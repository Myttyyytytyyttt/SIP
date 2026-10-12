// C8, the `privy-address` cut: each wallet's Privy record by its address,
// remembered, instead of every Solana wallet in the app every sweep.
//
// TODAY (the cut off). Every sweep that turns anybody lists the app's Solana
// wallets — ⌈W/100⌉ requests, W the app's wallets, linked or not — on both
// keepers, 2,880 requests a day for a four-wallet app. When the listing fails,
// each wallet's signer resolution builds a listing of its own: N × ⌈W/100⌉
// requests in one sweep, the cliff the cost model put at about 145 users
// (dispatcher ADR §3.14 P6; COST_MODEL §7).
//
// WITH THE CUT. A book keyed by address:
//   * WARM-UP: the first sweep that needs a record lists the app ONCE (limit
//     100) and keeps every Solana wallet in it. A failed warm-up is retried
//     next sweep; meanwhile the addresses this sweep needs are asked one by one.
//   * STEADY STATE: a record is asked again BY ADDRESS (POST /v1/wallets/address,
//     src/privy-signer.ts) when it is due, and served from the book until then.
//     NEVER A FULL LISTING PER WALLET: the cliff has nowhere to come from.
//
// HOW OFTEN A RECORD IS ASKED AGAIN, and why the two answers differ:
//   * UNSIGNABLE — not a Privy wallet, the keeper's signer not seated, or seated
//     without the keeper's policy — every PRIVY_UNSIGNABLE_RECHECK_MS (a minute,
//     one default sweep). These are the records the OWNER fixes from the web
//     (Grant keeper permission, Re-seat keeper), and today he sees the fix work
//     at the next sweep. That latency is kept.
//   * SIGNABLE every PRIVY_SIGNABLE_RECHECK_MS (30 minutes), each on its own
//     phase so a thousand wallets warmed in one sweep are not all due in one
//     later sweep (the post-boot stagger of ADR RT-19). A signable record goes
//     stale only by its owner REMOVING or UNBOUNDING the seat. Privy enforces
//     the wallet's policy on every send whatever this book says, so the keeper
//     cannot sign anything it could not sign before; what waits up to 30 minutes
//     is the keeper NOTICING — the "none (signer not granted)" route and, for a
//     seat that loses its policy, the seat-unbounded page. That is the trade.
//   * AND AT ONCE AFTER A FAILED SEND. A submit Privy refuses forgets the
//     wallet's record (forgetOnFailure), so the next turn asks again: a seat
//     that went away is discovered by the first send that needed it, not 30
//     minutes later.
//
// A FAILED LOOKUP FAILS THAT WALLET'S RESOLUTION, as a failed listing and a
// failed full scan do today: the route reads "none (privy lookup failed)" and
// the wallet is not signed for this sweep. An expired record is NOT served in
// its place: an answer the book could not refresh is not one it may vouch for.

import type { PrivyAddressSource, PrivyWalletEntry, SolanaWalletSubmitter } from "./privy-signer.js";

/** A signable record is asked again after this long: 30 minutes, the doorbell's own safety bound. */
export const PRIVY_SIGNABLE_RECHECK_MS = 30 * 60 * 1_000;
/** An unsignable record is asked again after this long: one default sweep, today's latency for the owner's fix. */
export const PRIVY_UNSIGNABLE_RECHECK_MS = 60 * 1_000;
/** Lookups in flight at once. Bounded, so a cold book over many wallets neither serializes a sweep nor floods Privy. */
export const PRIVY_LOOKUP_CONCURRENCY = 4;

export interface PrivyAddressBookOptions {
  /** Whether a record would resolve to a signer (privy-signer.ts, seatsSignable, with the keeper's ids). */
  readonly signable: (entry: PrivyWalletEntry) => boolean;
  readonly signableRecheckMs?: number;
  readonly unsignableRecheckMs?: number;
  readonly concurrency?: number;
}

/** What the turns of ONE sweep may ask: the records it resolved, and the addresses it could not. */
export interface PrivySweepView {
  /**
   * The Privy wallets among the addresses asked, in createPrivySolanaSigner's
   * index shape: an address absent here and absent from `failed` is NOT a Privy
   * wallet in this app.
   */
  readonly index: ReadonlyMap<string, PrivyWalletEntry>;
  /** Addresses whose record could not be read this sweep, with a summary of why. Never a URL. */
  readonly failed: ReadonlyMap<string, string>;
}

/** The book's counters for /status: what it asked Privy and what it did not have to. */
export interface PrivyAddressBookStatus {
  /** Whether the warm-up listing has succeeded since boot. */
  readonly warm: boolean;
  /** Listing pages read since boot. 0 after warm-up is the cut working (rollout L1b go). */
  readonly listPages: number;
  readonly listFailures: number;
  /** Records asked by address since boot. */
  readonly lookups: number;
  readonly lookupFailures: number;
  /** Records served from the book without a request. */
  readonly cacheHits: number;
  /** Records dropped after a failed send. */
  readonly forgotten: number;
  readonly entries: number;
}

interface Held {
  readonly entry: PrivyWalletEntry | null;
  readonly dueAt: number;
}

/** A 32-bit FNV-1a of the address: a stable phase, so a wallet's recheck falls on its own minute. */
function phaseOf(address: string, periodMs: number): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < address.length; i += 1) {
    hash ^= address.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % Math.max(1, periodMs);
}

