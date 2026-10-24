// The hero: the figure with nothing explained under it, the pill a live page
// adds beside its label, and the share button on its line.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// recharts draws on a ResizeObserver, which node has none of.
vi.mock("@/components/pension-chart", () => ({ PensionChart: () => null }));

const { PensionPanel, heroWidth } = await import("@/components/pension-panel");
const { TooltipProvider } = await import("@/components/ui/tooltip");
const { mock } = await import("@/mocks");
const { usd } = await import("@/lib/format");

const render = (mode: "profit" | "volume", rateBps: number): string =>
  renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(PensionPanel, { stats: { ...mock.stats, firstSaveAt: "2026-09-18T00:00:00.000Z" }, curve: mock.curve, holdings: mock.holdings, days: mock.days, rule: { ...mock.rule, mode, rateBps }, now: mock.now }),
    ),
  );

/**
 * NOTHING UNDER THE FIGURE (owner, 10-23: "quita esos textos que aparecen de
 * forma de subtítulo"). The line that said "Now 1% of every buy and sell ·
 * saving since Sep 18" is gone for either rule, with a first save on record.
 */
describe("the hero's figure", () => {
  it.each([
    ["volume", 100],
    ["profit", 2_500],
  ] as const)("has no line of explanation under it (%s)", (mode, rateBps) => {
    const html = render(mode, rateBps);
    expect(html).not.toContain('data-slot="card-description"');
    expect(html.replace(/<[^>]+>/g, "")).not.toMatch(/saving since|Now \d+%/);
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
 * THE SHARE SLOT (owner, 10-22; live/ShareSavings.tsx): the share button on the
 * figure's own line, to its right — a live page's, and since the same day the
 * sample's too, with its own example card (sample-share.test.ts). Without the
 * slot the figure stands alone, as the sample's did before; sample-golden.test.ts
 * holds the whole panel as the sample now renders it.
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
    // The sample's figure: marked for the header's tight bands (below).
    expect(html).toMatch(new RegExp(`<div class="flex min-w-0 flex-wrap items-center gap-x-3 w-max max-w-full" data-hero-row="tight">${FIGURE.source}<button data-share-savings=""></button></div>`));
  });

  it("is not there at all without `share`: the figure stands alone", () => {
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

  it("never without a button", () => {
    expect(figureOf({ totalSavedUsd: 123_504.57 }, false)).toContain(`class="${SHORT}"`);
  });

  it("the sample's own figure keeps its full size beside its button: its hero does not move", () => {
    expect(figureOf({})).toContain(`class="${SHORT}"`);
    expect(figureOf({})).toContain(`>${usd(mock.stats.totalSavedUsd)}</p>`);
  });
});

/**
 * THE HEADER'S TIGHT BANDS (review, 10-22; the rule is in globals.css): where
 * the header's row squeezes the figure's column, a figure that would wrap its
 * button there is drawn a step smaller by scale and the button stands beside it
 * out of the flow — so the row says which figures may be. Measured: beside the
 * sample's stats, with their gain, nine characters wrapped and seven never did;
 * beside a live page's, which have none, nine never did and ten did.
 */
describe("the header's tight bands", () => {
  const rowOf = (stats: Partial<typeof mock.stats>, share = true): string | null => {
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
    return html.match(/<div class="flex min-w-0 flex-wrap items-center gap-x-3[^"]*"[^>]*>/)?.[0] ?? null;
  };
  // Every figure here is 13 characters or fewer: its row says its own width (below).
  const TIGHT = '<div class="flex min-w-0 flex-wrap items-center gap-x-3 w-max max-w-full" data-hero-row="tight">';
  const PLAIN = '<div class="flex min-w-0 flex-wrap items-center gap-x-3 w-max max-w-full">';

  it("marks the sample's own figure, beside stats that carry a gain", () => {
    expect(mock.stats.unrealizedUsd).not.toBeNull();
    expect(rowOf({})).toBe(TIGHT);
  });

  it("leaves a figure that fits beside the button even there: seven characters and fewer beside a gain", () => {
    expect(rowOf({ totalSavedUsd: 415.7 })).toBe(PLAIN);
    expect(rowOf({ totalSavedUsd: 4.15 })).toBe(PLAIN);
  });

  it("beside a live page's stats, with no gain: nine characters fit, ten are marked", () => {
    expect(rowOf({ unrealizedUsd: null, totalSavedUsd: 1_142.51 })).toBe(PLAIN);
    expect(rowOf({ unrealizedUsd: null, totalSavedUsd: 12_345.67 })).toBe(TIGHT);
  });

  it("leaves a long figure as it was: it is a step down already", () => {
    expect(rowOf({ totalSavedUsd: 123_504.57 })).toBe(PLAIN);
  });

  it("has no row to mark without a button", () => {
    expect(rowOf({}, false)).toBeNull();
  });
});

/**
 * THE ROW SAYS ITS OWN WIDTH (10-23; ROW_EXACT in pension-panel.tsx). Chrome
 * reckons a wrapping flex row narrower than it lays out in, and with the line
 * under the figure gone nothing wider held the column open: the sample's
 * button wrapped under its figure at 1440, one of 24 widths. Up to 13
 * characters the row measures itself (swept: never wraps, nothing leaves the
 * card); from 14 it is the plain wrapping row, which may wrap the button but
 * never pushes the stats out.
 */
describe("the figure's row width", () => {
  const rowOf = (stats: Partial<typeof mock.stats>): string =>
    renderToStaticMarkup(
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
          share: createElement("button", { "data-share-savings": "" }),
        }),
      ),
    ).match(/<div class="flex min-w-0 flex-wrap items-center gap-x-3[^"]*"/)?.[0] ?? "";

  it("is the row's own up to 13 characters: the sample's, a live page's, a long dollar figure, a no-price SOL", () => {
    expect(rowOf({})).toContain("w-max max-w-full");
    expect(rowOf({ unrealizedUsd: null, totalSavedUsd: 29.82 })).toContain("w-max max-w-full");
    expect(rowOf({ unrealizedUsd: null, totalSavedUsd: 1_234_567.89 })).toContain("w-max max-w-full");
    expect(rowOf({ unrealizedUsd: null, totalSavedUsd: null, totalSavedSol: "1.234567890", pricedToday: false })).toContain("w-max max-w-full");
  });

  it("is the plain wrapping row from 14: $10M, or 10 SOL with no price read", () => {
    expect(rowOf({ unrealizedUsd: null, totalSavedUsd: 12_345_678.9 })).toBe('<div class="flex min-w-0 flex-wrap items-center gap-x-3"');
    expect(rowOf({ unrealizedUsd: null, totalSavedUsd: null, totalSavedSol: "12.345678901", pricedToday: false })).toBe('<div class="flex min-w-0 flex-wrap items-center gap-x-3"');
  });
});
