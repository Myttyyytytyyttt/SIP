/**
 * THE PUBLIC DASHBOARD'S FIGURES — and nothing else. No database, no clock, no
 * network, no import: given the rows the read model's two GROUPING SETS queries
 * return (SolanaReadModel.globalStatsRows), this returns the `stats` block the
 * keeper serves beside the rankings on GET /leaderboard.
 *
 * WHY POSTGRES GROUPS AND THIS FILE ONLY ARRANGES. "How many pensions settled
 * that day" is a DISTINCT count across both modes, and a pension can settle in
 * PROFIT in the morning and in VOLUME at night. Summing the per-mode counts would
 * count it twice; only the database, which sees the vault addresses, can say the
 * cross-mode figure exactly — so every distinct count arrives already counted,
 * from its own grouping set, and this file never adds two of them together.
 *
 * EVERY AMOUNT LEAVES AS A STRING OF DIGITS, every count as a JSON integer.
 * Lamports and USDC raw units do not fit a double, and JSON has no wider number:
 * a number here would round a real balance before the page ever saw it.
 */

/** settlement_event.mode: what a settlement's base measured. The program's own numbering. */
const MODE_PROFIT = 0;
const MODE_VOLUME = 1;

/**
 * One row of the settlements query: one grouping set's group.
 *
 *   (day, mode)  noDay false, noMode false — one mode on one day
 *   (day)        noDay false, noMode true  — one day, every mode: its pensions are cross-mode
 *   (mode)       noDay true,  noMode false — one mode, all time
 *   ()           noDay true,  noMode true  — everything, all time
 *
 * The GROUPING() flags say which set a row came from, not a NULL in `day` or
 * `mode`: a NULL there is ambiguous in SQL, the flag is not. Sums and counts are
 * nullable because an empty table still yields the () row, with count 0 and NULL
 * sums; this file reads NULL as zero.
 */
export interface SettlementStatsRow {
  /** A UTC calendar day, YYYY-MM-DD; null on the sets that do not group by day. */
  readonly day: string | null;
  /** 0 PROFIT, 1 VOLUME; null on the sets that do not group by mode. */
  readonly mode: number | null;
  readonly noDay: boolean;
  readonly noMode: boolean;
  readonly settles: number | null;
  /** Settlements that put something aside (contribution_raw > 0). */
  readonly paying: number | null;
  readonly contributionRaw: bigint | null;
  readonly volumeRaw: bigint | null;
  /** count(DISTINCT vault_addr) over the group: pensions, never summed across groups. */
  readonly subjects: number | null;
}

/**
 * One row of the investments query: a (day, target) group, a (target) group
 * (noDay, with a target), or the () total (noDay, no target).
 * `target` is the bought token's MINT address; `spentRaw` is USDC raw units
 * (6 decimals) spent.
 */
export interface InvestmentStatsRow {
  readonly day: string | null;
  readonly target: string | null;
  readonly noDay: boolean;
  readonly buys: number | null;
  readonly spentRaw: bigint | null;
}

/** One mode's figures, or every mode's: what was saved, what was traded, by how many. */
export interface ModeFigures {
  /** Lamports saved, as a decimal string. */
  readonly savedRaw: string;
  /** Lamports traded (the measured notional), as a decimal string. */
  readonly tradedRaw: string;
  readonly settlements: number;
  readonly payingSettlements: number;
  /** Distinct pensions in the group. */
  readonly pensions: number;
}

export interface GlobalStatsDay {
  readonly day: string;
  /** Distinct pensions settled that day ACROSS modes: not the sum of the modes' own counts. */
  readonly pensions: number;
  /** Absent when no settlement that day was in this mode: a true zero, not an unknown. */
  readonly profit?: ModeFigures;
  readonly volume?: ModeFigures;
}

export interface InvestedDayFigures {
  readonly day: string;
  /** The bought token's mint address (investment_event.target). */
  readonly mint: string;
  /** USDC raw units spent, as a decimal string. */
  readonly spentRaw: string;
  readonly buys: number;
}

/** The wire block. Its shape is the web's parser's contract (global-stats-model.ts): change both or neither. */
export interface GlobalStats {
  readonly v: 1;
  /**
   * Always false, and said rather than implied: the queries carry no LIMIT, so
   * every figure here is whole. The web calls a total complete only when told so.
   */
  readonly truncated: false;
  readonly totals: ModeFigures;
  /** A mode with no settlement at all is ABSENT (a true zero). Always an object, even {}. */
  readonly byMode: { readonly profit?: ModeFigures; readonly volume?: ModeFigures };
  /** One row per day with any settlement, ascending by day. */
  readonly daily: readonly GlobalStatsDay[];
  readonly invested: {
    readonly spentRaw: string;
    readonly buys: number;
    /**
     * Each asset all time, largest spend first: read whole from the table, so
     * it stays exact however long the daily series grows.
     */
    readonly byAsset: readonly { readonly mint: string; readonly spentRaw: string; readonly buys: number }[];
    /** Ascending by day, then by mint. */
    readonly daily: readonly InvestedDayFigures[];
  };
}

/** What a group adds up to while rows are being read. */
interface Tally {
  saved: bigint;
  traded: bigint;
  settlements: number;
  paying: number;
  pensions: number;
}

const emptyTally = (): Tally => ({ saved: 0n, traded: 0n, settlements: 0, paying: 0, pensions: 0 });

/** One day while rows are read: the (day) set's group, and each known mode's (day, mode) group. */
interface DayCells {
  all: Tally | null;
  profit: Tally | null;
  volume: Tally | null;
}

