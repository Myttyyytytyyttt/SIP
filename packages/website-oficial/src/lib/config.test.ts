// The Solana-only configuration: what the page and the routes load, and what the
// environment must not hold. Every key and URL here is a throwaway: .invalid
// hosts, placeholder values, and a placeholder Privy app id of the right length.

import { OLD_NUVEM_PROGRAM_ID, SIP_PROGRAM_ID } from "@sip/solana-core/client";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

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

/**
 * Every configuration problem writes a line to console.error. Silenced for the whole file and recorded here, so the
 * cases about that line read it without spying on console.error a second time.
 */
let errorLog: MockInstance<typeof console.error>;

beforeEach(() => {
  errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

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

/** load-config.ts's other process-wide latch: the names of the last problems line. Cleared the same way. */
const PROBLEMS_LOGGED = Symbol.for("sip.web.config.problemsLogged");

interface ProblemsLine {
  readonly event: string;
  readonly names: readonly string[];
  readonly message: string;
}

/** Every console.error line so far, parsed. In these cases the problems line is the only thing written there. */
const problemLines = (): ProblemsLine[] => errorLog.mock.calls.map((call) => JSON.parse(String(call[0])) as ProblemsLine);

describe("the configuration problems, in the server's log", () => {
  beforeEach(() => {
    delete (globalThis as unknown as Record<symbol, unknown>)[PROBLEMS_LOGGED];
  });

  it("names SIP_CHAIN, PRIVY_APP_SECRET and SIP_SOLANA_SETTLE_KEY in one line, with no value and no problem text, and reads neither secret", async () => {
    vi.resetModules();
    const fresh = await import("@/lib/load-config");
    const otherLogs = (["log", "info", "warn", "debug"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
    const canaries = {
      SIP_CHAIN: "evm-canary-9c1d",
      PRIVY_APP_SECRET: "canary-value-never-logged-7f3a",
      SIP_SOLANA_SETTLE_KEY: "canary-settle-key-never-logged-4e2b",
    };
    // SIP_CHAIN's value is compared with solana, so it is read, and must never be repeated. The two secrets are
    // checked by name: reading either value throws.
    const env = readTrap({ ...SOLANA_ENV, ...canaries }, ["PRIVY_APP_SECRET", "SIP_SOLANA_SETTLE_KEY"]);
    let problems: readonly ConfigProblem[] = [];
    for (let request = 0; request < 3; request += 1) {
      const load = fresh.loadConfig(env);
      if (load.ok) throw new Error("expected problems");
      problems = load.problems;
      expect(fresh.solanaGate(env).kind).toBe("invalid");
    }

    expect(problemLines()).toEqual([
      { event: "web.config.problems", names: ["PRIVY_APP_SECRET", "SIP_CHAIN", "SIP_SOLANA_SETTLE_KEY"], message: expect.stringContaining("/wallets") },
    ]);
    const written = [errorLog, ...otherLogs].flatMap((spy) => spy.mock.calls.flat().map(String)).join("\n");
    for (const canary of Object.values(canaries)) expect(written).not.toContain(canary);
    expect(problems.map((problem) => problem.variable).sort()).toEqual(["PRIVY_APP_SECRET", "SIP_CHAIN", "SIP_SOLANA_SETTLE_KEY"]);
    for (const problem of problems) {
      expect(written).not.toContain(problem.message);
      expect(written).not.toContain(problem.howToFix);
    }
  });

  it("writes one line when the pages and the route handlers each load their own copy and are asked again and again", async () => {
    // Two module registries in one process, as in a production build. The routes are asked first, and the environment
    // also holds a problem only the page checks (the Privy app id): the line is still the page's whole list, once.
    vi.resetModules();
    const pages = await import("@/lib/load-config");
    vi.resetModules();
    const routes = await import("@/lib/load-config");
    expect(routes).not.toBe(pages);
    const env: Env = { ...SOLANA_ENV, SIP_CHAIN: "evm", SIP_SOLANA_RPC_URLS: "", PRIVY_APP_ID: "short" };
    // The gate on its own, before any page: a deployment whose first traffic is the relay still gets the line.
    expect(routes.solanaGate(env).kind).toBe("invalid");
    expect(problemLines()).toEqual([
      { event: "web.config.problems", names: ["PRIVY_APP_ID", "SIP_CHAIN", "SIP_SOLANA_RPC_URLS"], message: expect.stringContaining("/wallets") },
    ]);
    for (let request = 0; request < 3; request += 1) {
      expect(routes.solanaGate(env).kind).toBe("invalid");
      expect(pages.loadConfig(env).ok).toBe(false);
      expect(pages.solanaGate(env).kind).toBe("invalid");
      expect(routes.loadConfig(env).ok).toBe(false);
    }
    expect(problemLines()).toEqual([
      { event: "web.config.problems", names: ["PRIVY_APP_ID", "SIP_CHAIN", "SIP_SOLANA_RPC_URLS"], message: expect.stringContaining("/wallets") },
    ]);
  });

  it("writes nothing for a complete configuration, on the page or on the routes", async () => {
    vi.resetModules();
    const fresh = await import("@/lib/load-config");
    const seated: Env = {
      ...SOLANA_ENV,
      SIP_CHAIN: "solana",
      SIP_SOLANA_PRIVY_SIGNER_ID: "signer-id-0000000000000000",
      SIP_SOLANA_PRIVY_POLICY_ID: "policy-id-0000000000000000",
    };
    for (const env of [SOLANA_ENV, seated, SOLANA_ENV]) {
      expect(fresh.loadConfig(env).ok).toBe(true);
      expect(fresh.solanaGate(env).kind).toBe("ok");
    }
    expect(errorLog).not.toHaveBeenCalled();
  });

  it("leaves a problem only the page has to the page: the routes stay ok and write nothing", async () => {
    vi.resetModules();
    const fresh = await import("@/lib/load-config");
    const { PRIVY_APP_ID: _app, ...noApp } = SOLANA_ENV;
    expect(fresh.solanaGate(noApp).kind).toBe("ok");
    expect(errorLog).not.toHaveBeenCalled();
    expect(fresh.loadConfig(noApp).ok).toBe(false);
    expect(problemLines().map((line) => line.names)).toEqual([["PRIVY_APP_ID"]]);
  });

  it("names a missing SIP_SOLANA_RPC_URLS, and a malformed one is the same name, so it is not written twice", async () => {
    vi.resetModules();
    const fresh = await import("@/lib/load-config");
    const { SIP_SOLANA_RPC_URLS: _rpc, ...missing } = SOLANA_ENV;
    expect(fresh.solanaGate(missing).kind).toBe("invalid");
    expect(fresh.loadConfig(missing).ok).toBe(false);
    expect(problemLines()).toEqual([
      { event: "web.config.problems", names: ["SIP_SOLANA_RPC_URLS"], message: expect.stringContaining("/wallets") },
    ]);

    // Two bad entries are two problems under one name. The line lists names once each, and it has already said this one.
    const malformed: Env = { ...SOLANA_ENV, SIP_SOLANA_RPC_URLS: "MALFORMEDENTRY1,ftp://MALFORMEDENTRY2.invalid" };
    const load = fresh.loadConfig(malformed);
    expect(!load.ok && load.problems.map((problem) => problem.variable)).toEqual(["SIP_SOLANA_RPC_URLS", "SIP_SOLANA_RPC_URLS"]);
    expect(fresh.solanaGate(malformed).kind).toBe("invalid");
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(errorLog.mock.calls.flat().map(String).join("\n")).not.toContain("MALFORMEDENTRY");
  });

  it("writes again for a different set of names, as after an edited .env under next dev", async () => {
    vi.resetModules();
    const fresh = await import("@/lib/load-config");
    const before: Env = { ...SOLANA_ENV, SIP_CHAIN: "evm" };
    const after: Env = { ...SOLANA_ENV, SIP_CHAIN: "evm", PRIVY_AUTHORIZATION_PRIVATE_KEY: "" };
    for (const env of [before, before, after, after]) {
      expect(fresh.loadConfig(env).ok).toBe(false);
      expect(fresh.solanaGate(env).kind).toBe("invalid");
    }
    expect(fresh.loadConfig(SOLANA_ENV).ok).toBe(true);
    expect(problemLines().map((line) => line.names)).toEqual([["SIP_CHAIN"], ["PRIVY_AUTHORIZATION_PRIVATE_KEY", "SIP_CHAIN"]]);
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
