// bin/privy-policy.mts's flows against a fake Privy and a fake chain.
//
// runPrivyPolicyCli is the whole command but the SDK: the same argument parser,
// environment reading, redactor and loggers the bin runs, with the Privy calls
// and the three chain reads behind the interfaces it declares. So create is
// driven to the disk and back, check through each verdict, and verify through
// every probe outcome, with no network and no credential. Every line both
// streams carry is parsed, and the last block throws the secrets at the output
// the way a real failure would.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APIConnectionError,
  APIError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  NotFoundError,
  generateP256KeyPair,
} from "@privy-io/node";
import { Keypair, SystemInstruction, SystemProgram, Transaction } from "@solana/web3.js";
import { Redactor, type Secret } from "@sip/solana-log";
import { afterAll, describe, expect, it } from "vitest";
import { OLD_NUVEM_PROGRAM_ID, SIP_PROGRAM_ID } from "../src/idl.js";
import { SERVICE } from "../src/keeper-log.js";
import { runPrivyPolicyCli, type PrivyPolicyClient, type ProbeChain, type WalletLike } from "../src/privy-policy-cli.js";
import { MEMO_PROGRAM_ID, PROBE_MESSAGE, allowedPrograms, buildKeeperPolicy, type KeeperPolicy, type PolicyLike } from "../src/privy-policy.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sip-privy-policy-cli-")));
const repo = join(root, "repo");
const keys = join(root, "keys");
mkdirSync(join(repo, "packages"), { recursive: true });
mkdirSync(keys, { mode: 0o700 });
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Throwaway: generated per run, registered nowhere, never used against Privy. */
const signerPair = await generateP256KeyPair();
const APP_ID = "sipprivyapp0000000000000001";
const APP_SECRET = "privy-app-secret-NeverPrinted-0005";
const AUTH_KEY = `wallet-auth:${signerPair.privateKey}`;
const SIGNER_ID = "keeperSignerQuorum0001";
const ADMIN_QUORUM_ID = "adminQuorum0000000000001";
const POLICY_ID = "keeperPolicy000000000001";
const WALLET_ID = "tradingWallet00000000001";
const ADDRESS = Keypair.generate().publicKey.toBase58();
const BLOCKHASH = Keypair.generate().publicKey.toBase58();
const RPC = "https://mainnet.helius-rpc.example.test/?api-key=HeliusKeyNeverPrinted0005";
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

const privyEnv: NodeJS.ProcessEnv = { SIP_SOLANA_PRIVY_APP_ID: APP_ID, SIP_SOLANA_PRIVY_APP_SECRET: APP_SECRET };
const verifyEnv: NodeJS.ProcessEnv = {
  ...privyEnv,
  SIP_SOLANA_PRIVY_AUTHORIZATION_KEY: AUTH_KEY,
  SIP_SOLANA_PRIVY_SIGNER_ID: SIGNER_ID,
  SIP_SOLANA_RPC_URLS: RPC,
};

const headers = new Headers();
const policyViolation = (): Error => new BadRequestError(400, { error: "Policy violation", code: "policy_violation" }, undefined, headers);
const simulationFailed = (): Error =>
  new BadRequestError(400, { error: "Transaction simulation failed: Attempt to debit an account but found no record of a prior credit." }, undefined, headers);

function storedPolicy(policy: KeeperPolicy, over: Partial<PolicyLike> = {}): PolicyLike & { id: string } {
  return { id: POLICY_ID, owner_id: ADMIN_QUORUM_ID, ...(JSON.parse(JSON.stringify(policy)) as KeeperPolicy), ...over };
}

const grantedWallet = (over: Partial<WalletLike> = {}): WalletLike => ({
  id: WALLET_ID,
  address: ADDRESS,
  chain_type: "solana",
  policy_ids: [],
  additional_signers: [{ signer_id: SIGNER_ID, override_policy_ids: [POLICY_ID] }],
  ...over,
});

