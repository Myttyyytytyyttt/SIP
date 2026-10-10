"use client";

/**
 * WHAT IS ON ITS WAY, OVER THE FEED (owner, 2026-10-08).
 *
 * The steps come from src/lib/live-pending.ts. Each is drawn in the feed row's
 * own language (activity-row.tsx): the square on the left, the title, the
 * amount on the right, the same colours — grey for the machinery converting
 * and for anything resting, blue for a buy under way. The square is the shared
 * WorkMark (WorkMark.tsx): a turning mark for a step under way, a still glyph
 * for one that rests. A trading wallet the chain said changed, and not yet
 * saved from, leads the list ("Trading wallet 1: checking your latest
 * activity"): grey, with no amount, because nothing is known yet about what it
 * will save. Its title wraps instead of truncating: it has no amount beside
 * it, and in the 263 px column of the lg layout the one-line title lost its
 * last words.
 *
 * THE WHY IS ONE TAP AWAY, NOT UNDER THE TITLE (owner, 10-10: "tiene mucho
 * texto"). Every step carried a grey line under its title — what it waits
 * for, and how often SaverFi checks ("A saving follows once 0.001 SOL is owed…
 * · SaverFi checks about once a minute"). The row keeps its figures — the
 * title, the mark, the amount — and that sentence sits in a "?" beside the
 * title (info-tip.tsx: hover and tap, never takes focus, the sentence in its
 * screen-reader text). A DONE ROW DRAWS ITS TITLE ALONE TOO (review, 10-10):
 * its short line ("The USDC is in your vault") is said by the region when the
 * announcer did not speak it (saidOf), and a done row as tall as a step's
 * swaps in place without moving what is under it. A row's title and amount
 * are one line beside its 32 px square (a wallet's title may wrap), padded to
 * sit on the square's middle.
 *
 * A "?" THAT GOES HANDS ITS FOCUS ON (review, 10-10). The rows had nothing
 * focusable before; now every step has its "?", and a step can end on any sweep.
 * A focused "?" whose row turns done, turns heard, loses its sentence — or
 * whose row, or card, closes and goes inert — would drop focus to <body>, and
 * the next Tab would start again from the header. So it hands focus on first:
 * to the next "?" still usable in its copy, else the one before it, else the
 * copy's own box (tabIndex -1, never inert, never unmounted while the rows
 * live). Removed: the "?"'s own cleanup (Why), which runs before React takes
 * the node out. Made inert: the box's check after every commit (useFocusKept)
 * — a closing Reveal goes on drawing what it last held, so the row inside it
 * never learns it is leaving.
 *
 * THE REGION IS ITS OWN, AND HOLDS ONLY WORDS (10-10). A "?" is a button, and
 * no control may sit inside a live region (test/live-regions.ts) — so the rows
 * drawn are no longer the region. Beside them, visually hidden, a polite
 * region (SaidRegion) says what the rows made a screen reader hear while they
 * were it: each step's title, its sentence and its amount as spoken; a done
 * row only when the announcer did not speak it (toldBy); never a change heard,
 * never the heading, never a row on its way out (a closing Reveal is
 * aria-hidden, so it was never read either). One node per row, keyed by it:
 * a step that joins reaches the region as an addition, and a step whose words
 * change is a change of its text, as before. A screen reader browsing the page
 * meets the steps twice — the region's words, then the rows with their "?" —
 * the price of a region that holds no control.
 *
 * WHAT SOLANA SAID CHANGED LEADS BEFORE ANY UPDATE HAS (plan B3, 10-09). A
 * trading wallet's first activity since its last saving, or the vault's own
 * change, is a row from the moment the chain rings ("Activity seen on Trading
 * wallet 1 · checking", heard-lines.ts) — under the key the wallet's step takes
 * when the update lands, so the step's line replaces it in place, and the row
 * never closes and grows back. It goes through the same track as a step: it
 * grows in, and closes when `heard` clears with no step behind it. Its words
 * are not read out: what it becomes is (saidOf).
 *
 * THE HEADING SAYS WHAT THE ROWS ARE (10-09, G14): "In progress" while one is
 * under way, "Waiting" when every one rests — and NOTHING once no step stands
 * (review, 10-09): over the done rows alone, the held card's "Nothing in
 * progress right now", or steps the page can no longer confirm, either word
 * would be false. It closes then (a Reveal, in step with the idle line, so the
 * card swaps one line for the other). It is aria-hidden, and not in the
 * region: the steps are what the region speaks, and a heading that flips is
 * not news.
 *
 * HOW A STEP ENDS (10-09). The rows are drawn from a read that landed WHOLE
 * (use-whole-read.ts): its snapshot and its history in one commit, so a step
 * never vanishes over a row that has not arrived. When a step ends:
 *  * the read that ended it brought the transaction that did it — a conversion,
 *    a buy, no older than the step's own clock — so its row stays DONE_HOLD_MS as
 *    "Converted to USDC · 14:32 UTC" / "Bought SPYx and ANTHROPIC · 14:33 UTC"
 *    (the time it landed, its day too when not today), with a check in the
 *    step's tone. aria-hidden when the announcer spoke its transaction (step
 *    A5): the arrival is the feed's news, not this region's. When it did not
 *    — the arrival is not marked on the history's unreadable→readable edge
 *    (use-arrivals.ts) — the row says it itself (toldBy, review 10-09), in
 *    the region (saidOf): a step seen done must not go unsaid to a screen
 *    reader;
 *  * otherwise it simply closes (Reveal.tsx), over its last words. When unsure,
 *    nothing is claimed done.
 * A read whose history could not be read commits its snapshot alone, and
 * nothing is judged off it (plan B5): the rows stay as the last whole read drew
 * them. A step that newer snapshot no longer has as under way keeps its row,
 * DRAWN RESTING (review, 10-09: pendingViewOf) — the still clock, "Not
 * confirmed on this page yet", no "In progress" over it and no turning mark
 * beside Next investment — until a read lands whole and says what became of
 * it. No timer: once nothing claims the step is under way, holding its row is
 * honest. The track itself keeps the whole read's lines, so what a whole read
 * ends is still judged against them.
 *
 * THE REGION IS ALWAYS THERE, EMPTY OR NOT. A polite live region announces what
 * changes inside it, which needs it to exist before the change; it holds
 * nothing, and nothing is drawn, while no step is pending. What comes and goes
 * on screen grows and closes (Reveal.tsx): the rows' frame, and each row. The
 * turning mark stops for anyone who asked for reduced motion, and every growth
 * is an instant swap for them.
 *
 * TWO PLACES, ONE PER SCREEN WIDTH (LiveBody.tsx). From lg up the steps lead
 * the activity column. Below lg that column lives in a sheet nobody has opened,
 * so a "card" copy leads the page's own top instead — out of the flow while it
 * is empty (sr-only keeps the region inside it in the accessibility tree, so
 * the first step is still announced, without adding a gap to the column it
 * sits in). The card STAYS UP CARD_HOLD_MS after its last step ended — the
 * done rows while they hold, then "Nothing in progress right now" — and only
 * then closes, so the steps of one cycle, a minute or less apart, grow the
 * page once and shrink it once rather than two or three times.
 *
 * A CONVERTING ROW'S DOLLARS ARE NOT READ OUT. They are re-priced at every
 * read's SOL price, and in a live region every cent would be announced again;
 * the SOL, which only changes when the step does, is what is spoken
 * (PendingLine.amountSpoken) — by the region, and by the row to a screen reader
 * browsing it.
 *
 * ONE TRACK FOR EVERY COPY. The column is mounted twice (the aside and the
 * header's sheet) and the card once more; what has ended, and until when it is
 * held, is worked out once in LiveBody (usePendingView) and handed to each, so
 * no two copies hold a row on clocks of their own.
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";

import { InfoTip } from "@/components/info-tip";
import { REVEAL_MS, Reveal, revealFrameClass, revealLook, useRevealPhase } from "@/components/live/Reveal";
import { WorkMark, type WorkState } from "@/components/live/WorkMark";
import { MONO, TONE_TEXT, type Tone } from "@/lib/classes";
import { whenLabel } from "@/lib/format";
import { LIVE_COPY } from "@/lib/live-copy";
import { namesOf, type PendingKind, type PendingLine, type PendingStep } from "@/lib/live-pending";
import { symbolOfMint } from "@/lib/live-symbols";
import type { LiveDashboard, LiveRow } from "@/lib/live-types";
import { cn } from "@/lib/utils";

/** How long a step whose transaction landed stays on as "done". */
export const DONE_HOLD_MS = 4_000;
/** How long the below-lg card stays up after its last step ended. */
export const CARD_HOLD_MS = 60_000;

