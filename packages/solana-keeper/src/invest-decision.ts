// Which in-asset this keeper can invest from, whether it may invest at all,
// whether it may convert the vault's SOL to get there, and how much of that SOL
// one turn may wrap, as pure decisions.
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

import { PublicKey } from "@solana/web3.js";
import type { Alert } from "./alerts.js";

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
