// The redacting logger, tested against a real-looking key.
//
// Requirement 4 is "the attester private key never reaches a log line or an
// error message". These tests use a key of exactly the right shape (0x + 64 hex)
// so a regression in the length heuristics, the case folding or the
// substitution order fails here rather than in production.

import { describe, expect, it } from "vitest";
import { Redactor, Secret, createLogger, redactUpstreamHost, summarizeUpstreamError } from "../src/log.js";

/** Shaped exactly like a real key. Never used to sign anything. */
const FAKE_KEY = "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";
const FAKE_RPC = "https://robinhood-mainnet.g.alchemy.com/v2/AbCdEf1234567890SecretKey";

function capture(): { lines: string[]; sink: (line: string) => void } {
  const lines: string[] = [];
  return { lines, sink: (line) => lines.push(line) };
}

describe("Secret", () => {
  it("does not serialize its value", () => {
    const secret = new Secret(FAKE_KEY, "attesterKey");
    expect(JSON.stringify({ key: secret })).not.toContain("4c0883a6");
    expect(JSON.stringify({ key: secret })).toBe('{"key":"<redacted:attesterKey>"}');
    expect(String(secret)).toBe("<redacted:attesterKey>");
    expect(`${secret}`).toBe("<redacted:attesterKey>");
    // The value is still reachable at the point of use, and only there.
    expect(secret.reveal()).toBe(FAKE_KEY);
  });

  it("survives spread and Object.entries, which a plain field would not", () => {
    const secret = new Secret(FAKE_KEY, "attesterKey");
    const config = { chainId: 4663, attesterKey: secret };
    expect(JSON.stringify({ ...config })).not.toContain(FAKE_KEY.slice(2, 20));
    expect(Object.entries(config).map(([, v]) => String(v)).join(",")).not.toContain("4c0883");
  });
});

describe("Redactor", () => {
  it("redacts a key in both cases and with or without the 0x prefix", () => {
    const redactor = new Redactor().register(FAKE_KEY, "attesterKey");
    for (const form of [FAKE_KEY, FAKE_KEY.toUpperCase(), FAKE_KEY.slice(2), FAKE_KEY.slice(2).toUpperCase()]) {
      const scrubbed = redactor.scrub(`the key is ${form} ok`);
      expect(scrubbed).toContain("<redacted:attesterKey>");
      expect(redactor.contains(scrubbed)).toBe(false);
    }
  });

  it("leaves 32-byte hashes alone, because ledgerRoot and sessionId must be auditable", () => {
    const redactor = new Redactor().register(FAKE_KEY, "attesterKey");
    const ledgerRoot = "0xf3c9a1b25d0e47ab8fa2c6d5e0917483bb2f6c1d9e0a5473cc81f2b6d4a90e17";
    expect(redactor.scrub(`ledgerRoot ${ledgerRoot}`)).toContain(ledgerRoot);
  });

  it("does not register a needle short enough to redact half the log", () => {
    const redactor = new Redactor().register("0x1234", "tiny");
    expect(redactor.scrub("value 0x1234 here")).toBe("value 0x1234 here");
  });
});

