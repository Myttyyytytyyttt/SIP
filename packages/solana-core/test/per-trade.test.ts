// The per-trade modes in core (ROUND-UP = 2, FIXED = 3; dispatcher ADR §5.4):
// the PerTradePolicy account and the PerTradeSettled event decoded as state.rs
// and events.rs lay them out, a settle_v3's logs read as ONE settlement (the
// unchanged Settled; PerTradeSettled skipped), the history naming settle_v3 and
// set_policy_v3, the relay binding a set_policy_v3 to the owner's own vault and
// PerTradePolicy, and the bounds pinned to state.rs.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { PublicKey, Transaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { classifyVaultEntry, type ClassifiableEntry } from "../src/client/activity";
import { base64Encode } from "../src/client/base64";
import { encodeStruct } from "../src/client/borsh";
import { DecodeError, SIP_ACCOUNT_SPACE, decodePerTradePolicy, decodePerTradeSettledEvent, decodeSettledEvent, type SettledEvent } from "../src/client/decoders";
import { SIP_PROGRAM_ID, accountDiscriminator, eventDiscriminator, toHex } from "../src/client/idl";
import {
  FIXED_LAMPORTS_MAX,
  FIXED_LAMPORTS_MIN,
  MIN_TRADE_CENTS_MAX,
  MIN_TRADE_LAMPORTS_MAX,
  MODE_FIXED,
  MODE_ROUNDUP,
  ROUNDUP_UNIT_CENTS_MAX,
  ROUNDUP_UNIT_CENTS_MIN,
  ROUNDUP_UNIT_CENTS_STEP,
  isPerTradeMode,
  perTradePolicyProblems,
} from "../src/client/rules";
import { sipInstruction } from "../src/server/builders";
import { derivePerTradePda, deriveVaultPda } from "../src/server/pda";
import { readPerTradePolicy, settledEventsFromLogs } from "../src/server/readers";
import { createRpcPool } from "../src/server/rpc-pool";
import { verifySignedTransaction } from "../src/server/verify-tx";
import { answerRpc, localRent } from "./chain-fixtures";
import { BLOCKHASH, UPSTREAM_1, accountInfo, fakeFetch, keypair, signWire } from "./helpers";

const require = createRequire(import.meta.url);
const STATE_RS = readFileSync(join(dirname(require.resolve("@sip/solana-program/package.json")), "programs/sip-vault/src/state.rs"), "utf8");
const rustConst = (name: string): number => {
  const match = new RegExp(`pub const ${name}: \\w+ = ([0-9_]+);`).exec(STATE_RS);
  if (match === null) throw new Error(`state.rs has no ${name}`);
  return Number(match[1]!.replaceAll("_", ""));
};
const key = (): string => keypair().publicKey.toBase58();

/** state.rs PerTradePolicy, written byte by byte at the offsets the M1a spec names. */
function perTradeBytes(vault: string): Uint8Array {
  const buf = Buffer.alloc(104);
  accountDiscriminator("PerTradePolicy").forEach((byte, index) => (buf[index] = byte));
  new PublicKey(vault).toBuffer().copy(buf, 8);
  buf.writeUInt8(252, 40);
  buf.writeUInt8(1, 41);
  buf.writeUInt16LE(200, 42);
  buf.writeUInt32LE(1_000_000, 44);
  buf.writeUInt16LE(150, 48);
  buf.writeUInt32LE(10_000_000, 50);
  buf.writeBigUInt64LE(300_000_000n, 54);
  buf.writeUInt32LE(20_833, 62);
  buf.writeBigUInt64LE(12_345n, 66);
  return Uint8Array.from(buf);
}

describe("the per-trade bounds are state.rs's", () => {
  it("pins every number validate_per_trade_policy reads", () => {
    expect(MODE_ROUNDUP).toBe(rustConst("MODE_ROUNDUP"));
    expect(MODE_FIXED).toBe(rustConst("MODE_FIXED"));
    expect(ROUNDUP_UNIT_CENTS_MIN).toBe(rustConst("ROUNDUP_UNIT_CENTS_MIN"));
    expect(ROUNDUP_UNIT_CENTS_MAX).toBe(rustConst("ROUNDUP_UNIT_CENTS_MAX"));
    expect(ROUNDUP_UNIT_CENTS_STEP).toBe(rustConst("ROUNDUP_UNIT_CENTS_STEP"));
    expect(FIXED_LAMPORTS_MIN).toBe(rustConst("FIXED_LAMPORTS_MIN"));
    expect(FIXED_LAMPORTS_MAX).toBe(rustConst("FIXED_LAMPORTS_MAX"));
    expect(MIN_TRADE_CENTS_MAX).toBe(rustConst("MIN_TRADE_CENTS_MAX"));
    expect(MIN_TRADE_LAMPORTS_MAX).toBe(rustConst("MIN_TRADE_LAMPORTS_MAX"));
    expect([0, 1, 2, 3, 4].map(isPerTradeMode)).toEqual([false, false, true, true, false]);
  });

  it("accepts a whole policy and names each problem otherwise", () => {
    const ok = { mode: 2, roundupUnitCents: 100, fixedLamports: 1_000_000, minTradeCents: 100, minTradeLamports: 10_000_000, dailyCapLamports: 300_000_000n, maxContribution: 60_000_000n, walletReserve: 0n };
    expect(perTradePolicyProblems(ok)).toEqual([]);
    expect(perTradePolicyProblems({ ...ok, mode: 1, roundupUnitCents: 150, dailyCapLamports: 0n })).toHaveLength(3);
  });
});

