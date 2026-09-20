// Gross or net, decided on REAL MEASURED FILLS, and the min_out rule that
// follows from them.
//
// WHY THIS FILE EXISTS SEPARATELY FROM jupiter-route.test.ts. That file pins
// what the builder REFUSES before anything is signed. This one pins the thing
// the refusals cannot see: whether Jupiter's outAmount is before or after the
// Token-2022 transfer fee, which is a fact about mainnet, not about our code.
// It was measured — scripts/jupiter-sim.ts, mainnet simulations on 2026-09-20,
// epoch 1038 — and every row below is a row that run actually produced, gross
// and net and withheld, copied whole. A change to classify() or safeMinOut()
// that stops agreeing with them is a change that stops agreeing with mainnet.
//
// THE ANSWER IS NOT ONE ANSWER, and that is the point of the table: ANTHROPIC
// filling through Manifest quotes GROSS, FIGUREAI filling through Raydium CLMM
// quotes NET, on the same day with byte-identical transfer-fee configs. The
// basis follows the AMM that makes the final transfer, and Jupiter re-picks
// that per quote — so any rule that reads the basis off the leg is a rule that
// breaks when the route moves, which is why the only rule here is the one that
// survives both.
//
// This file lives in the keeper's suite because packages/solana-program has no
// vitest — its `test` script is `anchor test` — and a new file here merges
// cleanly and runs in a gate that already exists.

import { describe, expect, it } from "vitest";
import { classify, safeMinOut, type LegMeasurement } from "@sip/solana-program/jupiter-sim";
import { netOfTransferFee, transferFeeOn, type TransferFeeRate } from "@sip/solana-program/jupiter-route";

/** The two rates the PreStocks mints actually carry, read from their config. */
const FEE_50: TransferFeeRate = { epoch: 1032n, basisPoints: 50, maximumFee: 18_446_744_073_709_551_615n };
const FEE_100: TransferFeeRate = { epoch: 1039n, basisPoints: 100, maximumFee: 18_446_744_073_709_551_615n };
const NO_FEE: TransferFeeRate = { epoch: 0n, basisPoints: 0, maximumFee: 0n };

/** Everything classify() does not read, filled once so the rows stay readable. */
const row = (fields: {
  leg: string;
  usd: number;
  lastHop: string;
  quotedOut: bigint;
  venueThreshold: bigint;
  credit: bigint;
  withheld: bigint;
  fee: TransferFeeRate;
}): LegMeasurement => ({
  leg: fields.leg,
  mint: "measured-on-mainnet",
  usd: fields.usd,
  amountIn: BigInt(fields.usd) * 1_000_000n,
  hops: 2,
  labels: [fields.lastHop],
  lastHop: fields.lastHop,
  quotedOut: fields.quotedOut,
  venueThreshold: fields.venueThreshold,
  credit: fields.credit,
  withheld: fields.withheld,
  grossDelivered: fields.credit + fields.withheld,
  spent: BigInt(fields.usd) * 1_000_000n,
  feeCurrent: fields.fee,
  feeWorstCase: fields.fee.basisPoints === 0 ? NO_FEE : FEE_100,
  computeUnits: null,
  txBytes: 0,
});

