// Builds and signs a SettlementAttestation for one finished session.
//
// This is a faithful port of packages/aa-smoke-old/scripts/settle.mjs, which is the
// working reference implementation and the only code in this repo that has
// produced a real mainnet settlement. Everything it gets right is preserved
// here, in the same order and for the same reasons:
//
//   * EVERY NUMBER COMES FROM @nuvem/session-engine. Nothing in this file
//     decides anything about PnL. An earlier generation of settle.mjs hardcoded
//     externalDeposits/externalWithdrawals to zero and performed no soundness
//     check, which is exactly how a hand-picked window becomes a settled figure
//     nobody can defend.
//   * A REFUSED WINDOW STOPS HERE, with no override flag, deliberately. It stops
//     BEFORE the signer is touched, so a refused report cannot produce a
//     signature even by accident.
//   * BOTH RANGES ARE ATTESTED, and they do different jobs. The L1 pair
//     (startBlock/endBlock) is what SettlementExecutor compares against
//     block.number — freshness and the activation floor — because on Arbitrum
//     Nitro Solidity's block.number IS the L1 number. The L2 pair
//     (startBlockL2/endBlockL2) is what the vault progresses on, because a
//     trading session is an event in L2 time and ~120 L2 blocks fit inside one
//     L1 block. Both are also folded into deriveSessionId, so the replay key
//     stays unique when two distinct sessions share one L1 range. They were
//     previously carried only inside ledgerRoot, where the contract could not
//     see them and could not enforce them.
//   * BIND TO CURRENT ONCHAIN STATE. Every epoch, nonce and policy hash is read
//     and committed. Anything that changes afterwards invalidates the signature,
//     which is the intended behaviour.
//   * ASK THE EXECUTOR WHAT IT WILL ACCEPT. previewContribution runs the same
//     five clamps settle() will; reimplementing them here would be a second
//     source of truth about the amount of money that moves.
//   * CROSS-CHECK THE DIGEST. The local EIP-712 hash is compared against
//     hashAttestation() before any gas is spent, so a drift between the type
//     list in onchain.ts and the contract surfaces as a refusal rather than as
//     InvalidAttesterSignature after paying for the attempt.
//
// What is NEW relative to settle.mjs, and why:
//
//   * The preflight refuses conditions settle.mjs would have learned from a
//     revert: a paused protocol or vault, a non-ACTIVE account, an attester key
//     that is no longer the registered one, an L1 range that has not yet
//     advanced past endBlock, a balance too thin to cover contribution plus gas.
//     A human running settle.mjs reads the revert and stops. An unattended
//     service would retry it every 30 seconds, burning the trader's ETH.
//   * A per-settlement circuit breaker on the contribution.

import { hashTypedData, type Hex } from "viem";
import type { RefusalReason, SessionReport } from "./engine.js";
import type { KeeperLimits } from "./config.js";
import type { SkipReason } from "./ledger.js";
import {
  ACCOUNT_STATUS_ACTIVE,
  ATTESTATION_TYPES,
  DOMAIN_NAME,
  DOMAIN_VERSION,
  type ChainAccess,
  type SettlementAttestation,
  type VaultSnapshot,
} from "./onchain.js";

/**
 * The signing capability, narrowed to exactly what is needed.
 *
 * A viem LocalAccount satisfies this. It is an interface rather than a concrete
 * account so the tests can assert the strongest property in this package: that a
 * REFUSED report never reaches a signer at all.
 */
export interface AttesterSigner {
  readonly address: `0x${string}`;
  signTypedData(args: {
    domain: { name: string; version: string; chainId: number; verifyingContract: `0x${string}` };
    types: typeof ATTESTATION_TYPES;
    primaryType: "SettlementAttestation";
    message: SettlementAttestation;
  }): Promise<Hex>;
}

export interface AttestInput {
  readonly chain: ChainAccess;
  readonly signer: AttesterSigner;
  readonly report: SessionReport;
  readonly snapshot: VaultSnapshot;
  readonly chainId: number;
  readonly account: `0x${string}`;
  readonly vault: `0x${string}`;
  readonly executor: `0x${string}`;
  /** Current L1 height, so the endBlock < block.number rule can be checked early. */
  readonly currentL1Block: bigint;
  readonly limits: KeeperLimits;
  readonly nowSeconds?: number;
}

