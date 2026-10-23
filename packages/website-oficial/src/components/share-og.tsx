/**
 * THE SHARE CARD, DRAWN ON THE SERVER — the preview X (and Telegram, Discord,
 * WhatsApp…) shows under a post of /c/<token> (owner, 10-22: "Enlace con vista
 * previa"). The same card the dialog draws in the browser (live/share-canvas.ts),
 * redrawn with next/og (Satori) at 1200×630 from the same SHARE_LAYOUT and
 * SHARE_INK (lib/live-share.ts), so the link's picture is the dialog's picture.
 *
 * ONLY FROM A TOKEN THE SERVER SIGNED. The routes that call this
 * (app/c/[token]/card.png, app/c/example/…) draw a card that lib/share-token.ts
 * verified, or the sample's own; nothing a URL merely says.
 *
 * THE BACKGROUND IS THE PLATE'S FRAME 0, like the dialog's still: a 1200×630
 * copy of each film's first frame (assets/share-og/plates, made by
 * `pnpm run share:plates`), so the still, the video and the preview open on
 * one picture.
 *
 * THE TYPE IS THE APP'S: Geist and Geist Mono at 400, 500 and 600, the static
 * TTFs of vercel/geist-font v1.7.1 (commit 8b8b75f, OFL-1.1, licence beside
 * them in assets/share-og/fonts) — Geist 1.800 as Google serves the page,
 * Geist Mono 1.700 where Google serves 1.701. Satori reads no woff2 and no
 * variable font, and next/og ships only Geist Regular, hence the copies.
 *
 * READ AT RUN TIME, WITHOUT THE NETWORK: from assets/share-og under the app's
 * directory (process.cwd(), like og-card.tsx), once per instance. A standalone
 * build carries only traced files, so next.config.mjs names that folder in
 * outputFileTracingIncludes for every route that draws a card.
 *
 * BASELINES, AS A CANVAS DRAWS THEM. Every y in SHARE_LAYOUT is a baseline;
 * Satori places a text box, and puts its baseline at the font's ascender plus
 * half the leading, rounded (lineHeight 1: 0.855 of the size in Geist). So
 * each line is a box whose top is its baseline less that offset. The figure's
 * width is exact without a canvas: Geist Mono is monospaced, every glyph 0.6
 * em, and the figure's tracking takes 0.02 em off each — fitHero picks the
 * same step here as in the browser. The zero card's two lines are measured once
 * (ZERO_LINE_WIDTHS) for the same reason.
 *
 * WHAT DIFFERS, MEASURED (review, 10-22: the dialog's PNG against this one,
 * Chrome and WebKit, 30 cards). The canvas now sets every line glyph by glyph
 * without kerning (share-canvas.ts), as Satori does: the tagline ends on the
 * same pixel, "since" within 2 px, the day within 3, and the block and the
 * figure within a pixel in both engines. What is left is inside a tracked
 * title: Satori sets its glyphs a little tighter — "pension" 149 px wide where
 * the canvas's is 153, so the sample's gap before it reads 20 px against 14.
 * Every baseline is within a pixel; the rest is two rasterisers' anti-aliasing.
 *
 * next/og draws with Satori: every box with more than one child says
 * `display: flex`, and only inline styles exist.
 */
import "server-only";

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ImageResponse } from "next/og";
import type { CSSProperties, ReactNode } from "react";

import { MARK_H, MARK_PIECES, MARK_W } from "@/lib/brand-mark";
import { SHARE_COPY } from "@/lib/live-copy";
import {
  SHARE_BACKGROUNDS,
  SHARE_CARD,
  SHARE_INK as C,
  SHARE_LAYOUT as L,
  bandMid,
  blockBox,
  fitHero,
  heroPadX,
  heroUnitGap,
  heroUnitSize,
  rowBaseline,
  shareHero,
  shareRows,
  titleBaseline,
  zeroBeside,
  zeroLines,
  type ShareBackground,
  type ShareCardData,
  type ShareUnit,
} from "@/lib/live-share";

/** Where the preview's own files live, under the app's directory: never public/, never fetched. */
export const SHARE_OG_DIR = "assets/share-og";

const W = SHARE_CARD.width;
const H = SHARE_CARD.height;
const PAD = L.pad;
const SANS = "Geist";
const MONO = "Geist Mono";

