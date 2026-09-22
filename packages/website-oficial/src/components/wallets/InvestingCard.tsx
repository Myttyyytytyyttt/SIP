"use client";

/**
 * INVESTING: the vault's investment policy, or the form that signs its first one.
 *
 * STATES. Loading: a skeleton. Unreadable (the route, the vault or the policy):
 * words, and never a form, because a policy may exist. No vault: "Create your
 * vault first." No policy: SIP's basket and its $5 rule, the two caps, today's
 * price limits, the rent, and the issuer's powers over SPYx with a box to tick
 * before Sign investment policy. A policy: on or paused, the floors it signed
 * against today's prices, its caps, what it used in the trailing 30 days and in
 * all, whether the next sweep can buy, and buttons to sign again at today's
 * prices or to pause and resume, each keeping the caps it has. Pause signs the
 * stored policy again with investing off and reads no price, so the owner can
 * stop investing when the pools cannot be priced; Sign again and Resume set
 * floors from today's prices.
 *
 * WHAT IS SIGNED is the build's floors, not the ones shown here before building:
 * the flow checks them against SIP's margins, and they are shown again while
 * Phantom asks.
 *
 * WHAT THIS CARD OFFERS, AND IN WHAT SHAPE. All four of the fields the owner
 * asked for are buildable, and the three that belong to the POLICY are wired
 * here; the fourth, the cap per settlement, is the VAULT's rule and lives on
 * VaultCard. investPolicy takes the two caps, the minimum per buy,
 * the basket weights and the venue (INVEST_POLICY_FIELDS in
 * solana-core/src/server/build-handler.ts), and the cap per settlement rides on
 * setPolicy, the vault's own rule. Each has exactly one accepted shape, and the
 * route refuses every other before it reads a single account:
 *  * MOST PER BUY and MOST PER 30 DAYS: decimal strings of USDC raw units; the
 *    route's decimalU64 refuses a float or a JS number outright, so no cap can
 *    arrive through a lossy double.
 *  * THE MINIMUM PER BUY: the same decimal string of USDC raw units. It is
 *    enforced PER LEG, which is what REACHABLE_PER_BUY_RAW below exists for.
 *  * THE BASKET WEIGHTS: {mint, weightBps} pairs, BY MINT and never positional,
 *    that must sum to exactly LEG_WEIGHT_TOTAL_BPS. Nothing is normalised or
 *    filled in for you, so Sign is gated on the sum.
 *  * THE VENUE: a NAME from the closed set the server itself serves
 *    (offeredVenues), never a program id from the browser.
 *  * THE CAP PER SETTLEMENT is NOT here: it is a VAULT field, carried by
 *    setPolicy, which writes all six of the vault's rule at once. It belongs
 *    beside the rest of that rule on VaultCard, not on the policy card.
 * route.test.ts pins every one of those shapes, so a change to the whitelist
 * turns it red rather than leaving this comment quietly wrong.
 *
 * AND THE ONE FIELD THAT MUST NEVER BECOME AN INPUT: min_convert_rate_wad. The
 * program does not validate it, and a zero there silently switches the
 * SOL-to-USDC conversion off. Nothing here can reach it — it is always
 * floorWad(the live pool price, CONVERT_FLOOR_MARGIN_BPS), and vault-flows.ts
 * refuses to sign a build whose convertWad is null, zero or not exactly that.
 * The card states its EFFECT in words beside the live price it came from
 * (INVEST_COPY.convertFloorEffect), which is as far as this should ever go.
 */

import {
  CONVERT_FLOOR_MARGIN_BPS,
  DEFAULT_INVEST_CAPS,
  LEG_FLOOR_MARGIN_BPS,
  LEG_WEIGHT_TOTAL_BPS,
  OFFERED_LEGS,
  SIGNATURE_FEE_LAMPORTS,
  TOKEN_PROGRAM,
  basketWeightsBps,
  defaultInvestPolicy,
  floorWad,
  investmentReadiness,
  isOfferable,
  ownerComputeBudget,
  priorityFeeLamports,
  usdcRawPer1e8LegRaw,
  usdcRawPerSol,
  type InvestmentReadiness,
} from "@sip/solana-core/client";
import { useState, type ReactNode } from "react";

import { Num } from "@/components/num";
import { BasketPicker } from "@/components/wallets/BasketPicker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { TxProgress } from "@/components/wallets/TxProgress";
import { useVaultWrite, type InvestRequest, type WriteProgress } from "@/hooks/use-vault-actions";
import { DEFAULT_VENUE_NAME, VERIFIABLE_VENUES } from "@/lib/vault-flows";
import { useVaultScreen } from "@/hooks/use-vault-state";
import { AmountError, USDC_DECIMALS, formatSol, formatUnits, formatUsd, parseUnits, rawFrom } from "@/lib/amounts";
import { LABEL } from "@/lib/classes";
import {
  PICKER_MAX_LEGS,
  basketLimits,
  catalogueAsset,
  evenPercents,
  lighterWeightBps,
  overCeiling,
  type BasketLimits,
  type PickedLeg,
  type PickedRow,
} from "@/lib/basket-picker";
import { floorDrift, todaysLimits, usedInLast30Days } from "@/lib/invest-limits";
import { floorsState } from "@/lib/live-model";
import type { InvestPolicyBuildJson, InvestmentPolicyJson, VaultStateJson } from "@/lib/vault-api";
import { INVEST_COPY, MAX_LEG_FEE_BPS, VAULT_COPY, listAnd, ratePercent, shortAddress, signedLegsOf } from "@/lib/vault-copy";

/** The write hook as this card holds it. Exported so a test can render PolicySetup directly with a stub. */
export type VaultWrite = ReturnType<typeof useVaultWrite>;

/** The caps a person typed, in USDC raw units, or why they cannot be signed. */
export type Caps = { readonly ok: true; readonly maxPerCall: bigint; readonly maxRolling30d: bigint } | { readonly ok: false; readonly message: string };

/**
 * THE BASKET THE FORM OPENS ON: every offered stock, at equal whole percents.
 *
 * WHOLE PERCENTS, not basketWeightsBps. That function divides 10,000 and hands
 * back 33.34 % at three legs, which no box on this card can hold and which the
 * server would be right to refuse as a fraction of a point nobody typed.
 * evenPercents divides 100 instead and puts the remainder on the first row, so
 * the sum is exactly 100 at every count the picker allows.
 */
export const DEFAULT_PICKED: readonly PickedRow[] = OFFERED_LEGS.map((leg, index) => ({ mint: leg.mint, percent: String(evenPercents(OFFERED_LEGS.length)[index]!) }));

/** The default basket as the arithmetic takes it: each offered leg at its equal share, in basis points. */
const defaultLegs = (): PickedLeg[] => OFFERED_LEGS.map((leg, index) => ({ asset: leg, weightBps: evenPercents(OFFERED_LEGS.length)[index]! * 100 }));

/**
 * THE WINDOW OF CAPS THE FORM OPENS ON, computed once for the default basket.
 *
 * The three constants below used to be three DIFFERENT KINDS of number pinned
 * at three different times, and only one of them could survive a picker:
 *  * REACHABLE_PER_BUY_RAW was arithmetic over the default basket's weights;
 *  * DEPTH_CEILING_PER_BUY_RAW was a LITERAL, 380_000_000n, written down from
 *    one reading of one Raydium pool on 2026-09-20 — a pool the keeper no
 *    longer trades through at all since the move to Jupiter;
 *  * SUGGESTED_PER_BUY_RAW was half of that literal.
 * They are all three the same computation now, run over the same catalogue
 * readings the picker runs it over, and they exist only as THE STARTING STATE
 * of a form whose every keystroke recomputes them. Nothing on this card reads
 * them again after the first render.
 */
const DEFAULT_WINDOW: BasketLimits = basketLimits(defaultLegs(), defaultInvestPolicy(OFFERED_LEGS.length).minInvestment);

