"use client";

import { useState } from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { dateLabel, dayLabel, usd, usdCompact } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { SavingsPoint } from "@/mocks";

/** The one accent on the page: money put aside. */
const chartConfig = {
  total: { label: "Saved", color: "var(--color-emerald-500)" },
} satisfies ChartConfig;

const RANGES = { "30d": 30, "90d": 90 } as const;
type Range = keyof typeof RANGES;

function isRange(value: string): value is Range {
  return value in RANGES;
}

/**
 * The cumulative curve with its y-axis on the right — the reference's
 * round panel. Client only because of recharts and the range tabs; the
 * panel around it stays a server component, so the slicing lives here.
 */
export function PensionChart({ curve, className }: { curve: readonly SavingsPoint[]; className?: string }) {
  const [range, setRange] = useState<Range>("90d");
  // The curve opens with a baseline point on the day before the first save.
  // A window keeps one point before its first day for the same reason.
  const points = curve.slice(-(RANGES[range] + 1));

  return (
    <div className="flex w-full flex-col gap-3">
      <div className="flex items-center">
        <Tabs
          value={range}
          onValueChange={(value) => {
            if (isRange(value)) setRange(value);
          }}
          className="ml-auto"
        >
          <TabsList aria-label="Range">
            <TabsTrigger value="30d">30d</TabsTrigger>
            <TabsTrigger value="90d">90d</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

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
          <YAxis orientation="right" tickLine={false} axisLine={false} width={56} tickFormatter={usdCompact} />
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
                      <span className="font-mono font-medium text-foreground tabular-nums">{usd(Number(value))}</span>
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
