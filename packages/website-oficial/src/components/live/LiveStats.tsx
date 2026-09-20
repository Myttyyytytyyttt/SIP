"use client";

/**
 * THE FACTS THE CHAIN ACTUALLY HOLDS, as tiles.
 *
 * WHAT IS MISSING HERE IS THE POINT. The mock shows Avg per trade, Volume,
 * Biggest trade, Streak, Active days and "At this pace". None of them has a
 * source on chain — there are no trades, no volume and no daily series — so
 * they are not shown at all rather than computed from something that looks
 * similar. A tile that exists must be a number the vault or its links record.
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
import { formatSol, formatUsd } from "@/lib/amounts";
import { LABEL } from "@/lib/classes";
import { timeAgo } from "@/lib/format";
import { STATS_COPY } from "@/lib/live-copy";
import type { LivePolicyView, LiveStatsView, LiveVaultView } from "@/lib/live-types";
import { cn } from "@/lib/utils";

interface Tile {
  readonly label: string;
  readonly value: ReactNode;
  readonly sub: ReactNode;
}

export function LiveStats({
  stats,
  vault,
  policy,
  now,
  className,
}: {
  readonly stats: LiveStatsView;
  readonly vault: LiveVaultView;
  readonly policy: LivePolicyView;
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
      value: <Num>{stats.settlementsLifetime === null ? "—" : stats.settlementsLifetime.toString()}</Num>,
      sub: STATS_COPY.settlementsSub(String(stats.loadedSettlements)),
    });
    if (stats.biggestPaid !== null) {
      tiles.push({ label: STATS_COPY.biggest, value: <Num>{`${formatSol(stats.biggestPaid)} SOL`}</Num>, sub: STATS_COPY.biggestSub });
    }
    if (stats.cappedCount > 0 && vault.maxContribution !== null) {
      tiles.push({ label: STATS_COPY.capped, value: <Num>{String(stats.cappedCount)}</Num>, sub: STATS_COPY.cappedSub(formatSol(vault.maxContribution)) });
    }
    tiles.push({
      label: STATS_COPY.lastSettlement,
      value: (
        <span className="text-base">
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

  // Only when the loaded history actually covers the window.
  if (stats.savedTodayLamports !== null) tiles.push({ label: STATS_COPY.today, value: <Num>{`${formatSol(stats.savedTodayLamports)} SOL`}</Num>, sub: "" });
  if (stats.savedThisWeekLamports !== null) tiles.push({ label: STATS_COPY.thisWeek, value: <Num>{`${formatSol(stats.savedThisWeekLamports)} SOL`}</Num>, sub: "" });

  if (hasPolicy) {
    if (policy.lifetimeInvested !== null) {
      tiles.push({ label: STATS_COPY.investedSoFar, value: <Num>{formatUsd(policy.lifetimeInvested)}</Num>, sub: `${stats.investmentsLoaded} in loaded history` });
    }
    if (policy.usedLast30d !== null && policy.maxRolling30d !== null) {
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
      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border @xl:grid-cols-4">
        {tiles.map((tile) => (
          <div key={tile.label} className="min-w-0 space-y-1 bg-card p-4">
            <dt className={LABEL}>{tile.label}</dt>
            <dd className="text-lg font-medium whitespace-nowrap">{tile.value}</dd>
            {tile.sub === "" ? null : <dd className="text-xs text-muted-foreground">{tile.sub}</dd>}
          </div>
        ))}
      </dl>
    </section>
  );
}
