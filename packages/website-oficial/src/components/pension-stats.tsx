"use client";

import type { FocusEvent, KeyboardEvent, ReactNode } from "react";

import { Num } from "@/components/num";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { LABEL, MONO } from "@/lib/classes";
import { count, relativeDayLabel, usd, usdCompact } from "@/lib/format";
import { ACTIVITY_COPY } from "@/lib/live-copy";
import { cn } from "@/lib/utils";
// The leaf, not the barrel: `@/mocks` also re-exports the seeded dataset, and this file ships to the browser.
import type { SavingsDay, SavingsStats } from "@/mocks/types";

/** A word inside a tile value ("day", "of") steps down to the sentence face, so only the digits carry the number weight. */
function Word({ children }: { children: ReactNode }) {
  return <span className="text-sm font-normal text-muted-foreground">{children}</span>;
}

/**
 * Eight facts about the saving, as a tile grid, and under them a quiet
 * 13-week strip of the days a save happened. Client only for the strip's
 * focus handlers — nothing here holds state, and every date goes through
 * the UTC formatters.
 */
/**
 * HOW FAR THE LAST TILE STRETCHES, so a part-filled row has no hole in it.
 *
 * The grid's own background is the border colour showing through a 1px gap, so
 * an empty cell is not empty space: it is a grey rectangle the shape of a tile,
 * and it reads as a figure that failed to load. The sample always has eight
 * tiles and never needs this; a live page leaves out every tile it has no
 * figure for, so its count is whatever the chain could answer. Spelled out
 * rather than built: Tailwind reads the classes out of the source.
 */
function lastSpan(count: number): string {
  if (count % 4 === 0) return "";
  const two = count % 2 === 1 ? "col-span-2" : "";
  const rest = count % 4;
  const four = rest === 1 ? "@xl:col-span-4" : rest === 2 ? "@xl:col-span-3" : "@xl:col-span-2";
  return `${two} ${four}`;
}

interface Tile {
  readonly label: string;
  readonly value: ReactNode;
  readonly sub: ReactNode;
  /** What the value is, where the figure alone could be misread: "at today's SOL price". */
  readonly title?: string;
}

/**
 * Eight facts about the saving, as a tile grid, and under them a quiet
 * 13-week strip of the days a save happened. Client only for the strip's
 * focus handlers — nothing here holds state, and every date goes through
 * the UTC formatters.
 *
 * A LIVE PENSION FILLS THE SAME EIGHT SLOTS WITH WHAT THE CHAIN RECORDS
 * (`stats.vocabulary`). It has no trades, only the settlements taken from
 * them, so the two tiles that count trades count settlements under that name;
 * and where the sample shows volume a profit vault shows the gains its rule
 * measured. A tile whose figure the chain cannot answer is left out rather than
 * printed as a dash in a box — and every other word is the sample's own.
 */