describe("the basis Jupiter quotes in, measured", () => {
  it("calls a Manifest fill GROSS: the vault is credited a whole fee below outAmount", () => {
    // mainnet 2026-09-20, ANTHROPIC 5 USD, 3 hops ending on Manifest.
    const measured = row({
      leg: "ANTHROPIC",
      usd: 5,
      lastHop: "Manifest",
      quotedOut: 4_791_352n,
      venueThreshold: 4_743_439n,
      credit: 4_767_395n,
      withheld: 23_957n,
      fee: FEE_50,
    });
    const verdict = classify(measured);
    expect(verdict.basis).toBe("gross");
    // The decomposition is exact: what the venue delivered IS the quote.
    expect(measured.grossDelivered).toBe(measured.quotedOut);
    expect(verdict.grossDriftBps).toBeCloseTo(0, 3);
    expect(verdict.creditDriftBps).toBeCloseTo(-50.001, 2);
    // And the fee is the mint's own arithmetic, rounded UP, on the gross.
    expect(transferFeeOn(measured.grossDelivered, FEE_50)).toBe(measured.withheld);
  });

  it("calls a Raydium CLMM fill NET: the vault is credited outAmount exactly", () => {
    // mainnet 2026-09-20, FIGUREAI 250 USD, 1 hop, Raydium CLMM.
    const measured = row({
      leg: "FIGUREAI",
      usd: 250,
      lastHop: "Raydium CLMM",
      quotedOut: 1_376_918_399n,
      venueThreshold: 1_363_149_216n,
      credit: 1_376_918_399n,
      withheld: 6_919_188n,
      fee: FEE_50,
    });
    const verdict = classify(measured);
    expect(verdict.basis).toBe("net");
    expect(measured.credit).toBe(measured.quotedOut);
    expect(verdict.creditDriftBps).toBe(0);
    // The venue sent a fee MORE than it quoted, so the quote had it subtracted.
    expect(verdict.grossDriftBps).toBeCloseTo(50.251, 2);
  });

  it("gives the SAME MINT opposite answers when only the venue changes", () => {
    // THE EXPERIMENT THAT SETTLES IT. ANTHROPIC, 25 USD, the same afternoon,
    // the same transfer-fee config, the same builder and flags — the only
    // difference is which AMM makes the final transfer, forced by excluding
    // Manifest from the route. Through Manifest the vault is credited a whole
    // fee below outAmount; through Meteora DLMM it is credited outAmount to
    // the raw unit. So the basis is NOT a property of the mint, and cannot be
    // configured per leg: Jupiter picks the venue per quote.
    const viaManifest = row({
      leg: "ANTHROPIC",
      usd: 25,
      lastHop: "Manifest",
      quotedOut: 23_942_364n,
      venueThreshold: 23_702_941n,
      credit: 23_779_749n,
      withheld: 119_497n,
      fee: FEE_50,
    });
    const viaMeteora = row({
      leg: "ANTHROPIC",
      usd: 25,
      lastHop: "Meteora DLMM",
      quotedOut: 23_816_857n,
      venueThreshold: 23_578_689n,
      credit: 23_816_857n,
      withheld: 119_683n,
      fee: FEE_50,
    });
    expect(classify(viaManifest).basis).toBe("gross");
    expect(classify(viaMeteora).basis).toBe("net");
    expect(classify(viaMeteora).creditDriftBps).toBe(0);
    // And the one rule that does not have to know which of the two it got.
    for (const measured of [viaManifest, viaMeteora]) {
      const worstCredit = netOfTransferFee(measured.venueThreshold, FEE_100);
      expect(worstCredit).toBeGreaterThanOrEqual(safeMinOut(measured.venueThreshold, FEE_100));
      expect(measured.venueThreshold).toBeGreaterThanOrEqual(safeMinOut(measured.venueThreshold, FEE_100));
    }
  });

  it("calls a fee-free mint neither, however the fill lands", () => {
    // SPYx carries no TransferFeeConfig; gross and net are the same number, so
    // a verdict either way would be an artefact of the control, not a finding.
    const measured = row({
      leg: "SPYx",
      usd: 250,
      lastHop: "Riptide",
      quotedOut: 32_518_312n,
      venueThreshold: 32_193_129n,
      credit: 32_518_312n,
      withheld: 0n,
      fee: NO_FEE,
    });
    expect(classify(measured).basis).toBe("no-fee");
  });

  it("does not confuse the two bases with price drift: they are a whole fee apart", () => {
    // The noisiest measured row — FIGUREAI 25 USD, credit 19.4 bps under the
    // quote — is still 30 bps from the gross hypothesis. Drift moves a fill by
    // basis points; the fee moves it by fifty.
    const noisy = row({
      leg: "FIGUREAI",
      usd: 25,
      lastHop: "Raydium CLMM",
      quotedOut: 137_810_018n,
      venueThreshold: 136_431_918n,
      credit: 137_542_637n,
      withheld: 691_170n,
      fee: FEE_50,
    });
    const verdict = classify(noisy);
    expect(verdict.basis).toBe("net");
    expect(Math.abs(verdict.creditDriftBps)).toBeLessThan(Math.abs(verdict.grossDriftBps));
    expect(Math.abs(verdict.grossDriftBps - verdict.creditDriftBps)).toBeCloseTo(50.1, 0);
  });
});

