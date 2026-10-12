// THE SCHEDULER ON POSTGRES 16 (src/scheduler-pg.ts, src/scheduler.ts): its
// statements over sql/sip_solana.sql alone, its lock on real sessions, two
// schedulers over one database, and the queue's order under a full-pass backlog.
//
//   * every statement, against the schema file and its CHECKs: a drift between
//     the two is a failing test, not a refused write in production;
//   * two Scheduler instances, each with its own pool and its own lock session
//     (PgSchedulerLock): exactly one listing a tick for the pair, a standby that
//     takes the lock the tick after the holder's session dies — ended, or
//     terminated by the server — and whose first tick is a full pass;
//   * THE STARVATION CHECK (P3a-1's note): workers claiming by affinity under a
//     saturated queue, the scheduler re-marking every vault due on every tick
//     (an untrusted doorbell's full pass), and a third of the vaults last held by
//     a worker that is gone. Every vault must still be claimed, in a bounded
//     number of ticks.
//
// RUN ONLY WITH A THROWAWAY DATABASE ON THE LOOPBACK (test/fleet-pg.test.ts's
// rule): KEEPER_TEST_PG_URL names the server, the run creates its own database
// and drops it. Without the variable the block is skipped and says why.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";
import pg from "pg";
import { Secret } from "@sip/solana-log";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CLAIM_AFFINITY_SECONDS, DispatchStore, createDispatchPool } from "../src/dispatch-store.js";
import { PgFleetStore } from "../src/fleet-pg.js";
import {
  MARK_DUE_SQL,
  PgSchedulerLock,
  PgSchedulerStore,
  REAP_INTENT_AGE_MINUTES,
  SCHEDULER_COMPLETE_SQL,
  missingSchedulerColumns,
  type LinkRow,
  type LockClient,
} from "../src/scheduler-pg.js";
import { SolanaReadModel } from "../src/read-model.js";
import { FleetBoard } from "../src/scheduler-board.js";
import { SCHEDULER_LOCK_NAME, Scheduler } from "../src/scheduler.js";
import { advisoryKeyFor } from "../src/singleton.js";
import { FakeAlerter, FakeChain, fakeLink } from "./scheduler-fakes.js";

const URL_RAW = process.env["KEEPER_TEST_PG_URL"];
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const usable = ((): boolean => {
  if (URL_RAW === undefined || URL_RAW.trim() === "") return false;
  const host = new URL(URL_RAW).hostname;
  if (!LOOPBACK.has(host)) throw new Error("KEEPER_TEST_PG_URL must point at the loopback; it names another host");
  return true;
})();

const SCHEMA_SQL = readFileSync(fileURLToPath(new URL("../sql/sip_solana.sql", import.meta.url)), "utf8");
const S = "sip_solana";

/** A lock session the test steers: whether the lock is free, whether its statements answer, and its error event. */
class FakeLockClient implements LockClient {
  static free = true;
  readonly queries: string[] = [];
  ended = false;
  failQueries = false;
  #onError: ((error: Error) => void) | null = null;
  async connect(): Promise<void> {
    if (this.failQueries) throw new Error("ECONNREFUSED");
  }
  async query(text: string): Promise<{ rows: Record<string, unknown>[] }> {
    this.queries.push(text);
    if (this.failQueries) throw new Error("Connection terminated unexpectedly");
    if (text.includes("pg_try_advisory_lock")) {
      const granted = FakeLockClient.free;
      if (granted) FakeLockClient.free = false;
      return { rows: [{ locked: granted }] };
    }
    return { rows: [{ "?column?": 1 }] };
  }
  async end(): Promise<void> {
    this.ended = true;
  }
  on(_event: "error", listener: (error: Error) => void): this {
    this.#onError = listener;
    return this;
  }
  emitError(): void {
    this.#onError?.(new Error("terminating connection due to administrator command"));
  }
}

