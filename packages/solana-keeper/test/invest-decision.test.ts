// The in_mint refusal and the pause switches. sip-vault pins the in-asset in the
// owner's policy; the keeper can only route USDC, so anything else is refused
// before a lamport moves, naming both mints. And a paused vault or protocol
// rests before any wrap, so the owner's pause costs no refused transaction. And
// a policy that never signed a conversion floor is never wrapped: the program
// would refuse the wrap, so the turn skips it and invests only USDC already held.
// And a wrap moves no more than the crank can front, because wrap_sol has the
// crank pay the amount in first; a crank that stays short is told on the third
// turn.

import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  CRANK_WRAP_RESERVE_LAMPORTS,
  USDC_MINT,
  WRAP_DUST_LAMPORTS,
  convertDecision,
  inMintDecision,
  investPauseDecision,
  wrapPlan,
  wrapShortAlert,
  wrapShortStreak,
} from "../src/invest-decision.js";

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

describe("the conversion floor", () => {
  it("skips wrap and convert at a zero floor, naming the field, the refusal it spares, and what is still invested", () => {
    const decision = convertDecision({ minConvertRateWad: 0n });
    expect(decision.convert).toBe(false);
    const detail = decision.convert ? "" : decision.detail;
    expect(detail).toContain("min_convert_rate_wad is 0");
    expect(detail).toContain("FloorTooLow");
    expect(detail).toContain("only USDC already in the vault is invested");
  });

  it("wraps and converts under any non-zero floor, down to one unit of a wad", () => {
    for (const minConvertRateWad of [1n, 30_000_000_000_000_000n, (1n << 128n) - 1n]) {
      expect(convertDecision({ minConvertRateWad })).toEqual({ convert: true });
    }
  });
});

describe("the wrap, no more than the crank can front", () => {
  it("wraps the crank's balance less its reserve when the vault holds more: the review's 0.5 SOL vault and 0.3 SOL crank", () => {
    expect(wrapPlan({ free: 500_000_000n, crankLamports: 300_000_000n })).toEqual({
      free: 500_000_000n,
      allowance: 280_000_000n,
      amount: 280_000_000n,
      short: true,
    });
  });

  it("wraps nothing below dust, however much the crank holds", () => {
    expect(WRAP_DUST_LAMPORTS).toBe(5_000_000n);
    expect(wrapPlan({ free: 4_999_999n, crankLamports: 10_000_000_000n })).toEqual({
      free: 4_999_999n,
      allowance: 9_980_000_000n,
      amount: 0n,
      short: false,
    });
  });

  it("wraps nothing when all the crank can front is dust, and calls the vault short", () => {
    expect(wrapPlan({ free: 500_000_000n, crankLamports: 24_999_999n })).toEqual({
      free: 500_000_000n,
      allowance: 4_999_999n,
      amount: 0n,
      short: true,
    });
  });

  it("gives a crank inside its reserve an allowance of zero, never a negative one", () => {
    expect(CRANK_WRAP_RESERVE_LAMPORTS).toBe(20_000_000n);
    for (const crankLamports of [0n, 10_000_000n, 20_000_000n]) {
      expect(wrapPlan({ free: 500_000_000n, crankLamports })).toEqual({
        free: 500_000_000n,
        allowance: 0n,
        amount: 0n,
        short: true,
      });
    }
  });

  it("wraps all of it when the crank can front exactly the free balance", () => {
    expect(wrapPlan({ free: 280_000_000n, crankLamports: 300_000_000n })).toEqual({
      free: 280_000_000n,
      allowance: 280_000_000n,
      amount: 280_000_000n,
      short: false,
    });
  });

  it("reads a vault below its rent floor as nothing free", () => {
    expect(wrapPlan({ free: -1_000_000n, crankLamports: 300_000_000n })).toEqual({
      free: 0n,
      allowance: 280_000_000n,
      amount: 0n,
      short: false,
    });
  });
});

describe("the wrap-short alert", () => {
  const vault = Keypair.generate().publicKey.toBase58();
  const wrap = { free: 500_000_000n, allowance: 280_000_000n, wrapped: 280_000_000n, short: true };

  it("stays quiet for two short turns and warns on the third, naming both figures", () => {
    const first = wrapShortStreak(0, true);
    const second = wrapShortStreak(first, true);
    const third = wrapShortStreak(second, true);
    expect([first, second, third]).toEqual([1, 2, 3]);
    expect(wrapShortAlert(vault, first, wrap)).toBeNull();
    expect(wrapShortAlert(vault, second, wrap)).toBeNull();

    const alert = wrapShortAlert(vault, third, wrap);
    expect(alert?.key).toBe(`wrap-short:${vault}`);
    expect(alert?.severity).toBe("warn");
    expect(alert?.title).toBe("A vault holds more free SOL than the crank can front");
    expect(alert?.detail).toContain("500000000 free lamports");
    expect(alert?.detail).toContain("the crank can front 280000000");
  });

  it("resets on a turn that is not short", () => {
    expect(wrapShortStreak(5, false)).toBe(0);
    expect(wrapShortAlert(vault, wrapShortStreak(5, false), { ...wrap, short: false })).toBeNull();
  });
});
