// /api/solana-build as wired in this app: the settings gate, the environment, and
// the core build handler behind them (tested in depth in @sip/solana-core).
// Every key is Keypair.generate(); every URL an .invalid host. No network.

import { createPrivateKey, sign } from "node:crypto";

import {
  ANTHROPIC_MINT,
  ANTHROPIC_USDC_POOL,
  ATA_PROGRAM,
  CLMM_POOL_STATE_BYTES,
  CLMM_POOL_STATE_DISCRIMINATOR,
  COMPUTE_BUDGET_PROGRAM,
  ED25519_PROGRAM,
  RAYDIUM_CLMM,
  SIP_ACCOUNT_SPACE,
  SIP_PROGRAM_ID,
  SOL_USDC_POOL,
  SPYX_MINT,
  SPYX_USDC_POOL,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  USDC_MINT,
  WSOL_MINT,
  accountDiscriminator,
  base58Encode,
  base64Encode,
  encodeStruct,
  linkConsentMessage,
  parseLegacyMessage,
  splitWire,
  toHex,
  tryBase58Decode,
  tryBase64Decode,
} from "@sip/solana-core/client";
import { deriveAta, deriveConfigPda, deriveLinkPda, deriveVaultPda, verifySignedTransaction } from "@sip/solana-core/server";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { solanaBuildRoute } from "@/lib/solana-routes";

import { GET, POST } from "./route";

const SECRET = "WEBBUILDSECRET789";
const UPSTREAM = `https://upstream.invalid/?api-key=${SECRET}`;
const SOLANA_ENV = {
  SIP_SOLANA_RPC_URLS: UPSTREAM,
  SIP_SOLANA_PROGRAM_ID: SIP_PROGRAM_ID,
  SIP_TRUSTED_CLIENT_IP_HEADER: "x-envoy-external-address",
} as const;
/** Cleared before each case, so nothing the calling shell exported can decide the answer. */
const NAMES = [
  "SIP_CHAIN",
  "SIP_SOLANA_RPC_URLS",
  "SIP_SOLANA_PROGRAM_ID",
  "SIP_TRUSTED_CLIENT_IP_HEADER",
  "SIP_SOLANA_PUBLIC_WS_URL",
  "SIP_SOLANA_SETTLE_KEY",
  "SIP_SOLANA_PRIVY_APP_SECRET",
  "SIP_SOLANA_PRIVY_AUTHORIZATION_KEY",
  "PRIVY_APP_SECRET",
  "PRIVY_AUTHORIZATION_PRIVATE_KEY",
];

const BLOCKHASH = base58Encode(Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 1) & 0xff));

let lastIp = 0;
const freshIp = (): string => `198.51.100.${(lastIp = (lastIp % 250) + 1)}`;

function buildRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://sip.example/api/solana-build", {
    method: "POST",
    headers: { "content-type": "application/json", "x-envoy-external-address": freshIp(), ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function useEnv(env: Readonly<Record<string, string | undefined>>): void {
  for (const name of NAMES) vi.stubEnv(name, undefined);
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
}

type RpcCall = { readonly id?: unknown; readonly method?: string; readonly params?: readonly unknown[] };
type AccountJson = { data: [string, "base64"]; lamports: number; owner: string; executable: boolean; rentEpoch: number; space: number };

/** Answers single and batch JSON-RPC from an account map, at mainnet's rent of 5,080 lamports per byte. */
function stubChain(accounts: ReadonlyMap<string, AccountJson>, down = false): string[] {
  const methods: string[] = [];
  const one = (call: RpcCall): Record<string, unknown> => {
    methods.push(String(call.method));
    const context = { slot: 321 };
    const params = call.params ?? [];
    switch (call.method) {
      case "getMultipleAccounts":
        return { jsonrpc: "2.0", id: call.id ?? null, result: { context, value: (params[0] as string[]).map((address) => accounts.get(address) ?? null) } };
      case "getMinimumBalanceForRentExemption":
        return { jsonrpc: "2.0", id: call.id ?? null, result: ((params[0] as number) + 128) * 5_080 };
      case "getLatestBlockhash":
        return { jsonrpc: "2.0", id: call.id ?? null, result: { context, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 300_000_150 } } };
      case "getAccountInfo":
        return { jsonrpc: "2.0", id: call.id ?? null, result: { context, value: accounts.get(params[0] as string) ?? null } };
      case "getTokenAccountsByOwner":
        // The vault holds no token in these cases.
        return { jsonrpc: "2.0", id: call.id ?? null, result: { context, value: [] } };
      default:
        return { jsonrpc: "2.0", id: call.id ?? null, error: { code: -32601, message: "not stubbed" } };
    }
  };
  vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit): Promise<Response> => {
    if (down) throw new Error(`socket hang up ${UPSTREAM}`);
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "null") as RpcCall | RpcCall[];
    const answer = Array.isArray(body) ? body.map(one) : one(body);
    return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
  });
  return methods;
}

