"use client";

/**
 * THE FACTS THE CHAIN ACTUALLY HOLDS, in the sample's tile grid.
 *
 * THE GRID IS THE SAMPLE'S, TAKEN AS IT STANDS — the same dl, the same dt/dd
 * faces, and the same `Word`, which steps a unit word inside a value down to
 * the sentence face so only the digits carry the number weight. What differs is
 * WHICH tiles exist and what their subs are allowed to say.
 *
 * WHAT IS MISSING HERE IS THE POINT. The sample shows Avg per trade, Volume,
 * Streak, Active days and "At this pace", and under the tiles a 13-week strip
 * of the days a save happened. None of them has a source on chain — there are
 * no trades, no volume and no daily series — so they are not shown at all
 * rather than computed from something that looks similar. A tile that exists
 * must be a number the vault or its links record.
 *
 * A SUB EARNS ITS LINE BY STOPPING A MISREADING, and the rest are gone. What is
 * left says the WINDOW a figure covers — the pages loaded here, not a lifetime —
 * or the denominator a figure is a fraction of. A count of investments under a
 * lifetime dollar total said neither, and the tooltip on that figure was already
 * carrying the one thing it could be misread as.
 *
 * A WINDOW IS ONLY CLAIMED WHEN THE LOADED HISTORY COVERS IT. "Today" and "This
 * week" are null in the model unless the loaded pages reach back past the start
 * of the window, and a null window is left out instead of being shown as a
 * smaller number wearing a complete one's name.
 *
 * AND NOTHING HERE MAY CONTRADICT THE STATE. "Last settlement none yet" is a
 * statement about the chain, not about this page of signatures: with the vault's
 * own total saying otherwise it says where the settlement is instead — not in
 * the history loaded so far — and the tiles appear at all, which they did not
 * when every link's nonce was unreadable and only lifetimeSaved knew.
 */

import type { ReactNode } from "react";

import { Num } from "@/components/num";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatSol, formatUsd, usdcRawForLamports } from "@/lib/amounts";
import { LABEL } from "@/lib/classes";
import { timeAgo } from "@/lib/format";
import { LIVE_COPY, STATS_COPY } from "@/lib/live-copy";
import type { LivePolicyView, LiveStatsView, LiveVaultView } from "@/lib/live-types";
import { cn } from "@/lib/utils";

/** A word inside a tile value ("SOL") steps down to the sentence face, so only the digits carry the number weight. */
function Word({ children }: { children: ReactNode }) {
  return <span className="text-sm font-normal text-muted-foreground">{children}</span>;
}

interface Tile {
  readonly label: string;
  readonly value: ReactNode;
  /** "" is a tile with nothing left to qualify, and it renders no line at all. */
  readonly sub: ReactNode;
}

/**
 * HOW FAR THE LAST TILE STRETCHES, so a part-filled row has no holes in it.
 *
 * The grid's own background is the border colour showing through a 1px gap, so
 * a cell with nothing in it is not empty space: it is a grey rectangle the
 * shape of a tile, and it reads as a figure that failed to load. How many
 * tiles there are depends on what the chain answered — a vault with no policy
 * has four, one with everything has seven — so the remainder cannot be a
 * constant.
 *
 * Spelled out rather than built, because Tailwind reads the classes it emits
 * out of the source: `col-span-${n}` compiles to nothing at all.
 */
function lastSpan(count: number): string {
  const two = count % 2 === 1 ? "col-span-2" : "";
  const rest = count % 4;
  const four = rest === 0 ? "@xl:col-span-1" : rest === 1 ? "@xl:col-span-4" : rest === 2 ? "@xl:col-span-3" : "@xl:col-span-2";
  return `${two} ${four}`;
}

