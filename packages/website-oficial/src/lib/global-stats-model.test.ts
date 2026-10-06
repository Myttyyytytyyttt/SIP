// What the public dashboard is willing to claim about a total it did not
// compute. The cases that matter are the honest refusals: a count the payload
// does not carry is unknown, not 0; a board that was cut is "at least"; a
// source that failed leaves no figure standing.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  HISTORY_GROUP_LIMIT,
  buildGlobalStats,
  dollarsFor,
  historyWindowProvablyOpen,
  known,
  parseStatsBlock,
  readUtcDay,
  sumRaw,
  unavailable,
  type GlobalStatsModel,
  type Shelf,
} from "@/lib/global-stats-model";
import type { LeaderboardBodyResult, LeaderboardFailure } from "@/lib/leaderboard";

const RULES = { participation: 10, sizeFactor: 5, sizeCap: 25, sizeUnit: 1_000_000, streakPerDay: 2, streakCap: 20 };
const SHELF: Shelf = { offered: ["SPYx", "ANTHROPIC"], listed: 9, symbolOf: { mintA: "SPYx", mintB: "ANTHROPIC" } };

const row = (over: Record<string, unknown> = {}) => ({
  rank: 1,
  subject: "pension-0",
  points: 84,
  activeDays: 3,
  bestStreak: 2,
  settles: 9,
  amountRaw: "186400000",
  volumeRaw: "18975900000",
  ...over,
});

/** Today's production payload, as the keeper sends it (no `stats`). */
const body = (over: Record<string, unknown> = {}, rows: readonly unknown[] = [row()]) => ({
  computedAt: "2026-10-06T18:00:00.000Z",
  seasonStart: "2026-10-05T00:00:00.000Z",
  unit: "lamports",
  rules: { ahorro: RULES, volumen: RULES },
  coverage: { subjects: 1, settlements: 9, firstDay: "2026-09-19", lastDay: "2026-09-25" },
  boards: { total: { season: [], all: rows }, ahorro: { season: [], all: [] }, volumen: { season: [], all: [] } },
  ...over,
});

const ok = (value: unknown): LeaderboardBodyResult => ({ ok: true, body: value });
const PRICE = known("150000000");
const build = (feed: LeaderboardBodyResult, price = PRICE): GlobalStatsModel => buildGlobalStats({ source: "live", feed, price, shelf: SHELF });

describe("today's keeper, with no stats block", () => {
  const model = build(ok(body()));

  it("adds up the board and says the history behind it is complete", () => {
    expect(model.feed).toEqual({ ok: true, contract: "totals-only" });
    expect(model.saved).toEqual(known({ lamports: "186400000", bound: "complete" }));
    expect(model.traded).toEqual(known({ lamports: "18975900000", partial: false }));
    expect(model.pensions).toEqual(known({ count: 1, bound: "complete" }));
    expect(model.settlements).toEqual(known({ count: 9, bound: "complete" }));
    expect(model.firstDay).toEqual(known("2026-09-19"));
    expect(model.computedAt).toEqual(known("2026-10-06T18:00:00.000Z"));
  });

  it("calls everything only a newer keeper sends 'not published yet', never zero", () => {
    for (const figure of [model.invested, model.byMode, model.payingSettlements, model.daily, model.investedDaily]) {
      expect(figure).toEqual(unavailable("not-served-yet"));
    }
  });

  it("round-trips through JSON unchanged: it crosses to the browser as props", () => {
    expect(JSON.parse(JSON.stringify(model))).toEqual(model);
  });
});

describe("unknown is not zero", () => {
  it("a missing or mistyped pension count is unreadable, and the sum stops claiming to be whole", () => {
    for (const subjects of [undefined, "1", 1.5, -1, Number.NaN]) {
      const model = build(ok(body({ coverage: { subjects, settlements: 9, firstDay: "2026-09-19", lastDay: "2026-09-25" } })));
      expect(model.pensions).toEqual(unavailable("field-unreadable"));
      expect(model.saved.kind === "known" && model.saved.value.bound).toBe("at-least");
    }
  });

  it("an empty board is a known zero only when the count says nobody settled", () => {
    const empty = build(ok(body({ coverage: { subjects: 0, settlements: 0, firstDay: null, lastDay: null } }, [])));
    expect(empty.saved).toEqual(known({ lamports: "0", bound: "complete" }));
    expect(empty.firstDay).toEqual(known(null));
    const unread = build(ok(body({ coverage: { settlements: 0, firstDay: null, lastDay: null } }, [])));
    expect(unread.saved).toEqual(unavailable("field-unreadable"));
    // Rows that failed to parse while somebody did settle: not "0 SOL".
    const dropped = build(ok(body({}, [{ rank: 1, subject: "x" }])));
    expect(dropped.saved).toEqual(unavailable("field-unreadable"));
  });

  it("a coverage day that is not a calendar day is unreadable, JSON null is 'none yet'", () => {
    const model = build(ok(body({ coverage: { subjects: 1, settlements: 9, firstDay: "2026-02-30", lastDay: 20260925 } })));
    expect(model.firstDay).toEqual(unavailable("field-unreadable"));
    expect(model.lastDay).toEqual(unavailable("field-unreadable"));
    expect(readUtcDay("2028-02-29")).toBe("2028-02-29");
    expect(readUtcDay("2026-02-29")).toBeNull();
  });

  it("a computedAt that is not a time is unreadable", () => {
    expect(build(ok(body({ computedAt: "soon" }))).computedAt).toEqual(unavailable("field-unreadable"));
  });
});

