// The dispatcher's store: the seven tables at the end of sql/sip_solana.sql and
// the FOUR STATEMENTS every lease, fence and send goes through (dispatcher ADR
// §3.4–3.7, decision S-3; safety §2.2; plan P3a, Q1).
//
// DARK. Nothing a legacy keeper runs imports this file (test/dispatch-store.test.ts
// scans for it, and test/dispatch-dark.test.ts walks every bin/ entry point's
// imports for it and the other dispatcher modules): only the dispatcher's own
// entry points will, and with SIP_SOLANA_DISPATCH unset none of them runs. Its
// tables are additive; a legacy keeper neither reads nor writes them.
//
// THE FOUR STATEMENTS, as ADR §3.5 writes them:
//
//   CLAIM      up to `slots` due vaults of system 'queue' whose lease is free or
//              expired, FOR UPDATE SKIP LOCKED, fence + 1, a 45 s lease. Its
//              own last vaults get a head start of CLAIM_AFFINITY_SECONDS on
//              their due time, never precedence over an older vault past it.
//   HEARTBEAT  one statement per process for every vault it holds, every 10 s, on
//              a timer of its own; it renews only (holder, fence) pairs that are
//              still this process's, and refuses past the 6-minute job ceiling.
//              A vault missing from the answer: the job stops at its next step.
//   GATE       before EVERY send, one transaction: the vault row FOR SHARE, held
//              by this worker at this fence with more than 10 s of lease left by
//              clock_timestamp(); then the send_intent row, only if the job's
//              plan cleared every earlier fence's intents (the takeover's floor,
//              below); then, for a PROFIT settle, the carry write-ahead. The
//              bytes leave only once the COMMIT is acknowledged.
//   COMPLETE   the lease handed back with the job's outcome; RELEASE on SIGTERM is
//              the same statement, due at once. A holder that lost its lease
//              changes nothing.
//
// WHY clock_timestamp(), EVERYWHERE. Every lease comparison is the database's own
// wall clock at the moment the row is judged. Never now(), the start of the
// transaction: a gate that waited on the row lock behind a write would judge the
// lease at the instant it began waiting. And never a worker's clock: a worker ten
// minutes fast or slow claims, renews, gates and completes exactly as one with
// the right time (fence-pg proves it with a faked system time). For the same
// reason COMPLETE's next due time is a DELAY the database adds to its own clock,
// not a time the worker computed — the one place where ADR §3.5's `$10` would
// have let a worker's clock into the row.
//
// WHAT POSTGRES RE-JUDGES, AND WHAT IT DOES NOT (fence-pg pins both). A gate that
// waited for a WRITE to the row (a claim, a heartbeat, the scheduler's bell)
// judges the row's new version, with the clock read again. A gate that waited
// for a lock given back WITHOUT a write (a claim that gave up) goes on with the
// row as it first judged it: unchanged, still this worker's fence, and nobody
// could claim it meanwhile, because a claim needs that lock — only the margin was
// read up to one statement timeout early.
//
// WHY FOR SHARE (S-3). The queue section's gate assumed its own commit landed
// within the 10 s margin. A commit can stall where no statement_timeout reaches
// (Postgres disarms it before it commits), past the end of the lease. The row
// lock removes the assumption (PostgreSQL READ COMMITTED):
//   * gate first: a claim's FOR UPDATE SKIP LOCKED skips the row, and any other
//     write to it waits, until the gate has committed — so whoever takes the
//     vault next sees the intent, even one whose commit this side gave up on;
//   * a write first: the gate waits for it, then judges the row's NEW version, on
//     which the fence or holder is no longer this worker's, and refuses.
// The margin stays as defence in depth.
//
// THE ONE-STATEMENT FORM (gateOneStatement): the same lock and insert as one
// CTE, one round trip instead of four. ADR §3.5 accepts it only once
// test-local/fence-pg.local.test.ts has proved it on PostgreSQL 16, and that file
// runs every race the transaction form runs against it too. It cannot carry a
// carry write, so a PROFIT settle always takes the transaction.
//
// WHAT A GATE ANSWERS, and what each means for the signed bytes:
//   gated           the intent row is committed and acknowledged: send exactly
//                   those bytes;
//   refused         `lease`: the fence is no longer this worker's, or less than
//                   the margin is left; `plan-floor`: the job planned without
//                   clearing an earlier fence's intent (a bug upstream). Either
//                   way drop the bytes (never re-sign them with another
//                   blockhash, never log them serialized);
//   unavailable     the gate never got as far as COMMIT, or the server refused
//                   the commit on the request's own account (a constraint):
//                   nothing was committed; drop the bytes;
//   unacknowledged  COMMIT (or the one statement, which is its own commit) was
//                   sent and no answer came back, or one saying the SERVER is in
//                   trouble: it may have committed. Drop the bytes all the same;
//                   if the row exists, the next holder waits out its blockhash,
//                   which is the safe direction (ADR §4.9 row 4).
// Only `gated` sends. A client that failed inside a transaction is destroyed,
// never handed back to the pool with the transaction open.
//
// THE TAKEOVER'S FLOOR (priorIntents). Before a job plans, every earlier fence's
// intent must be over at a height its plan_cleared_height is ABOVE: the overlap
// audit's own right-hand side, COALESCE(resolved_height, last_valid_block_height),
// maximised over the vault (PLAN_FLOOR_SQL). resolved_height is the last height
// at which that transaction could act — where it landed or reverted; for one that
// expired, its last valid height. So a plan that waits for the finalized height
// to pass the floor can never be an audit row, and a send that landed a moment
// ago is waited out to finality (≈ 13 s) before the next fence plans over it. The
// worker that resolves, waits and plans is Q3's; this file gives it the two reads
// — AND REFUSES, IN BOTH GATE FORMS, an intent whose plan_cleared_height is not
// above that floor (NULL included, unless no earlier fence ever gated on the
// vault). The audit then proves an invariant the store itself holds, instead of
// being the first place a job that planned too early could be noticed.
//
// SHADOW (plan P3a design detail 1). A store built for the shadow world writes
// its intents with state 'shadow' and never writes a carry: under
// SIP_SOLANA_DISPATCH=shadow a worker gates exactly as `on` would and sends
// nothing, so the gate, the takeover and the overlap audit run on real
// scheduling. A carry is the post-state of a settle that lands, and a shadow
// settle never does. One database holds one world.
//
// CONNECTIONS (ADR §3.11, from the queue section's when.py; owner decision 32).
// Two per worker replica, its whole pool: the queue's statements and nothing
// else. The scheduler pools ONE, plus the advisory lock's pinned connection on
// the replica that holds it: holder 2 + standby 1 = 3. Steady 3 + 2r; a deploy's
// boot window doubles it; each legacy keeper still running adds its read model's
// 2, and a PROFIT keeper whose carry store is not off (SIP_SOLANA_CARRY_STORE =
// dual | on, which S-4 wants before the queue) 1 more for createCarryPool's own.
// dispatchConnections() is that arithmetic. AN ASSUMED SESSION POOL OF 15 FITS
// r ≤ 2 WITH A DEPLOY, AND NO r WHILE THE LEGACY KEEPERS SHADOW A PUSH.
//
// WHAT THE OTHER P3a TRACKS READ AND WRITE THROUGH IT (the merge's wiring):
//   * the quota hand-out (src/rpc-quota.ts): the scheduler's handOutQuotas
//     writes each live worker's share and `quota_at`, the database's time of the
//     write; a worker's beat (beatProcess, or quotaSource for QuotaFollower)
//     reads it back as an AGE on that one clock, so a worker whose own clock is
//     wrong still drops to its floor two minutes after the scheduler went quiet;
//   * worker.stats, the page's contract with the worker (src/fleet-status.ts
//     WORKER_STATS_KEYS): beatProcess writes those keys and no other;
//   * rpc_usage (src/credit-governor.ts): PgRpcUsageFeed is the RpcUsageFeed
//     every collector flushes into and the governor reads.
// The bell and the fleet page have their own statements over these tables
// (src/fleet-pg.ts), on the scheduler's pool from createDispatchPool.
//
// WHERE THIS FILE FOLLOWS THE CODE OVER THE ADR'S PROSE, said once:
//   * ADR §3.11 says "2 per replica plus 1 pinned on the lock-holding scheduler"
//     and then "steady 3 + 2r". With two scheduler replicas at 2 each that would
//     be 5 + 2r; the 3 + 2r its table and when.py compute is a scheduler pool of
//     ONE (holder 1 + 1 pinned, standby 1). The pools here are sized to the
//     table: SCHEDULER_POOL_MAX = 1, WORKER_POOL_MAX = 2.
//   * COMPLETE's `$10` is a delay in seconds (the clock paragraph above says why).
//   * CLAIM's affinity is bounded (CLAIM_AFFINITY_SECONDS): the ADR's
//     unbounded order starved a dead worker's vaults under a full-pass backlog.
//   * The overlap audit counts a NULL plan_cleared_height as -1 (OVERLAP_AUDIT_SQL
//     says why): the ADR's text compares it with `<=`, under which such a row
//     drops out of the audit instead of failing it.
//   * L2's loss_carry already existed with valid_until_slot and written_by; the
//     dispatcher's written_fence and send_intent_id are added beside them by an
//     ALTER, and a gated carry fills all four.

