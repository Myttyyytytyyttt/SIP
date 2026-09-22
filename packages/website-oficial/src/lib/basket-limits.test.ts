// The arithmetic a picker has to obey, pinned on BOTH SIDES of every boundary.
//
// Each of the three limits here is an exact integer edge, not an estimate, so
// every case below asserts the value AND the value one raw unit past it. A test
// that only checks the passing side cannot tell a correct bound from a lax one.

import { describe, expect, it } from "vitest";

import { MAX_LEGS } from "@sip/solana-core/client";

import { capWindow, depthCeiling, floorLoss, smallestLegalCap, weightsAreLegal, type BasketLegDepth } from "@/lib/basket-limits";
import { POOL_DEPTH_MULTIPLE } from "@/lib/vault-copy";

const MULTIPLE = BigInt(POOL_DEPTH_MULTIPLE);

/** A basket from bare shares, with distinct mints. */
const basket = (...weightsBps: number[]) => weightsBps.map((weightBps, index) => ({ mint: `Mint${index}`, weightBps }));

/** The same, each leg carrying the inventory its venue was counted at. */
const deep = (...legs: readonly (readonly [number, bigint])[]): BasketLegDepth[] =>
  legs.map(([weightBps, venueInventoryRaw], index) => ({ mint: `Mint${index}`, weightBps, venueInventoryRaw }));

/** The keeper's own gate, restated here so the ceiling is checked against the RULE and not against itself. */
const keeperWouldRefuse = (cap: bigint, legs: readonly BasketLegDepth[]): boolean =>
  legs.some((leg) => leg.venueInventoryRaw < ((cap * BigInt(leg.weightBps)) / 10_000n) * MULTIPLE);

describe("weightsAreLegal mirrors set_invest_policy, so Phantom is never asked for a doomed signature", () => {
  it("accepts a basket the program accepts", () => {
    expect(weightsAreLegal(basket(10_000))).toEqual({ ok: true });
    expect(weightsAreLegal(basket(2_000, 2_000, 2_000, 2_000, 2_000))).toEqual({ ok: true });
    expect(weightsAreLegal(basket(500, 9_500))).toEqual({ ok: true });
  });

  it("holds the sum to EXACTLY 10,000 on both sides, because nothing is normalised", () => {
    // A 9,999 is not rounded up and a 10,001 is not trimmed: each is a
    // different basket from the one the owner is looking at.
    expect(weightsAreLegal(basket(5_000, 4_999)).ok).toBe(false);
    expect(weightsAreLegal(basket(5_000, 5_000)).ok).toBe(true);
    expect(weightsAreLegal(basket(5_000, 5_001)).ok).toBe(false);
  });

  it("refuses a zero share rather than treating it as unchosen", () => {
    // require!(leg.weight_bps > 0). An untick must REMOVE the row.
    const refused = weightsAreLegal([...basket(10_000), { mint: "MintZ", weightBps: 0 }]);
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.problems.some((p) => p.includes("#2"))).toBe(true);
  });

  it("refuses a fractional or over-u16 share", () => {
    expect(weightsAreLegal([{ mint: "A", weightBps: 5_000.5 }, { mint: "B", weightBps: 4_999.5 }]).ok).toBe(false);
    expect(weightsAreLegal([{ mint: "A", weightBps: 65_536 }, { mint: "B", weightBps: -55_536 }]).ok).toBe(false);
  });

  it("refuses a repeated mint even when the shares add up", () => {
    // The program inserts into a BTreeSet, so the SECOND copy fails.
    expect(weightsAreLegal([{ mint: "A", weightBps: 5_000 }, { mint: "A", weightBps: 5_000 }]).ok).toBe(false);
  });

  it("pins the leg count on both sides of MAX_LEGS, and refuses an empty basket", () => {
    const share = 10_000 / MAX_LEGS;
    expect(Number.isInteger(share)).toBe(true);
    expect(weightsAreLegal(basket(...Array<number>(MAX_LEGS).fill(share))).ok).toBe(true);
    const tooMany = [...Array<number>(MAX_LEGS).fill(share), share].map((w, i) => ({ mint: `M${i}`, weightBps: w }));
    // One leg too many, and the shares no longer sum either — both are named.
    expect(weightsAreLegal(tooMany).ok).toBe(false);
    expect(weightsAreLegal([]).ok).toBe(false);
  });

  it("names every problem at once, not the first", () => {
    const verdict = weightsAreLegal([{ mint: "A", weightBps: 0 }, { mint: "A", weightBps: 3_000 }]);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.problems.length).toBeGreaterThanOrEqual(3);
  });
});

