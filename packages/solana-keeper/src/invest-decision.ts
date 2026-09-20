// Which in-asset this keeper can invest from, whether it may invest at all,
// whether it may convert the vault's SOL to get there, whether an independent
// oracle still agrees with the pool that conversion would price against, how
// much of that SOL one turn may wrap and convert, whether the 30-day cap leaves
// the basket room, and whether every leg's mint is one the program can buy at
// all, as pure decisions, with the alerts for a crank or an investment that
// stays stuck.
//
// NEW IN SIP. sip-vault's InvestmentPolicy pins `in_mint`: the only mint convert
// may fill into and invest may spend from, chosen by the owner, with every floor
// and cap in the policy denominated in it. Nuvem's keeper hardcoded USDC and
// never looked. Against a policy pinned to anything else it would have wrapped
// and market-sold the vault's SOL toward USDC, and convert would then have been
// refused on chain with WrongInMint — the SOL exposure gone, nothing bought.
//
// The keeper has routes for exactly one in-asset (the wSOL/USDC pool and USDC
// pools per leg), so any other in_mint is refused BEFORE anything moves, naming
// both mints so the operator can see which side must change.

import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import type { InvestmentPolicyState } from "./accounts.js";
import type { Alert } from "./alerts.js";
import type { InvestOutcome } from "./invest-tick.js";
import { NO_TRANSFER_FEE, type TransferFeeTerms } from "./min-out.js";
import { olderPublishTime, pythPublishAgeSeconds, solUsdcPythRateWad, type PythPriceUpdate } from "./pyth.js";

/** USDC on mainnet: the only in-asset the keeper has routes for. */
export const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

export function inMintDecision(inMint: PublicKey): { readonly outcome: "REFUSED"; readonly detail: string } | null {
  if (inMint.equals(USDC_MINT)) return null;
  return {
    outcome: "REFUSED",
    detail:
      `the policy's in_mint is ${inMint.toBase58()}, but the only in-asset this keeper has routes for is USDC ` +
      `(${USDC_MINT.toBase58()}) — refusing to wrap, convert or invest toward it`,
  };
}

/**
 * Whether either pause switch stops this investment turn, decided before any
 * balance, ATA or wrap.
 *
 * THE VAULT'S OWN SWITCH WAS THE DANGEROUS ONE. convert and invest always refused
 * a paused vault (VaultPaused), but wrap_sol once checked only the protocol switch
 * — so a keeper that did not look would wrap a paused vault's free SOL, have the
 * convert refused, and leave the owner's SOL sitting as wSOL that only
 * withdraw_token recovers, again on every sweep. wrap_sol refuses a paused vault
 * too now; resting here first still spares a failed transaction. A paused vault
 * is a RESTING state: nothing is wrapped or bought, and nothing is alerted as a
 * failure.
 */
export function investPauseDecision(input: {
  readonly vaultPaused: boolean;
  readonly protocolPaused: boolean;
}): { readonly outcome: "PAUSED"; readonly detail: string } | null {
  if (!input.vaultPaused && !input.protocolPaused) return null;
  const switches = [
    input.vaultPaused ? "the vault's owner paused it (wrap_sol, convert and invest refuse with VaultPaused)" : null,
    input.protocolPaused ? "the protocol's authority paused every vault (wrap_sol, convert and invest refuse with ProtocolPaused)" : null,
  ].filter((part): part is string => part !== null);
  return { outcome: "PAUSED", detail: `${switches.join(" and ")} — nothing is wrapped, converted or bought` };
}

/** Whether a turn may wrap and convert; when it may not, why, in words for the turn's detail. */
export type ConvertDecision = { readonly convert: true } | { readonly convert: false; readonly detail: string };

/**
 * Whether this investment turn may wrap and convert the vault's SOL, decided
 * from the policy alone, before any ATA or wrap.
 *
 * A ZERO FLOOR MEANS THE OWNER NEVER TURNED CONVERSION ON, and wrap_sol and
 * convert both refuse it with FloorTooLow: "accept any price" is not a policy.
 * The tick once checked only `enabled` before wrapping, so a vault whose owner
 * enabled investing without ever signing a conversion floor had its ATAs
 * re-created and a refused wrap_sol sent on every sweep, reported as FAILED.
 *
 * NOT A REFUSAL. The owner chose to keep the SOL as SOL, and USDC already in
 * the vault is still invested against the legs as usual, so the turn goes on
 * without wrap and convert, says so in its detail, and alerts nobody.
 */
export function convertDecision(policy: { readonly minConvertRateWad: bigint }): ConvertDecision {
  if (policy.minConvertRateWad > 0n) return { convert: true };
  return {
    convert: false,
    detail:
      "conversion is off: the policy's min_convert_rate_wad is 0, which wrap_sol and convert refuse with FloorTooLow, " +
      "so the vault's SOL is not wrapped or converted and only USDC already in the vault is invested",
  };
}

// ── the oracle beside the pool, before the SOL hop ───────────────────────────

/**
 * The most seconds a Pyth publish may sit behind the CHAIN's clock before this
 * keeper stops pricing the SOL hop against it: 60.
 *
 * MEASURED, NOT GUESSED. Both feeds publish every 8-10 s, and the pair reads
 * 14-15 s old at the vault — the receiver posts, and the account is read a slot
 * or two later — so a 5 s bound would refuse every turn there has ever been and
 * convert nothing again, ever. 60 s is four times the worst age measured and
 * about six missed publishes in a row: ordinary jitter, a slow slot, a leader
 * change and a congested block all pass, and a feed that has genuinely stopped
 * is caught inside a minute. 120 s is where a bound stops being defensible —
 * two minutes of unnoticed staleness is already more SOL movement than the
 * deviation bound below tolerates — so this sits at half of it.
 *
 * A PUBLISH AHEAD OF THE CHAIN'S CLOCK IS NOT REFUSED. The age is signed, and
 * it goes negative when the cluster's stake-weighted clock is the thing that
 * has drifted, not the feed. That price is FRESHER than this keeper can
 * measure, and refusing it would turn a chain-wide clock drift into a product
 * that has stopped converting — the failure this whole guard is written not to
 * cause. The deviation bound is what catches a wrong price; this catches a
 * stopped one.
 */
export const MAX_PYTH_AGE_SECONDS = 60n;

