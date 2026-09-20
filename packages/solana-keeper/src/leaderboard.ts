/**
 * THE LEADERBOARD'S ARITHMETIC — and nothing else. No database, no clock, no
 * network: given one row per (vault, UTC day), this returns the ranked boards.
 * The rule that decides who is first is therefore testable without a Postgres,
 * and the page that explains the scoring is handed these very constants
 * (`RULES`, served inside the snapshot) instead of restating them in another
 * language, where they would drift the first time one of them changed.
 *
 * WHY THE SHAPE IS "USE FIRST, SIZE SECOND", which is the whole point of it:
 *
 *   - Most of a day's score is FLAT. Everyone who actually saved that day gets
 *     the same participation points, whether they saved 0.001 SOL or 50.
 *   - Size enters through a LOGARITHM WITH A CAP: 100x the amount is worth
 *     about 2x the points, and beyond roughly 100 SOL in a day it is worth
 *     nothing at all. A board ranked by amount is just a list of who arrived
 *     with the most money — unfair, and buyable in a single transaction.
 *   - COMING BACK is worth more than any one large day: consecutive days pay a
 *     streak bonus that a one-off settlement can never earn.
 *
 * A whale who settles once against a trader who settles ten days running: the
 * trader wins, deliberately, and by a margin no single day can close.
 *
 * WHAT IT CANNOT DO, said here so nobody reads more into a rank than is there:
 * one person may hold several pension keys, and each is a separate competitor.
 * Nothing in this file resists that, and no scoring rule can — resisting it
 * needs an identity, which this system deliberately never asks for.
 */

/** The two boards: what was SAVED, and what was TRADED. */
export const BOARDS = ["ahorro", "volumen"] as const;
export type Board = (typeof BOARDS)[number];

/** At most this many rows per board: a public payload with a bound on its size. */
export const MAX_ENTRIES = 100;

/**
 * One row per (vault, UTC day), already summed by the mirror. `volumeRaw` is the
 * notional that day's settled windows traded (measure-window.ts) — measured,
 * never attested — and `contributionRaw` is what those settlements actually saved.
 */
export interface DayTotals {
  readonly subject: string;
  /** A UTC calendar day, YYYY-MM-DD. Compared as a string, which in this format is date order. */
  readonly day: string;
  readonly settles: number;
  readonly contributionRaw: bigint;
  readonly volumeRaw: bigint;
}

export interface BoardRules {
  /** Points for having saved AT ALL that day — the largest single term, on purpose. */
  readonly participation: number;
  /** Multiplies log10(1 + amount / sizeUnit). */
  readonly sizeFactor: number;
  /** The most size can add in one day, however large the day was. */
  readonly sizeCap: number;
  /** One unit of the size logarithm, in lamports: 0.001 SOL. */
  readonly sizeUnit: number;
  /** Points per consecutive day after the first. */
  readonly streakPerDay: number;
  /** The most a streak can add, however long it runs. */
  readonly streakCap: number;
}

/**
 * VOLUME IS SCORED MORE SOFTLY THAN SAVING, because it is the easier of the two
 * to manufacture: a wash trade moves notional and saves nobody anything, while
 * a contribution is money that actually left the trading wallet. Same shape,
 * smaller size term, same flat participation — the ranking stays about use.
 */
export const RULES: Readonly<Record<Board, BoardRules>> = {
  ahorro: { participation: 10, sizeFactor: 5, sizeCap: 25, sizeUnit: 1_000_000, streakPerDay: 2, streakCap: 20 },
  volumen: { participation: 10, sizeFactor: 4, sizeCap: 20, sizeUnit: 1_000_000, streakPerDay: 2, streakCap: 20 },
};

export interface LeaderboardEntry {
  readonly rank: number;
  /** The vault: one competitor per pension, however many trading wallets feed it. */
  readonly subject: string;
  readonly points: number;
  readonly activeDays: number;
  readonly bestStreak: number;
  readonly settles: number;
  /**
   * Lamports, as a DECIMAL STRING. JSON has no integer this wide, and a number
   * here would round a real balance — the web formats from this string.
   */
  readonly amountRaw: string;
  /** The same total, split the way the page explains it. */
  readonly breakdown: { readonly participation: number; readonly size: number; readonly streak: number };
}

/** What a day contributes to a board: savings for `ahorro`, notional for `volumen`. */
function amountOf(row: DayTotals, board: Board): bigint {
  return board === "ahorro" ? row.contributionRaw : row.volumeRaw;
}

/**
 * The size term. Amounts are lamports and arrive as bigint; the conversion to
 * Number is safe here and nowhere near a money path — 2^53 lamports is nine
 * million SOL, and this figure is capped a hundred thousand times below that.
 */
export function sizePoints(amountRaw: bigint, rules: BoardRules): number {
  if (amountRaw <= 0n) return 0;
  return Math.min(rules.sizeCap, rules.sizeFactor * Math.log10(1 + Number(amountRaw) / rules.sizeUnit));
}

/** A UTC day string as a day number, for asking whether two days are adjacent. */
function dayNumber(day: string): number {
  const [year, month, date] = day.split("-").map((part) => Number(part));
  return Math.floor(Date.UTC(year ?? 0, (month ?? 1) - 1, date ?? 1) / 86_400_000);
}

/** The longest run of consecutive days in an ascending, de-duplicated list. */
export function longestStreak(days: readonly string[]): number {
  let best = 0;
  let run = 0;
  let previous: number | null = null;
  for (const day of days) {
    const number = dayNumber(day);
    run = previous !== null && number === previous + 1 ? run + 1 : 1;
    previous = number;
    if (run > best) best = run;
  }
  return best;
}

