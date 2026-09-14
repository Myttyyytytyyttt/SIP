// /api/solana-tx as wired in this app: the settings gate, the environment, and
// the core verifier and sender behind them (tested in depth in @sip/solana-core).
// Every key is Keypair.generate(); every URL an .invalid host. No network.

import { createPrivateKey, sign } from "node:crypto";

import {
  DEFAULT_RATES,
  OLD_NUVEM_PROGRAM_ID,
  SIP_PROGRAM_ID,
  base58Encode,
  base64Encode,
  instructionDiscriminator,
  tryBase64Decode,
} from "@sip/solana-core/client";
import { buildCreateVaultV2, buildLinkWallet, prepareLinkWalletConsent } from "@sip/solana-core/server";
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { solanaTxRoute } from "@/lib/solana-routes";

import { GET, POST } from "./route";

const SECRET = "WEBTXSECRET456";
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

/** A fixed, valid-looking blockhash: nothing here is ever simulated for real. */
const BLOCKHASH = base58Encode(Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 1) & 0xff));

let lastIp = 0;
const freshIp = (): string => `198.51.100.${(lastIp = (lastIp % 250) + 1)}`;

type RpcBody = { readonly id?: unknown; readonly method?: string; readonly params?: unknown[] };

function sendRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://sip.example/api/solana-tx", {
    method: "POST",
    headers: { "content-type": "application/json", "x-envoy-external-address": freshIp(), ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const rpcOk = (body: RpcBody, result: unknown): Response =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? null, result }), { status: 200, headers: { "content-type": "application/json" } });

const parse = (init?: RequestInit): RpcBody => JSON.parse(typeof init?.body === "string" ? init.body : "null") as RpcBody;

function useEnv(env: Readonly<Record<string, string | undefined>>): void {
  for (const name of NAMES) vi.stubEnv(name, undefined);
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
}

function stubUpstream(answer: (body: RpcBody) => Response): RpcBody[] {
  const seen: RpcBody[] = [];
  vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit): Promise<Response> => {
    const body = parse(init);
    seen.push(body);
    return answer(body);
  });
  return seen;
}

/** A create_vault_v2 built by the core's builder and signed by a throwaway owner. */
function signedCreateVault(): { base64: string; signature: string } {
  const owner = Keypair.generate();
  const built = buildCreateVaultV2({
    // A base58 string, not the PublicKey object: the web and the core may resolve
    // @solana/web3.js to different store instances, and a class check across two
    // copies of the class fails. Production never hands the core a web3.js object.
    owner: owner.publicKey.toBase58(),
    mode: 1,
    skimBps: DEFAULT_RATES.profitBps,
    volumeBps: DEFAULT_RATES.volumeBps,
    maxContribution: 1_000_000_000n,
    walletReserve: 0n,
    blockhash: BLOCKHASH,
  });
  const unsigned = tryBase64Decode(built.txBase64);
  if (unsigned === null) throw new Error("the builder returned something that is not base64");
  const tx = VersionedTransaction.deserialize(unsigned);
  tx.sign([owner]);
  const signature = tx.signatures[0];
  if (signature === undefined) throw new Error("no signature");
  return { base64: base64Encode(tx.serialize()), signature: base58Encode(signature) };
}

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

/** A link through both core calls: the trading wallet signs the consent, then owner and wallet sign the transaction. */
function signedLink(): { owner: Keypair; wallet: Keypair; base64: string; signature: string } {
  const owner = Keypair.generate();
  const wallet = Keypair.generate();
  // Base58 strings, not PublicKey objects, for the reason signedCreateVault gives.
  const parties = { owner: owner.publicKey.toBase58(), wallet: wallet.publicKey.toBase58() };
  const consent = tryBase64Decode(prepareLinkWalletConsent(parties).consentMessageBase64);
  if (consent === null) throw new Error("the consent is not base64");
  const built = buildLinkWallet({ ...parties, consentSignature: signMessage(wallet, consent), blockhash: BLOCKHASH });
  const unsigned = tryBase64Decode(built.txBase64);
  if (unsigned === null) throw new Error("the builder returned something that is not base64");
  const tx = VersionedTransaction.deserialize(unsigned);
  tx.sign([owner, wallet]);
  const signature = tx.signatures[0];
  if (signature === undefined) throw new Error("no signature");
  return { owner, wallet, base64: base64Encode(tx.serialize()), signature: base58Encode(signature) };
}

