// The loop. Wires discovery, verification, attestation, idempotency and
// submission together, and decides exactly once per tick what may happen.
//
// THE SHAPE OF A TICK, and why it is in this order:
//
//   1. eth_chainId, uncached, every tick.       Cheapest possible catastrophe.
//   2. eth_blockNumber + anchor block hash.     Reorg detection.
//   3. the vault snapshot.                      Everything the attestation binds.
//   4. recovery.                                No settle runs before it finishes.
//   5. discovery (sparse-cheap window).         Propose boundaries.
//   6. ONE dense verification.                  The only thing allowed to say
//                                               ATTESTABLE.
//   7. attest -> eligibility -> submit.         Sign late, broadcast later.
//   8. checkpoint + heartbeat.                  Silence becomes alertable.
//
// Step 1 looks paranoid and is not. viem asserts the chain id only on wallet
// writes, never on reads, so a testnet endpoint answers every read plausibly: no
// code at the factory means a zeroed struct, which reads as "not configured"
// rather than as an error. The repo's own .env legitimately contains
// RH_TESTNET_RPC_URL. A keeper that signed against that would produce confident
// nonsense.
//
// Step 6 is deliberately ONE per tick. A backlog drains oldest-first, which is
// also what keeps the vault's monotone-progression guard satisfiable: settle a
// later window first and every earlier one is foreclosed forever.

import type { Hex } from "viem";
import type { JournalStore } from "./journal-store.js";
import { buildAttestation, fabricatableInputs, type AttesterSigner } from "./attest.js";
import { describeConfig, type KeeperConfig } from "./config.js";
import { buildSessionReport, type RpcClient, type SessionReport } from "./engine.js";
import {
  Ledger,
  LedgerConstraintError,
  LedgerWriteError,
  experimentalWarnings,
  localEligibility,
  windowKey,
  type ConfirmedBody,
  type FailedBody,
  type JournalRecord,
  type LedgerState,
  type SkippedBody,
  type SkipReason,
} from "./ledger.js";
import { summarizeUpstreamError, type Logger } from "./log.js";
import type { ChainAccess, SettlementAttestation } from "./onchain.js";
import { chainEligibility, reconcile, type ReconcileInput, type ReconcileResult } from "./reconcile.js";
import { describePlan, submitSettlement, type SettlePlan, type TradingSigner } from "./submit.js";
import { discoverSessions, planTick, tickScanBounds, verifyRequestFor } from "./watch.js";

export interface KeeperDeps {
  readonly config: KeeperConfig;
  readonly chain: ChainAccess;
  /** The engine's JSON-RPC client, used only by the scanner. */
  readonly rpc: RpcClient;
  readonly ledger: JournalStore;
  readonly logger: Logger;
  readonly attesterSigner: AttesterSigner | null;
  readonly tradingSigner: TradingSigner | null;
  readonly now?: () => Date;
  /** Reports RPC calls made this tick, for the budget guard. */
  readonly rpcCalls?: () => number;
}

export type TickOutcome =
  | "CHAIN_MISMATCH"
  | "DEGRADED"
  | "REORG"
  | "IDLE"
  | "OPEN_SESSION"
  | "NO_CANDIDATE"
  | "REFUSED"
  | "SKIPPED"
  /**
   * A genuinely new L2 session that the protocol's L1-only block range can never
   * accept. Its own outcome because it is REVENUE LOST, not a duplicate — see
   * L1_COLLAPSE_NOTE.
   */
  | "L1_RANGE_COLLAPSED"
  | "DEFERRED"
  | "BLOCKED"
  | "DRY_RUN"
  | "SETTLED"
  | "SETTLE_FAILED"
  | "UNRESOLVED"
  /**
   * The STORE refused a write. It means a candidate got as far as being recorded
   * that the schema can prove is a replay, a second in-flight settlement or a
   * reused settlementNonce — i.e. the application logic was wrong and the
   * database caught it. Its own outcome because it used to arrive as RPC_ERROR,
   * which is the one label that says "retry in 30s".
   */
  | "STORE_REFUSED"
  | "RPC_ERROR"
  | "BUDGET_EXHAUSTED";

/**
 * The reconciliation contract this file depends on, written down here because
 * reconcile.ts is owned separately and the two halves have to meet somewhere
 * explicit rather than by accident.
 *
 * `unaccountedNonces` is reconciliation's veto: vault settlement nonces the chain
 * says were consumed that the journal still cannot name after adoption. Anything
 * other than an empty list means the keeper does not know the whole settled
 * history, and runTick refuses before any attestation is built. `refusal` is
 * accepted as an alternative shape for the same statement. Both are optional in
 * this local type so this file compiles against reconcile.ts before and after the
 * other half lands; neither is trusted as the ONLY guard — see the cold-start
 * gate in runTick.
 */
export type RecoveryRequest = ReconcileInput;

export type RecoveryOutcome = ReconcileResult & {
  readonly unaccountedNonces?: readonly bigint[];
  readonly refusal?: { readonly reason: string; readonly detail: string } | null;
};

export interface TickResult {
  readonly tickId: string;
  readonly outcome: TickOutcome;
  readonly detail?: string;
  readonly headBlockL2?: bigint;
  readonly anchorBlockL2?: bigint;
  readonly plan?: SettlePlan;
  readonly report?: SessionReport;
  /** Set on SETTLED: the confirmed settlement tx, for the read-model writer. */
  readonly txHash?: `0x${string}`;
  /** Set on SETTLED: the L2 block the settlement landed in. */
  readonly settledBlockL2?: bigint;
}

let tickCounter = 0;
const nextTickId = (): string => `tick-${Date.now().toString(36)}-${(tickCounter++).toString(36)}`;

/** How far to rewind the anchor when the anchor block's hash no longer matches. */
const REORG_REWIND_MULTIPLE = 8n;

// ---------------------------------------------------------------------------
// A REVERT IS NOT A REASON TO TRY AGAIN
//
// A settle that reverts costs real gas, consumes the EOA nonce, and moves no
// money. There used to be no backoff, no attempt counter and no breaker: the
// FAILED branch returned without checkpointing, so the anchor did not advance,
// the same session was rediscovered on the next poll, and any persistent cause
// re-signed and rebroadcast every `pollMs` — ~2,880 attempts a day, forever, on
// the trader's own balance.
//
// So each failure is now classified, and the two classes get opposite treatment:
//
//   PERMANENT. The vault has decided something about this window that no amount
//   of waiting changes. Record it terminal and never offer it again.
//
//   TRANSIENT. A nonce race, an underpriced replacement, an RPC failure, or a
//   revert that no longer reproduces. Retry, but on an exponential backoff with
//   a cap, and trip a latching breaker after a few consecutive failures so a
//   human is forced to look before more gas is spent.
//
// The classification is done on the RAW error text, in memory, and the ONLY
// thing derived from it that is ever emitted is a name from the fixed table
// below — so a viem error's endpoint annotation cannot ride out on this path.
// ---------------------------------------------------------------------------

/**
 * Reverts that will never succeed on retry, and the honest `SkipReason` for
 * each. Every one of these is a statement about history or configuration, not
 * about timing.
 */
const PERMANENT_REVERTS: readonly (readonly [string, SkipReason])[] = [
  // NonProgressiveBlockRange is raised on the L2 range, which is where session
  // progression now lives (PersonalVault.sol:65-69). An L2 collision is a
  // GENUINE REPLAY, not the old L1-granularity forfeit — the contract keeps the
  // two apart under distinct errors precisely so an operator can tell them
  // apart, and labelling this one L1_RANGE_COLLAPSED would tell them the
  // opposite: "revenue lost, nothing to do" instead of "the local store and the
  // chain disagree about what has already been settled", which is the one that
  // needs looking at.
  //
  // Reaching this map at all means the LOCAL progression check passed and the
  // chain refused anyway, so the store is behind. The L1 case has its own
  // handled path further down (search L1_COLLAPSE_NOTE) and never arrives here.
  ["NonProgressiveBlockRange", "ALREADY_SETTLED"],
  ["NonProgressiveL1BlockRange", "L1_RANGE_COLLAPSED"],
  ["SessionAlreadyUsed", "ALREADY_SETTLED"],
  ["ContributionBelowMinimum", "BELOW_MINIMUM"],
  // Something else settled. The nonce is a compare-and-swap token, so the
  // signed attestation is dead; a fresh one has to be built from a fresh read.
  ["InvalidSettlementNonce", "ALREADY_SETTLED"],
  // Rebound, revoked or paused since the attestation was signed.
  ["InvalidAccountState", "BINDING_EPOCH_ADVANCED"],
];

