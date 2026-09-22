/**
 * WHAT AN ASSET LOOKS LIKE, KEYED BY ITS MINT.
 *
 * THE MINT IS THE NAME, THE SYMBOL IS THE LABEL. A ticker is chosen by whoever
 * issued the token: two mints can carry the same one, and an issuer can change
 * theirs. Reaching for `/stocks/${symbol}.png` is fine for the seeded sample,
 * where the symbols are the dataset's own — but on a panel reading mainnet it
 * would hang somebody else's logo on somebody else's token the first time two
 * issuers agree on three letters. Every live event that names an asset carries
 * the mint (`invested`, `withdrew_token`), and so does every holding row.
 *
 * A MISSING MARK IS NOT A BROKEN ONE. Anything unmapped falls through to the
 * lettered disc AssetMark draws, which is the same disc every other icon on
 * the page sits on. That is what lets the catalogue grow — a new leg is listed
 * the day the policy names it, and its artwork can follow whenever it follows,
 * rather than the listing waiting on a PNG and a deploy.
 *
 * AND THE FILES ARE OURS. This app ships a Content-Security-Policy whose
 * img-src is checked by a test (scripts/check-csp.mts): pulling logos from a
 * token-list CDN would mean opening that directive to a third party who could
 * then see every visitor. So the art is served from public/.
 *
 * No '@/mocks' import: live must never be one hop from the seeded example
 * (src/components/live/no-mock-import.test.ts).
 */

import {
  ANDURIL_MINT,
  ANTHROPIC_MINT,
  FIGUREAI_MINT,
  KALSHI_MINT,
  NEURALINK_MINT,
  OPENAI_MINT,
  POLYMARKET_MINT,
  SPACEX_MINT,
  SPYX_MINT,
  USDC_MINT,
  WSOL_MINT,
} from "@sip/solana-core/client";

/** SOL itself has no mint; the holdings' SOL row is the vault's own lamports. */
export const NATIVE_SOL = "native:SOL";

/**
 * Every mint this app can draw, and the file it draws.
 *
 * A path here is a PROMISE that the file exists: next/image renders a broken
 * image rather than falling back, so a mint is listed only once its art is in
 * public/. The eight PreStocks legs and the three cash assets are commented
 * where they are still missing, so adding one is dropping a file and deleting
 * a comment rather than reading this file to work out what it wanted.
 */
const ART: Readonly<Record<string, string>> = Object.freeze({
  [SPYX_MINT]: "/stocks/SPYx.png",
  // Drop the file in and uncomment. Until then each draws its lettered disc.
  // [ANTHROPIC_MINT]: "/tokens/ANTHROPIC.png",
  // [FIGUREAI_MINT]: "/tokens/FIGUREAI.png",
  // [OPENAI_MINT]: "/tokens/OPENAI.png",
  // [NEURALINK_MINT]: "/tokens/NEURALINK.png",
  // [SPACEX_MINT]: "/tokens/SPACEX.png",
  // [POLYMARKET_MINT]: "/tokens/POLYMARKET.png",
  // [KALSHI_MINT]: "/tokens/KALSHI.png",
  // [ANDURIL_MINT]: "/tokens/ANDURIL.png",
  // [NATIVE_SOL]: "/tokens/SOL.png",
  // [WSOL_MINT]: "/tokens/wSOL.png",
  // [USDC_MINT]: "/tokens/USDC.png",
});

/** The mints a mark is still wanted for, so a test can name them rather than a person remembering. */
export const MINTS_WITHOUT_ART: readonly string[] = Object.freeze(
  [NATIVE_SOL, WSOL_MINT, USDC_MINT, ANTHROPIC_MINT, FIGUREAI_MINT, OPENAI_MINT, NEURALINK_MINT, SPACEX_MINT, POLYMARKET_MINT, KALSHI_MINT, ANDURIL_MINT].filter(
    (mint) => ART[mint] === undefined,
  ),
);

/** This mint's mark, or null when there is none and the lettered disc is right. */
export const artForMint = (mint: string | null | undefined): string | null => (typeof mint === "string" ? (ART[mint] ?? null) : null);
