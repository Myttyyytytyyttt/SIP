"use client";

/**
 * THE DASHBOARD'S VAULT SCREEN FOLLOWS ITS LIVE STORE (diagnosis 10-09,
 * inventory D2). The Manage wallets modal, the rule card's gear dot and the
 * start-buying card all read the shared vault screen (wallets-host.tsx), which
 * read the chain when the page mounted and then only after a write or a
 * Refresh: after a settle, a conversion or a buy, the modal opened on the
 * vault as it had been.
 *
 * The live store already reads and hears the chain, so the vault screen does
 * not poll beside it. It reads again — a read nobody pressed, which keeps a
 * ready view if it fails (useVaultState catchUp) — when:
 *
 *   - a committed live read shows the vault moved since the one before it
 *     (vaultMoved: its lamports, its account, a token amount, its policy),
 *     no sooner than VAULT_FOLLOW_FLOOR_MS after the last vault read began;
 *   - the Manage wallets modal opens, no sooner than the manual floor.
 *
 * The numbers and what they cost are src/lib/vault-follow.ts's.
 */

import { useEffect, useRef } from "react";

import type { VaultScreenValue } from "@/hooks/use-vault-state";
import { VAULT_FOLLOW_FLOOR_MS, VAULT_OPEN_FLOOR_MS, vaultMoved, type VaultStamp } from "@/lib/vault-follow";

export function useVaultFollowsLive(input: {
  /** The page's vault screen; null outside one (no key connected, no config). */
  readonly screen: VaultScreenValue | null;
  /** The live store's stamp of its last committed snapshot (LiveDashboardStore.vaultStamp). */
  readonly stamp: VaultStamp | null;
  /** Whether the Manage wallets modal is on screen (useWalletsModalOpen). */
  readonly modalOpen: boolean;
}): void {
  const catchUp = input.screen?.catchUp ?? null;

  // The stamp of the read before: a move is between two committed reads, never from nothing.
  const heldStamp = useRef<VaultStamp | null>(input.stamp);
  useEffect(() => {
    const before = heldStamp.current;
    heldStamp.current = input.stamp;
    if (vaultMoved(before, input.stamp)) catchUp?.(VAULT_FOLLOW_FLOOR_MS);
  }, [input.stamp, catchUp]);

  // The edge, not the state: opening reads once, staying open reads nothing more.
  const wasOpen = useRef(input.modalOpen);
  useEffect(() => {
    const opened = input.modalOpen && !wasOpen.current;
    wasOpen.current = input.modalOpen;
    if (opened) catchUp?.(VAULT_OPEN_FLOOR_MS);
  }, [input.modalOpen, catchUp]);
}
