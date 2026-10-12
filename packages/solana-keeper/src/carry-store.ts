// SIP_SOLANA_CARRY_STORE: where the losses zero settles carry forward are kept
// (dispatcher ADR §4.6, decision S-4; rollout L2; safety §3).
//
// TODAY (`off`, the default). The CarryBook lives in the keeper's memory
// (bin/keeper.mts, settleCarries). A restart forgets every pending carry, and the
// window above it is then charged on its own profit: an OVER-CHARGE, pinned by
// test-local/backlog-local.local.test.ts ("one over an empty book, standing in for
// a restart, charges the trade whole"). A deploy is a restart. pendingCarries was
// 0 on both keepers when the ADR measured it (F/ topology §7); the hole is the one
// way a loss is forgotten that the wallet's own 100 signed transactions did not
// decide.
//
// THE THREE PHASES, one variable, strict, `off` unless named:
//
//   | phase | decisions come from         | writes                         | the store fails              |
//   |-------|-----------------------------|--------------------------------|------------------------------|
//   | off   | memory                      | memory                         | —                            |
//   | dual  | memory, seeded from the DB  | memory, then the DB (2 s)      | warn `carry-store`; the      |
//   |       | at boot                     | — compared on every read       | settle goes on, as today     |
//   | on    | the DB, read through on     | the DB, before the send; the   | RETRY: nothing is decided    |
//   |       | every turn; memory mirrors  | memory mirrors it              | or sent without its carry    |
//   |       | it for /status              |                                |                              |
//
// WHY `on` READS THROUGH (ADR RT-8). A boot-loaded cache misses a carry the old
// container writes during the deploy overlap: its last settle records the carry
// for the state it leaves, and the new container booted before that row existed.
// One indexed SELECT per PROFIT turn that walks is the price of seeing it.
//
// WHY `dual` IS SEEDED AT BOOT (ADR RT-20). Rolling `on` back to `dual` must not
// reopen the hole: the rows `on` wrote are loaded into memory before the first
// sweep, so the next win of every pending carry is still netted. A seeded row can
// only LOWER a base (settle-decision.ts, LossCarry: a carry only lowers a base).
//
// WHICH WAY EACH ERROR FAILS, the reason the store may be wrong at all:
//   * a missing row over-charges, which is today's restart;
//   * a stale row cannot match: its key is a link state the chain has left;
//   * a wrong row can only lower a base, an under-charge, never an over-charge.
//
// `on` FAILS CLOSED, IN THE USER'S FAVOUR. A carry that cannot be read is a base
// that cannot be known, and a carry that cannot be written is a loss the next
// window might forget; either ends the turn RETRY before anything is sent, and the
// settle waits for the store. An armed keeper already goes dry without its
// database claim (read-model.ts, claimSingleton), so this adds no new dependency.
//
// A STORE THAT IS DOWN IS ONE PAGE, NOT ONE PER WALLET (review, 2026-10-12; ADR
// §4.10 amendment 1). The store is one table that every PROFIT wallet's turn
// reads, so when it cannot be used every such turn comes back RETRY at once. Fed
// to the per-wallet ladder (settleAlert), that was N "A settlement keeps not
// landing" criticals on the third sweep, none of them naming the store, and —
// under dep-down — none held, because nothing tied them to the database. So:
//   * a turn the store could not serve says so (SettleResult.waitingOn), and the
//     per-wallet ladder neither counts nor raises it (settleRetryStreak,
//     settleAlert in settle-decision.ts): the wallet did nothing wrong;
//   * the cause pages ONCE, under its own key: `carry-store` warns at the first
//     failure and, in `on`, where settles wait for it, pages critical once the
//     store has gone CARRY_STORE_CRITICAL_AFTER_MS without one answer — a store
//     that is not ready included, the table missing too, because in `on` that
//     keeper does not act at all (liveBlocker);
//   * every round trip is told to the `database` watch (CarryStoreHooks.observe,
//     databaseAnswered), and under dep-down `carry-store` is one of the alerts a
//     database outage explains (src/dependency-watch.ts): while dep-down:database
//     pages, the store's own page is held, and the outage is one message.
//
// THE STORE SEES ONLY MODES THAT CARRY LOSSES (role-registry.ts, carriesLosses):
// PROFIT. A VOLUME turn decides and records exactly as `off` does, in memory, and
// the volume keeper refuses a store other than `off` at boot (config.ts): it would
// hold nothing, and a variable that is accepted and does nothing is the failure
// SIP_SOLANA_CUTS exists to prevent.
//
// THE GATE `on` ADDS, AND WHY L2 NEEDS ONE (ADR T-C3, T-C4; safety §3.3).
// recordCarry deletes every row of the link but the current state's, before the
// send. With one writer that is today's memory rule. With two — a deploy overlap
// in which the old container's last settle is still in flight when the new one
// takes the claim, or a lock lost in silence — the delete can erase the row of the
// settle that actually lands, and its loss is forgotten: the over-charge again. So
// in `on` the write refuses, as RETRY with nothing sent, when a row for the state
// AFTER this one stands in its way that this attempt would not have written
// identically: the chain is asked for the link's nonce — moved means this turn is
// stale, unmoved with that settle's deadline not yet passed means it may still
// land and this turn waits for it, and only a dead row (unmoved, past its
// deadline) is deleted as memory would delete it. A row for a later state still,
// or another epoch above this one, means this turn read an old link: refused
// without asking. L5's send intents replace this with the gate transaction; the
// rule it enforces is the same.

