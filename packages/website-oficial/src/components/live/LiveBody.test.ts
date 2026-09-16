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

import { NOW_MS, OWNER, liveDashboard } from "../../../test/fixtures/live-dashboard";

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