describe("what a sum over the board may claim", () => {
  it("is 'at least' when the board holds fewer pensions than were counted", () => {
    const model = build(ok(body({ coverage: { subjects: 250, settlements: 900, firstDay: "2026-09-19", lastDay: "2026-09-25" } })));
    expect(model.saved.kind === "known" && model.saved.value.bound).toBe("at-least");
    expect(model.traded.kind === "known" && model.traded.value.partial).toBe(true);
  });

  it("is 'at least' when the keeper's bounded read could have been full", () => {
    expect(historyWindowProvablyOpen(100, "2026-01-01", "2026-01-03")).toBe(true);
    expect(historyWindowProvablyOpen(100, "2024-01-01", "2026-01-01")).toBe(false);
    expect(historyWindowProvablyOpen(null, "2026-01-01", "2026-01-03")).toBe(false);
    expect(historyWindowProvablyOpen(0, null, null)).toBe(true);
    const model = build(ok(body({ coverage: { subjects: 1, settlements: 9, firstDay: "2010-01-01", lastDay: "2026-09-25" } })));
    // One pension over sixteen years is still under the limit: provably whole.
    expect(model.saved.kind === "known" && model.saved.value.bound).toBe("complete");
  });

  it("never sums the volume board's amounts as savings", () => {
    const model = build(
      ok({
        ...body(),
        boards: {
          total: { season: [], all: [row()] },
          ahorro: { season: [], all: [] },
          volumen: { season: [], all: [row({ amountRaw: "999999999999" })] },
        },
      }),
    );
    expect(model.saved.kind === "known" && model.saved.value.lamports).toBe("186400000");
  });

  it("a row without a traded measure leaves the traded total partial; none at all leaves it unread", () => {
    const some = build(ok(body({ coverage: { subjects: 2, settlements: 9, firstDay: "2026-09-19", lastDay: "2026-09-25" } }, [row(), row({ subject: "pension-1", volumeRaw: undefined })])));
    expect(some.traded).toEqual(known({ lamports: "18975900000", partial: true }));
    const none = build(ok(body({}, [row({ volumeRaw: undefined })])));
    expect(none.traded).toEqual(unavailable("field-unreadable"));
    expect(none.saved.kind).toBe("known");
  });

  it("adds in BigInt, past a double's exact integers", () => {
    expect(sumRaw(["9007199254740993", "9007199254740993"])).toBe("18014398509481986");
  });
});

describe("a source that failed", () => {
  const failures: readonly [LeaderboardFailure, string][] = [
    ["unconfigured", "source-unconfigured"],
    ["misconfigured", "source-misconfigured"],
    ["timeout", "source-unreachable"],
    ["unreachable", "source-unreachable"],
    ["not-ready", "source-not-ready"],
    ["refused", "source-refused"],
  ];

  it.each(failures)("%s leaves no figure standing", (failure, reason) => {
    const model = build({ ok: false, failure, detail: "the keeper could not be reached" });
    expect(model.feed).toEqual({ ok: false, reason });
    for (const figure of [model.saved, model.traded, model.pensions, model.settlements, model.firstDay, model.computedAt, model.daily]) {
      expect(figure).toEqual(unavailable(reason as never));
    }
    expect(model.shelf).toEqual(SHELF);
  });

  it("an answer that is not a leaderboard is 'not understood'", () => {
    for (const value of [null, [], { service: "keeper", status: "withheld: redaction tripwire" }]) {
      expect(build(ok(value)).feed).toEqual({ ok: false, reason: "source-not-understood" });
    }
  });
});

