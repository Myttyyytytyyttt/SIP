import type { ReactNode } from "react";

import { CopyButton } from "@/components/copy-button";
import { Figure } from "@/components/live/Figure";
import { Num } from "@/components/num";
import { PensionChart } from "@/components/pension-chart";
import { PensionHoldings } from "@/components/pension-holdings";
import { PensionStats, SaveCalendar } from "@/components/pension-stats";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { splitDecimal } from "@/lib/amounts";
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

/** The hero figure's face, and its size: the sample's, and a live page's while the figure is short enough. */
const HERO_FIGURE = "font-mono text-4xl font-semibold tracking-tight tabular-nums sm:text-5xl xl:short:text-4xl";
/** One step smaller on a line of the SAME height (40/48 px), so the hero does not change height. */
const HERO_FIGURE_LONG = "font-mono text-3xl leading-10 font-semibold tracking-tight tabular-nums sm:text-4xl sm:leading-12 xl:short:text-3xl xl:short:leading-10";
/**
 * The no-price figure's digits past the fourth: every one on the page
 * (live/Figure.tsx), at 0.6 em. leading-none, because the long figure's line
 * height is a length (leading-10/12), inherited whole by the smaller tail — whose
 * box then hung 4 px below the line and made the hero taller (measured).
 * The class is spelled out whole, for Tailwind to find.
 */
const HERO_TAIL = { em: 0.6, className: "text-[0.6em] leading-none" } as const;
/**
 * HOW MANY CHARACTERS SHARE THE FIGURE'S LINE WITH THE SHARE BUTTON (review,
 * 10-22). Measured beside the 32 px button and its 12 px gap: 10 at 1440 —
 * the tightest, the save-days squares beside a 48 px figure — 11 at 768, 12 at
 * 375 and 360. One step down, 14 fit at all of them: every dollar figure under
 * $10M, and — under 100 SOL — the chain's nine-decimal SOL shown when no price
 * was read, which at full size wrapped the button under the figure (and at 1440
 * wrapped itself).
 */
const HERO_FITS = 10;

/** A figure's width in characters of its own size: a Figure tail counts at its step. */
export function heroWidth(text: string, tailed: boolean): number {
  if (!tailed) return text.length;
  const [head, rest] = splitDecimal(text, 4);
  const tail = /^\d*/.exec(rest)?.[0] ?? "";
  return head.length + tail.length * HERO_TAIL.em + (rest.length - tail.length);
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
  share,
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
  /**
   * The share button (live/ShareSavings.tsx, owner 10-22), to the right of the
   * figure: a live page's, and the sample's own (MockBody, the same day: "en el
   * mock también puede aparecer pero con los datos del mock claro"), whose card
   * is marked as the example. The figure keeps its size and its line beside it.
   */
  share?: ReactNode;
  className?: string;
}) {
  const savedToday = stats.savedTodayUsd !== null && stats.savedTodayUsd > 0;
  // What the rate is taken from, in the vault's own words: the sample measures
  // volume, a live vault today measures profit.
  const measure = rule.mode === "profit" ? "of trading gains" : "of every buy and sell";
  // A dollar here is SOL at the one price this page read. Said on the figure,
  // where the question arises, rather than on a line of its own.
  const priced = stats.pricedToday === true ? ACTIVITY_COPY.atTodaysPrice : undefined;

  // No price read: the chain's own figure leads rather than a dash — it is already SOL, so there is nothing to qualify.
  const solHero = stats.totalSavedUsd === null && stats.totalSavedSol !== undefined && stats.totalSavedSol !== null ? `${stats.totalSavedSol} SOL` : null;
  // Beside the share button, a figure too long for the line steps down a size (HERO_FITS). The sample's fits at full size (pension-panel.test.ts).
  const long = share !== undefined && heroWidth(solHero ?? usd(stats.totalSavedUsd), solHero !== null) > HERO_FITS;
  const figure = (
    <p
      className={long ? HERO_FIGURE_LONG : HERO_FIGURE}
      // The chain's own figure, in full, and that the dollar is it at one price read now.
      {...(stats.totalSavedSol === undefined || stats.totalSavedSol === null || priced === undefined ? {} : { title: LIVE_COPY.heroSolAtPrice(stats.totalSavedSol) })}
    >
      {/* Nine decimals: every digit stays, the ones past the fourth a size down (live/Figure.tsx) — a figure, not a wall of digits. */}
      {solHero === null ? usd(stats.totalSavedUsd) : <Figure tailClassName={HERO_TAIL.className}>{solHero}</Figure>}
    </p>
  );

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
          {share === undefined ? (
            figure
          ) : (
            /*
             * THE SHARE BUTTON ON THE FIGURE'S OWN LINE (owner, 10-22: right of
             * the number, above the chart). 32 px centred on a 40/48 px line,
             * so the hero keeps its height, and a long figure steps down a size
             * to keep it there (HERO_FITS). Only a figure past even that — 100
             * SOL or more with no price read, at 1440 or 360 — wraps the button
             * under it rather than off the card.
             */
            <div className="flex min-w-0 flex-wrap items-center gap-x-3">
              {figure}
              {share}
            </div>
          )}
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
