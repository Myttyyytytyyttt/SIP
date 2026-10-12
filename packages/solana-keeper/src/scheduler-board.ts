// /leaderboard on a scheduler replica: the rankings, debounced (dispatcher ADR
// §3.8 step 8, owner decision 25; [QUEUE] §2.7 step 8).
//
// EVERY REPLICA SERVES IT, so every replica keeps its own. The route is public
// and Railway sends a request to whichever replica it likes, the standby
// included; a board only the lock holder computed would be a 503 half the time.
// Two replicas therefore read the rankings twice per period — two statements
// every two minutes, on each replica's one pooled connection — which is what a
// public page costs, and nothing a vault waits on.
//
// THE TRIGGERS, AS ADR §3.8 STEP 8 HAS THEM: the 120 s timer, plus at most one
// recompute every BOARD_REFRESH_MIN_GAP_MS (15 s) while fleet.board_dirty_at
// moves — a worker's settle sets it. The replica sees it in the fleet snapshot
// its page re-reads every 15 s (FleetStatusReader); a CHANGED value is a
// request, so no replica ever clears it and none needs to agree with another
// about having seen it. Today a settle recomputes the rankings at once, ten
// settles start ten recomputes (bin/keeper.mts, board-timer off), and that is
// the Postgres wall at N ≈ 3,802 (COST_MODEL §4) this removes.
//
// THE COMPUTATION IS THE LEGACY KEEPER'S, line for line (refreshLeaderboard in
// bin/keeper.mts): the days, then the stats on the same connection, the last
// good stats kept a day, and "the history could not be read" rather than an
// empty board. Its reads go through a read model over the scheduler's own pool
// (SolanaReadModel.overPool), never a pool of their own.

import { summarizeUpstreamError, sharedRedactor } from "@sip/solana-log";
import { BOARD_REFRESH_MIN_GAP_MS, CoalescedRefresh, type RefreshClock } from "./board-refresh.js";
import { computeGlobalStats, type GlobalStats } from "./global-stats.js";
import { computeLeaderboard } from "./leaderboard.js";
import type { SolanaReadModel } from "./read-model.js";
import { renderLeaderboard, type LeaderboardReply } from "./status.js";

/** The legacy keeper's timer (bin/keeper.mts LEADERBOARD_REFRESH_MS). */
export const BOARD_TIMER_MS = 120_000;
/** How long a stats block nobody could re-read is still served: a day (bin/keeper.mts STATS_MAX_AGE_MS). */
export const BOARD_STATS_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

export interface FleetBoardOptions {
  readonly readModel: Pick<SolanaReadModel, "leaderboardDays" | "globalStatsRows">;
  readonly log: (level: "warn", message: string, fields?: Record<string, unknown>) => void;
  readonly now?: () => number;
  readonly clock?: RefreshClock;
}

export interface FleetBoardStatus {
  readonly refreshes: number;
  readonly coalesced: number;
  readonly dirtySeen: number;
  readonly lastDirtyAt: string | null;
  readonly served: "board" | "unavailable";
}

export class FleetBoard {
  readonly #readModel: FleetBoardOptions["readModel"];
  readonly #log: FleetBoardOptions["log"];
  readonly #now: () => number;
  readonly #refresh: CoalescedRefresh;
  #reply: LeaderboardReply = { unavailable: "the rankings have not been computed yet" };
  #lastGoodStats: (GlobalStats & { readonly computedAt: string }) | null = null;
  #lastDirtyAt: string | null = null;
  #dirtySeen = 0;

  constructor(options: FleetBoardOptions) {
    this.#readModel = options.readModel;
    this.#log = options.log;
    this.#now = options.now ?? (() => Date.now());
    this.#refresh = new CoalescedRefresh(() => this.#recompute(), BOARD_REFRESH_MIN_GAP_MS, options.clock);
  }

  /** What /leaderboard serves now. */
  reply(): LeaderboardReply {
    return this.#reply;
  }

  /** The timer's way in, and the first one at boot. Never awaited. */
  request(): void {
    this.#refresh.request();
  }

  /**
   * fleet.board_dirty_at as this replica's page last read it. A value it has
   * not seen before is a settle since: one more request, coalesced.
   *
   * THE FIRST VALUE A REPLICA READS COUNTS TOO. It may have been written after
   * the boot's own recompute read the history — a settle in the replica's first
   * seconds — and skipping it would leave that saver off the board until the
   * 120 s timer. One extra recompute a boot, folded into the boot's by the gap.
   */
  observeDirty(boardDirtyAt: string | null): void {
    if (boardDirtyAt === null || boardDirtyAt === this.#lastDirtyAt) return;
    this.#lastDirtyAt = boardDirtyAt;
    this.#dirtySeen += 1;
    this.#refresh.request();
  }

  async #recompute(): Promise<void> {
    try {
      const days = await this.#readModel.leaderboardDays();
      if (days === null) {
        if (!("body" in this.#reply)) this.#reply = { unavailable: "the history could not be read" };
        return;
      }
      try {
        const rows = await this.#readModel.globalStatsRows();
        if (rows !== null) this.#lastGoodStats = { ...computeGlobalStats(rows.settlements, rows.investments), computedAt: new Date(this.#now()).toISOString() };
        else if (this.#lastGoodStats !== null && this.#now() - Date.parse(this.#lastGoodStats.computedAt) > BOARD_STATS_MAX_AGE_MS) this.#lastGoodStats = null;
      } catch (error) {
        this.#log("warn", "the global stats could not be computed (the rankings still refresh)", { detail: summarizeUpstreamError(error) });
      }
      const stats = this.#lastGoodStats;
      this.#reply = { body: renderLeaderboard({ ...computeLeaderboard(days, new Date(this.#now())), ...(stats === null ? {} : { stats }) }, sharedRedactor) };
    } catch (error) {
      this.#log("warn", "the leaderboard could not be computed", { detail: summarizeUpstreamError(error) });
    }
  }

  status(): FleetBoardStatus {
    const refresh = this.#refresh.status();
    return {
      refreshes: refresh.refreshes,
      coalesced: refresh.coalesced,
      dirtySeen: this.#dirtySeen,
      lastDirtyAt: this.#lastDirtyAt,
      served: "body" in this.#reply ? "board" : "unavailable",
    };
  }
}
