/**
 * A MINT'S NAME, in one place.
 *
 * The classifier reports a mint, because that is what the transaction carries;
 * the screen shows a symbol, because that is what a person reads. Two copies of
 * this mapping is how a withdrawal row comes to say "SPYx" while the holdings
 * table calls the same mint something else.
 *
 * Pure and client-safe, and deliberately NOT a guess: a mint nothing here knows
 * comes back null, and the caller says less rather than inventing a ticker.
 */

import { OFFERED_LEGS, USDC_MINT, WSOL_MINT } from "@sip/solana-core/client";

/** wSOL and USDC are not legs, and they are the two the vault always holds an account of. */
const BASE: Readonly<Record<string, string>> = { [WSOL_MINT]: "wSOL", [USDC_MINT]: "USDC" };

/** The symbol for `mint`, or null when this app does not know it. */
export function symbolOfMint(mint: string | null | undefined): string | null {
  if (typeof mint !== "string" || mint === "") return null;
  return BASE[mint] ?? OFFERED_LEGS.find((leg) => leg.mint === mint)?.symbol ?? null;
}
