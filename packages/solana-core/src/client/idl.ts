// The one place the sip_vault IDL is loaded. Browser-safe.
//
// Every discriminator, argument order, account list and layout in this package
// comes from @sip/solana-program/idl (packages/solana-program/idl/sip_vault.json,
// committed, copied from target/idl by `pnpm idl:export`). Nothing here is
// typed from memory and nothing hashes names at runtime: Nuvem's builders
// hashed "create_vault" and "set_policy", which SIP's program does not have.
//
// NAMES ARE THE IDL'S, snake_case. Anchor 0.32's TypeScript Program camelCases
// them (max_rolling_30d becomes maxRolling30D) and the keeper crashed on exactly
// that; this package never goes through Program, so the names stay as written.
//
// WHAT DOES NOT THROW AT LOAD. The owner/forbidden classification below must
// cover every IDL instruction, but that is enforced by test/idl.test.ts and by
// `pnpm check:idl` (which the web's prebuild runs), not by a throw here: a
// program that gains an instruction must fail the build, not crash every page
// that imports this module after deploy. At runtime an unclassified instruction
// is simply not an owner instruction, and the verifier refuses it.

import idlJson from "@sip/solana-program/idl";

export type IdlType =
  | string
  | { readonly array: readonly [IdlType, number] }
  | { readonly vec: IdlType }
  | { readonly option: IdlType }
  | { readonly defined: { readonly name: string } };

export interface IdlField {
  readonly name: string;
  readonly type: IdlType;
  readonly docs?: readonly string[];
}

export interface IdlTypeDef {
  readonly name: string;
  readonly docs?: readonly string[];
  readonly type: { readonly kind: string; readonly fields?: readonly IdlField[] };
}

export interface IdlAccountItem {
  readonly name: string;
  readonly signer?: boolean;
  readonly writable?: boolean;
  readonly address?: string;
  readonly pda?: unknown;
  readonly relations?: readonly string[];
  readonly docs?: readonly string[];
}

export interface IdlInstruction {
  readonly name: string;
  readonly discriminator: readonly number[];
  readonly accounts: readonly IdlAccountItem[];
  readonly args: readonly IdlField[];
}

export interface SipVaultIdl {
  readonly address: string;
  readonly metadata: { readonly name: string; readonly version: string };
  readonly instructions: readonly IdlInstruction[];
  readonly accounts: readonly { readonly name: string; readonly discriminator: readonly number[] }[];
  readonly events: readonly { readonly name: string; readonly discriminator: readonly number[] }[];
  readonly errors: readonly { readonly code: number; readonly name: string; readonly msg?: string }[];
  readonly types: readonly IdlTypeDef[];
}

export const SIP_IDL = idlJson as unknown as SipVaultIdl;

/**
 * Nuvem's program. Its upgrade authority key leaked, so whoever holds that key
 * can rewrite its logic: nothing in SIP may ever talk to it. Named only so the
 * refusals can compare against it — the same constant the keeper holds.
 */
export const OLD_NUVEM_PROGRAM_ID = "7rtgXTu852M1NTx7PLoJd3bChaCb2hgsgv5o54aFv6Fy";

/** The sip-vault program id, as the IDL states it. Never typed by hand. */
export const SIP_PROGRAM_ID: string = SIP_IDL.address;

if (SIP_PROGRAM_ID === OLD_NUVEM_PROGRAM_ID) {
  // The one load-time throw: no configuration can make an IDL that names
  // Nuvem's program safe to build or verify with.
  throw new Error("the sip_vault IDL names a program SaverFi does not use; refusing to load it");
}

/** What an owner (or a linked wallet) signs in the web. The only SIP instructions /api/solana-tx relays. */
export const OWNER_INSTRUCTIONS = [
  "create_vault_v2",
  "set_policy_v2",
  "link_wallet",
  "unlink_wallet",
  "withdraw",
  "withdraw_token",
  "set_invest_policy",
] as const;
export type OwnerInstructionName = (typeof OWNER_INSTRUCTIONS)[number];

