// WHO ACTS ON A VAULT WHILE THE FLEET MOVES TO THE QUEUE: the legacy keepers'
// half of the migration (dispatcher ADR §3.12, RT-4; §4.9 rows 12, 20 and 21;
// plan P3a, "migration and selection").
//
// THE ACTOR IS `vault_work.system`, NEVER THE MODE BYTE. 'legacy' is today's two
// keepers; 'draining' is the first step of a handover — the legacy keepers
// already leave the vault alone and no worker may take it yet; 'queue' is the
// dispatcher's workers. A selector keyed on the vault's on-chain skim_mode would
// move a vault between actors the moment its owner called set_policy_v2,
// skipping the handover — so nothing in this file reads a mode, and its test
// changes every mode byte to prove it.
//
// BOTH LEGACY KEEPERS, AND FOR SETTLE AND INVEST BOTH (RT-4). The profit keeper
// invests EVERY vault whatever its mode (bin/keeper.mts, the `investing` block):
// a VOLUME vault on the queue left alone only by the volume keeper would still be
// bought for by the profit keeper, while a worker bought for it too. So a turn
// this file leaves alone is not run at all — no settle, no invest, no Privy
// lookup, no vault read — on whichever keeper reads it.
//
// ONLY UNDER SIP_SOLANA_DISPATCH (src/cuts.ts). Unset or `off`, bin/keeper.mts
// builds no LegacySelector and runs no statement here: the keeper of before,
// request for request. `shadow` and `on` mean the same thing on a legacy keeper.
//
// ONE STATEMENT A SWEEP, READ AND RECEIPT TOGETHER (LEGACY_SELECT_SQL). It reads
// every vault vault_work does not call 'legacy' and, in the same statement,
// writes this process's sip_solana.legacy_process row with exactly the map it
// read. That row is the handover's evidence (src/handover.ts): sweeps never
// overlap in one process (bin/keeper.mts's cycleRunning), so a row naming a vault
// says this process will not act on it again AND that every earlier sweep of it,
// which might have, is over. Written apart, a receipt could claim a read the
// keeper never acted on.
//
// A READ THAT FAILS ACTS ON NO VAULT (`unread`). Not the last good answer: a
// vault drained since then would be acted on by a process whose receipt never
// saw the drain — the handover would wait for it, but this process would not.
// So a database that cannot answer holds every legacy turn for that sweep: a
// delay, never a double actor. It warns, and pages from the third sweep in a row.
// An armed keeper whose database is down has usually lost its claim already; this
// covers the one that has not.
//
// A VAULT WITH NO ROW is what fleet.new_vault_system says (plan P3a design detail
// 3): 'legacy' until P3d, and then not this keeper's (`unenrolled`). Under
// 'queue' the scheduler enrols new vaults as 'draining' (src/scheduler-pg.ts,
// ENSURE_VAULTS_SQL), so a new vault reaches the queue by the same handover as
// any — `arm`, run by an operator or by the scheduler itself (src/auto-arm.ts).
//
// THE CARRY LEFT IN MEMORY. A PROFIT link's loss carry lives in this process's
// memory when SIP_SOLANA_CARRY_STORE is off — and under `dual` when its Postgres
// write failed (src/carry-store.ts, DurableCarries.memoryOnlyLinks); a worker
// cannot see it and would over-charge that link's next win. The receipt names the
// vaults with such a carry (carry_vaults), and the handover refuses to arm them.
//
// AND THE CARRY STORE IT READS (carry_store): the way back needs it. A worker
// writes its PROFIT carries into Postgres only, and a legacy keeper that does not
// read the store on every turn would charge the next win without them; the
// handover refuses to release such a vault until every profit receipt says `on`.

import { summarizeUpstreamError } from "@sip/solana-log";
import type { Alert } from "./alerts.js";
import type { CarryStoreMode, DispatchMode } from "./cuts.js";
import { READ_MODEL_SCHEMA } from "./read-model.js";
import type { KeeperRole } from "./role-registry.js";

/** Who acts on a vault (vault_work.system): the legacy keepers, a handover in progress, or the queue. */
export const VAULT_SYSTEMS = ["legacy", "draining", "queue"] as const;
export type VaultSystem = (typeof VAULT_SYSTEMS)[number];
export type NotLegacy = Exclude<VaultSystem, "legacy">;
/** fleet.new_vault_system: whose a vault with no vault_work row is. */
export type NewVaultSystem = "legacy" | "queue";

/**
 * Why a legacy keeper left a turn alone: the vault's system, `unenrolled` (no
 * row, and new vaults are the queue's), or `unread` (this sweep's read failed).
 */
export type LeaveReason = NotLegacy | "unenrolled" | "unread";

