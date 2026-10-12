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
//     stale only by its owner REMOVING or UNBOUNDING the seat.
//   * AND RIGHT BEFORE EVERY SEND (confirmedSubmitter). A record served from the
//     book can be 30 minutes old, and a send on it used to be the keeper's first
//     notice of a removed seat: Privy refused it, the turn was FAILED, and
//     settleAlert paged "A settlement failed" — critical, and standing until a
//     settle landed again — for an owner pressing Remove SaverFi permission on
//     the web. Without the cut the same press is a NO_SIGNER warning at the next
//     sweep. So a live settle asks Privy about its wallet once more before it
//     leaves: a seat gone or unbounded since is that same NO_SIGNER, nothing is
//     sent, and the answer is kept, so the next sweep resolves the wallet from it
//     — a seat that lost its policy is SEAT_NOT_BOUNDED there and pages
//     seat-unbounded, a sweep after the send it stopped.
//     ONE READ PER SEND, NOT PER SWEEP. A link settles well under once a day
//     (0.22–0.8 measured, disp-measure RECHECK D3), each settle one send plus
//     its retries. Reading every turned wallet's seats every sweep — what
//     caching the wallet id alone would mean — is N reads a sweep, and at N ≤ 50
//     the safety lane alone turns every link every sweep (SAFETY_MIN_PER_SWEEP,
//     src/doorbell.ts): more requests than today's one listing page, against the
//     2,880 list requests a day the cut is meant to save (COST_MODEL §7).
//   * AND AT ONCE AFTER A FAILED SEND. A submit Privy refuses forgets the
//     wallet's record, so the next turn asks again.
//
// WHAT STILL WAITS UP TO 30 MINUTES is the keeper noticing a change on a wallet
// it sends nothing for: the route /status shows and, for a seat that loses its
// policy, the seat-unbounded page. Nothing is signed for such a wallet in that
// time — nothing is sent without asking first — and Privy enforces the wallet's
// policy on every send whatever this book says. That is the trade.
//
// A FAILED LOOKUP FAILS THAT WALLET'S RESOLUTION, as a failed listing and a
// failed full scan do today: the route reads "none (privy lookup failed)" and
// the wallet is not signed for this sweep. An expired record is NOT served in
// its place: an answer the book could not refresh is not one it may vouch for.
// (The read right before a send is the exception, and confirmedSubmitter says
// why: the record it would replace is one the sweep already resolved from.)

import { SeatWithdrawnError, type PrivyAddressSource, type PrivyWalletEntry, type SolanaWalletSubmitter } from "./privy-signer.js";

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
  /**
   * Sends stopped because the read right before them found the seat gone or
   * unbounded: each one a turn reported NO_SIGNER instead of a refused send.
   * Above 0 means a record the book served was stale when it was used.
   */
  readonly withdrawnAtSend: number;
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
  private withdrawnAtSend = 0;
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

  /** Whether a record would resolve to a signer: the options' rule, and never for an address that is not a Privy wallet. */
  signable(entry: PrivyWalletEntry | null): boolean {
    return entry !== null && this.options.signable(entry);
  }

  private recheckFor(entry: PrivyWalletEntry | null): number {
    return this.signable(entry) ? this.signableRecheckMs : this.unsignableRecheckMs;
  }

  /**
   * Asks Privy about ONE wallet now, by address, and keeps the answer as the
   * book keeps any lookup's: prepare's due records, and the read a send makes
   * right before it leaves (confirmedSubmitter). THROWS WHAT THE LOOKUP THREW,
   * after dropping the record it held — an answer the book could not refresh is
   * not one it vouches for again.
   */
  async refresh(address: string, now: number): Promise<PrivyWalletEntry | null> {
    this.lookups += 1;
    try {
      const entry = await this.source.byAddress(address);
      this.held.set(address, { entry, dueAt: now + this.recheckFor(entry) });
      return entry;
    } catch (error) {
      this.lookupFailures += 1;
      this.held.delete(address);
      throw error;
    }
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
        try {
          await this.refresh(address, now);
        } catch (error) {
          // NOT SERVED STALE: refresh dropped the record it held with the
          // failure, so the next sweep asks again rather than trusting an old answer.
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

  /** One send stopped by the read right before it (confirmedSubmitter): counted for /status. */
  noteWithdrawnAtSend(): void {
    this.withdrawnAtSend += 1;
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
      withdrawnAtSend: this.withdrawnAtSend,
      entries: this.held.size,
    };
  }
}

/**
 * The same submitter, with the book's two checks around a send: the wallet's
 * seat is asked about right before it (confirmSeat), and a send that throws
 * forgets the wallet's record.
 *
 * CONFIRMSEAT, called by settle-tick.ts once a live settle is built and shape-
 * checked, before the carry is recorded and before anything leaves. One read by
 * address (PrivyAddressBook.refresh), whose answer the book keeps:
 *   * STILL SIGNABLE — resolves, and the send goes as it always did;
 *   * GONE OR UNBOUNDED, or no longer a Privy wallet — throws SeatWithdrawnError,
 *     which the turn reports NO_SIGNER: nothing sent, nothing paged critical;
 *   * COULD NOT ASK — resolves, and the send goes on the record the sweep
 *     resolved, as every send went before this read existed. Privy enforces the
 *     wallet's policy on it all the same, and the record is dropped, so the next
 *     sweep asks again. A Privy that cannot answer a read does not also stop a
 *     settle it may still accept: that would be a new way for money not to move,
 *     and a NO_SIGNER the cut-off keeper would never have reported.
 *
 * NOTHING ELSE CHANGES: the shape check, the idempotency key and the one
 * attempt are the signer's own, and a send's error propagates untouched to the
 * settle turn that will report it.
 */
export function confirmedSubmitter(
  signer: SolanaWalletSubmitter,
  book: PrivyAddressBook,
  clock: () => number = () => Date.now(),
): SolanaWalletSubmitter {
  const address = signer.address.toBase58();
  return {
    address: signer.address,
    async confirmSeat() {
      let entry: PrivyWalletEntry | null;
      try {
        entry = await book.refresh(address, clock());
      } catch {
        return;
      }
      if (book.signable(entry)) return;
      book.noteWithdrawnAtSend();
      throw new SeatWithdrawnError(address, entry === null ? "NOT_A_PRIVY_WALLET" : "NOT_SIGNABLE");
    },
    async submit(transaction, options) {
      try {
        return await signer.submit(transaction, options);
      } catch (error) {
        book.forget(address);
        throw error;
      }
    },
  };
}
