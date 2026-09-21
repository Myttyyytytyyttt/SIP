// A HISTORY NOBODY COULD READ MUST NOT BE DRAWN AS ONE WITH NOTHING IN IT.
//
// The honest branch — "Activity could not be read just now", with a Retry — and
// the `activityUnreadable` prop on both columns already existed. Nothing passed
// the prop, so the branch was dead for every real failure and a 429 on the
// activity page drew "No activity yet" beside a Settlements tile reading 3.
//
// This is the test that keeps it WIRED. It renders the frame the way the shell
// does, so a prop dropped anywhere between the hook and the feed fails here
// rather than in front of somebody looking at their own pension.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The frame's two contexts, stubbed: this test is about what the body draws,
// not about Privy or the wallets modal.
vi.mock("@/app/providers", () => ({ useSolanaConfigOrNull: () => null }));
vi.mock("@/components/wallets-host", () => ({ useWalletsOpener: () => null }));
// recharts draws on a ResizeObserver, which node has none of.
vi.mock("@/components/live/LiveSavedChart", () => ({ LiveSavedChart: () => createElement("div", null, "LIVECHART") }));

import { LiveBody } from "@/components/live/LiveBody";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ACTIVITY_COPY, LIVE_COPY, STATS_COPY } from "@/lib/live-copy";
import type { LiveDashboard } from "@/lib/live-types";

import { NOW_MS, OWNER, liveActivity, liveDashboard, liveEntry, liveSnapshot, seconds, signature } from "../../../test/fixtures/live-dashboard";

const older = { busy: false, retryAt: null, message: null, complete: false };

/**
 * A pension with settlements on chain and NO rows loaded — exactly what a failed
 * activity read leaves behind: the snapshot answered, the history did not.
 */
const settledButNoRows = (): LiveDashboard => liveDashboard({ activity: null });

function render(input: { readonly view?: "pension" | "activity"; readonly activityUnreadable: boolean; readonly data?: LiveDashboard }): string {
  return renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(LiveBody, {
        view: input.view ?? "pension",
        data: input.data ?? settledButNoRows(),
        stale: null,
        pensionKey: OWNER,
        control: null,
        account: null,
        older,
        onRefresh: vi.fn(),
        onLoadOlder: vi.fn(),
        nowMs: NOW_MS,
        activityUnreadable: input.activityUnreadable,
      }),
    ),
  );
}

describe("an activity read that failed", () => {
  it("says so in the sidebar, with a retry — never 'No activity yet'", () => {
    const html = render({ activityUnreadable: true });
    expect(html).toContain(ACTIVITY_COPY.unreadableNow);
    expect(html).not.toContain(ACTIVITY_COPY.empty);
    expect(html).toContain(LIVE_COPY.retry);
  });

  it("says so on /activity too, which follows the same rule", () => {
    const html = render({ view: "activity", activityUnreadable: true });
    expect(html).toContain(ACTIVITY_COPY.unreadableNow);
    expect(html).not.toContain(ACTIVITY_COPY.empty);
  });

  /**
   * AND IT KEEPS WHAT IT ALREADY HAD. The hook holds on to the rows a failed
   * poll could not refresh; the feed used to throw every one of them away and
   * draw a grey sentence in a full-height column, while the footer underneath
   * went on counting them — "3 transactions" under a feed showing none.
   */
  it("keeps the rows already loaded, with the note above them", () => {
    const data = liveDashboard();
    expect(data.rows.length).toBeGreaterThan(0);

    const html = render({ data, activityUnreadable: true });
    expect(html).toContain(ACTIVITY_COPY.unreadableNow);
    // The settlement that was already on screen is still on screen.
    expect(html).toContain("+0.06 SOL");
  });

  it("no longer contradicts the tile beside it", () => {
    // The chain says three settlements; the history could not be read. The page
    // may not say both "3 settlements" and "no activity yet".
    const data = settledButNoRows();
    expect(data.stats.settlementsLifetime).toBe(3n);

    const html = render({ data, activityUnreadable: true });
    expect(html).toContain(STATS_COPY.settlements);
    expect(html).not.toContain(ACTIVITY_COPY.empty);
  });
});

/**
 * A PAGE WHOSE EVERY TRANSACTION WAS KEEPER UPKEEP is the ordinary case on
 * this vault — twelve of fifteen on 2026-09-19 — and the feed printed "No
 * activity yet" over all fifteen while the footnote underneath counted them.
 * They were not hidden, they were discarded: nothing could open the count.
 */
