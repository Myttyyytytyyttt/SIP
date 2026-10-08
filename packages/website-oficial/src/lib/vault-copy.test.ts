// The rule texts' numbers, held to the code that acts on them — and, since the
// basket became the owner's, the rule texts THEMSELVES, held to the basket they
// are generated from.
//
// WHAT CHANGED AND WHY THIS FILE IS NEARLY NEW. Until the picker landed, three
// of the most dangerous paragraphs on the policy card named SPYx and ANTHROPIC
// in prose, and the last case in this file was a TRIPWIRE: it asserted that
// OFFERED_LEGS was exactly those two, so that the day the basket changed, the
// suite would go red and somebody would have to rewrite the words by hand. That
// was the honest thing to do while the words could not follow the basket. They
// can now: every one of them is built from the chosen legs and their own
// measured readings, so the tripwire is replaced by the property it was
// standing in for — NO PARAGRAPH MAY NAME A STOCK THE OWNER DID NOT CHOOSE, and
// every paragraph must name the ones he did.
//
// THROUGH A COMMITTED VECTOR, NOT THROUGH THE KEEPER'S TEXT. Each number below
// used to be regexed out of a keeper source file, so reflowing a line in a
// package the web may not edit turned a WEB gate red. The numbers now come from
// test/fixtures/keeper-policy.ts, which the keeper's own tests assert against
// too: a constant that moves fails in the keeper, a sentence that moves fails
// here. The fixture carries each number's MEANING as well as its digits — the
// unit the website prints, a worked example, the two cases either side of the
// keeper's comparison — because two packages can agree on "100" and disagree
// about what it counts.
//
// AND THE DOCTRINE THE SAME WAY. The last readFileSync calls here pinned the
// keeper's all-or-nothing rule and its transfer-hook switch by regexing two
// exported types and two expressions out of invest-decision.ts. They went on
// 2026-09-24: the sentences are now held to ALL_OR_NOTHING and TRANSFER_HOOK in
// the same vector, and the keeper's invest-decision.test.ts holds its types and
// its gates to those entries. A per-leg escape hatch fails in the keeper; an
// entry flipped to let one through fails here, beside the sentence it would
// make false.

import { describe, expect, it } from "vitest";

import { CATALOGUE, LIVE_PRICE_FLOOR_WAD, OFFERED_LEGS, PRESTOCKS_POWERS, floorWad, keeperInvestMinOutFor, type CatalogueAsset } from "@sip/solana-core/client";

import { ALL_OR_NOTHING, LEG_FEE, LIVE_PRICE_FLOOR, LOSS_FORGIVEN, OWNER_FLOOR_MIN_OUT, POOL_DEPTH, PYTH_GUARD, TRANSFER_HOOK } from "../../../solana-core/test/fixtures/keeper-policy";

import { ROUTE_COST_UNDER_MID_BPS, ROUTE_OVER_MID_BPS, floorRoom, keeperVenueThresholdWad } from "@/lib/invest-limits";
import {
  INVEST_COPY,
  LOSS_DROPPED_AFTER_TXS,
  MAX_LEG_FEE_BPS,
  POOL_DEPTH_MULTIPLE,
  PYTH_CONF_BPS,
  PYTH_DEVIATION_BPS,
  PYTH_MAX_AGE_SECONDS,
  VAULT_COPY,
  ratePercent,
  roundTripPercent,
  shortAddress,
  signedLegsOf,
  type SignedLeg,
} from "@/lib/vault-copy";

// ── THE BASKETS THESE CASES ARE WRITTEN ABOUT ────────────────────────────────
//
// REAL CATALOGUE ENTRIES WHEREVER ONE EXISTS, per docs/TESTING_TRAPS.md: "give
// a fixture the REAL value for anything the code under test is meant to carry
// through — the mint the catalogue actually lists". So SPYx and ANTHROPIC come
// out of CATALOGUE with their own mainnet fee readings attached, and the two
// invented legs below exist only for shapes today's shelf does not carry: a
// SECOND xStock (there is one) and a leg whose fee nobody has read (there is
// none). Both are labelled as inventions and neither is given a measurement
// that does not exist.
const asset = (symbol: string): CatalogueAsset => {
  const found = CATALOGUE.find((entry) => entry.symbol === symbol);
  if (found === undefined) throw new Error(`the catalogue no longer lists ${symbol}`);
  return found;
};

const SPYX = signedLegsOf([asset("SPYx")])[0]!;
const ANTHROPIC = signedLegsOf([asset("ANTHROPIC")])[0]!;

/** INVENTED: a second xStock, to prove the xStock sentences are about a group and not about SPYx. No reading of a real GLDx mint is claimed. */
const GLDX_SHAPED: SignedLeg = { symbol: "GLDx", group: "xstock", feeBps: 0, feeEpoch: 1039, feeReadOn: "2026-09-21", scheduledFeeBps: null, scheduledFeeEpoch: null, feeSettingAbsent: true };
/** INVENTED: a PreStock whose fee nobody has read. Every catalogue PreStock has been read, so this shape has to be built to be tested. */
const UNREAD_PRESTOCK: SignedLeg = { symbol: "ANDURIL", group: "prestock", feeBps: null, feeEpoch: null, feeReadOn: null, scheduledFeeBps: null, scheduledFeeEpoch: null, feeSettingAbsent: false };

const BASKETS = {
  /** What the form opens on today. */
  both: [SPYX, ANTHROPIC] as readonly SignedLeg[],
  /** One xStock: no fee anywhere, and no PreStock to talk about. */
  spyxOnly: [SPYX] as readonly SignedLeg[],
  /** One PreStock: one key holds everything, and there is no safer leg beside it. */
  anthropicOnly: [ANTHROPIC] as readonly SignedLeg[],
  /** Two xStocks: nothing in the basket can ever charge a fee. */
  xstocks: [SPYX, GLDX_SHAPED] as readonly SignedLeg[],
  /** A leg nobody has read a fee for, which must never be described as free. */
  unread: [SPYX, UNREAD_PRESTOCK] as readonly SignedLeg[],
} as const;

