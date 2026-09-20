// Environment loading. Refuses to start rather than guessing.
//
// The doctrine is the EVM worker's (now in archive/evm): a dry run needs
// no secret and READS none, going live takes an exact sentence compared byte for
// byte, and a refusal names the variable and never its value. The variables are
// the keeper's own, SIP_SOLANA_*, and Nuvem's names are not aliases but refusals.
//
// WHAT THIS REPLACES. Nuvem's supervisor read its environment inline, at module
// scope, in the order it happened to need things: it loaded the crank and
// attester keys before it knew whether it was armed and exited without them even
// in dry run, appended the public RPC to whatever it was given, and read
// NUVEM_*, PRIVY_* and ANCHOR_* names interchangeably. Here the environment is
// read once, by a function a test can hand a Proxy, and the answer is a frozen
// object or a ConfigError.
//
// THREE RULES, each one tested:
//
//   * DRY RUN READS NO SIGNING SECRET. SIP_SOLANA_SETTLE_KEY, the Privy app secret
//     and authorization key, and SIP_SOLANA_LOCAL_SIGNERS_DIR are looked up only
//     once the arming check has passed. Their NAMES are listed — Object.keys
//     reads no value — so an operator is told they were present and ignored.
//
//   * ARMING IS TWO VARIABLES AND ONE EXACT SENTENCE. SIP_SOLANA_BROADCAST=1 says
//     go live; SIP_SOLANA_ALLOW_BROADCAST must equal BROADCAST_ACK byte for byte.
//     The flag with a wrong or missing sentence refuses to start — an operator
//     who set it believes the keeper is live — and the sentence without the flag
//     is announced as still a dry run.
//
//   * NUVEM'S CONFIGURATION IS REFUSED, NOT ADAPTED. A NUVEM_* variable, or one of
//     the bare PRIVY_* and ANCHOR_* names Nuvem's keeper read, means an
//     environment was copied from a deployment whose program key leaked. Quietly
//     ignoring it would leave an operator believing a setting took effect.
//
// NO MESSAGE BUILT HERE CONTAINS AN ENVIRONMENT VALUE. Problems name the variable,
// the shape expected and the SHAPE received (`shape()`: length and character
// class). Every credential-bearing value — endpoints, the database URL, the
// webhook, every signing secret — is registered with the redactor the moment it
// is read, and every problem and warning is scrubbed on the way out.

import { createHash } from "node:crypto";
import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { Redactor, Secret, sharedRedactor } from "@sip/solana-log";
import { OLD_NUVEM_PROGRAM_ID, SIP_PROGRAM_ID } from "./idl.js";
import { PRIVY_KEY_PREFIXES, canonicalPrivyAuthorizationKey } from "./privy-authorization-key.js";

/**
 * The literal acknowledgement that arms the keeper. Nothing else does.
 *
 * REDECLARED, NOT IMPORTED: the same sentence the EVM worker (now archived)
 * declared, byte for byte. test/config.test.ts pins the literal, so changing it
 * takes a deliberate edit in two places.
 */
export const BROADCAST_ACK = "i-understand-this-moves-real-funds";

export const DEFAULT_SWEEP_MS = 60_000;
/** Below this a sweep over a handful of links overruns itself on a public endpoint. */
export const MIN_SWEEP_MS = 5_000;

/** Read only when armed. Everything else in the environment is readable at any time. */
export const SIGNING_SECRET_VARS = [
  "SIP_SOLANA_SETTLE_KEY",
  "SIP_SOLANA_PRIVY_APP_SECRET",
  "SIP_SOLANA_PRIVY_AUTHORIZATION_KEY",
  "SIP_SOLANA_LOCAL_SIGNERS_DIR",
] as const;

const KNOWN_SIP_SOLANA_VARS = new Set<string>([
  "SIP_SOLANA_RPC_URLS",
  "SIP_SOLANA_PROGRAM_ID",
  "SIP_SOLANA_SWEEP_MS",
  "SIP_SOLANA_POOLS",
  "SIP_SOLANA_ALERT_WEBHOOK",
  "SIP_SOLANA_BROADCAST",
  "SIP_SOLANA_ALLOW_BROADCAST",
  "SIP_SOLANA_PRIVY_APP_ID",
  "SIP_SOLANA_PRIVY_SIGNER_ID",
  "SIP_SOLANA_PRIVY_POLICY_ID",
  ...SIGNING_SECRET_VARS,
]);

/** The unprefixed names Nuvem's keeper read, and what SIP reads in their place. */
const COPIED_BARE_NAMES: Readonly<Record<string, string>> = {
  PRIVY_APP_ID: "SIP_SOLANA_PRIVY_APP_ID",
  PRIVY_APP_SECRET: "SIP_SOLANA_PRIVY_APP_SECRET",
  PRIVY_AUTHORIZATION_KEY: "SIP_SOLANA_PRIVY_AUTHORIZATION_KEY",
  PRIVY_AUTHORIZATION_PRIVATE_KEY: "SIP_SOLANA_PRIVY_AUTHORIZATION_KEY",
  ANCHOR_WALLET: "SIP_SOLANA_SETTLE_KEY",
  ANCHOR_PROVIDER_URL: "SIP_SOLANA_RPC_URLS",
};

