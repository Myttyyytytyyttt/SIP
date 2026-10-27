// THE TWO-STEP HANDOVER: how a vault moves between the legacy keepers and the
// dispatcher's queue (dispatcher ADR §3.12, RT-4; plan P3c step 2, P3d; the
// queue section §2.14).
//
//   legacy ──drain──▶ draining ──arm (twice: record a height, then 150 blocks)──▶ queue
//   queue ──rollback──▶ draining ──release (no holder, every intent dead)──▶ legacy
//
// WHY TWO STEPS. The two sides hold different advisory locks
// (sip-solana-keeper / -volume-keeper and sip-solana-scheduler), which do not
// exclude each other; only this does. A vault is first taken away from its
// outgoing actor, and the incoming one is armed only once nothing the outgoing
// one signed can still land.
//
// THE EVIDENCE IS THE LEGACY KEEPERS' OWN RECEIPTS, not a clock. Every legacy
// process running with SIP_SOLANA_DISPATCH writes, in the very statement that
// reads its selection, the map of vaults it just read as not its own
// (legacy_process.seen; src/dispatch-select.ts says why that proves its earlier
// sweeps are over). `arm` refuses while:
//   * any process row not marked gone has not read the vault as not its own —
//     the "wait until the old container is gone" of ADR §3.12, made checkable:
//     an old container that is really gone is marked so by the operator, after
//     checking Railway (`gone`), and one still running reads again within a
//     sweep, which clears the mark;
//   * a required role (both legacy roles, by default) has no such row that read
//     within LEGACY_READ_FRESH_MS and was ACTING at that read — the one check
//     that catches an old container still holding the claim without the
//     variable, which writes no row at all (`allowDry` lifts it, for a drill
//     where no keeper is armed);
//   * any row holds a loss carry for the vault only in memory (carry_vaults):
//     under SIP_SOLANA_CARRY_STORE=off every carry, and under `dual` one whose
//     Postgres write failed (src/carry-store.ts, memoryOnlyLinks).
// Then the first `arm` records the PROCESSED block height — at or above the
// height behind any blockhash a legacy keeper could have signed with before its
// receipt — and a later one moves the vault to the queue only once the FINALIZED
// height is more than HANDOVER_WAIT_BLOCKS past it: every such transaction is
// expired, or final and visible to the worker's first read. A blocker that
// appears during the wait clears the recorded height, and the wait starts again.
//
// BACK THE OTHER WAY, THE EVIDENCE IS THE QUEUE'S: `rollback` stops new claims
// (CLAIM takes only 'queue'); `release` gives the vault to the legacy keepers
// only once no worker can gate a send for it — no holder, or a holder whose lease
// has run out past the 6-minute job ceiling, which no heartbeat renews — and the
// finalized height has passed every intent's last height
// (max COALESCE(resolved_height, last_valid_block_height), the store's own plan
// floor). The legacy keeper has no gate of its own, so it waits as a worker would.
// AND THE LOSSES THE WORKERS CARRIED STAY NETTED: a worker writes each PROFIT
// carry into sip_solana.loss_carry inside its settle's gate, and nowhere else. A
// legacy profit keeper under SIP_SOLANA_CARRY_STORE=off never reads that table,
// and under `dual` reads it once, at boot — a row a worker wrote after that is not
// in its memory — so either would charge the link's next win whole, the
// over-charge the table exists to prevent. So while a worker's carry for one of
// the vault's links can still match (WORKER_CARRIES_SQL), `release` refuses until
// every profit receipt not marked gone says `on` (legacy_process.carry_store),
// which reads the store on every turn, and one of them read within
// LEGACY_READ_FRESH_MS.
//
// NO PUSH WHILE A HANDOVER IS OPEN (ADR §6.1 rule 5): a push restarts every
// keeper service, and a new container is a new row the open handover must see.
//
// THE SCHEDULER'S OWN ENROLMENTS ARE ARMED BY THE SCHEDULER, AND NOTHING ELSE
// IS (src/auto-arm.ts, SIP_SOLANA_AUTO_ARM). Under new_vault_system = 'queue'
// the scheduler enrols a new vault as 'draining' (ENSURE_VAULTS_SQL,
// src/scheduler-pg.ts) and, with the variable on, calls `arm` on it each tick
// until it moves — the same `arm`, receipts and 150 blocks included, with one
// more refusal (`enrolledOnly`): the row must still be exactly as the
// enrolment left it (AUTO_ARMABLE_SQL), checked under the row's lock. Every
// step here stamps system_at — drain, the move of `arm`, rollback, release —
// and ENSURE_VAULTS_SQL does not, so a vault an operator drained, rolled back
// or released is never armed by the scheduler: its handover is the operator's
// to finish. A claim raises the fence and a lease sets the holder, so a vault a
// worker ever took is not one either.
//
// DARK. Only the dispatcher's entry points load this file: bin/dispatch-handover.mts
// (an operator's command, never started by production) and bin/scheduler.mts,
// for the auto-arm step and nothing else (test/dispatch-dark.test.ts). Every
// statement is on the database's clock.

