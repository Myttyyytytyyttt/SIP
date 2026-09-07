// The quote the keeper hands to `invest()` as its floor.
//
// THE ONE THAT MATTERS is `matches the live mainnet pools`. Everything else here
// checks the arithmetic behaves; that one checks the arithmetic is describing the
// pools this vault actually trades in. A quote module that is internally
// consistent and disagrees with the chain produces floors that are either
// unreachable — every purchase reverts — or meaningless.

import { describe, expect, it } from "vitest";

import {
  DEFAULT_TOLERANCE_BPS,
  minOutFromQuote,
  quoteExactInSingle,
  quoteTwoHop,
  splitAcrossLegs,
  type PoolState,
} from "../src/quote.js";

/**
 * Read off Robinhood Chain mainnet. These are the two pools the adapter pins.
 *
 *   WETH/USDG   fee 500 (0.05%), tickSpacing 10
 *   USDG/NVDA   fee 3000 (0.30%), tickSpacing 60
 *
 * WETH sorts below USDG and USDG below NVDA, so the route spends currency0 on
 * both hops.
 */
const WETH_USDG: PoolState = {
  sqrtPriceX96: 3435887068360568108188696n,
  liquidity: 68_903_952_934_212_396n,
  // The EFFECTIVE fee from slot0: lpFee 500 composed with protocolFee 125.
  feePips: 625,
  zeroForOne: true,
};

const USDG_NVDA: PoolState = {
  sqrtPriceX96: 5285137176772789725945204142569457n,
  liquidity: 1_171_748_594_528_528_804n,
  // lpFee 3000 composed with protocolFee 500.
  feePips: 3499,
  zeroForOne: true,
};

const ETH = 10n ** 18n;

describe("quoting a single hop", () => {
  it("returns nothing for a dead pool rather than dividing by zero", () => {
    expect(quoteExactInSingle({ ...WETH_USDG, liquidity: 0n }, ETH)).toBe(0n);
    expect(quoteExactInSingle({ ...WETH_USDG, sqrtPriceX96: 0n }, ETH)).toBe(0n);
    expect(quoteExactInSingle(WETH_USDG, 0n)).toBe(0n);
    expect(quoteExactInSingle(WETH_USDG, -1n)).toBe(0n);
  });

  /**
   * The fee comes off the INPUT, before the curve. Taking it off the output
   * instead is the natural mistake and it overstates every quote by roughly the
   * fee — which on a two-hop route compounds into a floor no fill can clear.
   */
  it("charges the fee on the way in, not on the way out", () => {
    const free = quoteExactInSingle({ ...WETH_USDG, feePips: 0 }, ETH);
    const charged = quoteExactInSingle(WETH_USDG, ETH);
    expect(charged).toBeLessThan(free);
    // 0.05% of the input, within a basis point of a basis point.
    const impliedBps = Number(((free - charged) * 10_000n) / free);
    expect(impliedBps).toBeGreaterThanOrEqual(5);
    expect(impliedBps).toBeLessThanOrEqual(7);
  });

  /**
   * Cross-multiplied rather than divided. `out / in` in bigint arithmetic
   * truncates both sides to zero here — the outputs are 6-decimal USDG and the
   * inputs are 18-decimal wei — so a division-based comparison asserts 0 < 0 and
   * passes for a quote function that ignores size entirely.
   */
  it("gives less per unit as the trade gets bigger", () => {
    const smallIn = ETH / 1000n;
    const largeIn = ETH * 100n;
    const small = quoteExactInSingle(WETH_USDG, smallIn);
    const large = quoteExactInSingle(WETH_USDG, largeIn);
    expect(small).toBeGreaterThan(0n);
    expect(large).toBeGreaterThan(0n);
    // small/smallIn > large/largeIn, without ever dividing.
    expect(small * largeIn).toBeGreaterThan(large * smallIn);
  });
});

