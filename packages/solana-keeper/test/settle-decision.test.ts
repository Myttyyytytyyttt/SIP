// The settle tick's decisions, reached without a Connection, a Program or a mock.
//
// Two things are new in SIP and both are pinned here: a VOLUME vault stops at
// UNSUPPORTED_MODE before anything is measured or attested, and the attestation
// binds exactly the fields settle_v2 rebuilds from chain state — the vault's own
// mode, the rate of that mode as state.rs's active_bps reads it, its policy
// nonce, a start that is the link's measurementStart and nothing else, and a
// deadline 150 slots past the confirmed slot. The measurement order is the old
// tick's behind two new stops — a walk that did not reach the frontier, and a
// window finality has not caught up with — and the frontier-from-epoch rule is
// unchanged. The bytes those inputs encode to are pinned to the program's golden
// vector in attestation-golden.test.ts.

import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import type { VaultState } from "../src/accounts.js";
import type { ManagedLink } from "../src/discovery.js";
import { SIP_PROGRAM_ID } from "../src/idl.js";
import type { WindowMeasurement } from "../src/measure-window.js";
import { ATTESTATION_MESSAGE_LEN, MODE_PROFIT, MODE_VOLUME, attestationMessage } from "../src/program-scripts.js";
import {
  ATTESTATION_VALIDITY_SLOTS,
  activeBps,
  attestationInputs,
  decideFromMeasurement,
  expectedContribution,
  measurementStart,
  modeDecision,
  pauseDecision,
} from "../src/settle-decision.js";

const link: ManagedLink = {
  linkAddress: Keypair.generate().publicKey,
  wallet: Keypair.generate().publicKey,
  vault: Keypair.generate().publicKey,
  epoch: 300_000_000n,
  settlementNonce: 7n,
  frontierSlot: 300_000_500n,
};

const vault = (over: Partial<VaultState> = {}): VaultState => ({
  owner: Keypair.generate().publicKey,
  paused: false,
  skimMode: 0,
  skimBps: 2_000,
  volumeBps: 20,
  policyNonce: 3n,
  maxContribution: 1_000_000_000n,
  walletReserve: 0n,
  ...over,
});

/** A walk that reached the frontier and read twelve clean trades above it. */
const measured = (over: Partial<WindowMeasurement> = {}): WindowMeasurement => ({
  txCount: 12,
  settleTxCount: 0,
  successfulTradeCount: 12,
  chainBreaks: 0,
  unfetchable: 0,
  cashDelta: 50_000_000n,
  deposits: 0n,
  withdrawals: 0n,
  profitLamports: 50_000_000n,
  firstSlot: 300_000_600n,
  lastSlot: 300_000_900n,
  signaturesAbove: 12,
  frontierReached: true,
  pagesExhausted: false,
  ...over,
});

describe("the vault's mode", () => {
  it("stops a VOLUME vault at UNSUPPORTED_MODE, pointing at keeper-medir-volumen", () => {
    const decision = modeDecision(vault({ skimMode: 1 }));
    expect(decision?.outcome).toBe("UNSUPPORTED_MODE");
    expect(decision?.detail).toContain("keeper-medir-volumen");
  });

  it("stops a mode no program version defines", () => {
    expect(modeDecision(vault({ skimMode: 9 }))?.outcome).toBe("UNSUPPORTED_MODE");
  });

  it("lets a PROFIT vault through", () => {
    expect(modeDecision(vault())).toBeNull();
  });
});

describe("the pause switches", () => {
  it("rests a vault its owner paused, naming VaultPaused", () => {
    const decision = pauseDecision(vault({ paused: true }), false);
    expect(decision?.outcome).toBe("PAUSED");
    expect(decision?.detail).toContain("VaultPaused");
    expect(decision?.detail).not.toContain("ProtocolPaused");
  });

  it("rests every vault while the protocol is paused, naming ProtocolPaused", () => {
    const decision = pauseDecision(vault(), true);
    expect(decision?.outcome).toBe("PAUSED");
    expect(decision?.detail).toContain("ProtocolPaused");
    expect(decision?.detail).not.toContain("VaultPaused");
  });

  it("names both switches when both are on", () => {
    const decision = pauseDecision(vault({ paused: true }), true);
    expect(decision?.outcome).toBe("PAUSED");
    expect(decision?.detail).toContain("VaultPaused");
    expect(decision?.detail).toContain("ProtocolPaused");
  });

  it("lets an unpaused vault in an unpaused protocol through", () => {
    expect(pauseDecision(vault(), false)).toBeNull();
  });
});

