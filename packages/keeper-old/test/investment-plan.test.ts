// Assembling the `invest()` call, and refusing to assemble a wrong one.
//
// THE TESTS THAT CARRY THE MOST WEIGHT are the parity ones. Everything else here
// checks that the planner refuses what it should; those check that the planner's
// idea of a basket is byte-identical to the contract's. The vault uses the hash
// as a compare-and-swap (PersonalVault.sol:659), so an encoder that disagrees
// makes every recovered basket look tampered with — an outage that reports the
// vault admin's configuration as corrupt when the bug is in this file.

import { describe, expect, it } from "vitest";

import { basketHash, describePlan, planInvestment, type BasketLeg, type LegRoute } from "../src/investment-plan.js";
import type { PoolState } from "../src/quote.js";

/**
 * Printed by Solidity — packages/contracts/test/unit/BasketEncodingParity.t.sol,
 * `forge test --match-path ... -vv`. Regenerate them from that test, never by
 * copying whatever this encoder happens to produce, or the check is circular and
 * proves only that the file agrees with itself.
 */
const SOLIDITY_VECTORS = {
  oneLeg: "0x704f5f3e50617f2c59ac2707cda48b2fcd69ccab7f3304739a7c235f1dc1bce3",
  twoLeg: "0xabb79166cc34a36621dc658c588f1d929e4df67c336d60e7161c63687ad86759",
  twoLegSwapped: "0x45bd50ca761e1e542204032bdbbaee272034d033f0a2e2fbb0d0bb795989e2eb",
  empty: "0x569e75fc77c1a856f6daaf9e69d8a9566ca34aa47f9133711ce065a571af0cfd",
} as const;

const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const;
const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC" as const;
const SPY = "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C" as const;

/**
 * NOT the mid rate. 8.3690e18 NVDA/WETH is the pool's MID, and the route costs 35
 * bps in fees before impact — so an admin who sets the floor at mid has built a
 * vault that can never buy. That trap is pinned in its own test below; this
 * fixture carries the 1% of slack a working configuration needs.
 */
const ONE_LEG: BasketLeg[] = [{ targetAsset: NVDA, weightBps: 10_000, minOutRateWad: 8_285_357_364_570_000_000n }];

/** The exact legs BasketEncodingParity.t.sol hashes. Parity only — never planned. */
const VECTOR_ONE_LEG: BasketLeg[] = [
  { targetAsset: NVDA, weightBps: 10_000, minOutRateWad: 8_369_047_843_000_000_000n },
];
const VECTOR_TWO_LEG: BasketLeg[] = [
  { targetAsset: NVDA, weightBps: 6_000, minOutRateWad: 8_369_047_843_000_000_000n },
  { targetAsset: SPY, weightBps: 4_000, minOutRateWad: 1n },
];
const TWO_LEG: BasketLeg[] = [
  { targetAsset: NVDA, weightBps: 6_000, minOutRateWad: 8_285_357_364_570_000_000n },
  { targetAsset: SPY, weightBps: 4_000, minOutRateWad: 1n },
];

// The live mainnet pools, same state as quote.test.ts.
const WETH_USDG: PoolState = {
  sqrtPriceX96: 3435887068360568108188696n,
  liquidity: 68_903_952_934_212_396n,
  feePips: 500,
  zeroForOne: true,
};
const USDG_STOCK: PoolState = {
  sqrtPriceX96: 5285137176772789725945204142569457n,
  liquidity: 1_171_748_594_528_528_804n,
  feePips: 3000,
  zeroForOne: true,
};

const poolsFor = (assets: readonly string[], override?: Partial<Extract<LegRoute, { kind: "STOCK" }>>): Map<string, LegRoute> =>
  new Map(
    assets.map((a) => [
      a.toLowerCase(),
      { kind: "STOCK", wethToUsdg: WETH_USDG, usdgToStock: USDG_STOCK, ...override } satisfies LegRoute,
    ]),
  );

const ETH = 10n ** 18n;

function plan(over: Partial<Parameters<typeof planInvestment>[0]> = {}) {
  return planInvestment({
    legs: ONE_LEG,
    amountIn: ETH / 100n,
    pools: poolsFor([NVDA]),
    expectedBasketHash: basketHash(ONE_LEG),
    policyNonce: 1n,
    adapterStatusEpoch: 1n,
    deadline: 2_000_000_000,
    ...over,
  });
}

describe("encoding a basket the way the contract does", () => {
  it("reproduces Solidity's hash for one leg", () => {
    expect(basketHash(VECTOR_ONE_LEG)).toBe(SOLIDITY_VECTORS.oneLeg);
  });

  it("reproduces Solidity's hash for two legs", () => {
    expect(basketHash(VECTOR_TWO_LEG)).toBe(SOLIDITY_VECTORS.twoLeg);
  });

  /**
   * Order is part of the basket. If this collided, a keeper could present the
   * admin's legs in a different order — changing which asset gets which share —
   * and the vault's compare-and-swap would wave it through.
   */
  it("keeps leg order significant, exactly as Solidity does", () => {
    const swapped = [VECTOR_TWO_LEG[1]!, VECTOR_TWO_LEG[0]!];
    expect(basketHash(swapped)).toBe(SOLIDITY_VECTORS.twoLegSwapped);
    expect(basketHash(swapped)).not.toBe(basketHash(VECTOR_TWO_LEG));
  });

  /// An empty basket hashes to something, and it is not the "never set" sentinel.
  it("reproduces Solidity's hash for an empty basket", () => {
    expect(basketHash([])).toBe(SOLIDITY_VECTORS.empty);
    expect(basketHash([])).not.toBe(`0x${"0".repeat(64)}`);
  });
});

