"use client";

/**
 * THE VAULT'S SHARE OF THE WALLETS SCREEN: one read of the chain for the pension
 * key and its trading wallets, the client every card writes through, and the
 * lock that lets one write run at a time. WalletsScreen mounts it once, around
 * the vault card and the trading wallets, so /wallets and the Manage wallets
 * modal share it.
 */

import { usePrivy } from "@privy-io/react-auth";
import { useMemo, type ReactNode } from "react";

import { VaultWriteLock } from "@/hooks/use-vault-actions";
import { VaultScreenContext, useVaultState, type VaultScreenValue } from "@/hooks/use-vault-state";
import { MAX_TRADING_WALLETS, tradingWalletsOf } from "@/lib/trading-wallets";
import { createVaultApi } from "@/lib/vault-api";

export function VaultScreen({ pensionKey, children }: { readonly pensionKey: string; readonly children: ReactNode }) {
  const { user } = usePrivy();
  const api = useMemo(() => createVaultApi(), []);
  // Privy's record of the trading wallets, never the pension key, and at most as many as one read asks about.
  const walletsKey = useMemo(
    () =>
      tradingWalletsOf(user)
        .map((wallet) => wallet.address)
        .filter((address) => address !== pensionKey)
        .slice(0, MAX_TRADING_WALLETS)
        .join(","),
    [user, pensionKey],
  );
  const wallets = useMemo(() => (walletsKey === "" ? [] : walletsKey.split(",")), [walletsKey]);
  const { view, refresh } = useVaultState(api, pensionKey, wallets);
  const value = useMemo<VaultScreenValue>(() => ({ pensionKey, view, refresh, api }), [pensionKey, view, refresh, api]);

  return (
    <VaultScreenContext.Provider value={value}>
      <VaultWriteLock>{children}</VaultWriteLock>
    </VaultScreenContext.Provider>
  );
}
