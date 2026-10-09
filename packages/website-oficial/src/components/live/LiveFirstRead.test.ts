// The first read, still in flight (LiveFirstRead.tsx): words from the start,
// how long after five seconds, "taking longer" after twenty and a Reload after
// forty-five — nothing ticking inside the region a screen reader is told about,
// and blocks that stand where the page's own cards will.

import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DashboardMain, PENSION_SLOT, RULE_SLOT } from "@/components/dashboard-main";
import { Elapsed, elapsedSeconds } from "@/components/live/Elapsed";
import { FIRST_READ_ELAPSED_MS, FIRST_READ_RELOAD_MS, FIRST_READ_SLOW_MS, LiveFirstRead, stillSlot } from "@/components/live/LiveFirstRead";
import { LIVE_COPY } from "@/lib/live-copy";

import { liveRegions, tickingInRegion } from "../../../test/live-regions";

const T = Date.UTC(2026, 9, 9, 12, 0, 0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T);
});
afterEach(() => vi.useRealTimers());

/** The screen as drawn `waited` ms after the wait began. */
const after = (waited: number): string => renderToStaticMarkup(createElement(LiveFirstRead, { since: T - waited }));

/** What a person reads: the markup without its tags. */
const seen = (html: string): string => html.replace(/<[^>]*>/g, "");

const RELOAD = new RegExp(`<button[^>]*>(?:(?!</button>)[\\s\\S])*${LIVE_COPY.firstRead.reloadPage}</button>`);

describe("what the line says, and when", () => {
  it("from the start: what it is doing, and no count yet", () => {
    const html = after(0);
    expect(seen(html)).toContain(LIVE_COPY.firstRead.reading);
    expect(seen(html)).not.toMatch(/· \d+ s/);
    expect(html).not.toContain(LIVE_COPY.firstRead.slow);
    expect(html).not.toMatch(RELOAD);
  });

  it("after five seconds, for how long — in whole seconds", () => {
    expect(seen(after(FIRST_READ_ELAPSED_MS - 1))).not.toMatch(/· \d+ s/);
    expect(seen(after(FIRST_READ_ELAPSED_MS))).toContain(LIVE_COPY.elapsed(5));
    expect(seen(after(8_900))).toContain(LIVE_COPY.elapsed(8));
  });

  it("after twenty, that it is taking longer than usual, in place of the first words", () => {
    expect(after(FIRST_READ_SLOW_MS - 1)).not.toContain(LIVE_COPY.firstRead.slow);
    const html = after(FIRST_READ_SLOW_MS);
    expect(seen(html)).toContain(LIVE_COPY.firstRead.slow);
    expect(seen(html)).not.toContain(LIVE_COPY.firstRead.reading);
    expect(seen(html)).toContain(LIVE_COPY.elapsed(20));
    expect(html).not.toMatch(RELOAD);
  });

  it("after forty-five, a Reload page button — exactly then", () => {
    expect(after(FIRST_READ_RELOAD_MS - 1)).not.toMatch(RELOAD);
    expect(after(FIRST_READ_RELOAD_MS)).toMatch(RELOAD);
  });

  it("counts from when the screen appeared when nobody says otherwise", () => {
    const html = renderToStaticMarkup(createElement(LiveFirstRead));
    expect(seen(html)).toContain(LIVE_COPY.firstRead.reading);
    expect(seen(html)).not.toMatch(/· \d+ s/);
  });
});

