// TypeScript mirror of programs/sip-vault/src/attestation.rs.
//
// SAME BYTES OR NOTHING. The program reconstructs this message from chain
// state and compares it against what the Ed25519 instruction verified; a
// drifted mirror produces signatures that never verify. Both mirrors are pinned
// to one golden vector computed independently of either: the unit test in
// attestation.rs and tests/attestation-v2.ts (V2), tests/attestation-v3.ts (V3).
//
// NO IMPORT BUT web3.js, ON PURPOSE. The keeper's image copies this file by
// name, and its Dockerfile test walks the closure of what it copies: an import
// of a sibling here is a file the image does not have. The per-trade
// arithmetic that feeds V3 lives in per-trade.ts for that reason.

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

// ── V3: settle_v3, the per-trade modes ──────────────────────────────────────

export const ATTESTATION_V3_DOMAIN = Buffer.from("SIP_SETTLE_V3\0\0\0", "latin1");

export const MODE_ROUNDUP = 2;
export const MODE_FIXED = 3;

/**
 * domain 16 · program, wallet, vault 32×3 · epoch, nonce, start, end, amount 8×5 · mode 1
 * · policy nonce 8 · deadline 8 · trade count 4 · price min 8 · mode param 8 · min trade 8 · prices hash 32
 */
export const ATTESTATION_V3_MESSAGE_LEN = 16 + 32 * 3 + 8 * 5 + 1 + 8 + 8 + 4 + 8 + 8 + 8 + 32;

export interface AttestationV3Inputs {
  readonly programId: PublicKey;
  readonly wallet: PublicKey;
  readonly vault: PublicKey;
  readonly linkEpoch: bigint;
  readonly settlementNonce: bigint;
  readonly sessionStartSlot: bigint;
  readonly sessionEndSlot: bigint;
  /** What the window owes before any cap: Σ per-trade round-ups, or trade count × F. */
  readonly amountLamports: bigint;
  /** MODE_ROUNDUP or MODE_FIXED, as the vault holds it. */
  readonly mode: number;
  readonly policyNonce: bigint;
  readonly validUntilSlot: bigint;
  readonly tradeCount: number;
  /** ROUND-UP: the lowest SOL/USD price used in the window, micro-dollars per SOL. FIXED: 0n. */
  readonly priceMinUsdE6: bigint;
  /** ROUND-UP: the PerTradePolicy's roundup_unit_cents. FIXED: its fixed_lamports. */
  readonly modeParam: bigint;
  /** ROUND-UP: min_trade_cents. FIXED: min_trade_lamports. */
  readonly minTrade: bigint;
  /** ROUND-UP: per-trade.ts's pricesHash of the counted trades. FIXED: 32 zero bytes. */
  readonly pricesHash: Uint8Array;
}

const u32le = (value: number): Buffer => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
};

export function attestationV3Message(inputs: AttestationV3Inputs): Buffer {
  if (inputs.pricesHash.length !== 32) throw new Error(`prices hash is 32 bytes, not ${inputs.pricesHash.length}`);
  const message = Buffer.concat([
    ATTESTATION_V3_DOMAIN,
    inputs.programId.toBuffer(),
    inputs.wallet.toBuffer(),
    inputs.vault.toBuffer(),
    u64le(inputs.linkEpoch),
    u64le(inputs.settlementNonce),
    u64le(inputs.sessionStartSlot),
    u64le(inputs.sessionEndSlot),
    u64le(inputs.amountLamports),
    u8(inputs.mode),
    u64le(inputs.policyNonce),
    u64le(inputs.validUntilSlot),
    u32le(inputs.tradeCount),
    u64le(inputs.priceMinUsdE6),
    u64le(inputs.modeParam),
    u64le(inputs.minTrade),
    Buffer.from(inputs.pricesHash),
  ]);
  if (message.length !== ATTESTATION_V3_MESSAGE_LEN) throw new Error("V3 attestation message drifted");
  return message;
}

/** The Ed25519SigVerify instruction settle_v3() expects immediately before it. */
export function attestationV3Instruction(
  attesterSecretKey: Uint8Array,
  inputs: AttestationV3Inputs,
): TransactionInstruction {
  return Ed25519Program.createInstructionWithPrivateKey({
    privateKey: attesterSecretKey,
    message: attestationV3Message(inputs),
  });
}
