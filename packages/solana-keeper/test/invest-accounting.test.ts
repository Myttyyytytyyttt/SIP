// EVERY CONFIRMED LEG IS RECORDED, INCLUDING THE ONES A LATER REFUSAL FOLLOWS.
//
// bin/keeper.mts states the contract in the imperative: "EVERY confirmed leg is
// recorded — including the ones that confirmed before a later leg broke the
// basket, because those moved real money". It is the only writer: it iterates
// `invest.purchases ?? []` and calls readModel.recordInvestment. A return that
// leaves the field off is therefore not a delayed record, it is no record —
// the vault's history and the dashboard show a turn that bought nothing while
// the chain shows a completed buy.
//
// WHY THIS IS A SOURCE CHECK AND NOT A BEHAVIOURAL ONE. investTurn needs a
// chain, an Anchor program, a funded crank and a live Jupiter to reach the
// return in question; nothing in this package can drive it, which is exactly
// how the mid-loop REFUSED came to be added without the field while the suite
// stayed green and InvestResult.purchases is optional so tsc said nothing. The
// property is structural — "this exit carries the money that already moved" —
// so it is checked structurally, in the same spirit as
// test/dockerfile-copies.test.ts. A guard with no red case is not a guard
// (docs/TESTING_TRAPS.md): delete `purchases` from either exit below and this
// goes red naming it.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), "../src/invest-tick.ts");

/** The whole `return { ... }` expression an offset sits inside, by brace balance. */
function enclosingReturn(text: string, at: number): string {
  const open = text.lastIndexOf("return {", at);
  expect(open, "an outcome literal that is not part of a return statement").toBeGreaterThan(-1);
  let depth = 0;
  for (let index = open + "return ".length; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    else if (text[index] === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(open, index + 1);
    }
  }
  throw new Error("unbalanced return literal");
}

describe("the invest turn's accounting of legs that already confirmed", () => {
  it("carries `purchases` on EVERY exit reachable after the first leg can have been bought", () => {
    const text = readFileSync(SOURCE, "utf8");
    // The declaration is the line after which money can have moved: every
    // buy pushes into it, and every exit below it may be carrying some.
    const from = text.indexOf("const purchases: InvestPurchase[] = [];");
    expect(from, "invest-tick.ts declares the turn's purchases").toBeGreaterThan(-1);

    const exits: { readonly outcome: string; readonly literal: string }[] = [];
    for (const outcome of ['outcome: "REFUSED"', 'outcome: "FAILED"']) {
      let at = text.indexOf(outcome, from);
      while (at !== -1) {
        exits.push({ outcome, literal: enclosingReturn(text, at) });
        at = text.indexOf(outcome, at + 1);
      }
    }
    // NOT VACUOUS: there are two such exits today — the mid-loop depth/slippage
    // refusal and the catch. A scan that found none would pass silently.
    expect(exits.length, "the leg loop's refusal and the turn's catch").toBeGreaterThanOrEqual(2);
    const dropped = exits.filter((exit) => !exit.literal.includes("purchases")).map((exit) => exit.outcome);
    expect(dropped, "an exit below the first buy that does not carry what was bought loses it for good").toEqual([]);
  });

  it("does not demand the field of the refusals that sit ABOVE the wrap, where nothing has moved", () => {
    // The doctrine is that the owner's SOL is never sold toward a basket that
    // cannot be bought, so the gate's own refusals come before any purchase
    // exists. Requiring the field there would be cargo cult, and would make
    // this test pass for the wrong reason if the mid-loop exit were deleted.
    const text = readFileSync(SOURCE, "utf8");
    const from = text.indexOf("const purchases: InvestPurchase[] = [];");
    const above = text.slice(0, from);
    expect(above).toContain('outcome: "REFUSED"');
    expect(above.slice(above.lastIndexOf("return {")), "the pre-wrap depth refusal carries no purchases").not.toContain("purchases");
  });
});
