// /api/solana-build and /api/solana-vault through their handlers, over a stub chain.

import { describe, expect, it } from "vitest";

import {
  ATA_PROGRAM,
  ANTHROPIC_MINT,
  COMPUTE_BUDGET_PROGRAM,
  ED25519_PROGRAM,
  JUPITER_V6,
  RAYDIUM_CLMM,
  SOL_USDC_POOL,
  SPYX_MINT,
  SPYX_USDC_POOL,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  USDC_MINT,
  WSOL_MINT,
} from "../src/client/addresses";
import { base64Encode } from "../src/client/base64";
import { decodeArgs } from "../src/client/borsh";
import { SIP_ACCOUNT_SPACE } from "../src/client/decoders";
import { SIP_PROGRAM_ID, toHex } from "../src/client/idl";
import { linkConsentMessage } from "../src/client/link-consent";
import { BUNDLED_VAULT_TOKEN_ACCOUNT_CREATES, OFFERED_LEGS, basketWeightsBps } from "../src/client/product";
import { parseLegacyMessage, splitWire } from "../src/client/message";
import { U64_MAX } from "../src/client/rules";
import {
  BUILD_READS_WEIGHT,
  BUILD_REQUEST_WEIGHT,
  MAX_BUILD_REQUEST_BYTES,
  OFFERED_VENUES,
  createSolanaBuildHandler,
  createSolanaVaultHandler,
  sharedBuildReadsBudget,
  type SolanaBuildHandlerOptions,
} from "../src/server/build-handler";
import { DEFAULT_RELAY_LIMITS, loadSolanaServerSettings } from "../src/server/config";
import type { SolanaGate } from "../src/server/handlers";
import { deriveAta, deriveConfigPda, deriveInvestPda, deriveLinkPda, deriveVaultPda } from "../src/server/pda";
import { createWeightedLimiter, type WeightedLimiter } from "../src/server/rate-limit";
import { MAX_RELAY_REQUEST_WEIGHT } from "../src/server/relay-policy";
import { createRpcPool } from "../src/server/rpc-pool";
import { verifySignedTransaction } from "../src/server/verify-tx";
import {
  LEG_POOLS,
  SOL_SQRT_PRICE,
  answerRpc,
  clmmPoolAccount,
  configAccount,
  linkAccount,
  localRent,
  methodsOf,
  mintAccount,
  parsedTokenAccount,
  policyAccount,
  pricedPoolEntries,
  tokenAccountData,
  tokenAccountInfo,
  vaultAccount,
  type StubChain,
} from "./chain-fixtures";
import { SECRET_QUERY, UPSTREAM_1, accountInfo, fakeFetch, fromB64, keypair, signBytes, signWire } from "./helpers";
import { ROUTED_VENUE } from "./fixtures/keeper-policy";

const load = loadSolanaServerSettings({ SIP_SOLANA_RPC_URLS: UPSTREAM_1, SIP_SOLANA_PROGRAM_ID: SIP_PROGRAM_ID, SIP_TRUSTED_CLIENT_IP_HEADER: "x-envoy-external-address" });
if (!load.ok) throw new Error("test settings must load");
const OK_GATE: SolanaGate = { kind: "ok", settings: load.settings };

let lastIp = 0;
const freshIp = (): string => `198.51.100.${(lastIp = (lastIp % 250) + 1)}`;

