// Configuration, and the broadcast gate.
//
// DESIGN.md §0.1 is enforced in two places and both are tested here: the mode
// requires the exact acknowledgement string, byte for byte, and outside live
// mode the secrets are never READ — proved with a getter that throws. The
// second is the stronger guarantee: a process that never held a secret cannot
// leak or use it regardless of what the rest of the code does.
//
// The last blocks cover §0.6 on the one path that has no logger behind it: a
// configuration refusal, written raw to stderr by bin/worker.mts.

import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BROADCAST_ACK,
  ConfigError,
  DEFAULTS,
  SECRET_VARS,
  describeConfig,
  loadConfig,
  parseConfig,
  shape,
} from "../src/config.js";
import { Redactor, createLogger } from "../src/log.js";
import { seatSignerOver } from "../src/pull/privy.js";

/** Shaped exactly like real keys. Never used to sign anything. */
const ATTESTER = "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";
// A real-looking key pasted into a variable that wants an ADDRESS: the single
// most likely way a signing key reaches a log line.
const PASTED_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const RPC = "https://robinhood-mainnet.g.alchemy.com/v2/SECRETKEY123456";
const DB = "postgres://sip:DbPassw0rdSecret@db.example.test:5432/sip";
const AUTH_KEY = "wallet-auth:MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgSecretAuthorizationKeyBody";
const APP_SECRET = "privy-app-secret-value-never-logged";

/** Everything a dry run needs. */
/**
 * A deployment is REQUIRED now — no default aims the worker anywhere — so every
 * environment a test builds names one. These addresses belong to no deployment
 * on purpose; a test must never be able to reach a real vault.
 */
const DEPLOYMENT: NodeJS.ProcessEnv = {
  SIP_VAULT_FACTORY: "0x1111111111111111111111111111111111111111",
  SIP_SETTLEMENT_EXECUTOR: "0x2222222222222222222222222222222222222222",
  SIP_LOGS_FROM_BLOCK: "1000",
};

const SIGNER_ID = "zdhe35f97hmzxes5iuzga7d0";

const dry = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ SIP_RPC_URLS: RPC, ...DEPLOYMENT, ...over });

/** Everything a live run needs. */
const live = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  SIP_RPC_URLS: RPC,
  ...DEPLOYMENT,
  SIP_WORKER_ALLOW_BROADCAST: BROADCAST_ACK,
  SIP_ATTESTER_PRIVATE_KEY: ATTESTER,
  PRIVY_APP_ID: "app-id",
  PRIVY_APP_SECRET: APP_SECRET,
  PRIVY_AUTHORIZATION_PRIVATE_KEY: AUTH_KEY,
  PRIVY_SIGNER_ID: SIGNER_ID,
  DATABASE_URL: DB,
  ...over,
});

const SECRET_FRAGMENTS = [ATTESTER, ATTESTER.slice(2), "4c0883a6", "SECRETKEY123456", "DbPassw0rdSecret", APP_SECRET, AUTH_KEY.slice(12)];

const expectNoSecret = (text: string): void => {
  for (const fragment of SECRET_FRAGMENTS) expect(text).not.toContain(fragment);
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the facts DESIGN.md §1 pins", () => {
  it("pins the tuning defaults and the acknowledgement, and ships no deployment", () => {
    // No deployment is built in any more: the factory and the executor are
    // required, so a worker can never silently aim at Nuvem's vaults.
    expect(DEFAULTS).toEqual({ pollMs: 300_000, finalityMarginL2: 64n, maxLogSpan: 10_000n });
    expect(BROADCAST_ACK).toBe("i-understand-this-moves-real-funds");
  });
});

