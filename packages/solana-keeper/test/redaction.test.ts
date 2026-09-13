// No endpoint key and no settle key in a line the keeper writes.
//
// The config registers every fixed form of both the moment it reads them; the
// logger scrubs against that set. This test goes through the real pair —
// loadConfig armed with a throwaway key, then the keeper's own logger — and
// throws every shape an accident takes at it: an upstream error quoting the
// endpoint, a derived websocket URL, the key as JSON, as the comma lists
// Array#join makes of it, as hex, as base58, the config object logged whole, and
// the padded decimal columns util.inspect prints a Uint8Array as. That last one
// is not a fixed string, so no registered needle matches it: keeper-log.ts's
// byte-run net drops the line instead (test/console-bridge.test.ts drives the
// console path that produces it).

import { inspect } from "node:util";
import * as anchor from "@coral-xyz/anchor";
import { Keypair } from "@solana/web3.js";
import { Redactor } from "@sip/worker/log";
import { describe, expect, it } from "vitest";
import { BROADCAST_ACK, loadConfig } from "../src/config.js";
import { SIP_PROGRAM_ID } from "../src/idl.js";
import { SERVICE, createChangeLog, createKeeperLogger } from "../src/keeper-log.js";

const keypair = Keypair.generate();
const bytes = Array.from(keypair.secretKey);
const RPC = "https://mainnet.helius-rpc.example.test/?api-key=HeliusKeyNeverLogged0002";

function armedKeeper(): { lines: string[]; log: ReturnType<typeof createKeeperLogger>; config: ReturnType<typeof loadConfig> } {
  const redactor = new Redactor();
  const config = loadConfig(
    {
      SIP_SOLANA_RPC_URLS: RPC,
      SIP_SOLANA_PROGRAM_ID: SIP_PROGRAM_ID,
      SIP_SOLANA_BROADCAST: "1",
      SIP_SOLANA_ALLOW_BROADCAST: BROADCAST_ACK,
      SIP_SOLANA_SETTLE_KEY: JSON.stringify(bytes),
    },
    redactor,
  );
  const lines: string[] = [];
  return { lines, log: createKeeperLogger({ redactor, sink: (line) => lines.push(line) }), config };
}

const FORMS = [
  RPC,
  "HeliusKeyNeverLogged0002",
  JSON.stringify(bytes),
  bytes.join(","),
  bytes.slice(0, 16).join(","),
  Buffer.from(keypair.secretKey).toString("hex"),
  Buffer.from(keypair.secretKey.subarray(0, 32)).toString("hex"),
  anchor.utils.bytes.bs58.encode(keypair.secretKey),
];

/** True when the seed's 32 bytes appear in order as consecutive integers, whatever separates them. */
function holdsSeed(line: string): boolean {
  const numbers = (line.match(/\d+/g) ?? []).map(Number);
  const seed = bytes.slice(0, 32);
  return numbers.some((_, start) => seed.every((byte, offset) => numbers[start + offset] === byte));
}

describe("a line through the keeper's logger", () => {
  it("never carries the registered endpoint or the settle key, in any form", () => {
    const { lines, log, config } = armedKeeper();
    log.error("sweep cycle failed", { error: new Error(`fetch failed for ${RPC}: 429 Too Many Requests`) });
    log.warn("console", { text: "ws error: connect wss://mainnet.helius-rpc.example.test/?api-key=HeliusKeyNeverLogged0002" });
    log.info("oops", { key: JSON.stringify(bytes), list: bytes.join(","), spaced: bytes.join(", ") });
    log.info("oops", { hex: Buffer.from(keypair.secretKey).toString("hex"), seed: Buffer.from(keypair.secretKey.subarray(0, 32)).toString("hex") });
    log.info("oops", { base58: anchor.utils.bytes.bs58.encode(keypair.secretKey) });
    log.info("boot", { config, signing: config.signing, settleKey: config.signing?.settleKey, url: config.rpcUrls[0] });
    log.warn("console", { text: inspect(keypair.secretKey) });
    createChangeLog(log).change("k", "settle failed", { detail: `every Solana endpoint refused (${RPC})` });

    expect(lines.length).toBeGreaterThanOrEqual(8);
    for (const line of lines) {
      for (const form of FORMS) expect(line).not.toContain(form);
      expect(holdsSeed(line)).toBe(false);
      expect(JSON.parse(line)).toMatchObject({ service: SERVICE });
    }
    const all = lines.join("\n");
    expect(all).toContain("<redacted:rpcUrl:0>");
    expect(all).toContain("<redacted:settleKey>");
    expect(all).toContain("log.suppressed");
    // The public key is not a secret, and an operator needs it.
    expect(all).toContain(keypair.publicKey.toBase58());
  });
});
