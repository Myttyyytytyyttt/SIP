"use client";

/**
 * One press mints a trading wallet inside Privy, BORN SEATED.
 *
 * createWallet then addSigners is two calls with a gap, and Privy answers the
 * second with "Address to add signers to is not associated with current user"
 * until the new wallet reaches the user record. That race stranded wallets in
 * HEAD's onboarding. Privy takes the signers AT CREATION, and a wallet that is
 * never briefly seatless cannot lose the race.
 *
 * Ported from HEAD (fd927b0) src/components/InviteTradingWallet.tsx
 * (`createOptions`, `generate`).
 */

import { useCreateWallet } from "@privy-io/react-auth";
import { LoaderCircle, Plus } from "lucide-react";
import { useState } from "react";
import { getAddress, type Address } from "viem";

import { Button } from "@/components/ui/button";
import type { PublicConfig } from "@/lib/config";
import { describeError } from "@/lib/wallets/judge";
import { SEAT_NOT_CONFIGURED, seatSigners } from "@/lib/wallets/policy";

export function CreateWalletButton({
  config,
  hasEmbedded,
  onCreated,
  disabled = false,
}: {
  config: PublicConfig;
  /**
   * Privy embedded wallets are HD, so a user can hold many. `createAdditional`
   * is what mints the next index rather than erroring on "you already have one".
   */
  hasEmbedded: boolean;
  onCreated: (address: Address) => void;
  disabled?: boolean;
}) {
  const { createWallet } = useCreateWallet();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function create() {
    // Knowable BEFORE creating anything: a signer with no policy would be
    // refused later, so refuse now, with no wallet minted for nothing. Never
    // an EMPTY policyIds array — Privy reads that as FULL permission.
    const signers = seatSigners(config);
    if (signers === null) {
      setFailure(`${SEAT_NOT_CONFIGURED} Nothing was created.`);
      return;
    }
    setFailure(null);
    setBusy(true);
    try {
      const wallet = await createWallet({
        createAdditional: hasEmbedded,
        signers: signers.map((signer) => ({ signerId: signer.signerId, policyIds: [...signer.policyIds] })),
      });
      onCreated(getAddress(wallet.address));
    } catch (error) {
      setFailure(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button type="button" size="sm" disabled={disabled || busy} aria-busy={busy} onClick={() => void create()}>
        {busy ? <LoaderCircle className="animate-spin" aria-hidden /> : <Plus aria-hidden />}
        {busy ? "Creating…" : "Create a trading wallet"}
      </Button>
      {failure !== null ? (
        <p role="alert" className="max-w-xs text-right text-xs text-destructive">
          {failure}
        </p>
      ) : null}
    </div>
  );
}