import pg from "pg";
import { summarizeUpstreamError, type Secret } from "@sip/solana-log";
import { CARRY_LOCK_CLASS, type CarryLink } from "./carry-store.js";
import { HELIUS_USAGE_PROVIDERS, type HeliusUsageSummary, type RpcUsageFeed, type RpcUsageRow, type UsageClass, type UsageProvider } from "./credit-governor.js";
import { WORKER_DEAD_AFTER_MS, WORKER_STATS_KEYS } from "./fleet-status.js";
import { READ_MODEL_SCHEMA, databaseAnswered, sslFor } from "./read-model.js";
import type { RpcLane } from "./rpc-budget.js";
import { fleetQuotas, type FleetQuotaInput, type FleetQuotas, type WorkerQuotaRow, type WorkerQuotaSource } from "./rpc-quota.js";
import type { LossCarry } from "./settle-decision.js";

/** The dispatcher's seven tables, in sql/sip_solana.sql's order (ADR §3.4). */
export const DISPATCH_TABLES = ["keeper_link", "vault_work", "send_intent", "loss_carry", "worker", "rpc_usage", "fleet"] as const;

/**
 * The three that are NOT derived and can NEVER be rebuilt; the schema file's
 * header says so, and why. Dropping loss_carry over-charges, send_intent stops a
 * successor from waiting for a transaction that can still land, vault_work hands
 * the fences out again from 0.
 */
export const NOT_REBUILDABLE_TABLES = ["loss_carry", "send_intent", "vault_work"] as const;

/** A lease: 45 s (ADR §3.7). Three missed heartbeats plus one statement timeout fit inside it. */
export const LEASE_SECONDS = 45;
/** The heartbeat, on a timer independent of whatever the job is awaiting. */
export const HEARTBEAT_EVERY_MS = 10_000;
/** What a gate requires to be left on the lease. Correctness comes from the row lock; this is depth. */
export const GATE_MARGIN_SECONDS = 10;
/** The job ceiling: the heartbeat renews no lease claimed longer ago than this. */
export const JOB_CEILING_MINUTES = 6;
/**
 * Every statement's bound, server-side and client-side, and how long a statement
 * waits for a pooled connection: 5 s, the read model's, which the lease
 * arithmetic counts once (3 × 10 s + 5 s = 35 s < 45 s).
 */
export const DISPATCH_STATEMENT_TIMEOUT_MS = 5_000;

/** A worker replica's whole pool (ADR §3.11). */
export const WORKER_POOL_MAX = 2;
/** A scheduler replica's pool, apart from the lock's pinned connection (see the header). */
export const SCHEDULER_POOL_MAX = 1;
/** The advisory lock's pinned connection, on the scheduler replica that holds it. */
export const SCHEDULER_LOCK_CONNECTIONS = 1;
/** A legacy keeper's two (read-model.ts, max 2). */
export const LEGACY_KEEPER_CONNECTIONS = 2;
/**
 * And one more on a legacy keeper whose carry store is not off: createCarryPool
 * (src/carry-store.ts) is a pool of its own, max 1, so a settle never queues for
 * its carry behind the read model's history writes. Only a PROFIT keeper has one
 * (config.ts refuses the store on a role that carries no loss).
 */
export const LEGACY_CARRY_POOL_CONNECTIONS = 1;

/** Where a vault waits; its priority follows from it (queue §2.3). */
export type Lane = "bell" | "busy" | "retry" | "new" | "full" | "safety";
export const LANE_PRIORITY: Readonly<Record<Lane, number>> = { bell: 0, busy: 1, retry: 1, new: 2, full: 3, safety: 4 };

export type IntentKind = "settle" | "wrap" | "convert" | "invest";
export type IntentState = "intent" | "landed" | "failed" | "expired" | "shadow";
/** What a resolution says happened to an intent's transaction. */
export type IntentOutcome = "landed" | "failed" | "expired";
/** `live` sends; `shadow` gates exactly as `live` and never sends (the header). */
export type DispatchWorld = "live" | "shadow";

const VAULT_WORK = `${READ_MODEL_SCHEMA}.vault_work`;
const SEND_INTENT = `${READ_MODEL_SCHEMA}.send_intent`;
const LOSS_CARRY = `${READ_MODEL_SCHEMA}.loss_carry`;
const WORKER = `${READ_MODEL_SCHEMA}.worker`;
const RPC_USAGE = `${READ_MODEL_SCHEMA}.rpc_usage`;
const KEEPER_LINK = `${READ_MODEL_SCHEMA}.keeper_link`;
const FLEET = `${READ_MODEL_SCHEMA}.fleet`;

/**
 * How far ahead of its due time a worker's OWN last vault is taken (CLAIM's soft
 * affinity, ADR §3.4: it keeps the in-memory walk cache warm). A HEAD START,
 * NOT PRECEDENCE: the ADR's `COALESCE(last_holder = $1, false) DESC` put every
 * own vault before every other of the same priority, so under a saturated queue
 * — a full pass's backlog, or a fleet whose busy vaults come due faster than its
 * slots turn them — a vault whose last holder is gone (released on SIGTERM, its
 * worker replaced) or that never had one waited behind each worker's own vaults
 * FOREVER (the P3a-1 note; Q3 checked it: test/worker-pg.test.ts). Ordered by
 * due_at less this head start, an own vault still goes first when it came due
 * up to five minutes after the other, and never later: no vault waits more than
 * five minutes beyond its turn for affinity's sake. Five, so the order Q1 pinned
 * (an own vault due 1 minute ago before another's due 5 minutes ago) holds.
 */
export const CLAIM_AFFINITY_SECONDS = 300;

/**
 * CLAIM (ADR §3.5): up to $2 free slots, for worker $1. The ADR's order —
 * priority, then this worker's own last vaults, then due time — except that the
 * affinity is a head start of CLAIM_AFFINITY_SECONDS on due_at, not precedence.
 *
 * TWO TRACKS FOUND THE SAME STARVATION (P3a-2). The scheduler track's check
 * (test/scheduler-pg.test.ts: workers claiming by affinity, the scheduler
 * re-marking every vault due on every tick of an untrusted doorbell, a third of
 * the vaults last held by a worker that is gone) saw that third never claimed in
 * forty ticks under the ADR's order; the workers' track saw the same with one
 * orphan (test/worker-pg.test.ts). The scheduler track bounded it with a
 * six-minute grace past which a vault went in strict due order; the merge keeps
 * the workers' head start instead: it is continuous (no step at the grace), it
 * keeps the order the scheduler track pinned (an orphan overdue past the bound
 * first, then the claimer's own fresh vault, then another's older one), and
 * test/memory-dispatch-store.ts mirrors it for the fast tests.
 */
