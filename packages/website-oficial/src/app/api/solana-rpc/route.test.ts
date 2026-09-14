// /api/solana-rpc as wired in this app: the settings gate, the environment, and
// the core handler behind them. The relay's own rules (allowlist, parameters,
// weights, caps) are tested in @sip/solana-core; these prove the route reaches
// them. No network: fetch is a stub and every URL is an .invalid host with a fake key.

import { SIP_PROGRAM_ID } from "@sip/solana-core/client";
import { DEFAULT_RELAY_LIMITS } from "@sip/solana-core/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { solanaRpcRoute } from "@/lib/solana-routes";

import { GET, POST } from "./route";

const SECRET = "WEBRPCSECRET123";
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

let lastIp = 0;
const freshIp = (): string => `198.51.100.${(lastIp = (lastIp % 250) + 1)}`;

type RpcBody = { readonly id?: unknown; readonly method?: string };

function rpcRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://sip.example/api/solana-rpc", {
    method: "POST",
    headers: { "content-type": "application/json", "x-envoy-external-address": freshIp(), ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const call = (method: string, params: unknown[] = [], id: number | string = 1) => ({ jsonrpc: "2.0", id, method, params });

const ok = (body: RpcBody, result: unknown): Response =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? null, result }), { status: 200, headers: { "content-type": "application/json" } });

function parse(init?: RequestInit): RpcBody {
  return JSON.parse(typeof init?.body === "string" ? init.body : "null") as RpcBody;
}

/** Replaces the global fetch, which the core's pool looks up at call time. */
function stubUpstream(answer: (body: RpcBody) => Response): { url: string; body: unknown }[] {
  const seen: { url: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit): Promise<Response> => {
    const body = parse(init);
    seen.push({ url: String(input), body });
    return answer(body);
  });
  return seen;
}

