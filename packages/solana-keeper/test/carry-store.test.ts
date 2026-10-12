// SIP_SOLANA_CARRY_STORE without a database: the variable, the phases' rules
// over a store that can be made to fail, `on`'s gate as a pure function, and the
// settle turn itself over test/settle-world.ts with each phase's store in it.
// What only Postgres can prove — the SQL, the CHECK, a restart over a real table,
// two keepers over one — is test/carry-store-pg.test.ts, against Postgres 16.
//
// THE RULES PINNED HERE, one test each:
//   * `off` is today: no store reaches the turn, and nothing in this file runs.
//   * `dual` decides from memory, writes Postgres after it, compares every read,
//     and goes on when Postgres fails — a warn, never a held settle.
//   * `on` decides from Postgres and sends nothing it could not read or write
//     there: RETRY, the wallet signs nothing, nothing leaves.
//   * a mode that carries no loss (VOLUME) never touches the store in any phase.

import { PublicKey } from "@solana/web3.js";
import { Redactor, Secret } from "@sip/solana-log";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { createAlerter, type Alert, type Alerter } from "../src/alerts.js";
import {
  CARRY_MISMATCH_ALERT_KEY,
  CARRY_STORE_ALERT_KEY,
  CARRY_STORE_CRITICAL_AFTER_MS,
  DurableCarries,
  MemoryCarryStore,
  gateRefusal,
  type CarryGate,
  type CarryLink,
  type CarryStoreHooks,
  type CarryWriteOptions,
  type DurableCarryStore,
  type StoredCarry,
} from "../src/carry-store.js";
import { ConfigError, describeConfig, loadConfig } from "../src/config.js";
import { CARRY_STORE_MODES, readCarryStore } from "../src/cuts.js";
import { SIP_PROGRAM_ID } from "../src/idl.js";
import { MODE_PROFIT, MODE_VOLUME } from "../src/program-scripts.js";
import { DependencyWatch, depDownAlerts, explainedBy, gatedAlerter } from "../src/dependency-watch.js";
import { roleCarriesLosses } from "../src/role-registry.js";
import { settleAlert, settleRetryStreak, type CarryBook, type LossCarry } from "../src/settle-decision.js";
import { EPOCH, SettleWorld, WorldKeeper } from "./settle-world.js";

const dry = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  SIP_SOLANA_RPC_URLS: "https://rpc.example.test/",
  SIP_SOLANA_PROGRAM_ID: SIP_PROGRAM_ID,
  ...over,
});
const DATABASE = { DATABASE_URL: "postgres://keeper:not-a-secret@db.example.test:5432/keeper" };

const refusal = (env: NodeJS.ProcessEnv): string => {
  try {
    loadConfig(env, new Redactor());
  } catch (error) {
    if (error instanceof ConfigError) return error.message;
    throw error;
  }
  throw new Error("expected a ConfigError");
};

describe("SIP_SOLANA_CARRY_STORE", () => {
  it("is off when unset or blank, and off is described exactly as before the variable existed", () => {
    for (const raw of [undefined, "", "  "]) expect(readCarryStore(raw)).toEqual({ mode: "off" });
    const config = loadConfig(dry(), new Redactor());
    expect(config.carryStore).toBe("off");
    expect(describeConfig(config)).not.toHaveProperty("carryStore");
  });

  it("reads off, dual and on, exactly as written, and nothing else", () => {
    expect(CARRY_STORE_MODES).toEqual(["off", "dual", "on"]);
    for (const mode of CARRY_STORE_MODES) expect(readCarryStore(` ${mode} `)).toEqual({ mode });
    for (const bad of ["On", "ON", "true", "1", "memory", "dual,on", "postgres"]) {
      const read = readCarryStore(bad);
      expect("problem" in read && read.problem, bad).toMatch(/must be one of off, dual, on; it holds a \d+-character value/);
      // BY SHAPE, NEVER BY VALUE.
      expect(refusal(dry({ ...DATABASE, SIP_SOLANA_CARRY_STORE: bad }))).not.toContain(bad === "1" ? "holds 1" : bad);
    }
  });

  it("is a variable this keeper reads, and dual or on is described when set", () => {
    const config = loadConfig(dry({ ...DATABASE, SIP_SOLANA_CARRY_STORE: "dual" }), new Redactor());
    expect(config.carryStore).toBe("dual");
    expect(describeConfig(config)).toMatchObject({ carryStore: "dual" });
    expect(config.warnings.join(" ")).not.toMatch(/not a variable this keeper reads/);
  });

  it("refuses dual or on without DATABASE_URL: a store in Postgres needs Postgres", () => {
    for (const mode of ["dual", "on"]) {
      expect(refusal(dry({ SIP_SOLANA_CARRY_STORE: mode }))).toContain(`SIP_SOLANA_CARRY_STORE is ${mode}, which keeps the loss carries in Postgres`);
    }
  });

  it("refuses dual or on on the volume keeper, which settles no mode that carries a loss", () => {
    expect(roleCarriesLosses("profit")).toBe(true);
    expect(roleCarriesLosses("volume")).toBe(false);
    for (const mode of ["dual", "on"]) {
      expect(refusal(dry({ ...DATABASE, SIP_SOLANA_ROLE: "volume", SIP_SOLANA_CARRY_STORE: mode }))).toContain(
        `SIP_SOLANA_CARRY_STORE is ${mode}, but the volume keeper settles no mode that carries a loss`,
      );
    }
    // OFF IS FINE ON EITHER ROLE.
    expect(loadConfig(dry({ SIP_SOLANA_ROLE: "volume", SIP_SOLANA_CARRY_STORE: "off" }), new Redactor()).carryStore).toBe("off");
  });
});