export function PensionStats({
  stats,
  days,
  now,
  mode,
  className,
}: {
  stats: SavingsStats;
  days: readonly SavingsDay[];
  now: string;
  /** What the rule is taken from; decides whether the third tile is volume or gains. */
  mode?: "volume" | "profit";
  className?: string;
}) {
  const live = stats.vocabulary === "settlements";
  const priced = stats.pricedToday === true ? ACTIVITY_COPY.atTodaysPrice : undefined;
  const titled = (title: string | undefined): { readonly title?: string } => (title === undefined ? {} : { title });

  const candidates: readonly (Tile | null)[] = [
    stats.savedThisWeekUsd === null
      ? null
      : {
          label: "This week",
          value: <Num>{usd(stats.savedThisWeekUsd)}</Num>,
          sub:
            stats.savedThisMonthUsd === null ? (
              ""
            ) : (
              <>
                <Num>{usd(stats.savedThisMonthUsd)}</Num> this month
              </>
            ),
          ...titled(priced),
        },
    stats.avgSavedPerTradeUsd === null
      ? null
      : {
          label: live ? "Avg per settlement" : "Avg per trade",
          value: <Num>{usd(stats.avgSavedPerTradeUsd)}</Num>,
          sub:
            stats.trades === null ? (
              ""
            ) : (
              <>
                <Num>{count(stats.trades)}</Num> {live ? (stats.trades === 1 ? "settlement" : "settlements") : "trades"}
              </>
            ),
          ...titled(priced),
        },
    stats.volumeUsd === null
      ? null
      : {
          // What the rate was taken from. On a profit vault that is the gains, not the volume.
          label: live && mode === "profit" ? "Gains measured" : "Volume",
          value: <Num>{usdCompact(stats.volumeUsd)}</Num>,
          sub:
            stats.volumeThisMonthUsd === null ? (
              ""
            ) : (
              <>
                <Num>{usdCompact(stats.volumeThisMonthUsd)}</Num> this month
              </>
            ),
          ...titled(priced),
        },
    stats.bestTradeSavedUsd === null
      ? null
      : {
          label: "Biggest",
          value: <Num>{usd(stats.bestTradeSavedUsd)}</Num>,
          // Over what is loaded, unless everything is: a record over a page is not a lifetime's.
          // Short enough not to wrap: a second line here makes the whole first row of tiles taller.
          sub: !live ? "put aside by one trade" : stats.complete === true ? "by one settlement" : "in the loaded history",
          ...titled(priced),
        },
    stats.currentStreakDays === null
      ? null
      : {
          label: "Streak",
          value: (
            <>
              <Num>{count(stats.currentStreakDays)}</Num> <Word>{stats.currentStreakDays === 1 ? "day" : "days"}</Word>
            </>
          ),
          sub:
            stats.longestStreakDays === null ? (
              ""
            ) : (
              <>
                longest <Num>{count(stats.longestStreakDays)}</Num>
              </>
            ),
        },
    {
      label: "Investments",
      value: <Num>{count(stats.investments)}</Num>,
      sub:
        live && stats.complete !== true ? (
          "in the loaded history"
        ) : stats.thresholdUsd === null ? (
          ""
        ) : (
          <>
            every <Num>{usd(stats.thresholdUsd)}</Num>
          </>
        ),
    },
    stats.activeDays === null
      ? null
      : {
          label: "Active days",
          value: (
            <>
              <Num>{count(stats.activeDays)}</Num> <Word>of</Word> <Num>{count(days.length)}</Num>
            </>
          ),
          sub: "days with a save",
        },
    stats.projectedYearUsd === null ? null : { label: "At this pace", value: <Num>{usd(stats.projectedYearUsd)}</Num>, sub: "over a year", ...titled(priced) },
  ];
  const tiles = candidates.filter((tile): tile is Tile => tile !== null);

  return (
    <section className={cn("@container space-y-3 xl:space-y-2", className)} aria-labelledby="pension-stats-heading">
      <div className="flex items-center justify-between">
        <h3 id="pension-stats-heading" className="text-sm font-medium">
          Stats
        </h3>
      </div>

      {/* Four-up keys on the card's width, not the viewport: from md the panel shares its row, and under a 576px card four tiles cannot hold "$1,309.78" — overflow-hidden would clip the figure. */}
      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border @xl:grid-cols-4">
        {tiles.map((tile, index) => (
          <div key={tile.label} className={cn("min-w-0 space-y-1 bg-card p-4 xl:px-4 xl:py-2.5 xl:short:py-2", index === tiles.length - 1 && lastSpan(tiles.length))}>
            <dt className={LABEL}>{tile.label}</dt>
            <dd className="text-lg font-medium whitespace-nowrap" {...titled(tile.title)}>
              {tile.value}
            </dd>
            <dd className="text-xs text-muted-foreground">{tile.sub}</dd>
          </div>
        ))}
      </dl>

    </section>
  );
}

/** One column per week; paired with the strip's `grid-rows-7`, which Tailwind needs spelled out. */
const ROWS = 7;

