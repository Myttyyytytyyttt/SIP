// The receiver's and the fleet page's statements against Postgres (Q4, Q5),
// over the dispatcher's tables: keeper_link, vault_work, send_intent, worker and
// fleet, plus the loss_carry table L2 already ships and the migration's
// legacy_process, read for the legacy keepers' receipts.
//
// THE TABLES ARE NOT THIS FILE'S. The store track (Q1) owns them, in
// sql/sip_solana.sql with the four lease statements (src/dispatch-store.ts),
// additive and idempotent like the rest of that file. This file only rings
// bells, asks for and takes a full pass, and reads the fleet; the columns it
// names are FLEET_COLUMNS, and missingFleetColumns lists which of them a
// database lacks — for the scheduler's boot check (Q2) to refuse by name,
// rather than lose its first bell to a refused write. test/fleet-pg.test.ts runs
// every statement here on Postgres 16 over the schema file alone, Q1's CHECKs
// included: a drift between the two is a failing test, not a refused write in
// production.
//
// EVERY TIME IS clock_timestamp(), read once per statement (the `t` CTE): the
// database's wall clock, the one the lease statements compare against (ADR
// §3.5). Never now(), which is the transaction's start, and never this process's
// clock, which is wrong on some replica eventually.
//
// NO CLIENT IS HELD ACROSS AN AWAIT. Each statement is one round trip on the
// pool, its row locks gone at its own commit: the receiver, the page and the
// tick share the scheduler's ONE pooled connection (SCHEDULER_POOL_MAX in
// src/dispatch-store.ts, from ADR §3.11's 3 + 2r), and a client held between
// statements is one the other two cannot use.

import type pg from "pg";
import { ECHO_DEADLINE_MS } from "./doorbell.js";
import { FULL_PASS_REASON_MAX_CHARS, type BellBatch, type BellWrite, type FleetBellStore } from "./fleet-receiver.js";
import {
  JOB_CEILING_MS,
  PARKED_LISTED,
  VAULTS_LISTED,
  VAULT_DETAIL_CHARS,
  VAULT_DETAIL_READ_CHARS,
  VAULT_DETAIL_WITHHELD,
  WORKER_DEAD_AFTER_MS,
  type FleetLegacy,
  type FleetQueue,
  type FleetSchedulerRow,
  type FleetSends,
  type FleetSnapshot,
  type FleetStatusSource,
  type FleetUnserved,
  type FleetVaultRow,
  type FleetWorkerRow,
  type LaneLag,
  type LeaseExpiry,
  type LegacyRoleReads,
  type UnservedVault,
  type VaultStreaks,
  type WorkerStats,
} from "./fleet-status.js";
import { LEGACY_READ_FRESH_MS } from "./handover.js";
import { scrubbedForExport } from "./keeper-log.js";
import { READ_MODEL_SCHEMA } from "./read-model.js";

/** What this file needs of a pool: one statement at a time. pg.Pool is one. */
export type FleetDb = Pick<pg.Pool, "query">;

const S = READ_MODEL_SCHEMA;

/**
 * Every column a statement below names, by table. A database missing one of
 * them refuses that statement whole; missingFleetColumns lists them first.
 */
export const FLEET_COLUMNS = {
  keeper_link: ["link_addr", "wallet_addr", "vault_addr", "gone_at"],
  vault_work: [
    "vault_addr",
    "system",
    "skim_mode",
    "lane",
    "priority",
    "due_at",
    "rests",
    "bell_at",
    "holder",
    "fence",
    "lease_until",
    "claimed_at",
    "attempts",
    "last_outcome",
    "last_detail",
    "last_done_at",
    "streaks",
    "parked_reason",
    "system_at",
  ],
  send_intent: ["id", "kind", "state", "signature", "created_at", "resolved_at", "echoed_at"],
  worker: ["worker_id", "kind", "version", "started_at", "heartbeat_at", "slots", "busy", "rps_quota", "jup_quota", "quota_at", "stopped_at", "stats"],
  fleet: ["id", "scheduler_id", "tick_at", "full_pass_reason", "board_dirty_at", "discovery_ok_at", "new_vault_system"],
  loss_carry: ["link_addr"],
  legacy_process: ["read_at", "gone_at", "role", "live"],
} as const satisfies Record<string, readonly string[]>;

