"use client";

/**
 * THE DASHBOARD'S LEAD CARD: the headline figure, and under it the running
 * total that reached it — the reference's "Liquidity" card (owner, 10-07:
 * Uniswap's analytics page), in this site's parts.
 *
 * One series, the site's one accent: money put aside. A dashed rule marks where
 * the total stands now, with its figure in a tag on the axis. The ranges are
 * windows onto the same running total, so every one of them ends on the
 * headline.
 *
 * Like the bar card, it prints nothing it read off a curve: the tooltip and the
 * tag print the exact strings each point carries. And a series that could not
 * be read is a band with a sentence — the headline above it still stands.
 */

import { useState } from "react";
import { Area, AreaChart, CartesianGrid, ReferenceLine, XAxis, YAxis } from "recharts";

import { BarsTooltip, Headline, valueText, type HeadlineProps } from "@/components/global-stats-chart";
import { InfoTip } from "@/components/info-tip";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatSolAtMost } from "@/lib/amounts";
import { dateLabel, dayLabel } from "@/lib/format";
import { GLOBAL_STATS_COPY } from "@/lib/global-stats-copy";
import { daysBetween, type Stat, type UtcDay } from "@/lib/global-stats-model";
import { SERIES, axisTick, bucketize, carryIn, cumulative, dayWindow, toPlotRows, unreadDays, type DayValues, type PlotRow, type Unit } from "@/lib/global-stats-series";

const COPY = GLOBAL_STATS_COPY.charts;

const RANGES = ["30d", "90d", "all"] as const;
type Range = (typeof RANGES)[number];

const isRange = (value: string): value is Range => (RANGES as readonly string[]).includes(value);

/** The days a range shows: always ending on the data's day, never shorter than two weeks. */
function rangeWindow(range: Range, end: UtcDay, first: UtcDay | null): readonly UtcDay[] {
  if (range === "30d") return dayWindow(end, first, 30, 14);
  if (range === "90d") return dayWindow(end, first, 90, 14);
  // All: from the first settlement, capped at the series the page keeps.
  return dayWindow(end, first, first === null ? 14 : Math.min(2_000, Math.max(14, daysBetween(first, end) + 1)), 14);
}

/** How wide the axis gutter is: the tag sits in it, beside the plot, never over the newest part of the curve. */
const GUTTER = 68;

/** The figure where the total stands, as a tag in the axis gutter: inverted ink, so it reads on either theme. */
function Tag({ viewBox, text }: { readonly viewBox?: { readonly x?: number; readonly y?: number; readonly width?: number }; readonly text: string }) {
  const x = (viewBox?.x ?? 0) + (viewBox?.width ?? 0) + 2;
  const y = viewBox?.y ?? 0;
  const w = Math.min(GUTTER - 4, Math.max(36, text.length * 6.6 + 10));
  return (
    <g>
      <rect x={x} y={y - 10} width={w} height={20} rx={4} fill="var(--foreground)" />
      <text x={x + w / 2} y={y + 4} textAnchor="middle" fontSize={11} fontWeight={500} fill="var(--background)" className="font-mono">
        {text}
      </text>
    </g>
  );
}

/** The tag's figure: the headline's rounding (four places under 1,000), no unit. */
function axisFigure(raw: string, unit: Unit): string {
  const value = BigInt(raw);
  if (unit.decimals !== 9) return valueText(raw, unit);
  return formatSolAtMost(value, value < 1_000n * 1_000_000_000n ? 4 : value < 1_000_000n * 1_000_000_000n ? 2 : 0);
}

export interface RunningTotalCardProps {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly info: string;
  readonly sample: boolean;
  readonly headline: HeadlineProps;
  /** Per-day amounts of ONE series; the card draws their running total. */
  readonly days: Stat<{ readonly rows: readonly DayValues[]; readonly partial: boolean; readonly missing?: readonly UtcDay[] }>;
  readonly series: "saved";
  readonly unit: Unit;
  readonly end: UtcDay;
  readonly first: UtcDay | null;
  readonly emptyCaption: string;
  readonly unavailableCaption: string;
  readonly className?: string;
}

