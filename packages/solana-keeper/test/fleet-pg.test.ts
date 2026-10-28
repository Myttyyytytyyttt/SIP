// The receiver's and the fleet page's statements on Postgres 16
// (src/fleet-pg.ts): the bell over the recorded deliveries, the full-pass
// request and its taking under a row lock, and the fleet snapshot read from
// seeded tables (dispatcher ADR §3.10, §3.11, §6.3; failure matrix row 17).
//
// RUN ONLY WITH A THROWAWAY DATABASE ON THE LOOPBACK, as
// test/carry-store-pg.test.ts: KEEPER_TEST_PG_URL names a server (a
// `docker run --rm postgres:16-alpine` with a generated password); a host that
// is not the loopback is refused; each run creates its own databases and drops
// them at the end. Without the variable — the Docker build, a plain
// `pnpm test` — the block is skipped and says why in its name.
//
// THE TABLES ARE THE SCHEMA FILE'S, AND ONLY ITS: sql/sip_solana.sql with Q1's
// dispatcher section, CHECKs and indexes included. (Before the merge a fixture
// with the ADR's DDL stood in for Q1's tables; it is gone, so a statement here
// that Q1's tables refuse fails this file.)

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Alert } from "../src/alerts.js";
import { DispatchStore } from "../src/dispatch-store.js";
import {
  FleetAlerts,
  LEASE_EXPIRED_ALERT_KEY,
  LEGACY_ORPHANED_ALERT_KEY,
  QUEUE_LAG_ALERT_KEY,
  SCHEDULER_STALE_ALERT_KEY,
  SchedulerStaleWatch,
  vaultParkedKey,
  vaultUnservedKey,
} from "../src/fleet-alerts.js";
import { FLEET_COLUMNS, FLEET_SNAPSHOT_SQL, PgFleetStore, TAKE_FULL_PASS_SQL, missingFleetColumns, parseFleetSnapshot } from "../src/fleet-pg.js";
import { BELL_DELAY_MS, FleetReceiver, readDelivery, type FleetBellStore } from "../src/fleet-receiver.js";
import { FleetStatusReader, VAULTS_LISTED, VAULT_DETAIL_CHARS, VAULT_DETAIL_READ_CHARS, samplePool } from "../src/fleet-status.js";
import { DRAIN_SQL } from "../src/handover.js";
import { PgSchedulerStore } from "../src/scheduler-pg.js";

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
const signatureOf = (name: string): string => (fixtures[name]![0] as { transaction: { signatures: string[] } }).transaction.signatures[0]!;

/** The owner's wallet and vault (test/doorbell.test.ts), and the two halves no delivery carries. */
const WALLET = "9QX53J3Kbs8ogQirZq5iN11rucZAvgF4EKWw98QAkUSe";
const VAULT = "EFXK995PV49Qz8xPSYMEUDBU5AKRR466JkgsfuGak5iU";
const VAULT_OF_WALLET = "VauLtOfTheOwnersWa11et1111111111111111111111";
const WALLET_OF_VAULT = "Wa11etLinkedToTheOwnersVau1t1111111111111111";

