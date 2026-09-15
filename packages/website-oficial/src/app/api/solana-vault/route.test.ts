// /api/solana-vault as wired in this app: the gate, the environment, and the core
// state handler behind them (tested in depth in @sip/solana-core). No network.

import { SIP_ACCOUNT_SPACE, SIP_PROGRAM_ID, accountDiscriminator, base64Encode, encodeStruct } from "@sip/solana-core/client";
import { deriveConfigPda, deriveInvestPda, deriveLinkPda, deriveVaultPda } from "@sip/solana-core/server";
import { Keypair } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { solanaVaultRoute } from "@/lib/solana-routes";

import { GET, POST } from "./route";

const SECRET = "WEBVAULTSECRET321";
const UPSTREAM = `https://upstream.invalid/?api-key=${SECRET}`;
const SOLANA_ENV = {
  SIP_SOLANA_RPC_URLS: UPSTREAM,
  SIP_SOLANA_PROGRAM_ID: SIP_PROGRAM_ID,
  SIP_TRUSTED_CLIENT_IP_HEADER: "x-envoy-external-address",
} as const;
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

let lastIp = 0;
const freshIp = (): string => `198.51.100.${(lastIp = (lastIp % 250) + 1)}`;

function stateRequest(body: unknown): Request {
  return new Request("https://sip.example/api/solana-vault", {
    method: "POST",
    headers: { "content-type": "application/json", "x-envoy-external-address": freshIp() },
    body: JSON.stringify(body),
  });
}

function useEnv(env: Readonly<Record<string, string | undefined>>): void {
  for (const name of NAMES) vi.stubEnv(name, undefined);
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
}

type RpcCall = { readonly id?: unknown; readonly method?: string; readonly params?: readonly unknown[] };
type AccountJson = { data: [string, "base64"]; lamports: number; owner: string; executable: boolean; rentEpoch: number; space: number };

function stubChain(accounts: ReadonlyMap<string, AccountJson>, down = false): void {
  const one = (call: RpcCall): Record<string, unknown> => {
    const params = call.params ?? [];
    switch (call.method) {
      case "getMultipleAccounts":
        return { jsonrpc: "2.0", id: call.id ?? null, result: { context: { slot: 9 }, value: (params[0] as string[]).map((address) => accounts.get(address) ?? null) } };
      case "getMinimumBalanceForRentExemption":
        return { jsonrpc: "2.0", id: call.id ?? null, result: ((params[0] as number) + 128) * 5_080 };
      default:
        return { jsonrpc: "2.0", id: call.id ?? null, error: { code: -32601, message: "not stubbed" } };
    }
  };
  vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit): Promise<Response> => {
    if (down) throw new Error(`socket hang up ${UPSTREAM}`);
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "null") as RpcCall | RpcCall[];
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)), { status: 200, headers: { "content-type": "application/json" } });
  });
}

function sipAccount(name: "Vault" | "TradingLink" | "ProtocolConfig", fields: Record<string, unknown>, lamports = 2_000_000): AccountJson {
  const bytes = new Uint8Array(SIP_ACCOUNT_SPACE[name]);
  bytes.set(accountDiscriminator(name), 0);
  bytes.set(encodeStruct(name, fields), 8);
  return { data: [base64Encode(bytes), "base64"], lamports, owner: SIP_PROGRAM_ID, executable: false, rentEpoch: 0, space: bytes.length };
}

const someKey = (): string => Keypair.generate().publicKey.toBase58();

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("/api/solana-vault", () => {
  it("is 503 unavailable with no detail when a refused name is present", async () => {
    useEnv({ ...SOLANA_ENV, PRIVY_APP_SECRET: "" });
    stubChain(new Map());
    const response = await POST(stateRequest({ action: "state", owner: someKey(), wallets: [] }));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(/SIP_|PRIVY_|variable/);
  });

  it("answers the vault with bigints as strings, the config, and each trading wallet's link", async () => {
    useEnv(SOLANA_ENV);
    const owner = someKey();
    const vault = deriveVaultPda(owner).toBase58();
    const [mine, theirs, fresh] = [someKey(), someKey(), someKey()];
    const reserved = (length: number) => new Array(length).fill(0);
    stubChain(
      new Map([
        [
          vault,
          sipAccount(
            "Vault",
            { owner, bump: 255, version: 2, paused: false, skim_bps: 2_000, lifetime_saved: 9_007_199_254_740_993n, created_at: 1n, skim_mode: 0, volume_bps: 200, policy_nonce: 0n, max_contribution: 60_000_000n, wallet_reserve: 50_000_000n, _reserved: reserved(37) },
            300_000_000,
          ),
        ],
        [deriveConfigPda().toBase58(), sipAccount("ProtocolConfig", { authority: someKey(), attester: someKey(), bump: 253, keeper: someKey(), pending_authority: "11111111111111111111111111111111", paused: true, version: 2, _reserved: reserved(64) })],
        [deriveLinkPda(mine).toBase58(), sipAccount("TradingLink", { wallet: mine, vault, epoch: 7n, settlement_nonce: 0n, frontier_slot: 0n, bump: 254, _reserved: reserved(32) })],
        [deriveLinkPda(theirs).toBase58(), sipAccount("TradingLink", { wallet: theirs, vault: someKey(), epoch: 7n, settlement_nonce: 0n, frontier_slot: 0n, bump: 254, _reserved: reserved(32) })],
      ]),
    );
    const response = await POST(stateRequest({ action: "state", owner, wallets: [mine, theirs, fresh] }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.vault).toMatchObject({ status: "exists", address: vault, lamports: "300000000", rentFloor: String(253 * 5_080) });
    // Past 2^53: a number would have lost the last digit.
    expect(body.vault.state.lifetimeSaved).toBe("9007199254740993");
    expect(body.policy).toEqual({ status: "missing", address: deriveInvestPda(vault).toBase58() });
    expect(body.config).toMatchObject({ status: "exists", exists: true, paused: true });
    expect(body.walletLinks.map((link: { status: string }) => link.status)).toEqual(["this_vault", "other_vault", "missing"]);
    expect(body.rents).toEqual({ vault: String(253 * 5_080), link: String(257 * 5_080) });
    // The pools are not in this stub's map, so there is no price rather than a guessed one.
    expect(body.prices).toBeNull();
  });

  it("an unreadable read is reported unreadable, never missing, and the endpoint never appears", async () => {
    const route = solanaVaultRoute({ env: SOLANA_ENV, onRefusal: () => undefined });
    stubChain(new Map(), true);
    const wallet = someKey();
    const response = await route.POST(stateRequest({ action: "state", owner: someKey(), wallets: [wallet] }));
    const text = await response.text();
    expect(response.status).toBe(200);
    const body = JSON.parse(text) as Record<string, any>;
    expect([body.vault.status, body.policy.status, body.config.status]).toEqual(["unreadable", "unreadable", "unreadable"]);
    expect(body.walletLinks).toEqual([{ wallet, link: deriveLinkPda(wallet).toBase58(), status: "unreadable", vault: null }]);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("upstream.invalid");
  });

  it("GET is 405", () => {
    expect(GET().status).toBe(405);
  });
});