/**
 * How far the captured route's realised rate may sit from the oracle's before
 * the SOL hop is skipped: 500 bps, RELATIVE, in either direction.
 *
 * RELATIVE OR NOTHING. An absolute USD band is a claim about today's SOL price,
 * and the price moves; a band written at $100 is a 1 % guard at $100 and a 10 %
 * guard at $1,000. The two rates are compared as bps of the ORACLE rate, so the
 * bound means the same thing at every price this product will ever see.
 *
 * TIGHTER THAN THE FLOOR IT BACKS. The convert floor the owner signs sits 1000
 * bps under the live pool price (CONVERT_FLOOR_MARGIN_BPS in the web's
 * product.ts), so a guard at or above 1000 bps could never fire before the
 * floor already had, and would be decoration.
 *
 * LOOSER THAN THE HONEST GAP. What is compared is not two mid prices. The route
 * side is ONE REAL PAST SWAP's realised rate, already below mid by the pool's
 * own fee and by that swap's price impact, and captured up to a few minutes ago
 * — live-route.ts walks back pages of signatures to find it. Pool fee, impact
 * and a few minutes of SOL movement together stay well inside 1 %, so 5 % fires
 * on a pool that has been moved away from the world and on nothing else.
 */
export const MAX_PYTH_DEVIATION_BPS = 500n;

/**
 * The rate a captured swap actually traded at, as USDC raw per lamport x 1e18 —
 * the unit both the policy's convert floor and the oracle speak, so the three
 * numbers compare with no display price entering any of them.
 *
 * NULL WHEN THERE IS NOTHING TO IMPLY ONE. live-route.ts reports `observed` only
 * for a swap that went the SAME WAY as ours (inverting an opposite-direction
 * swap's rate crosses the spread and flatters us), and min-out.ts already falls
 * back to the owner's floor in that case. The deviation arm falls silent the
 * same way rather than comparing against a number nobody measured.
 */
export function routeRateWad(observed: { readonly inRaw: bigint; readonly outRaw: bigint } | null): bigint | null {
  if (observed === null || observed.inRaw <= 0n || observed.outRaw <= 0n) return null;
  return (observed.outRaw * 10n ** 18n) / observed.inRaw;
}

/**
 * Whether the SOL-to-USDC hop may be priced against this pool at all, from the
 * two Pyth feeds and the rate the captured route implies.
 *
 * THE SAME TAGGED UNION convertDecision RETURNS, deliberately: a bad oracle
 * reading is not a failure and not a refusal of the turn. It is the same rest
 * as an owner who never signed a conversion floor — the SOL stays SOL, the USDC
 * the vault already holds is still invested against the basket, nobody is
 * paged, and the detail says why the SOL did not move. A STALLED ORACLE MUST
 * NOT BECOME A STALLED PRODUCT: nothing in here can return FAILED, REFUSED, or
 * anything that stops the sweep, and that is the whole shape of it.
 *
 * WHY AN ORACLE AT ALL, WHEN THE POOL IS THE VENUE. min-out.ts draws its
 * slippage bound from the pool's own captured swap, so a pool whose price has
 * been pushed somewhere absurd prices its own bound, agrees with itself, and
 * the swap passes every check this keeper makes. The floor underneath it is the
 * owner's, and it is deliberately loose — 1000 bps under the pool price the day
 * it was signed, and untouched since. Pyth is the only number in the turn that
 * does not come from the venue being traded against.
 *
 * `routeWad` IS `null` WHEN THERE IS NOTHING TO COMPARE — the route has not
 * been captured yet, or the capture was an opposite-direction swap whose rate
 * live-route.ts refuses to invert. The freshness arms still decide; the
 * deviation arm cannot, and says nothing rather than guessing. That is what
 * lets invest-tick.ts ask this the same question twice: once before the wrap,
 * when only the feeds are known, and once with the route in hand.
 */
export function oracleConvertDecision(input: {
  readonly sol: PythPriceUpdate | null;
  readonly usdc: PythPriceUpdate | null;
  /** The CHAIN's unix_timestamp, out of the Clock sysvar — never this host's wall clock. */
  readonly nowUnixSeconds: bigint;
  /** USDC raw per lamport x 1e18, as the captured swap actually traded, or null. */
  readonly routeWad: bigint | null;
}): ConvertDecision {
  const { sol, usdc, nowUnixSeconds, routeWad } = input;
  const rest = "so the SOL hop is skipped this turn and only the USDC the vault already holds is invested";

  if (sol === null || usdc === null) {
    const missing = [sol === null ? "SOL/USD" : null, usdc === null ? "USDC/USD" : null].filter((feed): feed is string => feed !== null);
    return {
      convert: false,
      detail:
        `the Pyth ${missing.join(" and ")} feed${missing.length === 1 ? "" : "s"} could not be read — absent, not owned by ` +
        `the receiver program, or not carrying the feed id it was fetched for — ${rest}`,
    };
  }

  const age = pythPublishAgeSeconds(olderPublishTime(sol, usdc), nowUnixSeconds);
  if (age > MAX_PYTH_AGE_SECONDS) {
    return {
      convert: false,
      detail:
        `the Pyth pair's stalest publish is ${age} s behind the chain's clock, past the ${MAX_PYTH_AGE_SECONDS} s this ` +
        `keeper will price a swap on (SOL/USD at ${sol.publishTime}, USDC/USD at ${usdc.publishTime}, chain clock ` +
        `${nowUnixSeconds}) — ${rest}`,
    };
  }

  let oracleWad: bigint;
  try {
    oracleWad = solUsdcPythRateWad(sol, usdc);
  } catch (error) {
    // A feed that decodes but quotes zero, a negative price or an absurd
    // exponent is as unusable as one that did not decode at all.
    return {
      convert: false,
      detail: `the Pyth pair carries no usable rate: ${error instanceof Error ? error.message : String(error)} — ${rest}`,
    };
  }

  // Nothing to compare against: the deviation arm has no opinion, and the two
  // arms above have already had theirs.
  if (routeWad === null || routeWad <= 0n) return { convert: true };

  const gap = routeWad > oracleWad ? routeWad - oracleWad : oracleWad - routeWad;
  const deviationBps = (gap * 10_000n) / oracleWad;
  if (deviationBps > MAX_PYTH_DEVIATION_BPS) {
    return {
      convert: false,
      detail:
        `the pool and the oracle disagree by ${deviationBps} bps, past the ${MAX_PYTH_DEVIATION_BPS} bps this keeper ` +
        `will sell SOL across: the captured route implies ${routeWad} USDC raw per lamport x 1e18 and Pyth says ` +
        `${oracleWad} — ${rest}`,
    };
  }
  return { convert: true };
}

/**
 * Below this, free SOL is not wrapped: three pool fees and three transaction
 * fees to move dust is a worse outcome for the owner than waiting for the next
 * settlement. The 0.005 SOL the tick has always used.
 */
export const WRAP_DUST_LAMPORTS = 5_000_000n;

/**
 * What the crank keeps back from fronting a wrap: 0.02 SOL, the line the
 * crank-low alert draws. Its own rent floor and the fees of the turn come out
 * of it. It does NOT cover a first basket's token-account rent, which is spent
 * after the wrap has already paid the crank back.
 */
export const CRANK_WRAP_RESERVE_LAMPORTS = 20_000_000n;

