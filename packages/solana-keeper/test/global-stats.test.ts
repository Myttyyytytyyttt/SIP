// The dashboard's `stats` block, from the rows the two GROUPING SETS queries
// return. No database: the rows are written here in the exact shape
// SolanaReadModel.globalStatsRows hands over, one per group of each set.

import { describe, expect, it } from "vitest";
import {
  computeGlobalStats,
  type GlobalStats,
  type InvestmentStatsRow,
  type SettlementStatsRow,
} from "../src/global-stats.js";
import { MODE_PROFIT, MODE_VOLUME } from "../src/program-scripts.js";

interface Figures {
  readonly settles?: number | null;
  readonly paying?: number | null;
  readonly saved?: bigint | null;
  readonly traded?: bigint | null;
  readonly pensions?: number | null;
}

function row(day: string | null, mode: number | null, f: Figures): SettlementStatsRow {
  return {
    day,
    mode,
    noDay: day === null,
    noMode: mode === null,
    settles: f.settles === undefined ? 0 : f.settles,
    paying: f.paying === undefined ? 0 : f.paying,
    contributionRaw: f.saved === undefined ? 0n : f.saved,
    volumeRaw: f.traded === undefined ? 0n : f.traded,
    subjects: f.pensions === undefined ? 0 : f.pensions,
  };
}

/** One mode on one day: the (day, mode) set. */
const cell = (day: string, mode: number, f: Figures) => row(day, mode, f);
/** One day, every mode: the (day) set. */
const dayRow = (day: string, f: Figures) => row(day, null, f);
/** One mode, all time: the (mode) set. */
const modeRow = (mode: number, f: Figures) => row(null, mode, f);
/** Everything: the () set. */
const total = (f: Figures) => row(null, null, f);

const bought = (day: string, mint: string, buys: number, spent: bigint | null): InvestmentStatsRow => ({
  day,
  target: mint,
  noDay: false,
  buys,
  spentRaw: spent,
});
/** One asset, all time: the (target) set — no day, a target. */
const assetBought = (mint: string, buys: number, spent: bigint | null): InvestmentStatsRow => ({
  day: null,
  target: mint,
  noDay: true,
  buys,
  spentRaw: spent,
});
const allBought = (buys: number | null, spent: bigint | null): InvestmentStatsRow => ({
  day: null,
  target: null,
  noDay: true,
  buys,
  spentRaw: spent,
});

const D1 = "2026-10-05";
const D2 = "2026-10-06";
const MINT_A = "AaaMint1111111111111111111111111111111111111";
const MINT_Z = "ZzzMint1111111111111111111111111111111111111";

/**
 * Three pensions over two days:
 *   D1  A PROFIT x2 (one paying), B VOLUME x1
 *   D2  A PROFIT x1, A VOLUME x1 (the same pension in BOTH modes), C PROFIT x1 (saved nothing)
 * Fed out of order, the way a query plan may return them.
 */
const SETTLEMENTS: readonly SettlementStatsRow[] = [
  cell(D2, MODE_VOLUME, { settles: 1, paying: 1, saved: 20n, traded: 2000n, pensions: 1 }),
  total({ settles: 6, paying: 4, saved: 200n, traded: 8300n, pensions: 3 }),
  dayRow(D2, { settles: 3, paying: 2, saved: 50n, traded: 2300n, pensions: 2 }),
  cell(D1, MODE_PROFIT, { settles: 2, paying: 1, saved: 100n, traded: 1000n, pensions: 1 }),
  modeRow(MODE_VOLUME, { settles: 2, paying: 2, saved: 70n, traded: 7000n, pensions: 2 }),
  cell(D2, MODE_PROFIT, { settles: 2, paying: 1, saved: 30n, traded: 300n, pensions: 2 }),
  dayRow(D1, { settles: 3, paying: 2, saved: 150n, traded: 6000n, pensions: 2 }),
  modeRow(MODE_PROFIT, { settles: 4, paying: 2, saved: 130n, traded: 1300n, pensions: 2 }),
  cell(D1, MODE_VOLUME, { settles: 1, paying: 1, saved: 50n, traded: 5000n, pensions: 1 }),
];

const INVESTMENTS: readonly InvestmentStatsRow[] = [
  bought(D2, MINT_Z, 1, 5_000_000n),
  allBought(4, 9_000_000n),
  assetBought(MINT_A, 2, 3_000_000n),
  bought(D2, MINT_A, 2, 3_000_000n),
  assetBought(MINT_Z, 2, 6_000_000n),
  bought(D1, MINT_Z, 1, 1_000_000n),
];

