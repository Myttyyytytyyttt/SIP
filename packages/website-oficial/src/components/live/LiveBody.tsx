"use client";

/**
 * THE CONNECTED DASHBOARD, assembled: header, sidebar, main column, footer.
 *
 * It is the same frame the sample uses, so the two cannot drift into different
 * layouts — but every component inside it is a live one, and none of them can
 * reach the seeded example (src/components/live/no-mock-import.test.ts).
 *
 * ONE CLOCK FOR LABELS, ANOTHER FOR THIS BROWSER'S OWN WAITING, and they are
 * different on purpose. `now` is the SERVER's clock as at the snapshot
 * (`data.nowMs`): every "4m ago" and every day heading is measured against it,
 * so the page cannot disagree with the numbers it was read with. `nowMs` is the
 * browser's, used only for how long a failure has stood — and for the one
 * label that is about this browser's wait, the stale note's day, since a
 * snapshot is always "today" against its own clock. Every "try again in
 * 12 s" ticks in its own leaf (RetryButton, LoadOlderButton), and so does the
 * header dot's "Updated 2 min ago" (LiveHeartbeat), so this body is never
 * re-rendered every second for one.
 *
 * A STAGE THAT HAS NOTHING TO SHOW SHOWS NOTHING. Before there is a vault the
 * panels are not rendered at all — not rendered empty — because a hero reading
 * "0 SOL" over a chart with no points reads as a broken pension rather than one
 * that has not been created yet. The strip likewise: it is not passed at all
 * before the first settlement, so its wrapper does not stand empty in the
 * column holding a gap open, and it grows in when that settlement lands.
 *
 * WHAT COMES AND GOES IN THE TOP COLUMN DOES NOT SHOVE THE PAGE (10-09, G8):
 * the stage card swaps its height from one stage to the next, the steps' card
 * grows and closes, the start-buying card grows in (Reveal.tsx).
 *
 * WHAT IS ON ITS WAY IS READ OFF A READ THAT LANDED WHOLE (plan B5,
 * use-whole-read.ts): a read commits its snapshot and its history together
 * and is drawn at once. A later read that could not read its history commits
 * its snapshot alone; the steps over the feed then stay as the last whole
 * read drew them, their loaders still where that snapshot no longer has them
 * under way (LivePending.tsx).
 *
 * AND WHAT SOLANA SAID CHANGED LEADS THEM BEFORE ANY UPDATE HAS (plan B3,
 * heard-lines.ts): "Activity seen on Trading wallet 1 · checking" from the
 * moment the chain rings (`live.heard`), which becomes that wallet's "checking
 * your latest activity" in place once the update lands; "Activity seen on your
 * vault · checking" when only the vault rang. Each ends when `heard` clears.
 *
 * WHAT JUST ARRIVED IS WORKED OUT ONCE, HERE (use-arrivals.ts): a transaction
 * new to the page and newer than anything it showed. Its rows in the column
 * (both copies), on /activity, its chips in the strip and in the bar wear one
 * wash on one clock; a saving puts its pill beside the hero's figure; and the
 * page's one announcer says it in words (LiveAnnouncer.tsx). No figure counts
 * up or flashes (owner, 10-09).
 *
 * THE RULE CARD SAYS WHAT IS MOVING ITS MONEY (10-09, plan B1): Next
 * investment's mark from the same steps the rows draw, a buy under way beside
 * "Last investment", and the washes of a buy or a rule change just arrived —
 * all worked out here from what the page already holds (rulePulseOf).
 *
 * EVERY MOMENT IT NAMES CARRIES ITS DAY WHEN THAT IS NOT TODAY (format.ts
 * whenLabel): the stale note, the hero's pill, a done step, the setup's wait.
 *
 * HOW LIVE IT IS COMES FROM THE STORE, NOT FROM A GUESS (plan B2): `live`
 * (use-live-dashboard.ts LiveLiveness) — whether the chain's push is live, a
 * check is out, a change was heard, when the last update landed, when the next
 * check is due, and from when a Retry reads at once. The header's dot says it
 * (LiveHeartbeat.tsx), and every Retry on the page opens at that one moment.
 * And whether a newer version is served (use-update-available.ts): asked here,
 * where it is drawn, so the sample never asks.
 *
 * WHAT WAS JUST SIGNED IS JUDGED HERE, ONCE (plan B4, last-write-context.ts):
 * the last signature that landed anywhere on the page — the gear, the
 * first-buy card, the wallets modal — against what this page shows. Until it
 * shows it, the card that speaks for it says "updating your pension" (the rule
 * card, the first-buy card, the next step in place of its button), and past a
 * minute or two updates the still "not on this page yet". The verdict goes
 * back up for the modal's own success lines. While it says "updating", the
 * vault's "Activity seen on your vault" line stands down: it is the same
 * change, and one fact wears one moving mark.
 */

