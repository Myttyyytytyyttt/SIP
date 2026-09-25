// The chart's buttons (owner, 09-25): what ONE point of the line stands for —
// 1h over the last 7 days, 1d over the last 30, 7d over the last 6 months —
// and all three end on the same total the hero shows.

import { describe, expect, it } from "vitest";

import { daily, hourly, weekly } from "@/components/pension-chart";
import type { SavingsPoint, Trade } from "@/mocks/types";

const DAY = 86_400_000;
const NOW = "2026-09-25T18:30:00.000Z";

/** A daily curve of `n` days ending today, rising a dollar a day. */
const curveOf = (n: number): SavingsPoint[] =>
  Array.from({ length: n }, (_, index) => ({ date: new Date(Date.parse("2026-09-25T00:00:00.000Z") - (n - 1 - index) * DAY).toISOString().slice(0, 10), total: index + 1 }));

const save = (at: string, savedUsd: number | null): Trade => ({ id: at, at, symbol: "SOL", notionalUsd: null, savedUsd, txHash: "x" });

describe("1d: a point a day, the last 30 days", () => {
  it("keeps the 30 days and the one before them", () => {
    const points = daily(curveOf(200));
    expect(points).toHaveLength(31);
    expect(points.at(-1)!.total).toBe(200);
  });
});

describe("7d: a point a week, the last 6 months", () => {
  it("takes the total at the end of each of the last 26 weeks, ending today", () => {
    const points = weekly(curveOf(400));
    expect(points).toHaveLength(27);
    expect(points.at(-1)!.total).toBe(400);
    expect(points.at(-2)!.total).toBe(393);
  });

  it("is simply shorter for a pension younger than six months", () => {
    expect(weekly(curveOf(10)).map((point) => point.total)).toEqual([3, 10]);
  });
});

describe("1h: a point an hour, the last 7 days", () => {
  const curve = curveOf(30); // ends on $30
  const saves = [save("2026-09-25T17:46:05.000Z", 3.58), save("2026-09-25T17:46:00.000Z", 0.62), save("2026-09-24T10:00:00.000Z", 1)];

  it("has 168 hours and ends on the curve's own total", () => {
    const points = hourly(curve, saves, NOW)!;
    expect(points).toHaveLength(168);
    expect(points.at(-1)!.total).toBe(30);
  });

  it("steps down by each save, in the hour it landed", () => {
    const points = hourly(curve, saves, NOW)!;
    // The 17h hour holds both of today's saves: the hour before it is $4.20 lower.
    const at17 = points.find((point) => point.date === "2026-09-25T17:00:00.000Z")!;
    const at16 = points.find((point) => point.date === "2026-09-25T16:00:00.000Z")!;
    expect(at17.total).toBe(30);
    expect(at16.total).toBe(25.8);
  });

  it("is not offered when a save's dollar amount is unknown", () => {
    expect(hourly(curve, [save("2026-09-25T17:46:05.000Z", null)], NOW)).toBeNull();
  });
});
