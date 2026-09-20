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

import { generateKeyPairSync } from "node:crypto";
import { inspect } from "node:util";
import * as anchor from "@coral-xyz/anchor";
import { Keypair } from "@solana/web3.js";
import { Redactor } from "@sip/solana-log";
import { describe, expect, it } from "vitest";
import { BROADCAST_ACK, loadConfig, registerPrivyAuthorizationKey } from "../src/config.js";
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

// THE SHAPES THE KEY IS BLESSED IN ARE THE SHAPES IT MUST BE REDACTED IN.
// derivePrivyPublicKey deliberately accepts a value carrying the wallet-api:
// prefix, surrounding quotes or 64-column wrapping, and the runbook tells the
// owner those pastes are fine. The needles used to be the raw value and its
// wallet-auth:-stripped form alone, so for those three the CANONICAL key — the
// string a library or a `detail` field would echo — was not a needle at all,
// and the tripwire could not catch it either: Redactor.contains reassembles hex
// needles only, never base64. Both last-resort nets were off for exactly the
// configurations the runbook recommends.
describe("a Privy authorization key pasted in any shape the check blesses", () => {
  // Generated per run, registered with nobody, used against nothing.
  const canonical = Buffer.from(generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "der", type: "pkcs8" })).toString(
    "base64",
  );
  const shapes: Readonly<Record<string, string>> = {
    "as Privy shows it": `wallet-auth:${canonical}`,
    "the bare key": canonical,
    "the wallet-api: prefix": `wallet-api:${canonical}`,
    "double quotes from a paste": `"${canonical}"`,
    "wrapped at 64 columns": canonical.replace(/(.{64})/g, "$1\n"),
    "surrounding whitespace": `  ${canonical}\n`,
  };

  for (const [what, value] of Object.entries(shapes)) {
    it(`is scrubbed and tripwired when Railway holds it ${what}`, () => {
      const redactor = new Redactor();
      loadConfig(
        {
          SIP_SOLANA_RPC_URLS: RPC,
          SIP_SOLANA_PROGRAM_ID: SIP_PROGRAM_ID,
          SIP_SOLANA_BROADCAST: "1",
          SIP_SOLANA_ALLOW_BROADCAST: BROADCAST_ACK,
          SIP_SOLANA_SETTLE_KEY: JSON.stringify(bytes),
          SIP_SOLANA_PRIVY_APP_ID: "app-id",
          SIP_SOLANA_PRIVY_APP_SECRET: "privy-app-secret-value-never-logged",
          SIP_SOLANA_PRIVY_AUTHORIZATION_KEY: value,
        },
        redactor,
      );
      const lines: string[] = [];
      const log = createKeeperLogger({ redactor, sink: (line) => lines.push(line) });

      // The single console.log this module's doctrine says the redactor exists
      // to survive: the key inside prose, in the form the SDK signs with.
      log.error("privy refused", { detail: `401 while signing with ${canonical} — check the key` });
      log.warn("console", { text: `wallet-auth:${canonical}` });

      expect(lines).toHaveLength(2);
      for (const line of lines) expect(line).not.toContain(canonical);
      expect(lines.join("\n")).toContain("<redacted:privyAuthorizationKey>");
      // MECHANISM 3, INDEPENDENTLY: the tripwire sees the key even unscrubbed.
      expect(redactor.contains(`401 while signing with ${canonical}`)).toBe(true);
    });
  }

  // The prefixed form is registered too, so the longest needle wins and no line
  // is left holding a bare "wallet-auth:" where a key used to be.
  it("replaces the prefix along with the key", () => {
    const redactor = new Redactor();
    registerPrivyAuthorizationKey(redactor, `wallet-auth:${canonical}`);
    expect(redactor.scrub(`key=wallet-auth:${canonical}!`)).toBe("key=<redacted:privyAuthorizationKey>!");
  });
});

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
