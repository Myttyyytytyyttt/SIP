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
//   * any row holds a loss carry for the vault only in memory (carry_vaults).
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
//
// NO PUSH WHILE A HANDOVER IS OPEN (ADR §6.1 rule 5): a push restarts every
// keeper service, and a new container is a new row the open handover must see.
//
// DARK. Only bin/dispatch-handover.mts loads this file (an operator's command,
// never started by production; test/dispatch-dark.test.ts), and the scheduler
// will, for ENROL_VAULTS_SQL. Every statement is on the database's clock.

import { READ_MODEL_SCHEMA } from "./read-model.js";
import type { NewVaultSystem, VaultSystem } from "./dispatch-select.js";
import { KEEPER_ROLES, type KeeperRole } from "./role-registry.js";

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
 * THE SCHEDULER'S ENROLMENT of the vaults its discovery found: $1 vault
 * addresses, $2 their mode bytes. A new vault is 'legacy' while
 * fleet.new_vault_system is 'legacy', and 'draining' — never 'queue' — once it
 * is 'queue', so it reaches the queue through `arm` like any other. AN EXISTING
 * ROW ONLY EVER HAS ITS MODE BYTE REWRITTEN: an on-chain mode change never
 * touches `system`.
 */
export const ENROL_VAULTS_SQL = `INSERT INTO ${S}.vault_work AS w (vault_addr, system, skim_mode, system_at)
SELECT v.vault_addr, CASE f.new_vault_system WHEN 'queue' THEN 'draining' ELSE 'legacy' END, v.skim_mode, clock_timestamp()
  FROM unnest($1::text[], $2::smallint[]) AS v(vault_addr, skim_mode),
       (SELECT COALESCE((SELECT new_vault_system FROM ${S}.fleet WHERE id), 'legacy') AS new_vault_system) f
ON CONFLICT (vault_addr) DO UPDATE SET skim_mode = EXCLUDED.skim_mode
 WHERE w.skim_mode IS DISTINCT FROM EXCLUDED.skim_mode
RETURNING vault_addr, system`;

export const DRAIN_SQL = `INSERT INTO ${S}.vault_work AS w (vault_addr, system, system_at) VALUES ($1, 'draining', clock_timestamp())
ON CONFLICT (vault_addr) DO UPDATE SET system = 'draining', system_at = clock_timestamp(), handover_height = NULL
 WHERE w.system = 'legacy'
RETURNING system`;

export const ROLLBACK_SQL = `UPDATE ${S}.vault_work SET system = 'draining', system_at = clock_timestamp(), handover_height = NULL
 WHERE vault_addr = $1 AND system = 'queue'
RETURNING system`;

const VAULT_FOR_UPDATE_SQL = `SELECT system, handover_height, holder, lease_until,
       holder IS NOT NULL AND lease_until < clock_timestamp()
         AND claimed_at < clock_timestamp() - interval '${RELEASE_JOB_CEILING_MINUTES} minutes' AS holder_dead
  FROM ${S}.vault_work WHERE vault_addr = $1 FOR UPDATE`;

const RECEIPTS_SQL = `SELECT process_id, role, deployment, host, live, read_at,
       seen ? $1 AS saw, $1 = ANY(carry_vaults) AS carry,
       round(extract(epoch FROM clock_timestamp() - read_at) * 1000)::bigint AS age_ms
  FROM ${S}.legacy_process WHERE gone_at IS NULL ORDER BY role, read_at DESC, process_id`;

const INTENT_FLOOR_SQL = `SELECT max(COALESCE(resolved_height, last_valid_block_height)) AS floor
  FROM ${S}.send_intent WHERE vault_addr = $1`;

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
}

export interface HandoverStatus {
  readonly newVaultSystem: NewVaultSystem | null;
  readonly vaults: readonly {
    readonly vault: string;
    readonly system: VaultSystem;
    readonly systemAt: string | null;
    readonly handoverHeight: bigint | null;
    readonly holder: string | null;
    readonly leaseUntil: string | null;
  }[];
  readonly processes: readonly LegacyProcessRow[];
}

const iso = (value: unknown): string | null =>
  value instanceof Date ? value.toISOString() : typeof value === "string" ? new Date(value).toISOString() : null;
const big = (value: unknown): bigint | null => (value === null || value === undefined ? null : BigInt(value as string | number));

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
   */
  async arm(
    vault: string,
    heights: ChainHeights,
    options: { readonly requiredRoles?: readonly KeeperRole[]; readonly allowDry?: boolean } = {},
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
              "would over-charge that link's next win. Run the profit keeper with SIP_SOLANA_CARRY_STORE=dual or on first",
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

  /** draining → legacy, once no worker can send for the vault and every one of its intents is dead or final. */
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
      if (blockers.length > 0) return { vault, system, moved: false, blockers, ...(floor !== null && heights.finalized <= floor ? { waitUntilFinalizedAbove: floor } : {}) };
      await client.query(
        `UPDATE ${S}.vault_work SET system = 'legacy', system_at = clock_timestamp(), handover_height = NULL, holder = NULL, lease_until = NULL
          WHERE vault_addr = $1`,
        [vault],
      );
      return { vault, system: "legacy", moved: true, blockers: [] };
    });
  }

  /** Every vault that is draining, armed one by one (the scheduler's way under new_vault_system = 'queue', and `arm --all`). */
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

  /** Every vault that is not legacy (or `vault` alone), every legacy process row, and the new-vault flag. */
  async status(vault?: string): Promise<HandoverStatus> {
    return this.#tx(async (client) => {
      const vaults = await client.query(
        `SELECT vault_addr, system, system_at, handover_height, holder, lease_until FROM ${S}.vault_work
          WHERE ($1::text IS NULL AND system <> 'legacy') OR vault_addr = $1::text ORDER BY vault_addr`,
        [vault ?? null],
      );
      const processes = await client.query(
        `SELECT process_id, role, dispatch, deployment, host, live, reads, read_at, started_at, gone_at, seen, absent_is, carry_vaults,
                round(extract(epoch FROM clock_timestamp() - read_at) * 1000)::bigint AS age_ms
           FROM ${S}.legacy_process ORDER BY gone_at NULLS FIRST, role, read_at DESC, process_id`,
      );
      const flag = await client.query(`SELECT new_vault_system FROM ${S}.fleet WHERE id`);
      return {
        newVaultSystem: (flag.rows[0]?.["new_vault_system"] as NewVaultSystem | undefined) ?? null,
        vaults: vaults.rows.map((row) => ({
          vault: String(row["vault_addr"]),
          system: row["system"] as VaultSystem,
          systemAt: iso(row["system_at"]),
          handoverHeight: big(row["handover_height"]),
          holder: row["holder"] === null ? null : String(row["holder"]),
          leaseUntil: iso(row["lease_until"]),
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
        })),
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
