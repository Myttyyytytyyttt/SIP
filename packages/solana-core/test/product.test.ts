// The product's defaults, pinned to the program's rules and to the verifier's caps.

import { describe, expect, it } from "vitest";

import { SPYX_MINT, SPYX_USDC_POOL, TOKEN_2022_PROGRAM, USDC_MINT, RAYDIUM_CLMM } from "../src/client/addresses";
import { OWNER_INSTRUCTIONS } from "../src/client/idl";
import {
  CLASSIC_TOKEN_ACCOUNT_BYTES,
  CONVERT_FLOOR_MARGIN_BPS,
  DEFAULT_INVEST_CAPS,
  DEFAULT_VAULT_POLICY,
  LEG_FLOOR_MARGIN_BPS,
  OFFERED_LEGS,
  OWNER_TX_COMPUTE,
  OWNER_TX_MICROLAMPORTS,
  VOLUME_MODE_OFFERED,
  basketWeightsBps,
  ownerComputeBudget,
  priorityFeeLamports,
} from "../src/client/product";
import { DEFAULT_RATES, MODE_PROFIT, defaultInvestPolicy, investPolicyProblems, vaultPolicyProblems } from "../src/client/rules";
import { MAX_COMPUTE_UNIT_LIMIT, MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS } from "../src/server/verify-tx";

describe("the vault a new pension key is offered", () => {
  it("is PROFIT at the owner's rates, with both rates valid, and passes the program's validate_policy", () => {
    expect(DEFAULT_VAULT_POLICY.mode).toBe(MODE_PROFIT);
    expect([DEFAULT_VAULT_POLICY.skimBps, DEFAULT_VAULT_POLICY.volumeBps]).toEqual([DEFAULT_RATES.profitBps, DEFAULT_RATES.volumeBps]);
    expect([DEFAULT_VAULT_POLICY.skimBps, DEFAULT_VAULT_POLICY.volumeBps]).toEqual([2_000, 200]);
    expect(vaultPolicyProblems(DEFAULT_VAULT_POLICY)).toEqual([]);
    expect(vaultPolicyProblems({ ...DEFAULT_VAULT_POLICY, mode: 1 })).toEqual([]);
  });

  it("moves at most 0.06 SOL per settlement and leaves 0.05 SOL in the trading wallet", () => {
    expect(DEFAULT_VAULT_POLICY.maxContribution).toBe(60_000_000n);
    expect(DEFAULT_VAULT_POLICY.walletReserve).toBe(50_000_000n);
  });

  it("does not offer VOLUME: the owner's decision is open, and changing it must change this test", () => {
    expect(VOLUME_MODE_OFFERED).toBe(false);
  });
});

describe("the first investment policy", () => {
  it("keeps convert at its tightest program bound (max_per_call ≤ 1e9) and allows one maximum buy per day-bucket", () => {
    expect(DEFAULT_INVEST_CAPS.maxPerCall).toBeLessThanOrEqual(1_000_000_000n);
    expect(DEFAULT_INVEST_CAPS.maxPerCall).toBe(1_000_000_000n);
    expect(DEFAULT_INVEST_CAPS.maxRolling30d).toBe(31n * DEFAULT_INVEST_CAPS.maxPerCall);
  });

  it("buys every $5 split across the offered legs, and the whole policy passes set_invest_policy's rules", () => {
    const amounts = defaultInvestPolicy(OFFERED_LEGS.length);
    expect(amounts.minInvestment).toBe(5_000_000n / BigInt(OFFERED_LEGS.length));
    const problems = investPolicyProblems({
      legs: OFFERED_LEGS.map((leg) => ({ mint: leg.mint, weightBps: 10_000 / OFFERED_LEGS.length, minOutRateWad: 1n })),
      venueProgram: RAYDIUM_CLMM,
      inMint: USDC_MINT,
      minConvertRateWad: 1n,
      minInvestment: amounts.minInvestment,
      maxPerCall: DEFAULT_INVEST_CAPS.maxPerCall,
      maxRolling30d: DEFAULT_INVEST_CAPS.maxRolling30d,
      enabled: true,
    });
    expect(problems).toEqual([]);
  });

  it("offers SPYx on Token-2022 at 8 decimals, priced from the keeper's pool, with 10 % and 5 % margins", () => {
    expect(OFFERED_LEGS).toEqual([{ symbol: "SPYx", name: "SP500 xStock", mint: SPYX_MINT, pool: SPYX_USDC_POOL, tokenProgram: TOKEN_2022_PROGRAM, decimals: 8, tokenAccountBytes: 179 }]);
    expect([CONVERT_FLOOR_MARGIN_BPS, LEG_FLOOR_MARGIN_BPS]).toEqual([1_000, 500]);
  });

  it("sizes the vault's token accounts: 165 bytes classic, and 179 for SPYx (account type, ImmutableOwner, PausableAccount, TransferHookAccount)", () => {
    expect(CLASSIC_TOKEN_ACCOUNT_BYTES).toBe(165);
    expect(OFFERED_LEGS[0]!.tokenAccountBytes).toBe(165 + 1 + 4 + 4 + 5);
  });

  it("weighs a basket's legs to exactly 10,000 bps, the remainder on the first leg", () => {
    expect(basketWeightsBps(1)).toEqual([10_000]);
    expect(basketWeightsBps(3)).toEqual([3_334, 3_333, 3_333]);
    for (let count = 1; count <= 8; count++) expect(basketWeightsBps(count).reduce((total, weight) => total + weight, 0)).toBe(10_000);
    expect(() => basketWeightsBps(0)).toThrow(RangeError);
  });
});

describe("the compute budget of owner transactions", () => {
  it("names every owner instruction, within the verifier's caps", () => {
    expect(Object.keys(OWNER_TX_COMPUTE).sort()).toEqual([...OWNER_INSTRUCTIONS].sort());
    for (const limit of Object.values(OWNER_TX_COMPUTE)) {
      expect(Number.isInteger(limit) && limit > 0 && limit <= MAX_COMPUTE_UNIT_LIMIT).toBe(true);
    }
    expect(OWNER_TX_MICROLAMPORTS).toBeLessThanOrEqual(MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS);
    expect(MAX_COMPUTE_UNIT_LIMIT).toBeLessThanOrEqual(1_400_000);
  });

  it("costs what the table says: 6,000 lamports of priority for a vault, 10,000 for a link, rounded up", () => {
    expect(priorityFeeLamports(ownerComputeBudget("create_vault_v2"))).toBe(6_000n);
    expect(priorityFeeLamports(ownerComputeBudget("link_wallet"))).toBe(10_000n);
    expect(priorityFeeLamports(ownerComputeBudget("set_invest_policy"))).toBe(30_000n);
    expect(priorityFeeLamports({ unitLimit: 1, microLamports: 1n })).toBe(1n);
    expect(priorityFeeLamports({ unitLimit: 1, microLamports: 0n })).toBe(0n);
  });
});
