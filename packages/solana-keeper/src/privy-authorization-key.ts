// "Does the authorization key on Railway belong to the key quorum the keeper is
// seated under?" — the one question, decided here.
//
// WHY IT NEEDS A FILE OF ITS OWN. Privy answers a request signed by the wrong
// key with 401 "No valid authorization signatures were provided", and that
// sentence is true of every way the pairing can be wrong: a different key, a key
// from another Privy app, a paste that lost its middle. The keeper only ever
// meets it at the moment it tries to settle real money, and an operator reading
// it learns nothing about which of those it is. The pairing is checkable
// beforehand, locally and cheaply, and this is the check.
//
// THE SECRET NEVER LEAVES THE PROCESS. The private key goes in; a PUBLIC key
// comes out, which is the whole point — it is what the Privy dashboard shows
// next to the quorum, so a human can compare them with their eyes. Nothing here
// sends the key anywhere, and the remote half of the check (reading the quorum)
// needs only the app credentials.
//
// IT MIRRORS THE SDK'S PARSER, NOT A STRICTER ONE. @privy-io/node signs with
// whatever 32 bytes follow the first 0x04 0x20 in the base64-decoded value
// (lib/cryptography.ts importPKCS8PrivateKey), and Node's base64 decoder
// silently drops characters it does not recognise. So a "wallet-auth:" prefix,
// surrounding quotes, stray whitespace, 64-column wrapping and even a paste
// whose TAIL was cut all produce a byte-identical signature. isP256Pkcs8PrivateKey
// (privy-policy.ts) rejects every one of those, because it asks a different and
// stricter question — "is this canonical PKCS8?" — and answering THIS question
// with that one would report "malformed key" for a key the keeper signs with
// perfectly well, sending an operator after a paste that is not the problem.
// Measured against @privy-io/node's own generateP256KeyPair: all seven shapes
// above derive the same public key; PEM headers, an empty value and plain
// garbage derive nothing.
//
// AND IT DERIVES, IT DOES NOT ASK. Privy is never asked what our key is; the
// public key is computed from the private one with node:crypto. @noble/curves,
// which the SDK uses, is not a dependency of this package.
//
// ONE VERDICT IS EXPENSIVE TO GET WRONG. "not-in-quorum" is what sends an
// operator down the lost-key path: a new key, a new signer id, and every trading
// wallet re-seated by its user, with each user present. So it is said only about
// a quorum whose membership is fully known — public keys and nothing else. A
// quorum that also holds a nested quorum or a user holds keys this check never
// sees, and an absence from the direct list proves nothing about them
// (compareWithQuorum).

import { createPrivateKey, createPublicKey } from "node:crypto";
import { classifyPrivyError, privyErrorStatus } from "./privy-policy.js";

/**
 * A minimal PKCS8 envelope for a P-256 private key, everything but the 32-byte
 * scalar: SEQUENCE { INTEGER 0, AlgorithmIdentifier(ecPublicKey, prime256v1),
 * OCTET STRING { SEQUENCE { INTEGER 1, OCTET STRING <32 bytes> } } }.
 *
 * WHY REBUILD IT INSTEAD OF HANDING NODE THE VALUE. createPrivateKey runs a
 * strict ASN.1 parse and throws on a key whose tail was truncated — while the
 * SDK, which scans for the scalar rather than parsing, signs with it happily.
 * Feeding Node the raw value would therefore call a working key malformed. Taking
 * the scalar the SDK would take and re-wrapping it here keeps the two in step.
 */
const PKCS8_P256_PREFIX = Buffer.from("308141020100301306072a8648ce3d020106082a8648ce3d030107042730250201010420", "hex");

/** The two prefixes @privy-io/node strips before decoding, stripped the same way. */
export const PRIVY_KEY_PREFIXES = ["wallet-auth:", "wallet-api:"] as const;

/**
 * The key with every shape the SDK tolerates taken off it: both prefixes, and
 * every character base64 cannot hold — whitespace (a 64-column wrap, a stray
 * newline) and the quotes a shell or a JSON paste leaves behind.
 *
 * IT IS THE FORM THE REDACTOR MUST KNOW. The needles registered for
 * SIP_SOLANA_PRIVY_AUTHORIZATION_KEY used to be the raw environment value, its
 * trimmed form and its wallet-auth:-stripped form — so when Railway held a
 * quoted, wrapped or wallet-api:-prefixed paste (all of which this module
 * deliberately blesses, and the runbook tells the owner are fine), the CANONICAL
 * key was not a needle. Nothing in the process would then redact the string a
 * library, a stack trace or a `detail` field would actually echo, and the
 * tripwire could not catch it either: Redactor.contains' reassembly pass
 * rebuilds hex needles only (HEX_BODY, packages/solana-log/src/log.ts), never
 * base64. Both last-resort nets were off for exactly the configuration the
 * runbook recommends. registerPrivyAuthorizationKey (src/config.ts) registers
 * this form, so whatever shape sits in Railway, the key itself is a needle.
 */
