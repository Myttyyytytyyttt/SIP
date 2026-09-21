// The basket somebody is clicking together: the rows, and the window of caps
// they admit.
//
// basket-limits.test.ts already pins the ARITHMETIC on both sides of every
// edge. What is pinned here is the JOIN — which reading a ceiling is allowed to
// divide, what happens to a leg nobody counted, and the four rules the picker's
// rows obey — because every one of those is a decision rather than a sum, and a
// decision that only exists inside a component is a decision nothing can check.

import { describe, expect, it } from "vitest";

import { ANDURIL_MINT, ANTHROPIC_MINT, CATALOGUE, OPENAI_MINT, SPYX_MINT, isOfferable, routeCensusRaw } from "@sip/solana-core/client";

import {
  MOST_PICKED,
  PICKER_MAX_LEGS,
  basketLimits,
  catalogueAsset,
  catalogueRows,
  evenPercents,
  evenedOut,
  lighterWeightBps,
  overCeiling,
  percentTotal,
  toggled,
  withPercent,
  type PickedLeg,
  type PickedRow,
} from "@/lib/basket-picker";
import { POOL_DEPTH_MULTIPLE } from "@/lib/vault-copy";

const MULTIPLE = BigInt(POOL_DEPTH_MULTIPLE);

/** A basket from mints and whole percents, as the card builds one once readWeights has said yes. */
const legs = (...picks: readonly (readonly [string, number])[]): PickedLeg[] =>
  picks.map(([mint, percent]) => ({ asset: catalogueAsset(mint)!, weightBps: percent * 100 }));

const rows = (...picks: readonly (readonly [string, string])[]): PickedRow[] => picks.map(([mint, percent]) => ({ mint, percent }));

/**
 * THE KEEPER'S GATE, RESTATED, so a ceiling is checked against the rule it
 * forecasts and never against the function that produced it. legDepthDecision
 * refuses on `inventory < take × 50`, take being ⌊cap × weight / 10,000⌋.
 */
const keeperWouldRefuse = (cap: bigint, basket: readonly PickedLeg[]): boolean =>
  basket.some((leg) => {
    const census = routeCensusRaw(leg.asset);
    return census !== null && census < ((cap * BigInt(leg.weightBps)) / 10_000n) * MULTIPLE;
  });

/** The default basket the form opens on: the two offered stocks at half each. */
const DEFAULT = legs([SPYX_MINT, 50], [ANTHROPIC_MINT, 50]);
/** defaultInvestPolicy(2).minInvestment — $5 split across two legs. */
const MIN_TWO = 2_500_000n;

describe("the catalogue as the picker shows it", () => {
  it("puts what can be bought first, and never shows a refusal without the reading behind it", () => {
    const shown = catalogueRows();
    expect(shown).toHaveLength(CATALOGUE.length);
    // Offered first, refused after — one boundary, not an interleaving.
    const firstRefused = shown.findIndex((row) => !row.offerable);
    expect(firstRefused).toBeGreaterThan(0);
    expect(shown.slice(0, firstRefused).every((row) => row.offerable)).toBe(true);
    expect(shown.slice(firstRefused).some((row) => row.offerable)).toBe(false);

    for (const row of shown) {
      // A refused asset carries EVERY rule it failed, and an offered one
      // carries none: "offerable" and "no problems" are the same statement, so
      // a tile can never show a tick and a reason at once.
      expect(row.problems.length === 0).toBe(row.offerable);
      expect(row.offerable).toBe(isOfferable(row.asset));
      for (const failure of row.problems) expect(failure.why.length).toBeGreaterThan(0);
    }
  });

  it("answers for a mint it knows and null for one it does not, rather than guessing", () => {
    expect(catalogueAsset(SPYX_MINT)?.symbol).toBe("SPYx");
    expect(catalogueAsset(ANDURIL_MINT)?.symbol).toBe("ANDURIL");
    expect(catalogueAsset("NotAMintAnybodyPinned")).toBeNull();
  });
});

