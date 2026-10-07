// The dashboard's sample: invented pensions, and honest about it. Every total
// it shows is the sum of its own rows, it never ages, it names no account, and
// it goes through the same builder as the live page — so it is also the
// written contract of the stats block a newer keeper sends.

import { describe, expect, it } from "vitest";

import { buildGlobalStats, known, type GlobalStatsModel } from "@/lib/global-stats-model";
import { SAMPLE_USDC_RAW_PER_SOL, sampleGlobalStatsBody } from "@/lib/global-stats-sample";
import { addDays } from "@/lib/global-stats-series";
import { parseLeaderboard } from "@/lib/leaderboard";

const NOW = "2026-10-06T18:30:00.000Z";
const MINTS = ["mintA", "mintB"] as const;
const SHELF = { offered: ["SPYx", "ANTHROPIC"], listed: 9, symbolOf: { mintA: "SPYx", mintB: "ANTHROPIC" }, assets: [] };

const sample = (now = NOW): GlobalStatsModel =>
  buildGlobalStats({ source: "sample", feed: { ok: true, body: sampleGlobalStatsBody(now, MINTS) }, price: known(SAMPLE_USDC_RAW_PER_SOL), shelf: SHELF });

describe("the sample payload", () => {
  it("is a keeper's leaderboard as far as the board parser can tell", () => {
    expect(parseLeaderboard(sampleGlobalStatsBody(NOW, MINTS))).not.toBeNull();
  });

  it("is a pure function of `now`", () => {
    expect(sampleGlobalStatsBody(NOW, MINTS)).toEqual(sampleGlobalStatsBody(NOW, MINTS));
  });

  it("ends on the day it was added up, sixty days long, so it never ages on screen", () => {
    const model = sample("2027-03-01T12:00:00.000Z");
    const rows = model.daily.kind === "known" ? model.daily.value.rows : [];
    expect(rows.at(-1)?.day).toBe("2027-03-01");
    expect(rows[0]?.day).toBe(addDays("2027-03-01", -59));
  });

  it("names no real pension: every placeholder has a 0, which no base58 address can", () => {
    const body = sampleGlobalStatsBody(NOW, MINTS) as { boards: Record<string, { season: { subject: string }[]; all: { subject: string }[] }> };
    const subjects = Object.values(body.boards).flatMap((board) => [...board.season, ...board.all]).map((row) => row.subject);
    expect(subjects.length).toBe(24);
    for (const subject of subjects) expect(subject).toMatch(/0/);
  });

  it("ranks its board consistently with its own totals", () => {
    const body = sampleGlobalStatsBody(NOW, MINTS) as { boards: { total: { all: { amountRaw: string; settles: number }[] } }; stats: { totals: { savedRaw: string; settlements: number } } };
    const rows = body.boards.total.all;
    expect(rows.reduce((sum, row) => sum + BigInt(row.amountRaw), 0n).toString()).toBe(body.stats.totals.savedRaw);
    expect(rows.reduce((sum, row) => sum + row.settles, 0)).toBe(body.stats.totals.settlements);
  });
});

describe("the model built from it", () => {
  const model = sample();

  it("has every figure — nothing in it is 'not available'", () => {
    const unavailable: string[] = [];
    for (const [name, value] of Object.entries(model)) {
      if (typeof value === "object" && value !== null && "kind" in value && value.kind === "unavailable") unavailable.push(name);
    }
    expect(unavailable).toEqual([]);
    expect(model.source).toBe("sample");
  });

  it("adds up: every total is the sum of its days, and the modes add up to the total", () => {
    const days = model.daily.kind === "known" ? model.daily.value.rows : [];
    const savedByDays = days.reduce((sum, day) => sum + BigInt(day.profit?.savedRaw ?? "0") + BigInt(day.volume?.savedRaw ?? "0"), 0n);
    expect(model.saved.kind === "known" && model.saved.value.lamports).toBe(savedByDays.toString());
    const byMode = model.byMode.kind === "known" ? model.byMode.value : null;
    expect((BigInt(byMode?.profit?.savedRaw ?? "0") + BigInt(byMode?.volume?.savedRaw ?? "0")).toString()).toBe(savedByDays.toString());
    const settlements = days.reduce((sum, day) => sum + (day.profit?.settlements ?? 0) + (day.volume?.settlements ?? 0), 0);
    expect(model.settlements.kind === "known" && model.settlements.value.count).toBe(settlements);
    const invested = model.investedDaily.kind === "known" ? model.investedDaily.value.rows.reduce((sum, row) => sum + BigInt(row.spentRaw), 0n) : -1n;
    expect(model.invested.kind === "known" && model.invested.value.usdcRaw).toBe(invested.toString());
  });

  it("has settlements that put nothing aside, so the two counts differ", () => {
    const settlements = model.settlements.kind === "known" ? model.settlements.value.count : 0;
    const paying = model.payingSettlements.kind === "known" ? model.payingSettlements.value.count : 0;
    expect(paying).toBeGreaterThan(0);
    expect(paying).toBeLessThan(settlements);
  });

  it("counts a pension once a day, and never more pensions than it invented", () => {
    const days = model.daily.kind === "known" ? model.daily.value.rows : [];
    for (const day of days) {
      expect(day.pensions).not.toBeNull();
      expect(day.pensions!).toBeLessThanOrEqual(24);
    }
    expect(model.pensions.kind === "known" && model.pensions.value.count).toBe(24);
  });

  it("buys only the assets it was given", () => {
    const mints = new Set(model.investedDaily.kind === "known" ? model.investedDaily.value.rows.map((row) => row.mint) : []);
    expect([...mints].sort()).toEqual([...MINTS]);
  });
});
