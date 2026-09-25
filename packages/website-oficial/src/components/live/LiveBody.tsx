"use client";

/**
 * THE CONNECTED DASHBOARD, assembled: header, sidebar, main column, footer.
 *
 * It is the same frame the sample uses, so the two cannot drift into different
 * layouts — but every component inside it is a live one, and none of them can
 * reach the seeded example (src/components/live/no-mock-import.test.ts).
 *
 * ONE CLOCK FOR LABELS, ANOTHER FOR COUNTDOWNS, and they are different on
 * purpose. `now` is the SERVER's clock as at the snapshot (`data.nowMs`): every
 * "4m ago" and every day heading is measured against it, so the page cannot
 * disagree with the numbers it was read with. `nowMs` is the browser's, used
 * only for "try again in 12 s", which is about this browser's own next attempt.
 *
 * A STAGE THAT HAS NOTHING TO SHOW SHOWS NOTHING. Before there is a vault the
 * panels are not rendered at all — not rendered empty — because a hero reading
 * "0 SOL" over a chart with no points reads as a broken pension rather than one
 * that has not been created yet.
 */

import type { ReactNode } from "react";

import { LiveActivityPage } from "@/components/live/LiveActivityPage";
import { LiveNextStep } from "@/components/live/LiveNextStep";
import { LiveStartBuying } from "@/components/live/LiveStartBuying";
import { LiveRulePanel } from "@/components/live/LiveRulePanel";
import { FeedBanner, HiddenRows, LeadNotes, WalletList } from "@/components/live/LiveColumn";
import { secondsUntil } from "@/components/live/LiveStates";
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
import type { LiveOlder, LiveStale } from "@/hooks/use-live-dashboard";
import { clockLabel } from "@/lib/format";
import { ACTIVITY_COPY, LIVE_COPY } from "@/lib/live-copy";
import { rawFrom } from "@/lib/amounts";
import { anchorOf, toDashboardMock } from "@/lib/live-mock";
import type { LiveDashboard } from "@/lib/live-types";
import { seatProblem } from "@/lib/trading-wallets";

/** After this long without a good read, the note adds that the numbers may be out of date. */
const STALE_WARNING_MS = 5 * 60_000;

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
  /** The browser's clock. Countdowns only; never a label. */
  readonly nowMs: number;
  /** The history could not be read. REQUIRED, because forgetting it drew an empty feed over a pension with settlements. */
  readonly activityUnreadable: boolean;
  /** When the server said the history may be asked for again; the retry counts down to it. */
  readonly activityRetryAt?: number | null;
  /** Drawn before the history answered (use-live-dashboard.ts, FIRST_PAINT_WAIT_MS): the feed says it is reading. */
  readonly activityPending?: boolean;
}) {
  const openWallets = useWalletsOpener();
  const onOpenWallets = (): void => openWallets?.();
  const config = useSolanaConfigOrNull();

  // The payload's own clock: every relative label is measured against it.
  const now = new Date(data.nowMs).toISOString();
  // THE SAMPLE'S SHAPE, FILLED WITH THIS PENSION. The panels below are the
  // sample's own components (src/components/pension-*.tsx); this is what they
  // draw instead of the seeded example — real figures, today's dollars, and a
  // dash wherever the chain has no answer (src/lib/live-mock.ts).
  const page = toDashboardMock(data, { complete: older.complete });

  /** A wallet's own label, so a settlement says which one it came from. */
  const labelOf = (wallet: string | null): string => {
    if (wallet === null) return ACTIVITY_COPY.someWallet;
    return data.wallets.find((entry) => entry.address === wallet)?.label ?? ACTIVITY_COPY.someWallet;
  };

  // A poll that failed keeps the last good data and says as of when.
  const notice = (): string | null => {
    if (stale === null) return null;
    const clock = clockLabel(now);
    const seconds = secondsUntil(stale.retryAt, nowMs);
    const line = seconds === null ? LIVE_COPY.staleAsOfPending(clock) : LIVE_COPY.staleAsOf(clock, seconds);
    return nowMs - stale.since >= STALE_WARNING_MS ? `${line} ${LIVE_COPY.staleLong}` : line;
  };

  // No vault means no history was even requested; say that rather than "none yet".
  // And a history still on its way is not an empty one either.
  const emptyNote = data.stage === "no_vault" ? LIVE_COPY.noVault.sidebar : activityPending ? ACTIVITY_COPY.readingHistory : undefined;
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
      onManageWallets={onOpenWallets}
      className={inSheet ? "min-h-0 flex-1" : "sticky top-14 h-[calc(100dvh-3.5rem)]"}
      live={{
        below: lead === null ? null : <LeadNotes wallet={lead} />,
        list: <WalletList wallets={data.wallets} usdcRawPerSol={rawFrom(data.prices?.usdcRawPerSol)} />,
        banner: activityUnreadable ? <FeedBanner onRetry={onRefresh} retryAt={activityRetryAt} nowMs={nowMs} /> : null,
        hidden: <HiddenRows events={page.hidden ?? []} upkeep={data.hiddenUpkeep} dust={data.hiddenDust} now={page.now} id={id} />,
        // A page whose every transaction was upkeep is not an empty history.
        empty: emptyNote ?? (data.hiddenRows.length > 0 ? ACTIVITY_COPY.onlyHidden : ACTIVITY_COPY.empty),
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
        contributions={<HeaderContributions rows={data.settlementRows} />}
        account={account}
        current={view}
      />

      <div className="flex flex-1">
        <aside className="hidden w-80 shrink-0 border-r lg:block xl:w-88">{sidebarFor("activity-aside", false)}</aside>

        {view === "activity" ? (
          <LiveActivityPage
            data={data}
            now={now}
            nowMs={nowMs}
            labelOf={labelOf}
            older={older}
            onLoadOlder={onLoadOlder}
            onRetryActivity={onRefresh}
            activityUnreadable={activityUnreadable}
            activityRetryAt={activityRetryAt}
            nextStep={nextStep}
            {...(emptyNote === undefined ? {} : { emptyNote })}
          />
        ) : (
          <DashboardMain
            top={
              <>
                {/* Reads the rendered payload's own source, never the toggle. */}
                <DashboardSource source="live" notice={notice()} />
                {data.protocolPaused === true ? (
                  <p role="status" className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                    {LIVE_COPY.protocolPaused}
                  </p>
                ) : null}
                {nextStep}
                {/* The buying approval the setup promised, once the first savings have landed. */}
                <LiveStartBuying data={data} pensionKey={pensionKey} onRefresh={onRefresh} />
              </>
            }
            strip={
              panels ? null : (
                <SavingsStrip
                  trades={page.trades}
                  rule={page.rule}
                  now={page.now}
                  live={{
                    settledOutsideHistory: data.stats.settledOutsideHistory,
                    loadOlder: { busy: older.busy, retryIn: secondsUntil(older.retryAt, nowMs), complete: older.complete, available: older.available, onClick: onLoadOlder },
                  }}
                />
              )
            }
            cards={
              panels ? null : (
                <>
                  <LiveRulePanel rule={page.rule} stats={page.stats} activity={page.activity} now={page.now} onRefresh={onRefresh} className={RULE_SLOT} />
                  <PensionPanel
                    stats={page.stats}
                    curve={page.curve}
                    holdings={page.holdings}
                    days={page.days}
                    rule={page.rule}
                    now={page.now}
                    trades={page.trades}
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