export type RevertClass =
  | { readonly kind: "PERMANENT"; readonly revert: string; readonly skipReason: SkipReason }
  | { readonly kind: "TRANSIENT" };

/** Raw error text for classification only. Never emitted, never stored. */
function rawErrorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const extra = error as Error & { shortMessage?: string; metaMessages?: string[] };
  return [error.name, error.message, extra.shortMessage ?? "", ...(extra.metaMessages ?? [])].join("\n");
}

export function classifyRevert(error: unknown): RevertClass {
  const text = rawErrorText(error);
  for (const [revert, skipReason] of PERMANENT_REVERTS) {
    if (text.includes(revert)) return { kind: "PERMANENT", revert, skipReason };
  }
  return { kind: "TRANSIENT" };
}

/** Reverts for one window before it is abandoned. Two is already conclusive. */
const MAX_REVERTS_PER_WINDOW = 2;
/** Consecutive reverts, across any windows, before the keeper latches DEGRADED. */
const BREAKER_CONSECUTIVE_REVERTS = 3;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_CAP_MS = 30 * 60_000;

/** Exponential, capped. Attempt 1 waits a minute, attempt 6 waits half an hour. */
export function revertBackoffMs(attempts: number): number {
  if (attempts <= 0) return 0;
  const scaled = BACKOFF_BASE_MS * 2 ** Math.min(attempts - 1, 20);
  return Math.min(scaled, BACKOFF_CAP_MS);
}

export interface WindowFailures {
  readonly attempts: number;
  readonly lastAtMs: number;
  readonly lastReason: string;
}

export interface FailureHistory {
  readonly perWindow: ReadonlyMap<string, WindowFailures>;
  /** FAILED records since the last CONFIRMED/ADOPTED. The breaker's input. */
  readonly consecutive: number;
}

/**
 * Counts reverts per window from the raw record stream.
 *
 * Read from the record stream rather than from `LedgerState` because the derived
 * state deliberately records no progress for a FAILED record — a revert moved no
 * money, so it must not advance any boundary — and the attempt counter is the
 * one thing that does have to survive it. This is exactly why the store keeps a
 * public, ordered, side-effect-free record query even though the settlement table
 * is what enforces the rules.
 */
export function failureHistory(ledger: JournalStore): FailureHistory {
  const perWindow = new Map<string, WindowFailures>();
  let consecutive = 0;
  const { records } = ledger.readRecords();
  for (const record of records) {
    if (record.type === "FAILED") {
      const body = record.body as FailedBody;
      const key = windowKey(body);
      const prior = perWindow.get(key);
      perWindow.set(key, {
        attempts: (prior?.attempts ?? 0) + 1,
        lastAtMs: Date.parse(record.ts),
        lastReason: body.reason,
      });
      consecutive += 1;
    } else if (record.type === "CONFIRMED" || record.type === "ADOPTED") {
      consecutive = 0;
    }
  }
  return { perWindow, consecutive };
}

/**
 * CONFIRMED plus ADOPTED: settlements this store can actually account for.
 *
 * Taken from the settlement table rather than from the record stream, because the
 * settlement table is the one the frontier constraints police — and because a
 * record row that failed its integrity digest is not admitted, which would
 * otherwise silently lower this count.
 */
const settlementRecordCount = (state: LedgerState): number => state.settlementCount;

const journalContribution = (state: LedgerState): bigint => state.settledContributionWei;

/**
 * Why an L1 range collision is its own outcome and not "already settled".
 *
 * The attestation commits an L1 block range and the vault's monotone guard is in
 * L1 space, but sessions are detected in L2 space and MANY L2 blocks map to one
 * L1 block — measured between 64:1 and 120:1 on this chain, and the ratio is not
 * constant. So two genuinely distinct sessions minutes apart can land inside one
 * already-consumed L1 block, and the vault will refuse the second one forever.
 *
 * That is a REAL LOSS of the operator's savings, not a duplicate being caught,
 * and calling it ALREADY_SETTLED buried it under the one label an operator will
 * never investigate. It is reported here, loudly and countably, and it is NOT
 * worked around: settling it would need the attestation schema to carry the L2
 * range, which is a contract change.
 */
const L1_COLLAPSE_NOTE =
  "The attestation now commits the L2 range as well as the L1 one, and the vault progresses on L2, so " +
  "the ordinary many-L2-blocks-to-one-L1-block collapse no longer forfeits anything: two sessions inside " +
  "one L1 block both settle. Reaching this outcome therefore no longer means 'the schema is too coarse'. " +
  "It means this window's L1 range RUNS BACKWARDS relative to the last settled one while its L2 range runs " +
  "forwards, which is incoherent — the L2->L1 map is monotone, so an honest pair cannot do that. Suspect " +
  "the L1 heights the report derived (session-engine's toL1Block) or an adopted boundary, not the trader.";