describe("planning a purchase", () => {
  it("produces a call with one floor per leg", () => {
    const result = plan();
    expect(result.kind).toBe("PLAN");
    if (result.kind !== "PLAN") return;
    expect(result.call.minAmountsOut).toHaveLength(1);
    expect(result.call.minAmountsOut[0]).toBeGreaterThan(0n);
    expect(result.call.amountIn).toBe(ETH / 100n);
    expect(result.call.policyNonce).toBe(1n);
  });

  it("splits a two-leg basket by weight and sums back to the whole", () => {
    const result = plan({
      legs: TWO_LEG,
      pools: poolsFor([NVDA, SPY]),
      expectedBasketHash: basketHash(TWO_LEG),
      // A real size. 1001 wei splits into legs that quote nothing at all, which
      // is a different (and correctly refused) case — see the dust test below.
      amountIn: ETH / 100n + 1n,
    });
    expect(result.kind).toBe("PLAN");
    if (result.kind !== "PLAN") return;
    const total = result.call.quoted.reduce((sum, q) => sum + q.legAmount, 0n);
    expect(total).toBe(ETH / 100n + 1n);
    expect(result.call.quoted[0]!.legAmount).toBeGreaterThan(result.call.quoted[1]!.legAmount);
  });

  /**
   * THE FLOOR IS BELOW THE QUOTE BUT NOT FAR BELOW. A floor above the quote makes
   * every honest fill revert; a floor at zero protects nothing. Both directions
   * are asserted because only checking one lets a broken tolerance through.
   */
  it("sets each floor just under what the pool actually quotes", () => {
    const result = plan();
    if (result.kind !== "PLAN") throw new Error("expected a plan");
    const { quote } = result.call.quoted[0]!;
    const floor = result.call.minAmountsOut[0]!;
    expect(floor).toBeLessThan(quote);
    expect(floor).toBeGreaterThan((quote * 99n) / 100n);
  });
});

describe("the three routes a leg can take", () => {
  /**
   * DOLLARS IS ONE HOP, and quoting it as two would be quoting a pool that
   * cannot exist — there is no USDG/USDG pair. The planner used to require a
   * second PoolState for every leg, which is why a savings basket was refused
   * before it was ever attempted.
   */
  it("quotes a dollar leg through one pool, not two", () => {
    const legs: BasketLeg[] = [{ targetAsset: USDG, weightBps: 10_000, minOutRateWad: 1n }];
    const plan = planInvestment({
      legs,
      amountIn: 10n ** 18n,
      pools: new Map([[USDG.toLowerCase(), { kind: "DOLLARS", wethToUsdg: WETH_USDG } satisfies LegRoute]]),
      expectedBasketHash: basketHash(legs),
      policyNonce: 1n,
      adapterStatusEpoch: 1n,
      deadline: 1_800_000_000,
    });
    expect(plan.kind).toBe("PLAN");
    if (plan.kind === "PLAN") expect(plan.call.minAmountsOut[0]).toBeGreaterThan(0n);
  });

  /**
   * A YIELD LEG'S FLOOR IS IN SHARES, and the shares come from the destination's
   * own previewDeposit rather than from any arithmetic here. Share decimals are
   * a property of the vault — spUSDG mints 6, steakUSDG 18, over the same
   * 6-decimal dollar — so a number computed locally would be right for one and
   * wrong by 1e12 for the other.
   */
  it("takes a yield leg's floor from the previewed shares", () => {
    const legs: BasketLeg[] = [{ targetAsset: NVDA, weightBps: 10_000, minOutRateWad: 1n }];
    const previewed = 2_486_837_390n;
    const plan = planInvestment({
      legs,
      amountIn: 10n ** 18n,
      pools: new Map([[NVDA.toLowerCase(), { kind: "YIELD", wethToUsdg: WETH_USDG, shares: previewed, quoter: NVDA } satisfies LegRoute]]),
      expectedBasketHash: basketHash(legs),
      policyNonce: 1n,
      adapterStatusEpoch: 1n,
      deadline: 1_800_000_000,
    });
    expect(plan.kind).toBe("PLAN");
    if (plan.kind === "PLAN") {
      // The tolerance is applied to the previewed number and nothing else.
      expect(plan.call.minAmountsOut[0]).toBeLessThanOrEqual(previewed);
      expect(plan.call.minAmountsOut[0]).toBeGreaterThan((previewed * 9n) / 10n);
    }
  });

  /// A vault refusing deposits previews nothing, and that is a refusal, not a buy.
  it("refuses a yield leg the destination would not accept", () => {
    const legs: BasketLeg[] = [{ targetAsset: NVDA, weightBps: 10_000, minOutRateWad: 1n }];
    const plan = planInvestment({
      legs,
      amountIn: 10n ** 18n,
      pools: new Map([[NVDA.toLowerCase(), { kind: "YIELD", wethToUsdg: WETH_USDG, shares: 0n, quoter: NVDA } satisfies LegRoute]]),
      expectedBasketHash: basketHash(legs),
      policyNonce: 1n,
      adapterStatusEpoch: 1n,
      deadline: 1_800_000_000,
    });
    expect(plan.kind).toBe("REFUSED");
    if (plan.kind === "REFUSED") expect(plan.reason).toMatch(/previewed no shares/i);
  });
});

