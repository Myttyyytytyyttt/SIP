// The ledger: what the worker saw, what it refused, what it attested, what it pulled.
//
// Ported in part from the keeper of the project this was forked from (src/ledger-pg.ts: the session-scoped advisory lock and its)
// holder lookup, the connection settings, the application_name that says its mode first, the
// load-bearing 'error' listener, and the refuse-when-lost discipline. The record stream and its hash
// chain are NOT ported: every row here is a fact about volume that anyone can recompute from a public
// RPC, which is a stronger integrity property than a chain of digests over our own rows.
//
// TWO BACKENDS, ONE SET OF RULES. memoryLedger() is the reference implementation — tests, and dry runs
// without a database, use it — and the Postgres one must agree with it on every rule below. The schema
// re-states the load-bearing rules as constraints and triggers, so a missed WHERE clause cannot undo
// them.
//
// THE RULES.
//   1. Addresses and hashes are lowercased on the way in and validated; malformed input is a bug
//      upstream and throws LedgerInputError rather than being stored.
//   2. upsertWallets inserts unknown wallets (cursor = initialCursorL2, totals 0) and refreshes the
//      vault of known ones. It never touches a cursor or a total: those are the wallet's history.
//   3. recordFills upserts on (wallet, txHash). An UNWINDOWED fill may change — a block retried after
//      a refusal may decode differently, and that is what the retry is for. A WINDOWED fill is
//      committed to a batch root: re-recording it identically is a no-op, differently is a
//      LedgerConflictError. Recording a fill or an exclusion for a block CLEARS that block's refusal
//      (the block reconciled cleanly this time); recordRefusals VOIDS the block's unwindowed fills.
//      So the tick records in the order DESIGN.md §6 lists — fills, exclusions, refusals — and a
//      refused block's outcome carries no fills (§3.5); then the last word on a block is the right one.
//   4. advanceCursor is monotonic: max(cursor, toL2). A lagging provider can hand the tick a head
//      below the cursor; that is "nothing to close", not an error.
//   5. unwindowedFills returns fills at or below throughL2 with no window AND no refusal on their
//      block, oldest first — a refused block's fill is never handed to the window builder, even if a
//      caller got rule 3's order wrong.
//   6. openWindow needs at least one fill; every fill must be known, unwindowed, this wallet's, inside
//      [startL2, endL2] and on an unrefused block; the range must not overlap a live (non-FAILED)
//      window of the wallet. Then the fills are tagged with the window id, atomically.
//   7. markWindow changes status and, when given, detail. CONFIRMED is terminal. FAILED may reopen:
//      its fills stay tagged, so a retry re-attests the same window rather than re-windowing them.
//   8. recordPull writes one row per attempt, keyed on the raw tx hash when there is one, so an
//      intent recorded before the send and the outcome recorded after it are one row, not two.
//   9. addOwed / addCollected add non-negative wei to a known wallet's totals.
//  10. After close() every call throws; close() itself is idempotent.

import { createHash } from "node:crypto";
import pg from "pg";

import type {
  Address,
  BlockRefusal,
  Exclusion,
  Fill,
  Hex,
  Ledger,
  PersistedWindow,
  PullIntent,
  PullOutcome,
  VolumeWindow,
  WalletRef,
  WalletState,
  WindowStatus,
  WorkerMode,
} from "../types.js";
import { SCHEMA_SQL } from "./schema.js";

// ── the extended contract ───────────────────────────────────────────────────

export interface StoredRefusal extends BlockRefusal {
  readonly timesSeen: number;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

/** A window as the ledger holds it: the VolumeWindow (fills included, so it can be re-attested) plus its row state. */
export interface StoredWindow extends VolumeWindow {
  readonly id: number;
  readonly status: WindowStatus;
  readonly detail: unknown;
}

export interface StoredPull {
  readonly id: number;
  readonly windowId: number;
  readonly txHash: Hex | null;
  readonly nonce: number | null;
  readonly contributionWei: bigint;
  readonly outcome: PullOutcome["kind"];
  readonly detail: unknown;
}

/**
 * The frozen Ledger plus what the frozen Ledger cannot express: reading back refusals, exclusions,
 * windows (to re-attest an OPEN one after a restart) and pulls, and clearing a refusal for a block
 * that reconciled clean without producing a fill or an exclusion (a gas-only block).
 */
export interface SipLedger extends Ledger {
  refusals(wallet?: Address): Promise<readonly StoredRefusal[]>;
  exclusions(wallet?: Address): Promise<readonly Exclusion[]>;
  windows(filter?: { readonly wallet?: Address; readonly status?: WindowStatus }): Promise<readonly StoredWindow[]>;
  pulls(windowId?: number): Promise<readonly StoredPull[]>;
  clearRefusals(wallet: Address, blocksL2: readonly bigint[]): Promise<void>;
}

// ── errors ──────────────────────────────────────────────────────────────────

/** Malformed input: an address that is not one, negative wei. A bug upstream, never stored. */
export class LedgerInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerInputError";
  }
}

/** The write would break a rule the ledger exists to keep: a fill in two windows, an unknown wallet, a re-marked CONFIRMED window. */
export class LedgerConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerConflictError";
  }
}

/** Every method after close(). */
export class LedgerClosedError extends Error {
  constructor(method: string) {
    super(`${method} on a closed ledger`);
    this.name = "LedgerClosedError";
  }
}

/** Who holds a lock, when nobody expected anyone to. */
export interface LockHolder {
  readonly applicationName: string | null;
  /** When that connection opened. An hours-old holder is not a rolling deploy. */
  readonly since: string | null;
  readonly state: string | null;
}

export class LedgerBusyError extends Error {
  constructor(readonly holder?: LockHolder) {
    super(
      "Another worker already holds the advisory lock for this database. Two workers on one ledger " +
        "would both close windows against the same cursors and both form pulls for the same fills — " +
        "the chain would refuse the second, but it is still wrong." +
        (holder === undefined
          ? ""
          : ` It is held by ${holder.applicationName ?? "a connection that did not name itself"}` +
            (holder.since === null ? "" : `, open since ${holder.since}`) +
            "."),
    );
    this.name = "LedgerBusyError";
  }
}

/**
 * The ledger's connection died under it.
 *
 * DISTINCT FROM AN ORDINARY QUERY FAILURE, because the response is different: a failed query is
 * retried, whereas a dead connection means this ledger can never write again AND that its advisory
 * lock is gone — so the process has to exit and be restarted rather than keep ticking.
 */
export class LedgerConnectionLostError extends Error {
  constructor(readonly cause: string) {
    super(
      `The Postgres connection was lost (${cause}). This ledger cannot write again and no longer ` +
        "holds its advisory lock, so the worker must exit and be started afresh.",
    );
    this.name = "LedgerConnectionLostError";
  }
}

export class LedgerIdentityMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerIdentityMismatchError";
  }
}

// ── normalisation shared by both backends ───────────────────────────────────

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const HASH_RE = /^0x[0-9a-f]{64}$/;

function lowerAddress(value: string, what: string): Address {
  const lower = value.toLowerCase();
  if (!ADDRESS_RE.test(lower)) throw new LedgerInputError(`${what} is not an address: ${value}`);
  return lower as Address;
}

function lowerHash(value: string, what: string): Hex {
  const lower = value.toLowerCase();
  if (!HASH_RE.test(lower)) throw new LedgerInputError(`${what} is not a 32-byte hash: ${value}`);
  return lower as Hex;
}

function lowerToken(value: Address | "native", what: string): Address | "native" {
  return value === "native" ? "native" : lowerAddress(value, what);
}

function nonNegative(value: bigint, what: string): bigint {
  if (typeof value !== "bigint") throw new LedgerInputError(`${what} must be a bigint`);
  if (value < 0n) throw new LedgerInputError(`${what} must not be negative: ${value}`);
  return value;
}

function nonNegativeInt(value: number, what: string): number {
  if (!Number.isInteger(value) || value < 0) throw new LedgerInputError(`${what} must be a non-negative integer: ${value}`);
  return value;
}

