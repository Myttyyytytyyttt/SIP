// Turning "this vault should buy" into the exact call that buys.
//
// WHERE THIS SITS. `decideInvestment` answers WHETHER and HOW MUCH from chain
// state; `quote.ts` answers WHAT PRICE IS ACCEPTABLE from live pool state. Both
// are pure. This module is the third piece: it assembles the argument list for
// `PersonalVault.invest`, and it is also pure — the reads happen in the caller
// and the transaction happens in the runner, so the assembly can be tested
// exhaustively without an RPC, a signer or a database.
//
// WHY THE BASKET ARRIVES AS AN ARGUMENT RATHER THAN BEING READ. The vault stores
// only `keccak256(abi.encode(BasketLeg[]))`; the legs themselves live in the
// `InvestmentPolicyUpdated` event. So "what am I buying?" is a LOG lookup, not a
// chain read, and it can fail in a way no `eth_call` can report. Handing the legs
// in means this module cannot silently proceed with an empty basket — the caller
// has to have found them, and `decideInvestment` already refuses when it has not.
//
// THE HASH IS RECHECKED HERE ANYWAY. `invest` reverts unless the legs it is
// handed hash to the stored `investmentBasketHash`, so a mismatch is caught on
// chain regardless. Catching it first turns a wasted transaction and an opaque
// revert into a named refusal, and it is one keccak.

import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";

import {
  DEFAULT_TOLERANCE_BPS,
  minOutFromQuote,
  quoteExactInSingle,
  quoteTwoHop,
  splitAcrossLegs,
  type PoolState,
} from "./quote.js";

/** One leg of the admin's basket, as emitted by `InvestmentPolicyUpdated`. */
export interface BasketLeg {
  readonly targetAsset: Address;
  readonly weightBps: number;
  readonly minOutRateWad: bigint;
}

/**
 * How a single leg gets from WETH to what the vault ends up holding.
 *
 * THREE ROUTES, BECAUSE THERE ARE THREE DESTINATIONS, and the difference is not
 * cosmetic — it is how many hops there are and what unit the answer is in.
 * This was a pair of pools, which silently assumed every destination is a stock
 * reached through two Uniswap swaps. A dollar leg has ONE hop and no second
 * pool; a yield leg has one hop and then a mint, which is not a pool at all.
 */
export type LegRoute =
  /** WETH -> USDG -> stock. Two swaps, and the quote is in the stock's units. */
  | { readonly kind: "STOCK"; readonly wethToUsdg: PoolState; readonly usdgToStock: PoolState }
  /** WETH -> USDG, and the vault keeps the dollars. The quote is USDG. */
  | { readonly kind: "DOLLARS"; readonly wethToUsdg: PoolState }
  /**
   * WETH -> USDG -> an ERC-4626 deposit. The quote is in SHARES, and share
   * decimals are a property of the vault rather than a constant: spUSDG mints
   * 6-decimal shares and steakUSDG 18, over the same 6-decimal USDG. `shares` is
   * the destination's own previewDeposit for this leg's amount, read by the
   * caller — EIP-4626 forbids it from promising more than the deposit delivers,
   * so a floor built on it is conservative by construction.
   */
  | {
      readonly kind: "YIELD";
      readonly wethToUsdg: PoolState;
      readonly shares: bigint;
      /**
       * WHO WAS ASKED for the preview — the asset itself for a 4626 like
       * spUSDG, the desk for a pToken. Carried so a refusal can name the
       * contract that actually answered zero: "the vault is refusing deposits"
       * sends an operator to Arcus when the broken thing is the desk wiring.
       */
      readonly quoter: string;
    };

/** @deprecated The old two-pool shape, kept as the STOCK route's payload. */
export interface LegPools {
  readonly wethToUsdg: PoolState;
  readonly usdgToStock: PoolState;
}

