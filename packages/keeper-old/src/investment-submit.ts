// Turning a plan into calldata, and a calldata into a transaction.
//
// THE SIGNER IS THE ONE THE KEEPER ALREADY HAS. `PersonalVault._requireInvestmentAuthority`
// admits the vault admin OR any ACTIVE trading account, and the keeper holds a
// trading account key because that is what settlement needs. So automating
// purchases costs no new key and no new authority — which is worth stating,
// because the obvious assumption is that buying needs the owner's wallet and that
// assumption would have sent this design somewhere much worse.
//
// WHAT THIS DELIBERATELY DOES NOT DO is decide anything. By the time a plan
// arrives here every judgement has been made and checked: `decideInvestment` on
// chain state, `planInvestment` on quotes and the basket hash. This module
// encodes, estimates, signs and reports — and refuses to send when it is not in
// live mode, which is the same shape `submitSettlement` uses so that an operator
// reading either sees the same thing.

import { encodeFunctionData, type Address, type Hex } from "viem";

import type { InvestCall } from "./investment-plan.js";
import type { TradingSigner } from "./submit.js";

/** The `invest` fragment, written out so the argument ORDER is visible here. */
export const INVEST_ABI = [
  {
    type: "function",
    name: "invest",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "legs",
        type: "tuple[]",
        components: [
          { name: "targetAsset", type: "address" },
          { name: "weightBps", type: "uint16" },
          { name: "minOutRateWad", type: "uint128" },
        ],
      },
      { name: "amountIn", type: "uint256" },
      { name: "minAmountsOut", type: "uint256[]" },
      { name: "deadline", type: "uint48" },
      { name: "expectedAdapterStatusEpoch", type: "uint64" },
      { name: "expectedInvestmentPolicyNonce", type: "uint64" },
    ],
    outputs: [],
  },
] as const;

/**
 * THE LAST TWO ARGUMENTS ARE EASY TO SWAP AND BOTH ARE uint64.
 *
 * `invest(..., expectedAdapterStatusEpoch, expectedInvestmentPolicyNonce)` — in
 * that order. Swapping them compiles, encodes, and produces a transaction that
 * reverts with `InvalidInvestmentPolicyNonce` naming two numbers that both look
 * plausible. The encoder test asserts the order against a fixture with the two
 * values deliberately different.
 */
export function encodeInvestCalldata(call: InvestCall): Hex {
  return encodeFunctionData({
    abi: INVEST_ABI,
    functionName: "invest",
    args: [
      call.legs.map((leg) => ({
        targetAsset: leg.targetAsset,
        weightBps: leg.weightBps,
        minOutRateWad: leg.minOutRateWad,
      })),
      call.amountIn,
      [...call.minAmountsOut],
      call.deadline,
      call.adapterStatusEpoch,
      call.policyNonce,
    ],
  });
}

export interface InvestPlan {
  readonly from: Address;
  readonly to: Address;
  readonly value: bigint;
  readonly data: Hex;
  readonly chainId: number;
  readonly gasLimit: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly estimatedGasCostWei: bigint;
  /** null in a dry run: nothing is sent, so no nonce is reserved. */
  readonly nonce: number | null;
  readonly call: InvestCall;
}

export type InvestSubmitResult =
  | { readonly kind: "DRY_RUN"; readonly plan: InvestPlan }
  | { readonly kind: "BLOCKED"; readonly reason: string; readonly detail: string }
  | { readonly kind: "CONFIRMED"; readonly plan: InvestPlan; readonly txHash: Hex; readonly gasUsed: bigint }
  | { readonly kind: "FAILED"; readonly plan: InvestPlan; readonly txHash: Hex }
  /** Sent, no receipt in time. Left for reconciliation rather than resent. */
  | { readonly kind: "UNRESOLVED"; readonly plan: InvestPlan; readonly txHash: Hex };

