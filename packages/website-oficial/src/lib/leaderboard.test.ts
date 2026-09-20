// What this app is willing to believe about a leaderboard it did not compute.
//
// The cases that matter are the refusals: a keeper that answers with an error
// page, an old build whose payload is missing a field, a URL with a password in
// it. Every one of them must produce "unavailable" — never a page that renders
// an empty, credible, wrong table.

import { describe, expect, it, vi } from "vitest";
import {
  KEEPER_URL_VARIABLE,
  fetchLeaderboard,
  formatSol,
  leaderboardEndpoint,
  parseLeaderboard,
} from "./leaderboard";

const RULES = { participation: 10, sizeFactor: 5, sizeCap: 25, sizeUnit: 1_000_000, streakPerDay: 2, streakCap: 20 };

const entry = (over: Record<string, unknown> = {}) => ({
  rank: 1,
  subject: "5Y1bpPuG8hatmmUKC86WLJqbMuNfXAQUQAQMwKM3YNMe",
  points: 84,
  activeDays: 5,
  bestStreak: 5,
  settles: 7,
  amountRaw: "36600000",
  ...over,
});

const payload = (over: Record<string, unknown> = {}) => ({
  computedAt: "2026-09-20T21:00:00.000Z",
  seasonStart: "2026-09-14T00:00:00.000Z",
  unit: "lamports",
  rules: { ahorro: RULES, volumen: { ...RULES, sizeFactor: 4, sizeCap: 20 } },
  coverage: { subjects: 1, settlements: 7, firstDay: "2026-09-14", lastDay: "2026-09-20" },
  boards: {
    ahorro: { season: [entry()], all: [entry()] },
    volumen: { season: [], all: [] },
  },
  ...over,
});

describe("the endpoint", () => {
  it("is the keeper's URL with /leaderboard on the end, trailing slash or not", () => {
    expect(leaderboardEndpoint({ [KEEPER_URL_VARIABLE]: "https://keeper.example.test" })).toEqual({
      ok: true,
      url: "https://keeper.example.test/leaderboard",
    });
    expect(leaderboardEndpoint({ [KEEPER_URL_VARIABLE]: "https://keeper.example.test/" })).toMatchObject({
      url: "https://keeper.example.test/leaderboard",
    });
    // A keeper behind a path prefix keeps its prefix.
    expect(leaderboardEndpoint({ [KEEPER_URL_VARIABLE]: "https://ops.example.test/sip/" })).toMatchObject({
      url: "https://ops.example.test/sip/leaderboard",
    });
  });

  it("says what is missing instead of guessing a host", () => {
    const missing = leaderboardEndpoint({});
    expect(missing.ok).toBe(false);
    expect(missing.ok === false && missing.detail).toContain(KEEPER_URL_VARIABLE);
    expect(leaderboardEndpoint({ [KEEPER_URL_VARIABLE]: "   " }).ok).toBe(false);
    expect(leaderboardEndpoint({ [KEEPER_URL_VARIABLE]: "keeper.example.test" }).ok).toBe(false);
  });

  it("refuses credentials in the URL rather than stripping them", () => {
    // Stripping would leave the password sitting in an environment variable
    // nobody ever looks at again.
    const answer = leaderboardEndpoint({ [KEEPER_URL_VARIABLE]: "https://user:pw@keeper.example.test" });
    expect(answer.ok).toBe(false);
    expect(answer.ok === false && answer.detail).toContain("credentials");
  });

  it("requires https off localhost", () => {
    expect(leaderboardEndpoint({ [KEEPER_URL_VARIABLE]: "http://keeper.example.test" }).ok).toBe(false);
    expect(leaderboardEndpoint({ [KEEPER_URL_VARIABLE]: "http://localhost:8080" })).toMatchObject({
      ok: true,
      url: "http://localhost:8080/leaderboard",
    });
  });
});

