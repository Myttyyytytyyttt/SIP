// Server settings from an injected env object.

import { inspect } from "node:util";
import { describe, expect, it } from "vitest";

import { OLD_NUVEM_PROGRAM_ID, SIP_PROGRAM_ID } from "../src/client/idl";
import { checkPublicWsUrl } from "../src/shared/public-ws-url.mjs";
import { loadSolanaServerSettings, type Env } from "../src/server/config";
import { SECRET_QUERY, UPSTREAM_1, UPSTREAM_2 } from "./helpers";

const valid: Env = {
  SIP_SOLANA_RPC_URLS: `${UPSTREAM_1},${UPSTREAM_2}`,
  SIP_SOLANA_PROGRAM_ID: SIP_PROGRAM_ID,
  SIP_TRUSTED_CLIENT_IP_HEADER: "x-envoy-external-address",
};

function problems(env: Env): { variable: string; message: string; howToFix: string }[] {
  const load = loadSolanaServerSettings(env);
  expect(load.ok).toBe(false);
  return load.ok ? [] : [...load.problems];
}

const variables = (env: Env): string[] => problems(env).map((problem) => problem.variable);

describe("a valid Solana environment", () => {
  it("loads, with the IDL's program id and the documented defaults", () => {
    const load = loadSolanaServerSettings(valid);
    expect(load.ok).toBe(true);
    if (!load.ok) return;
    expect(load.settings.programId).toBe(SIP_PROGRAM_ID);
    expect(load.settings.rpcEndpoints).toHaveLength(2);
    expect(load.settings.rpcEndpoints[0]!.reveal()).toBe(UPSTREAM_1);
    expect(load.settings.publicWsUrl).toBe("wss://api.mainnet-beta.solana.com");
    expect(load.settings.trustedClientIpHeader).toBe("x-envoy-external-address");
    expect(load.settings.relay).toEqual({ perClientPerMin: 60, signingGlobalPerMin: 1_800, readsGlobalPerMin: 1_800 });
    expect(load.settings.send).toEqual({ perClientPerMin: 6, globalPerMin: 150 });
  });

  it("keeps every default global budget 25 or more clients deep, so a handful of addresses cannot empty it", () => {
    const load = loadSolanaServerSettings(valid);
    if (!load.ok) throw new Error("expected ok");
    const { relay, send } = load.settings;
    expect(relay.signingGlobalPerMin / relay.perClientPerMin).toBeGreaterThanOrEqual(25);
    expect(relay.readsGlobalPerMin / relay.perClientPerMin).toBeGreaterThanOrEqual(25);
    expect(send.globalPerMin / send.perClientPerMin).toBeGreaterThanOrEqual(25);
  });

  it("never serializes an endpoint", () => {
    const load = loadSolanaServerSettings(valid);
    if (!load.ok) throw new Error("expected ok");
    for (const text of [JSON.stringify(load.settings), inspect(load.settings, { depth: 10 }), JSON.stringify({ ...load.settings }), String(load.settings.rpcEndpoints)]) {
      expect(text).not.toContain(SECRET_QUERY);
      expect(text).not.toContain("upstream.invalid");
      expect(text).not.toContain("PATHTOKEN456");
    }
  });

  it("ignores EVM variables instead of refusing them", () => {
    expect(loadSolanaServerSettings({ ...valid, NUVEM_RPC_URL: "https://evm.invalid", SIP_CHAIN_ID: "4663", NUVEM_CHAIN_ID: "4663", NUVEM_VAULT_FACTORY: "0x1" }).ok).toBe(true);
  });

  it("dedupes a repeated endpoint and keeps the order", () => {
    const load = loadSolanaServerSettings({ ...valid, SIP_SOLANA_RPC_URLS: ` ${UPSTREAM_2} , ${UPSTREAM_1},${UPSTREAM_2}` });
    expect(load.ok && load.settings.rpcEndpoints.map((endpoint) => endpoint.reveal())).toEqual([UPSTREAM_2, UPSTREAM_1]);
  });

  it("lowercases the trusted header and accepts limit overrides", () => {
    const load = loadSolanaServerSettings({ ...valid, SIP_TRUSTED_CLIENT_IP_HEADER: "X-Envoy-External-Address", SIP_SOLANA_RELAY_PER_MIN: "200", SIP_SOLANA_SEND_GLOBAL_PER_MIN: "10" });
    expect(load.ok).toBe(true);
    if (!load.ok) return;
    expect(load.settings.trustedClientIpHeader).toBe("x-envoy-external-address");
    expect(load.settings.relay.perClientPerMin).toBe(200);
    expect(load.settings.send.globalPerMin).toBe(10);
  });
});

