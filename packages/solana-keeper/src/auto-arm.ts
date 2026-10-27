// THE SCHEDULER ARMS WHAT IT ENROLLED (SIP_SOLANA_AUTO_ARM; dispatcher ADR
// §3.12, RT-4; plan P3d, "new vaults straight to the queue").
//
// THE GAP IT CLOSES. Under fleet.new_vault_system = 'queue' the scheduler's
// discovery enrols a new vault as 'draining', never straight onto the queue
// (ENSURE_VAULTS_SQL, src/scheduler-pg.ts), so that a legacy keeper that read
// the flag before it flipped can never act on a vault a worker holds. But a
// draining vault is nobody's: the legacy keepers leave it alone, and CLAIM
// takes only 'queue'. Until this step existed only an operator's
// `dispatch-handover arm` moved it on, so a user who linked a wallet while
// nobody was watching was settled and bought for by nobody.
//
// THE SAME `arm`, NOT A SECOND ONE. Each tick the lock holder reads the rows it
// may arm and calls Handover.arm on each, as the operator's command does:
// every legacy receipt (a non-gone process that has not read the vault as not
// its own blocks by name; a memory-only carry blocks), the acting receipt of
// each required role, the processed height recorded on the first call that
// finds nothing in the way, and the move only once the finalized height is
// HANDOVER_WAIT_BLOCKS past it. Nothing of that is re-implemented here: this
// file decides only WHICH rows, WHEN, and who is told.
//
// WHICH ROWS: ONLY THE SCHEDULER'S OWN, UNTOUCHED (AUTO_ARMABLE_SQL,
// src/handover.ts) — draining, system_at NULL, fence 0, no holder. Every
// handover step stamps system_at and the enrolment does not, so a vault an
// operator drained, rolled back or released is never armed from here: an
// operator's handover is the operator's to finish, and a rolled-back vault is
// one somebody took off the queue on purpose. The selection reads the rule, and
// `arm` reads it again under the row's lock (`enrolledOnly`), so a row an
// operator touches between the two is refused rather than armed. At most
// AUTO_ARM_BATCH a tick, oldest enrolment first.
//
// WHICH ROLES (SIP_SOLANA_LEGACY_ROLES, src/scheduler-config.ts): by default
// both legacy roles must hold an acting receipt, which is `arm`'s own rule —
// and which no vault can meet once the legacy keepers are stopped. `none` says
// they are retired: no role's receipt is required, and EVERY legacy_process row
// not marked gone must still have read the vault as not its own, so a legacy
// keeper brought back with SIP_SOLANA_DISPATCH=on holds every arm until it has
// seen the vault, and a stopped one that never saw it holds it until an
// operator marks it gone (`dispatch-handover gone`).
//
// NEVER THE TICK'S FAILURE, AND NEVER SILENT. A step that cannot read its rows,
// the chain's heights or a vault's arm is recorded on /status
// (scheduler.autoArm.lastError) and logged, and the tick goes on: scheduling
// the queue matters more than moving a vault onto it. What a person must hear
// is a new user nobody serves, so the alert (AUTO_ARM_ALERT_KEY) is on how long
// that has lasted — the step failing, or the oldest enrolled vault still
// waiting, whichever is longer: warn at 15 minutes, page at 60. The normal wait
// is one legacy sweep (SIP_SOLANA_SWEEP_MS, at most five minutes) and 150
// blocks (about a minute), plus a tick.
//
// FREE WHEN THERE IS NOTHING TO ARM. A tick with no such row reads one
// statement and asks the chain nothing; the two heights are read only when a
// row waits, through the scheduler's budgeted pool (lane `sched`), processed
// first, by the reader the operator's command uses (readChainHeights).
//
// BY THE LOCK HOLDER, UNDER `on` ONLY (src/scheduler.ts). A shadow scheduler
// arms nothing: a shadow fleet's queue is not the production one's.

import { summarizeUpstreamError } from "@sip/solana-log";
import { AUTO_ARMABLE_SQL, type ChainHeights, type Handover, type Step } from "./handover.js";
import { READ_MODEL_SCHEMA } from "./read-model.js";
import type { KeeperRole } from "./role-registry.js";
import type { SchedulerDb } from "./scheduler-pg.js";
import type { AlertDecision } from "./usage-alerts.js";

const S = READ_MODEL_SCHEMA;

