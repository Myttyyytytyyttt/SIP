/**
 * THE SHARE CARD'S FIGURES, AND ITS LAYOUT'S ARITHMETIC (owner, 10-22): "Saved
 * $X", an image of a pension for X and anywhere else — GMGN's and Axiom's PnL
 * cards, in SaverFi's own dress.
 *
 * TWO STEPS, AND THIS IS THE PURE ONE. shareCardOf turns what the Live page
 * already holds into the card's words and numbers; live/share-canvas.ts draws
 * them. Everything that can be wrong without a canvas — which state a pension
 * is in, which unit it can show, how a long figure fits, what the rows say,
 * what the post says — is here, and is tested in node.
 *
 * DRAWN IN THE BROWSER — AND BY ONE ROUTE, ONLY FROM FIGURES THE SERVER SIGNED
 * (owner, 10-22: Post on X posts a link, and X shows the card under it). The
 * dialog's image is still drawn by the person's browser (share-canvas.ts). The
 * link's preview is drawn by /c/<token>/card.png (components/share-og.tsx), and
 * the token is the reason that is safe: the route that makes it (/api/share,
 * lib/share-server.ts) reads the figures from the chain itself and signs them,
 * and the image route draws nothing it cannot verify. No endpoint draws a figure
 * a URL merely states — that would let anybody mint a "SaverFi" card with any
 * number on our own domain.
 *
 * AND THE LINK'S CARD IS NOBODY'S IN PARTICULAR (review finding S1; owner,
 * 10-23: 'usa "SaverFi's Vault"'). /api/share signs a card for any pension key
 * it is handed, with no proof that the person asking owns it — so a link could
 * put somebody else's pension under the first-person "My pension". The words a
 * card speaks in are therefore chosen by where it is drawn (ShareVoice): the
 * dialog's canvas, made in the owner's browser from his own connected Live
 * page, is "own" and says "My pension"; the server's preview of a /c/<token>
 * link is "link" and says "SaverFi’s Vault", in the third person, with no "my"
 * or "I" anywhere on it (SHARE_COPY.page.card). Same figures, same layout; the
 * zero card's narrower line may let the link's rate take a larger step. The
 * sample's card is "Example pension" in both voices.
 *
 * NO ADDRESS, WALLET OR NAME (owner, 10-22): ShareCardData has no field for a
 * vault, a wallet, an owner or a handle, so no layout can print one. And the
 * link carries none either: its token holds what the card prints and nothing
 * else (lib/share-token.ts). No referral yet; the footer's right side is left
 * empty for that.
 *
 * AND NO FIGURE THAT IS A KEY TO THE VAULT (review, 10-22). /leaderboard prints
 * each vault's lifetime SOL to four places beside its address, and the first
 * card printed the same four places — so a posted card pointed at its vault,
 * its owner and its wallets. So the card's SOL is to two places, no line on it
 * carries the SOL figure beside the dollars, and "since" is a month (the day
 * was the vault account's createdAt). An amount can still be guessed at from a
 * handful of vaults; the dialog promises no more than what is true.
 *
 * NOTHING AROUND THE FIGURE BUT THE FIGURE (owner, 10-22: "Quitamos en todas
 * las imágenes lo que está debajo del dinero: saved so far, value at sols price
 * today"). The card had a "SAVED SO FAR" label over the green block and a note
 * under it — what valued the dollars, or, on the sample, "Example numbers.
 * Nobody's pension." Both are gone from every card, and "Saved so far" with
 * them, the zero card's row included: the title says whose pension it is, and
 * the block what it holds.
 *
 * UNKNOWN IS NEVER ZERO. A vault whose total could not be read has no card at
 * all (its button is off); a vault that has saved nothing yet gets a card of its
 * rule, never a "$0.00".
 *
 * THE SAMPLE HAS ONE TOO, OF ITS OWN FIGURES (owner, 10-22: "en el mock también
 * puede aparecer pero con los datos del mock claro"). exampleShareCardOf builds
 * it from what the sample's hero shows, and the same card and renderer carry it
 * with `example` set. That flag is the whole difference, and it is a promise:
 * the image says "Example" on itself (a pill at the corner, and "Example
 * pension" over the figure — share-canvas.ts), the post is a line about SaverFi
 * rather than "I've saved", and the files are saverfi-example-<day>.png and
 * .mp4. A card of a Live page never sets it. The sample is in dollars only: it
 * has no SOL total, and a SOL figure made up for the image would be a second
 * invention.
 *
 * Types from '@/mocks/types' only: no-mock-import.test.ts scans lib/live-*.
 */