/**
 * THE BELL (ADR §3.10, [QUEUE] §2.9). One statement: the addresses become vaults
 * through `keeper_link` — a wallet or a vault of a link that is not gone — and
 * those vaults' rows are rung; the signatures' intents are marked echoed.
 *
 *   * bell_at = now: COMPLETE compares it with claimed_at, so a bell that rings
 *     while a worker holds the vault makes it due the moment that job ends
 *     ([QUEUE] §2.4 COMPLETE) — a held row is rung like any other.
 *   * lane 'bell', priority 0: first in CLAIM's ORDER BY.
 *   * rests = false: a resting vault was resting on "nothing has moved", and a
 *     bell is something moving. [QUEUE] §2.9's statement sets it; ADR §3.10's
 *     summary does not list it, and the statement is the one followed here.
 *   * due_at = LEAST(due_at, now + bell delay): never later than it already was.
 *
 * WHATEVER THE VAULT'S `system`. A bell on a `legacy` row changes nothing anyone
 * reads — CLAIM takes only `queue` rows — and keeps the evidence for the day the
 * row is handed over: a vault draining toward the queue arrives with its bell.
 */
export const RING_SQL = `WITH t AS (SELECT clock_timestamp() AS now),
rung AS (
  SELECT DISTINCT l.vault_addr FROM ${S}.keeper_link l
   WHERE l.gone_at IS NULL AND (l.wallet_addr = ANY($1::text[]) OR l.vault_addr = ANY($1::text[]))
),
belled AS (
  UPDATE ${S}.vault_work w
     SET bell_at = t.now, lane = 'bell', priority = 0, rests = false,
         due_at = LEAST(w.due_at, t.now + make_interval(secs => $3::double precision))
    FROM rung, t
   WHERE w.vault_addr = rung.vault_addr
  RETURNING w.vault_addr
),
echoed AS (
  UPDATE ${S}.send_intent s SET echoed_at = t.now
    FROM t
   WHERE s.signature = ANY($2::text[]) AND s.echoed_at IS NULL
  RETURNING s.id
)
SELECT (SELECT count(*) FROM belled)::int AS vaults, (SELECT count(*) FROM echoed)::int AS echoes`;

/**
 * A FULL PASS REQUESTED (ADR §3.10): the shared version of Doorbell.lost. The
 * one `fleet` row is created if no scheduler has written it yet. A request
 * already pending is KEPT — its reason is the first cause, and one full pass
 * answers every request made before it is taken.
 */
export const REQUEST_FULL_PASS_SQL = `INSERT INTO ${S}.fleet (id, full_pass_reason) VALUES (true, $1)
ON CONFLICT (id) DO UPDATE SET full_pass_reason = COALESCE(${S}.fleet.full_pass_reason, EXCLUDED.full_pass_reason)`;

/**
 * A FULL PASS TAKEN, by the acting scheduler at the start of its tick (Q2),
 * BEFORE the pass begins. Returns the pending reason and clears it in one
 * statement, or returns nothing when none is pending.
 *
 * TAKEN BEFORE THE PASS, NEVER AFTER IT. A request written before the take is
 * answered by the pass the take starts, which reads everything after it; a
 * receiver's upsert that arrives during the take waits on the row's lock and
 * writes into the cleared row, so its request is the next tick's. Clearing at
 * the END of a pass instead would erase a request made during it, about a vault
 * the pass may already have read (test/fleet-pg.test.ts runs the interleaving).
 * The statement only ever clears a reason it returns, so a take that finds
 * nothing erases nothing.
 *
 * THE LOCK IN THE CTE IS FOR A SPLIT BRAIN (ADR §4.9 row 16). Two schedulers
 * taking at the same moment: unlocked, the second reads the reason from a
 * snapshot taken before the first committed, clears the already-cleared row and
 * returns the same reason, and the same full pass runs twice — harmless, as
 * every scheduler write is a hint, but at N = 10,000 a full pass is ≈ 405
 * batched reads ([QUEUE] §2.7). Locked, the second waits for the first's commit
 * and finds nothing.
 */
export const TAKE_FULL_PASS_SQL = `WITH old AS (SELECT full_pass_reason FROM ${S}.fleet WHERE id FOR UPDATE)
UPDATE ${S}.fleet f SET full_pass_reason = NULL
  FROM old
 WHERE f.id AND old.full_pass_reason IS NOT NULL
RETURNING old.full_pass_reason AS reason`;

