// The verifier behind /api/solana-tx: a fully signed transaction goes out only
// if it is exactly one owner-facing SIP instruction, signed by the people that
// instruction names.
//
// WHY THIS EXISTS. Nuvem's `send` checked `typeof signedTxBase64 === "string"`
// and broadcast whatever it was given through the operator's paid key: an open
// relay for any program, the leaked old one included. This is the replacement.
// It is pure (no network), so every rule below has a test with real signed
// transactions from throwaway keys.
//
// THE RULES, in order (the first failure is the answer):
//   1  size ≤ 1232 bytes                                        too_large
//   2  decodes as a legacy or v0 transaction                    undecodable
//   3  re-serialises to the same bytes                          non_canonical
//      (web3.js's decoder is more lenient than the validator's; what is sent
//       is what was checked, byte for byte)
//   4  no address lookup tables                                 lookup_tables
//   5  1..2 required signatures, one per signature slot         signature_count
//   6  every signature present and a valid ed25519 signature
//      over the message, for EVERY required signer              missing_signature / bad_signature
//   7  Nuvem's program nowhere in the account keys              old_program
//   8  1..4 instructions, each for SIP, ComputeBudget or
//      Ed25519SigVerify, not counting 8c's                      instruction_count / program_not_allowed
//  8b  the Associated Token Account program only beside
//      set_invest_policy, and only its instructions may take the
//      count past 4, to at most 6                               program_not_allowed / instruction_count
//  8c  Lighthouse only as the wallet's checks, by
//      client/lighthouse.ts checkWalletGuards: after every other
//      instruction, at most 6, each one assertion kind Phantom
//      adds, exactly encoded, about one account the others name,
//      adding no key but its program and no privilege to any    lighthouse_misplaced / lighthouse_count /
//                                                               lighthouse_instruction / lighthouse_accounts
//   9  exactly one SIP instruction, an owner instruction, whose
//      arguments decode exactly                                 instruction_count / unknown_discriminator /
//                                                               instruction_not_allowed
//  10  ComputeBudget only SetComputeUnitLimit ≤ 1.4M and
//      SetComputeUnitPrice ≤ 5M µlamports, once each            compute_budget_invalid
//  11  Ed25519SigVerify only as the ONE instruction immediately
//      before link_wallet, and link_wallet never without it     ed25519_misplaced / link_consent_missing
//  12  that instruction in the shape the program reads: no
//      accounts, exactly one signature, every instruction index
//      its own and every offset inside its own data             ed25519_malformed / ed25519_signature_count /
//                                                               ed25519_offsets
//  13  the accounts are the instruction's own: an IDL-fixed
//      address (system program, instructions sysvar) where the
//      IDL fixes one; owner = fee payer (key 0); link_wallet
//      also wallet = key 1, wallet ≠ owner, and vault,
//      trading_link and config at their PDAs; unlink_wallet's
//      authority is the owner of ['vault', owner], signing
//      alone                                                    account_binding / wallet_is_owner /
//                                                               signature_count
// 13b  each of those token-account instructions is CreateIdempotent
//      (data [1], 6 accounts) ahead of set_invest_policy, paid by
//      its owner (the fee payer), for ['vault', owner], a mint the
//      policy names (wSOL, in_mint or a leg), the System program,
//      SPL Token or Token-2022, at ATA(vault, mint, program), no
//      mint twice and at most 3                                 vault_account_invalid
//  14  the consent says what link_wallet will compare: its key is
//      the wallet, its bytes are SIP_LINK_V1 for (program,
//      wallet, vault, owner), and its signature verifies        link_consent_wrong_signer /
//                                                               link_consent_mismatch /
//                                                               link_consent_bad_signature
//
// WHY 11 TO 14. A signature on the transaction is no longer the wallet's consent
// to be linked: a Privy seat holds that key under a policy that can name nothing
// finer than a program id. link_wallet reads back, through the instructions
// sysvar, an Ed25519SigVerify of the wallet's signMessage over SIP_LINK_V1
// immediately before it (link_consent.rs, ed25519_introspection.rs). Those rules
// run here first, so a consent the chain would refuse costs no simulation, and
// an Ed25519 instruction anywhere else is refused because nothing SIP builds
// puts one there.
//
// WHY 8c. Phantom signs on mainnet by appending Lighthouse assertions: each fails
// the transaction if an account did not end up as Phantom's simulation showed.
// They are the only instructions relayed that SaverFi did not build, so they are
// held to what an assertion is. The browser checks Phantom's bytes against the
// build with the same function; this verifier never saw the build, so its
// reference for privileges is what SaverFi's own instructions declare (the IDL's
// metas, CreateIdempotent's, the fee payer's). Without a guard, nothing about
// rule 8c runs.
//
// WHY 8b AND 13b. set_invest_policy creates no token account, and the owner pays
// for the vault's wSOL, USDC and leg accounts in the same transaction. Bound this
// way, a CreateIdempotent can only make a token account owned by the signer's own
// vault, for a mint the policy it sits beside names, paid by that signer: it moves
// no token and sends no lamport anywhere but into that account's rent. A mint
// whose owner is not the named token program fails in simulation.

