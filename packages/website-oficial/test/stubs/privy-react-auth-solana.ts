// The Solana half of the dev-only Privy stand-in. See privy-react-auth.ts for
// why this exists and how it is gated.
//
// Everything here is a no-op: the screenshot script never signs, never creates a
// wallet and never exports one. It only needs these exports to EXIST, because
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
