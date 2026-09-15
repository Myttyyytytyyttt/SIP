"use client";

import { usePrivy } from "@privy-io/react-auth";
// THE SOLANA ENTRY, never the root: the root package's useExportWallet exports Ethereum wallets.
import { useExportWallet } from "@privy-io/react-auth/solana";
import { useCallback, useState } from "react";

import { exportTradingWallet, failureText } from "@/lib/trading-wallets";

/**
 * Hand one trading wallet's key to its owner, through Privy's dialog and never this
 * page's DOM: Privy shows the key in an iframe on auth.privy.io, so the page never
 * holds it. Only the owner can export — a signer cannot — and the keeper's policy
 * binds only its signer, so taking the key to Axiom leaves the seat as it was.
 *
 * Ported from the EVM web's ExportWalletButton (968e06c), for Solana.
 */
export function useExportTradingWallet(address: string) {
  const { user } = usePrivy();
  const { exportWallet } = useExportWallet();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const run = useCallback(async () => {
    setBusy(true);
    setFailure(null);
    try {
      // Resolves when the person closes Privy's dialog; the key never comes back here.
      await exportTradingWallet({ exportWallet, user, address });
    } catch (error) {
      setFailure(failureText(error));
    } finally {
      setBusy(false);
    }
  }, [exportWallet, user, address]);

  return { run, busy, failure } as const;
}
