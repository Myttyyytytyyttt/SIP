// Solana's wire format, read and spliced without the web3 SDK. Browser-safe.
//
// WHY THE BROWSER PARSES AT ALL. The build route's answer is advice: before the
// pension key signs, the page reads the bytes it is about to hand Phantom and
// refuses anything that is not what the person asked for (the fee payer, the
// programs, the SIP instruction's arguments). After Phantom signs, it reads the
// bytes Phantom returned, because a wallet may rewrite an unsigned message; and
// for a link it splices the trading wallet's co-signature into Phantom's bytes.
// /api/solana-tx verifies everything again, with the SDK, before anything is sent.
//
// ONLY LEGACY MESSAGES. Every builder compiles legacy; a v0 message (its first
// byte has the 0x80 bit) is refused, as is a message with bytes left over or an
// index past its keys.

import { base58Encode } from "./base58";

export class WireFormatError extends Error {
  override readonly name = "WireFormatError";
}

export const SIGNATURE_BYTES = 64;

/** A compact-u16 ("shortvec") at `at`: its value and the offset after it. */
export function readShortVec(bytes: Uint8Array, at: number): { readonly value: number; readonly next: number } {
  let value = 0;
  for (let i = 0; i < 3; i++) {
    const byte = bytes[at + i];
    if (byte === undefined) throw new WireFormatError("a length runs past the end of the bytes");
    if (i === 2 && byte > 0x03) throw new WireFormatError("a length is larger than a compact-u16");
    value |= (byte & 0x7f) << (7 * i);
    if ((byte & 0x80) === 0) {
      if (i > 0 && byte === 0) throw new WireFormatError("a length is not in its shortest encoding");
      return { value, next: at + i + 1 };
    }
  }
  throw new WireFormatError("a length is longer than a compact-u16");
}

export interface WireParts {
  /** Each signature slot, 64 bytes, in order (zeroed when unsigned). */
  readonly signatures: readonly Uint8Array[];
  /** The message every signer signs. */
  readonly message: Uint8Array;
  /** Where the message starts in the wire bytes. */
  readonly messageOffset: number;
}

/** A serialized transaction's signature slots and message. */
export function splitWire(wire: Uint8Array): WireParts {
  if (!(wire instanceof Uint8Array) || wire.length === 0) throw new WireFormatError("no transaction bytes");
  const { value: count, next } = readShortVec(wire, 0);
  const messageOffset = next + count * SIGNATURE_BYTES;
  if (count === 0 || messageOffset >= wire.length) throw new WireFormatError("the signature slots run past the end of the transaction");
  const signatures: Uint8Array[] = [];
  for (let i = 0; i < count; i++) signatures.push(wire.slice(next + i * SIGNATURE_BYTES, next + (i + 1) * SIGNATURE_BYTES));
  return { signatures, message: wire.slice(messageOffset), messageOffset };
}

export interface MessageHeader {
  readonly numRequiredSignatures: number;
  readonly numReadonlySignedAccounts: number;
  readonly numReadonlyUnsignedAccounts: number;
}

export interface ParsedInstruction {
  readonly programIdIndex: number;
  /** base58 */
  readonly programId: string;
  readonly accountIndexes: readonly number[];
  /** base58, in the instruction's order. */
  readonly accountKeys: readonly string[];
  readonly data: Uint8Array;
}

export interface ParsedLegacyMessage {
  readonly header: MessageHeader;
  /** base58; the first numRequiredSignatures sign, the first key pays. */
  readonly keys: readonly string[];
  readonly recentBlockhash: string;
  readonly instructions: readonly ParsedInstruction[];
}

