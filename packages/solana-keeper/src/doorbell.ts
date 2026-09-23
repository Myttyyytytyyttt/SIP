// The doorbell (el timbre): Helius tells the keeper which wallets and vaults
// just moved, so a sweep turns those — plus a rotating safety slice — instead
// of every link it knows.
//
// WHY IT EXISTS. Measured in production on 2026-09-23: an idle user costs ~210
// ms per sweep (six RPC calls, most of them the invest turn's reads), on top of
// ~465 ms that every sweep pays once, against a 60 s interval — about 280
// users before sweeps start to overrun and get skipped. Almost every one of
// those turns asks a wallet that did nothing whether it did anything. The
// chain already knows who moved; a RAW webhook on the owner's own trading
// wallet and vault delivered 11 of 11 transactions, 1-3 s after the block,
// with no duplicate and the Authorization header echoed exactly.
//
// PURE. No socket, no clock, no RPC: every method takes `now`, and the
// receiver (src/status.ts) and the wiring (bin/keeper.mts) do the I/O. What is
// decided here is decided in test/doorbell.test.ts, against real payloads.
//
// SAFE BY CONSTRUCTION, because the owner wants it ACTIVE FROM THE START. The
// doorbell can only ever REMOVE turns from a sweep, and every way it could be
// wrong about which ones falls back to today's behaviour — every link, every
// sweep — rather than to silence:
//
//   * IT IS TRUSTED ONLY ONCE IT HAS BEEN HEARD, and only while it keeps
//     hearing the keeper's OWN transactions. Every settle and every purchase the
//     keeper sends touches a watched address, so it must come back through the
//     webhook; one that has not within ECHO_DEADLINE_MS makes the doorbell
//     "deaf", and a deaf doorbell is a FULL pass every sweep until an event
//     arrives again.
//   * A FULL PASS on boot, on a takeover of the claim, on the protocol being
//     unpaused, after any delivery it could not read whole, and after any
//     window in which Helius is KNOWN to have dropped deliveries: a webhook the
//     sync had to create, switch back on or give the right header, and a 403
//     before the header was confirmed (src/doorbell-wiring.ts).
//   * A BELL IS ANSWERED BY A TURN, NOT BY THE CLOCK: it holds its links in the
//     bell lane until a turn that began after it comes out resting (HOLD_MS).
//   * A LINK THAT IS NOT RESTING IS TURNED EVERY SWEEP (the "busy" lane), so
//     everything that time alone resolves — finality, a retry, a backlog, a
//     refused basket — never waits on a bell.
//   * EVERY LINK IS STILL TURNED on a rotation (the "safety" lane), at least
//     SAFETY_MIN_PER_SWEEP per sweep and all of them within SAFETY_PASS_MS. At
//     fifty links or fewer that is every link, every sweep: at hackathon scale
//     the doorbell changes nothing but what /status reports.

import type { InvestOutcome } from "./invest-tick.js";
import type { SettleOutcome } from "./settle-decision.js";

/**
 * The LEAST time a rung address keeps its links in the "bell" lane: three
 * minutes. A bell is let go only once this has passed AND a turn has answered
 * it (BELL_ANSWER_MARGIN_MS) — never by the clock alone.
 *
 * FINALITY TRAILS CONFIRMED BY ~13 s, AND THE TURN READS BOTH. The settle's
 * cheap probe reads the confirmed tip, while the walk reads finalized history
 * only, so a trade seen by the probe before it is final comes out
 * PENDING_FINALITY (src/settle-decision.ts) and has to be turned again. That
 * one is busy and would be turned anyway; the hold covers the other order — a
 * bell that arrives, a turn that runs a moment too early to see anything at all
 * — with one full 60 s sweep and a margin on top.
 *
 * WHY NOT THE CLOCK ALONE (review, 2026-09-23). A bell that lapsed after 180 s
 * whatever had happened lapsed unanswered whenever no select ran in between:
 * three sweeps that threw in readChainSnapshot, or ONE full pass longer than the
 * hold — which at the measured 210 ms per idle user is any fleet past ~850
 * links, and ~35 min at 10,000. Every trade made during a boot, takeover or
 * unpause pass then waited for the safety lane, and was logged as the webhook's
 * "possible miss" when the webhook had delivered it in 1-3 s.
 */
export const HOLD_MS = 180_000;

