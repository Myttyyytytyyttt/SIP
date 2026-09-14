// Per-wallet local signers, for localnet only.
//
// Ported from the old supervisor's loadSigners(). Nuvem read them from a fixed
// scripts/.local/signers directory it created on demand; SIP reads them only
// from SIP_SOLANA_LOCAL_SIGNERS_DIR, which has no default, is read only when
// armed, and config.ts refuses unless every endpoint is loopback. Against a real
// cluster the keeper signs as a trading wallet through Privy and holds no key.
//
// REGISTERED LIKE THE SETTLE KEY. They are throwaway localnet wallets, but they
// are secret keys in this process all the same, and the redactor only scrubs
// what it was told about.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { sharedRedactor, type Redactor, type Secret } from "@sip/solana-log";
import { registerSecretKeyForms } from "./config.js";

export interface LocalSigners {
  readonly signers: ReadonlyMap<string, Keypair>;
  /** File names that were not a JSON array secret key. Names only. */
  readonly skipped: readonly string[];
  /** Set when the directory itself could not be read. */
  readonly problem: string | null;
}

/** Per-wallet signers, keyed by the wallet's own address. Re-read every sweep, as the old supervisor did. */
export function loadLocalSigners(dir: Secret, redactor: Redactor = sharedRedactor): LocalSigners {
  const signers = new Map<string, Keypair>();
  const skipped: string[] = [];
  const path = dir.reveal();
  if (!existsSync(path)) {
    return { signers, skipped, problem: "SIP_SOLANA_LOCAL_SIGNERS_DIR does not exist; no local signer is available" };
  }
  let files: string[];
  try {
    files = readdirSync(path);
  } catch {
    return { signers, skipped, problem: "SIP_SOLANA_LOCAL_SIGNERS_DIR could not be listed; no local signer is available" };
  }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const bytes = Uint8Array.from(JSON.parse(readFileSync(join(path, file), "utf8")) as number[]);
      const keypair = Keypair.fromSecretKey(bytes);
      // After the key proved to be one (a short array would register needles
      // that match ordinary text) and before anything can print it.
      registerSecretKeyForms(bytes, redactor, "localSigner");
      signers.set(keypair.publicKey.toBase58(), keypair);
    } catch {
      // Skip and NAME THE FILE only — a parse error's message can carry the
      // file's own bytes, and these files are secret keys.
      skipped.push(file);
    }
  }
  return { signers, skipped, problem: null };
}