/** A store over memory's own rules that fails, or never answers, on the operations named. */
class FaultyStore implements DurableCarryStore {
  readonly inner = new MemoryCarryStore();
  readonly calls: string[] = [];
  fail = new Set<string>();
  hang = new Set<string>();
  ready_: { ok: boolean; detail: string } = { ok: true, detail: "test store" };
  /** What a failing operation throws: a dropped connection unless a test says otherwise. */
  failWith: (name: string) => Error = (name) => new Error(`${name} refused: connection terminated`);

  async #gate<T>(name: string, work: () => Promise<T>): Promise<T> {
    this.calls.push(name);
    if (this.hang.has(name)) return new Promise<T>(() => undefined);
    if (this.fail.has(name)) throw this.failWith(name);
    return work();
  }

  carryFor(link: CarryLink) {
    return this.#gate("carryFor", () => this.inner.carryFor(link));
  }
  recordCarry(link: CarryLink, endSlot: bigint, carry: LossCarry | null, _options: CarryWriteOptions) {
    return this.#gate("recordCarry", () => this.inner.recordCarry(link, endSlot, carry));
  }
  loadAll(): Promise<readonly StoredCarry[]> {
    return this.#gate("loadAll", () => this.inner.loadAll());
  }
  ready() {
    return this.#gate("ready", async () => this.ready_);
  }
}

function hooks(): CarryStoreHooks & { readonly fired: Alert[]; readonly cleared: string[]; readonly warned: string[] } {
  const fired: Alert[] = [];
  const cleared: string[] = [];
  const warned: string[] = [];
  return { fired, cleared, warned, fire: (alert) => fired.push(alert), clear: (key) => cleared.push(key), warn: (message) => warned.push(message) };
}

const linkAt = (settlementNonce: bigint, frontierSlot: bigint): CarryLink => ({
  linkAddress: new PublicKey(Buffer.alloc(32, 3)),
  epoch: BigInt(EPOCH),
  settlementNonce,
  frontierSlot,
});
const LOSS: LossCarry = { lossLamports: 500_000_000n, walletSignedTxCount: 1 };
const turnWrite = { currentSlot: 1_000n, validUntilSlot: 1_150n, nonceNow: async () => 4n };

