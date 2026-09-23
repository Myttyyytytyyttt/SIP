// The impure half of the depth gate: one leg, one route, one measurement.
//
// THE SPLIT IS THE POINT. Every VERDICT lives in invest-decision.ts, where it
// is a pure function of numbers a test can write down — the census, the two
// implied rates, the ceilings. This file only fetches: it quotes the turn,
// quotes a probe, reads the accounts the route names, and hands the numbers
// over. Nothing here decides whether a basket is bought.
//
// WHY THAT MATTERS AND IS NOT TIDINESS. The cases this gate exists for are a
// drained venue at $5 and a re-routed probe, and neither can be produced on
// demand against a live API. They are written as pure cases against
// legDepthDecision and censusVenueInventory instead, at exact raw amounts taken
// from the 2026-09-20 measurement. A gate whose judgement only ran behind a
// network call would be a gate whose judgement was never tested.
//
// ONE REFUSAL DOES LIVE HERE, and only because it is about a disagreement
// between two reads rather than about a number: see the
// slippage-not-above-transfer-fee check in measureLegVenue.
//
// THE RAYDIUM ADAPTER IS GONE, 2026-09-23, and this is where it was. It read a
// CLMM PoolState at four offsets, worked out which vault held the side a buy is
// paid in, and censused it: raydiumLegVenue, raydiumSides, decodeRaydiumPoolPair,
// the four POOL_TOKEN_* offsets, and vaultOwnedAmong. It existed to carry the
// vault across a migration it could not skip: venue_program is ONE field on the
// owner-signed InvestmentPolicy, so moving to Jupiter takes the OWNER's
// signature, and retiring the Raydium read before that would have left real
// money trading with no depth check at all.
//
// THAT WINDOW IS SHUT. The owner re-signed onto Jupiter v6 on 2026-09-22
// (CHANGELOG.md), but the adapter would be unreachable whatever a policy names:
// ROUTABLE_VENUES holds Jupiter v6 alone, and a Raydium venue_program hits
// RETIRED_VENUES and is REFUSED, with the vault's money untouched, before
// anything is measured. Refused under a Raydium policy, bypassed under a
// Jupiter one — which is what makes it dead rather than dormant. An adapter
// with no possible caller is not a spare tyre; it is a second description of
// how to trade that no test of the real path can ever contradict. If Raydium
// is ever routed directly again, the census it fed is venue-agnostic and the
// offsets are in clmm-layout: what comes back is one adapter, not this file's
// whole other half.
//
// WHAT KEPT IT ALIVE WAS A TEST IN ANOTHER PACKAGE, from the move to Jupiter on
// 2026-09-21 until this deletion two days later. The web's pool panel
// (solana-core/src/server/readers.ts) genuinely still reads Raydium pools — for
// one venue's own depth, published beside the price it takes from the same
// pool — and solana-core's readers.test.ts held its offsets against this
// file's by READING THIS FILE AS TEXT: a regex pulled the four offsets out, and
// two expressions had to appear verbatim. So the live reader was pinned to the
// dead one, and deleting dead code broke a green test in a package that does
// not import this one. The offsets now live in @sip/solana-program/clmm-layout,
// which solana-core and this package both already depend on, and readers.ts
// and live-route.ts both import them — the fix docs/TESTING_TRAPS.md files
// under "a test that pins another package by its text". Nothing here needs
// them, so nothing here has them.

import { Connection, PublicKey } from "@solana/web3.js";
import {
  type AgeTolerance,
  type JupiterQuote,
  type JupiterRoute,
  buildJupiterRoute,
  fetchJupiterQuote,
  findVaultOwnedTokenAccounts,
  routeMints,
  routeWarning,
} from "./program-scripts.js";
import {
  type ImpactProbe,
  type InventoryCensus,
  type LegVenue,
  type LegVenueHop,
  type VenueAccount,
  censusVenueInventory,
  impliedRateWad,
  legSlippageBps,
  maxTurnImpactBps,
  probeAmount,
  takeAtProbeRate,
  venueImpactBps,
} from "./invest-decision.js";
import { JUPITER_CALLS_PER_QUOTE, JUPITER_CALLS_PER_ROUTE_BUILD, jupiterCalls } from "./sweep-cost.js";