describe("for a screen reader", () => {
  it("the words' region, busy, under a fixed name that does not change with the words", () => {
    for (const waited of [0, FIRST_READ_SLOW_MS, FIRST_READ_RELOAD_MS]) {
      const regions = liveRegions(after(waited));
      expect(regions).toHaveLength(2);
      expect(regions[0]).toContain('aria-busy="true"');
      expect(regions[0]).toContain(`aria-label="${LIVE_COPY.reading}"`);
    }
  });

  /**
   * A BUSY REGION HOLDS ITS CHANGES BACK, so the news is said in a second one
   * beside it: not busy, there and empty from the first render, and filled
   * exactly twice — slower than usual at 20 s, the way out at 45 s.
   */
  it("says 'taking longer' and then the way out in a second region that is not busy, empty until then", () => {
    const spoken = (waited: number): { readonly tag: string; readonly words: string } => {
      const region = liveRegions(after(waited))[1]!;
      return { tag: region.match(/^<[^>]*>/)![0], words: seen(region) };
    };
    for (const waited of [0, FIRST_READ_SLOW_MS, FIRST_READ_RELOAD_MS]) {
      expect(spoken(waited).tag).toBe('<span role="status" class="sr-only">');
    }
    expect(spoken(0).words).toBe("");
    expect(spoken(FIRST_READ_SLOW_MS - 1).words).toBe("");
    expect(spoken(FIRST_READ_SLOW_MS).words).toBe(LIVE_COPY.firstRead.slowSpoken);
    expect(spoken(FIRST_READ_RELOAD_MS - 1).words).toBe(LIVE_COPY.firstRead.slowSpoken);
    expect(spoken(FIRST_READ_RELOAD_MS).words).toBe(LIVE_COPY.firstRead.reloadSpoken);
  });

  it("holds only words in its regions: the count and the Reload button sit beside them, the count hidden", () => {
    const html = after(FIRST_READ_RELOAD_MS + 3_000);
    expect(seen(html)).toContain(LIVE_COPY.elapsed(48));
    expect(tickingInRegion(html)).toBe(false);
    const regions = liveRegions(html);
    expect(seen(regions[0]!)).toBe(LIVE_COPY.firstRead.slow);
    for (const region of regions) expect(region).not.toMatch(/\d+ s\b/);
    expect(html).toMatch(new RegExp(`<span aria-hidden="true"[^>]*>${LIVE_COPY.elapsed(48)}</span>`));
  });

  /**
   * AT 375 px THE RELOAD BUTTON WRAPS under the words, so below sm the line
   * keeps room for both from the first paint, packed to the top: neither the
   * 20 s words nor the 45 s button moves the blocks under it.
   */
  it("keeps the line's height from the start, two lines below sm and one from sm up", () => {
    for (const waited of [0, FIRST_READ_RELOAD_MS]) {
      const line = after(waited).match(/^<div class="[^"]*"><div class="([^"]*)">/)?.[1] ?? "";
      expect(line.split(" ")).toEqual(expect.arrayContaining(["flex-wrap", "content-start", "min-h-16", "sm:min-h-7"]));
    }
    expect(after(0)).toContain('<div class="flex min-h-7 min-w-0 items-center gap-1.5 text-sm text-muted-foreground">');
  });

  it("hides the blocks, which say nothing", () => {
    const html = after(0);
    // Every skeleton block sits under an aria-hidden ancestor: the strip is one itself, the cards share one.
    expect(html).toMatch(/<div data-slot="skeleton" class="[^"]*h-9 w-full[^"]*" aria-hidden="true"/);
    expect(html).toMatch(/<div aria-hidden="true" class="grid /);
  });
});

describe("its shape is the page's", () => {
  /** DashboardMain's own classes, as it renders them. */
  const main = renderToStaticMarkup(createElement(DashboardMain, { strip: null, cards: createElement(Fragment) }));
  const classOf = (html: string, tag: string): string => html.match(new RegExp(`<${tag} class="([^"]*)"`))?.[1] ?? "";

  it("stands in DashboardMain's own column, as a div — never a second <main>", () => {
    const html = after(0);
    expect(classOf(html, "div")).toBe(classOf(main, "main"));
    expect(html).not.toContain("<main");
  });

  it("lays its cards in DashboardMain's own grid, in the rule and pension slots' order", () => {
    const html = after(0);
    const grid = main.match(/<div class="(grid [^"]*)"/)?.[1] ?? "";
    expect(grid).not.toBe("");
    expect(html).toContain(`class="${grid}"`);
    expect(html).toContain(stillSlot(RULE_SLOT));
    expect(html).toContain(stillSlot(PENSION_SLOT));
    expect(html.indexOf(stillSlot(RULE_SLOT))).toBeLessThan(html.indexOf(stillSlot(PENSION_SLOT)));
  });

  it("does not rise in: the real cards do, when they land", () => {
    expect(stillSlot(RULE_SLOT)).not.toMatch(/rise-/);
    expect(stillSlot(RULE_SLOT)).toContain("order-2");
    expect(after(0)).not.toContain("rise-");
  });

  it("has the strip, the hero, the chart, four tiles and three holdings", () => {
    const html = after(0);
    expect(html).toMatch(/class="[^"]*\bh-9 w-full\b/);
    expect(html).toMatch(/class="[^"]*\bh-12\b/);
    expect(html).toMatch(/class="[^"]*\bh-64 w-full sm:h-72\b/);
    expect(html.match(/h-16 w-full rounded-lg/g)).toHaveLength(4);
  });

  it("moves only for motion-safe: the blocks' pulse and the line's glyph", () => {
    const html = after(0);
    expect(html).toContain("motion-safe:animate-spin");
    expect(html).toContain("motion-safe:animate-pulse");
    expect(html).not.toMatch(/[\s"]animate-(?:spin|pulse)/);
  });

  it("shows no figure: nothing is known yet", () => {
    expect(seen(after(FIRST_READ_RELOAD_MS))).not.toMatch(/\$|SOL\b|\b0\.\d/);
  });
});

describe("Elapsed", () => {
  it("is whole seconds, rounded down, never below zero", () => {
    expect(elapsedSeconds(T, T)).toBe(0);
    expect(elapsedSeconds(T, T + 8_999)).toBe(8);
    expect(elapsedSeconds(T, T + 9_000)).toBe(9);
    expect(elapsedSeconds(T + 1_000, T)).toBe(0);
  });

  it("shows nothing before its moment, then the count — hidden from a screen reader", () => {
    expect(renderToStaticMarkup(createElement(Elapsed, { from: T - 4_000, after: 5_000 }))).toBe("");
    const html = renderToStaticMarkup(createElement(Elapsed, { from: T - 12_000, after: 5_000 }));
    expect(html).toContain('aria-hidden="true"');
    expect(seen(html)).toBe(LIVE_COPY.elapsed(12));
  });
});
