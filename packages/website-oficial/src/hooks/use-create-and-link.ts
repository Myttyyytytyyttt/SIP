"use client";

import { useUser } from "@privy-io/react-auth";
// THE SOLANA ENTRY, never the root: the root package's useCreateWallet mints an EVM wallet.
import { useCreateWallet } from "@privy-io/react-auth/solana";
import { useCallback, useRef, useState } from "react";

import { useVaultWrite } from "@/hooks/use-vault-actions";
import type { CreateAndLinkOutcome } from "@/lib/create-and-link";
import type { SeatConfig } from "@/lib/trading-wallets";

/**
 * ONE PRESS: a trading wallet born seated, then linked to the vault.
 *
 * The chain itself is pure (src/lib/create-and-link.ts) and runs under the
 * screen's single write lock (src/hooks/use-vault-actions.ts), so no other
 * signature can start between the create and the link.
 *
 * ONE CREATE AT A TIME. Privy's Solana create sends no idempotency key, so a
 * double click would mint two wallets. The lock disables every write on the
 * screen, and this ref closes the gap before React re-renders.
 *
 * `created` IS KEPT until Privy's record lists the wallet: the card shows the row
 * from the moment Privy names the address, whatever the link does afterwards, so
 * a wallet is never missing from the list it was just added to.
 *
 * Replaces useCreateTradingWallet, which created and stopped.
 */
export function useCreateAndLink(config: SeatConfig) {
  const { createWallet } = useCreateWallet();
  const { refreshUser } = useUser();
  const write = useVaultWrite("create-and-link");
  const [created, setCreated] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<CreateAndLinkOutcome | null>(null);
  const inFlight = useRef(false);

  const run = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setOutcome(null);
    try {
      await write.createAndLink({
        createWallet,
        config,
        refreshUser,
        onCreated: setCreated,
        onOutcome: setOutcome,
      });
    } finally {
      inFlight.current = false;
    }
  }, [write, createWallet, refreshUser, config]);

  return { run, created, outcome, write } as const;
}
