// The days a save happened — now in the pension card's header — say how many
// weeks they span in the grammar a person would use.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PensionStats, SaveCalendar } from "@/components/pension-stats";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UNKNOWN } from "@/lib/format";
import { toDashboardMock } from "@/lib/live-mock";

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