export const CLAIM_SQL = `WITH c AS (
  SELECT vault_addr FROM ${VAULT_WORK}
   WHERE system = 'queue' AND parked_reason IS NULL AND due_at <= clock_timestamp()
     AND (holder IS NULL OR lease_until < clock_timestamp())
   ORDER BY priority, due_at - CASE WHEN last_holder = $1 THEN interval '${CLAIM_AFFINITY_SECONDS} seconds' ELSE interval '0 seconds' END, due_at
   LIMIT $2 FOR UPDATE SKIP LOCKED)
UPDATE ${VAULT_WORK} w
   SET holder = $1, fence = w.fence + 1, claimed_at = clock_timestamp(),
       lease_until = clock_timestamp() + interval '${LEASE_SECONDS} seconds', attempts = w.attempts + 1
  FROM c WHERE w.vault_addr = c.vault_addr
RETURNING w.vault_addr, w.fence, w.lane, w.skim_mode, w.streaks, w.attempts`;

/** HEARTBEAT (ADR §3.5): every (vault, fence) worker $1 holds, in two parallel arrays. */
export const HEARTBEAT_SQL = `UPDATE ${VAULT_WORK} SET lease_until = clock_timestamp() + interval '${LEASE_SECONDS} seconds'
 WHERE holder = $1 AND (vault_addr, fence) IN (SELECT * FROM unnest($2::text[], $3::bigint[]))
   AND claimed_at > clock_timestamp() - interval '${JOB_CEILING_MINUTES} minutes'
RETURNING vault_addr`;

/** The GATE's lock (ADR §3.5): the vault row, FOR SHARE, if it is still ($vault, $worker, $fence) with the margin left. */
export const GATE_LOCK_SQL = `SELECT 1 FROM ${VAULT_WORK}
 WHERE vault_addr = $1 AND holder = $2 AND fence = $3
   AND lease_until > clock_timestamp() + interval '${GATE_MARGIN_SECONDS} seconds'
   FOR SHARE`;

const INTENT_COLUMNS =
  "vault_addr, link_addr, kind, fence, worker_id, blockhash, last_valid_block_height, plan_cleared_height, signature, idempotency_key, amount_raw, state";

/** The intent's twelve values, every one cast: a parameter that only appears in a SELECT list has no type to infer. */
const INTENT_VALUES = "$1::text, $2::text, $3::text, $4::bigint, $5::text, $6::text, $7::bigint, $8::bigint, $9::text, $10::text, $11::numeric, $12::text";

/**
 * THE PLAN FLOOR, IN THE GATE ITSELF (the header's "takeover's floor"): the
 * largest COALESCE(resolved_height, last_valid_block_height) over every EARLIER
 * fence's intent of the vault — PLAN_FLOOR_SQL's number, and the overlap
 * audit's own right-hand side.
 */
const GATE_FLOOR_CTE = `p AS (
  SELECT max(COALESCE(resolved_height, last_valid_block_height)) AS floor
    FROM ${SEND_INTENT} WHERE vault_addr = $1::text AND fence < $4::bigint)`;

/**
 * Whether the plan cleared that floor: plan_cleared_height ($8) STRICTLY above
 * it, or — only when no earlier fence ever gated an intent on this vault — any
 * plan_cleared_height, NULL included. A NULL height over an earlier intent is
 * refused: NULL is not above anything, and it would also drop out of the
 * audit's comparison.
 *
 * SOUND UNDER THE ROW LOCK. Once the fence has moved no earlier fence can gate
 * again, so no earlier intent can appear after this read; and a resolution only
 * ever LOWERS an intent's bound, from its last valid height to where it actually
 * landed or reverted.
 */
const GATE_FLOOR_CLEARED = "COALESCE($8::bigint > p.floor, p.floor IS NULL)";

/**
 * The GATE's intent row, inside its transaction, after GATE_LOCK_SQL: inserted
 * only when the plan cleared the floor. ALWAYS ONE ROW BACK — `id` NULL when
 * nothing was inserted, and the floor it was judged against — so a refusal can
 * say which height it needed.
 */
export const GATE_INSERT_SQL = `WITH ${GATE_FLOOR_CTE},
i AS (
  INSERT INTO ${SEND_INTENT} (${INTENT_COLUMNS})
  SELECT ${INTENT_VALUES} FROM p
   WHERE ${GATE_FLOOR_CLEARED}
  RETURNING id)
SELECT (SELECT id FROM i) AS id, (SELECT floor FROM p) AS plan_floor`;

/**
 * The GATE as one statement (safety §2.2): the same row lock, in a CTE whose
 * rows feed the INSERT, and the same plan floor. No row, no insert. ALWAYS ONE
 * ROW BACK: `id` (NULL when nothing was inserted), `held` (whether the lock
 * found the row at this holder, fence and margin) and the floor, so the two
 * refusals are told apart as in the transaction form.
 */
export const GATE_ONE_STATEMENT_SQL = `WITH l AS (
  SELECT 1 FROM ${VAULT_WORK}
   WHERE vault_addr = $1::text AND holder = $5::text AND fence = $4::bigint
     AND lease_until > clock_timestamp() + interval '${GATE_MARGIN_SECONDS} seconds'
   FOR SHARE),
${GATE_FLOOR_CTE},
i AS (
  INSERT INTO ${SEND_INTENT} (${INTENT_COLUMNS})
  SELECT ${INTENT_VALUES} FROM l, p
   WHERE ${GATE_FLOOR_CLEARED}
  RETURNING id)
SELECT (SELECT id FROM i) AS id, EXISTS (SELECT 1 FROM l) AS held, (SELECT floor FROM p) AS plan_floor`;

/**
 * COMPLETE (ADR §3.5), and RELEASE with a delay of 0. A bell rung after the claim
 * makes the vault due at once: a bell during the turn is not lost. `$10` is a
 * delay in seconds added to the database's clock (the header says why).
 */
export const COMPLETE_SQL = `UPDATE ${VAULT_WORK}
   SET holder = NULL, lease_until = NULL, last_holder = $2, attempts = 0, rests = $4, lane = $5,
       priority = $6, streaks = $7, last_outcome = $8, last_detail = $9, last_done_at = clock_timestamp(),
       due_at = CASE WHEN bell_at > claimed_at THEN clock_timestamp()
                     ELSE clock_timestamp() + make_interval(secs => $10::double precision) END
 WHERE vault_addr = $1 AND holder = $2 AND fence = $3
RETURNING vault_addr`;

/**
 * The overlap audit (ADR §3.6, safety §5): zero rows means every later holder
 * planned only after every earlier fence's intent had landed, reverted or
 * expired. The gate for shadow and for L5.
 *
 * NULL-AWARE, WHERE THE ADR'S TEXT IS NOT: `b.plan_cleared_height <= …` is NULL
 * for a row whose height is NULL, and such a row would drop out of the very check
 * that is meant to catch it. A NULL height counts as -1 here, below every bound,
 * so a later-fence row that recorded no plan height is ALWAYS an audit row. The
 * gate refuses to write one (GATE_FLOOR_CLEARED); this is what catches one
 * written any other way.
 */
export const OVERLAP_AUDIT_SQL = `SELECT b.id FROM ${SEND_INTENT} a JOIN ${SEND_INTENT} b
  ON b.vault_addr = a.vault_addr AND b.fence > a.fence
 WHERE COALESCE(b.plan_cleared_height, -1) <= COALESCE(a.resolved_height, a.last_valid_block_height)`;

/** The open intents of earlier fences, oldest first: what a job resolves before it plans (ADR §3.6). */
export const OPEN_INTENTS_SQL = `SELECT id, vault_addr, link_addr, kind, fence, worker_id, blockhash, last_valid_block_height,
       plan_cleared_height, signature, idempotency_key, amount_raw, state
  FROM ${SEND_INTENT}
 WHERE vault_addr = $1 AND fence < $2 AND resolved_at IS NULL
 ORDER BY fence, id`;

/**
 * The height a new plan must be above: the overlap audit's right-hand side over
 * every earlier fence's intent. A plan_cleared_height above it can never be an
 * overlap row.
 */
export const PLAN_FLOOR_SQL = `SELECT max(COALESCE(resolved_height, last_valid_block_height)) AS floor
  FROM ${SEND_INTENT} WHERE vault_addr = $1 AND fence < $2`;

/**
 * A resolution, once: whoever resolves first (the sender or a successor) writes
 * it, and a shadow row stays 'shadow'.
 */
export const RESOLVE_INTENT_SQL = `UPDATE ${SEND_INTENT}
   SET state = CASE WHEN state = 'shadow' THEN 'shadow' ELSE $2 END,
       resolved_height = $3, resolved_at = clock_timestamp()
 WHERE id = $1 AND resolved_at IS NULL
RETURNING id`;

