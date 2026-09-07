// Broadcast, and the dry-run gate.
//
// TWO THINGS THIS FILE EXISTS FOR.
//
// 1. DRY RUN BY DEFAULT, STRUCTURALLY. The mode check is the first statement in
//    `submitSettlement`, and it returns before the transaction signer or the
//    sender is touched. It is not the only defence — config.ts refuses to even
//    read the trading key outside live mode, so in a dry run the process does
//    not hold a key capable of broadcasting — but it is the one that is directly
//    testable, and test/submit.test.ts asserts it by handing dry-run mode a
//    signer and a sender that throw if called.
//
// 2. THE CRASH-AFTER-BROADCAST WINDOW IS CLOSED BY ORDERING, NOT BY DETECTION.
//    settle.mjs does `simulateContract` then `writeContract(request)`, where
//    viem picks the nonce internally and the transaction hash is unknown until
//    after the send has already happened. That is fine for a human watching a
//    terminal and fatal for an unattended service: crash in that gap and there
//    is no record of what was sent, or with which nonce.
//
//    So the keeper owns both. viem can sign a transaction locally and hand back
//    the raw bytes, whose keccak IS the transaction hash, before anything
//    reaches the network. The order is therefore:
//
//        reserve nonce -> estimate -> sign locally -> APPEND INTENT + fsync -> send
//
//    Crash anywhere and exactly one of these is true: nothing was sent and no
//    local trace exists (the window is simply still unsettled), or an INTENT
//    exists carrying the exact nonce and raw hash, and reconcile.ts can ask the
//    chain which it was. There is no third case. A torn journal line degrades
//    into the second case, which is why a torn write is not corruption.
//
// This single change — owning the nonce and the hash — is the most important
// difference between this package and the reference script.

import type { JournalStore } from "./journal-store.js";
import { keccak256, type Hex } from "viem";
import type { KeeperMode } from "./config.js";
import type { ChainAccess, SettlementAttestation } from "./onchain.js";
import { encodeSettleCalldata } from "./onchain.js";
import { Ledger, localEligibility, type IntentBody, type LedgerState } from "./ledger.js";
import type { Logger } from "./log.js";

/**
 * Signs a raw EIP-1559 transaction. A viem LocalAccount satisfies this.
 *
 * `signTransaction` and not `sendTransaction`, on purpose: the keeper must hold
 * the serialized bytes — and therefore the hash — before the network sees them.
 */
export interface TradingSigner {
  readonly address: `0x${string}`;
  signTransaction(transaction: {
    to: `0x${string}`;
    value: bigint;
    data: Hex;
    nonce: number;
    gas: bigint;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
    chainId: number;
    type: "eip1559";
  }): Promise<Hex>;
}

/** Exactly what would be, or was, put on the wire. */
export interface SettlePlan {
  readonly from: `0x${string}`;
  readonly to: `0x${string}`;
  readonly value: bigint;
  readonly data: Hex;
  readonly dataHash: Hex;
  readonly chainId: number;
  readonly gasLimit: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly estimatedGasCostWei: bigint;
  /** null in a dry run: no nonce is reserved because nothing will be sent. */
  readonly nonce: number | null;
  readonly attestation: SettlementAttestation;
  readonly digest: Hex;
}

export type SubmitResult =
  | { readonly kind: "DRY_RUN"; readonly plan: SettlePlan }
  | { readonly kind: "BLOCKED"; readonly reason: string; readonly detail: string }
  | {
      readonly kind: "CONFIRMED";
      readonly plan: SettlePlan;
      readonly txHash: Hex;
      readonly blockNumberL2: bigint;
      readonly gasUsed: bigint;
    }
  | { readonly kind: "FAILED"; readonly plan: SettlePlan; readonly txHash: Hex }
  /** Sent, but no receipt within the attestation's own deadline. reconcile resolves it. */
  | { readonly kind: "UNRESOLVED"; readonly plan: SettlePlan; readonly rawTxHash: Hex };

