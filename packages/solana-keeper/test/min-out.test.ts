// The slippage bound, in raw units, over the numbers a real purchase produced.
//
// The four zero-fee vectors moved here from measure-window.test.ts UNCHANGED,
// because the transfer-fee subtraction must not move them: a mint that charges
// nothing must price exactly as it always did, and the old arithmetic is
// re-derived below to prove it rather than asserted from memory.
//
// The rest is the fee itself. live-route.ts measures the observed price off the
// pool's OUTPUT VAULT — its gross outflow — while Raydium's swap_v2 and
// sip-vault's invest both check their thresholds against the NET delta the
// destination is credited. The gap is the mint's Token-2022 transfer fee: 50
// bps on both PreStocks mints since epoch 1032, uncapped, set by a key that
// moved them there from 0 and can schedule 10_000 bps with about two epochs'
// notice. Taken out of a 200 bps bound, that fee left 150.75 bps of real
// tolerance; at 200 it would leave none at all, and that is a throw, not a
// number.

import { describe, expect, it } from "vitest";
import { NO_TRANSFER_FEE, SLIPPAGE_BPS, netOfTransferFee, tightenMinOut } from "../src/min-out.js";

/** u64::MAX: maximum_fee on both PreStocks mints, i.e. no cap at all. */
const UNCAPPED = (1n << 64n) - 1n;
/** What those mints have charged since epoch 1032. */
const PRESTOCKS_FEE = { bps: 50n, maximumFee: UNCAPPED } as const;

describe("min_out", () => {
  it("a live observation tightens min_out far above the lab floor", () => {
    // The tester's real purchase: 1.00 USDC in, 464278 raw stock out.
    const observed = { inRaw: 1_000_000n, outRaw: 464_278n };
    // The floor the web writes: amountIn * 1e15 / 1e18 = amountIn / 1000.
    const floor = 1_000_000n / 1000n; // 1000 raw units — ~460x below market
    const { minOut, live } = tightenMinOut(1_000_000n, floor, observed, NO_TRANSFER_FEE);
    expect(live).toBe(true);
    // 2% under the observed rate, and hugely tighter than the floor.
    expect(minOut).toBe((464_278n * 9800n) / 10_000n);
    expect(minOut > floor * 400n, "the live bound must dwarf the lab floor").toBe(true);
  });

  it("without an observation it falls back to the floor and admits it", () => {
    const floor = 1_000n;
    const { minOut, live } = tightenMinOut(1_000_000n, floor, null, NO_TRANSFER_FEE);
    expect(minOut).toBe(floor);
    expect(live, "no observation must never be reported as live protection").toBe(false);
  });

  it("min_out is NEVER below the floor the owner signed", () => {
    // A collapsing pool: the observed rate is worse than the user's own floor.
    const observed = { inRaw: 1_000_000n, outRaw: 10n };
    const floor = 500_000n;
    const { minOut, live } = tightenMinOut(1_000_000n, floor, observed, NO_TRANSFER_FEE);
    expect(minOut, "the program requires min_out >= floor; tightening is the only direction").toBe(floor);
    expect(live).toBe(false);
  });

  it("a zero-input observation cannot divide by zero", () => {
    const { minOut, live } = tightenMinOut(1_000n, 7n, { inRaw: 0n, outRaw: 5n }, NO_TRANSFER_FEE);
    expect(minOut).toBe(7n);
    expect(live).toBe(false);
  });

  it("a mint that charges nothing prices EXACTLY as it did before the fee was subtracted", () => {
    // The arithmetic this module had before the fee existed, re-derived here so
    // the claim is proved against the current code rather than remembered.
    const before = (amountIn: bigint, floor: bigint, o: { inRaw: bigint; outRaw: bigint }): bigint => {
      const bounded = (((amountIn * o.outRaw) / o.inRaw) * (10_000n - SLIPPAGE_BPS)) / 10_000n;
      return bounded <= floor ? floor : bounded;
    };
    const vectors = [
      { amountIn: 1_000_000n, floor: 1_000n, observed: { inRaw: 1_000_000n, outRaw: 464_278n } },
      { amountIn: 7n, floor: 1n, observed: { inRaw: 1_000_000n, outRaw: 464_278n } },
      { amountIn: 3_333_333n, floor: 3_333n, observed: { inRaw: 999_999n, outRaw: 1n } },
      { amountIn: 500_000_000n, floor: 0n, observed: { inRaw: 1n, outRaw: 1_000_000_000n } },
    ];
    for (const v of vectors) {
      expect(tightenMinOut(v.amountIn, v.floor, v.observed, NO_TRANSFER_FEE).minOut).toBe(before(v.amountIn, v.floor, v.observed));
    }
  });
});