const EMPTY: GlobalStats = {
  v: 1,
  truncated: false,
  totals: { savedRaw: "0", tradedRaw: "0", settlements: 0, payingSettlements: 0, pensions: 0 },
  byMode: {},
  daily: [],
  invested: { spentRaw: "0", buys: 0, byAsset: [], daily: [] },
};

/** Every value under a key ending in "Raw" is a digit string; every count is a safe JSON integer. */
function expectWireTypes(value: unknown, path = "stats"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => expectWireTypes(item, `${path}[${index}]`));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, member] of Object.entries(value)) {
    const at = `${path}.${key}`;
    if (key.endsWith("Raw")) {
      expect(typeof member, at).toBe("string");
      expect(member, at).toMatch(/^[0-9]+$/);
    } else if (["settlements", "payingSettlements", "pensions", "buys"].includes(key)) {
      expect(Number.isSafeInteger(member) && (member as number) >= 0, at).toBe(true);
    } else {
      expectWireTypes(member, at);
    }
  }
}

describe("the stats block from a realistic history", () => {
  const stats = computeGlobalStats(SETTLEMENTS, INVESTMENTS);

  it("says what it is and that its read was whole", () => {
    expect(stats.v).toBe(1);
    expect(stats.truncated).toBe(false);
  });

  it("takes the all-time totals from the () set, distinct pensions included", () => {
    expect(stats.totals).toEqual({ savedRaw: "200", tradedRaw: "8300", settlements: 6, payingSettlements: 4, pensions: 3 });
  });

  it("splits by mode from the (mode) sets", () => {
    expect(stats.byMode).toEqual({
      profit: { savedRaw: "130", tradedRaw: "1300", settlements: 4, payingSettlements: 2, pensions: 2 },
      volume: { savedRaw: "70", tradedRaw: "7000", settlements: 2, payingSettlements: 2, pensions: 2 },
    });
  });

  it("serves one row per day, ascending, each mode's cell beside the cross-mode count", () => {
    expect(stats.daily).toEqual([
      {
        day: D1,
        pensions: 2,
        profit: { savedRaw: "100", tradedRaw: "1000", settlements: 2, payingSettlements: 1, pensions: 1 },
        volume: { savedRaw: "50", tradedRaw: "5000", settlements: 1, payingSettlements: 1, pensions: 1 },
      },
      {
        day: D2,
        pensions: 2,
        profit: { savedRaw: "30", tradedRaw: "300", settlements: 2, payingSettlements: 1, pensions: 2 },
        volume: { savedRaw: "20", tradedRaw: "2000", settlements: 1, payingSettlements: 1, pensions: 1 },
      },
    ]);
  });

  it("counts a pension that settled in both modes on one day ONCE", () => {
    // On D2, A settled in PROFIT and in VOLUME. The modes' own counts add up to
    // 3; the day had 2 pensions, and that is the figure served.
    const d2 = stats.daily.find((day) => day.day === D2);
    expect((d2?.profit?.pensions ?? 0) + (d2?.volume?.pensions ?? 0)).toBe(3);
    expect(d2?.pensions).toBe(2);
  });

  it("serves what was invested, all time and per day and asset, ascending by day then mint", () => {
    expect(stats.invested).toEqual({
      spentRaw: "9000000",
      buys: 4,
      // Largest spend first, read whole from the table rather than rebuilt from the days.
      byAsset: [
        { mint: MINT_Z, spentRaw: "6000000", buys: 2 },
        { mint: MINT_A, spentRaw: "3000000", buys: 2 },
      ],
      daily: [
        { day: D1, mint: MINT_Z, spentRaw: "1000000", buys: 1 },
        { day: D2, mint: MINT_A, spentRaw: "3000000", buys: 2 },
        { day: D2, mint: MINT_Z, spentRaw: "5000000", buys: 1 },
      ],
    });
  });

  it("does not depend on the order the rows arrive in", () => {
    expect(computeGlobalStats([...SETTLEMENTS].reverse(), [...INVESTMENTS].reverse())).toEqual(stats);
  });

  it("puts every amount on the wire as digits and every count as an integer", () => {
    expectWireTypes(stats);
    // And survives JSON whole: no bigint anywhere to make stringify throw.
    expect(JSON.parse(JSON.stringify(stats))).toEqual(stats);
  });
});

