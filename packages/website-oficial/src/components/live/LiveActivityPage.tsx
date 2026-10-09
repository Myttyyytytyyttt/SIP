"use client";

/**
 * /activity — the same history, full width, with a way back through it.
 *
 * The sidebar shows the head page in a 320px column. This page is where someone
 * goes to actually read it: the rows at full width, what has been loaded so far
 * said plainly ("Showing since Sep 12" or "Complete history"), and Load older to
 * reach further back — one page at a time, because each page costs a signature
 * listing and a transaction read upstream.
 *
 * THE COUNTDOWN IS THE HONEST PART. When the server refuses with a retry-after,
 * the button says when it can be pressed rather than failing again on click —
 * and it moves (LoadOlderButton.tsx). A failed page says to try again, never
 * that it is being tried: nothing reads an older page unless someone presses.
 *
 * A STALE PAGE SAYS SO HERE TOO (G11). The pension view leads with the note
 * that the last update failed and the line that SaverFi is paused; this page
 * showed neither, so a history the page could no longer update looked current.
 * LiveBody hands both over as `notes`, the same elements the pension view draws.
 *
 * A PENSION THAT DOES NOT EXIST YET GETS THE SAME GUARD THE PENSION VIEW GIVES
 * ITS PANELS. Before there is a vault there is no total, no history and no
 * window to claim one over, so this page shows what to do next instead of a
 * summary — a hero reading "0.00 SOL" over "Complete history" describes a
 * pension that is broken rather than one nobody has created.
 */

import { useState, type ReactNode } from "react";

import { FeedFooter, LiveActivityFeed } from "@/components/live/LiveActivityFeed";
import { LoadOlderButton } from "@/components/live/LoadOlderButton";
import { PendingRows, viewOf, type PendingView } from "@/components/live/LivePending";
import { Num } from "@/components/num";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { formatSol } from "@/lib/amounts";
import { LABEL } from "@/lib/classes";
import { dateLabel } from "@/lib/format";
import { ACTIVITY_COPY, LIVE_COPY } from "@/lib/live-copy";
import type { PendingLine } from "@/lib/live-pending";
import type { LiveDashboard, LiveRow, VaultEventKindJson } from "@/lib/live-types";
import type { LiveOlder } from "@/hooks/use-live-dashboard";
import { cn } from "@/lib/utils";

export type Filter = "all" | "savings" | "investing" | "withdrawals";

/** Which event kinds each chip keeps. `all` keeps everything the model made visible. */
const KINDS: Readonly<Record<Exclude<Filter, "all">, ReadonlySet<VaultEventKindJson>>> = {
  savings: new Set<VaultEventKindJson>(["settled", "received_sol"]),
  investing: new Set<VaultEventKindJson>(["wrapped", "converted", "invested", "policy_signed"]),
  withdrawals: new Set<VaultEventKindJson>(["withdrew_sol", "withdrew_token"]),
};

/**
 * Converting and buying are investing: shown under All and Investing. A wallet
 * being checked is a saving that may follow: under All and Savings. Nothing
 * pending is a withdrawal.
 */
export function pendingShownFor<T extends { readonly kind: PendingLine["kind"] }>(filter: Filter, pending: readonly T[]): readonly T[] {
  if (filter === "all") return pending;
  if (filter === "savings") return pending.filter((line) => line.kind === "measuring");
  if (filter === "investing") return pending.filter((line) => line.kind !== "measuring");
  return [];
}

/** The same filter over the steps and over the rows drawn for them, held ones included. */
export function pendingViewFor(filter: Filter, view: PendingView): PendingView {
  return { lines: pendingShownFor(filter, view.lines), rows: pendingShownFor(filter, view.rows), held: false };
}

const NOTHING_PENDING: PendingView = viewOf([]);

const CHIPS: readonly (readonly [Filter, string])[] = [
  ["all", ACTIVITY_COPY.filterAll],
  ["savings", ACTIVITY_COPY.filterSavings],
  ["investing", ACTIVITY_COPY.filterInvesting],
  ["withdrawals", ACTIVITY_COPY.filterWithdrawals],
];

