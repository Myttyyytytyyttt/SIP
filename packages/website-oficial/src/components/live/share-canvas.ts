/**
 * THE SHARE CARD, DRAWN (owner, 10-22): Canvas 2D, in the browser, into a PNG —
 * the words over one of the films' plates. What the dialog shows is the same
 * words over the same plate, so what is posted is what was seen.
 *
 * BROWSER ONLY. Nothing here runs while a page renders: ShareSavings loads the
 * dialog that calls it on first open, and every call is from an effect or a
 * click. The words and the layout's arithmetic are src/lib/live-share.ts's;
 * this file only paints.
 *
 * THE BACKGROUND IS A PLATE'S FRAME 0 (owner, 10-22: "que las imágenes tengan
 * movimientos"). The films made three animated backgrounds (src/lib/
 * share-plates.ts); the still image is drawn on the first frame of the same
 * loop the video moves, so the PNG and the MP4 open on one picture. The three
 * hand-drawn backgrounds this file used to paint are gone. A plate that does not
 * arrive (offline in the middle of a dialog) leaves the card's dark ground and
 * every word on it, rather than no image: the preview's own copy of the plate
 * did not arrive either, so the picture still matches what was seen, and 400
 * lines of art kept for that moment alone would be 400 lines nobody looks at.
 *
 * THE WORDS ARE THEIR OWN LAYER (drawCardWords): over the still for the PNG,
 * over each decoded frame for the video (live/share-video.ts), and as a
 * transparent PNG over the plate's own <video> for the dialog's moving
 * preview. One drawing, three uses. No scrim under them: the plates keep their
 * text zone (x 64–720) dark and still — measured rgb(10,12,17–18), the card's
 * own ground — and put their motion right of x = 720.
 *
 * FONTS: the page's own Geist faces, which next/font serves, so the card is set
 * in the app's type. A canvas does not wait for a font: with `display: swap`,
 * drawing before the face loaded draws the fallback, so the faces are loaded by
 * name first (cardFonts).
 *
 * FIXED SCALE, NOT devicePixelRatio: every image is 2400×1260 (SHARE_SCALE),
 * so what is posted never depends on whose screen it was made on; the video is
 * the card at 1×, the plates' size. shadowBlur is in device pixels — the
 * transform does not scale it — so every blur is multiplied by the scale by
 * hand. No ctx.filter: Safari has long lacked it.
 *
 * THE NUMBER RULE (the app's <Num>): in a line of words, every number is Geist
 * Mono at the same size; words are Geist.
 *
 * THE SAMPLE'S CARD SAYS "Example" ON ITSELF (owner, 10-22), twice: the docs
 * clips' pill at the top-right corner, the day moved beside it; and the title
 * over the figure, "Example pension" where a pension's card says "My pension"
 * (review, 10-22: a crop of the title and the figure must keep the mark).
 * Nothing on it says "my" (SHARE_COPY.example.card). A card of a Live page has
 * neither (`example` is false on it). The line that used to say "Example
 * numbers. Nobody's pension." under the figure went with every card's note
 * (owner, 10-22: nothing under the money).
 */

import { MARK_H, MARK_PIECES, MARK_W } from "@/lib/brand-mark";
import { SHARE_COPY } from "@/lib/live-copy";
import { SHARE_CARD, SHARE_SCALE, fitHero, heroPadX, heroUnitGap, heroUnitSize, shareHero, shareRows, type ShareBackground, type ShareCardData, type ShareUnit } from "@/lib/live-share";
import { SHARE_PLATES } from "@/lib/share-plates";

const W = SHARE_CARD.width;
const H = SHARE_CARD.height;
const PAD = 64;

/**
 * The card's inks. The quietest text is 55 % white (about 6:1 on the ground):
 * 40 % was about 3.8:1, and at a phone's timeline width — the card ~300 px wide
 * — the date all but went (review, 10-22).
 */
