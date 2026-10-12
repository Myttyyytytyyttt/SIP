// WHO GETS HOW MUCH OF THE FLEET'S RPC AND JUPITER RATE, AND HOW A PROCESS
// LEARNS ITS SHARE (ADR §3.8 step 7, §3.9; [QUEUE] §2.8).
//
// THE ARITHMETIC IS THE SCHEDULER'S, THE FOLLOWING IS EACH WORKER'S. Every tick
// the scheduler divides the fleet's budget among the processes it sees alive
// (fleetQuotas) and writes each one's share into its `worker` row (rps_quota,
// jup_quota). Every heartbeat a worker reads its row and sets its bucket and its
// Jupiter pacer to what it says (QuotaFollower). A bucket per process with
// handed-out quotas costs no database round trip per RPC call, which a shared
// bucket in Postgres would ([QUEUE] §2.8, rejected).
//
// THE ROW'S STORE IS NOT HERE. The `worker` table and the code that reads and
// writes it land in their own track (Q1); this file names only what it needs
// from them — WorkerQuotaSource, one read of one row — and is handed one. Until
// then a worker runs on the static floor, which is safe by construction.
//
// THE FLOOR IS WHAT MAKES A SILENT SCHEDULER SAFE. A worker that has heard no
// quota for QUOTA_STALE_MS drops to (fleet − scheduler) / r_max: the share it
// would get if every worker the fleet may ever run were alive. However many are
// alive, their floors add up to no more than the fleet's budget. A new worker
// starts there too, before its first heartbeat has read anything.
//
// NOTHING HERE RUNS TODAY. No legacy keeper builds a budget or a follower; only
// the dispatcher's entry points, which production never starts, will.

import type { JupiterPacer } from "./jupiter-pacer.js";
import type { RpcBudget } from "./rpc-budget.js";

/** Helius Developer's sustained requests a second: the repo's own record (F/ scale §3), as the ADR uses it. */
export const HELIUS_DEVELOPER_RPS = 50;

/**
 * The share of the plan the fleet may use: 0.8, so 40 of Developer's 50 (ADR
 * §3.9). ASSUMED there, as in COST_MODEL, and kept: the rest is headroom for the
 * website's own reads on the same project and for bursts no bucket sees.
 */
export const FLEET_RPS_SHARE = 0.8;

/** What the scheduler process keeps for its own tick, in requests a second (ADR §3.9). */
export const SCHEDULER_RPS = 8;

/** How long a worker runs on a quota it has stopped hearing before it drops to the floor: 2 min ([QUEUE] §2.8). */
export const QUOTA_STALE_MS = 120_000;

/** How long one read of the worker row may take before the heartbeat gives up on it for this beat. */
export const QUOTA_READ_TIMEOUT_MS = 5_000;

export interface FleetQuotaInput {
  /** The provider plan's requests a second. Default HELIUS_DEVELOPER_RPS. */
  readonly planRps?: number;
  /** The share of it the fleet may use. Default FLEET_RPS_SHARE. */
  readonly share?: number;
  /** What the scheduler keeps. Default SCHEDULER_RPS, and never more than the fleet's whole budget. */
  readonly schedulerRps?: number;
  /** Workers alive this tick (heartbeat inside its bound). Zero is allowed: then there is no per-worker share. */
  readonly liveWorkers: number;
  /** The most workers the fleet is configured to run: the floor's divisor. At least 1, and at least liveWorkers. */
  readonly maxWorkers: number;
  /** The organisation's Jupiter calls a minute (SIP_SOLANA_JUPITER_CALLS_PER_MINUTE's meaning), or null for none. */
  readonly jupiterPerMinute?: number | null;
}

export interface FleetQuotas {
  readonly fleetRps: number;
  readonly schedulerRps: number;
  /** Each live worker's rps_quota: (fleet − scheduler) / live. Null with no live worker. */
  readonly perWorkerRps: number | null;
  /** The static floor: (fleet − scheduler) / r_max. */
  readonly floorRps: number;
  /** Each live worker's jup_quota, in calls a minute (whole calls): the organisation's minute over the live workers. */
  readonly perWorkerJupiterPerMinute: number | null;
  readonly floorJupiterPerMinute: number | null;
}