describe("the stats block a newer keeper adds", () => {
  const stats = {
    v: 1,
    truncated: false,
    totals: { savedRaw: "300", tradedRaw: "9000", settlements: 12, payingSettlements: 10, pensions: 3 },
    byMode: { profit: { savedRaw: "200", settlements: 8, pensions: 2 }, volume: { savedRaw: "100", settlements: 4, pensions: 1 } },
    daily: [
      { day: "2026-10-02", profit: { savedRaw: "50", settlements: 2 }, pensions: 1 },
      { day: "2026-10-01", profit: { savedRaw: "150", settlements: 6 }, volume: { savedRaw: "100", settlements: 4 }, pensions: 3 },
    ],
    invested: {
      spentRaw: "4000000",
      buys: 5,
      daily: [
        { day: "2026-10-01", mint: "mintA", spentRaw: "3000000", buys: 3 },
        { day: "2026-10-01", mint: "mintB", spentRaw: "1000000", buys: 2 },
      ],
    },
  };

  it("takes its totals first, and serves the series in day order", () => {
    const model = build(ok(body({ stats })));
    expect(model.feed).toEqual({ ok: true, contract: "with-stats" });
    expect(model.saved).toEqual(known({ lamports: "300", bound: "complete" }));
    expect(model.pensions).toEqual(known({ count: 3, bound: "complete" }));
    expect(model.payingSettlements).toEqual(known({ count: 10, bound: "complete" }));
    // Both sides of the division from the same read: 300 lamports over 10.
    expect(model.average).toEqual(known({ lamports: "30", bound: "complete" }));
    expect(model.daily.kind === "known" && model.daily.value.rows.map((r) => r.day)).toEqual(["2026-10-01", "2026-10-02"]);
    expect(model.invested.kind === "known" && model.invested.value.byAsset).toEqual([
      { mint: "mintA", usdcRaw: "3000000" },
      { mint: "mintB", usdcRaw: "1000000" },
    ]);
  });

  it("a cut read makes every total 'at least' and every series partial", () => {
    const model = build(ok(body({ stats: { ...stats, truncated: true } })));
    expect(model.saved.kind === "known" && model.saved.value.bound).toBe("at-least");
    expect(model.settlements.kind === "known" && model.settlements.value.bound).toBe("at-least");
    expect(model.daily.kind === "known" && model.daily.value.partial).toBe(true);
    // A partial series cannot be split by asset fairly.
    expect(model.invested.kind === "known" && model.invested.value.byAsset).toEqual([]);
  });

  it("a malformed member is dropped alone; the rest, and the board, still stand", () => {
    expect(parseStatsBlock("x")).toBeNull();
    expect(parseStatsBlock({ ...stats, v: 2 })).toBeNull();
    const numberAmount = build(ok(body({ stats: { ...stats, totals: { ...stats.totals, savedRaw: 300 } } })));
    // A JSON number may already be rounded: it is refused, and the board's sum takes over.
    expect(numberAmount.saved).toEqual(known({ lamports: "186400000", bound: "complete" }));
    const badRow = parseStatsBlock({ ...stats, daily: [...stats.daily, { day: "2026-13-01", profit: { savedRaw: "1", settlements: 1 } }, stats.daily[0]] });
    expect(badRow?.daily?.rows).toHaveLength(2);
    expect(badRow?.daily?.dropped).toBe(2);
    const badInvested = build(ok(body({ stats: { ...stats, invested: { ...stats.invested, daily: "x" } } })));
    // Sent and unreadable is not "not published yet".
    expect(badInvested.investedDaily).toEqual(unavailable("field-unreadable"));
    expect(badInvested.invested.kind).toBe("known");
  });

  it("keeps at most 2,000 days, the newest, and says the series is partial", () => {
    const days = Array.from({ length: 2_500 }, (_, index) => ({
      day: new Date(Date.UTC(2020, 0, 1) + index * 86_400_000).toISOString().slice(0, 10),
      profit: { savedRaw: "1", settlements: 1 },
    }));
    const model = build(ok(body({ stats: { daily: days } })));
    expect(model.daily.kind === "known" && model.daily.value.rows.length).toBe(2_000);
    expect(model.daily.kind === "known" && model.daily.value.rows.at(-1)?.day).toBe(days.at(-1)?.day);
    expect(model.daily.kind === "known" && model.daily.value.partial).toBe(true);
  });
});

describe("dollars", () => {
  it("are today's price applied to the total, and unknown when either side is", () => {
    expect(dollarsFor(known({ lamports: "2000000000" }), known("150000000"))).toEqual(known("300000000"));
    expect(dollarsFor(known({ lamports: "1" }), unavailable("price-unread"))).toEqual(unavailable("price-unread"));
    expect(dollarsFor(unavailable("field-unreadable"), PRICE)).toEqual(unavailable("field-unreadable"));
  });
});

