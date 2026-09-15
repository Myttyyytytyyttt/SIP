/**
 * THE PENSION KEY: the Solana wallet the user signed in with, never an embedded one.
 *
 * Client-safe: it reads Privy's `User` object and imports nothing at runtime, so
 * the dashboard shell derives the key in the browser. The key is derived, never
 * stored: the app keeps no copy of who you are, so a disconnect is a disconnect.
 *
 * EXTERNAL ONLY. The pension key withdraws every saving in the vault, so it is a
 * wallet the user brought (Phantom, Backpack, Solflare…). Privy marks its own
 * embedded wallets with walletClientType "privy" or "privy-v2", and those never
 * qualify, even though providers.tsx mints none on login.
 */
import type { User } from "@privy-io/react-auth";

/** Privy's walletClientType values for its embedded wallets (@privy-io/react-auth's Wallet type). Trading wallets are exactly these. */
export const EMBEDDED_CLIENT_TYPES: ReadonlySet<string> = new Set(["privy", "privy-v2"]);

interface WalletFields {
  readonly address: string;
  readonly chainType: string;
  readonly walletClientType?: string | undefined;
}

const isExternalSolana = (wallet: WalletFields): boolean =>
  wallet.chainType === "solana" && !EMBEDDED_CLIENT_TYPES.has(wallet.walletClientType ?? "");

/** The first external Solana wallet: the one the user signed in with, else the first linked one. Null when there is none. */
export function pensionKeyOf(user: User): string | null {
  const primary = user.wallet;
  if (primary !== undefined && isExternalSolana(primary)) return primary.address;
  for (const account of user.linkedAccounts) {
    if (account.type === "wallet" && isExternalSolana(account)) return account.address;
  }
  return null;
}