describe("the min_out a fill cannot reject", () => {
  // The venue's own worst allowed fill is `threshold` GROSS, because Jupiter
  // reverts below it inside the CPI. Under the gross basis the vault then sees
  // threshold - fee(threshold); under the net basis it sees threshold. min_out
  // has to clear the smaller of the two, whichever basis today's route uses.
  const worstCreditIfGross = (threshold: bigint, fee: TransferFeeRate): bigint => netOfTransferFee(threshold, fee);

  it("is the threshold net of the fee, and that survives both bases", () => {
    const threshold = 236_646_472n; // ANTHROPIC 250 USD, measured.
    const minOut = safeMinOut(threshold, FEE_100);
    expect(minOut).toBe(234_280_007n);
    expect(worstCreditIfGross(threshold, FEE_100)).toBeGreaterThanOrEqual(minOut);
    expect(threshold).toBeGreaterThanOrEqual(minOut);
  });

  it("REVERTS if min_out is taken from the gross threshold — the whole reason for this task", () => {
    const threshold = 236_646_472n;
    // What the vault would actually measure on the venue's worst allowed fill.
    const measured = worstCreditIfGross(threshold, FEE_100);
    expect(measured).toBeLessThan(threshold);
    // invest() requires received >= min_out; this is FillTooSmall.
    expect(measured >= threshold).toBe(false);
    expect(threshold - measured).toBe(2_366_465n);
    // And the rule this file exists to defend does NOT reject that same fill.
    expect(measured).toBeGreaterThanOrEqual(safeMinOut(threshold, FEE_100));
  });

  it("is one raw unit below the threshold even at ZERO slippage, once the rates match", () => {
    // Jupiter FLOORS its slippage deduction and Token-2022 CEILS its fee. At
    // epoch 1039 both are 100 bps, so the net of the threshold lands a single
    // raw unit under it — min_out = threshold does not merely run out of
    // margin, it reverts on a perfect fill.
    const quotedOut = 1_376_918_399n;
    const threshold = quotedOut - (quotedOut * 100n) / 10_000n;
    expect(threshold).toBe(1_363_149_216n);
    expect(netOfTransferFee(quotedOut, FEE_100)).toBe(threshold - 1n);
  });

  it("reads the rate from the epoch the transaction LANDS in, not the one it was built in", () => {
    // Measured at epoch 1038, where the mints still charged 50 bps while 100
    // was already scheduled for 1039 — about an hour away when this was run.
    // A min_out sized at 50 bps and landing at 100 is short by a whole fee.
    const threshold = 1_362_115_246n; // FIGUREAI 250 USD, measured.
    // Both rounded UP, the way Token-2022's calculate_fee does it: 50 bps of
    // 1,362,115,246 is 6,810,576.23, withheld as 6,810,577.
    expect(safeMinOut(threshold, FEE_50)).toBe(1_355_304_669n);
    expect(safeMinOut(threshold, FEE_100)).toBe(1_348_494_093n);
    expect(safeMinOut(threshold, FEE_50)).toBeGreaterThan(safeMinOut(threshold, FEE_100));
  });
});

describe("epoch 1039, where the fee doubled and the slippage ran out", () => {
  // Measured across the boundary itself on 2026-09-20: the mints step from 50
  // to 100 bps at epoch 1039, and the harness was re-run the minute it landed.
  // The step does not merely shrink the margin — on a venue that quotes GROSS
  // it removes the ability to fill at all, because Jupiter checks its own
  // threshold against the CREDITED (net) amount while quoting gross.

  it("still credits outAmount exactly on a NET venue, now a doubled fee wide", () => {
    // FIGUREAI 5 USD, epoch 1039, 2 hops ending on Raydium CLMM.
    const measured = row({
      leg: "FIGUREAI",
      usd: 5,
      lastHop: "Raydium CLMM",
      quotedOut: 27_610_549n,
      venueThreshold: 27_334_444n,
      credit: 27_610_549n,
      withheld: 278_895n,
      fee: FEE_100,
    });
    const verdict = classify(measured);
    expect(verdict.basis).toBe("net");
    expect(verdict.creditDriftBps).toBe(0);
    // 100 bps withheld from the gross is 101.01 bps ON TOP of the net quote.
    expect(verdict.grossDriftBps).toBeCloseTo(101.01, 2);
    expect(transferFeeOn(measured.grossDelivered, FEE_100)).toBe(measured.withheld);
  });

  it("fills on a GROSS venue only once slippage is raised above the fee", () => {
    // ANTHROPIC 25 USD, epoch 1039, GoonFi V2 > Manifest, slippage 200 bps.
    // At 100 bps slippage the same leg reverted with Jupiter's own 0x1771
    // (6001) at 5, 25 and 250 USD; at 200 bps it fills.
    const measured = row({
      leg: "ANTHROPIC",
      usd: 25,
      lastHop: "Manifest",
      quotedOut: 23_900_857n,
      venueThreshold: 23_422_840n, // out - floor(out * 200 / 1e4)
      credit: 23_661_848n,
      withheld: 239_009n,
      fee: FEE_100,
    });
    const verdict = classify(measured);
    expect(verdict.basis).toBe("gross");
    expect(verdict.creditDriftBps).toBeCloseTo(-100, 3);
    expect(measured.grossDelivered).toBe(measured.quotedOut);
    // 200 bps of tolerance minus a 100 bps fee leaves the fill above Jupiter's
    // own threshold, which is why this one lands and the 100 bps one did not.
    expect(measured.credit).toBeGreaterThan(measured.venueThreshold);
  });

  it("explains the revert: at slippage == fee the net is a raw unit UNDER the threshold", () => {
    // Jupiter's threshold floors; Token-2022's fee ceils. Equal rates are
    // therefore not a tie — the net loses by one, and Jupiter reverts before
    // invest() is ever reached. Shown on the measured quote of that leg.
    const quotedOut = 23_900_857n;
    const thresholdAt100 = quotedOut - (quotedOut * 100n) / 10_000n;
    const netAt100 = netOfTransferFee(quotedOut, FEE_100);
    expect(netAt100).toBe(thresholdAt100 - 1n);
    expect(netAt100 < thresholdAt100).toBe(true);
    // And at 200 bps the same quote clears its threshold with room to spare.
    const thresholdAt200 = quotedOut - (quotedOut * 200n) / 10_000n;
    expect(netAt100).toBeGreaterThan(thresholdAt200);
    expect(netAt100 - thresholdAt200).toBe(239_008n);
  });
});
