/**
 * TEN INVENTED PENSIONS, for looking at the page rather than for reading.
 *
 * WHY IT EXISTS: with one real settlement on chain the board is one row, which
 * says nothing about whether the design works — where the eye goes, whether the
 * medals read, whether a streak flame is too loud. This fills it.
 *
 * WHY IT IS SAFE: it is reachable only at /leaderboard?demo=1, it never touches
 * the keeper's payload, and the page that renders it puts "Sample data — not
 * real pensions" on screen beside the numbers. The addresses are not real
 * pensions and are not claimed to be.
 *
 * EVERY ROW ADDS UP. participation + size + streak IS pointsExact, and points
 * is that rounded — the same invariant the real scorer holds, so the tooltip
 * tells the truth here too.
 */

import type { LeaderboardData, LeaderboardEntry } from "@/lib/leaderboard";

const SOL = 1_000_000_000;

function entry(input: {
  readonly rank: number;
  readonly subject: string;
  readonly days: number;
  readonly streak: number;
  readonly size: number;
  readonly savedSol: number;
  readonly tradedSol: number;
  readonly settles: number;
}): LeaderboardEntry {
  const participation = 10 * input.days;
  const streak = Math.min(20, 2 * Math.max(0, input.streak - 1));
  const pointsExact = Math.round((participation + input.size + streak) * 10) / 10;
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
    breakdown: { participation, size: input.size, streak },
  };
}

const ROWS: readonly LeaderboardEntry[] = [
  entry({ rank: 1, subject: "7Ldx9vQmA2kR5tYpN3wFgH8sJ4bCzE6uVnMq1XrTaPkD", days: 7, streak: 7, size: 61.4, savedSol: 2.184, tradedSol: 41.7, settles: 19 }),
  entry({ rank: 2, subject: "4bTqZs8mLpN2vXcR7hYdJ9fE3uGaK5oW6iVbQtXwMzAe", days: 6, streak: 5, size: 52.8, savedSol: 1.472, tradedSol: 33.1, settles: 14 }),
  entry({ rank: 3, subject: "9QX53J3Kbs8ogQirZq5iN11rucZAvgF4EKWw98QAkUSe", days: 6, streak: 4, size: 44.1, savedSol: 0.961, tradedSol: 18.6, settles: 12 }),
  entry({ rank: 4, subject: "BnK4rTvC8xWqZ2mLpS6hYdJ9fE3uGaN5oR7iVbQtXwMz", days: 5, streak: 3, size: 39.7, savedSol: 0.744, tradedSol: 15.2, settles: 9 }),
  entry({ rank: 5, subject: "EFXK995PV49Qz8xPSYMEUDBU5AKRR466JkgsfuGak5iU", days: 4, streak: 4, size: 33.2, savedSol: 0.508, tradedSol: 11.9, settles: 8 }),
  entry({ rank: 6, subject: "3QfWb8sKpLmNvTz5YhXcRjD2gA7eU9iFoB4tSxMwQnHy", days: 3, streak: 2, size: 36.5, savedSol: 4.310, tradedSol: 96.4, settles: 6 }),
  entry({ rank: 7, subject: "GkP2mXvR9tLqB6sN4hYcW8dF3jU7aE5oZ1iVbQtXwMzC", days: 3, streak: 3, size: 27.9, savedSol: 0.276, tradedSol: 6.8, settles: 5 }),
  entry({ rank: 8, subject: "5Y1bpPuG8hatmmUKC86WLJqbMuNfXAQUQAQMwKM3YNMe", days: 2, streak: 2, size: 31.4, savedSol: 1.905, tradedSol: 44.2, settles: 4 }),
  entry({ rank: 9, subject: "HsW7qYnL2vXcB9gKfT4mRjD6aA8eZuC3oNxS5iQbVtGp", days: 2, streak: 1, size: 24.8, savedSol: 0.383, tradedSol: 9.7, settles: 3 }),
  entry({ rank: 10, subject: "2mVtL8sQpR5nX9cB4hYdK7fE6uGaW3oZ1iJbNtXwQzMe", days: 1, streak: 1, size: 22.6, savedSol: 8.640, tradedSol: 212.5, settles: 2 }),
];

const RULES = {
  ahorro: { participation: 10, sizeFactor: 5, sizeCap: 25, sizeUnit: 1_000_000, streakPerDay: 2, streakCap: 20 },
  volumen: { participation: 10, sizeFactor: 4, sizeCap: 20, sizeUnit: 1_000_000, streakPerDay: 2, streakCap: 20 },
} as const;

/** The whole payload, in the shape the keeper serves — including a thinner season cut. */
export const SAMPLE_LEADERBOARD: LeaderboardData = {
  computedAt: "2026-09-20T21:00:00.000Z",
  seasonStart: "2026-09-14T00:00:00.000Z",
  unit: "lamports",
  rules: RULES,
  coverage: { subjects: ROWS.length, settlements: ROWS.reduce((total, row) => total + row.settles, 0), firstDay: "2026-09-08", lastDay: "2026-09-20" },
  boards: {
    // The season is the same field of competitors with a couple of the
    // all-time names missing, which is what a weekly reset actually looks like.
    total: { season: ROWS.slice(0, 8).map((row, index) => ({ ...row, rank: index + 1 })), all: ROWS },
    ahorro: { season: [], all: [] },
    volumen: { season: [], all: [] },
  },
};
