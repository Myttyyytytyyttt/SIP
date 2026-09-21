// The three numbers the keeper decides with and the website promises in writing.
//
// A SHARED VECTOR, NOT A SHARED MODULE. vault-copy.test.ts used to readFileSync
// three of the keeper's source files and regex these numbers out of them: a web
// gate that went red whenever the keeper reflowed a line, in a package the web
// may not edit, with only the keeper's owner able to fix it. The obvious remedy
// — move the constants into @sip/solana-core and import them from the keeper —
// is the one remedy this repository forbids, in its own words. Of the mirrored
// Pyth decoder, packages/solana-keeper/src/pyth.ts says: "The keeper does not
// depend on @sip/solana-core and must not start to: its package.json is what
// ships to Railway, and the repo already draws this boundary — invest-tick.ts
// re-declares the wSOL/USDC pool rather than import the web's copy of it." A
// rule affirmed there and broken here would be worse than either choice alone.
//
// So this is the pattern that decoder ALREADY uses: ONE COMMITTED VECTOR,
// ASSERTED FROM BOTH SIDES. test/fixtures/pyth-accounts.ts holds two mainnet
// accounts that solana-core's pyth-price.test.ts and the keeper's own
// pyth.test.ts each decode independently, and the copies are held together by
// agreeing about the vector rather than by importing each other. Nothing here
// ships: a test fixture a sibling reads costs the deployed keeper nothing.
//
// EACH NUMBER CARRIES WHAT IT MEANS, WHICH IS THE WHOLE POINT. A vector that
// said only "100" would pass two codebases that agree on the digits and
// disagree on the unit — basis points read as percent, a multiple read as a
// share. So every entry carries FOUR things: the value in the keeper's own
// unit, the same quantity in the unit the website prints, a worked example, and
// the two cases either side of the comparison the keeper actually makes. The
// derived magnitude and the boundary are the assertion; the digits are not.
//
// WHICH SIDE GOES RED FOR WHAT:
//   * the keeper's tests hold its exported constants AND its gates to `keeper`
//     and `boundary`, so MOVING A KEEPER CONSTANT fails in the keeper;
//   * vault-copy.test.ts holds the web's constants AND the sentences the owner
//     signs to `web` and the derived magnitudes, so MOVING THE SIGNED TEXT
//     fails in the website.
// One vector, two assertions, each failing in the package that caused it.
//
// NOTHING IS IMPORTED HERE, deliberately: the keeper resolves this file through
// a runtime-built specifier so its NodeNext tsc never follows it, and the web
// imports it directly under Bundler resolution. A dependency-free module is
// legible to both.

/**
 * HOW LONG A LOSS FOLLOWS A TRADER.
 *
 * A losing stretch moves nothing and its loss comes off the next gain. The loss
 * is dropped — and later gains count in full — only once the trading wallet has
 * signed this many transactions OF ITS OWN while still behind, summed across
 * the windows the loss was carried through. The keeper's own settles are not
 * counted, which is what stops a stranger's transfers deciding when a trader is
 * forgiven.
 */
export const LOSS_FORGIVEN = Object.freeze({
  /** packages/solana-keeper/src/settle-decision.ts */
  keeper: Object.freeze({ constant: "ZERO_BASE_MIN_TXS", module: "settle-decision.ts", value: 100 }),
  /** packages/website-oficial/src/lib/vault-copy.ts, printed by VAULT_COPY.profitRule. */
  web: Object.freeze({ constant: "LOSS_DROPPED_AFTER_TXS", value: 100 }),
  /**
   * The gate is `signed >= ZERO_BASE_MIN_TXS`, so the count below still carries
   * the loss and the count above forgets it. A flip to `>` moves both.
   */
  boundary: Object.freeze({ stillCarriedAtTxs: 99, forgottenAtTxs: 100 }),
});

/**
 * HOW SMALL ONE BUY MUST BE BESIDE THE POOL IT GOES INTO.
 *
 * The pool's in-side reserve must cover the buy this many times over, measured
 * BEFORE the owner's SOL is sold toward it. One thin leg refuses the whole
 * basket and the SOL conversion with it.
 */
