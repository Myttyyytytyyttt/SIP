// A wallet's ledger in memory, read through the walk's own LedgerReader, so a
// walk is tested without a network. It refuses the two shortcuts that looked
// cheapest and were wrong: a read at any commitment but finalized, and any
// `until` in a signature request.
//
// Entries are given oldest first, as the chain executed them, and served newest
// first, as getSignaturesForAddress serves them, in pages that honour `before`
// and `limit`. Each transaction is a real message whose instructions invoke the
// entry's programs over the wallet, with the wallet's balances where its key
// sits, so the walk's key, program and signer extraction runs on it unchanged.
// Unless an entry says otherwise it is a MessageV0 the wallet alone signs, first
// among its keys; an entry can name other signers, load the wallet from an
// address lookup table, or ask for a legacy message. Every request is recorded
// with its arguments.

import { Message, MessageV0, PublicKey, type Finality, type TransactionError, type VersionedTransactionResponse } from "@solana/web3.js";
import type { LedgerReader } from "../src/measure-window.js";

/** The table a looked-up wallet is loaded from. Nothing reads it: a response carries the keys it loaded. */
const LOOKUP_TABLE = new PublicKey(Buffer.alloc(32, 7));

export interface LedgerEntry {
  readonly signature: string;
  readonly slot: number;
  /** The wallet's lamports before and after, fee included. */
  readonly pre: number;
  readonly post: number;
  readonly programs: readonly string[];
  readonly err?: TransactionError | null;
  /**
   * Who signed, fee payer first: the message's first static keys. Absent, the
   * wallet alone signs and pays, as it does for its own trades. A wallet left out
   * of it is an unsigned static key right after the signers, or, with
   * `walletThroughLookup`, no static key at all.
   */
  readonly signers?: readonly PublicKey[];
  /** The wallet is loaded from an address lookup table, after every static key: a v0 message only, and never a signer. */
  readonly walletThroughLookup?: boolean;
  /** A legacy message instead of a v0 one. */
  readonly legacy?: boolean;
}

export class FakeLedger implements LedgerReader {
  readonly signatureCalls: { readonly before?: string; readonly limit: number; readonly commitment: Finality }[] = [];
  readonly transactionCalls: { readonly signature: string; readonly commitment: Finality }[] = [];
  private readonly newestFirst: readonly LedgerEntry[];
  private readonly bySignature: ReadonlyMap<string, LedgerEntry>;

  constructor(
    private readonly wallet: PublicKey,
    oldestFirst: readonly LedgerEntry[],
    /** Signatures answered with null, as a throttling RPC answers without erroring. */
    private readonly unreadable: ReadonlySet<string> = new Set(),
  ) {
    for (let i = 1; i < oldestFirst.length; i++) {
      if (oldestFirst[i]!.slot < oldestFirst[i - 1]!.slot) throw new Error(`entry ${oldestFirst[i]!.signature} is older than the one before it`);
    }
    this.newestFirst = [...oldestFirst].reverse();
    this.bySignature = new Map(oldestFirst.map((entry) => [entry.signature, entry]));
    if (this.bySignature.size !== oldestFirst.length) throw new Error("the fake ledger holds a signature twice");
  }

  async signatures(
    wallet: PublicKey,
    options: { readonly before?: string; readonly limit: number },
    commitment: Finality,
  ): Promise<{ signature: string; slot: number }[]> {
    if (!wallet.equals(this.wallet)) throw new Error(`the fake ledger holds ${this.wallet.toBase58()}, not ${wallet.toBase58()}`);
    if (commitment !== "finalized") throw new Error(`signatures read at ${commitment}: the walk reads finalized history only`);
    if ("until" in options) throw new Error("the walk passed until, which skips trades made between a window's end and its settle");
    if (options.limit < 1 || options.limit > 1_000) throw new Error(`limit ${options.limit} is outside the RPC's 1..1000`);
    this.signatureCalls.push({ ...options, commitment });
    let start = 0;
    if (options.before !== undefined) {
      const at = this.newestFirst.findIndex((entry) => entry.signature === options.before);
      if (at < 0) throw new Error(`before ${options.before} is not in the fake ledger`);
      start = at + 1;
    }
    return this.newestFirst.slice(start, start + options.limit).map(({ signature, slot }) => ({ signature, slot }));
  }

