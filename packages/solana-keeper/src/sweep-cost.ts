// WHAT A SWEEP COSTS, so the ceiling on simultaneous users is READ rather than
// guessed.
//
// THE QUESTION THIS FILE EXISTS FOR. One process sweeps every linked wallet
// every SIP_SOLANA_SWEEP_MS, in one sequential loop. How many users fit in a
// sweep is therefore an arithmetic question — sweepMs divided by what a user
// costs — and nobody could answer it, because nothing measured either side of
// that division. The numbers that existed were taken from a laptop in Lisbon
// against the public endpoint; production runs on Railway against a different
// provider, and the only honest place to measure is where the money moves.
//
// IT DECIDES NOTHING ABOUT MONEY. Every function here counts, times or words an
// alert. Nothing in this file is read by a settle, an invest or a refusal, and
// nothing in it may become so: a counter that can change what gets signed is a
// counter that can be wrong about money.
//
// WHY THE ALERTS ARE SHAPED LIKE THE ONES ALREADY HERE. vaultReadAlert
// (sweep-decision.ts) and investFailedAlert (invest-decision.ts) both warn on
// the first occurrence and page critical on the third in a row, under ONE key
// the alerter dedupes. A third shape would be a third thing for an operator to
// learn at 3am, so these copy theirs exactly, including the rule that the
// standing warning is cleared at the escalation or it swallows the critical.

import type { Alert } from "./alerts.js";
import type { SettleOutcome } from "./settle-decision.js";

/**
 * How many sweeps' durations are kept for the percentiles: thirty.
 *
 * BOUNDED BECAUSE THIS PROCESS RUNS FOR WEEKS. At a 60 s sweep this is the last
 * half hour — long enough that one slow pass does not move p90 on its own, short
 * enough that an operator reading it during an incident is reading THIS
 * incident and not an average over last Tuesday. An unbounded array would be a
 * slow leak in the one process that must not be restarted to be fixed.
 */
export const SWEEP_TIMES_KEPT = 30;

/**
 * The q-th percentile of a set of durations, NEAREST RANK: the smallest sample
 * at or above the q fraction of the sorted set. Null for an empty set — no
 * sweep has been timed, which is a different fact from "the sweeps take 0 ms"
 * and must not be drawn as one on a status page.
 *
 * NEAREST RANK, NOT INTERPOLATION: every value reported is a duration that
 * really happened, which is what an operator comparing against sweepMs needs.
 * With 30 samples p90 is the 27th, so a single overrun does not reach it and
 * three in a row do.
 */
export function percentileMs(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(q * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index]!;
}

/** A bounded ring of recent sweep durations, and the percentiles over it. */
export interface SweepTimes {
  add(ms: number): void;
  /** How many sweeps are in the ring: 0 until the first one finishes. */
  readonly length: number;
  p50(): number | null;
  p90(): number | null;
}

export function createSweepTimes(capacity: number = SWEEP_TIMES_KEPT): SweepTimes {
  const kept: number[] = [];
  return {
    add(ms) {
      // A NEGATIVE OR NON-FINITE DURATION IS NOT A MEASUREMENT. Date.now() can
      // step backwards over an NTP correction, and a percentile computed from
      // that is a number nobody can act on. Dropped, not clamped: a sample that
      // did not happen must not be counted as a fast sweep either.
      if (!Number.isFinite(ms) || ms < 0) return;
      kept.push(ms);
      while (kept.length > capacity) kept.shift();
    },
    get length() {
      return kept.length;
    },
    p50: () => percentileMs(kept, 0.5),
    p90: () => percentileMs(kept, 0.9),
  };
}

