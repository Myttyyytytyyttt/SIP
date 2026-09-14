// The browser-safe validation rules, pinned to the Rust source they mirror.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { RAYDIUM_CLMM, SYSTEM_PROGRAM, USDC_MINT } from "../src/client/addresses";
import { SIP_IDL } from "../src/client/idl";
import {
  DEFAULT_PURCHASE_USDC_RAW,
  DEFAULT_RATES,
  LEG_WEIGHT_TOTAL_BPS,
  MAX_LEGS,
  MODE_PROFIT,
  MODE_VOLUME,
  PROFIT_BPS_MAX,
  PROFIT_BPS_MIN,
  U64_MAX,
  VOLUME_BPS_MAX,
  VOLUME_BPS_MIN,
  defaultInvestPolicy,
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
/** state.rs with its doc-comment line breaks folded, so a sentence reads as one line. */
const STATE_DOCS = STATE_RS.replace(/\s*\/\/\/\s*/g, " ");

const rustConst = (name: string): number => {
  const match = new RegExp(`pub const ${name}: \\w+ = ([0-9_]+);`).exec(STATE_RS);
  if (match === null) throw new Error(`state.rs has no ${name}`);
  return Number(match[1]!.replaceAll("_", ""));
};

const errorMsg = (name: string): string | undefined => SIP_IDL.errors.find((error) => error.name === name)?.msg;

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

  it("the ranges decided 2026-09-14: volume up to 2 %, profit from 2.01 %, disjoint, the owner's rates inside", () => {
    expect([VOLUME_BPS_MIN, VOLUME_BPS_MAX, PROFIT_BPS_MIN, PROFIT_BPS_MAX]).toEqual([1, 200, 201, 10_000]);
    expect(VOLUME_BPS_MAX + 1).toBe(PROFIT_BPS_MIN);
    expect(STATE_RS).toContain("VOLUME_BPS_MAX + 1 == PROFIT_BPS_MIN");
    expect(STATE_DOCS).toContain("The owner's product rate is 2_000 (20%)");
    expect(STATE_DOCS).toContain("200 (2%) is the owner's product rate");
    expect(DEFAULT_RATES).toEqual({ profitBps: 2_000, volumeBps: 200 });
  });

  it("the program's refusals state the same bounds", () => {
    expect(errorMsg("InvalidSkimBps")).toBe(`skim_bps (profit rate) must be between ${PROFIT_BPS_MIN} and ${PROFIT_BPS_MAX}`);
    expect(errorMsg("InvalidVolumeBps")).toBe(`volume_bps must be between ${VOLUME_BPS_MIN} and ${VOLUME_BPS_MAX}`);
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

describe("vaultPolicyProblems (validate_policy)", () => {
  it("accepts a valid policy, including a zero wallet reserve", () => {
    expect(vaultPolicyProblems(policy())).toEqual([]);
    expect(vaultPolicyProblems(policy({ walletReserve: 0n, mode: MODE_PROFIT }))).toEqual([]);
  });

  it("accepts the owner's product rates in both modes, and every edge of both ranges", () => {
    for (const mode of [MODE_PROFIT, MODE_VOLUME]) {
      expect(vaultPolicyProblems(policy({ mode, skimBps: DEFAULT_RATES.profitBps, volumeBps: DEFAULT_RATES.volumeBps }))).toEqual([]);
    }
    for (const [skimBps, volumeBps] of [
      [PROFIT_BPS_MIN, VOLUME_BPS_MIN],
      [PROFIT_BPS_MAX, VOLUME_BPS_MAX],
    ] as const) {
      expect(vaultPolicyProblems(policy({ skimBps, volumeBps }))).toEqual([]);
    }
  });

  it.each([
    ["skim 200, a volume rate where a profit rate belongs", { skimBps: 200 }],
    ["skim 10001", { skimBps: 10_001 }],
    ["volume 0", { volumeBps: 0 }],
    ["volume 201, a profit rate where a volume rate belongs", { volumeBps: 201 }],
    ["mode 2", { mode: 2 }],
    ["max contribution 0", { maxContribution: 0n }],
    ["negative reserve", { walletReserve: -1n }],
    ["fractional skim", { skimBps: 250.5 }],
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

describe("defaultInvestPolicy (the first investment policy)", () => {
  it("buys every 5 USDC: 5 USDC split across the legs, rounded down; no ceilings; USDC in", () => {
    expect(DEFAULT_PURCHASE_USDC_RAW).toBe(5n * 10n ** 6n);
    expect(defaultInvestPolicy(1)).toEqual({ inMint: USDC_MINT, minInvestment: 5_000_000n, maxPerCall: U64_MAX, maxRolling30d: U64_MAX });
    expect(defaultInvestPolicy(2).minInvestment).toBe(2_500_000n);
    expect(defaultInvestPolicy(3).minInvestment).toBe(1_666_666n);
    expect(defaultInvestPolicy(MAX_LEGS).minInvestment).toBe(625_000n);
    for (let legs = 1; legs <= MAX_LEGS; legs++) {
      // A 5 USDC pile always covers every leg's minimum.
      expect(defaultInvestPolicy(legs).minInvestment * BigInt(legs)).toBeLessThanOrEqual(DEFAULT_PURCHASE_USDC_RAW);
    }
  });

  it("is a policy set_invest_policy accepts for every basket size", () => {
    for (let count = 1; count <= MAX_LEGS; count++) {
      const share = Math.floor(LEG_WEIGHT_TOTAL_BPS / count);
      const legs = Array.from({ length: count }, (_, index) => ({
        mint: keypair().publicKey.toBase58(),
        weightBps: index === 0 ? LEG_WEIGHT_TOTAL_BPS - share * (count - 1) : share,
        minOutRateWad: 1n,
      }));
      expect(investPolicyProblems({ ...defaultInvestPolicy(count), legs, venueProgram: RAYDIUM_CLMM, minConvertRateWad: 0n, enabled: true })).toEqual([]);
    }
  });

  it.each([0, 9, 1.5, Number.NaN])("refuses a basket of %s legs", (count) => {
    expect(() => defaultInvestPolicy(count)).toThrow(RangeError);
  });
});