/** A leg this turn refuses outright, before any verdict is reached. */
export class VenueMeasurementRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VenueMeasurementRefusal";
  }
}

/** The ORDERED list of venue accounts a quote's hops trade against, as Jupiter names them. */
export function ammKeysOf(quote: JupiterQuote): string[] {
  return quote.routePlan.map((step) => step.swapInfo.ammKey ?? "");
}

/** The labels a quote's hops carry, for a refusal a human has to act on. */
export function labelsOf(quote: JupiterQuote): string[] {
  return quote.routePlan.map((step) => step.swapInfo.label ?? "an unnamed venue");
}

/**
 * Whether two quotes went through the same venues, in the same order.
 *
 * ORDERED, NOT A SET. USDC -> X -> Y and USDC -> Y -> X touch the same two AMMs
 * and are not the same route; comparing sets would let ARM 2 divide a rate
 * taken on one path by a rate taken on another and call the difference impact.
 *
 * AN EMPTY ammKey NEVER MATCHES ANYTHING, including another empty one: a hop
 * Jupiter did not name is a hop we cannot say is the same hop.
 */
export function sameVenues(turn: readonly string[], probe: readonly string[]): boolean {
  if (turn.length !== probe.length || turn.length === 0) return false;
  return turn.every((key, index) => key.length > 0 && key === probe[index]);
}

/**
 * ARM 2 for one leg: the turn's implied rate against a sixteenth-sized probe's,
 * both from ONE source in ONE instant.
 *
 * WHAT IT CAN AND CANNOT SEE. It sees liquidity that is not where a count of
 * units suggests — a Meteora DLMM holding 1,000 of the target in bins far from
 * the price passes ARM 1 at 1000x cover and degrades 400 bps here. It CANNOT
 * see a uniformly bad price: both numerator and denominator come from the same
 * quoter in the same instant, so a market quoted 30 % off divides out. That is
 * the whole reason §0 of invest-decision.ts names the price defences elsewhere.
 */
export function impactFrom(input: {
  readonly turnIn: bigint;
  readonly turnOut: bigint;
  readonly probeIn: bigint;
  readonly probeOut: bigint;
  readonly turnAmms: readonly string[];
  readonly probeAmms: readonly string[];
  readonly turnLabels: readonly string[];
  readonly probeLabels: readonly string[];
  readonly slippageBps: bigint;
  readonly feeBps: bigint;
}): ImpactProbe {
  if (!sameVenues(input.turnAmms, input.probeAmms)) {
    // AN ABSTENTION, NOT A REFUSAL, AND NOT A PASS. Jupiter re-picks venues per
    // quote: measured 2026-09-21 in one instant, a 25 USD USDC -> ANTHROPIC
    // turn routed Kipseli + Manifest while the 1 USD probe routed
    // Byreal + Manifest. A gate that refused on that would refuse routinely,
    // and a gate that refuses routinely is a gate an operator turns off. ARM 1
    // then carries the leg alone — and legDepthDecision refuses outright when
    // ARM 1's scope is partial too, because that is the one case in which
    // NOTHING measured the turn.
    return {
      compared: false,
      why:
        `the probe routed through ${input.probeLabels.join(" + ")} and the turn through ` +
        `${input.turnLabels.join(" + ")}, so the two rates are not two sizes of one venue`,
    };
  }
  if (input.probeIn >= input.turnIn) {
    return { compared: false, why: `the turn is ${input.turnIn} raw, no larger than the ${input.probeIn} raw probe, so there is no size to compare` };
  }
  return {
    compared: true,
    impactBps: venueImpactBps(impliedRateWad(input.turnIn, input.turnOut), impliedRateWad(input.probeIn, input.probeOut)),
    ceilingBps: maxTurnImpactBps(input.slippageBps, input.feeBps),
  };
}