import { formatSolAtMost } from "@/lib/amounts";
import { compact, dateLabel, monthLabel, pct, usd, usdCompact } from "@/lib/format";
import { SHARE_COPY } from "@/lib/live-copy";
import type { SavingsRule, SavingsStats } from "@/mocks/types";

/** The production site: the only address on the card and in the post. */
export const SHARE_SITE = "https://saverfi.cash";

/** The card in logical pixels: 1200×630, the social-card ratio (1.91:1) it was designed at. */
export const SHARE_CARD = { width: 1200, height: 630 } as const;
/** Every image is drawn at twice that (2400×1260), whatever this screen's pixel ratio: what is posted must not depend on who posts it. */
export const SHARE_SCALE = 2;

/**
 * THE BACKGROUNDS, IN THE PICKER'S ORDER (owner, 10-22: "La primera tiene que
 * ser la del grid donde muestra el logo chill"): Grid first, and the one a
 * dialog opens on; then Streaks and Vault, both with the S behind, fainter.
 * Each is one of the films' plates (src/lib/share-plates.ts).
 */
export const SHARE_BACKGROUNDS = ["grid", "streaks", "vault"] as const;
export type ShareBackground = (typeof SHARE_BACKGROUNDS)[number];

export type ShareUnit = "usd" | "sol";

/** saved: there is a total to show · zero: the chain says nothing yet · unknown: the total could not be read. */
export type ShareState = "saved" | "zero" | "unknown";

export interface ShareCardData {
  readonly state: ShareState;
  /** "$2,073.42", "<$0.01" — null when no SOL price was read, and the card can only show SOL. */
  readonly usdText: string | null;
  /** "$1.2M" — for a figure too long for the card even at its smallest step. */
  readonly usdCompact: string | null;
  /**
   * "11.42", "<0.01" — SOL to two places, like the dollar's cents, never
   * rounded to nothing. Never the four places /leaderboard prints beside the
   * vault's address: that figure would name the vault. Null when unreadable,
   * and on the sample's card, which has no SOL total.
   */
  readonly solText: string | null;
  readonly solCompact: string | null;
  /** "20%" — today's rate. */
  readonly rate: string;
  readonly mode: "profit" | "volume";
  readonly paused: boolean;
  /** "Sep 2026" — the month the vault was created: the hero's "saving since", without the day that is on chain. */
  readonly since: string | null;
  readonly streakDays: number | null;
  /** The basket's symbols, biggest share first; empty when the page does not vouch for it. */
  readonly basket: readonly string[];
  /** "Oct 22, 2026" — the snapshot's day, top-right. */
  readonly asOf: string;
  /** "2026-10-22" — for the file name. */
  readonly day: string;
  /**
   * The sample's card (exampleShareCardOf): nobody's pension, and the image,
   * the post, the dialog and the file name all say so. Never set on a Live
   * page's card.
   */
  readonly example: boolean;
}

/**
 * WHAT A CARD IS MADE FROM: just the fields it reads — the hero's dollars, the
 * month, the streak, the rule and its basket, the day. Narrow on purpose, so
 * the share route can hand over its own figures (live-figures.ts shareInputOf)
 * without inventing a whole SavingsStats.
 */
export interface ShareCardInput {
  readonly stats: Pick<SavingsStats, "totalSavedUsd" | "firstSaveAt" | "currentStreakDays">;
  readonly rule: Pick<SavingsRule, "rateBps" | "mode" | "paused" | "targetsNote"> & { readonly targets: readonly Pick<SavingsRule["targets"][number], "symbol" | "weightBps">[] };
  readonly now: string;
}
type CardInput = ShareCardInput;

/**
 * THE LONGEST STREAK A CARD STATES EXACTLY: 45 days, then "45+". The server
 * proves a streak one settlement per day (live-figures.ts), and reading 45
 * transactions is what one client's bucket can pay for in a request (3 + 1 +
 * 45 of its 60 a minute). So both cards stop counting there, the browser's and
 * the server's, and say "45+" — true of any longer run.
 */