describe("decodePerTradePolicy", () => {
  it("reads state.rs's 104 bytes, field by field", () => {
    const vault = key();
    expect(SIP_ACCOUNT_SPACE.PerTradePolicy).toBe(104);
    expect(toHex(accountDiscriminator("PerTradePolicy"))).toBe("4a5e12f4fc1859b9");
    expect(decodePerTradePolicy(perTradeBytes(vault))).toMatchObject({
      vault,
      bump: 252,
      version: 1,
      roundupUnitCents: 200,
      fixedLamports: 1_000_000,
      minTradeCents: 150,
      minTradeLamports: 10_000_000,
      dailyCapLamports: 300_000_000n,
      dayIndex: 20_833,
      daySavedLamports: 12_345n,
    });
  });

  it("refuses another account's bytes or another size", () => {
    const vault = key();
    expect(() => decodePerTradePolicy(perTradeBytes(vault).subarray(0, 103))).toThrow(DecodeError);
    const other = perTradeBytes(vault);
    other[0] = other[0]! ^ 0xff;
    expect(() => decodePerTradePolicy(other)).toThrow(/not a PerTradePolicy/);
  });
});

/** PerTradeSettled's 161 bytes at events.rs's offsets. */
function perTradeSettledBytes(vault: string, wallet: string): Uint8Array {
  const buf = Buffer.alloc(161);
  eventDiscriminator("PerTradeSettled").forEach((byte, index) => (buf[index] = byte));
  new PublicKey(vault).toBuffer().copy(buf, 8);
  new PublicKey(wallet).toBuffer().copy(buf, 40);
  buf.writeBigUInt64LE(300n, 72);
  buf.writeBigUInt64LE(7n, 80);
  buf.writeUInt8(2, 88);
  buf.writeUInt32LE(3, 89);
  buf.writeBigUInt64LE(150_000_000n, 93);
  Buffer.alloc(32, 0xab).copy(buf, 101);
  buf.writeBigUInt64LE(100n, 133);
  buf.writeBigUInt64LE(100n, 141);
  buf.writeUInt32LE(20_833, 149);
  buf.writeBigUInt64LE(4_000_000n, 153);
  return Uint8Array.from(buf);
}

function settledBytes(event: SettledEvent): Uint8Array {
  const body = encodeStruct("Settled", {
    vault: event.vault,
    wallet: event.wallet,
    mode: event.mode,
    base_lamports: event.baseLamports,
    bps: event.bps,
    owed: event.owed,
    paid: event.paid,
    settlement_nonce: event.settlementNonce,
    session_end_slot: event.sessionEndSlot,
    link_epoch: event.linkEpoch,
    session_start_slot: event.sessionStartSlot,
    policy_nonce: event.policyNonce,
  });
  return Uint8Array.from([...eventDiscriminator("Settled"), ...body]);
}

