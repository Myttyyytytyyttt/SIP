// The settle tick's decisions, reached without a Connection, a Program or a mock.
//
// Two things are new in SIP and both are pinned here: a VOLUME vault stops at
// UNSUPPORTED_MODE before anything is measured or attested, and a PROFIT
// attestation binds exactly the fields settle_v2 rebuilds from chain state —
// the vault's own PROFIT rate and policy nonce, mode 0, and a deadline 150 slots
// past the confirmed slot. The measurement order is the old tick's, and so is
// the frontier-from-epoch rule.

import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import type { VaultState } from "../src/accounts.js";
import type { ManagedLink } from "../src/discovery.js";
import { SIP_PROGRAM_ID } from "../src/idl.js";
import type { WindowMeasurement } from "../src/measure-window.js";
import { ATTESTATION_MESSAGE_LEN, MODE_PROFIT, attestationMessage } from "../src/program-scripts.js";
import {
  ATTESTATION_VALIDITY_SLOTS,
  decideFromMeasurement,
  expectedContribution,
  measurementStart,
  modeDecision,
  pauseDecision,
  profitAttestationInputs,
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

const measured = (over: Partial<WindowMeasurement> = {}): WindowMeasurement => ({
  txCount: 12,
  chainBreaks: 0,
  unfetchable: 0,
  cashDelta: 50_000_000n,
  deposits: 0n,
  withdrawals: 0n,
  profitLamports: 50_000_000n,
  firstSlot: 300_000_600n,
  lastSlot: 300_000_900n,
  truncated: false,
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

  it("an unreadable span is INCOMPLETE even when it looks empty", () => {
    const decision = decideFromMeasurement(measured({ unfetchable: 3, txCount: 0 }), from);
    expect(decision).toMatchObject({ kind: "stop", outcome: "INCOMPLETE" });
    if (decision.kind === "stop") expect(decision.detail).toContain("OUR node");
  });

  it("an empty readable span is IDLE", () => {
    expect(decideFromMeasurement(measured({ txCount: 0 }), from)).toMatchObject({ kind: "stop", outcome: "IDLE" });
  });

  it("a truncated walk and a broken chain are INCOMPLETE", () => {
    expect(decideFromMeasurement(measured({ truncated: true }), from)).toMatchObject({ outcome: "INCOMPLETE" });
    expect(decideFromMeasurement(measured({ chainBreaks: 1 }), from)).toMatchObject({ outcome: "INCOMPLETE" });
  });

  it("a flat or losing span is NO_PROFIT and carries its base, and does not settle", () => {
    const decision = decideFromMeasurement(measured({ profitLamports: -5n }), from);
    expect(decision).toMatchObject({ kind: "stop", outcome: "NO_PROFIT", baseLamports: -5n });
    expect(decideFromMeasurement(measured({ profitLamports: 0n }), from)).toMatchObject({ outcome: "NO_PROFIT" });
  });

  it("profit with no slot beyond the frontier is IDLE", () => {
    expect(decideFromMeasurement(measured({ lastSlot: from }), from)).toMatchObject({ kind: "stop", outcome: "IDLE" });
  });

  it("clean profit settles over the measured window", () => {
    expect(decideFromMeasurement(measured(), from)).toEqual({ kind: "settle", baseLamports: 50_000_000n, endSlot: 300_000_900n });
  });
});

describe("the PROFIT attestation", () => {
  const programId = new PublicKey(SIP_PROGRAM_ID);

  it("binds the vault's PROFIT rate and policy nonce, mode 0, and a deadline 150 slots out", () => {
    const state = vault({ skimBps: 2_500, volumeBps: 40, policyNonce: 11n });
    const inputs = profitAttestationInputs({
      programId,
      link,
      vault: state,
      from: 300_000_500n,
      endSlot: 300_000_900n,
      baseLamports: 50_000_000n,
      currentSlot: 300_001_000n,
    });
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

  it("encodes through the program's own mirror to the 171-byte message settle_v2 verifies", () => {
    const inputs = profitAttestationInputs({
      programId,
      link,
      vault: vault(),
      from: 1n,
      endSlot: 2n,
      baseLamports: 3n,
      currentSlot: 4n,
    });
    const message = attestationMessage(inputs);
    expect(message.length).toBe(ATTESTATION_MESSAGE_LEN);
    expect(message.length).toBe(171);
    // mode sits right after the five u64s: 16 + 96 + 40.
    expect(message[152]).toBe(MODE_PROFIT);
  });

  it("previews what settle_v2 would pay: floored, and clipped at max_contribution", () => {
    expect(expectedContribution(50_000_000n, 2_000, 1_000_000_000n)).toEqual({ owed: 10_000_000n, paid: 10_000_000n });
    expect(expectedContribution(9_999n, 2_000, 1_000_000_000n)).toEqual({ owed: 1_999n, paid: 1_999n });
    expect(expectedContribution(50_000_000n, 2_000, 4_000_000n)).toEqual({ owed: 10_000_000n, paid: 4_000_000n });
  });
});
