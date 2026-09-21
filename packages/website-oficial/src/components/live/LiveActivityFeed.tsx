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

import { useState } from "react";

import { LiveActivityRow } from "@/components/live/LiveActivityRow";
import { secondsUntil } from "@/components/live/LiveStates";
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
  const parts = hiddenWords(upkeep, dust);
  if (parts === null) return null;
  return <p className={cn("text-xs text-muted-foreground", className)}>{parts}</p>;
}

const hiddenWords = (upkeep: number, dust: number): string | null => {
  const parts = [upkeep > 0 ? ACTIVITY_COPY.hiddenUpkeep(String(upkeep)) : null, dust > 0 ? ACTIVITY_COPY.hiddenDust(String(dust)) : null].filter(
    (part): part is string => part !== null,
  );
  return parts.length === 0 ? null : parts.join(" · ");
};

/**
 * THE COUNT, AND THE ROWS IT COUNTS.
 *
 * The keeper's account-keeping is hidden because listing it buries the
 * settlements — but it used to be DISCARDED, so "12 account upkeep
 * transactions hidden" was a sentence nobody could check against Solscan. Now
 * it opens.
 *
 * THE DISCLOSED ROWS NEVER TAKE THE FEED'S TAB STOP while there are visible
 * rows above them: the roving stop belongs to the list a person came for. When
 * there are none — a page where every transaction was upkeep, which is the
 * case this is most worth having for — the first disclosed row takes it,
 * because otherwise nothing in the feed is reachable by Tab at all.
 */
