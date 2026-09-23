import Image from "next/image";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SAVED } from "@/lib/classes";
import { fillLabel, timeAgo, usd, usdSigned } from "@/lib/format";
import { cn } from "@/lib/utils";
// The leaf, not the barrel: `@/mocks` also re-exports the seeded dataset, and this file ships to the browser.
import { tickerLogo, type Trade } from "@/mocks/types";

/**
 * One trade on the strip: its mark and what it put aside. Every fill — buy or
 * sell — puts a slice of its size aside, so every chip normally carries the
 * SAVED accent; the muted "$0.00" only appears when a paused rule let a fill
 * through with nothing set aside. The rest of the story (side, size, when)
 * waits in the tooltip, which the chip reveals on hover or keyboard focus —
 * that is why it renders as a button.
 */
/**
 * A POSITIVE SLICE NEVER READS AS NOTHING. A settlement of a few thousand
 * lamports is well under a cent, and usdSigned would print it "+$0.00" — which
 * says the settlement moved nothing when it moved something.
 */
function faceOf(saved: number | null): string {
  if (saved !== null && saved > 0 && saved < 0.005) return "+<$0.01";
  return usdSigned(saved);
}

export function StripChip({ trade, now, newest = false }: { trade: Trade; now: string; newest?: boolean }) {
  const saved = trade.savedUsd !== null && trade.savedUsd > 0;
  // A fill names its side and size; a live chip is a settlement and brings its own words.
  const detail =
    trade.detail !== undefined
      ? `${trade.detail} · ${timeAgo(trade.at, now)}`
      : `${trade.side === undefined ? trade.symbol : fillLabel(trade.side, trade.symbol)} · ${usd(trade.notionalUsd)} · ${timeAgo(trade.at, now)}`;
  const className = cn(
    "flex h-9 shrink-0 items-center gap-2 rounded-md border px-3 font-mono text-sm tabular-nums outline-none",
    // Focus: 2px and inset, so it reads against the newest chip's resting
    // 1px ring and needs no room outside the border. scroll-mr-8 keeps a
    // focus-scrolled chip clear of the strip's 2rem right-edge fade.
    "scroll-mr-8 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
    // The text shade and its contrast reasoning live with SAVED in classes.ts.
    saved ? cn("border-emerald-500/20 bg-emerald-500/10", SAVED) : "text-muted-foreground",
    newest && "ring-1 ring-ring/40",
  );
  const face = (
    <>
      <Image src={trade.logo ?? tickerLogo(trade.symbol)} alt={trade.symbol} width={14} height={14} className="rounded-full" />
      {faceOf(trade.savedUsd)}
    </>
  );

  return (
    <Tooltip>
      {/* A chip with a real transaction behind it opens it; the sample's have none, so they stay buttons. */}
      {trade.href === undefined ? (
        <TooltipTrigger type="button" className={className}>
          {face}
        </TooltipTrigger>
      ) : (
        <TooltipTrigger asChild>
          <a href={trade.href} target="_blank" rel="noopener noreferrer" aria-label={detail} className={className}>
            {face}
          </a>
        </TooltipTrigger>
      )}
      <TooltipContent>{detail}</TooltipContent>
    </Tooltip>
  );
}
