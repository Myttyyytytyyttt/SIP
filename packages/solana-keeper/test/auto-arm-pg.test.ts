// THE SCHEDULER ARMS WHAT IT ENROLLED, ON POSTGRES 16 (src/auto-arm.ts over
// src/handover.ts and sql/sip_solana.sql): the selection and `arm` on real
// rows, the legacy keepers' real receipts (src/dispatch-select.ts), and a
// scheduler tick on its one-connection pool.
//
//   * a vault the scheduler enrolled is armed only after every acting receipt
//     and 150 finalized blocks, then claimed;
//   * a vault an operator drained — or released and drained again — is NEVER
//     armed by the scheduler, whatever the receipts and the blocks;
//   * a vault rolled back off the queue is never re-armed, claimed or not;
//   * SIP_SOLANA_LEGACY_ROLES=none arms with no receipt at all, and still waits
//     for every legacy process not marked gone to have read the vault;
//   * with the legacy keepers stopped and the default roles, nothing is armed
//     and the wait raises the alert.
//
// RUN ONLY WITH A THROWAWAY DATABASE ON THE LOOPBACK (test/dispatch-select-pg.test.ts's
// rule): KEEPER_TEST_PG_URL names the server, the run creates its own database
// and drops it. Without the variable the block is skipped and says why.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";
import pg from "pg";
import { Secret } from "@sip/solana-log";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AUTO_ARM_ALERT_KEY, AutoArm, PgAutoArmStore } from "../src/auto-arm.js";
import { CLAIM_SQL, createDispatchPool } from "../src/dispatch-store.js";
import { LegacySelector } from "../src/dispatch-select.js";
import { HANDOVER_WAIT_BLOCKS, Handover, LEGACY_READ_FRESH_MS, type ChainHeights } from "../src/handover.js";
import { KEEPER_ROLES, type KeeperRole } from "../src/role-registry.js";
import { PgSchedulerStore } from "../src/scheduler-pg.js";
import { Scheduler } from "../src/scheduler.js";
import { FakeAlerter, FakeChain, FakeLock, LockServer, fakeLink } from "./scheduler-fakes.js";

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

/** Made-up vaults: nothing here reads a chain. */
const NEW_VAULT = "NewVau1tEnro11edMadeUp1111111111111111111111";
const DRAINED_VAULT = "DrainedVau1tMadeUp11111111111111111111111111";
const ROLLED_VAULT = "Ro11edBackVau1tMadeUp11111111111111111111111";
const ROLLED_EARLY = "Ro11edEar1yVau1tMadeUp1111111111111111111111";