describe("the scheduler's lock, on a session it steers (PgSchedulerLock)", () => {
  const rig = () => {
    FakeLockClient.free = true;
    const clients: FakeLockClient[] = [];
    const lost: string[] = [];
    const lock = new PgSchedulerLock({
      client: () => {
        const client = new FakeLockClient();
        clients.push(client);
        return client;
      },
      key: 42n,
      onLost: (detail) => lost.push(detail),
    });
    return { lock, clients, lost };
  };

  it("takes a free lock and keeps its session; a refused attempt closes its session and stands by", async () => {
    const { lock, clients } = rig();
    expect(await lock.ensure()).toBe("took");
    expect(lock.held).toBe(true);
    expect(clients[0]!.ended).toBe(false);
    const other = rig();
    FakeLockClient.free = false;
    expect(await other.lock.ensure()).toBe("standby");
    expect(other.clients[0]!.ended).toBe(true);
  });

  it("checks the session it holds on every tick, and a session that stopped answering — with no error event — is a lost lock", async () => {
    const { lock, clients, lost } = rig();
    await lock.ensure();
    expect(await lock.ensure()).toBe("held");
    expect(clients[0]!.queries.at(-1)).toBe("SELECT 1");
    clients[0]!.failQueries = true;
    expect(await lock.ensure()).toBe("lost");
    expect(lock.held).toBe(false);
    expect(clients[0]!.ended).toBe(true);
    expect(lost).toEqual([expect.stringContaining("Connection terminated")]);
  });

  it("learns of a session the server ended from its error event, and releasing ends the session", async () => {
    const { lock, clients } = rig();
    await lock.ensure();
    clients[0]!.emitError();
    expect(lock.held).toBe(false);
    expect(await lock.ensure()).toBe("lost");
    FakeLockClient.free = true;
    expect(await lock.ensure()).toBe("took");
    lock.release();
    expect(clients[1]!.ended).toBe(true);
    expect(lock.held).toBe(false);
  });

  it("stands by when it cannot even connect, and closes what it opened", async () => {
    const { lock } = rig();
    const failing = new PgSchedulerLock({
      client: () => Object.assign(new FakeLockClient(), { failQueries: true }),
      key: 42n,
    });
    expect(await failing.ensure()).toBe("standby");
    expect(failing.held).toBe(false);
    expect(lock.held).toBe(false);
  });
});

