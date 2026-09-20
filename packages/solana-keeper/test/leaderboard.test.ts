// The scoring rule, pinned. This file is the argument that the board ranks USE
// rather than SIZE: the cases that matter are the ones where a large amount
// loses to a small habit, and they assert the exact totals, because "it ranks
// fairly" is not a claim a test can make and "the trader beats the whale by 49
// points" is.
//
// No database and no clock: computeLeaderboard takes the day rows and the time.

import { describe, expect, it } from "vitest";
import {
  BOARDS,
  MAX_ENTRIES,
  RULES,
  computeLeaderboard,
  dayOf,
  longestStreak,
  rankBoard,
  seasonStart,
  sizePoints,
  type DayTotals,
} from "../src/leaderboard.js";

const SOL = 1_000_000_000n;

function day(subject: string, day: string, contribution: bigint, volume = 0n, settles = 1): DayTotals {
  return { subject, day, settles, contributionRaw: contribution, volumeRaw: volume };
}

/** Five consecutive days from the 14th, one amount each. */
function run(subject: string, amount: bigint, days: number, from = 14): DayTotals[] {
  return Array.from({ length: days }, (_, index) => day(subject, `2026-09-${String(from + index).padStart(2, "0")}`, amount));
}

describe("the shape of the rule", () => {
  it("pays most of a day flat, so showing up is worth more than the amount", () => {
    // 0.001 SOL and 1 SOL on the same day: the amounts differ by 1000x…
    const small = rankBoard([day("a", "2026-09-14", SOL / 1000n)], "ahorro")[0]!;
    const large = rankBoard([day("a", "2026-09-14", SOL)], "ahorro")[0]!;
    expect(small.points).toBe(12);
    expect(large.points).toBe(25);
    // …and the scores by less than 3x, because 10 of each was just for saving.
    expect(large.points).toBeLessThan(small.points * 3);
  });

  it("caps size, so past 100 SOL in a day more money buys nothing", () => {
    const hundred = rankBoard([day("a", "2026-09-14", 100n * SOL)], "ahorro")[0]!;
    const thousand = rankBoard([day("a", "2026-09-14", 1000n * SOL)], "ahorro")[0]!;
    const million = rankBoard([day("a", "2026-09-14", 1_000_000n * SOL)], "ahorro")[0]!;
    expect(hundred.points).toBe(35);
    expect(thousand.points).toBe(35);
    expect(million.points).toBe(35);
    expect(sizePoints(1_000_000n * SOL, RULES.ahorro)).toBe(RULES.ahorro.sizeCap);
  });

  it("lets a small daily habit beat a single large day — the whole point of the board", () => {
    const trader = rankBoard(run("trader", SOL / 100n, 5), "ahorro")[0]!;
    const whale = rankBoard([day("whale", "2026-09-14", 100n * SOL)], "ahorro")[0]!;
    // 0.01 SOL five days running against 100 SOL once: 10 000x less money.
    expect(trader.points).toBe(84);
    expect(whale.points).toBe(35);
  });

  it("pays the streak only for consecutive days", () => {
    const consecutive = rankBoard(run("a", SOL / 100n, 5), "ahorro")[0]!;
    const scattered = rankBoard(
      ["2026-09-14", "2026-09-16", "2026-09-18", "2026-09-20", "2026-09-22"].map((d) => day("a", d, SOL / 100n)),
      "ahorro",
    )[0]!;
    expect(consecutive.activeDays).toBe(scattered.activeDays);
    expect(consecutive.breakdown.size).toBe(scattered.breakdown.size);
    expect(consecutive.breakdown.streak).toBe(8);
    expect(scattered.breakdown.streak).toBe(0);
    expect(consecutive.points - scattered.points).toBe(8);
  });

  it("caps the streak, so a bot running for a year does not own the board", () => {
    const eleven = rankBoard(run("a", SOL / 100n, 11, 1), "ahorro")[0]!;
    const thirty = rankBoard(run("a", SOL / 100n, 30, 1), "ahorro")[0]!;
    expect(eleven.breakdown.streak).toBe(RULES.ahorro.streakCap);
    expect(thirty.breakdown.streak).toBe(RULES.ahorro.streakCap);
    // Thirty days still beats eleven — through participation, which is use.
    expect(thirty.points).toBeGreaterThan(eleven.points);
  });

  it("scores volume more softly than saving, at the same amount", () => {
    const saved = rankBoard([day("a", "2026-09-14", 10n * SOL)], "ahorro")[0]!;
    const traded = rankBoard([day("a", "2026-09-14", 0n, 10n * SOL)], "volumen")[0]!;
    expect(traded.points).toBeLessThan(saved.points);
  });

  it("counts the longest run, not the last one", () => {
    expect(longestStreak(["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-10"])).toBe(3);
    expect(longestStreak(["2026-09-30", "2026-10-01"])).toBe(2);
    expect(longestStreak([])).toBe(0);
  });
});