/** Every paragraph generated for one basket, so a property can be asserted of all of them at once. */
const paragraphsFor = (legs: readonly SignedLeg[]): Record<string, string> => ({
  issuerCost: INVEST_COPY.issuerCost(legs),
  feeCeiling: INVEST_COPY.feeCeiling(legs),
  marketCost: INVEST_COPY.marketCost(legs),
  keeperChecks: INVEST_COPY.keeperChecks(legs),
  freezeNotice: INVEST_COPY.freezeNotice(legs),
  issuerKeys: INVEST_COPY.issuerKeys(legs),
  hookSwitch: INVEST_COPY.hookSwitch(legs),
  freezeShort: INVEST_COPY.freezeShort(legs),
  acknowledge: INVEST_COPY.acknowledge(legs),
});

describe("the PROFIT rule", () => {
  it("says a loss comes off the next gain only until the trading wallet signs the keeper's own count of transactions, and names that count", () => {
    // THE VECTOR, not the keeper's file: the keeper's settle-decision.test.ts
    // ("THE KEEPER'S HALF OF LOSS_FORGIVEN") holds ZERO_BASE_MIN_TXS to this
    // same entry and runs its boundary through the settle gate. Until
    // 2026-09-24 nothing did: the keeper pinned its count to a bare 100, so a
    // keeper moved to 90 with its own literals left this case green, and the
    // sentence below promising 100.
    expect(LOSS_DROPPED_AFTER_TXS).toBe(LOSS_FORGIVEN.keeper.value);
    expect(LOSS_DROPPED_AFTER_TXS).toBe(LOSS_FORGIVEN.web.value);
    // AND THE MEANING, which is a count of transactions and not of anything
    // else: the loss is still carried one transaction below it and forgotten at
    // it, so a sentence promising forgiveness A transaction earlier is wrong.
    expect(LOSS_FORGIVEN.boundary.forgottenAtTxs).toBe(LOSS_DROPPED_AFTER_TXS);
    expect(LOSS_FORGIVEN.boundary.stillCarriedAtTxs).toBe(LOSS_DROPPED_AFTER_TXS - 1);

    const rule = VAULT_COPY.profitRule("20 %", "0.06", "0.05");
    expect(rule).toContain(
      `A losing stretch moves nothing, and its loss comes off the next gain. Once your trading wallet has signed ${LOSS_DROPPED_AFTER_TXS} transactions of its own while still behind, that loss is dropped and later gains count in full.`,
    );
    expect(rule).not.toMatch(/its loss comes off the next gain\. One settlement/);
  });
});

describe("the thin-pool notice", () => {
  it("says the keeper's own depth multiple, not a number of its own, and tells the owner to lower the cap it names", () => {
    // THE VECTOR, not the keeper's file.
    expect(BigInt(POOL_DEPTH_MULTIPLE)).toBe(POOL_DEPTH.keeper.value);
    expect(POOL_DEPTH_MULTIPLE).toBe(POOL_DEPTH.web.value);
    // AND THE MEANING, which is the half a bare "50" cannot carry: a MULTIPLE
    // of the pool's reserve, so one buy is at most a fiftieth — 2 % — of it.
    expect(100 / POOL_DEPTH_MULTIPLE).toBe(POOL_DEPTH.largestShareOfReservePercent);
    expect(POOL_DEPTH.worked.spend * POOL_DEPTH.keeper.value).toBe(POOL_DEPTH.worked.requiredReserve);

    // EVERY FIGURE IS PASSED IN. A hard-coded dollar figure reappearing in this
    // string is the regression this argument list exists to make impossible.
    const notice = INVEST_COPY.thinPool("$298.00", "$149.00", "ANTHROPIC", "2026-09-21");
    expect(notice).toContain(`holds at least ${POOL_DEPTH_MULTIPLE} times that buy`);
    expect(notice).toContain("the leg that sets it is ANTHROPIC");
    expect(notice).toContain("on 2026-09-21");
    expect(notice).toContain("the whole buy can be at most $298.00");
    expect(notice).toContain("Most per buy starts at $149.00, which is half the ceiling");
    expect(notice).not.toMatch(/\$9,5|\$190|\$380|20 September/);
    // ALL OR NOTHING, which is the keeper's own doctrine.
    expect(notice).toContain("a buy takes all of the basket or none");
    expect(notice).toContain("nothing bought, no SOL converted, at any balance");
    // THE DOCTRINE, THROUGH THE VECTOR. The keeper's DepthDecision carries ONE
    // verdict for the whole basket and no per-leg outcome, so a half-basket is
    // unrepresentable; the keeper's own test holds that type, and what the gate
    // returns for a basket with one drained leg, to this entry. Rewording
    // cannot break this; a per-leg escape hatch breaks it in the keeper, and
    // flipping the entry to allow one breaks it here.
    expect(ALL_OR_NOTHING.keeperTypes).toContain("DepthDecision");
    expect(ALL_OR_NOTHING).toMatchObject({ perLegOutcomes: false, refusesHealthyLegsToo: true, stopsSolConversion: true });
  });
});

