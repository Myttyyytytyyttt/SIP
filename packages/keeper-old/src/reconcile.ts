// Chain-versus-local truth. The authority on what has already been settled.
//
// THE GOVERNING PRINCIPLE: the local journal is a CACHE. Chain history is the
// ledger, and it is fully recoverable — including the field the contract stores
// but exposes no getter for. PersonalVault keeps lastEndBlock[account][epoch]
// and usedSessions[...] in private namespaced storage with no accessor, so the
// last settled boundary cannot be read back. It can, however, be RE-DERIVED:
// SettlementExecuted indexes sessionId and account, and the settle transaction's
// calldata carries the entire attestation. Log plus calldata therefore rebuilds
// the whole settled-boundary map from nothing but chain data.
//
// That is what makes requirement 3 satisfiable rather than merely hoped for. A
// keeper whose volume was deleted, or whose journal lost its tail to a crash,
// recovers the truth by asking the chain — never by assuming the absence of a
// local record means the absence of a settlement.
//
// THREE PHASES, in order, and no settle may run before they finish:
//
//   A. Resolve every unterminated INTENT. Chain first, receipt then transaction
//      then log — never the nonce alone.
//   B. Hunt for settlements the journal never saw at all.
//   C. Latch on anything unexplained, and refuse to settle until a human says so.
//
// PHASE B'S TRIGGER IS THE WHOLE BALLGAME, AND IT USED TO BE WRONG. It compared
// the chain's settlementNonce against `header.baselineSettlementNonce + records`,
// and the header of a brand-new journal is written from the live snapshot moments
// earlier — so on the one scenario this file exists for, a wiped volume, the two
// sides were equal by construction. Phase B never ran, every idempotency map
// stayed empty, and the result came back nonceReconciled: true. The guard was not
// wrong about anything; it was unarmed, and it reported itself green.
//
// The trigger is now the invariant itself. PersonalVault consumes settlement
// nonces strictly in order from zero and never resets them, so a chain
// settlementNonce of N is a claim that N settlements happened. Each journal
// record names the nonce its settlement consumed, so the journal can be asked
// directly: name all N. An empty journal cannot name nonce 0, so a wiped volume
// scans the chain — which is exactly what recovery is supposed to mean. Nothing
// but an explicit, durable, bounded operator acknowledgement can excuse a nonce
// the journal cannot name, and the absence of a local record is never, anywhere
// in this file, read as the absence of a settlement.
//
// Phase C matters more than it looks. An unattributed settlement means the
// service's model of history is wrong, and a service with a wrong model of
// history is precisely the thing that pays twice. Halting is cheap; the money is
// not.

import type { JournalStore } from "./journal-store.js";
import type { Hex } from "viem";
import {
  Ledger,
  windowKey,
  type IntentBody,
  type JournalRecord,
  type L2Precision,
  type LedgerState,
} from "./ledger.js";
import type { Logger } from "./log.js";
import { decodeSettleCalldata, type ChainAccess, type VaultSnapshot } from "./onchain.js";

export type IntentResolution =
  | { readonly kind: "CONFIRMED"; readonly txHash: Hex; readonly blockNumberL2: bigint; readonly gasUsed: bigint }
  | { readonly kind: "FAILED"; readonly txHash: Hex }
  | { readonly kind: "ABANDONED"; readonly reason: string }
  /** Still in the mempool, still inside its own deadline. Leave it alone. */
  | { readonly kind: "PENDING"; readonly detail: string };

/**
 * Decides what became of one broadcast attempt, using only chain evidence.
 *
 * THE ORDER IS THE ARGUMENT. A receipt is conclusive. A pending transaction is
 * conclusive about "not yet". Absence is conclusive about nothing at all, which
 * is why the nonce is consulted only to narrow the question and never to answer
 * it: the trading account is the trader's own actively-used EOA, so a GMGN trade
 * can consume the reserved nonce. "Nonce advanced" therefore does NOT mean "we
 * settled". Only the indexed SettlementExecuted log decides that, and it decides
 * it exactly, because sessionId commits chainId, vault, account, bindingEpoch,
 * both L1 boundaries and the ledgerRoot.
 */