  async transaction(signature: string, commitment: Finality): Promise<VersionedTransactionResponse | null> {
    if (commitment !== "finalized") throw new Error(`transaction ${signature} read at ${commitment}: the walk reads finalized history only`);
    this.transactionCalls.push({ signature, commitment });
    const entry = this.bySignature.get(signature);
    if (entry === undefined) throw new Error(`${signature} is not in the fake ledger`);
    if (this.unreadable.has(signature)) return null;
    const programs = entry.programs.map((program) => new PublicKey(program));
    const signers = entry.signers ?? [this.wallet];
    if (signers.length === 0) throw new Error(`entry ${signature} names no signer, and every transaction has a fee payer`);
    const walletSigns = signers.some((signer) => signer.equals(this.wallet));
    const throughLookup = entry.walletThroughLookup === true;
    if (throughLookup && (walletSigns || entry.legacy === true)) {
      throw new Error(`entry ${signature} loads the wallet from a lookup table, which only a v0 message does, and never for a signer`);
    }
    // The signers, then the wallet when it is an unsigned static key, then the
    // programs, read-only and unsigned. A looked-up key follows every static one.
    const staticAccountKeys = [...signers, ...(walletSigns || throughLookup ? [] : [this.wallet]), ...programs];
    const accountKeys = throughLookup ? [...staticAccountKeys, this.wallet] : staticAccountKeys;
    const walletIndex = accountKeys.findIndex((key) => key.equals(this.wallet));
    const firstProgram = staticAccountKeys.length - programs.length;
    const header = { numRequiredSignatures: signers.length, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: programs.length };
    const recentBlockhash = PublicKey.default.toBase58();
    const message =
      entry.legacy === true
        ? new Message({
            header,
            accountKeys: staticAccountKeys,
            recentBlockhash,
            instructions: programs.map((_, i) => ({ programIdIndex: firstProgram + i, accounts: [walletIndex], data: "" })),
          })
        : new MessageV0({
            header,
            staticAccountKeys,
            recentBlockhash,
            compiledInstructions: programs.map((_, i) => ({ programIdIndex: firstProgram + i, accountKeyIndexes: [walletIndex], data: new Uint8Array() })),
            addressTableLookups: throughLookup ? [{ accountKey: LOOKUP_TABLE, writableIndexes: [0], readonlyIndexes: [] }] : [],
          });
    // The wallet's balances at its own index; every other account holds one lamport throughout.
    const balances = (lamports: number) => accountKeys.map((key) => (key.equals(this.wallet) ? lamports : 1));
    return {
      slot: entry.slot,
      version: entry.legacy === true ? "legacy" : 0,
      blockTime: null,
      transaction: { message, signatures: signers.map((_, i) => (i === 0 ? entry.signature : `${entry.signature}:${i}`)) },
      meta: {
        err: entry.err ?? null,
        fee: 5_000,
        preBalances: balances(entry.pre),
        postBalances: balances(entry.post),
        innerInstructions: [],
        loadedAddresses: { writable: throughLookup ? [this.wallet] : [], readonly: [] },
        logMessages: [],
      },
    };
  }
}

/**
 * Entries whose balances chain from `balance`: each pre is the previous post.
 * `delta` is what the transaction did to the wallet, fee included.
 */
export function chained(
  balance: number,
  specs: readonly (Omit<LedgerEntry, "pre" | "post"> & { readonly delta: number })[],
): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  for (const { delta, ...entry } of specs) {
    entries.push({ ...entry, pre: balance, post: balance + delta });
    balance += delta;
  }
  return entries;
}
