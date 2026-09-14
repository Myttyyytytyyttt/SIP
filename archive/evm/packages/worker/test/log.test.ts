// The redacting logger, tested against a real-looking key.
//
// DESIGN.md §0.6 is "no secrets in logs: any 64-hex string is redacted before
// it reaches a sink". These tests use a key of exactly the right shape (0x + 64
// hex) so a regression in the length heuristics, the case folding, the
// substitution order or the shape mask fails here rather than in production.

import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Redactor,
  Secret,
  createLogger,
  hex64Fingerprint,
  sharedRedactor,
  silentLogger,
  stripUpstreamMetadata,
  summarizeUpstreamError,
} from "../src/log.js";

/** Shaped exactly like a real key. Never used to sign anything. */
const FAKE_KEY = "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";
const FAKE_RPC = "https://robinhood-mainnet.g.alchemy.com/v2/AbCdEf1234567890SecretKey";
/** Shaped like a tx hash or a batchRoot: never registered, so only the mask can cover it. */
const A_HASH = "0xf3c9a1b25d0e47ab8fa2c6d5e0917483bb2f6c1d9e0a5473cc81f2b6d4a90e17";

function capture(): { lines: string[]; sink: (line: string) => void } {
  const lines: string[] = [];
  return { lines, sink: (line) => lines.push(line) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Secret", () => {
  it("does not serialize its value", () => {
    const secret = new Secret(FAKE_KEY, "attesterKey");
    expect(JSON.stringify({ key: secret })).toBe('{"key":"<redacted:attesterKey>"}');
    expect(String(secret)).toBe("<redacted:attesterKey>");
    expect(`${secret}`).toBe("<redacted:attesterKey>");
    expect(inspect(secret)).toBe("<redacted:attesterKey>");
    expect(secret.length).toBe(66);
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

describe("Redactor: registered needles", () => {
  it("redacts a key in both cases and with or without the 0x prefix, under its label", () => {
    const redactor = new Redactor().register(FAKE_KEY, "attesterKey");
    for (const form of [FAKE_KEY, FAKE_KEY.toUpperCase(), FAKE_KEY.slice(2), FAKE_KEY.slice(2).toUpperCase()]) {
      const scrubbed = redactor.scrub(`the key is ${form} ok`);
      expect(scrubbed).toBe("the key is <redacted:attesterKey> ok");
      expect(redactor.contains(scrubbed)).toBe(false);
    }
  });

  it("labels a registered key rather than fingerprinting it, so the operator knows what to rotate", () => {
    const redactor = new Redactor().register(FAKE_KEY, "possible-key:SIP_VAULT_FACTORY");
    const scrubbed = redactor.scrub(FAKE_KEY);
    expect(scrubbed).toBe("<redacted:possible-key:SIP_VAULT_FACTORY>");
    expect(scrubbed).not.toContain("hex64");
  });

  it("does not register a needle short enough to redact half the log", () => {
    const redactor = new Redactor().register("0x1234", "tiny");
    expect(redactor.size).toBe(0);
    expect(redactor.scrub("value 0x1234 here")).toBe("value 0x1234 here");
  });

  it("registers a Secret by its own label and a URL in every case", () => {
    const redactor = new Redactor().register(new Secret(FAKE_RPC, "rpcUrl"));
    expect(redactor.scrub(`GET ${FAKE_RPC}`)).toBe("GET <redacted:rpcUrl>");
    expect(redactor.scrub(`GET ${FAKE_RPC.toUpperCase()}`)).toBe("GET <redacted:rpcUrl>");
  });
});

describe("Redactor: the 64-hex shape mask (DESIGN.md §0.6)", () => {
  it("masks an unregistered 64-hex value in every spelling with one non-reversible fingerprint", () => {
    const redactor = new Redactor();
    const fingerprint = hex64Fingerprint(A_HASH);
    expect(fingerprint).toMatch(/^[0-9a-f]{8}$/);
    for (const form of [A_HASH, A_HASH.toUpperCase(), A_HASH.slice(2), A_HASH.slice(2).toUpperCase()]) {
      const scrubbed = redactor.scrub(`root ${form} closed`);
      expect(scrubbed).toBe(`root <redacted:hex64:${fingerprint}> closed`);
      expect(scrubbed).not.toContain("f3c9a1b2");
      expect(redactor.contains(scrubbed)).toBe(false);
    }
  });

  it("masks inside a JSON line, where quotes are the boundaries", () => {
    const line = JSON.stringify({ event: "pull.sent", txHash: A_HASH, nested: { key: FAKE_KEY.slice(2) } });
    const scrubbed = new Redactor().scrub(line);
    expect(scrubbed).not.toContain("f3c9a1b2");
    expect(scrubbed).not.toContain("4c0883a6");
    expect(JSON.parse(scrubbed)).toMatchObject({ event: "pull.sent" });
  });

  it("masks exactly 64, leaving signatures, calldata and shorter hashes readable", () => {
    const redactor = new Redactor();
    const signature = `0x${"ab".repeat(65)}`; // 130 hex: r, s, v
    const sixtyThree = `0x${"c".repeat(63)}`;
    const sixtyFive = `0x${"d".repeat(65)}`;
    const selector = "0x9ea6bfbe";
    for (const text of [signature, sixtyThree, sixtyFive, selector]) {
      expect(redactor.scrub(`x ${text} y`)).toBe(`x ${text} y`);
    }
  });

  it("masks several values in one line independently", () => {
    const other = `0x${"1".repeat(64)}`;
    const scrubbed = new Redactor().scrub(`${A_HASH} and ${other}`);
    expect(scrubbed).toBe(`<redacted:hex64:${hex64Fingerprint(A_HASH)}> and <redacted:hex64:${hex64Fingerprint(other)}>`);
  });
});

describe("Redactor.contains, the independent check", () => {
  it("sees a raw 64-hex run even with nothing registered", () => {
    expect(new Redactor().contains(`leak ${A_HASH}`)).toBe(true);
    expect(new Redactor().contains(`leak ${A_HASH.slice(2)}`)).toBe(true);
    expect(new Redactor().contains("a totally ordinary message")).toBe(false);
  });

  it("sees a registered key that was split by a separator", () => {
    const redactor = new Redactor().register(FAKE_KEY, "attesterKey");
    expect(redactor.contains(`${FAKE_KEY.slice(0, 20)} ${FAKE_KEY.slice(20)}`)).toBe(true);
    expect(redactor.contains(`${FAKE_KEY.slice(0, 40)}\\n${FAKE_KEY.slice(40)}`)).toBe(true);
  });
});

describe("createLogger", () => {
  it("never emits a registered key, however deeply it is buried", () => {
    const { lines, sink } = capture();
    const redactor = new Redactor().register(FAKE_KEY, "attesterKey").register(FAKE_RPC, "rpcUrl");
    const logger = createLogger({ redactor, sink, json: true, base: { service: "@sip/worker" } });

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
      expect(JSON.parse(line)).toMatchObject({ service: "@sip/worker" });
    }
  });

  it("masks an unregistered 64-hex value on the way to the sink", () => {
    const { lines, sink } = capture();
    createLogger({ redactor: new Redactor(), sink, json: true }).info("window.closed", { batchRoot: A_HASH });
    expect(lines[0]).not.toContain("f3c9a1b2");
    expect(lines[0]).toContain(`<redacted:hex64:${hex64Fingerprint(A_HASH)}>`);
  });

  it("writes one JSON object per line with ts, level and event first", () => {
    const { lines, sink } = capture();
    const now = () => new Date("2026-09-07T12:00:00.000Z");
    createLogger({ redactor: new Redactor(), sink, json: true, now }).warn("tick.slow", { ms: 1234 });
    expect(lines[0]).toBe('{"ts":"2026-09-07T12:00:00.000Z","level":"warn","event":"tick.slow","ms":1234}');
  });

  it("redacts a key hidden in an error stack", () => {
    const { lines, sink } = capture();
    const redactor = new Redactor().register(FAKE_KEY, "attesterKey");
    const logger = createLogger({ redactor, sink, json: true });
    const error = new Error("transport failure");
    error.stack = `Error: transport failure\n    at sign (${FAKE_KEY})\n    at tick`;
    logger.error("boom", { error });
    expect(lines[0]).not.toContain("4c0883a6");
    expect(lines[0]).toContain("<redacted:attesterKey>");
  });

  it("drops viem's URL and Request body metadata lines wholesale", () => {
    const { lines, sink } = capture();
    const logger = createLogger({ redactor: new Redactor(), sink, json: true });
    const error = new Error(
      ["HTTP request failed.", "", `URL: ${FAKE_RPC}`, 'Request body: {"method":"eth_call"}'].join("\n"),
    );
    logger.error("rpc", { error });
    // Even with NOTHING registered, the endpoint does not survive: the metadata
    // filter is an independent mechanism from substitution, on purpose.
    expect(lines[0]).not.toContain("alchemy.com");
    expect(lines[0]).not.toContain("Request body");
    expect(lines[0]).toContain("HTTP request failed.");
  });

  it("suppresses the whole line rather than emitting a key that survived scrubbing", () => {
    const { lines, sink } = capture();
    // A redactor whose substitution has been sabotaged: it reports the secret as
    // present but replaces nothing. This is the mechanism-3 backstop.
    const broken = new Redactor();
    broken.register(FAKE_KEY, "attesterKey");
    const sabotaged = Object.assign(Object.create(Object.getPrototypeOf(broken) as object), broken) as Redactor;
    Object.defineProperty(sabotaged, "scrub", { value: (text: string) => text });
    Object.defineProperty(sabotaged, "contains", { value: (text: string) => text.includes(FAKE_KEY) });

    const logger = createLogger({ redactor: sabotaged, sink, json: true });
    logger.info("leak attempt", { key: FAKE_KEY });

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("4c0883a6");
    expect(lines[0]).toContain("redaction failed");
    expect(lines[0]).toContain("leak attempt");
  });

  it("suppresses a registered key split by a separator, which no substitution can catch", () => {
    const { lines, sink } = capture();
    const redactor = new Redactor().register(FAKE_KEY, "attesterKey");
    createLogger({ redactor, sink, json: true }).info("split key", { key: `${FAKE_KEY.slice(0, 20)} ${FAKE_KEY.slice(20)}` });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("redaction failed");
    expect(lines[0]).not.toContain("4c0883a6");
    // And the key is not reassemblable from what did get emitted.
    expect((lines[0] ?? "").replace(/[^0-9a-fA-F]/g, "")).not.toContain(FAKE_KEY.slice(2));
  });

  it("refuses to serialize bytes, which would carry a key past every needle", () => {
    const { lines, sink } = capture();
    const redactor = new Redactor().register(FAKE_KEY, "attesterKey");
    createLogger({ redactor, sink, json: true }).info("bytes", { key: Buffer.from(FAKE_KEY.slice(2), "hex") });
    expect(lines[0]).toContain("<binary:32 bytes>");
    expect(lines[0]).not.toContain('"type":"Buffer"');
    expect(lines[0]).not.toContain("76,8,131");
  });

  it("serializes bigints and Secrets rather than throwing, so a log line never silences a tick", () => {
    const { lines, sink } = capture();
    createLogger({ redactor: new Redactor(), sink, json: true }).info("numbers", {
      contribution: 403370889498747n,
      key: new Secret(FAKE_KEY, "attesterKey"),
    });
    expect(lines[0]).toContain('"contribution":"403370889498747"');
    expect(lines[0]).toContain('"key":"<redacted:attesterKey>"');
  });

  it("survives a circular structure instead of dropping the line", () => {
    const { lines, sink } = capture();
    const loop: Record<string, unknown> = { name: "loop" };
    loop.self = loop;
    createLogger({ redactor: new Redactor(), sink, json: true }).info("cycle", { loop });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"event":"cycle"');
    expect(lines[0]).toContain("<depth limit>");
  });

  it("honours minLevel", () => {
    const { lines, sink } = capture();
    const logger = createLogger({ redactor: new Redactor(), sink, json: true, minLevel: "warn" });
    logger.info("quiet");
    logger.warn("loud");
    logger.error("louder");
    expect(lines.map((line) => (JSON.parse(line) as { event: string }).event)).toEqual(["loud", "louder"]);
  });

  it("renders a human line when json is false, still scrubbed", () => {
    const { lines, sink } = capture();
    const now = () => new Date("2026-09-07T12:00:00.000Z");
    const redactor = new Redactor().register(FAKE_KEY, "attesterKey");
    createLogger({ redactor, sink, json: false, now, base: { mode: "dry-run" } }).info("worker.start", {
      chainId: 4663,
      key: FAKE_KEY,
      note: "two words",
    });
    expect(lines[0]).toBe(
      '2026-09-07T12:00:00.000Z INFO  worker.start mode=dry-run chainId=4663 key=<redacted:attesterKey> note="two words"',
    );
  });

  it("uses the shared redactor by default, which is where loadConfig registers what it reads", () => {
    const { lines, sink } = capture();
    const needle = "https://rpc.example.test/v2/SharedNeedleForTheDefaultLogger";
    sharedRedactor.register(needle, "rpcUrl:shared");
    createLogger({ sink, json: true }).error("rpc", { url: needle });
    expect(lines[0]).not.toContain("SharedNeedleForTheDefaultLogger");
    expect(lines[0]).toContain("<redacted:rpcUrl:shared>");
  });

  it("defaults to stdout, JSON when stdout is not a TTY and the human form when it is", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stdout = process.stdout as { isTTY?: boolean };
    const hadTTY = Object.prototype.hasOwnProperty.call(stdout, "isTTY");
    const original = stdout.isTTY;
    try {
      stdout.isTTY = false;
      createLogger({ redactor: new Redactor() }).info("piped");
      stdout.isTTY = true;
      createLogger({ redactor: new Redactor() }).info("terminal");
    } finally {
      if (hadTTY) stdout.isTTY = original;
      else delete stdout.isTTY;
    }
    const written = write.mock.calls.map((call) => String(call[0]));
    expect(written).toHaveLength(2);
    expect(written[0]).toMatch(/^\{"ts":.*"event":"piped"\}\n$/);
    expect(written[1]).toMatch(/^\S+ INFO {2}terminal\n$/);
  });

  it("silentLogger emits nothing", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const logger = silentLogger();
    logger.info("a");
    logger.warn("b");
    logger.error("c", { key: FAKE_KEY });
    expect(write).not.toHaveBeenCalled();
  });
});

describe("stripUpstreamMetadata", () => {
  it("leaves a single line alone and drops viem's metadata lines from a blob", () => {
    expect(stripUpstreamMetadata("plain")).toBe("plain");
    const blob = ["Boom.", `URL: ${FAKE_RPC}`, "Request body: {}", "Docs: https://viem.sh", "Version: viem@2.55.8", "kept"].join("\n");
    expect(stripUpstreamMetadata(blob)).toBe("Boom.\nkept");
  });
});

/** The sanitizer for the exits that never touch a logger: a TickSummary or a ledger `detail`. */
describe("summarizeUpstreamError", () => {
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

  it("names the error and keeps neither the key nor the endpoint, even with nothing registered", () => {
    const summary = summarizeUpstreamError(viemError(), { redactor: new Redactor() });
    expect(summary).toBe("HttpRequestError: HTTP request failed.");
    expect(summary).not.toContain("AbCdEf1234567890SecretKey");
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
    const summary = summarizeUpstreamError(error, { redactor: new Redactor(), take: 2 });
    expect(summary).toContain("NonProgressiveBlockRange");
    expect(summary).not.toContain("alchemy.com");
  });

  it("masks a 64-hex value and withholds the detail entirely if a secret still survives", () => {
    expect(summarizeUpstreamError(new Error(`tx ${A_HASH} failed`), { redactor: new Redactor() })).toBe(
      `Error: tx <redacted:hex64:${hex64Fingerprint(A_HASH)}> failed`,
    );
    const honest = new Redactor().register(FAKE_KEY, "attesterKey");
    const sabotaged = Object.assign(Object.create(Object.getPrototypeOf(honest) as object), honest) as Redactor;
    Object.defineProperty(sabotaged, "scrub", { value: (text: string) => text });
    Object.defineProperty(sabotaged, "contains", { value: (text: string) => text.includes(FAKE_KEY) });
    const summary = summarizeUpstreamError(new Error(`signing failed with ${FAKE_KEY}`), { redactor: sabotaged });
    expect(summary).toBe("Error: <detail withheld: redaction tripwire>");
  });

  it("is bounded and copes with a non-Error", () => {
    expect(summarizeUpstreamError(new Error("x".repeat(10_000)), { redactor: new Redactor() }).length).toBeLessThanOrEqual(200);
    expect(summarizeUpstreamError("just a string", { redactor: new Redactor() })).toBe("string: just a string");
  });
});
