// What just arrived (use-arrivals.ts): a transaction new to the page AND newer
// than anything it showed — and nothing at all on a first paint, an older page,
// a backfilled settlement, a new price, or the snapshot that lands before its
// history. Every case the plan lists (LIVE_LOADING_PLAN_2026-10-09, "Units") is
// here, built through the real model, so a rule cannot pass against a shape the
// page never draws.

import { describe, expect, it } from "vitest";

import {
  ARRIVAL_HOLD_MS,
  PILL_MS,
  advanceArrivals,
  arrivalTone,
  arrivalsOf,
  baseOf,
  heroPillOf,
  pillShown,
  startArrivals,
  type ArrivalFrame,
  type ArrivalSaving,
} from "@/components/live/use-arrivals";
import { toDashboardMock } from "@/lib/live-mock";
import { toLiveDashboard } from "@/lib/live-model";
import type { LiveDashboard, LiveEntryJson, LiveRow, LiveSnapshotJson, VaultEventJson } from "@/lib/live-types";
import type { Trade } from "@/mocks/types";

import { NOW_MS, OWNER, PRICES, WALLET_A, liveActivity, liveEntry, liveSnapshot, seconds, settledEvent, signature } from "../../../test/fixtures/live-dashboard";

const at = (msAgo: number): number => seconds(NOW_MS - msAgo);

/** A settlement an hour old: what the page already shows. */
const OLD = liveEntry(signature(1), at(3_600_000), [settledEvent("60000000")], 4_000);
/** A settlement a minute old, in a later slot: what a read brings. */
const NEW = liveEntry(signature(2), at(60_000), [settledEvent("40000000")], 4_100);
/** Its conversion, half a minute later. */
const CONVERTED = liveEntry(signature(3), at(30_000), [{ kind: "converted", lamportsSpent: "40000000", usdcReceivedRaw: "4001548" } as VaultEventJson], 4_150);
/** A transaction that did not land. */
const FAILED: LiveEntryJson = { ...liveEntry(signature(4), at(20_000), [{ kind: "failed", instructions: ["settle"] } as VaultEventJson], 4_200), ok: false };
/** A day old, in an earlier slot: what Load older appends. */
const OLDER = liveEntry(signature(9), at(86_400_000), [settledEvent("10000000")], 3_000);
/** The keeper's account-keeping, new: hidden behind the disclosure. */
const UPKEEP = liveEntry(signature(5), at(10_000), [{ kind: "upkeep" } as VaultEventJson], 4_300);

function dash(entries: readonly LiveEntryJson[], options: { readonly snapshot?: LiveSnapshotJson; readonly linkEntries?: readonly LiveEntryJson[] } = {}): LiveDashboard {
  return toLiveDashboard({
    snapshot: options.snapshot ?? liveSnapshot(),
    activity: liveActivity(entries),
    privyWallets: [WALLET_A],
    ...(options.linkEntries === undefined ? {} : { linkEntries: options.linkEntries }),
  });
}

const frame = (data: LiveDashboard, over: Partial<Omit<ArrivalFrame, "data">> = {}): ArrivalFrame => ({
  key: OWNER,
  data,
  activityPending: false,
  activityUnreadable: false,
  ...over,
});

/** What `next` brings after `prev` was shown. */
const arrived = (prev: ArrivalFrame, next: ArrivalFrame): readonly LiveRow[] => arrivalsOf(baseOf(prev), next).arrived;
const signatures = (rows: readonly LiveRow[]): string[] => [...new Set(rows.map((row) => row.signature))];

describe("what counts as arrived", () => {
  it("marks one transaction per genuinely new signature, once — its vault row and its settlement row are one", () => {
    const rows = arrived(frame(dash([OLD])), frame(dash([NEW, OLD])));
    expect(signatures(rows)).toEqual([NEW.signature]);
    expect(rows).toHaveLength(1);
  });

  it("marks every event of a new transaction: a settle that paid two wallets is two chips, both new", () => {
    const two = liveEntry(signature(6), at(50_000), [settledEvent("40000000"), { ...settledEvent("20000000"), wallet: "TradingOneP1aceho1der111111111111111111111" } as VaultEventJson], 4_120);
    const rows = arrived(frame(dash([OLD])), frame(dash([two, OLD])));
    expect(signatures(rows)).toEqual([two.signature]);
    expect(rows).toHaveLength(2);
  });

  it("marks several new transactions from one read, and never the rows already shown", () => {
    expect(signatures(arrived(frame(dash([OLD])), frame(dash([CONVERTED, NEW, OLD]))))).toEqual([CONVERTED.signature, NEW.signature]);
  });

  it("never marks the machinery's hidden account-keeping", () => {
    expect(arrived(frame(dash([OLD])), frame(dash([UPKEEP, OLD])))).toEqual([]);
  });
});