/**
 * WHAT A ROW STANDS FOR: one of the steps (live-pending.ts), or — "vault" — a
 * change Solana said the vault itself made, before an update brought it
 * (heard-lines.ts). A wallet's heard change is drawn as the "measuring" step it
 * becomes, under that step's key.
 */
export type RowKind = PendingKind | "vault";

/** A line as the rows draw it: a step's, or a change heard and not on the page yet (heard-lines.ts). */
export interface ShownLine extends Omit<PendingLine, "kind"> {
  readonly kind: RowKind;
  /** Heard, not yet read: no step stands behind it. Its words are not read out (Row). */
  readonly heard?: true;
  /**
   * Under way in the whole read, and not in the newer snapshot a read committed
   * without its history: drawn resting, its line saying the page cannot
   * confirm it (unconfirmedOf). Never in the track, only in what is drawn.
   */
  readonly unconfirmed?: true;
}

/** A step that just finished, as its row says it while it is held. */
export interface DoneLine {
  readonly key: string;
  readonly kind: PendingKind;
  readonly title: string;
  readonly sub: string;
  readonly tone: Tone;
  /** The landed transactions that ended it: whether the announcer spoke them decides who says it (toldBy). */
  readonly signatures: readonly string[];
}

/** One row as the list draws it: a step, or a step just done — either one on its way out. */
export type PendingRow =
  | { readonly show: "line"; readonly key: string; readonly kind: RowKind; readonly line: ShownLine; readonly still: boolean; readonly leaving: boolean }
  | {
      readonly show: "done";
      readonly key: string;
      readonly kind: PendingKind;
      readonly done: DoneLine;
      readonly leaving: boolean;
      /** False when the announcer did not speak its transaction, so the row says it (toldBy); spoken elsewhere when not given. */
      readonly told?: boolean;
    };

