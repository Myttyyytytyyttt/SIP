/**
 * TEN INVENTED PENSIONS, for looking at the page rather than for reading.
 *
 * WHY IT EXISTS: with one real settlement on chain the board is one row, which
 * says nothing about whether the design works — where the eye goes, whether the
 * medals read, whether a streak flame is too loud. This fills it.
 *
 * THE ADDRESSES ARE NOT ADDRESSES. An earlier version of this file borrowed
 * base58 strings from test fixtures; two of them turned out to be real mainnet
 * accounts, one of them THIS PROJECT'S OWN VAULT — so a page reachable by
 * anyone attributed invented savings, an invented streak and an invented score
 * to a real account, with a link to Solscan under it. These are placeholders
 * that say so in their own text and cannot collide with a real account: base58
 * has no "0", "O", "I" or "l", and no key derives to a pretty word. The page
 * also refuses to link a sample row to an explorer — see leaderboard-view.tsx.
 *
 * EVERY ROW ADDS UP, and its size term is what the RULES in the same payload
 * actually produce for the amounts on that row: computed here by the same
 * arithmetic the keeper uses, never typed in. A sample whose numbers the rule
 * could not have made would teach the wrong thing about the rule.
 */

import type { LeaderboardData, LeaderboardEntry } from "@/lib/leaderboard";

const SOL = 1_000_000_000;

const RULES = {
  ahorro: { participation: 10, sizeFactor: 5, sizeCap: 25, sizeUnit: 1_000_000, streakPerDay: 2, streakCap: 20 },
  volumen: { participation: 10, sizeFactor: 4, sizeCap: 20, sizeUnit: 1_000_000, streakPerDay: 2, streakCap: 20 },
} as const;

const round1 = (value: number): number => Math.round(value * 10) / 10;

/** The keeper's own size term: min(cap, factor · log10(1 + amount / unit)). */
function sizePoints(lamports: number, rules: { sizeFactor: number; sizeCap: number; sizeUnit: number }): number {
  if (lamports <= 0) return 0;
  return Math.min(rules.sizeCap, rules.sizeFactor * Math.log10(1 + lamports / rules.sizeUnit));
}

/**
 * One competitor, scored the way the keeper scores: the day's amounts are split
 * evenly across their active days, each day is scored under its own cap, and
 * the parts published are the parts summed.
 */
function entry(input: {
  readonly rank: number;
  readonly subject: string;
  readonly days: number;
  readonly streak: number;
  readonly savedSol: number;
  readonly tradedSol: number;
  readonly settles: number;
}): LeaderboardEntry {
  const perDaySaved = (input.savedSol * SOL) / input.days;
  const perDayTraded = (input.tradedSol * SOL) / input.days;
  const size = round1(input.days * (sizePoints(perDaySaved, RULES.ahorro) + sizePoints(perDayTraded, RULES.volumen)));
  const participation = RULES.ahorro.participation * input.days;
  const streak = Math.min(RULES.ahorro.streakCap, RULES.ahorro.streakPerDay * Math.max(0, input.streak - 1));
  const pointsExact = round1(participation + size + streak);
  return {
    rank: input.rank,
    subject: input.subject,
    points: Math.round(pointsExact),
    pointsExact,
    activeDays: input.days,
    bestStreak: input.streak,
    settles: input.settles,
    amountRaw: Math.round(input.savedSol * SOL).toString(),
    volumeRaw: Math.round(input.tradedSol * SOL).toString(),
    breakdown: { participation, size, streak },
  };
}

/** Placeholders, and readable as such: no key derives to a word. */
const SAMPLE = (word: string): string => `Samp1e${word}${"1".repeat(Math.max(0, 43 - 6 - word.length))}`;

const SCORED: readonly LeaderboardEntry[] = [
  entry({ rank: 0, subject: SAMPLE("Habit"), days: 7, streak: 7, savedSol: 2.184, tradedSol: 41.7, settles: 19 }),
  entry({ rank: 0, subject: SAMPLE("Daily"), days: 6, streak: 5, savedSol: 1.472, tradedSol: 33.1, settles: 14 }),
  entry({ rank: 0, subject: SAMPLE("Steady"), days: 6, streak: 4, savedSol: 0.961, tradedSol: 18.6, settles: 12 }),
  entry({ rank: 0, subject: SAMPLE("Often"), days: 5, streak: 3, savedSol: 0.744, tradedSol: 15.2, settles: 9 }),
  entry({ rank: 0, subject: SAMPLE("Patient"), days: 4, streak: 4, savedSol: 0.508, tradedSol: 11.9, settles: 8 }),
  entry({ rank: 0, subject: SAMPLE("Whale"), days: 3, streak: 2, savedSol: 4.31, tradedSol: 96.4, settles: 6 }),
  entry({ rank: 0, subject: SAMPLE("Small"), days: 3, streak: 3, savedSol: 0.276, tradedSol: 6.8, settles: 5 }),
  entry({ rank: 0, subject: SAMPLE("Brief"), days: 2, streak: 2, savedSol: 1.905, tradedSol: 44.2, settles: 4 }),
  entry({ rank: 0, subject: SAMPLE("Sparse"), days: 2, streak: 1, savedSol: 0.383, tradedSol: 9.7, settles: 3 }),
  entry({ rank: 0, subject: SAMPLE("OneDay"), days: 1, streak: 1, savedSol: 8.64, tradedSol: 212.5, settles: 2 }),
];

/** Ranked the way the keeper ranks: exact score, then days, then the streak. */
const exact = (row: LeaderboardEntry): number => row.pointsExact ?? row.points;

const ROWS: readonly LeaderboardEntry[] = [...SCORED]
  .sort((a, b) => exact(b) - exact(a) || b.activeDays - a.activeDays || b.bestStreak - a.bestStreak)
  .map((row, index) => ({ ...row, rank: index + 1 }));

/** The whole payload, in the shape the keeper serves — including a thinner season cut. */
export const SAMPLE_LEADERBOARD: LeaderboardData = {
  computedAt: "2026-09-20T21:00:00.000Z",
  seasonStart: "2026-09-14T00:00:00.000Z",
  unit: "lamports",
  rules: RULES,
  coverage: {
    subjects: ROWS.length,
    settlements: ROWS.reduce((total, row) => total + row.settles, 0),
    firstDay: "2026-09-08",
    lastDay: "2026-09-20",
  },
  boards: {
    // The season is the same field with a couple of the all-time names missing,
    // which is what a weekly reset actually looks like.
    total: { season: ROWS.slice(0, 8).map((row, index) => ({ ...row, rank: index + 1 })), all: ROWS },
    ahorro: { season: [], all: [] },
    volumen: { season: [], all: [] },
  },
};