describe("a day with a single mode", () => {
  it("omits the mode it did not have, rather than serving a zero cell", () => {
    const stats = computeGlobalStats(
      [
        cell(D1, MODE_PROFIT, { settles: 1, paying: 1, saved: 5n, traded: 9n, pensions: 1 }),
        dayRow(D1, { settles: 1, paying: 1, saved: 5n, traded: 9n, pensions: 1 }),
        modeRow(MODE_PROFIT, { settles: 1, paying: 1, saved: 5n, traded: 9n, pensions: 1 }),
        total({ settles: 1, paying: 1, saved: 5n, traded: 9n, pensions: 1 }),
      ],
      [allBought(0, null)],
    );
    expect(stats.daily).toEqual([
      { day: D1, pensions: 1, profit: { savedRaw: "5", tradedRaw: "9", settlements: 1, payingSettlements: 1, pensions: 1 } },
    ]);
    expect("volume" in stats.daily[0]!).toBe(false);
    expect(stats.byMode).toEqual({ profit: { savedRaw: "5", tradedRaw: "9", settlements: 1, payingSettlements: 1, pensions: 1 } });
    expect("volume" in stats.byMode).toBe(false);
  });
});

describe("an empty history", () => {
  it("reads what Postgres returns for empty tables — the () row, count 0, NULL sums — as zeros", () => {
    const stats = computeGlobalStats(
      [total({ settles: 0, paying: 0, saved: null, traded: null, pensions: 0 })],
      [allBought(0, null)],
    );
    expect(stats).toEqual(EMPTY);
    expectWireTypes(stats);
  });

  it("gives the same zeros with no rows at all", () => {
    expect(computeGlobalStats([], [])).toEqual(EMPTY);
  });

  it("reads a NULL count as zero too", () => {
    const stats = computeGlobalStats(
      [total({ settles: null, paying: null, saved: null, traded: null, pensions: null })],
      [allBought(null, null)],
    );
    expect(stats).toEqual(EMPTY);
  });
});

describe("NULL sums inside a history", () => {
  it("treats a NULL sum as zero and keeps the group's counts", () => {
    const stats = computeGlobalStats(
      [
        cell(D1, MODE_VOLUME, { settles: 2, paying: 0, saved: null, traded: 40n, pensions: 1 }),
        dayRow(D1, { settles: 2, paying: 0, saved: null, traded: 40n, pensions: 1 }),
        modeRow(MODE_VOLUME, { settles: 2, paying: 0, saved: null, traded: null, pensions: 1 }),
        total({ settles: 2, paying: 0, saved: 0n, traded: null, pensions: 1 }),
      ],
      [bought(D1, MINT_A, 1, null), allBought(1, null)],
    );
    expect(stats.totals).toEqual({ savedRaw: "0", tradedRaw: "0", settlements: 2, payingSettlements: 0, pensions: 1 });
    expect(stats.byMode.volume).toEqual({ savedRaw: "0", tradedRaw: "0", settlements: 2, payingSettlements: 0, pensions: 1 });
    expect(stats.daily[0]?.volume).toEqual({ savedRaw: "0", tradedRaw: "40", settlements: 2, payingSettlements: 0, pensions: 1 });
    expect(stats.invested).toEqual({ spentRaw: "0", buys: 1, byAsset: [], daily: [{ day: D1, mint: MINT_A, spentRaw: "0", buys: 1 }] });
    expectWireTypes(stats);
  });
});