/**
 * ARM 1's censuses, ONE PER MINT THE ROUTE PAYS US, and the scope that
 * describes them.
 *
 * `swapInfo.outAmount` IS WHAT A HOP TAKES OUT OF ITS VENUE, which is the
 * number the cover is measured against. When it is absent, that hop is NOT
 * censused and the scope degrades to "final-only" — an honest narrower claim
 * rather than a hop silently counted as taking nothing, which would read as
 * infinite cover. THE FINAL HOP IS ALWAYS CENSUSED: without it the leg has no
 * measurement at all, and censusVenueInventory then returns counted:false,
 * which legDepthDecision refuses on.
 *
 * ── WHY PER MINT AND NOT PER STEP ───────────────────────────────────────────
 *
 * A routePlan IS NOT ALWAYS A CHAIN. Jupiter's other shape is a PARALLEL SPLIT:
 * every step's outputMint is the target, each carries its own `percent`, and
 * they are alternatives rather than a sequence. Measured live on 2026-09-21,
 * USDC -> FIGUREAI at $5,000 came back as Raydium CLMM 4 % + Hadron 94 % +
 * Manifest 2 %.
 *
 * ONE STEP AT A TIME WAS THE WRONG QUESTION FOR THAT SHAPE, AND IT INVERTED THE
 * GATE. censusVenueInventory counts every writable non-vault account holding
 * the mint, which on a split is ALL THREE VENUES' payout accounts; asking it
 * once per sliver compared three venues' inventory against one venue's 4 %
 * share. Replayed through this very composition, the Raydium hop's real 1.81x
 * cover of its own pool read as 1,199.77x and the turn spent. Summing the takes
 * the same way the inventory is summed reads 48.06x on the same route and
 * refuses it.
 *
 * TWO SMALLER THINGS FALL OUT OF THE SAME LINE. censusScope no longer says
 * "every-hop" about a census nothing hop-wise was taken of, and the "final hop"
 * is no longer whichever sliver Jupiter happened to list last — on a split that
 * was a 2 % share standing in for the whole leg.
 */
export function censusHops(input: {
  readonly quote: JupiterQuote;
  readonly inputMint: PublicKey;
  readonly targetMint: PublicKey;
  readonly candidates: readonly VenueAccount[];
  readonly writable: ReadonlySet<string>;
  readonly vaultOwned: ReadonlySet<string>;
  /**
   * The least this turn may be judged to take of the TARGET mint, whatever the
   * route quoted: takeAtProbeRate of the probe. Absent when no probe answered.
   */
  readonly takeFloorRaw?: bigint;
}): { readonly hops: LegVenueHop[]; readonly censusScope: "every-hop" | "final-only" } {
  const plan = input.quote.routePlan;
  /** One entry per mint the route pays us, in the order the mints first appear. */
  const groups = new Map<string, { readonly payMint: PublicKey; labels: string[]; take: bigint }>();
  let every = true;
  let finalUnreadable: string | null = null;

  for (const [index, step] of plan.entries()) {
    const last = index === plan.length - 1;
    const label = step.swapInfo.label ?? "an unnamed venue";
    // The LAST hop pays us the target mint by definition; an intermediate pays
    // us whatever its own outputMint says, and a hop that names neither cannot
    // be censused at all.
    const payMint = last ? input.targetMint : step.swapInfo.outputMint === undefined ? null : new PublicKey(step.swapInfo.outputMint);
    const takeRaw = step.swapInfo.outAmount === undefined ? null : BigInt(step.swapInfo.outAmount);
    if (payMint === null || takeRaw === null) {
      // Unrepresentable as a pass: the target mint always produces a hop entry,
      // and one whose final step could not be read is one whose census did not
      // count — whatever the other slivers of a split said.
      if (last) finalUnreadable = `reported no out-amount for its ${label} hop, so what it would take out of that venue is unknown`;
      every = false;
      continue;
    }
    const name = payMint.toBase58();
    const group = groups.get(name) ?? { payMint, labels: [], take: 0n };
    group.labels.push(label);
    group.take += takeRaw;
    groups.set(name, group);
  }

  const target = input.targetMint.toBase58();
  if (finalUnreadable !== null && !groups.has(target)) groups.set(target, { payMint: input.targetMint, labels: [], take: 0n });

  const hops: LegVenueHop[] = [];
  for (const [name, group] of groups) {
    const label = group.labels.length > 0 ? [...new Set(group.labels)].join(" + ") : "an unnamed venue";
    if (name === target && finalUnreadable !== null) {
      hops.push({ label, payMint: group.payMint, takeRaw: group.take, census: { counted: false, why: finalUnreadable } });
      continue;
    }
    // THE FLOOR IS THE TARGET MINT'S ALONE. The probe quotes the leg end to
    // end, so its rate says what the turn should take OUT; it says nothing
    // about an intermediate mint, and inventing a number for one would be the
    // stand-in docs/TESTING_TRAPS.md is about.
    const floored = name === target && input.takeFloorRaw !== undefined && input.takeFloorRaw > group.take;
    hops.push({
      label,
      payMint: group.payMint,
      takeRaw: floored ? input.takeFloorRaw! : group.take,
      ...(floored ? { quotedTakeRaw: group.take } : {}),
      census: censusVenueInventory({ payMint: group.payMint, candidates: input.candidates, writable: input.writable, vaultOwned: input.vaultOwned }),
    });
  }
  return { hops, censusScope: every ? "every-hop" : "final-only" };
}

