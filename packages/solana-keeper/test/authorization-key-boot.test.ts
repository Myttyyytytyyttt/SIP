// The keeper's own check of its authorization key: that it is established before
// any money is at stake, RE-established afterwards, stamped with the moment it
// was taken, and that an unknown which persists stops being silent.
//
// WHY THE SOURCE IS READ RATHER THAN THE BEHAVIOUR EXERCISED — the same reason
// test/wallet-turn-catch.test.ts gives. establishAuthorizationKey is a closure
// inside a top-level script that connects to a chain, a database and Privy
// before it defines one; there is no seam to drive it through. What regressed
// here is structural and reads back from the text exactly: the check ran once
// and never again, carried no timestamp, and returned before alerting whenever
// Privy could not be reached — so a boot that missed Privy left /status claiming
// "quorum-unreadable" for the life of the process with nothing retrying, which
// is the protection this check exists to give, silently absent. The verdicts
// themselves are exercised properly in test/privy-authorization-key.test.ts and
// end to end against the fake Privy in test/privy-policy-cli.test.ts.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const keeper = readFileSync(fileURLToPath(new URL("../bin/keeper.mts", import.meta.url)), "utf8");

/** The body of one top-level `async function <name>()`, to its closing brace at column 0. */
function body(name: string): string {
  const start = keeper.indexOf(`async function ${name}(`);
  expect(start, `${name} was not found`).toBeGreaterThan(-1);
  const end = keeper.indexOf("\n}\n", start);
  expect(end).toBeGreaterThan(start);
  return keeper.slice(start, end);
}

describe("the boot check of the authorization key", () => {
  // A DRY RUN READS NO SIGNING SECRET, and that promise is older than this check.
  it("performs nothing at all without a Privy config or a signer id", () => {
    expect(body("establishAuthorizationKey")).toContain("if (privyConfig === null || signerId === null) return;");
    // And the re-check reaches Privy only through that same function, so it
    // cannot grow a path around the guard.
    const again = body("reestablishAuthorizationKey");
    expect(again).toContain("await establishAuthorizationKey()");
    expect(again).not.toContain("authorizationKeyVerdict");
    expect(again).not.toContain("reveal()");
  });

  // A VERDICT WITHOUT A DATE IS A CLAIM ABOUT AN UNKNOWN MOMENT. Assigned in one
  // statement so the two cannot drift: /status must never show a fresh verdict
  // next to a stale stamp, or a stale verdict with no stamp at all.
  it("stamps the verdict with the moment it was taken, in the same assignment", () => {
    expect(body("establishAuthorizationKey")).toMatch(
      /health\.signing = \{ \.\.\.health\.signing, authorizationKey: verdict\.check, authorizationKeyAt: new Date\(\)\.toISOString\(\) \};/,
    );
  });

  // ONCE AT BOOT WAS NOT ENOUGH: a key removed from the quorum, or a boot that
  // could not reach Privy, left /status saying so until the next deploy.
  it("runs again on a slow cadence, from the sweep", () => {
    expect(keeper).toMatch(/const AUTHORIZATION_KEY_EVERY_SWEEPS = \d+;/);
    expect(body("reestablishAuthorizationKey")).toContain("health.sweeps % AUTHORIZATION_KEY_EVERY_SWEEPS !== 0");
    // Called from the sweep, after the sweep counter has advanced.
    const call = keeper.indexOf("await reestablishAuthorizationKey();");
    const counted = keeper.indexOf("health.sweeps += 1;");
    expect([call, counted].every((index) => index > -1)).toBe(true);
    expect(call).toBeGreaterThan(counted);
    // A CHECK THAT CANNOT RUN MUST NOT END A SWEEP THAT IS MOVING MONEY.
    expect(body("reestablishAuthorizationKey")).toContain("} catch (error) {");
  });

  // UNKNOWN IS NOT WRONG, so the first dropped connection pages nobody — but an
  // unknown that persists means the protection has been off for hours, and the
  // old code returned before alerter.fire() every single time.
  it("alerts once an unreadable quorum has persisted, instead of returning forever", () => {
    const text = body("establishAuthorizationKey");
    expect(keeper).toMatch(/const AUTHORIZATION_KEY_UNREADABLE_STREAK = \d+;/);
    expect(text).toContain('authorizationKeyUnreadable = verdict.check === "quorum-unreadable" ? authorizationKeyUnreadable + 1 : 0;');
    expect(text).toContain('if (verdict.check === "quorum-unreadable" && authorizationKeyUnreadable < AUTHORIZATION_KEY_UNREADABLE_STREAK) return;');
    // The early return is the ONLY one between the verdict and the fire.
    const fire = text.indexOf("alerter.fire({");
    expect(fire).toBeGreaterThan(-1);
    const guard = text.indexOf('if (verdict.check === "quorum-unreadable" &&');
    expect(text.slice(guard, fire).match(/\breturn;/g)).toHaveLength(1);
  });

  // THE ALERTER DEDUPES BY KEY ALONE. Re-checking on a cadence makes that a
  // hazard it never was at boot: a warn raised half an hour ago would swallow
  // the critical that replaces it, which is the one transition an operator needs.
  it("clears the standing alert when the verdict changes, so an escalation is not deduped away", () => {
    const text = body("establishAuthorizationKey");
    expect(text).toContain("const changed = lastAuthorizationKeyCheck !== verdict.check;");
    expect(text).toContain("if (changed && lastAuthorizationKeyCheck !== null) alerter.clear(AUTHORIZATION_KEY_ALERT_KEY);");
    // And a healthy pairing is not restated every half hour forever.
    expect(text).toContain('if (changed) log.info("privy authorization key belongs to the signer quorum", context);');
  });
});
