// The transaction a Jupiter route has to travel in, and why the legacy one cannot carry it.
//
// THE CLAIM UNDER TEST IS A SIZE. invest-tick.ts built a legacy
// `new Transaction()` for every send, which was right for as long as the venue
// was Raydium CLMM: a concentrated-liquidity swap lists few enough accounts to
// fit one 1,232-byte packet. Jupiter's do not. A legacy transaction cannot
// carry an address lookup table, so there is no price, no retry and no
// compute-budget setting that makes an oversized one send — it is refused by
// the wire format itself.
//
// MEASURED, NOT ASSUMED, on 2026-09-21 against lite-api.jup.ag, USDC ->
// ANTHROPIC (Pren1FvFX…) at $25 and 200 bps, by
// scripts/measure-route-size.mts. Five live routes, each the whole invest
// instruction with both compute-budget instructions in front of it:
//
//   hops  venues                                  legacy  v0 bare  v0 + tables
//   2     Quantum, Manifest                        1,266    1,268          778
//   2     GoonFi V2, Manifest                      1,302    1,304          814
//   2     HumidiFi, Manifest                       1,403    1,405          915
//   3     Deriverse, GoonFi V2, Manifest           1,670    1,672          906
//   3     JupLend AMM, Raydium CLMM, Manifest      1,936    1,938          955
//
// EVERY ONE IS OVER THE 1,232-BYTE LIMIT WITHOUT TABLES — the closest by 34
// bytes, the worst by 704 — and every one fits with them, the tightest with
// 277 bytes to spare. The spread is the point: Jupiter re-picks the venues per
// quote, so the size belongs to the ROUTE THAT WAS RETURNED and not to the
// leg. No single number here is a constant of ANTHROPIC, and a test that pinned
// one as though it were would go red on a re-quote rather than on a
// regression. What is pinned is one CAPTURED route, recompiled from its own
// bytes.
//
// THE FIXTURE IS A REAL MAINNET BUILD, in the sense docs/TESTING_TRAPS.md asks
// for: test/fixtures/anthropic-route.json holds the invest instruction that
// route really produced — its 47 account keys, its data — and the FULL
// contents of the two lookup tables it really named, so the message
// recompiled here is the message the cluster was offered. Re-capture it with
//   node_modules/.bin/tsx scripts/measure-route-size.mts --dump test/fixtures/anthropic-route.json
// and the three byte counts below move together with it.

import { readFileSync } from "node:fs";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  PACKET_DATA_SIZE,
  PublicKey,
  type AccountMeta,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import type * as anchor from "@coral-xyz/anchor";
import { describe, expect, it } from "vitest";
import {
  COMPUTE_UNIT_LIMIT,
  COMPUTE_UNIT_PRICE_MICRO_LAMPORTS,
  ROUTE_MAX_AGE_MS,
  budgetedInstructions,
  buildV0Transaction,
  lookupTableCache,
  lookupTablesOf,
  venueAccountsOf,
  sendWithBudget,
  versionedTransactionBytes,
} from "../src/invest-tick.js";
import { legacyTransactionBytes, type JupiterRoute } from "../src/program-scripts.js";

interface RouteFixture {
  readonly hops: number;
  readonly labels: readonly string[];
  readonly payer: string;
  readonly instruction: {
    readonly programId: string;
    readonly keys: readonly { readonly pubkey: string; readonly isSigner: boolean; readonly isWritable: boolean }[];
    readonly data: string;
  };
  readonly lookupTables: readonly { readonly address: string; readonly addresses: readonly string[] }[];
  readonly bytes: { readonly legacy: number; readonly v0NoTables: number; readonly v0WithTables: number };
}

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/anthropic-route.json", import.meta.url), "utf8"),
) as RouteFixture;