describe("the keeper's read limit", () => {
  it("is the one the keeper applies", () => {
    const source = readFileSync(new URL("../../../solana-keeper/src/read-model.ts", import.meta.url), "utf8");
    const match = /export const LEADERBOARD_DAY_LIMIT = ([\d_]+);/.exec(source);
    expect(match, "LEADERBOARD_DAY_LIMIT renamed: update HISTORY_GROUP_LIMIT's source").not.toBeNull();
    expect(Number(match![1]!.replaceAll("_", ""))).toBe(HISTORY_GROUP_LIMIT);
  });
});

/** The review of 10-06: each case is a way a figure could have claimed more than the payload proves. */
describe("only proof makes a figure whole", () => {
  const stats = (over: Record<string, unknown> = {}) => ({
    v: 1,
    totals: { savedRaw: "300", tradedRaw: "9000", settlements: 12, payingSettlements: 10, pensions: 3 },
    byMode: { profit: { savedRaw: "200", settlements: 8 }, volume: { savedRaw: "100", settlements: 4 } },
    daily: [{ day: "2026-10-01", profit: { savedRaw: "300", settlements: 12 }, pensions: 3 }],
    ...over,
  });

  it("a block that does not say its read was whole is a floor, not a total", () => {
    for (const truncated of [undefined, "false", 0, null]) {
      const model = build(ok(body({ stats: stats(truncated === undefined ? {} : { truncated }) })));
      expect(model.saved.kind === "known" && model.saved.value.bound, String(truncated)).toBe("at-least");
      expect(model.settlements.kind === "known" && model.settlements.value.bound).toBe("at-least");
      expect(model.daily.kind === "known" && model.daily.value.partial).toBe(true);
      expect(model.byMode.kind === "known" && model.byMode.value.bound).toBe("at-least");
    }
    const whole = build(ok(body({ stats: stats({ truncated: false }) })));
    expect(whole.saved.kind === "known" && whole.saved.value.bound).toBe("complete");
  });

  it("a member sent but unreadable is 'missing from the answer', not 'not published yet'", () => {
    const model = build(ok(body({ stats: stats({ truncated: false, totals: { savedRaw: "300", payingSettlements: "10" } }) })));
    expect(model.payingSettlements).toEqual(unavailable("field-unreadable"));
    expect(model.average).toEqual(unavailable("field-unreadable"));
    const absent = build(ok(body({ stats: stats({ truncated: false, totals: { savedRaw: "300" } }) })));
    expect(absent.payingSettlements).toEqual(unavailable("not-served-yet"));
  });

  it("one unreadable side sinks the split: it is never a 0 handing the other side 100 %", () => {
    const model = build(ok(body({ stats: stats({ truncated: false, byMode: { profit: { savedRaw: "200", settlements: 8 }, volume: { savedRaw: 100, settlements: 4 } } }) })));
    expect(model.byMode).toEqual(unavailable("field-unreadable"));
    // An absent side had no settlement in that mode: a true zero, and the split stands.
    const oneMode = build(ok(body({ stats: stats({ truncated: false, byMode: { profit: { savedRaw: "200", settlements: 8 } } }) })));
    expect(oneMode.byMode.kind === "known" && oneMode.byMode.value.volume).toBeNull();
  });

  it("the average needs both sides of the division from the same read", () => {
    // `stats` sends the count but not the total: the board's total is a different history.
    const model = build(ok(body({ stats: stats({ truncated: false, totals: { payingSettlements: 10 } }) })));
    expect(model.saved.kind === "known" && model.saved.value.lamports).toBe("186400000");
    expect(model.average).toEqual(unavailable("field-unreadable"));
    const none = build(ok(body({ stats: stats({ truncated: false, totals: { savedRaw: "0", payingSettlements: 0 } }) })));
    expect(none.average).toEqual(known(null));
  });

  it("a first day after the last is not a span, and proves no read was whole", () => {
    expect(historyWindowProvablyOpen(100, "2026-09-25", "2026-09-19")).toBe(false);
    const model = build(ok(body({ coverage: { subjects: 1, settlements: 9, firstDay: "2026-09-25", lastDay: "2026-09-19" } })));
    expect(model.firstDay).toEqual(unavailable("field-unreadable"));
    expect(model.lastDay).toEqual(unavailable("field-unreadable"));
    expect(model.saved.kind === "known" && model.saved.value.bound).toBe("at-least");
  });

  it("a computedAt that is not a UTC instant is unreadable; one that is comes back in one form", () => {
    for (const computedAt of ["1", "2026-10-06T23:30:00+02:00", "Oct 6 2026"]) {
      expect(build(ok(body({ computedAt }))).computedAt, computedAt).toEqual(unavailable("field-unreadable"));
    }
    expect(build(ok(body({ computedAt: "2026-10-06T18:00Z" }))).computedAt).toEqual(known("2026-10-06T18:00:00.000Z"));
  });
});
