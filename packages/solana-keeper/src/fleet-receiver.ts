// The webhook receiver of the dispatcher's fleet (Q4): a Helius delivery rings
// its vaults IN POSTGRES, so whichever scheduler replica holds the lock sees it
// (dispatcher ADR §3.10, [QUEUE] §2.9, failure matrix row 17; plan §3.3.1 Q4).
//
// WHY THE BELL MOVES OUT OF MEMORY. Today the doorbell (src/doorbell.ts) lives
// in the one keeper that holds the claim and also answers /hooks/helius, so a
// bell rung in its memory is a bell its next sweep reads. The dispatcher runs
// the receiver on EVERY scheduler replica, two of them, and Railway is ASSUMED
// to spread public traffic across replicas (ADR §8 Q9, never checked): a
// delivery can land on the replica that does not hold `sip-solana-scheduler`.
// A bell kept in that replica's memory would be a bell nobody selects. So the
// receiver writes it where the acting scheduler, and every worker's COMPLETE,
// reads: `vault_work.bell_at`, `lane = 'bell'`, `priority = 0`, and a due time
// no later than BELL_DELAY_MS from now.
//
// WHAT IS KEPT FROM TODAY'S RECEIVER, unchanged, because it is the same route:
// the Authorization header is compared in constant time and the 200 is written
// BEFORE the body is handled (httpHandler and receiveDelivery, src/status.ts,
// which this file plugs into through HooksRoute — the legacy /hooks/helius path
// itself is not touched). What changes is only what `accepted` does with the
// body.
//
// THE MAPPING IS POSTGRES'S, NOT THIS PROCESS'S. The legacy doorbell rings only
// the addresses it discovered (Doorbell.ingest's `known`), because that set is
// in its memory. A receiver on a replica that runs no discovery has no such
// set, so it hands Postgres every string SHAPED like an account address (base58,
// 32 to 44 characters: a 32-byte key) and lets `keeper_link` say which are a
// wallet or a vault of a live link. Unknown strings ring nothing, exactly as
// before; what changes is where they are dropped. A signature (64 bytes, about
// 88 characters) is not address-shaped and never matches, and the walk keeps the
// legacy bounds (MAX_WALK_*), so what one delivery can make this process hold
// is bounded by the walk, not by the sender.
//
// IF THE WRITE FAILS, THE SCHEDULER IS TOLD TO LOOK AT EVERYONE. A bell that
// could not be written is a delivery the scheduler will never see, and Helius
// does not resend what was answered 200. So a failed bell write becomes a
// request for a full pass in `fleet.full_pass_reason` — the shared version of
// Doorbell.lost (src/doorbell.ts) — and if even that write fails, Postgres is
// down for this replica: the request is kept and retried (FULL_PASS_RETRY_MS,
// or with the next delivery), and meanwhile the 30-minute safety rotation still
// turns every link, the same guarantee as for a delivery Helius dropped after
// its three retries ([QUEUE] §2.9).
//
// ONE WRITE IN FLIGHT PER REPLICA. A busy trading wallet can produce several
// deliveries a second. Each one used to be a map insertion; here it would be a
// statement, and the scheduler's pool is ONE connection beside its lock's pinned
// one (SCHEDULER_POOL_MAX, src/dispatch-store.ts: ADR §3.11's 3 + 2r), shared
// with the tick and the fleet page. So deliveries that arrive while a write is in flight are merged into the next
// one: the bell's timestamp is the write's, at most one write later than the
// delivery, and the due time is BELL_DELAY_MS after that — a delay the walk's
// finality wait needs anyway.
//
// DARK. Nothing in the legacy keepers imports this file, and nothing else does
// yet: the dispatcher's scheduler entry point (Q2) is to construct it, and
// production starts no such process until the owner says so (plan §2 rule 1). Until the last vault moves to the queue
// (P3d), the webhook stays with the legacy profit keeper (plan §3.3.1 design
// detail 2): Helius delivers there, and this receiver hears nothing at all.

import { summarizeUpstreamError } from "@sip/solana-log";
import { MAX_WALK_DEPTH, MAX_WALK_NODES, MAX_WALK_STRINGS } from "./doorbell.js";
import type { HooksRoute } from "./status.js";