export const SHARE_STREAK_CAP = 45;

/** "13", or "45+" at the cap (SHARE_STREAK_CAP). */
export const streakText = (days: number): string => (days >= SHARE_STREAK_CAP ? `${SHARE_STREAK_CAP}+` : String(days));

/** A dollar total as the card prints it — A POSITIVE AMOUNT NEVER READS AS ZERO (amounts.ts formatSolAtMost's rule, for the dollar). */
const dollarsOf = (dollars: number | null): Pick<ShareCardData, "usdText" | "usdCompact"> => ({
  usdText: dollars === null ? null : dollars > 0 && dollars < 0.005 ? "<$0.01" : usd(dollars),
  usdCompact: dollars === null ? null : usdCompact(dollars),
});

/** What every card takes from the page's rule and stats, whoever's figures they are: the rule, the month, the streak, the basket, the day. */
const ruleOf = ({ stats, rule, now }: CardInput): Pick<ShareCardData, "rate" | "mode" | "paused" | "since" | "streakDays" | "basket" | "asOf" | "day"> => ({
  rate: pct(rule.rateBps),
  mode: rule.mode ?? "volume",
  paused: rule.paused,
  since: stats.firstSaveAt ? monthLabel(stats.firstSaveAt) : null,
  streakDays: stats.currentStreakDays === null ? null : Math.min(stats.currentStreakDays, SHARE_STREAK_CAP),
  // A basket the page qualifies (unread, or chosen and not approved yet) is not stated on an image.
  basket: rule.targetsNote === undefined ? [...rule.targets].sort((a, b) => b.weightBps - a.weightBps).map((target) => target.symbol) : [],
  asOf: dateLabel(now),
  day: now.slice(0, 10),
});

/**
 * THE CARD, FROM THE LIVE PAGE'S OWN FIGURES. `lifetimeSaved` is the vault's raw
 * counter (LiveDashboard.vault.lifetimeSaved): the state is read from it rather
 * than from the dollars, so a page with no price still knows whether anything
 * was saved. Everything else is what the hero and the rule card already show
 * (src/lib/live-mock.ts).
 */
export function shareCardOf(input: CardInput & { readonly lifetimeSaved: bigint | null }): ShareCardData {
  const { lifetimeSaved, stats } = input;
  const state: ShareState = lifetimeSaved === null ? "unknown" : lifetimeSaved > 0n ? "saved" : "zero";
  const dollars = state === "saved" ? stats.totalSavedUsd : null;
  return {
    state,
    ...dollarsOf(dollars),
    solText: lifetimeSaved === null ? null : formatSolAtMost(lifetimeSaved, SHARE_SOL_PLACES),
    solCompact: lifetimeSaved === null ? null : compact(Number(lifetimeSaved) / 1e9),
    ...ruleOf(input),
    example: false,
  };
}

/**
 * THE SAMPLE'S CARD, FROM THE SAMPLE'S OWN FIGURES (owner, 10-22): what its hero
 * and rule card show (MockBody in dashboard-shell.tsx), marked as the example.
 * Its state is read from the hero's dollars — the sample has no chain counter —
 * and it has no SOL: no total in SOL and no SOL price, so the image is in
 * dollars and the dialog says why SOL is off.
 */
export function exampleShareCardOf(input: CardInput): ShareCardData {
  const dollars = input.stats.totalSavedUsd;
  const state: ShareState = dollars === null ? "unknown" : dollars > 0 ? "saved" : "zero";
  return {
    state,
    ...dollarsOf(state === "saved" ? dollars : null),
    solText: null,
    solCompact: null,
    ...ruleOf(input),
    example: true,
  };
}

/** The card's SOL places: two, where the leaderboard's are four (formatSol in lib/leaderboard.ts). */
export const SHARE_SOL_PLACES = 2;

/** The units this card can show: dollars only with a price; SOL only with a SOL total (the sample has none). */
export const unitsOf = (card: ShareCardData): readonly ShareUnit[] => (card.usdText === null ? ["sol"] : card.solText === null ? ["usd"] : ["usd", "sol"]);

