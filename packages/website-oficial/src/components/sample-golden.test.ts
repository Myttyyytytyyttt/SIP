// THE SAMPLE, FROZEN (10-09). /?mode=mock is what the landing's app-loop video
// was recorded from, so every live-only behaviour the live page gains enters
// these components through an OPTIONAL prop the sample never passes — and these
// goldens are how a change that forgot that fails in the same run as everything
// else, before anyone has to diff a screenshot.
//
// WHEN THEY WERE TAKEN: once, in the live page's groundwork step (A0), AFTER its
// motion gates — `motion-safe:animate-pulse` on Skeleton and
// `motion-reduce:transition-none` on Progress change class strings the sample
// renders, though not a single pixel at default motion (what the 0-px
// screenshot diff each phase runs is there to prove). From then on they are
// frozen: a diff here is a change to the sample, and it is reviewed as one,
// never refreshed with `-u` to make a run green.
//
// renderToString, NOT renderToStaticMarkup: the static renderer glues adjacent
// text nodes together, so splitting one text run into two nodes — which once
// moved the sample's glyphs by a sub-pixel — would pass unseen. renderToString
// marks every seam with `<!-- -->`, so that change shows here too.
//
// The props are MockBody's own (dashboard-shell.tsx), from the sample's own
// data: the sample as a visitor gets it, not a fixture that resembles it.

import { Fragment, createElement, type ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ActivityRow } from "@/components/activity-row";
import { DashboardMain, PENSION_SLOT, RULE_SLOT } from "@/components/dashboard-main";
import { DashboardSource } from "@/components/DashboardSource";
import { LiveLoading } from "@/components/live/LiveStates";
import { PensionHoldings } from "@/components/pension-holdings";
import { PensionPanel } from "@/components/pension-panel";
import { PensionStats } from "@/components/pension-stats";
import { SavingsRulePanel } from "@/components/savings-rule-panel";
import { SavingsStrip } from "@/components/savings-strip";
import { StripChip } from "@/components/strip-chip";
import { Sheet } from "@/components/ui/sheet";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WalletActivity } from "@/components/wallet-activity";
import { MODE_COPY } from "@/lib/live-copy";
import { mock } from "@/mocks";

const { now, wallet, rule, stats, curve, days, holdings, trades, activity } = mock;

/** One tag per line, so a reviewer reads the diff of a golden rather than one 40 kB line. Nothing is dropped: only a newline goes in. */
const html = (element: ReactElement): string => renderToString(createElement(TooltipProvider, null, element)).replaceAll("><", ">\n<") + "\n";

/** The golden beside this file, by name. */
const golden = (name: string): string => `./__golden__/${name}.html`;

/** The sample's notice, as MockBody puts it over the page. */
const source = createElement(DashboardSource, { source: "mock", notice: MODE_COPY.sample });

describe("the sample's markup is frozen", () => {
  it("has the sample to render, so a reseeded or emptied dataset cannot make this pass by drawing nothing", () => {
    expect(trades.length).toBeGreaterThan(1);
    expect(activity.length).toBeGreaterThan(1);
    expect(holdings.length).toBeGreaterThan(0);
  });

  it("DashboardSource, with the sample's notice and the keyless one", async () => {
    await expect(html(source)).toMatchFileSnapshot(golden("dashboard-source"));
    await expect(html(createElement(DashboardSource, { source: "mock", notice: MODE_COPY.keyless }))).toMatchFileSnapshot(golden("dashboard-source-keyless"));
  });

  it("SavingsStrip", async () => {
    await expect(html(createElement(SavingsStrip, { trades, rule, now }))).toMatchFileSnapshot(golden("savings-strip"));
  });

  it("StripChip, the newest and the one after it", async () => {
    await expect(html(createElement(StripChip, { trade: trades[0]!, now, newest: true }))).toMatchFileSnapshot(golden("strip-chip-newest"));
    await expect(html(createElement(StripChip, { trade: trades[1]!, now }))).toMatchFileSnapshot(golden("strip-chip"));
  });

  it("SavingsRulePanel", async () => {
    await expect(html(createElement(SavingsRulePanel, { rule, stats, activity, now, className: RULE_SLOT }))).toMatchFileSnapshot(golden("savings-rule-panel"));
  });

  it("PensionPanel, chart and all", async () => {
    await expect(html(createElement(PensionPanel, { stats, curve, holdings, days, rule, now, trades, className: PENSION_SLOT }))).toMatchFileSnapshot(golden("pension-panel"));
  });

  it("PensionStats and PensionHoldings, as the panel mounts them", async () => {
    await expect(html(createElement(PensionStats, { stats, days, now, ...(rule.mode === undefined ? {} : { mode: rule.mode }) }))).toMatchFileSnapshot(golden("pension-stats"));
    await expect(html(createElement(PensionHoldings, { holdings, rule, stats }))).toMatchFileSnapshot(golden("pension-holdings"));
  });

  it("WalletActivity, in the aside and in the header's sheet", async () => {
    const onManageWallets = () => undefined;
    await expect(
      html(createElement(WalletActivity, { wallet, activity, now, className: "sticky top-14 h-[calc(100dvh-3.5rem)]", onManageWallets })),
    ).toMatchFileSnapshot(golden("wallet-activity"));
    // THE SHEET'S OWN PARTS ONLY: its id, its class, and the SheetClose around
    // Manage wallets (which needs its sheet around it). The rows are the same
    // component with the same props, frozen in full just above; a second
    // half-megabyte copy of them would only make this diff harder to read.
    await expect(
      html(
        createElement(
          Sheet,
          null,
          createElement(WalletActivity, { wallet, activity: activity.slice(0, 3), now, id: "activity-sheet", className: "min-h-0 flex-1", onManageWallets, inSheet: true }),
        ),
      ),
    ).toMatchFileSnapshot(golden("wallet-activity-sheet"));
  });

  it("ActivityRow, one of each kind the sample holds, as the feed's first row and as a later one", async () => {
    const kinds = new Set<string>();
    const rows = activity.filter((event) => !kinds.has(event.kind) && kinds.add(event.kind));
    expect(rows.length).toBeGreaterThan(1);
    const markup = rows.map((event, index) => html(createElement(ActivityRow, { event, now, first: index === 0, order: index }))).join("");
    await expect(markup).toMatchFileSnapshot(golden("activity-row"));
  });

  it("DashboardMain, composed exactly as the sample's pension page", async () => {
    await expect(
      html(
        createElement(DashboardMain, {
          top: source,
          strip: createElement(SavingsStrip, { trades, rule, now }),
          cards: createElement(
            Fragment,
            null,
            createElement(SavingsRulePanel, { rule, stats, activity, now, className: RULE_SLOT }),
            createElement(PensionPanel, { stats, curve, holdings, days, rule, now, trades, className: PENSION_SLOT }),
          ),
        }),
      ),
    ).toMatchFileSnapshot(golden("dashboard-main"));
  });

  it("LiveLoading with no props: the frame /?mode=mock shows before Privy answers", async () => {
    await expect(html(createElement(LiveLoading))).toMatchFileSnapshot(golden("live-loading"));
  });
});
