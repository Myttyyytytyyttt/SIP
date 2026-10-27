// The quota hand-out (src/rpc-quota.ts): the scheduler's arithmetic, a
// worker's following of its row — the floor at boot and after two silent
// minutes — and the Jupiter pacer of P2 retuned to a worker's share of the
// organisation's minute (src/jupiter-pacer.ts, retune).
//
// THE ROW'S STORE IS NOT HERE: a WorkerQuotaSource is whatever the test hands
// in, as the store track's will be.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

  it("REFUSES — never silently defers — a basket the organisation's minute covers but this worker's share does not", () => {
    // THE REVIEW'S PROBE: the free key's 60, four workers at most, two alive.
    const quotas = fleetQuotas({ liveWorkers: 2, maxWorkers: 4, jupiterPerMinute: 60 });
    expect([quotas.perWorkerJupiterPerMinute, quotas.floorJupiterPerMinute]).toEqual([30, 15]);
    const pacer = new JupiterPacer({ perMinute: 60, now: () => 0, sleep: async () => undefined });
    // ON ITS FLOOR (at boot, or two minutes after the scheduler went quiet): 15, under the owner's 18.
    expect(pacer.retune(quotas.floorJupiterPerMinute!)).toBe(true);
    const owner = buyingTurnJupiterCalls(2, true);
    expect(owner).toBe(18);
    for (let sweep = 0; sweep < 3; sweep++) {
      const answer = pacer.reserve(owner);
      expect(answer.granted).toBe(false);
      if (!answer.granted) {
        expect(answer.reason).toBe("share-too-small");
        // NO WAIT IS PROMISED: nothing frees on its own.
        expect(answer.retryInMs).toBeNull();
        expect(answer.detail).not.toContain("frees in about");
        expect(answer.detail).toContain("this worker's share of the organisation's 60 a minute is 15 now");
        expect(answer.detail).toContain("run fewer workers");
      }
    }
    expect(pacer.status().deferred).toEqual({ budget: 0, backoff: 0, neverFits: 3 });
    expect(pacer.status().lastDeferral?.reason).toBe("share-too-small");
    // THE ADR'S r = 2 ON A 5-LEG BASKET UNDER THE KEY: 36 calls over a share of 30, within the minute of 60.
    expect(pacer.retune(quotas.perWorkerJupiterPerMinute!)).toBe(true);
    const fiveLegs = pacer.reserve(buyingTurnJupiterCalls(5, true));
    expect(!fiveLegs.granted && fiveLegs.reason).toBe("share-too-small");
    // OVER THE WHOLE MINUTE it is still never-fits.
    const huge = pacer.reserve(61);
    expect(huge.granted).toBe(false);
    if (!huge.granted) expect(huge.reason).toBe("never-fits");
    // A SHARE THE BASKET FITS: bought.
    expect(pacer.reserve(owner).granted).toBe(true);
  });

  it("still DEFERS a basket its share covers when the share's minute is merely spent: that one frees on its own", () => {
    const pacer = new JupiterPacer({ perMinute: 60, now: () => 0, sleep: async () => undefined });
    pacer.retune(30);
    expect(pacer.reserve(18).granted).toBe(true);
    const short = pacer.reserve(18);
    expect(short.granted).toBe(false);
    if (!short.granted) {
      expect(short.reason).toBe("budget");
      expect(short.detail).toContain("this worker's share of the fleet's 60");
      expect(short.retryInMs).toBe(60_000);
    }
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

describe("bin/worker.mts: the pacer built at the organisation's minute, held at the floor until a hand-out", () => {
  const worker = readFileSync(fileURLToPath(new URL("../bin/worker.mts", import.meta.url)), "utf8");

  it("builds ONE pacer with the whole minute as its ceiling and hands the follower the floor, with nothing awaited in between", () => {
    expect(worker.match(/new JupiterPacer\(/g)).toHaveLength(1);
    expect(worker).toContain("pacer: new JupiterPacer({ perMinute: config.jupiterCallsPerMinute }),");
    expect(worker).toContain("const jupiterFloorPerMinute = Math.max(1, floor.floorJupiterPerMinute ?? config.jupiterCallsPerMinute);");
    expect(worker).toContain("floorJupiterPerMinute: jupiter === null ? null : jupiterFloorPerMinute,");
    // THE FOLLOWER'S CONSTRUCTOR IS WHAT PUTS THE PACER ON THE FLOOR: built in the
    // same synchronous run as the pacer, and before the loop that runs the jobs.
    const pacerAt = worker.indexOf("new JupiterPacer(");
    const followerAt = worker.indexOf("const follower = new QuotaFollower({");
    expect(pacerAt).toBeGreaterThan(-1);
    expect(followerAt).toBeGreaterThan(pacerAt);
    expect(worker.slice(pacerAt, followerAt)).not.toMatch(/\bawait\b/);
    expect(followerAt).toBeLessThan(worker.indexOf("await loop.start();"));
  });

  /** The worker's construction, as bin/worker.mts writes it, for a fleet of `maxWorkers` on the organisation's `minute`. */
  function booted(maxWorkers: number, minute: number) {
    const clock = manualClock();
    const floor = fleetQuotas({ liveWorkers: 0, maxWorkers, jupiterPerMinute: minute });
    const budget = new RpcBudget({ ratePerSecond: floor.floorRps, defaultLane: "hot", now: clock.now, setTimer: clock.setTimer });
    const pacer = new JupiterPacer({ perMinute: minute, now: clock.now, sleep: async () => undefined });
    const ceiling = pacer.perMinute;
    const follower = new QuotaFollower({
      budget,
      pacer,
      floorRps: floor.floorRps,
      floorJupiterPerMinute: Math.max(1, floor.floorJupiterPerMinute ?? minute),
      maxRps: floor.fleetRps,
      now: clock.now,
    });
    /** The scheduler's hand-out with `live` workers alive, as handOutQuotas computes it, just written. */
    const handOut = (live: number) => {
      const q = fleetQuotas({ liveWorkers: live, maxWorkers: Math.max(maxWorkers, live), jupiterPerMinute: minute });
      return follower.apply({ rpsQuota: q.perWorkerRps, jupQuotaPerMinute: q.perWorkerJupiterPerMinute, ageMs: 0 });
    };
    return { clock, pacer, follower, ceiling, handOut };
  }

  it("runs at the floor from boot, rises to a lone worker's whole minute, and is back on the floor two minutes after the scheduler goes quiet", async () => {
    // TWO WORKERS AT MOST ON THE FREE KEY'S 50 A MINUTE: a floor of 25.
    const { clock, pacer, follower, ceiling, handOut } = booted(2, 50);
    expect(ceiling).toBe(50);
    expect(pacer.ceilingPerMinute).toBe(50);
    expect(pacer.perMinute).toBe(25);
    expect(follower.status()).toMatchObject({ state: "floor", jupiterPerMinute: 25 });
    // ON THE FLOOR a three-leg basket (24 calls) fits and a four-leg one (30) is refused as this worker's share, not as the plan's.
    const fourLegs = buyingTurnJupiterCalls(4, true);
    expect(fourLegs).toBe(30);
    const threeLegs = pacer.reserve(buyingTurnJupiterCalls(3, true));
    expect(threeLegs.granted).toBe(true);
    if (threeLegs.granted) threeLegs.reservation.release();
    const atFloor = pacer.reserve(fourLegs);
    expect(!atFloor.granted && atFloor.reason).toBe("share-too-small");
    // ALONE IN THE FLEET, the scheduler hands it the whole minute — and it gets it.
    expect(handOut(1)).toMatchObject({ state: "row", jupiterPerMinute: 50 });
    expect(pacer.perMinute).toBe(50);
    const alone = pacer.reserve(fourLegs);
    expect(alone.granted).toBe(true);
    if (alone.granted) alone.reservation.release();
    // THE OLD BUILD — the pacer's ceiling at the floor — kept 25 whatever the row said, and called the same basket never-fits.
    const old = new JupiterPacer({ perMinute: 25, now: clock.now, sleep: async () => undefined });
    expect(old.retune(50)).toBe(true);
    expect(old.perMinute).toBe(25);
    const oldAnswer = old.reserve(fourLegs);
    expect(!oldAnswer.granted && oldAnswer.reason).toBe("never-fits");
    // THE SCHEDULER GOES QUIET: two minutes after it last wrote, the floor again.
    await clock.advance(QUOTA_STALE_MS + 1);
    expect(follower.apply(null).state).toBe("floor");
    expect(pacer.perMinute).toBe(25);
  });

  it("comes down to a deploy's overlap share at the first beat that hears it, and never above the minute", () => {
    // PRODUCTION'S SHAPE: WORKERS_MAX = 1, 50 a minute. Its floor is the whole minute.
    const { pacer, handOut } = booted(1, 50);
    expect(pacer.perMinute).toBe(50);
    // THE OUTGOING REPLICA IS STILL ALIVE: the scheduler divides among both.
    expect(handOut(2)).toMatchObject({ state: "row", jupiterPerMinute: 25 });
    expect(pacer.perMinute).toBe(25);
    expect(handOut(1).jupiterPerMinute).toBe(50);
    // A ROW ABOVE THE MINUTE is held to the ceiling.
    expect(pacer.retune(600)).toBe(true);
    expect(pacer.perMinute).toBe(50);
  });

  it("takes a floor of zero — a minute smaller than WORKERS_MAX — as one call, never leaving the pacer at its ceiling", () => {
    expect(fleetQuotas({ liveWorkers: 0, maxWorkers: 4, jupiterPerMinute: 3 }).floorJupiterPerMinute).toBe(0);
    const { pacer } = booted(4, 3);
    expect(pacer.perMinute).toBe(1);
  });
});
