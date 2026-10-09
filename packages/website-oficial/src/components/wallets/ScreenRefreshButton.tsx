"use client";

/**
 * A READ OF THE WALLETS SCREEN, ASKED FOR — AND SEEN TO BE OUT (10-09, plan B4).
 *
 * The screen's Refresh, Retry, Read again and Check all ask VaultScreen for the
 * same read (useVaultScreen().refresh), and none of them showed that one was
 * out: a press drew nothing until the answer came, and a second press only
 * dropped the read already on its way to start another. Now each is busy while
 * a read is out over what is on screen (`refreshing`, use-vault-state.ts) —
 * the one pressed, the screen's own poll, or the dashboard catching it up —
 * its arrows turning and the button resting until the answer lands.
 *
 * RESTING, NOT DISABLED (review, 10-09). A read goes out under a focused button
 * with no press at all — the /wallets poll, the catch-up on coming back to the
 * tab, the 15 s retry behind VaultCard's Retry — and a button that became
 * `disabled` under the focus dropped it on the page's body, outside the
 * modal's Tab order, announced "unavailable" on every poll. So while busy it
 * is aria-disabled, as RetryButton.tsx and Check now are: still focusable, a
 * press doing nothing. The card's own `disabled` stays real: it follows a
 * write started from another button, so the focus is not on this one.
 *
 * Reduced motion: the arrows stand still; the resting button, its
 * aria-disabled and aria-busy say it. A screen that names no `refreshing` (a
 * test's hand-built one) is never busy, and the button is exactly the one each
 * card drew before.
 */

import { RefreshCw } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { useVaultScreen } from "@/hooks/use-vault-state";

export function ScreenRefreshButton({
  children,
  variant = "outline",
  size = "sm",
  disabled = false,
}: {
  readonly children: ReactNode;
  readonly variant?: ComponentProps<typeof Button>["variant"];
  readonly size?: ComponentProps<typeof Button>["size"];
  /** The card's own reason to rest (its write running), beside the read's. */
  readonly disabled?: boolean;
}) {
  const screen = useVaultScreen();
  const busy = screen?.refreshing ?? false;
  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      disabled={disabled}
      // Held, not disabled: a read out while it has the focus (its own press, the poll, a catch-up on coming back) must not drop that focus on the body — RetryButton.tsx.
      className={busy ? "aria-disabled:pointer-events-none aria-disabled:opacity-50" : undefined}
      {...(busy ? { "aria-disabled": true } : {})}
      aria-busy={busy || undefined}
      onClick={() => {
        if (busy) return;
        // Called with nothing, whatever the button hands its onClick.
        screen?.refresh();
      }}
    >
      <RefreshCw className={busy ? "motion-safe:animate-spin" : undefined} aria-hidden />
      {children}
    </Button>
  );
}
