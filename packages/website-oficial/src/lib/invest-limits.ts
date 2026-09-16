/**
 * WHAT AN INVESTMENT POLICY WOULD CARRY TODAY, and what it has already spent.
 *
 * Pure and client-safe. These two were InvestingCard's, and they moved here when
 * the live dashboard's rule card needed the same numbers: a pure model must not
 * import a `"use client"` component to do arithmetic, and two copies of "how
 * much has this policy used" is how two screens come to disagree about somebody's
 * remaining allowance. InvestingCard re-exports them, so its own test and its
 * existing imports are untouched.
 */

import { CONVERT_FLOOR_MARGIN_BPS, LEG_FLOOR_MARGIN_BPS, OFFERED_LEGS, floorWad, usdcRawPer1e8LegRaw, usdcRawPerSol } from "@sip/solana-core/client";

import { rawFrom } from "@/lib/amounts";
import type { VaultStateJson } from "@/lib/vault-api";

/** What the policy's 31 day-buckets say it invested in the trailing 31 days, summed as the program sums them. */
export function usedInLast30Days(bucketDays: readonly number[], bucketAmounts: readonly string[], nowSeconds: number): bigint {
  const today = Math.floor(nowSeconds / 86_400);
  return bucketDays.reduce((total, day, index) => (day + 31 > today ? total + (rawFrom(bucketAmounts[index]) ?? 0n) : total), 0n);
}

export interface TodaysLimits {
  /** USDC raw per SOL at the convert floor, and at today's rate. */
  readonly floorPerSol: bigint;
  readonly todayPerSol: bigint;
  readonly legs: readonly { readonly mint: string; readonly symbol: string; readonly todayPer1e8: bigint; readonly maxPer1e8: bigint }[];
}

/** The limits a policy signed now would carry, from the screen's last read of the pools; null when a price is missing. */
export function todaysLimits(prices: VaultStateJson["prices"]): TodaysLimits | null {
  if (prices === null) return null;
  try {
    const convert = rawFrom(prices.convertWad);
    if (convert === null) return null;
    const legs = OFFERED_LEGS.map((leg) => {
      const wad = rawFrom(prices.legs.find((entry) => entry.mint === leg.mint)?.wad);
      if (wad === null) throw new RangeError(`no price for ${leg.symbol}`);
      return { mint: leg.mint, symbol: leg.symbol, todayPer1e8: usdcRawPer1e8LegRaw(wad), maxPer1e8: usdcRawPer1e8LegRaw(floorWad(wad, LEG_FLOOR_MARGIN_BPS)) };
    });
    return { floorPerSol: usdcRawPerSol(floorWad(convert, CONVERT_FLOOR_MARGIN_BPS)), todayPerSol: usdcRawPerSol(convert), legs };
  } catch {
    return null;
  }
}
