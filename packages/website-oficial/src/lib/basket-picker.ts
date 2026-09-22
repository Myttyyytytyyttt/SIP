/**
 * THE BASKET SOMEBODY IS CLICKING TOGETHER, between the catalogue and the
 * arithmetic.
 *
 * basket-limits.ts is pure integer arithmetic over weights and raw USDC and
 * knows nothing about an asset. product.ts is a shelf of dated readings and
 * knows nothing about a form. This file is the join: it takes the rows the
 * picker is showing, decides WHICH reading each chosen leg's ceiling may be
 * divided by, and answers the one thing the form has to know — the window of
 * caps that can actually buy this basket, and which leg closed it.
 *
 * THE RULE THAT MATTERS MOST HERE, because getting it wrong is the failure the
 * whole feature exists to prevent: A CEILING MAY ONLY EVER DIVIDE A ROUTE
 * CENSUS. The keeper counts the USDC held by the accounts the chosen route
 * names (invest-decision.ts censusVenueInventory); a published venue-wide depth
 * sums a book or a set of bins that no single route touches, and on ANTHROPIC
 * on 2026-09-21 the two differed by forty-five times. `depth` screens an asset
 * onto the shelf and may be either; a ceiling DIVIDES, so the bigger number
 * makes the cap bigger, and a cap that is too big does not buy less — it buys
 * NOTHING, at any balance, for the life of the policy, with the rent spent. So
 * routeCensusRaw() is the only input, and a leg nobody counted leaves the
 * ceiling UNKNOWN rather than large.
 *
 * AND EVERY NUMBER HERE IS A FORECAST OF A GATE, NOT THE GATE. The keeper
 * re-measures inside every turn, at the size that turn will really spend, and
 * it is the one that is always right. What this file does is keep the form from
 * signing a policy that walks straight into it on the readings SaverFi has.
 */

import {
  CATALOGUE,
  LEG_WEIGHT_TOTAL_BPS,
  MAX_PICKED_LEGS,
  isOfferable,
  offerProblems,
  routeCensusReading,
  type CatalogueAsset,
  type RuleFailure,
} from "@sip/solana-core/client";

import { capWindow, type BasketLegDepth } from "@/lib/basket-limits";
import { POOL_DEPTH_MULTIPLE } from "@/lib/vault-copy";

/** The owner's "maximo como 5", one copy, in core beside the size the shelf's rules are measured at. */
export { PICKER_MAX_LEGS } from "@/lib/basket-limits";

/** A row in the picker: an asset, and the share the owner typed against it. Text, because it is what is in the box. */
export interface PickedRow {
  readonly mint: string;
  /** Whole percent, as typed. "" while the box is empty. */
  readonly percent: string;
}

/** A chosen asset with its share already read as basis points. */
export interface PickedLeg {
  readonly asset: CatalogueAsset;
  readonly weightBps: number;
}

/** The catalogue, offered first, then the refused ones with the rules that refused them. */
export interface CatalogueRow {
  readonly asset: CatalogueAsset;
  readonly offerable: boolean;
  readonly problems: readonly RuleFailure[];
}

/** Every asset the catalogue knows about, the offerable ones first and each refusal carrying its rules. */
export function catalogueRows(): readonly CatalogueRow[] {
  const rows = CATALOGUE.map((asset) => ({ asset, offerable: isOfferable(asset), problems: offerProblems(asset) }));
  return [...rows.filter((row) => row.offerable), ...rows.filter((row) => !row.offerable)];
}

/** The catalogue entry for `mint`, or null. */
export const catalogueAsset = (mint: string): CatalogueAsset | null => CATALOGUE.find((asset) => asset.mint === mint) ?? null;

/**
 * EQUAL SHARES IN WHOLE PERCENT, the affordance behind "even them out".
 *
 * NOT basketWeightsBps, which divides 10,000 and hands back 33.34 % — a figure
 * the boxes cannot hold and the server would be right to refuse as a fraction
 * of a point nobody typed. This divides 100 and puts the remainder on the first
 * row, so three legs are 34/33/33 and five are 20 each, and the sum is exactly
 * 100 by construction at every count.
 */
