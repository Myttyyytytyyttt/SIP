// The `jupiter-key` cut: which Jupiter host a buying turn talks to, with what
// key, and how fast (ADR §3.9 "Jupiter bucket", §6.2 L1b-m1; PLAN §3.2 P2).
//
// THREE PIECES, ONE TOKEN, because each is unsafe without the others.
//
//   * J1, THE HOST. lite-api.jup.ag is being retired with no date given, and it
//     was down twice for minutes on 2026-10-11 while api.jup.ag answered
//     (MEASURED, disp-measure/jupiter-pg/avail.log). With
//     SIP_SOLANA_JUPITER_API_KEY set, every quote and /swap-instructions goes to
//     api.jup.ag/swap/v1 with the key in an `x-api-key` header — the host and the
//     header verified in Jupiter's own API reference on 2026-10-12. Without a
//     key the cut keeps today's host, so the token can be switched on before the
//     owner has made a key and its pacer still protects the turn.
//
//   * P8, THE PACER. A buying turn spends 6(L+1) Jupiter calls — a measurement
//     before the wrap and another at send time, three calls each, per leg and for
//     the convert (MEASURED for L = 2: 18, jupiter-turn-run3 and run4). Unpaced,
//     the owner's own turn against the keyless api.jup.ag met a 429 on call 6,
//     0.85 s in, and the gate threw: the whole basket REFUSED
//     (jupiter-turn-run2-apijup-unpaced.jsonl, kept as test/fixtures). A turn
//     that fails on call 13 has also spent twelve calls of a budget Jupiter
//     counts PER ORGANISATION, not per key (DOC). So a buying turn RESERVES every
//     call it can make BEFORE ITS FIRST ONE, and a turn the budget cannot cover is
//     DEFERRED — nothing quoted, nothing wrapped, nothing sent, asked again next
//     sweep — instead of starting and failing mid-basket. Each call it then makes
//     is spaced by the plan's rate, because the keyless gateway measured as five
//     per ten seconds, not thirty per minute (api-keyless-probe.log), and a
//     reservation that fits the minute can still burst through the window.
//
//   * THE BACKOFF. A 429 the pacer did not prevent — another consumer of the same
//     organisation's budget, or a window shorter than modelled — blocks new
//     buying turns for a minute, doubling on each further 429 up to ten minutes,
//     and never less than Jupiter's own `x-ratelimit-reset`. Without it the
//     REFUSED basket is turned again every sweep (it is a busy outcome,
//     doorbell.ts investRests) and spends its whole gate against a limiter that
//     is still refusing (m6-numbers.json: refused_requotes_every_sweep). The
//     step goes back to a minute only when a whole turn that STARTED after the
//     latest 429 ends with none: a turn that merely saw no 429 of its own —
//     stopped by the block, or answered before the other turn's — is no
//     evidence Jupiter answers again, and with two buying turns on one pacer it
//     would undo every doubling; and a single answer is no evidence either — the
//     measured 429 came on call 6, after five answers, so a turn answered a few
//     times and then refused is a limiter still refusing.
//
// THE MONEY PATH CHANGES ONLY BY WHEN, NEVER BY WHAT. A key changes which host
// prices the route, not what the route is checked against: every verification,
// every depth arm and every floor in venue-depth.ts and jupiter-route.ts runs on
// the keyed answer exactly as on the keyless one. The pacer only ever DELAYS a
// turn, and a deferred turn has moved nothing. That is why the rollback is
// removing the token and why the token is money path all the same (ADR §6.1):
// it decides whether a buy starts.
//
// NOTHING HERE READS THE NETWORK OR THE CLOCK ON ITS OWN. The clock and the
// sleep are injected, so the tests drive minutes of pacing in microseconds, and
// the fetch is the caller's (jupiterApiForTurn), looked up at call time.

import type { Secret } from "@sip/solana-log";
import type { JupiterApi } from "./program-scripts.js";
import { JUPITER_CALLS_PER_QUOTE, JUPITER_CALLS_PER_ROUTE_BUILD, JUPITER_KEYLESS_CALLS_PER_MINUTE } from "./sweep-cost.js";