import { READ_MODEL_SCHEMA } from "./read-model.js";
import type { NewVaultSystem, VaultSystem } from "./dispatch-select.js";
import { KEEPER_ROLES, isKeeperRole, roleCarriesLosses, type KeeperRole } from "./role-registry.js";

const S = READ_MODEL_SCHEMA;

/** A blockhash is valid for 150 blocks past the height it was fetched at (Solana's lastValidBlockHeight). */
export const HANDOVER_WAIT_BLOCKS = 150n;

/**
 * How recent a legacy process's read must be to count for its role: 15 minutes,
 * which is three sweeps of the longest interval the credit-burn lever sets
 * (SIP_SOLANA_SWEEP_MS = 300000), and above /health's 10-minute bound.
 */
export const LEGACY_READ_FRESH_MS = 15 * 60_000;

/**
 * The job ceiling past which no heartbeat renews a lease (dispatch-store.ts's
 * JOB_CEILING_MINUTES, redeclared because no src/ file may import the store;
 * test/dispatch-select-pg.test.ts holds the two equal).
 */
export const RELEASE_JOB_CEILING_MINUTES = 6;

/**
 * A ROW THE SCHEDULER ENROLLED AND NOBODY HAS TOUCHED SINCE: the only rows the
 * scheduler's auto-arm may arm (the header). A vault_work condition over the
 * row's own columns, unqualified, so the auto-arm's selection and `arm`'s
 * locked read (VAULT_FOR_UPDATE_SQL, under `enrolledOnly`) are the same words.
 *
 *   * draining — what ENSURE_VAULTS_SQL writes under new_vault_system = 'queue';
 *   * system_at IS NULL — every handover step stamps it, the enrolment does not;
 *   * fence = 0 — no worker ever claimed it (a claim is the only thing that raises it);
 *   * holder IS NULL — nobody holds it now.
 */
export const AUTO_ARMABLE_SQL = "system = 'draining' AND system_at IS NULL AND fence = 0 AND holder IS NULL";

/** AUTO_ARMABLE_SQL over a row already read: the unit tests' mirror of the statement. */
export function autoArmable(row: { readonly system: string; readonly systemAt: unknown; readonly fence: bigint | number | string; readonly holder: string | null }): boolean {
  return row.system === "draining" && (row.systemAt === null || row.systemAt === undefined) && BigInt(row.fence) === 0n && row.holder === null;
}

/**
 * THE LEGACY ROLES WHOSE ACTING RECEIPT `arm` REQUIRES, from one string: the
 * command line's --roles= and the scheduler's SIP_SOLANA_LEGACY_ROLES read it
 * alike. A comma-separated list of roles, each once, or `none` SPELLED OUT: no
 * role's receipt is required, which is right only where no legacy keeper acts —
 * a shadow's database, or a fleet whose legacy keeper services are stopped.
 * Every receipt that IS there still has to name the vault. null: refused.
 */
export function parseLegacyRoles(value: string): readonly KeeperRole[] | null {
  if (value === "none") return [];
  const roles = value.split(",").map((role) => role.trim());
  if (roles.some((role) => !isKeeperRole(role)) || new Set(roles).size !== roles.length) return null;
  return roles as KeeperRole[];
}

/** What reading the two heights needs of a chain: @solana/web3.js's Connection is one. */
export interface BlockHeightReader {
  getBlockHeight(commitment: "processed" | "finalized"): Promise<number>;
}

/**
 * THE TWO HEIGHTS A STEP IS TAKEN AGAINST, read only — the operator's command
 * and the scheduler's auto-arm read them this one way. PROCESSED FIRST: it is
 * the height a step records, and it must be at or above any height a legacy
 * keeper fetched a blockhash at before its receipt. A processed height BELOW the
 * finalized one is two endpoints out of step (a failover between the reads),
 * and nothing is recorded from it.
 */
export async function readChainHeights(chain: BlockHeightReader): Promise<ChainHeights> {
  const processed = BigInt(await chain.getBlockHeight("processed"));
  const finalized = BigInt(await chain.getBlockHeight("finalized"));
  if (processed < finalized) {
    throw new Error(`the chain answered a processed height (${processed}) below its finalized one (${finalized}): two endpoints out of step; nothing is recorded from it`);
  }
  return { processed, finalized };
}

