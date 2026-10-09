"use client";

/**
 * A RETRY THAT SAYS WHEN IT WILL HELP, AND THEN SAYS IT IS HELPING (10-09).
 *
 * "Try again in 12 s" used to be worked out once per render and never move, so
 * the button could stay disabled long after its time (G5). And a press inside
 * the 10 s floor after the last read (live-schedule.ts MANUAL_FLOOR_MS) was
 * deferred by the hook without a word: nothing on screen changed for up to ten
 * seconds, which reads as a button that does nothing.
 *
 * So it counts down to the moment a press reads AT ONCE — the later of the
 * server's retry-after and that floor — enables exactly then, and once pressed
 * says "Retrying…" until a read finishes (the floor moves with it) or for
 * RETRYING_MS, whichever comes first. Used wherever a read failed: the
 * unreadable card (LiveStates.tsx) and the history's banner (LiveColumn.tsx),
 * in the column and on /activity.
 *
 * THE FLOOR IS THE STORE'S OWN (plan B2): `live.refreshReadyAt`, the moment
 * from which refresh() reads at once, failed reads included. It used to be
 * this browser's guess — the floor after the last read it SAW finish, which
 * opened early by the gap between a read's snapshot and its history and held
 * a host mounted long after its read for a floor nobody needed.
 *
 * ITS WORDS ARE NEVER IN A LIVE REGION. The sentence beside it says what failed
 * and is the one announced; a countdown inside a polite region would be read
 * out every second. A button's name changes silently.
 *
 * AND IT KEEPS ITS FOCUS. Pressed from the keyboard it turns "Retrying…" at
 * once, and a button that became `disabled` under the focus would drop it on
 * the page's body. So while it cannot help it is aria-disabled — still
 * focusable, its name saying why, a press doing nothing.
 */

import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import { useCountdown } from "@/components/live/use-countdown";
import { Button } from "@/components/ui/button";
import { LIVE_COPY } from "@/lib/live-copy";
import { cn } from "@/lib/utils";

/** How long "Retrying…" stands when no read finishes: then the button is offered again rather than held. */
export const RETRYING_MS = 15_000;

/** The moment a press reads at once: the server's retry-after and the floor, whichever is later. */
export function retryEnableAt(retryAt: number | null, readyAt: number): number {
  return retryAt === null ? readyAt : Math.max(retryAt, readyAt);
}

/** What the button says, and whether it can be pressed. */
export function retryLook(input: { readonly left: number | null; readonly retrying: boolean }): { readonly label: string; readonly disabled: boolean } {
  if (input.retrying) return { label: LIVE_COPY.retrying, disabled: true };
  if (input.left !== null) return { label: LIVE_COPY.retryIn(input.left), disabled: true };
  return { label: LIVE_COPY.retry, disabled: false };
}

/**
 * WHICH READ A PRESS WAS MADE AFTER: the floor and the retry-after it was
 * pressed against. A read that finishes moves the floor (or brings a new
 * retry-after), and that alone ends the press — no effect has to notice it.
 */
export function pressKeyOf(retryAt: number | null, readyAt: number): string {
  return `${readyAt}|${retryAt ?? ""}`;
}

/**
 * Whether a press is still waiting on its read: true from the press until
 * `after` changes (pressKeyOf) or for RETRYING_MS, whichever comes first.
 * Returns that, and the press.
 */
export function usePressedUntilRead(after: string): readonly [boolean, () => void] {
  const [pressedAfter, setPressedAfter] = useState<string | null>(null);
  const pressed = pressedAfter === after;
  useEffect(() => {
    if (!pressed) return undefined;
    const timer = setTimeout(() => setPressedAfter(null), RETRYING_MS);
    return () => clearTimeout(timer);
  }, [pressed]);
  return [pressed, () => setPressedAfter(after)];
}

export function RetryButton({
  retryAt,
  readyAt,
  onRetry,
  icon = false,
  className,
}: {
  /** When the server said this browser may ask again (a 429's retry-after); null when it named no time. */
  readonly retryAt: number | null;
  /** When a press stops being deferred by the floor: the store's `live.refreshReadyAt`. */
  readonly readyAt: number;
  readonly onRetry: () => void;
  /** The unreadable card's button carries the refresh glyph; the history's banner does not. */
  readonly icon?: boolean;
  readonly className?: string;
}) {
  const left = useCountdown(retryEnableAt(retryAt, readyAt));
  const [retrying, press] = usePressedUntilRead(pressKeyOf(retryAt, readyAt));
  const look = retryLook({ left, retrying });

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      // The `disabled:` look, for aria-disabled (see the top of the file).
      className={cn("aria-disabled:pointer-events-none aria-disabled:opacity-50", className)}
      {...(look.disabled ? { "aria-disabled": true } : {})}
      onClick={() => {
        if (look.disabled) return;
        press();
        onRetry();
      }}
    >
      {icon ? <RefreshCw aria-hidden /> : null}
      {look.label}
    </Button>
  );
}
