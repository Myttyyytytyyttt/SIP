// Chain selection and the two configurations. Every key and URL here is a
// throwaway: .invalid hosts, and a placeholder Privy app id of the right length.

import { OLD_NUVEM_PROGRAM_ID, SIP_PROGRAM_ID } from "@sip/solana-core/client";
import { describe, expect, it } from "vitest";

import { chainFrom, evmRouteGate, loadEvmConfig, toAnyPublicConfig, toPublicConfig, type Env } from "@/lib/config";
import { loadConfig, loadSolanaConfig, solanaGate } from "@/lib/load-config";

const APP_ID = "clsipplaceholderappid0000";
const FACTORY = "0x1111111111111111111111111111111111111111";
const EVM_ENV: Env = { PRIVY_APP_ID: APP_ID, NUVEM_RPC_URL: "https://evm.invalid/v2/EVMKEY000", NUVEM_VAULT_FACTORY: FACTORY };

const RPC_SECRET = "HELIUSSECRET123";
const RPC_URL = `https://mainnet.helius-rpc.invalid/?api-key=${RPC_SECRET}`;
const SOLANA_ENV: Env = {
  SIP_CHAIN: "solana",
  PRIVY_APP_ID: APP_ID,
  SIP_SOLANA_RPC_URLS: RPC_URL,
  SIP_SOLANA_PROGRAM_ID: SIP_PROGRAM_ID,
  SIP_TRUSTED_CLIENT_IP_HEADER: "x-envoy-external-address",
};

function problemsOf(env: Env): { variable: string; message: string; howToFix: string }[] {
  const load = loadConfig(env);
  if (load.ok) throw new Error("expected problems");
  return [...load.problems];
}

describe("SIP_CHAIN", () => {
  it("unset or blank is evm; evm and solana are read trimmed and in any case", () => {
    expect(chainFrom({})).toEqual({ ok: true, chain: "evm" });
    expect(chainFrom({ SIP_CHAIN: "  " })).toEqual({ ok: true, chain: "evm" });
    expect(chainFrom({ SIP_CHAIN: "EVM" })).toEqual({ ok: true, chain: "evm" });
    expect(chainFrom({ SIP_CHAIN: " Solana " })).toEqual({ ok: true, chain: "solana" });
  });

  it("anything else is a problem naming SIP_CHAIN, and the page gets a checklist, not a guess", () => {
    const read = chainFrom({ SIP_CHAIN: "sol" });
    expect(read.ok).toBe(false);
    expect(problemsOf({ ...EVM_ENV, SIP_CHAIN: "sol" }).map((p) => p.variable)).toEqual(["SIP_CHAIN"]);
    expect(evmRouteGate({ SIP_CHAIN: "sol" }).kind).toBe("invalid");
  });

  it("the EVM routes' gate: evm by default, solana when set", () => {
    expect(evmRouteGate({}).kind).toBe("evm");
    expect(evmRouteGate({ SIP_CHAIN: "solana" }).kind).toBe("solana");
  });
});