describe("where a measurement starts", () => {
  it("starts a never-settled link at its own creation, not at slot zero", () => {
    expect(measurementStart({ epoch: 300_000_000n, frontierSlot: 0n })).toBe(300_000_000n);
  });

  it("starts a settled link at its frontier", () => {
    expect(measurementStart({ epoch: 300_000_000n, frontierSlot: 300_000_500n })).toBe(300_000_500n);
  });
});

describe("what a measurement allows, in order", () => {
  const from = 300_000_500n;
  // Finality well past the start: the ordinary case.
  const at = { from, finalizedSlot: 300_001_000n };

  it("an unreadable span is INCOMPLETE even when it looks empty", () => {
    const decision = decideFromMeasurement(measured({ unfetchable: 3, txCount: 0 }), at);
    expect(decision).toMatchObject({ kind: "stop", outcome: "INCOMPLETE" });
    if (decision.kind === "stop") expect(decision.detail).toContain("OUR node");
  });

  it("a walk whose finalized history ends above a start not finalized yet rests at PENDING_FINALITY", () => {
    const decision = decideFromMeasurement(measured({ frontierReached: false, txCount: 0 }), { from, finalizedSlot: from - 1n });
    expect(decision).toMatchObject({ kind: "stop", outcome: "PENDING_FINALITY" });
    if (decision.kind === "stop") expect(decision.detail).toContain(`slot ${from}`);
  });

  it("a walk whose finalized history ends above a finalized start is INCOMPLETE, naming the slot", () => {
    // At the boundary too: a start AT the finalized slot is finalized.
    for (const finalizedSlot of [from, from + 1_000n]) {
      const decision = decideFromMeasurement(measured({ frontierReached: false, txCount: 0 }), { from, finalizedSlot });
      expect(decision).toMatchObject({ kind: "stop", outcome: "INCOMPLETE" });
      if (decision.kind === "stop") expect(decision.detail).toContain(`stops above slot ${from}`);
    }
  });

  it("a walk that ran out of pages is INCOMPLETE, even over a start finality has not reached", () => {
    const decision = decideFromMeasurement(
      measured({ frontierReached: false, pagesExhausted: true, signaturesAbove: 20_000, txCount: 0 }),
      { from, finalizedSlot: from - 1n },
    );
    expect(decision).toMatchObject({ kind: "stop", outcome: "INCOMPLETE" });
    if (decision.kind === "stop") expect(decision.detail).toContain("walked 20000 signatures over 20 pages");
  });

  it("a walk that reached the frontier with nothing finalized above it rests at PENDING_FINALITY, never IDLE", () => {
    // The turn walks only after a confirmed probe saw a newer signature, so
    // this is finality catching up. An idle wallet never gets this far.
    expect(decideFromMeasurement(measured({ txCount: 0, signaturesAbove: 0 }), at)).toMatchObject({ kind: "stop", outcome: "PENDING_FINALITY" });
  });

  it("words each finality stop the same while finality advances, so the sweep logs it once", () => {
    // The sweep's change log emits a resting state only when its line changes,
    // and the finalized slot moves every sweep.
    const shapes = [
      [measured({ frontierReached: false, txCount: 0 }), [from - 50n, from - 1n]],
      [measured({ frontierReached: false, txCount: 0 }), [from, from + 1_000n]],
      [measured({ txCount: 0, signaturesAbove: 0 }), [300_001_000n, 300_001_032n]],
    ] as const;
    for (const [shape, [earlier, later]] of shapes) {
      expect(decideFromMeasurement(shape, { from, finalizedSlot: earlier })).toEqual(decideFromMeasurement(shape, { from, finalizedSlot: later }));
    }
  });

  it("more signatures above the frontier than one settlement reads is INCOMPLETE and promises no catch-up; the limit itself is measured", () => {
    const over = decideFromMeasurement(measured({ signaturesAbove: 301, txCount: 0 }), at);
    expect(over).toMatchObject({ kind: "stop", outcome: "INCOMPLETE" });
    if (over.kind === "stop") {
      expect(over.detail).toContain("301 signatures");
      expect(over.detail).not.toContain("catch up");
    }
    expect(decideFromMeasurement(measured({ signaturesAbove: 300, txCount: 300 }), at)).toMatchObject({ kind: "settle" });
  });

  it("a broken chain is INCOMPLETE", () => {
    expect(decideFromMeasurement(measured({ chainBreaks: 1 }), at)).toMatchObject({ kind: "stop", outcome: "INCOMPLETE" });
  });

  it("a flat or losing span is NO_PROFIT and carries its base, and does not settle", () => {
    const decision = decideFromMeasurement(measured({ profitLamports: -5n }), at);
    expect(decision).toMatchObject({ kind: "stop", outcome: "NO_PROFIT", baseLamports: -5n });
    expect(decideFromMeasurement(measured({ profitLamports: 0n }), at)).toMatchObject({ outcome: "NO_PROFIT" });
  });

  it("profit with no slot beyond the frontier is IDLE", () => {
    expect(decideFromMeasurement(measured({ lastSlot: from }), at)).toMatchObject({ kind: "stop", outcome: "IDLE" });
  });

  it("clean profit settles over the measured window", () => {
    expect(decideFromMeasurement(measured(), at)).toEqual({ kind: "settle", baseLamports: 50_000_000n, endSlot: 300_000_900n });
  });
});

