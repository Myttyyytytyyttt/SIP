"use client";

/**
 * THE LAST FEW CONTRIBUTIONS, in the bar's spare width.
 *
 * WHERE IT BELONGS AND WHERE IT DOES NOT. Only away from the pension page: on
 * the pension the same settlements are already on screen, in full, in the strip
 * under the header — repeating them in the chrome would be noise. Everywhere
 * else the bar has room, and this is the one number a saver wants following
 * them around.
 *
 * THE EDGES FADE RATHER THAN CUT. The row scrolls, so a chip at either end is
 * usually half shown; a hard clip reads as a rendering bug, while a mask reads
 * as "there is more this way". `mask-image` on both sides, transparent for the
 * first and last few pixels — and the fade is what MAKES the strip legible as
 * something separate from the buttons beside it.
 */

import { formatSol, rawFrom } from "@/lib/amounts";
import type { LiveRow } from "@/lib/live-types";
import { cn } from "@/lib/utils";

/** How many chips can be in the bar at once. Past this the row is a feed, not a glance. */
const SHOWN = 8;

/**
 * A settlement that moved nothing is not a contribution to show here — the feed
 * on the pension page lists those, because they happened; a glance in the bar
 * is for money that arrived.
 *
 * `paid` IS WHAT MOVED, not what was owed: a contribution clipped by
 * max_contribution shows the smaller, true number.
 */
function contributions(rows: readonly LiveRow[]): { readonly key: string; readonly lamports: bigint }[] {
  const found: { key: string; lamports: bigint }[] = [];
  for (const row of rows) {
    if (row.event.kind !== "settled" || !row.ok) continue;
    const lamports = rawFrom(row.event.paid) ?? 0n;
    if (lamports <= 0n) continue;
    found.push({ key: row.signature, lamports });
    if (found.length === SHOWN) break;
  }
  return found;
}

export function HeaderContributions({ rows, className }: { readonly rows: readonly LiveRow[]; readonly className?: string }) {
  const chips = contributions(rows);
  // NOTHING TO SAY, NOTHING SHOWN. An empty strip would leave a gap that reads
  // as a component that failed to load.
  if (chips.length === 0) return null;

  return (
    <div
      className={cn("hidden min-w-0 items-center gap-1.5 overflow-x-auto md:flex", className)}
      style={{
        // Both edges, so the row never ends in a hard cut. The scrollbar is
        // hidden by the utility below; the mask is the only affordance there is.
        maskImage: "linear-gradient(to right, transparent 0, black 14px, black calc(100% - 14px), transparent 100%)",
        WebkitMaskImage: "linear-gradient(to right, transparent 0, black 14px, black calc(100% - 14px), transparent 100%)",
        scrollbarWidth: "none",
      }}
      aria-label="Recent contributions"
    >
      {chips.map((chip) => (
        <span
          key={chip.key}
          className="inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1 font-mono text-xs whitespace-nowrap text-emerald-700 tabular-nums dark:text-emerald-300"
        >
          +{formatSol(chip.lamports)}
          <span className="text-emerald-700/60 dark:text-emerald-300/60">SOL</span>
        </span>
      ))}
    </div>
  );
}
