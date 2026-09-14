// The Ed25519SigVerify precompile's instruction data, both ways, and ed25519
// verification with node:crypto.
//
// ONE LAYOUT, THE RUNTIME'S, which @solana/web3.js's
// Ed25519Program.createInstructionWithPublicKey also writes (test/builders.test.ts
// compares the bytes): count u8 = 1, padding u8, then one offsets struct —
// signature offset, signature instruction index, public key offset, public key
// instruction index, message offset, message size, message instruction index,
// u16 LE each — then the public key at 16, the signature at 48, the message at 112.
// An instruction index of u16::MAX means "this instruction".
//
// THE READER IS THE PROGRAM'S. ed25519_introspection.rs treats the offset table
// as hostile input: the precompile verifies whatever the offsets point at,
// including bytes in another instruction, so every reference must be to the
// Ed25519 instruction itself and every region must lie inside its own data. The
// verifier refuses the same shapes, before a simulation is spent on them.

import { createPublicKey, verify } from "node:crypto";

/** count u8 · padding u8 · one 14-byte offsets struct */
export const ED25519_HEADER_BYTES = 16;
export const ED25519_PUBLIC_KEY_BYTES = 32;
export const ED25519_SIGNATURE_BYTES = 64;
/** The runtime's "the current instruction" sentinel in an offsets struct. */
export const ED25519_THIS_INSTRUCTION = 0xffff;

export interface Ed25519Verify {
  readonly publicKey: Uint8Array;
  readonly signature: Uint8Array;
  readonly message: Uint8Array;
}

/** Instruction data for one Ed25519 signature check over `message`, in web3.js's layout. */
export function encodeEd25519Verify(input: Ed25519Verify): Uint8Array {
  const { publicKey, signature, message } = input;
  if (publicKey.length !== ED25519_PUBLIC_KEY_BYTES) throw new RangeError(`an ed25519 public key is ${ED25519_PUBLIC_KEY_BYTES} bytes, got ${publicKey.length}`);
  if (signature.length !== ED25519_SIGNATURE_BYTES) throw new RangeError(`an ed25519 signature is ${ED25519_SIGNATURE_BYTES} bytes, got ${signature.length}`);
  const publicKeyAt = ED25519_HEADER_BYTES;
  const signatureAt = publicKeyAt + ED25519_PUBLIC_KEY_BYTES;
  const messageAt = signatureAt + ED25519_SIGNATURE_BYTES;
  if (messageAt + message.length > 0xffff) throw new RangeError("the message is too long for a u16 offset table");
  const data = new Uint8Array(messageAt + message.length);
  const view = new DataView(data.buffer);
  data[0] = 1;
  data[1] = 0;
  view.setUint16(2, signatureAt, true);
  view.setUint16(4, ED25519_THIS_INSTRUCTION, true);
  view.setUint16(6, publicKeyAt, true);
  view.setUint16(8, ED25519_THIS_INSTRUCTION, true);
  view.setUint16(10, messageAt, true);
  view.setUint16(12, message.length, true);
  view.setUint16(14, ED25519_THIS_INSTRUCTION, true);
  data.set(publicKey, publicKeyAt);
  data.set(signature, signatureAt);
  data.set(message, messageAt);
  return data;
}

export type Ed25519VerifyRead =
  | ({ readonly ok: true } & Ed25519Verify)
  /** signature_count: not exactly one signature. malformed: shorter than its header. offsets: a reference outside its own data. */
  | { readonly ok: false; readonly reason: "signature_count" | "malformed" | "offsets"; readonly detail: string };

/**
 * Reads an Ed25519SigVerify instruction's data as ed25519_introspection.rs does:
 * exactly one signature, every instruction index u16::MAX or `ownIndex` (its
 * position among the transaction's instructions), every region inside `data`.
 */
export function readEd25519Verify(data: Uint8Array, ownIndex: number): Ed25519VerifyRead {
  if (data.length < 1) return { ok: false, reason: "malformed", detail: "the Ed25519SigVerify instruction carries no data" };
  if (data[0] !== 1) return { ok: false, reason: "signature_count", detail: `the Ed25519SigVerify instruction checks ${data[0]} signatures; exactly 1 is accepted` };
  if (data.length < ED25519_HEADER_BYTES) {
    return { ok: false, reason: "malformed", detail: `the Ed25519SigVerify instruction is ${data.length} bytes, shorter than its ${ED25519_HEADER_BYTES}-byte header` };
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u16 = (at: number): number => view.getUint16(at, true);
  const signatureAt = u16(2);
  const publicKeyAt = u16(6);
  const messageAt = u16(10);
  const messageSize = u16(12);
  for (const [what, index] of [
    ["signature", u16(4)],
    ["public key", u16(8)],
    ["message", u16(14)],
  ] as const) {
    if (index !== ED25519_THIS_INSTRUCTION && index !== ownIndex) {
      return { ok: false, reason: "offsets", detail: `the Ed25519SigVerify instruction's ${what} is read from instruction ${index}, not from itself` };
    }
  }
  if (publicKeyAt + ED25519_PUBLIC_KEY_BYTES > data.length || signatureAt + ED25519_SIGNATURE_BYTES > data.length || messageAt + messageSize > data.length) {
    return { ok: false, reason: "offsets", detail: "an offset in the Ed25519SigVerify instruction points past its own data" };
  }
  return {
    ok: true,
    publicKey: data.slice(publicKeyAt, publicKeyAt + ED25519_PUBLIC_KEY_BYTES),
    signature: data.slice(signatureAt, signatureAt + ED25519_SIGNATURE_BYTES),
    message: data.slice(messageAt, messageAt + messageSize),
  };
}

/** Whether `signature` is `publicKey`'s ed25519 signature over `message`. Never throws. */
export function ed25519SignatureValid(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean {
  if (signature.length !== ED25519_SIGNATURE_BYTES || publicKey.length !== ED25519_PUBLIC_KEY_BYTES) return false;
  try {
    const key = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(publicKey).toString("base64url") },
      format: "jwk",
    });
    return verify(null, message, key, signature);
  } catch {
    return false;
  }
}