/**
 * How long after a bell a turn must have STARTED to answer it: twenty seconds.
 *
 * Helius delivers once the transaction is confirmed; the keeper's own endpoint
 * can trail that by a few slots, and a turn that began before it could see the
 * trade comes out IDLE — resting — having seen nothing. Twenty seconds covers
 * the measured 1-3 s delivery, ~13 s of finality and endpoint lag with room to
 * spare; a turn that began sooner leaves the bell ringing for the next sweep.
 */
export const BELL_ANSWER_MARGIN_MS = 20_000;

/**
 * How long a transaction the keeper sent may take to come back through the
 * webhook before the doorbell is declared deaf: five minutes, against a
 * measured 1-3 s.
 *
 * GENEROUS ON PURPOSE. A false "deaf" costs full passes until the next event —
 * exactly today's behaviour — and a warn line; a deadline tight enough to trip
 * on a slow Helius minute would teach an operator to ignore the alert.
 */
export const ECHO_DEADLINE_MS = 300_000;

/** The safety lane's floor per sweep. At N <= 50 this is every link, every sweep. */
export const SAFETY_MIN_PER_SWEEP = 50;

/** The longest any link waits for the safety lane: thirty minutes, whatever N is. */
export const SAFETY_PASS_MS = 30 * 60_000;

/**
 * The most addresses held as rung at once. Only KNOWN addresses are ever held
 * (two per link at most), so this is a ceiling a real fleet does not reach; a
 * map that did would be a bug, and reaching it asks for a full pass rather than
 * silently dropping a bell.
 */
export const MAX_RUNG = 200_000;

/** How deep and how wide one delivery is walked. Past any of these, it was not read whole. */
export const MAX_WALK_DEPTH = 32;
export const MAX_WALK_STRINGS = 500_000;
/**
 * Every value visited, of any kind. Strings alone were bounded, and 4 MiB of
 * `[{},{},…]` walked 1.4 million empty objects (~210 ms of one event loop the
 * money path shares) without being called lost. A real delivery of 4 MiB — a
 * few hundred full getTransaction results — is well under half of this.
 */
export const MAX_WALK_NODES = 1_000_000;

/**
 * Signatures delivered and not (yet) expected, kept so an echo that arrives
 * BEFORE the keeper registers it still counts. Held ECHO_DEADLINE_MS, at most
 * this many; the oldest go first.
 */
export const MAX_SEEN_SIGNATURES = 100_000;

/** Sent-and-not-yet-echoed signatures kept at most; a sweep sends a handful. */
export const MAX_ECHOES_PENDING = 10_000;

export type Lane = "full" | "bell" | "busy" | "new" | "safety";

export interface LaneCounts {
  readonly full: number;
  readonly bell: number;
  readonly busy: number;
  readonly new: number;
  readonly safety: number;
}

/** A discovered link as the doorbell sees it: three base58 addresses. */
export interface DoorLink {
  readonly link: string;
  readonly wallet: string;
  readonly vault: string;
}

export interface Turn<T extends DoorLink> {
  readonly link: T;
  readonly lane: Lane;
}

export interface Selection<T extends DoorLink> {
  /** Why this sweep turns every link, or null when it turns a selection. */
  readonly fullReason: string | null;
  /** In link-address order, each with the first lane that selected it. */
  readonly turns: readonly Turn<T>[];
  readonly lanes: LaneCounts;
}

export interface IngestReport {
  readonly transactions: number;
  readonly rung: number;
  readonly echoes: number;
  /** Set when the delivery could not be read whole; a full pass has been requested. */
  readonly lost: string | null;
}

export interface Trust {
  readonly trusted: boolean;
  readonly reason: string | null;
}

/** The doorbell's own half of the /status block. The webhook half is src/helius-webhooks.ts's. */
export interface DoorbellCoreStatus {
  readonly enabled: boolean;
  readonly trusted: boolean;
  readonly untrustedReason: string | null;
  /** Transactions delivered and authenticated since boot. */
  readonly eventsReceived: number;
  /** Deliveries refused 403: a wrong or missing Authorization header. */
  readonly eventsRejected: number;
  /** Deliveries that could not be read whole (oversize, unparseable, too deep): each forced a full pass. */
  readonly eventsLost: number;
  readonly lastEventAt: string | null;
  /** How long after its block the newest transaction of the last delivery arrived. */
  readonly lastEventLagMs: number | null;
  readonly rungAddresses: number;
  /** The last sweep's lanes, or null before the first. */
  readonly lanes: (LaneCounts & { readonly total: number }) | null;
  readonly possibleMisses: number;
  readonly lastPossibleMiss: { readonly wallet: string; readonly at: string; readonly outcome: string } | null;
  readonly echoesPending: number;
  readonly echoesMissed: number;
}