describe("settle_v3's two events", () => {
  const vault = key();
  const wallet = key();
  const settled: SettledEvent = {
    vault,
    wallet,
    mode: 2,
    baseLamports: 4_000_000n,
    bps: 10_000,
    owed: 4_000_000n,
    paid: 4_000_000n,
    settlementNonce: 7n,
    sessionEndSlot: 900n,
    linkEpoch: 300n,
    sessionStartSlot: 800n,
    policyNonce: 5n,
  };

  it("PerTradeSettled decodes at events.rs's offsets, and decodeSettledEvent refuses it by discriminator", () => {
    const bytes = perTradeSettledBytes(vault, wallet);
    expect(toHex(eventDiscriminator("PerTradeSettled"))).toBe("e59dce6a79cbaeaa");
    expect(decodePerTradeSettledEvent(bytes)).toEqual({
      vault,
      wallet,
      linkEpoch: 300n,
      settlementNonce: 7n,
      mode: 2,
      tradeCount: 3,
      priceMinUsdE6: 150_000_000n,
      pricesHash: new Array(32).fill(0xab),
      modeParam: 100n,
      minTrade: 100n,
      dayIndex: 20_833,
      daySavedLamports: 4_000_000n,
    });
    expect(() => decodeSettledEvent(bytes)).toThrow(/not a Settled event/);
    expect(() => decodePerTradeSettledEvent(Uint8Array.from([...bytes, 0]))).toThrow(/trailing bytes/);
  });

  it("a settle_v3's logs are ONE settlement: the unchanged Settled, mode 2; PerTradeSettled is skipped", () => {
    const logs = [
      `Program ${SIP_PROGRAM_ID} invoke [1]`,
      "Program log: Instruction: SettleV3",
      `Program data: ${base64Encode(settledBytes(settled))}`,
      `Program data: ${base64Encode(perTradeSettledBytes(vault, wallet))}`,
      `Program ${SIP_PROGRAM_ID} success`,
    ];
    expect(settledEventsFromLogs(logs)).toEqual([settled]);
  });

  it("the history names a settle_v3 a settlement and a set_policy_v3 a rule change", () => {
    const entry = (instructions: ClassifiableEntry["instructions"], events: readonly SettledEvent[] = []): ClassifiableEntry =>
      ({ signature: "s".repeat(64), slot: 1_000, blockTime: null, ok: true, readable: true, instructions, vaultLamportsDelta: 4_000_000n, vaultTokenDeltas: [], settled: events }) as unknown as ClassifiableEntry;
    expect(classifyVaultEntry(entry([{ name: "settle_v3", args: {}, accounts: { vault } }], [settled]))).toEqual([
      expect.objectContaining({ kind: "settled", mode: 2, bps: 10_000, owed: 4_000_000n, paid: 4_000_000n, capped: false }),
    ]);
    const args = { mode: 3, roundup_unit_cents: 100, fixed_lamports: 1_000_000, min_trade_cents: 100, min_trade_lamports: 10_000_000, daily_cap_lamports: 300_000_000n, max_contribution: 60_000_000n, wallet_reserve: 0n, paused: false };
    expect(classifyVaultEntry(entry([{ name: "set_policy_v3", args, accounts: { vault } }]))).toEqual([
      {
        kind: "rule_changed",
        mode: 3,
        skimBps: null,
        volumeBps: null,
        paused: false,
        maxContribution: 60_000_000n,
        walletReserve: 0n,
        perTrade: { roundupUnitCents: 100, fixedLamports: 1_000_000, minTradeCents: 100, minTradeLamports: 10_000_000, dailyCapLamports: 300_000_000n },
      },
    ]);
  });
});

describe("readPerTradePolicy", () => {
  it("reads ['per_trade', vault]: missing for a vault that never had one, decoded for one that has", async () => {
    const vault = key();
    const address = derivePerTradePda(vault).toBase58();
    const accounts = new Map([[address, accountInfo(SIP_PROGRAM_ID, perTradeBytes(vault), localRent(104))]]);
    const upstream = fakeFetch(answerRpc({ accounts }));
    const pool = createRpcPool([UPSTREAM_1], { fetch: upstream.fetch });
    expect(await readPerTradePolicy(pool, vault)).toMatchObject({ kind: "exists", value: { address, state: { vault, roundupUnitCents: 200 } } });
    expect(await readPerTradePolicy(pool, key())).toEqual({ kind: "missing" });
    expect(await readPerTradePolicy(pool, "not-a-key")).toMatchObject({ kind: "unreadable" });
  });
});

describe("the relay binds a set_policy_v3 to the owner's own vault and PerTradePolicy", () => {
  const args = { mode: 2, roundup_unit_cents: 100, fixed_lamports: 1_000_000, min_trade_cents: 100, min_trade_lamports: 10_000_000, daily_cap_lamports: 300_000_000n, max_contribution: 60_000_000n, wallet_reserve: 0n, paused: false };
  const signed = (accounts: Record<string, PublicKey>, owner: ReturnType<typeof keypair>): Uint8Array => {
    const tx = new Transaction({ feePayer: owner.publicKey, recentBlockhash: BLOCKHASH }).add(sipInstruction("set_policy_v3", accounts, args));
    return signWire(base64Encode(tx.serialize({ requireAllSignatures: false, verifySignatures: false })), owner);
  };

  it("refuses another owner's vault, and a PerTradePolicy that is not ['per_trade', vault]", () => {
    const owner = keypair();
    const mine = deriveVaultPda(owner.publicKey);
    const theirs = deriveVaultPda(keypair().publicKey);
    const good = verifySignedTransaction(signed({ owner: owner.publicKey, vault: mine, per_trade_policy: derivePerTradePda(mine) }, owner));
    expect(good.ok).toBe(true);
    const stranger = verifySignedTransaction(signed({ owner: owner.publicKey, vault: theirs, per_trade_policy: derivePerTradePda(theirs) }, owner));
    expect(stranger).toMatchObject({ ok: false, reason: "account_binding", detail: expect.stringContaining("['vault', owner]") });
    const wrongPda = verifySignedTransaction(signed({ owner: owner.publicKey, vault: mine, per_trade_policy: derivePerTradePda(theirs) }, owner));
    expect(wrongPda).toMatchObject({ ok: false, reason: "account_binding", detail: expect.stringContaining("['per_trade', vault]") });
  });
});
