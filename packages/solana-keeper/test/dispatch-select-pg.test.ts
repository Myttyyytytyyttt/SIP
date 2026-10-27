// THE MIGRATION ON POSTGRES 16: the legacy keepers' read and receipt
// (src/dispatch-select.ts), the scheduler's enrolment and the two-step handover
// (src/handover.ts), and the operator's command over them (src/handover-cli.ts).
//
// RUN ONLY WITH A THROWAWAY DATABASE ON THE LOOPBACK, as
// test/dispatch-wiring-pg.test.ts: KEEPER_TEST_PG_URL names a server (a
// `docker run --rm postgres:16-alpine` with a generated password); a host that is
// not the loopback is refused; the run creates its own database and drops it at
// the end. Without the variable the block is skipped and says why.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CLAIM_SQL, JOB_CEILING_MINUTES } from "../src/dispatch-store.js";
import { LEGACY_SELECT_SQL, LegacySelector, carryOnlyInMemoryVaults, partitionLegacyTurns, type LegacyView } from "../src/dispatch-select.js";
import { DurableCarries, type DurableCarryStore } from "../src/carry-store.js";
import { MODE_PROFIT } from "../src/program-scripts.js";
import type { CarryBook } from "../src/settle-decision.js";
import { HANDOVER_WAIT_BLOCKS, Handover, LEGACY_READ_FRESH_MS, RELEASE_JOB_CEILING_MINUTES, STATUS_DETAIL_CHARS, type HandoverStatus } from "../src/handover.js";
import { ENSURE_VAULTS_SQL, PgSchedulerStore } from "../src/scheduler-pg.js";
import type { CarryStoreMode } from "../src/cuts.js";
import { parseHandoverArgs, runHandoverCommand } from "../src/handover-cli.js";
import type { KeeperRole } from "../src/role-registry.js";

const URL_RAW = process.env["KEEPER_TEST_PG_URL"];
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const usable = ((): boolean => {
  if (URL_RAW === undefined || URL_RAW.trim() === "") return false;
  const host = new URL(URL_RAW).hostname;
  if (!LOOPBACK.has(host)) throw new Error("KEEPER_TEST_PG_URL must point at the loopback; it names another host");
  return true;
})();

const SCHEMA_SQL = readFileSync(fileURLToPath(new URL("../sql/sip_solana.sql", import.meta.url)), "utf8");

/** The owner's VOLUME vault (test/doorbell.test.ts), and two made-up ones: nothing here reads a chain. */
const VOLUME_VAULT = "EFXK995PV49Qz8xPSYMEUDBU5AKRR466JkgsfuGak5iU";
const PROFIT_VAULT = "ProfitVau1tMadeUp11111111111111111111111111";
const OTHER_VAULT = "UnfundedVau1tMadeUp1111111111111111111111111";