// ── whether a finished turn may rest ──────────────────────────────────────────

export type TurnSettle = SettleOutcome | "THREW";
export type TurnInvest = InvestOutcome | "THREW";

/**
 * Whether a settle outcome may wait for a bell, or must be turned again next
 * sweep regardless.
 *
 * THE RULE: RESTING is a state that only a new transaction on the wallet or
 * the vault can change — and that transaction rings the bell. BUSY is anything
 * that time, a retry, a human off-chain, or the next page of a backlog can
 * change: none of those ring anything.
 *
 * EXHAUSTIVE, AND THE COMPILER SAYS SO. A new SettleOutcome member fails the
 * typecheck here until somebody decides which it is; a default would decide it
 * for them, silently, and "resting" is the default that loses money.
 */
export function settleRests(outcome: TurnSettle): boolean {
  switch (outcome) {
    // Nothing since the frontier; only a new transaction changes that, and it rings.
    case "IDLE":
      return true;
    // Confirmed but not finalized yet: TIME resolves it, and nothing rings when finality arrives.
    case "PENDING_FINALITY":
      return false;
    // A settle landed, and a backlog past MAX_SIGNATURES may remain for the next prefix; also its echo is due.
    case "SETTLED":
      return false;
    // The span is below its zero-settle count; only the wallet signing more transactions moves it, and those ring.
    case "NO_PROFIT":
      return true;
    // The walk could not see the span (an endpoint, a gap); the next sweep retries the same span.
    case "INCOMPLETE":
      return false;
    // The owner re-seats the signer in Privy, OFF CHAIN: no transaction, so no bell would ever say so.
    case "NO_SIGNER":
      return false;
    // Unknown mode or an unmeasurable VOLUME span: only a keeper upgrade (a restart, a full pass) or new activity changes it.
    case "UNSUPPORTED_MODE":
      return true;
    // The owner's unpause touches the vault and rings; the protocol's unpause forces a full pass (select()).
    case "PAUSED":
      return true;
    // Funding the wallet is a transfer to it, which rings; a fee that merely drifts is left to the safety lane.
    case "BELOW_RESERVE":
      return true;
    // Did not land and may land next sweep: the retry IS the next sweep.
    case "RETRY":
      return false;
    // Money that should have moved and did not; it is retried every sweep, as it always was.
    case "FAILED":
      return false;
    // Nothing is known about a turn that threw.
    case "THREW":
      return false;
    default: {
      // Unreachable while the switch is whole. At RUNTIME a value this build
      // does not know (a newer module, a bad cast) is BUSY: the safe direction.
      const unclassified: never = outcome;
      void unclassified;
      return false;
    }
  }
}

/** The same question for the invest half, under the same rule. */
export function investRests(outcome: TurnInvest): boolean {
  switch (outcome) {
    // Below the policy minimum, investing switched off, or the 30-day cap full: a deposit or a
    // policy edit touches the vault and rings; a cap that reopens at a day boundary waits at most
    // one safety pass. (A crank too short to wrap is IDLE too, and is caught by turnRests.)
    case "IDLE":
      return true;
    // No basket chosen: choosing one is a transaction on the vault's policy.
    case "NO_POLICY":
      return true;
    // Same two switches as the settle's PAUSED.
    case "PAUSED":
      return true;
    // Bought: the budget is clamped by max_per_call and the depth ceiling, so more may remain; also its echoes are due.
    case "INVESTED":
      return false;
    // A depth or route refusal: pools refill with TIME, and nothing rings when they do.
    case "REFUSED":
      return false;
    // The FAILED streak escalates per sweep, and only a turned vault advances it.
    case "FAILED":
      return false;
    case "THREW":
      return false;
    default: {
      // Unreachable while the switch is whole. At RUNTIME a value this build
      // does not know (a newer module, a bad cast) is BUSY: the safe direction.
      const unclassified: never = outcome;
      void unclassified;
      return false;
    }
  }
}