/** Dollars by default (owner, 10-22: "sí usa $ por defecto"); SOL when there is no price to make them. */
export const defaultUnit = (card: ShareCardData): ShareUnit => unitsOf(card)[0]!;

/** What is shown for a unit asked for: dollars that do not exist fall back to SOL, and SOL that does not exist to dollars. */
export const unitFor = (card: ShareCardData, wanted: ShareUnit): ShareUnit => (unitsOf(card).includes(wanted) ? wanted : defaultUnit(card));

/** The hero of a card with savings: the figure, its unit and a shorter form — and nothing under it (owner, 10-22). */
export interface ShareHero {
  readonly number: string;
  /** "SOL", set smaller beside the number; dollars carry their unit in the number. */
  readonly unit: string | null;
  readonly compact: string;
}

export function shareHero(card: ShareCardData, wanted: ShareUnit): ShareHero | null {
  if (card.state !== "saved") return null;
  if (unitFor(card, wanted) === "sol") {
    if (card.solText === null) return null;
    return { number: card.solText, unit: "SOL", compact: card.solCompact ?? card.solText };
  }
  if (card.usdText === null) return null;
  return { number: card.usdText, unit: null, compact: card.usdCompact ?? card.usdText };
}

/** "20% of trading gains" / "2% of every buy and sell". */
export const ruleLine = (card: ShareCardData): string => `${card.rate} ${SHARE_COPY.card.measure[card.mode]}`;

/** "SPYx · ANTHROPIC · NVDAx +1": at most three, then how many more. */
export function basketLine(symbols: readonly string[]): string {
  const shown = symbols.slice(0, 3).join(" · ");
  return symbols.length > 3 ? `${shown} +${symbols.length - 3}` : shown;
}

export interface ShareRow {
  readonly label: string;
  readonly value: string;
  /** Said after the value, quieter: " · paused". */
  readonly after?: string;
}

/**
 * THE ROWS UNDER THE HERO, bottom-anchored on the card. "Saving now", because
 * the rule is today's and the total is lifetime (pension-panel.tsx, 09-25) —
 * "Rule … · paused" when it is paused, which is not saving; a streak only when
 * it is one (two days or more); the basket when it is known. A card with
 * nothing saved has its rule as its hero, so its rows are the basket alone —
 * and no "Saved so far · Nothing yet" (owner, 10-22): its title ("Building my
 * pension", or on a link "SaverFi’s Vault") and the rule beside its rate say it.
 * No row says "my": the rows are the same in both voices (ShareVoice).
 */
export function shareRows(card: ShareCardData): readonly ShareRow[] {
  const rows: ShareRow[] = [];
  if (card.state === "saved") {
    rows.push(card.paused ? { label: SHARE_COPY.card.rule, value: ruleLine(card), after: ` · ${SHARE_COPY.card.paused}` } : { label: SHARE_COPY.card.savingNow, value: ruleLine(card) });
    if (card.streakDays !== null && card.streakDays >= 2) rows.push({ label: SHARE_COPY.card.streak, value: SHARE_COPY.card.streakDays(streakText(card.streakDays)) });
  }
  if (card.basket.length > 0) rows.push({ label: SHARE_COPY.card.investsIn, value: basketLine(card.basket) });
  return rows;
}

// ── the layout both renderers draw ───────────────────────────────────────────

/**
 * THE CARD'S INKS. The quietest text is 55 % white (about 6:1 on the ground):
 * 40 % was about 3.8:1, and at a phone's timeline width — the card ~300 px wide
 * — the date all but went (review, 10-22).
 */
export const SHARE_INK = {
  ground: "#0A0B11",
  fg: "#FAFAFA",
  fg55: "rgba(255,255,255,0.55)",
  fg10: "rgba(255,255,255,0.10)",
  /** emerald-400: the app's "saved". */
  emerald: "#34d399",
  /** emerald-950: the figure on the block, ~11:1 on emerald-400. */
  ink: "#022c22",
  /** The unit beside a SOL figure, on the block. */
  unitInk: "rgba(2,44,34,0.72)",
  /** The block: a gradient corner to corner, its glow, and the light on its top half. */
  blockFrom: "#3fe0a8",
  blockTo: "#10b981",
  glow: "rgba(16,185,129,0.45)",
  lit: "rgba(255,255,255,0.22)",
} as const;