/**
 * THE SMALLEST PER-BUY CAP THE DEFAULT BASKET CAN EVER BUY AT, in USDC raw units.
 *
 * min_investment is enforced PER LEG: an invest tick gives each leg its weight's
 * slice of the budget and refuses a slice under the minimum. So the bar is not
 * min_investment itself but the cap at which the LIGHTEST leg's slice clears it,
 * ⌈minInvestment × 10,000 / lightestWeightBps⌉ — the same arithmetic
 * investmentReadiness does when it calls a policy "reachable", rounded up the
 * same way, so the form and the summary cannot disagree.
 *
 * AT ONE LEG THE TWO NUMBERS COINCIDE, which is why comparing against
 * min_investment alone was invisible until the basket became two. At two equal
 * legs min_investment is $2.50 and a $2.50 cap hands each leg $1.25: a policy
 * that can never buy at any balance. The program does not refuse it — its only
 * rule is 0 < min_investment ≤ max_per_call — so without this bar the owner pays
 * the rent for a policy that is dead the moment it lands.
 *
 * IT IS A STARTING VALUE NOW, NOT THE BAR. The bar is recomputed from the
 * basket on screen, because the lightest weight is the owner's to type.
 */
export const REACHABLE_PER_BUY_RAW: bigint = DEFAULT_WINDOW.floorRaw;

/**
 * THE LARGEST PER-BUY CAP THE DEFAULT BASKET'S COUNTED ROUTES COVER, in USDC
 * raw units. IT IS NO LONGER A LITERAL.
 *
 * WHAT IT WAS AND WHY THAT COULD NOT STAND. 380_000_000n, being a fiftieth of
 * ANTHROPIC's pinned Raydium pool as read on 2026-09-20, doubled for two equal
 * legs and rounded down. Two separate things made it wrong rather than merely
 * stale. The keeper moved to Jupiter, so the pool it divided is not where a buy
 * lands — the same mint routed BisonFi + Manifest the next day. And the shares
 * became the owner's, so the ceiling stopped being a property of the product:
 * one leg at 50 % and the same leg at 20 % differ by two and a half times.
 *
 * WHAT IT IS NOW. min over the chosen legs of the largest cap whose share of
 * that leg still sits inside a fiftieth of what its ROUTE was counted to hold
 * (basket-limits.ts depthCeiling, over solana-core's routeCensus readings).
 * Exact on both sides: this cap passes the keeper's gate on those readings, and
 * one raw unit more fails the leg that set it.
 *
 * AND IT IS STILL A FORECAST. It divides a count taken on a named day against
 * a route Jupiter re-picks per quote. The gate that decides is the keeper's,
 * inside the turn, at the size that turn really spends. Null would mean a
 * chosen leg's route was never counted — impossible for today's shelf, and the
 * form says so rather than inventing a ceiling if it ever happens.
 */
export const DEPTH_CEILING_PER_BUY_RAW: bigint | null = DEFAULT_WINDOW.ceilingRaw;

/**
 * WHAT THE "Most per buy" BOX STARTS AT, in USDC raw units: half the ceiling,
 * never under the floor.
 *
 * NOT DEFAULT_INVEST_CAPS.maxPerCall, which is $1,000 — a cap this card's own
 * notice calls "nothing bought, no SOL converted, at any balance", and which
 * the form once pre-filled with Sign lit over 0.0117348 SOL of rent that does
 * not come back.
 *
 * HALF, NOT THE WHOLE. The ceiling itself leaves no cover for an ordinary day's
 * drift in the market it was counted from, and a ceiling shown as a starting
 * value is read as a target. The owner can still type anything inside the
 * capsWindow — this is where the box starts, not what it allows.
 */
export const SUGGESTED_PER_BUY_RAW: bigint = DEFAULT_WINDOW.suggestedRaw;

/**
 * A cap quoted in words has to round DOWN. formatUsd rounds to the nearer cent,
 * so a ceiling of $297.999999 prints as "$298.00" — and a sentence that tells
 * the owner to type "$298.00 or less" would then be telling him to type a cap
 * the chain refuses. Truncating to the cent first can only ever understate.
 */
export const atMostUsd = (raw: bigint): string => formatUsd(raw - (raw % 10_000n));

/**
 * A FLOOR QUOTED IN WORDS HAS TO ROUND THE OTHER WAY, and for the same reason
 * the ceiling rounds down.
 *
 * formatUsd rounds to the NEARER cent, so a floor of $47.571429 prints as
 * "$47.57" — and readCaps, which compares raw units, then refuses the $47.57
 * the sentence just asked for. Typing what the message says loops. Rounding UP
 * to the cent can only ever overstate a floor by less than a cent, which is a
 * cap that works; rounding down states one that does not.
 */
export const atLeastUsd = (raw: bigint): string => formatUsd(raw + ((10_000n - (raw % 10_000n)) % 10_000n));

/**
 * The two caps as typed, in dollars: at least `floorRaw` per buy, and at least
 * one buy per 30 days.
 *
 * `floorRaw` DEFAULTS TO THE DEFAULT BASKET'S FLOOR AND IS NOT A CONSTANT. The
 * smallest cap that can buy is ⌈min_investment × 10,000 / the lightest share⌉,
 * and with a picker every term of that is the owner's: five equal legs need
 * five times the minimum, one leg at 5 % needs twenty. The form passes the
 * floor computed from the basket on screen.
 */
export function readCaps(perBuyText: string, per30DaysText: string, floorRaw: bigint = REACHABLE_PER_BUY_RAW): Caps {
  try {
    const maxPerCall = parseUnits(perBuyText, USDC_DECIMALS, INVEST_COPY.mostPerBuy);
    const maxRolling30d = parseUnits(per30DaysText, USDC_DECIMALS, INVEST_COPY.mostPer30Days);
    // UP TO THE CENT, never to the nearest one: see atLeastUsd. This sentence
    // names a cap the owner is going to type, and the check it names is on the
    // raw units, so a figure a cent short is a refusal that repeats itself.
    if (maxPerCall < floorRaw || maxRolling30d < maxPerCall) return { ok: false, message: INVEST_COPY.capsProblem(atLeastUsd(floorRaw)) };
    return { ok: true, maxPerCall, maxRolling30d };
  } catch (error) {
    if (error instanceof AmountError) return { ok: false, message: error.message };
    throw error;
  }
}

/** The least one LEG may be given, as typed, in USDC raw units — or why it cannot be signed. */
export type Minimum = { readonly ok: true; readonly raw: bigint } | { readonly ok: false; readonly message: string };

/**
 * THE MINIMUM PER BUY, WHICH IS ENFORCED PER LEG.
 *
 * The program's only rule is 0 < min_investment <= max_per_call, so it would
 * accept a minimum that makes the policy unbuyable at the cap beside it — the
 * same trap REACHABLE_PER_BUY_RAW closes from the other side. Checked here
 * against the cap actually typed, so the two boxes cannot disagree.
 */
export function readMinimum(text: string, maxPerCall: bigint | null, weightsBps: readonly number[] = basketWeightsBps(OFFERED_LEGS.length)): Minimum {
  try {
    const raw = parseUnits(text, USDC_DECIMALS, INVEST_COPY.minPerBuy);
    if (raw <= 0n) return { ok: false, message: INVEST_COPY.minimumProblem };
    // Per LEG: the lightest leg's slice of the cap has to clear it — and the
    // lightest leg is whatever the picker's boxes say it is.
    if (maxPerCall !== null && weightsBps.length > 0) {
      const lightest = BigInt(Math.min(...weightsBps));
      if ((maxPerCall * lightest) / 10_000n < raw) return { ok: false, message: INVEST_COPY.minimumUnreachable(formatUsd(raw)) };
    }
    return { ok: true, raw };
  } catch (error) {
    if (error instanceof AmountError) return { ok: false, message: error.message };
    throw error;
  }
}

/** The basket as typed, by mint — or why it cannot be signed. */
export type Weights = { readonly ok: true; readonly byMint: ReadonlyMap<string, number> } | { readonly ok: false; readonly message: string };

/**
 * THE BASKET, BY MINT, SUMMING TO EXACTLY LEG_WEIGHT_TOTAL_BPS.
 *
 * NOTHING IS REPAIRED HERE, because nothing is repaired on the server either: a
 * sum of 9,999 is not normalised and a missing leg is not filled in at the
 * share that would make it work — each is a different basket from the one on
 * screen. Whole percentages only, which is what the boxes take; the server
 * takes basis points and this multiplies by 100, so a weight cannot arrive as
 * a fraction of a point nobody typed.
 */