describe("smallestLegalCap: the cap at which the LIGHTEST leg clears min_investment", () => {
  /** The program's own per-leg rule, restated: every leg's floor()ed share clears the minimum. */
  const everyLegBuys = (cap: bigint, weights: readonly number[], min: bigint): boolean =>
    weights.every((w) => (cap * BigInt(w)) / 10_000n >= min);

  it("is the same number as min_investment at ONE leg — which is how the bug hid", () => {
    expect(smallestLegalCap(basket(10_000), 5_000_000n)).toBe(5_000_000n);
  });

  it("is exact at two equal legs, and one raw unit less cannot buy", () => {
    // $2.50 minimum, two 50 % legs: $5.00 exactly. At $4.999999 each leg gets
    // $2.4999995 → floor $2.499999, a cent's millionth short, and the WHOLE
    // turn goes IDLE.
    const weights = [5_000, 5_000];
    const cap = smallestLegalCap(basket(...weights), 2_500_000n);
    expect(cap).toBe(5_000_000n);
    expect(everyLegBuys(cap, weights, 2_500_000n)).toBe(true);
    expect(everyLegBuys(cap - 1n, weights, 2_500_000n)).toBe(false);
  });

  it("is set by the lightest leg, wherever it sits in the basket", () => {
    // 5 % is the bar: $1 minimum needs $20, not the $1.25 the 80 % leg implies.
    expect(smallestLegalCap(basket(500, 8_000, 1_500), 1_000_000n)).toBe(20_000_000n);
    expect(smallestLegalCap(basket(8_000, 1_500, 500), 1_000_000n)).toBe(20_000_000n);
  });

  it("rounds UP, never down, when the division is not exact", () => {
    // $5 over three legs: min $1,666,666 raw, lightest 3,333 bps.
    // 1,666,666 × 10,000 / 3,333 = 5,000,498.05… → 5,000,499.
    const weights = [3_334, 3_333, 3_333];
    const cap = smallestLegalCap(basket(...weights), 1_666_666n);
    expect(cap).toBe(5_000_499n);
    expect(everyLegBuys(cap, weights, 1_666_666n)).toBe(true);
    expect(everyLegBuys(cap - 1n, weights, 1_666_666n)).toBe(false);
  });

  it("walks the whole picker: five equal legs need five times the minimum, a 5 % leg twenty times", () => {
    expect(smallestLegalCap(basket(2_000, 2_000, 2_000, 2_000, 2_000), 1_000_000n)).toBe(5_000_000n);
    expect(smallestLegalCap(basket(500, 2_375, 2_375, 2_375, 2_375), 1_000_000n)).toBe(20_000_000n);
  });

  it("refuses to answer for an illegal basket or a zero minimum", () => {
    expect(() => smallestLegalCap(basket(5_000, 4_000), 1_000_000n)).toThrow(RangeError);
    expect(() => smallestLegalCap(basket(10_000), 0n)).toThrow(RangeError);
  });
});