describe.skipIf(!usable)("the fleet's statements on Postgres 16 (needs KEEPER_TEST_PG_URL on the loopback)", () => {
  const stamp = `${process.pid}_${Date.now()}`;
  const database = `keeper_fleet_${stamp}`;
  const bare = `keeper_fleet_bare_${stamp}`;
  let admin: pg.Pool;
  let db: pg.Pool;
  const pools: pg.Pool[] = [];
  const urlFor = (name: string): string => {
    const url = new URL(URL_RAW!);
    url.pathname = `/${name}`;
    return url.toString();
  };
  const pool = (name = database, max = 2): pg.Pool => {
    const opened = new pg.Pool({ connectionString: urlFor(name), max });
    opened.on("error", () => undefined);
    pools.push(opened);
    return opened;
  };

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: URL_RAW!, max: 2 });
    admin.on("error", () => undefined);
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.query(`CREATE DATABASE ${bare}`);
    db = pool(database, 4);
    await db.query(SCHEMA_SQL);
  });

  afterAll(async () => {
    for (const opened of pools) await opened.end().catch(() => undefined);
    if (admin !== undefined) {
      for (const name of [database, bare]) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined);
      await admin.end();
    }
  });

  /** Two links that tell a wallet match from a vault match, a third that is gone, and a queue row for each vault, due in 30 min and resting. */
  async function seedLinks(): Promise<void> {
    await db.query("TRUNCATE sip_solana.keeper_link, sip_solana.vault_work, sip_solana.send_intent, sip_solana.fleet, sip_solana.worker");
    const link = (addr: string, wallet: string, vault: string, gone: boolean) =>
      db.query(
        `INSERT INTO sip_solana.keeper_link (link_addr, wallet_addr, vault_addr, epoch, settlement_nonce, frontier_slot, seen_slot, seen_at, gone_at)
         VALUES ($1, $2, $3, 0, 1, 1, 1, clock_timestamp(), CASE WHEN $4 THEN clock_timestamp() END)`,
        [addr, wallet, vault, gone],
      );
    await link("L1", WALLET, VAULT_OF_WALLET, false);
    await link("L2", WALLET_OF_VAULT, VAULT, false);
    await link("L3", WALLET, "VaultOfAGoneLink111111111111111111111111111", true);
    for (const vault of [VAULT_OF_WALLET, VAULT, "VaultOfAGoneLink111111111111111111111111111"]) {
      await db.query(
        `INSERT INTO sip_solana.vault_work (vault_addr, system, lane, priority, due_at, rests)
         VALUES ($1, 'queue', 'safety', 4, clock_timestamp() + interval '30 minutes', true)`,
        [vault],
      );
    }
  }

  const rowOf = async (vault: string) =>
    (
      await db.query<{ lane: string; priority: number; rests: boolean; rung: boolean; delay_s: string | null; due_in_s: string }>(
        `SELECT lane, priority, rests, bell_at IS NOT NULL AS rung,
                extract(epoch FROM due_at - bell_at)::text AS delay_s,
                extract(epoch FROM due_at - clock_timestamp())::text AS due_in_s
           FROM sip_solana.vault_work WHERE vault_addr = $1`,
        [vault],
      )
    ).rows[0]!;

  describe("the columns", () => {
    it("are all there over the schema file alone, and a database without them is told which by name", async () => {
      expect(await missingFleetColumns(db)).toEqual([]);
      const thin = pool(bare, 1);
      await thin.query("CREATE SCHEMA IF NOT EXISTS sip_solana; CREATE TABLE IF NOT EXISTS sip_solana.vault_work (vault_addr text PRIMARY KEY)");
      const missing = await missingFleetColumns(thin);
      expect(missing).toContain("vault_work.bell_at");
      expect(missing).toContain("fleet.full_pass_reason");
      expect(missing).not.toContain("vault_work.vault_addr");
      const named = Object.entries(FLEET_COLUMNS).reduce((n, [, columns]) => n + columns.length, 0);
      expect(missing).toHaveLength(named - 1);
    });
  });

  describe("the bell", () => {
    beforeEach(seedLinks);

    it("rings exactly the vaults of the live links each recorded delivery touched, and no gone link's", async () => {
      const store = new PgFleetStore(db);
      const cases: [string, string[]][] = [
        ["usdcDepositToVault", [VAULT]],
        ["axiomTradeV1", [VAULT_OF_WALLET]],
        ["keeperSettle", [VAULT, VAULT_OF_WALLET]],
        ["solDepositToVault", [VAULT]],
        ["keeperConvertV0", [VAULT]],
      ];
      for (const [name, expected] of cases) {
        await seedLinks();
        const delivery = readDelivery(JSON.stringify(fixtures[name]));
        const wrote = await store.ring({ addresses: delivery.addresses, signatures: delivery.signatures, bellDelayMs: BELL_DELAY_MS });
        expect(wrote.vaults, name).toBe(expected.length);
        const rung = (await db.query<{ vault_addr: string }>("SELECT vault_addr FROM sip_solana.vault_work WHERE bell_at IS NOT NULL ORDER BY vault_addr")).rows.map(
          (row) => row.vault_addr,
        );
        expect(rung, name).toEqual([...expected].sort());
        for (const vault of expected) {
          const row = await rowOf(vault);
          expect(row.lane, name).toBe("bell");
          expect(row.priority, name).toBe(0);
          // A BELL IS SOMETHING MOVING: the vault no longer rests on "nothing has".
          expect(row.rests, name).toBe(false);
          expect(Number(row.delay_s), name).toBe(BELL_DELAY_MS / 1000);
        }
      }
    });

    it("never makes a vault due later than it already was, and rings a vault a worker holds", async () => {
      const store = new PgFleetStore(db);
      await db.query(
        `UPDATE sip_solana.vault_work SET due_at = clock_timestamp() - interval '5 seconds', holder = 'w1', fence = 3,
                lease_until = clock_timestamp() + interval '40 seconds', claimed_at = clock_timestamp() - interval '2 seconds'
          WHERE vault_addr = $1`,
        [VAULT],
      );
      await store.ring({ addresses: [VAULT], signatures: [], bellDelayMs: BELL_DELAY_MS });
      const row = await rowOf(VAULT);
      expect(row.rung).toBe(true);
      expect(Number(row.due_in_s)).toBeLessThan(0);
      // COMPLETE's own rule then makes it due the moment the job ends ([QUEUE] §2.4): bell_at > claimed_at.
      const { rows } = await db.query<{ after: boolean }>("SELECT bell_at > claimed_at AS after FROM sip_solana.vault_work WHERE vault_addr = $1", [VAULT]);
      expect(rows[0]!.after).toBe(true);
    });

    it("marks the keeper's own settle echoed once, and leaves an intent the delivery did not carry alone", async () => {
      const store = new PgFleetStore(db);
      const intent = (signature: string) =>
        db.query(
          `INSERT INTO sip_solana.send_intent (vault_addr, link_addr, kind, fence, worker_id, blockhash, last_valid_block_height, signature, state, resolved_at)
           VALUES ($1, 'L2', 'settle', 1, 'w1', 'bh', 100, $2, 'landed', clock_timestamp())`,
          [VAULT, signature],
        );
      await intent(signatureOf("keeperSettle"));
      await intent("AnotherSignatureTheDeliveryDidNotCarry");
      const delivery = readDelivery(JSON.stringify(fixtures["keeperSettle"]));
      expect((await store.ring({ addresses: delivery.addresses, signatures: delivery.signatures, bellDelayMs: BELL_DELAY_MS })).echoes).toBe(1);
      expect((await store.ring({ addresses: delivery.addresses, signatures: delivery.signatures, bellDelayMs: BELL_DELAY_MS })).echoes).toBe(0);
      const { rows } = await db.query<{ signature: string; echoed: boolean }>(
        "SELECT signature, echoed_at IS NOT NULL AS echoed FROM sip_solana.send_intent",
      );
      expect(Object.fromEntries(rows.map((row) => [row.signature, row.echoed]))).toEqual({
        AnotherSignatureTheDeliveryDidNotCarry: false,
        [signatureOf("keeperSettle")]: true,
      });
    });

    it("receiver-any-replica: a bell from replica B makes the vault due", async () => {
      // Two scheduler replicas, each with its own pool and receiver; only A would
      // hold the lock. The delivery lands on B.
      const log = () => undefined;
      const replicaA = new FleetReceiver({ store: new PgFleetStore(pool()), authorized: () => true, log });
      const replicaB = new FleetReceiver({ store: new PgFleetStore(pool()), authorized: () => true, log });
      replicaB.accept(Buffer.from(JSON.stringify(fixtures["usdcDepositToVault"])));
      await replicaB.idle();
      expect(replicaA.status().deliveries).toBe(0);
      const row = await rowOf(VAULT);
      expect(row.lane).toBe("bell");
      // DUE WITHIN THE BELL DELAY, where the safety rotation had it 30 minutes out.
      expect(Number(row.delay_s)).toBe(BELL_DELAY_MS / 1000);
      expect(Number(row.due_in_s)).toBeLessThanOrEqual(BELL_DELAY_MS / 1000);
      expect(replicaB.status().vaultsRung).toBe(1);

      // AND THE ADR'S CLAIM TAKES IT FIRST once it is due: a bell with no delay
      // against a safety vault that has been due for a minute.
      await db.query(`UPDATE sip_solana.vault_work SET due_at = clock_timestamp() - interval '1 minute' WHERE vault_addr = $1`, [VAULT_OF_WALLET]);
      await new PgFleetStore(db).ring({ addresses: [VAULT], signatures: [], bellDelayMs: 0 });
      const claimed = await db.query<{ vault_addr: string; fence: string }>(
        `WITH c AS (
           SELECT vault_addr FROM sip_solana.vault_work
            WHERE system = 'queue' AND parked_reason IS NULL AND due_at <= clock_timestamp()
              AND (holder IS NULL OR lease_until < clock_timestamp())
            ORDER BY priority, COALESCE(last_holder = $1, false) DESC, due_at
            LIMIT $2 FOR UPDATE SKIP LOCKED)
         UPDATE sip_solana.vault_work w
            SET holder = $1, fence = w.fence + 1, claimed_at = clock_timestamp(),
                lease_until = clock_timestamp() + interval '45 seconds', attempts = w.attempts + 1
           FROM c WHERE w.vault_addr = c.vault_addr
         RETURNING w.vault_addr, w.fence`,
        ["worker-1", 1],
      );
      expect(claimed.rows.map((row) => row.vault_addr)).toEqual([VAULT]);
    });
  });

  describe("the full pass", () => {
    beforeEach(seedLinks);

    it("is asked for when a bell write fails, kept first-come, and taken by the scheduler once", async () => {
      const store = new PgFleetStore(db);
      const failingBells: FleetBellStore = {
        ring: async () => {
          throw new Error("canceling statement due to statement timeout");
        },
        requestFullPass: (reason) => store.requestFullPass(reason),
      };
      const receiver = new FleetReceiver({ store: failingBells, authorized: () => true, log: () => undefined });
      receiver.accept(Buffer.from(JSON.stringify(fixtures["axiomTradeV1"])));
      await receiver.idle();
      await store.requestFullPass("a second reason, while the first is pending");
      const reason = await store.takeFullPass();
      expect(reason).toMatch(/^a bell write failed \(Error: canceling statement due to statement timeout\)/);
      expect(await store.takeFullPass()).toBeNull();
    });

    it("loses no request a receiver writes while the scheduler is taking one: the receiver waits on the row lock and writes into the cleared row", async () => {
      const store = new PgFleetStore(db);
      await store.requestFullPass("first");
      const scheduler = await db.connect();
      try {
        await scheduler.query("BEGIN");
        const taken = await scheduler.query<{ reason: string }>(TAKE_FULL_PASS_SQL);
        expect(taken.rows[0]!.reason).toBe("first");
        let written = false;
        const receiverWrite = new PgFleetStore(pool()).requestFullPass("second, during the take").then(() => {
          written = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(written, "the receiver waits for the scheduler's commit").toBe(false);
        await scheduler.query("COMMIT");
        await receiverWrite;
      } finally {
        scheduler.release();
      }
      expect(await store.takeFullPass()).toBe("second, during the take");
    });

    it("takes one pass between two schedulers taking at once (a split brain), not two: the second reads the row only once it holds it", async () => {
      const store = new PgFleetStore(db);
      await store.requestFullPass("first");
      const s1 = await db.connect();
      try {
        await s1.query("BEGIN");
        expect((await s1.query<{ reason: string }>(TAKE_FULL_PASS_SQL)).rows[0]!.reason).toBe("first");
        const s2 = new PgFleetStore(pool()).takeFullPass();
        await new Promise((resolve) => setTimeout(resolve, 250));
        await s1.query("COMMIT");
        // UNLOCKED, S2 WOULD RETURN "first": its snapshot predates S1's commit,
        // and it would run the same full pass again.
        expect(await s2).toBeNull();
      } finally {
        s1.release();
      }
      expect(await store.takeFullPass()).toBeNull();
    });

    it("answers a request written while two schedulers take at once: it is taken by one of them, or left for the next tick", async () => {
      const store = new PgFleetStore(db);
      await store.requestFullPass("first");
      const s1 = await db.connect();
      const wait = () => new Promise((resolve) => setTimeout(resolve, 250));
      let answered: (string | null)[] = [];
      try {
        await s1.query("BEGIN");
        expect((await s1.query<{ reason: string }>(TAKE_FULL_PASS_SQL)).rows[0]!.reason).toBe("first");
        const receiverWrite = new PgFleetStore(pool()).requestFullPass("second, during the take");
        await wait();
        const s2 = new PgFleetStore(pool()).takeFullPass();
        await wait();
        await s1.query("COMMIT");
        await receiverWrite;
        answered = [await s2];
      } finally {
        s1.release();
      }
      answered.push(await store.takeFullPass());
      expect(answered).toContain("second, during the take");
      expect(await store.takeFullPass()).toBeNull();
    });
  });

  describe("the snapshot", () => {
    beforeEach(async () => {
      await db.query(
        "TRUNCATE sip_solana.keeper_link, sip_solana.vault_work, sip_solana.send_intent, sip_solana.fleet, sip_solana.worker, sip_solana.loss_carry, sip_solana.legacy_process",
      );
      await db.query(
        `INSERT INTO sip_solana.fleet (id, scheduler_id, tick_at, discovery_ok_at)
         VALUES (true, 'sched-a', clock_timestamp() - interval '11 minutes', clock_timestamp() - interval '1 minute')`,
      );
      await db.query(
        `INSERT INTO sip_solana.worker (worker_id, kind, version, started_at, heartbeat_at, slots, busy, stats, stopped_at) VALUES
           ('w-alive', 'worker', 'abc', clock_timestamp() - interval '1 hour', clock_timestamp() - interval '5 seconds', 2, 1, '{"fenceRejects": 1, "jobsLast10Min": 4}', NULL),
           ('w-dead',  'worker', 'abc', clock_timestamp() - interval '2 hours', clock_timestamp() - interval '3 minutes', 2, 0, '{}', NULL),
           ('w-gone',  'worker', 'old', clock_timestamp() - interval '9 hours', clock_timestamp() - interval '2 hours', 2, 0, '{}', clock_timestamp() - interval '2 hours')`,
      );
      await db.query(
        `INSERT INTO sip_solana.vault_work (vault_addr, system, lane, priority, due_at, holder, fence, lease_until, claimed_at, attempts, parked_reason, last_outcome) VALUES
           ('Q1-bell',      'queue',    'bell',   0, clock_timestamp() - interval '10 seconds',  NULL,      2, NULL, NULL, 0, NULL, 'SETTLED'),
           ('Q2-safety',    'queue',    'safety', 4, clock_timestamp() - interval '150 seconds', NULL,      5, NULL, NULL, 0, NULL, NULL),
           ('Q3-held',      'queue',    'busy',   1, clock_timestamp() - interval '25 seconds',  'w-alive', 4, clock_timestamp() + interval '30 seconds', clock_timestamp() - interval '20 seconds', 1, NULL, NULL),
           ('Q4-lapsed',    'queue',    'busy',   1, clock_timestamp() - interval '70 seconds',  'w-dead',  7, clock_timestamp() - interval '5 seconds',  clock_timestamp() - interval '60 seconds', 1, NULL, NULL),
           ('Q5-takeover',  'queue',    'retry',  1, clock_timestamp() - interval '8 minutes',   'w-alive', 9, clock_timestamp() + interval '40 seconds', clock_timestamp() - interval '7 minutes', 3, NULL, NULL),
           ('Q6-parked',    'queue',    'retry',  1, clock_timestamp() - interval '1 hour',      NULL,      3, NULL, NULL, 5, '5 lapsed leases in a row', 'RETRY'),
           ('L1-legacy',    'legacy',   'new',    2, clock_timestamp() - interval '1 hour',      NULL,      0, NULL, NULL, 0, NULL, NULL),
           ('D1-draining',  'draining', 'new',    2, clock_timestamp() - interval '1 hour',      NULL,      0, NULL, NULL, 0, NULL, NULL)`,
      );
      await db.query(
        `INSERT INTO sip_solana.send_intent (vault_addr, link_addr, kind, fence, worker_id, blockhash, last_valid_block_height, signature, state, created_at, resolved_at, echoed_at) VALUES
           ('Q3-held',  NULL, 'wrap',   4, 'w-alive', 'bh', 1, 'sig-open',     'intent', clock_timestamp() - interval '40 seconds', NULL, NULL),
           ('Q1-bell',  'L1', 'settle', 2, 'w-alive', 'bh', 1, 'sig-unechoed', 'landed', clock_timestamp() - interval '7 minutes',  clock_timestamp() - interval '6 minutes', NULL),
           ('Q1-bell',  'L1', 'settle', 3, 'w-alive', 'bh', 1, 'sig-just-landed', 'landed', clock_timestamp() - interval '2 minutes', clock_timestamp() - interval '1 minute', NULL),
           ('Q1-bell',  'L1', 'settle', 1, 'w-alive', 'bh', 1, 'sig-echoed',   'landed', clock_timestamp() - interval '9 minutes',  clock_timestamp() - interval '8 minutes', clock_timestamp() - interval '8 minutes'),
           ('Q2-safety', NULL, 'invest', 5, 'w-dead',  'bh', 1, NULL,           'failed', clock_timestamp() - interval '3 minutes',  clock_timestamp() - interval '2 minutes', NULL),
           ('Q2-safety', NULL, 'invest', 4, 'w-dead',  'bh', 1, 'sig-old',      'landed', clock_timestamp() - interval '3 hours',    clock_timestamp() - interval '3 hours', NULL)`,
      );
      await db.query(
        `INSERT INTO sip_solana.loss_carry (link_addr, epoch, settlement_nonce, frontier_slot, loss_lamports, wallet_signed_tx_count, valid_until_slot, written_by)
         VALUES ('L1', 0, 1, 1, 5, 1, 10, 'test')`,
      );
    });

    it("reads every block of the page in one statement, by the database's clock", async () => {
      const snapshot = await new PgFleetStore(db).read();
      expect(Math.abs(snapshot.scheduler!.tickAgeMs! - 11 * 60_000)).toBeLessThan(5_000);
      expect(snapshot.scheduler!.schedulerId).toBe("sched-a");
      // Stopped two hours ago: off the page. Three minutes without a heartbeat: dead. Oldest first.
      expect(snapshot.workers.map((w) => [w.workerId, w.dead, w.leases])).toEqual([
        ["w-dead", true, 0],
        ["w-alive", false, 2],
      ]);
      expect(snapshot.workers[1]!.stats).toEqual({ fenceRejects: 1, fenceRejectsLastHour: null, leaseLosses: null, jobsLast10Min: 4, releasedOnSigterm: null });
      expect(snapshot.queue.bySystem).toEqual({ queue: 6, legacy: 1, draining: 1 });
      // CLAIMABLE ONLY: queue, not parked, due, free or lapsed. Q4's lapsed lease is claimable; Q3 and Q5 are held.
      expect(Object.fromEntries(Object.entries(snapshot.queue.lanes).map(([lane, lag]) => [lane, lag.due]))).toEqual({ bell: 1, busy: 1, safety: 1 });
      expect(snapshot.queue.due).toBe(3);
      expect(Math.abs(snapshot.queue.oldestDueMs! - 150_000)).toBeLessThan(5_000);
      expect(snapshot.queue.leases).toMatchObject({ held: 2, expired: 1, overCeiling: 1, takeovers: 1 });
      expect(snapshot.queue.parked).toEqual({ count: 1, vaults: [{ vault: "Q6-parked", reason: "5 lapsed leases in a row", attempts: 5, system: "queue" }] });
      expect(snapshot.queue.outcomes).toEqual({ none: 4, SETTLED: 1, RETRY: 1 });
      expect(snapshot.expiries).toEqual([
        { vault: "Q4-lapsed", fence: 7 },
        { vault: "Q5-takeover", fence: 8 },
        { vault: "Q5-takeover", fence: 7 },
      ]);
      expect(snapshot.sends.open).toBe(1);
      expect(Math.abs(snapshot.sends.oldestOpenAgeMs! - 40_000)).toBeLessThan(5_000);
      // Landed, never heard, five minutes past its landing, inside the hour: one. The one that landed a minute ago is
      // still inside the echo deadline, and the three-hour-old one is not looked at.
      expect(snapshot.sends.unechoed).toBe(1);
      expect(snapshot.sends.lastHour).toEqual([
        { kind: "invest", state: "failed", count: 1 },
        { kind: "settle", state: "landed", count: 3 },
        { kind: "wrap", state: "intent", count: 1 },
      ]);
      expect(snapshot.carries.pending).toBe(1);
    });

    it("pages what the snapshot shows, as the acting replica: three lapsed leases, a queue past two windows, a scheduler 11 minutes quiet, a vault draining an hour, a vault parked", async () => {
      const fired: Alert[] = [];
      const alerts = new FleetAlerts({ alerter: { fire: (alert) => fired.push(alert), clear: () => undefined }, windowMs: 60_000 });
      const reader = new FleetStatusReader({ source: new PgFleetStore(db), onSnapshot: (snapshot) => alerts.observeSnapshot(snapshot, { acting: true }) });
      expect(await reader.refresh()).toBe(true);
      alerts.observePools([samplePool(db)]);
      expect(fired.map((alert) => `${alert.key}:${alert.severity}`).sort()).toEqual([
        `${LEASE_EXPIRED_ALERT_KEY}:critical`,
        `${QUEUE_LAG_ALERT_KEY}:critical`,
        `${SCHEDULER_STALE_ALERT_KEY}:critical`,
        `${vaultParkedKey("Q6-parked")}:critical`,
        `${vaultUnservedKey("D1-draining")}:critical`,
      ]);
      expect(alerts.status().pg?.saturatedStreak).toBe(0);
    });

    it("counts the legacy keepers' side — the 'legacy' rows a live link names, where new vaults go, the receipts not gone and those read in 15 min — and legacy-orphaned pages it", async () => {
      // L1-legacy (seeded) gets a live link; L2 two; L3's only link is gone, so nobody is left to serve there. Q1 is the queue's.
      await db.query("INSERT INTO sip_solana.vault_work (vault_addr, system) VALUES ('L2-legacy', 'legacy'), ('L3-legacy-unlinked', 'legacy')");
      await db.query(
        `INSERT INTO sip_solana.keeper_link (link_addr, wallet_addr, vault_addr, epoch, settlement_nonce, frontier_slot, seen_slot, gone_at) VALUES
           ('LK1', 'W1', 'L1-legacy', 0, 1, 1, 1, NULL),
           ('LK2', 'W2', 'L2-legacy', 0, 1, 1, 1, NULL),
           ('LK2b', 'W2b', 'L2-legacy', 0, 1, 1, 1, NULL),
           ('LK3', 'W3', 'L3-legacy-unlinked', 0, 1, 1, 1, clock_timestamp()),
           ('LK4', 'W4', 'Q1-bell', 0, 1, 1, 1, NULL)`,
      );
      const read = async () => (await new PgFleetStore(db).read()).legacy!;
      // NO RECEIPT EVER: none counted, and no age rather than an age of 0. The fleet row's default sends new vaults legacy.
      expect(await read()).toEqual({ vaults: 2, newVaultSystem: "legacy", receipts: 0, fresh: 0, lastReadAgeMs: null, roles: {} });

      // ONE KEEPER UP, ONE 20 MINUTES QUIET, ONE MARKED GONE — the gone one read last, and still counts for the age.
      await db.query(
        `INSERT INTO sip_solana.legacy_process (process_id, role, dispatch, live, read_at, absent_is, gone_at) VALUES
           ('p-up',    'profit', 'on', true, clock_timestamp() - interval '2 minutes',  'legacy', NULL),
           ('v-quiet', 'volume', 'on', true, clock_timestamp() - interval '20 minutes', 'legacy', NULL),
           ('p-gone',  'profit', 'on', true, clock_timestamp() - interval '1 minute',   'legacy', clock_timestamp())`,
      );
      const up = await read();
      expect(up).toMatchObject({ vaults: 2, newVaultSystem: "legacy", receipts: 2, fresh: 1 });
      expect(Math.abs(up.lastReadAgeMs! - 60_000)).toBeLessThan(5_000);
      // PER ROLE: acting receipts not gone and read in 15 min; the role's newest read counts a gone row too.
      expect(Object.keys(up.roles!).sort()).toEqual(["profit", "volume"]);
      expect([up.roles!["profit"]!.acting, up.roles!["volume"]!.acting]).toEqual([1, 0]);
      expect(Math.abs(up.roles!["profit"]!.lastReadAgeMs! - 60_000)).toBeLessThan(5_000);
      expect(Math.abs(up.roles!["volume"]!.lastReadAgeMs! - 20 * 60_000)).toBeLessThan(5_000);

      // THE PROFIT KEEPER CRASH-LOOPS WHILE THE VOLUME KEEPER STILL SWEEPS: one fresh receipt, and still nobody buys.
      // A new profit container that reads without acting (its carry store not ready) does not count either.
      await db.query("UPDATE sip_solana.legacy_process SET read_at = clock_timestamp() - interval '20 minutes' WHERE process_id = 'p-up'");
      await db.query("UPDATE sip_solana.legacy_process SET read_at = clock_timestamp() - interval '25 minutes' WHERE process_id = 'p-gone'");
      await db.query("UPDATE sip_solana.legacy_process SET read_at = clock_timestamp() - interval '30 seconds' WHERE process_id = 'v-quiet'");
      await db.query(
        `INSERT INTO sip_solana.legacy_process (process_id, role, dispatch, live, read_at, absent_is) VALUES
           ('p-dry', 'profit', 'on', false, clock_timestamp() - interval '10 seconds', 'legacy')`,
      );
      const profitDown = await read();
      expect(profitDown).toMatchObject({ receipts: 3, fresh: 2 });
      expect([profitDown.roles!["profit"]!.acting, profitDown.roles!["volume"]!.acting]).toEqual([0, 1]);
      const roleFired: Alert[] = [];
      const roleAlerts = new FleetAlerts({ alerter: { fire: (alert) => roleFired.push(alert), clear: () => undefined }, windowMs: 60_000, legacy: { retired: false } });
      const roleReader = new FleetStatusReader({ source: new PgFleetStore(db), onSnapshot: (snapshot) => roleAlerts.observeSnapshot(snapshot, { acting: true }) });
      expect(await roleReader.refresh()).toBe(true);
      const profitPage = roleFired.filter((alert) => alert.key === LEGACY_ORPHANED_ALERT_KEY);
      expect(profitPage.map((alert) => alert.severity)).toEqual(["warn"]);
      expect(profitPage[0]!.detail).toContain("the profit keeper (sip-solana-keeper) has not read while acting in 15 min");
      expect(profitPage[0]!.detail).toContain("the volume keeper (sip-solana-volume-keeper) still acts");
      // THE ROLE'S CLOCK IS ITS LAST READ WHILE ACTING — p-up's, 20 min — not p-dry's 10 s:
      // a container reading without acting does none of the role's work.
      expect(Math.abs(profitDown.roles!["profit"]!.lastReadAgeMs! - 20 * 60_000)).toBeLessThan(5_000);
      expect(profitPage[0]!.detail).toContain("its last read while acting was 20 min ago");
      // 35 MIN SINCE THE LAST ACTING READ, SEEN BY A SCHEDULER THAT JUST RESTARTED (observedForMs 0): it
      // pages. Timed from p-dry's 10 s it fell back to a warn after every restart, and paged 45 min in.
      await db.query("UPDATE sip_solana.legacy_process SET read_at = clock_timestamp() - interval '35 minutes' WHERE process_id = 'p-up'");
      await db.query("UPDATE sip_solana.legacy_process SET read_at = clock_timestamp() - interval '40 minutes' WHERE process_id = 'p-gone'");
      const restartedFired: Alert[] = [];
      const restarted = new FleetAlerts({ alerter: { fire: (alert) => restartedFired.push(alert), clear: () => undefined }, windowMs: 60_000, legacy: { retired: false } });
      const restartedReader = new FleetStatusReader({ source: new PgFleetStore(db), onSnapshot: (snapshot) => restarted.observeSnapshot(snapshot, { acting: true }) });
      expect(await restartedReader.refresh()).toBe(true);
      expect(restartedFired.filter((alert) => alert.key === LEGACY_ORPHANED_ALERT_KEY).map((alert) => alert.severity)).toEqual(["critical"]);
      await db.query("DELETE FROM sip_solana.legacy_process WHERE process_id = 'p-dry'");

      // THE KEEPERS STOP: every receipt goes quiet, the newest 40 minutes ago. Not declared retired, it pages on their silence.
      await db.query("UPDATE sip_solana.legacy_process SET read_at = clock_timestamp() - interval '40 minutes' WHERE process_id = 'p-gone'");
      await db.query("UPDATE sip_solana.legacy_process SET read_at = clock_timestamp() - interval '50 minutes' WHERE process_id <> 'p-gone'");
      const down = await read();
      expect(down).toMatchObject({ receipts: 2, fresh: 0 });
      expect(Math.abs(down.lastReadAgeMs! - 40 * 60_000)).toBeLessThan(5_000);
      const fired: Alert[] = [];
      const alerts = new FleetAlerts({ alerter: { fire: (alert) => fired.push(alert), clear: () => undefined }, windowMs: 60_000, legacy: { retired: false } });
      const reader = new FleetStatusReader({ source: new PgFleetStore(db), onSnapshot: (snapshot) => alerts.observeSnapshot(snapshot, { acting: true }) });
      expect(await reader.refresh()).toBe(true);
      const page = fired.filter((alert) => alert.key === LEGACY_ORPHANED_ALERT_KEY);
      expect(page.map((alert) => alert.severity)).toEqual(["critical"]);
      expect(page[0]!.detail).toContain("2 vaults with a live link are still 'legacy'");

      // traspasar-todos AND nuevos-a-la-cola: nothing legacy with a live link, nothing new goes there.
      await db.query("UPDATE sip_solana.vault_work SET system = 'queue' WHERE vault_addr IN ('L1-legacy', 'L2-legacy')");
      await db.query("UPDATE sip_solana.fleet SET new_vault_system = 'queue'");
      expect(await read()).toMatchObject({ vaults: 0, newVaultSystem: "queue" });
      expect(await reader.refresh()).toBe(true);
      expect(alerts.status().firing).not.toContain(LEGACY_ORPHANED_ALERT_KEY);
    });

    it("counts a shadow world's unresolved intents as open, its resolved ones not, however old they are", async () => {
      // Under SIP_SOLANA_DISPATCH=shadow every intent is a 'shadow' row and stays one when resolved (Q1): only
      // resolved_at says which are open. One opened two hours ago is outside the last hour and still open.
      await db.query(
        `INSERT INTO sip_solana.send_intent (vault_addr, kind, fence, worker_id, blockhash, last_valid_block_height, state, created_at, resolved_at) VALUES
           ('Q4-lapsed', 'wrap',   7, 'w-dead',  'bh', 1, 'shadow', clock_timestamp() - interval '2 hours',   NULL),
           ('Q5-takeover', 'invest', 9, 'w-alive', 'bh', 1, 'shadow', clock_timestamp() - interval '5 minutes', NULL),
           ('Q5-takeover', 'invest', 8, 'w-alive', 'bh', 1, 'shadow', clock_timestamp() - interval '9 minutes', clock_timestamp() - interval '8 minutes')`,
      );
      const { sends } = await new PgFleetStore(db).read();
      expect(sends.open).toBe(3);
      expect(Math.abs(sends.oldestOpenAgeMs! - 2 * 3_600_000)).toBeLessThan(5_000);
      expect(sends.lastHour).toContainEqual({ kind: "invest", state: "shadow", count: 2 });
    });

    it("reads send_intent through the schema's indexes: the open ones and the last hour, never a scan of 35 days", async () => {
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        // Scans are only ever a choice on ten rows; forbidden, the plan shows whether an index path exists at all.
        await client.query("SET LOCAL enable_seqscan = off");
        const plan = (await client.query<{ "QUERY PLAN": string }>(`EXPLAIN ${FLEET_SNAPSHOT_SQL}`, [360, 50, 300, VAULTS_LISTED, VAULT_DETAIL_READ_CHARS])).rows.map((row) => row["QUERY PLAN"]).join("\n");
        expect(plan).toMatch(/Index (Only )?Scan using send_intent_(open|created)|Bitmap Index Scan on send_intent_(open|created)/);
        expect(plan).not.toMatch(/Seq Scan on send_intent/);
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    });

    it("lists every vault_work row — the unserved first, then by address — with its detail scrubbed before it is cut, and its streaks", async () => {
      await db.query(
        `UPDATE sip_solana.vault_work SET skim_mode = 0, last_detail = repeat('d', 300), last_done_at = clock_timestamp() - interval '1 minute',
                streaks = '{"settleRetries": {"9QX53J3Kbs8ogQirZq5iN11rucZAvgF4EKWw98QAkUSe": 2}, "investRefused": 1, "secret": "never served"}'
          WHERE vault_addr = 'Q1-bell'`,
      );
      // A KEY THAT STRADDLES THE 200TH CHARACTER, as a raw exception message could store it: read whole, masked, then cut.
      const straddling = createHash("sha256").update("a key across the cut").digest("hex");
      await db.query("UPDATE sip_solana.vault_work SET last_detail = repeat('y', 190) || $1 || ' and the rest' WHERE vault_addr = 'Q2-safety'", [straddling]);
      const snapshot = await new PgFleetStore(db).read();
      const safety = snapshot.vaults.find((row) => row.vault === "Q2-safety")!.lastDetail!;
      expect(safety).toHaveLength(VAULT_DETAIL_CHARS);
      expect(safety).not.toContain(straddling.slice(0, 10));
      expect(safety.slice(190)).toBe("<redacted:".slice(0, 10));
      expect(snapshot.vaults.map((row) => [row.vault, row.system])).toEqual([
        ["D1-draining", "draining"],
        ["Q6-parked", "queue"],
        ["L1-legacy", "legacy"],
        ["Q1-bell", "queue"],
        ["Q2-safety", "queue"],
        ["Q3-held", "queue"],
        ["Q4-lapsed", "queue"],
        ["Q5-takeover", "queue"],
      ]);
      expect(snapshot.vaultsTruncated).toBe(0);
      const bell = snapshot.vaults.find((row) => row.vault === "Q1-bell")!;
      expect(bell).toMatchObject({ skimMode: 0, lane: "bell", lastOutcome: "SETTLED", attempts: 0, parkedReason: null });
      expect(bell.lastDetail).toBe("d".repeat(VAULT_DETAIL_CHARS));
      expect(Date.parse(bell.lastDoneAt!)).toBeLessThan(Date.now());
      expect(Date.parse(bell.dueAt!)).toBeLessThan(Date.now());
      expect(bell.streaks).toEqual({ settleRetries: { "9QX53J3Kbs8ogQirZq5iN11rucZAvgF4EKWw98QAkUSe": 2 }, investFailed: 0, investRefused: 1, wrapShort: 0 });
      expect(JSON.stringify(snapshot.vaults)).not.toContain("never served");
      expect(snapshot.vaults.find((row) => row.vault === "Q6-parked")!.parkedReason).toBe("5 lapsed leases in a row");
      // THE UNSERVED VIEW: the scheduler-enrolled draining row measured from its due_at, the parked queue row counted.
      expect(snapshot.unserved.draining).toBe(1);
      expect(snapshot.unserved.parked).toBe(1);
      expect(snapshot.unserved.vaults.map((row) => [row.vault, row.system, row.from, row.parkedReason])).toEqual([
        ["D1-draining", "draining", "due_at", null],
        ["Q6-parked", "queue", null, "5 lapsed leases in a row"],
      ]);
      expect(Math.abs(snapshot.unserved.vaults[0]!.forMs! - 3_600_000)).toBeLessThan(5_000);
      expect(snapshot.unserved.vaults[1]!.forMs).toBeNull();
    });

    it("measures a vault the scheduler enrolled from its due_at — which no bell and no mark moves — and one a handover drained from system_at, and pages each past its threshold", async () => {
      const store = new PgFleetStore(db);
      const scheduler = new PgSchedulerStore(db);
      await db.query("UPDATE sip_solana.fleet SET new_vault_system = 'queue' WHERE id");
      // THE ENROLMENT, AS THE SCHEDULER'S TICK DOES IT; then made twenty minutes old.
      expect(await scheduler.ensureVaults(["N1-new"])).toEqual([{ vault: "N1-new", system: "draining" }]);
      await db.query("UPDATE sip_solana.vault_work SET due_at = due_at - interval '20 minutes' WHERE vault_addr = 'N1-new'");
      const dueBefore = (await db.query<{ due: string }>("SELECT due_at::text AS due FROM sip_solana.vault_work WHERE vault_addr = 'N1-new'")).rows[0]!.due;
      // A BELL ON IT AND A MARK OF IT: neither moves a draining row's due_at.
      await db.query(
        `INSERT INTO sip_solana.keeper_link (link_addr, wallet_addr, vault_addr, epoch, settlement_nonce, frontier_slot, seen_slot)
         VALUES ('LN1', 'WalletOfN1', 'N1-new', 0, 1, 1, 1)`,
      );
      expect((await store.ring({ addresses: ["WalletOfN1"], signatures: [], bellDelayMs: BELL_DELAY_MS })).vaults).toBe(1);
      expect(await scheduler.markDue([{ vault: "N1-new", lane: "new" }], BELL_DELAY_MS)).toEqual([]);
      const dueAfter = (await db.query<{ due: string; system_at: string | null }>("SELECT due_at::text AS due, system_at FROM sip_solana.vault_work WHERE vault_addr = 'N1-new'")).rows[0]!;
      expect(dueAfter).toEqual({ due: dueBefore, system_at: null });
      // THE HANDOVER'S DRAIN WRITES system_at; made seventy minutes old.
      expect((await db.query(DRAIN_SQL, ["L1-legacy"])).rows).toEqual([{ system: "draining" }]);
      await db.query("UPDATE sip_solana.vault_work SET system_at = system_at - interval '70 minutes' WHERE vault_addr = 'L1-legacy'");

      const snapshot = await store.read();
      const byVault = new Map(snapshot.unserved.vaults.map((row) => [row.vault, row]));
      expect(snapshot.unserved.draining).toBe(3);
      expect(byVault.get("N1-new")!.from).toBe("due_at");
      expect(Math.abs(byVault.get("N1-new")!.forMs! - 20 * 60_000)).toBeLessThan(5_000);
      expect(byVault.get("L1-legacy")!.from).toBe("system_at");
      expect(Math.abs(byVault.get("L1-legacy")!.forMs! - 70 * 60_000)).toBeLessThan(5_000);
      // LONGEST FIRST.
      expect(snapshot.unserved.vaults.map((row) => row.vault)).toEqual(["L1-legacy", "D1-draining", "N1-new", "Q6-parked"]);

      const fired: Alert[] = [];
      const cleared: string[] = [];
      const alerts = new FleetAlerts({ alerter: { fire: (alert) => fired.push(alert), clear: (key) => cleared.push(key) }, windowMs: 60_000 });
      alerts.observeSnapshot(snapshot, { acting: true });
      const unservedPages = fired.filter((alert) => alert.key.startsWith("vault-unserved")).map((alert) => `${alert.key}:${alert.severity}`);
      expect(unservedPages.sort()).toEqual(
        [`${vaultUnservedKey("L1-legacy")}:critical`, `${vaultUnservedKey("D1-draining")}:critical`, `${vaultUnservedKey("N1-new")}:warn`].sort(),
      );
      // ARM'S MOVE (system = 'queue', system_at = now): the vault leaves the view, and its page ends.
      await db.query("UPDATE sip_solana.vault_work SET system = 'queue', system_at = clock_timestamp() WHERE vault_addr = 'N1-new'");
      alerts.observeSnapshot(await store.read(), { acting: true });
      expect(cleared).toContain(vaultUnservedKey("N1-new"));
      expect(alerts.status().firing.filter((key) => key.startsWith("vault-unserved")).sort()).toEqual([vaultUnservedKey("D1-draining"), vaultUnservedKey("L1-legacy")].sort());
    });

    it("keeps the page whole over a draining row whose time is infinite, and over one whose time is still to come", async () => {
      await db.query(
        `INSERT INTO sip_solana.vault_work (vault_addr, system, due_at) VALUES
           ('D2-infinite', 'draining', 'infinity'), ('D3-future', 'draining', clock_timestamp() + interval '1 hour')`,
      );
      const snapshot = await new PgFleetStore(db).read();
      const byVault = new Map(snapshot.unserved.vaults.map((row) => [row.vault, row]));
      expect(byVault.get("D2-infinite")!.forMs).toBeNull();
      expect(byVault.get("D3-future")!.forMs).toBe(0);
      expect(snapshot.vaults.find((row) => row.vault === "D2-infinite")!.dueAt).toBe("infinity");
    });

    it("caps both lists at the statement's limit, the unserved first, and counts every row the cap left out", async () => {
      await db.query(
        `INSERT INTO sip_solana.vault_work (vault_addr, system, due_at)
         SELECT 'Bulk-' || lpad(i::text, 4, '0'), 'legacy', clock_timestamp() FROM generate_series(1, 600) AS i`,
      );
      const full = await new PgFleetStore(db).read();
      expect(full.vaults).toHaveLength(VAULTS_LISTED);
      expect(full.vaultsTruncated).toBe(608 - VAULTS_LISTED);
      expect(full.vaults.slice(0, 2).map((row) => row.vault)).toEqual(["D1-draining", "Q6-parked"]);
      const raw = (await db.query<{ snapshot: unknown }>(FLEET_SNAPSHOT_SQL, [360, 50, 300, 1, VAULT_DETAIL_READ_CHARS])).rows[0]!.snapshot;
      const one = parseFleetSnapshot(raw);
      expect(one.vaults.map((row) => row.vault)).toEqual(["D1-draining"]);
      expect(one.vaultsTruncated).toBe(607);
      expect(one.unserved).toMatchObject({ draining: 1, parked: 1 });
      expect(one.unserved.vaults.map((row) => row.vault)).toEqual(["D1-draining"]);
    });

    it("hands a worker's beat the scheduler tick's age, and the worker's watch pages it 11 minutes old and clears it once the tick moves", async () => {
      const fired: Alert[] = [];
      const cleared: string[] = [];
      const watch = new SchedulerStaleWatch({ alerter: { fire: (alert) => fired.push(alert), clear: (key) => cleared.push(key) } });
      const worker = new DispatchStore(db, "w-alive");
      const source = worker.quotaSource(
        () => ({ busy: 1 }),
        (age) => void watch.observe(age),
      );
      expect(await source.readQuota()).toEqual({ rpsQuota: null, jupQuotaPerMinute: null, ageMs: null });
      expect(fired.map((alert) => `${alert.key}:${alert.severity}`)).toEqual([`${SCHEDULER_STALE_ALERT_KEY}:critical`]);
      expect(Math.abs(watch.status().tickAgeMs! - 11 * 60_000)).toBeLessThan(5_000);
      await db.query("UPDATE sip_solana.fleet SET tick_at = clock_timestamp() WHERE id");
      await source.readQuota();
      expect(cleared).toEqual([SCHEDULER_STALE_ALERT_KEY]);
      expect(watch.status().firing).toBe(false);
      // A FLEET ROW THAT WAS NEVER TICKED: null, judged by the worker's uptime (a moment), so nothing.
      await db.query("UPDATE sip_solana.fleet SET tick_at = NULL WHERE id");
      await source.readQuota();
      expect(watch.status().tickAgeMs).toBeNull();
      expect(fired).toHaveLength(1);
    });

    it("is a read failure that says what to run over a database without the dispatcher's tables", async () => {
      const reader = new FleetStatusReader({ source: new PgFleetStore(pool(bare, 1)) });
      expect(await reader.refresh()).toBe(false);
      expect(reader.status().lastError).toContain("apply sql/sip_solana.sql with setup-read-model");
    });
  });
});
