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
//     is still refusing (m6-numbers.json: refused_requotes_every_sweep).
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

/** Why a reservation was not granted. */
export type JupiterDeferralReason = "budget" | "backoff" | "never-fits";

export type JupiterReserveAnswer =
  | { readonly granted: true; readonly reservation: JupiterReservation }
  | {
      readonly granted: false;
      readonly reason: JupiterDeferralReason;
      /** How long until a reservation of the same size could be granted, as far as this process knows; null for never-fits. */
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
  /** Buying turns that asked, were granted, and were deferred — by why. */
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
 * concurrent turns — the dispatcher's workers reuse this — cannot both be
 * granted the same calls.
 */
export class JupiterPacer {
  readonly perMinute: number;
  readonly minGapMs: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  /** When each call of the last minute left, oldest first. */
  #spent: number[] = [];
  #outstanding = 0;
  #nextCallAt = 0;
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
    this.perMinute = options.perMinute;
    this.minGapMs = minGapMsFor(options.perMinute);
    this.#now = options.now ?? (() => Date.now());
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
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
   * alert names the remedy.
   */
  reserve(calls: number): JupiterReserveAnswer {
    const now = this.#now();
    this.#reservations += 1;
    this.#prune(now);
    if (calls > this.perMinute) {
      return this.#defer(now, "never-fits", null,
        `this basket needs ${calls} Jupiter calls per buying turn (6 per leg, and 6 for the convert) and this keeper's budget is ` +
          `${this.perMinute} a minute, so it can never be bought at this budget — raise SIP_SOLANA_JUPITER_CALLS_PER_MINUTE with a ` +
          "paid key, or hold fewer stocks; nothing was quoted, wrapped or sent");
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
      return this.#defer(now, "budget", wait,
        `the Jupiter budget is short: this buying turn needs ${calls} calls and ${used} of this keeper's ${this.perMinute} a minute ` +
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
    else this.#deferred.neverFits += 1;
    this.#lastDeferral = { at: now, reason, detail };
    return { granted: false, reason, retryInMs, detail };
  }

  /** @internal — JupiterReservation's: wait for the spacing, then count the call. Throws, sending nothing, while backed off. */
  async _beforeCall(reservation: JupiterReservation): Promise<void> {
    const before = this.#now();
    if (before < this.#blockedUntil) throw new JupiterBackoffError(this.#blockedUntil, before);
    const wait = this.#nextCallAt - before;
    if (wait > 0) await this.#sleep(wait);
    const now = this.#now();
    if (now < this.#blockedUntil) throw new JupiterBackoffError(this.#blockedUntil, now);
    this.#prune(now);
    this.#spent.push(now);
    this.#nextCallAt = now + this.minGapMs;
    this.#calls += 1;
    if (reservation._take()) this.#outstanding -= 1;
    else this.#overdrawn += 1;
  }

  /** @internal — a 429 seen on a paced call: block new turns for the backoff step, never less than Jupiter's own reset. */
  _note429(resetAtMs: number | null): void {
    const now = this.#now();
    this.#http429 += 1;
    const resetBelieved = resetAtMs !== null && resetAtMs > now && resetAtMs - now <= RESET_HORIZON_MS ? resetAtMs : 0;
    this.#blockedUntil = Math.max(this.#blockedUntil, now + this.#backoffMs, resetBelieved);
    this.#backoffMs = Math.min(this.#backoffMs * 2, JUPITER_BACKOFF_MAX_MS);
  }

  /** @internal — a reservation ending: unspent calls go back, and a turn with no 429 resets the backoff step. */
  _release(unspent: number, saw429: boolean): void {
    this.#outstanding -= unspent;
    if (!saw429) this.#backoffMs = JUPITER_BACKOFF_BASE_MS;
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
  #saw429 = false;

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
    await this.#pacer._beforeCall(this);
  }

  /** After each answer: a 429 starts or extends the backoff, at least to Jupiter's own `x-ratelimit-reset`. */
  observe(status: number, headers: { get(name: string): string | null }): void {
    if (status !== 429) return;
    this.#saw429 = true;
    const reset = Number(headers.get("x-ratelimit-reset"));
    this.#pacer._note429(Number.isFinite(reset) && reset > 0 ? reset * 1_000 : null);
  }

  release(): void {
    if (this.#released) return;
    this.#released = true;
    this.#pacer._release(this.#remaining, this.#saw429);
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
