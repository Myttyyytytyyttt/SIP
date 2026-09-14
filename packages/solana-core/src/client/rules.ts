// The program's own validation rules, so a bad policy is refused with words
// before anyone is asked to sign a transaction the chain will bounce.
//
// Mirrors packages/solana-program/programs/sip-vault/src/state.rs
// (validate_policy, MODE_*, *_BPS_*) and instructions/set_invest_policy.rs. The
// IDL carries none of these constants, so test/rules.test.ts reads the Rust
// source and pins every number here to it. Browser-safe: the forms use the same
// functions the server builders use.

import { DEFAULT_PUBKEY, isPubkey } from "./base58";
import { IDL_VEC_MAX_LEN } from "./idl";

export const MODE_PROFIT = 0;
export const MODE_VOLUME = 1;
export const PROFIT_BPS_MIN = 101;
export const PROFIT_BPS_MAX = 10_000;
export const VOLUME_BPS_MIN = 1;
export const VOLUME_BPS_MAX = 100;
/** state.rs MAX_LEGS, through the IDL vec bound so there is one copy of the number. */
export const MAX_LEGS: number = IDL_VEC_MAX_LEN.InvestmentPolicy!.legs!;
export const LEG_WEIGHT_TOTAL_BPS = 10_000;

export const U64_MAX = (1n << 64n) - 1n;
export const U128_MAX = (1n << 128n) - 1n;

const isInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);
const inU64 = (value: unknown): value is bigint => typeof value === "bigint" && value >= 0n && value <= U64_MAX;
const inU128 = (value: unknown): value is bigint => typeof value === "bigint" && value >= 0n && value <= U128_MAX;

export interface VaultPolicyInput {
  /** MODE_PROFIT (0) or MODE_VOLUME (1). */
  readonly mode: number;
  /** Profit rate, 101..=10000 bps. Required valid in BOTH modes (validate_policy checks both). */
  readonly skimBps: number;
  /** Volume rate, 1..=100 bps. Required valid in BOTH modes. */
  readonly volumeBps: number;
  /** Lamports; > 0. */
  readonly maxContribution: bigint;
  /** Lamports; >= 0. */
  readonly walletReserve: bigint;
}

/** create_vault_v2 / set_policy_v2 arguments against validate_policy. Empty when the chain would accept them. */
export function vaultPolicyProblems(input: VaultPolicyInput): string[] {
  const problems: string[] = [];
  if (input.mode !== MODE_PROFIT && input.mode !== MODE_VOLUME) problems.push("mode must be 0 (profit) or 1 (volume)");
  if (!isInt(input.skimBps) || input.skimBps < PROFIT_BPS_MIN || input.skimBps > PROFIT_BPS_MAX) {
    problems.push(`skimBps (the profit rate) must be an integer from ${PROFIT_BPS_MIN} to ${PROFIT_BPS_MAX}, whatever the mode`);
  }
  if (!isInt(input.volumeBps) || input.volumeBps < VOLUME_BPS_MIN || input.volumeBps > VOLUME_BPS_MAX) {
    problems.push(`volumeBps (the volume rate) must be an integer from ${VOLUME_BPS_MIN} to ${VOLUME_BPS_MAX}, whatever the mode`);
  }
  if (!inU64(input.maxContribution) || input.maxContribution === 0n) problems.push("maxContribution must be a u64 greater than zero");
  if (!inU64(input.walletReserve)) problems.push("walletReserve must be a u64 (zero or more)");
  return problems;
}

export interface InvestLegInput {
  readonly mint: string;
  readonly weightBps: number;
  /** WAD (1e18) floor, out-raw per in-raw; > 0. */
  readonly minOutRateWad: bigint;
}

export interface InvestPolicyInput {
  readonly legs: readonly InvestLegInput[];
  readonly venueProgram: string;
  readonly inMint: string;
  readonly minConvertRateWad: bigint;
  readonly minInvestment: bigint;
  readonly maxPerCall: bigint;
  readonly maxRolling30d: bigint;
  readonly enabled: boolean;
}

/** set_invest_policy arguments against set_invest_policy.rs. Empty when the chain would accept them. */
export function investPolicyProblems(input: InvestPolicyInput): string[] {
  const problems: string[] = [];
  const legs = Array.isArray(input.legs) ? input.legs : [];
  if (legs.length === 0 || legs.length > MAX_LEGS) problems.push(`a basket has between 1 and ${MAX_LEGS} legs`);
  const mints = new Set<string>();
  let total = 0;
  legs.forEach((leg, index) => {
    const at = `leg #${index + 1}`;
    if (!isPubkey(leg.mint)) problems.push(`${at}: the mint is not a base58 32-byte address`);
    else if (mints.has(leg.mint)) problems.push(`${at}: repeats a mint already in the basket`);
    else mints.add(leg.mint);
    if (!isInt(leg.weightBps) || leg.weightBps <= 0 || leg.weightBps > 0xffff) problems.push(`${at}: the weight must be a positive integer (bps)`);
    else total += leg.weightBps;
    if (!inU128(leg.minOutRateWad) || leg.minOutRateWad === 0n) problems.push(`${at}: the min-out floor must be a u128 greater than zero`);
  });
  if (legs.length > 0 && total !== LEG_WEIGHT_TOTAL_BPS) problems.push(`the weights must sum to exactly ${LEG_WEIGHT_TOTAL_BPS} bps, got ${total}`);
  if (!isPubkey(input.inMint) || input.inMint === DEFAULT_PUBKEY) problems.push("inMint must be a real mint (not the default key)");
  else if (mints.has(input.inMint)) problems.push("inMint cannot also be a mint the basket buys");
  if (!isPubkey(input.venueProgram)) problems.push("venueProgram is not a base58 32-byte address");
  else if (input.enabled && input.venueProgram === DEFAULT_PUBKEY) problems.push("an enabled policy needs a venue program");
  if (!inU128(input.minConvertRateWad)) problems.push("minConvertRateWad must be a u128");
  if (!inU64(input.minInvestment) || !inU64(input.maxPerCall) || !inU64(input.maxRolling30d)) {
    problems.push("minInvestment, maxPerCall and maxRolling30d must be u64 amounts");
  } else if (!(input.minInvestment > 0n && input.minInvestment <= input.maxPerCall && input.maxPerCall <= input.maxRolling30d)) {
    problems.push("the caps must satisfy 0 < minInvestment <= maxPerCall <= maxRolling30d");
  }
  if (typeof input.enabled !== "boolean") problems.push("enabled must be a boolean");
  return problems;
}