/** One leg's measurement: a route build (a /quote and a /swap-instructions) and ARM 2's probe quote. */
export const JUPITER_CALLS_PER_LEG_MEASUREMENT = JUPITER_CALLS_PER_ROUTE_BUILD + JUPITER_CALLS_PER_QUOTE;

/** The free key's published limit: 1 request a second, 60 a minute (developers.jup.ag/docs/api-rate-limit, read 2026-10-12). */
export const JUPITER_FREE_KEY_CALLS_PER_MINUTE = 60;

/** The largest plan Jupiter publishes, Pro: 150 a second, 9,000 a minute. A larger number is a typo, not a plan. */
export const JUPITER_MAX_CALLS_PER_MINUTE = 9_000;

/** Jupiter's window: "a 60-second sliding window" (DOC). The budget is counted over it. */
export const JUPITER_WINDOW_MS = 60_000;

/** The first backoff after a 429, and its ceiling: a minute, doubling to ten. */
export const JUPITER_BACKOFF_BASE_MS = 60_000;
export const JUPITER_BACKOFF_MAX_MS = 600_000;

/** How far ahead an `x-ratelimit-reset` may point and still be believed: past ten minutes it is a clock, not a limiter. */
const RESET_HORIZON_MS = 600_000;

/**
 * Every Jupiter call one buying turn can make: 6(L+1) with the convert, 6L
 * without (m6-numbers.json, `calls_per_buying_turn`; MEASURED 18 at L = 2).
 *
 * WHY THE CEILING AND NOT AN ESTIMATE. The turn measures every leg and the
 * convert before the wrap, then measures each again at the amount it really
 * sends (invest-tick.ts, measureBasketVenues and remeasureForSend). A leg whose
 * share rounds to nothing is measured neither time, so this can over-reserve by
 * a few calls; it cannot under-reserve, and an under-reservation is exactly the
 * mid-basket 429 this exists to prevent. What a turn does not spend is handed
 * back when it ends (JupiterReservation.release).
 */
export function buyingTurnJupiterCalls(legs: number, converts: boolean): number {
  return 2 * JUPITER_CALLS_PER_LEG_MEASUREMENT * (legs + (converts ? 1 : 0));
}

/** The spacing that keeps a turn's calls at the plan's rate: a minute over its calls, rounded up. */
export function minGapMsFor(perMinute: number): number {
  return Math.ceil(JUPITER_WINDOW_MS / perMinute);
}

/**
 * SIP_SOLANA_JUPITER_API_KEY and SIP_SOLANA_JUPITER_CALLS_PER_MINUTE, read the
 * way src/config.ts reads every new variable (ADR §6.1 rule 3): strictly, and
 * never reproducing a value.
 *
 * READ ONLY UNDER THE TOKEN. Both are the `jupiter-key` cut's settings, so with
 * the token absent they are reported as unused — a WARNING, not a refusal.
 * Refusing would break the rollback: the owner sets the key, then the token, and
 * "remove the token" must still boot.
 *
 * WITH THE TOKEN, A MALFORMED VALUE REFUSES TO START. A key with a space or a
 * newline in it is a paste that went wrong, and Jupiter would answer every call
 * 401 — a basket refused every sweep for a reason the detail would name only as
 * an HTTP status. The per-minute budget is a whole number from 1 to Pro's 9,000;
 * unset, it is the free key's 60 with a key and the keyless 30 without.
 */