describe("the transfer-fee ceiling", () => {
  it("says the keeper's own MAX_LEG_FEE_BPS and holds it to the gate's own comparison", () => {
    // THE VECTOR, not the keeper's file.
    expect(BigInt(MAX_LEG_FEE_BPS)).toBe(LEG_FEE.keeper.value);
    expect(MAX_LEG_FEE_BPS).toBe(LEG_FEE.web.value);
    // AND THE MEANING, in the unit this page prints: 300 bps is 3 % per transfer.
    expect(MAX_LEG_FEE_BPS / 100).toBe(LEG_FEE.percentPerTransfer);
    expect(ratePercent(MAX_LEG_FEE_BPS)).toBe("3 %");
    // AND THE ROUND TRIP THE OWNER ACCEPTED ON 2026-09-24, derived here and
    // held to the vector's own figure: 1 - 0.97^2, not 6 %.
    expect(roundTripPercent(MAX_LEG_FEE_BPS)).toBe(`${LEG_FEE.roundTripPercent} %`);
    expect(roundTripPercent(MAX_LEG_FEE_BPS)).toBe("5.91 %");
    // STRICTLY GREATER, so a leg sitting exactly on the limit is admitted with
    // no margin -- which is seven PreStocks' position from epoch 1043. If this
    // gate ever became >=, the copy would be wrong in the owner's favour.
    expect(LEG_FEE.boundary.admittedAtBps).toBe(LEG_FEE.keeper.value);
    expect(LEG_FEE.boundary.refusedAtBps).toBe(LEG_FEE.keeper.value + 1n);
    // The same all-or-nothing shape on the fee side: one refused leg, one
    // verdict, no per-leg admission. PINNED TO THE DOCTRINE, NOT TO THE
    // KEEPER'S LINE BREAKS: the keeper's test holds LegAdmission to this entry.
    expect(ALL_OR_NOTHING.keeperTypes).toContain("LegAdmission");
    expect(ALL_OR_NOTHING).toMatchObject({ perLegOutcomes: false, refusesHealthyLegsToo: true });
  });

  it("names the legs that land ON the limit, when, and the whole basket their next raise would stop", () => {
    const notice = INVEST_COPY.feeCeiling(BASKETS.both);
    expect(notice).toContain(`will not buy a stock that charges more than ${ratePercent(MAX_LEG_FEE_BPS)} to transfer`);
    // ANTHROPIC's WRITTEN fee IS the ceiling, read from its own mint, so the
    // sentence is generated rather than remembered: it is the leg's reading
    // that puts it here, not a name in a string. And it is the written one,
    // not the one charged today — so the sentence says both, and when.
    expect(ANTHROPIC.feeBps).toBe(100);
    expect(ANTHROPIC.scheduledFeeBps).toBe(MAX_LEG_FEE_BPS);
    expect(notice).toContain(
      "ANTHROPIC charges 1 % today, and its issuer has already written 3 % for epoch 1043, around 26 September 2026: from then it sits exactly on that limit, with no margin whatsoever.",
    );
    // NEVER "sits on that limit today": on 2026-09-24 it charged 1 %.
    expect(notice).not.toContain("sits exactly on that limit today");
    expect(notice).toContain("If that issuer raises its fee once more after that");
    // ALL OR NOTHING, and it NAMES the legs that go down with it — which is
    // what "SPYx along with it" used to say, in a sentence that could only ever
    // be true of one basket.
    expect(notice).toContain("the vault stops buying the whole basket — SPYx and ANTHROPIC, every one of them — and stops converting your SOL at all");
  });

  it("does not put a stock on the limit when the basket has none there, and says what can never reach it", () => {
    const notice = INVEST_COPY.feeCeiling(BASKETS.xstocks);
    expect(notice).not.toContain("sits exactly on that limit");
    // THE STRONGER CLAIM, AND ONLY WHERE THE MINT SUPPORTS IT: a Token-2022
    // mint with no TransferFeeConfig cannot gain one, so "can never reach it"
    // is a fact about the layout and not a promise about a key.
    expect(notice).toContain("Nothing you have chosen can ever reach it: SPYx and GLDx carry no fee setting at all, and no key anywhere can add one");
    expect(notice).not.toContain("ANTHROPIC");
  });

  it("never treats an unread fee as a zero fee, and says it cannot place it against the limit", () => {
    const notice = INVEST_COPY.feeCeiling(BASKETS.unread);
    expect(notice).toContain("SaverFi has not read ANDURIL's transfer fee, so it cannot tell you where it sits against that limit — and an unread fee is not a zero fee");
    expect(notice).not.toContain("ANDURIL charges nothing");
    // A PreStock is known to HAVE a fee setting (the 2026-09-21 read found the
    // one key holding transfer-fee-config on all eight), so a raise is a thing
    // that can be described even while the current fee is unread.
    expect(notice).toContain("If ANDURIL raises its fee past 3 %");
  });
});

