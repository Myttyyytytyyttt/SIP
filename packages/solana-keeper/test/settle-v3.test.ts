// A per-trade span through runSettleTick (src/settle-tick.ts, settlePerTrade):
// the walk's counted swaps priced from the tape, charged, attested as
// SIP_SETTLE_V3 and sent as [Ed25519SigVerify, settle_v3] through the fence —
// over the small real-enough chain of test/settle-world.ts, with the real
// volume probe. And the pins that keep every legacy keeper out of it (T-O2).

import * as anchor from "@coral-xyz/anchor";
import { Ed25519Program, Keypair, PublicKey, type Connection } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { perTradePolicyAddress, type PerTradePolicyState, type VaultState } from "../src/accounts.js";
import { idl, instructionDiscriminator } from "../src/idl.js";
import { tradeNotional } from "../src/measure-volume.js";
import { dayIndexOf, signatureBytes } from "../src/per-trade-base.js";
import type { PolicyBoundaryBook } from "../src/policy-boundary.js";
import { MemoryPriceTape } from "../src/price-tape.js";
import { MODE_FIXED, MODE_PROFIT, MODE_ROUNDUP, MODE_VOLUME, attestationV3Message, pricesHash } from "../src/program-scripts.js";
import { PYTH_SOL_USD_FEED_ID_HEX, decodePythPriceUpdate } from "../src/pyth.js";
import { KEEPER_MODES, KEEPER_ROLES } from "../src/role-registry.js";
import { attestationV3Inputs, keeperModes } from "../src/settle-decision.js";
import { perTradeSeam } from "../src/settle-modules.js";
import { runSettleTick, type PerTradeTurn, type SettleDeps, type SettleFence, type SettleGateRequest } from "../src/settle-tick.js";
import { pythSolUsdBytes, signatureFor } from "./per-trade-fixtures.js";
import { SettleWorld } from "./settle-world.js";

const programId = new PublicKey(idl.address);
const NOW = 1_800_000_000;
const ORACLE = Keypair.generate().publicKey;
const SETTLE_V3 = instructionDiscriminator("settle_v3");

/** A per-trade vault and its world: the walk's swaps, its PerTradePolicy, the tape and the job's Pyth read. */
function perTradeWorld(mode: typeof MODE_ROUNDUP | typeof MODE_FIXED, options: { readonly maxContribution?: bigint; readonly policy?: Partial<PerTradePolicyState>; readonly tapePrice?: bigint; readonly oraclePrice?: bigint } = {}) {
  const world = new SettleWorld();
  const vault: VaultState = {
    owner: Keypair.generate().publicKey,
    paused: false,
    skimMode: mode,
    skimBps: 2_000,
    volumeBps: 200,
    policyNonce: 4n,
    maxContribution: options.maxContribution ?? 4_000_000n,
    walletReserve: 50_000_000n,
  };
  const policy: PerTradePolicyState = {
    address: perTradePolicyAddress(programId, world.link.vault),
    vault: world.link.vault,
    version: 1,
    roundupUnitCents: 100,
    fixedLamports: 1_000_000,
    minTradeCents: 100,
    minTradeLamports: 10_000_000,
    dailyCapLamports: 300_000_000n,
    dayIndex: 0,
    daySavedLamports: 0n,
    ...options.policy,
  };
  const tape = new MemoryPriceTape();
  const calls: string[] = [];
  const connection = world.connection(calls);
  const refuse = async (): Promise<never> => Promise.reject(new Error("the world's program signs nothing"));
  const program = new anchor.Program(idl, new anchor.AnchorProvider(connection, { publicKey: PublicKey.default, signTransaction: refuse, signAllTransactions: refuse }, { commitment: "confirmed" }));
  const update = decodePythPriceUpdate(pythSolUsdBytes({ price: options.oraclePrice ?? 15_000_000_000n, publishTime: BigInt(NOW) }), PYTH_SOL_USD_FEED_ID_HEX);
  const gated: SettleGateRequest[] = [];
  const fence: SettleFence = {
    gate: async (request) => {
      gated.push(request);
      return { kind: "gated", ticket: { signed: () => undefined, ended: () => undefined } };
    },
  };
  const perTrade = (): PerTradeTurn => ({
    base: perTradeSeam({
      context: {
        link: world.link,
        vault,
        programId,
        boundaries: { boundary: async () => ({ slot: null, detail: "no change" }) } as unknown as PolicyBoundaryBook,
        ownerHistory: { signatures: async () => [], transaction: async () => null },
        nowSeconds: () => NOW,
      },
      mode: KEEPER_MODES[mode],
      policy,
      oracle: mode === MODE_ROUNDUP ? update : null,
      serving: { fromSlot: null, tape },
    }),
    policy,
    oracle: mode === MODE_ROUNDUP ? { address: ORACLE, update } : null,
    nowSeconds: () => NOW,
  });
  const attester = Keypair.generate();
  const deps = (over: Partial<SettleDeps> = {}): SettleDeps => ({
    connection: connection as Connection,
    program,
    link: world.link,
    vault,
    attester: null,
    walletSigner: null,
    live: false,
    protocolPaused: false,
    settles: [mode],
    carries: new Map(),
    volumeProbe: tradeNotional,
    perTrade: perTrade(),
    ...over,
  });
  const live = (over: Partial<SettleDeps> = {}) => deps({ live: true, attester, walletSigner: world.walletKey, fence, ...over });
  return { world, vault, policy, tape, calls, deps, live, gated, attester, program };
}