export async function runTick(deps: KeeperDeps): Promise<TickResult> {
  const { config, chain, ledger, logger: rootLogger } = deps;
  const tickId = nextTickId();
  const logger = rootLogger.child({ tickId });
  const startedAt = Date.now();
  const callsAtStart = deps.rpcCalls?.() ?? 0;
  const nowMs = (): number => (deps.now?.() ?? new Date()).getTime();

  const finish = (result: TickResult): TickResult => {
    // Exactly one heartbeat per tick, at info, even when nothing happened. The
    // failure mode a keeper actually has is not crashing loudly, it is quietly
    // doing nothing — so silence has to be the alertable condition.
    logger.info("tick", {
      outcome: result.outcome,
      detail: result.detail,
      headBlockL2: result.headBlockL2?.toString(),
      anchorBlockL2: (result.anchorBlockL2 ?? ledger.state.anchorBlockL2)?.toString(),
      inFlight: ledger.state.openIntents.length,
      degraded: ledger.state.degraded?.reason ?? null,
      journalSeq: ledger.state.seq,
      journalHead: ledger.state.head,
      rpcCalls: (deps.rpcCalls?.() ?? 0) - callsAtStart,
      durationMs: Date.now() - startedAt,
    });
    return result;
  };

  try {
    // ---- 0. THE STORE ITSELF, BEFORE THE CHAIN -----------------------------
    //
    // A DAMAGED store — zero bytes, truncated, not a database, missing the tables
    // the dedup reads — is refused here, first, before a single RPC call and long
    // before anything is signed. localEligibility would refuse it later with
    // STORE_INTEGRITY and append() would refuse the INTENT that must precede any
    // broadcast, so this is the third net rather than the only one; it exists so
    // the refusal is a clean verdict at the top of the tick instead of an
    // exception thrown from somewhere in the middle of one.
    //
    // Deliberately gated on `condition`, not on `integrityOk`. A tampered row in a
    // structurally sound file still walks the full path and refuses where it
    // always did, which keeps every existing reason code where callers expect it.
    const condition = ledger.state.condition;
    if (condition === "DAMAGED") {
      const detail =
        `STORE_DAMAGED: ${ledger.state.integrityDetail ?? "the store could not be read"}`;
      logger.error("the store is damaged; refusing to do anything with it", {
        decision: "HALT",
        reasonCode: "STORE_DAMAGED",
        storeCondition: condition,
        store: ledger.journalPath,
        detail,
      });
      return finish({ tickId, outcome: "STORE_REFUSED", detail });
    }

    // ---- 1. the chain ------------------------------------------------------
    const observedChainId = await chain.getChainId();
    if (observedChainId !== config.chainId) {
      return finish({
        tickId,
        outcome: "CHAIN_MISMATCH",
        detail: `RPC reports chainId ${observedChainId}, expected ${config.chainId}. Aborting the tick.`,
      });
    }

    const headBlockL2 = await chain.getHeadBlockL2();

    // ---- 2. reorg detection ------------------------------------------------
    const state0 = ledger.state;
    if (state0.anchorBlockL2 !== null && state0.anchorBlockHash !== null) {
      const hash = await chain.getBlockHash(state0.anchorBlockL2);
      if (hash !== null && hash.toLowerCase() !== state0.anchorBlockHash.toLowerCase()) {
        const rewind = config.limits.finalityMarginL2 * REORG_REWIND_MULTIPLE;
        const rewound = state0.anchorBlockL2 > rewind ? state0.anchorBlockL2 - rewind : 0n;
        logger.warn("anchor block hash changed: treating as a reorg", {
          anchorBlockL2: state0.anchorBlockL2.toString(),
          expectedHash: state0.anchorBlockHash,
          observedHash: hash,
          rewoundTo: rewound.toString(),
        });
        // Re-verify every settlement the journal believes in. One that has
        // vanished must halt: it is not safe to re-settle (it may still be in a
        // rebuilt block) and not safe to ignore (the money may never have moved).
        const vanished = await findVanishedSettlements(chain, state0.confirmedRecords);
        if (vanished.length > 0) {
          await ledger.append("DEGRADED", {
            reason: "SETTLEMENT_VANISHED_IN_REORG",
            detail: `settlements no longer on chain after a reorg: ${vanished.join(", ")}`,
          });
          return finish({ tickId, outcome: "DEGRADED", detail: "a confirmed settlement vanished in a reorg", headBlockL2 });
        }
        const rewoundHash = await chain.getBlockHash(rewound);
        await ledger.append("CHECKPOINT", {
          anchorBlockL2: rewound,
          anchorBlockHash: rewoundHash ?? "0x",
          headBlockL2,
        });
        ledger.writeSnapshot();
        return finish({ tickId, outcome: "REORG", headBlockL2, anchorBlockL2: rewound });
      }
    }

    // ---- 3. the vault snapshot ---------------------------------------------
    const snapshot = await chain.readVaultSnapshot(config.account);

    // ---- 4. recovery. It runs BEFORE the header is written, and it may refuse.
    //
    // THE HEADER USED TO BE WRITTEN HERE, seeded from the CHAIN's current
    // settlementNonce, and that single line was the state-loss blind spot. On a
    // wiped volume it declared "the chain was already at nonce N and that is our
    // baseline", which made reconcile's `expected == observed` and stopped it
    // from ever enumerating chain history. Every idempotency map stayed empty,
    // `nonceReconciled` came back TRUE, and both eligibility gates waved through
    // a window that was already settled — a signed, broadcast duplicate in live
    // mode, stopped only by the vault's own revert.
    //
    // Reconciliation therefore runs first, on a journal that has not yet been
    // told anything, and nothing is written and nothing is attested until it has
    // had its chance to object. The baseline is written afterwards, DERIVED from
    // what reconciliation actually accounted for (below) rather than assumed.
    const recoveryRequest: RecoveryRequest = {
      chain,
      ledger,
      logger,
      account: config.account,
      snapshot,
      logsFromBlockL2: config.logsFromBlockL2,
    };
    // CONTRACT WITH reconcile.ts, because the ordering change moves the ground
    // under one of its lines: with no HEADER written yet, any
    // `header?.baselineSettlementNonce ?? <fallback>` fallback now decides the
    // cold-start case on its own, and the only safe fallback is ZERO — "assume
    // nothing is accounted for". The live nonce as a fallback is precisely the
    // bug this reordering exists to remove, because it makes the journal agree
    // with the chain by construction.
    const recovery: RecoveryOutcome = await reconcile(recoveryRequest);

    // The latch first, because when reconciliation halts it writes a far better
    // explanation than anything that can be reconstructed from its return value.
    if (ledger.state.degraded !== null) {
      return finish({
        tickId,
        outcome: "DEGRADED",
        detail: `${ledger.state.degraded.reason}: ${ledger.state.degraded.detail}`,
        headBlockL2,
      });
    }
    // Then reconciliation's veto, for the case where it reports a shortfall
    // without latching. Honoured before the header exists and before anything is
    // attested.
    const unaccounted = recovery.unaccountedNonces ?? [];
    const refusal =
      recovery.refusal ??
      (unaccounted.length > 0
        ? {
            reason: "UNACCOUNTED_SETTLEMENTS",
            detail:
              `the chain has consumed settlement nonce(s) ${unaccounted.join(", ")} that this journal ` +
              "cannot name. The block boundary of each is needed to refuse a replay and cannot be read " +
              "back from the vault, so nothing will be attested until recovery accounts for them.",
          }
        : null);
    if (refusal !== null) {
      logger.error("recovery refused to proceed", refusal);
      return finish({
        tickId,
        outcome: "DEGRADED",
        detail: `${refusal.reason}: ${refusal.detail}`,
        headBlockL2,
      });
    }

    // ---- 4b. THE COLD START GATE -------------------------------------------
    //
    // "No local record" is never permission to read "nothing was settled". If
    // the chain says this account has settled at least once and the journal holds
    // no CONFIRMED and no ADOPTED record, then the last settled boundary is
    // unknown — and it cannot be read back from the vault, because
    // `lastEndBlock` has no public getter. Progression, the primary idempotency
    // rule, has nothing to compare against, and sessionId novelty cannot cover
    // for it: a re-derivation under a newer ledgerRoot produces a DIFFERENT
    // sessionId for the very same settled window, so the indexed-log lookup
    // finds nothing.
    //
    // Not latched as DEGRADED. This is a recoverable condition — reconciliation
    // adopting the history, or an operator fixing NUVEM_KEEPER_LOGS_FROM_BLOCK
    // so the enumeration can see it — and latching would turn a fixable
    // misconfiguration into an acknowledgement ceremony. It refuses on every
    // tick, loudly, for as long as it holds.
    const settledInJournal = settlementRecordCount(ledger.state);
    if (settledInJournal === 0 && snapshot.settlementNonce > 0n) {
      const detail =
        `COLD_START_UNACCOUNTED: the chain reports settlementNonce ${snapshot.settlementNonce} for ` +
        `${config.account} and this journal holds no CONFIRMED or ADOPTED record, so the last settled ` +
        "block boundary is unknown and cannot be read back from the vault. Refusing to attest anything: " +
        "an empty journal against a non-zero settlementNonce is the one case where absence of a local " +
        "record must never be read as absence of a settlement. Run `keeper recover` to see what the " +
        "chain says was settled, and check NUVEM_KEEPER_LOGS_FROM_BLOCK is at or below the vault's " +
        "deployment era so the enumeration can find it.";
      logger.error("cold start with unaccounted settlement history; refusing to settle", {
        reasonCode: "COLD_START_UNACCOUNTED",
        observedSettlementNonce: snapshot.settlementNonce.toString(),
        journalSettlementRecords: settledInJournal,
        logsFromBlockL2: config.logsFromBlockL2.toString(),
        lifetimeContribution: snapshot.lifetimeContribution.toString(),
        adopted: recovery.adopted,
      });
      return finish({ tickId, outcome: "DEGRADED", detail, headBlockL2 });
    }

    // Only now, with history accounted for, is a baseline safe to write. It is
    // arithmetic, not an assumption: baseline + (settlements the journal knows
    // about) == the nonce the chain reports, which is exactly the invariant
    // reconcile checks, so this can never make the two disagree.
    const baselineNonce = snapshot.settlementNonce - BigInt(settledInJournal);
    const baselineContribution = snapshot.lifetimeContribution - journalContribution(ledger.state);
    await ledger.ensureHeader({
      settlementNonce: baselineNonce < 0n ? 0n : baselineNonce,
      lifetimeContribution: baselineContribution < 0n ? 0n : baselineContribution,
    });
    if (ledger.state.openIntents.length > 0) {
      return finish({
        tickId,
        outcome: "UNRESOLVED",
        detail: "an intent is still in flight; nothing else may be settled",
        headBlockL2,
      });
    }

    // ---- 5. discovery ------------------------------------------------------
    const anchor = ledger.state.anchorBlockL2 ?? config.fromBlockL2;
    const bounds = tickScanBounds({
      anchorBlockL2: anchor,
      headBlockL2,
      finalityMarginL2: config.limits.finalityMarginL2,
      maxTickScanSpanBlocks: config.limits.maxTickScanSpanBlocks,
    });
    if (bounds.kind === "IDLE") {
      return finish({ tickId, outcome: "IDLE", headBlockL2, anchorBlockL2: anchor });
    }
    // Being behind is a REPORTED STATE, not a failure. It says this tick answers
    // about a window that ends before the chain does, so a quiet outcome here
    // means "nothing in the part I have caught up to" and not "nothing at all".
    if (bounds.behindBy > 0n) {
      logger.info("catching up", {
        behindBy: bounds.behindBy.toString(),
        scanningTo: bounds.bounds.toBlockL2.toString(),
        headBlockL2: headBlockL2.toString(),
      });
    }

    const discovered = await discoverSessions(deps.rpc, config.account, bounds.bounds);
    const plan = planTick({
      sessions: discovered.sessions,
      openStatus: discovered.openStatus,
      scannedTo: bounds.bounds.toBlockL2,
      anchorBlockL2: anchor,
      maxVerifySpanBlocks: config.limits.maxVerifySpanBlocks,
      terminalWindows: ledger.state.terminalWindows,
    });

    for (const wide of plan.tooWide) {
      await ledger.append("SKIPPED", {
        startBlockL2: wide.startBlockL2,
        endBlockL2: wide.endBlockL2,
        reason: "SPAN_TOO_WIDE",
        detail:
          `${wide.endBlockL2 - wide.startBlockL2} L2 blocks exceeds ` +
          `NUVEM_KEEPER_MAX_VERIFY_SPAN_BLOCKS (${config.limits.maxVerifySpanBlocks}). Not split: a ` +
          "sub-window is not flat-to-flat and would refuse anyway.",
      });
      logger.warn("session too wide to verify", { window: windowKey(wide), spanBlocks: (wide.endBlockL2 - wide.startBlockL2).toString() });
    }

    const advanceAnchor = (handledCount: number): bigint => {
      const remaining = plan.candidates.slice(handledCount);
      let target = plan.nextAnchorL2;
      // Hold the watermark before anything not yet handled, or the next tick
      // would never see it again.
      if (remaining.length > 0) {
        const firstRemaining = remaining[0];
        if (firstRemaining && firstRemaining.startBlockL2 < target) target = firstRemaining.startBlockL2;
      }
      return target;
    };

    const checkpoint = async (handledCount: number): Promise<bigint> => {
      const target = advanceAnchor(handledCount);
      if (target !== anchor || ledger.state.anchorBlockHash === null) {
        const hash = await chain.getBlockHash(target);
        await ledger.append("CHECKPOINT", { anchorBlockL2: target, anchorBlockHash: hash ?? "0x", headBlockL2 });
      }
      ledger.writeSnapshot({
        recovery: {
          nonceReconciled: recovery.nonceReconciled,
          expectedSettlementNonce: recovery.expectedSettlementNonce.toString(),
          observedSettlementNonce: recovery.observedSettlementNonce.toString(),
        },
      });
      return target;
    };

    // An open session already wider than the dense verifier's limit can never
    // settle, wherever it closes — and pinning the anchor to it froze the scan
    // window on the same 30k blocks forever while the trader kept trading.
    // Journaled with the scan edge as the honest "at least this wide" boundary,
    // BEFORE any checkpoint so the record precedes the anchor that jumps it, and
    // deduped against terminalWindows because the anchor can be held back by an
    // unhandled candidate for a tick or two, re-detecting the same abandonment.
    if (plan.abandonedOpen !== null) {
      const { startBlockL2, scannedTo, openTokens } = plan.abandonedOpen;
      const key = windowKey({ startBlockL2, endBlockL2: scannedTo });
      if (ledger.state.terminalWindows.get(key) === undefined) {
        await ledger.append("SKIPPED", {
          startBlockL2,
          endBlockL2: scannedTo,
          reason: "SPAN_TOO_WIDE",
          detail:
            `open session from ${startBlockL2} still held ${openTokens.length} position(s) at ${scannedTo}, ` +
            `already ${scannedTo - startBlockL2} L2 blocks — wider than ` +
            `NUVEM_KEEPER_MAX_VERIFY_SPAN_BLOCKS (${config.limits.maxVerifySpanBlocks}) wherever it closes. ` +
            `Abandoned so the scan can advance; held: ${openTokens.join(", ")}`,
        });
        logger.warn("abandoning an open session too wide to ever verify", {
          openFromL2: startBlockL2.toString(),
          scannedTo: scannedTo.toString(),
          spanSoFarBlocks: (scannedTo - startBlockL2).toString(),
          openTokens,
        });
      }
    }

    if (plan.candidates.length === 0) {
      if (plan.abandonedOpen !== null) {
        const target = await checkpoint(0);
        return finish({
          tickId,
          outcome: "SKIPPED",
          detail:
            `abandoned an open session from ${plan.abandonedOpen.startBlockL2}: already wider than the ` +
            "verifier's limit, so its trades can never settle; resuming the scan past it",
          headBlockL2,
          anchorBlockL2: target,
        });
      }
      const target = await checkpoint(0);
      const outcome: TickOutcome = discovered.openStatus.state === "OPEN" ? "OPEN_SESSION" : "NO_CANDIDATE";
      return finish({
        tickId,
        outcome,
        detail:
          discovered.openStatus.state === "OPEN"
            ? `a session is open from ${discovered.openStatus.startBlockL2}; ${discovered.openStatus.openTokens.length} position(s) still held`
            : `${discovered.transactions.length} transaction(s) scanned, no closed session`,
        headBlockL2,
        anchorBlockL2: target,
      });
    }

    // ---- 6. ONE dense verification ----------------------------------------
    const session = plan.candidates[0];
    if (!session) {
      const target = await checkpoint(0);
      return finish({ tickId, outcome: "NO_CANDIDATE", headBlockL2, anchorBlockL2: target });
    }
    // ---- 5b. reverts this window has already suffered ----------------------
    //
    // Checked HERE, before the dense verification and before anything is signed,
    // because the whole point is to stop spending on a window that has already
    // told us no. A revert costs gas, consumes the EOA nonce and moves nothing;
    // the old code recorded no attempt count, marked nothing terminal and did not
    // checkpoint, so a persistently-reverting cause was re-signed and rebroadcast
    // every poll — ~2,880 attempts a day on the trader's own balance.
    const failures = failureHistory(ledger);
    const windowLogger = logger.child({
      window: windowKey(session),
      windowL2: [session.startBlockL2.toString(), session.endBlockL2.toString()],
    });
    if (failures.consecutive >= BREAKER_CONSECUTIVE_REVERTS) {
      const detail =
        `${failures.consecutive} consecutive settle attempts reverted with no settlement in between. ` +
        "Latching rather than continuing: every attempt costs the trading account real gas, and a cause " +
        "that has produced three reverts is a cause a human has to look at. Read the FAILED and SKIPPED " +
        "records at the tail of the journal, then clear this with --acknowledge-degraded <seq>.";
      await ledger.append("DEGRADED", { reason: "REVERT_BREAKER", detail });
      windowLogger.error("revert breaker tripped; halting", {
        decision: "HALT",
        reasonCode: "REVERT_BREAKER",
        detail,
        consecutiveReverts: failures.consecutive,
      });
      return finish({ tickId, outcome: "DEGRADED", detail: `REVERT_BREAKER: ${detail}`, headBlockL2 });
    }
    const priorFailures = failures.perWindow.get(windowKey(session));
    if (priorFailures !== undefined) {
      if (priorFailures.attempts >= MAX_REVERTS_PER_WINDOW) {
        const detail =
          `REVERT_LIMIT: ${priorFailures.attempts} settle attempts for this window have reverted (last: ` +
          `${priorFailures.lastReason}). A settle that reverts twice for the same window is not going to ` +
          "succeed by being retried a third time, so the window is recorded terminal and will not be " +
          "offered again. Investigate the revert; do not delete the journal to clear it.";
        windowLogger.error("window abandoned after repeated reverts", {
          decision: "SKIP",
          reasonCode: "REVERT_LIMIT",
          detail,
          attempts: priorFailures.attempts,
        });
        await ledger.append("SKIPPED", {
          startBlockL2: session.startBlockL2,
          endBlockL2: session.endBlockL2,
          reason: "REFUSED",
          detail,
        });
        const target = await checkpoint(1);
        return finish({ tickId, outcome: "SKIPPED", detail, headBlockL2, anchorBlockL2: target });
      }
      const backoff = revertBackoffMs(priorFailures.attempts);
      const nextEligibleAtMs = priorFailures.lastAtMs + backoff;
      if (Number.isFinite(nextEligibleAtMs) && nowMs() < nextEligibleAtMs) {
        const detail =
          `REVERT_BACKOFF: ${priorFailures.attempts} prior revert(s) for this window; waiting ` +
          `${Math.max(0, Math.round((nextEligibleAtMs - nowMs()) / 1000))}s more of a ` +
          `${Math.round(backoff / 1000)}s backoff before another attempt.`;
        windowLogger.warn("backing off after a reverted settle", {
          decision: "DEFER",
          reasonCode: "REVERT_BACKOFF",
          detail,
          attempts: priorFailures.attempts,
          backoffMs: backoff,
          nextEligibleAtMs,
        });
        // No checkpoint: the window is still one we intend to settle.
        return finish({ tickId, outcome: "DEFERRED", detail, headBlockL2 });
      }
    }

    const request = verifyRequestFor(session);
    const report = await buildSessionReport({ rpc: deps.rpc, wallet: config.account, ...request });

    // Refusals and defers log at the SAME fidelity as settlements, which is why
    // identity, policy and authority all live on the child logger rather than
    // only on the settle path. If a refusal logs less than a settlement, the
    // operator's instinct becomes "make the refusal go away".
    const decisionLogger = logger.child({
      window: windowKey(session),
      // Both spaces, always, and always labelled. Conflating them produced a real
      // InvalidBlockRange revert earlier in this project.
      windowL2: [session.startBlockL2.toString(), session.endBlockL2.toString()],
      windowL1: [report.startBlockL1.toString(), report.endBlockL1.toString()],
      vault: config.vault,
      executor: config.executor,
      bindingEpoch: snapshot.bindingEpoch.toString(),
      policyNonce: snapshot.policyNonce.toString(),
      settlementNonce: snapshot.settlementNonce.toString(),
      policyHash: snapshot.policyHash,
      savingsBps: snapshot.policy.savingsBps,
      // The attester ADDRESS is logged loudly and often: it is public, it is the
      // thing being held accountable, and a mismatch against the registry is a
      // top failure mode. The key is never logged anywhere, by construction.
      attester: deps.attesterSigner?.address ?? null,
      attesterEpoch: snapshot.attesterEpoch,
      attesterMatchesRegistry:
        deps.attesterSigner === null
          ? null
          : snapshot.registeredAttester.toLowerCase() === deps.attesterSigner.address.toLowerCase(),
    });

    const engineFields = {
      ...fabricatableInputs(report),
      realizedProfit: report.realizedProfit.toString(),
      naiveDelta: report.naiveDelta.toString(),
      residualWei: report.reconciliation.residualWei.toString(),
      gasPaid: report.gasPaid.toString(),
      zeroBasisRealized: report.zeroBasisRealized.toString(),
      positionsRoot: report.positionsRoot,
      ledgerRootV2: report.ledgerRootV2,
      replayStartBlockL2: report.replayStartBlockL2.toString(),
      verdict: report.verdict,
      reasons: report.reasons,
      txCount: report.transactions.length,
      txKinds: histogram(report.transactions.map((tx) => tx.kind)),
    };

    if (report.verdict !== "ATTESTABLE") {
      // A refused window is the normal, healthy outcome. It logs at the SAME
      // fidelity as a settlement on purpose: if refusals log less, the operator's
      // instinct becomes "make the refusal go away", which is the wrong instinct.
      await ledger.append("SKIPPED", {
        startBlockL2: session.startBlockL2,
        endBlockL2: session.endBlockL2,
        reason: "REFUSED",
        detail: report.reasons.join(", "),
        engineReasons: report.reasons,
        endBlockL1: report.endBlockL1,
        bindingEpoch: snapshot.bindingEpoch,
      });
      decisionLogger.info("engine refused the window; not settling", {
        decision: "REFUSE",
        reasonCode: "REFUSED",
        ...engineFields,
      });
      const target = await checkpoint(1);
      return finish({ tickId, outcome: "REFUSED", detail: report.reasons.join(", "), headBlockL2, anchorBlockL2: target, report });
    }

    // ---- 7. attest, check eligibility, submit ------------------------------
    if (deps.attesterSigner === null) {
      return finish({ tickId, outcome: "BLOCKED", detail: "no attester signer is loaded", headBlockL2 });
    }

    const currentL1Block = await chain.getL1BlockNumber(headBlockL2);
    const attested = await buildAttestation({
      chain,
      signer: deps.attesterSigner,
      report,
      snapshot,
      chainId: config.chainId,
      account: config.account,
      vault: config.vault,
      executor: config.executor,
      currentL1Block,
      limits: config.limits,
    });

    if (attested.kind === "REFUSED") {
      // Unreachable given the check above, kept because the invariant matters
      // more than the reachability: nothing signs a refused report.
      return finish({ tickId, outcome: "REFUSED", detail: attested.reasons.join(", "), headBlockL2, report });
    }
    if (attested.kind === "SKIP") {
      await ledger.append("SKIPPED", {
        startBlockL2: session.startBlockL2,
        endBlockL2: session.endBlockL2,
        reason: attested.reason,
        detail: attested.detail,
        endBlockL1: report.endBlockL1,
        bindingEpoch: snapshot.bindingEpoch,
      });
      decisionLogger.info("nothing to settle for this window", {
        decision: "SKIP",
        reasonCode: attested.reason,
        detail: attested.detail,
        contribution: attested.contribution.toString(),
        ...engineFields,
      });
      const target = await checkpoint(1);
      return finish({ tickId, outcome: "SKIPPED", detail: `${attested.reason}: ${attested.detail}`, headBlockL2, anchorBlockL2: target, report });
    }
    if (attested.kind === "DEFER") {
      decisionLogger.warn("deferring this window", {
        decision: "DEFER",
        reasonCode: attested.reason,
        detail: attested.detail,
        ...engineFields,
      });
      // No checkpoint: the anchor must not move past a window we still intend to
      // settle once the world changes.
      return finish({ tickId, outcome: "DEFERRED", detail: `${attested.reason}: ${attested.detail}`, headBlockL2, report });
    }
    if (attested.kind === "HALT") {
      await ledger.append("DEGRADED", { reason: attested.reason, detail: attested.detail });
      decisionLogger.error("halting", { decision: "HALT", reasonCode: attested.reason, detail: attested.detail, ...engineFields });
      return finish({ tickId, outcome: "DEGRADED", detail: `${attested.reason}: ${attested.detail}`, headBlockL2, report });
    }

    // Idempotency: local rules first (cheap, prevents gas waste), then the
    // chain-derived pair (survives total local state loss).
    const candidate = {
      startBlockL2: session.startBlockL2,
      endBlockL2: session.endBlockL2,
      startBlockL1: report.startBlockL1,
      endBlockL1: report.endBlockL1,
      bindingEpoch: snapshot.bindingEpoch,
      sessionId: attested.sessionId,
    };
    const local = localEligibility(ledger.state, candidate, config.limits, Date.now());
    if (!local.ok) {
      // TWO VERY DIFFERENT THINGS USED TO LOOK THE SAME HERE, and the old code
      // had to GUESS between them with `lastEndBlockL2 > 0n`. They are now
      // separated by construction, because the two questions are answered in two
      // different scopes:
      //
      //   "is this a replay?"          epoch-INDEPENDENT, L2, the settled frontier
      //   "will the chain revert it?"  epoch-SCOPED,      L1, chainGuardL1
      //
      // PROGRESSION_L2 runs first, so reaching PROGRESSION_L1 at all PROVES the
      // window's L2 range is strictly above every settled window. It is therefore
      // a genuinely new session that the protocol's L1-only block range can never
      // accept — forfeited revenue, not a duplicate caught.
      const epochKey = snapshot.bindingEpoch.toString();
      const priorL1 = ledger.state.chainGuardL1.get(epochKey);
      const frontierL2 = ledger.state.settledFrontierL2;
      if (local.rule === "PROGRESSION_L1") {
        const detail =
          `L1_RANGE_COLLAPSED: startBlockL1 ${report.startBlockL1} < lastEndBlockL1 ${priorL1} for ` +
          `bindingEpoch ${epochKey}, so PersonalVault.acceptSettlement would revert ` +
          `NonProgressiveL1BlockRange — but this session's startBlockL2 ${session.startBlockL2} is above the ` +
          `settled L2 frontier ${frontierL2 ?? "(nothing settled)"}, so it is a NEW session and NOT a replay. ` +
          `${report.realizedProfit} wei of realized profit is forfeited. ${L1_COLLAPSE_NOTE}`;
        decisionLogger.warn("L1 range collapse: real profit forfeited on a window that is not a duplicate", {
          decision: "SKIP",
          reasonCode: "L1_RANGE_COLLAPSED",
          detail,
          sessionId: attested.sessionId,
          forfeitedRealizedProfitWei: report.realizedProfit.toString(),
          forfeitedContributionWei: attested.contribution.toString(),
          chainGuardL1: priorL1?.toString() ?? null,
          settledFrontierL2: frontierL2?.toString() ?? null,
          ...engineFields,
        });
        await ledger.append("SKIPPED", {
          startBlockL2: session.startBlockL2,
          endBlockL2: session.endBlockL2,
          reason: "L1_RANGE_COLLAPSED",
          detail,
          endBlockL1: report.endBlockL1,
          bindingEpoch: snapshot.bindingEpoch,
        });
        const target = await checkpoint(1);
        return finish({ tickId, outcome: "L1_RANGE_COLLAPSED", detail, headBlockL2, anchorBlockL2: target, report });
      }

      const detail = `${local.rule}: ${local.detail}`;
      decisionLogger.warn("local idempotency refused this window", {
        decision: "SKIP",
        reasonCode: local.rule,
        detail,
        sessionId: attested.sessionId,
        ...engineFields,
      });
      // NOT EVERY REFUSAL IS "ALREADY SETTLED", and burning a window forever
      // under that label is how forfeited revenue becomes invisible. Only the
      // rules that are statements about SETTLED HISTORY record the window
      // terminal. STORE_INTEGRITY and COVERAGE_UNRESOLVED are recoverable
      // conditions — a damaged store, or an adoption whose L2 range the scan
      // could not resolve — so the window is left alone and no checkpoint moves
      // past it. The refusal repeats, loudly, until the condition is fixed.
      const recoverable = local.rule === "STORE_INTEGRITY" || local.rule === "COVERAGE_UNRESOLVED";
      if (recoverable) {
        return finish({ tickId, outcome: "SKIPPED", detail, headBlockL2, report });
      }
      await ledger.append("SKIPPED", {
        startBlockL2: session.startBlockL2,
        endBlockL2: session.endBlockL2,
        reason: "ALREADY_SETTLED",
        detail,
        endBlockL1: report.endBlockL1,
        bindingEpoch: snapshot.bindingEpoch,
      });
      const target = await checkpoint(1);
      return finish({ tickId, outcome: "SKIPPED", detail, headBlockL2, anchorBlockL2: target, report });
    }

    const onchainOk = await chainEligibility(
      chain,
      snapshot,
      {
        sessionId: attested.sessionId,
        account: config.account,
        expectedSettlementNonce: recovery.expectedSettlementNonce,
      },
      config.logsFromBlockL2,
    );
    if (!onchainOk.ok) {
      // THE CRASH-AFTER-BROADCAST CASE, in its most general form: local state
      // says unsettled, the chain says otherwise. The chain wins, always.
      decisionLogger.warn("chain says this window is already settled; not re-settling", {
        decision: "SKIP",
        reasonCode: onchainOk.rule,
        detail: onchainOk.detail,
        sessionId: attested.sessionId,
        ...engineFields,
      });
      await ledger.append("SKIPPED", {
        startBlockL2: session.startBlockL2,
        endBlockL2: session.endBlockL2,
        reason: "ALREADY_SETTLED",
        detail: `${onchainOk.rule}: ${onchainOk.detail}`,
        endBlockL1: report.endBlockL1,
        bindingEpoch: snapshot.bindingEpoch,
      });
      const target = await checkpoint(1);
      return finish({ tickId, outcome: "SKIPPED", detail: `${onchainOk.rule}: ${onchainOk.detail}`, headBlockL2, anchorBlockL2: target, report });
    }

    const submitted = await submitSettlement({
      mode: config.mode,
      chain,
      ledger,
      logger: decisionLogger,
      attestation: attested.attestation,
      signature: attested.signature,
      digest: attested.digest,
      chainId: config.chainId,
      executor: config.executor,
      account: config.account,
      startBlockL2: session.startBlockL2,
      endBlockL2: session.endBlockL2,
      attesterAddress: deps.attesterSigner.address,
      reportCash: {
        cashStart: report.cashStart,
        cashEnd: report.cashEnd,
        externalDeposits: report.externalDeposits,
        externalWithdrawals: report.externalWithdrawals,
      },
      limits: config.limits,
      tradingSigner: deps.tradingSigner,
    });

    const contributionBps =
      report.realizedProfit > 0n ? (attested.contribution * 10_000n) / report.realizedProfit : 0n;
    const decisionFields = {
      ...engineFields,
      sessionId: attested.sessionId,
      attestationDigest: attested.digest,
      contribution: attested.contribution.toString(),
      // A human spots 2000 at a glance, and spots anything else instantly.
      contributionBps: contributionBps.toString(),
      adminEpoch: snapshot.adminEpoch.toString(),
      localPauseEpoch: snapshot.localPauseEpoch.toString(),
      globalPauseEpoch: snapshot.globalPauseEpoch.toString(),
    };

    switch (submitted.kind) {
      case "DRY_RUN":
        decisionLogger.info("DRY RUN: this is exactly what would be sent", {
          decision: "DRYRUN",
          reasonCode: "DRY_RUN",
          wouldSend: describePlan(submitted.plan, config.printCalldata),
          ...decisionFields,
        });
        // No checkpoint past the window: a dry run changes nothing, so the same
        // window must still be the next thing considered.
        return finish({ tickId, outcome: "DRY_RUN", headBlockL2, plan: submitted.plan, report });
      case "BLOCKED":
        decisionLogger.warn("submission blocked", { decision: "SKIP", reasonCode: submitted.reason, detail: submitted.detail, ...decisionFields });
        return finish({ tickId, outcome: "BLOCKED", detail: `${submitted.reason}: ${submitted.detail}`, headBlockL2, report });
      case "CONFIRMED": {
        decisionLogger.info("settled", {
          decision: "SETTLE",
          reasonCode: "CONFIRMED",
          txHash: submitted.txHash,
          blockNumberL2: submitted.blockNumberL2.toString(),
          gasUsed: submitted.gasUsed.toString(),
          eoaNonce: submitted.plan.nonce,
          ...decisionFields,
        });
        const target = await checkpoint(1);
        return finish({
          tickId, outcome: "SETTLED", headBlockL2, anchorBlockL2: target,
          plan: submitted.plan, report,
          txHash: submitted.txHash, settledBlockL2: submitted.blockNumberL2,
        });
      }
      case "FAILED": {
        // Gas burned, nonce consumed, nothing moved. Ask the chain WHY before
        // deciding whether this window may ever be offered again, and never
        // return without either recording the window terminal or scheduling a
        // bounded retry — returning with neither is what made this an unbounded
        // gas drain.
        const diagnosis = await diagnoseRevert(chain, config, attested.attestation, attested.signature);
        const attempts = failureHistory(ledger).perWindow.get(windowKey(session))?.attempts ?? 1;
        const permanent = diagnosis.verdict.kind === "PERMANENT";
        const terminal = permanent || attempts >= MAX_REVERTS_PER_WINDOW;
        const revert = permanent ? diagnosis.verdict.revert : "UNKNOWN";
        const backoff = revertBackoffMs(attempts);
        const base = `settle reverted onchain (${revert}) on attempt ${attempts}: ${diagnosis.detail}`;
        decisionLogger.error("settle reverted onchain", {
          decision: "SETTLE",
          reasonCode: "REVERTED",
          txHash: submitted.txHash,
          revert,
          revertClass: diagnosis.verdict.kind,
          revertDetail: diagnosis.detail,
          attempts,
          terminal,
          ...(terminal ? {} : { backoffMs: backoff, nextEligibleAtMs: nowMs() + backoff }),
          ...decisionFields,
        });
        if (terminal) {
          const detail =
            `${base}. Recorded terminal: ` +
            (permanent
              ? `${revert} is a statement about history or configuration, not about timing, so no retry can succeed.`
              : `${MAX_REVERTS_PER_WINDOW} reverts for one window is conclusive.`) +
            " This window will not be offered again.";
          await ledger.append("SKIPPED", {
            startBlockL2: session.startBlockL2,
            endBlockL2: session.endBlockL2,
            reason: permanent ? diagnosis.verdict.skipReason : "REFUSED",
            detail,
            endBlockL1: report.endBlockL1,
            bindingEpoch: snapshot.bindingEpoch,
          });
          // Checkpointing here is the fix for the retry loop: the old FAILED
          // branch returned without it, so the anchor never advanced and the same
          // doomed window was rediscovered on every poll.
          const target = await checkpoint(1);
          return finish({
            tickId,
            outcome: "SETTLE_FAILED",
            detail,
            headBlockL2,
            anchorBlockL2: target,
            plan: submitted.plan,
            report,
          });
        }
        // Transient. Deliberately NO checkpoint — this window is still one we
        // intend to settle — and the backoff gate above holds it off until then.
        return finish({
          tickId,
          outcome: "SETTLE_FAILED",
          detail: `${base}. Retrying after ${Math.round(backoff / 1000)}s.`,
          headBlockL2,
          plan: submitted.plan,
          report,
        });
      }
      case "UNRESOLVED":
        decisionLogger.warn("broadcast outcome unknown; the intent stays open", { decision: "SETTLE", reasonCode: "UNRESOLVED", rawTxHash: submitted.rawTxHash, ...decisionFields });
        return finish({ tickId, outcome: "UNRESOLVED", headBlockL2, plan: submitted.plan, report });
    }
  } catch (error) {
    // THE STORE REFUSING A WRITE IS NOT AN RPC PROBLEM, and it used to be
    // reported as one. A LedgerWriteError thrown inside runTick was swallowed by
    // the generic handler below and labelled RPC_ERROR — the single label that
    // means "transient, retry in 30s". A schema refusal means the opposite: the
    // database just proved the keeper was about to do something it must not, so
    // the keeper HALTS and a human looks.
    if (error instanceof LedgerConstraintError || error instanceof LedgerWriteError) {
      const detail =
        error instanceof LedgerConstraintError
          ? `STORE_REFUSED_${error.rule}: ${error.message}`
          : `STORE_UNWRITABLE: ${(error as Error).message}`;
      logger.error("the store refused a write; halting rather than retrying", {
        decision: "HALT",
        reasonCode: "STORE_REFUSED",
        detail,
      });
      try {
        // Best-effort: if the store is unwritable this cannot land either, and
        // the refusal is still returned and still logged.
        await ledger.append("DEGRADED", { reason: "STORE_REFUSED", detail });
      } catch {
        /* the store already told us it will not accept writes */
      }
      return finish({ tickId, outcome: "STORE_REFUSED", detail });
    }
    // A failed tick yields NO verdict. It does not exit: restarting has never
    // once fixed an upstream RPC, and a keeper that dies on a 429 is a keeper
    // that is down whenever the provider is busy.
    logger.error("tick aborted", { error });
    // Summarized, not sliced. `TickResult.detail` is surfaced by callers, and a
    // raw viem transport message carries `URL: <endpoint>` — with the API key —
    // well inside the old 300-character slice.
    return finish({
      tickId,
      outcome: "RPC_ERROR",
      detail: summarizeUpstreamError(error, {
        redactor: config.redactor,
        rpcHost: config.rpcHost,
        take: 2,
        maxChars: 300,
      }),
    });
  }
}

