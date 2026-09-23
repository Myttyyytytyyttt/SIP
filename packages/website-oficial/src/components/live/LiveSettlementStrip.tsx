"use client";

/**
 * WHAT EACH SETTLEMENT PUT ASIDE, newest at the left — savings-strip.tsx and
 * strip-chip.tsx, wired to the chain.
 *
 * The mock's strip shows a chip per FILL. The chain has no fills, so this shows
 * a chip per SETTLEMENT — the only event the program calls a contribution — and
 * every chip opens that transaction on Solscan. A settlement that moved nothing
 * is a muted "0" rather than being dropped: it happened, and a strip that
 * silently skips the zeroes overstates how often saving happens.
 *
 * NO CHIPS IS TWO DIFFERENT FACTS, and only one of them is "nothing to show".
 * A pension that has never settled has no band, and LiveNextStep is the one
 * voice there. But a pension whose settlement the loaded page simply does not
 * hold — twelve of fifteen signatures being keeper upkeep is enough — used to
 * lose the whole row too, and with it the top of the main column: the rate
 * badge is a statement about the vault as it stands today and was never about
 * history at all. So that case keeps the band, and puts the one CONTROL that
 * can fill it in the space the chips would have taken.
 *
 * A BUTTON, NOT A FOURTH SENTENCE. The chart's caption and the Last settlement
 * tile already say the settlement is outside the loaded history; pressing "Load
 * older" is what actually puts the chip, the curve and the Biggest tile back.
 */

import { secondsUntil } from "@/components/live/LiveStates";
import { measureOf } from "@/components/live/LiveActivityRow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AssetMark } from "@/components/live/AssetMark";
import { NATIVE_SOL } from "@/lib/asset-art";
import { formatSol, formatSolAtMost, rawFrom } from "@/lib/amounts";
import { SAVED } from "@/lib/classes";
import { pct, timeAgo } from "@/lib/format";
import type { LiveOlder } from "@/hooks/use-live-dashboard";
import { ACTIVITY_COPY, LIVE_COPY, STATS_COPY, stripTooltip } from "@/lib/live-copy";
import type { LiveRow, LiveVaultView, VaultEventJson } from "@/lib/live-types";
import { cn } from "@/lib/utils";
import { ratePercent } from "@/lib/vault-copy";

/** How many settlements the strip shows. Rows arrive newest first, so these are the latest. */
const SHOWN = 40;

export type SettledEvent = Extract<VaultEventJson, { kind: "settled" }>;
type SettledRow = LiveRow & { readonly event: SettledEvent };

const isSettled = (row: LiveRow): row is SettledRow => row.event.kind === "settled";

/**
 * One chip's tooltip: which wallet it came from, how much of what THAT
 * settlement measured, what a cap kept back, and when.
 *
 * THE MEASURE IS THE EVENT'S OWN, never the vault's mode today. set_policy_v2
 * takes a mode as an argument and validate_policy accepts either, so a vault
 * can be switched — and every chip would then describe its whole history in the
 * new mode's words, while the same transaction's row in the feed (which reads
 * measureOf(event.mode)) says the other.
 */
export function chipDetail(input: {
  readonly event: SettledEvent;
  readonly labelOf: (wallet: string | null) => string;
  readonly maxContribution: bigint | null;
  /** Already in words: "4m ago", or the time-unknown sentence. */
  readonly when: string;
}): string {
  const { event } = input;
  return stripTooltip({
    // THE EXACT AMOUNT LIVES HERE, because the chip's face is rounded to three
    // places to be readable at a glance. Nothing on this page rounds without
    // the whole figure staying one hover away.
    paid: formatSol(rawFrom(event.paid) ?? 0n),
    label: input.labelOf(event.wallet),
    rate: ratePercent(event.bps),
    base: formatSol(rawFrom(event.baseLamports) ?? 0n),
    measure: measureOf(event.mode),
    capped: event.capped && input.maxContribution !== null ? formatSol(input.maxContribution) : null,
    when: input.when,
  });
}

