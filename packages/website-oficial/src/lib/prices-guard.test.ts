// THE PAGE'S COPY OF THE KEEPER'S GUARD IS THE KEEPER'S, OR THIS FAILS.
//
// /prices tells a reader that the live keeper refuses to convert SOL when Pyth
// is more than 60 s old or 500 bps away. Both numbers are the keeper's, and a
// public page that keeps quoting them after they change is worse than a page
// that never quoted them: it is a false claim with a citation on it. So this
// test reads the keeper's own source — the file the page names on screen — and
// holds the copy to it.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { KEEPER_GUARD_SOURCE, KEEPER_ORACLE_GUARD } from "@/lib/prices-guard";

const source = (): string => readFileSync(new URL("../../../solana-keeper/src/invest-decision.ts", import.meta.url), "utf8");

/** `export const NAME = <digits>n;` in the keeper's source, or nothing — a renamed constant must fail loudly, not silently pass. */
function constantIn(text: string, name: string): bigint {
  const found = new RegExp(`export const ${name} = (\\d+)n;`).exec(text);
  expect(found, `${name} is no longer declared as a bigint literal in ${KEEPER_GUARD_SOURCE}`).not.toBeNull();
  return BigInt(found![1]!);
}

describe("the keeper's oracle guard, as /prices states it", () => {
  it("quotes the keeper's own MAX_PYTH_AGE_SECONDS", () => {
    expect(KEEPER_ORACLE_GUARD.maxAgeSeconds).toBe(constantIn(source(), "MAX_PYTH_AGE_SECONDS"));
  });

  it("quotes the keeper's own MAX_PYTH_DEVIATION_BPS", () => {
    expect(KEEPER_ORACLE_GUARD.maxDeviationBps).toBe(constantIn(source(), "MAX_PYTH_DEVIATION_BPS"));
  });

  it("names the function and the tick that apply them, and both still exist", () => {
    const text = source();
    expect(text).toContain(`export function ${KEEPER_ORACLE_GUARD.decision}`);
    expect(readFileSync(new URL("../../../solana-keeper/src/invest-tick.ts", import.meta.url), "utf8")).toContain(KEEPER_ORACLE_GUARD.decision);
  });
});
