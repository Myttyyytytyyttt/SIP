/**
 * THE ARITHMETIC OF A BASKET SOMEBODY IS STILL ASSEMBLING.
 *
 * The owner wants a catalogue with a picker: choose up to about five assets and
 * type a percentage against each. The program already allows it — state.rs
 * MAX_LEGS is 8, InvestmentLeg.weight_bps is a u16, and set_invest_policy
 * refuses anything whose weights do not sum to exactly 10,000, repeats a mint,
 * or brings more than eight legs. Nothing on chain has to change. What has to
 * change is that THREE NUMBERS THE WEB TREATS AS CONSTANTS STOP BEING
 * CONSTANTS the moment the weights are the user's:
 *
 *   * the smallest cap a policy can ever buy at (REACHABLE_PER_BUY_RAW in
 *     InvestingCard.tsx) is minInvestment × 10,000 / the LIGHTEST weight, and
 *     today it is computed once over basketWeightsBps(OFFERED_LEGS.length) —
 *     equal shares over a catalogue of two;
 *   * the largest cap the venues admit (DEPTH_CEILING_PER_BUY_RAW, a literal
 *     380_000_000n written down from ONE pool read on 2026-09-20) depends on
 *     every chosen leg's weight AND on its own venue's inventory;
 *   * and what the box should START at (SUGGESTED_PER_BUY_RAW) is half of that.
 *
 * A literal cannot follow a picker. These functions are what replaces it.
 *
 * WHY A NEW FILE AND NOT invest-limits.ts. That module answers "what would a
 * policy signed RIGHT NOW carry, and what has this policy already spent": it
 * reads VaultStateJson.prices and the on-chain 31 day-buckets, so every one of
 * its functions needs a vault that exists. Everything here runs BEFORE any of
 * that — with no vault, no policy, no price read, on a basket that is still
 * being clicked together — and is integer arithmetic over weights and raw USDC
 * with no I/O shape anywhere in its signatures. Merging the two would give the
 * picker a module whose type surface is chain JSON it has not got. They sit
 * side by side, and neither imports the other.
 *
 * WHAT THIS FILE DOES NOT KNOW, stated once so nobody reads a guarantee that is
 * not here. It does not measure depth; it divides a depth somebody else
 * measured. It has no opinion on price: the SOL leg is anchored by Pyth in the
 * keeper, and THE STOCK LEGS HAVE NO INDEPENDENT PRICE ANCHOR TODAY. And the
 * keeper's gate is the one that is always right, because it measures the venue
 * inside the turn at the amount that turn will really spend. Everything here is
 * a FORECAST of that gate, made from numbers read on some earlier day, and its
 * only job is to keep the form from signing a policy that walks straight into
 * it.
 */

import { LEG_WEIGHT_TOTAL_BPS, MAX_LEGS } from "@sip/solana-core/client";

import { POOL_DEPTH_MULTIPLE } from "@/lib/vault-copy";

/** The most legs the picker offers, which is the owner's "maximo como 5", not the program's 8. */
export const PICKER_MAX_LEGS = 5;

/** One chosen asset and the share of every buy it takes, in basis points. */
export interface BasketLeg {
  readonly mint: string;
  readonly weightBps: number;
}

/**
 * A chosen asset plus what its venue was measured to hold OF THE POLICY'S
 * in-mint — USDC raw units, the side the spend is denominated in.
 *
 * THIS IS A CENSUS FIGURE, NOT A MARKET-DEPTH FIGURE, and the two are not the
 * same number. The keeper's ARM 1 counts the inventory held by THE ACCOUNTS THE
 * CHOSEN ROUTE NAMES (venue-depth.ts hands legDepthDecision a census over
 * routeMints); a published "USDC-side depth" for a venue is a much larger
 * quantity that includes book or bin inventory no single route touches. Feed
 * this field the census. A market-depth number put here is an OPTIMISTIC
 * ceiling, which is the one direction a ceiling may never be wrong in.
 */