/**
 * How long after a bell its vault becomes due: fifteen seconds (ADR §3.7 "bell
 * delay"). Finality trails confirmation by about 13 s (ASSUMED) and the window
 * walk reads finalized history only, so a job claimed the instant Helius
 * delivered would walk a window that does not contain the trade yet.
 * LEAST(due_at, …): a bell never makes a vault due LATER than it already was.
 */
export const BELL_DELAY_MS = 15_000;

/**
 * The most distinct address-shaped strings one write carries: 20,000. A RAW
 * delivery of one transaction names a few dozen accounts; this is hundreds of
 * full transactions' worth. Past it the delivery, or the merged batch, is not
 * rung piecemeal: a full pass is requested instead, because a partial bell is
 * a bell that says "nothing else happened" about vaults it never mentioned.
 */
export const MAX_BELL_ADDRESSES = 20_000;

/** The most distinct transaction signatures one write marks as echoed. Past it, the same full pass. */
export const MAX_BELL_SIGNATURES = 20_000;

/**
 * How often a 403 may ask for a full pass from one replica: once per five
 * seconds. A 403 before this replica has heard the webhook authenticate may be
 * Helius sending an old header after a rotation, and 403 is the one 4xx Helius
 * never resends (Doorbell.rejected, src/doorbell.ts) — so it asks for a full
 * pass, as today. But here each request is a Postgres write, and a stranger
 * POSTing wrong headers to a freshly booted replica could otherwise turn a
 * request flood into a write flood. Helius's own retries of one delivery come
 * a second apart, three times: all four answers fall inside one window and are
 * one request, which is exactly what they mean.
 */
export const REJECT_FULL_PASS_COALESCE_MS = 5_000;

/**
 * When a full-pass request that could not be written is tried again, if no
 * delivery comes first to carry it: thirty seconds, half a tick. Postgres down
 * for this replica is the only way to get here; trying faster helps nobody.
 */
export const FULL_PASS_RETRY_MS = 30_000;

/** The longest full-pass reason written: the column is free text, and a reason is a sentence. */
export const FULL_PASS_REASON_MAX_CHARS = 500;

/**
 * Address-shaped: base58's alphabet, 32 to 44 characters — what a 32-byte
 * public key encodes to. A transaction signature (64 bytes) is longer, and so
 * is every log line Helius carries.
 */
const ADDRESS_SHAPE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** What one delivery says, read once and bounded. */
export interface Delivery {
  /** Distinct address-shaped strings found anywhere in it. Most are programs, mints and pools; Postgres keeps the ones that are links. */
  readonly addresses: readonly string[];
  /** Distinct signatures of the transactions it carries: the echo evidence for `send_intent.echoed_at`. */
  readonly signatures: readonly string[];
  /** Transactions that look like one: a signature and a numeric slot (Doorbell's rule, src/doorbell.ts). */
  readonly transactions: number;
  /** The newest blockTime among them, in seconds, or null. */
  readonly newestBlockTime: number | null;
  /** Set when the delivery could not be read whole: a full pass is owed for it. */
  readonly lost: string | null;
}

/** transaction.signatures[0], or an enhanced payload's top-level `signature` — Doorbell's reading, kept identical. */
function signatureOf(tx: Record<string, unknown>): string | null {
  const inner = tx["transaction"];
  if (typeof inner === "object" && inner !== null) {
    const signatures = (inner as Record<string, unknown>)["signatures"];
    if (Array.isArray(signatures) && typeof signatures[0] === "string") return signatures[0];
  }
  const flat = tx["signature"];
  return typeof flat === "string" ? flat : null;
}

/**
 * A parsed delivery's addresses and transactions.
 *
 * SHAPE-INDEPENDENT FOR THE SAME REASON AS THE DOORBELL: the 1 USDC deposit to
 * the owner's vault names the vault only as a token balance's owner, and his
 * Axiom trades are version 1 transactions a v0 parser refuses (Doorbell.ingest).
 * Every string value anywhere is a candidate; nothing parses a message.
 */