export interface PlanInput {
  readonly legs: readonly BasketLeg[];
  /** What `decideInvestment` settled on. */
  readonly amountIn: bigint;
  /** Keyed by `targetAsset`, lowercased. */
  readonly pools: ReadonlyMap<string, LegRoute>;
  /** `investmentBasketHash` as the vault currently stores it. */
  readonly expectedBasketHash: Hex;
  /** `investmentPolicyNonce`, which `invest` pins against. */
  readonly policyNonce: bigint;
  /** The registry's status epoch for the vault's adapter. */
  readonly adapterStatusEpoch: bigint;
  /** Unix seconds. */
  readonly deadline: number;
  readonly toleranceBps?: number;
}

export type PlanResult =
  | { readonly kind: "PLAN"; readonly call: InvestCall }
  /** Something a human has to fix. Never a quiet skip. */
  | { readonly kind: "REFUSED"; readonly reason: string };

export interface InvestCall {
  readonly legs: readonly BasketLeg[];
  readonly amountIn: bigint;
  readonly minAmountsOut: readonly bigint[];
  readonly deadline: number;
  readonly policyNonce: bigint;
  readonly adapterStatusEpoch: bigint;
  /** Per-leg detail, for the log line. Not sent. */
  readonly quoted: readonly { readonly targetAsset: Address; readonly legAmount: bigint; readonly quote: bigint }[];
}

const BPS_DENOMINATOR = 10_000;
const OUTPUT_RATE_SCALE = 10n ** 18n;

/**
 * The ABI encoding of `BasketLeg[]`, which is what the vault hashes.
 *
 * MUST MATCH `abi.encode(NuvemTypes.BasketLeg[])` EXACTLY, field order included.
 * A mismatch here does not throw — it produces a different hash, so every basket
 * looks tampered with and the keeper refuses every purchase while reporting the
 * admin's own configuration as corrupt.
 *
 * WHAT IS AND IS NOT LOAD-BEARING HERE, measured by mutating each part and
 * running the parity vectors:
 *   - reordering the fields                     -> 3 tests fail
 *   - dropping `minOutRateWad` from the tuple   -> 3 tests fail
 *   - `tuple[]` -> a fixed-size array           -> 17 tests fail
 *   - `uint16` -> `uint32` on `weightBps`       -> NOTHING fails, and correctly:
 *     ABI pads both to the same 32-byte word, and the contract bounds weights to
 *     10,000 so the widths can never diverge on a real value. Left as-is rather
 *     than "fixed", because the width that matters is Solidity's.
 */
export function encodeBasket(legs: readonly BasketLeg[]): Hex {
  return encodeAbiParameters(
    [
      {
        type: "tuple[]",
        components: [
          { name: "targetAsset", type: "address" },
          { name: "weightBps", type: "uint16" },
          { name: "minOutRateWad", type: "uint128" },
        ],
      },
    ],
    [legs.map((leg) => ({ targetAsset: leg.targetAsset, weightBps: leg.weightBps, minOutRateWad: leg.minOutRateWad }))],
  );
}

export function basketHash(legs: readonly BasketLeg[]): Hex {
  return keccak256(encodeBasket(legs));
}

/**
 * Builds the call, or refuses and says why.
 *
 * EVERY REFUSAL IS NAMED. A keeper that returns "no plan" for six different
 * reasons is a keeper whose operator cannot tell a stale log from a dead pool
 * from a basket that was reconfigured a second ago — and all three look like a
 * vault quietly not investing.
 */