export interface SubmitInput {
  readonly mode: KeeperMode;
  readonly chain: ChainAccess;
  readonly ledger: JournalStore;
  readonly logger: Logger;
  readonly attestation: SettlementAttestation;
  readonly signature: Hex;
  readonly digest: Hex;
  readonly chainId: number;
  readonly executor: `0x${string}`;
  readonly account: `0x${string}`;
  /** The L2 window, carried through so the journal keys on it rather than on L1. */
  readonly startBlockL2: bigint;
  readonly endBlockL2: bigint;
  readonly attesterAddress: `0x${string}`;
  readonly reportCash: {
    readonly cashStart: bigint;
    readonly cashEnd: bigint;
    readonly externalDeposits: bigint;
    readonly externalWithdrawals: bigint;
  };
  readonly limits: { readonly maxSettlementsPerDay: number };
  /** Absent in dry-run mode, by construction. */
  readonly tradingSigner: TradingSigner | null;
  readonly nowMs?: number;
}

/** The gas a mainnet settle actually used, plus room. Only a fallback. */
const FALLBACK_GAS_LIMIT = 900_000n;

export interface PlanInput {
  readonly chain: ChainAccess;
  readonly logger: Logger;
  readonly attestation: SettlementAttestation;
  readonly signature: Hex;
  readonly digest: Hex;
  readonly chainId: number;
  readonly executor: `0x${string}`;
  readonly account: `0x${string}`;
  /** null in a dry run: no nonce is reserved because nothing will be sent. */
  readonly nonce: number | null;
}

/**
 * Assembles the exact transaction. Shared by the dry-run path, the live send and
 * the `verify` command, so what a dry run shows is byte-identical to what a live
 * run would put on the wire — not a separate description of it.
 *
 * estimateGas runs the whole settle against current state, so it doubles as the
 * "would this actually work" check, and a dry run does it too. That is what makes
 * "it worked in dry run" mean something. When it reverts, the revert is reported
 * and the fallback limit is used: the estimate is diagnostic, not a gate.
 */
export async function planSettlement(input: PlanInput): Promise<SettlePlan> {
  const data = encodeSettleCalldata(input.attestation, input.signature);
  const fees = await input.chain.getFeeQuote();

  let gasLimit = FALLBACK_GAS_LIMIT;
  try {
    const estimated = await input.chain.estimateSettleGas({
      account: input.account,
      attestation: input.attestation,
      signature: input.signature,
    });
    gasLimit = (estimated * 12n) / 10n;
  } catch (error) {
    input.logger.warn("settle gas estimation reverted; using the fallback limit", {
      estimateError: ((error as Error).message ?? "unknown").slice(0, 400),
      fallbackGasLimit: FALLBACK_GAS_LIMIT.toString(),
    });
  }

  return {
    from: input.account,
    to: input.executor,
    value: input.attestation.contribution,
    data,
    dataHash: keccak256(data),
    chainId: input.chainId,
    gasLimit,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    estimatedGasCostWei: gasLimit * fees.maxFeePerGas,
    nonce: input.nonce,
    attestation: input.attestation,
    digest: input.digest,
  };
}

const buildPlan = (input: SubmitInput, nonce: number | null): Promise<SettlePlan> =>
  planSettlement({
    chain: input.chain,
    logger: input.logger,
    attestation: input.attestation,
    signature: input.signature,
    digest: input.digest,
    chainId: input.chainId,
    executor: input.executor,
    account: input.account,
    nonce,
  });