export function readPayload(payload: unknown): Delivery {
  const addresses = new Set<string>();
  let lost: string | null = null;
  let strings = 0;
  let nodes = 0;
  const stack: { readonly value: unknown; readonly depth: number }[] = [{ value: payload, depth: 0 }];
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_WALK_NODES) {
      lost = `a delivery with more than ${MAX_WALK_NODES} nodes was not read whole`;
      break;
    }
    if (typeof value === "string") {
      strings += 1;
      if (strings > MAX_WALK_STRINGS) {
        lost = `a delivery with more than ${MAX_WALK_STRINGS} strings was not read whole`;
        break;
      }
      if (ADDRESS_SHAPE.test(value) && !addresses.has(value)) {
        if (addresses.size >= MAX_BELL_ADDRESSES) {
          lost = `a delivery naming more than ${MAX_BELL_ADDRESSES} distinct addresses was not rung piecemeal`;
          break;
        }
        addresses.add(value);
      }
      continue;
    }
    if (typeof value !== "object" || value === null) continue;
    if (depth >= MAX_WALK_DEPTH) {
      lost = `a delivery nested deeper than ${MAX_WALK_DEPTH} levels was not read whole`;
      continue;
    }
    const children = Array.isArray(value) ? value : Object.values(value);
    for (const child of children) stack.push({ value: child, depth: depth + 1 });
  }

  const signatures = new Set<string>();
  let transactions = 0;
  let newestBlockTime: number | null = null;
  for (const item of Array.isArray(payload) ? payload : [payload]) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const tx = item as Record<string, unknown>;
    const signature = signatureOf(tx);
    const slot = tx["slot"];
    // ONLY WHAT LOOKS LIKE ONE (Doorbell's rule): an authenticated `[{}]` names
    // no transaction and must not count as the webhook having been heard.
    if (signature === null || typeof slot !== "number" || !Number.isFinite(slot)) continue;
    transactions += 1;
    if (!signatures.has(signature)) {
      if (signatures.size >= MAX_BELL_SIGNATURES) {
        lost ??= `a delivery carrying more than ${MAX_BELL_SIGNATURES} transactions was not read whole`;
        break;
      }
      signatures.add(signature);
    }
    const blockTime = tx["blockTime"];
    if (typeof blockTime === "number" && Number.isFinite(blockTime) && (newestBlockTime === null || blockTime > newestBlockTime)) {
      newestBlockTime = blockTime;
    }
  }
  return { addresses: [...addresses], signatures: [...signatures], transactions, newestBlockTime, lost };
}

/** The body as it arrived. A body that is not JSON is a delivery lost, never a crash. */
export function readDelivery(body: string): Delivery {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return { addresses: [], signatures: [], transactions: 0, newestBlockTime: null, lost: "a delivery that is not JSON was not read" };
  }
  return readPayload(payload);
}

/** One write's worth of bells: what the deliveries since the last write named. */
export interface BellBatch {
  readonly addresses: readonly string[];
  readonly signatures: readonly string[];
  /** BELL_DELAY_MS, passed rather than baked into the SQL so a test can read what was asked. */
  readonly bellDelayMs: number;
}

/** What a bell write did: vaults whose row it rang, and intents it marked echoed. */
export interface BellWrite {
  readonly vaults: number;
  readonly echoes: number;
}

/**
 * Where bells are written. PgFleetStore (src/fleet-pg.ts) is the real one, over
 * Q1's tables in sql/sip_solana.sql and on the scheduler's pool from
 * createDispatchPool(…, "scheduler") (src/dispatch-store.ts). Both methods may
 * throw: the receiver turns every failure into a full-pass request or a retry,
 * and never into silence.
 */
export interface FleetBellStore {
  /** Maps the addresses to vaults through `keeper_link`, rings their `vault_work` rows, and marks the signatures' intents echoed. */
  ring(batch: BellBatch): Promise<BellWrite>;
  /** Asks the acting scheduler for a full pass (`fleet.full_pass_reason`). Keeps a request already pending. */
  requestFullPass(reason: string): Promise<void>;
}

