// Configuration, and the broadcast gate.
//
// The worker's doctrine, tested the worker's way: the mode needs the exact
// sentence byte for byte, a dry run never READS a signing secret — proved with
// an env Proxy that records every key read — and no refusal ever echoes a value.
// On top of it, the two refusals this keeper exists to make: Nuvem's copied
// configuration and Nuvem's program id.

import { inspect } from "node:util";
import { Keypair } from "@solana/web3.js";
import { Redactor } from "@sip/solana-log";
import { describe, expect, it } from "vitest";
import {
  BROADCAST_ACK,
  ConfigError,
  DEFAULT_SWEEP_MS,
  SIGNING_SECRET_VARS,
  loadConfig,
  parsePools,
  shape,
  type KeeperConfig,
} from "../src/config.js";
import { OLD_NUVEM_PROGRAM_ID, SIP_PROGRAM_ID } from "../src/idl.js";

/** Throwaway: generated per run, never funded, never used to sign anything real. */
const settleKeypair = Keypair.generate();
const SETTLE_KEY = JSON.stringify(Array.from(settleKeypair.secretKey));
const RPC = "https://mainnet.helius-rpc.example.test/?api-key=HeliusKeyNeverLogged0001";
const DB = "postgres://sip:DbPassw0rdSecret@db.example.test:5432/sip";
const WEBHOOK = "https://hooks.slack.example.test/services/T000/B000/WebhookTokenNeverLogged";
const APP_SECRET = "privy-app-secret-value-never-logged";
const AUTH_KEY = "wallet-auth:MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgSecretAuthorizationKeyBody";
const MINT = "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh";
const POOL = "49iMatQtoyabsYAQc8GafVq6aeBFVDxSRH44oiatyyw6";

const dry = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  SIP_SOLANA_RPC_URLS: RPC,
  SIP_SOLANA_PROGRAM_ID: SIP_PROGRAM_ID,
  ...over,
});

const armed = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv =>
  dry({
    SIP_SOLANA_BROADCAST: "1",
    SIP_SOLANA_ALLOW_BROADCAST: BROADCAST_ACK,
    SIP_SOLANA_SETTLE_KEY: SETTLE_KEY,
    SIP_SOLANA_PRIVY_APP_ID: "app-id",
    SIP_SOLANA_PRIVY_APP_SECRET: APP_SECRET,
    SIP_SOLANA_PRIVY_AUTHORIZATION_KEY: AUTH_KEY,
    ...over,
  });

/** Every key read through `get`, recorded. Object.keys goes through ownKeys, which is not a read of a value. */
function recording(values: NodeJS.ProcessEnv): { env: NodeJS.ProcessEnv; reads: Set<string> } {
  const reads = new Set<string>();
  const env = new Proxy({ ...values }, {
    get(target, key, receiver) {
      if (typeof key === "string") reads.add(key);
      return Reflect.get(target, key, receiver);
    },
  });
  return { env, reads };
}

