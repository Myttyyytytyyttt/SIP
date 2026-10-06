// The dashboard's chart card where recharts is not involved: the band in
// place of a series that is missing or empty, and the tooltip, which prints
// from the exact strings and never from a bar's height.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BarsTooltip, StackedBarsCard, valueText, type StackedBarsCardProps } from "@/components/global-stats-chart";
import { known, unavailable } from "@/lib/global-stats-model";
import { bucketize, toPlotRows } from "@/lib/global-stats-series";

const props = (over: Partial<StackedBarsCardProps>): StackedBarsCardProps => ({
  id: "saved",
  title: "Put aside",
  description: "SOL put aside by settlements, by mode. Days are UTC.",
  info: "Each bar is what settlements put aside.",
  sample: false,
  series: ["profit", "volume"],
  unit: { label: "SOL", decimals: 9 },
  days: known({ rows: [], partial: false }),
  end: "2026-10-06",
  first: null,
  periods: ["day", "week"],
  views: ["period", "cumulative", "share"],
  emptyCaption: "No settlement yet. The first one starts this chart.",
  unavailableCaption: "This figure is not published yet.",
  ...over,
});

describe("a chart with nothing to draw", () => {
  it("is a band that says why, and no controls", () => {
    const html = renderToStaticMarkup(createElement(StackedBarsCard, props({ days: unavailable("not-served-yet") })));
    expect(html).toContain("This figure is not published yet.");
    expect(html).toContain("border-dashed");
    expect(html).not.toContain("Daily");
  });

  it("served and empty is a different sentence", () => {
    const html = renderToStaticMarkup(createElement(StackedBarsCard, props({})));
    expect(html).toContain("No settlement yet. The first one starts this chart.");
  });

  it("built from the sample, says so on the card", () => {
    expect(renderToStaticMarkup(createElement(StackedBarsCard, props({ sample: true })))).toContain(">Sample<");
  });
});

describe("the tooltip", () => {
  const [bucket] = bucketize([{ day: "2026-10-06", values: { profit: "36634582", volume: "1000000" } }], ["2026-10-06"], "day", ["profit", "volume"], "2026-10-06");
  const [row] = toPlotRows([bucket!], "period", ["profit", "volume"], 9);
  const tip = (over: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      createElement(BarsTooltip, { active: true, payload: [{ payload: { ...row, ...over } }], series: ["profit", "volume"], unit: { label: "SOL", decimals: 9 }, period: "day", view: "period" }),
    );

  it("heads with the UTC day, says a running day is 'so far', and adds a total", () => {
    const html = tip();
    expect(html).toContain("Oct 6, 2026 · UTC · so far");
    expect(html).toContain("0.0366 SOL");
    expect(html).toContain("0.001 SOL");
    expect(html).toContain("Total");
    expect(html).toContain("0.0376 SOL");
  });

  it("prints the exact string even when the bar's number says otherwise", () => {
    expect(tip({ profit: 999 })).toContain("0.0366 SOL");
  });

  it("says a day nobody could read is not read, never 0, and reads a partly read one as a floor", () => {
    const [empty] = bucketize([], ["2026-10-05"], "day", ["profit", "volume"], "2026-10-06", () => true);
    expect(tip({ ...toPlotRows([empty!], "period", ["profit", "volume"], 9)[0] })).toContain("Could not be read");
    expect(tip({ ...toPlotRows([empty!], "period", ["profit", "volume"], 9)[0] })).not.toContain("0 SOL");
    const partly = tip({ unread: true });
    expect(partly).toContain("at least 0.0366 SOL");
    expect(partly).toContain("at least 0.0376 SOL");
  });

  it("is nothing when the pointer is elsewhere", () => {
    expect(renderToStaticMarkup(createElement(BarsTooltip, { active: false, payload: [], series: ["profit"], unit: { label: "SOL", decimals: 9 }, period: "day", view: "period" }))).toBe("");
  });

  it("in the share view, prints shares that read 100 % and says an empty bar has none", () => {
    const html = renderToStaticMarkup(
      createElement(BarsTooltip, { active: true, payload: [{ payload: toPlotRows([bucket!], "share", ["profit", "volume"], 9)[0] }], series: ["profit", "volume"], unit: { label: "SOL", decimals: 9 }, period: "day", view: "share" }),
    );
    expect(html).toContain("97.34%");
    expect(html).toContain("2.66%");
    const [empty] = bucketize([], ["2026-10-06"], "day", ["profit"], "2026-10-06");
    const none = renderToStaticMarkup(
      createElement(BarsTooltip, { active: true, payload: [{ payload: toPlotRows([empty!], "share", ["profit"], 9)[0] }], series: ["profit"], unit: { label: "SOL", decimals: 9 }, period: "day", view: "share" }),
    );
    expect(none).toContain("Nothing put aside");
  });
});

describe("a value as the tooltip prints it", () => {
  it("in its own unit, and a time series never wears $", () => {
    expect(valueText("36634582", { label: "SOL", decimals: 9 })).toBe("0.0366 SOL");
    expect(valueText("1240000000", { label: "USDC", decimals: 6 })).toBe("1,240.00 USDC");
    expect(valueText("1056", { label: null, decimals: 0 })).toBe("1,056");
    // A positive amount never reads as zero.
    expect(valueText("4999", { label: "USDC", decimals: 6 })).toBe("<0.01 USDC");
    expect(valueText("0", { label: "USDC", decimals: 6 })).toBe("0.00 USDC");
  });
});
