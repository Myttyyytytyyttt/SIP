/**
 * THE PASTED KEY, JUDGED BEFORE ANYTHING IS DONE WITH IT.
 *
 * Importing a wallet means handing its private key to Privy, which encrypts it
 * for its TEE. Before that, this module says what the pasted text IS, in words
 * the person can act on: a recovery phrase, an EVM key, an address or half a
 * key, a key file of the wrong size — each the likeliest mistake of someone
 * holding a wallet they already trade with.
 *
 * THE ADDRESS COMES FROM THE PRIVATE HALF. A Solana secret key is 64 bytes: the
 * private seed, then the public key. The second half is only a copy, and nothing
 * forces it to match the first, so it is never trusted: the public key is derived
 * from the seed (WebCrypto Ed25519, through @solana/kit) and must equal the copy.
 * Every check before the import — the pension key, a vault this key owns, a link
 * elsewhere — runs on that address, and a key whose halves disagree could
 * otherwise pass them under one address and land in Privy as another. A browser
 * that cannot derive it gets a refusal, never a guess.
 *
 * FORMATS (owner, 10-08): base58 of the 64 bytes, as Phantom, Solflare and most
 * trading tools export it, and a key file's JSON list of 64 numbers
 * (`solana-keygen`). Recovery phrases and 32-byte seeds are refused with the way
 * to the right thing; the installed Privy SDK imports neither.
 *
 * THE KEY NEVER LEAVES A LOCAL. Nothing here stores, logs or returns the key
 * except privateKeyForImport, whose caller passes it straight to Privy. The
 * byte arrays this module decodes are zeroed before each function returns;
 * copies made inside WebCrypto and @solana/kit are out of its reach. Strings
 * cannot be zeroed; the caller keeps the text in an uncontrolled input, never
 * in React state.
 *
 * Client-safe and pure apart from WebCrypto.
 */

import { base58Encode, tryBase58Decode } from "@sip/solana-core/client";
import { createKeyPairFromPrivateKeyBytes, getAddressFromPublicKey } from "@solana/kit";

/** A Solana secret key: the 32-byte private seed, then the 32-byte public key. */
export const SECRET_KEY_BYTES = 64;

export type KeyRefusal =
  /** Words separated by spaces. */
  | "recovery_phrase"
  /** 0x-prefixed or 64-character hex: an EVM key. */
  | "evm_key"
  /** 32 bytes: an address, or the seed alone. */
  | "half_key"
  /** A JSON list that is not 64 numbers from 0 to 255. */
  | "key_file"
  /** Nothing a Solana key is written as. */
  | "not_a_key"
  /** The public half is not the one the private half makes. */
  | "damaged"
  /** This browser cannot derive a public key, so nothing can be checked. */
  | "unchecked";

export type PastedKey =
  | { readonly kind: "empty" }
  | { readonly kind: "refused"; readonly reason: KeyRefusal; readonly message: string }
  /** A whole key; `address` is the wallet it opens, derived from the private half. */
  | { readonly kind: "key"; readonly address: string; readonly format: "base58" | "json" };

export const KEY_COPY = {
  recoveryPhrase:
    "That is a recovery phrase, not a private key. Export the wallet's private key from your wallet app and paste that instead.",
  evmKey: "That is written in hex, like an Ethereum-style key. SaverFi needs a Solana private key as your wallet app exports it: about 88 letters and numbers.",
  halfKey:
    "That is only 32 bytes: a wallet address, or half of a key. Paste the whole private key your wallet exports, about 88 characters long.",
  keyFile: (count: number): string =>
    `That list has ${count} ${count === 1 ? "number" : "numbers"}. A Solana key file holds ${SECRET_KEY_BYTES}, each from 0 to 255.`,
  keyFileByte: "That list has a value that is not a whole number from 0 to 255, so it is not a Solana key file.",
  notAKey:
    "That is not a Solana private key. Paste the key your wallet exports: about 88 letters and numbers, or a key file's list of 64 numbers.",
  damaged: "This key is damaged: its two halves do not belong to the same wallet. Copy it again from your wallet app.",
  unchecked:
    "This browser cannot check the key before it is sent, so nothing was sent. Use a current version of Chrome, Edge, Firefox or Safari.",
} as const;

type Parsed =
  | { readonly kind: "empty" }
  | { readonly kind: "refused"; readonly reason: KeyRefusal; readonly message: string }
  | { readonly kind: "bytes"; readonly bytes: Uint8Array; readonly format: "base58" | "json" };

const refused = (reason: KeyRefusal, message: string): Parsed & { kind: "refused" } => ({ kind: "refused", reason, message });