export function readJupiterKeySettings(
  env: NodeJS.ProcessEnv,
  tokenOn: boolean,
): {
  readonly apiKey: string | null;
  readonly callsPerMinute: number;
  readonly callsPerMinuteSource: "default" | "env";
  readonly problems: readonly string[];
  readonly warnings: readonly string[];
} {
  const problems: string[] = [];
  const warnings: string[] = [];
  const keyRaw = env["SIP_SOLANA_JUPITER_API_KEY"]?.trim();
  const rateRaw = env["SIP_SOLANA_JUPITER_CALLS_PER_MINUTE"]?.trim();
  const keySet = keyRaw !== undefined && keyRaw !== "";
  const rateSet = rateRaw !== undefined && rateRaw !== "";
  if (!tokenOn) {
    const unused = [keySet ? "SIP_SOLANA_JUPITER_API_KEY" : null, rateSet ? "SIP_SOLANA_JUPITER_CALLS_PER_MINUTE" : null].filter(
      (name): name is string => name !== null,
    );
    if (unused.length > 0) {
      warnings.push(
        `${unused.join(" and ")}: set, and not used — SIP_SOLANA_CUTS does not name jupiter-key, so every Jupiter call still ` +
          "goes keyless to lite-api.jup.ag, unpaced, exactly as before the cut existed.",
      );
    }
    return { apiKey: null, callsPerMinute: JUPITER_KEYLESS_CALLS_PER_MINUTE, callsPerMinuteSource: "default", problems, warnings };
  }
  let apiKey: string | null = null;
  if (keySet) {
    // PRINTABLE ASCII, NO SPACE, A PLAUSIBLE LENGTH: what every key shape ever
    // issued for an HTTP header looks like. The refusal says the length and the
    // class, never a character of it.
    if (/^[\x21-\x7e]{8,256}$/.test(keyRaw)) apiKey = keyRaw;
    else problems.push(`SIP_SOLANA_JUPITER_API_KEY must be 8 to 256 printable characters with no spaces; it holds a ${keyRaw.length}-character value that is not.`);
  }
  let callsPerMinute = apiKey === null && !keySet ? JUPITER_KEYLESS_CALLS_PER_MINUTE : JUPITER_FREE_KEY_CALLS_PER_MINUTE;
  let callsPerMinuteSource: "default" | "env" = "default";
  if (rateSet) {
    const parsed = /^[0-9]+$/.test(rateRaw) ? Number(rateRaw) : Number.NaN;
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > JUPITER_MAX_CALLS_PER_MINUTE) {
      problems.push(
        `SIP_SOLANA_JUPITER_CALLS_PER_MINUTE must be a whole number of calls from 1 to ${JUPITER_MAX_CALLS_PER_MINUTE}; ` +
          `it holds a ${rateRaw.length}-character value.`,
      );
    } else {
      callsPerMinute = parsed;
      callsPerMinuteSource = "env";
    }
  }
  return { apiKey, callsPerMinute, callsPerMinuteSource, problems, warnings };
}

/**
 * Why a reservation was not granted. `never-fits` and `share-too-small` are
 * REFUSALS of the basket's size — at the plan's whole minute, and at this
 * worker's share of it — and the caller turns both into a REFUSED basket;
 * `budget` and `backoff` are deferrals that free on their own.
 */
export type JupiterDeferralReason = "budget" | "backoff" | "never-fits" | "share-too-small";

export type JupiterReserveAnswer =
  | { readonly granted: true; readonly reservation: JupiterReservation }
  | {
      readonly granted: false;
      readonly reason: JupiterDeferralReason;
      /** How long until a reservation of the same size could be granted, as far as this process knows; null for never-fits and share-too-small. */
      readonly retryInMs: number | null;
      /** A sentence for the turn's detail: what was asked, what was free, and that nothing moved. */
      readonly detail: string;
    };