/** How much of a vault's free SOL one turn wraps, and whether the crank had to leave some behind. */
export interface WrapPlan {
  /** The vault's lamports above its rent floor, never below zero: wrap_sol saturates the same way. */
  readonly free: bigint;
  /** What the crank can front: its balance less CRANK_WRAP_RESERVE_LAMPORTS, never below zero. */
  readonly allowance: bigint;
  /** What the turn wraps: the smaller of the two, and nothing below WRAP_DUST_LAMPORTS. */
  readonly amount: bigint;
  /** The vault holds wrap-worthy free SOL that the crank cannot front in full. */
  readonly short: boolean;
}

/**
 * How much free SOL one turn may wrap: min(free, crank − 0.02 SOL).
 *
 * THE CRANK FRONTS EVERY WRAP. wrap_sol's first step is a System transfer of
 * `amount` from the crank into the vault's wSOL account; only its third step
 * debits the vault to pay the crank back (wrap_sol.rs). A crank holding less
 * than `amount` fails that transfer before any reimbursement exists. The tick
 * once wrapped the vault's whole free balance, so a vault holding more than the
 * settle key's own SOL — one large settlement, several wallets settling in one
 * sweep, SOL sent straight to the PDA — had its wrap refused on every sweep,
 * and nothing was wrapped, converted or invested until an operator funded the
 * hot key above the largest vault: the balance a key leak would expose.
 *
 * A SLICE PER TURN INSTEAD. The wrap pays the crank back inside the same
 * instruction, so the crank's balance bounds one wrap and not the vault's
 * savings; the rest waits for later sweeps. `short` says so, and a crank that
 * stays short is alerted on rather than left to fall behind in silence.
 */
export function wrapPlan(input: { readonly free: bigint; readonly crankLamports: bigint }): WrapPlan {
  const free = input.free > 0n ? input.free : 0n;
  const allowance =
    input.crankLamports > CRANK_WRAP_RESERVE_LAMPORTS ? input.crankLamports - CRANK_WRAP_RESERVE_LAMPORTS : 0n;
  const fronted = free < allowance ? free : allowance;
  return {
    free,
    allowance,
    amount: fronted < WRAP_DUST_LAMPORTS ? 0n : fronted,
    short: free >= WRAP_DUST_LAMPORTS && free > allowance,
  };
}

/** What a turn found and did about the wrap, carried on its result for the wrap-short alert. */
export interface WrapReport {
  readonly free: bigint;
  readonly allowance: bigint;
  /** Lamports the turn wrapped; in a dry run, the lamports it would wrap. */
  readonly wrapped: bigint;
  readonly short: boolean;
}

/** Consecutive short turns before a vault's wrap-short alert fires. */
export const WRAP_SHORT_ALERT_STREAK = 3;

/** A vault's count of consecutive short turns, after one more turn. */
export function wrapShortStreak(previous: number, short: boolean): number {
  return short ? previous + 1 : 0;
}

/**
 * The alert for a crank that stays short of a vault, or null until it has.
 *
 * NOT ON THE FIRST SHORT TURN. One large settlement is wrapped in slices over a
 * few sweeps, and that is the clamp working. Three turns in a row is a crank
 * that is not keeping up — and one inside its reserve wraps nothing at all,
 * while crank-low stays silent until the crank is below the reserve itself.
 */
export function wrapShortAlert(vault: string, streak: number, wrap: WrapReport): Alert | null {
  if (streak < WRAP_SHORT_ALERT_STREAK) return null;
  return {
    key: `wrap-short:${vault}`,
    severity: "warn",
    title: "A vault holds more free SOL than the crank can front",
    detail:
      `${wrap.free} free lamports, but the crank can front ${wrap.allowance} (its balance less the ` +
      `${CRANK_WRAP_RESERVE_LAMPORTS}-lamport reserve), ${streak} turns in a row; ${wrap.wrapped} wrapped this turn ` +
      `and the rest waits for later sweeps. A crank below ${CRANK_WRAP_RESERVE_LAMPORTS + WRAP_DUST_LAMPORTS} lamports wraps nothing.`,
    context: { vault },
  };
}

/** The 1 SOL floor under convert.rs's per-call cap. */
export const CONVERT_CAP_FLOOR_LAMPORTS = 1_000_000_000n;

/**
 * The most lamports of wSOL one convert may sell: max(max_per_call, 1 SOL), the
 * bound convert.rs puts on amount_in (AboveMaximum above it).
 *
 * TWO SCALES, ONE KNOB. amount_in is lamports; max_per_call is written in the
 * in-asset's raw units, USDC's six decimals. The program reads the owner's
 * figure as lamports anyway and floors it at 1_000_000_000, so a 50-USDC cap
 * lets 1 SOL convert per call and a 1_500-USDC cap lets 1.5 SOL
 * (tests/z-review-invest.ts pins both boundaries).
 */
export function convertCapLamports(maxPerCall: bigint): bigint {
  return maxPerCall > CONVERT_CAP_FLOOR_LAMPORTS ? maxPerCall : CONVERT_CAP_FLOOR_LAMPORTS;
}

/**
 * How much of the vault's wSOL one turn converts: all of it up to the cap, the
 * rest left for later sweeps.
 *
 * THE WHOLE BALANCE WAS REFUSED ON EVERY SWEEP. The tick once converted all the
 * vault held as wSOL in one call, so once a wrap took that above the cap — an
 * owner's 50-USDC max_per_call and a 1.5 SOL settlement are enough — convert
 * was refused, the next sweep asked again for the same balance plus whatever it
 * had wrapped since, and the vault never invested again: its savings sat as
 * liquid wSOL and every sweep ended FAILED.
 */
export function convertAmount(wsol: bigint, maxPerCall: bigint): bigint {
  const cap = convertCapLamports(maxPerCall);
  return wsol < cap ? wsol : cap;
}

/** Below this, wSOL the turn did not just wrap is left where it is. */
export const CONVERT_DUST_LAMPORTS = 5_000_000n;

/**
 * Whether the turn converts: always after a wrap, and otherwise only when the
 * wSOL already held is worth a swap.
 *
 * DUST FAILED EVERY SWEEP. Any wSOL at all woke the convert, but a few lamports
 * price to a floor and a min_out of 0, which convert refuses with FloorTooLow —
 * so wSOL anyone can send to the vault's token account, or a partial fill left
 * behind, turned every later sweep into a refused convert reported as FAILED.
 * What a wrap just added is never dust: WRAP_DUST_LAMPORTS is the same line.
 */
export function shouldConvert(wsolHeld: bigint, wrapped: bigint): boolean {
  return wrapped > 0n || wsolHeld >= CONVERT_DUST_LAMPORTS;
}

/** u64::MAX: the product's default for max_per_call and max_rolling_30d, and where state.rs saturates. */
export const U64_MAX = (1n << 64n) - 1n;