/** A legacy message, every index checked and every byte consumed. */
export function parseLegacyMessage(message: Uint8Array): ParsedLegacyMessage {
  if (!(message instanceof Uint8Array) || message.length < 3) throw new WireFormatError("the message is shorter than its header");
  if ((message[0]! & 0x80) !== 0) throw new WireFormatError("a versioned (v0) message: only legacy messages are built and read here");
  const header: MessageHeader = { numRequiredSignatures: message[0]!, numReadonlySignedAccounts: message[1]!, numReadonlyUnsignedAccounts: message[2]! };
  let at = 3;
  const keyCount = readShortVec(message, at);
  at = keyCount.next;
  if (at + keyCount.value * 32 + 32 > message.length) throw new WireFormatError("the account keys run past the end of the message");
  const keys: string[] = [];
  for (let i = 0; i < keyCount.value; i++, at += 32) keys.push(base58Encode(message.subarray(at, at + 32)));
  if (header.numRequiredSignatures === 0 || header.numRequiredSignatures > keys.length) throw new WireFormatError("the header's signer count does not fit the keys");
  if (header.numReadonlySignedAccounts >= header.numRequiredSignatures || header.numReadonlyUnsignedAccounts > keys.length - header.numRequiredSignatures) {
    throw new WireFormatError("the header's read-only counts do not fit the keys");
  }
  const recentBlockhash = base58Encode(message.subarray(at, at + 32));
  at += 32;
  const instructionCount = readShortVec(message, at);
  at = instructionCount.next;
  const instructions: ParsedInstruction[] = [];
  for (let i = 0; i < instructionCount.value; i++) {
    const programIdIndex = message[at];
    if (programIdIndex === undefined) throw new WireFormatError("an instruction runs past the end of the message");
    at += 1;
    const accountCount = readShortVec(message, at);
    at = accountCount.next;
    if (at + accountCount.value > message.length) throw new WireFormatError("an instruction's accounts run past the end of the message");
    const accountIndexes = [...message.subarray(at, at + accountCount.value)];
    at += accountCount.value;
    const dataLength = readShortVec(message, at);
    at = dataLength.next;
    if (at + dataLength.value > message.length) throw new WireFormatError("an instruction's data runs past the end of the message");
    const data = message.slice(at, at + dataLength.value);
    at += dataLength.value;
    if (programIdIndex >= keys.length || accountIndexes.some((index) => index >= keys.length)) {
      throw new WireFormatError("an instruction names an account the message does not carry");
    }
    instructions.push({ programIdIndex, programId: keys[programIdIndex]!, accountIndexes, accountKeys: accountIndexes.map((index) => keys[index]!), data });
  }
  if (at !== message.length) throw new WireFormatError(`${message.length - at} bytes follow the last instruction`);
  return { header, keys, recentBlockhash, instructions };
}

/** Whether key `index` must sign. */
export const isSignerIndex = (message: ParsedLegacyMessage, index: number): boolean => index < message.header.numRequiredSignatures;

/** Whether key `index` is writable, from the header's read-only counts. */
export function isWritableIndex(message: ParsedLegacyMessage, index: number): boolean {
  const { numRequiredSignatures, numReadonlySignedAccounts, numReadonlyUnsignedAccounts } = message.header;
  if (index < numRequiredSignatures) return index < numRequiredSignatures - numReadonlySignedAccounts;
  return index < message.keys.length - numReadonlyUnsignedAccounts;
}

export const isZeroSignature = (signature: Uint8Array): boolean => signature.every((byte) => byte === 0);

/** `wire` with signature slot `index` replaced by `signature`; a new array, the input untouched. */
export function spliceSignature(wire: Uint8Array, index: number, signature: Uint8Array): Uint8Array {
  if (!(signature instanceof Uint8Array) || signature.length !== SIGNATURE_BYTES) throw new WireFormatError(`a signature is ${SIGNATURE_BYTES} bytes`);
  const { value: count, next } = readShortVec(wire, 0);
  if (!Number.isInteger(index) || index < 0 || index >= count) throw new WireFormatError(`the transaction has no signature slot ${index}`);
  if (next + count * SIGNATURE_BYTES >= wire.length) throw new WireFormatError("the signature slots run past the end of the transaction");
  const out = wire.slice();
  out.set(signature, next + index * SIGNATURE_BYTES);
  return out;
}

// ── ComputeBudget ────────────────────────────────────────────────────────────

/** ComputeBudget SetComputeUnitLimit: [2, u32 LE]. */
export const SET_COMPUTE_UNIT_LIMIT = 2;
/** ComputeBudget SetComputeUnitPrice: [3, u64 LE micro-lamports]. */
export const SET_COMPUTE_UNIT_PRICE = 3;

export function encodeSetComputeUnitLimit(units: number): Uint8Array {
  if (!Number.isInteger(units) || units < 0 || units > 0xffff_ffff) throw new RangeError("a compute unit limit is a u32");
  const data = new Uint8Array(5);
  data[0] = SET_COMPUTE_UNIT_LIMIT;
  new DataView(data.buffer).setUint32(1, units, true);
  return data;
}

export function encodeSetComputeUnitPrice(microLamports: bigint): Uint8Array {
  if (typeof microLamports !== "bigint" || microLamports < 0n || microLamports > (1n << 64n) - 1n) throw new RangeError("a compute unit price is a u64 (a bigint)");
  const data = new Uint8Array(9);
  data[0] = SET_COMPUTE_UNIT_PRICE;
  new DataView(data.buffer).setBigUint64(1, microLamports, true);
  return data;
}

export type ComputeBudgetInstruction = { readonly kind: "unitLimit"; readonly units: number } | { readonly kind: "unitPrice"; readonly microLamports: bigint };

/** A ComputeBudget instruction's data as one of the two kinds owner transactions carry, or null. */
export function readComputeBudget(data: Uint8Array): ComputeBudgetInstruction | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length === 5 && data[0] === SET_COMPUTE_UNIT_LIMIT) return { kind: "unitLimit", units: view.getUint32(1, true) };
  if (data.length === 9 && data[0] === SET_COMPUTE_UNIT_PRICE) return { kind: "unitPrice", microLamports: view.getBigUint64(1, true) };
  return null;
}