export function evenPercents(count: number): number[] {
  if (!Number.isInteger(count) || count < 1) throw new RangeError("a basket has at least one asset");
  const share = Math.floor(100 / count);
  return Array.from({ length: count }, (_, index) => (index === 0 ? share + (100 - share * count) : share));
}

/**
 * TICKING, UNTICKING AND EVENING OUT, as functions over the rows rather than as
 * three closures inside the component — each is a rule with a price on it, and
 * a rule inside a closure is a rule nothing can pin.
 *
 * UNTICKED IS REMOVED, NEVER HELD AT 0 %. set_invest_policy takes weight_bps as
 * a u16 it requires to be greater than zero, so a row "kept" at zero is not a
 * stock the owner declined — it is a transaction the chain rejects, after
 * Phantom has already asked him to sign it. Absence is how a stock stays out.
 *
 * A FULL BASKET DOES NOT GROW AND A REFUSED ASSET NEVER ENTERS ONE. The ticks
 * are already disabled at both, so this is the second lock and not the first:
 * what it stops is a sixth leg, or a mint the shelf refuses, arriving from
 * anywhere that is not the checkbox — after which the only refusal left is the
 * build route's, which arrives once the form has already said yes.
 */
export function toggled(rows: readonly PickedRow[], mint: string, on: boolean): readonly PickedRow[] {
  if (!on) return rows.filter((row) => row.mint !== mint);
  const asset = catalogueAsset(mint);
  if (asset === null || !isOfferable(asset)) return rows;
  if (rows.length >= MAX_PICKED_LEGS || rows.some((row) => row.mint === mint)) return rows;
  return [...rows, { mint, percent: "" }];
}

/**
 * The share typed against one row, kept EXACTLY as typed — "07", "5.5", "" and
 * all. The boxes are read in one place, by readWeights, which refuses anything
 * that is not a whole percent and names the stock it refused; a picker that
 * quietly corrected the text here would be deciding a share the owner did not.
 */
export const withPercent = (rows: readonly PickedRow[], mint: string, percent: string): readonly PickedRow[] =>
  rows.map((row) => (row.mint === mint ? { mint: row.mint, percent } : row));

/**
 * THE ONE REPAIR, AND ONLY WHEN IT IS PRESSED FOR.
 *
 * Nothing normalises a basket that does not add up: a sum of 99 is a different
 * basket from the one on screen and both the server and the program refuse it
 * rather than fix it. What is offered instead is this, behind a button — equal
 * whole percents with the remainder on the first row, so the sum is exactly 100
 * at every count the picker allows, and the owner chose it.
 */
export function evenedOut(rows: readonly PickedRow[]): readonly PickedRow[] {
  if (rows.length === 0) return rows;
  const shares = evenPercents(rows.length);
  return rows.map((row, index) => ({ mint: row.mint, percent: String(shares[index]!) }));
}

/** The whole percentages in `rows`, with an unreadable box counting as nothing. Only for the total on screen. */
export const percentTotal = (rows: readonly PickedRow[]): number =>
  rows.reduce((total, row) => total + (/^[0-9]{1,3}$/.test(row.percent.trim()) ? Number(row.percent.trim()) : 0), 0);

/** What a chosen leg's ceiling was divided by, or why it could not be. */
export interface LegCensus {
  readonly symbol: string;
  readonly weightBps: number;
  /** USDC raw the route was counted to hold, or null when nobody counted it. */
  readonly censusRaw: bigint | null;
  readonly venue: string | null;
  readonly readOn: string | null;
  /**
   * TRUE WHEN THAT FIGURE WAS WORKED BACK FROM ANOTHER MEASUREMENT rather than
   * counted (product.ts DepthReading.derived). It changes no arithmetic and one
   * sentence: the card must not tell the owner a number was counted when the
   * catalogue's own entry says it was not, because "counted" is the word the
   * uncounted branch of this same copy turns on.
   */
  readonly derived: boolean;
}