/** Monday 00:00 UTC, on or before `now`: where every board's season cut begins. */
export function seasonStart(now: Date): Date {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  // getUTCDay is 0 on Sunday, which is six days INTO the week that began Monday.
  const back = (start.getUTCDay() + 6) % 7;
  start.setUTCDate(start.getUTCDate() - back);
  return start;
}

/** A Date as the UTC calendar day the rows are keyed by. */
export function dayOf(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Ranks one board. A day with nothing on it does not count: a settlement that
 * charged zero earns no participation on the savings board, which is what stops
 * an idle wallet from collecting points for being swept.
 *
 * DUPLICATE (subject, day) ROWS ARE MERGED rather than trusted to be absent.
 * The query groups them today; a backfill, a second writer or a hand-run INSERT
 * need not, and two rows for one day must never pay participation twice.
 */
export function rankBoard(
  rows: readonly DayTotals[],
  board: Board,
  options: { readonly fromDay?: string } = {},
): LeaderboardEntry[] {
  const rules = RULES[board];
  const merged = new Map<string, { subject: string; day: string; settles: number; amount: bigint }>();
  for (const row of rows) {
    if (options.fromDay !== undefined && row.day < options.fromDay) continue;
    const amount = amountOf(row, board);
    if (amount <= 0n) continue;
    const key = `${row.subject}|${row.day}`;
    const seen = merged.get(key);
    if (seen === undefined) merged.set(key, { subject: row.subject, day: row.day, settles: row.settles, amount });
    else {
      seen.settles += row.settles;
      seen.amount += amount;
    }
  }

  // SORTED BEFORE SUMMING. The streak needs its days in order, and a float sum
  // whose order depended on how rows arrived would make a rank depend on the
  // query plan.
  const ordered = [...merged.values()].sort((a, b) =>
    a.day < b.day ? -1 : a.day > b.day ? 1 : a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0,
  );

  const bySubject = new Map<string, { days: string[]; settles: number; amount: bigint; size: number }>();
  for (const day of ordered) {
    const subject = bySubject.get(day.subject) ?? { days: [], settles: 0, amount: 0n, size: 0 };
    subject.days.push(day.day);
    subject.settles += day.settles;
    subject.amount += day.amount;
    subject.size += sizePoints(day.amount, rules);
    bySubject.set(day.subject, subject);
  }

  const scored = [...bySubject.entries()].map(([subject, totals]) => {
    const participation = rules.participation * totals.days.length;
    const bestStreak = longestStreak(totals.days);
    const streak = Math.min(rules.streakCap, rules.streakPerDay * Math.max(0, bestStreak - 1));
    return {
      subject,
      points: Math.round(participation + totals.size + streak),
      activeDays: totals.days.length,
      bestStreak,
      settles: totals.settles,
      amount: totals.amount,
      breakdown: { participation, size: round1(totals.size), streak },
    };
  });

  // POINTS, THEN AMOUNT, THEN ADDRESS. The last is not a tie-break anybody
  // deserves; it is there so two equal competitors are ordered the same way on
  // every refresh instead of swapping places at random.
  scored.sort(
    (a, b) =>
      b.points - a.points ||
      (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0) ||
      (a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0),
  );

  return scored.slice(0, MAX_ENTRIES).map((entry, index) => ({
    rank: index + 1,
    subject: entry.subject,
    points: entry.points,
    activeDays: entry.activeDays,
    bestStreak: entry.bestStreak,
    settles: entry.settles,
    amountRaw: entry.amount.toString(),
    breakdown: entry.breakdown,
  }));
}

export interface LeaderboardSnapshot {
  readonly computedAt: string;
  /** Monday 00:00 UTC: where the "season" cut of every board begins. */
  readonly seasonStart: string;
  /** The unit of every amount on every board, so a reader never has to guess it. */
  readonly unit: "lamports";
  readonly rules: Readonly<Record<Board, BoardRules>>;
  readonly coverage: {
    readonly subjects: number;
    readonly settlements: number;
    readonly firstDay: string | null;
    readonly lastDay: string | null;
  };
  readonly boards: Readonly<Record<Board, { readonly season: LeaderboardEntry[]; readonly all: LeaderboardEntry[] }>>;
}

/**
 * The whole payload, from the mirror's day rows. Two cuts of each board — this
 * season and all time — because a weekly reset is what gives somebody who joins
 * on a Thursday a reason to trade, and the all-time board is what makes the
 * weeks add up to something.
 */
export function computeLeaderboard(rows: readonly DayTotals[], now: Date): LeaderboardSnapshot {
  const fromDay = dayOf(seasonStart(now));
  const days = rows.map((row) => row.day).sort();
  const boards = Object.fromEntries(
    BOARDS.map((board) => [board, { season: rankBoard(rows, board, { fromDay }), all: rankBoard(rows, board) }]),
  ) as LeaderboardSnapshot["boards"];
  return {
    computedAt: now.toISOString(),
    seasonStart: seasonStart(now).toISOString(),
    unit: "lamports",
    rules: RULES,
    coverage: {
      subjects: new Set(rows.map((row) => row.subject)).size,
      settlements: rows.reduce((total, row) => total + row.settles, 0),
      firstDay: days[0] ?? null,
      lastDay: days[days.length - 1] ?? null,
    },
    boards,
  };
}
