"use client";

/**
 * WHAT IS ON ITS WAY, OVER THE FEED (owner, 2026-10-08).
 *
 * The steps come from src/lib/live-pending.ts. Each is drawn in the feed row's
 * own language (activity-row.tsx): the square on the left, the title and its
 * line, the amount on the right, the same colours — grey for the machinery
 * converting and for anything resting, blue for a buy under way. The square is
 * the shared WorkMark (WorkMark.tsx): a turning mark for a step under way, a
 * still glyph for one that rests, beside the words that say why. A trading
 * wallet the chain said changed, and not yet saved from, leads the list
 * ("Trading wallet 1: checking your latest activity"): grey, with no amount, because
 * nothing is known yet about what it will save. Its title wraps instead of
 * truncating: it has no amount beside it, and in the 263 px column of the lg
 * layout the one-line title lost its last words.
 *
 * THE HEADING SAYS WHAT THE ROWS ARE (10-09, G14): "In progress" while one is
 * under way, "Waiting" when every one rests — and NOTHING once no step stands
 * (review, 10-09): over the done rows alone, or the held card's "Nothing in
 * progress right now", either word would be false. It closes then (a Reveal,
 * in step with the idle line, so the card swaps one line for the other). It
 * is aria-hidden: the rows are what the region speaks, and a heading that
 * flips is not news.
 *
 * HOW A STEP ENDS (10-09). The rows read a SETTLED view (use-read-settled.ts):
 * a read's snapshot lands before its history, and a step must not vanish over
 * a row that has not arrived. When a step ends:
 *  * the read that ended it brought the transaction that did it — a conversion,
 *    a buy, no older than the step's own clock — so its row stays DONE_HOLD_MS as
 *    "Converted to USDC · 14:32 UTC" / "Bought SPYx and ANTHROPIC · 14:33 UTC"
 *    (the time it landed, its day too when not today), with a check in the
 *    step's tone. aria-hidden: the arrival is the feed's news, not this
 *    region's (the announcer, step A5, speaks it);
 *  * otherwise it simply closes (Reveal.tsx), over its last words. When unsure,
 *    nothing is claimed done.
 * Until a read settles — at most READ_SETTLE_MS — a step the newer snapshot no
 * longer has as under way keeps its row, its loader standing still: the page
 * is no longer sure it turns.
 *
 * THE REGION IS ALWAYS THERE, EMPTY OR NOT. A polite live region announces what
 * changes inside it, which needs it to exist before the change; it holds
 * nothing and draws nothing while no step is pending. What comes and goes
 * inside it grows and closes (Reveal.tsx): the rows' frame, and each row. The
 * turning mark stops for anyone who asked for reduced motion, and every growth
 * is an instant swap for them.
 *
 * TWO PLACES, ONE PER SCREEN WIDTH (LiveBody.tsx). From lg up the steps lead
 * the activity column. Below lg that column lives in a sheet nobody has opened,
 * so a "card" copy leads the page's own top instead — out of the flow while it
 * is empty (sr-only keeps the region in the accessibility tree, so the first
 * step is still announced, without adding a gap to the column it sits in). The
 * card STAYS UP CARD_HOLD_MS after its last step ended — the done rows while
 * they hold, then "Nothing in progress right now" — and only then closes, so
 * the steps of one cycle, a minute or less apart, grow the page once and
 * shrink it once rather than two or three times.
 *
 * A CONVERTING ROW'S DOLLARS ARE NOT READ OUT. They are re-priced at every
 * read's SOL price, and inside a live region every cent would be announced
 * again; the SOL, which only changes when the step does, is what is spoken
 * (PendingLine.amountSpoken).
 *
 * ONE TRACK FOR EVERY COPY. The column is mounted twice (the aside and the
 * header's sheet) and the card once more; what has ended, and until when it is
 * held, is worked out once in LiveBody (usePendingView) and handed to each, so
 * no two copies hold a row on clocks of their own.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";

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

/** A step that just finished, as its row says it while it is held. */
export interface DoneLine {
  readonly key: string;
  readonly kind: PendingKind;
  readonly title: string;
  readonly sub: string;
  readonly tone: Tone;
}

/** One row as the list draws it: a step, or a step just done — either one on its way out. */
export type PendingRow =
  | { readonly show: "line"; readonly key: string; readonly kind: PendingKind; readonly line: PendingLine; readonly still: boolean; readonly leaving: boolean }
  | { readonly show: "done"; readonly key: string; readonly kind: PendingKind; readonly done: DoneLine; readonly leaving: boolean };

/** What every copy of the rows draws. */
export interface PendingView {
  /** The steps as they stand, from the settled read. */
  readonly lines: readonly PendingLine[];
  /** What is drawn: those steps, the ones just done, and the ones on their way out, in the steps' order. */
  readonly rows: readonly PendingRow[];
  /** The below-lg card is held up after its last step ended. */
  readonly held: boolean;
}