export function LiveSettlementStrip({
  rows,
  vault,
  now,
  labelOf,
  settledOutsideHistory,
  older,
  onLoadOlder,
  nowMs,
  className,
}: {
  readonly rows: readonly LiveRow[];
  readonly vault: LiveVaultView;
  readonly now: string;
  readonly labelOf: (wallet: string | null) => string;
  /**
   * The state records a settlement the loaded history does not hold
   * (stats.settledOutsideHistory). REQUIRED: it is the whole difference between
   * "this pension has never saved" and "this page has not read far enough", and
   * a default would silently pick one.
   */
  readonly settledOutsideHistory: boolean;
  readonly older: LiveOlder;
  readonly onLoadOlder: () => void;
  /** The BROWSER's clock, for the retry countdown only — never for a label. */
  readonly nowMs: number;
  readonly className?: string;
}) {
  const shown = rows.filter(isSettled).slice(0, SHOWN);

  // The BADGE is the vault's rule as it stands today, which is what a badge is
  // for. Each chip's own words come from its own event, below.
  // `pct` and not `ratePercent`: this badge reads "Profit: 20%", tight, the way
  // the sample's does. ratePercent's "20 %" is the spaced form the rule card
  // and the row details use, and both stay as they are.
  const rate = vault.rateBps === null ? null : pct(vault.rateBps);
  const badge = rate === null ? null : vault.mode === 1 ? STATS_COPY.stripModeVolume(rate) : STATS_COPY.stripModeProfit(rate);

  // Nothing has ever settled, or there is not even a rule to state: no band.
  // Only a history that falls short of a settlement the chain records earns one.
  if (shown.length === 0 && !(settledOutsideHistory && badge !== null)) return null;

  const retryIn = secondsUntil(older.retryAt, nowMs);

  return (
    <div className={cn("flex items-center gap-2", className)} role="group" aria-label={STATS_COPY.settlementStripLabel}>
      {badge === null || rate === null ? null : (
        // h-9 rounded-md px-3: the chips' box, so the rate reads as the row's
        // header and not a stray pill. No percent glyph, unlike the sample's:
        // the badge says "20%" in words, and the icon beside it read as
        // "% Profit: 20%". It says what it means on hover, as the sample's does.
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="secondary" tabIndex={0} className="h-9 shrink-0 rounded-md px-3 font-mono tabular-nums">
              {badge}
            </Badge>
          </TooltipTrigger>
          <TooltipContent>{vault.mode === 1 ? STATS_COPY.stripBadgeVolume(rate) : STATS_COPY.stripBadgeProfit(rate)}</TooltipContent>
        </Tooltip>
      )}

      {shown.length === 0 ? (
        // The chips' own slot, holding the one thing that can fill it. With the
        // history already at its beginning there is nothing older to ask for,
        // and a button that cannot help is worse than no button.
        older.complete ? null : (
          <Button type="button" size="sm" variant="outline" className="h-9 shrink-0" disabled={older.busy || retryIn !== null} onClick={onLoadOlder}>
            {older.busy ? ACTIVITY_COPY.loadingOlder : retryIn === null ? ACTIVITY_COPY.loadOlder : LIVE_COPY.retryIn(retryIn)}
          </Button>
        )
      ) : (
        /*
          -m-px p-px: one pixel of room so the newest chip's ring and any focus
          ring are not clipped by the scroll container. The mask fades the right
          edge — with the scrollbar hidden, it is the only hint there is more.
        */
        <div className="-m-px flex min-w-0 flex-1 gap-2 overflow-x-auto p-px [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [mask-image:linear-gradient(to_right,black_calc(100%-2rem),transparent)]">
          {shown.map((row, index) => (
            <StripChip key={`${row.signature}-${index}`} row={row} now={now} labelOf={labelOf} maxContribution={vault.maxContribution} newest={index === 0} />
          ))}
        </div>
      )}

      {/*
        "last N", as the sample trails its strip: the Settlements tile counts
        the loaded history, so this one names its own population — the chips
        shown, which are neither a lifetime nor the whole history.

        GUARDED, because the band renders with zero chips on the
        settled-outside-history branch and BigInt division by zero throws.
      */}
      {shown.length === 0 ? null : (
        <p className="ml-auto hidden shrink-0 text-xs text-muted-foreground lg:block">
          {/* Rounded like the chips it averages: the same figure in two
              precisions on one line reads as two different numbers. */}
          {STATS_COPY.stripAverage(formatSolAtMost(shown.reduce((total, row) => total + (rawFrom(row.event.paid) ?? 0n), 0n) / BigInt(shown.length), 3), String(shown.length))}
        </p>
      )}
    </div>
  );
}

/**
 * One settlement on the strip: its mark and what it put aside. Every settlement
 * normally carries the SAVED accent; the muted "0" only appears when one landed
 * with nothing to pay. The rest of the story (whose wallet, of what, when)
 * waits in the tooltip, which the chip reveals on hover or keyboard focus.
 */
function StripChip({
  row,
  now,
  labelOf,
  maxContribution,
  newest,
}: {
  readonly row: SettledRow;
  readonly now: string;
  readonly labelOf: (wallet: string | null) => string;
  readonly maxContribution: bigint | null;
  readonly newest: boolean;
}) {
  const event = row.event;
  const paid = rawFrom(event.paid) ?? 0n;
  const saved = paid > 0n;
  const detail = chipDetail({
    event,
    labelOf,
    maxContribution,
    when: row.at === null ? ACTIVITY_COPY.timeUnknown : timeAgo(row.at, now),
  });

  const className = cn(
    "flex h-9 shrink-0 items-center gap-2 rounded-md border px-3 font-mono text-sm tabular-nums outline-none",
    // Focus: 2px and inset, so it reads against the newest chip's resting 1px
    // ring and needs no room outside the border. scroll-mr-8 keeps a
    // focus-scrolled chip clear of the strip's 2rem right-edge fade.
    "scroll-mr-8 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
    // The text shade and its contrast reasoning live with SAVED in classes.ts.
    saved ? cn("border-emerald-500/20 bg-emerald-500/10", SAVED) : "text-muted-foreground",
    newest && "ring-1 ring-ring/40",
  );

  /*
   * THE ASSET'S MARK AND THREE DECIMALS. A settlement is SOL, so the chip wears
   * SOL's mark — mint-keyed, never the ticker — and the unit is the mark rather
   * than a repeated word, which is what buys the room for the figure. Three
   * places because "+0.036634582" in a pill is a smear; the exact amount is in
   * the tooltip and in the accessible name, and a settlement too small to show
   * at three places reads "<0.001" and never "0".
   */
  const face = saved ? `+${formatSolAtMost(paid, 3)}` : "0";
  const body = (
    <>
      <AssetMark symbol="SOL" mint={NATIVE_SOL} size={16} className={saved ? "" : "opacity-60"} />
      {face}
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
        {/*
          The face is rounded and the mark is decorative, so the accessible
          name carries the whole figure with its unit — otherwise a screen
          reader hears "+0.037" and is told neither of what nor how much.
        */}
        {row.explorerUrl === null ? (
          <span className={className} aria-label={detail}>
            {body}
          </span>
        ) : (
          <a href={row.explorerUrl} target="_blank" rel="noopener noreferrer" className={className} aria-label={detail}>
            {body}
          </a>
        )}
      </TooltipTrigger>
      <TooltipContent>{detail}</TooltipContent>
    </Tooltip>
  );
}
