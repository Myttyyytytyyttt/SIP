// The dashboard's charts, as arithmetic: which days a chart shows, how days
// fold into weeks, that a running total ends on the all-time figure, that the
// shares of a bar read 100 % together — and that a bar's height is the only
// Number ever taken of an amount.

import { describe, expect, it } from "vitest";

import {
  addDays,
  axisTick,
  bucketize,
  carryIn,
  cumulative,
  dayWindow,
  investedByDay,
  pensionsByDay,
  plotUnits,
  savedByDay,
  settlementsByDay,
  shareBps,
  growthBps,
  savedTotalByDay,
  sparkBars,
  toPlotRows,
  tradedByDay,
  unreadDays,
  weekStart,
  weekWindow,
  type DayValues,
} from "@/lib/global-stats-series";
import type { StatsDay } from "@/lib/global-stats-model";

const SERIES = ["profit", "volume"] as const;
const rows: readonly DayValues[] = [
  { day: "2026-09-19", values: { profit: "100", volume: "0" } },
  { day: "2026-09-22", values: { profit: "50", volume: "25" } },
  { day: "2026-09-25", values: { profit: "0", volume: "10" } },
];

describe("UTC days and weeks", () => {
  it("steps across month ends, year ends and a leap day", () => {
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-10-01", -1)).toBe("2026-09-30");
  });

  it("starts a week on Monday, the keeper's own week", () => {
    expect(weekStart("2026-09-28")).toBe("2026-09-28");
    expect(weekStart("2026-09-30")).toBe("2026-09-28");
    expect(weekStart("2026-10-04")).toBe("2026-09-28");
  });
});

describe("the window a chart shows", () => {
  it("is at least two weeks, reaching back to the first day when it fits, and ends on the data's day", () => {
    const young = dayWindow("2026-09-30", "2026-09-19");
    expect(young).toHaveLength(14);
    expect(young[0]).toBe("2026-09-17");
    expect(young.at(-1)).toBe("2026-09-30");
    expect(dayWindow("2026-09-30", "2026-09-05")).toHaveLength(26);
    expect(dayWindow("2026-09-30", "2026-01-01")).toHaveLength(30);
    expect(dayWindow("2026-09-30", null)).toHaveLength(14);
  });

  it("in weeks, Mondays only, ending with the data's week", () => {
    const weeks = weekWindow("2026-09-30", "2026-09-19");
    expect(weeks).toHaveLength(8);
    expect(weeks.at(-1)).toBe("2026-09-28");
    expect(weeks.every((week) => weekStart(week) === week)).toBe(true);
  });
});

describe("bars", () => {
  it("sum the days into their buckets in BigInt; a window day with no row is a true zero", () => {
    const window = dayWindow("2026-09-25", "2026-09-19");
    const buckets = bucketize(rows, window, "day", SERIES, "2026-09-25");
    const sep22 = buckets.find((bucket) => bucket.key === "2026-09-22");
    expect(sep22?.values).toEqual({ profit: "50", volume: "25" });
    expect(sep22?.total).toBe("75");
    expect(buckets.find((bucket) => bucket.key === "2026-09-20")?.total).toBe("0");
    // The last day added up was still running: only its bar is "so far".
    expect(buckets.filter((bucket) => bucket.soFar).map((bucket) => bucket.key)).toEqual(["2026-09-25"]);
  });

  it("fold days into Monday weeks", () => {
    const weeks = bucketize(rows, weekWindow("2026-09-25", "2026-09-19"), "week", SERIES, "2026-09-25");
    expect(weeks.find((week) => week.key === "2026-09-14")?.values).toEqual({ profit: "100", volume: "0" });
    expect(weeks.find((week) => week.key === "2026-09-21")?.values).toEqual({ profit: "50", volume: "35" });
  });

  it("never count a day after the one the data was added up on", () => {
    const later = [...rows, { day: "2026-09-26", values: { profit: "999", volume: "0" } }];
    const buckets = bucketize(later, weekWindow("2026-09-25", null), "week", SERIES, "2026-09-25");
    expect(buckets.at(-1)?.values).toEqual({ profit: "50", volume: "35" });
  });
});