/** A settle's signature, once Privy has answered with it. Never overwrites one. */
export const RECORD_SIGNATURE_SQL = `UPDATE ${SEND_INTENT} SET signature = $2 WHERE id = $1 AND signature IS NULL RETURNING id`;

/**
 * The carry write-ahead inside a PROFIT settle's gate (ADR §4.6, S-4): memory's
 * recordCarry rule, as L2's PgCarryStore applies it — every row of the link but
 * the current state's goes — under the same per-link advisory lock, so this and
 * an L2 writer never interleave on one link. L2's own `on` gate is not repeated
 * here: under the fence a stale writer cannot reach this point, and a successor
 * does not plan a link while an earlier settle on it can still land (ADR §3.6,
 * the takeover rule's settle wait). That holds for the GATED vault's link only,
 * so gate() refuses a carry whose link is not the settle's own (intent.link)
 * before it asks anything. It does not also look the link up in keeper_link:
 * the job takes its links from the vault it claimed, and keeper_link is the
 * scheduler's discovery, which may lag a link that was just made.
 */
export const CARRY_LOCK_SQL = "SELECT pg_advisory_xact_lock($1, hashtext($2))";
export const CARRY_DELETE_SQL = `DELETE FROM ${LOSS_CARRY}
 WHERE link_addr = $1 AND (epoch, settlement_nonce, frontier_slot) <> ($2::bigint, $3::bigint, $4::bigint)`;
export const CARRY_UPSERT_SQL = `INSERT INTO ${LOSS_CARRY}
   (link_addr, epoch, settlement_nonce, frontier_slot, loss_lamports, wallet_signed_tx_count, valid_until_slot, written_by, written_fence, send_intent_id)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
 ON CONFLICT (link_addr, epoch, settlement_nonce, frontier_slot) DO UPDATE SET
   loss_lamports = EXCLUDED.loss_lamports,
   wallet_signed_tx_count = EXCLUDED.wallet_signed_tx_count,
   valid_until_slot = EXCLUDED.valid_until_slot,
   written_by = EXCLUDED.written_by,
   written_fence = EXCLUDED.written_fence,
   send_intent_id = EXCLUDED.send_intent_id,
   written_at = clock_timestamp()`;

/**
 * A job's links (Q3): the addresses the scheduler's discovery holds for the vault
 * and has not seen go, in link-address order. ADDRESSES ONLY: every field a
 * settle reads comes from the job's own fresh read of each one (src/job-chain.ts),
 * because a cached link is never trusted for an attestation (ADR §3.8 step 2).
 */
export const LINKS_OF_VAULT_SQL = `SELECT link_addr FROM ${KEEPER_LINK} WHERE vault_addr = $1 AND gone_at IS NULL ORDER BY link_addr`;

/**
 * A settlement a worker wrote into the history: the leaderboard is due again.
 * The scheduler refreshes it at most once every 15 s while this is set (ADR §3.8
 * step 8, owner decision 25), instead of after every SETTLED.
 */
export const BOARD_DIRTY_SQL = `UPDATE ${FLEET} SET board_dirty_at = clock_timestamp() WHERE id`;

/** The process's own row: written at boot, beaten on its timer, closed on exit. */
export const REGISTER_WORKER_SQL = `INSERT INTO ${WORKER} (worker_id, kind, version, started_at, heartbeat_at, slots)
VALUES ($1, $2, $3, clock_timestamp(), clock_timestamp(), $4)
ON CONFLICT (worker_id) DO UPDATE SET heartbeat_at = clock_timestamp(), stopped_at = NULL, slots = EXCLUDED.slots`;
/**
 * The process's beat: its busy slots and, when given, its stats ($3, jsonb of
 * WORKER_STATS_KEYS only; NULL keeps what is there). Answers the quotas the
 * scheduler last wrote for it and HOW LONG AGO, by the database's clock alone:
 * NULL until the first hand-out.
 *
 * AND HOW OLD THE SCHEDULER'S TICK IS (fleet.tick_at), on the same clock and in
 * the same round trip: what a worker pages scheduler-stale on when both
 * scheduler replicas are gone (SchedulerStaleWatch, src/fleet-alerts.ts). NULL
 * when no tick was ever written, or the fleet row is missing.
 */
export const WORKER_BEAT_SQL = `UPDATE ${WORKER} SET heartbeat_at = clock_timestamp(), busy = $2, stats = COALESCE($3::jsonb, stats)
 WHERE worker_id = $1
RETURNING rps_quota, jup_quota, round(extract(epoch FROM clock_timestamp() - quota_at) * 1000) AS quota_age_ms,
          (SELECT round(extract(epoch FROM clock_timestamp() - f.tick_at) * 1000) FROM ${FLEET} f WHERE f.id) AS tick_age_ms`;
export const WORKER_STOPPED_SQL = `UPDATE ${WORKER} SET stopped_at = clock_timestamp(), busy = 0 WHERE worker_id = $1`;

/** The workers a hand-out divides among: kind 'worker', not stopped, heard within $1 seconds. */
export const LIVE_WORKERS_SQL = `SELECT worker_id FROM ${WORKER}
 WHERE kind = 'worker' AND stopped_at IS NULL AND heartbeat_at > clock_timestamp() - make_interval(secs => $1::double precision)
 ORDER BY worker_id`;

/** The hand-out itself: the same share for each worker named, and quota_at = the database's now. */
export const WRITE_QUOTAS_SQL = `UPDATE ${WORKER} SET rps_quota = $2, jup_quota = $3, quota_at = clock_timestamp()
 WHERE kind = 'worker' AND worker_id = ANY($1::text[])
RETURNING worker_id`;

/**
 * A flush into rpc_usage (credit-governor.ts, RpcUsageFeed.add): each row's
 * counts ADDED onto the stored row with its key. Rows of one flush that share a
 * key are summed first — ON CONFLICT cannot touch one row twice in a statement.
 * Buckets travel as ms since the epoch, the collector's unit.
 */
export const USAGE_ADD_SQL = `INSERT INTO ${RPC_USAGE} AS u (bucket, worker_id, provider, lane, class, calls, errors_429, errors_other)
SELECT to_timestamp(r.bucket_ms / 1000.0), r.worker_id, r.provider, r.lane, r.usage_class, sum(r.calls), sum(r.errors_429), sum(r.errors_other)
  FROM unnest($1::bigint[], $2::text[], $3::text[], $4::text[], $5::text[], $6::bigint[], $7::bigint[], $8::bigint[])
       AS r(bucket_ms, worker_id, provider, lane, usage_class, calls, errors_429, errors_other)
 GROUP BY 1, 2, 3, 4, 5
ON CONFLICT (bucket, worker_id, provider, lane, class) DO UPDATE SET
  calls = u.calls + EXCLUDED.calls,
  errors_429 = u.errors_429 + EXCLUDED.errors_429,
  errors_other = u.errors_other + EXCLUDED.errors_other`;

/** Every rpc_usage row whose bucket starts in [$1, $2), both ms since the epoch. */
export const USAGE_READ_SQL = `SELECT (extract(epoch FROM bucket) * 1000)::bigint AS bucket_ms, worker_id, provider, lane, class, calls, errors_429, errors_other
  FROM ${RPC_USAGE}
 WHERE bucket >= to_timestamp($1 / 1000.0) AND bucket < to_timestamp($2 / 1000.0)`;

/**
 * The governor's read (RpcUsageFeed.summarize), aggregated here: calls by class
 * over the buckets in [$1, $3), each sum split by whether the bucket starts at or
 * after $2 (the recent window) and whether its lane is 'rest'. Only the providers
 * in $4 (the bill's, HELIUS_USAGE_PROVIDERS) and the lanes in $5 (the code's):
 * read() skips a lane it cannot name, and so does this. At most four rows a
 * class, whatever the month's row count.
 */
export const USAGE_SUMMARY_SQL = `SELECT class, lane = 'rest' AS rest, bucket >= to_timestamp($2 / 1000.0) AS recent, sum(calls) AS calls
  FROM ${RPC_USAGE}
 WHERE bucket >= to_timestamp($1 / 1000.0) AND bucket < to_timestamp($3 / 1000.0)
   AND provider = ANY($4::text[]) AND lane = ANY($5::text[])
 GROUP BY 1, 2, 3`;

