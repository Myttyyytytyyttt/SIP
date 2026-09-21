// The rule texts' numbers, held to the code that acts on them.
//
// THROUGH A COMMITTED VECTOR, NOT THROUGH THE KEEPER'S TEXT. Each number below
// used to be regexed out of a keeper source file, so reflowing a line in a
// package the web may not edit turned a WEB gate red. The numbers now come from
// test/fixtures/keeper-policy.ts, which the keeper's own tests assert against
// too: a constant that moves fails in the keeper, a sentence that moves fails
// here. The fixture carries each number's MEANING as well as its digits — the
// unit the website prints, a worked example, the two cases either side of the
// keeper's comparison — because two packages can agree on "100" and disagree
// about what it counts. That is the pattern pyth-accounts.ts already uses for
// the mirrored Pyth decoder, and it is the one remedy that does not break the
// boundary packages/solana-keeper/src/pyth.ts states in its own words.
//
// THE readFileSync CALLS THAT REMAIN pin DOCTRINE, never prose: the shape of
// two exported types and two expressions, none of which a rewording can touch.
// They belong on the keeper's side for the same reason the numbers did, and the
// keeper is adding them; they stay here until that lands, because a documented
// duplicate is better than a silent hole.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { OFFERED_LEGS } from "@sip/solana-core/client";

import { LEG_FEE, LOSS_FORGIVEN, POOL_DEPTH } from "../../../solana-core/test/fixtures/keeper-policy";

import { INVEST_COPY, LOSS_DROPPED_AFTER_TXS, MAX_LEG_FEE_BPS, POOL_DEPTH_MULTIPLE, VAULT_COPY } from "@/lib/vault-copy";

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
    // of the pool's reserve, so one buy is at most a fiftieth — 2 % — of it. A
    // copy that printed the multiple as a share would agree about the digits
    // and tell the owner the opposite of the rule.
    expect(100 / POOL_DEPTH_MULTIPLE).toBe(POOL_DEPTH.largestShareOfReservePercent);
    expect(POOL_DEPTH.worked.spend * POOL_DEPTH.keeper.value).toBe(POOL_DEPTH.worked.requiredReserve);

    const notice = INVEST_COPY.thinPool("$1,000.00");
    expect(notice).toContain(`holds at least ${POOL_DEPTH_MULTIPLE} times that buy`);
    // The cap it asks to be lowered is the one the box starts at, said back.
    expect(notice).toContain("Most per buy starts at $1,000.00.");
    // ALL OR NOTHING, which is the keeper's own doctrine: one thin pool refuses
    // the whole basket AND the SOL conversion, so the notice may not offer the
    // reader a half-basket that cannot happen.
    expect(notice).toContain("a buy takes all of the basket or none");
    expect(notice).toContain("nothing bought, no SOL converted, at any balance");
    // THE DOCTRINE, PINNED TO AN EXPORTED TYPE RATHER THAN TO A SENTENCE.
    // This used to grep the runtime refusal "refusing to convert SOL toward
    // it" -- prose, in a package the web may not edit, so the other session
    // reflowing a message turned a WEB gate red with only its owner able to
    // fix it. DepthDecision carries ONE verdict for the whole basket and no
    // per-leg outcome at all, which is the all-or-nothing rule itself: a
    // half-basket is unrepresentable. Rewording cannot break this; adding a
    // per-leg escape hatch is exactly what should.
    const keeper = readFileSync(fileURLToPath(new URL("../../../solana-keeper/src/invest-decision.ts", import.meta.url)), "utf8");
    expect(keeper).toMatch(/export type DepthDecision =\s*\|\s*\{ readonly deep: true \}\s*\|\s*\{ readonly deep: false; readonly outcome: "REFUSED"; readonly detail: string \};/);
  });
});

describe("the transfer-fee ceiling", () => {
  it("says the keeper's own MAX_LEG_FEE_BPS, and warns that the basket is all-or-nothing at it", () => {
    // THE VECTOR, not the keeper's file.
    expect(BigInt(MAX_LEG_FEE_BPS)).toBe(LEG_FEE.keeper.value);
    expect(MAX_LEG_FEE_BPS).toBe(LEG_FEE.web.value);
    // AND THE MEANING, in the unit this page prints: 100 bps is 1 % per
    // transfer, which is the conversion the sentence below performs.
    expect(MAX_LEG_FEE_BPS / 100).toBe(LEG_FEE.percentPerTransfer);
    // STRICTLY GREATER, so a leg sitting exactly on the limit is admitted with
    // no margin -- which is ANTHROPIC's position at 100 bps today. If this gate
    // ever became >=, the copy below would be wrong in the owner's favour. The
    // vector carries both cases and the KEEPER'S tests run them through the
    // real gate; this holds the ceiling the copy names to the admitted one.
    const keeper = readFileSync(fileURLToPath(new URL("../../../solana-keeper/src/invest-decision.ts", import.meta.url)), "utf8");
    expect(LEG_FEE.boundary.admittedAtBps).toBe(LEG_FEE.keeper.value);
    expect(LEG_FEE.boundary.refusedAtBps).toBe(LEG_FEE.keeper.value + 1n);
    // The same all-or-nothing shape on the fee side: one refused leg, one
    // verdict, no per-leg admission.
    expect(keeper).toMatch(/export type LegAdmission =\s*\|\s*\{ readonly admit: true;[^}]*\}\s*\|\s*\{ readonly admit: false; readonly outcome: "REFUSED"; readonly detail: string \};/);

    const notice = INVEST_COPY.feeCeiling("1 %");
    expect(notice).toContain("will not buy a stock that charges more than 1 % to transfer");
    expect(notice).toContain("ANTHROPIC sits exactly on that limit today");
    // ALL OR NOTHING, the same doctrine the thin-pool notice is held to: a fee
    // rise on one leg may not be described as costing the owner only that leg.
    expect(notice).toContain("the whole basket");
    expect(notice).toContain("SPYx along with it");
    expect(notice).toContain("stops converting your SOL at all");
  });
});


