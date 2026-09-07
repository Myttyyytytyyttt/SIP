// What the vault should be willing to accept, quoted from the pool it is about
// to trade in.
//
// WHY THIS MODULE EXISTS. The adapter used to price purchases against Chainlink
// and refuse anything more than a fixed band away from that. It no longer does:
// the oracle and the trading-hours gate were removed because they were stopping
// purchases at prices nobody disputed — measured on a Saturday, the pool quoted
// $224.83 for NVDA against a 22-hour-old feed at $225.31, and the vault was
// refusing to trade. What replaced the oracle is `minAmountOut`, and this module
// is where that number comes from.
//
// WHAT IT REPLACED, AND WHY THAT WAS NOT ENOUGH. `PersonalVault.invest` takes the
// HIGHER of two floors: the admin's `minOutRateWad`, frozen into the basket hash,
// and the keeper's per-call figure. Until now the keeper supplied nothing, so the
// frozen rate was the only floor — and a frozen rate cannot work, because it is
// denominated in stock-per-WETH and therefore moves with BOTH prices. From live
// mainnet numbers (1 WETH = 1880.71 USDG, 1 NVDA = 224.72 USDG, fair rate 8.3691):
//
//     set with  5% slack -> reverts FOREVER once ETH/NVDA falls 5%
//     ETH/NVDA rises 25% -> the floor sits 24% below fair and constrains nothing
//
// Both are ordinary multi-week moves. A frozen rate either strangles the vault
// silently or is decoration; there is no value that is both tight and durable.
// So the real floor has to be quoted fresh, which is what this does.
//
// WHAT THIS DOES NOT DO, stated plainly because it is easy to assume otherwise: a
// floor derived from the pool you are about to trade in CANNOT tell you that pool
// is mispriced. It defends against movement between the read and the fill, and
// against a mis-sized trade eating its own depth. It does NOT defend against the
// pinned pool itself being wrong or manipulated — that is what pinning
// `fee`/`tickSpacing` per stock in the adapter is for, and mainnet has hookless
// USDG/NVDA pools charging 85%, 90% and 99.9% with real liquidity to prove the
// pinning matters.

/** One Uniswap v4 pool, as much of it as an exact-in quote needs. */
export interface PoolState {
  /** From `slot0`, the low 160 bits. */
  readonly sqrtPriceX96: bigint;
  /** Active liquidity at the current tick. */
  readonly liquidity: bigint;
  /**
   * The EFFECTIVE swap fee in hundredths of a bip — lpFee composed with the
   * pool's protocol fee, as `decodeSwapFeePips` reads it out of slot0.
   *
   * NOT the fee from the PoolKey. That is the lpFee alone, and using it
   * understated these pools by 6.23 bps: 625 rather than 500, 3499 rather
   * than 3000.
   */
  readonly feePips: number;
  /**
   * True when the token being spent is the pool's `currency0`.
   *
   * NOT inferable here. It follows from address sort order, which the caller
   * knows and this module deliberately does not: passing addresses in would let
   * this file disagree with the adapter's pinned `PoolKey` about which pool is
   * even being described.
   */
  readonly zeroForOne: boolean;
}

export const FEE_DENOMINATOR = 1_000_000n;
const Q96 = 2n ** 96n;

/**
 * Exact-in output, assuming the swap stays inside the current tick.
 *
 * THE ASSUMPTION IS LOAD-BEARING AND IS THE REASON `toleranceBps` EXISTS.
 * Concentrated liquidity means `liquidity` is only valid until the next
 * initialised tick; a swap that crosses one moves into a range with different
 * depth, and this estimate is then wrong in a direction that depends on which way
 * depth changes. For the sizes this vault trades it cannot happen — measured
 * against the live pools, a $94 purchase moves the price 0.4 bps beyond the 35
 * bps of fees — but "cannot happen at today's size" is not "cannot happen", so
 * the tolerance has to cover it rather than the comment.
 *
 * Returns the gross output before the caller's tolerance.
 */