import pg from "pg";
import { summarizeUpstreamError, type Secret } from "@sip/solana-log";
import type { Alert } from "./alerts.js";
import type { ManagedLink } from "./discovery.js";
import { READ_MODEL_SCHEMA, databaseAnswered, sslFor, type DatabaseObserver } from "./read-model.js";
import { keeperModeFor } from "./role-registry.js";
import { carryFor, recordCarry, type CarryBook, type LossCarry } from "./settle-decision.js";

/** The table, in sql/sip_solana.sql. NOT derived and NOT rebuildable: the header there says so. */
export const LOSS_CARRY_TABLE = "loss_carry";

/** The columns this file reads and writes; ready() refuses a table missing any of them. */
export const LOSS_CARRY_COLUMNS = [
  "link_addr",
  "epoch",
  "settlement_nonce",
  "frontier_slot",
  "loss_lamports",
  "wallet_signed_tx_count",
  "valid_until_slot",
  "written_by",
  "written_at",
] as const;

/**
 * How long one read or one write of the store may take before it counts as
 * failed: 2 s (ADR §4.6, ASSUMED there and not measured since). Well under a
 * sweep: a store that answers slower than this is treated as down, which in `on`
 * means the settle waits.
 */
export const CARRY_STORE_BUDGET_MS = 2_000;

/**
 * The advisory-lock class every carry write locks its link under: the two-key
 * form, whose key space Postgres keeps apart from the one-key form the singleton
 * claim uses (read-model.ts), so a link's hash can never meet the claim.
 */
export const CARRY_LOCK_CLASS = 0x5c4a7;

/**
 * The alert a store that could not be used raises: the ONE page for that cause
 * (the header says why there is no per-wallet one). Warn in `dual`, where the
 * settle went on; in `on` it warns, then pages critical (carryStoreAlert).
 */
export const CARRY_STORE_ALERT_KEY = "carry-store";

/**
 * How long, in `on`, the store may go without one answer before `carry-store`
 * pages critical: two minutes. That is the third sweep at the default 60 s
 * cadence, which is where a wallet's RETRY streak paged before the store had its
 * own page (SETTLE_RETRY_CRITICAL_AFTER = 3): the settles that wait on the store
 * are woken for exactly as soon as they were, once instead of once per wallet.
 * Shorter would page a store that dropped one 2 s budget and answered the next
 * sweep — a settle that waited one minute is not a page.
 */
export const CARRY_STORE_CRITICAL_AFTER_MS = 120_000;
/** The alert a `dual` read that disagreed with memory raises, once per key: it blocks moving to `on`. */
export const CARRY_MISMATCH_ALERT_KEY = "carry-mismatch";

/** The part of a link a carry is keyed by. */
export type CarryLink = Pick<ManagedLink, "linkAddress" | "epoch" | "settlementNonce" | "frontierSlot">;

/** One row of the store, as the boot seed reads it. */
export interface StoredCarry {
  readonly link: string;
  readonly epoch: bigint;
  readonly settlementNonce: bigint;
  readonly frontierSlot: bigint;
  readonly carry: LossCarry;
}

/** What `on`'s gate needs from the turn that is about to send (settle-tick.ts). */
export interface CarryGate {
  /** The chain's confirmed slot the turn read for its attestation's deadline. */
  readonly currentSlot: bigint;
  /**
   * The link's settlement nonce on chain now, or null when it could not be read.
   * Asked only when a row this attempt would not have written stands in the way:
   * another process's (a deploy overlap, or a restart within a settle's life) or
   * another window's. One process retrying one state writes the same row, and is
   * not asked.
   */
  readonly nonceNow: () => Promise<bigint | null>;
}

/** What a write is told by the turn about to send: the settle's deadline, and `on`'s gate or none. */
export interface CarryWriteOptions {
  /**
   * The attestation's valid_until_slot: the settle this write precedes cannot land
   * after it. Stored with the row in every phase, so a successor can tell whether
   * it still might — `dual`'s rows too, for the day the store moves to `on`.
   */
  readonly validUntilSlot: bigint;
  /** `on`'s gate (the header); null writes by memory's rule alone. */
  readonly gate: CarryGate | null;
}

/** What settle-tick.ts hands DurableCarries for a write: the deadline and everything the gate may need. */
export type CarryTurnWrite = CarryGate & { readonly validUntilSlot: bigint };

/** A write's answer: done, or refused by `on`'s gate with the reason the turn reports. */
export type CarryWrite = { readonly kind: "written" } | { readonly kind: "refused"; readonly detail: string };

/** A durable store of carries: the Postgres one, or MemoryCarryStore, its model. */
export interface DurableCarryStore {
  /** The carry for the link's exact state, or null. READ-ONLY: a non-holder's dry run reads it too. */
  carryFor(link: CarryLink): Promise<LossCarry | null>;
  /**
   * recordCarry's rule: every row of the link but the current state's goes, and
   * the state the settle leaves gets `carry`, or nothing. With a gate, `on`'s rule
   * first (the header above); without one, exactly memory's.
   */
  recordCarry(link: CarryLink, endSlot: bigint, carry: LossCarry | null, options: CarryWriteOptions): Promise<CarryWrite>;
  /** Every row, for the boot seed. */
  loadAll(): Promise<readonly StoredCarry[]>;
  /** Whether the table is there with every column this file uses. */
  ready(): Promise<{ readonly ok: boolean; readonly detail: string }>;
}