/** The window of caps this basket can be signed at, and which leg closed each end. */
export interface BasketLimits {
  /** The smallest max_per_call at which EVERY leg clears the minimum. Pure arithmetic over what is signed: always known. */
  readonly floorRaw: bigint;
  /** The lightest-weighted leg, which is the one that sets the floor. */
  readonly floorBinding: LegCensus | null;
  /** The largest max_per_call every leg's counted route still covers, or null when a chosen leg was never counted. */
  readonly ceilingRaw: bigint | null;
  /** The leg whose route closed the ceiling: the one to drop, or to lighten. */
  readonly ceilingBinding: LegCensus | null;
  /** Chosen legs nobody counted a route for. Non-empty means ceilingRaw is null. */
  readonly uncounted: readonly LegCensus[];
  /** No cap exists at all: the ceiling is under the floor. The basket must lose a leg or move a weight. */
  readonly empty: boolean;
  /** Where the Most per buy box should start. Half the ceiling when there is one, never under the floor. */
  readonly suggestedRaw: bigint;
  readonly legs: readonly LegCensus[];
}

const censusOf = (leg: PickedLeg): LegCensus => {
  // ONE READING, NOT A FIELD AT A TIME. routeCensusReading answers the whole
  // census — its number, its venue, its day and whether it was derived — so the
  // venue can no longer come from one measurement while the figure comes from
  // another, which is what reading `routeCensus?.venue ?? depth?.venue` could
  // do on an asset whose census is its depth.
  const reading = routeCensusReading(leg.asset);
  return {
    symbol: leg.asset.symbol,
    weightBps: leg.weightBps,
    censusRaw: reading?.usdcRaw ?? null,
    venue: reading?.venue ?? null,
    readOn: reading?.readOn ?? null,
    derived: reading?.derived === true,
  };
};

/**
 * THE WHOLE ANSWER FOR ONE BASKET AT ONE MINIMUM, recomputed on every keystroke
 * because every input moves it.
 *
 * THE TWO ENDS ARE NOT THE SAME KIND OF NUMBER, and the card must not treat
 * them as one:
 *  * THE FLOOR is arithmetic over fields the transaction itself carries —
 *    ⌈min_investment × 10,000 / the lightest weight⌉ — and it cannot be stale,
 *    cannot be measured wrong, and is the same number the program and the
 *    keeper will apply. It may be enforced.
 *  * THE CEILING divides a reading taken on a named day against a route that is
 *    re-picked per quote. It is the best forecast available and it is still a
 *    forecast.
 *
 * Throws RangeError on weights the program would refuse — the caller validates
 * first, and an illegal basket has no meaningful window.
 */
export function basketLimits(legs: readonly PickedLeg[], minInvestmentRaw: bigint): BasketLimits {
  const legCensuses = legs.map(censusOf);
  const uncounted = legCensuses.filter((leg) => leg.censusRaw === null);
  const lightest = legCensuses.reduce<LegCensus | null>((worst, leg) => (worst === null || leg.weightBps < worst.weightBps ? leg : worst), null);

  // With a leg nobody counted there is no ceiling to compute, so the arithmetic
  // is run with the floor alone: a fictitious inventory would be a fictitious
  // ceiling, and this is the one direction the answer may never lean.
  if (uncounted.length > 0) {
    const { floorRaw } = capWindow(
      legs.map((leg, index) => ({ mint: leg.asset.mint, weightBps: legCensuses[index]!.weightBps, venueInventoryRaw: 0n })),
      minInvestmentRaw,
    );
    return { floorRaw, floorBinding: lightest, ceilingRaw: null, ceilingBinding: null, uncounted, empty: false, suggestedRaw: floorRaw, legs: legCensuses };
  }

  const depths: BasketLegDepth[] = legs.map((leg, index) => ({ mint: leg.asset.mint, weightBps: leg.weightBps, venueInventoryRaw: legCensuses[index]!.censusRaw! }));
  const window = capWindow(depths, minInvestmentRaw);
  const bindingAt = window.binding === null ? -1 : legs.findIndex((leg) => leg.asset.mint === window.binding!.mint);
  const ceilingBinding = bindingAt < 0 ? null : (legCensuses[bindingAt] ?? null);
  return {
    floorRaw: window.floorRaw,
    floorBinding: lightest,
    ceilingRaw: window.ceilingRaw,
    ceilingBinding,
    uncounted,
    empty: window.empty,
    suggestedRaw: window.suggestedRaw ?? window.floorRaw,
    legs: legCensuses,
  };
}

