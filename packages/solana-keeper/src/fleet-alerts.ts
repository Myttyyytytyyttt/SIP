// The dispatcher's five alerts (Q5): lease-expired, fence-reject, queue-lag,
// scheduler-stale and pg-saturated (dispatcher ADR §6.3 rows "leases (L4+)" and
// "Postgres (L4+)", §4.9 rows 1-7 and 15, §3.11 "Health"; plan §3.3.1 Q5) —
// and two the cut-over needs: vault-unserved, one key per vault, and
// legacy-orphaned, one for the fleet.
//
// THE ADR'S SEVERITIES AND NOTHING LOUDER. Only `critical` leaves the box
// (src/alerts.ts), so the severity IS the decision to wake somebody:
//
//   | key                    | warn                         | critical (pages)                       |
//   |------------------------|------------------------------|----------------------------------------|
//   | lease-expired          | 1-2 lapsed leases in an hour | ≥ 3 in an hour                         |
//   | fence-reject           | —                            | any, within the hour                   |
//   | queue-lag              | —                            | a due vault unclaimed > 2 windows      |
//   | scheduler-stale        | —                            | fleet.tick_at older than 10 minutes    |
//   | pg-saturated           | —                            | queries waiting for a connection on    |
//   |                        |                              | 3 ticks in a row                       |
//   | vault-unserved:<vault> | draining > 15 minutes        | draining > 60 minutes                  |
//   | legacy-orphaned        | a legacy vault (or new vaults| the same for 30 minutes                |
//   |                        | going legacy) with keepers   |                                        |
//   |                        | retired or 15 minutes silent |                                        |
//
// Where the ADR names only the page, there is no warn: a lower rung nobody
// asked for is a new behaviour, and on this branch a new behaviour is off until
// named (plan §2 rule 1). Each rule clears on the condition's end, so the next
// occurrence pages again; queue-lag clears only once the wait is back under ONE
// window, so a lag that hovers at the threshold pages once, not once a refresh.
//
// vault-unserved IS NOT THE ADR'S, it is the cut-over's (2026-10-27): once
// fleet.new_vault_system is 'queue' the scheduler enrols every new vault as
// 'draining' (ENSURE_VAULTS_SQL), the legacy keepers leave a draining vault
// alone, no worker claims one, and only `dispatch-handover arm` moves it on. A
// new user's vault then waits on an operator, and nothing said so. Its warn is
// a named rung: a handover carried through goes from drain to queue in about
// two minutes (rehearsed, test-local/shadow/handover-prod.mts), so a quarter of
// an hour is one that stalled — arm waiting on receipts from legacy keepers
// that are stopped, say — and an hour is a user with no settle and no buy. A
// PARKED queue row is unserved as well and is counted in
// the same view (fleet.unserved), but it already pages as vault-parked when the
// reap parks it (src/scheduler.ts), so nothing here pages it again.
//
// legacy-orphaned IS THE CUT-OVER'S TOO (2026-10-27), for its last step: the
// legacy keepers are stopped (not deleted) and SIP_SOLANA_LEGACY_ROLES=none says
// so on the scheduler. A vault still 'legacy' then is one the legacy keepers
// alone may act on (src/dispatch-select.ts) and no worker claims — and
// fleet.new_vault_system = 'legacy' hands every new user's vault to them too.
// Nothing else pages it: such a row is not draining, so vault-unserved never
// sees it, and the keepers that used to page about their own wallets are the
// ones that stopped. It fires when legacy vaults exist (or new vaults go there)
// AND either the operator has declared the keepers retired (`retired`, the
// variable) or none of them has read in LEGACY_READ_FRESH_MS (fleet.legacy:
// fresh 0 — they are down whatever the variable says). It warns at once and
// pages once it has lasted 30 minutes, timed from the last legacy read when
// they are silent (the database's clock: since then nobody has served those
// vaults), and from this process's first sight of it otherwise. Only the lock
// holder raises it, only under SIP_SOLANA_DISPATCH=on (bin/scheduler.mts hands
// the evaluator `legacy` there alone): a shadow scheduler's database is not the
// one users are served from, and has no legacy keeper writing receipts to it.
//
// scheduler-stale IS ALSO A WORKER'S (ADR §3.11). The scheduler's two replicas
// page it about each other; when both are gone, nobody would. So a worker reads
// fleet.tick_at on its own beat and applies the same rule through
// SchedulerStaleWatch below, titled "[worker] " by its alerter.
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
// fence-reject, queue-lag, vault-unserved, legacy-orphaned. scheduler-stale is evaluated by EVERY reader, the
// standby above all: a hung lock holder is exactly the process that will not
// page about itself (ADR §4.9 row 15), and the ADR has workers page it too
// (§3.11). pg-saturated is about this process's own pools, so each process
// pages its own.
//
// NONE OF THEM DECIDES ANYTHING. They read counters after the fact and change
// only who is woken.

