// The sweep's own decisions, pinned where bin/keeper.mts cannot be reached: what
// a failed batched vault read raises, and when it stops being weather.

import { describe, expect, it } from "vitest";
import { VAULT_READ_ALERT_KEY, VAULT_READ_CRITICAL_STREAK, vaultReadAlert } from "../src/sweep-decision.js";

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