import { VersionedTransaction, type MessageCompiledInstruction } from "@solana/web3.js";

import { ATA_PROGRAM, COMPUTE_BUDGET_PROGRAM, ED25519_PROGRAM, LIGHTHOUSE_PROGRAM, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, WSOL_MINT } from "../client/addresses";
import { base58Encode } from "../client/base58";
import { base64Encode } from "../client/base64";
import { decodeArgs } from "../client/borsh";
import {
  OLD_NUVEM_PROGRAM_ID,
  SIP_PROGRAM_ID,
  bytesEqual,
  isForbiddenInstruction,
  isOwnerInstruction,
  matchInstruction,
  type OwnerInstructionName,
} from "../client/idl";
import { WALLET_GUARD_REFUSALS, checkWalletGuards, readLighthouseGuard } from "../client/lighthouse";
import { linkConsentMessage } from "../client/link-consent";
import type { KeyPrivileges } from "../client/message";
import { ed25519SignatureValid, readEd25519Verify, type Ed25519Verify } from "./ed25519";
import { deriveAta, deriveConfigPda, deriveLinkPda, deriveVaultPda } from "./pda";
import { MAX_TX_BYTES } from "./relay-policy";

export const VERIFY_REFUSALS = [
  "too_large",
  "undecodable",
  "non_canonical",
  "lookup_tables",
  "signature_count",
  "missing_signature",
  "bad_signature",
  "old_program",
  "program_not_allowed",
  "instruction_count",
  "unknown_discriminator",
  "instruction_not_allowed",
  "compute_budget_invalid",
  "account_binding",
  "wallet_is_owner",
  /** link_wallet with no Ed25519SigVerify immediately before it. */
  "link_consent_missing",
  /** An Ed25519SigVerify that is not the one instruction immediately before link_wallet. */
  "ed25519_misplaced",
  /** The consent's Ed25519SigVerify checks other than exactly one signature. */
  "ed25519_signature_count",
  /** The consent's Ed25519SigVerify lists accounts, or is shorter than its header. */
  "ed25519_malformed",
  /** The consent's Ed25519SigVerify reads from another instruction, or past its own data. */
  "ed25519_offsets",
  /** The consent verifies a key that is not link_wallet's wallet. */
  "link_consent_wrong_signer",
  /** The consent's bytes are not SIP_LINK_V1 for this program, wallet, vault and owner. */
  "link_consent_mismatch",
  /** The consent's signature does not verify: the runtime would refuse the transaction. */
  "link_consent_bad_signature",
  /** A token-account instruction beside set_invest_policy that is not CreateIdempotent of the owner's own vault's account for a policy mint. */
  "vault_account_invalid",
  /** Rule 8c: a Lighthouse instruction that is not a check the wallet may add (client/lighthouse.ts). */
  ...WALLET_GUARD_REFUSALS,
] as const;
export type VerifyRefusal = (typeof VERIFY_REFUSALS)[number];

export const MAX_SIGNERS = 2;
export const MAX_INSTRUCTIONS = 4;
/** The instruction limit when every instruction past MAX_INSTRUCTIONS creates a vault token account beside set_invest_policy. */
export const MAX_INSTRUCTIONS_WITH_VAULT_ACCOUNTS = 6;
/** Token-account creations beside one set_invest_policy: wSOL, the in-mint and a leg. */
export const MAX_VAULT_TOKEN_ACCOUNT_CREATES = 3;
export const MAX_COMPUTE_UNIT_LIMIT = 1_400_000;
export const MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS = 5_000_000n;