const stateKey = (epoch: bigint, settlementNonce: bigint, frontierSlot: bigint): string => `${epoch}:${settlementNonce}:${frontierSlot}`;

const refusedLossDetail = (carry: LossCarry): string =>
  `a carried loss is positive, not ${carry.lossLamports} lamports: a carry that is not a loss would raise the next base`;

/**
 * The store's model, over its own CarryBook: settle-decision.ts's carryFor and
 * recordCarry, unchanged. The agreement test runs it beside PgCarryStore over the
 * same sequences; the unit tests use it as a store that can be made to fail.
 *
 * ITS GATE IS NONE. Memory has one writer by construction; the gate exists for
 * the case it cannot have.
 */
export class MemoryCarryStore implements DurableCarryStore {
  readonly book: CarryBook = new Map();

  async carryFor(link: CarryLink): Promise<LossCarry | null> {
    return carryFor(this.book, link);
  }

  async recordCarry(link: CarryLink, endSlot: bigint, carry: LossCarry | null): Promise<CarryWrite> {
    recordCarry(this.book, link, endSlot, carry);
    return { kind: "written" };
  }

  async loadAll(): Promise<readonly StoredCarry[]> {
    const out: StoredCarry[] = [];
    for (const [link, entries] of this.book) {
      for (const [state, carry] of entries) {
        const [epoch, settlementNonce, frontierSlot] = state.split(":").map((part) => BigInt(part));
        out.push({ link, epoch: epoch!, settlementNonce: settlementNonce!, frontierSlot: frontierSlot!, carry });
      }
    }
    return out;
  }

  async ready(): Promise<{ readonly ok: boolean; readonly detail: string }> {
    return { ok: true, detail: "memory" };
  }
}

/** What PgCarryStore needs of pg: a pool that lends clients. pg.Pool is one. */
export interface CarryPool {
  connect(): Promise<CarryClient>;
}

export interface CarryClient {
  query(text: string, values?: unknown[]): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
  release(destroy?: boolean): void;
}

/** A row as `on`'s gate reads it, under the link's lock. */
interface GateRow {
  readonly epoch: bigint;
  readonly settlementNonce: bigint;
  readonly frontierSlot: bigint;
  readonly lossLamports: bigint;
  readonly walletSignedTxCount: number;
  readonly validUntilSlot: bigint;
  readonly writtenBy: string;
}

const TABLE = `${READ_MODEL_SCHEMA}.${LOSS_CARRY_TABLE}`;

/**
 * The carries in Postgres: sip_solana.loss_carry, keyed exactly as the CarryBook
 * (`${epoch}:${settlementNonce}:${frontierSlot}` per link, carryKey in
 * settle-decision.ts).
 *
 * carryFor IS A SELECT BY THE FULL KEY, READ-ONLY. Memory prunes other epochs and
 * lower nonces as it reads; here pruning moves to the write, which deletes every
 * row of the link but the current state's. A row a read would have pruned can
 * never match again (a nonce only grows within an epoch, and the epoch only
 * grows), so the answers are the same; the agreement test pins it.
 *
 * recordCarry IS ONE TRANSACTION under the link's advisory lock: read the link's
 * rows, apply `on`'s gate when one is given, delete every row but the current
 * state's, and upsert the post-state row. ON CONFLICT DO UPDATE is safe because a
 * window measured from one state is deterministic: two attempts from one state
 * write one carry (settle-decision.test.ts pins the determinism).
 */
export class PgCarryStore implements DurableCarryStore {
  constructor(
    private readonly pool: CarryPool,
    /** Who writes: one id per process, so a successor can tell another keeper's row from its own. */
    readonly writer: string,
  ) {}

  async carryFor(link: CarryLink): Promise<LossCarry | null> {
    const client = await this.pool.connect();
    let broken = false;
    try {
      const { rows } = await client.query(
        `SELECT loss_lamports, wallet_signed_tx_count FROM ${TABLE}
          WHERE link_addr = $1 AND epoch = $2 AND settlement_nonce = $3 AND frontier_slot = $4`,
        [link.linkAddress.toBase58(), link.epoch.toString(), link.settlementNonce.toString(), link.frontierSlot.toString()],
      );
      const row = rows[0];
      return row === undefined ? null : { lossLamports: BigInt(String(row["loss_lamports"])), walletSignedTxCount: Number(row["wallet_signed_tx_count"]) };
    } catch (error) {
      broken = true;
      throw error;
    } finally {
      client.release(broken);
    }
  }

