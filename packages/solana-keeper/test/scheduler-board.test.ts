// /leaderboard on a scheduler replica (src/scheduler-board.ts): the legacy
// computation, debounced — the 120 s timer, plus at most one recompute every
// 15 s while fleet.board_dirty_at moves (ADR §3.8 step 8, owner decision 25).

import { describe, expect, it } from "vitest";
import type { RefreshClock } from "../src/board-refresh.js";
import { BOARD_REFRESH_MIN_GAP_MS } from "../src/board-refresh.js";
import type { LeaderboardDayRow } from "../src/read-model.js";
import { FleetBoard } from "../src/scheduler-board.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));

function board(days: LeaderboardDayRow[] | null = []) {
  let now = 1_000_000;
  const timers: { at: number; run: () => void }[] = [];
  const clock: RefreshClock = { now: () => now, setTimeout: (run, ms) => timers.push({ at: now + ms, run }) };
  let reads = 0;
  const readModel = {
    leaderboardDays: async () => {
      reads += 1;
      return days;
    },
    globalStatsRows: async () => ({ settlements: [], investments: [] }),
  };
  const fleetBoard = new FleetBoard({ readModel, log: () => undefined, now: () => now, clock });
  return {
    board: fleetBoard,
    reads: () => reads,
    advance: async (ms: number) => {
      now += ms;
      for (const timer of timers.splice(0)) if (timer.at <= now) timer.run();
      else timers.push(timer);
      await flush();
    },
  };
}

describe("the replica's leaderboard", () => {
  it("serves 'not computed yet' until its first read, then the board; an unreadable history before any board is unavailable", async () => {
    const ok = board([{ subject: "V1", day: "2026-10-12", settles: 2, contributionRaw: 5_000n, volumeRaw: 9_000n }]);
    expect(ok.board.reply()).toEqual({ unavailable: "the rankings have not been computed yet" });
    ok.board.request();
    await flush();
    expect("body" in ok.board.reply()).toBe(true);
    const unreadable = board(null);
    unreadable.board.request();
    await flush();
    expect(unreadable.board.reply()).toEqual({ unavailable: "the history could not be read" });
  });

  it("recomputes when board_dirty_at moves, at most once every 15 s, the same value once", async () => {
    const b = board();
    b.board.request();
    await flush();
    expect(b.reads()).toBe(1);
    // A SETTLE SINCE: each new value is a request, all of them coalesced into the 15 s gap.
    b.board.observeDirty("2026-10-12T10:00:05.000Z");
    b.board.observeDirty("2026-10-12T10:00:06.000Z");
    b.board.observeDirty("2026-10-12T10:00:06.000Z");
    await flush();
    expect(b.reads()).toBe(1);
    await b.advance(BOARD_REFRESH_MIN_GAP_MS);
    expect(b.reads()).toBe(2);
    expect(b.board.status()).toMatchObject({ dirtySeen: 2, refreshes: 2, lastDirtyAt: "2026-10-12T10:00:06.000Z" });
    // THE SAME VALUE READ AGAIN IS NOT A SETTLE.
    await b.advance(BOARD_REFRESH_MIN_GAP_MS);
    b.board.observeDirty("2026-10-12T10:00:06.000Z");
    await flush();
    expect(b.reads()).toBe(2);
  });

  it("counts the FIRST value it reads: a settle in the replica's first seconds is not left to the 120 s timer", async () => {
    const b = board();
    b.board.request();
    await flush();
    await b.advance(BOARD_REFRESH_MIN_GAP_MS + 1);
    b.board.observeDirty("2026-10-12T10:00:01.000Z");
    await flush();
    expect(b.reads()).toBe(2);
  });
});