import type { Alerter } from "./alerts.js";
import type { FleetLegacy, FleetSnapshot, PoolSample, UnservedVault } from "./fleet-status.js";
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
 * transaction (ADR §4.4), and every replica runs on two connections at most (a
 * worker's two; a scheduler's one beside its lock's, src/dispatch-store.ts): a
 * pool that stays full delays heartbeats toward the 45 s lease, and gates toward
 * their 10 s margin. One tick with a queue is a burst;
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

// --- vault-unserved ----------------------------------------------------------

/** The prefix of each vault's key: `vault-unserved:<vault>`. */
export const VAULT_UNSERVED_ALERT_PREFIX = "vault-unserved";
/** Draining longer than this warns: 15 minutes. */
export const VAULT_UNSERVED_WARN_MS = 15 * 60_000;
/** Draining longer than this pages: an hour. */
export const VAULT_UNSERVED_CRITICAL_MS = 60 * 60_000;

export const vaultUnservedKey = (vault: string): string => `${VAULT_UNSERVED_ALERT_PREFIX}:${vault}`;

/**
 * One draining vault, by how long it has drained (fleet.unserved, read by
 * FLEET_SNAPSHOT_SQL from system_at, or from due_at for a row the scheduler
 * enrolled). `forMs` null — not draining, or a time that could not be measured —
 * is no evidence and clears.
 *
 * WHAT TO DO IS IN THE DETAIL, because the person paged is the one who runs it:
 * `dispatch-handover arm` (twice, 150 blocks apart) moves it to the queue, and
 * stalls while a legacy role it requires has no fresh receipt — with the legacy
 * keepers stopped, every arm does; `release` gives it back to them.
 */
export function vaultUnservedAlert(input: { readonly vault: string; readonly forMs: number | null; readonly from: "system_at" | "due_at" | null }): AlertDecision {
  const { vault, forMs, from } = input;
  if (forMs === null || !(forMs > VAULT_UNSERVED_WARN_MS)) return cleared;
  const critical = forMs > VAULT_UNSERVED_CRITICAL_MS;
  const since = from === "due_at" ? "since the scheduler enrolled it (fleet.new_vault_system is 'queue')" : "since a handover drained it";
  return {
    fire: {
      key: vaultUnservedKey(vault),
      severity: critical ? "critical" : "warn",
      title: critical ? "A vault has had nobody settling or buying for it for over an hour" : "A vault is waiting between the legacy keepers and the queue",
      detail:
        `Vault ${vault} has been draining for ${minutes(forMs)} min, ${since}. The legacy keepers leave a draining vault alone and ` +
        "no worker claims one, so nothing is settled or bought for it. `dispatch-handover arm` moves it to the queue (twice, 150 " +
        "blocks apart); arm waits for a fresh receipt from every legacy role it requires, which stopped keepers never write. " +
        "`dispatch-handover release` gives it back to the legacy keepers instead. Read fleet.unserved on /status.",
      context: { vault, forMs, from },
    },
    clear: false,
  };
}

// --- legacy-orphaned ---------------------------------------------------------

export const LEGACY_ORPHANED_ALERT_KEY = "legacy-orphaned";
/**
 * How long a legacy keeper may go without reading before it counts as down: 15
 * minutes, handover.ts's LEGACY_READ_FRESH_MS, which fleet.legacy.fresh counts
 * by (src/fleet-pg.ts). Redeclared because a worker loads this file and must not
 * load the handover's (test/fleet-alerts.test.ts holds the two equal).
 */
export const LEGACY_SILENT_AFTER_MS = 15 * 60_000;
/** Orphaned this long, it pages: half an hour. */
export const LEGACY_ORPHANED_CRITICAL_MS = 30 * 60_000;

/**
 * The condition, without its clock: vaults the legacy keepers alone serve — a
 * 'legacy' row a live link names, or new vaults enrolled as 'legacy' — while
 * those keepers are retired (SIP_SOLANA_LEGACY_ROLES=none) or silent (no
 * receipt not marked gone has read within LEGACY_SILENT_AFTER_MS).
 */
export function legacyOrphaned(legacy: FleetLegacy, retired: boolean): boolean {
  const exposed = legacy.vaults > 0 || legacy.newVaultSystem === "legacy";
  return exposed && (retired || legacy.fresh === 0);
}

/**
 * How long the condition has lasted, or null when it does not hold: since the
 * last legacy read when the keepers are silent (nobody has served those vaults
 * since), and never less than `observedForMs`, what this evaluator has watched
 * — the only clock while keepers declared retired are still reading, or when
 * none ever read.
 */
export function legacyOrphanedForMs(input: { readonly legacy: FleetLegacy; readonly retired: boolean; readonly observedForMs: number }): number | null {
  const { legacy, retired } = input;
  if (!legacyOrphaned(legacy, retired)) return null;
  const silentForMs = legacy.fresh === 0 ? (legacy.lastReadAgeMs ?? 0) : 0;
  return Math.max(0, input.observedForMs, silentForMs);
}

/**
 * legacy-orphaned (the header): warn as soon as it holds, page from
 * LEGACY_ORPHANED_CRITICAL_MS, clear once it does not.
 *
 * WHAT TO DO IS IN THE DETAIL, in the owner's own commands: `flota-prod
 * traspasar-todos` moves every legacy vault to the queue, one after another, and
 * `flota-prod nuevos-a-la-cola` sends new vaults there (it refuses unless the
 * scheduler arms by itself, SIP_SOLANA_AUTO_ARM=on); or, if the legacy keepers
 * are meant to be up, they are restarted.
 */
export function legacyOrphanedAlert(input: { readonly legacy: FleetLegacy; readonly retired: boolean; readonly observedForMs: number }): AlertDecision {
  const forMs = legacyOrphanedForMs(input);
  if (forMs === null) return cleared;
  const { legacy, retired } = input;
  const critical = forMs >= LEGACY_ORPHANED_CRITICAL_MS;
  const n = legacy.vaults;
  const newGoLegacy = legacy.newVaultSystem === "legacy";
  const silent = legacy.fresh === 0;
  const left = [
    ...(n === 0
      ? []
      : [`${n} vault${n === 1 ? "" : "s"} with a live link ${n === 1 ? "is" : "are"} still 'legacy' (vault_work.system): no worker claims ${n === 1 ? "it" : "them"}`]),
    ...(newGoLegacy ? ["fleet.new_vault_system is 'legacy': every new user's vault is enrolled for the legacy keepers"] : []),
  ];
  const who = n === 0 ? "new users" : n === 1 && !newGoLegacy ? "that user" : "those users";
  // RETIRED BUT STILL READING IS A PAGE ABOUT WHAT COMES NEXT, not a claim that nobody serves them now.
  const consequence = silent
    ? `nobody settles or buys for ${who}`
    : `${legacy.fresh} legacy keeper${legacy.fresh === 1 ? " still reads" : "s still read"}, and once ${legacy.fresh === 1 ? "it stops" : "they stop"} nobody settles or buys for ${who}`;
  const lastRead = legacy.lastReadAgeMs === null ? "none ever has" : `the last read was ${minutes(legacy.lastReadAgeMs)} min ago`;
  const why =
    retired && silent
      ? `SIP_SOLANA_LEGACY_ROLES=none on this scheduler says the legacy keepers are retired, and none has read in ${LEGACY_SILENT_AFTER_MS / 60_000} min (${lastRead})`
      : retired
        ? "SIP_SOLANA_LEGACY_ROLES=none on this scheduler says the legacy keepers are retired"
        : `no legacy keeper has read in ${LEGACY_SILENT_AFTER_MS / 60_000} min (${lastRead}): stopped, crashing, or running without SIP_SOLANA_DISPATCH`;
  return {
    fire: {
      key: LEGACY_ORPHANED_ALERT_KEY,
      severity: critical ? "critical" : "warn",
      title: critical
        ? "For half an hour, vaults have been left to legacy keepers that are retired or silent"
        : "Vaults are still the legacy keepers', and those keepers are retired or silent",
      detail:
        `${left.join("; ")}. ${why}: ${consequence}. This has held for ${minutes(forMs)} min. ` +
        "To finish the move: `flota-prod traspasar-todos` moves every legacy vault to the queue, and " +
        "`flota-prod nuevos-a-la-cola` sends new vaults there (with SIP_SOLANA_AUTO_ARM=on on the scheduler). To keep the legacy keepers " +
        `instead: restart sip-solana-keeper and sip-solana-volume-keeper${retired ? " and unset SIP_SOLANA_LEGACY_ROLES" : ""}. Read fleet.legacy on /status.`,
      context: { legacyVaults: n, newVaultSystem: legacy.newVaultSystem, retired, fresh: legacy.fresh, lastReadAgeMs: legacy.lastReadAgeMs, forMs },
    },
    clear: false,
  };
}

// --- scheduler-stale, from a worker ------------------------------------------

/** What a worker's watch shows of the scheduler's tick. */
export interface SchedulerStaleWatchStatus {
  /** fleet.tick_at's age at the last read that answered, by the database's clock; null when that read found no tick. */
  readonly tickAgeMs: number | null;
  /** When that read was, on this process's clock; null before the first. */
  readonly readAt: string | null;
  readonly firing: boolean;
}

/**
 * scheduler-stale as a WORKER raises it (the ADR has workers page it too,
 * §3.11): schedulerStaleAlert, the scheduler replicas' own rule and threshold,
 * over the tick age the worker's beat reads with its quotas (WORKER_BEAT_SQL,
 * src/dispatch-store.ts) — no statement of its own.
 *
 * THE FAILURE IT IS FOR: both scheduler replicas gone (a crash loop, a bad
 * deploy, the service stopped). Then no replica's FleetAlerts runs, nothing
 * makes a vault due — workers drain what was due and idle — and each worker's
 * quota falls to its floor two minutes after the last hand-out; the only
 * dispatcher processes still up are workers, and without this none of them
 * would say so. While a replica lives it pages the same condition itself, so
 * then it pages from both sides, told apart by "[scheduler] " and "[worker] ".
 *
 * THE SAME TEN MINUTES as the replicas (SCHEDULER_STALE_AFTER_MS): the holder
 * writes tick_at once a tick (SIP_SOLANA_SWEEP_MS, 60 s by default) and exits on
 * its own after max(3 ticks, 10 min) without progress, so at the default a tick
 * older than ten minutes is past the point where a hung holder should have
 * exited and the standby taken the lock.
 *
 * ONLY A READ THAT ANSWERED IS EVIDENCE. A beat that failed, timed out or found
 * no row of its own is not handed here (observe is not called): a worker cut
 * off from Postgres knows nothing about the scheduler, and its leases' lapse is
 * already the scheduler's lease-expired. A tick that was never written is judged
 * by this process's uptime, as the rule says.
 */
export class SchedulerStaleWatch {
  readonly #alerter: Pick<Alerter, "fire" | "clear">;
  readonly #now: () => number;
  readonly #startedAt: number;
  #tickAgeMs: number | null = null;
  #readAt: number | null = null;
  #firing = false;

  constructor(options: { readonly alerter: Pick<Alerter, "fire" | "clear">; readonly now?: () => number }) {
    this.#alerter = options.alerter;
    this.#now = options.now ?? (() => Date.now());
    this.#startedAt = this.#now();
  }

  /** One answered read of fleet.tick_at's age (null: no tick was ever written). Returns what the rule decided. */
  observe(tickAgeMs: number | null): AlertDecision {
    const now = this.#now();
    const age = tickAgeMs !== null && Number.isFinite(tickAgeMs) ? tickAgeMs : null;
    this.#tickAgeMs = age;
    this.#readAt = now;
    const decision = schedulerStaleAlert({ tickAgeMs: age, upMs: now - this.#startedAt });
    if (decision.fire !== null) {
      this.#alerter.fire(decision.fire);
      this.#firing = true;
    } else if (decision.clear && this.#firing) {
      this.#alerter.clear(SCHEDULER_STALE_ALERT_KEY);
      this.#firing = false;
    }
    return decision;
  }

  status(): SchedulerStaleWatchStatus {
    return { tickAgeMs: this.#tickAgeMs, readAt: this.#readAt === null ? null : new Date(this.#readAt).toISOString(), firing: this.#firing };
  }
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
  /** The longest any vault has been draining (fleet.unserved), what `vault-unserved` reads; null when none is. */
  readonly unservedOldestMs: number | null;
  /** How long legacy-orphaned's condition has held (legacyOrphanedForMs); null when it does not, or when this process does not evaluate it. */
  readonly legacyOrphanedForMs: number | null;
  /** This process's pools at the last tick, summed, and how many ticks in a row had queries waiting. */
  readonly pg: { readonly waiting: number; readonly total: number; readonly idle: number; readonly saturatedStreak: number } | null;
  /** Keys this evaluator has raised and not cleared. */
  readonly firing: readonly string[];
}

export interface FleetAlertsOptions {
  readonly alerter: Pick<Alerter, "fire" | "clear">;
  /** One window: the scheduler's tick (SIP_SOLANA_SWEEP_MS, 60 s by default). */
  readonly windowMs: number;
  /**
   * legacy-orphaned's input from the scheduler's configuration: `retired` is
   * SIP_SOLANA_LEGACY_ROLES=none. Absent or null, the rule is not evaluated —
   * bin/scheduler.mts hands it only under SIP_SOLANA_DISPATCH=on.
   */
  readonly legacy?: { readonly retired: boolean } | null;
  readonly now?: () => number;
}

/**
 * Applies the rules to what a dispatcher process sees: each fleet snapshot
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
  /**
   * What each snapshot found a worker's counter had grown by, and when this
   * process saw it; `seeded` for what the first snapshot took from a worker's
   * own last hour (fenceRejectsLastHour), whose count that worker's later reports
   * can only lower.
   */
  #rejectEvents: { readonly at: number; readonly worker: string; count: number; readonly seeded: boolean }[] = [];
  #rejectsTotal = 0;
  #acting: boolean | null = null;
  #queueOldestDueMs: number | null = null;
  #tickAgeMs: number | null = null;
  #unservedOldestMs: number | null = null;
  /** The vaults this evaluator has raised `vault-unserved` for and not cleared. */
  readonly #unservedFiring = new Set<string>();
  readonly #legacy: { readonly retired: boolean } | null;
  /** When this process first saw legacy-orphaned's condition hold, unbroken since; null while it does not. */
  #legacyOrphanSince: number | null = null;
  #legacyOrphanedForMs: number | null = null;
  #pool: { waiting: number; total: number; idle: number } | null = null;
  #saturatedStreak = 0;

  constructor(options: FleetAlertsOptions) {
    this.#alerter = options.alerter;
    this.#windowMs = options.windowMs;
    this.#legacy = options.legacy ?? null;
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
   * only the acting replica raises the fleet's conditions.
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
    // A worker already there at this process's FIRST snapshot has its counter
    // since boot taken as a baseline — that number says how many, not when — but
    // NOT the rejects of its own last hour (fenceRejectsLastHour): the ADR pages
    // on any reject within the hour, and one a worker met between the old
    // scheduler's last read and this one's first (a scheduler redeploy, SIGKILLed
    // at RAILWAY_DEPLOYMENT_DRAINING_SECONDS 0) would otherwise page on no
    // replica at all. A reject still inside the hour may page again after a
    // scheduler restart; losing one is the worse error. A worker that APPEARS
    // later was registered after that first read, so all of its count is new.
    const first = this.#rejectsSeen === null;
    const seen = new Map<string, number>();
    let total = 0;
    for (const worker of snapshot.workers) {
      const count = worker.stats.fenceRejects ?? 0;
      total += count;
      seen.set(worker.workerId, count);
      if (first) {
        const lastHour = worker.stats.fenceRejectsLastHour ?? 0;
        if (lastHour > 0) this.#rejectEvents.push({ at: now, worker: worker.workerId, count: lastHour, seeded: true });
        continue;
      }
      const before = this.#rejectsSeen!.get(worker.workerId) ?? 0;
      if (count > before) this.#rejectEvents.push({ at: now, worker: worker.workerId, count: count - before, seeded: false });
      this.#trimSeeded(worker.workerId, worker.stats.fenceRejectsLastHour);
    }
    this.#rejectsSeen = seen;
    this.#rejectsTotal = total;
    this.#rejectEvents = this.#rejectEvents.filter((event) => event.count > 0 && now - event.at <= HOUR_MS);

    this.#queueOldestDueMs = snapshot.queue.oldestDueMs;
    this.#tickAgeMs = snapshot.scheduler?.tickAgeMs ?? null;
    const draining = snapshot.unserved.vaults.filter((row) => row.system === "draining");
    this.#unservedOldestMs = draining.reduce<number | null>((oldest, row) => (row.forMs !== null && (oldest === null || row.forMs > oldest) ? row.forMs : oldest), null);

    // LEGACY-ORPHANED'S CLOCK RUNS ON EVERY REPLICA, like the hour of leases. A
    // snapshot without the block is no evidence: the clock and the page stand.
    let legacyDecision: AlertDecision | null = null;
    if (this.#legacy !== null && snapshot.legacy !== null) {
      const holds = legacyOrphaned(snapshot.legacy, this.#legacy.retired);
      this.#legacyOrphanSince = holds ? (this.#legacyOrphanSince ?? now) : null;
      const input = { legacy: snapshot.legacy, retired: this.#legacy.retired, observedForMs: holds ? now - this.#legacyOrphanSince! : 0 };
      this.#legacyOrphanedForMs = legacyOrphanedForMs(input);
      legacyDecision = legacyOrphanedAlert(input);
    }

    if (input.acting) {
      this.#apply(leaseExpiredAlert({ expiredLastHour: this.#expiries.size, latest: this.#latestExpiry }), LEASE_EXPIRED_ALERT_KEY);
      const workers = [...new Set(this.#rejectEvents.map((event) => event.worker))];
      this.#apply(fenceRejectAlert({ rejectsLastHour: this.#rejectsLastHour(), workers }), FENCE_REJECT_ALERT_KEY);
      this.#apply(
        queueLagAlert({ oldestDueMs: snapshot.queue.oldestDueMs, due: snapshot.queue.due, windowMs: this.#windowMs }),
        QUEUE_LAG_ALERT_KEY,
      );
      this.#evaluateUnserved(draining, snapshot.unserved.draining);
      if (legacyDecision !== null) this.#apply(legacyDecision, LEGACY_ORPHANED_ALERT_KEY);
    } else {
      // A REPLICA THAT STOPPED ACTING HANDS ITS PAGES BACK: cleared here, so the
      // day it acts again they fire afresh, and meanwhile the holder pages them.
      for (const key of [LEASE_EXPIRED_ALERT_KEY, FENCE_REJECT_ALERT_KEY, QUEUE_LAG_ALERT_KEY]) this.#apply(cleared, key);
      for (const vault of [...this.#unservedFiring]) this.#clearUnserved(vault);
      if (this.#legacy !== null) this.#apply(cleared, LEGACY_ORPHANED_ALERT_KEY);
    }
    this.#apply(schedulerStaleAlert({ tickAgeMs: this.#tickAgeMs, upMs: now - this.#startedAt }), SCHEDULER_STALE_ALERT_KEY);
  }

  /**
   * vault-unserved, one key per draining vault the snapshot lists. A vault that
   * left 'draining' is cleared — but only when the list is whole: past the
   * page's cap (VAULTS_LISTED) a vault missing from it may still be draining,
   * and its page stands until a whole list says otherwise.
   */
  #evaluateUnserved(listed: readonly UnservedVault[], drainingTotal: number): void {
    const seen = new Set<string>();
    for (const row of listed) {
      seen.add(row.vault);
      const decision = vaultUnservedAlert({ vault: row.vault, forMs: row.forMs, from: row.from });
      if (decision.fire !== null) {
        this.#alerter.fire(decision.fire);
        this.#firing.add(decision.fire.key);
        this.#unservedFiring.add(row.vault);
      } else if (decision.clear && this.#unservedFiring.has(row.vault)) {
        this.#clearUnserved(row.vault);
      }
    }
    if (listed.length < drainingTotal) return;
    for (const vault of [...this.#unservedFiring]) if (!seen.has(vault)) this.#clearUnserved(vault);
  }

  #clearUnserved(vault: string): void {
    const key = vaultUnservedKey(vault);
    this.#alerter.clear(key);
    this.#firing.delete(key);
    this.#unservedFiring.delete(vault);
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

  /**
   * A seeded event is the worker's own last hour as the first snapshot read it,
   * timed by THIS process at that read; its rejects happened earlier and leave
   * the worker's hour earlier. So each later report of that hour lowers it: no
   * more than what the worker still counts, less what this process has seen it
   * grow by since. Gone once the worker's hour is.
   */
  #trimSeeded(worker: string, lastHour: number | null): void {
    if (lastHour === null) return;
    const seeded = this.#rejectEvents.find((event) => event.seeded && event.worker === worker);
    if (seeded === undefined) return;
    const grownSince = this.#rejectEvents.filter((event) => !event.seeded && event.worker === worker).reduce((sum, event) => sum + event.count, 0);
    seeded.count = Math.min(seeded.count, Math.max(0, lastHour - grownSince));
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
      unservedOldestMs: this.#unservedOldestMs,
      legacyOrphanedForMs: this.#legacyOrphanedForMs,
      pg: this.#pool === null ? null : { ...this.#pool, saturatedStreak: this.#saturatedStreak },
      firing: [...this.#firing].sort(),
    };
  }
}