describe("the rows: four rules the program would otherwise refuse after Phantom had signed", () => {
  it("REMOVES an unticked stock instead of keeping it at 0 %", () => {
    const after = toggled(rows([SPYX_MINT, "50"], [ANTHROPIC_MINT, "50"]), ANTHROPIC_MINT, false);
    expect(after.map((row) => row.mint)).toEqual([SPYX_MINT]);
    // The rule is not "its percent became 0" — set_invest_policy takes
    // weight_bps as a u16 it requires to be > 0, so a 0 % row is a transaction
    // the chain rejects. Absence is the only way out of the basket.
    expect(after.some((row) => row.percent === "0")).toBe(false);
    // Unticking something that was never ticked changes nothing.
    expect(toggled(after, ANTHROPIC_MINT, false)).toEqual(after);
  });

  it("adds a ticked stock with an EMPTY box, because a share nobody typed is a share nobody chose", () => {
    const after = toggled(rows([SPYX_MINT, "50"]), ANTHROPIC_MINT, true);
    expect(after).toEqual([
      { mint: SPYX_MINT, percent: "50" },
      { mint: ANTHROPIC_MINT, percent: "" },
    ]);
    // Ticking what is already ticked does not duplicate the mint — the program
    // refuses a repeated mint outright, and the sum would still be 100.
    expect(toggled(after, SPYX_MINT, true)).toEqual(after);
  });

  it("refuses a sixth stock and refuses one the shelf refuses, so neither is first met at Sign", () => {
    // A FULL BASKET THAT DOES NOT ALREADY HOLD SPYx, so what refuses the sixth
    // row is the COUNT and not the no-duplicates rule beside it. The shelf is
    // two stocks deep today, so the other four rows are fillers.
    const full = rows([ANTHROPIC_MINT, "20"], ...Array.from({ length: PICKER_MAX_LEGS - 1 }, (_, index) => [`Filler${index}`, "20"] as const));
    expect(full).toHaveLength(PICKER_MAX_LEGS);
    expect(full.some((row) => row.mint === SPYX_MINT)).toBe(false);
    expect(toggled(full, SPYX_MINT, true)).toEqual(full);
    // One row lighter and the same tick goes through, so the refusal above is
    // the limit doing its job rather than the guard refusing everything.
    expect(toggled(full.slice(1), SPYX_MINT, true)).toHaveLength(PICKER_MAX_LEGS);

    // And a refused asset never enters a basket with room in it. OPENAI is off
    // the shelf on its price at the reference size; ANDURIL on its depth.
    const room = rows([SPYX_MINT, "50"]);
    expect(toggled(room, OPENAI_MINT, true)).toEqual(room);
    expect(toggled(room, ANDURIL_MINT, true)).toEqual(room);
    expect(toggled(room, "NotAMintAnybodyPinned", true)).toEqual(room);
    // What IS offered goes in, so the guard is a rule and not a blanket.
    expect(toggled(room, ANTHROPIC_MINT, true)).toHaveLength(2);
  });

  it("keeps a typed share exactly as typed, and touches only the row it names", () => {
    const before = rows([SPYX_MINT, "50"], [ANTHROPIC_MINT, "50"]);
    // "07" is not corrected to "7" and "5.5" is not rounded: readWeights
    // refuses both and names the stock. A picker that repaired the text here
    // would be choosing a share the owner did not.
    expect(withPercent(before, SPYX_MINT, "07")).toEqual([
      { mint: SPYX_MINT, percent: "07" },
      { mint: ANTHROPIC_MINT, percent: "50" },
    ]);
    expect(withPercent(before, SPYX_MINT, "5.5")[0]!.percent).toBe("5.5");
    expect(withPercent(before, SPYX_MINT, "")[0]!.percent).toBe("");
    expect(withPercent(before, "NotAMintAnybodyPinned", "99")).toEqual(before);
  });
});