export function planInvestment(input: PlanInput): PlanResult {
  const { legs, amountIn, pools, expectedBasketHash, deadline } = input;

  if (legs.length === 0) {
    return { kind: "REFUSED", reason: "the basket has no legs, so there is nothing to buy" };
  }
  if (amountIn <= 0n) {
    return { kind: "REFUSED", reason: `amountIn must be positive, got ${amountIn}` };
  }

  const totalWeight = legs.reduce((sum, leg) => sum + leg.weightBps, 0);
  if (totalWeight !== BPS_DENOMINATOR) {
    return {
      kind: "REFUSED",
      reason: `leg weights sum to ${totalWeight}, not ${BPS_DENOMINATOR}; the vault would revert on its own check`,
    };
  }

  // The legs came out of a log. If they do not hash to what the vault stores,
  // the log is from a superseded policy — which happens the moment an admin
  // reconfigures — and sending them would burn a transaction on a revert.
  const recovered = basketHash(legs);
  if (recovered.toLowerCase() !== expectedBasketHash.toLowerCase()) {
    return {
      kind: "REFUSED",
      reason:
        `the recovered basket hashes to ${recovered} but the vault stores ${expectedBasketHash}; ` +
        "these legs are from a superseded policy, so re-read the logs rather than sending this",
    };
  }

  const legAmounts = splitAcrossLegs(
    amountIn,
    legs.map((leg) => leg.weightBps),
  );

  const minAmountsOut: bigint[] = [];
  const quoted: { targetAsset: Address; legAmount: bigint; quote: bigint }[] = [];
  const tolerance = input.toleranceBps ?? DEFAULT_TOLERANCE_BPS;

  for (let i = 0; i < legs.length; i += 1) {
    const leg = legs[i]!;
    const legAmount = legAmounts[i]!;
    const legRoute = pools.get(leg.targetAsset.toLowerCase());
    if (legRoute === undefined) {
      return { kind: "REFUSED", reason: `no route was read for ${leg.targetAsset}` };
    }

    // ONE QUOTE PER ROUTE, IN THAT ROUTE'S OWN UNITS. The vault compares the
    // floor against its own balance delta of `targetAsset`, so the unit here is
    // whatever the vault ends up holding: the stock, the dollars, or the shares.
    const quote =
      legRoute.kind === "STOCK"
        ? quoteTwoHop(legRoute.wethToUsdg, legRoute.usdgToStock, legAmount)
        : legRoute.kind === "DOLLARS"
          ? quoteExactInSingle(legRoute.wethToUsdg, legAmount)
          : legRoute.shares;
    if (quote <= 0n) {
      return {
        kind: "REFUSED",
        reason:
          legRoute.kind === "YIELD"
            ? `${leg.targetAsset} previewed no shares for ${legAmount} wei of dollars` +
              `${legRoute.quoter.toLowerCase() === leg.targetAsset.toLowerCase() ? "" : ` (asked at its desk, ${legRoute.quoter})`} — ` +
              "the destination is refusing deposits, out of inventory, or could not be read"
            : `the pools for ${leg.targetAsset} quote nothing for ${legAmount} wei — ` +
              "the pinned pool is empty or its state could not be read",
      };
    }

    const floor = minOutFromQuote(quote, tolerance);

    // THE ADMIN'S FLOOR IS APPLIED BY THE VAULT, NOT HERE, and this is only a
    // check. `invest` takes max(adminFloor, ours), so a keeper floor below the
    // admin's is harmless — but it means the purchase will revert on the admin's
    // number, and reporting that here is the difference between a diagnosable
    // stop and a vault that mysteriously never buys. See the frozen-rate problem
    // in quote.ts: this is exactly how a stale `minOutRateWad` announces itself.
    const adminFloor = (legAmount * leg.minOutRateWad) / OUTPUT_RATE_SCALE;
    if (adminFloor > quote) {
      return {
        kind: "REFUSED",
        reason:
          `the admin's minOutRateWad for ${leg.targetAsset} demands ${adminFloor} but the pool quotes ${quote}; ` +
          "the configured rate has drifted out of reach of the market and has to be reset by the vault admin",
      };
    }

    minAmountsOut.push(floor);
    quoted.push({ targetAsset: leg.targetAsset, legAmount, quote });
  }

  return {
    kind: "PLAN",
    call: {
      legs,
      amountIn,
      minAmountsOut,
      deadline,
      policyNonce: input.policyNonce,
      adapterStatusEpoch: input.adapterStatusEpoch,
      quoted,
    },
  };
}

/** One line an operator can read without opening a block explorer. */
export function describePlan(call: InvestCall): string {
  const legs = call.quoted
    .map((q, i) => `${q.targetAsset} ${q.legAmount} wei -> >=${call.minAmountsOut[i]} (quoted ${q.quote})`)
    .join("; ");
  return `invest ${call.amountIn} wei across ${call.legs.length} leg(s): ${legs}`;
}