/**
 * THE FLEET IN ONE STATEMENT, so every part of the page is from the same
 * snapshot of the tables and costs one round trip. Each block scans vault_work
 * at most twice — a count, and a capped list where it lists (parked, vaults,
 * unserved) — and the workers' lease counts are one grouped scan joined in, not
 * a scan per worker; so at N = 10,000 a read is about a dozen passes over ten
 * thousand rows every FLEET_STATUS_REFRESH_MS. $1 the job ceiling and $3
 * the echo deadline, in seconds; $2 how many parked vaults are listed; $4 how
 * many vault rows (and unserved rows) are listed one by one, $5 how many
 * characters of each last_detail are read (VAULT_DETAIL_READ_CHARS).
 *
 * `vaults` is every vault_work row, the unserved ones first, then by address,
 * capped at $4 and counted whole (`total`): the page's per-user table
 * (VAULTS_LISTED). last_detail is read up to $5 characters — more than any
 * writer stores — and cut to VAULT_DETAIL_CHARS only AFTER the scrub
 * (vaultDetailOf): cut first, a secret straddling the cut would reach the
 * redactor in pieces it cannot recognise.
 *
 * `unserved` is what `vault-unserved` reads: the rows nobody acts on — draining
 * (the legacy keepers leave it, CLAIM takes only 'queue'), or parked on the
 * queue — and, for a draining one, for how long.
 *
 * `legacy` is what `legacy-orphaned` reads (FleetLegacy): the 'legacy' rows a
 * live link still names — a vault whose links are all gone has nobody to serve
 * — where fleet.new_vault_system sends a new vault, and the legacy keepers'
 * receipts: those not marked gone, those of them read within
 * LEGACY_READ_FRESH_MS (the complement of `dispatch-handover gone --stale`), and
 * the newest read of any; and the same per role, counting only the receipts that
 * read while acting (`live`) — the rule decides by role, since the volume keeper
 * reading says nothing of whether anybody buys (src/fleet-alerts.ts). One more
 * count over vault_work, each 'legacy' row checked against keeper_link (indexed
 * by vault for its live links); legacy_process holds one row per legacy
 * container, so its two scans are a handful of rows.
 *
 * HOW LONG A VAULT HAS BEEN DRAINING, WITHOUT A NEW COLUMN. A handover writes
 * system_at whenever it changes `system` (DRAIN_SQL, ROLLBACK_SQL, arm's move,
 * release: src/handover.ts), so a row it drained is measured from system_at.
 * The scheduler's enrolment under new_vault_system = 'queue'
 * (ENSURE_VAULTS_SQL, src/scheduler-pg.ts) inserts the row as 'draining' with
 * no system_at; its time is due_at, which that INSERT sets to clock_timestamp()
 * and which nothing moves later on a row outside the queue:
 *   * MARK_DUE_SQL, SCHEDULER_COMPLETE_SQL and RETIRE_UNLINKED_SQL touch only
 *     system = 'queue';
 *   * COMPLETE (src/dispatch-store.ts) needs the row's holder and fence, and
 *     CLAIM, the only writer of a holder, takes only 'queue';
 *   * RING_SQL (above) sets due_at = LEAST(due_at, now + the bell delay), which
 *     is never earlier than an insert made before that now.
 * So for such a row, due_at IS the enrolment, and draining-since =
 * coalesce(system_at, due_at). A row put into 'draining' by a hand edit that
 * skips system_at is measured from its due_at too, which then says nothing
 * about when it was drained — the handover's commands are the way to drain. A
 * time that is not finite is not measured (a timestamp minus infinity is an
 * error in Postgres 16, and would cost the whole page), and a time in the
 * future reads as 0.
 *
 * The `lanes` block counts exactly the rows CLAIM could take now (ADR §3.5):
 * on the queue, not parked, due, free or with a lapsed lease. `expiries` is the
 * evidence `lease-expired` counts: held rows whose lease lapsed, and held rows
 * whose attempts say earlier claims never completed.
 *
 * send_intent is read only for the last hour and the open intents: at
 * N = 1,000 the table holds ≈ 14k rows a day for 35 days ([QUEUE] §2.3), and
 * the schema's two indexes for exactly these (send_intent_open, partial on
 * resolved_at IS NULL, and send_intent_created) keep the older ones unread.
 *
 * OPEN IS resolved_at IS NULL, NOT state = 'intent'. Under
 * SIP_SOLANA_DISPATCH=shadow every intent is written as 'shadow' and stays so
 * when it is resolved (Q1, plan design detail 1); only resolved_at tells an open
 * one. Under `on` the two agree (the schema's send_intent_open_is_unresolved).
 */
