// The durable settled-window store: a node:sqlite database whose SCHEMA, not
// whose application code, is what refuses a double settlement.
//
// WHY THIS REPLACED A HAND-ROLLED JSONL JOURNAL. The previous store was 1,314
// lines of append-only text with a hash chain, tail repair, torn-write detection
// and a sequence tripwire. Two of its three blocking defects were artefacts of
// hand-rolling durability and simply cease to exist under ACID:
//
//   * repairTail() truncated everything after the FIRST hash-chain break wherever
//     it occurred — including CONFIRMED and DEGRADED records — while its comment
//     claimed it only ever cut the end. There is no tail repair here. A crash
//     mid-transaction rolls back, byte-exactly, and PRAGMA integrity_check
//     REPORTS damage rather than deleting it.
//   * the append() tripwire compared the sequence NUMBER rather than the record,
//     so it passed whenever anyone else wrote at that seq. Inside BEGIN IMMEDIATE
//     no other connection can have written, and a COMMIT either succeeds or
//     throws. There is nothing left to trip.
//
// THE THIRD DEFECT WAS A DESIGN ERROR AND IS FIXED DELIBERATELY, IN THE SCHEMA.
// lastEndBlockL1 / lastEndBlockL2 / settlementCount used to be keyed on
// bindingEpoch, exactly like the vault's own guards. A rebind therefore handed
// the keeper a fresh, empty namespace: PROGRESSION found no entry for the new
// epoch and passed, NOVELTY missed because sessionId commits bindingEpoch and so
// the same window re-derives to a new id, and TERMINAL only ever covered windows
// that were SKIPPED. The whole settled history became replayable. The contract's
// guards (PersonalVault.sol:543-549) reset on a rebind too — which is PRECISELY
// why service-side dedup exists, so mirroring the weakness defeated its purpose.
//
// THE DEDUP KEY IS THE L2 WINDOW, `(account, startBlockL2, endBlockL2)`. It is
// the only identifier that is both epoch-independent and content-independent:
//   * sessionId folds bindingEpoch AND ledgerRoot in (SettlementExecutor.sol
//     :185-189), so it moves on a rebind and on a root re-encoding;
//   * usedSessions is doubly epoch-scoped;
//   * lastEndBlock[account][bindingEpoch] is an epoch-keyed map that a rebind
//     empties;
//   * settlementNonce survives a rebind but counts settlements, it does not
//     identify one;
//   * the attested startBlock/endBlock are L1, and many L2 blocks map to one L1
//     block (measured 64:1 to 120:1), so the L1 range cannot identify a session.
//
// AND IT IS ENFORCED AS A FRONTIER CHAIN, NOT A BARE UNIQUE. A bare
// UNIQUE(account, start, end) decides only EXACT duplicates; it accepts a subset,
// an overlap and a superset, and a post-rebind re-derivation with a tighter
// replay start produces exactly a subset. So settled L2 coverage is modelled as
// one strictly increasing chain of disjoint intervals: every settlement names the
// frontier it extends (prev_end_block_l2), a CHECK requires start > prev, partial
// UNIQUE indexes say a frontier is extended at most once and exists at most once
// (plus one for the single genesis row, because SQLite treats NULLs as distinct),
// and a BEFORE INSERT trigger requires prev to BE the current live frontier.
// bindingEpoch appears in the row as recorded data and in NO key, index or
// constraint that governs replay.
//
// TWO DIFFERENT QUESTIONS, TWO DIFFERENT SCOPES. "Is this a replay?" is answered
// epoch-INDEPENDENTLY in L2 space by the frontier. "Will the chain revert this?"
// is answered epoch-SCOPED in L1 space by `chainGuardL1`, which is a deliberate
// mirror of PersonalVault:543-546 and is documented, here and at its every use,
// as A REVERT PREDICTOR ONLY. Collapsing the two — which is what happens if
// replay detection keys on L1 — either forfeits real revenue forever or pays
// twice, depending on which way it collapses. That distinction is what keeps
// L1_RANGE_COLLAPSED separable from ALREADY_SETTLED.
//
// WHAT THE HASH CHAIN WAS ALSO DOING, AND IS STILL DOING. An ACID transaction
// protects against torn writes and interleaving. It does NOT detect a human or a
// script editing a committed row — raising a contribution by hand is exactly the
// edit an attacker would make. So every record row still carries a digest over
// (seq, prevDigest, type, ts, body), verified on read. A row that fails is
// REPORTED AND NOT ADMITTED, and — unlike the old loader — everything after it
// still verifies, because each row chains to its predecessor's STORED digest.
// Out-of-band editing is therefore in scope and detected, and detection never
// destroys anything.
//
// WHAT THIS FILE IS AND IS NOT. It is defence in depth plus an intent
// write-ahead log. It is NOT the only barrier against a double settlement:
// PersonalVault.acceptSettlement enforces monotone progression on startBlock and
// a usedSessions set. This store exists because
//   (a) `previousEnd != 0` leaves the first settlement of each bindingEpoch
//       unguarded onchain, and a rebind makes every epoch a first,
//   (b) `lastEndBlock` has NO public getter, so the last settled boundary cannot
//       be read back and MUST be persisted or re-derived from calldata,
//   (c) the onchain guards are in coarse L1 block space, so they cannot tell a
//       genuinely new L2 session from an already-consumed one, and
//   (d) every duplicate attempt the local rule fails to stop burns the trader's
//       gas on a revert.
//
// WHAT THIS STORE MAY NEVER DO IS BE CONFIDENTLY EMPTY. Its rules are keyed on
// rows it holds, so an empty store refuses nothing. That is fine on a genuinely
// new account and catastrophic after a lost volume, and the two look identical
// from here. So each settlement records the vault settlementNonce it consumed
// (LedgerState.settledSettlementNonces), which lets reconcile.ts state a
// checkable invariant: the chain says N nonces were consumed, so the store must
// be able to NAME all N. Nothing may excuse a nonce it cannot name except an
// explicit, durable, BOUNDED operator acknowledgement.
//
// LEGIBILITY. The JSONL format's stated decisive advantage was `cat` during an
// incident. That is revoked at the file level and re-satisfied at the command
// level: `keeper journal` prints every record, in order, with its seq and its
// decoded body, and exits non-zero when integrity is not intact. Every wei value
// is still a decimal string in the record body, and the whole record stream is
// still a public, side-effect-free query (Ledger.read / ledger.readRecords).

import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createRequire } from "node:module";
import { hostname } from "node:os";
import { join } from "node:path";
import type { DatabaseSync as DatabaseSyncType, StatementSync } from "node:sqlite";

/**
 * BUMPED FROM "nuvem.keeper.ledger.v1". This value is the gate that stops a v1
 * JSONL volume being opened by a SQLite build, and vice versa: it is pinned in
 * instance.json and compared on every open, and a mismatch throws
 * LedgerIdentityError rather than migrating.
 */
export const LEDGER_SCHEMA = "nuvem.keeper.ledger.v2-sqlite";
/** Mirrors @nuvem/session-engine's LEDGER_SCHEMA_V2. It tracks the ENGINE, never the storage layer. */
export const ENGINE_SCHEMA = "nuvem.ledger.v2";
/** The database schema version. A different one refuses to start; it is never migrated in place. */
export const STORE_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// node:sqlite, loaded with a NARROW warning filter.
//
// `require("node:sqlite")` emits, once, an ExperimentalWarning. NODE_NO_WARNINGS
// and --no-warnings would silence EVERY warning in a process that signs
// transactions, including the deprecations that predict the next breakage;
// --disable-warning=ExperimentalWarning would silence every experimental warning,
// so a future dependency reaching for another experimental API would go unnoticed.
// So the filter matches this one message, is installed for the microseconds the
// import takes, and is restored immediately. The swallowed text is RETAINED and
// published on `keeper status`, so it is acknowledged rather than hidden — and
// the day the wording changes the filter stops matching and the warning reappears
// rather than being lost.
// ---------------------------------------------------------------------------
const acknowledgedExperimentalWarnings: string[] = [];

function loadSqlite(): { DatabaseSync: typeof DatabaseSyncType } {
  const original = process.emitWarning;
  process.emitWarning = function patched(warning: unknown, ...rest: unknown[]): void {
    const isObject = typeof warning === "object" && warning !== null;
    const name = isObject ? (warning as Error).name : (rest[0] as string | undefined);
    const message = isObject ? (warning as Error).message : String(warning);
    if (name === "ExperimentalWarning" && /SQLite is an experimental feature/i.test(message)) {
      acknowledgedExperimentalWarnings.push(message);
      return;
    }
    (original as (...args: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    return createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: typeof DatabaseSyncType };
  } finally {
    process.emitWarning = original;
  }
}

const { DatabaseSync } = loadSqlite();

/** Experimental warnings this build deliberately swallowed. Published on `keeper status`. */
export const experimentalWarnings = (): readonly string[] => [...acknowledgedExperimentalWarnings];

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Identity the volume is pinned to. A mismatch refuses to start; it never migrates. */
export interface LedgerInstance {
  readonly chainId: number;
  readonly factory: string;
  readonly executor: string;
  readonly vault: string;
  readonly account: string;
  readonly ledgerSchema: string;
  readonly engineSchema: string;
}

/** The L2 window a record is about. The primary key of everything here. */
export interface WindowRef {
  readonly startBlockL2: bigint;
  readonly endBlockL2: bigint;
}

export const windowKey = (window: WindowRef): string => `${window.startBlockL2}:${window.endBlockL2}`;

export interface SettlementFacts extends WindowRef {
  readonly sessionId: string;
  readonly bindingEpoch: bigint;
  readonly settlementNonce: bigint;
  readonly startBlockL1: bigint;
  readonly endBlockL1: bigint;
  readonly ledgerRoot: string;
  readonly contribution: bigint;
  readonly realizedProfit: bigint;
}

export type RecordType =
  | "HEADER"
  | "CHECKPOINT"
  | "INTENT"
  | "CONFIRMED"
  | "FAILED"
  | "ABANDONED"
  | "SKIPPED"
  | "ADOPTED"
  | "DRYRUN"
  | "DEGRADED"
  | "RESUMED";

const RECORD_TYPES: readonly RecordType[] = [
  "HEADER",
  "CHECKPOINT",
  "INTENT",
  "CONFIRMED",
  "FAILED",
  "ABANDONED",
  "SKIPPED",
  "ADOPTED",
  "DRYRUN",
  "DEGRADED",
  "RESUMED",
];

export type SkipReason =
  | "REFUSED"
  | "NON_POSITIVE_PROFIT"
  | "BELOW_MINIMUM"
  | "SPAN_TOO_WIDE"
  | "L1_RANGE_COLLAPSED"
  | "BINDING_EPOCH_ADVANCED"
  | "ALREADY_SETTLED";

export interface HeaderBody extends LedgerInstance {
  readonly createdAt: string;
  /**
   * The chain's settlementNonce when this store was created — an OBSERVATION,
   * never a licence.
   *
   * IT USED TO BE LOAD-BEARING AND THAT WAS THE BUG. reconcile() computed
   * `expected = baselineSettlementNonce + recordCount` and only hunted the chain
   * when `observed > expected`. On a wiped volume the header is written fresh
   * from the live snapshot, so baseline == observed and the difference was always
   * zero: the keeper concluded "nothing to adopt", left the settled boundary
   * empty, and reported nonceReconciled TRUE while knowing nothing about any
   * prior settlement. NOTHING reads this field for accounting. It survives for
   * audit only: it records what the chain looked like when the volume was made.
   */
  readonly baselineSettlementNonce: bigint;
  readonly baselineLifetimeContribution: bigint;
}

export interface CheckpointBody {
  readonly anchorBlockL2: bigint;
  readonly anchorBlockHash: string;
  readonly headBlockL2: bigint;
}

/**
 * The pre-broadcast write-ahead record. It carries the already-signed
 * transaction's hash and the exact EOA nonce it was signed for, which together
 * make the crash-after-broadcast case resolvable against the chain. It carries
 * the attester ADDRESS and never any signature material beyond that.
 */
export interface IntentBody extends SettlementFacts {
  readonly attestationDigest: string;
  readonly attester: string;
  readonly eoaNonce: number;
  readonly rawTxHash: string;
  readonly gasLimit: bigint;
  readonly maxFeePerGas: bigint;
  readonly validAfter: number;
  readonly deadline: number;
  readonly cashStart: bigint;
  readonly cashEnd: bigint;
  readonly externalDeposits: bigint;
  readonly externalWithdrawals: bigint;
}

/** How well this settlement's L2 coverage is known. */
export type L2Precision =
  /** The keeper cut this window itself, or the exact preimage was recovered. */
  | "EXACT"
  /**
   * Recovered from the chain by clamping the attested L1 range into L2 space.
   * It claims a SUPERSET of the true window, which can forfeit a genuine session
   * that hid inside an already-consumed L1 block and can NEVER double-pay.
   */
  | "L1_CLAMP"
  /**
   * Recovered, and found to lie entirely at or below the settled frontier — an
   * out-of-order adoption of an older settlement. It makes NO new coverage claim
   * (the frontier already covers it), so it stays out of the frontier chain
   * rather than being forced forward into blocks it never touched. Its
   * settlementNonce is still nameable, which is the whole point of adopting it.
   */
  | "COVERED"
  /**
   * The L2 window of a chain-adopted settlement could not be determined at all.
   * The frontier is therefore unknown, and localEligibility refuses EVERY window
   * with rule COVERAGE_UNRESOLVED until it is.
   */
  | "UNRESOLVED";

export interface ConfirmedBody extends SettlementFacts {
  readonly txHash: string;
  readonly blockNumberL2: bigint;
  readonly gasUsed: bigint;
  readonly source: "own" | "adopted";
  /**
   * Defaults to EXACT for source "own". For an ADOPTED record it defaults to
   * UNRESOLVED when both L2 slots are zero — a zero there means "unknown", never
   * "block zero" — and to L1_CLAMP otherwise.
   */
  readonly l2Precision?: L2Precision;
}

export interface FailedBody extends WindowRef {
  readonly sessionId: string;
  readonly txHash: string;
  readonly reason: string;
}

export interface AbandonedBody extends WindowRef {
  readonly sessionId: string;
  readonly rawTxHash: string;
  readonly reason: string;
}

export interface SkippedBody extends WindowRef {
  readonly reason: SkipReason;
  readonly detail: string;
  /** Refusal reasons straight from the engine, when reason === "REFUSED". */
  readonly engineReasons?: readonly string[];
  readonly endBlockL1?: bigint;
  readonly bindingEpoch?: bigint;
}

export interface DryRunBody extends SettlementFacts {
  readonly attestationDigest: string;
  readonly attester: string;
  readonly wouldSendTo: string;
  readonly wouldSendValue: bigint;
}

export interface DegradedBody {
  readonly reason: string;
  readonly detail: string;
  /**
   * Set by reconcile() when it halted because the chain reports settlements this
   * store cannot name. It is the EXCLUSIVE upper bound of the unaccounted range.
   *
   * This is what makes the operator acknowledgement DURABLE and BOUNDED. A
   * RESUMED that clears this halt raises acknowledgedNonceFloor to this value, so
   * the same shortfall is not re-detected on the very next tick (which would
   * latch again forever and make `--acknowledge-degraded` useless), and —
   * critically — the acknowledgement does NOT extend to any settlement that
   * happens afterwards.
   */
  readonly unaccountedBelow?: bigint;
}

export interface ResumedBody {
  readonly acknowledgedSeq: number;
  readonly note: string;
}

export type RecordBody =
  | HeaderBody
  | CheckpointBody
  | IntentBody
  | ConfirmedBody
  | FailedBody
  | AbandonedBody
  | SkippedBody
  | DryRunBody
  | DegradedBody
  | ResumedBody;

export interface JournalRecord<T extends RecordBody = RecordBody> {
  readonly seq: number;
  readonly ts: string;
  readonly type: RecordType;
  readonly prevHash: string;
  readonly hash: string;
  readonly body: T;
}

// ---------------------------------------------------------------------------
// Serialization
//
// bigints are written as decimal strings rather than a tagged wrapper, because
// `keeper journal` has to stay legible to a human. That means the reader needs to
// know which names are bigints. The set is explicit and CLOSED for exactly that
// reason: an implicit "anything numeric-looking" rule would silently turn a
// future string field into a BigInt and throw at load time on a valid store.
//
// It also matters for storage. Wei-scale values exceed 2^63 (node:sqlite throws
// "BigInt value is too large to bind" at 2^64), so no wei value may ever live in
// a SQLite INTEGER column. Every one of them is decimal TEXT, and none of them is
// ever ORDER BY'd or SUM'd in SQL — TEXT compares lexicographically, so '9' > '10'.
// Aggregation happens in JS, with BigInt.
// ---------------------------------------------------------------------------
const BIGINT_FIELDS: ReadonlySet<string> = new Set([
  "startBlockL2",
  "endBlockL2",
  "startBlockL1",
  "endBlockL1",
  "bindingEpoch",
  "settlementNonce",
  "contribution",
  "realizedProfit",
  "cashStart",
  "cashEnd",
  "externalDeposits",
  "externalWithdrawals",
  "anchorBlockL2",
  "headBlockL2",
  "blockNumberL2",
  "gasUsed",
  "gasLimit",
  "maxFeePerGas",
  "baselineSettlementNonce",
  "baselineLifetimeContribution",
  "unaccountedBelow",
]);

function encode(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) out[key] = encode(inner);
    return out;
  }
  return value;
}

