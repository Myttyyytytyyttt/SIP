// The hero's subtitle (owner, 09-25): the rule is today's, the total is since
// the first save. A vault that switched mode saved under both, so the subtitle
// never claims the whole total for today's rule.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// recharts draws on a ResizeObserver, which node has none of.
vi.mock("@/components/pension-chart", () => ({ PensionChart: () => null }));

const { PensionPanel, heroWidth } = await import("@/components/pension-panel");
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

/**
 * THE SHARE SLOT (owner, 10-22; live/ShareSavings.tsx): a live page's share
 * button on the figure's own line, to its right. The sample passes nothing, and
 * its hero is byte for byte what it was — sample-golden.test.ts holds the whole
 * panel, and the landing's video is recorded from it.
 */
describe("the share slot", () => {
  const panel = (share?: Parameters<typeof PensionPanel>[0]["share"]): string =>
    renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(PensionPanel, { stats: mock.stats, curve: mock.curve, holdings: mock.holdings, days: mock.days, rule: mock.rule, now: mock.now, ...(share === undefined ? {} : { share }) }),
      ),
    );
  const FIGURE = /<p class="font-mono text-4xl font-semibold tracking-tight tabular-nums sm:text-5xl xl:short:text-4xl"[^>]*>[^<]*<\/p>/;

  it("puts the button right after the figure, on its line", () => {
    const html = panel(createElement("button", { "data-share-savings": "" }));
    expect(html).toMatch(new RegExp(`<div class="flex min-w-0 flex-wrap items-center gap-x-3">${FIGURE.source}<button data-share-savings=""></button></div>`));
  });

  it("is not there at all without `share`: the sample's figure stands alone", () => {
    const html = panel();
    expect(html).toMatch(FIGURE);
    expect(html).not.toContain("flex-wrap items-center gap-x-3");
    expect(html).not.toContain("data-share-savings");
  });
});

/**
 * A FIGURE TOO LONG TO SHARE ITS LINE WITH THE BUTTON (review, 10-22): the
 * chain's nine-decimal SOL, shown when no price was read, wrapped the button
 * under it and made the hero 32 px taller. Past HERO_FITS characters the
 * figure steps down a size on a line of the same height; the no-price SOL keeps
 * every digit, the ones past the fourth a size down.
 */
describe("a long figure beside the share button", () => {
  const LONG = "font-mono text-3xl leading-10 font-semibold tracking-tight tabular-nums sm:text-4xl sm:leading-12 xl:short:text-3xl xl:short:leading-10";
  const SHORT = "font-mono text-4xl font-semibold tracking-tight tabular-nums sm:text-5xl xl:short:text-4xl";
  const figureOf = (stats: Partial<typeof mock.stats>, share = true): string => {
    const html = renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(PensionPanel, {
          stats: { ...mock.stats, ...stats },
          curve: mock.curve,
          holdings: mock.holdings,
          days: mock.days,
          rule: mock.rule,
          now: mock.now,
          ...(share ? { share: createElement("button", { "data-share-savings": "" }) } : {}),
        }),
      ),
    );
    return html.match(/<p class="font-mono [^"]*"[^>]*>.*?<\/p>/)?.[0] ?? "";
  };

  it("counts a figure in characters of its own size, a tail at its step", () => {
    expect(heroWidth("$1,142.51", false)).toBe(9);
    expect(heroWidth("0.036612345 SOL", true)).toBeCloseTo(13);
    expect(heroWidth("0.06 SOL", true)).toBe(8);
  });

  it("keeps a realistic dollar figure at full size", () => {
    expect(figureOf({ totalSavedUsd: 1_142.51 })).toContain(`class="${SHORT}"`);
    expect(figureOf({ totalSavedUsd: 12_345.67 })).toContain(`class="${SHORT}"`);
  });

  it("steps a long one down, on a line of the same 40/48 px", () => {
    expect(figureOf({ totalSavedUsd: 123_504.57 })).toContain(`class="${LONG}"`);
  });

  it("no price: the chain's SOL, every digit, the tail a size down — and stepped down beside the button", () => {
    const figure = figureOf({ totalSavedUsd: null, totalSavedSol: "0.036612345", pricedToday: false });
    expect(figure).toContain(`class="${LONG}"`);
    expect(figure).toContain('<span>0.0366<span class="text-[0.6em] leading-none">12345</span> SOL</span>');
    expect(figureOf({ totalSavedUsd: null, totalSavedSol: "0.06", pricedToday: false })).toContain(`class="${SHORT}"`);
  });

  it("never on the sample, which has no button", () => {
    expect(figureOf({ totalSavedUsd: 123_504.57 }, false)).toContain(`class="${SHORT}"`);
  });
});
