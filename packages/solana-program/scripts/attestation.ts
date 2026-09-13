// TypeScript mirror of programs/sip-vault/src/attestation.rs.
//
// SAME BYTES OR NOTHING. The program reconstructs this message from chain
// state and compares it against what the Ed25519 instruction verified; a
// drifted mirror produces signatures that never verify. Both mirrors are pinned
// to one golden vector computed independently of either: the unit test in
// attestation.rs and tests/attestation-v2.ts.

import { Ed25519Program, PublicKey, TransactionInstruction } from "@solana/web3.js";

export const ATTESTATION_DOMAIN = Buffer.from("SIP_SETTLE_V2\0\0\0", "latin1");

export const MODE_PROFIT = 0;
export const MODE_VOLUME = 1;

/** domain 16 · program, wallet, vault 32×3 · epoch, nonce, start, end, base 8×5 · mode 1 · bps 2 · policy nonce 8 · deadline 8 */
export const ATTESTATION_MESSAGE_LEN = 16 + 32 * 3 + 8 * 5 + 1 + 2 + 8 + 8;

export interface AttestationInputs {
  readonly programId: PublicKey;
  readonly wallet: PublicKey;
  readonly vault: PublicKey;
  readonly linkEpoch: bigint;
  readonly settlementNonce: bigint;
  readonly sessionStartSlot: bigint;
  readonly sessionEndSlot: bigint;
  /** Profit in PROFIT mode, notional in VOLUME mode; `mode` says which. */
  readonly baseLamports: bigint;
  readonly mode: number;
  /** The rate of `mode`, as the vault holds it. */
  readonly bps: number;
  readonly policyNonce: bigint;
  readonly validUntilSlot: bigint;
}

const u8 = (value: number): Buffer => Buffer.from([value]);

const u16le = (value: number): Buffer => {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
};

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
    u64le(inputs.baseLamports),
    u8(inputs.mode),
    u16le(inputs.bps),
    u64le(inputs.policyNonce),
    u64le(inputs.validUntilSlot),
  ]);
  if (message.length !== ATTESTATION_MESSAGE_LEN) throw new Error("attestation message drifted");
  return message;
}

/** The Ed25519SigVerify instruction settle_v2() expects immediately before it. */
export function attestationInstruction(
  attesterSecretKey: Uint8Array,
  inputs: AttestationInputs,
): TransactionInstruction {
  return Ed25519Program.createInstructionWithPrivateKey({
    privateKey: attesterSecretKey,
    message: attestationMessage(inputs),
  });
}
