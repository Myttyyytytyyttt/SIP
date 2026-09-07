// Deciding whether a vault should buy, and refusing to guess.
//
// WHAT THIS MODULE IS AND IS NOT. It is the decision: given what the chain says
// about a vault, should a purchase be attempted, and for how much. It is
// deliberately NOT the transaction — that lives in the runner, so this can be
// tested exhaustively without a signer, an RPC or a database.
//
// THE AUTHORITY MODEL, because it is the whole reason the shape is this way.
// The keeper does not choose what is bought. Assets, weights, floors, the
// threshold, the ceilings and the recipient all come from vault storage that the
// admin signed for with their own wallet. The keeper chooses WHEN, inside those
// bounds, and nothing else. So the only interesting output here is an amount and
// a reason — never an asset, never a price.
//
// EVERY REFUSAL HAS ITS OWN NAME. "Nothing happened" is the state this system
// has been burned by twice: a keeper that reports healthy while a user's savings
// sit still looks exactly like a keeper with nothing to do. `NO_BASKET` and
// `INVALID_CONFIG` in particular must never be collapsed into a generic skip —
// they are the states where the user believes they are investing and are not.

export type InvestmentDecision =
  /** Investing is switched off for this vault. Not a fault. */
  | { readonly kind: "DISABLED" }
  /** The admin stopped purchases without changing the configuration. */
  | { readonly kind: "PAUSED" }
  /**
   * Enabled, but there is nothing to buy or the configuration cannot be acted
   * on. The user believes their savings are being invested. They are not.
   */
  | { readonly kind: "NO_BASKET"; readonly detail: string }
  /** Below the admin's own threshold. The ordinary resting state. */
  | { readonly kind: "BELOW_THRESHOLD"; readonly investable: bigint; readonly threshold: bigint }
  /** The rolling window is used up. Releases on its own; not a fault. */
  | { readonly kind: "CAP_EXHAUSTED"; readonly remaining: bigint }
  /** Buy this much. */
  | { readonly kind: "INVEST"; readonly amountIn: bigint };

export interface VaultInvestmentState {
  /** WETH the vault holds right now. */
  readonly wethBalance: bigint;
  readonly enabled: boolean;
  readonly paused: boolean;
  /** keccak256 of the encoded basket. Zero when never set. */
  readonly basketHash: `0x${string}`;
  readonly adapterId: `0x${string}`;
  readonly minInvestmentWei: bigint;
  readonly maxPerCallWei: bigint;
  /** What the rolling 30-day cap still allows. */
  readonly capRemaining: bigint;
  /** True when the registry still considers this vault's adapter usable. */
  readonly adapterActive: boolean;
  /** How many legs the keeper could reconstruct from logs. */
  readonly knownBasketLegs: number;
}

const ZERO_HASH = `0x${"0".repeat(64)}` as const;

/**
 * The decision, from chain state alone.
 *
 * ORDER MATTERS AND IS NOT ARBITRARY. The checks that mean "a human has to do
 * something" come before the ones that mean "wait". A vault with an empty basket
 * and a balance over its threshold must report NO_BASKET, not BELOW_THRESHOLD —
 * reporting the quieter of two true statements is how an outage gets described
 * as normal.
 */
export function decideInvestment(state: VaultInvestmentState): InvestmentDecision {
  if (!state.enabled) return { kind: "DISABLED" };
  if (state.paused) return { kind: "PAUSED" };

  if (state.basketHash === ZERO_HASH) {
    return { kind: "NO_BASKET", detail: "investing is enabled and no basket has ever been set" };
  }
  if (state.adapterId === ZERO_HASH) {
    return { kind: "NO_BASKET", detail: "investing is enabled and no adapter is chosen" };
  }
  if (!state.adapterActive) {
    return {
      kind: "NO_BASKET",
      detail:
        "the chosen adapter is not active in the registry; governance retired it or its code changed, " +
        "and no retry will fix that",
    };
  }
  if (state.knownBasketLegs === 0) {
    // The vault stores only the hash; the legs live in the event. If they cannot
    // be reconstructed the keeper cannot form the call at all, and saying so is
    // the difference between a fixable report and a vault that quietly stops.
    return {
      kind: "NO_BASKET",
      detail: "the basket hash is set but its legs could not be read from logs, so no call can be formed",
    };
  }
  if (state.minInvestmentWei === 0n) {
    return { kind: "NO_BASKET", detail: "no threshold is configured" };
  }

  const investable = state.wethBalance;
  if (investable < state.minInvestmentWei) {
    return { kind: "BELOW_THRESHOLD", investable, threshold: state.minInvestmentWei };
  }

  // Clamp rather than refuse. A settlement landing between the read and the mine
  // can push the balance over the per-call ceiling, and reverting there would be
  // a permanent race against this protocol's own settlement path.
  let amountIn = investable;
  if (amountIn > state.maxPerCallWei) amountIn = state.maxPerCallWei;
  if (amountIn > state.capRemaining) amountIn = state.capRemaining;

  // Clamping must never take the amount back under the admin's own threshold:
  // buying less than the user asked to buy at once is not a smaller version of
  // what they wanted, it is a different thing.
  if (amountIn < state.minInvestmentWei) {
    return { kind: "CAP_EXHAUSTED", remaining: state.capRemaining };
  }

  return { kind: "INVEST", amountIn };
}

/**
 * Whether a decision is one an operator should be told about.
 *
 * `DISABLED`, `PAUSED`, `BELOW_THRESHOLD` and `CAP_EXHAUSTED` are all states the
 * system reaches on purpose. `NO_BASKET` is not: it is always a configuration a
 * human has to fix, and it is the one that looks like nothing from the outside.
 */
export function isActionableProblem(decision: InvestmentDecision): boolean {
  return decision.kind === "NO_BASKET";
}
