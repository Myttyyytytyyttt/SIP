// The ceiling the bench publishes, and the three terms the first one left out.
//
// WHY THIS FILE EXISTS. c6e38d8 published "about 99 links at the public
// endpoint's shape" (and ~266, ~698 at faster ones) from one straight line
// through four dry sweeps. A review found it flattered production three ways:
// the line mixed fleets with different hot shares, a hot user was priced on its
// reads alone, and a provider's rate limit — which is a REFUSAL, not a
// slowdown — was not modelled at all. Each test below pins one of those terms,
// and each goes red when its term is taken out of src/bench/ceiling.ts,
// src/bench/grid.ts or src/bench/rate-gate.ts.

import { Secret } from "@sip/solana-log";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  backlogFill,
  fleetCeiling,
  jupiterBuyerCeiling,
  laneCosts,
  roundTripMs,
  settleWriteFloor,
  type LaneCosts,
  type LaneRow,
} from "../src/bench/ceiling.js";
import { ceilingLinks, fitSweepCost, rowVerdict } from "../src/bench/grid.js";
import { createRateGate } from "../src/bench/rate-gate.js";
import { MAX_SIGNATURES } from "../src/measure-window.js";
import { poolFetch } from "../src/rpc-pool.js";
import { CONFIRM_POLL_MS, CONFIRM_TIMEOUT_MS } from "../src/settle-tick.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * A fleet whose truth is known: 400 ms fixed, 600 ms per idle user over 6 calls,
 * 2 400 ms per hot user over 26, and 8 fixed calls (the boot read among them).
 * The rows are the default grid's shape at 2 % hot: 1, 10, 50, 100 links with
 * 0, 0, 1, 2 hot users.
 */
const TRUTH = { fixedMs: 400, idleMs: 600, hotMs: 2_400, fixedCalls: 8, idleCalls: 6, hotCalls: 26 };
const row = (links: number, hot: number): LaneRow => ({
  links,
  hot,
  triageMs: (links - hot) * TRUTH.idleMs,
  expensiveMs: hot * TRUTH.hotMs,
  sweepMs: TRUTH.fixedMs + (links - hot) * TRUTH.idleMs + hot * TRUTH.hotMs,
  rpcCalls: TRUTH.fixedCalls + (links - hot) * TRUTH.idleCalls + hot * TRUTH.hotCalls,
});
const DEFAULT_GRID_AT_2_PERCENT = [row(1, 0), row(10, 0), row(50, 1), row(100, 2)];

const known: LaneCosts = {
  fixedMs: 400,
  idleMs: 600,
  hotReadMs: 2_400,
  fixedCalls: 8,
  idleCalls: 6,
  hotCalls: 26,
  roundTripMs: 100,
  hotTxCount: 12,
  rows: 4,
};

