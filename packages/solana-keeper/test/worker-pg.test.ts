// A WORKER JOB AGAINST THE REAL STORE, ON POSTGRES 16: the proofs of
// test/worker-job.test.ts that a model of the store could only promise — the
// gate's FOR SHARE row lock and plan floor, the carry written in the settle's
// own gate transaction (S-4), the shadow world's rows, the takeover's wait, the
// outbox's investment_event row, COMPLETE — each against src/dispatch-store.ts's
// own statements and sql/sip_solana.sql's own tables, with the overlap audit
// read from the database at the end of every one.
//
// RUN ONLY WITH A THROWAWAY DATABASE ON THE LOOPBACK, as the other *-pg tests:
// KEEPER_TEST_PG_URL names a server (a `docker run --rm postgres:16-alpine` with
// a generated password); a host that is not the loopback is refused; the run
// creates its own database and drops it at the end. Without the variable the
// block is skipped and says why.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DispatchStore } from "../src/dispatch-store.js";
import { SolanaReadModel } from "../src/read-model.js";
import { runSettleTick, type SettleDeps } from "../src/settle-tick.js";
import { runVaultJob } from "../src/worker-job.js";
import { SettleWorld } from "./settle-world.js";
import { buyingInvest, deps, jobChain, keysFor } from "./worker-world.js";

const URL_RAW = process.env["KEEPER_TEST_PG_URL"];
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const usable = ((): boolean => {
  if (URL_RAW === undefined || URL_RAW.trim() === "") return false;
  const host = new URL(URL_RAW).hostname;
  if (!LOOPBACK.has(host)) throw new Error("KEEPER_TEST_PG_URL must point at the loopback; it names another host");
  return true;
})();

const SCHEMA_SQL = readFileSync(fileURLToPath(new URL("../sql/sip_solana.sql", import.meta.url)), "utf8");

