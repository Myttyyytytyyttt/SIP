// The hero's subtitle (owner, 09-25): the rule is today's, the total is since
// the first save. A vault that switched mode saved under both, so the subtitle
// never claims the whole total for today's rule.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// recharts draws on a ResizeObserver, which node has none of.
vi.mock("@/components/pension-chart", () => ({ PensionChart: () => null }));

const { PensionPanel } = await import("@/components/pension-panel");
const { TooltipProvider } = await import("@/components/ui/tooltip");
const { mock } = await import("@/mocks");

const render = (mode: "profit" | "volume", rateBps: number): string =>
  renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(PensionPanel, { stats: { ...mock.stats, firstSaveAt: "2026-09-18T00:00:00.000Z" }, curve: mock.curve, holdings: mock.holdings, days: mock.days, rule: { ...mock.rule, mode, rateBps }, now: mock.now }),
    ),
  );

describe("the hero's subtitle", () => {
  it("says the rule is today's, and the date stands apart as when saving began", () => {
    const text = render("volume", 100).replace(/<[^>]+>/g, "");
    expect(text).toContain("Now 1% of every buy and sell · saving since Sep 18, 2026");
    expect(text).not.toMatch(/every buy and sell, since/);
  });

  it("names a profit rule the same way", () => {
    expect(render("profit", 2_500).replace(/<[^>]+>/g, "")).toContain("Now 25% of trading gains · saving since");
  });
});