function normalizeFill(fill: Fill): Fill {
  return {
    wallet: lowerAddress(fill.wallet, "fill.wallet"),
    txHash: lowerHash(fill.txHash, "fill.txHash"),
    blockL2: nonNegative(fill.blockL2, "fill.blockL2"),
    txIndex: nonNegativeInt(fill.txIndex, "fill.txIndex"),
    side: fill.side,
    venue: fill.venue,
    tokenIn: lowerToken(fill.tokenIn, "fill.tokenIn"),
    tokenOut: lowerToken(fill.tokenOut, "fill.tokenOut"),
    notionalWei: nonNegative(fill.notionalWei, "fill.notionalWei"),
    feeWei: nonNegative(fill.feeWei, "fill.feeWei"),
    source: fill.source,
  };
}

function normalizeExclusion(exclusion: Exclusion): Exclusion {
  return {
    wallet: lowerAddress(exclusion.wallet, "exclusion.wallet"),
    txHash: lowerHash(exclusion.txHash, "exclusion.txHash"),
    blockL2: nonNegative(exclusion.blockL2, "exclusion.blockL2"),
    reason: exclusion.reason,
  };
}

function normalizeRefusal(refusal: BlockRefusal): BlockRefusal {
  return {
    wallet: lowerAddress(refusal.wallet, "refusal.wallet"),
    blockL2: nonNegative(refusal.blockL2, "refusal.blockL2"),
    reason: refusal.reason,
    ...(refusal.detail === undefined ? {} : { detail: refusal.detail }),
  };
}

function normalizeWindow(window: VolumeWindow): VolumeWindow {
  const startL2 = nonNegative(window.startL2, "window.startL2");
  const endL2 = nonNegative(window.endL2, "window.endL2");
  if (endL2 < startL2) throw new LedgerInputError(`window.endL2 ${endL2} is below window.startL2 ${startL2}`);
  if (window.fills.length === 0) throw new LedgerInputError("a window with no fills has nothing to attest");
  if (!Number.isInteger(window.savingsBps) || window.savingsBps < 0 || window.savingsBps > 10_000) {
    throw new LedgerInputError(`window.savingsBps out of range: ${window.savingsBps}`);
  }
  return {
    wallet: lowerAddress(window.wallet, "window.wallet"),
    vault: lowerAddress(window.vault, "window.vault"),
    startL2,
    endL2,
    fills: window.fills.map(normalizeFill),
    sumNotionalWei: nonNegative(window.sumNotionalWei, "window.sumNotionalWei"),
    savingsBps: window.savingsBps,
    owedWei: nonNegative(window.owedWei, "window.owedWei"),
    batchRoot: lowerHash(window.batchRoot, "window.batchRoot"),
  };
}

/** Everything but the key: what a windowed fill is not allowed to change. */
function sameFillContent(a: Fill, b: Fill): boolean {
  return (
    a.blockL2 === b.blockL2 &&
    a.txIndex === b.txIndex &&
    a.side === b.side &&
    a.venue === b.venue &&
    a.tokenIn === b.tokenIn &&
    a.tokenOut === b.tokenOut &&
    a.notionalWei === b.notionalWei &&
    a.feeWei === b.feeWei &&
    a.source === b.source
  );
}

function byBlockThenIndex(a: Fill, b: Fill): number {
  if (a.blockL2 !== b.blockL2) return a.blockL2 < b.blockL2 ? -1 : 1;
  return a.txIndex - b.txIndex;
}