describe("what the position costs", () => {
  /**
   * THE CLOSED FIGURES, from simulated round trips on mainnet (unsigned
   * transactions through simulateTransaction, the sell chained on the credit
   * the buy really returned), epoch 1039, 2026-09-20, n=7.
   *
   * The structural part is the one thing here that is arithmetic rather than a
   * reading, so it is computed: a 1 % fee charged once in and once out is
   * 1 - 0.99^2, which is 1.99 % and NOT "2 x 1 %".
   */
  it("gives up the issuer's fee compounded, not doubled, and computes it from the leg's own fee", () => {
    const structural = (1 - 0.99 ** 2) * 100;
    expect(Number(structural.toFixed(2))).toBe(1.99);
    expect(roundTripPercent(100)).toBe(`${Number(structural.toFixed(2))} %`);
    // At the 3 % written for epoch 1043: 1 - 0.97^2, still not twice the fee.
    expect(roundTripPercent(300)).toBe("5.91 %");
    // AND IT IS ARITHMETIC OVER THE LEG'S OWN FEE, not a figure typed once: half
    // the fee gives a different answer, and the same formula produces it.
    expect(roundTripPercent(50)).toBe("1 %");
    expect(roundTripPercent(0)).toBe("0 %");

    const cost = INVEST_COPY.issuerCost(BASKETS.both);
    expect(cost).toContain(`Going in and back out therefore gives up ${structural.toFixed(2)} % before the market is involved at all`);
    expect(cost).toContain("because the second charge is taken from what the first one left");
    // A FEE, NOT SLIPPAGE: no sentence may offer a smaller buy as a way out.
    expect(cost).toContain("Buying in smaller pieces does not make that smaller");
    expect(cost).toContain("every later buy pays it again");
    // NO FEE CAN EVER BE PUT ON SPYx, which is stronger than "charges nothing
    // today" and is the reason feeSettingAbsent exists as a separate field.
    expect(cost).toContain("its mint carries no fee setting at all, and no key with the power to add one");
    // WHAT IS CHARGED TODAY AND WHAT IS ALREADY WRITTEN, both, in that order:
    // on 2026-09-24 ANTHROPIC charged 1 % and had 3 % written for epoch 1043.
    expect(cost).toContain("ANTHROPIC's issuer charges 1 % of every transfer of it");
    expect(cost).toContain("That was its fee on 2026-09-24, in epoch 1041. Its issuer has already written 3 % for epoch 1043, around 26 September 2026; from then the same round trip gives up 5.91 %.");
    expect(cost).not.toContain("ANTHROPIC's issuer charges 3 %");
    // THE RAISES THAT HAVE ALREADY HAPPENED, dated, because they are the proof
    // the key is in use rather than merely held.
    expect(cost).toContain(
      "ANTHROPIC's was 0.5 % until it became 1 % on 20 September 2026, and on 24 September its issuer was found to have already written 3 % for epoch 1043",
    );
    expect(cost).not.toContain("when the current epoch began");
  });

  it("splits the measured round trip at the fee it was MEASURED at, not the one written for later", () => {
    // 2.4 % was measured at a 1 % fee. Split with the 3 % written for epoch
    // 1043 the issuer's "share" would be 5.91 % of a 2.4 % whole.
    const measured = INVEST_COPY.marketCost(BASKETS.both);
    expect(measured).toContain("The 1.99 % its issuer charged that day is the part of that which never moves");
    expect(measured).not.toContain("5.91 %");
  });

  it("quotes the measured round trips with their date, and says plainly where nobody measured one", () => {
    const measured = INVEST_COPY.marketCost(BASKETS.both);
    expect(measured).toContain("measured on 20 September 2026 on Solana itself");
    expect(measured).toContain("each sale priced on what its purchase actually delivered rather than on a quote");
    expect(measured).toContain("ANTHROPIC's round trip cost 2.4 % all told, between 2.24 % and 2.63 %");
    expect(measured).toContain("the rest, between 0.25 % and 0.64 %, is the market, and it moved by 0.36 % within thirteen minutes that day");
    expect(measured).toContain("SPYx's round trip cost between 0.011 % and 0.018 %");
    // AND THE SILENCE WHERE THERE IS NO MEASUREMENT. The catalogue has nine
    // assets and the simulation covered two; a paragraph that quietly described
    // the other seven would be the fourth species exactly.
    const unmeasured = INVEST_COPY.marketCost(BASKETS.xstocks);
    expect(unmeasured).toContain("Nobody has measured a round trip in GLDx, so what it costs beyond the transfer fee above is not a number SaverFi has");
    expect(unmeasured).not.toContain("2.4 %");
  });

  it("keeps the superseded readings out of every generated paragraph, in their own shape", () => {
    // BANNED IN ITS OWN SHAPE, NOT BY ITS DIGITS. The old claim was ANTHROPIC's
    // WHOLE round trip "between 0.41 % and 0.44 %". A bare ban on "0.41 %" was
    // wrong from the day the closed measurement landed: 2.4 - 1.99 = 0.41 is now
    // the market's own central share, so an editor writing it CORRECTLY would go
    // red for the wrong reason. The upper figure belongs to the dead reading and
    // to nothing else, so it stays banned outright.
    for (const legs of Object.values(BASKETS)) {
      for (const line of Object.values(paragraphsFor(legs))) {
        expect(line).not.toMatch(/0\.41 %\s*(?:and|to|[-–—])\s*0\.44 %/);
        expect(line).not.toContain("0.44 %");
        expect(line).not.toContain("0.01 % on SPYx");
        expect(line).not.toContain("half a percent");
        expect(line).not.toContain("1.3 % at $100");
        expect(line).not.toContain("because its pool is small");
      }
    }
    expect(Number((2.4 - (1 - 0.99 ** 2) * 100).toFixed(2))).toBe(0.41);
  });
});

describe("the issuers' powers, over the stocks actually chosen", () => {
  it("enumerates one PreStock key holding everything, with the key and the day it was read", () => {
    const powers = INVEST_COPY.issuerKeys(BASKETS.anthropicOnly);
    expect(powers).toContain(`one key — ${shortAddress(PRESTOCKS_POWERS.issuerKey)} —`);
    expect(powers).toContain("is the mint authority, the freeze authority, the transfer-fee authority and the permanent delegate of it");
    expect(powers).toContain("the same key can point every transfer at a program of its choosing");
    expect(powers).toContain(`read on ${PRESTOCKS_POWERS.readOn}`);
    // THE FOUR POWERS COME FROM THE CONSTANT, not from this sentence: if the
    // read ever finds a fifth, or loses one, the words and the record disagree.
    expect([...PRESTOCKS_POWERS.oneKeyHolds]).toEqual(["mint", "freeze", "permanent-delegate", "transfer-fee-config"]);
    expect(PRESTOCKS_POWERS.pausable).toBe(true);
    expect(PRESTOCKS_POWERS.transferHookProgram).toBeNull();
  });

  it("says of an xStock what is stronger and what is NOT claimed", () => {
    const powers = INVEST_COPY.issuerKeys(BASKETS.spyxOnly);
    expect(powers).toContain("no transfer-fee setting at all, and no key anywhere can add one");
    expect(powers).toContain("Token-2022 extensions are fixed at mint initialisation");
    // THE HALF THAT IS EASY TO OVER-READ: no fee authority is not no authority.
    expect(powers).toContain("That is about the fee and nothing else");
    expect(powers).toContain("a freeze authority, a permanent delegate, a pause and a default account state");
    // AND NOT ONE WORD ABOUT A KEY THAT IS NOT OVER THIS BASKET.
    expect(powers).not.toContain("ANTHROPIC");
    expect(powers).not.toContain(shortAddress(PRESTOCKS_POWERS.issuerKey));
  });

  it("splits the two groups when the basket holds both, and claims neither group's facts of the other", () => {
    const powers = INVEST_COPY.issuerKeys(BASKETS.both);
    expect(powers).toContain("ANTHROPIC is a PreStock");
    expect(powers).toContain("SPYx is an xStock");
    expect(powers).toContain("None of that is SaverFi's to grant or to take away, and none of it is Solana's.");
    // The single-key claim is attached to the PreStock and the no-fee-setting
    // claim to the xStock, never the other way about.
    expect(powers.indexOf("ANTHROPIC is a PreStock")).toBeLessThan(powers.indexOf("SPYx is an xStock"));
  });
});

