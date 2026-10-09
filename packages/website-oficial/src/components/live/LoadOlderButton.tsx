"use client";

/**
 * LOAD OLDER, COUNTING DOWN TO WHEN IT CAN HELP (10-09). The same countdown as
 * RetryButton, on the history's own retry-after: the number used to be worked
 * out once per render and never move (G5), so after a refusal the button could
 * stay disabled over a bucket that had long refilled.
 *
 * IT PROMISES NOTHING ON ITS OWN. A page of older history is read only when
 * someone presses for it — nothing retries it in the background — so a failure
 * is said as "Could not load older activity · try again" (ACTIVITY_COPY
 * .olderFailed, beside it on /activity), never "trying again shortly".
 *
 * NO FLOOR HERE: Load older asks for its page directly, not through the
 * dashboard's refresh, so only the server's retry-after can hold it back.
 *
 * On /activity under the feed, and in the strip's chip slot when the chain
 * records a settlement no loaded page holds (savings-strip.tsx loadOlderSlot).
 */

import { useCountdown } from "@/components/live/use-countdown";
import { Button } from "@/components/ui/button";
import type { LiveOlder } from "@/hooks/use-live-dashboard";
import { ACTIVITY_COPY, LIVE_COPY } from "@/lib/live-copy";

/** What the button says, and whether it can be pressed. */
export function loadOlderLook(input: { readonly busy: boolean; readonly left: number | null }): { readonly label: string; readonly disabled: boolean } {
  if (input.busy) return { label: ACTIVITY_COPY.loadingOlder, disabled: true };
  if (input.left !== null) return { label: LIVE_COPY.retryIn(input.left), disabled: true };
  return { label: ACTIVITY_COPY.loadOlder, disabled: false };
}

export function LoadOlderButton({ older, onLoadOlder, className }: { readonly older: LiveOlder; readonly onLoadOlder: () => void; readonly className?: string }) {
  const left = useCountdown(older.retryAt);
  // With the history at its beginning there is nothing older to ask for, and
  // before a head page has said where the older one starts there is nothing to
  // press on: a button that cannot help is worse than no button.
  if (older.complete || !older.available) return null;
  const look = loadOlderLook({ busy: older.busy, left });
  return (
    <Button type="button" size="sm" variant="outline" className={className} disabled={look.disabled} onClick={onLoadOlder}>
      {look.label}
    </Button>
  );
}