interface Behaviour {
  readonly createKeyQuorum?: () => Promise<{ id: string }>;
  readonly createPolicy?: (policy: KeeperPolicy, ownerId: string) => Promise<PolicyLike & { id: string }>;
  readonly getPolicy?: () => Promise<PolicyLike>;
  readonly getWallet?: () => Promise<WalletLike>;
  readonly signMessage?: () => Promise<{ signature: string }>;
  readonly selfTransfer?: () => Promise<{ hash: string }>;
  readonly memo?: () => Promise<{ hash: string }>;
}

interface Recorded {
  readonly credentials: { appId: string; appSecret: Secret }[];
  readonly quorums: { publicKey: string; displayName: string }[];
  readonly policies: { policy: KeeperPolicy; ownerId: string }[];
  readonly messages: Uint8Array[];
  readonly transactions: Transaction[];
  readonly keys: string[];
}

/** A Privy that refuses every probe with policy_violation unless told otherwise, and records what it was asked. */
function fakePrivy(behaviour: Behaviour, recorded: Recorded): PrivyPolicyClient {
  return {
    async createKeyQuorum(input) {
      recorded.quorums.push({ ...input });
      return behaviour.createKeyQuorum ? behaviour.createKeyQuorum() : { id: ADMIN_QUORUM_ID };
    },
    async createPolicy(policy, ownerId) {
      recorded.policies.push({ policy, ownerId });
      return behaviour.createPolicy ? behaviour.createPolicy(policy, ownerId) : storedPolicy(policy, { owner_id: ownerId });
    },
    async getPolicy() {
      return behaviour.getPolicy ? behaviour.getPolicy() : storedPolicy(buildKeeperPolicy(SIP_PROGRAM_ID));
    },
    async getWallet() {
      return behaviour.getWallet ? behaviour.getWallet() : grantedWallet();
    },
    async signMessage(_walletId, message, key) {
      recorded.messages.push(message);
      recorded.keys.push(key.reveal());
      if (behaviour.signMessage) return behaviour.signMessage();
      throw policyViolation();
    },
    async signAndSendTransaction(_walletId, bytes, key) {
      const transaction = Transaction.from(Buffer.from(bytes));
      recorded.transactions.push(transaction);
      recorded.keys.push(key.reveal());
      const program = transaction.instructions[0]?.programId.toBase58();
      const handler = program === SystemProgram.programId.toBase58() ? behaviour.selfTransfer : program === MEMO_PROGRAM_ID ? behaviour.memo : undefined;
      if (program !== SystemProgram.programId.toBase58() && program !== MEMO_PROGRAM_ID) throw new Error("not a probe");
      if (handler) return handler();
      throw policyViolation();
    },
  };
}

interface Run {
  readonly code: number;
  readonly stdout: Record<string, unknown>[];
  readonly stderr: Record<string, unknown>[];
  readonly text: string;
  readonly clientBuilt: number;
  readonly chainBuilt: number;
  readonly recorded: Recorded;
}

async function run(
  argv: readonly string[],
  options: { env?: NodeJS.ProcessEnv; privy?: Behaviour; chain?: Partial<ProbeChain>; keyPair?: { publicKey: string; privateKey: string } } = {},
): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const recorded: Recorded = { credentials: [], quorums: [], policies: [], messages: [], transactions: [], keys: [] };
  let clientBuilt = 0;
  let chainBuilt = 0;
  const code = await runPrivyPolicyCli(argv, {
    env: options.env ?? {},
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    redactor: new Redactor(),
    client: (credentials) => {
      clientBuilt += 1;
      recorded.credentials.push({ ...credentials });
      return fakePrivy(options.privy ?? {}, recorded);
    },
    chain: () => {
      chainBuilt += 1;
      return { genesisHash: async () => MAINNET_GENESIS, latestBlockhash: async () => BLOCKHASH, balanceLamports: async () => 2_000_000, ...options.chain };
    },
    generateKeyPair: async () => options.keyPair ?? generateP256KeyPair(),
    repoRoot: repo,
  });
  const parse = (lines: string[]): Record<string, unknown>[] =>
    lines.map((line) => {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(parsed["service"]).toBe(SERVICE);
      return parsed;
    });
  return { code, stdout: parse(out), stderr: parse(err), text: [...out, ...err].join("\n"), clientBuilt, chainBuilt, recorded };
}

