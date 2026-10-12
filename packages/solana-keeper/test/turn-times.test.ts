// The turn timers and Jupiter's per-minute view (src/sweep-cost.ts): the
// measurements the ADR says the dispatcher would be sized on and nobody had
// taken — a settle's wall time, a send's two waits — and the minute Jupiter's
// limit is written in.
//
// Pure: every duration and every clock is handed in.

import { describe, expect, it } from "vitest";
import { TURN_TIMES_KEPT, createDurationRing, createJupiterCallCounter, createTurnTimers, JUPITER_KEYLESS_CALLS_PER_MINUTE } from "../src/sweep-cost.js";

describe("a duration ring", () => {
  it("is null everywhere before its first sample, which is not the same as 0 ms", () => {
    expect(createDurationRing().stats()).toEqual({ samples: 0, lastMs: null, p50Ms: null, p90Ms: null, maxMs: null });
  });

  it("serves the last sample and nearest-rank percentiles over the most recent ones, and counts every sample ever taken", () => {
    const ring = createDurationRing(10);
    for (let ms = 1; ms <= 15; ms++) ring.add(ms * 100);
    // Only 600..1500 are kept; all fifteen were taken.
    expect(ring.stats()).toEqual({ samples: 15, lastMs: 1_500, p50Ms: 1_000, p90Ms: 1_400, maxMs: 1_500 });
  });

  it("drops a duration that did not happen", () => {
    const ring = createDurationRing();
    for (const ms of [-5, Number.NaN, Number.POSITIVE_INFINITY]) ring.add(ms);
    expect(ring.stats().samples).toBe(0);
  });
});

describe("the turn timers", () => {
  it("keeps each phase apart, bounded at TURN_TIMES_KEPT", () => {
    const timers = createTurnTimers();
    timers.record("settleSettledMs", 1_480);
    timers.record("settleSubmitMs", 600);
    timers.record("settleConfirmMs", 1_900);
    for (let i = 0; i < TURN_TIMES_KEPT + 20; i++) timers.record("privyIndexMs", 200);
    const report = timers.report();
    expect(report.settleSettledMs).toMatchObject({ samples: 1, lastMs: 1_480 });
    expect(report.settleSubmitMs.lastMs).toBe(600);
    expect(report.settleConfirmMs.lastMs).toBe(1_900);
    expect(report.investInvestedMs.samples).toBe(0);
    expect(report.investConfirmMs.samples).toBe(0);
    expect(report.privyIndexMs).toMatchObject({ samples: TURN_TIMES_KEPT + 20, p90Ms: 200 });
    expect(Object.keys(report).sort()).toEqual(
      ["investConfirmMs", "investInvestedMs", "privyIndexMs", "settleConfirmMs", "settleSettledMs", "settleSubmitMs"].sort(),
    );
  });
});

describe("Jupiter's minute", () => {
  it("serves the last minute, the busiest minute of the day and that peak against the keyless 30", () => {
    const clock = { now: 1_760_000_000_000 };
    const jupiter = createJupiterCallCounter({ startedAt: clock.now, now: () => clock.now });
    // A buying turn: three legs' route builds and probes, inside twenty seconds.
    for (let i = 0; i < 3; i++) {
      jupiter.count(2);
      jupiter.count(1);
      clock.now += 5_000;
    }
    jupiter.count(18);
    let report = jupiter.report(clock.now);
    expect(report.callsLastMinute).toBe(27);
    expect(report.peakPerMinuteLastDay).toBe(27);
    expect(report.budgetPerMinute).toBe(JUPITER_KEYLESS_CALLS_PER_MINUTE);
    expect(report.peakPctOfBudget).toBe(90);

    // Ten minutes later the burst is over; the minute reads 0 and the peak remembers it.
    clock.now += 600_000;
    jupiter.count(3);
    report = jupiter.report(clock.now);
    expect(report.callsLastMinute).toBe(3);
    expect(report.peakPerMinuteLastDay).toBe(27);
    expect(report.callsPerDay).toBe(30);
    expect(report.callsSinceBoot).toBe(30);
  });

  it("keeps the per-sweep and lifetime counts it always kept", () => {
    const jupiter = createJupiterCallCounter();
    jupiter.startSweep();
    jupiter.count(2);
    jupiter.count(1);
    expect(jupiter.sweepTotal()).toBe(3);
    jupiter.startSweep();
    expect(jupiter.sweepTotal()).toBe(0);
    expect(jupiter.total()).toBe(3);
  });
});
