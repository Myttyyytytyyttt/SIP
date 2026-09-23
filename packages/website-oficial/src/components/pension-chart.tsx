"use client";

import { useState } from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { dateLabel, dayLabel, usd, usdCompact } from "@/lib/format";
import { LIVE_COPY } from "@/lib/live-copy";
import { cn } from "@/lib/utils";
import type { SavingsPoint } from "@/mocks/types";

/** The one accent on the page: money put aside. */
const chartConfig = {
  total: { label: "Saved", color: "var(--color-emerald-500)" },
} satisfies ChartConfig;

const RANGES = { "30d": 30, "90d": 90 } as const;
type Range = keyof typeof RANGES;

function isRange(value: string): value is Range {
  return value in RANGES;
}

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
  unit,
  settledOutsideHistory = false,
  className,
}: {
  curve: readonly SavingsPoint[];
  /** The curve's unit when it is not dollars: a live page that could not read a price. */
  unit?: "SOL";
  /**
   * The vault's own state records a settlement the loaded history does not
   * hold. Then no caption may say the first one is still to come.
   */
  settledOutsideHistory?: boolean;
  className?: string;
}) {
  const [range, setRange] = useState<Range>("90d");
  // The curve opens with a baseline point on the day before the first save.
  // A window keeps one point before its first day for the same reason.
  const points = curve.slice(-(RANGES[range] + 1));
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
        value={range}
        onValueChange={(value) => {
          if (isRange(value)) setRange(value);
        }}
        className="absolute top-0 left-0 z-10"
      >
        <TabsList aria-label="Range" className="h-7">
          <TabsTrigger value="30d" className="px-2 text-xs">
            30d
          </TabsTrigger>
          <TabsTrigger value="90d" className="px-2 text-xs">
            90d
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
            tickFormatter={dayLabel}
          />
          {/* "0.045 SOL" needs the room "$4.5K" does not, or it wraps onto two lines. */}
          <YAxis orientation="right" tickLine={false} axisLine={false} width={unit === "SOL" ? 76 : 56} tickFormatter={moneyAxis} />
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={(label) => dateLabel(String(label))}
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
