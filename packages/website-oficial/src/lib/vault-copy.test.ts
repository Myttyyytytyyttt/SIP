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
// THE readFileSync CALLS THAT REMAIN pin DOCTRINE, never prose: the shape of
// two exported types and two expressions, none of which a rewording can touch.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CATALOGUE, CONVERT_FLOOR_MARGIN_BPS, LEG_FLOOR_MARGIN_BPS, OFFERED_LEGS, PRESTOCKS_POWERS, legFloorWad, type CatalogueAsset } from "@sip/solana-core/client";

import { LEG_FEE, LOSS_FORGIVEN, POOL_DEPTH } from "../../../solana-core/test/fixtures/keeper-policy";

import { FLOOR_DRIFT_NOTICE_MULTIPLE, floorDrift, floorOverKeeperAsk, keeperBestMinOutWad, legFloorUnderMidBps, signedSlackBps } from "@/lib/invest-limits";
import {
  INVEST_COPY,
  LOSS_DROPPED_AFTER_TXS,
  MAX_LEG_FEE_BPS,
  POOL_DEPTH_MULTIPLE,
  overTodayPercent,
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
  defencesLimits: INVEST_COPY.defencesLimits(legs, ratePercent(LEG_FLOOR_MARGIN_BPS)),
  freezeNotice: INVEST_COPY.freezeNotice(legs),
  issuerKeys: INVEST_COPY.issuerKeys(legs),
  hookSwitch: INVEST_COPY.hookSwitch(legs),
  freezeShort: INVEST_COPY.freezeShort(legs),
  acknowledge: INVEST_COPY.acknowledge(legs),
});