const C = {
  ground: "#0A0B11",
  fg: "#FAFAFA",
  fg55: "rgba(255,255,255,0.55)",
  fg10: "rgba(255,255,255,0.10)",
  /** emerald-400: the app's "saved". */
  emerald: "#34d399",
  /** emerald-950: the figure on the block, ~11:1 on emerald-400. */
  ink: "#022c22",
} as const;

export interface CardFonts {
  readonly sans: string;
  readonly mono: string;
}

export interface DrawOptions {
  readonly unit: ShareUnit;
  /** Device pixels per logical pixel: SHARE_SCALE for the image and the preview's words, 1 for the video. */
  readonly scale: number;
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

let fontsOnce: Promise<CardFonts> | null = null;

/**
 * THE PAGE'S OWN FACES, BY THE NAMES next/font GAVE THEM. layout.tsx puts
 * --font-sans and --font-mono on <html> ('"Geist", "Geist Fallback"' on Next
 * 16; older versions hashed the family, so it is read, never written here).
 * Measured on a dev server: document.fonts.check() is false for them until an
 * explicit load(), even preloaded. A face that will not load leaves its
 * fallback — the card is drawn either way.
 */
export function cardFonts(): Promise<CardFonts> {
  fontsOnce ??= (async () => {
    const root = getComputedStyle(document.documentElement);
    const sans = `${root.getPropertyValue("--font-sans").trim() || "ui-sans-serif"}, system-ui, sans-serif`;
    const mono = `${root.getPropertyValue("--font-mono").trim() || "ui-monospace"}, ui-monospace, monospace`;
    try {
      await Promise.all([400, 500, 600].flatMap((weight) => [document.fonts.load(`${weight} 40px ${sans}`), document.fonts.load(`${weight} 40px ${mono}`, "$0123456789.,%<SOL")]));
      await document.fonts.ready;
    } catch {
      // Drawn in the fallback rather than not at all.
    }
    return { sans, mono };
  })();
  return fontsOnce;
}

const stills = new Map<ShareBackground, Promise<ImageBitmap | null>>();

/**
 * A PLATE'S STILL, DECODED ONCE PER DIALOG'S LIFE (measured 10-22: 10–25 ms to
 * fetch and decode, the whole card 35–60 ms). Null when it does not arrive —
 * the card is then drawn on its ground (above) — and a failure is not kept, so
 * the next draw asks again.
 */
export function loadStill(background: ShareBackground): Promise<ImageBitmap | null> {
  let still = stills.get(background);
  if (still === undefined) {
    still = fetch(SHARE_PLATES[background].still)
      .then((response) => (response.ok ? response.blob() : Promise.reject(new Error(`still ${response.status}`))))
      .then((blob) => createImageBitmap(blob))
      .catch(() => {
        stills.delete(background);
        return null;
      });
    stills.set(background, still);
  }
  return still;
}

function canvasOf(scale: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(W * scale);
  canvas.height = Math.round(H * scale);
  return canvas;
}

/** The PNG of one card: the plate's still, and the words over it, at 2400×1260. */
export async function renderShareCard(card: ShareCardData, { background, unit }: { readonly background: ShareBackground; readonly unit: ShareUnit }): Promise<Blob> {
  const [fonts, still] = await Promise.all([cardFonts(), loadStill(background)]);
  const canvas = canvasOf(SHARE_SCALE);
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("no 2d canvas");
  drawShareCard(ctx, card, { unit, scale: SHARE_SCALE }, fonts, still);
  return canvasBlob(canvas);
}

/** The words alone, on a transparent 2400×1260 PNG: laid over the plate's <video> (and its thumbs) in the dialog. */
export async function renderShareWords(card: ShareCardData, unit: ShareUnit): Promise<Blob> {
  const fonts = await cardFonts();
  const canvas = canvasOf(SHARE_SCALE);
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("no 2d canvas");
  drawCardWords(ctx, card, { unit, scale: SHARE_SCALE }, fonts);
  return canvasBlob(canvas);
}

/** canvas.toBlob as a promise; a null blob (a canvas too big for this device) is a failure, never an empty image. */
export function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob === null ? reject(new Error("the canvas gave no image")) : resolve(blob)), "image/png");
  });
}

