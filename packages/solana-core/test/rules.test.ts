// The browser-safe validation rules, pinned to the Rust source they mirror.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { RAYDIUM_CLMM, SYSTEM_PROGRAM, USDC_MINT } from "../src/client/addresses";
import {
  LEG_WEIGHT_TOTAL_BPS,
  MAX_LEGS,
  MODE_PROFIT,
  MODE_VOLUME,
  PROFIT_BPS_MAX,
  PROFIT_BPS_MIN,
  VOLUME_BPS_MAX,
  VOLUME_BPS_MIN,
  investPolicyProblems,
  vaultPolicyProblems,
  type InvestPolicyInput,
  type VaultPolicyInput,
} from "../src/client/rules";
import { keypair } from "./helpers";

const require = createRequire(import.meta.url);
const SRC = join(dirname(require.resolve("@sip/solana-program/package.json")), "programs/sip-vault/src");
const STATE_RS = readFileSync(join(SRC, "state.rs"), "utf8");
const SET_INVEST_RS = readFileSync(join(SRC, "instructions/set_invest_policy.rs"), "utf8");

const rustConst = (name: string): number => {
  const match = new RegExp(`pub const ${name}: \\w+ = ([0-9_]+);`).exec(STATE_RS);
  if (match === null) throw new Error(`state.rs has no ${name}`);
  return Number(match[1]!.replaceAll("_", ""));
};

describe("the constants equal state.rs", () => {
  it("modes, rate bounds and the leg cap", () => {
    expect(MODE_PROFIT).toBe(rustConst("MODE_PROFIT"));
    expect(MODE_VOLUME).toBe(rustConst("MODE_VOLUME"));
    expect(PROFIT_BPS_MIN).toBe(rustConst("PROFIT_BPS_MIN"));
    expect(PROFIT_BPS_MAX).toBe(rustConst("PROFIT_BPS_MAX"));
    expect(VOLUME_BPS_MIN).toBe(rustConst("VOLUME_BPS_MIN"));
    expect(VOLUME_BPS_MAX).toBe(rustConst("VOLUME_BPS_MAX"));
    expect(MAX_LEGS).toBe(rustConst("MAX_LEGS"));
  });

  it("the basket rules are the ones set_invest_policy.rs requires", () => {
    expect(SET_INVEST_RS).toContain("legs.len() <= MAX_LEGS");
    expect(SET_INVEST_RS).toContain(`weights == ${LEG_WEIGHT_TOTAL_BPS.toLocaleString("en-US").replace(",", "_")}`);
    expect(SET_INVEST_RS).toContain("in_mint != Pubkey::default() && !mints.contains(&in_mint)");
    expect(SET_INVEST_RS).toContain("min_investment > 0 && min_investment <= max_per_call && max_per_call <= max_rolling_30d");
    expect(STATE_RS).toContain("require!(max_contribution > 0");
  });
});

const policy = (overrides: Partial<VaultPolicyInput> = {}): VaultPolicyInput => ({
  mode: MODE_VOLUME,
  skimBps: 2_000,
  volumeBps: 10,
  maxContribution: 1_000_000_000n,
  walletReserve: 5_000_000n,
  ...overrides,
});

describe("vaultPolicyProblems", () => {
  it("accepts a valid policy, including a zero wallet reserve", () => {
    expect(vaultPolicyProblems(policy())).toEqual([]);
    expect(vaultPolicyProblems(policy({ walletReserve: 0n, mode: MODE_PROFIT }))).toEqual([]);
  });

  it.each([
    ["skim 100", { skimBps: 100 }],
    ["skim 10001", { skimBps: 10_001 }],
    ["volume 0", { volumeBps: 0 }],
    ["volume 101", { volumeBps: 101 }],
    ["mode 2", { mode: 2 }],
    ["max contribution 0", { maxContribution: 0n }],
    ["negative reserve", { walletReserve: -1n }],
    ["fractional skim", { skimBps: 150.5 }],
  ] as const)("refuses %s", (_, overrides) => {
    expect(vaultPolicyProblems(policy(overrides as Partial<VaultPolicyInput>)).length).toBeGreaterThan(0);
  });
});

const spyx = keypair().publicKey.toBase58();
const invest = (overrides: Partial<InvestPolicyInput> = {}): InvestPolicyInput => ({
  legs: [{ mint: spyx, weightBps: 10_000, minOutRateWad: 1n }],
  venueProgram: RAYDIUM_CLMM,
  inMint: USDC_MINT,
  minConvertRateWad: 0n,
  minInvestment: 1_000_000n,
  maxPerCall: 50_000_000n,
  maxRolling30d: 500_000_000n,
  enabled: true,
  ...overrides,
});

describe("investPolicyProblems", () => {
  it("accepts one USDC-in SPYx leg on Raydium CLMM", () => {
    expect(investPolicyProblems(invest())).toEqual([]);
  });

  it.each([
    ["no legs", { legs: [] }],
    ["nine legs", { legs: Array.from({ length: 9 }, () => ({ mint: keypair().publicKey.toBase58(), weightBps: 1_111, minOutRateWad: 1n })) }],
    ["weights 9999", { legs: [{ mint: spyx, weightBps: 9_999, minOutRateWad: 1n }] }],
    ["a duplicate mint", { legs: [{ mint: spyx, weightBps: 5_000, minOutRateWad: 1n }, { mint: spyx, weightBps: 5_000, minOutRateWad: 1n }] }],
    ["in_mint as a leg", { inMint: spyx }],
    ["the default in_mint", { inMint: SYSTEM_PROGRAM }],
    ["enabled with a default venue", { venueProgram: SYSTEM_PROGRAM }],
    ["a zero leg floor", { legs: [{ mint: spyx, weightBps: 10_000, minOutRateWad: 0n }] }],
    ["min above per-call", { minInvestment: 60_000_000n }],
    ["per-call above rolling", { maxPerCall: 600_000_000n }],
    ["a zero minimum", { minInvestment: 0n }],
  ] as const)("refuses %s", (_, overrides) => {
    expect(investPolicyProblems(invest(overrides as Partial<InvestPolicyInput>)).length).toBeGreaterThan(0);
  });

  it("allows a default venue when the policy is disabled", () => {
    expect(investPolicyProblems(invest({ venueProgram: SYSTEM_PROGRAM, enabled: false }))).toEqual([]);
  });
});
