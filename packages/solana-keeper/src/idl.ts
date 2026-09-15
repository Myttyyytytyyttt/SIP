// The one program this keeper talks to, from the IDL the program exports.
//
// READ EXPLICITLY, not via anchor.workspace: the workspace needs Anchor.toml at
// cwd plus env conventions, none of which exist in a container. Nuvem's keeper
// read target/idl/nuvem_vault.json by a relative path; SIP's reads
// packages/solana-program/idl/sip_vault.json through @sip/solana-program's
// exports. That file is COMMITTED — copied from target/idl by `pnpm idl:export`
// after `anchor build` — so an image never needs the Rust toolchain to know the
// program's interface, and test/idl.test.ts pins it to target/ whenever a build
// exists.

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { Idl } from "@coral-xyz/anchor";

const require = createRequire(import.meta.url);

/**
 * Nuvem's program. Its upgrade authority key leaked, so whoever holds that key
 * can rewrite the program's logic at will: nothing in SIP may ever talk to it.
 * Named here so the refusals can compare against it; used for nothing else.
 */
export const OLD_NUVEM_PROGRAM_ID = "7rtgXTu852M1NTx7PLoJd3bChaCb2hgsgv5o54aFv6Fy";

export type SipVaultIdl = Idl & { readonly address: string };

/** Where the exported IDL resolved from. Diagnostic, and what the IDL test compares against target/. */
export const IDL_PATH: string = require.resolve("@sip/solana-program/idl");
export const idl = require("@sip/solana-program/idl") as SipVaultIdl;

/** The sip-vault program id, as the exported IDL states it. Never typed by hand. */
export const SIP_PROGRAM_ID: string = idl.address;

if (SIP_PROGRAM_ID === OLD_NUVEM_PROGRAM_ID) {
  // A file-level guard, not a config check: if the exported IDL itself ever
  // names Nuvem's program, no configuration can make this keeper safe to run.
  throw new Error("the exported sip_vault IDL names a retired program; refusing to load it");
}

export function hasInstruction(name: string): boolean {
  return idl.instructions.some((instruction) => instruction.name === name);
}

/** An account's 8-byte discriminator as the IDL records it. */
export function accountDiscriminator(name: string): Buffer {
  const account = idl.accounts?.find((candidate) => candidate.name === name);
  if (account === undefined) throw new Error(`the exported IDL has no ${name} account`);
  return Buffer.from(account.discriminator);
}

/**
 * An instruction's 8-byte discriminator as the IDL records it: the first eight
 * bytes of its data, which is how a transaction names the instruction it calls.
 */
export function instructionDiscriminator(name: string): Buffer {
  const instruction = idl.instructions.find((candidate) => candidate.name === name);
  if (instruction === undefined) throw new Error(`the exported IDL has no ${name} instruction`);
  return Buffer.from(instruction.discriminator);
}

/** The same discriminator derived the way Anchor derives it, for the preflight to cross-check. */
export function derivedDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
}
