// The product's defaults, pinned to the program's rules and to the verifier's caps.

import { describe, expect, it } from "vitest";

import {
  ANTHROPIC_MINT,
  ANTHROPIC_USDC_POOL,
  FIGUREAI_MINT,
  FIGUREAI_USDC_POOL,
  SPYX_MINT,
  SPYX_USDC_POOL,
  TOKEN_2022_PROGRAM,
  USDC_MINT,
  RAYDIUM_CLMM,
} from "../src/client/addresses";
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
import { DEFAULT_RATES, MAX_LEGS, MODE_PROFIT, defaultInvestPolicy, investPolicyProblems, vaultPolicyProblems } from "../src/client/rules";
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
    // The weights come from basketWeightsBps — the function the build route
    // itself uses — and not from a division that was only an integer while the
    // basket had one leg. Two legs do divide 10,000 evenly; three did not, and
    // will not again if the catalogue grows, which is why this is not a division.
    const weights = basketWeightsBps(OFFERED_LEGS.length);
    expect(weights).toEqual([5_000, 5_000]);
    // Written out as well as derived: at two legs $5 splits to $2.50, and a
    // catalogue that changes length must move this literal, not slide past it.
    expect(amounts.minInvestment).toBe(2_500_000n);
    expect(amounts.minInvestment).toBe(5_000_000n / BigInt(OFFERED_LEGS.length));
    const problems = investPolicyProblems({
      legs: OFFERED_LEGS.map((leg, index) => ({ mint: leg.mint, weightBps: weights[index]!, minOutRateWad: 1n })),
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

  it("offers SPYx and one PreStocks leg, both Token-2022, each priced from its own pool, with 10 % and 5 % margins", () => {
    expect(OFFERED_LEGS).toEqual([
      { symbol: "SPYx", name: "SP500 xStock", mint: SPYX_MINT, pool: SPYX_USDC_POOL, tokenProgram: TOKEN_2022_PROGRAM, decimals: 8, tokenAccountBytes: 179 },
      { symbol: "ANTHROPIC", name: "Anthropic PreStock", mint: ANTHROPIC_MINT, pool: ANTHROPIC_USDC_POOL, tokenProgram: TOKEN_2022_PROGRAM, decimals: 9, tokenAccountBytes: 191 },
    ]);
    expect(OFFERED_LEGS).toHaveLength(2);
    expect([CONVERT_FLOOR_MARGIN_BPS, LEG_FLOOR_MARGIN_BPS]).toEqual([1_000, 500]);
  });

  it("does NOT offer FIGUREAI, whose mint is fine and whose pinned pool is empty: putting it back must change this test", () => {
    // addresses.ts still names both, on purpose — the leg is withdrawn, not
    // deleted — so the catalogue is what says whether it is offered. Read on
    // mainnet 2026-09-20 (epoch 1038) its pool held 0.110274669 FIGUREAI and
    // 31.91 USDC, about $51, and a buy over roughly $11 reverted; the program
    // can only make a single-hop USDC buy through that one pool.
    expect(OFFERED_LEGS.map((leg) => leg.mint)).not.toContain(FIGUREAI_MINT);
    expect(OFFERED_LEGS.map((leg) => leg.pool)).not.toContain(FIGUREAI_USDC_POOL);
    expect(OFFERED_LEGS.map((leg) => leg.symbol)).toEqual(["SPYx", "ANTHROPIC"]);
  });

  it("names each mint, pool and symbol once, and stays a basket the program would take", () => {
    // A copy-pasted mint or pool would price one leg from another's market and
    // would be refused on chain as a repeated mint; catch it here instead.
    for (const field of ["symbol", "mint", "pool"] as const) {
      expect(new Set(OFFERED_LEGS.map((leg) => leg[field])).size).toBe(OFFERED_LEGS.length);
    }
    expect(OFFERED_LEGS.length).toBeGreaterThanOrEqual(1);
    expect(OFFERED_LEGS.length).toBeLessThanOrEqual(MAX_LEGS);
  });

  it("sizes the vault's token accounts: 165 classic, 179 for SPYx, 191 for a PreStocks leg (which also withholds a transfer fee)", () => {
    expect(CLASSIC_TOKEN_ACCOUNT_BYTES).toBe(165);
    // 165 base, the account type (1), then a 4-byte header plus its value per
    // extension: ImmutableOwner (0), PausableAccount (0), TransferHookAccount (1).
    const SPYX_BYTES = 165 + 1 + 4 + 4 + 5;
    expect(SPYX_BYTES).toBe(179);
    expect(OFFERED_LEGS[0]!.tokenAccountBytes).toBe(SPYX_BYTES);
    // A PreStocks leg adds TransferFeeAmount: a header and an 8-byte withheld
    // amount. The loop is over every leg past SPYx, and the count is asserted so
    // it cannot quietly become a loop over nothing if the catalogue shrinks again.
    const preStocks = OFFERED_LEGS.slice(1);
    expect(preStocks).toHaveLength(1);
    for (const leg of preStocks) expect(leg.tokenAccountBytes).toBe(SPYX_BYTES + 4 + 8);
    expect(OFFERED_LEGS[1]!.tokenAccountBytes).toBe(191);
  });

  it("weighs a basket's legs to exactly 10,000 bps, the remainder on the first leg", () => {
    expect(basketWeightsBps(1)).toEqual([10_000]);
    expect(basketWeightsBps(2)).toEqual([5_000, 5_000]);
    // Kept at three though the catalogue no longer has three legs: the remainder
    // rule is the function's, not the catalogue's, and only an uneven count shows it.
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
