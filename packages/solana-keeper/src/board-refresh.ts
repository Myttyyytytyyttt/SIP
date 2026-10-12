// The `board-timer` cut: the rankings recomputed at most every 15 seconds
// after settlements, never once per settlement.
//
// TODAY (the cut off). Every SETTLED whose history row lands triggers a full
// recompute of /leaderboard — the days query, the stats query, and the
// computation over both — at once, detached, and on top of the 120-second
// timer. Nothing stops two of them running together: a sweep that settles ten
// wallets starts ten recomputes that race each other for the read model's two
// connections, the same two the settlement writes need. The cost model puts the
// Postgres wall this makes at about 3,800 users at mix B, 380 at a busy mix
// (dispatcher ADR §3.14 P7; COST_MODEL, limits.csv).
//
// WITH THE CUT. Every trigger — the settle's and the timer's — goes through one
// CoalescedRefresh:
//   * ONE IN FLIGHT. A request while a recompute runs is remembered, not started.
//   * ONE QUEUED. However many requests arrive meanwhile, they are served by one
//     recompute that starts after the running one ends: every settle they stand
//     for has its row written by then (each request is made after its write
//     resolved), so one recompute sees them all.
//   * AT MOST ONE START PER BOARD_REFRESH_MIN_GAP_MS. A request inside the gap
//     schedules the recompute for the gap's end instead of running it now.
//
// THE PROMISE TO THE USER STAYS: somebody who just saved and went to look finds
// himself on the board within the gap plus one recompute — 15 s — instead of
// "at once, unless ten others saved in the same sweep".

/** The shortest interval between two recompute starts: 15 seconds. */
export const BOARD_REFRESH_MIN_GAP_MS = 15_000;

/** The clock and timer this needs, injectable so a test controls time. */
export interface RefreshClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
}

const realClock: RefreshClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    // A PENDING REFRESH IS NOT A REASON TO STAY UP: the sweep's own interval keeps the process alive.
    handle.unref?.();
    return handle;
  },
};

/** What the board refresher did since boot, for /status. */
export interface BoardRefreshStatus {
  /** Recomputes started. */
  readonly refreshes: number;
  /** Requests absorbed by a recompute that was already running, queued or scheduled. */
  readonly coalesced: number;
  readonly minGapMs: number;
}

export class CoalescedRefresh {
  private running = false;
  private queued = false;
  private scheduled = false;
  private lastStartAt: number | null = null;
  private refreshes = 0;
  private coalesced = 0;

  /**
   * `run` is the recompute. It is expected never to throw (refreshLeaderboard
   * catches everything); a rejection is swallowed here anyway, because this runs
   * detached under the process's uncaughtException trap, which exits.
   */
  constructor(
    private readonly run: () => Promise<void>,
    private readonly minGapMs: number = BOARD_REFRESH_MIN_GAP_MS,
    private readonly clock: RefreshClock = realClock,
  ) {}

  /** Asks for a recompute: now if nothing runs and the gap has passed, otherwise as soon as both allow. */
  request(): void {
    if (this.running) {
      if (this.queued) this.coalesced += 1;
      this.queued = true;
      return;
    }
    if (this.scheduled) {
      this.coalesced += 1;
      return;
    }
    const waitMs = this.lastStartAt === null ? 0 : Math.max(0, this.lastStartAt + this.minGapMs - this.clock.now());
    if (waitMs === 0) {
      this.start();
      return;
    }
    this.scheduled = true;
    this.clock.setTimeout(() => {
      this.scheduled = false;
      this.start();
    }, waitMs);
  }

  private start(): void {
    this.running = true;
    this.lastStartAt = this.clock.now();
    this.refreshes += 1;
    // THROUGH A RESOLVED PROMISE, so a `run` that throws before its first await
    // is a rejection here too, and `running` is always released.
    void Promise.resolve()
      .then(() => this.run())
      .catch(() => undefined)
      .finally(() => {
        this.running = false;
        if (this.queued) {
          this.queued = false;
          this.request();
        }
      });
  }

  status(): BoardRefreshStatus {
    return { refreshes: this.refreshes, coalesced: this.coalesced, minGapMs: this.minGapMs };
  }
}
