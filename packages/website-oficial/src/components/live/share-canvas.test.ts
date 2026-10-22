// WHAT THE CARD PAINTS, AND WHERE (owner, 10-22): the words over a plate's
// still, nothing around the figure but the figure, and the "Example" mark on
// the sample's card and on no other. The words a card paints, read off a context
// that records every call: node has no canvas, and what is checked here is WHAT
// is painted and where, not how it looks (the PNGs and MP4s themselves are
// looked at in Chrome, WebKit and Firefox).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ROWS_Y, TITLE_Y, drawCardWords, drawShareCard } from "@/components/live/share-canvas";
import { SHARE_COPY } from "@/lib/live-copy";
import { toDashboardMock } from "@/lib/live-mock";
import { SHARE_CARD, exampleShareCardOf, shareCardOf, type ShareCardData } from "@/lib/live-share";

import { liveDashboard, liveSnapshot } from "../../../test/fixtures/live-dashboard";

interface Painted {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly align: string;
}

/** A 2D context that does nothing but remember what was painted on it. Text is 10 px a character, 10 px tall. */
function recording(): { ctx: CanvasRenderingContext2D; painted: Painted[]; calls: { name: string; args: unknown[] }[] } {
  const painted: Painted[] = [];
  const calls: { name: string; args: unknown[] }[] = [];
  const state: Record<string, unknown> = { textAlign: "left" };
  const gradient = { addColorStop: () => undefined };
  const ctx = new Proxy(state, {
    get(target, prop: string) {
      if (prop === "fillText")
        return (text: string, x: number, y: number) => {
          painted.push({ text, x, y, align: String(target.textAlign) });
          calls.push({ name: prop, args: [text, x, y] });
        };
      if (prop === "measureText") return (text: string) => ({ width: text.length * 10, actualBoundingBoxAscent: 10 });
      if (prop === "createLinearGradient" || prop === "createRadialGradient") return () => gradient;
      if (prop in target) return target[prop];
      return (...args: unknown[]) => {
        calls.push({ name: prop, args });
      };
    },
    set(target, prop: string, value: unknown) {
      target[prop] = value;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, painted, calls };
}

beforeEach(() => {
  // The pill's icon path: a shape only, nothing to read.
  vi.stubGlobal("Path2D", class {});
});
afterEach(() => vi.unstubAllGlobals());

const FONTS = { sans: "Geist", mono: "Geist Mono" };
const UNITS = ["usd", "sol"] as const;

/** Every word a card paints, in both units. */
function paintedOf(card: ShareCardData): Painted[] {
  return UNITS.flatMap((unit) => {
    const { ctx, painted } = recording();
    drawShareCard(ctx, card, { unit, scale: 1 }, FONTS, null);
    return painted;
  });
}

const page = toDashboardMock(liveDashboard(), { complete: false });
const liveCard = (lifetimeSaved: bigint | null, data = page): ShareCardData => shareCardOf({ lifetimeSaved, stats: data.stats, rule: data.rule, now: data.now });
const noPrice = toDashboardMock(liveDashboard({ snapshot: liveSnapshot({ prices: null }) }), { complete: false });
const example = exampleShareCardOf({ stats: page.stats, rule: page.rule, now: page.now });

/** Every kind of card there is: a pension's — saved, nothing yet, paused, no price, dust, long streak — and the sample's. */
const EVERY_CARD: Readonly<Record<string, ShareCardData>> = {
  saved: liveCard(60_000_000n),
  zero: liveCard(0n),
  zeroPaused: { ...liveCard(0n), paused: true },
  paused: { ...liveCard(60_000_000n), paused: true, mode: "volume", rate: "2%" },
  noPrice: liveCard(60_000_000n, noPrice),
  dust: liveCard(1_000n),
  streak: { ...liveCard(11_420_734_512n), streakDays: 13, basket: ["SPYx", "ANTHROPIC", "NVDAx", "TSLAx"] },
  example,
  exampleZero: { ...example, state: "zero", usdText: null, usdCompact: null },
};

describe("the background", () => {
  it("is the plate's still, drawn first and at the card's size — the words over it", () => {
    const still = { still: true } as unknown as ImageBitmap;
    const { ctx, calls } = recording();
    drawShareCard(ctx, liveCard(60_000_000n), { unit: "usd", scale: 2 }, FONTS, still);
    const image = calls.findIndex((call) => call.name === "drawImage");
    expect(calls[image]?.args).toEqual([still, 0, 0, SHARE_CARD.width, SHARE_CARD.height]);
    // Only the ground under it, and every word after it.
    expect(calls.slice(0, image).map((call) => call.name)).not.toContain("fillText");
    expect(calls.slice(image).some((call) => call.name === "fillText")).toBe(true);
  });

  it("with no still (it did not arrive), the card's ground — and every word still on it", () => {
    const { ctx, calls, painted } = recording();
    drawShareCard(ctx, liveCard(60_000_000n), { unit: "usd", scale: 2 }, FONTS, null);
    expect(calls.map((call) => call.name)).not.toContain("drawImage");
    expect(calls.find((call) => call.name === "fillRect")?.args).toEqual([0, 0, SHARE_CARD.width, SHARE_CARD.height]);
    expect(painted.map((each) => each.text)).toEqual(paintedOf(liveCard(60_000_000n)).slice(0, painted.length).map((each) => each.text));
  });

  it("the words alone paint no ground: the layer the video and the preview lay over the plate is transparent", () => {
    for (const card of Object.values(EVERY_CARD)) {
      const { ctx, calls } = recording();
      drawCardWords(ctx, card, { unit: "usd", scale: 1 }, FONTS);
      expect(calls.map((call) => call.name)).not.toContain("drawImage");
      // Its rectangles are the block's lit edge and the footer's 1 px rule: never a ground over the card.
      for (const call of calls.filter((each) => each.name === "fillRect")) expect((call.args[2] as number) * (call.args[3] as number)).toBeLessThan((SHARE_CARD.width * SHARE_CARD.height) / 8);
    }
  });
});

/**
 * NOTHING AROUND THE FIGURE BUT THE FIGURE (owner, 10-22: "Quitamos en todas
 * las imágenes lo que está debajo del dinero: saved so far, value at sols price
 * today"): no label over the green block, no note under it — on a pension's
 * card in every state and on the sample's.
 */
describe("nothing around the figure", () => {
  const GONE = [/saved so far/i, /savings rule/i, /today’s SOL price/i, /valued at/i, /example numbers/i, /nobody/i, /only I control/i, /nothing yet/i];

  it("no \"SAVED SO FAR\", no rule label, no valuation, no sample's notice — every card, both units", () => {
    for (const [name, card] of Object.entries(EVERY_CARD)) {
      const words = paintedOf(card).map((each) => each.text);
      expect(words.length, name).toBeGreaterThan(5);
      for (const gone of GONE) expect(words.join("\n"), `${name} ${gone}`).not.toMatch(gone);
    }
  });

  it("between the title and the rows, only the figure — or, with nothing saved, the rate and its two lines", () => {
    for (const [name, card] of Object.entries(EVERY_CARD)) {
      for (const unit of UNITS) {
        const { ctx, painted } = recording();
        drawShareCard(ctx, card, { unit, scale: 1 }, FONTS, null);
        const between = painted.filter((each) => each.y > TITLE_Y && each.y < ROWS_Y - 3 * 38);
        const allowed =
          card.state === "saved"
            ? [card.usdText, card.usdCompact, card.solText, card.solCompact, "SOL"]
            : [card.rate, ...Object.values(SHARE_COPY.card.zeroMeasure), ...Object.values(SHARE_COPY.example.card.zeroMeasure), SHARE_COPY.card.zeroAside, SHARE_COPY.card.zeroPaused];
        for (const each of between) expect(allowed, `${name} ${unit}: "${each.text}" at ${each.y}`).toContain(each.text);
        expect(between.length, `${name} ${unit}`).toBeGreaterThan(0);
      }
    }
  });
});

describe("the Example mark", () => {
  it("is on no Live page's card: saved, nothing yet, no price — both units", () => {
    for (const card of [liveCard(60_000_000n), liveCard(0n), liveCard(60_000_000n, noPrice)]) {
      const words = paintedOf(card).map((each) => each.text);
      expect(words.length).toBeGreaterThan(10);
      expect(words).not.toContain(SHARE_COPY.example.mark);
      expect(words.join("\n")).not.toMatch(/example|nobody/i);
      // The day keeps its corner.
      expect(paintedOf(card).find((each) => each.text === card.asOf)).toMatchObject({ x: SHARE_CARD.width - 64, align: "right" });
    }
  });

  it("is on the example's card twice — the pill at the corner, and the title over the figure — both units", () => {
    for (const unit of UNITS) {
      const { ctx, painted } = recording();
      drawShareCard(ctx, example, { unit, scale: 1 }, FONTS, null);
      const mark = painted.find((each) => each.text === SHARE_COPY.example.mark);
      const day = painted.find((each) => each.text === example.asOf);
      expect(mark, unit).toBeDefined();
      // In the header's line, at the right; the day stands to its left, never under it.
      expect(mark!.y).toBeLessThan(100);
      expect(mark!.x).toBeGreaterThan(SHARE_CARD.width / 2);
      expect(day!.align).toBe("right");
      expect(day!.x).toBeLessThan(mark!.x);
      expect(painted.map((each) => each.text)).toContain(SHARE_COPY.example.card.titleSaved);
      // The sample's figure, in dollars, whichever unit was asked for.
      expect(painted.map((each) => each.text)).toContain(example.usdText);
    }
  });
});

/**
 * NOBODY'S PENSION SAYS NO "MY" (review, 10-22): the example's card was titled
 * "My pension since Jun 2026" right above "Nobody's pension", and a crop of the
 * title and the figure — the brag, as people post it — kept neither the corner's
 * pill nor the line under the number. The title carries the mark itself; and,
 * with every line under the figure gone (owner, 10-22), it is the mark nearest
 * the money.
 */
describe("the example's own words", () => {
  const FIRST_PERSON = /\bmy\b|\bI\b|\bI’|\bI'/i;
  // Nothing yet: the sample never is, but its card would say so in the same voice.
  const zero = exampleShareCardOf({ stats: { ...page.stats, totalSavedUsd: 0 }, rule: page.rule, now: page.now });
  const zeroPaused = exampleShareCardOf({ stats: { ...page.stats, totalSavedUsd: 0 }, rule: { ...page.rule, paused: true }, now: page.now });

  it("says nothing in the first person — saved, nothing yet, paused — both units, in either mode", () => {
    for (const card of [example, zero, zeroPaused, { ...example, mode: "profit" as const }, { ...zero, mode: "profit" as const }]) {
      const words = paintedOf(card).map((each) => each.text);
      expect(words.length).toBeGreaterThan(8);
      expect(words.join("\n")).not.toMatch(FIRST_PERSON);
    }
  });

  it("titles the figure as the example's, between the corner and the figure — where a crop of the brag keeps it", () => {
    const { ctx, painted } = recording();
    drawShareCard(ctx, example, { unit: "usd", scale: 1 }, FONTS, null);
    const title = painted.find((each) => each.text === SHARE_COPY.example.card.titleSaved);
    const figure = painted.find((each) => each.text === example.usdText);
    expect(title?.text).toMatch(/^Example\b/);
    expect(title!.y).toBeGreaterThan(100);
    expect(title!.y).toBeLessThan(figure!.y);
    expect(paintedOf(zero).map((each) => each.text)).toContain(SHARE_COPY.example.card.titleZero);
    expect(SHARE_COPY.example.card.titleZero).toMatch(/^Example\b/);
  });

  it("leaves a pension's card in its own voice", () => {
    expect(paintedOf(liveCard(60_000_000n)).map((each) => each.text)).toContain(SHARE_COPY.card.titleSaved);
    expect(paintedOf(liveCard(0n)).map((each) => each.text)).toContain(SHARE_COPY.card.titleZero);
  });
});