describe("a running total", () => {
  it("carries in everything before the window, so its last bar is the all-time figure", () => {
    const window = ["2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25"];
    const carry = carryIn(rows, window[0]!, SERIES);
    expect(carry).toEqual({ profit: "100", volume: "0" });
    const running = cumulative(bucketize(rows, window, "day", SERIES, "2026-09-25"), carry, SERIES);
    expect(running.at(-1)?.values).toEqual({ profit: "150", volume: "35" });
    expect(running.at(-1)?.total).toBe("185");
  });
});

describe("shares", () => {
  it("read exactly 100 % together, and an empty bar has none", () => {
    const [bucket] = bucketize([{ day: "2026-09-25", values: { profit: "1", volume: "2" } }], ["2026-09-25"], "day", SERIES, "2026-09-25");
    const shares = shareBps(bucket!, SERIES);
    expect(shares).toEqual({ profit: 3_333, volume: 6_667 });
    const [empty] = bucketize([], ["2026-09-25"], "day", SERIES, "2026-09-25");
    expect(shareBps(empty!, SERIES)).toBeNull();
  });
});

describe("what recharts receives", () => {
  it("one geometry number per series, the exact strings beside it, and who sits on top", () => {
    const buckets = bucketize(rows, ["2026-09-19", "2026-09-22", "2026-09-25"], "day", SERIES, "2026-09-25");
    const plot = toPlotRows(buckets, "period", SERIES, 0);
    expect(plot[1]).toMatchObject({ key: "2026-09-22", profit: 50, volume: 25, exact: { profit: "50", volume: "25" }, bottom: "profit", top: "volume" });
    // A zero lower series: the upper one sits on the axis and takes the rounded top.
    expect(plot[2]).toMatchObject({ bottom: "volume", top: "volume" });
    const shares = toPlotRows(buckets, "share", SERIES, 0);
    expect(shares[1]).toMatchObject({ profit: 66.66, volume: 33.34 });
  });

  it("sizes a bar from BigInt first, so no amount loses digits on the way to a number", () => {
    expect(plotUnits("186400000", 9)).toBe(0.1864);
    expect(plotUnits("4000000", 6)).toBe(4);
    expect(plotUnits("12", 0)).toBe(12);
  });

  it("prints axis ticks without a locale", () => {
    expect(axisTick(0.05)).toBe("0.05");
    expect(axisTick(0.1234)).toBe("0.123");
    expect(axisTick(12.5)).toBe("12.5");
    expect(axisTick(1234)).toBe("1.2K");
  });
});

describe("from the model's days to a chart's", () => {
  const days: readonly StatsDay[] = [
    { day: "2026-10-01", profit: { savedRaw: "150", tradedRaw: null, settlements: 6, payingSettlements: 5 }, volume: { savedRaw: "100", tradedRaw: null, settlements: 4, payingSettlements: 4 }, pensions: 3 },
    { day: "2026-10-02", profit: { savedRaw: "50", tradedRaw: null, settlements: 2, payingSettlements: 2 }, volume: null, pensions: null },
  ];

  it("a mode with no row on a served day is that mode's zero", () => {
    expect(savedByDay(days)[1]).toEqual({ day: "2026-10-02", values: { profit: "50", volume: "0" } });
    expect(settlementsByDay(days)[0]).toEqual({ day: "2026-10-01", values: { profit: "6", volume: "4" } });
  });

  it("a day that did not send its pension count is left out, not zeroed, and named", () => {
    expect(pensionsByDay(days)).toEqual({ rows: [{ day: "2026-10-01", values: { pensions: "3" } }], missing: ["2026-10-02"] });
  });

  it("what was bought, every asset of a day together", () => {
    expect(
      investedByDay([
        { day: "2026-10-02", mint: "a", spentRaw: "5", buys: 1 },
        { day: "2026-10-01", mint: "a", spentRaw: "3", buys: 1 },
        { day: "2026-10-01", mint: "b", spentRaw: "1", buys: 1 },
      ]),
    ).toEqual([
      { day: "2026-10-01", values: { invested: "4" } },
      { day: "2026-10-02", values: { invested: "5" } },
    ]);
  });
});