export const FLEET_SNAPSHOT_SQL = `WITH t AS (SELECT clock_timestamp() AS now)
SELECT json_build_object(
  'now', t.now,
  'fleet', (SELECT json_build_object(
              'schedulerId', f.scheduler_id,
              'tickAt', f.tick_at,
              'tickAgeMs', round(extract(epoch FROM t.now - f.tick_at) * 1000),
              'fullPassReason', f.full_pass_reason,
              'boardDirtyAt', f.board_dirty_at,
              'discoveryOkAt', f.discovery_ok_at,
              'discoveryAgeMs', round(extract(epoch FROM t.now - f.discovery_ok_at) * 1000))
              FROM ${S}.fleet f WHERE f.id),
  'workers', (SELECT coalesce(json_agg(json_build_object(
                'workerId', w.worker_id, 'kind', w.kind, 'version', w.version,
                'startedAt', w.started_at,
                'heartbeatAgeMs', round(extract(epoch FROM t.now - w.heartbeat_at) * 1000),
                'stoppedAt', w.stopped_at, 'slots', w.slots, 'busy', w.busy,
                'rpsQuota', w.rps_quota, 'jupQuota', w.jup_quota,
                'quotaAgeMs', round(extract(epoch FROM t.now - w.quota_at) * 1000), 'stats', w.stats,
                'leases', coalesce(h.leases, 0))
                ORDER BY w.kind, w.started_at, w.worker_id), '[]'::json)
               FROM (SELECT * FROM ${S}.worker x
                      WHERE x.stopped_at IS NULL OR x.stopped_at > t.now - interval '1 hour'
                      ORDER BY x.heartbeat_at DESC LIMIT 200) w
               LEFT JOIN (SELECT v.holder, count(*) AS leases FROM ${S}.vault_work v
                           WHERE v.holder IS NOT NULL AND v.lease_until >= t.now GROUP BY v.holder) h
                 ON h.holder = w.worker_id),
  'bySystem', (SELECT coalesce(json_object_agg(s.system, s.n), '{}'::json)
                 FROM (SELECT system, count(*) AS n FROM ${S}.vault_work GROUP BY system) s),
  'lanes', (SELECT coalesce(json_object_agg(d.lane, json_build_object('due', d.due, 'waitP50Ms', d.p50, 'waitP90Ms', d.p90, 'waitMaxMs', d.max)), '{}'::json)
              FROM (SELECT c.lane, count(*) AS due,
                           round(percentile_cont(0.5) WITHIN GROUP (ORDER BY c.wait_ms)) AS p50,
                           round(percentile_cont(0.9) WITHIN GROUP (ORDER BY c.wait_ms)) AS p90,
                           round(max(c.wait_ms)) AS max
                      FROM (SELECT v.lane, extract(epoch FROM t.now - v.due_at) * 1000 AS wait_ms
                              FROM ${S}.vault_work v
                             WHERE v.system = 'queue' AND v.parked_reason IS NULL AND v.due_at <= t.now
                               AND (v.holder IS NULL OR v.lease_until < t.now)) c
                     GROUP BY c.lane) d),
  'leases', (SELECT json_build_object(
               'held', count(*) FILTER (WHERE v.lease_until >= t.now),
               'expired', count(*) FILTER (WHERE v.lease_until IS NULL OR v.lease_until < t.now),
               'overCeiling', count(*) FILTER (WHERE v.claimed_at < t.now - make_interval(secs => $1::double precision)),
               'takeovers', count(*) FILTER (WHERE v.attempts >= 2),
               'claimLagP50Ms', round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM v.claimed_at - v.due_at) * 1000)),
               'claimLagP90Ms', round(percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM v.claimed_at - v.due_at) * 1000)))
               FROM ${S}.vault_work v WHERE v.holder IS NOT NULL),
  'parked', (SELECT json_build_object('count', count(*), 'vaults', coalesce(
                (SELECT json_agg(json_build_object('vault', p.vault_addr, 'reason', p.parked_reason, 'attempts', p.attempts, 'system', p.system) ORDER BY p.vault_addr)
                   FROM (SELECT vault_addr, parked_reason, attempts, system FROM ${S}.vault_work
                          WHERE parked_reason IS NOT NULL ORDER BY vault_addr LIMIT $2) p), '[]'::json))
               FROM ${S}.vault_work WHERE parked_reason IS NOT NULL),
  'outcomes', (SELECT coalesce(json_object_agg(o.outcome, o.n), '{}'::json)
                 FROM (SELECT coalesce(last_outcome, 'none') AS outcome, count(*) AS n
                         FROM ${S}.vault_work WHERE system = 'queue' GROUP BY 1) o),
  'expiries', (SELECT coalesce(json_agg(json_build_object('vault', e.vault_addr, 'fence', e.fence, 'attempts', e.attempts, 'lapsed', e.lapsed) ORDER BY e.vault_addr), '[]'::json)
                 FROM (SELECT vault_addr, fence, attempts, (lease_until IS NULL OR lease_until < t.now) AS lapsed
                         FROM ${S}.vault_work
                        WHERE holder IS NOT NULL AND (lease_until IS NULL OR lease_until < t.now OR attempts >= 2)
                        ORDER BY vault_addr LIMIT 1000) e),
  'sends', (SELECT json_build_object(
              'open', count(*) FILTER (WHERE s.resolved_at IS NULL),
              'oldestOpenAgeMs', round(max(extract(epoch FROM t.now - s.created_at) * 1000) FILTER (WHERE s.resolved_at IS NULL)),
              'unechoed', count(*) FILTER (WHERE s.state = 'landed' AND s.echoed_at IS NULL AND s.created_at > t.now - interval '1 hour'
                                             AND s.resolved_at < t.now - make_interval(secs => $3::double precision)))
              FROM ${S}.send_intent s WHERE s.resolved_at IS NULL OR s.created_at > t.now - interval '1 hour'),
  'lastHour', (SELECT coalesce(json_agg(json_build_object('kind', h.kind, 'state', h.state, 'count', h.n) ORDER BY h.kind, h.state), '[]'::json)
                 FROM (SELECT kind, state, count(*) AS n FROM ${S}.send_intent
                        WHERE created_at > t.now - interval '1 hour' GROUP BY kind, state) h),
  'carries', (SELECT count(*) FROM ${S}.loss_carry),
  'vaults', (SELECT json_build_object(
               'total', (SELECT count(*) FROM ${S}.vault_work),
               'rows', coalesce(json_agg(json_build_object(
                  'vault', r.vault_addr, 'system', r.system, 'skimMode', r.skim_mode, 'lane', r.lane,
                  'lastOutcome', r.last_outcome, 'lastDetail', left(r.last_detail, $5::int), 'lastDoneAt', r.last_done_at,
                  'dueAt', r.due_at, 'parkedReason', r.parked_reason, 'attempts', r.attempts, 'streaks', r.streaks)
                  ORDER BY r.unserved DESC, r.vault_addr), '[]'::json))
               FROM (SELECT v.vault_addr, v.system, v.skim_mode, v.lane, v.last_outcome, v.last_detail, v.last_done_at,
                            v.due_at, v.parked_reason, v.attempts, v.streaks,
                            (v.system = 'draining' OR (v.system = 'queue' AND v.parked_reason IS NOT NULL)) AS unserved
                       FROM ${S}.vault_work v
                      ORDER BY unserved DESC, v.vault_addr LIMIT $4) r),
  'unserved', (SELECT json_build_object(
                 'draining', count(*) FILTER (WHERE u.system = 'draining'),
                 'parked', count(*) FILTER (WHERE u.system = 'queue' AND u.parked_reason IS NOT NULL),
                 'vaults', coalesce((SELECT json_agg(json_build_object(
                                       'vault', x.vault_addr, 'system', x.system, 'forMs', x.for_ms, 'from', x.since,
                                       'parkedReason', x.parked_reason) ORDER BY x.draining DESC, x.for_ms DESC NULLS LAST, x.vault_addr)
                                       FROM (SELECT y.vault_addr, y.system, y.parked_reason, y.system = 'draining' AS draining,
                                                    CASE WHEN y.system = 'draining' AND isfinite(coalesce(y.system_at, y.due_at))
                                                         THEN round(greatest(0, extract(epoch FROM t.now - coalesce(y.system_at, y.due_at)) * 1000)) END AS for_ms,
                                                    CASE WHEN y.system <> 'draining' THEN NULL WHEN y.system_at IS NOT NULL THEN 'system_at' ELSE 'due_at' END AS since
                                               FROM ${S}.vault_work y
                                              WHERE y.system = 'draining' OR (y.system = 'queue' AND y.parked_reason IS NOT NULL)
                                              ORDER BY draining DESC, for_ms DESC NULLS LAST, y.vault_addr LIMIT $4) x), '[]'::json))
                 FROM ${S}.vault_work u WHERE u.system = 'draining' OR (u.system = 'queue' AND u.parked_reason IS NOT NULL)),
  'legacy', (SELECT json_build_object(
               'vaults', (SELECT count(*) FROM ${S}.vault_work v
                           WHERE v.system = 'legacy'
                             AND EXISTS (SELECT 1 FROM ${S}.keeper_link l WHERE l.vault_addr = v.vault_addr AND l.gone_at IS NULL)),
               'newVaultSystem', (SELECT f.new_vault_system FROM ${S}.fleet f WHERE f.id),
               'receipts', count(*) FILTER (WHERE p.gone_at IS NULL),
               'fresh', count(*) FILTER (WHERE p.gone_at IS NULL AND p.read_at >= t.now - interval '${LEGACY_READ_FRESH_MS / 1000} seconds'),
               'lastReadAgeMs', round(extract(epoch FROM t.now - max(p.read_at)) * 1000),
               'roles', (SELECT coalesce(json_object_agg(r.role, json_build_object('acting', r.acting, 'lastReadAgeMs', r.age_ms)), '{}'::json)
                           FROM (SELECT q.role,
                                        count(*) FILTER (WHERE q.gone_at IS NULL AND q.live
                                                           AND q.read_at >= t.now - interval '${LEGACY_READ_FRESH_MS / 1000} seconds') AS acting,
                                        round(extract(epoch FROM t.now - max(q.read_at)) * 1000) AS age_ms
                                   FROM ${S}.legacy_process q GROUP BY q.role) r))
               FROM ${S}.legacy_process p)
) AS snapshot
FROM t`;

