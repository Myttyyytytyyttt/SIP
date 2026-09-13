// How tight the keeper's slippage bound actually is.
//
// Ported from Nuvem's solana-lab keeper (keeper/src/min-out.ts), unchanged.
//
// ITS OWN MODULE because it decides how much of a user's money may be lost
// to a bad fill, and that decision should be testable without dragging in a
// Raydium route fetcher, an RPC connection and an Anchor program. A pure
// function with real numbers in a test is worth more here than any amount of
// integration coverage.

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
 * This derives a bound from the price the CAPTURED SWAP really got — the same
 * transaction the route was copied from, measured by the pool vaults' own
 * balance deltas, which is consensus data rather than a quote from anywhere —
 * minus a tolerance for the gap between then and now and for our own size.
 *
 * When no such observation exists (an opposite-direction capture, where
 * inverting the rate would cross the spread and flatter us) it falls back to
 * the floor and SAYS SO in the outcome, rather than claiming a protection it
 * does not have. Tightening is the only direction allowed: the result is never
 * below what the owner signed.
 */
const SLIPPAGE_BPS = 200n; // 2% — a CLMM pool's price moves between blocks.

export function tightenMinOut(
  amountIn: bigint,
  floor: bigint,
  observed: { readonly inRaw: bigint; readonly outRaw: bigint } | null,
): { minOut: bigint; live: boolean } {
  if (observed === null || observed.inRaw === 0n) return { minOut: floor, live: false };
  const expected = (amountIn * observed.outRaw) / observed.inRaw;
  const bounded = (expected * (10_000n - SLIPPAGE_BPS)) / 10_000n;
  if (bounded <= floor) return { minOut: floor, live: false };
  return { minOut: bounded, live: true };
}