  async recordCarry(link: CarryLink, endSlot: bigint, carry: LossCarry | null, { validUntilSlot, gate }: CarryWriteOptions): Promise<CarryWrite> {
    // THE CODE REFUSES IT FIRST, as memory's recordCarry does; the table's CHECK
    // refuses it again, for any other writer.
    if (carry !== null && carry.lossLamports <= 0n) throw new Error(refusedLossDetail(carry));
    const address = link.linkAddress.toBase58();
    const client = await this.pool.connect();
    let broken = false;
    try {
      await client.query("BEGIN");
      // ONE WRITER PER LINK AT A TIME, rows or none: FOR UPDATE locks no row that is not there yet.
      await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [CARRY_LOCK_CLASS, address]);
      const { rows } = await client.query(
        `SELECT epoch, settlement_nonce, frontier_slot, loss_lamports, wallet_signed_tx_count, valid_until_slot, written_by
           FROM ${TABLE} WHERE link_addr = $1`,
        [address],
      );
      if (gate !== null) {
        const refusal = await gateRefusal(
          rows.map((row) => ({
            epoch: BigInt(String(row["epoch"])),
            settlementNonce: BigInt(String(row["settlement_nonce"])),
            frontierSlot: BigInt(String(row["frontier_slot"])),
            lossLamports: BigInt(String(row["loss_lamports"])),
            walletSignedTxCount: Number(row["wallet_signed_tx_count"]),
            validUntilSlot: BigInt(String(row["valid_until_slot"])),
            writtenBy: String(row["written_by"]),
          })),
          { link, endSlot, carry, gate, writer: this.writer },
        );
        if (refusal !== null) {
          await client.query("ROLLBACK");
          return { kind: "refused", detail: refusal };
        }
      }
      await client.query(
        `DELETE FROM ${TABLE}
          WHERE link_addr = $1 AND (epoch, settlement_nonce, frontier_slot) <> ($2::bigint, $3::bigint, $4::bigint)`,
        [address, link.epoch.toString(), link.settlementNonce.toString(), link.frontierSlot.toString()],
      );
      if (carry !== null) {
        await client.query(
          `INSERT INTO ${TABLE}
             (link_addr, epoch, settlement_nonce, frontier_slot, loss_lamports, wallet_signed_tx_count, valid_until_slot, written_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (link_addr, epoch, settlement_nonce, frontier_slot) DO UPDATE SET
             loss_lamports = EXCLUDED.loss_lamports,
             wallet_signed_tx_count = EXCLUDED.wallet_signed_tx_count,
             valid_until_slot = EXCLUDED.valid_until_slot,
             written_by = EXCLUDED.written_by,
             written_at = clock_timestamp()`,
          [
            address,
            link.epoch.toString(),
            (link.settlementNonce + 1n).toString(),
            endSlot.toString(),
            carry.lossLamports.toString(),
            carry.walletSignedTxCount,
            validUntilSlot.toString(),
            this.writer,
          ],
        );
      }
      await client.query("COMMIT");
      return { kind: "written" };
    } catch (error) {
      broken = true;
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      // A CLIENT THAT FAILED MID-TRANSACTION IS DESTROYED, never handed back to
      // the pool with a transaction open on it.
      client.release(broken);
    }
  }

  async loadAll(): Promise<readonly StoredCarry[]> {
    const client = await this.pool.connect();
    let broken = false;
    try {
      const { rows } = await client.query(
        `SELECT link_addr, epoch, settlement_nonce, frontier_slot, loss_lamports, wallet_signed_tx_count FROM ${TABLE}
          ORDER BY link_addr, epoch, settlement_nonce, frontier_slot`,
      );
      return rows.map((row) => ({
        link: String(row["link_addr"]),
        epoch: BigInt(String(row["epoch"])),
        settlementNonce: BigInt(String(row["settlement_nonce"])),
        frontierSlot: BigInt(String(row["frontier_slot"])),
        carry: { lossLamports: BigInt(String(row["loss_lamports"])), walletSignedTxCount: Number(row["wallet_signed_tx_count"]) },
      }));
    } catch (error) {
      broken = true;
      throw error;
    } finally {
      client.release(broken);
    }
  }

  async ready(): Promise<{ readonly ok: boolean; readonly detail: string }> {
    let client: CarryClient | undefined;
    let broken = false;
    try {
      client = await this.pool.connect();
      const { rows } = await client.query(
        `SELECT c.name FROM unnest($1::text[]) AS c(name)
          WHERE NOT EXISTS (
            SELECT 1 FROM information_schema.columns
             WHERE table_schema = $2 AND table_name = $3 AND column_name = c.name)`,
        [[...LOSS_CARRY_COLUMNS], READ_MODEL_SCHEMA, LOSS_CARRY_TABLE],
      );
      const missing = rows.map((row) => String(row["name"]));
      if (missing.length === LOSS_CARRY_COLUMNS.length) {
        return { ok: false, detail: `${TABLE} does not exist; run \`pnpm --dir packages/solana-keeper setup-read-model\` against this database` };
      }
      if (missing.length > 0) {
        return { ok: false, detail: `${TABLE} is missing ${missing.join(", ")}; run \`pnpm --dir packages/solana-keeper setup-read-model\` against this database` };
      }
      return { ok: true, detail: `${TABLE} is reachable and complete` };
    } catch (error) {
      // THROWN, NOT ANSWERED AS NOT READY: a round trip that failed is the
      // database's silence or its error, and only DurableCarries — which tells the
      // `database` watch (CarryStoreHooks.observe) — can say which. It reports it
      // as "could not be checked", as it always did.
      broken = true;
      throw error;
    } finally {
      client?.release(broken);
    }
  }
}