/** The most earlier claims one row's attempts are read back for: a vault is parked after 5 lapses (ADR §3.8). */
const MAX_ATTEMPTS_READ = 5;

// ── parsing what Postgres returned ───────────────────────────────────────────

type Json = Record<string, unknown>;
const obj = (value: unknown): Json => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {});
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
/** A number as json_build_object writes count(*), round() and real: a JSON number, or numeric text. */
const num = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
};
const count = (value: unknown): number => num(value) ?? 0;

function workerStats(value: unknown): WorkerStats {
  const stats = obj(value);
  return {
    fenceRejects: num(stats["fenceRejects"]),
    fenceRejectsLastHour: num(stats["fenceRejectsLastHour"]),
    leaseLosses: num(stats["leaseLosses"]),
    jobsLast10Min: num(stats["jobsLast10Min"]),
    releasedOnSigterm: num(stats["releasedOnSigterm"]),
  };
}

function workerRow(value: unknown): FleetWorkerRow | null {
  const row = obj(value);
  const workerId = str(row["workerId"]);
  if (workerId === null) return null;
  const heartbeatAgeMs = num(row["heartbeatAgeMs"]);
  const stoppedAt = str(row["stoppedAt"]);
  return {
    workerId,
    kind: str(row["kind"]) ?? "unknown",
    version: str(row["version"]) ?? "unknown",
    startedAt: str(row["startedAt"]),
    heartbeatAgeMs,
    dead: stoppedAt === null && heartbeatAgeMs !== null && heartbeatAgeMs > WORKER_DEAD_AFTER_MS,
    stoppedAt,
    slots: count(row["slots"]),
    busy: count(row["busy"]),
    leases: count(row["leases"]),
    rpsQuota: num(row["rpsQuota"]),
    jupQuota: num(row["jupQuota"]),
    quotaAgeMs: num(row["quotaAgeMs"]),
    stats: workerStats(row["stats"]),
  };
}

