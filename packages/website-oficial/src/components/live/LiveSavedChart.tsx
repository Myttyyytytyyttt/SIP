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

/**
 * The short band the two curve-less states share.
 *
 * The `sm:` half is not decoration: the caller passes "h-64 w-full sm:h-72",
 * and `cn` only drops a class the later one shadows at the SAME breakpoint. A
 * bare `h-28` would leave `sm:h-72` standing and the band would spring back to
 * 288px on any screen wider than 640px — which is every screen this was a
 * complaint on.
 */
const BAND = "h-28 sm:h-28";

/**
 * A WINDOW WITH NO CURVE IN IT, drawn as a deliberate band rather than as a
 * chart that came back blank.
 *
 * Two states use it and they are not the same. With `level` the total stood
 * still across the window — a true fact, drawn as a rule through the middle
 * with the figure beside it. Without it there is no line at all to draw yet,
 * and the band is empty.
 *
 * RECHARTS DOES NOT DRAW EITHER OF THESE WELL. It has no domain for an empty
 * series and renders nothing; and for a one-value series its default
 * [0, 'auto'] domain fills the plot to the baseline, which painted a pension
 * that saved nothing this week as a 288px block of solid green. CSS is
 * deterministic here, needs no measuring pass, and paints the same on the
 * server as in the browser.
 */
function Band({ level, className }: { readonly level: string | null; readonly className?: string }) {
  return (
    <div aria-hidden className={cn("relative w-full overflow-hidden rounded-lg border border-dashed bg-muted/20", className, BAND)}>
      {level === null ? null : (
        <>
          <div className="absolute inset-x-4 top-1/2 border-t border-dashed border-emerald-500/70" />
          <div className="absolute top-1/2 right-4 -translate-y-1/2 bg-card px-1.5 font-mono text-xs tabular-nums text-muted-foreground">{level}</div>
        </>
      )}
    </div>
  );
}

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
  /**
   * NO CURVE IS STILL A STATE, not a missing element. The sentence used to be
   * returned bare — dropping the `className` the card had reserved a 288px band
   * with — so the panel lost a quarter of its height to one grey line and the
   * page read as half-built. It keeps a frame now, and a SHORT one: the
   * complaint was empty space, and a full-height dashed box is empty space with
   * a border round it.
   *
   * The frame is ruled with CSS, never with an empty recharts chart. A chart
   * with no data has no domain to place gridlines from and draws nothing at
   * all; and a synthesised zero series would draw a line at zero across a window
   * in which the vault's own total says money WAS saved, which is the exact
   * falsehood settlement-not-in-history.test.ts exists to forbid.
   */
  if (points === null || points.length === 0) {
    return (
      <div className="flex w-full flex-col gap-3">
        <Band level={null} {...(className === undefined ? {} : { className })} />
        <p className="text-sm text-muted-foreground">{settledOutsideHistory ? LIVE_COPY.chartOutsideHistory : LIVE_COPY.chartEmpty}</p>
      </div>
    );
  }

  // Recharts plots numbers; the exact lamport figure is kept for the tooltip.
  const data = points.map((point) => ({ at: point.at, total: Number(point.totalLamports) / LAMPORTS, lamports: point.totalLamports.toString() }));
  const oldest = points[0]!.at;

  /**
   * EVERY POINT THE SAME: the window holds no settlement, so the total stood
   * still across it. Compared on the bigints, not on the plotted floats, which
   * are lossy above 2^53 lamports.
   *
   * It is only drawn as a band when the caption underneath EXPLAINS it
   * (chartFlat, below). A level line nobody has accounted for keeps the full
   * chart, axes and all, because the next poll is about to resolve it and a
   * band with no sentence under it would be a fact nobody can check.
   */
  const flat = points.every((point) => point.totalLamports === points[0]!.totalLamports);
  const caption = (
    <p className="text-xs text-muted-foreground">
      {settledOutsideHistory ? `${LIVE_COPY.chartFlat} ` : ""}
      {complete ? LIVE_COPY.chartComplete : LIVE_COPY.chartSince(dateLabel(oldest))}
    </p>
  );

  if (flat && settledOutsideHistory) {
    return (
      <div className="flex w-full flex-col gap-3">
        <Band level={`${formatSol(points[0]!.totalLamports)} SOL`} {...(className === undefined ? {} : { className })} />
        {caption}
      </div>
    );
  }

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
      {caption}
    </div>
  );
}
