// Configuration, and the broadcast gate.
//
// Non-negotiable #1 is enforced in two places and both are tested here: the mode
// requires BOTH the flag and an exact acknowledgement string, and outside live
// mode the trading key is never handed to the caller. The second is the stronger
// guarantee — a process that does not hold the key cannot broadcast regardless of
// what the rest of the code does. Note the key is still READ (and deleted, and
// registered for redaction) in every mode; what live mode gates is whether
// anything can get at it. See "still takes the trading key out of the
// environment" below.
//
// The last describe block covers non-negotiable #4 on the one path that has no
// logger behind it: a configuration refusal, written raw to stderr by
// bin/keeper.mts before the redactor could possibly be attached.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BROADCAST_ACK, MAINNET, describeConfig, loadConfig } from "../src/config.js";

const ATTESTER = "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";
const TRADING = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const RPC = "https://robinhood-mainnet.g.alchemy.com/v2/SECRETKEY123456";

// A real-looking key (anvil account #0) pasted into a variable that wants an
// ADDRESS. NUVEM_TRADING_ACCOUNT is one word away from "trading key", and this is
// the single most likely way a signing key reaches a log line.
const PASTED_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const baseEnv = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  NUVEM_RPC_URL: RPC,
  NUVEM_KEEPER_ACCOUNT: "0xc455bF7f16ebbc2b07cb26D1Dd46194977974E7d",
  // Explicit because there is no default. A vault belongs to one user, so a
  // built-in fallback would silently aim a settlement at whoever the constant
  // happened to name.
  NUVEM_VAULT: "0x0b5036063527bA4e32032e1b6B953c3677386BBD",
  NUVEM_ATTESTER_PRIVATE_KEY: ATTESTER,
  TRADING_OWNER_PRIVATE_KEY: TRADING,
  ...over,
});