describe("the broadcast gate", () => {
  it("defaults to dry run with every default in place and no secret at all", () => {
    const result = parseConfig(dry(), new Redactor());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config).toMatchObject({
      mode: "dry-run",
      chainId: 4663,
      rpcUrls: [RPC],
      factory: DEPLOYMENT["SIP_VAULT_FACTORY"],
      executor: DEPLOYMENT["SIP_SETTLEMENT_EXECUTOR"],
      logsFromBlock: 1000n,
      databaseUrl: null,
      pollMs: 300_000,
      finalityMarginL2: 64n,
      maxLogSpan: 10_000n,
      attesterPrivateKey: null,
      privy: null,
    });
    expect(result.warnings).toEqual([]);
  });

  it("stays dry run on every truthy-looking value that is not the exact sentence, and hands over nothing", () => {
    // A truthiness check would be enabled by "0", "false" and "no", all of which
    // a human writes when they mean the opposite. The comparison is byte for
    // byte, so a stray space, a newline or a change of case does not arm it.
    for (const value of [
      "1",
      "true",
      "yes",
      "0",
      "false",
      "no",
      "i-understand",
      `${BROADCAST_ACK} `,
      ` ${BROADCAST_ACK}`,
      `${BROADCAST_ACK}\n`,
      BROADCAST_ACK.toUpperCase(),
      BROADCAST_ACK.replace(/-/g, "_"),
    ]) {
      const env = live({ SIP_WORKER_ALLOW_BROADCAST: value });
      const result = parseConfig(env, new Redactor());
      expect(result.ok, `value ${JSON.stringify(value)} must still load, as a dry run`).toBe(true);
      if (!result.ok) return;
      expect(result.config.mode, `value ${JSON.stringify(value)} must not arm the worker`).toBe("dry-run");
      expect(result.config.attesterPrivateKey).toBeNull();
      expect(result.config.privy).toBeNull();
      for (const name of SECRET_VARS) expect(env[name], `${name} must be gone`).toBeUndefined();
      const warning = result.warnings.join(" ");
      expect(warning).toContain("SIP_WORKER_ALLOW_BROADCAST");
      expect(warning).toContain("byte for byte");
    }
  });

  it("goes live only with the exact sentence, and then holds every secret", () => {
    const env = live();
    const result = parseConfig(env, new Redactor());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.mode).toBe("live");
    expect(result.config.attesterPrivateKey).toBe(ATTESTER);
    expect(result.config.privy).toMatchObject({ appId: "app-id", appSecret: APP_SECRET, authorizationPrivateKey: AUTH_KEY });
    expect(result.config.databaseUrl).toBe(DB);
    // Gone from the environment for the rest of the process's life.
    for (const name of SECRET_VARS) expect(env[name]).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  it("accepts the authorization key under either spelling, because a near-miss is invisible until live mode", () => {
    const env = live({ PRIVY_AUTHORIZATION_PRIVATE_KEY: undefined, PRIVY_AUTHORIZATION_KEY: AUTH_KEY });
    const result = parseConfig(env, new Redactor());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.privy?.authorizationPrivateKey).toBe(AUTH_KEY);
    expect(env.PRIVY_AUTHORIZATION_KEY).toBeUndefined();
  });
});

describe("live mode requires every secret", () => {
  for (const name of [
    "SIP_ATTESTER_PRIVATE_KEY",
    "PRIVY_APP_ID",
    "PRIVY_APP_SECRET",
    "PRIVY_AUTHORIZATION_PRIVATE_KEY",
    "PRIVY_SIGNER_ID",
    "DATABASE_URL",
  ]) {
    it(`refuses to start without ${name}, naming it and echoing nothing`, () => {
      const env = live();
      delete env[name];
      const result = parseConfig(env, new Redactor());
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const text = result.problems.join("\n");
      expect(text).toContain(name);
      expectNoSecret(text);
    });
  }

  it("refuses a malformed attester key by shape rather than failing at signing time", () => {
    for (const bad of ["not-a-key", "0x1234", ATTESTER.slice(0, -2), `${ATTESTER}ff`]) {
      const result = parseConfig(live({ SIP_ATTESTER_PRIVATE_KEY: bad }), new Redactor());
      expect(result.ok, `key ${bad.slice(0, 8)} must be rejected`).toBe(false);
      if (result.ok) return;
      const text = result.problems.join("\n");
      expect(text).toContain("SIP_ATTESTER_PRIVATE_KEY");
      expect(text).toContain("66 characters");
      expect(text).not.toContain(bad);
    }
  });

  it("refuses to go live on the memory ledger, because a forgotten pull is a window pulled twice", () => {
    const result = parseConfig(live({ DATABASE_URL: undefined }), new Redactor());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.join(" ")).toContain("DATABASE_URL");
    // The same absence is fine in dry run: null means the memory ledger.
    const dryRun = parseConfig(dry(), new Redactor());
    expect(dryRun.ok && dryRun.config.databaseUrl).toBeNull();
  });
});