export function readWeights(percents: readonly string[], legs: readonly { readonly mint: string; readonly symbol: string }[] = OFFERED_LEGS): Weights {
  const byMint = new Map<string, number>();
  let total = 0;
  // THE BASKET'S SIZE IS A RULE TOO, and both ends of it are refused here
  // rather than at Sign: the program takes at least one leg, and this product
  // offers at most five.
  if (legs.length === 0) return { ok: false, message: INVEST_COPY.basketEmpty };
  if (legs.length > PICKER_MAX_LEGS) return { ok: false, message: INVEST_COPY.basketTooMany(PICKER_MAX_LEGS, legs.length) };
  for (const [index, leg] of legs.entries()) {
    const text = (percents[index] ?? "").trim();
    if (!/^[0-9]{1,3}$/.test(text)) return { ok: false, message: INVEST_COPY.weightProblem(leg.symbol) };
    const bps = Number(text) * 100;
    if (bps <= 0) return { ok: false, message: INVEST_COPY.weightProblem(leg.symbol) };
    // A mint twice over is a basket the program refuses outright (its BTreeSet
    // insert fails), and the picker cannot produce one — but nothing else here
    // would notice, and the sum would still be 10,000.
    if (byMint.has(leg.mint)) return { ok: false, message: INVEST_COPY.weightProblem(leg.symbol) };
    byMint.set(leg.mint, bps);
    total += bps;
  }
  if (total !== LEG_WEIGHT_TOTAL_BPS) return { ok: false, message: INVEST_COPY.weightsSum(ratePercent(total)) };
  return { ok: true, byMint };
}

/**
 * Whether the setup form may ask Phantom: the issuer's powers acknowledged,
 * every field valid, the cap inside the capsWindow this basket can buy in, and no
 * other write in the way.
 *
 * WHY THE DEPTH CEILING GATES SIGN NOW, WHERE IT ONLY WARNED BEFORE. It warned
 * because it was a literal the page could not re-derive, and refusing on a
 * number you cannot defend is worse than saying it out loud. The page derives
 * it now, from the basket on screen and solana-core's dated route censuses, and
 * re-derives it on every keystroke. On those readings a cap above it does not
 * buy less — the keeper's depth gate is all-or-nothing, so it buys NOTHING, at
 * any balance, for the life of the policy, and the rent is spent either way.
 *
 * WHAT IS STILL NOT A GATE: a ceiling nobody could compute. A chosen leg whose
 * route has never been counted leaves depthOk true and puts a sentence on the
 * screen, because a refusal has to rest on a number.
 */
export const canSignPolicy = (input: {
  readonly acknowledged: boolean;
  readonly capsOk: boolean;
  readonly blocked: boolean;
  /** Default true, so the existing two-argument callers keep their meaning. */
  readonly minimumOk?: boolean;
  readonly weightsOk?: boolean;
  readonly depthOk?: boolean;
}): boolean =>
  input.acknowledged && input.capsOk && (input.minimumOk ?? true) && (input.weightsOk ?? true) && (input.depthOk ?? true) && !input.blocked;

/** What "Sign again" and "Resume" would re-sign, or why neither may be pressed. */
export type Resign =
  | { readonly ok: true; readonly weights: ReadonlyMap<string, number>; readonly minInvestment: bigint; readonly limits: BasketLimits }
  | { readonly ok: false; readonly message: string };

/**
 * WHAT THE TWO BUTTONS ON A SIGNED POLICY MAY DO, AND WHEN THEY MAY NOT.
 *
 * BOTH OF THEM RE-SIGN. "Sign again with today's prices" and "Resume investing"
 * are set_invest_policy, the same instruction the setup form builds, and they
 * used to send the two caps and NOTHING ELSE. Every other field was then filled
 * in by the build route's defaults — the WHOLE shelf at equal shares, at the
 * catalogue's split minimum (vault-flows.ts and build-handler.ts both, so the
 * server could not catch it either). On the live one-leg policy that is one
 * press away from a basket the owner never picked, while Pause three inches
 * away re-signs the stored legs correctly: pause-then-resume was not a round
 * trip, and nothing on the screen said so.
 *
 * SO THE STORED BASKET IS SENT BACK, BY MINT, WITH ITS OWN MINIMUM. And once it
 * is, the cap has to be judged against IT: the window a cap sits inside is a
 * function of the basket and the shares, so the $1,000 that was fine for one
 * SPYx leg hands a half-weighted ANTHROPIC $500 against a route counted at
 * $7,450, which the keeper's gate refuses — the whole basket, the SOL
 * conversion included, on every sweep, forever, with the rent spent again. The
 * setup form has refused exactly this since the picker landed. These two
 * buttons went around it, so they are held to the same arithmetic here.
 *
 * WHAT IT WILL NOT DO IS GUESS. A leg the catalogue no longer offers cannot be
 * re-signed (the request would silently drop it, which is a different basket),
 * an unreadable field is not defaulted, and in every refusal Pause still works
 * — it reads no price and re-signs exactly what is stored.
 */
/** A stored policy resolved back to catalogue legs, with the three figures it carries; or why it could not be read. */
type StoredBasket =
  | { readonly ok: true; readonly picked: readonly PickedLeg[]; readonly minInvestment: bigint; readonly maxPerCall: bigint }
  | { readonly ok: false; readonly message: string };

/**
 * HALF OF resignStoredPolicy, AND THE HALF THE EDIT FORM ALSO NEEDS: resolving
 * what is stored back to assets the shelf still offers, and reading its
 * amounts. It judges NOTHING — the floor and the ceiling stay in
 * resignStoredPolicy, because they are what the edit form exists to let the
 * owner change, and a cap that is over the ceiling is a thing the form must
 * SHOW him, not a reason to refuse him the form.
 *
 * Extracted rather than reimplemented so there is one answer to "can this
 * policy's basket be put back on a screen": two copies of this would drift on
 * the day the shelf drops an asset, and only one of them would be fixed.
 */
function storedBasket(policy: InvestmentPolicyJson): StoredBasket {
  const minInvestment = rawFrom(policy.minInvestment);
  const maxPerCall = rawFrom(policy.maxPerCall);
  if (minInvestment === null || maxPerCall === null || minInvestment <= 0n || maxPerCall <= 0n) return { ok: false, message: INVEST_COPY.resignUnreadable };
  if (!Array.isArray(policy.legs) || policy.legs.length === 0) return { ok: false, message: INVEST_COPY.resignUnreadable };

  const picked: PickedLeg[] = [];
  const missing: string[] = [];
  for (const leg of policy.legs) {
    const asset = catalogueAsset(leg.mint);
    // NOT OFFERED IS NOT THE SAME AS NOT KNOWN, and neither may be re-signed:
    // investPolicyFlow filters the weights to OFFERED_LEGS, so either one would
    // leave the request naming a shorter basket than the policy on screen.
    if (asset === null || !isOfferable(asset)) missing.push(asset?.symbol ?? shortAddress(leg.mint));
    else picked.push({ asset, weightBps: leg.weightBps });
  }
  if (missing.length > 0) return { ok: false, message: INVEST_COPY.resignUnoffered(listAnd(missing)) };
  return { ok: true, picked, minInvestment, maxPerCall };
}

/** The boxes and ticks an edit form opens on, taken from the policy the chain holds — or why the stored policy cannot be put back on this form. */
export type PolicySeed = {
  readonly picked: readonly PickedRow[];
  readonly perBuy: string;
  readonly per30Days: string;
  readonly minimum: string;
  readonly venue: string;
  readonly enabled: boolean;
};
export type PolicyEdit = ({ readonly ok: true } & PolicySeed) | { readonly ok: false; readonly message: string };

/**
 * THE STORED POLICY AS THE SETUP FORM'S OPENING STATE — the whole of the edit
 * path's new arithmetic, and it has none.
 *
 * It returns strings and rows, nothing else: the floor, the ceiling, the
 * window, the warnings and the Sign gate are all recomputed by the form from
 * these, on every keystroke, in the one place that has always computed them.
 * If this function did any arithmetic of its own it could disagree with the
 * form it seeds, which is the defect the single-form decision exists to avoid.
 *
 * THREE MISMATCHES BETWEEN WHAT IS STORED AND WHAT A BOX CAN HOLD:
 *  * WEIGHTS. The policy carries basis points; the boxes hold whole percents.
 *    A share that is not a multiple of 100 bps is REFUSED, never rounded — a
 *    rounded share is a basket the owner never chose, re-signed from a screen
 *    he opened to change something else.
 *  * THE VENUE. The policy carries a PROGRAM ID; the select holds a NAME. The
 *    look-up is over VERIFIABLE_VENUES, so a stored program this app cannot
 *    check the bytes of (the retired raydium-clmm) falls back to the default
 *    name rather than putting an id in the form.
 *  * enabled. PolicySetup signed `true` unconditionally, which is right for a
 *    first policy and would silently resume a PAUSED one. It travels.
 */