const events = (lines: Record<string, unknown>[]): unknown[] => lines.map((line) => line["event"]);

describe("--print", () => {
  it("prints the policy and reads no environment, builds no client and touches no chain", async () => {
    const touched: string[] = [];
    const env = new Proxy({} as NodeJS.ProcessEnv, {
      get: (target, key) => (touched.push(`get:${String(key)}`), Reflect.get(target, key)),
      has: (target, key) => (touched.push(`has:${String(key)}`), Reflect.has(target, key)),
      ownKeys: (target) => (touched.push("ownKeys"), Reflect.ownKeys(target)),
    });
    for (const argv of [["--print"], ["--", "--print"]]) {
      const result = await run(argv, { env });
      expect(result.code).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(result.stdout).toHaveLength(1);
      expect(result.stdout[0]).toMatchObject({ event: "privy policy", policy: JSON.parse(JSON.stringify(buildKeeperPolicy(SIP_PROGRAM_ID))) });
      expect(result.stdout[0]!["programs"]).toEqual(allowedPrograms(buildKeeperPolicy(SIP_PROGRAM_ID)));
      expect([result.clientBuilt, result.chainBuilt]).toEqual([0, 0]);
    }
    expect(touched).toEqual([]);
  });
});

describe("create", () => {
  it("writes the admin key, registers its quorum, creates the owned policy, and prints only the ids, programs and path", async () => {
    const keyPair = await generateP256KeyPair();
    const path = join(keys, "admin.key");
    const result = await run(["create", "--admin-key-out", path], { env: privyEnv, keyPair });

    expect(result.code).toBe(0);
    expect(result.stdout).toHaveLength(1);
    const line = result.stdout[0]!;
    expect(Object.keys(line).sort()).toEqual(["adminKeyFile", "adminKeyQuorumId", "event", "level", "policyId", "programs", "service", "ts"]);
    expect(line).toMatchObject({ event: "privy policy created", policyId: POLICY_ID, adminKeyQuorumId: ADMIN_QUORUM_ID, adminKeyFile: path });
    expect(line["programs"]).toEqual(allowedPrograms(buildKeeperPolicy(SIP_PROGRAM_ID)));

    expect(readFileSync(path, "utf8")).toBe(keyPair.privateKey);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(result.text).not.toContain(keyPair.privateKey);

    expect(result.recorded.quorums).toEqual([{ publicKey: keyPair.publicKey, displayName: "sip-solana-policy-admin" }]);
    expect(result.recorded.policies).toHaveLength(1);
    expect(result.recorded.policies[0]!.ownerId).toBe(ADMIN_QUORUM_ID);
    expect(JSON.stringify(result.recorded.policies[0]!.policy)).toBe(JSON.stringify(buildKeeperPolicy(SIP_PROGRAM_ID)));
    expect(result.recorded.credentials.map((credentials) => [credentials.appId, credentials.appSecret.reveal()])).toEqual([[APP_ID, APP_SECRET]]);
  });

  it("says which objects exist when the policy is refused after the quorum was registered", async () => {
    const path = join(keys, "policy-refused.key");
    const result = await run(["create", "--admin-key-out", path], {
      env: privyEnv,
      privy: { createPolicy: async () => Promise.reject(new BadRequestError(400, { error: "Invalid rule" }, undefined, headers)) },
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toEqual([]);
    const incomplete = result.stderr.find((line) => line["event"] === "privy policy create incomplete")!;
    expect(incomplete).toMatchObject({
      failedStep: "create the policy",
      exists: { adminKeyFile: path, adminKeyQuorumId: ADMIN_QUORUM_ID },
      doesNotExist: ["policy"],
      unknown: [],
    });
    expect(existsSync(path)).toBe(true);
  });

  it("says what cannot be known when the quorum request gets no answer", async () => {
    const path = join(keys, "quorum-unanswered.key");
    const result = await run(["create", "--admin-key-out", path], {
      env: privyEnv,
      privy: { createKeyQuorum: async () => Promise.reject(new APIConnectionError({ message: "Connection error." })) },
    });
    expect(result.code).toBe(1);
    const incomplete = result.stderr.find((line) => line["event"] === "privy policy create incomplete")!;
    expect(incomplete).toMatchObject({ failedStep: "register the admin key quorum", exists: { adminKeyFile: path }, doesNotExist: ["policy"] });
    expect(incomplete["unknown"]).toHaveLength(1);
    expect(result.recorded.policies).toEqual([]);
  });

  it("counts a timeout, a conflict, a rate limit or a server error as may-have-landed, at either step", async () => {
    for (const status of [408, 409, 429, 500, 504]) {
      const failure = (): Error =>
        status >= 500
          ? new InternalServerError(status, { error: "gateway timeout" }, undefined, headers)
          : new APIError(status, { error: "try again" }, undefined, headers);

      const quorum = await run(["create", "--admin-key-out", join(keys, `quorum-${status}.key`)], {
        env: privyEnv,
        privy: { createKeyQuorum: async () => Promise.reject(failure()) },
      });
      expect(quorum.code, `quorum ${status}`).toBe(1);
      const quorumLine = quorum.stderr.find((line) => line["event"] === "privy policy create incomplete")!;
      expect(quorumLine, `quorum ${status}`).toMatchObject({ failedStep: "register the admin key quorum", status, doesNotExist: ["policy"] });
      expect(quorumLine["unknown"], `quorum ${status}`).toHaveLength(1);
      expect(quorum.recorded.policies).toEqual([]);

      const policy = await run(["create", "--admin-key-out", join(keys, `policy-${status}.key`)], {
        env: privyEnv,
        privy: { createPolicy: async () => Promise.reject(failure()) },
      });
      expect(policy.code, `policy ${status}`).toBe(1);
      const policyLine = policy.stderr.find((line) => line["event"] === "privy policy create incomplete")!;
      expect(policyLine, `policy ${status}`).toMatchObject({
        failedStep: "create the policy",
        status,
        exists: { adminKeyQuorumId: ADMIN_QUORUM_ID },
        doesNotExist: [],
      });
      expect(policyLine["unknown"], `policy ${status}`).toHaveLength(1);
    }
  });

  it("counts any other 4xx as proof the object was not created", async () => {
    const result = await run(["create", "--admin-key-out", join(keys, "quorum-400.key")], {
      env: privyEnv,
      privy: { createKeyQuorum: async () => Promise.reject(new BadRequestError(400, { error: "Invalid public key" }, undefined, headers)) },
    });
    expect(result.code).toBe(1);
    expect(result.stderr.find((line) => line["event"] === "privy policy create incomplete")).toMatchObject({
      failedStep: "register the admin key quorum",
      status: 400,
      doesNotExist: ["admin key quorum", "policy"],
      unknown: [],
    });
  });

  it("refuses a path inside the repository, a relative path and an existing file before asking Privy anything", async () => {
    const existing = join(keys, "already-there.key");
    writeFileSync(existing, "keep me", { mode: 0o600 });
    for (const [path, reason] of [
      [join(repo, "packages", "admin.key"), "INSIDE_REPOSITORY"],
      ["admin.key", null],
      [existing, "EXISTS"],
    ] as const) {
      const result = await run(["create", "--admin-key-out", path], { env: privyEnv });
      expect(result.code, path).toBe(2);
      expect(result.clientBuilt).toBe(0);
      expect(result.stdout).toEqual([]);
      if (reason !== null) expect(result.stderr.find((line) => line["event"] === "admin key file refused")).toMatchObject({ reason });
    }
    expect(existsSync(join(repo, "packages", "admin.key"))).toBe(false);
    expect(readFileSync(existing, "utf8")).toBe("keep me");
  });
});

describe("check", () => {
  const withSigner = { ...privyEnv, SIP_SOLANA_PRIVY_SIGNER_ID: SIGNER_ID };
  const policy = buildKeeperPolicy(SIP_PROGRAM_ID);

  it("exits 0 for the identical, owned policy", async () => {
    const result = await run(["check", "--policy", POLICY_ID], { env: withSigner });
    expect(result.code).toBe(0);
    expect(result.stdout).toHaveLength(1);
    expect(result.stdout[0]).toMatchObject({ event: "privy policy check", verdict: "OK", identical: true, owned: true, ownerId: ADMIN_QUORUM_ID, signerCompared: true });
  });

  it("exits 1 for a missing owner, an owner that is the signer, and an added program", async () => {
    const extra = Keypair.generate().publicKey.toBase58();
    const widened = JSON.parse(JSON.stringify(policy)) as { rules: { conditions: { value: string[] }[] }[] };
    widened.rules[0]!.conditions[0]!.value.push(extra);
    for (const [getPolicy, verdict] of [
      [async () => storedPolicy(policy, { owner_id: null }), "UNOWNED"],
      [async () => storedPolicy(policy, { owner_id: SIGNER_ID }), "OWNED_BY_SIGNER"],
      [async () => ({ ...storedPolicy(policy), rules: widened.rules as unknown as PolicyLike["rules"] }), "DIFFERENT"],
    ] as const) {
      const result = await run(["check", "--policy", POLICY_ID], { env: withSigner, privy: { getPolicy } });
      expect(result.code, verdict).toBe(1);
      expect(result.stdout[0]).toMatchObject({ verdict });
    }
    const different = await run(["check", "--policy", POLICY_ID], {
      env: withSigner,
      privy: { getPolicy: async () => ({ ...storedPolicy(policy), rules: widened.rules as unknown as PolicyLike["rules"] }) },
    });
    expect(JSON.stringify(different.stdout[0]!["differences"])).toContain(extra);
  });

  it("exits 1 when the policy cannot be read", async () => {
    const result = await run(["check", "--policy", POLICY_ID], {
      env: privyEnv,
      privy: { getPolicy: async () => Promise.reject(new NotFoundError(404, { error: "Policy not found" }, undefined, headers)) },
    });
    expect(result.code).toBe(1);
    expect(result.stderr.find((line) => line["event"] === "privy policy not read")).toMatchObject({ status: 404, class: "OTHER" });
  });
});

describe("verify", () => {
  const argv = ["verify", "--wallet", WALLET_ID, "--policy", POLICY_ID];
  const probeLines = (result: Run): Record<string, unknown>[] => result.stdout.filter((line) => line["event"] === "privy probe");
  const summary = (result: Run): Record<string, unknown> => result.stdout.find((line) => line["event"] === "privy verify")!;

  it("passes only when all three probes are refused with policy_violation, and sends exactly the probes", async () => {
    const result = await run(argv, { env: verifyEnv });
    expect(result.code).toBe(0);
    expect(probeLines(result).map((line) => [line["probe"], line["outcome"], line["code"]])).toEqual([
      ["signMessage", "REFUSED", "policy_violation"],
      ["selfTransfer", "REFUSED", "policy_violation"],
      ["memo", "REFUSED", "policy_violation"],
    ]);
    expect(summary(result)).toMatchObject({ verdict: "PASS", probes: { signMessage: "REFUSED", selfTransfer: "REFUSED", memo: "REFUSED" } });
    expect(result.stdout.find((line) => line["event"] === "old program")).toMatchObject({ program: OLD_NUVEM_PROGRAM_ID, excluded: true });
    expect(String(result.stdout.find((line) => line["event"] === "old program")!["detail"])).toContain("simulates before");

    expect(result.recorded.messages.map((message) => new TextDecoder().decode(message))).toEqual([PROBE_MESSAGE]);
    const [transfer, memo] = result.recorded.transactions;
    expect(result.recorded.transactions).toHaveLength(2);
    for (const transaction of [transfer!, memo!]) {
      expect(transaction.feePayer?.toBase58()).toBe(ADDRESS);
      expect(transaction.recentBlockhash).toBe(BLOCKHASH);
      expect(transaction.instructions).toHaveLength(1);
    }
    expect(SystemInstruction.decodeTransfer(transfer!.instructions[0]!).lamports).toBe(1n);
    expect(memo!.instructions[0]!.programId.toBase58()).toBe(MEMO_PROGRAM_ID);
    // Signed as the keeper's signer, with the key exactly as the environment holds it.
    expect(new Set(result.recorded.keys)).toEqual(new Set([AUTH_KEY]));
  });

  it("is CRITICAL when a probe goes through, and prints what Privy returned", async () => {
    const signed = await run(argv, { env: verifyEnv, privy: { signMessage: async () => ({ signature: "c2lnbmVkLWFueXdheQ==" }) } });
    expect(signed.code).toBe(1);
    expect(probeLines(signed)[0]).toMatchObject({ probe: "signMessage", outcome: "CRITICAL", level: "error", signature: "c2lnbmVkLWFueXdheQ==" });
    expect(summary(signed)).toMatchObject({ verdict: "CRITICAL" });

    const hash = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";
    const sent = await run(argv, { env: verifyEnv, privy: { memo: async () => ({ hash }) } });
    expect(sent.code).toBe(1);
    expect(probeLines(sent).map((line) => line["outcome"])).toEqual(["REFUSED", "REFUSED", "CRITICAL"]);
    expect(probeLines(sent)[2]).toMatchObject({ probe: "memo", hash });
    expect(summary(sent)).toMatchObject({ verdict: "CRITICAL" });
  });

  it("is INCONCLUSIVE, never a pass, when the simulation fails first", async () => {
    const result = await run(argv, {
      env: verifyEnv,
      privy: { selfTransfer: async () => Promise.reject(simulationFailed()), memo: async () => Promise.reject(simulationFailed()) },
      chain: { balanceLamports: async () => 0 },
    });
    expect(result.code).toBe(1);
    expect(probeLines(result).map((line) => line["outcome"])).toEqual(["REFUSED", "INCONCLUSIVE", "INCONCLUSIVE"]);
    expect(summary(result)).toMatchObject({ verdict: "INCONCLUSIVE" });
    expect(events(result.stderr)).toContain("the wallet is probably too poor for the transaction probes to simulate");
  });

  it("does not count refused credentials as a refusal by the policy", async () => {
    const result = await run(argv, {
      env: verifyEnv,
      privy: { signMessage: async () => Promise.reject(new AuthenticationError(401, { error: "Invalid app ID or app secret." }, undefined, headers)) },
    });
    expect(result.code).toBe(1);
    expect(probeLines(result)[0]).toMatchObject({ outcome: "UNAUTHORIZED" });
    expect(summary(result)).toMatchObject({ verdict: "FAILED" });
  });

  it("probes nothing unless the signer is on the wallet with exactly this override policy", async () => {
    for (const [wallet, verdict] of [
      [grantedWallet({ additional_signers: [{ signer_id: "someOtherSigner" }] }), "SIGNER_NOT_GRANTED"],
      [grantedWallet({ additional_signers: [{ signer_id: SIGNER_ID }] }), "OVERRIDE_POLICY_MISMATCH"],
      [grantedWallet({ additional_signers: [{ signer_id: SIGNER_ID, override_policy_ids: [POLICY_ID, "anotherPolicy"] }] }), "OVERRIDE_POLICY_MISMATCH"],
      [grantedWallet({ additional_signers: [{ signer_id: SIGNER_ID, override_policy_ids: ["anotherPolicy"] }] }), "OVERRIDE_POLICY_MISMATCH"],
    ] as const) {
      const result = await run(argv, { env: verifyEnv, privy: { getWallet: async () => wallet } });
      expect(result.code, verdict).toBe(1);
      expect(summary(result)).toMatchObject({ verdict });
      expect([result.recorded.messages, result.recorded.transactions, result.chainBuilt]).toEqual([[], [], 0]);
    }
  });

  it("refuses an endpoint that is not mainnet-beta before probing", async () => {
    const result = await run(argv, { env: verifyEnv, chain: { genesisHash: async () => "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" } });
    expect(result.code).toBe(2);
    expect([result.recorded.messages, result.recorded.transactions]).toEqual([[], []]);
  });
});

describe("refusals", () => {
  it("exits 2 naming every missing variable, for each command, without building a client", async () => {
    for (const [argv, missing] of [
      [["create", "--admin-key-out", join(keys, "never.key")], ["SIP_SOLANA_PRIVY_APP_ID", "SIP_SOLANA_PRIVY_APP_SECRET"]],
      [["check", "--policy", POLICY_ID], ["SIP_SOLANA_PRIVY_APP_ID", "SIP_SOLANA_PRIVY_APP_SECRET"]],
      [
        ["verify", "--wallet", WALLET_ID, "--policy", POLICY_ID],
        ["SIP_SOLANA_PRIVY_APP_ID", "SIP_SOLANA_PRIVY_APP_SECRET", "SIP_SOLANA_PRIVY_AUTHORIZATION_KEY", "SIP_SOLANA_PRIVY_SIGNER_ID", "SIP_SOLANA_RPC_URLS"],
      ],
    ] as const) {
      const result = await run(argv, { env: {} });
      expect(result.code, argv[0]).toBe(2);
      expect(result.stderr).toHaveLength(1);
      expect(result.stderr[0]).toMatchObject({ event: "configuration refused", command: argv[0], missing });
      for (const name of missing) expect(JSON.stringify(result.stderr[0]!["problems"])).toContain(name);
      expect([result.clientBuilt, result.stdout]).toEqual([0, []]);
    }
    expect(existsSync(join(keys, "never.key"))).toBe(false);
  });

  it("refuses Nuvem's variables, a malformed key and the old program, without echoing a value", async () => {
    const nuvem = await run(["check", "--policy", POLICY_ID], { env: { ...privyEnv, NUVEM_SOLANA_SIGNER_ID: "nuvem-signer-value-0001" } });
    expect(nuvem.code).toBe(2);
    expect(nuvem.text).toContain("NUVEM_SOLANA_SIGNER_ID is Nuvem's configuration");
    expect(nuvem.text).not.toContain("nuvem-signer-value-0001");

    const malformed = await run(["verify", "--wallet", WALLET_ID, "--policy", POLICY_ID], {
      env: { ...verifyEnv, SIP_SOLANA_PRIVY_AUTHORIZATION_KEY: "wallet-auth:NotAKeyButSecretAnyway0006" },
    });
    expect(malformed.code).toBe(2);
    expect(malformed.text).toContain("SIP_SOLANA_PRIVY_AUTHORIZATION_KEY is not a P-256 private key");
    expect(malformed.text).not.toContain("NotAKeyButSecretAnyway0006");

    const old = await run(["check", "--policy", POLICY_ID], { env: { ...privyEnv, SIP_SOLANA_PROGRAM_ID: OLD_NUVEM_PROGRAM_ID } });
    expect(old.code).toBe(2);
    expect(old.text).toContain("names Nuvem's old program");
  });

  it("refuses the Privy SDK's own environment overrides by name, before any client, chain or key exists", async () => {
    const value = "https://collector.example.test/override-value-NeverPrinted-0008";
    for (const name of ["PRIVY_API_BASE_URL", "PRIVY_API_LOG", "PRIVY_API_CUSTOM_HEADERS"]) {
      const keyFile = join(keys, `override-${name}.key`);
      for (const argv of [
        ["create", "--admin-key-out", keyFile],
        ["check", "--policy", POLICY_ID],
        ["verify", "--wallet", WALLET_ID, "--policy", POLICY_ID],
      ]) {
        const result = await run(argv, { env: { ...verifyEnv, [name]: value } });
        expect(result.code, `${name} ${argv[0]}`).toBe(2);
        expect([result.clientBuilt, result.chainBuilt, result.stdout], `${name} ${argv[0]}`).toEqual([0, 0, []]);
        const refused = result.stderr.find((line) => line["event"] === "configuration refused")!;
        expect(JSON.stringify(refused["problems"]), `${name} ${argv[0]}`).toContain(`${name} is the Privy SDK's own setting`);
        expect(result.text).not.toContain("override-value-NeverPrinted-0008");
      }
      expect(existsSync(keyFile)).toBe(false);
    }
  });

  it("refuses unknown commands, unknown or repeated flags, and missing values", async () => {
    for (const argv of [[], ["delete"], ["check"], ["check", "--policy"], ["check", "--policy", POLICY_ID, "--wallet", WALLET_ID], ["check", "--policy", "a", "--policy", "b"], ["check", "--policy", "has spaces"]]) {
      const result = await run(argv, { env: privyEnv });
      expect(result.code, argv.join(" ")).toBe(2);
      expect(events(result.stderr)).toEqual(["arguments refused"]);
      expect(result.clientBuilt).toBe(0);
    }
  });
});

describe("redaction", () => {
  it("never prints the app secret, the authorization key or the endpoint, even when failures quote them", async () => {
    const result = await run(["verify", "--wallet", WALLET_ID, "--policy", POLICY_ID], {
      env: verifyEnv,
      privy: {
        signMessage: async () => Promise.reject(new Error(`request failed for app secret ${APP_SECRET}`)),
        selfTransfer: async () => Promise.reject(new BadRequestError(400, { error: `bad signature from ${signerPair.privateKey}` }, undefined, headers)),
        memo: async () => Promise.reject(new Error(`fetch ${RPC} failed with ${AUTH_KEY}`)),
      },
      chain: { balanceLamports: async () => Promise.reject(new Error(`429 from ${RPC}`)) },
    });
    expect(result.code).toBe(1);
    for (const secret of [APP_SECRET, AUTH_KEY, signerPair.privateKey, RPC, "HeliusKeyNeverPrinted0005"]) expect(result.text).not.toContain(secret);
    expect(result.text).toContain("<redacted:privyAppSecret>");
    expect(result.text).toContain("<redacted:privyAuthorizationKey>");
    expect(result.text).toContain("<redacted:rpcUrl:0>");
  });

  it("never prints the generated admin key, even when a failure quotes it", async () => {
    const keyPair = await generateP256KeyPair();
    const result = await run(["create", "--admin-key-out", join(keys, "quoted.key")], {
      env: privyEnv,
      keyPair,
      privy: { createKeyQuorum: async () => Promise.reject(new BadRequestError(400, { error: `leaked ${keyPair.privateKey}` }, undefined, headers)) },
    });
    expect(result.code).toBe(1);
    expect(result.text).not.toContain(keyPair.privateKey);
    expect(result.text).toContain("<redacted:policyAdminKey>");
    for (const secret of [APP_SECRET]) expect(result.text).not.toContain(secret);
  });
});