describe("the price of a user, read off the keeper's own lanes", () => {
  it("prices idle and hot users separately, where a line through the totals mixes fleets with different hot shares", () => {
    const costs = laneCosts(DEFAULT_GRID_AT_2_PERCENT, 12);
    expect(costs).not.toBeNull();
    expect(costs!.fixedMs).toBeCloseTo(TRUTH.fixedMs, 6);
    expect(costs!.idleMs).toBeCloseTo(TRUTH.idleMs, 6);
    expect(costs!.hotReadMs).toBeCloseTo(TRUTH.hotMs, 6);
    expect(costs!.fixedCalls).toBeCloseTo(TRUTH.fixedCalls, 6);
    expect(costs!.idleCalls).toBeCloseTo(TRUTH.idleCalls, 6);
    expect(costs!.hotCalls).toBeCloseTo(TRUTH.hotCalls, 6);
    // c6e38d8's method on the same rows: one slope through fleets that were 0 %,
    // 0 %, 2 % and 2 % hot. It is neither the idle price nor any fleet's price.
    const line = fitSweepCost(DEFAULT_GRID_AT_2_PERCENT.map(({ links, sweepMs }) => ({ links, sweepMs })));
    expect(line!.perLinkMs).not.toBeCloseTo(TRUTH.idleMs, 0);
    expect(line!.perLinkMs).not.toBeCloseTo(0.98 * TRUTH.idleMs + 0.02 * TRUTH.hotMs, 0);
  });

  it("states no hot price at all when no row had a hot user, rather than inventing one", () => {
    const costs = laneCosts([row(1, 0), row(10, 0)], 12);
    expect(costs!.hotReadMs).toBeNull();
    expect(costs!.hotCalls).toBeNull();
    expect(costs!.idleCalls).toBeCloseTo(6, 6);
    expect(fleetCeiling({ costs: costs!, windowMs: 60_000, hotShare: 0.02, writeMs: 0, writeCalls: 0, planRps: null }).binding).toBe("unmeasured");
    expect(laneCosts([], 12)).toBeNull();
  });

  it("reads one round trip as every per-user millisecond over every per-user call, the boot read left out", () => {
    const costs = laneCosts(DEFAULT_GRID_AT_2_PERCENT, 12)!;
    const userMs = DEFAULT_GRID_AT_2_PERCENT.reduce((sum, r) => sum + r.triageMs + r.expensiveMs, 0);
    const userCalls = DEFAULT_GRID_AT_2_PERCENT.reduce((sum, r) => sum + r.rpcCalls - TRUTH.fixedCalls, 0);
    expect(roundTripMs(costs)).toBeCloseTo(userMs / userCalls, 6);
  });

  it("still prices both lanes and the round trip when every row shares one hot share, and leaves the call split unstated", () => {
    // 20 % hot at 10 and 50 links: hot is a multiple of idle, so the calls
    // cannot be split between the lanes — but the milliseconds can, and the
    // round trip needs only the fixed calls.
    const costs = laneCosts([row(10, 2), row(50, 10)], 12)!;
    expect(costs.idleMs).toBeCloseTo(TRUTH.idleMs, 6);
    expect(costs.hotReadMs).toBeCloseTo(TRUTH.hotMs, 6);
    expect(costs.fixedCalls).toBeCloseTo(TRUTH.fixedCalls, 6);
    expect(costs.idleCalls).toBeNull();
    expect(costs.hotCalls).toBeNull();
    expect(costs.roundTripMs).toBeCloseTo((0.8 * 600 + 0.2 * 2_400) / (0.8 * 6 + 0.2 * 26), 6);
  });
});

describe("a hot user's write path, charged at the least settle-tick.ts lets it cost", () => {
  it("is never cheaper than one CONFIRM_POLL_MS wait plus two status checks and a receipt read", () => {
    const floor = settleWriteFloor(100);
    expect(floor.ms).toBe(CONFIRM_POLL_MS + 3 * 100);
    expect(floor.calls).toBe(3);
    // Privy's round trip only when it is passed: it was never measured.
    expect(settleWriteFloor(100, 250).ms).toBe(250 + CONFIRM_POLL_MS + 300);
  });

  it("says a settle that never confirms costs the whole CONFIRM_TIMEOUT_MS on its own", () => {
    expect(settleWriteFloor(100).stuckMs).toBeGreaterThanOrEqual(CONFIRM_TIMEOUT_MS);
    expect(() => settleWriteFloor(-1)).toThrow(/round trip/);
  });

  it("pulls the ceiling below the reads-only one c6e38d8 published, because every hot user pays it", () => {
    const floor = settleWriteFloor(roundTripMs(known)!);
    const readsOnly = fleetCeiling({ costs: known, windowMs: 60_000, hotShare: 0.2, writeMs: 0, writeCalls: 0, planRps: null });
    const withWrites = fleetCeiling({ costs: known, windowMs: 60_000, hotShare: 0.2, writeMs: floor.ms, writeCalls: floor.calls, planRps: null });
    // 0.8 x 600 + 0.2 x 2 400 = 960 ms a user, reads only: (60 000 - 400) / 960 = 62.08 -> 63.
    expect(readsOnly.links).toBe(63);
    // + 0.2 x 800 ms of write floor = 1 120 ms a user: 53.2 -> 54.
    expect(withWrites.links).toBe(54);
  });
});

describe("the ceiling as a function of the hot share", () => {
  const at = (hotShare: number) => fleetCeiling({ costs: known, windowMs: 60_000, hotShare, writeMs: 800, writeCalls: 3, planRps: null });

  it("fits fewer users as more of them are hot — the headline is a curve, not a number", () => {
    // 0 %: 600 ms a user -> (60 000 - 400) / 600 = 99.3 -> 100.
    expect(at(0).links).toBe(100);
    // 2 %: 0.98 x 600 + 0.02 x 3 200 = 652 ms -> 91.4 -> 92.
    expect(at(0.02).links).toBe(92);
    // 20 %: 1 120 ms -> 54. After an outage nobody is idle.
    expect(at(0.2).links).toBe(54);
    expect(at(0.5).links!).toBeLessThan(at(0.2).links!);
  });

  it("caps BUYING users at Jupiter's keyless budget whatever the sweep does", () => {
    // 30 requests a minute over about 12 a buying turn: 2.5 buyers a window.
    expect(jupiterBuyerCeiling(0.02, 60_000)).toBe(126);
    expect(jupiterBuyerCeiling(0.2, 60_000)).toBe(13);
    expect(jupiterBuyerCeiling(0, 60_000)).toBeNull();
  });

  it("finds a handful of backlogged users filling the window on their own after an outage", () => {
    const fill = backlogFill(known, 60_000, 800);
    // 2 400 ms at 12 tx + 288 more getTransactions at 100 ms + 800 ms of write floor.
    expect(fill!.perUserMs).toBe(2_400 + (MAX_SIGNATURES - 12) * 100 + 800);
    expect(fill!.users).toBe(2);
    expect(backlogFill({ ...known, hotReadMs: null }, 60_000, 800)).toBeNull();
  });
});

