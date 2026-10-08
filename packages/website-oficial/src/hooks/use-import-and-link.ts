"use client";

import { useUser } from "@privy-io/react-auth";
// THE SOLANA ENTRY, never the root: the root package's useImportWallet takes an EVM key.
import { useImportWallet } from "@privy-io/react-auth/solana";
import { useCallback, useRef, useState } from "react";

import { useVaultWrite } from "@/hooks/use-vault-actions";
import type { ImportAndLinkOutcome } from "@/lib/create-and-link";
import type { SeatConfig } from "@/lib/trading-wallets";

/**
 * ONE PRESS: a wallet the person already uses, imported seated, then linked to
 * the vault — the import's twin of useCreateAndLink, under the same screen-wide
 * write lock (src/hooks/use-vault-actions.ts).
 *
 * ONE IMPORT AT A TIME: the lock disables every write on the screen, and this ref
 * closes the gap before React re-renders.
 *
 * THE KEY IS NOT HERE. The panel hands `takeKey`, which reads its own field once
 * and empties it; this hook keeps the imported ADDRESS (`imported`), so the
 * list shows the wallet from the moment Privy has it, whatever the link does.
 */
export function useImportAndLink(config: SeatConfig) {
  const { importWallet } = useImportWallet();
  const { refreshUser } = useUser();
  const write = useVaultWrite("import-and-link");
  const [imported, setImported] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<ImportAndLinkOutcome | null>(null);
  const inFlight = useRef(false);

  const run = useCallback(
    async (input: { readonly takeKey: () => Promise<string | null>; readonly expected: string; readonly needsLink: boolean }) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setOutcome(null);
      try {
        await write.importAndLink({
          importWallet,
          config,
          refreshUser,
          takeKey: input.takeKey,
          expected: input.expected,
          needsLink: input.needsLink,
          onImported: setImported,
          onOutcome: setOutcome,
        });
      } finally {
        inFlight.current = false;
      }
    },
    [write, importWallet, refreshUser, config],
  );

  const dismiss = useCallback(() => setOutcome(null), []);

  return { run, imported, outcome, dismiss, write } as const;
}