describe("the output mint's transfer fee", () => {
  const observed = { inRaw: 1_000_000n, outRaw: 464_278n };
  const floor = 1_000n;
  /** The pool's gross outflow for a 1.00 USDC buy at the observed rate. */
  const gross = 464_278n;
  /** What Token-2022 withholds at 50 bps: 2321.39, ROUNDED UP. */
  const fee = 2_322n;
  const net = gross - fee;

  it("prices a 50 bps leg against the net the vault is credited, not the vault's gross outflow", () => {
    expect(netOfTransferFee(gross, PRESTOCKS_FEE)).toBe(net);
    expect(net).toBe(461_956n);
    const { minOut, live } = tightenMinOut(1_000_000n, floor, observed, PRESTOCKS_FEE);
    expect(live).toBe(true);
    expect(minOut).toBe(452_716n); // 461_956 × 9800 / 10_000
    // Tighter than the zero-fee bound by exactly the fee's share of it.
    expect(minOut < tightenMinOut(1_000_000n, floor, observed, NO_TRANSFER_FEE).minOut).toBe(true);
    // And the tolerance now means what it says: 2% of what actually arrives.
    expect(((net - minOut) * 10_000n) / net).toBe(SLIPPAGE_BPS);
  });

  it("is what the gross-priced bound was silently spending: 150 bps of tolerance left, not 200", () => {
    // What the old arithmetic demanded, against what the vault can be credited.
    const grossPriced = tightenMinOut(1_000_000n, floor, observed, NO_TRANSFER_FEE).minOut;
    expect(grossPriced).toBe(454_992n);
    expect(grossPriced < net, "it cleared — which is why nobody noticed").toBe(true);
    expect(((net - grossPriced) * 10_000n) / net).toBe(150n); // 150.75 bps

    // AND IT ABSORBED WHATEVER CAME NEXT. The same gross bound against a 199 bps
    // fee — one the authority can schedule on these mints in two epochs — leaves
    // a single basis point between the keeper's demand and the best possible
    // fill, so every leg fails on a price that moved at all.
    const nearly = netOfTransferFee(gross, { bps: 199n, maximumFee: UNCAPPED });
    expect(((nearly - grossPriced) * 10_000n) / nearly).toBe(1n);
    // Priced against the net, the same fee simply costs what it costs.
    expect(tightenMinOut(1_000_000n, floor, observed, { bps: 199n, maximumFee: UNCAPPED }).minOut).toBe((nearly * 9800n) / 10_000n);
  });

  it("REFUSES a fee at or above the slippage bound instead of absorbing it", () => {
    for (const bps of [SLIPPAGE_BPS, SLIPPAGE_BPS + 1n, 1_000n, 10_000n]) {
      expect(() => tightenMinOut(1_000_000n, floor, observed, { bps, maximumFee: UNCAPPED })).toThrow(
        /transfer fee, at or above the 200 bps slippage bound/,
      );
      // Not even with no observation to price: the refusal is about the leg, not the route.
      expect(() => tightenMinOut(1_000_000n, floor, null, { bps, maximumFee: UNCAPPED })).toThrow(/refusing to price/);
    }
    // One basis point under it still prices.
    expect(tightenMinOut(1_000_000n, floor, observed, { bps: SLIPPAGE_BPS - 1n, maximumFee: UNCAPPED }).live).toBe(true);
  });

  it("rounds the fee UP and honours maximum_fee, as Token-2022's calculate_fee does", () => {
    // 1 raw unit at 50 bps owes 0.005 — and Token-2022 still takes one.
    expect(netOfTransferFee(1n, PRESTOCKS_FEE)).toBe(0n);
    expect(netOfTransferFee(200n, PRESTOCKS_FEE)).toBe(199n);
    expect(netOfTransferFee(201n, PRESTOCKS_FEE)).toBe(199n); // 1.005 → 2
    // A capped mint pays the cap, however large the transfer.
    expect(netOfTransferFee(1_000_000n, { bps: 50n, maximumFee: 100n })).toBe(999_900n);
    // Nothing at all: gross through, whatever the cap says.
    expect(netOfTransferFee(1_000_000n, NO_TRANSFER_FEE)).toBe(1_000_000n);
    expect(netOfTransferFee(0n, PRESTOCKS_FEE)).toBe(0n);
  });
});
