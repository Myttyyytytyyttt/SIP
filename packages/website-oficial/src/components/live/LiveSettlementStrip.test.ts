// A chip describes the settlement it opens — not the vault's mode today.
//
// set_policy_v2 takes a mode as an argument and validate_policy accepts either,
// so a vault can be switched from any client. The rate on a chip was already
// the event's own (event.bps) while the measure beside it came from the vault,
// so one switch relabelled a whole history — and made the strip contradict the
// feed's row for the very same transaction.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { partsOf } from "@/components/live/LiveActivityRow";
import { LiveSettlementStrip, chipDetail, type SettledEvent } from "@/components/live/LiveSettlementStrip";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ACTIVITY_COPY } from "@/lib/live-copy";

import { WALLET_A, liveDashboard } from "../../../test/fixtures/live-dashboard";

const OLDER = { busy: false, retryAt: null, message: null, complete: false } as const;

/** The strip as the body mounts it. `settledOutsideHistory` is the caller's fact, not the rows'. */
function render(input: { readonly data: ReturnType<typeof liveDashboard>; readonly settledOutsideHistory?: boolean; readonly complete?: boolean }): string {
  return renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(LiveSettlementStrip, {
        rows: input.data.rows,
        vault: input.data.vault,
        now: new Date(input.data.nowMs).toISOString(),
        labelOf,
        settledOutsideHistory: input.settledOutsideHistory ?? false,
        older: { ...OLDER, complete: input.complete ?? false },
        onLoadOlder: () => undefined,
        nowMs: input.data.nowMs,
      }),
    ),
  );
}

const MAX_CONTRIBUTION = 60_000_000n;
const labelOf = (wallet: string | null): string => (wallet === WALLET_A ? "Trading wallet 1" : ACTIVITY_COPY.someWallet);

/** A settlement carrying its OWN mode: 1 volume, 0 profit, with that mode's rate. */
const settled = (mode: number): SettledEvent =>
  ({
    kind: "settled",
    wallet: WALLET_A,
    mode,
    baseLamports: "500000000",
    bps: mode === 1 ? 200 : 2_000,
    owed: "60000000",
    paid: "60000000",
    capped: false,
    settlementNonce: "0",
    linkEpoch: "12",
    sessionStartSlot: "200",
    sessionEndSlot: "220",
  }) as SettledEvent;

const detailOf = (mode: number): string => chipDetail({ event: settled(mode), labelOf, maxContribution: MAX_CONTRIBUTION, when: "4m ago" });

describe("what a chip says that settlement measured", () => {
  it("says volume for a VOLUME settlement, whatever the vault measures now", () => {
    const detail = detailOf(1);
    expect(detail).toContain(ACTIVITY_COPY.measureVolume);
    expect(detail).not.toContain(ACTIVITY_COPY.measureProfit);
  });

  it("says profit for a PROFIT settlement", () => {
    const detail = detailOf(0);
    expect(detail).toContain(ACTIVITY_COPY.measureProfit);
    expect(detail).not.toContain(ACTIVITY_COPY.measureVolume);
  });

  it("agrees with the same transaction's row in the feed, which reads the same field", () => {
    for (const mode of [0, 1]) {
      const measure = mode === 1 ? ACTIVITY_COPY.measureVolume : ACTIVITY_COPY.measureProfit;
      // partsOf is what the feed row renders from.
      expect(partsOf(settled(mode), labelOf, MAX_CONTRIBUTION).detail).toContain(measure);
      expect(detailOf(mode)).toContain(measure);
    }
  });

  it("quotes the settlement's own rate beside its own measure", () => {
    expect(detailOf(1)).toContain(`2 % of 0.5 SOL ${ACTIVITY_COPY.measureVolume}`);
    expect(detailOf(0)).toContain(`20 % of 0.5 SOL ${ACTIVITY_COPY.measureProfit}`);
  });
});

describe("the strip still draws what it drew", () => {
  it("shows a chip per settlement, with what it put aside", () => {
    expect(render({ data: liveDashboard() })).toContain("+0.06 SOL");
  });
});

/**
 * THE BAND IS NOT THE CHIPS. A settlement the chain records and this page has
 * not read is the one case where an empty strip was hiding a fact and a
 * control: the rate badge is about the vault today, and "Load older" is the
 * one press that fills the strip, the curve and the Biggest tile at once.
 * Returning null there took the whole top of the main column with it.
 */
describe("a settlement the loaded history does not hold", () => {
  const noRows = () => liveDashboard({ activity: null });

  it("keeps the band, with the rate badge and a way to fetch the settlement", () => {
    const html = render({ data: noRows(), settledOutsideHistory: true });
    expect(html).toContain("20 %");
    expect(html).toContain(ACTIVITY_COPY.loadOlder);
  });

  it("says nothing about the history there: the chart and the tile already do", () => {
    const html = render({ data: noRows(), settledOutsideHistory: true });
    expect(html).not.toContain("loaded history");
    // "last 0 settlements" is not a fact worth a line.
    expect(html).not.toContain("last 0");
  });

  it("drops the button once the history reaches the beginning: there is nothing older to ask for", () => {
    const html = render({ data: noRows(), settledOutsideHistory: true, complete: true });
    expect(html).toContain("20 %");
    expect(html).not.toContain(ACTIVITY_COPY.loadOlder);
  });

  it("draws no band at all when nothing has ever settled", () => {
    expect(render({ data: noRows(), settledOutsideHistory: false })).toBe("");
  });
});