describe("a provider's rate limit, which is a refusal and not a slowdown", () => {
  it("has the keeper's pool THROW on a 429 rather than wait — the premise the bench models", async () => {
    // If rpc-pool.ts ever learns to back off, this goes red and the bench's
    // 429-as-refusal model has to be revisited with it.
    const answered = vi.fn(async () => new Response("", { status: 429 }));
    vi.stubGlobal("fetch", answered);
    const fetcher = poolFetch([new Secret("https://rpc.example.test/?api-key=NeverServed", "rpcUrl:0")]);
    await expect(fetcher("ignored")).rejects.toThrow(/every Solana endpoint refused.*HTTP 429/);
    expect(answered).toHaveBeenCalledTimes(1);
  });

  it("admits a second's worth of burst, then refuses rather than queues, and refills at the plan's rate", () => {
    let now = 0;
    const gate = createRateGate(10, () => now);
    for (let i = 0; i < 10; i++) expect(gate.admit()).toBe(true);
    expect(gate.admit()).toBe(false);
    expect(gate.admit()).toBe(false);
    expect(gate.refused).toBe(2);
    now += 100; // a tenth of a second is one request at 10 a second
    expect(gate.admit()).toBe(true);
    expect(gate.admit()).toBe(false);
    expect(() => createRateGate(0)).toThrow(/positive/);
  });

  it("grades a row with a refusal as refused however fast it was, because a refused sweep ends early", () => {
    expect(rowVerdict(900, 60_000, 0)).toBe("fits");
    expect(rowVerdict(900, 60_000, 31)).toBe("refused");
    expect(rowVerdict(70_000, 60_000, 0)).toBe("overruns");
  });

  it("gives no ceiling at all to a sweep that drives more requests a second than the plan allows", () => {
    // 6 calls over 600 ms is 10 requests a second, from the first call to the last.
    const under = fleetCeiling({ costs: known, windowMs: 60_000, hotShare: 0, writeMs: 0, writeCalls: 0, planRps: 12 });
    expect(under.driveRps).toBeCloseTo(10, 6);
    expect(under.binding).toBe("window");
    expect(under.links).toBe(100);
    const over = fleetCeiling({ costs: known, windowMs: 60_000, hotShare: 0, writeMs: 0, writeCalls: 0, planRps: 5 });
    expect(over.overPlan).toBe(true);
    expect(over.binding).toBe("refused");
    expect(over.links).toBeNull();
    // What a keeper that PACED itself could reach: (5 x 60 - 8) / 6 = 48.7 -> 49.
    expect(over.byPlan).toBe(49);
  });

  it("still states the request rate a ceiling needs when no plan was given", () => {
    const answer = fleetCeiling({ costs: known, windowMs: 60_000, hotShare: 0, writeMs: 0, writeCalls: 0, planRps: null });
    expect(answer.driveRps).toBeCloseTo(10, 6);
    expect(answer.overPlan).toBe(false);
    expect(answer.byPlan).toBeNull();
  });
});

describe("the straight line c6e38d8 read its headline from", () => {
  it("is kept only to print beside the corrected figure, and is higher than it on a fleet with hot users", () => {
    const line = fitSweepCost(DEFAULT_GRID_AT_2_PERCENT.map(({ links, sweepMs }) => ({ links, sweepMs })))!;
    const floor = settleWriteFloor(roundTripMs(known)!);
    const corrected = fleetCeiling({ costs: known, windowMs: 60_000, hotShare: 0.02, writeMs: floor.ms, writeCalls: floor.calls, planRps: null });
    expect(ceilingLinks(line, 60_000)!).toBeGreaterThan(corrected.links!);
  });
});