describe("dry run never reads a secret", () => {
  /** A property whose value cannot be read without the test failing. */
  const trap = (env: NodeJS.ProcessEnv, name: string): void => {
    Object.defineProperty(env, name, {
      configurable: true,
      enumerable: true,
      get(): string {
        throw new Error(`${name} was read in dry run`);
      },
    });
  };

  it("removes the secret variables by name without ever touching their values", () => {
    const env = dry();
    for (const name of SECRET_VARS) trap(env, name);
    const result = parseConfig(env, new Redactor());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const name of SECRET_VARS) expect(name in env, `${name} must be gone`).toBe(false);
    const warning = result.warnings.join(" ");
    expect(warning).toContain("unread");
    for (const name of SECRET_VARS) expect(warning).toContain(name);
  });

  it("does not let the key-shaped sweep see the attester key's own variable either", () => {
    const redactor = new Redactor();
    const result = parseConfig(dry({ SIP_ATTESTER_PRIVATE_KEY: ATTESTER }), redactor);
    expect(result.ok).toBe(true);
    // No needle was registered for it — it was never read — yet a log line
    // carrying it would still be masked, by shape, with no variable name.
    const scrubbed = redactor.scrub(`leak ${ATTESTER}`);
    expect(scrubbed).not.toContain("possible-key");
    expect(scrubbed).not.toContain("attesterKey");
    expect(scrubbed).toContain("<redacted:hex64:");
    expect(scrubbed).not.toContain("4c0883a6");
  });

  it("reads the same variables in live mode (the trap is real)", () => {
    const env = live();
    Object.defineProperty(env, "SIP_ATTESTER_PRIVATE_KEY", { configurable: true, enumerable: true, get: () => ATTESTER });
    const result = parseConfig(env, new Redactor());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.attesterPrivateKey).toBe(ATTESTER);
    expect("SIP_ATTESTER_PRIVATE_KEY" in env).toBe(false);
  });
});