export const SHARE_OG_FONTS = [
  { name: SANS, weight: 400, file: "Geist-Regular.ttf" },
  { name: SANS, weight: 500, file: "Geist-Medium.ttf" },
  { name: SANS, weight: 600, file: "Geist-SemiBold.ttf" },
  { name: MONO, weight: 400, file: "GeistMono-Regular.ttf" },
  { name: MONO, weight: 500, file: "GeistMono-Medium.ttf" },
  { name: MONO, weight: 600, file: "GeistMono-SemiBold.ttf" },
] as const;

/** What a font's tables say about where its glyphs sit: from head, hhea and one glyph's box. */
export interface FontMetrics {
  readonly unitsPerEm: number;
  readonly ascender: number;
  readonly descender: number;
  /** The top of one glyph ("0", "E"), as measureText's actualBoundingBoxAscent reads it. */
  readonly glyphTop: number;
}

/** A TrueType font's metrics, and the top of `char`'s outline (cmap format 4, loca, glyf). Throws on anything else. */
export function fontMetrics(font: Buffer, char: string): FontMetrics {
  const tables = new Map<string, number>();
  for (let i = 0; i < font.readUInt16BE(4); i += 1) tables.set(font.toString("latin1", 12 + 16 * i, 16 + 16 * i), font.readUInt32BE(20 + 16 * i));
  const at = (tag: string): number => {
    const offset = tables.get(tag);
    if (offset === undefined) throw new Error(`no ${tag} table`);
    return offset;
  };
  const head = at("head");
  const hhea = at("hhea");
  const cmap = at("cmap");
  let sub: number | null = null;
  for (let i = 0; i < font.readUInt16BE(cmap + 2); i += 1) {
    const record = cmap + 4 + 8 * i;
    if (font.readUInt16BE(record) === 3 && font.readUInt16BE(record + 2) === 1) sub = cmap + font.readUInt32BE(record + 4);
  }
  if (sub === null || font.readUInt16BE(sub) !== 4) throw new Error("no Unicode BMP cmap");
  const code = char.codePointAt(0)!;
  const segments = font.readUInt16BE(sub + 6) / 2;
  const ends = sub + 14;
  const starts = ends + 2 * segments + 2;
  const deltas = starts + 2 * segments;
  const ranges = deltas + 2 * segments;
  let glyph = 0;
  for (let i = 0; i < segments; i += 1) {
    if (code > font.readUInt16BE(ends + 2 * i)) continue;
    const start = font.readUInt16BE(starts + 2 * i);
    if (code < start) break;
    const delta = font.readInt16BE(deltas + 2 * i);
    const range = font.readUInt16BE(ranges + 2 * i);
    glyph = range === 0 ? (code + delta) & 0xffff : (font.readUInt16BE(ranges + 2 * i + range + 2 * (code - start)) + delta) & 0xffff;
    break;
  }
  const longLoca = font.readInt16BE(head + 50) === 1;
  const loca = at("loca");
  const glyphAt = at("glyf") + (longLoca ? font.readUInt32BE(loca + 4 * glyph) : font.readUInt16BE(loca + 2 * glyph) * 2);
  return {
    unitsPerEm: font.readUInt16BE(head + 18),
    ascender: font.readInt16BE(hhea + 4),
    descender: font.readInt16BE(hhea + 6),
    glyphTop: font.readInt16BE(glyphAt + 8),
  };
}

export interface ShareOgAssets {
  readonly fonts: { readonly name: string; readonly data: Buffer; readonly weight: 400 | 500 | 600; readonly style: "normal" }[];
  /** Geist's line metrics (Geist Mono's are the same), and the tops of the glyphs a line is centred by. */
  readonly sans: FontMetrics;
  readonly monoDigitTop: number;
  readonly sansCapTop: number;
  readonly plates: Readonly<Record<ShareBackground, string>>;
}

let assetsOnce: Promise<ShareOgAssets> | null = null;

