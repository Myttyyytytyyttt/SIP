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
// failing turns critical on the third turn. And every leg's mint is read out of
// its own Token-2022 bytes before the basket is bought: a mint the program
// cannot buy safely — not Token-2022, a real transfer hook, or a transfer fee
// above the ceiling in the epoch the swap lands in — refuses the WHOLE basket,
// the sound legs included, because a partial basket is not the basket the owner
// signed.

import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  CONVERT_DUST_LAMPORTS,
  CRANK_WRAP_RESERVE_LAMPORTS,
  INVEST_FAILED_CRITICAL_STREAK,
  MAX_LEG_FEE_BPS,
  U64_MAX,
  USDC_MINT,
  WRAP_DUST_LAMPORTS,
  activeTransferFee,
  basketMinimum,
  chainDay,
  convertAmount,
  convertCapLamports,
  convertDecision,
  decodeMintFacts,
  inMintDecision,
  investFailedAlert,
  investFailedStreak,
  investPauseDecision,
  legAdmissionDecision,
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

describe("a leg's mint, before the basket is bought", () => {
  const key = (): PublicKey => Keypair.generate().publicKey;
  /** u64::MAX: maximum_fee on both PreStocks mints, i.e. no cap at all. */
  const UNCAPPED = (1n << 64n) - 1n;
  /** The epoch the fee these mints charge today was stamped with, and one it is read in. */
  const FEE_EPOCH = 1_032n;
  const TODAY = 1_036n;

  interface Extension {
    readonly type: number;
    readonly data: Buffer;
  }

  /** A Token-2022 mint as extension.rs writes one: the 82-byte base, AccountType::Mint, then TLV entries. */
  function mintBytes(extensions: readonly Extension[]): Buffer {
    const mint = Buffer.alloc(83 + extensions.reduce((total, extension) => total + 4 + extension.data.length, 0));
    mint.fill(0xab, 0, 82); // the base fields: noise that must not leak into any extension
    mint.writeUInt8(1, 82); // AccountType::Mint
    let offset = 83;
    for (const extension of extensions) {
      mint.writeUInt16LE(extension.type, offset);
      mint.writeUInt16LE(extension.data.length, offset + 2);
      extension.data.copy(mint, offset + 4);
      offset += 4 + extension.data.length;
    }
    return mint;
  }

  interface Fee {
    readonly epoch: bigint;
    readonly maximumFee: bigint;
    readonly bps: number;
  }

  /** TransferFeeConfig (type 1): two authorities, the withheld amount, then older and newer TransferFee. */
  function transferFeeConfig(older: Fee, newer: Fee): Extension {
    const data = Buffer.alloc(108);
    key().toBuffer().copy(data, 0); // transfer_fee_config_authority
    key().toBuffer().copy(data, 32); // withdraw_withheld_authority
    data.writeBigUInt64LE(777n, 64); // withheld_amount
    for (const [offset, fee] of [[72, older], [90, newer]] as const) {
      data.writeBigUInt64LE(fee.epoch, offset);
      data.writeBigUInt64LE(fee.maximumFee, offset + 8);
      data.writeUInt16LE(fee.bps, offset + 16);
    }
    return { type: 1, data };
  }

  /** TransferHook (type 14): an authority, then the program id — all zeroes when the issuer named none. */
  function transferHook(programId: PublicKey): Extension {
    const data = Buffer.alloc(64);
    key().toBuffer().copy(data, 0);
    programId.toBuffer().copy(data, 32);
    return { type: 14, data };
  }

  /** ScaledUiAmountConfig (25) and PausableConfig (26): extensions this gate must step over, not read. */
  const scaledUiAmount: Extension = { type: 25, data: Buffer.alloc(40) };
  const pausable: Extension = { type: 26, data: Buffer.alloc(33) };

  /** Both PreStocks mints, as the chain holds them: 50 bps since epoch 1032, uncapped, hook extension with a NULL program id. */
  const preStocks = (): Buffer =>
    mintBytes([
      scaledUiAmount,
      transferFeeConfig({ epoch: 0n, maximumFee: 0n, bps: 0 }, { epoch: FEE_EPOCH, maximumFee: UNCAPPED, bps: 50 }),
      transferHook(PublicKey.default),
      pausable,
    ]);

  const legOf = (data: Buffer, owner = TOKEN_2022_PROGRAM_ID) => ({ mint: key(), account: { owner, data } });

  it("reads the fee schedule and the null hook out of the live shape, stepping over the extensions it does not need", () => {
    const facts = decodeMintFacts(preStocks());
    expect(facts.transferHook, "the extension is present, but its program id is null: nothing is called").toBeNull();
    expect(facts.transferFee).toEqual({
      older: { epoch: 0n, maximumFee: 0n, bps: 0n },
      newer: { epoch: FEE_EPOCH, maximumFee: UNCAPPED, bps: 50n },
    });
  });

  it("charges the newer fee only from the epoch it was stamped with", () => {
    const facts = decodeMintFacts(preStocks());
    // 0 → 50 bps is exactly the move this issuer made; a keeper that read
    // `newer` unconditionally would have charged it two epochs early, and one
    // that read `older` would never see it at all.
    expect(activeTransferFee(facts, FEE_EPOCH - 1n).bps).toBe(0n);
    expect(activeTransferFee(facts, FEE_EPOCH).bps).toBe(50n);
    expect(activeTransferFee(facts, TODAY)).toEqual({ epoch: FEE_EPOCH, maximumFee: UNCAPPED, bps: 50n });
  });

  it("charges nothing for a mint with no extensions at all", () => {
    const classic = Buffer.alloc(82);
    expect(decodeMintFacts(classic)).toEqual({ transferHook: null, transferFee: null });
    expect(activeTransferFee(decodeMintFacts(classic), TODAY)).toEqual({ bps: 0n, maximumFee: 0n });
    // And a Token-2022 mint that carries only extensions this gate ignores.
    expect(activeTransferFee(decodeMintFacts(mintBytes([scaledUiAmount, pausable])), TODAY)).toEqual({ bps: 0n, maximumFee: 0n });
  });

  it("admits the live basket and hands each leg's epoch-active fee to the bound", () => {
    const legs = [legOf(preStocks()), legOf(preStocks())];
    const admission = legAdmissionDecision({ legs, currentEpoch: TODAY });
    expect(admission.admit).toBe(true);
    if (!admission.admit) return;
    for (const leg of legs) {
      expect(admission.fees.get(leg.mint.toBase58())?.bps).toBe(50n);
      expect(admission.fees.get(leg.mint.toBase58())?.maximumFee).toBe(UNCAPPED);
    }
  });

  it("refuses a mint that is not a Token-2022 mint, naming both programs", () => {
    const leg = legOf(preStocks(), TOKEN_PROGRAM_ID);
    const admission = legAdmissionDecision({ legs: [leg], currentEpoch: TODAY });
    expect(admission.admit).toBe(false);
    if (admission.admit) return;
    expect(admission.outcome).toBe("REFUSED");
    expect(admission.detail).toContain(leg.mint.toBase58());
    expect(admission.detail).toContain(TOKEN_PROGRAM_ID.toBase58());
    expect(admission.detail).toContain(TOKEN_2022_PROGRAM_ID.toBase58());
  });

  it("refuses a REAL transfer hook — the one failure no later transaction can undo", () => {
    const hook = key();
    const mint = mintBytes([transferFeeConfig({ epoch: 0n, maximumFee: 0n, bps: 0 }, { epoch: 0n, maximumFee: 0n, bps: 0 }), transferHook(hook)]);
    expect(decodeMintFacts(mint).transferHook?.equals(hook)).toBe(true);
    const admission = legAdmissionDecision({ legs: [legOf(mint)], currentEpoch: TODAY });
    expect(admission.admit).toBe(false);
    if (admission.admit) return;
    expect(admission.detail).toContain(hook.toBase58());
    expect(admission.detail).toContain("without a program upgrade");
  });

  it("buys through a fee up to the ceiling and refuses the basis point above it", () => {
    expect(MAX_LEG_FEE_BPS).toBe(100n);
    const withFee = (bps: number): Buffer =>
      mintBytes([transferFeeConfig({ epoch: 0n, maximumFee: 0n, bps: 0 }, { epoch: FEE_EPOCH, maximumFee: UNCAPPED, bps })]);
    expect(legAdmissionDecision({ legs: [legOf(withFee(100))], currentEpoch: TODAY }).admit).toBe(true);
    const over = legAdmissionDecision({ legs: [legOf(withFee(101))], currentEpoch: TODAY });
    expect(over.admit).toBe(false);
    if (over.admit) return;
    expect(over.detail).toContain("charges a 101 bps transfer fee in epoch 1036, above the 100 bps");
    // The rate the authority can reach in two epochs, on mints it has already moved once.
    expect(legAdmissionDecision({ legs: [legOf(withFee(10_000))], currentEpoch: TODAY }).admit).toBe(false);
  });

  it("refuses only from the epoch a scheduled fee starts in, not before", () => {
    const scheduled = mintBytes([
      transferFeeConfig({ epoch: FEE_EPOCH, maximumFee: UNCAPPED, bps: 50 }, { epoch: TODAY + 2n, maximumFee: UNCAPPED, bps: 1_000 }),
    ]);
    expect(legAdmissionDecision({ legs: [legOf(scheduled)], currentEpoch: TODAY }).admit).toBe(true);
    expect(legAdmissionDecision({ legs: [legOf(scheduled)], currentEpoch: TODAY + 1n }).admit).toBe(true);
    expect(legAdmissionDecision({ legs: [legOf(scheduled)], currentEpoch: TODAY + 2n }).admit).toBe(false);
  });

  it("refuses a mint account it could not read, and one whose bytes do not decode", () => {
    const unreadable = legAdmissionDecision({ legs: [{ mint: key(), account: null }], currentEpoch: TODAY });
    expect(unreadable.admit).toBe(false);
    if (unreadable.admit) return;
    expect(unreadable.detail).toContain("has no readable mint account");

    // An extension header whose length runs off the end of the account: decoded
    // blindly it reads a fee out of whatever follows, so it is a refusal, and a
    // reason, rather than a throw out of the middle of a turn.
    const truncated = Buffer.alloc(87);
    truncated.writeUInt8(1, 82); // AccountType::Mint
    truncated.writeUInt16LE(1, 83); // TransferFeeConfig…
    truncated.writeUInt16LE(108, 85); // …108 bytes that are not there
    const broken = legAdmissionDecision({ legs: [legOf(truncated)], currentEpoch: TODAY });
    expect(broken.admit).toBe(false);
    if (broken.admit) return;
    expect(broken.detail).toContain("could not be decoded");
    expect(broken.detail).toContain("past the end of a 87-byte mint");
  });

  it("refuses the WHOLE basket for one bad leg, the sound ones included", () => {
    // The new all-or-nothing failure this gate introduces, stated as a vector:
    // a basket of three sound legs and one hooked mint buys nothing at all.
    const sound = [legOf(preStocks()), legOf(preStocks()), legOf(preStocks())];
    const hooked = legOf(mintBytes([transferHook(key())]));
    const admission = legAdmissionDecision({ legs: [...sound, hooked], currentEpoch: TODAY });
    expect(admission.admit).toBe(false);
    if (admission.admit) return;
    expect(admission.detail).toContain(hooked.mint.toBase58());
    expect(admission.detail).toContain("refusing the whole basket of 4 leg(s), the sound ones included");
    expect(admission.detail).toContain("drifts from the weights the owner signed");
    for (const leg of sound) expect(admission.detail).not.toContain(leg.mint.toBase58());
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