/**
 * The chain's day, as invest.rs derives it: unix_timestamp / 86_400 in i64
 * division, which truncates toward zero as BigInt division does, and refused
 * outside u32 (InvalidPolicy).
 *
 * THE CHAIN'S CLOCK, NOT THIS HOST'S. A host clock a few minutes ahead near
 * midnight UTC would let a bucket out of the window a day before the program
 * does, and see headroom the program refuses.
 */
export function chainDay(unixTimestamp: bigint): number {
  const day = unixTimestamp / 86_400n;
  if (day < 0n || day > 0xffff_ffffn) {
    throw new Error(`the chain's unix_timestamp ${unixTimestamp} gives day ${day}, outside u32; invest refuses it with InvalidPolicy`);
  }
  return Number(day);
}

/**
 * What the policy has invested in the trailing 31 days, as state.rs's
 * rolling_total computes it: every bucket whose day + 31 is after today, added
 * in order with saturation at u64::MAX. The buckets are read, never rebuilt:
 * record() overwrites a stale one in place, so the stored days are the truth.
 */
export function rollingTotal(days: readonly number[], amounts: readonly bigint[], today: number): bigint {
  if (days.length !== amounts.length) throw new Error(`${days.length} bucket days against ${amounts.length} bucket amounts`);
  let total = 0n;
  for (const [index, day] of days.entries()) {
    // state.rs adds in u32 with overflow checks on (Cargo.toml), so a day this
    // large panics the program; the mirror refuses it too.
    if (day + 31 > 0xffff_ffff) throw new Error(`bucket day ${day} overflows u32 at day + 31, which panics rolling_total`);
    if (day + 31 > today) {
      total += amounts[index]!;
      if (total > U64_MAX) total = U64_MAX;
    }
  }
  return total;
}

/**
 * The smallest budget the whole basket can be bought with: ceil(min_investment
 * × 10_000 / the lightest weight). Split by weight and rounded down, as the
 * tick splits it, that budget gives every leg at least the min_investment
 * invest.rs requires of each call; one lamport less starves the lightest leg.
 */
export function basketMinimum(minInvestment: bigint, weightsBps: readonly number[]): bigint {
  if (weightsBps.length === 0 || weightsBps.some((weight) => !Number.isInteger(weight) || weight <= 0)) {
    throw new Error("a basket needs at least one leg and a positive weight on each, as set_invest_policy requires");
  }
  const lightest = BigInt(Math.min(...weightsBps));
  return (minInvestment * 10_000n + lightest - 1n) / lightest;
}

/** Whether the 30-day cap leaves the basket room; when it does, how much. */
export type RollingDecision =
  | { readonly invest: true; readonly headroom: bigint }
  | { readonly invest: false; readonly outcome: "IDLE"; readonly detail: string };

/**
 * Whether the 30-day cap leaves room to buy the basket, decided before any
 * balance, ATA, wrap or convert.
 *
 * SOLD FOR A PURCHASE THE CAP FORBIDS. invest.rs refuses every leg that would
 * take rolling_total past max_rolling_30d (RollingCapExhausted), but convert
 * records nothing against the cap. The tick never read the buckets, so a vault
 * whose month was spent had its SOL wrapped and market-sold to USDC and then
 * every leg refused — the SOL exposure gone and nothing bought — the sequence
 * this keeper already refuses for an unroutable basket.
 *
 * THE BASKET'S MINIMUM, NOT ONE LEG'S. Headroom of one min_investment lets one
 * leg through, but the tick buys every leg or none, and a basket of several
 * needs basketMinimum before its lightest leg qualifies. Resting only below
 * min_investment would still sell SOL for a basket the split then refuses.
 *
 * THE HEADROOM IS WHAT THE PROGRAM ADMITS: the largest amount_in for which
 * rolling.saturating_add(amount_in) <= max_rolling_30d. Under u64::MAX, the
 * product default, that is every amount, however much is already recorded.
 */
export function rollingDecision(input: {
  readonly policy: Pick<InvestmentPolicyState, "minInvestment" | "maxRolling30d" | "legs" | "bucketDays" | "bucketAmounts">;
  readonly today: number;
}): RollingDecision {
  const { policy, today } = input;
  const rolling = rollingTotal(policy.bucketDays, policy.bucketAmounts, today);
  const max = policy.maxRolling30d;
  const headroom = max === U64_MAX ? U64_MAX : rolling >= max ? 0n : max - rolling;
  const minimum = basketMinimum(policy.minInvestment, policy.legs.map((leg) => leg.weightBps));
  if (headroom >= minimum) return { invest: true, headroom };

  // A counted bucket leaves the window on its day + 31, and the headroom grows
  // by its amount that day.
  const leaving = policy.bucketDays
    .filter((day, index) => day + 31 > today && (policy.bucketAmounts[index] ?? 0n) > 0n)
    .map((day) => day + 31);
  const next = leaving.length === 0 ? null : Math.min(...leaving);
  return {
    invest: false,
    outcome: "IDLE",
    detail:
      `RollingCapExhausted: rolling ${rolling} of max ${max}; headroom ${headroom} is below the basket minimum ${minimum}; ` +
      (next === null || max < minimum
        ? "max_rolling_30d itself is below the basket minimum, so the basket cannot be bought until the owner raises it or lowers min_investment"
        : `headroom next grows on day ${next} (${new Date(next * 86_400_000).toISOString().slice(0, 10)})`) +
      " — nothing is wrapped, converted or bought",
  };
}

// ── every leg's mint, before the basket is bought ────────────────────────────

/**
 * The most an epoch-active transfer fee may be before this keeper refuses to
 * buy a leg at all: 100 bps, half of SLIPPAGE_BPS.
 *
 * SUBTRACTING THE FEE IS NOT THE SAME AS SURVIVING IT. min-out.ts now prices
 * against what the vault is actually credited, so the bound is honest at any
 * rate — but honest arithmetic on a 10% fee still buys 10% less stock, and one
 * key (the same that holds mint, freeze, pause and permanent-delegate authority
 * over both PreStocks mints) can schedule any rate up to 10_000 bps with about
 * two epochs' notice. It has already moved these mints from 0 to 50. A ceiling
 * is what turns "we would have priced it correctly" into "we did not buy it".
 *
 * 100 IS ADMITTED ON PURPOSE, AND IT IS THE LAST RATE THAT IS. The comparison
 * below is strictly greater-than, so exactly 100 bps passes — that is a
 * decision, not an accident of the operator, and this is where it is recorded.
 * A leg is bought and one day sold, so the ceiling is paid TWICE: 100 bps in
 * and 100 bps out is a 2 % round trip, which is the entire 200 bps
 * (SLIPPAGE_BPS) tolerance min-out.ts allows a single fill. At the ceiling the
 * product is already giving away a round trip's worth of the user's money to
 * the issuer, and the same authority can schedule more whenever it likes. So
 * the boundary is deliberate, it is tested at exactly 100 and at 101, and
 * raising the number means accepting a round trip larger than the slippage
 * bound the keeper enforces against the market — which is a different decision
 * from this one, and has to be argued on its own.
 */
