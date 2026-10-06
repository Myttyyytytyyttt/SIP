/**
 * THE DASHBOARD'S SAMPLE: twenty-four invented pensions over sixty days, for
 * looking at the page rather than for reading it.
 *
 * WHY IT EXISTS: the real history is one pension and three active days, which
 * says nothing about whether the charts work. The sample is shown only in Mock
 * (?mode=mock), under a "Sample data" badge on the page and on every card.
 *
 * IT IS A PAYLOAD, not a model. It has the keeper's wire shape — today's
 * leaderboard fields plus the `stats` block a newer keeper adds — and the page
 * builds it with the same buildGlobalStats the live page uses. So the sample is
 * also the written contract of that block: what it sends is what the page reads.
 *
 * COMPUTED, NEVER TYPED IN. Every amount comes out of BigInt arithmetic on the
 * rows below and every total is the sum of its rows, so the page cannot show a
 * total its own bars contradict. No clock: the days end on the `now` the page
 * resolved, so the sample never ages the way a fixed date would.
 *
 * NO PENSION, WALLET OR ACCOUNT ADDRESS. The ranking boards are empty, so
 * nothing here can be attributed to a real account or linked to an explorer.
 * The only addresses are the PUBLIC TOKEN MINTS of the assets on offer, passed
 * in by the page, so the invested chart can name SPYx and ANTHROPIC.
 */

import { addDays, weekStart } from "@/lib/global-stats-series";

/** An example SOL price for the sample's dollar lines, in USDC raw per SOL. Said to be a sample on screen. */
export const SAMPLE_USDC_RAW_PER_SOL = "150000000";

const DAYS = 60;
const PENSIONS = 24;
/** The first 16 save on their profit, the other 8 on their volume. */
const PROFIT_PENSIONS = 16;

interface Cell {
  saved: bigint;
  traded: bigint;
  settlements: number;
  paying: number;
  pensions: Set<number>;
}

const emptyCell = (): Cell => ({ saved: 0n, traded: 0n, settlements: 0, paying: 0, pensions: new Set() });

/** Pension `i` settles on day `d` (0 = the first day): it has started, and two days in five it rests. */
const active = (d: number, i: number): boolean => d >= i * 2 && (d * 7 + i * 13) % 5 < 3;

/** The two rules of today's board, so parseLeaderboard accepts the payload as a keeper's. */
const RULES = {
  ahorro: { participation: 10, sizeFactor: 5, sizeCap: 25, sizeUnit: 1_000_000, streakPerDay: 2, streakCap: 20 },
  volumen: { participation: 10, sizeFactor: 4, sizeCap: 20, sizeUnit: 1_000_000, streakPerDay: 2, streakCap: 20 },
} as const;

const EMPTY_BOARD = { season: [], all: [] } as const;

/**
 * The sample, as the keeper would send it at `now`. `mints`: the assets on
 * offer, whose purchases the invested series splits 60/40 (one asset takes it
 * all; none, and nothing is invested).
 */
export function sampleGlobalStatsBody(now: string, mints: readonly string[]): unknown {
  const computedAt = new Date(Date.parse(now) - 60_000).toISOString();
  const end = computedAt.slice(0, 10);
  const first = addDays(end, -(DAYS - 1));

  const days: { profit: Cell; volume: Cell; pensions: Set<number> }[] = [];
  const everyone = new Set<number>();
  const byMode = { profit: emptyCell(), volume: emptyCell() };

  for (let d = 0; d < DAYS; d += 1) {
    const day = { profit: emptyCell(), volume: emptyCell(), pensions: new Set<number>() };
    for (let i = 0; i < PENSIONS; i += 1) {
      if (!active(d, i)) continue;
      const mode = i < PROFIT_PENSIONS ? "profit" : "volume";
      const settlements = 1 + ((d + i) % 3);
      // One settlement-day in seven puts nothing aside: a profit mode with no profit that day.
      const pays = (d + i * 3) % 7 !== 0;
      const saved = pays ? 20_000_000n + BigInt((d * 37 + i * 101) % 90) * 1_000_000n : 0n;
      // Profit mode saves a share of the gain; volume mode 1% of what was traded.
      const traded = mode === "profit" ? (saved === 0n ? 150_000_000n : saved * 6n) : saved * 100n;
      for (const cell of [day[mode], byMode[mode]]) {
        cell.saved += saved;
        cell.traded += traded;
        cell.settlements += settlements;
        cell.paying += pays ? settlements : 0;
        cell.pensions.add(i);
      }
      day.pensions.add(i);
      everyone.add(i);
    }
    days.push(day);
  }

  const cellWire = (cell: Cell) =>
    cell.settlements === 0 ? undefined : { savedRaw: cell.saved.toString(), tradedRaw: cell.traded.toString(), settlements: cell.settlements, payingSettlements: cell.paying, pensions: cell.pensions.size };

  const daily = days.flatMap((day, d) =>
    day.pensions.size === 0 ? [] : [{ day: addDays(first, d), profit: cellWire(day.profit), volume: cellWire(day.volume), pensions: day.pensions.size }],
  );

  // What the pensions bought: 90 % of each day's savings, converted at the
  // sample price, split across the assets on offer.
  const investedDaily = days.flatMap((day, d) => {
    const saved = day.profit.saved + day.volume.saved;
    if (saved === 0n || mints.length === 0) return [];
    const usdc = (saved * BigInt(SAMPLE_USDC_RAW_PER_SOL) * 9n) / (1_000_000_000n * 10n);
    const firstShare = mints.length === 1 ? usdc : (usdc * 6n) / 10n;
    const shares = mints.length === 1 ? [firstShare] : [firstShare, usdc - firstShare];
    return shares.map((spent, index) => ({ day: addDays(first, d), mint: mints[index]!, spentRaw: spent.toString(), buys: day.pensions.size }));
  });

  const total = (pick: (cell: Cell) => bigint): string => (pick(byMode.profit) + pick(byMode.volume)).toString();
  const settlements = byMode.profit.settlements + byMode.volume.settlements;
  const firstActive = daily[0]?.day ?? null;
  const lastActive = daily.at(-1)?.day ?? null;

  return {
    computedAt,
    seasonStart: `${weekStart(end)}T00:00:00.000Z`,
    unit: "lamports",
    rules: RULES,
    coverage: { subjects: everyone.size, settlements, firstDay: firstActive, lastDay: lastActive },
    boards: { total: EMPTY_BOARD, ahorro: EMPTY_BOARD, volumen: EMPTY_BOARD },
    stats: {
      v: 1,
      truncated: false,
      totals: {
        savedRaw: total((cell) => cell.saved),
        tradedRaw: total((cell) => cell.traded),
        settlements,
        payingSettlements: byMode.profit.paying + byMode.volume.paying,
        pensions: everyone.size,
      },
      byMode: {
        profit: { savedRaw: byMode.profit.saved.toString(), settlements: byMode.profit.settlements, pensions: byMode.profit.pensions.size },
        volume: { savedRaw: byMode.volume.saved.toString(), settlements: byMode.volume.settlements, pensions: byMode.volume.pensions.size },
      },
      daily,
      invested: {
        spentRaw: investedDaily.reduce((sum, row) => sum + BigInt(row.spentRaw), 0n).toString(),
        buys: investedDaily.reduce((sum, row) => sum + row.buys, 0),
        daily: investedDaily,
      },
    },
  };
}