import { useRef, type ReactNode } from "react";

import { LiveActivityPage } from "@/components/live/LiveActivityPage";
import { LiveNextStep } from "@/components/live/LiveNextStep";
import { LiveStartBuying } from "@/components/live/LiveStartBuying";
import { LiveRulePanel } from "@/components/live/LiveRulePanel";
import { rulePulseOf } from "@/components/live/NextInvestmentLive";
import { FeedBanner, HiddenRows, LeadNotes, WalletList } from "@/components/live/LiveColumn";
import { FeedSkeleton } from "@/components/live/FeedSkeleton";
import { LiveAnnouncer } from "@/components/live/LiveAnnouncer";
import { LiveHeartbeat } from "@/components/live/LiveHeartbeat";
import { LoadOlderButton } from "@/components/live/LoadOlderButton";
import { PendingRows, usePendingView } from "@/components/live/LivePending";
import { Reveal } from "@/components/live/Reveal";
import { heardLinesOf } from "@/components/live/heard-lines";
import { useWriteJudge } from "@/components/live/last-write-context";
import { heroPillOf, pillShown, useArrivals } from "@/components/live/use-arrivals";
import { useUpdateAvailable } from "@/components/live/use-update-available";
import { useWholeRead } from "@/components/live/use-whole-read";
import { DashboardSource } from "@/components/DashboardSource";
import { DashboardMain, PENSION_SLOT, RULE_SLOT } from "@/components/dashboard-main";
import { PensionPanel } from "@/components/pension-panel";
import { SavingsStrip } from "@/components/savings-strip";
import { WalletActivity } from "@/components/wallet-activity";
import { SiteFooter } from "@/components/site-footer";
import { HeaderContributions } from "@/components/header-contributions";
import { SiteHeader } from "@/components/site-header";
import { useSolanaConfigOrNull } from "@/app/providers";
import { useWalletsOpener } from "@/components/wallets-host";
import type { LiveLiveness, LiveOlder, LiveStale } from "@/hooks/use-live-dashboard";
import { whenLabel } from "@/lib/format";
import { ACTIVITY_COPY, LIVE_COPY } from "@/lib/live-copy";
import { rawFrom } from "@/lib/amounts";
import { anchorOf, toDashboardMock } from "@/lib/live-mock";
import { pendingLines, pendingSteps } from "@/lib/live-pending";
import type { LiveDashboard } from "@/lib/live-types";
import { seatProblem } from "@/lib/trading-wallets";
import type { WalletsSection } from "@/lib/wallets-sections";

/** After this long without a good read, the note adds that the numbers may be out of date. */
const STALE_WARNING_MS = 5 * 60_000;

