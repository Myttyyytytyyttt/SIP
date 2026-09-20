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
// signed. And the SOL hop is priced against an oracle OUTSIDE the venue as well
// as against the pool it would trade on: a feed that cannot be read, a pair that
// has stopped publishing, or a pool that has walked away from the world rests
// the hop — and rests it the way a zero conversion floor does, so the USDC the
// vault already holds is still invested and no reading of any oracle can stop
// the keeper.

import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  CONVERT_DUST_LAMPORTS,
  CRANK_WRAP_RESERVE_LAMPORTS,
  INVEST_FAILED_CRITICAL_STREAK,
  MAX_LEG_FEE_BPS,
  MIN_POOL_DEPTH_MULTIPLE,
  U64_MAX,
  USDC_MINT,
  WRAP_DUST_LAMPORTS,
  activeTransferFee,
  basketBudget,
  basketMinimum,
  chainDay,
  convertAmount,
  convertCapLamports,
  convertDecision,
  decodeMintFacts,
  decodePoolPair,
  decodeTokenAccountAmount,
  inMintDecision,
  investFailedAlert,
  investFailedStreak,
  investPauseDecision,
  legAdmissionDecision,
  legDepthDecision,
  legShare,
  MAX_PYTH_AGE_SECONDS,
  MAX_PYTH_DEVIATION_BPS,
  oracleConvertDecision,
  readPoolPair,
  rollingDecision,
  routeRateWad,
  rollingTotal,
  shouldConvert,
  turnSpendCeiling,
  wrapPlan,
  wrapShortAlert,
  wrapShortStreak,
} from "../src/invest-decision.js";
import { SLIPPAGE_BPS, netOfTransferFee } from "../src/min-out.js";
import { PYTH_SOL_USD_FEED_ID_HEX, PYTH_USDC_USD_FEED_ID_HEX, PYTH_VERIFICATION_FULL, type PythPriceUpdate } from "../src/pyth.js";

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

  it("admits exactly 100 bps on purpose: the ceiling is a whole round trip of the slippage bound", () => {
    // THE BOUNDARY IS A DECISION, NOT A SIDE EFFECT OF `>`. A leg is bought and
    // one day sold, so the ceiling is paid twice, and twice 100 bps is the
    // whole 200 bps tolerance min-out.ts allows a single fill.
    expect(MAX_LEG_FEE_BPS * 2n).toBe(SLIPPAGE_BPS);
    const ceiling = { bps: MAX_LEG_FEE_BPS, maximumFee: UNCAPPED };
    const roundTrip = netOfTransferFee(netOfTransferFee(1_000_000_000n, ceiling), ceiling);
    expect(roundTrip).toBe(980_100_000n);
    // 199 bps: a hair under the bound only because the second fee is charged on
    // what the first one left. At the ceiling the issuer takes as much of a
    // position as every price movement this keeper will absorb on a fill.
    expect(((1_000_000_000n - roundTrip) * 10_000n) / 1_000_000_000n).toBe(SLIPPAGE_BPS - 1n);

    const withFee = (bps: number): Buffer =>
      mintBytes([transferFeeConfig({ epoch: 0n, maximumFee: 0n, bps: 0 }, { epoch: FEE_EPOCH, maximumFee: UNCAPPED, bps })]);
    expect(legAdmissionDecision({ legs: [legOf(withFee(99))], currentEpoch: TODAY }).admit).toBe(true);
    expect(legAdmissionDecision({ legs: [legOf(withFee(100))], currentEpoch: TODAY }).admit).toBe(true);
    expect(legAdmissionDecision({ legs: [legOf(withFee(101))], currentEpoch: TODAY }).admit).toBe(false);
  });

  it("charges the rise already scheduled on chain from the epoch it names, and not the epoch before", () => {
    // MEASURED ON MAINNET 2026-09-20, epoch 1038: both mints carry
    // newer_transfer_fee = 100 bps stamped 1039, over an older 50 bps stamped
    // 1032. Nothing has to be signed for the live fee to double — the cluster
    // only has to roll an epoch, which it did within hours of this being read.
    const scheduled = mintBytes([
      transferFeeConfig({ epoch: 1_032n, maximumFee: UNCAPPED, bps: 50 }, { epoch: 1_039n, maximumFee: UNCAPPED, bps: 100 }),
    ]);
    const facts = decodeMintFacts(scheduled);
    expect(activeTransferFee(facts, 1_038n).bps).toBe(50n);
    expect(activeTransferFee(facts, 1_039n).bps).toBe(100n);
    expect(activeTransferFee(facts, 1_040n).bps).toBe(100n);
    // The doubled fee is still admitted — it lands exactly on the ceiling, which
    // is the boundary the test above pins deliberately.
    expect(legAdmissionDecision({ legs: [legOf(scheduled)], currentEpoch: 1_039n }).admit).toBe(true);

    // One basis point more on the same schedule, and the epoch roll alone turns
    // a basket this keeper buys into one it refuses, with nothing else changed.
    const overTheLine = mintBytes([
      transferFeeConfig({ epoch: 1_032n, maximumFee: UNCAPPED, bps: 50 }, { epoch: 1_039n, maximumFee: UNCAPPED, bps: 101 }),
    ]);
    expect(legAdmissionDecision({ legs: [legOf(overTheLine)], currentEpoch: 1_038n }).admit).toBe(true);
    const refused = legAdmissionDecision({ legs: [legOf(overTheLine)], currentEpoch: 1_039n });
    expect(refused.admit).toBe(false);
    if (refused.admit) return;
    expect(refused.detail).toContain("charges a 101 bps transfer fee in epoch 1039, above the 100 bps");
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

describe("how much of a turn one leg gets", () => {
  it("caps the BASKET and then splits it, which is how one leg gets 333 dollars out of a 1,000-dollar cap", () => {
    // The shape of max_per_call that makes a depth gate necessary: the cap is
    // not a per-leg bound, and a three-leg basket pushes a third of it into ONE
    // pool in a single turn — two orders of magnitude over the 5-dollar default.
    const budget = basketBudget({ held: 5_000_000_000n, maxPerCall: 1_000_000_000n, headroom: U64_MAX });
    expect(budget).toBe(1_000_000_000n);
    expect(legShare(budget, 3_333)).toBe(333_300_000n);
    // And the three shares never add up to more than the cap.
    const shares = [3_334, 3_333, 3_333].map((weight) => legShare(budget, weight));
    expect(shares.reduce((total, share) => total + share, 0n)).toBeLessThanOrEqual(budget);
  });

  it("takes the smallest of the holding, the per-call cap and the 30-day headroom", () => {
    expect(basketBudget({ held: 40_000_000n, maxPerCall: 250_000_000n, headroom: U64_MAX })).toBe(40_000_000n);
    expect(basketBudget({ held: 400_000_000n, maxPerCall: 250_000_000n, headroom: U64_MAX })).toBe(250_000_000n);
    expect(basketBudget({ held: 400_000_000n, maxPerCall: 250_000_000n, headroom: 9_000_000n })).toBe(9_000_000n);
  });

  it("tests a converting turn at the most it could reach, and a resting one at what the vault actually holds", () => {
    const caps = { maxPerCall: 250_000_000n, headroom: 900_000_000n };
    // The convert has not happened yet, so the USDC that will exist is unknown;
    // what is known is that it cannot buy past the cap or the headroom.
    expect(turnSpendCeiling({ held: 0n, converting: true, ...caps })).toBe(250_000_000n);
    expect(turnSpendCeiling({ held: 0n, converting: true, ...caps, headroom: 40_000_000n })).toBe(40_000_000n);
    // A turn whose SOL hop is off or rested can gain no in-asset this turn, so
    // its own holding is the ceiling — testing it at the cap would refuse a
    // 20-dollar basket because a 250-dollar one would have been too big.
    expect(turnSpendCeiling({ held: 20_000_000n, converting: false, ...caps })).toBe(20_000_000n);
    expect(turnSpendCeiling({ held: 400_000_000n, converting: false, ...caps })).toBe(250_000_000n);
  });
});

describe("a leg's pool, at the moment the money would move", () => {
  const key = (): PublicKey => Keypair.generate().publicKey;

  /** The two pools measured on mainnet on 2026-09-20, by the addresses the registry routes through. */
  const DRAINED_POOL = new PublicKey("HvpDt29EdGcKkFMLkUgvAJDP5oDFLaYG4jnVZnRsHduM");
  const LIVE_POOL = new PublicKey("47MsbowAJnPPt6jgSGLK4hdCtKqRRcKT5pTFHPV7WBPt");
  /** What each held that night, raw: USDC's six decimals, the stock's nine. */
  const DRAINED_USDC = 31_910_000n;
  const DRAINED_STOCK = 110_274_669n;
  const LIVE_USDC = 9_389_405_679n;
  const LIVE_STOCK = 1_163_416_179n;
  /** The default purchase, one leg's share of it, and one leg's share of a 1,000-dollar per-call cap split three ways. */
  const FIVE_DOLLARS = 5_000_000n;
  const ONE_LEG_OF_THE_DEFAULT = 1_666_666n;
  const A_THIRD_OF_A_THOUSAND = 333_300_000n;

  /** A Raydium CLMM PoolState as mainnet serves one: 1544 bytes, the pair at 73 and 105, the vaults at 137 and 169. */
  function poolBytes(pair: { mint0: PublicKey; mint1: PublicKey; vault0: PublicKey; vault1: PublicKey }): Buffer {
    const data = Buffer.alloc(1_544);
    // The discriminator, bump, amm_config and owner ahead of the pair, and
    // everything after the vaults: noise that must not leak into any address.
    data.fill(0xcd, 0, 73);
    data.fill(0xce, 201, 1_544);
    pair.mint0.toBuffer().copy(data, 73);
    pair.mint1.toBuffer().copy(data, 105);
    pair.vault0.toBuffer().copy(data, 137);
    pair.vault1.toBuffer().copy(data, 169);
    return data;
  }

  /** An SPL Token account: 165 bytes, mint(32) owner(32) then the amount, a u64 at 64. */
  function tokenAccountBytes(amount: bigint): Buffer {
    const data = Buffer.alloc(165);
    key().toBuffer().copy(data, 0);
    key().toBuffer().copy(data, 32);
    data.writeBigUInt64LE(amount, 64);
    data.fill(0xaf, 72, 165); // delegate, state, is_native, delegated_amount, close_authority
    return data;
  }

  interface LegInput {
    readonly reserve: bigint;
    readonly stock: bigint;
    readonly spend: bigint;
    readonly pool?: PublicKey;
    /** True puts the in-asset at token_1 instead of token_0: the order is the pool's, not ours. */
    readonly flipped?: boolean;
  }

  /** A basket as the turn hands it to the gate: one pool account and two vault balances per leg. */
  function basketOf(legs: readonly LegInput[]) {
    const vaultAmounts = new Map<string, bigint>();
    const built = legs.map((leg) => {
      const mint = key();
      const inVault = key();
      const outVault = key();
      vaultAmounts.set(inVault.toBase58(), leg.reserve);
      vaultAmounts.set(outVault.toBase58(), leg.stock);
      const pair = leg.flipped === true
        ? { mint0: mint, mint1: USDC_MINT, vault0: outVault, vault1: inVault }
        : { mint0: USDC_MINT, mint1: mint, vault0: inVault, vault1: outVault };
      return {
        mint,
        pool: leg.pool ?? key(),
        spend: leg.spend,
        read: readPoolPair({ data: poolBytes(pair) }),
      };
    });
    return { legs: built, vaultAmounts, decide: () => legDepthDecision({ inMint: USDC_MINT, legs: built, vaultAmounts }) };
  }

  it("walks the pair and both vaults out of a pool's own bytes, and a balance out of a token account's", () => {
    const pair = { mint0: USDC_MINT, mint1: key(), vault0: key(), vault1: key() };
    expect(decodePoolPair(poolBytes(pair))).toEqual(pair);
    expect(decodeTokenAccountAmount(tokenAccountBytes(LIVE_USDC))).toBe(LIVE_USDC);

    // Bytes too short to reach the offsets are a refusal with a reason, not a
    // PublicKey built out of whatever followed.
    const short = readPoolPair({ data: Buffer.alloc(200) });
    expect(short.ok).toBe(false);
    if (short.ok) return;
    expect(short.why).toContain("could not be read as a Raydium pool");
    expect(() => decodeTokenAccountAmount(Buffer.alloc(64))).toThrow(/at least 72 bytes/);
  });

  it("trades against a pool with room, in either token order", () => {
    // The live pool as measured, against one leg's share of a 250-dollar cap.
    for (const flipped of [false, true]) {
      const basket = basketOf([{ reserve: LIVE_USDC, stock: LIVE_STOCK, spend: 83_000_000n, flipped }]);
      expect(basket.decide()).toEqual({ deep: true });
    }
  });

  it("refuses the pool that drained after check:legs passed it — down to the default basket's own share", () => {
    // 6,700 dollars when the build-time check ran; 51 two days later. This is
    // the failure the whole gate exists for, stated as a vector — and it is
    // stated at the SMALLEST spend the product makes as well as the largest,
    // because a bound that only catches the big ones would have let the default
    // 5-dollar basket buy into a pool holding 31.91 USDC.
    for (const spend of [ONE_LEG_OF_THE_DEFAULT, FIVE_DOLLARS, A_THIRD_OF_A_THOUSAND]) {
      const basket = basketOf([{ reserve: DRAINED_USDC, stock: DRAINED_STOCK, spend, pool: DRAINED_POOL }]);
      const decision = basket.decide();
      expect(decision.deep).toBe(false);
      if (decision.deep) return;
      expect(decision.outcome).toBe("REFUSED");
      // Both figures, named: the operator cannot act on "a pool was thin".
      expect(decision.detail).toContain(`holds ${DRAINED_USDC} in-asset raw against the ${spend} this turn would push into it`);
      expect(decision.detail).toContain(basket.legs[0]!.mint.toBase58());
      expect(decision.detail).toContain(DRAINED_POOL.toBase58());
      expect(decision.detail).toContain("Pool depth is measured in the turn, not at build time");
    }
    // 19.1x cover at the default basket's share — the vector that sets the
    // bound: anything at or under 19x would have admitted this pool there.
    const smallest = basketOf([{ reserve: DRAINED_USDC, stock: DRAINED_STOCK, spend: ONE_LEG_OF_THE_DEFAULT }]).decide();
    expect(smallest.deep === false && smallest.detail).toContain("19.1x cover, under the 50x this keeper trades on");
    const five = basketOf([{ reserve: DRAINED_USDC, stock: DRAINED_STOCK, spend: FIVE_DOLLARS }]).decide();
    expect(five.deep === false && five.detail).toContain("6.4x cover, under the 50x this keeper trades on");
  });

  it("admits what the live pool was measured to serve, and refuses the size it was measured not to", () => {
    // The live pool as mainnet held it on 2026-09-20, with its 0.5 % impact
    // size measured at 350 dollars and then 598 six minutes later.
    const against = (spend: bigint) => basketOf([{ reserve: LIVE_USDC, stock: LIVE_STOCK, spend }]).decide();
    // A 250-dollar per-call cap's heaviest leg: 94x cover, a size this venue
    // serves without noticing. A gate that refused this is one an operator
    // turns off, and then none of it runs at all.
    expect(against(100_000_000n)).toEqual({ deep: true });
    // 187.79 — half the smaller of the two measurements, and the most 50x admits here.
    expect(against(187_788_113n)).toEqual({ deep: true });
    // And the 333 dollars a 1,000-dollar cap splits three ways: 28x cover, at
    // the size this pool was measured NOT to absorb quietly.
    const overTheMeasuredSize = against(A_THIRD_OF_A_THOUSAND);
    expect(overTheMeasuredSize.deep).toBe(false);
    expect(overTheMeasuredSize.deep === false && overTheMeasuredSize.detail).toContain("28.2x cover, under the 50x");
  });

  it("puts the boundary exactly at the multiple, and tests it there", () => {
    expect(MIN_POOL_DEPTH_MULTIPLE).toBe(50n);
    const spend = 1_000_000n;
    const exactly = basketOf([{ reserve: spend * MIN_POOL_DEPTH_MULTIPLE, stock: LIVE_STOCK, spend }]).decide();
    expect(exactly).toEqual({ deep: true });
    const oneShort = basketOf([{ reserve: spend * MIN_POOL_DEPTH_MULTIPLE - 1n, stock: LIVE_STOCK, spend }]).decide();
    expect(oneShort.deep).toBe(false);
    expect(oneShort.deep === false && oneShort.detail).toContain("it would need 50000000");
  });

  it("refuses the WHOLE basket for one shallow leg, the deep ones included", () => {
    // The same doctrine as the unroutable-leg and mint-admission refusals, and
    // for the same reason: a partial basket is not the basket that was signed.
    const basket = basketOf([
      { reserve: LIVE_USDC, stock: LIVE_STOCK, spend: 50_000_000n },
      { reserve: DRAINED_USDC, stock: DRAINED_STOCK, spend: 50_000_000n, pool: DRAINED_POOL },
      { reserve: LIVE_USDC, stock: LIVE_STOCK, spend: 50_000_000n },
    ]);
    const decision = basket.decide();
    expect(decision.deep).toBe(false);
    if (decision.deep) return;
    expect(decision.detail).toContain(basket.legs[1]!.mint.toBase58());
    expect(decision.detail).toContain("refusing the whole basket of 3 leg(s), the deep ones included");
    expect(decision.detail).toContain("drifts from the weights the owner signed");
    expect(decision.detail).toContain("refusing to convert SOL toward it");
    for (const index of [0, 2]) expect(decision.detail).not.toContain(basket.legs[index]!.mint.toBase58());
  });

  it("refuses a pool that is not this leg's pair, which is the registry checked against the chain", () => {
    // deps.pools maps a mint to a pool by configuration, and nothing until here
    // asks the pool what it actually trades.
    const stranger = { mint0: USDC_MINT, mint1: key(), vault0: key(), vault1: key() };
    const decision = legDepthDecision({
      inMint: USDC_MINT,
      vaultAmounts: new Map([[stranger.vault0.toBase58(), LIVE_USDC], [stranger.vault1.toBase58(), LIVE_STOCK]]),
      legs: [{ mint: key(), pool: LIVE_POOL, spend: FIVE_DOLLARS, read: readPoolPair({ data: poolBytes(stranger) }) }],
    });
    expect(decision.deep).toBe(false);
    if (decision.deep) return;
    expect(decision.detail).toContain("is not this leg's pair");
    expect(decision.detail).toContain(stranger.mint1.toBase58());
  });

  it("refuses a pool it could not read, a vault it could not read, and a pool with no stock left", () => {
    const missing = legDepthDecision({
      inMint: USDC_MINT,
      vaultAmounts: new Map(),
      legs: [{ mint: key(), pool: LIVE_POOL, spend: FIVE_DOLLARS, read: readPoolPair(null) }],
    });
    expect(missing.deep === false && missing.detail).toContain("has no readable pool account");

    // A pool whose state read fine but whose vault balance did not: an unread
    // reserve is not a deep one, and the gate says which account went missing.
    const built = basketOf([{ reserve: LIVE_USDC, stock: LIVE_STOCK, spend: FIVE_DOLLARS }]);
    const blind = legDepthDecision({ inMint: USDC_MINT, legs: built.legs, vaultAmounts: new Map() });
    expect(blind.deep === false && blind.detail).toContain("a depth that cannot be measured is not a depth");

    // The one thing the out side can be judged on without a price: whether
    // there is anything there at all.
    const empty = basketOf([{ reserve: LIVE_USDC, stock: 0n, spend: FIVE_DOLLARS }]).decide();
    expect(empty.deep === false && empty.detail).toContain("holds none of the leg at all");
  });

  it("judges no pool for a leg whose share rounds to nothing, because the turn sends nothing there", () => {
    const basket = basketOf([{ reserve: 0n, stock: 0n, spend: 0n }]);
    expect(basket.decide()).toEqual({ deep: true });
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


// ── the oracle beside the pool ───────────────────────────────────────────────

/** A decoded feed built from numbers: what invest-tick.ts hands the decision after the owner check. */
function feed(feedIdHex: string, price: bigint, publishTime: bigint, expo = -8): PythPriceUpdate {
  return {
    writeAuthority: Keypair.generate().publicKey.toBase58(),
    verification: { variant: PYTH_VERIFICATION_FULL, numSignatures: null },
    feedIdHex,
    price,
    conf: 1_000n,
    expo,
    publishTime,
    prevPublishTime: publishTime - 1n,
    emaPrice: price,
    emaConf: 1_000n,
    postedSlot: 400_000_000n,
  };
}

/** The chain's clock for these tests, and the pair as mainnet quoted it 15 s earlier. */
const CHAIN_NOW = 1_789_699_401n;
const PUBLISHED = CHAIN_NOW - 15n;
const solFeed = (publishTime = PUBLISHED, price = 10_259_321_149n) => feed(PYTH_SOL_USD_FEED_ID_HEX, price, publishTime);
const usdcFeed = (publishTime = PUBLISHED, price = 99_987_040n) => feed(PYTH_USDC_USD_FEED_ID_HEX, price, publishTime);
/** $102.59321149 over a USDC at $0.99987040, in USDC raw per lamport x 1e18 — pyth.test.ts pins it from the bytes. */
const ORACLE_WAD = 102_606_509_293_604_451n;
/** A route that agrees with the oracle exactly. */
const ask = (over: Partial<Parameters<typeof oracleConvertDecision>[0]> = {}) =>
  oracleConvertDecision({ sol: solFeed(), usdc: usdcFeed(), nowUnixSeconds: CHAIN_NOW, routeWad: null, ...over });

describe("the rate a captured route implies", () => {
  it("is the swap's own realised rate as a WAD, and null when there was no same-direction swap to read", () => {
    // 1 SOL in, 102.606509 USDC out: the same unit the oracle and the floor speak.
    expect(routeRateWad({ inRaw: 1_000_000_000n, outRaw: 102_606_509n })).toBe(102_606_509_000_000_000n);
    expect(routeRateWad({ inRaw: 2_000_000_000n, outRaw: 205_213_018n })).toBe(102_606_509_000_000_000n);
    // live-route.ts reports nothing for an opposite-direction capture rather
    // than inverting it across the spread, and the deviation arm falls silent.
    expect(routeRateWad(null)).toBeNull();
    expect(routeRateWad({ inRaw: 0n, outRaw: 5n })).toBeNull();
    expect(routeRateWad({ inRaw: 5n, outRaw: 0n })).toBeNull();
  });
});

describe("the oracle gate on the SOL hop", () => {
  it("lets a fresh, agreeing pair through, with or without a route to compare", () => {
    expect(ask()).toEqual({ convert: true });
    expect(ask({ routeWad: ORACLE_WAD })).toEqual({ convert: true });
  });

  it("rests the hop when a feed could not be read, and names which", () => {
    // Null is every reason at once: no account, an account the Pyth receiver
    // does not own, bytes that are not a PriceUpdateV2, or the wrong feed id.
    const noSol = ask({ sol: null });
    expect(noSol.convert).toBe(false);
    expect(noSol.convert === false && noSol.detail).toContain("SOL/USD");
    expect(noSol.convert === false && noSol.detail).not.toContain("USDC/USD feed");

    const neither = ask({ sol: null, usdc: null });
    expect(neither.convert === false && neither.detail).toContain("SOL/USD and USDC/USD");
    expect(neither.convert === false && neither.detail).toContain("not owned by the receiver program");
  });

  it("rests the hop on a pair that has stopped publishing, at a bound measured against the feeds' own cadence", () => {
    // 8-10 s cadence, 14-15 s old at the read: the age the keeper sees every turn.
    expect(ask({ nowUnixSeconds: PUBLISHED + 15n })).toEqual({ convert: true });
    expect(MAX_PYTH_AGE_SECONDS).toBe(60n);
    expect(ask({ nowUnixSeconds: PUBLISHED + MAX_PYTH_AGE_SECONDS })).toEqual({ convert: true });
    const stale = ask({ nowUnixSeconds: PUBLISHED + MAX_PYTH_AGE_SECONDS + 1n });
    expect(stale.convert).toBe(false);
    expect(stale.convert === false && stale.detail).toContain(`past the ${MAX_PYTH_AGE_SECONDS} s`);
    // THE PAIR IS ONLY AS FRESH AS ITS STALEST LEG: a live SOL feed does not
    // rescue a USDC feed that stopped an hour ago.
    const oneLegStale = ask({ usdc: usdcFeed(PUBLISHED - 3_600n) });
    expect(oneLegStale.convert).toBe(false);
  });

  it("does NOT rest the hop on a publish AHEAD of the chain's clock, which is the chain drifting, not the feed", () => {
    // The cluster's stake-weighted clock runs behind wall time; the price is
    // then fresher than this keeper can measure. Refusing it would turn a
    // chain-wide drift into a product that has stopped converting.
    expect(ask({ nowUnixSeconds: PUBLISHED - 300n })).toEqual({ convert: true });
    expect(ask({ nowUnixSeconds: PUBLISHED - 300n, routeWad: ORACLE_WAD })).toEqual({ convert: true });
  });

  it("rests the hop on a feed that decodes but quotes no usable price", () => {
    for (const broken of [solFeed(PUBLISHED, 0n), solFeed(PUBLISHED, -1n)]) {
      const decision = ask({ sol: broken });
      expect(decision.convert).toBe(false);
      expect(decision.convert === false && decision.detail).toContain("no usable rate");
    }
    // An exponent far enough out to hang 10 ** scale is refused, not computed.
    const absurd = ask({ sol: feed(PYTH_SOL_USD_FEED_ID_HEX, 10_259_321_149n, PUBLISHED, -40) });
    expect(absurd.convert).toBe(false);
  });

  it("rests the hop when the pool has walked away from the oracle, in either direction", () => {
    // Rounded UP, so the gap really is that many bps: the decision floors the
    // bps it measures, and a gap built by flooring lands back ON the bound.
    const offBy = (bps: bigint) => (ORACLE_WAD * bps + 9_999n) / 10_000n;
    const above = ORACLE_WAD + offBy(MAX_PYTH_DEVIATION_BPS + 1n);
    const below = ORACLE_WAD - offBy(MAX_PYTH_DEVIATION_BPS + 1n);
    for (const routeWad of [above, below]) {
      const decision = ask({ routeWad });
      expect(decision.convert).toBe(false);
      expect(decision.convert === false && decision.detail).toContain(`past the ${MAX_PYTH_DEVIATION_BPS} bps`);
      expect(decision.convert === false && decision.detail).toContain(String(ORACLE_WAD));
    }
    // And lets the bound itself through: the guard fires past it, not at it.
    expect(ask({ routeWad: ORACLE_WAD + (ORACLE_WAD * MAX_PYTH_DEVIATION_BPS) / 10_000n })).toEqual({ convert: true });
    expect(ask({ routeWad: ORACLE_WAD - (ORACLE_WAD * MAX_PYTH_DEVIATION_BPS) / 10_000n })).toEqual({ convert: true });
  });

  it("compares RELATIVELY, so the bound means the same thing at every SOL price", () => {
    // The same pair with SOL ten times dearer. A 3 % gap passes at both prices
    // and a 7 % gap fails at both — which an absolute USD band could not do.
    const dear = { sol: solFeed(PUBLISHED, 102_593_211_490n) };
    const dearWad = ORACLE_WAD * 10n;
    expect(ask({ ...dear, routeWad: dearWad })).toEqual({ convert: true });
    for (const bps of [300n, 700n]) {
      const near = ask({ routeWad: ORACLE_WAD + (ORACLE_WAD * bps) / 10_000n });
      const nearDear = ask({ ...dear, routeWad: dearWad + (dearWad * bps) / 10_000n });
      expect(near.convert).toBe(bps < MAX_PYTH_DEVIATION_BPS);
      expect(nearDear.convert).toBe(near.convert);
    }
    // The same ABSOLUTE gap — 3 USDC per SOL — is 2.9 % of a $102 SOL and 0.29 %
    // of a $1,025 one. A band written once at either price is wrong at the other.
    const threeUsdcPerSol = 3_000_000_000_000_000n;
    expect(ask({ routeWad: ORACLE_WAD - threeUsdcPerSol }).convert).toBe(true);
    expect(ask({ ...dear, routeWad: dearWad - threeUsdcPerSol }).convert).toBe(true);
  });

  it("is tighter than the convert floor it backs, or it could never fire", () => {
    // The web signs min_convert_rate_wad 1000 bps under the pool price of the
    // day (CONVERT_FLOOR_MARGIN_BPS in the web's product.ts). A guard at or
    // above that margin would only ever fire after the floor already had.
    expect(MAX_PYTH_DEVIATION_BPS).toBeLessThan(1_000n);
    expect(MAX_PYTH_DEVIATION_BPS).toBe(500n);
    // And loose enough that a pool fee, one capture's price impact and a few
    // minutes of SOL movement — all well inside 1 % — never reach it.
    expect(ask({ routeWad: (ORACLE_WAD * 9_900n) / 10_000n })).toEqual({ convert: true });
  });

  it("can rest the SOL hop and NOTHING else: no outcome, no alert, no way to stop the keeper", () => {
    // THE SAME TAGGED UNION convertDecision RETURNS, which is what makes a bad
    // reading indistinguishable — to the turn — from an owner who never signed
    // a conversion floor: the SOL is left alone and the USDC already held is
    // still invested. Nothing in here can carry a FAILED or a REFUSED.
    const off = convertDecision({ minConvertRateWad: 0n });
    const blind = ask({ sol: null, usdc: null });
    expect(Object.keys(blind).sort()).toEqual(Object.keys(off).sort());
    expect(Object.keys(blind)).not.toContain("outcome");
    expect(blind.convert === false && blind.detail).toContain("only the USDC the vault already holds is invested");
    expect(ask()).toEqual(convertDecision({ minConvertRateWad: 1n }));
  });
});