describe("the transfer-hook switch", () => {
  /**
   * THE SECOND STOP THE SAME KEY HOLDS. The fee is a number that can rise; this
   * is a field that, once filled in, refuses the leg outright — and by the same
   * all-or-nothing doctrine, the whole basket with it.
   *
   * PINNED TO THE KEEPER'S CODE AND NEVER TO ITS PROSE, the way the depth
   * doctrine is: two expressions, both of which would have to be deleted for
   * the sentence below to become untrue. Rewording the keeper's comments cannot
   * turn this gate red; giving a filled-in hook a way through is exactly what
   * should.
   */
  it("says the keeper refuses a leg whose hook is filled in, and that the refusal takes the whole basket", () => {
    // Read as text, never imported: the web does not depend on the keeper.
    const keeper = readFileSync(fileURLToPath(new URL("../../../solana-keeper/src/invest-decision.ts", import.meta.url)), "utf8");
    // EMPTY MEANS THE DEFAULT PROGRAM ID, which is what "the field is empty
    // today" rests on: anything else is a hook and is refused.
    expect(keeper).toMatch(/transferHook = programId\.equals\(PublicKey\.default\) \? null : programId;/);
    // AND A NON-NULL HOOK IS A REFUSAL, in the same pass that gates the fee.
    expect(keeper).toMatch(/if \(facts\.transferHook !== null\) \{/);

    const notice = INVEST_COPY.hookSwitch;
    expect(notice).toContain("on both it is empty today");
    expect(notice).toContain("SaverFi will not buy a stock whose field has been filled in");
    // ALL OR NOTHING, the doctrine the thin-pool and fee-ceiling notices are
    // held to: a hook on one leg may not be described as costing only that leg.
    expect(notice).toContain("the vault stops buying the whole basket — SPYx along with it — and stops converting your SOL");
    // WHAT HE IS ACTUALLY ACCEPTING, in his own terms.
    expect(notice).toContain("stop your pension buying anything at all");

    // THE STOP SPEAKS FOR ITSELF AND FOR NOTHING ELSE. This paragraph used to
    // end a bare "Nothing you have already saved is lost or moved." — two
    // paragraphs under freezeNotice's permanent delegate and inside the SAME
    // amber box, where alone it reads as a promise that nothing can ever be
    // taken, which that box denies three lines earlier. The qualified form, and
    // the pointer back at the powers that DO reach the holding, are both pinned.
    expect(notice).toContain("That stop takes nothing from you: what you have already saved is neither lost nor moved by it.");
    expect(notice).toContain("The freeze, the pause and the permanent delegate described above are separate powers, and those can reach what your vault already holds.");
    expect(notice).not.toContain("Nothing you have already saved is lost or moved.");

    // THE STOP IS SYMMETRIC; THE FEE IS NOT. The mainnet read recorded in
    // vault-copy.ts gives SPYx its own transfer-hook authority (5aMNNLQJ…), so
    // SPYx's empty field can be filled in by ITS key exactly as ANTHROPIC's can.
    // "a different key holds it" followed by a close on "one stranger's key"
    // left the reader believing the stop belonged to ANTHROPIC alone.
    expect(notice).toContain("either issuer can fill its own field in and stop the whole basket the same way");
    expect(notice).toContain("either stranger's key can stop your pension buying anything at all");
    expect(notice).not.toContain("SPYx carries the same empty field, a different key holds it");
    expect(notice).not.toContain("one stranger's key can stop your pension");
    // AND THE ASYMMETRY THAT IS PROVABLE, which is the fee and not the stop:
    // SPYx's mint carries no TransferFeeConfig and no authority for one, while
    // ANTHROPIC's fee key is the same key that freezes, pauses and moves it.
    expect(notice).toContain("The asymmetry that can be proved is the fee, not the stop");
    expect(notice).toContain("SPYx's mint carries no fee setting at all and no key able to add one");
    expect(notice).toContain("the key that would write the hook in is the same key that sets the fee and can freeze, pause and move the stock");
    // NOT OVERSTATED THE OTHER WAY EITHER: nothing read here measures which of
    // the two keys is likelier to act, so no sentence may weigh them.
    expect(notice).toContain("Nothing here measures which of them is likelier to.");
    expect(notice).not.toMatch(/equally likely|just as likely|as likely to/);
    // The box he ticks names the stop, not only the freeze.
    expect(INVEST_COPY.acknowledge).toContain("the same key can stop my vault buying anything at all");
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
   * 1 - 0.99^2, which is 1.99 % and NOT "2 x 1 %". If someone rounds it back up
   * to "about 2 %", this says so.
   */
  it("gives up the issuer's fee compounded, not doubled, and quotes the measured round trips with their date", () => {
    const structural = (1 - 0.99 ** 2) * 100;
    expect(Number(structural.toFixed(2))).toBe(1.99);
    expect(INVEST_COPY.issuerCost).toContain(`gives up ${structural.toFixed(2)} % before the market is involved at all`);
    expect(INVEST_COPY.issuerCost).toContain("because the second 1 % is taken from what the first one left");
    // A FEE, NOT SLIPPAGE: no sentence may offer a smaller buy as a way out.
    expect(INVEST_COPY.issuerCost).toContain("Buying in smaller pieces does not make it smaller");
    expect(INVEST_COPY.issuerCost).toContain("every later buy pays it again");
    // NO FEE CAN EVER BE PUT ON SPYx: its mint carries no fee setting and no
    // authority for one, which is stronger than "charges nothing today".
    expect(INVEST_COPY.issuerCost).toContain("no fee setting at all, and no key with the power to add one");

    // THE MEASUREMENT, no tighter than it was read, and dated.
    expect(INVEST_COPY.marketCost).toContain("measured on 20 September 2026 on Solana itself");
    expect(INVEST_COPY.marketCost).toContain("each sale priced on what its purchase actually delivered rather than on a quote");
    expect(INVEST_COPY.marketCost).toContain("2.4 % all told, between 2.24 % and 2.63 %");
    expect(INVEST_COPY.marketCost).toContain("between 0.25 % and 0.64 %, is the market");
    expect(INVEST_COPY.marketCost).toContain("moved by 0.36 % within thirteen minutes");
    expect(INVEST_COPY.marketCost).toContain("between 0.011 % and 0.018 %");
    // THE SUPERSEDED READING, which priced the sell off the quote: gone from
    // every sentence, not only from the one it was written in.
    //
    // BANNED IN ITS OWN SHAPE, NOT BY ITS DIGITS. The old claim was ANTHROPIC's
    // WHOLE round trip "between 0.41 % and 0.44 %". A bare ban on "0.41 %" was
    // wrong from the day the closed measurement landed: 2.4 - 1.99 = 0.41 is now
    // the market's own central share, so an editor writing it CORRECTLY would go
    // red for the wrong reason. The upper figure belongs to the dead reading and
    // to nothing else, so it stays banned outright, and the pair is banned in
    // whichever way the two are joined back together.
    for (const line of [INVEST_COPY.issuerCost, INVEST_COPY.marketCost, INVEST_COPY.costTogether]) {
      expect(line).not.toMatch(/0\.41 %\s*(?:and|to|[-–—])\s*0\.44 %/);
      expect(line).not.toContain("0.44 %");
      expect(line).not.toContain("0.01 % on SPYx");
      expect(line).not.toContain("half a percent");
    }
    // And the number that is now right is not banned by accident: the market's
    // share is 2.4 - 1.99, and a sentence saying so must be allowed to.
    expect(Number((2.4 - (1 - 0.99 ** 2) * 100).toFixed(2))).toBe(0.41);
  });
});

describe("the sentences that name the other leg by hand", () => {
  /**
   * WRITTEN OUT, SO TRUE ONLY WHILE THE BASKET IS THESE TWO. hookSwitch and
   * feeCeiling both say "the whole basket — SPYx along with it" to make the
   * all-or-nothing doctrine concrete, and hookSwitch names SPYx four more times
   * for the fee asymmetry. None of that is derived from OFFERED_LEGS, so a
   * third leg, or a swap of either one, would leave the two most dangerous
   * paragraphs on the screen quietly naming a stock the vault no longer buys —
   * and "SPYx along with it" would understate what a stop costs.
   *
   * OFFERED_LEGS is frozen at two today, so the sentences cannot be false yet.
   * This is what fails when that changes, and it fails on the basket rather
   * than on the prose, so the message is "rewrite these" and not "reword this".
   */
  it("fails if the basket is no longer exactly SPYx and ANTHROPIC", () => {
    expect(OFFERED_LEGS.map((leg) => leg.symbol)).toEqual(["SPYx", "ANTHROPIC"]);
    for (const line of [INVEST_COPY.hookSwitch, INVEST_COPY.feeCeiling(`${MAX_LEG_FEE_BPS / 100} %`)]) {
      expect(line).toContain("the whole basket — SPYx along with it");
    }
  });
});
