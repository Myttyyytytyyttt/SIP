// The days a save happened — now in the pension card's header — say how many
// weeks they span in the grammar a person would use.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PensionStats, SaveCalendar } from "@/components/pension-stats";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UNKNOWN } from "@/lib/format";
import { toDashboardMock } from "@/lib/live-mock";
import { mock } from "@/mocks";

import { liveDashboard } from "../../test/fixtures/live-dashboard";

const days = (count: number) => Array.from({ length: count }, (_, index) => ({ date: `2026-09-${String(10 + index).padStart(2, "0")}`, savedUsd: index === 0 ? 3.66 : 0, volumeUsd: null, trades: null }));
const render = (count: number): string =>
  renderToStaticMarkup(createElement(TooltipProvider, null, createElement(SaveCalendar, { days: days(count), now: "2026-09-23T12:00:00.000Z" }))).replace(/<[^>]*>/g, "");

describe("the save calendar's caption", () => {
  it("says one week, not one weeks", () => {
    expect(render(6)).toContain("Last 1 week");
    expect(render(6)).not.toContain("1 weeks");
  });

  it("says weeks for more than one", () => {
    expect(render(14)).toContain("Last 2 weeks");
  });
});

/**
 * A COUNT NOBODY MADE IS A DASH (10-09, G10): a live page whose history has not
 * answered, or could not be read, has no number of investments — the tile says
 * "—", never 0, and stays in its place so the grid does not shift.
 */
describe("the Investments tile on a live page", () => {
  const tile = (html: string): string => html.slice(html.indexOf(">Investments<"), html.indexOf("</dd>", html.indexOf(">Investments<")));

  it("reads a dash while no history page has answered", () => {
    const page = toDashboardMock(liveDashboard({ activity: null }), { complete: false });
    expect(page.stats.investments).toBeNull();
    const html = renderToStaticMarkup(createElement(TooltipProvider, null, createElement(PensionStats, { stats: page.stats, days: page.days, now: page.now, mode: "profit" })));
    expect(tile(html)).toContain(`>${UNKNOWN}</span>`);
    expect(tile(html)).not.toMatch(/>0</);
  });

  it("counts the buys once a page has answered", () => {
    const page = toDashboardMock(liveDashboard(), { complete: false });
    expect(page.stats.investments).toBe(0);
    const html = renderToStaticMarkup(createElement(TooltipProvider, null, createElement(PensionStats, { stats: page.stats, days: page.days, now: page.now, mode: "profit" })));
    expect(tile(html)).toContain(">0</span>");
  });
});

/**
 * A LABEL AND A FIGURE, NOTHING UNDER THEM (owner, 10-23: "títulos simples y
 * concisos"). No tile keeps a sub line, in the sample or on a live page; what a
 * reader needs went into the label, and a live figure taken over the loaded
 * pages says so on hover only.
 */
describe("the stat tiles", () => {
  const stats = (props: Parameters<typeof PensionStats>[0]): string => renderToStaticMarkup(createElement(TooltipProvider, null, createElement(PensionStats, props)));
  const labels = (html: string): string[] => [...html.matchAll(/<dt[^>]*>([^<]*)<\/dt>/g)].map((match) => match[1]!);
  /** Each tile's title on its figure, by label. */
  const titles = (html: string): Record<string, string | null> =>
    Object.fromEntries([...html.matchAll(/<dt[^>]*>([^<]*)<\/dt><dd([^>]*)>/g)].map((match) => [match[1]!, /title="([^"]*)"/.exec(match[2]!)?.[1] ?? null]));

  it("are a label and a figure each, in the sample", () => {
    const html = stats({ stats: mock.stats, days: mock.days, now: mock.now, ...(mock.rule.mode === undefined ? {} : { mode: mock.rule.mode }) });
    expect(labels(html)).toEqual(["This week", "Avg per trade", "Volume", "Biggest save", "Streak", "Investments", "Active days", "Yearly pace"]);
    expect(html.match(/<dd/g)).toHaveLength(8);
    expect(html).not.toContain("text-xs text-muted-foreground");
  });

  it("are a label and a figure each on a live page, the loaded-history note on hover", () => {
    const page = toDashboardMock(liveDashboard(), { complete: false });
    const html = stats({ stats: page.stats, days: page.days, now: page.now, mode: "profit" });
    expect(html.match(/<dd/g)).toHaveLength(labels(html).length);
    expect(html.replace(/<[^>]+>/g, " ")).not.toContain("loaded history");
    expect(titles(html)["Biggest save"]).toBe("at today&#x27;s SOL price · in the loaded history");
    expect(titles(html)["Investments"]).toBe("in the loaded history");
    // Every label short enough for one line in a 375 px phone's two-column tile.
    expect(labels(html)).toContain("Avg settlement");
  });

  it("say nothing about the loaded history once every page is loaded", () => {
    const page = toDashboardMock(liveDashboard(), { complete: true });
    const html = stats({ stats: page.stats, days: page.days, now: page.now, mode: "profit" });
    expect(html).not.toContain("loaded history");
    expect(titles(html)["Investments"]).toBeNull();
  });
});