export function policyEditSeed(policy: InvestmentPolicyJson): PolicyEdit {
  const stored = storedBasket(policy);
  if (!stored.ok) return stored;
  const maxRolling30d = rawFrom(policy.maxRolling30d);
  if (maxRolling30d === null || maxRolling30d <= 0n) return { ok: false, message: INVEST_COPY.resignUnreadable };

  const picked: PickedRow[] = [];
  for (const leg of stored.picked) {
    if (leg.weightBps % 100 !== 0) return { ok: false, message: INVEST_COPY.editFractionalShare(leg.asset.symbol, ratePercent(leg.weightBps)) };
    picked.push({ mint: leg.asset.mint, percent: String(leg.weightBps / 100) });
  }
  const venue = [...VERIFIABLE_VENUES.entries()].find(([, program]) => program === policy.venueProgram)?.[0] ?? DEFAULT_VENUE_NAME;
  return {
    ok: true,
    picked,
    perBuy: formatUnits(stored.maxPerCall, USDC_DECIMALS),
    per30Days: formatUnits(maxRolling30d, USDC_DECIMALS),
    minimum: formatUnits(stored.minInvestment, USDC_DECIMALS),
    venue,
    enabled: policy.enabled,
  };
}

export function resignStoredPolicy(policy: InvestmentPolicyJson): Resign {
  const stored = storedBasket(policy);
  if (!stored.ok) return stored;
  const { picked, minInvestment, maxPerCall } = stored;

  let limits: BasketLimits;
  try {
    limits = basketLimits(picked, minInvestment);
  } catch {
    // basketLimits throws RangeError on weights the program would refuse. A
    // stored policy cannot hold any — the program checked them when it was
    // signed — so this is a policy that could not be read, not one to repair.
    return { ok: false, message: INVEST_COPY.resignUnreadable };
  }
  const weights = new Map(picked.map((leg) => [leg.asset.mint, leg.weightBps]));
  if (maxPerCall < limits.floorRaw) {
    return { ok: false, message: INVEST_COPY.resignBelowFloor(atLeastUsd(limits.floorRaw), limits.floorBinding?.symbol ?? picked[0]!.asset.symbol) };
  }
  if (limits.ceilingRaw !== null && limits.ceilingBinding !== null && (limits.empty || overCeiling(maxPerCall, limits))) {
    return {
      ok: false,
      message: INVEST_COPY.resignOverCeiling(atMostUsd(limits.ceilingRaw), limits.ceilingBinding.symbol, limits.ceilingBinding.readOn ?? "an unrecorded day"),
    };
  }
  return { ok: true, weights, minInvestment, limits };
}

// These two moved to src/lib/invest-limits.ts, where the live dashboard's rule
// card reads the same numbers; re-exported so this card's existing imports and
// its test are untouched.
export { todaysLimits, usedInLast30Days, type TodaysLimits } from "@/lib/invest-limits";

/**
 * TODAY'S PER-STOCK LIMITS, FOR THE STOCKS HE TICKED.
 *
 * todaysLimits prices the WHOLE shelf and takes no basket: the build reads
 * every offered leg's pool in one call and the page checks them all, which is
 * right. What was wrong was printing them all under a heading that reads as a
 * description of the policy being signed — a one-stock basket carried a limit
 * line for a stock that basket does not hold, which is the same defect the
 * approval paragraph had one screen later.
 *
 * IT FOLLOWS THE TICKS, NOT THE SHARES, like the paragraphs below it: a row
 * whose percentage box is still empty is a stock he has chosen, and its limit
 * is his to read while he types.
 */
export const pickedLegLimits = <T extends { readonly mint: string }>(legs: readonly T[], picked: readonly { readonly mint: string }[]): readonly T[] =>
  legs.filter((leg) => picked.some((asset) => asset.mint === leg.mint));

/** The rent a first policy costs: the policy account if missing, and each vault token account missing; null when any part is unknown. */
export function setupRent(state: VaultStateJson): bigint | null {
  const { rents } = state;
  if (rents === null || state.vaultTokenAccounts.status !== "exists") return null;
  let total = state.policy.status === "missing" ? rawFrom(rents.policy) : 0n;
  if (total === null) return null;
  for (const account of state.vaultTokenAccounts.items) {
    if (account.status === "exists") continue;
    if (account.status !== "missing") return null;
    const rent = rawFrom(account.tokenProgram === TOKEN_PROGRAM ? rents.tokenAccount : rents.legTokenAccounts[account.mint]);
    if (rent === null) return null;
    total += rent;
  }
  return total;
}

function readinessWords(readiness: InvestmentReadiness): string {
  if (readiness.state === "ready") return INVEST_COPY.ready;
  if (readiness.state === "waiting") return INVEST_COPY.waiting(formatUsd(readiness.investsAtRaw));
  return INVEST_COPY.unreachable;
}

/**
 * WHICH OF THE TWO SCREENS A VAULT WITH A POLICY IS SHOWING.
 *
 * LIFTED OUT OF THE JSX BECAUSE OF THIS SUITE'S SHAPE. Everything here renders
 * with renderToStaticMarkup in a node environment: no DOM, no act(), no
 * re-render, so the press that flips `editing` sets state nothing can observe.
 * A three-way condition inline would be a rule with a price on it that no case
 * could reach. As a function it is pinned, even though the click is not.
 *
 * THE TWO GUARDS BESIDE `editing`, and neither is decoration. `justSigned`: the
 * write that just landed REPLACED this policy, so leaving the form open over it
 * invites signing the same change twice. `seedable`: a stored policy the boxes
 * cannot hold — a share that is not a whole percent — has no opening state, and
 * a form opened on the shelf's defaults would offer to overwrite a live policy
 * with numbers the owner never chose.
 */
export const editScreen = (input: { readonly editing: boolean; readonly justSigned: boolean; readonly seedable: boolean }): "form" | "summary" =>
  input.editing && !input.justSigned && input.seedable ? "form" : "summary";

export function InvestingCard() {
  const screen = useVaultScreen();
  const write = useVaultWrite("policy");
  const [signing, setSigning] = useState<InvestRequest | "pause" | null>(null);
  // WHETHER THE OWNER IS CHANGING THE POLICY HE HAS. Declared with the other
  // hooks, above the early return: a hook after a conditional return is a hook
  // order that changes between renders.
  const [editing, setEditing] = useState(false);
  if (screen === null) return null;
  const { view } = screen;

  // An explicit object: the flow gets the caps shown, never a click event.
  const start = (input: InvestRequest): void => {
    setSigning(input);
    void write.investPolicy(input);
  };
  // The policy on screen, re-signed with investing off: no prices are read.
  const pause = (policy: InvestmentPolicyJson): void => {
    setSigning("pause");
    void write.pauseInvesting(policy);
  };
  const progress = (
    <TxProgress
      progress={write.progress}
      successLabel={INVEST_COPY.signed}
      onBuildAgain={() => void write.buildAgain()}
      onCheckAgain={() => void write.checkAgain()}
      onDismiss={() => {
        write.dismiss();
        // Dismissing a finished write leaves the summary, not the form: the
        // policy on screen is the one that just landed.
        setEditing(false);
      }}
      approveDetail={<SigningDetail progress={write.progress} request={signing} />}
    />
  );

  if (view.kind === "loading") {
    return (
      <Card aria-busy="true" aria-label={INVEST_COPY.title}>
        <CardHeader>
          <CardTitle>{INVEST_COPY.title}</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-20 w-full" />
        </CardContent>
      </Card>
    );
  }
  if (view.kind === "unreadable" || view.state.vault.status === "unreadable") return <Shell description={VAULT_COPY.unreadable} alert />;
  const { state } = view;
  if (state.vault.status === "missing") return <Shell description={INVEST_COPY.needsVault} />;
  if (state.policy.status === "unreadable" || (state.policy.status === "exists" && state.policy.state === undefined)) {
    return <Shell description={INVEST_COPY.policyUnreadable} alert>{write.progress.phase !== "idle" ? progress : null}</Shell>;
  }
  if (state.policy.status === "missing" || state.policy.state === undefined) return <PolicySetup state={state} write={write} start={start} progress={progress} />;

  // A POLICY EXISTS, SO THERE ARE TWO SCREENS AND ONE FORM. The seed is the
  // stored policy as the form's opening state; when it cannot be made — a
  // stored leg the shelf no longer offers, a share no box can hold — the
  // summary says so and leaves Sign-again and Pause alone.
  const stored = state.policy.state;
  const seed = policyEditSeed(stored);
  // The write that just landed replaced this policy, so the form is done with:
  // sitting in an edit form over a policy that no longer exists is how an owner
  // signs the same change twice.
  const justSigned = write.progress.phase === "finished" && write.progress.result.ok;
  return editScreen({ editing, justSigned, seedable: seed.ok }) === "form" && seed.ok ? (
    <PolicySetup state={state} write={write} start={start} progress={progress} seed={seed} onCancel={() => setEditing(false)} />
  ) : (
    <PolicySummary
      state={state}
      policy={stored}
      write={write}
      start={start}
      pause={pause}
      progress={progress}
      onEdit={seed.ok ? () => setEditing(true) : null}
      editProblem={seed.ok ? null : seed.message}
    />
  );
}