function HiddenTransactions({
  rows,
  upkeep,
  dust,
  now,
  labelOf,
  maxContribution,
  id,
  ownsTabStop,
}: {
  readonly rows: readonly LiveRow[];
  readonly upkeep: number;
  readonly dust: number;
  readonly now: string;
  readonly labelOf: (wallet: string | null) => string;
  readonly maxContribution: bigint | null;
  readonly id: string;
  readonly ownsTabStop: boolean;
}) {
  const [open, setOpen] = useState(false);
  const words = hiddenWords(upkeep, dust);
  if (rows.length === 0 || words === null) return null;
  // One panel id per feed: the aside, the header's sheet and /activity are all
  // mounted at once, and a shared id would point every control at the first.
  const panelId = `${id}-hidden`;

  return (
    <div className="border-t">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((shown) => !shown)}
        className="flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <span>{words}</span>
        <span className="shrink-0 underline underline-offset-4">{open ? ACTIVITY_COPY.hideHidden : ACTIVITY_COPY.showHidden}</span>
      </button>
      <div id={panelId} hidden={!open}>
        {open
          ? groupByDay(rows).map(([day, dayRows]) => (
              <div key={day === "" ? "unknown" : day}>
                <div className="sticky top-0 z-10 bg-background px-4 py-2 text-xs text-muted-foreground">
                  {day === "" ? ACTIVITY_COPY.timeUnknown : ACTIVITY_COPY.dayHeading(relativeDayLabel(day, now))}
                </div>
                {dayRows.map((row, within) => (
                  <LiveActivityRow
                    key={`${row.signature}-${within}-${row.event.kind}`}
                    row={row}
                    labelOf={labelOf}
                    maxContribution={maxContribution}
                    first={ownsTabStop && rows[0] === row}
                  />
                ))}
              </div>
            ))
          : null}
      </div>
    </div>
  );
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
  hiddenRows = [],
  hiddenUpkeep = 0,
  hiddenDust = 0,
  unreadable = false,
  onRetry,
  retryAt = null,
  nowMs,
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
  /** What the feed leaves out, behind a disclosure at its foot. */
  readonly hiddenRows?: readonly LiveRow[];
  readonly hiddenUpkeep?: number;
  readonly hiddenDust?: number;
  readonly unreadable?: boolean;
  readonly onRetry?: () => void;
  /** When the server said the history may be asked for again. The button counts down to it. */
  readonly retryAt?: number | null;
  /** The BROWSER's clock, for that countdown only — never for a label. */
  readonly nowMs?: number;
  /** What to say instead of rows: the stage's own sentence, when it has one. */
  readonly emptyNote?: string;
  readonly className?: string;
}) {
  /**
   * A FAILED READ IS A NOTE ABOVE THE HISTORY, NOT INSTEAD OF IT.
   *
   * The hook deliberately keeps the rows it already has when a poll fails
   * (use-live-dashboard.ts) — and this component then threw every one of them
   * away and drew a grey sentence in a full-height column. The footer below it
   * went on counting them, so the sidebar said "3 transactions" under a feed
   * that showed none. The banner is rendered over the rows now; only a feed
   * that genuinely holds nothing is the banner alone.
   */
  // The server said when it will answer again, so the button says so too
  // rather than offering a press that walks into the same refusal.
  const left = nowMs === undefined ? null : secondsUntil(retryAt ?? null, nowMs);
  const banner = !unreadable ? null : (
    <div className="space-y-2 border-b px-4 py-3" role="status">
      <p className="text-sm text-muted-foreground">{ACTIVITY_COPY.unreadableNow}</p>
      {onRetry === undefined ? null : (
        <Button type="button" variant="outline" size="sm" onClick={onRetry} disabled={left !== null}>
          {left === null ? LIVE_COPY.retry : LIVE_COPY.retryIn(left)}
        </Button>
      )}
    </div>
  );

  const disclosure = (
    <HiddenTransactions
      rows={hiddenRows}
      upkeep={hiddenUpkeep}
      dust={hiddenDust}
      now={now}
      labelOf={labelOf}
      maxContribution={maxContribution}
      id={id}
      ownsTabStop={rows.length === 0}
    />
  );

  if (rows.length === 0) {
    // Unreadable and nothing carried: the banner IS the whole message, and it
    // must never be replaced by "No activity yet" — a read that failed says
    // nothing about whether there is a history.
    //
    // AND "no history" IS A LIE WHEN THE APP IS HOLDING FIFTEEN TRANSACTIONS.
    // A page whose every row was keeper upkeep is the ordinary case on this
    // vault, and it used to print ACTIVITY_COPY.empty over all of them. The
    // stage's own sentence still wins where it has one: "you have no vault
    // yet" and "nothing matches this filter" are about something else.
    const nothing = emptyNote ?? (hiddenRows.length > 0 ? ACTIVITY_COPY.onlyHidden : ACTIVITY_COPY.empty);
    return banner !== null ? (
      <div className={className} data-live-feed={id}>
        {banner}
        {disclosure}
      </div>
    ) : (
      <div className={className} data-live-feed={id}>
        <div className="px-4 py-6">
          <p className="text-sm text-muted-foreground">{nothing}</p>
        </div>
        {disclosure}
      </div>
    );
  }

  const groups = groupByDay(rows);
  let position = 0;

  return (
    <div className={className} data-live-feed={id}>
      {banner}
      {groups.map(([day, dayRows]) => (
        <div key={day === "" ? "unknown" : day}>
          {/* The bucket is a UTC day (groupByDay slices the ISO string), and the heading says so. */}
          <div className="sticky top-0 z-10 bg-background px-4 py-2 text-xs text-muted-foreground">
            {day === "" ? ACTIVITY_COPY.timeUnknown : ACTIVITY_COPY.dayHeading(relativeDayLabel(day, now))}
          </div>
          {dayRows.map((row, within) => {
            const first = position === 0;
            position += 1;
            // A transaction can hold two events (two settlements in one settle),
            // so the signature alone is not a key.
            return <LiveActivityRow key={`${row.signature}-${within}-${row.event.kind}`} row={row} labelOf={labelOf} maxContribution={maxContribution} first={first} />;
          })}
        </div>
      ))}
      {disclosure}
    </div>
  );
}