describe("createLogger", () => {
  it("never emits a registered key, however deeply it is buried", () => {
    const { lines, sink } = capture();
    const redactor = new Redactor().register(FAKE_KEY, "attesterKey").register(FAKE_RPC, "rpcUrl");
    const logger = createLogger({ redactor, sink, base: { service: "@nuvem/keeper" } });

    logger.info("plain field", { key: FAKE_KEY });
    logger.info("nested", { a: { b: { c: [FAKE_KEY] } } });
    logger.error("in a message", { detail: `signing with ${FAKE_KEY} failed` });
    logger.error("in an error", { error: new Error(`bad key ${FAKE_KEY}`) });
    logger.error("in a url", { error: new Error(`HTTP 429 from ${FAKE_RPC}`) });

    expect(lines).toHaveLength(5);
    for (const line of lines) {
      expect(line).not.toContain(FAKE_KEY);
      expect(line).not.toContain(FAKE_KEY.slice(2));
      expect(line).not.toContain("4c0883a69102937d");
      expect(line).not.toContain("AbCdEf1234567890SecretKey");
      expect(line).toContain("<redacted:");
    }
  });

  it("redacts a key hidden in an error stack", () => {
    const { lines, sink } = capture();
    const redactor = new Redactor().register(FAKE_KEY, "attesterKey");
    const logger = createLogger({ redactor, sink });

    const error = new Error("transport failure");
    error.stack = `Error: transport failure\n    at sign (${FAKE_KEY})\n    at tick`;
    logger.error("boom", { error });

    expect(lines[0]).not.toContain("4c0883a6");
    expect(lines[0]).toContain("<redacted:attesterKey>");
  });

  it("drops viem's URL and Request body metadata lines wholesale", () => {
    const { lines, sink } = capture();
    const logger = createLogger({ redactor: new Redactor(), sink });
    const error = new Error(
      ["HTTP request failed.", "", `URL: ${FAKE_RPC}`, 'Request body: {"method":"eth_call"}'].join("\n"),
    );
    logger.error("rpc", { error });
    // Even with NOTHING registered, the endpoint does not survive: the metadata
    // filter is an independent mechanism from substitution, on purpose.
    expect(lines[0]).not.toContain("alchemy.com");
    expect(lines[0]).not.toContain("Request body");
  });

  it("suppresses the whole line rather than emitting a key that survived scrubbing", () => {
    const { lines, sink } = capture();
    // A redactor whose substitution has been sabotaged: it reports the secret as
    // present but replaces nothing. This is the mechanism-3 backstop.
    const broken = new Redactor();
    broken.register(FAKE_KEY, "attesterKey");
    const sabotaged = Object.assign(Object.create(Object.getPrototypeOf(broken)), broken) as Redactor;
    Object.defineProperty(sabotaged, "scrub", { value: (text: string) => text });
    Object.defineProperty(sabotaged, "contains", { value: (text: string) => text.includes(FAKE_KEY) });

    const logger = createLogger({ redactor: sabotaged, sink });
    logger.info("leak attempt", { key: FAKE_KEY });

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("4c0883a6");
    expect(lines[0]).toContain("redaction failed");
    expect(lines[0]).toContain("leak attempt");
  });

  it("suppresses a key split by a separator, which mechanism 3 could not previously see", () => {
    // THE CASE MECHANISM 3'S OWN COMMENT CITES, and which it used to miss: the
    // assertion tested the identical needle set `scrub` had just substituted, so it
    // could only fire if `scrub` was broken. A key logged with a space in the
    // middle was emitted whole, `contains` returned false, and the key was
    // recoverable by stripping the non-hex characters. `contains` now does exactly
    // that stripping itself.
    const { lines, sink } = capture();
    const redactor = new Redactor().register(FAKE_KEY, "attesterKey");
    const logger = createLogger({ redactor, sink });

    logger.info("split key", { key: `${FAKE_KEY.slice(0, 20)} ${FAKE_KEY.slice(20)}` });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("redaction failed");
    expect(lines[0]).not.toContain("4c0883a6");
    // And the key is not reassemblable from what did get emitted.
    expect((lines[0] ?? "").replace(/[^0-9a-fA-F]/g, "")).not.toContain(FAKE_KEY.slice(2));
  });

  it("refuses to serialize bytes, which would carry a key past every needle", () => {
    // A Buffer has a toJSON, so it used to serialize as
    // {"type":"Buffer","data":[76,8,131,…]} — the key's bytes in a form no
    // registered needle matches and `contains` cannot see.
    const { lines, sink } = capture();
    const redactor = new Redactor().register(FAKE_KEY, "attesterKey");
    const logger = createLogger({ redactor, sink });

    logger.info("bytes", { key: Buffer.from(FAKE_KEY.slice(2), "hex") });

    expect(lines[0]).toContain("<binary:32 bytes>");
    expect(lines[0]).not.toContain('"type":"Buffer"');
    expect(lines[0]).not.toContain("76,8,131");
  });

  it("serializes bigints rather than throwing, so a log line never silences a tick", () => {
    const { lines, sink } = capture();
    const logger = createLogger({ redactor: new Redactor(), sink });
    logger.info("numbers", { contribution: 403370889498747n });
    expect(lines[0]).toContain('"contribution":"403370889498747"');
  });

  it("stamps base fields onto every line and merges child fields", () => {
    const { lines, sink } = capture();
    const logger = createLogger({ redactor: new Redactor(), sink, base: { dryRun: true, mode: "dry-run" } });
    logger.child({ tickId: "tick-1" }).info("hello");
    const parsed = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(parsed.dryRun).toBe(true);
    expect(parsed.mode).toBe("dry-run");
    expect(parsed.tickId).toBe("tick-1");
  });
});

/**
 * The sanitizer for the two exits that never touch a logger: `GET /status` and
 * `keeper status`. Both used to carry a raw viem message, whose second line is
 * `URL: <endpoint>` — and the endpoint carries an Alchemy API key.
 */