/** The fonts and the plates, read once per instance. A failed read is not kept: the next card asks again. */
export function shareOgAssets(root: string = process.cwd()): Promise<ShareOgAssets> {
  assetsOnce ??= (async () => {
    const dir = join(root, SHARE_OG_DIR);
    const fonts = await Promise.all(SHARE_OG_FONTS.map(async (font) => ({ name: font.name, weight: font.weight, style: "normal" as const, data: await readFile(join(dir, "fonts", font.file)) })));
    const plates = Object.fromEntries(
      await Promise.all(SHARE_BACKGROUNDS.map(async (name) => [name, `data:image/jpeg;base64,${(await readFile(join(dir, "plates", `${name}.jpg`))).toString("base64")}`] as const)),
    ) as Record<ShareBackground, string>;
    const sansMedium = fonts.find((font) => font.name === SANS && font.weight === 500)!.data;
    const monoSemiBold = fonts.find((font) => font.name === MONO && font.weight === 600)!.data;
    const sans = fontMetrics(sansMedium, "E");
    const mono = fontMetrics(monoSemiBold, "0");
    return { fonts, plates, sans, monoDigitTop: mono.glyphTop, sansCapTop: sans.glyphTop };
  })().catch((error: unknown) => {
    assetsOnce = null;
    throw error;
  });
  return assetsOnce;
}

// ── type, placed by its baseline ─────────────────────────────────────────────

type Family = typeof SANS | typeof MONO;

interface Run {
  readonly text: string;
  readonly family: Family;
  readonly weight: 400 | 500 | 600;
  readonly size: number;
  readonly color: string;
  /** In px. */
  readonly tracking?: number;
}

/** Where Satori puts a baseline inside a line box of lineHeight 1: the ascender, less half of what the font's own line overflows the box by, rounded. */
const baselineIn = (size: number, metrics: FontMetrics): number => {
  const ascent = (metrics.ascender / metrics.unitsPerEm) * size;
  const descent = (metrics.descender / metrics.unitsPerEm) * size;
  return Math.round(ascent + (size - (ascent - descent)) / 2);
};

/** A NUMBER RUN, as the canvas splits them (share-canvas.ts runs): a digit with what sticks to it, ending on a digit or %. */
const NUMBER_RUN = /(\$?\d(?:[\d,.]*\d)?%?)/;

/** Words in Geist, every number in Geist Mono at the same size (<Num>), the canvas's rule. */
function runsOf(text: string, size: number, weight: 400 | 500 | 600, color: string): Run[] {
  return text.split(NUMBER_RUN).flatMap((part, index) =>
    part === "" ? [] : [index % 2 === 1 ? { text: part, family: MONO, weight, size, color, tracking: -0.02 * size } : { text: part, family: SANS, weight, size, color }],
  );
}

function Text({ run }: { readonly run: Run }) {
  return (
    <div
      style={{
        display: "flex",
        fontFamily: run.family,
        fontWeight: run.weight,
        fontSize: run.size,
        lineHeight: 1,
        color: run.color,
        letterSpacing: run.tracking ?? 0,
        whiteSpace: "pre",
      }}
    >
      {run.text}
    </div>
  );
}

/**
 * A LINE OF RUNS WHOSE BASELINE IS `baseline`, from `left` (or ending at
 * `right`). Every run of one size shares a box height, so in a row their
 * baselines line up by themselves; a run of another size is pushed down by
 * the difference.
 */
function Line({ runs, baseline, left, right, metrics }: { readonly runs: readonly Run[]; readonly baseline: number; readonly left?: number; readonly right?: number; readonly metrics: FontMetrics }) {
  const offsets = runs.map((run) => baselineIn(run.size, metrics));
  const top = Math.max(...offsets);
  const style: CSSProperties = { position: "absolute", top: baseline - top, display: "flex", flexDirection: "row", alignItems: "flex-start" };
  if (left !== undefined) style.left = left;
  if (right !== undefined) style.right = W - right;
  return (
    <div style={style}>
      {runs.map((run, index) => (
        <div key={index} style={{ display: "flex", marginTop: top - offsets[index]! }}>
          <Text run={run} />
        </div>
      ))}
    </div>
  );
}

// ── the pieces ───────────────────────────────────────────────────────────────

/** The S as one path, all seven pieces filled together, as the canvas draws it. */
function Mark({ x, y, height }: { readonly x: number; readonly y: number; readonly height: number }) {
  const width = (height * MARK_W) / MARK_H;
  const d = MARK_PIECES.map((piece) => `M${piece.map(([px, py]) => `${px} ${py}`).join("L")}Z`).join("");
  return (
    <svg width={width} height={height} viewBox={`0 0 ${MARK_W} ${MARK_H}`} style={{ position: "absolute", left: x, top: y }}>
      <path d={d} fill={C.fg} />
    </svg>
  );
}

/**
 * THE CANVAS'S GRADIENT, CORNER TO CORNER, as CSS: a canvas gradient from
 * (x, y) to (x + w, y + h) runs along that diagonal, which is not what "to
 * bottom right" means in CSS for a box that is not square. The angle whose
 * gradient line is that diagonal has the same length, and starts and ends at
 * the same corners.
 */
