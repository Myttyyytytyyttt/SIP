// The SIP_LINK_V1 consent: the bytes a trading wallet signs, off chain, to be
// linked. Browser-safe.
//
// Mirrors packages/solana-program/programs/sip-vault/src/link_consent.rs and its
// TypeScript twin scripts/link-consent.ts. link_wallet no longer takes the
// wallet's signature on the transaction as consent, because a Privy seat holds
// that key under a policy that can match nothing finer than the program id. The
// program reads back an Ed25519SigVerify instruction, immediately before
// link_wallet, in which the wallet signed exactly these 140 bytes; the seat's
// policy denies signMessage, so only the user's own session can produce them.
//
// HERE AND NOT ONLY ON THE SERVER, because the browser is what asks the wallet to
// sign: it can rebuild the message from the four keys and refuse to sign bytes
// the server sent that are anything else. test/link-consent.test.ts pins this to
// the golden vector the program's tests hold, and to the program's own mirror.
//
// FIXED CONCATENATION: 0xFF ‖ "SIP_LINK_V1" ‖ program ‖ wallet ‖ vault ‖ owner.
// The lead byte is one no transaction message can start with, so nothing a seat
// signs through signAndSendTransaction is ever these bytes.

import { tryBase58Decode } from "./base58";

/** 0xFF, then ASCII "SIP_LINK_V1". Kept private; the export below is a copy, so mutating it cannot drift a message. */
const DOMAIN: readonly number[] = [0xff, ...Array.from("SIP_LINK_V1", (char) => char.charCodeAt(0))];

/** link_consent.rs LINK_CONSENT_DOMAIN: 0xFF, then "SIP_LINK_V1" (12 bytes). */
export const LINK_CONSENT_DOMAIN: Uint8Array = Uint8Array.from(DOMAIN);

/** domain 12 · program, wallet, vault, owner 32×4 */
export const LINK_CONSENT_MESSAGE_LEN = 140;

/** A 32-byte key as base58 text or as bytes. */
export type ConsentKey = string | Uint8Array;

export interface LinkConsentInputs {
  /** The sip_vault program id (idl.ts SIP_PROGRAM_ID for this deployment). */
  readonly programId: ConsentKey;
  /** The trading wallet being linked: the key that signs these bytes. */
  readonly wallet: ConsentKey;
  /** The vault link_wallet derives from `owner`: ["vault", owner]. */
  readonly vault: ConsentKey;
  /** The vault's owner, the pension key that pays for and co-signs the link. */
  readonly owner: ConsentKey;
}

function keyBytes(value: unknown, what: string): Uint8Array {
  const bytes = value instanceof Uint8Array ? value : typeof value === "string" ? tryBase58Decode(value) : null;
  if (bytes === null || bytes.length !== 32) throw new RangeError(`link consent: ${what} is not a 32-byte public key`);
  return bytes;
}

/** The 140 bytes the wallet signs with signMessage to consent to being linked to `vault`. */
export function linkConsentMessage(inputs: LinkConsentInputs): Uint8Array {
  const message = new Uint8Array(LINK_CONSENT_MESSAGE_LEN);
  message.set(DOMAIN, 0);
  let at = DOMAIN.length;
  for (const [what, key] of [
    ["programId", inputs.programId],
    ["wallet", inputs.wallet],
    ["vault", inputs.vault],
    ["owner", inputs.owner],
  ] as const) {
    message.set(keyBytes(key, what), at);
    at += 32;
  }
  if (at !== LINK_CONSENT_MESSAGE_LEN) throw new Error("link consent message drifted");
  return message;
}