describe.skipIf(!usable)("a worker job on the real store, Postgres 16 (needs KEEPER_TEST_PG_URL on the loopback)", () => {
  const database = `keeper_worker_${process.pid}_${Date.now()}`;
  let admin: pg.Pool;
  let db: pg.Pool;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: URL_RAW!, max: 1 });
    admin.on("error", () => undefined);
    await admin.query(`CREATE DATABASE ${database}`);
    const url = new URL(URL_RAW!);
    url.pathname = `/${database}`;
    db = new pg.Pool({ connectionString: url.toString(), max: 4 });
    db.on("error", () => undefined);
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
    await db.query(
      "TRUNCATE sip_solana.keeper_link, sip_solana.vault_work, sip_solana.send_intent, sip_solana.loss_carry, sip_solana.worker, sip_solana.investment_event, sip_solana.settlement_event, sip_solana.vault, sip_solana.trading_link",
    );
    await db.query("UPDATE sip_solana.fleet SET board_dirty_at = NULL");
  });

  const intents = async (): Promise<number> => Number((await db.query("SELECT count(*) AS n FROM sip_solana.send_intent")).rows[0]!["n"]);
  const audit = async (): Promise<unknown[]> => (await new DispatchStore(db, "auditor").overlapAudit()).map(String);
  const rows = async () =>
    (
      await db.query<{ id: string; kind: string; state: string; fence: string; plan_cleared_height: string | null; resolved_height: string | null; signature: string | null }>(
        "SELECT id, kind, state, fence, plan_cleared_height, resolved_height, signature FROM sip_solana.send_intent ORDER BY id",
      )
    ).rows;

  /** One wallet's vault on the queue, with its link in keeper_link as the scheduler's discovery would leave it. */
  async function queuedOnPg(world: SettleWorld): Promise<string> {
    const vault = world.link.vault.toBase58();
    await db.query("INSERT INTO sip_solana.vault_work (vault_addr, system, skim_mode) VALUES ($1, 'queue', 0)", [vault]);
    await db.query(
      "INSERT INTO sip_solana.keeper_link (link_addr, wallet_addr, vault_addr, epoch, settlement_nonce, frontier_slot, seen_slot) VALUES ($1, $2, $3, $4, $5, $6, 1)",
      [world.link.linkAddress.toBase58(), world.wallet.toBase58(), vault, world.link.epoch.toString(), world.link.settlementNonce.toString(), world.link.frontierSlot.toString()],
    );
    return vault;
  }

  it("live: the settle with its carry IN the gate transaction, the wrap and the leg — each committed before it left — the leg's history, COMPLETE, no overlap", async () => {
    const world = new SettleWorld();
    world.losingBacklog();
    const vault = await queuedOnPg(world);
    const store = new DispatchStore(db, "worker-live");
    const { chain, intentsAtSend } = jobChain([world], intents);
    const history = SolanaReadModel.overPool(db, () => undefined);
    const [claimed] = await store.claim(1);
    const end = await runVaultJob(claimed!, deps(store, chain, { keys: keysFor([world]), history, invest: buyingInvest(chain.program).invest }));

    expect(end.kind).toBe("complete");
    expect(intentsAtSend).toEqual([1, 2, 3]);
    expect(world.sent).toHaveLength(3);
    const sent = await rows();
    expect(sent.map((row) => [row.kind, row.state, row.fence])).toEqual([
      ["settle", "landed", "1"],
      ["wrap", "landed", "1"],
      ["invest", "landed", "1"],
    ]);
    // S-4: the carry the PROFIT zero settle hands on, written by the gate, stamped with its fence and its intent.
    const carry = (await db.query("SELECT loss_lamports, written_fence, send_intent_id, written_by FROM sip_solana.loss_carry")).rows;
    expect(carry).toEqual([{ loss_lamports: "500000000", written_fence: "1", send_intent_id: sent[0]!.id, written_by: "worker-live" }]);
    // S-9: the leg's row, keyed by its signature.
    const legs = (await db.query("SELECT tx_ref, spent_raw FROM sip_solana.investment_event")).rows;
    expect(legs).toEqual([{ tx_ref: sent[2]!.signature, spent_raw: "2000000" }]);
    expect((await db.query("SELECT count(*) AS n FROM sip_solana.settlement_event")).rows[0]!["n"]).toBe("1");
    expect((await db.query("SELECT board_dirty_at IS NOT NULL AS dirty FROM sip_solana.fleet")).rows[0]!["dirty"]).toBe(true);
    if (end.kind !== "complete") return;
    expect(await store.complete(claimed!, end.completion)).toBe(true);
    const row = (await db.query("SELECT holder, last_outcome, last_holder FROM sip_solana.vault_work WHERE vault_addr = $1", [vault])).rows[0];
    expect(row).toEqual({ holder: null, last_outcome: "settle SETTLED · invest INVESTED", last_holder: "worker-live" });
    expect(await audit()).toEqual([]);
  });

  it("live: a vault taken over mid-job — the real gate refuses the wrap under its row lock, and nothing after the settle is sent", async () => {
    const world = new SettleWorld();
    world.trade(400_000_000);
    world.finalizeTo(world.tip);
    const vault = await queuedOnPg(world);
    const store = new DispatchStore(db, "worker-a");
    const { chain } = jobChain([world], intents);
    const [claimed] = await store.claim(1);
    const settle = async (settleDeps: SettleDeps) => {
      const result = await runSettleTick(settleDeps);
      // ITS LEASE RUNS OUT AND worker-b CLAIMS: fence 2.
      await db.query("UPDATE sip_solana.vault_work SET lease_until = clock_timestamp() - interval '1 second' WHERE vault_addr = $1", [vault]);
      expect(await new DispatchStore(db, "worker-b").claim(1)).toHaveLength(1);
      return result;
    };
    const end = await runVaultJob(claimed!, deps(store, chain, { keys: keysFor([world]), settle, invest: buyingInvest(chain.program).invest }));
    expect(end.kind).toBe("stop");
    expect(world.sent).toHaveLength(1);
    expect((await rows()).map((row) => row.kind)).toEqual(["settle"]);
    expect(await store.release(claimed!, "stopped")).toBe(false);
    expect(await audit()).toEqual([]);
  });

  it("shadow: 'shadow' rows for the would-be settle, wrap, convert and leg, nothing sent, no carry — and the next job plans only above them", async () => {
    const world = new SettleWorld();
    world.trade(400_000_000);
    world.finalizeTo(world.tip);
    const vault = await queuedOnPg(world);
    const store = new DispatchStore(db, "worker-shadow", "shadow");
    const { chain, state } = jobChain([world], intents, { finalized: 5_000n, confirmed: 5_020n });
    const [first] = await store.claim(1);
    const end = await runVaultJob(first!, deps(store, chain, { invest: buyingInvest(chain.program).invest }));
    expect(end.kind).toBe("complete");
    expect(world.sent).toHaveLength(0);
    // RESOLVED AT ONCE, at the confirmed height — capped at each row's own last valid height: the stub's settle
    // blockhash expires at 1000, under the chain's 5020, and a row is never said to act past its blockhash.
    expect((await rows()).map((row) => [row.kind, row.state, row.resolved_height])).toEqual([
      ["settle", "shadow", "1000"],
      ["wrap", "shadow", "5020"],
      ["convert", "shadow", "5020"],
      ["invest", "shadow", "5020"],
    ]);
    expect((await db.query("SELECT count(*) AS n FROM sip_solana.loss_carry")).rows[0]!["n"]).toBe("0");
    if (end.kind !== "complete") return;
    await store.complete(first!, { ...end.completion, dueInSeconds: 0 });

    const [second] = await store.claim(1);
    expect(second!.fence).toBe(2n);
    await runVaultJob(second!, deps(store, chain, {
      invest: buyingInvest(chain.program).invest,
      sleep: async () => {
        state.finalized += 10n;
      },
    }));
    const later = (await rows()).filter((row) => row.fence === "2");
    expect(later.length).toBeGreaterThan(0);
    expect(later.every((row) => BigInt(row.plan_cleared_height!) > 5_020n)).toBe(true);
    expect(world.sent).toHaveLength(0);
    expect(await audit()).toEqual([]);
    void vault;
  });

  it("COMPLETE writes the mode byte the job read on chain — the row's own byte picked nothing — and a release, or a value that is not a byte, keeps it", async () => {
    const world = new SettleWorld();
    world.trade(400_000_000);
    world.finalizeTo(world.tip);
    const vault = await queuedOnPg(world);
    const mode = async (): Promise<number | null> =>
      (await db.query<{ skim_mode: number | null }>("SELECT skim_mode FROM sip_solana.vault_work WHERE vault_addr = $1", [vault])).rows[0]!.skim_mode;
    // THE ROW SAYS VOLUME, THE CHAIN SAYS PROFIT (jobChain's vault): the job settles by the chain's.
    await db.query("UPDATE sip_solana.vault_work SET skim_mode = 1 WHERE vault_addr = $1", [vault]);
    const store = new DispatchStore(db, "worker-shadow", "shadow");
    const { chain } = jobChain([world], intents);
    const [first] = await store.claim(1);
    expect(first!.skimMode).toBe(1);
    const end = await runVaultJob(first!, deps(store, chain, { invest: buyingInvest(chain.program).invest }));
    expect(end.report.module).toBe("PROFIT");
    if (end.kind !== "complete") throw new Error(`the job did not complete: ${end.reason}`);
    expect(await store.complete(first!, { ...end.completion, dueInSeconds: 0 })).toBe(true);
    expect(await mode()).toBe(0);

    // A RELEASE READ NO VAULT: the byte the last read left stays. So does a value that is not a byte.
    await db.query("UPDATE sip_solana.vault_work SET skim_mode = 1 WHERE vault_addr = $1", [vault]);
    const [second] = await store.claim(1);
    expect(await store.release(second!, "SIGTERM")).toBe(true);
    expect(await mode()).toBe(1);
    const [third] = await store.claim(1);
    expect(await store.complete(third!, { rests: true, lane: "safety", streaks: {}, outcome: "IDLE", detail: null, dueInSeconds: 0, skimMode: 300 })).toBe(true);
    expect(await mode()).toBe(1);
    expect(await audit()).toEqual([]);
  });

  it("CLAIM under a saturated queue (a full pass's backlog): a vault whose holder is gone is not starved by the claimer's own vaults", async () => {
    // worker-b's own five vaults come due again the moment each completes; worker-a released 'orphan' six minutes
    // ago on SIGTERM and is gone; 'recent' it released one minute ago.
    await db.query(
      `INSERT INTO sip_solana.vault_work (vault_addr, system, lane, priority, due_at, last_holder)
       SELECT 'own-' || i, 'queue', 'full', 3, clock_timestamp(), 'worker-b' FROM generate_series(1, 5) AS i`,
    );
    await db.query(
      `INSERT INTO sip_solana.vault_work (vault_addr, system, lane, priority, due_at, last_holder) VALUES
         ('orphan', 'queue', 'full', 3, clock_timestamp() - interval '6 minutes', 'worker-a'),
         ('recent', 'queue', 'full', 3, clock_timestamp() - interval '1 minute', 'worker-a')`,
    );
    const b = new DispatchStore(db, "worker-b");
    /** Ten claims of one slot each, every own vault completed due at once, as a saturated worker turns them. */
    const tenClaims = async (claimOnce: () => Promise<string[]>): Promise<string[]> => {
      const order: string[] = [];
      for (let i = 0; i < 10; i++) {
        const [vault] = await claimOnce();
        if (vault === undefined) break;
        order.push(vault);
        await db.query(
          "UPDATE sip_solana.vault_work SET holder = NULL, lease_until = NULL, last_holder = 'worker-b', due_at = clock_timestamp() WHERE vault_addr = $1 AND vault_addr LIKE 'own-%'",
          [vault],
        );
      }
      return order;
    };

    // THE ADR'S ORDER, `COALESCE(last_holder = $1, false) DESC`: every own vault first, for ever. The orphan never comes up.
    const adrOrder = await tenClaims(async () =>
      (
        await db.query<{ vault_addr: string }>(
          `SELECT vault_addr FROM sip_solana.vault_work
            WHERE system = 'queue' AND parked_reason IS NULL AND due_at <= clock_timestamp() AND (holder IS NULL OR lease_until < clock_timestamp())
            ORDER BY priority, COALESCE(last_holder = $1, false) DESC, due_at LIMIT 1`,
          ["worker-b"],
        )
      ).rows.map((row) => row.vault_addr),
    );
    expect(adrOrder).toHaveLength(10);
    expect(adrOrder.every((vault) => vault.startsWith("own-"))).toBe(true);

    // THE STORE'S CLAIM: the six-minute orphan first — it has waited past the five-minute head start — while the
    // one-minute one still yields to the claimer's own, inside its bound.
    const order = await tenClaims(async () => (await b.claim(1)).map((claimed) => claimed.vault));
    expect(order[0]).toBe("orphan");
    expect(order.slice(1).every((vault) => vault.startsWith("own-"))).toBe(true);
    // AND ONCE IT, TOO, HAS WAITED PAST THE BOUND, IT IS NEXT.
    await db.query("UPDATE sip_solana.vault_work SET due_at = clock_timestamp() - interval '301 seconds' WHERE vault_addr = 'recent'");
    expect((await b.claim(1)).map((claimed) => claimed.vault)).toEqual(["recent"]);
  });

  it("takeover: an abandoned send is waited out while the finalized height has not passed it, then expired, and the successor plans above it", async () => {
    const world = new SettleWorld();
    world.trade(400_000_000);
    world.finalizeTo(world.tip);
    const vault = await queuedOnPg(world);
    const old = new DispatchStore(db, "worker-old");
    const [first] = await old.claim(1);
    const gated = await old.gateOneStatement({ vault, fence: first!.fence, kind: "wrap", link: null, blockhash: "bh", lastValidBlockHeight: 5_100n, planClearedHeight: null, signature: null, idempotencyKey: null, amountRaw: 1n });
    expect(gated.kind).toBe("gated");
    // worker-old DIES WITH ITS SEND IN FLIGHT: its lease runs out.
    await db.query("UPDATE sip_solana.vault_work SET lease_until = clock_timestamp() - interval '1 second' WHERE vault_addr = $1", [vault]);

    const store = new DispatchStore(db, "worker-new");
    const { chain, state } = jobChain([world], intents, { finalized: 5_100n, confirmed: 5_090n });
    const [claimed] = await store.claim(1);
    const never = async (): Promise<never> => {
      throw new Error("nothing may be planned while the earlier send can land");
    };
    const waiting = await runVaultJob(claimed!, deps(store, chain, { keys: keysFor([world]), settle: never, invest: never }));
    expect(waiting.kind).toBe("complete");
    if (waiting.kind !== "complete") return;
    expect(waiting.completion.outcome).toBe("WAITING_INTENT");
    expect(await store.complete(claimed!, waiting.completion)).toBe(true);
    expect((await rows())[0]).toMatchObject({ state: "intent", resolved_height: null });

    state.finalized = 5_101n;
    await db.query("UPDATE sip_solana.vault_work SET due_at = clock_timestamp() WHERE vault_addr = $1", [vault]);
    const [again] = await store.claim(1);
    const end = await runVaultJob(again!, deps(store, chain, { keys: keysFor([world]), invest: buyingInvest(chain.program).invest }));
    expect(end.kind).toBe("complete");
    const all = await rows();
    expect(all[0]).toMatchObject({ kind: "wrap", state: "expired", resolved_height: "5100" });
    expect(all.slice(1).length).toBeGreaterThan(0);
    expect(all.slice(1).every((row) => row.plan_cleared_height === "5101")).toBe(true);
    expect(await audit()).toEqual([]);
  });
});