/**
 * The settle outcomes decided BEFORE the window walk — the cheap half of a turn.
 *
 * WHAT THE SPLIT IS FOR. An idle user costs a handful of round trips: the probe
 * that returns IDLE (one getSignaturesForAddress) plus the invest turn, which
 * runs unconditionally and reads the vault, the policy and the two token
 * accounts. An ACTIVE user costs the window walk, one getTransaction per
 * transaction, sequentially, and that is the lane that fills a sweep. Dividing
 * sweepMs by an average over both tells nobody which lane to widen.
 *
 * THESE THREE AND NO OTHERS, read off runSettleTick's own order: the pause
 * decision, the mode decision and the signer check all return above the probe,
 * and IDLE is the probe's own answer. UNSUPPORTED_MODE is NOT here although it
 * has an early return, because decideFromMeasurement returns it too, AFTER the
 * walk — so counting it cheap would charge a walk to the cheap lane. FAILED is
 * not here for the same reason: a missing vault fails before the probe, and
 * everything else that fails does so after it. Both therefore land in the
 * expensive lane, which over-states that lane and never under-states it: the
 * error an operator can act on safely.
 */
export const CHEAP_SETTLE_OUTCOMES: readonly SettleOutcome[] = ["IDLE", "NO_SIGNER", "PAUSED"];

/** Whether this turn's settle got past the cheap probe and walked the window. */
export function settleWalked(outcome: SettleOutcome): boolean {
  return !CHEAP_SETTLE_OUTCOMES.includes(outcome);
}

/**
 * The alerter's key for sweeps skipped because the previous one had not
 * finished. ONE KEY, like vault-read: it is the sweep's own condition and names
 * no wallet.
 */
export const SWEEP_SKIPPED_ALERT_KEY = "sweep-skipped";

/** Sweeps skipped in a row before it pages critical: 3, the streak every other escalation here uses. */
export const SWEEP_SKIPPED_CRITICAL_STREAK = 3;

/**
 * The alert for a sweep that was skipped because the previous one was still
 * running: a warning at first, critical from the third in a row.
 *
 * IT USED TO BE A LOG LINE AND NOTHING ELSE. bin/keeper.mts logs "cycle skipped:
 * the previous one is still running" and returns — never counted, never
 * escalated, and absent from /status entirely. That silence has already
 * happened once: a wallet turn threw, `cycleRunning` stayed true, and every
 * later sweep logged the skip while nobody was settled. The comment recording
 * it is still in that file.
 *
 * NOT CRITICAL ON THE FIRST, for the same reason the vault read is not. One
 * overrun is a sweep that met a backlogged wallet, and the next pass is usually
 * fine. Three in a row is a keeper that has stopped keeping up — or one wedged
 * with the flag stuck on — and by then nobody has been settled for three
 * sweeps.
 */
export function sweepSkippedAlert(streak: number, detail: string): Alert {
  const critical = streak >= SWEEP_SKIPPED_CRITICAL_STREAK;
  return {
    key: SWEEP_SKIPPED_ALERT_KEY,
    severity: critical ? "critical" : "warn",
    title: critical ? "The keeper's sweeps are being skipped: the previous one never finishes in time" : "A sweep was skipped: the previous one was still running",
    detail: `${streak} sweep${streak === 1 ? "" : "s"} in a row skipped: ${detail}`,
    context: { skipped: streak },
  };
}

/** The alerter's key for a sweep that is taking most of its own interval. */
export const SWEEP_SLOW_ALERT_KEY = "sweep-slow";

/**
 * The share of the configured interval at which a sweep is called slow: 60 %.
 *
 * AN ALERT THAT ARRIVES BEFORE THE SKIP IS THE ONE THAT IS ACTIONABLE. At 100 %
 * the next sweep is already being dropped and users are already unserved; at
 * 60 % there is a whole sweep's worth of room left to raise SIP_SOLANA_SWEEP_MS,
 * widen a lane, or stop onboarding — which is the entire point of measuring the
 * ceiling before the users arrive.
 */
export const SWEEP_SLOW_FRACTION = 0.6;

/**
 * Sweeps that must be in the ring before slowness is claimed: 3.
 *
 * THE FIRST SWEEP IS NOT EVIDENCE. It follows the chain read, the read model's
 * preflight and the first Privy scan, on a cold connection pool, and it is
 * routinely the slowest this process will ever run. Paging on it would teach an
 * operator that this channel cries wolf at every deploy, which is how an alert
 * stops being read.
 */
