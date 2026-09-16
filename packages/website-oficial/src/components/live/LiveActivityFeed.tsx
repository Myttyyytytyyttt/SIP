"use client";

/**
 * THE HISTORY, NEWEST FIRST, grouped by the day it landed.
 *
 * WHAT IS HIDDEN IS COUNTED, NEVER DROPPED. The keeper's own account-keeping
 * transactions name the vault, and a rent top-up arrives as a few thousand
 * lamports; listing either would bury the settlements in noise, and dropping
 * them silently would make this page disagree with Solscan. So they are hidden
 * AND said: "3 account upkeep transactions hidden".
 *
 * AN EMPTY FEED IS NOT AN UNREADABLE ONE. A vault with no history says what will
 * appear here; a read that failed says it failed and offers a retry. Neither
 * ever falls back to the sample.
 *
 * The day headings come from the payload's own `now` (relativeDayLabel), never
 * the clock: a component that reads Date.now() during render paints one string
 * on the server and another in the browser.
 */

import { LiveActivityRow } from "@/components/live/LiveActivityRow";
import { Num } from "@/components/num";
import { Button } from "@/components/ui/button";
import { relativeDayLabel } from "@/lib/format";
import { ACTIVITY_COPY, LIVE_COPY } from "@/lib/live-copy";
import type { LiveRow } from "@/lib/live-types";
import { cn } from "@/lib/utils";

/** Newest first in, newest first out — one bucket per UTC day, in arrival order. */
function groupByDay(rows: readonly LiveRow[]): ReadonlyArray<readonly [string, readonly LiveRow[]]> {
  const groups = new Map<string, LiveRow[]>();
  for (const row of rows) {
    // A transaction the chain gave no block time keeps its own bucket rather
    // than being filed under today, which would be a date nobody can check.
    const key = row.at === null ? "" : row.at.slice(0, 10);
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [row]);
    else bucket.push(row);
  }
  return Array.from(groups);
}

/** What was left out of the feed, and why. Renders nothing when nothing was. */
export function HiddenCounts({ upkeep, dust, className }: { readonly upkeep: number; readonly dust: number; readonly className?: string }) {
  const parts = [upkeep > 0 ? ACTIVITY_COPY.hiddenUpkeep(String(upkeep)) : null, dust > 0 ? ACTIVITY_COPY.hiddenDust(String(dust)) : null].filter(
    (part): part is string => part !== null,
  );
  if (parts.length === 0) return null;
  return <p className={cn("text-xs text-muted-foreground", className)}>{parts.join(" · ")}</p>;
}

/** "12 transactions · 3 settlements", under a feed. One of each counts as one. */
export function FeedFooter({ transactions, settlements, className }: { readonly transactions: number; readonly settlements: number; readonly className?: string }) {
  return (
    <span className={cn("text-xs text-muted-foreground", className)}>
      <Num>{transactions}</Num> {transactions === 1 ? "transaction" : "transactions"} · <Num>{settlements}</Num> {settlements === 1 ? "settlement" : "settlements"}
    </span>
  );
}

export function LiveActivityFeed({
  rows,
  now,
  labelOf,
  maxContribution,
  id,
  unreadable = false,
  onRetry,
  emptyNote,
  className,
}: {
  readonly rows: readonly LiveRow[];
  /** The payload's own clock. Day headings are judged against it, never Date.now(). */
  readonly now: string;
  readonly labelOf: (wallet: string | null) => string;
  readonly maxContribution: bigint | null;
  /** This feed's own scope for the roving Tab stop: the aside and the sheet must never share one. */
  readonly id: string;
  readonly unreadable?: boolean;
  readonly onRetry?: () => void;
  /** What to say instead of rows: the stage's own sentence, when it has one. */
  readonly emptyNote?: string;
  readonly className?: string;
}) {
  if (unreadable) {
    return (
      <div className={cn("space-y-2 px-4 py-6", className)} role="status">
        <p className="text-sm text-muted-foreground">{ACTIVITY_COPY.unreadableNow}</p>
        {onRetry === undefined ? null : (
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            {LIVE_COPY.retry}
          </Button>
        )}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className={cn("px-4 py-6", className)}>
        <p className="text-sm text-muted-foreground">{emptyNote ?? ACTIVITY_COPY.empty}</p>
      </div>
    );
  }

  const groups = groupByDay(rows);
  let position = 0;

  return (
    <div className={className} data-live-feed={id}>
      {groups.map(([day, dayRows]) => (
        <div key={day === "" ? "unknown" : day}>
          <div className="sticky top-0 z-10 bg-background px-4 py-2 text-xs text-muted-foreground">{day === "" ? ACTIVITY_COPY.timeUnknown : relativeDayLabel(day, now)}</div>
          {dayRows.map((row, within) => {
            const first = position === 0;
            position += 1;
            // A transaction can hold two events (two settlements in one settle),
            // so the signature alone is not a key.
            return <LiveActivityRow key={`${row.signature}-${within}-${row.event.kind}`} row={row} labelOf={labelOf} maxContribution={maxContribution} first={first} />;
          })}
        </div>
      ))}
    </div>
  );
}