function Shell({ description, alert = false, children }: { readonly description: string; readonly alert?: boolean; readonly children?: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{INVEST_COPY.title}</CardTitle>
        <CardDescription role={alert ? "alert" : undefined}>{description}</CardDescription>
      </CardHeader>
      {children !== undefined && children !== null ? <CardContent>{children}</CardContent> : null}
    </Card>
  );
}

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="space-y-1">
      <dt className={LABEL}>{label}</dt>
      <dd>
        <Num>{children}</Num>
      </dd>
    </div>
  );
}

/**
 * What Phantom is asked to sign, from the checked build: its floors, and the
 * caps this card sent; or, for a pause, the policy as it is.
 *
 * EVERY FIGURE COMES FROM THE WADS THE FLOW CHECKED and the transaction
 * actually carries — never from the answer's own dollar fields
 * (floorUsdcRawPerSol, maxUsdcRawPer1e8, symbol). Those ride along beside the
 * wads and nothing holds them to each other, so a build could print a floor of
 * $90.03 over bytes that signed $0.00. The basket's names are SaverFi's own
 * OFFERED_LEGS, in the order the flow pinned them to.
 *
 * AND IT IS THE BASKET HE PICKED, NOT THE SHELF. The answer's `floors` block
 * prices the WHOLE shelf, in OFFERED_LEGS' order, because that is one pool read
 * either way — but the policy carries only the legs in `request.weights`
 * (vault-flows.ts and build-handler.ts both filter to them). This is the last
 * sentence the owner reads before Phantom, so a line here about a stock his
 * policy will not contain is a false statement at the worst possible moment:
 * it named an ANTHROPIC price ceiling over bytes that signed SPYx alone. The
 * floors are still read by INDEX into that block, and the lines are filtered by
 * MINT, so a leg cannot be printed against its neighbour's floor either.
 */
export function SigningDetail({ progress, request }: { readonly progress: WriteProgress; readonly request: InvestRequest | "pause" | null }) {
  if (progress.phase !== "running" || progress.built === null || request === null) return null;
  if (request === "pause") return <p className="font-normal text-foreground">{INVEST_COPY.pauseSigning}</p>;
  const floors = (progress.built as Partial<InvestPolicyBuildJson>).floors;
  const convertWad = rawFrom(floors?.convertWad);
  // A floor nobody can read is not guessed at: the progress says nothing rather
  // than a figure the bytes may not carry.
  if (floors === undefined || floors === null || convertWad === null || convertWad <= 0n) return null;
  const legs: string[] = [];
  for (const [index, leg] of OFFERED_LEGS.entries()) {
    const wad = rawFrom(floors.legs?.[index]?.wad);
    // A FLOOR THE BUILD DID NOT PRICE IS STILL FATAL, even for a leg this
    // policy does not hold: the flow checks the whole block before it signs, so
    // a missing wad anywhere means the answer is not the one that was checked.
    if (wad === null || wad <= 0n) return null;
    if (request.weights !== undefined && !request.weights.has(leg.mint)) continue;
    legs.push(INVEST_COPY.legSigning(leg.symbol, formatUsd(usdcRawPer1e8LegRaw(wad))));
  }
  // A basket with no line at all is not described in half: the weights named
  // nothing this app offers, and nothing here can say what is being signed.
  if (legs.length === 0) return null;
  return (
    <p className="font-normal text-foreground">
      {INVEST_COPY.youAreSigning(formatUsd(usdcRawPerSol(convertWad)), legs.join("; "), formatUsd(request.maxPerCall), formatUsd(request.maxRolling30d))}
    </p>
  );
}

function CapField({ id, label, value, onChange, disabled }: { readonly id: string; readonly label: string; readonly value: string; readonly onChange: (value: string) => void; readonly disabled: boolean }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">$</span>
        <Input id={id} inputMode="decimal" autoComplete="off" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} className="font-mono" />
        <span className="text-sm text-muted-foreground">USD</span>
      </div>
    </div>
  );
}

/**
 * THE POLICY FORM — for a vault that has never signed one AND for a vault
 * changing the one it has. ONE form, two opening states.
 *
 * `seed` IS THE ONLY DIFFERENCE, and it reaches nothing but the six useState
 * initializers below. Everything else in this component is derived from those
 * six and from `state` on every render, so seeding them seeds the window, the
 * floor, the ceiling, the warnings, the cost paragraphs and the Sign gate — all
 * of it, without a second copy of any of it. A second "edit" form would have
 * drifted from this one at the next arithmetic fix, and only one of the two
 * would have got it.
 *
 * THE INITIALIZERS ARE LAZY, WHICH IS LOAD-BEARING: the seed is read once, at
 * mount, so a background refresh of the policy cannot overwrite what the owner
 * is typing. The card mounts this subtree fresh when the edit starts.
 */
