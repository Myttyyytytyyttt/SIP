// The dispatcher's /status and /health (Q5): a fleet view read from Postgres,
// and a health verdict per role (dispatcher ADR §3.11 "Health", §6.3 "leases
// (L4+)" and "Postgres (L4+)"; [QUEUE] §2.11; plan §3.3.1 Q5).
//
// WHY THE PAGE COMES FROM POSTGRES. Today's /status is one keeper's memory: it
// is the fleet because the fleet is one process per role. Under the dispatcher
// the work is spread over a scheduler, its standby and r workers × s slots, and
// a request reaches whichever scheduler replica Railway routes it to — which may
// be the standby, which acts on nothing. Only Postgres holds what all of them
// did: the lock holder's tick, every worker's heartbeat, every lease, what is
// due and for how long, what was sent. So any replica answers, and every
// replica answers the same page ([QUEUE] §2.11).
//
// NO DATABASE CALL INSIDE THE HANDLER, the rule src/status.ts states for the
// RPC and for the same reason: a probe must never fail because the upstream is
// down, and a public route must never be a way to load the database. The page
// is a SNAPSHOT a timer refreshes (FLEET_STATUS_REFRESH_MS) with one statement,
// and the handler renders the last one with how old it is and whether the last
// read failed. AN UNREAD FLEET AND AN EMPTY ONE ARE DIFFERENT FACTS
// (LeaderboardReply's rule): before the first read `fleet` is null and `read`
// says so; after a failure the last good snapshot stays, marked stale.
//
// EVERY AGE IS THE DATABASE'S. Lease ages, due waits, heartbeat ages and the
// tick's age are computed in SQL against clock_timestamp(), the one clock every
// lease comparison already uses (ADR §3.5), so a replica whose clock is ten
// minutes off reports the same ages as one whose clock is right.
//
// /health PER ROLE ([QUEUE] §2.11). The scheduler is unhealthy when its tick has
// not MOVED for max(3 ticks, 10 min) — today's rule (decideHealth), applied to
// the tick instead of the sweep. A worker is unhealthy only when its heartbeat
// LOOP stops — never because the chain or Postgres answered badly: "a restart
// has never once fixed an RPC" (src/status.ts), and a heartbeat that FAILS is a
// lease that expires, which the takeover rule already handles without a
// restart. A stopped event loop answers no probe at all, which is its own
// verdict. Railway asks /health only at deploy time (ADR §3.11, RT-11); the
// watchdog's self-exit is what acts on the same verdict afterwards.
//
// DARK. Nothing in the legacy keepers imports this file: the scheduler and
// worker entry points (Q2, Q3) are to construct the reader and serve the view.
// The snapshot is read from Q1's tables (sql/sip_solana.sql, through
// src/fleet-pg.ts), and a worker's row is written by Q1's store
// (src/dispatch-store.ts: its stats and the quota age on every beat).

import type { Redactor } from "@sip/solana-log";
import { summarizeUpstreamError } from "@sip/solana-log";
import type { FleetAlertsStatus } from "./fleet-alerts.js";
import type { FleetReceiverStatus } from "./fleet-receiver.js";
import { SERVICE } from "./keeper-log.js";
import { healthStaleAfterMs, type HealthReport } from "./status.js";

/** The dispatcher's two process kinds (ADR §3.11). Not a row of the role registry: the registry's roles are the legacy keepers'. */
export type FleetRole = "scheduler" | "worker";

/**
 * What /health watches on each kind, as a table and not a ternary — L0's rule
 * (src/role-registry.ts): a third kind without a row does not compile, where a
 * `role === "scheduler" ? … : …` would hand it the worker's answer in silence.
 */
export const FLEET_ROLE_HEALTH = {
  scheduler: { loop: "tick" },
  worker: { loop: "heartbeat loop" },
} as const satisfies Record<FleetRole, { readonly loop: string }>;

/**
 * How often the snapshot is re-read: every fifteen seconds. One statement each
 * time, on the replica's pool — on a scheduler, its ONE pooled connection
 * (SCHEDULER_POOL_MAX), which the receiver and the tick share; the scheduler's
 * own tick runs every sixty, so the page is at most a quarter of a tick behind
 * the table.
 */
export const FLEET_STATUS_REFRESH_MS = 15_000;