describe("EVM (SIP_CHAIN unset): today's configuration plus chain", () => {
  it("is exactly the EVM loader's object, with chain evm", () => {
    const load = loadConfig(EVM_ENV);
    expect(load.ok).toBe(true);
    if (!load.ok) return;
    expect(load.config).toEqual({
      chain: "evm",
      privyAppId: APP_ID,
      privyClientId: null,
      privySignerId: null,
      privyPolicyId: null,
      walletRpcUrl: "/api/rpc",
      explorerUrl: null,
      factory: FACTORY,
      cohortId: 1n,
      chainId: 4663,
      rpcUrl: "https://evm.invalid/v2/EVMKEY000",
      logsFromBlock: 0n,
      rpcProxyDisabled: false,
      rpcRelayInUse: true,
      databaseUrl: null,
      expected: { executor: null, weth: null, pauseController: null, attesterRegistry: null },
    });
    expect(loadEvmConfig(EVM_ENV)).toEqual(load);
    if (load.config.chain !== "evm") return;
    expect(toPublicConfig(load.config)).toEqual({
      chain: "evm",
      privyAppId: APP_ID,
      privyClientId: null,
      privySignerId: null,
      privyPolicyId: null,
      walletRpcUrl: "/api/rpc",
      explorerUrl: null,
      factory: FACTORY,
      cohortId: 1n,
      chainId: 4663,
    });
  });

  it("ignores every Solana variable, even Nuvem's refused ones", () => {
    const withSolana = loadConfig({ ...EVM_ENV, NUVEM_SOLANA_RPC_URL: "https://old.invalid", SIP_SOLANA_PROGRAM_ID: OLD_NUVEM_PROGRAM_ID });
    expect(withSolana).toEqual(loadConfig(EVM_ENV));
    expect(loadConfig({ ...EVM_ENV, SIP_CHAIN: "evm" })).toEqual(loadConfig(EVM_ENV));
  });

  it("still reports the EVM problems it always did", () => {
    expect(problemsOf({ PRIVY_APP_ID: APP_ID }).map((p) => p.variable).sort()).toEqual(["NUVEM_RPC_URL", "NUVEM_VAULT_FACTORY"]);
  });
});