describe("the key-shaped sweep", () => {
  it("refuses a key pasted into an address variable by shape, names it, and registers it", () => {
    const result = parseConfig(dry({ SIP_VAULT_FACTORY: PASTED_KEY }), new Redactor());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const text = result.problems.join("\n");
    // Diagnosable: which variable, what was expected, and what shape arrived.
    expect(text).toContain("SIP_VAULT_FACTORY");
    expect(text).toContain("40 hex characters");
    expect(text).toContain("66-character");
    // ...and it says the dangerous part out loud, because the operator must rotate.
    expect(text).toContain("private key");
    expect(text).toContain("rotate");
    // Unusable: not the value, not the body without 0x, not even a prefix.
    expect(text).not.toContain(PASTED_KEY);
    expect(text).not.toContain(PASTED_KEY.slice(2));
    expect(text).not.toContain("ac0974be");
    expect(text).not.toContain("f4f2ff80");
    // The redactor comes back primed, with a label naming the variable to rotate.
    const scrubbed = result.redactor.scrub(`transport error for ${PASTED_KEY}`);
    expect(scrubbed).toBe("transport error for <redacted:possible-key:SIP_VAULT_FACTORY>");
  });

  it("sees every variable, even one this file has never heard of", () => {
    const redactor = new Redactor();
    const result = parseConfig(dry({ SOME_UNRELATED_SETTING: ` ${PASTED_KEY} ` }), redactor);
    expect(result.ok).toBe(true);
    expect(redactor.scrub(PASTED_KEY.toUpperCase())).toBe("<redacted:possible-key:SOME_UNRELATED_SETTING>");
  });

  it("names the shape, never the content, for every kind of wrong value", () => {
    expect(shape("")).toBe("an empty value");
    expect(shape("   ")).toBe("a 3-character whitespace-only value");
    expect(shape("0xabc")).toBe("a 5-character 0x-prefixed hex value");
    expect(shape("-12")).toBe("a 3-character decimal-integer value");
    expect(shape("1.5")).toBe("a 3-character decimal-fraction value");
    expect(shape("hello world")).toBe("a 11-character neither-hex-nor-numeric value");
    expect(shape(PASTED_KEY)).toContain("shaped exactly like a 0x-prefixed 32-byte private key");
    expect(shape(PASTED_KEY)).not.toContain("ac0974be");
  });
});

describe("RPC endpoints", () => {
  it("splits on commas, trims, drops empties and keeps the preference order", () => {
    const result = parseConfig(dry({ SIP_RPC_URLS: ` ${RPC} , https://b.example.test/x ,, ` }), new Redactor());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.rpcUrls).toEqual([RPC, "https://b.example.test/x"]);
  });

  it("accepts SIP_RPC_URL as a near-miss of SIP_RPC_URLS", () => {
    const result = parseConfig({ SIP_RPC_URL: RPC, ...DEPLOYMENT }, new Redactor());
    expect(result.ok && result.config.rpcUrls).toEqual([RPC]);
  });

  it("requires at least one endpoint", () => {
    for (const env of [{}, { SIP_RPC_URLS: "   " }, { SIP_RPC_URLS: " , , " }]) {
      const result = parseConfig(env, new Redactor());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.problems.join(" ")).toContain("SIP_RPC_URLS");
    }
  });

  it("refuses a non-http(s) or unparsable entry by position, without echoing it", () => {
    for (const bad of ["wss://x.example.test/SECRETWS", "robinhood.example/v2/SECRETKEY123456", "ftp://x.example.test"]) {
      const result = parseConfig(dry({ SIP_RPC_URLS: `${RPC},${bad}` }), new Redactor());
      expect(result.ok, bad).toBe(false);
      if (result.ok) return;
      const text = result.problems.join("\n");
      expect(text).toContain("SIP_RPC_URLS entry #2");
      expect(text).not.toContain("SECRETWS");
      expect(text).not.toContain("SECRETKEY123456");
      expect(text).not.toContain("x.example.test");
    }
  });

  it("registers every endpoint with the redactor before anything can fail", () => {
    const redactor = new Redactor();
    const result = parseConfig(dry({ SIP_RPC_URLS: `${RPC},not a url` }), redactor);
    expect(result.ok).toBe(false);
    expect(redactor.scrub(`429 from ${RPC}`)).toBe("429 from <redacted:rpcUrl:0>");
  });
});