function sipAccount(name: "Vault" | "TradingLink" | "ProtocolConfig", fields: Record<string, unknown>, owner = SIP_PROGRAM_ID): AccountJson {
  const bytes = new Uint8Array(SIP_ACCOUNT_SPACE[name]);
  bytes.set(accountDiscriminator(name), 0);
  bytes.set(encodeStruct(name, fields), 8);
  return { data: [base64Encode(bytes), "base64"], lamports: 2_000_000, owner, executable: false, rentEpoch: 0, space: bytes.length };
}

const someKey = (): string => Keypair.generate().publicKey.toBase58();

const vaultOf = (owner: string): AccountJson =>
  sipAccount("Vault", {
    owner,
    bump: 255,
    version: 2,
    paused: false,
    skim_bps: 2_000,
    lifetime_saved: 0n,
    created_at: 1n,
    skim_mode: 0,
    volume_bps: 200,
    policy_nonce: 0n,
    max_contribution: 60_000_000n,
    wallet_reserve: 50_000_000n,
    _reserved: new Array(37).fill(0),
  });

const config = (): AccountJson =>
  sipAccount("ProtocolConfig", { authority: someKey(), attester: someKey(), bump: 253, keeper: someKey(), pending_authority: "11111111111111111111111111111111", paused: false, version: 2, _reserved: new Array(64).fill(0) });

const linkOf = (wallet: string, vault: string): AccountJson =>
  sipAccount("TradingLink", { wallet, vault, epoch: 7n, settlement_nonce: 0n, frontier_slot: 0n, bump: 254, _reserved: new Array(32).fill(0) });

/** What a wallet's signMessage returns: an ed25519 signature, here with node:crypto and a throwaway key. */
function signMessage(signer: Keypair, message: Uint8Array): Uint8Array {
  const privateKey = createPrivateKey({
    key: {
      kty: "OKP",
      crv: "Ed25519",
      d: Buffer.from(signer.secretKey.subarray(0, 32)).toString("base64url"),
      x: Buffer.from(signer.publicKey.toBytes()).toString("base64url"),
    },
    format: "jwk",
  });
  return Uint8Array.from(sign(null, message, privateKey));
}

/** Signs unsigned wire bytes with each key in turn, as Phantom and then the trading wallet would. */
function signed(txBase64: string, ...signers: Keypair[]): Uint8Array {
  const unsigned = tryBase64Decode(txBase64);
  if (unsigned === null) throw new Error("not base64");
  const tx = VersionedTransaction.deserialize(unsigned);
  tx.sign(signers);
  return Uint8Array.from(tx.serialize());
}

const programsOf = (txBase64: string): string[] => parseLegacyMessage(splitWire(tryBase64Decode(txBase64)!).message).instructions.map((instruction) => instruction.programId);

/** An account some program other than SIP holds: only its owner and size matter here. */
const ownedBy = (owner: string, size: number): AccountJson => ({ data: [base64Encode(new Uint8Array(size)), "base64"], lamports: 1_000_000, owner, executable: false, rentEpoch: 0, space: size });

/** A Raydium CLMM PoolState with the fields SIP prices from: the mints at 73 and 105, sqrt_price_x64 at 253. */
function poolOf(mint0: string, mint1: string, sqrtPriceX64: bigint): AccountJson {
  const bytes = new Uint8Array(CLMM_POOL_STATE_BYTES);
  bytes.set(CLMM_POOL_STATE_DISCRIMINATOR, 0);
  bytes.set(tryBase58Decode(mint0)!, 73);
  bytes.set(tryBase58Decode(mint1)!, 105);
  let value = sqrtPriceX64;
  for (let i = 0; i < 16; i++, value >>= 8n) bytes[253 + i] = Number(value & 0xffn);
  return { data: [base64Encode(bytes), "base64"], lamports: 1_000_000, owner: RAYDIUM_CLMM, executable: false, rentEpoch: 0, space: bytes.length };
}