/** What every copy of the rows draws. */
export interface PendingView {
  /** The steps as they stand, from the whole read — and after them what was heard and no step has taken yet. */
  readonly lines: readonly ShownLine[];
  /** What is drawn: those steps, the ones just done, and the ones on their way out, in the steps' order. */
  readonly rows: readonly PendingRow[];
  /** The below-lg card is held up after its last step ended. */
  readonly held: boolean;
}

/** The steps alone, nothing held: a page's first paint, and every caller that tracks nothing. */
export function viewOf(lines: readonly ShownLine[]): PendingView {
  return { lines, rows: lines.map((line) => ({ show: "line", key: line.key, kind: line.kind, line, still: false, leaving: false })), held: false };
}

/** The transaction that ends each of the keeper's two steps. */
const ENDS: Readonly<Record<"converting" | "buying", LiveRow["event"]["kind"]>> = { converting: "converted", buying: "invested" };

/**
 * WHETHER A STEP THAT ENDED IS DONE, and how its row says so — or null, when
 * the read that ended it did not bring the transaction that did it: a
 * successful conversion (or buy) that was not on the page before, and is no
 * older than the step's own clock. A step that ended any other way — SOL
 * withdrawn, a switch turned off, a wallet whose check found nothing — is not
 * dressed as done. A wallet being checked has no "done": its saving is the
 * feed's own row.
 *
 * A BASKET IS BOUGHT ONE TRANSACTION PER LEG (solana-keeper invest-tick.ts), and
 * a turn can stop after some of them landed — the rest under the basket's
 * minimum, so the step is gone. The row names only the legs whose buy is on the
 * page, in the order they landed, as the announcer does (LiveAnnouncer.tsx) —
 * never the basket the step meant to buy (review, 10-09). A landed leg this app
 * cannot name: nothing is claimed.
 *
 * IT SAYS WHEN, as the row it is about does: the newest landed transaction's
 * time, dated against the read that brought it (format.ts whenLabel) — and no
 * time at all when the chain gave that transaction none.
 */
export function doneOf(step: PendingStep, key: string, after: LiveDashboard, before: LiveDashboard): DoneLine | null {
  if (step.kind === "measuring") return null;
  const kind = ENDS[step.kind];
  const known = new Set(before.rows.map((row) => row.signature));
  const landed = after.rows.filter(
    (row) =>
      row.ok &&
      row.event.kind === kind &&
      !known.has(row.signature) &&
      (step.since === null || (row.blockTime !== null && row.blockTime * 1_000 >= step.since)),
  );
  if (landed.length === 0) return null;
  const newest = landed.reduce((best, row) => (row.slot > best.slot ? row : best));
  const when = newest.blockTime === null ? null : whenLabel(newest.blockTime * 1_000, after.nowMs);
  const signatures = landed.map((row) => row.signature);
  if (step.kind === "converting") {
    const title = when === null ? LIVE_COPY.pendingDone.converted : LIVE_COPY.pendingDone.convertedAt(when);
    return { key, kind: step.kind, title, sub: LIVE_COPY.pendingDone.convertedSub, tone: "quiet", signatures };
  }
  // Every landed row is a buy here, so `names` is never empty: namesOf never falls back to "your basket".
  const names: string[] = [];
  for (const row of [...landed].sort((left, right) => left.slot - right.slot)) {
    if (row.event.kind !== "invested") continue;
    const symbol = row.event.symbol ?? symbolOfMint(row.event.mint);
    if (symbol === null) return null;
    if (!names.includes(symbol)) names.push(symbol);
  }
  const title = when === null ? LIVE_COPY.pendingDone.bought(namesOf(names)) : LIVE_COPY.pendingDone.boughtAt(namesOf(names), when);
  return { key, kind: step.kind, title, sub: LIVE_COPY.pendingDone.boughtSub, tone: "invest", signatures };
}

type Leaving = { readonly show: "line"; readonly line: ShownLine } | { readonly show: "done"; readonly done: DoneLine };