/** The most rows one tick arms: each is one short transaction on the scheduler's one connection. */
export const AUTO_ARM_BATCH = 20;
/** How many recent results /status keeps, newest first, one per vault. */
export const AUTO_ARM_RESULTS_KEPT = 5;
/** The alert's key: one for the fleet, raised by the lock holder. */
export const AUTO_ARM_ALERT_KEY = "auto-arm-stalled";
/** How long a new vault may go unserved before it warns: twice the normal wait at the longest sweep (the header). */
export const AUTO_ARM_WARN_MS = 15 * 60_000;
/** ... and before it pages. */
export const AUTO_ARM_CRITICAL_MS = 60 * 60_000;

/**
 * The rows the auto-arm may arm (AUTO_ARMABLE_SQL), oldest enrolment first, at
 * most $1, with how many there are in all and how long each has waited. An
 * enrolled row's due_at is its enrolment: nothing but a bell (only ever
 * earlier, and never before the enrolment) writes due_at on a draining row.
 */
export const AUTO_ARM_PENDING_SQL = `SELECT vault_addr,
       greatest(0, round(extract(epoch FROM clock_timestamp() - due_at) * 1000))::bigint AS waiting_ms,
       count(*) OVER () AS pending
  FROM ${S}.vault_work
 WHERE ${AUTO_ARMABLE_SQL}
 ORDER BY due_at, vault_addr
 LIMIT $1`;

/** What the step reads of Postgres. */
export interface AutoArmStore {
  pending(limit: number): Promise<{ readonly total: number; readonly rows: readonly { readonly vault: string; readonly waitingMs: number }[] }>;
}

/** AUTO_ARM_PENDING_SQL on the scheduler's pool. */
export class PgAutoArmStore implements AutoArmStore {
  readonly #db: SchedulerDb;

  constructor(db: SchedulerDb) {
    this.#db = db;
  }

  async pending(limit: number): Promise<{ readonly total: number; readonly rows: readonly { readonly vault: string; readonly waitingMs: number }[] }> {
    const result = await this.#db.query(AUTO_ARM_PENDING_SQL, [limit]);
    const rows = result.rows.map((row: Record<string, unknown>) => ({ vault: String(row["vault_addr"]), waitingMs: Number(row["waiting_ms"]) }));
    const first = result.rows[0] as Record<string, unknown> | undefined;
    return { total: first === undefined ? 0 : Number(first["pending"]), rows };
  }
}

/** One vault's latest arm, as /status lists it. */
export interface AutoArmResult {
  readonly vault: string;
  readonly moved: boolean;
  /** The first thing in the way, when it did not move. */
  readonly blocker?: string;
  /** This process's clock, ISO. */
  readonly at: string;
}

/** scheduler.autoArm on /status. */
export interface AutoArmStatus {
  /** SIP_SOLANA_AUTO_ARM=on under SIP_SOLANA_DISPATCH=on. */
  readonly enabled: boolean;
  /** SIP_SOLANA_LEGACY_ROLES: the roles whose acting receipt each arm requires; [] is `none`. */
  readonly legacyRoles: readonly string[];
  /** Enrolled draining rows still waiting at the last step; null before the first (and whenever it is off). */
  readonly pending: number | null;
  /** How long the oldest of them had waited since its enrolment, at the last step. */
  readonly oldestWaitingMs: number | null;
  readonly lastArmedAt: string | null;
  /** Vaults this process moved to the queue since it started. */
  readonly armed: number;
  /** Up to AUTO_ARM_RESULTS_KEPT, newest first, one per vault. */
  readonly lastResults: readonly AutoArmResult[];
  /** The last step's failure, summarized; null once a step runs clean. */
  readonly lastError: string | null;
  /** Since when steps have been failing, ISO; null when the last one ran clean. */
  readonly failingSince: string | null;
}

/** What one step did: the scheduler's handle on it. */
export interface AutoArmTick {
  readonly ran: boolean;
  /** The vaults moved to the queue this step. */
  readonly moved: readonly string[];
  readonly pending: number | null;
  readonly error: string | null;
  /** AUTO_ARM_ALERT_KEY's decision, for the scheduler to apply. */
  readonly alert: AlertDecision;
}

/** The step as the scheduler holds it (src/scheduler.ts). */
export interface SchedulerAutoArm {
  readonly enabled: boolean;
  step(): Promise<AutoArmTick>;
  status(): AutoArmStatus;
}

export interface AutoArmOptions {
  /** autoArmRuns(config): SIP_SOLANA_AUTO_ARM=on under SIP_SOLANA_DISPATCH=on. Off, step() does nothing. */
  readonly enabled: boolean;
  readonly legacyRoles: readonly KeeperRole[];
  readonly store: AutoArmStore;
  readonly handover: Pick<Handover, "arm">;
  /** readChainHeights over the scheduler's Connection (src/handover.ts). */
  readonly heights: () => Promise<ChainHeights>;
  readonly log: (level: "info" | "warn", message: string, fields?: Record<string, unknown>) => void;
  /** This process's clock, for durations and /status only. */
  readonly now?: () => number;
  readonly batch?: number;
}

