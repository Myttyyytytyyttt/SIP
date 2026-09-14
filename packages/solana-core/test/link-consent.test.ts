// The SIP_LINK_V1 consent bytes in the browser entry, pinned to the golden
// vector the program's own tests hold and to the program's TypeScript mirror.
// If any of them drifts by one byte, a wallet's consent stops verifying on chain
// and nobody can link; this fails first.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import * as programMirror from "@sip/solana-program/link-consent";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { base58Encode } from "../src/client/base58";
import { SIP_PROGRAM_ID, toHex } from "../src/client/idl";
import { LINK_CONSENT_DOMAIN, LINK_CONSENT_MESSAGE_LEN, linkConsentMessage } from "../src/client/link-consent";
import { deriveVaultPda } from "../src/server/pda";
import { keypair } from "./helpers";

const require = createRequire(import.meta.url);
const PROGRAM_DIR = dirname(require.resolve("@sip/solana-program/package.json"));
const PROGRAM_TEST = readFileSync(join(PROGRAM_DIR, "tests/link-consent-v1.ts"), "utf8");
const LINK_CONSENT_RS = readFileSync(join(PROGRAM_DIR, "programs/sip-vault/src/link_consent.rs"), "utf8");

/**
 * Copied from packages/solana-program/tests/link-consent-v1.ts, where it was
 * computed with Python from keys of all 1s, 2s, 3s and 4s — not by this code,
 * and not by either program mirror. The first test proves the copy is exact.
 */
const GOLDEN_V1_HEX =
  "ff5349505f4c494e4b5f56310101010101010101010101010101010101010101010101010101010101010101020202020202020202020202020202020202020202020202020202020202020203030303030303030303030303030303030303030303030303030303030303030404040404040404040404040404040404040404040404040404040404040404";

const filled = (byte: number): Uint8Array => new Uint8Array(32).fill(byte);

describe("the SIP_LINK_V1 consent", () => {
  it("is the golden vector the program's tests and link_consent.rs hold, byte for byte", () => {
    expect(PROGRAM_TEST).toContain(`"${GOLDEN_V1_HEX}"`);
    expect(LINK_CONSENT_RS).toContain(`"${GOLDEN_V1_HEX}"`);
    const fromBytes = linkConsentMessage({ programId: filled(1), wallet: filled(2), vault: filled(3), owner: filled(4) });
    expect(fromBytes).toHaveLength(LINK_CONSENT_MESSAGE_LEN);
    expect(fromBytes[0]).toBe(0xff);
    expect(toHex(fromBytes)).toBe(GOLDEN_V1_HEX);
    const fromBase58 = linkConsentMessage({
      programId: base58Encode(filled(1)),
      wallet: base58Encode(filled(2)),
      vault: base58Encode(filled(3)),
      owner: base58Encode(filled(4)),
    });
    expect(toHex(fromBase58)).toBe(GOLDEN_V1_HEX);
  });

  it("keeps the domain and length link_consent.rs declares", () => {
    expect(LINK_CONSENT_RS).toContain('pub const LINK_CONSENT_DOMAIN: &[u8; 12] = b"\\xffSIP_LINK_V1";');
    expect(LINK_CONSENT_RS).toContain("pub const LINK_CONSENT_MESSAGE_LEN: usize = 12 + 32 * 4;");
    expect(toHex(LINK_CONSENT_DOMAIN)).toBe(`ff${toHex(new TextEncoder().encode("SIP_LINK_V1"))}`);
    expect(LINK_CONSENT_MESSAGE_LEN).toBe(12 + 32 * 4);
  });

  it("equals @sip/solana-program/link-consent for real keys and this deployment's program id", () => {
    expect(programMirror.LINK_CONSENT_MESSAGE_LEN).toBe(LINK_CONSENT_MESSAGE_LEN);
    expect(toHex(Uint8Array.from(programMirror.LINK_CONSENT_DOMAIN))).toBe(toHex(LINK_CONSENT_DOMAIN));
    for (let round = 0; round < 8; round++) {
      const owner = keypair().publicKey;
      const wallet = keypair().publicKey;
      const vault = deriveVaultPda(owner);
      const program = programMirror.linkConsentMessage({ programId: new PublicKey(SIP_PROGRAM_ID), wallet, vault, owner });
      const ours = linkConsentMessage({ programId: SIP_PROGRAM_ID, wallet: wallet.toBase58(), vault: vault.toBase58(), owner: owner.toBase58() });
      expect(toHex(ours)).toBe(toHex(Uint8Array.from(program)));
    }
  });

  it("names every party: swapping any two keys changes the bytes", () => {
    const [a, b, c, d] = [filled(1), filled(2), filled(3), filled(4)];
    const base = toHex(linkConsentMessage({ programId: a, wallet: b, vault: c, owner: d }));
    expect(toHex(linkConsentMessage({ programId: a, wallet: d, vault: c, owner: b }))).not.toBe(base);
    expect(toHex(linkConsentMessage({ programId: a, wallet: b, vault: d, owner: c }))).not.toBe(base);
  });

  it("refuses a key that is not 32 bytes, and a mutated export cannot drift a message", () => {
    expect(() => linkConsentMessage({ programId: new Uint8Array(31), wallet: filled(2), vault: filled(3), owner: filled(4) })).toThrow(/programId/);
    expect(() => linkConsentMessage({ programId: filled(1), wallet: "0OIl", vault: filled(3), owner: filled(4) })).toThrow(/wallet/);
    const saved = LINK_CONSENT_DOMAIN[0]!;
    LINK_CONSENT_DOMAIN[0] = 0;
    try {
      expect(toHex(linkConsentMessage({ programId: filled(1), wallet: filled(2), vault: filled(3), owner: filled(4) }))).toBe(GOLDEN_V1_HEX);
    } finally {
      LINK_CONSENT_DOMAIN[0] = saved;
    }
  });
});
