// Where a VOLUME span starts being chargeable (src/policy-boundary.ts): the
// owner's own policy writes, read from the owner's history, decoded from real
// web3.js messages built with the IDL's own discriminators.

import { Keypair, PublicKey, TransactionInstruction, TransactionMessage, type Finality, type VersionedTransactionResponse } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { idl, SIP_PROGRAM_ID } from "../src/idl.js";
import { MAX_OWNER_PAGES, OWNER_PAGE_LIMIT, PolicyBoundaryBook, findPolicyBoundary, policyWrites, type OwnerHistoryReader } from "../src/policy-boundary.js";
import { MODE_PROFIT, MODE_VOLUME } from "../src/program-scripts.js";

const PROGRAM = new PublicKey(SIP_PROGRAM_ID);
const owner = Keypair.generate().publicKey;
const vault = Keypair.generate().publicKey;
const otherVault = Keypair.generate().publicKey;
const BLOCKHASH = "11111111111111111111111111111111";

const discriminator = (name: string): Buffer =>
  Buffer.from((idl.instructions as readonly { name: string; discriminator: number[] }[]).find((ix) => ix.name === name)!.discriminator);

/** set_policy_v2's data: mode, skim_bps, volume_bps, paused, max_contribution, wallet_reserve. */
function setPolicyData(mode: number, volumeBps: number, paused = false): Buffer {
  const data = Buffer.alloc(8 + 1 + 2 + 2 + 1 + 8 + 8);
  discriminator("set_policy_v2").copy(data, 0);
  data.writeUInt8(mode, 8);
  data.writeUInt16LE(2_500, 9);
  data.writeUInt16LE(volumeBps, 11);
  data.writeUInt8(paused ? 1 : 0, 13);
  data.writeBigUInt64LE(60_000_000n, 14);
  data.writeBigUInt64LE(50_000_000n, 22);
  return data;
}

function createVaultData(mode: number, volumeBps: number): Buffer {
  const data = Buffer.alloc(8 + 1 + 2 + 2 + 8 + 8);
  discriminator("create_vault_v2").copy(data, 0);
  data.writeUInt8(mode, 8);
  data.writeUInt16LE(2_500, 9);
  data.writeUInt16LE(volumeBps, 11);
  return data;
}

interface Entry {
  readonly signature: string;
  readonly slot: number;
  readonly data?: Buffer;
  readonly target?: PublicKey;
  readonly err?: unknown;
  /** Reached through another program: the sip-vault instruction is inner. */
  readonly inner?: boolean;
}

function response(entry: Entry): VersionedTransactionResponse {
  const outer = entry.inner ? Keypair.generate().publicKey : PROGRAM;
  const ix = new TransactionInstruction({
    programId: outer,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: entry.target ?? vault, isSigner: false, isWritable: true },
      { pubkey: PROGRAM, isSigner: false, isWritable: false },
    ],
    data: entry.data ?? Buffer.from([1, 2, 3]),
  });
  const message = new TransactionMessage({ payerKey: owner, recentBlockhash: BLOCKHASH, instructions: [ix] }).compileToV0Message();
  const keys = message.staticAccountKeys;
  const innerInstructions = entry.inner
    ? [{ index: 0, instructions: [{ programIdIndex: keys.findIndex((k) => k.equals(PROGRAM)), accounts: [0, keys.findIndex((k) => k.equals(entry.target ?? vault))], data: "1" }] }]
    : [];
  return {
    slot: entry.slot,
    blockTime: null,
    version: 0,
    transaction: { message, signatures: [entry.signature] },
    meta: {
      err: (entry.err ?? null) as never,
      fee: 5_000,
      preBalances: keys.map(() => 1),
      postBalances: keys.map(() => 1),
      innerInstructions,
      loadedAddresses: { writable: [], readonly: [] },
      logMessages: [],
    },
  } as unknown as VersionedTransactionResponse;
}

/** The owner's history, oldest first, served newest first in pages. */
function history(oldestFirst: readonly Entry[], unreadable: ReadonlySet<string> = new Set()) {
  const newestFirst = [...oldestFirst].reverse();
  const reads: string[] = [];
  const reader: OwnerHistoryReader = {
    signatures: async (address, options, commitment: Finality) => {
      expect(address.equals(owner)).toBe(true);
      expect(commitment).toBe("confirmed");
      const start = options.before === undefined ? 0 : newestFirst.findIndex((e) => e.signature === options.before) + 1;
      return newestFirst.slice(start, start + options.limit).map((e) => ({ signature: e.signature, slot: e.slot, err: e.err ?? null }));
    },
    transaction: async (signature) => {
      reads.push(signature);
      if (unreadable.has(signature)) return null;
      return response(oldestFirst.find((e) => e.signature === signature)!);
    },
  };
  return { reader, reads };
}

const boundary = (entries: readonly Entry[], from: bigint, unreadable?: ReadonlySet<string>) =>
  findPolicyBoundary({ reader: history(entries, unreadable).reader, programId: SIP_PROGRAM_ID, vault, owner, from });

const created = (slot: number, mode = MODE_PROFIT, volumeBps = 200): Entry => ({ signature: `create-${slot}`, slot, data: createVaultData(mode, volumeBps) });
const policy = (slot: number, mode: number, volumeBps = 200, paused = false): Entry => ({ signature: `policy-${slot}`, slot, data: setPolicyData(mode, volumeBps, paused) });
const other = (slot: number): Entry => ({ signature: `other-${slot}`, slot });