const payer = new PublicKey(fixture.payer);
const investInstruction = new TransactionInstruction({
  programId: new PublicKey(fixture.instruction.programId),
  keys: fixture.instruction.keys.map(
    (key): AccountMeta => ({ pubkey: new PublicKey(key.pubkey), isSigner: key.isSigner, isWritable: key.isWritable }),
  ),
  data: Buffer.from(fixture.instruction.data, "base64"),
});
const tables = fixture.lookupTables.map(
  (table) =>
    new AddressLookupTableAccount({
      key: new PublicKey(table.address),
      state: {
        deactivationSlot: 2n ** 64n - 1n,
        lastExtendedSlot: 0,
        lastExtendedSlotStartIndex: 0,
        addresses: table.addresses.map((address) => new PublicKey(address)),
      },
    }),
);
// A PLACEHOLDER BLOCKHASH, as the measurement used: 32 bytes whatever it says.
const blockhash = PublicKey.default.toBase58();
const instructions = budgetedInstructions([investInstruction]);
const v0 = (lookupTables: readonly AddressLookupTableAccount[]) =>
  buildV0Transaction({ payer, recentBlockhash: blockhash, instructions, lookupTables });

describe("the size of a Jupiter route's transaction", () => {
  it("does not fit a legacy transaction, by the margin the capture recorded", () => {
    const bytes = legacyTransactionBytes(payer, instructions);
    expect(bytes).toBe(fixture.bytes.legacy);
    expect(bytes).toBeGreaterThan(PACKET_DATA_SIZE);
  });

  it("does not fit a versioned transaction either, until the tables are in it", () => {
    // TWO BYTES MORE THAN LEGACY, for the version prefix and the empty
    // table-lookup count — so "make it versioned" is not on its own a fix.
    expect(versionedTransactionBytes(v0([]))).toBe(fixture.bytes.v0NoTables);
    expect(versionedTransactionBytes(v0([]))).toBe(fixture.bytes.legacy + 2);
    expect(versionedTransactionBytes(v0([]))).toBeGreaterThan(PACKET_DATA_SIZE);
  });

  it("fits once the route's own lookup tables carry its accounts", () => {
    const bytes = versionedTransactionBytes(v0(tables));
    expect(bytes).toBe(fixture.bytes.v0WithTables);
    expect(bytes).toBeLessThanOrEqual(PACKET_DATA_SIZE);
    // The compression is the tables', and it is most of the transaction.
    expect(fixture.bytes.legacy - bytes).toBeGreaterThan(400);
  });

  it("really does route through the tables, rather than merely carrying them", () => {
    // WHAT A TABLE CHANGES IS THE PRICE OF AN ACCOUNT, NOT THE COUNT OF THEM.
    // The route lists 47 keys, which the compiler deduplicates to 32 distinct
    // accounts either way. Bare, all 32 are written out at 32 bytes each;
    // through the tables, 14 are written out and 18 are referenced by a
    // one-byte index — which is the whole 490-byte saving.
    const accounts = (transaction: VersionedTransaction) => {
      const message = transaction.message;
      const pulled = message.addressTableLookups.reduce(
        (total, lookup) => total + lookup.writableIndexes.length + lookup.readonlyIndexes.length,
        0,
      );
      return { static: message.staticAccountKeys.length, pulled, total: message.staticAccountKeys.length + pulled };
    };
    expect(accounts(v0([]))).toEqual({ static: 32, pulled: 0, total: 32 });
    expect(accounts(v0(tables))).toEqual({ static: 14, pulled: 18, total: 32 });
    expect(v0(tables).message.addressTableLookups.map((lookup) => lookup.accountKey.toBase58()).sort()).toEqual(
      fixture.lookupTables.map((table) => table.address).sort(),
    );
  });
});

