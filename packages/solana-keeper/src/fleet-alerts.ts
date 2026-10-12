// The dispatcher's five alerts (Q5): lease-expired, fence-reject, queue-lag,
// scheduler-stale and pg-saturated (dispatcher ADR §6.3 rows "leases (L4+)" and
// "Postgres (L4+)", §4.9 rows 1-7 and 15, §3.11 "Health"; plan §3.3.1 Q5).
//
// THE ADR'S SEVERITIES AND NOTHING LOUDER. Only `critical` leaves the box
// (src/alerts.ts), so the severity IS the decision to wake somebody:
//
//   | key             | warn                         | critical (pages)                       |
//   |-----------------|------------------------------|----------------------------------------|
//   | lease-expired   | 1-2 lapsed leases in an hour | ≥ 3 in an hour                         |
//   | fence-reject    | —                            | any, within the hour                   |
//   | queue-lag       | —                            | a due vault unclaimed > 2 windows      |
//   | scheduler-stale | —                            | fleet.tick_at older than 10 minutes    |
//   | pg-saturated    | —                            | queries waiting for a connection on    |
//   |                 |                              | 3 ticks in a row                       |
//
// Where the ADR names only the page, there is no warn: a lower rung nobody
// asked for is a new behaviour, and on this branch a new behaviour is off until
// named (plan §2 rule 1). Each rule clears on the condition's end, so the next
// occurrence pages again; queue-lag clears only once the wait is back under ONE
// window, so a lag that hovers at the threshold pages once, not once a refresh.
//
// PURE RULES, ONE STATEFUL EVALUATOR. Each rule is a function over numbers
// returning what to raise and whether to clear (AlertDecision,
// src/usage-alerts.ts), so a test pins every threshold without a fleet around
// it. FleetAlerts holds the little state the rules need — the hour of lapsed
// leases, each worker's last reject count, the pool's streak — and applies the
// decisions to the process's alerter.
//
// WHO EVALUATES WHAT. Two scheduler replicas read the same snapshot; if both
// paged, every condition would page twice. So only the replica that holds the
// scheduler lock (`acting`) raises the fleet's conditions — lease-expired,
// fence-reject, queue-lag. scheduler-stale is evaluated by EVERY reader, the
// standby above all: a hung lock holder is exactly the process that will not
// page about itself (ADR §4.9 row 15), and the ADR has workers page it too
// (§3.11). pg-saturated is about this process's own pools, so each process
// pages its own.
//
// NONE OF THEM DECIDES ANYTHING. They read counters after the fact and change
// only who is woken.

import type { Alerter } from "./alerts.js";
import type { FleetSnapshot, PoolSample } from "./fleet-status.js";
import type { AlertDecision } from "./usage-alerts.js";

const nothing: AlertDecision = { fire: null, clear: false };
const cleared: AlertDecision = { fire: null, clear: true };
const HOUR_MS = 60 * 60_000;
const minutes = (ms: number): number => Math.round(ms / 6_000) / 10;

// --- lease-expired -----------------------------------------------------------

export const LEASE_EXPIRED_ALERT_KEY = "lease-expired";
/** Lapsed leases in an hour at which it pages: 3 (ADR §6.3). */
export const LEASE_EXPIRED_CRITICAL_PER_HOUR = 3;

/**
 * Leases that lapsed in the last hour: a worker that stopped heartbeating with
 * a vault in hand — killed, partitioned from Postgres, hung past the job
 * ceiling (ADR §4.9 rows 2, 3, 7, 27).
 *
 * ONE IS A WARNING, BECAUSE ONE IS A DEPLOY. With RAILWAY_DEPLOYMENT_DRAINING_SECONDS
 * at its default 0, every worker deploy is a SIGKILL and every lease it held
 * lapses (ADR §3.11, RT-16); nothing is lost — the successor waits out the
 * intents and takes over — but somebody should be able to see it happened.
 * Three in an hour is no longer a deploy.
 */
