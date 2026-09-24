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
 * the button says when it can be pressed rather than failing again on click.
 *
 * A PENSION THAT DOES NOT EXIST YET GETS THE SAME GUARD THE PENSION VIEW GIVES
 * ITS PANELS. Before there is a vault there is no total, no history and no
 * window to claim one over, so this page shows what to do next instead of a
 * summary — a hero reading "0.00 SOL" over "Complete history" describes a
 * pension that is broken rather than one nobody has created.
 */

import { useState, type ReactNode } from "react";

import { FeedFooter, LiveActivityFeed } from "@/components/live/LiveActivityFeed";
import { secondsUntil } from "@/components/live/LiveStates";
import { Num } from "@/components/num";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { formatSol } from "@/lib/amounts";
import { LABEL } from "@/lib/classes";
import { dateLabel } from "@/lib/format";
import { ACTIVITY_COPY, LIVE_COPY } from "@/lib/live-copy";
import type { LiveDashboard, LiveRow, VaultEventKindJson } from "@/lib/live-types";
import type { LiveOlder } from "@/hooks/use-live-dashboard";
import { cn } from "@/lib/utils";

type Filter = "all" | "savings" | "investing" | "withdrawals";

/** Which event kinds each chip keeps. `all` keeps everything the model made visible. */
const KINDS: Readonly<Record<Exclude<Filter, "all">, ReadonlySet<VaultEventKindJson>>> = {
  savings: new Set<VaultEventKindJson>(["settled", "received_sol"]),
  investing: new Set<VaultEventKindJson>(["wrapped", "converted", "invested", "policy_signed"]),
  withdrawals: new Set<VaultEventKindJson>(["withdrew_sol", "withdrew_token"]),
};

const CHIPS: readonly (readonly [Filter, string])[] = [
  ["all", ACTIVITY_COPY.filterAll],
  ["savings", ACTIVITY_COPY.filterSavings],
  ["investing", ACTIVITY_COPY.filterInvesting],
  ["withdrawals", ACTIVITY_COPY.filterWithdrawals],
];

export function LiveActivityPage({
  data,
  now,
  nowMs,
  labelOf,
  older,
  onLoadOlder,
  onRetryActivity,
  activityUnreadable,
  activityRetryAt = null,
  nextStep,
  emptyNote,
  className,
}: {
  readonly data: LiveDashboard;
  readonly now: string;
  /** The browser's clock, for the retry countdown only. */
  readonly nowMs: number;
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
  /** The one thing to do next. Shown INSTEAD of the summary before a vault exists. */
  readonly nextStep: ReactNode;
  readonly emptyNote?: string;
  readonly className?: string;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const rows: readonly LiveRow[] = filter === "all" ? data.rows : data.rows.filter((row) => KINDS[filter].has(row.event.kind));

  const oldest = data.rows.at(-1);
  const since = oldest?.at ?? null;
  // From settlementRows, not the feed: a settlement found on a wallet's link
  // is not in the vault's page, and the footer must not contradict the strip.
  const settlements = data.settlementRows.length;
  const retryIn = secondsUntil(older.retryAt, nowMs);

  const frame = (children: ReactNode) => <div className={cn("flex min-w-0 flex-1 flex-col gap-4 p-4 lg:gap-6 lg:p-6", className)}>{children}</div>;

  // No vault: no total to show, and nothing was ever asked for to be complete.
  // The sidebar says why the feed is empty; this column says what to do about it.
  if (data.stage === "no_vault") return frame(nextStep);

  return frame(
    <>
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
              nowMs={nowMs}
              {...(onRetryActivity === undefined ? {} : { onRetry: onRetryActivity })}
              emptyNote={filter === "all" ? emptyNote : ACTIVITY_COPY.noneInFilter}
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <FeedFooter transactions={data.rows.length} settlements={settlements} />
            {older.complete ? (
              <span className="text-xs text-muted-foreground">{ACTIVITY_COPY.complete}</span>
            ) : !older.available ? null : (
              <Button type="button" size="sm" variant="outline" disabled={older.busy || retryIn !== null} onClick={onLoadOlder}>
                {older.busy ? ACTIVITY_COPY.loadingOlder : retryIn === null ? ACTIVITY_COPY.loadOlder : LIVE_COPY.retryIn(retryIn)}
              </Button>
            )}
          </div>

          {older.message === null ? null : (
            <p role="status" className="text-xs text-muted-foreground">
              {older.message}
            </p>
          )}
        </CardContent>
      </Card>
    </>,
  );
}