/** The receiver as /status shows it: what arrived, what was written, and what is still owed. */
export interface FleetReceiverStatus {
  /** Authenticated deliveries handed over since boot. */
  readonly deliveries: number;
  /** Transactions among them that look like one. */
  readonly transactions: number;
  readonly rejected: number;
  /** 403s that asked for no full pass of their own because one had just been asked (REJECT_FULL_PASS_COALESCE_MS). */
  readonly rejectedCoalesced: number;
  /** Deliveries that could not be read whole: oversize, not JSON, too deep, too wide. */
  readonly lost: number;
  /** Whether this replica has heard the webhook send this secret: an authenticated transaction, or the sync's word. */
  readonly authConfirmed: boolean;
  readonly lastEventAt: string | null;
  /** How long after its block the newest transaction of the last delivery arrived. */
  readonly lastEventLagMs: number | null;
  readonly writes: number;
  readonly writeFailures: number;
  /** Vault rows rung, summed over writes: a vault rung by two writes counts twice. */
  readonly vaultsRung: number;
  /** Intents marked echoed, summed over writes. */
  readonly echoesMarked: number;
  readonly fullPassRequests: number;
  readonly fullPassFailures: number;
  /** A full pass this replica owes the scheduler and could not write yet, or null. */
  readonly fullPassOwed: string | null;
  readonly lastWriteAt: string | null;
  readonly lastWriteError: string | null;
  /** Addresses and signatures waiting for the write in flight to finish. */
  readonly pending: { readonly addresses: number; readonly signatures: number };
}

export interface FleetReceiverOptions {
  readonly store: FleetBellStore;
  /** Whether the Authorization header is the doorbell secret: authorizationMatcher (src/status.ts), constant time. */
  readonly authorized: (header: string | undefined) => boolean;
  /** The keeper's logger, or a test's. Every failure is logged; nothing here throws into it. */
  readonly log: (level: "info" | "warn", message: string, fields?: Record<string, unknown>) => void;
  /** Injected for tests. */
  readonly now?: () => number;
  /** The retry timer, injected for tests; unref'd by default so it never holds a process open. */
  readonly schedule?: (run: () => void, ms: number) => void;
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

const defaultSchedule = (run: () => void, ms: number): void => {
  const timer = setTimeout(run, ms);
  timer.unref?.();
};

/**
 * One scheduler replica's receiver: what it hands httpHandler (src/status.ts)
 * as the `hooks` route, and what it shows on the fleet /status.
 *
 * NOTHING THROWS OUT OF IT. receiveDelivery already guards each callback, but
 * the writes run after the callback has returned, on promises nobody awaits:
 * each is caught here, because an unhandled rejection is one more way for a
 * malformed delivery to reach the process's exit trap.
 */
export class FleetReceiver {
  readonly #store: FleetBellStore;
  readonly #authorizedHeader: (header: string | undefined) => boolean;
  readonly #log: FleetReceiverOptions["log"];
  readonly #now: () => number;
  readonly #schedule: (run: () => void, ms: number) => void;

  readonly #pendingAddresses = new Set<string>();
  readonly #pendingSignatures = new Set<string>();
  /** The full pass owed, the FIRST reason kept: any one of them is enough, and the first is the cause. */
  #owed: string | null = null;
  #inFlight: Promise<void> | null = null;
  /** A retry timer is set for the owed full pass: until it fires, the owed request alone starts no write. */
  #retryArmed = false;
  #authConfirmed = false;
  #lastRejectRequestAt: number | null = null;

  #deliveries = 0;
  #transactions = 0;
  #rejected = 0;
  /** 403s since the last authenticated transaction: the webhook sync's evidence (deliveryCounts). */
  #rejectedSinceAccepted = 0;
  #rejectedCoalesced = 0;
  #lost = 0;
  #lastEventAt: number | null = null;
  #lastEventLagMs: number | null = null;
  #writes = 0;
  #writeFailures = 0;
  #vaultsRung = 0;
  #echoesMarked = 0;
  #fullPassRequests = 0;
  #fullPassFailures = 0;
  #lastWriteAt: number | null = null;
  #lastWriteError: string | null = null;

  constructor(options: FleetReceiverOptions) {
    this.#store = options.store;
    this.#authorizedHeader = options.authorized;
    this.#log = options.log;
    this.#now = options.now ?? (() => Date.now());
    this.#schedule = options.schedule ?? defaultSchedule;
  }

