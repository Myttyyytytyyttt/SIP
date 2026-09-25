// NOTHING ON THIS SCREEN MAY SAY WHAT THE VAULT'S OWN STATE CONTRADICTS.
//
// 2026-09-19, mainnet: twelve of the fifteen newest vault signatures were keeper
// upkeep, so the 00:50:21Z settlement sat at position 24 and no loaded page held
// it. The card then read "LAST SETTLEMENT none yet" and "The chart starts with
// your first settlement" — both false — above "saved so far 0.0366 SOL", which
// was right, because that figure reads state while the rest read the page.
//
// Paging back for the settlement (live-backfill.ts) is the other half of the
// fix, and it can fail, be rate-limited, or simply not reach far enough. So this
// is the half that must hold WHATEVER the history turns out to hold: the card is
// rendered from the real model, through the adapter, into the sample's own
// panel — exactly as LiveBody mounts it — and asked what it says.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PensionChart } from "@/components/pension-chart";
import { PensionPanel } from "@/components/pension-panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import { toDashboardMock } from "@/lib/live-mock";
import { LIVE_COPY, STATS_COPY } from "@/lib/live-copy";
import type { LiveDashboard, LiveEntryJson, LiveSnapshotJson, VaultEventJson } from "@/lib/live-types";

import { NOW_MS, WALLET_A, liveActivity, liveDashboard, liveEntry, liveSnapshot, seconds, settledEvent, signature } from "../../../test/fixtures/live-dashboard";

const UPKEEP = { kind: "upkeep" } as VaultEventJson;

/** The fifteen newest signatures, every one of them the keeper's own account-keeping. */
const UPKEEP_PAGE: readonly LiveEntryJson[] = Array.from({ length: 15 }, (_, index) => liveEntry(signature(index + 1), seconds(NOW_MS - (index + 1) * 600_000), [UPKEEP]));

/** The incident: the vault has saved (lifetimeSaved 0.06 SOL, a link nonce of 3), and no loaded row is a settlement. */
const settledButNotHere = (): LiveDashboard => liveDashboard({ activity: liveActivity(UPKEEP_PAGE, { nextBefore: signature(16) }) });

/** The same page over a pension that genuinely never settled: nothing on chain says otherwise. */
function neverSettled(): LiveDashboard {
  const snapshot: LiveSnapshotJson = liveSnapshot();
  return liveDashboard({
    snapshot: {
      ...snapshot,
      vault: { ...snapshot.vault, state: { ...snapshot.vault.state!, lifetimeSaved: "0" } },
      wallets: [{ ...snapshot.wallets[0]!, link: { ...snapshot.wallets[0]!.link, settlementNonce: "0" } }],
    },
    activity: liveActivity(UPKEEP_PAGE, { nextBefore: signature(16) }),
  });
}

const card = (data: LiveDashboard): string => {
  const page = toDashboardMock(data, { complete: false });
  return renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(PensionPanel, { stats: page.stats, curve: page.curve, holdings: page.holdings, days: page.days, rule: page.rule, now: page.now }),
    ),
  );
};

