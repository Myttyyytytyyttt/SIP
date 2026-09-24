"use client";

/**
 * /activity IN THE SAMPLE — the history, full width, in the feed's own look.
 *
 * It used to be the pension page again: the same strip, rule and chart, with
 * only the tab's underline moved, so a judge who pressed Activity saw nothing
 * happen — and on a phone, where there is no sidebar, no activity at all
 * (owner, 09-24). Now the tab is what it says: what happened, newest first,
 * grouped by day, with a line of totals over it and chips to narrow it.
 *
 * THE ROWS ARE THE SIDEBAR'S OWN (activity-row.tsx): the same five tones, the
 * same token marks behind each icon, the same roving focus. A second design of
 * the same list is how the two drift apart. Typed against the mock contract
 * only, so a live page can mount it later without a new shape.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";

import { ActivityRow } from "@/components/activity-row";
import { Num } from "@/components/num";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { groupByDay } from "@/components/wallet-activity";
import { LABEL, MONO } from "@/lib/classes";
import { relativeDayLabel } from "@/lib/format";
import { ACTIVITY_COPY } from "@/lib/live-copy";
import { cn } from "@/lib/utils";
import type { ActivityEvent } from "@/mocks/types";

type Group = "savings" | "investing" | "withdrawals" | "other";
type Filter = "all" | Group;

/**
 * Which chip a row belongs to — the live page's grouping (LiveActivityPage),
 * said in the mock's kinds: money put aside, the pension buying, money taken
 * out, and everything else.
 */
export function groupOf(event: ActivityEvent): Group {
  switch (event.kind) {
    case "trade":
    case "saved":
      return "savings";
    case "invested":
      return "investing";
    case "deposit":
      return "other";
    case "other":
      if (event.icon === "receive") return "savings";
      if (event.icon === "convert" || event.icon === "wrap" || event.icon === "policy") return "investing";
      if (event.icon === "withdraw") return "withdrawals";
      return "other";
  }
}

/** Rows drawn at a time. The sample alone holds hundreds, and a phone should not lay them all out to show the first few. */
export const ACTIVITY_PAGE_ROWS = 50;

const CHIPS: readonly (readonly [Filter, string])[] = [
  ["all", ACTIVITY_COPY.filterAll],
  ["savings", ACTIVITY_COPY.filterSavings],
  ["investing", ACTIVITY_COPY.filterInvesting],
  ["withdrawals", ACTIVITY_COPY.filterWithdrawals],
  ["other", ACTIVITY_COPY.filterOther],
];

/** One figure over the list. `quiet` for a sentence rather than a number (the span the list covers). */
export interface ActivitySummaryItem {
  readonly label: string;
  readonly value: ReactNode;
  readonly quiet?: boolean;
}

export function ActivityMain({
  activity,
  now,
  summary,
  top = null,
  id = "activity-page",
  className,
}: {
  /** Newest first. */
  readonly activity: readonly ActivityEvent[];
  readonly now: string;
  readonly summary: readonly ActivitySummaryItem[];
  /** Over the card: the sample's own notice, so this page is labelled exactly as the pension page is. */
  readonly top?: ReactNode;
  /** Its own id: the sidebar's feed is mounted beside it, and the roving Tab stop of one must not walk the other's rows. */
  readonly id?: string;
  readonly className?: string;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [shown, setShown] = useState(ACTIVITY_PAGE_ROWS);
  /**
   * The row to hand focus to once the rows it named are drawn. Only the LAST
   * "Show more" sets it: that press removes the button it was made from, and
   * focus would otherwise fall to the page itself. The others leave focus on
   * the button, where the next press is.
   */
  const focusRow = useRef<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const index = focusRow.current;
    if (index === null) return;
    focusRow.current = null;
    listRef.current?.querySelectorAll<HTMLElement>("[data-activity-row]")[index]?.focus();
  }, [shown]);
  // A chip for a kind the list does not hold would only ever say "nothing here".
  const present = new Set(activity.map(groupOf));
  const chips = CHIPS.filter(([value]) => value === "all" || present.has(value));
  const matching = filter === "all" ? activity : activity.filter((event) => groupOf(event) === filter);
  const rows = matching.slice(0, shown);
  const left = matching.length - rows.length;
  const groups = groupByDay(rows);
  const firstId = rows[0]?.id;
  const orderOf = new Map(rows.map((event, index) => [event.id, index]));
  const trades = matching.filter((event) => event.kind === "trade").length;

  return (
    <main className={cn("flex min-w-0 flex-1 flex-col gap-4 p-4 lg:gap-6 lg:p-6", className)}>
      {top === null ? null : <div className="rise-in flex flex-col gap-4">{top}</div>}

      <Card className="rise-in rise-d1">
        <CardHeader>
          <h2 className="sr-only">Activity</h2>
          <dl className="flex flex-wrap items-baseline gap-x-8 gap-y-3">
            {summary.map((item) => (
              <div key={item.label} className="space-y-1">
                <dt className={LABEL}>{item.label}</dt>
                <dd className={item.quiet === true ? "text-sm text-muted-foreground" : cn(MONO, "text-2xl font-semibold")}>{item.value}</dd>
              </div>
            ))}
          </dl>
        </CardHeader>

        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={ACTIVITY_COPY.filterLabel}>
            {chips.map(([value, label]) => (
              <Button
                key={value}
                type="button"
                size="sm"
                variant={filter === value ? "secondary" : "outline"}
                aria-pressed={filter === value}
                onClick={() => {
                  setFilter(value);
                  setShown(ACTIVITY_PAGE_ROWS);
                }}
              >
                {label}
              </Button>
            ))}
          </div>

          {/*
            The rows' own scope: ActivityRow's arrows walk this list and no other.
            KEYED ON THE FILTER: the rows keep their one-Tab-stop state on the
            DOM node itself, so a list re-used across chips could keep a row
            that had stepped out of the Tab order and lose the one that held
            the stop — the list then had no Tab stop at all.
          */}
          <div key={filter} ref={listRef} id={id} data-activity-feed="" className="rounded-md border">
            {rows.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted-foreground">{ACTIVITY_COPY.noneInFilter}</p>
            ) : (
              // A day is a heading over its rows, not a landmark: a named <section>
              // per day put dozens of regions in a screen reader's landmark list.
              groups.map(([date, events], index) => (
                <div key={date === "" ? "unknown" : date}>
                  <h3 className={cn("bg-muted/40 px-4 py-2 text-xs font-normal text-muted-foreground", index === 0 ? "rounded-t-md" : "border-t")}>
                    {date === "" ? "Time unknown" : relativeDayLabel(date, now)}
                  </h3>
                  {events.map((event) => (
                    <ActivityRow key={event.id} event={event} now={now} first={event.id === firstId} order={orderOf.get(event.id) ?? 0} />
                  ))}
                </div>
              ))
            )}
          </div>

          {left <= 0 ? null : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => {
                if (left <= ACTIVITY_PAGE_ROWS) focusRow.current = rows.length;
                setShown((count) => count + ACTIVITY_PAGE_ROWS);
              }}
            >
              Show more · <Num>{left}</Num> left
            </Button>
          )}

          <div className="flex justify-between text-xs text-muted-foreground">
            <span>
              <Num>{matching.length}</Num> events
            </span>
            {trades === 0 ? null : (
              <span>
                <Num>{trades}</Num> {trades === 1 ? "trade" : "trades"}
              </span>
            )}
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