export function LiveActivityPage({
  data,
  now,
  readyAt,
  labelOf,
  older,
  onLoadOlder,
  onRetryActivity,
  activityUnreadable,
  activityRetryAt = null,
  countsUnknown = false,
  nextStep,
  notes,
  pending = NOTHING_PENDING,
  emptyNote,
  arrived,
  className,
}: {
  readonly data: LiveDashboard;
  readonly now: string;
  /** When the history's Retry stops being deferred by the floor after the last read (RetryButton.tsx useReadyAt). */
  readonly readyAt: number;
  readonly labelOf: (wallet: string | null) => string;
  readonly older: LiveOlder;
  readonly onLoadOlder: () => void;
  readonly onRetryActivity?: () => void;
  /**
   * The history could not be read, so the feed says that instead of "none yet".
   *
   * REQUIRED, and deliberately so. It defaulted to false, no caller passed it,
   * and the honest branch in the feed was dead code for every real failure.
   */
  readonly activityUnreadable: boolean;
  /** When the server said the history may be asked for again. */
  readonly activityRetryAt?: number | null;
  /** No history has been read yet (LiveBody.tsx countsUnknownOf): the footer's counts are "—", never 0 (G10). */
  readonly countsUnknown?: boolean;
  /** The one thing to do next. Shown INSTEAD of the summary before a vault exists. */
  readonly nextStep: ReactNode;
  /** What to keep in mind about every figure on the page — stale, paused — over everything else, as on the pension view. */
  readonly notes?: ReactNode;
  /** What the keeper is about to do with the vault's money (src/lib/live-pending.ts), over the rows — with what just ended (LivePending.tsx usePendingView). */
  readonly pending?: PendingView;
  readonly emptyNote?: string;
  /** The transactions that just arrived, by signature (use-arrivals.ts): their rows wear the wash, under any filter. */
  readonly arrived?: ReadonlySet<string>;
  readonly className?: string;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const rows: readonly LiveRow[] = filter === "all" ? data.rows : data.rows.filter((row) => KINDS[filter].has(row.event.kind));

  const oldest = data.rows.at(-1);
  const since = oldest?.at ?? null;
  // From settlementRows, not the feed: a settlement found on a wallet's link
  // is not in the vault's page, and the footer must not contradict the strip.
  const settlements = data.settlementRows.length;
  const pendingShown = pendingViewFor(filter, pending);

  const frame = (children: ReactNode) => <div className={cn("flex min-w-0 flex-1 flex-col gap-4 p-4 lg:gap-6 lg:p-6", className)}>{children}</div>;

  // No vault: no total to show, and nothing was ever asked for to be complete.
  // The sidebar says why the feed is empty; this column says what to do about it.
  if (data.stage === "no_vault") {
    return frame(
      <>
        {notes}
        {nextStep}
      </>,
    );
  }

  return frame(
    <>
      {notes}
      <Card>
        <CardHeader>
          <dl className="flex flex-wrap items-baseline gap-x-8 gap-y-3">
            <div className="space-y-1">
              <dt className={LABEL}>{LIVE_COPY.savedSoFar}</dt>
              {/* A total nobody could read is not a zero — the module's own rule. */}
              <dd className="font-mono text-2xl font-semibold tabular-nums">
                {data.vault.lifetimeSaved === null ? LIVE_COPY.unknownFigure : `${formatSol(data.vault.lifetimeSaved)} SOL`}
              </dd>
            </div>
            <div className="space-y-1">
              <dt className={LABEL}>{ACTIVITY_COPY.filterSavings}</dt>
              <dd className="font-mono text-2xl font-semibold tabular-nums">
                <Num>{data.stats.settlementsLifetime === null ? LIVE_COPY.unknownFigure : data.stats.settlementsLifetime.toString()}</Num>
              </dd>
            </div>
            <div className="space-y-1">
              <dt className={LABEL}>{LIVE_COPY.activity}</dt>
              {/*
                COMPLETE IS A CLAIM ABOUT A PAGE THAT WAS READ. `older.complete`
                is set only by a head page that actually came back, so it is the
                whole test: nothing loaded and nothing complete means the history
                is unknown, not finished. It used to read `since === null` as
                completeness, which is how a read that FAILED came out as
                "Complete history".
              */}
              <dd className="text-sm text-muted-foreground">
                {older.complete ? ACTIVITY_COPY.complete : since === null ? LIVE_COPY.unknownFigure : ACTIVITY_COPY.showingSince(dateLabel(since))}
              </dd>
            </div>
          </dl>
        </CardHeader>

        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={ACTIVITY_COPY.filterLabel}>
            {CHIPS.map(([value, label]) => (
              <Button key={value} type="button" size="sm" variant={filter === value ? "secondary" : "outline"} aria-pressed={filter === value} onClick={() => setFilter(value)}>
                {label}
              </Button>
            ))}
          </div>

          <div className="overflow-hidden rounded-md border">
            {/* The divider is the rows' own, so it comes and goes with them. */}
            <PendingRows lines={pendingShown.lines} view={pendingShown} innerClassName="border-b" />
            <LiveActivityFeed
              rows={rows}
              now={now}
              labelOf={labelOf}
              maxContribution={data.vault.maxContribution}
              id="activity-page"
              hiddenRows={data.hiddenRows}
              hiddenUpkeep={data.hiddenUpkeep}
              hiddenDust={data.hiddenDust}
              unreadable={activityUnreadable}
              retryAt={activityRetryAt}
              readyAt={readyAt}
              {...(onRetryActivity === undefined ? {} : { onRetry: onRetryActivity })}
              emptyNote={filter === "all" ? emptyNote : ACTIVITY_COPY.noneInFilter}
              {...(arrived === undefined ? {} : { arrived })}
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <FeedFooter transactions={countsUnknown ? null : data.rows.length} settlements={countsUnknown ? null : settlements} />
            {older.complete ? (
              <span className="text-xs text-muted-foreground">{ACTIVITY_COPY.complete}</span>
            ) : (
              <LoadOlderButton older={older} onLoadOlder={onLoadOlder} />
            )}
          </div>

          {/* Its own sentence, whatever refused the page: an older page is
              fetched only when someone presses, so the line says to press. */}
          {older.message === null ? null : (
            <p role="status" className="text-xs text-muted-foreground">
              {ACTIVITY_COPY.olderFailed}
            </p>
          )}
        </CardContent>
      </Card>
    </>,
  );
}
