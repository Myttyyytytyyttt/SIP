/**
 * THE SHARE CARD, DRAWN (owner, 10-22): Canvas 2D, in the browser, into a PNG.
 * What the person sees in the dialog is this PNG itself, so what they post is
 * exactly what they saw.
 *
 * BROWSER ONLY. Nothing here runs while a page renders: ShareSavings loads the
 * dialog that calls it on first open, and every call is from an effect or a
 * click. The words and the layout's arithmetic are src/lib/live-share.ts's;
 * this file only paints.
 *
 * NO IMAGES, NOTHING FETCHED. The S is drawn from its own numbers
 * (lib/brand-mark.ts), the backgrounds are procedural, and the only thing
 * waited on is the page's own Geist faces — which next/font serves, so the card
 * is set in the app's type. A canvas does not wait for a font: with
 * `display: swap`, drawing before the face loaded draws the fallback, so the
 * faces are loaded by name first (cardFonts).
 *
 * FIXED SCALE, NOT devicePixelRatio: every image is 2400×1260 (SHARE_SCALE),
 * so what is posted never depends on whose screen it was made on. The
 * previews draw the same card smaller (THUMB_SCALE). shadowBlur is in device
 * pixels — the transform does not scale it — so every blur is multiplied by
 * the scale by hand. No ctx.filter: Safari has long lacked it.
 *
 * THE NUMBER RULE (the app's <Num>): in a line of words, every number is Geist
 * Mono at the same size; words are Geist.
 */

import { MARK_H, MARK_H_LINES, MARK_PIECES, MARK_V_LINES, MARK_W } from "@/lib/brand-mark";
import { SHARE_COPY } from "@/lib/live-copy";
import {
  SHARE_CARD,
  fitHero,
  heroPadX,
  heroUnitGap,
  heroUnitSize,
  shareHero,
  shareRows,
  type ShareBackground,
  type ShareCardData,
  type ShareUnit,
} from "@/lib/live-share";

const W = SHARE_CARD.width;
const H = SHARE_CARD.height;
const PAD = 64;

const C = {
  ground: "#0A0B11",
  fg: "#FAFAFA",
  fg55: "rgba(255,255,255,0.55)",
  fg40: "rgba(255,255,255,0.40)",
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
  readonly background: ShareBackground;
  readonly unit: ShareUnit;
  /** Device pixels per logical pixel: SHARE_SCALE for the image, THUMB_SCALE for a preview. */
  readonly scale: number;
}

type Ctx = CanvasRenderingContext2D;

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

/** The PNG of one card. */
export async function renderShareCard(card: ShareCardData, options: DrawOptions): Promise<Blob> {
  const fonts = await cardFonts();
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(W * options.scale);
  canvas.height = Math.round(H * options.scale);
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("no 2d canvas");
  drawShareCard(ctx, card, options, fonts);
  return canvasBlob(canvas);
}

/** canvas.toBlob as a promise; a null blob (a canvas too big for this device) is a failure, never an empty image. */
export function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob === null ? reject(new Error("the canvas gave no image")) : resolve(blob)), "image/png");
  });
}

/** The whole card on a context `options.scale` times its logical size. */
export function drawShareCard(ctx: Ctx, card: ShareCardData, options: DrawOptions, fonts: CardFonts): void {
  ctx.save();
  ctx.setTransform(options.scale, 0, 0, options.scale, 0, 0);
  BACKGROUNDS[options.background](ctx, options.scale);
  // A legibility scrim under the words, for the backgrounds whose art reaches left.
  if (options.background !== "vault") {
    const scrim = ctx.createLinearGradient(0, 0, 760, 0);
    scrim.addColorStop(0, "rgba(10,11,17,0.70)");
    scrim.addColorStop(1, "rgba(10,11,17,0)");
    ctx.fillStyle = scrim;
    ctx.fillRect(0, 0, W, H);
  }
  drawContent(ctx, card, options, fonts);
  ctx.restore();
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

// ── backgrounds ──────────────────────────────────────────────────────────────

function radial(ctx: Ctx, x: number, y: number, r: number, stops: readonly (readonly [number, string])[], sy = 1): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(1, sy);
  const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
  for (const [offset, color] of stops) gradient.addColorStop(offset, color);
  ctx.fillStyle = gradient;
  ctx.fillRect(-W * 2, -H * 4, W * 4, H * 8);
  ctx.restore();
}

/** An offscreen layer at the card's scale, drawn back whole: for art that is masked before it lands. */
function layer(scale: number, draw: (l: Ctx) => void): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(W * scale);
  canvas.height = Math.round(H * scale);
  const l = canvas.getContext("2d");
  if (l === null) throw new Error("no 2d canvas");
  l.setTransform(scale, 0, 0, scale, 0, 0);
  draw(l);
  return canvas;
}

