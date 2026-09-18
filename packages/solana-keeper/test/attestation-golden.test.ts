// The attestation bytes, pinned in the keeper's own suite.
//
// THE VECTOR WAS PINNED WHERE `vitest run` NEVER LOOKS: the unit test in
// attestation.rs runs under cargo, and tests/attestation-v2.ts under anchor
// test. The keeper signs with the program's TypeScript mirror, so a drift in it,
// or a keeper feeding it the wrong mode or rate, would first show up on chain as
// AttestationMismatch, after the fee. Here the keeper's copy of the vector is
// tied to attestation.rs by reading the file, the mirror to that vector, and the
// keeper's own input builder and Ed25519 instruction to the same 171 bytes. No
// network, and the only key is generated here.

import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import { GOLDEN_V2_HEX, GOLDEN_V2_INPUTS } from "../src/attestation-golden.js";
import { SIP_PROGRAM_ID } from "../src/idl.js";
import { runPreflight } from "../src/preflight.js";
import { ATTESTATION_MESSAGE_LEN, MODE_PROFIT, MODE_VOLUME, attestationInstruction, attestationMessage } from "../src/program-scripts.js";
import { ATTESTATION_VALIDITY_SLOTS, attestationInputs } from "../src/settle-decision.js";

const ATTESTATION_RS = new URL("../../solana-program/programs/sip-vault/src/attestation.rs", import.meta.url);
const golden = Buffer.from(GOLDEN_V2_HEX, "hex");
const key = (byte: number): PublicKey => new PublicKey(Buffer.alloc(32, byte));

/**
 * What the keeper holds when it builds the vector's attestation: a link as
 * discovery reads it, a vault in `skimMode`, and the window it measured. The
 * confirmed slot is 150, so the deadline lands on the vector's 300.
 */
const vectorArgs = (skimMode: number) => ({
  programId: key(1),
  link: { wallet: key(2), vault: key(3), epoch: 0x0102_0304_0506_0708n, settlementNonce: 9n, frontierSlot: 100n },
  vault: { skimMode, skimBps: 2_000, volumeBps: 20, policyNonce: 3n },
  from: 100n,
  endSlot: 200n,
  baseLamports: 1_000_000_000n,
  currentSlot: 150n,
});

describe("the attestation golden vector", () => {
  it("is attestation.rs's own, character for character", () => {
    const declared = /GOLDEN_V2_HEX: &str = "([0-9a-f]+)"/.exec(readFileSync(ATTESTATION_RS, "utf8"));
    expect(declared, "attestation.rs no longer declares GOLDEN_V2_HEX in the shape this test reads").not.toBeNull();
    expect(GOLDEN_V2_HEX).toBe(declared?.[1]);
    expect(golden.length).toBe(ATTESTATION_MESSAGE_LEN);
    expect(golden.length).toBe(171);
  });

  it("is what the program's TypeScript mirror encodes from the vector's inputs", () => {
    expect(attestationMessage(GOLDEN_V2_INPUTS).toString("hex")).toBe(GOLDEN_V2_HEX);
  });

  it("is what the keeper builds for that link, a VOLUME vault at 20 bps, and that window", () => {
    expect(ATTESTATION_VALIDITY_SLOTS).toBe(150n);
    const inputs = attestationInputs(vectorArgs(MODE_VOLUME));
    expect(inputs).toEqual(GOLDEN_V2_INPUTS);
    expect(attestationMessage(inputs).toString("hex")).toBe(GOLDEN_V2_HEX);
  });

  it("differs for the same vault in PROFIT mode only at the mode byte and the rate, which becomes skim_bps", () => {
    const profit = attestationMessage(attestationInputs(vectorArgs(MODE_PROFIT)));
    const differing = [...profit.keys()].filter((index) => profit[index] !== golden[index]);
    // The mode at 152, then the rate as a u16 LE at 153..154: 2_000 is 0x07d0.
    expect(differing).toEqual([152, 153, 154]);
    expect(profit.subarray(152, 155).toString("hex")).toBe("00d007");
  });

  it("rides the Ed25519 instruction intact, signed by the attester over exactly those bytes", () => {
    const attester = Keypair.generate();
    const { data } = attestationInstruction(attester.secretKey, attestationInputs(vectorArgs(MODE_VOLUME)));
    // web3.js's layout: a 16-byte header, the public key at 16, the signature at
    // 48 and the message at 112.
    expect(data[0], "exactly one signature").toBe(1);
    expect(data.length).toBe(112 + ATTESTATION_MESSAGE_LEN);
    expect(data.subarray(16, 48).equals(attester.publicKey.toBuffer())).toBe(true);
    expect(data.subarray(112).toString("hex")).toBe(GOLDEN_V2_HEX);
    // The Ed25519 program's own check, done here with node:crypto: the raw key
    // behind the fixed SPKI prefix for Ed25519.
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), attester.publicKey.toBuffer()]);
    expect(verify(null, golden, createPublicKey({ key: spki, format: "der", type: "spki" }), data.subarray(48, 112))).toBe(true);
  });
});

describe("--preflight", () => {
  // Seventeen, not ten: the last seven BUILD settle_v2, wrap_sol, convert and
  // invest — settle_v2 and convert three times each, so the vectors cover a
  // zero argument and a u64 past 2^32 and not only the comfortable middle.
  // Under vitest they cannot fail the way they failed in production — vitest's
  // interop hands anchor's BN over and Node's does not — which is the whole
  // reason the real gate is `tsx bin/keeper.mts --preflight` in the Dockerfile.
  // This case only holds the count and the vectors steady.
  it("holds all seventeen invariants, the golden vector and the seven builds among them", async () => {
    expect(await runPreflight()).toEqual({ ok: true, program: SIP_PROGRAM_ID, invariants: 17 });
  });

  it("fails, naming the invariant, when the vector and the mirror disagree by one byte", async () => {
    // A fresh module graph whose copy of the vector ends in ff instead of 00:
    // proof the invariant compares bytes, not something that is always true.
    vi.resetModules();
    vi.doMock("../src/attestation-golden.js", () => ({ GOLDEN_V2_HEX: `${GOLDEN_V2_HEX.slice(0, -2)}ff`, GOLDEN_V2_INPUTS }));
    try {
      const { runPreflight: preflightOverADriftedVector } = await import("../src/preflight.js");
      expect(await preflightOverADriftedVector()).toEqual({
        ok: false,
        program: SIP_PROGRAM_ID,
        invariants: 17,
        failure: 'invariant "the attestation mirror matches the program golden vector" is false, expected true',
      });
    } finally {
      vi.doUnmock("../src/attestation-golden.js");
      vi.resetModules();
    }
  });
});
