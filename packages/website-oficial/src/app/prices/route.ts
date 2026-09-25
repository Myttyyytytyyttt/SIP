/**
 * GET /prices — the same reading the page shows, as raw JSON.
 *
 * WHY THIS IS THE DEFAULT AND THE PAGE IS AT /prices/view. What SaverFi knows
 * about a price is a machine-readable fact — a number, its age, the account it
 * came from, and the reason it could not be read — and a judge, a script or an
 * agent should be able to take it without parsing markup. The page renders the
 * same model for a human; neither is derived from the other, both call
 * loadPrices().
 *
 * EVERY FIGURE CARRIES ITS PROVENANCE, because that is the point rather than a
 * flourish: a bare number here would be indistinguishable from a stale one. A
 * reading that failed serializes with its reason and takes nothing else down.
 *
 * BIGINTS LEAVE AS DECIMAL STRINGS. Raw token amounts and 1e18-scaled rates do
 * not survive a double — 31,000 USDC is 31_000_000_000 raw and a WAD is far
 * past 2^53 — so they are strings, the same convention the vault routes use
 * (packages/solana-core/src/server/build-handler.ts). Never JSON.parse these
 * into numbers; keep them as strings or read them as BigInt.
 *
 * NOT CACHED, EVER. force-dynamic and no-store: a cached price is a lie with a
 * timestamp on it, and this answer exists to be trusted about the moment it
 * names. Ages are measured against the CHAIN's Clock sysvar, never this
 * server's wall clock, which appears only as `builtAt` and governs nothing.
 */
import { loadPrices } from "@/lib/prices-data";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Raw token amounts and WADs are past a double's exact range; they leave as decimal strings. */
const bigintSafe = (_key: string, value: unknown): unknown => (typeof value === "bigint" ? value.toString() : value);

export async function GET(): Promise<Response> {
  const model = await loadPrices();
  const body = JSON.stringify({ ...model, human: "/prices/view" }, bigintSafe, 2);
  return new Response(`${body}\n`, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