describe("Solana (SIP_CHAIN=solana)", () => {
  it("loads with no EVM variable at all, and the browser's share is the relay, the public WebSocket and the program", () => {
    const load = loadConfig(SOLANA_ENV);
    expect(load.ok).toBe(true);
    if (!load.ok || load.config.chain !== "solana") throw new Error("expected a Solana config");
    expect(toAnyPublicConfig(load.config)).toEqual({
      chain: "solana",
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
    expect(load.config.databaseUrl).toBeNull();
  });

  it("makes the relay URL absolute when the origin is known", () => {
    const load = loadSolanaConfig(SOLANA_ENV, { origin: "https://sip.example/" });
    expect(load.ok && load.config.solanaRpcUrl).toBe("https://sip.example/api/solana-rpc");
  });

  it("IGNORES the EVM variables rather than refusing them, so compose's NUVEM_CHAIN_ID default and a flip back to evm both work", () => {
    const load = loadConfig({ ...SOLANA_ENV, NUVEM_CHAIN_ID: "4663", SIP_CHAIN_ID: "1", NUVEM_RPC_URL: "not a url", NUVEM_VAULT_FACTORY: "nope" });
    expect(load.ok).toBe(true);
  });

  it("refuses Nuvem's old program by name", () => {
    const problems = problemsOf({ ...SOLANA_ENV, SIP_SOLANA_PROGRAM_ID: OLD_NUVEM_PROGRAM_ID });
    expect(problems.map((p) => p.variable)).toEqual(["SIP_SOLANA_PROGRAM_ID"]);
    expect(problems[0]!.message).toContain("Nuvem's old program");
  });

  it("refuses a program id that is not the IDL's", () => {
    expect(problemsOf({ ...SOLANA_ENV, SIP_SOLANA_PROGRAM_ID: "11111111111111111111111111111111" }).map((p) => p.variable)).toEqual(["SIP_SOLANA_PROGRAM_ID"]);
  });

  it("refuses a copied Nuvem Solana variable and names its replacement", () => {
    const problems = problemsOf({ ...SOLANA_ENV, NUVEM_SOLANA_RPC_URL: "https://old.invalid/?api-key=OLD" });
    expect(problems.map((p) => p.variable)).toEqual(["NUVEM_SOLANA_RPC_URL"]);
    expect(problems[0]!.howToFix).toContain("SIP_SOLANA_RPC_URLS");
  });

  it("refuses a WebSocket on the RPC host, or one carrying a query", () => {
    expect(problemsOf({ ...SOLANA_ENV, SIP_SOLANA_PUBLIC_WS_URL: "wss://mainnet.helius-rpc.invalid" }).map((p) => p.variable)).toEqual(["SIP_SOLANA_PUBLIC_WS_URL"]);
    expect(problemsOf({ ...SOLANA_ENV, SIP_SOLANA_PUBLIC_WS_URL: "wss://ws.example.org/?api-key=x" }).map((p) => p.variable)).toEqual(["SIP_SOLANA_PUBLIC_WS_URL"]);
  });

  it("requires the RPC URLs and the one trusted client-IP header", () => {
    const { SIP_SOLANA_RPC_URLS: _rpc, SIP_TRUSTED_CLIENT_IP_HEADER: _header, ...bare } = SOLANA_ENV;
    expect(problemsOf(bare).map((p) => p.variable).sort()).toEqual(["SIP_SOLANA_RPC_URLS", "SIP_TRUSTED_CLIENT_IP_HEADER"]);
  });

  it("the Solana seat is both or neither, never the same id twice", () => {
    expect(problemsOf({ ...SOLANA_ENV, SIP_SOLANA_PRIVY_SIGNER_ID: "signer-id-0000000000000000" }).map((p) => p.variable)).toEqual(["SIP_SOLANA_PRIVY_SIGNER_ID"]);
    expect(
      problemsOf({ ...SOLANA_ENV, SIP_SOLANA_PRIVY_SIGNER_ID: "same-id-00000000000000000", SIP_SOLANA_PRIVY_POLICY_ID: "same-id-00000000000000000" }).map((p) => p.variable),
    ).toEqual(["SIP_SOLANA_PRIVY_POLICY_ID"]);
    const both = loadConfig({ ...SOLANA_ENV, SIP_SOLANA_PRIVY_SIGNER_ID: "signer-id-0000000000000000", SIP_SOLANA_PRIVY_POLICY_ID: "policy-id-0000000000000000" });
    expect(both.ok && toAnyPublicConfig(both.config)).toMatchObject({ privySignerId: "signer-id-0000000000000000", privyPolicyId: "policy-id-0000000000000000" });
    // The EVM pair is not read under solana.
    expect(loadConfig({ ...SOLANA_ENV, PRIVY_SIGNER_ID: "evm-signer-00000000000000" }).ok).toBe(true);
  });

  it("applies Privy's app-id length rule on the page, and not for callers that do not need it", () => {
    expect(problemsOf({ ...SOLANA_ENV, PRIVY_APP_ID: "short" }).map((p) => p.variable)).toEqual(["PRIVY_APP_ID"]);
    const { PRIVY_APP_ID: _app, ...noApp } = SOLANA_ENV;
    const load = loadConfig(noApp, { needPrivyAppId: false });
    expect(load.ok && load.config.privyAppId).toBe("");
  });

  it("never lets an endpoint key into the browser's share, the server object's JSON, or a problem", () => {
    const load = loadConfig(SOLANA_ENV);
    if (!load.ok) throw new Error("expected a Solana config");
    const publicJson = JSON.stringify(toAnyPublicConfig(load.config));
    for (const leak of [RPC_SECRET, "helius-rpc", "rpcUrls", "rpcEndpoints"]) expect(publicJson).not.toContain(leak);
    expect(JSON.stringify(load.config)).not.toContain(RPC_SECRET);
    const problems = JSON.stringify(problemsOf({ ...SOLANA_ENV, SIP_SOLANA_PUBLIC_WS_URL: `wss://ws.example.org/${RPC_SECRET}`, NUVEM_SOLANA_RPC_URL: RPC_URL }));
    expect(problems).not.toContain(RPC_SECRET);
  });
});

describe("the Solana route gate", () => {
  it("is disabled unless SIP_CHAIN=solana, invalid when the settings are incomplete, and ok otherwise", () => {
    expect(solanaGate({}).kind).toBe("disabled");
    expect(solanaGate({ ...SOLANA_ENV, SIP_CHAIN: "sol" }).kind).toBe("disabled");
    expect(solanaGate({ ...SOLANA_ENV, SIP_SOLANA_RPC_URLS: "" }).kind).toBe("invalid");
    // The relay does not need the Privy app id.
    const { PRIVY_APP_ID: _app, ...noApp } = SOLANA_ENV;
    expect(solanaGate(noApp).kind).toBe("ok");
  });
});
