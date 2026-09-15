// /api/solana-build and /api/solana-vault through their handlers, over a stub chain.

import { describe, expect, it } from "vitest";

import {
  ATA_PROGRAM,
  COMPUTE_BUDGET_PROGRAM,
  ED25519_PROGRAM,
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
import { parseLegacyMessage, splitWire } from "../src/client/message";
import { BUILD_READS_WEIGHT, BUILD_REQUEST_WEIGHT, MAX_BUILD_REQUEST_BYTES, createSolanaBuildHandler, createSolanaVaultHandler, type SolanaBuildHandlerOptions } from "../src/server/build-handler";
import { DEFAULT_RELAY_LIMITS, loadSolanaServerSettings } from "../src/server/config";
import type { SolanaGate } from "../src/server/handlers";
import { deriveAta, deriveConfigPda, deriveInvestPda, deriveLinkPda, deriveVaultPda } from "../src/server/pda";
import { createWeightedLimiter } from "../src/server/rate-limit";
import { verifySignedTransaction } from "../src/server/verify-tx";
import {
  SOL_SQRT_PRICE,
  SPYX_SQRT_PRICE,
  answerRpc,
  clmmPoolAccount,
  configAccount,
  linkAccount,
  localRent,
  methodsOf,
  mintAccount,
  policyAccount,
  tokenAccountInfo,
  vaultAccount,
  type StubChain,
} from "./chain-fixtures";
import { SECRET_QUERY, UPSTREAM_1, accountInfo, fakeFetch, fromB64, keypair, signBytes, signWire } from "./helpers";

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
    ["a token withdrawal naming its source account", { action: "withdrawToken", owner: key(), mint: SPYX_MINT, amountRaw: "1", vaultToken: key() }],
    ["a token withdrawal whose mint is not a key", { action: "withdrawToken", owner: key(), mint: "SPYx", amountRaw: "1" }],
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
    expect([answer.status, answer.json.error?.code, answer.json.error?.message]).toEqual([422, "link_consent_invalid", "Your trading wallet's signature does not match SIP's link consent."]);
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

/** A chain where `owner` has a vault, the pinned pools price SOL and SPYx at the goldens, and USDC and SPYx are their token programs' mints. */
function investableChain(owner: string): StubChain {
  return {
    accounts: new Map([
      [deriveVaultPda(owner).toBase58(), sipOwned(vaultAccount(owner), localRent(125))],
      [SOL_USDC_POOL, accountInfo(RAYDIUM_CLMM, clmmPoolAccount(WSOL_MINT, USDC_MINT, SOL_SQRT_PRICE))],
      [SPYX_USDC_POOL, accountInfo(RAYDIUM_CLMM, clmmPoolAccount(SPYX_MINT, USDC_MINT, SPYX_SQRT_PRICE, [8, 6]))],
      [USDC_MINT, mintAccount(TOKEN_PROGRAM)],
      [SPYX_MINT, mintAccount(TOKEN_2022_PROGRAM)],
    ]),
  };
}

const instructionsOf = (txBase64: string) => parseLegacyMessage(splitWire(fromB64(txBase64)).message).instructions;

describe("investPolicy", () => {
  it("a first policy: [CU limit, CU price, ATA wSOL, ATA USDC, ATA SPYx, set_invest_policy] at 90 % and 95 % of the pools, the default caps and every rent; it verifies once the owner signs", async () => {
    const owner = keypair();
    const ownerKey = owner.publicKey.toBase58();
    const vault = deriveVaultPda(ownerKey).toBase58();
    const { build, upstream } = setup(investableChain(ownerKey));
    const answer = await build({ action: "investPolicy", owner: ownerKey });
    expect(answer.status).toBe(200);
    const body = answer.json;
    expect(programsOf(body.txBase64)).toEqual([COMPUTE_BUDGET_PROGRAM, COMPUTE_BUDGET_PROGRAM, ATA_PROGRAM, ATA_PROGRAM, ATA_PROGRAM, SIP_PROGRAM_ID]);
    expect(decodeArgs("set_invest_policy", instructionsOf(body.txBase64)[5]!.data)).toEqual({
      legs: [{ mint: SPYX_MINT, weight_bps: 10_000, min_out_rate_wad: 124_719_467_624_105_690n }],
      venue_program: RAYDIUM_CLMM,
      in_mint: USDC_MINT,
      min_convert_rate_wad: 90_034_840_399_943_305n,
      min_investment: 5_000_000n,
      max_per_call: 1_000_000_000n,
      max_rolling_30d: 31_000_000_000n,
      enabled: true,
    });
    expect(body.policy).toBe(deriveInvestPda(vault).toBase58());
    expect(body.policyExists).toBe(false);
    expect(body.vaultTokenAccounts).toEqual([
      { mint: WSOL_MINT, address: deriveAta(vault, WSOL_MINT, TOKEN_PROGRAM).toBase58(), tokenProgram: TOKEN_PROGRAM, create: true },
      { mint: USDC_MINT, address: deriveAta(vault, USDC_MINT, TOKEN_PROGRAM).toBase58(), tokenProgram: TOKEN_PROGRAM, create: true },
      { mint: SPYX_MINT, address: deriveAta(vault, SPYX_MINT, TOKEN_2022_PROGRAM).toBase58(), tokenProgram: TOKEN_2022_PROGRAM, create: true },
    ]);
    expect(body.floors).toEqual({
      slot: 321,
      marginBps: { convert: 1_000, leg: 500 },
      liveConvertWad: "100038711555492562",
      convertWad: "90034840399943305",
      usdcRawPerSol: "100038711",
      floorUsdcRawPerSol: "90034840",
      legs: [{ symbol: "SPYx", mint: SPYX_MINT, liveWad: "131283650130637569", wad: "124719467624105690", usdcRawPer1e8: "761709474", maxUsdcRawPer1e8: "801799446" }],
    });
    expect(body.costs).toEqual({
      rentLamports: String(localRent(970) + 2 * localRent(165) + localRent(179)),
      signatureFeeLamports: "5000",
      priorityFeeLamports: "30000",
      policyRentLamports: String(localRent(970)),
      tokenAccountRentLamports: String(2 * localRent(165) + localRent(179)),
    });
    expect(body.warnings).toEqual([]);
    const verified = verifySignedTransaction(signWire(body.txBase64, owner));
    expect(verified.ok, verified.ok ? "" : verified.detail).toBe(true);
    const methods = methodsOf(upstream.calls);
    expect(methods.filter((method) => method === "getLatestBlockhash")).toHaveLength(1);
    expect(methods).toHaveLength(BUILD_READS_WEIGHT.investPolicy);
  });

  it("creates only what the vault lacks: an existing USDC account is left alone, a wSOL address holding only lamports is still created, and an existing policy costs no policy rent", async () => {
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
    expect([instructions[2]!.accountKeys[3], instructions[3]!.accountKeys[3]]).toEqual([WSOL_MINT, SPYX_MINT]);
    expect(answer.json.vaultTokenAccounts.map((entry: { mint: string; create: boolean }) => [entry.mint, entry.create])).toEqual([
      [WSOL_MINT, true],
      [USDC_MINT, false],
      [SPYX_MINT, true],
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
    chain.accounts.set(deriveAta(vault, SPYX_MINT, TOKEN_2022_PROGRAM).toBase58(), tokenAccountInfo(TOKEN_2022_PROGRAM, 179));
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
    ["the SPYx pool with its mints swapped", (chain) => void chain.accounts.set(SPYX_USDC_POOL, accountInfo(RAYDIUM_CLMM, clmmPoolAccount(USDC_MINT, SPYX_MINT, SPYX_SQRT_PRICE)))],
    ["the SOL/USDC pool owned by another program", (chain) => void chain.accounts.set(SOL_USDC_POOL, accountInfo(key(), clmmPoolAccount(WSOL_MINT, USDC_MINT, SOL_SQRT_PRICE)))],
  ])("%s is 502 price_unavailable, and nothing is built", async (_, spoil) => {
    const owner = key();
    const chain = investableChain(owner);
    spoil(chain);
    const answer = await setup(chain).build({ action: "investPolicy", owner });
    expect([answer.status, answer.json.error?.code]).toEqual([502, "price_unavailable"]);
    expect(answer.json).not.toHaveProperty("txBase64");
  });

  it("a SPYx mint held by classic Token, or a USDC mint that does not exist, is 409 mint_unexpected naming it", async () => {
    const owner = key();
    const classic = investableChain(owner);
    classic.accounts.set(SPYX_MINT, mintAccount(TOKEN_PROGRAM));
    const wrong = await setup(classic).build({ action: "investPolicy", owner });
    expect([wrong.status, wrong.json.error?.code, (wrong.json.error as { mint?: string } | undefined)?.mint]).toEqual([409, "mint_unexpected", SPYX_MINT]);
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
    for (const caps of [{ maxRolling30d: "999999999" }, { maxPerCall: "4999999", maxRolling30d: "4999999" }]) {
      const answer = await build({ action: "investPolicy", owner: key(), ...caps });
      expect([answer.status, answer.json.error?.code]).toEqual([400, "invalid_policy"]);
      expect(answer.json.error?.problems?.join(" ")).toMatch(/minInvestment <= maxPerCall <= maxRolling30d/);
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
  const spyxHolding = (pubkey: string, amount: string) => ({ pubkey, mint: SPYX_MINT, amount, decimals: 8, uiAmountString: "0.1241643", tokenProgram: TOKEN_2022_PROGRAM });

  it("takes the source account and the token program from the vault's holdings, the largest of that mint, never the request, and quotes the rent of the owner's new account", async () => {
    const owner = keypair();
    const ownerKey = owner.publicKey.toBase58();
    const vault = deriveVaultPda(ownerKey).toBase58();
    const holding = key();
    const chain: StubChain = {
      accounts: new Map([[vault, sipOwned(vaultAccount(ownerKey), localRent(125))]]),
      tokenAccounts: new Map([[vault, [spyxHolding(key(), "1000"), spyxHolding(holding, "12345678")]]]),
    };
    const { build, upstream } = setup(chain);
    const answer = await build({ action: "withdrawToken", owner: ownerKey, mint: SPYX_MINT, amountRaw: "12345678" });
    expect(answer.status).toBe(200);
    expect(programsOf(answer.json.txBase64)).toEqual([COMPUTE_BUDGET_PROGRAM, COMPUTE_BUDGET_PROGRAM, SIP_PROGRAM_ID]);
    expect(decodeArgs("withdraw_token", instructionsOf(answer.json.txBase64)[2]!.data)).toEqual({ amount: 12_345_678n });
    const ownerToken = deriveAta(ownerKey, SPYX_MINT, TOKEN_2022_PROGRAM).toBase58();
    expect(answer.json.accounts).toMatchObject({ owner: ownerKey, vault, token_mint: SPYX_MINT, vault_token: holding, owner_token: ownerToken, token_program: TOKEN_2022_PROGRAM });
    expect([answer.json.vaultTokenAccount, answer.json.ownerTokenAccount, answer.json.heldRaw]).toEqual([holding, ownerToken, "12345678"]);
    expect([answer.json.ownerTokenAccountExists, answer.json.ownerTokenAccountRentLamports]).toEqual([false, String(localRent(179))]);
    expect(answer.json.costs).toEqual({ rentLamports: String(localRent(179)), signatureFeeLamports: "5000", priorityFeeLamports: "20000" });
    expect(methodsOf(upstream.calls)).toHaveLength(BUILD_READS_WEIGHT.withdrawToken);
    const verified = verifySignedTransaction(signWire(answer.json.txBase64, owner));
    expect(verified.ok, verified.ok ? "" : verified.detail).toBe(true);
  });

  it("wSOL comes out as SOL, so no rent is quoted; nor for an owner's account that already exists", async () => {
    const owner = key();
    const vault = deriveVaultPda(owner).toBase58();
    const wsol = { pubkey: deriveAta(vault, WSOL_MINT, TOKEN_PROGRAM).toBase58(), mint: WSOL_MINT, amount: "100000000", decimals: 9, uiAmountString: "0.1", tokenProgram: TOKEN_PROGRAM };
    const chain: StubChain = { accounts: new Map([[vault, sipOwned(vaultAccount(owner), localRent(125))]]), tokenAccounts: new Map([[vault, [wsol, spyxHolding(key(), "5")]]]) };
    const { build } = setup(chain);
    const unwrapped = await build({ action: "withdrawToken", owner, mint: WSOL_MINT, amountRaw: "100000000" });
    expect([unwrapped.status, unwrapped.json.ownerTokenAccountRentLamports, unwrapped.json.costs.rentLamports]).toEqual([200, "0", "0"]);
    chain.accounts.set(deriveAta(owner, SPYX_MINT, TOKEN_2022_PROGRAM).toBase58(), tokenAccountInfo(TOKEN_2022_PROGRAM, 179));
    const held = await build({ action: "withdrawToken", owner, mint: SPYX_MINT, amountRaw: "5" });
    expect([held.json.ownerTokenAccountExists, held.json.ownerTokenAccountRentLamports]).toEqual([true, "0"]);
  });

  it("a mint the vault does not hold is 422 not_held; more than it holds is 422 above_holding with what it holds; zero is 400 zero_amount before any read", async () => {
    const owner = key();
    const vault = deriveVaultPda(owner).toBase58();
    const chain: StubChain = { accounts: new Map([[vault, sipOwned(vaultAccount(owner), localRent(125))]]), tokenAccounts: new Map([[vault, [spyxHolding(key(), "12345678")]]]) };
    const { build, upstream } = setup(chain);
    expect((await build({ action: "withdrawToken", owner, mint: USDC_MINT, amountRaw: "1" })).json.error?.code).toBe("not_held");
    const above = await build({ action: "withdrawToken", owner, mint: SPYX_MINT, amountRaw: "12345679" });
    expect([above.status, above.json.error?.code, (above.json.error as { heldRaw?: string } | undefined)?.heldRaw]).toEqual([422, "above_holding", "12345678"]);
    const calls = upstream.calls.length;
    expect((await build({ action: "withdrawToken", owner, mint: SPYX_MINT, amountRaw: "0" })).json.error?.code).toBe("zero_amount");
    expect(upstream.calls).toHaveLength(calls);
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
    chain.accounts.set(SOL_USDC_POOL, accountInfo(RAYDIUM_CLMM, clmmPoolAccount(WSOL_MINT, USDC_MINT, SOL_SQRT_PRICE)));
    chain.accounts.set(SPYX_USDC_POOL, accountInfo(RAYDIUM_CLMM, clmmPoolAccount(SPYX_MINT, USDC_MINT, SPYX_SQRT_PRICE, [8, 6])));
    const usdcAccount = deriveAta(vault, USDC_MINT, TOKEN_PROGRAM).toBase58();
    chain.accounts.set(usdcAccount, tokenAccountInfo(TOKEN_PROGRAM));
    const holdings = [{ pubkey: usdcAccount, mint: USDC_MINT, amount: "9007199254740993", decimals: 6, uiAmountString: "9007199254.740993", tokenProgram: TOKEN_PROGRAM }];
    const { state } = setup({ ...chain, tokenAccounts: new Map([[vault, holdings]]) });
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
    expect(body.rents).toEqual({
      vault: String(localRent(125)),
      link: String(localRent(129)),
      policy: String(localRent(970)),
      tokenAccount: String(localRent(165)),
      legTokenAccounts: { [SPYX_MINT]: String(localRent(179)) },
    });
    // Past 2^53, as the RPC wrote it: a number would have lost the last digit.
    expect(body.holdings).toEqual({
      status: "exists",
      items: [{ tokenAccount: usdcAccount, mint: USDC_MINT, amountRaw: "9007199254740993", decimals: 6, uiAmount: "9007199254.740993", tokenProgram: TOKEN_PROGRAM }],
    });
    expect(body.vaultTokenAccounts).toEqual({
      status: "exists",
      items: [
        { mint: WSOL_MINT, address: deriveAta(vault, WSOL_MINT, TOKEN_PROGRAM).toBase58(), tokenProgram: TOKEN_PROGRAM, status: "missing" },
        { mint: USDC_MINT, address: usdcAccount, tokenProgram: TOKEN_PROGRAM, status: "exists" },
        { mint: SPYX_MINT, address: deriveAta(vault, SPYX_MINT, TOKEN_2022_PROGRAM).toBase58(), tokenProgram: TOKEN_2022_PROGRAM, status: "missing" },
      ],
    });
    expect(body.prices).toEqual({
      slot: 321,
      convertWad: "100038711555492562",
      usdcRawPerSol: "100038711",
      legs: [{ symbol: "SPYx", mint: SPYX_MINT, wad: "131283650130637569", usdcRawPer1e8: "761709474" }],
    });
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
    const swapped = setup({
      accounts: new Map([
        [SOL_USDC_POOL, accountInfo(RAYDIUM_CLMM, clmmPoolAccount(USDC_MINT, WSOL_MINT, SOL_SQRT_PRICE))],
        [SPYX_USDC_POOL, accountInfo(RAYDIUM_CLMM, clmmPoolAccount(SPYX_MINT, USDC_MINT, SPYX_SQRT_PRICE))],
      ]),
    });
    expect((await swapped.state({ action: "state", owner, wallets: [] })).json.prices).toBeNull();
    const foreign = setup({
      accounts: new Map([
        [SOL_USDC_POOL, accountInfo(key(), clmmPoolAccount(WSOL_MINT, USDC_MINT, SOL_SQRT_PRICE))],
        [SPYX_USDC_POOL, accountInfo(RAYDIUM_CLMM, clmmPoolAccount(SPYX_MINT, USDC_MINT, SPYX_SQRT_PRICE))],
      ]),
    });
    expect((await foreign.state({ action: "state", owner, wallets: [] })).json.prices).toBeNull();
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
