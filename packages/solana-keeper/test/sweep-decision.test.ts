// The sweep's own decisions, pinned where bin/keeper.mts cannot be reached: what
// a failed batched vault read raises, and when it stops being weather.

import { describe, expect, it } from "vitest";
import { INVEST_FAILED_CRITICAL_STREAK, investFailedStreak, wrapShortStreak, type WrapReport } from "../src/invest-decision.js";
import type { InvestOutcome } from "../src/invest-tick.js";
import {
  VAULT_READ_ALERT_KEY,
  VAULT_READ_CRITICAL_STREAK,
  foldInvestTurn,
  vaultReadAlert,
  type VaultInvestSweep,
} from "../src/sweep-decision.js";

describe("the batched vault read's alert", () => {
  it("warns while it could be weather and pages critical from the third sweep in a row", () => {
    expect(vaultReadAlert(1, "429 Too Many Requests")).toMatchObject({ key: VAULT_READ_ALERT_KEY, severity: "warn" });
    expect(vaultReadAlert(VAULT_READ_CRITICAL_STREAK - 1, "429 Too Many Requests").severity).toBe("warn");
    expect(vaultReadAlert(VAULT_READ_CRITICAL_STREAK, "429 Too Many Requests").severity).toBe("critical");
    expect(vaultReadAlert(9, "429 Too Many Requests").severity).toBe("critical");
  });

  it("raises the escalation under the SAME key, so the keeper can clear the standing warning first", () => {
    // The alerter dedupes by key alone with a 30-minute repeat window, so a
    // critical under a new key would be a second condition and one under this
    // key, left standing, would be swallowed. keeper.mts clears it at the streak.
    expect(vaultReadAlert(1, "x").key).toBe(vaultReadAlert(VAULT_READ_CRITICAL_STREAK, "x").key);
  });

  it("names no vault and no wallet: the batch is one request for every link", () => {
    expect(VAULT_READ_ALERT_KEY).not.toContain(":");
  });

  it("counts the sweeps and carries the upstream summary it was given", () => {
    expect(vaultReadAlert(1, "429 Too Many Requests").detail).toBe("1 sweep in a row: 429 Too Many Requests");
    expect(vaultReadAlert(3, "429 Too Many Requests").detail).toBe("3 sweeps in a row: 429 Too Many Requests");
    expect(vaultReadAlert(3, "429 Too Many Requests").context).toEqual({ sweeps: 3 });
  });
});

describe("a vault's invest turns folded across one sweep", () => {
  type Turn = { readonly outcome: InvestOutcome; readonly detail: string; readonly wrap?: WrapReport };
  const wrap = (short: boolean): WrapReport => ({
    free: 9_000_000n,
    allowance: short ? 1_000_000n : 9_000_000n,
    wrapped: short ? 1_000_000n : 9_000_000n,
    short,
  });
  /** Three links on one vault settle in one sweep: three turns, one fold. */
  const fold = (...turns: readonly Turn[]): VaultInvestSweep =>
    turns.reduce<VaultInvestSweep | undefined>((carry, turn) => foldInvestTurn(carry, turn), undefined)!;

  it("advances a vault's failed streak ONCE for the sweep, however many wallets are linked to it", () => {
    const folded = fold({ outcome: "FAILED", detail: "leg 1" }, { outcome: "FAILED", detail: "leg 1" }, { outcome: "FAILED", detail: "leg 1" });
    expect(investFailedStreak(0, folded.outcome)).toBe(1);
    expect(investFailedStreak(1, folded.outcome)).toBe(2);
    // THE DEFECT, in one line: counted per turn, the same three links reached the
    // critical streak — "three sweeps in a row" — inside a single sweep.
    const perTurn = (["FAILED", "FAILED", "FAILED"] as const).reduce((streak, outcome) => investFailedStreak(streak, outcome), 0);
    expect(perTurn).toBe(INVEST_FAILED_CRITICAL_STREAK);
  });

  it("lets one FAILED turn decide the sweep, and keeps the first failure's words", () => {
    expect(fold({ outcome: "INVESTED", detail: "bought" }, { outcome: "FAILED", detail: "leg 2 broke" }, { outcome: "IDLE", detail: "nothing" })).toMatchObject({
      outcome: "FAILED",
      detail: "leg 2 broke",
    });
    expect(fold({ outcome: "FAILED", detail: "first" }, { outcome: "FAILED", detail: "second" }).detail).toBe("first");
  });

  it("holds the streak on REFUSED only while nothing else happened, in either order", () => {
    // REFUSED neither advances the run nor ends it: it has its own alert.
    expect(investFailedStreak(2, fold({ outcome: "REFUSED", detail: "a" }, { outcome: "REFUSED", detail: "b" }).outcome)).toBe(2);
    // A resting turn in the same sweep ends it, and must not be masked by a REFUSED sibling.
    expect(investFailedStreak(2, fold({ outcome: "REFUSED", detail: "a" }, { outcome: "IDLE", detail: "b" }).outcome)).toBe(0);
    expect(investFailedStreak(2, fold({ outcome: "IDLE", detail: "b" }, { outcome: "REFUSED", detail: "a" }).outcome)).toBe(0);
    expect(investFailedStreak(2, fold({ outcome: "REFUSED", detail: "a" }, { outcome: "INVESTED", detail: "b" }).outcome)).toBe(0);
  });

  it("keeps a short turn's wrap report whatever the later turns saw, and the latest one when none was short", () => {
    expect(fold({ outcome: "INVESTED", detail: "a", wrap: wrap(true) }, { outcome: "INVESTED", detail: "b", wrap: wrap(false) }).wrap?.short).toBe(true);
    expect(fold({ outcome: "INVESTED", detail: "a", wrap: wrap(false) }, { outcome: "INVESTED", detail: "b", wrap: wrap(true) }).wrap?.short).toBe(true);
    // A turn that read no wrap at all does not blank out one that did.
    expect(fold({ outcome: "INVESTED", detail: "a", wrap: wrap(false) }, { outcome: "IDLE", detail: "b" }).wrap?.short).toBe(false);
    expect(fold({ outcome: "IDLE", detail: "a" }, { outcome: "IDLE", detail: "b" }).wrap).toBeUndefined();
  });

  it("advances the wrap-short streak once per sweep too", () => {
    const short = { outcome: "INVESTED", detail: "wrapped a slice", wrap: wrap(true) } as const;
    expect(wrapShortStreak(0, fold(short, short, short).wrap?.short === true)).toBe(1);
    expect(wrapShortStreak(2, fold(short, { outcome: "IDLE", detail: "nothing to wrap", wrap: wrap(false) }).wrap?.short === true)).toBe(3);
  });
});
