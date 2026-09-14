// PDA and ATA derivation with @solana/web3.js, against the IDL's program id.
//
// Seeds are the constants in client/pda.ts, which test/idl.test.ts pins to the
// seeds the IDL records. Ported from Nuvem solana-tx.ts (deriveVaultPda,
// deriveLinkPda, deriveInvestPda, deriveAta) with the program id no longer a
// parameter: there is one program, and it comes from the IDL.

import { PublicKey } from "@solana/web3.js";

import { ATA_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "../client/addresses";
import { SIP_PROGRAM_ID } from "../client/idl";
import { CONFIG_SEED, INVEST_SEED, LINK_SEED, VAULT_SEED } from "../client/pda";

export type KeyLike = PublicKey | string;

export class InvalidKeyError extends Error {
  override readonly name = "InvalidKeyError";
}

/** A PublicKey from a base58 string or a PublicKey; throws InvalidKeyError naming `what`. */
export function toPublicKey(key: KeyLike, what = "key"): PublicKey {
  if (key instanceof PublicKey) return key;
  if (typeof key !== "string" || key.length < 32 || key.length > 44) throw new InvalidKeyError(`${what} is not a base58 32-byte public key`);
  try {
    return new PublicKey(key);
  } catch {
    throw new InvalidKeyError(`${what} is not a base58 32-byte public key`);
  }
}

export const SIP_PROGRAM_KEY = new PublicKey(SIP_PROGRAM_ID);
const ATA_PROGRAM_KEY = new PublicKey(ATA_PROGRAM);
const text = new TextEncoder();

const find = (seeds: Uint8Array[], program: PublicKey = SIP_PROGRAM_KEY): PublicKey => PublicKey.findProgramAddressSync(seeds, program)[0];

/** ["vault", owner] */
export const deriveVaultPda = (owner: KeyLike): PublicKey => find([text.encode(VAULT_SEED), toPublicKey(owner, "owner").toBytes()]);

/** ["link", wallet] — keyed by the wallet, so one wallet has at most one link. */
export const deriveLinkPda = (wallet: KeyLike): PublicKey => find([text.encode(LINK_SEED), toPublicKey(wallet, "wallet").toBytes()]);

/** ["invest", vault] */
export const deriveInvestPda = (vault: KeyLike): PublicKey => find([text.encode(INVEST_SEED), toPublicKey(vault, "vault").toBytes()]);

/** ["config"] */
export const deriveConfigPda = (): PublicKey => find([text.encode(CONFIG_SEED)]);

/** The associated token account of (owner, mint) under classic SPL Token or Token-2022. */
export function deriveAta(owner: KeyLike, mint: KeyLike, tokenProgram: KeyLike): PublicKey {
  const program = toPublicKey(tokenProgram, "tokenProgram");
  const name = program.toBase58();
  if (name !== TOKEN_PROGRAM && name !== TOKEN_2022_PROGRAM) {
    throw new InvalidKeyError("tokenProgram must be the SPL Token or Token-2022 program");
  }
  return find([toPublicKey(owner, "owner").toBytes(), program.toBytes(), toPublicKey(mint, "mint").toBytes()], ATA_PROGRAM_KEY);
}
