"use client";

// useSigners comes from the ROOT package: it has no Solana variant, and the signer it adds is not chain-specific.
import { usePrivy, useSigners, useUser } from "@privy-io/react-auth";
import { useCallback, useRef, useState } from "react";

import { failureText, grantKeeperSeat, seatOf, type SeatConfig } from "@/lib/trading-wallets";

/**
 * The keeper's seat on one trading wallet: its status from Privy's record on every
 * render (never local state), the grant that repairs a missing seat, and a re-read
 * for an unknown one. The rules live in grantKeeperSeat (src/lib/trading-wallets.ts).
 *
 * Ported from the EVM web's SeatStatus (968e06c), for Solana.
 */
export function useKeeperSeat(address: string, config: SeatConfig) {
  const { user } = usePrivy();
  const { refreshUser } = useUser();
  const { addSigners } = useSigners();
  const [busy, setBusy] = useState<"granting" | "checking" | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const inFlight = useRef(false);

  const grant = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy("granting");
    setFailure(null);
    try {
      await grantKeeperSeat({ address, config, addSigners, refreshUser });
    } catch (error) {
      setFailure(failureText(error));
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }, [address, config, addSigners, refreshUser]);

  const check = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy("checking");
    setFailure(null);
    try {
      await refreshUser();
    } catch (error) {
      setFailure(failureText(error));
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }, [refreshUser]);

  return { seat: seatOf(user, address), grant, check, busy, failure } as const;
}
