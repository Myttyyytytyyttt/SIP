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