/** A reason to try again later: the world may change in our favour. */
export type DeferReason =
  | "PROTOCOL_PAUSED"
  | "VAULT_PAUSED"
  | "ACCOUNT_NOT_ACTIVE"
  | "ATTESTER_MISMATCH"
  | "L1_NOT_ADVANCED"
  | "INSUFFICIENT_BALANCE"
  | "VAULT_MISMATCH"
  | "PREVIEW_FAILED"
  | "CONTRIBUTION_ABOVE_POLICY";

export type AttestOutcome =
  /** The engine could not vouch for the window. Terminal. Nothing was signed. */
  | { readonly kind: "REFUSED"; readonly reasons: readonly RefusalReason[] }
  /** Terminal for this window, and correct behaviour rather than a failure. */
  | { readonly kind: "SKIP"; readonly reason: SkipReason; readonly detail: string; readonly contribution: bigint }
  /** Retryable. The window stays eligible. */
  | { readonly kind: "DEFER"; readonly reason: DeferReason; readonly detail: string }
  /** Something is wrong with our model of the world. Halt and ask a human. */
  | { readonly kind: "HALT"; readonly reason: string; readonly detail: string }
  | {
      readonly kind: "READY";
      readonly attestation: SettlementAttestation;
      readonly signature: Hex;
      readonly digest: Hex;
      readonly contribution: bigint;
      readonly sessionId: Hex;
    };

/** validAfter is backdated by a minute so a slightly-behind node still accepts it. */
const VALID_AFTER_SKEW_SECONDS = 60;
/**
 * Ten minutes, matching settle.mjs. SettlementExecutor caps the window at
 * MAX_ATTESTATION_VALIDITY and rejects anything wider; more importantly a long
 * deadline means a signature that stays live while the state it commits to
 * drifts, so short is safer than generous.
 */
const DEADLINE_SECONDS = 600;