/** The dry-run/live decision, and the intent-before-broadcast ordering. */
export async function submitSettlement(input: SubmitInput): Promise<SubmitResult> {
  // ---- gate 1: the mode. Before the signer or the sender is touched. --------
  if (input.mode !== "live") {
    const plan = await buildPlan(input, null);
    await input.ledger.append("DRYRUN", {
      startBlockL2: input.startBlockL2,
      endBlockL2: input.endBlockL2,
      sessionId: input.attestation.sessionId,
      bindingEpoch: input.attestation.bindingEpoch,
      settlementNonce: input.attestation.settlementNonce,
      startBlockL1: input.attestation.startBlock,
      endBlockL1: input.attestation.endBlock,
      ledgerRoot: input.attestation.ledgerRoot,
      contribution: input.attestation.contribution,
      realizedProfit: input.attestation.realizedProfit,
      attestationDigest: input.digest,
      attester: input.attesterAddress,
      wouldSendTo: input.executor,
      wouldSendValue: input.attestation.contribution,
    });
    return { kind: "DRY_RUN", plan };
  }

  // ---- gate 2: the key. Live mode without a spending key cannot proceed. ----
  if (input.tradingSigner === null) {
    return {
      kind: "BLOCKED",
      reason: "NO_TRADING_KEY",
      detail: "live mode reached submit with no trading signer; refusing rather than guessing",
    };
  }
  if (input.tradingSigner.address.toLowerCase() !== input.account.toLowerCase()) {
    // msg.sender MUST be the trading account: SettlementExecutor resolves the
    // vault via factory.activeVaultOf(msg.sender). A different signer would
    // resolve to the zero vault and revert.
    return {
      kind: "BLOCKED",
      reason: "WRONG_SENDER",
      detail: `trading signer ${input.tradingSigner.address} is not the trading account ${input.account}`,
    };
  }

  // ---- gate 3: local eligibility, re-checked at the last possible moment ----
  const state: LedgerState = input.ledger.state;
  const eligible = localEligibility(
    state,
    {
      startBlockL2: input.startBlockL2,
      endBlockL2: input.endBlockL2,
      startBlockL1: input.attestation.startBlock,
      endBlockL1: input.attestation.endBlock,
      bindingEpoch: input.attestation.bindingEpoch,
      sessionId: input.attestation.sessionId,
    },
    input.limits,
    input.nowMs ?? Date.now(),
  );
  if (!eligible.ok) {
    return { kind: "BLOCKED", reason: eligible.rule, detail: eligible.detail };
  }

  // ---- reserve the nonce, sign locally, WRITE THE INTENT, then send ---------
  const nonce = await input.chain.getPendingTransactionCount(input.account);
  const plan = await buildPlan(input, nonce);

  const raw = await input.tradingSigner.signTransaction({
    to: plan.to,
    value: plan.value,
    data: plan.data,
    nonce,
    gas: plan.gasLimit,
    maxFeePerGas: plan.maxFeePerGas,
    maxPriorityFeePerGas: plan.maxPriorityFeePerGas,
    chainId: plan.chainId,
    type: "eip1559",
  });
  // The hash of a signed transaction is the keccak of its serialization. Knowing
  // it before the send is the whole point of this ordering.
  const rawTxHash = keccak256(raw);

  const intent: IntentBody = {
    startBlockL2: input.startBlockL2,
    endBlockL2: input.endBlockL2,
    sessionId: input.attestation.sessionId,
    bindingEpoch: input.attestation.bindingEpoch,
    settlementNonce: input.attestation.settlementNonce,
    startBlockL1: input.attestation.startBlock,
    endBlockL1: input.attestation.endBlock,
    ledgerRoot: input.attestation.ledgerRoot,
    contribution: input.attestation.contribution,
    realizedProfit: input.attestation.realizedProfit,
    attestationDigest: input.digest,
    attester: input.attesterAddress,
    eoaNonce: nonce,
    rawTxHash,
    gasLimit: plan.gasLimit,
    maxFeePerGas: plan.maxFeePerGas,
    validAfter: input.attestation.validAfter,
    deadline: input.attestation.deadline,
    cashStart: input.reportCash.cashStart,
    cashEnd: input.reportCash.cashEnd,
    externalDeposits: input.reportCash.externalDeposits,
    externalWithdrawals: input.reportCash.externalWithdrawals,
  };
  await input.ledger.append("INTENT", intent);

  // THE INTENT MUST BE DURABLE BEFORE ANYTHING IS SENT. Nothing in this project
  // lints for a floating promise, so a missing `await` anywhere on this path
  // would compile, run, and leave the record only on a filesystem the next
  // container will not have — producing a settlement that moved real money with
  // no record to reconcile it against. This check is a length comparison, and it
  // is the difference between that and a keeper that refused to send.
  input.ledger.assertDurable();

  input.logger.info("intent recorded; broadcasting", {
    sessionId: input.attestation.sessionId,
    rawTxHash,
    eoaNonce: nonce,
    contribution: plan.value.toString(),
  });

  // Everything above this line is reversible. Nothing below it is.
  let sent: Hex;
  try {
    sent = await input.chain.sendRawTransaction(raw);
  } catch (error) {
    // The send itself failed, but "failed" is not "definitely not broadcast":
    // a timeout can hide a transaction that reached the mempool. The INTENT is
    // already durable, so leave it open and let reconcile.ts settle the question
    // against the chain rather than guessing here.
    input.logger.error("sendRawTransaction failed; intent left open for reconciliation", { error });
    return { kind: "UNRESOLVED", plan, rawTxHash };
  }

  // Bound the wait by the attestation's own deadline. Past it, the transaction
  // can only revert AttestationExpired, so waiting longer proves nothing.
  const remainingMs = Math.max(15_000, (input.attestation.deadline - Math.floor(Date.now() / 1000)) * 1000);
  const receipt = await input.chain.waitForReceipt(sent, remainingMs);
  if (receipt === null) {
    return { kind: "UNRESOLVED", plan, rawTxHash };
  }

  if (receipt.status === "reverted") {
    await input.ledger.append("FAILED", {
      startBlockL2: input.startBlockL2,
      endBlockL2: input.endBlockL2,
      sessionId: input.attestation.sessionId,
      txHash: receipt.transactionHash,
      reason: "mined with status 0: gas burned, no funds moved, EOA nonce consumed",
    });
    return { kind: "FAILED", plan, txHash: receipt.transactionHash };
  }

  await input.ledger.append("CONFIRMED", {
    startBlockL2: input.startBlockL2,
    endBlockL2: input.endBlockL2,
    sessionId: input.attestation.sessionId,
    bindingEpoch: input.attestation.bindingEpoch,
    settlementNonce: input.attestation.settlementNonce,
    startBlockL1: input.attestation.startBlock,
    endBlockL1: input.attestation.endBlock,
    ledgerRoot: input.attestation.ledgerRoot,
    contribution: input.attestation.contribution,
    realizedProfit: input.attestation.realizedProfit,
    txHash: receipt.transactionHash,
    blockNumberL2: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
    source: "own",
  });
  return {
    kind: "CONFIRMED",
    plan,
    txHash: receipt.transactionHash,
    blockNumberL2: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
  };
}

