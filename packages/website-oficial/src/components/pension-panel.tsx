import { Num } from "@/components/num";
import { PensionChart } from "@/components/pension-chart";
import { PensionHoldings } from "@/components/pension-holdings";
import { PensionStats } from "@/components/pension-stats";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { LABEL, SAVED } from "@/lib/classes";
import { dateLabel, pct, usd, usdSigned } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Holding, SavingsDay, SavingsPoint, SavingsRule, SavingsStats } from "@/mocks/types";

/**
 * The big panel — where the reference played its round. The figure, its
 * curve, the stats and what the pension holds. Server component: the only
 * interaction (the chart's range) lives inside PensionChart.
 */
export function PensionPanel({
  stats,
  curve,
  holdings,
  days,
  rule,
  now,
  className,
}: {
  stats: SavingsStats;
  curve: readonly SavingsPoint[];
  holdings: readonly Holding[];
  days: readonly SavingsDay[];
  rule: SavingsRule;
  now: string;
  className?: string;
}) {
  const savedToday = stats.savedTodayUsd !== null && stats.savedTodayUsd > 0;

  // The hero row switches on the card's width, not the viewport's: at lg the page
  // grid can hand this card ~312px while the row needs ~344px. Named, because the
  // stock CardHeader is a container of its own and an unnamed @md would query it.
  return (
    <Card className={cn("@container/panel overflow-hidden", className)}>
      <CardHeader className="flex flex-col gap-4 @md/panel:flex-row @md/panel:items-start @md/panel:justify-between">
        <div className="space-y-1">
          <p className={LABEL}>Saved so far</p>
          <p className="font-mono text-4xl font-semibold tracking-tight tabular-nums sm:text-5xl">
            {usd(stats.totalSavedUsd)}
          </p>
          <CardDescription>
            <Num>{pct(rule.rateBps)}</Num> of every buy and sell
            {stats.firstSaveAt ? (
              <>
                , since <Num>{dateLabel(stats.firstSaveAt)}</Num>
              </>
            ) : null}
          </CardDescription>
        </div>

        <dl className="grid grid-cols-2 gap-3 @md/panel:shrink-0 @md/panel:grid-cols-1 @md/panel:text-right">
          <div className="space-y-1">
            <dt className="text-xs text-muted-foreground">Pension value</dt>
            <dd className="font-mono text-sm tabular-nums">
              {usd(stats.pensionValueUsd)}
              {/* No cost basis, no gain: a live pension never has this figure, and a "+$0.00" would be a claim. */}
              {stats.unrealizedUsd === null ? null : (
                <>
                  {" "}
                  <span className={stats.unrealizedUsd >= 0 ? SAVED : "text-muted-foreground"}>{usdSigned(stats.unrealizedUsd)}</span>
                </>
              )}
            </dd>
          </div>
          <div className="space-y-1">
            <dt className="text-xs text-muted-foreground">Today</dt>
            <dd className={cn("font-mono text-sm tabular-nums", savedToday ? SAVED : "text-muted-foreground")}>
              {savedToday ? `+${usd(stats.savedTodayUsd)}` : usd(0)}
            </dd>
          </div>
        </dl>
      </CardHeader>

      <CardContent>
        <PensionChart curve={curve} className="h-64 w-full sm:h-72" />
      </CardContent>

      <CardContent className="space-y-6">
        <PensionStats stats={stats} days={days} now={now} />
        <PensionHoldings holdings={holdings} rule={rule} stats={stats} />
      </CardContent>
    </Card>
  );
}