describe("policyWrites", () => {
  it("reads the mode and the volume rate of set_policy_v2 and create_vault_v2 for this vault only", () => {
    expect(policyWrites(response(policy(10, MODE_VOLUME, 50)), SIP_PROGRAM_ID, vault, "s")).toEqual([{ slot: 10n, signature: "s", rule: { mode: MODE_VOLUME, volumeBps: 50 } }]);
    expect(policyWrites(response(created(5, MODE_PROFIT, 200)), SIP_PROGRAM_ID, vault, "c")).toEqual([{ slot: 5n, signature: "c", rule: { mode: MODE_PROFIT, volumeBps: 200 } }]);
    expect(policyWrites(response({ ...policy(10, MODE_VOLUME), target: otherVault }), SIP_PROGRAM_ID, vault, "s")).toEqual([]);
    expect(policyWrites(response(other(10)), SIP_PROGRAM_ID, vault, "o")).toEqual([]);
  });

  it("ignores a failed write, which changed nothing", () => {
    expect(policyWrites(response({ ...policy(10, MODE_VOLUME), err: { InstructionError: [0, "Custom"] } }), SIP_PROGRAM_ID, vault, "s")).toEqual([]);
  });

  it("takes the program reached through another program as a change of unknown content", () => {
    expect(policyWrites(response({ ...policy(10, MODE_VOLUME), inner: true }), SIP_PROGRAM_ID, vault, "i")).toEqual([{ slot: 10n, signature: "i", rule: null }]);
  });
});

describe("findPolicyBoundary", () => {
  it("charges the whole span when nothing changed above its start, and reads no transaction to know it", async () => {
    const { reader, reads } = history([created(10, MODE_VOLUME), other(50), other(90)]);
    expect(await findPolicyBoundary({ reader, programId: SIP_PROGRAM_ID, vault, owner, from: 100n })).toMatchObject({ slot: null });
    expect(reads).toEqual([]);
  });

  it("starts a span switched from PROFIT to VOLUME at the switch", async () => {
    expect(await boundary([created(10, MODE_PROFIT), other(120), policy(150, MODE_VOLUME)], 100n)).toMatchObject({ slot: 150n });
  });

  it("starts it at the last change of the volume rate", async () => {
    expect(await boundary([created(10, MODE_VOLUME, 50), policy(130, MODE_VOLUME, 100), policy(160, MODE_VOLUME, 50)], 100n)).toMatchObject({ slot: 160n });
  });

  it("forgives nothing for a pause and an unpause", async () => {
    expect(await boundary([created(10, MODE_VOLUME, 50), policy(130, MODE_VOLUME, 50, true), policy(160, MODE_VOLUME, 50, false)], 100n)).toMatchObject({ slot: null });
  });

  it("judges the first change against the rule in force at the start, not against nothing", async () => {
    // Written below the start as VOLUME 50: a later write of VOLUME 50 is no change.
    expect(await boundary([created(10, MODE_PROFIT), policy(80, MODE_VOLUME, 50), policy(130, MODE_VOLUME, 50, true)], 100n)).toMatchObject({ slot: null });
    // Written below the start as PROFIT: the first VOLUME write above it is the switch.
    expect(await boundary([created(10, MODE_PROFIT), policy(130, MODE_VOLUME, 50), policy(140, MODE_VOLUME, 50, true)], 100n)).toMatchObject({ slot: 130n });
  });

  it("forgives up to a change it could not decode", async () => {
    expect(await boundary([created(10, MODE_VOLUME), { ...policy(140, MODE_VOLUME), inner: true }], 100n)).toMatchObject({ slot: 140n });
  });

  it("refuses when a transaction above the start cannot be read", async () => {
    await expect(boundary([created(10, MODE_VOLUME), policy(140, MODE_VOLUME, 20)], 100n, new Set(["policy-140"]))).rejects.toThrow(/could not be read/);
  });

  const FULL = MAX_OWNER_PAGES * OWNER_PAGE_LIMIT;

  it("refuses when its pages run out above the start without a single write", async () => {
    const busy = Array.from({ length: FULL }, (_, i) => other(200 + i));
    await expect(boundary([created(10, MODE_VOLUME), ...busy], 100n)).rejects.toThrow(/was not read back/);
  });

  it("counts the first change as a boundary when its pages run out before the rule at the start", async () => {
    const busy = Array.from({ length: FULL - 1 }, (_, i) => other(200 + i));
    expect(await boundary([created(10, MODE_VOLUME, 50), ...busy, policy(20_000, MODE_VOLUME, 50, true)], 100n)).toMatchObject({ slot: 20_000n });
  });
});

describe("PolicyBoundaryBook", () => {
  it("walks once while nothing new reaches the owner's history", async () => {
    const book = new PolicyBoundaryBook();
    const { reader, reads } = history([created(10, MODE_PROFIT), policy(150, MODE_VOLUME)]);
    const args = { reader, programId: SIP_PROGRAM_ID, vault, owner, from: 100n };
    expect(await book.boundary(args)).toMatchObject({ slot: 150n });
    const after = reads.length;
    expect(await book.boundary(args)).toMatchObject({ slot: 150n });
    expect(reads.length).toBe(after);
  });
});
