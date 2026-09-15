// The in_mint refusal and the pause switches. sip-vault pins the in-asset in the
// owner's policy; the keeper can only route USDC, so anything else is refused
// before a lamport moves, naming both mints. And a paused vault or protocol
// rests before any wrap, so the owner's pause costs no refused transaction. And
// a policy that never signed a conversion floor is never wrapped: the program
// would refuse the wrap, so the turn skips it and invests only USDC already held.
// And a wrap moves no more than the crank can front, because wrap_sol has the
// crank pay the amount in first; a crank that stays short is told on the third
// turn. And a convert sells no more than convert.rs admits in one call, dust
// wSOL is left alone, nothing is sold while the 30-day cap, counted exactly as
// state.rs counts it, leaves the basket no room, and an investment that keeps
// failing turns critical on the third turn.

import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  CONVERT_DUST_LAMPORTS,
  CRANK_WRAP_RESERVE_LAMPORTS,
  INVEST_FAILED_CRITICAL_STREAK,
  U64_MAX,
  USDC_MINT,
  WRAP_DUST_LAMPORTS,
  basketMinimum,
  chainDay,
  convertAmount,
  convertCapLamports,
  convertDecision,
  inMintDecision,
  investFailedAlert,
  investFailedStreak,
  investPauseDecision,
  rollingDecision,
  rollingTotal,
  shouldConvert,
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

describe("the convert, no more than convert.rs admits in one call", () => {
  it("caps at max(max_per_call, 1 SOL), reading the owner's figure as lamports", () => {
    expect(convertCapLamports(50_000_000n)).toBe(1_000_000_000n);
    expect(convertCapLamports(1_000_000_000n)).toBe(1_000_000_000n);
    expect(convertCapLamports(1_500_000_000n)).toBe(1_500_000_000n);
    expect(convertCapLamports(U64_MAX)).toBe(U64_MAX);
  });

  it("converts up to the cap and leaves the rest: the review's 1.5 SOL under 50 USDC, and both boundaries the program suite pins", () => {
    expect(convertAmount(1_500_000_000n, 50_000_000n)).toBe(1_000_000_000n);
    expect(convertAmount(1_000_000_001n, 100_000_000n)).toBe(1_000_000_000n);
    expect(convertAmount(1_500_000_001n, 1_500_000_000n)).toBe(1_500_000_000n);
    expect(convertAmount(700_000_000n, 50_000_000n)).toBe(700_000_000n);
    expect(convertAmount(3_000_000_000n, U64_MAX)).toBe(3_000_000_000n);
  });

  it("leaves dust wSOL alone unless the turn just wrapped", () => {
    expect(CONVERT_DUST_LAMPORTS).toBe(5_000_000n);
    expect(shouldConvert(4_999_999n, 0n)).toBe(false);
    expect(shouldConvert(5_000_000n, 0n)).toBe(true);
    expect(shouldConvert(1n, 1n)).toBe(true);
    expect(shouldConvert(0n, 0n)).toBe(false);
  });
});

