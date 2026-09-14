// The Solana-only configuration: what the page and the routes load, and what the
// environment must not hold. Every key and URL here is a throwaway: .invalid
// hosts, placeholder values, and a placeholder Privy app id of the right length.

import { OLD_NUVEM_PROGRAM_ID, SIP_PROGRAM_ID } from "@sip/solana-core/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { toSolanaPublicConfig, type ConfigProblem, type Env } from "@/lib/config";
import { loadConfig, solanaGate } from "@/lib/load-config";

const APP_ID = "clsipplaceholderappid0000";

const RPC_SECRET = "HELIUSSECRET123";
const RPC_URL = `https://mainnet.helius-rpc.invalid/?api-key=${RPC_SECRET}`;
const SOLANA_ENV: Env = {
  PRIVY_APP_ID: APP_ID,
  SIP_SOLANA_RPC_URLS: RPC_URL,
  SIP_SOLANA_PROGRAM_ID: SIP_PROGRAM_ID,
  SIP_TRUSTED_CLIENT_IP_HEADER: "x-envoy-external-address",
};

const KEEPER_SECRETS = ["SIP_SOLANA_SETTLE_KEY", "SIP_SOLANA_PRIVY_APP_SECRET", "SIP_SOLANA_PRIVY_AUTHORIZATION_KEY"] as const;
const PRIVY_CREDENTIALS = ["PRIVY_APP_SECRET", "PRIVY_AUTHORIZATION_PRIVATE_KEY"] as const;

function problemsOf(env: Env): ConfigProblem[] {
  const load = loadConfig(env);
  if (load.ok) throw new Error("expected problems");
  return [...load.problems];
}

const variables = (env: Env): string[] => problemsOf(env).map((problem) => problem.variable);