/** The whole card on a context `options.scale` times its logical size: the plate's still (or the bare ground), then the words. */
export function drawShareCard(ctx: Ctx, card: ShareCardData, options: DrawOptions, fonts: CardFonts, still: CanvasImageSource | null): void {
  ctx.save();
  ctx.setTransform(options.scale, 0, 0, options.scale, 0, 0);
  ctx.fillStyle = C.ground;
  ctx.fillRect(0, 0, W, H);
  if (still !== null) ctx.drawImage(still, 0, 0, W, H);
  ctx.restore();
  drawCardWords(ctx, card, options, fonts);
}

// ── type ─────────────────────────────────────────────────────────────────────

function font(ctx: Ctx, weight: number, size: number, family: string, tracking = "0px"): void {
  ctx.font = `${weight} ${size}px ${family}`;
  // Tracking only where the canvas has it: without it the words are merely a little looser.
  if ("letterSpacing" in ctx) ctx.letterSpacing = tracking;
}

/** A number run: a digit with what sticks to it ($ , . %), ending on a digit or %. "Sep 18, 2026" keeps its comma in Geist. */
const NUMBER_RUN = /(\$?\d(?:[\d,.]*\d)?%?)/;

/** Words in Geist, every number in Geist Mono at the same size (<Num>). Returns the width drawn. */
function runs(ctx: Ctx, fonts: CardFonts, x: number, y: number, text: string, size: number, weight: number, color: string): number {
  ctx.fillStyle = color;
  let at = x;
  // split() with one capturing group alternates: words at even places, numbers at odd ones.
  text.split(NUMBER_RUN).forEach((part, index) => {
    if (part === "") return;
    const isNumber = index % 2 === 1;
    font(ctx, weight, size, isNumber ? fonts.mono : fonts.sans, isNumber ? `${-0.02 * size}px` : "0px");
    ctx.fillText(part, at, y);
    at += ctx.measureText(part).width;
  });
  return at - x;
}

// ── the mark ─────────────────────────────────────────────────────────────────

/** The S as one path — all seven pieces, filled nonzero, so no seam shows between them. */
function markPath(ctx: Ctx, x: number, y: number, height: number): void {
  const s = height / MARK_H;
  ctx.beginPath();
  for (const piece of MARK_PIECES) {
    piece.forEach(([px, py], index) => (index === 0 ? ctx.moveTo(x + px * s, y + py * s) : ctx.lineTo(x + px * s, y + py * s)));
    ctx.closePath();
  }
}

// ── the words and the figure ─────────────────────────────────────────────────

/** The emerald block the figure sits on: a gradient, a glow, and a lit top edge. */
function block(ctx: Ctx, scale: number, x: number, y: number, w: number, h: number): void {
  ctx.save();
  ctx.shadowColor = "rgba(16,185,129,0.45)";
  ctx.shadowBlur = 28 * scale;
  const fill = ctx.createLinearGradient(x, y, x + w, y + h);
  fill.addColorStop(0, "#3fe0a8");
  fill.addColorStop(1, "#10b981");
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 18);
  ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 18);
  ctx.clip();
  const lit = ctx.createLinearGradient(0, y, 0, y + h * 0.5);
  lit.addColorStop(0, "rgba(255,255,255,0.22)");
  lit.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = lit;
  ctx.fillRect(x, y, w, h * 0.5);
  ctx.restore();
}

/**
 * THE "Example" PILL, at the top-right corner of the sample's card: the docs
 * clips' label — a quiet capsule, an info ring, the word — set larger than
 * anything else up there. Where a phone's timeline shows the card ~350 px wide
 * its 28 px word is ~8 px, where the day beside it is ~5 px. Centred on the
 * lockup's line; returns its left edge, so the day can stand beside it.
 */