describe("the attestation", () => {
  const programId = new PublicKey(SIP_PROGRAM_ID);
  // link.frontierSlot is 300_000_500, so that is where this span must start.
  const span = { from: 300_000_500n, endSlot: 300_000_900n, baseLamports: 50_000_000n, currentSlot: 300_001_000n };

  it("takes the rate of the vault's active mode, branch for branch as state.rs's active_bps", () => {
    expect(activeBps(vault({ skimMode: MODE_PROFIT, skimBps: 2_500, volumeBps: 40 }))).toBe(2_500);
    expect(activeBps(vault({ skimMode: MODE_VOLUME, skimBps: 2_500, volumeBps: 40 }))).toBe(40);
    // The program tests `== MODE_VOLUME`, so every other mode reads skim_bps.
    expect(activeBps(vault({ skimMode: 9, skimBps: 2_500, volumeBps: 40 }))).toBe(2_500);
  });

  it("binds a PROFIT vault's mode 0, its PROFIT rate and policy nonce, and a deadline 150 slots out", () => {
    const state = vault({ skimBps: 2_500, volumeBps: 40, policyNonce: 11n });
    const inputs = attestationInputs({ programId, link, vault: state, ...span });
    expect(inputs).toEqual({
      programId,
      wallet: link.wallet,
      vault: link.vault,
      linkEpoch: link.epoch,
      settlementNonce: 7n,
      sessionStartSlot: 300_000_500n,
      sessionEndSlot: 300_000_900n,
      baseLamports: 50_000_000n,
      mode: MODE_PROFIT,
      bps: 2_500,
      policyNonce: 11n,
      validUntilSlot: 300_001_150n,
    });
    expect(ATTESTATION_VALIDITY_SLOTS).toBe(150n);
    expect(inputs.bps, "never the volume rate").not.toBe(state.volumeBps);
  });

  it("binds a VOLUME vault's mode 1 and its VOLUME rate, never the profit rate", () => {
    const state = vault({ skimMode: MODE_VOLUME, skimBps: 2_500, volumeBps: 40, policyNonce: 11n });
    const inputs = attestationInputs({ programId, link, vault: state, ...span });
    expect(inputs).toMatchObject({ mode: MODE_VOLUME, bps: 40, policyNonce: 11n, validUntilSlot: 300_001_150n });
    expect(inputs.bps, "never the profit rate").not.toBe(state.skimBps);
  });

  it("encodes through the program's own mirror to the 171-byte message, the vault's mode at byte 152", () => {
    for (const skimMode of [MODE_PROFIT, MODE_VOLUME]) {
      const message = attestationMessage(attestationInputs({ programId, link, vault: vault({ skimMode }), ...span }));
      expect(message.length).toBe(ATTESTATION_MESSAGE_LEN);
      expect(message.length).toBe(171);
      // mode sits right after the five u64s: 16 + 96 + 40.
      expect(message[152]).toBe(skimMode);
    }
  });

  it("a start other than measurementStart throws, above it or below it", () => {
    // Above forgives the slots in between; below is a window settle_v2 would
    // refuse for a settled link.
    for (const from of [300_000_501n, 300_000_499n]) {
      expect(() => attestationInputs({ programId, link, vault: vault(), ...span, from })).toThrow(/starts at slot 300000500/);
    }
    // A never-settled link starts at its epoch: not at zero, where the
    // program's own check (start >= frontier 0) would let it through.
    const fresh: ManagedLink = { ...link, frontierSlot: 0n };
    expect(() => attestationInputs({ programId, link: fresh, vault: vault(), ...span, from: 0n })).toThrow(/starts at slot 300000000/);
    expect(attestationInputs({ programId, link: fresh, vault: vault(), ...span, from: 300_000_000n }).sessionStartSlot).toBe(300_000_000n);
  });

  it("previews what settle_v2 would pay: floored, and clipped at max_contribution", () => {
    expect(expectedContribution(50_000_000n, 2_000, 1_000_000_000n)).toEqual({ owed: 10_000_000n, paid: 10_000_000n });
    expect(expectedContribution(9_999n, 2_000, 1_000_000_000n)).toEqual({ owed: 1_999n, paid: 1_999n });
    expect(expectedContribution(50_000_000n, 2_000, 4_000_000n)).toEqual({ owed: 10_000_000n, paid: 4_000_000n });
  });
});