/** The review of 10-06: a day nobody could read is drawn and printed as a floor or as "not read", never as 0. */
describe("a day that could not be read", () => {
  const served: readonly DayValues[] = [
    { day: "2026-10-01", values: { profit: "100", volume: "0" } },
    { day: "2026-10-03", values: { profit: "50", volume: "0" } },
  ];
  const window = ["2026-10-01", "2026-10-02", "2026-10-03"];

  it("in a whole series, a day with no row is a true zero", () => {
    const buckets = bucketize(served, window, "day", SERIES, "2026-10-03", unreadDays(served, false));
    expect(buckets.map((bucket) => bucket.unread)).toEqual([false, false, false]);
  });

  it("in a partial one, a day with no row is unread, and so is its week", () => {
    const unread = unreadDays(served, true);
    expect(bucketize(served, window, "day", SERIES, "2026-10-03", unread).map((bucket) => bucket.unread)).toEqual([false, true, false]);
    expect(bucketize(served, ["2026-09-28"], "week", SERIES, "2026-10-03", unread)[0]?.unread).toBe(true);
  });

  it("a day named as missing is unread whatever the series says", () => {
    const unread = unreadDays(served, false, ["2026-10-01"]);
    expect(bucketize(served, window, "day", SERIES, "2026-10-03", unread).map((bucket) => bucket.unread)).toEqual([true, false, false]);
  });

  it("makes every later running total a floor, and draws no share of a partly read bar", () => {
    const buckets = bucketize(served, window, "day", SERIES, "2026-10-03", unreadDays(served, true));
    expect(cumulative(buckets, { profit: "0", volume: "0" }, SERIES).map((bucket) => bucket.unread)).toEqual([false, true, true]);
    expect(cumulative(buckets, { profit: "0", volume: "0" }, SERIES, true)[0]?.unread).toBe(true);
    expect(toPlotRows(buckets, "share", SERIES, 0)[1]?.shares).toBeNull();
  });
});

describe("the segment that takes the rounded top", () => {
  it("is the highest one DRAWN: an amount too small to draw does not take it", () => {
    const [bucket] = bucketize([{ day: "2026-10-01", values: { profit: "500000000", volume: "1" } }], ["2026-10-01"], "day", SERIES, "2026-10-01");
    expect(toPlotRows([bucket!], "period", SERIES, 9)[0]).toMatchObject({ bottom: "profit", top: "profit", volume: 0 });
  });
});

describe("the lead cards' arithmetic", () => {
  const days: readonly StatsDay[] = [
    { day: "2026-09-25", profit: { savedRaw: "100", tradedRaw: "1000", settlements: 1, payingSettlements: 1 }, volume: null, pensions: 1 },
    { day: "2026-10-02", profit: { savedRaw: "50", tradedRaw: null, settlements: 1, payingSettlements: 1 }, volume: { savedRaw: "50", tradedRaw: "5000", settlements: 1, payingSettlements: 1 }, pensions: 2 },
  ];

  it("adds both modes into what was put aside each day", () => {
    expect(savedTotalByDay(days)).toEqual([
      { day: "2026-09-25", values: { saved: "100" } },
      { day: "2026-10-02", values: { saved: "100" } },
    ]);
  });

  it("leaves out, and names, a day whose traded figure a mode did not send", () => {
    expect(tradedByDay(days)).toEqual({ rows: [{ day: "2026-09-25", values: { profit: "1000", volume: "0" } }], missing: ["2026-10-02"] });
  });

  it("grows a running total over 7 days from where it stood before them, and not from nothing", () => {
    const saved = savedTotalByDay(days);
    // 100 before Sep 26, 200 by Oct 3: +100 %.
    expect(growthBps(saved, "2026-10-03", 7, ["saved"])).toBe(10_000);
    expect(growthBps(saved, "2026-09-26", 7, ["saved"])).toBeNull();
  });

  it("draws two weeks of spark bars against the tallest, and none when a day in them was not read", () => {
    const bars = sparkBars(savedTotalByDay(days), "2026-10-03", 14, ["saved"], () => false);
    expect(bars).toHaveLength(14);
    expect(bars?.filter((bar) => bar === 1)).toHaveLength(2);
    expect(sparkBars(savedTotalByDay(days), "2026-10-03", 14, ["saved"], (day) => day === "2026-09-30")).toBeNull();
  });
});