/** Every account a route names, read from the chain in pages of 100. */
export async function readRouteAccounts(connection: Connection, addresses: readonly PublicKey[]): Promise<VenueAccount[]> {
  const unique = [...new Map(addresses.map((address) => [address.toBase58(), address])).values()];
  const found: VenueAccount[] = [];
  for (let offset = 0; offset < unique.length; offset += 100) {
    const page = unique.slice(offset, offset + 100);
    const infos = await connection.getMultipleAccountsInfo(page, "confirmed");
    infos.forEach((info, index) => {
      // AN ACCOUNT THAT DID NOT COME BACK IS LEFT OUT, never defaulted to an
      // empty one: a census over accounts we could not read must come up short
      // and refuse, not read as a venue holding nothing (which refuses too) or
      // as one we measured (which does not).
      if (info === null) return;
      found.push({ address: page[index]!, owner: info.owner, data: info.data });
    });
  }
  return found;
}

/**
 * WHERE THE WARNING BECOMES A REFUSAL.
 *
 * legSlippageBps makes this unreachable by construction, and that is exactly
 * why reaching it is worth refusing on: buildJupiterRoute reads the destination
 * mint's transfer-fee config ITSELF, so a warning here means THE FEE THE SIZING
 * USED AND THE FEE THE BUILDER READ DISAGREE. One of the two is about a
 * different epoch or a different mint, and neither is a basis on which to spend
 * the owner's money.
 *
 * MEASURED ACROSS THE 1038 -> 1039 BOUNDARY: at equality Jupiter reverts the
 * CPI with its own 0x1771 (6001) at 5, 25 and 250 USD — one raw unit short,
 * because Jupiter floors its deduction and Token-2022 ceils its fee — and fills
 * only once the slippage is strictly above the fee. jupiter-route.ts leaves
 * this a WARNING because it cannot know whether the AMM that makes the final
 * transfer quotes gross or net; the keeper can refuse, because it would rather
 * miss a sweep than sign a transaction it has measured reverting.
 *
 * PURE, so the refusal can be tested without a route: the network half of this
 * file cannot be pointed at a 100-over-100 quote on demand.
 */