export function PolicySetup({
  state,
  write,
  start,
  progress,
  seed = null,
  onCancel,
}: {
  readonly state: VaultStateJson;
  readonly write: VaultWrite;
  readonly start: (input: InvestRequest) => void;
  readonly progress: ReactNode;
  /** The stored policy's own values, when this form was opened to change one; null for a first policy. */
  readonly seed?: PolicySeed | null;
  /** Back to the summary without signing. Absent when there is nothing to go back to. */
  readonly onCancel?: () => void;
}) {
  const [perBuy, setPerBuy] = useState(() => seed?.perBuy ?? formatUnits(SUGGESTED_PER_BUY_RAW, USDC_DECIMALS));
  const [per30Days, setPer30Days] = useState(() => seed?.per30Days ?? formatUnits(DEFAULT_INVEST_CAPS.maxRolling30d, USDC_DECIMALS));
  const [acknowledged, setAcknowledged] = useState(false);
  // The catalogue's own defaults, as the route would build them when these
  // fields are left alone: the $5-split minimum and equal shares.
  const [minimum, setMinimum] = useState(() => seed?.minimum ?? formatUnits(defaultInvestPolicy(OFFERED_LEGS.length).minInvestment, USDC_DECIMALS));
  // THE BASKET IS STATE NOW. The rows the owner ticked, in the order he ticked
  // them, each holding the percent he typed — not an array positional over the
  // catalogue, because the catalogue is longer than the basket.
  const [picked, setPicked] = useState<readonly PickedRow[]>(() => seed?.picked ?? DEFAULT_PICKED);
  // THE INTERSECTION, not the server's list: a name the web cannot check the
  // bytes of is never offered. See VERIFIABLE_VENUES in vault-flows.ts.
  const venues = (state.offeredVenues ?? []).filter((name) => VERIFIABLE_VENUES.has(name));
  const [venue, setVenue] = useState(() => seed?.venue ?? DEFAULT_VENUE_NAME);
  // WHICH OF THE TWO IS BEING SIGNED. A first policy is on; an edit keeps the
  // policy's own flag, so changing a PAUSED policy's basket does not quietly
  // turn investing back on — and the button says so.
  const enabled = seed?.enabled ?? true;

  const blocked = write.running || write.busyElsewhere || write.unconfirmed;
  // THE ORDER THESE ARE READ IN IS NOT FREE. The cap's own lower bound depends
  // on the minimum and on the lightest share, so the shares are read first, the
  // minimum second (on its own, before any cap), and the caps last, against the
  // floor those two produce. Reading the caps first was what let a constant
  // stand in for the floor.
  //
  // THE ROWS AND THEIR SHARES ARE CARRIED TOGETHER, never as two arrays read by
  // the same index. readWeights reads percents[i] against legs[i], so dropping
  // one row from one array and not the other would hand a stock the share of
  // the stock beside it — the sum would still be 100 and nothing would fail.
  const rows = picked.flatMap((row) => {
    const asset = catalogueAsset(row.mint);
    return asset === null ? [] : [{ asset, percent: row.percent }];
  });
  const chosenAssets = rows.map((row) => row.asset);
  const weightsTyped = readWeights(
    rows.map((row) => row.percent),
    chosenAssets,
  );
  const typedMinimum = readMinimum(minimum, null);
  const minimumRaw = typedMinimum.ok ? typedMinimum : null;
  const legs: PickedLeg[] | null = weightsTyped.ok ? chosenAssets.map((asset) => ({ asset, weightBps: weightsTyped.byMint.get(asset.mint)! })) : null;
  const capsWindow: BasketLimits | null = legs !== null && minimumRaw !== null && minimumRaw.ok ? basketLimits(legs, minimumRaw.raw) : null;
  const caps = readCaps(perBuy, per30Days, capsWindow?.floorRaw ?? REACHABLE_PER_BUY_RAW);
  const minPerLeg = readMinimum(minimum, caps.ok ? caps.maxPerCall : null, legs?.map((leg) => leg.weightBps));
  // OVER THE CEILING, OR NO CEILING AT ALL: both stop Sign, and neither is
  // silent about which leg did it or what would fix it.
  const overDepth = capsWindow !== null && caps.ok && (capsWindow.empty || overCeiling(caps.maxPerCall, capsWindow));
  // The third way out of a depth refusal, when the basket has room for one:
  // lighterWeightBps answers null in a one-stock basket, where the share is
  // 100 % by arithmetic and cannot be lowered at all.
  const lighter = capsWindow !== null && caps.ok ? lighterWeightBps(caps.maxPerCall, capsWindow) : null;
  const priceLimits = todaysLimits(state.prices);
  const rent = setupRent(state);
  const fees = SIGNATURE_FEE_LAMPORTS + priorityFeeLamports(ownerComputeBudget("set_invest_policy"));
  const floorText = priceLimits === null ? "today's floor" : formatUsd(priceLimits.floorPerSol);
  // "SPYx at 50 % and ANTHROPIC at 50 %", from the CHOSEN legs and their
  // weights — so the prose, the Basket field and the picker cannot say three
  // different things, which is what the prose and the field did while it named
  // SPYx alone.
  const basket = legs === null ? listAnd(chosenAssets.map((asset) => asset.symbol)) : listAnd(legs.map((leg) => `${leg.asset.symbol} at ${ratePercent(leg.weightBps)}`));
  const basketField = legs === null ? chosenAssets.map((asset) => asset.symbol).join(", ") : legs.map((leg) => `${leg.asset.symbol} · ${ratePercent(leg.weightBps)}`).join(", ");
  // WHAT THE SIGNED PARAGRAPHS ARE WRITTEN FROM: the ticked assets themselves,
  // with their own fee readings — never a hand-written pair of names. It
  // follows the TICKS and not the shares, so the issuer's powers and the fee
  // ceiling are described correctly while a percentage box is still empty.
  const copyLegs = signedLegsOf(chosenAssets);
  // The whole buy that clears the minimum on every leg: the floor, which is the
  // per-leg minimum multiplied up by the LIGHTEST share and not by the count.
  // EVERY FLOOR ON THIS CARD IS QUOTED UPWARDS, for atLeastUsd's reason: the
  // owner reads these three figures as "type this", and a floor a cent short of
  // itself is a cap readCaps then refuses.
  //
  // AND NULL WHERE IT USED TO SAY $5.00. The fallback was
  // formatUsd(DEFAULT_PURCHASE_USDC_RAW), the catalogue's flat $5 — the figure
  // for ONE leg, correct here only by the arithmetic coincidence that makes one
  // leg's floor equal the minimum. capsWindow is null whenever the shares or
  // the minimum are momentarily unreadable, which is most of a re-weight, so
  // the headline and the Rule fact would both blink back to a one-leg number
  // in the middle of the exact edit that makes it false.
  const purchaseText = capsWindow === null ? null : atLeastUsd(capsWindow.floorRaw);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{INVEST_COPY.title}</CardTitle>
        <CardDescription>
          {INVEST_COPY.policyRule(
            basket,
            floorText,
            purchaseText,
            caps.ok ? formatUsd(caps.maxPerCall) : `$${perBuy.trim()}`,
            caps.ok ? formatUsd(caps.maxRolling30d) : `$${per30Days.trim()}`,
            rent === null ? "some" : formatSol(rent),
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid gap-3 sm:grid-cols-2">
          <Fact label={INVEST_COPY.basket}>{basketField}</Fact>
          <Fact label={INVEST_COPY.rule}>{purchaseText === null ? INVEST_COPY.buysUnknown : INVEST_COPY.buysEach(purchaseText)}</Fact>
        </dl>

        {/* WHAT SIGNING FROM HERE DOES TO A POLICY THAT ALREADY EXISTS, and the
            one thing about it that reads as a bug if it is not said first: a
            thin stock pulls the cap down, so Sign can grey out the moment he
            ticks one. */}
        {seed === null ? null : <p className="text-xs text-muted-foreground">{INVEST_COPY.editingPolicy}</p>}

        {/* THE CATALOGUE AND THE SHARES, FIRST, in place of the fixed grid of
            one box per offered leg — and above the caps rather than below them,
            because the basket is what sets BOTH ends of the window those boxes
            have to sit in. Asking for a cap first and then explaining it with
            a basket further down the page is the wrong way round. The picker
            owns the rows and their percentages; the arithmetic they drive is
            rendered below, beside the boxes it binds. */}
        <BasketPicker picked={picked} onPicked={setPicked} blocked={blocked} problem={weightsTyped.ok ? null : weightsTyped.message} perBuyRaw={caps.ok ? caps.maxPerCall : null} />

        {/* THE WINDOW, ABOVE THE BOX IT CONSTRAINS AND NOT UNDER IT: both ends
            and whose market set the top, read BEFORE the cap is typed rather
            than as an explanation of a refusal afterwards. */}
        {capsWindow !== null && capsWindow.ceilingRaw !== null && capsWindow.ceilingBinding !== null && !capsWindow.empty ? (
          <p className="text-xs text-muted-foreground">
            {INVEST_COPY.capWindow(
              atLeastUsd(capsWindow.floorRaw),
              atMostUsd(capsWindow.ceilingRaw),
              capsWindow.ceilingBinding.symbol,
              capsWindow.ceilingBinding.readOn ?? "an unrecorded day",
              capsWindow.ceilingBinding.derived,
            )}
          </p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <CapField id="invest-max-per-call" label={INVEST_COPY.mostPerBuy} value={perBuy} onChange={setPerBuy} disabled={blocked} />
          <CapField id="invest-max-rolling" label={INVEST_COPY.mostPer30Days} value={per30Days} onChange={setPer30Days} disabled={blocked} />
        </div>
        {capsWindow !== null && capsWindow.uncounted.length > 0 ? (
          <p className="text-xs text-destructive">{INVEST_COPY.ceilingUnknown(listAnd(capsWindow.uncounted.map((leg) => leg.symbol)))}</p>
        ) : null}
        {!caps.ok ? (
          <p role="alert" className="text-xs text-destructive">
            {caps.message}
          </p>
        ) : (
          <>
            {/* NO CAP EXISTS AT ALL — the ceiling is under the floor. The fix is
                the basket, so no number is offered as one. */}
            {capsWindow !== null && capsWindow.empty && capsWindow.ceilingRaw !== null && capsWindow.ceilingBinding !== null ? (
              <p role="alert" className="text-xs text-destructive">
                {INVEST_COPY.capWindowEmpty(atLeastUsd(capsWindow.floorRaw), atMostUsd(capsWindow.ceilingRaw), capsWindow.ceilingBinding.symbol)}
              </p>
            ) : null}
            {capsWindow !== null && !capsWindow.empty && capsWindow.ceilingRaw !== null && capsWindow.ceilingBinding !== null && overCeiling(caps.maxPerCall, capsWindow) ? (
              <div className="space-y-1">
                <p role="alert" className="text-xs text-destructive">
                  {INVEST_COPY.depthWarning(
                    atMostUsd(capsWindow.ceilingRaw),
                    capsWindow.ceilingBinding.symbol,
                    capsWindow.ceilingBinding.readOn ?? "an unrecorded day",
                    lighter === null ? null : ratePercent(lighter),
                    capsWindow.ceilingBinding.derived,
                  )}
                </p>
                {/* THE FIX AS A PRESS, at the value the card would have started
                    on: half the ceiling, so it is not a new edge to sit on. */}
                <Button type="button" size="sm" variant="outline" disabled={blocked} onClick={() => setPerBuy(formatUnits(capsWindow.suggestedRaw, USDC_DECIMALS))}>
                  {INVEST_COPY.useSuggested(formatUsd(capsWindow.suggestedRaw))}
                </Button>
              </div>
            ) : null}
            {caps.maxPerCall > 1_000_000_000n ? <p className="text-xs text-destructive">{INVEST_COPY.convertWarning}</p> : null}
          </>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <CapField id="invest-min-investment" label={INVEST_COPY.minPerBuy} value={minimum} onChange={setMinimum} disabled={blocked} />
          {venues.length > 0 ? (
            <div className="space-y-1">
              <Label htmlFor="invest-venue">{INVEST_COPY.venueLabel}</Label>
              <select
                id="invest-venue"
                name="invest-venue"
                value={venue}
                disabled={blocked}
                onChange={(event) => setVenue(event.target.value)}
                className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm disabled:opacity-50"
              >
                {venues.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">{INVEST_COPY.venueHint}</p>
            </div>
          ) : null}
        </div>
        {/* THE BASKET'S OWN FIGURE, not a worked example of a basket he may not
            have. The hint named "twice this", which is the answer for two EQUAL
            legs and for nothing else: at 80/20 the bar is five times the
            minimum. purchaseText is ⌈min × 10,000 / the lightest share⌉ over
            the boxes as they stand. */}
        <p className="text-xs text-muted-foreground">{INVEST_COPY.minPerBuyHint(purchaseText, legs?.length ?? 0)}</p>
        {!minPerLeg.ok ? (
          <p role="alert" className="text-xs text-destructive">
            {minPerLeg.message}
          </p>
        ) : null}

        {/* THE CEILING IN FULL, with every figure computed from the basket
            above rather than from the night this block used to quote. It is
            only shown when there IS a ceiling: a basket whose routes nobody
            counted gets ceilingUnknown beside the caps instead, and inventing a
            number here would be the one error this whole feature exists to
            prevent. */}
        {capsWindow !== null && capsWindow.ceilingRaw !== null && capsWindow.ceilingBinding !== null ? (
          <div className="space-y-1 rounded-md border border-amber-600/30 bg-amber-600/5 px-3 py-2 text-xs">
            <div className={LABEL}>{INVEST_COPY.thinPoolTitle}</div>
            <p>
              {INVEST_COPY.thinPool(
                atMostUsd(capsWindow.ceilingRaw),
                formatUsd(capsWindow.suggestedRaw),
                capsWindow.ceilingBinding.symbol,
                capsWindow.ceilingBinding.readOn ?? "an unrecorded day",
                capsWindow.ceilingBinding.derived,
              )}
            </p>
          </div>
        ) : null}

        <div className="space-y-1 rounded-md border px-3 py-2 text-xs">
          <div className={LABEL}>{INVEST_COPY.floorsTitle}</div>
          {priceLimits === null ? (
            <p>{INVEST_COPY.pricesUnknown}</p>
          ) : (
            <>
              <p>{INVEST_COPY.solFloor(formatUsd(priceLimits.floorPerSol), formatUsd(priceLimits.todayPerSol))}</p>
              {/* THE TICKED STOCKS, NOT THE SHELF. todaysLimits prices every
                  offered leg — the build reads them all in one call and the
                  page checks them all — but a box headed "Today's price limits"
                  under a basket of one was printing a limit for a stock that
                  basket does not hold. It follows the TICKS, like the paragraphs
                  below it, so a row with an empty percentage box still has its
                  own limit shown. */}
              {pickedLegLimits(priceLimits.legs, chosenAssets).map((leg) => (
                <p key={leg.mint}>{INVEST_COPY.legCeiling(leg.symbol, formatUsd(leg.maxPer1e8))}</p>
              ))}
              <p className="text-muted-foreground">{INVEST_COPY.convertFloorEffect(ratePercent(CONVERT_FLOOR_MARGIN_BPS))}</p>
            </>
          )}
        </div>

        <p className="text-xs">{rent === null ? VAULT_COPY.costUnknown : VAULT_COPY.cost(formatSol(rent), formatSol(fees))}</p>

        <div className="space-y-1 rounded-md border px-3 py-2 text-xs">
          <div className={LABEL}>{INVEST_COPY.costTitle}</div>
          <p>{INVEST_COPY.issuerCost(copyLegs)}</p>
          <p>{INVEST_COPY.feeCeiling(copyLegs, ratePercent(MAX_LEG_FEE_BPS))}</p>
          <p>{INVEST_COPY.marketCost(copyLegs)}</p>
          <p>{INVEST_COPY.defencesLimits(copyLegs, ratePercent(LEG_FLOOR_MARGIN_BPS))}</p>
        </div>

        <div className="space-y-2 rounded-md border border-amber-600/30 bg-amber-600/5 px-3 py-2 text-xs">
          <p>{INVEST_COPY.freezeNotice(copyLegs)}</p>
          <p>{INVEST_COPY.issuerKeys(copyLegs)}</p>
          <p>{INVEST_COPY.hookSwitch(copyLegs)}</p>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              name="invest-acknowledge"
              checked={acknowledged}
              disabled={blocked}
              onChange={(event) => setAcknowledged(event.target.checked)}
              className="mt-0.5 size-4 shrink-0 accent-primary"
            />
            <span>{INVEST_COPY.acknowledge(copyLegs)}</span>
          </label>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            disabled={!canSignPolicy({ acknowledged, capsOk: caps.ok, minimumOk: minPerLeg.ok, weightsOk: weightsTyped.ok, depthOk: !overDepth, blocked })}
            aria-busy={write.running}
            onClick={() => {
              // THE SAME CONDITION AS THE BUTTON'S OWN, depth included. A guard
              // here that is weaker than the one that greys the button is how a
              // policy gets signed by a keypress on a disabled control.
              if (caps.ok && minPerLeg.ok && weightsTyped.ok && !overDepth && acknowledged) {
                start({
                  maxPerCall: caps.maxPerCall,
                  maxRolling30d: caps.maxRolling30d,
                  enabled,
                  minInvestment: minPerLeg.raw,
                  weights: weightsTyped.byMint,
                  // A NAME from the closed set, never a program id.
                  venue,
                });
              }
            }}
          >
            {write.running ? INVEST_COPY.signing : seed === null ? INVEST_COPY.sign : enabled ? INVEST_COPY.signChanges : INVEST_COPY.signChangesPaused}
          </Button>
          {/* THE WAY BACK. An edit that can only end in a signature is a trap:
              the owner who opened this to look at his shares has to be able to
              leave with the policy he already has. */}
          {onCancel === undefined ? null : (
            <Button type="button" variant="outline" disabled={blocked} onClick={onCancel}>
              {INVEST_COPY.keepWhatIHave}
            </Button>
          )}
        </div>
        {progress}
      </CardContent>
    </Card>
  );
}

function PolicySummary({
  state,
  policy,
  write,
  start,
  pause,
  progress,
  onEdit,
  editProblem,
}: {
  readonly state: VaultStateJson;
  readonly policy: InvestmentPolicyJson;
  readonly write: VaultWrite;
  readonly start: (input: InvestRequest) => void;
  readonly pause: (policy: InvestmentPolicyJson) => void;
  readonly progress: ReactNode;
  /** Open the form on this policy; null when the stored policy cannot be put back on it. */
  readonly onEdit: (() => void) | null;
  /** Why not, when onEdit is null. */
  readonly editProblem: string | null;
}) {
  const limits = todaysLimits(state.prices);
  // The live rule card reads the same state, so the two cannot disagree about
  // whether a floor has been passed.
  const { storedConvert, liveConvert, legs, pricesKnown, belowMarket } = floorsState(policy, state.prices);

  const maxPerCall = rawFrom(policy.maxPerCall) ?? 0n;
  const maxRolling30d = rawFrom(policy.maxRolling30d) ?? 0n;
  const minInvestment = rawFrom(policy.minInvestment) ?? 0n;
  const usdcHeld = state.holdings.status === "exists" ? state.holdings.items.filter((item) => item.mint === policy.inMint).reduce((total, item) => total + (rawFrom(item.amountRaw) ?? 0n), 0n) : null;
  // THE THRESHOLD IS A FACT ABOUT THE POLICY, NOT ABOUT THE BALANCE. It is
  // ⌈min_investment × 10,000 / the LIGHTEST weight⌉ — $5 for one leg, $25 for
  // the same $5 minimum at 80/20 — and investmentReadiness is the one place
  // that computes it, so the summary, the form and the keeper cannot disagree.
  // Read at a zero balance too, so a vault whose holdings are unreadable is
  // still told what it buys at rather than told nothing.
  const basketReadiness = investmentReadiness(usdcHeld ?? 0n, policy.legs, minInvestment, maxPerCall);
  const readiness = usdcHeld === null ? null : basketReadiness;
  const blocked = write.running || write.busyElsewhere || write.unconfirmed;
  // THE PARAGRAPHS ARE ABOUT THIS POLICY'S LEGS, resolved back to their
  // catalogue readings. A mint the catalogue does not know is left out rather
  // than described from nothing.
  const policyLegs = signedLegsOf(
    legs.flatMap((leg) => {
      const asset = catalogueAsset(leg.mint);
      return asset === null ? [] : [asset];
    }),
  );

  // ── HOW FAR EACH SIGNED FLOOR HAS DRIFTED ──────────────────────────────────
  //
  // Signed once, from one pool's price, and untouched since. The card already
  // showed the half that is loud — a floor the market has PASSED stops every
  // buy and flips the badge — and said nothing about the half that is quiet: a
  // floor the market has left far behind still permits a fill at a price
  // nobody would take today. Both are listed here, in the owner's terms,
  // before the caps and the buttons rather than under them.
  //
  // THE DAY HE SIGNED IS NOT KNOWN AND IS NOT GUESSED. InvestmentPolicy carries
  // no timestamp (solana-program state.rs), so null is passed and the sentence
  // says so; what IS on the page is the floor and the rate just read, and the
  // drift is arithmetic over those two.
  // WHAT THE TWO RE-SIGNING BUTTONS WOULD BUILD, or why neither may be pressed:
  // the stored basket and its own minimum, judged against the same floor and
  // depth ceiling the setup form judges a new one by.
  const resign = resignStoredPolicy(policy);

  const solDrift = floorDrift(storedConvert, liveConvert, CONVERT_FLOOR_MARGIN_BPS);
  const driftLines: string[] = [];
  if (solDrift !== null && storedConvert !== null && liveConvert !== null) {
    if (solDrift.kind === "passed") driftLines.push(INVEST_COPY.solFloorPassed(formatUsd(usdcRawPerSol(storedConvert)), formatUsd(usdcRawPerSol(liveConvert))));
    else if (solDrift.kind === "slack")
      driftLines.push(INVEST_COPY.solFloorSlack(formatUsd(usdcRawPerSol(storedConvert)), formatUsd(usdcRawPerSol(liveConvert)), ratePercent(solDrift.driftBps)));
  }
  for (const leg of legs) {
    const drift = floorDrift(leg.floor, leg.live, LEG_FLOOR_MARGIN_BPS);
    if (drift === null || leg.floor === null || leg.live === null) continue;
    const limit = formatUsd(usdcRawPer1e8LegRaw(leg.floor));
    const today = formatUsd(usdcRawPer1e8LegRaw(leg.live));
    if (drift.kind === "passed") driftLines.push(INVEST_COPY.legFloorPassed(leg.symbol, limit, today));
    else if (drift.kind === "slack") driftLines.push(INVEST_COPY.legFloorSlack(leg.symbol, limit, today, ratePercent(drift.driftBps)));
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{INVEST_COPY.title}</CardTitle>
        <CardDescription>{policy.enabled ? INVEST_COPY.enabled : INVEST_COPY.paused}</CardDescription>
        {pricesKnown ? (
          <CardAction>
            <Badge variant={belowMarket ? "outline" : "destructive"}>{belowMarket ? INVEST_COPY.floorsBelowMarket : INVEST_COPY.floorPassed}</Badge>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        {pricesKnown && !belowMarket ? (
          <p role="status" className="text-xs text-destructive">
            {INVEST_COPY.marketPast}
          </p>
        ) : null}
        {/* BEFORE IT BITES: the drift sits above the caps and the buttons, not
            under the stored numbers it is about. */}
        {driftLines.length > 0 ? (
          <div className="space-y-1 rounded-md border border-amber-600/30 bg-amber-600/5 px-3 py-2 text-xs">
            <div className={LABEL}>{INVEST_COPY.floorDriftTitle}</div>
            <p>{INVEST_COPY.floorDriftSigned(null)}</p>
            {driftLines.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
        ) : null}
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Fact label={INVEST_COPY.basket}>{legs.map((leg) => `${leg.symbol} · ${ratePercent(leg.weightBps)}`).join(", ")}</Fact>
          <Fact label={INVEST_COPY.mostPerBuy}>{formatUsd(maxPerCall)}</Fact>
          <Fact label={INVEST_COPY.mostPer30Days}>{formatUsd(maxRolling30d)}</Fact>
          <Fact label={INVEST_COPY.usedLast30}>{formatUsd(usedInLast30Days(policy.bucketDays, policy.bucketAmounts, Date.now() / 1_000))}</Fact>
          <Fact label={INVEST_COPY.lifetime}>{formatUsd(rawFrom(policy.lifetimeInvested) ?? 0n)}</Fact>
        </dl>
        <div className="space-y-1 text-xs">
          {storedConvert !== null && storedConvert > 0n ? (
            <p>{INVEST_COPY.storedSolFloor(formatUsd(usdcRawPerSol(storedConvert)), limits === null ? null : formatUsd(limits.todayPerSol))}</p>
          ) : null}
          {legs.map((leg) =>
            leg.floor !== null && leg.floor > 0n ? (
              <p key={leg.mint}>{INVEST_COPY.storedLegCeiling(leg.symbol, formatUsd(usdcRawPer1e8LegRaw(leg.floor)), leg.today === null ? null : formatUsd(leg.today))}</p>
            ) : null,
          )}
        </div>
        {readiness !== null ? (
          <p className="text-xs">{readinessWords(readiness)}</p>
        ) : basketReadiness !== null ? (
          <p className="text-xs">{INVEST_COPY.buysEach(formatUsd(basketReadiness.investsAtRaw))}</p>
        ) : null}
        <p className="text-xs text-muted-foreground">{INVEST_COPY.freezeShort(policyLegs)}</p>
        {/* WHY A REFUSAL CAN SIT HERE AND PAUSE STILL WORK. Both re-signing
            buttons build set_invest_policy from today's prices and the stored
            basket, so they are held to the same window the setup form is held
            to; Pause reads no price and re-signs the stored bytes as they are,
            so it is never blocked by an arithmetic about buying. */}
        {!resign.ok ? (
          <p role="alert" className="text-xs text-destructive">
            {resign.message}
          </p>
        ) : null}
        {/* WHY THE EDIT PATH HAS ITS OWN REFUSAL AND NOT resign's. They ask two
            different questions: resign asks whether the STORED cap may be
            re-signed as it stands, which a cap over today's ceiling may not —
            and that is precisely the owner who most needs the form. This one
            asks only whether the stored basket can be put back into the boxes
            at all. */}
        {editProblem === null ? null : (
          <p role="alert" className="text-xs text-destructive">
            {editProblem}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {/* THE GAP THIS CLOSES: an owner who had signed could reach neither
              the picker nor a single one of the four numbers below it. Both
              buttons beside this one re-sign what is already stored; this is
              the only one that lets him sign something else. */}
          <Button type="button" size="sm" disabled={blocked || onEdit === null} onClick={() => onEdit?.()}>
            {INVEST_COPY.editBasket}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={blocked || !resign.ok}
            aria-busy={write.running}
            onClick={() => {
              // THE SAME CONDITION AS THE BUTTON'S OWN. And the stored basket
              // travels with the caps: without weights and minInvestment the
              // route rebuilds the WHOLE shelf at equal shares.
              if (resign.ok) start({ maxPerCall, maxRolling30d, enabled: policy.enabled, minInvestment: resign.minInvestment, weights: resign.weights });
            }}
          >
            {INVEST_COPY.signAgain}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={blocked || (!policy.enabled && !resign.ok)}
            onClick={() => {
              if (policy.enabled) pause(policy);
              else if (resign.ok) start({ maxPerCall, maxRolling30d, enabled: true, minInvestment: resign.minInvestment, weights: resign.weights });
            }}
          >
            {policy.enabled ? INVEST_COPY.pause : INVEST_COPY.resume}
          </Button>
        </div>
        {policy.enabled ? <p className="text-xs text-muted-foreground">{INVEST_COPY.pauseKeeps}</p> : null}
        <p className="text-xs text-muted-foreground">{INVEST_COPY.noRefill}</p>
        {progress}
      </CardContent>
    </Card>
  );
}
