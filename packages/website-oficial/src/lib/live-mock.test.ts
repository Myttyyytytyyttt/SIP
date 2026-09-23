// THE LIVE PENSION IN THE SAMPLE'S SHAPE, and nothing of the sample in it.
//
// The sample's components now draw a real pension through this adapter. What
// is pinned here is what makes that safe: no figure the sample invented can
// come out; a figure the chain cannot answer comes out null (a dash), never
// zero; dollars are today's price on the chain's own lamports; and the rows the
// sample fills with trades are filled with what the chain actually records.

import { describe, expect, it } from "vitest";

import { usdcRawForLamports } from "@/lib/amounts";
import { anchorOf, toDashboardMock } from "@/lib/live-mock";
import { toLiveDashboard } from "@/lib/live-model";
import type { LiveDashboard, LiveWalletView, VaultEventJson } from "@/lib/live-types";

import {
  DEFAULT_ENTRIES,
  NOW_MS,
  PRICES,
  WALLET_A,
  liveActivity,
  liveDashboard,
  liveEntry,
  liveSnapshot,
  seconds,
  settledEvent,
  signature,
} from "../../test/fixtures/live-dashboard";

const adapt = (data: LiveDashboard = liveDashboard(), complete = false) => toDashboardMock(data, { complete });

/** Lamports as dollars at the fixture's own price — computed the way the page computes it, never hardcoded. */
const at = (lamports: bigint): number => Number(usdcRawForLamports(lamports, BigInt(PRICES!.usdcRawPerSol))) / 1_000_000;

const DAY_MS = 86_400_000;

describe("nothing of the sample can come out", () => {
  /**
   * The sample's wallet, its clock, its tickers and its fills. None of them
   * exists on this pension, so none of them may appear in what it draws.
   */
  it("carries no sample identifier, ticker or fill", () => {
    const text = JSON.stringify(adapt(), (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value));
    for (const sample of ["FezjSXZsF5dcDjHS9PGq2zvw2Nu8SNmJwbDRPAJZgyXA", "2026-09-07T14:32:00.000Z", "INDEX", "GLDx", "HOODx", "NVDAx", "TSLAx"]) {
      expect(text, sample).not.toContain(sample);
    }
    expect(text).not.toMatch(/\bSold\b|\bBought\b|Funded wallet/);
  });

  it("produces no trade and no deposit: the chain records neither", () => {
    expect(adapt().activity.filter((event) => event.kind === "trade" || event.kind === "deposit")).toEqual([]);
  });
});

describe("dollars are today's price on the chain's own lamports", () => {
  it("values the hero, the wallet and a settlement at the one price this read", () => {
    const page = adapt();
    expect(page.stats.totalSavedUsd).toBe(at(60_000_000n));
    expect(page.wallet?.balanceUsd).toBe(at(420_000_000n));
    const saved = page.activity.find((event) => event.kind === "saved");
    expect(saved?.kind === "saved" && saved.savedUsd).toBe(at(60_000_000n));
  });

  /** Unreadable is not zero. Every dollar goes to a dash; the curve keeps the chain's own unit. */
  it("with no price read, every dollar is null and the curve is drawn in SOL", () => {
    const page = adapt(liveDashboard({ snapshot: liveSnapshot({ prices: null }) }));
    expect(page.stats.totalSavedUsd).toBeNull();
    expect(page.stats.savedTodayUsd).toBeNull();
    expect(page.stats.pensionValueUsd).toBeNull();
    expect(page.wallet?.balanceUsd ?? null).toBeNull();
    expect(page.unit).toBe("SOL");
    expect(page.curve.at(-1)?.total).toBe(0.06);
  });

  it("has no gain or loss, because the chain keeps no cost basis", () => {
    const page = adapt();
    expect(page.stats.unrealizedUsd).toBeNull();
    expect(page.stats.costUsd).toBeNull();
  });
});