export interface VerifiedTransaction {
  readonly tx: VersionedTransaction;
  /** The canonical wire bytes (identical to the input), and their base64: what gets simulated and sent. */
  readonly wire: Uint8Array;
  readonly wireBase64: string;
  readonly version: "legacy" | 0;
  /** base58 of the first signature: the transaction id. */
  readonly signature: string;
  readonly feePayer: string;
  /** The required signers, fee payer first. */
  readonly signers: readonly string[];
  readonly instruction: {
    readonly name: OwnerInstructionName;
    /** IDL account name → address. */
    readonly accounts: Readonly<Record<string, string>>;
    /** IDL argument name → decoded value (bigints for u64/u128). */
    readonly args: Readonly<Record<string, unknown>>;
  };
  readonly computeBudget: { readonly unitLimit: number | null; readonly microLamports: bigint | null };
  /** Every top-level instruction, in order. */
  readonly instructions: readonly { readonly program: string; readonly name: string | null }[];
}

export type VerifyResult =
  | ({ readonly ok: true } & VerifiedTransaction)
  | { readonly ok: false; readonly reason: VerifyRefusal; readonly detail: string };

const refuse = (reason: VerifyRefusal, detail: string): VerifyResult => ({ ok: false, reason, detail });

/** Signing and account rules for the owner instructions, by the IDL account names they bind. */
function bindAccounts(
  name: OwnerInstructionName,
  accounts: Readonly<Record<string, string>>,
  signers: readonly string[],
): VerifyResult | null {
  const feePayer = signers[0]!;
  switch (name) {
    case "link_wallet": {
      const owner = accounts["owner"]!;
      const wallet = accounts["wallet"]!;
      // The program refuses it too (WalletIsOwner): a pension key linked as its
      // own trading wallet would let a seat link and crank with no other key.
      if (owner === wallet) return refuse("wallet_is_owner", "link_wallet names the same key as owner and wallet");
      if (signers.length !== 2) return refuse("signature_count", `link_wallet needs exactly 2 signers (owner, wallet), the message requires ${signers.length}`);
      if (feePayer !== owner) return refuse("account_binding", "link_wallet's owner must be the fee payer (signer 1)");
      if (signers[1] !== wallet) return refuse("account_binding", "link_wallet's wallet must be signer 2");
      // The consent names the vault; it must be the owner's.
      if (accounts["vault"] !== deriveVaultPda(owner).toBase58()) return refuse("account_binding", "link_wallet's vault is not ['vault', owner]");
      if (accounts["trading_link"] !== deriveLinkPda(wallet).toBase58()) return refuse("account_binding", "link_wallet's trading_link is not ['link', wallet]");
      if (accounts["config"] !== deriveConfigPda().toBase58()) return refuse("account_binding", "link_wallet's config is not ['config']");
      return null;
    }
    case "unlink_wallet": {
      const authority = accounts["authority"]!;
      const owner = accounts["owner"]!;
      // The owner alone: the program refuses any other authority
      // (UnlinkUnauthorized), because the linked wallet's key is a Privy seat's.
      if (authority !== owner) return refuse("account_binding", "unlink_wallet's authority must be the vault owner; a wallet cannot unlink itself");
      if (feePayer !== owner) return refuse("account_binding", "unlink_wallet's owner must be the fee payer");
      if (signers.length !== 1) return refuse("signature_count", `unlink_wallet is signed by the vault owner alone; the message requires ${signers.length} signers`);
      // Pure proof that `owner` is the vault's owner: the program derives the vault from it.
      if (accounts["vault"] !== deriveVaultPda(owner).toBase58()) return refuse("account_binding", "unlink_wallet's vault is not ['vault', owner]");
      // trading_link is NOT bound here: the transaction does not name the
      // wallet, so there is no ['link', wallet] to derive. The program pins it
      // instead: its seeds are the link's own stored wallet, and its stored
      // vault must be this vault (LinkVaultMismatch). Any other account fails
      // on chain, in simulation, before it is sent. The builder's derivation is
      // checked in builders.test.ts.
      return null;
    }
    default: {
      const owner = accounts["owner"]!;
      if (signers.length !== 1) return refuse("signature_count", `${name} is signed by its owner alone; the message requires ${signers.length} signers`);
      if (feePayer !== owner) return refuse("account_binding", `${name}'s owner must be the fee payer`);
      return null;
    }
  }
}