/**
 * Adds one row into a tally. The query never yields two rows for one group, but
 * a pure function answers for every input: sums and counts ADD, while a DISTINCT
 * count takes the larger of the two — adding two distinct counts is precisely
 * the double count this file exists to avoid.
 */
function add(tally: Tally, row: SettlementStatsRow): void {
  tally.saved += row.contributionRaw ?? 0n;
  tally.traded += row.volumeRaw ?? 0n;
  tally.settlements += row.settles ?? 0;
  tally.paying += row.paying ?? 0;
  tally.pensions = Math.max(tally.pensions, row.subjects ?? 0);
}

function figures(tally: Tally): ModeFigures {
  return {
    savedRaw: tally.saved.toString(),
    tradedRaw: tally.traded.toString(),
    settlements: tally.settlements,
    payingSettlements: tally.paying,
    pensions: tally.pensions,
  };
}

/** The wire key of a mode, or null for a value the program does not define. */
function modeKey(mode: number | null): "profit" | "volume" | null {
  if (mode === MODE_PROFIT) return "profit";
  if (mode === MODE_VOLUME) return "volume";
  return null;
}

/** Plain code-unit order: YYYY-MM-DD and base58 both sort correctly by it, and it never depends on a locale. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The `stats` block, from the two queries' rows.
 *
 * A MODE THE PROGRAM DOES NOT DEFINE is counted wherever the grouping sets
 * already counted it — the all-time totals and each day's pensions — and named
 * nowhere else: there is no side of the split to put it on, and inventing one
 * would be a claim about what it measured.
 */
export function computeGlobalStats(
  settlementRows: readonly SettlementStatsRow[],
  investmentRows: readonly InvestmentStatsRow[],
): GlobalStats {
  const totals = emptyTally();
  const byMode = new Map<"profit" | "volume", Tally>();
  const days = new Map<string, DayCells>();
  const dayOf = (day: string): DayCells => {
    const seen = days.get(day);
    if (seen !== undefined) return seen;
    const fresh: DayCells = { all: null, profit: null, volume: null };
    days.set(day, fresh);
    return fresh;
  };

  for (const row of settlementRows) {
    if (row.noDay && row.noMode) {
      add(totals, row);
      continue;
    }
    if (row.noDay) {
      const key = modeKey(row.mode);
      if (key === null) continue;
      const tally = byMode.get(key) ?? emptyTally();
      add(tally, row);
      byMode.set(key, tally);
      continue;
    }
    if (row.day === null) continue;
    const day = dayOf(row.day);
    if (row.noMode) {
      day.all ??= emptyTally();
      add(day.all, row);
      continue;
    }
    const key = modeKey(row.mode);
    if (key === null) continue;
    const cell = day[key] ?? emptyTally();
    add(cell, row);
    day[key] = cell;
  }

  const daily = [...days.entries()]
    .sort(([a], [b]) => compare(a, b))
    .map(([day, cells]): GlobalStatsDay => ({
      day,
      // THE (day) SET'S DISTINCT COUNT, which is the cross-mode one. Only an
      // input the query never produces lacks it; the largest mode's count is
      // then the most that can be said without counting a pension twice.
      pensions: cells.all?.pensions ?? Math.max(cells.profit?.pensions ?? 0, cells.volume?.pensions ?? 0),
      ...(cells.profit === null ? {} : { profit: figures(cells.profit) }),
      ...(cells.volume === null ? {} : { volume: figures(cells.volume) }),
    }));

  let spent = 0n;
  let buys = 0;
  const invested = new Map<string, { day: string; mint: string; spent: bigint; buys: number }>();
  const assets = new Map<string, { spent: bigint; buys: number }>();
  for (const row of investmentRows) {
    if (row.noDay && row.target !== null) {
      const asset = assets.get(row.target) ?? { spent: 0n, buys: 0 };
      asset.spent += row.spentRaw ?? 0n;
      asset.buys += row.buys ?? 0;
      assets.set(row.target, asset);
      continue;
    }
    if (row.noDay) {
      spent += row.spentRaw ?? 0n;
      buys += row.buys ?? 0;
      continue;
    }
    if (row.day === null || row.target === null) continue;
    const key = `${row.day} ${row.target}`;
    const cell = invested.get(key) ?? { day: row.day, mint: row.target, spent: 0n, buys: 0 };
    cell.spent += row.spentRaw ?? 0n;
    cell.buys += row.buys ?? 0;
    invested.set(key, cell);
  }

  const profit = byMode.get("profit");
  const volume = byMode.get("volume");
  return {
    v: 1,
    truncated: false,
    totals: figures(totals),
    byMode: {
      ...(profit === undefined ? {} : { profit: figures(profit) }),
      ...(volume === undefined ? {} : { volume: figures(volume) }),
    },
    daily,
    invested: {
      spentRaw: spent.toString(),
      buys,
      byAsset: [...assets.entries()]
        .sort(([mintA, a], [mintB, b]) => (a.spent > b.spent ? -1 : a.spent < b.spent ? 1 : compare(mintA, mintB)))
        .map(([mint, asset]) => ({ mint, spentRaw: asset.spent.toString(), buys: asset.buys })),
      daily: [...invested.values()]
        .sort((a, b) => compare(a.day, b.day) || compare(a.mint, b.mint))
        .map((cell) => ({ day: cell.day, mint: cell.mint, spentRaw: cell.spent.toString(), buys: cell.buys })),
    },
  };
}
