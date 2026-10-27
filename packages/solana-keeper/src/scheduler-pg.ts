// The scheduler's statements over the dispatcher's tables (Q2; dispatcher ADR
// §3.8, §3.12; [QUEUE] §2.7), and its lock.
//
// THE TABLES ARE Q1's (sql/sip_solana.sql, src/dispatch-store.ts). This file
// writes only what ADR §3.8 calls the scheduler's: keeper_link (discovery),
// vault_work's SCHEDULING columns — lane, priority, due_at, and a completion of
// its own for a vault it decided needs no job (C7) — the fleet row's tick, the
// reap's parking, and the resolution of intents nobody reclaimed. It never
// touches a holder, a lease or a fence: those are the four statements' alone.
//
// EVERY SCHEDULER WRITE IS A HINT (ADR §3.8 "Lock"). Two schedulers in a split
// brain double the reads and the writes and spend nothing, because money's
// exclusivity is the vault lease. So the statements are idempotent, and the ones
// that touch vault_work NEVER WAIT FOR A WORKER: they lock the rows they change
// with SKIP LOCKED and leave alone a row a worker holds, so a gate's FOR SHARE,
// a claim or a COMPLETE in flight is skipped this tick and picked up the next,
// rather than holding the scheduler's ONE pooled connection (SCHEDULER_POOL_MAX)
// for as long as a stalled transaction lives.
//
// A DUE TIME ONLY EVER MOVES EARLIER (LEAST). A vault already due keeps its
// place: a scheduler that re-marked every row "due now" on every full pass
// would reset the queue's order every tick, and a vault that had waited longest
// would wait again behind the ones that had just come due. CLAIM takes an
// overdue row by its due time first (src/dispatch-store.ts), so the order kept
// here IS the order the backlog drains in (test/scheduler-pg.test.ts, the
// starvation check under a full-pass backlog).
//
// EVERY TIME IS clock_timestamp(), read in the statement: the database's clock,
// the one the lease statements compare against (ADR §3.5). Times come back as
// milliseconds since the epoch, on that clock.

import pg from "pg";
import { summarizeUpstreamError, type Secret } from "@sip/solana-log";
import { DISPATCH_STATEMENT_TIMEOUT_MS, LANE_PRIORITY, type IntentKind, type Lane } from "./dispatch-store.js";
import { READ_MODEL_SCHEMA, sslFor } from "./read-model.js";

const S = READ_MODEL_SCHEMA;

/** What the scheduler's statements need of a pool: one statement at a time. pg.Pool is one. */
export type SchedulerDb = Pick<pg.Pool, "query">;

/** The two values fleet.new_vault_system takes (plan design detail 3). */
export type VaultSystem = "legacy" | "draining" | "queue";
/** fleet.webhook_owner (plan design detail 2). */
export type WebhookOwner = "legacy" | "scheduler";

/** A listed link, as keeper_link stores it. */
export interface LinkRow {
  readonly link: string;
  readonly wallet: string;
  readonly vault: string;
  readonly epoch: bigint;
  readonly nonce: bigint;
  readonly frontier: bigint;
}

/** What the scheduler reads of a vault's row each tick. Times in ms on the database's clock. */
export interface WorkRow {
  readonly vault: string;
  readonly system: VaultSystem;
  readonly lane: string;
  readonly priority: number;
  readonly rests: boolean;
  /** Held by a worker whose lease still runs. */
  readonly held: boolean;
  readonly parked: boolean;
  readonly fence: bigint;
  readonly bellAt: number | null;
  readonly claimedAt: number | null;
  readonly doneAt: number | null;
  readonly dueAt: number;
  readonly lastOutcome: string | null;
  /** Intents of this vault not yet resolved: a vault with one is never completed by the scheduler. */
  readonly openIntents: number;
}

/** The fleet row, read at the top of a tick. */
export interface FleetRead {
  /** The database's clock, ms. */
  readonly now: number;
  readonly newVaultSystem: VaultSystem;
  readonly webhookOwner: WebhookOwner;
  readonly boardDirtyAt: string | null;
}

