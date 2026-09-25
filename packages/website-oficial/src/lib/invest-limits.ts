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

import {
  CONVERT_FLOOR_MARGIN_BPS,
  OFFERED_LEGS,
  catalogueLegSlippageBps,
  floorWad,
  judgedFeeBps,
  keeperInvestMinOutFor,
  legFloorMarginBps,
  legFloorWad,
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

export interface TodaysLimits {
  /** USDC raw per SOL at the convert floor, and at today's rate. */
  readonly floorPerSol: bigint;
  readonly todayPerSol: bigint;
  /**
   * Per leg: today's price, and the most the floor a policy signed now lets be
   * paid — per 1e8 raw units THAT ARRIVE, because the floor is net of `feeBps`,
   * the transfer fee the build nets (the higher of the one in force and one
   * already written, as the catalogue read it) — and `marginBps`, how far
   * under that net price the floor sits (legFloorMarginBps: 500, or 700 at a
   * 300 bps fee, where the keeper asks the market for 200 bps more).
   */
  readonly legs: readonly {
    readonly mint: string;
    readonly symbol: string;
    readonly todayPer1e8: bigint;
    readonly maxPer1e8: bigint;
    readonly feeBps: number;
    readonly marginBps: number;
  }[];
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
      // THE SAME ARITHMETIC THE BUILD SIGNS (build-handler.ts liveFloors), with
      // the catalogue's reading of the fee standing in for the mint read the
      // build takes at the click. The build's own figure is what is signed, and
      // vault-flows.ts holds it to this arithmetic over the fee IT read.
      const feeBps = judgedFeeBps(leg.fee);
      return {
        mint: leg.mint,
        symbol: leg.symbol,
        todayPer1e8: usdcRawPer1e8LegRaw(wad),
        maxPer1e8: usdcRawPer1e8LegRaw(legFloorWad(wad, feeBps)),
        feeBps,
        marginBps: legFloorMarginBps(feeBps),
      };
    });
    return { floorPerSol: usdcRawPerSol(floorWad(convert, CONVERT_FLOOR_MARGIN_BPS)), todayPerSol: usdcRawPerSol(convert), legs };
  } catch {
    return null;
  }
}

// ── HOW FAR A SIGNED FLOOR HAS DRIFTED FROM THE MARKET ───────────────────────
//
// A floor is signed ONCE. build-handler derives min_out_rate_wad from a pool's
// mid, net of the leg's transfer fee, at legFloorMarginBps(fee) under it (a
// policy signed before 2026-09-24 was not netted, and took a flat 500), and
// min_convert_rate_wad from the SOL
// price at CONVERT_FLOOR_MARGIN_BPS under it, and then both numbers stand until
// the owner signs again. The keeper's own comment states the consequence:
// the floor "DECAYS ... it clears itself as the market rises (a stale floor
// stops binding) and blocks every honest buy as the market falls."
//
// BOTH ENDS OF THAT ARE FAILURES AND ONLY ONE OF THEM IS VISIBLE. A floor the
// market has passed shows up immediately — nothing buys, and the card says so.
// A floor the market has left far behind shows up as nothing at all: it is
// still signed, still enforced on chain, and it would let a fill through at a
// price no one would accept today. That is the half this measures.
//
// THE ARITHMETIC IS OVER TWO NUMBERS THE PAGE ALREADY HAS: the wad the policy
// carries, and the wad the screen just read. No reading is taken for it.

/**
 * How far under the GROSS pool mid a leg's floor is signed today, in bps: the
 * transfer fee and legFloorMarginBps(fee) compounded — 500 with no fee, 595 at
 * 100 bps, 979 at 300. It is the margin floorDrift needs for a leg: the drift
 * is measured against the gross mid the screen reads, so a floor that is
 * rightly 9.8 % under it at 300 bps must not be called out as slack the moment
 * it is signed. A DISPLAY NUMBER, like FLOOR_DRIFT_NOTICE_MULTIPLE: it reads
 * the fee as the catalogue has it now, which is the fee a policy signed now
 * nets, and a policy signed before 2026-09-24 sits closer to the mid than this.
 */
export function legFloorUnderMidBps(feeBps: number): number {
  return 10_000 - Math.round(((10_000 - feeBps) * (10_000 - legFloorMarginBps(feeBps))) / 10_000);
}

/** The margin's own slack, in basis points: a floor signed m bps under the market sits m/(10,000-m) under it as a ratio. At 500 bps that is 526, at 1,000 it is 1,111. */
export const signedSlackBps = (marginBps: number): number => Math.round((marginBps * 10_000) / (10_000 - marginBps));

/**
 * HOW MUCH FURTHER THAN ITS OWN MARGIN A FLOOR HAS TO HAVE DRIFTED BEFORE THE
 * CARD CALLS IT OUT, and it is a display rule and nothing else — no gate, on
 * chain or in the keeper, cares about this number.
 *
 * ONE margin's worth of movement is what the margin was for: the floor was set
 * that far under the market precisely so an ordinary day does not pass it.
 * TWICE it is the market having gone somewhere else, and the floor is then
 * further from today's price than it ever was from the price it was signed at.
 */