/** What the list remembers between whole reads: the steps it last drew, and what it holds, until when (browser ms). */
export interface PendingTrack {
  readonly data: LiveDashboard;
  /**
   * The whole read's steps, and their lines — one line per step, in the same
   * order (live-pending.ts pendingLines) — then the heard lines no step has
   * taken, which have no step: past the last one, each closes when it ends.
   */
  readonly steps: readonly PendingStep[];
  readonly lines: readonly ShownLine[];
  /** The heard lines as last given, to tell a change in them from none. */
  readonly heard: readonly ShownLine[];
  readonly done: ReadonlyMap<string, { readonly row: DoneLine; readonly until: number }>;
  readonly leaving: ReadonlyMap<string, { readonly row: Leaving; readonly until: number }>;
  /** Until when the card stays up with no step on it; null when it is not held. */
  readonly cardUntil: number | null;
}

export interface PendingInput {
  readonly data: LiveDashboard;
  readonly steps: readonly PendingStep[];
  readonly lines: readonly PendingLine[];
  /**
   * What Solana said changed and the whole read does not draw yet
   * (heard-lines.ts heardLinesOf), each under the key its step will take. A
   * step's own line under the same key wins. None when not given.
   */
  readonly heard?: readonly ShownLine[];
}

const NO_LINES: readonly ShownLine[] = [];

/** The steps' lines, then every heard line whose key no step has. */
export function withHeard(lines: readonly ShownLine[], heard: readonly ShownLine[]): readonly ShownLine[] {
  if (heard.length === 0) return lines;
  const keys = new Set(lines.map((line) => line.key));
  return [...lines, ...heard.filter((line) => !keys.has(line.key))];
}

const sameLine = (a: ShownLine, b: ShownLine): boolean =>
  a.key === b.key &&
  a.kind === b.kind &&
  a.active === b.active &&
  a.rest === b.rest &&
  a.title === b.title &&
  a.sub === b.sub &&
  a.amount === b.amount &&
  a.amountSpoken === b.amountSpoken &&
  a.heard === b.heard;

/** Whether two lists of lines say the same: heard lines are made afresh at every render. */
export const sameLines = (a: readonly ShownLine[], b: readonly ShownLine[]): boolean => a.length === b.length && a.every((line, index) => sameLine(line, b[index]!));

export function startTrack(input: PendingInput): PendingTrack {
  const heard = input.heard ?? NO_LINES;
  return { data: input.data, steps: input.steps, lines: withHeard(input.lines, heard), heard, done: new Map(), leaving: new Map(), cardUntil: null };
}

/**
 * The track after a new whole read, or a change in what was heard, at
 * browser time `now`: what ended is held as done or sent on its way out, a step
 * that is back takes its row back, and the card's minute starts when its last
 * step ends. A heard line its step takes over keeps its row: same key, nothing
 * ended (heard-lines.ts).
 */
export function advancePending(track: PendingTrack, next: PendingInput, now: number): PendingTrack {
  const heard = next.heard ?? NO_LINES;
  if (next.data === track.data && sameLines(heard, track.heard)) return track;
  const lines = withHeard(next.lines, heard);
  const keys = new Set(lines.map((line) => line.key));
  const done = new Map(track.done);
  const leaving = new Map(track.leaving);
  // A step back on screen takes its row back: no "done" and no exit over a live line.
  for (const key of keys) {
    done.delete(key);
    leaving.delete(key);
  }
  track.lines.forEach((line, index) => {
    if (keys.has(line.key)) return;
    // A heard line sits past the last step, so it has none: it simply closes.
    const step = track.steps[index];
    const finished = step === undefined ? null : doneOf(step, line.key, next.data, track.data);
    if (finished !== null) done.set(line.key, { row: finished, until: now + DONE_HOLD_MS });
    else leaving.set(line.key, { row: { show: "line", line }, until: now + REVEAL_MS });
  });
  const cardUntil = lines.length > 0 ? null : track.lines.length > 0 ? now + CARD_HOLD_MS : track.cardUntil;
  return { data: next.data, steps: next.steps, lines, heard, done, leaving, cardUntil };
}

/** What is still held at `now`: a done whose time ran out closes in its turn, and the same track back when nothing was due. */
export function releasePending(track: PendingTrack, now: number): PendingTrack {
  let changed = false;
  const leaving = new Map(track.leaving);
  for (const [key, held] of track.leaving) {
    if (held.until > now) continue;
    leaving.delete(key);
    changed = true;
  }
  const done = new Map(track.done);
  for (const [key, held] of track.done) {
    if (held.until > now) continue;
    done.delete(key);
    leaving.set(key, { row: { show: "done", done: held.row }, until: now + REVEAL_MS });
    changed = true;
  }
  const cardDue = track.cardUntil !== null && track.cardUntil <= now;
  if (!changed && !cardDue) return track;
  return { ...track, done, leaving, cardUntil: cardDue ? null : track.cardUntil };
}