const nothing: AlertDecision = { fire: null, clear: false };
const cleared: AlertDecision = { fire: null, clear: true };
const minutes = (ms: number): number => Math.round(ms / 60_000);

/**
 * AUTO_ARM_ALERT_KEY's rule. The stall is the longer of how long the step has
 * been failing and how long the oldest enrolled vault has waited: under
 * AUTO_ARM_WARN_MS it clears, from it it warns, from AUTO_ARM_CRITICAL_MS it pages.
 * `why` is the step's last error or the oldest vault's first blocker.
 */
export function autoArmAlert(input: {
  readonly failingForMs: number | null;
  readonly oldestWaitingMs: number | null;
  readonly pending: number | null;
  readonly why: string | null;
}): AlertDecision {
  const stalled = Math.max(input.failingForMs ?? 0, input.oldestWaitingMs ?? 0);
  if (stalled < AUTO_ARM_WARN_MS) return cleared;
  const critical = stalled >= AUTO_ARM_CRITICAL_MS;
  const n = input.pending;
  const waiting =
    n === null || n === 0
      ? ""
      : `${n} vault${n === 1 ? "" : "s"} the scheduler enrolled ${n === 1 ? "is" : "are"} still draining — the legacy keepers leave ` +
        `${n === 1 ? "it" : "them"} alone and no worker takes ${n === 1 ? "it" : "them"}, so nobody settles or buys for ${n === 1 ? "its" : "their"} users` +
        (input.oldestWaitingMs === null ? "" : `; the oldest has waited ${minutes(input.oldestWaitingMs)} min`) +
        ". ";
  const failing = input.failingForMs === null ? "" : `The auto-arm step has been failing for ${minutes(input.failingForMs)} min. `;
  return {
    fire: {
      key: AUTO_ARM_ALERT_KEY,
      severity: critical ? "critical" : "warn",
      title: critical ? "New vaults are stuck before the queue: nobody serves them" : "A new vault is taking long to reach the queue",
      detail:
        waiting +
        failing +
        (input.why === null ? "" : `Last: ${input.why}. `) +
        "`dispatch-handover status` shows every legacy receipt; a legacy keeper whose container no longer exists is marked with " +
        "`dispatch-handover gone`, and SIP_SOLANA_LEGACY_ROLES=none on the scheduler says the legacy keepers are retired.",
      context: { pending: n, oldestWaitingMs: input.oldestWaitingMs, failingForMs: input.failingForMs },
    },
    clear: false,
  };
}

/** A blocker's kind, without its numbers: a wait that only counts blocks is the same line, not a new one to log. */
const kindOf = (text: string): string => text.replace(/[0-9]+/g, "#");

/**
 * The step (the header). Holds only what /status and the alert need: the last
 * results, the failure streak, the counts. step() NEVER THROWS.
 */
export class AutoArm implements SchedulerAutoArm {
  readonly #o: AutoArmOptions;
  readonly #now: () => number;
  readonly #batch: number;
  /** vault → the kind of its last blocker that was logged. */
  readonly #logged = new Map<string, string>();
  #results: AutoArmResult[] = [];
  #pending: number | null = null;
  #oldestWaitingMs: number | null = null;
  #lastArmedAt: number | null = null;
  #armed = 0;
  #lastError: string | null = null;
  #failingSince: number | null = null;

  constructor(options: AutoArmOptions) {
    this.#o = options;
    this.#now = options.now ?? (() => Date.now());
    this.#batch = options.batch ?? AUTO_ARM_BATCH;
  }

  get enabled(): boolean {
    return this.#o.enabled;
  }

