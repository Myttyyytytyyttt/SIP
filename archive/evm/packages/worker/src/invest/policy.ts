// The invest DECISION: given what one vault says about itself, invest how much,
// or wait for exactly which named reason. Pure — no rpc, no clock, no signer.
//
// THE THRESHOLD IS THE VAULT'S, NEVER THE WORKER'S. The product's "$5 before we
// buy anything" is `PersonalVault.minInvestmentWei`, which the vault admin set
// and `invest()` enforces. A constant here would be a second threshold nobody
// agreed to, and the two would disagree the first time a user moved theirs — so
// every number in this file arrives as an input read from the chain.
//
// WHY A PURE DECISION AT ALL. `invest()` reverts for nine different reasons, and
// a revert costs the user gas and tells the operator nothing a log can group by.
// This function asks the same nine questions before anything is signed, in the
// order the contract asks them, so a wait is a named fact ("CAP_EXHAUSTED until
// the bucket releases") rather than a failed transaction.
//
// ONE VOCABULARY. The reasons are `InvestDeferReason` in types.ts, because the
// pass logs them and the ledger will store them; this file is where each one is
// decided, and every one of them means "later", never "never".
//
// WHAT IT DELIBERATELY DOES NOT DECIDE: which assets, at what floor, or where
// the output lands. Those come from state the vault admin signed for; the caller
// of `invest` chooses WHEN and, within the admin's bounds, HOW MUCH, and nothing
// else (PersonalVault.sol, "the investment path"). This file is that sentence.

import { encodeAbiParameters, keccak256 } from "viem";

import type { Address, BasketLeg, Hex, InvestDeferReason, VaultInvestmentPolicy } from "../types.js";

/**
 * THE SEAM'S VOCABULARY IS THIS MODULE'S VOCABULARY. `InvestDeferReason` is
 * declared in types.ts because the pass logs it and the ledger will store it;
 * it is DECIDED here, and an alias rather than a second union is what keeps the
 * two from drifting into "almost the same list".
 */
export type InvestWaitReason = InvestDeferReason;

/** NuvemTypes.BPS_DENOMINATOR. */
export const BPS_DENOMINATOR = 10_000n;

/** NuvemTypes.MAX_BASKET_LEGS — the calldata bound `invest()` was built around. */
export const MAX_BASKET_LEGS = 8;

const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

/** The abi.encode shape of `BasketLeg[]` — the preimage of `investmentBasketHash`. */
export const BASKET_LEGS_PARAM = {
  type: "tuple[]",
  components: [
    { name: "targetAsset", type: "address" },
    { name: "weightBps", type: "uint16" },
    { name: "minOutRateWad", type: "uint128" },
  ],
} as const;

/**
 * `keccak256(abi.encode(legs))` — the vault's compare-and-swap on the basket.
 *
 * The legs are rebuilt from `InvestmentPolicyUpdated`, not from a copy anyone
 * keeps in sync, so this is how the worker proves the array it is about to send
 * is the one the admin hashed. A mismatch is a refusal, never a "close enough".
 */
export function basketHashOf(legs: readonly BasketLeg[]): Hex {
  return keccak256(encodeAbiParameters([BASKET_LEGS_PARAM], [legs]));
}

/** What `AdapterRegistry` says about the vault's `adapterId` right now. */
export interface AdapterStatus {
  /** Zero when nothing is registered under the vault's `adapterId`. */
  readonly adapter: Address;
  /** `isAdapterActive`: registered, active, AND its runtime codehash still matches the pin. */
  readonly active: boolean;
  /** `resolveActiveAdapter` reverts unless the call carries exactly this epoch. */
  readonly statusEpoch: bigint;
}

export interface InvestInputs {
  readonly policy: VaultInvestmentPolicy;
  readonly adapter: AdapterStatus;
  /**
   * The policy nonce the legs in `policy.legs` were emitted at, when it is known
   * from somewhere other than this same read — the pre-send re-read is the case
   * that matters. Null or absent means "the legs came from this very pass".
   */
  readonly basketPolicyNonce?: bigint | null;
}

/** Which constraint set the size — for the log line, not for the contract. */
export type InvestBound = "balance" | "maxPerCall" | "rollingCap";

export type InvestDecision =
  | {
      readonly kind: "invest";
      /** `amountIn`: gross WETH to spend this call. */
      readonly grossWei: bigint;
      readonly bound: InvestBound;
      readonly legs: readonly BasketLeg[];
      /** The split `invest()` will compute; carried for the log and the zero-leg check. */
      readonly legAmountsWei: readonly bigint[];
      /** Per-leg lower bounds, all zero — see `zeroMinAmountsOut`. */
      readonly minAmountsOut: readonly bigint[];
      readonly expectedAdapterStatusEpoch: bigint;
      readonly expectedInvestmentPolicyNonce: bigint;
    }
  | { readonly kind: "wait"; readonly reason: InvestWaitReason; readonly detail?: string };

const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/**
 * The per-leg split, exactly as `invest()` computes it: weight × amountIn, and
 * THE LAST LEG ABSORBS THE ROUNDING DUST. Reproduced rather than approximated,
 * because the vault asserts an exact debit — a split that sums to less than
 * `amountIn` reverts, so the worker must be able to see that coming.
 */
export function legAmounts(grossWei: bigint, legs: readonly BasketLeg[]): readonly bigint[] {
  const amounts: bigint[] = [];
  let assigned = 0n;
  for (const [i, leg] of legs.entries()) {
    const amount = i + 1 === legs.length ? grossWei - assigned : (grossWei * BigInt(leg.weightBps)) / BPS_DENOMINATOR;
    assigned += amount;
    amounts.push(amount);
  }
  return amounts;
}

