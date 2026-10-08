// The Solana half of the dev-only Privy stand-in. See privy-react-auth.ts for
// why this exists and how it is gated.
//
// Everything here is a no-op: the screenshot script never signs, never creates or
// imports a wallet and never exports one. It only needs these exports to EXIST, because
// the wallet screens import them at module level.

if (process.env.NODE_ENV === "production") {
  throw new Error("test/stubs/privy-react-auth-solana.ts was imported in a production build. It is a screenshot stub and must never ship.");
}

export function toSolanaWalletConnectors(): Record<string, never> {
  return {};
}

export function useSolanaLedgerPlugin(): void {
  // The real one registers a Ledger signer. Nothing signs in a screenshot.
}

export function useWallets(): { ready: boolean; wallets: readonly { address: string }[] } {
  return { ready: true, wallets: [] };
}

export function useSignTransaction(): { signTransaction: () => Promise<never> } {
  return {
    signTransaction: async () => {
      throw new Error("the Privy stub never signs");
    },
  };
}

export function useSignMessage(): { signMessage: () => Promise<never> } {
  return {
    signMessage: async () => {
      throw new Error("the Privy stub never signs");
    },
  };
}

export function useCreateWallet(): { createWallet: () => Promise<never> } {
  return {
    createWallet: async () => {
      throw new Error("the Privy stub never creates a wallet");
    },
  };
}

export function useExportWallet(): { exportWallet: () => Promise<never> } {
  return {
    exportWallet: async () => {
      throw new Error("the Privy stub never exports a key");
    },
  };
}

/**
 * The import, for the import panel's E2E. It throws unless the script set
 * `importAs` on the injected state: then it adds that address to the user as an
 * imported TEE wallet WITH a signer — what Privy's record should show after an
 * import with additionalSigners — and records the signers it was handed. The key
 * itself is never kept: only whether one came, and its length.
 */
interface ImportStub {
  user: { linkedAccounts: unknown[] } | null;
  importAs?: string;
  lastImport?: { additionalSigners: unknown; keyLength: number };
}

export function useImportWallet(): { importWallet: (input: { privateKey: string; additionalSigners?: unknown }) => Promise<{ address: string }> } {
  return {
    importWallet: async ({ privateKey, additionalSigners }) => {
      const state = (globalThis as unknown as { __SAVERFI_PRIVY_STUB__?: ImportStub }).__SAVERFI_PRIVY_STUB__;
      if (state === undefined || state.importAs === undefined || state.user === null) throw new Error("the Privy stub never imports a key");
      state.lastImport = { additionalSigners, keyLength: privateKey.length };
      // A new user object, as Privy's refresh gives: the page memoises on the record's identity.
      state.user = { ...state.user, linkedAccounts: [...state.user.linkedAccounts, {
        type: "wallet",
        address: state.importAs,
        chainType: "solana",
        walletClientType: "privy",
        connectorType: "embedded",
        imported: true,
        delegated: true,
        // As Privy records an imported Solana wallet: index 0, the first created wallet's number too.
        walletIndex: 0,
        id: "wallet-id-imported-stub",
        recoveryMethod: "privy-v2",
        firstVerifiedAt: "2026-10-08T00:00:00.000Z",
        latestVerifiedAt: "2026-10-08T00:00:00.000Z",
      }] };
      window.dispatchEvent(new Event("saverfi-privy-stub-changed"));
      return { address: state.importAs };
    },
  };
}