/** Every NUVEM_* name the Solana keeper and its scripts are known to have read. */
const NUVEM_REPLACEMENTS: Readonly<Record<string, string>> = {
  NUVEM_SOLANA_MAINNET_RPC: "SIP_SOLANA_RPC_URLS",
  NUVEM_SOLANA_MAINNET_RPC2: "SIP_SOLANA_RPC_URLS",
  NUVEM_SOLANA_RPC_URL: "SIP_SOLANA_RPC_URLS",
  NUVEM_SOLANA_RPC_URL2: "SIP_SOLANA_RPC_URLS",
  NUVEM_SOLANA_SWEEP_MS: "SIP_SOLANA_SWEEP_MS",
  NUVEM_SOLANA_POOLS: "SIP_SOLANA_POOLS",
  NUVEM_SOLANA_ALERT_WEBHOOK: "SIP_SOLANA_ALERT_WEBHOOK",
  NUVEM_ALERT_WEBHOOK: "SIP_SOLANA_ALERT_WEBHOOK",
  NUVEM_KEEPER_DATABASE_URL: "DATABASE_URL",
  NUVEM_SOLANA_BROADCAST: "SIP_SOLANA_BROADCAST",
  NUVEM_SOLANA_ALLOW_BROADCAST: "SIP_SOLANA_ALLOW_BROADCAST",
  NUVEM_SOLANA_CRANK_KEY: "SIP_SOLANA_SETTLE_KEY",
  NUVEM_SOLANA_ATTESTER_KEY: "SIP_SOLANA_SETTLE_KEY",
  NUVEM_SOLANA_SIGNER_ID: "SIP_SOLANA_PRIVY_SIGNER_ID",
};

/** What `loadConfig` throws. `problems` and `message` are already scrubbed. */
export class ConfigError extends Error {
  override readonly name = "ConfigError";

