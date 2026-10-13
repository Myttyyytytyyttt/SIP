// Which code settles a vault, chosen by the vault's own on-chain skim_mode
// (src/settle-modules.ts; ADR §3.2, plan §3.4). The job-level proof — a
// worker's job hands each turn exactly its vault's byte and that module's
// measurement — is test/worker-job.test.ts's, and the per-trade job end to end
// in the shadow world is test/per-trade-job.test.ts's.

import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { perTradePolicyAddress } from "../src/accounts.js";
import { idl } from "../src/idl.js";
import type { WindowMeasurement } from "../src/measure-window.js";
import { dayIndexOf } from "../src/per-trade-base.js";
import { tradeNotional } from "../src/measure-volume.js";
import { PolicyBoundaryBook } from "../src/policy-boundary.js";
import { MemoryPriceTape, type PriceTapeReader } from "../src/price-tape.js";
import { KEEPER_MODES, MODE_FIXED_BYTE, MODE_PROFIT_BYTE, MODE_ROUNDUP_BYTE, MODE_VOLUME_BYTE } from "../src/role-registry.js";
import type { PerTradeAnswer } from "../src/settle-decision.js";
import { servesPerTrade, settleModuleFor, type ModuleJob, type PerTradeServing, type SettleModuleContext } from "../src/settle-modules.js";
import { perTradePolicyBytes, pythAccount, trade, type PolicyBytesInput } from "./per-trade-fixtures.js";
import { vaultOf } from "./settle-world.js";

const programId = new PublicKey(idl.address);
const NOW = 1_800_000_000;
const ORACLE = Keypair.generate().publicKey;

const context = (mode: number, over: Partial<SettleModuleContext> = {}): SettleModuleContext => ({
  link: {
    linkAddress: Keypair.generate().publicKey,
    wallet: Keypair.generate().publicKey,
    vault: Keypair.generate().publicKey,
    epoch: 1n,
    settlementNonce: 0n,
    frontierSlot: 0n,
  },
  vault: vaultOf(mode),
  programId: PublicKey.default,
  boundaries: new PolicyBoundaryBook(),
  ownerHistory: {
    signatures: async () => {
      throw new Error("not asked while the module is only chosen");
    },
    transaction: async () => null,
  },
  nowSeconds: () => NOW,
  ...over,
});

/** A connection that answers nothing: PROFIT and VOLUME prepare without a single call. */
const silent = new Proxy({}, { get: (_t, prop) => (prop === "then" ? undefined : () => Promise.reject(new Error(`unexpected RPC call: ${String(prop)}`))) }) as Connection;
const refusingProgram = new anchor.Program(idl, new anchor.AnchorProvider(silent, { publicKey: PublicKey.default, signTransaction: async () => Promise.reject(new Error("no")), signAllTransactions: async () => Promise.reject(new Error("no")) }, {}));

const job = (mode: number, connection: Connection = silent, vaultAddress = Keypair.generate().publicKey): ModuleJob => ({
  connection,
  program: refusingProgram,
  vaultAddress,
  vault: vaultOf(mode),
});

const serving = (over: Partial<PerTradeServing> = {}): PerTradeServing => ({
  modes: new Set([MODE_ROUNDUP_BYTE, MODE_FIXED_BYTE]),
  vaults: "*",
  live: false,
  fromSlot: null,
  tape: new MemoryPriceTape(),
  oracle: ORACLE,
  ...over,
});

