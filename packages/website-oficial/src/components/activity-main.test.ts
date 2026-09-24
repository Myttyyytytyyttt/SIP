// /activity in the sample (owner, 09-24): the history full width, in the
// sidebar's own rows, with totals over it and chips to narrow it — never the
// pension page again under another tab.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ACTIVITY_PAGE_ROWS, ActivityMain, groupOf } from "@/components/activity-main";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ACTIVITY_COPY } from "@/lib/live-copy";
import { mock } from "@/mocks";
import type { ActivityEvent, OtherEvent } from "@/mocks/types";

const render = (activity: readonly ActivityEvent[], summary = [{ label: "Saved so far", value: "$10.00" }]): string =>
  renderToStaticMarkup(createElement(TooltipProvider, null, createElement(ActivityMain, { activity, now: mock.now, summary })));

const BASE = { id: "x", at: "2026-09-23T11:00:00.000Z", txHash: "5nStUz377UpWNdnPDiex1111111111111111111111111" };
const other = (icon: OtherEvent["icon"]): ActivityEvent => ({ ...BASE, id: icon, kind: "other", title: icon, sub: null, amount: null, icon });

/** The chips as rendered, in order. */
const chips = (html: string): string[] => [...html.matchAll(/aria-pressed="(?:true|false)"[^>]*>([^<]+)</g)].map((m) => m[1]!);

describe("which chip a row belongs to", () => {
  it("files money put aside under Savings, the pension buying under Investing, money out under Withdrawals", () => {
    expect(groupOf({ ...BASE, kind: "trade", tradeId: "t", symbol: "SOL", side: "buy", notionalUsd: 1, savedUsd: 1, rateBps: 200 })).toBe("savings");
    expect(groupOf({ ...BASE, kind: "saved", from: "w", basis: "b", savedUsd: 1 })).toBe("savings");
    expect(groupOf(other("receive"))).toBe("savings");
    expect(groupOf({ ...BASE, kind: "invested", symbol: "SPYx", shares: 1, priceUsd: 1, amountUsd: 1 })).toBe("investing");
    for (const icon of ["convert", "wrap", "policy"] as const) expect(groupOf(other(icon)), icon).toBe("investing");
    expect(groupOf(other("withdraw"))).toBe("withdrawals");
    for (const icon of ["rule", "link", "unlink", "vault", "upkeep", "failed", "other"] as const) expect(groupOf(other(icon)), icon).toBe("other");
    expect(groupOf({ ...BASE, kind: "deposit", amountUsd: 1 })).toBe("other");
  });
});

describe("the sample's activity page", () => {
  const html = render(mock.activity);

  it("draws the newest rows a page at a time, in the sidebar's own row design, and says how many are left", () => {
    expect([...html.matchAll(/data-activity-row=""/g)]).toHaveLength(Math.min(ACTIVITY_PAGE_ROWS, mock.activity.length));
    expect(mock.activity.length).toBeGreaterThan(ACTIVITY_PAGE_ROWS);
    expect(html).toMatch(new RegExp(`Show more · <span[^>]*>${mock.activity.length - ACTIVITY_PAGE_ROWS}</span> left`));
    // The count under the list is the whole list's, not the page's.
    expect(html).toMatch(new RegExp(`>${mock.activity.length}</span> events`));
    // The feed's tiles, not the old grey glyphs.
    expect(html).toMatch(/relative flex size-8[^"]*emerald/);
  });

  it("groups the rows by day, newest first, each day a heading — not a landmark", () => {
    expect(html).toMatch(/<h3[^>]*>Today<\/h3>/);
    expect(html).not.toContain("<section");
  });

  it("offers a chip only for a kind the list holds", () => {
    expect(chips(html)).toEqual([ACTIVITY_COPY.filterAll, ACTIVITY_COPY.filterSavings, ACTIVITY_COPY.filterInvesting, ACTIVITY_COPY.filterOther]);
    expect(chips(render([other("withdraw")]))).toEqual([ACTIVITY_COPY.filterAll, ACTIVITY_COPY.filterWithdrawals]);
  });

  it("puts its totals over the list", () => {
    expect(html).toContain("Saved so far");
    expect(html).toContain("$10.00");
  });

  it("gives its rows a feed of their own, apart from the sidebar's", () => {
    expect(html).toContain('id="activity-page" data-activity-feed=""');
  });

  it("says so when there is nothing to list, rather than an empty box", () => {
    expect(render([])).toContain(ACTIVITY_COPY.noneInFilter);
  });
});
