// Which in-asset this keeper can invest from, which VENUE it can build a route
// for, whether it may invest at all, whether it may convert the vault's SOL to
// get there, whether an independent oracle still agrees with the pool that
// conversion would price against, how much of that SOL one turn may wrap and
// convert, whether the 30-day cap leaves the basket room, and whether every
// leg's mint is one the program can buy at all, as pure decisions, with the
// alerts for a crank or an investment that stays stuck.
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
//
// THE SAME IS TRUE OF THE VENUE, and for a while the keeper did not notice.
// InvestmentPolicy pins `venue_program` too, convert.rs and invest.rs check the
// account passed against it (WrongVenue), and invest-tick.ts passed a literal.
// venueDecision below refuses a venue this keeper cannot route, beside the other
// all-or-nothing basket refusals and before anything moves.

import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import type { InvestmentPolicyState } from "./accounts.js";
import type { Alert } from "./alerts.js";
import type { InvestOutcome } from "./invest-tick.js";
import { NO_TRANSFER_FEE, SLIPPAGE_BPS, type TransferFeeTerms } from "./min-out.js";
// THROUGH program-scripts.ts, NEVER FROM @sip/solana-program DIRECTLY. That
// file is the one place the CommonJS/ESM unwrap happens, and JUPITER_PROGRAM is
// in its import-time loop — so a build where the unwrap stops working fails at
// startup, in --preflight, rather than as `undefined.equals(...)` inside the
// venue comparison below on a live turn. Importing the id from the package here
// would take a SECOND path into the same module and quietly skip that check.
import { JUPITER_PROGRAM, feeRiseCanLand } from "./program-scripts.js";
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

// ── the venue the owner signed, before the basket is bought ──────────────────
//
// THE POLICY NAMES THE VENUE AND THE PROGRAM PINS IT. convert.rs and invest.rs
// both `require!(ctx.accounts.venue_program.key() == policy.venue_program,
// WrongVenue)` before a lamport moves, so the venue account the keeper passes is
// not a detail of the route: it is a term of the policy the vault owner signed,
// and the program checks it byte for byte.
//
// THE KEEPER USED TO IGNORE IT. invest-tick.ts passed the RAYDIUM_CLMM literal
// at both sites — the convert and the per-leg invest — and never read
// policy.venue_program at all, which it already had in hand. That is the crank
// disobeying what the owner signed, and it is a defect on its own, whatever the
// policies on chain happen to say today.
//
// AND IT IS A TRAP. The day a policy is signed with any other venue_program,
// EVERY convert and EVERY invest for that vault reverts with WrongVenue, on
// every sweep, for as long as the policy stands — and the keeper, sending the
// literal, could never say why: it would report the program's rejection as one
// more FAILED turn. So the venue is read from the policy (task 1) and a venue
// this keeper cannot build a route for is refused HERE, loudly, before anything
// is wrapped, converted or bought (task 2).

/**
 * Raydium CLMM on mainnet: the venue every policy signed before 2026-09-22
 * names, and the one this keeper NO LONGER ROUTES.
 *
 * KEPT THOUGH IT IS NOT ROUTABLE, and that is the whole reason it is still
 * here. It was the venue the live policy named until the owner re-signed onto
 * Jupiter v6 on 2026-09-22 (CHANGELOG.md), and it is what any policy signed
 * before that still names — so it is a value venueDecision can still be
 * handed, and a refusal that can name it can say "this is the migration"
 * instead of "unknown venue". See RETIRED_VENUES.
 */
export const RAYDIUM_CLMM_PROGRAM = new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");

/**
 * Jupiter v6 on mainnet: the venue this keeper buys and converts through.
 *
 * THE PACKAGE'S OWN VALUE, through program-scripts.ts, rather than a second
 * literal beside it. It used to be written out here so this file stayed a pure
 * decision module, with a test comparing the two ends. That test is the thing
 * that argued against the arrangement: a value that travels wants ONE source,
 * and program-scripts.ts is the file that already checks at import time that
 * the unwrap produced a PublicKey. The base58 string is still pinned, once, in
 * test/invest-decision.test.ts — against a literal written independently of
 * this line, which is the pin that can actually fail.
 */
export const JUPITER_V6_PROGRAM = JUPITER_PROGRAM;

/**
 * Every venue this keeper can actually build a route for, by the program id a
 * policy names, to the name a human uses for it.
 *
 * AN ENTRY HERE IS A PROMISE THIS KEEPER CAN KEEP. Jupiter v6 is
 * buildJupiterRoute: a quote, a /swap-instructions build, a verified
 * shared-accounts route, and a venue_data blob invest.rs and convert.rs CPI
 * straight through. A second venue is a second entry HERE plus a route builder
 * for it — the gate below neither needs nor gains a branch, and the refusal
 * names whatever this map holds. A placeholder entry would be a keeper claiming
 * a route it cannot build, which is the failure this whole gate exists to
 * prevent.
 *
 * WHY RAYDIUM CLMM IS NOT IN IT ANY MORE. The assets the product must hold have
 * their liquidity away from Raydium — ANTHROPIC $331,617 on Hadron against
 * $7,458 on Raydium, OPENAI $25,220 on Manifest, SPACEX on Meteora — so the
 * owner has decided the keeper buys through Jupiter, which reaches all of them.
 * invest-tick.ts no longer contains a Raydium route builder at all: there is no
 * fetchLiveRoute, no buildSwapV2AccountMetas and no pool read on the money
 * path. Leaving the entry here would therefore be the lie this doc comment
 * warns about — the gate would pass, and the turn would then reach a builder
 * that does not exist.
 */
export const ROUTABLE_VENUES: ReadonlyMap<string, string> = new Map([[JUPITER_V6_PROGRAM.toBase58(), "Jupiter v6"]]);

/**
 * A venue this keeper USED to route, and the sentence its refusal earns.
 *
 * THIS EXISTED BECAUSE ONE REFUSAL WAS EXPECTED. When this code shipped, the
 * policy on chain (vault EFXK995PV49Qz8xPSYMEUDBU5AKRR466JkgsfuGak5iU) named
 * Raydium CLMM, so any sweep that found enough to invest would refuse — by
 * design, before the wrap, with the vault's money untouched — until the owner
 * re-signed onto Jupiter v6 on 2026-09-22 (CHANGELOG.md). It stays for any vault
 * whose policy still names Raydium. Whoever reads that refusal at three
 * in the morning needs to know in its first clause that it is the planned state
 * of a migration and not a keeper that broke, because those two call for
 * opposite reactions: one waits for a signature, the other wakes somebody.
 */
export const RETIRED_VENUES: ReadonlyMap<string, string> = new Map([
  [
    RAYDIUM_CLMM_PROGRAM.toBase58(),
    "This is the EXPECTED first state of the Jupiter migration, not a broken keeper: Raydium CLMM is the venue " +
      "policies were signed with until 2026-09-22 and the one this policy still names, and this keeper deliberately " +
      "stopped routing it when the basket moved to Jupiter (the assets the product must hold — ANTHROPIC, OPENAI, " +
      "SPACEX — have their liquidity away from Raydium). Nothing is wrong with the vault, nothing has been spent, " +
      "and no SOL has been wrapped.",
  ],
]);

/** The routable venues as a refusal names them: "Jupiter v6 (JUP6…TaV4)". */
function routableVenues(): string {
  return [...ROUTABLE_VENUES].map(([address, name]) => `${name} (${address})`).join(", ");
}

/**
 * Whether this keeper can build a route for the venue the policy names, decided
 * from the policy alone and beside the unroutable-leg, mint-admission and
 * venue-depth refusals — before anything is wrapped, converted or bought.
 *
 * WRITTEN FOR SOMEONE READING IT AT THREE IN THE MORNING. This message is the
 * only thing that will ever explain why a vault stopped buying: the alternative
 * is a WrongVenue revert per leg per sweep, forever, with a keeper that reports
 * it as a failed transaction and names nothing. So it says which venue the
 * policy asked for, which venues this keeper can actually route, that the vault
 * OWNER re-signs the policy to change it, and that adding a venue to the keeper
 * is a code change rather than a configuration one — and, for a venue this
 * keeper has RETIRED, it opens by saying so, because that refusal is expected
 * and the others are not.
 */