describe("DurableCarries: what each phase decides from, and what it does when Postgres fails", () => {
  it("dual decides from memory, writes Postgres after it, and counts a carry seen in both", async () => {
    const store = new FaultyStore();
    const h = hooks();
    const carries = new DurableCarries("dual", store, h);
    const book: CarryBook = new Map();
    expect(await carries.recordCarry(book, linkAt(4n, 0n), 900n, LOSS, MODE_PROFIT, turnWrite)).toEqual({ kind: "written" });
    expect(await carries.carryFor(book, linkAt(5n, 900n), MODE_PROFIT)).toEqual({ carry: LOSS });
    expect(await store.inner.carryFor(linkAt(5n, 900n))).toEqual(LOSS);
    expect(carries.status()).toMatchObject({ mode: "dual", written: 1, compared: 1, seenInBoth: 1, mismatches: 0 });
  });

  it("dual goes on from memory when Postgres fails or hangs, and warns once per failure; the next success clears it", async () => {
    for (const fault of ["fail", "hang"] as const) {
      const store = new FaultyStore();
      store[fault].add("recordCarry");
      store[fault].add("carryFor");
      const h = hooks();
      const carries = new DurableCarries("dual", store, h, 30);
      const book: CarryBook = new Map();
      expect(await carries.recordCarry(book, linkAt(4n, 0n), 900n, LOSS, MODE_PROFIT, turnWrite), fault).toEqual({ kind: "written" });
      expect(await carries.carryFor(book, linkAt(5n, 900n), MODE_PROFIT), fault).toEqual({ carry: LOSS });
      expect(carries.status(), fault).toMatchObject({ written: 0, writeFailures: 1, readFailures: 1, compared: 0, lastProblem: { what: "read" } });
      expect(h.fired.map((alert) => [alert.key, alert.severity]), fault).toEqual([
        [CARRY_STORE_ALERT_KEY, "warn"],
        [CARRY_STORE_ALERT_KEY, "warn"],
      ]);
      expect(h.fired[0]!.detail).toContain("settles go on from memory");
      store[fault].clear();
      await carries.carryFor(book, linkAt(5n, 900n), MODE_PROFIT);
      expect(h.cleared, fault).toContain(CARRY_STORE_ALERT_KEY);
    }
  });

  it("dual counts a disagreement as a mismatch and raises it once, still deciding from memory", async () => {
    const store = new FaultyStore();
    const h = hooks();
    const carries = new DurableCarries("dual", store, h);
    const book: CarryBook = new Map();
    // POSTGRES HOLDS A CARRY MEMORY NEVER SAW: written by another process after this one booted.
    await store.inner.recordCarry(linkAt(4n, 0n), 900n, LOSS);
    expect(await carries.carryFor(book, linkAt(5n, 900n), MODE_PROFIT)).toEqual({ carry: null });
    expect(carries.status()).toMatchObject({ mismatches: 1, seenInBoth: 0, lastMismatch: { memory: null, db: LOSS, state: `${EPOCH}:5:900` } });
    expect(h.fired).toHaveLength(1);
    expect(h.fired[0]).toMatchObject({ key: CARRY_MISMATCH_ALERT_KEY, severity: "warn", once: true });
  });

  it("on decides from Postgres, mirrors it into memory for /status, and refuses a turn it cannot read or write", async () => {
    const store = new FaultyStore();
    const h = hooks();
    const carries = new DurableCarries("on", store, h, 30);
    const book: CarryBook = new Map();
    await store.inner.recordCarry(linkAt(4n, 0n), 900n, LOSS);
    expect(await carries.carryFor(book, linkAt(5n, 900n), MODE_PROFIT)).toEqual({ carry: LOSS });
    expect(book.get(linkAt(5n, 900n).linkAddress.toBase58())?.get(`${EPOCH}:5:900`), "the mirror").toEqual(LOSS);

    for (const fault of ["fail", "hang"] as const) {
      store[fault].add("carryFor");
      store[fault].add("recordCarry");
      const read = await carries.carryFor(book, linkAt(5n, 900n), MODE_PROFIT);
      expect("unavailable" in read && read.unavailable, fault).toMatch(/^the loss-carry store could not be read \(/);
      const before = JSON.stringify([...book].map(([k, v]) => [k, [...v.keys()]]));
      const write = await carries.recordCarry(book, linkAt(5n, 900n), 990n, null, MODE_PROFIT, turnWrite);
      // UNAVAILABLE, NOT REFUSED: the store said nothing about this link.
      expect(write.kind === "unavailable" && write.detail, fault).toMatch(/could not be written .*; nothing was sent/);
      expect(JSON.stringify([...book].map(([k, v]) => [k, [...v.keys()]])), "memory moves only after Postgres did").toBe(before);
      store[fault].clear();
    }
    expect(h.fired.every((alert) => alert.key === CARRY_STORE_ALERT_KEY && alert.detail.includes("PROFIT settles wait"))).toBe(true);
    expect(carries.status()).toMatchObject({ readFailures: 2, writeFailures: 2 });
  });

  it("never touches the store for a mode that carries no loss, in either phase", async () => {
    for (const mode of ["dual", "on"] as const) {
      const store = new FaultyStore();
      for (const name of ["carryFor", "recordCarry", "loadAll", "ready"]) store.fail.add(name);
      const carries = new DurableCarries(mode, store, hooks());
      const book: CarryBook = new Map();
      expect(await carries.recordCarry(book, linkAt(4n, 0n), 900n, null, MODE_VOLUME, turnWrite)).toEqual({ kind: "written" });
      expect(await carries.carryFor(book, linkAt(5n, 900n), MODE_VOLUME)).toEqual({ carry: null });
      expect(store.calls, mode).toEqual([]);
    }
  });

  it("seeds memory from every row at boot, and counts each seeded row once when a decision uses it", async () => {
    const store = new FaultyStore();
    await store.inner.recordCarry(linkAt(4n, 0n), 900n, LOSS);
    const other: CarryLink = { ...linkAt(7n, 50n), linkAddress: new PublicKey(Buffer.alloc(32, 4)) };
    await store.inner.recordCarry(other, 800n, { lossLamports: 9n, walletSignedTxCount: 3 });
    const carries = new DurableCarries("dual", store, hooks());
    const book: CarryBook = new Map();
    await carries.prepare(book);
    expect(carries.status()).toMatchObject({ notReady: null, dbOnlyAtBoot: 2, decidedWithDbRow: 0 });
    expect(await carries.carryFor(book, linkAt(5n, 900n), MODE_PROFIT)).toEqual({ carry: LOSS });
    expect(await carries.carryFor(book, linkAt(5n, 900n), MODE_PROFIT)).toEqual({ carry: LOSS });
    expect(carries.status()).toMatchObject({ decidedWithDbRow: 1, seenInBoth: 2, mismatches: 0 });
    // PREPARED ONCE, IT ASKS NOTHING MORE.
    const asked = store.calls.length;
    await carries.prepare(book);
    expect(store.calls.length).toBe(asked);
  });

  it("keeps on from acting while its table is not there, asks again before every sweep, and seeds once it is", async () => {
    const store = new FaultyStore();
    store.ready_ = { ok: false, detail: "sip_solana.loss_carry does not exist" };
    const on = new DurableCarries("on", store, hooks());
    const dual = new DurableCarries("dual", store, hooks());
    const book: CarryBook = new Map();
    await on.prepare(book);
    await dual.prepare(book);
    expect(on.liveBlocker()).toBe("SIP_SOLANA_CARRY_STORE is on and the loss-carry store is not ready: sip_solana.loss_carry does not exist");
    expect(dual.liveBlocker(), "dual decides from memory and acts as off would").toBeNull();
    expect(on.status().dbOnlyAtBoot).toBeNull();
    store.ready_ = { ok: true, detail: "test store" };
    await on.prepare(book);
    expect(on.liveBlocker()).toBeNull();
    expect(on.status()).toMatchObject({ notReady: null, dbOnlyAtBoot: 0 });
  });
});

describe("on's gate: a row for the state this settle leaves that it would not have written", () => {
  const link = linkAt(4n, 700n);
  const row = (over: Partial<Parameters<typeof gateRefusal>[0][number]> = {}) => ({
    epoch: BigInt(EPOCH),
    settlementNonce: 5n,
    frontierSlot: 900n,
    lossLamports: LOSS.lossLamports,
    walletSignedTxCount: LOSS.walletSignedTxCount,
    validUntilSlot: 1_150n,
    writtenBy: "me",
    ...over,
  });
  const gate = (nonce: bigint | null, currentSlot = 1_000n): CarryGate & { asked: number } => {
    const g = {
      asked: 0,
      currentSlot,
      nonceNow: async () => {
        g.asked += 1;
        return nonce;
      },
    };
    return g;
  };
  const write = (g: CarryGate, carry: LossCarry | null = LOSS, endSlot = 900n) => ({ link, endSlot, carry, gate: g, writer: "me" });

  it("goes ahead, asking nothing, over no row, the current state's row, or its own identical attempt", async () => {
    const g = gate(4n);
    expect(await gateRefusal([], write(g))).toBeNull();
    expect(await gateRefusal([row({ settlementNonce: 4n, frontierSlot: 700n })], write(g))).toBeNull();
    expect(await gateRefusal([row()], write(g))).toBeNull();
    // Older states are garbage the delete removes: no question either.
    expect(await gateRefusal([row({ settlementNonce: 2n }), row({ epoch: BigInt(EPOCH) - 1n, settlementNonce: 9n })], write(g))).toBeNull();
    expect(g.asked).toBe(0);
  });

  it("refuses, asking nothing, when the store holds a later state or a later epoch of the link", async () => {
    const g = gate(4n);
    expect(await gateRefusal([row({ settlementNonce: 6n })], write(g))).toMatch(/past the state this sweep read .*: the link has moved since, so nothing was sent/);
    expect(await gateRefusal([row({ epoch: BigInt(EPOCH) + 1n, settlementNonce: 0n })], write(g))).toMatch(/the link has moved since/);
    expect(g.asked).toBe(0);
  });

  it("asks the chain about another keeper's row, or another window's: moved is stale, unreadable waits, unmoved and live waits", async () => {
    for (const inTheWay of [row({ writtenBy: "the old container" }), row({ frontierSlot: 950n }), row({ lossLamports: 7n })]) {
      expect(await gateRefusal([inTheWay], write(gate(5n)))).toMatch(/the link's nonce is 5 on chain, past the 4 this sweep read: another settle landed first/);
      expect(await gateRefusal([inTheWay], write(gate(null)))).toMatch(/could not be read to tell whether it landed or may still land; nothing was sent/);
      expect(await gateRefusal([inTheWay], write(gate(4n, 1_150n)))).toMatch(/may still land until slot 1150 \(the chain is at 1150\).*this turn waits for it, and nothing was sent/);
      // UNMOVED AND PAST ITS DEADLINE: that settle can never land, and its row goes as memory's would.
      expect(await gateRefusal([inTheWay], write(gate(4n, 1_151n)))).toBeNull();
    }
    // A NULL CARRY IS NEVER "IDENTICAL" TO A ROW: writing it would delete one.
    expect(await gateRefusal([row()], write(gate(4n, 1_000n), null))).toMatch(/may still land/);
  });
});

describe("the settle turn with each phase's store in it (test/settle-world.ts)", () => {
  /** A link at nonce 4 with a losing backlog whose prefix carries 0.5 SOL: its live settle records the carry, then sends. */
  function losingLink() {
    const world = new SettleWorld({ settlementNonce: 4n });
    const prefixEnd = world.losingBacklog();
    return { world, prefixEnd, keeper: new WorldKeeper(world) };
  }

  it("on: a carry write that fails ends the turn RETRY with nothing sent, and memory untouched", async () => {
    const { world, keeper } = losingLink();
    const store = new FaultyStore();
    store.fail.add("recordCarry");
    const turn = await keeper.turn({ live: true, carryStore: new DurableCarries("on", store, hooks()) });
    expect(turn.result.outcome).toBe("RETRY");
    expect(turn.result.detail).toMatch(/^the loss-carry store could not be written \(.*\); nothing was sent, and the next sweep tries again$/);
    expect(turn.result.waitingOn, "the store's, not the wallet's").toBe("carry-store");
    expect(turn.result.carry, "it says what it would have carried").toEqual(LOSS);
    expect(world.sent).toHaveLength(0);
    expect(turn.calls).not.toContain("sendRawTransaction");
    expect(keeper.carries.size).toBe(0);
  });

  it("on: a carry read that fails ends the turn RETRY before anything is priced, attested or sent", async () => {
    const { world, keeper } = losingLink();
    const store = new FaultyStore();
    store.fail.add("carryFor");
    for (const live of [false, true]) {
      const turn = await keeper.turn({ live, carryStore: new DurableCarries("on", store, hooks()) });
      expect(turn.result).toEqual({
        outcome: "RETRY",
        detail:
          "the loss-carry store could not be read (Error: carryFor refused: connection terminated): the loss this span may owe is unknown, " +
          "so nothing was attested or sent; the next sweep reads it again",
        waitingOn: "carry-store",
      });
      for (const method of ["getLatestBlockhash", "getFeeForMessage", "getBalance", "sendRawTransaction"]) expect(turn.calls).not.toContain(method);
    }
    expect(world.sent).toHaveLength(0);
  });

  it("on: the carry is in Postgres before the settle leaves, and memory mirrors it after", async () => {
    const { world, prefixEnd, keeper } = losingLink();
    const store = new FaultyStore();
    let atSend: LossCarry | null | undefined;
    const carries = new DurableCarries("on", store, hooks());
    const turn = await keeper.turn({
      live: true,
      carryStore: {
        carryFor: (book, link, mode) => carries.carryFor(book, link, mode),
        recordCarry: async (...args) => {
          const written = await carries.recordCarry(...args);
          atSend = await store.inner.carryFor({ ...world.link, settlementNonce: 5n, frontierSlot: prefixEnd });
          return written;
        },
      },
    });
    expect(turn.result, turn.result.detail).toMatchObject({ outcome: "SETTLED", baseLamports: 0n, carry: LOSS, nonce: 4n, endSlot: prefixEnd });
    expect(atSend, "Postgres held it when the send was made").toEqual(LOSS);
    expect(world.sent).toHaveLength(1);
    expect(keeper.carries.get(world.link.linkAddress.toBase58())?.get(`${EPOCH}:5:${prefixEnd}`)).toEqual(LOSS);
    expect(carries.status()).toMatchObject({ written: 1, writeFailures: 0 });
  });

  it("dual: a write Postgres refuses still sends, as off does, and the carry is in memory", async () => {
    const { world, prefixEnd, keeper } = losingLink();
    const store = new FaultyStore();
    store.fail.add("recordCarry");
    const h = hooks();
    const turn = await keeper.turn({ live: true, carryStore: new DurableCarries("dual", store, h) });
    expect(turn.result, turn.result.detail).toMatchObject({ outcome: "SETTLED", carry: LOSS });
    expect(world.sent).toHaveLength(1);
    expect(keeper.carries.get(world.link.linkAddress.toBase58())?.get(`${EPOCH}:5:${prefixEnd}`)).toEqual(LOSS);
    expect(h.fired.map((alert) => alert.key)).toEqual([CARRY_STORE_ALERT_KEY]);
  });

  it("a dry run reads the store and writes nothing to it, in either phase", async () => {
    for (const mode of ["dual", "on"] as const) {
      const { keeper } = losingLink();
      const store = new FaultyStore();
      const turn = await keeper.turn({ live: false, carryStore: new DurableCarries(mode, store, hooks()) });
      expect(turn.result.detail, mode).toMatch(/^DRY RUN — would settle 0 lamports/);
      expect(store.calls, mode).toEqual(["carryFor"]);
    }
  });

  it("two measurements of one window from one state give the same carry, more activity above it or not: what ON CONFLICT DO UPDATE relies on", async () => {
    const { world, prefixEnd } = losingLink();
    const first = await new WorldKeeper(world).turn();
    // MORE OF THE STRANGER'S TRANSFERS AND A TRADE ARRIVE ABOVE THE PREFIX; another
    // process, with its own cold walk cache, measures from the same state.
    world.transfer();
    world.trade(42_000_000);
    world.finalizeTo(world.tip);
    const second = await new WorldKeeper(world).turn();
    for (const turn of [first, second]) {
      expect(turn.result, turn.result.detail).toMatchObject({ outcome: "SETTLED", baseLamports: 0n, carry: LOSS });
      expect(turn.result.detail).toContain(`up to slot ${prefixEnd}; the rest continues next sweep`);
    }
    expect(second.result.carry).toEqual(first.result.carry);
  });

  it("refuses a non-positive loss in code before Postgres is asked, as memory's book does", async () => {
    const store = new FaultyStore();
    const carries = new DurableCarries("on", store, hooks());
    await expect(carries.recordCarry(new Map(), linkAt(4n, 0n), 900n, { lossLamports: 0n, walletSignedTxCount: 1 }, MODE_PROFIT, turnWrite)).rejects.toThrow(
      /a carried loss is positive, not 0 lamports/,
    );
    expect(store.calls).toEqual([]);
  });
});

/** An error Postgres itself sent, with its SQLSTATE: what pg throws for a missing table (42P01) or a server going away (08xxx). */
function postgresError(message: string, code: string): Error {
  const error = new pg.DatabaseError(message, 0, "error");
  error.code = code;
  return error;
}

describe("the database watch: every round trip the store makes, told as answered or not (dep-down)", () => {
  it("an answer is an answer — a refused write and a table that is not there included; silence and a server in trouble are not", async () => {
    const store = new FaultyStore();
    const told: boolean[] = [];
    const carries = new DurableCarries("on", store, { ...hooks(), observe: (answered) => told.push(answered) }, 30);
    const book: CarryBook = new Map();
    await carries.carryFor(book, linkAt(5n, 900n), MODE_PROFIT);
    store.fail.add("carryFor");
    await carries.carryFor(book, linkAt(5n, 900n), MODE_PROFIT);
    store.failWith = () => postgresError('relation "sip_solana.loss_carry" does not exist', "42P01");
    await carries.carryFor(book, linkAt(5n, 900n), MODE_PROFIT);
    store.failWith = () => postgresError("terminating connection due to administrator command", "57P01");
    await carries.carryFor(book, linkAt(5n, 900n), MODE_PROFIT);
    store.fail.clear();
    store.hang.add("carryFor");
    await carries.carryFor(book, linkAt(5n, 900n), MODE_PROFIT);
    store.hang.clear();
    store.ready_ = { ok: false, detail: "sip_solana.loss_carry does not exist" };
    await carries.checkReady();
    expect(told).toEqual([true, false, true, false, false, true]);
  });

  it("is not asked at all without an observer, and a throwing one changes nothing", async () => {
    const store = new FaultyStore();
    store.fail.add("carryFor");
    const quiet = new DurableCarries("on", store, hooks(), 30);
    expect("unavailable" in (await quiet.carryFor(new Map(), linkAt(5n, 900n), MODE_PROFIT))).toBe(true);
    const throwing = new DurableCarries("on", store, { ...hooks(), observe: () => { throw new Error("observer broke"); } }, 30);
    expect("unavailable" in (await throwing.carryFor(new Map(), linkAt(5n, 900n), MODE_PROFIT))).toBe(true);
  });
});

describe("carry-store: the store's one page", () => {
  const T0 = 1_700_000_000_000;

  it(`warns, and in on pages critical once it has gone ${CARRY_STORE_CRITICAL_AFTER_MS / 1000} s without an answer; any answer ends the run`, async () => {
    let clock = T0;
    const store = new FaultyStore();
    store.fail.add("carryFor");
    const h = hooks();
    const carries = new DurableCarries("on", store, h, 30, () => clock);
    const book: CarryBook = new Map();
    const severities = async (): Promise<string> => {
      await carries.carryFor(book, linkAt(5n, 900n), MODE_PROFIT);
      return h.fired.at(-1)!.severity;
    };
    expect(await severities()).toBe("warn");
    clock = T0 + CARRY_STORE_CRITICAL_AFTER_MS - 1;
    expect(await severities()).toBe("warn");
    clock = T0 + CARRY_STORE_CRITICAL_AFTER_MS;
    expect(await severities()).toBe("critical");
    expect(h.fired.at(-1)!.detail).toContain("It has not answered for 120 s.");
    expect(h.fired.at(-1)!.detail).toContain("no wallet is paged for it");
    // ONE ANSWER ENDS THE RUN, AND THE PAGE WITH IT; the next failure starts over at warn.
    store.fail.clear();
    await carries.carryFor(book, linkAt(5n, 900n), MODE_PROFIT);
    expect(h.cleared.at(-1)).toBe(CARRY_STORE_ALERT_KEY);
    store.fail.add("carryFor");
    clock += CARRY_STORE_CRITICAL_AFTER_MS * 10;
    expect(await severities()).toBe("warn");
  });

  it("never pages in dual, however long Postgres stays away: its settles go on from memory", async () => {
    let clock = T0;
    const store = new FaultyStore();
    store.fail.add("carryFor");
    const h = hooks();
    const carries = new DurableCarries("dual", store, h, 30, () => clock);
    for (const at of [T0, T0 + 10 * CARRY_STORE_CRITICAL_AFTER_MS]) {
      clock = at;
      await carries.carryFor(new Map(), linkAt(5n, 900n), MODE_PROFIT);
    }
    expect(h.fired.map((alert) => alert.severity)).toEqual(["warn", "warn"]);
  });

  it("pages for a store that is not ready in on — the keeper does not act at all — and says so", async () => {
    let clock = T0;
    const store = new FaultyStore();
    store.ready_ = { ok: false, detail: "sip_solana.loss_carry does not exist; run setup-read-model" };
    const h = hooks();
    const carries = new DurableCarries("on", store, h, 30, () => clock);
    await carries.prepare(new Map());
    clock = T0 + CARRY_STORE_CRITICAL_AFTER_MS;
    await carries.prepare(new Map());
    expect(h.fired.at(-1)).toMatchObject({ key: CARRY_STORE_ALERT_KEY, severity: "critical", context: { mode: "on", what: "ready" } });
    expect(h.fired.at(-1)!.detail).toContain("this keeper does not act until it is ready");
    // THE TABLE ARRIVES: ready, and the page is resolved.
    store.ready_ = { ok: true, detail: "test store" };
    await carries.prepare(new Map());
    expect(carries.liveBlocker()).toBeNull();
    expect(h.cleared).toContain(CARRY_STORE_ALERT_KEY);
  });

  it("is what a database outage explains, under dep-down", () => {
    expect(explainedBy({ key: CARRY_STORE_ALERT_KEY, severity: "critical", title: "t", detail: "d" })).toEqual(["database"]);
  });
});

describe("the settle turns a store that is down makes wait: one page, not one per wallet (ADR §4.10 amendment 1)", () => {
  const T0 = 1_700_000_000_000;
  const WALLETS = 5;
  const SWEEPS = 3;

  /** A real alerter at the production threshold, whose sends are captured as they leave. */
  function box(): { readonly alerter: Alerter; readonly sent: { readonly key: string; readonly severity: string; readonly title: string }[] } {
    const sent: { key: string; severity: string; title: string }[] = [];
    const alerter = createAlerter({
      webhookUrl: new Secret("https://hooks.example.test/carry", "SIP_SOLANA_ALERT_WEBHOOK"),
      minSeverity: "critical",
      log: () => {},
      post: async (_url, body) => {
        const parsed = JSON.parse(body) as { key: string; severity: string; title: string };
        sent.push({ key: parsed.key, severity: parsed.severity, title: parsed.title });
      },
    });
    return { alerter, sent };
  }

  /**
   * WALLETS PROFIT links, each with a losing backlog its turn walks, turned in dry
   * run (the claim went with the database) by one keeper with one store in `on`,
   * for SWEEPS sweeps a minute apart while the store fails as `breakStore` says —
   * from boot, before its first readiness check, or after it, as `atBoot` says.
   * Each turn's outcome goes through bin/keeper.mts's own ladder, in its order:
   * settleRetryStreak, then settleAlert; each sweep ends with dep-down's pages.
   */
  async function outage(options: { readonly depDown: boolean; readonly atBoot?: boolean; readonly breakStore: (store: FaultyStore) => void }) {
    let clock = T0;
    const { alerter: inner, sent } = box();
    const watch = new DependencyWatch();
    const alerter = options.depDown ? gatedAlerter(inner, watch, () => clock) : inner;
    const store = new FaultyStore();
    const carries = new DurableCarries(
      "on",
      store,
      {
        fire: (alert) => alerter.fire(alert),
        clear: (key) => alerter.clear(key),
        warn: () => undefined,
        // bin/keeper.mts's databaseObserver, on the test's clock.
        ...(options.depDown
          ? { observe: (answered: boolean) => watch.record("database", clock, answered ? { ok: true } : { ok: false, reason: "no answer from the database" }) }
          : {}),
      },
      30,
      () => clock,
    );
    const book: CarryBook = new Map();
    if (options.atBoot === true) options.breakStore(store);
    await carries.prepare(book);
    if (options.atBoot !== true) options.breakStore(store);
    const keepers = Array.from({ length: WALLETS }, () => {
      const world = new SettleWorld({ settlementNonce: 4n });
      world.losingBacklog();
      return new WorldKeeper(world, { carries: book });
    });
    const streaks = new Map<string, number>();
    const results: string[] = [];
    for (let sweep = 1; sweep <= SWEEPS; sweep += 1) {
      clock = T0 + sweep * 60_000;
      await carries.prepare(book);
      for (const keeper of keepers) {
        const { result } = await keeper.turn({ live: false, carryStore: carries });
        results.push(`${result.outcome}/${result.waitingOn ?? "-"}`);
        const wallet = keeper.world.wallet.toBase58();
        const streak = settleRetryStreak(streaks.get(wallet) ?? 0, result.outcome, result.waitingOn);
        streaks.set(wallet, streak);
        const rule = settleAlert(result.outcome, { wallet, vault: `Vault-${wallet}` }, result.detail, streak, result.waitingOn);
        for (const key of rule.clear) alerter.clear(key);
        if (rule.fire !== null) alerter.fire(rule.fire);
      }
      if (options.depDown) {
        const down = depDownAlerts(watch, clock);
        for (const key of down.clear) alerter.clear(key);
        for (const page of down.fire) alerter.fire(page);
      }
    }
    return { sent, watch, results, streaks, carries, clock };
  }

  const dropped = (store: FaultyStore): void => {
    store.fail.add("carryFor");
    store.fail.add("recordCarry");
  };

  it("Supabase down under dep-down: dep-down:database once, and nothing per wallet", async () => {
    const { sent, watch, results, streaks, clock } = await outage({ depDown: true, breakStore: dropped });
    expect(new Set(results)).toEqual(new Set(["RETRY/carry-store"]));
    expect(results).toHaveLength(WALLETS * SWEEPS);
    expect(sent).toEqual([{ key: "dep-down:database", severity: "critical", title: "The database is failing: the single-keeper claim and the history are at risk" }]);
    // THE STORE'S OWN CRITICAL WAS RAISED, AND HELD: the outage is the one page.
    expect(watch.status(clock).database.held).toBeGreaterThan(0);
    // No wallet's ladder moved: once the store answers, each starts from where it was.
    expect([...streaks.values()]).toEqual(Array(WALLETS).fill(0));
  });

  it("the store failing without dep-down: the store's own critical, once", async () => {
    const { sent } = await outage({ depDown: false, breakStore: dropped });
    expect(sent.map(({ key, severity }) => ({ key, severity }))).toEqual([{ key: CARRY_STORE_ALERT_KEY, severity: "critical" }]);
  });

  it("on set before setup-read-model: the database answers, so one carry-store critical by cause — not dep-down, not N wallets", async () => {
    const { sent, watch, results, carries, clock } = await outage({
      depDown: true,
      atBoot: true,
      breakStore: (store) => {
        store.ready_ = { ok: false, detail: "sip_solana.loss_carry does not exist; run `pnpm --dir packages/solana-keeper setup-read-model` against this database" };
        store.fail.add("carryFor");
        store.failWith = () => postgresError('relation "sip_solana.loss_carry" does not exist', "42P01");
      },
    });
    expect(carries.liveBlocker()).toMatch(/^SIP_SOLANA_CARRY_STORE is on and the loss-carry store is not ready: sip_solana\.loss_carry does not exist/);
    expect(new Set(results)).toEqual(new Set(["RETRY/carry-store"]));
    expect(sent.map(({ key, severity }) => ({ key, severity }))).toEqual([{ key: CARRY_STORE_ALERT_KEY, severity: "critical" }]);
    expect(watch.status(clock).database.down).toBe(false);
  });
});
