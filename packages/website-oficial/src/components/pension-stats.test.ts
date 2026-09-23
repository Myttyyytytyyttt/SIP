// The days a save happened — now in the pension card's header — say how many
// weeks they span in the grammar a person would use.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SaveCalendar } from "@/components/pension-stats";
import { TooltipProvider } from "@/components/ui/tooltip";

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