const READ_ONLY: KeyPrivileges = { signer: false, writable: false };
/** CreateIdempotent's accounts: the funder signs and pays, the account is created; wallet, mint, System and token program are read. */
const CREATE_IDEMPOTENT_PRIVILEGES: readonly KeyPrivileges[] = [
  { signer: true, writable: true },
  { signer: false, writable: true },
];

/**
 * Rule 8c's reference: the signer and writable flags SaverFi's own instructions
 * declare for each key they name (the fee payer's, the IDL's metas for the SIP
 * instruction, CreateIdempotent's for a token-account creation, read-only for
 * every program), which is what the message carries without the wallet's checks.
 */
function declaredPrivileges(keys: readonly string[], compiled: readonly MessageCompiledInstruction[]): Map<string, KeyPrivileges> {
  const declared = new Map<string, KeyPrivileges>();
  const add = (key: string, privileges: KeyPrivileges): void => {
    const was = declared.get(key) ?? READ_ONLY;
    declared.set(key, { signer: was.signer || privileges.signer, writable: was.writable || privileges.writable });
  };
  add(keys[0]!, { signer: true, writable: true });
  for (const instruction of compiled) {
    const program = keys[instruction.programIdIndex]!;
    if (program === LIGHTHOUSE_PROGRAM) continue;
    add(program, READ_ONLY);
    const metas: readonly KeyPrivileges[] =
      program === SIP_PROGRAM_ID
        ? (matchInstruction(instruction.data)?.accounts ?? []).map((account) => ({ signer: account.signer === true, writable: account.writable === true }))
        : program === ATA_PROGRAM
          ? CREATE_IDEMPOTENT_PRIVILEGES
          : [];
    instruction.accountKeyIndexes.forEach((index, position) => add(keys[index]!, metas[position] ?? READ_ONLY));
  }
  return declared;
}

interface TokenAccountCreate {
  readonly position: number;
  readonly data: Uint8Array;
  /** The instruction's accounts, base58, in its order. */
  readonly accounts: readonly string[];
}

/** Rule 13b: why these token-account instructions are not the owner's own vault accounts for this policy, or null. */
function vaultAccountProblem(creates: readonly TokenAccountCreate[], sipPosition: number, args: Readonly<Record<string, unknown>>, owner: string, feePayer: string): string | null {
  if (creates.length > MAX_VAULT_TOKEN_ACCOUNT_CREATES) {
    return `${creates.length} token-account instructions; at most ${MAX_VAULT_TOKEN_ACCOUNT_CREATES} (wSOL, the in-mint and a leg) are relayed beside set_invest_policy`;
  }
  const vault = deriveVaultPda(owner).toBase58();
  const legs = Array.isArray(args["legs"]) ? (args["legs"] as readonly { readonly mint?: unknown }[]) : [];
  const allowed = new Set<unknown>([WSOL_MINT, args["in_mint"], ...legs.map((leg) => leg.mint)]);
  const seen = new Set<string>();
  for (const create of creates) {
    const at = `the token-account instruction at position ${create.position + 1}`;
    if (create.position > sipPosition) return `${at} comes after set_invest_policy`;
    if (create.data.length !== 1 || create.data[0] !== 1) return `${at} is not CreateIdempotent (data [1])`;
    if (create.accounts.length !== 6) return `${at} lists ${create.accounts.length} accounts; CreateIdempotent takes 6`;
    const [funder, account, wallet, mint, system, tokenProgram] = create.accounts as readonly [string, string, string, string, string, string];
    if (funder !== feePayer || funder !== owner) return `${at} is not paid by the owner who signs set_invest_policy`;
    if (wallet !== vault) return `${at} creates an account for ${wallet}, not for ['vault', owner]`;
    if (!allowed.has(mint)) return `${at} names mint ${mint}, which is neither wSOL, the policy's in-mint nor one of its legs`;
    if (system !== SYSTEM_PROGRAM) return `${at}'s system program is not the System program`;
    if (tokenProgram !== TOKEN_PROGRAM && tokenProgram !== TOKEN_2022_PROGRAM) return `${at}'s token program is neither SPL Token nor Token-2022`;
    if (account !== deriveAta(wallet, mint, tokenProgram).toBase58()) return `${at}'s account is not the vault's associated token account for ${mint}`;
    if (seen.has(mint)) return `${at} creates the vault's ${mint} account a second time`;
    seen.add(mint);
  }
  return null;
}

