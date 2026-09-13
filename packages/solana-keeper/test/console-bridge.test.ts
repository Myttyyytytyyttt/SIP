// console.log(keypair) cannot put a key in the log.
//
// The bridge used to call util.format on the raw arguments, and util.inspect
// prints a Uint8Array as padded decimal columns before the logger's byte guard
// ever runs. Those decimals matched no registered form of the key, so a library
// that printed a signer would have shipped its 64 bytes. This installs the real
// bridge over a registered throwaway key, prints every shape that accident takes,
// and reads what actually reached stderr. It also drives the second net, the
// byte-run tripwire in keeper-log.ts, with a key the redactor was never told about.

import { inspect } from "node:util";
import * as anchor from "@coral-xyz/anchor";
import { Keypair } from "@solana/web3.js";
import { Secret } from "@sip/worker/log";
import { describe, expect, it } from "vitest";
// Importing the bridge installs it on this file's console.
import { sanitizeConsoleArg } from "../src/console-bridge.js";
import { BROADCAST_ACK, loadConfig } from "../src/config.js";
import { SIP_PROGRAM_ID } from "../src/idl.js";
import { BYTE_RUN, SERVICE, createKeeperLogger } from "../src/keeper-log.js";

const keypair = Keypair.generate();
const secret = Array.from(keypair.secretKey);
// Armed into the shared redactor, which is the one the bridge's logger scrubs with.
const config = loadConfig({
  SIP_SOLANA_RPC_URLS: "https://rpc.example.test/",
  SIP_SOLANA_PROGRAM_ID: SIP_PROGRAM_ID,
  SIP_SOLANA_BROADCAST: "1",
  SIP_SOLANA_ALLOW_BROADCAST: BROADCAST_ACK,
  SIP_SOLANA_SETTLE_KEY: JSON.stringify(secret),
});

const REGISTERED_FORMS = [
  JSON.stringify(secret),
  secret.join(","),
  Buffer.from(keypair.secretKey).toString("hex"),
  Buffer.from(keypair.secretKey.subarray(0, 32)).toString("hex"),
  anchor.utils.bytes.bs58.encode(keypair.secretKey),
];

/** True when `bytes` appear in order as consecutive integers anywhere in `line`, whatever separates them. */
function holdsRun(line: string, bytes: readonly number[]): boolean {
  const numbers = (line.match(/\d+/g) ?? []).map(Number);
  outer: for (let start = 0; start + bytes.length <= numbers.length; start++) {
    for (let offset = 0; offset < bytes.length; offset++) {
      if (numbers[start + offset] !== bytes[offset]) continue outer;
    }
    return true;
  }
  return false;
}

function printed(run: () => void): { stderr: string[]; stdout: string[] } {
  const err: string[] = [];
  const out: string[] = [];
  const originalErr = process.stderr.write;
  const originalOut = process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => err.push(String(chunk)) > 0) as typeof process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => out.push(String(chunk)) > 0) as typeof process.stdout.write;
  try {
    run();
  } finally {
    process.stderr.write = originalErr;
    process.stdout.write = originalOut;
  }
  const lines = (chunks: string[]): string[] => chunks.join("").split("\n").filter((line) => line !== "");
  return { stderr: lines(err), stdout: lines(out) };
}

