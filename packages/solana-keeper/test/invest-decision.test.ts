// The in_mint refusal and the pause switches. sip-vault pins the in-asset in the
// owner's policy; the keeper can only route USDC, so anything else is refused
// before a lamport moves, naming both mints. And a paused vault or protocol
// rests before any wrap, so the owner's pause costs no refused transaction.

import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { USDC_MINT, inMintDecision, investPauseDecision } from "../src/invest-decision.js";

describe("the policy's in_mint", () => {
  it("lets USDC through", () => {
    expect(USDC_MINT.toBase58()).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    expect(inMintDecision(USDC_MINT)).toBeNull();
  });

  it("refuses any other mint, naming both", () => {
    const other = Keypair.generate().publicKey;
    const decision = inMintDecision(other);
    expect(decision?.outcome).toBe("REFUSED");
    expect(decision?.detail).toContain(other.toBase58());
    expect(decision?.detail).toContain(USDC_MINT.toBase58());
  });
});

describe("the pause switches, for investing", () => {
  it("rests a vault its owner paused, naming every step that would refuse it", () => {
    const decision = investPauseDecision({ vaultPaused: true, protocolPaused: false });
    expect(decision?.outcome).toBe("PAUSED");
    expect(decision?.detail).toContain("wrap_sol, convert and invest refuse with VaultPaused");
  });

  it("rests every vault while the protocol is paused", () => {
    const decision = investPauseDecision({ vaultPaused: false, protocolPaused: true });
    expect(decision?.outcome).toBe("PAUSED");
    expect(decision?.detail).toContain("ProtocolPaused");
    expect(decision?.detail).not.toContain("VaultPaused");
  });

  it("names both switches when both are on", () => {
    const decision = investPauseDecision({ vaultPaused: true, protocolPaused: true });
    expect(decision?.detail).toContain("VaultPaused");
    expect(decision?.detail).toContain("ProtocolPaused");
  });

  it("lets an unpaused vault in an unpaused protocol through", () => {
    expect(investPauseDecision({ vaultPaused: false, protocolPaused: false })).toBeNull();
  });
});