/** The steps alone, nothing held: a page's first paint, and every caller that tracks nothing. */
export function viewOf(lines: readonly PendingLine[]): PendingView {
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
  if (step.kind === "converting") {
    const title = when === null ? LIVE_COPY.pendingDone.converted : LIVE_COPY.pendingDone.convertedAt(when);
    return { key, kind: step.kind, title, sub: LIVE_COPY.pendingDone.convertedSub, tone: "quiet" };
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
  return { key, kind: step.kind, title, sub: LIVE_COPY.pendingDone.boughtSub, tone: "invest" };
}

type Leaving = { readonly show: "line"; readonly line: PendingLine } | { readonly show: "done"; readonly done: DoneLine };

/** What the list remembers between settled reads: the steps it last drew, and what it holds, until when (browser ms). */
export interface PendingTrack {
  readonly data: LiveDashboard;
  /** The settled steps, and their lines — one line per step, in the same order (live-pending.ts pendingLines). */
  readonly steps: readonly PendingStep[];
  readonly lines: readonly PendingLine[];
  readonly done: ReadonlyMap<string, { readonly row: DoneLine; readonly until: number }>;
  readonly leaving: ReadonlyMap<string, { readonly row: Leaving; readonly until: number }>;
  /** Until when the card stays up with no step on it; null when it is not held. */
  readonly cardUntil: number | null;
}

export interface PendingInput {
  readonly data: LiveDashboard;
  readonly steps: readonly PendingStep[];
  readonly lines: readonly PendingLine[];
}

export function startTrack(input: PendingInput): PendingTrack {
  return { data: input.data, steps: input.steps, lines: input.lines, done: new Map(), leaving: new Map(), cardUntil: null };
}

/**
 * The track after a new settled read, at browser time `now`: what ended is
 * held as done or sent on its way out, a step that is back takes its row back,
 * and the card's minute starts when its last step ends.
 */
export function advancePending(track: PendingTrack, next: PendingInput, now: number): PendingTrack {
  if (next.data === track.data) return track;
  const keys = new Set(next.lines.map((line) => line.key));
  const done = new Map(track.done);
  const leaving = new Map(track.leaving);
  // A step back on screen takes its row back: no "done" and no exit over a live line.
  for (const key of keys) {
    done.delete(key);
    leaving.delete(key);
  }
  track.lines.forEach((line, index) => {
    if (keys.has(line.key)) return;
    const step = track.steps[index];
    const finished = step === undefined ? null : doneOf(step, line.key, next.data, track.data);
    if (finished !== null) done.set(line.key, { row: finished, until: now + DONE_HOLD_MS });
    else leaving.set(line.key, { row: { show: "line", line }, until: now + REVEAL_MS });
  });
  const cardUntil = next.lines.length > 0 ? null : track.lines.length > 0 ? now + CARD_HOLD_MS : track.cardUntil;
  return { data: next.data, steps: next.steps, lines: next.lines, done, leaving, cardUntil };
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
 * THE STEPS THE PAGE IS NO LONGER SURE OF: under way in the settled read, and
 * not under way in the newer snapshot whose history has not landed. Their
 * loader stands still until the read settles. Empty once it has.
 */
export function stillOf(settled: readonly PendingLine[], latest: readonly PendingLine[]): ReadonlySet<string> {
  const turning = new Set(latest.filter((line) => line.active).map((line) => line.key));
  return new Set(settled.filter((line) => line.active && !turning.has(line.key)).map((line) => line.key));
}

const RANK: Readonly<Record<PendingKind, number>> = { measuring: 0, converting: 1, buying: 2 };

/** The rows in the steps' own order — a wallet being checked, then converting, then buying — each held row where its step stood. */
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
 * THE TRACK, ONCE FOR THE PAGE (LiveBody). `data` is the settled read and
 * `steps`/`lines` its steps; `latest` is the newest snapshot's lines, for the
 * loaders the page is no longer sure of. A new settled read is worked out
 * during the render, so a step that ended is drawn done or leaving in the very
 * frame its line would otherwise vanish from; one timer lets go of whatever is
 * due first.
 */
export function usePendingView(input: PendingInput & { readonly latest: readonly PendingLine[] }): PendingView {
  const [track, setTrack] = useState<PendingTrack>(() => startTrack(input));
  let current = track;
  if (input.data !== track.data) {
    current = advancePending(track, input, Date.now());
    setTrack(current);
  }

  const due = nextDue(current);
  useEffect(() => {
    if (due === null) return;
    // Released as at `due` at the least: a timer may wake a millisecond early (use-hold.ts).
    const timer = setTimeout(() => setTrack((held) => releasePending(held, Math.max(Date.now(), due))), Math.max(0, due - Date.now()));
    return () => clearTimeout(timer);
  }, [due]);

  return { lines: current.lines, rows: pendingRowsOf(current, stillOf(current.lines, input.latest)), held: current.cardUntil !== null };
}

/** The mark a step wears: under way, resting on a slow keeper, or held for a reason the row states. */
export function workStateOf(line: PendingLine): WorkState {
  if (line.active) return "active";
  return line.rest === "slow" ? "slow" : "held";
}

/** Blue is a buy, and only a buy under way wears it; the conversion, and anything resting, is the machinery's grey. */
const toneOf = (line: PendingLine): Tone => (line.active && line.kind === "buying" ? "invest" : "quiet");

/**
 * The heading over the rows: under way if one is, waiting if every step rests,
 * and none with no step at all — done rows alone, or a card held up over
 * nothing, are neither in progress nor waiting.
 */
export function headingOf(lines: readonly PendingLine[]): string | null {
  if (lines.length === 0) return null;
  return lines.some((line) => line.active) ? LIVE_COPY.pendingHeading.active : LIVE_COPY.pendingHeading.waiting;
}

function Row({ row }: { readonly row: PendingRow }) {
  if (row.show === "done") {
    const { done } = row;
    return (
      // Not read out: the feed's own row is the news (the announcer, step A5).
      <div className="flex w-full items-start gap-3 px-4 py-2.5" data-pending-done={done.kind} aria-hidden>
        <WorkMark state="done" tone={done.tone} />
        <span className="min-w-0 flex-1">
          {/* Wraps rather than truncating: at the lg column's 263 px the time at its end is what a cut would lose. */}
          <span className="block text-sm break-words">{done.title}</span>
          <span className="block text-xs text-muted-foreground">{done.sub}</span>
        </span>
      </div>
    );
  }
  const { line } = row;
  return (
    <div className="flex w-full items-start gap-3 px-4 py-2.5" data-pending-step={line.kind} data-state={line.active ? "active" : "waiting"}>
      <WorkMark state={workStateOf(line)} tone={toneOf(line)} still={row.still} />
      <span className="min-w-0 flex-1">
        <span className={cn("block text-sm", line.kind === "measuring" ? "break-words" : "truncate")}>{line.title}</span>
        <span className="block text-xs text-muted-foreground">{line.sub}</span>
      </span>
      <span className={cn("shrink-0 text-right text-sm", MONO, TONE_TEXT[toneOf(line)])} {...(line.amountSpoken === null ? {} : { "aria-hidden": true })}>
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

/** The polite region's attributes, or none for a copy that must not announce. */
type Region = { readonly role?: "status"; readonly "aria-live"?: "polite" };

/** In the column: the frame grows when the first step comes and closes after the last. */
function Column({ view, region, className, innerClassName }: { readonly view: PendingView; readonly region: Region; readonly className?: string; readonly innerClassName?: string }) {
  return (
    <div {...region} className={className || undefined} data-pending-steps={view.lines.length}>
      <Reveal open={standing(view)}>
        <Body view={view} card={false} {...(innerClassName === undefined ? {} : { className: innerClassName })} />
      </Reveal>
    </div>
  );
}

/**
 * ON THE PAGE'S TOP, BELOW lg: the region is the card's own box, so it can be
 * out of the flow (sr-only) while closed and still be there to announce, and
 * take its `gap-4` back while it grows and closes — a Reveal inside it would
 * leave the region in the column, holding the gap open over nothing.
 */
function TopCard({ view, region, className }: { readonly view: PendingView; readonly region: Region; readonly className?: string }) {
  const open = standing(view) || view.held;
  const phase = useRevealPhase(open);
  const look = revealLook(open, phase);
  const body = <Body view={view} card />;
  // What it showed last while open, so it closes over its content.
  const last = useRef<ReactNode>(body);
  if (open) last.current = body;
  return (
    <div
      {...region}
      // The first collapsed frame after sr-only does not transition: there is nothing to move from.
      className={cn(look === "gone" ? "sr-only" : revealFrameClass({ grown: look === "grown", inGap: true, still: open && phase === "closed" }), className)}
      data-pending-steps={view.lines.length}
    >
      {look === "gone" ? null : (
        <div className={cn("min-h-0 min-w-0", (!open || phase !== "open") && "overflow-hidden")} {...(open ? {} : { inert: true, "aria-hidden": true })}>
          {open ? body : last.current}
        </div>
      )}
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
  /** The steps as they stand. */
  readonly lines: readonly PendingLine[];
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
   * change read out twice is noise.
   */
  readonly announce?: boolean;
}) {
  const shown = view ?? viewOf(lines);
  const region: Region = announce ? { role: "status", "aria-live": "polite" } : {};
  if (variant === "card") return <TopCard view={shown} region={region} {...(className === undefined ? {} : { className })} />;
  return (
    <Column
      view={shown}
      region={region}
      {...(className === undefined ? {} : { className })}
      {...(innerClassName === undefined ? {} : { innerClassName })}
    />
  );
}
