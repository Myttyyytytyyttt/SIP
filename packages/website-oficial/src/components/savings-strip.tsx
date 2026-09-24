import { Percent } from "lucide-react";

import { Num } from "@/components/num";
import { StripChip } from "@/components/strip-chip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { pct, usd } from "@/lib/format";
import { ACTIVITY_COPY, LIVE_COPY, STATS_COPY } from "@/lib/live-copy";
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
  /** `available`: a head page named an older one. Without it the button would press on nothing (use-live-dashboard.ts). */
  readonly loadOlder: { readonly busy: boolean; readonly retryIn: number | null; readonly complete: boolean; readonly available: boolean; readonly onClick: () => void };
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
            {/* The words say what the glyph did; "% Profit: 20%" said it twice. */}
            {live === undefined ? <Percent aria-hidden data-icon="inline-start" /> : null}
            {live === undefined ? rate : rule.mode === "volume" ? STATS_COPY.stripModeVolume(rate) : STATS_COPY.stripModeProfit(rate)}
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
        // The chips' own slot, holding the one thing that can fill it. With the
        // history already at its beginning there is nothing older to ask for,
        // and a button that cannot help is worse than no button — nor is there
        // one to press before a head page has said where the older one starts.
        live.loadOlder.complete || !live.loadOlder.available ? null : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-9 shrink-0"
            disabled={live.loadOlder.busy || live.loadOlder.retryIn !== null}
            onClick={live.loadOlder.onClick}
          >
            {live.loadOlder.busy ? ACTIVITY_COPY.loadingOlder : live.loadOlder.retryIn === null ? ACTIVITY_COPY.loadOlder : LIVE_COPY.retryIn(live.loadOlder.retryIn)}
          </Button>
        )
      ) : (
        <div className="-m-px flex min-w-0 flex-1 gap-2 overflow-x-auto p-px [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [mask-image:linear-gradient(to_right,black_calc(100%-2rem),transparent)]">
          {shown.map((trade, index) => (
            <StripChip key={trade.id} trade={trade} now={now} newest={index === 0} />
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
