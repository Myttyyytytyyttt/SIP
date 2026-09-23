"use client";

/**
 * THE BIG PANEL: what has been saved, what it is worth, and what it is held as.
 *
 * ITS HEADER IS THE SAMPLE'S HEADER, word for word wherever the words are still
 * true: the label, one figure, and one short line under it. The sample reads
 * "<rate> of every buy and sell, since <date>" — this vault measures profit, so
 * the same line with this vault's own measure is what it says here.
 *
 * THE HERO IS THE DOLLAR AND THE LAMPORTS ARE ITS TITLE. lifetimeSaved is a
 * lamport figure the vault itself records; the dollar beside it is that figure
 * at the price read in THIS SAME SNAPSHOT, which is a fact about what is held
 * right now and NOT the sum of the dollars that were set aside — each
 * settlement happened at a price nobody recorded. That sentence is the only
 * thing keeping the hero from being read as a history, so it is kept: it moved
 * off a third clause of the description onto the figure's own title=, which
 * leaves the line under the hero the sample's one line and puts the chain's
 * exact figure one hover away rather than one clause of three. The curve below
 * stays in SOL for the same reason, and no second dollar sits beside this one:
 * two unrelated dollars on one line are an unrealized profit by subtraction,
 * and there is no cost basis on chain to make one.
 *
 * WHAT THE SAMPLE HAS AND THIS CANNOT. Its right-hand dl leads with "Pension
 * value +unrealized", and unrealized needs a cost basis this chain does not
 * keep. "Today" is the entry that survives, in the sample's own markup.
 */

import { LiveHoldings } from "@/components/live/LiveHoldings";
import { LiveSavedChart } from "@/components/live/LiveSavedChart";
import { LiveStats } from "@/components/live/LiveStats";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
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
   * NULL IS NOT ZERO. A total nobody could read must not become "$0.00"; it is
   * the dash, as /activity already says of the same figure. `saved` is the
   * ?? 0n form and may only be used where a zero is harmless — which is why the
   * description no longer carries a dollar of its own: the one it used to print
   * when the total was unreadable was "≈ $0.00", under a dash.
   */
  const usdNow = vault.lifetimeSaved === null || perSol === null ? null : usdcRawForLamports(vault.lifetimeSaved, perSol);
  // Nine decimals all at 48px is a wall of digits with no figure in it. The
  // tail steps down in SIZE only — muting real digits would read as a rounding,
  // and on this page every digit is one the chain actually holds.
  const [head, tail] = splitDecimal(formatSol(saved));

  const savedToday = stats.savedTodayLamports !== null && stats.savedTodayLamports > 0n;

  /*
   * "Profit · 20 % of trading gains, since Sep 15, 2026" — the sample's one
   * line, with this vault's own measure where the sample says "every buy and
   * sell", and its comma before "since".
   *
   * THE VOLUME FORM KEEPS ITS TAIL. A rate quoted over a measure nothing is
   * ever taken from is the one rate on this page that is misread without it,
   * and the sentence is three words longer than the profit one.
   */
  const description = [
    rate === null ? null : vault.mode === 1 ? LIVE_COPY.heroVolumeNotOffered(rate) : LIVE_COPY.heroProfit(rate),
    vault.createdAt === null || vault.createdAt === 0n ? null : LIVE_COPY.heroSince(dateLabel(new Date(Number(vault.createdAt) * 1_000).toISOString())),
  ]
    .filter((part): part is string => part !== null)
    .join(", ");

  return (
    <Card className={cn("@container/panel overflow-hidden", className)}>
      <CardHeader className="flex flex-col gap-4 @md/panel:flex-row @md/panel:items-start @md/panel:justify-between">
        <div className="space-y-1">
          <p className={LABEL}>{LIVE_COPY.savedSoFar}</p>
          {vault.lifetimeSaved === null ? (
            <p className="font-mono text-4xl font-semibold tracking-tight tabular-nums sm:text-5xl">{LIVE_COPY.unknownFigure}</p>
          ) : usdNow !== null ? (
            // The caption this figure cannot be read without, on the figure
            // itself: the chain's own lamports, in full, and the fact that the
            // dollar is them at one price read now.
            <p
              title={LIVE_COPY.heroSolAtPrice(formatSol(vault.lifetimeSaved))}
              className="font-mono text-4xl font-semibold tracking-tight tabular-nums sm:text-5xl"
            >
              {formatUsd(usdNow)}
            </p>
          ) : (
            // The pools could not be read. The figure the chain records is
            // still known, so it leads rather than a dash — and it is already
            // the SOL, so there is no valuation to qualify.
            <p className="font-mono font-semibold tracking-tight tabular-nums">
              <span className="text-4xl sm:text-5xl">{head}</span>
              {tail === "" ? null : <span className="text-2xl sm:text-3xl">{tail}</span>}
              <span className="ml-2 text-2xl font-normal text-muted-foreground sm:text-3xl">SOL</span>
            </p>
          )}
          {description === "" ? null : <CardDescription>{description}</CardDescription>}
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
              <dd className={cn("font-mono text-sm tabular-nums", savedToday ? SAVED : "text-muted-foreground")}>
                {savedToday ? `+${formatSol(stats.savedTodayLamports)} SOL` : "0 SOL"}
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
          <LiveStats stats={stats} vault={vault} policy={policy} perSol={perSol} now={now} />
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