function post(route: "build" | "vault", body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://sip.example/api/solana-${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-envoy-external-address": freshIp(), ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

type ErrorBody = { code: string; message: string; problems?: string[]; vault?: string; rule?: Record<string, unknown>; retryAfterSeconds?: number };
type Answer = { status: number; json: { error?: ErrorBody } & Record<string, any>; text: string; headers: Headers };

async function read(response: Response): Promise<Answer> {
  const text = await response.text();
  return { status: response.status, json: JSON.parse(text) as never, text, headers: response.headers };
}

function setup(chain: StubChain = { accounts: new Map() }, extra: Omit<SolanaBuildHandlerOptions, "gate"> = {}, gate: SolanaGate = OK_GATE) {
  const upstream = fakeFetch(answerRpc(chain));
  const options: SolanaBuildHandlerOptions = { gate: () => gate, fetch: upstream.fetch, now: () => 0, onRefusal: () => undefined, ...extra };
  const build = createSolanaBuildHandler(options);
  const vault = createSolanaVaultHandler(options);
  return {
    upstream,
    build: async (body: unknown, headers?: Record<string, string>) => read(await build.POST(post("build", body, headers))),
    state: async (body: unknown, headers?: Record<string, string>) => read(await vault.POST(post("vault", body, headers))),
    handlers: { build, vault },
  };
}

const key = (): string => keypair().publicKey.toBase58();
const sipOwned = (data: Uint8Array, lamports = 2_000_000) => accountInfo(SIP_PROGRAM_ID, data, lamports);

/** A chain where `owner` has a vault and the protocol config exists (paused or not). */
function linkableChain(owner: string, paused = false): StubChain {
  return {
    accounts: new Map([
      [deriveVaultPda(owner).toBase58(), sipOwned(vaultAccount(owner), localRent(125))],
      [deriveConfigPda().toBase58(), sipOwned(configAccount(paused))],
    ]),
  };
}

const programsOf = (txBase64: string): string[] => parseLegacyMessage(splitWire(fromB64(txBase64)).message).instructions.map((instruction) => instruction.programId);

describe("the order of refusals, before any chain read", () => {
  it("an invalid gate is 503 with no detail; cross-site 403; text/plain 415; over 2048 bytes 413; GET 405", async () => {
    const off = setup(undefined, {}, { kind: "invalid" });
    const unavailable = await off.build({ action: "createVault", owner: key(), mode: 0 });
    expect([unavailable.status, unavailable.json.error?.code]).toEqual([503, "unavailable"]);
    expect(unavailable.text).not.toMatch(/SIP_|PRIVY_|variable/);

    const { build, state, handlers, upstream } = setup();
    expect((await build({ action: "createVault", owner: key(), mode: 0 }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await state({ action: "state", owner: key(), wallets: [] }, { "content-type": "text/plain" })).status).toBe(415);
    const large = await build({ action: "createVault", owner: key(), mode: 0, pad: "x".repeat(MAX_BUILD_REQUEST_BYTES) });
    expect([large.status, large.json.error?.code]).toEqual([413, "payload_too_large"]);
    expect(handlers.build.GET().status).toBe(405);
    expect(handlers.vault.GET().status).toBe(405);
    expect(upstream.calls).toHaveLength(0);
  });

  it.each([
    ["an unknown action", { action: "buildLinkWallet" }],
    ["no action", { owner: "x" }],
    ["an extra field", { action: "createVault", owner: key(), mode: 0, signedTxBase64: "AA==" }],
    ["an owner that is not a key", { action: "createVault", owner: "not-a-key", mode: 0 }],
    ["mode 2", { action: "createVault", owner: key(), mode: 2 }],
    ["lamports as a number", { action: "createVault", owner: key(), mode: 0, maxContribution: 60_000_000 }],
    ["lamports with a sign", { action: "createVault", owner: key(), mode: 0, walletReserve: "-1" }],
    ["a fractional rate", { action: "createVault", owner: key(), mode: 0, skimBps: 20.5 }],
    ["a link without its signature", { action: "link", owner: key(), wallet: key() }],
    ["a consent signature that is not 64 bytes", { action: "link", owner: key(), wallet: key(), consentSignature: base64Encode(new Uint8Array(63)) }],
    ["a prepareLink with a signature", { action: "prepareLink", owner: key(), wallet: key(), consentSignature: base64Encode(new Uint8Array(64)) }],
    ["an investment policy naming its own legs", { action: "investPolicy", owner: key(), legs: [] }],
    ["an investment policy's cap as a number", { action: "investPolicy", owner: key(), maxPerCall: 10_000_000 }],
    ["an investment policy's enabled as text", { action: "investPolicy", owner: key(), enabled: "yes" }],
    ["a withdrawal in lamports as a number", { action: "withdraw", owner: key(), lamports: 5 }],
    ["a token withdrawal that does not name its source account", { action: "withdrawToken", owner: key(), mint: SPYX_MINT, amountRaw: "1" }],
    ["a token withdrawal naming its token program", { action: "withdrawToken", owner: key(), mint: SPYX_MINT, amountRaw: "1", vaultToken: key(), tokenProgram: TOKEN_PROGRAM }],
    ["a token withdrawal whose source is not a key", { action: "withdrawToken", owner: key(), mint: SPYX_MINT, amountRaw: "1", vaultToken: "the largest" }],
    ["a token withdrawal whose mint is not a key", { action: "withdrawToken", owner: key(), mint: "SPYx", amountRaw: "1", vaultToken: key() }],
    ["an array body", [1]],
  ])("%s is 400 bad_request with no chain read", async (_, body) => {
    const { build, upstream } = setup();
    const answer = await build(body);
    expect([answer.status, answer.json.error?.code]).toEqual([400, "bad_request"]);
    expect(upstream.calls).toHaveLength(0);
  });

  it("the client's bucket refuses before the body is read: a body over the cap is 429, not 413", async () => {
    const { build, upstream } = setup(undefined, { limiter: createWeightedLimiter({ capacity: BUILD_REQUEST_WEIGHT }) });
    const client = { "x-envoy-external-address": "203.0.113.40" };
    expect((await build({ action: "nope" }, client)).status).toBe(400);
    const limited = await build({ action: "createVault", pad: "x".repeat(5_000) }, client);
    expect([limited.status, limited.json.error?.code]).toEqual([429, "rate_limited"]);
    expect(limited.headers.get("retry-after")).not.toBeNull();
    expect(limited.json.error?.retryAfterSeconds).toBeGreaterThan(0);
    expect(upstream.calls).toHaveLength(0);
  });

  it(`one client gets ${DEFAULT_RELAY_LIMITS.perClientPerMin / BUILD_REQUEST_WEIGHT} requests a minute at weight ${BUILD_REQUEST_WEIGHT}; another client is not refused`, async () => {
    const { build } = setup();
    const client = { "x-envoy-external-address": "203.0.113.41" };
    for (let i = 0; i < DEFAULT_RELAY_LIMITS.perClientPerMin / BUILD_REQUEST_WEIGHT; i++) expect((await build({ action: "nope" }, client)).status).toBe(400);
    expect((await build({ action: "nope" }, client)).status).toBe(429);
    expect((await build({ action: "nope" }, { "x-envoy-external-address": "192.0.2.41" })).status).toBe(400);
  });

  it("the process-wide reads budget refuses a well-formed request before any read", async () => {
    const { build, upstream } = setup(undefined, { readsBudget: createWeightedLimiter({ capacity: 4 }) });
    expect((await build({ action: "createVault", owner: key(), mode: 0 })).status).toBe(200);
    const calls = upstream.calls.length;
    const refused = await build({ action: "createVault", owner: key(), mode: 0 });
    expect([refused.status, refused.json.error?.code]).toEqual([429, "rate_limited"]);
    expect(upstream.calls).toHaveLength(calls);
  });

  it(`the heaviest action, state at ${BUILD_READS_WEIGHT.state} calls, costs its client every call: one address spends at most ${DEFAULT_RELAY_LIMITS.perClientPerMin} read tokens a minute, a reads budget 25 or more addresses deep`, async () => {
    expect(Math.max(...Object.values(BUILD_READS_WEIGHT))).toBe(BUILD_READS_WEIGHT.state);
    const inner = createWeightedLimiter({ capacity: DEFAULT_RELAY_LIMITS.readsGlobalPerMin });
    let spent = 0;
    const readsBudget: WeightedLimiter = {
      take: (budgetKey, cost, at) => {
        const wait = inner.take(budgetKey, cost, at);
        if (wait === 0) spent += cost;
        return wait;
      },
      get size() {
        return inner.size;
      },
    };
    const { state, upstream } = setup(undefined, { readsBudget });
    const client = { "x-envoy-external-address": "203.0.113.50" };
    let served = 0;
    for (let attempt = 0; attempt < 100; attempt++) {
      const answer = await state({ action: "state", owner: key(), wallets: [] }, client);
      if (answer.status !== 200) {
        expect([answer.status, answer.json.error?.code]).toEqual([429, "rate_limited"]);
        break;
      }
      served += 1;
    }
    expect(served).toBe(DEFAULT_RELAY_LIMITS.perClientPerMin / BUILD_READS_WEIGHT.state);
    expect(spent).toBe(served * BUILD_READS_WEIGHT.state);
    expect(spent).toBeLessThanOrEqual(DEFAULT_RELAY_LIMITS.perClientPerMin);
    expect(DEFAULT_RELAY_LIMITS.readsGlobalPerMin / spent).toBeGreaterThanOrEqual(25);
    expect(upstream.calls.length).toBeGreaterThan(0);
  });

  it("eight addresses in two /24s, each spending all it may on state, leave the reads budget for everyone else", async () => {
    const { state, build } = setup(undefined, { readsBudget: createWeightedLimiter({ capacity: DEFAULT_RELAY_LIMITS.readsGlobalPerMin }) });
    for (const network of [18, 19]) {
      for (let host = 1; host <= 4; host++) {
        const client = { "x-envoy-external-address": `198.18.${network}.${host}` };
        for (let attempt = 0; attempt < 100; attempt++) {
          if ((await state({ action: "state", owner: key(), wallets: [] }, client)).status !== 200) break;
        }
      }
    }
    const visitor = { "x-envoy-external-address": "192.0.2.77" };
    expect((await state({ action: "state", owner: key(), wallets: [] }, visitor)).status).toBe(200);
    expect((await build({ action: "withdraw", owner: key(), lamports: "1" }, { "x-envoy-external-address": "192.0.2.78" })).json.error?.code).toBe("vault_missing");
  });

  it("a build past the client's flat charge is refused 429 before any read, and spends nothing of the reads budget", async () => {
    const reads = createWeightedLimiter({ capacity: DEFAULT_RELAY_LIMITS.readsGlobalPerMin });
    const { build, upstream } = setup(undefined, { limiter: createWeightedLimiter({ capacity: BUILD_REQUEST_WEIGHT + 1 }), readsBudget: reads });
    const refused = await build({ action: "investPolicy", owner: key() }, { "x-envoy-external-address": "203.0.113.51" });
    expect([refused.status, refused.json.error?.code]).toEqual([429, "rate_limited"]);
    expect(upstream.calls).toHaveLength(0);
    expect(reads.take("global", DEFAULT_RELAY_LIMITS.readsGlobalPerMin, 0)).toBe(0);
  });

  it("the build and vault routes share one reads budget in a process: what state reads spend is gone for builds", async () => {
    // A capacity no other case uses, so this case has the shared budget to itself.
    const capacity = 3 * BUILD_READS_WEIGHT.state;
    expect(capacity).toBeGreaterThanOrEqual(MAX_RELAY_REQUEST_WEIGHT);
    const shared = loadSolanaServerSettings({
      SIP_SOLANA_RPC_URLS: UPSTREAM_1,
      SIP_SOLANA_PROGRAM_ID: SIP_PROGRAM_ID,
      SIP_TRUSTED_CLIENT_IP_HEADER: "x-envoy-external-address",
      SIP_SOLANA_RELAY_READS_GLOBAL_PER_MIN: String(capacity),
    });
    if (!shared.ok) throw new Error("test settings must load");
    const upstream = fakeFetch(answerRpc({ accounts: new Map() }));
    const options: SolanaBuildHandlerOptions = { gate: () => ({ kind: "ok", settings: shared.settings }), fetch: upstream.fetch, now: () => 0, onRefusal: () => undefined };
    const vaultRoute = createSolanaVaultHandler(options);
    const buildRoute = createSolanaBuildHandler(options);
    for (let i = 0; i < 3; i++) expect((await vaultRoute.POST(post("vault", { action: "state", owner: key(), wallets: [] }))).status).toBe(200);
    const calls = upstream.calls.length;
    const refused = await read(await buildRoute.POST(post("build", { action: "createVault", owner: key(), mode: 0 })));
    expect([refused.status, refused.json.error?.code]).toEqual([429, "rate_limited"]);
    expect(refused.json.error?.message).toMatch(/^SaverFi is reading Solana for many people right now\./);
    expect(upstream.calls).toHaveLength(calls);
    expect(sharedBuildReadsBudget(capacity)).toBe(sharedBuildReadsBudget(capacity));
  });
});

describe("createVault", () => {
  it("builds [CU limit, CU price, create_vault_v2] with the product defaults, one blockhash, and the costs; it verifies once the owner signs", async () => {
    const owner = keypair();
    const { build, upstream } = setup();
    const answer = await build({ action: "createVault", owner: owner.publicKey.toBase58(), mode: 0 });
    expect(answer.status).toBe(200);
    const body = answer.json;
    expect(body.instruction).toBe("create_vault_v2");
    expect(body.vault).toBe(deriveVaultPda(owner.publicKey).toBase58());
    expect(body.lastValidBlockHeight).toBe(300_000_150);
    expect(body.computeBudget).toEqual({ unitLimit: 60_000, microLamports: "100000" });
    expect(body.costs).toEqual({ rentLamports: String(localRent(SIP_ACCOUNT_SPACE.Vault)), signatureFeeLamports: "5000", priorityFeeLamports: "6000" });
    expect(programsOf(body.txBase64)).toEqual([COMPUTE_BUDGET_PROGRAM, COMPUTE_BUDGET_PROGRAM, SIP_PROGRAM_ID]);
    const sip = parseLegacyMessage(splitWire(fromB64(body.txBase64)).message).instructions[2]!;
    expect(decodeArgs("create_vault_v2", sip.data)).toEqual({ mode: 0, skim_bps: 2_000, volume_bps: 200, max_contribution: 60_000_000n, wallet_reserve: 50_000_000n });
    const verified = verifySignedTransaction(signWire(body.txBase64, owner));
    expect(verified.ok, verified.ok ? "" : verified.detail).toBe(true);
    expect(methodsOf(upstream.calls).filter((method) => method === "getLatestBlockhash")).toHaveLength(1);
  });

  it("takes the limits the form sends", async () => {
    const { build } = setup();
    const answer = await build({ action: "createVault", owner: key(), mode: 0, maxContribution: "70000000", walletReserve: "0" });
    const sip = parseLegacyMessage(splitWire(fromB64(answer.json.txBase64)).message).instructions[2]!;
    expect(decodeArgs("create_vault_v2", sip.data)).toMatchObject({ max_contribution: 70_000_000n, wallet_reserve: 0n });
  });

  it("an existing vault is 409 vault_exists with its stored rule, and no blockhash is read", async () => {
    const owner = key();
    const { build, upstream } = setup(linkableChain(owner));
    const answer = await build({ action: "createVault", owner, mode: 0 });
    expect([answer.status, answer.json.error?.code]).toEqual([409, "vault_exists"]);
    expect(answer.json.error?.vault).toBe(deriveVaultPda(owner).toBase58());
    expect(answer.json.error?.rule).toEqual({ mode: 0, skimBps: 2_000, volumeBps: 200, maxContribution: "60000000", walletReserve: "50000000" });
    expect(methodsOf(upstream.calls)).not.toContain("getLatestBlockhash");
  });

  it("an unreadable chain is 502 unreadable, never an offer to create, and never quotes the endpoint", async () => {
    const chain: StubChain = { accounts: new Map(), down: true };
    const { build } = setup(chain);
    const answer = await build({ action: "createVault", owner: key(), mode: 0 });
    expect([answer.status, answer.json.error?.code]).toEqual([502, "unreadable"]);
    expect(answer.text).not.toContain(SECRET_QUERY);
    expect(answer.text).not.toContain("upstream.invalid");
    expect(answer.json).not.toHaveProperty("txBase64");
  });

  it("a vault address held by another program is unreadable, not missing", async () => {
    const owner = key();
    const { build } = setup({ accounts: new Map([[deriveVaultPda(owner).toBase58(), accountInfo(key(), vaultAccount(owner))]]) });
    expect((await build({ action: "createVault", owner, mode: 0 })).json.error?.code).toBe("unreadable");
  });

  it("mode 1 is 400 volume_not_offered while VOLUME is not offered, before any read; offered, it builds", async () => {
    const off = setup();
    const refused = await off.build({ action: "createVault", owner: key(), mode: 1 });
    expect([refused.status, refused.json.error?.code, refused.json.error?.message]).toEqual([400, "volume_not_offered", "Volume mode is not offered yet."]);
    expect(off.upstream.calls).toHaveLength(0);

    const on = setup(undefined, { volumeOffered: true });
    const built = await on.build({ action: "createVault", owner: key(), mode: 1 });
    expect(built.status).toBe(200);
    const sip = parseLegacyMessage(splitWire(fromB64(built.json.txBase64)).message).instructions[2]!;
    expect(decodeArgs("create_vault_v2", sip.data)).toMatchObject({ mode: 1, skim_bps: 2_000, volume_bps: 200 });
  });

  it("a rule the program refuses is 400 invalid_policy with its problems, before any read", async () => {
    const { build, upstream } = setup();
    const answer = await build({ action: "createVault", owner: key(), mode: 0, maxContribution: "0", skimBps: 200 });
    expect([answer.status, answer.json.error?.code]).toEqual([400, "invalid_policy"]);
    expect(answer.json.error?.problems?.join(" ")).toMatch(/maxContribution/);
    expect(answer.json.error?.problems?.join(" ")).toMatch(/skimBps/);
    expect(upstream.calls).toHaveLength(0);
  });

  it("a blockhash Solana does not give is 502 upstream_unavailable", async () => {
    const owner = key();
    let blockhashAsked = false;
    const upstream = fakeFetch((call) => {
      const body = call.body as { method?: string }[];
      if (Array.isArray(body) && body.some((request) => request.method === "getLatestBlockhash")) {
        blockhashAsked = true;
        throw new Error(`timeout ${UPSTREAM_1}`);
      }
      return answerRpc({ accounts: new Map() })(call);
    });
    const handler = createSolanaBuildHandler({ gate: () => OK_GATE, fetch: upstream.fetch, now: () => 0, onRefusal: () => undefined });
    const answer = await read(await handler.POST(post("build", { action: "createVault", owner, mode: 0 })));
    expect(blockhashAsked).toBe(true);
    expect([answer.status, answer.json.error?.code]).toEqual([502, "upstream_unavailable"]);
    expect(answer.text).not.toContain(SECRET_QUERY);
  });
});

describe("setPolicy", () => {
  /** A chain where `owner` has a vault, and nothing else: set_policy_v2 reads the vault and a blockhash. */
  const vaultChain = (owner: string, vault: Record<string, unknown> = {}): StubChain => ({
    accounts: new Map([[deriveVaultPda(owner).toBase58(), sipOwned(vaultAccount(owner, vault), localRent(125))]]),
  });

  /** A whole rule, as the panel must send one: set_policy_v2 writes all six fields. */
  const WHOLE_RULE = { mode: "profit", skimBps: 2_500, volumeBps: 150, paused: false, maxContribution: "30000000000", walletReserve: "25000000" } as const;

  it("builds [CU limit, CU price, set_policy_v2] with the whole rule the request names, and the 30,000-dollar cap survives as an exact u64; it verifies once the owner signs", async () => {
    const owner = keypair();
    const ownerKey = owner.publicKey.toBase58();
    const { build, upstream } = setup(vaultChain(ownerKey));
    const answer = await build({ action: "setPolicy", owner: ownerKey, ...WHOLE_RULE });
    expect(answer.status).toBe(200);
    const body = answer.json;
    expect(body.instruction).toBe("set_policy_v2");
    expect(body.vault).toBe(deriveVaultPda(ownerKey).toBase58());
    expect(body.computeBudget).toEqual({ unitLimit: 40_000, microLamports: "100000" });
    expect(programsOf(body.txBase64)).toEqual([COMPUTE_BUDGET_PROGRAM, COMPUTE_BUDGET_PROGRAM, SIP_PROGRAM_ID]);
    // 30,000 SOL-dollars of cap is 30,000,000,000 raw: past 2^53 a double would
    // have rounded it, which is why the wire carries decimal strings.
    expect(decodeArgs("set_policy_v2", instructionsOf(body.txBase64)[2]!.data)).toEqual({
      mode: 0,
      skim_bps: 2_500,
      volume_bps: 150,
      paused: false,
      max_contribution: 30_000_000_000n,
      wallet_reserve: 25_000_000n,
    });
    // The rule this replaces, so the panel can show both sides of the change.
    expect(body.current).toEqual({ mode: 0, skimBps: 2_000, volumeBps: 200, paused: false, maxContribution: "60000000", walletReserve: "50000000", policyNonce: "0" });
    expect(body.costs).toEqual({ rentLamports: "0", signatureFeeLamports: "5000", priorityFeeLamports: "4000" });
    const verified = verifySignedTransaction(signWire(body.txBase64, owner));
    expect(verified.ok, verified.ok ? "" : verified.detail).toBe(true);
    const methods = methodsOf(upstream.calls);
    expect(methods.filter((method) => method === "getLatestBlockhash")).toHaveLength(1);
    // readVault 2 (the account and its rent floor) + readBuildBatch 1 (the blockhash).
    expect(methods, "BUILD_READS_WEIGHT.setPolicy must equal the upstream calls setPolicy really makes").toHaveLength(BUILD_READS_WEIGHT.setPolicy);
  });

  it("the answer says the nonce moves and what that costs, which is the whole difference from an investPolicy change", async () => {
    const owner = key();
    const { build } = setup(vaultChain(owner, { policy_nonce: 41n }));
    const answer = await build({ action: "setPolicy", owner, ...WHOLE_RULE });
    expect(answer.json.policyNonce).toEqual({
      current: "41",
      next: "42",
      invalidatesSettlementsInFlight: true,
      notice: expect.stringContaining("stops being valid"),
    });
    // set_policy.rs bumps vault.policy_nonce and settle.rs signs it into the
    // attestation; set_invest_policy.rs bumps the POLICY account's own counter,
    // which no attestation carries. The basket change must not claim otherwise.
    const invest = await setup(investableChain(owner)).build({ action: "investPolicy", owner });
    expect(invest.status).toBe(200);
    expect(invest.json).not.toHaveProperty("policyNonce");
    expect(invest.text).not.toMatch(/stops being valid/);
  });

  it.each([
    ["no mode", { skimBps: 2_500, volumeBps: 150, paused: false, maxContribution: "1", walletReserve: "0" }],
    ["mode as the number createVault takes", { ...WHOLE_RULE, mode: 0 }],
    ["mode in the wrong case", { ...WHOLE_RULE, mode: "Profit" }],
    ["no skimBps", { mode: "profit", volumeBps: 150, paused: false, maxContribution: "1", walletReserve: "0" }],
    ["no volumeBps", { mode: "profit", skimBps: 2_500, paused: false, maxContribution: "1", walletReserve: "0" }],
    ["a fractional rate", { ...WHOLE_RULE, skimBps: 2_500.5 }],
    ["no paused", { mode: "profit", skimBps: 2_500, volumeBps: 150, maxContribution: "1", walletReserve: "0" }],
    ["paused as text", { ...WHOLE_RULE, paused: "no" }],
    // NOT DEFAULTED, ON PURPOSE: set_policy_v2 writes every field, so a cap left
    // out cannot mean "leave mine alone" — it would silently overwrite it.
    ["no maxContribution", { mode: "profit", skimBps: 2_500, volumeBps: 150, paused: false, walletReserve: "0" }],
    ["no walletReserve", { mode: "profit", skimBps: 2_500, volumeBps: 150, paused: false, maxContribution: "1" }],
    ["lamports as a number", { ...WHOLE_RULE, maxContribution: 30_000_000_000 }],
    ["lamports with a sign", { ...WHOLE_RULE, walletReserve: "-1" }],
    ["an extra field", { ...WHOLE_RULE, enabled: true }],
    ["an owner that is not a key", { ...WHOLE_RULE, owner: "not-a-key" }],
  ])("%s is 400 bad_request with no chain read, and nothing is built", async (_, rule) => {
    const owner = key();
    const { build, upstream } = setup(vaultChain(owner));
    const answer = await build({ action: "setPolicy", owner, ...rule });
    expect([answer.status, answer.json.error?.code]).toEqual([400, "bad_request"]);
    expect(answer.json).not.toHaveProperty("txBase64");
    expect(upstream.calls).toHaveLength(0);
  });

  it.each([
    ["a profit rate under the floor", { ...WHOLE_RULE, skimBps: 200 }, /skimBps/],
    ["a profit rate over 100 %", { ...WHOLE_RULE, skimBps: 10_001 }, /skimBps/],
    ["a volume rate over its ceiling", { ...WHOLE_RULE, volumeBps: 201 }, /volumeBps/],
    ["a volume rate of zero", { ...WHOLE_RULE, volumeBps: 0 }, /volumeBps/],
    ["a per-settlement cap of zero", { ...WHOLE_RULE, maxContribution: "0" }, /maxContribution/],
  ])("%s is 400 invalid_policy with its problems, before any read", async (_, rule, problem) => {
    const owner = key();
    const { build, upstream } = setup(vaultChain(owner));
    const answer = await build({ action: "setPolicy", owner, ...rule });
    expect([answer.status, answer.json.error?.code]).toEqual([400, "invalid_policy"]);
    expect(answer.json.error?.problems?.join(" ")).toMatch(problem);
    expect(upstream.calls).toHaveLength(0);
  });

  it("mode volume is 400 volume_not_offered while VOLUME is not offered, before any read; offered, it builds", async () => {
    const owner = key();
    const off = setup(vaultChain(owner));
    const refused = await off.build({ action: "setPolicy", owner, ...WHOLE_RULE, mode: "volume" });
    expect([refused.status, refused.json.error?.code, refused.json.error?.message]).toEqual([400, "volume_not_offered", "Volume mode is not offered yet."]);
    expect(off.upstream.calls).toHaveLength(0);

    const on = setup(vaultChain(owner), { volumeOffered: true });
    const built = await on.build({ action: "setPolicy", owner, ...WHOLE_RULE, mode: "volume" });
    expect(built.status).toBe(200);
    expect(decodeArgs("set_policy_v2", instructionsOf(built.json.txBase64)[2]!.data)).toMatchObject({ mode: 1 });
  });

  it("pausing the vault is the same whole rule with paused true", async () => {
    const owner = key();
    const { build } = setup(vaultChain(owner));
    const answer = await build({ action: "setPolicy", owner, ...WHOLE_RULE, paused: true });
    expect(decodeArgs("set_policy_v2", instructionsOf(answer.json.txBase64)[2]!.data)).toMatchObject({ paused: true });
  });

  it("no vault is 409 vault_missing with no blockhash read; an unreadable chain is 502 unreadable and never quotes the endpoint", async () => {
    const owner = key();
    const { build, upstream } = setup();
    const answer = await build({ action: "setPolicy", owner, ...WHOLE_RULE });
    expect([answer.status, answer.json.error?.code]).toEqual([409, "vault_missing"]);
    expect(methodsOf(upstream.calls)).not.toContain("getLatestBlockhash");
    const down = await setup({ accounts: new Map(), down: true }).build({ action: "setPolicy", owner, ...WHOLE_RULE });
    expect([down.status, down.json.error?.code]).toEqual([502, "unreadable"]);
    expect(down.text).not.toContain(SECRET_QUERY);
    expect(down.json).not.toHaveProperty("txBase64");
  });

  it("a vault whose nonce is already at the u64 maximum is 409 invalid_policy: checked_add in set_policy.rs would refuse it, so nothing is built", async () => {
    const owner = key();
    const { build, upstream } = setup(vaultChain(owner, { policy_nonce: U64_MAX }));
    const answer = await build({ action: "setPolicy", owner, ...WHOLE_RULE });
    expect([answer.status, answer.json.error?.code]).toEqual([409, "invalid_policy"]);
    expect(answer.json.error?.problems?.join(" ")).toMatch(/policy_nonce/);
    expect(methodsOf(upstream.calls)).not.toContain("getLatestBlockhash");
    expect(answer.json).not.toHaveProperty("txBase64");
  });
});

describe("prepareLink and link", () => {
  it("prepareLink answers the SIP_LINK_V1 consent naming the owner's vault, after one read", async () => {
    const owner = key();
    const wallet = key();
    const { build, upstream } = setup(linkableChain(owner));
    const answer = await build({ action: "prepareLink", owner, wallet });
    expect(answer.status).toBe(200);
    const vault = deriveVaultPda(owner).toBase58();
    expect(answer.json).toMatchObject({ instruction: "link_wallet", programId: SIP_PROGRAM_ID, owner, wallet, vault, tradingLink: deriveLinkPda(wallet).toBase58() });
    expect(toHex(fromB64(answer.json.consentMessageBase64))).toBe(toHex(linkConsentMessage({ programId: SIP_PROGRAM_ID, wallet, vault, owner })));
    expect(methodsOf(upstream.calls)).toEqual(["getMultipleAccounts"]);
  });

  it("the owner's own key as the wallet is 400 wallet_is_owner with no read", async () => {
    const owner = key();
    const { build, upstream } = setup(linkableChain(owner));
    for (const action of ["prepareLink", "link"]) {
      const body = action === "link" ? { action, owner, wallet: owner, consentSignature: base64Encode(new Uint8Array(64)) } : { action, owner, wallet: owner };
      const answer = await build(body);
      expect([answer.status, answer.json.error?.code]).toEqual([400, "wallet_is_owner"]);
    }
    expect(upstream.calls).toHaveLength(0);
  });

  it("refuses with the chain's reason: no vault, no config, a paused protocol, a wallet linked elsewhere, an unreadable read", async () => {
    const owner = key();
    const wallet = key();
    const vault = deriveVaultPda(owner).toBase58();
    const noVault = setup({ accounts: new Map([[deriveConfigPda().toBase58(), sipOwned(configAccount(false))]]) });
    expect((await noVault.build({ action: "prepareLink", owner, wallet })).json.error?.code).toBe("vault_missing");

    const noConfig = setup({ accounts: new Map([[vault, sipOwned(vaultAccount(owner))]]) });
    const missing = await noConfig.build({ action: "prepareLink", owner, wallet });
    expect([missing.status, missing.json.error?.code]).toEqual([409, "config_missing"]);

    const paused = setup(linkableChain(owner, true));
    expect((await paused.build({ action: "prepareLink", owner, wallet })).json.error?.code).toBe("protocol_paused");

    const elsewhere = linkableChain(owner);
    const otherVault = key();
    elsewhere.accounts.set(deriveLinkPda(wallet).toBase58(), sipOwned(linkAccount(wallet, otherVault)));
    const linked = await setup(elsewhere).build({ action: "prepareLink", owner, wallet });
    expect([linked.status, linked.json.error?.code, linked.json.error?.vault]).toEqual([409, "wallet_already_linked", otherVault]);

    const forged = linkableChain(owner);
    forged.accounts.set(deriveLinkPda(wallet).toBase58(), accountInfo(key(), linkAccount(wallet, vault)));
    expect((await setup(forged).build({ action: "prepareLink", owner, wallet })).json.error?.code).toBe("unreadable");

    const down = await setup({ accounts: new Map(), down: true }).build({ action: "prepareLink", owner, wallet });
    expect([down.status, down.json.error?.code]).toEqual([502, "unreadable"]);
  });

  it("link builds [CU limit, CU price, Ed25519SigVerify, link_wallet] that verifies once both keys sign, with its costs", async () => {
    const owner = keypair();
    const wallet = keypair();
    const ownerKey = owner.publicKey.toBase58();
    const walletKey = wallet.publicKey.toBase58();
    const { build, upstream } = setup(linkableChain(ownerKey));
    const prepared = await build({ action: "prepareLink", owner: ownerKey, wallet: walletKey });
    const signature = signBytes(wallet, fromB64(prepared.json.consentMessageBase64));
    const answer = await build({ action: "link", owner: ownerKey, wallet: walletKey, consentSignature: base64Encode(signature) });
    expect(answer.status).toBe(200);
    expect(programsOf(answer.json.txBase64)).toEqual([COMPUTE_BUDGET_PROGRAM, COMPUTE_BUDGET_PROGRAM, ED25519_PROGRAM, SIP_PROGRAM_ID]);
    expect(answer.json.signers).toEqual([ownerKey, walletKey]);
    expect(answer.json.costs).toEqual({ rentLamports: String(localRent(SIP_ACCOUNT_SPACE.TradingLink)), signatureFeeLamports: "10000", priorityFeeLamports: "10000" });
    const verified = verifySignedTransaction(signWire(answer.json.txBase64, owner, wallet));
    expect(verified.ok, verified.ok ? "" : verified.detail).toBe(true);
    expect(methodsOf(upstream.calls).filter((method) => method === "getLatestBlockhash")).toHaveLength(1);
  });

  it("a consent by another key, or over another owner's vault, is 422 link_consent_invalid before any read", async () => {
    const owner = key();
    const wallet = keypair();
    const walletKey = wallet.publicKey.toBase58();
    const { build, upstream } = setup(linkableChain(owner));
    const consent = linkConsentMessage({ programId: SIP_PROGRAM_ID, wallet: walletKey, vault: deriveVaultPda(owner).toBase58(), owner });
    const byStranger = await build({ action: "link", owner, wallet: walletKey, consentSignature: base64Encode(signBytes(keypair(), consent)) });
    expect([byStranger.status, byStranger.json.error?.code]).toEqual([422, "link_consent_invalid"]);
    const otherOwner = key();
    const overAnotherVault = linkConsentMessage({ programId: SIP_PROGRAM_ID, wallet: walletKey, vault: deriveVaultPda(otherOwner).toBase58(), owner: otherOwner });
    const answer = await build({ action: "link", owner, wallet: walletKey, consentSignature: base64Encode(signBytes(wallet, overAnotherVault)) });
    expect([answer.status, answer.json.error?.code, answer.json.error?.message]).toEqual([422, "link_consent_invalid", "Your trading wallet's signature does not match SaverFi's link consent."]);
    expect(upstream.calls).toHaveLength(0);
  });

  it("link re-runs the chain's refusals with a good consent: no config is 409 config_missing", async () => {
    const owner = key();
    const wallet = keypair();
    const walletKey = wallet.publicKey.toBase58();
    const vault = deriveVaultPda(owner).toBase58();
    const { build, upstream } = setup({ accounts: new Map([[vault, sipOwned(vaultAccount(owner))]]) });
    const consent = linkConsentMessage({ programId: SIP_PROGRAM_ID, wallet: walletKey, vault, owner });
    const answer = await build({ action: "link", owner, wallet: walletKey, consentSignature: base64Encode(signBytes(wallet, consent)) });
    expect([answer.status, answer.json.error?.code]).toEqual([409, "config_missing"]);
    expect(methodsOf(upstream.calls)).not.toContain("getLatestBlockhash");
  });
});

/**
 * A chain where `owner` has a vault, EVERY pinned pool prices its leg at the
 * goldens, and USDC and every leg mint are held by the token program the route
 * expects. Every pool is present so a test that spoils one is testing that pool.
 */
function investableChain(owner: string): StubChain {
  return {
    accounts: new Map<string, ReturnType<typeof accountInfo> | null>([
      [deriveVaultPda(owner).toBase58(), sipOwned(vaultAccount(owner), localRent(125))],
      ...pricedPoolEntries(),
      [USDC_MINT, mintAccount(TOKEN_PROGRAM)],
      ...LEG_POOLS.map((leg): [string, ReturnType<typeof accountInfo>] => [leg.mint, mintAccount(TOKEN_2022_PROGRAM)]),
    ]),
  };
}

const instructionsOf = (txBase64: string) => parseLegacyMessage(splitWire(fromB64(txBase64)).message).instructions;

describe("investPolicy", () => {
  /**
   * THE OWNER COULD NOT RE-SIGN HIS OWN POLICY, 2026-09-22.
   *
   * buildSetInvestPolicy allows exactly wSOL, the in-mint and THIS POLICY'S
   * legs (builders.ts allowedMints). This handler bundled the vault's missing
   * accounts from the WHOLE SHELF, so a vault holding wSOL, USDC and SPYx, and
   * re-signing a stored SPYx-only basket, bundled ANTHROPIC — the one account
   * it lacked — and the handler refused its OWN build with "neither wSOL, the
   * policy's in-mint nor one of its legs". Every attempt to sign died here.
   *
   * Harmless while the basket was always the whole shelf. A wall the day the
   * picker let an owner take a subset. The web had the same bug in its half,
   * and fixing that alone changed nothing, because THIS is the half that
   * builds the bytes.
   */
  it("bundles no account for a stock the chosen basket does not name, so a subset basket can be signed at all", async () => {
    const owner = keypair();
    const ownerKey = owner.publicKey.toBase58();
    const vault = deriveVaultPda(ownerKey).toBase58();
    const chain = investableChain(ownerKey);
    // The owner's real vault that day: wSOL, USDC and SPYx open, ANTHROPIC not.
    for (const [mint, program, bytes] of [
      [WSOL_MINT, TOKEN_PROGRAM, 165],
      [USDC_MINT, TOKEN_PROGRAM, 165],
      [SPYX_MINT, TOKEN_2022_PROGRAM, 179],
    ] as const) {
      chain.accounts.set(
        deriveAta(vault, mint, program).toBase58(),
        accountInfo(program, tokenAccountData({ mint, owner: vault, amount: 0n, bytes }), localRent(bytes)),
      );
    }
    const { build } = setup(chain);
    const answer = await build({ action: "investPolicy", owner: ownerKey, weights: [{ mint: SPYX_MINT, weightBps: 10_000 }] });
    expect(answer.status, JSON.stringify(answer.json)).toBe(200);
    const body = answer.json;
    // NOTHING IS CREATED: the only missing account belongs to a stock this
    // policy does not name, and the keeper opens it if it is ever picked.
    expect(instructionsOf(body.txBase64).filter((instruction) => instruction.programId === ATA_PROGRAM)).toHaveLength(0);
    expect(body.vaultTokenAccounts.filter((entry: { create: boolean }) => entry.create)).toEqual([]);
    // And the bytes carry the basket the owner actually chose.
    expect(decodeArgs("set_invest_policy", instructionsOf(body.txBase64).at(-1)!.data).legs).toEqual([
      { mint: SPYX_MINT, weight_bps: 10_000, min_out_rate_wad: 124_719_467_624_105_690n },
    ]);
  });

  it("a first policy: [CU limit, CU price, ATA wSOL, ATA USDC, set_invest_policy] at 90 % and 95 % of the pools, the default caps and the rent of what it creates; it verifies once the owner signs", async () => {
    const owner = keypair();
    const ownerKey = owner.publicKey.toBase58();
    const vault = deriveVaultPda(ownerKey).toBase58();
    const { build, upstream } = setup(investableChain(ownerKey));
    const answer = await build({ action: "investPolicy", owner: ownerKey });
    expect(answer.status).toBe(200);
    const body = answer.json;
    // FOUR targets, but only BUNDLED_VAULT_TOKEN_ACCOUNT_CREATES of them ride along:
    // wSOL and USDC, the first two of vaultTokenAccountTargets' order. The keeper
    // opens each leg's account idempotently on the first invest tick.
    expect(programsOf(body.txBase64)).toEqual([COMPUTE_BUDGET_PROGRAM, COMPUTE_BUDGET_PROGRAM, ATA_PROGRAM, ATA_PROGRAM, SIP_PROGRAM_ID]);
    expect(instructionsOf(body.txBase64).filter((instruction) => instruction.programId === ATA_PROGRAM)).toHaveLength(BUNDLED_VAULT_TOKEN_ACCOUNT_CREATES);
    expect(decodeArgs("set_invest_policy", instructionsOf(body.txBase64)[4]!.data)).toEqual({
      // basketWeightsBps(2): two even halves, summing to 10,000. (At three legs
      // this carried a remainder on the first leg; the rule is still the function's.)
      legs: [
        { mint: SPYX_MINT, weight_bps: 5_000, min_out_rate_wad: 124_719_467_624_105_690n },
        { mint: ANTHROPIC_MINT, weight_bps: 5_000, min_out_rate_wad: 5_277_777_777_777_777_778n },
      ],
      venue_program: JUPITER_V6,
      in_mint: USDC_MINT,
      min_convert_rate_wad: 90_034_840_399_943_305n,
      // 5 USDC split two ways, rounded down, so one $5 purchase still covers every leg.
      min_investment: 2_500_000n,
      max_per_call: 1_000_000_000n,
      max_rolling_30d: 31_000_000_000n,
      enabled: true,
    });
    expect(body.policy).toBe(deriveInvestPda(vault).toBase58());
    expect(body.policyExists).toBe(false);
    // Every target is still listed; `create` says whether THIS transaction opens it.
    expect(body.vaultTokenAccounts).toEqual([
      { mint: WSOL_MINT, address: deriveAta(vault, WSOL_MINT, TOKEN_PROGRAM).toBase58(), tokenProgram: TOKEN_PROGRAM, create: true },
      { mint: USDC_MINT, address: deriveAta(vault, USDC_MINT, TOKEN_PROGRAM).toBase58(), tokenProgram: TOKEN_PROGRAM, create: true },
      { mint: SPYX_MINT, address: deriveAta(vault, SPYX_MINT, TOKEN_2022_PROGRAM).toBase58(), tokenProgram: TOKEN_2022_PROGRAM, create: false },
      { mint: ANTHROPIC_MINT, address: deriveAta(vault, ANTHROPIC_MINT, TOKEN_2022_PROGRAM).toBase58(), tokenProgram: TOKEN_2022_PROGRAM, create: false },
    ]);
    expect(body.floors).toEqual({
      slot: 321,
      marginBps: { convert: 1_000, leg: 500 },
      liveConvertWad: "100038711555492562",
      convertWad: "90034840399943305",
      usdcRawPerSol: "100038711",
      floorUsdcRawPerSol: "90034840",
      // Mapped over LEG_POOLS, so the SYMBOLS are pinned below too: a mapped
      // expectation agrees with an empty answer if the catalogue ever empties.
      legs: LEG_POOLS.map((leg) => ({
        symbol: leg.symbol,
        mint: leg.mint,
        liveWad: String(leg.legWad),
        wad: String(leg.floorWad),
        usdcRawPer1e8: String(leg.usdcRawPer1e8),
        maxUsdcRawPer1e8: String(leg.maxUsdcRawPer1e8),
      })),
    });
    expect(body.floors.legs.map((leg: { symbol: string }) => leg.symbol)).toEqual(["SPYx", "ANTHROPIC"]);
    // The owner is quoted the rent of the two accounts this transaction opens, and
    // NOT of the legs the keeper opens at the crank's expense.
    expect(body.costs).toEqual({
      rentLamports: String(localRent(970) + 2 * localRent(165)),
      signatureFeeLamports: "5000",
      priorityFeeLamports: "30000",
      policyRentLamports: String(localRent(970)),
      tokenAccountRentLamports: String(2 * localRent(165)),
    });
    expect(body.warnings).toEqual([]);
    const verified = verifySignedTransaction(signWire(body.txBase64, owner));
    expect(verified.ok, verified.ok ? "" : verified.detail).toBe(true);
    const methods = methodsOf(upstream.calls);
    expect(methods.filter((method) => method === "getLatestBlockhash")).toHaveLength(1);
    // THE READS BUDGET, PINNED AGAINST THE CALLS THE ROUTE REALLY MAKES, which is
    // what keeps the Helius exposure equal to what each client is charged:
    //   readOwnerAccounts 2 (accounts + the vault's rent)
    //   + readBuildBatch 6 (blockhash, accounts, and one rent per DISTINCT size in
    //     [InvestmentPolicy 970, 165, 179, 191])
    //   = 8 = BUILD_READS_WEIGHT.investPolicy.
    // DROPPING A LEG DID NOT MOVE IT. Losing FIGUREAI took away a 191-byte target
    // but not the 191-byte SIZE — ANTHROPIC still carries it — so the batch still
    // asks four rents and the weight is still 8. It would move at a catalogue with
    // no PreStocks leg left in it, and this assertion is what would say so.
    expect(methods, "BUILD_READS_WEIGHT.investPolicy must equal the upstream calls investPolicy really makes").toHaveLength(BUILD_READS_WEIGHT.investPolicy);
  });

  it("creates only what the vault lacks, and at most the bundle: an existing USDC account is left alone, a wSOL address holding only lamports is still created, SPYx rides the free slot, the two PreStocks are left to the keeper, and an existing policy costs no policy rent", async () => {
    const owner = keypair();
    const ownerKey = owner.publicKey.toBase58();
    const vault = deriveVaultPda(ownerKey).toBase58();
    const chain = investableChain(ownerKey);
    chain.accounts.set(deriveAta(vault, USDC_MINT, TOKEN_PROGRAM).toBase58(), tokenAccountInfo(TOKEN_PROGRAM));
    chain.accounts.set(deriveAta(vault, WSOL_MINT, TOKEN_PROGRAM).toBase58(), accountInfo(SYSTEM_PROGRAM, new Uint8Array(0), 5_000));
    chain.accounts.set(deriveInvestPda(vault).toBase58(), sipOwned(policyAccount(vault), localRent(970)));
    const { build } = setup(chain);
    const answer = await build({ action: "investPolicy", owner: ownerKey, maxPerCall: "10000000", maxRolling30d: "50000000" });
    expect(answer.status).toBe(200);
    expect(programsOf(answer.json.txBase64)).toEqual([COMPUTE_BUDGET_PROGRAM, COMPUTE_BUDGET_PROGRAM, ATA_PROGRAM, ATA_PROGRAM, SIP_PROGRAM_ID]);
    const instructions = instructionsOf(answer.json.txBase64);
    // The bundle takes the first BUNDLED_VAULT_TOKEN_ACCOUNT_CREATES MISSING targets in
    // vaultTokenAccountTargets' order, so an existing USDC account lets SPYx ride
    // along and ANTHROPIC is still left to the keeper.
    expect([instructions[2]!.accountKeys[3], instructions[3]!.accountKeys[3]]).toEqual([WSOL_MINT, SPYX_MINT]);
    expect(answer.json.vaultTokenAccounts.map((entry: { mint: string; create: boolean }) => [entry.mint, entry.create])).toEqual([
      [WSOL_MINT, true],
      [USDC_MINT, false],
      [SPYX_MINT, true],
      [ANTHROPIC_MINT, false],
    ]);
    expect(answer.json.policyExists).toBe(true);
    expect(answer.json.costs).toMatchObject({
      rentLamports: String(localRent(165) + localRent(179)),
      policyRentLamports: "0",
      tokenAccountRentLamports: String(localRent(165) + localRent(179)),
    });
    expect(decodeArgs("set_invest_policy", instructions[4]!.data)).toMatchObject({ max_per_call: 10_000_000n, max_rolling_30d: 50_000_000n, enabled: true });
    const verified = verifySignedTransaction(signWire(answer.json.txBase64, owner));
    expect(verified.ok, verified.ok ? "" : verified.detail).toBe(true);
  });

  it("with every account in place: [CU limit, CU price, set_invest_policy] alone, enabled false when asked; past 1,000 USDC a call it warns that convert is no longer held to 1 SOL", async () => {
    const owner = key();
    const vault = deriveVaultPda(owner).toBase58();
    const chain = investableChain(owner);
    chain.accounts.set(deriveAta(vault, WSOL_MINT, TOKEN_PROGRAM).toBase58(), tokenAccountInfo(TOKEN_PROGRAM));
    chain.accounts.set(deriveAta(vault, USDC_MINT, TOKEN_PROGRAM).toBase58(), tokenAccountInfo(TOKEN_PROGRAM));
    // Every one of the four, legs included, so nothing below is 200 merely because
    // an account the route wanted was never asked about.
    for (const leg of LEG_POOLS) chain.accounts.set(deriveAta(vault, leg.mint, TOKEN_2022_PROGRAM).toBase58(), tokenAccountInfo(TOKEN_2022_PROGRAM, leg.mint === SPYX_MINT ? 179 : 191));
    const { build } = setup(chain);
    const paused = await build({ action: "investPolicy", owner, enabled: false });
    expect(programsOf(paused.json.txBase64)).toEqual([COMPUTE_BUDGET_PROGRAM, COMPUTE_BUDGET_PROGRAM, SIP_PROGRAM_ID]);
    expect(decodeArgs("set_invest_policy", instructionsOf(paused.json.txBase64)[2]!.data)).toMatchObject({ enabled: false });
    expect([paused.json.warnings, paused.json.costs.rentLamports]).toEqual([[], String(localRent(970))]);
    const wide = await build({ action: "investPolicy", owner, maxPerCall: "1000000001", maxRolling30d: "31000000031" });
    expect(wide.status).toBe(200);
    expect(wide.json.warnings).toEqual(["convert_per_call_above_1_sol"]);
  });

  it.each<[string, (chain: StubChain) => void]>([
    ["the SOL/USDC pool missing", (chain) => void chain.accounts.delete(SOL_USDC_POOL)],
    ["the SPYx pool with its mints swapped", (chain) => void chain.accounts.set(SPYX_USDC_POOL, accountInfo(RAYDIUM_CLMM, clmmPoolAccount(USDC_MINT, SPYX_MINT, LEG_POOLS[0]!.sqrtPriceX64, [8, 6])))],
    ["the SOL/USDC pool owned by another program", (chain) => void chain.accounts.set(SOL_USDC_POOL, accountInfo(key(), clmmPoolAccount(WSOL_MINT, USDC_MINT, SOL_SQRT_PRICE)))],
    // A PreStocks pool is as load-bearing as SPYx's: either leg unpriced is no
    // policy. Both of FIGUREAI's old cases move onto ANTHROPIC rather than being
    // dropped — a pool that is gone and one held by the wrong program are
    // different bugs, and each must be fatal on its own.
    ["the ANTHROPIC pool missing", (chain) => void chain.accounts.delete(LEG_POOLS[1]!.pool)],
    [
      "the ANTHROPIC pool owned by another program",
      (chain) => void chain.accounts.set(LEG_POOLS[1]!.pool, accountInfo(key(), clmmPoolAccount(ANTHROPIC_MINT, USDC_MINT, LEG_POOLS[1]!.sqrtPriceX64, [9, 6]))),
    ],
  ])("%s is 502 price_unavailable, and nothing is built", async (_, spoil) => {
    const owner = key();
    const chain = investableChain(owner);
    spoil(chain);
    const answer = await setup(chain).build({ action: "investPolicy", owner });
    expect([answer.status, answer.json.error?.code]).toEqual([502, "price_unavailable"]);
    expect(answer.json).not.toHaveProperty("txBase64");
  });

  it("any leg mint held by classic Token, or a USDC mint that does not exist, is 409 mint_unexpected naming it", async () => {
    const owner = key();
    // Each leg on its own: the check runs over the whole catalogue, not just its
    // head. The count is asserted so a shrinking catalogue cannot turn this into
    // a loop that tests nothing.
    expect(LEG_POOLS.length).toBe(2);
    for (const leg of LEG_POOLS) {
      const classic = investableChain(owner);
      classic.accounts.set(leg.mint, mintAccount(TOKEN_PROGRAM));
      const wrong = await setup(classic).build({ action: "investPolicy", owner });
      expect([wrong.status, wrong.json.error?.code, (wrong.json.error as { mint?: string } | undefined)?.mint]).toEqual([409, "mint_unexpected", leg.mint]);
    }
    const absent = investableChain(owner);
    absent.accounts.delete(USDC_MINT);
    const missing = await setup(absent).build({ action: "investPolicy", owner });
    expect([missing.json.error?.code, (missing.json.error as { mint?: string } | undefined)?.mint]).toEqual(["mint_unexpected", USDC_MINT]);
  });

  it("no vault is 409 vault_missing, with no blockhash read; an unreadable chain is 502 unreadable and never quotes the endpoint", async () => {
    const { build, upstream } = setup();
    const answer = await build({ action: "investPolicy", owner: key() });
    expect([answer.status, answer.json.error?.code]).toEqual([409, "vault_missing"]);
    expect(methodsOf(upstream.calls)).not.toContain("getLatestBlockhash");
    const down = await setup({ accounts: new Map(), down: true }).build({ action: "investPolicy", owner: key() });
    expect([down.status, down.json.error?.code]).toEqual([502, "unreadable"]);
    expect(down.text).not.toContain(SECRET_QUERY);
  });

  it("caps the program would refuse are 400 invalid_policy before any read", async () => {
    const { build, upstream } = setup();
    // 2,499,999 is one raw unit under the two-leg minimum investment (5 USDC / 2).
    // At one leg the minimum was the whole 5 USDC and this read 4999999, at three
    // legs 1666665; the number moves because the basket does, and it still names a
    // cap the program refuses.
    for (const caps of [{ maxRolling30d: "999999999" }, { maxPerCall: "2499999", maxRolling30d: "2499999" }]) {
      const answer = await build({ action: "investPolicy", owner: key(), ...caps });
      expect([answer.status, answer.json.error?.code]).toEqual([400, "invalid_policy"]);
      expect(answer.json.error?.problems?.join(" ")).toMatch(/minInvestment <= maxPerCall <= maxRolling30d/);
    }
    expect(upstream.calls).toHaveLength(0);
  });

  // ── what the basket holds and what it may spend ────────────────────────────

  it("a request that names none of minInvestment, weights or venue builds the SAME BYTES as one that names today's values: the three fields are additions, not a new default", async () => {
    const owner = key();
    const { build } = setup(investableChain(owner));
    const implicit = await build({ action: "investPolicy", owner });
    const explicit = await build({
      action: "investPolicy",
      owner,
      minInvestment: "2500000",
      weights: OFFERED_LEGS.map((leg, index) => ({ mint: leg.mint, weightBps: basketWeightsBps(OFFERED_LEGS.length)[index]! })),
      venue: "jupiter-v6",
    });
    expect([implicit.status, explicit.status]).toEqual([200, 200]);
    expect(explicit.json.txBase64).toBe(implicit.json.txBase64);
    expect(explicit.json.costs).toEqual(implicit.json.costs);
    expect(explicit.json.floors).toEqual(implicit.json.floors);
    expect(explicit.json.vaultTokenAccounts).toEqual(implicit.json.vaultTokenAccounts);
  });

  it("weights are applied BY MINT, not by position: sent in the catalogue's reverse order, each share still lands on its own stock, beside its own floor", async () => {
    const owner = keypair();
    const ownerKey = owner.publicKey.toBase58();
    const { build, upstream } = setup(investableChain(ownerKey));
    expect(LEG_POOLS.length).toBe(2);
    const answer = await build({
      action: "investPolicy",
      owner: ownerKey,
      // REVERSED, and deliberately lopsided: read positionally this would put
      // 7,000 on SPYx and 3,000 on ANTHROPIC, sum to 10,000 all the same, and
      // the chain would accept the wrong basket without a word.
      weights: [
        { mint: ANTHROPIC_MINT, weightBps: 7_000 },
        { mint: SPYX_MINT, weightBps: 3_000 },
      ],
      minInvestment: "1000000",
    });
    expect(answer.status).toBe(200);
    const args = decodeArgs("set_invest_policy", instructionsOf(answer.json.txBase64)[4]!.data) as {
      legs: { mint: string; weight_bps: number; min_out_rate_wad: bigint }[];
      min_investment: bigint;
      venue_program: string;
    };
    // The legs keep OFFERED_LEGS' order, because the floors are read in it; only
    // the shares follow the mints.
    expect(args.legs).toEqual([
      { mint: SPYX_MINT, weight_bps: 3_000, min_out_rate_wad: LEG_POOLS[0]!.floorWad },
      { mint: ANTHROPIC_MINT, weight_bps: 7_000, min_out_rate_wad: LEG_POOLS[1]!.floorWad },
    ]);
    expect(args.min_investment).toBe(1_000_000n);
    expect(args.venue_program).toBe(JUPITER_V6);
    const verified = verifySignedTransaction(signWire(answer.json.txBase64, owner));
    expect(verified.ok, verified.ok ? "" : verified.detail).toBe(true);
    // The three fields buy no extra upstream call.
    expect(methodsOf(upstream.calls)).toHaveLength(BUILD_READS_WEIGHT.investPolicy);
  });

  it.each([
    ["weights that are not an array", { weights: { [SPYX_MINT]: 10_000 } }, /must be an array/],
    ["a weight that is not an object", { weights: [10_000, 0] }, /weights\[0\] must be an object/],
    ["a weight carrying a field of its own", { weights: [{ mint: SPYX_MINT, weightBps: 5_000, pool: SOL_USDC_POOL }, { mint: ANTHROPIC_MINT, weightBps: 5_000 }] }, /weights\[0\]: Unexpected field pool/],
    ["a mint that is not a key", { weights: [{ mint: "SPYx", weightBps: 10_000 }] }, /weights\[0\]\.mint must be a base58/],
    ["a mint named twice", { weights: [{ mint: SPYX_MINT, weightBps: 5_000 }, { mint: SPYX_MINT, weightBps: 5_000 }] }, /names .* again/],
    ["the in-mint in the basket", { weights: [{ mint: USDC_MINT, weightBps: 5_000 }, { mint: SPYX_MINT, weightBps: 5_000 }] }, /the currency the basket spends/],
    ["a share of zero", { weights: [{ mint: SPYX_MINT, weightBps: 0 }, { mint: ANTHROPIC_MINT, weightBps: 10_000 }] }, /greater than zero/],
    ["a negative share", { weights: [{ mint: SPYX_MINT, weightBps: -1 }, { mint: ANTHROPIC_MINT, weightBps: 10_001 }] }, /greater than zero/],
    ["a fractional share", { weights: [{ mint: SPYX_MINT, weightBps: 33.5 }, { mint: ANTHROPIC_MINT, weightBps: 9_966.5 }] }, /whole number/],
    ["a share written as a string", { weights: [{ mint: SPYX_MINT, weightBps: "5000" }, { mint: ANTHROPIC_MINT, weightBps: 5_000 }] }, /whole number/],
    ["an empty basket", { weights: [] }, /names no stock at all/],
    ["a stock SaverFi does not offer", { weights: [{ mint: SPYX_MINT, weightBps: 5_000 }, { mint: ANTHROPIC_MINT, weightBps: 4_000 }, { mint: WSOL_MINT, weightBps: 1_000 }] }, /does not offer/],
    ["shares one short of the whole", { weights: [{ mint: SPYX_MINT, weightBps: 5_000 }, { mint: ANTHROPIC_MINT, weightBps: 4_999 }] }, /add up to exactly 10000 basis points; these add up to 9999/],
    ["shares one over the whole", { weights: [{ mint: SPYX_MINT, weightBps: 5_000 }, { mint: ANTHROPIC_MINT, weightBps: 5_001 }] }, /add up to exactly 10000/],
  ])("%s is 400 bad_request naming what was wrong, with no chain read and nothing filled in", async (_, body, problem) => {
    const owner = key();
    const { build, upstream } = setup(investableChain(owner));
    const answer = await build({ action: "investPolicy", owner, ...body });
    expect([answer.status, answer.json.error?.code]).toEqual([400, "bad_request"]);
    expect(answer.json.error?.message).toMatch(problem);
    expect(answer.json).not.toHaveProperty("txBase64");
    expect(upstream.calls).toHaveLength(0);
  });

  it("the venue is a NAME from a closed list: a program id is refused however valid, and the list is one long", async () => {
    const owner = key();
    // ONE LONG, AND IT IS THE ONE THE KEEPER ROUTES. While this read
    // ["raydium-clmm"] every policy this route could build was refused by the
    // keeper before the wrap, for the life of the policy.
    expect(OFFERED_VENUES).toEqual(["jupiter-v6"]);
    const { build, upstream } = setup(investableChain(owner));
    for (const venue of [JUPITER_V6, RAYDIUM_CLMM, key(), "raydium-clmm", "Jupiter", "jupiter", "orca-whirlpool", "", 0, null, { name: "jupiter-v6" }, ["jupiter-v6"]]) {
      const answer = await build({ action: "investPolicy", owner, venue });
      expect([answer.status, answer.json.error?.code], `venue ${JSON.stringify(venue)} must be refused`).toEqual([400, "bad_request"]);
      expect(answer.json.error?.message).toMatch(/venue must be one of: jupiter-v6\./);
      expect(answer.json.error?.message).toMatch(/never a program address/);
      expect(answer.json).not.toHaveProperty("txBase64");
    }
    // A name the table does not hold, however Object.prototype answers for it.
    for (const venue of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      const answer = await build({ action: "investPolicy", owner, venue });
      expect([answer.status, answer.json.error?.code], `venue ${venue} must be refused`).toEqual([400, "bad_request"]);
    }
    expect(upstream.calls).toHaveLength(0);
  });

  /**
   * THE BYTE THE KEEPER WILL ACCEPT, HELD TO THE VECTOR BOTH PACKAGES ASSERT
   * AGAINST (test/fixtures/keeper-policy.ts ROUTED_VENUE).
   *
   * This is the check that was missing while the one offered name was
   * raydium-clmm: the route was internally consistent, its tests were green,
   * and every policy it could build was refused by the keeper before the wrap,
   * at any balance, for the life of the policy. A venue set is only correct
   * relative to the keeper, so it is asserted relative to the keeper.
   */
  it("offers the one venue the keeper routes, by the vector both packages assert against, and can never offer the retired one again", async () => {
    expect(JUPITER_V6).toBe(ROUTED_VENUE.web.programId);
    expect(JUPITER_V6).toBe(ROUTED_VENUE.keeper.programId);
    expect(OFFERED_VENUES).toEqual([ROUTED_VENUE.web.venueName]);
    expect(OFFERED_VENUES).toHaveLength(ROUTED_VENUE.routableCount);
    expect(OFFERED_VENUES).not.toContain(ROUTED_VENUE.retired.venueName);
    expect(RAYDIUM_CLMM).toBe(ROUTED_VENUE.retired.programId);

    // AND THE BYTES CARRY IT. A name is only worth checking if the transaction
    // built from it names the program the keeper will route through.
    const owner = keypair();
    const ownerKey = owner.publicKey.toBase58();
    const { build } = setup(investableChain(ownerKey));
    const answer = await build({ action: "investPolicy", owner: ownerKey, venue: ROUTED_VENUE.web.venueName });
    expect(answer.status).toBe(200);
    const args = decodeArgs("set_invest_policy", instructionsOf(answer.json.txBase64)[4]!.data) as { venue_program: string };
    expect(args.venue_program).toBe(ROUTED_VENUE.keeper.programId);
    expect(args.venue_program).not.toBe(ROUTED_VENUE.retired.programId);
  });

  it.each([
    ["as a number", 5_000_000],
    ["with a sign", "-1"],
    ["fractional", "5000000.5"],
    ["with a thousands separator", "5,000,000"],
    ["in hex", "0x4c4b40"],
    ["as null", null],
    ["over a u64", "18446744073709551616"],
  ])("minInvestment %s is 400 bad_request with no chain read", async (_, minInvestment) => {
    const owner = key();
    const { build, upstream } = setup(investableChain(owner));
    const answer = await build({ action: "investPolicy", owner, minInvestment });
    expect([answer.status, answer.json.error?.code]).toEqual([400, "bad_request"]);
    expect(answer.json.error?.message).toMatch(/minInvestment is a USDC raw amount/);
    expect(upstream.calls).toHaveLength(0);
  });

  it("a minimum purchase the program would refuse is 400 invalid_policy before any read: zero, and one above the per-call cap", async () => {
    const owner = key();
    const { build, upstream } = setup(investableChain(owner));
    for (const caps of [{ minInvestment: "0" }, { minInvestment: "2000000000" }]) {
      const answer = await build({ action: "investPolicy", owner, ...caps });
      expect([answer.status, answer.json.error?.code]).toEqual([400, "invalid_policy"]);
      expect(answer.json.error?.problems?.join(" ")).toMatch(/minInvestment <= maxPerCall <= maxRolling30d/);
    }
    expect(upstream.calls).toHaveLength(0);
  });

  /**
   * THE BASKET IS A SUBSET NOW. Until the picker existed the route demanded a
   * share for every offered stock, so "choosing" could only ever mean choosing
   * the shares. The owner asked to choose the stocks themselves, and the program
   * has always taken 1..MAX_LEGS distinct mints summing to 10,000 — so what is
   * pinned here is that ONE stock at 10,000 bps builds, and builds the policy
   * that names only it, beside its own floor.
   *
   * AND THAT THE FLOORS BLOCK IS UNCHANGED BY IT. The answer still prices the
   * whole shelf: it is one getMultipleAccounts either way, and the page holds
   * every one of those legs to the rates it showed before it will sign. What
   * narrows is the POLICY, not the reading.
   */
  it("one stock at the whole weight builds a one-leg policy, and still prices the whole shelf", async () => {
    const owner = keypair();
    const ownerKey = owner.publicKey.toBase58();
    const { build } = setup(investableChain(ownerKey));
    const answer = await build({ action: "investPolicy", owner: ownerKey, weights: [{ mint: SPYX_MINT, weightBps: 10_000 }] });
    expect(answer.status).toBe(200);
    expect(decodeArgs("set_invest_policy", instructionsOf(answer.json.txBase64)[4]!.data)).toMatchObject({
      legs: [{ mint: SPYX_MINT, weight_bps: 10_000, min_out_rate_wad: LEG_POOLS[0]!.floorWad }],
    });
    // The floors the page checks are still both legs, in the catalogue's order.
    expect(answer.json.floors.legs.map((leg: { mint: string }) => leg.mint)).toEqual(OFFERED_LEGS.map((leg) => leg.mint));
    const verified = verifySignedTransaction(signWire(answer.json.txBase64, owner));
    expect(verified.ok, verified.ok ? "" : verified.detail).toBe(true);
  });

  /** The SECOND stock alone, so a one-leg basket cannot pass by taking the first floor by accident. */
  it("the leg a one-stock basket carries is its own, not the catalogue's first", async () => {
    const owner = key();
    const { build } = setup(investableChain(owner));
    const answer = await build({ action: "investPolicy", owner, weights: [{ mint: ANTHROPIC_MINT, weightBps: 10_000 }] });
    expect(answer.status).toBe(200);
    expect(decodeArgs("set_invest_policy", instructionsOf(answer.json.txBase64)[4]!.data)).toMatchObject({
      legs: [{ mint: ANTHROPIC_MINT, weight_bps: 10_000, min_out_rate_wad: LEG_POOLS[1]!.floorWad }],
    });
  });

  it("the three fields travel together: a whole basket the owner chose, with its own minimum and venue", async () => {
    const owner = keypair();
    const ownerKey = owner.publicKey.toBase58();
    const { build } = setup(investableChain(ownerKey));
    const answer = await build({
      action: "investPolicy",
      owner: ownerKey,
      weights: [
        { mint: SPYX_MINT, weightBps: 2_500 },
        { mint: ANTHROPIC_MINT, weightBps: 7_500 },
      ],
      minInvestment: "5000000",
      venue: "jupiter-v6",
      maxPerCall: "30000000000",
      maxRolling30d: "30000000000",
      enabled: true,
    });
    expect(answer.status).toBe(200);
    expect(decodeArgs("set_invest_policy", instructionsOf(answer.json.txBase64)[4]!.data)).toMatchObject({
      legs: [
        { mint: SPYX_MINT, weight_bps: 2_500, min_out_rate_wad: LEG_POOLS[0]!.floorWad },
        { mint: ANTHROPIC_MINT, weight_bps: 7_500, min_out_rate_wad: LEG_POOLS[1]!.floorWad },
      ],
      venue_program: JUPITER_V6,
      in_mint: USDC_MINT,
      min_investment: 5_000_000n,
      max_per_call: 30_000_000_000n,
      max_rolling_30d: 30_000_000_000n,
      enabled: true,
    });
    const verified = verifySignedTransaction(signWire(answer.json.txBase64, owner));
    expect(verified.ok, verified.ok ? "" : verified.detail).toBe(true);
  });
});

describe("pauseInvesting", () => {
  /** A vault with a policy whose floors and caps are not the product's, and no pinned pool on chain. */
  function unpricedChain(owner: string, policy: Record<string, unknown> = {}): StubChain {
    const vault = deriveVaultPda(owner).toBase58();
    return {
      accounts: new Map([
        [vault, sipOwned(vaultAccount(owner), localRent(125))],
        [deriveInvestPda(vault).toBase58(), sipOwned(policyAccount(vault, { legs: [{ mint: SPYX_MINT, weight_bps: 10_000, min_out_rate_wad: 111n }], min_convert_rate_wad: 222n, ...policy }), localRent(970))],
      ]),
    };
  }

  it("re-signs the stored policy with investing off and reads no pool: it builds with both pinned pools gone, and verifies once the owner signs", async () => {
    const owner = keypair();
    const ownerKey = owner.publicKey.toBase58();
    const { build, upstream } = setup(unpricedChain(ownerKey));
    const answer = await build({ action: "pauseInvesting", owner: ownerKey });
    expect(answer.status).toBe(200);
    expect(programsOf(answer.json.txBase64)).toEqual([COMPUTE_BUDGET_PROGRAM, COMPUTE_BUDGET_PROGRAM, SIP_PROGRAM_ID]);
    expect(decodeArgs("set_invest_policy", instructionsOf(answer.json.txBase64)[2]!.data)).toEqual({
      legs: [{ mint: SPYX_MINT, weight_bps: 10_000, min_out_rate_wad: 111n }],
      venue_program: RAYDIUM_CLMM,
      in_mint: USDC_MINT,
      min_convert_rate_wad: 222n,
      min_investment: 5_000_000n,
      max_per_call: 10_000_000n,
      max_rolling_30d: 50_000_000n,
      enabled: false,
    });
    expect(answer.json.costs).toEqual({ rentLamports: "0", signatureFeeLamports: "5000", priorityFeeLamports: "30000" });
    const requests = upstream.calls.flatMap((call) => (Array.isArray(call.body) ? call.body : [call.body]) as { method: string; params: unknown[] }[]);
    const addresses = requests.filter((request) => request.method === "getMultipleAccounts").flatMap((request) => request.params[0] as string[]);
    expect(addresses).not.toContain(SOL_USDC_POOL);
    expect(addresses).not.toContain(SPYX_USDC_POOL);
    expect(methodsOf(upstream.calls)).toHaveLength(BUILD_READS_WEIGHT.pauseInvesting);
    const verified = verifySignedTransaction(signWire(answer.json.txBase64, owner));
    expect(verified.ok, verified.ok ? "" : verified.detail).toBe(true);

    // Signing again and resuming set new floors: on the same chain they still need today's prices.
    for (const enabled of [true, false]) {
      const resigned = await build({ action: "investPolicy", owner: ownerKey, maxPerCall: "10000000", maxRolling30d: "50000000", enabled });
      expect([resigned.status, resigned.json.error?.code]).toEqual([502, "price_unavailable"]);
    }
  });

  it("no vault is 409 vault_missing; no policy 409 policy_missing; a paused policy 409 already_paused; an unreadable chain 502 unreadable; none reads a blockhash", async () => {
    const owner = key();
    const noVault = setup();
    expect((await noVault.build({ action: "pauseInvesting", owner })).json.error?.code).toBe("vault_missing");
    const noPolicy = setup({ accounts: new Map([[deriveVaultPda(owner).toBase58(), sipOwned(vaultAccount(owner), localRent(125))]]) });
    const missing = await noPolicy.build({ action: "pauseInvesting", owner });
    expect([missing.status, missing.json.error?.code, missing.json.error?.message]).toEqual([409, "policy_missing", "Your vault has no investment policy to pause."]);
    const paused = setup(unpricedChain(owner, { enabled: false }));
    const again = await paused.build({ action: "pauseInvesting", owner });
    expect([again.status, again.json.error?.code, again.json.error?.message]).toEqual([409, "already_paused", "Investing is already paused."]);
    for (const { upstream } of [noVault, noPolicy, paused]) expect(methodsOf(upstream.calls)).not.toContain("getLatestBlockhash");
    const down = await setup({ accounts: new Map(), down: true }).build({ action: "pauseInvesting", owner });
    expect([down.status, down.json.error?.code]).toEqual([502, "unreadable"]);
  });

  it("a pause naming caps or a switch is 400 bad_request with no read: a pause changes nothing but the switch", async () => {
    const { build, upstream } = setup();
    for (const extra of [{ maxPerCall: "10000000" }, { enabled: false }]) {
      const answer = await build({ action: "pauseInvesting", owner: key(), ...extra });
      expect([answer.status, answer.json.error?.code]).toEqual([400, "bad_request"]);
    }
    expect(upstream.calls).toHaveLength(0);
  });
});

describe("withdraw", () => {
  it("builds [CU limit, CU price, withdraw] for exactly what the vault can release, with one blockhash; it verifies once the owner signs", async () => {
    const owner = keypair();
    const ownerKey = owner.publicKey.toBase58();
    const vault = deriveVaultPda(ownerKey).toBase58();
    const { build, upstream } = setup({ accounts: new Map([[vault, sipOwned(vaultAccount(ownerKey), 200_000_000 + localRent(125))]]) });
    const answer = await build({ action: "withdraw", owner: ownerKey, lamports: "200000000" });
    expect(answer.status).toBe(200);
    expect(programsOf(answer.json.txBase64)).toEqual([COMPUTE_BUDGET_PROGRAM, COMPUTE_BUDGET_PROGRAM, SIP_PROGRAM_ID]);
    expect(decodeArgs("withdraw", instructionsOf(answer.json.txBase64)[2]!.data)).toEqual({ amount: 200_000_000n });
    expect(answer.json.accounts).toEqual({ owner: ownerKey, vault });
    expect(answer.json.withdrawableLamports).toBe("200000000");
    expect(answer.json.costs).toEqual({ rentLamports: "0", signatureFeeLamports: "5000", priorityFeeLamports: "4000" });
    expect(methodsOf(upstream.calls)).toHaveLength(BUILD_READS_WEIGHT.withdraw);
    const verified = verifySignedTransaction(signWire(answer.json.txBase64, owner));
    expect(verified.ok, verified.ok ? "" : verified.detail).toBe(true);
  });

  it("one lamport more than the vault can release is 422 above_withdrawable, saying how much it can, with no blockhash read", async () => {
    const owner = key();
    const vault = deriveVaultPda(owner).toBase58();
    const { build, upstream } = setup({ accounts: new Map([[vault, sipOwned(vaultAccount(owner), 200_000_000 + localRent(125))]]) });
    const answer = await build({ action: "withdraw", owner, lamports: "200000001" });
    expect([answer.status, answer.json.error?.code, (answer.json.error as { withdrawableLamports?: string } | undefined)?.withdrawableLamports]).toEqual([422, "above_withdrawable", "200000000"]);
    expect(methodsOf(upstream.calls)).not.toContain("getLatestBlockhash");
  });

  it("zero is 400 zero_amount before any read; no vault is 409 vault_missing", async () => {
    const { build, upstream } = setup();
    expect((await build({ action: "withdraw", owner: key(), lamports: "0" })).json.error?.code).toBe("zero_amount");
    expect(upstream.calls).toHaveLength(0);
    expect((await build({ action: "withdraw", owner: key(), lamports: "1" })).json.error?.code).toBe("vault_missing");
  });
});

describe("withdrawToken", () => {
  /** The vault's SPYx account: 179 bytes under Token-2022, its owner field the vault unless said otherwise. */
  const spyxAccount = (vault: string, amount: bigint, fields: { readonly owner?: string; readonly state?: number } = {}) =>
    accountInfo(TOKEN_2022_PROGRAM, tokenAccountData({ mint: SPYX_MINT, owner: fields.owner ?? vault, amount, state: fields.state, bytes: 179 }), localRent(179));

  it("reads the source account the request names by address, from its own bytes, takes the token program from the chain, never lists the vault, and quotes the rent of the owner's new account", async () => {
    const owner = keypair();
    const ownerKey = owner.publicKey.toBase58();
    const vault = deriveVaultPda(ownerKey).toBase58();
    const holding = key();
    const chain: StubChain = { accounts: new Map([[vault, sipOwned(vaultAccount(ownerKey), localRent(125))], [holding, spyxAccount(vault, 12_345_678n)]]) };
    const { build, upstream } = setup(chain);
    const answer = await build({ action: "withdrawToken", owner: ownerKey, mint: SPYX_MINT, amountRaw: "12345678", vaultToken: holding });
    expect(answer.status).toBe(200);
    expect(programsOf(answer.json.txBase64)).toEqual([COMPUTE_BUDGET_PROGRAM, COMPUTE_BUDGET_PROGRAM, SIP_PROGRAM_ID]);
    expect(decodeArgs("withdraw_token", instructionsOf(answer.json.txBase64)[2]!.data)).toEqual({ amount: 12_345_678n });
    const ownerToken = deriveAta(ownerKey, SPYX_MINT, TOKEN_2022_PROGRAM).toBase58();
    expect(answer.json.accounts).toMatchObject({ owner: ownerKey, vault, token_mint: SPYX_MINT, vault_token: holding, owner_token: ownerToken, token_program: TOKEN_2022_PROGRAM });
    expect([answer.json.vaultTokenAccount, answer.json.ownerTokenAccount, answer.json.heldRaw]).toEqual([holding, ownerToken, "12345678"]);
    expect([answer.json.ownerTokenAccountExists, answer.json.ownerTokenAccountRentLamports]).toEqual([false, String(localRent(179))]);
    expect(answer.json.costs).toEqual({ rentLamports: String(localRent(179)), signatureFeeLamports: "5000", priorityFeeLamports: "20000" });
    const methods = methodsOf(upstream.calls);
    expect(methods).toHaveLength(BUILD_READS_WEIGHT.withdrawToken);
    expect(methods).not.toContain("getTokenAccountsByOwner");
    const verified = verifySignedTransaction(signWire(answer.json.txBase64, owner));
    expect(verified.ok, verified.ok ? "" : verified.detail).toBe(true);
  });

  it("wSOL comes out as SOL, so no rent is quoted; nor for an owner's account that already exists", async () => {
    const owner = key();
    const vault = deriveVaultPda(owner).toBase58();
    const wsol = deriveAta(vault, WSOL_MINT, TOKEN_PROGRAM).toBase58();
    const spyx = key();
    const chain: StubChain = {
      accounts: new Map([
        [vault, sipOwned(vaultAccount(owner), localRent(125))],
        [wsol, accountInfo(TOKEN_PROGRAM, tokenAccountData({ mint: WSOL_MINT, owner: vault, amount: 100_000_000n }), localRent(165) + 100_000_000)],
        [spyx, spyxAccount(vault, 5n)],
      ]),
    };
    const { build } = setup(chain);
    const unwrapped = await build({ action: "withdrawToken", owner, mint: WSOL_MINT, amountRaw: "100000000", vaultToken: wsol });
    expect([unwrapped.status, unwrapped.json.ownerTokenAccountRentLamports, unwrapped.json.costs.rentLamports]).toEqual([200, "0", "0"]);
    chain.accounts.set(deriveAta(owner, SPYX_MINT, TOKEN_2022_PROGRAM).toBase58(), tokenAccountInfo(TOKEN_2022_PROGRAM, 179));
    const held = await build({ action: "withdrawToken", owner, mint: SPYX_MINT, amountRaw: "5", vaultToken: spyx });
    expect([held.json.ownerTokenAccountExists, held.json.ownerTokenAccountRentLamports]).toEqual([true, "0"]);
  });

  it("an account that is gone, another vault's, of another mint, empty, uninitialized or not a token account is 422 not_held; more than it holds is 422 above_holding with what it holds; neither reads a blockhash", async () => {
    const owner = key();
    const vault = deriveVaultPda(owner).toBase58();
    const [holding, theirs, usdc, empty, uninitialized] = [key(), key(), key(), key(), key()];
    const chain: StubChain = {
      accounts: new Map([
        [vault, sipOwned(vaultAccount(owner), localRent(125))],
        [holding, spyxAccount(vault, 12_345_678n)],
        [theirs, spyxAccount(vault, 12_345_678n, { owner: deriveVaultPda(key()).toBase58() })],
        [usdc, accountInfo(TOKEN_PROGRAM, tokenAccountData({ mint: USDC_MINT, owner: vault, amount: 9n }))],
        [empty, spyxAccount(vault, 0n)],
        [uninitialized, spyxAccount(vault, 7n, { state: 0 })],
        [SPYX_MINT, mintAccount(TOKEN_2022_PROGRAM)],
      ]),
    };
    const { build, upstream } = setup(chain);
    for (const vaultToken of [key(), theirs, usdc, empty, uninitialized, SPYX_MINT, vault]) {
      const answer = await build({ action: "withdrawToken", owner, mint: SPYX_MINT, amountRaw: "1", vaultToken });
      expect([vaultToken, answer.status, answer.json.error?.code]).toEqual([vaultToken, 422, "not_held"]);
    }
    const above = await build({ action: "withdrawToken", owner, mint: SPYX_MINT, amountRaw: "12345679", vaultToken: holding });
    expect([above.status, above.json.error?.code, (above.json.error as { heldRaw?: string } | undefined)?.heldRaw]).toEqual([422, "above_holding", "12345678"]);
    expect(methodsOf(upstream.calls)).not.toContain("getLatestBlockhash");
  });

  it("zero is 400 zero_amount before any read; no vault is 409 vault_missing; an unreadable chain is 502 unreadable", async () => {
    const { build, upstream } = setup();
    expect((await build({ action: "withdrawToken", owner: key(), mint: SPYX_MINT, amountRaw: "0", vaultToken: key() })).json.error?.code).toBe("zero_amount");
    expect(upstream.calls).toHaveLength(0);
    expect((await build({ action: "withdrawToken", owner: key(), mint: SPYX_MINT, amountRaw: "1", vaultToken: key() })).json.error?.code).toBe("vault_missing");
    const down = await setup({ accounts: new Map(), down: true }).build({ action: "withdrawToken", owner: key(), mint: SPYX_MINT, amountRaw: "1", vaultToken: key() });
    expect([down.status, down.json.error?.code]).toEqual([502, "unreadable"]);
    expect(down.text).not.toContain(SECRET_QUERY);
  });

  it("a vault buried in token accounts it never asked for: the listing is too large to read, yet the state offers the vault's own SPYx account and the build withdraws from it", async () => {
    const owner = keypair();
    const ownerKey = owner.publicKey.toBase58();
    const vault = deriveVaultPda(ownerKey).toBase58();
    const spyxAta = deriveAta(vault, SPYX_MINT, TOKEN_2022_PROGRAM).toBase58();
    // Empty SPYx accounts anyone can open with the vault as their owner: 400 overflow this pool's 32 KiB answers, as about 12,650 overflow mainnet's 8 MiB.
    const spam = Array.from({ length: 400 }, () => ({ pubkey: spyxAta, mint: SPYX_MINT, amount: "0", decimals: 8, uiAmountString: "0", tokenProgram: TOKEN_2022_PROGRAM }));
    const chain: StubChain = {
      accounts: new Map([
        [vault, sipOwned(vaultAccount(ownerKey), localRent(125))],
        [spyxAta, spyxAccount(vault, 12_345_678n)],
      ]),
      parsedAccounts: new Map([[spyxAta, parsedTokenAccount({ tokenProgram: TOKEN_2022_PROGRAM, mint: SPYX_MINT, owner: vault, amount: "12345678", decimals: 8, uiAmountString: "0.1241643", bytes: 179 })]]),
      tokenAccounts: new Map([[vault, spam]]),
    };
    const upstream = fakeFetch(answerRpc(chain));
    const pool = createRpcPool(load.settings.rpcEndpoints, { fetch: upstream.fetch, redactor: load.settings.redactor, maxResponseBytes: 32 * 1024 });
    const { state, build } = setup(chain, { pool });

    const listed = await state({ action: "state", owner: ownerKey, wallets: [] });
    expect(listed.status).toBe(200);
    expect(listed.json.holdings).toEqual({ status: "unreadable", items: [] });
    expect(listed.json.vaultTokenAccounts.items[2]).toEqual({ mint: SPYX_MINT, address: spyxAta, tokenProgram: TOKEN_2022_PROGRAM, status: "exists", amountRaw: "12345678", decimals: 8, uiAmount: "0.1241643" });

    const built = await build({ action: "withdrawToken", owner: ownerKey, mint: SPYX_MINT, amountRaw: "12345678", vaultToken: spyxAta });
    expect(built.status).toBe(200);
    expect(built.json.accounts).toMatchObject({ vault_token: spyxAta, token_program: TOKEN_2022_PROGRAM });
    expect(methodsOf(upstream.calls).filter((method) => method === "getTokenAccountsByOwner")).toHaveLength(2);
    const verified = verifySignedTransaction(signWire(built.json.txBase64, owner));
    expect(verified.ok, verified.ok ? "" : verified.detail).toBe(true);
  });
});

describe("state", () => {
  it("answers every read with its own outcome, bigints as strings, links per wallet, rents and the live prices", async () => {
    const owner = key();
    const vault = deriveVaultPda(owner).toBase58();
    const [mine, theirs, fresh, forged] = [key(), key(), key(), key()];
    const chain = linkableChain(owner);
    chain.accounts.set(vault, sipOwned(vaultAccount(owner, { lifetime_saved: 12_345_678_901n }), 250_000_000));
    chain.accounts.set(deriveLinkPda(mine).toBase58(), sipOwned(linkAccount(mine, vault)));
    chain.accounts.set(deriveLinkPda(theirs).toBase58(), sipOwned(linkAccount(theirs, key())));
    chain.accounts.set(deriveLinkPda(forged).toBase58(), accountInfo(key(), linkAccount(forged, vault)));
    for (const [address, account] of pricedPoolEntries()) chain.accounts.set(address, account);
    const usdcAccount = deriveAta(vault, USDC_MINT, TOKEN_PROGRAM).toBase58();
    chain.accounts.set(usdcAccount, tokenAccountInfo(TOKEN_PROGRAM));
    const holdings = [{ pubkey: usdcAccount, mint: USDC_MINT, amount: "9007199254740993", decimals: 6, uiAmountString: "9007199254.740993", tokenProgram: TOKEN_PROGRAM }];
    const parsedAccounts = new Map([[usdcAccount, parsedTokenAccount({ tokenProgram: TOKEN_PROGRAM, mint: USDC_MINT, owner: vault, amount: "9007199254740993", decimals: 6, uiAmountString: "9007199254.740993" })]]);
    const { state } = setup({ ...chain, parsedAccounts, tokenAccounts: new Map([[vault, holdings]]) });
    const answer = await state({ action: "state", owner, wallets: [mine, theirs, fresh, forged] });
    expect(answer.status).toBe(200);
    const body = answer.json;
    expect(body.owner).toBe(owner);
    expect(body.programId).toBe(SIP_PROGRAM_ID);
    expect(body.vault).toMatchObject({ status: "exists", address: vault, lamports: "250000000", rentFloor: String(localRent(125)) });
    expect(body.vault.withdrawableLamports).toBe(String(250_000_000 - localRent(125)));
    expect(body.vault.state).toMatchObject({ owner, skimMode: 0, skimBps: 2_000, volumeBps: 200, maxContribution: "60000000", walletReserve: "50000000", lifetimeSaved: "12345678901" });
    expect(body.policy).toEqual({ status: "missing", address: deriveInvestPda(vault).toBase58() });
    expect(body.config).toEqual({ address: deriveConfigPda().toBase58(), status: "exists", exists: true, paused: false });
    expect(body.walletLinks.map((link: { wallet: string; status: string; vault: string | null }) => [link.wallet, link.status])).toEqual([
      [mine, "this_vault"],
      [theirs, "other_vault"],
      [fresh, "missing"],
      [forged, "unreadable"],
    ]);
    expect(body.walletLinks[0].link).toBe(deriveLinkPda(mine).toBase58());
    // One rent per leg, read at that leg's own size: 179 for SPYx, 191 for the
    // PreStocks account, which carries TransferFeeAmount on top of the same extensions.
    expect(body.rents).toEqual({
      vault: String(localRent(125)),
      link: String(localRent(129)),
      policy: String(localRent(970)),
      tokenAccount: String(localRent(165)),
      legTokenAccounts: { [SPYX_MINT]: String(localRent(179)), [ANTHROPIC_MINT]: String(localRent(191)) },
    });
    // Past 2^53, as the RPC wrote it: a number would have lost the last digit.
    expect(body.holdings).toEqual({
      status: "exists",
      items: [{ tokenAccount: usdcAccount, mint: USDC_MINT, amountRaw: "9007199254740993", decimals: 6, uiAmount: "9007199254.740993", tokenProgram: TOKEN_PROGRAM }],
    });
    expect(body.vaultTokenAccounts).toEqual({
      status: "exists",
      items: [
        { mint: WSOL_MINT, address: deriveAta(vault, WSOL_MINT, TOKEN_PROGRAM).toBase58(), tokenProgram: TOKEN_PROGRAM, status: "missing", amountRaw: null, decimals: null, uiAmount: null },
        { mint: USDC_MINT, address: usdcAccount, tokenProgram: TOKEN_PROGRAM, status: "exists", amountRaw: "9007199254740993", decimals: 6, uiAmount: "9007199254.740993" },
        { mint: SPYX_MINT, address: deriveAta(vault, SPYX_MINT, TOKEN_2022_PROGRAM).toBase58(), tokenProgram: TOKEN_2022_PROGRAM, status: "missing", amountRaw: null, decimals: null, uiAmount: null },
        {
          mint: ANTHROPIC_MINT,
          address: deriveAta(vault, ANTHROPIC_MINT, TOKEN_2022_PROGRAM).toBase58(),
          tokenProgram: TOKEN_2022_PROGRAM,
          status: "missing",
          amountRaw: null,
          decimals: null,
          uiAmount: null,
        },
      ],
    });
    expect(body.prices).toEqual({
      slot: 321,
      convertWad: "100038711555492562",
      usdcRawPerSol: "100038711",
      legs: LEG_POOLS.map((leg) => ({ symbol: leg.symbol, mint: leg.mint, wad: String(leg.legWad), usdcRawPer1e8: String(leg.usdcRawPer1e8) })),
    });
    // As above: the mapped list is pinned to the catalogue's real length.
    expect(body.prices.legs.map((leg: { symbol: string }) => leg.symbol)).toEqual(["SPYx", "ANTHROPIC"]);
  });

  it("an unreadable chain is reported unreadable everywhere, never missing, and still answers 200 with no endpoint in it", async () => {
    const owner = key();
    const wallet = key();
    const { state } = setup({ accounts: new Map(), down: true });
    const answer = await state({ action: "state", owner, wallets: [wallet] });
    expect(answer.status).toBe(200);
    expect(answer.json.vault.status).toBe("unreadable");
    expect(answer.json.policy.status).toBe("unreadable");
    expect(answer.json.config).toMatchObject({ status: "unreadable", exists: false, paused: null });
    expect(answer.json.walletLinks).toEqual([{ wallet, link: deriveLinkPda(wallet).toBase58(), status: "unreadable", vault: null }]);
    expect([answer.json.rents, answer.json.prices]).toEqual([null, null]);
    expect([answer.json.holdings, answer.json.vaultTokenAccounts]).toEqual([
      { status: "unreadable", items: [] },
      { status: "unreadable", items: [] },
    ]);
    expect(answer.text).not.toContain(SECRET_QUERY);
    expect(answer.text).not.toContain("upstream.invalid");
  });

  it("a pool under another owner, or with its mints swapped, gives no prices rather than a wrong one", async () => {
    const owner = key();
    // ONE pool is spoiled at a time and every other one is where it belongs, so the
    // null is that pool's doing. With three priced pools, a chain listing two would
    // have answered null whatever was done to either of them.
    const swapped = setup({
      accounts: new Map<string, ReturnType<typeof accountInfo> | null>([
        ...pricedPoolEntries(),
        [SOL_USDC_POOL, accountInfo(RAYDIUM_CLMM, clmmPoolAccount(USDC_MINT, WSOL_MINT, SOL_SQRT_PRICE))],
      ]),
    });
    expect((await swapped.state({ action: "state", owner, wallets: [] })).json.prices).toBeNull();
    const foreign = setup({
      accounts: new Map<string, ReturnType<typeof accountInfo> | null>([
        ...pricedPoolEntries(),
        [LEG_POOLS[1]!.pool, accountInfo(key(), clmmPoolAccount(ANTHROPIC_MINT, USDC_MINT, LEG_POOLS[1]!.sqrtPriceX64, [9, 6]))],
      ]),
    });
    expect((await foreign.state({ action: "state", owner, wallets: [] })).json.prices).toBeNull();
    // And with every pool as it should be, the same chain DOES price: the two above
    // are null because of what was done to them, not because prices never work here.
    const whole = setup({ accounts: new Map<string, ReturnType<typeof accountInfo> | null>(pricedPoolEntries()) });
    expect((await whole.state({ action: "state", owner, wallets: [] })).json.prices).toMatchObject({ usdcRawPerSol: "100038711" });
  });

  /**
   * THE PANEL LEARNS THE CLOSED SET FROM THE ROUTE THAT ENFORCES IT. state offers
   * the venue names and investPolicy refuses everything outside them; if those two
   * ever came from different lists, a day would come when the panel offered an
   * option the server refuses. So this case checks the two halves against each
   * other rather than against a literal: every name the answer offers is a name
   * that builds, and the program each one buys is learned from the BYTES the
   * builder produced, never from a constant written here. One more venue in
   * VENUE_PROGRAMS and this case covers it without being edited.
   */
  it("offers the venue names investPolicy accepts, and leaks no venue program into the answer", async () => {
    const owner = key();
    // The FULLEST answer this route gives — vault, pools priced, every mint in
    // place — so the search for a program below runs over a whole response and
    // not over a handful of nulls.
    const { state, build } = setup(investableChain(owner));
    const answer = await state({ action: "state", owner, wallets: [] });
    expect(answer.status).toBe(200);
    expect(answer.json.prices).not.toBeNull();
    // The set the validator holds, served whole: names, and nothing beside them.
    expect(answer.json.offeredVenues).toEqual([...OFFERED_VENUES]);
    const offered = answer.json.offeredVenues as string[];
    expect(offered.length).toBeGreaterThan(0);

    const venuePrograms: string[] = [];
    for (const venue of offered) {
      const built = await build({ action: "investPolicy", owner, venue });
      // OFFERED ⇒ ACCEPTED. (The other direction — anything else refused — is the
      // "venue is a NAME from a closed list" case above.)
      expect([venue, built.status], `venue ${venue} is offered, so it must build`).toEqual([venue, 200]);
      const args = decodeArgs("set_invest_policy", instructionsOf(built.json.txBase64).at(-1)!.data) as { venue_program: string };
      venuePrograms.push(args.venue_program);
    }
    expect(venuePrograms).toHaveLength(offered.length);

    // NOT ONE PROGRAM ADDRESS ANYWHERE IN THE SERIALISED ANSWER — not beside its
    // name, not in a field added later, not in a nested object: the whole response
    // text is searched. A refactor that served VENUE_PROGRAMS instead of its keys,
    // or that helpfully attached the program each name resolves to, dies here.
    for (const program of venuePrograms) {
      expect(answer.text, `the venue program ${program} must never leave the server`).not.toContain(program);
    }
    // And the names themselves DO travel, so the assertion above is about an answer
    // that really carries the venues rather than an empty one.
    for (const venue of offered) expect(answer.text).toContain(JSON.stringify(venue));
  });

  it.each([
    ["another action", { action: "createVault", owner: key(), wallets: [] }],
    ["no wallets field", { action: "state", owner: key() }],
    ["eleven wallets", { action: "state", owner: key(), wallets: Array.from({ length: 11 }, key) }],
    ["a repeated wallet", { action: "state", owner: key(), wallets: [SPYX_MINT, SPYX_MINT] }],
    ["a wallet that is not a key", { action: "state", owner: key(), wallets: ["nope"] }],
    ["an extra field", { action: "state", owner: key(), wallets: [], vault: key() }],
  ])("%s is 400 bad_request with no read", async (_, body) => {
    const { state, upstream } = setup();
    const answer = await state(body);
    expect([answer.status, answer.json.error?.code]).toEqual([400, "bad_request"]);
    expect(upstream.calls).toHaveLength(0);
  });
});
