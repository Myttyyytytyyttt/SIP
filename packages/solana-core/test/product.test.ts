// The product's defaults, pinned to the program's rules and to the verifier's caps.

import { describe, expect, it } from "vitest";

import {
  ANTHROPIC_MINT,
  ANTHROPIC_USDC_POOL,
  FIGUREAI_MINT,
  PRESTOCKS_ISSUER,
  SPYX_MINT,
  SPYX_USDC_POOL,
  TOKEN_2022_PROGRAM,
  USDC_MINT,
  RAYDIUM_CLMM,
} from "../src/client/addresses";
import { OWNER_INSTRUCTIONS } from "../src/client/idl";
import { investmentReadiness } from "../src/client/pending";
import {
  CATALOGUE,
  CATALOGUE_MAX_FEE_BPS,
  CATALOGUE_MIN_FLOOR_POOL_RAW,
  CATALOGUE_MIN_VENUE_DEPTH_RAW,
  CATALOGUE_REFERENCE_LEG_RAW,
  CATALOGUE_SLIPPAGE_BPS,
  CATALOGUE_VENUE_INVENTORY_MULTIPLE,
  CLASSIC_TOKEN_ACCOUNT_BYTES,
  CONVERT_FLOOR_MARGIN_BPS,
  DEFAULT_INVEST_CAPS,
  DEFAULT_VAULT_POLICY,
  LEG_FLOOR_MARGIN_BPS,
  MAX_PICKED_LEGS,
  OFFERED_LEGS,
  OWNER_TX_COMPUTE,
  OWNER_TX_MICROLAMPORTS,
  PRESTOCKS_POWERS,
  VOLUME_MODE_OFFERED,
  XSTOCKS_POWERS,
  basketWeightsBps,
  offerProblems,
  ownerComputeBudget,
  priorityFeeLamports,
  sizePenaltyCeilingBps,
} from "../src/client/product";
import {
  DEFAULT_PURCHASE_USDC_RAW,
  DEFAULT_RATES,
  MAX_LEGS,
  MODE_PROFIT,
  defaultInvestPolicy,
  investPolicyProblems,
  vaultPolicyProblems,
} from "../src/client/rules";
import { LEG_FEE, POOL_DEPTH } from "./fixtures/keeper-policy";
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

  it("the shipped caps can buy the catalogue's OWN basket, read per leg and not per basket", () => {
    // min_investment is enforced once per leg (invest.rs), so the question the
    // caps have to answer is whether the LIGHTEST leg's slice of max_per_call
    // clears the minimum — not whether the basket's total does. At ONE leg the
    // two are the same number, so this only says anything from two legs up, and
    // it is here so a catalogue that changes length is measured against the rule
    // rather than against the coincidence. The rule itself lives in
    // client/pending.ts; test/rules.test.ts pins its divergence cases.
    const weights = basketWeightsBps(OFFERED_LEGS.length);
    const minInvestment = defaultInvestPolicy(OFFERED_LEGS.length).minInvestment;
    const lightest = BigInt(Math.min(...weights));
    expect((DEFAULT_INVEST_CAPS.maxPerCall * lightest) / 10_000n).toBeGreaterThanOrEqual(minInvestment);

    const readiness = investmentReadiness(DEFAULT_PURCHASE_USDC_RAW, weights.map((weightBps) => ({ weightBps })), minInvestment, DEFAULT_INVEST_CAPS.maxPerCall);
    expect(readiness?.state).toBe("ready");
    // The catalogue's two equal legs divide 5 USDC exactly, so the first buy
    // happens at the 5 USDC the product is sized around and not a unit later.
    expect(readiness?.investsAtRaw).toBe(DEFAULT_PURCHASE_USDC_RAW);
    expect(investmentReadiness(DEFAULT_PURCHASE_USDC_RAW - 1n, weights.map((weightBps) => ({ weightBps })), minInvestment, DEFAULT_INVEST_CAPS.maxPerCall)?.state).toBe("waiting");
  });

  it("offers what the RULES admit and nothing else: SPYx and ANTHROPIC, each with a floor pool, at 10 % and 5 % margins", () => {
    // OFFERED_LEGS IS A RESULT, NOT A LIST, and this is the assertion that
    // keeps it one. A hand-added entry that fails a rule cannot pass here,
    // because the expected value is recomputed from the same predicate the
    // export is built from — and an entry that fails NO rule cannot be left
    // off, which is the direction a list quietly gets stale in.
    expect(OFFERED_LEGS).toEqual(CATALOGUE.filter((asset) => offerProblems(asset).length === 0));
    expect(OFFERED_LEGS.map((leg) => leg.symbol)).toEqual(["SPYx", "ANTHROPIC"]);
    expect(OFFERED_LEGS.map((leg) => [leg.mint, leg.floorPool])).toEqual([
      [SPYX_MINT, SPYX_USDC_POOL],
      [ANTHROPIC_MINT, ANTHROPIC_USDC_POOL],
    ]);
    for (const leg of OFFERED_LEGS) expect(leg.tokenProgram).toBe(TOKEN_2022_PROGRAM);
    expect([CONVERT_FLOOR_MARGIN_BPS, LEG_FLOOR_MARGIN_BPS]).toEqual([1_000, 500]);
  });

  it("refuses every other asset on a NAMED rule, and the naming is the part that has to survive", () => {
    // A future reader re-applies these rather than trusting the shelf. Each
    // entry is pinned to the exact set of rules it fails, so a measurement that
    // moves — or a rule that quietly stops being applied — fails here and says
    // which asset it was about.
    const refusedBy = (symbol: string): string[] =>
      offerProblems(CATALOGUE.find((asset) => asset.symbol === symbol)!)
        .map((problem) => problem.rule)
        .sort();
    expect(refusedBy("FIGUREAI")).toEqual(["HELD"]);
    expect(refusedBy("OPENAI")).toEqual(["FLOOR", "PRICE_AT_SIZE"]);
    expect(refusedBy("NEURALINK")).toEqual(["DEPTH", "FLOOR", "PRICE_AT_SIZE"]);
    expect(refusedBy("SPACEX")).toEqual(["DEPTH", "FLOOR", "PRICE_AT_SIZE"]);
    // The one asset whose price holds at the reference leg and whose refusals
    // are both about SaverFi's own plumbing rather than about the asset.
    expect(refusedBy("POLYMARKET")).toEqual(["DEPTH", "FLOOR"]);
    expect(refusedBy("KALSHI")).toEqual(["DEPTH", "FLOOR", "PRICE_AT_SIZE"]);
    expect(refusedBy("ANDURIL")).toEqual(["DEPTH", "FLOOR", "PRICE_AT_SIZE"]);
    // Every refusal carries the reading that failed it: a rule name with no
    // number behind it is exactly the hand-picked list this design replaces.
    for (const asset of CATALOGUE) for (const problem of offerProblems(asset)) expect(problem.why.length).toBeGreaterThan(20);
  });

  it("refuses what nobody measured exactly as it refuses what measured badly", () => {
    const spyx = CATALOGUE[0]!;
    const unmeasured = { ...spyx, fee: null, depth: null, sizePenalty: null, floorPoolUsdc: null };
    expect(offerProblems(unmeasured).map((problem) => problem.rule)).toEqual(["ROUTED", "FEE", "PRICE_AT_SIZE", "FLOOR"]);
    // AND THE SENTENCES SAY SO, because "no fee recorded" read as "no fee" is
    // precisely the mistake the catalogue exists to stop.
    expect(offerProblems(unmeasured)[1]!.why).toContain("an unread fee is not a zero fee");
    // A measured zero is not the same thing as an unmeasured one.
    expect(offerProblems(spyx)).toEqual([]);
  });

  it("every reading in the catalogue carries the day it was taken and what took it", () => {
    const dated = (reading: { readonly readOn: string; readonly by: string } | null): void => {
      if (reading === null) return;
      expect(reading.readOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(reading.by.length).toBeGreaterThan(10);
    };
    for (const asset of CATALOGUE) {
      dated(asset.fee);
      dated(asset.depth);
      dated(asset.floorPoolUsdc);
      dated(asset.sizePenalty);
      // A depth figure that does not say WHICH measurement it is can be out by
      // a factor of forty-five: ANTHROPIC's venue-wide reading against the
      // census behind the same day's ceiling.
      if (asset.depth !== null) expect(["route-census", "venue-wide"]).toContain(asset.depth.scope);
      if (asset.sizePenalty !== null) expect(typeof asset.sizePenalty.sameVenues).toBe("boolean");
    }
  });

  it("holds the keeper's three numbers as the keeper's, through the committed vector", () => {
    // THE VECTOR, not the keeper's source: test/fixtures/keeper-policy.ts, the
    // same one vault-copy.test.ts asserts the website's copies against. The
    // browser may not import the keeper, so the copies are held together by
    // agreeing about a fixture rather than by importing each other.
    expect(CATALOGUE_VENUE_INVENTORY_MULTIPLE).toBe(POOL_DEPTH.keeper.value);
    expect(BigInt(CATALOGUE_MAX_FEE_BPS)).toBe(LEG_FEE.keeper.value);
    expect(BigInt(CATALOGUE_SLIPPAGE_BPS)).toBe(LEG_FEE.slippageBps);
    // ARM 2's ceiling is a QUARTER of what the slippage budget has left after
    // the issuer's fee — so a mint at the fee ceiling is allowed 25 bps of its
    // own impact and a zero-fee mint 50. Both written out: a formula that
    // agreed with the keeper's arithmetic and not with its numbers would pass a
    // derivation-only test.
    expect(sizePenaltyCeilingBps(CATALOGUE_MAX_FEE_BPS)).toBe(25);
    expect(sizePenaltyCeilingBps(0)).toBe(50);
    expect(sizePenaltyCeilingBps(CATALOGUE_SLIPPAGE_BPS)).toBe(0);
  });

  it("measures every rule at the share one turn can push into one leg of a full basket", () => {
    expect(MAX_PICKED_LEGS).toBeLessThanOrEqual(MAX_LEGS);
    expect(CATALOGUE_REFERENCE_LEG_RAW).toBe(DEFAULT_INVEST_CAPS.maxPerCall / BigInt(MAX_PICKED_LEGS));
    expect(CATALOGUE_REFERENCE_LEG_RAW).toBe(200_000_000n);
    expect(CATALOGUE_MIN_VENUE_DEPTH_RAW).toBe(10_000_000_000n);
    // The floor source's bar is the small one deliberately: it asks that the
    // price be a market at all, not that it be deep.
    expect(CATALOGUE_MIN_FLOOR_POOL_RAW).toBe(CATALOGUE_VENUE_INVENTORY_MULTIPLE * DEFAULT_PURCHASE_USDC_RAW);
    expect(CATALOGUE_MIN_FLOOR_POOL_RAW).toBe(250_000_000n);
  });

  it("says out loud that ANTHROPIC sits ON the fee ceiling, and one basis point more refuses the basket", () => {
    const anthropic = CATALOGUE.find((asset) => asset.symbol === "ANTHROPIC")!;
    expect(anthropic.fee!.bps).toBe(CATALOGUE_MAX_FEE_BPS);
    expect(offerProblems(anthropic)).toEqual([]);
    // The gate is `>`, so exactly the ceiling is admitted with NO margin. The
    // boundary is asserted from both sides because a flip to `>=` would take
    // the basket the website promises off the shelf.
    expect(offerProblems({ ...anthropic, fee: { ...anthropic.fee!, bps: CATALOGUE_MAX_FEE_BPS + 1 } }).map((problem) => problem.rule)).toEqual(["FEE"]);
    // AND THE ENTRY SAYS IT IN WORDS, because a number in a field is not a
    // warning to anybody reading the shelf.
    expect(anthropic.notes.join(" ")).toMatch(/ZERO MARGIN/);
    expect(anthropic.notes.join(" ")).toMatch(/whole basket/i);
  });

  it("keeps FIGUREAI out on the quarantine ALONE, which is the rule doing the work and not an old sentence", () => {
    // Its pool was about $51 on 2026-09-20 and $2,786.97 on 2026-09-21, and
    // Jupiter quotes the reference leg into Manifest at no measurable penalty.
    // The sentence that used to keep it out is false now; the rule is what
    // keeps it out, and this test is what makes that visible.
    const figureai = CATALOGUE.find((asset) => asset.symbol === "FIGUREAI")!;
    expect(offerProblems(figureai).map((problem) => problem.rule)).toEqual(["HELD"]);
    expect(figureai.quarantinedUntil).toBe("2026-10-20");
    // PROVEN BY REMOVAL: lift the quarantine and it is offerable on today's
    // readings, so nothing else in this file is quietly also refusing it.
    expect(offerProblems({ ...figureai, quarantinedUntil: null })).toEqual([]);
    expect(OFFERED_LEGS.map((leg) => leg.mint)).not.toContain(FIGUREAI_MINT);
  });

  it("names each symbol, mint and floor pool once, and stays a basket the program would take", () => {
    // A copy-pasted mint or floor pool would price one leg from another's
    // market and would be refused on chain as a repeated mint; catch it here.
    for (const field of ["symbol", "mint"] as const) {
      expect(new Set(CATALOGUE.map((asset) => asset[field])).size).toBe(CATALOGUE.length);
    }
    expect(new Set(OFFERED_LEGS.map((leg) => leg.floorPool)).size).toBe(OFFERED_LEGS.length);
    expect(OFFERED_LEGS.length).toBeGreaterThanOrEqual(1);
    expect(OFFERED_LEGS.length).toBeLessThanOrEqual(MAX_LEGS);
  });

  it("groups by what an issuer can do, which is a product fact: one key over every PreStock, and no fee an xStock can ever be given", () => {
    expect(new Set(CATALOGUE.map((asset) => asset.group))).toEqual(new Set(["xstock", "prestock"]));
    // ONE KEY, EVERYTHING. Read on mainnet over all eight PreStocks mints.
    expect(PRESTOCKS_POWERS.issuerKey).toBe(PRESTOCKS_ISSUER);
    expect(PRESTOCKS_POWERS.oneKeyHolds).toEqual(["mint", "freeze", "permanent-delegate", "transfer-fee-config"]);
    expect(PRESTOCKS_POWERS.pausable).toBe(true);
    // AND EVERY PRESTOCK IS AT THE CEILING TODAY, which is a group fact and not
    // an ANTHROPIC quirk: the issuer moved all of them to 100 bps at epoch 1039.
    for (const asset of CATALOGUE.filter((entry) => entry.group === "prestock")) {
      expect(asset.fee!.bps).toBe(CATALOGUE_MAX_FEE_BPS);
      expect(asset.fee!.epoch).toBe(1039);
      expect(asset.tokenAccountBytes).toBe(191);
    }
    // THE STRONGER FACT, AND THE REASON IT IS STRONGER: a Token-2022 mint's
    // extensions are fixed at initialisation, so "no transfer-fee extension"
    // means no authority anywhere can add one — not "no fee today".
    expect(XSTOCKS_POWERS.transferFeeExtension).toBe(false);
    expect(XSTOCKS_POWERS.feeAddableLater).toBe(false);
    expect(XSTOCKS_POWERS.why).toContain("fixed at mint initialisation");
    // It is not a claim that the issuer is powerless, which is the over-read.
    expect(XSTOCKS_POWERS.stillHolds).toContain("freeze");
    expect(XSTOCKS_POWERS.stillHolds).toContain("permanent-delegate");
    for (const asset of CATALOGUE.filter((entry) => entry.group === "xstock")) expect(asset.fee!.bps).toBe(0);
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