describe("library console output through the bridge", () => {
  it("prints a Keypair and its bytes, alone or nested, as lengths and never as the key", () => {
    const { stderr, stdout } = printed(() => {
      console.log(keypair);
      console.log(keypair.secretKey);
      console.log("%o", keypair);
      console.error("signer", keypair);
      console.error({ signers: [keypair] });
      console.error("%o", { signers: [keypair] });
      console.warn(new Map([[keypair.publicKey.toBase58(), keypair]]));
      console.error(Object.assign(new Error("send failed"), { signer: keypair }));
      console.debug(Buffer.from(keypair.secretKey));
      console.info(keypair.secretKey.buffer);
    });

    expect(stdout, "the bridge writes to stderr, never stdout").toEqual([]);
    expect(stderr).toHaveLength(10);
    for (const line of stderr) {
      expect(holdsRun(line, secret)).toBe(false);
      expect(holdsRun(line, secret.slice(0, 32))).toBe(false);
      for (const form of REGISTERED_FORMS) expect(line).not.toContain(form);
      expect(JSON.parse(line)).toMatchObject({ service: SERVICE, event: "console" });
    }
    // util.inspect's default depth collapses `{ signers: [keypair] }` to
    // `[Object]`, which prints no bytes either; every other line, %o included,
    // reaches the bytes and shows the walk's marker in their place.
    expect(stderr.filter((line) => /<binary:(32|64) bytes>/.test(line))).toHaveLength(9);
    expect(stderr.join("\n")).toContain("send failed");
  });

  it("still formats an ordinary line the way console would", () => {
    const { stderr } = printed(() => console.log("hello %s, %d wallets", "operator", 3));
    expect(JSON.parse(stderr[0]!)).toMatchObject({ service: SERVICE, level: "info", event: "console", text: "hello operator, 3 wallets" });
  });

  it("drops a line whose bytes arrive as plain numbers, which no walk can recognise as a key", () => {
    const { stderr } = printed(() => console.log(Array.from(Keypair.generate().secretKey)));
    expect(stderr).toHaveLength(1);
    expect(JSON.parse(stderr[0]!)).toMatchObject({ event: "log.suppressed", suppressedEvent: "console", service: SERVICE });
  });
});

describe("the byte-run net under the keeper's logger", () => {
  it("drops a line carrying an unregistered key's bytes in any decimal form", () => {
    const other = Array.from(Keypair.generate().secretKey);
    const lines: string[] = [];
    const log = createKeeperLogger({ sink: (line) => lines.push(line) });
    log.info("oops", { list: other });
    log.info("oops", { text: other.join(", ") });
    log.info("oops", { text: inspect(Uint8Array.from(other)) });
    log.info("oops", { seed: other.slice(0, 32) });

    expect(lines).toHaveLength(4);
    for (const line of lines) {
      expect(JSON.parse(line)).toMatchObject({ event: "log.suppressed", suppressedEvent: "oops", service: SERVICE });
      expect(holdsRun(line, other.slice(0, 32))).toBe(false);
    }
  });

  it("leaves the lines a keeper actually writes alone", () => {
    const lines: string[] = [];
    const log = createKeeperLogger({ sink: (line) => lines.push(line) });
    log.info("sweep", { links: 3, slots: [300_000_600, 300_000_900], at: new Date().toISOString() });
    log.error("settle failed", { detail: 'settle confirmed WITH an on-chain error: {"InstructionError":[1,{"Custom":6012}]}' });
    // The net's threshold is a seed's length: 31 values in a row is not yet a key.
    log.info("short", { values: Array.from({ length: 31 }, (_, index) => index * 7) });

    expect(lines.map((line) => (JSON.parse(line) as { event: string }).event)).toEqual(["sweep", "settle failed", "short"]);
    expect(BYTE_RUN.test(Array.from({ length: 32 }, (_, index) => index).join(","))).toBe(true);
    expect(BYTE_RUN.test("1234, 256, 999, 300_000_600")).toBe(false);
  });
});

describe("sanitizeConsoleArg", () => {
  it("replaces bytes at any depth and keeps what already describes itself", () => {
    expect(sanitizeConsoleArg(keypair)).toEqual({ _keypair: { publicKey: "<binary:32 bytes>", secretKey: "<binary:64 bytes>" } });

    const labelled = new Secret("a-secret-value-long-enough", "label");
    expect(sanitizeConsoleArg(labelled)).toBe(labelled);
    expect(sanitizeConsoleArg(config.signing!.settleKey)).toBe(config.signing!.settleKey);
    expect(sanitizeConsoleArg(config)).toBe(config);

    const loop: Record<string, unknown> = { name: "loop" };
    loop["self"] = loop;
    expect(sanitizeConsoleArg(loop)).toEqual({ name: "loop", self: "<circular>" });
    expect(sanitizeConsoleArg(keypair.publicKey)).toBe(keypair.publicKey.toBase58());
  });
});
