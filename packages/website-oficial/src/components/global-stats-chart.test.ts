// The dashboard's chart card where recharts is not involved: the band in
// place of a series that is missing or empty, and the tooltip, which prints
// from the exact strings and never from a bar's height.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RunningTotalCard } from "@/components/global-stats-area";
import { BarsTooltip, Headline, StackedBarsCard, valueText, type StackedBarsCardProps } from "@/components/global-stats-chart";
import { known, unavailable } from "@/lib/global-stats-model";
import { bucketize, toPlotRows, type DayValues } from "@/lib/global-stats-series";

const props = (over: Partial<StackedBarsCardProps>): StackedBarsCardProps => ({
  id: "saved",
  title: "Put aside per day (SOL)",
  sample: false,
  series: ["profit", "volume"],
  unit: { label: "SOL", decimals: 9 },
  days: known({ rows: [], partial: false }),
  end: "2026-10-06",
  first: null,
  periods: ["day", "week"],
  views: ["period", "cumulative", "share"],
  emptyCaption: "No settlements yet",
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
    expect(html).toContain("No settlements yet");
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

  it("prints an approximate measure as ≈, never as 'at least', even on a partly read day", () => {
    const html = renderToStaticMarkup(
      createElement(BarsTooltip, { active: true, payload: [{ payload: { ...row, unread: true } }], series: ["profit", "volume"], unit: { label: "SOL", decimals: 9 }, period: "day", view: "period", approximate: true }),
    );
    expect(html).toContain("≈ 0.0366 SOL");
    expect(html).not.toContain("at least");
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

describe("a lead card's headline", () => {
  it("puts the qualifier right before the figure, the unit after it, and the growth beside it", () => {
    const html = renderToStaticMarkup(
      createElement(Headline, { value: "18.9759", qualifier: "≈", unit: "SOL", title: "18.9759 SOL", delta: "+12.4% in 7 days", dollars: { text: "≈ $2,846.39", title: "At today’s SOL price, not what it was worth on the day" } }),
    );
    expect(html).toMatch(/>≈<\/span><span[^>]*title="18\.9759 SOL"[^>]*>18\.9759<\/span><span[^>]*>SOL<\/span>/);
    expect(html).toContain("+12.4% in 7 days");
  });

  it("prints the dollars as a figure, with the price that made them in its hover, and nothing else under the figure", () => {
    const html = renderToStaticMarkup(
      createElement(Headline, { value: "0.2879", qualifier: null, unit: "SOL", title: "0.287866794 SOL", delta: null, dollars: { text: "≈ $29.55", title: "At today’s SOL price, not what it was worth on the day" } }),
    );
    expect(html).toMatch(/<p[^>]*title="At today’s SOL price, not what it was worth on the day"[^>]*>≈ \$29\.55<\/p>/);
    expect(html.match(/<p\b/g)).toHaveLength(1);
  });

  it("under a headline, a series not published yet draws no band: the page says it once", () => {
    const headline = { value: "0.1864", qualifier: null, unit: "SOL", title: null, delta: null, dollars: null };
    const quiet = renderToStaticMarkup(createElement(StackedBarsCard, props({ headline, days: unavailable("not-served-yet") })));
    expect(quiet).toContain("0.1864");
    expect(quiet).not.toContain("border-dashed");
    const unread = renderToStaticMarkup(createElement(StackedBarsCard, props({ headline, days: unavailable("field-unreadable") })));
    expect(unread).toContain("This figure is not published yet.");
    expect(unread).toContain("border-dashed");
  });

  it("the running-total card does the same, and keeps its headline either way", () => {
    const base = {
      id: "saved",
      title: "Put aside so far",
      info: "What went in: withdrawals are not taken off.",
      sample: false,
      headline: { value: "0.1864", qualifier: null, unit: "SOL", title: null, delta: null, dollars: null },
      series: "saved" as const,
      unit: { label: "SOL" as const, decimals: 9 as const },
      end: "2026-10-06",
      first: "2026-09-19",
      emptyCaption: "No settlement yet.",
      unavailableCaption: "This figure was missing from the answer.",
    };
    const quiet = renderToStaticMarkup(createElement(RunningTotalCard, { ...base, days: unavailable("not-served-yet") }));
    expect(quiet).toContain("0.1864");
    expect(quiet).not.toContain("border-dashed");
    const unread = renderToStaticMarkup(createElement(RunningTotalCard, { ...base, days: unavailable("field-unreadable") }));
    expect(unread).toContain("This figure was missing from the answer.");
  });
});

/**
 * NO SUBTEXT (owner, 10-24): no line under a chart's title, none under its
 * bars. What it counts, and days nobody could read, are its title's hover.
 */
describe("a chart card's text", () => {
  const rows: readonly DayValues[] = [
    { day: "2026-10-05", values: { profit: "36634582", volume: "1000000" } },
    { day: "2026-10-06", values: { profit: "12000000" } },
  ];

  it("is its title, its controls and its legend: no description, no count of days, no footer", () => {
    const html = renderToStaticMarkup(createElement(StackedBarsCard, props({ days: known({ rows, partial: false }) })));
    expect(html).toContain(">Put aside per day (SOL)<");
    // The bars are drawn (their controls are there), and nothing is written around them.
    expect(html).toContain(">Daily<");
    expect(html).not.toContain('data-slot="card-description"');
    expect(html).not.toMatch(/days? (with|that)/);
    expect(html).not.toContain("Running total since");
    // No "?" unless the page passes one.
    expect(html).not.toContain('data-slot="popover-trigger"');
  });

  it("puts what it counts in the title's hover, and adds the days nobody could read", () => {
    const whole = renderToStaticMarkup(createElement(StackedBarsCard, props({ hint: "Including the ones that put nothing aside", days: known({ rows, partial: false }) })));
    expect(whole).toMatch(/title="Including the ones that put nothing aside"[^>]*>Put aside per day \(SOL\)</);
    const cut = renderToStaticMarkup(createElement(StackedBarsCard, props({ hint: "Including the ones that put nothing aside", days: known({ rows, partial: true }) })));
    expect(cut).toMatch(/title="Including the ones that put nothing aside · Some days could not be read"/);
    expect(cut).not.toMatch(/<p[^>]*>[^<]*Some days could not be read/);
  });

  it("keeps a '?' where the page passes one", () => {
    const html = renderToStaticMarkup(createElement(StackedBarsCard, props({ info: "Approximate: Profit and Volume are measured differently." })));
    expect(html).toContain("Approximate: Profit and Volume are measured differently.");
  });

  it("the running-total card says the days nobody could read in its title's hover, not under the curve", () => {
    const html = renderToStaticMarkup(
      createElement(RunningTotalCard, {
        id: "saved",
        title: "Put aside so far",
        info: "What went in: withdrawals are not taken off.",
        sample: false,
        headline: { value: "0.0496", qualifier: null, unit: "SOL", title: null, delta: null, dollars: null },
        days: known({ rows: [{ day: "2026-10-05", values: { saved: "37634582" } }], partial: true }),
        series: "saved",
        unit: { label: "SOL", decimals: 9 },
        end: "2026-10-06",
        first: "2026-10-05",
        emptyCaption: "No settlements yet",
        unavailableCaption: "This figure was missing from the answer.",
      }),
    );
    expect(html).toMatch(/title="Some days could not be read"[^>]*>Put aside so far</);
    expect(html).not.toContain("Running total since");
    expect(html).not.toContain('data-slot="card-description"');
  });
});
