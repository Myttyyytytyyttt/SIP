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
 * Reduced motion: the arrows stand still; the resting button and its
 * aria-busy say it. A screen that names no `refreshing` (a test's hand-built
 * one) is never busy, and the button is exactly the one each card drew before.
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
    // Called with nothing, whatever the button hands its onClick.
    <Button type="button" variant={variant} size={size} disabled={disabled || busy} aria-busy={busy || undefined} onClick={() => screen?.refresh()}>
      <RefreshCw className={busy ? "motion-safe:animate-spin" : undefined} aria-hidden />
      {children}
    </Button>
  );
}