/**
 * How long one read may take before it counts as failed: five seconds, the
 * pool's own statement_timeout (src/read-model.ts). A read that has not
 * answered by then is not raced by a second one: the next refresh is skipped
 * until the first settles, so a stalled database holds one statement, not one
 * per tick.
 */
export const FLEET_STATUS_READ_BUDGET_MS = 5_000;

/** A worker whose heartbeat is older than this is dead: two minutes (ADR §3.8, reap). */
export const WORKER_DEAD_AFTER_MS = 2 * 60_000;

/** The worker's heartbeat interval (ADR §3.7): the loop /health watches on a worker. */
export const WORKER_HEARTBEAT_MS = 10_000;

/** The job ceiling (ADR §3.7): a lease claimed longer ago than this is a job the heartbeat no longer renews. */
export const JOB_CEILING_MS = 6 * 60_000;

/** The most parked vaults listed by address on the page; the count is always whole. */
export const PARKED_LISTED = 50;

/**
 * What a worker reports about itself in `worker.stats` (jsonb), the contract
 * between the worker (Q3, which writes it on its heartbeat) and this page.
 * COUNTERS SINCE THAT WORKER'S BOOT. Only these keys are read, and only these
 * are served: the column is free jsonb, and a public page serves what it names.
 */
export interface WorkerStats {
  /** GATE statements that returned no row: a send this worker signed and dropped because its lease was gone (ADR §3.5). */
  readonly fenceRejects: number | null;
  /** COMPLETE statements that updated no row, and heartbeats that dropped a vault: leases this worker lost mid-job. */
  readonly leaseLosses: number | null;
  /** Jobs this worker completed in its last ten minutes. */
  readonly jobsLast10Min: number | null;
  /** Leases released on SIGTERM (ADR §3.11: the proof that the drain variable works). */
  readonly releasedOnSigterm: number | null;
}

/** The keys of WorkerStats as they are spelled in the jsonb. */
export const WORKER_STATS_KEYS = ["fenceRejects", "leaseLosses", "jobsLast10Min", "releasedOnSigterm"] as const;

/** One `worker` row, as served. */
export interface FleetWorkerRow {
  readonly workerId: string;
  readonly kind: string;
  readonly version: string;
  readonly startedAt: string | null;
  readonly heartbeatAgeMs: number | null;
  /** Heartbeat older than WORKER_DEAD_AFTER_MS, and not stopped: the reap's verdict, read rather than written. */
  readonly dead: boolean;
  readonly stoppedAt: string | null;
  readonly slots: number;
  readonly busy: number;
  /** Vault leases this worker holds and has not let lapse. */
  readonly leases: number;
  readonly rpsQuota: number | null;
  readonly jupQuota: number | null;
  /**
   * How long ago the scheduler wrote those two quotas (worker.quota_at), by the
   * database's clock; null before the first hand-out. Past QUOTA_STALE_MS
   * (src/rpc-quota.ts) the worker runs on its floor, whatever the row says.
   */
  readonly quotaAgeMs: number | null;
  readonly stats: WorkerStats;
}

/** The one `fleet` row: the lock holder's tick and the fleet-wide flags. */
export interface FleetSchedulerRow {
  readonly schedulerId: string | null;
  readonly tickAt: string | null;
  /** How long ago the lock holder last ticked, by the database's clock; null before any tick. */
  readonly tickAgeMs: number | null;
  /** A full pass requested and not yet taken by the scheduler: a lost delivery, a failed bell write, a 403. */
  readonly fullPassReason: string | null;
  readonly boardDirtyAt: string | null;
  readonly discoveryOkAt: string | null;
  readonly discoveryAgeMs: number | null;
}

/** The claimable rows of one lane — due, not parked, on the queue, free or with a lapsed lease — and how long they have waited. */
export interface LaneLag {
  readonly due: number;
  readonly waitP50Ms: number | null;
  readonly waitP90Ms: number | null;
  readonly waitMaxMs: number | null;
}

export interface FleetLeases {
  /** Held, lease still running. */
  readonly held: number;
  /** Held, lease lapsed and not yet reclaimed: the holder stopped heartbeating. */
  readonly expired: number;
  /** Held longer than the job ceiling: the heartbeat refuses them, so they will lapse. */
  readonly overCeiling: number;
  /** Held after at least one claim that did not complete (attempts ≥ 2): a takeover of a lapsed lease. */
  readonly takeovers: number;
  /** How long held rows waited between due and claimed (claimed_at − due_at), over the rows held now. */
  readonly claimLagP50Ms: number | null;
  readonly claimLagP90Ms: number | null;
}

