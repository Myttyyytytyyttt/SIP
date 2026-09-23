// THE X AXIS MAY NOT SAY THE SAME DAY TWICE.
//
// The curve's points are SETTLEMENTS, not days, so a busy afternoon puts four
// of them in one date — and recharts, which picks its ticks by pixel spacing,
// printed that date under each one. A reader counting the labels would count
// four days of saving where there was one.

import { describe, expect, it } from "vitest";

import { dayTicks } from "@/components/live/LiveSavedChart";
import { dayLabel } from "@/lib/format";
import type { LiveChartPoint } from "@/lib/live-types";

const at = (iso: string, total: bigint): LiveChartPoint => ({ at: iso, totalLamports: total });

describe("the ticks are the day boundaries", () => {
  it("takes the day's FIRST point and skips the rest of that day", () => {
    expect(
      dayTicks([
        at("2026-09-14T08:00:00.000Z", 1n),
        at("2026-09-14T13:00:00.000Z", 2n),
        at("2026-09-14T19:00:00.000Z", 3n),
        at("2026-09-16T09:00:00.000Z", 4n),
      ]),
    ).toEqual(["2026-09-14T08:00:00.000Z", "2026-09-16T09:00:00.000Z"]);
  });

  /**
   * THE POINT OF THE WHOLE THING: whatever recharts then thins away, no two
   * ticks it keeps can carry the same date.
   */
  it("hands out each date at most once, over a window that revisits none", () => {
    const points = Array.from({ length: 40 }, (_, index) =>
      at(`2026-09-${String(10 + Math.floor(index / 5)).padStart(2, "0")}T0${index % 5}:00:00.000Z`, BigInt(index)),
    );
    const labels = dayTicks(points).map(dayLabel);
    expect(labels).toHaveLength(8);
    expect(new Set(labels).size).toBe(labels.length);
  });

  /** Every tick is a real point of the series, so none is drawn off the curve. */
  it("returns timestamps the chart actually plots, in the order it plots them", () => {
    const points = [at("2026-09-14T08:00:00.000Z", 1n), at("2026-09-14T19:00:00.000Z", 2n), at("2026-09-15T09:00:00.000Z", 3n)];
    const ticks = dayTicks(points);
    const plotted = points.map((point) => point.at);
    for (const tick of ticks) expect(plotted).toContain(tick);
    expect([...ticks].sort()).toEqual([...ticks]);
  });

  /** The bucket is UTC, as every other date on the page is. */
  it("cuts the day in UTC, so a late-evening settlement is not tomorrow", () => {
    const ticks = dayTicks([at("2026-09-14T23:30:00.000Z", 1n), at("2026-09-15T00:30:00.000Z", 2n)]);
    expect(ticks.map(dayLabel)).toEqual(["Sep 14", "Sep 15"]);
  });

  it("has nothing to draw for an empty series", () => {
    expect(dayTicks([])).toEqual([]);
  });
});