/**
 * THE OPERATOR'S UNPARK (src/scheduler-pg.ts parks a vault whose lease lapsed
 * PARK_AFTER_ATTEMPTS claims in a row): parked_reason cleared, the streak of
 * lapsed claims back to 0, and the vault due now — never later than it already
 * was. Only a parked row; holder, lease and fence are the claim's and are not
 * touched (a lapsed holder is taken over by the next CLAIM). Answers what it
 * cleared.
 */
export const UNPARK_SQL = `WITH prior AS (SELECT vault_addr, parked_reason, attempts FROM ${S}.vault_work WHERE vault_addr = $1)
UPDATE ${S}.vault_work w
   SET parked_reason = NULL, attempts = 0, due_at = LEAST(w.due_at, clock_timestamp())
  FROM prior
 WHERE w.vault_addr = prior.vault_addr AND w.parked_reason IS NOT NULL
RETURNING prior.parked_reason AS was_reason, prior.attempts AS was_attempts`;

export const DRAIN_SQL = `INSERT INTO ${S}.vault_work AS w (vault_addr, system, system_at) VALUES ($1, 'draining', clock_timestamp())
ON CONFLICT (vault_addr) DO UPDATE SET system = 'draining', system_at = clock_timestamp(), handover_height = NULL
 WHERE w.system = 'legacy'
RETURNING system`;

export const ROLLBACK_SQL = `UPDATE ${S}.vault_work SET system = 'draining', system_at = clock_timestamp(), handover_height = NULL
 WHERE vault_addr = $1 AND system = 'queue'
RETURNING system`;

export const VAULT_FOR_UPDATE_SQL = `SELECT system, handover_height, holder, lease_until,
       holder IS NOT NULL AND lease_until < clock_timestamp()
         AND claimed_at < clock_timestamp() - interval '${RELEASE_JOB_CEILING_MINUTES} minutes' AS holder_dead,
       (${AUTO_ARMABLE_SQL}) AS auto_armable
  FROM ${S}.vault_work WHERE vault_addr = $1 FOR UPDATE`;

const RECEIPTS_SQL = `SELECT process_id, role, deployment, host, live, read_at,
       seen ? $1 AS saw, $1 = ANY(carry_vaults) AS carry,
       round(extract(epoch FROM clock_timestamp() - read_at) * 1000)::bigint AS age_ms
  FROM ${S}.legacy_process WHERE gone_at IS NULL ORDER BY role, read_at DESC, process_id`;

const INTENT_FLOOR_SQL = `SELECT max(COALESCE(resolved_height, last_valid_block_height)) AS floor
  FROM ${S}.send_intent WHERE vault_addr = $1`;

/**
 * THE LOSS CARRIES A WORKER WROTE for the vault's links that may still be netted.
 * written_fence is set only inside a settle's gate (src/dispatch-store.ts); L2's
 * rows leave it NULL. The links are the scheduler's listing (keeper_link), the
 * same rows a job takes its links from. A row whose (epoch, settlement nonce) is
 * BELOW the state that listing last saw for its link can never match again — the
 * epoch is the link's creation slot, so a relink only raises it, and the nonce
 * only grows within an epoch — and is skipped; every other row counts, so a
 * listing that lags errs towards refusing.
 */
export const WORKER_CARRIES_SQL = `SELECT c.link_addr, c.epoch, c.settlement_nonce, c.frontier_slot, c.loss_lamports, c.written_fence
  FROM ${S}.loss_carry c JOIN ${S}.keeper_link k ON k.link_addr = c.link_addr
 WHERE k.vault_addr = $1 AND c.written_fence IS NOT NULL
   AND (c.epoch, c.settlement_nonce) >= (k.epoch, k.settlement_nonce)
 ORDER BY c.link_addr, c.epoch, c.settlement_nonce, c.frontier_slot`;

/** The legacy processes of the roles that carry losses, not marked gone, with the carry store each said it runs. */
const CARRY_READERS_SQL = `SELECT process_id, role, deployment, host, live, read_at, carry_store,
       round(extract(epoch FROM clock_timestamp() - read_at) * 1000)::bigint AS age_ms
  FROM ${S}.legacy_process WHERE gone_at IS NULL AND role = ANY($1::text[]) ORDER BY role, read_at DESC, process_id`;

export interface HandoverClient {
  query(text: string, values?: unknown[]): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
  release(destroy?: boolean): void;
}

export interface HandoverPool {
  connect(): Promise<HandoverClient>;
}