const diagonalAngle = (w: number, h: number): number => 180 - (Math.atan2(w, h) * 180) / Math.PI;

function Block({ top, width, height, children }: { readonly top: number; readonly width: number; readonly height: number; readonly children: ReactNode }) {
  return (
    <div
      style={{
        position: "absolute",
        left: PAD,
        top,
        width,
        height,
        display: "flex",
        borderRadius: L.band.radius,
        backgroundImage: `linear-gradient(${diagonalAngle(width, height)}deg, ${C.blockFrom}, ${C.blockTo})`,
        boxShadow: `0 0 ${L.band.glowBlur}px ${C.glow}`,
      }}
    >
      {/* The light on its top half. */}
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width,
          height: height * 0.5,
          borderTopLeftRadius: L.band.radius,
          borderTopRightRadius: L.band.radius,
          backgroundImage: `linear-gradient(180deg, ${C.lit}, rgba(255,255,255,0))`,
        }}
      />
      {children}
    </div>
  );
}

/** The "Example" pill and the day beside it, ending at the card's right padding: the docs clips' label (share-canvas.ts examplePill). */
function PillAndDay({ day, metrics, capTop }: { readonly day: string; readonly metrics: FontMetrics; readonly capTop: number }) {
  const { pill, lockup } = L;
  const mid = lockup.markTop + lockup.markHeight / 2;
  const pillTop = mid - pill.height / 2;
  const dayTop = lockup.dayBaseline - baselineIn(lockup.daySize, metrics);
  const wordTop = mid + ((capTop / metrics.unitsPerEm) * pill.text) / 2 - baselineIn(pill.text, metrics);
  const top = Math.min(pillTop, dayTop);
  return (
    <div style={{ position: "absolute", right: PAD, top, display: "flex", flexDirection: "row", alignItems: "flex-start" }}>
      <div style={{ display: "flex", marginTop: dayTop - top, marginRight: lockup.dayGap }}>
        <Text run={{ text: day, family: MONO, weight: 400, size: lockup.daySize, color: C.fg55 }} />
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "row",
          marginTop: pillTop - top,
          height: pill.height,
          paddingLeft: pill.padLeft,
          paddingRight: pill.padRight,
          borderRadius: pill.height / 2,
          backgroundColor: pill.ground,
          backgroundImage: `linear-gradient(${pill.wash}, ${pill.wash})`,
          border: `1.5px solid ${pill.ring}`,
          boxShadow: `0 0 16px ${pill.shadow}`,
        }}
      >
        {/* lucide Info, on a 24-unit box. */}
        <svg width={pill.icon} height={pill.icon} viewBox="0 0 24 24" style={{ marginTop: (pill.height - 3 - pill.icon) / 2 }}>
          <circle cx="12" cy="12" r="10" fill="none" stroke="rgba(255,255,255,0.80)" strokeWidth="2" />
          <path d="M12 16v-4M12 8h.01" fill="none" stroke="rgba(255,255,255,0.80)" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <div style={{ display: "flex", marginLeft: pill.gap, marginTop: wordTop - pillTop - 1.5 }}>
          <Text run={{ text: SHARE_COPY.example.mark, family: SANS, weight: 500, size: pill.text, color: "rgba(255,255,255,0.90)" }} />
        </div>
      </div>
    </div>
  );
}

// ── the card ─────────────────────────────────────────────────────────────────

/** The figure's width, exactly as the canvas measures it: Geist Mono's 0.6 em a glyph, less the figure's tracking. */
const monoWidth = (text: string, size: number, part: "number" | "unit"): number => [...text].length * (0.6 * size + (part === "number" ? -0.02 * size : 0));

