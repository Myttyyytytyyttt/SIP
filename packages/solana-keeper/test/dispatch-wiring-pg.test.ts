// THE P3a TRACKS WIRED TOGETHER, ON POSTGRES 16: the store (Q1,
// src/dispatch-store.ts) behind the interfaces the other tracks left for it.
//
//   * the quota hand-out (src/rpc-quota.ts): the scheduler writes each live
//     worker's share and quota_at; the worker's beat reads it back as an age on
//     the database's clock, and QuotaFollower follows it — or drops to its floor
//     two minutes after the scheduler last wrote, whatever the worker's clock;
//   * rpc_usage (src/credit-governor.ts): PgRpcUsageFeed against
//     InMemoryRpcUsageFeed, row for row and verdict for verdict;
//   * worker.stats (src/fleet-status.ts): what a worker's beat writes is what the
//     fleet page serves and what `fence-reject` pages on;
//   * the bell (src/fleet-receiver.ts, src/fleet-pg.ts): a vault the receiver
//     rang is the one CLAIM takes first, and a bell during the job makes COMPLETE
//     due it at once;
//   * the scheduler's pool (createDispatchPool, "scheduler"): ONE connection,
//     and the receiver, the page and the full pass all get through it.
//
// RUN ONLY WITH A THROWAWAY DATABASE ON THE LOOPBACK, as
// test/carry-store-pg.test.ts and test/fleet-pg.test.ts: KEEPER_TEST_PG_URL names
// a server (a `docker run --rm postgres:16-alpine` with a generated password); a
// host that is not the loopback is refused; the run creates its own database and
// drops it at the end. Without the variable the block is skipped and says why.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { Secret } from "@sip/solana-log";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Alert } from "../src/alerts.js";
import { CreditGovernor, InMemoryRpcUsageFeed, RpcUsageCollector, USAGE_BUCKET_MS, bucketStart, type RpcUsageRow, type UsageClass, type UsageProvider } from "../src/credit-governor.js";
import { DispatchStore, LIVE_WORKERS_SQL, PgRpcUsageFeed, SCHEDULER_POOL_MAX, USAGE_SUMMARY_SQL, createDispatchPool } from "../src/dispatch-store.js";
import { FENCE_REJECT_ALERT_KEY, FleetAlerts } from "../src/fleet-alerts.js";
import { PgFleetStore } from "../src/fleet-pg.js";
import { BELL_DELAY_MS, FleetReceiver } from "../src/fleet-receiver.js";
import { FleetStatusReader, WORKER_DEAD_AFTER_MS } from "../src/fleet-status.js";
import type { RpcLane } from "../src/rpc-budget.js";
import { QUOTA_STALE_MS, QuotaFollower } from "../src/rpc-quota.js";

const URL_RAW = process.env["KEEPER_TEST_PG_URL"];
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const usable = ((): boolean => {
  if (URL_RAW === undefined || URL_RAW.trim() === "") return false;
  const host = new URL(URL_RAW).hostname;
  if (!LOOPBACK.has(host)) throw new Error("KEEPER_TEST_PG_URL must point at the loopback; it names another host");
  return true;
})();

const SCHEMA_SQL = readFileSync(fileURLToPath(new URL("../sql/sip_solana.sql", import.meta.url)), "utf8");
const fixtures = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/helius-raw-2026-09-23.json", import.meta.url)), "utf8"),
) as Record<string, unknown[]>;

/** The owner's vault (test/doorbell.test.ts): the recorded USDC deposit names it and nothing else of ours. */
const VAULT = "EFXK995PV49Qz8xPSYMEUDBU5AKRR466JkgsfuGak5iU";
const OTHER_VAULT = "Vau1tNoDe1iveryNames111111111111111111111111";

