// The quota hand-out (src/rpc-quota.ts): the scheduler's arithmetic, a
// worker's following of its row — the floor at boot and after two silent
// minutes — and the Jupiter pacer of P2 retuned to a worker's share of the
// organisation's minute (src/jupiter-pacer.ts, retune).
//
// THE ROW'S STORE IS NOT HERE: a WorkerQuotaSource is whatever the test hands
// in, as the store track's will be.

import { describe, expect, it } from "vitest";
import { JupiterPacer, buyingTurnJupiterCalls } from "../src/jupiter-pacer.js";
import { RpcBudget } from "../src/rpc-budget.js";
import {
  FLEET_RPS_SHARE,
  HELIUS_DEVELOPER_RPS,
  QUOTA_STALE_MS,
  QuotaFollower,
  SCHEDULER_RPS,
  fleetQuotas,
  type WorkerQuotaRow,
  type WorkerQuotaSource,
} from "../src/rpc-quota.js";
import { manualClock } from "./manual-clock.js";

describe("the scheduler's hand-out", () => {
  it("gives the fleet 40 of Developer's 50, keeps 8 for the scheduler and splits 32 among the live workers", () => {
    expect(HELIUS_DEVELOPER_RPS * FLEET_RPS_SHARE).toBe(40);
    expect(SCHEDULER_RPS).toBe(8);
    const two = fleetQuotas({ liveWorkers: 2, maxWorkers: 4, jupiterPerMinute: 60 });
    expect(two).toEqual({ fleetRps: 40, schedulerRps: 8, perWorkerRps: 16, floorRps: 8, perWorkerJupiterPerMinute: 30, floorJupiterPerMinute: 15 });
    expect(fleetQuotas({ liveWorkers: 3, maxWorkers: 4 }).perWorkerRps).toBeCloseTo(32 / 3, 9);
  });

  it("never hands out more than the fleet's budget, whoever is alive: live shares and floors both add up to at most 32", () => {
    for (let max = 1; max <= 6; max++) {
      for (let live = 0; live <= max; live++) {
        const q = fleetQuotas({ liveWorkers: live, maxWorkers: max, jupiterPerMinute: 30 });
        expect((q.perWorkerRps ?? 0) * live).toBeLessThanOrEqual(32 + 1e-9);
        expect(q.floorRps * max).toBeLessThanOrEqual(32 + 1e-9);
        expect((q.perWorkerJupiterPerMinute ?? 0) * live).toBeLessThanOrEqual(30);
        expect(q.schedulerRps + (q.perWorkerRps ?? 0) * live).toBeLessThanOrEqual(q.fleetRps + 1e-9);
      }
    }
  });

  it("states no per-worker share with no live worker, and refuses inputs that are not a fleet", () => {
    expect(fleetQuotas({ liveWorkers: 0, maxWorkers: 2 }).perWorkerRps).toBeNull();
    expect(fleetQuotas({ liveWorkers: 1, maxWorkers: 1, schedulerRps: 100 }).schedulerRps).toBe(40);
    expect(() => fleetQuotas({ liveWorkers: 3, maxWorkers: 2 })).toThrow(/liveWorkers/);
    expect(() => fleetQuotas({ liveWorkers: 1, maxWorkers: 0 })).toThrow(/maxWorkers/);
    expect(() => fleetQuotas({ liveWorkers: 1, maxWorkers: 1, share: 1.5 })).toThrow(/at most 1/);
    expect(() => fleetQuotas({ liveWorkers: 1, maxWorkers: 1, planRps: 0 })).toThrow(/planRps/);
  });
});

/** A worker's budget and pacer, a follower over them, and a row the test writes. */
function worker() {
  const clock = manualClock();
  const budget = new RpcBudget({ ratePerSecond: 8, defaultLane: "hot", now: clock.now, setTimer: clock.setTimer });
  const pacer = new JupiterPacer({ perMinute: 60, now: clock.now, sleep: async () => undefined });
  const follower = new QuotaFollower({ budget, pacer, floorRps: 8, floorJupiterPerMinute: 15, maxRps: 40, now: clock.now });
  let row: WorkerQuotaRow | null = null;
  const source: WorkerQuotaSource = { readQuota: async () => row };
  return { clock, budget, pacer, follower, source, write: (next: WorkerQuotaRow | null) => (row = next) };
}

