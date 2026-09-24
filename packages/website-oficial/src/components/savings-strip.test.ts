// The strip across the top — the sample's own, drawing a live pension's
// settlements through the adapter. What came with it from the live strip:
//
// A CHIP DESCRIBES THE SETTLEMENT IT OPENS, not the vault's mode today.
// set_policy_v2 takes a mode as an argument, so a vault can be switched from
// any client; a chip that took its measure from the vault would relabel a whole
// history on the day it was switched, and contradict the feed's row for the
// very same transaction.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SavingsStrip } from "@/components/savings-strip";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ACTIVITY_COPY, STATS_COPY } from "@/lib/live-copy";
import { toDashboardMock } from "@/lib/live-mock";
import type { LiveDashboard, VaultEventJson } from "@/lib/live-types";

import { NOW_MS, liveActivity, liveDashboard, liveEntry, seconds, settledEvent, signature } from "../../test/fixtures/live-dashboard";

/** The strip as LiveBody mounts it. `settledOutsideHistory` is the caller's fact, not the rows'. */
function render(input: { readonly data: LiveDashboard; readonly settledOutsideHistory?: boolean; readonly complete?: boolean; readonly available?: boolean }): string {
  const page = toDashboardMock(input.data, { complete: input.complete ?? false });
  return renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(SavingsStrip, {
        trades: page.trades,
        rule: page.rule,
        now: page.now,
        live: {
          settledOutsideHistory: input.settledOutsideHistory ?? input.data.stats.settledOutsideHistory,
          loadOlder: { busy: false, retryIn: null, complete: input.complete ?? false, available: input.available ?? true, onClick: () => undefined },
        },
      }),
    ),
  );
}

/** One settlement carrying its OWN mode: 1 volume at 2 %, 0 profit at 20 %. */
const oneSettlement = (mode: number): LiveDashboard =>
  liveDashboard({
    activity: liveActivity([
      liveEntry(signature(3), seconds(NOW_MS - 3_600_000), [{ ...settledEvent("60000000"), mode, bps: mode === 1 ? 200 : 2_000 } as VaultEventJson]),
    ]),
  });

const chipDetail = (mode: number): string => toDashboardMock(oneSettlement(mode), { complete: false }).trades[0]!.detail!;

describe("what a chip says that settlement measured", () => {
  it("says volume for a VOLUME settlement, whatever the vault measures now", () => {
    // The fixture's vault measures profit.
    expect(chipDetail(1)).toContain(ACTIVITY_COPY.measureVolume);
    expect(chipDetail(1)).not.toContain(ACTIVITY_COPY.measureProfit);
  });

  it("says profit for a PROFIT settlement", () => {
    expect(chipDetail(0)).toContain(ACTIVITY_COPY.measureProfit);
    expect(chipDetail(0)).not.toContain(ACTIVITY_COPY.measureVolume);
  });

  it("agrees with the same transaction's row in the feed, which reads the same field", () => {
    for (const mode of [0, 1]) {
      const page = toDashboardMock(oneSettlement(mode), { complete: false });
      const row = page.activity.find((event) => event.kind === "saved");
      expect(row?.kind === "saved" && page.trades[0]!.detail!.endsWith(row.basis)).toBe(true);
    }
  });

  it("quotes the settlement's own rate beside its own measure", () => {
    expect(chipDetail(1)).toMatch(new RegExp(`^Trading wallet 1 · 2 % of \\$[\\d.,]+ ${ACTIVITY_COPY.measureVolume}$`));
    expect(chipDetail(0)).toMatch(new RegExp(`^Trading wallet 1 · 20 % of \\$[\\d.,]+ ${ACTIVITY_COPY.measureProfit}$`));
  });
});

describe("the chips", () => {
  it("show what each settlement put aside, in today's dollars, and open the transaction", () => {
    const html = render({ data: liveDashboard() });
    expect(html).toContain("+$6.00");
    expect(html).toMatch(/href="https:\/\/solscan\.io\/tx\//);
    // The badge names the rule, as the owner asked: "Profit: 20%".
    expect(html).toContain(STATS_COPY.stripModeProfit("20%"));
    // The average counts what the chips are.
    expect(html).toContain("/ settlement");
  });

  it("say when the rule's ceiling cut one short", () => {
    // The fixture's settlement owed 0.1 SOL and paid the 0.06 ceiling.
    expect(render({ data: liveDashboard() })).toContain("capped at");
  });

  it("never let a settlement that moved something read as zero", () => {
    // 4,000 lamports: a small fraction of a cent at any SOL price this side of absurd.
    const tiny = liveEntry(signature(9), seconds(NOW_MS - 600_000), [settledEvent("4000")]);
    const html = render({ data: liveDashboard({ activity: liveActivity([tiny]) }) });
    // Escaped, because this is the rendered markup: "<" is "&lt;" in it.
    expect(html).toContain("+&lt;$0.01");
    expect(html).not.toContain("+$0.00");
  });
});

/**
 * THE BAND IS NOT THE CHIPS. A settlement the chain records and this page has
 * not read is the one case where an empty strip was hiding a fact and a
 * control: the rate badge is about the vault today, and "Load older" is the one
 * press that fills the strip, the curve and the Biggest tile at once.
 */
describe("a settlement the loaded history does not hold", () => {
  const noRows = () => liveDashboard({ activity: null });

  it("keeps the band, with the rate badge and a way to fetch the settlement", () => {
    const html = render({ data: noRows(), settledOutsideHistory: true });
    expect(html).toContain(STATS_COPY.stripModeProfit("20%"));
    expect(html).toContain(ACTIVITY_COPY.loadOlder);
  });

  it("says nothing about the history there: the chart and the tiles already do", () => {
    const html = render({ data: noRows(), settledOutsideHistory: true });
    expect(html).not.toContain("loaded history");
    // "last 0" is not a fact worth a line.
    expect(html).not.toContain("last <");
  });

  it("drops the button once the history reaches the beginning: there is nothing older to ask for", () => {
    const html = render({ data: noRows(), settledOutsideHistory: true, complete: true });
    expect(html).toContain(STATS_COPY.stripModeProfit("20%"));
    expect(html).not.toContain(ACTIVITY_COPY.loadOlder);
  });

  it("draws no Load older before a head page has named an older one: it would press on nothing", () => {
    const html = render({ data: noRows(), settledOutsideHistory: true, available: false });
    expect(html).toContain(STATS_COPY.stripModeProfit("20%"));
    expect(html).not.toContain(ACTIVITY_COPY.loadOlder);
  });

  it("draws no band at all when nothing has ever settled", () => {
    expect(render({ data: noRows(), settledOutsideHistory: false })).toBe("");
  });
});