/** An environment whose `get` throws for the named variables: proof that their values are never read. */
function readTrap(env: Record<string, string | undefined>, trapped: readonly string[]): Env {
  return new Proxy(env, {
    get(target, property, receiver) {
      if (typeof property === "string" && trapped.includes(property)) throw new Error(`the value of ${property} was read`);
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

/** A distinct, recognisable placeholder per name, so a value that leaked into a problem would show. */
const placeholders = (names: readonly string[]): Record<string, string> =>
  Object.fromEntries(names.map((name, index) => [name, `PLACEHOLDERVALUE${index}XYZ`]));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the configuration", () => {
  it("loads from the Solana names alone, and the browser's share is the relay, the public WebSocket and the program", () => {
    const load = loadConfig(SOLANA_ENV);
    if (!load.ok) throw new Error("expected a configuration");
    const publicConfig = toSolanaPublicConfig(load.config);
    expect(publicConfig).toEqual({
      privyAppId: APP_ID,
      privyClientId: null,
      privySignerId: null,
      privyPolicyId: null,
      solanaRpcUrl: "/api/solana-rpc",
      solanaWsUrl: "wss://api.mainnet-beta.solana.com",
      programId: SIP_PROGRAM_ID,
      explorer: "solscan",
    });
    expect(load.config.solana.trustedClientIpHeader).toBe("x-envoy-external-address");
    // The server object is the browser's share plus the settings, and nothing else.
    expect(Object.keys(load.config).sort()).toEqual([...Object.keys(publicConfig), "solana"].sort());
  });

  it("makes the relay URL absolute when the origin is known", () => {
    const load = loadConfig(SOLANA_ENV, { origin: "https://sip.example/" });
    expect(load.ok && load.config.solanaRpcUrl).toBe("https://sip.example/api/solana-rpc");
  });

  it("refuses Nuvem's old program by name", () => {
    const problems = problemsOf({ ...SOLANA_ENV, SIP_SOLANA_PROGRAM_ID: OLD_NUVEM_PROGRAM_ID });
    expect(problems.map((p) => p.variable)).toEqual(["SIP_SOLANA_PROGRAM_ID"]);
    expect(problems[0]!.message).toContain("Nuvem's old program");
  });

  it("refuses a program id that is not the IDL's", () => {
    expect(variables({ ...SOLANA_ENV, SIP_SOLANA_PROGRAM_ID: "11111111111111111111111111111111" })).toEqual(["SIP_SOLANA_PROGRAM_ID"]);
  });

  it("refuses a copied Nuvem Solana variable and names its replacement", () => {
    const problems = problemsOf({ ...SOLANA_ENV, NUVEM_SOLANA_RPC_URL: "https://old.invalid/?api-key=OLD" });
    expect(problems.map((p) => p.variable)).toEqual(["NUVEM_SOLANA_RPC_URL"]);
    expect(problems[0]!.howToFix).toContain("SIP_SOLANA_RPC_URLS");
  });

  it("refuses a WebSocket on the RPC host, or one carrying a query", () => {
    expect(variables({ ...SOLANA_ENV, SIP_SOLANA_PUBLIC_WS_URL: "wss://mainnet.helius-rpc.invalid" })).toEqual(["SIP_SOLANA_PUBLIC_WS_URL"]);
    expect(variables({ ...SOLANA_ENV, SIP_SOLANA_PUBLIC_WS_URL: "wss://ws.example.org/?api-key=x" })).toEqual(["SIP_SOLANA_PUBLIC_WS_URL"]);
  });

  it("requires the RPC URLs and the one trusted client-IP header", () => {
    const { SIP_SOLANA_RPC_URLS: _rpc, SIP_TRUSTED_CLIENT_IP_HEADER: _header, ...bare } = SOLANA_ENV;
    expect(variables(bare).sort()).toEqual(["SIP_SOLANA_RPC_URLS", "SIP_TRUSTED_CLIENT_IP_HEADER"]);
  });

  it("the Solana seat is both or neither, never the same id twice", () => {
    expect(variables({ ...SOLANA_ENV, SIP_SOLANA_PRIVY_SIGNER_ID: "signer-id-0000000000000000" })).toEqual(["SIP_SOLANA_PRIVY_SIGNER_ID"]);
    expect(
      variables({ ...SOLANA_ENV, SIP_SOLANA_PRIVY_SIGNER_ID: "same-id-00000000000000000", SIP_SOLANA_PRIVY_POLICY_ID: "same-id-00000000000000000" }),
    ).toEqual(["SIP_SOLANA_PRIVY_POLICY_ID"]);
    const both = loadConfig({ ...SOLANA_ENV, SIP_SOLANA_PRIVY_SIGNER_ID: "signer-id-0000000000000000", SIP_SOLANA_PRIVY_POLICY_ID: "policy-id-0000000000000000" });
    expect(both.ok && toSolanaPublicConfig(both.config)).toMatchObject({ privySignerId: "signer-id-0000000000000000", privyPolicyId: "policy-id-0000000000000000" });
    // The EVM pair is not read: a leftover changes nothing but a warning.
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(loadConfig({ ...SOLANA_ENV, PRIVY_SIGNER_ID: "evm-signer-00000000000000" }).ok).toBe(true);
  });

  it("applies Privy's app-id length rule on the page, and not for callers that do not need it", () => {
    expect(variables({ ...SOLANA_ENV, PRIVY_APP_ID: "short" })).toEqual(["PRIVY_APP_ID"]);
    const { PRIVY_APP_ID: _app, ...noApp } = SOLANA_ENV;
    const load = loadConfig(noApp, { needPrivyAppId: false });
    expect(load.ok && load.config.privyAppId).toBe("");
  });

  it("never lets an endpoint key into the browser's share, the server object's JSON, or a problem", () => {
    const load = loadConfig(SOLANA_ENV);
    if (!load.ok) throw new Error("expected a configuration");
    const publicJson = JSON.stringify(toSolanaPublicConfig(load.config));
    for (const leak of [RPC_SECRET, "helius-rpc", "rpcUrls", "rpcEndpoints"]) expect(publicJson).not.toContain(leak);
    expect(JSON.stringify(load.config)).not.toContain(RPC_SECRET);
    const problems = JSON.stringify(problemsOf({ ...SOLANA_ENV, SIP_SOLANA_PUBLIC_WS_URL: `wss://ws.example.org/${RPC_SECRET}`, NUVEM_SOLANA_RPC_URL: RPC_URL }));
    expect(problems).not.toContain(RPC_SECRET);
  });
});

describe("refused by name, and never read", () => {
  it("refuses the keeper's signing secrets by name, without reading them, on the page and on the routes", () => {
    const values = placeholders(KEEPER_SECRETS);
    const env = readTrap({ ...SOLANA_ENV, ...values }, KEEPER_SECRETS);
    const problems = problemsOf(env);
    expect(problems.map((problem) => problem.variable).sort()).toEqual([...KEEPER_SECRETS].sort());
    const json = JSON.stringify(problems);
    for (const value of Object.values(values)) expect(json).not.toContain(value);
    expect(solanaGate(env).kind).toBe("invalid");
  });

  it("refuses PRIVY_APP_SECRET and PRIVY_AUTHORIZATION_PRIVATE_KEY the same way, and names the keeper's copy of each", () => {
    const values = placeholders(PRIVY_CREDENTIALS);
    const env = readTrap({ ...SOLANA_ENV, ...values }, PRIVY_CREDENTIALS);
    const problems = problemsOf(env);
    expect(problems.map((problem) => problem.variable)).toEqual([...PRIVY_CREDENTIALS]);
    const json = JSON.stringify(problems);
    for (const value of Object.values(values)) expect(json).not.toContain(value);
    expect(problems[0]!.howToFix).toContain("SIP_SOLANA_PRIVY_APP_SECRET");
    expect(problems[1]!.howToFix).toContain("SIP_SOLANA_PRIVY_AUTHORIZATION_KEY");
    expect(solanaGate(env).kind).toBe("invalid");
  });

  it("counts a blank value: the check is by name", () => {
    for (const name of [...KEEPER_SECRETS, ...PRIVY_CREDENTIALS]) {
      expect(variables({ ...SOLANA_ENV, [name]: "" })).toEqual([name]);
      expect(solanaGate({ ...SOLANA_ENV, [name]: "" }).kind).toBe("invalid");
    }
  });
});

describe("SIP_CHAIN", () => {
  it("is accepted silently when unset, blank or solana, trimmed and in any case", () => {
    const envs: Env[] = [SOLANA_ENV, ...["", "  ", "solana", " Solana ", "SOLANA"].map((value) => ({ ...SOLANA_ENV, SIP_CHAIN: value }))];
    for (const env of envs) {
      expect(loadConfig(env).ok).toBe(true);
      expect(solanaGate(env).kind).toBe("ok");
    }
  });

  it("refuses any other value by name, without repeating it, on the page and on the routes", () => {
    for (const value of ["evm", "EVM", "SIPCHAINVALUE42"]) {
      const env = { ...SOLANA_ENV, SIP_CHAIN: value };
      const problems = problemsOf(env);
      expect(problems.map((problem) => problem.variable)).toEqual(["SIP_CHAIN"]);
      expect(JSON.stringify(problems)).not.toContain(value);
      expect(solanaGate(env).kind).toBe("invalid");
    }
  });
});

/** load-config.ts's process-wide latch. Cleared before each case, so each starts as a fresh server process would. */
const RETIRED_NAMES_WARNED = Symbol.for("sip.web.config.retiredNamesWarned");

describe("the retired EVM names", () => {
  beforeEach(() => {
    delete (globalThis as unknown as Record<symbol, unknown>)[RETIRED_NAMES_WARNED];
  });

  it("produce no problem, and once per process one warning that lists the non-blank names and no value", async () => {
    vi.resetModules();
    const fresh = await import("@/lib/load-config");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const env: Env = {
      ...SOLANA_ENV,
      NUVEM_RPC_URL: "https://evm.invalid/v2/EVMKEYVALUE000",
      PRIVY_POLICY_ID: "EVMPOLICYVALUE0000000000",
      NUVEM_VAULT_FACTORY: "0x1111-retired-factory-not-read",
      NEXT_PUBLIC_RPC_URL_4663: "https://public.evm.invalid",
      NUVEM_PUBLIC_RPC_URL: "",
      SIP_CHAIN_ID: "   ",
    };
    expect(fresh.loadConfig(env).ok).toBe(true);
    expect(fresh.solanaGate(env).kind).toBe("ok");
    expect(fresh.loadConfig(env).ok).toBe(true);

    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]![0]);
    const logged = JSON.parse(line) as { names: string[]; message: string };
    expect(logged.names).toEqual(["NEXT_PUBLIC_RPC_URL_4663", "NUVEM_RPC_URL", "NUVEM_VAULT_FACTORY", "PRIVY_POLICY_ID"]);
    expect(logged.message).toContain("SIP_SOLANA_PRIVY_SIGNER_ID");
    expect(logged.message).toContain("SIP_SOLANA_PRIVY_POLICY_ID");
    for (const value of ["EVMKEYVALUE000", "evm.invalid", "EVMPOLICYVALUE", "0x1111"]) expect(line).not.toContain(value);
  });

  it("name the Solana seat only when an EVM seat name is among them", async () => {
    vi.resetModules();
    const fresh = await import("@/lib/load-config");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(fresh.loadConfig({ ...SOLANA_ENV, NUVEM_CHAIN_ID: "4663" }).ok).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(String(warn.mock.calls[0]![0])) as { names: string[]; message: string };
    expect(logged.names).toEqual(["NUVEM_CHAIN_ID"]);
    expect(logged.message).not.toContain("SIP_SOLANA_PRIVY");
  });

  it("warn once per process even when the pages and the route handlers each load their own copy of the module", async () => {
    // A production build compiles load-config.ts into two server runtimes, one
    // for the pages and one for the route handlers, in the same Node process.
    vi.resetModules();
    const pages = await import("@/lib/load-config");
    vi.resetModules();
    const routes = await import("@/lib/load-config");
    expect(routes).not.toBe(pages);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const env: Env = { ...SOLANA_ENV, NUVEM_RPC_URL: "https://evm.invalid/retired" };
    expect(pages.loadConfig(env).ok).toBe(true);
    expect(routes.solanaGate(env).kind).toBe("ok");
    expect(routes.loadConfig(env).ok).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("the Solana route gate", () => {
  it("is invalid when the settings are incomplete, ok otherwise, and never needs the Privy app id", () => {
    expect(solanaGate({}).kind).toBe("invalid");
    expect(solanaGate({ ...SOLANA_ENV, SIP_SOLANA_RPC_URLS: "" }).kind).toBe("invalid");
    const { PRIVY_APP_ID: _app, ...noApp } = SOLANA_ENV;
    expect(solanaGate(noApp).kind).toBe("ok");
  });
});