export function leaseExpiredAlert(input: { readonly expiredLastHour: number; readonly latest: string | null }): AlertDecision {
  const n = input.expiredLastHour;
  if (n <= 0) return cleared;
  const critical = n >= LEASE_EXPIRED_CRITICAL_PER_HOUR;
  return {
    fire: {
      key: LEASE_EXPIRED_ALERT_KEY,
      severity: critical ? "critical" : "warn",
      title: critical ? "Vault leases keep lapsing: workers stop with vaults in hand" : "A vault lease lapsed",
      detail:
        `${n} lease${n === 1 ? "" : "s"} lapsed in the last hour${input.latest === null ? "" : ` (latest: ${input.latest})`}. ` +
        "A lapsed lease is a worker that stopped heartbeating mid-job: killed, cut off from Postgres, or hung past the 6-minute " +
        "ceiling. Its successor waits out every open intent before acting, so nothing is sent twice; what is lost is time. " +
        "One per deploy is expected while RAILWAY_DEPLOYMENT_DRAINING_SECONDS is 0. Read fleet.workers on /status.",
      context: { expiredLastHour: n },
    },
    clear: false,
  };
}

// --- fence-reject ------------------------------------------------------------

export const FENCE_REJECT_ALERT_KEY = "fence-reject";

/**
 * A send refused at the gate: a worker signed a transaction for a vault whose
 * lease it no longer held, and dropped it (ADR §3.5 GATE, §4.4).
 *
 * IT PAGES ON ANY (ADR §6.3), because the fence did its job and something
 * upstream of it did not: a worker kept working after its lease was taken. The
 * only expected rejects are the ones a drill causes, and a drill knows.
 */
export function fenceRejectAlert(input: { readonly rejectsLastHour: number; readonly workers: readonly string[] }): AlertDecision {
  const n = input.rejectsLastHour;
  if (n <= 0) return cleared;
  return {
    fire: {
      key: FENCE_REJECT_ALERT_KEY,
      severity: "critical",
      title: "A worker tried to send for a vault it no longer held",
      detail:
        `${n} send${n === 1 ? "" : "s"} refused at the fence in the last hour` +
        `${input.workers.length === 0 ? "" : ` (worker${input.workers.length === 1 ? "" : "s"} ${input.workers.join(", ")})`}. ` +
        "The gate dropped the signed bytes, so nothing left twice — but the worker was still acting after its lease was " +
        "taken, which no healthy job does. Outside a drill this is a bug or a stall: read that worker's leaseLosses and the vault's history.",
      context: { rejectsLastHour: n },
    },
    clear: false,
  };
}

// --- queue-lag ---------------------------------------------------------------

export const QUEUE_LAG_ALERT_KEY = "queue-lag";
/** Windows a due vault may wait unclaimed before it pages: 2 (ADR §6.3). */
export const QUEUE_LAG_CRITICAL_WINDOWS = 2;

/**
 * The longest a claimable vault has waited past its due time, against the
 * scheduler's window (its tick, SIP_SOLANA_SWEEP_MS).
 *
 * WHAT IT CATCHES: workers that are not claiming — all dead, all stuck in
 * ceiling-long jobs, all out of slots — while work piles up. A healthy queue
 * claims a due row within one poll. Under a full pass at large N the backlog
 * drains at the budget's pace (ADR §3.8 step 5) and can legitimately wait
 * longer; at today's N it drains in seconds.
 *
 * CLEARED UNDER ONE WINDOW, NOT TWO, so a wait hovering at the threshold pages
 * once instead of once per refresh.
 */
export function queueLagAlert(input: { readonly oldestDueMs: number | null; readonly due: number; readonly windowMs: number }): AlertDecision {
  const { oldestDueMs, due, windowMs } = input;
  if (oldestDueMs === null || due <= 0 || !(windowMs > 0)) return cleared;
  if (oldestDueMs <= windowMs) return cleared;
  if (oldestDueMs <= windowMs * QUEUE_LAG_CRITICAL_WINDOWS) return nothing;
  return {
    fire: {
      key: QUEUE_LAG_ALERT_KEY,
      severity: "critical",
      title: "Due vaults are waiting and no worker is claiming them",
      detail:
        `The oldest of ${due} due vault${due === 1 ? "" : "s"} has waited ${minutes(oldestDueMs)} min past its due time, ` +
        `more than ${QUEUE_LAG_CRITICAL_WINDOWS} windows of ${Math.round(windowMs / 1000)} s. Settles and buys on those vaults are late ` +
        "until a worker claims them. Read fleet.workers (dead, slots, busy) and fleet.queue.lanes on /status.",
      context: { oldestDueMs, due, windowMs },
    },
    clear: false,
  };
}