function signedLegacy(instruction: TransactionInstruction, payer: Keypair): string {
  const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: BLOCKHASH }).add(instruction);
  tx.sign(payer);
  return base64Encode(tx.serialize());
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("/api/solana-tx", () => {
  it("is 503 unavailable with no detail, never 404, when the settings are incomplete or a refused name is present", async () => {
    const created = signedCreateVault();
    const refused: Readonly<Record<string, string | undefined>>[] = [
      { ...SOLANA_ENV, SIP_SOLANA_PROGRAM_ID: undefined },
      { ...SOLANA_ENV, SIP_CHAIN: "evm" },
      { ...SOLANA_ENV, PRIVY_AUTHORIZATION_PRIVATE_KEY: "" },
    ];
    for (const env of refused) {
      useEnv(env);
      const seen = stubUpstream((body) => rpcOk(body, null));
      const response = await POST(sendRequest({ action: "send", signedTxBase64: created.base64 }));
      expect(response.status).toBe(503);
      const text = await response.text();
      expect((JSON.parse(text) as { error: { code: string } }).error.code).toBe("unavailable");
      expect(text).not.toMatch(/SIP_|NUVEM_|PRIVY_|variable/);
      expect(seen).toHaveLength(0);
    }
  });

  it("refuses text/plain (415) and garbage (400) with nothing sent upstream", async () => {
    useEnv(SOLANA_ENV);
    const seen = stubUpstream((body) => rpcOk(body, null));
    expect((await POST(sendRequest({ action: "send", signedTxBase64: "AQ==" }, { "content-type": "text/plain" }))).status).toBe(415);
    for (const garbage of ["{", { action: "send", signedTxBase64: "not base64!" }, { action: "buildLinkWallet" }, { action: "send" }]) {
      const response = await POST(sendRequest(garbage));
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("bad_request");
    }
    expect(seen).toHaveLength(0);
  });

  it("refuses a transaction to Nuvem's old program (422 old_program) before any upstream call", async () => {
    useEnv(SOLANA_ENV);
    const seen = stubUpstream((body) => rpcOk(body, null));
    const payer = Keypair.generate();
    const toOldProgram = new TransactionInstruction({
      programId: new PublicKey(OLD_NUVEM_PROGRAM_ID),
      keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: true }],
      data: Buffer.from(instructionDiscriminator("link_wallet")),
    });
    const response = await POST(sendRequest({ action: "send", signedTxBase64: signedLegacy(toOldProgram, payer) }));
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("old_program");
    expect(seen).toHaveLength(0);
  });

  it("refuses a plain SOL transfer (422 program_not_allowed): the route is not a transfer relay", async () => {
    useEnv(SOLANA_ENV);
    const seen = stubUpstream((body) => rpcOk(body, null));
    const payer = Keypair.generate();
    const transfer = SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 });
    const response = await POST(sendRequest({ action: "send", signedTxBase64: signedLegacy(transfer, payer) }));
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("program_not_allowed");
    expect(seen).toHaveLength(0);
  });

  it("simulates an owner's create_vault_v2 with sigVerify, then sends it, and answers with its signature", async () => {
    useEnv(SOLANA_ENV);
    const created = signedCreateVault();
    const seen = stubUpstream((body) =>
      body.method === "simulateTransaction"
        ? rpcOk(body, { context: { slot: 321 }, value: { err: null, logs: ["Program log: Instruction: CreateVaultV2"], unitsConsumed: 5_000 } })
        : rpcOk(body, created.signature),
    );
    const response = await POST(sendRequest({ action: "send", signedTxBase64: created.base64 }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      signature: created.signature,
      slot: 321,
      unitsConsumed: 5_000,
      explorerUrl: `https://solscan.io/tx/${created.signature}`,
    });
    expect(seen.map((body) => body.method)).toEqual(["simulateTransaction", "sendTransaction"]);
    expect(seen[0]!.params?.[1]).toMatchObject({ sigVerify: true, replaceRecentBlockhash: false });
    expect(seen[1]!.params?.[1]).toMatchObject({ skipPreflight: true });
  });

  it("relays a link only with the wallet's consent before it: the link is sent, the same link stripped of its consent is 422 link_consent_missing", async () => {
    useEnv(SOLANA_ENV);
    const linked = signedLink();
    const seen = stubUpstream((body) =>
      body.method === "simulateTransaction"
        ? rpcOk(body, { context: { slot: 322 }, value: { err: null, logs: ["Program log: Instruction: LinkWallet"], unitsConsumed: 9_000 } })
        : rpcOk(body, linked.signature),
    );
    const response = await POST(sendRequest({ action: "send", signedTxBase64: linked.base64 }));
    expect(response.status).toBe(200);
    expect(((await response.json()) as { signature: string }).signature).toBe(linked.signature);
    expect(seen.map((body) => body.method)).toEqual(["simulateTransaction", "sendTransaction"]);

    const bytes = tryBase64Decode(linked.base64);
    if (bytes === null) throw new Error("not base64");
    const stripped = Transaction.from(Buffer.from(bytes));
    expect(stripped.instructions.map((instruction) => instruction.programId.toBase58())).toEqual(["Ed25519SigVerify111111111111111111111111111", SIP_PROGRAM_ID]);
    stripped.instructions.shift();
    stripped.sign(linked.owner, linked.wallet);
    const refused = await POST(sendRequest({ action: "send", signedTxBase64: base64Encode(stripped.serialize()) }));
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("link_consent_missing");
    expect(seen).toHaveLength(2);
  });

  it("a send-stage upstream failure is 502 send_unconfirmed with the signature to confirm, and never quotes the endpoint", async () => {
    const created = signedCreateVault();
    const route = solanaTxRoute({
      env: SOLANA_ENV,
      fetch: (async (_input: unknown, init?: RequestInit) => {
        const body = parse(init);
        if (body.method === "simulateTransaction") return rpcOk(body, { context: { slot: 1 }, value: { err: null, logs: [], unitsConsumed: 1 } });
        throw new Error(`socket hang up ${UPSTREAM}`);
      }) as typeof fetch,
      onRefusal: () => undefined,
    });
    const response = await route.POST(sendRequest({ action: "send", signedTxBase64: created.base64 }));
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("upstream.invalid");
    expect(text).not.toContain("nothing was sent");
    const body = JSON.parse(text) as { error: { code: string; signature?: string } };
    expect(body.error.code).toBe("send_unconfirmed");
    expect(body.error.signature).toBe(created.signature);
  });

  it("the 7th send from one client within a minute is 429", async () => {
    const route = solanaTxRoute({ env: SOLANA_ENV, now: () => 0, onRefusal: () => undefined });
    const client = { "x-envoy-external-address": "203.0.113.88" };
    for (let i = 0; i < 6; i++) expect((await route.POST(sendRequest({ action: "nothing" }, client))).status).toBe(400);
    const limited = await route.POST(sendRequest({ action: "nothing" }, client));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).not.toBeNull();
  });

  it("GET is 405", () => {
    expect(GET().status).toBe(405);
  });
});
