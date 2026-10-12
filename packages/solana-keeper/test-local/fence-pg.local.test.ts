// The dispatcher's store against PostgreSQL 16: the seven tables of
// sql/sip_solana.sql, the four statements of src/dispatch-store.ts, and the races
// they exist to win (dispatcher ADR §3.4–3.7, §3.11, §4.9 rows 4, 6 and 8; safety
// §2.2; plan P3a Q1 and its design detail 1).
//
// RUN ONLY WITH A THROWAWAY DATABASE ON THE LOOPBACK. KEEPER_TEST_PG_URL names a
// server (a `docker run --rm postgres:16-alpine` with a generated password is what
// this was written against); a host that is not the loopback is refused. Each run
// creates its own database, applies the schema file to it, and drops it at the
// end, with the one role the connection-budget test creates. Without the variable
// the whole file is skipped and says why in its name.
//
//   KEEPER_TEST_PG_URL=postgresql://postgres:…@127.0.0.1:PORT/postgres \
//     pnpm --dir packages/solana-keeper exec vitest run -c vitest.local.config.ts test-local/fence-pg.local.test.ts
//
// THE SIGTERM DRILL is compressed by default (a 40 ms slot, a SIGTERM every 3 s,
// 30 of them). FENCE_PG_DRILL=full runs the ADR's own shape — real slot timing, a
// SIGTERM every 20 s for 10 minutes — and takes as long.
//
// WHAT IS REAL: Postgres 16 and its locks, the schema file, every statement the
// store sends, separate sessions per "process" (one pg.Pool each), real worker
// processes and real SIGTERMs in the drill. WHAT IS NOT: the chain, which is a
// table the drill advances (test-local/fence-drill-worker.ts says how).

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";
import pg from "pg";
import { Secret } from "@sip/solana-log";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CARRY_LOCK_CLASS, PgCarryStore, type CarryLink } from "../src/carry-store.js";
import {
  DispatchStore,
  LANE_PRIORITY,
  LEASE_SECONDS,
  createDispatchPool,
  dispatchConnections,
  type ClaimedVault,
  type DispatchWorld,
  type GateAnswer,
  type IntentDraft,
} from "../src/dispatch-store.js";

const URL_RAW = process.env["KEEPER_TEST_PG_URL"];
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const usable = ((): boolean => {
  if (URL_RAW === undefined || URL_RAW.trim() === "") return false;
  try {
    const host = new URL(URL_RAW).hostname;
    if (!LOOPBACK.has(host)) throw new Error("KEEPER_TEST_PG_URL must point at the loopback; it names another host");
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("KEEPER_TEST_PG_URL")) throw error;
    return false;
  }
})();

const SCHEMA_SQL = readFileSync(fileURLToPath(new URL("../sql/sip_solana.sql", import.meta.url)), "utf8");
/** The file as L2 left it: everything above the dispatcher's section. */
const DISPATCHER_SECTION = "-- ─── The dispatcher's tables";
const L2_ERA_SQL = SCHEMA_SQL.slice(0, SCHEMA_SQL.indexOf(DISPATCHER_SECTION));
const WORKER_FIXTURE = fileURLToPath(new URL("./fence-drill-worker.ts", import.meta.url));
const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** An intent as a worker would gate it; a fresh signature unless one is given. */
function draft(vault: string, fence: bigint, overrides: Partial<IntentDraft> = {}): IntentDraft {
  return {
    vault,
    fence,
    kind: "wrap",
    link: null,
    blockhash: "hash",
    lastValidBlockHeight: 1_000n,
    planClearedHeight: 500n,
    signature: randomUUID(),
    idempotencyKey: null,
    amountRaw: 1n,
    ...overrides,
  };
}

/** The two forms of the gate, each run through every race below. */
const GATE_FORMS: ReadonlyArray<readonly [string, (store: DispatchStore, intent: IntentDraft) => Promise<GateAnswer>]> = [
  ["the transaction", (store, intent) => store.gate(intent)],
  ["the one-statement CTE", (store, intent) => store.gateOneStatement(intent)],
];