export interface BasketLegDepth extends BasketLeg {
  readonly venueInventoryRaw: bigint;
}

// ── 1. the rules set_invest_policy itself enforces ───────────────────────────

export type WeightsVerdict = { readonly ok: true } | { readonly ok: false; readonly problems: readonly string[] };

/**
 * WHETHER THE PROGRAM WOULD ACCEPT THESE WEIGHTS, so the picker can never build
 * a transaction that reverts after the owner has paid for it in Phantom.
 *
 * Mirrors set_invest_policy.rs line for line, and mirrors NOTHING ELSE — the
 * caps, the floors and the in-mint are checked where they are typed:
 *   require!(!legs.is_empty() && legs.len() <= MAX_LEGS)
 *   for leg: require!(leg.weight_bps > 0)          — weight_bps is a u16
 *            require!(mints.insert(leg.mint))      — a BTreeSet, so duplicates fail
 *   require!(weights == 10_000)                    — summed in a u32, exact
 *
 * EVERY PROBLEM IS RETURNED, not the first. A picker with five rows showing one
 * complaint at a time makes somebody fix five things in five round trips.
 *
 * AND NOTHING IS REPAIRED HERE, as nothing is repaired on the server either: a
 * sum of 9,999 is not normalised up and a missing share is not filled in. Each
 * would be a different basket from the one on screen.
 */
