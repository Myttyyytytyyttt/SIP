"use client";

/**
 * Whether the keeper holds its policy-bound seat on a trading wallet, and the
 * repair when it does not.
 *
 * READ FROM PRIVY'S OWN RECORD, EVERY RENDER. The `delegated` flag on the
 * wallet in the user object is the fact; having a signer id configured only
 * means we intended to ask. Reporting the second as if it were the first is a
 * false security claim — it tells the user their savings are being collected
 * when nothing can collect them. Nothing here is cached in local state.
 *
 * Ported from HEAD (fd927b0) src/components/InviteTradingWallet.tsx
 * (`hasSeat`, `authoriseKeeper`) — Solana and the profit presets dropped.
 */

import { usePrivy, useSigners, useUser, type User } from "@privy-io/react-auth";
import { LoaderCircle } from "lucide-react";
import { useState } from "react";
import type { Address } from "viem";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { PublicConfig } from "@/lib/config";
import { describeError } from "@/lib/wallets/judge";
import { SEAT_BACKOFF_MS, SEAT_NOT_CONFIGURED, seatSigners } from "@/lib/wallets/policy";

/**
 * The seat as Privy records it: true or false for a wallet Privy holds, null
 * when the user record does not list this address at all (an external wallet,
 * or one created seconds ago that has not reached the record yet).
 */
export function seatOf(user: User | null, address: string): boolean | null {
  const target = address.toLowerCase();
  for (const account of user?.linkedAccounts ?? []) {
    if (account.type === "wallet" && account.chainType === "ethereum" && account.address.toLowerCase() === target) {
      return account.delegated === true;
    }
  }
  return null;
}

export function SeatStatus({
  address,
  config,
  held,
  onChanged,
}: {
  address: Address;
  config: PublicConfig;
  /** Whether Privy holds this wallet's key. An external wallet has no seat to grant. */
  held: boolean;
  onChanged?: () => void;
}) {
  const { user } = usePrivy();
  const { refreshUser } = useUser();
  const { addSigners } = useSigners();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const seat = seatOf(user, address);

  if (!held) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="secondary" tabIndex={0}>
            No seat
          </Badge>
        </TooltipTrigger>
        <TooltipContent>Privy does not hold this wallet, so the keeper has no seat on it — nothing is collected from it.</TooltipContent>
      </Tooltip>
    );
  }

  /**
   * Grant the keeper permission to settle. Separate so it can be retried.
   *
   * WITH PATIENCE, AND ONE USER REFRESH. A wallet created moments ago has not
   * always reached Privy's user record, and this call checks that record — so
   * the first attempt can fail on a wallet that is perfectly fine. Sleeping
   * alone would only hope the record caught up; asking Privy to re-fetch the
   * user is what moves the state this is blocked on.
   *
   * ONE REFRESH, NOT ONE PER ATTEMPT. Privy rate-limits /users/me, and
   * refetching on every retry turned a propagation delay into a 429 storm that
   * GUARANTEED the staleness it was trying to cure. One nudge, early, then
   * wait: the SDK updates its own copy of the user in the background anyway.
   *
   * ONLY THE PROPAGATION RACE IS RETRIED. Any other refusal is an answer, and
   * asking six times does not change it. Privy says "not associated with
   * current user" when the wallet has not reached the user record, and "must
   * be authenticated and have an embedded wallet" when the SDK's own copy of
   * the user has not caught up either. Both mean "ask again in a moment".
   */
  async function authorise() {
    const signers = seatSigners(config);
    // NEVER AN EMPTY policyIds ARRAY — Privy reads that as FULL permission
    // over the wallet, which is the one thing a signer must never have.
    if (signers === null) {
      setFailure(SEAT_NOT_CONFIGURED);
      return;
    }
    setFailure(null);
    setBusy(true);
    try {
      let lastError: unknown = null;
      let attached = false;
      for (let attempt = 0; attempt < SEAT_BACKOFF_MS.length && !attached; attempt += 1) {
        try {
          await addSigners({
            address,
            signers: signers.map((signer) => ({ signerId: signer.signerId, policyIds: [...signer.policyIds] })),
          });
          attached = true;
        } catch (error) {
          lastError = error;
          const why = describeError(error);
          if (!/not associated|embedded wallet to add a session signer/i.test(why)) throw error;
          if (attempt === 0) await refreshUser().catch(() => undefined);
          await new Promise((resolve) => setTimeout(resolve, SEAT_BACKOFF_MS[attempt] ?? 8_000));
        }
      }
      if (!attached) throw lastError instanceof Error ? lastError : new Error(String(lastError));
      // The `delegated` flag this component renders lives on the user object;
      // refresh it so the badge flips from Privy's record, not from a guess.
      await refreshUser().catch(() => undefined);
      onChanged?.();
    } catch (error) {
      setFailure(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {seat === true ? (
        <Badge variant="outline">Authorised</Badge>
      ) : seat === false ? (
        <Badge variant="destructive">Not authorised</Badge>
      ) : (
        <Badge variant="secondary">Seat unknown</Badge>
      )}
      {seat !== true ? (
        <Button type="button" size="xs" variant="outline" disabled={busy} aria-busy={busy} onClick={() => void authorise()}>
          {busy ? <LoaderCircle className="animate-spin" aria-hidden /> : null}
          {busy ? "Authorising…" : seat === false ? "Re-authorise" : "Authorise"}
        </Button>
      ) : null}
      {failure !== null ? (
        <span role="alert" className="basis-full text-xs text-destructive">
          {failure}
        </span>
      ) : null}
    </div>
  );
}
