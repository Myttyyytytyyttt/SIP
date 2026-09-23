// What a sweep costs, and the two alerts that come out of it.
//
// THE MEASUREMENT IS THE PRODUCT HERE. Everything in src/sweep-cost.ts exists so
// that "how many simultaneous users can this keeper hold?" is arithmetic rather
// than an opinion, and a counter that is quietly wrong is worse than none: it
// would be read, and sized on. So the rules are pinned here — the percentile,
// the bound on the ring, which turns are cheap, when a skip pages — beside the
// escalations they copy (test/sweep-decision.test.ts, test/invest-decision.test.ts).

import { describe, expect, it } from "vitest";
import type { SettleOutcome } from "../src/settle-decision.js";
import {
  CHEAP_SETTLE_OUTCOMES,
  JUPITER_CALLS_PER_QUOTE,
  JUPITER_CALLS_PER_ROUTE_BUILD,
  JUPITER_KEYLESS_CALLS_PER_MINUTE,
  SWEEP_SKIPPED_ALERT_KEY,
  SWEEP_SKIPPED_CRITICAL_STREAK,
  SWEEP_SLOW_ALERT_KEY,
  SWEEP_SLOW_FRACTION,
  SWEEP_SLOW_MIN_SAMPLES,
  SWEEP_TIMES_KEPT,
  createJupiterCallCounter,
  createSweepTimes,
  jupiterCalls,
  percentileMs,
  settleWalked,
  sweepSkippedAlert,
  sweepSlowAlert,
} from "../src/sweep-cost.js";

describe("the percentiles over recent sweeps", () => {
  it("has no answer at all before a sweep has been timed", () => {
    // NOT ZERO. "No sweep has finished" and "the sweeps take no time" are
    // opposite facts, and a page that draws the first as the second tells an
    // operator his keeper is fast when it has not run.
    expect(percentileMs([], 0.5)).toBeNull();
    expect(createSweepTimes().p90()).toBeNull();
  });

  it("reports a duration that really happened, by nearest rank", () => {
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentileMs(values, 0.5)).toBe(50);
    expect(percentileMs(values, 0.9)).toBe(90);
    // Unsorted input is the normal case: sweeps arrive in time order.
    expect(percentileMs([90, 10, 50], 0.5)).toBe(50);
    expect(percentileMs([1], 0.9)).toBe(1);
  });

  it("keeps only the last SWEEP_TIMES_KEPT sweeps, because this process runs for weeks", () => {
    const times = createSweepTimes(3);
    for (const ms of [100, 200, 300, 400]) times.add(ms);
    expect(times.length).toBe(3);
    // The 100 is gone: p50 of [200,300,400] is 300, not 250.
    expect(times.p50()).toBe(300);
    expect(SWEEP_TIMES_KEPT).toBe(30);
  });

  it("drops a duration that cannot have happened rather than counting it as a fast sweep", () => {
    // Date.now() can step backwards over an NTP correction; a negative sweep is
    // not a measurement, and clamping it to 0 would drag every percentile down.
    const times = createSweepTimes();
    times.add(-5);
    times.add(Number.NaN);
    expect(times.length).toBe(0);
    times.add(1_000);
    expect(times.p50()).toBe(1_000);
  });
});

describe("which lane a turn's milliseconds belong to", () => {
  it("counts the outcomes decided before the window walk as the cheap lane", () => {
    // An idle user is not one round trip: the probe answers IDLE and the invest
    // turn then runs anyway, reading the vault, the policy and two token
    // accounts. That whole cost is what divides into the interval.
    for (const outcome of ["IDLE", "NO_SIGNER", "PAUSED"] as const) expect(settleWalked(outcome), outcome).toBe(false);
    expect([...CHEAP_SETTLE_OUTCOMES].sort()).toEqual(["IDLE", "NO_SIGNER", "PAUSED"]);
  });

  it("counts everything that can have walked as expensive, including the ambiguous ones", () => {
    // UNSUPPORTED_MODE and FAILED each have an early return AND a late one;
    // charging them to the cheap lane would hide a walk. Over-stating the
    // expensive lane is the error an operator can act on safely.
    const walked: readonly SettleOutcome[] = ["SETTLED", "NO_PROFIT", "PENDING_FINALITY", "INCOMPLETE", "BELOW_RESERVE", "RETRY", "FAILED", "UNSUPPORTED_MODE"];
    for (const outcome of walked) expect(settleWalked(outcome), outcome).toBe(true);
  });
});