/** The 35-day retention ([QUEUE] §2.3), the scheduler's reap: rows whose bucket starts before $1 ms. */
export const USAGE_PRUNE_SQL = `DELETE FROM ${RPC_USAGE} WHERE bucket < to_timestamp($1 / 1000.0)`;

/** What a worker reports on its beat: the page's keys (WORKER_STATS_KEYS), counters since its boot. */
export type WorkerStatsWrite = { readonly [K in (typeof WORKER_STATS_KEYS)[number]]?: number };

/**
 * The jsonb a beat writes: WORKER_STATS_KEYS only, each a whole number of zero
 * or more. The column is free jsonb and the page is public; a key the page does
 * not name never reaches the row, and a value that is not a count is dropped
 * rather than served.
 */
export function workerStatsJson(stats: WorkerStatsWrite | undefined): string | null {
  if (stats === undefined) return null;
  const out: Record<string, number> = {};
  for (const key of WORKER_STATS_KEYS) {
    const value = stats[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) out[key] = value;
  }
  return JSON.stringify(out);
}

/** A hand-out as the scheduler made it: the arithmetic, and the workers it was written to. */
export interface QuotaHandOut {
  readonly quotas: FleetQuotas;
  readonly workers: readonly string[];
}

/** What the store needs of pg: a pool that lends clients. pg.Pool is one. */
export interface DispatchPool {
  connect(): Promise<DispatchClient>;
}

export interface DispatchClient {
  query(text: string, values?: unknown[]): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
  release(destroy?: boolean): void;
}

/** A vault this worker now holds, at this fence. */
export interface ClaimedVault {
  readonly vault: string;
  readonly fence: bigint;
  readonly lane: string;
  /** The last mode byte read, or null: it picks the job's module and is never trusted to settle. */
  readonly skimMode: number | null;
  readonly streaks: Readonly<Record<string, unknown>>;
  /** Consecutive claims that did not complete, this one included. */
  readonly attempts: number;
}

/** A vault this worker holds, as the heartbeat names it. */
export interface HeldVault {
  readonly vault: string;
  readonly fence: bigint;
}

/** Everything the gate records about one send, before it leaves. */
export interface IntentDraft {
  readonly vault: string;
  readonly fence: bigint;
  readonly kind: IntentKind;
  /** The link a settle is for; null for wrap, convert and invest. */
  readonly link: string | null;
  readonly blockhash: string;
  readonly lastValidBlockHeight: bigint;
  /** The finalized height this holder saw pass every older fence's intents before it planned. */
  readonly planClearedHeight: bigint | null;
  /** Null for a Privy settle, whose id is known only once Privy answers (recordSignature). */
  readonly signature: string | null;
  readonly idempotencyKey: string | null;
  readonly amountRaw: bigint | null;
}

/** A PROFIT settle's carry, written in its gate: the state it leaves and the loss it carries there, or none. */
export interface GateCarry {
  readonly link: CarryLink;
  /** The window's end slot: the frontier of the state the settle leaves. */
  readonly endSlot: bigint;
  readonly carry: LossCarry | null;
  /** The attestation's valid_until_slot (L2's column: until then the settle may land). */
  readonly validUntilSlot: bigint;
}

/**
 * Why a gate refused: `lease` — the vault is no longer this worker's at this
 * fence with the margin left (the fence did its job); `plan-floor` — the lease
 * is fine but the job planned without clearing every earlier fence's intents
 * (a bug in the job's takeover, caught before it could send).
 */
export type GateRefusal = "lease" | "plan-floor";

export type GateAnswer =
  | { readonly kind: "gated"; readonly intentId: bigint; readonly carryWritten: boolean }
  | { readonly kind: "refused"; readonly reason: GateRefusal; readonly detail: string }
  | { readonly kind: "unavailable"; readonly detail: string }
  | { readonly kind: "unacknowledged"; readonly detail: string };

/** COMPLETE's fields: what the job leaves on the vault's row. */
export interface Completion {
  readonly rests: boolean;
  readonly lane: Lane;
  /** Defaults to the lane's (LANE_PRIORITY). */
  readonly priority?: number;
  readonly streaks: Readonly<Record<string, unknown>>;
  readonly outcome: string;
  readonly detail: string | null;
  /** Seconds after the database's clock at which the vault is due again; 0 for at once. */
  readonly dueInSeconds: number;
}

/** An open intent of an earlier fence, as a job's takeover reads it. */
export interface OpenIntent {
  readonly id: bigint;
  readonly vault: string;
  readonly link: string | null;
  readonly kind: IntentKind;
  readonly fence: bigint;
  readonly worker: string;
  readonly blockhash: string;
  readonly lastValidBlockHeight: bigint;
  readonly planClearedHeight: bigint | null;
  readonly signature: string | null;
  readonly idempotencyKey: string | null;
  readonly amountRaw: bigint | null;
  readonly state: IntentState;
}

/** What a job reads of the earlier fences before it plans (ADR §3.6). */
export interface PriorIntents {
  /** Unresolved, oldest first: resolve each, or wait it out. */
  readonly open: readonly OpenIntent[];
  /**
   * The height this job's plan_cleared_height must be ABOVE: the largest
   * COALESCE(resolved_height, last_valid_block_height) over every earlier
   * fence's intent, or null when there is none.
   */
  readonly planFloor: bigint | null;
}

const big = (value: unknown): bigint => BigInt(String(value));
const bigOrNull = (value: unknown): bigint | null => (value === null || value === undefined ? null : big(value));
const textOrNull = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

/**
 * Whether a failed COMMIT (or a one-statement gate, which is its own commit) is
 * CERTAIN to have committed nothing: the server answered it with an error of its
 * own about the request — a constraint, a type — and Postgres rolls back what it
 * answers that way. NOT CERTAIN: no answer at all (a dropped connection, this
 * side's query_timeout), or an answer that says the SERVER is in trouble
 * (databaseAnswered's classes 08, 53, 57, 58): a backend terminated after its
 * commit record was written still reports FATAL, and the row is there.
 */
export function certainlyNotCommitted(error: unknown): boolean {
  return databaseAnswered(error);
}

/**
 * The dispatcher's store for one process: `holder` is its worker_id, the name
 * every lease it takes is held under; `world` is fixed for its life (the header).
 */
export class DispatchStore {
  constructor(
    private readonly pool: DispatchPool,
    readonly holder: string,
    readonly world: DispatchWorld = "live",
  ) {
    if (holder.trim() === "") throw new Error("a dispatch store needs its process's worker_id");
  }

  /** CLAIM: up to `slots` vaults, each with its new fence. Throws when the database cannot be asked. */
  async claim(slots: number): Promise<readonly ClaimedVault[]> {
    if (!Number.isInteger(slots) || slots < 1) return [];
    const rows = await this.#one(CLAIM_SQL, [this.holder, slots]);
    return rows.map((row) => ({
      vault: String(row["vault_addr"]),
      fence: big(row["fence"]),
      lane: String(row["lane"]),
      skimMode: row["skim_mode"] === null || row["skim_mode"] === undefined ? null : Number(row["skim_mode"]),
      streaks: (row["streaks"] ?? {}) as Record<string, unknown>,
      attempts: Number(row["attempts"]),
    }));
  }

  /**
   * HEARTBEAT: renews every held (vault, fence) that is still this process's and
   * inside the job ceiling; answers the vaults it renewed. A held vault missing
   * from the answer has lost its lease, or passed the ceiling: its job stops at
   * its next step. Throws when the database cannot be asked — and then nothing
   * was renewed, which the gate will find out on its own.
   */
  async heartbeat(held: readonly HeldVault[]): Promise<ReadonlySet<string>> {
    if (held.length === 0) return new Set();
    const rows = await this.#one(HEARTBEAT_SQL, [this.holder, held.map((h) => h.vault), held.map((h) => h.fence.toString())]);
    return new Set(rows.map((row) => String(row["vault_addr"])));
  }