/** When the next hold lets go, or null when nothing is held. */
export function nextDue(track: PendingTrack): number | null {
  const times = [...[...track.done.values()].map((held) => held.until), ...[...track.leaving.values()].map((held) => held.until)];
  if (track.cardUntil !== null) times.push(track.cardUntil);
  return times.length === 0 ? null : Math.min(...times);
}

/**
 * THE STEPS THE PAGE IS NO LONGER SURE OF: under way in the whole read the
 * rows are drawn from, and not under way in the newer snapshot a read
 * committed without its history (use-whole-read.ts). They are drawn resting
 * (unconfirmedOf) until a read lands whole. Empty while the newest read is the
 * whole one.
 */
export function stillOf(drawn: readonly ShownLine[], latest: readonly ShownLine[]): ReadonlySet<string> {
  const turning = new Set(latest.filter((line) => line.active).map((line) => line.key));
  return new Set(drawn.filter((line) => line.active && !turning.has(line.key)).map((line) => line.key));
}

/**
 * A STEP THE PAGE CAN NO LONGER CONFIRM, AS IT IS DRAWN (review, 10-09). The
 * hold itself is right — a read with no history can neither time a new step
 * nor say how an old one ended — but its words were not: the line went on
 * saying "Converting SOL to USDC" under "In progress", beside a turning mark at
 * Next investment, for as long as the history failed, with nothing current
 * behind it. Now it rests: the still clock of a wait (the convention a change
 * heard uses while behind, heard-lines.ts), grey, and the doubt in its line.
 * Its title stays the step's name; nothing says it ended either.
 */
export function unconfirmedOf(line: ShownLine): ShownLine {
  return { ...line, active: false, rest: "slow", sub: LIVE_COPY.pendingUnconfirmed, unconfirmed: true };
}

/**
 * WHAT EVERY COPY DRAWS FROM THE TRACK: its lines — each one the newest
 * snapshot no longer has under way drawn resting (unconfirmedOf) — the rows
 * made from them, and whether the card is held. Only the drawing changes: the
 * track keeps the whole read's own lines, so what the next whole read ends is
 * judged against them (advancePending, doneOf).
 */
export function pendingViewOf(track: PendingTrack, latest: readonly ShownLine[]): PendingView {
  const still = stillOf(track.lines, latest);
  const lines = still.size === 0 ? track.lines : track.lines.map((line) => (still.has(line.key) ? unconfirmedOf(line) : line));
  return { lines, rows: pendingRowsOf({ ...track, lines }, still), held: track.cardUntil !== null };
}

/**
 * WHO SAYS A STEP IS DONE (review, 10-09). A done row is aria-hidden on the
 * premise that the announcer spoke its transaction (use-arrivals.ts). That
 * premise fails on the history's unreadable→readable edge, where no arrival is
 * marked: the row was drawn done and nobody said it. So a done row whose
 * transactions are not among `arrived` is `told: false`, and says it itself
 * (Row). The same view back when no row is done.
 */
export function toldBy(view: PendingView, arrived: ReadonlySet<string>): PendingView {
  if (!view.rows.some((row) => row.show === "done")) return view;
  return {
    ...view,
    rows: view.rows.map((row) => (row.show === "done" ? { ...row, told: row.done.signatures.some((signature) => arrived.has(signature)) } : row)),
  };
}

const RANK: Readonly<Record<RowKind, number>> = { measuring: 0, vault: 1, converting: 2, buying: 3 };

/**
 * The rows in the steps' own order — a wallet being checked, then a change
 * heard on the vault, then converting, then buying — each held row where its
 * step stood.
 */
export function pendingRowsOf(track: PendingTrack, still: ReadonlySet<string>): PendingRow[] {
  const rows: PendingRow[] = track.lines.map((line) => ({ show: "line", key: line.key, kind: line.kind, line, still: still.has(line.key), leaving: false }));
  for (const [key, held] of track.done) rows.push({ show: "done", key, kind: held.row.kind, done: held.row, leaving: false });
  for (const [key, held] of track.leaving) {
    rows.push(
      held.row.show === "line"
        ? { show: "line", key, kind: held.row.line.kind, line: held.row.line, still: true, leaving: true }
        : { show: "done", key, kind: held.row.done.kind, done: held.row.done, leaving: true },
    );
  }
  // Stable: rows of one kind keep the order they were pushed in.
  return rows.sort((a, b) => RANK[a.kind] - RANK[b.kind]);
}

/**
 * THE TRACK, ONCE FOR THE PAGE (LiveBody). `data` is the whole read and
 * `steps`/`lines` its steps, `heard` what Solana said changed and no step
 * draws yet; `latest` is the newest snapshot's lines, for the steps the page
 * can no longer confirm (pendingViewOf). A new whole read, or a change in
 * what was heard, is worked out during the render, so a step that ended is
 * drawn done or leaving in the very frame its line would otherwise vanish
 * from; one timer lets go of whatever is due first.
 */