/** An intent older than the reap's age whose vault nobody holds. */
export interface StaleIntent {
  readonly id: bigint;
  readonly vault: string;
  readonly kind: IntentKind;
  readonly signature: string | null;
  readonly lastValidBlockHeight: bigint;
}

/** A vault the reap parked. */
export interface ParkedVault {
  readonly vault: string;
  readonly attempts: number;
}

/** The doorbell's evidence in Postgres (src/scheduler.ts, doorbellTrust). Times in ms, database clock. */
export interface HookEvidence {
  /** The newest bell any replica's receiver wrote. */
  readonly lastBellAt: number | null;
  /** The newest echo any replica's receiver marked, among intents created since `since` − an hour. */
  readonly lastEchoAt: number | null;
  /** The newest resolution of a LANDED intent created since `since` that no delivery echoed within ECHO_DEADLINE_MS. */
  readonly deafSince: number | null;
}

/** How long an intent waits before the reap looks at it: ten minutes (ADR §3.8 step 6). */
export const REAP_INTENT_AGE_MINUTES = 10;
/** The most intents one reap reads: they are resolved one statement each. */
export const REAP_INTENT_BATCH = 100;
/** Expiries in a row before a vault is parked (ADR §3.8 step 6). */
export const PARK_AFTER_ATTEMPTS = 5;
/** How long rpc_usage and resolved send_intent rows are kept ([QUEUE] §2.3). */
export const RETENTION_DAYS = 35;
/** The most send_intent rows one prune deletes: the next prune takes the rest. */
export const PRUNE_BATCH = 10_000;

const ms = (column: string): string => `(extract(epoch FROM ${column}) * 1000)::float8`;

/** The fleet row, and the database's own clock. */
export const FLEET_READ_SQL = `SELECT new_vault_system, webhook_owner, board_dirty_at, ${ms("clock_timestamp()")} AS now_ms
  FROM ${S}.fleet WHERE id`;

/**
 * A SUCCESSFUL listing, upserted. A link listed again comes back from gone; its
 * Privy id (C8) and its own-settle memo (C4) are kept. seen_slot never moves
 * backwards: a stale scheduler's late write of an older listing does not
 * overwrite a newer one's state.
 */
export const UPSERT_LINKS_SQL = `INSERT INTO ${S}.keeper_link AS k
  (link_addr, wallet_addr, vault_addr, epoch, settlement_nonce, frontier_slot, seen_slot, seen_at, gone_at)
SELECT l.link, l.wallet, l.vault, l.epoch, l.nonce, l.frontier, $7::bigint, clock_timestamp(), NULL
  FROM unnest($1::text[], $2::text[], $3::text[], $4::bigint[], $5::bigint[], $6::bigint[]) AS l(link, wallet, vault, epoch, nonce, frontier)
ON CONFLICT (link_addr) DO UPDATE SET
  wallet_addr = EXCLUDED.wallet_addr, vault_addr = EXCLUDED.vault_addr, epoch = EXCLUDED.epoch,
  settlement_nonce = EXCLUDED.settlement_nonce, frontier_slot = EXCLUDED.frontier_slot,
  seen_slot = EXCLUDED.seen_slot, seen_at = EXCLUDED.seen_at, gone_at = NULL
 WHERE k.seen_slot <= EXCLUDED.seen_slot`;

/** Every link a SUCCESSFUL listing did not return is gone (an unlink closes the account). */
export const MARK_GONE_SQL = `UPDATE ${S}.keeper_link SET gone_at = clock_timestamp()
 WHERE gone_at IS NULL AND NOT (link_addr = ANY($1::text[]))
RETURNING link_addr`;

/** The last-known-good list: every link not gone. Addresses only are trusted from it (L3's rule). */
export const CACHED_LINKS_SQL = `SELECT link_addr, wallet_addr, vault_addr, epoch, settlement_nonce, frontier_slot,
       ${ms("seen_at")} AS seen_ms
  FROM ${S}.keeper_link WHERE gone_at IS NULL ORDER BY link_addr`;

