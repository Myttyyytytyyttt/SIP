// How tight the keeper's slippage bound actually is.
//
// Ported from the solana-lab keeper (keeper/src/min-out.ts), with the
// output mint's Token-2022 transfer fee taken off the observed price before the
// bound is drawn — new in SIP, where every leg is a Token-2022 mint that
// charges one.
//
// ITS OWN MODULE because it decides how much of a user's money may be lost
// to a bad fill, and that decision should be testable without dragging in a
// Raydium route fetcher, an RPC connection and an Anchor program. A pure
// function with real numbers in a test is worth more here than any amount of
// integration coverage.

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
 * This derives a bound from the price the CAPTURED SWAP really got — the same
 * transaction the route was copied from, measured by the pool vaults' own
 * balance deltas, which is consensus data rather than a quote from anywhere —
 * minus the output mint's transfer fee, and minus a tolerance for the gap
 * between then and now and for our own size.
 *
 * THE OBSERVATION IS GROSS; EVERY THRESHOLD IN THE CHAIN IS NET. live-route.ts
 * reads `observed.outRaw` off the pool's OUTPUT VAULT — its outflow, which is
 * what the source is debited, before Token-2022 withholds the fee on the way to
 * the buyer. Raydium's swap_v2 and sip-vault's invest both compare their
 * thresholds against the NET delta the destination account actually gained, so
 * a bound drawn from the gross is tightened by the fee ON TOP OF SLIPPAGE_BPS:
 * against the 50 bps these mints have charged since epoch 1032 the real
 * tolerance was 150.75 bps, not the 200 it names, and it would have been none
 * at all the day the issuer schedules 200. The fee comes off first, so the
 * bound means the slippage it names and nothing else.
 *
 * When no observation exists (an opposite-direction capture, where inverting
 * the rate would cross the spread and flatter us) it falls back to the floor
 * and SAYS SO in the outcome, rather than claiming a protection it does not
 * have. Tightening is the only direction allowed: the result is never below
 * what the owner signed.
 */
export function tightenMinOut(
  amountIn: bigint,
  floor: bigint,
  observed: { readonly inRaw: bigint; readonly outRaw: bigint } | null,
  /** The OUTPUT mint's epoch-active fee. NO_TRANSFER_FEE for a mint that charges none. */
  outFee: TransferFeeTerms,
): { minOut: bigint; live: boolean } {
  // A FEE THAT EATS THE WHOLE TOLERANCE IS REFUSED, NOT PRICED. Subtracting it
  // correctly keeps the arithmetic honest but cannot make such a leg safe: at
  // SLIPPAGE_BPS the fee alone costs more than every price movement this keeper
  // is willing to absorb, and the fee authority on these mints can schedule any
  // rate up to 10_000 with about two epochs' notice. invest-decision.ts refuses
  // such a leg before a lamport moves (MAX_LEG_FEE_BPS, half of this); reaching
  // here anyway means that gate was bypassed, and a loud throw is the only
  // answer that cannot be mistaken for protection.
  if (outFee.bps >= SLIPPAGE_BPS) {
    throw new Error(
      `the output mint charges a ${outFee.bps} bps transfer fee, at or above the ${SLIPPAGE_BPS} bps slippage bound — ` +
        "refusing to price a swap whose fee alone exceeds the tolerance the bound names",
    );
  }
  if (observed === null || observed.inRaw === 0n) return { minOut: floor, live: false };
  const gross = (amountIn * observed.outRaw) / observed.inRaw;
  const expected = netOfTransferFee(gross, outFee);
  const bounded = (expected * (10_000n - SLIPPAGE_BPS)) / 10_000n;
  if (bounded <= floor) return { minOut: floor, live: false };
  return { minOut: bounded, live: true };
}