  /**
   * GATE, as one transaction: the lock, the intent and — for a PROFIT settle —
   * its carry, committed together or not at all. Only `gated` may send.
   */
  async gate(intent: IntentDraft, options: { readonly carry?: GateCarry | null } = {}): Promise<GateAnswer> {
    // A CARRY BELONGS TO THE SETTLE IT IS GATED WITH, checked before the world
    // drops it, so a shadow worker refuses the same mis-wired call a live one
    // would. The row lock and the fence cover intent.vault ONLY: a carry for any
    // other link would delete that link's states, and stamp them with this fence,
    // on a vault whose lease this worker may not hold.
    if (options.carry !== undefined && options.carry !== null) {
      const carryLink = options.carry.link.linkAddress.toBase58();
      if (intent.kind !== "settle" || intent.link !== carryLink) {
        throw new Error(
          `a carry is written only with the settle of its own link: this gate is a ${intent.kind} for ` +
            `${intent.link === null ? "no link" : `link ${intent.link}`} and the carry is for link ${carryLink}; nothing was asked`,
        );
      }
    }
    const carry = this.world === "shadow" ? null : (options.carry ?? null);
    // THE CODE REFUSES IT FIRST, as recordCarry does; the table's CHECK refuses it again.
    if (carry !== null && carry.carry !== null && carry.carry.lossLamports <= 0n) {
      throw new Error(`a carried loss is positive, not ${carry.carry.lossLamports} lamports: a carry that is not a loss would raise the next base`);
    }
    let client: DispatchClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      return { kind: "unavailable", detail: `no database connection for the gate: ${summarizeUpstreamError(error)}` };
    }
    let destroy = false;
    let stage: "before-commit" | "commit" = "before-commit";
    try {
      await client.query("BEGIN");
      const lock = await client.query(GATE_LOCK_SQL, [intent.vault, this.holder, intent.fence.toString()]);
      if (lock.rows.length === 0) {
        await client.query("ROLLBACK");
        return { kind: "refused", reason: "lease", detail: refusedDetail(intent) };
      }
      const inserted = (await client.query(GATE_INSERT_SQL, this.#intentValues(intent))).rows[0];
      if (inserted?.["id"] === null || inserted?.["id"] === undefined) {
        await client.query("ROLLBACK");
        return { kind: "refused", reason: "plan-floor", detail: planFloorDetail(intent, bigOrNull(inserted?.["plan_floor"])) };
      }
      const intentId = big(inserted["id"]);
      if (carry !== null) await this.#writeCarry(client, carry, intent.fence, intentId);
      stage = "commit";
      await client.query("COMMIT");
      return { kind: "gated", intentId, carryWritten: carry !== null };
    } catch (error) {
      destroy = true;
      // BEFORE COMMIT NOTHING CAN HAVE COMMITTED: the transaction is rolled back,
      // or dies with the connection, which Postgres aborts.
      if (stage === "before-commit") await client.query("ROLLBACK").catch(() => undefined);
      const detail = summarizeUpstreamError(error);
      if (stage === "commit" && !certainlyNotCommitted(error)) {
        return { kind: "unacknowledged", detail: `the gate's COMMIT was not acknowledged (${detail}); nothing was sent` };
      }
      return { kind: "unavailable", detail: `the gate failed before it committed (${detail}); nothing was sent` };
    } finally {
      client.release(destroy);
    }
  }

  /**
   * GATE as one statement (the header): one round trip, the same lock. Not for a
   * PROFIT settle, whose carry needs the transaction.
   */
  async gateOneStatement(intent: IntentDraft): Promise<GateAnswer> {
    let client: DispatchClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      return { kind: "unavailable", detail: `no database connection for the gate: ${summarizeUpstreamError(error)}` };
    }
    let destroy = false;
    try {
      const row = (await client.query(GATE_ONE_STATEMENT_SQL, this.#intentValues(intent))).rows[0];
      if (row?.["id"] !== null && row?.["id"] !== undefined) return { kind: "gated", intentId: big(row["id"]), carryWritten: false };
      if (row?.["held"] !== true) return { kind: "refused", reason: "lease", detail: refusedDetail(intent) };
      return { kind: "refused", reason: "plan-floor", detail: planFloorDetail(intent, bigOrNull(row["plan_floor"])) };
    } catch (error) {
      destroy = true;
      const detail = summarizeUpstreamError(error);
      // ONE STATEMENT IS ITS OWN COMMIT: an answer that never came leaves it in doubt.
      if (!certainlyNotCommitted(error)) {
        return { kind: "unacknowledged", detail: `the gate's statement was not acknowledged (${detail}); nothing was sent` };
      }
      return { kind: "unavailable", detail: `the gate failed (${detail}); nothing was sent` };
    } finally {
      client.release(destroy);
    }
  }

  /** COMPLETE: true when the lease was still this worker's; false means it was lost, and the outcome is discarded. */
  async complete(held: HeldVault, done: Completion): Promise<boolean> {
    if (!Number.isFinite(done.dueInSeconds) || done.dueInSeconds < 0) {
      throw new Error(`a vault is due again after a delay of 0 or more seconds, not ${done.dueInSeconds}`);
    }
    const rows = await this.#one(COMPLETE_SQL, [
      held.vault,
      this.holder,
      held.fence.toString(),
      done.rests,
      done.lane,
      done.priority ?? LANE_PRIORITY[done.lane],
      JSON.stringify(done.streaks),
      done.outcome,
      done.detail,
      done.dueInSeconds,
    ]);
    return rows.length > 0;
  }

  /**
   * RELEASE on SIGTERM: COMPLETE, due at once, resting false, its lane and
   * streaks as the claim left them, so whoever claims next turns it now.
   */
  async release(claimed: ClaimedVault, reason: string): Promise<boolean> {
    const lane = (Object.hasOwn(LANE_PRIORITY, claimed.lane) ? claimed.lane : "new") as Lane;
    return this.complete(claimed, { rests: false, lane, streaks: claimed.streaks, outcome: "RELEASED", detail: reason, dueInSeconds: 0 });
  }

