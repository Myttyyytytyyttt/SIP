// The fleet's month of Helius credits (src/credit-governor.ts): the rpc_usage
// rows a process collects and flushes, the in-memory feed, the governor that
// stretches the safety rotation 30 → 60 → 120 min as the month runs short, and
// the one thing it must never do — hold back a send.
//
// THE MONTH IS NOVEMBER 2026 (30 days, UTC), and every burn below is written
// into the feed as ten-minute rows, as a fleet's heartbeats would write it. The
// numbers are chosen so each projection is a round figure the reader can check:
// plan 10M, day 10, twenty days left.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CREDIT_GOVERNOR_ALERT_KEY,
  CreditGovernor,
  GOVERNOR_DWELL_MS,
  InMemoryRpcUsageFeed,
  RpcUsageCollector,
  SAFETY_PASS_STEPS_MS,
  USAGE_BUCKET_MS,
  bucketStart,
  safetySliceSize,
  summarizeUsage,
  utcMonth,
  type RpcUsageFeed,
  type RpcUsageRow,
  type UsageClass,
  type UsageProvider,
} from "../src/credit-governor.js";
import { SAFETY_MIN_PER_SWEEP, SAFETY_PASS_MS } from "../src/doorbell.js";
import { RpcBudget, withRpcLane, type RpcLane } from "../src/rpc-budget.js";
import { manualClock } from "./manual-clock.js";

const KEEPER = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOV = Date.UTC(2026, 10, 1);

/** Writes `perDay` calls a day for each lane, as rows of `usageClass`, over [from, to). Each per-day figure divides by 144 buckets. */
async function burn(
  feed: RpcUsageFeed,
  from: number,
  to: number,
  perDay: Partial<Record<RpcLane, number>>,
  usageClass: UsageClass = "standard",
  provider: UsageProvider = "helius-rpc",
): Promise<void> {
  const rows: RpcUsageRow[] = [];
  for (let bucket = bucketStart(from); bucket < to; bucket += USAGE_BUCKET_MS) {
    for (const [lane, calls] of Object.entries(perDay) as [RpcLane, number][]) {
      rows.push({ bucket, workerId: "w1", provider, lane, usageClass, calls: calls / 144, errors429: 0, errorsOther: 0 });
    }
  }
  await feed.add(rows);
}

function governed(options: { readonly at: number; readonly archival?: 1 | 10; readonly source?: "default" | "env"; readonly feed?: RpcUsageFeed; readonly readTimeoutMs?: number }) {
  let now = options.at;
  const feed = options.feed ?? new InMemoryRpcUsageFeed();
  const governor = new CreditGovernor({
    feed,
    archivalCredits: options.archival ?? 1,
    archivalCreditsSource: options.source ?? "env",
    now: () => now,
    ...(options.readTimeoutMs === undefined ? {} : { readTimeoutMs: options.readTimeoutMs }),
  });
  return { feed, governor, at: () => now, advance: (ms: number) => (now += ms) };
}

