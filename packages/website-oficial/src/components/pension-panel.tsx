import { CopyButton } from "@/components/copy-button";
import { Num } from "@/components/num";
import { PensionChart } from "@/components/pension-chart";
import { PensionHoldings } from "@/components/pension-holdings";
import { PensionStats, SaveCalendar } from "@/components/pension-stats";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { LABEL, SAVED } from "@/lib/classes";
import { dateLabel, pct, usd, usdSigned } from "@/lib/format";
import { ACTIVITY_COPY, LIVE_COPY } from "@/lib/live-copy";
import { cn } from "@/lib/utils";
import { shortAddress } from "@/lib/vault-copy";
import type { Holding, SavingsDay, SavingsPoint, SavingsRule, SavingsStats, Trade } from "@/mocks/types";

/**
 * WHAT A LIVE PAGE ADDS TO THE HERO (live/use-arrivals.ts): the pill beside
 * "Saved so far" when savings have just arrived — "+$0.43 saved · 14:32 UTC".
 * `pill` is the newest one's words, kept after it lapses so it fades out over
 * them; `shown` is whether it is up. No count-up and no flash on any figure
 * (owner, 10-09): the pill is the one mark.
 */
export interface HeroPulse {
  readonly pill: { readonly text: string; readonly title: string | null } | null;
  readonly shown: boolean;
}

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
  unit,
  calendar,
  vault,
  trades,
  pulse,
  className,
}: {
  stats: SavingsStats;
  curve: readonly SavingsPoint[];
  holdings: readonly Holding[];
  days: readonly SavingsDay[];
  /** The week squares' own days (a live page): the last thirteen weeks, unknown days null. Absent: `days`. */
  calendar?: readonly SavingsDay[];
  /** The vault's account, under the total — a live page. */
  vault?: { readonly address: string; readonly href: string };
  /** Every save with its time, for the chart's hourly view. */
  trades?: readonly Trade[];
  rule: SavingsRule;
  now: string;
  /** The curve's unit when it is not dollars: a live page that could not read a price. */
  unit?: "SOL";
  /** A live page's arrivals: the pill beside the label. Absent on the sample, which keeps its bare label. */
  pulse?: HeroPulse;
  className?: string;
}) {
  const savedToday = stats.savedTodayUsd !== null && stats.savedTodayUsd > 0;
  // What the rate is taken from, in the vault's own words: the sample measures
  // volume, a live vault today measures profit.
  const measure = rule.mode === "profit" ? "of trading gains" : "of every buy and sell";
  // A dollar here is SOL at the one price this page read. Said on the figure,
  // where the question arises, rather than on a line of its own.
  const priced = stats.pricedToday === true ? ACTIVITY_COPY.atTodaysPrice : undefined;

  // The hero row switches on the card's width, not the viewport's: at lg the page
  // grid can hand this card ~312px while the row needs ~344px. Named, because the
  // stock CardHeader is a container of its own and an unnamed @md would query it.
  return (
    // One step tighter on desktop (12px, the card's own "sm" spacing): every
    // pixel of padding here is a pixel the holdings needed to stay on screen.
    <Card className={cn("@container/panel overflow-hidden xl:[--card-spacing:--spacing(3)]", className)}>
      <CardHeader className="flex flex-col gap-4 @md/panel:flex-row @md/panel:items-start @md/panel:justify-between">
        <div className="space-y-1">
          {pulse === undefined ? (
            <p className={LABEL}>Saved so far</p>
          ) : (
            /*
             * THE LABEL'S OWN 16 px LINE, with the pill in it: h-4 is LABEL's
             * line, and the pill is always mounted while a live page passes
             * `pulse` — faded out, not removed — so the hero never changes
             * height when a saving arrives or its pill lapses. Reduced motion:
             * it appears and goes without the fade.
             */
            <div className="flex h-4 min-w-0 items-center gap-2">
              <p className={cn(LABEL, "shrink-0")}>Saved so far</p>
              <span
                className={cn(
                  "block h-4 min-w-0 truncate rounded-full bg-emerald-500/12 px-1.5 text-[11px] leading-4 tabular-nums transition-opacity duration-300 motion-reduce:transition-none",
                  SAVED,
                  pulse.shown && pulse.pill !== null ? "opacity-100" : "opacity-0",
                )}
                {...(pulse.shown && pulse.pill !== null ? (pulse.pill.title === null ? {} : { title: pulse.pill.title }) : { "aria-hidden": true })}
              >
                {pulse.pill?.text}
              </span>
            </div>
          )}
          <p
            className="font-mono text-4xl font-semibold tracking-tight tabular-nums sm:text-5xl xl:short:text-4xl"
            // The chain's own figure, in full, and that the dollar is it at one price read now.
            {...(stats.totalSavedSol === undefined || stats.totalSavedSol === null || priced === undefined ? {} : { title: LIVE_COPY.heroSolAtPrice(stats.totalSavedSol) })}
          >
            {/* No price read: the chain's own figure leads rather than a dash — it is already SOL, so there is nothing to qualify. */}
            {stats.totalSavedUsd === null && stats.totalSavedSol !== undefined && stats.totalSavedSol !== null ? `${stats.totalSavedSol} SOL` : usd(stats.totalSavedUsd)}
          </p>
          {/*
            THE RULE IS TODAY'S; THE TOTAL IS SINCE THE FIRST SAVE. A vault that
            switched mode (09-25: profit, then volume at 1 %) saved under both,
            and "1 % of every buy and sell, since Sep 18" claimed the whole total
            for today's rule. So the rule says "now" and the date stands apart.
          */}
          <CardDescription>
            Now <Num>{pct(rule.rateBps)}</Num> {measure}
            {stats.firstSaveAt ? (
              <>
                {" "}
                · saving since <Num>{dateLabel(stats.firstSaveAt)}</Num>
              </>
            ) : null}
          </CardDescription>
          {/* THE VAULT ITSELF, under what it holds (owner, 09-25): its address, a copy, and the explorer. */}
          {vault === undefined ? null : (
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              Vault{" "}
              <a href={vault.href} target="_blank" rel="noopener noreferrer" title={LIVE_COPY.solscanAccount} className="font-mono underline-offset-4 hover:text-foreground hover:underline">
                {shortAddress(vault.address)}
              </a>
              <CopyButton value={vault.address} />
            </p>
          )}
        </div>

        {/*
          THE DAYS A SAVE HAPPENED, beside the figure they add up to — up here
          where the header had room to spare, rather than a row of its own
          under the stats that pushed the holdings below the fold. Hidden until
          the card is wide enough to hold three things in a row.
        */}
        <div className="hidden @2xl/panel:flex @2xl/panel:self-center">
          <SaveCalendar days={calendar ?? days} now={now} />
        </div>

        <dl className="grid grid-cols-2 gap-3 @md/panel:shrink-0 @md/panel:grid-cols-1 @md/panel:text-right">
          <div className="space-y-1">
            <dt className="text-xs text-muted-foreground">Pension value</dt>
            <dd className="font-mono text-sm tabular-nums" {...(priced === undefined ? {} : { title: "at today's prices" })}>
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
          {/* A day the loaded history cannot prove has no total — and "$0.00" there would be a claim. */}
          {stats.savedTodayUsd === null ? null : (
            <div className="space-y-1">
              <dt className="text-xs text-muted-foreground">Today</dt>
              <dd className={cn("font-mono text-sm tabular-nums", savedToday ? SAVED : "text-muted-foreground")} {...(priced === undefined ? {} : { title: priced })}>
                {savedToday ? `+${usd(stats.savedTodayUsd)}` : usd(0)}
              </dd>
            </div>
          )}
        </dl>
      </CardHeader>

      {/* On xl the chart is what grows: the card fills the row, and this takes whatever the figures around it leave. */}
      <CardContent className="xl:flex xl:min-h-0 xl:flex-1 xl:flex-col">
        <PensionChart
          curve={curve}
          now={now}
          {...(trades === undefined ? {} : { saves: trades })}
          {...(unit === undefined ? {} : { unit })}
          settledOutsideHistory={stats.settledOutsideHistory === true}
          className="h-64 w-full sm:h-72 xl:h-auto xl:min-h-32 xl:flex-1 xl:short:min-h-28"
        />
      </CardContent>

      <CardContent className="space-y-6 xl:space-y-4">
        <PensionStats stats={stats} days={days} now={now} {...(rule.mode === undefined ? {} : { mode: rule.mode })} />
        <PensionHoldings holdings={holdings} rule={rule} stats={stats} />
      </CardContent>
    </Card>
  );
}