/** The pacer as /status reads it, under `cuts.jupiter` (bin/keeper.mts). */
export interface JupiterPacerStatus {
  readonly perMinute: number;
  readonly minGapMs: number;
  /** Calls made in the last 60 s, and reserved but not yet made. */
  readonly spentLastMinute: number;
  readonly reservedOutstanding: number;
  /**
   * Buying turns that asked, were granted, and were not — by why. `neverFits`
   * counts every turn refused for its SIZE: over the plan's minute, and (on a
   * dispatcher worker, whose pacer is retuned) over this worker's share of it,
   * which lastDeferral.reason tells apart. One counter for both keeps the legacy
   * keeper's /status exactly as it was: its pacer is never retuned, so it can
   * never meet the second.
   */
  readonly reservations: number;
  readonly granted: number;
  readonly deferred: { readonly budget: number; readonly backoff: number; readonly neverFits: number };
  /** Calls made through a reservation, and those made past it (should stay 0: the ceiling is an over-estimate). */
  readonly calls: number;
  readonly overdrawn: number;
  /** 429s seen on any paced call since boot: the go gate wants 0 over three real buys (ADR §6.2 L1b-m1). */
  readonly http429: number;
  /** While a 429 holds new turns back: until when, and the step the next one would set. */
  readonly blockedUntil: string | null;
  readonly backoffMs: number;
  readonly lastDeferral: { readonly at: string; readonly reason: JupiterDeferralReason; readonly detail: string } | null;
}

/**
 * Thrown by a paced call made while a 429 holds the organisation's budget: the
 * request is NOT sent. A plain Error to every catch above it, deliberately — the
 * turn's own handling of a refused Jupiter call (a REFUSED basket at the gate, a
 * rested convert or a FAILED leg after the wrap) is the handling it already has
 * for the 429 this stands in for, and nothing new is decided here.
 */
export class JupiterBackoffError extends Error {
  constructor(untilMs: number, now: number) {
    super(
      `Jupiter answered 429 Too Many Requests earlier and is backed off for another ${Math.max(0, Math.ceil((untilMs - now) / 1_000))} s; ` +
        "this call was not sent",
    );
    this.name = "JupiterBackoffError";
  }
}

/**
 * The per-process Jupiter budget: a sliding minute of calls made, the calls
 * reserved against it, the spacing between calls, and the backoff after a 429.
 *
 * ONE PER PROCESS, AND THE SWEEP IS ITS ONLY USER. Turns run one at a time
 * (bin/keeper.mts's `cycleRunning`), so a reservation is normally the only one
 * outstanding; the bookkeeping still counts outstanding reservations, so two
 * concurrent turns — the dispatcher's workers reuse this, two slots to a
 * process — cannot both be granted the same calls, and the spacing hands each
 * call its own slot before it sleeps (_beforeCall), so neither can their calls
 * leave together.
 *
 * THE DISPATCHER'S WORKERS SHARE ONE ORGANISATION'S MINUTE, so each is handed a
 * share of it (worker.jup_quota, src/rpc-quota.ts) and RETUNES its pacer to that
 * share (retune). The share is what the budget check and the spacing use; the
 * minute the pacer was built with stays the ceiling, which NEVER-FITS compares
 * against. A basket over the SHARE but within the ceiling is SHARE-TOO-SMALL:
 * refused, not deferred. Every live worker is handed the same share
 * (fleetQuotas), so no worker of the fleet could buy it either, and a deferral
 * would say "about 60 s" every sweep, forever, while nothing was bought and
 * nothing alerted — the very silence never-fits exists to prevent. It is a
 * refusal for as long as the share stays that small (fewer workers, a larger
 * plan, or a share back from the floor end it). A legacy keeper never retunes,
 * so its share IS its ceiling, it can never meet share-too-small, and every
 * answer is the one it gave before.
 */
export class JupiterPacer {
  /** The minute the pacer was built with: the plan's whole budget, and the never-fits bound. */
  readonly ceilingPerMinute: number;
  #perMinute: number;
  #minGapMs: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  /** When each call of the last minute left, oldest first. */
  #spent: number[] = [];
  #outstanding = 0;
  /** The next slot a call may claim (_beforeCall): moved a gap on by every call before it sleeps. */
  #nextCallAt = 0;
  /** When the last call really left: the gap is measured from it as well as from the slot. */
  #lastCallAt = Number.NEGATIVE_INFINITY;
  /** The slot that last call had claimed: a later slot than a waking call's means that call was overtaken. */
  #lastSlot = Number.NEGATIVE_INFINITY;
  #blockedUntil = 0;
  #backoffMs = JUPITER_BACKOFF_BASE_MS;
  #reservations = 0;
  #granted = 0;
  #deferred = { budget: 0, backoff: 0, neverFits: 0 };
  #calls = 0;
  #overdrawn = 0;
  #http429 = 0;
  #lastDeferral: { at: number; reason: JupiterDeferralReason; detail: string } | null = null;