/**
 * All zeros, one per leg.
 *
 * THE WORKER QUOTES NO FLOOR OF ITS OWN. `minAmountsOut` may only TIGHTEN the
 * admin's `minOutRateWad`, and the vault takes the maximum of the two — so zero
 * means "the admin's floor stands", which is the honest answer from a process
 * that holds no price feed. Inventing a number here would be the worker quoting
 * itself slippage on the user's behalf; when a quote source exists, this is
 * where it lands.
 */
export function zeroMinAmountsOut(legs: readonly BasketLeg[]): readonly bigint[] {
  return legs.map(() => 0n);
}

/**
 * Invest, or wait with a reason. The order below is `invest()`'s own order of
 * refusal, with one deliberate exception: the basket checks come AFTER the size
 * checks, because recovering the legs costs a log scan and a vault with nothing
 * to invest must not pay for one. `crank.ts` relies on that — it decides once
 * with `legs: null` and only goes looking when the answer is BASKET_UNKNOWN.
 */
export function decideInvestment(inputs: InvestInputs): InvestDecision {
  const { policy, adapter } = inputs;

  if (!policy.enabled) return { kind: "wait", reason: "DISABLED" };
  // `setInvestmentPolicy` refuses `minInvestment == 0`, so enabled-with-no-floor
  // is unrepresentable through the setter. Reaching it means the slot map read
  // the wrong word, and inventing a floor would spend the user's WETH on that
  // mistake.
  if (policy.minInvestmentWei === 0n) {
    return { kind: "wait", reason: "DISABLED", detail: "investment is enabled but minInvestmentWei is 0, which setInvestmentPolicy cannot produce" };
  }
  if (policy.paused) return { kind: "wait", reason: "PAUSED" };
  if (policy.protocolPaused) return { kind: "wait", reason: "PROTOCOL_PAUSED" };

  if (adapter.adapter === ZERO_ADDRESS) {
    return { kind: "wait", reason: "ADAPTER_NOT_REGISTERED", detail: `nothing is registered under adapter id 0x${policy.adapterId.toString(16)}` };
  }
  // `isAdapterActive` folds the codehash pin into the same answer, so a swapped
  // implementation reads here as deactivated rather than as a revert inside the
  // vault's call to `resolveActiveAdapter`.
  if (!adapter.active) {
    return { kind: "wait", reason: "ADAPTER_DEACTIVATED", detail: `${adapter.adapter} is registered but not active (deactivated, or its runtime codehash moved)` };
  }

  if (policy.wethBalanceWei === 0n) return { kind: "wait", reason: "NOTHING_TO_INVEST" };
  // Cap before minimum: when the rolling window cannot fit even a minimum call,
  // no amount of waiting for MORE WETH helps — the wait is on the bucket, and
  // the operator needs to be told which one it is.
  if (policy.rollingRemainingWei < policy.minInvestmentWei) {
    return {
      kind: "wait",
      reason: "CAP_EXHAUSTED",
      detail: `rolling cap has ${policy.rollingRemainingWei} wei left, below the vault's minimum of ${policy.minInvestmentWei}`,
    };
  }

  const grossWei = min(min(policy.wethBalanceWei, policy.maxPerCallWei), policy.rollingRemainingWei);
  if (grossWei < policy.minInvestmentWei) {
    return { kind: "wait", reason: "BELOW_MINIMUM", detail: `${grossWei} wei investable, the vault's minimum is ${policy.minInvestmentWei}` };
  }
  const bound: InvestBound =
    grossWei === policy.wethBalanceWei ? "balance" : grossWei === policy.maxPerCallWei ? "maxPerCall" : "rollingCap";

  const legs = policy.legs;
  if (legs === null) return { kind: "wait", reason: "BASKET_UNKNOWN", detail: `no legs in hand for basket ${policy.basketHash}` };
  // The nonce before the hash: an admin can re-set the same assets with
  // different limits, which moves the nonce and leaves the hash alone.
  // `invest()` compares both, and the nonce is the one that says "your copy of
  // the policy is stale".
  const basketNonce = inputs.basketPolicyNonce;
  if (basketNonce !== undefined && basketNonce !== null && basketNonce !== policy.policyNonce) {
    return {
      kind: "wait",
      reason: "POLICY_NONCE_MOVED",
      detail: `the basket in hand belongs to policy nonce ${basketNonce}, the vault is at ${policy.policyNonce}`,
    };
  }
  if (legs.length === 0 || legs.length > MAX_BASKET_LEGS) {
    return { kind: "wait", reason: "BASKET_UNKNOWN", detail: `${legs.length} legs is outside 1..${MAX_BASKET_LEGS}` };
  }
  const hash = basketHashOf(legs);
  if (hash !== policy.basketHash.toLowerCase()) {
    return { kind: "wait", reason: "BASKET_UNKNOWN", detail: `legs in hand hash to ${hash}, the vault expects ${policy.basketHash}` };
  }

  const legAmountsWei = legAmounts(grossWei, legs);
  const zeroLeg = legAmountsWei.findIndex((amount) => amount === 0n);
  if (zeroLeg !== -1) {
    return { kind: "wait", reason: "LEG_ROUNDS_TO_ZERO", detail: `leg ${zeroLeg} of ${grossWei} wei rounds to 0 and invest() refuses it` };
  }

  return {
    kind: "invest",
    grossWei,
    bound,
    legs,
    legAmountsWei,
    minAmountsOut: zeroMinAmountsOut(legs),
    expectedAdapterStatusEpoch: adapter.statusEpoch,
    expectedInvestmentPolicyNonce: policy.policyNonce,
  };
}