export async function resolveIntent(
  chain: ChainAccess,
  account: `0x${string}`,
  intent: IntentBody,
  nowSeconds: number,
  /**
   * Where to start the SettlementExecuted scan. It used to be hardcoded to 0 here
   * while every other call site used the configured floor, so on any endpoint that
   * caps eth_getLogs by range this threw, the tick aborted, the INTENT was never
   * resolved, and SINGLE_FLIGHT then blocked every future settlement permanently —
   * a fail-safe direction, but one that needed a human and was triggered by
   * provider policy rather than by anything being wrong.
   */
  logsFromBlockL2: bigint = 0n,
): Promise<IntentResolution> {
  const rawTxHash = intent.rawTxHash as Hex;

  const receipt = await chain.getTransactionReceipt(rawTxHash);
  if (receipt !== null) {
    return receipt.status === "success"
      ? {
          kind: "CONFIRMED",
          txHash: receipt.transactionHash,
          blockNumberL2: receipt.blockNumber,
          gasUsed: receipt.gasUsed,
        }
      : { kind: "FAILED", txHash: receipt.transactionHash };
  }

  const tx = await chain.getTransaction(rawTxHash);
  if (tx !== null) {
    if (nowSeconds <= intent.deadline) {
      return { kind: "PENDING", detail: `in the mempool, deadline in ${intent.deadline - nowSeconds}s` };
    }
    return { kind: "ABANDONED", reason: "pending past the attestation deadline; it can only revert now" };
  }

  const minedCount = await chain.getTransactionCount(account);
  if (minedCount <= intent.eoaNonce) {
    // The reserved nonce is still unused, so our transaction never landed and
    // cannot land unless it is rebroadcast. Nothing was spent.
    return {
      kind: "ABANDONED",
      reason: `nonce ${intent.eoaNonce} is still unused (mined count ${minedCount}); the transaction never landed`,
    };
  }

  // Something consumed that nonce. It may not have been us. Ask the log, which
  // is the only thing that can distinguish "we settled" from "the trader traded".
  const logs = await chain.getSettlementLogs({
    fromBlockL2: logsFromBlockL2,
    sessionId: intent.sessionId as Hex,
  });
  const match = logs.find((log) => log.account.toLowerCase() === account.toLowerCase());
  if (match) {
    // Take the hash from the LOG, not from our record: a replacement or a
    // re-priced rebroadcast has a different hash and the same effect.
    return {
      kind: "CONFIRMED",
      txHash: match.transactionHash,
      blockNumberL2: match.blockNumber,
      gasUsed: 0n,
    };
  }
  return {
    kind: "ABANDONED",
    reason: `nonce ${intent.eoaNonce} was consumed by something else and no SettlementExecuted log exists for this sessionId`,
  };
}

export interface AdoptedSettlement {
  readonly sessionId: Hex;
  readonly txHash: Hex;
  readonly blockNumberL2: bigint;
  readonly bindingEpoch: bigint;
  readonly settlementNonce: bigint;
  readonly startBlockL1: bigint;
  readonly endBlockL1: bigint;
  /**
   * The L2 window as the settle calldata itself declares it.
   *
   * The attestation now carries startBlockL2/endBlockL2 as real fields, so for
   * any settlement made against this executor the exact window is decodable and
   * does not have to be clamped back out of the L1 range. Kept nullable rather
   * than assumed: a zero pair is not a window, and the clamp remains the
   * fallback for anything that cannot produce one.
   */
  readonly startBlockL2: bigint | null;
  readonly endBlockL2: bigint | null;
  readonly ledgerRoot: Hex;
  readonly contribution: bigint;
  readonly realizedProfit: bigint;
}

/**
 * Enumerates every settlement this account has ever had, from chain data alone.
 *
 * SettlementExecuted carries no block range, so the range is recovered by
 * fetching the transaction and ABI-decoding the settle calldata. A log whose
 * calldata cannot be decoded is reported rather than skipped: it means a
 * settlement happened by a route this code does not understand, and that is
 * exactly the kind of thing Phase C must halt on.
 */