export const SWEEP_SLOW_MIN_SAMPLES = 3;

/**
 * The alert for sweeps whose p90 has climbed into the interval they have to fit
 * in, or null when there is nothing to say.
 *
 * WARN AND NEVER CRITICAL, deliberately: this condition is a forecast, and the
 * event it forecasts — the skipped sweep — has its own escalation above. Two
 * criticals for one cause is how a page gets muted.
 */
export function sweepSlowAlert(input: {
  readonly p90Ms: number | null;
  readonly sweepMs: number;
  readonly samples: number;
}): Alert | null {
  const { p90Ms, sweepMs, samples } = input;
  if (p90Ms === null || samples < SWEEP_SLOW_MIN_SAMPLES) return null;
  if (!Number.isFinite(sweepMs) || sweepMs <= 0) return null;
  if (p90Ms < sweepMs * SWEEP_SLOW_FRACTION) return null;
  const percent = Math.round((p90Ms / sweepMs) * 100);
  return {
    key: SWEEP_SLOW_ALERT_KEY,
    severity: "warn",
    title: "The keeper's sweeps are filling their own interval",
    detail:
      `p90 over the last ${samples} sweep${samples === 1 ? "" : "s"} is ${p90Ms} ms against a ${sweepMs} ms interval ` +
      `(${percent} %). Past 100 % the next sweep is skipped and nobody in it is settled: raise SIP_SOLANA_SWEEP_MS, ` +
      "or read /status's phase timings for the lane that is filling.",
    context: { p90Ms, sweepMs, percent },
  };
}

/**
 * Jupiter requests one invest turn makes through @sip/solana-program's route
 * builder: a /quote and a /swap-instructions.
 *
 * COUNTED, NOT ASSUMED, at the two call sites in venue-depth.ts. The keyless
 * tier allows 30 requests a minute and an invest turn spends about a dozen, so
 * this — not the RPC, not the code — is the ceiling on ACTIVE users per minute.
 * A number the owner has to derive from reading the source is a number that
 * goes stale the first time a leg is added to the basket.
 */
export const JUPITER_CALLS_PER_ROUTE_BUILD = 2;

/** And the depth probe's bare quote: one GET, never posted back to /swap-instructions. */
export const JUPITER_CALLS_PER_QUOTE = 1;

/**
 * The keyless tier's published limit, kept beside the counter that is compared
 * against it: 30 requests per minute.
 */
export const JUPITER_KEYLESS_CALLS_PER_MINUTE = 30;

/**
 * Jupiter requests, counted where they are made and read where the sweep ends.
 *
 * A PROCESS SINGLETON, because the alternative is threading a counter through
 * the invest tick, the leg loop and the depth gate — four signatures on the
 * money path changed to carry a number that must never affect them. One sweep
 * runs at a time (bin/keeper.mts's `cycleRunning`), so the per-sweep total is
 * unambiguous.
 */
export interface JupiterCallCounter {
  /** Zero the per-sweep total. Called at the top of a sweep, by the sweep. */
  startSweep(): void;
  /** Record `calls` Jupiter requests. Never throws and never returns anything a caller could branch on. */
  count(calls: number): void;
  /** What this sweep has spent so far. */
  sweepTotal(): number;
  /** What this process has spent since it came up. */
  total(): number;
}

export function createJupiterCallCounter(): JupiterCallCounter {
  let sweep = 0;
  let all = 0;
  return {
    startSweep() {
      sweep = 0;
    },
    count(calls) {
      if (!Number.isFinite(calls) || calls <= 0) return;
      sweep += calls;
      all += calls;
    },
    sweepTotal: () => sweep,
    total: () => all,
  };
}

/** The one counter the keeper reads and venue-depth.ts writes. */
export const jupiterCalls: JupiterCallCounter = createJupiterCallCounter();
