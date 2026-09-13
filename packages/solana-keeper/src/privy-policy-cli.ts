// The flows behind bin/privy-policy.mts: print, create, check and verify.
//
// THE PRIVY CALLS ARE BEHIND AN INTERFACE (PrivyPolicyClient, ProbeChain) so the
// flows run against a fake in test/privy-policy-cli.test.ts with no network,
// and the bin wires the real SDK in src/privy-policy-client.ts. This file
// decides; that one only translates.
//
// TWO STREAMS. Results go to stdout as JSON lines through the keeper's logger —
// create's ids, check's verdict, verify's probes — so they can be piped and
// read. Refusals, progress and failures go to stderr through the same logger.
// Both scrub against one redactor, and every secret this command reads is
// registered with it before the first line of either.
//
// EXIT CODES, the keeper's convention: 0 the thing asked for is true; 1 it is
// not, or Privy could not be read; 2 "you have to change something" — an
// argument, a variable, a path — and nothing was sent anywhere.

import { statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { Redactor, Secret, sharedRedactor, summarizeUpstreamError, type Logger } from "@sip/worker/log";
import { ConfigError, copiedConfigProblems, loadConfig, privySdkOverrideProblems, registerPrivyAuthorizationKey, shape } from "./config.js";
import { OLD_NUVEM_PROGRAM_ID, SIP_PROGRAM_ID } from "./idl.js";
import { createKeeperLogger } from "./keeper-log.js";
import {
  ADMIN_KEY_QUORUM_NAME,
  AdminKeyFileError,
  PROBE_MESSAGE,
  allowedPrograms,
  buildKeeperPolicy,
  buildMemoProbe,
  buildSelfTransferProbe,
  classifyPrivyError,
  diffPolicy,
  isP256Pkcs8PrivateKey,
  privyErrorCode,
  privyErrorStatus,
  writeAdminKeyFile,
  type KeeperPolicy,
  type PolicyLike,
  type PrivyErrorClass,
} from "./privy-policy.js";
import { SOLANA_MAINNET_CAIP2 } from "./privy-signer.js";

export interface WalletSignerLike {
  readonly signer_id: string;
  readonly override_policy_ids?: readonly string[];
}

/** A Privy wallet as `verify` needs it. The SDK's Wallet is assignable to it. */
export interface WalletLike {
  readonly id: string;
  readonly address: string;
  readonly chain_type: string;
  readonly additional_signers: readonly WalletSignerLike[];
  readonly policy_ids: readonly string[];
}

/** Every Privy call the command makes, and nothing else. */
export interface PrivyPolicyClient {
  createKeyQuorum(input: { readonly publicKey: string; readonly displayName: string }): Promise<{ readonly id: string }>;
  createPolicy(policy: KeeperPolicy, ownerId: string): Promise<PolicyLike & { readonly id: string }>;
  getPolicy(policyId: string): Promise<PolicyLike>;
  getWallet(walletId: string): Promise<WalletLike>;
  /** Signs as the wallet with the keeper signer's authorization key. */
  signMessage(walletId: string, message: Uint8Array, authorizationKey: Secret): Promise<{ readonly signature: string }>;
  /** Signs and broadcasts on mainnet-beta with the keeper signer's authorization key. */
  signAndSendTransaction(walletId: string, transaction: Uint8Array, authorizationKey: Secret): Promise<{ readonly hash: string }>;
}

/** The three chain reads `verify` makes before it probes. */
export interface ProbeChain {
  genesisHash(): Promise<string>;
  latestBlockhash(): Promise<string>;
  balanceLamports(address: string): Promise<number>;
}

export interface PrivyPolicyCliDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  /** Defaults to the shared redactor, which the console bridge also scrubs with. */
  readonly redactor?: Redactor;
  readonly client: (credentials: { readonly appId: string; readonly appSecret: Secret }) => PrivyPolicyClient;
  readonly chain: (rpcUrls: readonly Secret[]) => ProbeChain;
  readonly generateKeyPair: () => Promise<{ readonly publicKey: string; readonly privateKey: string }>;
  /** create refuses to write the admin key under this directory. */
  readonly repoRoot: string;
}

