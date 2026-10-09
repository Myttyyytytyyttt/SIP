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
// The rule card's gear signs through Privy's wallet hooks, which these tests do
// not provide; its own signing is LiveRulePanel.test.ts's subject. Here it is the
// shared card with a closed gear, so the page's markup stays real.
vi.mock("@/components/live/LiveRulePanel", async () => {
  const { SavingsRulePanel } = await import("@/components/savings-rule-panel");
  const closed = { open: false, onOpen: () => undefined, attention: false };
  return {
    LiveRulePanel: (props: Parameters<typeof SavingsRulePanel>[0]) => createElement(SavingsRulePanel, { ...props, settings: closed }),
  };
});
vi.mock("@/components/pension-chart", () => ({ PensionChart: () => createElement("div", null, "LIVECHART") }));

import { LiveBody, countsUnknownOf, staleNote } from "@/components/live/LiveBody";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { LiveOlder, LiveStale } from "@/hooks/use-live-dashboard";
import { ACTIVITY_COPY, LIVE_COPY, STATS_COPY } from "@/lib/live-copy";
import type { LiveDashboard, VaultEventJson } from "@/lib/live-types";

import { DEFAULT_ENTRIES, NOW_MS, OWNER, liveActivity, liveDashboard, liveEntry, liveSnapshot, seconds, signature } from "../../../test/fixtures/live-dashboard";
import { tickingInRegion } from "../../../test/live-regions";

const older = { busy: false, retryAt: null, message: null, complete: false, available: true };

/**
 * A pension with settlements on chain and NO rows loaded — exactly what a failed
 * activity read leaves behind: the snapshot answered, the history did not.
 */
const settledButNoRows = (): LiveDashboard => liveDashboard({ activity: null });

/** What a person reads: the markup without its tags. A count and its word sit in two spans. */
const seen = (html: string): string => html.replace(/<[^>]*>/g, "");

function render(input: {
  readonly view?: "pension" | "activity";
  readonly activityUnreadable: boolean;
  readonly data?: LiveDashboard;
  readonly stale?: LiveStale | null;
  readonly older?: LiveOlder;
  readonly activityPending?: boolean;
  /** The browser's clock; the payload's own by default. */
  readonly nowMs?: number;
}): string {
  return renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(LiveBody, {
        view: input.view ?? "pension",
        data: input.data ?? settledButNoRows(),
        stale: input.stale ?? null,
        pensionKey: OWNER,
        control: null,
        account: null,
        older: input.older ?? older,
        onRefresh: vi.fn(),
        onLoadOlder: vi.fn(),
        nowMs: input.nowMs ?? NOW_MS,
        activityUnreadable: input.activityUnreadable,
        ...(input.activityPending === undefined ? {} : { activityPending: input.activityPending }),
      }),
    ),
  );
}