export function usePendingView(input: PendingInput & { readonly latest: readonly PendingLine[] }): PendingView {
  const [track, setTrack] = useState<PendingTrack>(() => startTrack(input));
  // The same track back while nothing moved: no render is asked for.
  const current = advancePending(track, input, Date.now());
  if (current !== track) setTrack(current);

  const due = nextDue(current);
  useEffect(() => {
    if (due === null) return;
    // Released as at `due` at the least: a timer may wake a millisecond early (use-hold.ts).
    const timer = setTimeout(() => setTrack((held) => releasePending(held, Math.max(Date.now(), due))), Math.max(0, due - Date.now()));
    return () => clearTimeout(timer);
  }, [due]);

  // A heard line turns for as long as it is heard: it is in the newest as well.
  return pendingViewOf(current, withHeard(input.latest, input.heard ?? NO_LINES));
}

/** The mark a step wears: under way, resting on a slow keeper, or held for a reason the row states. */
export function workStateOf(line: ShownLine): WorkState {
  if (line.active) return "active";
  return line.rest === "slow" ? "slow" : "held";
}

/** Blue is a buy, and only a buy under way wears it; the conversion, and anything resting, is the machinery's grey. */
const toneOf = (line: ShownLine): Tone => (line.active && line.kind === "buying" ? "invest" : "quiet");

/**
 * The heading over the rows: under way if one is, waiting if every step rests,
 * and none with no step at all — done rows alone, or a card held up over
 * nothing, are neither in progress nor waiting. A step the page can no longer
 * confirm (unconfirmedOf) is neither either: over such rows alone, nothing.
 */
export function headingOf(lines: readonly ShownLine[]): string | null {
  const known = lines.filter((line) => line.unconfirmed !== true);
  if (known.length === 0) return null;
  return known.some((line) => line.active) ? LIVE_COPY.pendingHeading.active : LIVE_COPY.pendingHeading.waiting;
}

/** The copy's own box: it never goes inert, and stays mounted while the rows live (Column, TopCard). */
const BOX = "[data-pending-steps]";

/**
 * Focus, held in `from`, handed on before `from` goes: to the next "?" still
 * usable in the copy, else the one before it, else the box. Never to a "?" in
 * `from` itself, nor in anything inert — a row, or the card, closing.
 */
function handOff(from: Element): void {
  const box = from.closest<HTMLElement>(BOX);
  if (box === null) return;
  const usable = [...box.querySelectorAll<HTMLElement>("[data-pending-why] button")].filter(
    (button) => !from.contains(button) && button.closest("[inert]") === null,
  );
  const next = usable.find((button) => (from.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) ?? usable.at(-1);
  if (next === undefined) box.focus({ preventScroll: true });
  else next.focus();
}

/**
 * A copy's box, checked after every commit: focus inside it, on something that
 * just went inert — a row closing, the frame closing after the last step, the
 * card closing — is handed on before the browser drops it to <body>. Inside
 * this effect the button still holds it: Chrome lets go of focus in an inert
 * subtree only at its next rendering step (measured, 10-10).
 */
function useFocusKept(box: RefObject<HTMLDivElement | null>): void {
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (box.current === null || active === null || active === box.current || !box.current.contains(active)) return;
    if (active.closest("[inert]") !== null) handOff(active);
  });
}

/**
 * A step's "?": the sentence that was its grey line (owner, 10-10). Unmounted
 * — its row turned done, or heard, or lost its sentence — it hands its focus
 * on in a layout cleanup, which React runs before it takes the node out.
 */
function Why({ sub }: { readonly sub: string }) {
  const at = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const node = at.current;
    return () => {
      if (node !== null && node.contains(document.activeElement)) handOff(node);
    };
  }, []);
  return (
    <span ref={at} className="contents" data-pending-why="">
      <InfoTip label={LIVE_COPY.pendingWhy} className="mt-0.5">
        {sub}
      </InfoTip>
    </span>
  );
}

