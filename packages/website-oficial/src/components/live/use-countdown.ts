"use client";

import { useEffect, useState } from "react";

import { useTicker } from "@/components/live/use-ticker";

/**
 * A COUNTDOWN THAT MOVES, AND LANDS ON ITS MOMENT (10-09). "Try again in 12 s"
 * used to be worked out once per render and then never changed, so a Retry
 * could stay disabled long after its time (G5). This one counts down every
 * second (useTicker: only while the tab is visible), and flips at `until`
 * EXACTLY, on its own timer: a second's tick that happens to land 900 ms after
 * the moment would leave the button disabled for most of a second it was owed.
 *
 * Browser time, in ms. `until` is a moment in this browser's clock — when the
 * server said this browser may ask again, or when a press stops being deferred.
 */

/** Seconds until `at`, rounded up; null when there is nothing left to count down to. */
export function secondsUntil(at: number | null, now: number): number | null {
  if (at === null) return null;
  const left = Math.ceil((at - now) / 1_000);
  return left > 0 ? left : null;
}

/**
 * Calls `onReach` once, at `until` — at once when it has already passed.
 * Returns the stop. Pure apart from the timer, so a test can drive it.
 */
export function armDeadline(until: number, now: number, onReach: () => void): () => void {
  const wait = until - now;
  if (wait <= 0) {
    onReach();
    return () => undefined;
  }
  const timer = setTimeout(onReach, wait);
  return () => clearTimeout(timer);
}

/**
 * Whether the moment `at` has come — true from then on. One re-render, at the
 * moment itself (armDeadline), and none before or after it: for a screen that
 * changes what it says at a few fixed points rather than every second (the
 * first read's "taking longer" and its Reload, LiveFirstRead.tsx).
 *
 * A moment already past at mount starts true, so the first paint is right. A
 * new `at` starts over, like useCountdown's `until`.
 */
export function useReached(at: number): boolean {
  const [reached, setReached] = useState<number | null>(() => (at <= Date.now() ? at : null));
  useEffect(() => armDeadline(at, Date.now(), () => setReached(at)), [at]);
  return reached === at;
}

/**
 * The whole seconds left until `until`, or null once it is reached (or when
 * there is nothing to wait for). Ticks only while it counts.
 *
 * THE TICKER IS WHAT RE-RENDERS, THE CLOCK IS READ HERE. A ticker that sat idle
 * holds the moment it stopped — a minute old, say — until its effect catches it
 * up after the paint; a new `until` counted against that would paint "Try again
 * in 70 s" for a frame. This leaf mounts only in the browser (use-ticker.ts), so
 * no server HTML can disagree with it.
 */
export function useCountdown(until: number | null): number | null {
  // The `until` whose moment has been seen to pass. A new `until` starts over;
  // one already past at mount starts reached, so no ticker is armed for nothing.
  const [reached, setReached] = useState<number | null>(() => (until !== null && until <= Date.now() ? until : null));
  const counting = until !== null && reached !== until;
  useTicker(counting, 1_000);
  useEffect(() => {
    if (until === null) return undefined;
    return armDeadline(until, Date.now(), () => setReached(until));
  }, [until]);
  return counting ? secondsUntil(until, Date.now()) : null;
}