const S = READ_MODEL_SCHEMA;

/**
 * THE SWEEP'S ONE STATEMENT. $1 process_id, $2 role, $3 dispatch mode, $4
 * deployment, $5 host, $6 live, $7 carry_vaults, $8 carry_store. Returns the map it stored
 * (`seen`), `absent_is`, the database's time of the read, and — only when new
 * vaults are the queue's — the vaults vault_work names 'legacy', so a legacy row
 * is told from a vault with no row (`legacy_rows`, not stored).
 *
 * A row the operator marked gone that reads again is not gone: gone_at clears.
 */
export const LEGACY_SELECT_SQL = `WITH f AS (
  SELECT COALESCE((SELECT new_vault_system FROM ${S}.fleet WHERE id), 'legacy') AS absent_is),
v AS (
  SELECT COALESCE(jsonb_object_agg(vault_addr, system) FILTER (WHERE system <> 'legacy'), '{}'::jsonb) AS seen,
         CASE WHEN (SELECT absent_is FROM f) = 'queue'
              THEN COALESCE(array_agg(vault_addr) FILTER (WHERE system = 'legacy'), '{}'::text[]) END AS legacy_rows
    FROM ${S}.vault_work),
i AS (
  INSERT INTO ${S}.legacy_process AS p
         (process_id, role, dispatch, deployment, host, live, read_at, seen, absent_is, carry_vaults, carry_store)
  SELECT $1::text, $2::text, $3::text, $4::text, $5::text, $6::boolean, clock_timestamp(), v.seen, f.absent_is, $7::text[], $8::text
    FROM v, f
  ON CONFLICT (process_id) DO UPDATE
     SET live = EXCLUDED.live, read_at = EXCLUDED.read_at, reads = p.reads + 1, seen = EXCLUDED.seen,
         absent_is = EXCLUDED.absent_is, carry_vaults = EXCLUDED.carry_vaults, carry_store = EXCLUDED.carry_store, gone_at = NULL
  RETURNING seen, absent_is, read_at)
SELECT i.seen, i.absent_is, i.read_at, v.legacy_rows FROM i, v`;

/** What one sweep's read said. */
export interface LegacyView {
  /** Every vault vault_work does not call 'legacy', with what it is. */
  readonly notLegacy: ReadonlyMap<string, NotLegacy>;
  /** Whose a vault with no vault_work row is (fleet.new_vault_system). */
  readonly absentIs: NewVaultSystem;
  /** Only when absentIs is 'queue': the vaults vault_work names 'legacy'. */
  readonly legacyRows: ReadonlySet<string> | null;
  /** The database's clock at the read, ISO. */
  readonly readAt: string;
}

/**
 * Why a legacy keeper leaves `vault` alone this sweep, or null when it is the
 * legacy keepers' to act on. A FAILED READ (view null) LEAVES EVERY VAULT ALONE.
 *
 * NO MODE PARAMETER, on purpose: who acts is the system, never the mode byte.
 */
export function leaveReason(view: LegacyView | null, vault: string): LeaveReason | null {
  if (view === null) return "unread";
  const system = view.notLegacy.get(vault);
  if (system !== undefined) return system;
  if (view.absentIs === "legacy") return null;
  return view.legacyRows?.has(vault) === true ? null : "unenrolled";
}

export interface LeftTurn<T> {
  readonly turn: T;
  readonly reason: LeaveReason;
}

/** A sweep's selected turns, split into the ones this legacy keeper runs and the ones it leaves alone, each in order. */
export function partitionLegacyTurns<T>(
  turns: readonly T[],
  vaultOf: (turn: T) => string,
  view: LegacyView | null,
): { readonly act: readonly T[]; readonly left: readonly LeftTurn<T>[] } {
  const act: T[] = [];
  const left: LeftTurn<T>[] = [];
  for (const turn of turns) {
    const reason = leaveReason(view, vaultOf(turn));
    if (reason === null) act.push(turn);
    else left.push({ turn, reason });
  }
  return { act, left };
}

/**
 * THE RECEIPT'S carry_vaults: the vaults whose loss carry lives only in this
 * process's memory, which a worker — reading Postgres alone — could not see.
 * `memoryOnly` is the carry store's own account of its links
 * (DurableCarries.memoryOnlyLinks: under `dual`, a carry whose write failed;
 * under `on`, none), or null when there is no store (`off`), where every carry
 * memory holds counts. Each vault once, in the links' order.
 */