function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = BIGINT_FIELDS.has(key) && typeof inner === "string" ? BigInt(inner) : decode(inner);
    }
    return out;
  }
  return value;
}

/**
 * The bytes a record's integrity digest commits to. Field order is fixed by
 * construction (seq, prevDigest, type, ts, then the body's own JSON) so the
 * digest does not depend on how an object literal happened to be written.
 *
 * THIS IS THE ONE THING AN ACID TRANSACTION DOES NOT GIVE. A transaction cannot
 * tell that someone opened the file with `sqlite3` and raised a contribution.
 * This can.
 */
function digestOf(seq: number, prevDigest: string, type: RecordType, ts: string, body: unknown): string {
  const preimage = JSON.stringify([seq, prevDigest, type, ts, encode(body)]);
  return `0x${createHash("sha256").update(preimage).digest("hex")}`;
}

const GENESIS = `0x${"0".repeat(64)}`;

// ---------------------------------------------------------------------------
// Derived state
// ---------------------------------------------------------------------------

/**
 * THE STORE HAS THREE STATES, NOT TWO.
 *
 * The code used to think in {empty, populated}, and that is precisely how a
 * damaged store became a double settlement: SQLite accepts a 0-byte file as a
 * perfectly valid empty database, so a disk-full write, a truncating restore, a
 * volume mounted before the file materialised or a bad backup all produced a file
 * that `Ledger.open` cheerfully re-created the schema over. The keeper then held
 * no history, complained about nothing, and every settled window was replayable —
 * which is the same catastrophe the bindingEpoch rebind used to cause, reached by
 * a different road.
 *
 *   ABSENT   the file does not exist at all. A GENUINE FIRST RUN. Proceed.
 *   HEALTHY  the file exists, is a SQLite database, passes PRAGMA quick_check and
 *            holds this keeper's schema. Proceed.
 *   DAMAGED  the file exists but is empty, truncated, not a SQLite database, is
 *            missing tables, or its write-ahead log is orphaned. REFUSE — and
 *            refuse LOUDLY, naming the file, because the alternative is to be
 *            confidently empty.
 *
 * DAMAGED IS A VALUE, NOT AN EXCEPTION. A getter that throws breaks the
 * inspection commands that exist for exactly this incident. THE RULE IS: READ
 * PATHS DEGRADE AND REPORT, WRITE PATHS REFUSE. An operator must always be able
 * to SEE the damage and must never be able to settle through it.
 */
export type StoreCondition = "ABSENT" | "HEALTHY" | "DAMAGED";

/** What a pre-open look at the files on disk can establish without SQLite's help. */
export interface StoreProbe {
  readonly condition: StoreCondition;
  /** Operator-facing, names the file, and says how to recover. `null` iff not DAMAGED. */
  readonly detail: string | null;
  /** `null` when the database file does not exist. */
  readonly sizeBytes: number | null;
  readonly walBytes: number | null;
  readonly shmBytes: number | null;
}

export interface JournalRead {
  /** Every record whose own integrity digest verified, in seq order. */
  readonly records: JournalRecord[];
  /**
   * False when a row failed its digest, the seq run is not dense, PRAGMA
   * integrity_check failed, OR THE DECISION TABLES DO NOT FOLLOW FROM THE RECORD
   * STREAM. That last clause is the point: the record table is an audit log, and
   * the settlement / terminal_window / halt tables are what actually refuse a
   * double settle. Integrity that covered only the audit log left every
   * decision-bearing row editable without complaint.
   */
  readonly integrityOk: boolean;
  readonly integrityDetail: string | null;
  /** Record seqs that failed their digest and were therefore NOT admitted. */
  readonly rejected: readonly number[];
  /** Size of the database file in bytes, for an operator's sanity check. */
  readonly totalBytes: number;
  /** ABSENT, HEALTHY or DAMAGED. A read path renders it; a write path refuses on DAMAGED. */
  readonly condition: StoreCondition;
}

export interface LedgerState {
  /** Highest record seq, dense from 0. -1 on an empty store. The operator's handle on a record. */
  readonly seq: number;
  /** Digest of the last record: a stable summary of the whole history. */
  readonly head: string;
  readonly header: HeaderBody | null;
  readonly anchorBlockL2: bigint | null;
  readonly anchorBlockHash: string | null;

  /**
   * THE SETTLED L2 FRONTIER: the highest endBlockL2 of any live settlement
   * (INTENT or CONFIRMED), across EVERY bindingEpoch. `null` when nothing is
   * settled. This is the epoch-INDEPENDENT replay boundary, and it is the direct
   * fix for the rebind defect: it does not move when an admin pause/resume
   * increments bindingEpoch.
   */
  readonly settledFrontierL2: bigint | null;
  /** Highest CONFIRMED endBlockL1 across every epoch. Reporting only; not a guard. */
  readonly settledHighWaterL1: bigint | null;
  /**
   * bindingEpoch -> highest CONFIRMED endBlockL1 for that epoch.
   *
   * A REVERT PREDICTOR ONLY. It is a faithful mirror of
   * PersonalVault.lastEndBlock[account][bindingEpoch] (PersonalVault.sol:543-546),
   * INCLUDING the weakness that a rebind resets it. It exists to save gas on a
   * settle the chain would refuse, and to let keeper.ts tell an L1 range collapse
   * from a replay. It must NEVER be used to decide whether a window was already
   * settled — that is settledFrontierL2's job.
   */
  readonly chainGuardL1: ReadonlyMap<string, bigint>;
  /**
   * Highest endBlockL2 of any window recorded terminal. Epoch-independent.
   * A refused window moved no money, so this never touches ANY L1 boundary and
   * never enters the settled frontier — it only stops a slightly-different
   * re-cut of an already-refused window being verified again forever.
   */
  readonly refusedHighWaterL2: bigint | null;

  readonly settledSessionIds: ReadonlySet<string>;
  /** CONFIRMED plus ADOPTED settlements, across every epoch. A plain count, no longer epoch-keyed. */
  readonly settlementCount: number;
  /** Sum of every CONFIRMED contribution, in wei. Summed in JS, never in SQL. */
  readonly settledContributionWei: bigint;
  /**
   * Every vault settlementNonce this store can NAME, as decimal strings.
   *
   * The spine of requirement 3. PersonalVault consumes settlement nonces 0,1,2,…
   * strictly in order and never resets them — not even on a rebind (_activate at
   * PersonalVault.sol:721-724 bumps bindingEpoch and policyNonce and leaves
   * settlementNonce alone) — so `settlementNonce == N` read off the chain means
   * nonces 0..N-1 were each consumed by exactly one settlement. A store that
   * cannot name one of them cannot know that settlement's block boundary, and
   * lastEndBlock has no getter.
   *
   * A COUNT would not do: two errors that cancel (one settlement forgotten, one
   * adopted twice) balance a count while leaving a hole. A set of nonces cannot
   * be balanced by accident. It is deliberately NOT keyed on bindingEpoch.
   */
  readonly settledSettlementNonces: ReadonlySet<string>;
  /**
   * Settlement nonces strictly below this are excused from the accounting above,
   * because an operator explicitly acknowledged a halt that NAMED them. Derived
   * as the MAX over cleared halts, so it only ever rises, and a halt that
   * recorded no bound excuses nothing.
   */
  readonly acknowledgedNonceFloor: bigint;
  /** INTENTs with no CONFIRMED / FAILED / ABANDONED for the same window. At most one. */
  readonly openIntents: readonly JournalRecord<IntentBody>[];
  /**
   * Every CONFIRMED and ADOPTED record, in order. Kept so a reorg can re-verify
   * that each settlement this store believes in is still on the chain — "the
   * money went twice" and "the money never went" are not distinguishable by
   * retrying.
   */
  readonly confirmedRecords: readonly JournalRecord<ConfirmedBody>[];
  /** Windows that will never be reconsidered: refused, unprofitable, too wide. */
  readonly terminalWindows: ReadonlyMap<string, SkipReason>;
  /** Unix ms of every confirmed settlement, for the per-day circuit breaker. */
  readonly confirmedAtMs: readonly number[];
  readonly degraded: { readonly seq: number; readonly reason: string; readonly detail: string } | null;
  readonly counts: Readonly<Record<RecordType, number>>;
  /** Live settlements whose L2 coverage could not be determined. Any is a hard refusal. */
  readonly coverageUnresolved: number;
  /**
   * False when a record failed its digest, the seq run is not dense, the file is
   * damaged, OR THE DECISION TABLES DISAGREE WITH THE RECORD STREAM.
   */
  readonly integrityOk: boolean;
  readonly integrityDetail: string | null;
  /**
   * ABSENT | HEALTHY | DAMAGED, as a VALUE that read paths render and write paths
   * refuse on. `state` never throws, whatever shape the store is in — inventory
   * guarantee #26, and the reason an inspection command works during the incident
   * it exists for. DAMAGED always implies integrityOk false; the converse does
   * not hold, because a tampered row in an otherwise-sound file is a content
   * problem, not a structural one.
   */
  readonly condition: StoreCondition;
}

const emptyCounts = (): Record<RecordType, number> => ({
  HEADER: 0,
  CHECKPOINT: 0,
  INTENT: 0,
  CONFIRMED: 0,
  FAILED: 0,
  ABANDONED: 0,
  SKIPPED: 0,
  ADOPTED: 0,
  DRYRUN: 0,
  DEGRADED: 0,
  RESUMED: 0,
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
export class LedgerIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerIdentityError";
  }
}

export class LedgerLockedError extends Error {
  constructor(
    readonly holder: string,
    why: string,
  ) {
    super(
      `Another keeper holds the state lock (${holder}). ${why} Two keepers on one volume would ` +
        "both see an unsettled window and both broadcast, and one would pay for a revert at best. " +
        "The database's own constraints would refuse the second settlement, but the lock is what " +
        "stops the attempt being made and the gas being spent.\n" +
        "A lock left behind by a hard kill is reclaimed AUTOMATICALLY on the next start, so a " +
        "crash-loop is not the expected outcome and --force-unlock is not the routine fix. If you " +
        "are seeing this, the holder looks alive. Stop it first.\n" +
        "Only when you have confirmed with your own eyes that no other keeper is running, pass " +
        "--force-unlock ONCE, interactively. NEVER put --force-unlock in docker-compose's " +
        "`command:` — that disables the single-writer interlock for every future start, which is " +
        "the one configuration that genuinely allows two keepers to race one store.",
    );
    this.name = "LedgerLockedError";
  }
}

/** Raised when the store could not accept a write. Never a silent success. */
export class LedgerWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerWriteError";
  }
}

/**
 * The store REFUSED a write because a constraint would have been violated.
 *
 * This is the schema doing the job the application logic was supposed to have
 * done already. Reaching it is not routine: it means a candidate got as far as
 * being recorded that the database can prove is a replay, a second in-flight
 * settlement, or a reused settlementNonce. It is never retried.
 */
export class LedgerConstraintError extends Error {
  constructor(
    /** NOT_DEGRADED | REPLAY | SINGLE_FLIGHT | NONCE_REUSE | NOVELTY | MALFORMED | IDENTITY | UNKNOWN */
    readonly rule: string,
    readonly errcode: number | null,
    message: string,
  ) {
    super(message);
    this.name = "LedgerConstraintError";
  }
}

// ---------------------------------------------------------------------------
// The single-writer lock. Carried across from the JSONL store UNCHANGED.
//
// The SQLite rewrite makes this lock unnecessary for CORRUPTION — WAL plus
// BEGIN IMMEDIATE serializes writers, and the frontier constraints refuse a
// second settlement outright. It is kept anyway, because it prevents something
// the constraints cannot: two keepers each holding a signing key, each
// discovering the same window, each spending the trader's gas to find out that
// only one of them may record it. Losing the interlock would make a double
// deployment cheap to do and expensive to discover.
// ---------------------------------------------------------------------------

/** What the lockfile records. Every field is here to answer "is the holder alive?". */
interface LockBody {
  readonly pid: number;
  readonly startedAt: string;
  readonly hostname: string;
  /**
   * When the holder PROCESS started, not when it took the lock. This is what
   * makes the container case decidable: under `restart: unless-stopped` the
   * replacement keeper is pid 1 again, so pid equality proves nothing on its own
   * — but a pid-1 lock whose process start time is not this process's start time
   * was written by a previous incarnation that is definitionally gone.
   */
  readonly processStartedAt: string;
  readonly reclaimedFrom?: LockBody;
}

export interface LockReclaim {
  readonly previous: LockBody | { readonly unparseable: string };
  readonly why: string;
}

/**
 * Our own process's start instant, computed ONCE.
 *
 * It has to be computed once. `Date.now() - process.uptime() * 1000` jitters by a
 * millisecond or two between calls, because uptime is sub-millisecond and the two
 * clocks are read at different moments. A recomputed value would therefore differ
 * from the one this same process wrote into the lockfile, and the staleness test
 * below — "same pid, different process start, so the holder is a previous
 * incarnation" — would fire against a lock we are genuinely holding. That is the
 * one mistake this whole mechanism must not make: it would hand a second writer a
 * store that is already open.
 */
const OWN_PROCESS_STARTED_AT = new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString();

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH: no such process. EPERM: it exists and belongs to someone else, so
    // it is alive and emphatically not ours to reclaim.
    return (error as { code?: string }).code === "EPERM";
  }
}

/**
 * Takes the single-writer lock, reclaiming it when the recorded holder is
 * provably gone.
 *
 * THE FAILURE MODE THIS FIXES IS SOCIAL, NOT TECHNICAL. `openSync(path, "wx")`
 * genuinely excludes a second writer. What was wrong is that close() was the only
 * thing that removed the lock, so any SIGKILL (OOM, `docker kill`, host reset,
 * anything past the stop grace period) left a lock nobody held. With
 * `restart: unless-stopped` that became an endless crash loop whose documented
 * escape was `--force-unlock` — and the only durable way to apply a flag in
 * compose is to put it in `command:`, at which point the interlock is off for
 * every future start. A safety mechanism whose failure mode pressures the
 * operator into disabling it permanently is worse than none.
 *
 * So the lock heals itself, and it does so only on EVIDENCE:
 *
 *   - the recorded pid is our own pid, but the recorded process start time is not
 *     ours. We are not our own predecessor, so that holder is gone. This is
 *     exactly the container case, where the replacement is pid 1 again.
 *   - the recorded pid is not alive at all.
 *
 * It refuses, and asks for a human, when the evidence is absent: an unparseable
 * lockfile, a lock written on a different host (a shared volume, where we cannot
 * probe the holder), or a live pid that is not us. Pid reuse by an unrelated
 * process is the reason "alive" is never overridden automatically — reclaiming
 * there could start a second writer, which is the accident the lock exists for.
 */