const reasonOf = (error: unknown): string => {
  // THE STATUS AND THE NAME, NEVER THE MESSAGE: an SDK error message can carry
  // the request, and the request carries the app id.
  const status = typeof error === "object" && error !== null ? (error as { readonly status?: unknown }).status : undefined;
  const name = error instanceof Error ? error.name : "unknown";
  return typeof status === "number" ? `${name} (HTTP ${status})` : name;
};

export class PrivyAddressBook {
  private readonly held = new Map<string, Held>();
  private warm = false;
  private listPages = 0;
  private listFailures = 0;
  private lookups = 0;
  private lookupFailures = 0;
  private cacheHits = 0;
  private forgotten = 0;
  private readonly signableRecheckMs: number;
  private readonly unsignableRecheckMs: number;
  private readonly concurrency: number;

  constructor(
    private readonly source: PrivyAddressSource,
    private readonly options: PrivyAddressBookOptions,
  ) {
    this.signableRecheckMs = options.signableRecheckMs ?? PRIVY_SIGNABLE_RECHECK_MS;
    this.unsignableRecheckMs = options.unsignableRecheckMs ?? PRIVY_UNSIGNABLE_RECHECK_MS;
    this.concurrency = Math.max(1, options.concurrency ?? PRIVY_LOOKUP_CONCURRENCY);
  }

  private recheckFor(entry: PrivyWalletEntry | null): number {
    return entry !== null && this.options.signable(entry) ? this.signableRecheckMs : this.unsignableRecheckMs;
  }

  /**
   * Resolves every address one sweep's turns will ask about, before the first
   * turn: the warm-up listing if the book is cold, then a lookup for each record
   * that is missing or due, a few at a time. Never throws: a failure is the
   * address's, in `failed`, and the rest of the sweep is unaffected.
   */
  async prepare(addresses: readonly string[], now: number): Promise<PrivySweepView> {
    const asked = [...new Set(addresses)];
    if (!this.warm && asked.length > 0) {
      try {
        const listed = await this.source.listAll(() => {
          this.listPages += 1;
        });
        for (const [address, entry] of listed) {
          // EACH SIGNABLE RECORD ON ITS OWN PHASE: due somewhere in the first
          // period, then every period from there.
          const period = this.recheckFor(entry);
          const offset = period === this.signableRecheckMs ? 1 + phaseOf(address, period) : period;
          this.held.set(address, { entry, dueAt: now + offset });
        }
        // THE LISTING IS THE APP'S WHOLE ANSWER AT THIS MOMENT: an address it
        // did not return is not a Privy wallet in this app, until asked again.
        for (const address of asked) {
          if (!listed.has(address)) this.held.set(address, { entry: null, dueAt: now + this.unsignableRecheckMs });
        }
        this.warm = true;
      } catch {
        // RETRIED NEXT SWEEP. Meanwhile this one asks by address below: one
        // request per wallet it needs, never a listing per wallet.
        this.listFailures += 1;
      }
    }

    const failed = new Map<string, string>();
    const due = asked.filter((address) => {
      const held = this.held.get(address);
      if (held !== undefined && held.dueAt > now) {
        this.cacheHits += 1;
        return false;
      }
      return true;
    });
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < due.length) {
        const address = due[next]!;
        next += 1;
        this.lookups += 1;
        try {
          const entry = await this.source.byAddress(address);
          this.held.set(address, { entry, dueAt: now + this.recheckFor(entry) });
        } catch (error) {
          this.lookupFailures += 1;
          // NOT SERVED STALE: the record it held is dropped with the failure,
          // so the next sweep asks again rather than trusting an old answer.
          this.held.delete(address);
          failed.set(address, reasonOf(error));
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, due.length) }, () => worker()));

    const index = new Map<string, PrivyWalletEntry>();
    for (const address of asked) {
      const entry = this.held.get(address)?.entry;
      if (entry !== null && entry !== undefined && !failed.has(address)) index.set(address, entry);
    }
    return { index, failed };
  }

  /** Drops one wallet's record, so its next turn asks Privy again. */
  forget(address: string): void {
    if (this.held.delete(address)) this.forgotten += 1;
  }

  /**
   * Keeps only the records of `wallets` — the ones this sweep discovered. A
   * warm-up keeps every wallet in the app; nobody unlinked is worth a row.
   */
  prune(wallets: ReadonlySet<string>): void {
    for (const address of this.held.keys()) if (!wallets.has(address)) this.held.delete(address);
  }

  status(): PrivyAddressBookStatus {
    return {
      warm: this.warm,
      listPages: this.listPages,
      listFailures: this.listFailures,
      lookups: this.lookups,
      lookupFailures: this.lookupFailures,
      cacheHits: this.cacheHits,
      forgotten: this.forgotten,
      entries: this.held.size,
    };
  }
}

/**
 * The same submitter, except that a send that throws first forgets the
 * wallet's record in `book`.
 *
 * NOTHING ELSE CHANGES: the shape check, the idempotency key and the one
 * attempt are the signer's own, and the error propagates untouched to the settle
 * turn that will report it. What this adds is that the NEXT turn asks Privy
 * about the wallet again instead of trusting a record up to 30 minutes old.
 */
export function forgetOnFailure(signer: SolanaWalletSubmitter, book: PrivyAddressBook): SolanaWalletSubmitter {
  return {
    address: signer.address,
    async submit(transaction, options) {
      try {
        return await signer.submit(transaction, options);
      } catch (error) {
        book.forget(signer.address.toBase58());
        throw error;
      }
    },
  };
}