describe("versionedTransactionBytes", () => {
  it("agrees with web3.js byte for byte, on a transaction web3.js can serialize", () => {
    const transaction = v0(tables);
    expect(versionedTransactionBytes(transaction)).toBe(transaction.serialize().length);
  });

  it("agrees on the captured route even though that route does not fit", () => {
    // A TRAP WORTH NAMING: web3.js caps the MESSAGE at one packet, not the
    // TRANSACTION. This route's message is 1,203 bytes, so serialize()
    // succeeds and returns 1,268 — a transaction already 36 bytes past the
    // wire limit. "It serialized" is therefore not evidence that it fits;
    // only the comparison against PACKET_DATA_SIZE is.
    const oversized = v0([]);
    expect(oversized.message.serialize().length).toBe(fixture.bytes.v0NoTables - 65);
    expect(oversized.serialize().length).toBe(fixture.bytes.v0NoTables);
    expect(versionedTransactionBytes(oversized)).toBe(fixture.bytes.v0NoTables);
    expect(fixture.bytes.v0NoTables).toBeGreaterThan(PACKET_DATA_SIZE);
  });

  it("still answers once the message itself passes what web3.js will encode", () => {
    // THE WHOLE REASON THIS FUNCTION EXISTS. Past a 1,232-byte MESSAGE,
    // serialize() does not return a large number — it throws, and "it threw"
    // is not a byte count. jupiter-route.ts's v0TransactionBytes() calls
    // serialize() and inherits this, which is why the measurement script does
    // not use it. Three of the five routes sampled on 2026-09-21 were this
    // big; the filler below stands in for them so the case needs no network.
    const filler = new TransactionInstruction({
      programId: new PublicKey(fixture.instruction.programId),
      keys: Array.from({ length: 40 }, () => ({ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: false })),
      data: Buffer.alloc(0),
    });
    const oversized = buildV0Transaction({
      payer,
      recentBlockhash: blockhash,
      instructions: budgetedInstructions([investInstruction, filler]),
      lookupTables: [],
    });
    expect(() => oversized.serialize()).toThrow(/overrun/i);
    const bytes = versionedTransactionBytes(oversized);
    expect(bytes).toBeGreaterThan(PACKET_DATA_SIZE);
    // Exactly what the wire format says the filler costs: 40 further distinct
    // accounts written out in full, their 40 one-byte indexes, and the
    // instruction's own three header bytes (programIdIndex, the compact-u16
    // index count, the compact-u16 data length).
    expect(bytes).toBe(fixture.bytes.v0NoTables + 40 * 32 + 40 * 1 + 3);
  });
});

describe("the compute budget", () => {
  const decode = (instruction: TransactionInstruction) => ({
    program: instruction.programId.toBase58(),
    discriminant: instruction.data[0],
    value: instruction.data.readUInt32LE(1),
  });

  it("is a limit AND a price, in that order, at the values a congested slot is bid", () => {
    const [limit, price, rest] = budgetedInstructions([investInstruction]);
    expect(decode(limit!)).toEqual({
      program: ComputeBudgetProgram.programId.toBase58(),
      discriminant: 2,
      value: COMPUTE_UNIT_LIMIT,
    });
    expect(decode(price!)).toEqual({
      program: ComputeBudgetProgram.programId.toBase58(),
      discriminant: 3,
      value: COMPUTE_UNIT_PRICE_MICRO_LAMPORTS,
    });
    expect(rest).toBe(investInstruction);
    // THE NUMBER IS PINNED WITH ITS REASON BESIDE IT, because the last one was
    // pinned without: 600_000 was derived for one Raydium CLMM swap plus an
    // ATA create, the venue moved to Jupiter, and the pin then kept the old
    // venue's budget alive across the change that retired it. 1_400_000 is what
    // Jupiter's own /swap-instructions asked for on these routes and is the
    // per-transaction maximum, so a route one hop longer than expected cannot
    // revert for compute.
    expect(COMPUTE_UNIT_LIMIT).toBe(1_400_000);
    expect(COMPUTE_UNIT_LIMIT, "the runtime's per-transaction ceiling").toBeLessThanOrEqual(1_400_000);
    expect(COMPUTE_UNIT_PRICE_MICRO_LAMPORTS).toBe(10_000);
    // And what the bid costs, stated rather than left to be inferred: 14_000
    // lamports of priority on top of the 5_000-lamport signature fee.
    expect((COMPUTE_UNIT_LIMIT * COMPUTE_UNIT_PRICE_MICRO_LAMPORTS) / 1_000_000).toBe(14_000);
  });

  it("rides the v0 transaction exactly as it rides the legacy one", () => {
    // THE VENUE MUST NOT CHANGE THE BID. A Jupiter transaction competes for the
    // same slots as a Raydium one, and this is the assertion that the move to
    // v0 did not quietly drop either instruction or reorder them.
    const legacy = new Transaction().add(...budgetedInstructions([investInstruction]));
    const versioned = v0(tables).message;
    expect(legacy.instructions.slice(0, 2).map(decode)).toEqual(
      versioned.compiledInstructions.slice(0, 2).map((compiled) =>
        decode(
          new TransactionInstruction({
            programId: versioned.staticAccountKeys[compiled.programIdIndex]!,
            keys: [],
            data: Buffer.from(compiled.data),
          }),
        ),
      ),
    );
  });
});

