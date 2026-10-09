"use client";

import { useEffect, useState } from "react";

/**
 * WAIT FOR A READ'S HISTORY BEFORE SAYING WHAT CHANGED (10-09, G4).
 *
 * Every read after the first commits twice (use-live-dashboard.ts): the
 * snapshot at once — new balances, a new `nowMs` — and the history's head page
 * a moment later, with the same `nowMs`. Between the two the page holds new
 * balances over old rows. Anything that says what CHANGED, read off that half
 * state, says something false: a conversion's line vanishes before the row
 * that converted lands, and a settlement whose row is not in yet draws its
 * conversion as "Not done since…" (live-pending.ts times the step from the
 * newest move it can see, which is older).
 *
 * So the transitions — a line leaving, a "done" being held, the heading
 * flipping — read a SETTLED view: the last `data` whose read had finished. A
 * read settles when, after its snapshot moved `nowMs`:
 *   - its rows change (the head page committed: `history`, historyKeyOf);
 *   - the history's own state changes — pending or unreadable — either way;
 *   - or READ_SETTLE_MS passes, whichever comes first. A read that brings no
 *     second commit (no history to read, a page that failed the same way
 *     twice), or a head page with no new row in it, is not waited on for
 *     longer than that.
 *
 * WHY THE ROWS, NOT ANY NEW `data` (review, 10-09): every socket notification
 * hands the page a new `data` with the same `nowMs` and the same rows. Taken
 * as the head page, it settled the snapshot alone — and a conversion timed off
 * the previous settlement read "Not done since 09:12 UTC" until the real head
 * page came, the very half state this hook is here to hide. While a wait is
 * open, a commit that leaves the rows untouched only moves `latest`.
 * With nothing waited on, any change of `data` (a push, an older page, a
 * failure noted on the same snapshot) settles at once: there is nothing to
 * wait for.
 *
 * [FALLBACK] Deleted once the hook commits the snapshot and the head page
 * together, or says which read a commit belongs to (plan §5, ask 7).
 */

/** At most this long between a read's snapshot and the moment its view counts as settled. */
export const READ_SETTLE_MS = 3_000;

/** What a commit says about its read: its snapshot's clock, where its history stands, and which rows it holds. */
export interface ReadMarks {
  readonly nowMs: number;
  readonly activityPending: boolean;
  readonly activityUnreadable: boolean;
  /** Changes only when a history page lands (historyKeyOf): a snapshot or a push leaves it as it was. */
  readonly history: string;
}

type Rows = readonly { readonly signature: string }[];

/**
 * The rows a commit holds, as a key only a history page can change: each
 * list's length and newest signature. Content, not identity — a push re-derives
 * the lists as new arrays holding the same rows.
 */
export function historyKeyOf(data: { readonly rows: Rows; readonly hiddenRows: Rows; readonly settlementRows: Rows }): string {
  return [data.rows, data.hiddenRows, data.settlementRows].map((rows) => `${rows.length}:${rows[0]?.signature ?? ""}`).join("|");
}

export interface ReadSettle<T> {
  /** The newest `data`, settled or not, and its marks. */
  readonly latest: T;
  readonly marks: ReadMarks;
  /** The newest `data` whose read had finished. */
  readonly settled: T;
  /** Browser ms at which the read in flight committed its snapshot; null when nothing is waited on. */
  readonly since: number | null;
}

const settledOn = <T>(data: T, marks: ReadMarks): ReadSettle<T> => ({ latest: data, marks, settled: data, since: null });

/**
 * The pure core: the state after `next` (with its `marks`) is seen at browser
 * time `now`. The same object back when nothing changed, so a render that
 * calls it again is not told to render once more.
 */
export function readSettled<T>(prev: ReadSettle<T> | null, next: T, marks: ReadMarks, now: number): ReadSettle<T> {
  // The page's first paint: nothing to compare with, nothing to wait for.
  if (prev === null) return settledOn(next, marks);
  const sameData = Object.is(prev.latest, next);
  const historyMoved = marks.activityPending !== prev.marks.activityPending || marks.activityUnreadable !== prev.marks.activityUnreadable;
  // A new snapshot: wait for its history — from the first unsettled moment, if one is already waited on.
  if (marks.nowMs !== prev.marks.nowMs && !historyMoved) return { latest: next, marks, settled: prev.settled, since: prev.since ?? now };
  if (historyMoved) return settledOn(next, marks);
  // A wait is open and this commit brought no row (a push, a resync): still the snapshot's half state — until the cap.
  if (!sameData && prev.since !== null && marks.history === prev.marks.history && now - prev.since < READ_SETTLE_MS) {
    return { latest: next, marks, settled: prev.settled, since: prev.since };
  }
  if (!sameData) return settledOn(next, marks);
  // Nothing new: a wait that has run its course settles on what is there.
  if (prev.since !== null && now - prev.since >= READ_SETTLE_MS) return settledOn(prev.latest, prev.marks);
  return prev;
}

/**
 * The settled `data`, and whether it is the newest. Worked out during the
 * render, so a transition is decided before the frame that would draw the half
 * state; one timer settles a read whose history never comes.
 */
export function useReadSettled<T extends { readonly nowMs: number }>(
  data: T,
  history: { readonly activityPending: boolean; readonly activityUnreadable: boolean; readonly history: string },
): { readonly data: T; readonly settled: boolean } {
  const marks: ReadMarks = { nowMs: data.nowMs, activityPending: history.activityPending, activityUnreadable: history.activityUnreadable, history: history.history };
  const [state, setState] = useState<ReadSettle<T>>(() => settledOn(data, marks));

  // A new commit: worked out now, before anything draws from it.
  let current = state;
  if (
    !Object.is(state.latest, data) ||
    state.marks.nowMs !== marks.nowMs ||
    state.marks.activityPending !== marks.activityPending ||
    state.marks.activityUnreadable !== marks.activityUnreadable ||
    state.marks.history !== marks.history
  ) {
    current = readSettled(state, data, marks, Date.now());
    setState(current);
  }

  const waitingSince = current.since;
  useEffect(() => {
    if (waitingSince === null) return;
    const due = waitingSince + READ_SETTLE_MS;
    // Settled as at `due` at the least: a timer may wake a millisecond early,
    // and one that settled nothing would leave no timer set (use-hold.ts).
    const timer = setTimeout(() => setState((held) => readSettled(held, held.latest, held.marks, Math.max(Date.now(), due))), Math.max(0, due - Date.now()));
    return () => clearTimeout(timer);
  }, [waitingSince]);

  return { data: current.settled, settled: current.since === null };
}