describe("a worker following its row", () => {
  it("starts on the floor, before any heartbeat has read anything", () => {
    const { budget, pacer, follower } = worker();
    expect(follower.status()).toMatchObject({ state: "floor", rpsQuota: 8, jupiterPerMinute: 15, heardAt: null });
    expect(budget.quotaPerSecond).toBe(8);
    expect(pacer.perMinute).toBe(15);
  });

  it("sets a fresh quota on its bucket and its pacer", async () => {
    const { clock, budget, pacer, follower, source, write } = worker();
    write({ rpsQuota: 16, jupQuotaPerMinute: 30, ageMs: 5_000 });
    expect(await follower.refresh(source)).toMatchObject({ state: "row", rpsQuota: 16, jupiterPerMinute: 30 });
    expect(budget.quotaPerSecond).toBe(16);
    expect(pacer.perMinute).toBe(30);
  });

  it("keeps a quota for two minutes from when the scheduler WROTE it, through failed reads, then drops to the floor", async () => {
    const { clock, budget, follower, source, write } = worker();
    write({ rpsQuota: 16, jupQuotaPerMinute: 30, ageMs: 0 });
    await follower.refresh(source);
    // A READ THAT FAILS a minute later is not a dead scheduler.
    await clock.advance(60_000);
    expect(follower.apply(null).state).toBe("holding");
    expect(budget.quotaPerSecond).toBe(16);
    // THE SCHEDULER HAS STOPPED WRITING: the same row, older every beat. At the bound it still counts…
    write({ rpsQuota: 16, jupQuotaPerMinute: 30, ageMs: QUOTA_STALE_MS });
    await clock.advance(60_000);
    expect((await follower.refresh(source)).state).toBe("row");
    // …and past it the worker is on the floor — however recently it re-read the row.
    write({ rpsQuota: 16, jupQuotaPerMinute: 30, ageMs: QUOTA_STALE_MS + 1 });
    await clock.advance(1);
    expect((await follower.refresh(source)).state).toBe("floor");
    expect(budget.quotaPerSecond).toBe(8);
    // AND BACK when the scheduler writes again.
    write({ rpsQuota: 10.5, jupQuotaPerMinute: 20.7, ageMs: 0 });
    expect(await follower.refresh(source)).toMatchObject({ state: "row", rpsQuota: 10.5, jupiterPerMinute: 20 });
  });

  it("does not let re-reading an old row stretch the two minutes", async () => {
    const { clock, follower, source, write } = worker();
    write({ rpsQuota: 16, jupQuotaPerMinute: 30, ageMs: 100_000 });
    expect((await follower.refresh(source)).state).toBe("row");
    // The scheduler is gone; reads now fail. The quota was written 100 s before the last read,
    // so it has 20 s left, not 120.
    await clock.advance(20_000);
    expect(follower.apply(null).state).toBe("holding");
    await clock.advance(1);
    expect(follower.apply(null).state).toBe("floor");
  });

  it("measures freshness by the database's age alone, so a worker clock hours off changes nothing", async () => {
    const skewed = manualClock(1_000_000 + 6 * 3_600_000);
    const budget = new RpcBudget({ ratePerSecond: 8, defaultLane: "hot", now: skewed.now, setTimer: skewed.setTimer });
    const follower = new QuotaFollower({ budget, pacer: null, floorRps: 8, floorJupiterPerMinute: null, maxRps: 40, now: skewed.now });
    expect(follower.apply({ rpsQuota: 16, jupQuotaPerMinute: null, ageMs: 3_000 }).state).toBe("row");
    expect(budget.quotaPerSecond).toBe(16);
  });

  it("treats a row without a quota, or without the time it was written, as hearing nothing", async () => {
    const { clock, follower, source, write } = worker();
    write({ rpsQuota: null, jupQuotaPerMinute: null, ageMs: 0 });
    expect((await follower.refresh(source)).state).toBe("floor");
    write({ rpsQuota: 16, jupQuotaPerMinute: 30, ageMs: null });
    expect((await follower.refresh(source)).state).toBe("floor");
    write(null);
    expect((await follower.refresh(source)).state).toBe("floor");
  });

  it("refuses a quota over the fleet's whole budget or not a positive number, and keeps what it had", async () => {
    const { clock, budget, follower, source, write } = worker();
    write({ rpsQuota: 16, jupQuotaPerMinute: 30, ageMs: 0 });
    await follower.refresh(source);
    for (const bad of [400, -1, 0, Number.NaN]) {
      write({ rpsQuota: bad, jupQuotaPerMinute: 30, ageMs: 0 });
      await follower.refresh(source);
    }
    expect(budget.quotaPerSecond).toBe(16);
    expect(follower.status()).toMatchObject({ state: "holding", refused: 4 });
  });

  it("never throws into the heartbeat: a read that throws or hangs is a beat that heard nothing", async () => {
    const clock = manualClock();
    const budget = new RpcBudget({ ratePerSecond: 8, defaultLane: "hot", now: clock.now, setTimer: clock.setTimer });
    const follower = new QuotaFollower({ budget, pacer: null, floorRps: 8, floorJupiterPerMinute: null, maxRps: 40, now: clock.now, readTimeoutMs: 20 });
    await expect(follower.refresh({ readQuota: async () => Promise.reject(new Error("pg down")) })).resolves.toMatchObject({ state: "floor" });
    await expect(follower.refresh({ readQuota: () => new Promise(() => undefined) })).resolves.toMatchObject({ state: "floor" });
    expect(follower.status().readFailures).toBe(2);
    expect(follower.status().jupiterPerMinute).toBeNull();
  });
});