// --- scheduler-stale ---------------------------------------------------------

export const SCHEDULER_STALE_ALERT_KEY = "scheduler-stale";
/** How old fleet.tick_at may be before it pages: 10 minutes (ADR §3.11, §6.3). */
export const SCHEDULER_STALE_AFTER_MS = 10 * 60_000;

/**
 * The lock holder's tick, as it wrote it to `fleet.tick_at`.
 *
 * THE FAILURE IT IS FOR is the scheduler alive but hung while holding the lock
 * (ADR §4.9 row 15, RT-11): its session keeps the lock, so the standby never
 * takes over, and discovery, enqueueing and reaping stop while every process
 * looks up. The self-exit fixes it within its bound; this is what tells a
 * person when it did not.
 *
 * NO TICK EVER is judged by how long this process has been up: a fleet whose
 * scheduler never started is as stale as one whose scheduler stopped, once the
 * same ten minutes have passed. An unreadable `fleet` row is not evidence
 * either way, and is not handed to this rule (FleetAlerts reads only snapshots).
 */
export function schedulerStaleAlert(input: { readonly tickAgeMs: number | null; readonly upMs: number }): AlertDecision {
  const { tickAgeMs, upMs } = input;
  if (tickAgeMs === null) {
    if (!(upMs > SCHEDULER_STALE_AFTER_MS)) return nothing;
    return {
      fire: {
        key: SCHEDULER_STALE_ALERT_KEY,
        severity: "critical",
        title: "No dispatcher scheduler has ever ticked",
        detail:
          `This process has been up ${minutes(upMs)} min and fleet.tick_at has never been written. Without a scheduler nothing ` +
          "discovers links, makes vaults due or reaps leases: the queue drains what was due and then stops.",
        context: { upMs },
      },
      clear: false,
    };
  }
  if (!(tickAgeMs > SCHEDULER_STALE_AFTER_MS)) return cleared;
  return {
    fire: {
      key: SCHEDULER_STALE_ALERT_KEY,
      severity: "critical",
      title: "The dispatcher's scheduler has stopped ticking",
      detail:
        `fleet.tick_at is ${minutes(tickAgeMs)} min old. While it holds the lock and does not tick, no link is discovered, no ` +
        "vault made due by a bell or the safety rotation, and no lease reaped; workers drain what was due and then idle. The " +
        "scheduler exits on its own after max(3 ticks, 10 min) without progress and the standby takes the lock — if this persists, it did not.",
      context: { tickAgeMs },
    },
    clear: false,
  };
}

// --- pg-saturated ------------------------------------------------------------

export const PG_SATURATED_ALERT_KEY = "pg-saturated";
/** Ticks in a row with queries waiting for a connection before it pages: 3 (ADR §6.3). */
export const PG_SATURATED_CRITICAL_STREAK = 3;

/**
 * Queries queued for a Postgres connection in this process (pg.Pool's
 * waitingCount), tick after tick.
 *
 * WHY IT MATTERS MORE HERE THAN TODAY. Every send now waits on a gate
 * transaction (ADR §4.4), and every replica runs on two connections
 * ([QUEUE] §2.12): a pool that stays full delays heartbeats toward the 45 s
 * lease, and gates toward their 10 s margin. One tick with a queue is a burst;
 * three in a row is the pool, or Supabase's, being too small.
 */