export const POOL_DEPTH = Object.freeze({
  /** packages/solana-keeper/src/invest-decision.ts */
  keeper: Object.freeze({ constant: "MIN_POOL_DEPTH_MULTIPLE", module: "invest-decision.ts", value: 50n }),
  /** packages/website-oficial/src/lib/vault-copy.ts, printed by INVEST_COPY.thinPool. */
  web: Object.freeze({ constant: "POOL_DEPTH_MULTIPLE", value: 50 }),
  /**
   * THE SAME QUANTITY IN THE OTHER UNIT, which is the half a bare "50" cannot
   * carry: at 50x cover, one buy is at most a fiftieth — 2 % — of what the pool
   * holds on the side being spent. A copy that printed "50 %" would agree with
   * the keeper about the digits and lie to the owner about the rule.
   */
  largestShareOfReservePercent: 2,
  /** Worked once by hand, in raw units whatever the mint's decimals: required = spend * multiple. */
  worked: Object.freeze({ spend: 1_000_000n, requiredReserve: 50_000_000n }),
  /**
   * The gate is `reserve < spend * MIN_POOL_DEPTH_MULTIPLE`, so EXACTLY 50x
   * cover is deep and one raw unit less is refused. A flip to `<=` moves both.
   */
  boundary: Object.freeze({ forSpend: 1_000_000n, deepAtReserve: 50_000_000n, refusedAtReserve: 49_999_999n }),
});

/**
 * THE MOST AN ISSUER MAY CHARGE TO MOVE A STOCK BEFORE THE KEEPER REFUSES IT.
 *
 * Charged on the way in and again on the way out, so the ceiling is paid twice.
 * One refused leg refuses the whole basket and the SOL conversion with it.
 */
export const LEG_FEE = Object.freeze({
  /** packages/solana-keeper/src/invest-decision.ts */
  keeper: Object.freeze({ constant: "MAX_LEG_FEE_BPS", module: "invest-decision.ts", value: 100n }),
  /** packages/website-oficial/src/lib/vault-copy.ts, printed by INVEST_COPY.feeCeiling. */
  web: Object.freeze({ constant: "MAX_LEG_FEE_BPS", value: 100 }),
  /** THE UNIT THE WEBSITE PRINTS: 100 bps is 1 % of every transfer. Off by a factor of ten in either direction, this disagrees. */
  percentPerTransfer: 1,
  /**
   * COMPOUNDED, NOT DOUBLED. In and out at the ceiling is 1 - 0.99^2 = 1.99 %,
   * not 2 %, because the second 1 % is taken from what the first one left. Both
   * sides derive this rather than copy it; INVEST_COPY.issuerCost prints it.
   */
  roundTripPercent: 1.99,
  /**
   * packages/solana-keeper/src/min-out.ts SLIPPAGE_BPS, here because it is what
   * makes the ceiling a decision rather than a number: at 100 bps the issuer's
   * round trip is the ENTIRE tolerance a single fill is allowed against the
   * market. Raising one without arguing the other is the mistake this records.
   */
  slippageBps: 200n,
  /**
   * The gate is `fee.bps > MAX_LEG_FEE_BPS` — STRICTLY greater — so a leg
   * sitting exactly on the limit is admitted with no margin at all. That is
   * ANTHROPIC's position today, and a flip to `>=` would refuse the basket the
   * website promises. Both cases are asserted so the flip cannot pass.
   */
  boundary: Object.freeze({ admittedAtBps: 100n, refusedAtBps: 101n }),
});

/**
 * THE DOCTRINE BOTH GATES OBEY, named here so the two sides are visibly talking
 * about one rule: a single refused leg refuses the WHOLE basket, the healthy
 * legs included, and stops the SOL conversion at any balance. There is no
 * per-leg outcome anywhere in it.
 *
 * THIS FIXTURE CANNOT PROVE IT, and says so rather than implying otherwise.
 * Each side proves its own half: the keeper against its own types (DepthDecision
 * and LegAdmission carry ONE verdict and no per-leg result, so a half-basket is
 * unrepresentable), the website against the sentences that must not offer the
 * reader a half-basket that cannot happen. What this entry buys is that the two
 * halves cite the same rule by name instead of each describing it privately.
 */
export const ALL_OR_NOTHING = Object.freeze({
  perLegOutcomes: false,
  refusesHealthyLegsToo: true,
  stopsSolConversion: true,
  keeperTypes: Object.freeze(["DepthDecision", "LegAdmission"]),
});
