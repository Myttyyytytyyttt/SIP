"use client";

/**
 * ONE STACKED-BAR CARD, FOUR USES on the public dashboard: what was put aside,
 * the settlements, the pensions active each day, and what pensions bought.
 *
 * The reference's anatomy in this site's parts: a title with its "?", a line of
 * description, then the view (per period, running total, share), Daily|Weekly,
 * the legend, the bars. Controls are local state, never the URL.
 *
 * WHAT IS PRINTED IS NEVER READ FROM A BAR. recharts needs a number to size a
 * bar; the tooltip prints the exact decimal string each row carries beside it
 * (src/lib/global-stats-series.ts). And the stock tooltip row formats with
 * toLocaleString(), which the hydration rule forbids — so this card draws its
 * own and cannot fall back to it.
 *
 * NO SERIES, NO RECHARTS: an unavailable or empty series is a dashed band with
 * a sentence, returned before any chart element — recharts draws an empty
 * series as nothing at all.
 */

import { useState, type ReactElement } from "react";
import { ChartColumnStacked, ChartLine, Percent } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Rectangle, XAxis, YAxis } from "recharts";

import { InfoTip } from "@/components/info-tip";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { formatSolAtMost, formatUsd } from "@/lib/amounts";
import { count, dateLabel, dayLabel, pct, weekLabel } from "@/lib/format";
import { GLOBAL_STATS_COPY } from "@/lib/global-stats-copy";
import type { Raw, Stat, UtcDay } from "@/lib/global-stats-model";
import {
  SERIES,
  axisTick,
  bucketize,
  carryIn,
  cumulative,
  dayWindow,
  toPlotRows,
  unreadDays,
  weekWindow,
  type DayValues,
  type Period,
  type PlotRow,
  type SeriesKey,
  type Unit,
  type View,
} from "@/lib/global-stats-series";
import { cn } from "@/lib/utils";

const COPY = GLOBAL_STATS_COPY.charts;

/** The surface left between two stacked segments, in pixels. */
const GAP = 2;

/** A value as the tooltip prints it: from the exact string, in its own unit. A time series never wears "$". */
export function valueText(raw: Raw, unit: Unit): string {
  const value = BigInt(raw);
  if (unit.decimals === 9) return `${formatSolAtMost(value, 4)} SOL`;
  // A positive amount never reads as zero: under half a cent is "<0.01", not "0.00".
  if (unit.decimals === 6) return value > 0n && value < 5_000n ? "<0.01 USDC" : `${formatUsd(value).slice(1)} USDC`;
  return count(Number(raw));
}

/**
 * A segment of a stacked bar. Every segment but the lowest gives up GAP pixels
 * at its foot, which leaves the card's own surface between segments; the
 * highest one in the row is rounded. Both are decided from the row itself.
 * A SEGMENT THAT IS THERE IS NEVER ERASED: one too thin to spare the gap keeps
 * at least a pixel, so the rounded top the row gives it is drawn somewhere.
 */
function segment(key: string) {
  return function Segment(props: unknown): ReactElement {
    const { x, y, width, height, fill, payload } = props as { x: number; y: number; width: number; height: number; fill?: string; payload?: PlotRow };
    if (payload === undefined || !(height > 0)) return <g />;
    const shown = payload.bottom === key ? height : height > GAP + 1 ? height - GAP : Math.max(1, height);
    return <Rectangle x={x} y={y} width={width} height={shown} {...(fill === undefined ? {} : { fill })} radius={payload.top === key ? [3, 3, 0, 0] : 0} />;
  };
}

