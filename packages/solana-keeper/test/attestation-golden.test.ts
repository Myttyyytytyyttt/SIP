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
import {
  GOLDEN_V2_HEX,
  GOLDEN_V2_INPUTS,
  GOLDEN_V3_FIXED_HEX,
  GOLDEN_V3_FIXED_INPUTS,
  GOLDEN_V3_ROUNDUP_HEX,
  GOLDEN_V3_ROUNDUP_INPUTS,
} from "../src/attestation-golden.js";
import { SIP_PROGRAM_ID } from "../src/idl.js";
import type { PerTradeCharge } from "../src/per-trade-base.js";
import { EXPECTED_INVARIANTS, runPreflight } from "../src/preflight.js";
import {
  ATTESTATION_MESSAGE_LEN,
  ATTESTATION_V3_MESSAGE_LEN,
  MODE_FIXED,
  MODE_PROFIT,
  MODE_ROUNDUP,
  MODE_VOLUME,
  attestationInstruction,
  attestationMessage,
  attestationV3Instruction,
  attestationV3Message,
  pricesHash,
} from "../src/program-scripts.js";
import { ATTESTATION_VALIDITY_SLOTS, attestationInputs, attestationV3Inputs } from "../src/settle-decision.js";

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

describe("the V3 golden vectors (settle_v3, the per-trade modes)", () => {
  const rs = (): string => readFileSync(ATTESTATION_RS, "utf8");
  /** What the keeper holds when it builds the round-up vector: the same link and window, a ROUND-UP vault, its charge. */
  const charge = (over: Partial<PerTradeCharge> = {}): PerTradeCharge => ({
    mode: MODE_ROUNDUP,
    amountLamports: 2_666_666n,
    tradeCount: 1,
    priceMinUsdE6: 150_000_000n,
    pricesHash: Buffer.from(GOLDEN_V3_ROUNDUP_INPUTS.pricesHash),
    modeParam: 100n,
    minTrade: 100n,
    rows: [],
    latePriced: 0,
    oldestChargedAt: null,
    unagedCharge: false,
    ...over,
  });
  const v3Args = (skimMode: number, perTrade: PerTradeCharge) => ({
    programId: key(1),
    link: { wallet: key(2), vault: key(3), epoch: 0x0102_0304_0506_0708n, settlementNonce: 9n, frontierSlot: 100n },
    vault: { skimMode, policyNonce: 3n },
    from: 100n,
    endSlot: 200n,
    charge: perTrade,
    currentSlot: 150n,
  });

  it("are attestation.rs's own, character for character", () => {
    expect(/GOLDEN_V3_ROUNDUP_HEX: &str = "([0-9a-f]+)"/.exec(rs())?.[1]).toBe(GOLDEN_V3_ROUNDUP_HEX);
    expect(/GOLDEN_V3_FIXED_HEX: &str = "([0-9a-f]+)"/.exec(rs())?.[1]).toBe(GOLDEN_V3_FIXED_HEX);
    expect(Buffer.from(GOLDEN_V3_ROUNDUP_HEX, "hex").length).toBe(ATTESTATION_V3_MESSAGE_LEN);
    expect(ATTESTATION_V3_MESSAGE_LEN).toBe(229);
  });

  it("are what the program's TypeScript mirror encodes, the round-up hash being pricesHash of its one trade", () => {
    expect(attestationV3Message(GOLDEN_V3_ROUNDUP_INPUTS).toString("hex")).toBe(GOLDEN_V3_ROUNDUP_HEX);
    expect(attestationV3Message(GOLDEN_V3_FIXED_INPUTS).toString("hex")).toBe(GOLDEN_V3_FIXED_HEX);
    expect(pricesHash([{ slot: 500n, signature: Buffer.alloc(64, 0x11), priceUsdE6: 150_000_000n }]).equals(Buffer.from(GOLDEN_V3_ROUNDUP_INPUTS.pricesHash))).toBe(true);
  });

  it("are what the keeper builds for that link, a ROUND-UP or FIXED vault, and that window", () => {
    expect(attestationV3Inputs(v3Args(MODE_ROUNDUP, charge()))).toEqual(GOLDEN_V3_ROUNDUP_INPUTS);
    const fixed = charge({ mode: MODE_FIXED, amountLamports: 7_000_000n, tradeCount: 7, priceMinUsdE6: 0n, pricesHash: Buffer.alloc(32), modeParam: 1_000_000n, minTrade: 10_000_000n });
    expect(attestationV3Message(attestationV3Inputs(v3Args(MODE_FIXED, fixed))).toString("hex")).toBe(GOLDEN_V3_FIXED_HEX);
  });

  it("T-N1: never a V2 attestation for a per-trade vault, nor a V3 one for PROFIT or VOLUME, nor one charge's mode for another's vault", () => {
    for (const skimMode of [MODE_ROUNDUP, MODE_FIXED]) {
      expect(() => attestationInputs({ ...vectorArgs(MODE_VOLUME), vault: { skimMode, skimBps: 2_000, volumeBps: 20, policyNonce: 3n } })).toThrow(/settles through settle_v3 only/);
    }
    for (const skimMode of [MODE_PROFIT, MODE_VOLUME, 4]) expect(() => attestationV3Inputs(v3Args(skimMode, charge()))).toThrow(/only ROUND-UP and FIXED/);
    expect(() => attestationV3Inputs(v3Args(MODE_FIXED, charge()))).toThrow(/skim_mode 2 charge for a vault in skim_mode 3/);
    expect(() => attestationV3Inputs({ ...v3Args(MODE_ROUNDUP, charge()), from: 101n })).toThrow(/starts at slot 100/);
  });

  it("rides the Ed25519 instruction intact, signed by the attester over exactly those 229 bytes", () => {
    const attester = Keypair.generate();
    const { data } = attestationV3Instruction(attester.secretKey, attestationV3Inputs(v3Args(MODE_ROUNDUP, charge())));
    expect(data[0]).toBe(1);
    expect(data.subarray(112).toString("hex")).toBe(GOLDEN_V3_ROUNDUP_HEX);
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), attester.publicKey.toBuffer()]);
    expect(verify(null, Buffer.from(GOLDEN_V3_ROUNDUP_HEX, "hex"), createPublicKey({ key: spki, format: "der", type: "spki" }), data.subarray(48, 112))).toBe(true);
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
  // AND SINCE 2026-09-25, TWENTY: the volume keeper's rule, measured on two of the
  // owner's real mainnet transactions in the image that will charge on it.
  // TWENTY-TWO SINCE 2026-10-08: a deposit carrying a memo is flow, and a trade
  // carrying one is still trading — the Memo programs joined the flow set.
  // TWENTY-SEVEN SINCE THE PER-TRADE MODES: settle_v3 in the IDL, the two V3
  // golden vectors through the mirror, its two builds and the oracle account.
  it("holds all twenty-seven invariants: the golden vectors, the nine builds, the venue and oracle accounts, the volume rule and the memo", async () => {
    expect(await runPreflight()).toEqual({ ok: true, program: SIP_PROGRAM_ID, invariants: 27 });
  });

  // THE SECOND COPY OF THE NUMBER, and the reason it is written as a literal:
  // the preflight now REFUSES to pass with any other count, so the only way to
  // add or drop a check is to change EXPECTED_INVARIANTS on purpose — and this
  // line, which is what makes that a decision instead of a side effect. Before
  // 2026-09-18 the count was reported and never asserted: deleting the settle_v2
  // build from buildOffline left {"preflight":"ok","invariants":13} and exit 0,
  // so the gate could be refactored away under a green light.
  // THE EIGHTEENTH ARRIVED ON 2026-09-21 WITH THE MOVE TO JUPITER, and it is
  // the shape this number exists for. convert and invest used to default their
  // venue account to RAYDIUM_CLMM; that default became a venue the keeper
  // REFUSES, so it was removed and the argument made required. The venue is an
  // ACCOUNT, and the seven vectors compare DATA — so a builder that dropped it
  // would pass all seven and revert on chain with WrongVenue on every sweep.
  // Raising this line is how that check was added on purpose rather than as a
  // side effect.
  it("pins its own size, so a gate that shrinks fails instead of quietly reporting a smaller one", async () => {
    expect(EXPECTED_INVARIANTS).toBe(27);
    expect((await runPreflight()).invariants).toBe(EXPECTED_INVARIANTS);
  });

  it("fails, naming the invariant, when the volume rule measures the owner's first buy wrong", async () => {
    // A fresh module graph whose volume rule is off by everything: proof the
    // invariant compares the measured lamports, not something always true.
    vi.resetModules();
    vi.doMock("../src/measure-volume.js", () => ({ tradeNotional: () => ({ counted: true, lamports: 1n }) }));
    try {
      const { runPreflight: preflightOverAWrongRule } = await import("../src/preflight.js");
      expect(await preflightOverAWrongRule()).toMatchObject({
        ok: false,
        failure: expect.stringContaining("the volume rule measures the owner's first buy at 1 010 000 000 lamports"),
      });
    } finally {
      vi.doUnmock("../src/measure-volume.js");
      vi.resetModules();
    }
  });

  it("fails, naming the invariant, when the vector and the mirror disagree by one byte", async () => {
    // A fresh module graph whose copy of the vector ends in ff instead of 00:
    // proof the invariant compares bytes, not something that is always true.
    vi.resetModules();
    vi.doMock("../src/attestation-golden.js", async (importOriginal) => ({ ...(await importOriginal<object>()), GOLDEN_V2_HEX: `${GOLDEN_V2_HEX.slice(0, -2)}ff` }));
    try {
      const { runPreflight: preflightOverADriftedVector } = await import("../src/preflight.js");
      expect(await preflightOverADriftedVector()).toEqual({
        ok: false,
        program: SIP_PROGRAM_ID,
        invariants: 27,
        failure: 'invariant "the attestation mirror matches the program golden vector" is false, expected true',
      });
    } finally {
      vi.doUnmock("../src/attestation-golden.js");
      vi.resetModules();
    }
  });

  it("fails, naming the invariant, when a V3 vector and the mirror disagree by one byte", async () => {
    vi.resetModules();
    vi.doMock("../src/attestation-golden.js", async (importOriginal) => ({ ...(await importOriginal<object>()), GOLDEN_V3_FIXED_HEX: `${GOLDEN_V3_FIXED_HEX.slice(0, -2)}ff` }));
    try {
      const { runPreflight: preflightOverADriftedVector } = await import("../src/preflight.js");
      expect(await preflightOverADriftedVector()).toMatchObject({
        ok: false,
        failure: 'invariant "the V3 attestation mirror matches both program golden vectors" is false, expected true',
      });
    } finally {
      vi.doUnmock("../src/attestation-golden.js");
      vi.resetModules();
    }
  });
});