function acquireLock(lockPath: string, forceUnlock: boolean, nowIso: string): LockReclaim | null {
  const self: LockBody = {
    pid: process.pid,
    startedAt: nowIso,
    hostname: hostname(),
    processStartedAt: OWN_PROCESS_STARTED_AT,
  };

  const write = (body: LockBody): void => {
    const fd = openSync(lockPath, "wx", 0o600);
    try {
      writeSync(fd, `${JSON.stringify(body)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };

  const claim = (reclaim: LockReclaim | null): LockReclaim | null => {
    const previous = reclaim && "pid" in reclaim.previous ? reclaim.previous : undefined;
    write(previous ? { ...self, reclaimedFrom: previous } : self);
    return reclaim;
  };

  if (forceUnlock && existsSync(lockPath)) {
    let raw = "";
    try {
      raw = readFileSync(lockPath, "utf8").trim();
    } catch {
      /* ignore */
    }
    unlinkSync(lockPath);
    return claim({ previous: { unparseable: raw }, why: "--force-unlock was passed" });
  }

  try {
    return claim(null);
  } catch (error) {
    if ((error as { code?: string }).code !== "EEXIST") throw error;
  }

  let raw = "";
  try {
    raw = readFileSync(lockPath, "utf8").trim();
  } catch {
    /* ignore */
  }

  let held: LockBody | null = null;
  try {
    const parsed = JSON.parse(raw) as Partial<LockBody>;
    if (typeof parsed.pid === "number") {
      held = {
        pid: parsed.pid,
        startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "unknown",
        // A lockfile written by an EARLIER BUILD carries only {pid, startedAt}. It
        // has to be judgeable, or the first start after an upgrade meets the very
        // crash loop this function exists to remove — so a missing hostname is
        // read as "this host", which is where that build was running, and a missing
        // process start reads as "not ours", which makes a leftover pid of our own
        // reclaimable. Either way the pid still has to be dead, or be us.
        hostname: typeof parsed.hostname === "string" ? parsed.hostname : hostname(),
        processStartedAt: typeof parsed.processStartedAt === "string" ? parsed.processStartedAt : "unknown",
      };
    }
  } catch {
    held = null;
  }

  if (held === null) {
    // A lockfile we cannot read is a lockfile we cannot judge. It could have been
    // torn mid-write, or written by something else entirely. Refuse rather than
    // guess. The contents are echoed clipped and on one line: this string reaches
    // an operator's terminal, and nothing whose provenance is unknown should be
    // spilled into it at length.
    throw new LedgerLockedError(
      raw === "" ? "an empty or unreadable lockfile" : `${raw.replace(/\s+/g, " ").slice(0, 120)} (clipped)`,
      "Its contents could not be parsed, so this keeper cannot tell whether the holder is alive.",
    );
  }

  if (held.hostname !== self.hostname) {
    throw new LedgerLockedError(
      `pid ${held.pid} on ${held.hostname}, since ${held.startedAt}`,
      `It was taken on a different host (${held.hostname}, we are ${self.hostname}), so its ` +
        "process cannot be probed from here. A state volume shared between hosts is not supported.",
    );
  }

  const staleBecause =
    held.pid === self.pid && held.processStartedAt !== self.processStartedAt
      ? `the lock records our own pid ${held.pid} but a different process start (${held.processStartedAt} vs ` +
        `${self.processStartedAt}); a process cannot be waiting on itself, so the holder is a previous ` +
        "incarnation that was killed without releasing it"
      : held.pid !== self.pid && !isAlive(held.pid)
        ? `pid ${held.pid} is not running`
        : null;

  if (staleBecause === null) {
    throw new LedgerLockedError(
      `pid ${held.pid} on ${held.hostname}, since ${held.startedAt}`,
      "That process is still running.",
    );
  }

  unlinkSync(lockPath);
  return claim({ previous: held, why: `stale lock reclaimed: ${staleBecause}` });
}

/**
 * fsync on a directory is what makes a newly created file survive power loss:
 * the file's own contents can be synced while its directory entry is not.
 * Windows refuses to open a directory as a file descriptor at all, so this is
 * best-effort by necessity — on that platform the guarantee is weaker and there
 * is nothing this code can do about it.
 */
function fsyncDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // EISDIR / EPERM on Windows, EACCES on some mounts. Not fatal.
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// TELLING A DAMAGED STORE FROM AN EMPTY ONE, BEFORE SQLITE GETS A VOTE.
//
// This runs on the FILES, not on a connection, and it runs BEFORE anything is
// opened — because the damage this exists to catch is damage that SQLite does not
// consider damage. A 0-byte file IS a valid empty SQLite database as far as the
// library is concerned: open it, create tables, no error, no warning. Verified
// independently. That is the whole defect.
//
// WHAT IS CHECKED, AND WHY EACH ONE:
//
//   * file existence, of the .db AND of its -wal / -shm siblings. Absence of the
//     .db is only a first run if NOTHING else is there. A surviving -wal with a
//     deleted .db is a half-destroyed store whose most recent commits are in the
//     file that DID survive — reading that as "never settled anything" is the
//     double-settle path. The reverse (a .db with the -wal deleted) silently
//     rewinds to the last checkpoint; where that is destructive the .db is left
//     header-only or empty, which the size and schema checks below catch.
//   * SIZE ZERO. The headline case, and the cheapest possible test. No SQLite
//     call can distinguish it from a store that has simply never been written,
//     because to SQLite it is not distinguishable.
//   * THE 16-BYTE HEADER MAGIC, "SQLite format 3\0". Decides "this is not a
//     database at all" from the file itself rather than from an exception, so the
//     operator gets a sentence instead of an errcode — and so we never hand a
//     file of unknown provenance to the SQL parser to find out what it is.
//   * THE HEADER'S OWN PAGE COUNT vs the file size. Bytes 16..17 are the page
//     size, 28..31 the database size in pages, and 24..27 / 92..95 are the change
//     counter and version-valid-for that say whether that page count is
//     trustworthy. When it is, and the file is SHORTER than the pages it claims,
//     the file was truncated mid-write. Under WAL the .db may legitimately be
//     STALE (newer pages live in the -wal), which makes the file LARGER or equal,
//     never smaller — so the shortfall direction is the only one tested and the
//     check cannot fire on a healthy WAL store.
//
// WHAT IS DELIBERATELY *NOT* CHECKED HERE: page-level corruption. That needs
// SQLite, and it is done immediately after opening with PRAGMA quick_check —
// before a single line of DDL runs, which is the ordering the previous code got
// wrong. quick_check is the structural pass (page linkage, cell integrity,
// row-count agreement) and it is what catches a corrupt or truncated image;
// PRAGMA integrity_check is then run as well, because it ADDS the index
// cross-check, and the dedup rules that refuse a double settle ARE partial
// indexes. A store whose indexes disagree with its tables is a store whose
// frontier constraints may not fire. The store is small enough (one row per
// settlement, skip and checkpoint) that paying for both is measured in
// milliseconds.
// ---------------------------------------------------------------------------

/** "SQLite format 3\0" — the first 16 bytes of every SQLite database file. */
const SQLITE_MAGIC = Buffer.from([
  0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00,
]);

const HOW_TO_RECOVER =
  "This is NOT treated as an empty store, and the schema is NOT re-created over it: an empty store " +
  "refuses nothing, so a keeper that starts from one believes it has never settled and will offer " +
  "every already-settled window again. Recover by RESTORING THE VOLUME from backup, or by pointing " +
  "NUVEM_KEEPER_STATE_DIR at a fresh, EMPTY directory and letting the chain-based adoption path " +
  "rebuild the history (`keeper recover` shows what the chain says was settled). Do not delete or " +
  "truncate the file to make this message go away.";

const sizeOrNull = (path: string): number | null => {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
};

/** Reads the first `length` bytes without slurping a file of unknown size. */
function readHead(path: string, length: number): Buffer | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, read);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Decides ABSENT / HEALTHY / DAMAGED from the bytes on disk alone.
 *
 * "HEALTHY" here means only "structurally plausible enough to open". The
 * authority on a healthy store is quick_check + integrity_check + the schema
 * inventory, all of which run after this and before any write.
 */
export function probeStoreFile(dbPath: string): StoreProbe {
  const sizeBytes = sizeOrNull(dbPath);
  const walBytes = sizeOrNull(`${dbPath}-wal`);
  const shmBytes = sizeOrNull(`${dbPath}-shm`);
  const probe = (condition: StoreCondition, detail: string | null): StoreProbe => ({
    condition,
    detail,
    sizeBytes,
    walBytes,
    shmBytes,
  });

  if (sizeBytes === null) {
    if (walBytes !== null || shmBytes !== null) {
      const survivors = [
        ...(walBytes !== null ? [`${dbPath}-wal (${walBytes} bytes)`] : []),
        ...(shmBytes !== null ? [`${dbPath}-shm (${shmBytes} bytes)`] : []),
      ].join(" and ");
      return probe(
        "DAMAGED",
        `The database file ${dbPath} is GONE but ${survivors} survives. A write-ahead log without its ` +
          "database is not a first run: the most recent commits this keeper made are in the file that was " +
          "left behind, and the settlements they record cannot be read from it alone. " +
          HOW_TO_RECOVER,
      );
    }
    return probe("ABSENT", null);
  }

  if (sizeBytes === 0) {
    return probe(
      "DAMAGED",
      `The database file ${dbPath} exists but is ZERO BYTES. SQLite accepts a zero-byte file as a valid ` +
        "EMPTY database, so this would otherwise present as a pristine first run — a disk full during a " +
        "write, a truncating restore, a volume mounted before the file materialised and a bad backup all " +
        "produce exactly this. " +
        HOW_TO_RECOVER,
    );
  }

  // THE OTHER HALF OF THE WAL CASE. A -shm is a pure shared-memory index and holds
  // NO durable data; a -wal holds committed transactions that are not yet in the
  // .db. SQLite creates both together and, on the last connection closing,
  // checkpoints, unlinks the -wal and then unlinks the -shm. So a -shm with no -wal
  // means one of two things: someone removed the write-ahead log by hand — in which
  // case the .db has silently rewound to its last checkpoint and reads as less
  // history than this keeper committed — or a crash landed in the two-syscall gap
  // between those unlinks. The first is a settled window becoming settleable again;
  // the second is benign and has a one-line escape, named in the message. Refusing
  // is the fail-closed direction and the cheap-to-resolve one.
  if (walBytes === null && shmBytes !== null) {
    return probe(
      "DAMAGED",
      `The database ${dbPath} is present but its write-ahead log ${dbPath}-wal is GONE while ` +
        `${dbPath}-shm (${shmBytes} bytes) remains. A -wal holds committed transactions the .db does not ` +
        "yet contain, so removing it silently rewinds this store to its last checkpoint — and a settlement " +
        "that rewinds out of the store is a settlement this keeper will offer to make again. " +
        "If, and only if, you are certain no -wal was deleted and this is the two-unlink gap of a clean " +
        `shutdown, the -shm holds no data and may be removed: delete ${dbPath}-shm and start again. ` +
        "Otherwise: " +
        HOW_TO_RECOVER,
    );
  }

  const head = readHead(dbPath, 100);
  if (head === null) {
    return probe(
      "DAMAGED",
      `The database file ${dbPath} exists (${sizeBytes} bytes) but its header could not be read. ` +
        HOW_TO_RECOVER,
    );
  }
  if (head.length < 16 || !head.subarray(0, 16).equals(SQLITE_MAGIC)) {
    return probe(
      "DAMAGED",
      `The file ${dbPath} exists (${sizeBytes} bytes) but is NOT A DATABASE: its first 16 bytes are ` +
        `not the SQLite header magic ("SQLite format 3"). ` +
        HOW_TO_RECOVER,
    );
  }

  // The header's own page accounting. Only trustworthy when the change counter
  // (24..27) equals version-valid-for (92..95); otherwise a legacy writer touched
  // the file and the page count is stale, and we say nothing rather than guess.
  if (head.length >= 96) {
    const rawPageSize = head.readUInt16BE(16);
    const pageSize = rawPageSize === 1 ? 65536 : rawPageSize;
    const pageCount = head.readUInt32BE(28);
    const changeCounter = head.readUInt32BE(24);
    const validFor = head.readUInt32BE(92);
    if (changeCounter === validFor && pageCount > 0 && pageSize >= 512) {
      const claimed = pageCount * pageSize;
      if (claimed > sizeBytes) {
        return probe(
          "DAMAGED",
          `The database file ${dbPath} is TRUNCATED: its header claims ${pageCount} pages of ${pageSize} ` +
            `bytes (${claimed} bytes) but the file is only ${sizeBytes} bytes. It was cut mid-file — a ` +
            "write that ran out of disk, or a partial copy. " +
            HOW_TO_RECOVER,
        );
      }
    }
  }

  return probe("HEALTHY", null);
}

/**
 * 0600 on the store and BOTH its siblings.
 *
 * The database file is the operator's realized-profit history and the file the
 * dedup depends on; instance.json, the snapshot and keeper.lock are all 0600 and
 * this was 0644 (observed -rw-r--r-- on the volume) because SQLITE CREATES THE
 * FILE ITSELF, honouring the process umask, and so does it for -wal and -shm.
 *
 * IT NEVER THROWS. On Windows the mode is largely advisory (chmod moves only the
 * read-only bit and stat reports 0666 regardless), and on some container storage
 * drivers chmod is refused outright. Failing startup over a permission bit on the
 * one file an incident needs readable would be trading a real capability for a
 * cosmetic one, so a failure DEGRADES AND WARNS.
 */
function hardenMode(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    chmodSync(path, 0o600);
    return null;
  } catch (error) {
    return `could not set mode 0600 on ${path}: ${(error as Error).message}`;
  }
}

// ---------------------------------------------------------------------------
// The schema
//
// Everything below is verified to execute and to enforce what it claims. Read the
// index and trigger block as the safety argument: the application code that calls
// it is a convenience, and if it is wrong the database still refuses.
// ---------------------------------------------------------------------------
const LIVE = "status IN ('INTENT','CONFIRMED')";
// The COVERAGE set: live settlements that make a claim on the L2 frontier chain.
// UNRESOLVED (the L2 window is unknown) and COVERED (it lies wholly below the
// frontier already) are deliberately outside it.
const COVERING = `${LIVE} AND l2_precision NOT IN ('UNRESOLVED','COVERED')`;

const DDL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version     INTEGER PRIMARY KEY,
  applied_at  TEXT NOT NULL,
  description TEXT NOT NULL
) STRICT;

-- The identity pin. CHECK (id = 1) makes two identities in one file structurally
-- impossible. Addresses are stored LOWERCASE: mixed-case EIP-55 against
-- lowercase is a classic silent miss in a TEXT equality join, and a missed join
-- here is a missed dedup.
CREATE TABLE IF NOT EXISTS instance (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  chain_id      INTEGER NOT NULL CHECK (chain_id > 0),
  factory       TEXT NOT NULL,
  executor      TEXT NOT NULL,
  vault         TEXT NOT NULL,
  account       TEXT NOT NULL UNIQUE CHECK (account GLOB '0x[0-9a-f]*' AND length(account) = 42),
  ledger_schema TEXT NOT NULL,
  engine_schema TEXT NOT NULL,
  created_at    TEXT NOT NULL
) STRICT;

-- The append-only record stream. It is what \`keeper journal\` prints, what
-- failureHistory counts reverts from, and what carries the per-row integrity
-- digest that detects an out-of-band edit.
CREATE TABLE IF NOT EXISTS record (
  seq         INTEGER PRIMARY KEY CHECK (seq >= 0),
  ts          TEXT NOT NULL,
  type        TEXT NOT NULL,
  prev_digest TEXT NOT NULL,
  digest      TEXT NOT NULL,
  body        TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS record_by_type ON record(type);
CREATE TRIGGER IF NOT EXISTS record_no_update BEFORE UPDATE ON record
  BEGIN SELECT RAISE(ABORT, 'records are immutable'); END;
CREATE TRIGGER IF NOT EXISTS record_no_delete BEFORE DELETE ON record
  BEGIN SELECT RAISE(ABORT, 'records are never deleted'); END;

-- THE TABLE THAT DOES THE WORK.
--
-- One table, not two. The obvious split — attempts here, settlements there —
-- puts the dedup constraints on the settled side only, so an INTENT could be
-- FORMED for a window that is already covered and would only blow up at
-- confirmation time, after the money moved. Here every constraint fires at
-- INSERT ... 'INTENT', which is BEFORE the broadcast: the database refuses to
-- let the keeper form the intention to double-settle.
--
-- Status rather than deletion, because FAILED and ABANDONED rows must persist for
-- audit while RELEASING the frontier so a retry is possible. The partial indexes
-- below are what make that work.
CREATE TABLE IF NOT EXISTS settlement (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  record_seq          INTEGER NOT NULL UNIQUE REFERENCES record(seq),
  resolved_record_seq INTEGER REFERENCES record(seq),
  account             TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('INTENT','CONFIRMED','FAILED','ABANDONED')),
  origin              TEXT NOT NULL CHECK (origin IN ('KEEPER','ADOPTED')),

  -- ---- THE DEDUP KEY. Epoch-independent, content-independent. ----
  start_block_l2      INTEGER NOT NULL CHECK (start_block_l2 >= 0),
  end_block_l2        INTEGER NOT NULL,
  prev_end_block_l2   INTEGER,
  l2_precision        TEXT NOT NULL CHECK (l2_precision IN ('EXACT','L1_CLAMP','COVERED','UNRESOLVED')),

  -- ---- Recorded, never keyed. binding_epoch is audit data and nothing else. ----
  binding_epoch       INTEGER NOT NULL CHECK (binding_epoch >= 0),
  settlement_nonce    INTEGER NOT NULL CHECK (settlement_nonce >= 0),
  start_block_l1      INTEGER NOT NULL CHECK (start_block_l1 >= 0),
  end_block_l1        INTEGER NOT NULL,
  session_id          TEXT NOT NULL,
  ledger_root         TEXT NOT NULL,

  -- ---- uint256 as decimal TEXT: an int64 column cannot hold these. ----
  contribution_wei    TEXT NOT NULL
    CHECK (contribution_wei NOT GLOB '*[^0-9]*' AND length(contribution_wei) BETWEEN 1 AND 78),
  realized_profit_wei TEXT NOT NULL
    CHECK (realized_profit_wei GLOB '-[0-9]*' OR realized_profit_wei NOT GLOB '*[^0-9]*'),

  raw_tx_hash         TEXT,
  tx_hash             TEXT,
  eoa_nonce           INTEGER,
  deadline            INTEGER,
  created_at          TEXT NOT NULL,
  resolved_at         TEXT,
  resolution_detail   TEXT,

  CHECK (end_block_l2 >= start_block_l2),
  CHECK (end_block_l1 >= start_block_l1),
  -- You may only ever extend the frontier FORWARD. This alone kills the exact
  -- replay, the right-overlap and the interior subset.
  CHECK (prev_end_block_l2 IS NULL OR start_block_l2 > prev_end_block_l2),
  CHECK ((status = 'INTENT') = (resolved_at IS NULL)),
  CHECK (origin <> 'ADOPTED' OR status = 'CONFIRMED'),
  CHECK (l2_precision NOT IN ('UNRESOLVED','COVERED') OR origin = 'ADOPTED'),
  FOREIGN KEY (account) REFERENCES instance(account)
) STRICT;

-- (1) the exact duplicate, epoch-independent
CREATE UNIQUE INDEX IF NOT EXISTS settlement_live_window
  ON settlement(account, start_block_l2, end_block_l2) WHERE ${COVERING};
-- (2) a frontier value exists at most once
CREATE UNIQUE INDEX IF NOT EXISTS settlement_live_end
  ON settlement(account, end_block_l2) WHERE ${COVERING};
-- (3) a frontier is EXTENDED at most once, which forbids forks and overlaps
CREATE UNIQUE INDEX IF NOT EXISTS settlement_live_prev
  ON settlement(account, prev_end_block_l2) WHERE ${COVERING};
-- (4) exactly one origin of the chain. SQLite treats NULLs as distinct in UNIQUE,
--     so without this a second prev=NULL row inserts freely — and every one of
--     them would be an unlinked replay of the beginning of history.
CREATE UNIQUE INDEX IF NOT EXISTS settlement_live_genesis
  ON settlement(account) WHERE ${COVERING} AND prev_end_block_l2 IS NULL;
-- (5) SINGLE FLIGHT, enforced by the database rather than by counting in JS
CREATE UNIQUE INDEX IF NOT EXISTS settlement_open_intent
  ON settlement(account) WHERE status = 'INTENT';
-- (6) the vault consumes settlementNonce strictly in order and never reuses it
CREATE UNIQUE INDEX IF NOT EXISTS settlement_live_nonce
  ON settlement(account, settlement_nonce) WHERE ${LIVE};
-- (7) mirrors usedSessions[keccak(account, epoch, sessionId)]. DELIBERATELY
--     REDUNDANT AND DELIBERATELY WEAKER: its epoch scoping is the very defect
--     being fixed, so it is a second net and must never be the only one.
CREATE UNIQUE INDEX IF NOT EXISTS settlement_live_session
  ON settlement(account, binding_epoch, session_id) WHERE ${LIVE};
-- (8) never sign two different attestations onto one raw transaction hash
CREATE UNIQUE INDEX IF NOT EXISTS settlement_raw_tx
  ON settlement(raw_tx_hash) WHERE raw_tx_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS settlement_by_epoch_l1
  ON settlement(account, binding_epoch, end_block_l1) WHERE status = 'CONFIRMED';

-- SQLite FOREIGN KEYs cannot reference a partial index, so "prev_end must BE the
-- current live frontier" is a trigger. It is strictly stronger than an FK would
-- be: an FK would happily accept a link to a stale interior end. \`IS NOT\` and
-- not \`<>\`, because NULL <> NULL is NULL, which is falsy — \`<>\` would wave the
-- genesis case through. MAX() over zero rows is NULL, and NULL IS NOT NULL is
-- false, so the first insert is accepted and every later unlinked one is not.
CREATE TRIGGER IF NOT EXISTS settlement_frontier_insert BEFORE INSERT ON settlement
WHEN new.status IN ('INTENT','CONFIRMED') AND new.l2_precision NOT IN ('UNRESOLVED','COVERED')
BEGIN
  SELECT RAISE(ABORT, 'frontier violation: prev_end_block_l2 is not the current live frontier')
  WHERE new.prev_end_block_l2 IS NOT (
    SELECT MAX(end_block_l2) FROM settlement
    WHERE account = new.account AND ${COVERING});
END;

CREATE TRIGGER IF NOT EXISTS settlement_immutable BEFORE UPDATE ON settlement
BEGIN
  SELECT RAISE(ABORT, 'settlement rows are immutable except for resolution fields')
  WHERE new.account           IS NOT old.account
     OR new.record_seq        IS NOT old.record_seq
     OR new.start_block_l2    IS NOT old.start_block_l2
     OR new.end_block_l2      IS NOT old.end_block_l2
     OR new.prev_end_block_l2 IS NOT old.prev_end_block_l2
     OR new.l2_precision      IS NOT old.l2_precision
     OR new.binding_epoch     IS NOT old.binding_epoch
     OR new.settlement_nonce  IS NOT old.settlement_nonce
     OR new.session_id        IS NOT old.session_id
     OR new.ledger_root       IS NOT old.ledger_root
     OR new.contribution_wei  IS NOT old.contribution_wei
     OR new.origin            IS NOT old.origin;
  SELECT RAISE(ABORT, 'only an INTENT may change status')
  WHERE old.status <> 'INTENT' AND new.status IS NOT old.status;
END;

-- What makes requirement 3 hold against an operator with sqlite3 and a bad
-- afternoon. With settlement_immutable, the only legal mutation in the whole
-- schema is INTENT -> {CONFIRMED, FAILED, ABANDONED}, exactly once.
CREATE TRIGGER IF NOT EXISTS settlement_no_delete BEFORE DELETE ON settlement
  BEGIN SELECT RAISE(ABORT, 'settlement rows are never deleted'); END;

-- Refused and skipped windows. Keyed on the same epoch-independent L2 window, so
-- a REFUSED verdict survives a rebind. SEPARATE FROM settlement ON PURPOSE: a
-- refusal moved no money, so it makes NO coverage claim and must not enter the
-- frontier chain.
CREATE TABLE IF NOT EXISTS terminal_window (
  account        TEXT NOT NULL,
  start_block_l2 INTEGER NOT NULL,
  end_block_l2   INTEGER NOT NULL,
  reason         TEXT NOT NULL,
  detail         TEXT NOT NULL,
  engine_reasons TEXT,
  binding_epoch  INTEGER,
  end_block_l1   INTEGER,
  record_seq     INTEGER NOT NULL REFERENCES record(seq),
  recorded_at    TEXT NOT NULL,
  PRIMARY KEY (account, start_block_l2, end_block_l2)
) STRICT;

-- The DEGRADED latch. An open halt is a hard precondition on every settle path,
-- and clearing one raises the acknowledged floor to unaccounted_below ONLY, so an
-- acknowledgement can never extend forward over settlements that have not
-- happened yet.
CREATE TABLE IF NOT EXISTS halt (
  record_seq           INTEGER PRIMARY KEY REFERENCES record(seq),
  reason               TEXT NOT NULL,
  detail               TEXT NOT NULL,
  unaccounted_below    INTEGER,
  raised_at            TEXT NOT NULL,
  cleared_at           TEXT,
  cleared_by_record_seq INTEGER REFERENCES record(seq),
  cleared_note         TEXT,
  CHECK ((cleared_at IS NULL) = (cleared_by_record_seq IS NULL))
) STRICT;
CREATE INDEX IF NOT EXISTS halt_open ON halt(record_seq) WHERE cleared_at IS NULL;

CREATE TABLE IF NOT EXISTS chain_checkpoint (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  anchor_block_l2   INTEGER NOT NULL,
  anchor_block_hash TEXT NOT NULL,
  head_block_l2     INTEGER NOT NULL,
  record_seq        INTEGER NOT NULL,
  updated_at        TEXT NOT NULL
) STRICT;
`;

// SQLite result codes. `node:sqlite`'s `constants` export carries only
// SQLITE_CHANGESET_* (verified: 8 keys), so these are hardcoded — which is fine,
// because they are part of SQLite's stable public ABI and far less likely to move
// than the JS wrapper around them. Never classify by parsing err.message: SQLite
// names the COLUMNS of the violated index, not the index, so a primary-key
// violation and a partial-index violation both read "UNIQUE constraint failed:
// settlement.account".
const SQLITE_BUSY = 5;
const SQLITE_BUSY_SNAPSHOT = 517;
const SQLITE_CONSTRAINT_CHECK = 275;
const SQLITE_CONSTRAINT_FOREIGNKEY = 787;
const SQLITE_CONSTRAINT_PRIMARYKEY = 1555;
const SQLITE_CONSTRAINT_TRIGGER = 1811;
const SQLITE_CONSTRAINT_UNIQUE = 2067;

interface SqliteError extends Error {
  code?: string;
  errcode?: number;
  errstr?: string;
}

const errcodeOf = (error: unknown): number | null => {
  const e = error as SqliteError;
  return e && typeof e.errcode === "number" ? e.errcode : null;
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------
export interface OpenLedgerOptions {
  readonly dir: string;
  readonly instance: LedgerInstance;
  /** Skips the pidfile interlock. Only for tests and read-only commands. */
  readonly noLock?: boolean;
  readonly forceUnlock?: boolean;
  readonly now?: () => Date;
}

interface RecordRow {
  seq: bigint;
  ts: string;
  type: string;
  prev_digest: string;
  digest: string;
  body: string;
}

const num = (value: unknown): number => (typeof value === "bigint" ? Number(value) : (value as number));
const big = (value: unknown): bigint | null =>
  value === null || value === undefined ? null : typeof value === "bigint" ? value : BigInt(value as number);

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------
export class Ledger {
  #db: DatabaseSyncType | null = null;
  #state: LedgerState | null = null;
  #damaged: string | null = null;
  readonly #now: () => Date;
  readonly #account: string;
  readonly #modeWarnings = new Set<string>();

  /**
   * Non-fatal complaints from tightening the store's file mode to 0600. Published
   * on `keeper status` and logged at startup, so a platform that will not honour
   * chmod is acknowledged rather than silently tolerated.
   */
  get permissionWarnings(): readonly string[] {
    return [...this.#modeWarnings];
  }

  /**
   * Set when this process took over a lock its recorded holder could not still be
   * holding. Callers MUST log it loudly: it means the previous keeper died
   * without releasing, which is also the case in which its last write may have
   * been rolled back mid-transaction. bin/keeper.mts logs it on startup.
   */
  lockReclaimed: LockReclaim | null = null;

  private constructor(
    readonly dir: string,
    /**
     * The database file. Named `journalPath` because it is the same
     * operator-facing concept the JSONL store had — "where the record stream
     * lives" — and `keeper journal`, `keeper status` and failureHistory all name
     * it. It is no longer a text file; `keeper journal` is how it is read by eye.
     */
    readonly journalPath: string,
    readonly snapshotPath: string,
    readonly lockPath: string | null,
    readonly instance: LedgerInstance,
    db: DatabaseSyncType | null,
    damaged: string | null,
    now: () => Date,
  ) {
    this.#db = db;
    this.#damaged = damaged;
    this.#now = now;
    this.#account = instance.account.toLowerCase();
  }

  static open(options: OpenLedgerOptions): Ledger {
    const { dir, instance } = options;
    const now = options.now ?? (() => new Date());
    mkdirSync(dir, { recursive: true, mode: 0o700 });

    // chainId + vault + account go in the FILENAME as well as instance.json. A
    // volume that once held testnet state, reused against mainnet, is the
    // cheapest possible route to a wrong settlement; this makes the mistake
    // visible in `ls` before it is visible in a transaction.
    const slug = `${instance.chainId}-${instance.vault.toLowerCase().slice(0, 10)}-${instance.account
      .toLowerCase()
      .slice(0, 10)}`;
    const dbPath = join(dir, `keeper-${slug}.db`);
    const snapshotPath = join(dir, `snapshot-${slug}.json`);
    const instancePath = join(dir, "instance.json");
    const lockPath = options.noLock === true ? null : join(dir, "keeper.lock");

    // ---- the identity pin, in a plain file so it is readable without sqlite ----
    if (existsSync(instancePath)) {
      const stored = JSON.parse(readFileSync(instancePath, "utf8")) as Record<string, unknown>;
      const mismatches = (Object.keys(instance) as (keyof LedgerInstance)[]).filter((key) => {
        const a = instance[key];
        const b = stored[key];
        return typeof a === "string" && typeof b === "string" ? a.toLowerCase() !== b.toLowerCase() : a !== b;
      });
      if (mismatches.length > 0) {
        throw new LedgerIdentityError(
          `State directory ${dir} was created for a different deployment ` +
            `(${mismatches.map((k) => `${k}: ${String(stored[k])} != ${String(instance[k])}`).join("; ")}). ` +
            "Refusing to start. Point NUVEM_KEEPER_STATE_DIR at a fresh directory rather than migrating this one.",
        );
      }
    } else {
      writeFileSync(instancePath, `${JSON.stringify(instance, null, 2)}\n`, { mode: 0o600 });
      fsyncDir(dir);
    }

    const reclaimed = lockPath ? acquireLock(lockPath, options.forceUnlock === true, now().toISOString()) : null;

    // ---- the database ------------------------------------------------------
    //
    // A corrupt or unreadable store must NEVER throw here: an inspection command
    // has to be able to open a damaged store and describe it. So a failure to
    // open, or to apply the schema, produces a DAMAGED ledger — one whose state
    // reports integrityOk false and condition DAMAGED, whose localEligibility
    // refuses everything, and whose append() throws rather than pretending to work.
    //
    // THE ORDER BELOW IS THE FIX FOR DEFECT 1. The probe runs FIRST, on the bytes,
    // and the schema is applied ONLY down the ABSENT branch. Nothing ever writes
    // DDL over a file that already exists, so a 0-byte / truncated / foreign file
    // can no longer be turned into a pristine empty store.
    let db: DatabaseSyncType | null = null;
    let damaged: string | null = null;
    let identityError: LedgerIdentityError | null = null;
    const modeWarnings: string[] = [];
    const probe = probeStoreFile(dbPath);

    if (probe.condition === "DAMAGED") {
      // Not opened. Not created. Not repaired. Named, and refused.
      damaged = probe.detail;
    } else {
      try {
        if (probe.condition === "ABSENT") {
          // A GENUINE FIRST RUN, and the schema is built somewhere else and moved
          // into place. Creating in place leaves a window — between
          // `new DatabaseSync()`, which materialises a zero-byte file
          // immediately, and the DDL's COMMIT — in which a crash produces exactly
          // the empty-looking file this whole probe exists to refuse, and the
          // next start would then be permanently wedged on its own debris.
          // Building at a temp path and renaming makes "the file exists" mean
          // "its schema was committed", which is what lets the probe be strict.
          Ledger.#createFresh(dbPath, dir, instance, now().toISOString(), modeWarnings);
        }
        db = new DatabaseSync(dbPath);
        Ledger.#configure(db);
        // quick_check BEFORE anything else touches the file: it is the structural
        // pass (page linkage, cell integrity, row counts) and it is what sees a
        // corrupt or truncated image. It runs ahead of every schema query so a
        // damaged file is never interrogated, let alone written to.
        const quick = db.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
        if (quick?.quick_check !== "ok") {
          damaged =
            `PRAGMA quick_check on ${dbPath} reported ${JSON.stringify(quick?.quick_check ?? "nothing")}. ` +
            HOW_TO_RECOVER;
        }
        if (damaged === null) {
          // The tables the decisions are made from must all be present. A store
          // missing one is structurally damaged, NOT a store to re-create the
          // schema over: `DROP TABLE settlement` would otherwise read as an empty
          // frontier and re-arm every settled window.
          const missing = Ledger.#missingTables(db);
          if (missing.length > 0) {
            damaged =
              `The store at ${dbPath} is a SQLite database but is missing the table(s) ` +
              `${missing.join(", ")}, so the rules that refuse a double settlement cannot be evaluated. ` +
              HOW_TO_RECOVER;
          }
        }
        if (damaged === null) {
          Ledger.#verifySchema(db, instance, now().toISOString());
          // integrity_check as well as quick_check, because it ADDS the index
          // cross-check — and the dedup rules that refuse a replay are partial
          // indexes, so an index that disagrees with its table is a frontier
          // constraint that may not fire.
          const check = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
          if (check?.integrity_check !== "ok") {
            damaged = `PRAGMA integrity_check reported ${JSON.stringify(check?.integrity_check ?? "nothing")}`;
          }
        }
      } catch (error) {
        if (error instanceof LedgerIdentityError) {
          identityError = error;
        } else {
          damaged =
            `the store at ${dbPath} could not be opened or its schema could not be applied ` +
            `(${(error as Error).message}). It is being reported, not repaired: nothing will be settled ` +
            "from a store whose integrity cannot be established.";
        }
        try {
          db?.close();
        } catch {
          /* ignore */
        }
        if (identityError === null) db = null;
      }
    }
    if (identityError !== null) {
      // Identity is not damage. It is a refusal, and it must reach exit code 3.
      if (lockPath !== null) {
        try {
          unlinkSync(lockPath);
        } catch {
          /* already gone */
        }
      }
      throw identityError;
    }

    const ledger = new Ledger(dir, dbPath, snapshotPath, lockPath, instance, db, damaged, now);
    ledger.lockReclaimed = reclaimed;
    for (const warning of modeWarnings) ledger.#modeWarnings.add(warning);
    ledger.#hardenFiles();
    return ledger;
  }

  /**
   * Builds a brand-new store at a temp path and RENAMES it into place.
   *
   * close() checkpoints the WAL back into the main file and removes -wal / -shm
   * (verified), so one rename moves the whole store. The point is the invariant it
   * buys: at `dbPath`, EXISTENCE IMPLIES A COMMITTED SCHEMA. That is what makes
   * `probeStoreFile` allowed to be strict about a file that exists but holds
   * nothing — without it, a crash during the first start would be indistinguishable
   * from the corruption this refuses, and would wedge the keeper on its own debris.
   */
  static #createFresh(
    dbPath: string,
    dir: string,
    instance: LedgerInstance,
    nowIso: string,
    modeWarnings: string[],
  ): void {
    // PER-PROCESS, not shared. The write path holds the lock before it gets here,
    // so two writers cannot meet — but a read-only open (`keeper status`,
    // `journal`, `recover`) passes noLock and would still land in this branch on
    // an absent store. Two of those racing on one shared `${dbPath}.new` would
    // have each unlinked the other's half-built database and then raced to rename
    // it into place. The pid makes the scratch file private, so the only thing
    // ever removed below is this process's own leftover from an earlier crash.
    const tmp = `${dbPath}.new.${process.pid}`;
    for (const stale of [tmp, `${tmp}-wal`, `${tmp}-shm`]) {
      try {
        if (existsSync(stale)) unlinkSync(stale);
      } catch {
        /* a leftover we cannot remove will surface as an open failure below */
      }
    }
    let db: DatabaseSyncType | null = null;
    try {
      db = new DatabaseSync(tmp);
      // Before a byte of schema: the store is 0600 from the moment it exists.
      for (const path of [tmp, `${tmp}-wal`, `${tmp}-shm`]) {
        const warning = hardenMode(path);
        if (warning !== null) modeWarnings.push(warning);
      }
      Ledger.#configure(db);
      Ledger.#createSchema(db, instance, nowIso);
      db.close();
      db = null;
    } catch (error) {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
      for (const stale of [tmp, `${tmp}-wal`, `${tmp}-shm`]) {
        try {
          if (existsSync(stale)) unlinkSync(stale);
        } catch {
          /* ignore */
        }
      }
      throw error;
    }
    // NEVER rename OVER an existing store. The single-writer lock excludes a
    // racing writer, but the read-only commands open with noLock, so two of them
    // can both probe ABSENT. Both would be building an empty schema and clobbering
    // one with the other is harmless today — but "rename over the money-critical
    // file" is not a line to leave lying around for a future caller to reach with
    // a populated store. The loser drops its own work instead.
    if (existsSync(dbPath)) {
      for (const stale of [tmp, `${tmp}-wal`, `${tmp}-shm`]) {
        try {
          if (existsSync(stale)) unlinkSync(stale);
        } catch {
          /* ignore */
        }
      }
      return;
    }
    renameSync(tmp, dbPath);
    // The directory entry, not just the file contents: that is what makes a newly
    // created store survive power loss. Best-effort on Windows, which cannot open
    // a directory as a file descriptor.
    fsyncDir(dir);
  }

  /** The tables every decision is made from. Missing one is damage, never a fresh start. */
  static #missingTables(db: DatabaseSyncType): string[] {
    const required = [
      "schema_version",
      "instance",
      "record",
      "settlement",
      "terminal_window",
      "halt",
      "chain_checkpoint",
    ];
    const present = new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as unknown as { name: string }[]
      ).map((row) => row.name),
    );
    return required.filter((name) => !present.has(name));
  }

  /**
   * 0600 on the database and on any journal beside it. Degrades and warns; never throws.
   *
   * `-journal` is the sibling journal_mode=DELETE actually produces: it is unlinked
   * at commit, so it is only on disk here when a crash left a hot one, and a hot
   * journal holds the same pages the database does. The WAL pair stays in the list
   * because hardenMode is a no-op on a file that is not there, and a store carrying
   * one is refused a few lines later — 0600 first, refuse second, is the safer order.
   */
  #hardenFiles(): void {
    for (const path of [
      this.journalPath,
      `${this.journalPath}-journal`,
      `${this.journalPath}-wal`,
      `${this.journalPath}-shm`,
    ]) {
      const warning = hardenMode(path);
      if (warning !== null) this.#modeWarnings.add(warning);
    }
  }

  /**
   * Connection preamble. ASSERT, never assume.
   *
   * THE STORE IS DELIBERATELY ONE FILE. This was WAL, and WAL is where the last
   * blocking defect lived:
   *
   *   A -wal captured while a connection was open, restored beside the same .db
   *   after it had advanced and checkpointed, REWINDS the store to the earlier
   *   image — and PRAGMA quick_check reports "ok". Reproduced directly: a store
   *   holding two settlements read back as holding one, healthy. That is a store
   *   claiming LESS was settled than really was, which is the double-settle path
   *   this whole component exists to close.
   *
   *   It is not exotic. "Restore the volume from two backup snapshots" produces
   *   exactly that pair of files, and so does any copy that catches the .db and
   *   the -wal at different instants — `docker cp` on a running container, an
   *   rsync without --delete, a volume snapshot taken mid-write.
   *
   * No amount of validation fixes it, because SQLite is behaving correctly: it is
   * replaying a self-consistent write-ahead log. The defect is having a second
   * file that can be paired with the wrong first one. journal_mode=DELETE removes
   * it: no -wal, no -shm, one file that is either right or visibly broken. The
   * hand-rolled journal this replaced failed for the same structural reason —
   * multiple files that had to agree.
   *
   * The cost is real and affordable: DELETE mode serialises readers against a
   * writer instead of letting them run concurrently. This keeper is a single
   * writer that commits a handful of small rows per tick, `busy_timeout` below
   * gives a reader 15 seconds to get its turn, and the read-only commands
   * (`status`, `journal`, `recover`) are interactive rather than hot-path. Losing
   * concurrency here buys back a whole class of silent wrongness.
   *
   * journal_mode is the only pragma that can silently fail (a read-only
   * directory, an exotic mount), so the mode actually in effect is read back and
   * anything else refuses. Setting it on a store an older build created in WAL
   * mode checkpoints and removes the -wal as part of the switch, so existing
   * stores migrate on first open.
   *
   * synchronous=FULL because NORMAL can lose the last commits on host power loss.
   * Acceptable for a cache. Not acceptable for the record that says "I already
   * paid this window".
   */
  static #configure(db: DatabaseSyncType): void {
    const mode = db.prepare("PRAGMA journal_mode = DELETE").get() as { journal_mode?: string } | undefined;
    if (mode?.journal_mode !== "delete") {
      throw new Error(
        `PRAGMA journal_mode = DELETE returned ${JSON.stringify(mode?.journal_mode ?? null)}. ` +
          "The store must be a single file: a separate write-ahead log can be paired with the wrong " +
          "database image by an ordinary backup restore, which silently rewinds the settled history and " +
          "still passes every integrity check. Refusing rather than running on a two-file store.",
      );
    }
    db.exec("PRAGMA synchronous = FULL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 15000");
    db.exec("PRAGMA trusted_schema = OFF");
  }

  /**
   * Applies the DDL. FRESH STORES ONLY, and only down the ABSENT branch of the
   * probe, at a temp path that has not yet been renamed into place.
   *
   * IT USED TO BE `#ensureSchema` AND IT USED TO RUN ON EVERY OPEN. That is
   * exactly how a 0-byte file became a pristine empty store: `schema_version` was
   * absent, so the else-branch fired and built a whole new schema on top of the
   * damage. There is no longer a code path that writes DDL to a file that already
   * exists.
   */
  static #createSchema(db: DatabaseSyncType, instance: LedgerInstance, nowIso: string): void {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(DDL);
      db.prepare("INSERT INTO schema_version (version, applied_at, description) VALUES (?,?,?)").run(
        BigInt(STORE_SCHEMA_VERSION),
        nowIso,
        "initial node:sqlite store; L2-frontier dedup, epoch-independent",
      );
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw error;
    }
    Ledger.#verifySchema(db, instance, nowIso);
  }

  /** Version pin plus identity pin, on a store that already exists. Writes no DDL, ever. */
  static #verifySchema(db: DatabaseSyncType, instance: LedgerInstance, nowIso: string): void {
    const row = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v?: unknown };
    const version = row?.v === null || row?.v === undefined ? 0 : num(row.v);
    if (version !== STORE_SCHEMA_VERSION) {
      // NEVER migrate. A read-only command must not rewrite the money-critical
      // store, and a write command must not guess what an unknown version meant.
      throw new LedgerIdentityError(
        `The store at this state directory was written with schema version ${version}, this build ` +
          `speaks ${STORE_SCHEMA_VERSION}. Refusing to start, and refusing to migrate in place. ` +
          "Point NUVEM_KEEPER_STATE_DIR at a fresh directory and let recovery rebuild from the chain.",
      );
    }

    // The in-database identity row. instance.json is the operator-readable half;
    // this is the half the FOREIGN KEY on settlement.account hangs off, so a row
    // can never be written for an account this store was not created for.
    const stored = db.prepare("SELECT * FROM instance WHERE id = 1").get() as Record<string, unknown> | undefined;
    const wanted = {
      chain_id: instance.chainId,
      factory: instance.factory.toLowerCase(),
      executor: instance.executor.toLowerCase(),
      vault: instance.vault.toLowerCase(),
      account: instance.account.toLowerCase(),
      ledger_schema: instance.ledgerSchema,
      engine_schema: instance.engineSchema,
    };
    if (stored === undefined) {
      db.prepare(
        `INSERT INTO instance (id, chain_id, factory, executor, vault, account, ledger_schema, engine_schema, created_at)
         VALUES (1,?,?,?,?,?,?,?,?)`,
      ).run(
        BigInt(wanted.chain_id),
        wanted.factory,
        wanted.executor,
        wanted.vault,
        wanted.account,
        wanted.ledger_schema,
        wanted.engine_schema,
        nowIso,
      );
    } else {
      const mismatches = Object.entries(wanted).filter(([key, value]) => {
        const held = stored[key];
        return typeof value === "string" && typeof held === "string"
          ? value.toLowerCase() !== held.toLowerCase()
          : num(held) !== value;
      });
      if (mismatches.length > 0) {
        throw new LedgerIdentityError(
          `The store in this state directory was created for a different deployment ` +
            `(${mismatches.map(([k, v]) => `${k}: ${String(stored[k])} != ${String(v)}`).join("; ")}). ` +
            "Refusing to start. It is never migrated and instance.json is never rewritten to make this " +
            "message go away.",
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Transactions
  //
  // node:sqlite has no db.transaction() helper (verified: undefined), so every
  // write goes through this. BEGIN IMMEDIATE and never plain BEGIN: a deferred
  // transaction that reads and then tries to write fails with
  // SQLITE_BUSY_SNAPSHOT (517) that busy_timeout CANNOT cure, because its read
  // snapshot is already stale and waiting would not help.
  //
  // And this is where the concurrency argument lands: the frontier trigger's
  // SELECT MAX(end_block_l2) runs inside the writer's exclusive lock, so two
  // processes cannot both observe the same frontier and both link to it.
  // Whichever commits second sees the first's row and is refused.
  // -------------------------------------------------------------------------
  #tx<T>(fn: (db: DatabaseSyncType) => T): T {
    const db = this.#assertWritable();
    db.exec("BEGIN IMMEDIATE");
    let result: T;
    try {
      result = fn(db);
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* the transaction is already gone */
      }
      this.#state = null;
      throw this.#classify(error);
    }
    // Invalidated inside the same critical section as the write, so in-memory
    // state and a fresh reload can never disagree: state is a QUERY, never a
    // patch. An incremental update with one missing case is precisely how a
    // service convinces itself a settled window is unsettled.
    this.#state = null;
    // The -wal and -shm are created by SQLITE, on the first write, honouring the
    // process umask — so they cannot be tightened once at open and forgotten.
    this.#hardenFiles();
    return result;
  }

  /**
   * THE WRITE HALF OF THE RULE. Read paths degrade and report; this refuses.
   *
   * A DAMAGED store never accepts a record — not a CHECKPOINT, not a HEADER and
   * above all not an INTENT, which is the record that must exist durably before a
   * settle transaction can be broadcast. Refusing here is therefore refusing the
   * broadcast: submit.ts cannot get past `append INTENT`.
   */
  #assertWritable(): DatabaseSyncType {
    if (this.#db === null || this.#damaged !== null) {
      throw new LedgerWriteError(
        `Refusing to write to the store at ${this.journalPath} (condition ${this.condition}): ` +
          `${this.#damaged ?? "it is not open"}. ` +
          "A store whose integrity cannot be established must not accept a settlement record, because a " +
          "settlement it fails to record is a settlement it will offer to make again.",
      );
    }
    return this.#db;
  }

  /**
   * Turns a SQLite failure into a refusal a human and a caller can both act on.
   *
   * Classified on `errcode`, never on the message text. Where the distinction
   * matters operationally it is followed by an explicit SELECT, so an operator
   * gets "blocked by settlement id=1, L2 [22080592,22080850], epoch 1, tx 0xd342…"
   * rather than "UNIQUE constraint failed: settlement.account".
   */
  #classify(error: unknown): unknown {
    if (error instanceof LedgerConstraintError || error instanceof LedgerWriteError) return error;
    const code = errcodeOf(error);
    if (code === null) return error;
    const message = (error as Error).message ?? "";
    const blocker = this.#describeBlocker();

    switch (code) {
      case SQLITE_CONSTRAINT_TRIGGER:
        if (/frontier violation/.test(message)) {
          return new LedgerConstraintError(
            "REPLAY",
            code,
            `The store REFUSED this settlement: it does not extend the current settled L2 frontier. ` +
              `${blocker} This is the epoch-independent replay guard, and it fires whatever the ` +
              "bindingEpoch or the sessionId says. If the window is genuinely new, its startBlockL2 must " +
              "be strictly above the frontier.",
          );
        }
        return new LedgerConstraintError("IMMUTABLE", code, `The store REFUSED this write: ${message}`);
      case SQLITE_CONSTRAINT_CHECK:
        if (/start_block_l2 > prev_end_block_l2/.test(message)) {
          return new LedgerConstraintError(
            "REPLAY",
            code,
            `The store REFUSED this settlement: its L2 window does not begin strictly after the frontier ` +
              `it claims to extend. ${blocker}`,
          );
        }
        return new LedgerConstraintError(
          "MALFORMED",
          code,
          `The store REFUSED this write because a column constraint failed: ${message}`,
        );
      case SQLITE_CONSTRAINT_UNIQUE:
      case SQLITE_CONSTRAINT_PRIMARYKEY:
        return new LedgerConstraintError(
          "DUPLICATE",
          code,
          `The store REFUSED this write as a duplicate (window, settlementNonce, sessionId, open intent ` +
            `or raw transaction hash). ${blocker}`,
        );
      case SQLITE_CONSTRAINT_FOREIGNKEY:
        return new LedgerConstraintError(
          "IDENTITY",
          code,
          "The store REFUSED this write: it names an account this state directory was not created for.",
        );
      case SQLITE_BUSY:
        return new LedgerWriteError(
          `The store at ${this.journalPath} stayed locked for the whole busy timeout. Another process is ` +
            "holding a write transaction open. Check for a second keeper on this volume.",
        );
      case SQLITE_BUSY_SNAPSHOT:
        return new LedgerWriteError(
          "A deferred transaction tried to upgrade to a write. That is a bug in this file, not a " +
            "condition: every write path must use BEGIN IMMEDIATE.",
        );
      default:
        return error;
    }
  }

  /** Names the live settlement most likely to be the one refusing a write. */
  #describeBlocker(): string {
    try {
      const db = this.#db;
      if (db === null) return "";
      const row = db
        .prepare(
          `SELECT id, start_block_l2, end_block_l2, binding_epoch, settlement_nonce, session_id, status, tx_hash
             FROM settlement WHERE account = ? AND ${COVERING}
            ORDER BY end_block_l2 DESC LIMIT 1`,
        )
        .get(this.#account) as Record<string, unknown> | undefined;
      if (row === undefined) return "There is no live settlement in this store.";
      return (
        `Blocked by settlement id=${num(row.id)}, ${row.status as string} over L2 ` +
        `[${String(row.start_block_l2)},${String(row.end_block_l2)}], bindingEpoch ${String(row.binding_epoch)}, ` +
        `settlementNonce ${String(row.settlement_nonce)}, sessionId ${String(row.session_id)}` +
        `${row.tx_hash ? `, tx ${String(row.tx_hash)}` : ""}.`
      );
    } catch {
      return "";
    }
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  /**
   * The raw record stream, in order, side-effect-free.
   *
   * Callers depend on it for facts derived state deliberately forgets — the
   * per-window revert counter (a FAILED record advances no boundary, so the
   * attempt count cannot come from derived state), the L1_RANGE_COLLAPSED census
   * on /status, and `keeper journal`.
   *
   * A row whose digest does not verify is REPORTED AND NOT ADMITTED, and — unlike
   * the JSONL loader — everything after it is still admitted, because each row
   * chains to its predecessor's STORED digest rather than to a recomputed one.
   * That is blocking defect 2 fixed rather than reproduced.
   */
  /** DAMAGED whenever the store could not be opened or a structural check failed. */
  get condition(): StoreCondition {
    return this.#damaged === null && this.#db !== null ? "HEALTHY" : "DAMAGED";
  }

  /** The operator-facing description of the damage, or `null` on a healthy store. */
  get damage(): string | null {
    return this.#damaged;
  }

  readRecords(): JournalRead {
    if (this.#db === null) {
      return {
        records: [],
        integrityOk: false,
        integrityDetail: this.#damaged ?? "the store is not open",
        rejected: [],
        totalBytes: Ledger.#sizeOf(this.journalPath),
        condition: "DAMAGED",
      };
    }
    return Ledger.#readFrom(this.#db, this.journalPath, this.#damaged, this.condition);
  }

  /**
   * Opens a store by path and reads it. Used by `keeper journal` and by tests.
   * NEVER throws: a store that cannot be opened comes back as zero records with
   * integrityOk false and a detail an operator can read.
   *
   * A store that DOES NOT EXIST is not damage — that is the ABSENT case, and it
   * reads as an intact empty history. A store that exists but is empty, truncated
   * or not a database IS damage, and the probe is what tells the two apart.
   */
  static read(dbPath: string): JournalRead {
    let db: DatabaseSyncType | null = null;
    const probe = probeStoreFile(dbPath);
    try {
      if (probe.condition === "ABSENT") {
        return {
          records: [],
          integrityOk: true,
          integrityDetail: null,
          rejected: [],
          totalBytes: 0,
          condition: "ABSENT",
        };
      }
      if (probe.condition === "DAMAGED") {
        return {
          records: [],
          integrityOk: false,
          integrityDetail: probe.detail,
          rejected: [],
          totalBytes: probe.sizeBytes ?? 0,
          condition: "DAMAGED",
        };
      }
      db = new DatabaseSync(dbPath);
      db.exec("PRAGMA busy_timeout = 15000");
      const quick = db.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
      if (quick?.quick_check !== "ok") {
        return {
          records: [],
          integrityOk: false,
          integrityDetail:
            `PRAGMA quick_check on ${dbPath} reported ${JSON.stringify(quick?.quick_check ?? "nothing")}. ` +
            HOW_TO_RECOVER,
          rejected: [],
          totalBytes: Ledger.#sizeOf(dbPath),
          condition: "DAMAGED",
        };
      }
      const missing = Ledger.#missingTables(db);
      if (missing.length > 0) {
        return {
          records: [],
          integrityOk: false,
          integrityDetail:
            `The store at ${dbPath} is a SQLite database but is missing the table(s) ` +
            `${missing.join(", ")}, so the rules that refuse a double settlement cannot be evaluated. ` +
            HOW_TO_RECOVER,
          rejected: [],
          totalBytes: Ledger.#sizeOf(dbPath),
          condition: "DAMAGED",
        };
      }
      return Ledger.#readFrom(db, dbPath, null, "HEALTHY");
    } catch (error) {
      return {
        records: [],
        integrityOk: false,
        integrityDetail: `the store at ${dbPath} could not be read: ${(error as Error).message}`,
        rejected: [],
        totalBytes: Ledger.#sizeOf(dbPath),
        condition: "DAMAGED",
      };
    } finally {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
    }
  }

  static #sizeOf(path: string): number {
    try {
      return statSync(path).size;
    } catch {
      return 0;
    }
  }

  static #readFrom(
    db: DatabaseSyncType,
    path: string,
    damaged: string | null,
    condition: StoreCondition,
    exemptSeq: number | null = null,
  ): JournalRead {
    const records: JournalRecord[] = [];
    const rejected: number[] = [];
    const problems: string[] = [];
    if (damaged !== null) problems.push(damaged);

    let rows: RecordRow[];
    try {
      const statement = db.prepare("SELECT seq, ts, type, prev_digest, digest, body FROM record ORDER BY seq");
      statement.setReadBigInts(true);
      rows = statement.all() as unknown as RecordRow[];
    } catch (error) {
      return {
        records: [],
        integrityOk: false,
        integrityDetail: `the record stream could not be read: ${(error as Error).message}`,
        rejected: [],
        totalBytes: Ledger.#sizeOf(path),
        condition: "DAMAGED",
      };
    }

    let expectedSeq = 0;
    let expectedPrev = GENESIS;
    for (const row of rows) {
      const seq = num(row.seq);
      if (seq !== expectedSeq) {
        problems.push(
          `record seq is not dense: expected ${expectedSeq}, found ${seq}. A record was removed or ` +
            "inserted out of band.",
        );
        expectedSeq = seq;
      }
      if (row.prev_digest !== expectedPrev) {
        problems.push(
          `record ${seq} does not chain to its predecessor (prevDigest ${row.prev_digest} != ${expectedPrev}).`,
        );
      }
      expectedSeq = seq + 1;
      // Chain to the STORED digest, deliberately. A single edited row is then the
      // only row that fails; everything after it still verifies.
      expectedPrev = row.digest;

      let body: RecordBody;
      try {
        body = decode(JSON.parse(row.body)) as RecordBody;
      } catch {
        rejected.push(seq);
        problems.push(`record ${seq} has a body that is not decodable JSON.`);
        continue;
      }
      const type = row.type as RecordType;
      if (digestOf(seq, row.prev_digest, type, row.ts, body) !== row.digest) {
        // The one thing an ACID transaction does not catch: someone edited a
        // committed row. It is not believed, and it is named.
        rejected.push(seq);
        problems.push(
          `record ${seq} (${row.type}) fails its integrity digest: it was edited after it was written, ` +
            "so it is NOT admitted.",
        );
        continue;
      }
      records.push({ seq, ts: row.ts, type, prevHash: row.prev_digest, hash: row.digest, body });
    }

    // THE DECISION TABLES, NOT ONLY THE AUDIT LOG. See #reconcileDecisions.
    problems.push(...Ledger.#reconcileDecisions(db, records, exemptSeq));

    return {
      records,
      integrityOk: problems.length === 0,
      integrityDetail: problems.length === 0 ? null : problems.join(" "),
      rejected,
      totalBytes: Ledger.#sizeOf(path),
      condition,
    };
  }

  // -------------------------------------------------------------------------
  // TAMPER DETECTION ON THE LOAD-BEARING PATH.
  //
  // `integrityOk` used to derive ONLY from the `record` table's digest chain. The
  // record table is an AUDIT LOG. The tables that actually gate a settlement are
  // `settlement` (the frontier chain the dedup reads), `terminal_window` and
  // `halt` — and none of them carries a digest, so editing one of them was
  // invisible. Deleting the single settlement row for a confirmed window left a
  // store whose record stream said "settled" and whose FRONTIER SAID NOTHING IS
  // SETTLED, with integrityOk cheerfully true. That is the double-settle path with
  // one `DELETE` in front of it.
  //
  // THE CHECK IS A RECONCILIATION, NOT A SECOND DIGEST: the derived frontier must
  // FOLLOW FROM the recorded settlements. If it does not, something edited one of
  // them, and it does not matter which.
  //
  //   (1) every settlement row must cite an ADMITTED record of a settlement-bearing
  //       type, and must agree with it field by field — window, epoch, nonce,
  //       sessionId, contribution. Catches an EDITED or INVENTED decision row.
  //   (2) every admitted INTENT / CONFIRMED / ADOPTED record must be projected into
  //       the settlement table, either as its own row or as the resolution of one.
  //       Catches a DELETED decision row.
  //   (3) every admitted SKIPPED must have its terminal_window row, and every
  //       admitted DEGRADED its halt row. Those two tables refuse, respectively,
  //       re-verifying a refusal forever and settling through an unacknowledged
  //       halt.
  //   (4) the live covering rows must form ONE strictly increasing chain from the
  //       genesis link to the frontier: one origin, no forks, no orphans, and the
  //       chain must end exactly at MAX(end_block_l2). Catches a RELINKED row, and
  //       is the direct statement of "the settled frontier follows from the
  //       recorded settlements".
  //
  // A RESUMED record is deliberately NOT cross-checked against the halt it names:
  // one that names the wrong halt legitimately clears nothing, and that is a
  // tested behaviour, not damage.
  // -------------------------------------------------------------------------
  static #reconcileDecisions(
    db: DatabaseSyncType,
    records: readonly JournalRecord[],
    /**
     * The record currently being projected, which is already in the `record`
     * table but has not reached the decision tables yet. Only #assertIntegrity
     * passes it, and only for the record it is in the middle of writing.
     */
    exemptSeq: number | null = null,
  ): string[] {
    const problems: string[] = [];
    try {
      const identity = db.prepare("SELECT account FROM instance WHERE id = 1").get() as
        | { account?: string }
        | undefined;
      const account = identity?.account;
      if (typeof account !== "string") {
        return [
          "the store holds no identity row, so its settlement rows cannot be attributed to an account " +
            "and the decision tables cannot be reconciled against the record stream.",
        ];
      }

      const q = (sql: string): StatementSync => {
        const statement = db.prepare(sql);
        statement.setReadBigInts(true);
        return statement;
      };

      interface Row {
        id: bigint;
        record_seq: bigint;
        resolved_record_seq: bigint | null;
        status: string;
        origin: string;
        start_block_l2: bigint;
        end_block_l2: bigint;
        prev_end_block_l2: bigint | null;
        l2_precision: string;
        binding_epoch: bigint;
        settlement_nonce: bigint;
        session_id: string;
        contribution_wei: string;
      }
      const rows = q(
        `SELECT id, record_seq, resolved_record_seq, status, origin, start_block_l2, end_block_l2,
                prev_end_block_l2, l2_precision, binding_epoch, settlement_nonce, session_id, contribution_wei
           FROM settlement WHERE account = ? ORDER BY id`,
      ).all(account) as unknown as Row[];

      const admitted = new Map(records.map((record) => [record.seq, record]));
      const projected = new Set<number>();
      const resolved = new Set<number>();

      // ---- (1) every settlement row is backed by the record it cites ---------
      for (const row of rows) {
        const seq = num(row.record_seq);
        projected.add(seq);
        if (row.resolved_record_seq !== null) resolved.add(num(row.resolved_record_seq));
        const record = admitted.get(seq);
        if (record === undefined) {
          problems.push(
            `settlement row id=${num(row.id)} over L2 [${row.start_block_l2},${row.end_block_l2}] cites ` +
              `record ${seq}, which this store cannot produce or cannot verify. A row the settled ` +
              "frontier is derived from is not backed by the record stream.",
          );
          continue;
        }
        if (record.type !== "INTENT" && record.type !== "CONFIRMED" && record.type !== "ADOPTED") {
          problems.push(
            `settlement row id=${num(row.id)} cites record ${seq}, which is a ${record.type} and records ` +
              "no settlement. A decision row was inserted out of band.",
          );
          continue;
        }
        const facts = record.body as SettlementFacts;
        const disagreements: string[] = [];
        const check = (name: string, stored: bigint | string, expected: bigint | string): void => {
          if (stored !== expected) disagreements.push(`${name} ${String(stored)} != ${String(expected)}`);
        };
        check("startBlockL2", row.start_block_l2, facts.startBlockL2);
        check("endBlockL2", row.end_block_l2, facts.endBlockL2);
        check("bindingEpoch", row.binding_epoch, facts.bindingEpoch);
        check("settlementNonce", row.settlement_nonce, facts.settlementNonce);
        check("sessionId", row.session_id, facts.sessionId.toLowerCase());
        check("contributionWei", row.contribution_wei, facts.contribution.toString());
        if (disagreements.length > 0) {
          problems.push(
            `settlement row id=${num(row.id)} disagrees with record ${seq} (${disagreements.join("; ")}). ` +
              "A row the dedup reads was edited after it was written, so the settled frontier no longer " +
              "follows from the recorded settlements.",
          );
        }
      }

      // ---- (2) every settlement-bearing record reached the decision table ----
      for (const record of records) {
        if (record.seq === exemptSeq) continue;
        if (record.type === "INTENT" || record.type === "CONFIRMED" || record.type === "ADOPTED") {
          if (!projected.has(record.seq) && !resolved.has(record.seq)) {
            const facts = record.body as SettlementFacts;
            problems.push(
              `record ${record.seq} (${record.type}) records a settlement over L2 ` +
                `[${facts.startBlockL2},${facts.endBlockL2}] that the settlement table does not contain. ` +
                "The settled frontier does not follow from the recorded settlements: a decision row was " +
                "removed out of band, and this store would offer that window again.",
            );
          }
        }
      }

      // ---- (3) refusals and halts ------------------------------------------
      const terminalKeys = new Set(
        (
          q("SELECT start_block_l2 AS s, end_block_l2 AS e FROM terminal_window WHERE account = ?").all(
            account,
          ) as unknown as { s: bigint; e: bigint }[]
        ).map((row) => `${row.s}:${row.e}`),
      );
      const haltSeqs = new Set(
        (q("SELECT record_seq AS s FROM halt").all() as unknown as { s: bigint }[]).map((row) => num(row.s)),
      );
      for (const record of records) {
        if (record.seq === exemptSeq) continue;
        if (record.type === "SKIPPED") {
          const body = record.body as SkippedBody;
          if (!terminalKeys.has(`${body.startBlockL2}:${body.endBlockL2}`)) {
            problems.push(
              `record ${record.seq} (SKIPPED ${body.reason}) refused L2 ` +
                `[${body.startBlockL2},${body.endBlockL2}] but no terminal_window row records it, so the ` +
                "refusal would not be honoured.",
            );
          }
        } else if (record.type === "DEGRADED" && !haltSeqs.has(record.seq)) {
          problems.push(
            `record ${record.seq} (DEGRADED) halted this keeper but no halt row records it, so the halt ` +
              "would not be enforced on the settle path.",
          );
        }
      }

      // ---- (4) the frontier chain is one chain -----------------------------
      const covering = rows.filter(
        (row) =>
          (row.status === "INTENT" || row.status === "CONFIRMED") &&
          row.l2_precision !== "UNRESOLVED" &&
          row.l2_precision !== "COVERED",
      );
      if (covering.length > 0) {
        const GENESIS_LINK = "genesis";
        const byPrev = new Map<string, Row>();
        for (const row of covering) {
          const key = row.prev_end_block_l2 === null ? GENESIS_LINK : row.prev_end_block_l2.toString();
          if (byPrev.has(key)) {
            problems.push(
              `two live settlements both extend the frontier ${key}, so the settled coverage forks. ` +
                "One of them is not a settlement this keeper made.",
            );
          }
          byPrev.set(key, row);
        }
        let cursor = byPrev.get(GENESIS_LINK);
        if (cursor === undefined) {
          problems.push(
            "the settled frontier chain has no origin row: every live settlement claims to extend an " +
              "earlier one, so the chain the dedup walks is broken.",
          );
        }
        const seen = new Set<bigint>();
        let end: bigint | null = null;
        let linked = 0;
        while (cursor !== undefined && !seen.has(cursor.id)) {
          seen.add(cursor.id);
          linked += 1;
          end = cursor.end_block_l2;
          cursor = byPrev.get(end.toString());
        }
        if (linked !== covering.length) {
          problems.push(
            `${covering.length - linked} live settlement(s) are not linked into the settled frontier ` +
              "chain, so the frontier the dedup reads does not cover every settlement on record.",
          );
        }
        const max = covering.reduce<bigint>(
          (best, row) => (row.end_block_l2 > best ? row.end_block_l2 : best),
          covering[0]?.end_block_l2 ?? 0n,
        );
        if (end !== null && end !== max) {
          problems.push(
            `the settled frontier chain ends at ${end} but a live settlement reaches ${max}. The replay ` +
              "boundary is lower than the coverage actually on record.",
          );
        }
      }
    } catch (error) {
      problems.push(
        "the decision tables (settlement, terminal_window, halt) could not be reconciled against the " +
          `record stream: ${(error as Error).message}. Their contents are what refuse a double ` +
          "settlement, so nothing may be settled while they cannot be checked.",
      );
    }
    return problems;
  }

  /**
   * INVENTORY GUARANTEE #26: THIS NEVER THROWS.
   *
   * An inspection command has to work during exactly the incident it exists for,
   * so a structurally damaged store — a dropped table, an unreadable page, a file
   * that was never a database — comes back as a VALUE that says so, never as an
   * exception out of a property access. `keeper status`, `keeper journal` and
   * `keeper recover` all open read-only and stay usable on a store too damaged to
   * run against.
   *
   * The other half of the rule lives in #assertWritable: READ PATHS DEGRADE AND
   * REPORT, WRITE PATHS REFUSE. Degrading here does not soften anything, because
   * the degraded value carries integrityOk false and condition DAMAGED, and
   * localEligibility refuses every window on the first and append() refuses every
   * write on the second.
   */
  get state(): LedgerState {
    if (this.#state === null) {
      try {
        this.#state = this.#deriveState();
      } catch (error) {
        // A query over the decision tables failed. On a store already known to be
        // damaged the probe's own sentence is the better one — it says WHICH table
        // or WHICH file, and what to do — so it wins over the raw SQLite text.
        this.#state = Ledger.#damagedState(
          this.#damaged ??
            `the store at ${this.journalPath} could not be read into a usable state ` +
              `(${(error as Error).message}). It is being reported, not repaired. ` +
              HOW_TO_RECOVER,
        );
      }
    }
    return this.#state;
  }

  /** The value a store that cannot answer questions returns. Never a throw, never a lie. */
  static #damagedState(detail: string | null): LedgerState {
    return {
      seq: -1,
      head: GENESIS,
      header: null,
      anchorBlockL2: null,
      anchorBlockHash: null,
      settledFrontierL2: null,
      settledHighWaterL1: null,
      chainGuardL1: new Map(),
      refusedHighWaterL2: null,
      settledSessionIds: new Set(),
      settlementCount: 0,
      settledContributionWei: 0n,
      settledSettlementNonces: new Set(),
      acknowledgedNonceFloor: 0n,
      openIntents: [],
      confirmedRecords: [],
      terminalWindows: new Map(),
      confirmedAtMs: [],
      degraded: null,
      counts: emptyCounts(),
      coverageUnresolved: 0,
      // Both false and DAMAGED, always together. Every zero above is "unknown",
      // never "nothing happened", and these two fields are what say so — a caller
      // that reads settledFrontierL2 as null without reading these would conclude
      // the store has never settled anything, which is the double-settle path.
      integrityOk: false,
      integrityDetail: detail,
      condition: "DAMAGED",
    };
  }

  /** Every derived value is a QUERY over the tables the constraints police. */
  #deriveState(): LedgerState {
    const read = this.readRecords();
    const db = this.#db;
    if (db === null) {
      return Ledger.#damagedState(read.integrityDetail);
    }

    const q = (sql: string): StatementSync => {
      const statement = db.prepare(sql);
      statement.setReadBigInts(true);
      return statement;
    };
    const account = this.#account;

    const last = records(read).at(-1);
    const headerRecord = records(read).find((r) => r.type === "HEADER");

    const checkpoint = q("SELECT anchor_block_l2, anchor_block_hash FROM chain_checkpoint WHERE id = 1").get() as
      | { anchor_block_l2: bigint; anchor_block_hash: string }
      | undefined;

    const frontierRow = q(
      `SELECT MAX(end_block_l2) AS f FROM settlement WHERE account = ? AND ${COVERING}`,
    ).get(account) as { f: bigint | null };

    const highWaterRow = q(
      "SELECT MAX(end_block_l1) AS f FROM settlement WHERE account = ? AND status = 'CONFIRMED'",
    ).get(account) as { f: bigint | null };

    const chainGuardL1 = new Map<string, bigint>();
    for (const row of q(
      `SELECT binding_epoch AS e, MAX(end_block_l1) AS m FROM settlement
        WHERE account = ? AND status = 'CONFIRMED' GROUP BY binding_epoch`,
    ).all(account) as unknown as { e: bigint; m: bigint }[]) {
      chainGuardL1.set(row.e.toString(), row.m);
    }

    const settledSessionIds = new Set<string>();
    const settledSettlementNonces = new Set<string>();
    let settledContributionWei = 0n;
    let settlementCount = 0;
    for (const row of q(
      `SELECT session_id, settlement_nonce, contribution_wei FROM settlement
        WHERE account = ? AND status = 'CONFIRMED' ORDER BY id`,
    ).all(account) as unknown as { session_id: string; settlement_nonce: bigint; contribution_wei: string }[]) {
      settledSessionIds.add(row.session_id.toLowerCase());
      settledSettlementNonces.add(row.settlement_nonce.toString());
      // Summed in JS with BigInt. NEVER SUM() in SQL: the column is decimal TEXT
      // and SQL would compare and add it lexicographically.
      settledContributionWei += BigInt(row.contribution_wei);
      settlementCount += 1;
    }

    const coverageUnresolved = num(
      (q(`SELECT COUNT(*) AS n FROM settlement WHERE account = ? AND ${LIVE} AND l2_precision = 'UNRESOLVED'`).get(
        account,
      ) as { n: bigint }).n,
    );

    const openIntentSeqs = new Set(
      (
        q(`SELECT record_seq AS s FROM settlement WHERE account = ? AND status = 'INTENT' ORDER BY id`).all(
          account,
        ) as unknown as { s: bigint }[]
      ).map((row) => num(row.s)),
    );

    const terminalWindows = new Map<string, SkipReason>();
    let refusedHighWaterL2: bigint | null = null;
    for (const row of q(
      `SELECT start_block_l2 AS s, end_block_l2 AS e, reason, end_block_l1 AS l1, binding_epoch AS ep
         FROM terminal_window WHERE account = ? ORDER BY record_seq`,
    ).all(account) as unknown as {
      s: bigint;
      e: bigint;
      reason: string;
      l1: bigint | null;
      ep: bigint | null;
    }[]) {
      terminalWindows.set(`${row.s}:${row.e}`, row.reason as SkipReason);
      // Carried across verbatim from the JSONL store, INCLUDING its condition:
      // only a SKIPPED that recorded endBlockL1 AND bindingEpoch moves the refusal
      // boundary. It moves it in L2 ONLY, and deliberately NEVER in L1 — a refused
      // window must not fabricate an L1 boundary the chain does not have, or the
      // keeper would start refusing genuinely-new windows as replays.
      if (row.l1 !== null && row.ep !== null && (refusedHighWaterL2 === null || row.e > refusedHighWaterL2)) {
        refusedHighWaterL2 = row.e;
      }
    }

    const openHalt = q(
      "SELECT record_seq AS s, reason, detail FROM halt WHERE cleared_at IS NULL ORDER BY record_seq DESC LIMIT 1",
    ).get() as { s: bigint; reason: string; detail: string } | undefined;

    // The floor is the MAX over CLEARED halts, so it only ever rises by
    // construction, and a halt that recorded no bound (NULL) excuses nothing.
    const floorRow = q("SELECT MAX(unaccounted_below) AS f FROM halt WHERE cleared_at IS NOT NULL").get() as {
      f: bigint | null;
    };

    const counts = emptyCounts();
    for (const row of q("SELECT type, COUNT(*) AS n FROM record GROUP BY type").all() as unknown as {
      type: string;
      n: bigint;
    }[]) {
      if ((RECORD_TYPES as readonly string[]).includes(row.type)) counts[row.type as RecordType] = num(row.n);
    }

    const openIntents: JournalRecord<IntentBody>[] = [];
    const confirmedRecords: JournalRecord<ConfirmedBody>[] = [];
    const confirmedAtMs: number[] = [];
    for (const record of records(read)) {
      if (record.type === "INTENT" && openIntentSeqs.has(record.seq)) {
        openIntents.push(record as JournalRecord<IntentBody>);
      } else if (record.type === "CONFIRMED" || record.type === "ADOPTED") {
        confirmedRecords.push(record as JournalRecord<ConfirmedBody>);
        confirmedAtMs.push(Date.parse(record.ts));
      }
    }

    return {
      seq: last?.seq ?? -1,
      head: last?.hash ?? GENESIS,
      header: (headerRecord?.body as HeaderBody | undefined) ?? null,
      anchorBlockL2: checkpoint ? checkpoint.anchor_block_l2 : null,
      anchorBlockHash: checkpoint ? checkpoint.anchor_block_hash : null,
      settledFrontierL2: frontierRow.f,
      settledHighWaterL1: highWaterRow.f,
      chainGuardL1,
      refusedHighWaterL2,
      settledSessionIds,
      settlementCount,
      settledContributionWei,
      settledSettlementNonces,
      acknowledgedNonceFloor: floorRow.f ?? 0n,
      openIntents,
      confirmedRecords,
      terminalWindows,
      confirmedAtMs,
      degraded:
        openHalt === undefined
          ? null
          : { seq: num(openHalt.s), reason: openHalt.reason, detail: openHalt.detail },
      counts,
      coverageUnresolved,
      integrityOk: read.integrityOk,
      integrityDetail: read.integrityDetail,
      condition: this.condition,
    };
  }

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  /**
   * Appends one record, DURABLY, before it returns, and projects it into the
   * tables whose constraints police it — in ONE transaction.
   *
   * That single transaction is the safety property. `submit.ts` does
   * `reserve nonce -> estimate -> sign locally -> APPEND INTENT -> send`, and this
   * method's COMMIT is that ordering's durability point: with synchronous=FULL the
   * commit fsyncs before returning, so a settle transaction can only ever exist if
   * a durable INTENT row for its exact L2 window already exists. Every dedup
   * constraint is evaluated HERE, before any broadcast — the database refuses to
   * let the keeper form the intention to double-settle.
   *
   * Throws LedgerConstraintError when the store refuses, and LedgerWriteError when
   * it cannot write at all. It NEVER returns having lost the record.
   */
  append<T extends RecordBody>(type: RecordType, body: T): JournalRecord<T> {
    const ts = this.#now().toISOString();
    return this.#tx((db) => {
      const tip = db.prepare("SELECT seq, digest FROM record ORDER BY seq DESC LIMIT 1").get() as
        | { seq: number | bigint; digest: string }
        | undefined;
      const seq = tip === undefined ? 0 : num(tip.seq) + 1;
      const prevHash = tip?.digest ?? GENESIS;
      const hash = digestOf(seq, prevHash, type, ts, body);

      db.prepare("INSERT INTO record (seq, ts, type, prev_digest, digest, body) VALUES (?,?,?,?,?,?)").run(
        BigInt(seq),
        ts,
        type,
        prevHash,
        hash,
        JSON.stringify(encode(body)),
      );
      this.#project(db, seq, ts, type, body);
      return { seq, ts, type, prevHash, hash, body };
    });
  }

  /** Projects a record onto the tables that enforce the rules. Inside the record's own transaction. */
  #project(db: DatabaseSyncType, seq: number, ts: string, type: RecordType, body: RecordBody): void {
    switch (type) {
      case "INTENT": {
        // NON-NEGOTIABLE #2, ENFORCED STRUCTURALLY. An open halt makes it
        // impossible to record the intention to settle, so it is impossible to
        // reach a broadcast. localEligibility says the same thing earlier and more
        // politely; this is the version with no way around it.
        this.#assertNoOpenHalt(db);
        this.#assertIntegrity(db, seq);
        const intent = body as IntentBody;
        this.#insertSettlement(db, seq, ts, {
          status: "INTENT",
          origin: "KEEPER",
          l2Precision: "EXACT",
          facts: intent,
          rawTxHash: intent.rawTxHash,
          txHash: null,
          eoaNonce: intent.eoaNonce,
          deadline: intent.deadline,
          resolvedAt: null,
          detail: null,
        });
        break;
      }
      case "CONFIRMED":
      case "ADOPTED": {
        this.#assertIntegrity(db, seq);
        const confirmed = body as ConfirmedBody;
        const adopted = type === "ADOPTED" || confirmed.source === "adopted";
        const precision: L2Precision =
          confirmed.l2Precision ??
          (adopted
            ? confirmed.startBlockL2 === 0n && confirmed.endBlockL2 === 0n
              ? "UNRESOLVED"
              : "L1_CLAMP"
            : "EXACT");

        // An open INTENT is resolved by any terminal record for the SAME WINDOW,
        // not the same sessionId: a re-derivation after a rebind produces a
        // different sessionId over the same window and the intent must still count
        // as resolved, or SINGLE_FLIGHT wedges permanently.
        const open = this.#findOpenIntent(db, confirmed);
        if (open !== undefined && !adopted) {
          db.prepare(
            `UPDATE settlement SET status='CONFIRMED', tx_hash=?, resolved_at=?, resolved_record_seq=?,
                                   resolution_detail=? WHERE id=?`,
          ).run(confirmed.txHash, ts, BigInt(seq), "receipt succeeded", BigInt(open));
        } else {
          this.#insertSettlement(db, seq, ts, {
            status: "CONFIRMED",
            origin: adopted ? "ADOPTED" : "KEEPER",
            l2Precision: precision,
            facts: confirmed,
            rawTxHash: null,
            txHash: confirmed.txHash,
            eoaNonce: null,
            deadline: null,
            resolvedAt: ts,
            detail: adopted ? "adopted from chain evidence" : "recorded without a prior intent",
          });
        }
        break;
      }
      case "FAILED":
      case "ABANDONED": {
        // A FAILED or ABANDONED record RECORDS NO PROGRESS. Gas burned, EOA nonce
        // consumed, no money moved — the window is still unsettled. So no boundary
        // advances, nothing becomes terminal, no settlement is counted, no
        // settlementNonce becomes nameable, the rate-limit window is not fed.
        // ONLY the intent clears, which also RELEASES the frontier so a retry is
        // possible; the row stays on disk for audit.
        const window = body as FailedBody | AbandonedBody;
        const open = this.#findOpenIntent(db, window);
        if (open !== undefined) {
          db.prepare(
            `UPDATE settlement SET status=?, resolved_at=?, resolved_record_seq=?, resolution_detail=? WHERE id=?`,
          ).run(type, ts, BigInt(seq), window.reason.slice(0, 500), BigInt(open));
        }
        break;
      }
      case "SKIPPED": {
        const skipped = body as SkippedBody;
        db.prepare(
          `INSERT INTO terminal_window
             (account, start_block_l2, end_block_l2, reason, detail, engine_reasons, binding_epoch,
              end_block_l1, record_seq, recorded_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(account, start_block_l2, end_block_l2) DO UPDATE SET
             reason=excluded.reason, detail=excluded.detail, engine_reasons=excluded.engine_reasons,
             binding_epoch=excluded.binding_epoch, end_block_l1=excluded.end_block_l1,
             record_seq=excluded.record_seq, recorded_at=excluded.recorded_at`,
        ).run(
          this.#account,
          skipped.startBlockL2,
          skipped.endBlockL2,
          skipped.reason,
          skipped.detail.slice(0, 4000),
          skipped.engineReasons ? JSON.stringify(skipped.engineReasons) : null,
          skipped.bindingEpoch ?? null,
          skipped.endBlockL1 ?? null,
          BigInt(seq),
          ts,
        );
        // A SKIPPED record also clears any open intent for the same window.
        const open = this.#findOpenIntent(db, skipped);
        if (open !== undefined) {
          db.prepare(
            `UPDATE settlement SET status='ABANDONED', resolved_at=?, resolved_record_seq=?,
                                   resolution_detail=? WHERE id=?`,
          ).run(ts, BigInt(seq), `superseded by SKIPPED ${skipped.reason}`, BigInt(open));
        }
        break;
      }
      case "DEGRADED": {
        const halt = body as DegradedBody;
        db.prepare(
          "INSERT INTO halt (record_seq, reason, detail, unaccounted_below, raised_at) VALUES (?,?,?,?,?)",
        ).run(
          BigInt(seq),
          halt.reason,
          halt.detail.slice(0, 4000),
          halt.unaccountedBelow ?? null,
          ts,
        );
        break;
      }
      case "RESUMED": {
        // A RESUMED must NAME the exact halt it clears. The acknowledgement is
        // per-record, so a stale script or a replayed command cannot clear a NEW
        // halt — and clearing raises the floor only to the bound that halt
        // recorded, so it never excuses a settlement that happens afterwards.
        const resumed = body as ResumedBody;
        db.prepare(
          `UPDATE halt SET cleared_at=?, cleared_by_record_seq=?, cleared_note=?
            WHERE record_seq=? AND cleared_at IS NULL`,
        ).run(ts, BigInt(seq), resumed.note.slice(0, 1000), BigInt(resumed.acknowledgedSeq));
        break;
      }
      case "CHECKPOINT": {
        const checkpoint = body as CheckpointBody;
        db.prepare(
          `INSERT INTO chain_checkpoint (id, anchor_block_l2, anchor_block_hash, head_block_l2, record_seq, updated_at)
           VALUES (1,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET anchor_block_l2=excluded.anchor_block_l2,
             anchor_block_hash=excluded.anchor_block_hash, head_block_l2=excluded.head_block_l2,
             record_seq=excluded.record_seq, updated_at=excluded.updated_at`,
        ).run(
          checkpoint.anchorBlockL2,
          checkpoint.anchorBlockHash,
          checkpoint.headBlockL2,
          BigInt(seq),
          ts,
        );
        break;
      }
      case "HEADER":
      case "DRYRUN":
        // A DRYRUN is DELIBERATELY INERT: a full audit trail that changes no
        // eligibility, no boundary and no counter. Non-negotiable #1.
        break;
    }
  }

  /**
   * THE SECOND LAYER, RESTORED FOR THE DECISION TABLES.
   *
   * The frontier constraints are the schema's own refusal, and they are computed
   * FROM the settlement table — so deleting the one row for a settled window makes
   * the frontier NULL and the schema stops refusing the replay. localEligibility
   * would still refuse it with STORE_INTEGRITY, but that leaves the guarantee
   * resting on ONE layer, and this file's whole argument is that it must rest on
   * two independent ones.
   *
   * So no settlement-bearing record is recorded while the decision tables do not
   * follow from the record stream. Checked INSIDE the write transaction, on the
   * table contents as they stand at that moment, exempting only the record row
   * this call is in the middle of projecting.
   *
   * It runs on INTENT / CONFIRMED / ADOPTED only. A CHECKPOINT, a SKIPPED, a
   * DEGRADED and a FAILED move no money and must stay recordable on a store that
   * needs exactly those records written to explain itself.
   */
  #assertIntegrity(db: DatabaseSyncType, seq: number): void {
    const read = Ledger.#readFrom(db, this.journalPath, this.#damaged, this.condition, seq);
    if (read.integrityOk) return;
    throw new LedgerConstraintError(
      "STORE_INTEGRITY",
      null,
      "The store REFUSED to record a settlement: its decision tables do not follow from its record " +
        `stream, so the frontier that refuses a replay cannot be trusted. ${read.integrityDetail ?? "unknown"}`,
    );
  }

  #assertNoOpenHalt(db: DatabaseSyncType): void {
    const halt = db.prepare("SELECT record_seq, reason FROM halt WHERE cleared_at IS NULL LIMIT 1").get() as
      | { record_seq: number | bigint; reason: string }
      | undefined;
    if (halt !== undefined) {
      throw new LedgerConstraintError(
        "NOT_DEGRADED",
        null,
        `The store REFUSED to record a settlement intent: it is halted at record ${num(halt.record_seq)} ` +
          `(${halt.reason}). An operator must acknowledge it by name with --acknowledge-degraded.`,
      );
    }
  }

  #findOpenIntent(db: DatabaseSyncType, window: WindowRef): number | undefined {
    const row = db
      .prepare(
        `SELECT id FROM settlement WHERE account=? AND status='INTENT'
           AND start_block_l2=? AND end_block_l2=? LIMIT 1`,
      )
      .get(this.#account, window.startBlockL2, window.endBlockL2) as { id: number | bigint } | undefined;
    return row === undefined ? undefined : num(row.id);
  }

  #insertSettlement(
    db: DatabaseSyncType,
    seq: number,
    ts: string,
    row: {
      status: "INTENT" | "CONFIRMED";
      origin: "KEEPER" | "ADOPTED";
      l2Precision: L2Precision;
      facts: SettlementFacts;
      rawTxHash: string | null;
      txHash: string | null;
      eoaNonce: number | null;
      deadline: number | null;
      resolvedAt: string | null;
      detail: string | null;
    },
  ): void {
    // Read the frontier and insert inside ONE BEGIN IMMEDIATE, which closes the
    // TOCTOU window. Even if this read were wrong, the trigger re-evaluates
    // MAX(end_block_l2) under the same exclusive lock, so a stale read cannot
    // produce a stale link.
    const frontier =
      row.l2Precision === "UNRESOLVED" || row.l2Precision === "COVERED"
        ? null
        : (
            db
              .prepare(`SELECT MAX(end_block_l2) AS f FROM settlement WHERE account=? AND ${COVERING}`)
              .get(this.#account) as { f: number | bigint | null }
          ).f;

    db.prepare(
      `INSERT INTO settlement
         (record_seq, account, status, origin, start_block_l2, end_block_l2, prev_end_block_l2, l2_precision,
          binding_epoch, settlement_nonce, start_block_l1, end_block_l1, session_id, ledger_root,
          contribution_wei, realized_profit_wei, raw_tx_hash, tx_hash, eoa_nonce, deadline,
          created_at, resolved_at, resolution_detail)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      BigInt(seq),
      this.#account,
      row.status,
      row.origin,
      row.facts.startBlockL2,
      row.facts.endBlockL2,
      frontier === null ? null : BigInt(frontier),
      row.l2Precision,
      row.facts.bindingEpoch,
      row.facts.settlementNonce,
      row.facts.startBlockL1,
      row.facts.endBlockL1,
      row.facts.sessionId.toLowerCase(),
      row.facts.ledgerRoot.toLowerCase(),
      row.facts.contribution.toString(),
      row.facts.realizedProfit.toString(),
      row.rawTxHash === null ? null : row.rawTxHash.toLowerCase(),
      row.txHash === null ? null : row.txHash.toLowerCase(),
      row.eoaNonce === null ? null : BigInt(row.eoaNonce),
      row.deadline === null ? null : BigInt(row.deadline),
      ts,
      row.resolvedAt,
      row.detail,
    );
  }

  /** Writes the HEADER if this store has none. Idempotent. */
  ensureHeader(baseline: { settlementNonce: bigint; lifetimeContribution: bigint }): void {
    if (this.state.header !== null) return;
    this.append<HeaderBody>("HEADER", {
      ...this.instance,
      createdAt: this.#now().toISOString(),
      baselineSettlementNonce: baseline.settlementNonce,
      baselineLifetimeContribution: baseline.lifetimeContribution,
    });
  }

  /**
   * Writes the derived snapshot ATOMICALLY: temp file in the SAME directory,
   * fsync, rename over the target, fsync the directory.
   *
   * Never `open(target, "w")` — that truncates first, so a crash there leaves a
   * zero-length snapshot. Snapshot LOSS IS NON-FATAL: it is a derived convenience
   * file, nothing ever reads it back, and destroying it costs an operator a
   * glance at `keeper status` instead of a `cat`. It carries the accounting a
   * human has to be able to check by eye during an incident.
   */
  writeSnapshot(extra: Record<string, unknown> = {}): void {
    const state = this.state;
    const payload = {
      ledgerSchema: this.instance.ledgerSchema,
      storeSchemaVersion: STORE_SCHEMA_VERSION,
      writtenAt: this.#now().toISOString(),
      journalSeq: state.seq,
      journalHead: state.head,
      anchorBlockL2: state.anchorBlockL2?.toString() ?? null,
      anchorBlockHash: state.anchorBlockHash,
      // THE EPOCH-INDEPENDENT REPLAY BOUNDARY. This is the number an operator
      // should look at first during an incident.
      settledFrontierL2: state.settledFrontierL2?.toString() ?? null,
      settledHighWaterL1: state.settledHighWaterL1?.toString() ?? null,
      refusedHighWaterL2: state.refusedHighWaterL2?.toString() ?? null,
      // A REVERT PREDICTOR ONLY, and labelled as one wherever it is published: it
      // mirrors a vault guard that a bindingEpoch rebind resets.
      chainGuardL1_revertPredictorOnly: Object.fromEntries(
        [...state.chainGuardL1].map(([k, v]) => [k, v.toString()]),
      ),
      settledSessionIds: [...state.settledSessionIds],
      settlementCount: state.settlementCount,
      settledContributionWei: state.settledContributionWei.toString(),
      settledSettlementNonces: [...state.settledSettlementNonces],
      acknowledgedNonceFloor: state.acknowledgedNonceFloor.toString(),
      coverageUnresolved: state.coverageUnresolved,
      integrityOk: state.integrityOk,
      integrityDetail: state.integrityDetail,
      /** ABSENT | HEALTHY | DAMAGED. The first thing to read on a snapshot from an incident. */
      storeCondition: state.condition,
      permissionWarnings: this.permissionWarnings,
      terminalWindows: Object.fromEntries(state.terminalWindows),
      openIntents: state.openIntents.map((intent) => ({
        seq: intent.seq,
        window: windowKey(intent.body),
        sessionId: intent.body.sessionId,
        rawTxHash: intent.body.rawTxHash,
        eoaNonce: intent.body.eoaNonce,
      })),
      degraded: state.degraded,
      counts: state.counts,
      ...extra,
    };
    const tmp = `${this.snapshotPath}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, "utf8"));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.snapshotPath);
    fsyncDir(this.dir);
  }

  /**
   * Closes the connection and releases the lock, so a clean restart works with no
   * flag. Release tolerates an already-gone lockfile.
   *
   * DURABILITY NEVER RESTS ON THIS. node:sqlite's close() with an open
   * transaction rolls back SILENTLY and does not throw (verified), so every write
   * path commits explicitly inside #tx or the data is gone with no error anywhere.
   */
  /**
   * Nothing can be behind: this store IS the only copy.
   *
   * Present so a plain Ledger satisfies JournalStore, and so the call before a
   * broadcast is unconditional — a check that exists only in one configuration
   * is a check nobody remembers is missing in the other.
   */
  assertDurable(): void {}

  /** No durable copy elsewhere. */
  get durableLocation(): string | null {
    return null;
  }

  /**
   * Never lost: a file has no connection to drop.
   *
   * Present for the same reason as `assertDurable` above — so a plain Ledger
   * satisfies JournalStore and the supervisor's check is unconditional rather
   * than one that quietly does not apply in this configuration.
   */
  get lost(): string | null {
    return null;
  }

  close(): void {
    if (this.#db !== null) {
      try {
        this.#db.close();
      } catch {
        /* already closed, or rolled back */
      }
      this.#db = null;
    }
    if (this.lockPath !== null) {
      try {
        unlinkSync(this.lockPath);
      } catch {
        /* already gone */
      }
    }
  }
}