describe.skipIf(!usable)("the dispatcher's store on Postgres 16 (needs KEEPER_TEST_PG_URL on the loopback)", () => {
  const database = `keeper_fence_${process.pid}_${Date.now()}`;
  let admin: pg.Pool;
  let db: pg.Pool;
  const pools: pg.Pool[] = [];
  const roles: string[] = [];
  const urlFor = (name: string, user?: { name: string; password: string }): string => {
    const url = new URL(URL_RAW!);
    url.pathname = `/${name}`;
    // A LOOPBACK CONTAINER SPEAKS NO TLS; createDispatchPool encrypts unless told so (sslFor).
    url.searchParams.set("sslmode", "disable");
    if (user !== undefined) {
      url.username = user.name;
      url.password = user.password;
    }
    return url.toString();
  };
  /** Every pool this file opens, ended before the database goes; each absorbs the FATAL a forced drop sends. */
  const tracked = <P extends pg.Pool>(pool: P): P => {
    pool.on("error", () => undefined);
    pools.push(pool);
    return pool;
  };
  /** A dispatcher process's pool exactly as production builds it (createDispatchPool). */
  const processPool = (name: string, kind: "worker" | "scheduler" = "worker", url = urlFor(database)): pg.Pool =>
    tracked(createDispatchPool(new Secret(url, "databaseUrl"), kind, `fence-pg:${name}`, () => undefined));
  /** One worker process: its own pool, its own sessions, its own worker_id. */
  const worker = (name: string, world: DispatchWorld = "live"): DispatchStore => new DispatchStore(processPool(name), name, world);

  async function seed(count: number, prefix: string, extra: { system?: string; dueIn?: number; lane?: string; priority?: number } = {}): Promise<string[]> {
    const { rows } = await db.query(
      `INSERT INTO sip_solana.vault_work (vault_addr, system, due_at, lane, priority)
       SELECT $1 || lpad(g::text, 4, '0'), $2, clock_timestamp() + make_interval(secs => $3), $4, $5
         FROM generate_series(1, $6) g
       RETURNING vault_addr`,
      [prefix, extra.system ?? "queue", extra.dueIn ?? -1, extra.lane ?? "new", extra.priority ?? LANE_PRIORITY.new, count],
    );
    return rows.map((row) => String(row.vault_addr)).sort();
  }
  /** Sets a vault's lease to end `seconds` from the database's clock (negative: already over). */
  const leaseIn = (vault: string, seconds: number) =>
    db.query("UPDATE sip_solana.vault_work SET lease_until = clock_timestamp() + make_interval(secs => $2) WHERE vault_addr = $1", [vault, seconds]);
  const row = async (vault: string) => (await db.query("SELECT * FROM sip_solana.vault_work WHERE vault_addr = $1", [vault])).rows[0];
  const intents = async (vault: string) => (await db.query("SELECT * FROM sip_solana.send_intent WHERE vault_addr = $1 ORDER BY id", [vault])).rows;
  const claimOne = async (store: DispatchStore, vault: string): Promise<ClaimedVault> => {
    const claimed = (await store.claim(10)).find((c) => c.vault === vault);
    if (claimed === undefined) throw new Error(`${store.holder} did not claim ${vault}`);
    return claimed;
  };
  /** Whether a backend of this database is waiting on a lock (a gate stuck behind a row lock). */
  const someoneWaitsOnALock = async (): Promise<boolean> =>
    (await db.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock'`, [database])).rows[0].n > 0;
  async function until(what: string, check: () => Promise<boolean>, ms = 5_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await sleep(20);
    }
  }

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: URL_RAW!, max: 2 });
    admin.on("error", () => undefined);
    await admin.query(`CREATE DATABASE ${database}`);
    db = tracked(new pg.Pool({ connectionString: urlFor(database), max: 8 }));
    // THE DATABASE AS L2 LEFT IT, WITH A CARRY IN IT, before the dispatcher's section is ever applied.
    await db.query(L2_ERA_SQL);
    const l2 = new PgCarryStore(tracked(new pg.Pool({ connectionString: urlFor(database), max: 1 })), "an L2 keeper");
    await l2.recordCarry(
      { linkAddress: new PublicKey(Buffer.alloc(32, 21)), epoch: 3n, settlementNonce: 7n, frontierSlot: 900n },
      1_200n,
      { lossLamports: 4_000n, walletSignedTxCount: 2 },
      { validUntilSlot: 1_300n, gate: null },
    );
    await db.query(SCHEMA_SQL);
    await db.query(SCHEMA_SQL);
    // TEST-ONLY INSTRUMENTS, in a schema of their own: a log of every fence change,
    // and a gate's COMMIT that stalls on the server (a deferred trigger that sleeps).
    await db.query(`
      CREATE SCHEMA fence_test;
      CREATE TABLE fence_test.claim_log (seq bigserial PRIMARY KEY, vault_addr text NOT NULL, fence bigint NOT NULL, holder text);
      CREATE FUNCTION fence_test.log_fence() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.fence IS DISTINCT FROM OLD.fence THEN
          INSERT INTO fence_test.claim_log (vault_addr, fence, holder) VALUES (NEW.vault_addr, NEW.fence, NEW.holder);
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER log_fence AFTER UPDATE ON sip_solana.vault_work FOR EACH ROW EXECUTE FUNCTION fence_test.log_fence();
      CREATE FUNCTION fence_test.stall_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.idempotency_key LIKE 'stall-commit:%' THEN PERFORM pg_sleep(split_part(NEW.idempotency_key, ':', 2)::double precision); END IF;
        RETURN NULL;
      END $$;
      CREATE CONSTRAINT TRIGGER stall_commit AFTER INSERT ON sip_solana.send_intent DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION fence_test.stall_commit();
    `);
  });

  afterAll(async () => {
    vi.useRealTimers();
    // BOUNDED: a pool whose client a failed test never handed back would wait for
    // it forever, and the database would outlive the run. The forced drop below
    // ends whatever is still connected.
    for (const pool of pools) await Promise.race([pool.end().catch(() => undefined), sleep(2_000)]);
    if (admin !== undefined) {
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`).catch(() => undefined);
      for (const role of roles) await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
      await admin.end();
    }
  });

  beforeEach(async () => {
    // EVERY TEST STARTS FROM EMPTY QUEUE TABLES. A throwaway database; L2's carry row is kept for the schema test.
    await db.query("TRUNCATE sip_solana.vault_work, sip_solana.send_intent, sip_solana.worker, fence_test.claim_log");
    await db.query("DELETE FROM sip_solana.loss_carry WHERE written_by <> 'an L2 keeper'");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("the schema", () => {
    it("lands on a database L2 already wrote to, twice, adds the seven tables, and keeps L2's carry row whole", async () => {
      const tables = await db.query(
        `SELECT t.name, to_regclass('sip_solana.' || t.name) IS NOT NULL AS present
           FROM unnest($1::text[]) AS t(name)`,
        [["keeper_link", "vault_work", "send_intent", "loss_carry", "worker", "rpc_usage", "fleet"]],
      );
      expect(tables.rows.every((t) => t.present), JSON.stringify(tables.rows)).toBe(true);
      const carry = await db.query(`SELECT * FROM sip_solana.loss_carry WHERE written_by = 'an L2 keeper'`);
      expect(carry.rows).toHaveLength(1);
      expect(carry.rows[0]).toMatchObject({ settlement_nonce: "8", frontier_slot: "1200", loss_lamports: "4000", written_fence: null, send_intent_id: null });
      // L2'S STORE READS AND WRITES THE TABLE AS IT DID: its INSERT names none of the new columns.
      const l2 = new PgCarryStore(tracked(new pg.Pool({ connectionString: urlFor(database), max: 1 })), "an L2 keeper");
      expect((await l2.ready()).ok).toBe(true);
      expect(
        await l2.carryFor({ linkAddress: new PublicKey(Buffer.alloc(32, 21)), epoch: 3n, settlementNonce: 8n, frontierSlot: 1_200n }),
      ).toEqual({ lossLamports: 4_000n, walletSignedTxCount: 2 });
      const fleet = await db.query("SELECT * FROM sip_solana.fleet");
      expect(fleet.rows).toEqual([expect.objectContaining({ id: true, new_vault_system: "legacy", full_pass_reason: null })]);
    });

    it("refuses rows the design cannot have: an unknown system or state, a holder without a lease, a resolution without a time, one signature twice", async () => {
      await expect(db.query(`INSERT INTO sip_solana.vault_work (vault_addr, system) VALUES ('x', 'queued')`)).rejects.toThrow(/vault_work_system_check/);
      await expect(db.query(`INSERT INTO sip_solana.vault_work (vault_addr, holder) VALUES ('x', 'w')`)).rejects.toThrow(/vault_work_held_has_lease/);
      const insert = (state: string, signature: string | null, resolved: boolean) =>
        db.query(
          `INSERT INTO sip_solana.send_intent (vault_addr, kind, fence, worker_id, blockhash, last_valid_block_height, signature, state, resolved_at)
           VALUES ('v', 'wrap', 1, 'w', 'h', 10, $1, $2, CASE WHEN $3 THEN clock_timestamp() END)`,
          [signature, state, resolved],
        );
      await expect(insert("sent", "s0", true)).rejects.toThrow(/send_intent_state_check/);
      await expect(insert("landed", "s1", false)).rejects.toThrow(/send_intent_resolved_has_time/);
      await expect(insert("intent", "s2", true)).rejects.toThrow(/send_intent_open_is_unresolved/);
      // A PRIVY SETTLE'S SIGNATURE IS UNKNOWN UNTIL PRIVY ANSWERS: several NULLs are fine, one signature twice is not.
      await insert("intent", null, false);
      await insert("intent", null, false);
      await insert("intent", "dup", false);
      await expect(insert("intent", "dup", false)).rejects.toThrow(/send_intent_signature_key/);
      await expect(
        db.query(
          `INSERT INTO sip_solana.send_intent (vault_addr, kind, fence, worker_id, blockhash, last_valid_block_height) VALUES ('v', 'settle', 1, 'w', 'h', 10)`,
        ),
      ).rejects.toThrow(/send_intent_settle_has_link/);
    });
  });

  describe("CLAIM", () => {
    it("many processes claiming at once: every due vault goes to exactly one, at fence 1, and nothing else is taken", async () => {
      const due = await seed(120, "due-");
      await seed(5, "later-", { dueIn: 3_600 });
      await seed(5, "legacy-", { system: "legacy" });
      await seed(5, "draining-", { system: "draining" });
      const parked = await seed(5, "parked-");
      await db.query("UPDATE sip_solana.vault_work SET parked_reason = 'five expiries' WHERE vault_addr = ANY($1)", [parked]);
      const claimers = Array.from({ length: 24 }, (_, i) => worker(`claimer-${i}`));
      const taken = await Promise.all(
        claimers.map(async (store) => {
          const mine: ClaimedVault[] = [];
          for (;;) {
            const got = await store.claim(3);
            if (got.length === 0) return mine;
            mine.push(...got);
          }
        }),
      );
      const all = taken.flat();
      expect(all.map((c) => c.vault).sort()).toEqual(due);
      expect(new Set(all.map((c) => c.vault)).size, "no vault claimed twice").toBe(all.length);
      expect(all.every((c) => c.fence === 1n && c.attempts === 1)).toBe(true);
      expect(taken.filter((mine) => mine.length > 0).length, "the work spread over the processes").toBeGreaterThan(1);
      const held = await db.query(`SELECT holder, count(*)::int AS n FROM sip_solana.vault_work WHERE holder IS NOT NULL GROUP BY holder`);
      expect(held.rows.reduce((sum, r) => sum + r.n, 0)).toBe(120);
    });

    it("when leases run out, the old holders' heartbeats and the new claims race, and each vault ends renewed or re-claimed, never both", async () => {
      const vaults = await seed(60, "race-");
      const old = Array.from({ length: 6 }, (_, i) => worker(`old-${i}`));
      const held = await Promise.all(old.map((store) => store.claim(10)));
      expect(held.flat()).toHaveLength(60);
      await db.query("UPDATE sip_solana.vault_work SET lease_until = clock_timestamp() - interval '1 second'");
      const fresh = Array.from({ length: 6 }, (_, i) => worker(`new-${i}`));
      const [renewed, reclaimed] = await Promise.all([
        Promise.all(old.map((store, i) => store.heartbeat(held[i]!))),
        Promise.all(
          fresh.map(async (store) => {
            const mine: ClaimedVault[] = [];
            for (;;) {
              const got = await store.claim(2);
              if (got.length === 0) return mine;
              mine.push(...got);
            }
          }),
        ),
      ]);
      const renewedSet = new Set(renewed.flatMap((set) => [...set]));
      const reclaimedSet = new Set(reclaimed.flat().map((c) => c.vault));
      expect([...renewedSet].filter((v) => reclaimedSet.has(v)), "renewed and re-claimed").toEqual([]);
      expect([...renewedSet, ...reclaimedSet].sort()).toEqual(vaults);
      for (const c of reclaimed.flat()) expect(c.fence).toBe(2n);
      const rows = await db.query("SELECT vault_addr, holder, fence FROM sip_solana.vault_work");
      for (const r of rows.rows) {
        if (reclaimedSet.has(r.vault_addr)) expect(r).toMatchObject({ fence: "2", holder: expect.stringMatching(/^new-/) });
        else expect(r).toMatchObject({ fence: "1", holder: expect.stringMatching(/^old-/) });
      }
    });

    it("the fence grows by exactly one on every claim, whoever claims, and complete, release and a stale holder never move it", async () => {
      const vaults = await seed(8, "fence-");
      const stores = Array.from({ length: 6 }, (_, i) => worker(`f-${i}`));
      const claims = new Map<string, bigint[]>(vaults.map((v) => [v, []]));
      let staleRefused = 0;
      const lastHolder = new Map<string, { store: DispatchStore; claimed: ClaimedVault }>();
      for (let round = 0; round < 25; round++) {
        const got = await Promise.all(stores.map(async (store) => ({ store, claimed: await store.claim(2) })));
        await Promise.all(
          got.flatMap(({ store, claimed }) =>
            claimed.map(async (c) => {
              claims.get(c.vault)!.push(c.fence);
              const previous = lastHolder.get(c.vault);
              if (previous !== undefined) {
                // THE HOLDER BEFORE: its complete and its heartbeat change nothing now.
                if (await previous.store.complete(previous.claimed, { rests: false, lane: "new", streaks: {}, outcome: "STALE", detail: null, dueInSeconds: 0 })) {
                  throw new Error("a stale complete was accepted");
                }
                staleRefused += 1;
              }
              lastHolder.set(c.vault, { store, claimed: c });
              const pick = Math.floor(Math.random() * 3);
              if (pick === 0) await store.complete(c, { rests: false, lane: "new", streaks: {}, outcome: "DONE", detail: null, dueInSeconds: 0 });
              else if (pick === 1) await store.release(c, "test");
              else await leaseIn(c.vault, -1);
            }),
          ),
        );
      }
      expect(staleRefused).toBeGreaterThan(0);
      for (const vault of vaults) {
        const fences = claims.get(vault)!;
        expect(fences.length).toBeGreaterThan(3);
        expect(fences, vault).toEqual(fences.map((_, i) => BigInt(i + 1)));
        // THE DATABASE'S OWN RECORD OF EVERY FENCE CHANGE, in commit order: 1, 2, 3, … and one per claim.
        const log = await db.query("SELECT fence FROM fence_test.claim_log WHERE vault_addr = $1 ORDER BY seq", [vault]);
        expect(log.rows.map((r) => BigInt(r.fence))).toEqual(fences);
        expect(BigInt((await row(vault)).fence)).toBe(fences.at(-1));
      }
    });

    it("takes the most urgent lane first, then its own last vaults, then the oldest due", async () => {
      await db.query(
        `INSERT INTO sip_solana.vault_work (vault_addr, system, lane, priority, due_at, last_holder) VALUES
           ('safety-old', 'queue', 'safety', 4, clock_timestamp() - interval '9 minutes', NULL),
           ('new-mine',   'queue', 'new',    2, clock_timestamp() - interval '1 minute',  'me'),
           ('new-old',    'queue', 'new',    2, clock_timestamp() - interval '5 minutes', 'someone'),
           ('bell',       'queue', 'bell',   0, clock_timestamp() - interval '1 second',  NULL)`,
      );
      const me = worker("me");
      const order: string[] = [];
      for (let i = 0; i < 4; i++) order.push(...(await me.claim(1)).map((c) => c.vault));
      expect(order).toEqual(["bell", "new-mine", "new-old", "safety-old"]);
    });
  });

  describe("HEARTBEAT", () => {
    it("renews only this process's own (vault, fence) pairs, to 45 s by the database's clock, and nothing past the six-minute ceiling", async () => {
      const [a, b, c, other] = await seed(4, "hb-");
      const me = worker("hb-me");
      const them = worker("hb-them");
      const mine = await me.claim(3);
      const theirs = await claimOne(them, other!);
      await db.query("UPDATE sip_solana.vault_work SET claimed_at = clock_timestamp() - interval '6 minutes 1 second' WHERE vault_addr = $1", [c]);
      const renewed = await me.heartbeat([
        ...mine,
        { vault: a!, fence: 99n }, // a fence that is not the row's
        theirs, // another holder's vault
      ]);
      expect([...renewed].sort()).toEqual([a, b].sort());
      const left = await db.query(
        `SELECT vault_addr, extract(epoch FROM lease_until - clock_timestamp())::float AS s FROM sip_solana.vault_work WHERE vault_addr = ANY($1)`,
        [[a, b]],
      );
      for (const r of left.rows) expect(r.s).toBeGreaterThan(LEASE_SECONDS - 2);
      // PAST THE CEILING THE LEASE RUNS OUT, AND THE JOB'S NEXT GATE FAILS.
      await leaseIn(c!, 11);
      expect(await me.heartbeat(mine.filter((m) => m.vault === c))).toEqual(new Set());
      await leaseIn(c!, -1);
      const stuck = mine.find((m) => m.vault === c)!;
      expect((await me.gate(draft(c!, stuck.fence))).kind).toBe("refused");
    });
  });

  describe.each(GATE_FORMS)("GATE, %s form", (form, gateWith) => {
    it("refuses a holder whose vault was taken over, writes nothing, and that holder's COMPLETE and HEARTBEAT change nothing", async () => {
      const [vault] = await seed(1, `stale-${form}-`);
      const a = worker("stale-a");
      const b = worker("stale-b");
      const first = await claimOne(a, vault!);
      await leaseIn(vault!, -1);
      const second = await claimOne(b, vault!);
      expect(second.fence).toBe(first.fence + 1n);
      const answer = await gateWith(a, draft(vault!, first.fence));
      expect(answer.kind).toBe("refused");
      expect(await intents(vault!)).toEqual([]);
      expect(await a.complete(first, { rests: true, lane: "new", streaks: {}, outcome: "STALE", detail: null, dueInSeconds: 999 })).toBe(false);
      expect(await a.heartbeat([first])).toEqual(new Set());
      expect(await row(vault!)).toMatchObject({ holder: "stale-b", fence: "2", rests: false });
      // NOR CAN ANOTHER PROCESS GATE AT THE HOLDER'S FENCE: the fence is the holder's, not a password.
      expect((await gateWith(worker("stale-c"), draft(vault!, second.fence))).kind).toBe("refused");
      expect((await gateWith(b, draft(vault!, second.fence))).kind).toBe("gated");
      expect((await intents(vault!)).map((i) => [i.worker_id, i.fence])).toEqual([["stale-b", "2"]]);
    });

    it("refuses with 10 s or less left on the lease, and passes with more", async () => {
      const [vault] = await seed(1, `margin-${form}-`);
      const a = worker("margin");
      const held = await claimOne(a, vault!);
      await leaseIn(vault!, 9);
      expect((await gateWith(a, draft(vault!, held.fence))).kind).toBe("refused");
      await leaseIn(vault!, 12);
      expect((await gateWith(a, draft(vault!, held.fence))).kind).toBe("gated");
    });

    it("a gate waiting on the row behind a write that moves the fence judges the NEW row, and refuses (FOR SHARE)", async () => {
      const [vault] = await seed(1, `moved-${form}-`);
      const a = worker("moved-a");
      const held = await claimOne(a, vault!);
      const writer = await db.connect();
      try {
        await writer.query("BEGIN");
        // ANY WRITE THAT HANDS THE VAULT ON: here the reaper's, with the lease still looking fine to the gate's snapshot.
        await writer.query(
          `UPDATE sip_solana.vault_work SET holder = 'moved-b', fence = fence + 1, claimed_at = clock_timestamp(),
                  lease_until = clock_timestamp() + interval '45 seconds' WHERE vault_addr = $1`,
          [vault],
        );
        const pending = gateWith(a, draft(vault!, held.fence));
        await until("the gate to wait on the row lock", someoneWaitsOnALock);
        await writer.query("COMMIT");
        expect((await pending).kind).toBe("refused");
      } finally {
        writer.release();
      }
      expect(await intents(vault!)).toEqual([]);
    });

    it("while a gate's COMMIT stalls past the end of the lease, a claim skips the vault; the next claim sees the intent and must wait for it", async () => {
      // THE STALLED COMMIT S-3 IS ABOUT. The gate passes with just over the margin;
      // then its commit stalls on the server for 12 s, where no statement_timeout
      // reaches (Postgres disarms it before it commits), and this side gives up at
      // its own 5 s bound. The row stays locked until the commit lands.
      const [vault] = await seed(1, `stall-${form}-`);
      const a = worker("stall-a");
      const b = worker("stall-b");
      const held = await claimOne(a, vault!);
      await leaseIn(vault!, 10.6);
      const answer = await gateWith(a, draft(vault!, held.fence, { idempotencyKey: "stall-commit:12", lastValidBlockHeight: 4_242n }));
      expect(answer.kind, "nothing is sent on a commit nobody acknowledged").toBe("unacknowledged");
      await until("the lease to run out", async () => (await db.query("SELECT lease_until < clock_timestamp() AS over FROM sip_solana.vault_work WHERE vault_addr = $1", [vault])).rows[0].over, 12_000);
      expect(await intents(vault!), "the stalled commit has not landed yet").toEqual([]);
      expect(await b.claim(5), "a claim while the gate still holds the row").toEqual([]);
      await until("the stalled commit to land", async () => (await intents(vault!)).length === 1, 8_000);
      const next = await claimOne(b, vault!);
      expect(next.fence).toBe(held.fence + 1n);
      const prior = await b.priorIntents(next);
      expect(prior.open.map((o) => [o.fence, o.worker, o.lastValidBlockHeight])).toEqual([[held.fence, "stall-a", 4_242n]]);
      expect(prior.planFloor).toBe(4_242n);
    }, 30_000);

    it("a gate that waited behind an update judges the lease when it gets the row (clock_timestamp), not when it began (now())", async () => {
      const [vault] = await seed(1, `clock-${form}-`);
      const a = worker("clock-a");
      const held = await claimOne(a, vault!);
      await leaseIn(vault!, 13);
      const writer = await db.connect();
      try {
        await writer.query("BEGIN");
        // THE SCHEDULER RINGING THE BELL: a write that keeps the holder and the fence.
        await writer.query("UPDATE sip_solana.vault_work SET bell_at = clock_timestamp() WHERE vault_addr = $1", [vault]);
        const pending = gateWith(a, draft(vault!, held.fence));
        await until("the gate to wait on the row lock", someoneWaitsOnALock);
        await sleep(4_000);
        await writer.query("COMMIT");
        // 13 s LEFT WHEN IT BEGAN, 9 WHEN IT GOT THE ROW: under the margin.
        expect((await pending).kind).toBe("refused");
      } finally {
        writer.release();
      }
      expect(await intents(vault!)).toEqual([]);
    }, 15_000);

    it("a gate that waited on a lock released WITHOUT a write goes on: the row is the one it judged, and nobody could take it meanwhile", async () => {
      // DOCUMENTED, NOT DEFENDED: Postgres re-judges a row only when it has a new
      // version. A lock taken and given back unchanged (a claim that gave up) leaves
      // the row as the gate first read it, and no claim can commit while the lock
      // is held — the fence is still this worker's.
      const [vault] = await seed(1, `nowrite-${form}-`);
      const a = worker("nowrite-a");
      const held = await claimOne(a, vault!);
      await leaseIn(vault!, 30);
      const locker = await db.connect();
      try {
        await locker.query("BEGIN");
        await locker.query("SELECT 1 FROM sip_solana.vault_work WHERE vault_addr = $1 FOR UPDATE", [vault]);
        const pending = gateWith(a, draft(vault!, held.fence));
        await until("the gate to wait on the row lock", someoneWaitsOnALock);
        await locker.query("ROLLBACK");
        expect((await pending).kind).toBe("gated");
      } finally {
        locker.release();
      }
    });
  });

  describe("GATE: a COMMIT that is never acknowledged (ADR §4.9 row 4)", () => {
    it("sends nothing; the row it may still have committed is there for the successor, who waits out its blockhash", async () => {
      const [vault] = await seed(1, "unacked-");
      // AN ACKNOWLEDGEMENT THAT NEVER ARRIVES: this side stops listening after 2 s
      // while the server, allowed 10, finishes the COMMIT — the network lost the answer.
      const deaf = tracked(new pg.Pool({ connectionString: urlFor(database), max: 2, query_timeout: 2_000, statement_timeout: 10_000 }));
      const a = new DispatchStore(deaf, "unacked-a");
      const b = worker("unacked-b");
      const held = await claimOne(a, vault!);
      const answer = await a.gate(draft(vault!, held.fence, { idempotencyKey: "stall-commit:4", lastValidBlockHeight: 7_777n }));
      expect(answer.kind).toBe("unacknowledged");
      expect(await intents(vault!), "not committed yet when the gate gave up").toEqual([]);
      await until("the late commit", async () => (await intents(vault!)).length === 1, 6_000);
      await leaseIn(vault!, -1);
      const next = await claimOne(b, vault!);
      const prior = await b.priorIntents(next);
      expect(prior.open.map((o) => o.lastValidBlockHeight)).toEqual([7_777n]);
      expect(prior.planFloor).toBe(7_777n);
    }, 20_000);

    it("a backend terminated during COMMIT is reported unacknowledged, never gated", async () => {
      const [vault] = await seed(1, "killed-");
      const a = worker("killed-a");
      const held = await claimOne(a, vault!);
      const pending = a.gate(draft(vault!, held.fence, { idempotencyKey: "stall-commit:4" }));
      await until("the commit to stall", async () =>
        (await db.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND wait_event = 'PgSleep'`, [database])).rows[0].n > 0,
      );
      await db.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND wait_event = 'PgSleep'`, [database]);
      const answer = await pending;
      expect(answer.kind).toBe("unacknowledged");
    }, 15_000);
  });

  describe("GATE: the carry write-ahead of a PROFIT settle (ADR §4.6, S-4)", () => {
    const link = (fill: number, nonce: bigint): CarryLink => ({
      linkAddress: new PublicKey(Buffer.alloc(32, fill)),
      epoch: 5n,
      settlementNonce: nonce,
      frontierSlot: 100n * nonce,
    });
    const settle = (vault: string, fence: bigint, carryLink: CarryLink): IntentDraft =>
      draft(vault, fence, { kind: "settle", link: carryLink.linkAddress.toBase58(), signature: null, idempotencyKey: `settle:${fence}` });
    const carries = async (fill: number) =>
      (
        await db.query(
          `SELECT settlement_nonce, frontier_slot, loss_lamports, written_by, written_fence, send_intent_id
             FROM sip_solana.loss_carry WHERE link_addr = $1 ORDER BY settlement_nonce`,
          [new PublicKey(Buffer.alloc(32, fill)).toBase58()],
        )
      ).rows;

    it("commits with the intent, stamped with its fence and intent, deletes the link's other states, and L2's reader finds it", async () => {
      const [vault] = await seed(1, "carry-");
      const a = worker("carry-a");
      const held = await claimOne(a, vault!);
      const from = link(31, 4n);
      await db.query(
        `INSERT INTO sip_solana.loss_carry (link_addr, epoch, settlement_nonce, frontier_slot, loss_lamports, wallet_signed_tx_count, valid_until_slot, written_by)
         VALUES ($1, 5, 2, 200, 77, 1, 1, 'older'), ($1, 5, 4, 400, 88, 1, 1, 'current')`,
        [from.linkAddress.toBase58()],
      );
      const answer = await a.gate(settle(vault!, held.fence, from), {
        carry: { link: from, endSlot: 450n, carry: { lossLamports: 1_000n, walletSignedTxCount: 3 }, validUntilSlot: 600n },
      });
      expect(answer).toMatchObject({ kind: "gated", carryWritten: true });
      const id = answer.kind === "gated" ? answer.intentId.toString() : "";
      expect(await carries(31)).toEqual([
        { settlement_nonce: "4", frontier_slot: "400", loss_lamports: "88", written_by: "current", written_fence: null, send_intent_id: null },
        { settlement_nonce: "5", frontier_slot: "450", loss_lamports: "1000", written_by: "carry-a", written_fence: held.fence.toString(), send_intent_id: id },
      ]);
      const l2 = new PgCarryStore(tracked(new pg.Pool({ connectionString: urlFor(database), max: 1 })), "reader");
      expect(await l2.carryFor({ ...from, settlementNonce: 5n, frontierSlot: 450n })).toEqual({ lossLamports: 1_000n, walletSignedTxCount: 3 });
      // A PRIVY SETTLE IS GATED WITHOUT ITS SIGNATURE, AND GETS IT ONCE, WHEN PRIVY ANSWERS.
      const intentId = answer.kind === "gated" ? answer.intentId : -1n;
      expect((await intents(vault!))[0]).toMatchObject({ signature: null, idempotency_key: `settle:${held.fence}` });
      expect(await a.recordSignature(intentId, "PrivySig1")).toBe(true);
      expect(await a.recordSignature(intentId, "PrivySig2"), "a second answer never overwrites the first").toBe(false);
      expect((await intents(vault!))[0]).toMatchObject({ signature: "PrivySig1" });
    });

    it("writes nothing when the gate refuses, and nothing at all when the carry cannot be written", async () => {
      const [vault] = await seed(1, "carry-fail-");
      const a = worker("carry-fail-a");
      const b = worker("carry-fail-b");
      const held = await claimOne(a, vault!);
      const from = link(32, 4n);
      await db.query(
        `INSERT INTO sip_solana.loss_carry (link_addr, epoch, settlement_nonce, frontier_slot, loss_lamports, wallet_signed_tx_count, valid_until_slot, written_by)
         VALUES ($1, 5, 3, 300, 66, 1, 1, 'kept')`,
        [from.linkAddress.toBase58()],
      );
      // THE CARRY'S OWN INSERT FAILS (a negative count the CHECK refuses): the intent goes with it.
      const broken = await a.gate(settle(vault!, held.fence, from), {
        carry: { link: from, endSlot: 450n, carry: { lossLamports: 10n, walletSignedTxCount: -1 }, validUntilSlot: 600n },
      });
      expect(broken.kind).toBe("unavailable");
      expect(await intents(vault!)).toEqual([]);
      expect((await carries(32)).map((c) => c.written_by)).toEqual(["kept"]);
      // A STALE HOLDER: refused, and its carry is not written either.
      await leaseIn(vault!, -1);
      await claimOne(b, vault!);
      const stale = await a.gate(settle(vault!, held.fence, from), {
        carry: { link: from, endSlot: 450n, carry: { lossLamports: 10n, walletSignedTxCount: 1 }, validUntilSlot: 600n },
      });
      expect(stale.kind).toBe("refused");
      expect((await carries(32)).map((c) => c.written_by)).toEqual(["kept"]);
    });

    it("waits on the link's advisory lock, as L2's writer does, so the two never interleave on one link", async () => {
      const [vault] = await seed(1, "carry-lock-");
      const a = worker("carry-lock-a");
      const held = await claimOne(a, vault!);
      const from = link(35, 4n);
      const other = await db.connect();
      try {
        await other.query("BEGIN");
        await other.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [CARRY_LOCK_CLASS, from.linkAddress.toBase58()]);
        let settled = false;
        const pending = a
          .gate(settle(vault!, held.fence, from), { carry: { link: from, endSlot: 450n, carry: { lossLamports: 9n, walletSignedTxCount: 1 }, validUntilSlot: 600n } })
          .finally(() => {
            settled = true;
          });
        await until("the gate to wait on the link's lock", someoneWaitsOnALock);
        expect(settled).toBe(false);
        await other.query("COMMIT");
        expect((await pending).kind).toBe("gated");
      } finally {
        other.release();
      }
    });

    it("leaves the same rows L2's PgCarryStore leaves, over the same sequence of settles", async () => {
      const vaults = await seed(1, "agree-");
      const a = worker("agree-a");
      const l2 = new PgCarryStore(tracked(new pg.Pool({ connectionString: urlFor(database), max: 1 })), "agree-l2");
      const at = (fill: number, nonce: bigint, frontierSlot: bigint): CarryLink => ({ linkAddress: new PublicKey(Buffer.alloc(32, fill)), epoch: 5n, settlementNonce: nonce, frontierSlot });
      const shape = async (fill: number) =>
        (await carries(fill)).map(({ settlement_nonce, frontier_slot, loss_lamports }) => [settlement_nonce, frontier_slot, loss_lamports]);
      let state = { nonce: 1n, frontier: 100n };
      let kept = 0;
      for (let step = 0; step < 16; step++) {
        const held = await claimOne(a, vaults[0]!);
        const loss = step % 3 === 2 ? null : { lossLamports: BigInt(100 + step), walletSignedTxCount: step };
        const endSlot = state.frontier + 50n + BigInt(step);
        const gated = await a.gate(settle(vaults[0]!, held.fence, at(33, state.nonce, state.frontier)), {
          carry: { link: at(33, state.nonce, state.frontier), endSlot, carry: loss, validUntilSlot: 9n },
        });
        expect(gated.kind).toBe("gated");
        await l2.recordCarry(at(34, state.nonce, state.frontier), endSlot, loss, { validUntilSlot: 9n, gate: null });
        await a.complete(held, { rests: false, lane: "new", streaks: {}, outcome: "SETTLED", detail: null, dueInSeconds: 0 });
        expect(await shape(33), `step ${step}`).toEqual(await shape(34));
        if ((await carries(33)).some((c) => c.settlement_nonce === state.nonce.toString())) kept += 1;
        // THE NEXT SETTLE STARTS FROM THE STATE THIS ONE LEFT, OR FROM THE SAME ONE (a settle that did not land).
        if (step % 4 !== 3) state = { nonce: state.nonce + 1n, frontier: endSlot };
      }
      expect(kept, "the current state's row was kept by both, some of the time").toBeGreaterThan(0);
    });
  });

  describe("shadow-intents (plan P3a design detail 1)", () => {
    it("a shadow job gates exactly as a live one, writes 'shadow' rows and no carry, and the overlap audit runs over them", async () => {
      const [vault] = await seed(1, "shadow-");
      const a = worker("shadow-a", "shadow");
      const b = worker("shadow-b", "shadow");
      const c = worker("shadow-c", "shadow");
      const first = await claimOne(a, vault!);
      const gated = await a.gate(draft(vault!, first.fence, { lastValidBlockHeight: 1_000n, planClearedHeight: 10n }), {
        carry: { link: { linkAddress: new PublicKey(Buffer.alloc(32, 41)), epoch: 1n, settlementNonce: 1n, frontierSlot: 1n }, endSlot: 2n, carry: { lossLamports: 5n, walletSignedTxCount: 1 }, validUntilSlot: 3n },
      });
      expect(gated).toMatchObject({ kind: "gated", carryWritten: false });
      expect((await db.query("SELECT count(*)::int AS n FROM sip_solana.loss_carry WHERE link_addr = $1", [new PublicKey(Buffer.alloc(32, 41)).toBase58()])).rows[0].n).toBe(0);
      expect((await intents(vault!)).map((i) => i.state)).toEqual(["shadow"]);
      // A SHADOW HOLDER THAT LOST THE VAULT IS REFUSED AS A LIVE ONE IS.
      await leaseIn(vault!, -1);
      const second = await claimOne(b, vault!);
      expect((await a.gate(draft(vault!, first.fence))).kind).toBe("refused");
      // THE SUCCESSOR WAITS IT OUT AS IF IT HAD BEEN SENT, resolves it, and the row stays 'shadow'.
      const prior = await b.priorIntents(second);
      expect(prior.open.map((o) => o.state)).toEqual(["shadow"]);
      expect(prior.planFloor).toBe(1_000n);
      expect(await b.resolveIntent(prior.open[0]!.id, "expired", 1_000n)).toBe(true);
      expect(await b.resolveIntent(prior.open[0]!.id, "landed", 1_000n), "a second resolution").toBe(false);
      expect((await intents(vault!))[0]).toMatchObject({ state: "shadow", resolved_height: "1000" });
      expect(await b.gate(draft(vault!, second.fence, { lastValidBlockHeight: 2_000n, planClearedHeight: 1_001n }))).toMatchObject({ kind: "gated" });
      expect(await b.overlapAudit()).toEqual([]);
      // A PLANTED OVERLAP: a third holder plans before the second's intent could have expired.
      await leaseIn(vault!, -1);
      const third = await claimOne(c, vault!);
      const planted = await c.gate(draft(vault!, third.fence, { planClearedHeight: 1_500n }));
      expect(planted.kind).toBe("gated");
      expect(await c.overlapAudit()).toEqual([planted.kind === "gated" ? planted.intentId : -1n]);
    });
  });

  describe("COMPLETE and RELEASE", () => {
    it("is due again after the delay by the database's clock; a bell rung during the turn makes it due at once; release is due at once and keeps the fence", async () => {
      const [vault] = await seed(1, "complete-");
      const a = worker("complete-a");
      const dueIn = async () => (await db.query("SELECT extract(epoch FROM due_at - clock_timestamp())::float AS s FROM sip_solana.vault_work WHERE vault_addr = $1", [vault])).rows[0].s as number;
      let held = await claimOne(a, vault!);
      expect(await a.complete(held, { rests: true, lane: "safety", streaks: { w: 1 }, outcome: "REST", detail: "resting", dueInSeconds: 600 })).toBe(true);
      expect(await dueIn()).toBeGreaterThan(598);
      expect(await row(vault!)).toMatchObject({ holder: null, lease_until: null, last_holder: "complete-a", attempts: 0, rests: true, lane: "safety", priority: 4, streaks: { w: 1 }, last_outcome: "REST" });
      await db.query("UPDATE sip_solana.vault_work SET due_at = clock_timestamp() - interval '1 second' WHERE vault_addr = $1", [vault]);
      held = await claimOne(a, vault!);
      await db.query("UPDATE sip_solana.vault_work SET bell_at = clock_timestamp() WHERE vault_addr = $1", [vault]);
      await a.complete(held, { rests: true, lane: "safety", streaks: {}, outcome: "REST", detail: null, dueInSeconds: 600 });
      expect(await dueIn()).toBeLessThan(1);
      held = await claimOne(a, vault!);
      expect(await a.release(held, "SIGTERM")).toBe(true);
      expect(await dueIn()).toBeLessThan(1);
      expect(await row(vault!)).toMatchObject({ holder: null, fence: "3", lane: "safety", priority: 4, rests: false, last_outcome: "RELEASED", last_detail: "SIGTERM" });
    });
  });

  describe("clock skew (ADR §4.9 row 8)", () => {
    it("a worker whose clock is 10 minutes fast or slow claims, renews, gates and completes exactly as one with the right time", async () => {
      // EACH WORKER ALSO TALKS IN ITS OWN SESSION TIME ZONE: timestamptz comparisons must not care.
      const outcomes: string[] = [];
      for (const [label, skewMs, zone] of [
        ["right", 0, "UTC"],
        ["fast", 10 * 60_000, "Pacific/Kiritimati"],
        ["slow", -10 * 60_000, "America/Adak"],
      ] as const) {
        await db.query("TRUNCATE sip_solana.vault_work, sip_solana.send_intent");
        await db.query(
          `INSERT INTO sip_solana.vault_work (vault_addr, system, due_at, holder, fence, lease_until, claimed_at) VALUES
             ('due-now',    'queue', clock_timestamp() - interval '1 second', NULL, 0, NULL, NULL),
             ('due-in-5m',  'queue', clock_timestamp() + interval '5 minutes', NULL, 0, NULL, NULL),
             ('lease-over', 'queue', clock_timestamp() - interval '1 minute', 'gone', 4, clock_timestamp() - interval '1 minute', clock_timestamp() - interval '2 minutes'),
             ('lease-live', 'queue', clock_timestamp() - interval '1 minute', 'alive', 4, clock_timestamp() + interval '1 minute', clock_timestamp())`,
        );
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(Date.now() + skewMs);
        const pool = tracked(
          new pg.Pool({ connectionString: urlFor(database), max: 2, options: `-c TimeZone=${zone}`, statement_timeout: 5_000, query_timeout: 5_000 }),
        );
        const store = new DispatchStore(pool, `skew-${label}`);
        const claimed = await store.claim(10);
        const leases = await db.query(
          `SELECT vault_addr, round(extract(epoch FROM lease_until - clock_timestamp()))::int AS s FROM sip_solana.vault_work WHERE holder = $1 ORDER BY 1`,
          [`skew-${label}`],
        );
        const renewed = await store.heartbeat(claimed);
        const held = claimed.find((c) => c.vault === "due-now")!;
        await leaseIn("due-now", 20);
        const passes = (await store.gate(draft("due-now", held.fence))).kind;
        await leaseIn("due-now", 5);
        const refused = (await store.gate(draft("due-now", held.fence))).kind;
        await leaseIn("due-now", 30);
        await store.complete(held, { rests: false, lane: "new", streaks: {}, outcome: "DONE", detail: null, dueInSeconds: 60 });
        const due = await db.query("SELECT round(extract(epoch FROM due_at - clock_timestamp()))::int AS s FROM sip_solana.vault_work WHERE vault_addr = 'due-now'");
        vi.useRealTimers();
        outcomes.push(
          JSON.stringify({
            claimed: claimed.map((c) => `${c.vault}@${c.fence}`).sort(),
            leases: leases.rows.map((r) => `${r.vault_addr}:${r.s}`),
            renewed: [...renewed].sort(),
            passes,
            refused,
            due: due.rows[0].s,
          }),
        );
      }
      expect(JSON.parse(outcomes[0]!)).toEqual({
        claimed: ["due-now@1", "lease-over@5"],
        leases: [`due-now:${LEASE_SECONDS}`, `lease-over:${LEASE_SECONDS}`],
        renewed: ["due-now", "lease-over"],
        passes: "gated",
        refused: "refused",
        due: 60,
      });
      expect(outcomes[1]).toBe(outcomes[0]);
      expect(outcomes[2]).toBe(outcomes[0]);
    });
  });

  describe("connections (ADR §3.11)", () => {
    it("a worker's pool is two connections: with both stuck behind a lock, its gates fail closed within the bound and a third statement never opens a third connection", async () => {
      await seed(3, "exhaust-");
      const app = `exhaust-${randomUUID().slice(0, 8)}`;
      const pool = processPool(app);
      const store = new DispatchStore(pool, app);
      const [v1, v2, v3] = await store.claim(3);
      const serverCount = async (where = "") =>
        (await db.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1 ${where}`, [`fence-pg:${app}`])).rows[0].n as number;
      const writer = await db.connect();
      let peak = 0;
      let sampling = true;
      const sampler = (async () => {
        while (sampling) {
          peak = Math.max(peak, pool.totalCount);
          await sleep(5);
        }
      })();
      try {
        await writer.query("BEGIN");
        await writer.query("UPDATE sip_solana.vault_work SET bell_at = clock_timestamp() WHERE vault_addr = ANY($1)", [[v1!.vault, v2!.vault]]);
        const started = Date.now();
        const gates = Promise.all([store.gate(draft(v1!.vault, v1!.fence)), store.gateOneStatement(draft(v2!.vault, v2!.fence))]);
        await until("both gates to wait on the rows", async () => (await serverCount("AND wait_event_type = 'Lock'")) === 2);
        // THE THIRD STATEMENT: the heartbeat, for a vault nobody locked. It waits for a connection.
        const beat = store.heartbeat([v3!]).then(
          (renewed) => ({ ok: true as const, renewed, at: Date.now() - started }),
          (error: unknown) => ({ ok: false as const, error, at: Date.now() - started }),
        );
        await sleep(500);
        expect(pool.waitingCount, "the heartbeat waits for one of the two").toBe(1);
        expect(await serverCount(), "connections this process holds on the server").toBe(2);
        const answers = await gates;
        const gatesAt = Date.now() - started;
        // FAILED CLOSED, WITHIN THE STATEMENT BOUND, WHILE THE LOCK IS STILL HELD: nothing gated.
        expect(answers.map((a) => a.kind)).toEqual(["unavailable", "unacknowledged"]);
        expect(gatesAt).toBeLessThan(7_000);
        const third = await beat;
        // IT GOT A CONNECTION ONCE A GATE GAVE ONE BACK, OR GAVE UP AT ITS OWN BOUND: never longer.
        expect(third.at).toBeLessThan(11_000);
        if (third.ok) expect([...third.renewed]).toEqual([v3!.vault]);
        await writer.query("COMMIT");
      } finally {
        writer.release();
        sampling = false;
        await sampler;
      }
      expect(peak, "connections the pool held at once").toBeLessThanOrEqual(2);
      expect(await intents(v1!.vault)).toEqual([]);
      expect(await intents(v2!.vault)).toEqual([]);
      // AND ONCE THE LOCK IS GONE, THE SAME HOLDER GATES AGAIN.
      expect((await store.gate(draft(v1!.vault, v1!.fence))).kind).toBe("gated");
    }, 30_000);

    it("under a 15-connection session pool (ASSUMED), the r = 2 fleet fits even doubled by a deploy; at r = 3 the processes left without a connection claim and gate nothing", async () => {
      const LIMIT = 15;
      const user = { name: `fence_pool_${process.pid}`, password: randomBytes(18).toString("hex") };
      await admin.query(`CREATE ROLE ${user.name} LOGIN PASSWORD '${user.password}' CONNECTION LIMIT ${LIMIT}`);
      roles.push(user.name);
      await db.query(`GRANT USAGE ON SCHEMA sip_solana TO ${user.name}`);
      await db.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA sip_solana TO ${user.name}`);
      await db.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA sip_solana TO ${user.name}`);
      // AND THE TEST'S OWN FENCE LOG, which the claim's trigger writes as the claimer.
      await db.query(`GRANT USAGE ON SCHEMA fence_test TO ${user.name}`);
      await db.query(`GRANT INSERT ON fence_test.claim_log TO ${user.name}`);
      await db.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA fence_test TO ${user.name}`);
      const url = urlFor(database, user);
      const vaults = await seed(40, "budget-");

      /** One fleet's processes, each opening every connection its pool may hold, as a busy one would. */
      async function fleet(workerReplicas: number, tag: string) {
        const deploying = true;
        const opened: pg.PoolClient[] = [];
        const lock: pg.Client[] = [];
        let refused = 0;
        const fill = async (pool: pg.Pool, size: number) => {
          for (let i = 0; i < size; i++) {
            try {
              opened.push(await pool.connect());
            } catch {
              refused += 1;
            }
          }
        };
        const copies = deploying ? 2 : 1;
        const workers: DispatchStore[] = [];
        const own: pg.Pool[] = [];
        const poolFor = (name: string, kind: "worker" | "scheduler") => {
          const pool = processPool(name, kind, url);
          own.push(pool);
          return pool;
        };
        for (let copy = 0; copy < copies; copy++) {
          // THE SCHEDULER: the holder (its pool and the pinned lock) and the standby.
          await fill(poolFor(`${tag}-sched-holder-${copy}`, "scheduler"), 1);
          const pinned = new pg.Client({ connectionString: url });
          pinned.on("error", () => undefined);
          try {
            await pinned.connect();
            lock.push(pinned);
          } catch {
            refused += 1;
          }
          await fill(poolFor(`${tag}-sched-standby-${copy}`, "scheduler"), 1);
          for (let r = 0; r < workerReplicas; r++) {
            const name = `${tag}-worker-${copy}-${r}`;
            const pool = poolFor(name, "worker");
            await fill(pool, 2);
            workers.push(new DispatchStore(pool, name));
          }
        }
        const holding = opened.length + lock.length;
        // EVERY CONNECTION HANDED BACK TO ITS POOL, OPEN, so a worker claims on its own.
        for (const client of opened) client.release();
        const claims = await Promise.all(
          workers.map(async (store) => {
            try {
              const got = await store.claim(2);
              const gates = await Promise.all(got.map((c) => store.gateOneStatement(draft(c.vault, c.fence))));
              return { store, got, gates, failed: false, why: "" };
            } catch (error) {
              return { store, got: [] as ClaimedVault[], gates: [] as GateAnswer[], failed: true, why: error instanceof Error ? error.message : String(error) };
            }
          }),
        );
        const onServer = (await admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = $1`, [user.name])).rows[0].n;
        for (const client of lock) await client.end().catch(() => undefined);
        for (const pool of own) await pool.end().catch(() => undefined);
        await until("the fleet's connections to close", async () =>
          (await admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = $1`, [user.name])).rows[0].n === 0,
        );
        return { expected: dispatchConnections({ workerReplicas, deploying }), holding, refused, claims, onServer };
      }

      const fits = await fleet(2, "r2");
      expect(fits.expected).toBe(14);
      expect(fits.holding).toBe(14);
      expect(fits.refused).toBe(0);
      expect(fits.onServer).toBeLessThanOrEqual(LIMIT);
      expect(
        fits.claims.map((c) => ({ failed: c.failed, why: c.why, got: c.got.length, gates: c.gates.map((g) => g.kind) })),
      ).toEqual(fits.claims.map(() => ({ failed: false, why: "", got: 2, gates: ["gated", "gated"] })));
      await db.query("UPDATE sip_solana.vault_work SET holder = NULL, lease_until = NULL");

      const over = await fleet(3, "r3");
      expect(over.expected).toBe(18);
      expect(over.holding).toBe(LIMIT);
      expect(over.refused).toBe(over.expected - LIMIT);
      expect(over.onServer).toBeLessThanOrEqual(LIMIT);
      const starved = over.claims.filter((c) => c.failed);
      expect(starved.length).toBeGreaterThan(0);
      for (const c of starved) {
        expect(c.why).toMatch(/too many connections for role/);
        expect((await db.query("SELECT count(*)::int AS n FROM sip_solana.vault_work WHERE holder = $1", [c.store.holder])).rows[0].n).toBe(0);
        expect((await db.query("SELECT count(*)::int AS n FROM sip_solana.send_intent WHERE worker_id = $1", [c.store.holder])).rows[0].n).toBe(0);
      }
      // THE ONES THAT DID CONNECT STILL HOLD EACH VAULT ALONE.
      const held = await db.query("SELECT vault_addr, holder FROM sip_solana.vault_work WHERE holder IS NOT NULL");
      expect(new Set(held.rows.map((r) => r.vault_addr)).size).toBe(held.rows.length);
      expect(vaults.length).toBe(40);
    }, 60_000);
  });

  describe("the SIGTERM drill (ADR §4.9 row 6)", () => {
    const FULL = process.env["FENCE_PG_DRILL"] === "full";
    // A QUEUE THAT KEEPS UP, AS THE REAL ONE DOES: each vault is due again within
    // dueMaxMs, which keeps two workers of two slots about half busy. A queue that
    // never drains would turn a released vault only after its earlier send had long
    // expired, and the takeover the drill is for would never be contested.
    const P = FULL
      ? { slotMs: 400, validity: 150, finality: 32, drainMs: 20_000, heartbeatMs: 10_000, everyMs: 20_000, sigterms: 30, dueMaxMs: 300_000, landP: 0.25, dropRate: 0.03 }
      : // THE SAME SHAPE TEN TIMES FASTER: a blockhash lives 150 slots and finality is 32, as on mainnet, at 40 ms a slot.
        { slotMs: 40, validity: 150, finality: 32, drainMs: 2_000, heartbeatMs: 1_000, everyMs: 3_000, sigterms: 30, dueMaxMs: 38_000, landP: 0.25, dropRate: 0.03 };

    it(
      `two worker processes over 50 vaults, one SIGTERM'd mid-job every ${P.everyMs / 1_000} s, ${P.sigterms} times: the overlap audit returns no rows, and no transaction lands on a state it was not planned from`,
      async () => {
        await db.query(`
          DROP SCHEMA IF EXISTS fence_drill CASCADE;
          CREATE SCHEMA fence_drill;
          CREATE TABLE fence_drill.chain (id boolean PRIMARY KEY DEFAULT true, height bigint NOT NULL, finalized bigint NOT NULL);
          INSERT INTO fence_drill.chain VALUES (true, 1000, 1000 - ${P.finality});
          CREATE TABLE fence_drill.vault (vault_addr text PRIMARY KEY, state bigint NOT NULL DEFAULT 0);
          CREATE TABLE fence_drill.tx (
            signature text PRIMARY KEY, vault_addr text NOT NULL, fence bigint NOT NULL, worker_id text NOT NULL,
            lvbh bigint NOT NULL, planned_state bigint NOT NULL, dropped boolean NOT NULL, sent_height bigint NOT NULL,
            landed_height bigint, state_before bigint);
          CREATE FUNCTION fence_drill.tick(p double precision, fin integer) RETURNS void LANGUAGE plpgsql AS $$
          DECLARE h bigint; t record;
          BEGIN
            UPDATE fence_drill.chain SET height = height + 1, finalized = height + 1 - fin RETURNING height INTO h;
            FOR t IN SELECT signature, vault_addr FROM fence_drill.tx
                      WHERE landed_height IS NULL AND NOT dropped AND lvbh >= h AND sent_height < h ORDER BY random() LOOP
              IF random() < p THEN
                UPDATE fence_drill.tx x SET landed_height = h, state_before = v.state
                  FROM fence_drill.vault v WHERE x.signature = t.signature AND v.vault_addr = t.vault_addr;
                UPDATE fence_drill.vault SET state = state + 1 WHERE vault_addr = t.vault_addr;
              END IF;
            END LOOP;
          END $$;
        `);
        const vaults = await seed(50, "drill-");
        await db.query("INSERT INTO fence_drill.vault (vault_addr) SELECT unnest($1::text[])", [vaults]);

        let ticking = true;
        const ticker = (async () => {
          while (ticking) {
            await db.query("SELECT fence_drill.tick($1, $2)", [P.landP, P.finality]);
            await sleep(P.slotMs);
          }
        })();

        const events: Record<string, unknown>[] = [];
        const exits: Array<{ id: string; code: number | null; signal: NodeJS.Signals | null }> = [];
        const children = new Map<string, ChildProcess>();
        let serial = 0;
        const start = (): string => {
          const id = `drill-w${serial++}`;
          const child = spawn(process.execPath, ["--import", "tsx", WORKER_FIXTURE], {
            cwd: PACKAGE_DIR,
            // A MINIMAL ENVIRONMENT: no SIP_SOLANA_*, no key, nothing but the drill's own.
            env: {
              PATH: process.env["PATH"] ?? "",
              DRILL_PG_URL: urlFor(database),
              DRILL_WORKER_ID: id,
              DRILL_SLOTS: "2",
              DRILL_SLOT_MS: String(P.slotMs),
              DRILL_VALIDITY: String(P.validity),
              DRILL_FINALITY: String(P.finality),
              DRILL_DRAIN_MS: String(P.drainMs),
              DRILL_HEARTBEAT_MS: String(P.heartbeatMs),
              DRILL_DROP_RATE: String(P.dropRate),
              DRILL_SENDS_MAX: "3",
              DRILL_DUE_MAX_MS: String(P.dueMaxMs),
            },
            stdio: ["ignore", "pipe", "pipe"],
          });
          let buffer = "";
          child.stdout!.on("data", (chunk: Buffer) => {
            buffer += chunk.toString("utf8");
            let newline: number;
            while ((newline = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, newline);
              buffer = buffer.slice(newline + 1);
              try {
                events.push(JSON.parse(line) as Record<string, unknown>);
              } catch {
                events.push({ event: "stdout", worker: id, line });
              }
            }
          });
          child.stderr!.on("data", (chunk: Buffer) => events.push({ event: "stderr", worker: id, line: chunk.toString("utf8") }));
          child.on("exit", (code, signal) => {
            exits.push({ id, code, signal });
            children.delete(id);
          });
          children.set(id, child);
          return id;
        };
        const ready = (id: string) => until(`${id} to be ready`, async () => events.some((e) => e.event === "ready" && e.worker === id), 30_000);
        const stop = async (id: string) => {
          const child = children.get(id);
          if (child === undefined) return;
          child.kill("SIGTERM");
          const deadline = Date.now() + P.drainMs + 15_000;
          while (children.has(id) && Date.now() < deadline) await sleep(20);
          if (children.has(id)) child.kill("SIGKILL");
        };

        try {
          let running = [start(), start()];
          await Promise.all(running.map(ready));
          for (let n = 0; n < P.sigterms; n++) {
            await sleep(P.everyMs);
            // A DEPLOY: the new container boots beside the old, then the old one gets SIGTERM.
            const victim = running[n % 2]!;
            const replacement = start();
            await ready(replacement);
            await stop(victim);
            running = running.map((id) => (id === victim ? replacement : id));
          }
          await Promise.all(running.map(stop));
        } finally {
          for (const child of children.values()) child.kill("SIGKILL");
        }
        // LET EVERY TRANSACTION STILL ON ITS WAY LAND OR EXPIRE, THEN STOP THE CHAIN.
        const settleTo = (await db.query("SELECT height FROM fence_drill.chain")).rows[0].height;
        await until("every sent transaction to land or expire", async () =>
          (await db.query("SELECT finalized > $1::bigint + $2::bigint AS done FROM fence_drill.chain", [settleTo, P.validity])).rows[0].done,
          (P.validity + P.finality + 10) * P.slotMs * 3,
        );
        ticking = false;
        await ticker;

        const count = (name: string) => events.filter((e) => e.event === name).length;
        const summary = {
          sent: count("sent"),
          plans: count("plan"),
          waitedToPlan: events.filter((e) => e.event === "plan" && e.waited === true).length,
          released: count("released"),
          releasedWithOpenIntent: events.filter((e) => e.event === "released" && e.open === true).length,
          takeoverResolved: count("takeover-resolved"),
          takeoverDeferred: count("takeover-deferred"),
          gateRefused: count("gate-refused"),
          sigterms: count("sigterm"),
          jobErrors: events.filter((e) => e.event === "job-error" || e.event === "fatal" || e.event === "stderr"),
        };
        // THE ADR'S PROOF: no later holder planned before an earlier intent was over.
        const audit = await db.query(
          `SELECT b.id FROM sip_solana.send_intent a JOIN sip_solana.send_intent b
             ON b.vault_addr = a.vault_addr AND b.fence > a.fence
            WHERE b.plan_cleared_height <= COALESCE(a.resolved_height, a.last_valid_block_height)`,
        );
        // AND THE CHAIN'S: no transaction landed on a state other than the one it was planned from.
        const doubles = await db.query("SELECT count(*)::int AS n FROM fence_drill.tx WHERE landed_height IS NOT NULL AND state_before <> planned_state");
        // ONE FENCE, ONE PROCESS: every intent of a fence was gated by the process that claimed it.
        const mixed = await db.query(
          `SELECT i.vault_addr, i.fence FROM sip_solana.send_intent i
             JOIN fence_test.claim_log l ON l.vault_addr = i.vault_addr AND l.fence = i.fence
            WHERE l.holder <> i.worker_id`,
        );
        const landed = (await db.query("SELECT count(*)::int AS n FROM fence_drill.tx WHERE landed_height IS NOT NULL")).rows[0].n;
        console.log(`fence-pg drill (${FULL ? "full" : "compressed"}): ${JSON.stringify({ ...summary, jobErrors: summary.jobErrors.length, landed })}`);
        expect(summary.jobErrors, JSON.stringify(summary.jobErrors.slice(0, 5))).toEqual([]);
        expect(audit.rows, "overlap audit").toEqual([]);
        expect(doubles.rows[0].n, "transactions landed on a state they were not planned from").toBe(0);
        expect(mixed.rows).toEqual([]);
        expect(exits.filter((e) => e.code !== 0), JSON.stringify(exits)).toEqual([]);
        expect(summary.sigterms).toBe(P.sigterms + 2);
        // NOT VACUOUS: the drill sent, released mid-job, and took vaults over with intents still open.
        expect(summary.sent).toBeGreaterThan(150);
        expect(landed).toBeGreaterThan(100);
        expect(summary.released).toBeGreaterThan(P.sigterms / 2);
        expect(summary.releasedWithOpenIntent, "released with a send still unconfirmed").toBeGreaterThan(0);
        expect(summary.takeoverDeferred, "taken over while an earlier send could still land, and waited out").toBeGreaterThan(0);
        expect(summary.waitedToPlan, "planned only once the finalized height passed the earlier sends").toBeGreaterThan(0);
      },
      FULL ? 20 * 60_000 : 5 * 60_000,
    );
  });
});
