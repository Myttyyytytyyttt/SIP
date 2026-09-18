"use client";

// useSigners comes from the ROOT package: it has no Solana variant, and the signer it adds is not chain-specific.
import { usePrivy, useSigners, useUser } from "@privy-io/react-auth";
import { useCallback, useSyncExternalStore } from "react";

import { beginSeatTask, endSeatTask, seatActivity, subscribeSeatActivity } from "@/lib/seat-activity";
import {
  GRANT_COPY,
  GRANT_HOLD_MS,
  GrantUnconfirmed,
  RESEAT_COPY,
  ReseatIncomplete,
  failureText,
  grantKeeperSeat,
  grantRefusal,
  reseatKeeperSeat,
  reseatRefusal,
  seatOf,
  type ReseatStage,
  type SeatConfig,
} from "@/lib/trading-wallets";

/**
 * The keeper's seat on one trading wallet: what Privy's record says of its signers on
 * every render (never local state) — a signer, none, or not listed yet, but never
 * whose — the grant that repairs a missing seat, the re-seat that replaces whatever
 * signer is there, and a re-read for an unknown one. The rules live in seatOf,
 * grantKeeperSeat and reseatKeeperSeat (src/lib/trading-wallets.ts).
 *
 * `reseatBlocked` and `grantBlocked` are why this wallet cannot be re-seated or
 * granted from here, read from the record on every render, or null. `notice` is
 * what a finished re-seat did: the badge reads "Has a signer" before and after
 * one, so without it the page would look as if nothing had happened.
 *
 * `busy`, `failure` and `notice` live in src/lib/seat-activity.ts, by address, not
 * in this hook: a re-seat outlives the row that started it (the modal closed, the
 * page left), and a row mounted again must show it running, then how it ended, and
 * must not start another operation on the same wallet meanwhile.
 *
 * THE SAME RENDER'S USER GOES WITH THE SAME RENDER'S SIGNER METHODS. Privy's
 * addSigners and removeSigners look the wallet up in the context user of the render
 * that produced them, and usePrivy().user is that same context read. Each callback
 * below closes over both from one render and passes the user as `renderedUser`,
 * which is what reseatKeeperSeat and grantKeeperSeat check before sending anything.
 * Never feed either method from a newer render (a ref updated every render, a
 * lookup at call time): the re-seat's add must come from before its removal.
 *
 * Ported from the EVM web's SeatStatus (968e06c), for Solana.
 */
export function useKeeperSeat(address: string, config: SeatConfig) {
  const { user } = usePrivy();
  const { refreshUser } = useUser();
  const { addSigners, removeSigners } = useSigners();
  // The same function for the server snapshot: nothing runs on the server, so there it is always idle.
  const activity = useSyncExternalStore(
    subscribeSeatActivity,
    () => seatActivity(address),
    () => seatActivity(address),
  );

  // After an add Privy accepted, Grant is held back for GRANT_HOLD_MS: its record may not show the seat yet, and a
  // grant on a record that lags appends the signer a second time.
  const grant = useCallback(async () => {
    if (!beginSeatTask(address, "granting")) return;
    try {
      const outcome = await grantKeeperSeat({ address, config, renderedUser: user, addSigners, refreshUser });
      if (outcome === "has-signer") endSeatTask(address);
      else endSeatTask(address, { notice: outcome === "added-record-lags" ? GRANT_COPY.addedRecordLags : null, holdGrantFor: GRANT_HOLD_MS });
    } catch (error) {
      endSeatTask(address, { failure: failureText(error), ...(error instanceof GrantUnconfirmed ? { holdGrantFor: GRANT_HOLD_MS } : {}) });
    }
  }, [address, config, user, addSigners, refreshUser]);

  const reseat = useCallback(async () => {
    if (!beginSeatTask(address, "reseating")) return;
    try {
      const outcome = await reseatKeeperSeat({ address, config, renderedUser: user, removeSigners, addSigners, refreshUser });
      endSeatTask(address, { notice: outcome === "reseated" ? RESEAT_COPY.done : RESEAT_COPY.grantedOnly, holdGrantFor: GRANT_HOLD_MS });
    } catch (error) {
      const added = error instanceof ReseatIncomplete && ADDED_STAGES.has(error.stage);
      endSeatTask(address, { failure: failureText(error), ...(added ? { holdGrantFor: GRANT_HOLD_MS } : {}) });
    }
  }, [address, config, user, removeSigners, addSigners, refreshUser]);

  const check = useCallback(async () => {
    if (!beginSeatTask(address, "checking", { keepNotice: true })) return;
    try {
      await refreshUser();
      endSeatTask(address);
    } catch (error) {
      endSeatTask(address, { failure: failureText(error) });
    }
  }, [address, refreshUser]);

  return {
    seat: seatOf(user, address),
    reseatBlocked: reseatRefusal(user, address),
    grantBlocked: grantRefusal(user, address),
    grant,
    reseat,
    check,
    busy: activity.busy,
    failure: activity.failure,
    notice: activity.notice,
    grantHeld: activity.holdGrantUntil !== null,
  } as const;
}

/** The re-seat stops after which Privy may have the keeper's signer on the wallet while its record does not show it. */
const ADDED_STAGES: ReadonlySet<ReseatStage> = new Set<ReseatStage>(["added-record-lags", "added-unconfirmed", "id-dropped"]);