export const USAGE = [
  "privy-policy --print",
  "privy-policy create --admin-key-out <absolute path outside the repository, e.g. ~/sip-keys/privy-policy-admin.key>",
  "privy-policy check --policy <policy id>",
  "privy-policy verify --wallet <privy wallet id> --policy <policy id>",
] as const;

/** Below this, a probe's simulation will most likely fail on rent or fees and prove nothing. */
export const MIN_PROBE_LAMPORTS = 1_000_000;

type Command = "create" | "check" | "verify";

const FLAGS: Readonly<Record<Command, readonly string[]>> = {
  create: ["--admin-key-out"],
  check: ["--policy"],
  verify: ["--wallet", "--policy"],
};

/** What each variable is, for a refusal that has to say what to set. */
const PURPOSE: Readonly<Record<string, string>> = {
  SIP_SOLANA_PRIVY_APP_ID: "the SIP Privy app's id (not Nuvem's app)",
  SIP_SOLANA_PRIVY_APP_SECRET: "the SIP Privy app's secret, loaded for this one command and never written to a file",
  SIP_SOLANA_PRIVY_AUTHORIZATION_KEY: "the keeper signer's private authorization key, from the password manager",
  SIP_SOLANA_PRIVY_SIGNER_ID: "the keeper signer's key quorum id",
  SIP_SOLANA_RPC_URLS: "one or more Solana mainnet-beta JSON-RPC endpoints, comma-separated, to read a recent blockhash",
};

const NEEDS: Readonly<Record<Command, readonly string[]>> = {
  create: ["SIP_SOLANA_PRIVY_APP_ID", "SIP_SOLANA_PRIVY_APP_SECRET"],
  check: ["SIP_SOLANA_PRIVY_APP_ID", "SIP_SOLANA_PRIVY_APP_SECRET"],
  verify: [
    "SIP_SOLANA_PRIVY_APP_ID",
    "SIP_SOLANA_PRIVY_APP_SECRET",
    "SIP_SOLANA_PRIVY_AUTHORIZATION_KEY",
    "SIP_SOLANA_PRIVY_SIGNER_ID",
    "SIP_SOLANA_RPC_URLS",
  ],
};

const ID_SHAPE = /^[A-Za-z0-9_-]{1,128}$/;

type Parsed =
  | { readonly kind: "print" }
  | { readonly kind: Command; readonly flags: ReadonlyMap<string, string> }
  | { readonly kind: "refused"; readonly problems: readonly string[] };

/** Strict: an unknown or repeated flag is refused, because a misspelt flag is one that silently does nothing. */
export function parseArguments(argv: readonly string[]): Parsed {
  // pnpm forwards a literal "--" when one is typed before the arguments.
  const args = argv[0] === "--" ? argv.slice(1) : [...argv];
  if (args.length === 1 && args[0] === "--print") return { kind: "print" };
  const [command, ...rest] = args;
  if (command === undefined || !(command in FLAGS)) {
    return { kind: "refused", problems: [`expected one of: ${USAGE.join(" | ")}`] };
  }
  const known = FLAGS[command as Command];
  const flags = new Map<string, string>();
  const problems: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]!;
    if (!token.startsWith("--")) {
      problems.push(`unexpected argument #${i + 2}: ${command} takes only ${known.join(" and ")}`);
      continue;
    }
    const equals = token.indexOf("=");
    const name = equals < 0 ? token : token.slice(0, equals);
    let value: string | undefined;
    if (equals >= 0) {
      value = token.slice(equals + 1);
    } else if (rest[i + 1] !== undefined && !rest[i + 1]!.startsWith("--")) {
      value = rest[i + 1];
      i += 1;
    }
    if (!known.includes(name)) {
      problems.push(`${name} is not an option of ${command}; it takes ${known.join(" and ")}`);
    } else if (flags.has(name)) {
      problems.push(`${name} is given twice`);
    } else if (value === undefined || value.trim() === "") {
      problems.push(`${name} needs a value`);
    } else {
      flags.set(name, value.trim());
    }
  }
  for (const name of known) if (!flags.has(name) && !problems.some((problem) => problem.startsWith(name))) problems.push(`${command} requires ${name}`);
  for (const name of ["--policy", "--wallet"]) {
    const value = flags.get(name);
    if (value !== undefined && !ID_SHAPE.test(value)) problems.push(`${name} is not a Privy id: it holds ${shape(value)}`);
  }
  return problems.length > 0 ? { kind: "refused", problems } : { kind: command as Command, flags };
}

