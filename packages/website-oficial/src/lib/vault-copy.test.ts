// The rule texts' numbers, held to the code that acts on them.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { INVEST_COPY, LOSS_DROPPED_AFTER_TXS, MAX_LEG_FEE_BPS, POOL_DEPTH_MULTIPLE, VAULT_COPY } from "@/lib/vault-copy";

describe("the PROFIT rule", () => {
  it("says a loss comes off the next gain only until the trading wallet signs the keeper's own count of transactions, and names that count", () => {
    // Read as text, never imported: the web does not depend on the keeper.
    const keeper = readFileSync(fileURLToPath(new URL("../../../solana-keeper/src/settle-decision.ts", import.meta.url)), "utf8");
    const count = /export const ZERO_BASE_MIN_TXS = ([0-9_]+);/.exec(keeper)?.[1];
    expect(count, "ZERO_BASE_MIN_TXS in packages/solana-keeper/src/settle-decision.ts").toBeDefined();
    expect(Number(count!.replaceAll("_", ""))).toBe(LOSS_DROPPED_AFTER_TXS);

    const rule = VAULT_COPY.profitRule("20 %", "0.06", "0.05");
    expect(rule).toContain(
      `A losing stretch moves nothing, and its loss comes off the next gain. Once your trading wallet has signed ${LOSS_DROPPED_AFTER_TXS} transactions of its own while still behind, that loss is dropped and later gains count in full.`,
    );
    expect(rule).not.toMatch(/its loss comes off the next gain\. One settlement/);
  });
});

describe("the thin-pool notice", () => {
  it("says the keeper's own depth multiple, not a number of its own, and tells the owner to lower the cap it names", () => {
    // Read as text, never imported: the web does not depend on the keeper.
    const keeper = readFileSync(fileURLToPath(new URL("../../../solana-keeper/src/invest-decision.ts", import.meta.url)), "utf8");
    const multiple = /export const MIN_POOL_DEPTH_MULTIPLE = ([0-9_]+)n;/.exec(keeper)?.[1];
    expect(multiple, "MIN_POOL_DEPTH_MULTIPLE in packages/solana-keeper/src/invest-decision.ts").toBeDefined();
    expect(Number(multiple!.replaceAll("_", ""))).toBe(POOL_DEPTH_MULTIPLE);

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
    expect(keeper).toMatch(/export type DepthDecision =\s*\|\s*\{ readonly deep: true \}\s*\|\s*\{ readonly deep: false; readonly outcome: "REFUSED"; readonly detail: string \};/);
  });
});

describe("the transfer-fee ceiling", () => {
  it("says the keeper's own MAX_LEG_FEE_BPS, and warns that the basket is all-or-nothing at it", () => {
    // Read as text, never imported: the web does not depend on the keeper.
    const keeper = readFileSync(fileURLToPath(new URL("../../../solana-keeper/src/invest-decision.ts", import.meta.url)), "utf8");
    const max = /export const MAX_LEG_FEE_BPS = ([0-9_]+)n;/.exec(keeper)?.[1];
    expect(max, "MAX_LEG_FEE_BPS in packages/solana-keeper/src/invest-decision.ts").toBeDefined();
    expect(Number(max!.replaceAll("_", ""))).toBe(MAX_LEG_FEE_BPS);

    // STRICTLY GREATER, so a leg sitting exactly on the limit is admitted with
    // no margin -- which is ANTHROPIC's position at 100 bps today. If this gate
    // ever became >=, the copy below would be wrong in the owner's favour and
    // this assertion is what would say so.
    expect(keeper).toMatch(/fee\.bps\s*>\s*MAX_LEG_FEE_BPS/);
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