/**
 * Asks the chain why a settle reverted, without ever putting its answer into a
 * payload verbatim.
 *
 * Re-simulating is the cheapest reliable source of the revert selector: the
 * receipt carries only `status: 0`. If the simulation now SUCCEEDS the cause was
 * not the attestation — a nonce race or a state change between signing and
 * mining — which is exactly the transient class.
 */
async function diagnoseRevert(
  chain: ChainAccess,
  config: KeeperConfig,
  attestation: SettlementAttestation,
  signature: Hex,
): Promise<{ readonly verdict: RevertClass; readonly detail: string }> {
  try {
    await chain.estimateSettleGas({ account: config.account, attestation, signature });
    return {
      verdict: { kind: "TRANSIENT" },
      detail:
        "the same settle simulates cleanly against current state, so the revert was not caused by the " +
        "attestation itself",
    };
  } catch (error) {
    return {
      verdict: classifyRevert(error),
      detail: summarizeUpstreamError(error, { redactor: config.redactor, rpcHost: config.rpcHost, take: 2 }),
    };
  }
}

async function findVanishedSettlements(
  chain: ChainAccess,
  confirmed: readonly JournalRecord<ConfirmedBody>[],
): Promise<string[]> {
  const vanished: string[] = [];
  for (const record of confirmed) {
    const txHash = record.body.txHash as Hex;
    if (!txHash.startsWith("0x") || txHash.length !== 66) continue;
    const receipt = await chain.getTransactionReceipt(txHash);
    if (receipt === null) vanished.push(`${record.body.sessionId} (${txHash})`);
  }
  return vanished;
}