function Row({ row }: { readonly row: PendingRow }) {
  if (row.show === "done") {
    const { done } = row;
    return (
      // Not read out when the announcer spoke its transaction (step A5): the feed's own row is the news. When it did not, it is read, and the region says it (toldBy, saidOf).
      <div className="flex w-full items-start gap-3 px-4 py-2.5" data-pending-done={done.kind} {...(row.told === false ? {} : { "aria-hidden": true })}>
        <WorkMark state="done" tone={done.tone} />
        {/*
          Its title alone (review, 10-10): its line is the region's to say, and
          only when the announcer did not. No "?" either: the row is aria-hidden
          while the announcer speaks it, and a button never sits inside
          aria-hidden. Wraps rather than truncating: at the lg column's 263 px
          the time at its end is what a cut would lose.
        */}
        <span className="min-w-0 flex-1 py-1.5 text-sm break-words">{done.title}</span>
      </div>
    );
  }
  const { line } = row;
  const heard = line.heard === true;
  return (
    <div
      className="flex w-full items-start gap-3 px-4 py-2.5"
      data-pending-step={line.kind}
      data-state={line.active ? "active" : "waiting"}
      {...(heard ? { "data-pending-heard": "" } : {})}
    >
      <WorkMark state={workStateOf(line)} tone={toneOf(line)} still={row.still} />
      {/*
        THE WHY IS IN THE "?", NOT UNDER THE TITLE (owner, 10-10: "tiene mucho
        texto"). The step's sentence — what it waits for, and how often SaverFi
        checks — sits in the "?" beside the title; the row keeps its title, its
        mark and its amount. A CHANGE HEARD IS NOT READ OUT (heard-lines.ts):
        what it becomes is, and the region says it as it joins (saidOf). Its
        words stay aria-hidden, and a button must never sit inside aria-hidden,
        so a heard line carries no "?" at all. ONE LINE ON THE SQUARE'S MIDDLE
        (review, 10-10): with the grey line gone the title and the amount are
        one 20 px line each, padded 6 px so it sits level with the 32 px
        square's glyph; a title that wraps still starts on that line.
      */}
      <span className="flex min-w-0 flex-1 items-start gap-1.5 py-1.5" {...(heard ? { "aria-hidden": true } : {})}>
        {/* A wallet's line and the vault's carry no amount beside them: they wrap rather than lose their last words. */}
        <span className={cn("min-w-0 text-sm", line.kind === "measuring" || line.kind === "vault" ? "break-words" : "truncate")}>{line.title}</span>
        {heard || line.sub === "" ? null : <Why sub={line.sub} />}
      </span>
      <span className={cn("shrink-0 py-1.5 text-right text-sm", MONO, TONE_TEXT[toneOf(line)])} {...(line.amountSpoken === null ? {} : { "aria-hidden": true })}>
        {line.amount}
      </span>
      {line.amountSpoken ? <span className="sr-only">{line.amountSpoken}</span> : null}
    </div>
  );
}

/**
 * The rows, each in its own Reveal: one that joins a list already drawn grows
 * in, one that ends closes. What is there when this copy mounts is simply there.
 */
function Rows({ rows }: { readonly rows: readonly PendingRow[] }) {
  const seen = useRef<ReadonlySet<string> | null>(null);
  const before = seen.current;
  useEffect(() => {
    seen.current = new Set(rows.map((row) => row.key));
  });
  return rows.map((row) => (
    <Reveal key={row.key} open={!row.leaving} appear={before !== null && !before.has(row.key)}>
      <Row row={row} />
    </Reveal>
  ));
}

/** The heading and the rows — and, on a card held up with none, the line that says so. */
function Body({ view, card, className }: { readonly view: PendingView; readonly card: boolean; readonly className?: string }) {
  const idle = card && view.rows.every((row) => row.leaving);
  const heading = headingOf(view.lines);
  return (
    <div className={cn(card && "overflow-hidden rounded-md border bg-card", className) || undefined}>
      {/* No `appear`: a heading there on the first paint is simply there. It closes over its last word. */}
      <Reveal open={heading !== null}>
        <div className="px-4 py-2 text-xs text-muted-foreground" aria-hidden>
          {heading}
        </div>
      </Reveal>
      <Rows rows={view.rows} />
      {card ? (
        <Reveal open={idle} appear>
          {/* Not read out: the steps ending was the news. */}
          <p className="px-4 pt-0.5 pb-3 text-sm text-muted-foreground" aria-hidden>
            {LIVE_COPY.pendingIdle}
          </p>
        </Reveal>
      ) : null}
    </div>
  );
}

const standing = (view: PendingView): boolean => view.rows.some((row) => !row.leaving);

/** One row as the region says it: a node of its own, keyed by the row, and its words in the order the row gave them. */
export interface SaidRow {
  readonly key: string;
  readonly words: readonly string[];
}

/**
 * WHAT THE REGION SAYS (10-10): word for word what the rows made a screen
 * reader hear while they were the region.
 *  * A STEP: its title, its sentence (on screen, in the "?"), then its amount
 *    as spoken — the SOL in place of a conversion's re-priced dollars
 *    (amountSpoken), nothing for an amount the row kept to itself (""), the
 *    amount as drawn when nothing is said in its place (null).
 *  * A DONE ROW: its title and its line, only when the announcer did not
 *    speak its transaction (toldBy: `told: false`). Otherwise it was
 *    aria-hidden, and it still is.
 *  * NEVER a change heard (heard-lines.ts: what it becomes is said), nor a row
 *    on its way out: its Reveal is aria-hidden while it closes.
 * A done row is keyed apart from the step it ends: its words join the region
 * as an addition, never as the step's words rewritten.
 */