/**
 * A row for each vault the listing names that has none yet, as the fleet flag
 * says (plan design detail 3): 'legacy' until P3d; then 'draining', NEVER
 * 'queue' — the handover's enrolment rule (src/handover.ts). A legacy keeper
 * that read the flag before it flipped takes a vault with no row for its own,
 * and a row written straight to the queue could be claimed by a worker while
 * that keeper's sweep still turns it; through 'draining' the vault reaches the
 * queue only by `arm`, after every legacy process's receipt and 150 finalized
 * blocks — the operator's, or this scheduler's own under SIP_SOLANA_AUTO_ARM
 * (src/auto-arm.ts). Due now, in the new lane. A vault that has a row keeps it
 * untouched.
 *
 * system_at IS LEFT NULL ON PURPOSE: every handover step stamps it, so a NULL
 * on a draining row is what tells the auto-arm the row is still the scheduler's
 * own enrolment (AUTO_ARMABLE_SQL). The insert writes no mode byte.
 */
export const ENSURE_VAULTS_SQL = `INSERT INTO ${S}.vault_work (vault_addr, system, lane, priority, due_at)
SELECT v.vault, CASE f.new_vault_system WHEN 'queue' THEN 'draining' ELSE 'legacy' END, 'new', ${LANE_PRIORITY.new}, clock_timestamp()
  FROM unnest($1::text[]) AS v(vault) CROSS JOIN ${S}.fleet f
 WHERE f.id
ON CONFLICT (vault_addr) DO NOTHING
RETURNING vault_addr, system`;

/** The rows of the vaults named, with their open intents, and the database's clock. */
export const READ_WORK_SQL = `WITH t AS (SELECT clock_timestamp() AS now)
SELECT w.vault_addr, w.system, w.lane, w.priority, w.rests,
       (w.holder IS NOT NULL AND w.lease_until >= t.now) AS held,
       (w.parked_reason IS NOT NULL) AS parked, w.fence,
       ${ms("w.bell_at")} AS bell_ms, ${ms("w.claimed_at")} AS claimed_ms, ${ms("w.last_done_at")} AS done_ms,
       ${ms("w.due_at")} AS due_ms, w.last_outcome, coalesce(o.open, 0)::int AS open_intents, ${ms("t.now")} AS now_ms
  FROM ${S}.vault_work w CROSS JOIN t
  LEFT JOIN (SELECT vault_addr, count(*) AS open FROM ${S}.send_intent WHERE resolved_at IS NULL GROUP BY vault_addr) o
         ON o.vault_addr = w.vault_addr
 WHERE w.vault_addr = ANY($1::text[])`;

/**
 * THE SELECTION, MADE DUE. Only rows of the queue, not parked, and free (or
 * with a lapsed lease): a held row's next due time is its COMPLETE's to write.
 * Rows a worker has locked are skipped (SKIP LOCKED) and re-marked next tick.
 *
 *   * due_at only moves EARLIER (the header): now, or — for a bell, whether
 *     this selection's or one the receiver already wrote on the row — no sooner
 *     than BELL_DELAY_MS after it rang, the finality the walk needs;
 *   * the lane and priority are the selection's, unless the row already holds a
 *     more urgent one that is still pending — due now, or the receiver's bell
 *     waiting out its delay: a full pass never demotes a bell to the back of
 *     the line.
 *
 * $1 vaults, $2 lanes, $3 priorities, $4 the bell delay in seconds.
 */