/**
 * THE CARD'S GEOMETRY, IN ITS LOGICAL 1200×630 — ONE COPY FOR TWO RENDERERS:
 * the browser's canvas (live/share-canvas.ts) and the link's preview
 * (components/share-og.tsx). Every y is a text BASELINE, as a canvas draws it;
 * the preview turns each into a box from the font's own metrics.
 *
 * TOP TO BOTTOM (owner, 10-22: no label over the figure, no note under it).
 * The lockup at the top — the S and the name on the left, the day on the right,
 * and on the sample the "Example" pill in the corner with the day beside it.
 * The title and the figure are one group — the title is the figure's label
 * now — centred between the lockup (bottom at 86) and what stands under it.
 * Under three rows (their top at ~443) the title's baseline is at 186 and the
 * block's middle at 300; with fewer, the group comes down by half the room the
 * missing rows leave (groupShift), and with none it is centred between the
 * lockup and the footer's rule (review, 10-22: a new vault's card, with no
 * row at all, had its lower third empty). A smaller step shrinks the block
 * about its middle, so nothing else moves. The rows are anchored to the
 * footer: the last one's baseline is always 534. The footer's right side is
 * left empty on purpose — a referral link goes there later.
 */
export const SHARE_LAYOUT = {
  pad: 64,
  lockup: { markTop: 52, markHeight: 34, markGap: 12, brandSize: 30, brandTracking: -0.6, brandBaseline: 79.5, daySize: 18, dayBaseline: 75.5, dayGap: 20 },
  /**
   * THE "Example" PILL, at the top-right corner of the sample's card: the docs
   * clips' label — a quiet capsule, an info ring, the word — set larger than
   * anything else up there. Where a phone's timeline shows the card ~350 px
   * wide its 28 px word is ~8 px, where the day beside it is ~5 px.
   */
  pill: { height: 52, text: 28, icon: 26, padLeft: 15, gap: 10, padRight: 22, ground: "rgba(14,15,21,0.86)", wash: "rgba(255,255,255,0.06)", ring: "rgba(255,255,255,0.18)", shadow: "rgba(0,0,0,0.35)" },
  title: { baseline: 186, size: 44, tracking: -0.9, sinceGap: 16, sinceSize: 26 },
  band: { mid: 300, radius: 18, height: 1.25, glowBlur: 28 },
  /** A card with nothing saved: the rate on the block, and two lines beside it — the first 6 above the middle, the second 34 below. */
  zero: { size: 32, tracking: -0.5, gap: 28, line1: -6, line2: 34 },
  /** `cap`: the top of a row's capitals above its baseline (Geist's 0.71 em at 21 px), where the stack of rows begins. */
  rows: { last: 534, step: 38, size: 21, valueX: 150, cap: 15, most: 3 },
  footer: { ruleY: 562, baseline: 594, size: 19, gap: 20 },
} as const;

/**
 * THE ZERO CARD'S TWO LINES, MEASURED: Geist 500 at 32 px, -0.5 px tracking,
 * rounded up — the font's own advances, which is how both renderers set a line
 * now (Satori does not kern, and the canvas is set glyph by glyph since the
 * review of 10-22: "of every buy and sell," 311 in each). Pinned rather than
 * measured at draw time so the browser and the preview choose the SAME step
 * for the rate (fitHero), and so the lines end inside the plates' still zone
 * in both. live-share.test.ts fails when a line is added or reworded without
 * its width here.
 */
export const ZERO_LINE_WIDTHS: Readonly<Record<string, number>> = {
  "of my trading gains,": 290,
  "of every buy and sell,": 311,
  "of trading gains,": 238,
  "put aside for later.": 269,
  "paused for now.": 236,
};

/**
 * WHOSE VOICE A CARD SPEAKS IN, BY WHERE IT IS DRAWN (review finding S1;
 * owner, 10-23: 'usa "SaverFi's Vault"'):
 *   "own"   the dialog's canvas (live/share-canvas.ts) — the PNG, the copy and
 *           the MP4, made in the owner's browser from his connected Live page:
 *           "My pension", "of my trading gains".
 *   "link"  the server's preview of a signed /c/<token> link
 *           (components/share-og.tsx): /api/share proves no ownership, so it is
 *           "SaverFi’s Vault", "of trading gains" — no "my", no "I".
 * The sample's card is "Example pension" in both: it was nobody's already.
 */