const PILL = { height: 52, text: 28, icon: 26, padLeft: 15, gap: 10, padRight: 22 } as const;

function examplePill(ctx: Ctx, fonts: CardFonts, scale: number, right: number, mid: number): number {
  font(ctx, 500, PILL.text, fonts.sans, "0px");
  const word = SHARE_COPY.example.mark;
  const width = PILL.padLeft + PILL.icon + PILL.gap + ctx.measureText(word).width + PILL.padRight;
  const x = right - width;
  const top = mid - PILL.height / 2;
  // A ground of its own first, so the art behind the corner never shows through the word.
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = 16 * scale;
  ctx.fillStyle = "rgba(14,15,21,0.86)";
  ctx.beginPath();
  ctx.roundRect(x, top, width, PILL.height, PILL.height / 2);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = "rgba(255,255,255,0.06)";
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  // lucide Info, on a 24-unit box.
  ctx.save();
  ctx.translate(x + PILL.padLeft, mid - PILL.icon / 2);
  ctx.scale(PILL.icon / 24, PILL.icon / 24);
  ctx.strokeStyle = "rgba(255,255,255,0.80)";
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(12, 12, 10, 0, Math.PI * 2);
  ctx.stroke();
  ctx.stroke(new Path2D("M12 16v-4M12 8h.01"));
  ctx.restore();
  ctx.fillStyle = "rgba(255,255,255,0.90)";
  const cap = ctx.measureText("E").actualBoundingBoxAscent;
  ctx.fillText(word, x + PILL.padLeft + PILL.icon + PILL.gap, mid + cap / 2);
  return x;
}

/**
 * THE LAYOUT, TOP TO BOTTOM (owner, 10-22: no label over the figure, no note
 * under it). The title and the figure are one group — the title is the
 * figure's label now — centred between the lockup (bottom at 86) and the
 * tallest stack of rows (three, their top at ~443): the title's baseline at
 * 186, the block's middle at 300. A smaller step shrinks the block about that
 * middle, so nothing else moves. The rows stay anchored to the footer.
 */
export const TITLE_Y = 186;
export const BAND_MID = 300;
/** The rows' last baseline, and the step between rows. */
export const ROWS_Y = 534;
const ROW_STEP = 38;

