// THE ALERTS ON L1a's COUNTERS: privy-burn, jupiter-budget, rpc-fallback and
// privy-index (ADR §6.3; [ROLLOUT] §6 rows 3, 5 and 8). Each is its own token in
// SIP_SOLANA_CUTS (src/cuts.ts), and with its token off it is never asked.
//
// L1a SHIPPED THE COUNTERS AND NOT THE ALERTS. src/rpc-usage.ts, src/privy-usage.ts
// and src/sweep-cost.ts put on /status what this keeper asks of Helius, Privy and
// Jupiter; credit-burn was the only alert hung on them, and discovery-stale came
// with L3. A number on a page nobody opens is the absence-shaped failure this
// keeper keeps meeting, so §6.3's other four are here, in creditBurnAlert's
// shape: pure, over /status's own blocks, returning what to raise and whether to
// clear, so a test can pin every threshold without a keeper around it.
//
// WHICH ONES PAGE. The ADR's severities, and nothing louder: privy-burn warns at
// 60 % of Privy's free tier and pages at 85 %; jupiter-budget warns at 80 % of
// the per-minute limit and pages on a 429 while this keeper is live; rpc-fallback
// pages once a fallback endpoint has answered alone for 10 minutes; privy-index
// warns on the first failed listing and pages on the third in a row. One key
// each, so an escalation breaks through the alerter's dedupe on its own
// (src/alerts.ts) and a de-escalation is a repeat.
//
// NONE OF THEM DECIDES ANYTHING. They read counters that are told after the
// fact, and change only who is woken.

import type { Alert } from "./alerts.js";
import type { PrivyUsageStatus } from "./privy-usage.js";
import { endpointLabel } from "./rpc-pool.js";
import type { JupiterUsageStatus } from "./status.js";

/** What every rule here returns: an alert to raise, or whether to clear its key. */
export interface AlertDecision {
  readonly fire: Alert | null;
  readonly clear: boolean;
}

const nothing: AlertDecision = { fire: null, clear: false };
const cleared: AlertDecision = { fire: null, clear: true };
const pct = (part: number, whole: number): number => Math.round((part / whole) * 1_000) / 10;

// --- privy-burn -------------------------------------------------------------

export const PRIVY_BURN_ALERT_KEY = "privy-burn";
/** Warn at 60 % of the free tier, page at 85 % (ADR §6.3, RT-23). */
export const PRIVY_BURN_WARN_FRACTION = 0.6;
export const PRIVY_BURN_CRITICAL_FRACTION = 0.85;
/**
 * How much of the day must have been observed before the projection may alert:
 * an hour, credit-burn's rule for the same reason. The month estimate is the
 * day's signatures scaled to 24 h and multiplied by thirty, and the first
 * minutes after a deploy settle whatever waited through it.
 */
export const PRIVY_BURN_MIN_OBSERVED_MS = 60 * 60 * 1_000;

/**
 * Privy signatures this keeper is on course to spend in a month, against the
 * free tier (privy.signaturesMonthEstimate, src/privy-usage.ts).
 *
 * THIS SERVICE'S SHARE ONLY. Both keepers sign through one Privy app and the
 * 50,000 are the app's; neither keeper sees the other's count. The message says
 * so, as credit-burn's does for Helius: the app-wide figure is the sum of the
 * two /status pages, or Privy's own dashboard.
 */
export function privyBurnAlert(privy: PrivyUsageStatus): AlertDecision {
  const estimate = privy.signaturesMonthEstimate;
  const free = privy.freeSignaturesPerMonth;
  if (estimate === null || privy.observedMs < PRIVY_BURN_MIN_OBSERVED_MS || !(free > 0)) return nothing;
  if (estimate < free * PRIVY_BURN_WARN_FRACTION) return cleared;
  const critical = estimate >= free * PRIVY_BURN_CRITICAL_FRACTION;
  const hours = Math.round((privy.observedMs / 3_600_000) * 10) / 10;
  const byMode = Object.entries(privy.signaturesPerDay)
    .map(([mode, n]) => `${mode} ${n}`)
    .join(", ");
  return {
    fire: {
      key: PRIVY_BURN_ALERT_KEY,
      severity: critical ? "critical" : "warn",
      title: critical ? "This keeper is on course to spend Privy's free signatures this month" : "This keeper's Privy signatures are climbing toward the free tier",
      detail:
        `About ${estimate} signatures a month at the rate of the last ${hours} h, against ${free} free (${pct(estimate, free)} %)` +
        `${byMode === "" ? "" : `; in the last day by mode: ${byMode}`}. This is this service's own count: both keepers sign through ` +
        "one Privy app, so the app's total is the sum of the two /status pages. Past the free tier Privy is a paid plan (ADR §6.4); " +
        "the lever is each mode's collection cadence (ADR decision 16).",
      context: { signaturesMonthEstimate: estimate, freeSignaturesPerMonth: free, observedMs: privy.observedMs },
    },
    clear: false,
  };
}