export type ShareVoice = "own" | "link";

/** The words that differ by voice: the title over the figure (or over a zero card's rate), and what the rule measures beside that rate. */
export function cardVoice(card: ShareCardData, voice: ShareVoice): { readonly titleSaved: string; readonly titleZero: string; readonly zeroMeasure: Readonly<Record<"profit" | "volume", string>> } {
  if (card.example) return SHARE_COPY.example.card;
  return voice === "link" ? SHARE_COPY.page.card : SHARE_COPY.card;
}

/** The title a card prints: over its figure, or — with nothing saved, no hero — over its rate. */
export const shareTitle = (card: ShareCardData, hero: ShareHero | null, voice: ShareVoice): string => {
  const words = cardVoice(card, voice);
  return hero === null ? words.titleZero : words.titleSaved;
};

/** The two lines beside a zero card's rate: what the rule measures, and whether anything is put aside. */
export function zeroLines(card: ShareCardData, voice: ShareVoice): readonly [string, string] {
  return [cardVoice(card, voice).zeroMeasure[card.mode], card.paused ? SHARE_COPY.card.zeroPaused : SHARE_COPY.card.zeroAside];
}

/** What stands beside a zero card's block: the gap and the longer line (ZERO_LINE_WIDTHS). */
export function zeroBeside(card: ShareCardData, voice: ShareVoice): number {
  const widths = zeroLines(card, voice).map((line) => ZERO_LINE_WIDTHS[line]);
  if (widths.some((width) => width === undefined)) throw new Error("a zero card's line has no measured width (ZERO_LINE_WIDTHS)");
  return SHARE_LAYOUT.zero.gap + Math.max(...(widths as number[]));
}

/** Each row's baseline: the last one's is always SHARE_LAYOUT.rows.last. */
export const rowBaseline = (index: number, count: number): number => SHARE_LAYOUT.rows.last - SHARE_LAYOUT.rows.step * (count - 1 - index);

/** Where what stands under the group begins: the first row's capitals, or with no row, the footer's rule. */
const underTop = (rows: number): number => (rows === 0 ? SHARE_LAYOUT.footer.ruleY : rowBaseline(0, rows) - SHARE_LAYOUT.rows.cap);

/**
 * HOW FAR THE TITLE AND THE BLOCK COME DOWN under fewer than three rows: half
 * the room the missing rows leave, so the group stays centred between the
 * lockup and what is under it — 0 under three rows, 19 under two, 38 under
 * one, 60 under none. One function for both renderers, so the link's preview
 * moves with the dialog's picture.
 */
export const groupShift = (rows: number): number => Math.round((underTop(Math.min(rows, SHARE_LAYOUT.rows.most)) - underTop(SHARE_LAYOUT.rows.most)) / 2);

/** The title's baseline over `rows` rows. */
export const titleBaseline = (rows: number): number => SHARE_LAYOUT.title.baseline + groupShift(rows);

/** The block's middle over `rows` rows: the figure, or the rate and the two lines beside it, are centred on it. */
export const bandMid = (rows: number): number => SHARE_LAYOUT.band.mid + groupShift(rows);

/** The block's height and top at a step: 1.25 × the figure, centred on the band's middle (bandMid). */
export const blockBox = (size: number, mid: number): { readonly top: number; readonly height: number } => {
  const height = Math.round(size * SHARE_LAYOUT.band.height);
  return { top: mid - height / 2, height };
};

// ── the hero's fit ───────────────────────────────────────────────────────────

/** The figure's sizes, largest first: the first that fits is used. */
export const HERO_STEPS = [104, 92, 80, 68, 60] as const;
/**
 * THE HERO'S ROOM: from the card's left padding (64) to x = 720, where the
 * plates' motion begins — their text zone, x 64–720, is kept dark and still
 * (the films, 10-22). The emerald block — and on a card with nothing saved,
 * the words beside it — must end before it.
 */
export const HERO_ROOM = 656;
/** The block's padding either side of the figure, and the unit's size and gap, all in proportion to the step. */
export const heroPadX = (size: number): number => Math.round(size * 0.28);
export const heroUnitSize = (size: number): number => Math.round(size * 0.44);
export const heroUnitGap = (size: number): number => Math.round(size * 0.18);

