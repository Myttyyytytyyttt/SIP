import "server-only";

/**
 * TODAY'S SOL PRICE for the dashboard's "≈ $" lines: USDC raw per 1 SOL, from
 * the pinned pools, in ONE chain read, shared by every visitor for a minute.
 *
 * NOT loadPrices(). That one is /prices' whole page: two chain reads and two
 * third-party requests per call, uncached. A public page that every visitor
 * loads cannot put that on each view. This is the same figure the pension page
 * prints (usdcRawPerSol of the pools' convert rate), read once and cached.
 *
 * A FAILURE IS THROWN, NEVER CACHED. unstable_cache stores what the function
 * returns; a thrown error is not stored, so the next visitor tries again
 * rather than inheriting "no price" for a minute. And it returns a decimal
 * string: the cache serialises its value as JSON, which a bigint cannot be.
 *
 * Imported only by src/app/dashboard/page.tsx: no test loads Next's cache.
 */

import { unstable_cache } from "next/cache";

import { usdcRawPerSol } from "@sip/solana-core/client";
import { createRpcPool, readPoolPrices } from "@sip/solana-core/server";

import { PriceUnconfigured } from "@/lib/global-stats-load";
import { solanaGate } from "@/lib/load-config";

/** A price the page waits for at most this long: the SOL figures are drawn either way. */
const TIMEOUT_MS = 3_000;

async function readSolPrice(): Promise<string> {
  const gate = solanaGate();
  if (gate.kind !== "ok") throw new PriceUnconfigured("this deployment's Solana settings are incomplete");
  const pool = createRpcPool(gate.settings.rpcEndpoints, { redactor: gate.settings.redactor, timeoutMs: TIMEOUT_MS });
  const prices = await readPoolPrices(pool);
  if (prices.kind !== "exists") throw new Error("the pinned pools could not be read");
  return usdcRawPerSol(prices.value.convertWad).toString();
}

export const readSolPriceCached: () => Promise<string> = unstable_cache(readSolPrice, ["dashboard-sol-usdc"], { revalidate: 60 });
