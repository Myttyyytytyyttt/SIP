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
  CATALOGUE_SLIPPAGE_MARGIN_BPS,
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
  routeCensusRaw,
  ownerComputeBudget,
  priorityFeeLamports,
  sizePenaltyCeilingBps,
  judgedFeeBps,
  keeperInvestMinOutFor,
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
import { LEG_FEE, OWNER_FLOOR_MIN_OUT, POOL_DEPTH } from "./fixtures/keeper-policy";
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

  it("offers VOLUME since 09-25, with the volume keeper: changing it must change this test", () => {
    expect(VOLUME_MODE_OFFERED).toBe(true);
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
      dated(asset.routeCensus);
      // A depth figure that does not say WHICH measurement it is can be out by
      // a factor of forty-five: ANTHROPIC's venue-wide reading against the
      // census behind the same day's ceiling.
      if (asset.depth !== null) expect(["route-census", "venue-wide"]).toContain(asset.depth.scope);
      if (asset.sizePenalty !== null) expect(typeof asset.sizePenalty.sameVenues).toBe("boolean");
    }
  });

  /**
   * THE FIELD A CAP IS DIVIDED BY. `depth` may be either measurement, because
   * the shelf's DEPTH bar SCREENS with it and a venue-wide figure that fails a
   * screen fails decisively. A ceiling DIVIDES, so the larger number makes the
   * cap larger — and a cap that is too large signs a policy that buys nothing,
   * at any balance, with the rent already spent. So the ceiling reads its own
   * field, and null there means "not counted", never "deep".
   */
  it("a route census is never a venue-wide figure, and an uncounted route answers null rather than a large number", () => {
    for (const asset of CATALOGUE) {
      if (asset.routeCensus !== null) expect(asset.routeCensus.scope).toBe("route-census");
      // Never read `depth` in its place when that reading is venue-wide.
      if (asset.depth?.scope === "venue-wide" && asset.routeCensus === null) expect(routeCensusRaw(asset)).toBeNull();
    }
    const anthropic = CATALOGUE.find((asset) => asset.symbol === "ANTHROPIC")!;
    expect(anthropic.depth!.scope).toBe("venue-wide");
    // The gap this field exists for: forty-five times, on one mint, on one day.
    expect(anthropic.depth!.usdcRaw / routeCensusRaw(anthropic)!).toBe(44n);
    // AND IT INVERTS THE MEASUREMENT IT CAME FROM. ⌊census / 50⌋ is what one leg
    // may take, and that leg at a half share is the $298.00 cap the day's
    // measurement reported, at a fifth share the $745.00.
    const perLeg = routeCensusRaw(anthropic)! / CATALOGUE_VENUE_INVENTORY_MULTIPLE;
    expect(perLeg).toBe(149_000_000n);
    expect(perLeg * 10_000n / 5_000n).toBe(298_000_000n);
    expect(perLeg * 10_000n / 2_000n).toBe(745_000_000n);
    // SPYx'S CENSUS IS SMALLER THAN ITS SCREENING DEPTH, AND THAT IS THE RULE,
    // NOT AN ODDITY. `depth` pins a pool a 200 USDC buy routed through once;
    // the census counts the smallest inventory of any pool the router was
    // actually seen picking, because the ceiling DIVIDES it and an optimistic
    // ceiling signs a policy that buys nothing. The two were the same number
    // while the census was pinned to a pool no later reading routed through.
    const spyx = CATALOGUE.find((asset) => asset.symbol === "SPYx")!;
    expect(routeCensusRaw(spyx)!).toBeLessThanOrEqual(spyx.depth!.usdcRaw);
    expect(spyx.routeCensus!.scope).toBe("route-census");
    expect(spyx.routeCensus!.derived ?? false).toBe(false);
    // The pool the count was taken over is named in FULL, so the reading can be
    // re-taken; a truncated address is a reading nobody else can run.
    expect(spyx.routeCensus!.by).toContain("FGdm1Ww1ch138kWjjEigFUFncxzkvfZ6m8Fo1YvM8BMu");

    // A DERIVED FIGURE SAYS SO. ANTHROPIC's census is inverted from that day's
    // ceiling measurement rather than counted, and until this flag existed the
    // web called it a count in four separate sentences — beside a null branch
    // whose meaning is "nobody counted this".
    expect(anthropic.routeCensus!.derived).toBe(true);
    expect(anthropic.routeCensus!.by).toContain("not a direct count");
    // An asset nobody counted says so rather than offering its venue's book.
    expect(routeCensusRaw({ ...spyx, routeCensus: null, depth: { ...spyx.depth!, scope: "venue-wide" } })).toBeNull();
  });

  /**
   * A SCREENING READING IS RECORDED AT ITS WORST, NOT AT ITS PRETTIEST.
   *
   * ANTHROPIC's size penalty was 0.1 bps, cited to "three readings: 0.0, -0.0,
   * 0.1" — which reads as a settled quantity and is not one. The same figure
   * has been read at 107 bps (failing the leg outright), at 14, at 9.8 and at
   * 0 within one day, because the router picks a different route for each
   * quote and the two sizes rarely take the same one. The bar is 25. An entry
   * that admits a leg on a number with a spread wider than its own bar has to
   * record the worst reading it took and say the quantity moves; anything else
   * is a stable-looking number standing in for a coin flip.
   */
  it("records an unstable screening reading at its worst, and says the quantity moves", () => {
    const anthropic = CATALOGUE.find((asset) => asset.symbol === "ANTHROPIC")!;
    // Not 0.1: the worst of the five paired readings taken, not the best.
    expect(anthropic.sizePenalty!.bps).toBeGreaterThanOrEqual(1);
    expect(anthropic.sizePenalty!.by).toMatch(/107 bps/);
    // AND THE SCOPE IS STILL STATED. sameVenues false means the keeper's own
    // ARM 2 would ABSTAIN here rather than compare, so this is a screen.
    expect(anthropic.sizePenalty!.sameVenues).toBe(false);
    // The leg still passes its bar on what was recorded; the disclosure is the
    // change, not the verdict.
    expect(offerProblems(anthropic)).toEqual([]);
  });

  /**
   * A CITATION HAS TO NAME SOMETHING A READER CAN OPEN.
   *
   * Seven entries sourced their depth to "this repo's Jupiter migration notes".
   * No such file exists, in the tree or anywhere in its history, and for
   * ANTHROPIC that figure is the whole evidence for the rule that ADMITS it.
   * The numbers stay — they are what somebody measured — but a `by` may not
   * point at a document that is not there: a reader who cannot find it cannot
   * tell a reading from an invention, which is the distinction this file's
   * every dated field exists to draw.
   */
  it("cites no source that does not exist: no reading points at a file this repository has not got", () => {
    const readings = CATALOGUE.flatMap((asset) => [asset.depth, asset.routeCensus, asset.floorPoolUsdc, asset.fee, asset.sizePenalty].filter((reading) => reading !== null));
    expect(readings.length).toBeGreaterThan(20);
    for (const reading of readings) {
      expect(reading!.by, `${reading!.by} cites a notes file that is not in this repository`).not.toMatch(/migration notes/i);
      expect(reading!.by.length, "a reading with no source is a number somebody typed").toBeGreaterThan(20);
    }
    // AND THE ONES WITH NO RE-DERIVABLE SOURCE SAY SO IN THOSE WORDS, rather
    // than naming a document. There are eight, all venue-wide.
    const carried = CATALOGUE.filter((asset) => /no notes file, script or commit|THERE IS NO SOURCE FOR IT/.test(asset.depth?.by ?? ""));
    expect(carried).toHaveLength(8);
    for (const asset of carried) expect(asset.depth!.scope).toBe("venue-wide");
  });

  it("holds the keeper's three numbers as the keeper's, through the committed vector", () => {
    // THE VECTOR, not the keeper's source: test/fixtures/keeper-policy.ts, the
    // same one vault-copy.test.ts asserts the website's copies against. The
    // browser may not import the keeper, so the copies are held together by
    // agreeing about a fixture rather than by importing each other.
    expect(CATALOGUE_VENUE_INVENTORY_MULTIPLE).toBe(POOL_DEPTH.keeper.value);
    expect(BigInt(CATALOGUE_MAX_FEE_BPS)).toBe(LEG_FEE.keeper.value);
    expect(BigInt(CATALOGUE_SLIPPAGE_BPS)).toBe(LEG_FEE.slippageBps);
    expect(BigInt(CATALOGUE_SLIPPAGE_MARGIN_BPS)).toBe(LEG_FEE.slippageMarginBps);
    // ARM 2's ceiling is a QUARTER of what the slippage the keeper ASKS leaves
    // over the issuer's fee, never under 5 — the keeper's own
    // maxTurnImpactBps(legSlippageBps(fee), fee), whose numbers the keeper's
    // tests hold to the same pairs. Written out as numbers: a formula that
    // agreed with the keeper's arithmetic and not with its numbers would pass a
    // derivation-only test.
    for (const [fee, ceiling] of LEG_FEE.impactCeilingBps) {
      expect(sizePenaltyCeilingBps(Number(fee)), `impact ceiling at a ${fee} bps fee`).toBe(Number(ceiling));
    }
    // THE CASE THAT BROKE THE OLD FORMULA: (200 - 300) / 4 floored at 0 would
    // have refused ANTHROPIC on PRICE_AT_SIZE from the day 300 was written,
    // while the keeper asks 400 and allows 25.
    expect(sizePenaltyCeilingBps(CATALOGUE_MAX_FEE_BPS)).toBe(25);
    expect(sizePenaltyCeilingBps(0)).toBe(50);
  });

  it("answers the keeper's own min_out under the owner's floor, case for case, through the committed vector", () => {
    const { venueThreshold, netOfVenueThreshold, quotedOut, slippageBps } = OWNER_FLOOR_MIN_OUT.measured;
    // The threshold is Jupiter's: out less floor(out x slippage / 1e4).
    expect(quotedOut - (quotedOut * slippageBps) / 10_000n).toBe(venueThreshold);
    for (const [ownerFloor, minOut] of OWNER_FLOOR_MIN_OUT.cases) {
      expect(keeperInvestMinOutFor({ venueThreshold, netOfVenueThreshold, ownerFloor }), `owner floor ${ownerFloor}`).toBe(minOut);
    }
    // THE MIDDLE BAND IS A BUY, NOT A REFUSAL: the owner's ANTHROPIC floor sits
    // between the two thresholds and the keeper hands invest() the floor itself.
    const { ownerFloor, minOut } = OWNER_FLOOR_MIN_OUT.ownersLeg;
    expect(ownerFloor > netOfVenueThreshold && ownerFloor <= venueThreshold).toBe(true);
    expect(keeperInvestMinOutFor({ venueThreshold, netOfVenueThreshold, ownerFloor })).toBe(minOut);
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

  it("says out loud that ANTHROPIC lands ON the fee ceiling at epoch 1043, and one basis point more refuses the basket", () => {
    const anthropic = CATALOGUE.find((asset) => asset.symbol === "ANTHROPIC")!;
    // TWO RATES, AS THE CHAIN HOLDS THEM ON 2026-09-24: 100 charged in epoch
    // 1041, 300 already written for 1043. The rules judge the 300.
    expect(anthropic.fee!.bps).toBe(100);
    expect(anthropic.fee!.epoch).toBe(1041);
    expect(anthropic.fee!.scheduled).toEqual({ bps: CATALOGUE_MAX_FEE_BPS, epoch: 1043 });
    expect(judgedFeeBps(anthropic.fee!)).toBe(CATALOGUE_MAX_FEE_BPS);
    expect(offerProblems(anthropic)).toEqual([]);
    // The gate is `>`, so exactly the ceiling is admitted with NO margin. The
    // boundary is asserted from both sides because a flip to `>=` would take
    // the basket the website promises off the shelf — and from BOTH readings,
    // because a rule that judged only the live 100 would offer a leg the
    // keeper refuses from epoch 1043 on.
    const scheduledAt = (bps: number) => ({ ...anthropic, fee: { ...anthropic.fee!, scheduled: { bps, epoch: 1043 } } });
    expect(offerProblems(scheduledAt(CATALOGUE_MAX_FEE_BPS))).toEqual([]);
    expect(offerProblems(scheduledAt(CATALOGUE_MAX_FEE_BPS + 1)).map((problem) => problem.rule)).toEqual(["FEE"]);
    expect(offerProblems(scheduledAt(CATALOGUE_MAX_FEE_BPS + 1))[0]!.why).toContain("already written for epoch 1043");
    expect(offerProblems({ ...anthropic, fee: { ...anthropic.fee!, bps: CATALOGUE_MAX_FEE_BPS + 1 } }).map((problem) => problem.rule)).toEqual(["FEE"]);
    // AND THE ENTRY SAYS IT IN WORDS, because a number in a field is not a
    // warning to anybody reading the shelf.
    expect(anthropic.notes.join(" ")).toMatch(/ZERO MARGIN/);
    expect(anthropic.notes.join(" ")).toMatch(/whole basket/i);
    expect(anthropic.notes.join(" ")).toContain("5.91 %");
  });

  it("judges the price-at-size bar at the fee the leg WILL pay, so a scheduled 300 keeps the keeper's 25 and not the old formula's 0", () => {
    const anthropic = CATALOGUE.find((asset) => asset.symbol === "ANTHROPIC")!;
    // A penalty just over the bar refuses at 300, the bar the keeper keeps;
    // just under it passes. Under the old (200 - fee) / 4 even 1 bps refused.
    const penalty = (bps: number) => ({ ...anthropic, sizePenalty: { ...anthropic.sizePenalty!, bps } });
    expect(offerProblems(penalty(25))).toEqual([]);
    expect(offerProblems(penalty(26)).map((problem) => problem.rule)).toEqual(["PRICE_AT_SIZE"]);
    expect(offerProblems(penalty(26))[0]!.why).toContain("over the 25 bps");
    // AND THE WRITTEN FEE IS WHAT DECIDES IT, where the two fees give two bars:
    // 50 charged today is a bar of 37, and 300 written for later is a bar of
    // 25. A leg measured at 30 bps passes the first and fails the second — and
    // the keeper will judge it at 25 from the day the 300 was written.
    const writtenOver = { ...penalty(30), fee: { ...anthropic.fee!, bps: 50, scheduled: { bps: 300, epoch: 1043 } } };
    expect(sizePenaltyCeilingBps(50)).toBe(37);
    expect(offerProblems(writtenOver).map((problem) => problem.rule)).toEqual(["PRICE_AT_SIZE"]);
    expect(offerProblems({ ...writtenOver, fee: { ...writtenOver.fee, scheduled: null } })).toEqual([]);
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
    // AND THE FEE IS A GROUP FACT, NOT AN ANTHROPIC QUIRK. Read 2026-09-24 in
    // epoch 1041: every PreStock charges 100 bps, and the same key had already
    // written 300 — exactly the ceiling — for epoch 1043 on every one of them
    // but SPACEX, which has nothing newer.
    for (const asset of CATALOGUE.filter((entry) => entry.group === "prestock")) {
      expect(asset.fee!.bps).toBe(100);
      expect(asset.fee!.epoch).toBe(1041);
      expect(asset.fee!.readOn).toBe("2026-09-24");
      expect(asset.fee!.scheduled, asset.symbol).toEqual(asset.symbol === "SPACEX" ? null : { bps: CATALOGUE_MAX_FEE_BPS, epoch: 1043 });
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