export interface HeroFit {
  readonly size: number;
  /** The text that fitted: the full figure, or its compact form. */
  readonly text: string;
  readonly numberWidth: number;
  /** The unit's gap and width together; 0 without one. */
  readonly unitWidth: number;
  /** The emerald block's width. */
  readonly blockWidth: number;
}

/**
 * The largest step at which the block — and `beside`, what stands to its right
 * — fits the hero's room. The full figure first; only if it fits at no step,
 * its compact form ("$1.2M"). `measure` is the canvas's (Geist Mono 600 at that
 * size, "number" with the figure's tracking), passed in so this stays testable
 * without one.
 */
export function fitHero(
  texts: readonly string[],
  unit: string | null,
  beside: number,
  measure: (text: string, size: number, part: "number" | "unit") => number,
): HeroFit {
  let last: HeroFit | null = null;
  for (const text of texts) {
    for (const size of HERO_STEPS) {
      const numberWidth = measure(text, size, "number");
      const unitWidth = unit === null ? 0 : heroUnitGap(size) + measure(unit, heroUnitSize(size), "unit");
      last = { size, text, numberWidth, unitWidth, blockWidth: numberWidth + unitWidth + 2 * heroPadX(size) };
      if (last.blockWidth + beside <= HERO_ROOM) return last;
    }
  }
  if (last === null) throw new Error("fitHero needs a text");
  return last;
}

// ── what leaves the page ─────────────────────────────────────────────────────

/**
 * The post's words. X puts the site's link after them (shareIntentUrl). A paused rule puts nothing aside, so a post with nothing saved claims no rule.
 * The sample's post claims nothing at all: its figure is nobody's, so the words are about SaverFi, in either unit.
 */
export function sharePostText(card: ShareCardData, wanted: ShareUnit): string {
  if (card.example) return SHARE_COPY.example.post;
  const hero = shareHero(card, wanted);
  if (hero === null) return card.paused ? SHARE_COPY.postZeroPaused : SHARE_COPY.postZero(`${card.rate} ${SHARE_COPY.card.measureMine[card.mode]}`);
  return SHARE_COPY.post(hero.unit === null ? hero.number : `${hero.number} ${hero.unit}`);
}

/** The image described in a sentence, for the preview's alt text — the sample's says it is the example. */
export function shareAlt(card: ShareCardData, wanted: ShareUnit): string {
  const hero = shareHero(card, wanted);
  const figure = hero === null ? null : hero.unit === null ? hero.number : `${hero.number} ${hero.unit}`;
  if (card.example) return SHARE_COPY.example.alt(figure === null ? `${card.rate} ${SHARE_COPY.card.measure[card.mode]}` : `${figure} saved`);
  if (figure === null) return (card.paused ? SHARE_COPY.altZeroPaused : SHARE_COPY.altZero)(`${card.rate} ${SHARE_COPY.card.measureMine[card.mode]}`);
  return SHARE_COPY.alt(figure);
}

/** The button's and the dialog's words (ShareSavings.tsx): a pension's, or the sample's, which is nobody's — "Share this example". */
export function shareWords(card: ShareCardData): { readonly trigger: string; readonly triggerTip: string; readonly title: string; readonly description: string } {
  const { trigger, triggerTip, title } = card.example ? SHARE_COPY.example : SHARE_COPY;
  const description = card.example ? SHARE_COPY.example.description : card.state === "saved" ? SHARE_COPY.description : SHARE_COPY.descriptionZero;
  return { trigger, triggerTip, title, description };
}

/**
 * X's composer, with the words and a link: the card's own (/c/<token>, whose
 * preview X shows as the card) when the server signed one, the site's
 * otherwise. Opened in a new tab; nothing is posted until the person posts it.
 */
