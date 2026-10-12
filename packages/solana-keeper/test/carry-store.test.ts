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
import { Redactor } from "@sip/solana-log";
import { describe, expect, it } from "vitest";
import type { Alert } from "../src/alerts.js";
import {
  CARRY_MISMATCH_ALERT_KEY,
  CARRY_STORE_ALERT_KEY,
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
import { roleCarriesLosses } from "../src/role-registry.js";
import type { CarryBook, LossCarry } from "../src/settle-decision.js";
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

  async #gate<T>(name: string, work: () => Promise<T>): Promise<T> {
    this.calls.push(name);
    if (this.hang.has(name)) return new Promise<T>(() => undefined);
    if (this.fail.has(name)) throw new Error(`${name} refused: connection terminated`);
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
      expect(write.kind === "refused" && write.detail, fault).toMatch(/could not be written .*; nothing was sent/);
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