export function canonicalPrivyAuthorizationKey(value: string): string {
  let out = value;
  for (const prefix of PRIVY_KEY_PREFIXES) out = out.replace(prefix, "");
  // Base64 holds none of these, so removing them all cannot damage a key and
  // cannot leave one half-cleaned.
  return out.replace(/[\s"'`]/g, "");
}

/** The marker the SDK searches for: an OCTET STRING of 32 bytes, the private scalar. */
const SCALAR_MARKER = Buffer.from([0x04, 0x20]);

/**
 * The order of the P-256 curve. A private key is a number in [1, n-1].
 *
 * CHECKED HERE BECAUSE NODE DOES NOT. createPrivateKey accepts a scalar of zero
 * (and exports a 36-character stub for it) and accepts 32 bytes of 0xff, which is
 * past the order — while @noble/curves, which the SDK signs with, throws "invalid
 * private key: out of range" for both. A key like that never reaches Privy, so
 * calling it unreadable here is what the keeper would actually experience.
 */
const P256_ORDER = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");

/** Why a value in SIP_SOLANA_PRIVY_AUTHORIZATION_KEY is not a key at all. */
export type AuthorizationKeyUnreadableReason =
  /** Nothing in the decoded bytes looks like a P-256 private scalar. */
  | "NO_PRIVATE_KEY"
  /** The scalar marker is there but the value ends before its 32 bytes do. */
  | "TRUNCATED"
  /** Thirty-two bytes were found and they are not a usable P-256 scalar (zero, or past the curve's order). */
  | "NOT_ON_THE_CURVE";

/**
 * Thrown by derivePrivyPublicKey. The message says what is wrong with the value
 * and never any part of the value itself.
 */
export class AuthorizationKeyUnreadable extends Error {
  override readonly name = "AuthorizationKeyUnreadable";

  constructor(
    readonly reason: AuthorizationKeyUnreadableReason,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The PUBLIC key of a Privy authorization private key, in the form Privy stores
 * and displays: base64 SPKI DER, no PEM headers — the same 124-character string
 * beginning "MFkwEwYHKoZI" that generateP256KeyPair returns as `publicKey`.
 *
 * Accepts what the SDK accepts and nothing else; throws AuthorizationKeyUnreadable
 * otherwise, without a network call and without quoting the value.
 */
export function derivePrivyPublicKey(value: string): string {
  // THE SAME CANONICALIZATION THE REDACTOR REGISTERS, so the string this derives
  // from and the string that is a needle cannot drift apart. Node's base64
  // decoder drops what it does not recognise, so removing the quotes and
  // whitespace first changes no byte it would have produced.
  const der = Buffer.from(canonicalPrivyAuthorizationKey(value), "base64");
  const marker = der.indexOf(SCALAR_MARKER);
  if (marker === -1) {
    throw new AuthorizationKeyUnreadable(
      "NO_PRIVATE_KEY",
      "no P-256 private key could be found in it. Privy shows the key once, as one long line starting with " +
        "wallet-auth:; a PEM block (-----BEGIN PRIVATE KEY-----) or a Solana keypair is a different thing entirely.",
    );
  }
  const scalar = der.subarray(marker + 2, marker + 34);
  if (scalar.length !== 32) {
    throw new AuthorizationKeyUnreadable(
      "TRUNCATED",
      `the key ends early: ${scalar.length} of the 32 bytes it must carry. The value was cut off — paste it again, whole.`,
    );
  }
  const asNumber = BigInt(`0x${scalar.toString("hex")}`);
  if (asNumber <= 0n || asNumber >= P256_ORDER) {
    throw new AuthorizationKeyUnreadable(
      "NOT_ON_THE_CURVE",
      "the 32 bytes it carries are not a usable P-256 key. That happens when the value was damaged near its start — " +
        "paste it again from the password manager, whole.",
    );
  }
  let publicKey: string;
  try {
    const priv = createPrivateKey({ key: Buffer.concat([PKCS8_P256_PREFIX, scalar]), format: "der", type: "pkcs8" });
    publicKey = Buffer.from(createPublicKey(priv).export({ format: "der", type: "spki" })).toString("base64");
  } catch {
    // The parser's own message describes DER state and would help nobody here.
    throw new AuthorizationKeyUnreadable(
      "NOT_ON_THE_CURVE",
      "the 32 bytes it carries are not a usable P-256 key. That happens when the value was damaged near its start — " +
        "paste it again from the password manager, whole.",
    );
  }
  return publicKey;
}

/**
 * A base64 SPKI key with every space and line break removed.
 *
 * PRIVY'S OWN EXAMPLES WRAP THESE AT 64 COLUMNS, embedded newlines and all
 * (@privy-io/node resources/key-quorums.ts), so comparing a registered key
 * against a locally derived single-line one with === would report "does not
 * match" for exactly the right key.
 */
export const normalizeSpki = (value: string): string => value.replace(/\s+/g, "");

/** One key registered in a Privy key quorum, as the quorum read returns it. */
export interface RegisteredAuthorizationKey {
  readonly publicKey: string;
  readonly displayName: string | null;
}

/**
 * A Privy key quorum, reduced to what this check reads.
 *
 * MEMBERSHIP IS THREE LISTS, NOT ONE. A KeyQuorum carries `authorization_keys`,
 * `user_ids` AND `key_quorum_ids` — nested quorums, one level deep
 * (@privy-io/node resources/key-quorums.d.ts). A key seated through a user or a
 * nested quorum signs exactly as well as one in the direct list, and Privy
 * validates a request's signature against what authorizes the WALLET, not
 * against the id this keeper calls its signer. So the direct list alone is not
 * the membership, and reading it as the membership turns "I cannot see it" into
 * "it is not there" — which is the difference between an unproven pairing and
 * the lost-key procedure, whose price is every trading wallet re-seated by its
 * user.
 */
export interface KeyQuorumLike {
  readonly id: string;
  readonly authorizationKeys: readonly RegisteredAuthorizationKey[];
  /** Nested key quorums that are members of this one. Their keys are not read here. */
  readonly keyQuorumIds?: readonly string[];
  /** Users that are members. Each authorizes with a key this check cannot see. */
  readonly userIds?: readonly string[];
  /**
   * How many of the quorum's members must sign for a request to be valid, as
   * Privy stores it; null when Privy did not say.
   *
   * THE KEEPER HAS EXACTLY ONE SIGNATURE TO GIVE. privy-signer.ts sends one key
   * in authorization_private_keys, so a threshold above 1 refuses every settle
   * however right the key is — and being registered is then not the same as
   * being able to sign.
   */
  readonly authorizationThreshold?: number | null;
}

/**
 * What the check concluded, worded for the person reading /status or the command's
 * output — each value says what IS, not which call returned what.
 */
export type AuthorizationKeyCheck =
  /** Not performed: a dry run reads no signing secret, and with no signer id there is no quorum to compare against. */
  | "not-checked"
  /** The key's public key is registered in the configured quorum. This is the only healthy value. */
  | "matches"
  /** The key is a key, and its public key is NOT one of the quorum's. Every settle will be refused. */
  | "not-in-quorum"
  /**
   * The key is not one of the quorum's OWN public keys, and the quorum has
   * members this check cannot read. Unproven, not wrong.
   */
  | "members-unresolved"
  /** The key IS registered, and the quorum wants more signatures than the keeper can give. */
  | "threshold-above-one"
  /** The value is not a P-256 private key at all; nothing was sent anywhere. */
  | "key-unreadable"
  /** Privy refused the app id and secret, so the quorum could not be read. */
  | "credentials-refused"
  /** Privy has no key quorum with the configured id, in this app. */
  | "quorum-not-found"
  /** Privy could not be reached or answered something else; the pairing is unknown. */
  | "quorum-unreadable";

/** Plain sentences for each verdict: what it means, and what to do next. */
export const AUTHORIZATION_KEY_MEANING: Readonly<Record<AuthorizationKeyCheck, string>> = {
  "not-checked": "The pairing was not checked.",
  matches: "The configured authorization key is registered in the configured key quorum. Signing should be accepted.",
  "not-in-quorum":
    "The key is a valid P-256 key, but its public key is not one this key quorum holds. Privy will refuse every " +
    "settle with 401 'No valid authorization signatures were provided' — this is that error's cause.",
  "members-unresolved":
    "The key is a valid P-256 key and is not one of this quorum's own public keys — but the quorum also has members " +
    "this check cannot read (a nested key quorum, or a user), and a key held by one of those signs just as well. The " +
    "pairing is UNPROVEN, not wrong.",
  "threshold-above-one":
    "The key IS registered in this key quorum, and the quorum requires more than one signature. The keeper signs with " +
    "one key and sends one signature, so Privy refuses every settle for want of the others — with the same 401 family " +
    "a wrong key produces. The key is right; the quorum is not one this keeper can satisfy alone.",
  "key-unreadable": "SIP_SOLANA_PRIVY_AUTHORIZATION_KEY does not hold a P-256 private key, so nothing could be derived from it.",
  "credentials-refused": "Privy refused the app id and secret, so the key quorum could not be read. This says nothing about the key.",
  "quorum-not-found": "This Privy app has no key quorum with that id. Either the id is wrong or it belongs to another app.",
  "quorum-unreadable": "Privy could not be read, so the pairing is unknown. This says nothing about the key.",
};

export const AUTHORIZATION_KEY_NEXT: Readonly<Record<AuthorizationKeyCheck, string>> = {
  "not-checked": "Set SIP_SOLANA_PRIVY_SIGNER_ID to the keeper signer's key quorum id, and run the command again.",
  matches:
    "Nothing to do about the key. If settles are still refused, the cause is elsewhere: check the seat and its policy " +
    "with `privy-policy verify`.",
  "not-in-quorum":
    "Open the Privy dashboard, Wallets → Authorization keys, and find the key whose id is this key quorum. Compare the " +
    "public key shown there with the derivedPublicKey printed above. They differ, so the private key in " +
    "SIP_SOLANA_PRIVY_AUTHORIZATION_KEY belongs to something else — set the variable to the private key of THAT quorum. " +
    "If that private key is lost, it cannot be recovered: see docs/runbooks/PRIVY_SOLANA.md.",
  "threshold-above-one":
    "Do not change the key: it is the right one. Open the Privy dashboard, Wallets → Authorization keys, and set this " +
    "key quorum's threshold back to 1 — or remove the members it gained, so one signature is again enough. A keeper " +
    "that must collect a second signature is a keeper that cannot settle unattended, which is the whole of its job.",
  "members-unresolved":
    "Do not regenerate anything yet, and do not re-seat any wallet. Open the Privy dashboard, Wallets → Authorization " +
    "keys, and look at this key quorum's members: besides the public keys printed above it holds a nested key quorum or " +
    "a user, and the keeper's key may well be registered there. Compare derivedPublicKey with the keys of those members " +
    "by eye. Only a quorum that holds public keys and nothing else can prove a key is missing from it.",
  "key-unreadable": "Paste the key again, whole, from the password manager. Nothing was sent to Privy.",
  "credentials-refused":
    "Check SIP_SOLANA_PRIVY_APP_ID and SIP_SOLANA_PRIVY_APP_SECRET against the dashboard's app settings. Both belong " +
    "to the same app as the key quorum.",
  "quorum-not-found":
    "Check SIP_SOLANA_PRIVY_SIGNER_ID against the dashboard's Wallets → Authorization keys: the id shown for the " +
    "keeper's key is the value it takes. An id from a different Privy app reads as missing here.",
  "quorum-unreadable": "Run the command again in a minute. If it keeps happening, check status.privy.io before changing anything.",
};

/** Which verdicts mean the keeper's signing is broken, as opposed to unproven. */
export const AUTHORIZATION_KEY_BROKEN: ReadonlySet<AuthorizationKeyCheck> = new Set<AuthorizationKeyCheck>([
  "not-in-quorum",
  "key-unreadable",
  // REGISTERED AND STILL REFUSED. One signature against a threshold of two is as
  // certain a refusal as the wrong key, and certainty is what this set means.
  "threshold-above-one",
]);

/**
 * Members of the quorum whose keys this check cannot read, so an operator knows
 * where to look instead of being told a key is missing.
 *
 * THE NESTED QUORUMS ARE NAMED AND THE USERS ARE COUNTED. A key quorum id is
 * infrastructure an operator opens in the dashboard; a Privy user id names a
 * person, and the count already says everything this verdict needs it to say.
 */
export interface UnresolvedQuorumMembers {
  readonly keyQuorumIds: readonly string[];
  readonly users: number;
}

/** What the check found, with the public data an operator compares by eye. */
export interface AuthorizationKeyVerdict {
  readonly check: AuthorizationKeyCheck;
  /** The public key derived from the configured private key, or null when none could be. */
  readonly derivedPublicKey: string | null;
  /** The quorum's registered public keys, whitespace-normalized, or null when the quorum was not read. */
  readonly registered: readonly RegisteredAuthorizationKey[] | null;
  /** What the quorum holds besides those keys, or null when the quorum was not read. */
  readonly unresolvedMembers: UnresolvedQuorumMembers | null;
  /** How many signatures the quorum requires; null when the quorum was not read, or did not say. */
  readonly authorizationThreshold: number | null;
  readonly meaning: string;
  readonly next: string;
}

const verdictOf = (
  check: AuthorizationKeyCheck,
  derivedPublicKey: string | null,
  registered: readonly RegisteredAuthorizationKey[] | null,
  unresolvedMembers: UnresolvedQuorumMembers | null = null,
  authorizationThreshold: number | null = null,
): AuthorizationKeyVerdict => ({
  check,
  derivedPublicKey,
  registered,
  unresolvedMembers,
  authorizationThreshold,
  meaning: AUTHORIZATION_KEY_MEANING[check],
  next: AUTHORIZATION_KEY_NEXT[check],
});

/**
 * Compares a derived public key with a quorum's registered ones.
 *
 * WHITESPACE IS NOT PART OF A KEY: both sides are normalized before they are
 * compared, and the normalized form is what is reported, so what an operator
 * reads is what was actually compared.
 *
 * "NOT IN" IS RESERVED FOR A QUORUM WHOSE MEMBERSHIP IS FULLY KNOWN. A quorum
 * that also holds a nested quorum or a user holds keys this check never sees, so
 * an absence from the direct list is not evidence of anything: the verdict is
 * members-unresolved, whose own words say not to regenerate the key. The verdict
 * this guards is the one that sends an operator down the lost-key path — a new
 * key, a new signer id, and every trading wallet re-seated by its user — and
 * spending that on a credential that signs perfectly well is the expensive way
 * to be wrong.
 */
export function compareWithQuorum(derivedPublicKey: string, quorum: KeyQuorumLike): AuthorizationKeyVerdict {
  const derived = normalizeSpki(derivedPublicKey);
  const registered = quorum.authorizationKeys.map((key) => ({ publicKey: normalizeSpki(key.publicKey), displayName: key.displayName }));
  const members: UnresolvedQuorumMembers = { keyQuorumIds: [...(quorum.keyQuorumIds ?? [])], users: quorum.userIds?.length ?? 0 };
  const threshold = quorum.authorizationThreshold ?? null;
  if (registered.some((key) => key.publicKey === derived)) {
    // BEING REGISTERED IS NOT BEING ABLE TO SIGN. The keeper puts exactly one key
    // in authorization_private_keys, so a quorum that wants two signatures
    // refuses every settle while this check, reading the key list alone, said
    // "matches" and sent the operator off to examine the seat and the policy —
    // both of which he would find perfectly bound. A threshold Privy did not
    // report (null) is not read as a fault.
    const short = threshold !== null && threshold > 1;
    return verdictOf(short ? "threshold-above-one" : "matches", derived, registered, members, threshold);
  }
  const unresolved = members.keyQuorumIds.length + members.users;
  return verdictOf(unresolved > 0 ? "members-unresolved" : "not-in-quorum", derived, registered, members, threshold);
}

/** The verdict for a value that could not be read as a key. Nothing was sent anywhere. */
export const unreadableKeyVerdict = (): AuthorizationKeyVerdict => verdictOf("key-unreadable", null, null);

/**
 * Which verdict a failed quorum read amounts to.
 *
 * 401 and 403 are the app credentials (classifyPrivyError's AUTHORIZATION), 404
 * is an id this app does not have, and everything else — a timeout, a 5xx, a
 * dropped connection — leaves the pairing unknown rather than wrong. The
 * distinction matters: only "not-in-quorum" is evidence of a broken keeper.
 */
export function quorumReadVerdict(error: unknown, derivedPublicKey: string | null): AuthorizationKeyVerdict {
  const status = privyErrorStatus(error);
  if (status === 404) return verdictOf("quorum-not-found", derivedPublicKey, null);
  if (classifyPrivyError(error) === "AUTHORIZATION") return verdictOf("credentials-refused", derivedPublicKey, null);
  return verdictOf("quorum-unreadable", derivedPublicKey, null);
}

/** The verdict for a check that was not performed: a dry run, or no signer id to compare against. */
export const notCheckedVerdict = (): AuthorizationKeyVerdict => verdictOf("not-checked", null, null);
