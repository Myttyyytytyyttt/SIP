// When a vault should buy, and — more importantly — what it says when it should not.
//
// The decision itself is small. What these tests are really pinning is the
// REPORTING, because this system has twice shipped a state where nothing was
// happening and every log line looked healthy. A vault whose owner believes they
// are investing, and is not, must be distinguishable from a vault that is simply
// waiting.

import { describe, expect, it } from "vitest";

import { decideInvestment, isActionableProblem, type VaultInvestmentState } from "../src/investment.js";

const ZERO = `0x${"0".repeat(64)}` as const;
const BASKET = `0x${"ab".repeat(32)}` as const;
const ADAPTER = `0x${"cd".repeat(32)}` as const;

function state(over: Partial<VaultInvestmentState> = {}): VaultInvestmentState {
  return {
    wethBalance: 10n ** 18n,
    enabled: true,
    paused: false,
    basketHash: BASKET,
    adapterId: ADAPTER,
    minInvestmentWei: 10n ** 15n,
    maxPerCallWei: 10n ** 19n,
    capRemaining: 10n ** 20n,
    adapterActive: true,
    knownBasketLegs: 2,
    ...over,
  };
}

describe("deciding to invest", () => {
  it("buys the whole investable balance when everything is in order", () => {
    const decision = decideInvestment(state({ wethBalance: 5n * 10n ** 17n }));
    expect(decision).toEqual({ kind: "INVEST", amountIn: 5n * 10n ** 17n });
  });

  /**
   * THE OWNER'S REAL NUMBER. A settlement on mainnet contributed 387,193,732,849,312
   * wei. With a threshold set below that — which the contract allows, because no
   * floor is hard-coded anywhere — one settlement is enough to trigger a purchase.
   * A design that could not do this could not be tested at the size it runs at.
   */
  it("fires on a single real-sized settlement when the threshold is set that low", () => {
    const contribution = 387_193_732_849_312n;
    const decision = decideInvestment(state({ wethBalance: contribution, minInvestmentWei: 300_000_000_000_000n }));
    expect(decision).toEqual({ kind: "INVEST", amountIn: contribution });
  });

  it("waits below the threshold and says how far off it is", () => {
    const decision = decideInvestment(state({ wethBalance: 5n, minInvestmentWei: 100n }));
    expect(decision).toEqual({ kind: "BELOW_THRESHOLD", investable: 5n, threshold: 100n });
  });

  /**
   * CLAMPS, DOES NOT REVERT. A settlement landing between the keeper's read and
   * the transaction being mined can push the balance over the per-call ceiling.
   * Refusing there would be a permanent race against this protocol's own
   * settlement path — the busier the user, the less their savings get invested.
   */
  it("clamps to the per-call ceiling rather than refusing", () => {
    const decision = decideInvestment(state({ wethBalance: 10n ** 20n, maxPerCallWei: 2n * 10n ** 18n }));
    expect(decision).toEqual({ kind: "INVEST", amountIn: 2n * 10n ** 18n });
  });

  it("clamps to what the rolling cap still allows", () => {
    const decision = decideInvestment(state({ wethBalance: 10n ** 20n, capRemaining: 3n * 10n ** 18n }));
    expect(decision).toEqual({ kind: "INVEST", amountIn: 3n * 10n ** 18n });
  });

  /**
   * Clamping must never drop the amount BACK under the admin's threshold. Buying
   * less than the user asked to buy in one go is not a smaller version of what
   * they wanted; it is a different thing, and it would quietly spend the
   * remaining cap on a purchase they never authorised at that size.
   */
  it("refuses rather than buying under the threshold after clamping", () => {
    const decision = decideInvestment(
      state({ wethBalance: 10n ** 18n, minInvestmentWei: 10n ** 17n, capRemaining: 10n ** 16n }),
    );
    expect(decision).toEqual({ kind: "CAP_EXHAUSTED", remaining: 10n ** 16n });
  });
});

describe("the states that mean nothing is happening", () => {
  it("reports being switched off as its own state", () => {
    expect(decideInvestment(state({ enabled: false })).kind).toBe("DISABLED");
  });

  it("reports being paused separately from being switched off", () => {
    expect(decideInvestment(state({ paused: true })).kind).toBe("PAUSED");
  });

  /**
   * THE ONE THAT MATTERS. Enabled, funded, above the threshold — and buying
   * nothing. From the outside this is indistinguishable from a healthy idle
   * vault, which is exactly how the last two outages in this system presented.
   */
  it("reports an unset basket as a problem, not as a quiet skip", () => {
    const decision = decideInvestment(state({ basketHash: ZERO }));
    expect(decision.kind).toBe("NO_BASKET");
    expect(isActionableProblem(decision)).toBe(true);
  });

  it("reports an unchosen adapter as a problem", () => {
    expect(decideInvestment(state({ adapterId: ZERO })).kind).toBe("NO_BASKET");
  });

  /**
   * A guardian deactivating an adapter stops every vault using it in the same
   * block. Retrying does not fix that, so it must not be reported as a transient.
   */
  it("reports a retired adapter as a problem rather than retrying forever", () => {
    const decision = decideInvestment(state({ adapterActive: false }));
    expect(decision.kind).toBe("NO_BASKET");
    if (decision.kind !== "NO_BASKET") return;
    expect(decision.detail).toMatch(/no retry will fix/);
  });

  /**
   * The vault stores only the basket's HASH; the legs live in the event. If they
   * cannot be reconstructed the keeper cannot form the call at all — and that is
   * a very quiet way to stop, because every other reading looks correct.
   */
  it("reports legs it could not reconstruct as a problem", () => {
    const decision = decideInvestment(state({ knownBasketLegs: 0 }));
    expect(decision.kind).toBe("NO_BASKET");
    if (decision.kind !== "NO_BASKET") return;
    expect(decision.detail).toMatch(/could not be read from logs/);
  });

  it("reports a missing threshold as a problem", () => {
    expect(decideInvestment(state({ minInvestmentWei: 0n })).kind).toBe("NO_BASKET");
  });

  /**
   * Ordering, stated as a test because getting it wrong is silent: a vault that
   * is both above its threshold and misconfigured must report the misconfiguration.
   * Reporting the quieter of two true statements is how an outage gets described
   * as normal.
   */
  it("prefers the actionable problem when both are true", () => {
    const decision = decideInvestment(state({ basketHash: ZERO, wethBalance: 10n ** 20n }));
    expect(decision.kind).toBe("NO_BASKET");
  });

  it("does not treat waiting, pausing or a full cap as problems", () => {
    expect(isActionableProblem(decideInvestment(state({ enabled: false })))).toBe(false);
    expect(isActionableProblem(decideInvestment(state({ paused: true })))).toBe(false);
    expect(isActionableProblem(decideInvestment(state({ wethBalance: 1n, minInvestmentWei: 2n })))).toBe(false);
    expect(isActionableProblem(decideInvestment(state({ capRemaining: 0n })))).toBe(false);
  });
});
