/**
 * A HISTORY ON ITS WAY, SHAPED LIKE ONE (10-09). Five rows the shape of the
 * feed's own (activity-row.tsx: a `size-8 rounded-md` tile, a title line and a
 * line under it), so the column does not jump when the real rows land — where
 * it used to be one grey sentence, and before that pulsing blocks of no shape
 * at all (G7).
 *
 * THE WORDS ARE NEVER REPLACED BY IT. It always sits beside "Reading this
 * pension's history…": as the first read's sidebar it brings them itself
 * (`label`), and in the column it sits under the column's own sentence for a
 * history still being read (LiveBody.tsx, wallet-activity.tsx `skeleton`). The
 * blocks are decoration — hidden from screen readers, and standing still for
 * anyone who asked for less motion (ui/skeleton.tsx) — and the words are what
 * say what is happening.
 *
 * A refresh never shows it: once rows are on screen they stay, and what is
 * moving is said beside them.
 */

import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** How many rows it draws: about what a short column shows before it scrolls. */
export const FEED_SKELETON_ROWS = 5;

/** A title line per row, each a different length, so five rows do not read as one stamped block. */
const TITLE_WIDTHS = ["w-3/4", "w-2/3", "w-4/5", "w-1/2", "w-3/5"] as const;

export function FeedSkeleton({
  label,
  className,
}: {
  /** The visible words, when nothing beside it says them already. */
  readonly label?: string;
  readonly className?: string;
}) {
  return (
    <div className={className}>
      {label === undefined ? null : <p className="text-sm text-muted-foreground">{label}</p>}
      <div aria-hidden="true" className={label === undefined ? undefined : "mt-3"} data-feed-skeleton="">
        {TITLE_WIDTHS.slice(0, FEED_SKELETON_ROWS).map((width) => (
          <div key={width} className="flex items-start gap-3 py-2.5">
            <Skeleton className="size-8 shrink-0" />
            <div className="min-w-0 flex-1 space-y-1.5 pt-0.5">
              <Skeleton className={cn("h-3.5", width)} />
              <Skeleton className="h-3 w-2/5" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