export function saidOf(rows: readonly PendingRow[]): readonly SaidRow[] {
  const said: SaidRow[] = [];
  for (const row of rows) {
    if (row.leaving) continue;
    if (row.show === "done") {
      if (row.told === false) said.push({ key: `done:${row.key}`, words: [row.done.title, row.done.sub] });
      continue;
    }
    const { line } = row;
    if (line.heard === true) continue;
    said.push({ key: row.key, words: [line.title, line.sub, line.amountSpoken ?? line.amount].filter((part) => part !== "") });
  }
  return said;
}

/**
 * THE POLITE REGION, VISUALLY HIDDEN AND MADE OF WORDS ONLY: no "?", no
 * button, no mark, no count that ticks (test/live-regions.ts). Always
 * mounted, empty or not, so the first step is an addition to a region that
 * was already there.
 */
function SaidRegion({ rows }: { readonly rows: readonly PendingRow[] }) {
  return (
    <div role="status" aria-live="polite" className="sr-only" data-pending-region="">
      {saidOf(rows).map((row) => (
        <p key={row.key}>
          {row.words.map((part, index) => (
            <span key={index} className="block">
              {part}
            </span>
          ))}
        </p>
      ))}
    </div>
  );
}

/**
 * In the column: the frame grows when the first step comes and closes after
 * the last. The region sits beside it, out of the flow (sr-only), so it never
 * holds a gap open, and outside the frame's Reveal, which is aria-hidden while
 * it closes. The box takes focus from a "?" that goes (handOff): tabIndex -1,
 * so a script can focus it and Tab never stops on it.
 */
function Column({ view, announce, className, innerClassName }: { readonly view: PendingView; readonly announce: boolean; readonly className?: string; readonly innerClassName?: string }) {
  const box = useRef<HTMLDivElement>(null);
  useFocusKept(box);
  return (
    <div ref={box} className={cn("outline-none", className)} tabIndex={-1} data-pending-steps={view.lines.length}>
      <Reveal open={standing(view)}>
        <Body view={view} card={false} {...(innerClassName === undefined ? {} : { className: innerClassName })} />
      </Reveal>
      {announce ? <SaidRegion rows={view.rows} /> : null}
    </div>
  );
}

/**
 * ON THE PAGE'S TOP, BELOW lg: the card's own box holds the region, beside its
 * content and outside the part that goes inert while it closes, so the box can
 * be out of the flow (sr-only) while closed with the region still there to
 * announce, and take its `gap-4` back while it grows and closes — a Reveal
 * inside it would leave the box in the column, holding the gap open over
 * nothing. The region is absolutely placed (sr-only): it takes no cell of the
 * box's grid, and no height. The box is also what takes focus from a "?" when
 * the card closes under it (handOff): it only turns sr-only, it never goes.
 */
function TopCard({ view, announce, className }: { readonly view: PendingView; readonly announce: boolean; readonly className?: string }) {
  const open = standing(view) || view.held;
  const phase = useRevealPhase(open);
  const look = revealLook(open, phase);
  const body = <Body view={view} card />;
  // What it showed last while open, so it closes over its content.
  const last = useRef<ReactNode>(body);
  if (open) last.current = body;
  const box = useRef<HTMLDivElement>(null);
  useFocusKept(box);
  return (
    <div
      ref={box}
      // The first collapsed frame after sr-only does not transition: there is nothing to move from.
      className={cn(look === "gone" ? "sr-only" : revealFrameClass({ grown: look === "grown", inGap: true, still: open && phase === "closed" }), "outline-none", className)}
      tabIndex={-1}
      data-pending-steps={view.lines.length}
    >
      {look === "gone" ? null : (
        <div className={cn("min-h-0 min-w-0", (!open || phase !== "open") && "overflow-hidden")} {...(open ? {} : { inert: true, "aria-hidden": true })}>
          {open ? body : last.current}
        </div>
      )}
      {announce ? <SaidRegion rows={view.rows} /> : null}
    </div>
  );
}

export function PendingRows({
  lines,
  view,
  className,
  innerClassName,
  announce = true,
  variant = "column",
}: {
  /** The steps as they stand, and what was heard and no step draws yet. */
  readonly lines: readonly ShownLine[];
  /** What to draw, with what has just ended (usePendingView); the steps alone when not given. */
  readonly view?: PendingView;
  readonly className?: string;
  /** The column's rows box, drawn only while there are rows: /activity's divider under them. */
  readonly innerClassName?: string;
  /** "card": framed, for the top of the page below lg, and out of the flow while empty. */
  readonly variant?: "column" | "card";
  /**
   * False for a copy drawn beside another that already announces: on /activity
   * the sidebar and the page's own list show the same steps at once, and one
   * change read out twice is noise. Such a copy has no region at all.
   */
  readonly announce?: boolean;
}) {
  const shown = view ?? viewOf(lines);
  if (variant === "card") return <TopCard view={shown} announce={announce} {...(className === undefined ? {} : { className })} />;
  return (
    <Column
      view={shown}
      announce={announce}
      {...(className === undefined ? {} : { className })}
      {...(innerClassName === undefined ? {} : { innerClassName })}
    />
  );
}
