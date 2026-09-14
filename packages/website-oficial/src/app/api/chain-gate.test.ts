// The EVM API routes under SIP_CHAIN=solana (404), and proof that with SIP_CHAIN
// unset they answer as they did, including /api/rpc's limiter after it moved to
// src/lib/rate-limit.ts. No network: fetch throws if anything tries.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EVM_ROUTE_OFF_MESSAGE } from "@/lib/config";

import { POST as createVault } from "./create-vault/route";
import { GET as dashboard } from "./dashboard/route";
import { GET as health } from "./health/route";
import { POST as rpc } from "./rpc/route";
import { GET as skims } from "./skims/route";
import { GET as vault } from "./vault/route";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const NAMES = [
  "SIP_CHAIN",
  "NUVEM_RPC_URL",
  "SIP_RPC_URL",
  "RPC_URL",
  "RPC_URL_4663",
  "NUVEM_VAULT_FACTORY",
  "SIP_VAULT_FACTORY",
  "VAULT_FACTORY",
  "NEXT_PUBLIC_VAULT_FACTORY",
  "NUVEM_PUBLIC_RPC_URL",
  "SIP_PUBLIC_RPC_URL",
  "NEXT_PUBLIC_RPC_URL",
  "NEXT_PUBLIC_RPC_URL_4663",
  "NUVEM_DISABLE_RPC_PROXY",
  "SIP_DISABLE_RPC_PROXY",
  "NUVEM_CHAIN_ID",
  "SIP_CHAIN_ID",
  "NEXT_PUBLIC_CHAIN_ID",
  "CHAIN_ID",
  "SIP_TRUSTED_CLIENT_IP_HEADER",
  "DATABASE_URL",
  "SIP_DATABASE_URL",
  "NUVEM_DATABASE_URL",
];

function environment(values: Readonly<Record<string, string>>): void {
  for (const name of NAMES) vi.stubEnv(name, undefined);
  for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
}

const post = (url: string, body: string, headers: Record<string, string> = {}): Request =>
  new Request(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

beforeEach(() => {
  vi.stubGlobal("fetch", async () => {
    throw new Error("no upstream call is expected in these tests");
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SIP_CHAIN=solana: the EVM API routes do not exist on this deployment", () => {
  it("answer 404 whatever else is set", async () => {
    environment({ SIP_CHAIN: "solana", NUVEM_RPC_URL: "https://evm.invalid/v2/EVMKEY", NUVEM_VAULT_FACTORY: ADDRESS });
    const answers: [string, Response][] = [
      ["/api/rpc", await rpc(post("https://sip.example/api/rpc", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId" })))],
      ["/api/vault", await vault(new Request(`https://sip.example/api/vault?admin=${ADDRESS}`))],
      ["/api/create-vault", await createVault(post("https://sip.example/api/create-vault", "{}"))],
      ["/api/dashboard", await dashboard(new Request(`https://sip.example/api/dashboard?admin=${ADDRESS}`))],
      ["/api/skims", await skims(new Request(`https://sip.example/api/skims?vault=${ADDRESS}`))],
    ];
    for (const [route, response] of answers) {
      expect([route, response.status]).toEqual([route, 404]);
      expect(await response.text()).toContain(EVM_ROUTE_OFF_MESSAGE);
    }
  });

  it("/api/health stays up", () => {
    environment({ SIP_CHAIN: "solana" });
    expect(health().status).toBe(200);
  });
});

describe("SIP_CHAIN unset: the EVM routes answer as before", () => {
  it("/api/rpc with no upstream configured is the same 503", async () => {
    environment({});
    const response = await rpc(post("https://sip.example/api/rpc", "{}"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32000, message: "This deployment is not configured: no upstream RPC is set." },
    });
  });

  it("/api/rpc still allows 60 requests a minute per client, keyed by the old header order", async () => {
    environment({ NUVEM_RPC_URL: "https://evm.invalid/v2/EVMKEY", NUVEM_VAULT_FACTORY: ADDRESS });
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    // cf-connecting-ip wins over a rotating x-forwarded-for, as it always did.
    const send = (ip: string, hop: number) =>
      rpc(post("https://sip.example/api/rpc", "not json", { "cf-connecting-ip": ip, "x-forwarded-for": `10.0.0.${hop}` }));
    for (let i = 0; i < 60; i++) expect((await send("198.51.100.60", i)).status).toBe(400);
    const limited = await send("198.51.100.60", 61);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("1");
    expect(((await limited.json()) as { error: { message: string } }).error.message).toBe(
      "Rate limit: 60 requests a minute per client. Retry in 1 s.",
    );
    expect((await send("198.51.100.61", 62)).status).toBe(400);
  });

  it("an unreadable SIP_CHAIN is a configuration problem (503), never a guess", async () => {
    environment({ SIP_CHAIN: "sol", NUVEM_RPC_URL: "https://evm.invalid/v2/EVMKEY", NUVEM_VAULT_FACTORY: ADDRESS });
    const response = await skims(new Request(`https://sip.example/api/skims?vault=${ADDRESS}`));
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("SIP_CHAIN");
  });
});
