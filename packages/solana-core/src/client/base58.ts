// base58 (the Bitcoin/Solana alphabet) with no web3 SDK, so the browser
// entry can validate and render addresses without pulling the SDK in.
//
// Ported from Nuvem packages/solana-core/src/solana.ts (tryBase58Decode,
// base58Encode). One change: Nuvem refused any text over 64 characters, which
// is right for a 32-byte key (at most 44) and wrong for a 64-byte signature (up
// to 88). The length bound stays, raised to what a signature needs; callers
// that want a key say so with isPubkey.

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ALPHABET_MAP = new Map([...ALPHABET].map((c, i) => [c, BigInt(i)]));

/** Longest base58 text any Solana value this package handles can have (a 64-byte signature). */
export const MAX_BASE58_LENGTH = 88;

export function tryBase58Decode(text: string): Uint8Array | null {
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_BASE58_LENGTH) return null;
  let n = 0n;
  for (const char of text) {
    const digit = ALPHABET_MAP.get(char);
    if (digit === undefined) return null;
    n = n * 58n + digit;
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  // Leading '1's encode leading zero bytes.
  for (const char of text) {
    if (char !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const byte of bytes) n = (n << 8n) | BigInt(byte);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out;
}

/** Base58 text that decodes to exactly `length` bytes. */
export function isBase58OfLength(text: unknown, length: number): text is string {
  if (typeof text !== "string") return false;
  const decoded = tryBase58Decode(text);
  return decoded !== null && decoded.length === length;
}

/** A base58 32-byte public key (on or off curve: PDAs are keys too). */
export const isPubkey = (text: unknown): text is string => isBase58OfLength(text, 32);

/** A base58 64-byte transaction signature. */
export const isSignature = (text: unknown): text is string => isBase58OfLength(text, 64);

/** The all-zero key, which Anchor treats as "unset" (and which is also the System program's address). */
export const DEFAULT_PUBKEY = "11111111111111111111111111111111";
