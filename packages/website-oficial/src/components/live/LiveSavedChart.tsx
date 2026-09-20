"use client";

/**
 * THE CURVE OF WHAT HAS BEEN SAVED, in SOL.
 *
 * IN SOL, NOT DOLLARS, and deliberately. The vault records lifetimeSaved in
 * lamports; a dollar curve would need the SOL price at each past moment, which
 * this app does not have and must not invent by applying today's price to last
 * week's savings. Dollars appear only as "≈ $X at today's price", labelled.
 *
 * NO 30d/90d TABS. The mock's curve is 90 days of seeded history; this one is
 * however much the loaded pages actually cover, and the caption says which —
 * "Since Sep 15" or "Complete history". A range tab over a partial window would
 * be a control that silently changes what the numbers mean.
 *
 * The points are worked BACKWARDS from lifetimeSaved in live-model.ts, so the
 * last point and the hero are the same number by construction.
 *
 * NO POINTS IS NOT "NOTHING HAS HAPPENED". A page of signatures can be all
 * keeper upkeep while the vault's own total says a settlement landed yesterday,
 * and "The chart starts with your first settlement" over that is false. So the
 * caller says whether the STATE records a settlement this history does not
 * hold, and both branches read from it: with no points the empty line says
 * where the settlements are, and with a flat line the caption says why it is
 * level.
 */

import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { formatSol } from "@/lib/amounts";
import { dateLabel, dayLabel } from "@/lib/format";
import { LIVE_COPY } from "@/lib/live-copy";
import type { LiveChartPoint } from "@/lib/live-types";
import { cn } from "@/lib/utils";

/** The one accent on the page: money put aside. */
const chartConfig = {
  total: { label: LIVE_COPY.chartLabel, color: "var(--color-emerald-500)" },
} satisfies ChartConfig;

const LAMPORTS = 1_000_000_000;

/** An axis tick: SOL, to four decimals at most, trailing zeros dropped. */
const axisSol = (value: number): string => `${Number(value.toFixed(4))}`;

export function LiveSavedChart({
  points,
  complete,
  settledOutsideHistory,
  className,
}: {
  readonly points: readonly LiveChartPoint[] | null;
  /** The loaded history reaches the beginning: the caption says so instead of a date. */
  readonly complete: boolean;
  /**
   * The state records a settlement the loaded history does not hold
   * (stats.settledOutsideHistory). REQUIRED: forgetting it is exactly how this
   * chart came to deny a settlement that had already happened.
   */
  readonly settledOutsideHistory: boolean;
  readonly className?: string;
}) {
  if (points === null || points.length === 0) {
    return <p className="text-sm text-muted-foreground">{settledOutsideHistory ? LIVE_COPY.chartOutsideHistory : LIVE_COPY.chartEmpty}</p>;
  }

  // Recharts plots numbers; the exact lamport figure is kept for the tooltip.
  const data = points.map((point) => ({ at: point.at, total: Number(point.totalLamports) / LAMPORTS, lamports: point.totalLamports.toString() }));
  const oldest = points[0]!.at;

  return (
    <div className="flex w-full flex-col gap-3">
      <ChartContainer config={chartConfig} className={cn("aspect-auto w-full", className)}>
        <AreaChart accessibilityLayer data={data} margin={{ top: 8, right: 0, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="at" tickLine={false} axisLine={false} tickMargin={8} minTickGap={40} tickFormatter={(value: string) => dayLabel(String(value))} />
          <YAxis orientation="right" tickLine={false} axisLine={false} width={56} tickFormatter={axisSol} />
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={(label) => dateLabel(String(label))}
                // The stock row formats with toLocaleString(), which the hydration rule forbids.
                formatter={(_value, _name, item) => (
                  <>
                    <span aria-hidden className="size-2.5 shrink-0 rounded-[2px]" style={{ backgroundColor: item.color }} />
                    <div className="flex flex-1 items-center justify-between gap-4 leading-none">
                      <span className="text-muted-foreground">{LIVE_COPY.chartLabel}</span>
                      <span className="font-mono font-medium text-foreground tabular-nums">
                        {formatSol(BigInt((item.payload as { lamports: string }).lamports))} SOL
                      </span>
                    </div>
                  </>
                )}
              />
            }
          />
          <Area type="monotone" dataKey="total" stroke="var(--color-total)" fill="var(--color-total)" fillOpacity={0.12} strokeWidth={1.5} dot={false} isAnimationActive={false} />
        </AreaChart>
      </ChartContainer>
      <p className="text-xs text-muted-foreground">
        {settledOutsideHistory ? `${LIVE_COPY.chartFlat} ` : ""}
        {complete ? LIVE_COPY.chartComplete : LIVE_COPY.chartSince(dateLabel(oldest))}
      </p>
    </div>
  );
}