describe("addresses", () => {
  it("lowercases a checksummed address and accepts a lowercase one", () => {
    const result = parseConfig(
      dry({
        SIP_VAULT_FACTORY: "0x1111111111111111111111111111111111111111",
        SIP_SETTLEMENT_EXECUTOR: "0x2222222222222222222222222222222222222222",
      }),
      new Redactor(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.factory).toBe("0x1111111111111111111111111111111111111111");
    expect(result.config.executor).toBe("0x2222222222222222222222222222222222222222");
  });

  it("refuses a mixed-case address whose checksum does not match, rather than talking to a different contract", () => {
    // Mixed case with ONE character wrong: an all-lowercase address skips checksum
    // validation entirely, so the bad-checksum path needs a mixed-case value.
    const result = parseConfig(dry({ SIP_SETTLEMENT_EXECUTOR: "0xaBcdEFABcdEFabcdEfAbCdefabcdeFABcDEFabCD" }), new Redactor());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.join(" ")).toContain("SIP_SETTLEMENT_EXECUTOR");
    expect(result.problems.join(" ")).toContain("checksum");
  });

  it("refuses a malformed address by shape", () => {
    for (const bad of ["0xnope", "783bdf0281090f21928398cc3da19cfb64fed15e", `0x${"a".repeat(39)}`, `0x${"a".repeat(41)}`]) {
      const result = parseConfig(dry({ SIP_VAULT_FACTORY: bad }), new Redactor());
      expect(result.ok, bad).toBe(false);
      if (!result.ok) expect(result.problems.join(" ")).toContain("40 hex characters");
    }
  });
});

describe("numbers", () => {
  const refuses = (over: NodeJS.ProcessEnv, name: string): void => {
    const result = parseConfig(dry(over), new Redactor());
    expect(result.ok, JSON.stringify(over)).toBe(false);
    if (!result.ok) expect(result.problems.join(" ")).toContain(name);
  };

  it("parses each tuning variable to its type", () => {
    const result = parseConfig(
      dry({
        SIP_CHAIN_ID: "31337",
        SIP_POLL_MS: "60000",
        SIP_FINALITY_MARGIN_L2: "0",
        SIP_MAX_LOG_SPAN: "2000",
        SIP_LOGS_FROM_BLOCK: "0",
      }),
      new Redactor(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config).toMatchObject({ chainId: 31337, pollMs: 60_000, finalityMarginL2: 0n, maxLogSpan: 2000n, logsFromBlock: 0n });
  });

  it("refuses a non-integer, zero or negative chain id and poll interval", () => {
    for (const bad of ["four-thousand", "-1", "0", "1.5", "1e3"]) {
      refuses({ SIP_CHAIN_ID: bad }, "SIP_CHAIN_ID");
      refuses({ SIP_POLL_MS: bad }, "SIP_POLL_MS");
    }
  });

  it("refuses a negative block or margin, and a zero log span", () => {
    refuses({ SIP_FINALITY_MARGIN_L2: "-1" }, "SIP_FINALITY_MARGIN_L2");
    refuses({ SIP_LOGS_FROM_BLOCK: "-5" }, "SIP_LOGS_FROM_BLOCK");
    refuses({ SIP_LOGS_FROM_BLOCK: "abc" }, "SIP_LOGS_FROM_BLOCK");
    refuses({ SIP_MAX_LOG_SPAN: "0" }, "SIP_MAX_LOG_SPAN");
    refuses({ SIP_MAX_LOG_SPAN: "1.5" }, "SIP_MAX_LOG_SPAN");
  });

  it("refuses a key-shaped number without printing it either", () => {
    const result = parseConfig(dry({ SIP_POLL_MS: PASTED_KEY }), new Redactor());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const text = result.problems.join("\n");
    expect(text).toContain("SIP_POLL_MS");
    expect(text).toContain("private key");
    expect(text).not.toContain("ac0974be");
  });
});

describe("the ledger URL", () => {
  it("is optional in dry run and accepted under SIP_DATABASE_URL too", () => {
    expect(parseConfig(dry(), new Redactor())).toMatchObject({ ok: true, config: { databaseUrl: null } });
    expect(parseConfig(dry({ SIP_DATABASE_URL: DB }), new Redactor())).toMatchObject({ ok: true, config: { databaseUrl: DB } });
    expect(parseConfig(dry({ DATABASE_URL: DB.replace("postgres:", "postgresql:") }), new Redactor()).ok).toBe(true);
  });

  it("refuses the transaction pooler on 6543, because advisory locks do not survive it", () => {
    const result = parseConfig(dry({ DATABASE_URL: DB.replace(":5432", ":6543") }), new Redactor());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.join(" ")).toContain("6543");
    expectNoSecret(result.problems.join(" "));
  });

  it("refuses a non-postgres or unparsable URL, never echoing the password", () => {
    for (const bad of ["https://db.example.test/sip", "not a url at all", "mysql://sip:DbPassw0rdSecret@db.example.test/sip"]) {
      const result = parseConfig(dry({ DATABASE_URL: bad }), new Redactor());
      expect(result.ok, bad).toBe(false);
      if (result.ok) return;
      expect(result.problems.join(" ")).toContain("DATABASE_URL");
      expectNoSecret(result.problems.join(" "));
    }
  });

  it("registers the URL with the redactor the moment it is read", () => {
    const redactor = new Redactor();
    parseConfig(dry({ DATABASE_URL: DB }), redactor);
    expect(redactor.scrub(`connect ${DB} failed`)).toBe("connect <redacted:databaseUrl> failed");
  });
});