export async function enumerateChainSettlements(
  chain: ChainAccess,
  account: `0x${string}`,
  fromBlockL2: bigint,
): Promise<{ settlements: AdoptedSettlement[]; undecodable: Hex[] }> {
  const logs = await chain.getSettlementLogs({ fromBlockL2, account });
  const settlements: AdoptedSettlement[] = [];
  const undecodable: Hex[] = [];

  for (const log of logs) {
    const tx = await chain.getTransaction(log.transactionHash);
    const decoded = tx ? decodeSettleCalldata(tx.input) : null;
    if (!decoded) {
      undecodable.push(log.transactionHash);
      continue;
    }
    settlements.push({
      sessionId: log.sessionId,
      txHash: log.transactionHash,
      blockNumberL2: log.blockNumber,
      bindingEpoch: BigInt(decoded.attestation.bindingEpoch),
      settlementNonce: BigInt(decoded.attestation.settlementNonce),
      startBlockL1: BigInt(decoded.attestation.startBlock),
      endBlockL1: BigInt(decoded.attestation.endBlock),
      startBlockL2: decoded.attestation.startBlockL2 === undefined ? null : BigInt(decoded.attestation.startBlockL2),
      endBlockL2: decoded.attestation.endBlockL2 === undefined ? null : BigInt(decoded.attestation.endBlockL2),
      ledgerRoot: decoded.attestation.ledgerRoot,
      contribution: log.contribution,
      realizedProfit: log.realizedProfit,
    });
  }
  return { settlements, undecodable };
}

export interface ReconcileResult {
  readonly resolvedIntents: number;
  readonly adopted: number;
  readonly degraded: { readonly reason: string; readonly detail: string } | null;
  readonly nonceReconciled: boolean;
  readonly expectedSettlementNonce: bigint;
  readonly observedSettlementNonce: bigint;
  /** True when Phase B actually ran the SettlementExecuted scan on this call. */
  readonly enumeratedChain: boolean;
  /**
   * Vault settlement nonces the chain says were consumed and the journal still
   * cannot name, after adoption. Anything other than an empty list means the
   * keeper does not know the whole settled history and must not sign.
   */
  readonly unaccountedNonces: readonly bigint[];
}

export interface ReconcileInput {
  readonly chain: ChainAccess;
  readonly ledger: JournalStore;
  readonly logger: Logger;
  readonly account: `0x${string}`;
  readonly snapshot: VaultSnapshot;
  /** Where to start the SettlementExecuted scan. The vault's deployment era. */
  readonly logsFromBlockL2: bigint;
  readonly nowSeconds?: number;
}

/** Total settlements the store knows about. No longer keyed on bindingEpoch. */
const journalSettlementTotal = (state: LedgerState): number => state.settlementCount;

// ---------------------------------------------------------------------------
// RECOVERING THE L2 WINDOW OF A CHAIN-ADOPTED SETTLEMENT
//
// This is what an ADOPTED record needs and the attestation does not carry. The
// settle calldata gives the L1 range; the L2 range survives only folded opaquely
// into ledgerRoot. The old code wrote 0 into both L2 slots and relied on the
// epoch-scoped L1 rule to protect the adopted window — which a bindingEpoch
// rebind then unarmed completely.
//
// So the L2 range is CLAMPED out of the L1 range instead:
//
//   endL2*   = max{ b : l1BlockNumber(b) <= endBlockL1 }
//   startL2* = min{ b : l1BlockNumber(b) >= startBlockL1 }
//
// read per block, by binary search, NEVER by storing an offset and adding it: the
// L1/L2 gap on this chain was 3,551,127 on one day and roughly 2.65M the next.
// Monotone, so a binary search is exact.
//
// THE ERROR DIRECTION IS DELIBERATE. The clamp claims a SUPERSET of the true
// window, because many L2 blocks map to one L1 block. That can cause the keeper
// to skip a genuine session that hid inside an already-consumed L1 block —
// unclaimed savings — and it can NEVER cause a double payment. A window the clamp
// swallows would have reverted NonProgressiveBlockRange anyway.
//
// When the clamp cannot be computed at all, the settlement is adopted with
// l2Precision UNRESOLVED, and localEligibility then refuses EVERY window with
// COVERAGE_UNRESOLVED until a human fixes the scan. Refusing is the safe
// direction; guessing is not.
// ---------------------------------------------------------------------------

/** ~25 RPC reads per bound at this chain's height, and it terminates by construction. */
async function searchL2ByL1(
  chain: ChainAccess,
  headBlockL2: bigint,
  cache: Map<string, bigint>,
  predicate: (l1: bigint) => boolean,
  /** "last" finds the highest block satisfying the predicate, "first" the lowest. */
  want: "last" | "first",
): Promise<bigint | null> {
  const l1At = async (block: bigint): Promise<bigint> => {
    const key = block.toString();
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const value = await chain.getL1BlockNumber(block);
    cache.set(key, value);
    return value;
  };

  let low = 0n;
  let high = headBlockL2;
  let found: bigint | null = null;
  while (low <= high) {
    const mid = (low + high) / 2n;
    const ok = predicate(await l1At(mid));
    if (want === "last") {
      // The predicate is "l1(b) <= endBlockL1", which is downward-closed.
      if (ok) {
        found = mid;
        low = mid + 1n;
      } else {
        if (mid === 0n) break;
        high = mid - 1n;
      }
    } else {
      // The predicate is "l1(b) >= startBlockL1", which is upward-closed.
      if (ok) {
        found = mid;
        if (mid === 0n) break;
        high = mid - 1n;
      } else {
        low = mid + 1n;
      }
    }
  }
  return found;
}

