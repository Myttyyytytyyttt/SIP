// The rule texts' numbers, held to the code that acts on them.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { LOSS_DROPPED_AFTER_TXS, VAULT_COPY } from "@/lib/vault-copy";

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