describe("settleModuleFor: the vault's byte picks the module", () => {
  it("PROFIT: the balance-chain module, which reads nothing and adds nothing to the turn — the walk measures it, and its losses are carried", async () => {
    const module = settleModuleFor(MODE_PROFIT_BYTE)!;
    expect(module.mode.byte).toBe(MODE_PROFIT_BYTE);
    expect(module.mode.base).toBe("balance-chain");
    expect(module.mode.carriesLosses).toBe(true);
    expect(module.sends).toBe(true);
    const prepared = await module.prepare(job(MODE_PROFIT_BYTE));
    expect(prepared.kind).toBe("ready");
    expect(prepared.kind === "ready" && prepared.turn(context(MODE_PROFIT_BYTE))).toEqual({});
  });

  it("VOLUME: the trade-notional module — the volume probe and a volume base at the vault's own rate — no reads, and no losses", async () => {
    const module = settleModuleFor(MODE_VOLUME_BYTE)!;
    expect(module.mode.byte).toBe(MODE_VOLUME_BYTE);
    expect(module.mode.base).toBe("trade-notional");
    expect(module.mode.carriesLosses).toBe(false);
    expect(module.sends).toBe(true);
    const prepared = await module.prepare(job(MODE_VOLUME_BYTE));
    if (prepared.kind !== "ready") throw new Error("VOLUME prepares nothing that can fail");
    const turn = prepared.turn(context(MODE_VOLUME_BYTE));
    expect(turn.volumeProbe).toBe(tradeNotional);
    expect(typeof turn.volumeBase).toBe("function");
    expect(turn.perTrade).toBeUndefined();
  });

  it("a byte no sip-vault version defines has no module: the job then settles it as UNSUPPORTED_MODE", () => {
    for (const byte of [4, 7, 255, -1, 0.5]) expect(settleModuleFor(byte, { vault: "any", serving: serving() })).toBeNull();
  });

  it("DARK BY DEFAULT: a per-trade byte has no module unless SIP_SOLANA_EXTRA_MODES serves it for that vault", () => {
    const vault = Keypair.generate().publicKey.toBase58();
    for (const byte of [MODE_ROUNDUP_BYTE, MODE_FIXED_BYTE]) {
      expect(settleModuleFor(byte), "no serving").toBeNull();
      expect(settleModuleFor(byte, { vault, serving: null }), "serving null").toBeNull();
      expect(settleModuleFor(byte, { serving: serving() }), "no vault named").toBeNull();
      expect(settleModuleFor(byte, { vault, serving: serving({ vaults: new Set(["someone-else"]) }) }), "vault not listed").toBeNull();
      expect(settleModuleFor(byte, { vault, serving: serving({ modes: new Set([byte === MODE_ROUNDUP_BYTE ? MODE_FIXED_BYTE : MODE_ROUNDUP_BYTE]) }) }), "other mode only").toBeNull();
      expect(settleModuleFor(byte, { vault, serving: serving({ vaults: new Set([vault]) }) })?.mode.byte, "listed").toBe(byte);
      expect(settleModuleFor(byte, { vault, serving: serving() })?.mode.byte, "every vault").toBe(byte);
    }
    expect(servesPerTrade(serving(), MODE_PROFIT_BYTE, "v")).toBe(false);
  });

  it("a served per-trade module sends only under SIP_SOLANA_EXTRA_MODES_LIVE", () => {
    expect(settleModuleFor(MODE_ROUNDUP_BYTE, { vault: "v", serving: serving({ live: false }) })?.sends).toBe(false);
    expect(settleModuleFor(MODE_ROUNDUP_BYTE, { vault: "v", serving: serving({ live: true }) })?.sends).toBe(true);
  });

  it("every mode the registry knows has a module where it is served — a new KeeperMode row cannot ship without one", () => {
    for (const mode of Object.values(KEEPER_MODES)) expect(settleModuleFor(mode.byte, { vault: "v", serving: serving() })?.mode).toBe(mode);
  });
});

/** A connection that answers getMultipleAccountsInfo from `accounts` and records each request's keys. */
function accountsConnection(accounts: ReadonlyMap<string, unknown>) {
  const asked: string[][] = [];
  const connection = {
    getMultipleAccountsInfo: async (keys: readonly PublicKey[]) => {
      asked.push(keys.map((key) => key.toBase58()));
      return keys.map((key) => accounts.get(key.toBase58()) ?? null);
    },
  } as unknown as Connection;
  return { connection, asked };
}