/** A small deterministic generator, so a failing property names its seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe.skipIf(!usable)("the P3a tracks wired to the store, on Postgres 16 (needs KEEPER_TEST_PG_URL on the loopback)", () => {
  const database = `keeper_wiring_${process.pid}_${Date.now()}`;
  let admin: pg.Pool;
  let db: pg.Pool;
  const pools: pg.Pool[] = [];
  const url = (): string => {
    const parsed = new URL(URL_RAW!);
    parsed.pathname = `/${database}`;
    return parsed.toString();
  };
  const pool = (max = 2): pg.Pool => {
    const opened = new pg.Pool({ connectionString: url(), max });
    opened.on("error", () => undefined);
    pools.push(opened);
    return opened;
  };

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: URL_RAW!, max: 1 });
    admin.on("error", () => undefined);
    await admin.query(`CREATE DATABASE ${database}`);
    db = pool(4);
    await db.query(SCHEMA_SQL);
  });

  afterAll(async () => {
    for (const opened of pools) await opened.end().catch(() => undefined);
    if (admin !== undefined) {
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`).catch(() => undefined);
      await admin.end();
    }
  });

  beforeEach(async () => {
    await db.query("TRUNCATE sip_solana.keeper_link, sip_solana.vault_work, sip_solana.send_intent, sip_solana.worker, sip_solana.rpc_usage");
  });

  describe("the quota hand-out: the scheduler writes, the worker's beat reads an age, the follower follows", () => {
    const follower = (sets: number[], now?: () => number) =>
      new QuotaFollower({
        budget: { setQuota: (rps) => sets.push(rps) > 0 },
        pacer: null,
        floorRps: 8,
        floorJupiterPerMinute: null,
        maxRps: 40,
        ...(now === undefined ? {} : { now }),
      });

    async function fleetOfFour(): Promise<{ scheduler: DispatchStore; a: DispatchStore; b: DispatchStore; dead: DispatchStore; stopped: DispatchStore }> {
      const scheduler = new DispatchStore(db, "sched-1");
      const [a, b, dead, stopped] = ["w-a", "w-b", "w-dead", "w-stopped"].map((id) => new DispatchStore(db, id)) as [DispatchStore, DispatchStore, DispatchStore, DispatchStore];
      await scheduler.registerProcess("scheduler", "test", 0);
      for (const worker of [a, b, dead, stopped]) await worker.registerProcess("worker", "test", 2);
      await db.query("UPDATE sip_solana.worker SET heartbeat_at = clock_timestamp() - interval '3 minutes' WHERE worker_id = 'w-dead'");
      await stopped.processStopped();
      return { scheduler, a, b, dead, stopped };
    }

    it("shares (40 − 8) among the workers alive now — not the dead, the stopped or the scheduler — and the beat reads it back a moment old", async () => {
      const { scheduler, a, dead } = await fleetOfFour();
      const out = await scheduler.handOutQuotas({ maxWorkers: 4, jupiterPerMinute: 60 });
      expect(out.workers).toEqual(["w-a", "w-b"]);
      expect(out.quotas.perWorkerRps).toBe(16);
      expect(out.quotas.perWorkerJupiterPerMinute).toBe(30);
      const row = await a.beatProcess(1);
      expect(row).toMatchObject({ rpsQuota: 16, jupQuotaPerMinute: 30 });
      expect(row!.ageMs).toBeGreaterThanOrEqual(0);
      expect(row!.ageMs).toBeLessThan(2_000);
      expect(await dead.beatProcess(0)).toEqual({ rpsQuota: null, jupQuotaPerMinute: null, ageMs: null });
      const { rows } = await db.query<{ worker_id: string; written: boolean }>(
        "SELECT worker_id, quota_at IS NOT NULL AS written FROM sip_solana.worker ORDER BY worker_id",
      );
      expect(Object.fromEntries(rows.map((r) => [r.worker_id, r.written]))).toEqual({ "sched-1": false, "w-a": true, "w-b": true, "w-dead": false, "w-stopped": false });
    });

    it("follows the row through the beat; a worker ten minutes fast follows it too; two minutes after the scheduler last wrote, the floor", async () => {
      const { scheduler, a } = await fleetOfFour();
      await scheduler.handOutQuotas({ maxWorkers: 4 });
      const sets: number[] = [];
      // This worker's own clock, moved by hand: the follower measures its two minutes on it.
      let clock = Date.now();
      const right = follower(sets, () => clock);
      expect((await right.refresh(a.quotaSource(() => ({ busy: 1 })))).state).toBe("row");
      // THE AGE IS THE DATABASE'S: a worker whose clock runs ten minutes fast still reads a quota written a moment ago.
      const fastSets: number[] = [];
      const fast = follower(fastSets, () => Date.now() + 10 * 60_000);
      expect((await fast.refresh(a.quotaSource(() => ({ busy: 1 })))).state).toBe("row");
      expect([sets, fastSets]).toEqual([
        [8, 16],
        [8, 16],
      ]);
      // THE SCHEDULER GOES QUIET for two minutes and five seconds, while the worker keeps beating (heartbeat_at
      // stays fresh): the database's write ages, and so does this worker's clock. Re-reading the old row every
      // beat never makes it new again.
      const quiet = QUOTA_STALE_MS + 5_000;
      await db.query(`UPDATE sip_solana.worker SET quota_at = quota_at - make_interval(secs => $1) WHERE worker_id = 'w-a'`, [quiet / 1000]);
      clock += quiet;
      const stale = await a.beatProcess(1);
      expect(stale!.ageMs!).toBeGreaterThan(QUOTA_STALE_MS);
      expect(right.apply(stale).state).toBe("floor");
      expect(sets).toEqual([8, 16, 8]);
      // The next hand-out is obeyed again at once.
      await scheduler.handOutQuotas({ maxWorkers: 4 });
      expect((await right.refresh(a.quotaSource(() => ({ busy: 1 })))).state).toBe("row");
      expect(sets).toEqual([8, 16, 8, 16]);
      const { rows } = await db.query<{ fresh: boolean }>("SELECT heartbeat_at > clock_timestamp() - interval '5 seconds' AS fresh FROM sip_solana.worker WHERE worker_id = 'w-a'");
      expect(rows[0]!.fresh).toBe(true);
    });

    it("divides among every live worker when more are alive than r_max (a deploy's overlap): the shares never exceed the budget", async () => {
      await fleetOfFour();
      for (const id of ["w-c", "w-d", "w-e"]) await new DispatchStore(db, id).registerProcess("worker", "next", 2);
      const out = await new DispatchStore(db, "sched-1").handOutQuotas({ maxWorkers: 2 });
      expect(out.workers).toEqual(["w-a", "w-b", "w-c", "w-d", "w-e"]);
      const { rows } = await db.query<{ total: number }>("SELECT sum(rps_quota)::float8 AS total FROM sip_solana.worker WHERE quota_at IS NOT NULL");
      expect(rows[0]!.total).toBeCloseTo(out.quotas.fleetRps - out.quotas.schedulerRps, 4);
    });

    it("a worker leaving as its drain starts: stopped at once with its busy kept, out of the next hand-out, still out after its beats, and its lease its own as before", async () => {
      const { scheduler, a } = await fleetOfFour();
      // w-a HOLDS A VAULT AND SAYS SO: a drain is a job still running.
      await db.query("INSERT INTO sip_solana.vault_work (vault_addr, system) VALUES ('Vau1tLeaving', 'queue')");
      const [held] = await a.claim(1);
      expect(held).toMatchObject({ vault: "Vau1tLeaving", fence: 1n });
      await a.beatProcess(1);
      expect((await scheduler.handOutQuotas({ maxWorkers: 4 })).workers).toEqual(["w-a", "w-b"]);
      const row = async () =>
        (await db.query<{ stopped_at: Date | null; busy: number }>("SELECT stopped_at, busy FROM sip_solana.worker WHERE worker_id = 'w-a'")).rows[0]!;
      const live = async () => (await db.query<{ worker_id: string }>(LIVE_WORKERS_SQL, [WORKER_DEAD_AFTER_MS / 1000])).rows.map((r) => r.worker_id);

      await a.processLeaving();
      const left = await row();
      expect(left.stopped_at).not.toBeNull();
      expect(left.busy).toBe(1);
      // THE HAND-OUT'S OWN STATEMENT NO LONGER NAMES IT, and the next hand-out gives w-b the workers' whole share.
      expect(await live()).toEqual(["w-b"]);
      const next = await scheduler.handOutQuotas({ maxWorkers: 4 });
      expect(next.workers).toEqual(["w-b"]);
      expect(next.quotas.perWorkerRps).toBe(32);

      // ITS DRAIN BEATS ON: the share it last heard, written no more, and a beat never brings the row back.
      expect(await a.beatProcess(1, { jobsLast10Min: 1 })).toMatchObject({ rpsQuota: 16 });
      expect(await row()).toEqual({ stopped_at: left.stopped_at, busy: 1 });
      expect(await live()).toEqual(["w-b"]);
      expect((await scheduler.handOutQuotas({ maxWorkers: 4 })).workers).toEqual(["w-b"]);

      // ITS LEASE IS ITS OWN AS BEFORE: the heartbeat renews it and the release lands.
      expect(await a.heartbeat([held!])).toEqual(new Set(["Vau1tLeaving"]));
      expect(await a.release(held!, "SIGTERM: drained")).toBe(true);
      // THE CLOSE AT THE END zeroes busy.
      await a.processStopped();
      expect((await row()).busy).toBe(0);
      expect((await row()).stopped_at).not.toBeNull();
    });

    it("shows each worker's quota age on the fleet page, and none for a worker never handed one", async () => {
      const { scheduler } = await fleetOfFour();
      await scheduler.handOutQuotas({ maxWorkers: 4 });
      const snapshot = await new PgFleetStore(db).read();
      const ages = Object.fromEntries(snapshot.workers.map((w) => [w.workerId, w.quotaAgeMs]));
      expect(ages["w-a"]).toBeGreaterThanOrEqual(0);
      expect(ages["w-a"]).toBeLessThan(2_000);
      expect(ages["w-dead"]).toBeNull();
      expect(ages["sched-1"]).toBeNull();
    });
  });

  describe("rpc_usage: PgRpcUsageFeed holds InMemoryRpcUsageFeed's contract", () => {
    const PROVIDERS: readonly UsageProvider[] = ["helius-rpc", "helius-rest", "jupiter", "privy", "other"];
    const LANES: readonly RpcLane[] = ["send", "hot", "rest", "sched"];
    const CLASSES: readonly UsageClass[] = ["standard", "archival", "programAccountsV2", "webhookEvent", "jupiter", "privy"];
    const NOW = Date.parse("2026-10-12T12:00:00Z");
    const MONTH_START = Date.parse("2026-10-01T00:00:00Z");
    const key = (row: RpcUsageRow): string => [row.bucket, row.workerId, row.provider, row.lane, row.usageClass].join("|");
    const sorted = (rows: readonly RpcUsageRow[]): RpcUsageRow[] => [...rows].sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0));

    function flushes(seed: number): RpcUsageRow[][] {
      const random = mulberry32(seed);
      const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
      const buckets = Math.floor((NOW - MONTH_START) / USAGE_BUCKET_MS);
      return Array.from({ length: 6 }, () =>
        Array.from({ length: 40 }, () => ({
          // The last two hours, often: the governor's recent window; and the rest of the month.
          bucket: random() < 0.5 ? bucketStart(NOW - Math.floor(random() * 12) * USAGE_BUCKET_MS) : MONTH_START + Math.floor(random() * buckets) * USAGE_BUCKET_MS,
          workerId: pick(["w-a", "w-b", "sched-1"]),
          provider: pick(PROVIDERS),
          lane: pick(LANES),
          usageClass: pick(CLASSES),
          calls: Math.floor(random() * 5_000),
          errors429: Math.floor(random() * 3),
          errorsOther: Math.floor(random() * 2),
        })),
      );
    }

    it.each([1, 2, 3])("adds flush onto flush exactly as memory does — same rows, same windows, same governor verdict (seed %i)", async (seed) => {
      await db.query("TRUNCATE sip_solana.rpc_usage");
      const pgFeed = new PgRpcUsageFeed(db);
      const memory = new InMemoryRpcUsageFeed();
      for (const rows of flushes(seed)) {
        await pgFeed.add(rows);
        await memory.add(rows);
      }
      for (const [from, to] of [
        [MONTH_START, NOW + 1],
        [bucketStart(NOW - 60 * 60_000), NOW + 1],
        [MONTH_START + 3 * USAGE_BUCKET_MS, MONTH_START + 7 * USAGE_BUCKET_MS],
      ] as const) {
        expect(sorted(await pgFeed.read(from, to))).toEqual(sorted(await memory.read(from, to)));
      }
      // THE GOVERNOR'S READ, SUMMED BY POSTGRES: the same numbers as memory's, in a handful of rows.
      const recentFrom = bucketStart(NOW - 60 * 60_000);
      expect(await pgFeed.summarize(MONTH_START, recentFrom, NOW + 1)).toEqual(await memory.summarize(MONTH_START, recentFrom, NOW + 1));
      const summed = await db.query(USAGE_SUMMARY_SQL, [MONTH_START, recentFrom, NOW + 1, ["helius-rpc", "helius-rest"], ["send", "hot", "rest", "sched"]]);
      expect(summed.rows.length).toBeLessThanOrEqual(CLASSES.length * 4);
      expect((await db.query("SELECT count(*)::int AS n FROM sip_solana.rpc_usage")).rows[0].n).toBeGreaterThan(summed.rows.length);
      for (const [archivalCredits, archivalCreditsSource] of [
        [10, "default"],
        [1, "env"],
      ] as const) {
        const over = (feed: InMemoryRpcUsageFeed | PgRpcUsageFeed) =>
          new CreditGovernor({ feed, archivalCredits, archivalCreditsSource, planCreditsPerMonth: 2_000_000, now: () => NOW }).evaluate();
        expect(await over(pgFeed)).toEqual(await over(memory));
      }
    });

    it("takes a collector's flushes, adds them up, keeps them on a failed flush, and prunes by bucket", async () => {
      const collector = new RpcUsageCollector({ workerId: "w-a" });
      const feed = new PgRpcUsageFeed(db);
      collector.asked("hot", "standard", 5, NOW);
      collector.ended("hot", "standard", 429, NOW);
      collector.count("privy", "rest", "privy", 2, NOW);
      expect(await collector.flush(feed)).toEqual({ written: 2 });
      collector.asked("hot", "standard", 3, NOW + 1_000);
      expect(await collector.flush(feed)).toEqual({ written: 1 });
      expect(sorted(await feed.read(MONTH_START, NOW + USAGE_BUCKET_MS))).toEqual([
        { bucket: bucketStart(NOW), workerId: "w-a", provider: "helius-rpc", lane: "hot", usageClass: "standard", calls: 8, errors429: 1, errorsOther: 0 },
        { bucket: bucketStart(NOW), workerId: "w-a", provider: "privy", lane: "rest", usageClass: "privy", calls: 2, errors429: 0, errorsOther: 0 },
      ]);
      // A FEED WHOSE POOL IS GONE: the flush fails and the rows wait for the next beat.
      const gone = pool(1);
      await gone.end();
      collector.asked("send", "standard", 1, NOW);
      expect(await collector.flush(new PgRpcUsageFeed(gone))).toEqual({ failed: true, kept: 1 });
      expect(collector.status()).toMatchObject({ pendingRows: 1, flushFailures: 1 });
      expect(await feed.prune(bucketStart(NOW))).toBe(0);
      expect(await feed.prune(bucketStart(NOW) + 1)).toBe(2);
      expect(await feed.read(MONTH_START, NOW + USAGE_BUCKET_MS)).toEqual([]);
    });
  });

  describe("worker.stats: what a worker's beat writes is what the page serves and what fence-reject pages on", () => {
    it("serves the named counters only, and pages a reject that grew after the first snapshot", async () => {
      const worker = new DispatchStore(db, "w-a");
      await worker.registerProcess("worker", "test", 2);
      await worker.beatProcess(1, { fenceRejects: 0, jobsLast10Min: 3 });
      const fired: Alert[] = [];
      const alerts = new FleetAlerts({ alerter: { fire: (alert) => fired.push(alert), clear: () => undefined }, windowMs: 60_000 });
      const reader = new FleetStatusReader({ source: new PgFleetStore(db), onSnapshot: (snapshot) => alerts.observeSnapshot(snapshot, { acting: true }) });
      expect(await reader.refresh()).toBe(true);
      expect(reader.snapshot()!.workers[0]!.stats).toEqual({ fenceRejects: 0, fenceRejectsLastHour: null, leaseLosses: null, jobsLast10Min: 3, releasedOnSigterm: null });
      expect(fired.filter((alert) => alert.key === FENCE_REJECT_ALERT_KEY)).toEqual([]);
      // A gate refused two sends: the worker's next beat says so, and the next read pages it.
      await worker.beatProcess(1, { fenceRejects: 2, jobsLast10Min: 4, ...({ walletKey: "never written" } as object) });
      // A beat without stats keeps the counters the row has.
      await worker.beatProcess(0);
      expect(await reader.refresh()).toBe(true);
      expect(reader.snapshot()!.workers[0]!.stats).toEqual({ fenceRejects: 2, fenceRejectsLastHour: null, leaseLosses: null, jobsLast10Min: 4, releasedOnSigterm: null });
      expect(fired.filter((alert) => alert.key === FENCE_REJECT_ALERT_KEY).map((alert) => alert.severity)).toEqual(["critical"]);
      const { rows } = await db.query<{ stats: Record<string, unknown> }>("SELECT stats FROM sip_solana.worker WHERE worker_id = 'w-a'");
      expect(rows[0]!.stats).toEqual({ fenceRejects: 2, jobsLast10Min: 4 });
    });
  });

  describe("the bell and the lease: the receiver's write is what CLAIM and COMPLETE read", () => {
    beforeEach(async () => {
      await db.query(
        `INSERT INTO sip_solana.keeper_link (link_addr, wallet_addr, vault_addr, epoch, settlement_nonce, frontier_slot, seen_slot)
         VALUES ('L-owner', 'WalletOfTheOwnersVau1t111111111111111111111', $1, 0, 1, 1, 1),
                ('L-other', 'WalletOfTheOtherVau1t111111111111111111111', $2, 0, 1, 1, 1)`,
        [VAULT, OTHER_VAULT],
      );
      // Both due now and on the queue; the other one waited longer and is in the full-pass lane.
      await db.query(
        `INSERT INTO sip_solana.vault_work (vault_addr, system, lane, priority, due_at) VALUES
           ($1, 'queue', 'safety', 4, clock_timestamp() - interval '1 second'),
           ($2, 'queue', 'full',   3, clock_timestamp() - interval '5 minutes')`,
        [VAULT, OTHER_VAULT],
      );
    });

    it("claims the vault a delivery rang before one that waited longer, and a bell during the job makes it due at once", async () => {
      const store = new PgFleetStore(db);
      const receiver = new FleetReceiver({ store, authorized: () => true, log: () => undefined });
      receiver.accept(Buffer.from(JSON.stringify(fixtures["usdcDepositToVault"])));
      await receiver.idle();
      // THE BELL'S DUE TIME IS AT MOST BELL_DELAY_MS AWAY, NEVER LATER THAN IT WAS: this row was already due.
      const worker = new DispatchStore(db, "w-a");
      const [claimed] = await worker.claim(1);
      expect(claimed).toMatchObject({ vault: VAULT, lane: "bell", fence: 1n });
      // Rung again while the worker holds it: COMPLETE ignores the 10-minute delay the job asked for.
      receiver.accept(Buffer.from(JSON.stringify(fixtures["usdcDepositToVault"])));
      await receiver.idle();
      expect(await worker.complete(claimed!, { rests: true, lane: "safety", streaks: {}, outcome: "IDLE", detail: null, dueInSeconds: 600 })).toBe(true);
      const { rows } = await db.query<{ due_in_s: number }>(
        "SELECT extract(epoch FROM due_at - clock_timestamp())::float8 AS due_in_s FROM sip_solana.vault_work WHERE vault_addr = $1",
        [VAULT],
      );
      expect(rows[0]!.due_in_s).toBeLessThanOrEqual(0);
      expect(BELL_DELAY_MS).toBe(15_000);
    });
  });

  describe("the scheduler's pool from createDispatchPool: one connection for the receiver, the page and the full pass", () => {
    // WHAT THIS CATCHES: a code path that holds the pool's client while it asks
    // the same pool for another would wait on itself until the pool's 5 s
    // connection timeout, and fail — on a pool of one, every such nesting is a
    // deadlock. Everything below is asked at once and must all get through.
    it("serves every statement through its one connection, concurrently asked, and never opens a second", async () => {
      await db.query(
        `INSERT INTO sip_solana.keeper_link (link_addr, wallet_addr, vault_addr, epoch, settlement_nonce, frontier_slot, seen_slot)
         VALUES ('L-owner', 'WalletOfTheOwnersVau1t111111111111111111111', $1, 0, 1, 1, 1)`,
        [VAULT],
      );
      await db.query(`INSERT INTO sip_solana.vault_work (vault_addr, system, lane, priority, due_at) VALUES ($1, 'queue', 'safety', 4, clock_timestamp() + interval '30 minutes')`, [VAULT]);
      const warned: string[] = [];
      const scheduler = createDispatchPool(new Secret(url(), "databaseUrl"), "scheduler", "wiring-test", (message) => warned.push(message));
      pools.push(scheduler);
      expect(scheduler.options.max).toBe(SCHEDULER_POOL_MAX);
      const store = new PgFleetStore(scheduler);
      const receiver = new FleetReceiver({ store, authorized: () => true, log: () => undefined });
      const reader = new FleetStatusReader({ source: store });
      let most = 0;
      const sample = setInterval(() => (most = Math.max(most, scheduler.totalCount)), 1);
      try {
        receiver.accept(Buffer.from(JSON.stringify(fixtures["usdcDepositToVault"])));
        const started = Date.now();
        const [read] = await Promise.all([reader.refresh(), store.requestFullPass("a lost delivery"), receiver.idle(), store.read(), store.read()]);
        expect(read).toBe(true);
        // Well inside the pool's connection timeout: nobody waited on a client that waited on them.
        expect(Date.now() - started).toBeLessThan(4_000);
        expect(await store.takeFullPass()).toBe("a lost delivery");
        expect(await store.takeFullPass()).toBeNull();
      } finally {
        clearInterval(sample);
      }
      expect(most).toBeLessThanOrEqual(1);
      expect(scheduler.totalCount).toBeLessThanOrEqual(1);
      const { rows } = await db.query<{ lane: string }>("SELECT lane FROM sip_solana.vault_work WHERE vault_addr = $1", [VAULT]);
      expect(rows[0]!.lane).toBe("bell");
      expect(receiver.status()).toMatchObject({ deliveries: 1 });
      expect(warned).toEqual([]);
    });
  });
});