describe("refusals", () => {
  it("requires the endpoints, the program id and the client header", () => {
    expect(variables({}).sort()).toEqual(["SIP_SOLANA_PROGRAM_ID", "SIP_SOLANA_RPC_URLS", "SIP_TRUSTED_CLIENT_IP_HEADER"]);
  });

  it("refuses a non-http endpoint without echoing it", () => {
    const found = problems({ ...valid, SIP_SOLANA_RPC_URLS: `ftp://keyed.invalid/?api-key=${SECRET_QUERY}` });
    expect(found.map((problem) => problem.variable)).toContain("SIP_SOLANA_RPC_URLS");
    expect(JSON.stringify(found)).not.toContain(SECRET_QUERY);
    expect(JSON.stringify(found)).not.toContain("keyed.invalid");
  });

  it("names Nuvem's old program explicitly", () => {
    const found = problems({ ...valid, SIP_SOLANA_PROGRAM_ID: OLD_NUVEM_PROGRAM_ID });
    expect(found[0]!.message).toContain("Nuvem's old program");
    expect(found[0]!.message).not.toContain(OLD_NUVEM_PROGRAM_ID);
  });

  it("refuses any other program id", () => {
    expect(variables({ ...valid, SIP_SOLANA_PROGRAM_ID: "11111111111111111111111111111111" })).toEqual(["SIP_SOLANA_PROGRAM_ID"]);
  });

  it("refuses every NUVEM_SOLANA_* variable and names its replacement", () => {
    const found = problems({ ...valid, NUVEM_SOLANA_RPC_URL: "https://x.invalid", NUVEM_SOLANA_PUBLIC_RPC_URL: "https://y.invalid", NUVEM_SOLANA_SOMETHING_NEW: "1" });
    expect(found.map((problem) => problem.variable).sort()).toEqual(["NUVEM_SOLANA_PUBLIC_RPC_URL", "NUVEM_SOLANA_RPC_URL", "NUVEM_SOLANA_SOMETHING_NEW"]);
    expect(found.find((problem) => problem.variable === "NUVEM_SOLANA_RPC_URL")!.howToFix).toContain("SIP_SOLANA_RPC_URLS");
    expect(JSON.stringify(found)).not.toContain("x.invalid");
  });

  it("refuses the keeper's signing secrets by name, without reading them", () => {
    const env = new Proxy({ ...valid, SIP_SOLANA_SETTLE_KEY: "unused" } as Record<string, string>, {
      get(target, property: string) {
        if (property === "SIP_SOLANA_SETTLE_KEY") throw new Error("the value was read");
        return target[property];
      },
    });
    expect(variables(env)).toEqual(["SIP_SOLANA_SETTLE_KEY"]);
  });

  it("refuses a spoofable or malformed client header", () => {
    expect(variables({ ...valid, SIP_TRUSTED_CLIENT_IP_HEADER: "X-Forwarded-For" })).toEqual(["SIP_TRUSTED_CLIENT_IP_HEADER"]);
    expect(variables({ ...valid, SIP_TRUSTED_CLIENT_IP_HEADER: "bad header" })).toEqual(["SIP_TRUSTED_CLIENT_IP_HEADER"]);
  });

  it("refuses limits that are not integers, or too small for one full batch", () => {
    expect(variables({ ...valid, SIP_SOLANA_RELAY_PER_MIN: "abc" })).toEqual(["SIP_SOLANA_RELAY_PER_MIN"]);
    expect(variables({ ...valid, SIP_SOLANA_RELAY_READS_GLOBAL_PER_MIN: "29" })).toEqual(["SIP_SOLANA_RELAY_READS_GLOBAL_PER_MIN"]);
    expect(variables({ ...valid, SIP_SOLANA_SEND_PER_MIN: "0" })).toEqual(["SIP_SOLANA_SEND_PER_MIN"]);
    expect(variables({ ...valid, SIP_SOLANA_RELAY_GLOBAL_PER_MIN: "1500" })).toEqual(["SIP_SOLANA_RELAY_GLOBAL_PER_MIN"]);
  });
});

describe("SIP_SOLANA_PUBLIC_WS_URL", () => {
  const rpc = [UPSTREAM_1, "https://h.example/TOKENPATH/"];

  it.each([
    ["wss://example.org", "wss://example.org"],
    ["wss://example.org/", "wss://example.org"],
    ["wss://example.org:8443", "wss://example.org:8443"],
    ["ws://localhost:8900", "ws://localhost:8900"],
    ["", "wss://api.mainnet-beta.solana.com"],
  ])("accepts %s as %s", (raw, url) => {
    expect(checkPublicWsUrl(raw, rpc)).toMatchObject({ ok: true, url });
  });

  it.each([
    ["a query", "wss://other-host.example/?api-key=x"],
    ["an empty query", "wss://other-host.example/?"],
    ["a path", "wss://h2.example/TOKEN/"],
    ["credentials", "wss://user:pass@other.example"],
    ["a fragment", "wss://other.example/#x"],
    ["plain ws to a public host", "ws://other.example"],
    ["an RPC host", "wss://upstream.invalid"],
    ["an RPC key in the host", `wss://${SECRET_QUERY.toLowerCase()}.example`],
    ["not a URL", "wss//nope"],
  ])("refuses %s", (_, raw) => {
    expect(checkPublicWsUrl(raw, rpc).ok).toBe(false);
  });

  it("is a settings problem that never echoes the value", () => {
    const found = problems({ ...valid, SIP_SOLANA_PUBLIC_WS_URL: `wss://ws.invalid/?api-key=${SECRET_QUERY}` });
    expect(found.map((problem) => problem.variable)).toEqual(["SIP_SOLANA_PUBLIC_WS_URL"]);
    expect(JSON.stringify(found)).not.toContain(SECRET_QUERY);
  });
});