/** Keeper-only and authority-only instructions. The web never builds or relays them. */
export const FORBIDDEN_INSTRUCTIONS = [
  "settle_v2",
  "invest",
  "convert",
  "wrap_sol",
  "init_config",
  "set_attester",
  "set_keeper",
  "transfer_authority",
  "accept_authority",
  "set_protocol_paused",
] as const;
export type ForbiddenInstructionName = (typeof FORBIDDEN_INSTRUCTIONS)[number];

export const isOwnerInstruction = (name: string): name is OwnerInstructionName =>
  (OWNER_INSTRUCTIONS as readonly string[]).includes(name);

export const isForbiddenInstruction = (name: string): name is ForbiddenInstructionName =>
  (FORBIDDEN_INSTRUCTIONS as readonly string[]).includes(name);

/**
 * Upper bounds for the IDL's unbounded vectors. The IDL carries no max_len, so
 * the account space Anchor allocates cannot be computed from it alone:
 * InvestmentPolicy.legs is `#[max_len(MAX_LEGS)]` with `MAX_LEGS: usize = 8` in
 * state.rs. test/idl.test.ts reads state.rs and pins this table to it.
 */
export const IDL_VEC_MAX_LEN: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  InvestmentPolicy: { legs: 8 },
};

/** The instruction set minus the classification, both ways. Empty when every instruction is classified exactly once. */
export function idlPartitionProblems(idl: SipVaultIdl = SIP_IDL): string[] {
  const problems: string[] = [];
  const names = idl.instructions.map((instruction) => instruction.name);
  const owner = new Set<string>(OWNER_INSTRUCTIONS);
  const forbidden = new Set<string>(FORBIDDEN_INSTRUCTIONS);
  for (const name of names) {
    if (owner.has(name) && forbidden.has(name)) problems.push(`${name} is classified both as an owner and as a forbidden instruction`);
    if (!owner.has(name) && !forbidden.has(name)) {
      problems.push(
        `${name} is in the IDL but in neither OWNER_INSTRUCTIONS nor FORBIDDEN_INSTRUCTIONS (packages/solana-core/src/client/idl.ts): classify it`,
      );
    }
  }
  for (const name of [...owner, ...forbidden]) {
    if (!names.includes(name)) problems.push(`${name} is classified but the IDL has no such instruction`);
  }
  if (idl.address === OLD_NUVEM_PROGRAM_ID) problems.push("the IDL names a program SaverFi does not use");
  return problems;
}

export function idlInstruction(name: string): IdlInstruction {
  const found = SIP_IDL.instructions.find((instruction) => instruction.name === name);
  if (found === undefined) throw new Error(`the sip_vault IDL has no instruction ${name}`);
  return found;
}

export function idlTypeDef(name: string): IdlTypeDef {
  const found = SIP_IDL.types.find((type) => type.name === name);
  if (found === undefined) throw new Error(`the sip_vault IDL has no type ${name}`);
  return found;
}

export function instructionDiscriminator(name: string): Uint8Array {
  return Uint8Array.from(idlInstruction(name).discriminator);
}

export function accountDiscriminator(name: string): Uint8Array {
  const found = SIP_IDL.accounts.find((account) => account.name === name);
  if (found === undefined) throw new Error(`the sip_vault IDL has no account ${name}`);
  return Uint8Array.from(found.discriminator);
}

export function eventDiscriminator(name: string): Uint8Array {
  const found = SIP_IDL.events.find((event) => event.name === name);
  if (found === undefined) throw new Error(`the sip_vault IDL has no event ${name}`);
  return Uint8Array.from(found.discriminator);
}

export function bytesEqual(a: Uint8Array, b: Uint8Array | readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export const toHex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/** The IDL instruction whose 8-byte discriminator starts `data`, or null. */
export function matchInstruction(data: Uint8Array): IdlInstruction | null {
  if (data.length < 8) return null;
  const head = data.subarray(0, 8);
  return SIP_IDL.instructions.find((instruction) => bytesEqual(head, instruction.discriminator)) ?? null;
}

/** A program error by its custom code (6000…), for turning `{Custom: 6013}` into words. */
export function idlErrorByCode(code: number): { readonly name: string; readonly msg: string | null } | null {
  const found = SIP_IDL.errors.find((error) => error.code === code);
  return found === undefined ? null : { name: found.name, msg: found.msg ?? null };
}