describe("the curve is one point per UTC day, as the sample's chart assumes", () => {
  it("steps a day at a time, from the day before the first, to today", () => {
    const { curve } = adapt();
    expect(curve.length).toBeGreaterThan(1);
    for (let index = 1; index < curve.length; index += 1) {
      expect(Date.parse(curve[index]!.date) - Date.parse(curve[index - 1]!.date)).toBe(DAY_MS);
    }
    expect(curve.at(-1)!.date).toBe(new Date(NOW_MS).toISOString().slice(0, 10));
  });

  it("ends at the hero's own figure, so the two can never disagree", () => {
    const page = adapt();
    expect(page.curve.at(-1)!.total).toBe(page.stats.totalSavedUsd);
  });

  it("never falls as it goes: a total that only grows cannot be drawn going down", () => {
    const { curve } = adapt();
    for (let index = 1; index < curve.length; index += 1) expect(curve[index]!.total).toBeGreaterThanOrEqual(curve[index - 1]!.total);
  });
});

describe("the sample's slots, filled with what the chain records", () => {
  it("counts settlements where the sample counts trades, and says so", () => {
    const { stats } = adapt();
    expect(stats.vocabulary).toBe("settlements");
    // The link's own nonce, not the rows that happen to be loaded.
    expect(stats.trades).toBe(3);
    expect(stats.avgSavedPerTradeUsd).toBe(at(20_000_000n));
  });

  it("shows the gains the rule measured where the sample shows volume — only when every settlement is loaded", () => {
    // The fixture's one settlement IS the whole lifetime (0.06 of 0.06 SOL).
    expect(adapt().stats.volumeUsd).toBe(at(500_000_000n));
    // Half a lifetime loaded is not a lifetime, so it has no such figure.
    const snapshot = liveSnapshot();
    const partial = liveDashboard({
      snapshot: { ...snapshot, vault: { ...snapshot.vault, state: { ...snapshot.vault.state!, lifetimeSaved: "120000000" } } },
      // More pages to read: the vault page has NOT reached its beginning.
      activity: liveActivity(DEFAULT_ENTRIES, { nextBefore: signature(40) }),
    });
    expect(adapt(partial).stats.volumeUsd).toBeNull();
  });

  it("uses the basket's real threshold, and none for a basket the caps can never buy", () => {
    const page = adapt();
    expect(page.rule.thresholdUsd).toBe(5);
    expect(page.stats.thresholdUsd).toBe(5);
    const missing = adapt(liveDashboard({ snapshot: liveSnapshot({ policy: { status: "missing", address: "p" } }) }));
    expect(missing.rule.thresholdUsd).toBeNull();
  });

  it("names the vault's own measure and rate", () => {
    const { rule } = adapt();
    expect(rule.mode).toBe("profit");
    expect(rule.rateBps).toBe(2_000);
    expect(rule.targets.map((target) => target.symbol)).toEqual(["SPYx"]);
  });

  it("gives the streaks and active days the sample's own meaning, over the days the history can vouch for", () => {
    const { stats, days } = adapt();
    // Created the day before, settled today: two whole days, one with a save.
    expect(days.map((day) => day.date)).toEqual(["2026-09-15", "2026-09-16"]);
    expect(stats.activeDays).toBe(1);
    expect(stats.currentStreakDays).toBe(1);
    expect(stats.longestStreakDays).toBe(1);
  });

  it("lists the basket as the sample does — legs only, with the cash under Pending", () => {
    const { holdings, stats } = adapt();
    expect(holdings.map((holding) => holding.symbol)).toEqual(["SPYx"]);
    // Exactly as the RPC wrote it: SPYx's display amount is scaled.
    expect(holdings[0]!.sharesText).toBe("0.1241643");
    expect(stats.pendingUsd).not.toBeNull();
  });
});

