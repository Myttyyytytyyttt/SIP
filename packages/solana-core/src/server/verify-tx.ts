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
//   8  1..4 instructions, each for SIP or ComputeBudget         instruction_count / program_not_allowed
//   9  exactly one SIP instruction, an owner instruction, whose
//      arguments decode exactly                                 instruction_count / unknown_discriminator /
//                                                               instruction_not_allowed
//  10  ComputeBudget only SetComputeUnitLimit ≤ 1.4M and
//      SetComputeUnitPrice ≤ 5M µlamports, once each            compute_budget_invalid
//  11  the signers are the instruction's own accounts:
//      owner = fee payer (key 0); link_wallet also wallet = key 1
//      and wallet ≠ owner; unlink_wallet's authority may be the
//      owner or the wallet                                      account_binding / wallet_is_owner /
//                                                               signature_count

import { createPublicKey, verify as ed25519 } from "node:crypto";
import { VersionedTransaction } from "@solana/web3.js";

import { COMPUTE_BUDGET_PROGRAM } from "../client/addresses";
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
] as const;
export type VerifyRefusal = (typeof VERIFY_REFUSALS)[number];

export const MAX_SIGNERS = 2;
export const MAX_INSTRUCTIONS = 4;
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

function signatureValid(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean {
  try {
    const key = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(publicKey).toString("base64url") },
      format: "jwk",
    });
    return ed25519(null, message, key, signature);
  } catch {
    return false;
  }
}

/** Signing rules for the owner instructions, by the IDL account names they bind. */
function bindSigners(
  name: OwnerInstructionName,
  accounts: Readonly<Record<string, string>>,
  signers: readonly string[],
): VerifyResult | null {
  const feePayer = signers[0]!;
  switch (name) {
    case "link_wallet": {
      const owner = accounts["owner"]!;
      const wallet = accounts["wallet"]!;
      // SIP's rule, not the program's: link_wallet.rs has no wallet != owner
      // require, and a pension key linked as its own trading wallet would be
      // pulled from by settle.
      if (owner === wallet) return refuse("wallet_is_owner", "link_wallet names the same key as owner and wallet");
      if (signers.length !== 2) return refuse("signature_count", `link_wallet needs exactly 2 signers (owner, wallet), the message requires ${signers.length}`);
      if (feePayer !== owner) return refuse("account_binding", "link_wallet's owner must be the fee payer (signer 1)");
      if (signers[1] !== wallet) return refuse("account_binding", "link_wallet's wallet must be signer 2");
      return null;
    }
    case "unlink_wallet": {
      const authority = accounts["authority"]!;
      const owner = accounts["owner"]!;
      // The program lets the owner cut a wallet loose OR the wallet remove
      // itself; either may be the authority, and the fee payer is one of them.
      if (!signers.includes(authority)) return refuse("account_binding", "unlink_wallet's authority must be a required signer");
      if (feePayer !== authority && feePayer !== owner) return refuse("account_binding", "unlink_wallet's fee payer must be the owner or the authority");
      const stranger = signers.find((signer) => signer !== authority && signer !== owner);
      if (stranger !== undefined) return refuse("account_binding", "unlink_wallet carries a signer that is neither the owner nor the authority");
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
    if (!signatureValid(messageBytes, signature, message.staticAccountKeys[i]!.toBytes())) {
      return refuse("bad_signature", `signer ${i + 1} of ${required}: the signature does not verify over this message`);
    }
  }

  if (keys.includes(OLD_NUVEM_PROGRAM_ID)) return refuse("old_program", "the transaction names Nuvem's old program");

  const compiled = message.compiledInstructions;
  if (compiled.length < 1 || compiled.length > MAX_INSTRUCTIONS) {
    return refuse("instruction_count", `${compiled.length} instructions; 1 to ${MAX_INSTRUCTIONS} are accepted`);
  }

  const instructions: { program: string; name: string | null }[] = [];
  let sip: { name: OwnerInstructionName; indexes: readonly number[]; args: Record<string, unknown> } | null = null;
  let unitLimit: number | null = null;
  let microLamports: bigint | null = null;

  for (const instruction of compiled) {
    if (instruction.programIdIndex >= keys.length || instruction.accountKeyIndexes.some((index) => index >= keys.length)) {
      return refuse("undecodable", "an instruction references an account the message does not carry");
    }
    const program = keys[instruction.programIdIndex]!;
    const data = instruction.data;

    if (program === SIP_PROGRAM_ID) {
      if (sip !== null) return refuse("instruction_count", "more than one SIP instruction");
      const matched = matchInstruction(data);
      if (matched === null) return refuse("unknown_discriminator", "the SIP instruction's discriminator is not in the IDL");
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
      sip = { name: matched.name, indexes: instruction.accountKeyIndexes, args };
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

    return refuse("program_not_allowed", `instructions for ${program} are not relayed`);
  }

  if (sip === null) return refuse("instruction_count", "no SIP instruction");

  const idlAccounts = matchInstruction(compiled.find((entry) => keys[entry.programIdIndex] === SIP_PROGRAM_ID)!.data)!.accounts;
  const accounts: Record<string, string> = {};
  idlAccounts.forEach((account, position) => {
    accounts[account.name] = keys[sip!.indexes[position]!]!;
  });

  const signers = keys.slice(0, required);
  const binding = bindSigners(sip.name, accounts, signers);
  if (binding !== null) return binding;

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