export interface RecoveredWindow {
  readonly startBlockL2: bigint;
  readonly endBlockL2: bigint;
  readonly precision: L2Precision;
  readonly detail: string;
}

export async function recoverL2Window(
  chain: ChainAccess,
  headBlockL2: bigint,
  settlement: { readonly startBlockL1: bigint; readonly endBlockL1: bigint },
  /** The current settled frontier. The recovered window is kept strictly above it. */
  frontierL2: bigint | null,
  cache: Map<string, bigint> = new Map(),
): Promise<RecoveredWindow> {
  try {
    const endStar = await searchL2ByL1(chain, headBlockL2, cache, (l1) => l1 <= settlement.endBlockL1, "last");
    const startStar = await searchL2ByL1(
      chain,
      headBlockL2,
      cache,
      (l1) => l1 >= settlement.startBlockL1,
      "first",
    );
    if (endStar === null || startStar === null) {
      return {
        startBlockL2: 0n,
        endBlockL2: 0n,
        precision: "UNRESOLVED",
        detail:
          `no L2 block maps into the attested L1 range [${settlement.startBlockL1}, ${settlement.endBlockL1}] ` +
          "on this endpoint, so the settled L2 coverage of this settlement is unknown",
      };
    }
    // An out-of-order adoption: this settlement's whole L2 range already sits at
    // or below the frontier, so it adds no coverage. Recorded honestly rather
    // than forced forward into blocks it never touched — the frontier already
    // refuses everything it covered.
    if (frontierL2 !== null && endStar <= frontierL2) {
      return {
        startBlockL2: startStar,
        endBlockL2: endStar,
        precision: "COVERED",
        detail:
          `clamped to L2 [${startStar}, ${endStar}], which lies entirely at or below the settled frontier ` +
          `${frontierL2}; it makes no new coverage claim`,
      };
    }
    // Keep the frontier chain legal and contiguous. Both clamps only ever widen.
    const floor = frontierL2 === null ? 0n : frontierL2 + 1n;
    const startBlockL2 = startStar > floor ? startStar : floor;
    const endBlockL2 = endStar > startBlockL2 ? endStar : startBlockL2;
    return {
      startBlockL2,
      endBlockL2,
      precision: "L1_CLAMP",
      detail:
        `clamped from the attested L1 range [${settlement.startBlockL1}, ${settlement.endBlockL1}] into L2 ` +
        `[${startBlockL2}, ${endBlockL2}]; a SUPERSET of the true window, which can forfeit a session but ` +
        "can never double-pay",
    };
  } catch (error) {
    return {
      startBlockL2: 0n,
      endBlockL2: 0n,
      precision: "UNRESOLVED",
      detail: `the L1 -> L2 mapping could not be read: ${(error as Error).message.slice(0, 200)}`,
    };
  }
}

/**
 * Beyond this many unaccounted nonces, stop enumerating them individually. The
 * list is for a human to read; the refusal does not depend on its length.
 */
const MAX_REPORTED_NONCES = 16;

/**
 * The settlement nonces the chain says were consumed and the journal cannot name.
 *
 * PersonalVault consumes settlement nonces strictly in order from 0 and never
 * resets them — not even on a rebind (compare _activate at PersonalVault.sol
 * :721-724, which bumps bindingEpoch and policyNonce and leaves settlementNonce
 * alone). So `settlementNonce == N` read off the chain is a statement that
 * settlements 0..N-1 each happened, exactly once. Each of them has a block
 * boundary this keeper needs and cannot get any other way, because lastEndBlock
 * has no getter.
 *
 * This is deliberately not a count. The check it replaces was
 * `baseline + recordCount == observed`, and it was unfalsifiable on the case that
 * mattered: a fresh journal's baseline is written from the live nonce, so the
 * two sides were equal by construction and the keeper concluded there was nothing
 * to learn. A set of nonces has no such slack — either the journal names nonce 7
 * or it does not, and no arithmetic elsewhere can make up the difference.
 */