export interface FleetQueue {
  /** Every vault_work row by `system`: legacy, draining, queue (ADR §3.12). */
  readonly bySystem: Readonly<Record<string, number>>;
  /** Claimable rows by lane. A lane with nothing due is absent. */
  readonly lanes: Readonly<Record<string, LaneLag>>;
  /** Claimable rows in all. */
  readonly due: number;
  /** The longest any claimable row has waited past its due time: what `queue-lag` reads. */
  readonly oldestDueMs: number | null;
  readonly leases: FleetLeases;
  readonly parked: { readonly count: number; readonly vaults: readonly { readonly vault: string; readonly reason: string; readonly attempts: number }[] };
  /** Queue vaults by their last job's outcome ("none" before the first). */
  readonly outcomes: Readonly<Record<string, number>>;
}

export interface FleetSends {
  /**
   * Intents not yet resolved (resolved_at IS NULL), and the oldest one's age.
   * Shadow rows included: under SIP_SOLANA_DISPATCH=shadow every intent is a
   * 'shadow' row, open until a job resolves it as `on` would.
   */
  readonly open: number;
  readonly oldestOpenAgeMs: number | null;
  /** Landed more than five minutes ago in the last hour and never seen in a delivery: the deaf webhook's evidence (ADR §3.8 step 5). */
  readonly unechoed: number;
  /** The last hour's intents, by kind and state. */
  readonly lastHour: readonly { readonly kind: string; readonly state: string; readonly count: number }[];
}

/** A lease that lapsed: the vault and the fence of the claim that did not complete. The evidence `lease-expired` counts. */
export interface LeaseExpiry {
  readonly vault: string;
  readonly fence: number;
}

/**
 * The fleet in one statement (FleetStatusSource.read). Everything a replica
 * needs to serve /status and to evaluate the fleet's alerts.
 */
export interface FleetSnapshot {
  /** The database's clock when the statement ran. */
  readonly now: string;
  /** The `fleet` row, or null when no scheduler has ever written one. */
  readonly scheduler: FleetSchedulerRow | null;
  readonly workers: readonly FleetWorkerRow[];
  readonly queue: FleetQueue;
  readonly sends: FleetSends;
  /** Rows in `loss_carry`: today's `pendingCarries`, fleet-wide. */
  readonly carries: { readonly pending: number };
  /** Lapsed leases visible now: held and lapsed, and the claims a takeover's attempts count says did not complete. */
  readonly expiries: readonly LeaseExpiry[];
}

/**
 * Where the snapshot comes from. PgFleetStore (src/fleet-pg.ts) is the real
 * one, over Q1's tables and on the scheduler's pool from
 * createDispatchPool(…, "scheduler") — the one the receiver writes through
 * (test/dispatch-wiring-pg.test.ts runs both on it at once).
 */
export interface FleetStatusSource {
  read(): Promise<FleetSnapshot>;
}

/** Whether the page is current: when it was last read, how, and how many reads failed. */
export interface FleetReadStatus {
  /** Null before the first read has finished; then whether the LAST read succeeded. */
  readonly ok: boolean | null;
  /** When the snapshot served was read, by this process's clock, or null when none was. */
  readonly at: string | null;
  readonly ageMs: number | null;
  readonly reads: number;
  readonly failures: number;
  readonly consecutiveFailures: number;
  /** Refreshes not started because the previous read had not settled. */
  readonly skipped: number;
  readonly lastError: string | null;
}

/** SQLSTATEs that mean the schema is not there: undefined table, undefined column. */
const SCHEMA_MISSING = new Set(["42P01", "42703"]);

/**
 * What a failed read says on the page. A missing table is the one failure an
 * operator fixes by running something, so it says what to run; everything else
 * is the upstream's summary, scrubbed (summarizeUpstreamError).
 */
export function describeReadFailure(error: unknown): string {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  if (typeof code === "string" && SCHEMA_MISSING.has(code)) {
    return `the dispatcher's tables are not in this database (${summarizeUpstreamError(error)}); apply sql/sip_solana.sql with setup-read-model`;
  }
  return summarizeUpstreamError(error);
}