describe("nothing secret survives serialization", () => {
  const loaded = (): { config: ReturnType<typeof loadConfig>; redactor: Redactor } => {
    const redactor = new Redactor();
    return { config: loadConfig(live(), { redactor, onWarning: () => {} }), redactor };
  };

  it("JSON.stringify and util.inspect yield the safe description, not the fields", () => {
    const { config } = loaded();
    for (const text of [JSON.stringify(config), JSON.stringify({ config }), inspect(config), inspect({ config })]) {
      expectNoSecret(text);
      expect(text).toContain("robinhood-mainnet.g.alchemy.com");
      expect(text).toContain("attesterKeyPresent");
    }
    expect(JSON.parse(JSON.stringify(config))).toEqual(describeConfig(config));
    expect(describeConfig(config)).toMatchObject({
      mode: "live",
      chainId: 4663,
      rpcHosts: ["robinhood-mainnet.g.alchemy.com"],
      ledger: "postgres@db.example.test:5432",
      attesterKeyPresent: true,
      privyAppId: "app-id",
    });
  });

  it("the privy block describes itself the same way", () => {
    const { config } = loaded();
    const text = JSON.stringify(config.privy);
    expectNoSecret(text);
    expect(text).toContain('"appId":"app-id"');
    expect(text).toContain("<redacted:privyAppSecret>");
    expect(text).toContain("<redacted:privyAuthorizationKey>");
  });

  it("but a teammate's spread and property access still see the real fields", () => {
    const { config } = loaded();
    const copy = { ...config };
    expect(copy.rpcUrls).toEqual([RPC]);
    expect(copy.attesterPrivateKey).toBe(ATTESTER);
    expect(config.attesterPrivateKey).toBe(ATTESTER);
    expect(config.privy?.appSecret).toBe(APP_SECRET);
    expect(Object.keys(config)).toContain("rpcUrls");
    expect(Object.keys(config)).not.toContain("toJSON");
  });

  it("and the logger scrubs a config that is logged whole, belt and braces", () => {
    const { config, redactor } = loaded();
    const lines: string[] = [];
    createLogger({ redactor, sink: (line) => lines.push(line), json: true }).info("boot", { config, raw: { ...config } });
    expect(lines).toHaveLength(1);
    expectNoSecret(lines[0] ?? "");
    expect(lines[0]).toContain("<redacted:attesterKey>");
    expect(lines[0]).toContain("<redacted:rpcUrl:0>");
    expect(lines[0]).toContain("<redacted:databaseUrl>");
    expect(lines[0]).toContain("<redacted:privyAppSecret>");
    expect(lines[0]).toContain("<redacted:privyAuthorizationKey>");
  });
});