export const shareIntentUrl = (text: string, url: string = SHARE_SITE): string => `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;

// ── the card's link (owner, 10-22: "Enlace con vista previa") ───────────────

/**
 * THE LINKS OF ONE CARD, by background and unit: paths on this site, "/c/<token>".
 * A unit the card cannot show has none; a card with nothing saved has no unit,
 * and both name its one link.
 */
export type ShareLinks = Readonly<Record<ShareBackground, Readonly<Partial<Record<ShareUnit, string>>>>>;

/**
 * WHERE A DIALOG'S LINKS COME FROM. A Live page's: the server, asked once per
 * open with the pension key and the streak's proof (live-figures.ts
 * streakProofOf) — the key names whose figures to read and goes nowhere else.
 * The sample's: fixed pages, signed by nobody, because the sample's figures are
 * nobody's (/c/example, marked Example like its image). No source, no link:
 * Post on X shares the site and the image is pasted, as before.
 */
export type ShareLinkSource = { readonly kind: "live"; readonly owner: string; readonly proof: readonly string[] } | { readonly kind: "example" };

/** The sample's pages, one per background, dollars only — the image the dialog shows. Built at build time from the sample (app/c/example). */
export const EXAMPLE_SHARE_LINKS: ShareLinks = {
  grid: { usd: "/c/example" },
  streaks: { usd: "/c/example/streaks" },
  vault: { usd: "/c/example/vault" },
};

/** The link for what the dialog shows: its background, its unit — or, with nothing saved, whichever unit names it. */
export function shareLinkFor(links: ShareLinks, background: ShareBackground, unit: ShareUnit): string | null {
  const each = links[background];
  return each[unit] ?? each.usd ?? each.sol ?? null;
}

/** A card page's own picture: its path, then card.png at the renderer's version (lib/share-render-version.ts). */
export const shareImagePath = (page: string, version: string): string => `${page}/card.png?v=${version}`;

/**
 * "saverfi-pension-2026-10-22.png", or ".mp4" for the video: the day, and
 * nothing about whose. The sample's is "saverfi-example-…": a file found later
 * still says what it is.
 */
export const shareFileName = (card: ShareCardData, kind: "png" | "mp4" = "png"): string => `saverfi-${card.example ? "example" : "pension"}-${card.day}.${kind}`;

// ── what this browser can do with an image ───────────────────────────────────

export interface ShareCaps {
  /** Write a PNG to the clipboard (ClipboardItem). */
  readonly copy: boolean;
  /** Hand a PNG to the system's share sheet (navigator.share with files) — mainly phones. */
  readonly share: boolean;
  /**
   * Hand an MP4 to the same sheet. Asked on its own: a sheet that takes an
   * image need not take a video. Whether this browser can MAKE the video is
   * another, asynchronous question (live/share-video.ts videoCaps).
   */
  readonly shareVideo: boolean;
}

/** Just the parts of a browser's global scope this asks about, so a test can hand it one. */
export interface ShareScope {
  readonly navigator?: {
    readonly clipboard?: { readonly write?: unknown };
    readonly share?: unknown;
    readonly canShare?: (data: { files: File[] }) => boolean;
  };
  readonly ClipboardItem?: unknown;
  readonly File?: unknown;
}

/** Whether the system's sheet takes a file of this type; false wherever asking throws. */
function sheetTakes(scope: ShareScope, name: string, type: string): boolean {
  const nav = scope.navigator;
  if (typeof nav?.share !== "function" || typeof nav.canShare !== "function" || typeof scope.File !== "function") return false;
  try {
    const FileOf = scope.File as typeof File;
    return nav.canShare({ files: [new FileOf([new Uint8Array([0])], name, { type })] }) === true;
  } catch {
    return false;
  }
}

/**
 * WHICH ACTIONS TO OFFER: only the ones this browser can carry out. A button
 * that can only fail is worse than none — Download and Post on X always work,
 * so nobody is left without a way.
 */
export function shareCaps(scope: ShareScope): ShareCaps {
  const nav = scope.navigator;
  const Item = scope.ClipboardItem;
  // ClipboardItem.supports, where a browser has it, answers for the type itself.
  const supports = typeof Item === "function" ? (Item as { supports?: unknown }).supports : undefined;
  const copy =
    typeof Item === "function" &&
    typeof nav?.clipboard?.write === "function" &&
    (typeof supports !== "function" || (supports as (type: string) => unknown).call(Item, "image/png") === true);
  return { copy, share: sheetTakes(scope, "saverfi.png", "image/png"), shareVideo: sheetTakes(scope, "saverfi.mp4", "video/mp4") };
}