describe("the refusals, each one named", () => {
  it("refuses an empty basket", () => {
    const result = plan({ legs: [], expectedBasketHash: basketHash([]) });
    expect(result.kind).toBe("REFUSED");
    if (result.kind !== "REFUSED") return;
    expect(result.reason).toMatch(/no legs/);
  });

  it("refuses a non-positive amount", () => {
    expect(plan({ amountIn: 0n }).kind).toBe("REFUSED");
    expect(plan({ amountIn: -1n }).kind).toBe("REFUSED");
  });

  it("refuses weights that do not sum to 100%", () => {
    const legs: BasketLeg[] = [{ targetAsset: NVDA, weightBps: 9_000, minOutRateWad: 1n }];
    const result = plan({ legs, expectedBasketHash: basketHash(legs) });
    expect(result.kind).toBe("REFUSED");
    if (result.kind !== "REFUSED") return;
    expect(result.reason).toMatch(/9000/);
  });

  /**
   * THE SUPERSEDED-POLICY CASE, which happens every time an admin reconfigures.
   * Without this the keeper spends a transaction to learn it from a revert.
   */
  it("refuses legs that do not hash to what the vault stores", () => {
    const result = plan({ expectedBasketHash: `0x${"ab".repeat(32)}` });
    expect(result.kind).toBe("REFUSED");
    if (result.kind !== "REFUSED") return;
    expect(result.reason).toMatch(/superseded policy/);
  });

  /**
   * DUST IS REFUSED, NOT PLANNED WITH A ZERO FLOOR. A leg small enough that the
   * pool quotes nothing would otherwise produce `minAmountOut = 0`, which is the
   * one value that accepts any fill at any price — the exact hole the adapter's
   * removed oracle used to cover.
   */
  it("refuses an amount too small for a leg to quote", () => {
    const result = plan({
      legs: TWO_LEG,
      pools: poolsFor([NVDA, SPY]),
      expectedBasketHash: basketHash(TWO_LEG),
      amountIn: 1001n,
    });
    expect(result.kind).toBe("REFUSED");
    if (result.kind !== "REFUSED") return;
    expect(result.reason).toMatch(/quote nothing/);
  });

  it("refuses when a leg's pool state was not read", () => {
    const result = plan({ pools: new Map() });
    expect(result.kind).toBe("REFUSED");
    if (result.kind !== "REFUSED") return;
    expect(result.reason).toMatch(/no route was read/i);
  });

  it("refuses when the pinned pool is empty", () => {
    const result = plan({ pools: poolsFor([NVDA], { usdgToStock: { ...USDG_STOCK, liquidity: 0n } }) });
    expect(result.kind).toBe("REFUSED");
    if (result.kind !== "REFUSED") return;
    expect(result.reason).toMatch(/quote nothing|empty/i);
  });

  /**
   * THE FROZEN-RATE FAILURE, reported rather than discovered. A `minOutRateWad`
   * set months ago drifts out of reach of the market as ETH and the stock move
   * independently; the vault would revert on it and the operator would see a
   * failing transaction with no cause. Naming it here is the difference between
   * "reset your rate" and "the keeper is broken".
   */
  it("refuses, and says so, when the admin's frozen rate is above the market", () => {
    const legs: BasketLeg[] = [{ targetAsset: NVDA, weightBps: 10_000, minOutRateWad: 1_000n * 10n ** 18n }];
    const result = plan({ legs, expectedBasketHash: basketHash(legs) });
    expect(result.kind).toBe("REFUSED");
    if (result.kind !== "REFUSED") return;
    expect(result.reason).toMatch(/drifted out of reach/);
  });

  /// The same rate, at a level the market can meet, plans normally.
  it("accepts an admin rate the market can still meet", () => {
    const legs: BasketLeg[] = [{ targetAsset: NVDA, weightBps: 10_000, minOutRateWad: 8n * 10n ** 18n }];
    expect(plan({ legs, expectedBasketHash: basketHash(legs) }).kind).toBe("PLAN");
  });
});

describe("describing a plan", () => {
  it("names every leg and both numbers an operator would want", () => {
    const result = plan();
    if (result.kind !== "PLAN") throw new Error("expected a plan");
    const line = describePlan(result.call);
    expect(line).toContain(NVDA);
    expect(line).toContain(String(result.call.minAmountsOut[0]));
    expect(line).toMatch(/invest \d+ wei across 1 leg/);
  });
});
