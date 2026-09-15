// A wallet's ledger in memory, read through the walk's own LedgerReader, so a
// walk is tested without a network. It refuses the two shortcuts that looked
// cheapest and were wrong: a read at any commitment but finalized, and any
// `until` in a signature request.
//
// Entries are given oldest first, as the chain executed them, and served newest
// first, as getSignaturesForAddress serves them, in pages that honour `before`
// and `limit`. Each transaction is a real MessageV0 whose first key is the
// wallet and whose instructions invoke the entry's programs, with the wallet's
// balances at index 0, so the walk's key and program extraction runs on it
// unchanged. Every request is recorded with its arguments.

import { MessageV0, PublicKey, type Finality, type TransactionError, type VersionedTransactionResponse } from "@solana/web3.js";
import type { LedgerReader } from "../src/measure-window.js";

export interface LedgerEntry {
  readonly signature: string;
  readonly slot: number;
  /** The wallet's lamports before and after, fee included. */
  readonly pre: number;
  readonly post: number;
  readonly programs: readonly string[];
  readonly err?: TransactionError | null;
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
    const message = new MessageV0({
      header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: programs.length },
      staticAccountKeys: [this.wallet, ...programs],
      recentBlockhash: PublicKey.default.toBase58(),
      compiledInstructions: programs.map((_, i) => ({ programIdIndex: i + 1, accountKeyIndexes: [0], data: new Uint8Array() })),
      addressTableLookups: [],
    });
    const programBalances = programs.map(() => 1);
    return {
      slot: entry.slot,
      version: 0,
      blockTime: null,
      transaction: { message, signatures: [entry.signature] },
      meta: {
        err: entry.err ?? null,
        fee: 5_000,
        preBalances: [entry.pre, ...programBalances],
        postBalances: [entry.post, ...programBalances],
        innerInstructions: [],
        loadedAddresses: { writable: [], readonly: [] },
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