  constructor(readonly problems: readonly string[]) {
    super(`Refusing to start:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
  }
}

/**
 * The settle wallet's key: the attester AND the crank during the hackathon.
 *
 * THE KEYPAIR IS UNREACHABLE BY SERIALIZATION. It lives in a private field;
 * JSON.stringify and util.inspect see the public key and a redaction marker.
 * `keypair()` is called at the two points of use — signing an attestation and
 * paying for a crank — and nowhere else.
 */
export class SettleKey {
  readonly #keypair: Keypair;
  readonly publicKey: PublicKey;

  constructor(keypair: Keypair) {
    this.#keypair = keypair;
    this.publicKey = keypair.publicKey;
  }

  keypair(): Keypair {
    return this.#keypair;
  }

  toJSON(): Record<string, string> {
    return { publicKey: this.publicKey.toBase58(), secretKey: "<redacted:settleKey>" };
  }

  toString(): string {
    return `SettleKey(${this.publicKey.toBase58()})`;
  }

  [Symbol.for("nodejs.util.inspect.custom")](): Record<string, string> {
    return this.toJSON();
  }
}

export interface PrivySigningConfig {
  /** Public: an id, legible in logs on purpose. */
  readonly appId: string;
  readonly appSecret: Secret;
  readonly authorizationKey: Secret;
}

/** Everything that can sign. Exists only in an armed config. */
export interface SigningConfig {
  readonly settleKey: SettleKey;
  readonly privy: PrivySigningConfig | null;
  /** Localnet only; there is no default path. */
  readonly localSignersDir: Secret | null;
}

export interface KeeperConfig {
  /** SIP_SOLANA_BROADCAST=1 AND the exact sentence. Necessary for live, not sufficient: see bin/keeper.mts. */
  readonly armed: boolean;
  /** In failover order. Secrets, because endpoints carry API keys. */
  readonly rpcUrls: readonly Secret[];
  readonly programId: string;
  readonly sweepMs: number;
  /** mint (base58) → Raydium CLMM pool. */
  readonly pools: ReadonlyMap<string, PublicKey>;
  readonly alertWebhook: Secret | null;
  /** The lowest severity that leaves the box. Below it, alerts are logged only. */
  readonly alertMinSeverity: "warn" | "critical";
  /** Telegram needs the chat in the body; it is public, like a channel name. */
  readonly alertChatId: string | null;
  /** Where an operator would look next, offered as a button. Railway sets the domain itself. */
  readonly statusUrl: string | null;
  readonly databaseUrl: Secret | null;
  readonly port: number | null;
  readonly privyAppId: string | null;
  readonly privySignerId: string | null;
  /**
   * OPTIONAL, and the keeper starts without it. Set, the keeper refuses to sign
   * for a wallet whose seat is not bounded by exactly this policy; unset, it
   * signs as it always has and says so once at startup.
   */
  readonly privyPolicyId: string | null;
  /** Null in dry run: nothing in this object can sign anything. */
  readonly signing: SigningConfig | null;
  /** Already scrubbed. */
  readonly warnings: readonly string[];
}

const trimmed = (value: string | undefined): string | undefined => {
  const out = value?.trim();
  return out === undefined || out === "" ? undefined : out;
};

const tryUrl = (raw: string): URL | null => {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
};

const JSON_KEY_SHAPE = /^\s*\[\s*\d{1,3}(\s*,\s*\d{1,3}){31,}\s*\]\s*$/;

/**
 * Describes a rejected value WITHOUT reproducing any of it — the worker's rule.
 *
 * Length and character class diagnose every mistake that actually happens and
 * are enough to use none. The key-shaped case gets its own sentence because it
 * is the one mistake with a catastrophic version.
 */
export function shape(value: string): string {
  if (value.length === 0) return "an empty value";
  if (JSON_KEY_SHAPE.test(value)) {
    return (
      `a ${value.length}-character value shaped like a JSON array secret key ` +
      "(withheld — if a signing key was pasted into this variable, treat it as exposed and rotate it)"
    );
  }
  const kind = /^\s+$/.test(value)
    ? "whitespace-only"
    : /^[+-]?[0-9]+$/.test(value)
      ? "decimal-integer"
      : /^[1-9A-HJ-NP-Za-km-z]+$/.test(value)
        ? "base58-alphabet"
        : "free-form";
  return `a ${value.length}-character ${kind} value`;
}

/**
 * Registers a URL and the parts of it that carry credentials on their own.
 *
 * A provider key is in the query (?api-key=…) or in the path (/v2/<key>), and a
 * library error or a derived websocket URL can quote either part without the
 * rest, so the parts are needles too. Parts under 8 characters are dropped by
 * the Redactor itself.
 */
function registerUrl(redactor: Redactor, raw: string, label: string, parsed: URL | null): void {
  redactor.register(raw, label);
  if (parsed === null) return;
  for (const part of [parsed.href, parsed.search, parsed.pathname, parsed.username, parsed.password]) {
    if (part !== "") redactor.register(part, label);
  }
}

/**
 * Registers a Privy authorization key (a P-256 PKCS8 private key, base64) in
 * every form a line can quote it in.
 *
 * THE VALUE AS PASTED IS NOT THE ONLY FORM. The SDK strips Privy's
 * "wallet-auth:" prefix and uses the body, so an error can quote the body alone
 * — and Privy signs identically for a value carrying "wallet-api:", surrounding
 * quotes or 64-column wrapping, all of which derivePrivyPublicKey deliberately
 * accepts and the runbook tells the owner are fine to paste. Registering only
 * the raw value and its wallet-auth:-stripped form left the CANONICAL key — the
 * string any library, stack trace or `detail` field would actually echo —
 * unknown to the redactor for exactly those configurations, with no second net
 * under it: Redactor.contains' reassembly pass rebuilds hex needles only, never
 * base64. So the canonical form is registered too, and the prefixed canonical
 * forms with it, because the redactor replaces its longest needle first and a
 * line should not be left holding a bare "wallet-auth:".
 *
 * Shared by loadConfig and bin/privy-policy.mts, which reads the same variable
 * outside an armed config.
 */
export function registerPrivyAuthorizationKey(redactor: Redactor, value: string, label = "privyAuthorizationKey"): void {
  redactor.register(value, label);
  redactor.register(value.replace(/^wallet-auth:/, ""), label);
  const canonical = canonicalPrivyAuthorizationKey(value);
  for (const prefix of PRIVY_KEY_PREFIXES) redactor.register(`${prefix}${canonical}`, label);
  redactor.register(canonical, label);
}

const isLoopback = (host: string): boolean =>
  host === "localhost" || host === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);

/** Refusals for copied Nuvem configuration, decided from NAMES alone. */
export function copiedConfigProblems(names: readonly string[]): string[] {
  const problems: string[] = [];
  for (const name of [...names].sort()) {
    const bare = COPIED_BARE_NAMES[name];
    const replacement = bare ?? (name.startsWith("NUVEM_") ? (NUVEM_REPLACEMENTS[name] ?? null) : undefined);
    if (replacement === undefined) continue;
    problems.push(
      `${name} is a legacy variable name, not one SaverFi reads` +
        (replacement === null
          ? "; the SaverFi keeper has no counterpart for it. Remove it."
          : `; the SaverFi keeper reads ${replacement} instead. Rename it and re-check the value.`) +
        " Its value was not read, and an environment that carries a legacy name " +
        "is refused whole rather than half-applied.",
    );
  }
  return problems;
}

/**
 * The environment variables the Privy SDK reads on its own
 * (node_modules/@privy-io/node/client.js), and what each would do to requests
 * that carry the app secret and, when signing, authorization signatures.
 */
const PRIVY_SDK_OVERRIDES: Readonly<Record<string, string>> = {
  PRIVY_API_BASE_URL: "it sends every Privy request, app secret included, to the host it names",
  PRIVY_API_LOG: "it makes the SDK log request details",
  PRIVY_API_CUSTOM_HEADERS: "it adds its headers to every Privy request, and no option in code can turn that off",
};

export const PRIVY_SDK_OVERRIDE_VARS: readonly string[] = Object.freeze(Object.keys(PRIVY_SDK_OVERRIDES));

/**
 * Refusals for the Privy SDK's own environment overrides, decided from NAMES
 * alone.
 *
 * NOT NUVEM'S, AND NOTHING TO RENAME. SIP's Privy clients pin the API URL and
 * the log level in code, but headers from the environment are merged whatever
 * the options say, so the only safe value for any of the three is unset.
 */
export function privySdkOverrideProblems(names: readonly string[]): string[] {
  return [...names]
    .sort()
    .filter((name) => PRIVY_SDK_OVERRIDE_VARS.includes(name))
    .map(
      (name) =>
        `${name} is the Privy SDK's own setting and changes where or how requests carrying the app secret are sent: ` +
        `${PRIVY_SDK_OVERRIDES[name]}. Unset it. Its value was not read.`,
    );
}

/** The old supervisor's near-miss diagnostics for the sentence, without echoing a byte of it. */
function sentenceProblem(got: string | undefined): string {
  const why =
    got === undefined
      ? "It is not set at all."
      : got === ""
        ? "It is set but empty."
        : got.trim() === BROADCAST_ACK
          ? `It matches except for surrounding whitespace (${got.length} characters where ${BROADCAST_ACK.length} are expected).`
          : got.trim().toLowerCase() === BROADCAST_ACK
            ? "It matches except for capitalisation; the check is case sensitive."
            : `It holds ${got.length} characters that are not the sentence.`;
  return (
    `SIP_SOLANA_BROADCAST=1 requires SIP_SOLANA_ALLOW_BROADCAST to be exactly "${BROADCAST_ACK}". ${why} ` +
    "Refusing to start: an operator who set the flag believes this keeper is live."
  );
}

/**
 * MINT=POOL pairs, comma separated. The old supervisor's rules, with positions
 * instead of echoed entries.
 *
 * MALFORMED ENTRIES ARE REFUSED AT STARTUP, not skipped. Silently dropping one
 * meant an operator who fat-fingered a mint saw a keeper that started cleanly
 * and then refused that leg forever with "no pool configured" — a message that
 * points at the policy rather than at the typo that caused it.
 *
 * The pool ADDRESS itself is not validated beyond being a pubkey, and cannot
 * usefully be: what protects the vault is invest(), which pins the venue
 * PROGRAM from the owner-signed policy and measures the spend and the fill
 * against the vault's own accounts. A wrong pool here produces a failed or
 * underfilled swap, never a drained vault.
 */
export function parsePools(raw: string | undefined, problems: string[]): Map<string, PublicKey> {
  const pools = new Map<string, PublicKey>();
  const positions = new Map<string, number>();
  const entries = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  entries.forEach((entry, index) => {
    const position = index + 1;
    const parts = entry.split("=").map((part) => part.trim());
    if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
      problems.push(`SIP_SOLANA_POOLS entry #${position} is not MINT=POOL: it holds ${shape(entry)}.`);
      return;
    }
    let mint: PublicKey;
    let pool: PublicKey;
    try {
      mint = new PublicKey(parts[0]!);
      pool = new PublicKey(parts[1]!);
    } catch {
      problems.push(`SIP_SOLANA_POOLS entry #${position} has an address that is not a base58 32-byte public key.`);
      return;
    }
    const key = mint.toBase58();
    const earlier = positions.get(key);
    if (earlier !== undefined) {
      problems.push(`SIP_SOLANA_POOLS entries #${earlier} and #${position} name the same mint. Refusing to start rather than pick one.`);
      return;
    }
    positions.set(key, position);
    pools.set(key, pool);
  });
  return pools;
}

