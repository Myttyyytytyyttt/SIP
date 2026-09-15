"use client";

import { useUser } from "@privy-io/react-auth";
// THE SOLANA ENTRY, never the root: the root package's useCreateWallet mints an EVM wallet.
import { useCreateWallet } from "@privy-io/react-auth/solana";
import { useCallback, useRef, useState } from "react";

import { privyFailure } from "@/lib/privy-failure";
import { SeatNotConfigured, createTradingWallet, type SeatConfig } from "@/lib/trading-wallets";

/**
 * One trading wallet at a time, born seated (src/lib/trading-wallets.ts).
 *
 * ONE CREATE AT A TIME. Privy's Solana create sends no idempotency key, so a double
 * click would mint two wallets. `busy` disables the button, and the ref closes the
 * gap before React re-renders.
 *
 * PRIVY'S RECORD IS READ AGAIN AFTER ANY ANSWER. On success the list must show the
 * wallet from the user record, not from what createWallet returned; on a failure a
 * wallet may exist anyway, and the list should show it with the seat Privy records.
 *
 * Ported from the EVM web's CreateWalletButton (968e06c), for Solana.
 */
export function useCreateTradingWallet(config: SeatConfig) {
  const { createWallet } = useCreateWallet();
  const { refreshUser } = useUser();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  /** The address Privy reported for the last wallet created here, until the record lists it. */
  const [created, setCreated] = useState<string | null>(null);
  const inFlight = useRef(false);

  const create = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setFailure(null);
    try {
      setCreated(await createTradingWallet(createWallet, config));
    } catch (error) {
      if (error instanceof SeatNotConfigured) {
        setFailure(error.message);
      } else {
        const described = privyFailure(error);
        if (described.kind !== "exited") setFailure(described.message);
      }
    } finally {
      await refreshUser().catch(() => undefined);
      inFlight.current = false;
      setBusy(false);
    }
  }, [createWallet, refreshUser, config]);

  return { create, busy, failure, created } as const;
}