interface CommandEnv {
  readonly appId: string;
  readonly appSecret: Secret;
  readonly signerId: string | null;
  readonly authorizationKey: Secret | null;
  readonly rpcUrls: readonly Secret[];
}

const trimmed = (value: string | undefined): string | undefined => {
  const out = value?.trim();
  return out === undefined || out === "" ? undefined : out;
};

/**
 * Reads exactly the variables `command` uses, registering every secret before
 * anything can be printed, and answers with a config or the problems.
 *
 * NOTHING HERE PUTS A VALUE IN A PROBLEM. Missing variables are named with what
 * they are for; malformed ones are described by shape or by the rule they
 * break. The RPC list goes through the keeper's own loadConfig, so it is parsed,
 * refused and registered exactly as the keeper does it.
 */
function readCommandEnv(
  command: Command,
  env: NodeJS.ProcessEnv,
  redactor: Redactor,
): { readonly config: CommandEnv } | { readonly missing: readonly string[]; readonly problems: readonly string[] } {
  const needs = NEEDS[command];

  // --- secrets first: registered before any line can be written --------------
  const appSecretRaw = env["SIP_SOLANA_PRIVY_APP_SECRET"];
  const appSecret = trimmed(appSecretRaw);
  if (appSecretRaw !== undefined && appSecretRaw !== "") redactor.register(appSecretRaw, "privyAppSecret");
  if (appSecret !== undefined) redactor.register(appSecret, "privyAppSecret");

  let authorizationKey: string | undefined;
  let rpcRaw: string | undefined;
  if (command === "verify") {
    const raw = env["SIP_SOLANA_PRIVY_AUTHORIZATION_KEY"];
    authorizationKey = trimmed(raw);
    if (raw !== undefined && raw !== "") registerPrivyAuthorizationKey(redactor, raw);
    if (authorizationKey !== undefined) registerPrivyAuthorizationKey(redactor, authorizationKey);
    rpcRaw = env["SIP_SOLANA_RPC_URLS"];
  }
  const problems: string[] = [];
  let rpcUrls: readonly Secret[] = [];
  if (trimmed(rpcRaw) !== undefined) {
    try {
      rpcUrls = loadConfig({ SIP_SOLANA_RPC_URLS: rpcRaw, SIP_SOLANA_PROGRAM_ID: SIP_PROGRAM_ID }, redactor).rpcUrls;
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      problems.push(...error.problems);
    }
  }

  // --- names only: Nuvem's configuration and the Privy SDK's overrides ----------
  // PRIVY_API_BASE_URL would send the app secret elsewhere, PRIVY_API_LOG would
  // log requests, PRIVY_API_CUSTOM_HEADERS would add headers no option removes.
  const names = Object.keys(env);
  problems.unshift(...copiedConfigProblems(names), ...privySdkOverrideProblems(names));

  const appId = trimmed(env["SIP_SOLANA_PRIVY_APP_ID"]);
  const signerId = trimmed(env["SIP_SOLANA_PRIVY_SIGNER_ID"]);
  const present: Readonly<Record<string, boolean>> = {
    SIP_SOLANA_PRIVY_APP_ID: appId !== undefined,
    SIP_SOLANA_PRIVY_APP_SECRET: appSecret !== undefined,
    SIP_SOLANA_PRIVY_AUTHORIZATION_KEY: authorizationKey !== undefined,
    SIP_SOLANA_PRIVY_SIGNER_ID: signerId !== undefined,
    SIP_SOLANA_RPC_URLS: trimmed(rpcRaw) !== undefined,
  };
  const missing = needs.filter((name) => !present[name]);
  for (const name of missing) problems.push(`${name} is required for ${command}: ${PURPOSE[name]}.`);

  if (appId !== undefined && /\s/.test(appId)) {
    problems.push(`SIP_SOLANA_PRIVY_APP_ID is not an app id: it holds ${shape(appId)}.`);
  }
  if (signerId !== undefined && !ID_SHAPE.test(signerId)) {
    problems.push(`SIP_SOLANA_PRIVY_SIGNER_ID is not a key quorum id: it holds ${shape(signerId)}.`);
  }
  if (authorizationKey !== undefined && !isP256Pkcs8PrivateKey(authorizationKey.replace(/^wallet-auth:/, ""))) {
    problems.push(
      "SIP_SOLANA_PRIVY_AUTHORIZATION_KEY is not a P-256 private key in base64 PKCS8 (the dashboard shows it once, " +
        "starting with wallet-auth:). Its value is withheld.",
    );
  }
  const programRaw = trimmed(env["SIP_SOLANA_PROGRAM_ID"]);
  if (programRaw === OLD_NUVEM_PROGRAM_ID) {
    problems.push(
      "SIP_SOLANA_PROGRAM_ID names Nuvem's old program. Its upgrade authority key leaked, so SIP never talks to it; " +
        `the policy allows only the sip-vault program, ${SIP_PROGRAM_ID}.`,
    );
  } else if (programRaw !== undefined && programRaw !== SIP_PROGRAM_ID) {
    problems.push(
      `SIP_SOLANA_PROGRAM_ID does not match the exported IDL's address (${SIP_PROGRAM_ID}); it holds ${shape(programRaw)}. ` +
        "The policy is built from the IDL, so an environment pointing elsewhere is a mistake to fix first.",
    );
  }

  if (problems.length > 0) return { missing, problems: problems.map((problem) => redactor.scrub(problem)) };
  return {
    config: {
      appId: appId!,
      appSecret: new Secret(appSecret!, "privyAppSecret"),
      signerId: signerId ?? null,
      authorizationKey: authorizationKey === undefined ? null : new Secret(authorizationKey, "privyAuthorizationKey"),
      rpcUrls,
    },
  };
}