export const MAX_LEG_FEE_BPS = 100n;

/** One of the two fees a mint's TransferFeeConfig carries, with the epoch it starts in. */
export interface ScheduledTransferFee extends TransferFeeTerms {
  /** The first epoch this fee applies in. */
  readonly epoch: bigint;
}

/** A mint's TransferFeeConfig: the fee in force and the one scheduled to replace it. */
export interface TransferFeeSchedule {
  readonly older: ScheduledTransferFee;
  readonly newer: ScheduledTransferFee;
}

/** What a leg's admissibility turns on, read from the mint's own Token-2022 extensions. */
export interface MintFacts {
  /**
   * The transfer hook's program id, or null when the mint names none — the
   * extension present with a NULL program id included, which is the issuer
   * keeping the option open rather than a hook: nothing is called today.
   */
  readonly transferHook: PublicKey | null;
  /** The mint's TransferFeeConfig, null when it carries none and so charges nothing, forever. */
  readonly transferFee: TransferFeeSchedule | null;
}

/** spl-token's Mint, before any extension. */
const MINT_BASE_BYTES = 82;
/** Token-2022's AccountType byte, which follows the base: 1 a mint, 2 a token account. */
const ACCOUNT_TYPE_MINT = 1;
/** extension.rs's ExtensionType discriminants, only the two this gate reads. */
const EXT_UNINITIALIZED = 0;
const EXT_TRANSFER_FEE_CONFIG = 1;
const EXT_TRANSFER_HOOK = 14;
/** TransferFeeConfig: authority(32) withdraw_withheld_authority(32) withheld_amount(8) older(18) newer(18). */
const TRANSFER_FEE_CONFIG_BYTES = 108;
/** TransferHook: authority(32) program_id(32). */
const TRANSFER_HOOK_BYTES = 64;

/** One TransferFee: epoch(8) maximum_fee(8) transfer_fee_basis_points(2), all little-endian. */
function scheduledFee(data: Buffer, offset: number): ScheduledTransferFee {
  return {
    epoch: data.readBigUInt64LE(offset),
    maximumFee: data.readBigUInt64LE(offset + 8),
    bps: BigInt(data.readUInt16LE(offset + 16)),
  };
}

/**
 * The two extensions this gate cares about, walked out of a mint account's own
 * bytes.
 *
 * HAND-ROLLED, like discovery.ts's walk over a TradingLink, and for the same
 * reason: it takes a Buffer, so the gate below it is a pure function a test can
 * hand a mint laid out byte for byte as extension.rs writes one, with no
 * connection anywhere.
 * The walk is Token-2022's own TLV: the 82-byte base, the account type, then
 * `u16 type, u16 length, length bytes` until the data runs out. An
 * over-allocated account is zero-padded and type 0 is that padding, so the walk
 * stops there rather than reading a fee out of zeroes.
 */
export function decodeMintFacts(data: Buffer): MintFacts {
  if (data.length < MINT_BASE_BYTES) {
    throw new Error(`a mint account is at least ${MINT_BASE_BYTES} bytes; this one is ${data.length}`);
  }
  // A classic SPL Token mint is exactly the base, and Token-2022 writes the
  // account type only once there is an extension to write after it.
  if (data.length <= MINT_BASE_BYTES + 1) return { transferHook: null, transferFee: null };
  const accountType = data.readUInt8(MINT_BASE_BYTES);
  if (accountType !== ACCOUNT_TYPE_MINT) {
    throw new Error(`the byte after the mint base is ${accountType}, not the ${ACCOUNT_TYPE_MINT} Token-2022 writes for a mint`);
  }

  let transferHook: PublicKey | null = null;
  let transferFee: TransferFeeSchedule | null = null;
  let offset = MINT_BASE_BYTES + 1;
  while (offset + 4 <= data.length) {
    const type = data.readUInt16LE(offset);
    if (type === EXT_UNINITIALIZED) break;
    const length = data.readUInt16LE(offset + 2);
    const start = offset + 4;
    if (start + length > data.length) {
      throw new Error(`extension ${type} claims ${length} bytes at ${start}, past the end of a ${data.length}-byte mint`);
    }
    if (type === EXT_TRANSFER_FEE_CONFIG) {
      if (length !== TRANSFER_FEE_CONFIG_BYTES) {
        throw new Error(`TransferFeeConfig is ${TRANSFER_FEE_CONFIG_BYTES} bytes; this mint carries ${length}`);
      }
      transferFee = { older: scheduledFee(data, start + 72), newer: scheduledFee(data, start + 90) };
    } else if (type === EXT_TRANSFER_HOOK) {
      if (length !== TRANSFER_HOOK_BYTES) {
        throw new Error(`TransferHook is ${TRANSFER_HOOK_BYTES} bytes; this mint carries ${length}`);
      }
      const programId = new PublicKey(data.subarray(start + 32, start + 64));
      transferHook = programId.equals(PublicKey.default) ? null : programId;
    }
    offset = start + length;
  }
  return { transferHook, transferFee };
}

/**
 * The fee terms in force for a transfer made in `currentEpoch`.
 *
 * TWO FEES ARE STORED AND ONE OF THEM IS LIVE. set_transfer_fee writes the new
 * rate into newer_transfer_fee stamped with the epoch it starts in — two epochs
 * out, so holders can see it coming — and keeps what it replaced in
 * older_transfer_fee until then. Reading `newer` unconditionally would charge a
 * scheduled fee two epochs early; reading `older` would miss it forever.
 *
 * THE RULE, NOT TODAY'S NUMBER. The newer fee is in force from the FIRST epoch
 * it names — `currentEpoch >= newer.epoch`, inclusive, which is the whole of
 * the branch below — and the older one holds until that epoch arrives. Neither
 * is "the fee" on its own, and a comment that names a rate has a shelf life:
 * BOTH PreStocks mints carry a rise ALREADY WRITTEN into newer_transfer_fee, so
 * the number in force changes the moment the cluster rolls an epoch, with
 * nothing signed, nothing deployed and nothing to notice it. What this function
 * promises is only this: the terms it returns are the ones Token-2022 will
 * charge in the epoch the transfer actually lands in, whatever the fee
 * authority has scheduled and whenever it scheduled it.
 */
export function activeTransferFee(facts: MintFacts, currentEpoch: bigint): TransferFeeTerms {
  const schedule = facts.transferFee;
  if (schedule === null) return NO_TRANSFER_FEE;
  return currentEpoch >= schedule.newer.epoch ? schedule.newer : schedule.older;
}

/** One leg's mint, as the chain returned its account. */
export interface LegMint {
  readonly mint: PublicKey;
  /** Null when the chain has no account at that address, or the read came back empty. */
  readonly account: { readonly owner: PublicKey; readonly data: Buffer } | null;
}