describe("venueAccountsOf", () => {
  // THIS GUARD DID NOT EXIST UNTIL 2026-09-21, and it was found by removing it:
  // deleting the `isSigner: false` re-map left all 18 cases in this file green.
  //
  // WHAT IT COSTS TO GET WRONG. Jupiter marks the vault PDA a signer in slot 2
  // of its own instruction, which is correct for the INNER CPI and impossible
  // for the outer one — a PDA cannot sign a transaction. A signer flag that
  // survived into the outer instruction would make the message demand a
  // signature nobody can produce, so every invest and every convert would fail
  // to sign, on every sweep. invest.rs and convert.rs re-mark exactly that key
  // for the CPI themselves; that is the whole authority the program lends.
  it("clears every signer flag, including the vault's own, which is the one Jupiter sets", () => {
    const vault = Keypair.generate().publicKey;
    const route = {
      remainingAccounts: [
        { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: false },
        { pubkey: vault, isSigner: true, isWritable: false },
        { pubkey: Keypair.generate().publicKey, isSigner: true, isWritable: true },
      ],
    } as unknown as Parameters<typeof venueAccountsOf>[0];

    const metas = venueAccountsOf(route);
    expect(metas.map((meta) => meta.isSigner)).toEqual([false, false, false]);
    // AND NOTHING ELSE MOVED. Writability is the route's own and the program
    // mirrors it into the CPI, so flattening it here would change which
    // accounts the venue may touch.
    expect(metas.map((meta) => meta.isWritable)).toEqual([false, false, true]);
    expect(metas.map((meta) => meta.pubkey.toBase58())).toEqual(route.remainingAccounts.map((m) => m.pubkey.toBase58()));
  });
});

describe("lookupTablesOf", () => {
  it("finds none on a route that named none, which is what keeps the legacy send reachable", () => {
    // THIS CASE USED TO BE "a Raydium route", whose LiveRoute had no
    // lookupTableAddresses field at all. There is no Raydium route any more —
    // but the EMPTY answer is still reachable and still load-bearing: Jupiter
    // returns no tables for plenty of one-hop builds, and sendWithBudget reads
    // empty as "send this legacy", not as an error.
    const none = { lookupTableAddresses: [] } as unknown as Parameters<typeof lookupTablesOf>[0];
    expect(lookupTablesOf(none)).toEqual([]);
  });

  it("finds a Jupiter route's, under the field name jupiter-route.ts really uses", () => {
    // TWO ENDS, ONE ASSERTION. `lookupTableAddresses` is read here and written
    // in jupiter-route.ts's JupiterRoute; the fixture's own table addresses are
    // the third party neither side can quietly disagree with.
    const addresses = fixture.lookupTables.map((table) => new PublicKey(table.address));
    const route = { lookupTableAddresses: addresses } as unknown as Parameters<typeof lookupTablesOf>[0];
    expect(lookupTablesOf(route).map((a) => a.toBase58())).toEqual(fixture.lookupTables.map((t) => t.address));
  });
});

