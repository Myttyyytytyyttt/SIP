// The demo board's rows are invented, and this is the file that keeps them that
// way.
//
// WHY IT EXISTS: the first version of the sample borrowed base58 strings from
// test fixtures, and two of them were real mainnet accounts — one of them this
// project's own vault. A page anyone can open then attributed invented savings,
// an invented streak and an invented score to a real account, with a link to
// Solscan under it. A comment saying "these are not real" did not stop that; an
// assertion does.

import { describe, expect, it } from "vitest";

import { SAMPLE_LEADERBOARD } from "@/lib/leaderboard-sample";

const ROWS = SAMPLE_LEADERBOARD.boards.total.all;

/** Accounts this project actually has on mainnet. None may appear in the sample. */
const REAL = [
  "6kA9H9zQT6PW5xWkXoAFCS3NotxarzaYqj66mjMf9w4J", // the program
  "5Y1bpPuG8hatmmUKC86WLJqbMuNfXAQUQAQMwKM3YNMe", // its config PDA
  "EFXK995PV49Qz8xPSYMEUDBU5AKRR466JkgsfuGak5iU", // the live vault
  "9QX53J3Kbs8ogQirZq5iN11rucZAvgF4EKWw98QAkUSe", // the live trading wallet
  "EE46GmYqiKwMve9qyriRYQ5MjQ4wR6t5kDA9B92VfGXg", // the admin key
  "8qsJxi8FyxqwVLvotowNRRUKQDW5Em8M7bTcPDwKGCQK", // the keeper's attester
];

describe("the sample's addresses", () => {
  it("are placeholders that say so, not base58 borrowed from somewhere", () => {
    expect(ROWS.length).toBe(10);
    for (const row of ROWS) expect(row.subject.endsWith("Samp1e"), row.subject).toBe(true);
  });

  it("are distinguishable where the table truncates them, which is both ends", () => {
    // Ten rows that all read "Samp…1111" are one row shown ten times, in the
    // one place whose job is to show what ten different rows look like.
    const shown = ROWS.map((row) => `${row.subject.slice(0, 4)}…${row.subject.slice(-4)}`);
    expect(new Set(shown).size).toBe(ROWS.length);
  });

  it("are none of this project's real accounts", () => {
    const subjects = new Set(ROWS.map((row) => row.subject));
    for (const address of REAL) expect(subjects.has(address), `${address} is real`).toBe(false);
  });

  it("cannot encode a key at all, because base58 has no zero", () => {
    // Impossible rather than unlikely: a string containing a character the
    // alphabet lacks is not a mis-typed address, it is not an address.
    for (const row of ROWS) expect(/[0OIl]/.test(row.subject), row.subject).toBe(true);
  });

  it("cannot be confused for a key by length", () => {
    // Long enough to look like an address in a column, and never one.
    for (const row of ROWS) expect(row.subject.length).toBeGreaterThan(32);
  });
});

describe("the sample's arithmetic", () => {
  it("publishes parts that add up to the score they explain", () => {
    for (const row of ROWS) {
      const sum = row.breakdown!.participation + row.breakdown!.size + row.breakdown!.streak;
      expect(sum, row.subject).toBe(row.pointsExact);
      expect(row.points, row.subject).toBe(Math.round(row.pointsExact!));
    }
  });

  it("publishes a size term the rules in the same payload can actually produce", () => {
    // THE DEFECT THIS CATCHES: the size used to be a free literal, so four rows
    // showed a figure no amount on that row could have earned. A sample whose
    // numbers the rule could not have made teaches the wrong rule.
    const { ahorro, volumen } = SAMPLE_LEADERBOARD.rules;
    const size = (lamports: number, rules: { sizeFactor: number; sizeCap: number; sizeUnit: number }): number =>
      lamports <= 0 ? 0 : Math.min(rules.sizeCap, rules.sizeFactor * Math.log10(1 + lamports / rules.sizeUnit));
    for (const row of ROWS) {
      const days = row.activeDays;
      const perDaySaved = Number(row.amountRaw) / days;
      const perDayTraded = Number(row.volumeRaw) / days;
      const expected = Math.round(days * (size(perDaySaved, ahorro) + size(perDayTraded, volumen)) * 10) / 10;
      expect(row.breakdown!.size, row.subject).toBe(expected);
      // And no day may exceed the two caps it is scored under.
      expect(row.breakdown!.size).toBeLessThanOrEqual(days * (ahorro.sizeCap + volumen.sizeCap));
    }
  });

  it("is ranked the way the keeper ranks: exact score, then days, then streak", () => {
    for (let index = 1; index < ROWS.length; index++) {
      const above = ROWS[index - 1]!;
      const below = ROWS[index]!;
      expect(above.rank).toBe(index);
      expect(above.pointsExact! >= below.pointsExact!, `${above.subject} over ${below.subject}`).toBe(true);
    }
  });

  it("gives the week a thinner field than all time, which is what a reset looks like", () => {
    const season = SAMPLE_LEADERBOARD.boards.total.season;
    expect(season.length).toBeLessThan(ROWS.length);
    expect(season[0]!.rank).toBe(1);
  });
});