describe("the per-trade module's job read", () => {
  const vaultAddress = Keypair.generate().publicKey;
  const pda = perTradePolicyAddress(programId, vaultAddress);
  const policyAccount = (vault = vaultAddress) => ({ data: perTradePolicyBytes({ vault, roundupUnitCents: 200 }), owner: programId, lamports: 1, executable: false, rentEpoch: 0 });
  const realProgram = (connection: Connection) =>
    new anchor.Program(idl, new anchor.AnchorProvider(connection, { publicKey: PublicKey.default, signTransaction: async () => Promise.reject(new Error("no")), signAllTransactions: async () => Promise.reject(new Error("no")) }, {}));

  it("ROUND-UP reads its PerTradePolicy and the oracle in ONE request; FIXED its PerTradePolicy alone", async () => {
    const { connection, asked } = accountsConnection(new Map<string, unknown>([[pda.toBase58(), policyAccount()], [ORACLE.toBase58(), pythAccount({ price: 15_000_000_000n, publishTime: BigInt(NOW) })]]));
    const roundUp = await settleModuleFor(MODE_ROUNDUP_BYTE, { vault: vaultAddress.toBase58(), serving: serving() })!.prepare({ connection, program: realProgram(connection), vaultAddress, vault: vaultOf(MODE_ROUNDUP_BYTE) });
    expect(asked).toEqual([[pda.toBase58(), ORACLE.toBase58()]]);
    if (roundUp.kind !== "ready") throw new Error(roundUp.detail);
    const turn = roundUp.turn(context(MODE_ROUNDUP_BYTE));
    expect(turn.volumeProbe).toBe(tradeNotional);
    expect(turn.perTrade?.policy.roundupUnitCents).toBe(200);
    expect(turn.perTrade?.oracle?.address.equals(ORACLE)).toBe(true);
    expect(turn.perTrade?.oracle?.update.price).toBe(15_000_000_000n);

    asked.length = 0;
    const fixed = await settleModuleFor(MODE_FIXED_BYTE, { vault: vaultAddress.toBase58(), serving: serving() })!.prepare({ connection, program: realProgram(connection), vaultAddress, vault: vaultOf(MODE_FIXED_BYTE) });
    expect(asked).toEqual([[pda.toBase58()]]);
    expect(fixed.kind === "ready" && fixed.turn(context(MODE_FIXED_BYTE)).perTrade?.oracle).toBeNull();
  });

  it("a vault whose PerTradePolicy the read cannot find, or that names another vault, is a RETRY for the job; an oracle it cannot use is no price, not a throw", async () => {
    const missing = accountsConnection(new Map());
    expect(await settleModuleFor(MODE_FIXED_BYTE, { vault: "v", serving: serving() })!.prepare({ connection: missing.connection, program: realProgram(missing.connection), vaultAddress, vault: vaultOf(MODE_FIXED_BYTE) })).toMatchObject({
      kind: "retry",
      detail: expect.stringContaining("no PerTradePolicy"),
    });
    const stranger = accountsConnection(new Map([[pda.toBase58(), policyAccount(Keypair.generate().publicKey)]]));
    expect(await settleModuleFor(MODE_FIXED_BYTE, { vault: "v", serving: serving() })!.prepare({ connection: stranger.connection, program: realProgram(stranger.connection), vaultAddress, vault: vaultOf(MODE_FIXED_BYTE) })).toMatchObject({
      kind: "retry",
      detail: expect.stringContaining("does not name this vault"),
    });
    const spoofed = accountsConnection(new Map<string, unknown>([[pda.toBase58(), policyAccount()], [ORACLE.toBase58(), pythAccount({ price: 15_000_000_000n, publishTime: BigInt(NOW) }, Keypair.generate().publicKey)]]));
    const prepared = await settleModuleFor(MODE_ROUNDUP_BYTE, { vault: "v", serving: serving() })!.prepare({ connection: spoofed.connection, program: realProgram(spoofed.connection), vaultAddress, vault: vaultOf(MODE_ROUNDUP_BYTE) });
    expect(prepared.kind === "ready" && prepared.turn(context(MODE_ROUNDUP_BYTE)).perTrade?.oracle).toBeNull();
  });

  it("refuses to prepare for a vault in another mode", async () => {
    await expect(settleModuleFor(MODE_ROUNDUP_BYTE, { vault: "v", serving: serving() })!.prepare(job(MODE_FIXED_BYTE))).rejects.toThrow(/skim_mode 3/);
  });
});

