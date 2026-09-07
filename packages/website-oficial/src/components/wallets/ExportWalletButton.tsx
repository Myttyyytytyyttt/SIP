"use client";

/**
 * Hand the wallet's key to its owner — through Privy's dialog, never our DOM.
 *
 * Exporting is about the wallet being usable at all: this key lives inside
 * Privy, and a trading front-end you sign into elsewhere cannot reach it.
 * Without the export the user owns a wallet they cannot trade from, which
 * makes the whole product inert. Privy renders the key in an iframe on its own
 * domain, so this page never sees it — a page that holds a key holds it for
 * every extension too. Signers cannot export a key at all, so this remains
 * something only the wallet's owner can do; the keeper's seat is unaffected.
 *
 * Ported from HEAD (fd927b0) src/components/WalletsPanel.tsx (the row's
 * "Export key" button) and src/components/Onboarding.tsx (the key-note).
 */

import { useExportWallet } from "@privy-io/react-auth";
import { KeyRound, LoaderCircle } from "lucide-react";
import { useState } from "react";
import type { Address } from "viem";

import { Button } from "@/components/ui/button";
import { describeError } from "@/lib/wallets/judge";

export function ExportWalletButton({ address, disabled = false }: { address: Address; disabled?: boolean }) {
  const { exportWallet } = useExportWallet();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function run() {
    setFailure(null);
    setBusy(true);
    try {
      // Resolves when the user closes Privy's modal; the key never comes back here.
      await exportWallet({ address });
    } catch (error) {
      setFailure(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button type="button" variant="outline" size="sm" disabled={disabled || busy} aria-busy={busy} onClick={() => void run()}>
        {busy ? <LoaderCircle className="animate-spin" aria-hidden /> : <KeyRound aria-hidden />}
        {busy ? "Privy dialog open…" : "Export key"}
      </Button>
      {failure !== null ? (
        <span role="alert" className="basis-full text-xs text-destructive">
          {failure}
        </span>
      ) : null}
    </>
  );
}
