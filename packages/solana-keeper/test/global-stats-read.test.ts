// SolanaReadModel.globalStatsRows against a FAKE pg pool: no database is
// reached. What it pins is how the read uses the one connection an armed keeper
// leaves free — one client, the two queries one after the other, released
// whatever happens — and how the text Postgres returns becomes exact rows.

import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  const state = {
    pools: 0,
    connects: 0,
    releases: 0,
    inFlight: 0,
    maxInFlight: 0,
    queries: [] as string[],
    failConnect: false,
    failOn: null as "settlement_event" | "investment_event" | null,
    settlementRows: [] as unknown[],
    investmentRows: [] as unknown[],
  };
  const client = {
    async query(sql: string) {
      state.queries.push(sql);
      state.inFlight += 1;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      // A real round trip: yield, so a concurrent second query would overlap.
      await new Promise((resolve) => setTimeout(resolve, 5));
      state.inFlight -= 1;
      if (state.failOn !== null && sql.includes(state.failOn)) throw new Error("canceling statement due to statement timeout");
      return { rows: sql.includes("investment_event") ? state.investmentRows : state.settlementRows };
    },
    release() {
      state.releases += 1;
    },
  };
  class Pool {
    constructor() {
      state.pools += 1;
    }
    on() {}
    async connect() {
      if (state.failConnect) throw new Error("timeout exceeded when trying to connect");
      state.connects += 1;
      return client;
    }
    async end() {}
  }
  return { state, Pool };
});

vi.mock("pg", () => ({ default: { Pool: fake.Pool } }));

const { Secret } = await import("@sip/solana-log");
const { GLOBAL_INVESTMENT_STATS_SQL, GLOBAL_SETTLEMENT_STATS_SQL, SolanaReadModel } = await import("../src/read-model.js");

const URL_FOR_A_FAKE_POOL = "postgres://nobody@localhost:1/none?sslmode=disable";

beforeEach(() => {
  Object.assign(fake.state, {
    pools: 0,
    connects: 0,
    releases: 0,
    inFlight: 0,
    maxInFlight: 0,
    queries: [],
    failConnect: false,
    failOn: null,
    settlementRows: [],
    investmentRows: [],
  });
});

function model() {
  const warnings: string[] = [];
  const readModel = SolanaReadModel.create(new Secret(URL_FOR_A_FAKE_POOL, "DATABASE_URL"), (message) => warnings.push(message));
  return { readModel, warnings };
}

describe("globalStatsRows", () => {
  it("answers null, not an empty history, when there is no database", async () => {
    const readModel = SolanaReadModel.create(null, () => {});
    expect(await readModel.globalStatsRows()).toBeNull();
    expect(fake.state.pools).toBe(0);
  });

  it("runs both queries on ONE client, one after the other, and releases it once", async () => {
    const { readModel, warnings } = model();
    const rows = await readModel.globalStatsRows();
    expect(rows).toEqual({ settlements: [], investments: [] });
    expect(fake.state.connects).toBe(1);
    expect(fake.state.queries).toEqual([GLOBAL_SETTLEMENT_STATS_SQL, GLOBAL_INVESTMENT_STATS_SQL]);
    expect(fake.state.maxInFlight).toBe(1);
    expect(fake.state.releases).toBe(1);
    expect(warnings).toEqual([]);
  });

  it("parses Postgres's text exactly: counts as numbers, sums as bigint, NULL kept for the arithmetic to read", async () => {
    fake.state.settlementRows = [
      // The () row of an empty table.
      { day: null, mode: null, no_day: 1, no_mode: 1, settles: "0", paying: "0", contribution_raw: null, volume_raw: null, subjects: "0" },
      // A (day, mode) row with a sum no double can hold.
      {
        day: "2026-10-06",
        mode: 1,
        no_day: 0,
        no_mode: 0,
        settles: "3",
        paying: "2",
        contribution_raw: "123456789012345678901234567890",
        volume_raw: "18446744073709551617",
        subjects: "2",
      },
    ];
    fake.state.investmentRows = [
      { day: "2026-10-06", target: "MintZ", no_day: 0, buys: "2", spent_raw: "9007199254740993" },
      { day: null, target: null, no_day: 1, buys: "0", spent_raw: null },
    ];
    const { readModel } = model();
    expect(await readModel.globalStatsRows()).toEqual({
      settlements: [
        { day: null, mode: null, noDay: true, noMode: true, settles: 0, paying: 0, contributionRaw: null, volumeRaw: null, subjects: 0 },
        {
          day: "2026-10-06",
          mode: 1,
          noDay: false,
          noMode: false,
          settles: 3,
          paying: 2,
          contributionRaw: 123456789012345678901234567890n,
          volumeRaw: 18446744073709551617n,
          subjects: 2,
        },
      ],
      investments: [
        { day: "2026-10-06", target: "MintZ", noDay: false, buys: 2, spentRaw: 9007199254740993n },
        { day: null, target: null, noDay: true, buys: 0, spentRaw: null },
      ],
    });
  });

  it("warns and answers null when the second query fails, and still releases the client", async () => {
    fake.state.failOn = "investment_event";
    const { readModel, warnings } = model();
    expect(await readModel.globalStatsRows()).toBeNull();
    expect(warnings).toEqual(["read-model global stats read failed (settlement unaffected)"]);
    expect(fake.state.releases).toBe(1);
  });

  it("warns and answers null when no connection can be had, and never throws", async () => {
    fake.state.failConnect = true;
    const { readModel, warnings } = model();
    await expect(readModel.globalStatsRows()).resolves.toBeNull();
    expect(warnings).toEqual(["read-model global stats read failed (settlement unaffected)"]);
    expect(fake.state.releases).toBe(0);
  });
});