/** The human-readable "this is exactly what would be sent" block. */
export function describePlan(plan: SettlePlan, includeCalldata: boolean): Record<string, unknown> {
  const a = plan.attestation;
  return {
    from: plan.from,
    to: plan.to,
    valueWei: plan.value.toString(),
    valueEth: `${Number(plan.value) / 1e18}`,
    chainId: plan.chainId,
    nonce: plan.nonce,
    gasLimit: plan.gasLimit.toString(),
    maxFeePerGas: plan.maxFeePerGas.toString(),
    maxPriorityFeePerGas: plan.maxPriorityFeePerGas.toString(),
    estimatedGasCostWei: plan.estimatedGasCostWei.toString(),
    calldataBytes: (plan.data.length - 2) / 2,
    calldataHash: plan.dataHash,
    // The full blob is opt-in only to keep routine logs legible. It is not
    // withheld for secrecy: an attester signature is not a spending authority
    // (the contract recomputes profit and requires msg.sender to supply
    // msg.value), and being able to hand the exact calldata to a human submitter
    // is the zero-custody fallback path.
    ...(includeCalldata ? { calldata: plan.data } : {}),
    attestationDigest: plan.digest,
    attestation: {
      account: a.account,
      vault: a.vault,
      executor: a.executor,
      chainId: a.chainId.toString(),
      bindingEpoch: a.bindingEpoch.toString(),
      policyNonce: a.policyNonce.toString(),
      adminEpoch: a.adminEpoch.toString(),
      localPauseEpoch: a.localPauseEpoch.toString(),
      globalPauseEpoch: a.globalPauseEpoch.toString(),
      settlementNonce: a.settlementNonce.toString(),
      policyHash: a.policyHash,
      sessionId: a.sessionId,
      ledgerRoot: a.ledgerRoot,
      startBlockL1: a.startBlock.toString(),
      endBlockL1: a.endBlock.toString(),
      cashStart: a.cashStart.toString(),
      cashEnd: a.cashEnd.toString(),
      externalDeposits: a.externalDeposits.toString(),
      externalWithdrawals: a.externalWithdrawals.toString(),
      realizedProfit: a.realizedProfit.toString(),
      contribution: a.contribution.toString(),
      attesterEpoch: a.attesterEpoch,
      validAfter: a.validAfter,
      deadline: a.deadline,
    },
  };
}