function histogram(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

export interface RunLoopOptions {
  /** Stop after this many ticks. Undefined runs until the signal. */
  readonly maxTicks?: number;
  readonly signal?: AbortSignal;
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * Called after every tick. This is what lets /health distinguish a wedged
   * loop from a busy one — the only condition a restart actually fixes.
   */
  readonly onTick?: (result: TickResult) => void;
  /** Bounds memory for a process that runs for months. */
  readonly keepResults?: number;
}

export async function runLoop(deps: KeeperDeps, options: RunLoopOptions = {}): Promise<TickResult[]> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const keepResults = options.keepResults ?? 200;
  const results: TickResult[] = [];
  let ticks = 0;

  for (;;) {
    if (options.signal?.aborted) break;
    const result = await runTick(deps);
    options.onTick?.(result);
    results.push(result);
    if (results.length > keepResults) results.splice(0, results.length - keepResults);
    ticks += 1;
    if (options.maxTicks !== undefined && ticks >= options.maxTicks) break;
    if (options.signal?.aborted) break;
    // Jitter so several restarted keepers do not synchronise their polling.
    const jitter = 1 + (Math.random() * 0.2 - 0.1);
    await sleep(Math.round(deps.config.limits.pollMs * jitter));
  }
  return results;
}

/**
 * The operator view. Deliberately NOT what a container health probe reads: a
 * probe that talks to the chain turns an RPC hiccup into a restart loop, and
 * restarting has never fixed an upstream RPC. A halted keeper must stay up to
 * explain itself.
 */