function schedulerRow(value: unknown): FleetSchedulerRow | null {
  if (typeof value !== "object" || value === null) return null;
  const row = obj(value);
  return {
    schedulerId: str(row["schedulerId"]),
    tickAt: str(row["tickAt"]),
    tickAgeMs: num(row["tickAgeMs"]),
    fullPassReason: str(row["fullPassReason"]),
    boardDirtyAt: str(row["boardDirtyAt"]),
    discoveryOkAt: str(row["discoveryOkAt"]),
    discoveryAgeMs: num(row["discoveryAgeMs"]),
  };
}

/** A base58 account address: the only key a settle retry is served under. */
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** A whole number of zero or more, as worker-job's readStreaks counts: anything else is 0. */
const whole = (value: unknown): number => {
  const n = num(value);
  return n !== null && Number.isSafeInteger(n) && n >= 0 ? n : 0;
};

/** vault_work.streaks, read as VaultStreaks: the four keys and nothing else, and a count that is not one is 0. */
export function vaultStreaksOf(value: unknown): VaultStreaks {
  const raw = obj(value);
  const settleRetries: Record<string, number> = {};
  for (const [wallet, n] of Object.entries(obj(raw["settleRetries"]))) {
    const retries = whole(n);
    if (BASE58_ADDRESS.test(wallet) && retries > 0) settleRetries[wallet] = retries;
  }
  return { settleRetries, investFailed: whole(raw["investFailed"]), investRefused: whole(raw["investRefused"]), wrapShort: whole(raw["wrapShort"]) };
}

/**
 * A last_detail as served: the text as read (up to VAULT_DETAIL_READ_CHARS),
 * through this process's redactor and the byte-run net (scrubbedForExport),
 * THEN cut to VAULT_DETAIL_CHARS — or the fixed marker when it does not pass.
 * The order is the point: both nets recognise a secret only whole, so a cut made
 * before them could leave the first characters of a key in what is served.
 */
export function vaultDetailOf(value: unknown): string | null {
  const text = str(value);
  if (text === null) return null;
  const scrubbed = scrubbedForExport(text);
  return scrubbed === null ? VAULT_DETAIL_WITHHELD : scrubbed.slice(0, VAULT_DETAIL_CHARS);
}

