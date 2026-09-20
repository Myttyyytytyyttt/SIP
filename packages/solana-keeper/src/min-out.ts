// How tight the keeper's slippage bound actually is.
//
// Ported from the solana-lab keeper (keeper/src/min-out.ts).
//
// ITS OWN MODULE because it decides how much of a user's money may be lost
// to a bad fill, and that decision should be testable without dragging in a
// Raydium route fetcher, an RPC connection and an Anchor program. A pure
// function with real numbers in a test is worth more here than any amount of
// integration coverage.
//
// ═══ THE OBSERVED RATE ARRIVES NET. NOTHING HERE MAY NET IT AGAIN. ═══
//
// This is the one fact this module cannot re-derive and cannot check for
// itself, so it is stated at the top rather than left beside the arithmetic.
//
// `observed` comes from live-route.ts's `observedRate`, which since the
// 2026-09-20 pool-state rewrite composes THREE factors into `outRaw`:
//
//     net = (1e6    - tradeFeeRate)   the pool's own trade fee, off the input
//         × (10_000 - inputFeeBps)    the INPUT mint's Token-2022 transfer fee
//         × (10_000 - outputFeeBps)   the OUTPUT mint's Token-2022 transfer fee
//
// so `amountIn * outRaw / inRaw` is already what the destination ATA is
// CREDITED — which is exactly the quantity Raydium's swap_v2 and sip-vault's
// invest compare their thresholds against. There is nothing left to subtract.
//
// IT USED TO BE GROSS, AND THAT IS THE TRAP. Until that rewrite the rate was
// measured by walking real swaps and reading the pool OUTPUT VAULT's outflow,
// which is what the vault is DEBITED — before Token-2022 withholds the fee on
// the way to the buyer. This module therefore took the output mint's fee off
// before applying SLIPPAGE_BPS, and was right to. Doing it now subtracts the
// same fee a SECOND time, and the damage runs in the safe-looking direction:
// a smaller `expected` yields a LOWER min_out, so the keeper demands less and
// ACCEPTS A FILL WORSE THAN THE BOUND CLAIMS TO GUARANTEE. Nothing reverts,
// nothing errors, no test goes red — the bound quietly stops meaning what it
// says. Against the 50 bps both PreStocks mints have charged since epoch 1032
// the real tolerance becomes 249 bps rather than the 200 it names
// (0.995 × 0.98 = 0.97510, i.e. 2.49 % below the credited amount); against the
// 100 bps scheduled for epoch 1039 it becomes 298 bps, half again as loose as
// the constant below. A weakening of a protection, not a revert, which is
// precisely why no test caught it.
//
// SO `tightenMinOut` TAKES NO FEE ARGUMENT. That is the fix, and the shape is
// the point: a parameter the arithmetic must never use is an invitation to use
// it. test/min-out.test.ts pins the tolerance at exactly SLIPPAGE_BPS against
// the rate it is handed, and that assertion is what goes red if the second
// subtraction ever comes back.

/** 2% — a CLMM pool's price moves between blocks. */
export const SLIPPAGE_BPS = 200n;

/**
 * One mint's transfer fee as Token-2022 charges it on ONE transfer: the rate
 * and the cap, both already resolved to the epoch the transfer lands in.
 *
 * `maximumFee` is u64::MAX on both PreStocks mints today — uncapped, so the
 * rate is the whole story there — but it is carried rather than assumed,
 * because the same authority that writes the rate writes the cap.
 */
export interface TransferFeeTerms {
  /** transfer_fee_basis_points, 0..=10_000. */
  readonly bps: bigint;
  /** maximum_fee, in the mint's raw units. */
  readonly maximumFee: bigint;
}

/** A mint that charges nothing on a transfer: every classic SPL Token mint, USDC and wSOL included. */
export const NO_TRANSFER_FEE: TransferFeeTerms = Object.freeze({ bps: 0n, maximumFee: 0n });

/**
 * What a transfer of `gross` raw units actually credits its destination, as
 * Token-2022's calculate_fee computes it: the fee ROUNDS UP — a transfer too
 * small to owe a whole unit still owes one — and is then capped at
 * maximum_fee. The remainder is what arrives.
 *
 * NO LONGER PART OF THE min_out ARITHMETIC, and deliberately still here. The
 * bound below is drawn around a rate that already has every transfer fee in
 * it (see the header), so `tightenMinOut` does not call this and must not.
 * What it is for is REASONING ABOUT a fee rather than applying one:
 * invest-decision.ts's MAX_LEG_FEE_BPS is argued as a round trip — the fee is
 * paid buying a leg and again selling it — and test/invest-decision.test.ts
 * proves that argument by running this function twice over the ceiling.
 */
export function netOfTransferFee(gross: bigint, fee: TransferFeeTerms): bigint {
  if (fee.bps === 0n || gross <= 0n) return gross;
  const rounded = (gross * fee.bps + 9_999n) / 10_000n;
  return gross - (rounded < fee.maximumFee ? rounded : fee.maximumFee);
}

/**
 * The min_out the keeper actually demands.
 *
 * THE POLICY FLOOR IS NOT SLIPPAGE PROTECTION. The floors the web writes are
 * deliberately loose — the comment beside them says "~460x below the market
 * rate" — and they are justified there by the claim that "real per-trade
 * protection is the keeper's tighter per-call min_out". The keeper was not
 * tightening anything: it passed the floor through verbatim, so a fill 99.8%
 * below market satisfied every layer, including the on-chain check that only
 * requires min_out >= floor.
 *
 * This derives a bound from the pool's own current price as live-route.ts
 * reads it, already net of the pool's trade fee and of both mints' Token-2022
 * transfer fees, minus a tolerance for the gap between the read and the fill
 * and for our own size. THE ONLY THING SUBTRACTED HERE IS SLIPPAGE_BPS; the
 * netting happens in live-route.ts's `observedRate` and the header explains
 * at length why repeating it here silently loosens the bound.
 *
 * WHAT `live` MEANS, because a caller's log depends on it. It is false in two
 * quite different situations, and neither is "the route failed" — a route that
 * cannot be built throws in live-route.ts and never reaches this function:
 *
 *   1. there is no usable observation (`null`, or a zero denominator). The
 *      current fetchLiveRoute cannot produce either, but the parameter is
 *      typed nullable and the arithmetic is guarded rather than trusting that.
 *   2. the derived bound came out AT OR BELOW the floor the owner signed, so
 *      the floor is the tighter of the two and the floor is what is sent.
 *
 * The second is ordinary and is the one that actually happens. Tightening is
 * the only direction allowed: the result is never below what the owner signed.
 */
export function tightenMinOut(
  amountIn: bigint,
  floor: bigint,
  /** The reference rate, ALREADY NET of every transfer fee — see the header. */
  observed: { readonly inRaw: bigint; readonly outRaw: bigint } | null,
): { minOut: bigint; live: boolean } {
  if (observed === null || observed.inRaw === 0n) return { minOut: floor, live: false };
  // What the vault's own token account is credited at this rate. NOT gross:
  // the transfer fees are already inside outRaw.
  const expected = (amountIn * observed.outRaw) / observed.inRaw;
  const bounded = (expected * (10_000n - SLIPPAGE_BPS)) / 10_000n;
  if (bounded <= floor) return { minOut: floor, live: false };
  return { minOut: bounded, live: true };
}