describe("parsing what came back", () => {
  it("accepts the keeper's payload and keeps lamports as a string", () => {
    const data = parseLeaderboard(payload());
    expect(data).not.toBeNull();
    expect(data!.boards.ahorro.season[0]!.amountRaw).toBe("36600000");
    expect(data!.rules.volumen.sizeCap).toBe(20);
    expect(data!.coverage.settlements).toBe(7);
  });

  it("refuses a payload that is not a leaderboard", () => {
    expect(parseLeaderboard(null)).toBeNull();
    expect(parseLeaderboard("<html>502 Bad Gateway</html>")).toBeNull();
    expect(parseLeaderboard(payload({ unit: "sol" }))).toBeNull();
    expect(parseLeaderboard(payload({ rules: { ahorro: RULES } }))).toBeNull();
    expect(parseLeaderboard(payload({ boards: { ahorro: { season: [] }, volumen: { season: [], all: [] } } }))).toBeNull();
  });

  it("keeps the breakdown, so a score can be checked by whoever reads the route", () => {
    const withBreakdown = payload({
      boards: {
        ahorro: { season: [entry({ breakdown: { participation: 50, size: 26, streak: 8 } })], all: [] },
        volumen: { season: [], all: [] },
      },
    });
    expect(parseLeaderboard(withBreakdown)!.boards.ahorro.season[0]!.breakdown).toEqual({ participation: 50, size: 26, streak: 8 });
    // A keeper too old to send one still ranks, and so does a broken one.
    expect(parseLeaderboard(payload())!.boards.ahorro.season[0]!.breakdown).toBeUndefined();
    const broken = payload({
      boards: { ahorro: { season: [entry({ breakdown: { participation: "ten" } })], all: [] }, volumen: { season: [], all: [] } },
    });
    const row = parseLeaderboard(broken)!.boards.ahorro.season[0]!;
    expect(row.points).toBe(84);
    expect(row.breakdown).toBeUndefined();
  });

  it("drops a row it cannot read instead of refusing the whole board", () => {
    const data = parseLeaderboard(
      payload({
        boards: {
          ahorro: { season: [entry(), { rank: 2, subject: "x" }, entry({ rank: 3, amountRaw: 12 })], all: [] },
          volumen: { season: [], all: [] },
        },
      }),
    );
    // A number where lamports belong is exactly the bug this rejects: JSON
    // would have rounded it on the way here.
    expect(data!.boards.ahorro.season).toHaveLength(1);
  });
});

describe("fetching it", () => {
  const env = { [KEEPER_URL_VARIABLE]: "https://keeper.example.test" };

  it("returns the parsed board", async () => {
    const answer = await fetchLeaderboard(env, vi.fn().mockResolvedValue(Response.json(payload())) as unknown as typeof fetch);
    expect(answer.ok).toBe(true);
    expect(answer.ok === true && answer.data.boards.ahorro.all[0]!.points).toBe(84);
  });

  it("passes the keeper's own reason through when it refuses", async () => {
    const refusal = Response.json({ error: "the leaderboard is not available", detail: "this keeper has no database" }, { status: 503 });
    const answer = await fetchLeaderboard(env, vi.fn().mockResolvedValue(refusal) as unknown as typeof fetch);
    expect(answer).toEqual({ ok: false, detail: "this keeper has no database" });
  });

  it("calls a stale or broken build unavailable rather than rendering it", async () => {
    const answer = await fetchLeaderboard(env, vi.fn().mockResolvedValue(Response.json({ boards: {} })) as unknown as typeof fetch);
    expect(answer.ok).toBe(false);
    expect(answer.ok === false && answer.detail).toContain("not a leaderboard");
  });

  it("never throws, whatever the network does", async () => {
    const thrown = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    const timeout = await fetchLeaderboard(env, vi.fn().mockRejectedValue(thrown) as unknown as typeof fetch);
    expect(timeout).toEqual({ ok: false, detail: "the keeper did not answer in time" });

    const refused = await fetchLeaderboard(env, vi.fn().mockRejectedValue(new Error("ECONNREFUSED 10.0.0.1:8080")) as unknown as typeof fetch);
    expect(refused).toEqual({ ok: false, detail: "the keeper could not be reached" });
    // No upstream text, and no address, reaches a visitor.
    expect(refused.ok === false && refused.detail).not.toContain("10.0.0.1");
  });

  it("does not call the network at all with no keeper configured", async () => {
    const fetchImpl = vi.fn();
    const answer = await fetchLeaderboard({}, fetchImpl as unknown as typeof fetch);
    expect(answer.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("the amounts", () => {
  it("formats lamports as SOL without rounding through a double", () => {
    expect(formatSol("36600000")).toBe("0.0366");
    expect(formatSol("1000000000")).toBe("1");
    expect(formatSol("1500000000")).toBe("1.5");
    expect(formatSol("0")).toBe("0");
    // Dust says it is dust rather than claiming to be zero.
    expect(formatSol("1")).toBe("<0.0001");
    // Nine million SOL: past a double's exact integers, and still exact here.
    expect(formatSol("9007199254740993000")).toBe("9007199254.7409");
    expect(formatSol("not a number")).toBe("—");
  });
});