describe("the transfer-hook switch", () => {
  /**
   * THE SECOND STOP. The fee is a number that can rise; this is a field that,
   * once filled in, refuses the leg outright — and by the same all-or-nothing
   * doctrine, the whole basket with it.
   *
   * PINNED TO THE KEEPER'S BEHAVIOUR AND NEVER TO ITS PROSE, through
   * TRANSFER_HOOK: the keeper's test decodes a hook of 32 zero bytes as empty
   * and buys it, and refuses any other, against that entry.
   */
  it("says the keeper refuses a leg whose hook is filled in, and that the refusal takes the whole basket by name", () => {
    // EMPTY MEANS 32 ZERO BYTES, which is what "the field is empty today"
    // rests on: anything else is a hook and is refused, the basket with it.
    expect(TRANSFER_HOOK).toMatchObject({ emptyProgramId: "11111111111111111111111111111111", emptyIsAdmitted: true, filledIsRefused: true });
    expect(ALL_OR_NOTHING).toMatchObject({ refusesHealthyLegsToo: true, stopsSolConversion: true });

    const notice = INVEST_COPY.hookSwitch(BASKETS.both);
    expect(notice).toContain("SaverFi will not buy a stock whose field has been filled in");
    expect(notice).toContain("On ANTHROPIC and SPYx that field was empty when SaverFi read it (ANTHROPIC on 2026-09-21 and SPYx on 2026-09-20)");
    expect(notice).toContain("the vault stops buying the whole basket — SPYx and ANTHROPIC, every one of them — and stops converting your SOL");
    expect(notice).toContain("It applies from the moment it is written: the next buy is the one that stops.");
    expect(notice).toContain("stop your pension buying anything at all");

    // THE STOP SPEAKS FOR ITSELF AND FOR NOTHING ELSE. This paragraph sits in
    // the same amber box as the permanent delegate, so a bare "nothing you have
    // saved is lost" reads there as a promise that box denies three lines up.
    expect(notice).toContain("That stop takes nothing from you: what you have already saved is neither lost nor moved by it.");
    expect(notice).toContain("The freeze, the pause and the permanent delegate described above are separate powers, and those can reach what your vault already holds.");
    expect(notice).not.toContain("Nothing you have already saved is lost or moved.");

    // THE STOP IS SYMMETRIC; THE FEE IS NOT — and neither side is weighed.
    expect(notice).toContain("either issuer can fill its own field in and stop the whole basket the same way");
    expect(notice).toContain("Nothing here measures which of them is likelier to.");
    expect(notice).toContain("The asymmetry that can be proved is the fee, not the stop");
    expect(notice).toContain("SPYx carries no fee setting at all and no key able to add one, while ANTHROPIC has one its issuer can raise");
    expect(notice).not.toMatch(/equally likely|just as likely|as likely to/);
  });

  it("does not generalise SPYx's reading to an xStock nobody read", () => {
    // THE FOURTH SPECIES, CAUGHT AT ITS SOURCE. The PreStocks read covered all
    // eight of those mints; the xStocks read covered SPYx and nothing else.
    // Printing "empty today" for a mint nobody opened would be a sentence true
    // of what was measured and read as true in general.
    const notice = INVEST_COPY.hookSwitch(BASKETS.xstocks);
    expect(notice).toContain("SaverFi has not read that field on GLDx, and an unread field is not an empty one.");
    expect(notice).not.toContain("GLDx on 2026-09-20");
  });

  it("offers no fee that may rise when the basket cannot carry one", () => {
    // A closing line about "a fee that may rise" in an all-xStock basket would
    // be describing a setting those mints do not have.
    expect(INVEST_COPY.hookSwitch(BASKETS.xstocks)).toContain("whatever the fees are");
    expect(INVEST_COPY.hookSwitch(BASKETS.both)).toContain("not only a fee that may rise");
  });

  it("puts on the tick-box the powers over the legs he is actually signing", () => {
    expect(INVEST_COPY.acknowledge(BASKETS.both)).toBe(
      "I understand each issuer can freeze, pause or move its own stock out of my vault, that one key holds all of those powers over ANTHROPIC, and that any of these issuers can stop my vault buying anything at all",
    );
    // NO PRESTOCK, NO SINGLE-KEY CLAUSE: the box must not have him acknowledge
    // a key that is over nothing he holds.
    expect(INVEST_COPY.acknowledge(BASKETS.spyxOnly)).toBe(
      "I understand each issuer can freeze, pause or move its own stock out of my vault, and that any of these issuers can stop my vault buying anything at all",
    );
    expect(INVEST_COPY.acknowledge(BASKETS.spyxOnly)).not.toContain("one key");
    expect(INVEST_COPY.acknowledge(BASKETS.unread)).toContain("over ANDURIL");
  });
});

