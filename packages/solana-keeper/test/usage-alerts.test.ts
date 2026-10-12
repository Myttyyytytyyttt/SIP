// The four alerts §6.3 hangs on L1a's counters (src/usage-alerts.ts): every
// threshold pinned from /status's own blocks, each rule pure. With its token
// off, bin/keeper.mts never asks one (test/ops-wiring.test.ts).

import { describe, expect, it } from "vitest";
import { PRIVY_FREE_SIGNATURES_PER_MONTH, type PrivyUsageStatus } from "../src/privy-usage.js";
import { JUPITER_KEYLESS_CALLS_PER_MINUTE } from "../src/sweep-cost.js";
import type { JupiterUsageStatus } from "../src/status.js";
import {
  JUPITER_429_QUIET_MS,
  JUPITER_BUDGET_ALERT_KEY,
  JupiterAnswers,
  PRIVY_BURN_ALERT_KEY,
  PRIVY_BURN_MIN_OBSERVED_MS,
  PRIVY_INDEX_ALERT_KEY,
  RPC_FALLBACK_AFTER_MS,
  RPC_FALLBACK_ALERT_KEY,
  jupiterBudgetAlert,
  privyBurnAlert,
  privyIndexAlert,
  rpcFallbackAlert,
} from "../src/usage-alerts.js";

const HOUR = 3_600_000;

function privy(over: Partial<PrivyUsageStatus> = {}): PrivyUsageStatus {
  return {
    observedMs: 2 * HOUR,
    callsPerDay: {},
    failedPerDay: 0,
    http429PerDay: 0,
    callsLastSweep: 0,
    listPagesLastSweep: 0,
    signaturesPerDay: { profit: 3, volume: 9 },
    signThrewPerDay: 0,
    signaturesSinceBoot: {},
    signaturesMonthEstimate: 1_000,
    freeSignaturesPerMonth: PRIVY_FREE_SIGNATURES_PER_MONTH,
    indexMs: 120,
    indexFailures: 0,
    consecutiveIndexFailures: 0,
    fallbackLookups: 0,
    ...over,
  };
}

describe("privy-burn: warn at 60 % of the free tier, page at 85 %", () => {
  const at = (estimate: number) => privyBurnAlert(privy({ signaturesMonthEstimate: estimate }));

  it("clears below 60 %", () => {
    expect(at(PRIVY_FREE_SIGNATURES_PER_MONTH * 0.6 - 1)).toEqual({ fire: null, clear: true });
  });

  it("warns from 60 % and pages from 85 %, on one key", () => {
    expect(at(PRIVY_FREE_SIGNATURES_PER_MONTH * 0.6).fire).toMatchObject({ key: PRIVY_BURN_ALERT_KEY, severity: "warn" });
    expect(at(PRIVY_FREE_SIGNATURES_PER_MONTH * 0.85 - 1).fire?.severity).toBe("warn");
    expect(at(PRIVY_FREE_SIGNATURES_PER_MONTH * 0.85).fire).toMatchObject({ key: PRIVY_BURN_ALERT_KEY, severity: "critical" });
  });

  it("says it is this service's share of one app's tier, and the modes behind it", () => {
    const detail = at(45_000).fire!.detail;
    expect(detail).toContain("this service's own count");
    expect(detail).toContain("profit 3, volume 9");
    expect(detail).toContain("90 %");
  });

  it("says nothing before an hour is observed, or before there is an estimate at all", () => {
    expect(privyBurnAlert(privy({ signaturesMonthEstimate: 49_000, observedMs: PRIVY_BURN_MIN_OBSERVED_MS - 1 }))).toEqual({ fire: null, clear: false });
    expect(privyBurnAlert(privy({ signaturesMonthEstimate: null }))).toEqual({ fire: null, clear: false });
  });
});

describe("privy-index: warn on the first failed listing, page on the third in a row", () => {
  it("follows the streak, and clears when a listing is built", () => {
    expect(privyIndexAlert(privy({ consecutiveIndexFailures: 0 }))).toEqual({ fire: null, clear: true });
    expect(privyIndexAlert(privy({ consecutiveIndexFailures: 1 })).fire).toMatchObject({ key: PRIVY_INDEX_ALERT_KEY, severity: "warn" });
    expect(privyIndexAlert(privy({ consecutiveIndexFailures: 2 })).fire?.severity).toBe("warn");
    expect(privyIndexAlert(privy({ consecutiveIndexFailures: 3, indexFailures: 7, fallbackLookups: 40 })).fire).toMatchObject({
      severity: "critical",
      detail: expect.stringContaining("(40 so far)"),
    });
  });
});

