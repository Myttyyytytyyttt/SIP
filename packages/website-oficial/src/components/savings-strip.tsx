
import type { ReactNode } from "react";

import { Num } from "@/components/num";
import { StripChip } from "@/components/strip-chip";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { pct, usd } from "@/lib/format";
import { STATS_COPY } from "@/lib/live-copy";
import { cn } from "@/lib/utils";
import type { SavingsRule, Trade } from "@/mocks/types";

/** How many trades the strip shows. Trades arrive newest first, so these are the latest. */
const SHOWN = 40;

/**
 * The strip across the top of the main column — where the reference shows
 * past multipliers, SIP shows what each trade put aside, newest at the left.
 * The rate leads, the chips scroll inside themselves, and on wide screens the
 * average over what is shown trails.
 *
 * Server component: nothing here has state. The tooltips are the ui client
 * pieces, and the layout already provides their provider.
 */
/**
 * WHAT ONLY A LIVE PAGE BRINGS TO THE STRIP. Its chips are settlements, so the
 * badge names the rule's measure — "Profit: 20%", which the owner asked for by
 * name (09-22) — and the average counts settlements. And one state the sample
 * cannot be in: the vault's state records a settlement no loaded page holds.
 * Then the band stays, badge and all, with the one thing that can fill it.
 */
export interface LiveStrip {
  readonly settledOutsideHistory: boolean;
  /**
   * The one thing that can fill an empty band: Load older, counting down on its
   * own (live/LoadOlderButton.tsx), which draws nothing once the history is
   * complete or before a head page has named an older one. A slot rather than
   * its state, so the ticking stays in that leaf and out of this strip.
   */
  readonly loadOlderSlot?: ReactNode;
  /** The settlements that just arrived, by signature (live/use-arrivals.ts): their chips slide in and wear the wash. */
  readonly arrived?: ReadonlySet<string>;
}

export function SavingsStrip({
  trades,
  rule,
  now,
  live,
  className,
}: {
  trades: readonly Trade[];
  rule: SavingsRule;
  now: string;
  live?: LiveStrip;
  className?: string;
}) {
  const shown = trades.slice(0, SHOWN);
  const rate = pct(rule.rateBps);
  // Nothing has ever settled: no band. A history that merely falls short of a
  // settlement the chain records keeps one — the rate, and a way to fetch it.
  if (live !== undefined && shown.length === 0 && !live.settledOutsideHistory) return null;
  // Over the chips whose figure is known: a slice nobody could price is not a zero to average in.
  const priced = shown.map((trade) => trade.savedUsd).filter((value): value is number => value !== null);
  const avg = priced.length > 0 ? priced.reduce((sum, value) => sum + value, 0) / priced.length : null;

  return (
    <div className={cn("flex items-center gap-2", className)} {...(live === undefined ? {} : { role: "group", "aria-label": STATS_COPY.settlementStripLabel })}>
      {/* h-9 rounded-md px-3: the chips' box, so the rate reads as the row's header and not a stray pill. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="secondary" tabIndex={0} className="h-9 shrink-0 rounded-md px-3 font-mono tabular-nums has-data-[icon=inline-start]:pl-2.5">
            {/* The words say what a glyph would: "% Profit: 20%" said it twice, and the sample's "% 2%" too. */}
            {rule.mode === "volume" ? STATS_COPY.stripModeVolume(rate) : STATS_COPY.stripModeProfit(rate)}
          </Badge>
        </TooltipTrigger>
        <TooltipContent>
          {live === undefined ? `${rate} of every buy and sell is put aside` : rule.mode === "volume" ? STATS_COPY.stripBadgeVolume(rate) : STATS_COPY.stripBadgeProfit(rate)}
        </TooltipContent>
      </Tooltip>

      {/*
        -m-px p-px: one pixel of room so the newest chip's ring and any focus
        ring are not clipped by the scroll container. The mask fades the right
        edge — with the scrollbar hidden, it is the only hint there is more.
      */}
      {shown.length === 0 && live !== undefined ? (
        // The chips' own slot, holding the one thing that can fill it — or
        // nothing, when there is nothing older to ask for (LiveStrip above).
        live.loadOlderSlot ?? null
      ) : (
        <div className="-m-px flex min-w-0 flex-1 gap-2 overflow-x-auto p-px [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [mask-image:linear-gradient(to_right,black_calc(100%-2rem),transparent)]">
          {shown.map((trade, index) => (
            <StripChip
              key={trade.id}
              trade={trade}
              now={now}
              newest={index === 0}
              // Only ever passed for a chip that arrived: the sample's chips get no new prop at all.
              {...(live?.arrived?.has(trade.txHash) === true ? { arrived: true } : {})}
            />
          ))}
        </div>
      )}

      {/* "last N": the stats tile below says "Avg per trade" over the lifetime, so this one names its population. */}
      {shown.length === 0 ? null : (
        <p className="ml-auto hidden shrink-0 text-xs text-muted-foreground lg:block">
          {/* One text run between the figures, as the sample has it: split into
              nodes, the browser shapes it differently and nudges the glyphs. */}
          avg <Num>{usd(avg)}</Num>
          {` / ${live === undefined ? "trade" : "settlement"} · last `}
          <Num>{shown.length}</Num>
        </p>
      )}
    </div>
  );
}