/** Whether every leg is one this keeper may buy; when it is, each leg's epoch-active fee, by mint. */
export type LegAdmission =
  | { readonly admit: true; readonly fees: ReadonlyMap<string, TransferFeeTerms> }
  | { readonly admit: false; readonly outcome: "REFUSED"; readonly detail: string };

/**
 * Whether the basket's mints are ones the program can buy safely, decided from
 * their own bytes before any wrap, convert or swap.
 *
 * THE FEE ARITHMETIC ALONE IS A HAZARD, NOT A FIX. Pricing against the net
 * credit keeps the bound honest at any rate, and the owner's money still buys
 * whatever the fee leaves. So the rate itself is bounded here (MAX_LEG_FEE_BPS),
 * not merely accounted for.
 *
 * THE HOOK IS THE ONE THAT CANNOT BE UNDONE. sip-vault's invest builds a
 * swap_v2 with the accounts the route names and nothing else; a mint whose
 * transfer_hook carries a real program id needs that program's own accounts
 * appended to every transfer, which this program cannot do without an upgrade.
 * Both PreStocks mints carry the extension with a NULL program id today — the
 * authority keeping the option open — and the day it is filled in, every leg
 * transfer starts calling code this keeper has never seen. Refusing is the only
 * safe reading.
 *
 * ALL OR NOTHING, the same doctrine as the unroutable-leg refusal and the
 * per-leg minimum: ONE disqualified leg refuses the WHOLE basket, the
 * well-behaved legs included. A basket bought without one of its legs is not
 * the basket the owner signed — its weights silently drift onto whatever is
 * left — so the turn buys every leg or none, and says which leg cost it.
 */