describe("rpc-fallback: pages once a fallback endpoint has answered alone for 10 minutes", () => {
  it("clears when endpoint 1 answers, waits under the bound, pages past it — by label only", () => {
    expect(rpcFallbackAlert({ endpointInUse: "endpoint 1/2", endpointSinceMs: 3 * HOUR, endpoints: 2 })).toEqual({ fire: null, clear: true });
    expect(rpcFallbackAlert({ endpointInUse: "endpoint 2/2", endpointSinceMs: RPC_FALLBACK_AFTER_MS - 1, endpoints: 2 })).toEqual({
      fire: null,
      clear: false,
    });
    const page = rpcFallbackAlert({ endpointInUse: "endpoint 3/3", endpointSinceMs: RPC_FALLBACK_AFTER_MS, endpoints: 3 }).fire!;
    expect(page).toMatchObject({ key: RPC_FALLBACK_ALERT_KEY, severity: "critical" });
    expect(page.detail).toContain("endpoint 3/3 has answered alone for 10 min; endpoint 1/3 keeps being set aside");
    expect(page.detail).not.toMatch(/https?:\/\//);
  });

  it("has nothing to say with one endpoint, or before any has answered", () => {
    expect(rpcFallbackAlert({ endpointInUse: "endpoint 1/1", endpointSinceMs: 3 * HOUR, endpoints: 1 })).toEqual({ fire: null, clear: false });
    expect(rpcFallbackAlert({ endpointInUse: null, endpointSinceMs: null, endpoints: 2 })).toEqual({ fire: null, clear: false });
  });
});

describe("jupiter-budget: warn at 80 % of the per-minute limit, page on a 429 while live", () => {
  const usage = (callsLastMinute: number, budgetPerMinute = JUPITER_KEYLESS_CALLS_PER_MINUTE): JupiterUsageStatus => ({
    callsLastMinute,
    peakPerMinuteLastDay: callsLastMinute,
    budgetPerMinute,
    peakPctOfBudget: 0,
    callsPerDay: 0,
    observedMs: HOUR,
    callsSinceBoot: 0,
  });
  const NOW = 1_700_000_000_000;

  it("pages on a 429 during a live sweep, and only warns for a dry run's quote", () => {
    expect(jupiterBudgetAlert({ usage: usage(12), http429ThisSweep: 1, lastHttp429At: NOW, live: true, now: NOW }).fire).toMatchObject({
      key: JUPITER_BUDGET_ALERT_KEY,
      severity: "critical",
    });
    expect(jupiterBudgetAlert({ usage: usage(12), http429ThisSweep: 2, lastHttp429At: NOW, live: false, now: NOW }).fire?.severity).toBe("warn");
  });

  it("warns at 80 % of the counter's own limit — the keyless 30 today, a key's tomorrow", () => {
    expect(jupiterBudgetAlert({ usage: usage(24), http429ThisSweep: 0, lastHttp429At: null, live: true, now: NOW }).fire?.severity).toBe("warn");
    expect(jupiterBudgetAlert({ usage: usage(23), http429ThisSweep: 0, lastHttp429At: null, live: true, now: NOW })).toEqual({ fire: null, clear: true });
    expect(jupiterBudgetAlert({ usage: usage(47, 60), http429ThisSweep: 0, lastHttp429At: null, live: true, now: NOW })).toEqual({ fire: null, clear: true });
    expect(jupiterBudgetAlert({ usage: usage(48, 60), http429ThisSweep: 0, lastHttp429At: null, live: true, now: NOW }).fire?.severity).toBe("warn");
  });

  it("does not clear for half an hour after a 429, so a throttling episode pages once", () => {
    const quiet = { usage: usage(3), http429ThisSweep: 0, live: true };
    expect(jupiterBudgetAlert({ ...quiet, lastHttp429At: NOW - 60_000, now: NOW })).toEqual({ fire: null, clear: false });
    expect(jupiterBudgetAlert({ ...quiet, lastHttp429At: NOW - JUPITER_429_QUIET_MS, now: NOW })).toEqual({ fire: null, clear: true });
  });
});

describe("JupiterAnswers", () => {
  it("counts by kind since boot and 429s by sweep", () => {
    const answers = new JupiterAnswers();
    answers.startSweep();
    for (const answer of [200, 429, 429, 502, "unanswered", 400] as const) answers.record(answer, 1_000);
    expect(answers.http429ThisSweep()).toBe(2);
    expect(answers.status()).toEqual({ answered: 1, http429: 2, httpOther: 2, unanswered: 1, lastHttp429At: new Date(1_000).toISOString() });
    answers.startSweep();
    expect(answers.http429ThisSweep()).toBe(0);
    expect(answers.status().http429).toBe(2);
  });
});