const positive = (value: number, name: string): number => {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive, finite number, not ${value}`);
  return value;
};

/**
 * The scheduler's hand-out for one tick (ADR §3.8 step 7).
 *
 * THE STANDBY SCHEDULER IS NOT IN THE SUM. It holds no lock, runs no tick and
 * makes a handful of calls a minute; giving it a share would take one from the
 * workers for nothing. During a split brain (two schedulers both ticking,
 * failure-matrix row 16) the fleet reads twice for a while; the 20 % the fleet
 * leaves of the plan is what absorbs it.
 *
 * JUPITER IN WHOLE CALLS, AND ROUNDED DOWN: a share of 7.5 calls a minute is 7,
 * so the shares never add up to more than the organisation's minute. A share
 * smaller than one buying turn (18 calls for the owner's basket) defers that
 * turn on that worker every time (JupiterPacer.retune says why it is not a
 * refusal); the scheduler's caller should treat perWorkerJupiterPerMinute below
 * the largest basket as a reason to run fewer workers, not more.
 */
export function fleetQuotas(input: FleetQuotaInput): FleetQuotas {
  const planRps = positive(input.planRps ?? HELIUS_DEVELOPER_RPS, "planRps");
  const share = positive(input.share ?? FLEET_RPS_SHARE, "share");
  if (share > 1) throw new Error(`share is a fraction of the plan, at most 1, not ${share}`);
  if (!Number.isSafeInteger(input.maxWorkers) || input.maxWorkers < 1) throw new Error(`maxWorkers must be a whole number of workers, at least 1, not ${input.maxWorkers}`);
  if (!Number.isSafeInteger(input.liveWorkers) || input.liveWorkers < 0 || input.liveWorkers > input.maxWorkers) {
    throw new Error(`liveWorkers must be a whole number from 0 to maxWorkers (${input.maxWorkers}), not ${input.liveWorkers}`);
  }
  const fleetRps = planRps * share;
  const schedulerRps = Math.min(positive(input.schedulerRps ?? SCHEDULER_RPS, "schedulerRps"), fleetRps);
  const workersRps = fleetRps - schedulerRps;
  const jupiter = input.jupiterPerMinute ?? null;
  if (jupiter !== null) positive(jupiter, "jupiterPerMinute");
  return {
    fleetRps,
    schedulerRps,
    perWorkerRps: input.liveWorkers === 0 ? null : workersRps / input.liveWorkers,
    floorRps: workersRps / input.maxWorkers,
    perWorkerJupiterPerMinute: jupiter === null || input.liveWorkers === 0 ? null : Math.floor(jupiter / input.liveWorkers),
    floorJupiterPerMinute: jupiter === null ? null : Math.floor(jupiter / input.maxWorkers),
  };
}

/**
 * What a worker reads of its own `worker` row (ADR §3.4; [QUEUE] §2.3).
 *
 * `ageMs` IS THE STORE'S TO FILL, and it must be HOW LONG AGO THE SCHEDULER
 * LAST WROTE THESE QUOTAS — not the row's heartbeat_at, which the worker itself
 * writes every 10 s and which stays fresh while the scheduler is dead. The
 * table as designed carries no column for it; fleet.tick_at (the scheduler's
 * last tick) is the natural source, or a column of the store track's own.
 *
 * AN AGE, NOT A TIMESTAMP, for the reason the ADR keeps every lease on
 * clock_timestamp() (§3.5, S-3): computed in SQL as `clock_timestamp() −
 * written_at`, both ends on the database's clock, it means the same thing on a
 * worker whose own clock is ten minutes off. A timestamp compared with the
 * worker's Date.now would not.
 *
 * Without it every quota reads as unheard and the worker stays on the floor —
 * slow, never over the plan.
 */
export interface WorkerQuotaRow {
  /** rps_quota: requests a second. */
  readonly rpsQuota: number | null;
  /** jup_quota: Jupiter calls a MINUTE — the pacer's unit and SIP_SOLANA_JUPITER_CALLS_PER_MINUTE's. */
  readonly jupQuotaPerMinute: number | null;
  /** How long ago the scheduler wrote them, by the database's clock alone. */
  readonly ageMs: number | null;
}

/** One read of this worker's row; null when the row is not there. Implemented by the store track, injected here. */
export interface WorkerQuotaSource {
  readQuota(): Promise<WorkerQuotaRow | null>;
}

/** Where the follower's numbers came from at its last beat. */
export type QuotaSourceState = "floor" | "row" | "holding";

export interface QuotaFollowerStatus {
  readonly state: QuotaSourceState;
  readonly rpsQuota: number;
  readonly jupiterPerMinute: number | null;
  /** When the quota in force was written (this worker's clock minus the database's age), or null when none has been heard since boot. */
  readonly heardAt: string | null;
  /** Row values that were refused: not a positive number, or above the fleet's whole budget. */
  readonly refused: number;
  /** Reads of the row that threw or timed out. */
  readonly readFailures: number;
}

export interface QuotaFollowerOptions {
  readonly budget: Pick<RpcBudget, "setQuota">;
  /** The worker's Jupiter pacer, or null in a process that buys nothing (the scheduler). */
  readonly pacer: Pick<JupiterPacer, "retune"> | null;
  readonly floorRps: number;
  readonly floorJupiterPerMinute: number | null;
  /** The fleet's whole rps: a row above it is a scheduler bug, refused rather than obeyed. */
  readonly maxRps: number;
  readonly staleMs?: number;
  readonly readTimeoutMs?: number;
  readonly now?: () => number;
}

/**
 * A worker's half of the quota hand-out: what its heartbeat calls with the row
 * it read (apply) or with the store to read it from (refresh).
 *
 * THREE STATES, AND A SAFE FIRST ONE.
 *   * floor   — at boot, and whenever the newest quota heard was WRITTEN more
 *               than staleMs ago.
 *   * row     — a quota written less than staleMs ago was just read and set.
 *   * holding — this beat brought nothing usable (no row, a failed read, a
 *               refused value), but the quota last set was written less than
 *               staleMs ago: keep it. A failed read is not a dead scheduler.
 *
 * THE TWO MINUTES RUN FROM WHEN THE SCHEDULER WROTE, not from when this worker
 * last read: re-reading an old row every 10 s must not keep it alive.
 */
export class QuotaFollower {
  readonly #budget: Pick<RpcBudget, "setQuota">;
  readonly #pacer: Pick<JupiterPacer, "retune"> | null;
  readonly #floorRps: number;
  readonly #floorJupiter: number | null;
  readonly #maxRps: number;
  readonly #staleMs: number;
  readonly #readTimeoutMs: number;
  readonly #now: () => number;
  #state: QuotaSourceState = "floor";
  #rps: number;
  #jupiter: number | null;
  #heardAt: number | null = null;
  #refused = 0;
  #readFailures = 0;

  constructor(options: QuotaFollowerOptions) {
    this.#budget = options.budget;
    this.#pacer = options.pacer;
    this.#floorRps = positive(options.floorRps, "floorRps");
    this.#floorJupiter = options.floorJupiterPerMinute;
    this.#maxRps = positive(options.maxRps, "maxRps");
    this.#staleMs = options.staleMs ?? QUOTA_STALE_MS;
    this.#readTimeoutMs = options.readTimeoutMs ?? QUOTA_READ_TIMEOUT_MS;
    this.#now = options.now ?? (() => Date.now());
    this.#rps = this.#floorRps;
    this.#jupiter = this.#floorJupiter;
    this.#toFloor();
  }

  #toFloor(): void {
    this.#state = "floor";
    this.#rps = this.#floorRps;
    this.#budget.setQuota(this.#floorRps);
    if (this.#pacer !== null && this.#floorJupiter !== null) {
      this.#jupiter = this.#floorJupiter;
      this.#pacer.retune(this.#floorJupiter);
    }
  }

  /** One beat's worth: `row` is what the heartbeat read, or null when it read nothing. */
  apply(row: WorkerQuotaRow | null): QuotaFollowerStatus {
    const now = this.#now();
    const age = row?.ageMs ?? null;
    const fresh = row !== null && age !== null && Number.isFinite(age) && age >= 0 && age <= this.#staleMs;
    const rps = fresh ? row.rpsQuota : null;
    const usable = rps !== null && Number.isFinite(rps) && rps > 0 && rps <= this.#maxRps;
    if (fresh && rps !== null && !usable) this.#refused += 1;
    if (usable) {
      this.#rps = rps;
      this.#budget.setQuota(rps);
      const jupiter = row!.jupQuotaPerMinute;
      if (this.#pacer !== null && jupiter !== null) {
        if (this.#pacer.retune(jupiter)) this.#jupiter = Math.floor(jupiter);
        else this.#refused += 1;
      }
      // WHEN IT WAS WRITTEN, on this worker's clock: the age is the database's, and so is skew-free.
      this.#heardAt = now - age!;
      this.#state = "row";
    } else if (this.#heardAt === null || now - this.#heardAt > this.#staleMs) {
      if (this.#state !== "floor") this.#toFloor();
    } else {
      this.#state = "holding";
    }
    return this.status();
  }

  /**
   * Reads the row and applies it. A read that throws or outlasts readTimeoutMs
   * is a beat that heard nothing — never a throw into the heartbeat, which has
   * a lease to renew.
   */
  async refresh(source: WorkerQuotaSource): Promise<QuotaFollowerStatus> {
    let row: WorkerQuotaRow | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      row = await Promise.race([
        source.readQuota(),
        new Promise<never>((_, fail) => {
          timer = setTimeout(() => fail(new Error("the worker row's quota read timed out")), this.#readTimeoutMs);
        }),
      ]);
    } catch {
      this.#readFailures += 1;
      row = null;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    return this.apply(row);
  }

  status(): QuotaFollowerStatus {
    return {
      state: this.#state,
      rpsQuota: this.#rps,
      jupiterPerMinute: this.#pacer === null ? null : this.#jupiter,
      heardAt: this.#heardAt === null ? null : new Date(this.#heardAt).toISOString(),
      refused: this.#refused,
      readFailures: this.#readFailures,
    };
  }
}
