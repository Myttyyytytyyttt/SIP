// Why the USDC sitting in a vault has not become stocks yet.
//
// THE VAULT SAVES IN TWO STEPS. Settling puts SOL in; investing turns it into
// the basket. Between them the money sits as USDC, and from the outside that is
// indistinguishable from something being broken — a balance that goes in and
// then visibly does nothing.
//
// "PENDING" ALONE WOULD BE A LIE. The program requires `min_investment` on
// EVERY leg's call, not on the total, so a basket splits the budget by weight
// and each slice has to clear the bar on its own. A six-leg basket at a $5
// minimum needs $25 before its largest leg qualifies and $50 before its
// smallest does. Below that nothing is queued and nothing is coming: it is
// blocked, not pending, and a UI that says "pending" sends someone away to wait
// for an event that will never fire. So this returns the THRESHOLD as well as
// the state, and the copy above it can name a number.
//
// AND SOMETIMES IT IS IMPOSSIBLE. `max_per_call` caps the budget, so a basket
// whose lightest leg cannot clear the minimum even at the cap will never invest
// at any balance. That is a configuration error, it is invisible from the
// balance alone, and it is worth saying out loud rather than showing a
// threshold nobody can ever reach.

export interface InvestmentReadiness {
  /** USDC the vault holds, raw (6 decimals). */
  readonly heldRaw: bigint;
  readonly legs: number;
  readonly minInvestmentRaw: bigint;
  /**
   * `ready` — the next sweep can buy the whole basket.
   * `waiting` — real money is held and the balance simply is not there yet.
   * `unreachable` — the caps make this basket unbuyable at ANY balance.
   */
  readonly state: "ready" | "waiting" | "unreachable";
  /**
   * The balance that unblocks investing, raw — the point at which EVERY leg
   * clears the minimum.
   *
   * ONE THRESHOLD, NOT TWO. An earlier version also reported where the heaviest
   * leg alone would qualify, and calling that "the first buy" was wrong: the
   * keeper refuses all-or-nothing, because buying only the legs that happen to
   * clear the bar is a partial basket drifting from the signed weights. A
   * number that unblocks nothing has no business on screen.
   */
  readonly investsAtRaw: bigint;
}

/**
 * Reads the same rule the program enforces and the keeper now mirrors.
 *
 * Returns null when there is nothing to say: no policy, no legs, or a policy
 * whose numbers could not be read. An absent answer is not a "ready" answer.
 */
export function investmentReadiness(
  heldRaw: bigint,
  legs: readonly { weightBps: number }[],
  minInvestmentRaw: bigint,
  maxPerCallRaw: bigint,
): InvestmentReadiness | null {
  if (legs.length === 0 || minInvestmentRaw <= 0n || maxPerCallRaw <= 0n) return null;

  const weights = legs.map((leg) => leg.weightBps).filter((bps) => bps > 0);
  if (weights.length === 0) return null;
  const lightest = Math.min(...weights);

  // The balance at which a leg of `bps` clears the minimum. Rounded UP: the
  // exact quotient can leave the integer division inside the program one raw
  // unit short, and a threshold you can meet and still be refused is worse than
  // one that is a hundredth of a cent conservative.
  const thresholdFor = (bps: number): bigint => {
    const numerator = minInvestmentRaw * 10_000n;
    const denominator = BigInt(bps);
    return (numerator + denominator - 1n) / denominator;
  };

  // THE CAP IS THE CEILING ON EVERY BUY, so a leg that cannot clear the minimum
  // out of a full max_per_call budget can never clear it at all.
  const reachable = (maxPerCallRaw * BigInt(lightest)) / 10_000n >= minInvestmentRaw;

  const budget = heldRaw > maxPerCallRaw ? maxPerCallRaw : heldRaw;
  const ready = legs.every((leg) => (budget * BigInt(leg.weightBps)) / 10_000n >= minInvestmentRaw);

  return {
    heldRaw,
    legs: legs.length,
    minInvestmentRaw,
    state: ready ? "ready" : reachable ? "waiting" : "unreachable",
    investsAtRaw: thresholdFor(lightest),
  };
}

/** Raw USDC as dollars, for copy. Six decimals, shown to the cent. */
export const usdc = (raw: bigint): string => `$${(Number(raw) / 1e6).toFixed(2)}`;