describe("the feed carries the settlements, which is where the greens were missing", () => {
  it("draws a settlement found only on a wallet's link, beside the vault's own page", () => {
    const linkOnly = liveEntry(signature(90), seconds(NOW_MS - 2 * 3_600_000), [settledEvent("30000000")]);
    const snapshot = liveSnapshot();
    const data = toLiveDashboard({
      snapshot: { ...snapshot, vault: { ...snapshot.vault, state: { ...snapshot.vault.state!, lifetimeSaved: "90000000" } } },
      activity: liveActivity(DEFAULT_ENTRIES),
      linkEntries: [linkOnly],
      privyWallets: [WALLET_A],
    });
    const saved = toDashboardMock(data, { complete: false }).activity.filter((event) => event.kind === "saved");
    expect(saved.map((event) => event.txHash)).toEqual([signature(1), signature(90)]);
  });

  it("links every row to its transaction", () => {
    for (const event of adapt().activity) expect(event.href).toMatch(/^https:\/\/solscan\.io\/tx\//);
  });

  it("never drops a withdrawal, and signs it as money leaving", () => {
    const withdrawal: VaultEventJson = { kind: "withdrew_sol", lamports: "20000000" } as VaultEventJson;
    const data = liveDashboard({ activity: liveActivity([...DEFAULT_ENTRIES, liveEntry(signature(5), seconds(NOW_MS - 7_200_000), [withdrawal])]) });
    const row = adapt(data).activity.find((event) => event.txHash === signature(5));
    expect(row?.kind).toBe("other");
    expect(row?.kind === "other" && row.amount).toMatch(/^−\$/);
  });

  it("says nothing was saved when nothing moved, in the live feed's own words", () => {
    const data = liveDashboard({ activity: liveActivity([liveEntry(signature(6), seconds(NOW_MS - 3_600_000), [settledEvent("0")])]) });
    const row = adapt(data).activity.find((event) => event.kind === "saved");
    expect(row?.kind === "saved" && row.title).toMatch(/nothing to save/);
  });

  /**
   * A PRICE PER SHARE ONLY WHEN IT IS ONE. The USDC a transaction spent is the
   * whole transaction's, so two buys in one transaction would each show twice
   * what they paid. One buy, one price; two, none.
   */
  it("prints a unit price only for a transaction that bought one thing", () => {
    const buy = (received: string): VaultEventJson =>
      ({ kind: "invested", mint: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W", symbol: "SPYx", usdcSpentRaw: "5000000", receivedRaw: "1", receivedUi: received }) as unknown as VaultEventJson;
    const data = liveDashboard({
      activity: liveActivity([
        ...DEFAULT_ENTRIES,
        liveEntry(signature(7), seconds(NOW_MS - 7_200_000), [buy("0.01")]),
        liveEntry(signature(8), seconds(NOW_MS - 9_000_000), [buy("0.01"), buy("0.02")]),
      ]),
    });
    const invested = adapt(data).activity.filter((event) => event.kind === "invested");
    const one = invested.find((event) => event.txHash === signature(7));
    expect(one?.kind === "invested" && one.priceUsd).toBe(500);
    for (const two of invested.filter((event) => event.txHash === signature(8))) expect(two.kind === "invested" && two.priceUsd).toBeNull();
  });
});

describe("the wallet the column leads with", () => {
  const wallet = (address: string, lamports: bigint | null, linkStatus: LiveWalletView["linkStatus"]): LiveWalletView =>
    ({ address, label: address, source: "privy", lamports, linkAddress: `${address}-link`, linkStatus, settlementNonce: 0n, canSettle: true }) as LiveWalletView;

  it("is the one readable wallet, or the one linked here — never a guess between two", () => {
    expect(anchorOf([wallet("a", 1n, "missing")])).toBe("a");
    expect(anchorOf([wallet("a", 1n, "this_vault"), wallet("b", 1n, "missing")])).toBe("a");
    expect(anchorOf([wallet("a", 1n, "this_vault"), wallet("b", 1n, "this_vault")])).toBeNull();
    // A balance nobody could read is never the one promoted.
    expect(anchorOf([wallet("a", null, "this_vault")])).toBeNull();
  });

  it("is absent from the page when there is no such wallet", () => {
    expect(adapt(liveDashboard({ snapshot: liveSnapshot({ wallets: [] }), privyWallets: [] })).wallet).toBeNull();
    expect(adapt().wallet?.label).toBe("Trading wallet 1");
  });
});

describe("a window the loaded history does not cover has no total", () => {
  it("leaves today, the week and the month null rather than smaller", () => {
    // A lifetime twice what is loaded, and a vault page that stops short: nothing proves the window.
    const snapshot = liveSnapshot();
    const data = liveDashboard({
      snapshot: { ...snapshot, vault: { ...snapshot.vault, state: { ...snapshot.vault.state!, lifetimeSaved: "120000000" } } },
      activity: liveActivity(DEFAULT_ENTRIES, { nextBefore: signature(40) }),
    });
    const { stats, days } = adapt(data);
    expect(stats.savedTodayUsd).toBeNull();
    expect(stats.savedThisMonthUsd).toBeNull();
    // The vault page reaches back only to a settlement an hour ago: today has
    // lost its morning, so not one whole day is vouched for — none, not zeros.
    expect(days).toEqual([]);
    expect(stats.activeDays).toBeNull();
  });
});