export function slippageRefusal(
  warning: { readonly slippageBps: number; readonly transferFeeBps: number; readonly usableToleranceBps: number } | null,
  context: { readonly targetMint: PublicKey; readonly askedBps: bigint; readonly feeBps: bigint },
): string | null {
  if (warning === null) return null;
  return (
    `${context.targetMint.toBase58()} quoted at ${warning.slippageBps} bps of slippage against a ` +
    `${warning.transferFeeBps} bps transfer fee, leaving ${warning.usableToleranceBps} bps of usable tolerance. ` +
    `This keeper asked for ${context.askedBps} bps (legSlippageBps of a ${context.feeBps} bps fee), so the fee the ` +
    "sizing used and the fee the route builder read DISAGREE — refusing rather than spending on a quote at a margin " +
    "measured to revert with Jupiter's 0x1771 at 5, 25 and 250 USD"
  );
}

/**
 * One leg's Jupiter route, and everything the depth gate needs to judge it.
 *
 * READ-ONLY, ALL OF IT. Two quotes, one /swap-instructions, and account reads.
 * Nothing is signed, nothing is sent, and the route it returns is the one the
 * caller will actually use — measured and used are the same object, which is
 * the only way the gate's guarantee survives the trip to the send.
 */
export async function measureLegVenue(
  connection: Connection,
  params: {
    readonly vault: PublicKey;
    readonly vaultIn: PublicKey;
    readonly vaultTarget: PublicKey;
    readonly inputMint: PublicKey;
    readonly targetMint: PublicKey;
    readonly spend: bigint;
    /** The destination mint's live transfer fee, in bps. Zero for the wSOL -> USDC convert. */
    readonly feeBps: bigint;
    readonly maxAge: AgeTolerance;
    readonly ownerFloorRateWad?: bigint;
  },
): Promise<{ readonly route: JupiterRoute; readonly venue: LegVenue }> {
  // STRICTLY ABOVE THE FEE, DECIDED BEFORE THE QUOTE IS ASKED FOR. This is the
  // single wider re-quote the 100-over-100 revert calls for: the keeper never
  // takes a quote at a margin measured to be fatal, so there is nothing to
  // re-quote afterwards.
  const slippageBps = legSlippageBps(params.feeBps);

  // COUNTED BEFORE THE CALL, NOT AFTER IT. Jupiter's 30-a-minute keyless limit
  // is spent by the REQUEST, so a build that throws — a 429, a timeout — has
  // cost the budget just as surely as one that answered, and a counter that
  // only counted successes would under-report exactly when the keeper was being
  // throttled. It counts and decides nothing: see src/sweep-cost.ts.
  jupiterCalls.count(JUPITER_CALLS_PER_ROUTE_BUILD);
  const route = await buildJupiterRoute(connection, {
    vault: params.vault,
    vaultIn: params.vaultIn,
    vaultTarget: params.vaultTarget,
    inputMint: params.inputMint,
    targetMint: params.targetMint,
    amountIn: params.spend,
    slippageBps: Number(slippageBps),
    maxAge: params.maxAge,
    ...(params.ownerFloorRateWad === undefined ? {} : { ownerFloorRateWad: params.ownerFloorRateWad }),
  });

  // WHERE THE WARNING BECOMES A REFUSAL.
  //
  // The line above makes this unreachable by construction, and that is exactly
  // why reaching it is worth refusing on: the builder reads the destination
  // mint's transfer-fee config itself, so a warning here means THE FEE THE
  // SIZING USED AND THE FEE THE BUILDER READ DISAGREE. One of the two is about
  // a different epoch or a different mint, and neither is a basis on which to
  // spend the owner's money. Measured across the 1038 -> 1039 boundary: at
  // equality Jupiter reverts the CPI with 0x1771 at 5, 25 and 250 USD, and
  // fills only once the slippage is above the fee.
  const tooTight = slippageRefusal(routeWarning(route, "slippage-not-above-transfer-fee"), {
    targetMint: params.targetMint,
    askedBps: slippageBps,
    feeBps: params.feeBps,
  });
  if (tooTight !== null) throw new VenueMeasurementRefusal(tooTight);

  const quote = route.quote;
  const turnAmms = ammKeysOf(quote);
  const turnLabels = labelsOf(quote);

  // THE PROBE IS A QUOTE AND NOTHING MORE. It is never posted to
  // /swap-instructions: nothing is ever built from it, so it costs one GET and
  // can never be mistaken for a route.
  const probeIn = probeAmount(params.spend);
  let impact: ImpactProbe;
  // THE PROBE'S RATE OUTLIVES ARM 2's VERDICT ON IT, deliberately. ARM 2
  // abstains when the probe took other venues, because two rates off two paths
  // are not one venue at two sizes. takeAtProbeRate asks a different question —
  // what this turn should take OUT — and a second opinion from other venues is
  // a better answer to it, not a worse one. So this is captured whenever the
  // probe answered at all, and only `impact` depends on the venues matching.
  let takeFloorRaw: bigint | undefined;
  try {
    // The probe spends the budget too, and it is the call most likely to be the
    // one refused: it is the last of the three this leg makes.
    jupiterCalls.count(JUPITER_CALLS_PER_QUOTE);
    const probe = await fetchJupiterQuote({
      inputMint: params.inputMint,
      outputMint: params.targetMint,
      amountIn: probeIn,
      slippageBps: Number(slippageBps),
    });
    takeFloorRaw = takeAtProbeRate(params.spend, BigInt(probe.inAmount), BigInt(probe.outAmount));
    impact = impactFrom({
      turnIn: BigInt(quote.inAmount),
      turnOut: BigInt(quote.outAmount),
      probeIn: BigInt(probe.inAmount),
      probeOut: BigInt(probe.outAmount),
      turnAmms,
      probeAmms: ammKeysOf(probe),
      turnLabels,
      probeLabels: labelsOf(probe),
      slippageBps,
      feeBps: params.feeBps,
    });
  } catch (error) {
    // A PROBE THAT DID NOT ANSWER IS AN ABSTENTION, NOT A FAILED TURN. ARM 1 is
    // the load-bearing arm and has already been measured off the turn's own
    // route; losing ARM 2 to a 429 must not refuse a basket that is fine, and
    // must not pass one that is not — legDepthDecision's fourth refusal is what
    // makes the difference when ARM 1's scope is partial as well.
    impact = { compared: false, why: `the probe quote did not answer: ${error instanceof Error ? error.message : String(error)}` };
  }

  // THE RESOLVED ACCOUNT LIST, NOT THE MESSAGE'S STATIC KEYS. A v0 message
  // hides half its accounts in address lookup tables, so compiling first and
  // reading `staticAccountKeys` would census a route while blind to the very
  // accounts the tables carry — which on a 2-hop ANTHROPIC route is 18 of 32.
  // `remainingAccounts` is the full list, with the route's own writability.
  const metas = route.remainingAccounts;
  const writable = new Set(metas.filter((meta) => meta.isWritable).map((meta) => meta.pubkey.toBase58()));
  const candidates = await readRouteAccounts(connection, metas.map((meta) => meta.pubkey));
  // routeMints, not the two ends: both of findVaultOwnedTokenAccounts' passes
  // are blind to an intermediate they were never handed, and an intermediate
  // ATA the vault owns is exactly the account that would inflate the census.
  const vaultOwned = await findVaultOwnedTokenAccounts(
    connection,
    params.vault,
    metas.map((meta) => meta.pubkey.toBase58()),
    routeMints(quote, params.inputMint, params.targetMint),
  );

  const { hops, censusScope } = censusHops({
    quote,
    inputMint: params.inputMint,
    targetMint: params.targetMint,
    candidates,
    writable,
    vaultOwned,
    ...(takeFloorRaw === undefined ? {} : { takeFloorRaw }),
  });

  return {
    route,
    venue: { mint: params.targetMint, spend: params.spend, venueLabels: turnLabels, hops, censusScope, impact },
  };
}

/** Re-exported so a caller need not know which half a type came from. */
export type { InventoryCensus, LegVenue };