export const MARK_DUE_SQL = `WITH u AS (SELECT * FROM unnest($1::text[], $2::text[], $3::smallint[]) AS u(vault, lane, priority)),
t AS (SELECT clock_timestamp() AS now),
c AS (
  SELECT w.vault_addr FROM ${S}.vault_work w JOIN u ON u.vault = w.vault_addr
   WHERE w.system = 'queue' AND w.parked_reason IS NULL AND (w.holder IS NULL OR w.lease_until < clock_timestamp())
   FOR UPDATE OF w SKIP LOCKED)
UPDATE ${S}.vault_work w
   SET due_at = LEAST(w.due_at, CASE WHEN (u.lane = 'bell' OR w.lane = 'bell') AND w.bell_at IS NOT NULL
                                     THEN GREATEST(t.now, w.bell_at + make_interval(secs => $4::double precision))
                                     ELSE t.now END),
       lane = CASE WHEN w.priority < u.priority AND (w.due_at <= t.now OR w.lane = 'bell') THEN w.lane ELSE u.lane END,
       priority = CASE WHEN w.priority < u.priority AND (w.due_at <= t.now OR w.lane = 'bell') THEN w.priority ELSE u.priority END
  FROM u, t, c
 WHERE w.vault_addr = u.vault AND c.vault_addr = w.vault_addr
RETURNING w.vault_addr`;

/**
 * THE SCHEDULER'S OWN COMPLETION (C7, ADR §3.8 step 3): a vault the batch read
 * showed has nothing to do — its wallets did not move, its invest half rests
 * on the snapshot — is completed here, at no worker job's cost: resting, in the
 * safety lane, due again after the safety pass ($4 seconds).
 *
 * ONLY IF THE ROW IS AS THE TICK READ IT: the same fence (no claim since) and
 * the same bell (none rang since), free, resting, on the queue, not parked. A
 * vault that changed under the tick is left for the next one. Fence, holder,
 * lease and attempts are not touched.
 *
 * $1 vaults, $2 the fences read, $3 the bells read (ms, NaN for none), $4 the pass in seconds, $5 the detail.
 */
export const SCHEDULER_COMPLETE_SQL = `WITH u AS (SELECT * FROM unnest($1::text[], $2::bigint[], $3::float8[]) AS u(vault, fence, bell_ms)),
c AS (
  SELECT w.vault_addr FROM ${S}.vault_work w JOIN u ON u.vault = w.vault_addr
   WHERE w.system = 'queue' AND w.parked_reason IS NULL AND w.holder IS NULL AND w.rests
     AND w.fence = u.fence
     AND coalesce(${ms("w.bell_at")}, 'NaN'::float8) = u.bell_ms
   FOR UPDATE OF w SKIP LOCKED)
UPDATE ${S}.vault_work w
   SET lane = 'safety', priority = ${LANE_PRIORITY.safety}, rests = true, last_outcome = 'IDLE', last_detail = $5,
       last_done_at = clock_timestamp(), due_at = clock_timestamp() + make_interval(secs => $4::double precision)
  FROM u, c
 WHERE w.vault_addr = u.vault AND c.vault_addr = w.vault_addr
RETURNING w.vault_addr`;

/**
 * A queue vault that no live link names any more is never due: a job for it
 * would settle nobody and buy with a vault the legacy keepers never turned
 * either (they turn links). Its row stays — it holds the vault's fence — and a
 * link that appears again brings it back through the selection's new lane.
 * Only after a SUCCESSFUL listing ($1: the vaults it named).
 */
export const RETIRE_UNLINKED_SQL = `UPDATE ${S}.vault_work SET due_at = 'infinity'
 WHERE system = 'queue' AND holder IS NULL AND due_at <> 'infinity' AND NOT (vault_addr = ANY($1::text[]))
RETURNING vault_addr`;

/** The tick, written by the lock holder: who, when, and — after a successful listing — the discovery's time. */
export const WRITE_TICK_SQL = `UPDATE ${S}.fleet
   SET scheduler_id = $1, tick_at = clock_timestamp(),
       discovery_ok_at = CASE WHEN $2::boolean THEN clock_timestamp() ELSE discovery_ok_at END
 WHERE id`;

/**
 * THE REAP'S PARKING (ADR §3.8 step 6): a vault held under a lapsed lease after
 * PARK_AFTER_ATTEMPTS claims in a row that never completed. CLAIM skips it until
 * an operator clears parked_reason; its open intents wait for the claim after.
 */