export function venueDecision(venueProgram: PublicKey): { readonly outcome: "REFUSED"; readonly detail: string } | null {
  if (ROUTABLE_VENUES.has(venueProgram.toBase58())) return null;
  const retired = RETIRED_VENUES.get(venueProgram.toBase58());
  return {
    outcome: "REFUSED",
    detail:
      (retired === undefined ? "" : `${retired} `) +
      `The policy's venue_program is ${venueProgram.toBase58()}, and this keeper cannot build a route for it. ` +
      `The only venue it can route is ${routableVenues()}. ` +
      "convert.rs and invest.rs both pin the venue account this keeper passes against policy.venue_program " +
      "(WrongVenue), so were the turn to go on, EVERY convert and EVERY invest for this vault would revert, on " +
      "every sweep, for as long as this policy stands — refusing here instead, before anything is wrapped, " +
      "converted or bought, and refusing the whole basket rather than part of it. " +
      "NOTHING IN THE KEEPER CAN FIX THIS: the venue is a term of the policy the vault owner signed, so only the " +
      "OWNER can change it, by re-signing the investment policy (set_invest_policy) with a venue this keeper " +
      "routes. Teaching the keeper a new venue is a code change, not a configuration one: it needs a route builder " +
      "for that venue as well as an entry in ROUTABLE_VENUES (invest-decision.ts)",
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
 * NOT A REFUSAL, AND THAT IS THE POINT OF THE NOISE. A zero here is a VALID
 * policy: set_invest_policy checks the legs, the weights, the in_mint and the
 * three amounts, and never once looks at min_convert_rate_wad, so the program
 * stores whatever arrives and then refuses every call that would use it. The
 * owner may have meant exactly that — keep the SOL as SOL — and the USDC already
 * in the vault is still invested against the legs as usual, so the turn goes on,
 * nobody is paged and nothing is refused. But the same zero is what a bad form
 * or a careless re-sign leaves behind, and its only symptom is a hop that
 * silently stops happening. So the detail below is written to be read by
 * somebody who did not sign this policy and is trying to work out why a vault's
 * SOL never becomes stock: it names the field, says the program accepts it, says
 * what stops, says that the Pyth guard on that hop is left with nothing to
 * watch, and says who can turn it back on. invest-tick.ts carries it at the
 * FRONT of every detail the turn ends with, not as an afterthought on some of
 * them.
 */
export function convertDecision(policy: { readonly minConvertRateWad: bigint }): ConvertDecision {
  if (policy.minConvertRateWad > 0n) return { convert: true };
  return {
    convert: false,
    detail:
      "CONVERSION IS OFF, DELIBERATELY OR NOT: the policy's min_convert_rate_wad is 0, and the SOL-to-USDC hop is " +
      "switched off for as long as it stays there. The program ACCEPTS this policy — set_invest_policy validates " +
      "every other field and never looks at this one — and then wrap_sol and convert refuse every call made under " +
      "it with FloorTooLow, so the vault's SOL is not wrapped or converted and only USDC already in the vault is " +
      "invested. THE PYTH GUARD ON THAT HOP HAS NOTHING TO WATCH while this stands: there is no convert for it to " +
      "price, so neither a stale feed nor a pool that has walked away from the world can be caught here — the hop " +
      "it protects is not happening at all. If the owner meant to keep the SOL as SOL, this is the policy working; " +
      "if not, a bad form or a careless re-sign put the 0 there, and NOTHING IN THE KEEPER CAN UNDO IT: only the " +
      "vault's OWNER can, by re-signing the investment policy with a non-zero min_convert_rate_wad",
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
 * buy a leg at all: 300 bps.
 *
 * SUBTRACTING THE FEE IS NOT THE SAME AS SURVIVING IT. min-out.ts now prices
 * against what the vault is actually credited, so the bound is honest at any
 * rate — but honest arithmetic on a 10% fee still buys 10% less stock, and one
 * key (the same that holds mint, freeze, pause and permanent-delegate authority
 * over every PreStocks mint) can schedule any rate up to 10_000 bps with about
 * two epochs' notice. It has moved these mints 0 -> 50 -> 100 -> 300. A ceiling
 * is what turns "we would have priced it correctly" into "we did not buy it".
 *
 * RAISED FROM 100 TO 300 ON 2026-09-24, BY THE OWNER, KNOWING THE COST. Read on
 * mainnet that day (epoch 1041): the issuer key WV9PJN7X… had ALREADY WRITTEN
 * newer_transfer_fee = 300 bps from epoch 1043 into ANTHROPIC, FIGUREAI, OPENAI,
 * NEURALINK, POLYMARKET, KALSHI and ANDURIL (older record 100 bps from 1039,
 * maximum_fee u64::MAX); SPACEX stayed at 100 from 1039 with nothing newer, and
 * SPYx carries no fee extension at all. At the old ceiling of 100 this keeper
 * raised a CRITICAL alert — 300 scheduled against 100 — because from epoch 1043
 * (around Sat 26 Sep 2026, 05:00Z, from 265.7 ms/slot measured over epoch 1041)
 * every basket holding a PreStock would have been REFUSED whole, SPYx and the
 * SOL conversion with it, with nothing signed or deployed here. The owner chose
 * to keep buying through it rather than drop the PreStock the track requires.
 *
 * WHAT HE ACCEPTED, SAID WHERE THE NUMBER IS. A leg is bought and one day sold,
 * so the fee is paid TWICE: 3 % in and 3 % out is 1 - 0.97^2 = 5.91 % of a
 * PreStock position gone to the issuer before the market is involved at all
 * (at 100 it was 1.99 %). That is almost three times the whole 200 bps
 * (SLIPPAGE_BPS) min-out.ts allows a single fill against the market, and the
 * ceiling existed to stop exactly this; accepting it is a product decision and
 * it is his. What it does NOT cost is the market budget: legSlippageBps(300)
 * asks Jupiter for 400 bps, strictly 100 over the fee as the 0x1771 revert
 * demands, so the usable tolerance is still 100 bps and maxTurnImpactBps(400,
 * 300) is still 25 bps — the same impact bar as at 100 over 200.
 *
 * 300 IS ADMITTED ON PURPOSE, AND IT IS AGAIN THE LAST RATE THAT IS. The
 * comparison below is strictly greater-than, so exactly 300 bps passes and 301
 * refuses; both are tested. One more step by the same key — it has stepped by
 * 50, 50 and then 200 — refuses the WHOLE basket and the SOL conversion again, on every
 * sweep, until the fee comes back down or the basket is re-signed without the
 * leg. Raising this again is the same decision over again, and is the owner's.
 */
export const MAX_LEG_FEE_BPS = 300n;

/**
 * The SMALLEST step the fee authority has actually used, in bps.
 *
 * The PreStocks mints were moved 0 -> 50 -> 100 by the same key in fifty-bps
 * steps, and then — read 2026-09-24 — 100 -> 300 in ONE write of 200. This is
 * not a promise about the next move: that key can write any rate up to 10_000
 * bps whenever it likes, and the 200 step is the proof that it does not keep
 * its own rhythm. Fifty is kept because it is the smallest move on record, and
 * the band below is spaced by it — one observed step of room under the ceiling
 * rather than a margin invented here.
 */
export const LEG_FEE_STEP_BPS = 50n;

/**
 * The fee at which a leg starts being REPORTED, in bps: one observed issuer
 * step under MAX_LEG_FEE_BPS, so 250.
 *
 * REPORTED, NOT REFUSED, AND THE DISTINCTION IS THE WHOLE POINT. The refusal
 * already exists and sits at MAX_LEG_FEE_BPS; firing it earlier would be this
 * keeper deciding a product question — how much of the owner's money may go to
 * an issuer — which is the owner's to decide and is argued at MAX_LEG_FEE_BPS.
 * What the band adds is NOTICE: a leg at the ceiling is admitted only because
 * the comparison at the refusal is strictly greater-than, and without this the
 * basket is bought, the turn reports INVESTED, and the single next step by one
 * key stops every leg and the SOL conversion together, with no warning before
 * it and a REFUSED turn after it.
 *
 * THE BAND IS NOT WHAT CAUGHT THE 200-BPS STEP, AND CANNOT BE. A write can jump
 * clean over any band — 100 to 300 did, over the old 50..100 one. What caught
 * it is legFeeCeilingAlert reading the SCHEDULED fee out of the same bytes: a
 * rise is written into newer_transfer_fee about two epochs before it is
 * charged, so a jump past the ceiling is a dated CRITICAL long before it is a
 * refusal. The band only decides which LIVE or scheduled rates under the
 * ceiling are close enough to say out loud.
 */
export const LEG_FEE_WARN_BPS = MAX_LEG_FEE_BPS - LEG_FEE_STEP_BPS;

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

/** spl-token's Mint, before any extension. A mint with none is exactly this long. */
const MINT_BASE_BYTES = 82;
/**
 * Token-2022's BASE_ACCOUNT_LENGTH: where a mint's AccountType byte really sits,
 * with the TLV extensions starting the byte after it.
 *
 * THIS WAS 82 UNTIL 2026-09-21, AND IT WAS WRONG ON EVERY REAL MINT. The walk
 * below assumed Token-2022 wrote the account type immediately after the 82-byte
 * base. It does not: a mint carrying extensions is zero-padded out past
 * `Account`'s own 165 bytes — precisely so a mint and a token account can never
 * be confused by length — and only THEN comes the account type, at 165, with
 * the TLV from 166.
 *
 * MEASURED, against mainnet, the day this was fixed:
 *   ANTHROPIC Pren1FvF… 911 bytes, byte[82] = 0, byte[165] = 1
 *   SPYx      XsoCS1Tf… 676 bytes, byte[82] = 0, byte[165] = 1
 * At the old offset decodeMintFacts threw "the byte after the mint base is 0"
 * for BOTH — so legAdmissionDecision refused every Token-2022 leg it was ever
 * shown, the live SPYx one included, and the fee ceiling it exists to enforce
 * had never once been evaluated against a real mint. spl-token's own
 * getTransferFeeConfig reads ANTHROPIC's schedule off the same bytes as
 * older{1032, 50} newer{1039, 100}, which is the schedule this project has been
 * quoting all along — from that tool, never from this one.
 *
 * WHY NO TEST CAUGHT IT, and it is the first species in docs/TESTING_TRAPS.md:
 * every mint fixture in the suite was BUILT at offset 82 by a helper written
 * beside this decoder, so the fixture and the code under test agreed with each
 * other and with nothing else. The fix comes with test/fixtures/token2022-mints.json
 * — the real accounts, captured from mainnet — so the next disagreement is with
 * the chain rather than with ourselves.
 */
const BASE_ACCOUNT_BYTES = 165;
/** Token-2022's AccountType byte: 1 a mint, 2 a token account. */
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
  // A mint with no extensions is exactly the base — a classic SPL Token mint,
  // or a Token-2022 one that never needed padding. Anything longer must be
  // padded past BASE_ACCOUNT_BYTES before the account type, so a length in
  // between is not a layout this walk understands.
  if (data.length <= BASE_ACCOUNT_BYTES) return { transferHook: null, transferFee: null };
  const accountType = data.readUInt8(BASE_ACCOUNT_BYTES);
  if (accountType !== ACCOUNT_TYPE_MINT) {
    throw new Error(
      `byte ${BASE_ACCOUNT_BYTES} of this mint is ${accountType}, not the ${ACCOUNT_TYPE_MINT} Token-2022 writes for a mint`,
    );
  }

  let transferHook: PublicKey | null = null;
  let transferFee: TransferFeeSchedule | null = null;
  let offset = BASE_ACCOUNT_BYTES + 1;
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

/**
 * The worst fee a transfer of this mint could be charged BY A TRANSACTION BUILT
 * NOW: today's, or a rise written for the NEXT epoch when that epoch starts
 * within LANDING_WINDOW_SLOTS (jupiter-route.ts) of the slot this turn read —
 * whichever is higher. A rise two or more epochs out changes nothing.
 *
 * WHY THE LANDING EPOCH AND NOT "ANY PENDING RISE". Token-2022 charges the fee
 * in force in the epoch the transfer LANDS, and nothing this turn sends can
 * land more than LANDING_WINDOW_SLOTS after its clock read. This used to take
 * any rise already written, however many epochs away, and that stopped buying
 * from the moment one was: ANTHROPIC charged 100 bps with 300 written for epoch
 * 1043, so from the write the keeper asked Jupiter for legSlippageBps(300) =
 * 400 bps and the builder took min_out net of 300. Measured 2026-09-25 with a
 * send-blocked run of runInvestTick for vault EFXK995P... in epoch 1042, about
 * 355,000 slots before 1043, on 0b31682 and on c346632 alike:
 *   JupiterRouteRefusal: jupiter route refused [below-owner-floor]: this
 *   route's min_out would be 2427695, under the owner's own floor of 2483089
 *   (2752188 in at 902223869744110771 wad)
 * — every sweep refused, over a fee no transaction it could send would pay.
 *
 * WHY THE SLIPPAGE IS SIZED AGAINST THIS AND NOT THE ACTIVE FEE. The route
 * builder derives min_out from `fee.worstCase`, which is
 * resolveDestinationTransferFee under the SAME feeRiseCanLand and the same
 * window. If the keeper sized its slippage against a smaller fee than the
 * builder modelled, measureLegVenue would refuse on that disagreement
 * (slippageRefusal); if against a larger one, the ask would be wider than the
 * min_out it pays for. One predicate, imported by both, is what keeps them
 * equal. The builder reads its own epoch later in the turn, so at the very
 * edge of the window it may see the rise when this read did not; that edge
 * refuses one turn rather than sending one.
 *
 * `slotsLeftInEpoch` is slots from the Clock's slot to the next epoch's first
 * slot (slotsLeftInEpoch below, from the EpochSchedule sysvar).
 *
 * THE COST IS A WIDER ASK, NOT A LOOSER FLOOR. A wider slippage only changes
 * what we ask Jupiter for; min_out still comes from the route's own bytes and
 * is still checked against the owner's signed floor.
 *
 * NOT THE ADMISSION GATE'S NUMBER. MAX_LEG_FEE_BPS is still judged on the fee
 * in force TODAY — a rise written for next month refuses nothing now, and
 * legFeeWarnings, which is unchanged by this, still announces every written
 * rise the day it is written.
 */
export function worstCaseTransferFee(facts: MintFacts, currentEpoch: bigint, slotsLeftInEpoch: bigint): TransferFeeTerms {
  const schedule = facts.transferFee;
  if (schedule === null) return NO_TRANSFER_FEE;
  const active = activeTransferFee(facts, currentEpoch);
  const pending = schedule.newer.epoch > currentEpoch ? schedule.newer : null;
  if (pending === null) return active;
  if (!feeRiseCanLand({ currentEpoch, slotsLeftInEpoch, riseEpoch: pending.epoch })) return active;
  return pending.bps > active.bps ? pending : active;
}

/** The EpochSchedule sysvar, as bincode lays it out: 33 bytes. */
export interface EpochScheduleFacts {
  readonly slotsPerEpoch: bigint;
  readonly warmup: boolean;
  readonly firstNormalEpoch: bigint;
  readonly firstNormalSlot: bigint;
}

/** Agave's MINIMUM_SLOTS_PER_EPOCH: the first warmup epoch's length, doubling each epoch after. */
const MINIMUM_SLOTS_PER_EPOCH = 32n;
const EPOCH_SCHEDULE_BYTES = 33;

/**
 * Decodes SysvarEpochSchedu1e111111111111111111111111: slots_per_epoch u64,
 * leader_schedule_slot_offset u64, warmup bool, first_normal_epoch u64,
 * first_normal_slot u64. Mainnet's bytes, read 2026-09-25, are 432000 /
 * 432000 / false / 0 / 0 — the same as getEpochSchedule answered that day.
 *
 * READ, NOT PINNED. The epoch's end is the one number the landing-window rule
 * needs that the Clock does not carry, and it rides in the same request as the
 * Clock, so reading it costs no round trip and cannot be wrong on a cluster
 * whose schedule is not mainnet's.
 */
export function decodeEpochSchedule(data: Buffer): EpochScheduleFacts {
  if (data.length < EPOCH_SCHEDULE_BYTES) {
    throw new Error(`the EpochSchedule sysvar is ${EPOCH_SCHEDULE_BYTES} bytes; this read returned ${data.length}`);
  }
  const slotsPerEpoch = data.readBigUInt64LE(0);
  if (slotsPerEpoch === 0n) throw new Error("the EpochSchedule sysvar says 0 slots per epoch");
  return {
    slotsPerEpoch,
    warmup: data.readUInt8(16) !== 0,
    firstNormalEpoch: data.readBigUInt64LE(17),
    firstNormalSlot: data.readBigUInt64LE(25),
  };
}

/** Agave's EpochSchedule::get_first_slot_in_epoch, warmup included. */
export function firstSlotOfEpoch(schedule: EpochScheduleFacts, epoch: bigint): bigint {
  if (epoch <= schedule.firstNormalEpoch) return ((1n << epoch) - 1n) * MINIMUM_SLOTS_PER_EPOCH;
  return (epoch - schedule.firstNormalEpoch) * schedule.slotsPerEpoch + schedule.firstNormalSlot;
}

/**
 * Slots from `slot` to the first slot of the epoch after `epoch` — the number
 * feeRiseCanLand compares with LANDING_WINDOW_SLOTS, and the same quantity
 * the route builder reads as getEpochInfo's slotsInEpoch - slotIndex.
 * Mainnet, measured 2026-09-25: slot 450,220,830 in epoch 1042 leaves
 * 1043 x 432,000 - 450,220,830 = 355,170. Zero or less means the slot and the
 * epoch disagree, and feeRiseCanLand reads that as inside the window.
 */
export function slotsLeftInEpoch(schedule: EpochScheduleFacts, clock: { readonly slot: bigint; readonly epoch: bigint }): bigint {
  return firstSlotOfEpoch(schedule, clock.epoch + 1n) - clock.slot;
}

/**
 * The warning for a leg whose transfer fee is at or within one issuer step of
 * the ceiling this keeper buys through, or which already carries a scheduled
 * rise — or null when the leg's fee is nowhere near it.
 *
 * A WARNING, NEVER A REFUSAL. The refusal is legAdmissionDecision's, at
 * MAX_LEG_FEE_BPS, and it stays exactly where it is. This says the thing the
 * refusal cannot: that the next move stops the basket. A leg at the ceiling is
 * bought today and refused tomorrow, and the only difference between the two
 * days is one transaction signed by somebody who does not answer to us.
 *
 * THE SCHEDULED FEE IS THE ONLY EARLY NOTICE ANYONE GETS. set_transfer_fee
 * writes the new rate into newer_transfer_fee stamped with the epoch it starts
 * in, about two epochs out — so between the write and the charge, the number
 * that will stop this basket is sitting in the mint's own bytes, readable, and
 * every turn until then reads it and says nothing. This turn reads those bytes
 * anyway (decodeMintFacts, for the refusal beside this), so the notice costs no
 * request, no round trip and no new dependency: only the decision to look at
 * the fee that is NOT in force yet.
 *
 * THE KEY CARRIES THE RATE, SO A WORSENING FEE IS NOT MUTED BY ITS OWN
 * WARNING. alerts.ts deduplicates by key and keeps a fired condition quiet for
 * the repeat window; a key of the mint alone would let 50 bps mute the 100 bps
 * that replaced it for as long as that window lasts, which is precisely the
 * move this exists to report. A different rate is a different condition, so it
 * fires at once, and the same rate stays quiet.
 *
 * EVERY VALUE IN `context` IS A STRING. The alerter spreads the context into
 * JSON.stringify on its way to the webhook, and a bigint throws there — inside
 * fire(), on the path whose whole purpose is that silence is never the healthy
 * state.
 */
export function legFeeCeilingAlert(input: {
  readonly mint: PublicKey;
  readonly facts: MintFacts;
  readonly currentEpoch: bigint;
}): Alert | null {
  const live = activeTransferFee(input.facts, input.currentEpoch);
  const schedule = input.facts.transferFee;
  // The fee written for a LATER epoch, which no transfer is charged yet. When
  // the newer entry's epoch has already arrived it IS the live fee above, and
  // there is nothing scheduled behind it.
  const scheduled = schedule !== null && input.currentEpoch < schedule.newer.epoch ? schedule.newer : null;
  const worst = scheduled !== null && scheduled.bps > live.bps ? scheduled.bps : live.bps;
  if (worst < LEG_FEE_WARN_BPS) return null;

  const name = input.mint.toBase58();
  // THE NEXT STEP IS MEASURED FROM THE FEE THIS LEG WILL PAY, NOT THE ONE IT
  // PAYS NOW. Read 2026-09-24: 100 live, 300 written for epoch 1043. Measured
  // from the live 100, "one more step takes it to 150" is a sentence about a
  // rate nobody will ever charge; the rate that matters is what lands after
  // the write already on chain, and one step past THAT is what stops the basket.
  const nextStep = worst + LEG_FEE_STEP_BPS;
  // A rise already written for a later epoch that lands ABOVE the ceiling is not
  // a risk, it is a date: on that epoch every turn for this basket is REFUSED,
  // with nothing signed here, nothing deployed, and nothing else to notice it.
  const dated = scheduled !== null && scheduled.bps > MAX_LEG_FEE_BPS;
  // THE FEE CAN ALSO HAVE ALREADY GONE. This runs over every leg whose bytes
  // decoded, admitted or not, so it has to be able to say "this has happened"
  // and not only "this is close" — a leg over the ceiling is refused by the gate
  // beside this one, and calling its rate "the last one admitted" would be a
  // false sentence in the message an operator wakes up to.
  const stopped = live.bps > MAX_LEG_FEE_BPS;
  const atCeiling = live.bps === MAX_LEG_FEE_BPS;
  // A SCHEDULED RATE EXACTLY ON THE CEILING IS A WARNING, NOT A DATE. It is
  // admitted — the gate is strictly greater-than — so the basket keeps being
  // bought from that epoch; what it loses is every basis point of margin. This
  // is the state the owner accepted on 2026-09-24 (MAX_LEG_FEE_BPS), and
  // calling it critical would page an operator every repeat window for a
  // decision that has already been taken.
  const scheduledAtCeiling = scheduled !== null && scheduled.bps === MAX_LEG_FEE_BPS;
  const position = stopped
    ? `already ${live.bps - MAX_LEG_FEE_BPS} bps OVER it, which is why this basket is being refused`
    : atCeiling
      ? "the last rate that is admitted"
      : `${MAX_LEG_FEE_BPS - live.bps} bps under it`;
  const nextStepWords = stopped
    ? `Every sweep refuses the whole basket while this stands — every other leg and the SOL conversion with it.`
    : dated
      ? `ANY rate above ${MAX_LEG_FEE_BPS} refuses the whole basket — every other leg and the SOL conversion with it, on every ` +
        `sweep, for as long as the fee stands.`
      : `One more step of ${LEG_FEE_STEP_BPS} bps — the smallest this issuer has used — past the ${worst} bps it ` +
        `${worst === live.bps ? "charges" : "is scheduled to charge"} takes it to ${nextStep} bps, and ANY rate above ` +
        `${MAX_LEG_FEE_BPS} refuses the whole basket — every other leg and the SOL conversion with it, on every sweep, ` +
        `for as long as the fee stands.`;

  const scheduledWords =
    scheduled === null
      ? `The mint carries no fee scheduled for a later epoch right now, so the next rise arrives with about two epochs' ` +
        `notice and this line is where it will appear.`
      : `A fee of ${scheduled.bps} bps is ALREADY written for epoch ${scheduled.epoch}, ` +
        `${scheduled.epoch - input.currentEpoch} epoch(s) from now` +
        (dated
          ? `: from that epoch this whole basket stops being bought, and nothing needs to be signed or deployed here for that to happen.`
          : scheduledAtCeiling
            ? `: EXACTLY the ceiling, the last rate that is admitted, so from that epoch this basket is still bought with no margin ` +
              `left at all, and the next write by the same key stops it.`
            : `, still under the ceiling.`);

  return {
    key: `leg-fee:${name}:${worst}`,
    severity: stopped || dated ? "critical" : "warn",
    title: stopped
      ? "A leg's transfer fee is above the ceiling: this basket is not being bought"
      : dated
        ? "A leg's scheduled transfer fee will stop this basket"
        : atCeiling
          ? "A leg's transfer fee is at the ceiling this keeper buys through"
          : scheduledAtCeiling
            ? "A leg's scheduled transfer fee lands exactly on the ceiling this keeper buys through"
            : "A leg's transfer fee is one issuer step under the ceiling",
    detail:
      `${name} charges ${live.bps} bps to transfer in epoch ${input.currentEpoch}, against the ${MAX_LEG_FEE_BPS} bps ` +
      `ceiling this keeper buys through — ${position}. ${nextStepWords} ${scheduledWords}`,
    context: {
      mint: name,
      feeBps: live.bps.toString(),
      ceilingBps: MAX_LEG_FEE_BPS.toString(),
      epoch: input.currentEpoch.toString(),
      nextStepBps: nextStep.toString(),
      ...(scheduled === null ? {} : { scheduledFeeBps: scheduled.bps.toString(), scheduledFromEpoch: scheduled.epoch.toString() }),
    },
  };
}

/** One leg's mint, as the chain returned its account. */
export interface LegMint {
  readonly mint: PublicKey;
  /** Null when the chain has no account at that address, or the read came back empty. */
  readonly account: { readonly owner: PublicKey; readonly data: Buffer } | null;
}

/** Whether every leg is one this keeper may buy; when it is, each leg's epoch-active fee, by mint. */
export type LegAdmission =
  | {
      readonly admit: true;
      /** Each leg's fee IN FORCE NOW, which is what the ceiling was judged on. */
      readonly fees: ReadonlyMap<string, TransferFeeTerms>;
      /**
       * Each leg's worst fee in any epoch this turn's transactions can land
       * in — what the SLIPPAGE is sized against, because that is what the
       * route builder models. See worstCaseTransferFee.
       */
      readonly worstCaseFees: ReadonlyMap<string, TransferFeeTerms>;
    }
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
 *
 * WHAT IT DOES NOT REFUSE IS REPORTED NEXT DOOR, NOT HERE. A leg sitting
 * exactly ON MAX_LEG_FEE_BPS is admitted — deliberately, see that constant —
 * and a leg carrying a rise already scheduled past it is admitted until the
 * epoch arrives. Both are bought today and refused later by one signature that
 * is not ours. legFeeWarnings below says so, as a separate call over the same
 * legs, so that this verdict stays one verdict for the whole basket and its
 * type keeps the exact shape the web reads it as text to check
 * (website-oficial/src/lib/vault-copy.test.ts pins this union's source, so
 * adding a field here breaks a test in another package).
 */
export function legAdmissionDecision(input: {
  readonly legs: readonly LegMint[];
  readonly currentEpoch: bigint;
  /** Slots from the Clock's slot to the next epoch; sizes worstCaseFees only, never the verdict. */
  readonly slotsLeftInEpoch: bigint;
}): LegAdmission {
  const refusals: string[] = [];
  const fees = new Map<string, TransferFeeTerms>();
  const worstCaseFees = new Map<string, TransferFeeTerms>();

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
    // THE SAME BYTES AND THE SAME EPOCH, so the two can never be about
    // different reads of the same mint.
    worstCaseFees.set(name, worstCaseTransferFee(facts, input.currentEpoch, input.slotsLeftInEpoch));
  }

  if (refusals.length === 0) return { admit: true, fees, worstCaseFees };
  return {
    admit: false,
    outcome: "REFUSED",
    detail:
      `${refusals.join("; ")} — refusing the whole basket of ${input.legs.length} leg(s), the sound ones included, ` +
      "and refusing to convert SOL toward it: a partial basket drifts from the weights the owner signed",
  };
}

/**
 * Every fee warning this basket's mints have earned, decided from the same
 * bytes the admission gate reads and over the same legs.
 *
 * A SECOND CALL, NOT A SECOND FIELD, and the reason is worth knowing before
 * anyone "tidies" it back into LegAdmission. That union is read as TEXT by
 * website-oficial/src/lib/vault-copy.test.ts, which pins its exact source to
 * prove the fee gate is one verdict for the whole basket rather than a per-leg
 * admission — so a field added there fails a test in a package that does not
 * even import this one. Keeping the notice beside the decision instead of
 * inside it costs one more walk over a couple of hundred bytes already in
 * memory, and keeps both statements true.
 *
 * IT RUNS WHETHER OR NOT THE BASKET IS ADMITTED. A basket refused today for
 * leg A's transfer hook must not swallow the notice that leg B's fee is one
 * step from stopping it forever: the refusal is this turn's problem and the
 * warning is next month's. Legs whose account is missing, whose owner is not
 * Token-2022, or whose bytes do not decode are simply skipped — every one of
 * them is already REFUSED in words by legAdmissionDecision, and a fee read out
 * of bytes that did not parse would be a number nobody should act on.
 */
export function legFeeWarnings(input: {
  readonly legs: readonly LegMint[];
  readonly currentEpoch: bigint;
}): readonly Alert[] {
  const warnings: Alert[] = [];
  for (const leg of input.legs) {
    if (leg.account === null || !leg.account.owner.equals(TOKEN_2022_PROGRAM_ID)) continue;
    let facts: MintFacts;
    try {
      facts = decodeMintFacts(leg.account.data);
    } catch {
      continue;
    }
    const alert = legFeeCeilingAlert({ mint: leg.mint, facts, currentEpoch: input.currentEpoch });
    if (alert !== null) warnings.push(alert);
  }
  return warnings;
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

// ── every leg's VENUE, at the moment the money would move ────────────────────
//
// WHAT THIS GATE IS. DEPTH AT THE TURN'S SIZE. Not price.
//
// Both quotes in ARM 2 come from ONE source in ONE instant, so a uniformly bad
// price — Jupiter quoting the whole market 30 % off — passes the ratio
// untouched. And a census of inventory is a count of UNITS, which has no
// opinion about what a unit is worth. Neither arm can tell an expensive market
// from a cheap one, and neither is trying to.
//
// THE PRICE DEFENCES, named here because they live elsewhere and because a
// reader who inherits a price guarantee nobody wrote will design around it:
//  * the owner-signed `min_out_rate_wad` floor, enforced on chain as
//    FloorTooLow. IT DECAYS. Signed once, it clears itself as the market rises
//    (a stale floor stops binding) and blocks every honest buy as the market
//    falls. A floor that always passes is not a defence.
//  * the on-chain measured delta in invest.rs, which bounds the fill against
//    what actually arrives in the vault's ATA.
//  * Pyth, via oracleConvertDecision — FOR THE SOL LEG ONLY.
//  * THE STOCK LEGS HAVE NO INDEPENDENT PRICE ANCHOR TODAY. Plainly: SPYx,
//    ANTHROPIC and FIGUREAI are priced by the venue we are buying from and by
//    a floor the owner signed once. This gate does not close that, and must
//    not be read as closing it.
//
// AND THE MOVE TO JUPITER WIDENED WHAT THAT COSTS, which belongs here rather
// than nowhere. Under Raydium the counterparty was ONE operator-configured pool
// per mint; under Jupiter it is any venue Jupiter indexes, the pool registry is
// gone from bin/keeper.mts, and the keeper passes neither `dexes` nor
// `excludeDexes` to the builder although jupiter-route.ts offers both. The vault
// PDA's signature now goes to JUP6..., which CPIs onward into whatever the route
// names. NEITHER ARM SEES THIS: ARM 1 counts the chosen venue's own inventory,
// so a seeded pool passes by being funded, and ARM 2 divides two quotes from one
// quoter, so a uniformly bad price divides out. The last bound on a stock leg is
// the owner's min_out_rate_wad — and that number is derived at policy-signing
// time from a RAYDIUM pool's mid, 5 % under it
// (solana-core/src/server/build-handler.ts over PRICED_POOLS, at
// LEG_FLOOR_MARGIN_BPS = 500), which for ANTHROPIC is the venue this migration
// exists to stop trading on. Whoever narrows this should narrow it there: an
// excludeDexes list, or a floor referenced to something the keeper still reads.
//
// This paragraph exists because of the species docs/TESTING_TRAPS.md calls
// "prose whose scope is narrower than its reading": no test catches a comment
// that is right about the mechanism and wrong about what it protects.
//
// WHY THE RAYDIUM POOL READ IS GONE. The gate used to decode a Raydium CLMM
// PoolState (mints at 73/105, vaults at 137/169) and compare the IN-SIDE
// RESERVE against the spend. That is structurally unusable for the venues the
// product must now hold: Hadron, Manifest (a central limit order book, which
// has no reserve to read) and Meteora DLMM. The one layout that works on all
// of them is the 165-byte SPL Token account, which every venue's payout
// account is, whatever the venue is — so the gate counts what the venue can
// PAY US, over the accounts the route itself names.

/**
 * How many times over the venue's inventory of the asset a hop pays us must
 * cover what that hop takes before the keeper will trade there: 50.
 *
 * A BUILD-TIME CHECK CANNOT PROTECT AGAINST A VENUE DRAINING. check:legs proved
 * every leg's depth against mainnet and passed. Two days later the leg it
 * passed — 6,700 dollars then — held 51: 0.110274669 of its own token against
 * 31.91 USDC, with any buy over about 11 dollars reverting (measured
 * 2026-09-20, three independent ways). Nothing about the leg changed; the
 * moment did. Depth is not a property of a mint or of a registry entry, it is a
 * property of the instant the swap lands in.
 *
 * DERIVED FROM THAT INCIDENT, RE-ARGUED IN OUT-UNITS. Mid was 289.36
 * USDC/token. The product's DEFAULT purchase is $5:
 *  * one leg at 10000 bps: the turn takes 0.014936 tokens against 0.110274669
 *    held — 7.4x cover;
 *  * three legs at 3333 bps: $1.6667 takes 0.005474 — 20.1x cover.
 * A bound has to clear the WORSE of those with room, so 20.1x becomes 50x.
 * Both are far under 50, so the drained venue is refused at the size the
 * product actually buys at — which is the size that matters, because $5 is
 * UNDER the ~$11 revert threshold: that venue would have FILLED and taken the
 * owner's money.
 *
 * WHY 50 CARRIES OVER FROM THE OLD IN-SIDE-RESERVE BOUND UNCHANGED, and is not
 * a coincidence. On a two-sided AMM, inventory cover and in-side-reserve cover
 * are THE SAME RATIO at the quoted rate:
 *     inventory / (spend / price)  ==  (inventory * price) / spend
 * so the old derivation transfers exactly, and the three-leg replay gives 20.1x
 * here where the old gate gave 19.1x — the two gates agree on the case both can
 * see. It is restated in out-units because a CLOB and a DLMM have no in-side
 * reserve to count at all.
 *
 * AND WHAT IT COSTS ON A VENUE THAT IS FINE. The live SPYx pool held 9,389.405679
 * USDC that night, its 0.5 % impact size measured at 350 USD and 598 six minutes
 * later. 50x admits 187.79 USDC of inventory-equivalent — about half the
 * SMALLER measurement, so roughly 27 bps of impact. It still refuses the 333 USD
 * leg a $1,000 max_per_call splits three ways (28x cover), which is exactly the
 * size that venue was measured NOT to absorb quietly.
 */
export const MIN_VENUE_INVENTORY_MULTIPLE = 50n;

/**
 * What ARM 2 allows of the turn's OWN price impact, as a fraction of the
 * usable slippage tolerance: a quarter.
 *
 * DERIVED FROM THE SLIPPAGE BUDGET, NOT FROM ARM 1's INCIDENT — deliberately,
 * because calibrating both arms off one measurement would make them one gate
 * wearing two hats.
 *
 * Usable tolerance T = slippageBps - feeBps is the WHOLE budget between the
 * quote and the fill on a gross-quoting venue (measured across the 1038 -> 1039
 * boundary: 100 bps of slippage against a 100 bps fee reverts with 0x1771 at 5,
 * 25 and 250 USD; 200 against 100 fills). T has to cover market drift AND our
 * own impact, and DRIFT DOMINATES — the same SPYx venue's 0.5 % size moved
 * 350 -> 598 in six minutes, a 70 % swing — so impact gets a quarter and drift
 * three quarters.
 *
 * ANTHROPIC at a 100 bps fee: (200 - 100) / 4 = 25 bps. At the 300 bps the
 * issuer wrote for epoch 1043 (read 2026-09-24): legSlippageBps(300) = 400, so
 * (400 - 300) / 4 = 25 bps again — the slippage moves with the fee and the
 * impact bar does not. A zero-fee mint: 50 bps.
 *
 * CROSS-CHECKED AGAINST A MEASUREMENT TAKEN FOR ANOTHER PURPOSE: 187.79 USDC
 * into the healthy venue measured ~27 bps when that mint charged 50 bps, so
 * T = 150 and the ceiling 37 bps — 27 passes with room.
 */
export const IMPACT_TOLERANCE_DIVISOR = 4n;

/**
 * The floor under that ceiling, so a mint whose fee eats the whole tolerance
 * still gets a finite, non-zero bar rather than "any impact at all refuses".
 * At 5 bps, a venue moving half a tenth of a percent on our size is admitted.
 */
export const MIN_IMPACT_CEILING_BPS = 5n;

/**
 * The turn's size divided by this is ARM 2's probe: a sixteenth.
 *
 * SMALL ENOUGH THAT THE PROBE'S OWN IMPACT IS NOISE. Under any convex impact
 * curve a 1/16 size contributes at most 1/16 of the turn's impact — under
 * 1.6 bps against a 25 bps ceiling — so the probe's rate is a fair stand-in for
 * the undisturbed one.
 */
export const PROBE_DIVISOR = 16n;

/**
 * And never smaller than a dollar (USDC's six decimals).
 *
 * LARGE ENOUGH TO BE QUOTED: jupiter-sim.ts's measured sizes are 5, 25 and 250
 * USD, and $1 is the smallest these venues were observed to answer at all. A
 * probe nobody answers is an abstention, not a measurement.
 */
export const MIN_PROBE_RAW = 1_000_000n;

/**
 * How far ABOVE the destination mint's transfer fee a leg's slippage must be
 * quoted: 100 bps.
 *
 * STRICTLY ABOVE THE FEE, AND BY A MEASURED MARGIN. 100 over 100 reverts by ONE
 * RAW UNIT — Jupiter floors its deduction and Token-2022 ceils its fee — and
 * 200 over 100 fills. So equality is provably fatal and the margin is at least
 * 100 bps. legSlippageBps() re-quotes automatically the day the issuer moves the
 * fee, instead of reverting every sweep with no explanation — and it already
 * has: from the moment 300 bps was written for epoch 1043 (read 2026-09-24),
 * a PreStock leg's worst-case fee is 300 and it is quoted at 400.
 *
 * THE COST, STATED WHERE THE TRADE IS MADE: a wider slippage is a LOOSER
 * per-call floor out of investMinOut. This gate does not compensate for that,
 * because this gate does not measure price — the owner's min_out_rate_wad and
 * invest.rs's measured delta do, and both are named at the top of this section.
 *
 * min-out.ts's SLIPPAGE_BPS stays 200n: that is the keeper's own bound on a
 * captured rate, and this is a floor under what we ASK JUPITER FOR.
 */
export const MIN_SLIPPAGE_MARGIN_BPS = 100n;

/**
 * SPL Token's Account, the ONLY layout this gate decodes:
 *   mint 0..32, owner 32..64, amount 64..72 little-endian.
 *
 * 165 bytes is all of an SPL Token account and the PREFIX of every Token-2022
 * one, so the same three fields sit at the same three offsets under both
 * programs. Same reasoning and same offsets as venue_route.rs and as
 * findVaultOwnedTokenAccounts — which is what lets the census and the
 * vault-ownership pass agree about what they are looking at.
 */
export interface TokenAccountFacts {
  readonly mint: PublicKey;
  readonly owner: PublicKey;
  readonly amount: bigint;
}

const TOKEN_ACCOUNT_BYTES = 165;

/** What a token account is and holds, out of its own bytes. Throws under 165. */
export function decodeTokenAccountFacts(data: Buffer): TokenAccountFacts {
  if (data.length < TOKEN_ACCOUNT_BYTES) {
    throw new Error(`an SPL token account is at least ${TOKEN_ACCOUNT_BYTES} bytes; this account is ${data.length}`);
  }
  return {
    mint: new PublicKey(data.subarray(0, 32)),
    owner: new PublicKey(data.subarray(32, 64)),
    amount: data.readBigUInt64LE(64),
  };
}

/** One account the route names, as the chain returned it. */
export interface VenueAccount {
  readonly address: PublicKey;
  /** The PROGRAM that owns the account — the SPL Token or Token-2022 program, for one we can read. */
  readonly owner: PublicKey;
  readonly data: Buffer;
}

/**
 * ARM 1's answer for one hop: how much of the asset this hop pays us the venue
 * can actually hand over, or why that could not be established at all.
 *
 * `counted: false` IS NEVER A PASS. An unmeasurable depth is not a depth — the
 * same sentence the retired readPoolPair used, and for the same reason.
 */
export type InventoryCensus =
  | { readonly counted: true; readonly inventory: bigint; readonly accounts: number }
  | { readonly counted: false; readonly why: string };

/**
 * ARM 1, over one MINT: how much of it the route's own accounts can pay us,
 * summed from the accounts the ROUTE ITSELF names.
 *
 * ROUTE-WIDE, NOT VENUE BY VENUE, AND THE DIFFERENCE IS NOT COSMETIC. This
 * function is handed every account the route resolves to and sums the ones
 * holding `payMint`. On a multi-venue route those accounts belong to SEVERAL
 * venues — measured 2026-09-21 on the live 2-hop USDC -> ANTHROPIC route at the
 * $1,000 cap, the wSOL side counts FOUR writable wSOL accounts totalling
 * 320,616,245,011 raw, one of which (33.6 SOL) pays us nothing at all. Jupiter's
 * flat account list carries no attribution of an account to a hop, and deriving
 * one would mean decoding each venue's own layout — the per-venue reading this
 * gate was rewritten to stop doing, because a CLOB and a DLMM have no reserve
 * to read.
 *
 * SO THE TAKE IS SUMMED THE SAME WAY, and that is the fix for what this
 * asymmetry used to allow. censusHops groups a route's hops BY THE MINT THEY
 * PAY US and judges one summed take against one summed inventory. Before it
 * did, a PARALLEL SPLIT — Jupiter's other routePlan shape, where every step
 * outputs the target and carries its own `percent` — was censused once per
 * sliver: USDC -> FIGUREAI at $5,000 measured live as Raydium CLMM 4 % +
 * Hadron 94 % + Manifest 2 %, and the Raydium sliver's 1.81x cover of its own
 * pool read as 1,199.77x because the other two venues' inventory was counted
 * against one twenty-fifth of the buy. Summed both ways the same route reads
 * 48.06x and is refused.
 *
 * WHAT THIS BOUND THEREFORE CLAIMS, exactly: the writable non-vault accounts
 * this route names hold at least 50x what this route takes of that mint. It
 * does NOT claim that each venue separately holds 50x its own share, and a
 * refusal naming several venues is naming them all, not one.
 *
 * AN ACCOUNT IS COUNTED WHEN, AND ONLY WHEN, all five hold:
 *  1. its program owner is the SPL Token or the Token-2022 program — anything
 *     else is not a token account and these offsets mean something else;
 *  2. it is at least 165 bytes, so the three fields are really there;
 *  3. its mint is the mint this hop pays us in;
 *  4. THE ROUTE MARKS IT WRITABLE. A source of funds must be writable; a
 *     read-only account cannot pay us, and counting one admits a venue that
 *     has the units but cannot move them;
 *  5. IT IS NOT VAULT-OWNED. See below — this is the gate, not hygiene.
 *
 * THE VAULT-OWNED EXCLUSION IS NOT HYGIENE, IT IS THE GATE. `vaultTarget` (the
 * destination ATA) is in the route's account list BY CONSTRUCTION, and the
 * vault accumulates the very stock it buys. Counting it makes the census grow
 * with our own holdings until a drained venue is admitted — a gate that loosens
 * itself every turn, and loosens fastest for the vaults that have bought most.
 * The set comes from findVaultOwnedTokenAccounts, which already derives vault
 * ATAs under BOTH token programs for every mint in the route and reads owner
 * bytes 32..64 with a 165-byte minimum. REUSE IT, NEVER RE-DERIVE: two lists
 * built two ways are two lists that can disagree.
 */
export function censusVenueInventory(input: {
  /** The mint THIS hop pays us in. */
  readonly payMint: PublicKey;
  /** Every account the route names, RESOLVED — post address-lookup-table, as the chain returned them. */
  readonly candidates: readonly VenueAccount[];
  /** The addresses the route marks writable. */
  readonly writable: ReadonlySet<string>;
  /** findVaultOwnedTokenAccounts' answer. EXCLUDED. */
  readonly vaultOwned: ReadonlySet<string>;
}): InventoryCensus {
  let inventory = 0n;
  let accounts = 0;
  for (const candidate of input.candidates) {
    const address = candidate.address.toBase58();
    if (!candidate.owner.equals(TOKEN_PROGRAM_ID) && !candidate.owner.equals(TOKEN_2022_PROGRAM_ID)) continue;
    // THE LENGTH IS CHECKED HERE AND NOWHERE ELSE IN THIS LOOP. It used to be
    // checked here AND caught from decodeTokenAccountFacts, and the second one
    // could not be made to fire: remove this line and the decoder's own throw
    // was swallowed, so the census behaved identically and no test could tell
    // the two versions apart. A guard with no red case is not a guard
    // (docs/TESTING_TRAPS.md), so there is one check and the decoder below is
    // reached only when it has passed.
    if (candidate.data.length < TOKEN_ACCOUNT_BYTES) continue;
    if (input.vaultOwned.has(address)) continue;
    if (!input.writable.has(address)) continue;
    const facts = decodeTokenAccountFacts(candidate.data);
    if (!facts.mint.equals(input.payMint)) continue;
    inventory += facts.amount;
    accounts += 1;
  }
  if (accounts === 0) {
    return {
      counted: false,
      why:
        `names no writable, non-vault token account holding ${input.payMint.toBase58()}, so there is nothing that ` +
        "can pay us this hop and no depth to measure — and an unmeasurable depth is not a depth",
    };
  }
  return { counted: true, inventory, accounts };
}

/** ARM 2's probe size for a turn of this size: a sixteenth, never under a dollar. */
export function probeAmount(spend: bigint): bigint {
  const sixteenth = spend / PROBE_DIVISOR;
  return sixteenth > MIN_PROBE_RAW ? sixteenth : MIN_PROBE_RAW;
}

/** out per in, in wad. Zero in is zero rate: a quote of nothing prices nothing. */
export function impliedRateWad(inRaw: bigint, outRaw: bigint): bigint {
  if (inRaw <= 0n) return 0n;
  return (outRaw * 10n ** 18n) / inRaw;
}

/**
 * How much worse the TURN's implied rate is than the PROBE's, in bps.
 *
 * Clamped at zero when the turn quotes BETTER than the probe, which happens:
 * a fixed per-hop fee is a larger share of a small size, so a probe can come
 * back worse than the turn on a venue that is perfectly deep. A negative
 * "impact" is not evidence of anything and must not read as credit.
 */
export function venueImpactBps(turnRateWad: bigint, probeRateWad: bigint): bigint {
  if (probeRateWad <= 0n) return 0n;
  if (turnRateWad >= probeRateWad) return 0n;
  return (10_000n * (probeRateWad - turnRateWad)) / probeRateWad;
}

/**
 * What this turn would take out of the route at the rate the PROBE quoted:
 * spend * probeOut / probeIn, floored to a raw unit.
 *
 * WHY THE PROBE IS THE RIGHT REFERENCE HERE, AND WHY IT IS USED EVEN WHEN ARM 2
 * REFUSES TO USE IT. ARM 2 divides two rates to measure IMPACT, so it abstains
 * the moment the two quotes took different venues — the rates would not be two
 * sizes of one thing. This is a different question: what SHOULD this turn take
 * out, in the mint's own units, independently of what the venue we are about to
 * trade with says. A probe that routed elsewhere answers that BETTER, not
 * worse, because it is a second opinion rather than the same one at another
 * size. So the floor applies whenever a probe answered at all.
 *
 * SCOPE, BESIDE THE CLAIM. The probe is a sixteenth (never under a dollar) and
 * comes from the same quoter, so it is an undisturbed rate and NOT an
 * independent price: a market Jupiter quotes uniformly badly moves this number
 * with it, and nothing in this gate sees that. What it does close is the venue
 * that flatters its own cover by quoting the turn worse at size.
 *
 * ZERO WHEN THERE IS NOTHING TO GO ON — no probe, no spend — and zero never
 * lifts anything, because the caller takes the larger of the two.
 */
export function takeAtProbeRate(spend: bigint, probeIn: bigint, probeOut: bigint): bigint {
  if (spend <= 0n || probeIn <= 0n || probeOut <= 0n) return 0n;
  return (spend * probeOut) / probeIn;
}

/** The most of ARM 2's impact this leg may show: a quarter of the usable tolerance, never under 5 bps. */
export function maxTurnImpactBps(slippageBps: bigint, feeBps: bigint): bigint {
  const usable = slippageBps - feeBps;
  const quarter = usable <= 0n ? 0n : usable / IMPACT_TOLERANCE_DIVISOR;
  return quarter > MIN_IMPACT_CEILING_BPS ? quarter : MIN_IMPACT_CEILING_BPS;
}

/**
 * The slippage a leg with this transfer fee must be QUOTED at: the keeper's own
 * 200 bps, or strictly above the fee by MIN_SLIPPAGE_MARGIN_BPS, whichever is
 * larger.
 *
 * THIS IS WHERE THE 100-OVER-100 REVERT IS MADE UNREACHABLE. At a 100 bps fee
 * this returns 200 — the margin that was measured to fill. At the ceiling of
 * 300 it returns 400 by itself (ANTHROPIC's worst-case fee since 300 was
 * written for epoch 1043), rather than the keeper quoting 200 against 300 and
 * reverting every sweep with 0x1771 and no explanation.
 */
export function legSlippageBps(feeBps: bigint): bigint {
  const floor = feeBps + MIN_SLIPPAGE_MARGIN_BPS;
  return floor > SLIPPAGE_BPS ? floor : SLIPPAGE_BPS;
}

/**
 * ARM 2's answer for one leg.
 *
 * `compared: false` IS AN ABSTENTION, NEVER A PASS, AND ALWAYS LOGGED. Jupiter
 * re-picks venues constantly — measured 2026-09-21, a 25 USD USDC->ANTHROPIC
 * turn routed Kipseli+Manifest while the $1 probe of the same instant routed
 * Byreal+Manifest — so a gate that refused on a re-route would refuse routinely,
 * and a gate that refuses routinely is a gate an operator turns off. When ARM 2
 * abstains, ARM 1 carries the leg alone; legDepthDecision refuses outright only
 * when NEITHER arm measured anything.
 */
export type ImpactProbe =
  | { readonly compared: true; readonly impactBps: bigint; readonly ceilingBps: bigint }
  | { readonly compared: false; readonly why: string };

/**
 * ONE MINT A LEG'S ROUTE PAYS US, as one turn measured it — not one step of the
 * routePlan. A chain gives one of these per intermediate mint plus one for the
 * target; a parallel SPLIT gives exactly one, whose take is the sum of the
 * slivers and whose label names every venue that pays it. censusHops says why.
 *
 * WHICH SIDE A HOP IS MEASURED ON, AND WHY EITHER WILL DO. On a Jupiter route
 * `payMint` is the mint the hop PAYS US and `takeRaw` is what it hands over —
 * the only side a CLOB or a DLMM has an account for. The Raydium CLMM adapter
 * — unreachable since the move to Jupiter on 2026-09-21, deleted on 2026-09-23
 * (venue-depth.ts says why) — measured the side we SPEND INTO instead, because
 * a pool state quotes no price the gate could convert with and a
 * constant-product reading of a concentrated pool is measurably wrong (it put
 * one venue's 0.5 % size at 47 dollars where the venue served 350). The type
 * still admits both sides, and the ratio below is why.
 *
 * THE TWO ARE THE SAME RATIO, which is what makes one constant cover both:
 *     inventory / (spend / price)  ==  (inventory * price) / spend
 * so 50x of the out-side inventory and 50x of the in-side reserve are the same
 * bound at the quoted rate. The refusal therefore says the neutral thing — what
 * this turn would MOVE THROUGH the venue — rather than claiming a direction the
 * reader would then have to check.
 *
 * AND THE EQUIVALENCE HOLDS AT ONE PRICE, WHICH IS THE CATCH `quotedTakeRaw`
 * ANSWERS. `price` in that identity is the price the trade actually gets, and on
 * a Jupiter route the out-side number IS the venue's own quote — so a venue
 * quoting us d times worse divides the take by d and multiplies the cover by d.
 * The in-side reading had no such handle, because the spend is ours. takeRaw is
 * therefore floored at what the probe's rate implies before any of this is
 * judged; see takeAtProbeRate for what that does and does not close.
 */
export interface LegVenueHop {
  /** The venue labels that pay this mint, joined — for the refusal text only. */
  readonly label: string;
  /** The mint this hop's inventory is counted in. */
  readonly payMint: PublicKey;
  /**
   * What this turn moves through the route on that side, in that mint's raw
   * units — the number the cover is measured against, and never smaller than
   * what the undisturbed rate implies (see quotedTakeRaw and takeAtProbeRate).
   */
  readonly takeRaw: bigint;
  /**
   * What the VENUE'S OWN QUOTE said it would hand over, present only when it
   * was smaller than takeRaw and a floor lifted it.
   *
   * THE PROPERTY THIS FIELD EXISTS TO RESTORE. On main the denominator was the
   * keeper's own spend — an in-unit nothing on the venue's side of the trade
   * chose — and the doc said what that bought: "the test needs no price, and no
   * quote from the venue being traded against can flatter it". Moving to
   * out-units to reach a CLOB and a DLMM made the denominator `outAmount`,
   * which IS that venue's quote, so a venue quoting us WORSE measured as
   * DEEPER: degrade the quote by d and the cover is multiplied by 1/d. Judging
   * against the larger of the two numbers takes that back. It does not make the
   * gate price-proof — a market quoted uniformly badly moves both numbers, and
   * §0 above names the defences for that — but a venue can no longer buy cover
   * by pricing us badly at size.
   */
  readonly quotedTakeRaw?: bigint;
  readonly census: InventoryCensus;
}

/** One leg, as one turn measured it. */
export interface LegVenue {
  readonly mint: PublicKey;
  /** In-asset raw this turn pushes at THIS leg. */
  readonly spend: bigint;
  /** Jupiter's AMM labels, for the refusal text only. */
  readonly venueLabels: readonly string[];
  readonly hops: readonly LegVenueHop[];
  /**
   * THE SCOPE BESIDE THE CLAIM. "every-hop" means every hop of this route was
   * censused; "final-only" means at least one intermediate hop was not — its
   * outAmount was absent — so the verdict is about the last hop alone and SAYS
   * SO. The final hop is always censused or the leg is refused.
   */
  readonly censusScope: "every-hop" | "final-only";
  readonly impact: ImpactProbe;
}

/** Whether every leg's venue can serve this turn's share of it with margin. */
export type DepthDecision =
  | { readonly deep: true }
  | { readonly deep: false; readonly outcome: "REFUSED"; readonly detail: string };

/** Inventory's cover of what a hop takes, for a refusal a human has to act on: "7.4x", "0.0x". */
function cover(inventory: bigint, take: bigint): string {
  if (take <= 0n) return "unbounded";
  return `${(Number(inventory) / Number(take)).toFixed(1)}x`;
}

/**
 * Whether the venues this turn would trade against can actually serve it,
 * measured at the moment of the turn and against the amount this turn would
 * really spend on each leg.
 *
 * THE GATE check:legs CANNOT BE. A build-time check proves a venue was deep
 * when the check ran. This one refuses the turn when the venue is shallow NOW,
 * which is the only tense in which money moves. It runs beside the unroutable-leg
 * and mint-admission refusals, BEFORE anything is wrapped or converted, so a
 * basket that cannot be bought never costs the owner their SOL exposure on the
 * way to finding out.
 *
 * ALL OR NOTHING IS THE TYPE, NOT A CONVENTION. DepthDecision carries ONE
 * verdict and no per-leg outcome, so a half-basket is UNREPRESENTABLE: there is
 * no shape this function could return that says "buy two of the three". Buying
 * only the legs whose venues happen to be deep drifts the weights onto whatever
 * survived, which is not the basket the owner signed. The SOL conversion is
 * refused with them, and it is refused before the wrap.
 *
 * (packages/website-oficial/src/lib/vault-copy.test.ts pins that union's SOURCE
 * TEXT with a regex — deliberately, to make a per-leg escape hatch expensive.
 * Keep those two lines verbatim; see docs/TESTING_TRAPS.md, third species.)
 *
 * THE FOUR REFUSALS, and why the fourth is not redundant:
 *  1. a hop whose census could not be taken at all;
 *  2. a hop whose inventory is under MIN_VENUE_INVENTORY_MULTIPLE x what it takes;
 *  3. ARM 2 compared, and the turn's own impact is over the ceiling;
 *  4. "final-only" AND ARM 2 abstained — the ONE combination in which nothing
 *     measured this turn either hop-wise or end-to-end. Neither arm alone fires
 *     here, which is exactly why it needs its own line.
 */
export function legDepthDecision(input: {
  /** The policy's in_mint — the side the spend is denominated in. */
  readonly inMint: PublicKey;
  readonly legs: readonly LegVenue[];
}): DepthDecision {
  const refusals: string[] = [];

  for (const leg of input.legs) {
    const venues = leg.venueLabels.length > 0 ? leg.venueLabels.join(" + ") : "an unnamed venue";
    const name = `${leg.mint.toBase58()} (via ${venues})`;
    const refuse = (reason: string): number => refusals.push(`${name} ${reason}`);
    // A leg whose share rounds to nothing is a leg this turn sends no
    // transaction for (the swap loop skips it), so there is no spend to serve
    // and no venue to judge.
    if (leg.spend <= 0n) continue;

    let hopRefused = false;
    for (const hop of leg.hops) {
      if (!hop.census.counted) {
        refuse(`cannot be measured at its ${hop.label} hop: it ${hop.census.why}`);
        hopRefused = true;
        continue;
      }
      const required = hop.takeRaw * MIN_VENUE_INVENTORY_MULTIPLE;
      if (hop.census.inventory < required) {
        refuse(
          `holds ${hop.census.inventory} raw of ${hop.payMint.toBase58()} across ${hop.census.accounts} account(s) at its ` +
            `${hop.label} hop(s) — counted route-wide for that mint, not venue by venue — ` +
            `against the ${hop.takeRaw} this turn would move through it` +
            (hop.quotedTakeRaw === undefined
              ? ""
              : ` (the route quoted ${hop.quotedTakeRaw}; judged at the undisturbed rate the probe implies, so a venue ` +
                "cannot read as deeper by quoting us worse)") +
            ` — ${cover(hop.census.inventory, hop.takeRaw)} ` +
            `cover, under the ${MIN_VENUE_INVENTORY_MULTIPLE}x this keeper trades on (it would need ${required})`,
        );
        hopRefused = true;
      }
    }

    if (leg.impact.compared && leg.impact.impactBps > leg.impact.ceilingBps) {
      refuse(
        `quotes ${leg.impact.impactBps} bps worse at this turn's size than at a sixteenth of it, over the ` +
          `${leg.impact.ceilingBps} bps this keeper allows — the units are there but not at this price, which a ` +
          "count of units cannot see",
      );
      continue;
    }

    // NOTHING MEASURED IT EITHER WAY. Not a hop census (an intermediate hop's
    // outAmount was absent, so only the final hop was counted) and not an
    // end-to-end comparison (the probe took a different route). Refusing here
    // is the difference between "both arms passed" and "neither arm ran".
    if (!hopRefused && leg.censusScope === "final-only" && !leg.impact.compared) {
      refuse(
        "was measured at its final hop only — an earlier hop reported no out-amount to census — and the " +
          `end-to-end probe abstained (${leg.impact.why}), so nothing measured this turn's depth at its own size`,
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
      "Venue depth is measured in the turn, not at build time: a venue that passed check:legs days ago can be " +
      `drained now, and the spend is denominated in ${input.inMint.toBase58()}`,
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
