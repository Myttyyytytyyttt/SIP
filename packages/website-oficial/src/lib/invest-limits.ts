/**
 * TODAY'S PRICES, WHAT A POLICY HAS ALREADY SPENT, AND WHETHER A POLICY SIGNED
 * BEFORE 2026-10-08 STILL CARRIES STOCK PRICE LIMITS.
 *
 * Pure and client-safe. These two were InvestingCard's, and they moved here when
 * the live dashboard's rule card needed the same numbers: a pure model must not
 * import a `"use client"` component to do arithmetic, and two copies of "how
 * much has this policy used" is how two screens come to disagree about somebody's
 * remaining allowance. InvestingCard re-exports them, so its own test and its
 * existing imports are untouched.
 */

import {
  LIVE_PRICE_FLOOR_WAD,
  OFFERED_LEGS,
  catalogueLegSlippageBps,
  floorWad,
  keeperInvestMinOutFor,
  netOfTransferFeeWad,
  usdcRawPer1e8LegRaw,
  usdcRawPerSol,
} from "@sip/solana-core/client";

import { rawFrom } from "@/lib/amounts";
import type { VaultStateJson } from "@/lib/vault-api";

/** What the policy's 31 day-buckets say it invested in the trailing 31 days, summed as the program sums them. */
export function usedInLast30Days(bucketDays: readonly number[], bucketAmounts: readonly string[], nowSeconds: number): bigint {
  const today = Math.floor(nowSeconds / 86_400);
  return bucketDays.reduce((total, day, index) => (day + 31 > today ? total + (rawFrom(bucketAmounts[index]) ?? 0n) : total), 0n);
}

/**
 * THE LAST DAY THE POLICY BOUGHT ANYTHING, FROM THE CHAIN'S OWN COUNTERS.
 *
 * Every buy adds its USDC to the bucket of its UTC day (state.rs, invest.rs),
 * and a re-signed policy keeps the buckets — so the newest bucket holding more
 * than zero is the day of the last buy, whatever the loaded page of history
 * holds. The live rule card needs it because that page is fifteen signatures
 * long: once upkeep pushes the buys off it, "No investments yet" would sit
 * beside the shares they bought.
 *
 * The amount is the WHOLE UTC day's spend, not one transaction's, and there is
 * no signature to link to. A bucket never written is day 0 with amount 0 and
 * is skipped; so is one whose amount cannot be read. Null when none is left.
 */
export function lastInvestedDay(bucketDays: readonly number[], bucketAmounts: readonly string[]): { readonly day: string; readonly usdcRaw: bigint } | null {
  let newestDay = 0;
  let newestRaw = 0n;
  for (let index = 0; index < bucketDays.length; index += 1) {
    const day = bucketDays[index]!;
    const usdcRaw = rawFrom(bucketAmounts[index]) ?? 0n;
    if (usdcRaw > 0n && Number.isSafeInteger(day) && day > newestDay) {
      newestDay = day;
      newestRaw = usdcRaw;
    }
  }
  return newestDay === 0 ? null : { day: new Date(newestDay * 86_400_000).toISOString().slice(0, 10), usdcRaw: newestRaw };
}

export interface TodaysPrices {
  /** USDC raw per SOL at today's rate. */
  readonly todayPerSol: bigint;
  /** Per offered leg: today's price per 1e8 raw units. */
  readonly legs: readonly { readonly mint: string; readonly symbol: string; readonly todayPer1e8: bigint }[];
}

/** Today's prices from the screen's last read of the pools; null when one is missing. */
export function todaysPrices(prices: VaultStateJson["prices"]): TodaysPrices | null {
  if (prices === null) return null;
  try {
    const convert = rawFrom(prices.convertWad);
    if (convert === null) return null;
    const legs = OFFERED_LEGS.map((leg) => {
      const wad = rawFrom(prices.legs.find((entry) => entry.mint === leg.mint)?.wad);
      if (wad === null) throw new RangeError(`no price for ${leg.symbol}`);
      return { mint: leg.mint, symbol: leg.symbol, todayPer1e8: usdcRawPer1e8LegRaw(wad) };
    });
    return { todayPerSol: usdcRawPerSol(convert), legs };
  } catch {
    return null;
  }
}