export function weightsAreLegal(legs: readonly BasketLeg[]): WeightsVerdict {
  const problems: string[] = [];
  if (legs.length === 0) problems.push("a basket needs at least one asset");
  if (legs.length > MAX_LEGS) problems.push(`a basket holds at most ${MAX_LEGS} assets; this one has ${legs.length}`);

  const seen = new Set<string>();
  let total = 0;
  for (const [index, leg] of legs.entries()) {
    const at = `asset #${index + 1}`;
    if (typeof leg.mint !== "string" || leg.mint.length === 0) problems.push(`${at}: no mint`);
    else if (seen.has(leg.mint)) problems.push(`${at}: repeats an asset already in the basket`);
    else seen.add(leg.mint);
    // u16, and strictly positive: an unchosen asset is REMOVED from the basket,
    // never carried at 0 %. floorLoss below says why that is the rule.
    if (!Number.isInteger(leg.weightBps) || leg.weightBps <= 0 || leg.weightBps > 0xffff) {
      problems.push(`${at}: the share must be a whole number of basis points from 1 to 65,535`);
    } else total += leg.weightBps;
  }

  if (legs.length > 0 && total !== LEG_WEIGHT_TOTAL_BPS) {
    problems.push(`the shares must add up to exactly ${LEG_WEIGHT_TOTAL_BPS} basis points; these add up to ${total}`);
  }
  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

/** The basket's lightest share, once the program's own rules have passed. Throws RangeError on weights weightsAreLegal refuses. */
function lightestLegalWeightBps(legs: readonly BasketLeg[]): bigint {
  const verdict = weightsAreLegal(legs);
  if (!verdict.ok) throw new RangeError(verdict.problems.join("; "));
  return BigInt(Math.min(...legs.map((leg) => leg.weightBps)));
}

// ── 2. the floor: the smallest cap at which every leg can buy ────────────────

/**
 * THE SMALLEST max_per_call AT WHICH EVERY LEG CLEARS min_investment.
 *
 * THE INEQUALITY. invest.rs requires `amount_in >= policy.min_investment` on
 * EVERY call, and invest-tick takes ONE budget for the whole basket —
 * min(held, max_per_call, 30-day headroom) — then splits it with
 * legShare(budget, w) = floor(budget × w / 10_000). The cap bounds the budget,
 * so the most a leg of weight w can ever be handed is floor(M × w / 10_000).
 * Every leg must clear the minimum out of a FULL cap, or it can never clear it
 * at any balance:
 *
 *     for every leg i:   floor(M × wᵢ / 10_000) ≥ m
 *
 * floor(x) ≥ m for integer m exactly when x ≥ m, so that is
 *
 *     M × wᵢ ≥ m × 10_000     ⟺     M ≥ ⌈m × 10_000 / wᵢ⌉
 *
 * and since the right-hand side falls as wᵢ rises, THE BINDING LEG IS THE
 * LIGHTEST. The answer is ⌈m × 10_000 / w_min⌉, and it is EXACT rather than
 * conservative: that M satisfies every leg, and M − 1 fails the lightest one.
 *
 * WHY IT IS NOT min_investment. At ONE leg the two coincide, which is how the
 * gap stayed invisible while the catalogue had a single asset. At five legs at
 * equal shares (2,000 bps) the cap must be five times the minimum; at a 5 %
 * share it must be TWENTY times it. The program does not refuse the difference
 * — its only rule is 0 < min_investment ≤ max_per_call ≤ max_rolling_30d — so
 * without this bar the owner pays rent for a policy that is dead on arrival and
 * learns it from the dashboard afterwards.
 *
 * AND IT IS ALL-OR-NOTHING. invest-tick refuses the WHOLE turn when any leg's
 * share is short, so one over-light leg stops the deep ones and the SOL
 * conversion with them. It is not "that leg is skipped".
 *
 * Throws RangeError on illegal weights, or on a minimum the program would
 * refuse (min_investment must be > 0).
 */
export function smallestLegalCap(legs: readonly BasketLeg[], minInvestmentRaw: bigint): bigint {
  const lightest = lightestLegalWeightBps(legs);
  if (minInvestmentRaw <= 0n) throw new RangeError("min_investment must be greater than zero");
  const numerator = minInvestmentRaw * BigInt(LEG_WEIGHT_TOTAL_BPS);
  return (numerator + lightest - 1n) / lightest;
}

// ── 3. the ceiling: the largest cap every venue still admits ─────────────────

export interface DepthCeiling {
  /** The largest max_per_call at which every leg passes the keeper's inventory gate. Zero when none does. */
  readonly maxPerCallRaw: bigint;
  /** The leg that set it — the one to drop or re-weight. Null only for an empty basket, which weightsAreLegal refuses first. */
  readonly binding: BasketLegDepth | null;
}

/**
 * THE LARGEST max_per_call AT WHICH EVERY LEG STILL CLEARS THE DEPTH GATE.
 * This is the function that replaces DEPTH_CEILING_PER_BUY_RAW.
 *
 * WHAT IS BEING FORECAST. On a CONVERTING turn the USDC the convert will bring
 * in does not exist yet, so turnSpendCeiling tests the turn at its worst
 * reachable case — min(max_per_call, headroom), which on a fresh vault is the
 * cap itself. legDepthDecision then refuses a hop whose census is under
 *
 *     inventory  <  take × MIN_VENUE_INVENTORY_MULTIPLE
 *
 * with take = legShare(M, w) = floor(M × w / 10_000). Strictly less, so EXACTLY
 * 50× cover is deep and one raw unit under is refused. Passing therefore means
 *
 *     floor(M × wᵢ / 10_000) × 50  ≤  inventoryᵢ
 *
 * Write Kᵢ = ⌊inventoryᵢ / 50⌋, the most one leg may take there. For integer k,
 * 50k ≤ inventory exactly when k ≤ Kᵢ, so the condition is
 *
 *     floor(M × wᵢ / 10_000) ≤ Kᵢ   ⟺   M × wᵢ < (Kᵢ + 1) × 10_000
 *     ⟺   M ≤ ⌈(Kᵢ + 1) × 10_000 / wᵢ⌉ − 1
 *
 * and the basket's ceiling is the MINIMUM of that over the legs. Exact on both
 * sides: that M passes, M + 1 refuses the leg that set it.
 *
 * THE CEILING IS SET BY ONE LEG AGAINST ITS OWN VENUE, NOT BY THE BASKET, and
 * that is the whole reason the literal has to go. A thin asset at a heavy share
 * drags the cap down for the deep ones beside it; the SAME thin asset at 5 %
 * barely touches it. Measured on 2026-09-21, adding ANTHROPIC at 50 % capped
 * the policy near $298 and at 20 % near $745 — one asset, one venue, one day,
 * two and a half times the cap. No constant can hold that.
 *
 * AND IT IS ALL-OR-NOTHING AGAIN: legDepthDecision refuses the whole basket,
 * "the deep ones included, and refusing to convert SOL toward it". A cap over
 * this ceiling does not buy less; it buys nothing, at any balance, forever,
 * while the rent stays spent.
 *
 * WHAT INVALIDATES IT: the reading. One venue, counted once, on one day. The
 * same kind of inventory fell from about $6,700 to $51 in two days on the leg
 * the catalogue dropped. This returns a number; it does not return a promise.
 *
 * Throws RangeError on illegal weights or a negative inventory.
 */
export function depthCeiling(legs: readonly BasketLegDepth[]): DepthCeiling {
  lightestLegalWeightBps(legs); // legality first: an illegal basket has no meaningful ceiling.

  const multiple = BigInt(POOL_DEPTH_MULTIPLE);
  let ceiling: bigint | null = null;
  let binding: BasketLegDepth | null = null;

  for (const leg of legs) {
    if (typeof leg.venueInventoryRaw !== "bigint" || leg.venueInventoryRaw < 0n) {
      throw new RangeError(`a venue cannot hold ${String(leg.venueInventoryRaw)} raw units`);
    }
    const mostOneLegMayTake = leg.venueInventoryRaw / multiple;
    const weight = BigInt(leg.weightBps);
    const limit = ((mostOneLegMayTake + 1n) * BigInt(LEG_WEIGHT_TOTAL_BPS) + weight - 1n) / weight - 1n;
    if (ceiling === null || limit < ceiling) {
      ceiling = limit;
      binding = leg;
    }
  }
  return { maxPerCallRaw: ceiling ?? 0n, binding };
}

// ── the window between them, which is what the form actually asks ────────────

export interface CapWindow {
  readonly floorRaw: bigint;
  readonly ceilingRaw: bigint;
  /** Nothing the owner can type works: the basket must lose a leg or re-weight. */
  readonly empty: boolean;
  /** Where the box should start: half the ceiling, but never under the floor. Null when the window is empty. */
  readonly suggestedRaw: bigint | null;
  readonly binding: BasketLegDepth | null;
}

/**
 * THE WHOLE ANSWER FOR ONE BASKET: the smallest cap that can buy, the largest
 * the venues admit, and whether any cap sits between them.
 *
 * AN EMPTY WINDOW IS A REAL OUTCOME, not an error. A thin venue at a heavy
 * share can put the depth ceiling UNDER the per-leg minimum's floor, and then
 * there is no max_per_call at all: the honest UI drops the leg or moves the
 * weight, and never offers Sign.
 *
 * SUGGESTED IS HALF THE CEILING, for the reason SUGGESTED_PER_BUY_RAW already
 * is: a start at the ceiling itself leaves no cover for an ordinary day's drift
 * in the venue, and turns a ceiling into a target. Clamped up to the floor,
 * because half a ceiling that cannot buy is worse than the edge that can.
 */
export function capWindow(legs: readonly BasketLegDepth[], minInvestmentRaw: bigint): CapWindow {
  const floorRaw = smallestLegalCap(legs, minInvestmentRaw);
  const { maxPerCallRaw: ceilingRaw, binding } = depthCeiling(legs);
  const empty = ceilingRaw < floorRaw;
  const half = ceilingRaw / 2n;
  return { floorRaw, ceilingRaw, empty, suggestedRaw: empty ? null : half < floorRaw ? floorRaw : half, binding };
}

// ── 4. what floor() leaves behind ────────────────────────────────────────────

export interface FloorLoss {
  /** What each leg is handed: floor(budget × weight / 10_000), in the same raw units as the budget. */
  readonly sharesRaw: readonly bigint[];
  /** budget − Σ shares: what the split does not hand to anybody this turn. */
  readonly unspentRaw: bigint;
  /** The mints whose share floors to nothing. Non-empty means the turn buys NOTHING — see below. */
  readonly starvedMints: readonly string[];
}

/**
 * WHAT floor() IN legShare LEAVES UNSPENT, AND WHETHER A LEG CAN GET ZERO.
 *
 * THE REMAINDER IS BOUNDED BY THE LEG COUNT, NOT BY THE BUDGET. The weights sum
 * to exactly 10,000, so the EXACT shares sum to exactly the budget and the
 * unspent amount is the sum of the parts floor() cut off — each strictly under
 * one raw unit, so
 *
 *     0  ≤  unspent  ≤  legs − 1     raw units
 *
 * At the picker's five legs that is at most 4 raw USDC units: $0.000004 a turn,
 * at any budget. IT IS NOT LOST EITHER — it is USDC that stays in the vault and
 * is part of the next turn's budget. This function exists to SAY that number,
 * so that nobody later "fixes" the rounding by pushing the remainder onto a leg
 * and quietly signs a basket that is not the one on screen.
 *
 * CAN A LEG GET ZERO? Only absurdly far below any plausible budget.
 * floor(budget × w / 10_000) = 0 exactly when budget × w < 10_000, i.e.
 * budget < 10_000 / w raw units. At the lightest weight the program allows
 * (1 bps) that needs a budget under 10,000 raw = ONE CENT; at the lightest the
 * picker allows (whole percents, 100 bps) under 100 raw = $0.0001. Meanwhile
 * smallestLegalCap already forbids any cap under m × 10_000 / w_min, which at
 * the $5 minimum this product ships is dollars, not cents. So AT ANY BUDGET
 * THIS PRODUCT CAN REACH, no legal weight combination starves a leg: the
 * per-leg minimum bites first, by four or five orders of magnitude.
 *
 * WHAT THE UI MUST FORBID IS THEREFORE NOT THE ZERO SHARE. It is the 0 %
 * WEIGHT: set_invest_policy requires weight_bps > 0, so an asset the user
 * unticks must be REMOVED from the legs, never sent at zero. A picker that
 * "keeps" an unchosen row at 0 % builds a transaction the program rejects
 * outright, after Phantom has asked for a signature.
 *
 * AND IF A ZERO SHARE EVER DID HAPPEN IT WOULD NOT BE A SMALL LOSS. The swap
 * loop does skip a zero-amount leg — but invest-tick's all-or-nothing minimum
 * check runs BEFORE that skip, and a zero share is under any min_investment, so
 * the turn returns IDLE and the basket buys nothing at all. starvedMints is
 * reported for that reason, not because the money would be missed.
 *
 * Throws RangeError on illegal weights or a negative budget.
 */
export function floorLoss(budgetRaw: bigint, legs: readonly BasketLeg[]): FloorLoss {
  lightestLegalWeightBps(legs);
  if (budgetRaw < 0n) throw new RangeError("a budget cannot be negative");

  const total = BigInt(LEG_WEIGHT_TOTAL_BPS);
  const sharesRaw = legs.map((leg) => (budgetRaw * BigInt(leg.weightBps)) / total);
  const spent = sharesRaw.reduce((sum, share) => sum + share, 0n);
  const starvedMints = legs.filter((_, index) => sharesRaw[index] === 0n).map((leg) => leg.mint);
  return { sharesRaw, unspentRaw: budgetRaw - spent, starvedMints };
}