/**
 * Whether a whole turn may rest: both halves, and one fact the invest outcome
 * does not carry. A vault whose free SOL the crank could not front comes back
 * IDLE, and what ends that is the CRANK being refilled — a transfer to the
 * crank, which is not a watched address. So it stays busy, and the wrap-short
 * streak (three sweeps in a row) keeps counting sweeps, not safety passes.
 */
export function turnRests(turn: { readonly settle: TurnSettle; readonly invest: TurnInvest | null; readonly wrapShort?: boolean }): boolean {
  if (!settleRests(turn.settle)) return false;
  // The invest half never ran: whatever it would have said is unknown.
  if (turn.invest === null) return false;
  if (!investRests(turn.invest)) return false;
  return turn.wrapShort !== true;
}

// ── the doorbell itself ───────────────────────────────────────────────────────

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * The transactions a delivery carries: a RAW payload is an array of
 * getTransaction results.
 *
 * ONLY WHAT LOOKS LIKE ONE: a signature and a numeric slot. Any object used to
 * count, so an authenticated `[{}]` made the doorbell trusted and cleared a
 * deafness while naming no transaction at all. Every real delivery of
 * 2026-09-23 carries both (test/fixtures/helius-raw-2026-09-23.json).
 */
function transactionsOf(payload: unknown): readonly { readonly signature: string; readonly blockTime: unknown }[] {
  const items = Array.isArray(payload) ? payload : [payload];
  const out: { signature: string; blockTime: unknown }[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const tx = item as Record<string, unknown>;
    const signature = signatureOf(tx);
    const slot = tx["slot"];
    if (signature === null || typeof slot !== "number" || !Number.isFinite(slot)) continue;
    out.push({ signature, blockTime: tx["blockTime"] });
  }
  return out;
}

/** transaction.signatures[0], or an enhanced payload's top-level `signature`. */
function signatureOf(tx: Record<string, unknown>): string | null {
  const inner = tx["transaction"];
  if (typeof inner === "object" && inner !== null) {
    const signatures = (inner as Record<string, unknown>)["signatures"];
    if (Array.isArray(signatures) && typeof signatures[0] === "string") return signatures[0];
  }
  const flat = tx["signature"];
  return typeof flat === "string" ? flat : null;
}

/** A rung address: when it last rang, and whether a turn has answered that ring. */
interface Bell {
  at: number;
  answered: boolean;
}