export function carryOnlyInMemoryVaults(
  links: readonly { readonly linkAddress: { toBase58(): string }; readonly vault: { toBase58(): string } }[],
  book: ReadonlyMap<string, { readonly size: number }>,
  memoryOnly: ReadonlySet<string> | null,
): readonly string[] {
  const vaults = links
    .filter((link) => {
      const address = link.linkAddress.toBase58();
      return memoryOnly === null ? (book.get(address)?.size ?? 0) > 0 : memoryOnly.has(address);
    })
    .map((link) => link.vault.toBase58());
  return [...new Set(vaults)];
}

/** The /status row's detail for a turn left alone: what the keeper did not do, and why. */
export function leftAloneDetail(reason: LeaveReason, mode: Exclude<DispatchMode, "off">): string {
  switch (reason) {
    case "draining":
      return (
        "vault_work.system is draining: this vault is being handed to the dispatcher's queue, so this keeper neither settles " +
        "nor invests it (dispatcher ADR §3.12)"
      );
    case "queue":
      return "vault_work.system is queue: the dispatcher's workers act on this vault, so this keeper neither settles nor invests it";
    case "unenrolled":
      return (
        "fleet.new_vault_system is queue and vault_work has no row for this vault yet: it is not this keeper's, so it is " +
        "neither settled nor invested here"
      );
    case "unread":
      return (
        `sip_solana.vault_work could not be read this sweep (SIP_SOLANA_DISPATCH is ${mode}): this keeper acts on no vault ` +
        "until it can tell whose each one is"
      );
  }
}

/** Runs one statement and answers its rows, or throws (SolanaReadModel.statement). */
export type StatementRunner = (text: string, values: readonly unknown[]) => Promise<readonly Record<string, unknown>[]>;

export interface LegacySelectorOptions {
  readonly role: KeeperRole;
  readonly mode: Exclude<DispatchMode, "off">;
  /** A uuid at boot. */
  readonly processId: string;
  /** RAILWAY_DEPLOYMENT_ID, or null off Railway. */
  readonly deployment: string | null;
  readonly host: string | null;
  /**
   * SIP_SOLANA_CARRY_STORE as this process runs it, written on every receipt:
   * `release` gives a vault with a worker's carries back only to profit keepers
   * that read the store on every turn (src/handover.ts).
   */
  readonly carryStore: CarryStoreMode;
  readonly run: StatementRunner;
}

export type LegacyRead =
  | { readonly ok: true; readonly view: LegacyView }
  | { readonly ok: false; readonly detail: string; readonly streak: number };

/** At most this many left-alone turns are listed on /status; the count is always whole. */
export const LEFT_ALONE_LISTED = 20;

export interface LegacySelectStatus {
  readonly mode: Exclude<DispatchMode, "off">;
  readonly processId: string;
  readonly reads: number;
  readonly failures: number;
  readonly consecutiveFailures: number;
  /** The database's clock at the last read that answered. */
  readonly lastReadAt: string | null;
  readonly lastFailure: { readonly at: string; readonly detail: string } | null;
  /** From the last read that answered: whose a vault with no row is, and how many vaults are not the legacy keepers'. */
  readonly absentVaultsAre: NewVaultSystem | null;
  readonly notLegacy: { readonly draining: number; readonly queue: number } | null;
  /** The last sweep's turns left alone: how many, and the first LEFT_ALONE_LISTED of them. */
  readonly leftAloneLastSweep: number;
  readonly leftAlone: readonly { readonly wallet: string; readonly vault: string; readonly reason: LeaveReason }[];
  /** Vaults left alone whose loss carry lives only in this process's memory: no handover arms them (src/handover.ts). */
  readonly carryOnlyInMemory: readonly string[];
}

/** The parsing is strict: a row this file cannot read is a read that failed, and a failed read acts on nothing. */
function parseView(rows: readonly Record<string, unknown>[]): LegacyView {
  if (rows.length !== 1) throw new Error(`the selection statement answered ${rows.length} rows, not 1`);
  const row = rows[0]!;
  const seen = row["seen"];
  if (seen === null || typeof seen !== "object" || Array.isArray(seen)) throw new Error("the selection's `seen` is not a JSON object");
  const notLegacy = new Map<string, NotLegacy>();
  for (const [vault, system] of Object.entries(seen as Record<string, unknown>)) {
    if (system !== "draining" && system !== "queue") throw new Error(`vault_work names a system this keeper does not know for ${vault}`);
    notLegacy.set(vault, system);
  }
  const absentIs = row["absent_is"];
  if (absentIs !== "legacy" && absentIs !== "queue") throw new Error("fleet.new_vault_system is neither legacy nor queue");
  const legacyRaw = row["legacy_rows"];
  let legacyRows: ReadonlySet<string> | null = null;
  if (absentIs === "queue") {
    if (!Array.isArray(legacyRaw) || !legacyRaw.every((vault) => typeof vault === "string")) {
      throw new Error("new vaults are the queue's but the selection did not list vault_work's legacy rows");
    }
    legacyRows = new Set(legacyRaw as string[]);
  }
  const readAtRaw = row["read_at"];
  const readAt = readAtRaw instanceof Date ? readAtRaw.toISOString() : typeof readAtRaw === "string" ? new Date(readAtRaw).toISOString() : null;
  if (readAt === null) throw new Error("the selection did not answer the time of its read");
  return { notLegacy, absentIs, legacyRows, readAt };
}