describe("evening them out is the affordance, and it is exact at every count", () => {
  it("adds up to EXACTLY 100 at one through five, with the remainder on the first row", () => {
    for (let count = 1; count <= PICKER_MAX_LEGS; count += 1) {
      const shares = evenPercents(count);
      expect(shares).toHaveLength(count);
      expect(shares.reduce((total, share) => total + share, 0)).toBe(100);
      // Whole percents only: the boxes cannot hold a third of a hundred, and
      // basketWeightsBps's 33.34 % is exactly the figure this avoids.
      expect(shares.every((share) => Number.isInteger(share) && share > 0)).toBe(true);
    }
    expect(evenPercents(1)).toEqual([100]);
    expect(evenPercents(3)).toEqual([34, 33, 33]);
    expect(evenPercents(5)).toEqual([20, 20, 20, 20, 20]);
    expect(() => evenPercents(0)).toThrow(RangeError);
  });

  it("rewrites the shares and nothing else, and does not invent a row to even out", () => {
    const before = rows([SPYX_MINT, ""], [ANTHROPIC_MINT, "7"]);
    const after = evenedOut(before);
    expect(after.map((row) => row.mint)).toEqual(before.map((row) => row.mint));
    expect(percentTotal(after)).toBe(100);
    expect(evenedOut([])).toEqual([]);
  });

  it("counts an unreadable box as nothing, so the total on screen is never a guess", () => {
    expect(percentTotal(rows([SPYX_MINT, "50"], [ANTHROPIC_MINT, "50"]))).toBe(100);
    expect(percentTotal(rows([SPYX_MINT, "50"], [ANTHROPIC_MINT, ""]))).toBe(50);
    expect(percentTotal(rows([SPYX_MINT, "50"], [ANTHROPIC_MINT, "5.5"]))).toBe(50);
    expect(percentTotal(rows([SPYX_MINT, " 50 "]))).toBe(50);
  });
});