function useEnv(env: Readonly<Record<string, string | undefined>>): void {
  for (const name of NAMES) vi.stubEnv(name, undefined);
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("/api/solana-rpc", () => {
  it("has no off switch: with SIP_CHAIN unset, or a leftover SIP_CHAIN=solana, it relays", async () => {
    for (const env of [SOLANA_ENV, { ...SOLANA_ENV, SIP_CHAIN: "solana" }]) {
      useEnv(env);
      stubUpstream((body) => ok(body, 1));
      expect((await POST(rpcRequest(call("getSlot")))).status).toBe(200);
    }
  });

  it("is 503 with no detail, never 404, when the settings are incomplete or the environment holds a refused name", async () => {
    const refused: Readonly<Record<string, string | undefined>>[] = [
      { ...SOLANA_ENV, SIP_SOLANA_RPC_URLS: undefined },
      { ...SOLANA_ENV, SIP_CHAIN: "evm" },
      { ...SOLANA_ENV, SIP_SOLANA_SETTLE_KEY: "" },
      { ...SOLANA_ENV, PRIVY_APP_SECRET: "" },
    ];
    for (const env of refused) {
      useEnv(env);
      const seen = stubUpstream((body) => ok(body, 1));
      const response = await POST(rpcRequest(call("getSlot")));
      expect(response.status).toBe(503);
      const text = await response.text();
      expect((JSON.parse(text) as { error: { code: number } }).error.code).toBe(-32000);
      expect(text).not.toMatch(/SIP_|NUVEM_|PRIVY_|variable/);
      expect(seen).toHaveLength(0);
    }
  });

  it("relays an allowed call to SIP_SOLANA_RPC_URLS as the validated call, and never shows the key", async () => {
    useEnv(SOLANA_ENV);
    const seen = stubUpstream((body) => ok(body, { context: { slot: 7 }, value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 99 } }));
    const sent = call("getLatestBlockhash", [{ commitment: "confirmed" }], "a1");
    const response = await POST(rpcRequest(sent));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ id: "a1", result: { value: { lastValidBlockHeight: 99 } } });
    expect(text).not.toContain(SECRET);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(UPSTREAM);
    const forwarded = Array.isArray(seen[0]!.body) ? (seen[0]!.body as unknown[])[0] : seen[0]!.body;
    expect(forwarded).toEqual(sent);
  });

  it("ignores the retired EVM variables: an old NUVEM_CHAIN_ID and an EVM RPC URL change nothing, and no warning quotes them", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    useEnv({ ...SOLANA_ENV, NUVEM_CHAIN_ID: "4663", NUVEM_RPC_URL: "https://evm.invalid/v2/EVMKEY" });
    stubUpstream((body) => ok(body, 12));
    expect((await POST(rpcRequest(call("getSlot")))).status).toBe(200);
    const logged = warn.mock.calls.flat().map(String).join("\n");
    expect(logged).not.toContain("EVMKEY");
    expect(logged).not.toContain("evm.invalid");
  });

  it("refuses a CORS-simple text/plain POST (415) and a cross-site one (403) before anything upstream", async () => {
    useEnv(SOLANA_ENV);
    const seen = stubUpstream((body) => ok(body, 1));
    expect((await POST(rpcRequest(call("getSlot"), { "content-type": "text/plain" }))).status).toBe(415);
    expect((await POST(rpcRequest(call("getSlot"), { "sec-fetch-site": "cross-site" }))).status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it("does not relay history, program scans or broadcasts (403 -32601): those are server-side or verified", async () => {
    useEnv(SOLANA_ENV);
    const seen = stubUpstream((body) => ok(body, null));
    const refused: [string, unknown[]][] = [
      ["getProgramAccounts", [SIP_PROGRAM_ID, { encoding: "base64", filters: [{ dataSize: 129 }] }]],
      ["getSignaturesForAddress", [SIP_PROGRAM_ID, { limit: 5 }]],
      ["getTransaction", ["1".repeat(88), { maxSupportedTransactionVersion: 0 }]],
      ["sendTransaction", ["AQ==", { encoding: "base64" }]],
    ];
    for (const [method, params] of refused) {
      const response = await POST(rpcRequest(call(method, params)));
      expect([method, response.status]).toEqual([method, 403]);
      expect(((await response.json()) as { error: { code: number } }).error.code).toBe(-32601);
    }
    expect(seen).toHaveLength(0);
  });

  it("refuses an oversized body and a batch of 11 (413)", async () => {
    useEnv(SOLANA_ENV);
    const seen = stubUpstream((body) => ok(body, 1));
    expect((await POST(rpcRequest({ ...call("getSlot"), padding: "x".repeat(70_000) }))).status).toBe(413);
    expect((await POST(rpcRequest(Array.from({ length: 11 }, (_, i) => call("getSlot", [], i))))).status).toBe(413);
    expect(seen).toHaveLength(0);
  });

  it("answers 502 without the endpoint when the upstream fails, even if the error quotes it", async () => {
    const route = solanaRpcRoute({
      env: SOLANA_ENV,
      fetch: (async () => {
        throw new Error(`connect ECONNREFUSED ${UPSTREAM}`);
      }) as typeof fetch,
      onRefusal: () => undefined,
    });
    const response = await route.POST(rpcRequest(call("getSlot")));
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("upstream.invalid");
  });

  it("the token past the per-client allowance (60) within a minute is 429 with retry-after", async () => {
    const route = solanaRpcRoute({
      env: SOLANA_ENV,
      fetch: (async (_input: unknown, init?: RequestInit) => ok(parse(init), 5)) as typeof fetch,
      now: () => 0,
      onRefusal: () => undefined,
    });
    const perClient = DEFAULT_RELAY_LIMITS.perClientPerMin;
    expect(perClient).toBe(60);
    const client = { "x-envoy-external-address": "203.0.113.77" };
    for (let i = 0; i < perClient; i++) expect((await route.POST(rpcRequest(call("getSlot", [], i), client))).status).toBe(200);
    const limited = await route.POST(rpcRequest(call("getSlot", [], perClient + 1), client));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("1");
    // A rotating header the edge does not write buys nothing.
    const spoofed = await route.POST(rpcRequest(call("getSlot", [], 122), { ...client, "cf-connecting-ip": "198.51.100.200" }));
    expect(spoofed.status).toBe(429);
  });

  it("GET is 405", () => {
    expect(GET().status).toBe(405);
  });
});
