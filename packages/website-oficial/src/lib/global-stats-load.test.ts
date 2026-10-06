// The live dashboard's load: the keeper and the price, side by side. A price
// that cannot be read never holds the SOL figures back, and a deployment with
// no chain settings is said apart from a read that failed.

import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { PriceUnconfigured, loadGlobalStats } from "@/lib/global-stats-load";
import { known, unavailable } from "@/lib/global-stats-model";
import { KEEPER_URL_VARIABLE } from "@/lib/leaderboard";

const RULES = { participation: 10, sizeFactor: 5, sizeCap: 25, sizeUnit: 1_000_000, streakPerDay: 2, streakCap: 20 };
const BODY = {
  computedAt: "2026-10-06T18:00:00.000Z",
  seasonStart: "2026-10-05T00:00:00.000Z",
  unit: "lamports",
  rules: { ahorro: RULES, volumen: RULES },
  coverage: { subjects: 1, settlements: 9, firstDay: "2026-09-19", lastDay: "2026-09-25" },
  boards: {
    total: { season: [], all: [{ rank: 1, subject: "pension-0", points: 1, activeDays: 3, bestStreak: 2, settles: 9, amountRaw: "186400000" }] },
    ahorro: { season: [], all: [] },
    volumen: { season: [], all: [] },
  },
};
const SHELF = { offered: ["SPYx"], listed: 9, symbolOf: {} };
const ENV = { [KEEPER_URL_VARIABLE]: "https://keeper.example.test" };
const answering = (response: Response) => vi.fn().mockResolvedValue(response) as unknown as typeof fetch;

describe("loading the live dashboard", () => {
  it("reads the keeper and the price, and builds a live model", async () => {
    const model = await loadGlobalStats({ shelf: SHELF, env: ENV, fetchImpl: answering(Response.json(BODY)), readPrice: async () => "150000000" });
    expect(model.source).toBe("live");
    expect(model.saved.kind).toBe("known");
    expect(model.solPrice).toEqual(known("150000000"));
  });

  it("keeps the SOL figures when the price cannot be read, and says which way it failed", async () => {
    const failed = await loadGlobalStats({ shelf: SHELF, env: ENV, fetchImpl: answering(Response.json(BODY)), readPrice: () => Promise.reject(new Error("rpc down")) });
    expect(failed.solPrice).toEqual(unavailable("price-unread"));
    expect(failed.saved.kind).toBe("known");
    const unconfigured = await loadGlobalStats({ shelf: SHELF, env: ENV, fetchImpl: answering(Response.json(BODY)), readPrice: () => Promise.reject(new PriceUnconfigured("no settings")) });
    expect(unconfigured.solPrice).toEqual(unavailable("price-unconfigured"));
    const nonsense = await loadGlobalStats({ shelf: SHELF, env: ENV, fetchImpl: answering(Response.json(BODY)), readPrice: async () => "0" });
    expect(nonsense.solPrice).toEqual(unavailable("price-unread"));
  });

  it("with no keeper configured, makes no request and says so", async () => {
    const fetchImpl = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const model = await loadGlobalStats({ shelf: SHELF, env: {}, fetchImpl: fetchImpl as unknown as typeof fetch, readPrice: async () => "1" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(model.feed).toEqual({ ok: false, reason: "source-unconfigured" });
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("a 503 is 'not ready', not an empty page", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const model = await loadGlobalStats({ shelf: SHELF, env: ENV, fetchImpl: answering(Response.json({ detail: "not computed yet" }, { status: 503 })), readPrice: async () => "1" });
    expect(model.feed).toEqual({ ok: false, reason: "source-not-ready" });
    warn.mockRestore();
  });
});

/**
 * THE SAMPLE STAYS OUT OF THE LIVE PATH. Only the page — which decides the
 * mode — may import it; a live module that reached it could show invented
 * pensions as real ones.
 */
describe("the sample's reach", () => {
  const LIVE_FILES = [
    "lib/global-stats-model.ts",
    "lib/global-stats-series.ts",
    "lib/global-stats-load.ts",
    "lib/global-stats-price.ts",
    "lib/global-stats-copy.ts",
    "lib/global-stats-mode.ts",
    "components/global-stats-view.tsx",
    "components/global-stats-chart.tsx",
    "components/global-stats-mode-toggle.tsx",
  ];

  it("is imported by none of the modules that draw live figures", () => {
    for (const file of LIVE_FILES) {
      const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
      expect(source, file).not.toMatch(/from\s*["'][^"']*global-stats-sample["']/);
      expect(source, file).not.toMatch(/from\s*["']@\/mocks(?:\/data)?["']/);
    }
  });

  /**
   * THE HYDRATION RULE, for the files this page added: no clock, no randomness
   * and no locale-dependent formatting while rendering. The page itself is
   * left out on purpose — it is where `now` is resolved, once.
   */
  it("reads no clock and formats with no locale in any of them", () => {
    for (const file of LIVE_FILES) {
      const code = readFileSync(new URL(`../${file}`, import.meta.url), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*)/.test(line))
        .join("\n");
      expect(code, file).not.toMatch(/Date\.now\(|new Date\(\)|Math\.random\(|toLocale[A-Za-z]*\(/);
    }
  });
});