/**
 * The legacy keeper's selection: one read (and receipt) a sweep, its counters,
 * and the last sweep's left-alone turns for /status. Built only under
 * SIP_SOLANA_DISPATCH.
 */
export class LegacySelector {
  readonly #options: LegacySelectorOptions;
  #reads = 0;
  #failures = 0;
  #streak = 0;
  #lastFailure: { at: string; detail: string } | null = null;
  #view: LegacyView | null = null;
  #leftCount = 0;
  #left: { wallet: string; vault: string; reason: LeaveReason }[] = [];
  #carryOnlyInMemory: string[] = [];

  constructor(options: LegacySelectorOptions) {
    this.#options = options;
  }

  get mode(): Exclude<DispatchMode, "off"> {
    return this.#options.mode;
  }

  /**
   * This sweep's read and receipt. `live`: whether the process is acting at the
   * sweep's start; `carryVaults`: the vaults whose loss carry lives only in its
   * memory. NEVER THROWS: a failure is `ok: false`, and the caller then acts on
   * no vault.
   */
  async read(input: { readonly live: boolean; readonly carryVaults: readonly string[]; readonly now: number }): Promise<LegacyRead> {
    const options = this.#options;
    try {
      const rows = await options.run(LEGACY_SELECT_SQL, [
        options.processId,
        options.role,
        options.mode,
        options.deployment,
        options.host,
        input.live,
        [...new Set(input.carryVaults)].sort(),
        options.carryStore,
      ]);
      const view = parseView(rows);
      this.#reads += 1;
      this.#streak = 0;
      this.#view = view;
      return { ok: true, view };
    } catch (error) {
      this.#failures += 1;
      this.#streak += 1;
      this.#lastFailure = { at: new Date(input.now).toISOString(), detail: summarizeUpstreamError(error, { take: 3, maxChars: 500 }) };
      return { ok: false, detail: this.#lastFailure.detail, streak: this.#streak };
    }
  }

  /** What the sweep left alone, for /status: replaced every sweep. */
  noteLeft(left: readonly { readonly wallet: string; readonly vault: string; readonly reason: LeaveReason }[], carryOnlyInMemory: readonly string[]): void {
    this.#leftCount = left.length;
    this.#left = left.slice(0, LEFT_ALONE_LISTED).map((entry) => ({ ...entry }));
    this.#carryOnlyInMemory = [...new Set(carryOnlyInMemory)].sort();
  }

  status(): LegacySelectStatus {
    const view = this.#view;
    let draining = 0;
    let queue = 0;
    for (const system of view?.notLegacy.values() ?? []) {
      if (system === "draining") draining += 1;
      else queue += 1;
    }
    return {
      mode: this.#options.mode,
      processId: this.#options.processId,
      reads: this.#reads,
      failures: this.#failures,
      consecutiveFailures: this.#streak,
      lastReadAt: view?.readAt ?? null,
      lastFailure: this.#lastFailure,
      absentVaultsAre: view?.absentIs ?? null,
      notLegacy: view === null ? null : { draining, queue },
      leftAloneLastSweep: this.#leftCount,
      leftAlone: this.#left,
      carryOnlyInMemory: this.#carryOnlyInMemory,
    };
  }
}

export const LEGACY_SELECT_ALERT_KEY = "legacy-select";
/** Sweeps in a row whose read failed before it pages: the streak vault-read uses. */
export const LEGACY_SELECT_CRITICAL_STREAK = 3;

/**
 * A failed read: a warning first, critical from the third sweep in a row — by
 * then this keeper has acted on nobody for three sweeps. The caller clears the
 * warning at the escalation, as for vault-read, or the dedupe would swallow it.
 */
export function legacySelectAlert(streak: number, detail: string): Alert {
  const critical = streak >= LEGACY_SELECT_CRITICAL_STREAK;
  return {
    key: LEGACY_SELECT_ALERT_KEY,
    severity: critical ? "critical" : "warn",
    title: critical
      ? "A legacy keeper cannot read who acts on each vault, and has settled and invested nothing"
      : "A legacy keeper could not read vault_work; this sweep settled and invested nothing",
    detail: `${streak} sweep${streak === 1 ? "" : "s"} in a row: ${detail}`,
    context: { sweeps: streak },
  };
}