describe("loadConfig, the throwing wrapper the binary uses", () => {
  it("throws a ConfigError whose problems and message are scrubbed and name the variable", () => {
    const env = dry({ SIP_VAULT_FACTORY: PASTED_KEY, SIP_RPC_URLS: `${RPC},bad` });
    let caught: unknown;
    try {
      loadConfig(env, { redactor: new Redactor(), onWarning: () => {} });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    if (!(caught instanceof ConfigError)) return;
    expect(caught.name).toBe("ConfigError");
    expect(caught.problems).toHaveLength(2);
    expect(caught.message).toContain("Refusing to start");
    expect(caught.message).toContain("SIP_VAULT_FACTORY");
    expect(caught.message).toContain("SIP_RPC_URLS entry #2");
    for (const text of [caught.message, ...caught.problems]) {
      expect(text).not.toContain("ac0974be");
      expect(text).not.toContain("SECRETKEY123456");
    }
  });

  it("forwards warnings to onWarning and still returns a dry-run config", () => {
    const warnings: string[] = [];
    const config = loadConfig(live({ SIP_WORKER_ALLOW_BROADCAST: "true" }), {
      redactor: new Redactor(),
      onWarning: (message) => warnings.push(message),
    });
    expect(config.mode).toBe("dry-run");
    expect(warnings.join(" ")).toContain("SIP_WORKER_ALLOW_BROADCAST");
    expect(warnings.join(" ")).toContain("unread");
    expectNoSecret(warnings.join(" "));
  });

  it("writes warnings to stderr when nobody asked for them, because there is no logger yet", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    loadConfig(dry({ SIP_WORKER_ALLOW_BROADCAST: "1" }), { redactor: new Redactor() });
    const written = stderr.mock.calls.map((call) => String(call[0])).join("");
    expect(written).toContain("warning: SIP_WORKER_ALLOW_BROADCAST");
  });

  it("registers what it reads with the shared redactor, so the default logger masks the RPC key", () => {
    const url = "https://rpc.example.test/v2/UniqueKeyForTheSharedRedactorTest";
    loadConfig(dry({ SIP_RPC_URLS: url }));
    const lines: string[] = [];
    createLogger({ sink: (line) => lines.push(line), json: true }).error("rpc", { error: new Error(`429 from ${url}`) });
    expect(lines[0]).not.toContain("UniqueKeyForTheSharedRedactorTest");
    expect(lines[0]).toContain("<redacted:rpcUrl:0>");
  });
});

describe("the Privy seat is constructible from the config it is handed", () => {
  // THE REGRESSION. The seat has always demanded a signer id -- seatSignerOver
  // calls requireSignerId, which throws -- and config.ts did not read
  // PRIVY_SIGNER_ID at all, so makeSeat built the seat without one. Nothing
  // caught it because nothing ever built a seat from a parsed config: arming the
  // worker threw at module load, every time, and only in live mode.
  it("carries PRIVY_SIGNER_ID through to a seat that builds", () => {
    const result = parseConfig(live(), new Redactor());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.privy?.signerId).toBe(SIGNER_ID);

    // The consumer, with the real precondition and a fake transport.
    const api = { walletsAt: async () => [], sendPull: async () => "0x" as const };
    expect(() =>
      seatSignerOver(api as never, {
        authorizationPrivateKey: result.config.privy!.authorizationPrivateKey,
        signerId: result.config.privy!.signerId,
      }),
    ).not.toThrow();
  });

  it("still refuses a signer id that is only whitespace", () => {
    const result = parseConfig(live({ PRIVY_SIGNER_ID: "   " }), new Redactor());
    // Trimmed to empty by `first`, so the parser refuses rather than handing the
    // seat a value requireSignerId would reject later.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.join("\n")).toContain("PRIVY_SIGNER_ID");
  });

  it("keeps the signer id out of the secret set: it is an id, and legible on purpose", () => {
    const result = parseConfig(live(), new Redactor());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(result.config.privy)).toContain(SIGNER_ID);
    expectNoSecret(JSON.stringify(result.config.privy));
  });
});
