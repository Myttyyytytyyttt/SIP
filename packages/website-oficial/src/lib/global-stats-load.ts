import "server-only";

/**
 * The live dashboard's one load: the keeper's answer and today's SOL price,
 * side by side, then the model. NEVER THROWS: each source that fails becomes
 * the reason beside the figures it would have filled, and the price can never
 * hold the SOL figures back.
 *
 * THE PRICE READER IS PASSED IN. The real one lives in global-stats-price.ts,
 * behind Next's shared cache, and only the page imports it — so this file, and
 * every test of it, runs without Next's server runtime.
 */

import { buildGlobalStats, known, unavailable, type GlobalStatsModel, type Raw, type Shelf, type Stat } from "@/lib/global-stats-model";
import { fetchLeaderboardBody, type Env } from "@/lib/leaderboard";

/** Thrown by a price reader when this deployment has no chain settings: said apart from a read that failed. */
export class PriceUnconfigured extends Error {
  override readonly name = "PriceUnconfigured";
}

export interface GlobalStatsLoadOptions {
  readonly shelf: Shelf;
  /** USDC raw per 1 SOL, as decimal digits. Rejects when the price cannot be read. */
  readonly readPrice: () => Promise<string>;
  readonly env?: Env;
  readonly fetchImpl?: typeof fetch;
}

async function priceOf(readPrice: () => Promise<string>): Promise<Stat<Raw>> {
  try {
    const value = await readPrice();
    return /^[0-9]{1,39}$/.test(value) && value !== "0" ? known(value) : unavailable("price-unread");
  } catch (error) {
    return unavailable(error instanceof PriceUnconfigured ? "price-unconfigured" : "price-unread");
  }
}

export async function loadGlobalStats(options: GlobalStatsLoadOptions): Promise<GlobalStatsModel> {
  const [feed, price] = await Promise.all([fetchLeaderboardBody(options.env, options.fetchImpl), priceOf(options.readPrice)]);
  if (!feed.ok) {
    // For whoever runs the deployment: the code and the HTTP-level detail,
    // cut short — an upstream body can say anything, and a log line is not
    // the place to repeat it whole.
    console.warn(`[dashboard] the settlement figures could not be read (${feed.failure}): ${feed.detail.slice(0, 160)}`);
  }
  return buildGlobalStats({ source: "live", feed, price, shelf: options.shelf });
}