/**
 * Verifies a fully signed transaction for /api/solana-tx. Pure: no network.
 * `context.programId`, when given, must be the IDL's (a mismatch is a bug in
 * the caller's settings, so it throws rather than refusing).
 */
export function verifySignedTransaction(bytes: Uint8Array, context: { readonly programId?: string } = {}): VerifyResult {
  if (context.programId !== undefined && context.programId !== SIP_PROGRAM_ID) {
    throw new Error("verifySignedTransaction: the configured program id is not the sip_vault IDL's address");
  }
  if (!(bytes instanceof Uint8Array)) return refuse("undecodable", "expected bytes");
  if (bytes.length > MAX_TX_BYTES) return refuse("too_large", `${bytes.length} bytes, the limit is ${MAX_TX_BYTES}`);
  if (bytes.length === 0) return refuse("undecodable", "empty");

  let tx: VersionedTransaction;
  let wire: Uint8Array;
  try {
    tx = VersionedTransaction.deserialize(bytes);
    wire = Uint8Array.from(tx.serialize());
  } catch {
    return refuse("undecodable", "not a legacy or v0 transaction");
  }
  if (!bytesEqual(wire, bytes)) return refuse("non_canonical", "the bytes do not re-serialise identically");
  const version = tx.version;
  if (version !== "legacy" && version !== 0) return refuse("undecodable", `transaction version ${String(version)} is not accepted`);

  const message = tx.message;
  if (message.addressTableLookups.length > 0) return refuse("lookup_tables", "address lookup tables hide the accounts being checked");

  const keys = message.staticAccountKeys.map((key) => key.toBase58());
  const required = message.header.numRequiredSignatures;
  if (required < 1 || required > MAX_SIGNERS || tx.signatures.length !== required || required > keys.length) {
    return refuse("signature_count", `requires ${required} signatures and carries ${tx.signatures.length}; 1 to ${MAX_SIGNERS} are accepted`);
  }

  const messageBytes = message.serialize();
  for (let i = 0; i < required; i++) {
    const signature = tx.signatures[i]!;
    if (signature.length !== 64 || signature.every((byte) => byte === 0)) {
      return refuse("missing_signature", `signer ${i + 1} of ${required} has not signed`);
    }
    if (!ed25519SignatureValid(messageBytes, signature, message.staticAccountKeys[i]!.toBytes())) {
      return refuse("bad_signature", `signer ${i + 1} of ${required}: the signature does not verify over this message`);
    }
  }

  if (keys.includes(OLD_NUVEM_PROGRAM_ID)) return refuse("old_program", "the transaction names a program SaverFi does not use");

  const compiled = message.compiledInstructions;
  // 8 and 8b: only token-account instructions count past MAX_INSTRUCTIONS; whether they may stand at all waits for the SIP instruction.
  // The wallet's Lighthouse checks are not counted here: rule 8c bounds them.
  const tokenAccountInstructions = compiled.filter((instruction) => keys[instruction.programIdIndex] === ATA_PROGRAM).length;
  const own = compiled.length - compiled.filter((instruction) => keys[instruction.programIdIndex] === LIGHTHOUSE_PROGRAM).length;
  if (own < 1 || own > MAX_INSTRUCTIONS_WITH_VAULT_ACCOUNTS || own - tokenAccountInstructions > MAX_INSTRUCTIONS) {
    return refuse(
      "instruction_count",
      `${own} instructions besides the wallet's Lighthouse checks; 1 to ${MAX_INSTRUCTIONS} are accepted, or up to ${MAX_INSTRUCTIONS_WITH_VAULT_ACCOUNTS} when those past ${MAX_INSTRUCTIONS} create the vault's token accounts`,
    );
  }

  const instructions: { program: string; name: string | null }[] = [];
  let sip: { name: OwnerInstructionName; position: number; indexes: readonly number[]; args: Record<string, unknown> } | null = null;
  const ed25519: { position: number; data: Uint8Array; accountCount: number }[] = [];
  const tokenAccountCreates: TokenAccountCreate[] = [];
  let unitLimit: number | null = null;
  let microLamports: bigint | null = null;

  for (const [position, instruction] of compiled.entries()) {
    if (instruction.programIdIndex >= keys.length || instruction.accountKeyIndexes.some((index) => index >= keys.length)) {
      return refuse("undecodable", "an instruction references an account the message does not carry");
    }
    const program = keys[instruction.programIdIndex]!;
    const data = instruction.data;

    if (program === SIP_PROGRAM_ID) {
      if (sip !== null) return refuse("instruction_count", "more than one SaverFi instruction");
      const matched = matchInstruction(data);
      if (matched === null) return refuse("unknown_discriminator", "the SaverFi instruction's discriminator is not in the IDL");
      if (isForbiddenInstruction(matched.name) || !isOwnerInstruction(matched.name)) {
        return refuse("instruction_not_allowed", `${matched.name} is not an owner instruction`);
      }
      if (instruction.accountKeyIndexes.length !== matched.accounts.length) {
        return refuse("account_binding", `${matched.name} takes ${matched.accounts.length} accounts, the instruction lists ${instruction.accountKeyIndexes.length}`);
      }
      let args: Record<string, unknown>;
      try {
        args = decodeArgs(matched.name, data);
      } catch (error) {
        return refuse("instruction_not_allowed", `${matched.name}: the arguments do not decode (${error instanceof Error ? error.message : "error"})`);
      }
      sip = { name: matched.name, position, indexes: instruction.accountKeyIndexes, args };
      instructions.push({ program, name: matched.name });
      continue;
    }

    if (program === COMPUTE_BUDGET_PROGRAM) {
      if (instruction.accountKeyIndexes.length !== 0) return refuse("compute_budget_invalid", "a ComputeBudget instruction takes no accounts");
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      if (data.length === 5 && data[0] === 2) {
        if (unitLimit !== null) return refuse("compute_budget_invalid", "SetComputeUnitLimit appears twice");
        unitLimit = view.getUint32(1, true);
        if (unitLimit > MAX_COMPUTE_UNIT_LIMIT) return refuse("compute_budget_invalid", `a unit limit of ${unitLimit} exceeds ${MAX_COMPUTE_UNIT_LIMIT}`);
        instructions.push({ program, name: "SetComputeUnitLimit" });
        continue;
      }
      if (data.length === 9 && data[0] === 3) {
        if (microLamports !== null) return refuse("compute_budget_invalid", "SetComputeUnitPrice appears twice");
        microLamports = view.getBigUint64(1, true);
        if (microLamports > MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS) {
          return refuse("compute_budget_invalid", `a unit price of ${microLamports} micro-lamports exceeds ${MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS}`);
        }
        instructions.push({ program, name: "SetComputeUnitPrice" });
        continue;
      }
      return refuse("compute_budget_invalid", "only SetComputeUnitLimit and SetComputeUnitPrice are accepted");
    }

    if (program === ED25519_PROGRAM) {
      // Where it stands and what it holds are rules 11 and 12, once the SIP
      // instruction's position is known.
      ed25519.push({ position, data, accountCount: instruction.accountKeyIndexes.length });
      instructions.push({ program, name: "Ed25519SigVerify" });
      continue;
    }

    if (program === ATA_PROGRAM) {
      // Rules 8b and 13b, once the SIP instruction and its arguments are known.
      tokenAccountCreates.push({ position, data, accounts: instruction.accountKeyIndexes.map((index) => keys[index]!) });
      instructions.push({ program, name: data.length === 1 && data[0] === 1 ? "CreateIdempotent" : null });
      continue;
    }

    if (program === LIGHTHOUSE_PROGRAM) {
      // Rule 8c, once every instruction is read.
      const read = readLighthouseGuard(data);
      instructions.push({ program, name: read.ok ? read.kind : null });
      continue;
    }

    return refuse("program_not_allowed", `instructions for ${program} are not relayed`);
  }

  if (sip === null) return refuse("instruction_count", "no SaverFi instruction");

  // 8c: the wallet's checks, before the rules that read positions.
  const guards = checkWalletGuards(
    {
      keys,
      privileges: keys.map((_, index) => ({ signer: message.isAccountSigner(index), writable: message.isAccountWritable(index) })),
      instructions: compiled.map((instruction) => ({ programId: keys[instruction.programIdIndex]!, accountKeys: instruction.accountKeyIndexes.map((index) => keys[index]!), data: instruction.data })),
    },
    declaredPrivileges(keys, compiled),
  );
  if (!guards.ok) return refuse(guards.reason, guards.detail);

  // 8b: the vault's token accounts are created beside set_invest_policy, and nowhere else.
  if (tokenAccountCreates.length > 0 && sip.name !== "set_invest_policy") {
    return refuse("program_not_allowed", `instructions for ${ATA_PROGRAM} are relayed only beside set_invest_policy, and this transaction's SaverFi instruction is ${sip.name}`);
  }

  // 11: the one place an Ed25519SigVerify may stand.
  const consentAt = sip.name === "link_wallet" ? sip.position - 1 : null;
  for (const entry of ed25519) {
    if (entry.position !== consentAt) {
      return refuse(
        "ed25519_misplaced",
        consentAt === null
          ? `an Ed25519SigVerify instruction is relayed only as the wallet's consent immediately before link_wallet, and this transaction's SaverFi instruction is ${sip.name}`
          : `the Ed25519SigVerify instruction at position ${entry.position + 1} is not the one immediately before link_wallet`,
      );
    }
  }
  let consent: Ed25519Verify | null = null;
  if (consentAt !== null) {
    const entry = ed25519.find((candidate) => candidate.position === consentAt);
    if (entry === undefined) {
      return refuse("link_consent_missing", "link_wallet needs the wallet's consent: an Ed25519SigVerify of its SIP_LINK_V1 signature immediately before it");
    }
    // 12: the shape ed25519_introspection.rs accepts.
    if (entry.accountCount !== 0) return refuse("ed25519_malformed", "the Ed25519SigVerify instruction takes no accounts");
    const read = readEd25519Verify(entry.data, entry.position);
    if (!read.ok) return refuse(`ed25519_${read.reason}`, read.detail);
    consent = read;
  }

  // 13: the accounts, by IDL name.
  const idlAccounts = matchInstruction(compiled[sip.position]!.data)!.accounts;
  const accounts: Record<string, string> = {};
  for (const [position, account] of idlAccounts.entries()) {
    const address = keys[sip.indexes[position]!]!;
    if (account.address !== undefined && address !== account.address) {
      return refuse("account_binding", `${sip.name}.${account.name} must be ${account.address}, the IDL's fixed address`);
    }
    accounts[account.name] = address;
  }

  const signers = keys.slice(0, required);
  const binding = bindAccounts(sip.name, accounts, signers);
  if (binding !== null) return binding;

  // 13b: every token account created is the signer's own vault's, for a mint this policy names.
  if (tokenAccountCreates.length > 0) {
    const problem = vaultAccountProblem(tokenAccountCreates, sip.position, sip.args, accounts["owner"]!, signers[0]!);
    if (problem !== null) return refuse("vault_account_invalid", problem);
  }

  // 14: what link_wallet will compare, and what the runtime will verify.
  if (consent !== null) {
    if (base58Encode(consent.publicKey) !== accounts["wallet"]) {
      return refuse("link_consent_wrong_signer", "the consent verifies a key that is not link_wallet's wallet");
    }
    const expected = linkConsentMessage({ programId: SIP_PROGRAM_ID, wallet: accounts["wallet"]!, vault: accounts["vault"]!, owner: accounts["owner"]! });
    if (!bytesEqual(consent.message, expected)) {
      return refuse("link_consent_mismatch", "the verified bytes are not the SIP_LINK_V1 consent naming this program, wallet, vault and owner");
    }
    if (!ed25519SignatureValid(consent.message, consent.signature, consent.publicKey)) {
      return refuse("link_consent_bad_signature", "the consent signature does not verify over SIP_LINK_V1: the runtime would refuse the transaction");
    }
  }

  return {
    ok: true,
    tx,
    wire,
    wireBase64: base64Encode(wire),
    version,
    signature: base58Encode(tx.signatures[0]!),
    feePayer: signers[0]!,
    signers,
    instruction: { name: sip.name, accounts, args: sip.args },
    computeBudget: { unitLimit, microLamports },
    instructions,
  };
}