  /** The open intents of earlier fences, and the height this job's plan must be above (ADR §3.6). */
  async priorIntents(held: HeldVault): Promise<PriorIntents> {
    return this.#withClient(async (client) => {
      const open = await client.query(OPEN_INTENTS_SQL, [held.vault, held.fence.toString()]);
      const floor = await client.query(PLAN_FLOOR_SQL, [held.vault, held.fence.toString()]);
      return {
        open: open.rows.map((row) => ({
          id: big(row["id"]),
          vault: String(row["vault_addr"]),
          link: textOrNull(row["link_addr"]),
          kind: String(row["kind"]) as IntentKind,
          fence: big(row["fence"]),
          worker: String(row["worker_id"]),
          blockhash: String(row["blockhash"]),
          lastValidBlockHeight: big(row["last_valid_block_height"]),
          planClearedHeight: bigOrNull(row["plan_cleared_height"]),
          signature: textOrNull(row["signature"]),
          idempotencyKey: textOrNull(row["idempotency_key"]),
          amountRaw: bigOrNull(row["amount_raw"]),
          state: String(row["state"]) as IntentState,
        })),
        planFloor: bigOrNull(floor.rows[0]?.["floor"]),
      };
    });
  }

  /**
   * Resolves an intent once. `resolvedHeight` is the last height at which its
   * transaction could still act: where it landed or reverted, or its
   * last_valid_block_height when it expired; null leaves the audit on the lvbh.
   * True when this call resolved it.
   */
  async resolveIntent(id: bigint, outcome: IntentOutcome, resolvedHeight: bigint | null): Promise<boolean> {
    const rows = await this.#one(RESOLVE_INTENT_SQL, [id.toString(), outcome, resolvedHeight?.toString() ?? null]);
    return rows.length > 0;
  }

  /** A settle's signature, once Privy has answered. True when it was recorded. */
  async recordSignature(id: bigint, signature: string): Promise<boolean> {
    const rows = await this.#one(RECORD_SIGNATURE_SQL, [id.toString(), signature]);
    return rows.length > 0;
  }

  /** The overlap audit's rows (ADR §3.6): must be empty. */
  async overlapAudit(): Promise<readonly bigint[]> {
    const rows = await this.#one(OVERLAP_AUDIT_SQL, []);
    return rows.map((row) => big(row["id"]));
  }

  /** The process's row in `worker`, at boot. */
  async registerProcess(kind: "scheduler" | "worker", version: string, slots: number): Promise<void> {
    await this.#one(REGISTER_WORKER_SQL, [this.holder, kind, version, slots]);
  }

  /**
   * The process's own beat: its busy slots and, when given, its stats. Answers
   * its row's quotas as QuotaFollower reads them — requests a second, Jupiter
   * calls a minute, and how long ago the scheduler wrote them by the database's
   * clock (null before the first hand-out) — or null when the row is gone.
   */
  async beatProcess(busy: number, stats?: WorkerStatsWrite): Promise<WorkerQuotaRow | null> {
    return (await this.#beat(busy, stats))?.quota ?? null;
  }

  /** The beat's one statement: the quotas as QuotaFollower reads them, and the scheduler tick's age; null when the row is gone. */
  async #beat(busy: number, stats?: WorkerStatsWrite): Promise<{ readonly quota: WorkerQuotaRow; readonly tickAgeMs: number | null } | null> {
    const rows = await this.#one(WORKER_BEAT_SQL, [this.holder, busy, workerStatsJson(stats)]);
    const row = rows[0];
    if (row === undefined) return null;
    const quota = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
    return {
      quota: { rpsQuota: quota(row["rps_quota"]), jupQuotaPerMinute: quota(row["jup_quota"]), ageMs: quota(row["quota_age_ms"]) },
      tickAgeMs: quota(row["tick_age_ms"]),
    };
  }

  /**
   * The beat as QuotaFollower's source (src/rpc-quota.ts): every read IS the
   * 10 s beat, so following the quota costs no statement of its own. `beat`
   * says what this beat reports. `onTick`, when given, is told the scheduler
   * tick's age from every beat that ANSWERED with this process's row (null: no
   * tick was ever written) — a beat that failed or found no row tells it
   * nothing, because it knows nothing.
   */
  quotaSource(
    beat: () => { readonly busy: number; readonly stats?: WorkerStatsWrite },
    onTick?: (tickAgeMs: number | null) => void,
  ): WorkerQuotaSource {
    return {
      readQuota: async () => {
        const now = beat();
        const read = await this.#beat(now.busy, now.stats);
        if (read !== null && onTick !== undefined) {
          try {
            onTick(read.tickAgeMs);
          } catch {
            // An alert that cannot be raised never costs the beat its quotas.
          }
        }
        return read?.quota ?? null;
      },
    };
  }

  /**
   * THE SCHEDULER'S HAND-OUT (ADR §3.8 step 7, §3.9): fleetQuotas over the
   * workers alive now, written to each of them with quota_at. Two statements, on
   * purpose not one transaction: a worker that registers between them is not
   * written and stays on its floor until the next tick, which is the same place a
   * worker stands before its first beat has read anything.
   *
   * MORE ALIVE THAN maxWorkers (a deploy's boot window, where old and new workers
   * overlap, or a killed worker whose row is still inside WORKER_DEAD_AFTER_MS)
   * is divided among all of them: the shares never add up to more than the
   * fleet's budget, where fleetQuotas alone would refuse the count. The
   * answer's floorRps is then the floor over that larger count; each worker's
   * own floor is its configuration, never written here.
   */
  async handOutQuotas(input: Omit<FleetQuotaInput, "liveWorkers">): Promise<QuotaHandOut> {
    if (!Number.isSafeInteger(input.maxWorkers) || input.maxWorkers < 1) {
      throw new Error(`maxWorkers must be a whole number of workers, at least 1, not ${input.maxWorkers}`);
    }
    const live = (await this.#one(LIVE_WORKERS_SQL, [WORKER_DEAD_AFTER_MS / 1000])).map((row) => String(row["worker_id"]));
    const quotas = fleetQuotas({ ...input, liveWorkers: live.length, maxWorkers: Math.max(input.maxWorkers, live.length) });
    if (live.length === 0 || quotas.perWorkerRps === null) return { quotas, workers: [] };
    const written = await this.#one(WRITE_QUOTAS_SQL, [live, quotas.perWorkerRps, quotas.perWorkerJupiterPerMinute]);
    return { quotas, workers: written.map((row) => String(row["worker_id"])) };
  }

  /** The process's row closed, on its way out. */
  async processStopped(): Promise<void> {
    await this.#one(WORKER_STOPPED_SQL, [this.holder]);
  }

  /** A job's link addresses (LINKS_OF_VAULT_SQL): never trusted beyond the address. */
  async linksOf(vault: string): Promise<readonly string[]> {
    return (await this.#one(LINKS_OF_VAULT_SQL, [vault])).map((row) => String(row["link_addr"]));
  }

  /** The leaderboard is due again (BOARD_DIRTY_SQL). */
  async markBoardDirty(): Promise<void> {
    await this.#one(BOARD_DIRTY_SQL, []);
  }

  #intentValues(intent: IntentDraft): unknown[] {
    return [
      intent.vault,
      intent.link,
      intent.kind,
      intent.fence.toString(),
      this.holder,
      intent.blockhash,
      intent.lastValidBlockHeight.toString(),
      intent.planClearedHeight?.toString() ?? null,
      intent.signature,
      intent.idempotencyKey,
      intent.amountRaw?.toString() ?? null,
      this.world === "shadow" ? "shadow" : "intent",
    ];
  }

  async #writeCarry(client: DispatchClient, { link, endSlot, carry, validUntilSlot }: GateCarry, fence: bigint, intentId: bigint): Promise<void> {
    const address = link.linkAddress.toBase58();
    await client.query(CARRY_LOCK_SQL, [CARRY_LOCK_CLASS, address]);
    await client.query(CARRY_DELETE_SQL, [address, link.epoch.toString(), link.settlementNonce.toString(), link.frontierSlot.toString()]);
    if (carry === null) return;
    await client.query(CARRY_UPSERT_SQL, [
      address,
      link.epoch.toString(),
      (link.settlementNonce + 1n).toString(),
      endSlot.toString(),
      carry.lossLamports.toString(),
      carry.walletSignedTxCount,
      validUntilSlot.toString(),
      this.holder,
      fence.toString(),
      intentId.toString(),
    ]);
  }

  /** One statement on a pooled client. A client whose statement failed is destroyed, not returned. */
  async #one(text: string, values: unknown[]): Promise<readonly Record<string, unknown>[]> {
    return this.#withClient(async (client) => (await client.query(text, values)).rows);
  }

  async #withClient<T>(work: (client: DispatchClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let destroy = false;
    try {
      return await work(client);
    } catch (error) {
      destroy = true;
      throw error;
    } finally {
      client.release(destroy);
    }
  }
}

function refusedDetail(intent: IntentDraft): string {
  return (
    `vault ${intent.vault} is no longer held at fence ${intent.fence} with more than ${GATE_MARGIN_SECONDS} s of lease left; ` +
    "the signed bytes were dropped and nothing was sent"
  );
}

function planFloorDetail(intent: IntentDraft, floor: bigint | null): string {
  const cleared = intent.planClearedHeight === null ? "no plan_cleared_height" : `plan_cleared_height ${intent.planClearedHeight}`;
  return (
    `vault ${intent.vault} at fence ${intent.fence} planned with ${cleared}, which is not above ${floor ?? "the floor"} — the ` +
    "last height at which an earlier fence's intent could still act — so it may have planned from a state without that " +
    "transaction; the signed bytes were dropped and nothing was sent"
  );
}

/**
 * How many Postgres connections a dispatcher fleet holds (ADR §3.11; the queue
 * section's when.py): the scheduler's holder (its pool plus the pinned lock) and
 * standby, `workerReplicas` workers at WORKER_POOL_MAX, doubled while a deploy's
 * new containers boot beside the old, plus each legacy keeper still running —
 * its read model's two, and `legacyCarryStores` of them (profit keepers with
 * SIP_SOLANA_CARRY_STORE dual or on) one more each for the carry pool. when.py
 * counted the read model only; with the carry store on, the profit keeper's
 * third connection is real and its table under-counts by one (two in a deploy).
 */