/** Only what submission needs, so the test fake stays small. */
export interface InvestChainAccess {
  estimateGas(args: { from: Address; to: Address; data: Hex }): Promise<bigint>;
  getFeeQuote(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
  getPendingTransactionCount(address: Address): Promise<number>;
  sendRawTransaction(raw: Hex): Promise<Hex>;
  waitForReceipt(hash: Hex, timeoutMs: number): Promise<{ status: "success" | "reverted"; gasUsed: bigint } | null>;
}

/**
 * THE SAME SIGNER SETTLEMENT USES, aliased rather than redeclared.
 *
 * It began as its own identical interface, which is one structural change away
 * from a signer that satisfies one path and not the other — and the failure would
 * land at signing time, in live mode, on the one code path that spends money.
 * Aliasing means `createPrivySigner` cannot satisfy settlement and quietly stop
 * satisfying this: there is one shape, and the compiler enforces it.
 */
export type InvestSigner = TradingSigner;

export interface SubmitInvestmentInput {
  readonly live: boolean;
  readonly chain: InvestChainAccess;
  readonly vault: Address;
  readonly chainId: number;
  readonly call: InvestCall;
  /** Absent in dry-run mode by construction, not by check. */
  readonly signer: InvestSigner | null;
  /**
   * Who the transaction will come from.
   *
   * REQUIRED EVEN IN A DRY RUN, and it used to default to the vault — which is
   * never right and never obviously wrong. `_requireInvestmentAuthority` admits
   * the vault admin or an ACTIVE trading account; the vault itself is neither, so
   * every estimate reverted `Unauthorized()` and reported it as though the plan
   * were bad. A dry run whose `from` is wrong measures nothing, so there is no
   * default to get wrong.
   */
  readonly from: Address;
  readonly receiptTimeoutMs?: number;
  /** Headroom over the estimate. Estimation is exact-ish; this is for drift. */
  readonly gasBufferBps?: number;
}

const DEFAULT_GAS_BUFFER_BPS = 2_500;
const DEFAULT_RECEIPT_TIMEOUT_MS = 90_000;

/**
 * Estimates, signs and sends — or explains why it did not.
 *
 * ESTIMATION IS THE REAL PRE-FLIGHT. `eth_estimateGas` executes the call, so a
 * plan whose floors cannot be met, whose basket has been replaced, or whose
 * adapter was just deactivated fails HERE, for free, with the vault's own revert
 * reason — rather than costing gas to discover on chain. That is why the estimate
 * is not skipped even when a fallback limit would do.
 */
export async function submitInvestment(input: SubmitInvestmentInput): Promise<InvestSubmitResult> {
  const { chain, vault, call } = input;
  const data = encodeInvestCalldata(call);

  let estimated: bigint;
  try {
    estimated = await chain.estimateGas({ from: input.from, to: vault, data });
  } catch (error) {
    return {
      kind: "BLOCKED",
      reason: "ESTIMATION_REVERTED",
      detail:
        `the vault refused a call from ${input.from}: ${(error as Error).message.slice(0, 240)}. ` +
        "Nothing was spent. Usual causes: the sender is neither the vault admin nor an ACTIVE trading " +
        "account (Unauthorized, 0x82b42900), the basket was replaced since the read, the guardian " +
        "deactivated the adapter, or the pool can no longer meet the floors.",
    };
  }

  const fee = await chain.getFeeQuote();
  const bufferBps = BigInt(input.gasBufferBps ?? DEFAULT_GAS_BUFFER_BPS);
  const gasLimit = (estimated * (10_000n + bufferBps)) / 10_000n;

  const plan: InvestPlan = {
    from: input.from,
    to: vault,
    value: 0n,
    data,
    chainId: input.chainId,
    gasLimit,
    maxFeePerGas: fee.maxFeePerGas,
    maxPriorityFeePerGas: fee.maxPriorityFeePerGas,
    estimatedGasCostWei: gasLimit * fee.maxFeePerGas,
    nonce: null,
    call,
  };

  if (!input.live) return { kind: "DRY_RUN", plan };

  if (input.signer === null) {
    return {
      kind: "BLOCKED",
      reason: "NO_SIGNER",
      detail: "live mode was requested with no signer, so nothing could be sent",
    };
  }

  const nonce = await chain.getPendingTransactionCount(input.signer.address);
  const signedPlan: InvestPlan = { ...plan, nonce };

  const raw = await input.signer.signTransaction({
    to: vault,
    value: 0n,
    data,
    nonce,
    gas: gasLimit,
    maxFeePerGas: fee.maxFeePerGas,
    maxPriorityFeePerGas: fee.maxPriorityFeePerGas,
    chainId: input.chainId,
    type: "eip1559",
  });

  const txHash = await chain.sendRawTransaction(raw);
  const receipt = await chain.waitForReceipt(txHash, input.receiptTimeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS);

  // NEVER RESENT FROM HERE. A purchase with no receipt may still be mined, and a
  // second attempt would buy twice with one decision. Reporting it unresolved is
  // the only safe answer; reconciliation decides later, with more information.
  if (receipt === null) return { kind: "UNRESOLVED", plan: signedPlan, txHash };
  if (receipt.status === "reverted") return { kind: "FAILED", plan: signedPlan, txHash };
  return { kind: "CONFIRMED", plan: signedPlan, txHash, gasUsed: receipt.gasUsed };
}

/** A line an operator can read without decoding calldata. */
export function describeInvestPlan(plan: InvestPlan): Record<string, unknown> {
  return {
    to: plan.to,
    from: plan.from,
    amountIn: plan.call.amountIn.toString(),
    legs: plan.call.legs.length,
    minAmountsOut: plan.call.minAmountsOut.map((v) => v.toString()),
    policyNonce: plan.call.policyNonce.toString(),
    adapterStatusEpoch: plan.call.adapterStatusEpoch.toString(),
    gasLimit: plan.gasLimit.toString(),
    estimatedGasCostWei: plan.estimatedGasCostWei.toString(),
    nonce: plan.nonce,
  };
}