  async step(): Promise<AutoArmTick> {
    if (!this.#o.enabled) return { ran: false, moved: [], pending: null, error: null, alert: nothing };
    const at = this.#now();
    let pending: Awaited<ReturnType<AutoArmStore["pending"]>>;
    try {
      pending = await this.#o.store.pending(this.#batch);
    } catch (error) {
      // pending and the oldest wait stay what the last step read: the streak's own age carries the alert.
      return this.#failed(at, `the enrolled draining vaults could not be read: ${summarizeUpstreamError(error, { take: 3, maxChars: 300 })}`, []);
    }
    for (const vault of [...this.#logged.keys()]) if (!pending.rows.some((row) => row.vault === vault)) this.#logged.delete(vault);
    if (pending.rows.length === 0) {
      this.#pending = pending.total;
      this.#oldestWaitingMs = null;
      return this.#ran([], null);
    }
    let heights: ChainHeights;
    try {
      heights = await this.#o.heights();
    } catch (error) {
      this.#pending = pending.total;
      this.#oldestWaitingMs = pending.rows[0]!.waitingMs;
      return this.#failed(at, `the chain's block heights could not be read: ${summarizeUpstreamError(error, { take: 3, maxChars: 300 })}`, []);
    }
    const moved: string[] = [];
    let error: string | null = null;
    let oldestBlocker: string | null = null;
    let oldestWaitingMs: number | null = null;
    for (const row of pending.rows) {
      let step: Step;
      try {
        step = await this.#o.handover.arm(row.vault, heights, { requiredRoles: this.#o.legacyRoles, enrolledOnly: true });
      } catch (armError) {
        const detail = `arm failed: ${summarizeUpstreamError(armError, { take: 3, maxChars: 300 })}`;
        error ??= `vault ${row.vault}: ${detail}`;
        this.#record({ vault: row.vault, moved: false, blocker: detail, at: new Date(at).toISOString() });
        if (oldestWaitingMs === null) {
          oldestWaitingMs = row.waitingMs;
          oldestBlocker = detail;
        }
        continue;
      }
      if (step.moved) {
        moved.push(row.vault);
        this.#logged.delete(row.vault);
        this.#record({ vault: row.vault, moved: true, at: new Date(at).toISOString() });
        this.#o.log("info", "auto-arm moved a vault the scheduler enrolled to the queue", { vault: row.vault, waitedMs: row.waitingMs });
        continue;
      }
      const blocker = step.blockers[0] ?? "it did not move, and arm said nothing in the way";
      this.#record({ vault: row.vault, moved: false, blocker, at: new Date(at).toISOString() });
      if (oldestWaitingMs === null) {
        oldestWaitingMs = row.waitingMs;
        oldestBlocker = blocker;
      }
      if (this.#logged.get(row.vault) !== kindOf(blocker)) {
        this.#logged.set(row.vault, kindOf(blocker));
        this.#o.log("info", "auto-arm: a vault the scheduler enrolled is waiting", { vault: row.vault, blockers: step.blockers, waitedMs: row.waitingMs });
      }
    }
    this.#pending = Math.max(0, pending.total - moved.length);
    // THE OLDEST THAT DID NOT MOVE. When every row of the batch moved it is null:
    // a younger row past the batch is not known yet, and is read next tick.
    this.#oldestWaitingMs = oldestWaitingMs;
    if (moved.length > 0) {
      this.#lastArmedAt = at;
      this.#armed += moved.length;
    }
    if (error !== null) return this.#failed(at, error, moved, oldestBlocker);
    return this.#ran(moved, oldestBlocker);
  }

  #record(result: AutoArmResult): void {
    this.#results = [result, ...this.#results.filter((r) => r.vault !== result.vault)].slice(0, AUTO_ARM_RESULTS_KEPT);
  }

  /** A step that ran clean: the failure streak ends; the alert is the waiting alone. */
  #ran(moved: readonly string[], why: string | null): AutoArmTick {
    this.#lastError = null;
    this.#failingSince = null;
    return { ran: true, moved, pending: this.#pending, error: null, alert: autoArmAlert({ failingForMs: null, oldestWaitingMs: this.#oldestWaitingMs, pending: this.#pending, why }) };
  }

  /** A step that failed somewhere: the streak starts or goes on; the alert is the longer of it and the waiting. */
  #failed(at: number, error: string, moved: readonly string[], why: string | null = null): AutoArmTick {
    this.#lastError = error;
    this.#failingSince ??= at;
    const failingForMs = at - this.#failingSince;
    this.#o.log("warn", "the auto-arm step failed; the tick goes on and the next one tries again", { detail: error, failingForMs });
    return {
      ran: true,
      moved,
      pending: this.#pending,
      error,
      alert: autoArmAlert({ failingForMs, oldestWaitingMs: this.#oldestWaitingMs, pending: this.#pending, why: why ?? error }),
    };
  }

  status(): AutoArmStatus {
    return {
      enabled: this.#o.enabled,
      legacyRoles: [...this.#o.legacyRoles],
      pending: this.#pending,
      oldestWaitingMs: this.#oldestWaitingMs,
      lastArmedAt: this.#lastArmedAt === null ? null : new Date(this.#lastArmedAt).toISOString(),
      armed: this.#armed,
      lastResults: [...this.#results],
      lastError: this.#lastError,
      failingSince: this.#failingSince === null ? null : new Date(this.#failingSince).toISOString(),
    };
  }
}
