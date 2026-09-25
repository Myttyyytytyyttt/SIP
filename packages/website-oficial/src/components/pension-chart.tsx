"use client";

import { useState } from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { clockLabel, dateLabel, dayLabel, usd, usdCompact } from "@/lib/format";
import { LIVE_COPY } from "@/lib/live-copy";
import { cn } from "@/lib/utils";
import type { SavingsPoint, Trade } from "@/mocks/types";

/** The one accent on the page: money put aside. */
const chartConfig = {
  total: { label: "Saved", color: "var(--color-emerald-500)" },
} satisfies ChartConfig;

/*
 * WHAT EACH BUTTON IS: WHAT ONE POINT OF THE LINE STANDS FOR (owner, 09-25).
 *   1h — a point an hour, over the last 7 days;
 *   1d — a point a day, over the last 30 days;
 *   7d — a point a week, over the last 6 months.
 * The daily curve is the one both pages already build; the weekly line is
 * read off it, and the hourly one is rebuilt from each save's own time,
 * working back from the curve's last figure — so all three end on the same
 * total the hero shows.
 */
const RANGES = ["1h", "1d", "7d"] as const;
type Range = (typeof RANGES)[number];

function isRange(value: string): value is Range {
  return (RANGES as readonly string[]).includes(value);
}

const HOUR_MS = 3_600_000;
const HOURS = 7 * 24;
const DAYS = 30;
const WEEKS = 26;

/** A point a day, the last 30 days — and the one before them, so the line has somewhere to start from. */
export const daily = (curve: readonly SavingsPoint[]): readonly SavingsPoint[] => curve.slice(-(DAYS + 1));

/** A point a week, the last 26 weeks, each the total at the end of its week. */
export function weekly(curve: readonly SavingsPoint[]): readonly SavingsPoint[] {
  const window = curve.slice(-(WEEKS * 7 + 1));
  const out: SavingsPoint[] = [];
  for (let index = window.length - 1; index >= 0; index -= 7) out.unshift(window[index]!);
  return out;
}

/**
 * A point an hour, the last 7 days, or null when a save's amount is unknown
 * (prices unread: the curve is then in SOL, and no dollar can be taken off it).
 * Each hour ends on the total less every save made after it.
 */
export function hourly(curve: readonly SavingsPoint[], saves: readonly Trade[], now: string): readonly SavingsPoint[] | null {
  const total = curve.at(-1)?.total;
  if (total === undefined || saves.some((save) => save.savedUsd === null)) return null;
  const times = saves.map((save) => ({ at: Date.parse(save.at), usd: save.savedUsd ?? 0 }));
  const current = Math.floor(Date.parse(now) / HOUR_MS) * HOUR_MS;
  const points: SavingsPoint[] = [];
  for (let back = HOURS - 1; back >= 0; back -= 1) {
    const start = current - back * HOUR_MS;
    const later = times.reduce((sum, save) => (save.at >= start + HOUR_MS ? sum + save.usd : sum), 0);
    points.push({ date: new Date(start).toISOString(), total: Math.max(0, Math.round((total - later) * 100) / 100) });
  }
  return points;
}

/** "Sep 25 14h" on the axis; the tooltip carries the full date and the clock. */
const hourTick = (iso: string): string => `${dayLabel(iso)} ${String(new Date(iso).getUTCHours()).padStart(2, "0")}h`;

/** A SOL figure for an axis or a tooltip: four places at most, trailing zeros dropped. */
const solShort = (value: number): string => `${Number(value.toFixed(4))} SOL`;

/**
 * THE BAND SHORTER THAN THE CHART, deliberately: a full-height dashed box is
 * empty space with a border round it. `cn` resolves the caller's "h-64 sm:h-72"
 * down to this — both breakpoints, or sm:h-72 would spring the band back.
 */
const BAND = "h-28 sm:h-28";

/**
 * A WINDOW WITH NO CURVE TO DRAW, as a band — two states the sample never
 * reaches, because its ninety days always hold a rising line. With `level` the
 * total stood still across the window, a true fact drawn as a rule with the
 * figure beside it. Without it there is no line at all yet. Recharts draws
 * neither well: an empty series renders nothing, and a one-value series fills
 * to the baseline as a block of green the height of the card.
 */