describe("the window of caps: computed from the basket, checked against the keeper's own rule", () => {
  it("reproduces the default basket's ceiling from the census, and is exact one raw unit either side", () => {
    const window = basketLimits(DEFAULT, MIN_TWO);
    // ⌈$2.50 × 10,000 / 5,000⌉ = $5.00: the smallest cap at which both legs
    // clear the per-leg minimum.
    expect(window.floorRaw).toBe(5_000_000n);
    expect(window.ceilingRaw).toBe(298_000_001n);
    expect(window.ceilingBinding?.symbol).toBe("ANTHROPIC");
    expect(window.empty).toBe(false);
    expect(window.uncounted).toEqual([]);

    // AGAINST THE RULE, NOT AGAINST ITSELF: the keeper's restated gate passes
    // at the ceiling and refuses one raw unit above it.
    expect(keeperWouldRefuse(window.ceilingRaw!, DEFAULT)).toBe(false);
    expect(keeperWouldRefuse(window.ceilingRaw! + 1n, DEFAULT)).toBe(true);
    expect(overCeiling(window.ceilingRaw!, window)).toBe(false);
    expect(overCeiling(window.ceilingRaw! + 1n, window)).toBe(true);

    // Half the ceiling, so an ordinary day's drift does not undo the start.
    expect(window.suggestedRaw).toBe(149_000_000n);
    expect(window.suggestedRaw).toBeGreaterThanOrEqual(window.floorRaw);
  });

  it("MOVES WITH THE SHARES, which is the whole reason it cannot be a literal", () => {
    // The same two stocks, the same readings, one weight moved: the two figures
    // the 2026-09-21 measurement recorded, reproduced from the census.
    const half = basketLimits(legs([SPYX_MINT, 50], [ANTHROPIC_MINT, 50]), MIN_TWO);
    const fifth = basketLimits(legs([SPYX_MINT, 80], [ANTHROPIC_MINT, 20]), MIN_TWO);
    expect(half.ceilingRaw! / 1_000_000n).toBe(298n);
    expect(fifth.ceilingRaw! / 1_000_000n).toBe(745n);
    // Not linear in the weight, either: two and a half times the ceiling for a
    // share two and a half times lighter is a coincidence of this pair, and the
    // binding leg can change identity when a weight moves.
    expect(fifth.ceilingBinding?.symbol).toBe("ANTHROPIC");
    expect(basketLimits(legs([SPYX_MINT, 99], [ANTHROPIC_MINT, 1]), MIN_TWO).ceilingBinding?.symbol).toBe("SPYx");
  });

  it("leaves the ceiling UNKNOWN when a chosen leg's route was never counted, rather than large", () => {
    // OPENAI's only figure is its venue's whole book, which no single route
    // touches. Dividing that by 50 would hand back a ceiling too HIGH — the one
    // direction this number may never be wrong in, because a cap above the real
    // ceiling does not buy less, it buys nothing at all.
    const openai = catalogueAsset(OPENAI_MINT)!;
    expect(routeCensusRaw(openai)).toBeNull();
    expect(openai.depth).not.toBeNull();

    const window = basketLimits([...legs([SPYX_MINT, 50]), { asset: openai, weightBps: 5_000 }], MIN_TWO);
    expect(window.ceilingRaw).toBeNull();
    expect(window.ceilingBinding).toBeNull();
    expect(window.uncounted.map((leg) => leg.symbol)).toEqual(["OPENAI"]);
    // The floor is arithmetic over what is being signed and survives regardless.
    expect(window.floorRaw).toBe(5_000_000n);
    expect(window.suggestedRaw).toBe(window.floorRaw);
    // And nothing is refused on a number nobody has: a refusal has to rest on
    // a figure, and the screen says so in words instead.
    expect(overCeiling(1_000_000_000_000n, window)).toBe(false);
  });

  it("reports an EMPTY window as a real outcome: a thin market at a heavy share admits no cap at all", () => {
    // ANTHROPIC at 99 % of a basket whose minimum is $5 a leg. The floor needs
    // $500 for the 1 % leg to clear $5; ANTHROPIC's counted route cannot cover
    // more than about $150. There is no max_per_call between them.
    const window = basketLimits(legs([SPYX_MINT, 1], [ANTHROPIC_MINT, 99]), 5_000_000n);
    expect(window.floorRaw).toBe(500_000_000n);
    expect(window.ceilingRaw).toBe(150_505_051n);
    expect(window.ceilingRaw! < window.floorRaw).toBe(true);
    expect(window.empty).toBe(true);
    expect(window.ceilingBinding?.symbol).toBe("ANTHROPIC");
    // The fix is the BASKET, so nothing here offers a cap as one: the suggested
    // value is not allowed to sit in a window that does not exist.
    expect(keeperWouldRefuse(window.floorRaw, legs([SPYX_MINT, 1], [ANTHROPIC_MINT, 99]))).toBe(true);
  });

  it("carries each leg's reading and its day, so a ceiling on screen can be re-run rather than argued with", () => {
    const window = basketLimits(DEFAULT, MIN_TWO);
    expect(window.legs.map((leg) => leg.symbol)).toEqual(["SPYx", "ANTHROPIC"]);
    for (const leg of window.legs) {
      expect(leg.censusRaw).not.toBeNull();
      expect(leg.readOn).toBe("2026-09-21");
      expect(leg.venue).not.toBeNull();
    }
    // The ceiling divides the ROUTE census, never the venue-wide figure beside
    // it: on ANTHROPIC the two differ by forty-five times, and only one of them
    // is what the keeper counts.
    const anthropic = catalogueAsset(ANTHROPIC_MINT)!;
    expect(routeCensusRaw(anthropic)).toBe(7_450_000_000n);
    expect(anthropic.depth!.usdcRaw).toBe(331_617_000_000n);
    expect(window.ceilingBinding!.censusRaw).toBe(routeCensusRaw(anthropic));
  });
});