/** The text without surrounding space, and without one pair of quotes around it (a value copied out of a JSON file). */
function unwrap(text: string): string {
  const trimmed = text.trim();
  const quoted = /^(["'`])([\s\S]*)\1$/.exec(trimmed);
  return quoted === null ? trimmed : (quoted[2] ?? "").trim();
}

/** A key file's list: 64 integers from 0 to 255, or a refusal saying what it is instead. */
function parseList(text: string): Parsed {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return refused("not_a_key", KEY_COPY.notAKey);
  }
  if (!Array.isArray(value)) return refused("not_a_key", KEY_COPY.notAKey);
  if (!value.every((n) => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 255)) return refused("key_file", KEY_COPY.keyFileByte);
  if (value.length === 32) return refused("half_key", KEY_COPY.halfKey);
  if (value.length !== SECRET_KEY_BYTES) return refused("key_file", KEY_COPY.keyFile(value.length));
  return { kind: "bytes", bytes: Uint8Array.from(value as number[]), format: "json" };
}

/**
 * What the text is, by its shape alone. ORDER MATTERS: a JSON list has commas
 * and may have spaces, so it is read before the word test; and 64 hex characters
 * are an EVM key even when every one of them is also a base58 character (base58
 * drops only 0, O, I and l, so a hex string with no 0 is valid in both).
 */
function parse(text: string): Parsed {
  const raw = unwrap(text);
  if (raw === "") return { kind: "empty" };
  if (raw.startsWith("[")) return parseList(raw);
  if (/\s/.test(raw)) return /^[a-z]+(\s+[a-z]+){5,}$/i.test(raw) ? refused("recovery_phrase", KEY_COPY.recoveryPhrase) : refused("not_a_key", KEY_COPY.notAKey);
  if (/^0x[0-9a-f]*$/i.test(raw) || /^[0-9a-f]{64}$/i.test(raw)) return refused("evm_key", KEY_COPY.evmKey);
  const bytes = tryBase58Decode(raw);
  if (bytes === null) return refused("not_a_key", KEY_COPY.notAKey);
  if (bytes.length === 32) {
    bytes.fill(0);
    return refused("half_key", KEY_COPY.halfKey);
  }
  if (bytes.length !== SECRET_KEY_BYTES) {
    bytes.fill(0);
    return refused("not_a_key", KEY_COPY.notAKey);
  }
  return { kind: "bytes", bytes, format: "base58" };
}

/** The address a 32-byte private seed opens, or null when this runtime cannot derive it (no WebCrypto Ed25519). */
export type DeriveAddress = (seed: Uint8Array) => Promise<string | null>;

/**
 * WebCrypto Ed25519 through @solana/kit. The CryptoKey pair it returns is dropped on return; to derive the public
 * key, kit also makes a short-lived extractable copy of the private key, which goes with it.
 */
export const deriveAddress: DeriveAddress = async (seed) => {
  try {
    const pair = await createKeyPairFromPrivateKeyBytes(seed);
    return await getAddressFromPublicKey(pair.publicKey);
  } catch {
    return null;
  }
};

/**
 * The verdict on a pasted text: empty, refused with the reason in words, or a
 * whole key and the address it opens. `derive` is a parameter so tests can
 * stand in for a browser without Ed25519.
 */
export async function judgePastedKey(text: string, derive: DeriveAddress = deriveAddress): Promise<PastedKey> {
  const parsed = parse(text);
  if (parsed.kind !== "bytes") return parsed;
  const { bytes, format } = parsed;
  const seed = bytes.slice(0, 32);
  try {
    const derived = await derive(seed);
    if (derived === null) return refused("unchecked", KEY_COPY.unchecked);
    if (derived !== base58Encode(bytes.slice(32))) return refused("damaged", KEY_COPY.damaged);
    return { kind: "key", address: derived, format };
  } finally {
    seed.fill(0);
    bytes.fill(0);
  }
}

/**
 * Whether a refused text is a whole secret of ANOTHER kind — a recovery phrase,
 * or a whole EVM key, quoted or not — which the field drops at once: no step on
 * the way to a Solana key looks like either. Anything else the judge refuses may
 * be a key half typed, and stays.
 */
export function isForeignSecret(text: string, verdict: PastedKey): boolean {
  if (verdict.kind !== "refused") return false;
  return verdict.reason === "recovery_phrase" || (verdict.reason === "evm_key" && /^(0x)?[0-9a-f]{64}$/i.test(unwrap(text)));
}

/**
 * `text` with every run of `min` or more characters that also appears in `key` replaced by "[redacted]": for an
 * error raised while the key was being handed over, whatever shape a quoted or clipped piece of it takes. Short
 * messages only — it compares every position.
 */
export function scrubKeyFrom(text: string, key: string, min = 8): string {
  if (key.length < min) return text;
  let out = "";
  let at = 0;
  while (at < text.length) {
    let run = 0;
    for (let length = min; at + length <= text.length && key.includes(text.slice(at, at + length)); length += 1) run = length;
    if (run >= min) {
      out += "[redacted]";
      at += run;
    } else {
      out += text[at];
      at += 1;
    }
  }
  return out;
}

/**
 * The key as Privy's Solana importWallet takes it: base58 of the 64 bytes, or
 * null when the text is not a whole key. Only for the call itself — the caller
 * passes it on and drops it. Re-judge first: this checks the shape, not the halves.
 */
export function privateKeyForImport(text: string): string | null {
  const parsed = parse(text);
  if (parsed.kind !== "bytes") return null;
  try {
    return base58Encode(parsed.bytes);
  } finally {
    parsed.bytes.fill(0);
  }
}