export function pgSaturatedAlert(input: { readonly streak: number; readonly waiting: number; readonly total: number }): AlertDecision {
  const { streak, waiting, total } = input;
  if (streak <= 0) return cleared;
  if (streak < PG_SATURATED_CRITICAL_STREAK) return nothing;
  return {
    fire: {
      key: PG_SATURATED_ALERT_KEY,
      severity: "critical",
      title: "This process keeps waiting for a Postgres connection",
      detail:
        `Queries have queued for a connection on ${streak} ticks in a row (${waiting} waiting now, ${total} open). Heartbeats ` +
        "and send gates wait in that queue: past 45 s a lease lapses, and a gate that waits too long refuses its send. Check the " +
        "pool size and Supabase's connection limit (ADR decision 32) before adding workers.",
      context: { streak, waiting, total },
    },
    clear: false,
  };
}

// --- the evaluator -----------------------------------------------------------

/** The `alerts` block of a dispatcher process's /status. */
export interface FleetAlertsStatus {
  /** Whether the last snapshot was evaluated as the lock holder; null before the first. */
  readonly acting: boolean | null;
  readonly leaseExpiredLastHour: number;
  readonly fenceRejectsLastHour: number;
  /** Rejects reported by the workers listed now, each since its own boot. */
  readonly fenceRejectsTotal: number;
  readonly queueOldestDueMs: number | null;
  readonly schedulerTickAgeMs: number | null;
  /** This process's pools at the last tick, summed, and how many ticks in a row had queries waiting. */
  readonly pg: { readonly waiting: number; readonly total: number; readonly idle: number; readonly saturatedStreak: number } | null;
  /** Keys this evaluator has raised and not cleared. */
  readonly firing: readonly string[];
}

export interface FleetAlertsOptions {
  readonly alerter: Pick<Alerter, "fire" | "clear">;
  /** One window: the scheduler's tick (SIP_SOLANA_SWEEP_MS, 60 s by default). */
  readonly windowMs: number;
  readonly now?: () => number;
}

/**
 * Applies the five rules to what a dispatcher process sees: each fleet snapshot
 * (observeSnapshot, from FleetStatusReader's onSnapshot) and its own pools once
 * per tick (observePools).
 */
export class FleetAlerts {
  readonly #alerter: Pick<Alerter, "fire" | "clear">;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #startedAt: number;
  readonly #firing = new Set<string>();
  /** `vault:fence` of every lapsed lease seen, with when THIS process first saw it. */
  readonly #expiries = new Map<string, number>();
  #latestExpiry: string | null = null;
  /** worker id → its fenceRejects at the last snapshot; null before the first snapshot. */
  #rejectsSeen: Map<string, number> | null = null;
  /** What each snapshot found a worker's counter had grown by, and when this process saw it. */
  #rejectEvents: { readonly at: number; readonly worker: string; readonly count: number }[] = [];
  #rejectsTotal = 0;
  #acting: boolean | null = null;
  #queueOldestDueMs: number | null = null;
  #tickAgeMs: number | null = null;
  #pool: { waiting: number; total: number; idle: number } | null = null;
  #saturatedStreak = 0;

  constructor(options: FleetAlertsOptions) {
    this.#alerter = options.alerter;
    this.#windowMs = options.windowMs;
    this.#now = options.now ?? (() => Date.now());
    this.#startedAt = this.#now();
  }

