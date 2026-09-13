// TypeScript mirror of programs/sip-vault/src/attestation.rs.
//
// SAME BYTES OR NOTHING. The program reconstructs this message from chain
// state and compares it against what the Ed25519 instruction verified; a
// drifted mirror produces signatures that never verify, which the e2e tests
// catch immediately — that is the pinning, there is no separate parity check.

import { Ed25519Program, PublicKey, TransactionInstruction } from "@solana/web3.js";

export const ATTESTATION_DOMAIN = Buffer.from("NUVEM_SETTLE_V1\0", "latin1");

export interface AttestationInputs {
  readonly programId: PublicKey;
  readonly wallet: PublicKey;
  readonly vault: PublicKey;
  readonly linkEpoch: bigint;
  readonly settlementNonce: bigint;
  readonly sessionStartSlot: bigint;
  readonly sessionEndSlot: bigint;
  readonly profitLamports: bigint;
}

const u64le = (value: bigint): Buffer => {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(value);
  return buffer;
};

export function attestationMessage(inputs: AttestationInputs): Buffer {
  const message = Buffer.concat([
    ATTESTATION_DOMAIN,
    inputs.programId.toBuffer(),
    inputs.wallet.toBuffer(),
    inputs.vault.toBuffer(),
    u64le(inputs.linkEpoch),
    u64le(inputs.settlementNonce),
    u64le(inputs.sessionStartSlot),
    u64le(inputs.sessionEndSlot),
    u64le(inputs.profitLamports),
  ]);
  if (message.length !== 16 + 32 * 3 + 8 * 5) throw new Error("attestation message drifted");
  return message;
}

/** The Ed25519SigVerify instruction settle() expects immediately before it. */
export function attestationInstruction(
  attesterSecretKey: Uint8Array,
  inputs: AttestationInputs,
): TransactionInstruction {
  return Ed25519Program.createInstructionWithPrivateKey({
    privateKey: attesterSecretKey,
    message: attestationMessage(inputs),
  });
}
