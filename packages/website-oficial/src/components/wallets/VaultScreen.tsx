"use client";

/**
 * THE VAULT'S SHARE OF THE WALLETS SCREEN: one read of the chain for the pension
 * key and its trading wallets, the client every card writes through, and the
 * lock that lets one write run at a time. WalletsScreen mounts it once, around
 * the vault card and the trading wallets, so /wallets and the Manage wallets
 * modal share it.
 */

import { usePrivy } from "@privy-io/react-auth";
import { useContext, useMemo, type ReactNode } from "react";

import { VaultWriteLock } from "@/hooks/use-vault-actions";
import { VaultScreenContext, useVaultState, type VaultScreenValue } from "@/hooks/use-vault-state";
import { MAX_TRADING_WALLETS, tradingWalletsOf } from "@/lib/trading-wallets";
import { createVaultApi } from "@/lib/vault-api";

/**
 * The vault card's anchor. The trading wallets card links to it when a wallet was
 * created and has no vault to link to: the vault is never created for the user
 * (its rent never comes back), so the offer has to be the form itself. It sits on
 * the vault card's section, not on the form, so the link resolves in every state
 * that card can be in.
 */
export const VAULT_CARD_ID = "vault";

/**
 * ONE SCREEN, ONE LOCK. The dashboard's rule card signs too (09-23), and it
 * sits beside the wallets modal on the same page: two VaultScreens would be two
 * locks, and a rule signed from the card could run while the modal signs
 * something else. So the page mounts one (SharedVaultScreen, in wallets-host),
 * and a VaultScreen that finds one already there for the same key adds nothing
 * — no second read, no second lock — and hands its children through.
 */
export function VaultScreen({ pensionKey, children }: { readonly pensionKey: string; readonly children: ReactNode }) {
  const outer = useContext(VaultScreenContext);
  if (outer !== null && outer.pensionKey === pensionKey) return <>{children}</>;
  return <OwnVaultScreen pensionKey={pensionKey}>{children}</OwnVaultScreen>;
}

function OwnVaultScreen({ pensionKey, children }: { readonly pensionKey: string; readonly children: ReactNode }) {
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