/** The tooltip: the day or week, then each series from the top of the stack, then the total. */
export function BarsTooltip({
  active,
  payload,
  series,
  unit,
  period,
  view,
}: {
  readonly active?: boolean;
  readonly payload?: readonly { readonly payload?: unknown }[];
  readonly series: readonly SeriesKey[];
  readonly unit: Unit;
  readonly period: Period;
  readonly view: View;
}) {
  const row = payload?.[0]?.payload as PlotRow | undefined;
  if (active !== true || row === undefined) return null;
  const heading = [period === "day" ? dateLabel(row.key) : weekLabel(row.key), "UTC"];
  if (row.soFar) heading.push(COPY.soFar);
  if (view === "cumulative") heading.push(COPY.running);
  // NOT A ZERO: a bucket with a day nobody could read shows what was read, as a
  // floor — and when nothing was read, or the view is a share of it, says so.
  const unknown = row.unread && (row.total === "0" || view === "share");
  const floor = row.unread ? `${COPY.atLeast} ` : "";

  return (
    <div role="status" aria-live="polite" className="grid min-w-40 items-start gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
      <div className="font-medium">{heading.join(" · ")}</div>
      {unknown ? (
        <div className="text-muted-foreground">{COPY.unread}</div>
      ) : view === "share" && row.shares === null ? (
        <div className="text-muted-foreground">{COPY.nothingInPeriod}</div>
      ) : (
        <div className="grid gap-1.5">
          {[...series].reverse().map((key) => (
            <div key={key} className="flex items-center gap-2">
              <span aria-hidden className={cn("size-2.5 shrink-0 rounded-[2px]", SERIES[key].swatch)} />
              <div className="flex flex-1 items-center justify-between gap-4 leading-none">
                <span className="text-muted-foreground">{SERIES[key].label}</span>
                <span className="font-mono font-medium text-foreground tabular-nums">
                  {view === "share" ? (
                    <>
                      {pct(row.shares?.[key] ?? null)} <span className="text-muted-foreground">{valueText(row.exact[key] ?? "0", unit)}</span>
                    </>
                  ) : (
                    `${floor}${valueText(row.exact[key] ?? "0", unit)}`
                  )}
                </span>
              </div>
            </div>
          ))}
          {series.length > 1 ? (
            <div className="flex items-center justify-between gap-4 border-t pt-1.5 leading-none">
              <span className="text-muted-foreground">{COPY.total}</span>
              <span className="font-mono font-medium text-foreground tabular-nums">{`${floor}${valueText(row.total, unit)}`}</span>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** The dashed band in place of a chart: nothing to draw, and why. */
function Band({ caption }: { readonly caption: string }) {
  return (
    <div className="flex w-full flex-col gap-3">
      <div aria-hidden className="h-28 w-full rounded-lg border border-dashed bg-muted/20" />
      <p className="text-xs text-muted-foreground">{caption}</p>
    </div>
  );
}

function isPeriod(value: string): value is Period {
  return value === "day" || value === "week";
}

function isView(value: string): value is View {
  return value === "period" || value === "cumulative" || value === "share";
}

const VIEW_ICONS: Readonly<Record<View, { readonly icon: typeof ChartColumnStacked; readonly label: string }>> = {
  period: { icon: ChartColumnStacked, label: COPY.perPeriod },
  cumulative: { icon: ChartLine, label: COPY.cumulative },
  share: { icon: Percent, label: COPY.share },
};

export interface StackedBarsCardProps {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly info: string;
  /** Built from the sample: a badge on the card, so a screenshot of it still says so. */
  readonly sample: boolean;
  /** Bottom of the stack first. */
  readonly series: readonly SeriesKey[];
  readonly unit: Unit;
  /** `partial`: a day with no row may hold settlements. `missing`: days known to be unread. */
  readonly days: Stat<{ readonly rows: readonly DayValues[]; readonly partial: boolean; readonly missing?: readonly UtcDay[] }>;
  /** The last day added up (the data's own day, not the clock's). */
  readonly end: UtcDay;
  /** The first day with a settlement, if known: the window reaches back to it. */
  readonly first: UtcDay | null;
  readonly periods: readonly Period[];
  readonly views: readonly View[];
  /** The sentence for a series that is served and empty. */
  readonly emptyCaption: string;
  /** The sentence for a series that could not be read. */
  readonly unavailableCaption: string;
  /** What a day with something on it is called under the chart: "3 days with a settlement" or "with a purchase". A word, not a function: this crosses from the server. */
  readonly daysOf?: "settlement" | "saving" | "purchase";
  /** A line under the chart, e.g. what each asset took. */
  readonly footer?: string | null;
  readonly className?: string;
}

export function StackedBarsCard(props: StackedBarsCardProps) {
  const { id, title, description, info, sample, series, unit, days, end, first, periods, views, emptyCaption, unavailableCaption, daysOf = "settlement", footer = null, className } = props;
  const [period, setPeriod] = useState<Period>(periods[0] ?? "day");
  const [view, setView] = useState<View>(views[0] ?? "period");

  return (
    <Card className={cn("min-w-0", className)} data-chart-card={id}>
      <CardHeader>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <CardTitle>{title}</CardTitle>
          <InfoTip label={title}>{info}</InfoTip>
          {sample ? (
            <Badge variant="secondary" className="font-normal">
              {GLOBAL_STATS_COPY.sampleCardBadge}
            </Badge>
          ) : null}
        </div>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {days.kind === "unavailable" ? (
          <Band caption={unavailableCaption} />
        ) : days.value.rows.length === 0 ? (
          <Band caption={emptyCaption} />
        ) : (
          <Plot
            series={series}
            unit={unit}
            rows={days.value.rows}
            partial={days.value.partial}
            end={end}
            first={first}
            periods={periods}
            views={views}
            period={period}
            view={view}
            onPeriod={setPeriod}
            onView={setView}
            missing={days.value.missing ?? []}
            title={title}
            daysCaption={daysOf === "purchase" ? COPY.purchaseDays : daysOf === "saving" ? COPY.savingDays : COPY.activeDays}
          />
        )}
        {footer === null ? null : <p className="text-xs text-muted-foreground">{footer}</p>}
      </CardContent>
    </Card>
  );
}

function Plot({
  series,
  unit,
  rows,
  partial,
  missing,
  title,
  end,
  first,
  periods,
  views,
  period,
  view,
  onPeriod,
  onView,
  daysCaption,
}: {
  readonly series: readonly SeriesKey[];
  readonly unit: Unit;
  readonly rows: readonly DayValues[];
  readonly partial: boolean;
  readonly missing: readonly UtcDay[];
  readonly title: string;
  readonly end: UtcDay;
  readonly first: UtcDay | null;
  readonly periods: readonly Period[];
  readonly views: readonly View[];
  readonly period: Period;
  readonly view: View;
  readonly onPeriod: (period: Period) => void;
  readonly onView: (view: View) => void;
  readonly daysCaption: (days: number) => string;
}) {
  const keys = period === "day" ? dayWindow(end, first) : weekWindow(end, first);
  const unread = unreadDays(rows, partial, missing);
  const buckets = bucketize(rows, keys, period, series, end, unread);
  const firstKey = keys[0] ?? end;
  // Anything unread before the window makes every running total a floor.
  const carryUnread = partial || missing.some((day) => day < firstKey);
  const shown = view === "cumulative" ? cumulative(buckets, carryIn(rows, firstKey, series), series, carryUnread) : buckets;
  const plot = toPlotRows(shown, view, series, unit.decimals);
  const config = Object.fromEntries(series.map((key) => [key, { label: SERIES[key].label, color: SERIES[key].color }])) satisfies ChartConfig;
  const activeDays = rows.filter((row) => row.day <= end && series.some((key) => BigInt(row.values[key] ?? "0") > 0n)).length;
  const firstServed = rows[0]?.day ?? null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-center gap-2">
          {views.length > 1 ? (
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              spacing={0}
              value={view}
              // Pressing the pressed item hands back "": the view stays.
              onValueChange={(value) => {
                if (isView(value)) onView(value);
              }}
              aria-label={COPY.viewLabel}
            >
              {views.map((option) => {
                const { icon: Icon, label } = VIEW_ICONS[option];
                return (
                  <ToggleGroupItem key={option} value={option} aria-label={label} title={label}>
                    <Icon aria-hidden />
                  </ToggleGroupItem>
                );
              })}
            </ToggleGroup>
          ) : null}
          {periods.length > 1 ? (
            <Tabs
              value={period}
              onValueChange={(value) => {
                if (isPeriod(value)) onPeriod(value);
              }}
            >
              <TabsList aria-label={COPY.periodLabel} className="h-7">
                <TabsTrigger value="day" className="px-2 text-xs">
                  {COPY.daily}
                </TabsTrigger>
                <TabsTrigger value="week" className="px-2 text-xs">
                  {COPY.weekly}
                </TabsTrigger>
              </TabsList>
            </Tabs>
          ) : null}
        </div>
        {series.length > 1 ? (
          <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {series.map((key) => (
              <li key={key} className="flex items-center gap-1.5">
                <span aria-hidden className={cn("size-2.5 shrink-0 rounded-[2px]", SERIES[key].swatch)} />
                {SERIES[key].label}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <ChartContainer config={config} className="aspect-auto h-56 w-full sm:h-64">
        <BarChart accessibilityLayer data={plot as PlotRow[]} margin={{ top: 8, right: 0, bottom: 0, left: 0 }} barCategoryGap="28%">
          <CartesianGrid vertical={false} />
          <XAxis dataKey="key" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} tickFormatter={(value) => dayLabel(String(value))} />
          <YAxis
            orientation="right"
            tickLine={false}
            axisLine={false}
            width={44}
            allowDecimals={unit.decimals !== 0 || view === "share"}
            domain={view === "share" ? [0, 100] : [0, "auto"]}
            tickFormatter={(value: number) => (view === "share" ? `${value}%` : axisTick(value))}
          />
          <ChartTooltip cursor={{ fill: "var(--muted)" }} content={<BarsTooltip series={series} unit={unit} period={period} view={view} />} />
          {series.map((key) => (
            <Bar key={key} dataKey={key} name={SERIES[key].label} stackId="stack" fill={`var(--color-${key})`} maxBarSize={22} isAnimationActive={false} shape={segment(key)} />
          ))}
        </BarChart>
      </ChartContainer>

      {/*
        THE SAME FIGURES AS TEXT, for a screen reader: the bars are a picture
        and the tooltip needs a pointer. Exact strings, as the tooltip prints them.
      */}
      <table className="sr-only">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">{period === "day" ? COPY.daily : COPY.weekly}</th>
            {series.map((key) => (
              <th key={key} scope="col">
                {SERIES[key].label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {plot.map((row) => (
            <tr key={row.key}>
              <th scope="row">{period === "day" ? dateLabel(row.key) : weekLabel(row.key)}</th>
              {series.map((key) => (
                <td key={key}>
                  {row.unread && row.total === "0"
                    ? COPY.unread
                    : view === "share"
                      ? pct(row.shares?.[key] ?? null)
                      : `${row.unread ? `${COPY.atLeast} ` : ""}${valueText(row.exact[key] ?? "0", unit)}`}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      <p className="text-xs text-muted-foreground">
        {[
          daysCaption(activeDays),
          ...(view === "cumulative" && firstServed !== null ? [COPY.runningSince(dateLabel(firstServed))] : []),
          ...(partial || missing.length > 0 ? [COPY.partial] : []),
        ].join(" · ")}
      </p>
    </div>
  );
}