describe("a settlement the state records and the loaded history does not hold", () => {
  it("is what the model says, rather than a pension with nothing in it", () => {
    const data = settledButNotHere();
    expect(data.stats.settledOutsideHistory).toBe(true);
    expect(data.stats.loadedSettlements).toBe(0);
    expect(data.stats.settlementsLifetime).toBe(3n);
    // The figure that was right all along, because it reads state.
    expect(data.vault.lifetimeSaved).toBe(60_000_000n);
  });

  it("NEVER says the last settlement is none yet", () => {
    // The sample's panel has no "last settlement" tile to be wrong in; what it
    // must not do is say, anywhere, that there has been none.
    const html = card(settledButNotHere());
    expect(html).not.toContain(STATS_COPY.lastSettlementNever);
    expect(html).not.toContain(LIVE_COPY.chartEmpty);
    // The hero is the vault's own total, whatever the page held: 0.06 SOL at the fixture's price.
    expect(html).toContain("$6.00");
  });

  it("NEVER says the chart starts with a first settlement that already happened", () => {
    const html = card(settledButNotHere());
    expect(html).not.toContain(LIVE_COPY.chartEmpty);
    expect(html).toContain(LIVE_COPY.chartFlat);
  });

  it("draws the flat line the vault's own total makes true: it moves only when a settlement lands", () => {
    const data = settledButNotHere();
    const points = data.chart!;
    expect(points).not.toBeNull();
    expect(points.map((point) => point.totalLamports)).toEqual([60_000_000n, 60_000_000n]);
    // Across the loaded window only: from its oldest row to the read's own clock.
    expect(Date.parse(points[0]!.at)).toBe(UPKEEP_PAGE[UPKEEP_PAGE.length - 1]!.blockTime! * 1_000);
    expect(Date.parse(points[points.length - 1]!.at)).toBe(NOW_MS);
    // And the hero over it is that same number.
    expect(points[points.length - 1]!.totalLamports).toBe(data.vault.lifetimeSaved);
  });

  it("says where the settlements are when there is no window at all to be flat across", () => {
    // A history nobody could read leaves no rows, so there is nothing to draw —
    // which is still not "your first settlement has yet to happen".
    const data = liveDashboard({ activity: null });
    expect(data.stats.settledOutsideHistory).toBe(true);
    expect(data.chart).toBeNull();

    // …and through the adapter that is an empty curve, which the chart draws as a band.
    expect(toDashboardMock(data, { complete: false }).curve).toEqual([]);
    const html = renderToStaticMarkup(createElement(PensionChart, { now: "2026-09-16T12:00:00.000Z", curve: [], settledOutsideHistory: true }));
    expect(html).not.toContain(LIVE_COPY.chartEmpty);
    expect(html).toContain(LIVE_COPY.chartOutsideHistory);
  });

  /**
   * AND IT IS STILL A BAND. The sentence used to be returned bare, dropping the
   * caller's className, so a panel that had reserved a chart's worth of height
   * lost it to one grey line and read as half-built.
   *
   * The band is deliberately SHORTER than the drawn chart — the complaint was
   * empty space, and a full-height dashed box is empty space with a border
   * round it. `cn` resolving "h-64 sm:h-72" down to "h-28 sm:h-28" is the
   * mechanism, and BOTH breakpoints must go: a bare h-28 would leave sm:h-72
   * standing and the band would spring back on every screen over 640px.
   */
  it("keeps a sized band instead of collapsing to one line, at both breakpoints", () => {
    const html = renderToStaticMarkup(createElement(PensionChart, { now: "2026-09-16T12:00:00.000Z", curve: [], settledOutsideHistory: true, className: "h-64 w-full sm:h-72" }));
    expect(html).toContain("border-dashed");
    expect(html).toContain("h-28");
    expect(html).toContain("sm:h-28");
    expect(html).not.toContain("h-64");
    expect(html).not.toContain("sm:h-72");
  });

  /**
   * A LEVEL WINDOW IS TRUE AND MUST NOT SHOUT. recharts' default [0, 'auto']
   * domain fills a one-value series to the baseline, so a week in which nothing
   * settled was painted as a solid block of green the height of the card.
   */
  it("draws a window with no settlement in it as a rule, not as a filled area", () => {
    const flat = [
      { date: new Date(NOW_MS - 86_400_000).toISOString().slice(0, 10), total: 3.66 },
      { date: new Date(NOW_MS).toISOString().slice(0, 10), total: 3.66 },
    ];
    const html = renderToStaticMarkup(createElement(PensionChart, { now: "2026-09-16T12:00:00.000Z", curve: flat, settledOutsideHistory: true, className: "h-64 w-full sm:h-72" }));
    // The figure is on screen, and the caption still says why the line is level.
    expect(html).toContain("$3.66");
    expect(html).toContain(LIVE_COPY.chartFlat);
    // No chart at all: there is nothing for one to plot.
    expect(html).not.toContain("recharts");
  });
});

describe("a settlement that landed between the snapshot and the page", () => {
  it("is not announced as missing while the feed is listing it", () => {
    // The hook reads the snapshot first and the activity page second, so a
    // settle in between is always newer than snapshot.slot. The model leaves it
    // out of the curve's arithmetic — rightly, lifetimeSaved does not include
    // it yet — and the card used to take that as "no settlement here" and print
    // it over the row.
    const justNow = liveEntry(signature(99), seconds(NOW_MS - 30_000), [settledEvent("36600000")], 99_999);
    const data = liveDashboard({ activity: liveActivity([justNow, ...UPKEEP_PAGE], { nextBefore: signature(16) }) });

    expect(data.stats.settledOutsideHistory).toBe(false);
    expect(data.stats.lastSettlementAt).not.toBeNull();

    const html = card(data);
    expect(html).not.toContain(STATS_COPY.lastSettlementNever);
    expect(html).not.toContain(LIVE_COPY.chartOutsideHistory);
    expect(html).not.toContain(LIVE_COPY.chartFlat);
  });
});

describe("a pension that genuinely has not settled yet", () => {
  it("still says so: the honest branch is kept, not traded for the other one", () => {
    const data = neverSettled();
    expect(data.stats.settledOutsideHistory).toBe(false);
    expect(data.chart).toBeNull();

    const html = card(data);
    expect(html).toContain(LIVE_COPY.chartEmpty);
    expect(html).not.toContain(LIVE_COPY.chartFlat);
    expect(html).not.toContain(LIVE_COPY.chartOutsideHistory);
  });

  it("keeps the wallets it has: the fixture's own link is what the two cases differ by", () => {
    expect(neverSettled().wallets.map((wallet) => wallet.address)).toEqual([WALLET_A]);
  });
});