// ── A POLICY SIGNED BEFORE 2026-10-08 ────────────────────────────────────────
//
// Since the owner's decision that day every policy signs LIVE_PRICE_FLOOR_WAD
// (1 wad) for every leg: no stock price floor (solana-core product.ts). A
// policy signed before it carries real floors — a floor per stock 5-7 % under
// its own price and a SOL floor 10 % under that day's — and keeps them until
// it is signed again. The page tells the two apart by THE LEGS ALONE: any leg
// floor over LIVE_PRICE_FLOOR_WAD is a price limit from before.
//
// NOT BY THE SOL FLOOR. Since 2026-10-09 every new policy signs a SOL safety
// floor at half the SOL price (product.ts CONVERT_SAFETY_FLOOR_BPS), so a SOL
// floor over 1 wad is what a NEW policy carries too; live-model.ts
// priceLimitsOf judges it on its own ("safety_floor").

/**
 * A price per 1e8 raw units of a leg (usdcRawPer1e8LegRaw, todaysPrices) as a
 * price per WHOLE token, in USDC raw units.
 *
 * 1e8 RAW UNITS IS NOT ONE TOKEN FOR EVERY LEG: it is one SPYx (8 decimals) but a
 * tenth of an ANTHROPIC (9 decimals). The old-limits block printed "per
 * 100,000,000 raw units", which was true and which nobody could read.
 */
export function perWholeToken(per1e8: bigint, decimals: number): bigint {
  return decimals >= 8 ? per1e8 * 10n ** BigInt(decimals - 8) : per1e8 / 10n ** BigInt(8 - decimals);
}

/**
 * Whether a stored policy carries the price limits of a policy signed before
 * 2026-10-08: any leg's min_out_rate_wad over LIVE_PRICE_FLOOR_WAD. The SOL
 * floor is not read here (see above). An unreadable number is not judged a
 * limit: nothing is urged on a guess.
 */
export function carriesPriceLimits(minOutRateWads: readonly (bigint | null)[]): boolean {
  return minOutRateWads.some((wad) => wad !== null && wad > LIVE_PRICE_FLOOR_WAD);
}

// ── WHETHER THE KEEPER STILL BUYS UNDER A SIGNED FLOOR ───────────────────────
//
// ONLY A POLICY SIGNED BEFORE 2026-10-08 HAS A FLOOR THIS CAN JUDGE: at 1 wad
// every route clears it. live-model.ts priceLimitsOf uses it to decide whether
// such a policy's old limits are stopping buys right now.
//
// THE THIRD WAY A FLOOR CAN STOP BUYING. "passed" is the market falling
// through a floor. This is the room the
// keeper asks of the market falling through it while the market stands still,
// because the issuer's transfer fee rose.
//
// THE KEEPER'S RULE, AS DEPLOYED (origin/main df6ca67, jupiter-route.ts
// investMinOutFor, mirrored by solana-core's keeperInvestMinOutFor and held to
// the keeper's own answers by test/fixtures/keeper-policy.ts
// OWNER_FLOOR_MIN_OUT): it BUYS a leg exactly when the venue's threshold —
// the quote less legSlippageBps(fee), Jupiter's otherAmountThreshold — is at or
// over the signed floor. The fee is not taken off before that comparison. (It
// was until df6ca67, and that rule had this card saying "Sign again" over a
// floor the deployed keeper buys under.)
//
// WHICH QUOTE, AND THAT IS WHERE THE FEE COMES IN. Jupiter re-picks the route
// per quote, and the quote's basis belongs to its LAST hop:
//   * GROSS (Manifest): about the mid less the route's own cost;
//   * NET (Raydium CLMM, Meteora DLMM): that, less the transfer fee too.
// So a floor sits in one of three places, at the fee that matters for the
// owner's future — the HIGHEST WRITTEN one, the catalogue's judged fee, which
// is the one in force once its epoch arrives:
//   "every-route" the costliest case clears it: a net last hop, on a route
//                 ROUTE_COST_UNDER_MID_BPS under the mid;
//   "some-routes" between the two: whether a sweep buys depends on the route
//                 it gets — its last hop's basis, and its own price against
//                 the mid. A note, and buying goes on;
//   "no-route"    not even the kindest case clears it: a gross last hop on a
//                 route ROUTE_OVER_MID_BPS OVER the mid. The keeper refuses
//                 the whole basket, and the SOL conversion with it, on every
//                 sweep. The only state that flips the badge, so it is judged
//                 at the route most favourable to buying.
//
// THE ROUTE'S OWN PRICE IS A MODEL, NOT A READING, AND IT RUNS BOTH WAYS.
// Under the mid — measured 2026-09-25 (epoch 1042, slot 450231345) for the
// owner's $2.75 ANTHROPIC leg at slippage 400, against the floor pool's mid:
// Jupiter's default route (Quantum > Manifest, gross) came back 18.95 bps
// under it; held to Raydium CLMM, 99.79 bps under and held to Meteora DLMM,
// 105.83 bps under, both with the 100 bps fee then in force already off. So
// 25 — the floor pool's own tier — covers the route's cost on every reading
// that day. Over the mid — measured the same day for SPYx against its floor
// pool: 3.64 and 3.40 bps over at $2.75 and $74.50 (Whirlpool, slot
// 450234502), 6.16 and 5.97 bps over (PancakeSwap and Byreal, slot 450236314).
// A route through another pool can beat the floor pool's mid, so "no-route"
// is judged with the route 25 bps over it, which covers every such reading.
// A bigger buy or a thinner book moves the real edges; this is a screen, and
// no gate reads it.