export function ShareOgCard({ card, background, unit, assets }: { readonly card: ShareCardData; readonly background: ShareBackground; readonly unit: ShareUnit; readonly assets: ShareOgAssets }) {
  const metrics = assets.sans;
  const { lockup, title: titleLayout, zero, footer } = L;
  const hero = shareHero(card, unit);
  const own = card.example ? SHARE_COPY.example.card : SHARE_COPY.card;
  const title = hero === null ? own.titleZero : own.titleSaved;
  const rows = shareRows(card);
  // Where the group stands: over fewer rows, lower (live-share.ts groupShift) — the canvas's rule.
  const mid = bandMid(rows.length);
  const markWidth = (lockup.markHeight * MARK_W) / MARK_H;
  /** The figure centred on the block the canvas's way: half the digit's height under the middle. */
  const figureBaseline = (top: number, height: number, size: number): number => top + height / 2 + ((assets.monoDigitTop / metrics.unitsPerEm) * size) / 2;

  let band: ReactNode;
  if (hero === null) {
    const [line1, line2] = zeroLines(card);
    const fit = fitHero([card.rate], null, zeroBeside(card), monoWidth);
    const { top, height } = blockBox(fit.size, mid);
    const x = PAD + fit.blockWidth + zero.gap;
    band = (
      <>
        <Block top={top} width={fit.blockWidth} height={height}>
          <Line runs={[{ text: fit.text, family: MONO, weight: 600, size: fit.size, color: C.ink, tracking: -0.02 * fit.size }]} baseline={figureBaseline(0, height, fit.size)} left={heroPadX(fit.size)} metrics={metrics} />
        </Block>
        <Line runs={[{ text: line1, family: SANS, weight: 500, size: zero.size, color: C.fg, tracking: zero.tracking }]} baseline={mid + zero.line1} left={x} metrics={metrics} />
        <Line runs={[{ text: line2, family: SANS, weight: 500, size: zero.size, color: C.fg55, tracking: zero.tracking }]} baseline={mid + zero.line2} left={x} metrics={metrics} />
      </>
    );
  } else {
    const fit = fitHero([hero.number, hero.compact], hero.unit, 0, monoWidth);
    const { top, height } = blockBox(fit.size, mid);
    const baseline = figureBaseline(0, height, fit.size);
    const x = heroPadX(fit.size);
    band = (
      <Block top={top} width={fit.blockWidth} height={height}>
        <Line runs={[{ text: fit.text, family: MONO, weight: 600, size: fit.size, color: C.ink, tracking: -0.02 * fit.size }]} baseline={baseline} left={x} metrics={metrics} />
        {hero.unit === null ? null : (
          <Line runs={[{ text: hero.unit, family: MONO, weight: 600, size: heroUnitSize(fit.size), color: C.unitInk }]} baseline={baseline} left={x + fit.numberWidth + heroUnitGap(fit.size)} metrics={metrics} />
        )}
      </Block>
    );
  }

  return (
    <div style={{ width: W, height: H, display: "flex", position: "relative", backgroundColor: C.ground }}>
      {/* The plate's frame 0: the still the dialog draws on, and the video's first frame. */}
      <img src={assets.plates[background]} width={W} height={H} alt="" style={{ position: "absolute", left: 0, top: 0, width: W, height: H }} />

      {/* 1. The lockup top-left, the day top-right — on the sample's card, the "Example" pill in the corner, the day beside it. */}
      <Mark x={PAD} y={lockup.markTop} height={lockup.markHeight} />
      <Line
        runs={[{ text: SHARE_COPY.card.brand, family: SANS, weight: 600, size: lockup.brandSize, color: C.fg, tracking: lockup.brandTracking }]}
        baseline={lockup.brandBaseline}
        left={PAD + markWidth + lockup.markGap}
        metrics={metrics}
      />
      {card.example ? (
        <PillAndDay day={card.asOf} metrics={metrics} capTop={assets.sansCapTop} />
      ) : (
        <Line runs={[{ text: card.asOf, family: MONO, weight: 400, size: lockup.daySize, color: C.fg55 }]} baseline={lockup.dayBaseline} right={W - PAD} metrics={metrics} />
      )}

      {/* 2. The title: the figure's label, and the month beside it. */}
      <Title title={title} since={hero === null ? null : card.since} baseline={titleBaseline(rows.length)} metrics={metrics} />

      {/* 3. The figure on its block, and nothing under it. */}
      {band}

      {/* 4. The rows, anchored at the bottom. */}
      {rows.map((row, index) => (
        <div key={row.label} style={{ display: "flex" }}>
          <Line runs={[{ text: row.label, family: SANS, weight: 400, size: L.rows.size, color: C.fg55 }]} baseline={rowBaseline(index, rows.length)} left={PAD} metrics={metrics} />
          <Line
            runs={[...runsOf(row.value, L.rows.size, 500, C.fg), ...(row.after === undefined ? [] : runsOf(row.after, L.rows.size, 500, C.fg55))]}
            baseline={rowBaseline(index, rows.length)}
            left={PAD + L.rows.valueX}
            metrics={metrics}
          />
        </div>
      ))}

      {/* 5. The footer: the site and the eyebrow; its right side left empty for a referral link later. */}
      <div style={{ position: "absolute", left: PAD, top: footer.ruleY, width: W - PAD * 2, height: 1, backgroundColor: C.fg10 }} />
      <Line runs={[{ text: SHARE_COPY.card.site, family: MONO, weight: 500, size: footer.size, color: C.emerald }]} baseline={footer.baseline} left={PAD} metrics={metrics} />
      <Line
        runs={[{ text: SHARE_COPY.card.tagline, family: SANS, weight: 400, size: footer.size, color: C.fg55 }]}
        baseline={footer.baseline}
        left={PAD + monoWidth(SHARE_COPY.card.site, footer.size, "unit") + footer.gap}
        metrics={metrics}
      />
    </div>
  );
}

