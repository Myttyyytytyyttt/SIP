// The loss-carry store against Postgres 16: the SQL in sql/sip_solana.sql, the
// PgCarryStore over it, and the settle turn over both (dispatcher ADR §4.6,
// T-C1..T-C6; safety §3.5).
//
// RUN ONLY WITH A THROWAWAY DATABASE ON THE LOOPBACK. KEEPER_TEST_PG_URL names a
// server (a `docker run --rm postgres:16` with a generated password is what this
// was written against); a host that is not the loopback is refused, and nothing
// here touches a database that was there before: each run creates its own
// database, applies the schema file to it, and drops it at the end. Without the
// variable — the Docker build, a plain `pnpm test` — the block is skipped and
// says why in its name.
//
// WHAT IS REAL AND WHAT IS NOT. Real: the schema file, every statement the store
// sends, the CHECKs, the advisory lock, a restart (a new pool, a new process id,
// an empty memory book), and runSettleTick deciding, recording and sending over
// test/settle-world.ts's chain. Not real: the chain itself, which is that small
// world, and the program, whose refusals of a stale nonce this file does not need
// — the gate refuses before anything is sent. The local validator is not used:
// its proof needs the tested sip_vault binary, which lives outside this worktree.
//
// VOLUME CARRIES NO LOSSES, SO NO REAL EVENT CAN PASS L2's GATE TODAY. The only
// vault with activity is VOLUME; the first real carry needs a PROFIT vault to
// trade into a cut losing prefix. Until then these drills are the evidence (ADR
// decision 29, rollout L2: "or the owner's drill").

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Alert } from "../src/alerts.js";
import {
  CARRY_LOCK_CLASS,
  DurableCarries,
  MemoryCarryStore,
  PgCarryStore,
  type CarryLink,
  type CarryStoreHooks,
} from "../src/carry-store.js";
import { MODE_PROFIT } from "../src/program-scripts.js";
import { expectedContribution, type CarryBook, type LossCarry } from "../src/settle-decision.js";
import { EPOCH, SettleWorld, WorldKeeper, rng } from "./settle-world.js";

const URL_RAW = process.env["KEEPER_TEST_PG_URL"];
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const usable = ((): boolean => {
  if (URL_RAW === undefined || URL_RAW.trim() === "") return false;
  try {
    const host = new URL(URL_RAW).hostname;
    if (!LOOPBACK.has(host)) throw new Error(`KEEPER_TEST_PG_URL must point at the loopback; it names another host`);
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("KEEPER_TEST_PG_URL")) throw error;
    return false;
  }
})();

const SCHEMA_SQL = readFileSync(fileURLToPath(new URL("../sql/sip_solana.sql", import.meta.url)), "utf8");
const LOSS: LossCarry = { lossLamports: 500_000_000n, walletSignedTxCount: 1 };
/** The next window's one winning trade. */
const TRADE = 1_000_000_000;
const NET = BigInt(TRADE) - LOSS.lossLamports;
/** What settle_v2 takes at 2 000 bps from the net. */
const PAID_ON_NET = expectedContribution(NET, 2_000, 10_000_000_000n).paid;

function hooks(): CarryStoreHooks & { readonly fired: Alert[] } {
  const fired: Alert[] = [];
  return { fired, fire: (alert) => fired.push(alert), clear: () => undefined, warn: () => undefined };
}

