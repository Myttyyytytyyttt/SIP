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

/**
 * THE PILL BESIDE "SAVED SO FAR" (owner, 10-09; live/use-arrivals.ts): in the
 * label's own 16 px line, always mounted while a live page passes `pulse`, so
 * the hero never changes height; faded out, and hidden from a screen reader,
 * when nothing just arrived. The sample passes nothing and keeps its bare label.
 */
describe("the hero's pill", () => {
  const panel = (pulse?: Parameters<typeof PensionPanel>[0]["pulse"]): string =>
    renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(PensionPanel, { stats: mock.stats, curve: mock.curve, holdings: mock.holdings, days: mock.days, rule: mock.rule, now: mock.now, ...(pulse === undefined ? {} : { pulse }) }),
      ),
    );
  const pill = { text: "+$0.43 saved · 14:32 UTC", title: "0.0043 SOL at today’s SOL price" };

  it("sits in the label's own line, with its words and what hovering says", () => {
    const html = panel({ pill, shown: true });
    expect(html).toMatch(/<div class="flex h-4 min-w-0 items-center gap-2"><p class="[^"]*shrink-0">Saved so far<\/p><span class="[^"]*opacity-100" title="0.0043 SOL at today’s SOL price">\+\$0.43 saved · 14:32 UTC<\/span><\/div>/);
    expect(html).toContain("motion-reduce:transition-none");
  });

  it("stays mounted, faded and unspoken, when it lapsed or nothing arrived yet", () => {
    expect(panel({ pill, shown: false })).toMatch(/<span class="[^"]*opacity-0" aria-hidden="true">\+\$0.43 saved · 14:32 UTC<\/span>/);
    expect(panel({ pill: null, shown: false })).toMatch(/<div class="flex h-4 min-w-0 items-center gap-2"><p class="[^"]*">Saved so far<\/p><span class="[^"]*opacity-0" aria-hidden="true"><\/span><\/div>/);
  });

  it("is not there at all without `pulse`: the sample's bare label", () => {
    const html = panel();
    expect(html).toContain('<p class="text-xs font-medium uppercase tracking-wide text-muted-foreground">Saved so far</p>');
    expect(html).not.toContain("h-4 min-w-0");
  });
});