  constructor(options: { readonly perMinute: number; readonly now?: () => number; readonly sleep?: (ms: number) => Promise<void> }) {
    if (!Number.isSafeInteger(options.perMinute) || options.perMinute < 1) throw new Error("a Jupiter pacer needs a whole, positive number of calls a minute");
    this.ceilingPerMinute = options.perMinute;
    this.#perMinute = options.perMinute;
    this.#minGapMs = minGapMsFor(options.perMinute);
    this.#now = options.now ?? (() => Date.now());
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** The calls a minute this pacer grants now: its share once retuned, its ceiling until then. */
  get perMinute(): number {
    return this.#perMinute;
  }

  /** The spacing between two calls at the current share. */
  get minGapMs(): number {
    return this.#minGapMs;
  }

  /**
   * A new share of the organisation's minute, from this worker's row
   * (QuotaFollower, src/rpc-quota.ts). Whole calls from 1 to the ceiling; above
   * the ceiling it is the ceiling, and anything that is not a positive number is
   * refused and changes nothing. Calls already made stay in the window and
   * reservations already granted stay granted: a smaller share refuses or
   * defers the NEXT turn, it never takes calls back from a turn halfway through
   * its basket.
   */
  retune(perMinute: number): boolean {
    if (!Number.isFinite(perMinute) || perMinute < 1) return false;
    const share = Math.min(this.ceilingPerMinute, Math.floor(perMinute));
    this.#perMinute = share;
    this.#minGapMs = minGapMsFor(share);
    return true;
  }

  #prune(now: number): void {
    while (this.#spent.length > 0 && this.#spent[0]! <= now - JUPITER_WINDOW_MS) this.#spent.shift();
  }

  /**
   * Reserve `calls` for one buying turn, or say why not — BEFORE the turn makes
   * its first call.
   *
   * GRANTED ONLY WHEN THE WHOLE TURN FITS: the calls made in the last minute,
   * plus every call already reserved, plus these, within the plan's minute. As
   * time passes calls only ever leave the window, so a turn granted now cannot
   * push the window past the budget at any later instant, however long its
   * spaced calls take.
   *
   * NEVER-FITS IS ITS OWN ANSWER. A basket needing more calls than the plan's
   * whole minute can never be granted; deferring it would retry it every sweep,
   * forever, and say nothing. The caller turns it into a REFUSED basket, whose
   * alert names the remedy. SHARE-TOO-SMALL is the same answer one level down
   * (the class header): more calls than this worker's share, which no wait on
   * this worker's own minute frees — only a larger share does.
   */
  reserve(calls: number): JupiterReserveAnswer {
    const now = this.#now();
    this.#reservations += 1;
    this.#prune(now);
    if (calls > this.ceilingPerMinute) {
      return this.#defer(now, "never-fits", null,
        `this basket needs ${calls} Jupiter calls per buying turn (6 per leg, and 6 for the convert) and this keeper's budget is ` +
          `${this.ceilingPerMinute} a minute, so it can never be bought at this budget — raise SIP_SOLANA_JUPITER_CALLS_PER_MINUTE with a ` +
          "paid key, or hold fewer stocks; nothing was quoted, wrapped or sent");
    }
    if (calls > this.perMinute) {
      return this.#defer(now, "share-too-small", null,
        `this basket needs ${calls} Jupiter calls per buying turn (6 per leg, and 6 for the convert) and this worker's share of the ` +
          `organisation's ${this.ceilingPerMinute} a minute is ${this.perMinute} now; every live worker is handed the same share, so ` +
          "no worker of this fleet can buy it while the share is this small, and no wait on this worker's minute frees it — run fewer workers, raise " +
          "SIP_SOLANA_JUPITER_CALLS_PER_MINUTE with a paid key, or hold fewer stocks; nothing was quoted, wrapped or sent");
    }
    if (now < this.#blockedUntil) {
      const wait = this.#blockedUntil - now;
      return this.#defer(now, "backoff", wait,
        `Jupiter answered 429 Too Many Requests and this keeper backs off buying turns until ${new Date(this.#blockedUntil).toISOString()} ` +
          `(${Math.ceil(wait / 1_000)} s); nothing was quoted, wrapped or sent, and the turn is asked again next sweep`);
    }
    const used = this.#spent.length + this.#outstanding;
    if (used + calls > this.perMinute) {
      // WHEN ENOUGH OF THE WINDOW AGES OUT: the k-th oldest call leaving is what
      // frees the k-th slot. Reserved calls are not yet in the window, so when
      // they alone are the shortfall the answer is "after they are spent", which
      // this process cannot date — a minute is the honest bound.
      const short = used + calls - this.perMinute;
      const leaving = this.#spent[short - 1];
      const wait = leaving === undefined ? JUPITER_WINDOW_MS : leaving + JUPITER_WINDOW_MS - now;
      const share = this.perMinute === this.ceilingPerMinute ? "" : ` (this worker's share of the fleet's ${this.ceilingPerMinute})`;
      return this.#defer(now, "budget", wait,
        `the Jupiter budget is short: this buying turn needs ${calls} calls and ${used} of this keeper's ${this.perMinute} a minute${share} ` +
          `are spent or reserved in the last 60 s; nothing was quoted, wrapped or sent, and the turn is asked again next sweep ` +
          `(enough frees in about ${Math.ceil(wait / 1_000)} s)`);
    }
    this.#outstanding += calls;
    this.#granted += 1;
    return { granted: true, reservation: new JupiterReservation(this, calls) };
  }

  #defer(now: number, reason: JupiterDeferralReason, retryInMs: number | null, detail: string): JupiterReserveAnswer {
    if (reason === "budget") this.#deferred.budget += 1;
    else if (reason === "backoff") this.#deferred.backoff += 1;
    else this.#deferred.neverFits += 1; // never-fits and share-too-small: refused for its size (JupiterPacerStatus)
    this.#lastDeferral = { at: now, reason, detail };
    return { granted: false, reason, retryInMs, detail };
  }

  /**
   * @internal — JupiterReservation's: wait for the spacing, then count the call.
   * Throws, sending nothing, while backed off.
   *
   * THE SLOT IS CLAIMED BEFORE THE SLEEP. A worker runs two buying turns in one
   * process (SIP_SOLANA_WORKER_SLOTS=2) on this one pacer. Reading the next-call
   * time, sleeping, and only then moving it on let both turns read the same
   * time, sleep to it side by side and leave TOGETHER — two calls 0 ms apart,
   * the very burst the spacing exists to prevent (test/jupiter-pacer.test.ts,
   * "two buying turns in one process"). Now each call takes the next free slot
   * and moves it a gap on before it awaits anything, so the second turn's call
   * is handed the slot after the first's: one queue, in the order they asked.
   * For one turn it is exactly the old spacing: the first call at once, each
   * next one a gap after the last.
   *
   * A SLOT IS WHEN A CALL MAY LEAVE, NOT A PROMISE THAT NOTHING ELSE DID. A timer
   * that fires late — the other slot's turn building and signing a transaction
   * holds the event loop — wakes a call after a LATER slot's call has already
   * left, and leaving then would put two calls inside one gap. So a woken call
   * leaves only if the last call that really left is a whole gap behind, checked
   * with nothing awaited between that check and counting the call. OVERTAKEN —
   * the call that left had a later slot — it takes the next free slot like any
   * new call: behind the calls already queued, not tied with each of them in
   * turn. MERELY LATE BEHIND ITS OWN PREDECESSOR — the call before it, on an
   * earlier slot, woke a millisecond late — it sleeps out the rest of that gap
   * and keeps its place: a timer routinely fires a millisecond or two late, and
   * sending such a call to the back made two turns run about 1.4 times slower
   * and let one starve the other until its whole basket was spent
   * (test/jupiter-pacer.test.ts, "a wake a millisecond late"). A wake that comes
   * EARLY sleeps out the rest of its own slot.
   *
   * A CLAIMED SLOT THAT MEETS A BACKOFF IS NOT HANDED BACK: the call throws and
   * the slot stays spent. The next call waits one gap more than it needed —
   * nothing, beside the minute a 429 blocks new turns for.
   */
  async _beforeCall(reservation: JupiterReservation): Promise<number> {
    let now = this.#now();
    if (now < this.#blockedUntil) throw new JupiterBackoffError(this.#blockedUntil, now);
    let slot = this.#claimSlot(now);
    for (;;) {
      if (now < slot) {
        await this.#sleep(slot - now);
        now = this.#now();
        if (now < this.#blockedUntil) throw new JupiterBackoffError(this.#blockedUntil, now);
        continue;
      }
      if (now >= this.#lastCallAt + this.#minGapMs) break;
      if (this.#lastSlot <= slot) {
        // LATE BEHIND ITS OWN PREDECESSOR, not overtaken: the rest of the gap, and the same place.
        await this.#sleep(this.#lastCallAt + this.#minGapMs - now);
        now = this.#now();
        if (now < this.#blockedUntil) throw new JupiterBackoffError(this.#blockedUntil, now);
        continue;
      }
      slot = this.#claimSlot(now);
    }
    this.#prune(now);
    this.#spent.push(now);
    this.#lastCallAt = now;
    this.#lastSlot = slot;
    this.#calls += 1;
    if (reservation._take()) this.#outstanding -= 1;
    else this.#overdrawn += 1;
    // THE CALL'S TICKET: the 429s noted before it left. A turn's first one decides whether its end resets the step (_release).
    return this.#http429;
  }

  /** The next free slot from `now`: never before a queued slot, nor within a gap of the last call that left. Moves the queue a gap on. */
  #claimSlot(now: number): number {
    const slot = Math.max(now, this.#nextCallAt, this.#lastCallAt + this.#minGapMs);
    this.#nextCallAt = slot + this.#minGapMs;
    return slot;
  }

  /** @internal — a 429 seen on a paced call: block new turns for the backoff step, never less than Jupiter's own reset. */
  _note429(resetAtMs: number | null): void {
    const now = this.#now();
    this.#http429 += 1;
    const resetBelieved = resetAtMs !== null && resetAtMs > now && resetAtMs - now <= RESET_HORIZON_MS ? resetAtMs : 0;
    this.#blockedUntil = Math.max(this.#blockedUntil, now + this.#backoffMs, resetBelieved);
    this.#backoffMs = Math.min(this.#backoffMs * 2, JUPITER_BACKOFF_MAX_MS);
  }

  /**
   * @internal — a reservation ending: unspent calls go back, and the backoff
   * step goes back to a minute only when the turn made a call, its FIRST call
   * left after the latest 429 (`firstTicket`, from _beforeCall), and no 429 has
   * been noted since — its own included. A turn the block stopped before any
   * call has no ticket; one whose first call left before the other turn's 429
   * has a stale one; one answered three times and then refused has moved the
   * count past its own. None of them resets anything.
   */
  _release(unspent: number, firstTicket: number | null): void {
    this.#outstanding -= unspent;
    if (firstTicket !== null && firstTicket === this.#http429) this.#backoffMs = JUPITER_BACKOFF_BASE_MS;
  }

  status(): JupiterPacerStatus {
    const now = this.#now();
    this.#prune(now);
    return {
      perMinute: this.perMinute,
      minGapMs: this.minGapMs,
      spentLastMinute: this.#spent.length,
      reservedOutstanding: this.#outstanding,
      reservations: this.#reservations,
      granted: this.#granted,
      deferred: { ...this.#deferred },
      calls: this.#calls,
      overdrawn: this.#overdrawn,
      http429: this.#http429,
      blockedUntil: now < this.#blockedUntil ? new Date(this.#blockedUntil).toISOString() : null,
      backoffMs: this.#backoffMs,
      lastDeferral:
        this.#lastDeferral === null
          ? null
          : { at: new Date(this.#lastDeferral.at).toISOString(), reason: this.#lastDeferral.reason, detail: this.#lastDeferral.detail },
    };
  }
}

/**
 * One buying turn's share of the budget: the calls it reserved, spent one at a
 * time at the plan's spacing, and handed back when the turn ends.
 *
 * RELEASED EXACTLY ONCE, by runInvestTick's `finally`, whatever way the turn
 * ended. A reservation never released would hold its calls out of the budget
 * for the life of the process — every later buy deferred, forever, by a turn
 * that ended an hour ago.
 */
export class JupiterReservation {
  readonly #pacer: JupiterPacer;
  readonly reserved: number;
  #remaining: number;
  #released = false;
  /** The ticket of this turn's first call that left (_beforeCall): null until one has. */
  #firstTicket: number | null = null;

  constructor(pacer: JupiterPacer, calls: number) {
    this.#pacer = pacer;
    this.reserved = calls;
    this.#remaining = calls;
  }

  get remaining(): number {
    return this.#remaining;
  }

  /** @internal — the pacer's: one reserved call spent, or false when there were none left. */
  _take(): boolean {
    if (this.#remaining === 0) return false;
    this.#remaining -= 1;
    return true;
  }

  /** Before each Jupiter request this turn makes: waits out the spacing, counts the call, or throws (sending nothing) while backed off. */
  async beforeCall(): Promise<void> {
    if (this.#released) throw new Error("a released Jupiter reservation was asked for a call: the turn it belonged to has ended");
    const ticket = await this.#pacer._beforeCall(this);
    this.#firstTicket ??= ticket;
  }

  /** After each answer: a 429 starts or extends the backoff, at least to Jupiter's own `x-ratelimit-reset`. */
  observe(status: number, headers: { get(name: string): string | null }): void {
    if (status !== 429) return;
    const reset = Number(headers.get("x-ratelimit-reset"));
    this.#pacer._note429(Number.isFinite(reset) && reset > 0 ? reset * 1_000 : null);
  }

  release(): void {
    if (this.#released) return;
    this.#released = true;
    this.#pacer._release(this.#remaining, this.#firstTicket);
    this.#remaining = 0;
  }
}

/**
 * The `jupiter-key` cut as one buying turn uses it: which host, which key, and
 * the process's pacer. Built once at boot (bin/keeper.mts) and handed to
 * runInvestTick only while the token is on; absent, the turn is today's.
 */
export interface JupiterAccess {
  /** KEYED_API with a key, LITE_API without one — today's host (program-scripts.ts). */
  readonly baseUrl: string;
  readonly apiKey: Secret | null;
  readonly pacer: JupiterPacer;
}

/**
 * The JupiterApi one reserved turn quotes through: every request paced by its
 * reservation, carrying the key in a header when there is one, and its 429s
 * reported back to the pacer.
 *
 * THE GLOBAL fetch IS LOOKED UP AT CALL TIME, not captured: it is the one the
 * keyless path has always used, and the one the suites stub.
 *
 * THE KEY IS SET ON A COPY OF THE CALLER'S HEADERS, never on a shared object,
 * and never anywhere an error message reads: getJson quotes the URL it asked,
 * and the URL carries no key.
 */
export function jupiterApiForTurn(access: JupiterAccess, reservation: JupiterReservation): JupiterApi {
  return {
    baseUrl: access.baseUrl,
    fetch: async (url: string, init: RequestInit): Promise<Response> => {
      await reservation.beforeCall();
      let sent = init;
      if (access.apiKey !== null) {
        const headers = new Headers(init.headers);
        headers.set("x-api-key", access.apiKey.reveal());
        sent = { ...init, headers };
      }
      const response = await globalThis.fetch(url, sent);
      reservation.observe(response.status, response.headers);
      return response;
    },
  };
}