function unaccountedNonces(state: LedgerState, observed: bigint): bigint[] {
  const missing: bigint[] = [];
  for (let nonce = state.acknowledgedNonceFloor; nonce < observed; nonce += 1n) {
    if (!state.settledSettlementNonces.has(nonce.toString())) missing.push(nonce);
  }
  return missing;
}

/** Nonces the journal claims were consumed that the chain has not reached yet. */
function noncesAheadOfChain(state: LedgerState, observed: bigint): bigint[] {
  return [...state.settledSettlementNonces]
    .map((value) => BigInt(value))
    .filter((nonce) => nonce >= observed)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

const describeNonces = (nonces: readonly bigint[]): string => {
  const shown = nonces.slice(0, MAX_REPORTED_NONCES).map(String).join(", ");
  return nonces.length > MAX_REPORTED_NONCES ? `${shown}, … (${nonces.length} total)` : shown;
};

export async function reconcile(input: ReconcileInput): Promise<ReconcileResult> {
  const { chain, ledger, logger, account, snapshot } = input;
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);

  // ---- Phase A -------------------------------------------------------------
  let resolvedIntents = 0;
  for (const intent of [...ledger.state.openIntents] as JournalRecord<IntentBody>[]) {
    const outcome = await resolveIntent(chain, account, intent.body, nowSeconds, input.logsFromBlockL2);
    const window = { startBlockL2: intent.body.startBlockL2, endBlockL2: intent.body.endBlockL2 };
    logger.info("resolving open intent", {
      intentSeq: intent.seq,
      window: windowKey(intent.body),
      sessionId: intent.body.sessionId,
      rawTxHash: intent.body.rawTxHash,
      eoaNonce: intent.body.eoaNonce,
      resolution: outcome.kind,
    });

    switch (outcome.kind) {
      case "CONFIRMED":
        await ledger.append("CONFIRMED", {
          ...window,
          sessionId: intent.body.sessionId,
          bindingEpoch: intent.body.bindingEpoch,
          settlementNonce: intent.body.settlementNonce,
          startBlockL1: intent.body.startBlockL1,
          endBlockL1: intent.body.endBlockL1,
          ledgerRoot: intent.body.ledgerRoot,
          contribution: intent.body.contribution,
          realizedProfit: intent.body.realizedProfit,
          txHash: outcome.txHash,
          blockNumberL2: outcome.blockNumberL2,
          gasUsed: outcome.gasUsed,
          source: "own",
        });
        resolvedIntents += 1;
        break;
      case "FAILED":
        await ledger.append("FAILED", {
          ...window,
          sessionId: intent.body.sessionId,
          txHash: outcome.txHash,
          reason: "mined with status 0",
        });
        resolvedIntents += 1;
        break;
      case "ABANDONED":
        await ledger.append("ABANDONED", {
          ...window,
          sessionId: intent.body.sessionId,
          rawTxHash: intent.body.rawTxHash,
          reason: outcome.reason,
        });
        resolvedIntents += 1;
        break;
      case "PENDING":
        // Deliberately left open. Single-flight will keep the keeper from
        // settling anything else until this resolves, which is correct: we do not
        // know whether the money has moved.
        logger.warn("intent still pending; nothing else will be settled until it resolves", {
          intentSeq: intent.seq,
          detail: outcome.detail,
        });
        break;
    }
  }

  // ---- Phase B -------------------------------------------------------------
  //
  // THE INVARIANT: the chain says N settlement nonces have been consumed, so the
  // journal must be able to NAME all N. Anything it cannot name is a settlement
  // whose block boundary the keeper does not know, and a window it therefore
  // cannot prove is new.
  //
  // WHAT THIS REPLACED, AND WHY. The old trigger was
  // `observed > baselineSettlementNonce + journalRecordCount`. On a wiped volume
  // the header is written fresh from the live snapshot (keeper.ts calls
  // ensureHeader with snapshot.settlementNonce immediately before this function
  // runs), so baseline == observed, the difference was zero, and the branch below
  // never ran. The keeper adopted nothing, left lastEndBlockL1 and
  // settledSessionIds empty, and returned nonceReconciled TRUE — a green
  // all-clear on the one field designed to detect exactly this. It would then
  // sign a settle for a window it had already settled, and only the vault's
  // NonProgressiveBlockRange stopped the payment.
  //
  // The trigger is now the invariant itself, so a state loss cannot suppress it:
  // an empty journal against settlementNonce 1 has one unnamed nonce, and one
  // unnamed nonce means the scan runs. In the steady state the journal names
  // every nonce, so this costs nothing — the scan happens on the cold start that
  // needs it and never again.
  const observed = snapshot.settlementNonce;
  let ahead = noncesAheadOfChain(ledger.state, observed);
  let missing = unaccountedNonces(ledger.state, observed);

  let adopted = 0;
  let enumeratedChain = false;
  let degraded: { reason: string; detail: string; unaccountedBelow?: bigint } | null = null;

  if (ahead.length > 0) {
    // The journal claims settlements the chain has not performed. That can only
    // mean the journal is describing a different account, a different deployment,
    // or a reorg that un-mined a confirmed settlement. All three need a human:
    // "the money went twice" and "the money never went" are not distinguishable
    // by retrying.
    degraded = {
      reason: "NONCE_REGRESSION",
      detail:
        `the journal records settlements at settlementNonce ${describeNonces(ahead)} but the chain ` +
        `reports only ${observed} consumed. Either this state directory belongs to another ` +
        "account/deployment, or a confirmed settlement was un-mined.",
    };
  } else if (missing.length > 0) {
    logger.warn("chain has settlements the journal cannot name; rebuilding from SettlementExecuted logs", {
      unaccountedNonces: missing.map(String),
      observedSettlementNonce: observed.toString(),
      acknowledgedNonceFloor: ledger.state.acknowledgedNonceFloor.toString(),
      journalSettlementRecords: journalSettlementTotal(ledger.state),
      logsFromBlockL2: input.logsFromBlockL2.toString(),
    });
    enumeratedChain = true;
    const { settlements, undecodable } = await enumerateChainSettlements(chain, account, input.logsFromBlockL2);
    // ADOPTED IN settlementNonce ORDER, always. The vault consumes nonces
    // strictly in order, so that is the order the settled L2 coverage happened
    // in, and the frontier chain has to be built in that order to stay
    // contiguous. The log list arrives in whatever order the provider felt like.
    const ordered = [...settlements].sort((a, b) =>
      a.settlementNonce === b.settlementNonce ? 0 : a.settlementNonce < b.settlementNonce ? -1 : 1,
    );
    const l1Cache = new Map<string, bigint>();
    let headBlockL2: bigint | null = null;
    for (const settlement of ordered) {
      if (ledger.state.settledSessionIds.has(settlement.sessionId.toLowerCase())) continue;
      if (headBlockL2 === null) headBlockL2 = await chain.getHeadBlockL2();
      // THE ATTESTATION NOW CARRIES THE L2 WINDOW, so the ordinary case is a
      // direct read rather than a recovery. That is not a shortcut, it is a
      // strictly better answer: the clamp below deliberately claims a SUPERSET
      // of the true window (many L2 blocks map to one L1 block), and a superset
      // frontier forfeits any genuine session that hid inside an already-consumed
      // L1 block. Reading the exact pair the attester signed costs nothing, needs
      // no RPC, and forfeits nothing.
      //
      // The clamp STAYS as the fallback and is not weakened. It still serves
      // anything that cannot declare its own window: a settlement made before
      // these fields existed, or an attestation that left them zero. An
      // inconsistent pair falls back too rather than being trusted — the whole
      // reason to prefer this path is that it is exact, so a pair that cannot be
      // a window is not evidence of anything.
      const declaredL2 =
        settlement.startBlockL2 !== null &&
        settlement.endBlockL2 !== null &&
        settlement.startBlockL2 > 0n &&
        settlement.endBlockL2 >= settlement.startBlockL2
          ? { startBlockL2: settlement.startBlockL2, endBlockL2: settlement.endBlockL2 }
          : null;
      //
      // The COVERED case survives the shortcut and must: settlements are adopted
      // in chain order but a frontier can already be ahead of one of them, and
      // the store's frontier chain is a hard constraint
      // (start_block_l2 > prev_end_block_l2, enforced by a CHECK and a trigger).
      // An EXACT window at or below the frontier would be REFUSED by the store,
      // which turns a routine out-of-order adoption into STORE_REFUSED. It makes
      // no new coverage claim either way, so it is recorded as COVERED — exactly
      // what the clamp does with the same situation.
      const frontier = ledger.state.settledFrontierL2;
      const window: RecoveredWindow =
        declaredL2 === null
          ? await recoverL2Window(chain, headBlockL2, settlement, frontier, l1Cache)
          : {
              ...declaredL2,
              precision: frontier !== null && declaredL2.startBlockL2 <= frontier ? "COVERED" : "EXACT",
              detail:
                `L2 [${declaredL2.startBlockL2}, ${declaredL2.endBlockL2}] read directly from the settle ` +
                "calldata, which now commits the L2 window the vault progresses on" +
                (frontier !== null && declaredL2.startBlockL2 <= frontier
                  ? `; it starts at or below the settled frontier ${frontier}, so it makes no new coverage claim`
                  : ""),
            };
      logger.info("adopting a settlement from chain evidence", {
        sessionId: settlement.sessionId,
        settlementNonce: settlement.settlementNonce.toString(),
        bindingEpoch: settlement.bindingEpoch.toString(),
        windowL1: [settlement.startBlockL1.toString(), settlement.endBlockL1.toString()],
        windowL2: [window.startBlockL2.toString(), window.endBlockL2.toString()],
        l2Precision: window.precision,
        l2Detail: window.detail,
      });
      await ledger.append("ADOPTED", {
        startBlockL2: window.startBlockL2,
        endBlockL2: window.endBlockL2,
        l2Precision: window.precision,
        sessionId: settlement.sessionId,
        bindingEpoch: settlement.bindingEpoch,
        settlementNonce: settlement.settlementNonce,
        startBlockL1: settlement.startBlockL1,
        endBlockL1: settlement.endBlockL1,
        ledgerRoot: settlement.ledgerRoot,
        contribution: settlement.contribution,
        realizedProfit: settlement.realizedProfit,
        txHash: settlement.txHash,
        blockNumberL2: settlement.blockNumberL2,
        gasUsed: 0n,
        source: "adopted",
      });
      adopted += 1;
    }
    missing = unaccountedNonces(ledger.state, observed);
    // Recomputed, not assumed: the scan can surface a settlement whose nonce is at
    // or beyond the snapshot we read, which means the snapshot is already stale.
    ahead = noncesAheadOfChain(ledger.state, observed);
    logger.info("chain rebuild finished", {
      adopted,
      settlementsFound: settlements.length,
      undecodable: undecodable.length,
      stillUnaccountedNonces: missing.map(String),
      noncesAheadOfSnapshot: ahead.map(String),
    });

    if (undecodable.length > 0) {
      degraded = {
        reason: "UNDECODABLE_SETTLEMENT",
        detail:
          `SettlementExecuted logs whose calldata could not be decoded as settle(): ${undecodable.join(", ")}. ` +
          "A settlement happened by a route this keeper does not understand, so its model of history is incomplete.",
        ...(missing.length > 0 ? { unaccountedBelow: observed } : {}),
      };
    } else if (missing.length > 0) {
      // OPTION (b), AND THE ONLY HONEST ONE LEFT. The authoritative rebuild ran
      // and still cannot account for these nonces, so the keeper does not know
      // the boundary of at least one real settlement. The usual cause is benign
      // and fixable: NUVEM_KEEPER_FROM_BLOCK / the log floor sits above the
      // settlement, so raising nothing and simply lowering the floor recovers it.
      // The cause that matters is not benign: a provider that answered a capped
      // eth_getLogs range with an empty list rather than an error.
      //
      // Either way the keeper must not proceed as if reconciled — that is the
      // precise failure this whole function exists to prevent. It halts, and an
      // operator who has verified the history by hand can accept the shortfall
      // with `--acknowledge-degraded <seq>`. That acknowledgement is durable and
      // BOUNDED: unaccountedBelow travels into the RESUMED record's derived
      // floor, so it excuses these nonces once and never covers a settlement that
      // happens afterwards.
      degraded = {
        reason: "UNACCOUNTED_SETTLEMENTS",
        detail:
          `the chain reports ${observed} consumed settlement nonce(s) for ${account} and the journal ` +
          `cannot name ${describeNonces(missing)} even after scanning SettlementExecuted from L2 block ` +
          `${input.logsFromBlockL2}. The block boundary of at least one real settlement is therefore ` +
          "unknown, and PersonalVault exposes no getter for lastEndBlock, so it cannot be read back. " +
          "Refusing to settle: an absent local record must never be read as an absent settlement. " +
          "Lower NUVEM_KEEPER_LOGS_FROM_BLOCK so the scan covers the missing settlement and restart; " +
          "if you have verified the history by hand, accept the shortfall with --acknowledge-degraded.",
        unaccountedBelow: observed,
      };
    }
  }

  // ANY EVIDENCE THAT THIS STORE IS NOT A COMPLETE RECORD OF WHAT THE KEEPER DID
  // must be surfaced next to the chain accounting it affects, not only on
  // /status, which is where it used to gate nothing. Under JSONL that evidence
  // was a torn tail; under ACID it is a record that fails its integrity digest, a
  // gap in the seq run, or an adopted settlement whose L2 coverage is unknown.
  // None of these halts on its own — localEligibility already refuses everything
  // — but all of them have to be readable beside the nonce accounting.
  if (!ledger.state.integrityOk || ledger.state.coverageUnresolved > 0) {
    logger.warn("this store is not a complete record of what this keeper did", {
      integrityOk: ledger.state.integrityOk,
      integrityDetail: ledger.state.integrityDetail,
      coverageUnresolved: ledger.state.coverageUnresolved,
      unaccountedNonces: missing.map(String),
      squaredAgainstChain: missing.length === 0 && ahead.length === 0,
    });
  }

  // ---- Phase C -------------------------------------------------------------
  const nonceReconciled = missing.length === 0 && ahead.length === 0;
  if (degraded === null && !nonceReconciled) {
    degraded = {
      reason: "NONCE_UNRECONCILED",
      detail:
        (missing.length > 0
          ? `the journal cannot account for settlement nonce(s) ${describeNonces(missing)}`
          : `the journal records settlements at settlementNonce ${describeNonces(ahead)} that the chain has not reached`) +
        ` against a chain settlementNonce of ${observed}. Refusing to settle with an incomplete model of history.`,
      ...(missing.length > 0 ? { unaccountedBelow: observed } : {}),
    };
  }
  if (degraded !== null && ledger.state.degraded === null) {
    await ledger.append("DEGRADED", degraded);
    logger.error("keeper halted", { reason: degraded.reason, detail: degraded.detail });
  }

  return {
    resolvedIntents,
    adopted,
    degraded: degraded === null ? null : { reason: degraded.reason, detail: degraded.detail },
    nonceReconciled,
    // The CAS token embedded in the next attestation. When the accounting squares
    // it is the chain's own nonce. When it does not, it is deliberately the LOWEST
    // nonce the keeper cannot explain: if anything ever reached chainEligibility
    // in that state, NONCE_AGREEMENT refuses instead of waving it through.
    expectedSettlementNonce: nonceReconciled ? observed : (missing[0] ?? observed),
    observedSettlementNonce: observed,
    enumeratedChain,
    unaccountedNonces: missing,
  };
}