describe.skipIf(!usable)("the loss-carry store on Postgres 16 (needs KEEPER_TEST_PG_URL on the loopback)", () => {
  const database = `keeper_carry_${process.pid}_${Date.now()}`;
  let admin: pg.Pool;
  let db: pg.Pool;
  const pools: pg.Pool[] = [];
  const urlFor = (name: string): string => {
    const url = new URL(URL_RAW!);
    url.pathname = `/${name}`;
    return url.toString();
  };
  /**
   * Every pool this file opens, kept so afterAll ends them all before the
   * database goes. Each absorbs the FATAL a forced drop sends an idle connection,
   * which would otherwise surface as an unhandled 'error' after the tests passed.
   */
  const tracked = (pool: pg.Pool): pg.Pool => {
    pool.on("error", () => undefined);
    pools.push(pool);
    return pool;
  };
  /** A connection pool as one keeper process holds it: one connection, its own. */
  const processPool = (): pg.Pool => tracked(new pg.Pool({ connectionString: urlFor(database), max: 1 }));
  /** One keeper process's store, in `mode`, writing as `writer`. A restart is a new one. */
  const keeperStore = (mode: "dual" | "on", writer: string) => {
    const store = new PgCarryStore(processPool(), writer);
    return { store, carries: new DurableCarries(mode, store, hooks()) };
  };

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: URL_RAW!, max: 2 });
    admin.on("error", () => undefined);
    await admin.query(`CREATE DATABASE ${database}`);
    db = tracked(new pg.Pool({ connectionString: urlFor(database), max: 4 }));
    await db.query(SCHEMA_SQL);
  });

  afterAll(async () => {
    for (const pool of pools) await pool.end().catch(() => undefined);
    if (admin !== undefined) {
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`).catch(() => undefined);
      await admin.end();
    }
  });

  /** A link at nonce 4 with a cut losing prefix: its live settle carries LOSS into the window above prefixEnd. */
  function losingLink() {
    const world = new SettleWorld({ settlementNonce: 4n });
    const prefixEnd = world.losingBacklog();
    return { world, prefixEnd };
  }

  /** The settle of the losing prefix landed, and the wallet won TRADE above it, finalized. */
  function landedThenWon(world: SettleWorld, prefixEnd: bigint): void {
    world.land(prefixEnd, 0);
    world.trade(TRADE);
    world.finalizeTo(world.tip);
  }

  describe("the schema and the store's own rules", () => {
    it("refuses a non-positive loss in code and in the table's CHECK", async () => {
      const { store } = keeperStore("on", "check");
      const link: CarryLink = { linkAddress: new PublicKey(Buffer.alloc(32, 11)), epoch: 1n, settlementNonce: 1n, frontierSlot: 1n };
      await expect(store.recordCarry(link, 2n, { lossLamports: 0n, walletSignedTxCount: 1 }, { validUntilSlot: 9n, gate: null })).rejects.toThrow(
        /a carried loss is positive, not 0 lamports/,
      );
      for (const loss of ["0", "-1"]) {
        await expect(
          db.query(
            `INSERT INTO sip_solana.loss_carry (link_addr, epoch, settlement_nonce, frontier_slot, loss_lamports, wallet_signed_tx_count, valid_until_slot, written_by)
             VALUES ('x', 1, 1, 1, $1, 1, 1, 'test')`,
            [loss],
          ),
        ).rejects.toThrow(/loss_carry_loss_lamports_check/);
      }
    });

    it("is ready over the schema file, and says what is missing over a database without it", async () => {
      expect(await keeperStore("on", "ready").store.ready()).toEqual({ ok: true, detail: "sip_solana.loss_carry is reachable and complete" });
      const bare = `${database}_bare`;
      await admin.query(`CREATE DATABASE ${bare}`);
      const pool = new pg.Pool({ connectionString: urlFor(bare), max: 1 });
      pool.on("error", () => undefined);
      const verdict = await new PgCarryStore(pool, "bare").ready();
      expect(verdict.ok).toBe(false);
      expect(verdict.detail).toMatch(/^sip_solana\.loss_carry does not exist; run `pnpm --dir packages\/solana-keeper setup-read-model`/);
      await pool.end();
      await admin.query(`DROP DATABASE ${bare} WITH (FORCE)`);
    });

    it("applies the schema file twice without error: it is idempotent, and loss_carry survives a re-run", async () => {
      await db.query(
        `INSERT INTO sip_solana.loss_carry (link_addr, epoch, settlement_nonce, frontier_slot, loss_lamports, wallet_signed_tx_count, valid_until_slot, written_by)
         VALUES ('idempotence', 1, 1, 1, 5, 1, 1, 'test')`,
      );
      await db.query(SCHEMA_SQL);
      expect((await db.query(`SELECT count(*)::int AS n FROM sip_solana.loss_carry WHERE link_addr = 'idempotence'`)).rows[0].n).toBe(1);
    });

    it("serializes two writes of one link on its advisory lock: the second sees the first's row and its gate decides", async () => {
      const { store } = keeperStore("on", "second");
      const link: CarryLink = { linkAddress: new PublicKey(Buffer.alloc(32, 12)), epoch: 7n, settlementNonce: 4n, frontierSlot: 100n };
      const holder = await db.connect();
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [CARRY_LOCK_CLASS, link.linkAddress.toBase58()]);
      let settled = false;
      const second = store
        .recordCarry(link, 200n, LOSS, { validUntilSlot: 1_150n, gate: { currentSlot: 1_000n, nonceNow: async () => 4n } })
        .finally(() => {
          settled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(settled, "the second write waits on the first's lock").toBe(false);
      // THE FIRST WRITER'S SETTLE, from the same state, another window, still landable.
      await holder.query(
        `INSERT INTO sip_solana.loss_carry (link_addr, epoch, settlement_nonce, frontier_slot, loss_lamports, wallet_signed_tx_count, valid_until_slot, written_by)
         VALUES ($1, 7, 5, 300, 9, 1, 1100, 'first')`,
        [link.linkAddress.toBase58()],
      );
      await holder.query("COMMIT");
      holder.release();
      const answer = await second;
      expect(answer.kind === "refused" && answer.detail).toMatch(/may still land until slot 1100/);
      expect(await store.carryFor({ ...link, settlementNonce: 5n, frontierSlot: 300n })).toEqual({ lossLamports: 9n, walletSignedTxCount: 1 });
    });
  });

  describe("PgCarryStore and MemoryCarryStore agree on random carryFor/recordCarry sequences", () => {
    it("by memory's rule (dual's writes): every answer equal, over link states that only move forward", async () => {
      let reads = 0;
      let hits = 0;
      for (let seed = 1; seed <= 25; seed++) {
        const random = rng(seed);
        const { store } = keeperStore("dual", `agree-${seed}`);
        const memory = new MemoryCarryStore();
        let link: CarryLink = { linkAddress: new PublicKey(Buffer.alloc(32, 100 + seed)), epoch: 1_000n, settlementNonce: 0n, frontierSlot: 0n };
        let slot = 2_000n;
        for (let step = 0; step < 60; step++) {
          const roll = random();
          if (roll < 0.4) {
            const [a, b] = [await store.carryFor(link), await memory.carryFor(link)];
            expect(a, `seed ${seed} step ${step}`).toEqual(b);
            reads += 1;
            if (a !== null) hits += 1;
          } else if (roll < 0.95) {
            // AN ATTEMPT FROM THIS STATE: any window, any carry or none.
            slot += BigInt(1 + Math.floor(random() * 40));
            const carry = random() < 0.6 ? { lossLamports: BigInt(1 + Math.floor(random() * 1e9)), walletSignedTxCount: Math.floor(random() * 99) } : null;
            await store.recordCarry(link, slot, carry, { validUntilSlot: slot + 150n, gate: null });
            await memory.recordCarry(link, slot, carry);
            // IT LANDS, OR IT DOES NOT AND THE LINK STAYS.
            if (random() < 0.6) link = { ...link, settlementNonce: link.settlementNonce + 1n, frontierSlot: slot };
          } else {
            // A RELINK: a later epoch, from nonce 0.
            slot += 1_000n;
            link = { ...link, epoch: slot, settlementNonce: 0n, frontierSlot: 0n };
          }
        }
      }
      expect(reads).toBeGreaterThan(500);
      expect(hits, "the sequences carried losses often enough to compare some").toBeGreaterThan(100);
    });

    it("by on's rule (the gate): one keeper, one window per state, never refused, every answer equal", async () => {
      let refused = 0;
      let hits = 0;
      for (let seed = 1; seed <= 25; seed++) {
        const random = rng(1_000 + seed);
        const { store } = keeperStore("on", `agree-on-${seed}`);
        const memory = new MemoryCarryStore();
        let link: CarryLink = { linkAddress: new PublicKey(Buffer.alloc(32, 150 + seed)), epoch: 1_000n, settlementNonce: 0n, frontierSlot: 0n };
        let chainSlot = 10_000n;
        // ONE STATE, ONE WINDOW: a window measured from one state is deterministic,
        // so every attempt from it writes the same row (settle-decision.test.ts).
        const windowOf = (state: CarryLink) => {
          const h = Number((state.epoch * 7_919n + state.settlementNonce * 104_729n + state.frontierSlot) % 1_000_003n);
          return { endSlot: state.frontierSlot + 1n + BigInt(h % 50), carry: h % 3 === 0 ? null : { lossLamports: BigInt(1 + (h % 999_983)), walletSignedTxCount: h % 97 } };
        };
        for (let step = 0; step < 60; step++) {
          const roll = random();
          chainSlot += 200n; // past every earlier attempt's deadline
          if (roll < 0.4) {
            const [a, b] = [await store.carryFor(link), await memory.carryFor(link)];
            expect(a, `seed ${seed} step ${step}`).toEqual(b);
            if (a !== null) hits += 1;
          } else {
            const { endSlot, carry } = windowOf(link);
            const nonce = link.settlementNonce;
            const written = await store.recordCarry(link, endSlot, carry, {
              validUntilSlot: chainSlot + 150n,
              gate: { currentSlot: chainSlot, nonceNow: async () => nonce },
            });
            if (written.kind === "refused") refused += 1;
            await memory.recordCarry(link, endSlot, carry);
            if (random() < 0.6) link = { ...link, settlementNonce: link.settlementNonce + 1n, frontierSlot: endSlot };
          }
        }
      }
      expect(refused).toBe(0);
      expect(hits).toBeGreaterThan(50);
    });
  });

  describe("T-C1..T-C6: the settle turn over the store", () => {
    it("T-C1: a restart over the Postgres carry store still nets the carried loss", async () => {
      const { world, prefixEnd } = losingLink();
      const before = new WorldKeeper(world);
      const first = keeperStore("on", "keeper-before-restart");
      await first.carries.prepare(before.carries);
      const settle1 = await before.turn({ live: true, carryStore: first.carries });
      expect(settle1.result, settle1.result.detail).toMatchObject({ outcome: "SETTLED", baseLamports: 0n, carry: LOSS, nonce: 4n, endSlot: prefixEnd });
      landedThenWon(world, prefixEnd);

      // THE RESTART: a new process — an empty book, a new pool, a new writer id.
      const after = new WorldKeeper(world);
      const second = keeperStore("on", "keeper-after-restart");
      await second.carries.prepare(after.carries);
      expect(second.carries.status().dbOnlyAtBoot).toBeGreaterThanOrEqual(1);
      const preview = await after.turn({ carryStore: second.carries });
      expect(preview.result, preview.result.detail).toMatchObject({ outcome: "SETTLED", baseLamports: NET, expectedLamports: PAID_ON_NET });
      expect(preview.result.detail).toContain(`net of ${LOSS.lossLamports} lamports carried`);

      world.receiptVaultDelta = Number(PAID_ON_NET);
      const settle2 = await after.turn({ live: true, carryStore: second.carries });
      expect(settle2.result, settle2.result.detail).toMatchObject({
        outcome: "SETTLED",
        baseLamports: NET,
        expectedLamports: PAID_ON_NET,
        settledLamports: PAID_ON_NET,
        nonce: 5n,
      });
      world.land(settle2.result.endSlot!, Number(PAID_ON_NET));
      expect(world.link.settlementNonce, "the nonce moved 4 → 5 → 6").toBe(6n);
      // NETTED ONCE: nothing applies to the state the second settle left.
      expect(await second.store.carryFor(world.link)).toBeNull();
      expect(second.carries.status()).toMatchObject({ decidedWithDbRow: 1, readFailures: 0, writeFailures: 0, refusedAtGate: 0 });
    });

    it("T-C2: the memory store over a fresh book still charges the trade whole (off, documented)", async () => {
      const { world, prefixEnd } = losingLink();
      const before = new WorldKeeper(world);
      expect((await before.turn({ live: true })).result).toMatchObject({ outcome: "SETTLED", carry: LOSS });
      landedThenWon(world, prefixEnd);
      // THE ONE HOLE `off` KEEPS: a restart is an empty book, and the trade is charged on its own profit.
      const restarted = await new WorldKeeper(world).turn();
      expect(restarted.result, restarted.result.detail).toMatchObject({ outcome: "SETTLED", baseLamports: BigInt(TRADE) });
      expect(restarted.result.detail).not.toContain("carried");
    });

    it("T-C3: two keepers over one store, both turned from nonce 4: one settle lands, its carry row exists, the stale turn is refused at the gate and sends nothing", async () => {
      const { world, prefixEnd } = losingLink();
      const seenByBoth = world.link;
      const a = keeperStore("on", "keeper-a");
      const b = keeperStore("on", "keeper-b");
      const keeperA = new WorldKeeper(world);
      const keeperB = new WorldKeeper(world);
      const settleA = await keeperA.turn({ live: true, carryStore: a.carries, link: seenByBoth });
      expect(settleA.result).toMatchObject({ outcome: "SETTLED", carry: LOSS });
      world.land(prefixEnd, 0);

      const stale = await keeperB.turn({ live: true, carryStore: b.carries, link: seenByBoth });
      expect(stale.result.outcome).toBe("RETRY");
      expect(stale.result.detail).toBe(
        "the link's nonce is 5 on chain, past the 4 this sweep read: another settle landed first, so nothing was sent",
      );
      expect(world.sent, "only A's settle left").toHaveLength(1);
      expect(stale.calls).not.toContain("sendRawTransaction");
      expect(b.carries.status().refusedAtGate).toBe(1);
      // A's ROW SURVIVES B, AND NETS THE NEXT WIN WHOEVER TURNS IT.
      expect(await b.store.carryFor(world.link)).toEqual(LOSS);
      world.trade(TRADE);
      world.finalizeTo(world.tip);
      expect((await keeperB.turn({ carryStore: b.carries })).result).toMatchObject({ outcome: "SETTLED", baseLamports: NET });
    });

    it("T-C4: a successor that takes the vault while the old holder's settle is in flight waits; the carry row of the state it left nets the next win", async () => {
      const { world, prefixEnd } = losingLink();
      const old = keeperStore("on", "old-holder");
      const oldKeeper = new WorldKeeper(world);
      const inFlight = await oldKeeper.turn({ live: true, carryStore: old.carries });
      expect(inFlight.result).toMatchObject({ outcome: "SETTLED", carry: LOSS });
      // NOT LANDED YET: the chain still reads nonce 4, and the old settle's deadline is ahead.
      const successor = keeperStore("on", "successor");
      const successorKeeper = new WorldKeeper(world);
      await successor.carries.prepare(successorKeeper.carries);
      world.advance(10);
      const waited = await successorKeeper.turn({ live: true, carryStore: successor.carries });
      expect(waited.result.outcome).toBe("RETRY");
      expect(waited.result.detail).toMatch(/^a settle another attempt sent from this state may still land until slot \d+ \(the chain is at \d+\)/);
      expect(world.sent, "the successor sent nothing").toHaveLength(1);

      // THE OLD SETTLE LANDS; ITS CARRY ROW IS STILL THERE AND NETS THE NEXT WIN.
      landedThenWon(world, prefixEnd);
      world.receiptVaultDelta = Number(PAID_ON_NET);
      const next = await successorKeeper.turn({ live: true, carryStore: successor.carries });
      expect(next.result, next.result.detail).toMatchObject({ outcome: "SETTLED", baseLamports: NET, settledLamports: PAID_ON_NET, nonce: 5n });
    });

    it("T-C4, its other end: an old settle that never landed and is past its deadline is dead, and the successor settles the same window itself", async () => {
      const { world, prefixEnd } = losingLink();
      const old = keeperStore("on", "old-holder-dead");
      expect((await new WorldKeeper(world).turn({ live: true, carryStore: old.carries })).result).toMatchObject({ outcome: "SETTLED" });
      world.advance(400); // its attestation's 150 slots are long gone; it never landed
      const successor = keeperStore("on", "successor-dead");
      const keeper = new WorldKeeper(world);
      const own = await keeper.turn({ live: true, carryStore: successor.carries });
      expect(own.result, own.result.detail).toMatchObject({ outcome: "SETTLED", carry: LOSS, endSlot: prefixEnd });
      expect(world.sent).toHaveLength(2);
      expect(await successor.store.carryFor({ ...world.link, settlementNonce: 5n, frontierSlot: prefixEnd })).toEqual(LOSS);
    });

    it("T-C5 (RT-8): on reads through, so a carry the previous holder wrote after this process booted nets the next win; dual over the same timing over-charges and says so", async () => {
      const { world, prefixEnd } = losingLink();
      // BOTH SUCCESSORS BOOT FIRST: their seeds see no row for this link.
      const onSuccessor = keeperStore("on", "rt8-on");
      const dualSuccessor = keeperStore("dual", "rt8-dual");
      const onKeeper = new WorldKeeper(world);
      const dualKeeper = new WorldKeeper(world);
      await onSuccessor.carries.prepare(onKeeper.carries);
      await dualSuccessor.carries.prepare(dualKeeper.carries);
      // THEN THE OLD HOLDER'S LAST SETTLE WRITES ITS ROW, AND LANDS.
      const old = keeperStore("on", "rt8-old");
      expect((await new WorldKeeper(world).turn({ live: true, carryStore: old.carries })).result).toMatchObject({ carry: LOSS });
      landedThenWon(world, prefixEnd);

      const netted = await onKeeper.turn({ carryStore: onSuccessor.carries });
      expect(netted.result, netted.result.detail).toMatchObject({ outcome: "SETTLED", baseLamports: NET });
      const whole = await dualKeeper.turn({ carryStore: dualSuccessor.carries });
      expect(whole.result, whole.result.detail).toMatchObject({ outcome: "SETTLED", baseLamports: BigInt(TRADE) });
      expect(dualSuccessor.carries.status()).toMatchObject({ mismatches: 1, lastMismatch: { memory: null, db: LOSS } });
    });

    it("T-C6 (RT-20): an on → dual redeploy with 2 pending carries nets both next wins", async () => {
      const links = [losingLink(), losingLink()];
      const onProcess = keeperStore("on", "rt20-on");
      const onBook: CarryBook = new Map();
      for (const { world } of links) {
        const turn = await new WorldKeeper(world, { carries: onBook }).turn({ live: true, carryStore: onProcess.carries });
        expect(turn.result).toMatchObject({ outcome: "SETTLED", carry: LOSS });
      }
      for (const { world, prefixEnd } of links) landedThenWon(world, prefixEnd);

      // THE ROLLBACK TO dual: a new process, one book for both links, seeded at boot.
      const dualProcess = keeperStore("dual", "rt20-dual");
      const dualBook: CarryBook = new Map();
      await dualProcess.carries.prepare(dualBook);
      for (const { world } of links) {
        world.receiptVaultDelta = Number(PAID_ON_NET);
        const next = await new WorldKeeper(world, { carries: dualBook }).turn({ live: true, carryStore: dualProcess.carries });
        expect(next.result, next.result.detail).toMatchObject({ outcome: "SETTLED", baseLamports: NET, settledLamports: PAID_ON_NET });
      }
      expect(dualProcess.carries.status()).toMatchObject({ decidedWithDbRow: 2, seenInBoth: 2, mismatches: 0, writeFailures: 0 });
    });
  });
});