describe("an activity read that failed", () => {
  it("says so in the sidebar, with a retry — never 'No activity yet'", () => {
    const html = render({ activityUnreadable: true });
    expect(html).toContain(ACTIVITY_COPY.unreadableNow);
    expect(html).not.toContain(ACTIVITY_COPY.empty);
    // Drawn right after the read that failed, so it counts down the floor
    // before a press can read at once (RetryButton.tsx).
    expect(html).toMatch(/Try again in \d+ s/);
  });

  it("keeps the countdown out of the sentence a screen reader is told about, on both views", () => {
    for (const view of ["pension", "activity"] as const) {
      const html = render({ view, activityUnreadable: true });
      expect(html).toMatch(/Try again in \d+ s/);
      expect(tickingInRegion(html)).toBe(false);
    }
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
    // The settlement that was already on screen is still on screen — in
    // today's dollars, as the owner chose for every amount in the column.
    expect(html).toContain("+$6.00");
  });

  it("no longer contradicts the tile beside it", () => {
    // The chain says three settlements; the history could not be read. The page
    // may not say both "3 settlements" and "no activity yet".
    const data = settledButNoRows();
    expect(data.stats.settlementsLifetime).toBe(3n);

    const html = render({ data, activityUnreadable: true });
    // The sample's "Avg per trade" tile, counting what this chain records.
    expect(seen(html)).toContain("3 settlements");
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

/**
 * THE PENSION KEY IS THE NAVBAR'S, NOT THE COLUMN'S (owner, 09-23): the account
 * chip at the top carries it with its copy button, and the same key under the
 * balance was the same fact twice on one screen.
 */
describe("the column under a linked wallet", () => {
  it("says nothing of the pension key: the navbar already does", () => {
    const html = render({ data: liveDashboard(), activityUnreadable: false });
    expect(html).not.toContain(LIVE_COPY.pensionKey);
  });
});

/**
 * A PAGE WHOSE LAST UPDATE FAILED says as of when, that it keeps trying, and
 * why — and never when it will try next: the next read on its own is the
 * backoff's two to five minutes, and "trying again in 12 s" was the server's
 * retry-after, which nothing kept (G6). /activity says it too (G11).
 */
describe("a page whose last update failed", () => {
  const stale: LiveStale = { message: LIVE_COPY.rateLimited(12), retryAt: NOW_MS + 12_000, since: NOW_MS - 30_000 };
  const asOf = LIVE_COPY.staleAsOf("12:00 UTC");

  it("says as of when, and why, on the pension view", () => {
    const html = render({ data: liveDashboard(), activityUnreadable: false, stale });
    expect(html).toContain(`${asOf} ${LIVE_COPY.rateLimited(null)}`);
    expect(seen(html)).not.toMatch(/trying again|shortly/i);
  });

  it("says the same on /activity, where a stale history used to look current", () => {
    const html = render({ view: "activity", data: liveDashboard(), activityUnreadable: false, stale });
    expect(html).toContain(`${asOf} ${LIVE_COPY.rateLimited(null)}`);
  });

  it("adds that the numbers may be out of date once the failure has stood five minutes", () => {
    const old = { ...stale, since: NOW_MS - 5 * 60_000 };
    expect(render({ data: liveDashboard(), activityUnreadable: false, stale: old })).toContain(LIVE_COPY.staleLong);
    expect(render({ data: liveDashboard(), activityUnreadable: false, stale })).not.toContain(LIVE_COPY.staleLong);
  });

  it("draws no note while the page is current", () => {
    expect(render({ view: "activity", data: liveDashboard(), activityUnreadable: false })).not.toContain(asOf);
  });

  it("names the day the figures are from once that is not today, never a bare clock that reads as minutes old", () => {
    // The last good update at 12:00 UTC on Sep 16; read in this browser the morning after.
    const html = render({ data: liveDashboard(), activityUnreadable: false, stale: { ...stale, since: NOW_MS + 60_000 }, nowMs: NOW_MS + 20 * 3_600_000 });
    expect(html).toContain(LIVE_COPY.staleAsOf("yesterday, 12:00 UTC"));
    expect(html).not.toContain(asOf);
  });
});

describe("the protocol paused for everyone", () => {
  const paused = (): LiveDashboard => ({ ...liveDashboard(), protocolPaused: true });

  it("is said on the pension view, and on /activity too", () => {
    expect(render({ data: paused(), activityUnreadable: false })).toContain(LIVE_COPY.protocolPaused);
    expect(render({ view: "activity", data: paused(), activityUnreadable: false })).toContain(LIVE_COPY.protocolPaused);
    expect(render({ view: "activity", data: liveDashboard(), activityUnreadable: false })).not.toContain(LIVE_COPY.protocolPaused);
  });

  it("is said on /activity even before there is a vault", () => {
    expect(render({ view: "activity", data: { ...noVault(), protocolPaused: true }, activityUnreadable: false })).toContain(LIVE_COPY.protocolPaused);
  });
});

describe("staleNote", () => {
  it("is as of when, then the failure's own words", () => {
    expect(staleNote({ when: "14:32 UTC", message: LIVE_COPY.network, long: false })).toBe(`${LIVE_COPY.staleAsOf("14:32 UTC")} ${LIVE_COPY.network}`);
  });

  it("says the numbers may be out of date once, last, whoever added it first", () => {
    const fromHook = `${LIVE_COPY.network} ${LIVE_COPY.staleLong}`;
    for (const [message, long] of [
      [fromHook, false],
      [fromHook, true],
      [LIVE_COPY.network, true],
    ] as const) {
      const note = staleNote({ when: "14:32 UTC", message, long });
      expect(note.split(LIVE_COPY.staleLong)).toHaveLength(2);
      expect(note.endsWith(LIVE_COPY.staleLong)).toBe(true);
    }
  });

  it("drops an empty reason rather than leaving a gap", () => {
    expect(staleNote({ when: "14:32 UTC", message: "", long: false })).toBe(LIVE_COPY.staleAsOf("14:32 UTC"));
  });
});

describe("an older page that failed", () => {
  it("says to try again on /activity, never that it is being tried", () => {
    const failed = { ...older, retryAt: NOW_MS - 1_000, message: LIVE_COPY.rateLimited(4) };
    const html = render({ view: "activity", data: liveDashboard(), activityUnreadable: false, older: failed });
    expect(html).toContain(ACTIVITY_COPY.olderFailed);
    expect(seen(html)).not.toMatch(/trying again|shortly/i);
  });
});

/**
 * A COUNT NOBODY HAS MADE IS "—", NEVER 0 (10-09, G10). Before a page of the
 * history had been read — still on its way, or failed with nothing loaded —
 * both footers said "0 events · 0 settlements" beside a pension the chain
 * says has settled three times.
 */
describe("a history nobody has read yet", () => {
  /** The words, as React writes them: the apostrophe is escaped. */
  const readingWords = ACTIVITY_COPY.readingHistory.replaceAll("'", "&#x27;");
  /** The column's bar (wallet-activity.tsx), as "<events> events · <n> settlements": "—" or digits. */
  const columnBar = (html: string): string => {
    const bar = html.match(/border-t px-4 py-2\.5 text-xs text-muted-foreground"><span><span[^>]*>([^<]*)<\/span> events<\/span><span><span[^>]*>([^<]*)<\/span> (settlements?)<\/span>/);
    return bar === null ? "" : `${bar[1]} events · ${bar[2]} ${bar[3]}`;
  };
  /** /activity's footer (LiveActivityFeed.tsx FeedFooter), as a person reads it. */
  const pageFooter = (html: string): string => seen(html.match(/<span class="text-xs text-muted-foreground"><span[^>]*>[^<]*<\/span> transactions?[^<]*<span[^>]*>[^<]*<\/span> settlements?<\/span>/)?.[0] ?? "");

  it("says it is reading, with the feed's shape under the words — never in place of them", () => {
    const html = render({ activityUnreadable: false, activityPending: true });
    expect(html).toContain(readingWords);
    expect(html).toContain("data-feed-skeleton");
    expect(html.indexOf(readingWords)).toBeLessThan(html.indexOf("data-feed-skeleton"));
  });

  it("counts '—' in the column's bar, and on /activity's footer", () => {
    expect(columnBar(render({ activityUnreadable: false, activityPending: true }))).toBe("— events · — settlements");
    const activity = render({ view: "activity", activityUnreadable: false, activityPending: true });
    expect(columnBar(activity)).toBe("— events · — settlements");
    expect(pageFooter(activity)).toBe("— transactions · — settlements");
  });

  it("counts '—' when the history failed before a single page was loaded", () => {
    expect(columnBar(render({ activityUnreadable: true }))).toBe("— events · — settlements");
    expect(pageFooter(render({ view: "activity", activityUnreadable: true }))).toBe("— transactions · — settlements");
  });

  it("goes on counting the rows it shows when a later read failed over them", () => {
    expect(columnBar(render({ data: liveDashboard(), activityUnreadable: true }))).toBe("1 events · 1 settlement");
    expect(pageFooter(render({ view: "activity", data: liveDashboard(), activityUnreadable: true }))).toBe("1 transaction · 1 settlement");
  });

  it("draws no skeleton and counts as before once the history has answered", () => {
    const html = render({ data: liveDashboard(), activityUnreadable: false });
    expect(html).not.toContain("data-feed-skeleton");
    expect(columnBar(html)).toBe("1 events · 1 settlement");
    expect(pageFooter(render({ view: "activity", data: liveDashboard(), activityUnreadable: false }))).toBe("1 transaction · 1 settlement");
  });
});

describe("countsUnknownOf", () => {
  it("is unknown while the history is on its way, or failed with nothing loaded — and only then", () => {
    expect(countsUnknownOf({ activityPending: true, activityUnreadable: false, loaded: 0 })).toBe(true);
    expect(countsUnknownOf({ activityPending: false, activityUnreadable: true, loaded: 0 })).toBe(true);
    expect(countsUnknownOf({ activityPending: false, activityUnreadable: true, loaded: 3 })).toBe(false);
    expect(countsUnknownOf({ activityPending: false, activityUnreadable: false, loaded: 0 })).toBe(false);
  });
});

/**
 * THE HEADER'S DOT (10-09, LiveHeartbeat.tsx): before the pension key, on both
 * views, wrapped in by this body so the header itself is not edited — and the
 * dot only, its words its accessible name, never text in the bar (owner).
 */
describe("how fresh the page is", () => {
  const withAccount = (view: "pension" | "activity", stale: LiveStale | null = null): string =>
    renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(LiveBody, {
          view,
          data: liveDashboard(),
          stale,
          pensionKey: OWNER,
          control: null,
          account: createElement("span", { "data-account": "" }),
          older,
          onRefresh: vi.fn(),
          onLoadOlder: vi.fn(),
          nowMs: NOW_MS,
          activityUnreadable: false,
        }),
      ),
    );
  /** The header's markup, which the dot must be in. */
  const header = (html: string): string => html.match(/<header\b[\s\S]*?<\/header>/)?.[0] ?? "";

  it("is a dot in the header, before the account, on both views", () => {
    for (const view of ["pension", "activity"] as const) {
      const bar = header(withAccount(view));
      expect(bar).toContain('data-pulse="fresh"');
      expect(bar.indexOf("data-pulse")).toBeLessThan(bar.indexOf("data-account"));
    }
  });

  it("says nothing in the bar: its words are its name", () => {
    const bar = header(withAccount("pension"));
    expect(bar).toContain(`aria-label="${LIVE_COPY.pulse.updated(LIVE_COPY.pulse.ago(0))}"`);
    expect(seen(bar)).not.toContain(LIVE_COPY.pulse.updated(LIVE_COPY.pulse.ago(0)));
  });

  it("is behind when the last update failed, beside the stale note that announces it", () => {
    const html = withAccount("pension", { message: LIVE_COPY.network, retryAt: null, since: Date.now() });
    expect(header(html)).toContain('data-pulse="behind"');
    expect(seen(header(html))).not.toContain(LIVE_COPY.pulse.behind);
    expect(html).toContain(LIVE_COPY.staleAsOf("12:00 UTC"));
  });
});

describe("what comes and goes in the pension view (10-09, G8)", () => {
  /** Linked, nothing settled yet, an empty history: the wait for the first saving. */
  const waiting = (): LiveDashboard => {
    const fresh = liveSnapshot();
    return liveDashboard({
      snapshot: liveSnapshot({ ...fresh, vault: { ...fresh.vault, state: { ...fresh.vault.state!, lifetimeSaved: "0" } }, wallets: [{ ...fresh.wallets[0]!, link: { ...fresh.wallets[0]!.link, settlementNonce: "0" } }] }),
      activity: liveActivity([]),
    });
  };

  it("passes no strip before the first settlement, so no empty wrapper holds a gap open in the column", () => {
    const data = waiting();
    expect(data.stage).toBe("waiting_first_settlement");
    const html = render({ data, activityUnreadable: false });
    expect(html).not.toContain(`aria-label="${STATS_COPY.settlementStripLabel}"`);
    expect(html).not.toContain('<div class="rise-in"></div>');
  });

  it("draws the strip in a box that can grow in — simply open on the page's first paint", () => {
    const html = render({ data: liveDashboard(), activityUnreadable: false });
    expect(html).toMatch(new RegExp(`<div class="rise-in"><div class="grid [^"]*grid-rows-\\[1fr\\] opacity-100"><div class="min-h-0 min-w-0"><div[^>]*role="group" aria-label="${STATS_COPY.settlementStripLabel}"`));
  });

  it("puts the stage card in one box that grows, swaps and closes, inside the top column's gap", () => {
    const html = render({ data: waiting(), activityUnreadable: false });
    expect(html).toMatch(/<div class="grid [^"]*grid-rows-\[1fr\] opacity-100 mt-0"><div class="min-h-0 min-w-0"><div><div><div data-slot="card"[^>]*><div[^>]*><div[^>]*>Waiting for the first settlement</);
  });

  it("draws /activity's own stage card plainly: it stands in a page of its own, not a column that moves", () => {
    const noVault = liveDashboard({ snapshot: liveSnapshot({ vault: { status: "missing", address: "v" }, policy: { status: "missing", address: "p" }, wallets: [] }), activity: null, privyWallets: [] });
    const html = render({ view: "activity", data: noVault, activityUnreadable: false });
    expect(html).toContain(LIVE_COPY.noVault.title);
    expect(html).not.toContain("mt-0");
  });
});

/**
 * WHAT JUST ARRIVED (10-09, use-arrivals.ts). A first paint brings nothing new:
 * no wash anywhere, the hero's pill mounted but faded and unspoken, and the
 * page's one announcer there and silent — on both views, so it exists before
 * the first arrival it has to say.
 */
describe("what just arrived, on the page's first paint", () => {
  it("is nothing: no wash, a silent announcer, and the pill mounted but out of sight", () => {
    for (const view of ["pension", "activity"] as const) {
      const html = render({ view, data: liveDashboard(), activityUnreadable: false });
      expect(html).not.toContain("live-wash");
      const announcers = html.match(/<p role="status" aria-live="polite" aria-atomic="true" class="sr-only" data-live-announcer="">(.*?)<\/p>/g) ?? [];
      expect(announcers).toEqual(['<p role="status" aria-live="polite" aria-atomic="true" class="sr-only" data-live-announcer=""></p>']);
    }
    const pension = render({ data: liveDashboard(), activityUnreadable: false });
    expect(pension).toMatch(/<div class="flex h-4 min-w-0 items-center gap-2"><p class="[^"]*">Saved so far<\/p><span class="[^"]*opacity-0" aria-hidden="true"><\/span><\/div>/);
  });
});

/**
 * THE RULE CARD SAYS WHAT IS MOVING ITS MONEY (10-09, plan B1): a buy under way
 * beside "Last investment", in the step's own words, from the same steps the
 * rows over the feed draw — and nothing for a buy that only waits.
 */
describe("the rule card on a live page", () => {
  const converted = { kind: "converted", lamportsSpent: "10000000", usdcReceivedRaw: "1000000" } as VaultEventJson;
  /** The vault's USDC converted a minute ago: its buy is under way, not overdue. */
  const buying = (): LiveDashboard =>
    liveDashboard({ activity: liveActivity([liveEntry(signature(30), seconds(NOW_MS - 60_000), [converted], 4_400), ...DEFAULT_ENTRIES]) });

  it("says a buy under way beside the last investment's label", () => {
    const html = render({ data: buying(), activityUnreadable: false });
    expect(html).toMatch(/data-buying=""><svg[^>]*motion-safe:animate-spin[^>]*>.*?<span class="truncate">Buying SPYx…<\/span>/);
  });

  it("says nothing there while the buy only waits, and keeps the label's own line", () => {
    const html = render({ data: liveDashboard(), activityUnreadable: false });
    expect(html).not.toContain("data-buying");
    expect(html).toContain('<div class="flex h-4 min-w-0 items-center justify-between gap-2"><p class="text-xs font-medium uppercase tracking-wide text-muted-foreground shrink-0">Last investment</p></div>');
  });
});