export class Doorbell {
  readonly enabled: boolean;
  /** address → its bell. Only addresses of discovered links are ever put here, and undiscovered ones are dropped. */
  readonly #rung = new Map<string, Bell>();
  /** signature → when the keeper sent it. */
  readonly #echoes = new Map<string, number>();
  /** signature → when it was delivered, for the echoes not expected yet. Insertion order is arrival order. */
  readonly #seen = new Map<string, number>();
  /** link → whether its last turn may rest. Absent = never turned = busy. */
  readonly #rests = new Map<string, boolean>();
  /** When the last select ran: the safety slice is sized from the real interval, not the configured one. */
  #lastSelectAt: number | null = null;
  /**
   * Whether the webhook is known to send this secret: an authenticated delivery
   * arrived, or a sync confirmed or wrote the header. Until then a 403 may be
   * Helius with an old header, and is a delivery lost.
   */
  #authConfirmed = false;
  #eventsReceived = 0;
  #eventsRejected = 0;
  #eventsLost = 0;
  #lastEventAt: number | null = null;
  #lastEventLagMs: number | null = null;
  #echoesMissed = 0;
  #deafSince: number | null = null;
  #deafReason: string | null = null;
  #everTrusted = false;
  /** Why the next sweep must be a full pass, or null. The first sweep after boot always is. */
  #fullPassPending: string | null = "the first sweep after boot";
  #lastPaused: boolean | null = null;
  #lastLive: boolean | null = null;
  #previousLinks: ReadonlySet<string> | null = null;
  #safetyCursor: string | null = null;
  #lanes: (LaneCounts & { readonly total: number }) | null = null;
  #possibleMisses = 0;
  #lastPossibleMiss: DoorbellCoreStatus["lastPossibleMiss"] = null;
  /**
   * The addresses the webhook is CONFIRMED to watch, or null when nobody manages
   * it and so nothing is known (a webhook made by hand is taken at its word).
   */
  #watched: ReadonlySet<string> | null = null;

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  /**
   * One authenticated delivery, already parsed.
   *
   * SHAPE-INDEPENDENT, BECAUSE THE SHAPE LIES ABOUT WHO WAS TOUCHED. A 1 USDC
   * deposit to the owner's vault (29z8KboF…) does not carry the vault in its
   * account keys at all — only the vault's USDC account — and names it ONLY as
   * the owner in meta.pre/postTokenBalances; getSignaturesForAddress(vault)
   * does not even list it. The owner's Axiom trades are VERSION 1
   * transactions, whose message a v0 parser refuses. So nothing here parses a
   * message: every string value anywhere in the delivery is tested for
   * membership in the known set, and whatever shape Helius sends next still
   * rings the right bell.
   *
   * UNKNOWN STRINGS ARE IGNORED, so what a delivery can make this process hold
   * is bounded by the links it discovered, not by the sender.
   */
  ingest(payload: unknown, known: ReadonlySet<string>, now: number): IngestReport {
    let rung = 0;
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
        if (known.has(value)) {
          if (!this.#rung.has(value) && this.#rung.size >= MAX_RUNG) {
            lost = `more than ${MAX_RUNG} addresses rang at once`;
            continue;
          }
          this.#ring(value, now);
          rung += 1;
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

    const transactions = transactionsOf(payload);
    let echoes = 0;
    let newestBlockTime: number | null = null;
    this.#forgetSeen(now);
    for (const tx of transactions) {
      if (this.#echoes.delete(tx.signature)) echoes += 1;
      // DELIVERED BEFORE IT WAS EXPECTED, which is the usual order: runSettleTick
      // returns only after it has polled its signature to confirmed and read the
      // receipt, and Helius delivers 200-500 ms after confirmation. The real
      // settle 5nGb2hqz…, delivered at T and expected at T + 1.5 s, made a
      // working webhook "deaf" five minutes later (review, 2026-09-23).
      else this.#remember(tx.signature, now);
      const blockTime = tx.blockTime;
      if (typeof blockTime === "number" && Number.isFinite(blockTime) && (newestBlockTime === null || blockTime > newestBlockTime)) {
        newestBlockTime = blockTime;
      }
    }
    if (transactions.length > 0) {
      this.#eventsReceived += transactions.length;
      // AN AUTHENTICATED TRANSACTION IS PROOF the webhook sends this secret.
      this.#authConfirmed = true;
      this.#lastEventAt = now;
      this.#lastEventLagMs = newestBlockTime === null ? null : Math.max(0, now - newestBlockTime * 1000);
      // HEARD AGAIN: the pipe that went deaf delivers, so it is trusted again.
      // The echo that went missing is not waited for any longer — it may never
      // have landed — and the next one is judged on its own.
      if (this.#deafSince !== null && now >= this.#deafSince) {
        this.#deafSince = null;
        this.#deafReason = null;
      }
    }
    if (lost !== null) this.lost(lost);
    return { transactions: transactions.length, rung, echoes, lost };
  }

  /** The body as it arrived. A body that is not JSON is a delivery lost, never a crash. */
  ingestBody(body: string, known: ReadonlySet<string>, now: number): IngestReport {
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      const lost = "a delivery that is not JSON was not read";
      this.lost(lost);
      return { transactions: 0, rung: 0, echoes: 0, lost };
    }
    return this.ingest(payload, known, now);
  }

  /**
   * A delivery refused 403. Always counted; a delivery LOST while the webhook is
   * not yet known to send this secret.
   *
   * THE ROTATION (review, 2026-09-23). A new secret in Railway reaches Helius
   * only when the acting instance's sync writes it; until then Helius sends the
   * old header, every delivery is refused, and 403 is the one 4xx Helius never
   * resends. Those trades rang nothing, and the first good delivery then
   * trusted a doorbell that had lost them. Once an authenticated delivery or a
   * sync has confirmed the header, a 403 is a stranger guessing, and a flood of
   * guesses must not become a flood of full passes.
   */
  rejected(): void {
    this.#eventsRejected += 1;
    if (this.enabled && !this.#authConfirmed) {
      this.requestFullPass("a delivery was refused 403 before the webhook was known to send this secret; Helius does not resend it");
    }
  }

  /** The webhook's Authorization header is known to be this secret (a sync confirmed or wrote it). */
  confirmAuthorization(): void {
    this.#authConfirmed = true;
  }

  /**
   * A delivery that could not be read whole. Helius does not resend what was
   * answered, and what it carried is unknown, so the next sweep turns everyone.
   */
  lost(reason: string): void {
    this.#eventsLost += 1;
    this.requestFullPass(reason);
  }

  /** The next sweep turns every link. For a sweep that failed before it turned what it selected, too. */
  requestFullPass(reason: string): void {
    this.#fullPassPending = reason;
  }

  /**
   * A transaction the keeper just sent, which must come back through the
   * webhook — IF the webhook is known to watch one of the addresses it touched.
   * A new link's first settle runs before the debounced edit has added its
   * wallet, and a deafness declared over a transaction nobody was listening for
   * would page about a webhook that is working. Unmanaged (null), every one is
   * expected: a webhook made by hand is taken at its word, and held to it.
   */
  expectEcho(signature: string, now: number, touched: readonly string[]): void {
    this.#forgetSeen(now);
    // ALREADY BACK: delivered while the turn that sent it was still reading its receipt.
    if (this.#seen.delete(signature)) return;
    if (this.#echoes.size >= MAX_ECHOES_PENDING) return;
    const watched = this.#watched;
    if (watched !== null && !touched.some((address) => watched.has(address))) return;
    this.#echoes.set(signature, now);
  }

  /**
   * The addresses the managed webhook is confirmed to watch; null when
   * unmanaged. An EMPTY set is "managed, nothing confirmed yet": every link is
   * then not watched, so none rests on a bell that cannot ring (review,
   * 2026-09-23 — unmanaged and unconfirmed used to be the same null).
   *
   * `added` are the addresses the edit that just landed put on the webhook.
   * They RING, now: a link turned in the "new" lane until the edit landed could
   * have traded after its last turn and before the landing — a transaction
   * Helius never delivered — and would then rest. Ringing keeps it turning
   * until a turn that began after the landing answers.
   */
  setWatched(addresses: ReadonlySet<string> | null, added: readonly string[] = [], now = 0): void {
    this.#watched = addresses;
    for (const address of added) {
      if (!this.#rung.has(address) && this.#rung.size >= MAX_RUNG) {
        this.requestFullPass(`more than ${MAX_RUNG} addresses rang at once`);
        return;
      }
      this.#ring(address, now);
    }
  }

  #ring(address: string, now: number): void {
    this.#rung.set(address, { at: now, answered: false });
  }

  #remember(signature: string, now: number): void {
    this.#seen.delete(signature);
    this.#seen.set(signature, now);
    while (this.#seen.size > MAX_SEEN_SIGNATURES) {
      const oldest = this.#seen.keys().next().value as string;
      this.#seen.delete(oldest);
    }
  }

  #forgetSeen(now: number): void {
    for (const [signature, at] of this.#seen) {
      if (now - at <= ECHO_DEADLINE_MS) break;
      this.#seen.delete(signature);
    }
  }