export function LiveStats({
  stats,
  vault,
  policy,
  perSol,
  now,
  className,
}: {
  readonly stats: LiveStatsView;
  readonly vault: LiveVaultView;
  readonly policy: LivePolicyView;
  /** Today's USDC per SOL, for the window subs. Null when the pools were not read. */
  readonly perSol: bigint | null;
  /** The payload's own clock: "4m ago" is measured against it, never Date.now(). */
  readonly now: string;
  readonly className?: string;
}) {
  const hasPolicy = policy.status === "exists";
  const everSettled = stats.loadedSettlements > 0 || (stats.settlementsLifetime ?? 0n) > 0n || stats.settledOutsideHistory;
  // Nothing settled and no policy: there is not one real number to put here.
  if (!everSettled && !hasPolicy) return null;

  const tiles: Tile[] = [];

  if (everSettled) {
    tiles.push({
      label: STATS_COPY.settlements,
      value: <Num>{stats.settlementsLifetime === null ? LIVE_COPY.unknownFigure : stats.settlementsLifetime.toString()}</Num>,
      // Two different facts, not one restated: the tile is every settlement the
      // links have ever counted, the sub is how many of them this page holds.
      sub: STATS_COPY.settlementsSub(String(stats.loadedSettlements)),
    });
    if (stats.biggestPaid !== null) {
      tiles.push({
        label: STATS_COPY.biggest,
        value: (
          <>
            <Num>{formatSol(stats.biggestPaid)}</Num> <Word>SOL</Word>
          </>
        ),
        // The maximum over the PAGES LOADED. Without this line it reads as a
        // lifetime record, which is a claim nothing here can make.
        sub: STATS_COPY.biggestSub,
      });
    }
    if (stats.cappedCount > 0 && vault.maxContribution !== null) {
      // Same window again, and the cap it was measured against: a count of
      // settlements that hit a limit means nothing without the limit.
      tiles.push({ label: STATS_COPY.capped, value: <Num>{String(stats.cappedCount)}</Num>, sub: STATS_COPY.cappedSub(formatSol(vault.maxContribution)) });
    }
    tiles.push({
      label: STATS_COPY.lastSettlement,
      value: (
        // whitespace-normal beats the dd's nowrap for THIS tile only: its value
        // is prose, not a figure, and "not in loaded history" is wider than a
        // 4-up cell. The dd keeps nowrap for every mono figure beside it.
        <span className="text-base leading-snug whitespace-normal">
          {stats.lastSettlementAt !== null
            ? timeAgo(stats.lastSettlementAt, now)
            : stats.settledOutsideHistory
              ? STATS_COPY.lastSettlementOutside
              : STATS_COPY.lastSettlementNever}
        </span>
      ),
      sub: "",
    });
  }

  // TODAY IS NOT HERE ANY MORE: it moved into the card's header, where the
  // sample puts it, and a fact on screen twice is a fact two places can come
  // to disagree about. This week stays, and only when the loaded history
  // actually covers the window.
  if (stats.savedThisWeekLamports !== null) {
    // THE VALUE STAYS SOL AND THE DOLLAR GOES IN THE SUB, worded. A window SUM
    // at today's price is not the same claim as a BALANCE at today's price: a
    // balance says what something is worth now, which is true; "$18.40 saved
    // this week" says dollars changed hands at rates this app never stored.
    tiles.push({
      label: STATS_COPY.thisWeek,
      value: (
        <>
          <Num>{formatSol(stats.savedThisWeekLamports)}</Num> <Word>SOL</Word>
        </>
      ),
      sub: perSol === null ? "" : STATS_COPY.windowAbout(formatUsd(usdcRawForLamports(stats.savedThisWeekLamports, perSol))),
    });
  }

  if (hasPolicy) {
    if (policy.lifetimeInvested !== null) {
      tiles.push({
        label: STATS_COPY.investedSoFar,
        // THE TOOLTIP CAME DOWN WITH THE TILE. It used to live in the card's
        // header, and it is the sentence that keeps this figure from being
        // read as the basket's value a few rows below — they diverge whenever
        // a token reaches the vault by any other route. It is also the whole
        // of what this tile has to qualify, which is why there is no sub under
        // it: a count of the investments in the loaded history was a fact in
        // another unit and another window, answering nothing anyone asked.
        value: (
          <Tooltip>
            <TooltipTrigger type="button" className="rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
              <Num>{formatUsd(policy.lifetimeInvested)}</Num>
            </TooltipTrigger>
            <TooltipContent>{LIVE_COPY.investedSoFarTooltip}</TooltipContent>
          </Tooltip>
        ),
        sub: "",
      });
    }
    if (policy.usedLast30d !== null && policy.maxRolling30d !== null) {
      // The denominator, not a restatement: a spend is a fraction of the cap
      // the policy signed, and the cap is the half nobody can infer.
      tiles.push({ label: STATS_COPY.usedIn30Days, value: <Num>{formatUsd(policy.usedLast30d)}</Num>, sub: STATS_COPY.usedIn30DaysSub(formatUsd(policy.maxRolling30d)) });
    }
  }

  if (tiles.length === 0) return null;

  return (
    <section className={cn("@container space-y-3", className)} aria-labelledby="live-stats-heading">
      <h3 id="live-stats-heading" className="text-sm font-medium">
        {STATS_COPY.heading}
      </h3>
      {/* Four-up on the CARD's width, not the viewport's: from md this panel shares its row. */}
      {/* The last tile fills the row rather than leaving holes: see lastSpan. */}
      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border @xl:grid-cols-4">
        {tiles.map((tile, index) => (
          <div key={tile.label} className={cn("min-w-0 space-y-1 bg-card p-4", index === tiles.length - 1 && lastSpan(tiles.length))}>
            <dt className={LABEL}>{tile.label}</dt>
            <dd className="text-lg font-medium whitespace-nowrap">{tile.value}</dd>
            {tile.sub === "" ? null : <dd className="text-xs text-muted-foreground">{tile.sub}</dd>}
          </div>
        ))}
      </dl>
    </section>
  );
}
