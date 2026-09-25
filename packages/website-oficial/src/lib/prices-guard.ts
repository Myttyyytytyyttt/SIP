/**
 * THE KEEPER'S LIVE ORACLE GUARD, RESTATED FOR A PAGE THAT EXPLAINS IT — and
 * pinned to the keeper's source so the explanation cannot drift from the code.
 *
 * The two numbers below are MAX_PYTH_AGE_SECONDS and MAX_PYTH_DEVIATION_BPS in
 * packages/solana-keeper/src/invest-decision.ts, where oracleConvertDecision
 * refuses to price the SOL hop — the conversion of a vault's saved SOL into the
 * USDC a buy is paid in — when the stalest of the two Pyth publishes sits more
 * than MAX_PYTH_AGE_SECONDS behind the CHAIN's clock, or when the route the
 * keeper captured and the oracle disagree by more than MAX_PYTH_DEVIATION_BPS of
 * the oracle's rate. invest-tick.ts calls it on the live sweep.
 *
 * WHY A COPY AND NOT AN IMPORT. This package does not depend on
 * @sip/solana-keeper and must not start to: the keeper is a Railway service with
 * its own runtime, its own Dockerfile that copies by name, and a money path this
 * public page has no business reaching into. So the constants are copied — and
 * prices-guard.test.ts reads the keeper's own file and fails if either number
 * here is not the number there. A stale sentence on a public page is the exact
 * failure this project keeps writing tests against.
 */

/** Where the numbers live, shown on the page so a reader can check them rather than believe them. */
export const KEEPER_GUARD_SOURCE = "packages/solana-keeper/src/invest-decision.ts";

export const KEEPER_ORACLE_GUARD = Object.freeze({
  source: KEEPER_GUARD_SOURCE,
  /** MAX_PYTH_AGE_SECONDS: the most seconds a publish may sit behind the chain's clock before the SOL hop is not priced at all. */
  maxAgeSeconds: 60n,
  /** MAX_PYTH_DEVIATION_BPS: how far the captured route may be from the oracle's rate, relative, either direction, before the hop is skipped. */
  maxDeviationBps: 500n,
  /** The function that applies them, for a reader who wants to go and look. */
  decision: "oracleConvertDecision",
  /** Where it runs on the live keeper. */
  calledFrom: "packages/solana-keeper/src/invest-tick.ts",
});
