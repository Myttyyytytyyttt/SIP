"use client";

import { useEffect, useState } from "react";

/**
 * A CLOCK FOR THE ONE LEAF THAT COUNTS (10-09). "Try again in 12 s" used to be
 * read once per render and then never moved, so a Retry could stay disabled
 * long after its time (G5). The countdowns, the "· 8 s" beside a slow first
 * read and the heartbeat's "updated 2 min ago" each tick on their own, in the
 * leaf that shows them — LiveBody never re-renders every second for them.
 *
 * IT TICKS ONLY WHILE IT IS NEEDED AND SEEN: while `active`, and while the tab
 * is visible. A hidden tab costs nothing; the moment it is shown again it ticks
 * once, so the first frame a person sees is already right rather than a step
 * behind.
 *
 * The value is the BROWSER's clock, in ms — for countdowns and ages measured in
 * this browser only. Anything said against the chain's time is measured against
 * the snapshot's own `nowMs`, never this.
 */

/** As much of `document` as the ticker reads: a fake one in the tests. */
export interface PageVisibility {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

/**
 * Calls `onTick` every `stepMs` while the page is visible, once more each time
 * it is shown again, and never while it is hidden. Returns the stop.
 */
export function runTicker(page: PageVisibility, stepMs: number, onTick: () => void): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  const start = () => {
    if (timer === null) timer = setInterval(onTick, stepMs);
  };
  const stop = () => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  };
  const onVisibility = () => {
    if (page.visibilityState === "visible") {
      onTick();
      start();
    } else {
      stop();
    }
  };

  if (page.visibilityState === "visible") start();
  page.addEventListener("visibilitychange", onVisibility);
  return () => {
    stop();
    page.removeEventListener("visibilitychange", onVisibility);
  };
}

/**
 * The browser's clock, refreshed every `stepMs` while `active` and the tab is
 * visible. Inactive, it holds its last value and costs nothing; turning active
 * catches it up at once, since the value it held may be minutes old.
 *
 * The first value is read when the leaf mounts. A live leaf mounts only once
 * Privy has answered in this browser — never in the server's HTML, where
 * `ready` is false — so no hydration can disagree with it.
 */
export function useTicker(active: boolean, stepMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const tick = () => setNow(Date.now());
    tick();
    return runTicker(document, stepMs, tick);
  }, [active, stepMs]);
  return now;
}
