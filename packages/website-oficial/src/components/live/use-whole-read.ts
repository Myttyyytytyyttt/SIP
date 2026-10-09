"use client";

import { useState } from "react";

/**
 * THE STEPS ARE DRAWN FROM A READ THAT LANDED WHOLE (10-09, plan B5).
 *
 * Every read commits its snapshot, its head page and the round's link rows in
 * ONE update now (live-commit.ts commitRead), and `live.readId` moves once per
 * read. The half state the steps used to wait out — new balances over old
 * rows, for the second between a read's two commits — is gone, and with it
 * the guess that waited it out: a settled view taken at the history's commit
 * or after three seconds, whichever came first (use-read-settled.ts, deleted).
 * A read that lands whole is drawn at once.
 *
 * ONE READ STILL COMMITS HALF, AND SAYS SO: a later read whose history could
 * not be read commits its snapshot alone (live-commit.ts), and the feed says
 * the history could not be read. Off that commit nothing about the steps can
 * be judged honestly:
 *   - how a step ENDED is the row that ended it, and that row is the history
 *     the read did not get — so it could only close, never be "done";
 *   - a step NEW to it is timed off rows that may be missing its newest move,
 *     so a fresh saving's conversion could read "Not done since" an older one.
 * So the steps stay as the last read that landed whole drew them, and every
 * loader the newer snapshot no longer has under way stands still
 * (LivePending.tsx stillOf): the page stops vouching that it turns, and
 * claims no step ended, done or slow off that commit. Until the next read
 * lands whole — no timer and no cap: the store says when, by the read it
 * commits.
 *
 * NOTHING TO STAND ON, NOTHING HELD: the page's first paint (its snapshot
 * drawn before its history answered, lib/first-paint.ts) is no read's commit,
 * and a first read whose history failed too has no whole read before it. The
 * newest is all there is, and it is drawn.
 */

/** What the steps are drawn from, and which read put it there. */
export interface StepsRead<T> {
  readonly data: T;
  /** The read that committed it (`live.readId`). */
  readonly readId: number;
  /** That read landed with its history: snapshot and head page in one commit. */
  readonly whole: boolean;
}

/**
 * The pure core: what the steps are drawn from once `next` is seen, given
 * what they were drawn from (`held`). The same object back when nothing
 * changed, so a render that asks again is not told to render once more.
 */
export function wholeReadOf<T>(held: StepsRead<T>, next: StepsRead<T>): StepsRead<T> {
  if (Object.is(held.data, next.data) && held.readId === next.readId && held.whole === next.whole) return held;
  // A LATER read committed its snapshot alone, over one that landed whole: the whole one stands.
  if (!next.whole && held.whole && next.readId !== held.readId) return held;
  // A whole read; the same read again (a push re-deriving it, an older page under it); or nothing whole to stand on.
  return next;
}

/**
 * The `data` the steps are drawn from, and whether it is the newest. Worked
 * out during the render, so a step is never drawn for one frame off a commit
 * that cannot vouch for it.
 */
export function useWholeRead<T>(data: T, read: { readonly readId: number; readonly whole: boolean }): { readonly data: T; readonly newest: boolean } {
  const next: StepsRead<T> = { data, readId: read.readId, whole: read.whole };
  const [held, setHeld] = useState<StepsRead<T>>(next);
  const current = wholeReadOf(held, next);
  if (current !== held) setHeld(current);
  return { data: current.data, newest: Object.is(current.data, data) };
}