/** A buy of `x` lamports at `blockTime`, as the probe measures it: the wallet pays x and the 5 000-lamport fee. */
function buy(world: SettleWorld, x: number, blockTime: number, seed: string): string {
  const signature = signatureFor(seed);
  world.swap(-(x + 5_000), blockTime, signature);
  return signature;
}

describe("settle_v3 through runSettleTick", () => {
  it("dry ROUND-UP: the $1.60 trade at the tape's $150 would settle 2 666 666 lamports, reads like any settle, and sends nothing", async () => {
    const w = perTradeWorld(MODE_ROUNDUP);
    await w.tape.record({ publishTime: NOW - 40, slot: 1n, priceE6: 150_000_000n, confE6: 0n });
    buy(w.world, 10_666_667, NOW - 30, "buy-1");
    w.world.finalizeTo(w.world.tip);
    const result = await runSettleTick(w.deps());
    expect(result).toMatchObject({ outcome: "SETTLED", mode: MODE_ROUNDUP, baseLamports: 2_666_666n, expectedLamports: 2_666_666n });
    expect(result.detail).toBe(
      "DRY RUN — would settle 2666666 lamports in ROUND-UP through settle_v3 (2666666 owed over 1 charged trade(s) of 1 counted, lowest price 150000000 µ$/SOL) " +
        `over slots ${w.world.link.epoch}..${w.world.tip}`,
    );
    expect(result.perTrade?.rows).toHaveLength(1);
    expect(w.calls).toEqual(expect.arrayContaining(["getSlot", "getLatestBlockhash", "getFeeForMessage", "getBalance"]));
    expect(w.calls).not.toContain("sendRawTransaction");
    expect(w.world.sent).toEqual([]);
  });

  it("live FIXED: [Ed25519 over SIP_SETTLE_V3, settle_v3] through the fence, no oracle, count × F paid and reported", async () => {
    const w = perTradeWorld(MODE_FIXED, { maxContribution: 1_500_000n });
    buy(w.world, 20_000_000, NOW - 10, "fixed-1");
    w.world.finalizeTo(w.world.tip);
    w.world.receiptVaultDelta = 1_000_000;
    const link = w.world.link;
    const result = await runSettleTick(w.live());
    expect(result).toMatchObject({ outcome: "SETTLED", mode: MODE_FIXED, baseLamports: 1_000_000n, expectedLamports: 1_000_000n, settledLamports: 1_000_000n, nonce: 0n });
    expect(w.gated).toHaveLength(1);
    expect(w.gated[0]).toMatchObject({ mode: MODE_FIXED, amountLamports: 1_000_000n, carry: null, live: true });
    expect(w.world.sent).toHaveLength(1);
    const tx = w.world.sent[0]!;
    const keys = tx.message.staticAccountKeys;
    const [verify, settle] = tx.message.compiledInstructions;
    expect(keys[verify!.programIdIndex]!.equals(Ed25519Program.programId)).toBe(true);
    expect(keys[settle!.programIdIndex]!.equals(programId)).toBe(true);
    const data = Buffer.from(settle!.data);
    expect(data.subarray(0, 8).equals(SETTLE_V3)).toBe(true);
    // The settle_v3 arguments: mode 3, the window, one trade, 1 000 000 lamports, no price, a zero hash.
    expect(data.readUInt8(8)).toBe(MODE_FIXED);
    expect(data.readBigUInt64LE(9)).toBe(link.epoch);
    expect(data.readUInt32LE(25)).toBe(1);
    expect(data.readBigUInt64LE(29)).toBe(1_000_000n);
    expect(data.readBigUInt64LE(37)).toBe(0n);
    expect(data.subarray(45, 77).equals(Buffer.alloc(32))).toBe(true);
    // Accounts: …, per_trade_policy, then the program id for "no oracle".
    const named = settle!.accountKeyIndexes.map((index) => keys[index]!.toBase58());
    expect(named.at(-2)).toBe(w.policy.address.toBase58());
    expect(named.at(-1)).toBe(programId.toBase58());
    // The verified bytes are exactly the V3 attestation the program rebuilds.
    const verifyData = Buffer.from(verify!.data);
    const expected = attestationV3Message({
      programId,
      wallet: link.wallet,
      vault: link.vault,
      linkEpoch: link.epoch,
      settlementNonce: 0n,
      sessionStartSlot: link.epoch,
      sessionEndSlot: data.readBigUInt64LE(17),
      amountLamports: 1_000_000n,
      mode: MODE_FIXED,
      policyNonce: 4n,
      validUntilSlot: data.readBigUInt64LE(77),
      tradeCount: 1,
      priceMinUsdE6: 0n,
      modeParam: 1_000_000n,
      minTrade: 10_000_000n,
      pricesHash: Buffer.alloc(32),
    });
    expect(verifyData.subarray(112).equals(expected)).toBe(true);
    expect(verifyData.subarray(16, 48).equals(w.attester.publicKey.toBuffer())).toBe(true);
  });

  it("live ROUND-UP: the oracle is named, and the signed price and hash are the tape's", async () => {
    const w = perTradeWorld(MODE_ROUNDUP);
    await w.tape.record({ publishTime: NOW - 100, slot: 1n, priceE6: 151_000_000n, confE6: 0n });
    const signature = buy(w.world, 10_666_667, NOW - 90, "buy-2");
    w.world.finalizeTo(w.world.tip);
    const trade = w.world.entries.at(-1)!;
    const result = await runSettleTick(w.live());
    expect(result.outcome).toBe("SETTLED");
    const tx = w.world.sent[0]!;
    const keys = tx.message.staticAccountKeys;
    const settle = tx.message.compiledInstructions[1]!;
    expect(keys[settle.accountKeyIndexes.at(-1)!]!.equals(ORACLE)).toBe(true);
    const data = Buffer.from(settle.data);
    expect(data.readBigUInt64LE(37)).toBe(151_000_000n);
    expect(data.subarray(45, 77).equals(pricesHash([{ slot: BigInt(trade.slot), signature: signatureBytes(signature), priceUsdE6: 151_000_000n }]))).toBe(true);
  });

  it("refuses a ROUND-UP price under half of Pyth's before anything is priced or signed: RETRY, nothing sent", async () => {
    // The tape says $74 — a power-of-ten-sized error against Pyth's $150 would look the same.
    const w = perTradeWorld(MODE_ROUNDUP);
    await w.tape.record({ publishTime: NOW - 40, slot: 1n, priceE6: 74_000_000n, confE6: 0n });
    buy(w.world, 30_000_000, NOW - 30, "buy-3");
    w.world.finalizeTo(w.world.tip);
    const result = await runSettleTick(w.live());
    expect(result.outcome).toBe("RETRY");
    expect(result.detail).toMatch(/PriceBelowOracleFloor/);
    expect(result.detail).toMatch(/nothing was signed$/);
    expect(w.calls).not.toContain("getLatestBlockhash");
    expect(w.gated).toEqual([]);
    expect(w.world.sent).toEqual([]);
  });

  it("clips by what is left of today's cap and says so; a live per-trade turn without a fence sends nothing", async () => {
    const w = perTradeWorld(MODE_ROUNDUP, { policy: { dayIndex: dayIndexOf(NOW), daySavedLamports: 299_000_000n } });
    await w.tape.record({ publishTime: NOW - 40, slot: 1n, priceE6: 150_000_000n, confE6: 0n });
    buy(w.world, 10_666_667, NOW - 3_600, "buy-4");
    w.world.finalizeTo(w.world.tip);
    const dry = await runSettleTick(w.deps());
    expect(dry).toMatchObject({ outcome: "SETTLED", baseLamports: 2_666_666n, expectedLamports: 1_000_000n });
    expect(dry.detail).toContain("clipped by the daily cap (299000000 of 300000000 saved today)");
    const unfenced = await runSettleTick(w.live({ fence: undefined }));
    expect(unfenced.outcome).toBe("FAILED");
    expect(unfenced.detail).toMatch(/only through the dispatcher's fence/);
    expect(w.world.sent).toEqual([]);
  });

  it("a span under its cadence rests at NO_PROFIT and says when its clock fires (dueAt)", async () => {
    const w = perTradeWorld(MODE_FIXED, { maxContribution: 60_000_000n });
    buy(w.world, 20_000_000, NOW - 600, "fixed-2");
    w.world.finalizeTo(w.world.tip);
    const result = await runSettleTick(w.deps());
    expect(result).toMatchObject({ outcome: "NO_PROFIT", baseLamports: 1_000_000n, dueAt: NOW - 600 + 3_600 });
    expect(w.calls).not.toContain("getLatestBlockhash");
  });
});

describe("T-O2: a legacy keeper never reaches settle_v3", () => {
  it("rests a per-trade vault at UNSUPPORTED_MODE with zero calls and zero sends on both roles, live or dry, even handed a per-trade turn", async () => {
    for (const mode of [MODE_ROUNDUP, MODE_FIXED] as const) {
      for (const role of KEEPER_ROLES) {
        for (const live of [true, false]) {
          const w = perTradeWorld(mode);
          buy(w.world, 20_000_000, NOW - 3_600, `legacy-${role}-${live}`);
          w.world.finalizeTo(w.world.tip);
          const result = await runSettleTick(live ? w.live({ settles: keeperModes(role) }) : w.deps({ settles: keeperModes(role) }));
          expect(result.outcome, `${role}, mode ${mode}, live ${live}`).toBe("UNSUPPORTED_MODE");
          expect(w.calls, `${role}, mode ${mode}, live ${live}`).toEqual([]);
          expect(w.world.sent).toEqual([]);
          expect(w.gated).toEqual([]);
        }
      }
    }
    expect(keeperModes("profit")).toEqual([MODE_PROFIT]);
    expect(keeperModes("volume")).toEqual([MODE_VOLUME]);
  });

  it("T-N1: a per-trade vault whose turn has no per-trade seam is never attested at all", async () => {
    const w = perTradeWorld(MODE_ROUNDUP);
    buy(w.world, 20_000_000, NOW - 3_600, "no-seam");
    w.world.finalizeTo(w.world.tip);
    const result = await runSettleTick(w.live({ perTrade: undefined }));
    expect(result.outcome).toBe("UNSUPPORTED_MODE");
    expect(w.calls).not.toContain("getLatestBlockhash");
    expect(w.world.sent).toEqual([]);
    // And the V3 builder refuses the legacy modes outright.
    expect(() =>
      attestationV3Inputs({
        programId,
        link: w.world.link,
        vault: { skimMode: MODE_VOLUME, policyNonce: 1n },
        from: w.world.link.epoch,
        endSlot: w.world.link.epoch + 1n,
        charge: { mode: MODE_ROUNDUP, amountLamports: 0n, tradeCount: 0, priceMinUsdE6: 1n, pricesHash: Buffer.alloc(32), modeParam: 100n, minTrade: 100n, rows: [], latePriced: 0, oldestChargedAt: null, unagedCharge: false },
        currentSlot: 1n,
      }),
    ).toThrow(/only ROUND-UP and FIXED/);
  });
});