describe("the 30-day cap, counted as state.rs counts it", () => {
  it("takes the chain's day as invest.rs does: truncating division, refused outside u32", () => {
    expect(chainDay(1_789_430_400n)).toBe(20_711); // 2026-09-15 00:00 UTC
    expect(chainDay(1_789_516_799n)).toBe(20_711);
    expect(chainDay(1_789_516_800n)).toBe(20_712);
    expect(chainDay(-1n)).toBe(0);
    expect(() => chainDay(-86_400n)).toThrow(/outside u32/);
    expect(() => chainDay((0xffff_ffffn + 1n) * 86_400n)).toThrow(/outside u32/);
  });

  it("counts a bucket while its day + 31 is after today, and saturates at u64::MAX", () => {
    expect(rollingTotal([20_680], [7n], 20_711)).toBe(0n);
    expect(rollingTotal([20_681], [7n], 20_711)).toBe(7n);
    expect(rollingTotal([20_680, 20_681, 20_711], [1n, 10n, 100n], 20_711)).toBe(110n);
    expect(rollingTotal(new Array<number>(31).fill(0), new Array<bigint>(31).fill(5n), 20_711)).toBe(0n);
    expect(rollingTotal([20_700, 20_710], [U64_MAX - 1n, 5n], 20_711)).toBe(U64_MAX);
  });

  it("needs the budget whose rounded-down split still gives the lightest leg the minimum", () => {
    expect(basketMinimum(5_000_000n, [10_000])).toBe(5_000_000n);
    expect(basketMinimum(1_666_666n, [3_334, 3_333, 3_333])).toBe(5_000_499n);
    expect((5_000_499n * 3_333n) / 10_000n).toBe(1_666_666n);
    expect((5_000_498n * 3_333n) / 10_000n).toBe(1_666_665n);
  });

  const legsOf = (weights: readonly number[]) =>
    weights.map((weightBps) => ({ mint: Keypair.generate().publicKey, weightBps, minOutRateWad: 1n }));
  const policyWith = (maxRolling30d: bigint, recorded: bigint) => ({
    minInvestment: 5_000_000n,
    maxRolling30d,
    legs: legsOf([10_000]),
    bucketDays: [20_711],
    bucketAmounts: [recorded],
  });

  it("rests when the headroom is below the basket minimum, naming the refusal, the figures and the day it grows", () => {
    const decision = rollingDecision({ policy: policyWith(900_000_000n, 896_000_000n), today: 20_711 });
    expect(decision.invest).toBe(false);
    const detail = decision.invest ? "" : decision.detail;
    expect(detail).toContain("RollingCapExhausted: rolling 896000000 of max 900000000");
    expect(detail).toContain("headroom 4000000 is below the basket minimum 5000000");
    expect(detail).toContain("headroom next grows on day 20742 (2026-10-16)");
  });

  it("proceeds with exactly the headroom the program admits", () => {
    expect(rollingDecision({ policy: policyWith(900_000_000n, 895_000_000n), today: 20_711 })).toEqual({
      invest: true,
      headroom: 5_000_000n,
    });
  });

  it("proceeds under the default u64::MAX cap, however much is recorded", () => {
    for (const recorded of [0n, 896_000_000n, U64_MAX]) {
      expect(rollingDecision({ policy: policyWith(U64_MAX, recorded), today: 20_711 })).toEqual({ invest: true, headroom: U64_MAX });
    }
  });

  it("says when the cap itself is below a multi-leg basket's minimum", () => {
    const decision = rollingDecision({
      policy: { ...policyWith(9_000_000n, 0n), legs: legsOf([3_334, 3_333, 3_333]) },
      today: 20_711,
    });
    const detail = decision.invest ? "" : decision.detail;
    expect(detail).toContain("headroom 9000000 is below the basket minimum 15001501");
    expect(detail).toContain("max_rolling_30d itself is below the basket minimum");
  });
});

describe("the invest-failed alert", () => {
  const vault = Keypair.generate().publicKey.toBase58();

  it("warns on the first failure and turns critical on the third in a row", () => {
    expect(INVEST_FAILED_CRITICAL_STREAK).toBe(3);
    const first = investFailedAlert(vault, 1, "Error Code: AboveMaximum");
    expect(first.key).toBe(`invest-failed:${vault}`);
    expect(first.severity).toBe("warn");
    expect(first.detail).toContain("AboveMaximum");
    expect(investFailedAlert(vault, 2, "slippage").severity).toBe("warn");
    expect(investFailedAlert(vault, 3, "slippage").severity).toBe("critical");
    expect(investFailedAlert(vault, 4, "slippage").severity).toBe("critical");
  });

  it("counts FAILED, holds through REFUSED, and ends on anything else", () => {
    expect(investFailedStreak(0, "FAILED")).toBe(1);
    expect(investFailedStreak(2, "FAILED")).toBe(3);
    expect(investFailedStreak(2, "REFUSED")).toBe(2);
    for (const outcome of ["INVESTED", "IDLE", "PAUSED", "NO_POLICY"] as const) {
      expect(investFailedStreak(2, outcome)).toBe(0);
    }
  });
});
