// The `board-timer` cut (src/board-refresh.ts): one recompute in flight, one
// queued, at most one start per gap — and every request served.
//
// A hand-driven clock and a recompute the test resolves itself, so each case
// says exactly how many recomputes started and when.

import { describe, expect, it } from "vitest";
import { BOARD_REFRESH_MIN_GAP_MS, CoalescedRefresh, type RefreshClock } from "../src/board-refresh.js";

class ManualClock implements RefreshClock {
  at = 1_000_000;
  private timers: { readonly due: number; readonly callback: () => void }[] = [];
  now(): number {
    return this.at;
  }
  setTimeout(callback: () => void, ms: number): unknown {
    this.timers.push({ due: this.at + ms, callback });
    return this.timers.length;
  }
  /** Moves time forward, firing every timer that falls due on the way. */
  advance(ms: number): void {
    this.at += ms;
    const due = this.timers.filter((timer) => timer.due <= this.at);
    this.timers = this.timers.filter((timer) => timer.due > this.at);
    for (const timer of due) timer.callback();
  }
  get pending(): number {
    return this.timers.length;
  }
}

/** A recompute that stays in flight until the test ends it. */
function recompute(): { readonly run: () => Promise<void>; readonly started: number[]; finish(): Promise<void> } {
  const started: number[] = [];
  const open: (() => void)[] = [];
  return {
    started,
    run: () => {
      started.push(started.length + 1);
      return new Promise<void>((resolve) => open.push(resolve));
    },
    async finish() {
      open.shift()?.();
      // Let the `finally` that releases the flag, and any queued request, run.
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    },
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

describe("CoalescedRefresh", () => {
  it("starts the first request at once: a settle on a quiet keeper reaches the board without waiting", async () => {
    const clock = new ManualClock();
    const board = recompute();
    const refresh = new CoalescedRefresh(board.run, BOARD_REFRESH_MIN_GAP_MS, clock);
    refresh.request();
    await flush();
    expect(board.started).toHaveLength(1);
  });

  it("serves ten settles in one sweep with ONE more recompute, not ten racing each other", async () => {
    const clock = new ManualClock();
    const board = recompute();
    const refresh = new CoalescedRefresh(board.run, BOARD_REFRESH_MIN_GAP_MS, clock);
    for (let i = 0; i < 10; i += 1) refresh.request();
    await flush();
    // ONE IN FLIGHT: nine requests arrived while it ran.
    expect(board.started).toHaveLength(1);
    clock.advance(2_000);
    await board.finish();
    // ONE QUEUED, held to the gap: the second start waits for 15 s after the first.
    expect(board.started).toHaveLength(1);
    expect(clock.pending).toBe(1);
    clock.advance(BOARD_REFRESH_MIN_GAP_MS - 2_000);
    await flush();
    expect(board.started).toHaveLength(2);
    await board.finish();
    expect(clock.pending).toBe(0);
    expect(board.started).toHaveLength(2);
    expect(refresh.status()).toEqual({ refreshes: 2, coalesced: 8, minGapMs: BOARD_REFRESH_MIN_GAP_MS });
  });

  it("never starts two recomputes less than the gap apart, and never leaves a request unserved", async () => {
    const clock = new ManualClock();
    const board = recompute();
    const starts: number[] = [];
    const tracked = new CoalescedRefresh(
      async () => {
        starts.push(clock.now());
        await board.run();
      },
      BOARD_REFRESH_MIN_GAP_MS,
      clock,
    );
    // A request every 4 s for a minute, each recompute taking 1 s.
    for (let t = 0; t < 60_000; t += 4_000) {
      tracked.request();
      await flush();
      clock.advance(1_000);
      await board.finish();
      clock.advance(3_000);
      await flush();
    }
    // The last request is still owed a recompute: let it fall due and run.
    clock.advance(BOARD_REFRESH_MIN_GAP_MS);
    await flush();
    await board.finish();
    for (let i = 1; i < starts.length; i += 1) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(BOARD_REFRESH_MIN_GAP_MS);
    // FIFTEEN REQUESTS, FIVE RECOMPUTES, and the last one started after the last request.
    expect(starts.length).toBe(5);
    expect(starts[starts.length - 1]).toBeGreaterThanOrEqual(1_000_000 + 56_000);
  });

  it("releases the flag when a recompute throws, so the board is not frozen by one bad query", async () => {
    const clock = new ManualClock();
    let calls = 0;
    const refresh = new CoalescedRefresh(
      () => {
        calls += 1;
        throw new Error("the read model is down");
      },
      BOARD_REFRESH_MIN_GAP_MS,
      clock,
    );
    refresh.request();
    await flush();
    clock.advance(BOARD_REFRESH_MIN_GAP_MS);
    refresh.request();
    await flush();
    expect(calls).toBe(2);
  });
});