describe.skipIf(!usable)("the auto-arm on Postgres 16 (needs KEEPER_TEST_PG_URL on the loopback)", () => {
  const database = `keeper_autoarm_${process.pid}_${Date.now()}`;
  let admin: pg.Pool;
  let db: pg.Pool;
  const pools: pg.Pool[] = [];
  const url = (): string => {
    const parsed = new URL(URL_RAW!);
    parsed.pathname = `/${database}`;
    return parsed.toString();
  };

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: URL_RAW!, max: 1 });
    admin.on("error", () => undefined);
    await admin.query(`CREATE DATABASE ${database}`);
    db = new pg.Pool({ connectionString: url(), max: 4 });
    db.on("error", () => undefined);
    await db.query(SCHEMA_SQL);
  });

  afterAll(async () => {
    for (const opened of pools) await opened.end().catch(() => undefined);
    await db?.end().catch(() => undefined);
    if (admin !== undefined) {
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`).catch(() => undefined);
      await admin.end();
    }
  });

  beforeEach(async () => {
    await db.query(`TRUNCATE ${S}.vault_work, ${S}.send_intent, ${S}.legacy_process, ${S}.loss_carry, ${S}.keeper_link, ${S}.worker`);
    await db.query(`UPDATE ${S}.fleet SET new_vault_system = 'queue', webhook_owner = 'legacy', full_pass_reason = NULL`);
  });

  const run = async (text: string, values: readonly unknown[]) => (await db.query(text, [...values])).rows;
  /** A legacy keeper's sweep: its read, and the receipt it writes in the same statement. */
  const sweep = async (role: KeeperRole, processId: string, live = true): Promise<void> => {
    const selector = new LegacySelector({ role, mode: "on", processId, deployment: `dep-${processId}`, host: "box", carryStore: "on", run });
    const read = await selector.read({ live, carryVaults: [], now: Date.now() });
    if (!read.ok) throw new Error(read.detail);
  };
  const bothSweep = async (): Promise<void> => {
    await sweep("profit", "profit-1");
    await sweep("volume", "volume-1");
  };
  const enrol = (...vaults: string[]) => new PgSchedulerStore(db).ensureVaults(vaults);
  const rowOf = async (vault: string) =>
    (await db.query(`SELECT system, system_at IS NOT NULL AS stamped, handover_height::text AS h, fence::text AS fence FROM ${S}.vault_work WHERE vault_addr = $1`, [vault])).rows[0];

  /** The step over this database, with a chain whose heights the test moves. */
  function stepper(legacyRoles: readonly KeeperRole[] = KEEPER_ROLES) {
    const chain = { processed: 10_000n, finalized: 9_968n };
    const logs: string[] = [];
    const autoArm = new AutoArm({
      enabled: true,
      legacyRoles,
      store: new PgAutoArmStore(db),
      handover: new Handover(db),
      heights: async (): Promise<ChainHeights> => ({ ...chain }),
      log: (_level, message) => logs.push(message),
    });
    const passBlocks = (): void => {
      chain.finalized = chain.processed + HANDOVER_WAIT_BLOCKS + 1n;
      chain.processed = chain.finalized + 32n;
    };
    return { autoArm, chain, passBlocks, logs };
  }

  it("arms a vault the scheduler enrolled only after every acting receipt and 150 finalized blocks, then a worker claims it", async () => {
    const { autoArm, passBlocks } = stepper();
    expect(await enrol(NEW_VAULT)).toEqual([{ vault: NEW_VAULT, system: "draining" }]);
    expect(await rowOf(NEW_VAULT)).toEqual({ system: "draining", stamped: false, h: null, fence: "0" });
    // NO RECEIPT YET: nothing recorded, the roles named.
    const none = await autoArm.step();
    expect(none).toMatchObject({ moved: [], pending: 1, error: null });
    expect(autoArm.status().lastResults[0]!.blocker).toMatch(/no ACTING profit keeper/);
    expect((await rowOf(NEW_VAULT)).h).toBeNull();
    // BOTH LEGACY KEEPERS SWEEP: they read it as draining, and the processed height is recorded.
    await bothSweep();
    expect((await autoArm.step()).moved).toEqual([]);
    expect(await rowOf(NEW_VAULT)).toEqual({ system: "draining", stamped: false, h: "10000", fence: "0" });
    expect(autoArm.status().lastResults[0]!.blocker).toMatch(/every legacy keeper has let go; waiting for the finalized height to pass 10150/);
    expect((await db.query(CLAIM_SQL, ["w-1", 4])).rows).toEqual([]);
    // 150 BLOCKS FINAL: it moves, stamped, and the queue takes it.
    passBlocks();
    expect(await autoArm.step()).toMatchObject({ moved: [NEW_VAULT], pending: 0, error: null });
    expect(await rowOf(NEW_VAULT)).toMatchObject({ system: "queue", stamped: true, fence: "0" });
    expect((await db.query(CLAIM_SQL, ["w-1", 4])).rows.map((row) => row.vault_addr)).toEqual([NEW_VAULT]);
    expect(autoArm.status()).toMatchObject({ pending: 0, armed: 1, lastError: null });
    expect(await autoArm.step()).toMatchObject({ moved: [], pending: 0 });
  });

  it("never arms a vault an operator drained — or released and drained again — whatever the receipts and the blocks", async () => {
    const { autoArm, chain, passBlocks } = stepper();
    const handover = new Handover(db);
    expect(await handover.drain(DRAINED_VAULT)).toMatchObject({ moved: true, system: "draining" });
    await enrol(NEW_VAULT);
    expect(await handover.release(NEW_VAULT, chain)).toMatchObject({ moved: true, system: "legacy" });
    expect(await handover.drain(NEW_VAULT)).toMatchObject({ moved: true, system: "draining" });
    await bothSweep();
    for (let round = 0; round < 3; round++) {
      expect(await autoArm.step(), `round ${round}`).toMatchObject({ moved: [], pending: 0 });
      passBlocks();
    }
    for (const vault of [DRAINED_VAULT, NEW_VAULT]) expect(await rowOf(vault), vault).toEqual({ system: "draining", stamped: true, h: null, fence: "0" });
    // EVEN ASKED STRAIGHT, under the row's lock: refused, nothing written.
    const refused = await handover.arm(DRAINED_VAULT, chain, { enrolledOnly: true });
    expect(refused).toMatchObject({ moved: false, blockers: [expect.stringMatching(/not as the scheduler enrolled it.*dispatch-handover arm/)] });
    expect((await rowOf(DRAINED_VAULT)).h).toBeNull();
    // THE OPERATOR'S OWN `arm` STILL WORKS: their handover is theirs to finish.
    expect((await handover.arm(DRAINED_VAULT, chain)).waitUntilFinalizedAbove).toBe(chain.processed + HANDOVER_WAIT_BLOCKS);
  });

  it("never re-arms a vault rolled back off the queue, whether a worker had claimed it or not", async () => {
    const { autoArm, passBlocks } = stepper();
    const handover = new Handover(db);
    await enrol(ROLLED_VAULT, ROLLED_EARLY);
    await bothSweep();
    await autoArm.step();
    passBlocks();
    expect([...(await autoArm.step()).moved].sort()).toEqual([ROLLED_VAULT, ROLLED_EARLY].sort());
    // ONE IS CLAIMED AND ITS JOB ENDS; THE OTHER IS TAKEN BACK BEFORE ANY CLAIM.
    await db.query(`UPDATE ${S}.vault_work SET due_at = clock_timestamp() + interval '1 hour' WHERE vault_addr = $1`, [ROLLED_EARLY]);
    expect((await db.query(CLAIM_SQL, ["w-1", 4])).rows.map((row) => row.vault_addr)).toEqual([ROLLED_VAULT]);
    await db.query(`UPDATE ${S}.vault_work SET holder = NULL, lease_until = NULL WHERE vault_addr = $1`, [ROLLED_VAULT]);
    for (const vault of [ROLLED_VAULT, ROLLED_EARLY]) expect(await handover.rollback(vault), vault).toMatchObject({ moved: true, system: "draining" });
    await bothSweep();
    for (let round = 0; round < 3; round++) {
      expect(await autoArm.step(), `round ${round}`).toMatchObject({ moved: [], pending: 0 });
      passBlocks();
    }
    expect(await rowOf(ROLLED_VAULT)).toMatchObject({ system: "draining", stamped: true, fence: "1" });
    expect(await rowOf(ROLLED_EARLY)).toMatchObject({ system: "draining", stamped: true, fence: "0", h: null });
  });

  it("SIP_SOLANA_LEGACY_ROLES=none arms with no receipt at all, and still waits for a legacy process not marked gone that has not read the vault", async () => {
    const { autoArm, passBlocks } = stepper([]);
    const handover = new Handover(db);
    // THE LEGACY KEEPERS ARE RETIRED AND LEFT NO ROW: recorded at once, moved after the blocks.
    await enrol(NEW_VAULT);
    await autoArm.step();
    expect((await rowOf(NEW_VAULT)).h).toBe("10000");
    passBlocks();
    expect((await autoArm.step()).moved).toEqual([NEW_VAULT]);
    // A STOPPED KEEPER'S LAST RECEIPT, FROM BEFORE THE NEXT VAULT EXISTED: not gone, so it holds the arm by name.
    await sweep("profit", "profit-stopped", false);
    await db.query(`UPDATE ${S}.legacy_process SET read_at = clock_timestamp() - make_interval(secs => $1)`, [LEGACY_READ_FRESH_MS / 1000 + 600]);
    await enrol(DRAINED_VAULT);
    const held = await autoArm.step();
    expect(held).toMatchObject({ moved: [], pending: 1 });
    expect(autoArm.status().lastResults[0]!.blocker).toMatch(/legacy process profit-stopped \(profit, .*has not yet read this vault as not its own.*dispatch-handover gone profit-stopped/);
    expect((await rowOf(DRAINED_VAULT)).h).toBeNull();
    // MARKED GONE BY AN OPERATOR WHO CHECKED RAILWAY: it no longer holds it.
    await handover.gone({ processIds: ["profit-stopped"] });
    await autoArm.step();
    expect((await rowOf(DRAINED_VAULT)).h).not.toBeNull();
    // A LEGACY KEEPER BROUGHT BACK WITH SIP_SOLANA_DISPATCH=on: its first receipt names the vault, so it holds
    // nothing — but a row that read before it was there (a fresh container with an old read) clears the record.
    await db.query(`INSERT INTO ${S}.legacy_process (process_id, role, dispatch, live, read_at, absent_is) VALUES ('back', 'volume', 'on', true, clock_timestamp(), 'queue')`);
    passBlocks();
    expect((await autoArm.step()).moved).toEqual([]);
    expect((await rowOf(DRAINED_VAULT)).h).toBeNull();
    await sweep("volume", "back");
    await autoArm.step();
    passBlocks();
    expect((await autoArm.step()).moved).toEqual([DRAINED_VAULT]);
  });

  it("with the legacy keepers stopped and every role required, nothing is armed, and the wait warns from 15 minutes", async () => {
    const { autoArm, passBlocks } = stepper();
    await bothSweep();
    await db.query(`UPDATE ${S}.legacy_process SET read_at = clock_timestamp() - make_interval(secs => $1)`, [LEGACY_READ_FRESH_MS / 1000 + 60]);
    await enrol(NEW_VAULT);
    passBlocks();
    const tick = await autoArm.step();
    expect(tick).toMatchObject({ moved: [], pending: 1, alert: { fire: null, clear: true } });
    expect(autoArm.status().lastResults[0]!.blocker).toMatch(/has not yet read this vault|no ACTING (profit|volume) keeper/);
    // ENROLLED 16 MINUTES AGO (its due_at is its enrolment).
    await db.query(`UPDATE ${S}.vault_work SET due_at = clock_timestamp() - interval '16 minutes' WHERE vault_addr = $1`, [NEW_VAULT]);
    const late = await autoArm.step();
    expect(late.alert.fire).toMatchObject({ key: AUTO_ARM_ALERT_KEY, severity: "warn", detail: expect.stringContaining("1 vault the scheduler enrolled is still draining") });
    expect(autoArm.status().oldestWaitingMs).toBeGreaterThanOrEqual(16 * 60_000);
    expect((await rowOf(NEW_VAULT)).h).toBeNull();
  });

  it("runs inside the holder's tick on the scheduler's one-connection pool: enrolled, armed, made due, claimed", async () => {
    const pool = createDispatchPool(new Secret(url(), "databaseUrl"), "scheduler", "test-autoarm", () => undefined);
    pools.push(pool);
    const chain = new FakeChain();
    for (let i = 0; i < 2; i++) chain.links.push(fakeLink(Keypair.generate().publicKey));
    const heights = { processed: 20_000n, finalized: 19_968n };
    const alerter = new FakeAlerter();
    const autoArm = new AutoArm({
      enabled: true,
      legacyRoles: [],
      store: new PgAutoArmStore(pool),
      handover: new Handover(pool),
      heights: async () => ({ ...heights }),
      log: () => undefined,
    });
    const scheduler = new Scheduler({
      id: "sched-auto",
      mode: "on",
      tickMs: 60_000,
      lock: new FakeLock(new LockServer(), "sched-auto"),
      store: new PgSchedulerStore(pool),
      fullPass: { takeFullPass: async () => null },
      intents: { resolveIntent: async () => true },
      chain,
      alerter,
      log: () => undefined,
      lamportsFilter: false,
      doorbellSecret: false,
      autoArm,
    });
    const vaults = [...new Set(chain.links.map((l) => l.vault.toBase58()))].sort();
    const first = await scheduler.tick();
    expect(first).toMatchObject({ kind: "acted", autoArmed: [], marked: [] });
    expect((await db.query(`SELECT vault_addr, system, handover_height::text AS h FROM ${S}.vault_work ORDER BY vault_addr`)).rows).toEqual(
      vaults.map((vault_addr) => ({ vault_addr, system: "draining", h: "20000" })),
    );
    heights.finalized = 20_151n;
    heights.processed = 20_183n;
    const second = await scheduler.tick();
    if (second.kind !== "acted") throw new Error(`tick: ${JSON.stringify(second)}`);
    expect([...second.autoArmed].sort()).toEqual(vaults);
    expect([...second.marked].sort()).toEqual(vaults);
    expect(scheduler.status()).toMatchObject({ consecutiveFailures: 0, autoArm: { enabled: true, legacyRoles: [], pending: 0, armed: 2, lastError: null } });
    expect((await db.query(CLAIM_SQL, ["w-1", 4])).rows.map((row) => row.vault_addr).sort()).toEqual(vaults);
    expect(alerter.firing.has(AUTO_ARM_ALERT_KEY)).toBe(false);
  });
});