const records = (read: JournalRead): readonly JournalRecord[] => read.records;

// ---------------------------------------------------------------------------
// Local eligibility: the rules that are a pure function of store state.
//
// These exist to avoid burning gas on a revert, and to refuse a replay one layer
// before the schema does. They are NOT the only authority — the schema's frontier
// constraints are, and they fire on the INTENT insert whether or not this
// function was consulted.
//
// THE ORDER IS ITSELF A GUARANTEE. Callers switch on `rule`: keeper.ts branches
// on PROGRESSION_L1 to tell an L1 range collapse from a replay, and
// bin/keeper.mts gives L1_RANGE_COLLAPSED its own exit code. Reordering silently
// changes the operator-visible reason code.
//
// IT CHANGED IN ONE PLACE, DELIBERATELY. PROGRESSION_L2 now runs BEFORE
// PROGRESSION_L1, because the epoch-INDEPENDENT L2 frontier is the replay rule
// and the epoch-SCOPED L1 mirror is only a revert predictor. That reordering is
// what makes L1_RANGE_COLLAPSED exact instead of heuristic: PROGRESSION_L1 can
// now only be reached when PROGRESSION_L2 already passed, so the window's L2
// range is provably above the settled frontier and it is provably NOT a replay.
// The old code had to guess at that with `lastEndBlockL2 > 0n`.
// ---------------------------------------------------------------------------
export type LocalEligibility =
  | { readonly ok: true }
  | { readonly ok: false; readonly rule: string; readonly detail: string };