export const PARK_SQL = `UPDATE ${S}.vault_work
   SET parked_reason = 'its lease lapsed ' || attempts || ' claims in a row without a completion: a job that never ends; ' ||
                       'parked by the scheduler until an operator clears parked_reason'
 WHERE holder IS NOT NULL AND lease_until < clock_timestamp() AND attempts >= $1 AND parked_reason IS NULL
RETURNING vault_addr, attempts`;

/**
 * The reap's intents (ADR §3.8 step 6): unresolved, older than
 * REAP_INTENT_AGE_MINUTES, on a vault nobody holds now — the ones no job is
 * resolving. The takeover rule is the worker's; the reap resolves only what the
 * chain settles without a link read (src/scheduler.ts).
 */
export const STALE_INTENTS_SQL = `SELECT s.id, s.vault_addr, s.kind, s.signature, s.last_valid_block_height
  FROM ${S}.send_intent s JOIN ${S}.vault_work w ON w.vault_addr = s.vault_addr
 WHERE s.resolved_at IS NULL AND s.created_at < clock_timestamp() - make_interval(mins => $1::int)
   AND (w.holder IS NULL OR w.lease_until < clock_timestamp())
 ORDER BY s.id
 LIMIT $2`;

/** Resolved intents past the retention, a batch at a time. An open intent is never pruned. */
export const PRUNE_INTENTS_SQL = `DELETE FROM ${S}.send_intent WHERE id IN (
  SELECT id FROM ${S}.send_intent
   WHERE resolved_at IS NOT NULL AND created_at < clock_timestamp() - make_interval(days => $1::int)
   ORDER BY id LIMIT $2)`;

/**
 * The doorbell's evidence ($1 = the takeover, ms on the database's clock; $2 the
 * echo deadline in seconds). The echo is looked for only among intents created
 * within the hour before the takeover or since: send_intent_created keeps that
 * an index read.
 */
export const HOOK_EVIDENCE_SQL = `WITH since AS (SELECT to_timestamp($1::float8 / 1000.0) AS at)
SELECT (SELECT ${ms("max(w.bell_at)")} FROM ${S}.vault_work w) AS last_bell_ms,
       (SELECT ${ms("max(s.echoed_at)")} FROM ${S}.send_intent s, since
         WHERE s.created_at > since.at - interval '1 hour' AND s.echoed_at IS NOT NULL) AS last_echo_ms,
       (SELECT ${ms("max(s.resolved_at)")} FROM ${S}.send_intent s, since
         WHERE s.created_at > since.at AND s.state = 'landed' AND s.echoed_at IS NULL
           AND s.resolved_at < clock_timestamp() - make_interval(secs => $2::double precision)) AS deaf_since_ms`;

const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
const big = (value: unknown): bigint => BigInt(String(value));

/** The scheduler's statements, on its pool (the ONE connection of createDispatchPool(…, "scheduler")). */
export class PgSchedulerStore {
  readonly #db: SchedulerDb;

  constructor(db: SchedulerDb) {
    this.#db = db;
  }