// --- privy-index ------------------------------------------------------------

export const PRIVY_INDEX_ALERT_KEY = "privy-index";
/** Failed listings in a row before it pages: 3 ([ROLLOUT] §6 row 5). */
export const PRIVY_INDEX_CRITICAL_STREAK = 3;

/**
 * The per-sweep Privy wallet listing failing (privy.consecutiveIndexFailures).
 *
 * IT USED TO BE A LOG LINE. A failed listing is not fatal — each wallet falls
 * back to its own lookup — and that fallback is the expensive part: every
 * lookup lists the whole app for one wallet, N × pages, the cliff
 * src/privy-usage.ts counts as fallbackLookups. One failure warns; three in a
 * row is a listing that is not coming back by itself.
 *
 * Under the privy-address cut no listing is built and the streak never moves,
 * so this stays quiet there: the book's own failures are its per-wallet routes.
 */
export function privyIndexAlert(privy: PrivyUsageStatus): AlertDecision {
  const streak = privy.consecutiveIndexFailures;
  if (streak <= 0) return cleared;
  const critical = streak >= PRIVY_INDEX_CRITICAL_STREAK;
  return {
    fire: {
      key: PRIVY_INDEX_ALERT_KEY,
      severity: critical ? "critical" : "warn",
      title: critical ? "The Privy wallet listing keeps failing" : "The Privy wallet listing failed",
      detail:
        `${streak} sweep${streak === 1 ? "" : "s"} in a row without it (${privy.indexFailures} since this process started). ` +
        `Each wallet falls back to a lookup of its own, which lists the whole app once per wallet ` +
        `(${privy.fallbackLookups} so far): settles still resolve their signer, at N times the Privy requests.`,
      context: { consecutiveIndexFailures: streak, indexFailures: privy.indexFailures, fallbackLookups: privy.fallbackLookups },
    },
    clear: false,
  };
}

// --- rpc-fallback -----------------------------------------------------------

export const RPC_FALLBACK_ALERT_KEY = "rpc-fallback";
/** How long a fallback endpoint may answer alone before it pages: 10 minutes (ADR §6.3). */
export const RPC_FALLBACK_AFTER_MS = 10 * 60 * 1_000;

/**
 * A fallback endpoint has been answering alone for too long.
 *
 * A FAILOVER IS SILENT BY DESIGN — src/rpc-pool.ts sets an endpoint aside for
 * 30 s and moves on — and that silence is right for a blip. Ten minutes on a
 * fallback is not a blip: the Helius key the credit budget is about has been
 * refusing for that long, and a key out of credits answers exactly that way
 * (429 "max usage", [ROLLOUT] §6 row 3). The keeper is then running on a
 * provider with another latency and another limit, and nobody is told.
 *
 * BY LABEL, NEVER BY URL: "endpoint 2/3" (endpointLabel). Endpoint 1 answering
 * clears it; a keeper with one endpoint has nothing to fall back to.
 */
export function rpcFallbackAlert(input: {
  readonly endpointInUse: string | null;
  readonly endpointSinceMs: number | null;
  readonly endpoints: number;
}): AlertDecision {
  const { endpointInUse, endpointSinceMs, endpoints } = input;
  if (endpoints < 2 || endpointInUse === null) return nothing;
  if (endpointInUse === endpointLabel(0, endpoints)) return cleared;
  if (endpointSinceMs === null || endpointSinceMs < RPC_FALLBACK_AFTER_MS) return nothing;
  const minutes = Math.round(endpointSinceMs / 60_000);
  return {
    fire: {
      key: RPC_FALLBACK_ALERT_KEY,
      severity: "critical",
      title: "The keeper has been running on a fallback RPC endpoint",
      detail:
        `${endpointInUse} has answered alone for ${minutes} min; ${endpointLabel(0, endpoints)} keeps being set aside. ` +
        "A Helius key out of credits answers 429 \"max usage\": check the Helius dashboard, then rpc.byEndpointPerDay on " +
        "/status for how each endpoint has been answering.",
      context: { endpointInUse, endpointSinceMs, endpoints },
    },
    clear: false,
  };
}

// --- jupiter-budget ---------------------------------------------------------

export const JUPITER_BUDGET_ALERT_KEY = "jupiter-budget";
/** Warn once the last minute has spent 80 % of the per-minute limit ([ROLLOUT] §6 row 8). */
export const JUPITER_BUDGET_WARN_FRACTION = 0.8;
/**
 * How long after the last 429 the key may clear: 30 minutes, the alerter's own
 * repeat window. A throttled minute is followed by one that is not, and
 * clearing on it would re-arm the page for the next 429 a few sweeps later: a
 * throttling episode would page once per buy instead of once.
 */