/**
 * `on`'s gate over the link's rows, read under its lock: null to go ahead, or why
 * this turn must not write, and so must not send. The header explains the rule.
 */
export async function gateRefusal(
  rows: readonly GateRow[],
  write: { readonly link: CarryLink; readonly endSlot: bigint; readonly carry: LossCarry | null; readonly gate: CarryGate; readonly writer: string },
): Promise<string | null> {
  const { link, endSlot, carry, gate, writer } = write;
  const next = link.settlementNonce + 1n;
  // A LATER STATE THAN THE ONE THIS TURN WILL LEAVE, OR A LATER EPOCH: someone saw
  // this link past the state this sweep read. Nonces only grow within an epoch, and
  // epochs only grow, so this turn's link is old, and its settle would be refused.
  const later = rows.find((row) => row.epoch > link.epoch || (row.epoch === link.epoch && row.settlementNonce > next));
  if (later !== undefined) {
    return (
      `the carry store already holds a carry for state ${stateKey(later.epoch, later.settlementNonce, later.frontierSlot)} of this link, ` +
      `past the state this sweep read (${stateKey(link.epoch, link.settlementNonce, link.frontierSlot)}): the link has moved since, so nothing was sent`
    );
  }
  // A ROW FOR THE STATE THIS SETTLE WOULD LEAVE that this attempt would not write
  // identically: another keeper's, or another window's. Its settle may have landed,
  // or may still land, and the delete below would forget its loss.
  const inTheWay = rows.filter(
    (row) =>
      row.epoch === link.epoch &&
      row.settlementNonce === next &&
      !(
        row.writtenBy === writer &&
        carry !== null &&
        row.frontierSlot === endSlot &&
        row.lossLamports === carry.lossLamports &&
        row.walletSignedTxCount === carry.walletSignedTxCount
      ),
  );
  if (inTheWay.length === 0) return null;
  const nonce = await gate.nonceNow().catch(() => null);
  if (nonce === null || nonce < link.settlementNonce) {
    return (
      "a settle from this link's state was recorded by another attempt, and the link's nonce could not be read to tell whether it " +
      "landed or may still land; nothing was sent, and the next sweep asks again"
    );
  }
  if (nonce > link.settlementNonce) {
    return `the link's nonce is ${nonce} on chain, past the ${link.settlementNonce} this sweep read: another settle landed first, so nothing was sent`;
  }
  const deadline = inTheWay.reduce((latest, row) => (row.validUntilSlot > latest ? row.validUntilSlot : latest), 0n);
  if (deadline >= gate.currentSlot) {
    return (
      `a settle another attempt sent from this state may still land until slot ${deadline} (the chain is at ${gate.currentSlot}), ` +
      "and its carry must not be deleted under it: this turn waits for it, and nothing was sent"
    );
  }
  // DEAD: the link has not moved and that settle's deadline has passed, so it can
  // never land; its row is deleted below, as memory deletes an earlier attempt's.
  return null;
}

/** What one turn's read answers: the carry, or why the store could not say. */
export type CarryRead = { readonly carry: LossCarry | null } | { readonly unavailable: string };

/**
 * What one turn's write answers: the store's own answer (written, or refused by
 * `on`'s gate — THIS link's business, so its wallet's ladder counts it), or
 * `unavailable`: the store could not be written at all, which is every PROFIT
 * wallet's business at once and is paged as the store's (CARRY_STORE_ALERT_KEY),
 * never as the wallet's.
 */
export type CarryTurnWriteResult = CarryWrite | { readonly kind: "unavailable"; readonly detail: string };

/** The part of DurableCarries a settle turn uses (SettleDeps.carryStore). */
export interface CarryStoreTurn {
  carryFor(book: CarryBook, link: CarryLink, mode: number): Promise<CarryRead>;
  recordCarry(
    book: CarryBook,
    link: CarryLink,
    endSlot: bigint,
    carry: LossCarry | null,
    mode: number,
    turn: CarryTurnWrite,
  ): Promise<CarryTurnWriteResult>;
}

/** A `dual` read that disagreed with memory: what each said, for /status and the alert. */
export interface CarryMismatch {
  readonly at: string;
  readonly link: string;
  readonly state: string;
  readonly memory: LossCarry | null;
  readonly db: LossCarry | null;
}

/** /status's view of the store. Absent while it is `off`. */
export interface CarryStoreStatus {
  readonly mode: "dual" | "on";
  /** Null once ready; otherwise why not. In `on`, while it is not null the keeper does not act. */
  readonly notReady: string | null;
  /** Rows the boot seed loaded that memory had not seen; null until a seed has succeeded. */
  readonly dbOnlyAtBoot: number | null;
  /** Decisions that used a row the boot seed brought in: the restart hole closing. */
  readonly decidedWithDbRow: number;
  readonly written: number;
  readonly writeFailures: number;
  readonly readFailures: number;
  /** `dual` reads compared with memory. */
  readonly compared: number;
  /** Compared reads where both held the same carry: the "≥ 1 carry seen in both" of the gate to `on`. */
  readonly seenInBoth: number;
  readonly mismatches: number;
  readonly lastMismatch: CarryMismatch | null;
  /** `on` writes the gate refused: another settle's row stood in the way. */
  readonly refusedAtGate: number;
  readonly lastProblem: { readonly at: string; readonly what: "read" | "write" | "seed" | "ready"; readonly detail: string } | null;
}