describe.skipIf(!usable)("the scheduler on Postgres 16 (needs KEEPER_TEST_PG_URL on the loopback)", () => {
  const database = `keeper_scheduler_${process.pid}_${Date.now()}`;
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
  const schedulerPool = (name: string): pg.Pool => {
    const opened = createDispatchPool(new Secret(url(), "databaseUrl"), "scheduler", `test-scheduler:${name}`, () => undefined);
    pools.push(opened);
    return opened;
  };
  const lockClient = () => {
    const client = new pg.Client({ connectionString: url(), application_name: "test-scheduler-lock" });
    return client;
  };
  /** Every lock a test built: released after it, so the next test starts with the lock free. */
  const locks: PgSchedulerLock[] = [];

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: URL_RAW!, max: 1 });
    admin.on("error", () => undefined);
    await admin.query(`CREATE DATABASE ${database}`);
    db = pool(4);
    await db.query(SCHEMA_SQL);
  });

  afterAll(async () => {
    for (const lock of locks.splice(0)) lock.release();
    for (const opened of pools) await opened.end().catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`).catch(() => undefined);
    await admin.end();
  });

  beforeEach(async () => {
    for (const lock of locks.splice(0)) lock.release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await db.query(`TRUNCATE ${S}.keeper_link, ${S}.vault_work, ${S}.send_intent, ${S}.worker, ${S}.rpc_usage`);
    await db.query(`UPDATE ${S}.fleet SET full_pass_reason = NULL, scheduler_id = NULL, tick_at = NULL, new_vault_system = 'queue', webhook_owner = 'legacy'`);
  });

  const queueRow = async (vault: string, over: Record<string, string> = {}): Promise<void> => {
    const columns = ["vault_addr", "system", ...Object.keys(over)];
    const values = [`'${vault}'`, "'queue'", ...Object.values(over)];
    await db.query(`INSERT INTO ${S}.vault_work (${columns.join(", ")}) VALUES (${values.join(", ")})`);
  };
  const row = async (vault: string): Promise<Record<string, unknown>> =>
    (await db.query(`SELECT *, extract(epoch FROM due_at - clock_timestamp()) AS due_in_s FROM ${S}.vault_work WHERE vault_addr = $1`, [vault])).rows[0]!;

  describe("the statements, against the schema file", () => {
    it("the schema applies again over a fleet row that predates webhook_owner, and the boot check finds every column", async () => {
      await db.query(`ALTER TABLE ${S}.fleet DROP COLUMN webhook_owner`);
      expect(await missingSchedulerColumns(db)).toEqual(["fleet.webhook_owner"]);
      await db.query(SCHEMA_SQL);
      expect(await missingSchedulerColumns(db)).toEqual([]);
      expect((await db.query(`SELECT webhook_owner FROM ${S}.fleet`)).rows).toEqual([{ webhook_owner: "legacy" }]);
      await expect(db.query(`UPDATE ${S}.fleet SET webhook_owner = 'nobody'`)).rejects.toThrow(/check/i);
    });

    it("upserts a listing without ever moving seen_slot backwards, keeps C8 and C4's columns, marks the unlisted gone and lists the rest back", async () => {
      const store = new PgSchedulerStore(db);
      const link = (n: number, nonce = 0n): LinkRow => ({ link: `L${n}`, wallet: `W${n}`, vault: `V${n % 2}`, epoch: 1n, nonce, frontier: 10n });
      await store.upsertLinks([link(1), link(2), link(3)], 500);
      await db.query(`UPDATE ${S}.keeper_link SET privy_wallet_id = 'pw', last_own_settle = 'sig' WHERE link_addr = 'L1'`);
      await store.upsertLinks([link(1, 5n)], 600);
      await store.upsertLinks([link(1, 4n)], 550); // a stale scheduler's older listing
      const l1 = (await db.query(`SELECT settlement_nonce, seen_slot, privy_wallet_id, last_own_settle FROM ${S}.keeper_link WHERE link_addr = 'L1'`)).rows[0];
      expect(l1).toEqual({ settlement_nonce: "5", seen_slot: "600", privy_wallet_id: "pw", last_own_settle: "sig" });
      expect(await store.markGone(["L1", "L3"])).toEqual(["L2"]);
      const cached = await store.cachedLinks();
      expect(cached.links.map((l) => l.link)).toEqual(["L1", "L3"]);
      expect(cached.newestSeenAt).toBeGreaterThan(Date.now() - 60_000);
      // LISTED AGAIN, IT COMES BACK.
      await store.upsertLinks([link(2)], 700);
      expect((await store.cachedLinks()).links.map((l) => l.link)).toEqual(["L1", "L2", "L3"]);
    });

    it("gives a new vault the fleet's system — 'draining' under 'queue', never the queue itself — leaves an existing row untouched, and reads rows with their open intents", async () => {
      const store = new PgSchedulerStore(db);
      await db.query(`UPDATE ${S}.fleet SET new_vault_system = 'legacy'`);
      expect(await store.ensureVaults(["VA", "VA"])).toEqual([{ vault: "VA", system: "legacy" }]);
      await db.query(`UPDATE ${S}.fleet SET new_vault_system = 'queue'`);
      // THE HANDOVER'S ENROLMENT RULE: a vault enters the queue only through `arm`.
      expect(await store.ensureVaults(["VA", "VB"])).toEqual([{ vault: "VB", system: "draining" }]);
      expect(await store.markDue([{ vault: "VB", lane: "full" }], 15_000)).toEqual([]);
      expect(await new DispatchStore(db, "W").claim(2)).toEqual([]);
      await db.query(`UPDATE ${S}.vault_work SET system = 'queue' WHERE vault_addr = 'VB'`);
      await db.query(
        `INSERT INTO ${S}.send_intent (vault_addr, kind, fence, worker_id, blockhash, last_valid_block_height) VALUES ('VB', 'wrap', 1, 'w', 'bh', 10), ('VB', 'invest', 1, 'w', 'bh', 11)`,
      );
      await db.query(`UPDATE ${S}.send_intent SET state = 'landed', resolved_at = clock_timestamp() WHERE kind = 'invest'`);
      const work = await store.readWork(["VA", "VB", "VZ"]);
      expect(work.rows.map((r) => [r.vault, r.system, r.openIntents, r.held, r.rests]).sort()).toEqual([
        ["VA", "legacy", 0, false, false],
        ["VB", "queue", 1, false, false],
      ]);
      expect(work.now).toBeGreaterThan(Date.now() - 60_000);
    });

    it("makes due only free queue rows, only ever earlier, keeps a pending bell's priority and its finality wait, and skips a row a worker has locked", async () => {
      const store = new PgSchedulerStore(db);
      await queueRow("FREE", { due_at: "clock_timestamp() + interval '1 hour'", lane: "'safety'", priority: "4" });
      await queueRow("EARLY", { due_at: "clock_timestamp() - interval '5 minutes'", lane: "'busy'", priority: "1" });
      await queueRow("BELL", { due_at: "clock_timestamp() + interval '10 seconds'", lane: "'bell'", priority: "0", bell_at: "clock_timestamp() - interval '5 seconds'" });
      await queueRow("HELD", { holder: "'w1'", lease_until: "clock_timestamp() + interval '40 seconds'", due_at: "clock_timestamp() + interval '1 hour'" });
      await queueRow("PARKED", { parked_reason: "'x'", due_at: "clock_timestamp() + interval '1 hour'" });
      await db.query(`INSERT INTO ${S}.vault_work (vault_addr, system, due_at) VALUES ('LEGACY', 'legacy', clock_timestamp() + interval '1 hour')`);
      await queueRow("LOCKED", { due_at: "clock_timestamp() + interval '1 hour'" });
      const locker = await db.connect();
      await locker.query("BEGIN");
      await locker.query(`SELECT 1 FROM ${S}.vault_work WHERE vault_addr = 'LOCKED' FOR SHARE`);
      const started = Date.now();
      const marked = await store.markDue(
        ["FREE", "EARLY", "BELL", "HELD", "PARKED", "LEGACY", "LOCKED"].map((vault) => ({ vault, lane: "full" as const })),
        15_000,
      );
      expect(Date.now() - started, "never waits for a worker's lock").toBeLessThan(1_000);
      await locker.query("ROLLBACK");
      locker.release();
      expect([...marked].sort()).toEqual(["BELL", "EARLY", "FREE"]);
      expect(Number((await row("FREE"))["due_in_s"])).toBeLessThanOrEqual(0);
      expect(await row("FREE")).toMatchObject({ lane: "full", priority: 3 });
      // ALREADY DUE, IN A MORE URGENT LANE: its place and its lane are kept.
      expect(Number((await row("EARLY"))["due_in_s"])).toBeLessThan(-250);
      expect(await row("EARLY")).toMatchObject({ lane: "busy", priority: 1 });
      // THE RECEIVER'S BELL: still a bell, still waiting out its 15 s from the ring.
      expect(await row("BELL")).toMatchObject({ lane: "bell", priority: 0 });
      expect(Number((await row("BELL"))["due_in_s"])).toBeGreaterThan(5);
      for (const vault of ["HELD", "PARKED", "LEGACY", "LOCKED"]) expect(Number((await row(vault))["due_in_s"]), vault).toBeGreaterThan(3_000);
      expect(MARK_DUE_SQL).toMatch(/SKIP LOCKED/);
      expect(MARK_DUE_SQL).toMatch(/LEAST\(w\.due_at/);
    });

    it("completes an idle vault only as the tick read it: same fence, same bell, free, resting", async () => {
      const store = new PgSchedulerStore(db);
      for (const vault of ["SAME", "CLAIMED", "RUNG", "HELD", "BUSY"]) {
        await queueRow(vault, { rests: vault === "BUSY" ? "false" : "true", fence: "3", due_at: "clock_timestamp()" });
      }
      const work = new Map((await store.readWork(["SAME", "CLAIMED", "RUNG", "HELD", "BUSY"])).rows.map((r) => [r.vault, r] as const));
      await db.query(`UPDATE ${S}.vault_work SET fence = 4 WHERE vault_addr = 'CLAIMED'`);
      await db.query(`UPDATE ${S}.vault_work SET bell_at = clock_timestamp() WHERE vault_addr = 'RUNG'`);
      await db.query(`UPDATE ${S}.vault_work SET holder = 'w', lease_until = clock_timestamp() + interval '40 s' WHERE vault_addr = 'HELD'`);
      const done = await store.completeIdle(
        [...work.values()].map((r) => ({ vault: r.vault, fence: r.fence, bellAt: r.bellAt })),
        30 * 60_000,
        "decided by the scheduler",
      );
      expect(done).toEqual(["SAME"]);
      const same = await row("SAME");
      expect(same).toMatchObject({ lane: "safety", priority: 4, rests: true, last_outcome: "IDLE", last_detail: "decided by the scheduler", fence: "3", holder: null });
      expect(Number(same["due_in_s"])).toBeGreaterThan(1_790);
      expect(SCHEDULER_COMPLETE_SQL).not.toMatch(/fence\s*=\s*w\.fence\s*\+/);
    });

    it("retires a queue vault no link names, parks one whose lease lapsed five claims running, and writes the tick", async () => {
      const store = new PgSchedulerStore(db);
      await queueRow("LISTED");
      await queueRow("UNLINKED");
      await queueRow("HELD_UNLINKED", { holder: "'w'", lease_until: "clock_timestamp() + interval '40 s'" });
      expect(await store.retireUnlinked(["LISTED"])).toEqual(["UNLINKED"]);
      expect((await db.query(`SELECT due_at = 'infinity' AS inf FROM ${S}.vault_work WHERE vault_addr = 'UNLINKED'`)).rows[0]).toEqual({ inf: true });
      await queueRow("LAPSED5", { holder: "'w'", lease_until: "clock_timestamp() - interval '1 s'", attempts: "5" });
      await queueRow("LAPSED4", { holder: "'w'", lease_until: "clock_timestamp() - interval '1 s'", attempts: "4" });
      await queueRow("LIVE5", { holder: "'w'", lease_until: "clock_timestamp() + interval '40 s'", attempts: "5" });
      expect(await store.park()).toEqual([{ vault: "LAPSED5", attempts: 5 }]);
      expect(await store.park()).toEqual([]);
      await store.writeTick("sched-1", true);
      const fleet = (await db.query(`SELECT scheduler_id, tick_at IS NOT NULL AS ticked, discovery_ok_at IS NOT NULL AS listed FROM ${S}.fleet`)).rows[0];
      expect(fleet).toEqual({ scheduler_id: "sched-1", ticked: true, listed: true });
    });

    it("reads the reap's intents — old, unresolved, on a vault nobody holds — and prunes only resolved ones past 35 days", async () => {
      const store = new PgSchedulerStore(db);
      await queueRow("FREE");
      await queueRow("HELD", { holder: "'w'", lease_until: "clock_timestamp() + interval '40 s'" });
      const intent = async (vault: string, age: string, resolved = false): Promise<void> => {
        await db.query(
          `INSERT INTO ${S}.send_intent (vault_addr, kind, fence, worker_id, blockhash, last_valid_block_height, signature, created_at, state, resolved_at)
           VALUES ($1, 'wrap', 1, 'w', 'bh', 77, md5(random()::text), clock_timestamp() - $2::interval, $3, $4)`,
          [vault, age, resolved ? "landed" : "intent", resolved ? new Date() : null],
        );
      };
      await intent("FREE", `${REAP_INTENT_AGE_MINUTES + 1} minutes`);
      await intent("FREE", "1 minute");
      await intent("HELD", "1 hour");
      await intent("FREE", "40 days", true);
      await intent("FREE", "40 days");
      const stale = await store.staleIntents();
      expect(stale.map((s) => s.vault)).toEqual(["FREE", "FREE"]);
      expect(stale[0]).toMatchObject({ kind: "wrap", lastValidBlockHeight: 77n });
      expect(await store.pruneIntents()).toBe(1);
      expect(Number((await db.query(`SELECT count(*) FROM ${S}.send_intent`)).rows[0]!["count"])).toBe(4);
    });

    it("reads the doorbell's evidence: the newest bell, an echo since the takeover, a landed intent nobody echoed", async () => {
      const store = new PgSchedulerStore(db);
      const since = Date.now() - 60_000;
      await queueRow("V", { bell_at: "clock_timestamp() - interval '10 s'" });
      await db.query(
        `INSERT INTO ${S}.send_intent (vault_addr, kind, fence, worker_id, blockhash, last_valid_block_height, signature, state, resolved_at)
         VALUES ('V', 'wrap', 1, 'w', 'bh', 9, 'deaf-sig', 'landed', clock_timestamp() - interval '400 s')`,
      );
      const evidence = await store.hookEvidence(since, 300_000);
      expect(evidence.lastBellAt).toBeGreaterThan(since);
      expect(evidence.lastEchoAt).toBeNull();
      expect(evidence.deafSince).not.toBeNull();
    });
  });

  describe("two schedulers over one database, each with its own lock session", () => {
    function build(name: string, chain: FakeChain) {
      const p = schedulerPool(name);
      const lock = new PgSchedulerLock({ client: lockClient, key: advisoryKeyFor(SCHEDULER_LOCK_NAME) });
      locks.push(lock);
      const fleet = new PgFleetStore(p);
      const store = new DispatchStore(p, name);
      const scheduler = new Scheduler({
        id: name,
        mode: "on",
        tickMs: 60_000,
        lock,
        store: new PgSchedulerStore(p),
        fullPass: fleet,
        intents: store,
        chain,
        alerter: new FakeAlerter(),
        log: () => undefined,
        lamportsFilter: false,
        doorbellSecret: false,
      });
      return { scheduler, lock, pool: p };
    }

    it("exactly one listing a tick for the pair; the standby takes over the tick after the holder's session ends, with a full pass", async () => {
      const chain = new FakeChain();
      for (let i = 0; i < 4; i++) chain.links.push(fakeLink(Keypair.generate().publicKey));
      const a = build("sched-A", chain);
      const b = build("sched-B", chain);
      const lists = (): number => chain.calls.filter((c) => c === "list").length;
      for (let round = 0; round < 6; round++) {
        const before = lists();
        const reports = await Promise.all([a.scheduler.tick(), b.scheduler.tick()]);
        expect(lists() - before, `round ${round}`).toBe(1);
        expect(reports.map((r) => r.kind).sort()).toEqual(["acted", "standby"]);
      }
      const holder = a.scheduler.acting ? a : b;
      const standby = a.scheduler.acting ? b : a;
      expect((await db.query(`SELECT scheduler_id FROM ${S}.fleet`)).rows[0]!["scheduler_id"]).toBe(holder === a ? "sched-A" : "sched-B");
      // ENROLLED DRAINING (new_vault_system = 'queue'); the handover's `arm` moves them to the queue.
      expect(Number((await db.query(`SELECT count(*) FROM ${S}.vault_work WHERE system = 'draining'`)).rows[0]!["count"])).toBe(4);
      await db.query(`UPDATE ${S}.vault_work SET system = 'queue' WHERE system = 'draining'`);
      // THE HOLDER DIES: its lock session ends with it.
      holder.lock.release();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const took = await standby.scheduler.tick();
      expect(took).toMatchObject({ kind: "acted", tookOver: true });
      if (took.kind !== "acted") throw new Error("unreachable");
      expect(took.fullReason).not.toBeNull();
      expect(took.marked).toHaveLength(4);
      expect(standby.scheduler.status().takeovers).toBe(1);
    });

    it("a holder whose session the server terminates finds out at its next tick and stands by; the other takes the lock", async () => {
      const chain = new FakeChain();
      chain.links.push(fakeLink(Keypair.generate().publicKey));
      const a = build("sched-C", chain);
      const b = build("sched-D", chain);
      expect((await a.scheduler.tick()).kind).toBe("acted");
      expect((await b.scheduler.tick()).kind).toBe("standby");
      const key = advisoryKeyFor(SCHEDULER_LOCK_NAME);
      const killed = await admin.query(
        `SELECT pg_terminate_backend(pid) AS killed FROM pg_locks
          WHERE locktype = 'advisory' AND granted AND database = (SELECT oid FROM pg_database WHERE datname = $1)
            AND ((classid::bigint << 32) | objid::bigint) = $2::bigint`,
        [database, key.toString()],
      );
      expect(killed.rows).toEqual([{ killed: true }]);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await a.scheduler.tick()).toEqual({ kind: "standby", lock: "lost" });
      expect(await b.scheduler.tick()).toMatchObject({ kind: "acted", tookOver: true });
      expect(await a.scheduler.tick()).toEqual({ kind: "standby", lock: "standby" });
    });
  });

  describe("the replica's leaderboard over the scheduler's one connection", () => {
    it("reads the rankings through SolanaReadModel.overPool on createDispatchPool(…, 'scheduler'), opening nothing else", async () => {
      await db.query(
        `INSERT INTO ${S}.settlement_event (wallet_addr, nonce, vault_addr, mode, base_raw, contribution_raw, volume_raw, tx_ref, height, at)
         VALUES ('W1', 1, 'V1', 0, 100, 20, 0, 'tx-1', 10, clock_timestamp()), ('W2', 1, 'V2', 1, 1000, 2, 1000, 'tx-2', 11, clock_timestamp())
         ON CONFLICT DO NOTHING`,
      );
      const p = schedulerPool("board");
      const board = new FleetBoard({ readModel: SolanaReadModel.overPool(p, () => undefined), log: () => undefined });
      board.request();
      for (let i = 0; i < 50 && !("body" in board.reply()); i++) await new Promise((resolve) => setTimeout(resolve, 20));
      const reply = board.reply();
      expect("body" in reply).toBe(true);
      expect((reply as { body: string }).body).toContain("V1");
      expect(p.totalCount).toBeLessThanOrEqual(1);
    });
  });

  describe("starvation under a full-pass backlog (CLAIM's affinity against FIFO)", () => {
    /** Moves the database's view of every vault back by `seconds`: time passing, without waiting for it. */
    const elapse = async (seconds: number): Promise<void> => {
      await db.query(
        `UPDATE ${S}.vault_work SET due_at = due_at - make_interval(secs => $1), claimed_at = claimed_at - make_interval(secs => $1),
                lease_until = lease_until - make_interval(secs => $1), last_done_at = last_done_at - make_interval(secs => $1)
          WHERE due_at <> 'infinity'`,
        [seconds],
      );
    };

    it("every vault is claimed within a bounded number of ticks, those last held by a worker that is gone included", async () => {
      const vaults = Array.from({ length: 30 }, (_, i) => `SV${String(i).padStart(2, "0")}`);
      const holders = ["W1", "W2", "GONE"];
      for (const [i, vault] of vaults.entries()) {
        await queueRow(vault, { last_holder: `'${holders[i % 3]}'`, lane: "'full'", priority: "3", due_at: "clock_timestamp()" });
      }
      const schedulerStore = new PgSchedulerStore(db);
      const workers = ["W1", "W2"].map((id) => new DispatchStore(pool(2), id));
      const firstClaim = new Map<string, number>();
      for (let tick = 1; tick <= 40; tick++) {
        await elapse(60);
        // AN UNTRUSTED DOORBELL: every tick is a full pass over every vault.
        await schedulerStore.markDue(vaults.map((vault) => ({ vault, lane: "full" as const })), 15_000);
        for (const worker of workers) {
          for (const claimed of await worker.claim(2)) {
            if (!firstClaim.has(claimed.vault)) firstClaim.set(claimed.vault, tick);
            // A QUIET JOB: rests, due again after the safety pass.
            await worker.complete(claimed, { rests: true, lane: "safety", streaks: {}, outcome: "IDLE", detail: null, dueInSeconds: 1_800 });
          }
        }
      }
      const unclaimed = vaults.filter((vault) => !firstClaim.has(vault));
      expect(unclaimed, "vaults never claimed").toEqual([]);
      // THE BOUND: affinity's head start (a tick is a minute), then the backlog ahead of it at 4 claims a tick.
      const bound = Math.ceil(CLAIM_AFFINITY_SECONDS / 60) + Math.ceil(vaults.length / 4) + 1;
      expect(Math.max(...firstClaim.values())).toBeLessThanOrEqual(bound);
    });

    it("keeps the soft affinity inside its head start: a worker's own fresh vault before another's older one, until that one is older by more", async () => {
      const head = CLAIM_AFFINITY_SECONDS / 60;
      await queueRow("MINE", { last_holder: "'W1'", lane: "'new'", priority: "2", due_at: "clock_timestamp() - interval '1 minute'" });
      await queueRow("THEIRS", {
        last_holder: "'W2'",
        lane: "'new'",
        priority: "2",
        due_at: `clock_timestamp() - interval '${1 + head - 1} minutes'`,
      });
      await queueRow("OVERDUE", {
        last_holder: "'GONE'",
        lane: "'new'",
        priority: "2",
        due_at: `clock_timestamp() - interval '${1 + head + 1} minutes'`,
      });
      const w1 = new DispatchStore(pool(1), "W1");
      const order: string[] = [];
      for (let i = 0; i < 3; i++) order.push(...(await w1.claim(1)).map((c) => c.vault));
      expect(order).toEqual(["OVERDUE", "MINE", "THEIRS"]);
    });
  });
});