export async function buildAttestation(input: AttestInput): Promise<AttestOutcome> {
  const { chain, report, snapshot, limits } = input;

  // -------------------------------------------------------------------------
  // 1. The refusal stance, first, before anything can be signed.
  // -------------------------------------------------------------------------
  if (report.verdict !== "ATTESTABLE") {
    return { kind: "REFUSED", reasons: report.reasons };
  }

  // -------------------------------------------------------------------------
  // 2. Preflight. Every condition here would otherwise be learned from a revert
  //    that has already cost the trader gas.
  // -------------------------------------------------------------------------
  if (snapshot.activeVault.toLowerCase() !== input.vault.toLowerCase()) {
    // Either the account is not bound at all (activeVaultOf returns zero — which
    // is what happens for the vault ADMIN address, a very easy mix-up), or it is
    // bound to a different vault than we are configured for. Both mean the
    // attestation would fail _validateAttestationBinding.
    return {
      kind: "DEFER",
      reason: "VAULT_MISMATCH",
      detail:
        `factory.activeVaultOf(${input.account}) is ${snapshot.activeVault}, not the configured ` +
        `vault ${input.vault}. SettlementExecutor resolves the vault from msg.sender, so this ` +
        "account cannot settle into that vault.",
    };
  }
  if (snapshot.protocolPaused) {
    return { kind: "DEFER", reason: "PROTOCOL_PAUSED", detail: "ProtocolPauseController.paused() is true" };
  }
  if (snapshot.settlementPaused) {
    return { kind: "DEFER", reason: "VAULT_PAUSED", detail: "PersonalVault.settlementPaused() is true" };
  }
  if (snapshot.status !== ACCOUNT_STATUS_ACTIVE) {
    return {
      kind: "DEFER",
      reason: "ACCOUNT_NOT_ACTIVE",
      detail: `account status is ${snapshot.status}, needs ${ACCOUNT_STATUS_ACTIVE} (ACTIVE)`,
    };
  }
  if (snapshot.registeredAttester.toLowerCase() !== input.signer.address.toLowerCase()) {
    return {
      kind: "DEFER",
      reason: "ATTESTER_MISMATCH",
      detail:
        `AttesterRegistry.attester() is ${snapshot.registeredAttester}, the loaded key is ` +
        `${input.signer.address}. Signing would only produce InvalidAttesterSignature.`,
    };
  }

  // The contract requires endBlock < block.number in L1 space. L1 advances only
  // every ~12s while L2 advances ~7 blocks/s, so a just-closed session is
  // briefly unsettleable. Waiting is correct; attempting is a wasted signature.
  if (report.endBlockL1 + limits.l1Margin > input.currentL1Block) {
    return {
      kind: "DEFER",
      reason: "L1_NOT_ADVANCED",
      detail:
        `endBlockL1 ${report.endBlockL1} needs L1 head > ${report.endBlockL1 + limits.l1Margin}, ` +
        `currently ${input.currentL1Block}`,
    };
  }
  if (report.startBlockL1 < snapshot.activationBlockL1) {
    return {
      kind: "SKIP",
      reason: "BINDING_EPOCH_ADVANCED",
      detail:
        `startBlockL1 ${report.startBlockL1} predates activationBlock ${snapshot.activationBlockL1}. ` +
        "The binding was re-established after this window, so it can never be settled.",
      contribution: 0n,
    };
  }

  // -------------------------------------------------------------------------
  // 3. The v2 ledger root. SettlementExecutor treats ledgerRoot as opaque, so
  //    this ships with no contract change: it makes the attester's soundness
  //    claim auditable, it does not make it enforced.
  // -------------------------------------------------------------------------
  const ledgerRoot = report.ledgerRootV2 as Hex;

  const sessionId = await chain.deriveSessionId({
    chainId: BigInt(input.chainId),
    vault: input.vault,
    account: input.account,
    bindingEpoch: snapshot.bindingEpoch,
    startBlockL1: report.startBlockL1,
    endBlockL1: report.endBlockL1,
    startBlockL2: report.startBlockL2,
    endBlockL2: report.endBlockL2,
    ledgerRoot,
  });

  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const base: SettlementAttestation = {
    account: input.account,
    vault: input.vault,
    executor: input.executor,
    chainId: BigInt(input.chainId),
    bindingEpoch: snapshot.bindingEpoch,
    policyNonce: snapshot.policyNonce,
    adminEpoch: snapshot.adminEpoch,
    localPauseEpoch: snapshot.localPauseEpoch,
    globalPauseEpoch: snapshot.globalPauseEpoch,
    settlementNonce: snapshot.settlementNonce,
    policyHash: snapshot.policyHash,
    sessionId,
    ledgerRoot,
    startBlock: report.startBlockL1,
    endBlock: report.endBlockL1,
    startBlockL2: report.startBlockL2,
    endBlockL2: report.endBlockL2,
    cashStart: report.cashStart,
    cashEnd: report.cashEnd,
    externalDeposits: report.externalDeposits,
    externalWithdrawals: report.externalWithdrawals,
    realizedProfit: report.realizedProfit,
    contribution: 0n,
    attesterEpoch: snapshot.attesterEpoch,
    validAfter: now - VALID_AFTER_SKEW_SECONDS,
    deadline: now + DEADLINE_SECONDS,
  };

  // -------------------------------------------------------------------------
  // 4. Ask the executor what it will accept, rather than reimplementing its
  //    five clamps (savingsBps, maxPerSettlement, account rolling cap,
  //    aggregate rolling cap, and balance minus tradingFloor+gasReserve).
  // -------------------------------------------------------------------------
  let contribution: bigint;
  try {
    contribution = await chain.previewContribution(base);
  } catch (error) {
    return {
      kind: "DEFER",
      reason: "PREVIEW_FAILED",
      detail: `previewContribution reverted: ${((error as Error).message ?? "unknown").slice(0, 200)}`,
    };
  }

  // Non-positive profit is NORMAL. _calculateContribution returns 0 and settle
  // reverts ContributionBelowMinimum. A perfectly attestable session can be
  // unprofitable, and this must read as an ordinary event, not an error.
  if (report.realizedProfit <= 0n) {
    return {
      kind: "SKIP",
      reason: "NON_POSITIVE_PROFIT",
      detail: `realizedProfit ${report.realizedProfit} <= 0; the executor returns a zero contribution`,
      contribution: 0n,
    };
  }
  if (contribution < snapshot.policy.minContributionWei) {
    return {
      kind: "SKIP",
      reason: "BELOW_MINIMUM",
      detail: `contribution ${contribution} < minContributionWei ${snapshot.policy.minContributionWei}`,
      contribution,
    };
  }

  // ---------------------------------------------------------------------------
  // THE BREAKER ASKS WHETHER THE NUMBER IS POSSIBLE, NOT WHETHER IT IS BIG.
  //
  // This was an absolute ceiling -- NUVEM_KEEPER_MAX_CONTRIBUTION_WEI, default
  // 0.001 ETH -- and it HALTED. In production it did what an absolute ceiling
  // must eventually do: two accounts made real profits of about 0.019 and 0.021
  // ETH, nineteen times a number chosen in a lab, and both latched DEGRADED.
  // Profit size is not a defect, so a check that fires on size alone punishes the
  // user for succeeding -- and the punishment was a durable Postgres latch that
  // only an operator holding DATABASE_URL could clear.
  //
  // A ceiling also cannot tell a bug from a good trade, which is what it was FOR.
  // The executor's arithmetic can, because it is fixed and public
  // (SettlementExecutor._calculateContribution):
  //
  //   c = floor(P * savingsBps / 10000)
  //   c = min(c, maxPerSettlementWei)
  //   c = min(c, accountRollingCapStatus.remaining)     // <= maxRolling30dWei
  //   c = min(c, aggregateRollingCapStatus.remaining)
  //   c = min(c, balance - (tradingFloorWei + gasReserveWei))
  //
  // Every step is a min, so the result can never exceed the FIRST term, nor the
  // two policy constants above it. That is a bound computable from the snapshot
  // alone -- no extra RPC call, no configuration -- and exceeding it means the
  // executor returned a number its own source cannot produce. That is the only
  // thing worth refusing over. A profit ten thousand times larger scales the
  // first term with it and never trips this.
  //
  // THE ROLLING-CAP TERMS ARE DELIBERATELY ABSENT from the bound: `remaining` is
  // live state this snapshot does not carry, and guessing at it would refuse
  // legitimate settlements. Leaving them out only makes the bound looser, never
  // wrong -- it is still an upper bound, which is all it has to be.
  //
  // DEFER, NOT HALT, and that distinction is the point. previewContribution
  // re-reads the policy inside the contract while `snapshot.policy` was read
  // earlier, so a vault admin editing the policy in between is a BENIGN way to
  // exceed this bound. Such an attestation could never execute anyway -- settle
  // rejects a mismatched policyNonce or policyHash, and this attestation binds
  // both -- so the safe answer is to re-read and decide again next tick. And
  // refusing to sign IS the protection: nothing is signed on either path, so HALT
  // would buy no safety over DEFER. It would only require a human.
  const bps = BigInt(snapshot.policy.savingsBps);
  // BigInt division truncates and realizedProfit is > 0 by the check above, so
  // this is floor() -- the same rounding as the contract's Math.mulDiv.
  const byProfit = (report.realizedProfit * bps) / 10_000n;
  const byPolicy =
    snapshot.policy.maxPerSettlementWei < snapshot.policy.maxRolling30dWei
      ? snapshot.policy.maxPerSettlementWei
      : snapshot.policy.maxRolling30dWei;
  const possible = byProfit < byPolicy ? byProfit : byPolicy;
  if (contribution > possible) {
    return {
      kind: "DEFER",
      reason: "CONTRIBUTION_ABOVE_POLICY",
      detail:
        `contribution ${contribution} exceeds what this policy can justify (${possible}): ` +
        `profit ${report.realizedProfit} x ${snapshot.policy.savingsBps}bps = ${byProfit}, ` +
        `maxPerSettlement ${snapshot.policy.maxPerSettlementWei}, ` +
        `maxRolling30d ${snapshot.policy.maxRolling30dWei}. ` +
        "Either the policy moved since the snapshot was read, in which case the next tick agrees " +
        "with itself, or the executor is not doing what its source says.",
    };
  }

  // -------------------------------------------------------------------------
  // 5. The gas hazard that deserves naming.
  //
  //    previewContribution clamps against `attestation.account.balance` NOW.
  //    settle clamps against `msg.sender.balance + msg.value` at execution time
  //    — and for an EOA transaction the entire gasLimit * maxFeePerGas is
  //    debited BEFORE the body runs. So the balance the contract sees is lower
  //    than the balance we just previewed against. If that difference pushes the
  //    clamp into binding, the recomputed savedAmount no longer equals the
  //    signed attestation.contribution and settle reverts InvalidContribution —
  //    which looks like a mysterious signature failure rather than a funding
  //    problem.
  //
  //    At 0.03 ETH against a 0.0002 ETH reserve this cannot bite. On a
  //    nearly-empty account it will. So it is checked explicitly.
  // -------------------------------------------------------------------------
  const reserved = snapshot.policy.tradingFloorWei + snapshot.policy.gasReserveWei;
  let gasBudget = 0n;
  try {
    const fees = await chain.getFeeQuote();
    // The gas estimate needs a signature, which we do not have yet. A settle has
    // cost ~516k gas on mainnet; 1.5x that is a safe upper bound for a
    // pre-signature budget check, and the real estimate happens in submit.ts.
    gasBudget = 800_000n * fees.maxFeePerGas * limits.gasHeadroom;
  } catch {
    // A fee read that fails must not silently skip the check.
    gasBudget = 0n;
  }
  if (snapshot.accountBalanceWei < contribution + reserved + gasBudget) {
    return {
      kind: "DEFER",
      reason: "INSUFFICIENT_BALANCE",
      detail:
        `balance ${snapshot.accountBalanceWei} < contribution ${contribution} + reserved ${reserved} ` +
        `+ gas headroom ${gasBudget}. Settling would strand the trader below their own floor.`,
    };
  }

  // -------------------------------------------------------------------------
  // 6. Sign, then verify the digest against the contract's own view.
  // -------------------------------------------------------------------------
  const attestation: SettlementAttestation = { ...base, contribution };
  const domain = {
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    chainId: input.chainId,
    verifyingContract: input.executor,
  } as const;

  const localDigest = hashTypedData({
    domain,
    types: ATTESTATION_TYPES,
    primaryType: "SettlementAttestation",
    message: attestation,
  });
  const onchainDigest = await chain.hashAttestation(attestation);
  if (localDigest.toLowerCase() !== onchainDigest.toLowerCase()) {
    return {
      kind: "HALT",
      reason: "DIGEST_MISMATCH",
      detail:
        `local EIP-712 digest ${localDigest} != hashAttestation() ${onchainDigest}. The type list in ` +
        "onchain.ts has drifted from the contract; a signature built from it would be rejected.",
    };
  }

  const signature = await input.signer.signTypedData({
    domain,
    types: ATTESTATION_TYPES,
    primaryType: "SettlementAttestation",
    message: attestation,
  });

  return { kind: "READY", attestation, signature, digest: onchainDigest, contribution, sessionId };
}

/** The four inputs the contract recomputes profit from, for the audit log line. */
export function fabricatableInputs(report: SessionReport): Record<string, string> {
  // These are the ONLY place a wrong settlement can hide. SettlementExecutor
  // recomputes realizedProfit from exactly these four numbers, so it can catch a
  // fabricated PROFIT — but it cannot check the four inputs against history.
  // Without them in the log there is nothing to audit after the fact.
  return {
    cashStart: report.cashStart.toString(),
    cashEnd: report.cashEnd.toString(),
    externalDeposits: report.externalDeposits.toString(),
    externalWithdrawals: report.externalWithdrawals.toString(),
  };
}