  /** The route httpHandler serves at /hooks/helius on a scheduler replica. */
  route(): HooksRoute {
    return {
      authorized: (header) => this.#authorizedHeader(header),
      accepted: (body) => this.accept(body),
      rejected: () => this.reject(),
      lost: (reason) => this.lose(reason),
    };
  }

  /** An authenticated body, after its 200 has gone. */
  accept(body: Buffer): void {
    this.#deliveries += 1;
    const delivery = readDelivery(body.toString("utf8"));
    const now = this.#now();
    if (delivery.transactions > 0) {
      this.#transactions += delivery.transactions;
      this.#rejectedSinceAccepted = 0;
      // AN AUTHENTICATED TRANSACTION IS PROOF the webhook sends this secret
      // (Doorbell.ingest): from here on, a 403 is a stranger guessing.
      this.#authConfirmed = true;
      this.#lastEventAt = now;
      this.#lastEventLagMs = delivery.newestBlockTime === null ? null : Math.max(0, now - delivery.newestBlockTime * 1000);
    }
    if (delivery.lost !== null) {
      this.#lost += 1;
      this.#owe(delivery.lost);
    }
    // WHAT WAS READ IS RUNG EVEN WHEN THE REST WAS NOT: the full pass covers
    // what was missed, and the bell still puts what was seen first in line.
    this.#merge(delivery);
    this.#kick();
  }