/** Whether `maxPerCallRaw` sits above what the counted routes cover. False when there is no ceiling to be above. */
export const overCeiling = (maxPerCallRaw: bigint, limits: BasketLimits): boolean => limits.ceilingRaw !== null && maxPerCallRaw > limits.ceilingRaw;

/**
 * THE LIGHTEST WEIGHT THAT KEEPS THIS CAP UNDER THE CEILING FOR THE BINDING
 * LEG — the "lower that one's share to n %" a refusal owes the owner.
 *
 * IT TAKES THE WHOLE WINDOW AND NOT ONE LEG, because whether this way out
 * exists at all is a fact about the BASKET. In a one-stock basket the share is
 * 100 % by arithmetic — set_invest_policy requires the weights to sum to
 * exactly 10,000 — so there is nowhere for a freed share to go, and offering a
 * smaller one would be advice the owner cannot take. The other two ways out,
 * a lower cap and dropping the stock, are then the whole of it.
 *
 * From the ceiling's own inequality, a leg passes while
 * ⌊M × w / 10,000⌋ ≤ ⌊inventory / 50⌋, so the largest weight that still passes
 * at a given cap M is ⌊(⌊inventory / 50⌋ + 1) × 10,000 / M⌋ − 1 capped at the
 * share it already has. Returns null when even one basis point is too much (the
 * leg has to go), and when the leg already passes.
 *
 * AND IT IS ROUNDED DOWN TO A WHOLE PERCENT, which is not a nicety. The boxes
 * take whole percentages and readWeights refuses anything else, so the exact
 * boundary — 14.89 % at a $1,000 cap on today's ANTHROPIC census — is a share
 * the owner is being told to type and CANNOT. A fix he has to round himself is
 * not a fix, and rounding the wrong way puts him back over the ceiling he was
 * just refused for. Down is the only safe direction, and since the exact answer
 * is the LARGEST passing share, the next whole percent up always fails.
 */
export function lighterWeightBps(maxPerCallRaw: bigint, limits: BasketLimits): number | null {
  const leg = limits.ceilingBinding;
  if (leg === null || limits.legs.length < 2) return null;
  if (leg.censusRaw === null || maxPerCallRaw <= 0n) return null;
  const mostOneLegMayTake = leg.censusRaw / BigInt(POOL_DEPTH_MULTIPLE);
  if ((maxPerCallRaw * BigInt(leg.weightBps)) / BigInt(LEG_WEIGHT_TOTAL_BPS) <= mostOneLegMayTake) return null;
  const largest = ((mostOneLegMayTake + 1n) * BigInt(LEG_WEIGHT_TOTAL_BPS)) / maxPerCallRaw - 1n;
  if (largest <= 0n) return null;
  const exact = Number(largest < BigInt(leg.weightBps) ? largest : BigInt(leg.weightBps));
  // A WHOLE PERCENT, always downwards. Under one percent there is no share the
  // picker can hold at all, and the honest answer is the other two ways out.
  const bps = Math.floor(exact / 100) * 100;
  return bps > 0 && bps < leg.weightBps ? bps : null;
}

/** The most legs a basket may hold here, restated for the callers that only import this module. */
export const MOST_PICKED = MAX_PICKED_LEGS;