/**
 * THE STALE NOTE: as of when, that the page keeps trying, and why the last
 * update failed — in the failure's own words (`stale.message`), which since
 * 10-09 name no time either. It used to promise "trying again in 30 s": the
 * server's retry-after, which the schedule's two-to-five-minute backoff never
 * kept (G6).
 *
 * "May be out of date" is said once, last. The hook adds it to the message
 * itself on a view worked out five minutes after the failure, and this body
 * adds it on its own clock; whichever saw it first, it is not said twice.
 */
export function staleNote(input: { readonly when: string; readonly message: string; readonly long: boolean }): string {
  const said = input.message.endsWith(LIVE_COPY.staleLong);
  const reason = (said ? input.message.slice(0, -LIVE_COPY.staleLong.length) : input.message).trim();
  return [LIVE_COPY.staleAsOf(input.when), reason, said || input.long ? LIVE_COPY.staleLong : ""].filter((part) => part !== "").join(" ");
}

/**
 * WHETHER THE FEEDS HAVE ANYTHING TO COUNT (10-09, G10). No page of the vault's
 * own history has been read — it is still on its way, or it failed before a
 * single one landed — so a count is nobody's knowledge, and the footers say
 * "—" rather than "0 events · 0 settlements" beside a pension the chain says
 * has settled. A history that fails AFTER a page landed keeps those rows on
 * screen (use-live-dashboard.ts), and the footers go on counting exactly the
 * rows shown: a known count, of what is there.
 */
/**
 * THE ROWS A SIGNATURE IS LOOKED FOR IN, when a slot is missing on either side
 * (last-write-context.ts pageShows): the vault's own page, the rows it hides
 * from the feed too — an owner's write can be one — never the links', which
 * no owner signature is on.
 */
export const signedRows = (data: Pick<LiveDashboard, "rows" | "hiddenRows">): readonly { readonly signature: string }[] =>
  data.hiddenRows.length === 0 ? data.rows : [...data.rows, ...data.hiddenRows];

export function countsUnknownOf(input: { readonly activityPending: boolean; readonly activityUnreadable: boolean; readonly loaded: number }): boolean {
  return input.activityPending || (input.activityUnreadable && input.loaded === 0);
}

