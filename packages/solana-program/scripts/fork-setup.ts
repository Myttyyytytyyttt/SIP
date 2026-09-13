// Phase 1 of the Raydium fork test: compute the addresses and FABRICATE the
// vault's USDC account, because a cloned validator has no USDC mint authority
// so USDC cannot be minted — it must be injected at genesis via --account.
//
// Writes:
//   scripts/.local/fork-owner.json       persisted owner keypair
//   scripts/.local/vault-usdc.json        a pre-funded SPL USDC account owned
//                                          by the vault PDA, for --account
// Prints the addresses fork.sh needs.

import {
  Keypair,
  PublicKey,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LOCAL = join(__dirname, ".local");
mkdirSync(LOCAL, { recursive: true });

const PROGRAM_ID = new PublicKey("7rtgXTu852M1NTx7PLoJd3bChaCb2hgsgv5o54aFv6Fy");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const USDC_FUND = 30_000_000n; // 30 USDC

function ownerKeypair(): Keypair {
  const path = join(LOCAL, "fork-owner.json");
  if (existsSync(path)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
  const kp = Keypair.generate();
  writeFileSync(path, JSON.stringify([...kp.secretKey]));
  return kp;
}

const owner = ownerKeypair();
const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from("vault"), owner.publicKey.toBuffer()], PROGRAM_ID);
const vaultUsdc = getAssociatedTokenAddressSync(USDC, vaultPda, true, TOKEN_PROGRAM_ID);

// SPL token account, 165 bytes.
const data = Buffer.alloc(165);
USDC.toBuffer().copy(data, 0);
vaultPda.toBuffer().copy(data, 32);
data.writeBigUInt64LE(USDC_FUND, 64);
data.writeUInt8(1, 108); // state = initialized
const accountFile = {
  pubkey: vaultUsdc.toBase58(),
  account: {
    lamports: 2_039_280, // rent-exempt for 165 bytes
    data: [data.toString("base64"), "base64"],
    owner: TOKEN_PROGRAM_ID.toBase58(),
    executable: false,
    rentEpoch: 0,
  },
};
writeFileSync(join(LOCAL, "vault-usdc.json"), JSON.stringify(accountFile, null, 1));

console.log(`OWNER=${owner.publicKey.toBase58()}`);
console.log(`VAULT=${vaultPda.toBase58()}`);
console.log(`VAULT_USDC=${vaultUsdc.toBase58()}`);