export const JUPITER_429_QUIET_MS = 30 * 60 * 1_000;

/** The `ops.jupiterAnswers` block: what Jupiter's host answered, as the transport saw it. */
export interface JupiterAnswersStatus {
  readonly answered: number;
  readonly http429: number;
  readonly httpOther: number;
  readonly unanswered: number;
  readonly lastHttp429At: string | null;
}

/**
 * Jupiter's answers, by kind, since this process started and in the sweep now
 * running. Fed by the global-fetch observer (observeGlobalFetch,
 * src/dependency-watch.ts), because the route builder takes no fetch of its own.
 *
 * EVERY JUPITER REQUEST THIS KEEPER MAKES IS AN INVEST TURN'S: the route builds
 * and the depth probe of measureLegVenue (src/venue-depth.ts), whose only caller
 * is src/invest-tick.ts. So a 429 seen during a sweep is a 429 during a buy — a
 * real one when the keeper is live, a dry run's quote otherwise.
 */
export class JupiterAnswers {
  #answered = 0;
  #http429 = 0;
  #httpOther = 0;
  #unanswered = 0;
  #lastHttp429At: number | null = null;
  #sweep429 = 0;

  record(answer: number | "unanswered", at: number): void {
    if (answer === "unanswered") this.#unanswered += 1;
    else if (answer === 429) {
      this.#http429 += 1;
      this.#sweep429 += 1;
      this.#lastHttp429At = at;
    } else if (answer >= 200 && answer < 300) this.#answered += 1;
    else this.#httpOther += 1;
  }

  startSweep(): void {
    this.#sweep429 = 0;
  }

  http429ThisSweep(): number {
    return this.#sweep429;
  }

  lastHttp429At(): number | null {
    return this.#lastHttp429At;
  }

  status(): JupiterAnswersStatus {
    return {
      answered: this.#answered,
      http429: this.#http429,
      httpOther: this.#httpOther,
      unanswered: this.#unanswered,
      lastHttp429At: this.#lastHttp429At === null ? null : new Date(this.#lastHttp429At).toISOString(),
    };
  }
}

/**
 * Jupiter's per-minute budget: a warning at 80 % of the limit in the last
 * minute, and a page when Jupiter answered a buying turn with 429.
 *
 * THE LIMIT IS THE COUNTER'S OWN (jupiter.budgetPerMinute, src/sweep-cost.ts):
 * the keyless 30 today, and whatever a key's limit becomes once `jupiter-key`
 * lands, without this rule changing.
 *
 * A 429 PAGES ONLY WHILE LIVE. A dry run's quotes spend the same budget and are
 * worth a warning; only a live turn is a buy that did not happen.
 */
export function jupiterBudgetAlert(input: {
  readonly usage: JupiterUsageStatus;
  readonly http429ThisSweep: number;
  readonly lastHttp429At: number | null;
  readonly live: boolean;
  readonly now: number;
}): AlertDecision {
  const { usage, http429ThisSweep, lastHttp429At, live, now } = input;
  const limit = usage.budgetPerMinute;
  if (http429ThisSweep > 0) {
    return {
      fire: {
        key: JUPITER_BUDGET_ALERT_KEY,
        severity: live ? "critical" : "warn",
        title: live ? "Jupiter refused a buy with 429: its per-minute limit was reached" : "Jupiter answered a dry run's quote with 429",
        detail:
          `${http429ThisSweep} request${http429ThisSweep === 1 ? "" : "s"} refused with 429 this sweep; ${usage.callsLastMinute} ` +
          `calls in the last minute against a limit of ${limit}. The turn that met it stopped at that step — refused before ` +
          "the wrap if it was still measuring, otherwise with what it had already wrapped or converted left for a later sweep; " +
          "invest-refused or invest-failed names which. At about a dozen calls a buying turn, the keyless limit is about two " +
          "and a half turns a minute.",
        context: { http429ThisSweep, callsLastMinute: usage.callsLastMinute, budgetPerMinute: limit },
      },
      clear: false,
    };
  }
  if (limit > 0 && usage.callsLastMinute >= limit * JUPITER_BUDGET_WARN_FRACTION) {
    return {
      fire: {
        key: JUPITER_BUDGET_ALERT_KEY,
        severity: "warn",
        title: "Jupiter calls are close to the per-minute limit",
        detail:
          `${usage.callsLastMinute} calls in the last minute against a limit of ${limit} (${pct(usage.callsLastMinute, limit)} %); ` +
          `the busiest minute of the last day was ${usage.peakPerMinuteLastDay}. Past the limit Jupiter answers 429 and the turn that ` +
          "asked is refused.",
        context: { callsLastMinute: usage.callsLastMinute, budgetPerMinute: limit },
      },
      clear: false,
    };
  }
  if (lastHttp429At !== null && now - lastHttp429At < JUPITER_429_QUIET_MS) return nothing;
  return cleared;
}