export function drawCardWords(ctx: Ctx, card: ShareCardData, options: DrawOptions, fonts: CardFonts): void {
  const { scale } = options;
  ctx.save();
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";

  // 1. The lockup top-left, the snapshot's day top-right — and on the sample's card, the "Example" pill in the corner, the day beside it.
  const markH = 34;
  markPath(ctx, PAD, 52, markH);
  ctx.fillStyle = C.fg;
  ctx.fill();
  font(ctx, 600, 30, fonts.sans, "-0.6px");
  ctx.fillText(SHARE_COPY.card.brand, PAD + (markH * MARK_W) / MARK_H + 12, 79.5);
  const dayRight = card.example ? examplePill(ctx, fonts, scale, W - PAD, 52 + markH / 2) - 20 : W - PAD;
  font(ctx, 400, 18, fonts.mono);
  ctx.fillStyle = C.fg55;
  ctx.textAlign = "right";
  ctx.fillText(card.asOf, dayRight, 75.5);
  ctx.textAlign = "left";

  const hero = shareHero(card, options.unit);
  // A pension's own words, or — on the sample's card — the example's, which are nobody's.
  const own = card.example ? SHARE_COPY.example.card : SHARE_COPY.card;

  // 2. The title: the figure's label.
  font(ctx, 500, 44, fonts.sans, "-0.9px");
  ctx.fillStyle = C.fg;
  const title = hero === null ? own.titleZero : own.titleSaved;
  ctx.fillText(title, PAD, TITLE_Y);
  if (hero !== null && card.since !== null) {
    const titleWidth = ctx.measureText(title).width;
    runs(ctx, fonts, PAD + titleWidth + 16, TITLE_Y, SHARE_COPY.card.since(card.since), 26, 400, C.fg55);
  }

  // 3. The figure on its block, and nothing under it.
  const measure = (text: string, size: number, part: "number" | "unit"): number => {
    font(ctx, 600, size, fonts.mono, part === "number" ? `${-0.02 * size}px` : "0px");
    return ctx.measureText(text).width;
  };

  if (hero === null) {
    // NOTHING SAVED YET: the rule itself is the hero, with the landing's words beside it — and, paused, no claim that anything is put aside.
    const [line1, line2] = [own.zeroMeasure[card.mode], card.paused ? SHARE_COPY.card.zeroPaused : SHARE_COPY.card.zeroAside];
    font(ctx, 500, 32, fonts.sans, "-0.5px");
    const beside = 28 + Math.max(ctx.measureText(line1).width, ctx.measureText(line2).width);
    const fit = fitHero([card.rate], null, beside, measure);
    const h = Math.round(fit.size * 1.25);
    const top = BAND_MID - h / 2;
    block(ctx, scale, PAD, top, fit.blockWidth, h);
    font(ctx, 600, fit.size, fonts.mono, `${-0.02 * fit.size}px`);
    ctx.fillStyle = C.ink;
    const cap = ctx.measureText("0").actualBoundingBoxAscent;
    ctx.fillText(fit.text, PAD + heroPadX(fit.size), top + h / 2 + cap / 2);
    font(ctx, 500, 32, fonts.sans, "-0.5px");
    const tx = PAD + fit.blockWidth + 28;
    ctx.fillStyle = C.fg;
    ctx.fillText(line1, tx, BAND_MID - 6);
    ctx.fillStyle = C.fg55;
    ctx.fillText(line2, tx, BAND_MID + 34);
  } else {
    const fit = fitHero([hero.number, hero.compact], hero.unit, 0, measure);
    const h = Math.round(fit.size * 1.25);
    const top = BAND_MID - h / 2;
    block(ctx, scale, PAD, top, fit.blockWidth, h);
    font(ctx, 600, fit.size, fonts.mono, `${-0.02 * fit.size}px`);
    ctx.fillStyle = C.ink;
    const cap = ctx.measureText("0").actualBoundingBoxAscent;
    const baseline = top + h / 2 + cap / 2;
    const x = PAD + heroPadX(fit.size);
    ctx.fillText(fit.text, x, baseline);
    if (hero.unit !== null) {
      font(ctx, 600, heroUnitSize(fit.size), fonts.mono);
      ctx.fillStyle = "rgba(2,44,34,0.72)";
      ctx.fillText(hero.unit, x + fit.numberWidth + heroUnitGap(fit.size), baseline);
    }
  }

  // 4. The rows, anchored at the bottom: the last one's baseline is always ROWS_Y.
  const rows = shareRows(card);
  rows.forEach((row, index) => {
    const y = ROWS_Y - ROW_STEP * (rows.length - 1 - index);
    font(ctx, 400, 21, fonts.sans);
    ctx.fillStyle = C.fg55;
    ctx.fillText(row.label, PAD, y);
    const width = runs(ctx, fonts, PAD + 150, y, row.value, 21, 500, C.fg);
    if (row.after !== undefined) runs(ctx, fonts, PAD + 150 + width, y, row.after, 21, 500, C.fg55);
  });

  // 5. The footer: the site and the eyebrow. Its right side is left empty on purpose — a referral link goes there later.
  ctx.fillStyle = C.fg10;
  ctx.fillRect(PAD, 562, W - PAD * 2, 1);
  font(ctx, 500, 19, fonts.mono);
  ctx.fillStyle = C.emerald;
  ctx.fillText(SHARE_COPY.card.site, PAD, 594);
  const siteWidth = ctx.measureText(SHARE_COPY.card.site).width;
  font(ctx, 400, 19, fonts.sans);
  ctx.fillStyle = C.fg55;
  ctx.fillText(SHARE_COPY.card.tagline, PAD + siteWidth + 20, 594);
  ctx.restore();
}