describe("the copy is generated from the basket, and names nothing else", () => {
  /**
   * THIS REPLACES THE TRIPWIRE, and it is the property the tripwire stood in
   * for. The old case asserted OFFERED_LEGS was exactly ["SPYx", "ANTHROPIC"]
   * and that two paragraphs contained the words "the whole basket — SPYx along
   * with it": it could only ever say WHEN the sentences had gone stale, never
   * that they were right. This says what must hold for every basket the picker
   * can produce.
   */
  it("names every chosen leg, and no catalogue stock that was not chosen", () => {
    const catalogueSymbols = CATALOGUE.map((entry) => entry.symbol);
    for (const [name, legs] of Object.entries(BASKETS)) {
      const chosen = legs.map((leg) => leg.symbol);
      const strangers = catalogueSymbols.filter((symbol) => !chosen.includes(symbol));
      const paragraphs = paragraphsFor(legs);
      for (const [which, line] of Object.entries(paragraphs)) {
        for (const stranger of strangers) {
          expect(line, `${which} of the ${name} basket names ${stranger}, which the owner did not choose`).not.toContain(stranger);
        }
      }
      // AND THE CHOSEN ONES ARE THERE: a paragraph that named nobody would pass
      // the half above while telling the owner nothing about his own basket.
      for (const symbol of chosen) {
        expect(paragraphs.issuerCost, `issuerCost of the ${name} basket does not name ${symbol}`).toContain(symbol);
        expect(paragraphs.hookSwitch, `hookSwitch of the ${name} basket does not name ${symbol}`).toContain(symbol);
        expect(paragraphs.issuerKeys, `issuerKeys of the ${name} basket does not name ${symbol}`).toContain(symbol);
      }
    }
  });

  it("names the whole basket wherever a refusal takes the whole basket", () => {
    // The all-or-nothing phrase is the one that understated the damage while it
    // was hand-written: "SPYx along with it" costs the reader every OTHER leg
    // he picked. Both paragraphs that carry it are checked at one leg and at
    // five, because the phrasing differs and only one of them can be wrong.
    const five: readonly SignedLeg[] = [SPYX, ANTHROPIC, GLDX_SHAPED, UNREAD_PRESTOCK, { ...GLDX_SHAPED, symbol: "MSTRx" }];
    for (const paragraph of [INVEST_COPY.feeCeiling(five), INVEST_COPY.hookSwitch(five)]) {
      expect(paragraph).toContain("the whole basket — SPYx, ANTHROPIC, GLDx, ANDURIL and MSTRx, every one of them —");
    }
    for (const paragraph of [INVEST_COPY.feeCeiling(BASKETS.anthropicOnly), INVEST_COPY.hookSwitch(BASKETS.anthropicOnly)]) {
      expect(paragraph).toContain("the whole basket — which is ANTHROPIC alone —");
      expect(paragraph).not.toContain("every one of them");
    }
  });

  it("derives 'no key can ever add a fee' from the shelf's own reading, not from the group's name", () => {
    // THE CONVENTION THIS COPY RESTS ON, CHECKED AGAINST THE CATALOGUE. An
    // xStock entry with a zero fee is a reading of the EXTENSION'S ABSENCE —
    // product.ts's SPYx entry says so in `fee.by` — and only that supports "no
    // key anywhere can add one". If someone lists an xStock whose zero is
    // merely a zero, this goes red instead of the sentence going quietly false.
    for (const entry of CATALOGUE.filter((candidate) => candidate.group === "xstock" && candidate.fee?.bps === 0)) {
      expect(entry.fee!.by, `${entry.symbol}'s zero fee must be read as the absence of the extension`).toMatch(/no TransferFeeConfig/i);
    }
    expect(SPYX.feeSettingAbsent).toBe(true);
    expect(ANTHROPIC.feeSettingAbsent).toBe(false);
    expect(UNREAD_PRESTOCK.feeSettingAbsent).toBe(false);
  });

  it("still describes the basket the form opens on, whatever OFFERED_LEGS becomes", () => {
    // NOT A TRIPWIRE: nothing here asserts which legs are offered. It asserts
    // that the paragraphs generated for whatever IS offered name those legs and
    // carry a fee reading for each — so a leg added to the shelf without a fee
    // read is caught here rather than on the owner's screen.
    const offered = signedLegsOf(OFFERED_LEGS);
    const cost = INVEST_COPY.issuerCost(offered);
    for (const leg of offered) {
      expect(cost).toContain(leg.symbol);
      expect(leg.feeBps, `${leg.symbol} is offered with no fee reading`).not.toBeNull();
    }
  });
});

describe("how the price is set: the live price, the keeper's checks, and what the chain still enforces", () => {
  /** The keeper's slippage for a leg at this fee, from the VECTOR (legSlippageBps = max(200, fee + 100)), never from the page's own copy. */
  const legSlippage = (fee: bigint): bigint => (LEG_FEE.slippageBps > fee + LEG_FEE.slippageMarginBps ? LEG_FEE.slippageBps : fee + LEG_FEE.slippageMarginBps);
  /** The keeper's impact bar at this fee, from the VECTOR's worked pairs. */
  const impact = (fee: bigint): bigint => LEG_FEE.impactCeilingBps.find(([at]) => at === fee)![1];
  const pct = (bps: bigint): string => ratePercent(Number(bps));

  it("states the owner's decision plainly: no price floor, and a price move never asks him to sign again", () => {
    expect(INVEST_COPY.livePrice).toBe(
      "SaverFi buys at the live market price. What you sign has no price floor, so a stock rising or SOL falling is not a reason for SaverFi to stop buying, and a price move never asks you to sign again.",
    );
    // And the constant the page builds every policy with is the vector's: the
    // least the program accepts, which floors nothing.
    expect(LIVE_PRICE_FLOOR_WAD).toBe(LIVE_PRICE_FLOOR.web.value);
  });

  it("quotes the keeper's own numbers for the chosen legs — slippage and impact at each leg's highest written fee, cover, fee ceiling and the Pyth guard", () => {
    // SPYx has no fee; ANTHROPIC's issuer has written 300 bps.
    const spyxFee = BigInt(SPYX.feeBps ?? 0);
    const anthropicFee = BigInt(Math.max(ANTHROPIC.feeBps ?? 0, ANTHROPIC.scheduledFeeBps ?? 0));
    expect([spyxFee, anthropicFee]).toEqual([0n, 300n]);
    expect(INVEST_COPY.keeperChecks(BASKETS.both)).toBe(
      `Before every buy, SaverFi's keeper asks Jupiter for a live quote for that exact buy and sends it with the least the vault must receive: the quote less ${pct(legSlippage(spyxFee))} (${pct(legSlippage(anthropicFee))} for ANTHROPIC), and less the transfer fee. ` +
        `It does not buy when the venue holds less than ${POOL_DEPTH.web.value} times the buy, when the full buy is quoted more than ${pct(impact(spyxFee))} (${pct(impact(anthropicFee))} for ANTHROPIC) worse than a sixteenth of it on the same route, or when a stock's issuer charges more than ${LEG_FEE.percentPerTransfer} % to move it. ` +
        `Converting SOL to USDC is also checked against the SOL price Pyth publishes: it waits while that price is more than ${PYTH_GUARD.keeper.maxAgeSeconds} seconds old, uncertain by more than ${pct(PYTH_GUARD.keeper.confBps)}, or more than ${pct(PYTH_GUARD.keeper.deviationBps)} away from Jupiter's quote. ` +
        "Nothing outside the venue prices SPYx and ANTHROPIC: those checks compare Jupiter's own quotes and count what the venue holds, so they can tell a buy is too big for its market, not that the market's price is fair. A check that refuses waits for a later sweep; nothing asks you to approve again.",
    );
    // The figures, spelled, so a broken ratePercent cannot pass with them.
    expect(INVEST_COPY.keeperChecks(BASKETS.both)).toContain("the quote less 2 % (4 % for ANTHROPIC)");
    expect(INVEST_COPY.keeperChecks(BASKETS.both)).toContain("more than 0.5 % (0.25 % for ANTHROPIC) worse");
    // One leg, one number: nothing about a stock that is not in the basket.
    const spyxOnly = INVEST_COPY.keeperChecks(BASKETS.spyxOnly);
    expect(spyxOnly).toContain("the quote less 2 %, and less the transfer fee");
    expect(spyxOnly).not.toContain("ANTHROPIC");
    expect(INVEST_COPY.keeperChecks(BASKETS.anthropicOnly)).toContain("the quote less 4 %, and less the transfer fee");
  });

  it("holds the Pyth figures to the keeper's own constants through the vector", () => {
    expect([PYTH_MAX_AGE_SECONDS, PYTH_CONF_BPS, PYTH_DEVIATION_BPS]).toEqual([
      Number(PYTH_GUARD.keeper.maxAgeSeconds),
      Number(PYTH_GUARD.keeper.confBps),
      Number(PYTH_GUARD.keeper.deviationBps),
    ]);
    expect([PYTH_MAX_AGE_SECONDS, PYTH_CONF_BPS, PYTH_DEVIATION_BPS]).toEqual([PYTH_GUARD.web.maxAgeSeconds, PYTH_GUARD.web.confBps, PYTH_GUARD.web.deviationBps]);
    // THE UNIT THE PAGE PRINTS: 50 bps is half a percent, 500 is five.
    expect([ratePercent(PYTH_CONF_BPS), ratePercent(PYTH_DEVIATION_BPS)]).toEqual([`${PYTH_GUARD.confPercent} %`, `${PYTH_GUARD.deviationPercent} %`]);
  });

  it("says what the chain still enforces, and plainly what it no longer does if the keeper failed or its key were stolen", () => {
    expect(INVEST_COPY.chainLimits("$149.00", "$31,000.00")).toBe(
      "What Solana itself still enforces on every buy, whatever happens to SaverFi's keeper: at most $149.00 per buy and $31,000.00 per 30 days, only the stocks you chose, through the exchange you signed, and that the vault receives at least the minimum the keeper sent with the buy. " +
        "What it no longer enforces is a price: there is no price floor in what you sign. If SaverFi's keeper failed, or its key were stolen, nothing on Solana would stop a buy at a bad price — those caps are what would limit how much.",
    );
    expect(INVEST_COPY.chainLimits(null, null)).toContain("the most per buy and per 30 days you set");
  });

  it("promises nothing the checks cannot do, and no paragraph still describes a signed limit", () => {
    for (const legs of Object.values(BASKETS)) {
      const text = [INVEST_COPY.livePrice, INVEST_COPY.keeperChecks(legs), INVEST_COPY.chainLimits("$1.00", "$2.00")].join(" ");
      expect(text).not.toMatch(/best price|guarantee|protects you from a bad price|never (sold below|bought above)|price limits? (you sign|are set)/i);
    }
    expect(INVEST_COPY.policyRule("SPYx at 100 %", "$5.00", "$149.00", "$31,000.00", "0.01")).not.toMatch(/never below|limit|until you sign again/);
  });
});