/** Fields that describe a Privy failure without quoting anything unscrubbed. */
function failureFields(error: unknown, redactor: Redactor): Record<string, unknown> {
  return {
    class: classifyPrivyError(error),
    status: privyErrorStatus(error),
    code: privyErrorCode(error),
    detail: summarizeUpstreamError(error, { redactor, take: 3, maxChars: 400 }),
  };
}

export async function runPrivyPolicyCli(argv: readonly string[], deps: PrivyPolicyCliDeps): Promise<number> {
  const redactor = deps.redactor ?? sharedRedactor;
  const out = createKeeperLogger({ sink: deps.stdout, redactor });
  const diag = createKeeperLogger({ sink: deps.stderr, redactor });

  const parsed = parseArguments(argv);
  if (parsed.kind === "refused") {
    diag.error("arguments refused", { problems: parsed.problems, usage: USAGE });
    return 2;
  }
  if (parsed.kind === "print") {
    // No environment, no network, no key: the document and nothing else.
    const policy = buildKeeperPolicy(SIP_PROGRAM_ID);
    out.info("privy policy", { policy, programs: allowedPrograms(policy) });
    return 0;
  }

  const read = readCommandEnv(parsed.kind, deps.env, redactor);
  if (!("config" in read)) {
    diag.error("configuration refused", { command: parsed.kind, missing: read.missing, problems: read.problems });
    return 2;
  }
  try {
    switch (parsed.kind) {
      case "create":
        return await create(parsed.flags.get("--admin-key-out")!, read.config, deps, { out, diag, redactor });
      case "check":
        return await check(parsed.flags.get("--policy")!, read.config, deps, { out, diag, redactor });
      case "verify":
        return await verify(parsed.flags.get("--wallet")!, parsed.flags.get("--policy")!, read.config, deps, { out, diag, redactor });
    }
  } catch (error) {
    diag.error("privy-policy failed", { command: parsed.kind, detail: summarizeUpstreamError(error, { redactor, take: 3, maxChars: 400 }) });
    return 1;
  }
}