/** Block heights read from the chain right before a step: `processed` to record, `finalized` to wait on. */
export interface ChainHeights {
  readonly processed: bigint;
  readonly finalized: bigint;
}

export interface Step {
  readonly vault: string;
  /** The vault's system after the step, or null when vault_work has no row for it. */
  readonly system: VaultSystem | null;
  /** Whether this call moved the vault to a new system. */
  readonly moved: boolean;
  /** Why it did not (or cannot yet), each a sentence an operator can act on. */
  readonly blockers: readonly string[];
  /** Waiting out the blocks: the vault moves once the finalized height is ABOVE this. */
  readonly waitUntilFinalizedAbove?: bigint;
}

export interface LegacyProcessRow {
  readonly processId: string;
  readonly role: string;
  readonly dispatch: string;
  readonly deployment: string | null;
  readonly host: string | null;
  readonly live: boolean;
  readonly reads: bigint;
  readonly readAt: string;
  readonly ageMs: number;
  readonly startedAt: string;
  readonly goneAt: string | null;
  readonly notLegacy: Readonly<Record<string, string>>;
  readonly absentIs: string;
  readonly carryVaults: readonly string[];
  /** SIP_SOLANA_CARRY_STORE at its last read; null for a row written before the column existed. */
  readonly carryStore: string | null;
}

/** One vault_work row as `status` prints it. Every field after leaseUntil was added for `status --all`, and is printed by plain `status` too. */
export interface HandoverVaultRow {
  readonly vault: string;
  readonly system: VaultSystem;
  readonly systemAt: string | null;
  readonly handoverHeight: bigint | null;
  readonly holder: string | null;
  readonly leaseUntil: string | null;
  /** The last mode byte the enrolment wrote, or null (the scheduler's enrolment writes none). */
  readonly skimMode: number | null;
  readonly lane: string;
  /** A bigint in the database, printed as its decimal string. */
  readonly fence: string;
  readonly claimedAt: string | null;
  readonly lastDoneAt: string | null;
  readonly lastOutcome: string | null;
  /** The first STATUS_DETAIL_CHARS characters. */
  readonly lastDetail: string | null;
  readonly parkedReason: string | null;
  readonly attempts: number;
  /** ISO, or "infinity" for a queue vault no live link names (RETIRE_UNLINKED_SQL). */
  readonly dueAt: string | null;
  readonly streaks: Readonly<Record<string, unknown>>;
}

export interface HandoverStatus {
  readonly newVaultSystem: NewVaultSystem | null;
  /** fleet.webhook_owner: who keeps the Helius webhook, 'legacy' or 'scheduler'. */
  readonly webhookOwner: string | null;
  readonly vaults: readonly HandoverVaultRow[];
  readonly processes: readonly LegacyProcessRow[];
}

/** What `unpark` did. */
export interface Unparked {
  readonly vault: string;
  /** Whether the row was parked: false for a free row, and for a vault with no row. */
  readonly wasParked: boolean;
  /** What was cleared, when it was parked. */
  readonly parkedReason?: string;
  readonly attempts?: number;
  /** Why nothing was done, when it was not. */
  readonly detail?: string;
}

/** How much of last_detail `status` prints. */
export const STATUS_DETAIL_CHARS = 300;

const iso = (value: unknown): string | null =>
  value instanceof Date ? value.toISOString() : typeof value === "string" ? new Date(value).toISOString() : null;
/** A timestamptz that may be ±infinity (node-postgres reads those as ±Infinity). */
const isoOrInfinity = (value: unknown): string | null => (value === Number.POSITIVE_INFINITY ? "infinity" : value === Number.NEGATIVE_INFINITY ? "-infinity" : iso(value));
const big = (value: unknown): bigint | null => (value === null || value === undefined ? null : BigInt(value as string | number));
const textOrNull = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

function ago(ms: number): string {
  if (ms < 90_000) return `${Math.round(ms / 1000)} s`;
  if (ms < 90 * 60_000) return `${Math.round(ms / 60_000)} min`;
  return `${Math.round(ms / 3_600_000)} h`;
}

function describeProcess(row: Record<string, unknown>): string {
  const age = Number(row["age_ms"]);
  return (
    `${String(row["process_id"])} (${String(row["role"])}, deployment ${row["deployment"] === null ? "none" : String(row["deployment"])}, ` +
    `host ${row["host"] === null ? "none" : String(row["host"])}, last read ${ago(age)} ago${row["live"] === true ? ", acting" : ""})`
  );
}

export class Handover {
  constructor(private readonly pool: HandoverPool) {}

