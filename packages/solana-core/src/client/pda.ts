// PDA seeds and explorer links. Browser-safe.
//
// The derivation itself (findProgramAddressSync: sha256 plus an off-curve test)
// lives in server/pda.ts with the web3 SDK. The seed strings are pinned by
// test/idl.test.ts to the constant seeds the IDL records for each PDA account.

import { isPubkey, isSignature } from "./base58";

export const VAULT_SEED = "vault";
export const LINK_SEED = "link";
export const INVEST_SEED = "invest";
export const CONFIG_SEED = "config";

/** A Solscan transaction link, or null when `signature` is not a base58 64-byte signature. */
export function solscanTx(signature: string): string | null {
  return isSignature(signature) ? `https://solscan.io/tx/${signature}` : null;
}

/** A Solscan account link, or null when `address` is not a base58 32-byte key. */
export function solscanAccount(address: string): string | null {
  return isPubkey(address) ? `https://solscan.io/account/${address}` : null;
}