/** What DurableCarries tells the keeper: alerts and log lines. Each call is its own; a throw from one is swallowed. */
export interface CarryStoreHooks {
  fire(alert: Alert): void;
  clear(key: string): void;
  warn(message: string, fields: Record<string, unknown>): void;
  /**
   * Told whether each round trip to the store got an answer from the database
   * (databaseAnswered: an error Postgres itself sent is an answer; a refused or
   * dropped connection, or this file's own budget running out, is not). For the
   * dep-down token's `database` watch and nothing else, exactly as the read
   * model's observer: absent, nothing is told and nothing is classified.
   */
  readonly observe?: DatabaseObserver;
}

/**
 * The page a store failure raises: the one alert for that cause, whichever wallet
 * met it. A warn — and, in `on`, a CRITICAL once the store has gone
 * CARRY_STORE_CRITICAL_AFTER_MS (`failingForMs`) without one answer, because
 * there every PROFIT settle is waiting on it (and, while it is not ready, the
 * keeper does not act at all). The critical breaks through the warn's dedup
 * window (alerts.ts: an escalation is not a repeat). `dual` never pages: its
 * settles go on from memory.
 */
export function carryStoreAlert(mode: "dual" | "on", what: "read" | "write" | "seed" | "ready", detail: string, failingForMs = 0): Alert {
  const critical = mode === "on" && failingForMs >= CARRY_STORE_CRITICAL_AFTER_MS;
  return {
    key: CARRY_STORE_ALERT_KEY,
    severity: critical ? "critical" : "warn",
    title: "The loss-carry store could not be used",
    detail:
      `Postgres ${what} failed: ${detail}. ` +
      (mode === "on"
        ? (critical ? `It has not answered for ${Math.round(failingForMs / 1000)} s. ` : "") +
          "SIP_SOLANA_CARRY_STORE is on, so PROFIT settles wait (RETRY, nothing sent) until it answers" +
          (what === "ready" ? ", and this keeper does not act until it is ready (missingLiveCondition on /status)." : ".") +
          " Each wallet's /status row says RETRY; no wallet is paged for it. See carryStore.lastProblem on /status."
        : "SIP_SOLANA_CARRY_STORE is dual: settles go on from memory, as with off, and this row was not compared."),
    context: { mode, what },
  };
}

/** The notice a `dual` mismatch raises: once, until cleared by hand; it blocks moving to `on`. */
export function carryMismatchAlert(mismatch: CarryMismatch, total: number): Alert {
  const show = (carry: LossCarry | null) => (carry === null ? "none" : `${carry.lossLamports} lamports / ${carry.walletSignedTxCount} txs`);
  return {
    key: CARRY_MISMATCH_ALERT_KEY,
    severity: "warn",
    title: "The loss-carry store disagrees with memory",
    detail:
      `Link ${mismatch.link} at ${mismatch.state}: memory holds ${show(mismatch.memory)}, Postgres ${show(mismatch.db)} ` +
      `(${total} mismatch${total === 1 ? "" : "es"} since boot). Memory decided, as dual does. Do not move to on until this is understood.`,
    context: { link: mismatch.link, state: mismatch.state, total },
    once: true,
  };
}

const sameCarry = (a: LossCarry | null, b: LossCarry | null): boolean =>
  a === null || b === null ? a === b : a.lossLamports === b.lossLamports && a.walletSignedTxCount === b.walletSignedTxCount;

/**
 * The store as the keeper uses it in `dual` or `on`: memory and Postgres, which
 * one decides, what is compared and counted, and what is alerted. One per process.
 */
export class DurableCarries implements CarryStoreTurn {
  /** Rows the boot seed loaded, by `${link}|${state}`, until a decision uses one. */
  readonly #seeded = new Set<string>();
  #notReady: string | null = "not checked yet";
  #dbOnlyAtBoot: number | null = null;
  #decidedWithDbRow = 0;
  #written = 0;
  #writeFailures = 0;
  #readFailures = 0;
  #compared = 0;
  #seenInBoth = 0;
  #mismatches = 0;
  #lastMismatch: CarryMismatch | null = null;
  #refusedAtGate = 0;
  #lastProblem: CarryStoreStatus["lastProblem"] = null;
  /**
   * When the store last started failing with no answer since, or null while it
   * answers: what `carry-store`'s severity is judged on (carryStoreAlert). Any
   * answer — a read, a write, the seed, a ready table — ends the run.
   */
  #failingSince: number | null = null;