describe("the Privy signer the live path needs", () => {
  const live = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv =>
    baseEnv({
      NUVEM_KEEPER_ALLOW_BROADCAST: BROADCAST_ACK,
      TRADING_OWNER_PRIVATE_KEY: undefined,
      PRIVY_APP_ID: "app",
      PRIVY_APP_SECRET: "secret",
      PRIVY_WALLET_ID: "wallet",
      ...over,
    });

  /**
   * A near-miss name is the worst kind of missing value: the key is present,
   * correct, and simply not read, so the keeper reports "no signer" while the
   * operator is looking straight at one in their .env. A live deployment lost
   * three restarts to exactly this before the account was parked.
   */
  for (const name of ["PRIVY_AUTHORIZATION_KEY", "PRIVY_AUTHORIZATION_PRIVATE_KEY"]) {
    it(`accepts the authorization key as ${name}`, () => {
      const result = loadConfig({
        env: live({ [name]: "wallet-auth:abc" }),
        broadcastFlag: true,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.config.mode).toBe("live");
    });
  }

  it("still refuses live mode when there is genuinely nothing that can sign", () => {
    const result = loadConfig({ env: live(), broadcastFlag: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.join(" ")).toContain("sign AS the trading account");
  });
});

describe("the addresses the keeper falls back to", () => {
  /**
   * These constants were once an entire superseded deployment, and it went
   * unnoticed because each is consulted only when its variable is unset. The
   * one nobody set — attesterRegistry — resolved to an old registry naming a
   * different attester, and every settlement deferred.
   */
  it("agree with the deployment the factory describes", () => {
    // The 2026-08-16 deployment, read back from protocolConfiguration() on
    // factory 0x783BDF02… The previous set here was August's and had gone stale
    // again — which is why `verifyDeployment` now runs at startup rather than
    // trusting these, and why this test is a reminder rather than a guarantee.
    expect(MAINNET.factory).toBe("0x783BDF0281090f21928398cC3Da19cFb64Fed15E");
    expect(MAINNET.executor).toBe("0xfA92ABF15dFAf470Cc8833Cb01464bD6CA139e16");
    expect(MAINNET.attesterRegistry).toBe("0x1a96be4a757e065fb8928a2e5ab2Ab24790Ec7de");
    expect(MAINNET.pauseController).toBe("0x418B3406BC483eB66ca5570b6fF91cE9d090E8a7");
    expect(MAINNET.weth.toLowerCase()).toBe("0x0bd7d308f8e1639fab988df18a8011f41eacad73");
  });

  it("offer no vault at all, because a guess would target a stranger's savings", () => {
    expect(MAINNET.vault).toBe("");
    const result = loadConfig({ env: { ...baseEnv(), NUVEM_VAULT: undefined } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.join(" ")).toContain("NUVEM_KEEPER_VAULT");
  });
});

describe("the broadcast gate", () => {
  it("defaults to dry run with no flags at all", () => {
    const result = loadConfig({ env: baseEnv() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.mode).toBe("dry-run");
  });

  it("stays dry run when --broadcast is absent even with the acknowledgement set", () => {
    const result = loadConfig({ env: baseEnv({ NUVEM_KEEPER_ALLOW_BROADCAST: BROADCAST_ACK }) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.mode).toBe("dry-run");
    expect(result.warnings.join(" ")).toContain("Staying in dry-run mode");
  });

  it("refuses to start when --broadcast is passed without the acknowledgement", () => {
    const result = loadConfig({ env: baseEnv(), broadcastFlag: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.join(" ")).toContain("NUVEM_KEEPER_ALLOW_BROADCAST");
  });

  it("rejects every truthy-looking value that is not the exact sentence", () => {
    // A truthiness check would be enabled by "0", "false" and "no", all of which
    // a human writes when they mean the opposite. The comparison is also byte for
    // byte, so a stray trailing space or a change of case does not arm it either.
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
      const result = loadConfig({
        env: baseEnv({ NUVEM_KEEPER_ALLOW_BROADCAST: value }),
        broadcastFlag: true,
      });
      expect(result.ok, `value ${JSON.stringify(value)} must not arm the keeper`).toBe(false);
    }
  });

  it("goes live only with both the flag and the exact acknowledgement", () => {
    const result = loadConfig({
      env: baseEnv({ NUVEM_KEEPER_ALLOW_BROADCAST: BROADCAST_ACK }),
      broadcastFlag: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.mode).toBe("live");
  });
});

describe("key handling", () => {
  it("does not EXPOSE the trading key in dry-run mode", () => {
    const env = baseEnv();
    const result = loadConfig({ env });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The process simply does not hold a key capable of broadcasting. This is the
    // mechanical half of non-negotiable #1 and it is unchanged.
    expect(result.config.tradingKey).toBeNull();
    expect(result.config.attesterKey).not.toBeNull();
  });

  it("still takes the trading key out of the environment in dry-run mode, and redacts it", () => {
    // It used to be left in place, because the whole read was skipped outside live
    // mode. That left the container's spending key in /proc/1/environ and in
    // `docker inspect` for the life of the process, and left the Redactor unaware
    // of a value it is the Redactor's entire job to catch. Not reading it is not
    // what makes a dry run safe — not HANDING IT OVER is.
    const env = baseEnv();
    const result = loadConfig({ env });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.tradingKey).toBeNull();
    expect(env.TRADING_OWNER_PRIVATE_KEY).toBeUndefined();
    expect(result.config.redactor.scrub(`about to spend with ${TRADING}`)).not.toContain("59c6995e");
  });

  it("deletes and registers an inline key even when a key FILE wins the read", () => {
    // The file's key was registered; the inline one was neither deleted nor
    // registered, because the file branch returned before the delete.
    const env = baseEnv({ NUVEM_ATTESTER_KEY_FILE: "/run/secrets/attester" });
    const fileKey = "0x8d5366123cb560bb606379f90a0bfd4769eecc0557f1b362dcae9012b548b1e5";
    const result = loadConfig({ env }, { readFileSync: () => `${fileKey}\n` });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.attesterKey?.reveal()).toBe(fileKey);
    expect(env.NUVEM_ATTESTER_PRIVATE_KEY).toBeUndefined();
    // Both values are known to the redactor: the one that won and the one that lost.
    const scrubbed = result.config.redactor.scrub(`${fileKey} ${ATTESTER}`);
    expect(scrubbed).not.toContain("8d536612");
    expect(scrubbed).not.toContain("4c0883a6");
  });

  it("removes a key from process.env once it has been read", () => {
    const env = baseEnv({ NUVEM_KEEPER_ALLOW_BROADCAST: BROADCAST_ACK });
    const result = loadConfig({ env, broadcastFlag: true });
    expect(result.ok).toBe(true);
    // Gone from /proc/<pid>/environ and from `docker inspect` for the rest of the
    // process's life.
    expect(env.NUVEM_ATTESTER_PRIVATE_KEY).toBeUndefined();
    expect(env.TRADING_OWNER_PRIVATE_KEY).toBeUndefined();
  });

  it("prefers a key file, and never puts the value in the config's serialization", () => {
    const result = loadConfig(
      {
        env: {
          NUVEM_RPC_URL: RPC,
          NUVEM_KEEPER_ACCOUNT: "0xc455bF7f16ebbc2b07cb26D1Dd46194977974E7d",
          NUVEM_VAULT: "0x0b5036063527bA4e32032e1b6B953c3677386BBD",
          NUVEM_ATTESTER_KEY_FILE: "/run/secrets/attester",
        },
      },
      { readFileSync: (path) => (path === "/run/secrets/attester" ? `${ATTESTER}\n` : "") },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.attesterKey?.reveal()).toBe(ATTESTER);
    // The config holds bigint limits, so serializing it needs a replacer. That is
    // beside the point: what matters is that the KEY is not in the output.
    const big = (_k: string, v: unknown): unknown => (typeof v === "bigint" ? v.toString() : v);
    expect(JSON.stringify(result.config, big)).not.toContain("4c0883a6");
    expect(JSON.stringify(result.config, big)).toContain("<redacted:attesterKey>");
    expect(JSON.stringify(describeConfig(result.config))).not.toContain("4c0883a6");
  });

  it("refuses a malformed key rather than failing later at signing time", () => {
    for (const bad of ["not-a-key", "0x1234", ATTESTER.slice(0, -2), `${ATTESTER}ff`]) {
      const result = loadConfig({ env: baseEnv({ NUVEM_ATTESTER_PRIVATE_KEY: bad }) });
      expect(result.ok, `key ${bad.slice(0, 12)} must be rejected`).toBe(false);
    }
  });

  it("registers the RPC URL and both keys with the redactor", () => {
    const result = loadConfig({
      env: baseEnv({ NUVEM_KEEPER_ALLOW_BROADCAST: BROADCAST_ACK }),
      broadcastFlag: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const scrubbed = result.config.redactor.scrub(`${RPC} ${ATTESTER} ${TRADING}`);
    expect(scrubbed).not.toContain("SECRETKEY123456");
    expect(scrubbed).not.toContain("4c0883a6");
    expect(scrubbed).not.toContain("59c6995e");
  });

  it("exposes only the RPC host, never the URL with its key", () => {
    const result = loadConfig({ env: baseEnv() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.rpcHost).toBe("robinhood-mainnet.g.alchemy.com");
    expect(JSON.stringify(describeConfig(result.config))).not.toContain("SECRETKEY");
  });
});

describe("a refusal never echoes the value it read", () => {
  // Config validation happens BEFORE any logger exists, and bin/keeper.mts writes
  // each problem straight to stderr, so a message that quotes what it read
  // publishes it into container logs — which are json-file logged, rotated and
  // pasted into bug reports. Non-negotiable #4 says a key must never appear in a
  // log line OR an error message, and this is the error-message half.

  it("names the variable and the shape but not the value", () => {
    const result = loadConfig({ env: baseEnv({ NUVEM_TRADING_ACCOUNT: PASTED_KEY, NUVEM_KEEPER_ACCOUNT: "" }) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const text = result.problems.join("\n");

    // Diagnosable: which variable, what was expected, and what shape arrived.
    expect(text).toContain("NUVEM_KEEPER_ACCOUNT");
    expect(text).toContain("40 hex characters");
    expect(text).toContain("66-character");
    // ...and it says the dangerous part out loud, because the operator must rotate.
    expect(text).toContain("private key");

    // Unusable: not the value, not the body without 0x, not even a prefix.
    expect(text).not.toContain(PASTED_KEY);
    expect(text).not.toContain(PASTED_KEY.slice(2));
    expect(text).not.toContain("ac0974be");
    expect(text).not.toContain("f4f2ff80");
  });

  it("registers a key-shaped value found in ANY variable, so later output cannot leak it", () => {
    // The load fails, and the redactor comes back on the failure branch primed
    // with the pasted value even though nothing here knows what variable it
    // belongs in.
    const result = loadConfig({ env: baseEnv({ NUVEM_KEEPER_ACCOUNT: PASTED_KEY }) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const scrubbed = result.redactor.scrub(`transport error for ${PASTED_KEY}`);
    expect(scrubbed).not.toContain("ac0974be");
    expect(scrubbed).toContain("possible-key:NUVEM_KEEPER_ACCOUNT");
  });

  it("scrubs problems on the way out when a message legitimately quotes a path", () => {
    // A path IS worth printing — it is how an operator finds the mount that is
    // missing. So this is the case layer 2 exists for: the value quoted here
    // happens to be the RPC URL, which carries the API key, and the redactor is
    // primed before validation runs so the key comes out redacted rather than raw.
    const failing = loadConfig(
      { env: baseEnv({ NUVEM_ATTESTER_KEY_FILE: RPC }) },
      {
        readFileSync: () => {
          throw new Error(`ENOENT: no such file or directory, open '${RPC}'`);
        },
      },
    );
    expect(failing.ok).toBe(false);
    if (failing.ok) return;
    const quoted = failing.problems.join("\n");
    expect(quoted).toContain("NUVEM_ATTESTER_KEY_FILE");
    expect(quoted).toContain("<redacted:rpcUrl>");
    expect(quoted).not.toContain("SECRETKEY123456");
  });

  it("keeps the RPC API key out of a refusal caused by the URL itself", () => {
    const result = loadConfig({ env: baseEnv({ NUVEM_RPC_URL: "robinhood.example/v2/SECRETKEY123456" }) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.join(String.fromCharCode(10))).toContain("NUVEM_RPC_URL");
    expect(result.problems.join(String.fromCharCode(10))).not.toContain("SECRETKEY123456");
  });

  it("does not print a pasted key to REAL stderr when the CLI refuses to start", { timeout: 60_000 }, () => {
    // The unit assertions above test the strings. This tests the actual exit path:
    // bin/keeper.mts writes result.problems to process.stderr and exits 2, with no
    // logger and no redactor between them and the terminal.
    const cli = fileURLToPath(new URL("../bin/keeper.mts", import.meta.url));
    const proc = spawnSync(process.execPath, ["--import", "tsx", cli, "status"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      encoding: "utf8",
      env: {
        ...process.env,
        NUVEM_RPC_URL: RPC,
        // The paste. `status` is read-only, so this is the only problem there is.
        NUVEM_KEEPER_ACCOUNT: PASTED_KEY,
        NUVEM_TRADING_ACCOUNT: "",
        NUVEM_ATTESTER_PRIVATE_KEY: "",
        NUVEM_ATTESTER_KEY_FILE: "",
        TRADING_OWNER_PRIVATE_KEY: "",
        NUVEM_KEEPER_ALLOW_BROADCAST: "",
        NUVEM_KEEPER_HTTP_PORT: "0",
      },
    });

    expect(proc.error).toBeUndefined();
    expect(proc.status).toBe(2);
    expect(proc.stderr).toContain("Refusing to start");
    expect(proc.stderr).toContain("NUVEM_KEEPER_ACCOUNT");
    for (const stream of [proc.stderr, proc.stdout]) {
      expect(stream).not.toContain(PASTED_KEY);
      expect(stream).not.toContain(PASTED_KEY.slice(2));
      expect(stream).not.toContain("ac0974be");
      expect(stream).not.toContain("SECRETKEY123456");
    }
  });
});

describe("refusing to start", () => {
  it("requires an RPC URL", () => {
    const env = baseEnv();
    delete env.NUVEM_RPC_URL;
    const result = loadConfig({ env });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.join(" ")).toContain("NUVEM_RPC_URL");
  });

  it("requires the trading account, because it IS the settler", () => {
    const env = baseEnv();
    delete env.NUVEM_KEEPER_ACCOUNT;
    const result = loadConfig({ env });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.join(" ")).toContain("trading account is required");
  });

  it("rejects a malformed address rather than reading a zeroed struct from nowhere", () => {
    const result = loadConfig({ env: baseEnv({ NUVEM_KEEPER_ACCOUNT: "0xnope" }) });
    expect(result.ok).toBe(false);
  });

  it("rejects a non-integer chain id and a negative limit", () => {
    expect(loadConfig({ env: baseEnv({ NUVEM_CHAIN_ID: "four-thousand" }) }).ok).toBe(false);
    expect(loadConfig({ env: baseEnv({ NUVEM_KEEPER_POLL_MS: "-1" }) }).ok).toBe(false);
    expect(loadConfig({ env: baseEnv({ NUVEM_KEEPER_MAX_CONTRIBUTION_WEI: "0" }) }).ok).toBe(false);
  });

  it("allows read-only commands to run with no attester key at all", () => {
    const env = baseEnv();
    delete env.NUVEM_ATTESTER_PRIVATE_KEY;
    expect(loadConfig({ env, requireAttesterKey: false }).ok).toBe(true);
    expect(loadConfig({ env: baseEnv({ NUVEM_ATTESTER_PRIVATE_KEY: "" }) }).ok).toBe(false);
  });

  it("refuses a key-shaped NUVEM_KEEPER_HTTP_PORT without printing it either", () => {
    const result = loadConfig({ env: baseEnv({ NUVEM_KEEPER_HTTP_PORT: PASTED_KEY }) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const text = result.problems.join("\n");
    expect(text).toContain("NUVEM_KEEPER_HTTP_PORT");
    expect(text).not.toContain("ac0974be");
  });

  /**
   * This previously asserted a SUPERSEDED deployment, which is why the stale
   * constants survived: the suite agreed with them. Pinning addresses is still
   * worth doing — it catches an accidental edit — but only against values
   * re-read from `factory.protocolConfiguration()`, never against whatever the
   * source happens to say.
   */
  it("defaults every address to the live mainnet deployment", () => {
    const result = loadConfig({ env: baseEnv() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.chainId).toBe(4663);
    // Re-read from protocolConfiguration() on factory 0x783BDF02… (2026-08-16),
    // which is the only way this assertion is worth anything. It has now been
    // wrong twice, both times because the suite was updated from the source
    // rather than from the chain.
    expect(result.config.factory).toBe("0x783BDF0281090f21928398cC3Da19cFb64Fed15E");
    expect(result.config.executor).toBe("0xfA92ABF15dFAf470Cc8833Cb01464bD6CA139e16");
  });
});