/** What a route is modelled to cost under the floor pool's mid, before any transfer fee: 25 bps (measured above). The "every-route" line. */
export const ROUTE_COST_UNDER_MID_BPS = 25;

/** How far over the floor pool's mid a route is allowed to come back when judging "no-route": 25 bps (measured above, readings up to 6.16). */
export const ROUTE_OVER_MID_BPS = 25;

/** Whether the route's last hop quotes before the transfer fee (gross) or after it (net). */
export type LastHopQuote = "gross" | "net";

/** Which side of the floor pool's mid the modelled route's price sits: the costly case, or the kind one. */
export type RoutePrice = "under-mid" | "over-mid";

/**
 * The venue threshold the keeper compares the owner's floor against, per 1e18
 * USDC raw, for a route quoting on `lastHop` at a `feeBps` transfer fee: the
 * mid less ROUTE_COST_UNDER_MID_BPS (or plus ROUTE_OVER_MID_BPS, `over-mid`),
 * less the fee on a net last hop, then less catalogueLegSlippageBps(fee).
 */
export function keeperVenueThresholdWad(midWad: bigint, feeBps: number, lastHop: LastHopQuote, route: RoutePrice = "under-mid"): bigint {
  const quote = route === "under-mid" ? floorWad(midWad, ROUTE_COST_UNDER_MID_BPS) : (midWad * BigInt(10_000 + ROUTE_OVER_MID_BPS)) / 10_000n;
  const quoted = lastHop === "net" ? netOfTransferFeeWad(quote, feeBps) : quote;
  return floorWad(quoted, catalogueLegSlippageBps(feeBps));
}

/** Whether the keeper would buy under `storedWad` on the modelled route: its own rule, run through the mirror. */
function keeperBuys(storedWad: bigint, midWad: bigint, feeBps: number, lastHop: LastHopQuote, route: RoutePrice): boolean {
  const venueThreshold = keeperVenueThresholdWad(midWad, feeBps, lastHop, route);
  return keeperInvestMinOutFor({ venueThreshold, netOfVenueThreshold: netOfTransferFeeWad(venueThreshold, feeBps), ownerFloor: storedWad }) !== null;
}

/** Where a signed leg floor sits against the keeper's rule at today's mid and a `feeBps` fee. */
export type FloorRoom = "every-route" | "some-routes" | "no-route";

/** The three states above, or null when either number is missing. */
export function floorRoom(storedWad: bigint | null, liveWad: bigint | null, feeBps: number): FloorRoom | null {
  if (storedWad === null || liveWad === null || storedWad <= 0n || liveWad <= 0n) return null;
  if (keeperBuys(storedWad, liveWad, feeBps, "net", "under-mid")) return "every-route";
  if (keeperBuys(storedWad, liveWad, feeBps, "gross", "over-mid")) return "some-routes";
  return "no-route";
}