describe("the live pools", () => {
  /**
   * THE ANCHOR, and the number in it is not the fee.
   *
   *   1 WETH = 1880.71 USDG,  1 NVDA = 224.72 USDG,  fair rate 8.3691 NVDA/WETH
   *
   * At ONE ETH the cost is 48.7 bps: 41.2 of effective fee plus ~7.5 of real
   * price impact, because 1 ETH is large against this pool. The fee-only figure
   * appears in the vault-sized test below, where impact is unmeasurable. Reading
   * this bound as "the fee" is how the 35 bps mistake was made in the first
   * place.
   *
   * If this drifts, either the pool state above is stale or the arithmetic
   * stopped describing Uniswap v4.
   */
  it("matches the live mainnet pools", () => {
    const out = quoteTwoHop(WETH_USDG, USDG_NVDA, ETH);
    const nvda = Number(out) / 1e18;
    expect(nvda).toBeGreaterThan(8.32);
    expect(nvda).toBeLessThan(8.34);

    const mid = 1880.71 / 224.72;
    const costBps = (1 - nvda / mid) * 10_000;
    // 41.2 of fee + ~7.5 of impact at this size.
    expect(costBps).toBeGreaterThan(48);
    expect(costBps).toBeLessThan(50);
  });

  /**
   * THE SIZE THE VAULT ACTUALLY TRADES. The live vault holds 406,589,807,384,335
   * wei — about 76 cents. At that size the entire cost is the two fees and price
   * impact is unmeasurable, which is the whole reason an oracle was not buying
   * anything the pinned pool does not already give.
   */
  it("costs essentially only the fees at the vault's real size", () => {
    const real = 406_589_807_384_335n;
    const out = quoteTwoHop(WETH_USDG, USDG_NVDA, real);
    const mid = 1880.71 / 224.72;
    const expected = (Number(real) / 1e18) * mid;
    const costBps = (1 - Number(out) / 1e18 / expected) * 10_000;
    // 41.2 bps is the two EFFECTIVE fees. Anything above is price impact.
    expect(costBps).toBeGreaterThan(41);
    expect(costBps).toBeLessThan(42);
  });

  it("shows real impact only once the trade is large", () => {
    const mid = 1880.71 / 224.72;
    const cost = (amount: bigint) => {
      const out = quoteTwoHop(WETH_USDG, USDG_NVDA, amount);
      const expected = (Number(amount) / 1e18) * mid;
      return (1 - Number(out) / 1e18 / expected) * 10_000;
    };
    expect(cost(ETH / 20n)).toBeLessThan(42);
    expect(cost(ETH * 10n)).toBeGreaterThan(90);
  });
});

describe("turning a quote into a floor", () => {
  it("subtracts the tolerance and nothing else", () => {
    expect(minOutFromQuote(10_000n, 50)).toBe(9_950n);
    expect(minOutFromQuote(10_000n, 0)).toBe(10_000n);
  });

  it("refuses a tolerance that is not a sane percentage", () => {
    expect(() => minOutFromQuote(1n, -1)).toThrow(RangeError);
    expect(() => minOutFromQuote(1n, 10_000)).toThrow(RangeError);
    expect(() => minOutFromQuote(1n, 1.5)).toThrow(RangeError);
  });

  it("passes zero through rather than inventing a floor", () => {
    expect(minOutFromQuote(0n, DEFAULT_TOLERANCE_BPS)).toBe(0n);
  });

  /**
   * A fair fill must clear the floor. Stated because the fees live INSIDE the
   * quote: if they were added on top instead, the default tolerance would not be
   * enough to cover them and every honest purchase would revert.
   */
  it("accepts the fill the pool would actually give", () => {
    const quoted = quoteTwoHop(WETH_USDG, USDG_NVDA, ETH);
    const floor = minOutFromQuote(quoted, DEFAULT_TOLERANCE_BPS);
    expect(floor).toBeLessThan(quoted);
    expect(floor).toBeGreaterThan((quoted * 99n) / 100n);
  });
});

describe("splitting across a basket", () => {
  it("assigns each leg its weight", () => {
    expect(splitAcrossLegs(1000n, [5000, 5000])).toEqual([500n, 500n]);
    expect(splitAcrossLegs(1000n, [10_000])).toEqual([1000n]);
  });

  /**
   * THE LAST LEG ABSORBS THE DUST, matching `PersonalVault.invest` exactly. If
   * the keeper split differently its floors would be computed for amounts the
   * vault does not swap, and every purchase would miss its own quote by a few wei
   * for a reason nobody could locate.
   */
  it("gives the remainder to the last leg, so the parts sum to the whole", () => {
    const legs = splitAcrossLegs(1001n, [3333, 3333, 3334]);
    expect(legs.reduce((a, b) => a + b, 0n)).toBe(1001n);
    expect(legs[2]).toBeGreaterThan(legs[0]!);
  });

  it("sums to the whole for awkward amounts and weights", () => {
    for (const amount of [1n, 7n, 999_999_999_999_999_999n, 406_589_807_384_335n]) {
      for (const weights of [[10_000], [5000, 5000], [3333, 3333, 3334], [1250, 1250, 2500, 5000]]) {
        const legs = splitAcrossLegs(amount, weights);
        expect(legs.reduce((a, b) => a + b, 0n)).toBe(amount);
      }
    }
  });

  it("returns nothing for an empty basket", () => {
    expect(splitAcrossLegs(1000n, [])).toEqual([]);
  });
});