describe("lookupTableCache", () => {
  const table = (address: PublicKey) =>
    new AddressLookupTableAccount({
      key: address,
      state: { deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: [] },
    });

  it("fetches each table once however many legs ask for it", async () => {
    const asked: string[] = [];
    const connection = {
      getAddressLookupTable: async (address: PublicKey) => {
        asked.push(address.toBase58());
        return { context: { slot: 1 }, value: table(address) };
      },
    } as unknown as Parameters<typeof lookupTableCache>[0];
    const cache = lookupTableCache(connection);
    const [a, b] = [Keypair.generate().publicKey, Keypair.generate().publicKey];

    // Three legs of one basket, the third sharing both tables with the others.
    const [first, second, third] = await Promise.all([
      cache.tablesFor([a, b]),
      cache.tablesFor([a]),
      cache.tablesFor([a, b]),
    ]);
    expect(asked.sort()).toEqual([a.toBase58(), b.toBase58()].sort());
    expect(first.map((t) => t.key.toBase58())).toEqual([a.toBase58(), b.toBase58()]);
    expect(second).toHaveLength(1);
    expect(third).toHaveLength(2);
    // Later in the same turn, still no new round trip.
    await cache.tablesFor([a, b]);
    expect(asked).toHaveLength(2);
  });

  it("refuses a table the chain does not have, instead of compiling around it", async () => {
    const connection = {
      getAddressLookupTable: async () => ({ context: { slot: 1 }, value: null }),
    } as unknown as Parameters<typeof lookupTableCache>[0];
    const missing = Keypair.generate().publicKey;
    await expect(lookupTableCache(connection).tablesFor([missing])).rejects.toThrow(
      new RegExp(`${missing.toBase58()} is not on chain`),
    );
  });

  it("does not remember a failed read as that table's answer", async () => {
    let attempt = 0;
    const address = Keypair.generate().publicKey;
    const connection = {
      getAddressLookupTable: async (key: PublicKey) => {
        attempt += 1;
        if (attempt === 1) throw new Error("rpc blipped");
        return { context: { slot: 1 }, value: table(key) };
      },
    } as unknown as Parameters<typeof lookupTableCache>[0];
    const cache = lookupTableCache(connection);
    await expect(cache.tablesFor([address])).rejects.toThrow("rpc blipped");
    // A cached REJECTION would make one blip the answer for the rest of the turn.
    expect((await cache.tablesFor([address]))[0]!.key.toBase58()).toBe(address.toBase58());
    expect(attempt).toBe(2);
  });
});