/** Which keys each redactor already knows, by a SHA-256 of the key: never the key itself. */
const registeredKeys = new WeakMap<Redactor, Set<string>>();

/**
 * Registers every textual form a Solana secret key can take in a log line: the
 * JSON array, the bare comma lists Array#join makes of it, hex, the seed's hex,
 * and base58. The decimal columns util.inspect prints are not a fixed string,
 * so keeper-log.ts drops any line carrying a run of byte values instead.
 *
 * ONCE PER KEY PER REDACTOR. Local signers are re-read every sweep, and a
 * redactor that gained eighteen needles a minute would slow every line it
 * scrubs, forever.
 */
export function registerSecretKeyForms(bytes: Uint8Array, redactor: Redactor, label: string): void {
  const fingerprint = createHash("sha256").update(bytes).digest("hex");
  let known = registeredKeys.get(redactor);
  if (known === undefined) {
    known = new Set();
    registeredKeys.set(redactor, known);
  }
  if (known.has(fingerprint)) return;
  known.add(fingerprint);
  const list = Array.from(bytes);
  for (const form of [
    JSON.stringify(list),
    list.join(","),
    list.join(", "),
    Buffer.from(bytes).toString("hex"),
    Buffer.from(bytes.subarray(0, 32)).toString("hex"),
    anchor.utils.bytes.bs58.encode(bytes),
  ]) {
    redactor.register(form, label);
  }
}