function refusal(env: NodeJS.ProcessEnv): ConfigError {
  try {
    loadConfig(env, new Redactor());
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error("expected a ConfigError");
}

const SECRET_FRAGMENTS = [
  SETTLE_KEY,
  Array.from(settleKeypair.secretKey).slice(0, 12).join(","),
  "HeliusKeyNeverLogged0001",
  "DbPassw0rdSecret",
  "WebhookTokenNeverLogged",
  APP_SECRET,
  AUTH_KEY.slice(12),
];
const expectNoSecret = (text: string): void => {
  for (const fragment of SECRET_FRAGMENTS) expect(text).not.toContain(fragment);
};

describe("the facts this keeper pins", () => {
  it("declares the arming sentence, byte for byte", () => {
    expect(BROADCAST_ACK).toBe("i-understand-this-moves-real-funds");
  });
});

describe("a dry run", () => {
  it("loads with only an endpoint and the program id, holding nothing that can sign", () => {
    const config = loadConfig(dry(), new Redactor());
    expect(config.armed).toBe(false);
    expect(config.signing).toBeNull();
    expect(config.programId).toBe(SIP_PROGRAM_ID);
    expect(config.sweepMs).toBe(DEFAULT_SWEEP_MS);
    expect(config.pools.size).toBe(0);
    expect(config.port).toBeNull();
    expect(config.warnings).toEqual([]);
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("READS NOT ONE SIGNING SECRET, even with every one of them present", () => {
    const { env, reads } = recording(
      armed({
        SIP_SOLANA_BROADCAST: undefined,
        SIP_SOLANA_ALLOW_BROADCAST: undefined,
        SIP_SOLANA_LOCAL_SIGNERS_DIR: "/tmp/sip-local-signers-never-read",
        SIP_SOLANA_PRIVY_SIGNER_ID: "signer-id",
        SIP_SOLANA_POOLS: `${MINT}=${POOL}`,
        SIP_SOLANA_ALERT_WEBHOOK: WEBHOOK,
        DATABASE_URL: DB,
        PORT: "18080",
      }),
    );
    const config = loadConfig(env, new Redactor());
    for (const name of SIGNING_SECRET_VARS) expect(reads.has(name), `${name} was read in dry run`).toBe(false);
    expect(config.signing).toBeNull();
    // Told, by name, that they were there and ignored.
    const warning = config.warnings.join(" ");
    for (const name of SIGNING_SECRET_VARS) expect(warning).toContain(name);
    expect(warning).toContain("not read");
    // Public and operational values are readable in dry run.
    expect(reads.has("SIP_SOLANA_PRIVY_APP_ID")).toBe(true);
    expect(reads.has("DATABASE_URL")).toBe(true);
    expect(config.databaseUrl?.reveal()).toBe(DB);
    expect(config.alertWebhook?.reveal()).toBe(WEBHOOK);
  });

  it("the trap is real: the same recording env shows the reads once armed", () => {
    const { env, reads } = recording(armed({ SIP_SOLANA_LOCAL_SIGNERS_DIR: undefined }));
    loadConfig(env, new Redactor());
    expect(reads.has("SIP_SOLANA_SETTLE_KEY")).toBe(true);
    expect(reads.has("SIP_SOLANA_PRIVY_APP_SECRET")).toBe(true);
  });

  it("appends nothing to the endpoints and registers each one", () => {
    const redactor = new Redactor();
    const config = loadConfig(dry({ SIP_SOLANA_RPC_URLS: ` ${RPC} , https://b.example.test/v2/SecondEndpointKey99 ,, ` }), redactor);
    expect(config.rpcUrls.map((url) => url.reveal())).toEqual([RPC, "https://b.example.test/v2/SecondEndpointKey99"]);
    expect(redactor.scrub(`429 from ${RPC}`)).toBe("429 from <redacted:rpcUrl:0>");
    // The key alone, as a derived websocket URL or a library error might quote it.
    expect(redactor.scrub("wss://b.example.test/v2/SecondEndpointKey99")).not.toContain("SecondEndpointKey99");
  });
});

describe("arming", () => {
  it("goes armed with the flag, the exact sentence and a throwaway settle key", () => {
    const config = loadConfig(armed({ SIP_SOLANA_PRIVY_SIGNER_ID: "signer-id" }), new Redactor());
    expect(config.armed).toBe(true);
    expect(config.signing).not.toBeNull();
    expect(config.signing!.settleKey.publicKey.equals(settleKeypair.publicKey)).toBe(true);
    expect(config.signing!.privy?.appId).toBe("app-id");
    expect(config.signing!.privy?.appSecret.reveal()).toBe(APP_SECRET);
    expect(config.signing!.localSignersDir).toBeNull();
    expect(config.privySignerId).toBe("signer-id");
    expect(config.warnings).toEqual([]);
  });

  it("serializes to its safe description, with the settle key's public key and nothing secret", () => {
    const config: KeeperConfig = loadConfig(armed({ DATABASE_URL: DB, SIP_SOLANA_ALERT_WEBHOOK: WEBHOOK }), new Redactor());
    for (const text of [JSON.stringify(config), inspect(config), JSON.stringify(config.signing), inspect(config.signing)]) {
      expectNoSecret(text);
    }
    expect(JSON.stringify(config)).toContain(settleKeypair.publicKey.toBase58());
  });

  it("refuses the flag with no sentence, naming what is missing", () => {
    const problem = refusal(dry({ SIP_SOLANA_BROADCAST: "1" })).message;
    expect(problem).toContain("SIP_SOLANA_ALLOW_BROADCAST");
    expect(problem).toContain("not set at all");
  });

  it("keeps the old near-miss diagnostics without echoing the value", () => {
    const cases: [string, string][] = [
      [`${BROADCAST_ACK} `, "surrounding whitespace"],
      [`\n${BROADCAST_ACK}`, "surrounding whitespace"],
      [BROADCAST_ACK.toUpperCase(), "capitalisation"],
      ["", "set but empty"],
      ["yes-please-arm-this-keeper", "characters that are not the sentence"],
    ];
    for (const [value, expected] of cases) {
      const error = refusal(dry({ SIP_SOLANA_BROADCAST: "1", SIP_SOLANA_ALLOW_BROADCAST: value }));
      expect(error.message, JSON.stringify(value)).toContain(expected);
      if (value.trim() !== BROADCAST_ACK && value.trim().toLowerCase() !== BROADCAST_ACK && value !== "") {
        expect(error.message).not.toContain(value);
      }
    }
  });

  it("reports the sentence without the flag as still a dry run", () => {
    const { env, reads } = recording(armed({ SIP_SOLANA_BROADCAST: undefined }));
    const config = loadConfig(env, new Redactor());
    expect(config.armed).toBe(false);
    expect(config.warnings.join(" ")).toContain("still a dry run");
    for (const name of SIGNING_SECRET_VARS) expect(reads.has(name)).toBe(false);
  });

  it("stays dry on a flag that is not the literal 1, and says so", () => {
    for (const value of ["true", "yes", " 1", "01"]) {
      const config = loadConfig(dry({ SIP_SOLANA_BROADCAST: value }), new Redactor());
      expect(config.armed, value).toBe(false);
      expect(config.warnings.join(" ")).toContain("not exactly 1");
    }
  });

  it("refuses to arm without SIP_SOLANA_SETTLE_KEY", () => {
    const error = refusal(armed({ SIP_SOLANA_SETTLE_KEY: undefined }));
    expect(error.message).toContain("SIP_SOLANA_SETTLE_KEY");
  });

  it("refuses a malformed settle key by name, never by content", () => {
    const wrongPublicHalf = Array.from(settleKeypair.secretKey);
    wrongPublicHalf[40] = (wrongPublicHalf[40]! + 1) % 256;
    for (const bad of [
      "not json at all SecretishText",
      "[1,2,3",
      JSON.stringify(Array.from(settleKeypair.secretKey).slice(0, 63)),
      JSON.stringify(Array.from(settleKeypair.secretKey).map((byte) => byte + 300)),
      JSON.stringify(wrongPublicHalf),
    ]) {
      const error = refusal(armed({ SIP_SOLANA_SETTLE_KEY: bad }));
      expect(error.message).toContain("SIP_SOLANA_SETTLE_KEY");
      expect(error.message).toContain("withheld");
      expect(error.message).not.toContain(bad);
      expect(error.message).not.toContain(Array.from(settleKeypair.secretKey).slice(0, 8).join(","));
    }
  });

  it("refuses a half-configured Privy route, naming the missing variable", () => {
    const error = refusal(armed({ SIP_SOLANA_PRIVY_APP_SECRET: undefined }));
    expect(error.message).toContain("SIP_SOLANA_PRIVY_APP_SECRET");
    expect(error.message).toContain("half-configured");
    expectNoSecret(error.message);
  });

  it("warns, and still arms, with no wallet signing route at all", () => {
    const config = loadConfig(
      armed({
        SIP_SOLANA_PRIVY_APP_ID: undefined,
        SIP_SOLANA_PRIVY_APP_SECRET: undefined,
        SIP_SOLANA_PRIVY_AUTHORIZATION_KEY: undefined,
      }),
      new Redactor(),
    );
    expect(config.armed).toBe(true);
    expect(config.warnings.join(" ")).toContain("NO_SIGNER");
  });

  it("accepts a local signers directory only when every endpoint is loopback", () => {
    const error = refusal(armed({ SIP_SOLANA_LOCAL_SIGNERS_DIR: "/tmp/sip-local-signers" }));
    expect(error.message).toContain("localnet only");
    const config = loadConfig(
      armed({ SIP_SOLANA_RPC_URLS: "http://127.0.0.1:8899", SIP_SOLANA_LOCAL_SIGNERS_DIR: "/tmp/sip-local-signers" }),
      new Redactor(),
    );
    expect(config.signing?.localSignersDir?.reveal()).toBe("/tmp/sip-local-signers");
  });
});

describe("copied Nuvem configuration", () => {
  it("refuses NUVEM_* by name and names the SIP_SOLANA_ replacement, reading no value", () => {
    const { env, reads } = recording(dry({ NUVEM_SOLANA_BROADCAST: "1", NUVEM_SOLANA_CRANK_KEY: SETTLE_KEY }));
    const error = (() => {
      try {
        loadConfig(env, new Redactor());
      } catch (caught) {
        return caught as ConfigError;
      }
      throw new Error("expected a refusal");
    })();
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain("NUVEM_SOLANA_BROADCAST");
    expect(error.message).toContain("reads SIP_SOLANA_BROADCAST instead");
    expect(error.message).toContain("NUVEM_SOLANA_CRANK_KEY");
    expect(error.message).toContain("SIP_SOLANA_SETTLE_KEY");
    expect(reads.has("NUVEM_SOLANA_BROADCAST")).toBe(false);
    expect(reads.has("NUVEM_SOLANA_CRANK_KEY")).toBe(false);
    expectNoSecret(error.message);
  });

  it("refuses an unknown NUVEM_* name too, saying it has no counterpart", () => {
    expect(refusal(dry({ NUVEM_SOMETHING_ELSE: "x" })).message).toContain("no counterpart");
  });

  it("refuses the bare PRIVY_* and ANCHOR_* names Nuvem's keeper read", () => {
    const pairs: [string, string][] = [
      ["PRIVY_APP_ID", "SIP_SOLANA_PRIVY_APP_ID"],
      ["PRIVY_APP_SECRET", "SIP_SOLANA_PRIVY_APP_SECRET"],
      ["PRIVY_AUTHORIZATION_KEY", "SIP_SOLANA_PRIVY_AUTHORIZATION_KEY"],
      ["PRIVY_AUTHORIZATION_PRIVATE_KEY", "SIP_SOLANA_PRIVY_AUTHORIZATION_KEY"],
      ["ANCHOR_WALLET", "SIP_SOLANA_SETTLE_KEY"],
      ["ANCHOR_PROVIDER_URL", "SIP_SOLANA_RPC_URLS"],
    ];
    for (const [name, replacement] of pairs) {
      const { env, reads } = recording(dry({ [name]: APP_SECRET }));
      let message = "";
      try {
        loadConfig(env, new Redactor());
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, name).toContain(name);
      expect(message, name).toContain(replacement);
      expect(reads.has(name)).toBe(false);
      expect(message).not.toContain(APP_SECRET);
    }
  });

  it("does not read signing secrets while refusing a copied environment, even armed", () => {
    const { env, reads } = recording(armed({ NUVEM_SOLANA_POOLS: "x" }));
    expect(() => loadConfig(env, new Redactor())).toThrow(ConfigError);
    for (const name of SIGNING_SECRET_VARS) expect(reads.has(name)).toBe(false);
  });
});

describe("the Privy SDK's environment overrides", () => {
  it("refuses PRIVY_API_BASE_URL, PRIVY_API_LOG and PRIVY_API_CUSTOM_HEADERS by name, reading no value, even armed", () => {
    for (const name of ["PRIVY_API_BASE_URL", "PRIVY_API_LOG", "PRIVY_API_CUSTOM_HEADERS"]) {
      const { env, reads } = recording(armed({ [name]: "https://collector.example.test/OverrideNeverRead0009" }));
      const error = refusal(env);
      expect(error.message, name).toContain(`${name} is the Privy SDK's own setting`);
      expect(error.message, name).not.toContain("OverrideNeverRead0009");
      expect(reads.has(name), name).toBe(false);
      expectNoSecret(error.message);
    }
  });
});

describe("the program id", () => {
  it("refuses Nuvem's old program with its own message, before any other comparison", () => {
    const error = refusal(dry({ SIP_SOLANA_PROGRAM_ID: OLD_NUVEM_PROGRAM_ID }));
    expect(error.problems).toHaveLength(1);
    expect(error.message).toContain("Nuvem's old program");
    expect(error.message).toContain("leaked");
    expect(error.message).not.toContain("does not match");
    expect(error.message).not.toContain(OLD_NUVEM_PROGRAM_ID);
  });

  it("refuses any other id than the exported IDL's, and a missing one", () => {
    expect(refusal(dry({ SIP_SOLANA_PROGRAM_ID: "11111111111111111111111111111111" })).message).toContain("does not match");
    expect(refusal(dry({ SIP_SOLANA_PROGRAM_ID: undefined })).message).toContain("SIP_SOLANA_PROGRAM_ID is required");
  });
});

describe("endpoints, cadence, pools and credentials", () => {
  it("requires at least one endpoint and refuses a non-http(s) one by position without echoing it", () => {
    expect(refusal(dry({ SIP_SOLANA_RPC_URLS: undefined })).message).toContain("SIP_SOLANA_RPC_URLS is required");
    expect(refusal(dry({ SIP_SOLANA_RPC_URLS: " , " })).message).toContain("SIP_SOLANA_RPC_URLS is required");
    const error = refusal(dry({ SIP_SOLANA_RPC_URLS: `${RPC},wss://x.example.test/SecretWsKey12345` }));
    expect(error.message).toContain("SIP_SOLANA_RPC_URLS entry #2");
    expect(error.message).not.toContain("SecretWsKey12345");
    expectNoSecret(error.message);
  });

  it("defaults the sweep to 60 s and refuses anything under 5 s or not an integer", () => {
    expect(loadConfig(dry({ SIP_SOLANA_SWEEP_MS: "5000" }), new Redactor()).sweepMs).toBe(5_000);
    for (const bad of ["4999", "0", "-60000", "1.5", "sixty"]) {
      expect(refusal(dry({ SIP_SOLANA_SWEEP_MS: bad })).message, bad).toContain("SIP_SOLANA_SWEEP_MS");
    }
  });

  it("parses MINT=POOL pairs and refuses malformed, non-base58 and duplicated entries by position", () => {
    const config = loadConfig(dry({ SIP_SOLANA_POOLS: ` ${MINT}=${POOL} ` }), new Redactor());
    expect(config.pools.get(MINT)?.toBase58()).toBe(POOL);

    const problems: string[] = [];
    parsePools(`${MINT}=${POOL},garbage-entry-here,${POOL}=0OIl-not-base58,${MINT}=${POOL},a=b=c`, problems);
    expect(problems.join("\n")).toContain("entry #2 is not MINT=POOL");
    expect(problems.join("\n")).toContain("entry #3 has an address that is not a base58");
    expect(problems.join("\n")).toContain("entries #1 and #4 name the same mint");
    expect(problems.join("\n")).toContain("entry #5 is not MINT=POOL");
    expect(problems.join("\n")).not.toContain("garbage-entry-here");
    expect(problems.join("\n")).not.toContain(MINT);

    expect(refusal(dry({ SIP_SOLANA_POOLS: "garbage" })).message).toContain("SIP_SOLANA_POOLS");
  });

  it("registers DATABASE_URL and refuses the transaction pooler and non-postgres URLs", () => {
    const redactor = new Redactor();
    loadConfig(dry({ DATABASE_URL: DB }), redactor);
    expect(redactor.scrub(`connect ${DB} failed`)).toBe("connect <redacted:databaseUrl> failed");
    expect(refusal(dry({ DATABASE_URL: DB.replace(":5432", ":6543") })).message).toContain("6543");
    const error = refusal(dry({ DATABASE_URL: "mysql://sip:DbPassw0rdSecret@db.example.test/sip" }));
    expect(error.message).toContain("DATABASE_URL");
    expectNoSecret(error.message);
  });

  it("registers the webhook and refuses a non-http(s) one", () => {
    const redactor = new Redactor();
    loadConfig(dry({ SIP_SOLANA_ALERT_WEBHOOK: WEBHOOK }), redactor);
    expect(redactor.scrub(`POST ${WEBHOOK}`)).not.toContain("WebhookTokenNeverLogged");
    expect(refusal(dry({ SIP_SOLANA_ALERT_WEBHOOK: "ftp://x.example.test/WebhookTokenNeverLogged" })).message).toContain("SIP_SOLANA_ALERT_WEBHOOK");
  });

  it("reads PORT as an integer port", () => {
    expect(loadConfig(dry({ PORT: "18080" }), new Redactor()).port).toBe(18_080);
    expect(refusal(dry({ PORT: "80a" })).message).toContain("PORT");
    expect(refusal(dry({ PORT: "70000" })).message).toContain("PORT");
  });

  it("warns about a SIP_SOLANA_* name it does not read, because a typo is a silent setting", () => {
    const config = loadConfig(dry({ SIP_SOLANA_BROADCASTS: "1" }), new Redactor());
    expect(config.warnings.join(" ")).toContain("SIP_SOLANA_BROADCASTS");
  });

  it("describes a rejected value by shape, and calls a pasted key what it is", () => {
    expect(shape("")).toBe("an empty value");
    expect(shape("abc")).toBe("a 3-character base58-alphabet value");
    expect(shape("12")).toBe("a 2-character decimal-integer value");
    expect(shape(SETTLE_KEY)).toContain("rotate");
    // Two bytes with their comma: shape() never writes a comma, so this cannot
    // collide with the length digits the way a lone byte did (~2% of keys).
    expect(shape(SETTLE_KEY)).not.toContain(`${settleKeypair.secretKey[0]},${settleKeypair.secretKey[1]}`);
    const error = refusal(dry({ SIP_SOLANA_SWEEP_MS: SETTLE_KEY }));
    expect(error.message).toContain("JSON array secret key");
    expectNoSecret(error.message);
  });
});