describe("the per-trade seam", () => {
  const vaultAddress = Keypair.generate().publicKey;
  const pda = perTradePolicyAddress(programId, vaultAddress);
  const measured = (trades: WindowMeasurement["volumeTrades"]): WindowMeasurement => ({
    txCount: trades?.length ?? 0,
    settleTxCount: 0,
    walletSignedTxCount: trades?.length ?? 0,
    successfulTradeCount: trades?.length ?? 0,
    tradedLamports: 0n,
    chainBreaks: 0,
    unfetchable: 0,
    cashDelta: 0n,
    deposits: 0n,
    withdrawals: 0n,
    profitLamports: 0n,
    firstSlot: 1n,
    lastSlot: 900n,
    signaturesAbove: 1,
    newestSignature: null,
    frontierReached: true,
    pagesExhausted: false,
    prefixCut: false,
    fetched: 1,
    ...(trades === undefined ? {} : { volumeTrades: trades }),
  });
  const boundaryAt = (slot: bigint | null) => ({ boundary: async () => ({ slot, detail: "stub" }) }) as unknown as PolicyBoundaryBook;
  async function preparedFor(mode: number, over: { readonly serving?: Partial<PerTradeServing>; readonly oracle?: unknown | null; readonly policy?: Omit<PolicyBytesInput, "vault"> } = {}) {
    const accounts = new Map<string, unknown>([[pda.toBase58(), { data: perTradePolicyBytes({ vault: vaultAddress, ...over.policy }), owner: programId, lamports: 1, executable: false, rentEpoch: 0 }]]);
    const oracle = over.oracle === undefined ? pythAccount({ price: 15_000_000_000n, publishTime: BigInt(NOW) }) : over.oracle;
    if (oracle !== null) accounts.set(ORACLE.toBase58(), oracle);
    const { connection } = accountsConnection(accounts);
    const program = new anchor.Program(idl, new anchor.AnchorProvider(connection, { publicKey: PublicKey.default, signTransaction: async () => Promise.reject(new Error("no")), signAllTransactions: async () => Promise.reject(new Error("no")) }, {}));
    const prepared = await settleModuleFor(mode, { vault: vaultAddress.toBase58(), serving: serving(over.serving) })!.prepare({ connection, program, vaultAddress, vault: vaultOf(mode) });
    if (prepared.kind !== "ready") throw new Error(prepared.detail);
    return prepared;
  }
  async function seamFor(mode: number, over: { readonly serving?: Partial<PerTradeServing>; readonly boundaries?: PolicyBoundaryBook; readonly oracle?: unknown | null } = {}) {
    const prepared = await preparedFor(mode, over);
    return prepared.turn(context(mode, { boundaries: over.boundaries ?? boundaryAt(null) })).perTrade!.base;
  }
  const charged = (answer: PerTradeAnswer) => {
    if (answer.kind !== "charge") throw new Error(answer.detail);
    return answer.charge;
  };

  it("prices each trade at the tape's sample, late at the job's Pyth read where the tape has none", async () => {
    const tape = new MemoryPriceTape();
    await tape.record({ publishTime: NOW - 600, slot: 1n, priceE6: 140_000_000n, confE6: 0n });
    const seam = await seamFor(MODE_ROUNDUP_BYTE, { serving: { tape } });
    const charge = charged(await seam(measured([trade("t", 100, 10_000_000n, NOW - 590), trade("late", 101, 10_000_000n, NOW - 100)])));
    expect(charge.rows.map((row) => [row.priceSource, row.priceUsdE6])).toEqual([
      ["tape", 140_000_000n],
      ["late", 150_000_000n],
    ]);
    expect(charge.latePriced).toBe(1);
    expect(charge.priceMinUsdE6).toBe(140_000_000n);
  });

  it("per-trade-from-slot: a vault switched to mode 2 weeks before serving began is charged only for trades after SIP_SOLANA_EXTRA_MODES_FROM_SLOT", async () => {
    // The owner's switch (the policy boundary) is at slot 50; serving widened at slot 500.
    const seam = await seamFor(MODE_ROUNDUP_BYTE, { serving: { fromSlot: 500n }, boundaries: boundaryAt(50n) });
    const charge = charged(await seam(measured([trade("weeks-ago", 60, 10_000_000n, NOW - 9_000), trade("at-serving", 500, 10_000_000n, NOW - 200), trade("after", 501, 10_000_000n, NOW - 100)])));
    expect(charge.rows.map((row) => row.status)).toEqual(["forgiven", "forgiven", "charged"]);
    expect(charge.tradeCount).toBe(1);
    // And a later policy boundary wins over an earlier serving slot.
    const later = await seamFor(MODE_FIXED_BYTE, { serving: { fromSlot: 10n }, boundaries: boundaryAt(500n) });
    expect(charged(await later(measured([trade("a", 400, 20_000_000n, NOW), trade("b", 600, 20_000_000n, NOW)]))).tradeCount).toBe(1);
  });

  it("waits on the clock for a small span, and says until when", async () => {
    const seam = await seamFor(MODE_FIXED_BYTE);
    const answer = await seam(measured([trade("one", 100, 20_000_000n, NOW - 60)]));
    expect(answer).toMatchObject({ kind: "charge", wait: { dueAt: NOW - 60 + 3_600 } });
    const old = await seam(measured([trade("old", 100, 20_000_000n, NOW - 3_600)]));
    expect(old).toMatchObject({ kind: "charge", wait: null });
  });

  it("is a RETRY, never a guess, when the tape, the owner's history or the price cannot be read", async () => {
    const broken: PriceTapeReader = { pricesAt: async () => Promise.reject(new Error("connection refused")) };
    expect(await (await seamFor(MODE_ROUNDUP_BYTE, { serving: { tape: broken } }))(measured([trade("x", 100, 10_000_000n, NOW)]))).toMatchObject({ kind: "retry", detail: expect.stringContaining("price tape") });
    const unwalkable = { boundary: async () => Promise.reject(new Error("429")) } as unknown as PolicyBoundaryBook;
    expect(await (await seamFor(MODE_FIXED_BYTE, { boundaries: unwalkable }))(measured([trade("x", 100, 20_000_000n, NOW)]))).toMatchObject({ kind: "retry", detail: expect.stringContaining("policy history") });
    expect(await (await seamFor(MODE_ROUNDUP_BYTE, { oracle: null }))(measured([]))).toMatchObject({ kind: "retry", detail: expect.stringContaining("Pyth") });
    // FIXED needs no price at all.
    expect(await (await seamFor(MODE_FIXED_BYTE, { oracle: null }))(measured([]))).toMatchObject({ kind: "charge" });
  });

  it("never prices a late trade at a Pyth read the tape would not keep: a feed 2 h stale or 60 bps wide is a RETRY for the trades the tape missed, and blocks nothing the tape priced", async () => {
    const tape = new MemoryPriceTape();
    await tape.record({ publishTime: NOW - 600, slot: 1n, priceE6: 140_000_000n, confE6: 0n });
    const stale = pythAccount({ price: 15_000_000_000n, publishTime: BigInt(NOW - 7_200) });
    const seam = await seamFor(MODE_ROUNDUP_BYTE, { serving: { tape }, oracle: stale });
    // A trade in the tape's hole is not valued at the 2-hour-old price, nor is one with no block time.
    const hole = await seam(measured([trade("taped", 100, 10_000_000n, NOW - 590), trade("in-the-hole", 101, 10_666_667n, NOW - 100), trade("unaged", 102, 10_666_667n, null)]));
    expect(hole).toMatchObject({ kind: "retry", detail: expect.stringContaining("no fresh price for 2 trade(s)") });
    expect(hole.kind === "retry" && hole.detail).toContain("published 7200 s before now, past 60 s");
    // A STALE FEED BLOCKS ONLY THE TAPE'S GAPS (ADR §4.10): a span the tape priced whole is charged as before.
    expect(charged(await seam(measured([trade("taped", 100, 10_000_000n, NOW - 590)]))).rows.map((row) => [row.priceSource, row.priceUsdE6])).toEqual([["tape", 140_000_000n]]);
    // A forgiven trade needs no price at all.
    const forgiving = await seamFor(MODE_ROUNDUP_BYTE, { serving: { tape }, oracle: stale, boundaries: boundaryAt(500n) });
    expect(charged(await forgiving(measured([trade("before-serving", 400, 10_666_667n, NOW - 100)]))).rows.map((row) => row.status)).toEqual(["forgiven"]);
    // Wide: 60 bps of its price.
    const wide = await seamFor(MODE_ROUNDUP_BYTE, { oracle: pythAccount({ price: 15_000_000_000n, conf: 90_000_000n, publishTime: BigInt(NOW) }) });
    expect(await wide(measured([trade("wide", 101, 10_666_667n, NOW - 100)]))).toMatchObject({ kind: "retry", detail: expect.stringContaining("60 bps of its price, past 50") });
    // At the tape's own limits — published 60 s before now, 50 bps wide — the late price is used.
    const edge = await seamFor(MODE_ROUNDUP_BYTE, { oracle: pythAccount({ price: 15_000_000_000n, conf: 75_000_000n, publishTime: BigInt(NOW - 60) }) });
    expect(charged(await edge(measured([trade("edge", 101, 10_666_667n, NOW - 100)]))).rows.map((row) => [row.priceSource, row.priceUsdE6])).toEqual([["late", 150_000_000n]]);
  });

  it("carries the vault's daily counter from one link's SETTLED turn to the next: a link after the day's cap is reached waits on the clock, not on size", async () => {
    // F = 0.03 SOL, max_contribution 0.06 SOL, cap 0.3 SOL with 0.27 SOL saved today: one more settle fills it.
    const today = dayIndexOf(NOW);
    const prepared = await preparedFor(MODE_FIXED_BYTE, { policy: { fixedLamports: 30_000_000, dailyCapLamports: 300_000_000n, dayIndex: today, daySavedLamports: 270_000_000n } });
    const vault = { ...vaultOf(MODE_FIXED_BYTE), maxContribution: 60_000_000n };
    const first = prepared.turn(context(MODE_FIXED_BYTE, { vault, boundaries: boundaryAt(null) })).perTrade!;
    expect(first.policy.daySavedLamports).toBe(270_000_000n);
    const firstAnswer = await first.base(measured([trade("l1", 100, 20_000_000n, NOW - 60)]));
    expect(firstAnswer).toMatchObject({ kind: "charge", wait: null });
    // A turn that did not settle moves nothing.
    prepared.afterTurn!({ outcome: "RETRY", expectedLamports: 30_000_000n, perTrade: charged(firstAnswer) }, NOW);
    expect(prepared.turn(context(MODE_FIXED_BYTE, { vault, boundaries: boundaryAt(null) })).perTrade!.policy.daySavedLamports).toBe(270_000_000n);
    // The first link settles its 0.03 SOL: the day is full.
    prepared.afterTurn!({ outcome: "SETTLED", expectedLamports: 30_000_000n, settledLamports: 30_000_000n, perTrade: charged(firstAnswer) }, NOW);
    const second = prepared.turn(context(MODE_FIXED_BYTE, { vault, boundaries: boundaryAt(null) })).perTrade!;
    expect(second.policy).toMatchObject({ dayIndex: today, daySavedLamports: 300_000_000n });
    expect(await second.base(measured([trade("l2", 100, 20_000_000n, NOW - 60)]))).toMatchObject({
      kind: "charge",
      wait: { dueAt: NOW - 60 + 3_600, detail: expect.stringContaining("saved its daily cap today") },
    });
    // Without a read receipt, what this keeper computed the program pays is what it carries; a new day starts again.
    prepared.afterTurn!({ outcome: "SETTLED", expectedLamports: 0n, perTrade: charged(firstAnswer) }, NOW + 86_400);
    expect(prepared.turn(context(MODE_FIXED_BYTE, { vault, boundaries: boundaryAt(null) })).perTrade!.policy).toMatchObject({ dayIndex: today + 1, daySavedLamports: 0n });
  });

  it("throws when the walk carries no volume trades: the turn was built without the probe", async () => {
    await expect((await seamFor(MODE_FIXED_BYTE))(measured(undefined))).rejects.toThrow(/volume probe/);
  });
});