export function RunningTotalCard(props: RunningTotalCardProps) {
  const { id, title, description, info, sample, headline, days, series, unit, end, first, emptyCaption, unavailableCaption, className } = props;
  const [range, setRange] = useState<Range>("30d");

  return (
    <Card className={className} data-chart-card={id}>
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
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <Headline {...headline} />
          {days.kind === "known" && days.value.rows.length > 0 ? (
            <Tabs
              value={range}
              onValueChange={(value) => {
                if (isRange(value)) setRange(value);
              }}
            >
              <TabsList aria-label={COPY.rangeLabel} className="h-7">
                <TabsTrigger value="30d" className="px-2 text-xs">
                  {COPY.range30}
                </TabsTrigger>
                <TabsTrigger value="90d" className="px-2 text-xs">
                  {COPY.range90}
                </TabsTrigger>
                <TabsTrigger value="all" className="px-2 text-xs">
                  {COPY.rangeAll}
                </TabsTrigger>
              </TabsList>
            </Tabs>
          ) : null}
        </div>
        {/* "Not published yet" is said once, by the page: no empty band under the headline. */}
        {days.kind === "unavailable" && days.reason === "not-served-yet" ? null : days.kind === "unavailable" ? (
          <Band caption={unavailableCaption} />
        ) : days.value.rows.length === 0 ? (
          <Band caption={emptyCaption} />
        ) : (
          <Plot
            id={id}
            title={title}
            series={series}
            unit={unit}
            rows={days.value.rows}
            partial={days.value.partial}
            missing={days.value.missing ?? []}
            keys={rangeWindow(range, end, first)}
            end={end}
          />
        )}
      </CardContent>
    </Card>
  );
}

function Band({ caption }: { readonly caption: string }) {
  return (
    <div className="flex w-full flex-col gap-3">
      <div aria-hidden className="h-28 w-full rounded-lg border border-dashed bg-muted/20" />
      <p className="text-xs text-muted-foreground">{caption}</p>
    </div>
  );
}

function Plot({
  id,
  title,
  series,
  unit,
  rows,
  partial,
  missing,
  keys,
  end,
}: {
  readonly id: string;
  readonly title: string;
  readonly series: "saved";
  readonly unit: Unit;
  readonly rows: readonly DayValues[];
  readonly partial: boolean;
  readonly missing: readonly UtcDay[];
  readonly keys: readonly UtcDay[];
  readonly end: UtcDay;
}) {
  const names = [series];
  const unread = unreadDays(rows, partial, missing);
  const firstKey = keys[0] ?? end;
  const running = cumulative(bucketize(rows, keys, "day", names, end, unread), carryIn(rows, firstKey, names), names, partial || missing.some((day) => day < firstKey));
  const plot = toPlotRows(running, "cumulative", names, unit.decimals);
  const last = plot.at(-1);
  const lastGeometry = typeof last?.[series] === "number" ? (last[series] as number) : 0;
  const config = { [series]: { label: SERIES[series].label, color: SERIES[series].color } } satisfies ChartConfig;
  const fill = `running-fill-${id}`;

  return (
    <div className="space-y-3">
      <ChartContainer config={config} className="aspect-auto h-56 w-full sm:h-64">
        <AreaChart accessibilityLayer data={plot as PlotRow[]} margin={{ top: 12, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={fill} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={`var(--color-${series})`} stopOpacity={0.32} />
              <stop offset="100%" stopColor={`var(--color-${series})`} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="key" tickLine={false} axisLine={false} tickMargin={8} minTickGap={32} tickFormatter={(value) => dayLabel(String(value))} />
          <YAxis orientation="right" tickLine={false} axisLine={false} width={GUTTER} domain={[0, "auto"]} tickFormatter={(value: number) => axisTick(value)} />
          <ChartTooltip cursor={{ stroke: "var(--border)" }} content={<BarsTooltip series={names} unit={unit} period="day" view="cumulative" />} />
          {last === undefined ? null : (
            <ReferenceLine
              y={lastGeometry}
              stroke={`var(--color-${series})`}
              strokeDasharray="4 4"
              strokeOpacity={0.7}
              ifOverflow="extendDomain"
              // The figure without its unit (the headline says SOL), so it fits the gutter; a floor says so.
              label={<Tag text={`${last.unread ? "≥ " : ""}${axisFigure(last.exact[series] ?? "0", unit)}`} />}
            />
          )}
          <Area type="monotone" dataKey={series} stroke={`var(--color-${series})`} strokeWidth={2} fill={`url(#${fill})`} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
        </AreaChart>
      </ChartContainer>

      <div className="sr-only">
      <table>
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">{COPY.daily}</th>
            <th scope="col">{COPY.cumulative}</th>
          </tr>
        </thead>
        <tbody>
          {plot.map((row) => (
            <tr key={row.key}>
              <th scope="row">{dateLabel(row.key)}</th>
              <td>{`${row.unread ? `${COPY.atLeast} ` : ""}${valueText(row.exact[series] ?? "0", unit)}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>

      <p className="text-xs text-muted-foreground">
        {[COPY.runningSince(dateLabel(rows[0]?.day ?? end)), ...(partial || missing.length > 0 ? [COPY.partial] : [])].join(" · ")}
      </p>
    </div>
  );
}