describe("a page the feed has nothing to list from", () => {
  const allUpkeep = (): LiveDashboard => {
    const upkeep = { kind: "upkeep" } as unknown as LiveDashboard["rows"][number]["event"];
    const entries = Array.from({ length: 15 }, (_, index) => liveEntry(signature(index + 1), seconds(NOW_MS - (index + 1) * 600_000), [upkeep]));
    return liveDashboard({ activity: liveActivity(entries, { nextBefore: signature(40) }) });
  };

  it("keeps the rows instead of discarding them", () => {
    const data = allUpkeep();
    expect(data.rows).toHaveLength(0);
    expect(data.hiddenRows).toHaveLength(15);
    expect(data.hiddenUpkeep).toBe(15);
  });

  it("no longer claims there is no history over fifteen transactions it is holding", () => {
    const html = render({ data: allUpkeep(), activityUnreadable: false });
    expect(html).not.toContain(ACTIVITY_COPY.empty);
    expect(html).toContain(ACTIVITY_COPY.onlyHidden);
  });

  it("offers to show them, and says so to a screen reader", () => {
    const html = render({ data: allUpkeep(), activityUnreadable: false });
    expect(html).toContain(ACTIVITY_COPY.hiddenUpkeep("15"));
    expect(html).toContain(ACTIVITY_COPY.showHidden);
    expect(html).toContain('aria-expanded="false"');
  });

  /**
   * The aside, the header's sheet and /activity each mount a feed, so a
   * constant panel id would point every control at the first one's rows.
   * (The sheet's own copy is not in this markup: Radix mounts it on open.)
   */
  it("gives the disclosure a panel id of its FEED's, not a shared one", () => {
    expect(render({ data: allUpkeep(), activityUnreadable: false })).toContain('id="activity-aside-hidden"');
    expect(render({ view: "activity", data: allUpkeep(), activityUnreadable: false })).toContain('id="activity-page-hidden"');
  });

  /** The stage's own sentence is about something else, and still wins. */
  it("still says there is no vault when there is none", () => {
    const html = render({ view: "activity", data: noVault(), activityUnreadable: false });
    expect(html).not.toContain(ACTIVITY_COPY.onlyHidden);
  });
});

describe("a history that really is empty", () => {
  it("still says what will appear there, and never claims a failure", () => {
    const html = render({ activityUnreadable: false });
    expect(html).toContain(ACTIVITY_COPY.empty);
    expect(html).not.toContain(ACTIVITY_COPY.unreadableNow);
  });

  it("…on /activity as well", () => {
    const html = render({ view: "activity", activityUnreadable: false });
    expect(html).toContain(ACTIVITY_COPY.empty);
    expect(html).not.toContain(ACTIVITY_COPY.unreadableNow);
  });
});

/** A pension key on its very first visit: no vault, no wallet, no link, no policy. */
const noVault = (): LiveDashboard =>
  liveDashboard({
    snapshot: liveSnapshot({ vault: { status: "missing", address: "v" }, policy: { status: "missing", address: "p" }, wallets: [] }),
    activity: null,
    privyWallets: [],
  });

describe("/activity before there is a vault", () => {
  it("shows the one thing to do next, not a hero of zeroes", () => {
    const data = noVault();
    expect(data.stage).toBe("no_vault");

    const html = render({ view: "activity", data, activityUnreadable: false });
    expect(html).toContain(LIVE_COPY.noVault.create);

    // The three claims the summary card used to make about a pension nobody has:
    // a total, that total being zero, and a complete history of nothing.
    expect(html).not.toContain(LIVE_COPY.savedSoFar);
    expect(html).not.toContain("0.00 SOL");
    expect(html).not.toContain(ACTIVITY_COPY.complete);
  });

  it("still summarises a pension that DOES exist: the guard is the stage, not the page", () => {
    const html = render({ view: "activity", activityUnreadable: false });
    expect(html).toContain(LIVE_COPY.savedSoFar);
    expect(html).not.toContain(LIVE_COPY.noVault.create);
  });
});

describe("how much of the history is loaded", () => {
  it("is never called complete when no page was read", () => {
    // A vault WITH settlements whose history could not be read: no rows, and
    // `older.complete` false because no head page ever came back. "Complete
    // history" there is a claim about something nobody looked at.
    const html = render({ view: "activity", activityUnreadable: true });
    expect(html).not.toContain(ACTIVITY_COPY.complete);
    expect(html).toContain(LIVE_COPY.unknownFigure);
  });
});