describe("what does not count", () => {
  it("ignores a day that saved nothing, so being swept is not an achievement", () => {
    const rows = [day("a", "2026-09-14", 0n, 5n * SOL), day("a", "2026-09-15", SOL / 100n, 5n * SOL)];
    const ahorro = rankBoard(rows, "ahorro")[0]!;
    expect(ahorro.activeDays).toBe(1);
    // The same zero-charge day DID trade, and the volume board counts it.
    expect(rankBoard(rows, "volumen")[0]!.activeDays).toBe(2);
  });

  it("merges two rows for one day instead of paying participation twice", () => {
    const merged = rankBoard(
      [day("a", "2026-09-14", 5n * SOL, 0n, 1), day("a", "2026-09-14", 5n * SOL, 0n, 2)],
      "ahorro",
    )[0]!;
    const once = rankBoard([day("a", "2026-09-14", 10n * SOL, 0n, 3)], "ahorro")[0]!;
    expect(merged.breakdown.participation).toBe(RULES.ahorro.participation);
    expect(merged.amountRaw).toBe((10n * SOL).toString());
    expect(merged.settles).toBe(3);
    expect(merged.points).toBe(once.points);
  });

  it("orders equal competitors the same way every time", () => {
    const rows = [day("zzz", "2026-09-14", SOL), day("aaa", "2026-09-14", SOL)];
    expect(rankBoard(rows, "ahorro").map((entry) => entry.subject)).toEqual(["aaa", "zzz"]);
    expect(rankBoard([...rows].reverse(), "ahorro").map((entry) => entry.subject)).toEqual(["aaa", "zzz"]);
  });

  it("serves lamports as a string, because JSON would round them", () => {
    const huge = 12_345_678_901_234_567_890n;
    expect(rankBoard([day("a", "2026-09-14", huge)], "ahorro")[0]!.amountRaw).toBe("12345678901234567890");
  });

  it("bounds the payload at MAX_ENTRIES and still ranks from 1", () => {
    const crowd = Array.from({ length: MAX_ENTRIES + 20 }, (_, index) =>
      day(`wallet${String(index).padStart(3, "0")}`, "2026-09-14", BigInt(index + 1) * SOL),
    );
    const board = rankBoard(crowd, "ahorro");
    expect(board).toHaveLength(MAX_ENTRIES);
    expect(board[0]!.rank).toBe(1);
    expect(board[MAX_ENTRIES - 1]!.rank).toBe(MAX_ENTRIES);
  });
});

describe("the season", () => {
  it("starts on the Monday on or before the day, in UTC", () => {
    // 2026-09-20 is a Sunday: its season began six days earlier.
    expect(dayOf(seasonStart(new Date("2026-09-20T23:59:59Z")))).toBe("2026-09-14");
    expect(dayOf(seasonStart(new Date("2026-09-14T00:00:00Z")))).toBe("2026-09-14");
    expect(dayOf(seasonStart(new Date("2026-09-13T12:00:00Z")))).toBe("2026-09-07");
  });

  it("cuts the season board at that Monday and leaves the all-time board whole", () => {
    const rows = [day("old", "2026-09-10", 5n * SOL), day("now", "2026-09-15", SOL / 100n)];
    const snapshot = computeLeaderboard(rows, new Date("2026-09-20T12:00:00Z"));
    expect(snapshot.boards.ahorro.season.map((entry) => entry.subject)).toEqual(["now"]);
    expect(snapshot.boards.ahorro.all.map((entry) => entry.subject)).toEqual(["old", "now"]);
    expect(snapshot.seasonStart).toBe("2026-09-14T00:00:00.000Z");
  });
});

describe("the snapshot", () => {
  it("carries its own rules, so the page explains what the service applied", () => {
    const snapshot = computeLeaderboard([day("a", "2026-09-15", SOL)], new Date("2026-09-20T12:00:00Z"));
    expect(snapshot.rules).toEqual(RULES);
    expect(snapshot.unit).toBe("lamports");
    for (const board of BOARDS) expect(snapshot.boards[board]).toHaveProperty("season");
  });

  it("reports its coverage, so an empty board can say whether it is empty or unwritten", () => {
    const rows = [day("a", "2026-09-15", SOL, 0n, 2), day("b", "2026-09-16", SOL, 0n, 1)];
    const snapshot = computeLeaderboard(rows, new Date("2026-09-20T12:00:00Z"));
    expect(snapshot.coverage).toEqual({ subjects: 2, settlements: 3, firstDay: "2026-09-15", lastDay: "2026-09-16" });
  });

  it("survives having nothing at all", () => {
    const snapshot = computeLeaderboard([], new Date("2026-09-20T12:00:00Z"));
    expect(snapshot.coverage).toEqual({ subjects: 0, settlements: 0, firstDay: null, lastDay: null });
    expect(snapshot.boards.volumen.all).toEqual([]);
  });

  it("serializes to JSON with no bigint in it", () => {
    const snapshot = computeLeaderboard([day("a", "2026-09-15", SOL, 2n * SOL)], new Date("2026-09-20T12:00:00Z"));
    expect(() => JSON.stringify(snapshot)).not.toThrow();
  });
});