export interface LocalCandidate extends WindowRef {
  readonly startBlockL1: bigint;
  readonly endBlockL1: bigint;
  readonly bindingEpoch: bigint;
  readonly sessionId: string;
}

export function localEligibility(
  state: LedgerState,
  candidate: LocalCandidate,
  limits: { readonly maxSettlementsPerDay: number },
  nowMs: number,
): LocalEligibility {
  if (state.degraded !== null) {
    return {
      ok: false,
      rule: "NOT_DEGRADED",
      detail: `halted at seq ${state.degraded.seq}: ${state.degraded.reason}. An operator must acknowledge it.`,
    };
  }

  // A store whose integrity is not intact is by definition not a complete record
  // of what this keeper did. Under the JSONL design this was TORN_TAIL. Under
  // ACID the specific failure mode is gone, but the general rule is the same:
  // if a record fails its integrity digest, if the seq run is not dense, or if
  // PRAGMA integrity_check does not say 'ok', nothing may be settled. Damage is
  // REPORTED, never repaired, and never truncated away.
  //
  // It now covers THREE things, not one: a record that fails its digest, a
  // DECISION TABLE that does not follow from the record stream (the settlement /
  // terminal_window / halt rows the dedup actually reads), and a store whose
  // condition is DAMAGED — empty, truncated, not a database, or missing tables.
  // The rule code is deliberately unchanged, because callers switch on it.
  if (!state.integrityOk) {
    return {
      ok: false,
      rule: "STORE_INTEGRITY",
      detail:
        `the store is ${state.condition} and its integrity is not intact, so it is not a complete record ` +
        `of what this keeper did: ${state.integrityDetail ?? "unknown"}. Nothing will be settled from it. ` +
        "Inspect with `keeper journal`; do not delete the state directory to clear this, run recovery " +
        "against the chain.",
    };
  }

  // A chain-adopted settlement whose L2 window could not be determined leaves the
  // frontier unknown, so "new session" and "replay" are genuinely
  // indistinguishable. Refusing is the safe direction; claiming lost revenue
  // would not be.
  if (state.coverageUnresolved > 0) {
    return {
      ok: false,
      rule: "COVERAGE_UNRESOLVED",
      detail:
        `${state.coverageUnresolved} settlement(s) adopted from the chain have no known L2 window, so the ` +
        "settled L2 frontier is unknown and a new session cannot be distinguished from a replay. " +
        "`keeper recover` shows what the chain says was settled; lower NUVEM_KEEPER_LOGS_FROM_BLOCK if the " +
        "scan cannot see the settlement's L2 range.",
    };
  }

  // SINGLE FLIGHT. One unresolved intent per account, ever, blocks EVERYTHING.
  // Two in flight would race each other for the same settlementNonce and one
  // would revert — after paying for the attempt. The schema enforces this too,
  // with a partial unique index; this is the polite half.
  if (state.openIntents.length > 0) {
    const intent = state.openIntents[0];
    return {
      ok: false,
      rule: "SINGLE_FLIGHT",
      detail: `intent at seq ${intent?.seq} for window ${intent ? windowKey(intent.body) : "?"} is unresolved`,
    };
  }

  // PROGRESSION_L2 — THE PRIMARY RULE, AND THE REPLAY RULE.
  //
  // Epoch-INDEPENDENT and content-independent, which is exactly what the old
  // epoch-keyed maps were not. It is also the only rule that survives a change to
  // how ledgerRoot is computed: a v3 root changes every sessionId, and an
  // exact-match rule alone would wave a re-settle straight through. `<=` because
  // the settled frontier is an INCLUSIVE end boundary — a new window must begin
  // strictly after it, which is the same thing the schema's CHECK says.
  if (state.settledFrontierL2 !== null && candidate.startBlockL2 <= state.settledFrontierL2) {
    return {
      ok: false,
      rule: "PROGRESSION_L2",
      detail:
        `startBlockL2 ${candidate.startBlockL2} <= the settled L2 frontier ${state.settledFrontierL2}. ` +
        "This window is already covered by a settlement, whatever its bindingEpoch or sessionId says.",
    };
  }
  // PROGRESSION_L1 — A REVERT PREDICTOR, NOT A SAFETY GUARD.
  //
  // A deliberate mirror of the vault's L1 range check, epoch-scoped BECAUSE THE
  // CONTRACT'S MAP IS. It exists to stop the keeper paying gas for a settle the
  // vault will refuse. Reaching it means PROGRESSION_L2 already passed, so the
  // window is provably new in L2 space — which is why keeper.ts can report this
  // as L1_RANGE_COLLAPSED (forfeited revenue) rather than as a duplicate.
  //
  // `<`, NOT `<=`, AND THAT IS THE WHOLE POINT OF THE REDEPLOY.
  //
  // The vault used to enforce session progression on the L1 range with a strict
  // increase. It now enforces progression on the L2 range and requires the L1
  // range only to be NON-DECREASING:
  //
  //     PersonalVault.acceptSettlement
  //       if (previousEndL2 != 0 && record.startBlockL2 <= previousEndL2)
  //           revert NonProgressiveBlockRange(...)
  //       if (previousEndL1 != 0 && record.startBlock  <  previousEndL1)
  //           revert NonProgressiveL1BlockRange(...)
  //
  // startBlockL1 == lastEndBlockL1 is the ROUND-TRIPPER CASE — a trader who
  // re-enters within the ~12s of one L1 block — and it is exactly what the
  // contract change exists to permit. A mirror that kept `<=` would keep
  // refusing those windows here, before the chain ever saw them, and the fix
  // would be invisible in production while looking correct on chain.
  //
  // Nothing is weakened by this. The replay property belongs entirely to
  // PROGRESSION_L2 above, which is unchanged, epoch-independent, and strictly
  // stronger: it refuses any window starting at or below the settled L2
  // frontier. This rule now catches only an L1 range that REWINDS under a
  // forward L2 range, which is an incoherent attestation rather than a replay —
  // the same distinction the contract draws by raising a separate error for it.
  const priorL1 = state.chainGuardL1.get(candidate.bindingEpoch.toString());
  if (priorL1 !== undefined && candidate.startBlockL1 < priorL1) {
    return {
      ok: false,
      rule: "PROGRESSION_L1",
      detail:
        `startBlockL1 ${candidate.startBlockL1} < lastEndBlockL1 ${priorL1} for bindingEpoch ` +
        `${candidate.bindingEpoch}, so PersonalVault.acceptSettlement would revert NonProgressiveL1BlockRange`,
    };
  }

  // NOVELTY. Mirrors usedSessions at PersonalVault.sol:548-549. Defence in depth
  // behind progression; case-insensitive throughout, because hex casing from
  // viem, decoded calldata and operator input all differ.
  if (state.settledSessionIds.has(candidate.sessionId.toLowerCase())) {
    return { ok: false, rule: "NOVELTY", detail: `sessionId ${candidate.sessionId} is already settled` };
  }

  const terminal = state.terminalWindows.get(windowKey(candidate));
  if (terminal !== undefined) {
    return { ok: false, rule: "TERMINAL", detail: `window was already terminal: ${terminal}` };
  }

  // A refused window advances no settlement boundary and never touches an L1 one,
  // but it does stop a slightly-different RE-CUT of the same refusal being densely
  // verified forever. Checked AFTER the exact-window TERMINAL rule so the exact
  // case keeps its own operator-facing reason code, which watch.ts and /status
  // both surface. `<` and not `<=`, because L2 windows are half-open at the start.
  if (state.refusedHighWaterL2 !== null && candidate.startBlockL2 < state.refusedHighWaterL2) {
    return {
      ok: false,
      rule: "PROGRESSION_L2",
      detail:
        `startBlockL2 ${candidate.startBlockL2} < the highest refused endBlockL2 ${state.refusedHighWaterL2}. ` +
        "A window that overlaps one already recorded terminal is not re-verified.",
    };
  }

  // The per-day circuit breaker. Only CONFIRMED and ADOPTED feed it — never
  // FAILED, never DRYRUN, never SKIPPED — and an unparseable timestamp is
  // EXCLUDED rather than counted as now, so a bad ts can neither silently disable
  // the breaker nor silently trip it.
  const dayAgo = nowMs - 24 * 60 * 60 * 1000;
  const recent = state.confirmedAtMs.filter((ms) => Number.isFinite(ms) && ms >= dayAgo).length;
  if (recent >= limits.maxSettlementsPerDay) {
    return {
      ok: false,
      rule: "RATE_LIMIT",
      detail: `${recent} settlements in the last 24h, limit ${limits.maxSettlementsPerDay}`,
    };
  }

  return { ok: true };
}