const DIAL = { x: 942, y: 318 } as const;

/** VAULT: the docs clips' dial — rings, a lit arc of ticks, and the padlock shut. */
function vault(ctx: Ctx): void {
  ctx.fillStyle = C.ground;
  ctx.fillRect(0, 0, W, H);
  radial(ctx, DIAL.x, DIAL.y, 400, [
    [0, "rgba(16,185,129,0.18)"],
    [0.5, "rgba(16,185,129,0.06)"],
    [1, "rgba(16,185,129,0)"],
  ]);
  ctx.lineWidth = 1;
  for (const [r, a] of [
    [236, 0.12],
    [292, 0.085],
    [360, 0.06],
    [444, 0.045],
    [540, 0.032],
    [650, 0.022],
  ] as const) {
    ctx.strokeStyle = `rgba(52,211,153,${a})`;
    ctx.beginPath();
    ctx.arc(DIAL.x, DIAL.y, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.strokeStyle = "rgba(52,211,153,0.16)";
  ctx.beginPath();
  ctx.arc(DIAL.x, DIAL.y, 214, 0, Math.PI * 2);
  ctx.stroke();
  // The lit arc, 150° round through the top to 330° (canvas degrees, clockwise from 3 o'clock).
  const A0 = (150 * Math.PI) / 180;
  const A1 = (330 * Math.PI) / 180;
  ctx.lineCap = "round";
  for (const [width, color] of [
    [34, "rgba(52,211,153,0.10)"],
    [8, "rgba(52,211,153,0.22)"],
  ] as const) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.arc(DIAL.x, DIAL.y, 190, A0, A1);
    ctx.stroke();
  }
  for (let i = 0; i < 72; i += 1) {
    const a = (i * 2 * Math.PI) / 72;
    const deg = i * 5;
    const lit = deg >= 150 && deg <= 330;
    const major = i % 6 === 0;
    const r0 = major ? 170 : 176;
    const r1 = major ? 208 : 202;
    ctx.lineWidth = major ? 2.6 : 1.8;
    ctx.strokeStyle = lit ? (major ? "rgba(110,231,183,0.95)" : "rgba(52,211,153,0.70)") : major ? "rgba(52,211,153,0.34)" : "rgba(52,211,153,0.16)";
    ctx.beginPath();
    ctx.moveTo(DIAL.x + Math.cos(a) * r0, DIAL.y + Math.sin(a) * r0);
    ctx.lineTo(DIAL.x + Math.cos(a) * r1, DIAL.y + Math.sin(a) * r1);
    ctx.stroke();
  }
  // The spark at the arc's moving end.
  const hx = DIAL.x + Math.cos(A1) * 190;
  const hy = DIAL.y + Math.sin(A1) * 190;
  radial(ctx, hx, hy, 34, [
    [0, "rgba(52,211,153,0.55)"],
    [1, "rgba(52,211,153,0)"],
  ]);
  ctx.fillStyle = "#ecfdf5";
  ctx.beginPath();
  ctx.arc(hx, hy, 5, 0, Math.PI * 2);
  ctx.fill();
  // The inner disc and its small ticks.
  const disc = ctx.createRadialGradient(DIAL.x, DIAL.y - 50, 0, DIAL.x, DIAL.y, 150);
  disc.addColorStop(0, "#181a22");
  disc.addColorStop(1, "#0d0e13");
  ctx.fillStyle = disc;
  ctx.beginPath();
  ctx.arc(DIAL.x, DIAL.y, 146, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = C.fg10;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.lineCap = "butt";
  for (let i = 0; i < 40; i += 1) {
    const a = (i * 2 * Math.PI) / 40;
    ctx.beginPath();
    ctx.moveTo(DIAL.x + Math.cos(a) * 128, DIAL.y + Math.sin(a) * 128);
    ctx.lineTo(DIAL.x + Math.cos(a) * 137, DIAL.y + Math.sin(a) * 137);
    ctx.stroke();
  }
  // The padlock, shut (lucide Lock), in emerald.
  ctx.save();
  ctx.translate(DIAL.x, DIAL.y);
  ctx.scale(3.4, 3.4);
  ctx.translate(-12, -12.4);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = C.emerald;
  ctx.lineWidth = 1.6;
  ctx.stroke(new Path2D("M7 11V7a5 5 0 0 1 10 0v4"));
  const body = new Path2D();
  body.roundRect(3, 11, 18, 11, 2.4);
  ctx.fillStyle = "#121319";
  ctx.fill(body);
  ctx.stroke(body);
  ctx.fillStyle = C.emerald;
  ctx.beginPath();
  ctx.arc(12, 15.6, 1.25, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 1.3;
  ctx.stroke(new Path2D("M12 16.6v2"));
  ctx.restore();
}

/** [offset across the streak's axis, width, rgb, peak alpha]. */
const STREAKS: readonly (readonly [number, number, string, number])[] = [
  [-60, 300, "16,185,129", 0.09],
  [210, 240, "59,130,246", 0.07],
  [-190, 84, "52,211,153", 0.2],
  [40, 54, "52,211,153", 0.26],
  [150, 30, "110,231,183", 0.32],
  [260, 96, "96,165,250", 0.16],
  [-130, 7, "167,243,208", 0.6],
  [12, 3, "236,253,245", 0.75],
  [118, 11, "52,211,153", 0.5],
  [196, 2, "236,253,245", 0.45],
  [318, 5, "191,219,254", 0.5],
  [-262, 3, "167,243,208", 0.35],
  [-30, 2, "236,253,245", 0.3],
];

/** STREAKS: the reference's light streaks, in the app's emerald ("saved") and blue ("invested"). */
function streaks(ctx: Ctx, scale: number): void {
  ctx.fillStyle = C.ground;
  ctx.fillRect(0, 0, W, H);
  radial(ctx, 1010, 90, 560, [
    [0, "rgba(16,185,129,0.16)"],
    [1, "rgba(16,185,129,0)"],
  ]);
  radial(ctx, 1180, 640, 440, [
    [0, "rgba(59,130,246,0.12)"],
    [1, "rgba(59,130,246,0)"],
  ]);
  const art = layer(scale, (l) => {
    l.translate(W / 2, H / 2);
    l.rotate((-34 * Math.PI) / 180);
    for (const [offset, width, rgb, alpha] of STREAKS) {
      const g = l.createLinearGradient(0, offset - width / 2, 0, offset + width / 2);
      g.addColorStop(0, `rgba(${rgb},0)`);
      g.addColorStop(0.5, `rgba(${rgb},${alpha})`);
      g.addColorStop(1, `rgba(${rgb},0)`);
      l.fillStyle = g;
      l.fillRect(-1400, offset - width / 2, 2800, width);
    }
    // Gone under the words, full on the right.
    l.setTransform(scale, 0, 0, scale, 0, 0);
    l.globalCompositeOperation = "destination-in";
    const mask = l.createLinearGradient(360, 0, 980, 0);
    mask.addColorStop(0, "rgba(0,0,0,0)");
    mask.addColorStop(1, "rgba(0,0,0,1)");
    l.fillStyle = mask;
    l.fillRect(0, 0, W, H);
  });
  ctx.drawImage(art, 0, 0, W, H);
}

/** GRID: the landing's blueprint, where ONE TILE IS THE S — the mark drawn on it has every edge on a line. */
function grid(ctx: Ctx, scale: number): void {
  ctx.fillStyle = C.ground;
  ctx.fillRect(0, 0, W, H);
  const TW = 280;
  const TH = (TW * MARK_H) / MARK_W;
  const cx = 930;
  const cy = 318;
  const sx = cx - TW / 2;
  const sy = cy - TH / 2;
  radial(ctx, cx, cy, 480, [
    [0, "rgba(16,185,129,0.26)"],
    [0.45, "rgba(16,185,129,0.08)"],
    [0.75, "rgba(16,185,129,0)"],
  ]);
  const art = layer(scale, (l) => {
    const hl = MARK_H_LINES.map((y) => (y / MARK_H) * TH);
    const vl = MARK_V_LINES.map((x) => (x / MARK_W) * TW);
    const ox = sx - TW * Math.ceil(sx / TW);
    const oy = sy - TH * Math.ceil(sy / TH);
    for (let ty = oy; ty < H; ty += TH) {
      for (let tx = ox; tx < W; tx += TW) {
        l.strokeStyle = "rgba(255,255,255,0.11)";
        l.lineWidth = 1;
        l.setLineDash([]);
        for (const x of vl) {
          l.beginPath();
          l.moveTo(tx + x, ty);
          l.lineTo(tx + x, ty + TH);
          l.stroke();
        }
        for (const y of hl) {
          l.beginPath();
          l.moveTo(tx, ty + y);
          l.lineTo(tx + TW, ty + y);
          l.stroke();
        }
        l.strokeStyle = "rgba(255,255,255,0.06)";
        l.setLineDash([5, 6]);
        l.beginPath();
        l.moveTo(tx, ty + TH * 0.18);
        l.lineTo(tx + TW * 0.82, ty + TH);
        l.stroke();
        l.setLineDash([]);
        l.fillStyle = "rgba(52,211,153,0.6)";
        for (const [x, y] of [
          [vl[1]!, hl[2]!],
          [vl[2]!, hl[5]!],
        ] as const) {
          l.beginPath();
          l.arc(tx + x, ty + y, 1.8, 0, Math.PI * 2);
          l.fill();
        }
      }
    }
    // The landing's mask: strongest at the glow, gone at the edges.
    l.save();
    l.globalCompositeOperation = "destination-in";
    l.translate(cx, cy);
    l.scale(1, 0.82);
    const mask = l.createRadialGradient(0, 0, 0, 0, 0, 640);
    mask.addColorStop(0, "rgba(0,0,0,1)");
    mask.addColorStop(0.45, "rgba(0,0,0,0.55)");
    mask.addColorStop(0.85, "rgba(0,0,0,0)");
    l.fillStyle = mask;
    l.fillRect(-W * 2, -H * 2, W * 4, H * 4);
    l.restore();
  });
  ctx.drawImage(art, 0, 0, W, H);
  // The S on its tile: a faint emerald body, a lit edge — the piece seams read as a blueprint.
  markPath(ctx, sx, sy, TH);
  const body = ctx.createLinearGradient(sx, sy, sx + TW, sy + TH);
  body.addColorStop(0, "rgba(52,211,153,0.16)");
  body.addColorStop(1, "rgba(16,185,129,0.04)");
  ctx.fillStyle = body;
  ctx.fill();
  ctx.save();
  ctx.shadowColor = "rgba(52,211,153,0.6)";
  ctx.shadowBlur = 9 * scale;
  ctx.strokeStyle = "rgba(110,231,183,0.55)";
  ctx.lineWidth = 1.5;
  ctx.lineJoin = "miter";
  ctx.stroke();
  ctx.restore();
}

const BACKGROUNDS: Readonly<Record<ShareBackground, (ctx: Ctx, scale: number) => void>> = { vault, streaks, grid };

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

/** The hero band's middle: a smaller step shrinks the block about it, so the note and the rows never move. */
const BAND_MID = 293;
const LABEL_Y = 210;
const NOTE_Y = 392;
const TITLE_Y = 158;

function drawContent(ctx: Ctx, card: ShareCardData, options: DrawOptions, fonts: CardFonts): void {
  const { scale } = options;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";

  // 1. The lockup top-left, the snapshot's day top-right.
  const markH = 34;
  markPath(ctx, PAD, 52, markH);
  ctx.fillStyle = C.fg;
  ctx.fill();
  font(ctx, 600, 30, fonts.sans, "-0.6px");
  ctx.fillText(SHARE_COPY.card.brand, PAD + (markH * MARK_W) / MARK_H + 12, 79.5);
  font(ctx, 400, 18, fonts.mono);
  ctx.fillStyle = C.fg40;
  ctx.textAlign = "right";
  ctx.fillText(card.asOf, W - PAD, 75.5);
  ctx.textAlign = "left";

  const hero = shareHero(card, options.unit);

  // 2. The title.
  font(ctx, 500, 44, fonts.sans, "-0.9px");
  ctx.fillStyle = C.fg;
  const title = hero === null ? SHARE_COPY.card.titleZero : SHARE_COPY.card.titleSaved;
  ctx.fillText(title, PAD, TITLE_Y);
  if (hero !== null && card.since !== null) {
    const titleWidth = ctx.measureText(title).width;
    runs(ctx, fonts, PAD + titleWidth + 16, TITLE_Y, SHARE_COPY.card.since(card.since), 26, 400, C.fg55);
  }

  // 3. The hero.
  font(ctx, 600, 15, fonts.sans, "1.8px");
  ctx.fillStyle = C.fg55;
  ctx.fillText((hero === null ? SHARE_COPY.card.labelZero : SHARE_COPY.card.labelSaved).toUpperCase(), PAD, LABEL_Y);

  const measure = (text: string, size: number, part: "number" | "unit"): number => {
    font(ctx, 600, size, fonts.mono, part === "number" ? `${-0.02 * size}px` : "0px");
    return ctx.measureText(text).width;
  };

  if (hero === null) {
    // NOTHING SAVED YET: the rule itself is the hero, with the landing's words beside it.
    const [line1, line2] = [SHARE_COPY.card.zeroMeasure[card.mode], SHARE_COPY.card.zeroAside];
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
    runs(ctx, fonts, PAD, NOTE_Y, SHARE_COPY.card.zeroNote, 18, 400, C.fg40);
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
    if (hero.note !== null) runs(ctx, fonts, PAD, NOTE_Y, hero.note, 18, 400, C.fg40);
  }

  // 4. The rows, anchored at the bottom: the last one's baseline is always 534.
  const rows = shareRows(card);
  rows.forEach((row, index) => {
    const y = 534 - 38 * (rows.length - 1 - index);
    font(ctx, 400, 21, fonts.sans);
    ctx.fillStyle = C.fg55;
    ctx.fillText(row.label, PAD, y);
    const width = runs(ctx, fonts, PAD + 150, y, row.value, 21, 500, row.muted === true ? C.fg55 : C.fg);
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
}