/**
 * A Solana secret key from the id.json-style JSON array, or null.
 *
 * A PARSE ERROR NEVER LEAVES THIS FUNCTION: V8's SyntaxError quotes the input it
 * choked on, and the input is a signing key. Every textual form the key could
 * take in a log line — the JSON, the bare comma list a Uint8Array prints as,
 * hex, base58 — is registered before the Keypair is even built.
 */
export function parseSettleKey(raw: string, redactor: Redactor): SettleKey | null {
  let bytes: Uint8Array;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 64 ||
      !parsed.every((value) => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 255)
    ) {
      return null;
    }
    bytes = Uint8Array.from(parsed as number[]);
  } catch {
    return null;
  }
  registerSecretKeyForms(bytes, redactor, "settleKey");
  try {
    return new SettleKey(Keypair.fromSecretKey(bytes));
  } catch {
    return null;
  }
}

/** Fields of the config that are safe in a log line or a status page. */
export function describeConfig(config: KeeperConfig): Record<string, unknown> {
  return {
    armed: config.armed,
    rpcEndpoints: config.rpcUrls.length,
    programId: config.programId,
    sweepMs: config.sweepMs,
    pools: config.pools.size,
    alertWebhook: config.alertWebhook !== null,
    alertMinSeverity: config.alertMinSeverity,
    alertChatId: config.alertChatId,
    statusUrl: config.statusUrl,
    database: config.databaseUrl !== null,
    port: config.port,
    privyAppId: config.privyAppId,
    privySignerId: config.privySignerId,
    privyPolicyId: config.privyPolicyId,
    signing:
      config.signing === null
        ? null
        : {
            settleKey: config.signing.settleKey.publicKey.toBase58(),
            privy: config.signing.privy !== null,
            localSigners: config.signing.localSignersDir !== null,
          },
  };
}

/**
 * Reads the environment into a frozen KeeperConfig, or throws ConfigError.
 *
 * Pure but for the side effect that is the point: every credential it reads is
 * registered with `redactor` (the process-wide `sharedRedactor` by default, which
 * is what the default logger scrubs with).
 */
