"use client";

// useSigners comes from the ROOT package: it has no Solana variant, and the signer it adds is not chain-specific.
import { usePrivy, useSigners, useUser } from "@privy-io/react-auth";
import { useCallback, useRef, useState } from "react";

import { RESEAT_COPY, failureText, grantKeeperSeat, reseatKeeperSeat, reseatRefusal, seatOf, type SeatConfig } from "@/lib/trading-wallets";

/**
 * The keeper's seat on one trading wallet: what Privy's record says of its signers on
 * every render (never local state) — a signer, none, or not listed yet, but never
 * whose — the grant that repairs a missing seat, the re-seat that replaces whatever
 * signer is there, and a re-read for an unknown one. The rules live in seatOf,
 * grantKeeperSeat and reseatKeeperSeat (src/lib/trading-wallets.ts).
 *
 * `reseatBlocked` is why this wallet cannot be re-seated from here, read from the
 * record on every render, or null. `notice` is what a finished re-seat did: the
 * badge reads "Has a signer" before and after one, so without it the page would
 * look as if nothing had happened.
 *
 * Ported from the EVM web's SeatStatus (968e06c), for Solana.
 */
export function useKeeperSeat(address: string, config: SeatConfig) {
  const { user } = usePrivy();
  const { refreshUser } = useUser();
  const { addSigners, removeSigners } = useSigners();
  const [busy, setBusy] = useState<"granting" | "reseating" | "checking" | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const inFlight = useRef(false);

  const grant = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy("granting");
    setFailure(null);
    setNotice(null);
    try {
      await grantKeeperSeat({ address, config, addSigners, refreshUser });
    } catch (error) {
      setFailure(failureText(error));
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }, [address, config, addSigners, refreshUser]);

  const reseat = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy("reseating");
    setFailure(null);
    setNotice(null);
    try {
      const outcome = await reseatKeeperSeat({ address, config, removeSigners, addSigners, refreshUser });
      setNotice(outcome === "reseated" ? RESEAT_COPY.done : RESEAT_COPY.grantedOnly);
    } catch (error) {
      setFailure(failureText(error));
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }, [address, config, removeSigners, addSigners, refreshUser]);

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

  return {
    seat: seatOf(user, address),
    reseatBlocked: reseatRefusal(user, address),
    grant,
    reseat,
    check,
    busy,
    failure,
    notice,
  } as const;
}