describe("the PROFIT rule", () => {
  it("says a loss comes off the next gain only until the trading wallet signs the keeper's own count of transactions, and names that count", () => {
    // THE VECTOR, not the keeper's file: the keeper's own tests hold
    // ZERO_BASE_MIN_TXS and the gate either side of it to this same entry.
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
    // THE DOCTRINE, PINNED TO AN EXPORTED TYPE RATHER THAN TO A SENTENCE.
    // DepthDecision carries ONE verdict for the whole basket and no per-leg
    // outcome at all: a half-basket is unrepresentable. Rewording cannot break
    // this; adding a per-leg escape hatch is exactly what should.
    const keeper = readFileSync(fileURLToPath(new URL("../../../solana-keeper/src/invest-decision.ts", import.meta.url)), "utf8");
    expect(keeper).toMatch(/export type DepthDecision =\s*\|\s*\{ readonly deep: true \}\s*\|\s*\{ readonly deep: false; readonly outcome: "REFUSED"; readonly detail: string \};/);
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
    // KEEPER'S LINE BREAKS.
    const keeper = readFileSync(fileURLToPath(new URL("../../../solana-keeper/src/invest-decision.ts", import.meta.url)), "utf8");
    expect(keeper).toMatch(/export type LegAdmission =/);
    expect(keeper).toMatch(/\{ readonly admit: false; readonly outcome: "REFUSED"; readonly detail: string \}/);
    const admission = keeper.slice(keeper.indexOf("export type LegAdmission ="), keeper.indexOf("readonly admit: false"));
    expect(admission).toMatch(/readonly admit: true;/);
    expect(admission, "a per-leg outcome in the admit arm is exactly what all-or-nothing forbids").not.toMatch(/outcome/);
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
   * PINNED TO THE KEEPER'S CODE AND NEVER TO ITS PROSE: two expressions, both
   * of which would have to be deleted for the sentence to become untrue.
   */
  it("says the keeper refuses a leg whose hook is filled in, and that the refusal takes the whole basket by name", () => {
    const keeper = readFileSync(fileURLToPath(new URL("../../../solana-keeper/src/invest-decision.ts", import.meta.url)), "utf8");
    // EMPTY MEANS THE DEFAULT PROGRAM ID, which is what "the field is empty
    // today" rests on: anything else is a hook and is refused.
    expect(keeper).toMatch(/transferHook = programId\.equals\(PublicKey\.default\) \? null : programId;/);
    expect(keeper).toMatch(/if \(facts\.transferHook !== null\) \{/);

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

describe("what the defences do not do", () => {
  it("says the depth gate measures size and not price, that Pyth covers the SOL leg only, and that the floor decays", () => {
    const limits = INVEST_COPY.defencesLimits(BASKETS.both, ratePercent(LEG_FLOOR_MARGIN_BPS));
    expect(limits).toContain(`holds at least ${POOL_DEPTH_MULTIPLE} times the buy`);
    expect(limits).toContain("THAT IS A CHECK ON SIZE, NOT ON PRICE");
    expect(limits).toContain("the SOL price Pyth publishes, which is the only number in a buy that does not come from the venue being traded against");
    expect(limits).toContain("SPYx and ANTHROPIC have no such anchor today");
    // THE FEE COMES OFF FIRST, AND A 3 % FEE WIDENS THE MARGIN — said with the
    // leg's own number and its cost, because "5 % under it" is not true of it.
    expect(limits).toContain(
      `it is taken from one pool's price at the moment you sign, less the highest transfer fee each stock's issuer has set, ${ratePercent(LEG_FLOOR_MARGIN_BPS)} under it ` +
        "(7 % for ANTHROPIC, whose fee makes each buy ask the market for more room — a lower limit, and so less protection against a bad price), and it does not follow the market afterwards",
    );
    // With no fee in the basket, the plain margin is the whole sentence.
    expect(INVEST_COPY.defencesLimits(BASKETS.spyxOnly, ratePercent(LEG_FLOOR_MARGIN_BPS))).toContain(
      `it is taken from one pool's price at the moment you sign, ${ratePercent(LEG_FLOOR_MARGIN_BPS)} under it, and it does not follow the market afterwards`,
    );
    expect(limits).toContain("the same number stops protecting you — or starts refusing every honest buy");
    // AND IT PROMISES NOTHING IT CANNOT DO. These are the readings a reader
    // would otherwise supply for free.
    expect(limits).not.toMatch(/fair price|best price|guarantee|protects you from a bad price|price is checked/i);
  });

  it("says it of the legs chosen, singular or plural, and of no others", () => {
    expect(INVEST_COPY.defencesLimits(BASKETS.anthropicOnly, "5 %")).toContain("ANTHROPIC has no such anchor today");
    expect(INVEST_COPY.defencesLimits(BASKETS.anthropicOnly, "5 %")).not.toContain("SPYx");
  });
});

describe("the floor the owner signed, and the market that moved away from it", () => {
  /**
   * THE ARITHMETIC AND THE WORDS ARE ASSERTED TOGETHER, on purpose: the whole
   * risk of this block is a sentence that says "drifted 30 %" over a number
   * that means something else. invest-limits.ts's floorDrift is the only
   * source, and the copy is a function of what it answers.
   *
   * WHAT A FLOOR IS: min_out_rate_wad, the least the vault accepts per unit
   * spent, derived once at signing from a pool's mid LEG_FLOOR_MARGIN_BPS under
   * it. The rate rising means the market moved AWAY from the floor (it now
   * permits a fill that much worse than today); the rate falling THROUGH the
   * floor means nothing buys at all.
   */
  /**
   * THE KEEPER'S BEST ASK, FROM THE SHARED VECTOR. The keeper's min_out is the
   * quote less legSlippageBps(fee) = max(slippageBps, fee + slippageMarginBps),
   * less the fee; from a quote exactly at the mid that is its ceiling. Derived
   * here from LEG_FEE rather than from catalogueLegSlippageBps, so a drift in
   * either the keeper's vector or the page's arithmetic goes red.
   */
  it("says a signed floor is over the keeper's ask exactly when the keeper's best min_out cannot reach it — the owner's own ANTHROPIC floor, measured 2026-09-25", () => {
    const legSlippage = (fee: bigint): bigint => (LEG_FEE.slippageBps > fee + LEG_FEE.slippageMarginBps ? LEG_FEE.slippageBps : fee + LEG_FEE.slippageMarginBps);
    const bestAsk = (mid: bigint, fee: bigint): bigint => {
      const afterSlippage = (mid * (10_000n - legSlippage(fee))) / 10_000n;
      return (afterSlippage * (10_000n - fee)) / 10_000n;
    };
    // Measured at slot 450224399: the owner's signed floor, and the pool mid.
    const ownerFloor = 902_223_869_744_110_771n;
    const mid = 950_870_892_320_522_646n;
    for (const fee of [0n, 100n, 300n]) expect(keeperBestMinOutWad(mid, Number(fee))).toBe(bestAsk(mid, fee));
    // At 300 the keeper's best is 0.96 x 0.97 = 93.12 % of the mid, and the
    // owner's floor (94.88 % of it) sits about 189 bps above: refused every sweep.
    expect(floorOverKeeperAsk(ownerFloor, mid, 300)).toBe(true);
    expect(Number(((ownerFloor - keeperBestMinOutWad(mid, 300)) * 10_000n) / keeperBestMinOutWad(mid, 300))).toBe(189);
    // At the 100 in force before epoch 1043 the same floor clears (0.98 x 0.99 = 97.02 %).
    expect(floorOverKeeperAsk(ownerFloor, mid, 100)).toBe(false);
    // A floor signed under today's rule clears at 300.
    expect(floorOverKeeperAsk(legFloorWad(mid, 300), mid, 300)).toBe(false);
    // THE BOUNDARY: at the ask it clears, one unit over it does not.
    expect(floorOverKeeperAsk(keeperBestMinOutWad(mid, 300), mid, 300)).toBe(false);
    expect(floorOverKeeperAsk(keeperBestMinOutWad(mid, 300) + 1n, mid, 300)).toBe(true);
    // An unread number says nothing.
    expect(floorOverKeeperAsk(null, mid, 300)).toBe(false);
    expect(floorOverKeeperAsk(ownerFloor, null, 300)).toBe(false);
  });

  it("measures the slack against the floor, and calls it out only past twice the margin it was signed at", () => {
    // At signing, a floor set m bps under the market sits m/(10,000-m) under it
    // as a ratio: 526 bps at the 500 the legs are signed with, 1,111 at the
    // 1,000 the SOL floor is.
    expect(signedSlackBps(LEG_FLOOR_MARGIN_BPS)).toBe(526);
    expect(signedSlackBps(CONVERT_FLOOR_MARGIN_BPS)).toBe(1_111);

    // A FLOOR JUST SIGNED IS IN STEP, and stays in step through an ordinary
    // day's movement: that is what the margin was for.
    const justSigned = floorDrift(9_500n, 10_000n, LEG_FLOOR_MARGIN_BPS);
    expect(justSigned).toEqual({ kind: "in-step", driftBps: 526 });

    // THE BOUNDARY, ON BOTH SIDES. Twice the signed slack is still in step; one
    // basis point past it is called out. A test that only asserted the loud
    // case could not tell this rule from any other.
    const edge = signedSlackBps(LEG_FLOOR_MARGIN_BPS) * FLOOR_DRIFT_NOTICE_MULTIPLE;
    expect(edge).toBe(1_052);
    expect(floorDrift(10_000n, 10_000n + BigInt(edge), LEG_FLOOR_MARGIN_BPS)).toEqual({ kind: "in-step", driftBps: edge });
    expect(floorDrift(10_000n, 10_000n + BigInt(edge) + 1n, LEG_FLOOR_MARGIN_BPS)).toEqual({ kind: "slack", driftBps: edge + 1 });

    // THE MARKET THROUGH THE FLOOR: the loud half, which the badge already
    // showed and which is repeated here as what it stops.
    expect(floorDrift(10_001n, 10_000n, LEG_FLOOR_MARGIN_BPS)).toEqual({ kind: "passed" });
    // AND AN UNREAD RATE IS NOT A DRIFT OF ZERO.
    expect(floorDrift(null, 10_000n, LEG_FLOOR_MARGIN_BPS)).toBeNull();
    expect(floorDrift(10_000n, null, LEG_FLOOR_MARGIN_BPS)).toBeNull();
    expect(floorDrift(0n, 10_000n, LEG_FLOOR_MARGIN_BPS)).toBeNull();
  });

  it("measures a floor netted of a 3 % fee against the gross mid at its own margin, so a floor just signed is not called slack", () => {
    // The fee and legFloorMarginBps compounded, under the GROSS mid the screen
    // reads: 500 with no fee, 595 at 100 bps, 979 at 300 (0.97 x 0.93 = 0.9021).
    expect([0, 100, 300].map(legFloorUnderMidBps)).toEqual([500, 595, 979]);
    const mid = 10n ** 18n;
    const signedAt300 = legFloorWad(mid, 300);
    expect(signedAt300).toBe(902_100_000_000_000_000n);
    // JUST SIGNED, IN STEP at its own margin — and at the plain 500 the same
    // floor would already read as slack (1,085 bps past a 1,052 edge), which is
    // the false alarm this margin exists to prevent.
    expect(floorDrift(signedAt300, mid, legFloorUnderMidBps(300))).toEqual({ kind: "in-step", driftBps: 1_085 });
    expect(floorDrift(signedAt300, mid, LEG_FLOOR_MARGIN_BPS)).toEqual({ kind: "slack", driftBps: 1_085 });
  });

  it("states the limit over today's price from the margin it was signed at, and says why a fee leg's is wider", () => {
    expect(overTodayPercent(500)).toBe("5.3 %");
    expect(overTodayPercent(700)).toBe("7.5 %");
    expect(INVEST_COPY.legCeiling("SPYx", "$801.80", null, 500)).toBe("SPYx is never bought above $801.80 per 100,000,000 raw units (5.3 % over today's pool price)");
    expect(INVEST_COPY.legCeiling("ANTHROPIC", "$19.95", "3 %", 700)).toBe(
      "ANTHROPIC is never bought above $19.95 per 100,000,000 raw units that reach your vault (7.5 % over today's pool price once a 3 % transfer fee is counted — the highest its issuer has set, in force now or written for a later epoch, so while a lower fee applies a buy may land further over today's price; " +
        "wider than the usual 5.3 % because at that fee each buy asks the market for more room, and the limit has to leave it)",
    );
    // At a 1 % fee the margin is the plain one, and no wider room is claimed.
    expect(INVEST_COPY.legCeiling("ANTHROPIC", "$18.95", "1 %", 500)).not.toMatch(/wider/);
  });

  it("says the date it was signed, or says plainly that nobody knows it", () => {
    // THE POLICY ACCOUNT CARRIES NO TIMESTAMP (solana-program state.rs), so the
    // page cannot date the signature. It says so rather than implying freshness
    // — an invented "signed recently" is exactly the claim the owner would act
    // on.
    expect(INVEST_COPY.floorDriftSigned(null)).toContain("SaverFi cannot tell you which day that was — the policy on Solana does not record one");
    expect(INVEST_COPY.floorDriftSigned(null)).toContain("how far today's prices have moved away from them");
    expect(INVEST_COPY.floorDriftSigned("19 September 2026")).toContain("You signed these limits on 19 September 2026");
  });

  it("tells the owner what a drifted limit still permits, and what a passed one stops", () => {
    const slack = INVEST_COPY.legFloorSlack("ANTHROPIC", "$12.40", "$10.00", "24 %");
    expect(slack).toContain("ANTHROPIC may still be bought at up to $12.40, while the market is at $10.00 — 24 % above today's price");
    expect(slack).toContain("it is no longer stopping much");
    expect(slack).toContain("Sign again to set it from today's prices.");

    const passed = INVEST_COPY.legFloorPassed("SPYx", "$6.10", "$6.40");
    expect(passed).toContain("SPYx is limited to $6.10 and the market has passed it at $6.40");
    // ALL OR NOTHING AGAIN: one passed floor stops the conversion too, so the
    // sentence may not describe it as one leg's problem.
    expect(passed).toContain("nothing is bought, and no SOL is converted toward any of it");

    expect(INVEST_COPY.solFloorSlack("$120.00", "$180.00", "50 %")).toContain("sold for as little as $120.00 per SOL, while it is worth $180.00 — 50 % under today's price");
    expect(INVEST_COPY.solFloorPassed("$180.00", "$120.00")).toContain("no SOL is converted, so nothing is bought, until you sign again");
  });
});