describe("summarizeUpstreamError", () => {
  const HOST = "robinhood-mainnet.g.alchemy.com";
  const viemError = (): Error => {
    const error = new Error(
      [
        "HTTP request failed.",
        "",
        `URL: ${FAKE_RPC}`,
        'Request body: {"method":"eth_chainId","params":[]}',
        "",
        "Details: fetch failed",
        "Version: viem@2.55.8",
      ].join("\n"),
    );
    error.name = "HttpRequestError";
    return error;
  };

  it("names the error and keeps neither the key nor the host", () => {
    const redactor = new Redactor().register(FAKE_RPC, "rpcUrl");
    const summary = summarizeUpstreamError(viemError(), { redactor, rpcHost: HOST });
    expect(summary).toBe("HttpRequestError: HTTP request failed.");
    expect(summary).not.toContain("AbCdEf1234567890SecretKey");
    expect(summary).not.toContain("alchemy.com");
  });

  it("removes the endpoint even when NOTHING is registered, because the two mechanisms are independent", () => {
    // Dropping viem's `URL:` line depends on its formatting, which is not a stable
    // contract; substituting the host cannot quietly stop working. Either alone is
    // enough today, which is the point of having both.
    const summary = summarizeUpstreamError(viemError(), { redactor: new Redactor(), rpcHost: HOST });
    expect(summary).not.toContain("AbCdEf1234567890SecretKey");
    expect(summary).not.toContain("alchemy.com");
  });

  it("takes the host out of a message that carries it without viem's formatting", () => {
    const summary = summarizeUpstreamError(new Error(`getaddrinfo ENOTFOUND ${HOST}`), {
      redactor: new Redactor(),
      rpcHost: HOST,
    });
    expect(summary).toContain("<upstream RPC>");
    expect(summary).not.toContain("alchemy.com");
  });

  it("keeps the revert name, which is the whole reason an operator reads this field", () => {
    const error = new Error(
      [
        'The contract function "settle" reverted.',
        "",
        "Error: NonProgressiveBlockRange(uint64 previousEndBlock, uint64 startBlock, uint64 endBlock)",
        "                               (25635384, 25635381, 25635384)",
        "",
        `URL: ${FAKE_RPC}`,
        "Version: viem@2.55.8",
      ].join("\n"),
    );
    error.name = "ContractFunctionRevertedError";
    const summary = summarizeUpstreamError(error, { redactor: new Redactor(), rpcHost: HOST, take: 2 });
    expect(summary).toContain("NonProgressiveBlockRange");
    expect(summary).not.toContain("alchemy.com");
  });

  it("withholds the detail entirely rather than returning something that still contains a secret", () => {
    const honest = new Redactor().register(FAKE_KEY, "attesterKey");
    const sabotaged = Object.assign(Object.create(Object.getPrototypeOf(honest)), honest) as Redactor;
    Object.defineProperty(sabotaged, "scrub", { value: (text: string) => text });
    Object.defineProperty(sabotaged, "contains", { value: (text: string) => text.includes(FAKE_KEY) });
    const summary = summarizeUpstreamError(new Error(`signing failed with ${FAKE_KEY}`), {
      redactor: sabotaged,
      rpcHost: HOST,
    });
    expect(summary).toBe("Error: <detail withheld: redaction tripwire>");
    expect(summary).not.toContain("4c0883a6");
  });

  it("is bounded, so a megabyte of upstream prose cannot become a status payload", () => {
    const summary = summarizeUpstreamError(new Error("x".repeat(10_000)), {
      redactor: new Redactor(),
      rpcHost: HOST,
    });
    expect(summary.length).toBeLessThanOrEqual(200);
  });

  it("substitutes the bare hostname as well as host:port", () => {
    expect(redactUpstreamHost("connect ECONNREFUSED example.test:8545", "example.test:8545")).not.toContain(
      "example.test",
    );
    expect(redactUpstreamHost("dial example.test failed", "example.test:8545")).not.toContain("example.test");
  });

  it("does nothing with a host too short to be one, rather than redacting half the text", () => {
    expect(redactUpstreamHost("a totally ordinary message", "")).toBe("a totally ordinary message");
    expect(redactUpstreamHost("abc def abc", "abc")).toBe("abc def abc");
  });
});

describe("createLogger, continued", () => {
  it("still stamps base fields (regression guard for the block split above)", () => {
    const { lines, sink } = capture();
    const logger = createLogger({ redactor: new Redactor(), sink, base: { dryRun: true, mode: "dry-run" } });
    logger.child({ tickId: "tick-1" }).info("hello");
    const parsed = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(parsed.dryRun).toBe(true);
    expect(parsed.mode).toBe("dry-run");
    expect(parsed.tickId).toBe("tick-1");
  });
});