/**
 * THE TITLE, and "since Sep 2026" 16 px after it (only over a figure). The
 * title's width is Satori's to know, so the two sit in one row: the month is
 * pushed down to share the title's baseline.
 */
function Title({ title, since, baseline, metrics }: { readonly title: string; readonly since: string | null; readonly baseline: number; readonly metrics: FontMetrics }) {
  const { title: layout } = L;
  const runs: Run[] = [{ text: title, family: SANS, weight: 500, size: layout.size, color: C.fg, tracking: layout.tracking }, ...(since === null ? [] : runsOf(SHARE_COPY.card.since(since), layout.sinceSize, 400, C.fg55))];
  const offsets = runs.map((run) => baselineIn(run.size, metrics));
  const top = Math.max(...offsets);
  return (
    <div style={{ position: "absolute", left: PAD, top: baseline - top, display: "flex", flexDirection: "row", alignItems: "flex-start" }}>
      {runs.map((run, index) => (
        <div key={index} style={{ display: "flex", marginTop: top - offsets[index]!, marginLeft: index === 1 ? layout.sinceGap : 0 }}>
          <Text run={run} />
        </div>
      ))}
    </div>
  );
}

/** A card's image response cached for a year without asking again: its address carries the renderer's version, so a redrawn card has a new one. */
export const SHARE_IMAGE_IMMUTABLE = "public, max-age=31536000, s-maxage=31536000, immutable";

/**
 * THE PICTURES THIS INSTANCE HAS DRAWN, by the card's address (review, 10-22).
 * The CDN keeps a picture by its RAW URL, and one card has many: a character
 * of its token or of "?v=" percent-encoded is another key to the CDN and the
 * same request to the route. Without this, every such URL drew the card again
 * (65–85 ms of Satori and resvg, measured on `next start`). Now the first draws
 * it, and the rest of this instance's life it is a lookup — bounded, oldest
 * out first, about 250 KB a card.
 */
const DRAWN_MAX = 64;
const drawn = new Map<string, Promise<Uint8Array>>();

/** A card's PNG bytes, drawn once per instance under `key` (its address); a failed draw is not kept. `draw` is next/og's response. */
export function drawnOnce(key: string, draw: () => Promise<Response>): Promise<Uint8Array> {
  const kept = drawn.get(key);
  if (kept !== undefined) {
    // Most recently asked for: to the back of the line.
    drawn.delete(key);
    drawn.set(key, kept);
    return kept;
  }
  const bytes = draw().then(async (response) => {
    if (!response.ok) throw new Error(`the card did not draw: ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  });
  bytes.catch(() => drawn.delete(key));
  drawn.set(key, bytes);
  while (drawn.size > DRAWN_MAX) drawn.delete(drawn.keys().next().value!);
  return bytes;
}

/**
 * ONE CARD AS A PNG RESPONSE, 1200×630. next/og would send "public, max-age=0,
 * must-revalidate" (its default in production), so the caller's caching is set
 * here explicitly.
 */
export async function shareCardImage(
  { card, background, unit }: { readonly card: ShareCardData; readonly background: ShareBackground; readonly unit: ShareUnit },
  cacheControl: string = SHARE_IMAGE_IMMUTABLE,
): Promise<ImageResponse> {
  const assets = await shareOgAssets();
  return new ImageResponse(<ShareOgCard card={card} background={background} unit={unit} assets={assets} />, {
    width: W,
    height: H,
    fonts: assets.fonts,
    headers: { "cache-control": cacheControl },
  });
}
