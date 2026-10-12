// The read model's database observer (src/read-model.ts, DatabaseObserver),
// against a FAKE pg pool: no database is reached. It feeds dep-down's Postgres
// watch and nothing else. What it pins: an answer is an answer — a missing
// column, a lock somebody else holds — and only no answer, or a SQLSTATE that
// says the server itself is in trouble, is the database down; the observer can
// never change what a method returns; and with no observer, a failure is not
// even classified.

import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  const state = {
    failConnect: false,
    failWith: null as Error | null,
    locked: true,
    /** How many times anything asked whether an error is a DatabaseError. */
    inspected: 0,
  };
  class DatabaseError extends Error {
    constructor(
      message: string,
      readonly code: string,
    ) {
      super(message);
    }
    static [Symbol.hasInstance](value: unknown): boolean {
      state.inspected += 1;
      return typeof value === "object" && value !== null && Object.prototype.isPrototypeOf.call(DatabaseError.prototype, value);
    }
  }
  const client = {
    async query(sql: string) {
      if (state.failWith !== null) throw state.failWith;
      if (sql.includes("pg_try_advisory_lock")) return { rows: [{ locked: state.locked }] };
      return { rows: [] };
    },
    release() {},
    on() {},
  };
  class Pool {
    on() {}
    async connect() {
      if (state.failConnect) throw new Error("timeout exceeded when trying to connect");
      return client;
    }
    async end() {}
  }
  return { state, Pool, DatabaseError };
});

vi.mock("pg", () => ({ default: { Pool: fake.Pool, DatabaseError: fake.DatabaseError } }));

const { Secret } = await import("@sip/solana-log");
const { SolanaReadModel, databaseAnswered } = await import("../src/read-model.js");

const URL_FOR_A_FAKE_POOL = "postgres://nobody@localhost:1/none?sslmode=disable";
const row = { vaultAddr: "V", target: "T", spentRaw: 1n, receivedRaw: 1n, txRef: "sig", height: 1n };

beforeEach(() => {
  Object.assign(fake.state, { failConnect: false, failWith: null, locked: true, inspected: 0 });
});

function observed() {
  const seen: boolean[] = [];
  const readModel = SolanaReadModel.create(new Secret(URL_FOR_A_FAKE_POOL, "DATABASE_URL"), () => {}, (answered) => void seen.push(answered));
  return { readModel, seen };
}

describe("databaseAnswered", () => {
  it("is the server replying for a SQLSTATE about the request, and no answer for one about the server", () => {
    expect(databaseAnswered(new fake.DatabaseError('column "volume_raw" does not exist', "42703"))).toBe(true);
    expect(databaseAnswered(new fake.DatabaseError("duplicate key", "23505"))).toBe(true);
    for (const code of ["08006", "53300", "57014", "57P01", "58030"]) {
      expect(databaseAnswered(new fake.DatabaseError("server trouble", code)), code).toBe(false);
    }
  });

  it("is no answer for anything that is not a DatabaseError: refused, reset, a timeout on this side", () => {
    expect(databaseAnswered(new Error("timeout exceeded when trying to connect"))).toBe(false);
    expect(databaseAnswered(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }))).toBe(false);
    expect(databaseAnswered("not even an error")).toBe(false);
  });
});

describe("the observer", () => {
  it("hears an answer from every kind of round trip, the busy lock included", async () => {
    const { readModel, seen } = observed();
    fake.state.locked = false;
    expect(await readModel.claimSingleton(1n, () => {})).toEqual({ held: false });
    expect(await readModel.recordInvestment(row)).toBe(true);
    expect(await readModel.leaderboardDays()).toEqual([]);
    expect(await readModel.globalStatsRows()).toEqual({ settlements: [], investments: [] });
    expect((await readModel.preflight()).ok).toBe(true);
    expect(seen).toEqual([true, true, true, true, true]);
  });

  it("hears no answer when the database cannot be reached — and every method returns what it always did", async () => {
    const { readModel, seen } = observed();
    fake.state.failConnect = true;
    expect(await readModel.claimSingleton(1n, () => {})).toEqual({ held: false });
    expect(await readModel.recordInvestment(row)).toBe(false);
    expect(await readModel.leaderboardDays()).toBeNull();
    expect(await readModel.globalStatsRows()).toBeNull();
    expect((await readModel.preflight()).ok).toBe(false);
    expect(seen).toEqual([false, false, false, false, false]);
  });

  it("hears an answer from a schema error, and no answer from a statement the server cancelled", async () => {
    const { readModel, seen } = observed();
    fake.state.failWith = new fake.DatabaseError('column "volume_raw" does not exist', "42703");
    expect(await readModel.recordInvestment(row)).toBe(false);
    fake.state.failWith = new fake.DatabaseError("canceling statement due to statement timeout", "57014");
    expect(await readModel.recordInvestment(row)).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  it("cannot change a result by throwing", async () => {
    const readModel = SolanaReadModel.create(new Secret(URL_FOR_A_FAKE_POOL, "DATABASE_URL"), () => {}, () => {
      throw new Error("observer broke");
    });
    expect(await readModel.recordInvestment(row)).toBe(true);
    fake.state.failConnect = true;
    expect(await readModel.recordInvestment(row)).toBe(false);
  });

  it("is never asked, and no failure is even classified, without one: the catch runs as it always ran", async () => {
    const readModel = SolanaReadModel.create(new Secret(URL_FOR_A_FAKE_POOL, "DATABASE_URL"), () => {});
    fake.state.failWith = new fake.DatabaseError("server trouble", "57014");
    expect(await readModel.recordInvestment(row)).toBe(false);
    expect(await readModel.leaderboardDays()).toBeNull();
    fake.state.failConnect = true;
    expect(await readModel.claimSingleton(1n, () => {})).toEqual({ held: false });
    expect(fake.state.inspected).toBe(0);
    // With one, the same failures are classified.
    const { readModel: watched, seen } = observed();
    expect(await watched.claimSingleton(1n, () => {})).toEqual({ held: false });
    expect(fake.state.inspected).toBeGreaterThan(0);
    expect(seen).toEqual([false]);
  });
});