export function dispatchConnections({
  workerReplicas,
  deploying = false,
  legacyKeepers = 0,
  legacyCarryStores = 0,
}: {
  readonly workerReplicas: number;
  readonly deploying?: boolean;
  readonly legacyKeepers?: number;
  /** How many of `legacyKeepers` run a carry store (not off): each holds LEGACY_CARRY_POOL_CONNECTIONS more. */
  readonly legacyCarryStores?: number;
}): number {
  if (!Number.isSafeInteger(legacyCarryStores) || legacyCarryStores < 0 || legacyCarryStores > legacyKeepers) {
    throw new Error(`legacyCarryStores counts legacy keepers with a carry store: 0 to legacyKeepers (${legacyKeepers}), not ${legacyCarryStores}`);
  }
  const scheduler = SCHEDULER_POOL_MAX + SCHEDULER_LOCK_CONNECTIONS + SCHEDULER_POOL_MAX;
  const legacy = LEGACY_KEEPER_CONNECTIONS * legacyKeepers + LEGACY_CARRY_POOL_CONNECTIONS * legacyCarryStores;
  const steady = scheduler + WORKER_POOL_MAX * workerReplicas + legacy;
  return deploying ? 2 * steady : steady;
}

/**
 * A dispatcher process's pool: WORKER_POOL_MAX or SCHEDULER_POOL_MAX
 * connections, every statement bounded at DISPATCH_STATEMENT_TIMEOUT_MS on both
 * sides, and a connection waited for no longer than that. An exhausted pool is
 * then a gate that answers `unavailable` within the bound — nothing sent — never
 * one that waits past its lease. `applicationName` shows the process in
 * pg_stat_activity.
 *
 * AND THE GAP BETWEEN TWO STATEMENTS IS BOUNDED TOO (idle_in_transaction_session_timeout,
 * the same 5 s). statement_timeout only runs while a statement does: a gate whose
 * process stops between its FOR SHARE and its COMMIT — paused, SIGSTOPped, a host
 * that suspends — would otherwise sit "idle in transaction" holding the vault's
 * row lock for as long as the TCP connection lives. Every claim would skip the
 * vault, and every write to its row (the heartbeat, release, the receiver's
 * multi-vault bell) would wait out its own timeout and fail. With the bound the
 * server ends that session and its transaction, the lock goes, and the process's
 * late COMMIT meets a dead connection: `unacknowledged`, nothing sent. A healthy
 * gate sends its statements back to back, microseconds apart.
 */
export function createDispatchPool(
  databaseUrl: Secret,
  kind: "scheduler" | "worker",
  applicationName: string,
  warn: (message: string, fields: Record<string, unknown>) => void,
): pg.Pool {
  const connectionString = databaseUrl.reveal();
  const pool = new pg.Pool({
    connectionString,
    ssl: sslFor(connectionString),
    max: kind === "worker" ? WORKER_POOL_MAX : SCHEDULER_POOL_MAX,
    connectionTimeoutMillis: DISPATCH_STATEMENT_TIMEOUT_MS,
    idleTimeoutMillis: 30_000,
    statement_timeout: DISPATCH_STATEMENT_TIMEOUT_MS,
    query_timeout: DISPATCH_STATEMENT_TIMEOUT_MS,
    idle_in_transaction_session_timeout: DISPATCH_STATEMENT_TIMEOUT_MS,
    application_name: applicationName,
  });
  // REQUIRED, as for every pool in this keeper: an idle client erroring emits
  // 'error' on the pool, and unhandled that takes the process down.
  pool.on("error", (error) => warn("dispatch pool idle client error (ignored)", { detail: summarizeUpstreamError(error) }));
  // AND A CHECKED-OUT CLIENT'S OWN: pg-pool takes its idle listener off a client
  // it lends, so a connection that dies BETWEEN two statements — the server's
  // idle-in-transaction bound above ending a stalled gate, a terminated backend,
  // a dropped socket — emits 'error' on the client with nobody listening, which
  // throws out of the socket's handler and ends the process. Heard here, it
  // only marks the client unusable: its next statement fails, the store's
  // catch answers for that (`unacknowledged` or `unavailable` for a gate) and
  // destroys it.
  pool.on("connect", (client) => {
    client.on("error", (error) => warn("dispatch pool client error while lent (its next statement fails)", { detail: summarizeUpstreamError(error) }));
  });
  return pool;
}

const USAGE_PROVIDERS: ReadonlySet<string> = new Set<UsageProvider>(["helius-rpc", "helius-rest", "jupiter", "privy", "other"]);
const USAGE_LANES: ReadonlySet<string> = new Set<RpcLane>(["send", "hot", "rest", "sched"]);

/**
 * rpc_usage in Postgres: the RpcUsageFeed (src/credit-governor.ts) every
 * process's RpcUsageCollector flushes into on its heartbeat, and the scheduler's
 * CreditGovernor reads. The same contract as InMemoryRpcUsageFeed, which the
 * merge's test holds it to row for row.
 *
 * ONE STATEMENT A FLUSH, on the process's own dispatch pool, and never on a
 * request's path: only the heartbeat flushes (the collector's header). A flush
 * that fails throws, and the collector keeps its rows for the next beat.
 *
 * A ROW READ BACK WITH A PROVIDER OR LANE THE CODE DOES NOT NAME is skipped, not
 * guessed at: the governor sums only the two Helius providers, and a row it
 * cannot place must not be priced.
 */
export class PgRpcUsageFeed implements RpcUsageFeed {
  constructor(private readonly pool: DispatchPool) {}

  async add(rows: readonly RpcUsageRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.#query(USAGE_ADD_SQL, [
      rows.map((row) => row.bucket.toString()),
      rows.map((row) => row.workerId),
      rows.map((row) => row.provider),
      rows.map((row) => row.lane),
      rows.map((row) => row.usageClass),
      rows.map((row) => row.calls.toString()),
      rows.map((row) => row.errors429.toString()),
      rows.map((row) => row.errorsOther.toString()),
    ]);
  }

  async read(fromMs: number, toMs: number): Promise<readonly RpcUsageRow[]> {
    const rows = await this.#query(USAGE_READ_SQL, [fromMs, toMs]);
    return rows.flatMap((row) => {
      const provider = String(row["provider"]);
      const lane = String(row["lane"]);
      if (!USAGE_PROVIDERS.has(provider) || !USAGE_LANES.has(lane)) return [];
      return [
        {
          bucket: Number(row["bucket_ms"]),
          workerId: String(row["worker_id"]),
          provider: provider as UsageProvider,
          lane: lane as RpcLane,
          usageClass: String(row["class"]) as UsageClass,
          calls: Number(row["calls"]),
          errors429: Number(row["errors_429"]),
          errorsOther: Number(row["errors_other"]),
        },
      ];
    });
  }

  /** The governor's read, summed by Postgres (USAGE_SUMMARY_SQL): a few dozen rows, never the month's. */
  async summarize(fromMs: number, recentFromMs: number, toMs: number): Promise<HeliusUsageSummary> {
    const rows = await this.#query(USAGE_SUMMARY_SQL, [fromMs, recentFromMs, toMs, [...HELIUS_USAGE_PROVIDERS], [...USAGE_LANES]]);
    const total: Record<string, number> = {};
    const recentRest: Record<string, number> = {};
    const recentOther: Record<string, number> = {};
    for (const row of rows) {
      const usageClass = String(row["class"]);
      const calls = Number(row["calls"]);
      total[usageClass] = (total[usageClass] ?? 0) + calls;
      if (row["recent"] === true) {
        const into = row["rest"] === true ? recentRest : recentOther;
        into[usageClass] = (into[usageClass] ?? 0) + calls;
      }
    }
    return { total, recentRest, recentOther };
  }

  /** The 35-day retention, for the scheduler's reap: how many rows went. */
  async prune(beforeMs: number): Promise<number> {
    const client = await this.pool.connect();
    let destroy = false;
    try {
      const result = (await client.query(USAGE_PRUNE_SQL, [beforeMs])) as { readonly rowCount?: number | null };
      return result.rowCount ?? 0;
    } catch (error) {
      destroy = true;
      throw error;
    } finally {
      client.release(destroy);
    }
  }

  async #query(text: string, values: unknown[]): Promise<readonly Record<string, unknown>[]> {
    const client = await this.pool.connect();
    let destroy = false;
    try {
      return (await client.query(text, values)).rows;
    } catch (error) {
      destroy = true;
      throw error;
    } finally {
      client.release(destroy);
    }
  }
}
