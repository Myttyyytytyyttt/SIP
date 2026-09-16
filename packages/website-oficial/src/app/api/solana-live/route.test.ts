// /api/solana-live as wired in this app: the gate, the environment, and the core
// live handler behind them (tested in depth in @sip/solana-core). No network.

import { SIP_ACCOUNT_SPACE, SIP_PROGRAM_ID, accountDiscriminator, base64Encode, encodeStruct } from "@sip/solana-core/client";
import { deriveVaultPda } from "@sip/solana-core/server";
import { Keypair } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GET, POST } from "./route";

const SECRET = "WEBLIVESECRET654";
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

function liveRequest(body: unknown): Request {
  return new Request("https://sip.example/api/solana-live", {
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

function stubChain(accounts: ReadonlyMap<string, AccountJson>): void {
  const one = (call: RpcCall): Record<string, unknown> => {
    const params = call.params ?? [];
    switch (call.method) {
      case "getMultipleAccounts":
        return { jsonrpc: "2.0", id: call.id ?? null, result: { context: { slot: 77 }, value: (params[0] as string[]).map((address) => accounts.get(address) ?? null) } };
      case "getMinimumBalanceForRentExemption":
        return { jsonrpc: "2.0", id: call.id ?? null, result: ((params[0] as number) + 128) * 5_080 };
      case "getProgramAccounts":
        return { jsonrpc: "2.0", id: call.id ?? null, result: [] };
      default:
        return { jsonrpc: "2.0", id: call.id ?? null, error: { code: -32601, message: "not stubbed" } };
    }
  };
  vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "null") as RpcCall | RpcCall[];
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)), { status: 200, headers: { "content-type": "application/json" } });
  });
}

function vaultAccount(owner: string, lifetimeSaved: bigint, lamports: number): AccountJson {
  const bytes = new Uint8Array(SIP_ACCOUNT_SPACE.Vault);
  bytes.set(accountDiscriminator("Vault"), 0);
  bytes.set(
    encodeStruct("Vault", {
      owner,
      bump: 255,
      version: 2,
      paused: false,
      skim_bps: 2_000,
      lifetime_saved: lifetimeSaved,
      created_at: 1_789_495_565n,
      skim_mode: 0,
      volume_bps: 200,
      policy_nonce: 0n,
      max_contribution: 60_000_000n,
      wallet_reserve: 50_000_000n,
      _reserved: new Array(37).fill(0),
    }),
    8,
  );
  return { data: [base64Encode(bytes), "base64"], lamports, owner: SIP_PROGRAM_ID, executable: false, rentEpoch: 0, space: bytes.length };
}

const someKey = (): string => Keypair.generate().publicKey.toBase58();

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("/api/solana-live", () => {
  it("is 503 unavailable with no detail when a refused name is present", async () => {
    useEnv({ ...SOLANA_ENV, PRIVY_APP_SECRET: "" });
    stubChain(new Map());
    const response = await POST(liveRequest({ action: "snapshot", owner: someKey(), wallets: [], discover: false }));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(/SIP_|PRIVY_|variable/);
  });

  it("answers a snapshot with every bigint as a string", async () => {
    useEnv(SOLANA_ENV);
    const owner = someKey();
    const vault = deriveVaultPda(owner).toBase58();
    // Past 2^53: a JSON number would have lost the last digit of somebody's savings.
    stubChain(new Map([[vault, vaultAccount(owner, 9_007_199_254_740_993n, 300_000_000)]]));

    const response = await POST(liveRequest({ action: "snapshot", owner, wallets: [], discover: false }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body).toMatchObject({ owner, programId: SIP_PROGRAM_ID, slot: 77 });
    expect(typeof body.readAtMs).toBe("number");
    expect(body.vault).toMatchObject({ status: "exists", address: vault, lamports: "300000000", rentFloor: String(253 * 5_080) });
    expect(body.vault.state.lifetimeSaved).toBe("9007199254740993");
    expect(body.vault.state.maxContribution).toBe("60000000");
    expect(body.rents).toEqual({ vault: String(253 * 5_080), walletFloor: String(128 * 5_080) });
    // Nothing was asked to be discovered, so nothing is claimed about the links.
    expect(body.links).toBeNull();
  });

  it("reports a read it could not make as unreadable, never as missing", async () => {
    useEnv(SOLANA_ENV);
    vi.stubGlobal("fetch", async () => {
      throw new Error(`socket hang up ${UPSTREAM}`);
    });
    const response = await POST(liveRequest({ action: "snapshot", owner: someKey(), wallets: [], discover: false }));
    const text = await response.text();
    expect(response.status).toBe(200);
    const body = JSON.parse(text) as Record<string, any>;
    expect([body.vault.status, body.policy.status, body.config.status]).toEqual(["unreadable", "unreadable", "unreadable"]);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("upstream.invalid");
  });

  it("GET is 405", () => {
    expect(GET().status).toBe(405);
  });
});