describe("depthCeiling: the literal that could not follow a picker", () => {
  it("reproduces the number DEPTH_CEILING_PER_BUY_RAW was written from", () => {
    // ANTHROPIC/USDC held 9,541,652,779 raw USDC on 2026-09-20. 50x admits
    // 190,833,055 a leg; at two equal legs that is $381.67, which the old
    // literal rounded DOWN to $380. The function gives the un-rounded edge.
    const legs = deep([5_000, 9_541_652_779n], [5_000, 2_380_319_900_000n]);
    const { maxPerCallRaw, binding } = depthCeiling(legs);
    expect(maxPerCallRaw).toBe(381_666_111n);
    expect(binding?.mint).toBe("Mint0");
    expect(maxPerCallRaw).toBeGreaterThan(380_000_000n);
  });

  it("is exact against the keeper's own gate, on both sides", () => {
    const legs = deep([5_000, 9_541_652_779n], [5_000, 2_380_319_900_000n]);
    const { maxPerCallRaw } = depthCeiling(legs);
    expect(keeperWouldRefuse(maxPerCallRaw, legs)).toBe(false);
    expect(keeperWouldRefuse(maxPerCallRaw + 1n, legs)).toBe(true);
  });

  it("pins EXACTLY 50x cover as deep and one raw unit under as refused", () => {
    // legDepthDecision refuses on `inventory < take × 50`, strictly less.
    const atFifty = deep([10_000, 1_000_000n * MULTIPLE]);
    expect(depthCeiling(atFifty).maxPerCallRaw).toBe(1_000_000n);
    expect(keeperWouldRefuse(1_000_000n, atFifty)).toBe(false);
    const oneShort = deep([10_000, 1_000_000n * MULTIPLE - 1n]);
    expect(depthCeiling(oneShort).maxPerCallRaw).toBe(999_999n);
    expect(keeperWouldRefuse(1_000_000n, oneShort)).toBe(true);
  });

  it("moves with the WEIGHT on the same venue, which is why no constant survives", () => {
    // One venue, one day, two baskets. Halving a thin leg's share doubles the
    // cap the whole basket may carry.
    const thin = 7_450_000_000n;
    const half = depthCeiling(deep([5_000, thin], [5_000, 2_380_319_900_000n])).maxPerCallRaw;
    const fifth = depthCeiling(deep([2_000, thin], [8_000, 2_380_319_900_000n])).maxPerCallRaw;
    expect(half).toBe(298_000_001n);
    expect(fifth).toBe(745_000_004n);
    expect(fifth).toBeGreaterThan(half * 2n);
  });

  it("names the leg that set the ceiling, so the UI can say which one to drop", () => {
    const legs = deep([2_000, 2_100_000_000_000n], [2_000, 8_995_000_000n], [6_000, 331_617_000_000n]);
    expect(depthCeiling(legs).binding?.mint).toBe("Mint1");
  });

  it("returns a ceiling of zero when a venue cannot cover one raw unit fifty times", () => {
    const empty = deep([10_000, MULTIPLE - 1n]);
    expect(depthCeiling(empty).maxPerCallRaw).toBe(0n);
    expect(depthCeiling(deep([10_000, 0n])).maxPerCallRaw).toBe(0n);
  });

  it("refuses an illegal basket or an impossible inventory", () => {
    expect(() => depthCeiling(deep([5_000, 1n], [4_000, 1n]))).toThrow(RangeError);
    expect(() => depthCeiling(deep([10_000, -1n]))).toThrow(RangeError);
  });
});

describe("capWindow: the floor, the ceiling, and the baskets with nothing between them", () => {
  it("offers half the ceiling, the way SUGGESTED_PER_BUY_RAW already does", () => {
    const window = capWindow(deep([5_000, 9_541_652_779n], [5_000, 2_380_319_900_000n]), 2_500_000n);
    expect(window.floorRaw).toBe(5_000_000n);
    expect(window.ceilingRaw).toBe(381_666_111n);
    expect(window.empty).toBe(false);
    expect(window.suggestedRaw).toBe(190_833_055n);
  });

  it("reports an EMPTY window instead of a cap nobody can type", () => {
    // ANDURIL ($2,016 counted) carried at 90 %: 50x admits $40.32 a leg, so the
    // cap may not exceed about $44.80 — under the $50 a 10 % leg needs to clear
    // a $5 minimum. No max_per_call exists. The basket must be re-weighted.
    const legs = deep([9_000, 2_016_000_000n], [1_000, 2_100_000_000_000n]);
    const window = capWindow(legs, 5_000_000n);
    expect(window.ceilingRaw).toBeLessThan(window.floorRaw);
    expect(window.empty).toBe(true);
    expect(window.suggestedRaw).toBeNull();
    expect(window.binding?.mint).toBe("Mint0");
  });

  it("clamps the suggestion up to the floor rather than starting under it", () => {
    // A window one raw unit wide: half the ceiling is far below the floor.
    const legs = deep([10_000, 5_000_000n * MULTIPLE]);
    const window = capWindow(legs, 5_000_000n);
    expect(window.floorRaw).toBe(5_000_000n);
    expect(window.ceilingRaw).toBe(5_000_000n);
    expect(window.empty).toBe(false);
    expect(window.suggestedRaw).toBe(5_000_000n);
  });
});