/** Distinct (wallet, block) pairs of a batch, in first-seen order. */
function distinctBlocks(items: readonly { readonly wallet: Address; readonly blockL2: bigint }[]): { wallet: Address; blockL2: bigint }[] {
  const seen = new Set<string>();
  const out: { wallet: Address; blockL2: bigint }[] = [];
  for (const item of items) {
    const key = `${item.wallet}|${item.blockL2}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ wallet: item.wallet, blockL2: item.blockL2 });
  }
  return out;
}

/** Deep copy with every bigint rendered as a decimal string, so both backends store one JSON shape. */
function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (inner !== undefined) out[key] = jsonSafe(inner);
    }
    return out;
  }
  return value;
}

/**
 * What a pull row records. The window is left out of the detail — its fills are already tagged with
 * the window id — and the raw signed tx is kept for a SENT outcome: it is what a recovery would
 * re-broadcast, and it can only ever pay into the user's own vault.
 */
function pullRow(intent: PullIntent | null, outcome: PullOutcome): {
  txHash: Hex | null;
  nonce: number | null;
  contributionWei: bigint;
  detail: unknown;
} {
  switch (outcome.kind) {
    case "SENT": {
      const i = outcome.intent;
      return {
        txHash: lowerHash(i.txHash, "intent.txHash"),
        nonce: nonNegativeInt(i.nonce, "intent.nonce"),
        contributionWei: nonNegative(i.contributionWei, "intent.contributionWei"),
        detail: jsonSafe({
          kind: "SENT",
          txHash: i.txHash,
          nonce: i.nonce,
          contributionWei: i.contributionWei,
          attestation: i.attestation,
          signature: i.signature,
          rawTx: i.rawTx,
        }),
      };
    }
    case "DRY_RUN": {
      const i = outcome.intent;
      return {
        txHash: null,
        nonce: null,
        contributionWei: nonNegative(i.contributionWei, "intent.contributionWei"),
        detail: jsonSafe({ kind: "DRY_RUN", contributionWei: i.contributionWei, attestation: i.attestation, signature: i.signature }),
      };
    }
    case "SKIPPED":
      return {
        // A signed-but-skipped intent keeps its hash, so a later send of the same raw tx is the same row.
        txHash: intent === null ? null : lowerHash(intent.txHash, "intent.txHash"),
        nonce: intent === null ? null : nonNegativeInt(intent.nonce, "intent.nonce"),
        contributionWei: intent === null ? 0n : nonNegative(intent.contributionWei, "intent.contributionWei"),
        detail: jsonSafe({
          kind: "SKIPPED",
          reason: outcome.reason,
          detail: outcome.detail,
          ...(intent === null ? {} : { txHash: intent.txHash, nonce: intent.nonce, contributionWei: intent.contributionWei }),
        }),
      };
  }
}

export interface LedgerOptions {
  /** The cursor a newly seen wallet starts at: nothing below it is ever windowed. Default 0. */
  readonly initialCursorL2?: bigint;
}

// ── the memory backend ──────────────────────────────────────────────────────

interface MemWallet {
  vault: Address;
  cursorL2: bigint;
  owedTotalWei: bigint;
  collectedTotalWei: bigint;
}

interface MemFill {
  fill: Fill;
  windowId: number | null;
}

interface MemRefusal {
  wallet: Address;
  blockL2: bigint;
  reason: BlockRefusal["reason"];
  detail: string | undefined;
  timesSeen: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

interface MemWindow {
  id: number;
  wallet: Address;
  vault: Address;
  startL2: bigint;
  endL2: bigint;
  batchRoot: Hex;
  sumNotionalWei: bigint;
  savingsBps: number;
  owedWei: bigint;
  status: WindowStatus;
  detail: unknown;
  fillKeys: string[];
}

const fillKey = (wallet: Address, txHash: Hex): string => `${wallet}|${txHash}`;
const blockKey = (wallet: Address, blockL2: bigint): string => `${wallet}|${blockL2}`;

class MemoryLedger implements SipLedger {
  readonly #initialCursorL2: bigint;
  readonly #wallets = new Map<Address, MemWallet>();
  readonly #fills = new Map<string, MemFill>();
  readonly #exclusions = new Map<string, Exclusion>();
  readonly #refusals = new Map<string, MemRefusal>();
  readonly #windows = new Map<number, MemWindow>();
  readonly #pulls: StoredPull[] = [];
  #nextWindowId = 1;
  #nextPullId = 1;
  #closed = false;

  constructor(options: LedgerOptions) {
    this.#initialCursorL2 = nonNegative(options.initialCursorL2 ?? 0n, "initialCursorL2");
  }

  #open(method: string): void {
    if (this.#closed) throw new LedgerClosedError(method);
  }

  #wallet(address: Address, method: string): MemWallet {
    const wallet = this.#wallets.get(address);
    if (wallet === undefined) throw new LedgerConflictError(`${method}: wallet ${address} is not in the ledger; upsertWallets first`);
    return wallet;
  }

  #clearRefusalsOf(blocks: readonly { readonly wallet: Address; readonly blockL2: bigint }[]): void {
    for (const b of blocks) this.#refusals.delete(blockKey(b.wallet, b.blockL2));
  }

  async upsertWallets(wallets: readonly WalletRef[]): Promise<void> {
    this.#open("upsertWallets");
    for (const ref of wallets) {
      const address = lowerAddress(ref.address, "wallet.address");
      const vault = lowerAddress(ref.vault, "wallet.vault");
      const existing = this.#wallets.get(address);
      if (existing === undefined) {
        this.#wallets.set(address, { vault, cursorL2: this.#initialCursorL2, owedTotalWei: 0n, collectedTotalWei: 0n });
      } else {
        existing.vault = vault;
      }
    }
  }

  async walletStates(): Promise<readonly WalletState[]> {
    this.#open("walletStates");
    return [...this.#wallets.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([wallet, w]) => ({
        wallet,
        vault: w.vault,
        cursorL2: w.cursorL2,
        owedTotalWei: w.owedTotalWei,
        collectedTotalWei: w.collectedTotalWei,
      }));
  }

  async recordFills(fills: readonly Fill[]): Promise<void> {
    this.#open("recordFills");
    const normalized = fills.map(normalizeFill);
    for (const fill of normalized) {
      this.#wallet(fill.wallet, "recordFills");
      const key = fillKey(fill.wallet, fill.txHash);
      const existing = this.#fills.get(key);
      if (existing === undefined) {
        this.#fills.set(key, { fill, windowId: null });
      } else if (existing.windowId === null) {
        existing.fill = fill;
      } else if (!sameFillContent(existing.fill, fill)) {
        throw new LedgerConflictError(
          `recordFills: fill ${fill.txHash} of ${fill.wallet} is committed to window ${existing.windowId} and the new record differs`,
        );
      }
    }
    this.#clearRefusalsOf(distinctBlocks(normalized));
  }

  async recordExclusions(exclusions: readonly Exclusion[]): Promise<void> {
    this.#open("recordExclusions");
    const normalized = exclusions.map(normalizeExclusion);
    for (const exclusion of normalized) {
      this.#wallet(exclusion.wallet, "recordExclusions");
      this.#exclusions.set(fillKey(exclusion.wallet, exclusion.txHash), exclusion);
    }
    this.#clearRefusalsOf(distinctBlocks(normalized));
  }

  async recordRefusals(refusals: readonly BlockRefusal[]): Promise<void> {
    this.#open("recordRefusals");
    const now = new Date().toISOString();
    for (const refusal of refusals.map(normalizeRefusal)) {
      this.#wallet(refusal.wallet, "recordRefusals");
      const key = blockKey(refusal.wallet, refusal.blockL2);
      const existing = this.#refusals.get(key);
      if (existing === undefined) {
        this.#refusals.set(key, { ...refusal, detail: refusal.detail, timesSeen: 1, firstSeenAt: now, lastSeenAt: now });
      } else {
        existing.reason = refusal.reason;
        existing.detail = refusal.detail;
        existing.timesSeen += 1;
        existing.lastSeenAt = now;
      }
      // A refusal voids every unwindowed fill of the block (§3.5). A windowed one was already attested
      // and stays: the schema forbids deleting it, and so does this.
      for (const [fk, entry] of this.#fills) {
        if (entry.windowId === null && entry.fill.wallet === refusal.wallet && entry.fill.blockL2 === refusal.blockL2) {
          this.#fills.delete(fk);
        }
      }
    }
  }

  async clearRefusals(wallet: Address, blocksL2: readonly bigint[]): Promise<void> {
    this.#open("clearRefusals");
    const address = lowerAddress(wallet, "wallet");
    this.#clearRefusalsOf(blocksL2.map((blockL2) => ({ wallet: address, blockL2: nonNegative(blockL2, "blockL2") })));
  }

  async advanceCursor(wallet: Address, toL2: bigint): Promise<void> {
    this.#open("advanceCursor");
    const w = this.#wallet(lowerAddress(wallet, "wallet"), "advanceCursor");
    const to = nonNegative(toL2, "toL2");
    if (to > w.cursorL2) w.cursorL2 = to;
  }

  async unwindowedFills(wallet: Address, throughL2: bigint): Promise<readonly Fill[]> {
    this.#open("unwindowedFills");
    const address = lowerAddress(wallet, "wallet");
    const through = nonNegative(throughL2, "throughL2");
    const out: Fill[] = [];
    for (const entry of this.#fills.values()) {
      if (entry.windowId !== null || entry.fill.wallet !== address || entry.fill.blockL2 > through) continue;
      if (this.#refusals.has(blockKey(address, entry.fill.blockL2))) continue;
      out.push(entry.fill);
    }
    return out.sort(byBlockThenIndex);
  }

  async openWindow(window: VolumeWindow): Promise<number> {
    this.#open("openWindow");
    const w = normalizeWindow(window);
    this.#wallet(w.wallet, "openWindow");
    for (const other of this.#windows.values()) {
      if (other.wallet === w.wallet && other.status !== "FAILED" && other.startL2 <= w.endL2 && other.endL2 >= w.startL2) {
        throw new LedgerConflictError(
          `openWindow: (${w.startL2}, ${w.endL2}] of ${w.wallet} overlaps live window ${other.id} (${other.startL2}, ${other.endL2}]`,
        );
      }
    }
    const keys: string[] = [];
    for (const fill of w.fills) {
      const key = fillKey(w.wallet, fill.txHash);
      if (fill.wallet !== w.wallet) throw new LedgerConflictError(`openWindow: fill ${fill.txHash} belongs to ${fill.wallet}, not ${w.wallet}`);
      if (keys.includes(key)) throw new LedgerConflictError(`openWindow: fill ${fill.txHash} listed twice`);
      const entry = this.#fills.get(key);
      if (entry === undefined) throw new LedgerConflictError(`openWindow: fill ${fill.txHash} of ${w.wallet} is not in the ledger`);
      if (entry.windowId !== null) throw new LedgerConflictError(`openWindow: fill ${fill.txHash} is already in window ${entry.windowId}`);
      if (entry.fill.blockL2 < w.startL2 || entry.fill.blockL2 > w.endL2) {
        throw new LedgerConflictError(`openWindow: fill ${fill.txHash} at block ${entry.fill.blockL2} is outside [${w.startL2}, ${w.endL2}]`);
      }
      if (this.#refusals.has(blockKey(w.wallet, entry.fill.blockL2))) {
        throw new LedgerConflictError(`openWindow: fill ${fill.txHash} sits on refused block ${entry.fill.blockL2}`);
      }
      keys.push(key);
    }
    const id = this.#nextWindowId++;
    this.#windows.set(id, {
      id,
      wallet: w.wallet,
      vault: w.vault,
      startL2: w.startL2,
      endL2: w.endL2,
      batchRoot: w.batchRoot,
      sumNotionalWei: w.sumNotionalWei,
      savingsBps: w.savingsBps,
      owedWei: w.owedWei,
      status: "OPEN",
      detail: null,
      fillKeys: keys,
    });
    for (const key of keys) {
      const entry = this.#fills.get(key);
      if (entry !== undefined) entry.windowId = id;
    }
    return id;
  }

  async markWindow(id: number, status: WindowStatus, detail?: unknown): Promise<void> {
    this.#open("markWindow");
    const window = this.#windows.get(id);
    if (window === undefined) throw new LedgerConflictError(`markWindow: no window ${id}`);
    if (window.status === "CONFIRMED" && status !== "CONFIRMED") {
      throw new LedgerConflictError(`markWindow: window ${id} is CONFIRMED, which is terminal; refusing ${status}`);
    }
    window.status = status;
    if (detail !== undefined) window.detail = jsonSafe(detail);
  }

  async recordPull(windowId: number, intent: PullIntent | null, outcome: PullOutcome): Promise<void> {
    this.#open("recordPull");
    if (!this.#windows.has(windowId)) throw new LedgerConflictError(`recordPull: no window ${windowId}`);
    const row = pullRow(intent, outcome);
    const existing = row.txHash === null ? undefined : this.#pulls.find((p) => p.txHash === row.txHash);
    if (existing !== undefined) {
      if (existing.windowId !== windowId) {
        throw new LedgerConflictError(`recordPull: tx ${row.txHash} was recorded for window ${existing.windowId}, not ${windowId}`);
      }
      this.#pulls[this.#pulls.indexOf(existing)] = { ...existing, nonce: row.nonce, contributionWei: row.contributionWei, outcome: outcome.kind, detail: row.detail };
      return;
    }
    this.#pulls.push({
      id: this.#nextPullId++,
      windowId,
      txHash: row.txHash,
      nonce: row.nonce,
      contributionWei: row.contributionWei,
      outcome: outcome.kind,
      detail: row.detail,
    });
  }

  async addOwed(wallet: Address, wei: bigint): Promise<void> {
    this.#open("addOwed");
    const w = this.#wallet(lowerAddress(wallet, "wallet"), "addOwed");
    w.owedTotalWei += nonNegative(wei, "wei");
  }

  async addCollected(wallet: Address, wei: bigint): Promise<void> {
    this.#open("addCollected");
    const w = this.#wallet(lowerAddress(wallet, "wallet"), "addCollected");
    w.collectedTotalWei += nonNegative(wei, "wei");
  }

  async refusals(wallet?: Address): Promise<readonly StoredRefusal[]> {
    this.#open("refusals");
    const address = wallet === undefined ? undefined : lowerAddress(wallet, "wallet");
    return [...this.#refusals.values()]
      .filter((r) => address === undefined || r.wallet === address)
      .sort((a, b) => (a.wallet !== b.wallet ? (a.wallet < b.wallet ? -1 : 1) : a.blockL2 < b.blockL2 ? -1 : a.blockL2 > b.blockL2 ? 1 : 0))
      .map((r) => ({
        wallet: r.wallet,
        blockL2: r.blockL2,
        reason: r.reason,
        ...(r.detail === undefined ? {} : { detail: r.detail }),
        timesSeen: r.timesSeen,
        firstSeenAt: r.firstSeenAt,
        lastSeenAt: r.lastSeenAt,
      }));
  }

  async exclusions(wallet?: Address): Promise<readonly Exclusion[]> {
    this.#open("exclusions");
    const address = wallet === undefined ? undefined : lowerAddress(wallet, "wallet");
    return [...this.#exclusions.values()]
      .filter((e) => address === undefined || e.wallet === address)
      .sort((a, b) => (a.blockL2 < b.blockL2 ? -1 : a.blockL2 > b.blockL2 ? 1 : a.txHash < b.txHash ? -1 : 1));
  }

  /**
   * The Ledger contract's view of `windows`: what a later pass needs to pick up
   * a window it persisted but could not collect — a DRY_RUN or SKIPPED pull, or
   * a restart between the attestation and the send. Every field of the window
   * comes back, so it can be re-attested without touching the fills again.
   */
  async windowsByStatus(status: WindowStatus, wallet?: Address): Promise<readonly PersistedWindow[]> {
    const found = await this.windows(wallet === undefined ? { status } : { status, wallet });
    return found.map(({ id, status: state, detail, ...window }) => ({ id, status: state, detail, window }));
  }

  async windows(filter: { readonly wallet?: Address; readonly status?: WindowStatus } = {}): Promise<readonly StoredWindow[]> {
    this.#open("windows");
    const address = filter.wallet === undefined ? undefined : lowerAddress(filter.wallet, "wallet");
    return [...this.#windows.values()]
      .filter((w) => (address === undefined || w.wallet === address) && (filter.status === undefined || w.status === filter.status))
      .sort((a, b) => a.id - b.id)
      .map((w) => ({
        id: w.id,
        wallet: w.wallet,
        vault: w.vault,
        startL2: w.startL2,
        endL2: w.endL2,
        fills: w.fillKeys
          .map((k) => this.#fills.get(k)?.fill)
          .filter((f): f is Fill => f !== undefined)
          .sort(byBlockThenIndex),
        sumNotionalWei: w.sumNotionalWei,
        savingsBps: w.savingsBps,
        owedWei: w.owedWei,
        batchRoot: w.batchRoot,
        status: w.status,
        detail: w.detail,
      }));
  }

  async pulls(windowId?: number): Promise<readonly StoredPull[]> {
    this.#open("pulls");
    return this.#pulls.filter((p) => windowId === undefined || p.windowId === windowId).map((p) => ({ ...p }));
  }

  async close(): Promise<void> {
    this.#closed = true;
  }
}

/** In-memory implementation for tests and dry runs without a database. */
export function memoryLedger(options: LedgerOptions = {}): SipLedger {
  return new MemoryLedger(options);
}

// ── the Postgres backend ────────────────────────────────────────────────────

/** One lock for the whole worker: one ledger, one writer. Two chains do not share a database. */
export const SIP_WORKER_LOCK_NAME = "sip-worker";

/**
 * A 64-bit key for pg_advisory_lock, derived from a name.
 * Ported from keeper-old/src/ledger-pg.ts (advisoryKeyFor).
 *
 * The lock is SESSION scoped, which is the property that matters: it is released when the connection
 * drops, so a worker that is killed — or a container that vanishes — frees its own lock without anyone
 * reclaiming a stale pid file.
 */
export function advisoryKeyFor(name: string): bigint {
  const digest = createHash("sha256").update(name).digest();
  // Signed 64-bit, which is what pg_advisory_lock takes.
  return BigInt.asIntN(64, digest.readBigUInt64BE(0));
}

/**
 * How this process will appear to whoever later finds it holding the lock.
 * Ported from keeper-old/src/ledger-pg.ts (keeperApplicationName).
 *
 * WITHOUT THIS, "another instance has it" is a dead end: there is no way to tell, from the logs or
 * the database, whether the holder is a healthy sibling or a stale dry-run container nobody tore
 * down. Those two need opposite responses, and one of them means nothing is being pulled at all.
 *
 * THE MODE GOES FIRST because it is the part that changes the answer. A dry-run instance holding the
 * lock while a live one waits is a system that looks healthy and pulls nothing.
 *
 * Postgres truncates application_name at 63 bytes SILENTLY, so it is capped here instead: losing the
 * tail to the server would eat the identifiers, which is the half that says which container.
 */
export function workerApplicationName(options: { readonly mode: WorkerMode; readonly env?: NodeJS.ProcessEnv }): string {
  const env = options.env ?? process.env;
  const short = (value: string | undefined): string | undefined => (value === undefined || value === "" ? undefined : value.slice(0, 8));
  const parts = ["sip-worker", options.mode === "live" ? "live" : "dry-run"];
  const deployment = short(env.RAILWAY_DEPLOYMENT_ID ?? env.SIP_WORKER_DEPLOYMENT_ID);
  const replica = short(env.RAILWAY_REPLICA_ID ?? env.SIP_WORKER_REPLICA_ID);
  if (deployment !== undefined) parts.push(`d:${deployment}`);
  if (replica !== undefined) parts.push(`r:${replica}`);
  return parts.join(" ").slice(0, 63);
}

/**
 * TLS for the ledger connection: relaxed by default, off only when asked.
 * Ported from keeper-old/src/ledger-pg.ts (sslOptionsFor).
 *
 * THE DEFAULT IS THE POINT. Supabase and most managed providers terminate TLS at a proxy whose chain
 * Node does not carry, so the chain check is relaxed — the connection is still encrypted. Anything
 * that is not an explicit `sslmode=disable` gets that treatment, including a malformed string,
 * because the failure mode of guessing wrong has to be "refuses to connect", never "connects in
 * plaintext". `sslmode=disable` is honoured so the backend can be exercised against a plain local
 * Postgres; it is safe to honour because no managed provider hands out a URL containing it.
 */
export function sslOptionsFor(connectionString: string): { rejectUnauthorized: false } | false {
  const relaxed = { rejectUnauthorized: false } as const;
  let mode: string | null;
  try {
    mode = new URL(connectionString).searchParams.get("sslmode");
  } catch {
    // Unparseable, so nothing was explicitly disabled. Encrypt.
    return relaxed;
  }
  return mode?.toLowerCase() === "disable" ? false : relaxed;
}

/** The slice of pg.Client the ledger uses; injectable so the SQL path is testable without a database. */
export interface PgSession {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: readonly unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
  end(): Promise<void>;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export interface PgLedgerOptions extends LedgerOptions {
  /** Named first in application_name. Default "dry-run": an unlabelled holder is assumed harmless, which is the wrong default. */
  readonly mode?: WorkerMode;
  /** When given, pinned in sip_instance on first open and checked on every later one. */
  readonly identity?: { readonly chainId: number; readonly factory: Address; readonly executor: Address };
  readonly env?: NodeJS.ProcessEnv;
  /** Opens the session. Default: a connected pg.Client. Tests pass a fake. */
  readonly connect?: (config: pg.ClientConfig) => Promise<PgSession>;
}

/**
 * The connection settings.
 * Ported in spirit from keeper-old/src/ledger-pg.ts, which used one pg.Client for the same reason.
 *
 * ONE CLIENT, NOT A POOL. The advisory lock is session-scoped: it lives on the connection that ran
 * pg_try_advisory_lock. A pool hands out connections, so the lock would sit on one and the writes go
 * through another — the lock would guard nothing. One session, one lock, one writer.
 *
 * The timeouts turn "hung" into "failed": a statement stuck behind a lock, or a transaction left open
 * by a crash mid-tick, ends the session instead of holding the advisory lock forever — and an ended
 * session surfaces as LedgerConnectionLostError on the next write, which is the loud failure wanted.
 */
export function pgClientConfig(databaseUrl: string, options: PgLedgerOptions): pg.ClientConfig {
  return {
    connectionString: databaseUrl,
    ssl: sslOptionsFor(databaseUrl),
    application_name: workerApplicationName({ mode: options.mode ?? "dry-run", ...(options.env === undefined ? {} : { env: options.env }) }),
    connectionTimeoutMillis: 10_000,
    keepAlive: true,
    statement_timeout: 30_000,
    query_timeout: 45_000,
    idle_in_transaction_session_timeout: 60_000,
  };
}

/**
 * Asks Postgres who holds the lock. Best effort, and never fatal.
 * Ported from keeper-old/src/ledger-pg.ts (findLockHolder).
 *
 * A single bigint advisory key is stored split across two oid columns: the high 32 bits in classid,
 * the low 32 in objid, with objsubid 1 marking it as the one-argument form.
 *
 * A failure here must not become the error the caller sees. Some managed providers restrict
 * pg_stat_activity, and "could not identify the holder" is strictly less useful than "the lock is
 * held" — not a reason to lose it.
 */
async function findLockHolder(session: PgSession, key: bigint): Promise<LockHolder | undefined> {
  const classid = Number(BigInt.asUintN(64, key) >> 32n);
  const objid = Number(BigInt.asUintN(64, key) & 0xffff_ffffn);
  try {
    const found = await session.query<{ application_name: string | null; backend_start: Date | string | null; state: string | null }>(
      `SELECT a.application_name, a.backend_start, a.state
         FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.locktype = 'advisory' AND l.classid = $1 AND l.objid = $2
          AND l.objsubid = 1 AND l.granted
        LIMIT 1`,
      [classid, objid],
    );
    const row = found.rows[0];
    if (row === undefined) return undefined;
    const since = row.backend_start === null ? null : row.backend_start instanceof Date ? row.backend_start.toISOString() : String(row.backend_start);
    return {
      applicationName: row.application_name === "" ? null : row.application_name,
      since,
      state: row.state,
    };
  } catch {
    return undefined;
  }
}

function toBig(value: unknown, what: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?[0-9]+$/.test(value)) return BigInt(value);
  throw new LedgerInputError(`${what}: expected a decimal integer from Postgres, got ${String(value)}`);
}

function toInt(value: unknown, what: string): number {
  const big = toBig(value, what);
  if (big > BigInt(Number.MAX_SAFE_INTEGER) || big < BigInt(Number.MIN_SAFE_INTEGER)) throw new LedgerInputError(`${what}: ${big} does not fit a JS number`);
  return Number(big);
}

interface WalletRow {
  address: string;
  vault: string;
  cursor_l2: string;
  owed_total_wei: string;
  collected_total_wei: string;
}

interface FillRow {
  wallet: string;
  tx_hash: string;
  block_l2: string;
  tx_index: number | string;
  side: string;
  venue: string;
  token_in: string;
  token_out: string;
  notional_wei: string;
  fee_wei: string;
  source: string;
  window_id: number | string | null;
}

interface ExclusionRow {
  wallet: string;
  tx_hash: string;
  block_l2: string;
  reason: string;
}

interface RefusalRow {
  wallet: string;
  block_l2: string;
  reason: string;
  detail: string | null;
  times_seen: number | string;
  first_seen_at: Date | string;
  last_seen_at: Date | string;
}

interface WindowRow {
  id: number | string;
  wallet: string;
  vault: string;
  start_l2: string;
  end_l2: string;
  batch_root: string;
  sum_notional_wei: string;
  owed_wei: string;
  savings_bps: number | string;
  status: string;
  detail: unknown;
}

interface PullRow {
  id: number | string;
  window_id: number | string;
  tx_hash: string | null;
  nonce: string | number | null;
  contribution_wei: string;
  outcome: string;
  detail: unknown;
}

const FILL_COLUMNS =
  "wallet, tx_hash, block_l2::text AS block_l2, tx_index, side, venue, token_in, token_out, notional_wei::text AS notional_wei, fee_wei::text AS fee_wei, source, window_id";

function fillFromRow(row: FillRow): Fill {
  return {
    wallet: row.wallet as Address,
    txHash: row.tx_hash as Hex,
    blockL2: toBig(row.block_l2, "sip_fill.block_l2"),
    txIndex: toInt(row.tx_index, "sip_fill.tx_index"),
    side: row.side as Fill["side"],
    venue: row.venue,
    tokenIn: row.token_in as Fill["tokenIn"],
    tokenOut: row.token_out as Fill["tokenOut"],
    notionalWei: toBig(row.notional_wei, "sip_fill.notional_wei"),
    feeWei: toBig(row.fee_wei, "sip_fill.fee_wei"),
    source: row.source as Fill["source"],
  };
}

const iso = (value: Date | string): string => (value instanceof Date ? value.toISOString() : String(value));

class PgLedger implements SipLedger {
  readonly #session: PgSession;
  readonly #initialCursorL2: bigint;
  #closed = false;
  /** Set by the connection's error handler. Non-null means this ledger is dead. */
  #lost: string | null = null;

  constructor(session: PgSession, initialCursorL2: bigint) {
    this.#session = session;
    this.#initialCursorL2 = initialCursorL2;
  }

  /** Records a dropped connection; the next call turns it into a LedgerConnectionLostError. */
  markLost(cause: string): void {
    this.#lost ??= cause;
  }

  get lost(): string | null {
    return this.#lost;
  }

  /**
   * Refuses a call on a dead connection, naming what happened.
   *
   * Without this the query reaches node-postgres and comes back as a generic "Client has encountered
   * a connection error and is not queryable" — true, but indistinguishable from a transient fault, so
   * the caller would retry forever against a connection that can never recover and a lock it no
   * longer holds.
   */
  #ready(method: string): void {
    if (this.#closed) throw new LedgerClosedError(method);
    if (this.#lost !== null) throw new LedgerConnectionLostError(this.#lost);
  }

  #query<R extends pg.QueryResultRow>(text: string, values: readonly unknown[] = []): Promise<{ rows: R[]; rowCount: number | null }> {
    return this.#session.query<R>(text, values);
  }

  /** Runs fn inside one transaction: a batch lands whole or not at all. */
  async #tx<T>(fn: () => Promise<T>): Promise<T> {
    await this.#query("BEGIN");
    try {
      const result = await fn();
      await this.#query("COMMIT");
      return result;
    } catch (error) {
      await this.#query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }

  async #requireWallet(address: Address, method: string): Promise<void> {
    const found = await this.#query<{ address: string }>("SELECT address FROM sip_wallet WHERE address = $1", [address]);
    if (found.rows.length === 0) throw new LedgerConflictError(`${method}: wallet ${address} is not in the ledger; upsertWallets first`);
  }

  async #clearRefusalsOf(blocks: readonly { readonly wallet: Address; readonly blockL2: bigint }[]): Promise<void> {
    for (const b of blocks) {
      await this.#query("DELETE FROM sip_refusal WHERE wallet = $1 AND block_l2 = $2", [b.wallet, b.blockL2.toString()]);
    }
  }

  async upsertWallets(wallets: readonly WalletRef[]): Promise<void> {
    this.#ready("upsertWallets");
    const rows = wallets.map((ref) => ({ address: lowerAddress(ref.address, "wallet.address"), vault: lowerAddress(ref.vault, "wallet.vault") }));
    if (rows.length === 0) return;
    await this.#tx(async () => {
      for (const row of rows) {
        await this.#query(
          `INSERT INTO sip_wallet (address, vault, cursor_l2) VALUES ($1, $2, $3)
             ON CONFLICT (address) DO UPDATE SET vault = EXCLUDED.vault, updated_at = now()`,
          [row.address, row.vault, this.#initialCursorL2.toString()],
        );
      }
    });
  }

  async walletStates(): Promise<readonly WalletState[]> {
    this.#ready("walletStates");
    const found = await this.#query<WalletRow>(
      `SELECT address, vault, cursor_l2::text AS cursor_l2, owed_total_wei::text AS owed_total_wei,
              collected_total_wei::text AS collected_total_wei
         FROM sip_wallet ORDER BY address`,
    );
    return found.rows.map((row) => ({
      wallet: row.address as Address,
      vault: row.vault as Address,
      cursorL2: toBig(row.cursor_l2, "sip_wallet.cursor_l2"),
      owedTotalWei: toBig(row.owed_total_wei, "sip_wallet.owed_total_wei"),
      collectedTotalWei: toBig(row.collected_total_wei, "sip_wallet.collected_total_wei"),
    }));
  }

  async recordFills(fills: readonly Fill[]): Promise<void> {
    this.#ready("recordFills");
    const normalized = fills.map(normalizeFill);
    if (normalized.length === 0) return;
    await this.#tx(async () => {
      for (const fill of normalized) {
        // The WHERE on the upsert leaves a windowed row untouched (rowCount 0); the trigger in the
        // schema is the second net. Then the old content decides whether that silence was a no-op
        // or a conflict.
        const upsert = await this.#query<{ window_id: number | null }>(
          `INSERT INTO sip_fill (wallet, tx_hash, block_l2, tx_index, side, venue, token_in, token_out, notional_wei, fee_wei, source)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             ON CONFLICT (wallet, tx_hash) DO UPDATE SET
               block_l2 = EXCLUDED.block_l2, tx_index = EXCLUDED.tx_index, side = EXCLUDED.side, venue = EXCLUDED.venue,
               token_in = EXCLUDED.token_in, token_out = EXCLUDED.token_out, notional_wei = EXCLUDED.notional_wei,
               fee_wei = EXCLUDED.fee_wei, source = EXCLUDED.source, updated_at = now()
             WHERE sip_fill.window_id IS NULL
             RETURNING window_id`,
          [
            fill.wallet,
            fill.txHash,
            fill.blockL2.toString(),
            fill.txIndex,
            fill.side,
            fill.venue,
            fill.tokenIn,
            fill.tokenOut,
            fill.notionalWei.toString(),
            fill.feeWei.toString(),
            fill.source,
          ],
        );
        if (upsert.rows.length > 0) continue;
        const existing = await this.#query<FillRow>(`SELECT ${FILL_COLUMNS} FROM sip_fill WHERE wallet = $1 AND tx_hash = $2`, [fill.wallet, fill.txHash]);
        const row = existing.rows[0];
        if (row === undefined) {
          // Neither inserted nor found: the wallet FK refused it, or the row vanished mid-transaction.
          throw new LedgerConflictError(`recordFills: fill ${fill.txHash} of ${fill.wallet} could not be recorded; is the wallet upserted?`);
        }
        if (!sameFillContent(fillFromRow(row), fill)) {
          throw new LedgerConflictError(
            `recordFills: fill ${fill.txHash} of ${fill.wallet} is committed to window ${String(row.window_id)} and the new record differs`,
          );
        }
      }
      await this.#clearRefusalsOf(distinctBlocks(normalized));
    });
  }

  async recordExclusions(exclusions: readonly Exclusion[]): Promise<void> {
    this.#ready("recordExclusions");
    const normalized = exclusions.map(normalizeExclusion);
    if (normalized.length === 0) return;
    await this.#tx(async () => {
      for (const e of normalized) {
        await this.#query(
          `INSERT INTO sip_exclusion (wallet, tx_hash, block_l2, reason) VALUES ($1, $2, $3, $4)
             ON CONFLICT (wallet, tx_hash) DO UPDATE SET block_l2 = EXCLUDED.block_l2, reason = EXCLUDED.reason`,
          [e.wallet, e.txHash, e.blockL2.toString(), e.reason],
        );
      }
      await this.#clearRefusalsOf(distinctBlocks(normalized));
    });
  }

  async recordRefusals(refusals: readonly BlockRefusal[]): Promise<void> {
    this.#ready("recordRefusals");
    const normalized = refusals.map(normalizeRefusal);
    if (normalized.length === 0) return;
    await this.#tx(async () => {
      for (const r of normalized) {
        await this.#query(
          `INSERT INTO sip_refusal (wallet, block_l2, reason, detail) VALUES ($1, $2, $3, $4)
             ON CONFLICT (wallet, block_l2) DO UPDATE SET
               reason = EXCLUDED.reason, detail = EXCLUDED.detail,
               times_seen = sip_refusal.times_seen + 1, last_seen_at = now()`,
          [r.wallet, r.blockL2.toString(), r.reason, r.detail ?? null],
        );
        // §3.5: a refusal voids the block's fills. Only the unwindowed ones can go; the trigger refuses
        // the rest, and the WHERE keeps this statement from ever asking.
        await this.#query("DELETE FROM sip_fill WHERE wallet = $1 AND block_l2 = $2 AND window_id IS NULL", [r.wallet, r.blockL2.toString()]);
      }
    });
  }

  async clearRefusals(wallet: Address, blocksL2: readonly bigint[]): Promise<void> {
    this.#ready("clearRefusals");
    const address = lowerAddress(wallet, "wallet");
    const blocks = blocksL2.map((blockL2) => ({ wallet: address, blockL2: nonNegative(blockL2, "blockL2") }));
    if (blocks.length === 0) return;
    await this.#tx(() => this.#clearRefusalsOf(blocks));
  }

  async advanceCursor(wallet: Address, toL2: bigint): Promise<void> {
    this.#ready("advanceCursor");
    const address = lowerAddress(wallet, "wallet");
    const to = nonNegative(toL2, "toL2");
    const updated = await this.#query(
      "UPDATE sip_wallet SET cursor_l2 = GREATEST(cursor_l2, $2::bigint), updated_at = now() WHERE address = $1",
      [address, to.toString()],
    );
    if ((updated.rowCount ?? 0) === 0) throw new LedgerConflictError(`advanceCursor: wallet ${address} is not in the ledger; upsertWallets first`);
  }

  async unwindowedFills(wallet: Address, throughL2: bigint): Promise<readonly Fill[]> {
    this.#ready("unwindowedFills");
    const address = lowerAddress(wallet, "wallet");
    const through = nonNegative(throughL2, "throughL2");
    const found = await this.#query<FillRow>(
      `SELECT ${FILL_COLUMNS} FROM sip_fill f
        WHERE f.wallet = $1 AND f.window_id IS NULL AND f.block_l2 <= $2::bigint
          AND NOT EXISTS (SELECT 1 FROM sip_refusal r WHERE r.wallet = f.wallet AND r.block_l2 = f.block_l2)
        ORDER BY f.block_l2, f.tx_index`,
      [address, through.toString()],
    );
    return found.rows.map(fillFromRow);
  }

  async openWindow(window: VolumeWindow): Promise<number> {
    this.#ready("openWindow");
    const w = normalizeWindow(window);
    const seen = new Set<string>();
    for (const fill of w.fills) {
      if (fill.wallet !== w.wallet) throw new LedgerConflictError(`openWindow: fill ${fill.txHash} belongs to ${fill.wallet}, not ${w.wallet}`);
      if (seen.has(fill.txHash)) throw new LedgerConflictError(`openWindow: fill ${fill.txHash} listed twice`);
      seen.add(fill.txHash);
    }
    return this.#tx(async () => {
      await this.#requireWallet(w.wallet, "openWindow");
      const overlap = await this.#query<{ id: number | string; start_l2: string; end_l2: string }>(
        `SELECT id, start_l2::text AS start_l2, end_l2::text AS end_l2 FROM sip_window
          WHERE wallet = $1 AND status <> 'FAILED' AND start_l2 <= $3::bigint AND end_l2 >= $2::bigint
          LIMIT 1`,
        [w.wallet, w.startL2.toString(), w.endL2.toString()],
      );
      const clash = overlap.rows[0];
      if (clash !== undefined) {
        throw new LedgerConflictError(
          `openWindow: (${w.startL2}, ${w.endL2}] of ${w.wallet} overlaps live window ${String(clash.id)} (${clash.start_l2}, ${clash.end_l2}]`,
        );
      }
      const inserted = await this.#query<{ id: number | string }>(
        `INSERT INTO sip_window (wallet, vault, start_l2, end_l2, batch_root, sum_notional_wei, owed_wei, savings_bps, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'OPEN')
           RETURNING id`,
        [w.wallet, w.vault, w.startL2.toString(), w.endL2.toString(), w.batchRoot, w.sumNotionalWei.toString(), w.owedWei.toString(), w.savingsBps],
      );
      const idRow = inserted.rows[0];
      if (idRow === undefined) throw new LedgerConflictError("openWindow: INSERT returned no id");
      const id = toInt(idRow.id, "sip_window.id");
      for (const fill of w.fills) {
        // Every condition of rule 6 is in the WHERE, so "0 rows" is the single answer to all of them;
        // the transaction rolls back and the window never existed.
        const tagged = await this.#query(
          `UPDATE sip_fill f SET window_id = $1, updated_at = now()
            WHERE f.wallet = $2 AND f.tx_hash = $3 AND f.window_id IS NULL
              AND f.block_l2 >= $4::bigint AND f.block_l2 <= $5::bigint
              AND NOT EXISTS (SELECT 1 FROM sip_refusal r WHERE r.wallet = f.wallet AND r.block_l2 = f.block_l2)`,
          [id, w.wallet, fill.txHash, w.startL2.toString(), w.endL2.toString()],
        );
        if ((tagged.rowCount ?? 0) !== 1) {
          throw new LedgerConflictError(
            `openWindow: fill ${fill.txHash} of ${w.wallet} is unknown, already windowed, outside [${w.startL2}, ${w.endL2}], or on a refused block`,
          );
        }
      }
      return id;
    });
  }

  async markWindow(id: number, status: WindowStatus, detail?: unknown): Promise<void> {
    this.#ready("markWindow");
    const windowId = nonNegativeInt(id, "window id");
    await this.#tx(async () => {
      const found = await this.#query<{ status: string }>("SELECT status FROM sip_window WHERE id = $1", [windowId]);
      const current = found.rows[0];
      if (current === undefined) throw new LedgerConflictError(`markWindow: no window ${windowId}`);
      if (current.status === "CONFIRMED" && status !== "CONFIRMED") {
        throw new LedgerConflictError(`markWindow: window ${windowId} is CONFIRMED, which is terminal; refusing ${status}`);
      }
      if (detail === undefined) {
        await this.#query("UPDATE sip_window SET status = $2, updated_at = now() WHERE id = $1", [windowId, status]);
      } else {
        await this.#query("UPDATE sip_window SET status = $2, detail = $3::jsonb, updated_at = now() WHERE id = $1", [
          windowId,
          status,
          JSON.stringify(jsonSafe(detail)),
        ]);
      }
    });
  }

  async recordPull(windowId: number, intent: PullIntent | null, outcome: PullOutcome): Promise<void> {
    this.#ready("recordPull");
    const id = nonNegativeInt(windowId, "window id");
    const row = pullRow(intent, outcome);
    const detail = JSON.stringify(row.detail);
    await this.#tx(async () => {
      const found = await this.#query<{ id: number | string }>("SELECT id FROM sip_window WHERE id = $1", [id]);
      if (found.rows.length === 0) throw new LedgerConflictError(`recordPull: no window ${id}`);
      if (row.txHash === null) {
        await this.#query(
          `INSERT INTO sip_pull (window_id, tx_hash, nonce, contribution_wei, outcome, detail)
             VALUES ($1, NULL, NULL, $2, $3, $4::jsonb)`,
          [id, row.contributionWei.toString(), outcome.kind, detail],
        );
        return;
      }
      const owner = await this.#query<{ window_id: number | string }>("SELECT window_id FROM sip_pull WHERE tx_hash = $1", [row.txHash]);
      const prior = owner.rows[0];
      if (prior !== undefined && toInt(prior.window_id, "sip_pull.window_id") !== id) {
        throw new LedgerConflictError(`recordPull: tx ${row.txHash} was recorded for window ${String(prior.window_id)}, not ${id}`);
      }
      await this.#query(
        `INSERT INTO sip_pull (window_id, tx_hash, nonce, contribution_wei, outcome, detail)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)
           ON CONFLICT (tx_hash) WHERE tx_hash IS NOT NULL DO UPDATE SET
             nonce = EXCLUDED.nonce, contribution_wei = EXCLUDED.contribution_wei,
             outcome = EXCLUDED.outcome, detail = EXCLUDED.detail, updated_at = now()`,
        [id, row.txHash, row.nonce, row.contributionWei.toString(), outcome.kind, detail],
      );
    });
  }

  async addOwed(wallet: Address, wei: bigint): Promise<void> {
    this.#ready("addOwed");
    const address = lowerAddress(wallet, "wallet");
    const amount = nonNegative(wei, "wei");
    const updated = await this.#query("UPDATE sip_wallet SET owed_total_wei = owed_total_wei + $2::numeric, updated_at = now() WHERE address = $1", [
      address,
      amount.toString(),
    ]);
    if ((updated.rowCount ?? 0) === 0) throw new LedgerConflictError(`addOwed: wallet ${address} is not in the ledger; upsertWallets first`);
  }

  async addCollected(wallet: Address, wei: bigint): Promise<void> {
    this.#ready("addCollected");
    const address = lowerAddress(wallet, "wallet");
    const amount = nonNegative(wei, "wei");
    const updated = await this.#query(
      "UPDATE sip_wallet SET collected_total_wei = collected_total_wei + $2::numeric, updated_at = now() WHERE address = $1",
      [address, amount.toString()],
    );
    if ((updated.rowCount ?? 0) === 0) throw new LedgerConflictError(`addCollected: wallet ${address} is not in the ledger; upsertWallets first`);
  }

  async refusals(wallet?: Address): Promise<readonly StoredRefusal[]> {
    this.#ready("refusals");
    const address = wallet === undefined ? null : lowerAddress(wallet, "wallet");
    const found = await this.#query<RefusalRow>(
      `SELECT wallet, block_l2::text AS block_l2, reason, detail, times_seen, first_seen_at, last_seen_at
         FROM sip_refusal WHERE $1::text IS NULL OR wallet = $1
        ORDER BY wallet, block_l2`,
      [address],
    );
    return found.rows.map((row) => ({
      wallet: row.wallet as Address,
      blockL2: toBig(row.block_l2, "sip_refusal.block_l2"),
      reason: row.reason as BlockRefusal["reason"],
      ...(row.detail === null ? {} : { detail: row.detail }),
      timesSeen: toInt(row.times_seen, "sip_refusal.times_seen"),
      firstSeenAt: iso(row.first_seen_at),
      lastSeenAt: iso(row.last_seen_at),
    }));
  }

  async exclusions(wallet?: Address): Promise<readonly Exclusion[]> {
    this.#ready("exclusions");
    const address = wallet === undefined ? null : lowerAddress(wallet, "wallet");
    const found = await this.#query<ExclusionRow>(
      `SELECT wallet, tx_hash, block_l2::text AS block_l2, reason FROM sip_exclusion
        WHERE $1::text IS NULL OR wallet = $1
        ORDER BY block_l2, tx_hash`,
      [address],
    );
    return found.rows.map((row) => ({
      wallet: row.wallet as Address,
      txHash: row.tx_hash as Hex,
      blockL2: toBig(row.block_l2, "sip_exclusion.block_l2"),
      reason: row.reason as Exclusion["reason"],
    }));
  }

  /**
   * The Ledger contract's view of `windows`: what a later pass needs to pick up
   * a window it persisted but could not collect — a DRY_RUN or SKIPPED pull, or
   * a restart between the attestation and the send. Every field of the window
   * comes back, so it can be re-attested without touching the fills again.
   */
  async windowsByStatus(status: WindowStatus, wallet?: Address): Promise<readonly PersistedWindow[]> {
    const found = await this.windows(wallet === undefined ? { status } : { status, wallet });
    return found.map(({ id, status: state, detail, ...window }) => ({ id, status: state, detail, window }));
  }

  async windows(filter: { readonly wallet?: Address; readonly status?: WindowStatus } = {}): Promise<readonly StoredWindow[]> {
    this.#ready("windows");
    const address = filter.wallet === undefined ? null : lowerAddress(filter.wallet, "wallet");
    const found = await this.#query<WindowRow>(
      `SELECT id, wallet, vault, start_l2::text AS start_l2, end_l2::text AS end_l2, batch_root,
              sum_notional_wei::text AS sum_notional_wei, owed_wei::text AS owed_wei, savings_bps, status, detail
         FROM sip_window
        WHERE ($1::text IS NULL OR wallet = $1) AND ($2::text IS NULL OR status = $2)
        ORDER BY id`,
      [address, filter.status ?? null],
    );
    if (found.rows.length === 0) return [];
    const ids = found.rows.map((row) => toInt(row.id, "sip_window.id"));
    const fills = await this.#query<FillRow>(`SELECT ${FILL_COLUMNS} FROM sip_fill WHERE window_id = ANY($1::int[]) ORDER BY block_l2, tx_index`, [ids]);
    const byWindow = new Map<number, Fill[]>();
    for (const row of fills.rows) {
      const key = toInt(row.window_id, "sip_fill.window_id");
      const list = byWindow.get(key) ?? [];
      list.push(fillFromRow(row));
      byWindow.set(key, list);
    }
    return found.rows.map((row) => {
      const id = toInt(row.id, "sip_window.id");
      return {
        id,
        wallet: row.wallet as Address,
        vault: row.vault as Address,
        startL2: toBig(row.start_l2, "sip_window.start_l2"),
        endL2: toBig(row.end_l2, "sip_window.end_l2"),
        fills: byWindow.get(id) ?? [],
        sumNotionalWei: toBig(row.sum_notional_wei, "sip_window.sum_notional_wei"),
        savingsBps: toInt(row.savings_bps, "sip_window.savings_bps"),
        owedWei: toBig(row.owed_wei, "sip_window.owed_wei"),
        batchRoot: row.batch_root as Hex,
        status: row.status as WindowStatus,
        detail: row.detail ?? null,
      };
    });
  }

  async pulls(windowId?: number): Promise<readonly StoredPull[]> {
    this.#ready("pulls");
    const found = await this.#query<PullRow>(
      `SELECT id, window_id, tx_hash, nonce::text AS nonce, contribution_wei::text AS contribution_wei, outcome, detail
         FROM sip_pull WHERE $1::int IS NULL OR window_id = $1
        ORDER BY id`,
      [windowId ?? null],
    );
    return found.rows.map((row) => ({
      id: toInt(row.id, "sip_pull.id"),
      windowId: toInt(row.window_id, "sip_pull.window_id"),
      txHash: row.tx_hash === null ? null : (row.tx_hash as Hex),
      nonce: row.nonce === null ? null : toInt(row.nonce, "sip_pull.nonce"),
      contributionWei: toBig(row.contribution_wei, "sip_pull.contribution_wei"),
      outcome: row.outcome as PullOutcome["kind"],
      detail: row.detail ?? null,
    }));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    // A dead connection has no session left to unlock, and querying it throws where a close must not.
    // The backend released the lock when it died.
    if (this.#lost !== null) {
      await this.#session.end().catch(() => undefined);
      return;
    }
    // Ending the connection releases the advisory lock; doing it explicitly makes an orderly shutdown
    // release immediately rather than at TCP timeout.
    await this.#session.query("SELECT pg_advisory_unlock_all()").catch(() => undefined);
    await this.#session.end().catch(() => undefined);
  }
}

async function defaultConnect(config: pg.ClientConfig): Promise<PgSession> {
  const client = new pg.Client(config);
  await client.connect();
  return client;
}

/**
 * Writes the identity on first use, and refuses to proceed if it disagrees.
 * Ported from keeper-old/src/ledger-pg.ts (#pinIdentity).
 *
 * A database persists across redeploys, so a worker pointed at a new factory or executor would
 * otherwise mix two deployments' fills and windows into one history.
 */
async function pinIdentity(session: PgSession, identity: NonNullable<PgLedgerOptions["identity"]>): Promise<void> {
  const want = {
    chain_id: String(identity.chainId),
    factory: lowerAddress(identity.factory, "identity.factory"),
    executor: lowerAddress(identity.executor, "identity.executor"),
  };
  const existing = await session.query<{ chain_id: string | number; factory: string; executor: string }>(
    "SELECT chain_id, factory, executor FROM sip_instance WHERE id = 1",
  );
  const found = existing.rows[0];
  if (found === undefined) {
    await session.query("INSERT INTO sip_instance (id, chain_id, factory, executor) VALUES (1, $1, $2, $3)", [want.chain_id, want.factory, want.executor]);
    return;
  }
  const differences: string[] = [];
  for (const key of Object.keys(want) as (keyof typeof want)[]) {
    if (String(found[key]) !== want[key]) differences.push(`${key}: ${String(found[key])} != ${want[key]}`);
  }
  if (differences.length > 0) {
    throw new LedgerIdentityMismatchError(
      `This database was created for a different deployment (${differences.join("; ")}). ` +
        "Refusing to start. Point at a fresh database rather than mixing two deployments' history.",
    );
  }
}

/**
 * Postgres implementation; schema in ./schema.ts; advisory lock per worker instance.
 *
 * Order: connect → lock → DDL → identity pin. The lock comes before the DDL because it needs no
 * tables and because holding it first means two workers never run the DDL at once.
 */
export async function openPgLedger(databaseUrl: string, options: PgLedgerOptions = {}): Promise<SipLedger> {
  const initialCursorL2 = nonNegative(options.initialCursorL2 ?? 0n, "initialCursorL2");
  const session = await (options.connect ?? defaultConnect)(pgClientConfig(databaseUrl, options));
  const ledger = new PgLedger(session, initialCursorL2);

  // THIS LISTENER IS NOT OPTIONAL, IT IS LOAD-BEARING. pg.Client is an EventEmitter, and an 'error'
  // with no listener is an uncaught exception: Node exits. Reproduced against a real Postgres —
  // terminating the backend killed the whole process, printing FATAL 57P01 and never reaching the
  // next line. Recorded rather than thrown: the throw would have nowhere to go from an async event.
  // The next call turns it into a real error, at a call site that can respond.
  session.on("error", (error: Error) => {
    ledger.markLost(error.message);
  });

  try {
    // try_ rather than the blocking form: a worker that cannot get the lock must say so and exit,
    // not hang forever looking healthy.
    const key = advisoryKeyFor(SIP_WORKER_LOCK_NAME);
    const lock = await session.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [key.toString()]);
    if (lock.rows[0]?.locked !== true) {
      // Asked before throwing, on this same connection, because the answer stops being available the
      // moment it is closed.
      const holder = await findLockHolder(session, key);
      throw new LedgerBusyError(holder);
    }
    for (const statement of SCHEMA_SQL) await session.query(statement);
    if (options.identity !== undefined) await pinIdentity(session, options.identity);
    return ledger;
  } catch (error) {
    await session.end().catch(() => undefined);
    throw error;
  }
}