function vaultRow(value: unknown): FleetVaultRow | null {
  const row = obj(value);
  const vault = str(row["vault"]);
  if (vault === null) return null;
  return {
    vault,
    system: str(row["system"]) ?? "unknown",
    skimMode: num(row["skimMode"]),
    lane: str(row["lane"]) ?? "unknown",
    lastOutcome: str(row["lastOutcome"]),
    lastDetail: vaultDetailOf(row["lastDetail"]),
    lastDoneAt: str(row["lastDoneAt"]),
    dueAt: str(row["dueAt"]),
    parkedReason: str(row["parkedReason"]),
    attempts: count(row["attempts"]),
    streaks: vaultStreaksOf(row["streaks"]),
  };
}

function unservedOf(value: unknown): FleetUnserved {
  const root = obj(value);
  return {
    draining: count(root["draining"]),
    parked: count(root["parked"]),
    vaults: arr(root["vaults"]).flatMap((entry): UnservedVault[] => {
      const row = obj(entry);
      const vault = str(row["vault"]);
      if (vault === null) return [];
      const from = row["from"] === "system_at" || row["from"] === "due_at" ? row["from"] : null;
      return [{ vault, system: str(row["system"]) ?? "unknown", forMs: num(row["forMs"]), from, parkedReason: str(row["parkedReason"]) }];
    }),
  };
}

/** The legacy block, or null when the statement returned none: an unread block is no evidence, never a fleet of zeros. */
function legacyOf(value: unknown): FleetLegacy | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = obj(value);
  return {
    vaults: count(row["vaults"]),
    newVaultSystem: str(row["newVaultSystem"]),
    receipts: count(row["receipts"]),
    fresh: count(row["fresh"]),
    lastReadAgeMs: num(row["lastReadAgeMs"]),
    roles: legacyRolesOf(row["roles"]),
  };
}

/** The per-role block, or null when the statement returned none: an absent role is one that never wrote a receipt. */
function legacyRolesOf(value: unknown): Record<string, LegacyRoleReads> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const out: Record<string, LegacyRoleReads> = {};
  for (const [role, reads] of Object.entries(obj(value))) {
    const row = obj(reads);
    out[role] = { acting: count(row["acting"]), lastReadAgeMs: num(row["lastReadAgeMs"]) };
  }
  return out;
}

function countsOf(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, n] of Object.entries(obj(value))) out[key] = count(n);
  return out;
}

/**
 * The lapsed leases a row shows. A held row whose lease ran out is one, at its
 * own fence; a held row claimed with attempts = k carries k − 1 earlier claims
 * that never completed (CLAIM adds one, COMPLETE resets to 0, a release on
 * SIGTERM completes), at the fences just below its own.
 */
export function expiriesOf(rows: readonly { vault: string; fence: number; attempts: number; lapsed: boolean }[]): LeaseExpiry[] {
  const out: LeaseExpiry[] = [];
  for (const row of rows) {
    if (row.lapsed) out.push({ vault: row.vault, fence: row.fence });
    const earlier = Math.min(Math.max(0, row.attempts - 1), MAX_ATTEMPTS_READ);
    for (let k = 1; k <= earlier && row.fence - k >= 1; k += 1) out.push({ vault: row.vault, fence: row.fence - k });
  }
  return out;
}