export function loadConfig(env: NodeJS.ProcessEnv, redactor: Redactor = sharedRedactor): KeeperConfig {
  const problems: string[] = [];
  const warnings: string[] = [];
  // NAMES ONLY. Object.keys runs no getter and returns no value, which is how
  // this function can know a signing secret is present without reading it.
  const names = Object.keys(env);

  // --- copied Nuvem configuration --------------------------------------------
  const copied = copiedConfigProblems(names);
  problems.push(...copied);
  // The Privy SDK's own overrides: names only, refused like the above.
  problems.push(...privySdkOverrideProblems(names));

  // --- the arming gate ---------------------------------------------------------
  //
  // Read RAW, not trimmed. The failure mode of strictness is a refusal that says
  // exactly why; the failure mode of leniency is a broadcast nobody intended.
  const flag = env["SIP_SOLANA_BROADCAST"];
  const sentence = env["SIP_SOLANA_ALLOW_BROADCAST"];
  let armed = false;
  if (flag === "1") {
    if (sentence === BROADCAST_ACK) armed = true;
    else problems.push(sentenceProblem(sentence));
  } else {
    if (flag !== undefined && flag !== "" && flag !== "0") {
      warnings.push(
        `SIP_SOLANA_BROADCAST is set but is not exactly 1 (it holds ${shape(flag)}) — still a dry run. ` +
          "Only the literal 1 arms, so a value written to mean the opposite cannot.",
      );
    }
    if (sentence !== undefined) {
      // The sentence alone arms nothing. An operator who set one of the pair
      // believes the keeper is live; say plainly that it is not, because a
      // silently-disarmed keeper is indistinguishable from an armed one until
      // the first profitable session settles nothing.
      warnings.push(
        "SIP_SOLANA_ALLOW_BROADCAST is set but SIP_SOLANA_BROADCAST is not 1 — still a dry run: nothing will " +
          "be sent and no signing secret was read. Set SIP_SOLANA_BROADCAST=1 to arm.",
      );
    }
  }

  const unknown = names.filter((name) => name.startsWith("SIP_SOLANA_") && !KNOWN_SIP_SOLANA_VARS.has(name)).sort();
  if (unknown.length > 0) {
    warnings.push(
      `${unknown.join(", ")}: not a variable this keeper reads. A misspelt setting is one that silently does nothing.`,
    );
  }

  // --- endpoints ---------------------------------------------------------------
  //
  // Each one is registered the moment it is read, not at the end: it carries the
  // API key and the next line can already fail. Nothing is appended.
  const rpcUrls: Secret[] = [];
  const rpcHosts: string[] = [];
  const rpcRaw = env["SIP_SOLANA_RPC_URLS"];
  const rpcEntries = (rpcRaw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  if (rpcEntries.length === 0) {
    problems.push(
      "SIP_SOLANA_RPC_URLS is required: one or more http(s) Solana JSON-RPC endpoints, comma-separated, in " +
        "failover order. Nothing is appended implicitly — list the public endpoint yourself if you want it last.",
    );
  }
  const seen = new Set<string>();
  rpcEntries.forEach((entry, index) => {
    const label = `rpcUrl:${index}`;
    const parsed = tryUrl(entry);
    registerUrl(redactor, entry, label, parsed);
    if (parsed === null || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
      problems.push(`SIP_SOLANA_RPC_URLS entry #${index + 1} is not an http(s) URL: it holds ${shape(entry)}.`);
      return;
    }
    if (seen.has(parsed.href)) {
      warnings.push(`SIP_SOLANA_RPC_URLS entry #${index + 1} repeats an earlier endpoint; it is used once.`);
      return;
    }
    seen.add(parsed.href);
    rpcUrls.push(new Secret(entry, label));
    // WHATWG hostname keeps IPv6 brackets ("[::1]"), which isLoopback expects.
    rpcHosts.push(parsed.hostname);
  });

  // --- the program -------------------------------------------------------------
  const programRaw = trimmed(env["SIP_SOLANA_PROGRAM_ID"]);
  if (programRaw === undefined) {
    problems.push(
      `SIP_SOLANA_PROGRAM_ID is required: the sip-vault program this keeper settles against, ${SIP_PROGRAM_ID} ` +
        "(the exported IDL's address). It has no default, so no keeper is ever pointed at a program by omission.",
    );
  } else if (programRaw === OLD_NUVEM_PROGRAM_ID) {
    // BEFORE ANY OTHER COMPARISON, and in its own words: "does not match the IDL"
    // would be true and would hide the only fact that matters.
    problems.push(
      "SIP_SOLANA_PROGRAM_ID names a retired program. Its upgrade authority key leaked, so whoever holds that " +
        `key can rewrite its logic: SaverFi never talks to it. Set the sip-vault program id, ${SIP_PROGRAM_ID}.`,
    );
  } else if (programRaw !== SIP_PROGRAM_ID) {
    problems.push(
      `SIP_SOLANA_PROGRAM_ID does not match the exported IDL's address (${SIP_PROGRAM_ID}); it holds ${shape(programRaw)}. ` +
        "The keeper decodes accounts and builds instructions from that IDL, so no other program id can be right.",
    );
  }

  // --- cadence, pools ----------------------------------------------------------
  let sweepMs = DEFAULT_SWEEP_MS;
  const sweepRaw = trimmed(env["SIP_SOLANA_SWEEP_MS"]);
  if (sweepRaw !== undefined) {
    const parsed = /^[0-9]+$/.test(sweepRaw) ? Number(sweepRaw) : Number.NaN;
    if (!Number.isSafeInteger(parsed) || parsed < MIN_SWEEP_MS) {
      problems.push(`SIP_SOLANA_SWEEP_MS must be an integer number of milliseconds, at least ${MIN_SWEEP_MS}; it holds ${shape(sweepRaw)}.`);
    } else {
      sweepMs = parsed;
    }
  }
  const pools = parsePools(env["SIP_SOLANA_POOLS"], problems);

  // --- operational credentials: readable in dry run, never logged or served ----
  let alertWebhook: Secret | null = null;
  const webhookRaw = trimmed(env["SIP_SOLANA_ALERT_WEBHOOK"]);
  if (webhookRaw !== undefined) {
    const parsed = tryUrl(webhookRaw);
    registerUrl(redactor, webhookRaw, "alertWebhook", parsed);
    if (parsed === null || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
      problems.push(`SIP_SOLANA_ALERT_WEBHOOK is not an http(s) URL: it holds ${shape(webhookRaw)}.`);
    } else {
      alertWebhook = new Secret(webhookRaw, "alertWebhook");
    }
  }
  // THE ESCALATION LADDER CAN BE POINTED AT NOTHING AND LOOK PERFECT. Armed
  // without a webhook, every critical this keeper can raise — a lost claim, a
  // failed settle, an unbounded seat, an authorization key outside its quorum —
  // becomes a log line in a service nobody is watching. The warning fires at the
  // moment the mistake is made: the deploy after the variable was edited, which
  // is exactly how the variable gets dropped (RAILWAY_SOLANA.md warns the same
  // edit can drop RAILWAY_DOCKERFILE_PATH).
  // TELEGRAM CARRIES THE CHAT IN THE BODY, so the chat id travels in the URL the
  // operator pastes: .../botTOKEN/sendMessage?chat_id=123. The token is the
  // credential and stays inside the Secret; the chat id is public, like a
  // channel name, and is read out here so the body can carry it.
  let alertChatId: string | null = null;
  if (alertWebhook !== null) {
    const url = tryUrl(webhookRaw!);
    if (url !== null && url.hostname === "api.telegram.org") {
      const chat = url.searchParams.get("chat_id")?.trim() ?? "";
      if (chat === "") {
        problems.push(
          "SIP_SOLANA_ALERT_WEBHOOK points at api.telegram.org with no chat_id: Telegram needs the chat in " +
            "the body. Use https://api.telegram.org/bot<token>/sendMessage?chat_id=<id>.",
        );
      } else {
        alertChatId = chat;
      }
    }
  }

  // ONLY WHAT WAKES SOMEBODY LEAVES THE BOX. Warnings stay in the log and in
  // /status, where a resting condition belongs; criticals are the ones a person
  // is asked to act on at three in the morning. The default is the owner's
  // decision, so an unset variable does not quietly widen it.
  let alertMinSeverity: "warn" | "critical" = "critical";
  const severityRaw = trimmed(env["SIP_SOLANA_ALERT_MIN_SEVERITY"])?.toLowerCase();
  if (severityRaw !== undefined) {
    if (severityRaw === "warn" || severityRaw === "critical") alertMinSeverity = severityRaw;
    else problems.push(`SIP_SOLANA_ALERT_MIN_SEVERITY must be "warn" or "critical": it holds ${shape(severityRaw)}.`);
  }

  // Railway sets this itself, so the status button costs no configuration.
  const publicDomain = trimmed(env["RAILWAY_PUBLIC_DOMAIN"]);
  const statusUrl = publicDomain === undefined ? null : `https://${publicDomain}/status`;

  if (armed && alertWebhook === null) {
    warnings.push(
      "Armed with no alert destination (SIP_SOLANA_ALERT_WEBHOOK): every critical stays in this service's " +
        "log, where nothing is watching. Set it to a Discord or Slack webhook and fire a test alert.",
    );
  }

  let databaseUrl: Secret | null = null;
  const databaseRaw = trimmed(env["DATABASE_URL"]);
  if (databaseRaw !== undefined) {
    const parsed = tryUrl(databaseRaw);
    registerUrl(redactor, databaseRaw, "databaseUrl", parsed);
    if (parsed === null || (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:")) {
      problems.push(`DATABASE_URL must be a postgres:// URL; it holds ${shape(databaseRaw)}.`);
    } else if (parsed.port === "6543") {
      // The worker's refusal, for the worker's reason: Supabase's transaction
      // pooler keeps no session, and the single-keeper claim is a SESSION
      // advisory lock. It would appear granted and hold nothing.
      problems.push(
        "DATABASE_URL points at port 6543, the transaction pooler. The single-keeper claim is a session advisory " +
          "lock and does not survive it, so two armed keepers could both act. Use the session pooler on port 5432.",
      );
    } else {
      databaseUrl = new Secret(databaseRaw, "databaseUrl");
    }
  }

  let port: number | null = null;
  const portRaw = trimmed(env["PORT"]);
  if (portRaw !== undefined) {
    const parsed = /^[0-9]+$/.test(portRaw) ? Number(portRaw) : Number.NaN;
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
      problems.push(`PORT must be an integer from 1 to 65535; it holds ${shape(portRaw)}.`);
    } else {
      port = parsed;
    }
  }

  // Public ids. Legible on purpose, like the worker's PRIVY_SIGNER_ID.
  const privyAppId = trimmed(env["SIP_SOLANA_PRIVY_APP_ID"]) ?? null;
  const privySignerId = trimmed(env["SIP_SOLANA_PRIVY_SIGNER_ID"]) ?? null;
  // OPTIONAL, AND NEVER A PROBLEM. Read like its siblings and never pushed onto
  // `problems`: a keeper that would not start without it could not be deployed
  // before the policy exists, and the live service's healthcheck depends on it
  // starting. Absent, the seat check below simply never runs.
  const privyPolicyId = trimmed(env["SIP_SOLANA_PRIVY_POLICY_ID"]) ?? null;

  // --- signing secrets: ONLY when armed ------------------------------------------
  let signing: SigningConfig | null = null;
  if (armed && copied.length === 0) {
    signing = readSigning(env, { privyAppId, rpcHosts, redactor, problems, warnings });
  } else if (!armed) {
    const present = SIGNING_SECRET_VARS.filter((name) => names.includes(name));
    if (present.length > 0) {
      warnings.push(
        `${present.join(", ")}: present in the environment and not read — a dry run holds no signing secret. ` +
          "Arm with SIP_SOLANA_BROADCAST=1 and the exact SIP_SOLANA_ALLOW_BROADCAST sentence.",
      );
    }
  }

  // Scrubbed on the way out. Nothing above interpolates a value — that is the
  // actual rule — and this keeps it true for the next author who forgets.
  const scrub = (text: string): string => redactor.scrub(text);
  if (problems.length > 0) throw new ConfigError(problems.map(scrub));

  const config: KeeperConfig = {
    armed,
    rpcUrls: Object.freeze(rpcUrls),
    programId: SIP_PROGRAM_ID,
    sweepMs,
    pools,
    alertWebhook,
    alertMinSeverity,
    alertChatId,
    statusUrl,
    databaseUrl,
    port,
    privyAppId,
    privySignerId,
    privyPolicyId,
    signing,
    warnings: Object.freeze(warnings.map(scrub)),
  };
  Object.defineProperty(config, "toJSON", { value: () => describeConfig(config), enumerable: false });
  Object.defineProperty(config, Symbol.for("nodejs.util.inspect.custom"), { value: () => describeConfig(config), enumerable: false });
  return Object.freeze(config);
}

function readSigning(
  env: NodeJS.ProcessEnv,
  context: {
    readonly privyAppId: string | null;
    readonly rpcHosts: readonly string[];
    readonly redactor: Redactor;
    readonly problems: string[];
    readonly warnings: string[];
  },
): SigningConfig | null {
  const { redactor, problems, warnings } = context;

  let settleKey: SettleKey | null = null;
  const settleRaw = env["SIP_SOLANA_SETTLE_KEY"];
  if (settleRaw === undefined || settleRaw.trim() === "") {
    problems.push(
      "Going live requires SIP_SOLANA_SETTLE_KEY: the JSON array secret key (the contents of an id.json) of the " +
        "settle wallet, which must be both the attester and the keeper the on-chain ProtocolConfig names.",
    );
  } else {
    redactor.register(settleRaw, "settleKey");
    redactor.register(settleRaw.trim(), "settleKey");
    settleKey = parseSettleKey(settleRaw, redactor);
    if (settleKey === null) {
      problems.push(
        "SIP_SOLANA_SETTLE_KEY is not a JSON array of 64 byte values forming a valid ed25519 secret key " +
          "(the contents of an id.json). Its contents are withheld.",
      );
    }
  }

  const appSecret = trimmed(env["SIP_SOLANA_PRIVY_APP_SECRET"]);
  if (appSecret !== undefined) redactor.register(appSecret, "privyAppSecret");
  const authorizationKey = trimmed(env["SIP_SOLANA_PRIVY_AUTHORIZATION_KEY"]);
  if (authorizationKey !== undefined) registerPrivyAuthorizationKey(redactor, authorizationKey);
  const localDir = trimmed(env["SIP_SOLANA_LOCAL_SIGNERS_DIR"]);
  if (localDir !== undefined) redactor.register(localDir, "localSignersDir");

  // ALL THREE OR NONE. A half-configured Privy route is always a mistake, and it
  // is invisible until the first settle is refused.
  const parts: [string, boolean][] = [
    ["SIP_SOLANA_PRIVY_APP_ID", context.privyAppId !== null],
    ["SIP_SOLANA_PRIVY_APP_SECRET", appSecret !== undefined],
    ["SIP_SOLANA_PRIVY_AUTHORIZATION_KEY", authorizationKey !== undefined],
  ];
  const have = parts.filter(([, present]) => present).map(([name]) => name);
  const missing = parts.filter(([, present]) => !present).map(([name]) => name);
  let privy: PrivySigningConfig | null = null;
  if (missing.length === 0) {
    privy = Object.freeze({
      appId: context.privyAppId!,
      appSecret: new Secret(appSecret!, "privyAppSecret"),
      authorizationKey: new Secret(authorizationKey!, "privyAuthorizationKey"),
    });
  } else if (have.length > 0) {
    problems.push(
      `Privy signing is half-configured: ${missing.join(", ")} missing while ${have.join(", ")} set. All three are ` +
        "needed to sign as a trading wallet; set the rest, or remove them all.",
    );
  }

  let localSignersDir: Secret | null = null;
  if (localDir !== undefined) {
    // LOCALNET ONLY. Per-wallet keypair files on a keeper talking to a real
    // cluster are exactly the keys this design keeps off the box; Privy is the
    // route there.
    if (context.rpcHosts.some((host) => !isLoopback(host))) {
      problems.push(
        "SIP_SOLANA_LOCAL_SIGNERS_DIR is for localnet only, but SIP_SOLANA_RPC_URLS lists a non-loopback endpoint. " +
          "Against a real cluster the keeper signs as a trading wallet through Privy, never from key files.",
      );
    } else {
      localSignersDir = new Secret(localDir, "localSignersDir");
    }
  }

  if (privy === null && localDir === undefined && missing.length === parts.length) {
    warnings.push(
      "Armed with no wallet signing route (neither the SIP_SOLANA_PRIVY_* trio nor SIP_SOLANA_LOCAL_SIGNERS_DIR): " +
        "every settle will report NO_SIGNER. Investing needs no wallet signature and still runs.",
    );
  }

  if (settleKey === null) return null;
  return Object.freeze({ settleKey, privy, localSignersDir });
}
