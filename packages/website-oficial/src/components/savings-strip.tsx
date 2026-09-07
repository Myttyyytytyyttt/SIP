import { Percent } from "lucide-react";

import { Num } from "@/components/num";
import { StripChip } from "@/components/strip-chip";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { pct, usd } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { SavingsRule, Trade } from "@/mocks";

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
export function SavingsStrip({ trades, rule, now, className }: { trades: readonly Trade[]; rule: SavingsRule; now: string; className?: string }) {
  const shown = trades.slice(0, SHOWN);
  const rate = pct(rule.rateBps);
  const avg = shown.length > 0 ? shown.reduce((sum, trade) => sum + trade.savedUsd, 0) / shown.length : 0;

  return (
    <div className={cn("flex items-center gap-2", className)}>
      {/* h-9 rounded-md px-3: the chips' box, so the rate reads as the row's header and not a stray pill. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="secondary" tabIndex={0} className="h-9 shrink-0 rounded-md px-3 font-mono tabular-nums has-data-[icon=inline-start]:pl-2.5">
            <Percent aria-hidden data-icon="inline-start" />
            {rate}
          </Badge>
        </TooltipTrigger>
        <TooltipContent>{rate} of every buy and sell is put aside</TooltipContent>
      </Tooltip>

      {/*
        -m-px p-px: one pixel of room so the newest chip's ring and any focus
        ring are not clipped by the scroll container. The mask fades the right
        edge — with the scrollbar hidden, it is the only hint there is more.
      */}
      <div className="-m-px flex min-w-0 flex-1 gap-2 overflow-x-auto p-px [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [mask-image:linear-gradient(to_right,black_calc(100%-2rem),transparent)]">
        {shown.map((trade, index) => (
          <StripChip key={trade.id} trade={trade} now={now} newest={index === 0} />
        ))}
      </div>

      {/* "last N": the stats tile below says "Avg per trade" over the lifetime, so this one names its population. */}
      <p className="ml-auto hidden shrink-0 text-xs text-muted-foreground lg:block">
        avg <Num>{usd(avg)}</Num> / trade · last <Num>{shown.length}</Num>
      </p>
    </div>
  );
}