describe("the lighter share a refusal offers is one the owner can actually type", () => {
  it("is a WHOLE percent, still passes the gate, and the next percent up does not", () => {
    const window = basketLimits(DEFAULT, MIN_TWO);
    const cap = 1_000_000_000n; // $1,000: the old shipped default, well over the ceiling.
    expect(overCeiling(cap, window)).toBe(true);

    const lighter = lighterWeightBps(cap, window);
    expect(lighter).not.toBeNull();
    // THE EXACT BOUNDARY IS 14.89 %, WHICH NO BOX ON THIS PAGE CAN HOLD. A
    // refusal that tells the owner to type a share readWeights would refuse is
    // not a way out, and rounding it the other way puts him back over the
    // ceiling he was just refused for.
    expect(lighter! % 100).toBe(0);
    expect(lighter).toBe(1_400);

    const at = legs([SPYX_MINT, 86], [ANTHROPIC_MINT, lighter! / 100]);
    expect(keeperWouldRefuse(cap, at)).toBe(false);
    // One whole percent more fails, so the rounding gave away at most a percent.
    expect(keeperWouldRefuse(cap, legs([SPYX_MINT, 85], [ANTHROPIC_MINT, lighter! / 100 + 1]))).toBe(true);
  });

  it("offers nothing when the leg already passes, when no share under a percent would save it, and when nobody counted it", () => {
    const window = basketLimits(DEFAULT, MIN_TWO);
    // Already inside the ceiling: there is nothing to fix.
    expect(lighterWeightBps(window.ceilingRaw!, window)).toBeNull();
    // A cap so large that even 1 % is too much — the leg has to go, and saying
    // "give it 0 %" would be naming a basket the program refuses.
    expect(lighterWeightBps(1_000_000_000_000n, window)).toBeNull();
    // A leg nobody counted has no boundary to lighten towards.
    const uncounted = basketLimits([...legs([SPYX_MINT, 50]), { asset: catalogueAsset(OPENAI_MINT)!, weightBps: 5_000 }], MIN_TWO);
    expect(lighterWeightBps(1_000_000_000n, uncounted)).toBeNull();
  });

  it("offers nothing in a ONE-STOCK basket, where the share is 100 % by arithmetic and cannot be lowered", () => {
    // ANTHROPIC alone at $500 a buy: its counted route covers $149, so the cap
    // is refused — and the refusal must not tell the owner to give it 29 %,
    // because the weights have to sum to exactly 10,000 and there is no second
    // stock for the other 71 % to go to.
    const alone = legs([ANTHROPIC_MINT, 100]);
    const window = basketLimits(alone, 2_500_000n);
    expect(window.ceilingRaw).toBe(149_000_000n);
    expect(overCeiling(500_000_000n, window)).toBe(true);
    expect(window.ceilingBinding?.weightBps).toBe(10_000);
    expect(lighterWeightBps(500_000_000n, window)).toBeNull();

    // Add a second stock and the same cap DOES have that way out, so what is
    // refused above is the one-leg case and not the advice itself.
    const paired = basketLimits(legs([SPYX_MINT, 50], [ANTHROPIC_MINT, 50]), 2_500_000n);
    expect(lighterWeightBps(500_000_000n, paired)).not.toBeNull();
  });
});

describe("the owner's 'maximo como 5' is one number", () => {
  it("is the catalogue's own, not a second copy that can drift", () => {
    expect(PICKER_MAX_LEGS).toBe(5);
    expect(MOST_PICKED).toBe(PICKER_MAX_LEGS);
    // The program would take eight. Five is the product's choice, and it is the
    // size every rule on the shelf was measured at.
    expect(PICKER_MAX_LEGS).toBeLessThan(8);
  });
});
