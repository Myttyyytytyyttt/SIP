// The dispatcher's store: the seven tables at the end of sql/sip_solana.sql and
// the FOUR STATEMENTS every lease, fence and send goes through (dispatcher ADR
// §3.4–3.7, decision S-3; safety §2.2; plan P3a, Q1).
//
// DARK. Nothing a legacy keeper runs imports this file (test/dispatch-store.test.ts
// scans for it): only the dispatcher's own entry points will, and with
// SIP_SOLANA_DISPATCH unset none of them runs. Its tables are additive; a legacy
// keeper neither reads nor writes them.
//
// THE FOUR STATEMENTS, as ADR §3.5 writes them:
//
//   CLAIM      up to `slots` due vaults of system 'queue' whose lease is free or
//              expired, FOR UPDATE SKIP LOCKED, fence + 1, a 45 s lease.
//   HEARTBEAT  one statement per process for every vault it holds, every 10 s, on
//              a timer of its own; it renews only (holder, fence) pairs that are
//              still this process's, and refuses past the 6-minute job ceiling.
//              A vault missing from the answer: the job stops at its next step.
//   GATE       before EVERY send, one transaction: the vault row FOR SHARE, held
//              by this worker at this fence with more than 10 s of lease left by
//              clock_timestamp(); then the send_intent row; then, for a PROFIT
//              settle, the carry write-ahead. The bytes leave only once the
//              COMMIT is acknowledged.
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
//   refused         the fence is no longer this worker's, or less than the margin
//                   is left: drop the bytes (never re-sign them with another
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
// worker that resolves, waits and plans is Q3's; this file gives it the two reads.
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
// boot window doubles it; each legacy keeper still running adds its own 2.
// dispatchConnections() is that arithmetic. AN ASSUMED SESSION POOL OF 15 FITS
// r ≤ 2 WITH A DEPLOY, AND NO r WHILE THE LEGACY KEEPERS SHADOW A PUSH.
//
// WHERE THIS FILE FOLLOWS THE CODE OVER THE ADR'S PROSE, said once:
//   * ADR §3.11 says "2 per replica plus 1 pinned on the lock-holding scheduler"
//     and then "steady 3 + 2r". With two scheduler replicas at 2 each that would
//     be 5 + 2r; the 3 + 2r its table and when.py compute is a scheduler pool of
//     ONE (holder 1 + 1 pinned, standby 1). The pools here are sized to the
//     table: SCHEDULER_POOL_MAX = 1, WORKER_POOL_MAX = 2.
//   * COMPLETE's `$10` is a delay in seconds (the clock paragraph above says why).
//   * L2's loss_carry already existed with valid_until_slot and written_by; the
//     dispatcher's written_fence and send_intent_id are added beside them by an
//     ALTER, and a gated carry fills all four.

import pg from "pg";
import { summarizeUpstreamError, type Secret } from "@sip/solana-log";
import { CARRY_LOCK_CLASS, type CarryLink } from "./carry-store.js";
import { READ_MODEL_SCHEMA, databaseAnswered, sslFor } from "./read-model.js";
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

/** CLAIM (ADR §3.5): up to $2 free slots, for worker $1. */
export const CLAIM_SQL = `WITH c AS (
  SELECT vault_addr FROM ${VAULT_WORK}
   WHERE system = 'queue' AND parked_reason IS NULL AND due_at <= clock_timestamp()
     AND (holder IS NULL OR lease_until < clock_timestamp())
   ORDER BY priority, COALESCE(last_holder = $1, false) DESC, due_at
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

/** The GATE's intent row, inside its transaction. */
export const GATE_INSERT_SQL = `INSERT INTO ${SEND_INTENT} (${INTENT_COLUMNS})
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
RETURNING id`;

/**
 * The GATE as one statement (safety §2.2): the same row lock, in a CTE whose
 * rows feed the INSERT. No row, no insert. Every parameter is cast, because a
 * parameter that only appears in a SELECT list has no type to infer.
 */
export const GATE_ONE_STATEMENT_SQL = `WITH l AS (
  SELECT 1 FROM ${VAULT_WORK}
   WHERE vault_addr = $1::text AND holder = $5::text AND fence = $4::bigint
     AND lease_until > clock_timestamp() + interval '${GATE_MARGIN_SECONDS} seconds'
   FOR SHARE)