describe.skipIf(!usable)("the migration on Postgres 16 (needs KEEPER_TEST_PG_URL on the loopback)", () => {
  const database = `keeper_select_${process.pid}_${Date.now()}`;
  let admin: pg.Pool;
  let db: pg.Pool;
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
    // AND AGAIN: the file is idempotent, the handover's ALTERs included.
    await db.query(SCHEMA_SQL);
  });

  afterAll(async () => {
    await db?.end().catch(() => undefined);
    if (admin !== undefined) {
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`).catch(() => undefined);
      await admin.end();
    }
  });

  beforeEach(async () => {
    await db.query("TRUNCATE sip_solana.vault_work, sip_solana.send_intent, sip_solana.legacy_process, sip_solana.loss_carry, sip_solana.keeper_link");
    await db.query("UPDATE sip_solana.fleet SET new_vault_system = 'legacy'");
  });

  const run = async (text: string, values: readonly unknown[]) => (await db.query(text, [...values])).rows;
  const keeper = (role: KeeperRole, processId: string, mode: "shadow" | "on" = "on", carryStore: CarryStoreMode = "off") =>
    new LegacySelector({ role, mode, processId, deployment: `dep-${processId}`, host: "box", carryStore, run });
  const readOk = async (selector: LegacySelector, live = true, carryVaults: readonly string[] = []): Promise<LegacyView> => {
    const read = await selector.read({ live, carryVaults, now: Date.now() });
    if (!read.ok) throw new Error(read.detail);
    return read.view;
  };
  /**
   * THE SCHEDULER'S ENROLMENT (ENSURE_VAULTS_SQL), then the mode byte each named
   * row records, written straight — a stand-in for an owner's set_policy_v2
   * reaching the row, which no statement may let move a vault between actors.
   */
  const enrol = async (vaults: readonly (readonly [string, number])[]) => {
    await db.query(ENSURE_VAULTS_SQL, [vaults.map(([vault]) => vault)]);
    await db.query(
      `UPDATE sip_solana.vault_work w SET skim_mode = v.mode FROM unnest($1::text[], $2::smallint[]) AS v(vault, mode) WHERE w.vault_addr = v.vault`,
      [vaults.map(([vault]) => vault), vaults.map(([, mode]) => mode)],
    );
  };
  const systemOf = async (vault: string) => (await db.query("SELECT system FROM sip_solana.vault_work WHERE vault_addr = $1", [vault])).rows[0]?.system ?? null;
  const heights = (processed: bigint, finalized: bigint) => ({ processed, finalized });

  describe("the legacy keeper's read and receipt", () => {
    it("reads every vault that is not legacy and writes exactly that map, with who read it, in one statement", async () => {
      await enrol([
        [VOLUME_VAULT, 1],
        [PROFIT_VAULT, 0],
        [OTHER_VAULT, 0],
      ]);
      await db.query("UPDATE sip_solana.vault_work SET system = 'queue' WHERE vault_addr = $1", [VOLUME_VAULT]);
      await db.query("UPDATE sip_solana.vault_work SET system = 'draining' WHERE vault_addr = $1", [OTHER_VAULT]);
      const view = await readOk(keeper("profit", "p-1"), true, [PROFIT_VAULT]);
      expect(Object.fromEntries(view.notLegacy)).toEqual({ [VOLUME_VAULT]: "queue", [OTHER_VAULT]: "draining" });
      expect(view.absentIs).toBe("legacy");
      expect(view.legacyRows).toBeNull();
      const { rows } = await db.query("SELECT * FROM sip_solana.legacy_process");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        process_id: "p-1",
        role: "profit",
        dispatch: "on",
        deployment: "dep-p-1",
        host: "box",
        live: true,
        reads: "1",
        seen: { [VOLUME_VAULT]: "queue", [OTHER_VAULT]: "draining" },
        absent_is: "legacy",
        carry_vaults: [PROFIT_VAULT],
        carry_store: "off",
        gone_at: null,
      });
      expect(new Date(rows[0].read_at).toISOString()).toBe(view.readAt);
    });

    it("rewrites its own row on every read, and a row marked gone that reads again is not gone", async () => {
      const selector = keeper("volume", "v-1", "shadow");
      await readOk(selector, false);
      await new Handover(db).gone({ processIds: ["v-1"] });
      expect((await db.query("SELECT gone_at FROM sip_solana.legacy_process")).rows[0].gone_at).not.toBeNull();
      await enrol([[VOLUME_VAULT, 1]]);
      await db.query("UPDATE sip_solana.vault_work SET system = 'draining'");
      await readOk(selector, true);
      expect((await db.query("SELECT reads, gone_at, live, seen, dispatch, carry_store FROM sip_solana.legacy_process")).rows[0]).toEqual({
        reads: "2",
        gone_at: null,
        live: true,
        seen: { [VOLUME_VAULT]: "draining" },
        dispatch: "shadow",
        carry_store: "off",
      });
    });

    it("under new_vault_system = queue lists the legacy rows, so a vault with no row is told apart and left alone", async () => {
      await enrol([[PROFIT_VAULT, 0]]);
      await new Handover(db).setNewVaultSystem("queue");
      const view = await readOk(keeper("profit", "p-1"));
      expect(view.absentIs).toBe("queue");
      expect([...(view.legacyRows ?? [])]).toEqual([PROFIT_VAULT]);
      const { act, left } = partitionLegacyTurns([PROFIT_VAULT, VOLUME_VAULT], (v) => v, view);
      expect(act).toEqual([PROFIT_VAULT]);
      expect(left).toEqual([{ turn: VOLUME_VAULT, reason: "unenrolled" }]);
    });

    it("a read that cannot be made — the table not there — is a failure, never an answer", async () => {
      const broken = new LegacySelector({
        role: "profit",
        mode: "on",
        processId: "p-x",
        deployment: null,
        host: null,
        carryStore: "off",
        run: async (text, values) => (await db.query(text.replaceAll("sip_solana.vault_work", "sip_solana.vault_work_missing"), [...values])).rows,
      });
      const read = await broken.read({ live: true, carryVaults: [], now: Date.now() });
      expect(read).toMatchObject({ ok: false, streak: 1, detail: expect.stringContaining("vault_work_missing") });
      expect((await db.query("SELECT count(*)::int AS n FROM sip_solana.legacy_process")).rows[0].n).toBe(0);
      expect(LEGACY_SELECT_SQL).toContain("sip_solana.vault_work");
    });
  });

  describe("dispatch-select: an on-chain mode change never moves a vault between actors (Postgres)", () => {
    it("dispatch-select: an on-chain mode change never moves a vault between actors", async () => {
      // THE OWNER'S VAULT ON THE QUEUE, A PROFIT VAULT WITH THE LEGACY KEEPERS.
      await enrol([
        [VOLUME_VAULT, 1],
        [PROFIT_VAULT, 0],
      ]);
      await db.query("UPDATE sip_solana.vault_work SET system = 'queue' WHERE vault_addr = $1", [VOLUME_VAULT]);
      const before = await readOk(keeper("profit", "p-1"));
      // BOTH OWNERS CALL set_policy_v2: the rows record the new bytes, and the enrolment runs again.
      await enrol([
        [VOLUME_VAULT, 0],
        [PROFIT_VAULT, 1],
      ]);
      expect((await db.query("SELECT vault_addr, system, skim_mode FROM sip_solana.vault_work ORDER BY system")).rows).toEqual([
        { vault_addr: PROFIT_VAULT, system: "legacy", skim_mode: 1 },
        { vault_addr: VOLUME_VAULT, system: "queue", skim_mode: 0 },
      ]);
      // THE LEGACY KEEPERS STILL LEAVE THE SAME VAULT ALONE, AND RUN THE SAME ONE.
      const after = await readOk(keeper("volume", "v-1"));
      expect(Object.fromEntries(after.notLegacy)).toEqual(Object.fromEntries(before.notLegacy));
      expect(partitionLegacyTurns([VOLUME_VAULT, PROFIT_VAULT], (v) => v, after).act).toEqual([PROFIT_VAULT]);
      // AND THE QUEUE STILL CLAIMS THE SAME ONE: by its system, whatever its byte now says.
      const claimed = (await db.query(CLAIM_SQL, ["w-1", 10])).rows.map((row) => [row.vault_addr, row.skim_mode]);
      expect(claimed).toEqual([[VOLUME_VAULT, 0]]);
    });

    it("an enrolment under new_vault_system = queue starts a new vault draining — never straight onto the queue", async () => {
      await enrol([[PROFIT_VAULT, 0]]);
      await new Handover(db).setNewVaultSystem("queue");
      await enrol([
        [PROFIT_VAULT, 1],
        [VOLUME_VAULT, 1],
      ]);
      expect(await systemOf(PROFIT_VAULT)).toBe("legacy");
      expect(await systemOf(VOLUME_VAULT)).toBe("draining");
      expect((await db.query(CLAIM_SQL, ["w-1", 10])).rows).toEqual([]);
    });
  });

  describe("the two-step handover, legacy → queue", () => {
    const both = async (seenBy: readonly KeeperRole[] = ["profit", "volume"], live = true) => {
      for (const role of seenBy) await readOk(keeper(role, `${role}-1`), live);
    };

    it("drain: legacy → draining, a missing row created, and nothing else drained twice", async () => {
      const handover = new Handover(db);
      expect(await handover.drain(VOLUME_VAULT)).toEqual({ vault: VOLUME_VAULT, system: "draining", moved: true, blockers: [] });
      expect((await db.query("SELECT system, system_at IS NOT NULL AS stamped, handover_height FROM sip_solana.vault_work")).rows).toEqual([
        { system: "draining", stamped: true, handover_height: null },
      ]);
      expect(await handover.drain(VOLUME_VAULT)).toMatchObject({ moved: false, system: "draining", blockers: [expect.stringContaining("not legacy")] });
      await db.query("UPDATE sip_solana.vault_work SET system = 'queue'");
      expect(await handover.drain(VOLUME_VAULT)).toMatchObject({ moved: false, system: "queue" });
    });

    it("arm waits for BOTH legacy keepers to have read the vault as not theirs, and names who is missing", async () => {
      const handover = new Handover(db);
      await handover.drain(VOLUME_VAULT);
      const none = await handover.arm(VOLUME_VAULT, heights(1_000n, 990n));
      expect(none.moved).toBe(false);
      expect(none.blockers.join("\n")).toMatch(/no ACTING profit keeper/);
      expect(none.blockers.join("\n")).toMatch(/no ACTING volume keeper/);
      await both(["profit"]);
      const half = await handover.arm(VOLUME_VAULT, heights(1_000n, 990n));
      expect(half.blockers).toEqual([expect.stringMatching(/no ACTING volume keeper/)]);
      // A legacy process that read BEFORE the drain has not let go: it blocks by name, whatever its role.
      await db.query("TRUNCATE sip_solana.legacy_process");
      await db.query("UPDATE sip_solana.vault_work SET system = 'legacy'");
      await readOk(keeper("volume", "old-volume"));
      await db.query("UPDATE sip_solana.vault_work SET system = 'draining'");
      await both(["profit", "volume"]);
      const old = await handover.arm(VOLUME_VAULT, heights(1_000n, 990n));
      expect(old.blockers).toEqual([expect.stringMatching(/legacy process old-volume \(volume, deployment dep-old-volume.*has not yet read this vault as not its own.*dispatch-handover gone old-volume/)]);
      // ITS CONTAINER IS GONE: marked, it no longer blocks.
      await handover.gone({ processIds: ["old-volume"] });
      expect((await handover.arm(VOLUME_VAULT, heights(1_000n, 990n))).waitUntilFinalizedAbove).toBe(1_000n + HANDOVER_WAIT_BLOCKS);
    });

    it("a keeper that read it but was not acting does not count — unless the operator says this is a drill with no armed keeper", async () => {
      const handover = new Handover(db);
      await handover.drain(VOLUME_VAULT);
      await both(["profit", "volume"], false);
      expect((await handover.arm(VOLUME_VAULT, heights(1_000n, 990n))).blockers).toHaveLength(2);
      expect((await handover.arm(VOLUME_VAULT, heights(1_000n, 990n), { allowDry: true })).waitUntilFinalizedAbove).toBe(1_150n);
      // ONLY THE ROLES ASKED FOR: a fleet that runs no volume keeper says so explicitly.
      await db.query("UPDATE sip_solana.vault_work SET handover_height = NULL");
      await db.query("DELETE FROM sip_solana.legacy_process WHERE role = 'volume'");
      await db.query("UPDATE sip_solana.legacy_process SET live = true");
      expect((await handover.arm(VOLUME_VAULT, heights(1_000n, 990n))).blockers).toEqual([expect.stringMatching(/no ACTING volume keeper/)]);
      expect((await handover.arm(VOLUME_VAULT, heights(1_000n, 990n), { requiredRoles: ["profit"] })).waitUntilFinalizedAbove).toBe(1_150n);
    });

    it("a receipt older than the freshness bound does not count for its role", async () => {
      const handover = new Handover(db);
      await handover.drain(VOLUME_VAULT);
      await both();
      await db.query(`UPDATE sip_solana.legacy_process SET read_at = clock_timestamp() - make_interval(secs => $1) WHERE role = 'volume'`, [LEGACY_READ_FRESH_MS / 1000 + 60]);
      expect((await handover.arm(VOLUME_VAULT, heights(1_000n, 990n))).blockers).toEqual([expect.stringMatching(/no ACTING volume keeper .* in the last 15 min/)]);
    });

    it("never arms a vault whose loss carry lives only in a legacy keeper's memory", async () => {
      const handover = new Handover(db);
      await handover.drain(PROFIT_VAULT);
      await readOk(keeper("profit", "profit-1"), true, [PROFIT_VAULT]);
      await readOk(keeper("volume", "volume-1"), true);
      expect((await handover.arm(PROFIT_VAULT, heights(1_000n, 990n))).blockers).toEqual([expect.stringMatching(/holds a loss carry .* only in its memory.*SIP_SOLANA_CARRY_STORE=dual or on/)]);
    });

    it("a dual profit keeper whose Postgres write of a carry failed names that vault in its receipt, and arm refuses it", async () => {
      const handover = new Handover(db);
      await handover.drain(PROFIT_VAULT);
      // THE KEEPER'S OWN STORE OBJECT, over a table whose write times out (the 2 s budget; 30 ms here).
      const store: DurableCarryStore = {
        carryFor: async () => null,
        recordCarry: () => new Promise(() => undefined),
        loadAll: async () => [],
        ready: async () => ({ ok: true, detail: "test" }),
      };
      const carries = new DurableCarries("dual", store, { fire: () => undefined, clear: () => undefined, warn: () => undefined }, 30);
      const book: CarryBook = new Map();
      const link = { linkAddress: new PublicKey(Buffer.alloc(32, 9)), vault: { toBase58: () => PROFIT_VAULT }, epoch: 3n, settlementNonce: 7n, frontierSlot: 100n };
      // THE SETTLE GOES ON FROM MEMORY, AS dual DOES; Postgres never got the row.
      expect(await carries.recordCarry(book, link, 900n, { lossLamports: 1_000n, walletSignedTxCount: 1 }, MODE_PROFIT, { currentSlot: 1n, validUntilSlot: 2n, nonceNow: async () => 7n })).toEqual({ kind: "written" });
      const named = carryOnlyInMemoryVaults([link], book, carries.memoryOnlyLinks(book));
      expect(named).toEqual([PROFIT_VAULT]);
      await readOk(keeper("profit", "profit-1", "on", "dual"), true, named);
      await readOk(keeper("volume", "volume-1"), true);
      expect((await handover.arm(PROFIT_VAULT, heights(1_000n, 990n))).blockers).toEqual([
        expect.stringMatching(/legacy process profit-1 .*holds a loss carry .* only in its memory/),
      ]);
    });

    it("records the processed height once nothing blocks, and moves the vault only once the finalized height is 150 blocks past it", async () => {
      const handover = new Handover(db);
      await handover.drain(VOLUME_VAULT);
      await both();
      const first = await handover.arm(VOLUME_VAULT, heights(5_000n, 4_970n));
      expect(first).toMatchObject({ moved: false, system: "draining", waitUntilFinalizedAbove: 5_150n });
      // A LATER CALL DOES NOT MOVE THE RECORD FORWARD: it waits from the first.
      expect(await handover.arm(VOLUME_VAULT, heights(5_100n, 5_100n))).toMatchObject({ moved: false, waitUntilFinalizedAbove: 5_150n });
      expect(await handover.arm(VOLUME_VAULT, heights(5_200n, 5_150n))).toMatchObject({ moved: false, waitUntilFinalizedAbove: 5_150n });
      expect(await systemOf(VOLUME_VAULT)).toBe("draining");
      // AND THE LEGACY KEEPERS LEAVE IT ALONE THE WHOLE TIME; then the queue may claim it.
      expect(await handover.arm(VOLUME_VAULT, heights(5_200n, 5_151n))).toEqual({ vault: VOLUME_VAULT, system: "queue", moved: true, blockers: [] });
      expect((await db.query(CLAIM_SQL, ["w-1", 1])).rows.map((row) => row.vault_addr)).toEqual([VOLUME_VAULT]);
      const after = await readOk(keeper("profit", "profit-1"));
      expect(partitionLegacyTurns([VOLUME_VAULT], (v) => v, after).left).toEqual([{ turn: VOLUME_VAULT, reason: "queue" }]);
    });

    it("a blocker that appears during the wait clears the recorded height, and the wait starts again", async () => {
      const handover = new Handover(db);
      await handover.drain(VOLUME_VAULT);
      await both();
      await handover.arm(VOLUME_VAULT, heights(5_000n, 4_970n));
      // A NEW CONTAINER THAT READ BEFORE THE VAULT WAS DRAINING (simulated: its receipt names nothing).
      await db.query(
        `INSERT INTO sip_solana.legacy_process (process_id, role, dispatch, live, read_at, absent_is) VALUES ('late', 'profit', 'on', true, clock_timestamp(), 'legacy')`,
      );
      expect((await handover.arm(VOLUME_VAULT, heights(6_000n, 5_999n))).moved).toBe(false);
      expect((await db.query("SELECT handover_height FROM sip_solana.vault_work")).rows[0].handover_height).toBeNull();
      await readOk(keeper("profit", "late"));
      expect(await handover.arm(VOLUME_VAULT, heights(6_000n, 5_999n))).toMatchObject({ moved: false, waitUntilFinalizedAbove: 6_150n });
    });

    it("a shadow's database, which no legacy keeper uses: --roles=none still waits the blocks, and still honours any receipt there is", async () => {
      const handover = new Handover(db);
      await handover.setNewVaultSystem("queue");
      await enrol([
        [VOLUME_VAULT, 1],
        [PROFIT_VAULT, 0],
      ]);
      const deps = { handover, heights: async () => heights(9_000n, 8_970n) };
      const first = await runHandoverCommand(parseHandoverArgs(["arm", "--all", "--roles=none", "--allow-dry"]), deps);
      expect(first.ok).toBe(false);
      expect((first.result as { waitUntilFinalizedAbove?: bigint }[]).map((step) => step.waitUntilFinalizedAbove)).toEqual([9_150n, 9_150n]);
      const later = { handover, heights: async () => heights(9_200n, 9_151n) };
      expect(await runHandoverCommand(parseHandoverArgs(["arm", "--all", "--roles=none", "--allow-dry"]), later)).toMatchObject({ ok: true });
      expect((await db.query(CLAIM_SQL, ["w-1", 10])).rows).toHaveLength(2);
      // A RECEIPT THAT IS THERE STILL COUNTS: a legacy keeper reading this database blocks until it lets go.
      await db.query(
        `INSERT INTO sip_solana.vault_work (vault_addr, system) VALUES ($1, 'draining')`,
        [OTHER_VAULT],
      );
      await db.query(`INSERT INTO sip_solana.legacy_process (process_id, role, dispatch, live, read_at, absent_is) VALUES ('stray', 'profit', 'on', false, clock_timestamp(), 'queue')`);
      expect((await handover.arm(OTHER_VAULT, heights(9_200n, 9_151n), { requiredRoles: [], allowDry: true })).blockers).toEqual([
        expect.stringMatching(/legacy process stray .* has not yet read this vault/),
      ]);
    });

    it("refuses a vault that is not draining", async () => {
      const handover = new Handover(db);
      expect((await handover.arm(VOLUME_VAULT, heights(1n, 1n))).blockers).toEqual(["vault_work has no row for this vault: drain it first"]);
      await enrol([[VOLUME_VAULT, 1]]);
      expect((await handover.arm(VOLUME_VAULT, heights(1n, 1n))).blockers).toEqual([expect.stringMatching(/the vault is legacy: only a draining vault is armed/)]);
    });

    it("gone --stale marks only the rows that have not read within the bound", async () => {
      const handover = new Handover(db);
      await both();
      await db.query(`UPDATE sip_solana.legacy_process SET read_at = clock_timestamp() - interval '1 hour' WHERE role = 'volume'`);
      expect((await handover.gone({ stale: true })).map((row) => row.processId)).toEqual(["volume-1"]);
      expect((await handover.gone({ stale: true })).map((row) => row.processId)).toEqual([]);
    });
  });

  describe("back the other way, queue → legacy", () => {
    const intent = (fence: number, lvbh: number, resolved: number | null = null) =>
      db.query(
        `INSERT INTO sip_solana.send_intent (vault_addr, kind, fence, worker_id, blockhash, last_valid_block_height, state, resolved_height, resolved_at)
         VALUES ($1, 'wrap', $2, 'w-1', 'bh', $3, $4, $5, $6)`,
        [VOLUME_VAULT, fence, lvbh, resolved === null ? "intent" : "landed", resolved, resolved === null ? null : new Date()],
      );

    it("rollback stops new claims; release waits for the holder's job and every intent's last height, then hands it back", async () => {
      const handover = new Handover(db);
      await enrol([[VOLUME_VAULT, 1]]);
      await db.query("UPDATE sip_solana.vault_work SET system = 'queue'");
      const [claim] = (await db.query(CLAIM_SQL, ["w-1", 1])).rows;
      expect(claim.vault_addr).toBe(VOLUME_VAULT);
      expect(await handover.rollback(VOLUME_VAULT)).toEqual({ vault: VOLUME_VAULT, system: "draining", moved: true, blockers: [] });
      expect(await handover.rollback(VOLUME_VAULT)).toMatchObject({ moved: false, system: "draining" });
      await db.query("UPDATE sip_solana.vault_work SET holder = NULL, lease_until = NULL");
      expect((await db.query(CLAIM_SQL, ["w-2", 1])).rows).toEqual([]);
      await db.query("UPDATE sip_solana.vault_work SET holder = 'w-1', lease_until = clock_timestamp() + interval '45 seconds', claimed_at = clock_timestamp()");
      await intent(1, 2_000);
      await intent(1, 2_100, 1_990);
      const held = await handover.release(VOLUME_VAULT, heights(3_000n, 1_999n));
      expect(held.moved).toBe(false);
      expect(held.blockers).toEqual([
        expect.stringMatching(/worker w-1 still holds it/),
        expect.stringMatching(/could still land until height 2000.*now 1999/),
      ]);
      // THE JOB COMPLETED; THE LAST INTENT'S HEIGHT IS NOT YET FINAL.
      await db.query("UPDATE sip_solana.vault_work SET holder = NULL, lease_until = NULL");
      expect((await handover.release(VOLUME_VAULT, heights(3_000n, 2_000n))).blockers).toEqual([expect.stringMatching(/until height 2000/)]);
      expect(await handover.release(VOLUME_VAULT, heights(3_000n, 2_001n))).toEqual({ vault: VOLUME_VAULT, system: "legacy", moved: true, blockers: [] });
      expect(partitionLegacyTurns([VOLUME_VAULT], (v) => v, await readOk(keeper("profit", "p-1"))).act).toEqual([VOLUME_VAULT]);
    });

    // A LINK OF THE PROFIT VAULT, as the scheduler's listing holds it, and a carry row as a gate (or L2) writes it.
    const LINK = "LinkOfProfitVau1tMadeUp111111111111111111111";
    const listLink = (link: string, vault: string, epoch: number, nonce: number) =>
      db.query(
        `INSERT INTO sip_solana.keeper_link (link_addr, wallet_addr, vault_addr, epoch, settlement_nonce, frontier_slot, seen_slot)
         VALUES ($1, 'WalletMadeUp', $2, $3, $4, 1000, 2000)`,
        [link, vault, epoch, nonce],
      );
    const carry = (link: string, epoch: number, nonce: number, fence: number | null) =>
      db.query(
        `INSERT INTO sip_solana.loss_carry (link_addr, epoch, settlement_nonce, frontier_slot, loss_lamports, wallet_signed_tx_count, valid_until_slot, written_by, written_fence, send_intent_id)
         VALUES ($1, $2, $3, 1500, 250000000, 2, 1600, $4, $5, $6)`,
        [link, epoch, nonce, fence === null ? "sip-solana-keeper:l2" : "worker:a", fence, fence === null ? null : 9],
      );
    const drainingProfitVault = async () => {
      await enrol([[PROFIT_VAULT, 0]]);
      await db.query("UPDATE sip_solana.vault_work SET system = 'draining' WHERE vault_addr = $1", [PROFIT_VAULT]);
    };

    it("never releases a vault whose link holds a loss a worker carried to a profit keeper that would not read it: off and dual refuse, on lets it go", async () => {
      const handover = new Handover(db);
      await drainingProfitVault();
      await listLink(LINK, PROFIT_VAULT, 3, 7);
      // THE WORKER'S GATE WROTE IT, for the state its settle leaves (fence 4): only Postgres holds it.
      await carry(LINK, 3, 8, 4);
      await readOk(keeper("volume", "volume-1"));
      // `off`: the legacy profit keeper never reads loss_carry.
      await readOk(keeper("profit", "profit-off", "on", "off"));
      const off = await handover.release(PROFIT_VAULT, heights(10n, 10n));
      expect(off).toMatchObject({ moved: false, system: "draining" });
      expect(off.blockers).toEqual([
        expect.stringMatching(
          new RegExp(
            `legacy process profit-off \\(profit, .*runs SIP_SOLANA_CARRY_STORE=off.*link ${LINK} carries 250000000 lamports into state 3:8:1500 \\(written at fence 4\\).*dispatch-handover gone profit-off`,
          ),
        ),
        expect.stringMatching(/no profit keeper running SIP_SOLANA_CARRY_STORE=on has read in the last 15 min/),
      ]);
      // `dual`: it read the store once, at boot, and the worker wrote after that — refused the same way.
      await db.query("TRUNCATE sip_solana.legacy_process");
      await readOk(keeper("volume", "volume-1"));
      await readOk(keeper("profit", "profit-dual", "on", "dual"));
      expect((await handover.release(PROFIT_VAULT, heights(10n, 10n))).blockers).toEqual([
        expect.stringMatching(/legacy process profit-dual .*runs SIP_SOLANA_CARRY_STORE=dual/),
        expect.stringMatching(/no profit keeper running SIP_SOLANA_CARRY_STORE=on/),
      ]);
      // THE PROFIT KEEPER REDEPLOYED WITH `on`: the new container reads on every turn, the old one blocks until it is gone.
      await readOk(keeper("profit", "profit-on", "on", "on"));
      expect((await handover.release(PROFIT_VAULT, heights(10n, 10n))).blockers).toEqual([expect.stringMatching(/legacy process profit-dual /)]);
      await handover.gone({ processIds: ["profit-dual"] });
      // A RECEIPT FROM BEFORE THE COLUMN is not `on` either.
      await db.query(`INSERT INTO sip_solana.legacy_process (process_id, role, dispatch, live, read_at, absent_is) VALUES ('old', 'profit', 'on', true, clock_timestamp(), 'legacy')`);
      expect((await handover.release(PROFIT_VAULT, heights(10n, 10n))).blockers).toEqual([
        expect.stringMatching(/legacy process old .*runs SIP_SOLANA_CARRY_STORE=unknown \(its receipt predates the column\)/),
      ]);
      await handover.gone({ processIds: ["old"] });
      // AN `on` RECEIPT THAT IS NOT RECENT IS NO EVIDENCE the service still runs it.
      await db.query(`UPDATE sip_solana.legacy_process SET read_at = clock_timestamp() - make_interval(secs => $1) WHERE process_id = 'profit-on'`, [LEGACY_READ_FRESH_MS / 1000 + 60]);
      expect((await handover.release(PROFIT_VAULT, heights(10n, 10n))).blockers).toEqual([expect.stringMatching(/no profit keeper running SIP_SOLANA_CARRY_STORE=on has read/)]);
      await readOk(keeper("profit", "profit-on", "on", "on"));
      expect(await handover.release(PROFIT_VAULT, heights(10n, 10n))).toEqual({ vault: PROFIT_VAULT, system: "legacy", moved: true, blockers: [] });
      expect((await handover.status()).processes.find((row) => row.processId === "profit-on")?.carryStore).toBe("on");
    });

    it("a carry the chain has left, one L2 wrote, or one of another vault's link does not hold the release", async () => {
      const handover = new Handover(db);
      await drainingProfitVault();
      await listLink(LINK, PROFIT_VAULT, 3, 9);
      await listLink("LinkOfAnotherVau1tMadeUp11111111111111111111", OTHER_VAULT, 3, 7);
      await readOk(keeper("profit", "profit-off", "on", "off"));
      // BELOW THE STATE THE LISTING SAW, in nonce and in epoch: it can never match again.
      await carry(LINK, 3, 8, 4);
      await carry(LINK, 2, 12, 3);
      // L2's own row: no fence; the legacy keeper that wrote it kept it in its memory.
      await carry(LINK, 3, 9, null);
      // A worker's carry on ANOTHER vault's link.
      await carry("LinkOfAnotherVau1tMadeUp11111111111111111111", 3, 8, 5);
      expect(await handover.release(PROFIT_VAULT, heights(10n, 10n))).toEqual({ vault: PROFIT_VAULT, system: "legacy", moved: true, blockers: [] });
      // AND ONE ABOVE THE LISTED STATE STILL COUNTS: a listing that lags errs towards refusing.
      await db.query("UPDATE sip_solana.vault_work SET system = 'draining' WHERE vault_addr = $1", [PROFIT_VAULT]);
      await carry(LINK, 3, 10, 6);
      expect((await handover.release(PROFIT_VAULT, heights(10n, 10n))).blockers).toEqual([
        expect.stringMatching(/profit-off .*into state 3:10:1500 \(written at fence 6\)/),
        expect.stringMatching(/no profit keeper running SIP_SOLANA_CARRY_STORE=on/),
      ]);
    });

    it("a holder whose lease ran out past the job ceiling can neither renew nor gate, and does not hold the release", async () => {
      expect(RELEASE_JOB_CEILING_MINUTES).toBe(JOB_CEILING_MINUTES);
      const handover = new Handover(db);
      await enrol([[VOLUME_VAULT, 1]]);
      await db.query(
        `UPDATE sip_solana.vault_work SET system = 'draining', holder = 'w-dead', lease_until = clock_timestamp() - interval '1 minute',
                claimed_at = clock_timestamp() - interval '${JOB_CEILING_MINUTES} minutes 1 second'`,
      );
      expect(await handover.release(VOLUME_VAULT, heights(10n, 10n))).toMatchObject({ moved: true, system: "legacy" });
      expect((await db.query("SELECT holder, lease_until FROM sip_solana.vault_work")).rows[0]).toEqual({ holder: null, lease_until: null });
      // INSIDE THE CEILING, AN EXPIRED LEASE COULD STILL BE RENEWED: it holds.
      await db.query(
        `UPDATE sip_solana.vault_work SET system = 'draining', holder = 'w-slow', lease_until = clock_timestamp() - interval '1 second',
                claimed_at = clock_timestamp() - interval '2 minutes'`,
      );
      expect((await handover.release(VOLUME_VAULT, heights(10n, 10n))).blockers).toEqual([expect.stringMatching(/worker w-slow still holds it/)]);
    });
  });

  describe("the operator's command, end to end", () => {
    it("drains, waits, arms and reports through runHandoverCommand", async () => {
      const handover = new Handover(db);
      let chain = heights(7_000n, 6_970n);
      const deps = { handover, heights: async () => chain };
      expect(await runHandoverCommand(parseHandoverArgs(["drain", VOLUME_VAULT]), deps)).toMatchObject({ ok: true, result: { system: "draining" } });
      for (const role of ["profit", "volume"] as const) await readOk(keeper(role, `${role}-1`));
      expect(await runHandoverCommand(parseHandoverArgs(["arm", VOLUME_VAULT]), deps)).toMatchObject({ ok: false, result: { waitUntilFinalizedAbove: 7_150n } });
      chain = heights(7_200n, 7_151n);
      expect(await runHandoverCommand(parseHandoverArgs(["arm", "--all"]), deps)).toMatchObject({ ok: true, result: [{ vault: VOLUME_VAULT, moved: true }] });
      const status = await runHandoverCommand(parseHandoverArgs(["status"]), deps);
      expect(status).toMatchObject({
        ok: true,
        result: {
          newVaultSystem: "legacy",
          vaults: [{ vault: VOLUME_VAULT, system: "queue", handoverHeight: 7_000n }],
          processes: [
            { processId: "profit-1", role: "profit", live: true, notLegacy: { [VOLUME_VAULT]: "draining" } },
            { processId: "volume-1", role: "volume", live: true },
          ],
        },
      });
      expect(await runHandoverCommand(parseHandoverArgs(["new-vaults", "queue"]), deps)).toEqual({ ok: true, result: { newVaultSystem: "queue" } });
    });

    it("status --all lists every row, legacy included, with the queue's columns and the webhook's owner; plain status keeps its selection", async () => {
      const handover = new Handover(db);
      const deps = { handover, heights: async () => heights(1n, 1n) };
      await enrol([
        [PROFIT_VAULT, 0],
        [VOLUME_VAULT, 1],
      ]);
      await db.query(
        `UPDATE sip_solana.vault_work
            SET system = 'queue', lane = 'retry', priority = 1, fence = 7, attempts = 2, claimed_at = clock_timestamp(), last_done_at = clock_timestamp(),
                last_outcome = 'SETTLED', last_detail = repeat('x', 400), streaks = '{"settleRetries": {"WalletMadeUp": 1}}', due_at = 'infinity'
          WHERE vault_addr = $1`,
        [VOLUME_VAULT],
      );
      await db.query("UPDATE sip_solana.fleet SET webhook_owner = 'scheduler'");
      const plain = await runHandoverCommand(parseHandoverArgs(["status"]), deps);
      expect((plain.result as HandoverStatus).vaults.map((v) => v.vault)).toEqual([VOLUME_VAULT]);
      expect(plain.result).toMatchObject({ webhookOwner: "scheduler" });
      const all = await runHandoverCommand(parseHandoverArgs(["status", "--all"]), deps);
      expect(all).toMatchObject({
        ok: true,
        result: {
          newVaultSystem: "legacy",
          webhookOwner: "scheduler",
          vaults: [
            {
              vault: VOLUME_VAULT,
              system: "queue",
              skimMode: 1,
              lane: "retry",
              fence: "7",
              attempts: 2,
              lastOutcome: "SETTLED",
              lastDetail: "x".repeat(STATUS_DETAIL_CHARS),
              parkedReason: null,
              dueAt: "infinity",
              streaks: { settleRetries: { WalletMadeUp: 1 } },
              claimedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
              lastDoneAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
            },
            { vault: PROFIT_VAULT, system: "legacy", skimMode: 0, lane: "new", fence: "0", attempts: 0, lastOutcome: null, lastDetail: null, claimedAt: null, streaks: {} },
          ],
        },
      });
      const profit = (all.result as HandoverStatus).vaults[1]!;
      expect(new Date(profit.dueAt!).getTime()).toBeGreaterThan(Date.now() - 60_000);
      // THE PRINTED LINE (bin/dispatch-handover.mts): bigints as strings, the rest as it is.
      const printed = JSON.parse(JSON.stringify(all.result, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value)));
      expect(printed.vaults[0]).toMatchObject({ fence: "7", handoverHeight: null, dueAt: "infinity" });
      await expect(handover.status(VOLUME_VAULT, { all: true })).rejects.toThrow(/not both/);
    });

    it("unpark clears a vault the scheduler parked — reason, streak, due now — and the queue takes it again; anything else is refused", async () => {
      const handover = new Handover(db);
      const deps = { handover, heights: async () => heights(1n, 1n) };
      await enrol([[VOLUME_VAULT, 1]]);
      await db.query(
        `UPDATE sip_solana.vault_work
            SET system = 'queue', holder = 'w-dead', lease_until = clock_timestamp() - interval '1 second', claimed_at = clock_timestamp() - interval '2 minutes',
                attempts = 5, fence = 5, due_at = clock_timestamp() + interval '1 hour'`,
      );
      // PARKED BY THE SCHEDULER'S OWN REAP: no worker takes it.
      expect(await new PgSchedulerStore(db).park()).toEqual([{ vault: VOLUME_VAULT, attempts: 5 }]);
      expect((await db.query(CLAIM_SQL, ["w-2", 1])).rows).toEqual([]);
      expect(await runHandoverCommand(parseHandoverArgs(["unpark", VOLUME_VAULT]), deps)).toEqual({
        ok: true,
        result: { vault: VOLUME_VAULT, wasParked: true, parkedReason: expect.stringContaining("its lease lapsed 5 claims in a row"), attempts: 5 },
      });
      const row = (
        await db.query(
          "SELECT parked_reason, attempts, holder, fence::text AS fence, due_at <= clock_timestamp() AS due FROM sip_solana.vault_work WHERE vault_addr = $1",
          [VOLUME_VAULT],
        )
      ).rows[0];
      // THE CLAIM'S COLUMNS ARE THE CLAIM'S: the lapsed holder stays until the next CLAIM takes it over.
      expect(row).toEqual({ parked_reason: null, attempts: 0, holder: "w-dead", fence: "5", due: true });
      expect((await db.query(CLAIM_SQL, ["w-2", 1])).rows.map((r) => [r.vault_addr, r.fence, r.attempts])).toEqual([[VOLUME_VAULT, "6", 1]]);
      // NOT PARKED, OR NO ROW: refused, nothing written.
      expect(await runHandoverCommand(parseHandoverArgs(["unpark", VOLUME_VAULT]), deps)).toEqual({
        ok: false,
        result: { vault: VOLUME_VAULT, wasParked: false, detail: expect.stringMatching(/the vault \(queue\) is not parked/) },
      });
      expect(await runHandoverCommand(parseHandoverArgs(["unpark", PROFIT_VAULT]), deps)).toEqual({
        ok: false,
        result: { vault: PROFIT_VAULT, wasParked: false, detail: expect.stringMatching(/no row for this vault/) },
      });
    });
  });
});
