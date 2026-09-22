"use client";

/**
 * THE BIG PANEL: what has been saved, what it is worth, and what it is held as.
 *
 * TWO FIGURES THAT ARE NOT THE SAME THING, and no longer share a word.
 * "Invested so far" is the program's lifetime_invested counter — USDC that
 * invest() has spent — and the holdings' "Basket value" is what the legs are
 * worth at today's prices. On mainnet they diverge whenever SPYx reaches the
 * vault by any other route, and the card used to say "Invested so far $0.00"
 * directly above "Invested $86.41".
 *
 * THE HERO IS SOL, NOT DOLLARS. lifetimeSaved is a lamport figure the vault
 * itself records; the dollar beside it is today's pool price applied to that
 * figure and is labelled as such. The mock's "Pension value +unrealized" is
 * gone: there is no cost basis on chain, so there is no unrealized number to
 * show, and inventing one from today's price would be a claim about a profit
 * nobody made.
 */

import { LiveHoldings } from "@/components/live/LiveHoldings";
import { LiveSavedChart } from "@/components/live/LiveSavedChart";
import { LiveStats } from "@/components/live/LiveStats";
import { Num } from "@/components/num";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatSol, formatUsd, rawFrom, splitDecimal, usdcRawForLamports } from "@/lib/amounts";
import { LABEL } from "@/lib/classes";
import { dateLabel } from "@/lib/format";
import { LIVE_COPY } from "@/lib/live-copy";
import type { LiveDashboard } from "@/lib/live-types";
import { cn } from "@/lib/utils";
import { ratePercent } from "@/lib/vault-copy";

export function LivePensionCard({
  data,
  now,
  complete,
  className,
}: {
  readonly data: LiveDashboard;
  /** The payload's own clock, for every relative time below. */
  readonly now: string;
  /** The loaded history reaches the beginning: the chart's caption says so. */
  readonly complete: boolean;
  readonly className?: string;
}) {
  const { vault, policy, prices, stats, holdings } = data;
  const saved = vault.lifetimeSaved ?? 0n;
  const perSol = rawFrom(prices?.usdcRawPerSol);
  const rate = vault.rateBps === null ? null : ratePercent(vault.rateBps);
  // Nine decimals all at 48px is a wall of digits with no figure in it. The
  // tail steps down in SIZE only — muting real digits would read as a rounding,
  // and on this page every digit is one the chain actually holds.
  const [head, tail] = splitDecimal(formatSol(saved));

  // "≈ $X at today's SOL price · Profit · 20 % of trading gains · since Sep 15, 2026"
  const description = [
    perSol === null ? null : LIVE_COPY.heroAbout(formatUsd(usdcRawForLamports(saved, perSol))),
    rate === null ? null : vault.mode === 1 ? LIVE_COPY.heroVolumeNotOffered(rate) : LIVE_COPY.heroProfit(rate),
    vault.createdAt === null || vault.createdAt === 0n ? null : LIVE_COPY.heroSince(dateLabel(new Date(Number(vault.createdAt) * 1_000).toISOString())),
  ].filter((part): part is string => part !== null);

  return (
    <Card className={cn("@container/panel overflow-hidden", className)}>
      <CardHeader className="flex flex-col gap-4 @md/panel:flex-row @md/panel:items-start @md/panel:justify-between">
        <div className="space-y-1">
          <p className={LABEL}>{LIVE_COPY.savedSoFar}</p>
          <p className="font-mono font-semibold tracking-tight tabular-nums">
            <span className="text-4xl sm:text-5xl">{head}</span>
            {tail === "" ? null : <span className="text-2xl sm:text-3xl">{tail}</span>}
            <span className="ml-2 text-2xl font-normal text-muted-foreground sm:text-3xl">SOL</span>
          </p>
          <CardDescription>{description.join(" · ")}</CardDescription>
        </div>

        <dl className="grid grid-cols-2 gap-3 @md/panel:shrink-0 @md/panel:grid-cols-1 @md/panel:text-right">
          <div className="space-y-1">
            <dt className="text-xs text-muted-foreground">{LIVE_COPY.worthNow}</dt>
            <dd className="font-mono text-sm tabular-nums">
              <Tooltip>
                <TooltipTrigger type="button" className="rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
                  {data.worthNowUsdcRaw === null ? LIVE_COPY.unknownFigure : formatUsd(data.worthNowUsdcRaw)}
                </TooltipTrigger>
                <TooltipContent>{data.worthNowUsdcRaw === null ? LIVE_COPY.pricesUnavailable : LIVE_COPY.worthNowTooltip}</TooltipContent>
              </Tooltip>
            </dd>
          </div>
          <div className="space-y-1">
            <dt className="text-xs text-muted-foreground">{LIVE_COPY.investedSoFar}</dt>
            <dd className="font-mono text-sm tabular-nums">
              {/* The program's own counter, which is NOT the basket's value in the holdings below. */}
              <Tooltip>
                <TooltipTrigger type="button" className="rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
                  <Num>{policy.lifetimeInvested === null ? LIVE_COPY.unknownFigure : formatUsd(policy.lifetimeInvested)}</Num>
                </TooltipTrigger>
                <TooltipContent>{LIVE_COPY.investedSoFarTooltip}</TooltipContent>
              </Tooltip>
            </dd>
          </div>
        </dl>
      </CardHeader>

      <CardContent>
        <LiveSavedChart points={data.chart} complete={complete} settledOutsideHistory={stats.settledOutsideHistory} className="h-64 w-full sm:h-72" />
      </CardContent>

      {/*
        SIDE BY SIDE ONCE THERE IS ROOM FOR BOTH. Stacked, the two sections
        leave the middle of the card empty twice over — four tiles on one line,
        then a two-row table — which is most of the "empty space" this panel was
        complained about for. @4xl (56rem) is measured, not guessed: beside the
        rule card at xl this panel is about 990px at a 1700px window, so a
        threshold of 64rem would never fire on the very screen the complaint
        came from. LiveStats is its own @container, so its 2-up/4-up decision
        follows the half it lands in without a second breakpoint here, and the
        holdings table gets the wider half because it carries four columns.
      */}
      <CardContent>
        <div className="grid gap-6 @4xl/panel:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] @4xl/panel:items-start">
          <LiveStats stats={stats} vault={vault} policy={policy} now={now} />
          <LiveHoldings
            holdings={holdings}
            worthNowUsdcRaw={data.worthNowUsdcRaw}
            notInvestedUsdcRaw={data.notInvestedUsdcRaw}
            rentOnlyLamports={data.rentOnlyLamports}
            tokensReadable={data.tokensReadable}
            pricesKnown={prices !== null}
          />
        </div>
      </CardContent>
    </Card>
  );
}