  /** A delivery refused 403 (Doorbell.rejected's rule, with a Postgres write behind it). */
  reject(): void {
    this.#rejected += 1;
    this.#rejectedSinceAccepted += 1;
    if (this.#authConfirmed) return;
    const now = this.#now();
    if (this.#lastRejectRequestAt !== null && now - this.#lastRejectRequestAt < REJECT_FULL_PASS_COALESCE_MS) {
      this.#rejectedCoalesced += 1;
      return;
    }
    this.#lastRejectRequestAt = now;
    this.#owe("a delivery was refused 403 before this replica knew the webhook sends this secret; Helius does not resend it");
    this.#kick();
  }

  /** A delivery that could not be read whole (receiveDelivery's 413): what it carried is unknown. */
  lose(reason: string): void {
    this.#lost += 1;
    this.#owe(reason);
    this.#kick();
  }

  /**
   * The webhook's Authorization header is known to be this secret: the acting
   * scheduler's webhook sync confirmed or wrote it (Doorbell.confirmAuthorization).
   * A replica that does not sync learns it from its first authenticated delivery.
   */
  confirmAuthorization(): void {
    this.#authConfirmed = true;
  }

  /**
   * What this replica counted, in the shape the webhook sync judges a hidden
   * header by (Doorbell.deliveryCounts, src/helius-webhooks.ts DeliveryCounts):
   * transactions authenticated, deliveries refused, and refused since the last
   * authenticated one. Only the lock holder syncs (bin/scheduler.mts), and it
   * hands the sync its own replica's counts: deliveries the other replica took
   * are not in them, which can only make a header look less proven, never more.
   */
  deliveryCounts(): { readonly accepted: number; readonly rejected: number; readonly rejectedSinceAccepted: number } {
    return { accepted: this.#transactions, rejected: this.#rejected, rejectedSinceAccepted: this.#rejectedSinceAccepted };
  }

  /**
   * Resolves once nothing is in flight and nothing is pending that a write
   * would carry now — for a SIGTERM drain, and for tests. An owed full pass
   * waiting on its retry timer is not "pending now".
   */
  async idle(): Promise<void> {
    while (this.#inFlight !== null) await this.#inFlight;
  }

  status(): FleetReceiverStatus {
    return {
      deliveries: this.#deliveries,
      transactions: this.#transactions,
      rejected: this.#rejected,
      rejectedCoalesced: this.#rejectedCoalesced,
      lost: this.#lost,
      authConfirmed: this.#authConfirmed,
      lastEventAt: iso(this.#lastEventAt),
      lastEventLagMs: this.#lastEventLagMs,
      writes: this.#writes,
      writeFailures: this.#writeFailures,
      vaultsRung: this.#vaultsRung,
      echoesMarked: this.#echoesMarked,
      fullPassRequests: this.#fullPassRequests,
      fullPassFailures: this.#fullPassFailures,
      fullPassOwed: this.#owed,
      lastWriteAt: iso(this.#lastWriteAt),
      lastWriteError: this.#lastWriteError,
      pending: { addresses: this.#pendingAddresses.size, signatures: this.#pendingSignatures.size },
    };
  }

  #owe(reason: string): void {
    if (this.#owed === null) this.#owed = reason.slice(0, FULL_PASS_REASON_MAX_CHARS);
  }

  /**
   * Adds a delivery to the next write. A merged batch past the bounds is
   * dropped whole for a full pass: the bounds exist so a write stays one
   * reasonable statement, and a full pass loses nothing a partial bell would
   * have caught.
   */
  #merge(delivery: Delivery): void {
    for (const address of delivery.addresses) this.#pendingAddresses.add(address);
    for (const signature of delivery.signatures) this.#pendingSignatures.add(signature);
    if (this.#pendingAddresses.size > MAX_BELL_ADDRESSES || this.#pendingSignatures.size > MAX_BELL_SIGNATURES) {
      this.#pendingAddresses.clear();
      this.#pendingSignatures.clear();
      this.#owe(`more deliveries arrived during one bell write than one write carries (${MAX_BELL_ADDRESSES} addresses, ${MAX_BELL_SIGNATURES} signatures)`);
    }
  }

  /**
   * Starts a write unless one is in flight; the one in flight starts the next
   * when it ends. An owed full pass ALONE starts nothing while its retry timer
   * is set: with Postgres down, each failure would otherwise start the next
   * attempt at once, forever. A new delivery still carries it.
   */
  #kick(): void {
    if (this.#inFlight !== null) return;
    const bells = this.#pendingAddresses.size > 0 || this.#pendingSignatures.size > 0;
    const owed = this.#owed !== null && !this.#retryArmed;
    if (!bells && !owed) return;
    this.#inFlight = this.#flush()
      .catch(() => undefined)
      .finally(() => {
        this.#inFlight = null;
        this.#kick();
      });
  }

  async #flush(): Promise<void> {
    const addresses = [...this.#pendingAddresses];
    const signatures = [...this.#pendingSignatures];
    this.#pendingAddresses.clear();
    this.#pendingSignatures.clear();
    if (addresses.length > 0 || signatures.length > 0) {
      try {
        const wrote = await this.#store.ring({ addresses, signatures, bellDelayMs: BELL_DELAY_MS });
        this.#writes += 1;
        this.#vaultsRung += wrote.vaults;
        this.#echoesMarked += wrote.echoes;
        this.#lastWriteAt = this.#now();
      } catch (error) {
        this.#writeFailures += 1;
        this.#lastWriteError = summarizeUpstreamError(error);
        // THE BELL IS GONE, AND THE SCHEDULER MUST NOT TAKE ITS ABSENCE FOR "NOTHING HAPPENED".
        this.#owe(`a bell write failed (${this.#lastWriteError}); which vaults it would have rung is unknown to the scheduler`);
        this.#log("warn", "the fleet receiver could not write a bell; asking the scheduler for a full pass", {
          addresses: addresses.length,
          signatures: signatures.length,
          detail: this.#lastWriteError,
        });
      }
    }
    const reason = this.#owed;
    if (reason === null) return;
    this.#owed = null;
    try {
      await this.#store.requestFullPass(reason);
      this.#fullPassRequests += 1;
    } catch (error) {
      this.#fullPassFailures += 1;
      this.#lastWriteError = summarizeUpstreamError(error);
      // KEPT, NOT DROPPED: the next delivery or the retry timer writes it.
      this.#owe(reason);
      this.#log("warn", "the fleet receiver could not ask for a full pass either; the 30-minute safety rotation still turns every link", {
        reason,
        detail: this.#lastWriteError,
        retryInMs: FULL_PASS_RETRY_MS,
      });
      this.#armRetry();
    }
  }

  #armRetry(): void {
    if (this.#retryArmed) return;
    this.#retryArmed = true;
    this.#schedule(() => {
      this.#retryArmed = false;
      this.#kick();
    }, FULL_PASS_RETRY_MS);
  }
}