export interface FleetStatusReaderOptions {
  readonly source: FleetStatusSource;
  readonly now?: () => number;
  readonly budgetMs?: number;
  /** Told every snapshot read: the alerts evaluate here (FleetAlerts.observeSnapshot). Its throws are swallowed. */
  readonly onSnapshot?: (snapshot: FleetSnapshot) => void;
}

/**
 * The timer's half of the page: reads the snapshot, keeps the last good one,
 * and counts what failed. The handler's half is fleetStatusView, which never
 * waits for this.
 */
export class FleetStatusReader {
  readonly #source: FleetStatusSource;
  readonly #now: () => number;
  readonly #budgetMs: number;
  readonly #onSnapshot: ((snapshot: FleetSnapshot) => void) | undefined;
  #snapshot: FleetSnapshot | null = null;
  #at: number | null = null;
  #ok: boolean | null = null;
  #reads = 0;
  #failures = 0;
  #consecutiveFailures = 0;
  #skipped = 0;
  #lastError: string | null = null;
  /** The underlying read, held until IT settles — not until the budget does — so reads never pile up. */
  #inFlight: Promise<FleetSnapshot> | null = null;

  constructor(options: FleetStatusReaderOptions) {
    this.#source = options.source;
    this.#now = options.now ?? (() => Date.now());
    this.#budgetMs = options.budgetMs ?? FLEET_STATUS_READ_BUDGET_MS;
    this.#onSnapshot = options.onSnapshot;
  }

  /** One read. True when a fresh snapshot is now served; false when it failed or was skipped. Never throws. */
  async refresh(): Promise<boolean> {
    if (this.#inFlight !== null) {
      this.#skipped += 1;
      return false;
    }
    this.#reads += 1;
    let started: Promise<FleetSnapshot>;
    try {
      started = this.#source.read();
    } catch (error) {
      started = Promise.reject(error);
    }
    // SETTLED IS THE READ'S OWN END, not the budget's: a read past its budget is
    // still holding a connection, and the next refresh waits for it.
    let settled = false;
    const read = started.then(
      (snapshot) => {
        settled = true;
        return snapshot;
      },
      (error: unknown) => {
        settled = true;
        throw error;
      },
    );
    this.#inFlight = read;
    void read
      .catch(() => undefined)
      .finally(() => {
        if (this.#inFlight === read) this.#inFlight = null;
      });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`the fleet read took longer than ${this.#budgetMs} ms`)), this.#budgetMs);
      timer.unref?.();
    });
    try {
      const snapshot = await Promise.race([read, budget]);
      this.#snapshot = snapshot;
      this.#at = this.#now();
      this.#ok = true;
      this.#consecutiveFailures = 0;
      this.#lastError = null;
      if (this.#onSnapshot !== undefined) {
        try {
          this.#onSnapshot(snapshot);
        } catch {
          // The page is served whatever the alerts made of it.
        }
      }
      return true;
    } catch (error) {
      this.#ok = false;
      this.#failures += 1;
      this.#consecutiveFailures += 1;
      this.#lastError = describeReadFailure(error);
      return false;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (settled && this.#inFlight === read) this.#inFlight = null;
    }
  }

  /** The last good snapshot, or null when none was ever read. */
  snapshot(): FleetSnapshot | null {
    return this.#snapshot;
  }

  status(): FleetReadStatus {
    const now = this.#now();
    return {
      ok: this.#ok,
      at: this.#at === null ? null : new Date(this.#at).toISOString(),
      ageMs: this.#at === null ? null : Math.max(0, now - this.#at),
      reads: this.#reads,
      failures: this.#failures,
      consecutiveFailures: this.#consecutiveFailures,
      skipped: this.#skipped,
      lastError: this.#lastError,
    };
  }
}

// ── /health per role ─────────────────────────────────────────────────────────

export interface FleetHealthInput {
  readonly role: FleetRole;
  readonly now: number;
  /** When the process came up: the only clock before its loop first moves. */
  readonly startedAt: number;
  /**
   * When the role's loop last MOVED, or null until it has.
   *   scheduler: a tick finished or made progress — holding the lock or standing
   *     by, because a standby's tick is its claim attempt and a standby that
   *     stopped trying is the one that will not take over (ADR §4.9 row 14).
   *   worker: a heartbeat ATTEMPT finished, answered or not. A heartbeat Postgres
   *     refused is the loop working; only a loop that stopped is a verdict.
   */
  readonly lastProgressAt: number | null;
  /** The loop's interval: the tick (SIP_SOLANA_SWEEP_MS) or WORKER_HEARTBEAT_MS. */
  readonly intervalMs: number;
}

