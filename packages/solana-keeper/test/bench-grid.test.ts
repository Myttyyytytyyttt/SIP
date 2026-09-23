// What the ceiling bench's numbers mean: the verdict against the sweep window,
// the line through the measured sweeps, and the extrapolation it is allowed to
// state.
//
// THE ONE THING THIS FILE IS REALLY FOR: keeping "measured" and "extrapolated"
// apart. A fitted ceiling is arithmetic over rows that really ran, and it is a
// number an owner would plan capacity on, so the fit refuses to exist on
// evidence that cannot support it — one fleet size, or a slope that is not
// positive — rather than printing a figure with nothing behind it.

import { describe, expect, it } from "vitest";
import { buildGrid, ceilingLinks, fitSweepCost, largestFitting, parseCountList, parseLatencyList, sweepVerdict } from "../src/bench/grid.js";
import { SWEEP_SLOW_FRACTION } from "../src/sweep-cost.js";

describe("a sweep against the window it has to fit in", () => {
  it("grades on the keeper's own two thresholds, not on new ones", () => {
    expect(sweepVerdict(1_000, 60_000)).toBe("fits");
    // SWEEP_SLOW_FRACTION is where src/sweep-cost.ts starts warning.
    expect(sweepVerdict(60_000 * SWEEP_SLOW_FRACTION - 1, 60_000)).toBe("fits");
    expect(sweepVerdict(60_000 * SWEEP_SLOW_FRACTION, 60_000)).toBe("close");
    expect(sweepVerdict(59_999, 60_000)).toBe("close");
    // At the window the next sweep is skipped and somebody goes unsettled.
    expect(sweepVerdict(60_000, 60_000)).toBe("overruns");
    expect(sweepVerdict(120_000, 60_000)).toBe("overruns");
  });

  it("refuses a window that is not a positive number of milliseconds", () => {
    expect(() => sweepVerdict(10, 0)).toThrow(/positive number of milliseconds/);
  });
});

describe("the line drawn through the measured sweeps", () => {
  it("recovers a fixed cost and a per-link cost from sweeps that lie on one", () => {
    const fit = fitSweepCost([
      { links: 1, sweepMs: 400 },
      { links: 10, sweepMs: 2_200 },
      { links: 100, sweepMs: 20_200 },
    ]);
    expect(fit).not.toBeNull();
    expect(fit!.fixedMs).toBeCloseTo(200, 6);
    expect(fit!.perLinkMs).toBeCloseTo(200, 6);
    expect(fit!.points).toBe(3);
  });

  it("is NULL on one fleet size, because one point fixes no slope", () => {
    expect(fitSweepCost([{ links: 10, sweepMs: 2_000 }])).toBeNull();
    expect(
      fitSweepCost([
        { links: 10, sweepMs: 2_000 },
        { links: 10, sweepMs: 2_100 },
      ]),
    ).toBeNull();
  });

  it("reads the fleet size at which the window fills, as the first size that does NOT fit", () => {
    const fit = { fixedMs: 200, perLinkMs: 200, points: 3 };
    // (60_000 - 200) / 200 = 299, so 299 links take exactly the window, which is
    // already an overrun.
    expect(ceilingLinks(fit, 60_000)).toBe(299);
    expect(sweepVerdict(fit.fixedMs + fit.perLinkMs * 299, 60_000)).toBe("overruns");
    expect(sweepVerdict(fit.fixedMs + fit.perLinkMs * 298, 60_000)).not.toBe("overruns");
  });

  it("answers null rather than 'infinite users' for a slope that is not positive", () => {
    expect(ceilingLinks({ fixedMs: 200, perLinkMs: 0, points: 4 }, 60_000)).toBeNull();
    expect(ceilingLinks({ fixedMs: 200, perLinkMs: -3, points: 4 }, 60_000)).toBeNull();
  });

  it("reports the largest fleet that was actually MEASURED to fit, separately from the fit", () => {
    const points = [
      { links: 1, sweepMs: 400 },
      { links: 100, sweepMs: 20_000 },
      { links: 400, sweepMs: 80_000 },
    ];
    expect(largestFitting(points, 60_000)).toBe(100);
    expect(largestFitting([{ links: 5, sweepMs: 90_000 }], 60_000)).toBeNull();
  });
});

describe("the grid the bench walks", () => {
  it("takes whole counts and refuses anything else, rather than running two thirds of what was asked for", () => {
    expect(parseCountList("1, 10 ,100", "--links")).toEqual([1, 10, 100]);
    expect(() => parseCountList("1,10,fifty", "--links")).toThrow(/--links/);
    expect(() => parseCountList("1,-10", "--links")).toThrow(/--links/);
    expect(() => parseCountList("  ", "--links")).toThrow(/at least one value/);
  });

  it("reads a latency as p50:p90, and a bare number as a flat latency", () => {
    expect(parseLatencyList("86:122, 30", "--latency")).toEqual([
      { p50Ms: 86, p90Ms: 122 },
      { p50Ms: 30, p90Ms: 30 },
    ]);
    expect(() => parseLatencyList("122:86", "--latency")).toThrow(/p90 must be at or above its p50/);
    expect(() => parseLatencyList("fast", "--latency")).toThrow(/--latency/);
  });

  it("walks every fleet size at every latency, latency by latency", () => {
    const grid = buildGrid([1, 2], [{ p50Ms: 10, p90Ms: 10 }, { p50Ms: 86, p90Ms: 122 }]);
    expect(grid.map((cell) => `${cell.links}@${cell.latency.p50Ms}`)).toEqual(["1@10", "2@10", "1@86", "2@86"]);
  });
});