interface Io {
  readonly out: Logger;
  readonly diag: Logger;
  readonly redactor: Redactor;
}

// --- create ------------------------------------------------------------------------

/**
 * Whether a create request that threw may still have created its object.
 *
 * ONLY ANOTHER 4XX PROVES IT DID NOT. No answer at all, a timeout (408), a lock
 * conflict (409), a rate limit (429) or a server error (5xx) can each come from
 * a layer that does not know whether Privy acted — a gateway's 504 says nothing
 * about the server behind it — so all of them may have landed. The real client
 * makes exactly one attempt (src/privy-policy-client.ts), so at most one such
 * object exists.
 */
export function mayHaveLanded(error: unknown): boolean {
  const status = privyErrorStatus(error);
  return status === null || status === 408 || status === 409 || status === 429 || status >= 500;
}

/**
 * Admin key → key file → key quorum → policy, in that order, each step only
 * after the one before it is known to exist.
 *
 * THE KEY FILE COMES FIRST so that no object at Privy is ever owned by a key
 * that was not safely on disk. A failure afterwards is reported as the list of
 * what exists, what does not, and what cannot be known (mayHaveLanded), because
 * the next step depends on exactly that.
 */
async function create(rawPath: string, config: CommandEnv, deps: PrivyPolicyCliDeps, { out, diag, redactor }: Io): Promise<number> {
  const path = rawPath === "~" ? homedir() : rawPath.startsWith("~/") ? join(homedir(), rawPath.slice(2)) : rawPath;
  if (!isAbsolute(path)) {
    diag.error("configuration refused", {
      command: "create",
      problems: [
        "--admin-key-out must be an absolute path, e.g. ~/sip-keys/privy-policy-admin.key: a relative one resolves against " +
          "packages/solana-keeper, inside the repository.",
      ],
    });
    return 2;
  }

  const policy = buildKeeperPolicy(SIP_PROGRAM_ID);
  const programs = allowedPrograms(policy);
  const pair = await deps.generateKeyPair();
  // Registered before it exists anywhere else, so no line can ever carry it.
  redactor.register(pair.privateKey, "policyAdminKey");

  let adminKeyFile: string;
  try {
    adminKeyFile = writeAdminKeyFile(path, pair.privateKey, { repoRoot: deps.repoRoot }).path;
  } catch (error) {
    if (!(error instanceof AdminKeyFileError)) throw error;
    diag.error("admin key file refused", {
      reason: error.reason,
      detail: error.message,
      exists: {},
      doesNotExist: ["admin key file", "admin key quorum", "policy"],
    });
    return error.reason === "WRITE_FAILED" || error.reason === "NOT_A_KEY" ? 1 : 2;
  }
  diag.info("admin key written", { adminKeyFile, mode: "0600" });
  try {
    if ((statSync(dirname(adminKeyFile)).mode & 0o077) !== 0) {
      diag.warn("the admin key's directory is readable by other users", { directory: dirname(adminKeyFile), fix: "chmod 700 on it" });
    }
  } catch {
    // The file was just written there; a failed stat only loses the warning.
  }

  const client = deps.client({ appId: config.appId, appSecret: config.appSecret });

  let adminKeyQuorumId: string;
  try {
    adminKeyQuorumId = (await client.createKeyQuorum({ publicKey: pair.publicKey, displayName: ADMIN_KEY_QUORUM_NAME })).id;
  } catch (error) {
    const unknown = mayHaveLanded(error);
    diag.error("privy policy create incomplete", {
      failedStep: "register the admin key quorum",
      ...failureFields(error, redactor),
      exists: { adminKeyFile },
      doesNotExist: unknown ? ["policy"] : ["admin key quorum", "policy"],
      unknown: unknown ? [`admin key quorum ${ADMIN_KEY_QUORUM_NAME}: no answer or a server error, so it may have landed`] : [],
      next: unknown
        ? `Look for a key quorum named ${ADMIN_KEY_QUORUM_NAME} created just now in the dashboard (Authorization keys). ` +
          "It would trust this file's key and own nothing. Either way, run create again with a new --admin-key-out."
        : "Nothing exists at Privy. This file's key is trusted by nothing: set it aside and run create again with a new --admin-key-out.",
    });
    return 1;
  }
  diag.info("admin key quorum registered", { adminKeyQuorumId, name: ADMIN_KEY_QUORUM_NAME });

  let created: PolicyLike & { readonly id: string };
  try {
    created = await client.createPolicy(policy, adminKeyQuorumId);
  } catch (error) {
    const unknown = mayHaveLanded(error);
    diag.error("privy policy create incomplete", {
      failedStep: "create the policy",
      ...failureFields(error, redactor),
      exists: { adminKeyFile, adminKeyQuorumId },
      doesNotExist: unknown ? [] : ["policy"],
      unknown: unknown ? ["policy: no answer or a server error, so it may have landed"] : [],
      next: unknown
        ? `Look in the dashboard's Policies for "${policy.name}" owned by ${adminKeyQuorumId}. If it is there, its id is the ` +
          "policy id and this file is its admin key: run check on it. If not, run create again with a new --admin-key-out."
        : `The key quorum ${adminKeyQuorumId} exists and owns nothing. Run create again with a new --admin-key-out; the ` +
          "unused quorum can be removed in the dashboard and this file set aside.",
    });
    return 1;
  }

  out.info("privy policy created", { policyId: created.id, adminKeyQuorumId, programs, adminKeyFile });

  // What Privy stored, not what was sent: the id is only worth handing to the web if the two agree.
  const stored = diffPolicy(policy, created);
  if (!stored.identical || stored.ownerId !== adminKeyQuorumId) {
    diag.error("privy stored a different policy than the one sent", {
      policyId: created.id,
      differences: stored.differences,
      ownerId: stored.ownerId,
      expectedOwnerId: adminKeyQuorumId,
      next: "Do not give this policy id to the web. Run check on it and compare with --print.",
    });
    return 1;
  }
  return 0;
}

