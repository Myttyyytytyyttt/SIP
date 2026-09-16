"use client";

/**
 * WHAT EACH SETTLEMENT PUT ASIDE, newest at the left.
 *
 * The mock's strip shows a chip per FILL. The chain has no fills, so this shows
 * a chip per SETTLEMENT — the only event the program calls a contribution — and
 * every chip opens that transaction on Solscan. A settlement that moved nothing
 * is a muted "0 SOL" rather than being dropped: it happened, and a strip that
 * silently skips the zeroes overstates how often saving happens.
 */

import { Percent } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatSol, rawFrom } from "@/lib/amounts";
import { SAVED } from "@/lib/classes";
import { timeAgo } from "@/lib/format";
import { ACTIVITY_COPY, LIVE_COPY, STATS_COPY, stripTooltip } from "@/lib/live-copy";
import type { LiveRow, LiveVaultView, VaultEventJson } from "@/lib/live-types";
import { cn } from "@/lib/utils";
import { ratePercent } from "@/lib/vault-copy";

/** How many settlements the strip shows. Rows arrive newest first. */
const SHOWN = 40;

type SettledEvent = Extract<VaultEventJson, { kind: "settled" }>;
type SettledRow = LiveRow & { readonly event: SettledEvent };

const isSettled = (row: LiveRow): row is SettledRow => row.event.kind === "settled";

export function LiveSettlementStrip({
  rows,
  vault,
  now,
  labelOf,
  className,
}: {
  readonly rows: readonly LiveRow[];
  readonly vault: LiveVaultView;
  readonly now: string;
  readonly labelOf: (wallet: string | null) => string;
  readonly className?: string;
}) {
  const shown = rows.filter(isSettled).slice(0, SHOWN);
  // The strip exists to show settlements. With none loaded there is nothing to show.
  if (shown.length === 0) return null;

  const rate = vault.rateBps === null ? null : ratePercent(vault.rateBps);
  const measure = vault.mode === 1 ? ACTIVITY_COPY.measureVolume : ACTIVITY_COPY.measureProfit;
  const badge = rate === null ? null : vault.mode === 1 ? LIVE_COPY.modeVolume(rate) : LIVE_COPY.modeProfit(rate);

  return (
    <div className={cn("flex items-center gap-2", className)} role="group" aria-label={STATS_COPY.settlementStripLabel}>
      {badge === null ? null : (
        <Badge variant="secondary" className="h-9 shrink-0 rounded-md px-3 font-mono tabular-nums has-data-[icon=inline-start]:pl-2.5">
          <Percent aria-hidden data-icon="inline-start" />
          {badge}
        </Badge>
      )}

      {/*
        -m-px p-px: one pixel of room so the newest chip's ring and any focus
        ring are not clipped by the scroll container. The mask fades the right
        edge — with the scrollbar hidden, it is the only hint there is more.
      */}
      <div className="-m-px flex min-w-0 flex-1 gap-2 overflow-x-auto p-px [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [mask-image:linear-gradient(to_right,black_calc(100%-2rem),transparent)]">
        {shown.map((row, index) => (
          <StripChip key={`${row.signature}-${index}`} row={row} now={now} measure={measure} labelOf={labelOf} maxContribution={vault.maxContribution} newest={index === 0} />
        ))}
      </div>

      <p className="ml-auto hidden shrink-0 text-xs text-muted-foreground lg:block">{STATS_COPY.lastSettlements(String(shown.length))}</p>
    </div>
  );
}

function StripChip({
  row,
  now,
  measure,
  labelOf,
  maxContribution,
  newest,
}: {
  readonly row: SettledRow;
  readonly now: string;
  readonly measure: string;
  readonly labelOf: (wallet: string | null) => string;
  readonly maxContribution: bigint | null;
  readonly newest: boolean;
}) {
  const event = row.event;
  const paid = rawFrom(event.paid) ?? 0n;
  const saved = paid > 0n;
  const detail = stripTooltip({
    label: labelOf(event.wallet),
    rate: ratePercent(event.bps),
    base: formatSol(rawFrom(event.baseLamports) ?? 0n),
    measure,
    capped: event.capped && maxContribution !== null ? formatSol(maxContribution) : null,
    when: row.at === null ? ACTIVITY_COPY.timeUnknown : timeAgo(row.at, now),
  });

  const className = cn(
    "flex h-9 shrink-0 items-center gap-1.5 rounded-md border px-3 font-mono text-sm tabular-nums outline-none",
    "scroll-mr-8 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
    saved ? cn("border-emerald-500/20 bg-emerald-500/10", SAVED) : "text-muted-foreground",
    newest && "ring-1 ring-ring/40",
  );

  const label = saved ? `+${formatSol(paid)} SOL` : "0 SOL";
  const body = (
    <>
      {label}
      {/* A cap kept part of this one back; the tooltip says how much. */}
      {event.capped ? (
        <span aria-hidden className="text-[0.625rem] opacity-70">
          cap
        </span>
      ) : null}
    </>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {row.explorerUrl === null ? (
          <span className={className}>{body}</span>
        ) : (
          <a href={row.explorerUrl} target="_blank" rel="noopener noreferrer" className={className}>
            {body}
          </a>
        )}
      </TooltipTrigger>
      <TooltipContent>{detail}</TooltipContent>
    </Tooltip>
  );
}