/**
 * What /health answers for a dispatcher process.
 *
 * THE BOUND IS TODAY'S: max(3 × interval, 10 min) (healthStaleAfterMs,
 * src/status.ts). On a worker that is ten minutes for a ten-second loop, which
 * is generous on purpose: its leases lapse in 45 s anyway and the takeover rule
 * covers them, so a restart buys nothing sooner — and a probe that fires early
 * is a restart loop (HEALTH_STALE_FLOOR_MS). Numbers and fixed words only, like
 * decideHealth: nothing upstream reaches an answer that is never scrubbed.
 */
export function decideFleetHealth(input: FleetHealthInput): HealthReport {
  const staleAfterMs = healthStaleAfterMs(input.intervalMs);
  const since = input.lastProgressAt ?? input.startedAt;
  const quietForMs = input.now - since;
  if (!(quietForMs >= staleAfterMs)) return { ok: true };
  const seconds = Math.round(quietForMs / 1000);
  const loop = FLEET_ROLE_HEALTH[input.role].loop;
  return {
    ok: false,
    detail:
      input.lastProgressAt === null
        ? `no ${loop} has run in the ${seconds}s since this ${input.role} came up`
        : `the ${input.role}'s ${loop} last moved ${seconds}s ago`,
    quietForMs,
    staleAfterMs,
  };
}

// ── the page ─────────────────────────────────────────────────────────────────

/** This process's pool, as pg.Pool counts it. */
export interface PoolSample {
  readonly total: number;
  readonly idle: number;
  /** Queries queued for a connection: `pg.waiting` (ADR §6.3), what `pg-saturated` reads. */
  readonly waiting: number;
}

/** pg.Pool's three counters, read without a query. */
export function samplePool(pool: { readonly totalCount: number; readonly idleCount: number; readonly waitingCount: number }): PoolSample {
  return { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount };
}

/** What a dispatcher replica serves at /status. */
export interface FleetStatusView {
  readonly service: string;
  readonly role: FleetRole;
  readonly process: { readonly id: string; readonly startedAt: string; readonly version: string | null };
  /** What /health answers right now: the same verdict, so the page and the probe never disagree. */
  readonly health: HealthReport;
  readonly read: FleetReadStatus;
  /** The last good snapshot of the whole fleet, or null before the first. `read` says how old it is. */
  readonly fleet: FleetSnapshot | null;
  /** This replica's webhook receiver (scheduler replicas only). */
  readonly receiver?: FleetReceiverStatus;
  /** This process's Postgres pools and the fleet alerts it evaluates. */
  readonly alerts?: FleetAlertsStatus;
}

export interface FleetStatusViewInput {
  readonly role: FleetRole;
  readonly processId: string;
  readonly startedAt: number;
  readonly version?: string | null;
  readonly health: HealthReport;
  readonly reader: FleetStatusReader;
  readonly receiver?: { status(): FleetReceiverStatus } | null;
  readonly alerts?: { status(): FleetAlertsStatus } | null;
}

/** The page, from what the timers already gathered. No I/O. */
export function fleetStatusView(input: FleetStatusViewInput): FleetStatusView {
  return {
    service: SERVICE,
    role: input.role,
    process: { id: input.processId, startedAt: new Date(input.startedAt).toISOString(), version: input.version ?? null },
    health: input.health,
    read: input.reader.status(),
    fleet: input.reader.snapshot(),
    ...(input.receiver ? { receiver: input.receiver.status() } : {}),
    ...(input.alerts ? { alerts: input.alerts.status() } : {}),
  };
}

const bigintSafe = (_key: string, value: unknown): unknown => (typeof value === "bigint" ? value.toString() : value);

/**
 * The page as served: JSON, scrubbed, and withheld whole if the tripwire finds a
 * registered secret — renderStatus's rule (src/status.ts). The snapshot carries
 * text other processes wrote (a parked vault's reason, a full-pass reason built
 * from an upstream error), and this route is public and unauthenticated.
 */
export function renderFleetStatus(view: FleetStatusView, redactor: Redactor): string {
  const scrubbed = redactor.scrub(JSON.stringify(view, bigintSafe));
  if (redactor.contains(scrubbed)) {
    return JSON.stringify({ service: SERVICE, status: "withheld: redaction tripwire" });
  }
  return scrubbed;
}