// --- check -------------------------------------------------------------------------

async function check(policyId: string, config: CommandEnv, deps: PrivyPolicyCliDeps, { out, diag, redactor }: Io): Promise<number> {
  const client = deps.client({ appId: config.appId, appSecret: config.appSecret });
  let stored: PolicyLike;
  try {
    stored = await client.getPolicy(policyId);
  } catch (error) {
    diag.error("privy policy not read", { policyId, ...failureFields(error, redactor) });
    return 1;
  }
  const expected = buildKeeperPolicy(SIP_PROGRAM_ID);
  const diff = diffPolicy(expected, stored, { signerId: config.signerId });
  if (config.signerId === null) {
    diag.warn("owner not compared with the keeper's signer", {
      detail: "SIP_SOLANA_PRIVY_SIGNER_ID is not set, so a policy owned by the key it bounds would still pass. Set it to check that too.",
    });
  }
  const verdict = !diff.identical ? "DIFFERENT" : !diff.owned ? "UNOWNED" : diff.ownerIsSigner ? "OWNED_BY_SIGNER" : "OK";
  out[diff.ok ? "info" : "error"]("privy policy check", {
    policyId,
    verdict,
    identical: diff.identical,
    owned: diff.owned,
    ownerId: diff.ownerId,
    ownerIsSigner: diff.ownerIsSigner,
    signerCompared: config.signerId !== null,
    differences: diff.differences,
    ownershipProblems: diff.ownershipProblems,
    programs: allowedPrograms(expected),
  });
  return diff.ok ? 0 : 1;
}

// --- verify ------------------------------------------------------------------------

type ProbeOutcome = "REFUSED" | "CRITICAL" | "INCONCLUSIVE" | "UNAUTHORIZED" | "FAILED";