  async readFleet(): Promise<FleetRead> {
    const row = (await this.#db.query(FLEET_READ_SQL)).rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) throw new Error("the fleet row is missing: apply sql/sip_solana.sql with setup-read-model");
    return {
      now: Number(row["now_ms"]),
      newVaultSystem: String(row["new_vault_system"]) as VaultSystem,
      webhookOwner: String(row["webhook_owner"]) as WebhookOwner,
      boardDirtyAt: row["board_dirty_at"] === null || row["board_dirty_at"] === undefined ? null : new Date(row["board_dirty_at"] as string).toISOString(),
    };
  }

  async upsertLinks(links: readonly LinkRow[], seenSlot: number): Promise<number> {
    if (links.length === 0) return 0;
    const result = await this.#db.query(UPSERT_LINKS_SQL, [
      links.map((l) => l.link),
      links.map((l) => l.wallet),
      links.map((l) => l.vault),
      links.map((l) => l.epoch.toString()),
      links.map((l) => l.nonce.toString()),
      links.map((l) => l.frontier.toString()),
      String(seenSlot),
    ]);
    return result.rowCount ?? 0;
  }

  async markGone(listed: readonly string[]): Promise<readonly string[]> {
    const result = await this.#db.query(MARK_GONE_SQL, [[...listed]]);
    return result.rows.map((row: Record<string, unknown>) => String(row["link_addr"]));
  }

  async cachedLinks(): Promise<{ readonly links: readonly LinkRow[]; readonly newestSeenAt: number | null }> {
    const result = await this.#db.query(CACHED_LINKS_SQL);
    let newest: number | null = null;
    const links = result.rows.map((row: Record<string, unknown>) => {
      const seen = num(row["seen_ms"]);
      if (seen !== null && (newest === null || seen > newest)) newest = seen;
      return {
        link: String(row["link_addr"]),
        wallet: String(row["wallet_addr"]),
        vault: String(row["vault_addr"]),
        epoch: big(row["epoch"]),
        nonce: big(row["settlement_nonce"]),
        frontier: big(row["frontier_slot"]),
      };
    });
    return { links, newestSeenAt: newest };
  }

  async ensureVaults(vaults: readonly string[]): Promise<readonly { readonly vault: string; readonly system: VaultSystem }[]> {
    if (vaults.length === 0) return [];
    const result = await this.#db.query(ENSURE_VAULTS_SQL, [[...new Set(vaults)]]);
    return result.rows.map((row: Record<string, unknown>) => ({ vault: String(row["vault_addr"]), system: String(row["system"]) as VaultSystem }));
  }

  async readWork(vaults: readonly string[]): Promise<{ readonly now: number | null; readonly rows: readonly WorkRow[] }> {
    if (vaults.length === 0) return { now: null, rows: [] };
    const result = await this.#db.query(READ_WORK_SQL, [[...new Set(vaults)]]);
    let now: number | null = null;
    const rows = result.rows.map((row: Record<string, unknown>) => {
      now = num(row["now_ms"]);
      return {
        vault: String(row["vault_addr"]),
        system: String(row["system"]) as VaultSystem,
        lane: String(row["lane"]),
        priority: Number(row["priority"]),
        rests: row["rests"] === true,
        held: row["held"] === true,
        parked: row["parked"] === true,
        fence: big(row["fence"]),
        bellAt: num(row["bell_ms"]),
        claimedAt: num(row["claimed_ms"]),
        doneAt: num(row["done_ms"]),
        dueAt: Number(row["due_ms"]),
        lastOutcome: row["last_outcome"] === null || row["last_outcome"] === undefined ? null : String(row["last_outcome"]),
        openIntents: Number(row["open_intents"]),
      };
    });
    return { now, rows };
  }

  /** Makes the selection due; answers the vaults it changed. */
  async markDue(entries: readonly { readonly vault: string; readonly lane: Lane }[], bellDelayMs: number): Promise<readonly string[]> {
    if (entries.length === 0) return [];
    const result = await this.#db.query(MARK_DUE_SQL, [
      entries.map((e) => e.vault),
      entries.map((e) => e.lane),
      entries.map((e) => LANE_PRIORITY[e.lane]),
      bellDelayMs / 1000,
    ]);
    return result.rows.map((row: Record<string, unknown>) => String(row["vault_addr"]));
  }

  /** The scheduler's own completion (C7); answers the vaults it completed. */
  async completeIdle(
    entries: readonly { readonly vault: string; readonly fence: bigint; readonly bellAt: number | null }[],
    dueInMs: number,
    detail: string,
  ): Promise<readonly string[]> {
    if (entries.length === 0) return [];
    const result = await this.#db.query(SCHEDULER_COMPLETE_SQL, [
      entries.map((e) => e.vault),
      entries.map((e) => e.fence.toString()),
      entries.map((e) => (e.bellAt === null ? "NaN" : String(e.bellAt))),
      dueInMs / 1000,
      detail,
    ]);
    return result.rows.map((row: Record<string, unknown>) => String(row["vault_addr"]));
  }

  async retireUnlinked(listedVaults: readonly string[]): Promise<readonly string[]> {
    const result = await this.#db.query(RETIRE_UNLINKED_SQL, [[...new Set(listedVaults)]]);
    return result.rows.map((row: Record<string, unknown>) => String(row["vault_addr"]));
  }

  async writeTick(schedulerId: string, discoveryOk: boolean): Promise<void> {
    await this.#db.query(WRITE_TICK_SQL, [schedulerId, discoveryOk]);
  }

  async park(): Promise<readonly ParkedVault[]> {
    const result = await this.#db.query(PARK_SQL, [PARK_AFTER_ATTEMPTS]);
    return result.rows.map((row: Record<string, unknown>) => ({ vault: String(row["vault_addr"]), attempts: Number(row["attempts"]) }));
  }

  async staleIntents(): Promise<readonly StaleIntent[]> {
    const result = await this.#db.query(STALE_INTENTS_SQL, [REAP_INTENT_AGE_MINUTES, REAP_INTENT_BATCH]);
    return result.rows.map((row: Record<string, unknown>) => ({
      id: big(row["id"]),
      vault: String(row["vault_addr"]),
      kind: String(row["kind"]) as IntentKind,
      signature: row["signature"] === null || row["signature"] === undefined ? null : String(row["signature"]),
      lastValidBlockHeight: big(row["last_valid_block_height"]),
    }));
  }

  async pruneIntents(): Promise<number> {
    const result = await this.#db.query(PRUNE_INTENTS_SQL, [RETENTION_DAYS, PRUNE_BATCH]);
    return result.rowCount ?? 0;
  }

  async hookEvidence(sinceMs: number, echoDeadlineMs: number): Promise<HookEvidence> {
    const row = (await this.#db.query(HOOK_EVIDENCE_SQL, [sinceMs, echoDeadlineMs / 1000])).rows[0] as Record<string, unknown> | undefined;
    return { lastBellAt: num(row?.["last_bell_ms"]), lastEchoAt: num(row?.["last_echo_ms"]), deafSince: num(row?.["deaf_since_ms"]) };
  }
}