  #apply(decision: AlertDecision, key: string): void {
    if (decision.fire !== null) {
      this.#alerter.fire(decision.fire);
      this.#firing.add(decision.fire.key);
    } else if (decision.clear) {
      this.#alerter.clear(key);
      this.#firing.delete(key);
    }
  }

  /**
   * One snapshot. The evidence is kept whether or not this process is acting —
   * a standby that takes the lock pages on the hour it already watched — but
   * only the acting replica raises the fleet's three conditions.
   */
  observeSnapshot(snapshot: FleetSnapshot, input: { readonly acting: boolean }): void {
    const now = this.#now();
    this.#acting = input.acting;

    // LAPSED LEASES: a key per (vault, fence), counted once, kept an hour.
    for (const expiry of snapshot.expiries) {
      const key = `${expiry.vault}:${expiry.fence}`;
      if (!this.#expiries.has(key)) {
        this.#expiries.set(key, now);
        this.#latestExpiry = `vault ${expiry.vault}, claim ${expiry.fence}`;
      }
    }
    for (const [key, at] of this.#expiries) if (now - at > HOUR_MS) this.#expiries.delete(key);

    // FENCE REJECTS: what each worker's counter grew by since the last snapshot.
    // A worker already there at this process's FIRST snapshot is a baseline —
    // what it rejected before may have paged on the scheduler before this one,
    // and repeating it after every scheduler restart would teach the owner to
    // mute it. A worker that APPEARS later was registered after that first read,
    // so all of its count is new here. (The worker that met the reject is the
    // first to know; Q3 may page it at the gate as well.)
    const first = this.#rejectsSeen === null;
    const seen = new Map<string, number>();
    let total = 0;
    for (const worker of snapshot.workers) {
      const count = worker.stats.fenceRejects ?? 0;
      total += count;
      seen.set(worker.workerId, count);
      if (first) continue;
      const before = this.#rejectsSeen!.get(worker.workerId) ?? 0;
      if (count > before) this.#rejectEvents.push({ at: now, worker: worker.workerId, count: count - before });
    }
    this.#rejectsSeen = seen;
    this.#rejectsTotal = total;
    this.#rejectEvents = this.#rejectEvents.filter((event) => now - event.at <= HOUR_MS);

    this.#queueOldestDueMs = snapshot.queue.oldestDueMs;
    this.#tickAgeMs = snapshot.scheduler?.tickAgeMs ?? null;

    if (input.acting) {
      this.#apply(leaseExpiredAlert({ expiredLastHour: this.#expiries.size, latest: this.#latestExpiry }), LEASE_EXPIRED_ALERT_KEY);
      const workers = [...new Set(this.#rejectEvents.map((event) => event.worker))];
      this.#apply(fenceRejectAlert({ rejectsLastHour: this.#rejectsLastHour(), workers }), FENCE_REJECT_ALERT_KEY);
      this.#apply(
        queueLagAlert({ oldestDueMs: snapshot.queue.oldestDueMs, due: snapshot.queue.due, windowMs: this.#windowMs }),
        QUEUE_LAG_ALERT_KEY,
      );
    } else {
      // A REPLICA THAT STOPPED ACTING HANDS ITS PAGES BACK: cleared here, so the
      // day it acts again they fire afresh, and meanwhile the holder pages them.
      for (const key of [LEASE_EXPIRED_ALERT_KEY, FENCE_REJECT_ALERT_KEY, QUEUE_LAG_ALERT_KEY]) this.#apply(cleared, key);
    }
    this.#apply(schedulerStaleAlert({ tickAgeMs: this.#tickAgeMs, upMs: now - this.#startedAt }), SCHEDULER_STALE_ALERT_KEY);
  }

  /** This process's pools, once per tick (samplePool, src/fleet-status.ts). */
  observePools(samples: readonly PoolSample[]): void {
    let waiting = 0;
    let total = 0;
    let idle = 0;
    for (const sample of samples) {
      waiting += sample.waiting;
      total += sample.total;
      idle += sample.idle;
    }
    this.#pool = { waiting, total, idle };
    this.#saturatedStreak = waiting > 0 ? this.#saturatedStreak + 1 : 0;
    this.#apply(pgSaturatedAlert({ streak: this.#saturatedStreak, waiting, total }), PG_SATURATED_ALERT_KEY);
  }

  #rejectsLastHour(): number {
    return this.#rejectEvents.reduce((sum, event) => sum + event.count, 0);
  }

  status(): FleetAlertsStatus {
    return {
      acting: this.#acting,
      leaseExpiredLastHour: this.#expiries.size,
      fenceRejectsLastHour: this.#rejectsLastHour(),
      fenceRejectsTotal: this.#rejectsTotal,
      queueOldestDueMs: this.#queueOldestDueMs,
      schedulerTickAgeMs: this.#tickAgeMs,
      pg: this.#pool === null ? null : { ...this.#pool, saturatedStreak: this.#saturatedStreak },
      firing: [...this.#firing].sort(),
    };
  }
}