describe("a mode the program does not define", () => {
  // Mode 2 does not exist on chain. If a row ever says it, it must not crash
  // anything, and it must not be drawn as PROFIT or VOLUME either.
  const UNKNOWN = 2;
  const D3 = "2026-10-07";
  const stats = computeGlobalStats(
    [
      cell(D1, MODE_PROFIT, { settles: 1, paying: 1, saved: 10n, traded: 100n, pensions: 1 }),
      cell(D1, UNKNOWN, { settles: 1, paying: 1, saved: 7n, traded: 70n, pensions: 1 }),
      dayRow(D1, { settles: 2, paying: 2, saved: 17n, traded: 170n, pensions: 2 }),
      cell(D3, UNKNOWN, { settles: 1, paying: 0, saved: 0n, traded: 3n, pensions: 1 }),
      dayRow(D3, { settles: 1, paying: 0, saved: 0n, traded: 3n, pensions: 1 }),
      modeRow(MODE_PROFIT, { settles: 1, paying: 1, saved: 10n, traded: 100n, pensions: 1 }),
      modeRow(UNKNOWN, { settles: 2, paying: 1, saved: 7n, traded: 73n, pensions: 2 }),
      total({ settles: 3, paying: 2, saved: 17n, traded: 173n, pensions: 3 }),
    ],
    [],
  );

  it("counts it in the all-time totals, which come from the () set", () => {
    expect(stats.totals).toEqual({ savedRaw: "17", tradedRaw: "173", settlements: 3, payingSettlements: 2, pensions: 3 });
  });

  it("leaves it out of the split by mode", () => {
    expect(Object.keys(stats.byMode)).toEqual(["profit"]);
  });

  it("counts it in each day's pensions and names no cell for it", () => {
    expect(stats.daily).toEqual([
      { day: D1, pensions: 2, profit: { savedRaw: "10", tradedRaw: "100", settlements: 1, payingSettlements: 1, pensions: 1 } },
      { day: D3, pensions: 1 },
    ]);
  });
});

describe("amounts past 2^53", () => {
  it("keeps every digit, because a double would not", () => {
    const huge = 2n ** 64n + 1n; // 18446744073709551617: a Number would print ...552000
    const wider = 10n ** 30n + 7n;
    const stats = computeGlobalStats(
      [
        cell(D1, MODE_PROFIT, { settles: 1, paying: 1, saved: huge, traded: wider, pensions: 1 }),
        dayRow(D1, { settles: 1, paying: 1, saved: huge, traded: wider, pensions: 1 }),
        modeRow(MODE_PROFIT, { settles: 1, paying: 1, saved: huge, traded: wider, pensions: 1 }),
        total({ settles: 1, paying: 1, saved: huge, traded: wider, pensions: 1 }),
      ],
      [bought(D1, MINT_A, 1, huge), allBought(1, huge)],
    );
    expect(stats.totals.savedRaw).toBe("18446744073709551617");
    expect(stats.totals.tradedRaw).toBe("1000000000000000000000000000007");
    expect(stats.byMode.profit?.savedRaw).toBe("18446744073709551617");
    expect(stats.daily[0]?.profit?.tradedRaw).toBe("1000000000000000000000000000007");
    expect(stats.invested.spentRaw).toBe("18446744073709551617");
    expect(stats.invested.daily[0]?.spentRaw).toBe("18446744073709551617");
    expect(Number(stats.totals.savedRaw).toString()).not.toBe(stats.totals.savedRaw);
    expectWireTypes(stats);
  });
});

describe("rows the query never sends twice", () => {
  it("adds sums and counts but never adds two distinct pension counts", () => {
    // Adding two DISTINCT counts is the double count the grouping sets exist
    // to avoid; the larger of the two is the most that can be said.
    const stats = computeGlobalStats(
      [
        dayRow(D1, { settles: 1, paying: 1, saved: 1n, traded: 2n, pensions: 2 }),
        dayRow(D1, { settles: 1, paying: 0, saved: 3n, traded: 4n, pensions: 1 }),
        cell(D1, MODE_PROFIT, { settles: 1, paying: 1, saved: 1n, traded: 2n, pensions: 2 }),
        cell(D1, MODE_PROFIT, { settles: 1, paying: 0, saved: 3n, traded: 4n, pensions: 1 }),
      ],
      [bought(D1, MINT_A, 1, 5n), bought(D1, MINT_A, 2, 6n)],
    );
    expect(stats.daily).toEqual([
      { day: D1, pensions: 2, profit: { savedRaw: "4", tradedRaw: "6", settlements: 2, payingSettlements: 1, pensions: 2 } },
    ]);
    expect(stats.invested.daily).toEqual([{ day: D1, mint: MINT_A, spentRaw: "11", buys: 3 }]);
  });

  it("still serves a day whose (day) row is missing, counting its pensions without double-counting", () => {
    const stats = computeGlobalStats(
      [
        cell(D1, MODE_PROFIT, { settles: 1, paying: 1, saved: 1n, traded: 1n, pensions: 3 }),
        cell(D1, MODE_VOLUME, { settles: 1, paying: 1, saved: 1n, traded: 1n, pensions: 2 }),
      ],
      [],
    );
    expect(stats.daily.map((day) => [day.day, day.pensions])).toEqual([[D1, 3]]);
  });
});