const OUTCOME_FOR: Readonly<Record<PrivyErrorClass, ProbeOutcome>> = {
  POLICY_VIOLATION: "REFUSED",
  SIMULATION_FAILED: "INCONCLUSIVE",
  AUTHORIZATION: "UNAUTHORIZED",
  OTHER: "FAILED",
};

const MEANING: Readonly<Record<ProbeOutcome, string>> = {
  REFUSED: "Privy answered policy_violation: the policy refused it, as it must.",
  CRITICAL:
    "Privy SIGNED what the policy must refuse: the keeper's signer is NOT bounded. Stop: remove the signer from the " +
    "wallets, or rotate its key, before anything else.",
  INCONCLUSIVE:
    "Privy's simulation failed before the policy was evaluated (usually an unfunded wallet). This proves nothing either " +
    "way: fund the wallet with about 0.002 SOL and run verify again.",
  UNAUTHORIZED:
    "Privy refused the request's credentials before the policy: the authorization key is not this signer's, or the app " +
    "id or secret is wrong. This proves nothing about the policy.",
  FAILED: "An unexpected failure. This proves nothing about the policy.",
};

const LEVEL: Readonly<Record<ProbeOutcome, "info" | "warn" | "error">> = {
  REFUSED: "info",
  CRITICAL: "error",
  INCONCLUSIVE: "warn",
  UNAUTHORIZED: "error",
  FAILED: "error",
};

/**
 * Proves the bound by trying to cross it, as the keeper's signer, on a real wallet.
 *
 * FIRST THE GRANT: the signer must be on the wallet with exactly this policy as
 * its override, or a refusal would prove a different configuration than the
 * one the keeper runs under — and no probe is sent.
 *
 * THEN THREE PROBES, each of which the policy must refuse and each harmless if
 * it does not: a bare message, a 1-lamport transfer to self, a memo. Only
 * POLICY_VIOLATION counts. A success is CRITICAL and prints what Privy returned;
 * a simulation failure is INCONCLUSIVE and never a pass.
 */