export const FLOOR_DRIFT_NOTICE_MULTIPLE = 2;

/** Where a signed floor now stands against the rate just read. */
export type FloorDrift =
  /** The market has fallen through the floor: the keeper refuses, and by the all-or-nothing doctrine it refuses the whole basket. */
  | { readonly kind: "passed" }
  /** The market has left the floor far behind: it still permits a fill at `driftBps` worse than today. */
  | { readonly kind: "slack"; readonly driftBps: number }
  /** The floor is still about where it was signed. */
  | { readonly kind: "in-step"; readonly driftBps: number };

/**
 * `storedWad` is the floor the policy carries, `liveWad` the same quantity as
 * the screen just read it, and `marginBps` the margin it was signed at. Null
 * when either number is missing or not positive — an unread rate is not a
 * drift of zero, and nothing is said about it.
 *
 * THE DRIFT IS MEASURED AGAINST THE FLOOR, not against the market, because the
 * floor is what the sentence quotes: at driftBps the floor permits a fill that
 * much worse than the rate just read.
 */
export function floorDrift(storedWad: bigint | null, liveWad: bigint | null, marginBps: number): FloorDrift | null {
  if (storedWad === null || liveWad === null || storedWad <= 0n || liveWad <= 0n) return null;
  if (storedWad > liveWad) return { kind: "passed" };
  const driftBps = Number(((liveWad - storedWad) * 10_000n) / storedWad);
  return { kind: driftBps > signedSlackBps(marginBps) * FLOOR_DRIFT_NOTICE_MULTIPLE ? "slack" : "in-step", driftBps };
}

// ── WHETHER THE KEEPER STILL BUYS UNDER A SIGNED FLOOR ───────────────────────
//
// THE THIRD WAY A FLOOR CAN STOP BUYING, AND THE ONE NOTHING ELSE ON THE PAGE
// SHOWS. "passed" is the market falling through a floor. This is the room the
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
//   "every-route" the net case clears it, and so does the gross one;
//   "some-routes" only the gross case clears it: a sweep whose best route
//                 quotes net refuses the basket and waits, one that quotes
//                 gross buys;
//   "no-route"    neither clears it: the keeper refuses the whole basket, and
//                 the SOL conversion with it, on every sweep.
//
// THE ROUTE'S OWN COST IS A MODEL, NOT A READING: ROUTE_COST_UNDER_MID_BPS.
// Measured 2026-09-25 (epoch 1042, slot 450231345) for the owner's $2.75
// ANTHROPIC leg at slippage 400, against the floor pool's mid: Jupiter's
// default route (Quantum > Manifest, gross) came back 18.95 bps under it; held
// to Raydium CLMM, 99.79 bps under and held to Meteora DLMM, 105.83 bps under,
// both with the 100 bps fee then in force already off. So 25 — the floor
// pool's own tier — covers the route's cost on every reading that day, with
// 0 to 25 bps to spare. A bigger buy or a thinner book costs more and moves the
// real edge up; this is a screen, and no gate reads it.

/** What a route is modelled to cost under the floor pool's mid, before any transfer fee: 25 bps (measured above). */
export const ROUTE_COST_UNDER_MID_BPS = 25;

/** Whether the route's last hop quotes before the transfer fee (gross) or after it (net). */
export type LastHopQuote = "gross" | "net";

/**
 * The venue threshold the keeper compares the owner's floor against, per 1e18
 * USDC raw, for a route quoting on `lastHop` at a `feeBps` transfer fee: the
 * mid less ROUTE_COST_UNDER_MID_BPS, less the fee on a net last hop, then less
 * catalogueLegSlippageBps(fee).
 */
export function keeperVenueThresholdWad(midWad: bigint, feeBps: number, lastHop: LastHopQuote): bigint {
  const quote = floorWad(midWad, ROUTE_COST_UNDER_MID_BPS);
  const quoted = lastHop === "net" ? netOfTransferFeeWad(quote, feeBps) : quote;
  return floorWad(quoted, catalogueLegSlippageBps(feeBps));
}

/** Whether the keeper would buy under `storedWad` on a route quoting on `lastHop`: its own rule, run through the mirror. */
function keeperBuys(storedWad: bigint, midWad: bigint, feeBps: number, lastHop: LastHopQuote): boolean {
  const venueThreshold = keeperVenueThresholdWad(midWad, feeBps, lastHop);
  return keeperInvestMinOutFor({ venueThreshold, netOfVenueThreshold: netOfTransferFeeWad(venueThreshold, feeBps), ownerFloor: storedWad }) !== null;
}

/** Where a signed leg floor sits against the keeper's rule at today's mid and a `feeBps` fee. */
export type FloorRoom = "every-route" | "some-routes" | "no-route";

/** The three states above, or null when either number is missing. */
export function floorRoom(storedWad: bigint | null, liveWad: bigint | null, feeBps: number): FloorRoom | null {
  if (storedWad === null || liveWad === null || storedWad <= 0n || liveWad <= 0n) return null;
  if (keeperBuys(storedWad, liveWad, feeBps, "net")) return "every-route";
  if (keeperBuys(storedWad, liveWad, feeBps, "gross")) return "some-routes";
  return "no-route";
}