export function LiveBody({
  view,
  data,
  stale,
  pensionKey,
  control,
  account,
  older,
  onRefresh,
  onLoadOlder,
  nowMs,
  activityUnreadable,
  activityRetryAt = null,
  activityPending = false,
  live,
}: {
  readonly view: "pension" | "activity";
  readonly data: LiveDashboard;
  readonly stale: LiveStale | null;
  readonly pensionKey: string;
  readonly control: ReactNode;
  readonly account: ReactNode;
  readonly older: LiveOlder;
  readonly onRefresh: () => void;
  readonly onLoadOlder: () => void;
  /** The browser's clock: how long a failure has stood, and which day the stale note is read on. Never a time printed. */
  readonly nowMs: number;
  /** The history could not be read. REQUIRED, because forgetting it drew an empty feed over a pension with settlements. */
  readonly activityUnreadable: boolean;
  /** When the server said the history may be asked for again; the retry counts down to it. */
  readonly activityRetryAt?: number | null;
  /** Drawn before the history answered (use-live-dashboard.ts, FIRST_PAINT_WAIT_MS): the feed says it is reading. */
  readonly activityPending?: boolean;
  /**
   * How live the page is (use-live-dashboard.ts LiveLiveness). REQUIRED: the
   * header's dot and every Retry read it, and without it neither has anything
   * true to say.
   */
  readonly live: LiveLiveness;
}) {
  const openWallets = useWalletsOpener();
  // Wrappers, not the opener itself. The sidebar hands its handler straight to onClick, so it takes nothing and
  // opens the overview: a click event never reaches the opener from here. The next-step card names the section
  // its stage needs, and that one is passed through.
  const onManageWallets = (): void => openWallets?.();
  const onOpenWallets = (section?: WalletsSection): void => openWallets?.(section);
  const config = useSolanaConfigOrNull();

  // The payload's own clock: every relative label is measured against it.
  const now = new Date(data.nowMs).toISOString();
  // THE SAMPLE'S SHAPE, FILLED WITH THIS PENSION. The panels below are the
  // sample's own components (src/components/pension-*.tsx); this is what they
  // draw instead of the seeded example — real figures, today's dollars, and a
  // dash wherever the chain has no answer (src/lib/live-mock.ts).
  const page = toDashboardMock(data, { complete: older.complete });
  // WHAT IS ON ITS WAY: a wallet being checked, SOL converting, a basket about
  // to be bought (src/lib/live-pending.ts) — from the newest read that landed
  // WHOLE (use-whole-read.ts): every read, unless its history could not be
  // read — then the newest snapshot's steps go beside it only for the loaders
  // the page no longer vouches for. A first paint drawn before its history
  // answered is no read's commit. Worked out once, for every copy of the rows;
  // each "since" said against its payload's own clock, with its day when that
  // is not today (format.ts whenLabel, in live-pending.ts pendingLines).
  const shown = useWholeRead(data, { readId: live.readId, whole: !activityPending && !activityUnreadable });
  const steps = pendingSteps(shown.data);
  const lines = pendingLines(steps, shown.data.nowMs);
  const latest = shown.newest ? lines : pendingLines(pendingSteps(data), data.nowMs);
  // WHAT WAS JUST SIGNED, AND WHETHER THIS PAGE SHOWS IT YET: against the
  // newest snapshot's slot, counted in whole updates (last-write-context.ts).
  const sync = useWriteJudge({ pensionKey, readId: live.readId, slot: data.slot, rows: signedRows(data) });
  // AND BEFORE ANY OF THAT, WHAT SOLANA SAID CHANGED (heard-lines.ts): from the
  // newest snapshot and the store's `heard`, under the keys the steps will
  // take. "Behind" while the updates fail — the stale note, or the history
  // unreadable — when no update is known to be bringing it.
  const heard = heardLinesOf({ heard: live.heard, data, lines, behind: stale !== null || activityUnreadable, signing: sync?.state === "syncing" });
  const pending = usePendingView({ data: shown.data, steps, lines, heard, latest });

  // THE STRIP, ONLY ONCE THERE IS ONE (SavingsStrip's own null rule). Grown in
  // when it comes after the page was drawn without it; simply there otherwise.
  const hasStrip = page.trades.length > 0 || data.stats.settledOutsideHistory;
  const stripWasAbsent = useRef(false);
  if (!hasStrip) stripWasAbsent.current = true;

  // WHAT JUST ARRIVED, once for every surface. From the newest commit: rows
  // change only with a read's history, so there is no half state to wait out.
  const arrivals = useArrivals({ key: pensionKey, data, activityPending, activityUnreadable });
  const pulse = { pill: heroPillOf(arrivals.saving, page.trades, data.nowMs), shown: pillShown(arrivals.saving, data.nowMs) };
  // The rule card's: the steps as the rows draw them, and the same arrivals.
  const rulePulse = rulePulseOf({ rows: pending.rows, history: data.rows, arrived: arrivals.arrived });

  /** A wallet's own label, so a settlement says which one it came from. */
  const labelOf = (wallet: string | null): string => {
    if (wallet === null) return ACTIVITY_COPY.someWallet;
    return data.wallets.find((entry) => entry.address === wallet)?.label ?? ACTIVITY_COPY.someWallet;
  };

  // A poll that failed keeps the last good data and says as of when, and why —
  // dated against THIS browser's day, not the snapshot's: the snapshot's own
  // clock is the very moment named, so against it every note would be "today".
  // The live body renders only in the browser, so no server's day can differ.
  const notice = (): string | null =>
    stale === null ? null : staleNote({ when: whenLabel(data.nowMs, nowMs), message: stale.message, long: nowMs - stale.since >= STALE_WARNING_MS });

  // When a Retry reads at once: the store's own floor after the last read,
  // good or failed. One for the page, so the aside's banner, the sheet's,
  // /activity's and the dot's Check now count down together.
  const readyAt = live.refreshReadyAt;
  // A newer version served than this tab runs: the dot's ring and its reload.
  const updateAvailable = useUpdateAvailable();

  /*
   * WHAT TO KEEP IN MIND ABOUT EVERY FIGURE ON THE PAGE, on both views: the
   * stale note and the protocol-paused line. /activity showed neither, so a
   * history the page could not update looked current there (G11).
   */
  const notes = (
    <>
      {/* Reads the rendered payload's own source, never the toggle. */}
      <DashboardSource source="live" notice={notice()} />
      {data.protocolPaused === true ? (
        <p role="status" className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {LIVE_COPY.protocolPaused}
        </p>
      ) : null}
    </>
  );

  // No vault means no history was even requested; say that rather than "none yet".
  // And a history still on its way is not an empty one either.
  const emptyNote = data.stage === "no_vault" ? LIVE_COPY.noVault.sidebar : activityPending ? ACTIVITY_COPY.readingHistory : undefined;
  // Counted from the vault's own page, shown or hidden; a settlement found on a link is not one of its rows.
  const countsUnknown = countsUnknownOf({ activityPending, activityUnreadable, loaded: data.rows.length + data.hiddenRows.length });
  // The wallet the column leads with — the same rule the adapter used to pick `page.wallet`.
  const anchor = anchorOf(data.wallets);
  const lead = anchor === null ? null : (data.wallets.find((wallet) => wallet.address === anchor) ?? null);
  /*
   * THE SAMPLE'S COLUMN, mounted twice — in the aside from lg up, and inside
   * the header's sheet below it — with a live page's own pieces in its slots
   * (LiveColumn.tsx). The two never share a DOM id: the roving Tab stop and the
   * hidden-rows panel of one would walk the other's.
   */
  const sidebarFor = (id: string, inSheet: boolean): ReactNode => (
    <WalletActivity
      wallet={page.wallet}
      activity={page.activity}
      now={page.now}
      id={id}
      onManageWallets={onManageWallets}
      className={inSheet ? "min-h-0 flex-1" : "sticky top-14 h-[calc(100dvh-3.5rem)]"}
      live={{
        below: lead === null ? null : <LeadNotes wallet={lead} />,
        list: <WalletList wallets={data.wallets} usdcRawPerSol={rawFrom(data.prices?.usdcRawPerSol)} />,
        banner: activityUnreadable ? <FeedBanner onRetry={onRefresh} retryAt={activityRetryAt} readyAt={readyAt} /> : null,
        // On /activity the page's own list announces the steps; the column only shows them.
        pending: <PendingRows lines={pending.lines} view={pending} announce={view !== "activity"} />,
        hidden: <HiddenRows events={page.hidden ?? []} upkeep={data.hiddenUpkeep} dust={data.hiddenDust} now={page.now} id={id} />,
        // A page whose every transaction was upkeep is not an empty history.
        empty: emptyNote ?? (data.hiddenRows.length > 0 ? ACTIVITY_COPY.onlyHidden : ACTIVITY_COPY.empty),
        // The feed's shape under "Reading this pension's history…", only while it is.
        skeleton: activityPending ? <FeedSkeleton className="mt-3" /> : null,
        countsUnknown,
        arrived: arrivals.arrived,
        inSheet,
      }}
    />
  );

  const nextStep = (
    <LiveNextStep
      data={data}
      pensionKey={pensionKey}
      seatProblem={config === null ? null : seatProblem(config)}
      onOpenWallets={onOpenWallets}
      sync={sync}
      // In the pension view's top column it enters, swaps and leaves without
      // shoving the page; /activity shows it only before there is a vault.
      animate={view === "pension"}
    />
  );

  // Before a vault exists there is nothing true to put in the panels.
  const panels = data.stage === "no_vault";

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader
        activitySheet={sidebarFor("activity-sheet", true)}
        control={control}
        // The header shows this only away from the pension, where these very
        // settlements are already on screen in full. From settlementRows, not
        // the feed: a settlement read from a wallet's link is not in the
        // vault's own page and is a contribution all the same.
        contributions={<HeaderContributions rows={data.settlementRows} arrived={arrivals.arrived} />}
        // HOW FRESH THIS PAGE IS: a dot before the pension key, its words in
        // its popover (LiveHeartbeat.tsx). Wrapped in here, so the header — the
        // sample's too — is not edited for it.
        account={
          <>
            <LiveHeartbeat nowMs={data.nowMs} stale={stale} live={live} activityRetryAt={activityRetryAt} updateAvailable={updateAvailable} onCheck={onRefresh} />
            {account}
          </>
        }
        current={view}
      />

      {/* What just arrived, in words: one polite announcement per update that brought something. */}
      <LiveAnnouncer news={arrivals.news} labelOf={labelOf} />

      <div className="flex flex-1">
        <aside className="hidden w-80 shrink-0 border-r lg:block xl:w-88">{sidebarFor("activity-aside", false)}</aside>

        {view === "activity" ? (
          <LiveActivityPage
            data={data}
            now={now}
            readyAt={readyAt}
            labelOf={labelOf}
            older={older}
            onLoadOlder={onLoadOlder}
            onRetryActivity={onRefresh}
            activityUnreadable={activityUnreadable}
            activityRetryAt={activityRetryAt}
            countsUnknown={countsUnknown}
            nextStep={nextStep}
            notes={notes}
            pending={pending}
            arrived={arrivals.arrived}
            {...(emptyNote === undefined ? {} : { emptyNote })}
          />
        ) : (
          <DashboardMain
            top={
              <>
                {notes}
                {nextStep}
                {/* BELOW lg THE ACTIVITY COLUMN IS IN A CLOSED SHEET, so the steps
                    on their way lead the page instead; from lg up the column
                    shows them and this copy is not displayed (LivePending.tsx). */}
                <PendingRows lines={pending.lines} view={pending} variant="card" className="lg:hidden" />
                {/* The buying approval the setup promised, once the first savings have landed. */}
                <LiveStartBuying data={data} pensionKey={pensionKey} onRefresh={onRefresh} sync={sync} />
              </>
            }
            strip={
              panels || !hasStrip ? null : (
                <Reveal open appear={stripWasAbsent.current}>
                  <SavingsStrip
                    trades={page.trades}
                    rule={page.rule}
                    now={page.now}
                    live={{
                      settledOutsideHistory: data.stats.settledOutsideHistory,
                      loadOlderSlot: <LoadOlderButton older={older} onLoadOlder={onLoadOlder} className="h-9 shrink-0" />,
                      arrived: arrivals.arrived,
                    }}
                  />
                </Reveal>
              )
            }
            cards={
              panels ? null : (
                <>
                  <LiveRulePanel
                    rule={page.rule}
                    stats={page.stats}
                    activity={page.activity}
                    now={page.now}
                    onRefresh={onRefresh}
                    pulse={rulePulse}
                    sync={sync}
                    className={RULE_SLOT}
                  />
                  <PensionPanel
                    stats={page.stats}
                    curve={page.curve}
                    holdings={page.holdings}
                    days={page.days}
                    rule={page.rule}
                    now={page.now}
                    trades={page.trades}
                    pulse={pulse}
                    {...(page.calendar === undefined ? {} : { calendar: page.calendar })}
                    {...(page.vault === undefined ? {} : { vault: page.vault })}
                    {...(page.unit === undefined ? {} : { unit: page.unit })}
                    className={PENSION_SLOT}
                  />
                </>
              )
            }
          />
        )}
      </div>

      <SiteFooter now={now} />
    </div>
  );
}
