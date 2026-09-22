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
import { LABEL, SAVED } from "@/lib/classes";
import { dateLabel } from "@/lib/format";
import { LIVE_COPY, STATS_COPY } from "@/lib/live-copy";
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

  /**
   * THE HERO IS THE DOLLAR, and the SOL is the caption — the sample's shape,
   * and what the owner asked for.
   *
   * IT IS A VALUATION, NOT A HISTORY. lifetimeSaved is lamports; this is those
   * lamports at the price read in THIS SAME SNAPSHOT, which is a fact about
   * what is held right now. It is NOT the sum of the dollars that were set
   * aside — each settlement happened at a price nobody recorded — and the
   * caption says "valued at today's SOL price" for exactly that reason. The
   * curve below stays in SOL for the same reason, and no dollar figure sits
   * beside this one: two unrelated dollars on one line are an unrealized
   * profit by subtraction, and there is no cost basis on chain to make one.
   *
   * NULL IS NOT ZERO. A total nobody could read must not become "$0.00"; it is
   * the dash, as /activity already says of the same figure. `saved` is the
   * ?? 0n form and may only be used where a zero is harmless.
   */
  const usdNow = vault.lifetimeSaved === null || perSol === null ? null : usdcRawForLamports(vault.lifetimeSaved, perSol);
  // Nine decimals all at 48px is a wall of digits with no figure in it. The
  // tail steps down in SIZE only — muting real digits would read as a rounding,
  // and on this page every digit is one the chain actually holds.
  const [head, tail] = splitDecimal(formatSol(saved));

  // "0.03669412 SOL, valued at today's SOL price · Profit · 20 % of trading gains · since Sep 15, 2026"
  const description = [
    usdNow !== null ? LIVE_COPY.heroSolAtPrice(formatSol(saved)) : perSol === null ? null : LIVE_COPY.heroAbout(formatUsd(usdcRawForLamports(saved, perSol))),
    rate === null ? null : vault.mode === 1 ? LIVE_COPY.heroVolumeNotOffered(rate) : LIVE_COPY.heroProfit(rate),
    vault.createdAt === null || vault.createdAt === 0n ? null : LIVE_COPY.heroSince(dateLabel(new Date(Number(vault.createdAt) * 1_000).toISOString())),
  ].filter((part): part is string => part !== null);

  return (
    <Card className={cn("@container/panel overflow-hidden", className)}>
      <CardHeader className="flex flex-col gap-4 @md/panel:flex-row @md/panel:items-start @md/panel:justify-between">
        <div className="space-y-1">
          <p className={LABEL}>{LIVE_COPY.savedSoFar}</p>
          {vault.lifetimeSaved === null ? (
            <p className="font-mono text-4xl font-semibold tracking-tight tabular-nums sm:text-5xl">{LIVE_COPY.unknownFigure}</p>
          ) : usdNow !== null ? (
            <p className="font-mono text-4xl font-semibold tracking-tight tabular-nums sm:text-5xl">{formatUsd(usdNow)}</p>
          ) : (
            // The pools could not be read. The figure the chain records is
            // still known, so it leads rather than a dash.
            <p className="font-mono font-semibold tracking-tight tabular-nums">
              <span className="text-4xl sm:text-5xl">{head}</span>
              {tail === "" ? null : <span className="text-2xl sm:text-3xl">{tail}</span>}
              <span className="ml-2 text-2xl font-normal text-muted-foreground sm:text-3xl">SOL</span>
            </p>
          )}
          <CardDescription>{description.join(" · ")}</CardDescription>
        </div>

        {/*
          NO SECOND DOLLAR UP HERE. "Worth now" used to sit beside the hero,
          and with the hero in dollars the two became an unrealized profit by
          subtraction — two unrelated quantities in one currency, which is the
          number this card refuses to invent. It still exists, under the
          holdings, where it belongs among the other portfolio totals.

          WHAT TAKES ITS PLACE IS TODAY, IN SOL. It is exact, it cannot be
          subtracted from the hero, and it disappears entirely when the loaded
          history does not reach the start of today — a window that is not
          covered has no total, and "0 SOL" there would be a claim.
        */}
        {stats.savedTodayLamports === null ? null : (
          <dl className="@md/panel:shrink-0 @md/panel:text-right">
            <div className="space-y-1">
              <dt className="text-xs text-muted-foreground">{STATS_COPY.today}</dt>
              <dd className={cn("font-mono text-sm tabular-nums", stats.savedTodayLamports > 0n ? SAVED : "text-muted-foreground")}>
                <Num>{stats.savedTodayLamports > 0n ? `+${formatSol(stats.savedTodayLamports)} SOL` : "0 SOL"}</Num>
              </dd>
            </div>
          </dl>
        )}
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