function Band({ level, caption, className }: { readonly level: string | null; readonly caption: string; readonly className?: string }) {
  return (
    <div className="flex w-full flex-col gap-3">
      <div aria-hidden className={cn("relative w-full overflow-hidden rounded-lg border border-dashed bg-muted/20", className, BAND)}>
        {level === null ? null : (
          <>
            <div className="absolute inset-x-4 top-1/2 border-t border-dashed border-emerald-500/70" />
            <div className="absolute top-1/2 right-4 -translate-y-1/2 bg-card px-1.5 font-mono text-xs tabular-nums text-muted-foreground">{level}</div>
          </>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{caption}</p>
    </div>
  );
}

/**
 * The cumulative curve with its y-axis on the right — the reference's
 * round panel. Client only because of recharts and the range tabs; the
 * panel around it stays a server component, so the slicing lives here.
 */
export function PensionChart({
  curve,
  now,
  saves,
  unit,
  settledOutsideHistory = false,
  className,
}: {
  curve: readonly SavingsPoint[];
  /** The page's own clock, for the hourly view's last hour. */
  now: string;
  /** Every save with its time: the hourly view is rebuilt from them. Absent, there is no 1h view. */
  saves?: readonly Trade[];
  /** The curve's unit when it is not dollars: a live page that could not read a price. */
  unit?: "SOL";
  /**
   * The vault's own state records a settlement the loaded history does not
   * hold. Then no caption may say the first one is still to come.
   */
  settledOutsideHistory?: boolean;
  className?: string;
}) {
  const [range, setRange] = useState<Range>("1d");
  const hours = saves === undefined || unit === "SOL" ? null : hourly(curve, saves, now);
  const shown: Range = range === "1h" && hours === null ? "1d" : range;
  const points = shown === "1h" ? hours! : shown === "7d" ? weekly(curve) : daily(curve);
  const money = unit === "SOL" ? solShort : usd;
  const moneyAxis = unit === "SOL" ? solShort : usdCompact;

  // NO CURVE: nothing has been saved yet, or what was saved is not in the
  // history this page loaded. The two are said apart, because the second
  // happened and "your first settlement is still to come" would deny it.
  if (curve.length === 0) {
    return <Band level={null} caption={settledOutsideHistory ? LIVE_COPY.chartOutsideHistory : LIVE_COPY.chartEmpty} {...(className === undefined ? {} : { className })} />;
  }
  // A LEVEL WINDOW THE STATE ACCOUNTS FOR: a rule at the total, and why.
  const flat = curve.every((point) => point.total === curve[0]!.total);
  if (flat && settledOutsideHistory) {
    return <Band level={money(curve[0]!.total)} caption={LIVE_COPY.chartFlat} {...(className === undefined ? {} : { className })} />;
  }

  return (
    // The range tabs float in the plot's top-left corner — where a curve that
    // only ever rises has not reached yet — instead of taking a row of their
    // own: that row was height the holdings needed to be seen without a scroll.
    <div className="relative flex w-full flex-col xl:min-h-0 xl:flex-1">
      <Tabs
        value={shown}
        onValueChange={(value) => {
          if (isRange(value)) setRange(value);
        }}
        className="absolute top-0 left-0 z-10"
      >
        <TabsList aria-label="One point per" className="h-7">
          {hours === null ? null : (
            <TabsTrigger value="1h" className="px-2 text-xs" title="A point an hour, the last 7 days">
              1h
            </TabsTrigger>
          )}
          <TabsTrigger value="1d" className="px-2 text-xs" title="A point a day, the last 30 days">
            1d
          </TabsTrigger>
          <TabsTrigger value="7d" className="px-2 text-xs" title="A point a week, the last 6 months">
            7d
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {/* The panel's h-64/h-72 sizes the plot itself; on the column, the tabs row would eat 44px of it. */}
      <ChartContainer config={chartConfig} className={cn("aspect-auto w-full", className)}>
        <AreaChart accessibilityLayer data={points} margin={{ top: 8, right: 0, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="date"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={40}
            tickFormatter={shown === "1h" ? hourTick : dayLabel}
          />
          {/* "0.045 SOL" needs the room "$4.5K" does not, or it wraps onto two lines. */}
          <YAxis orientation="right" tickLine={false} axisLine={false} width={unit === "SOL" ? 76 : 56} tickFormatter={moneyAxis} />
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={(label) => (shown === "1h" ? `${dateLabel(String(label))} · ${clockLabel(String(label))}` : dateLabel(String(label)))}
                // The stock row formats with toLocaleString(), which the hydration rule forbids.
                formatter={(value, _name, item) => (
                  <>
                    <span aria-hidden className="size-2.5 shrink-0 rounded-[2px]" style={{ backgroundColor: item.color }} />
                    <div className="flex flex-1 items-center justify-between gap-4 leading-none">
                      <span className="text-muted-foreground">{chartConfig.total.label}</span>
                      <span className="font-mono font-medium text-foreground tabular-nums">{money(Number(value))}</span>
                    </div>
                  </>
                )}
              />
            }
          />
          <Area
            type="monotone"
            dataKey="total"
            stroke="var(--color-total)"
            fill="var(--color-total)"
            fillOpacity={0.12}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ChartContainer>
    </div>
  );
}
