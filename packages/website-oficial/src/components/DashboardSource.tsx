import { Info } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * WHERE THE NUMBERS ON THIS PAGE CAME FROM, said once, quietly, at the top.
 *
 * The dashboard reads as a statement of somebody's money, so the one thing it
 * must never do is let example data pass for a real balance — or let a real
 * balance pass for a priced one while the rate is a placeholder. This is the
 * whole of that: a badge that names the source and a line that says why.
 *
 * It renders NOTHING when the data is live and there is nothing to qualify,
 * which is the state this app is trying to reach.
 */
export function DashboardSource({
  source,
  notice,
  className,
}: {
  source: "live" | "mock";
  /** The reason the mock is showing, or what to keep in mind about the live numbers. */
  notice: string | null;
  className?: string;
}) {
  if (source === "live" && notice === null) return null;

  return (
    <div
      // A note, not an alarm: the muted surface every quiet strip on the page
      // uses. `role="status"` because it explains what is on screen; it is not
      // an error and must not be announced as one.
      role="status"
      className={cn(
        "flex items-start gap-2.5 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground",
        className,
      )}
    >
      <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <p className="min-w-0">
        {source === "mock" ? (
          <>
            <Badge variant="secondary" className="mr-1.5 align-baseline text-[0.6875rem]">
              Sample data
            </Badge>
            {notice}
          </>
        ) : (
          notice
        )}
      </p>
    </div>
  );
}