async function verify(walletId: string, policyId: string, config: CommandEnv, deps: PrivyPolicyCliDeps, { out, diag, redactor }: Io): Promise<number> {
  const signerId = config.signerId!;
  const authorizationKey = config.authorizationKey!;
  const client = deps.client({ appId: config.appId, appSecret: config.appSecret });

  let wallet: WalletLike;
  try {
    wallet = await client.getWallet(walletId);
  } catch (error) {
    diag.error("privy wallet not read", { walletId, ...failureFields(error, redactor) });
    return 1;
  }
  if (wallet.chain_type !== "solana") {
    out.error("privy verify", { walletId, verdict: "NOT_A_SOLANA_WALLET", chainType: wallet.chain_type });
    return 1;
  }
  const grants = wallet.additional_signers.filter((signer) => signer.signer_id === signerId);
  if (grants.length === 0) {
    out.error("privy verify", {
      walletId,
      address: wallet.address,
      verdict: "SIGNER_NOT_GRANTED",
      signerId,
      granted: wallet.additional_signers.map((signer) => signer.signer_id),
      detail: "The keeper's signer is not on this wallet, so nothing was probed. The web registers it with addSigners.",
    });
    return 1;
  }
  const exact = (ids: readonly string[] | undefined): boolean => ids !== undefined && ids.length === 1 && ids[0] === policyId;
  if (!grants.every((grant) => exact(grant.override_policy_ids))) {
    out.error("privy verify", {
      walletId,
      address: wallet.address,
      verdict: "OVERRIDE_POLICY_MISMATCH",
      signerId,
      overridePolicyIds: grants.map((grant) => grant.override_policy_ids ?? []),
      expected: [policyId],
      detail:
        "The signer is on the wallet but not bound by exactly this policy, so nothing was probed: a refusal would prove a " +
        "configuration the keeper does not run under.",
    });
    return 1;
  }
  diag.info("signer granted with the override policy", { walletId, address: wallet.address, signerId, overridePolicyIds: [policyId] });
  if (wallet.policy_ids.includes(policyId)) {
    diag.warn("the policy is also attached at the wallet level", {
      walletId,
      detail: "Wallet-level policy_ids bind the user too and would block their export to Axiom; attach it only as the signer's override.",
    });
  }

  const chain = deps.chain(config.rpcUrls);
  let recentBlockhash: string;
  try {
    const genesis = await chain.genesisHash();
    const reference = SOLANA_MAINNET_CAIP2.split(":")[1]!;
    if (!genesis.startsWith(reference)) {
      diag.error("configuration refused", {
        command: "verify",
        problems: [
          "SIP_SOLANA_RPC_URLS answers for a cluster that is not mainnet-beta. Privy simulates the probes on mainnet-beta, " +
            "so a blockhash from another cluster would make every transaction probe INCONCLUSIVE.",
        ],
      });
      return 2;
    }
    recentBlockhash = await chain.latestBlockhash();
  } catch (error) {
    diag.error("solana endpoint not read", { detail: summarizeUpstreamError(error, { redactor }) });
    return 1;
  }
  try {
    const lamports = await chain.balanceLamports(wallet.address);
    if (lamports < MIN_PROBE_LAMPORTS) {
      diag.warn("the wallet is probably too poor for the transaction probes to simulate", {
        address: wallet.address,
        lamports,
        detail: "Expect INCONCLUSIVE for the two transaction probes. Fund it with about 0.002 SOL.",
      });
    }
  } catch (error) {
    diag.warn("wallet balance not read", { address: wallet.address, detail: summarizeUpstreamError(error, { redactor }) });
  }

  const probes: readonly { readonly name: string; readonly run: () => Promise<Record<string, string>> }[] = [
    {
      name: "signMessage",
      run: async () => ({
        signature: (await client.signMessage(walletId, new TextEncoder().encode(PROBE_MESSAGE), authorizationKey)).signature,
      }),
    },
    {
      name: "selfTransfer",
      run: async () => ({
        hash: (await client.signAndSendTransaction(walletId, buildSelfTransferProbe(wallet.address, recentBlockhash), authorizationKey)).hash,
      }),
    },
    {
      name: "memo",
      run: async () => ({
        hash: (await client.signAndSendTransaction(walletId, buildMemoProbe(wallet.address, recentBlockhash), authorizationKey)).hash,
      }),
    },
  ];

  const outcomes: Record<string, ProbeOutcome> = {};
  for (const probe of probes) {
    try {
      const returned = await probe.run();
      outcomes[probe.name] = "CRITICAL";
      out.error("privy probe", { probe: probe.name, outcome: "CRITICAL", ...returned, meaning: MEANING.CRITICAL });
    } catch (error) {
      const outcome = OUTCOME_FOR[classifyPrivyError(error)];
      outcomes[probe.name] = outcome;
      out[LEVEL[outcome]]("privy probe", { probe: probe.name, outcome, ...failureFields(error, redactor), meaning: MEANING[outcome] });
    }
  }

  out.info("old program", {
    program: OLD_NUVEM_PROGRAM_ID,
    excluded: true,
    detail:
      "Not in the allowlist, which names only sip-vault and Ed25519SigVerify, so a transaction with any " +
      "instruction for it is denied; check proves the allowlist. It is not probed: Privy simulates before it evaluates " +
      "the policy, so a refusal probe has to be a call that would succeed, and SIP builds no successful call into a " +
      "program whose upgrade key leaked. A failing one would stop at simulation and prove nothing.",
  });

  const all = Object.values(outcomes);
  const verdict = all.every((outcome) => outcome === "REFUSED")
    ? "PASS"
    : all.includes("CRITICAL")
      ? "CRITICAL"
      : all.includes("INCONCLUSIVE")
        ? "INCONCLUSIVE"
        : "FAILED";
  out[verdict === "PASS" ? "info" : verdict === "INCONCLUSIVE" ? "warn" : "error"]("privy verify", {
    walletId,
    address: wallet.address,
    policyId,
    signerId,
    verdict,
    probes: outcomes,
  });
  return verdict === "PASS" ? 0 : 1;
}