// ---------------------------------------------------------------------------
// Chain-derived eligibility: the two rules that survive total local state loss.
// ---------------------------------------------------------------------------
export type ChainEligibility =
  | { readonly ok: true }
  | { readonly ok: false; readonly rule: string; readonly detail: string };

export interface ChainCandidate {
  readonly sessionId: Hex;
  readonly account: `0x${string}`;
  readonly expectedSettlementNonce: bigint;
}

/**
 * CHAIN NOVELTY plus the settlementNonce compare-and-swap.
 *
 * The nonce check is not a race we might lose — it is a CAS token. The value is
 * embedded in the signed attestation and checked at _validateCurrentVaultState,
 * so any settlement the keeper failed to account for makes its own broadcast
 * revert InvalidSettlementNonce rather than pay twice. Checking it here just
 * saves the gas.
 */
export async function chainEligibility(
  chain: ChainAccess,
  snapshot: VaultSnapshot,
  candidate: ChainCandidate,
  logsFromBlockL2: bigint,
): Promise<ChainEligibility> {
  if (snapshot.settlementNonce !== candidate.expectedSettlementNonce) {
    return {
      ok: false,
      rule: "NONCE_AGREEMENT",
      detail:
        `chain settlementNonce ${snapshot.settlementNonce} != expected ${candidate.expectedSettlementNonce}. ` +
        "Something settled outside this keeper; reconcile before signing.",
    };
  }

  // sessionId is indexed, so this is one node-side filtered call and needs no
  // scan. It answers "was this exact window, with these exact numbers, already
  // settled?" without trusting a single byte of local state.
  const logs = await chain.getSettlementLogs({ fromBlockL2: logsFromBlockL2, sessionId: candidate.sessionId });
  const already = logs.some((log) => log.account.toLowerCase() === candidate.account.toLowerCase());
  if (already) {
    return {
      ok: false,
      rule: "CHAIN_NOVELTY",
      detail: `SettlementExecuted already exists onchain for sessionId ${candidate.sessionId}`,
    };
  }
  return { ok: true };
}