describe("a floor signed before 2026-10-08, and whether the keeper still buys under it", () => {
  /**
   * ONLY AN OLD POLICY HAS A FLOOR TO JUDGE. Until 2026-10-08 the build signed
   * min_out_rate_wad 5-7 % under a pool's mid; such a policy keeps it until it
   * is signed again, and live-model.ts priceLimitsOf calls it "blocking" when
   * floorRoom answers "no-route" (or the market passed it). Every policy signed
   * since carries LIVE_PRICE_FLOOR_WAD, which every route clears.
   */
  /**
   * THE KEEPER'S RULE, FROM THE SHARED VECTOR, AND THE THREE STATES IT GIVES.
   * The keeper (jupiter-route.ts investMinOutFor, deployed with df6ca67) buys a
   * leg exactly when the venue's threshold — the quote less legSlippageBps(fee)
   * — is at or over the owner's floor. Derived here from LEG_FEE rather than
   * from catalogueLegSlippageBps, so a drift in either the keeper's vector or
   * the page's arithmetic goes red.
   */
  const legSlippage = (fee: bigint): bigint => (LEG_FEE.slippageBps > fee + LEG_FEE.slippageMarginBps ? LEG_FEE.slippageBps : fee + LEG_FEE.slippageMarginBps);
  const lessBps = (wad: bigint, bps: bigint): bigint => (wad * (10_000n - bps)) / 10_000n;
  // Measured at slot 450231345 (and unchanged since slot 450224399): the owner's signed ANTHROPIC floor, and its floor pool's mid.
  const ownerFloor = 902_223_869_744_110_771n;
  const mid = 950_870_892_320_522_646n;

  it("models the keeper's threshold as the quote less its ask — the fee comes off the quote only where the last hop quotes net", () => {
    const cost = BigInt(ROUTE_COST_UNDER_MID_BPS);
    for (const fee of [0n, 100n, 300n]) {
      expect(keeperVenueThresholdWad(mid, Number(fee), "gross")).toBe(lessBps(lessBps(mid, cost), legSlippage(fee)));
      expect(keeperVenueThresholdWad(mid, Number(fee), "net")).toBe(lessBps(lessBps(lessBps(mid, cost), fee), legSlippage(fee)));
    }
    // With no fee the two routes are the same route.
    expect(keeperVenueThresholdWad(mid, 0, "net")).toBe(keeperVenueThresholdWad(mid, 0, "gross"));
    // AND THE MODEL IS UNDER WHAT JUPITER ACTUALLY ANSWERED for the owner's leg
    // (the vector's measured Manifest route, 2,752,188 USDC raw in at slippage
    // 400): a screen that erred the other way would promise buys the keeper refuses.
    const { amountIn, venueThreshold } = OWNER_FLOOR_MIN_OUT.measured;
    expect((amountIn * keeperVenueThresholdWad(mid, 300, "gross")) / 10n ** 18n).toBeLessThanOrEqual(venueThreshold);
    // And the owner's floor, in raw units for that leg, is the vector's.
    expect((amountIn * ownerFloor) / 10n ** 18n).toBe(OWNER_FLOOR_MIN_OUT.ownersLeg.ownerFloor);
  });

  it("puts the owner's own ANTHROPIC floor, measured 2026-09-25, on some routes at 3 % and on every route at 1 % — not \"Sign again\"", () => {
    // 94.88 % of the gross mid. At 300 a gross last hop leaves 0.9975 x 0.96 =
    // 95.76 % and the keeper buys; a net one leaves 0.9975 x 0.97 x 0.96 =
    // 92.89 % and that sweep waits.
    expect(floorRoom(ownerFloor, mid, 300)).toBe("some-routes");
    expect(floorRoom(ownerFloor, mid, 100)).toBe("every-route");
    // THE OLD RULE, WHICH THIS MUST NOT GO BACK TO: min_out = the quote less the
    // ask, less the fee, compared with the floor. From a quote AT the mid it put
    // this floor 189 bps over and said "Sign again", while the deployed keeper
    // buys under it on a gross last hop (OWNER_FLOOR_MIN_OUT.ownersLeg). Any
    // model that takes the fee off before the gross comparison lands here.
    const oldBestAsk = lessBps(lessBps(mid, legSlippage(300n)), 300n);
    expect(ownerFloor > oldBestAsk).toBe(true);
    expect(OWNER_FLOOR_MIN_OUT.ownersLeg.buys).toBe(true);
    expect(floorRoom(oldBestAsk + 1n, mid, 300)).not.toBe("no-route");
  });

  it("draws the three states at the keeper's own boundaries: every route at the costliest net one, no route only past the kindest gross one", () => {
    for (const fee of [100, 300]) {
      const net = keeperVenueThresholdWad(mid, fee, "net");
      const gross = keeperVenueThresholdWad(mid, fee, "gross");
      const kindest = keeperVenueThresholdWad(mid, fee, "gross", "over-mid");
      expect(floorRoom(net, mid, fee), `at the net threshold, fee ${fee}`).toBe("every-route");
      expect(floorRoom(net + 1n, mid, fee), `one over the net threshold, fee ${fee}`).toBe("some-routes");
      expect(floorRoom(gross + 1n, mid, fee), `one over the costly gross threshold, fee ${fee}`).toBe("some-routes");
      expect(floorRoom(kindest, mid, fee), `at the kindest gross threshold, fee ${fee}`).toBe("some-routes");
      expect(floorRoom(kindest + 1n, mid, fee), `one over the kindest gross threshold, fee ${fee}`).toBe("no-route");
    }
    // With no fee, gross and net are one route, and only the route's own
    // price against the mid splits every route from some.
    const only = keeperVenueThresholdWad(mid, 0, "gross");
    const kindest = keeperVenueThresholdWad(mid, 0, "gross", "over-mid");
    expect(floorRoom(only, mid, 0)).toBe("every-route");
    expect(floorRoom(only + 1n, mid, 0)).toBe("some-routes");
    expect(floorRoom(kindest, mid, 0)).toBe("some-routes");
    expect(floorRoom(kindest + 1n, mid, 0)).toBe("no-route");
    // An unread number says nothing.
    expect(floorRoom(null, mid, 300)).toBeNull();
    expect(floorRoom(ownerFloor, null, 300)).toBeNull();
  });

  /**
   * A ROUTE CAN COME BACK OVER THE FLOOR POOL'S MID, so "no-route" — the one
   * state that flips the badge and says SaverFi does not buy — is judged at a
   * route ROUTE_OVER_MID_BPS over it, never at the 25 bps under it that splits
   * every route from some. Measured read-only 2026-09-25, slot 450236314:
   * SPYx's floor pool (Raydium CLMM 6truu3rZ…) at mid 129732643720761089;
   * Jupiter for 2,752,188 USDC raw in at slippage 200 answered 357,268 out,
   * otherAmountThreshold 350,123, on PancakeSwap — 6.16 bps OVER the mid
   * (and 74.5 USDC in, on Byreal, 5.97 bps over). SPYx has no transfer fee.
   */
  it("keeps a SPYx floor the keeper was measured buying under off \"Sign again\" — the route came back over the pool's mid", () => {
    const spyxMid = 129_732_643_720_761_089n;
    const amountIn = 2_752_188n;
    const outAmount = 357_268n;
    const venueThreshold = 350_123n;
    // The highest floor wad whose leg floor is at or under what Jupiter enforced.
    const floor = (venueThreshold * 10n ** 18n) / amountIn;
    const ownerFloor = (amountIn * floor) / 10n ** 18n;
    // The keeper's own rule buys it: with no fee its min_out is Jupiter's threshold itself.
    expect(keeperInvestMinOutFor({ venueThreshold, netOfVenueThreshold: venueThreshold, ownerFloor })).toBe(venueThreshold);
    // It sits past the costly model's threshold — the case the old rule called "no-route".
    expect(floor > keeperVenueThresholdWad(spyxMid, 0, "gross")).toBe(true);
    expect(floorRoom(floor, spyxMid, 0)).toBe("some-routes");
    // And the allowance covers the reading: over the mid by 6.16 bps, under 25.
    const atMid = (amountIn * spyxMid) / 10n ** 18n;
    expect(outAmount > atMid).toBe(true);
    expect((outAmount - atMid) * 10_000n).toBeLessThanOrEqual(BigInt(ROUTE_OVER_MID_BPS) * atMid);
  });

  it("puts a policy signed today — 1 wad, no price floor — on every route at any fee, and the flat 5 % signed before 2026-09-24 on every route with no fee", () => {
    for (const fee of [0, 100, 300]) expect(floorRoom(LIVE_PRICE_FLOOR_WAD, mid, fee), `signed today at ${fee}`).toBe("every-route");
    expect(floorRoom(floorWad(mid, 500), mid, 0)).toBe("every-route");
  });

  it("words the old limits as a stop only when they stop buying, and offers one switch either way", () => {
    expect(INVEST_COPY.oldLimitsBlocking).toContain("old price limits are stopping your buys");
    expect(INVEST_COPY.oldLimitsHeld).not.toMatch(/stopping your buys|are stopping/);
    // ALL OR NOTHING: a stop takes the SOL conversion too, and is said so.
    expect(INVEST_COPY.oldLimitsBlocking).toContain("nothing is bought, and no SOL is converted");
    for (const line of [INVEST_COPY.oldLimitsHeld, INVEST_COPY.oldLimitsBlocking]) {
      expect(line).toContain("Switching signs the same basket again at the live price");
      // The public name, and no engine-room words.
      expect(line).not.toMatch(/keeper|min_out|bps|wad|Nuvem|\bSIP\b|Jupiter|gross|net\b/i);
    }
    expect(INVEST_COPY.switchToLive).toBe("Switch to live-price buying");
  });
});