describe("what never counts as arrived", () => {
  it("anything on a first paint (or a remount): there is nothing to compare with", () => {
    expect(arrivalsOf(null, frame(dash([NEW, OLD]))).arrived).toEqual([]);
  });

  it("anything of another pension key", () => {
    expect(arrived(frame(dash([OLD])), frame(dash([NEW, OLD]), { key: "AnotherKeyP1aceho1der1111111111111111111111" }))).toEqual([]);
  });

  it("the history coming into view, from on its way to read", () => {
    expect(arrived(frame(dash([OLD]), { activityPending: true }), frame(dash([NEW, OLD])))).toEqual([]);
  });

  it("the history coming into view, from unreadable to read", () => {
    expect(arrived(frame(dash([OLD]), { activityUnreadable: true }), frame(dash([NEW, OLD])))).toEqual([]);
  });

  it("the history's first rows: nothing was loaded before", () => {
    expect(arrived(frame(dash([])), frame(dash([NEW, OLD])))).toEqual([]);
  });

  it("a head that replaced the one shown (a gap): fifteen flashes would be noise", () => {
    const page = Array.from({ length: 15 }, (_, index) => liveEntry(signature(20 + index), at(1_000 * (index + 1)), [settledEvent("1000000")], 5_000 - index));
    expect(arrived(frame(dash([OLD])), frame(dash(page)))).toEqual([]);
  });

  it("an older page someone asked for (Load older)", () => {
    expect(arrived(frame(dash([NEW, OLD])), frame(dash([NEW, OLD, OLDER])))).toEqual([]);
  });

  it("a settlement backfilled from a wallet's link, at or below the newest slot shown", () => {
    const backfilled = liveEntry(signature(8), at(7_200_000), [settledEvent("30000000")], 3_500);
    const atNewest = liveEntry(signature(7), at(3_000_000), [settledEvent("30000000")], 4_000);
    const next = dash([OLD], { linkEntries: [atNewest, backfilled] });
    // The adapter does put them on screen — the test is that they are not news.
    expect(next.settlementRows.map((row) => row.signature)).toEqual(expect.arrayContaining([backfilled.signature, atNewest.signature]));
    expect(arrived(frame(dash([OLD])), frame(next))).toEqual([]);
  });

  it("a new price on the same rows", () => {
    const repriced = liveSnapshot({ prices: { ...PRICES!, usdcRawPerSol: "150000000" } });
    expect(arrived(frame(dash([NEW, OLD])), frame(dash([NEW, OLD], { snapshot: repriced })))).toEqual([]);
  });

  it("the snapshot that lands before its history: a new clock, the same rows", () => {
    const later = liveSnapshot({ readAtMs: NOW_MS + 20_000, slot: 4_500 });
    expect(arrived(frame(dash([OLD])), frame(dash([OLD], { snapshot: later })))).toEqual([]);
  });

  it("…and then its history does bring the new row, measured against the rows shown, never the snapshot's newer slot", () => {
    const later = liveSnapshot({ readAtMs: NOW_MS + 20_000, slot: 4_500 });
    let track = startArrivals(frame(dash([OLD])));
    track = advanceArrivals(track, frame(dash([OLD], { snapshot: later })), 1_000);
    expect(track.news).toBeNull();
    track = advanceArrivals(track, frame(dash([NEW, OLD], { snapshot: later })), 2_000);
    expect(signatures(track.news?.rows ?? [])).toEqual([NEW.signature]);
  });
});

describe("the wash's tone", () => {
  const rowOf = (entry: LiveEntryJson): LiveRow => dash([entry]).rows[0]!;

  it("is green for a saving, blue for a buy, mustard for a rule, grey for the machinery", () => {
    expect(arrivalTone(rowOf(NEW))).toBe("saved");
    expect(arrivalTone(rowOf(liveEntry(signature(11), at(1_000), [{ kind: "invested", mint: null, symbol: "SPYx", usdcSpentRaw: "1000000", receivedRaw: "1", receivedUi: "0.01" } as VaultEventJson])))).toBe("invest");
    expect(arrivalTone(rowOf(liveEntry(signature(12), at(1_000), [{ kind: "rule_changed", mode: 0, skimBps: 2_000, volumeBps: null, paused: false, maxContribution: null, walletReserve: null } as VaultEventJson])))).toBe("setting");
    expect(arrivalTone(rowOf(CONVERTED))).toBe("quiet");
  });

  it("is never green for a transaction that failed, nor for a settlement that moved nothing", () => {
    const failed = dash([FAILED]).rows[0]!;
    expect(failed.ok).toBe(false);
    expect(arrivalTone(failed)).toBe("quiet");
    expect(arrivalTone({ ...rowOf(NEW), ok: false })).toBe("quiet");
    expect(arrivalTone(rowOf(liveEntry(signature(13), at(1_000), [settledEvent("0")])))).toBe("quiet");
  });
});