describe("floorLoss: what the split leaves behind, and whether a leg can be starved", () => {
  it("leaves at most legs − 1 raw units, and never more, however awkward the weights", () => {
    for (const weights of [[3_334, 3_333, 3_333], [2_000, 2_000, 2_000, 2_000, 2_000], [1, 9_999], [1_234, 4_321, 4_445]]) {
      for (const budget of [1_000_000n, 190_833_055n, 999_999_999n, 7n]) {
        const { unspentRaw, sharesRaw } = floorLoss(budget, basket(...weights));
        expect(unspentRaw).toBeGreaterThanOrEqual(0n);
        expect(unspentRaw).toBeLessThanOrEqual(BigInt(weights.length - 1));
        expect(sharesRaw.reduce((a, b) => a + b, 0n) + unspentRaw).toBe(budget);
      }
    }
  });

  it("loses exactly nothing when the weights divide the budget", () => {
    expect(floorLoss(1_000_000n, basket(2_000, 2_000, 2_000, 2_000, 2_000)).unspentRaw).toBe(0n);
    expect(floorLoss(1_000_000n, basket(10_000)).unspentRaw).toBe(0n);
  });

  it("loses the maximum at the worst case, which is still a millionth of a cent times four", () => {
    // Five legs, a budget chosen so every share has a fractional part.
    const { unspentRaw } = floorLoss(9_999n, basket(1_999, 2_000, 2_000, 2_000, 2_001));
    expect(unspentRaw).toBe(4n);
  });

  it("starves a leg only under a CENT of budget, on both sides of the edge", () => {
    // floor(budget × w / 10,000) = 0 ⟺ budget × w < 10,000. At the program's
    // lightest legal weight, 1 bps, that is a budget under 10,000 raw = $0.01.
    const hair = basket(1, 9_999);
    expect(floorLoss(9_999n, hair).starvedMints).toEqual(["Mint0"]);
    expect(floorLoss(10_000n, hair).starvedMints).toEqual([]);
    expect(floorLoss(10_000n, hair).sharesRaw[0]).toBe(1n);
    // At the picker's own lightest weight, whole percents, it takes $0.0001.
    const percent = basket(100, 9_900);
    expect(floorLoss(99n, percent).starvedMints).toEqual(["Mint0"]);
    expect(floorLoss(100n, percent).starvedMints).toEqual([]);
  });

  it("cannot be reached from any cap smallestLegalCap allows — the minimum bites first", () => {
    // THE ANSWER TO "can any legal weight combination starve a leg at a
    // plausible budget": no, by four orders of magnitude. The smallest cap the
    // per-leg minimum permits is already far above the starving budget, and the
    // budget never exceeds the cap.
    for (const weights of [[1, 9_999], [100, 9_900], [500, 9_500], [2_000, 2_000, 2_000, 2_000, 2_000]]) {
      const legs = basket(...weights);
      const floorCap = smallestLegalCap(legs, 1_000_000n);
      for (const budget of [floorCap, floorCap * 1_000n]) {
        expect(floorLoss(budget, legs).starvedMints).toEqual([]);
      }
      // And a starving budget is orders of magnitude under the smallest cap.
      expect(floorCap).toBeGreaterThan(10_000n);
    }
  });

  it("refuses an illegal basket or a negative budget", () => {
    expect(() => floorLoss(1_000_000n, basket(5_000, 4_000))).toThrow(RangeError);
    expect(() => floorLoss(-1n, basket(10_000))).toThrow(RangeError);
  });
});