describe("sendWithBudget", () => {
  const crank = Keypair.generate();
  /**
   * A route as old as the caller says. Only `age` is read by the freshness
   * check, and stating the age is the whole point of the fixture: a route with
   * an arbitrary clock would randomise the field under dispute.
   */
  const routeAged = (ageMs: number) =>
    ({
      age: { quotedAtMs: Date.now() - ageMs, quotedAtSlot: null, oldestHopSlot: null, oldestHopLabel: null, quoteTimeTakenMs: null },
    }) as unknown as JupiterRoute;
  const fresh = () => routeAged(0);
  const sent: (Transaction | VersionedTransaction)[] = [];
  const provider = (wallet: PublicKey) =>
    ({
      wallet: { publicKey: wallet },
      connection: {
        getLatestBlockhash: async () => ({ blockhash: "3Nx5J6yqnGRrZ2mYqPSgDh1ZrmQnrgjSvJnBeCxMwGWk", lastValidBlockHeight: 1 }),
      },
      sendAndConfirm: async (transaction: Transaction | VersionedTransaction) => {
        sent.push(transaction);
        return "signature";
      },
    }) as unknown as anchor.AnchorProvider;

  it("sends a LEGACY transaction while the route carries no tables", async () => {
    sent.length = 0;
    // NOT "while the venue is Raydium" any more — there is no Raydium path. A
    // Jupiter route that names no tables takes this branch, and it is the send
    // that has been confirming on mainnet since 2026-09-19, so it must not move
    // just because the venue above it did.
    await sendWithBudget(provider(Keypair.generate().publicKey), crank, [investInstruction], fresh());
    const [transaction] = sent;
    expect(transaction).toBeInstanceOf(Transaction);
    // ANCHOR FILLS THESE IN on the legacy branch, which is why they are unset here.
    expect((transaction as Transaction).recentBlockhash).toBeUndefined();
    expect((transaction as Transaction).feePayer).toBeUndefined();
    expect((transaction as Transaction).instructions).toHaveLength(3);
  });

  it("sends a VERSIONED transaction once the route names tables, carrying them", async () => {
    sent.length = 0;
    await sendWithBudget(provider(crank.publicKey), crank, [investInstruction], fresh(), tables);
    const [transaction] = sent;
    expect(transaction).toBeInstanceOf(VersionedTransaction);
    const message = (transaction as VersionedTransaction).message;
    expect(message.addressTableLookups).toHaveLength(tables.length);
    expect(versionedTransactionBytes(transaction as VersionedTransaction)).toBeLessThanOrEqual(PACKET_DATA_SIZE);
  });

  it("supplies the fee payer and the blockhash itself, because Anchor does not", async () => {
    sent.length = 0;
    await sendWithBudget(provider(crank.publicKey), crank, [investInstruction], fresh(), tables);
    const message = (sent[0] as VersionedTransaction).message;
    // AnchorProvider.sendAndConfirm (0.32.1) sets feePayer and recentBlockhash
    // ONLY on the legacy branch; a v0 message that arrived without them would
    // be sent unsigned-for and expired.
    expect(message.staticAccountKeys[0]!.toBase58()).toBe(crank.publicKey.toBase58());
    expect(message.recentBlockhash).toBe("3Nx5J6yqnGRrZ2mYqPSgDh1ZrmQnrgjSvJnBeCxMwGWk");
  });

  it("RE-AGES THE ROUTE IMMEDIATELY BEFORE THE SIGNATURE, on both branches", async () => {
    // jupiter-route.ts says a caller holding a route for a while re-runs
    // verifyRouteFresh before it signs, and until 2026-09-21 nothing did: the
    // only enforcement was inside verifySharedAccountsRoute at BUILD time,
    // with a probe quote, two account reads, a balance, a token-account read,
    // a lookup-table fetch per table and a blockhash all happening afterwards.
    // min_out was sized off the quote's own otherAmountThreshold, so a stalled
    // RPC meant paying for Jupiter's slippage revert instead of refusing for
    // free.
    sent.length = 0;
    const stale = routeAged(ROUTE_MAX_AGE_MS + 1);
    await expect(sendWithBudget(provider(crank.publicKey), crank, [investInstruction], stale, tables)).rejects.toThrow(/route-age/);
    await expect(sendWithBudget(provider(crank.publicKey), crank, [investInstruction], stale)).rejects.toThrow(/ms old, past the 30000 ms/);
    expect(sent, "a route past its window costs a refusal, not a transaction").toHaveLength(0);
    // And one inside the window still sends, or the check would just be an off switch.
    await sendWithBudget(provider(crank.publicKey), crank, [investInstruction], routeAged(ROUTE_MAX_AGE_MS - 1_000), tables);
    expect(sent).toHaveLength(1);
  });

  it("refuses in words when the crank is not the provider's wallet", async () => {
    // N=1 TODAY, AND THAT IS THE TRAP. bin/keeper.mts passes the settle keypair
    // as the crank — "the attester and the crank are this one key during the
    // hackathon" — so the two readings of "who pays" agree by coincidence. The
    // legacy branch survives them separating (Anchor makes the WALLET the fee
    // payer); this one cannot, because Anchor signs with its wallet after us and
    // VersionedTransaction.sign throws on a key that is not a required signer.
    const stranger = Keypair.generate().publicKey;
    await expect(sendWithBudget(provider(stranger), crank, [investInstruction], fresh(), tables)).rejects.toThrow(
      /payable by the crank .* but the provider's wallet is/,
    );
  });
});
