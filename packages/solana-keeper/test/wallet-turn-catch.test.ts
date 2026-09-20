// The per-wallet catch in bin/keeper.mts: that it escalates, and that a wallet
// whose turn threw is still counted on /status.
//
// WHY THE SOURCE IS READ RATHER THAN THE BEHAVIOUR EXERCISED. The sweep is a
// closure inside a top-level script that connects to a chain, a database and
// Privy before it defines one; there is no seam to drive a single wallet turn
// through. What regressed here is structural and reads back from the text
// exactly: the ladder was applied only on the path that RETURNS, and the
// signing route was recorded only at the end of a turn. Both were invisible for
// as long as they existed, and both would go quiet again the same way — so the
// arrangement itself is what is pinned, next to the rules the ladder is made of,
// which test/settle-decision.test.ts exercises properly.
//
// 2026-09-18: ~2900 sweeps escalated nothing while the keeper settled nobody.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const keeper = readFileSync(fileURLToPath(new URL("../bin/keeper.mts", import.meta.url)), "utf8");

/** The body of the per-wallet catch: from its `} catch (error) {` to the end of the link loop. */
function walletTurnCatch(): string {
  const marker = keeper.indexOf('log.error("wallet turn threw"');
  expect(marker, "the per-wallet catch was not found").toBeGreaterThan(-1);
  const start = keeper.lastIndexOf("} catch (error) {", marker);
  const end = keeper.indexOf("\n      }\n", marker);
  expect([start, end].every((index) => index > -1)).toBe(true);
  return keeper.slice(start, end);
}

describe("a wallet turn that throws", () => {
  // THE WHOLE POINT. settleAlert and the invest streaks are applied from inside
  // the try, so an exception reached neither: the catch wrote a status row, logged
  // one line, and paged nobody.
  it("escalates both halves instead of only logging", () => {
    const body = walletTurnCatch();
    expect(body).toContain("settleThrewAlert");
    expect(body).toContain("alerter.fire");
    expect(body).toContain("alerter.clear");
    // The invest half rejoins the existing per-vault streak rather than inventing one.
    expect(body).toContain("foldInvestTurn");
    expect(body).toMatch(/outcome:\s*"FAILED"/);
  });

  // ONE TRY WRAPS BOTH HALVES. Without a phase marker the catch cannot tell a
  // settle that threw from an invest that threw, and would page the wrong money
  // path — and clear the other one's alerts while doing it.
  it("knows which half it was in", () => {
    expect(keeper).toMatch(/let phase: "settle" \| "invest" = "settle";/);
    expect(keeper).toMatch(/phase = "invest";/);
    expect(walletTurnCatch()).toMatch(/phase === "settle"/);
  });

  // A THROWN TURN USED TO VANISH FROM THE SIGNING SUMMARY. signingRoutes was
  // populated on the last line of the try, so /status reported
  // signing {signable: 0, of: 0} during exactly the incidents it is opened for.
  it("is counted in the signing summary, because the route is recorded before anything is sent", () => {
    const set = keeper.indexOf("signingRoutes.set(wallet, route);");
    const settle = keeper.indexOf("await runSettleTick(");
    const invest = keeper.indexOf("await runInvestTick(");
    expect(set).toBeGreaterThan(-1);
    expect(set).toBeLessThan(settle);
    expect(set).toBeLessThan(invest);
    // And a throw from before even that point still leaves the wallet counted.
    expect(walletTurnCatch()).toContain("signingRoutes.has(wallet)");
  });
});