describe("the track: marks, news and the pill", () => {
  it("holds each arrived signature for ARRIVAL_HOLD_MS of browser time, and counts each update that brought news", () => {
    let track = startArrivals(frame(dash([OLD])));
    track = advanceArrivals(track, frame(dash([NEW, OLD])), 1_000);
    expect(track.holds.get(NEW.signature)).toBe(1_000 + ARRIVAL_HOLD_MS);
    expect(track.news?.seq).toBe(1);

    // A commit that brings nothing changes no mark and no news.
    const quiet = advanceArrivals(track, frame(dash([NEW, OLD], { snapshot: liveSnapshot({ readAtMs: NOW_MS + 20_000 }) })), 2_000);
    expect(quiet.holds).toBe(track.holds);
    expect(quiet.news).toBe(track.news);

    const next = advanceArrivals(quiet, frame(dash([CONVERTED, NEW, OLD])), 3_000);
    expect(next.news?.seq).toBe(2);
    expect(signatures(next.news?.rows ?? [])).toEqual([CONVERTED.signature]);
  });

  it("puts a saving on the pill, and keeps it there when the conversion of that saving follows", () => {
    let track = startArrivals(frame(dash([OLD])));
    track = advanceArrivals(track, frame(dash([NEW, OLD])), 1_000);
    expect(track.saving?.atMs).toBe(NOW_MS);
    expect(signatures(track.saving?.rows ?? [])).toEqual([NEW.signature]);
    const saving = track.saving;
    track = advanceArrivals(track, frame(dash([CONVERTED, NEW, OLD])), 2_000);
    expect(track.saving).toBe(saving);
  });

  it("shows the pill for PILL_MS of the page's own data time", () => {
    const saving: ArrivalSaving = { rows: [], atMs: NOW_MS };
    expect(pillShown(saving, NOW_MS)).toBe(true);
    expect(pillShown(saving, NOW_MS + PILL_MS - 1)).toBe(true);
    expect(pillShown(saving, NOW_MS + PILL_MS)).toBe(false);
    expect(pillShown(null, NOW_MS)).toBe(false);
  });
});

describe("the hero's pill", () => {
  const savingOf = (entries: readonly LiveEntryJson[]): { readonly saving: ArrivalSaving; readonly trades: readonly Trade[] } => {
    let track = startArrivals(frame(dash([OLD])));
    const data = dash([...entries, OLD]);
    track = advanceArrivals(track, frame(data), 1_000);
    return { saving: track.saving!, trades: toDashboardMock(data, { complete: false }).trades };
  };

  it("one saving: its dollars, the chip's own, and its time", () => {
    const { saving, trades } = savingOf([NEW]);
    const chip = trades.find((trade) => trade.txHash === NEW.signature)!;
    const pill = heroPillOf(saving, trades, NOW_MS)!;
    expect(pill.text).toBe(`+$${chip.savedUsd!.toFixed(2)} saved · ${new Date(NEW.blockTime! * 1_000).toISOString().slice(11, 16)} UTC`);
    expect(pill.title).toBe("0.04 SOL at today’s SOL price");
  });

  it("more than one: their sum, how many, and the newest one's time", () => {
    const second = liveEntry(signature(14), at(40_000), [settledEvent("20000000")], 4_140);
    const { saving, trades } = savingOf([second, NEW]);
    const pill = heroPillOf(saving, trades, NOW_MS)!;
    expect(pill.text).toMatch(/^\+\$\d+\.\d\d · 2 savings · \d\d:\d\d UTC$/);
    expect(pill.text).toContain(`${new Date(second.blockTime! * 1_000).toISOString().slice(11, 16)} UTC`);
    expect(pill.title).toBe("0.06 SOL at today’s SOL price");
  });

  it("says SOL when a chip could not be priced — never a dollar nobody read", () => {
    const { saving, trades } = savingOf([NEW]);
    const pill = heroPillOf(
      saving,
      trades.map((trade) => ({ ...trade, savedUsd: null })),
      NOW_MS,
    )!;
    expect(pill.text).toMatch(/^\+0\.04 SOL saved · \d\d:\d\d UTC$/);
    expect(pill.title).toBe("0.04 SOL");
  });

  it("never reads as nothing when it moved something", () => {
    const { saving, trades } = savingOf([NEW]);
    expect(heroPillOf(saving, trades.map((trade) => ({ ...trade, savedUsd: 0.001 })), NOW_MS)!.text).toMatch(/^\+<\$0\.01 saved/);
  });

  it("says the day too once its time is not the page's today: still up after midnight, it is not minutes old", () => {
    const { saving, trades } = savingOf([NEW]);
    // NEW landed at 11:59 UTC on Sep 16; the page's clock has moved to the next day.
    const pill = heroPillOf(saving, trades, NOW_MS + 13 * 3_600_000)!;
    expect(pill.text).toMatch(/ · yesterday, 11:59 UTC$/);
  });

  it("is nothing before a saving arrived", () => {
    expect(heroPillOf(null, [], NOW_MS)).toBeNull();
  });
});