  /**
   * Whether a sweep may trust the bell: heard at least once since boot, and no
   * echo overdue. Declares the doorbell deaf as a side effect when one is.
   */
  trust(now: number): Trust {
    if (!this.enabled) return { trusted: false, reason: "the doorbell is off (no usable SIP_SOLANA_DOORBELL_SECRET)" };
    for (const [signature, sentAt] of this.#echoes) {
      if (now - sentAt <= ECHO_DEADLINE_MS) continue;
      this.#echoes.delete(signature);
      this.#echoesMissed += 1;
      this.#deafSince = now;
      this.#deafReason =
        `transaction ${signature.slice(0, 12)}… that this keeper sent did not come back through the webhook within ` +
        `${ECHO_DEADLINE_MS / 1000} s; every sweep is a full pass until an event arrives`;
    }
    if (this.#eventsReceived === 0) {
      return { trusted: false, reason: "no event has arrived since this process started; every sweep is a full pass until one does" };
    }
    if (this.#deafSince !== null) return { trusted: false, reason: this.#deafReason };
    this.#everTrusted = true;
    return { trusted: true, reason: null };
  }

  /** Whether the doorbell has ever been trusted since boot — "deaf" means trusted once and lost. */
  get everTrusted(): boolean {
    return this.#everTrusted;
  }

  /**
   * Which links this sweep turns, and why.
   *
   * THE ORDER IS BY LINK ADDRESS, so the safety cursor is stable across sweeps
   * whatever order discovery returns, and a link inserted or removed moves the
   * rotation by at most one position.
   */
  select<T extends DoorLink>(input: {
    readonly links: readonly T[];
    readonly now: number;
    readonly sweepMs: number;
    readonly protocolPaused: boolean;
    /** Whether this instance is the acting keeper at the start of this sweep. */
    readonly live: boolean;
  }): Selection<T> {
    const { now } = input;
    const links = [...input.links].sort((a, b) => (a.link < b.link ? -1 : a.link > b.link ? 1 : 0));
    const trust = this.trust(now);

    let fullReason: string | null = null;
    if (!this.enabled) fullReason = trust.reason;
    else if (this.#fullPassPending !== null) fullReason = this.#fullPassPending;
    // THE PROTOCOL'S UNPAUSE rings no wallet's bell: it is one transaction on
    // the config, and every link rested PAUSED behind it.
    else if (this.#lastPaused === true && !input.protocolPaused) fullReason = "the protocol was unpaused";
    // A TAKEOVER. Until the handover, deliveries went to whichever instance the
    // domain routed to — possibly the outgoing one — so what this one heard
    // before it held the claim is not everything that happened.
    else if (input.live && this.#lastLive === false) fullReason = "this instance just became the acting keeper";
    else if (!trust.trusted) fullReason = trust.reason;
    this.#lastPaused = input.protocolPaused;
    this.#lastLive = input.live;

    // A BELL GOES ONLY ONCE IT IS ANSWERED AND THE HOLD HAS PASSED — never by
    // the clock alone (HOLD_MS says why) — and with the address, when that is
    // no longer discovered. Links that are gone rest nowhere.
    const addresses = new Set(links.flatMap((link) => [link.wallet, link.vault]));
    for (const [address, bell] of this.#rung) {
      if (!addresses.has(address) || (bell.answered && now - bell.at > HOLD_MS)) this.#rung.delete(address);
    }
    const discovered = new Set(links.map((link) => link.link));
    for (const link of this.#rests.keys()) if (!discovered.has(link)) this.#rests.delete(link);

    const previous = this.#previousLinks;
    this.#previousLinks = discovered;

    if (fullReason !== null) {
      this.#fullPassPending = null;
      this.#lastSelectAt = now;
      const lanes = { full: links.length, bell: 0, busy: 0, new: 0, safety: 0 };
      this.#lanes = { ...lanes, total: links.length };
      return { fullReason, turns: links.map((link) => ({ link, lane: "full" as const })), lanes };
    }

    // THE REAL INTERVAL, NOT THE CONFIGURED ONE (review, 2026-09-23). A sweep
    // that overruns has its ticks skipped, so selects can be 240 s apart with
    // sweepMs at 60 s; a slice sized from sweepMs then takes 120 min to come
    // round. Sized from the time since the last select, the rotation keeps to
    // SAFETY_PASS_MS of wall time whatever the sweeps cost.
    const previousSelectAt = this.#lastSelectAt;
    this.#lastSelectAt = now;
    const intervalMs = Math.max(input.sweepMs, previousSelectAt === null ? 0 : now - previousSelectAt);
    const safety = this.#safetySlice(links, intervalMs);
    const watched = this.#watched;
    const lanes = { full: 0, bell: 0, busy: 0, new: 0, safety: 0 };
    const turns: Turn<T>[] = [];
    for (const link of links) {
      const lane: Lane | null = this.#rang(link, now)
        ? "bell"
        : previous === null || !previous.has(link.link)
          ? "new"
          : this.#rests.get(link.link) !== true
            ? "busy"
            : // NOT WATCHED YET IS STILL NEW: a link whose addresses the managed
              // webhook does not hold cannot ring, so it may not rest on a bell
              // until it can.
              watched !== null && (!watched.has(link.wallet) || !watched.has(link.vault))
              ? "new"
              : safety.has(link.link)
                ? "safety"
                : null;
      if (lane === null) continue;
      lanes[lane] += 1;
      turns.push({ link, lane });
    }
    this.#lanes = { ...lanes, total: turns.length };
    return { fullReason: null, turns, lanes };
  }

  /**
   * The rotating slice: k = min(N, max(SAFETY_MIN_PER_SWEEP, ceil(N × sweepMs /
   * SAFETY_PASS_MS))) links, starting after the last one the previous slice
   * took. At N = 10 000 and 60 s that is 334 a sweep, every link within 30 min.
   */
  #safetySlice(links: readonly DoorLink[], sweepMs: number): Set<string> {
    const n = links.length;
    const slice = new Set<string>();
    if (n === 0) return slice;
    const perSweep = Math.ceil((n * Math.max(1, sweepMs)) / SAFETY_PASS_MS);
    const k = Math.min(n, Math.max(SAFETY_MIN_PER_SWEEP, perSweep));
    const cursor = this.#safetyCursor;
    let start = cursor === null ? 0 : links.findIndex((link) => link.link > cursor);
    if (start < 0) start = 0;
    let last = cursor;
    for (let i = 0; i < k; i += 1) {
      const link = links[(start + i) % n]!;
      slice.add(link.link);
      last = link.link;
    }
    this.#safetyCursor = last;
    return slice;
  }

  /** Whether the link's wallet or vault holds a bell: unanswered, or answered inside the hold. */
  #rang(link: DoorLink, now: number): boolean {
    return this.#holds(this.#rung.get(link.wallet), now) || this.#holds(this.#rung.get(link.vault), now);
  }

  #holds(bell: Bell | undefined, now: number): boolean {
    return bell !== undefined && (!bell.answered || now - bell.at <= HOLD_MS);
  }

  /**
   * What a finished turn left behind: whether it may rest, and — the evidence
   * this whole design is audited by — whether the webhook seems to have missed
   * something. A link turned ONLY by the safety lane, while the bell was
   * trusted, that came out busy with no bell for it inside the hold: something
   * happened to it that nothing rang for.
   *
   * `startedAt` is when the turn BEGAN. A resting turn answers the link's bells
   * only when it began BELL_ANSWER_MARGIN_MS after they rang: one that began
   * before, or too soon after, cannot have seen what rang them.
   */
  recordTurn(link: DoorLink, lane: Lane, rests: boolean, now: number, outcome: string, startedAt: number): boolean {
    this.#rests.set(link.link, rests);
    if (rests) {
      for (const address of [link.wallet, link.vault]) {
        const bell = this.#rung.get(address);
        if (bell !== undefined && startedAt >= bell.at + BELL_ANSWER_MARGIN_MS) bell.answered = true;
      }
    }
    if (lane !== "safety" || rests || this.#rang(link, now)) return false;
    this.#possibleMisses += 1;
    this.#lastPossibleMiss = { wallet: link.wallet, at: iso(now), outcome };
    return true;
  }

  status(now: number): DoorbellCoreStatus {
    const trust = this.trust(now);
    let rung = 0;
    for (const bell of this.#rung.values()) if (this.#holds(bell, now)) rung += 1;
    return {
      enabled: this.enabled,
      trusted: trust.trusted,
      untrustedReason: trust.reason,
      eventsReceived: this.#eventsReceived,
      eventsRejected: this.#eventsRejected,
      eventsLost: this.#eventsLost,
      lastEventAt: this.#lastEventAt === null ? null : iso(this.#lastEventAt),
      lastEventLagMs: this.#lastEventLagMs,
      rungAddresses: rung,
      lanes: this.#lanes,
      possibleMisses: this.#possibleMisses,
      lastPossibleMiss: this.#lastPossibleMiss,
      echoesPending: this.#echoes.size,
      echoesMissed: this.#echoesMissed,
    };
  }
}

/** The alert key for a doorbell that was trusted and went deaf. One key, so regaining clears it. */
export const DOORBELL_DEAF_ALERT_KEY = "doorbell-deaf";

/**
 * Whether to raise or clear doorbell-deaf. Raised only for a doorbell that WAS
 * trusted and is not now: a keeper that has not heard its first event yet is
 * doing exactly what it did before the doorbell existed, and paging for that
 * would page on every boot.
 */
export function doorbellDeafAlert(
  trust: Trust,
  everTrusted: boolean,
): { readonly fire: { key: string; severity: "warn"; title: string; detail: string } | null; readonly clear: boolean } {
  if (trust.trusted) return { fire: null, clear: true };
  if (!everTrusted) return { fire: null, clear: false };
  return {
    fire: {
      key: DOORBELL_DEAF_ALERT_KEY,
      severity: "warn",
      title: "The doorbell went deaf; the keeper is polling every link again",
      detail: `${trust.reason ?? "the webhook stopped being trusted"}. Nothing is missed while this lasts — every sweep turns every link — but the webhook on Helius should be checked.`,
    },
    clear: false,
  };
}