describe("a sweep skipped because the previous one was still running", () => {
  it("warns on the first and pages critical on the third in a row, under one key", () => {
    // The shape vaultReadAlert and investFailedAlert already use: one key the
    // alerter dedupes, warn, then critical at three. A third shape would be a
    // third thing to learn at three in the morning.
    expect(sweepSkippedAlert(1, "x").severity).toBe("warn");
    expect(sweepSkippedAlert(2, "x").severity).toBe("warn");
    expect(sweepSkippedAlert(3, "x").severity).toBe("critical");
    expect(sweepSkippedAlert(9, "x").severity).toBe("critical");
    expect(SWEEP_SKIPPED_CRITICAL_STREAK).toBe(3);
    for (const streak of [1, 3]) expect(sweepSkippedAlert(streak, "x").key).toBe(SWEEP_SKIPPED_ALERT_KEY);
  });

  it("says how many in a row, and carries the detail it was given", () => {
    expect(sweepSkippedAlert(1, "running for 90000 ms").detail).toBe("1 sweep in a row skipped: running for 90000 ms");
    expect(sweepSkippedAlert(4, "running for 90000 ms").detail).toBe("4 sweeps in a row skipped: running for 90000 ms");
    expect(sweepSkippedAlert(4, "x").context).toEqual({ skipped: 4 });
  });
});

describe("the warning that arrives before the skip", () => {
  const sweepMs = 60_000;

  it("says nothing until there are sweeps to judge", () => {
    // The first sweep follows the chain read, the mirror's preflight and the
    // first Privy scan on a cold pool: routinely the slowest this process runs.
    expect(sweepSlowAlert({ p90Ms: null, sweepMs, samples: 0 })).toBeNull();
    expect(sweepSlowAlert({ p90Ms: 59_000, sweepMs, samples: SWEEP_SLOW_MIN_SAMPLES - 1 })).toBeNull();
  });

  it("stays quiet below 60 % of the interval and warns at it", () => {
    expect(sweepSlowAlert({ p90Ms: sweepMs * SWEEP_SLOW_FRACTION - 1, sweepMs, samples: 30 })).toBeNull();
    const alert = sweepSlowAlert({ p90Ms: sweepMs * SWEEP_SLOW_FRACTION, sweepMs, samples: 30 });
    expect(alert?.key).toBe(SWEEP_SLOW_ALERT_KEY);
    // WARN AND NEVER CRITICAL: this is a forecast, and the event it forecasts —
    // the skipped sweep — has its own escalation. Two criticals for one cause
    // is how a page gets muted.
    expect(alert?.severity).toBe("warn");
    expect(alert?.detail).toContain("60 %");
    expect(sweepSlowAlert({ p90Ms: 90_000, sweepMs, samples: 30 })?.detail).toContain("150 %");
  });

  it("cannot divide by an interval that is not one", () => {
    expect(sweepSlowAlert({ p90Ms: 10_000, sweepMs: 0, samples: 30 })).toBeNull();
    expect(sweepSlowAlert({ p90Ms: 10_000, sweepMs: Number.NaN, samples: 30 })).toBeNull();
  });
});

describe("the Jupiter budget", () => {
  it("counts a route build as its two requests and a probe as one", () => {
    // 30 requests a minute on the keyless tier, and an invest turn spends about
    // a dozen: this, not the RPC and not the code, is the ceiling on ACTIVE
    // users per minute.
    expect(JUPITER_CALLS_PER_ROUTE_BUILD).toBe(2);
    expect(JUPITER_CALLS_PER_QUOTE).toBe(1);
    expect(JUPITER_KEYLESS_CALLS_PER_MINUTE).toBe(30);
  });

  it("zeroes per sweep and keeps a total for the process", () => {
    const counter = createJupiterCallCounter();
    counter.startSweep();
    counter.count(JUPITER_CALLS_PER_ROUTE_BUILD);
    counter.count(JUPITER_CALLS_PER_QUOTE);
    expect(counter.sweepTotal()).toBe(3);
    counter.startSweep();
    expect(counter.sweepTotal()).toBe(0);
    expect(counter.total()).toBe(3);
  });

  it("ignores a count that is not a count, and never throws at a caller on the money path", () => {
    const counter = createJupiterCallCounter();
    counter.startSweep();
    counter.count(0);
    counter.count(-2);
    counter.count(Number.NaN);
    expect(counter.sweepTotal()).toBe(0);
  });

  it("exports the one counter venue-depth.ts writes and the sweep reads", () => {
    // A process singleton on purpose: the alternative is threading a number
    // through four money-path signatures that must never depend on it.
    expect(typeof jupiterCalls.startSweep).toBe("function");
    expect(typeof jupiterCalls.count).toBe("function");
    expect(typeof jupiterCalls.sweepTotal()).toBe("number");
  });
});