const mainnetRent = (size: number): number => (size + 128) * 5_080;

type Answer = { status: number; text: string; json: { error?: { code: string; message: string; vault?: string; withdrawableLamports?: string } } & Record<string, any> };
async function answer(response: Response): Promise<Answer> {
  const text = await response.text();
  return { status: response.status, text, json: JSON.parse(text) as never };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("/api/solana-build", () => {
  it("is 503 unavailable with no detail when the settings are incomplete or a refused name is present", async () => {
    const refused: Readonly<Record<string, string | undefined>>[] = [
      { ...SOLANA_ENV, SIP_SOLANA_PROGRAM_ID: undefined },
      { ...SOLANA_ENV, PRIVY_AUTHORIZATION_PRIVATE_KEY: "" },
      { ...SOLANA_ENV, PRIVY_APP_SECRET: "" },
    ];
    for (const env of refused) {
      useEnv(env);
      const methods = stubChain(new Map());
      const response = await answer(await POST(buildRequest({ action: "createVault", owner: someKey(), mode: 0 })));
      expect(response.status).toBe(503);
      expect(response.json.error?.code).toBe("unavailable");
      expect(response.text).not.toMatch(/SIP_|NUVEM_|PRIVY_|variable/);
      expect(methods).toHaveLength(0);
    }
  });

  it("createVault answers [CU limit, CU price, create_vault_v2] that the owner signs and the send route's verifier accepts", async () => {
    useEnv(SOLANA_ENV);
    const owner = Keypair.generate();
    const methods = stubChain(new Map());
    const response = await answer(await POST(buildRequest({ action: "createVault", owner: owner.publicKey.toBase58(), mode: 0 })));
    expect(response.status).toBe(200);
    expect(programsOf(response.json.txBase64)).toEqual([COMPUTE_BUDGET_PROGRAM, COMPUTE_BUDGET_PROGRAM, SIP_PROGRAM_ID]);
    expect(response.json.costs).toEqual({ rentLamports: String((125 + 128) * 5_080), signatureFeeLamports: "5000", priorityFeeLamports: "6000" });
    expect(response.json.vault).toBe(deriveVaultPda(owner.publicKey.toBase58()).toBase58());
    const verified = verifySignedTransaction(signed(response.json.txBase64, owner));
    expect(verified.ok).toBe(true);
    expect(methods.filter((method) => method === "getLatestBlockhash")).toHaveLength(1);
  });

  it("an existing vault is 409 vault_exists; VOLUME is 400 volume_not_offered with nothing read", async () => {
    useEnv(SOLANA_ENV);
    const owner = someKey();
    const methods = stubChain(new Map([[deriveVaultPda(owner).toBase58(), vaultOf(owner)]]));
    const exists = await answer(await POST(buildRequest({ action: "createVault", owner, mode: 0 })));
    expect([exists.status, exists.json.error?.code]).toEqual([409, "vault_exists"]);
    const readsSoFar = methods.length;
    const volume = await answer(await POST(buildRequest({ action: "createVault", owner: someKey(), mode: 1 })));
    expect([volume.status, volume.json.error?.code, volume.json.error?.message]).toEqual([400, "volume_not_offered", "Volume mode is not offered yet."]);
    expect(methods).toHaveLength(readsSoFar);
  });

  it("prepareLink refuses until the program is configured, and a wallet linked elsewhere; then answers the SIP_LINK_V1 consent", async () => {
    useEnv(SOLANA_ENV);
    const owner = someKey();
    const wallet = someKey();
    const vault = deriveVaultPda(owner).toBase58();
    const accounts = new Map([[vault, vaultOf(owner)]]);
    stubChain(accounts);
    const unconfigured = await answer(await POST(buildRequest({ action: "prepareLink", owner, wallet })));
    expect([unconfigured.status, unconfigured.json.error?.code]).toEqual([409, "config_missing"]);

    accounts.set(deriveConfigPda().toBase58(), config());
    const elsewhere = someKey();
    accounts.set(deriveLinkPda(wallet).toBase58(), linkOf(wallet, elsewhere));
    const linked = await answer(await POST(buildRequest({ action: "prepareLink", owner, wallet })));
    expect([linked.status, linked.json.error?.code, linked.json.error?.vault]).toEqual([409, "wallet_already_linked", elsewhere]);

    accounts.delete(deriveLinkPda(wallet).toBase58());
    const prepared = await answer(await POST(buildRequest({ action: "prepareLink", owner, wallet })));
    expect(prepared.status).toBe(200);
    expect(toHex(tryBase64Decode(prepared.json.consentMessageBase64)!)).toBe(toHex(linkConsentMessage({ programId: SIP_PROGRAM_ID, wallet, vault, owner })));
    const ownKey = await answer(await POST(buildRequest({ action: "prepareLink", owner, wallet: owner })));
    expect([ownKey.status, ownKey.json.error?.code]).toEqual([400, "wallet_is_owner"]);
  });

  it("link: a consent the trading wallet did not sign is 422 link_consent_invalid; its own consent builds a link both keys sign", async () => {
    useEnv(SOLANA_ENV);
    const owner = Keypair.generate();
    const wallet = Keypair.generate();
    const ownerKey = owner.publicKey.toBase58();
    const walletKey = wallet.publicKey.toBase58();
    const vault = deriveVaultPda(ownerKey).toBase58();
    stubChain(new Map([[vault, vaultOf(ownerKey)], [deriveConfigPda().toBase58(), config()]]));
    const consent = linkConsentMessage({ programId: SIP_PROGRAM_ID, wallet: walletKey, vault, owner: ownerKey });

    const forged = await answer(await POST(buildRequest({ action: "link", owner: ownerKey, wallet: walletKey, consentSignature: base64Encode(signMessage(Keypair.generate(), consent)) })));
    expect([forged.status, forged.json.error?.code]).toEqual([422, "link_consent_invalid"]);

    const built = await answer(await POST(buildRequest({ action: "link", owner: ownerKey, wallet: walletKey, consentSignature: base64Encode(signMessage(wallet, consent)) })));
    expect(built.status).toBe(200);
    expect(programsOf(built.json.txBase64)).toEqual([COMPUTE_BUDGET_PROGRAM, COMPUTE_BUDGET_PROGRAM, ED25519_PROGRAM, SIP_PROGRAM_ID]);
    const verified = verifySignedTransaction(signed(built.json.txBase64, owner, wallet));
    expect(verified.ok).toBe(true);
  });

  it("investPolicy: floors at 90 % and 95 % of the pools SaverFi prices from, a CreateIdempotent only for each vault account missing, and 502 price_unavailable without a pool", async () => {
    useEnv(SOLANA_ENV);
    const owner = Keypair.generate();
    const ownerKey = owner.publicKey.toBase58();
    const vault = deriveVaultPda(ownerKey).toBase58();
    const accounts = new Map<string, AccountJson>([
      [vault, vaultOf(ownerKey)],
      [SOL_USDC_POOL, poolOf(WSOL_MINT, USDC_MINT, 5_834_501_654_111_004_443n)],
      [SPYX_USDC_POOL, poolOf(SPYX_MINT, USDC_MINT, 50_911_325_114_989_095_030n)],
      // Both legs are priced, because PRICED_POOLS is one pool per offered leg:
      // without ANTHROPIC's the route reads no prices at all and refuses.
      [ANTHROPIC_USDC_POOL, poolOf(ANTHROPIC_MINT, USDC_MINT, 7_826_290_695_199_669_327n)],
      [USDC_MINT, ownedBy(TOKEN_PROGRAM, 82)],
      [SPYX_MINT, ownedBy(TOKEN_2022_PROGRAM, 82)],
      [ANTHROPIC_MINT, ownedBy(TOKEN_2022_PROGRAM, 82)],
      [deriveAta(vault, USDC_MINT, TOKEN_PROGRAM).toBase58(), ownedBy(TOKEN_PROGRAM, 165)],
    ]);
    const methods = stubChain(accounts);
    const built = await answer(await POST(buildRequest({ action: "investPolicy", owner: ownerKey })));
    expect(built.status).toBe(200);
    expect(built.json.floors).toMatchObject({
      convertWad: "90034840399943305",
      legs: [
        { mint: SPYX_MINT, wad: "124719467624105690" },
        { mint: ANTHROPIC_MINT, wad: "5277777777777777778" },
      ],
    });
    // Two CreateIdempotent, not three: the vault lacks wSOL, SPYx and ANTHROPIC,
    // and BUNDLED_VAULT_TOKEN_ACCOUNT_CREATES rides along with the first two,
    // leaving ANTHROPIC's to the keeper at the crank's expense.
    expect(programsOf(built.json.txBase64)).toEqual([COMPUTE_BUDGET_PROGRAM, COMPUTE_BUDGET_PROGRAM, ATA_PROGRAM, ATA_PROGRAM, SIP_PROGRAM_ID]);
    expect(built.json.vaultTokenAccounts.map((entry: { create: boolean }) => entry.create)).toEqual([true, false, true, false]);
    expect(built.json.costs.rentLamports).toBe(String(mainnetRent(970) + mainnetRent(165) + mainnetRent(179)));
    expect(verifySignedTransaction(signed(built.json.txBase64, owner)).ok).toBe(true);
    expect(methods.filter((method) => method === "getLatestBlockhash")).toHaveLength(1);

    accounts.delete(SPYX_USDC_POOL);
    const unpriced = await answer(await POST(buildRequest({ action: "investPolicy", owner: ownerKey })));
    expect([unpriced.status, unpriced.json.error?.code]).toEqual([502, "price_unavailable"]);
    expect(unpriced.json).not.toHaveProperty("txBase64");
  });

  /**
   * WHICH OF THE PANEL FIELDS THE SERVER ACTUALLY TAKES, pinned so the form is
   * never built against a field the route would refuse — and so that CHANGING
   * the whitelist turns this red and says "now re-wire the form".
   *
   * THE OWNER ASKED FOR FOUR: minimum per buy, cap per buy, basket weights and
   * cap per settlement. All four are buildable now. investPolicy takes the two
   * caps, the minimum, the weights and the venue (INVEST_POLICY_FIELDS in
   * solana-core/src/server/build-handler.ts); the settlement cap is a VAULT
   * field and rides on setPolicy, which is a real action and writes all six of
   * the vault's rule at once.
   *
   * SO WHAT THIS PINS IS THE SHAPE, not the refusal. Each field is accepted
   * only in the one form the panel may send it, and every wrong form is refused
   * before a single account is read — which is what lets the form send these
   * without guessing.
   */
  it("investPolicy takes the caps, the minimum, the weights by mint and the venue by name, and refuses every other shape before it reads a thing; the settlement cap rides on setPolicy", async () => {
    useEnv(SOLANA_ENV);
    const owner = someKey();
    const methods = stubChain(new Map());
    const sent = async (action: string, body: Record<string, unknown>): Promise<[number, string | undefined, string | undefined]> => {
      const response = await answer(await POST(buildRequest({ action, owner, ...body })));
      return [response.status, response.json.error?.code, response.json.error?.message];
    };
    /** A shape the route must refuse BEFORE it reads anything: pinned per call, not in aggregate. */
    const refusedAction = async (action: string, body: Record<string, unknown>): Promise<[number, string | undefined, string | undefined]> => {
      const before = methods.length;
      const result = await sent(action, body);
      expect(methods.length, `a refused ${action} shape must not read the chain`).toBe(before);
      return result;
    };
    const refused = (body: Record<string, unknown>) => refusedAction("investPolicy", body);
    /** A shape the route must ACCEPT: it gets past every check into the chain reads. */
    const accepted = (body: Record<string, unknown>) => sent("investPolicy", body);
    // ACCEPTED means the route got past the whitelist and the shape checks into
    // the chain reads, where this owner has no vault. It is the only "yes" a
    // build route gives a request it cannot finish.
    const ACCEPTED: [number, string, string] = [409, "vault_missing", "Create your vault first."];

    // ── THE MINIMUM PER BUY: a USDC raw amount as a decimal string ───────────
    expect(await accepted({ minInvestment: "2500000" })).toEqual(ACCEPTED);
    const minWords = 'minInvestment is a USDC raw amount (6 decimals), written as a decimal string: "5000000" is $5.00.';
    expect(await refused({ minInvestment: 2_500_000 })).toEqual([400, "bad_request", minWords]);
    expect(await refused({ minInvestment: "2.5" })).toEqual([400, "bad_request", minWords]);

    // ── THE WEIGHTS: {mint, weightBps} pairs, by mint, summing to 10,000 ─────
    const both = (spyx: number, anthropic: number) => [
      { mint: SPYX_MINT, weightBps: spyx },
      { mint: ANTHROPIC_MINT, weightBps: anthropic },
    ];
    expect(await accepted({ weights: both(5_000, 5_000) })).toEqual(ACCEPTED);
    expect(await accepted({ weights: both(7_000, 3_000) })).toEqual(ACCEPTED);
    // POSITIONAL WEIGHTS ARE REFUSED: the catalogue's order is not a contract.
    expect(await refused({ weights: [5_000, 5_000] })).toEqual([400, "bad_request", "weights[0] must be an object { mint, weightBps }."]);
    // A SUM THAT IS NOT 10,000 IS NOT NORMALISED, it is refused by name.
    expect(await refused({ weights: both(5_000, 4_999) })).toEqual([
      400,
      "bad_request",
      "the weights must add up to exactly 10000 basis points; these add up to 9999.",
    ]);
    // A LEG LEFT OUT IS THE FEATURE NOW, NOT A REFUSAL. The owner asked to
    // choose — "que el user pueda seleccionar las que quiere y las que no" —
    // and set_invest_policy has always taken 1..MAX_LEGS legs and known nothing
    // about a catalogue. So a basket that names ONE of the offered stocks at
    // the whole 10,000 is a legal basket and gets past the shape checks. This
    // assertion used to read the other way, which is what made the whole shelf
    // the only basket anybody could sign.
    expect(await accepted({ weights: [{ mint: SPYX_MINT, weightBps: 10_000 }] })).toEqual(ACCEPTED);

    // WHAT THE SUBSET RULE STILL REFUSES, and in this order, each before a
    // single account is read.
    // An empty basket: the program takes at least one leg, and there is no such
    // thing as a policy that buys nothing on purpose.
    expect(await refused({ weights: [] })).toEqual([400, "bad_request", "weights names no stock at all. A basket holds at least one."]);
    // MORE THAN THE PICKER OFFERS, refused with the PRODUCT's five rather than
    // the program's eight: a refusal has to be reachable from the screen that
    // caused it, and a sixth stock cannot come from this form at all. Checked
    // before the unoffered-mint rule, so the count is answered on its own terms.
    const six = Array.from({ length: 6 }, () => ({ mint: someKey(), weightBps: 1_000 }));
    expect(await refused({ weights: six })).toEqual([400, "bad_request", "weights names 6 stocks; a basket holds at most 5."]);
    // A MINT SAVERFI DOES NOT OFFER, which is the disagreement keying by mint
    // exists to catch: it needs a floor, a rent and a token program this server
    // pinned, and an unknown mint has none of them.
    const stranger = someKey();
    expect(await refused({ weights: [{ mint: stranger, weightBps: 10_000 }] })).toEqual([
      400,
      "bad_request",
      `weights names ${stranger}, which SaverFi does not offer.`,
    ]);

    // ── THE VENUE: A NAME, NEVER A PROGRAM ID FROM THE BROWSER ───────────────
    const venueWords = "venue must be one of: raydium-clmm. It is a venue's name, never a program address.";
    expect(await accepted({ venue: "raydium-clmm" })).toEqual(ACCEPTED);
    expect(await refused({ venue: RAYDIUM_CLMM })).toEqual([400, "bad_request", venueWords]);
    expect(await refused({ venue: "orca-whirlpool" })).toEqual([400, "bad_request", venueWords]);

    // ── THE SETTLEMENT CAP IS NOT AN investPolicy FIELD ──────────────────────
    // It is the VAULT's rule, and it moves through setPolicy, which exists.
    expect(await refused({ maxContribution: "60000000" })).toEqual([400, "bad_request", "Unexpected field maxContribution."]);
    // setPolicy WRITES ALL SIX, so a partial call is refused rather than having
    // the missing fields guessed: the form must send the vault's current values
    // back alongside the one it is changing.
    expect(await refusedAction("setPolicy", { maxContribution: "60000000" })).toEqual([400, "bad_request", "mode must be profit or volume."]);
    expect(await refusedAction("setPolicy", { mode: "profit", skimBps: 2_000, volumeBps: 50, paused: false, maxContribution: "60000000" })).toEqual([
      400,
      "bad_request",
      "maxContribution and walletReserve are lamports, written as decimal strings. set_policy_v2 writes every field, so both must be named.",
    ]);
    expect(
      await sent("setPolicy", { mode: "profit", skimBps: 2_000, volumeBps: 50, paused: false, maxContribution: "60000000", walletReserve: "10000000" }),
    ).toEqual(ACCEPTED);

    // THE CAPS ARE BASE UNITS AS DECIMAL STRINGS, and the route enforces it: a
    // float and a JavaScript number are both refused, so no cap can arrive
    // through a lossy double.
    const capWords = "maxPerCall and maxRolling30d are USDC raw units, written as decimal strings.";
    expect(await refused({ maxPerCall: 1_000_000_000 })).toEqual([400, "bad_request", capWords]);
    expect(await refused({ maxPerCall: "1000.5" })).toEqual([400, "bad_request", capWords]);
    expect(await refused({ maxPerCall: "1e9" })).toEqual([400, "bad_request", capWords]);
    // Every refusal above proved, at the point it was made, that it cost no
    // read; and every ACCEPTED shape reached the chain, which is what "accepted"
    // means for a build route that cannot finish without a vault.
    expect(methods.length).toBeGreaterThan(0);
  });


  it("withdraw past what the vault can release is 422 above_withdrawable; withdrawToken of a mint the vault does not hold is 422 not_held", async () => {
    useEnv(SOLANA_ENV);
    const owner = someKey();
    const vault = deriveVaultPda(owner).toBase58();
    stubChain(new Map([[vault, { ...vaultOf(owner), lamports: mainnetRent(125) + 1_000 }]]));
    const above = await answer(await POST(buildRequest({ action: "withdraw", owner, lamports: "1001" })));
    expect([above.status, above.json.error?.code, above.json.error?.withdrawableLamports]).toEqual([422, "above_withdrawable", "1000"]);
    const within = await answer(await POST(buildRequest({ action: "withdraw", owner, lamports: "1000" })));
    expect([within.status, programsOf(within.json.txBase64)]).toEqual([200, [COMPUTE_BUDGET_PROGRAM, COMPUTE_BUDGET_PROGRAM, SIP_PROGRAM_ID]]);
    const notHeld = await answer(await POST(buildRequest({ action: "withdrawToken", owner, mint: SPYX_MINT, amountRaw: "1", vaultToken: someKey() })));
    expect([notHeld.status, notHeld.json.error?.code]).toEqual([422, "not_held"]);
  });

  it("an upstream that fails is 502 unreadable, and the answer never contains the upstream URL", async () => {
    const route = solanaBuildRoute({ env: SOLANA_ENV, onRefusal: () => undefined });
    stubChain(new Map(), true);
    const response = await answer(await route.POST(buildRequest({ action: "createVault", owner: someKey(), mode: 0 })));
    expect([response.status, response.json.error?.code]).toEqual([502, "unreadable"]);
    expect(response.text).not.toContain(SECRET);
    expect(response.text).not.toContain("upstream.invalid");
  });

  it("refuses cross-site (403) and text/plain (415); the 21st request from one client within a minute is 429; GET is 405", async () => {
    const route = solanaBuildRoute({ env: SOLANA_ENV, now: () => 0, onRefusal: () => undefined });
    const methods = stubChain(new Map());
    expect((await route.POST(buildRequest({ action: "nothing" }, { "sec-fetch-site": "cross-site" }))).status).toBe(403);
    expect((await route.POST(buildRequest({ action: "nothing" }, { "content-type": "text/plain" }))).status).toBe(415);
    const client = { "x-envoy-external-address": "203.0.113.90" };
    for (let i = 0; i < 20; i++) expect((await route.POST(buildRequest({ action: "nothing" }, client))).status).toBe(400);
    const limited = await route.POST(buildRequest({ action: "nothing" }, client));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).not.toBeNull();
    expect(methods).toHaveLength(0);
    expect(GET().status).toBe(405);
  });
});