/** Every cell in the same strip. The grid is the scope, so a wrapper node between it and the cells could not break the walk. */
function cells(cell: HTMLButtonElement): HTMLButtonElement[] {
  const grid = cell.closest("[data-save-calendar]");
  return grid ? Array.from(grid.querySelectorAll<HTMLButtonElement>("[data-day-cell]")) : [cell];
}

/**
 * Roving tabindex, as in the feed: ninety cells would otherwise be ninety
 * Tab stops (each opening its tooltip) at the tail of the page. Whichever
 * cell gains focus keeps the stop; the rest step out of the Tab order.
 */
function rove(e: FocusEvent<HTMLButtonElement>) {
  for (const cell of cells(e.currentTarget)) cell.tabIndex = cell === e.currentTarget ? 0 : -1;
}

/**
 * A column is a week read top to bottom, so Up/Down walk the days in order
 * (flowing into the next column at the bottom), Left/Right jump a week and
 * Home/End reach the oldest and the newest. Focus moves; `rove` follows.
 */
function step(e: KeyboardEvent<HTMLButtonElement>) {
  const all = cells(e.currentTarget);
  const i = all.indexOf(e.currentTarget);
  const next =
    e.key === "ArrowDown"
      ? all[i + 1]
      : e.key === "ArrowUp"
        ? all[i - 1]
        : e.key === "ArrowRight"
          ? all[i + ROWS]
          : e.key === "ArrowLeft"
            ? all[i - ROWS]
            : e.key === "Home"
              ? all[0]
              : e.key === "End"
                ? all.at(-1)
                : undefined;
  if (!next) return;
  e.preventDefault();
  next.focus();
}

/**
 * One cell per day, oldest at the top-left, newest at the bottom of the last
 * column. Zero is muted; a save is the accent, stepped by quartile so the
 * strip reads as intensity without a legend.
 */
export function SaveCalendar({ days, now }: { days: readonly SavingsDay[]; now: string }) {
  if (days.length === 0) return null;

  const saved = days
    .map((day) => day.savedUsd)
    .filter((value): value is number => value !== null && value > 0)
    .sort((a, b) => a - b);
  const quartile = (q: number): number => saved[Math.min(saved.length - 1, Math.floor(saved.length * q))] ?? 0;
  const q1 = quartile(0.25);
  const q2 = quartile(0.5);
  const q3 = quartile(0.75);

  const tone = (value: number | null): string => {
    if (value === null || value <= 0) return "bg-muted";
    if (value <= q1) return "bg-emerald-500/30";
    if (value <= q2) return "bg-emerald-500/55";
    if (value <= q3) return "bg-emerald-500/80";
    return "bg-emerald-500";
  };

  const weeks = Math.ceil(days.length / ROWS);
  const newest = days.length - 1;

  return (
    <div className="flex items-center gap-3">
      <div
        className="grid grid-flow-col grid-rows-7 gap-1"
        role="group"
        aria-label={`Saved per day, last ${weeks} weeks`}
        data-save-calendar=""
      >
        {days.map((day, index) => {
          const label = `${relativeDayLabel(day.date, now)} · ${usd(day.savedUsd)}`;
          return (
            <Tooltip key={day.date}>
              <TooltipTrigger
                type="button"
                data-day-cell=""
                // The strip's one Tab stop is the newest day, until a cell is focused and `rove` moves it.
                tabIndex={index === newest ? 0 : -1}
                aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight"
                onFocus={rove}
                onKeyDown={step}
                className={cn(
                  "size-2.5 rounded-[2px] outline-none",
                  // Ring outside, not inset: a 10px cell has no room for one within, and the 4px gap keeps it clear of its neighbours.
                  "focus-visible:ring-2 focus-visible:ring-ring",
                  tone(day.savedUsd),
                )}
                // Kept beside the tooltip's aria-describedby: the button has no text, and Radix drops the description on close.
                aria-label={label}
              />
              <TooltipContent className={MONO}>{label}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        Last <Num>{weeks}</Num> {weeks === 1 ? "week" : "weeks"}
      </p>
    </div>
  );
}