  constructor(
    readonly mode: "dual" | "on",
    private readonly store: DurableCarryStore,
    private readonly hooks: CarryStoreHooks,
    private readonly budgetMs: number = CARRY_STORE_BUDGET_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Whether the table is there, asked at boot and, while it is not, again before
   * every sweep (bin/keeper.mts). Null when ready.
   */
  async checkReady(): Promise<string | null> {
    const answer = await this.#within(this.store.ready());
    if (!answer.ok) this.#notReady = `the loss-carry store could not be checked: ${summarizeUpstreamError(answer.error)}`;
    else this.#notReady = answer.value.ok ? null : answer.value.detail;
    if (this.#notReady !== null) this.#problem("ready", this.#notReady);
    else this.#answered();
    return this.#notReady;
  }

  /**
   * What stops this keeper from acting, or null. ONLY `on` WAITS FOR THE STORE: a
   * keeper whose decisions come from a table that is not there must not sign
   * anything, while `dual`, deciding from memory, acts as `off` would.
   */
  liveBlocker(): string | null {
    if (this.mode !== "on" || this.#notReady === null) return null;
    return `SIP_SOLANA_CARRY_STORE is on and the loss-carry store is not ready: ${this.#notReady}`;
  }

  /**
   * Readiness, then the seed, each until it has succeeded once: called before the
   * first sweep and before every sweep after (bin/keeper.mts). Once both are done
   * it asks nothing.
   */
  async prepare(book: CarryBook): Promise<void> {
    if (this.#notReady !== null && (await this.checkReady()) !== null) return;
    if (this.#dbOnlyAtBoot === null) await this.seed(book);
  }

  /**
   * THE BOOT SEED, both phases: every row into memory, so `dual` decides with what
   * `on` wrote (RT-20) and /status shows, after a deploy, the carries that were
   * pending before it. A row memory already holds for the same state is left as
   * it is. A failure leaves memory as it was — today's restart — says so, and
   * prepare() tries again before the next sweep: until then `dual` decides
   * without the rows, as `off` would.
   */
  async seed(book: CarryBook): Promise<void> {
    const answer = await this.#within(this.store.loadAll());
    if (!answer.ok) {
      this.#problem("seed", summarizeUpstreamError(answer.error));
      return;
    }
    this.#answered();
    let loaded = 0;
    for (const row of answer.value) {
      const state = stateKey(row.epoch, row.settlementNonce, row.frontierSlot);
      const entries = book.get(row.link) ?? new Map<string, LossCarry>();
      if (!entries.has(state)) {
        entries.set(state, row.carry);
        this.#seeded.add(`${row.link}|${state}`);
        loaded += 1;
      }
      book.set(row.link, entries);
    }
    this.#dbOnlyAtBoot = loaded;
  }

  async carryFor(book: CarryBook, link: CarryLink, mode: number): Promise<CarryRead> {
    // A MODE THAT CARRIES NO LOSS IS DECIDED AS `off` DECIDES IT.
    if (keeperModeFor(mode)?.carriesLosses !== true) return { carry: carryFor(book, link) };
    const address = link.linkAddress.toBase58();
    const state = stateKey(link.epoch, link.settlementNonce, link.frontierSlot);
    // MEMORY READS FIRST, IN BOTH PHASES: it decides in `dual`, and in `on` its
    // pruning keeps /status's mirror as `off` would keep it.
    const memory = carryFor(book, link);
    const db = await this.#within(this.store.carryFor(link));
    if (!db.ok) {
      this.#readFailures += 1;
      const detail = summarizeUpstreamError(db.error);
      this.#problem("read", detail);
      if (this.mode === "on") return { unavailable: `the loss-carry store could not be read (${detail})` };
      return { carry: this.#decided(address, state, memory) };
    }
    this.#answered();
    if (this.mode === "on") {
      // THE MIRROR: what Postgres holds for this state, so /status shows it.
      if (db.value !== null) {
        const entries = book.get(address) ?? new Map<string, LossCarry>();
        entries.set(state, db.value);
        book.set(address, entries);
      }
      return { carry: this.#decided(address, state, db.value) };
    }
    this.#compared += 1;
    if (sameCarry(memory, db.value)) {
      if (memory !== null) this.#seenInBoth += 1;
    } else {
      this.#mismatches += 1;
      this.#lastMismatch = { at: new Date(this.now()).toISOString(), link: address, state, memory, db: db.value };
      this.#tell(() => this.hooks.fire(carryMismatchAlert(this.#lastMismatch!, this.#mismatches)));
    }
    return { carry: this.#decided(address, state, memory) };
  }

  async recordCarry(
    book: CarryBook,
    link: CarryLink,
    endSlot: bigint,
    carry: LossCarry | null,
    mode: number,
    turn: CarryTurnWrite,
  ): Promise<CarryTurnWriteResult> {
    if (keeperModeFor(mode)?.carriesLosses !== true) {
      recordCarry(book, link, endSlot, carry);
      return { kind: "written" };
    }
    if (this.mode === "dual") {
      // MEMORY FIRST, EXACTLY AS `off`: the settle goes on whatever Postgres says.
      recordCarry(book, link, endSlot, carry);
      const written = await this.#within(this.store.recordCarry(link, endSlot, carry, { validUntilSlot: turn.validUntilSlot, gate: null }));
      if (!written.ok) {
        this.#writeFailures += 1;
        this.#problem("write", summarizeUpstreamError(written.error));
      } else {
        this.#written += 1;
        this.#answered();
      }
      return { kind: "written" };
    }
    // `on`: THE DB FIRST, AND NOTHING IS SENT WITHOUT IT.
    if (carry !== null && carry.lossLamports <= 0n) throw new Error(refusedLossDetail(carry));
    const written = await this.#within(this.store.recordCarry(link, endSlot, carry, { validUntilSlot: turn.validUntilSlot, gate: turn }));
    if (!written.ok) {
      this.#writeFailures += 1;
      const detail = summarizeUpstreamError(written.error);
      this.#problem("write", detail);
      // UNAVAILABLE, NOT REFUSED: the store said nothing about this link. The
      // settle turn reports it as waiting on the store (SettleResult.waitingOn),
      // and the store's own page is the one alert for it.
      return { kind: "unavailable", detail: `the loss-carry store could not be written (${detail}); nothing was sent, and the next sweep tries again` };
    }
    // AN ANSWER, EVEN A REFUSAL: the gate read the link's rows, so the store is up.
    this.#answered();
    if (written.value.kind === "refused") {
      this.#refusedAtGate += 1;
      return written.value;
    }
    this.#written += 1;
    recordCarry(book, link, endSlot, carry);
    return written.value;
  }

  status(): CarryStoreStatus {
    return {
      mode: this.mode,
      notReady: this.#notReady,
      dbOnlyAtBoot: this.#dbOnlyAtBoot,
      decidedWithDbRow: this.#decidedWithDbRow,
      written: this.#written,
      writeFailures: this.#writeFailures,
      readFailures: this.#readFailures,
      compared: this.#compared,
      seenInBoth: this.#seenInBoth,
      mismatches: this.#mismatches,
      lastMismatch: this.#lastMismatch,
      refusedAtGate: this.#refusedAtGate,
      lastProblem: this.#lastProblem,
    };
  }

  /** The carry a decision is about to use; counted once per seeded row it came from. */
  #decided(address: string, state: string, carry: LossCarry | null): LossCarry | null {
    if (carry !== null && this.#seeded.delete(`${address}|${state}`)) this.#decidedWithDbRow += 1;
    return carry;
  }

  #problem(what: "read" | "write" | "seed" | "ready", detail: string): void {
    const at = this.now();
    this.#failingSince ??= at;
    const failingForMs = at - this.#failingSince;
    this.#lastProblem = { at: new Date(at).toISOString(), what, detail };
    this.#tell(() => this.hooks.warn("loss-carry store problem", { mode: this.mode, what, detail }));
    this.#tell(() => this.hooks.fire(carryStoreAlert(this.mode, what, detail, failingForMs)));
  }

  /** The store answered: its failing run is over, and its page is resolved. */
  #answered(): void {
    this.#failingSince = null;
    this.#tell(() => this.hooks.clear(CARRY_STORE_ALERT_KEY));
  }

  /** A hook that throws loses its report, never the settle. */
  #tell(call: () => void): void {
    try {
      call();
    } catch {
      // The status block still counts it.
    }
  }

  /**
   * `work` within the budget: its value, or what went wrong. A write that loses
   * the race may still commit after it; that row is the state this turn's settle
   * — which was not sent — would leave, and the next attempt from the same state
   * rewrites it (one state, one window, one carry) or deletes it.
   */
  async #within<T>(work: Promise<T>): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new CarryStoreTimeout(this.budgetMs)), this.budgetMs);
    });
    work.catch(() => undefined);
    try {
      const value = await Promise.race([work, late]);
      this.#observe(true);
      return { ok: true, value };
    } catch (error) {
      // THE BUDGET RUNNING OUT IS SILENCE; anything else is databaseAnswered's to say.
      this.#observe(error instanceof CarryStoreTimeout ? false : error);
      return { ok: false, error };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Tells the `database` watch, if there is one, how a round trip ended. LAZY, as
   * the read model's: with no observer the error is not even looked at.
   */
  #observe(outcome: boolean | unknown): void {
    const observe = this.hooks.observe;
    if (observe === undefined) return;
    this.#tell(() => observe(typeof outcome === "boolean" ? outcome : databaseAnswered(outcome)));
  }
}

/** The store's own budget running out: no answer from the database, in fixed words. */
class CarryStoreTimeout extends Error {
  constructor(budgetMs: number) {
    super(`no answer within ${budgetMs} ms`);
    this.name = "CarryStoreTimeout";
  }
}

/**
 * The store's own pool: ONE connection, apart from the read model's two. The
 * read model holds one of its two for the singleton claim and writes history
 * fire-and-forget on the other, and a settle must never queue behind a history
 * write for the carry it cannot go without. Every timeout is the budget's.
 */
export function createCarryPool(databaseUrl: Secret, warn: (message: string, fields: Record<string, unknown>) => void): pg.Pool {
  const connectionString = databaseUrl.reveal();
  const pool = new pg.Pool({
    connectionString,
    ssl: sslFor(connectionString),
    max: 1,
    connectionTimeoutMillis: CARRY_STORE_BUDGET_MS,
    idleTimeoutMillis: 30_000,
    statement_timeout: CARRY_STORE_BUDGET_MS,
    query_timeout: CARRY_STORE_BUDGET_MS,
  });
  // REQUIRED, as for the read model's pool: an idle client erroring emits 'error'
  // on the pool, and unhandled that takes the keeper down.
  pool.on("error", (error) => warn("loss-carry store idle pool error (ignored)", { detail: summarizeUpstreamError(error) }));
  return pool;
}
