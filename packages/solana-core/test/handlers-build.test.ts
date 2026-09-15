// /api/solana-build and /api/solana-vault through their handlers, over a stub chain.

import { describe, expect, it } from "vitest";

import { COMPUTE_BUDGET_PROGRAM, ED25519_PROGRAM, RAYDIUM_CLMM, SOL_USDC_POOL, SPYX_MINT, SPYX_USDC_POOL, USDC_MINT, WSOL_MINT } from "../src/client/addresses";
import { base64Encode } from "../src/client/base64";
import { decodeArgs } from "../src/client/borsh";
import { SIP_ACCOUNT_SPACE } from "../src/client/decoders";
import { SIP_PROGRAM_ID, toHex } from "../src/client/idl";
import { linkConsentMessage } from "../src/client/link-consent";
import { parseLegacyMessage, splitWire } from "../src/client/message";
import { BUILD_REQUEST_WEIGHT, MAX_BUILD_REQUEST_BYTES, createSolanaBuildHandler, createSolanaVaultHandler, type SolanaBuildHandlerOptions } from "../src/server/build-handler";
import { DEFAULT_RELAY_LIMITS, loadSolanaServerSettings } from "../src/server/config";
import type { SolanaGate } from "../src/server/handlers";
import { deriveConfigPda, deriveInvestPda, deriveLinkPda, deriveVaultPda } from "../src/server/pda";
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
    const { state } = setup(chain);
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
    expect(body.rents).toEqual({ vault: String(localRent(125)), link: String(localRent(129)) });
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
