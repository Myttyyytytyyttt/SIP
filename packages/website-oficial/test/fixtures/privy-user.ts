// A Privy user record shaped like @privy-io/react-auth 3.36.0's own types (User, WalletWithMetadata),
// and typed against them, so a change in the installed SDK's shape fails typecheck here rather than
// passing tests on a record Privy no longer sends. Every address is a placeholder. SIGNER and POLICY
// are this deployment's public keeper signer and policy ids: ids, not keys.

import type { LinkedAccountWithMetadata, User, WalletWithMetadata } from "@privy-io/react-auth";

export const SIGNER = "cbx133itb717vxp3dqwhk808";
export const POLICY = "jsuzcjv6njl0raqjjhzqe9fh";

export const PENSION_KEY = "PensionKeyP1aceho1der111111111111111111111";
export const TRADING_0 = "TradingZeroP1aceho1der11111111111111111111";
export const TRADING_1 = "TradingOneP1aceho1der111111111111111111111";
export const TRADING_2 = "TradingTwoP1aceho1der111111111111111111111";
export const IMPORTED = "ImportedP1aceho1der1111111111111111111111";
export const EVM_EMBEDDED = "0x0000000000000000000000000000000000000001";

const VERIFIED = {
  firstVerifiedAt: new Date("2026-09-15T00:00:00.000Z"),
  latestVerifiedAt: new Date("2026-09-15T00:00:00.000Z"),
};

/** The pension key as Privy links it after a Phantom login: external, so never delegated and never indexed. */
export function phantom(address: string = PENSION_KEY): WalletWithMetadata {
  return {
    type: "wallet",
    address,
    chainType: "solana",
    walletClientType: "phantom",
    connectorType: "solana_adapter",
    imported: false,
    delegated: false,
    walletIndex: null,
    ...VERIFIED,
  };
}

/** A Privy embedded Solana wallet. Privy's server wallet id is null until the wallet has a signer. */
export function embedded(
  address: string,
  walletIndex: number | null,
  delegated: boolean,
  extra: Partial<WalletWithMetadata> = {},
): WalletWithMetadata {
  return {
    type: "wallet",
    address,
    chainType: "solana",
    walletClientType: "privy",
    connectorType: "embedded",
    imported: false,
    delegated,
    walletIndex,
    id: delegated ? `wallet-id-${address.slice(0, 10).toLowerCase()}` : null,
    ...VERIFIED,
    ...extra,
  };
}

/**
 * A trading wallet as this Privy app makes them, in TEE execution: walletClientType privy, a server wallet id, and
 * recoveryMethod privy-v2 — the SDK's own test (isUnifiedWallet) for a wallet whose signers removeSigners clears one
 * wallet at a time. The id is set whatever `delegated` says: a TEE wallet is a server wallet from its creation.
 */
export function teeWallet(
  address: string,
  walletIndex: number | null,
  delegated: boolean,
  extra: Partial<WalletWithMetadata> = {},
): WalletWithMetadata {
  return embedded(address, walletIndex, delegated, {
    id: `wallet-id-${address.slice(0, 10).toLowerCase()}`,
    recoveryMethod: "privy-v2",
    ...extra,
  });
}

/** A user whose first linked wallet is the one they signed in with, the way Privy fills `user.wallet`. */
export function userWith(linkedAccounts: LinkedAccountWithMetadata[]): User {
  const first = linkedAccounts.find((account) => account.type === "wallet");
  return {
    id: "did:privy:placeholder",
    createdAt: new Date("2026-09-15T00:00:00.000Z"),
    ...(first !== undefined && first.type === "wallet" ? { wallet: first } : {}),
    linkedAccounts,
    mfaMethods: [],
    hasAcceptedTerms: false,
    isGuest: false,
  };
}

/**
 * One account with everything Privy can list: the Phantom pension key, an email, trading wallets out
 * of HD order in both embedded generations, one seated and one not, an imported wallet, an EVM
 * embedded wallet, and a duplicate entry.
 */
export const RECORD: User = userWith([
  phantom(),
  { type: "email", address: "someone@example.invalid", ...VERIFIED },
  embedded(TRADING_1, 1, true),
  embedded(EVM_EMBEDDED, 0, true, { chainType: "ethereum" }),
  embedded(IMPORTED, null, false, { imported: true }),
  embedded(TRADING_0, 0, false),
  embedded(TRADING_2, 2, true, { walletClientType: "privy-v2" }),
  embedded(TRADING_0, 0, false),
]);