describe("the rows a process collects", () => {
  it("counts what was asked once and each failed attempt, by ten-minute bucket, lane and bill line", async () => {
    const collector = new RpcUsageCollector({ workerId: "worker-a" });
    const t = NOV + 5 * 60_000;
    collector.asked("hot", "archival", 2, t);
    collector.asked("hot", "archival", 1, t + 60_000);
    collector.ended("hot", "archival", 429, t + 61_000);
    collector.ended("hot", "archival", 503, t + 62_000);
    collector.ended("hot", "archival", "unreachable", t + 63_000);
    collector.ended("hot", "archival", 200, t + 64_000);
    collector.asked("send", "standard", 1, t + 6 * 60_000);
    collector.count("jupiter", "hot", "jupiter", 18, t);
    const rows = collector.drain().sort((a, b) => a.bucket - b.bucket || a.lane.localeCompare(b.lane) || a.provider.localeCompare(b.provider));
    expect(rows).toEqual([
      { bucket: NOV, workerId: "worker-a", provider: "helius-rpc", lane: "hot", usageClass: "archival", calls: 3, errors429: 1, errorsOther: 2 },
      { bucket: NOV, workerId: "worker-a", provider: "jupiter", lane: "hot", usageClass: "jupiter", calls: 18, errors429: 0, errorsOther: 0 },
      { bucket: NOV + USAGE_BUCKET_MS, workerId: "worker-a", provider: "helius-rpc", lane: "send", usageClass: "standard", calls: 1, errors429: 0, errorsOther: 0 },
    ]);
    expect(collector.drain()).toEqual([]);
  });

  it("is the budget's sink: a request admitted through the bucket lands in its lane's row", async () => {
    const clock = manualClock(NOV);
    const collector = new RpcUsageCollector({ workerId: "worker-a" });
    const budget = new RpcBudget({ ratePerSecond: 10, defaultLane: "rest", usage: collector, now: clock.now, setTimer: clock.setTimer });
    const permit = await budget.admit(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSignaturesForAddress", params: ["w", { limit: 1 }] }));
    budget.answered(permit, 429);
    expect(collector.drain()).toEqual([{ bucket: NOV, workerId: "worker-a", provider: "helius-rpc", lane: "rest", usageClass: "archival", calls: 1, errors429: 1, errorsOther: 0 }]);
  });

  it("adds each flush onto the stored rows, and keeps what a failed or hung write could not store", async () => {
    const feed = new InMemoryRpcUsageFeed();
    const collector = new RpcUsageCollector({ workerId: "worker-a" });
    collector.asked("hot", "standard", 5, NOV);
    expect(await collector.flush(feed)).toEqual({ written: 1 });
    collector.asked("hot", "standard", 7, NOV + 1_000);
    await collector.flush(feed);
    expect((await feed.read(NOV, NOV + DAY))[0]!.calls).toBe(12);

    collector.asked("hot", "standard", 3, NOV + 2_000);
    const nothing = async () => ({ total: {}, recentRest: {}, recentOther: {} });
    const down: RpcUsageFeed = { add: async () => Promise.reject(new Error("pg down")), read: async () => [], summarize: nothing };
    expect(await collector.flush(down)).toEqual({ failed: true, kept: 1 });
    const hung: RpcUsageFeed = { add: () => new Promise(() => undefined), read: async () => [], summarize: nothing };
    collector.asked("hot", "standard", 1, NOV + 3_000);
    expect(await collector.flush(hung, 20)).toEqual({ failed: true, kept: 1 });
    expect(collector.status()).toMatchObject({ pendingRows: 1, flushFailures: 2 });
    await collector.flush(feed);
    expect((await feed.read(NOV, NOV + DAY))[0]!.calls).toBe(16);
  });

  it("drops its oldest rows rather than grow without bound while the feed is down", () => {
    const collector = new RpcUsageCollector({ workerId: "worker-a", maxRows: 3 });
    for (let i = 0; i < 5; i++) collector.asked("hot", "standard", 1, NOV + i * USAGE_BUCKET_MS);
    expect(collector.drain().map((row) => (row.bucket - NOV) / USAGE_BUCKET_MS)).toEqual([2, 3, 4]);
    expect(collector.status().dropped).toBe(2);
  });

  it("is pruned at 35 days by the reap, and reads a half-open range", async () => {
    const feed = new InMemoryRpcUsageFeed();
    await burn(feed, NOV, NOV + 2 * HOUR, { hot: 144 });
    expect(await feed.read(NOV, NOV + HOUR)).toHaveLength(6);
    expect(feed.prune(NOV + HOUR)).toBe(6);
    expect(feed.size).toBe(6);
  });
});

describe("the safety slice at a stretched pass", () => {
  it("is the doorbell's own formula at 30 minutes, and half and a quarter of it at 60 and 120", () => {
    expect(SAFETY_PASS_STEPS_MS).toEqual([SAFETY_PASS_MS, 2 * SAFETY_PASS_MS, 4 * SAFETY_PASS_MS]);
    expect(safetySliceSize(10_000, 60_000, SAFETY_PASS_MS)).toBe(334);
    expect(safetySliceSize(10_000, 60_000, 2 * SAFETY_PASS_MS)).toBe(167);
    expect(safetySliceSize(10_000, 60_000, 4 * SAFETY_PASS_MS)).toBe(84);
  });

  it("changes nothing at today's fleet: the floor covers every link up to 50", () => {
    expect(SAFETY_MIN_PER_SWEEP).toBe(50);
    for (const pass of SAFETY_PASS_STEPS_MS) {
      expect(safetySliceSize(4, 60_000, pass)).toBe(4);
      expect(safetySliceSize(50, 60_000, pass)).toBe(50);
    }
    expect(safetySliceSize(0, 60_000, SAFETY_PASS_MS)).toBe(0);
  });
});

describe("the governor", () => {
  it("leaves the rotation at 30 minutes and clears its alert on a month projected at 60 %", async () => {
    const { feed, governor } = governed({ at: NOV + 10 * DAY });
    await burn(feed, NOV, NOV + 10 * DAY, { hot: 201_600 });
    const verdict = await governor.evaluate();
    expect(verdict).toMatchObject({ step: 0, safetyPassMs: SAFETY_PASS_MS, monthToDateCredits: 2_016_000, projectedPct: 60.5, held: null });
    expect(verdict.alert).toEqual({ fire: null, clear: true });
  });

  it("stretches to 60 minutes and warns on a month projected over 90 %, then reads the month at the new pass", async () => {
    const { feed, governor } = governed({ at: NOV + 10 * DAY });
    // 316 800 a day, half of it the safety rotation's rest lane: 3.168M + 20 × 316 800 = 9.504M.
    await burn(feed, NOV, NOV + 10 * DAY, { hot: 158_400, rest: 158_400 });
    const verdict = await governor.evaluate();
    expect(verdict.step).toBe(1);
    expect(verdict.safetyPassMs).toBe(2 * SAFETY_PASS_MS);
    expect(governor.safetyPassMs).toBe(2 * SAFETY_PASS_MS);
    // AT 60 MINUTES the rest lane burns half: 3.168M + 20 × (158 400 + 79 200) = 7.92M.
    expect(verdict.projectedPct).toBe(79.2);
    expect(verdict.projectedPctShorter).toBe(95);
    expect(verdict.alert.fire).toMatchObject({ key: CREDIT_GOVERNOR_ALERT_KEY, severity: "warn" });
    expect(verdict.alert.fire!.detail).toContain("bells, busy vaults, retries and every send run exactly as before");
  });

  it("waits an hour between steps, then stretches to 120 minutes and pages a month the stretch cannot save", async () => {
    const { feed, governor, at, advance } = governed({ at: NOV + 10 * DAY });
    const rate = { hot: 403_200, rest: 100_800 };
    await burn(feed, NOV, at(), rate);
    const first = await governor.evaluate();
    expect(first.step).toBe(1);
    expect(first.alert.fire).toMatchObject({ severity: "critical" });
    advance(GOVERNOR_DWELL_MS / 2);
    await burn(feed, at() - GOVERNOR_DWELL_MS / 2, at(), rate);
    const held = await governor.evaluate();
    expect(held).toMatchObject({ step: 1, held: "dwell" });
    advance(GOVERNOR_DWELL_MS / 2);
    await burn(feed, at() - GOVERNOR_DWELL_MS / 2, at(), rate);
    const second = await governor.evaluate();
    expect(second.step).toBe(2);
    expect(second.safetyPassMs).toBe(4 * SAFETY_PASS_MS);
    expect(second.alert.fire).toMatchObject({ severity: "critical" });
    expect(second.alert.fire!.detail).toContain("Stretching is not enough");
    // NOWHERE PAST 120.
    advance(GOVERNOR_DWELL_MS);
    await burn(feed, at() - GOVERNOR_DWELL_MS, at(), rate);
    expect((await governor.evaluate()).step).toBe(2);
  });

  it("steps back only when the month at the shorter pass is projected under 85 %", async () => {
    const { feed, governor, at, advance } = governed({ at: NOV + 10 * DAY });
    await burn(feed, NOV, at(), { hot: 158_400, rest: 158_400 });
    expect((await governor.evaluate()).step).toBe(1);
    // THE BURN DROPS to 100 800 a day for the next hour.
    advance(HOUR);
    await burn(feed, at() - HOUR, at(), { hot: 50_400, rest: 50_400 });
    const relaxed = await governor.evaluate();
    expect(relaxed.step).toBe(0);
    expect(relaxed.safetyPassMs).toBe(SAFETY_PASS_MS);
    expect(relaxed.alert).toEqual({ fire: null, clear: true });
  });

  it("does not step back while the month at the shorter pass would still be over 85 %", async () => {
    const { feed, governor, at, advance } = governed({ at: NOV + 10 * DAY });
    await burn(feed, NOV, at(), { hot: 158_400, rest: 158_400 });
    await governor.evaluate();
    advance(HOUR);
    // The same burn, read now as the rest lane at 60 minutes: at 30 it would be back near 95 %.
    await burn(feed, at() - HOUR, at(), { hot: 158_400, rest: 79_200 });
    const kept = await governor.evaluate();
    expect(kept.step).toBe(1);
    expect(kept.projectedPctShorter).toBeGreaterThan(85);
  });

  it("takes the archival price as a parameter, and decides on the dearer one while it is unsettled", async () => {
    const at = NOV + 10 * DAY;
    const archivalBurn = async (feed: RpcUsageFeed) => burn(feed, NOV, at, { hot: 144_000 }, "archival");
    const one = governed({ at, archival: 1, source: "env" });
    await archivalBurn(one.feed);
    expect(await one.governor.evaluate()).toMatchObject({ step: 0, projectedPct: 43.2, archivalCredits: 1 });
    const ten = governed({ at, archival: 10, source: "env" });
    await archivalBurn(ten.feed);
    expect(await ten.governor.evaluate()).toMatchObject({ step: 1, archivalCredits: 10 });
    // UNSETTLED (the variable unset): configured 1, decided at 10, and the page says why.
    const unsettled = governed({ at, archival: 1, source: "default" });
    await archivalBurn(unsettled.feed);
    const verdict = await unsettled.governor.evaluate();
    expect(verdict).toMatchObject({ step: 1, archivalCredits: 10 });
    expect(verdict.alert.fire!.detail).toContain("the dearer reading");
  });

  it("counts only Helius's rows: Jupiter, Privy and a non-Helius RPC endpoint are not on this bill", async () => {
    const { feed, governor } = governed({ at: NOV + 10 * DAY });
    await burn(feed, NOV, NOV + 10 * DAY, { hot: 201_600 });
    await burn(feed, NOV, NOV + 10 * DAY, { hot: 10_000_080 }, "jupiter", "jupiter");
    await burn(feed, NOV, NOV + 10 * DAY, { hot: 10_000_080 }, "privy", "privy");
    // THE SAME BILL LINE A HELIUS READ LANDS ON, from a process whose pool is not Helius's (the local shadow's public endpoint).
    await burn(feed, NOV, NOV + 10 * DAY, { hot: 10_000_080 }, "standard", "other");
    expect((await governor.evaluate()).projectedPct).toBe(60.5);
  });

  it("decides nothing from the first half hour of a month", async () => {
    const { feed, governor } = governed({ at: NOV + 20 * 60_000 });
    await burn(feed, NOV, NOV + 20 * 60_000, { hot: 100_000_080 });
    expect(await governor.evaluate()).toMatchObject({ step: 0, held: "unmeasured", projectedPct: null, alert: { fire: null, clear: false } });
  });

  it("keeps its step and raises nothing when the feed throws or hangs, and never throws into the tick", async () => {
    const feed = new InMemoryRpcUsageFeed();
    let mode: "ok" | "throw" | "hang" = "ok";
    const flaky: RpcUsageFeed = {
      add: (rows) => feed.add(rows),
      read: (from, to) => feed.read(from, to),
      summarize: (from, recent, to) =>
        mode === "ok" ? feed.summarize(from, recent, to) : mode === "throw" ? Promise.reject(new Error("pg down")) : new Promise(() => undefined),
    };
    const { governor } = governed({ at: NOV + 10 * DAY, feed: flaky, readTimeoutMs: 20 });
    await burn(feed, NOV, NOV + 10 * DAY, { hot: 158_400, rest: 158_400 });
    expect((await governor.evaluate()).step).toBe(1);
    for (const failing of ["throw", "hang"] as const) {
      mode = failing;
      const verdict = await governor.evaluate();
      expect(verdict).toMatchObject({ step: 1, safetyPassMs: 2 * SAFETY_PASS_MS, held: "feed-failed", alert: { fire: null, clear: false } });
    }
  });

  it("reads one aggregate of the month, never its rows: the same verdict from a feed whose rows cannot be read at all", async () => {
    // LATE IN A MONTH AT r = 2 the rows are tens to hundreds of thousands; the
    // governor's read must not grow with them. A feed that refuses row reads
    // decides exactly as the plain one, and is asked once per evaluation.
    const at = NOV + 10 * DAY;
    const plain = governed({ at });
    await burn(plain.feed, NOV, at, { hot: 158_400, rest: 158_400 });
    const memory = new InMemoryRpcUsageFeed();
    await burn(memory, NOV, at, { hot: 158_400, rest: 158_400 });
    const asked: Array<[number, number, number]> = [];
    const aggregateOnly: RpcUsageFeed = {
      add: (rows) => memory.add(rows),
      read: () => Promise.reject(new Error("the governor read the month's rows")),
      summarize: (from, recent, to) => {
        asked.push([from, recent, to]);
        return memory.summarize(from, recent, to);
      },
    };
    const lean = governed({ at, feed: aggregateOnly });
    const verdict = await lean.governor.evaluate();
    expect(verdict.held).toBeNull();
    expect(verdict).toEqual(await plain.governor.evaluate());
    expect(verdict.step).toBe(1);
    // THE MONTH, AND THE LAST HOUR'S BUCKETS INSIDE IT, IN ONE CALL.
    expect(asked).toEqual([[NOV, bucketStart(at - HOUR), at + 1]]);
  });

  it("summarizes only Helius's rows, by class, the recent window split by the rest lane", () => {
    const row = (bucket: number, lane: RpcLane, provider: UsageProvider, usageClass: UsageClass, calls: number): RpcUsageRow => ({
      bucket,
      workerId: "w",
      provider,
      lane,
      usageClass,
      calls,
      errors429: 0,
      errorsOther: 0,
    });
    const recent = NOV + DAY;
    const rows = [
      row(NOV, "hot", "helius-rpc", "standard", 5),
      row(recent, "rest", "helius-rpc", "standard", 7),
      row(recent, "hot", "helius-rest", "webhookEvent", 2),
      row(recent, "send", "jupiter", "jupiter", 100),
      row(NOV + 2 * DAY, "hot", "helius-rpc", "standard", 1_000),
    ];
    expect(summarizeUsage(rows, NOV, recent, NOV + 2 * DAY)).toEqual({
      total: { standard: 12, webhookEvent: 2 },
      recentRest: { standard: 7 },
      recentOther: { webhookEvent: 2 },
    });
  });

  it("reads the UTC calendar month", () => {
    expect(utcMonth(NOV + 15 * DAY)).toEqual({ start: NOV, end: Date.UTC(2026, 11, 1) });
    expect(utcMonth(Date.UTC(2026, 11, 31, 23, 59))).toEqual({ start: Date.UTC(2026, 11, 1), end: Date.UTC(2027, 0, 1) });
  });
});

describe("sends never deferred by the governor", () => {
  it("at its harshest verdict, with its feed hung, a worker still sends next and at its full quota", async () => {
    // THE SCHEDULER'S SIDE: a month that is gone. Critical, 120 minutes.
    const feed = new InMemoryRpcUsageFeed();
    const { governor, at, advance } = governed({ at: NOV + 10 * DAY, feed });
    const rate = { hot: 403_200, rest: 100_800 };
    await burn(feed, NOV, at(), rate);
    await governor.evaluate();
    advance(GOVERNOR_DWELL_MS);
    await burn(feed, at() - GOVERNOR_DWELL_MS, at(), rate);
    const verdict = await governor.evaluate();
    expect(verdict.step).toBe(2);
    expect(verdict.alert.fire!.severity).toBe("critical");

    // THE WORKER'S SIDE, on the same feed: a quota of 16 a second, a backlog of
    // hot and rest work, and a flush stuck on a database that never answers.
    const clock = manualClock(at());
    const collector = new RpcUsageCollector({ workerId: "worker-a" });
    const budget = new RpcBudget({ ratePerSecond: 16, defaultLane: "hot", usage: collector, now: clock.now, setTimer: clock.setTimer });
    const read = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: ["w"] });
    for (let i = 0; i < 16; i++) await budget.admit(read);
    const order: string[] = [];
    for (let i = 0; i < 40; i++) void withRpcLane("hot", () => budget.admit(read)).then(() => order.push("hot"));
    for (let i = 0; i < 40; i++) void withRpcLane("rest", () => budget.admit(read)).then(() => order.push("rest"));
    const hung: RpcUsageFeed = { add: () => new Promise(() => undefined), read: () => new Promise(() => undefined), summarize: () => new Promise(() => undefined) };
    const flushing = collector.flush(hung, 20);
    await clock.advance(1_000);
    // THE QUOTA'S RATE, untouched by any verdict: sixteen in the second.
    expect(order).toHaveLength(16);
    expect(budget.status().ratePerSecond).toBe(16);
    const before = order.length;
    void budget.admit(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: ["AAAA"] })).then(() => order.push("send"));
    // ONE TOKEN'S TIME at sixteen a second (62.5 ms, the timer's whole millisecond above it), ahead of 64 waiting.
    await clock.advance(63);
    expect(order[before]).toBe("send");
    expect(budget.status().maxWaitMs.send).toBeLessThanOrEqual(63);
    // THE HUNG WRITE gave up on its own and kept its two rows (hot and rest) for the next beat.
    expect(await flushing).toEqual({ failed: true, kept: 2 });
    expect(collector.status().pendingRows).toBe(3);
  });

  it("holds no bucket and no pacer to throttle with: its module imports types only from the budget, and nothing from the quota or the pacer", () => {
    const source = readFileSync(resolve(KEEPER, "src/credit-governor.ts"), "utf8");
    const imports = source.match(/^import[^;]+;$/gm) ?? [];
    expect(imports.filter((line) => line.includes("rpc-budget"))).toEqual(['import type { RpcLane, RpcUsageSink } from "./rpc-budget.js";']);
    expect(imports.some((line) => /rpc-quota|jupiter-pacer|rpc-pool/.test(line))).toBe(false);
  });
});