export function quoteExactInSingle(pool: PoolState, amountIn: bigint): bigint {
  if (amountIn <= 0n) return 0n;
  if (pool.liquidity <= 0n || pool.sqrtPriceX96 <= 0n) return 0n;

  // The fee is taken off the INPUT before it touches the curve, which is what v4
  // does. Taking it off the output instead overstates the quote by roughly the
  // fee, and on a two-hop route that error compounds.
  const feeBig = BigInt(pool.feePips);
  const amountInNet = amountIn - (amountIn * feeBig) / FEE_DENOMINATOR;
  if (amountInNet <= 0n) return 0n;

  const { sqrtPriceX96: sqrtP, liquidity: L } = pool;

  if (pool.zeroForOne) {
    // Spending token0. sqrtP falls.
    //   sqrtNext = L * sqrtP / (L + amountIn * sqrtP / Q96)
    // written with the Q96 factored out so the numerator cannot overflow before
    // the division does its work.
    const denominator = L * Q96 + amountInNet * sqrtP;
    if (denominator === 0n) return 0n;
    // ROUNDED UP, which is what v4 does and which rounds the OUTPUT down.
    //
    // MEASURED, against a real purchase on a mainnet fork: with the effective
    // swap fee read from slot0 and this rounding, the quote lands +0.013 bps
    // from the fill — 4.4 million wei out of 3.39e15. Before the fee fix it was
    // +6.27 bps. The residual is the fee's own integer truncation rounding in
    // the caller's favour, and at 0.013 bps the 50 bps tolerance covers it about
    // 3,800 times over; chasing it would cost more than it is worth.
    //
    // The SIGN is what matters and it is the wrong one: the quote is optimistic,
    // so the error eats tolerance rather than creating it. That is why the
    // tolerance is not tuned down towards zero.
    const numerator = L * Q96 * sqrtP;
    const sqrtNext = (numerator + denominator - 1n) / denominator;
    if (sqrtNext >= sqrtP) return 0n;
    // amount1 out = L * (sqrtP - sqrtNext) / Q96
    return (L * (sqrtP - sqrtNext)) / Q96;
  }

  // Spending token1. sqrtP rises.
  //   sqrtNext = sqrtP + amountIn * Q96 / L
  const sqrtNext = sqrtP + (amountInNet * Q96) / L;
  if (sqrtNext <= sqrtP) return 0n;
  // amount0 out = L * Q96 * (sqrtNext - sqrtP) / (sqrtNext * sqrtP)
  const numerator = L * Q96 * (sqrtNext - sqrtP);
  const denominator = sqrtNext * sqrtP;
  if (denominator === 0n) return 0n;
  return numerator / denominator;
}

/**
 * The full WETH -> USDG -> stock route, which is the only route the adapter has.
 *
 * Quoted as two sequential exact-in swaps because that is literally what happens
 * inside the adapter's single `unlock`: hop one's output is hop two's input, and
 * the intermediate USDG never becomes a balance.
 */
export function quoteTwoHop(first: PoolState, second: PoolState, amountIn: bigint): bigint {
  const intermediate = quoteExactInSingle(first, amountIn);
  if (intermediate <= 0n) return 0n;
  return quoteExactInSingle(second, intermediate);
}

/**
 * The floor to hand to `invest()`, from a fresh quote.
 *
 * ON THE TOLERANCE. It covers three things and nothing else: another trade
 * landing between the keeper's read and its transaction, a tick crossing that
 * makes the single-tick estimate optimistic, and rounding. It is NOT a slippage
 * budget in the usual sense, because the fees are already inside `quoted` — the
 * pool's 0.05% and 0.30% come off the input on each hop before the curve is
 * touched, so a tolerance of zero would still accept a fair fill.
 *
 * Blocks on this chain are 0.099s, so the read-to-fill window is a second or two
 * of wall clock. 50 bps is deliberately generous against that: the cost of being
 * too tight is a revert and a retry, and the cost of being too loose is a worse
 * fill, but neither is a loss of principal — the admin's frozen `minOutRateWad`
 * is still applied underneath as a floor the keeper cannot lower.
 */
export function minOutFromQuote(quoted: bigint, toleranceBps: number): bigint {
  if (quoted <= 0n) return 0n;
  if (!Number.isInteger(toleranceBps) || toleranceBps < 0 || toleranceBps >= 10_000) {
    throw new RangeError(`toleranceBps must be an integer in [0, 10000), got ${toleranceBps}`);
  }
  return (quoted * BigInt(10_000 - toleranceBps)) / 10_000n;
}

/** The default, for callers with no reason to pick their own. See above. */
export const DEFAULT_TOLERANCE_BPS = 50;

/**
 * Splits a purchase across a basket and quotes each leg, mirroring the vault's
 * own arithmetic.
 *
 * THE LAST LEG ABSORBS THE ROUNDING DUST, exactly as `PersonalVault.invest` does.
 * If this rounded the other way the keeper's floors would be computed for
 * slightly different amounts than the vault actually swaps, and every purchase
 * would sit a few wei away from its own quote for no reason anyone could find.
 */
export function splitAcrossLegs(amountIn: bigint, weightsBps: readonly number[]): bigint[] {
  if (weightsBps.length === 0) return [];
  const out: bigint[] = [];
  let assigned = 0n;
  for (let i = 0; i < weightsBps.length; i += 1) {
    if (i === weightsBps.length - 1) {
      out.push(amountIn - assigned);
      break;
    }
    const legAmount = (amountIn * BigInt(weightsBps[i]!)) / 10_000n;
    assigned += legAmount;
    out.push(legAmount);
  }
  return out;
}