/** The statement's one json value, as the page and the alerts read it. Tolerant: a missing part is empty, never a throw. */
export function parseFleetSnapshot(raw: unknown): FleetSnapshot {
  const root = obj(raw);
  const lanes: Record<string, LaneLag> = {};
  let due = 0;
  let oldestDueMs: number | null = null;
  for (const [lane, value] of Object.entries(obj(root["lanes"]))) {
    const lag = obj(value);
    const entry: LaneLag = { due: count(lag["due"]), waitP50Ms: num(lag["waitP50Ms"]), waitP90Ms: num(lag["waitP90Ms"]), waitMaxMs: num(lag["waitMaxMs"]) };
    lanes[lane] = entry;
    due += entry.due;
    if (entry.waitMaxMs !== null && (oldestDueMs === null || entry.waitMaxMs > oldestDueMs)) oldestDueMs = entry.waitMaxMs;
  }
  const leases = obj(root["leases"]);
  const parked = obj(root["parked"]);
  const queue: FleetQueue = {
    bySystem: countsOf(root["bySystem"]),
    lanes,
    due,
    oldestDueMs,
    leases: {
      held: count(leases["held"]),
      expired: count(leases["expired"]),
      overCeiling: count(leases["overCeiling"]),
      takeovers: count(leases["takeovers"]),
      claimLagP50Ms: num(leases["claimLagP50Ms"]),
      claimLagP90Ms: num(leases["claimLagP90Ms"]),
    },
    parked: {
      count: count(parked["count"]),
      vaults: arr(parked["vaults"]).flatMap((value) => {
        const row = obj(value);
        const vault = str(row["vault"]);
        return vault === null ? [] : [{ vault, reason: str(row["reason"]) ?? "", attempts: count(row["attempts"]), system: str(row["system"]) }];
      }),
    },
    outcomes: countsOf(root["outcomes"]),
  };
  const sendsRow = obj(root["sends"]);
  const sends: FleetSends = {
    open: count(sendsRow["open"]),
    oldestOpenAgeMs: num(sendsRow["oldestOpenAgeMs"]),
    unechoed: count(sendsRow["unechoed"]),
    lastHour: arr(root["lastHour"]).flatMap((value) => {
      const row = obj(value);
      const kind = str(row["kind"]);
      const state = str(row["state"]);
      return kind === null || state === null ? [] : [{ kind, state, count: count(row["count"]) }];
    }),
  };
  const expiryRows = arr(root["expiries"]).flatMap((value) => {
    const row = obj(value);
    const vault = str(row["vault"]);
    const fence = num(row["fence"]);
    return vault === null || fence === null ? [] : [{ vault, fence, attempts: count(row["attempts"]), lapsed: row["lapsed"] === true }];
  });
  const vaultsBlock = obj(root["vaults"]);
  const vaults = arr(vaultsBlock["rows"]).flatMap((value) => {
    const row = vaultRow(value);
    return row === null ? [] : [row];
  });
  return {
    now: str(root["now"]) ?? "",
    scheduler: schedulerRow(root["fleet"]),
    workers: arr(root["workers"]).flatMap((value) => {
      const row = workerRow(value);
      return row === null ? [] : [row];
    }),
    queue,
    sends,
    carries: { pending: count(root["carries"]) },
    expiries: expiriesOf(expiryRows),
    vaults,
    vaultsTruncated: Math.max(0, count(vaultsBlock["total"]) - vaults.length),
    unserved: unservedOf(root["unserved"]),
    legacy: legacyOf(root["legacy"]),
  };
}

// ── the store ────────────────────────────────────────────────────────────────

/**
 * The fleet's Postgres side for the receiver and the page. One pool, injected:
 * the scheduler's own, createDispatchPool(…, "scheduler") (src/dispatch-store.ts),
 * so the receiver, the page and the tick share its one connection rather than
 * opening a pool each ([QUEUE] §2.12; ADR §3.11's 3 + 2r).
 */
export class PgFleetStore implements FleetBellStore, FleetStatusSource {
  readonly #db: FleetDb;

  constructor(db: FleetDb) {
    this.#db = db;
  }

  async ring(batch: BellBatch): Promise<BellWrite> {
    const result = await this.#db.query<{ vaults: number; echoes: number }>(RING_SQL, [
      [...batch.addresses],
      [...batch.signatures],
      batch.bellDelayMs / 1000,
    ]);
    const row = result.rows[0];
    return { vaults: Number(row?.vaults ?? 0), echoes: Number(row?.echoes ?? 0) };
  }

  async requestFullPass(reason: string): Promise<void> {
    await this.#db.query(REQUEST_FULL_PASS_SQL, [reason.slice(0, FULL_PASS_REASON_MAX_CHARS)]);
  }

  /** For the acting scheduler's tick (Q2): the pending reason, cleared, or null when none was asked. */
  async takeFullPass(): Promise<string | null> {
    const result = await this.#db.query<{ reason: string | null }>(TAKE_FULL_PASS_SQL);
    return result.rows[0]?.reason ?? null;
  }

  async read(): Promise<FleetSnapshot> {
    const result = await this.#db.query<{ snapshot: unknown }>(FLEET_SNAPSHOT_SQL, [
      JOB_CEILING_MS / 1000,
      PARKED_LISTED,
      ECHO_DEADLINE_MS / 1000,
      VAULTS_LISTED,
      VAULT_DETAIL_READ_CHARS,
    ]);
    return parseFleetSnapshot(result.rows[0]?.snapshot);
  }
}

/**
 * The `table.column` pairs of FLEET_COLUMNS this database does not have, for a
 * boot check: a dispatcher process whose tables drifted from these statements
 * says which column, by name, before its first bell is lost to a refused write.
 */
export async function missingFleetColumns(db: FleetDb): Promise<string[]> {
  const result = await db.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = ANY($2::text[])`,
    [READ_MODEL_SCHEMA, Object.keys(FLEET_COLUMNS)],
  );
  const have = new Set(result.rows.map((row) => `${row.table_name}.${row.column_name}`));
  const missing: string[] = [];
  for (const [table, columns] of Object.entries(FLEET_COLUMNS)) {
    for (const column of columns) if (!have.has(`${table}.${column}`)) missing.push(`${table}.${column}`);
  }
  return missing;
}
