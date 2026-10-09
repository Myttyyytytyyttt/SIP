// The live column's two new slots (wallet-activity.tsx LiveColumnSlots), on the
// sample's own component: "—" in the bar while no history has been read, and
// the feed's shape under the column's sentence while it is being read. The
// sample passes neither, and its markup is frozen in sample-golden.test.ts.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { WalletActivity, type LiveColumnSlots } from "@/components/wallet-activity";
import { ACTIVITY_COPY } from "@/lib/live-copy";
import { mock } from "@/mocks";

const { now, wallet, activity } = mock;

const slots = (over: Partial<LiveColumnSlots> = {}): LiveColumnSlots => ({
  below: null,
  list: null,
  banner: null,
  hidden: null,
  empty: ACTIVITY_COPY.readingHistory,
  inSheet: false,
  ...over,
});

const draw = (events: typeof activity, live: LiveColumnSlots): string =>
  renderToStaticMarkup(createElement(TooltipProvider, null, createElement(WalletActivity, { wallet, activity: events, now, live })));

/** The bar under the feed, as a person reads it. */
const bar = (html: string): string => (html.match(/border-t px-4 py-2\.5 text-xs text-muted-foreground">([\s\S]*?)<\/div>/)?.[1] ?? "").replace(/<[^>]*>/g, "");

/** A stand-in for the skeleton: this is about where the slot goes, not what it draws (FeedSkeleton.test.ts). */
const marker = createElement("i", { "data-skeleton": "" });

describe("the bar's counts", () => {
  it("are '—' while no history has been read, never 0", () => {
    expect(bar(draw([], slots({ countsUnknown: true })))).toBe("— events— settlements");
  });

  it("are the rows shown otherwise, as they always were", () => {
    expect(bar(draw([], slots()))).toBe("0 events0 settlements");
    expect(bar(draw([], slots({ countsUnknown: false })))).toBe("0 events0 settlements");
  });
});

describe("the feed's shape while the history is read", () => {
  it("sits under the column's sentence, never in its place", () => {
    const html = draw([], slots({ skeleton: marker }));
    const words = ACTIVITY_COPY.readingHistory.replaceAll("'", "&#x27;");
    expect(html).toContain(`${words}</p><i data-skeleton=""></i>`);
  });

  it("is not drawn over rows: the rows are the history", () => {
    expect(draw(activity.slice(0, 2), slots({ skeleton: marker }))).not.toContain("data-skeleton");
  });

  it("changes nothing when it is not passed", () => {
    expect(draw([], slots({ skeleton: null }))).toBe(draw([], slots()));
  });
});