/** Every column the statements above name that Q1's schema may lack on an old database: the boot check's list. */
export const SCHEDULER_COLUMNS = {
  keeper_link: ["link_addr", "wallet_addr", "vault_addr", "epoch", "settlement_nonce", "frontier_slot", "seen_slot", "seen_at", "gone_at"],
  vault_work: ["vault_addr", "system", "lane", "priority", "due_at", "rests", "bell_at", "holder", "fence", "lease_until", "claimed_at", "attempts", "last_outcome", "last_detail", "last_done_at", "parked_reason"],
  send_intent: ["id", "vault_addr", "kind", "signature", "last_valid_block_height", "state", "created_at", "resolved_at", "echoed_at"],
  fleet: ["id", "scheduler_id", "tick_at", "discovery_ok_at", "board_dirty_at", "new_vault_system", "webhook_owner"],
} as const satisfies Record<string, readonly string[]>;

/** The `table.column` pairs of SCHEDULER_COLUMNS this database lacks: refused by name at boot, before a tick is lost to one. */
export async function missingSchedulerColumns(db: SchedulerDb): Promise<string[]> {
  const result = await db.query(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = ANY($2::text[])`,
    [S, Object.keys(SCHEDULER_COLUMNS)],
  );
  const have = new Set(result.rows.map((row: Record<string, unknown>) => `${String(row["table_name"])}.${String(row["column_name"])}`));
  const missing: string[] = [];
  for (const [table, columns] of Object.entries(SCHEDULER_COLUMNS)) {
    for (const column of columns) if (!have.has(`${table}.${column}`)) missing.push(`${table}.${column}`);
  }
  return missing;
}

// ── the lock ─────────────────────────────────────────────────────────────────

/** What a tick learns from the lock. */
export type LockState = "took" | "held" | "standby" | "lost";

/** The scheduler's lock: taken, verified and released by the tick (src/scheduler.ts). */
export interface SchedulerLock {
  readonly held: boolean;
  /** Takes the lock if free, or checks that the session holding it is alive. Never throws. */
  ensure(): Promise<LockState>;
  /** Gives it up: the session that holds it is closed. */
  release(): void;
}

/** What the lock needs of a client: pg.Client is one. */
export interface LockClient {
  connect(): Promise<unknown>;
  query(text: string, values?: unknown[]): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
  end(): Promise<void>;
  on(event: "error", listener: (error: Error) => void): unknown;
}

/**
 * The advisory lock `sip-solana-scheduler`, on a CONNECTION OF ITS OWN, outside
 * the pool: ADR §3.11's "1 pinned on the lock-holding scheduler". A session lock
 * lives on the session, so the holder keeps that one client open for as long as
 * it schedules; the pool's one connection stays free for the statements.
 *
 * A STANDBY OPENS A CLIENT ONLY TO ASK, once a tick, and closes it when the
 * answer is no: its steady connection count is its pool's one, and the attempt
 * adds one for a few milliseconds a minute.
 *
 * THE HOLDER CHECKS ITS SESSION EVERY TICK (SELECT 1 on that client, bounded by
 * the statement timeout): a session the server dropped, or a socket that went
 * quiet, is a lock this process no longer holds, and another scheduler may
 * already have it. The client's 'error' event says the same thing sooner. Either
 * way the client is closed and the tick runs as a standby; the next tick asks
 * again — and a holder that regains the lock starts over with a full pass.
 */
export class PgSchedulerLock implements SchedulerLock {
  readonly #connect: () => LockClient;
  readonly #key: bigint;
  readonly #onLost: (detail: string) => void;
  #client: LockClient | null = null;
  #lost: string | null = null;

  constructor(options: { readonly client: () => LockClient; readonly key: bigint; readonly onLost?: (detail: string) => void }) {
    this.#connect = options.client;
    this.#key = options.key;
    this.#onLost = options.onLost ?? (() => undefined);
  }

  get held(): boolean {
    return this.#client !== null && this.#lost === null;
  }

  async ensure(): Promise<LockState> {
    if (this.#client !== null) {
      if (this.#lost === null) {
        try {
          await this.#client.query("SELECT 1");
          return "held";
        } catch (error) {
          this.#lost = summarizeUpstreamError(error);
        }
      }
      const detail = this.#lost;
      this.#drop();
      this.#onLost(detail ?? "the lock's session failed");
      return "lost";
    }
    const client = this.#connect();
    // A CLIENT THAT ERRORS WITH NOBODY LISTENING ENDS THE PROCESS: listened to
    // from before it connects, for as long as it lives.
    client.on("error", (error) => {
      if (this.#client === client && this.#lost === null) this.#lost = summarizeUpstreamError(error);
    });
    try {
      await client.connect();
      const result = await client.query("SELECT pg_try_advisory_lock($1) AS locked", [this.#key.toString()]);
      if (result.rows[0]?.["locked"] === true) {
        this.#client = client;
        this.#lost = null;
        return "took";
      }
    } catch {
      // Not asked, or not answered: not granted. The next tick asks again.
    }
    void client.end().catch(() => undefined);
    return "standby";
  }

  release(): void {
    this.#drop();
  }

  #drop(): void {
    const client = this.#client;
    this.#client = null;
    this.#lost = null;
    // ENDING THE SESSION IS THE RELEASE: a session lock goes with its session.
    if (client !== null) void client.end().catch(() => undefined);
  }
}

/** A dedicated client for the lock, bounded like the pool's statements (createDispatchPool). */
export function schedulerLockClient(databaseUrl: Secret, applicationName: string): LockClient {
  const connectionString = databaseUrl.reveal();
  return new pg.Client({
    connectionString,
    ssl: sslFor(connectionString),
    connectionTimeoutMillis: DISPATCH_STATEMENT_TIMEOUT_MS,
    statement_timeout: DISPATCH_STATEMENT_TIMEOUT_MS,
    query_timeout: DISPATCH_STATEMENT_TIMEOUT_MS,
    keepAlive: true,
    application_name: applicationName,
  });
}
