"use client";

/**
 * "· 8 s" — HOW LONG A WAIT HAS STOOD, beside the words that say what it is
 * (10-09). A wait with no count beside it looks the same at second two and at
 * minute two; this one moves, every second, in its own leaf (useTicker: only
 * while the tab is visible), so nothing around it re-renders for it.
 *
 * NEVER READ OUT. It is `aria-hidden`: inside a polite region it would be
 * spoken every second, and the words beside it already carry the state. The
 * first read (LiveFirstRead.tsx) shows it once five seconds have passed, before
 * which a count would only be noise.
 *
 * Browser time, in ms: `from` is a moment in this browser's clock — when the
 * wait began on this screen — never the chain's.
 */

import { useTicker } from "@/components/live/use-ticker";
import { LIVE_COPY } from "@/lib/live-copy";
import { cn } from "@/lib/utils";

/** Whole seconds since `from`, rounded down — "· 8 s" until the ninth has passed. Never below zero. */
export function elapsedSeconds(from: number, now: number): number {
  return Math.max(0, Math.floor((now - from) / 1_000));
}

export function Elapsed({
  from,
  after = 0,
  className,
}: {
  /** When the wait began, in this browser's clock. */
  readonly from: number;
  /** Nothing is shown until this many ms have passed. */
  readonly after?: number;
  readonly className?: string;
}) {
  // The ticker is what re-renders; the clock is read here, as in use-countdown.ts.
  useTicker(true, 1_000);
  const now = Date.now();
  if (now - from < after) return null;
  return (
    <span aria-hidden="true" className={cn("tabular-nums", className)}>
      {LIVE_COPY.elapsed(elapsedSeconds(from, now))}
    </span>
  );
}