  /** legacy → draining: the legacy keepers leave the vault alone from their next read. A vault with no row gets one. */
  async drain(vault: string): Promise<Step> {
    return this.#tx(async (client) => {
      const moved = await client.query(DRAIN_SQL, [vault]);
      if (moved.rows.length === 1) return { vault, system: "draining", moved: true, blockers: [] };
      const system = await this.#system(client, vault);
      return { vault, system, moved: false, blockers: [`the vault is ${system ?? "unknown"}, not legacy: there is nothing to drain`] };
    });
  }

  /**
   * draining → queue, in two calls at least: the first that finds no blocker
   * records `heights.processed`, and the first after the finalized height has
   * passed it by HANDOVER_WAIT_BLOCKS moves the vault. Every call re-checks
   * every receipt.
   *
   * `enrolledOnly` is the scheduler's auto-arm (the header): the row must still
   * be as ENSURE_VAULTS_SQL left it (AUTO_ARMABLE_SQL), read under the row's
   * lock, or nothing is written and the vault is left to its operator.
   */
  async arm(
    vault: string,
    heights: ChainHeights,
    options: { readonly requiredRoles?: readonly KeeperRole[]; readonly allowDry?: boolean; readonly enrolledOnly?: boolean } = {},
  ): Promise<Step> {
    const required = options.requiredRoles ?? KEEPER_ROLES;
    return this.#tx(async (client) => {
      const found = await client.query(VAULT_FOR_UPDATE_SQL, [vault]);
      const row = found.rows[0];
      if (row === undefined) return { vault, system: null, moved: false, blockers: ["vault_work has no row for this vault: drain it first"] };
      const system = row["system"] as VaultSystem;
      if (system !== "draining") {
        return { vault, system, moved: false, blockers: [`the vault is ${system}: only a draining vault is armed (drain it first)`] };
      }
      if (options.enrolledOnly === true && row["auto_armable"] !== true) {
        return {
          vault,
          system,
          moved: false,
          blockers: [
            "the vault is not as the scheduler enrolled it (an operator drained, rolled back or released it, or a worker claimed it): " +
              "the scheduler arms only its own untouched enrolments; finish this handover with `dispatch-handover arm`",
          ],
        };
      }
      const blockers: string[] = [];
      const receipts = (await client.query(RECEIPTS_SQL, [vault])).rows;
      for (const receipt of receipts) {
        if (receipt["saw"] !== true) {
          blockers.push(
            `legacy process ${describeProcess(receipt)} has not yet read this vault as not its own: wait for its next sweep; ` +
              `if its container no longer exists in Railway, mark it with \`dispatch-handover gone ${String(receipt["process_id"])}\``,
          );
        }
        if (receipt["carry"] === true) {
          blockers.push(
            `legacy process ${describeProcess(receipt)} holds a loss carry for a link of this vault only in its memory: a worker ` +
              "would over-charge that link's next win. Run the profit keeper with SIP_SOLANA_CARRY_STORE=dual or on first; under dual " +
              "this is a carry whose Postgres write failed (its carry-store warning), named until a later write of it succeeds or the " +
              "link settles past it",
          );
        }
      }
      for (const role of required) {
        const counted = receipts.filter(
          (receipt) =>
            receipt["role"] === role && receipt["saw"] === true && Number(receipt["age_ms"]) <= LEGACY_READ_FRESH_MS && (options.allowDry === true || receipt["live"] === true),
        );
        if (counted.length === 0) {
          blockers.push(
            options.allowDry === true
              ? `no ${role} keeper has read this vault as not its own in the last ${LEGACY_READ_FRESH_MS / 60_000} min: is SIP_SOLANA_DISPATCH set on that service, and is it running?`
              : `no ACTING ${role} keeper has read this vault as not its own in the last ${LEGACY_READ_FRESH_MS / 60_000} min: is ` +
                  "SIP_SOLANA_DISPATCH set on that service, is it running, and is the deployment holding its claim the one with the variable " +
                  "(an older container without it writes no receipt and may still be acting)?",
          );
        }
      }
      const recorded = big(row["handover_height"]);
      if (blockers.length > 0) {
        if (recorded !== null) await client.query(`UPDATE ${S}.vault_work SET handover_height = NULL WHERE vault_addr = $1`, [vault]);
        return { vault, system, moved: false, blockers };
      }
      if (recorded === null) {
        await client.query(`UPDATE ${S}.vault_work SET handover_height = $2 WHERE vault_addr = $1`, [vault, heights.processed.toString()]);
        const above = heights.processed + HANDOVER_WAIT_BLOCKS;
        return {
          vault,
          system,
          moved: false,
          blockers: [`every legacy keeper has let go; waiting for the finalized height to pass ${above} (now ${heights.finalized})`],
          waitUntilFinalizedAbove: above,
        };
      }
      const above = recorded + HANDOVER_WAIT_BLOCKS;
      if (heights.finalized <= above) {
        return {
          vault,
          system,
          moved: false,
          blockers: [`waiting for the finalized height to pass ${above} (now ${heights.finalized})`],
          waitUntilFinalizedAbove: above,
        };
      }
      await client.query(`UPDATE ${S}.vault_work SET system = 'queue', system_at = clock_timestamp() WHERE vault_addr = $1`, [vault]);
      return { vault, system: "queue", moved: true, blockers: [] };
    });
  }

  /** queue → draining: no worker claims it again; one holding it finishes its job. */
  async rollback(vault: string): Promise<Step> {
    return this.#tx(async (client) => {
      const moved = await client.query(ROLLBACK_SQL, [vault]);
      if (moved.rows.length === 1) return { vault, system: "draining", moved: true, blockers: [] };
      const system = await this.#system(client, vault);
      return { vault, system, moved: false, blockers: [`the vault is ${system ?? "unknown"}, not queue: there is nothing to roll back`] };
    });
  }

  /**
   * draining → legacy, once no worker can send for the vault, every one of its
   * intents is dead or final, and every loss a worker carried for its links will be
   * read by the profit keeper that takes it back (the header).
   */
  async release(vault: string, heights: ChainHeights): Promise<Step> {
    return this.#tx(async (client) => {
      const found = await client.query(VAULT_FOR_UPDATE_SQL, [vault]);
      const row = found.rows[0];
      if (row === undefined) return { vault, system: null, moved: false, blockers: ["vault_work has no row for this vault: it is already the legacy keepers'"] };
      const system = row["system"] as VaultSystem;
      if (system !== "draining") {
        return { vault, system, moved: false, blockers: [`the vault is ${system}: only a draining vault is released (roll it back first)`] };
      }
      const blockers: string[] = [];
      if (row["holder"] !== null && row["holder_dead"] !== true) {
        blockers.push(
          `worker ${String(row["holder"])} still holds it (lease until ${iso(row["lease_until"]) ?? "unknown"}): wait for its job to complete, ` +
            `at most ${RELEASE_JOB_CEILING_MINUTES} minutes after its claim`,
        );
      }
      const floor = big((await client.query(INTENT_FLOOR_SQL, [vault])).rows[0]?.["floor"]);
      if (floor !== null && heights.finalized <= floor) {
        blockers.push(`a worker's transaction for this vault could still land until height ${floor}: wait for the finalized height to pass it (now ${heights.finalized})`);
      }
      blockers.push(...(await this.#carryBlockers(client, vault)));
      if (blockers.length > 0) return { vault, system, moved: false, blockers, ...(floor !== null && heights.finalized <= floor ? { waitUntilFinalizedAbove: floor } : {}) };
      await client.query(
        `UPDATE ${S}.vault_work SET system = 'legacy', system_at = clock_timestamp(), handover_height = NULL, holder = NULL, lease_until = NULL
          WHERE vault_addr = $1`,
        [vault],
      );
      return { vault, system: "legacy", moved: true, blockers: [] };
    });
  }

  /**
   * Why the vault's worker-written loss carries would be lost on the legacy side
   * (the header, "the losses the workers carried"): one blocker per profit
   * process not running the store `on`, and one when none that does has read
   * recently. Empty when no such carry can still match.
   */
  async #carryBlockers(client: HandoverClient, vault: string): Promise<string[]> {
    const carries = (await client.query(WORKER_CARRIES_SQL, [vault])).rows;
    if (carries.length === 0) return [];
    const first = carries[0]!;
    const named =
      `link ${String(first["link_addr"])} carries ${String(first["loss_lamports"])} lamports into state ` +
      `${String(first["epoch"])}:${String(first["settlement_nonce"])}:${String(first["frontier_slot"])} (written at fence ${String(first["written_fence"])})` +
      (carries.length > 1 ? `, and ${carries.length - 1} more carr${carries.length === 2 ? "y" : "ies"} of its links` : "");
    const roles = KEEPER_ROLES.filter(roleCarriesLosses);
    const readers = (await client.query(CARRY_READERS_SQL, [roles])).rows;
    const blockers: string[] = [];
    for (const reader of readers) {
      if (reader["carry_store"] === "on") continue;
      const mode = reader["carry_store"] === null ? "unknown (its receipt predates the column)" : String(reader["carry_store"]);
      blockers.push(
        `legacy process ${describeProcess(reader)} runs SIP_SOLANA_CARRY_STORE=${mode}, which does not read on every turn the loss a worker carried for ` +
          `this vault (${named}): it would charge that link's next win whole. Run the profit keeper with SIP_SOLANA_CARRY_STORE=on, ` +
          `then mark this process gone once its container no longer exists (\`dispatch-handover gone ${String(reader["process_id"])}\`)`,
      );
    }
    const fresh = readers.filter((reader) => reader["carry_store"] === "on" && Number(reader["age_ms"]) <= LEGACY_READ_FRESH_MS);
    if (fresh.length === 0) {
      blockers.push(
        `no ${roles.join(" or ")} keeper running SIP_SOLANA_CARRY_STORE=on has read in the last ${LEGACY_READ_FRESH_MS / 60_000} min, and a worker ` +
          `carried a loss for this vault (${named}): the keeper that takes it back must read that loss. Run the profit keeper with ` +
          "SIP_SOLANA_CARRY_STORE=on and SIP_SOLANA_DISPATCH set, wait for its next sweep, and release again",
      );
    }
    return blockers;
  }

  /**
   * Every vault that is draining, armed one by one: the operator's `arm --all`.
   * The scheduler arms only its own untouched enrolments, one `arm` each with
   * `enrolledOnly` (src/auto-arm.ts, under SIP_SOLANA_AUTO_ARM=on); with the
   * variable off, nothing but this command moves a draining vault.
   */
  async armAll(heights: ChainHeights, options: { readonly requiredRoles?: readonly KeeperRole[]; readonly allowDry?: boolean } = {}): Promise<readonly Step[]> {
    const draining = await this.#read(`SELECT vault_addr FROM ${S}.vault_work WHERE system = 'draining' ORDER BY vault_addr`, []);
    const steps: Step[] = [];
    for (const row of draining) steps.push(await this.arm(String(row["vault_addr"]), heights, options));
    return steps;
  }

  /**
   * Marks legacy process rows gone — ONLY AFTER CHECKING IN RAILWAY that their
   * containers no longer exist. `stale` marks every row that has not read for
   * LEGACY_READ_FRESH_MS. A row that reads again clears its mark.
   */
  async gone(which: { readonly processIds: readonly string[] } | { readonly stale: true }): Promise<readonly { readonly processId: string; readonly role: string; readonly deployment: string | null; readonly readAt: string | null }[]> {
    const rows =
      "stale" in which
        ? await this.#read(
            `UPDATE ${S}.legacy_process SET gone_at = clock_timestamp()
              WHERE gone_at IS NULL AND read_at < clock_timestamp() - make_interval(secs => $1::double precision)
             RETURNING process_id, role, deployment, read_at`,
            [LEGACY_READ_FRESH_MS / 1000],
          )
        : await this.#read(
            `UPDATE ${S}.legacy_process SET gone_at = clock_timestamp()
              WHERE gone_at IS NULL AND process_id = ANY($1::text[])
             RETURNING process_id, role, deployment, read_at`,
            [[...which.processIds]],
          );
    return rows.map((row) => ({
      processId: String(row["process_id"]),
      role: String(row["role"]),
      deployment: row["deployment"] === null ? null : String(row["deployment"]),
      readAt: iso(row["read_at"]),
    }));
  }

  /** fleet.new_vault_system: whose a newly discovered vault is (P3d flips it to 'queue'). */
  async setNewVaultSystem(system: NewVaultSystem): Promise<NewVaultSystem> {
    const rows = await this.#read(
      `INSERT INTO ${S}.fleet (id, new_vault_system) VALUES (true, $1)
       ON CONFLICT (id) DO UPDATE SET new_vault_system = EXCLUDED.new_vault_system
       RETURNING new_vault_system`,
      [system],
    );
    return rows[0]!["new_vault_system"] as NewVaultSystem;
  }

  /**
   * Every vault that is not legacy (or `vault` alone; or, with `all`, every
   * vault_work row, legacy included), every legacy process row, the new-vault
   * flag and the webhook's owner. One transaction, so the three agree.
   */
  async status(vault?: string, options: { readonly all?: boolean } = {}): Promise<HandoverStatus> {
    if (options.all === true && vault !== undefined) throw new Error("status lists every vault or one, not both");
    return this.#tx(async (client) => {
      const vaults = await client.query(
        `SELECT vault_addr, system, system_at, handover_height, holder, lease_until, skim_mode, lane, fence::text AS fence, claimed_at,
                last_done_at, last_outcome, left(last_detail, ${STATUS_DETAIL_CHARS}) AS last_detail, parked_reason, attempts, due_at, streaks
           FROM ${S}.vault_work
          WHERE $2::boolean OR ($1::text IS NULL AND system <> 'legacy') OR vault_addr = $1::text ORDER BY vault_addr`,
        [vault ?? null, options.all === true],
      );
      const processes = await client.query(
        `SELECT process_id, role, dispatch, deployment, host, live, reads, read_at, started_at, gone_at, seen, absent_is, carry_vaults, carry_store,
                round(extract(epoch FROM clock_timestamp() - read_at) * 1000)::bigint AS age_ms
           FROM ${S}.legacy_process ORDER BY gone_at NULLS FIRST, role, read_at DESC, process_id`,
      );
      const flag = await client.query(`SELECT new_vault_system, webhook_owner FROM ${S}.fleet WHERE id`);
      return {
        newVaultSystem: (flag.rows[0]?.["new_vault_system"] as NewVaultSystem | undefined) ?? null,
        webhookOwner: textOrNull(flag.rows[0]?.["webhook_owner"]),
        vaults: vaults.rows.map((row) => ({
          vault: String(row["vault_addr"]),
          system: row["system"] as VaultSystem,
          systemAt: iso(row["system_at"]),
          handoverHeight: big(row["handover_height"]),
          holder: textOrNull(row["holder"]),
          leaseUntil: iso(row["lease_until"]),
          skimMode: row["skim_mode"] === null || row["skim_mode"] === undefined ? null : Number(row["skim_mode"]),
          lane: String(row["lane"]),
          fence: String(row["fence"]),
          claimedAt: iso(row["claimed_at"]),
          lastDoneAt: iso(row["last_done_at"]),
          lastOutcome: textOrNull(row["last_outcome"]),
          lastDetail: textOrNull(row["last_detail"]),
          parkedReason: textOrNull(row["parked_reason"]),
          attempts: Number(row["attempts"]),
          dueAt: isoOrInfinity(row["due_at"]),
          streaks: (row["streaks"] ?? {}) as Record<string, unknown>,
        })),
        processes: processes.rows.map((row) => ({
          processId: String(row["process_id"]),
          role: String(row["role"]),
          dispatch: String(row["dispatch"]),
          deployment: row["deployment"] === null ? null : String(row["deployment"]),
          host: row["host"] === null ? null : String(row["host"]),
          live: row["live"] === true,
          reads: BigInt(row["reads"] as string),
          readAt: iso(row["read_at"])!,
          ageMs: Number(row["age_ms"]),
          startedAt: iso(row["started_at"])!,
          goneAt: iso(row["gone_at"]),
          notLegacy: row["seen"] as Record<string, string>,
          absentIs: String(row["absent_is"]),
          carryVaults: row["carry_vaults"] as string[],
          carryStore: row["carry_store"] === null || row["carry_store"] === undefined ? null : String(row["carry_store"]),
        })),
      };
    });
  }

  /**
   * A parked vault back in the queue's hands (UNPARK_SQL): only a parked row is
   * changed. The scheduler sent its vault-parked page once, when it parked the
   * vault, and this does not touch that process's alerter; a vault whose claims
   * lapse PARK_AFTER_ATTEMPTS times in a row again is parked, and paged, again.
   */
  async unpark(vault: string): Promise<Unparked> {
    return this.#tx(async (client) => {
      const cleared = (await client.query(UNPARK_SQL, [vault])).rows[0];
      if (cleared !== undefined) {
        return { vault, wasParked: true, parkedReason: String(cleared["was_reason"]), attempts: Number(cleared["was_attempts"]) };
      }
      const system = await this.#system(client, vault);
      return {
        vault,
        wasParked: false,
        detail: system === null ? "vault_work has no row for this vault: there is nothing to unpark" : `the vault (${system}) is not parked: there is nothing to unpark`,
      };
    });
  }

  async #system(client: HandoverClient, vault: string): Promise<VaultSystem | null> {
    const rows = (await client.query(`SELECT system FROM ${S}.vault_work WHERE vault_addr = $1`, [vault])).rows;
    return rows.length === 0 ? null : (rows[0]!["system"] as VaultSystem);
  }

  async #read(text: string, values: unknown[]): Promise<readonly Record<string, unknown>[]> {
    return this.#tx(async (client) => (await client.query(text, values)).rows);
  }

  /** One transaction; a client that failed inside it is destroyed, never pooled with the transaction open. */
  async #tx<T>(work: (client: HandoverClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let broken = false;
    try {
      await client.query("BEGIN");
      const out = await work(client);
      await client.query("COMMIT");
      return out;
    } catch (error) {
      broken = true;
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release(broken);
    }
  }
}