export function legAdmissionDecision(input: {
  readonly legs: readonly LegMint[];
  readonly currentEpoch: bigint;
}): LegAdmission {
  const refusals: string[] = [];
  const fees = new Map<string, TransferFeeTerms>();

  for (const leg of input.legs) {
    const name = leg.mint.toBase58();
    const refuse = (reason: string): number => refusals.push(`${name} ${reason}`);
    if (leg.account === null) {
      refuse("has no readable mint account, so nothing about it can be checked");
      continue;
    }
    if (!leg.account.owner.equals(TOKEN_2022_PROGRAM_ID)) {
      refuse(
        `is owned by ${leg.account.owner.toBase58()}, not Token-2022 (${TOKEN_2022_PROGRAM_ID.toBase58()}), ` +
          "which is the token program every leg's account and swap is built for",
      );
      continue;
    }
    let facts: MintFacts;
    try {
      facts = decodeMintFacts(leg.account.data);
    } catch (error) {
      refuse(`could not be decoded: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (facts.transferHook !== null) {
      refuse(
        `carries a transfer hook (${facts.transferHook.toBase58()}), and invest cannot append the accounts a real ` +
          "hook requires without a program upgrade",
      );
    }
    const fee = activeTransferFee(facts, input.currentEpoch);
    if (fee.bps > MAX_LEG_FEE_BPS) {
      refuse(
        `charges a ${fee.bps} bps transfer fee in epoch ${input.currentEpoch}, above the ${MAX_LEG_FEE_BPS} bps ` +
          "this keeper will buy through",
      );
    }
    fees.set(name, fee);
  }

  if (refusals.length === 0) return { admit: true, fees };
  return {
    admit: false,
    outcome: "REFUSED",
    detail:
      `${refusals.join("; ")} — refusing the whole basket of ${input.legs.length} leg(s), the sound ones included, ` +
      "and refusing to convert SOL toward it: a partial basket drifts from the weights the owner signed",
  };
}

// ── what one turn actually spends, per leg ───────────────────────────────────

/**
 * What one turn spends across the WHOLE basket: what the vault holds in the
 * in-asset, capped by max_per_call and by what the 30-day cap still admits.
 *
 * max_per_call CAPS THE BASKET, NOT THE LEG, and that is the surprising half of
 * it. invest.rs checks amount_in per call, so the name reads like a per-leg
 * bound; the tick takes min(held, max_per_call) ONCE and then splits it by
 * weight. A 1,000-dollar cap on a three-leg basket is therefore about 333
 * dollars into ONE pool in a single turn — two orders of magnitude more than
 * the 5-dollar purchase the product defaults to, and the figure any gate about
 * pool depth has to be written against.
 *
 * ONE FUNCTION, SO THE GATE AND THE SPEND CANNOT DRIFT. The depth gate below
 * tests a number; the swap loop sends one. They are the same arithmetic here
 * precisely so that no later edit can make the tested amount and the spent
 * amount two different things.
 */
export function basketBudget(input: {
  readonly held: bigint;
  readonly maxPerCall: bigint;
  readonly headroom: bigint;
}): bigint {
  const perCall = input.held > input.maxPerCall ? input.maxPerCall : input.held;
  return perCall > input.headroom ? input.headroom : perCall;
}

/** One leg's share of a budget, exactly as the tick splits it: floor(budget × weight / 10_000). */
export function legShare(budget: bigint, weightBps: number): bigint {
  return (budget * BigInt(weightBps)) / 10_000n;
}

/**
 * The most a turn could still spend, decided BEFORE the wrap — the figure the
 * depth gate tests against, because the gate has to run before anything is
 * wrapped or converted.
 *
 * THE ONE UNKNOWN IS REPLACED BY ITS OWN CAP. At the moment of the gate the
 * USDC that will exist after the convert has not been bought yet, so the exact
 * budget is unknowable; what IS known is that the budget can never exceed
 * max_per_call or the 30-day headroom, whatever the convert brings in. So a
 * converting turn is tested at min(max_per_call, headroom) — the worst case it
 * can reach — and the tick then clamps the budget it really spends to this same
 * ceiling, so the gate's guarantee holds exactly rather than approximately.
 *
 * AND A RESTING TURN IS NOT PUNISHED FOR IT. When the SOL hop is off or the
 * oracle rested it, no new in-asset can appear this turn, so the vault's own
 * holding is the ceiling. Testing such a turn at max_per_call would refuse a
 * 20-dollar basket because a 1,000-dollar one would have been too big — a gate
 * that refuses what it was never going to do is a gate an operator turns off.
 */
export function turnSpendCeiling(input: {
  /** The in-asset the vault holds right now, before any wrap or convert. */
  readonly held: bigint;
  /** Whether this turn will wrap and convert, and so may hold more by the time it buys. */
  readonly converting: boolean;
  readonly maxPerCall: bigint;
  readonly headroom: bigint;
}): bigint {
  const reachable = input.converting ? input.maxPerCall : input.held;
  return basketBudget({ held: reachable, maxPerCall: input.maxPerCall, headroom: input.headroom });
}

// ── every leg's pool, at the moment the money would move ─────────────────────

/**
 * How many times over a pool's in-side reserve must cover what this turn would
 * push into it before the keeper will trade there: 50.
 *
 * A BUILD-TIME CHECK CANNOT PROTECT AGAINST A POOL DRAINING. check:legs proved
 * every leg's depth against mainnet and passed. Two days later the leg it
 * passed — 6,700 dollars then — held 51: 0.110274669 of its own token against
 * 31.91 USDC, with any buy over about 11 dollars reverting (measured
 * 2026-09-20, three independent ways). Nothing about the leg changed; the
 * moment did. Depth is not a property of a mint or of a registry entry, it is a
 * property of the instant the swap lands in, so it is measured here, in the
 * turn, against the amount that turn is about to spend.
 *
 * WHY A MULTIPLE OF OUR OWN SIZE AND NOT AN AMOUNT. min-out.ts draws its 200
 * bps (SLIPPAGE_BPS) bound around a PAST swap's realised price, and everything
 * between that capture and our fill has to fit inside it: the drift since, and
 * OUR OWN impact. Our impact therefore has to be a fraction of that tolerance,
 * not equal to it. And a depth written as an amount is the check:legs mistake
 * again, one file further down — the depth that moved here is one market
 * maker's position, which moved five times in half an hour.
 *
 * WHY 50, FROM THE CASE THIS GATE EXISTS FOR. The drained pool holds 31.91
 * USDC. The product's default purchase is 5 dollars, which across three legs is
 * 1.67 into that pool — 19x cover. So any bound at or under 19x would have
 * ADMITTED the drained pool at the product's own default size, and a bound has
 * to clear that case with room. At 50x the drained pool admits 64 cents: every
 * spend a real turn can make there is refused, from the default basket up.
 *
 * AND WHAT IT COSTS ON A POOL THAT IS FINE. The live pool held 9,389.405679
 * USDC that night, its 0.5 % impact size measured at 350 dollars and then 598
 * six minutes later. 50x admits 187.79 there — about half the smaller
 * measurement, so roughly 27 bps of impact, an eighth of the tolerance. It
 * still refuses the 333 dollars a 1,000-dollar max_per_call splits three ways
 * (28x cover), which is exactly the size that pool was measured NOT to absorb
 * quietly. A gate that refused the 100-dollar leg a 250-dollar cap produces —
 * 94x cover, a size this venue serves without noticing — would be a gate an
 * operator turns off, and then none of this runs at all.
 *
 * WHAT THIS BOUND IS NOT. Read as flat constant product over the vault balance,
 * 50x is 196 bps of impact — the whole tolerance. That reading is the wrong
 * model for a concentrated-liquidity pool, and measurably so: it put the 0.5 %
 * size here at 47 dollars when the venue served 350. But the honest limit is
 * the other direction, and no multiple fixes it — a CLMM's vault balance can
 * sit entirely in ranges far from the current price, so a reserve can be large
 * while the depth AT the price is nothing. No multiple of a vault balance
 * bounds that. This gate is the cheap, early one: it refuses a pool that has
 * been drained BEFORE the owner's SOL is sold toward it. The bound that catches
 * liquidity which is not where the reserve suggests is min-out.ts's, at
 * execution, where the fill simply does not happen. Two layers, each doing the
 * thing the other cannot.
 */
export const MIN_POOL_DEPTH_MULTIPLE = 50n;

/**
 * Raydium CLMM PoolState, at the offsets live-route.ts already counts over the
 * same bytes: 8 disc, 1 bump, 32 amm_config, 32 owner, then token_mint_0 at 73,
 * token_mint_1 at 105, token_vault_0 at 137, token_vault_1 at 169. Mainnet
 * serves 1544 bytes; only these four addresses are read.
 */
const POOL_TOKEN_MINT_0 = 73;
const POOL_TOKEN_MINT_1 = 105;
const POOL_TOKEN_VAULT_0 = 137;
const POOL_TOKEN_VAULT_1 = 169;

/** The pair a pool trades, and the two accounts that hold its reserves. */
export interface PoolPair {
  readonly mint0: PublicKey;
  readonly mint1: PublicKey;
  readonly vault0: PublicKey;
  readonly vault1: PublicKey;
}

/**
 * The pair and the two vaults, walked out of a pool account's own bytes.
 *
 * NO LENGTH ORACLE. A length check alone cannot say these offsets mean what we
 * think — a different account of the right size decodes into four valid-looking
 * addresses — so the length is checked only as far as the bytes actually read,
 * and the DECISION below then requires the decoded pair to be the pair the
 * registry claims. Bytes that are not this pool's pair fail that, whatever
 * their length.
 */
export function decodePoolPair(data: Buffer): PoolPair {
  const end = POOL_TOKEN_VAULT_1 + 32;
  if (data.length < end) {
    throw new Error(`a Raydium CLMM pool state is at least ${end} bytes to reach its vaults; this account is ${data.length}`);
  }
  return {
    mint0: new PublicKey(data.subarray(POOL_TOKEN_MINT_0, POOL_TOKEN_MINT_0 + 32)),
    mint1: new PublicKey(data.subarray(POOL_TOKEN_MINT_1, POOL_TOKEN_MINT_1 + 32)),
    vault0: new PublicKey(data.subarray(POOL_TOKEN_VAULT_0, POOL_TOKEN_VAULT_0 + 32)),
    vault1: new PublicKey(data.subarray(POOL_TOKEN_VAULT_1, POOL_TOKEN_VAULT_1 + 32)),
  };
}

/** SPL Token's Account: mint(32) owner(32) amount(8, little-endian) — the balance at 64, in Token-2022 too. */
const TOKEN_ACCOUNT_AMOUNT = 64;

/** What a token account holds, out of its own bytes — the reserve, with no getTokenAccountBalance of its own. */
export function decodeTokenAccountAmount(data: Buffer): bigint {
  if (data.length < TOKEN_ACCOUNT_AMOUNT + 8) {
    throw new Error(`a token account is at least ${TOKEN_ACCOUNT_AMOUNT + 8} bytes to reach its amount; this account is ${data.length}`);
  }
  return data.readBigUInt64LE(TOKEN_ACCOUNT_AMOUNT);
}

/** A pool account as one turn read it: decoded, or the reason it could not be. */
export type PoolRead = { readonly ok: true; readonly pair: PoolPair } | { readonly ok: false; readonly why: string };

/**
 * One pool account as the chain returned it, read once — for the vault
 * addresses the turn must fetch next AND for the decision below, so the bytes
 * are decoded exactly once and every refusal string still lives in this file.
 */
export function readPoolPair(account: { readonly data: Buffer } | null | undefined): PoolRead {
  if (account === null || account === undefined) {
    return { ok: false, why: "has no readable pool account, and a depth that cannot be measured is not a depth" };
  }
  try {
    return { ok: true, pair: decodePoolPair(account.data) };
  } catch (error) {
    return { ok: false, why: `could not be read as a Raydium pool: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** One leg's pool, and what this turn would really push into it. */
export interface LegPool {
  readonly mint: PublicKey;
  /** The pool the registry routes this leg through. */
  readonly pool: PublicKey;
  /** In-asset raw units this turn would spend on THIS leg: its share of the turn's budget. */
  readonly spend: bigint;
  readonly read: PoolRead;
}

/** Whether every leg's pool can serve this turn's share of it with margin. */
export type DepthDecision =
  | { readonly deep: true }
  | { readonly deep: false; readonly outcome: "REFUSED"; readonly detail: string };

/** A reserve's cover of a spend, for a refusal a human has to act on: "6.4x", "0.0x". */
function cover(reserve: bigint, spend: bigint): string {
  if (spend <= 0n) return "unbounded";
  return `${(Number(reserve) / Number(spend)).toFixed(1)}x`;
}

/**
 * Whether the pools this turn would trade against can actually serve it,
 * measured from their own vaults at the moment of the turn and against the
 * amount this turn would really spend on each leg.
 *
 * THE GATE check:legs CANNOT BE. A build-time check proves a pool was deep when
 * the check ran. This one refuses the turn when the pool is shallow NOW, which
 * is the only tense in which money moves. It runs beside the unroutable-leg and
 * mint-admission refusals, before anything is wrapped or converted, so a basket
 * that cannot be bought never costs the owner their SOL exposure on the way to
 * finding out.
 *
 * ALL OR NOTHING, the same doctrine and the same reason as the two gates beside
 * it: ONE shallow leg refuses the WHOLE basket, the deep ones included. Buying
 * only the legs whose pools happen to be deep is a partial basket, and its
 * weights silently drift onto whatever survived — which is not the basket the
 * owner signed. The detail names the leg and both figures, because the operator
 * cannot act on "a pool was thin".
 *
 * THE IN-SIDE RESERVE IS WHAT IS TESTED. It is the denominator of the impact
 * the slippage bound has to absorb, and it is denominated in the same asset as
 * the spend — so the test needs no price, and no quote from the venue being
 * traded against can flatter it. The out side can only be checked for the one
 * thing that needs no price: whether there is anything there at all. A pool
 * with stock left but no in-asset depth is caught by the reserve arm; a pool
 * with neither is caught twice.
 */
export function legDepthDecision(input: {
  /** The policy's in_mint — the side the spend is denominated in. */
  readonly inMint: PublicKey;
  readonly legs: readonly LegPool[];
  /** What each pool vault held, by address, from the read that followed the pool accounts. */
  readonly vaultAmounts: ReadonlyMap<string, bigint>;
}): DepthDecision {
  const refusals: string[] = [];

  for (const leg of input.legs) {
    const name = `${leg.mint.toBase58()} (pool ${leg.pool.toBase58()})`;
    const refuse = (reason: string): number => refusals.push(`${name} ${reason}`);
    // A leg whose share rounds to nothing is a leg this turn sends no
    // transaction for (the swap loop skips it), so there is no spend to serve
    // and no pool to judge.
    if (leg.spend <= 0n) continue;
    if (!leg.read.ok) {
      refuse(leg.read.why);
      continue;
    }
    const { mint0, mint1, vault0, vault1 } = leg.read.pair;
    // THE REGISTRY IS CHECKED AGAINST THE CHAIN HERE. deps.pools maps a mint to
    // a pool by configuration; nothing until now has asked the pool whether it
    // trades that pair. A pool that does not is both a misconfiguration and the
    // one way these offsets could mean something else entirely.
    const inIsZero = mint0.equals(input.inMint) && mint1.equals(leg.mint);
    const inIsOne = mint1.equals(input.inMint) && mint0.equals(leg.mint);
    if (!inIsZero && !inIsOne) {
      refuse(
        `trades ${mint0.toBase58()} against ${mint1.toBase58()}, not ${input.inMint.toBase58()} against this leg — ` +
          "the pool this leg is routed through is not this leg's pair",
      );
      continue;
    }
    const inVault = inIsZero ? vault0 : vault1;
    const outVault = inIsZero ? vault1 : vault0;
    const reserve = input.vaultAmounts.get(inVault.toBase58());
    const stock = input.vaultAmounts.get(outVault.toBase58());
    if (reserve === undefined || stock === undefined) {
      refuse(
        `has a vault this turn could not read (${(reserve === undefined ? inVault : outVault).toBase58()}), ` +
          "and a depth that cannot be measured is not a depth",
      );
      continue;
    }
    if (stock === 0n) {
      refuse(`holds none of the leg at all: its ${outVault.toBase58()} vault is empty, so there is nothing to buy`);
      continue;
    }
    const required = leg.spend * MIN_POOL_DEPTH_MULTIPLE;
    if (reserve < required) {
      refuse(
        `holds ${reserve} in-asset raw against the ${leg.spend} this turn would push into it — ${cover(reserve, leg.spend)} ` +
          `cover, under the ${MIN_POOL_DEPTH_MULTIPLE}x this keeper trades on (it would need ${required})`,
      );
    }
  }

  if (refusals.length === 0) return { deep: true };
  return {
    deep: false,
    outcome: "REFUSED",
    detail:
      `${refusals.join("; ")} — refusing the whole basket of ${input.legs.length} leg(s), the deep ones included, ` +
      "and refusing to convert SOL toward it: a partial basket drifts from the weights the owner signed. " +
      "Pool depth is measured in the turn, not at build time: a pool that passed check:legs days ago can be drained now",
  };
}

/** Consecutive FAILED turns at which a vault's invest-failed alert turns critical. */
export const INVEST_FAILED_CRITICAL_STREAK = 3;

/**
 * A vault's count of consecutive FAILED invest turns, after one more turn.
 * REFUSED neither counts nor ends the run: it has its own alert. INVESTED and
 * every resting outcome end it.
 */
export function investFailedStreak(previous: number, outcome: InvestOutcome): number {
  if (outcome === "FAILED") return previous + 1;
  if (outcome === "REFUSED") return previous;
  return 0;
}

/**
 * The alert for a vault whose invest turn FAILED: a warning at first, critical
 * from the third turn in a row.
 *
 * ONLY REFUSED USED TO ALERT. A vault stuck on AboveMaximum, a short crank,
 * dust or slippage logged one warn line per sweep and reached no webhook,
 * while a settle that failed paged at once. One failure is often the market —
 * a fill under min_out, a dropped transaction — and the next sweep clears it;
 * three in a row is a vault that has stopped buying.
 */
export function investFailedAlert(vault: string, streak: number, detail: string): Alert {
  const critical = streak >= INVEST_FAILED_CRITICAL_STREAK;
  return {
    key: `invest-failed:${vault}`,
    severity: critical ? "critical" : "warn",
    title: critical ? "A vault's investing keeps failing" : "An investment turn failed",
    detail: `${streak} failed turn${streak === 1 ? "" : "s"} in a row: ${detail}`,
    context: { vault },
  };
}
