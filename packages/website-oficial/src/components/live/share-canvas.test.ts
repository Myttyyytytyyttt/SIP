// THE "Example" MARK IS PAINTED ON THE SAMPLE'S CARD AND ON NO OTHER (owner,
// 10-22: "en el mock también puede aparecer pero con los datos del mock claro").
// The words a card paints, read off a context that records every fillText: node
// has no canvas, and what is checked here is WHAT is painted and where, not how
// it looks (the PNGs themselves are looked at in Chrome).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { drawShareCard } from "@/components/live/share-canvas";
import { SHARE_COPY } from "@/lib/live-copy";
import { toDashboardMock } from "@/lib/live-mock";
import { SHARE_BACKGROUNDS, SHARE_CARD, exampleShareCardOf, shareCardOf, type ShareCardData } from "@/lib/live-share";

import { liveDashboard, liveSnapshot } from "../../../test/fixtures/live-dashboard";

interface Painted {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly align: string;
}

/** A 2D context that does nothing but remember the words painted on it. Text is 10 px a character, 10 px tall. */
function recording(): { ctx: CanvasRenderingContext2D; painted: Painted[] } {
  const painted: Painted[] = [];
  const state: Record<string, unknown> = { textAlign: "left" };
  const gradient = { addColorStop: () => undefined };
  const ctx = new Proxy(state, {
    get(target, prop: string) {
      if (prop === "fillText") return (text: string, x: number, y: number) => painted.push({ text, x, y, align: String(target.textAlign) });
      if (prop === "measureText") return (text: string) => ({ width: text.length * 10, actualBoundingBoxAscent: 10 });
      if (prop === "createLinearGradient" || prop === "createRadialGradient") return () => gradient;
      if (prop in target) return target[prop];
      return () => undefined;
    },
    set(target, prop: string, value: unknown) {
      target[prop] = value;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, painted };
}

beforeEach(() => {
  // The art's offscreen layers and the padlock's paths: shapes only, nothing to read.
  vi.stubGlobal("Path2D", class {
    roundRect(): void {}
  });
  vi.stubGlobal("document", { createElement: () => ({ width: 0, height: 0, getContext: () => recording().ctx }) });
});
afterEach(() => vi.unstubAllGlobals());

const FONTS = { sans: "Geist", mono: "Geist Mono" };

/** Every word a card paints, on every background, in both units. */
function paintedOf(card: ShareCardData): Painted[] {
  const all: Painted[] = [];
  for (const background of SHARE_BACKGROUNDS) {
    for (const unit of ["usd", "sol"] as const) {
      const { ctx, painted } = recording();
      drawShareCard(ctx, card, { background, unit, scale: 1 }, FONTS);
      all.push(...painted);
    }
  }
  return all;
}

const page = toDashboardMock(liveDashboard(), { complete: false });
const liveCard = (lifetimeSaved: bigint | null, data = page): ShareCardData => shareCardOf({ lifetimeSaved, stats: data.stats, rule: data.rule, now: data.now });
const noPrice = toDashboardMock(liveDashboard({ snapshot: liveSnapshot({ prices: null }) }), { complete: false });

describe("the Example mark", () => {
  it("is on no Live page's card: saved, nothing yet, no price — every background, both units", () => {
    for (const card of [liveCard(60_000_000n), liveCard(0n), liveCard(60_000_000n, noPrice)]) {
      const words = paintedOf(card).map((each) => each.text);
      expect(words.length).toBeGreaterThan(10);
      expect(words).not.toContain(SHARE_COPY.example.mark);
      expect(words.join("\n")).not.toMatch(/example|nobody/i);
      // The day keeps its corner.
      expect(paintedOf(card).find((each) => each.text === card.asOf)).toMatchObject({ x: SHARE_CARD.width - 64, align: "right" });
    }
  });

  it("is on the example's card twice — the pill at the corner, the notice under the figure — every background, both units", () => {
    const card = exampleShareCardOf({ stats: page.stats, rule: page.rule, now: page.now });
    for (const background of SHARE_BACKGROUNDS) {
      for (const unit of ["usd", "sol"] as const) {
        const { ctx, painted } = recording();
        drawShareCard(ctx, card, { background, unit, scale: 1 }, FONTS);
        const mark = painted.find((each) => each.text === SHARE_COPY.example.mark);
        const day = painted.find((each) => each.text === card.asOf);
        expect(mark, `${background} ${unit}`).toBeDefined();
        // In the header's line, at the right; the day stands to its left, never under it.
        expect(mark!.y).toBeLessThan(100);
        expect(mark!.x).toBeGreaterThan(SHARE_CARD.width / 2);
        expect(day!.align).toBe("right");
        expect(day!.x).toBeLessThan(mark!.x);
        expect(painted.map((each) => each.text)).toContain(SHARE_COPY.example.note);
        // The sample's figure, in dollars, whichever unit was asked for.
        expect(painted.map((each) => each.text)).toContain(card.usdText);
      }
    }
  });
});

/**
 * NOBODY'S PENSION SAYS NO "MY" (review, 10-22): the example's card was titled
 * "My pension since Jun 2026" right above "Nobody's pension", and a crop of the
 * title and the figure — the brag, as people post it — kept neither the corner's
 * pill nor the line under the number. The title now carries the mark itself.
 */
describe("the example's own words", () => {
  const FIRST_PERSON = /\bmy\b|\bI\b|\bI’|\bI'/i;
  const saved = exampleShareCardOf({ stats: page.stats, rule: page.rule, now: page.now });
  // Nothing yet: the sample never is, but its card would say so in the same voice.
  const zero = exampleShareCardOf({ stats: { ...page.stats, totalSavedUsd: 0 }, rule: page.rule, now: page.now });
  const zeroPaused = exampleShareCardOf({ stats: { ...page.stats, totalSavedUsd: 0 }, rule: { ...page.rule, paused: true }, now: page.now });

  it("says nothing in the first person — saved, nothing yet, paused — every background, both units, in either mode", () => {
    for (const card of [saved, zero, zeroPaused, { ...saved, mode: "profit" as const }, { ...zero, mode: "profit" as const }]) {
      const words = paintedOf(card).map((each) => each.text);
      expect(words.length).toBeGreaterThan(10);
      expect(words.join("\n")).not.toMatch(FIRST_PERSON);
    }
  });

  it("titles the figure as the example's, between the corner and the figure — where a crop of the brag keeps it", () => {
    for (const background of SHARE_BACKGROUNDS) {
      const { ctx, painted } = recording();
      drawShareCard(ctx, saved, { background, unit: "usd", scale: 1 }, FONTS);
      const title = painted.find((each) => each.text === SHARE_COPY.example.card.titleSaved);
      const figure = painted.find((each) => each.text === saved.usdText);
      expect(title?.text).toMatch(/^Example\b/);
      expect(title!.y).toBeGreaterThan(100);
      expect(title!.y).toBeLessThan(figure!.y);
    }
    const { ctx, painted } = recording();
    drawShareCard(ctx, zero, { background: "vault", unit: "usd", scale: 1 }, FONTS);
    expect(painted.map((each) => each.text)).toContain(SHARE_COPY.example.card.titleZero);
    expect(SHARE_COPY.example.card.titleZero).toMatch(/^Example\b/);
  });

  it("leaves a pension's card in its own voice", () => {
    const words = paintedOf(liveCard(60_000_000n)).map((each) => each.text);
    expect(words).toContain(SHARE_COPY.card.titleSaved);
    expect(paintedOf(liveCard(0n)).map((each) => each.text)).toContain(SHARE_COPY.card.titleZero);
  });
});