export async function buildStatus(deps: KeeperDeps): Promise<Record<string, unknown>> {
  const { config, chain, ledger } = deps;
  const state = ledger.state;

  const read = async <T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> => {
    try {
      return { ok: true, value: await fn() };
    } catch (error) {
      // A failed read is never silently a zero or a false. /status must be able
      // to say "unknown", because a green tick for something that was not
      // verified is the one bug this codebase exists to prevent.
      //
      // AND IT MUST NOT SAY IT WITH A RAW UPSTREAM MESSAGE. This payload leaves
      // the process two ways that do NOT pass through the redacting logger —
      // `send(200, payload)` on the unauthenticated /status port, and
      // `process.stdout.write` in `keeper status` — and a viem HttpRequestError's
      // message carries `URL: <endpoint>`, which carries an Alchemy API key. A
      // routine 429 was therefore enough to serve the key to anything on the
      // compose network. What goes in now is the error NAME plus a summary that
      // has been stripped of viem's metadata lines, had the endpoint host
      // substituted, been scrubbed, and then checked again.
      return {
        ok: false,
        error: summarizeUpstreamError(error, { redactor: config.redactor, rpcHost: config.rpcHost }),
      };
    }
  };

  const chainId = await read(() => chain.getChainId());
  const head = await read(() => chain.getHeadBlockL2());
  const snapshot = await read(() => chain.readVaultSnapshot(config.account));
  const lastSettlement = state.confirmedRecords.at(-1);

  // The field that would have caught the state-loss blind spot. A journal with no
  // settlement record against a non-zero chain settlementNonce means the last
  // settled boundary is unknown, and it is the condition runTick refuses on.
  const settledInJournal = settlementRecordCount(state);
  const chainNonce = snapshot.ok ? snapshot.value.settlementNonce : null;
  const accounted = chainNonce === null ? null : chainNonce === 0n || settledInJournal > 0;

  // L1 range collapse is real revenue lost, so it is counted rather than buried:
  // every occurrence is a SKIPPED record whose detail names the forfeited wei.
  const { records } = ledger.readRecords();
  const collapsed = records
    .filter((record) => record.type === "SKIPPED" && (record.body as SkippedBody).reason === "L1_RANGE_COLLAPSED")
    .map((record) => ({
      seq: record.seq,
      at: record.ts,
      window: windowKey(record.body as SkippedBody),
      detail: (record.body as SkippedBody).detail,
    }));
  const failures = failureHistory(ledger);

  // THE ENDPOINT HOST COMES OFF THIS PAYLOAD. It is not a credential and it is
  // deliberately visible on the log lines, which go to local stdout — but /status
  // is served unauthenticated, and in the shipped compose file it binds 0.0.0.0 on
  // a shared bridge network, so anything on that network can read it. The host is
  // the string an API key hangs off; naming the provider to a sibling container
  // buys the operator nothing. `keeper starting` and `describeConfig` still print
  // it where it is useful.
  const describedConfig = describeConfig(config);
  if ("rpcHost" in describedConfig) describedConfig.rpcHost = "<upstream RPC>";

  return {
    config: describedConfig,
    /**
     * THE FIRST BLOCK, AND THE FIRST THING TO READ DURING AN INCIDENT.
     *
     * The store has three states, not two. `condition` is HEALTHY when the file
     * opened and passed its structural checks, and DAMAGED when it is zero bytes,
     * truncated, not a database, missing a table the dedup reads, or has an
     * orphaned write-ahead log. `integrityOk` is the separate, narrower question
     * of whether the contents are unedited — it now covers the DECISION tables,
     * not only the record stream. A DAMAGED store settles nothing, and this is
     * where an operator sees that without having to infer it.
     */
    store: {
      path: ledger.journalPath,
      condition: state.condition,
      integrityOk: state.integrityOk,
      detail: state.integrityDetail,
      settleable: state.condition === "HEALTHY" && state.integrityOk,
      /** chmod is advisory on Windows and refused on some storage drivers; a failure warns, never crashes. */
      permissionWarnings: ledger.permissionWarnings,
    },
    chainIdObserved: chainId,
    chainOk: chainId.ok ? chainId.value === config.chainId : false,
    headBlockL2: head.ok ? head.value.toString() : head,
    anchorBlockL2: state.anchorBlockL2?.toString() ?? null,
    anchorLagBlocks: head.ok && state.anchorBlockL2 !== null ? (head.value - state.anchorBlockL2).toString() : null,
    vault: snapshot.ok
      ? {
          activeVault: snapshot.value.activeVault,
          status: snapshot.value.status,
          bindingEpoch: snapshot.value.bindingEpoch.toString(),
          policyNonce: snapshot.value.policyNonce.toString(),
          settlementNonce: snapshot.value.settlementNonce.toString(),
          activationBlockL1: snapshot.value.activationBlockL1.toString(),
          protocolPaused: snapshot.value.protocolPaused,
          settlementPaused: snapshot.value.settlementPaused,
          lifetimeContribution: snapshot.value.lifetimeContribution.toString(),
          accountBalanceWei: snapshot.value.accountBalanceWei.toString(),
          registeredAttester: snapshot.value.registeredAttester,
          attesterEpoch: snapshot.value.attesterEpoch,
          policy: {
            savingsBps: snapshot.value.policy.savingsBps,
            minContributionWei: snapshot.value.policy.minContributionWei.toString(),
            maxPerSettlementWei: snapshot.value.policy.maxPerSettlementWei.toString(),
            tradingFloorWei: snapshot.value.policy.tradingFloorWei.toString(),
            gasReserveWei: snapshot.value.policy.gasReserveWei.toString(),
          },
        }
      : snapshot,
    attesterMatchesRegistry:
      snapshot.ok && deps.attesterSigner !== null
        ? snapshot.value.registeredAttester.toLowerCase() === deps.attesterSigner.address.toLowerCase()
        : null,
    attester: deps.attesterSigner?.address ?? null,
    inFlight: state.openIntents.map((intent) => ({
      seq: intent.seq,
      window: windowKey(intent.body),
      sessionId: intent.body.sessionId,
      rawTxHash: intent.body.rawTxHash,
      eoaNonce: intent.body.eoaNonce,
      deadline: intent.body.deadline,
    })),
    lastSettlement: lastSettlement
      ? {
          sessionId: lastSettlement.body.sessionId,
          txHash: lastSettlement.body.txHash,
          contribution: lastSettlement.body.contribution.toString(),
          realizedProfit: lastSettlement.body.realizedProfit.toString(),
          atL2: lastSettlement.body.blockNumberL2.toString(),
          at: lastSettlement.ts,
          source: lastSettlement.body.source,
        }
      : null,
    journal: {
      path: ledger.journalPath,
      seq: state.seq,
      head: state.head,
      counts: state.counts,
      condition: state.condition,
      integrityOk: state.integrityOk,
      integrityDetail: state.integrityDetail,
      /**
       * THE EPOCH-INDEPENDENT REPLAY BOUNDARY. This is the number to read first
       * during an incident: no window whose startBlockL2 is at or below it will
       * ever be settled again, whatever the bindingEpoch does.
       */
      settledFrontierL2: state.settledFrontierL2?.toString() ?? null,
      settledHighWaterL1: state.settledHighWaterL1?.toString() ?? null,
      refusedHighWaterL2: state.refusedHighWaterL2?.toString() ?? null,
      /**
       * A REVERT PREDICTOR ONLY. It mirrors PersonalVault.lastEndBlock, which is
       * epoch-keyed and which a rebind RESETS. It must never be read as an
       * answer to "was this window already settled" — that is settledFrontierL2.
       */
      chainGuardL1_revertPredictorOnly: Object.fromEntries(
        [...state.chainGuardL1].map(([k, v]) => [k, v.toString()]),
      ),
      coverageUnresolved: state.coverageUnresolved,
      terminalWindows: Object.fromEntries(state.terminalWindows),
      /**
       * node:sqlite is experimental on this Node. The warning is swallowed at the
       * import and republished here, so it is acknowledged rather than hidden.
       */
      experimentalWarnings: experimentalWarnings(),
    },
    /**
     * ALERT ON `accounted === false`. It means the keeper cannot account for the
     * chain's settlement history from its own journal, which is the state a wiped
     * volume produces and the state in which no window may be attested.
     */
    history: {
      chainSettlementNonce: chainNonce?.toString() ?? null,
      journalSettlementRecords: settledInJournal,
      journalContributionWei: journalContribution(state).toString(),
      accounted,
      detail:
        accounted === false
          ? "the chain reports settlements this journal has no record of; the last settled boundary is " +
            "unknown and nothing will be attested until recovery accounts for it"
          : null,
    },
    /** Revenue the protocol's L1-only block range made unsettleable. Not duplicates. */
    l1RangeCollapsed: { count: collapsed.length, windows: collapsed.slice(-20) },
    reverts: {
      consecutive: failures.consecutive,
      breakerAt: BREAKER_CONSECUTIVE_REVERTS,
      maxPerWindow: MAX_REVERTS_PER_WINDOW,
      perWindow: Object.fromEntries(
        [...failures.perWindow].map(([window, failure]) => [
          window,
          {
            attempts: failure.attempts,
            lastAt: Number.isFinite(failure.lastAtMs) ? new Date(failure.lastAtMs).toISOString() : null,
            lastReason: failure.lastReason,
          },
        ]),
      ),
    },
    degraded: state.degraded,
  };
}

export type { SkipReason };
