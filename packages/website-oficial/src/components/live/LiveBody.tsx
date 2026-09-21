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
import { LivePensionCard } from "@/components/live/LivePensionCard";
import { LiveRuleCard } from "@/components/live/LiveRuleCard";
import { LiveSettlementStrip } from "@/components/live/LiveSettlementStrip";
import { LiveSidebar } from "@/components/live/LiveSidebar";
import { secondsUntil } from "@/components/live/LiveStates";
import { DashboardSource } from "@/components/DashboardSource";
import { SiteFooter } from "@/components/site-footer";
import { HeaderContributions } from "@/components/header-contributions";
import { SiteHeader } from "@/components/site-header";
import { useSolanaConfigOrNull } from "@/app/providers";
import { useWalletsOpener } from "@/components/wallets-host";
import type { LiveOlder, LiveStale } from "@/hooks/use-live-dashboard";
import { clockLabel } from "@/lib/format";
import { ACTIVITY_COPY, LIVE_COPY } from "@/lib/live-copy";
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
}) {
  const openWallets = useWalletsOpener();
  const onOpenWallets = (): void => openWallets?.();
  const config = useSolanaConfigOrNull();

  // The payload's own clock: every relative label is measured against it.
  const now = new Date(data.nowMs).toISOString();

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
  const emptyNote = data.stage === "no_vault" ? LIVE_COPY.noVault.sidebar : undefined;
  const sidebarFor = (id: string, inSheet: boolean): ReactNode => (
    <LiveSidebar
      data={data}
      pensionKey={pensionKey}
      now={now}
      labelOf={labelOf}
      id={id}
      inSheet={inSheet}
      onOpenWallets={onOpenWallets}
      onRetryActivity={onRefresh}
      activityUnreadable={activityUnreadable}
      {...(emptyNote === undefined ? {} : { emptyNote })}
      className={inSheet ? "min-h-0 flex-1" : "sticky top-14 h-[calc(100dvh-3.5rem)]"}
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
        // settlements are already on screen in full.
        contributions={<HeaderContributions rows={data.rows} />}
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
            nextStep={nextStep}
            {...(emptyNote === undefined ? {} : { emptyNote })}
          />
        ) : (
          <main className="flex min-w-0 flex-1 flex-col gap-4 p-4 lg:gap-6 lg:p-6">
            {/* Reads the rendered payload's own source, never the toggle. */}
            <DashboardSource source="live" notice={notice()} />
            {data.protocolPaused === true ? (
              <p role="status" className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                {LIVE_COPY.protocolPaused}
              </p>
            ) : null}

            {nextStep}

            {panels ? null : (
              <>
                <LiveSettlementStrip
                  rows={data.rows}
                  vault={data.vault}
                  now={now}
                  labelOf={labelOf}
                  settledOutsideHistory={data.stats.settledOutsideHistory}
                  older={older}
                  onLoadOlder={onLoadOlder}
                  nowMs={nowMs}
                />
                <div className="grid gap-4 lg:gap-6 md:grid-cols-[minmax(16rem,20rem)_1fr] lg:grid-cols-1 xl:grid-cols-[minmax(16rem,20rem)_1fr]">
                  <LiveRuleCard data={data} labelOf={labelOf} onOpenWallets={onOpenWallets} className="order-2 md:order-1 lg:order-2 xl:order-1" />
                  <LivePensionCard data={data} now={now} complete={older.complete} className="order-1 md:order-2 lg:order-1 xl:order-2" />
                </div>
              </>
            )}
          </main>
        )}
      </div>

      <SiteFooter now={now} />
    </div>
  );
}