INSERT INTO ${SEND_INTENT} (${INTENT_COLUMNS})
SELECT $1::text, $2::text, $3::text, $4::bigint, $5::text, $6::text, $7::bigint, $8::bigint, $9::text, $10::text, $11::numeric, $12::text FROM l
RETURNING id`;

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
 * The overlap audit (ADR §3.6, safety §5), exactly: zero rows means every later
 * holder planned only after every earlier fence's intent had landed, reverted or
 * expired. The gate for shadow and for L5.
 */
export const OVERLAP_AUDIT_SQL = `SELECT b.id FROM ${SEND_INTENT} a JOIN ${SEND_INTENT} b
  ON b.vault_addr = a.vault_addr AND b.fence > a.fence
 WHERE b.plan_cleared_height <= COALESCE(a.resolved_height, a.last_valid_block_height)`;

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
 * the takeover rule's settle wait).
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

/** The process's own row: written at boot, beaten on its timer, closed on exit. */
export const REGISTER_WORKER_SQL = `INSERT INTO ${WORKER} (worker_id, kind, version, started_at, heartbeat_at, slots)
VALUES ($1, $2, $3, clock_timestamp(), clock_timestamp(), $4)
ON CONFLICT (worker_id) DO UPDATE SET heartbeat_at = clock_timestamp(), stopped_at = NULL, slots = EXCLUDED.slots`;
export const WORKER_BEAT_SQL = `UPDATE ${WORKER} SET heartbeat_at = clock_timestamp(), busy = $2
 WHERE worker_id = $1 RETURNING rps_quota, jup_quota`;
export const WORKER_STOPPED_SQL = `UPDATE ${WORKER} SET stopped_at = clock_timestamp(), busy = 0 WHERE worker_id = $1`;

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

export type GateAnswer =
  | { readonly kind: "gated"; readonly intentId: bigint; readonly carryWritten: boolean }
  | { readonly kind: "refused"; readonly detail: string }
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
        return { kind: "refused", detail: refusedDetail(intent) };
      }
      const inserted = await client.query(GATE_INSERT_SQL, this.#intentValues(intent));
      const intentId = big(inserted.rows[0]?.["id"]);
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
      const { rows } = await client.query(GATE_ONE_STATEMENT_SQL, this.#intentValues(intent));
      if (rows.length === 0) return { kind: "refused", detail: refusedDetail(intent) };
      return { kind: "gated", intentId: big(rows[0]?.["id"]), carryWritten: false };
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

  /** The process's own beat: its busy slots, and the quotas the scheduler wrote for it (null until it has). */
  async beatProcess(busy: number): Promise<{ readonly rpsQuota: number | null; readonly jupQuota: number | null } | null> {
    const rows = await this.#one(WORKER_BEAT_SQL, [this.holder, busy]);
    const row = rows[0];
    if (row === undefined) return null;
    const quota = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
    return { rpsQuota: quota(row["rps_quota"]), jupQuota: quota(row["jup_quota"]) };
  }

  /** The process's row closed, on its way out. */
  async processStopped(): Promise<void> {
    await this.#one(WORKER_STOPPED_SQL, [this.holder]);
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

/**
 * How many Postgres connections a dispatcher fleet holds (ADR §3.11; the queue
 * section's when.py): the scheduler's holder (its pool plus the pinned lock) and
 * standby, `workerReplicas` workers at WORKER_POOL_MAX, doubled while a deploy's
 * new containers boot beside the old, plus each legacy keeper still running.
 */
export function dispatchConnections({
  workerReplicas,
  deploying = false,
  legacyKeepers = 0,
}: {
  readonly workerReplicas: number;
  readonly deploying?: boolean;
  readonly legacyKeepers?: number;
}): number {
  const scheduler = SCHEDULER_POOL_MAX + SCHEDULER_LOCK_CONNECTIONS + SCHEDULER_POOL_MAX;
  const steady = scheduler + WORKER_POOL_MAX * workerReplicas + LEGACY_KEEPER_CONNECTIONS * legacyKeepers;
  return deploying ? 2 * steady : steady;
}

/**
 * A dispatcher process's pool: WORKER_POOL_MAX or SCHEDULER_POOL_MAX
 * connections, every statement bounded at DISPATCH_STATEMENT_TIMEOUT_MS on both
 * sides, and a connection waited for no longer than that. An exhausted pool is
 * then a gate that answers `unavailable` within the bound — nothing sent — never
 * one that waits past its lease. `applicationName` shows the process in
 * pg_stat_activity.
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
    application_name: applicationName,
  });
  // REQUIRED, as for every pool in this keeper: an idle client erroring emits
  // 'error' on the pool, and unhandled that takes the process down.
  pool.on("error", (error) => warn("dispatch pool idle client error (ignored)", { detail: summarizeUpstreamError(error) }));
  return pool;
}