describe("the P2 Jupiter pacer, retuned to a worker's share", () => {
  it("answers exactly as before while it is never retuned: the share is the ceiling", () => {
    const pacer = new JupiterPacer({ perMinute: 30, now: () => 0, sleep: async () => undefined });
    expect(pacer.perMinute).toBe(30);
    expect(pacer.ceilingPerMinute).toBe(30);
    expect(pacer.minGapMs).toBe(2_000);
    const never = pacer.reserve(31);
    expect(never.granted).toBe(false);
    if (!never.granted) {
      expect(never.reason).toBe("never-fits");
      expect(never.detail).toContain("this keeper's budget is 30 a minute");
    }
    pacer.reserve(18);
    const short = pacer.reserve(18);
    expect(short.granted).toBe(false);
    if (!short.granted) expect(short.detail).toContain("18 of this keeper's 30 a minute are spent or reserved");
  });

  it("defers — does not refuse — a basket the organisation's minute covers but this worker's share does not", () => {
    const pacer = new JupiterPacer({ perMinute: 60, now: () => 0, sleep: async () => undefined });
    expect(pacer.retune(15)).toBe(true);
    const owner = buyingTurnJupiterCalls(2, true);
    expect(owner).toBe(18);
    const answer = pacer.reserve(owner);
    expect(answer.granted).toBe(false);
    if (!answer.granted) {
      expect(answer.reason).toBe("budget");
      expect(answer.detail).toContain("this worker's share of the fleet's 60");
    }
    // OVER THE WHOLE MINUTE it is still never-fits.
    const huge = pacer.reserve(61);
    expect(huge.granted).toBe(false);
    if (!huge.granted) expect(huge.reason).toBe("never-fits");
    expect(pacer.retune(30)).toBe(true);
    expect(pacer.reserve(owner).granted).toBe(true);
  });

  it("spaces calls at the share, clamps a share above the ceiling to it, and refuses one that is not a positive number", () => {
    const pacer = new JupiterPacer({ perMinute: 60, now: () => 0, sleep: async () => undefined });
    pacer.retune(30);
    expect(pacer.minGapMs).toBe(2_000);
    pacer.retune(600);
    expect(pacer.perMinute).toBe(60);
    expect(pacer.minGapMs).toBe(1_000);
    for (const bad of [0, 0.5, -3, Number.NaN, Number.POSITIVE_INFINITY]) expect(pacer.retune(bad)).toBe(false);
    expect(pacer.perMinute).toBe(60);
  });

  it("never takes calls back from a turn already granted: a smaller share defers the next turn only", async () => {
    let now = 0;
    const pacer = new JupiterPacer({ perMinute: 60, now: () => now, sleep: async (ms) => void (now += ms) });
    const answer = pacer.reserve(18);
    expect(answer.granted).toBe(true);
    if (!answer.granted) return;
    pacer.retune(10);
    for (let i = 0; i < 18; i++) await answer.reservation.beforeCall();
    answer.reservation.release();
    expect(pacer.status().overdrawn).toBe(0);
    expect(pacer.status().calls).toBe(18);
    expect(pacer.reserve(1).granted).toBe(false);
  });
});
