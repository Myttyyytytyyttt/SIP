// The in_mint refusal, the VENUE refusal and the pause switches. sip-vault pins
// the in-asset in the owner's policy; the keeper can only route USDC, so
// anything else is refused before a lamport moves, naming both mints. It pins
// the VENUE the same way, and the program checks the account the keeper passes
// against it (WrongVenue), so a venue this keeper cannot build a route for is
// refused before a lamport moves too — naming the venue asked for, what can
// actually be routed, and the owner as the only one who can change it. And a
// paused vault or protocol
// rests before any wrap, so the owner's pause costs no refused transaction. And
// a policy that never signed a conversion floor is never wrapped: the program
// would refuse the wrap, so the turn skips it and invests only USDC already
// held — and says so loudly, because a zero there is a VALID policy nothing
// validates, it silently switches off the SOL hop, and it leaves the Pyth guard
// on that hop with nothing to watch.
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

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  CONVERT_DUST_LAMPORTS,
  CRANK_WRAP_RESERVE_LAMPORTS,
  INVEST_FAILED_CRITICAL_STREAK,
  LEG_FEE_STEP_BPS,
  LEG_FEE_WARN_BPS,
  IMPACT_TOLERANCE_DIVISOR,
  JUPITER_V6_PROGRAM,
  MAX_LEG_FEE_BPS,
  MIN_IMPACT_CEILING_BPS,
  MIN_PROBE_RAW,
  MIN_SLIPPAGE_MARGIN_BPS,
  MIN_VENUE_INVENTORY_MULTIPLE,
  PROBE_DIVISOR,
  RAYDIUM_CLMM_PROGRAM,
  RETIRED_VENUES,
  ROUTABLE_VENUES,
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
  censusVenueInventory,
  decodeMintFacts,
  decodeTokenAccountFacts,
  impliedRateWad,
  inMintDecision,
  investFailedAlert,
  investFailedStreak,
  investPauseDecision,
  legAdmissionDecision,
  legDepthDecision,
  legFeeCeilingAlert,
  legFeeWarnings,
  legShare,
  legSlippageBps,
  maxTurnImpactBps,
  probeAmount,
  venueImpactBps,
  MAX_PYTH_AGE_SECONDS,
  MAX_PYTH_DEVIATION_BPS,
  oracleConvertDecision,
  rollingDecision,
  routeRateWad,
  rollingTotal,
  shouldConvert,
  turnSpendCeiling,
  venueDecision,
  wrapPlan,
  wrapShortAlert,
  wrapShortStreak,
  type DepthDecision,
  type ImpactProbe,
  type LegVenue,
} from "../src/invest-decision.js";
import { SLIPPAGE_BPS, netOfTransferFee } from "../src/min-out.js";
import { JUPITER_PROGRAM } from "../src/program-scripts.js";
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

describe("the venue the owner signed", () => {
  /**
   * THE KEEPER'S HALF OF THE VECTOR THE WEBSITE SIGNS AGAINST
   * (packages/solana-core/test/fixtures/keeper-policy.ts ROUTED_VENUE).
   *
   * Both packages were green while they disagreed: this keeper routed Jupiter
   * alone and the web's closed venue set held raydium-clmm alone, so every
   * policy the owner could sign was refused HERE, before the wrap, for the life
   * of the policy. Nothing in either package could see it, because neither
   * asserted anything about the other. This is that assertion, from this side.
   */
  it("routes exactly the venue the website is allowed to sign, and refuses exactly the one it may not", async () => {
    const vector = "keeper-policy";
    const { ROUTED_VENUE } = (await import(`../../solana-core/test/fixtures/${vector}.ts`)) as {
      ROUTED_VENUE: { keeper: { programId: string }; web: { programId: string }; retired: { programId: string }; routableCount: number };
    };
    expect([...ROUTABLE_VENUES.keys()]).toEqual([ROUTED_VENUE.keeper.programId]);
    expect(ROUTABLE_VENUES.size).toBe(ROUTED_VENUE.routableCount);
    // The web signs what this keeper routes: one value, asserted from both ends.
    expect(ROUTED_VENUE.web.programId).toBe(ROUTED_VENUE.keeper.programId);
    expect(venueDecision(new PublicKey(ROUTED_VENUE.web.programId))).toBeNull();
    // And the retired one stays refused, whoever offers it.
    expect(RETIRED_VENUES.has(ROUTED_VENUE.retired.programId)).toBe(true);
    expect(venueDecision(new PublicKey(ROUTED_VENUE.retired.programId))?.outcome).toBe("REFUSED");
  });

  it("lets through Jupiter v6, at the address the keeper really passes, pinned to a literal", () => {
    // ONE SOURCE, ONE INDEPENDENT PIN. JUPITER_V6_PROGRAM is now program-scripts'
    // JUPITER_PROGRAM — the same object, through the CommonJS/ESM unwrap the
    // keeper actually loads — so comparing the two would be comparing a value
    // with itself. The pin that can fail is against this string, typed out from
    // Jupiter's published program id and from nothing in the tree.
    expect(JUPITER_V6_PROGRAM.toBase58()).toBe("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
    expect(JUPITER_V6_PROGRAM).toBe(JUPITER_PROGRAM);
    expect(venueDecision(JUPITER_V6_PROGRAM)).toBeNull();
  });

  it("refuses Raydium CLMM, the venue policies named until 2026-09-22, and says first that the migration is expected", () => {
    // THE REFUSAL A NOT-YET-MIGRATED VAULT GETS. It was the live vault's until
    // the owner re-signed onto Jupiter v6 on 2026-09-22 (CHANGELOG.md), and any
    // vault whose policy still names Raydium gets it every sweep until its owner
    // re-signs. What an operator needs from its FIRST clause is whether to wake
    // somebody, and the answer here is no.
    expect(RAYDIUM_CLMM_PROGRAM.toBase58()).toBe("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
    const detail = venueDecision(RAYDIUM_CLMM_PROGRAM)?.detail ?? "";
    expect(venueDecision(RAYDIUM_CLMM_PROGRAM)?.outcome).toBe("REFUSED");
    expect(detail.startsWith("This is the EXPECTED first state of the Jupiter migration")).toBe(true);
    expect(detail).toContain("no SOL has been wrapped");
    // AND IT IS STILL THE FULL REFUSAL, not a shorter friendlier one.
    expect(detail).toContain(RAYDIUM_CLMM_PROGRAM.toBase58());
    expect(detail).toContain(JUPITER_V6_PROGRAM.toBase58());
    expect(detail).toContain("WrongVenue");
    expect(detail).toContain("set_invest_policy");
  });

  it("refuses an UNKNOWN venue without the migration sentence, because that one is not expected", () => {
    const venue = Keypair.generate().publicKey;
    const decision = venueDecision(venue);
    expect(decision?.outcome).toBe("REFUSED");
    const detail = decision?.detail ?? "";
    // The venue asked for, and the one this keeper can actually build a route
    // for: an operator at 3am can act on neither of those alone.
    expect(detail).toContain(venue.toBase58());
    expect(detail).toContain("Jupiter v6");
    expect(detail).toContain(JUPITER_V6_PROGRAM.toBase58());
    // What would otherwise happen, in the program's own vocabulary.
    expect(detail).toContain("WrongVenue");
    expect(detail).toContain("every sweep");
    // And who can fix it: not the operator, not the keeper.
    expect(detail).toContain("OWNER");
    expect(detail).toContain("set_invest_policy");
    // THE TWO REFUSALS MUST NOT READ ALIKE. A retired venue is a planned stop;
    // an unknown one means somebody signed a policy nobody here understands.
    expect(detail).not.toContain("EXPECTED first state");
    expect(detail.startsWith("The policy's venue_program is")).toBe(true);
  });

  it("refuses the default pubkey, which is what an unsigned or half-built policy carries", () => {
    // set_invest_policy admits Pubkey::default() only on a DISABLED policy, so a
    // vault can hold one; investing it would revert on every call.
    expect(venueDecision(PublicKey.default)?.outcome).toBe("REFUSED");
  });

  it("is a table, not a branch: every venue in it is admitted and every one is named in the refusal", () => {
    // THE SEAM, PINNED. Adding a venue is adding an entry here (plus a route
    // builder for it) — never rewriting the gate. ONE entry now: Jupiter v6,
    // which reaches the venues the product's assets actually trade on. Raydium
    // CLMM was dropped when invest-tick stopped containing a Raydium route
    // builder at all — an entry here is a promise the keeper can build a route,
    // and that promise would have been false.
    expect([...ROUTABLE_VENUES.keys()]).toEqual([JUPITER_V6_PROGRAM.toBase58()]);
    const detail = venueDecision(Keypair.generate().publicKey)?.detail ?? "";
    for (const [address, name] of ROUTABLE_VENUES) {
      expect(venueDecision(new PublicKey(address))).toBeNull();
      expect(detail).toContain(`${name} (${address})`);
    }
    // AND A RETIRED VENUE IS NEVER ALSO A ROUTABLE ONE. The two maps answer
    // opposite questions about the same key, so an address in both would make
    // venueDecision's first line decide which one wins — silently, in favour of
    // routing a venue somebody deliberately retired.
    for (const address of RETIRED_VENUES.keys()) expect(ROUTABLE_VENUES.has(address)).toBe(false);
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

  it("says a zero floor is a policy the PROGRAM accepts, which is what makes it dangerous rather than refusable", () => {
    // THE TWO CASES ARE DIFFERENT AND THE MESSAGE HAS TO SAY SO. A venue this
    // keeper cannot route is refused; a zero conversion floor is NOT — the
    // program stores it, set_invest_policy validates every other field and never
    // looks at this one, and the owner may have meant exactly this. The alarm is
    // the whole remedy, so it has to carry why the turn is not refusing.
    const decision = convertDecision({ minConvertRateWad: 0n });
    expect(decision.convert).toBe(false);
    const detail = decision.convert ? "" : decision.detail;
    expect(detail).toContain("set_invest_policy");
    expect(detail).toContain("ACCEPTS");
    expect(detail).toMatch(/SOL-to-USDC hop is\s+switched off|SOL-to-USDC hop/);
    // NOT the vocabulary of a refusal: this turn goes on and buys what it can.
    expect(detail).not.toContain("REFUSED");
    expect(detail).not.toContain("refusing");
  });

  it("says the Pyth guard on that hop is left with nothing to watch, which is the silence nobody would otherwise notice", () => {
    // The oracle gate below is the only number in the turn that does not come
    // from the venue being traded against — and with the hop switched off it
    // cannot fire, cannot rest anything and cannot warn anybody. A reader who
    // knows the guard exists would otherwise assume it is still watching.
    const decision = convertDecision({ minConvertRateWad: 0n });
    const detail = decision.convert ? "" : decision.detail;
    expect(detail).toContain("PYTH GUARD ON THAT HOP HAS NOTHING TO WATCH");
    expect(detail).toContain("no convert for it to price");
  });

  it("names the one person who can turn conversion back on, because it is not the keeper and not the operator", () => {
    const decision = convertDecision({ minConvertRateWad: 0n });
    const detail = decision.convert ? "" : decision.detail;
    expect(detail).toContain("OWNER");
    expect(detail).toContain("re-signing the investment policy");
    expect(detail).toContain("non-zero min_convert_rate_wad");
    // And that a careless re-sign is how it gets there, since nothing validates it.
    expect(detail).toContain("careless re-sign");
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

  /**
   * A Token-2022 mint as extension.rs writes one: the 82-byte base, ZERO
   * PADDING out to 165, AccountType::Mint at 165, then TLV entries from 166.
   *
   * THE PADDING IS THE PART THAT WAS MISSING. This builder wrote the account
   * type at byte 82 and the TLV at 83 until 2026-09-21, and so did the decoder
   * it feeds — fixture and code agreeing with each other and with no mint on
   * any cluster. Token-2022 pads a mint past `Account`'s own 165 bytes so that
   * a mint and a token account can never be told apart by length, and the
   * account type goes after that padding. Measured on mainnet the day this was
   * fixed: ANTHROPIC 911 bytes and SPYx 676, both with byte[82] = 0 and
   * byte[165] = 1. The real accounts are in test/fixtures/token2022-mints.json
   * and decoded further down this file.
   */
  const MINT_TLV_START = 166;
  function mintBytes(extensions: readonly Extension[]): Buffer {
    const mint = Buffer.alloc(MINT_TLV_START + extensions.reduce((total, extension) => total + 4 + extension.data.length, 0));
    mint.fill(0xab, 0, 82); // the base fields: noise that must not leak into any extension
    mint.writeUInt8(1, 165); // AccountType::Mint, after the padding at 82..165
    let offset = MINT_TLV_START;
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

  // ── the real accounts, which is the only pin that could have caught this ──
  //
  // EVERY OTHER MINT IN THIS FILE IS FABRICATED BY mintBytes ABOVE, and until
  // 2026-09-21 that builder and decodeMintFacts shared the same wrong idea of
  // where a Token-2022 mint keeps its extensions: AccountType at byte 82, TLV
  // at 83. They agreed, so all 97 tests were green — and the decoder threw on
  // every mint the chain has ever served, which means legAdmissionDecision
  // refused every Token-2022 leg it was shown, the LIVE SPYx one included, and
  // the fee ceiling had never been evaluated against a real mint in its life.
  //
  // docs/TESTING_TRAPS.md calls this the first species: the field under dispute
  // was supplied by the fixture, so the suite could not tell the two cases
  // apart. The cure is the same one it prescribes — pin the real value. These
  // bytes were read off mainnet with getAccountInfo and are checked into
  // test/fixtures/token2022-mints.json; they are the third party neither the
  // builder nor the decoder can quietly agree with.
  describe("the mints mainnet actually serves", () => {
    const fixture = JSON.parse(
      readFileSync(fileURLToPath(new URL("./fixtures/token2022-mints.json", import.meta.url)), "utf8"),
    ) as { readonly mints: Record<string, { readonly address: string; readonly bytes: number; readonly base64: string }> };
    const bytesOf = (name: string): Buffer => Buffer.from(fixture.mints[name]!.base64, "base64");

    it("puts AccountType at 165 and NOT at 82, which is the whole of the bug", () => {
      for (const name of ["ANTHROPIC", "SPYx"]) {
        const data = bytesOf(name);
        expect(data.length, `${name} is padded well past a token account's 165 bytes`).toBeGreaterThan(165);
        expect(data.readUInt8(165), `${name} byte 165 is AccountType::Mint`).toBe(1);
        expect(data.readUInt8(82), `${name} byte 82 is padding, which the old decoder read as the account type`).toBe(0);
      }
    });

    it("reads ANTHROPIC's real fee schedule: 50 bps from epoch 1032, 100 from 1039", () => {
      // THE SCHEDULE THIS PROJECT HAS BEEN QUOTING ALL ALONG — from spl-token's
      // getTransferFeeConfig, never from this decoder, which until now could
      // not read it at all.
      const facts = decodeMintFacts(bytesOf("ANTHROPIC"));
      expect(facts.transferHook).toBeNull();
      expect(facts.transferFee?.older).toEqual({ epoch: 1_032n, maximumFee: UNCAPPED, bps: 50n });
      expect(facts.transferFee?.newer).toEqual({ epoch: 1_039n, maximumFee: UNCAPPED, bps: 100n });
      // AND THE FEE THE GATE ACTUALLY USES, resolved at the epoch the chain is
      // in now: exactly MAX_LEG_FEE_BPS, admitted only because the comparison
      // is strictly greater-than.
      expect(activeTransferFee(facts, 1_039n).bps).toBe(MAX_LEG_FEE_BPS);
      expect(activeTransferFee(facts, 1_038n).bps).toBe(50n);
    });

    it("reads SPYx as carrying no transfer fee, though it is a 676-byte Token-2022 mint with extensions", () => {
      // THE CASE THAT MAKES THE FIX NON-TRIVIAL. A no-fee answer is also what
      // the BROKEN decoder would have produced if it had returned instead of
      // throwing, so "no fee" is only evidence when the bytes are real and the
      // length proves the extensions were walked.
      const data = bytesOf("SPYx");
      expect(data.length).toBe(676);
      expect(decodeMintFacts(data)).toEqual({ transferHook: null, transferFee: null });
    });

    it("admits both live mints, which is the thing that was impossible yesterday", () => {
      const legs = ["SPYx", "ANTHROPIC"].map((name) => ({
        mint: new PublicKey(fixture.mints[name]!.address),
        account: { owner: TOKEN_2022_PROGRAM_ID, data: bytesOf(name) },
      }));
      const admission = legAdmissionDecision({ legs, currentEpoch: 1_039n });
      expect(admission.admit, "the real basket, at the real epoch, off the real bytes").toBe(true);
      if (!admission.admit) return;
      expect(admission.fees.get(legs[0]!.mint.toBase58())?.bps).toBe(0n);
      expect(admission.fees.get(legs[1]!.mint.toBase58())?.bps).toBe(100n);
    });
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

  it("a fee that rises to 150 bps mid-flight refuses the WHOLE basket, at two legs so the two readings differ", () => {
    // THE ISSUER SCHEDULES 150 FROM A LATER EPOCH and the epoch arrives between
    // two sweeps. Two verdicts have to hold at once, and this is the first:
    // ONE leg over the ceiling refuses the whole basket AND the SOL conversion.
    //
    // TWO LEGS, DELIBERATELY. At N=1 the basket and the leg collapse into one
    // number and a per-leg rule and an all-or-nothing rule give the same answer
    // — docs/TESTING_TRAPS.md's third disguise. The well-behaved leg has to be
    // there for the refusal to be about the basket at all.
    const clean = mintBytes([transferFeeConfig({ epoch: 0n, maximumFee: 0n, bps: 0 }, { epoch: FEE_EPOCH, maximumFee: UNCAPPED, bps: 0 })]);
    const rising = mintBytes([transferFeeConfig({ epoch: 1_032n, maximumFee: UNCAPPED, bps: 100 }, { epoch: 1_040n, maximumFee: UNCAPPED, bps: 150 })]);
    const spyx = legOf(clean);
    const anthropic = legOf(rising);
    // The sweep before the roll buys both legs; the sweep after buys neither.
    expect(legAdmissionDecision({ legs: [spyx, anthropic], currentEpoch: 1_039n }).admit).toBe(true);
    const refused = legAdmissionDecision({ legs: [spyx, anthropic], currentEpoch: 1_040n });
    expect(refused.admit).toBe(false);
    if (refused.admit) return;
    expect(refused.detail).toContain("charges a 150 bps transfer fee in epoch 1040, above the 100 bps");
    // The leg at fault is named; the clean leg is not admitted separately,
    // because LegAdmission carries one verdict and no per-leg outcome.
    expect(refused.detail).toContain(anthropic.mint.toBase58());

    // AND THE SECOND VERDICT, which belongs to the quote rather than to the
    // mint: at 150 bps the keeper would have asked for 250, never the 200 that
    // is fatal against a 150 bps fee. "the numbers the two arms are drawn from"
    // holds the rest of that argument.
    expect(legSlippageBps(150n)).toBe(250n);
    expect(legSlippageBps(150n)).not.toBe(SLIPPAGE_BPS);
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
    const truncated = Buffer.alloc(170);
    truncated.writeUInt8(1, 165); // AccountType::Mint
    truncated.writeUInt16LE(1, 166); // TransferFeeConfig…
    truncated.writeUInt16LE(108, 168); // …108 bytes that are not there
    const broken = legAdmissionDecision({ legs: [legOf(truncated)], currentEpoch: TODAY });
    expect(broken.admit).toBe(false);
    if (broken.admit) return;
    expect(broken.detail).toContain("could not be decoded");
    expect(broken.detail).toContain("past the end of a 170-byte mint");
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

  // ── the warning before the fee reaches the ceiling ─────────────────────────
  //
  // THE REFUSAL IS NOT NOTICE. Everything above pins where the keeper stops
  // buying. Nothing above fires before it stops, and today's live fee on both
  // PreStocks mints is EXACTLY the ceiling — admitted only because that
  // comparison is strictly greater-than. The issuer has already moved these
  // mints 0 → 50 → 100 with the same key; one more write and the whole basket,
  // SPYx and the SOL conversion included, is refused on every sweep.
  describe("the warning before a leg's fee reaches the ceiling", () => {
    /** A mint whose live fee is `bps` from FEE_EPOCH, with nothing scheduled after it. */
    const liveFee = (bps: number): Buffer =>
      mintBytes([transferFeeConfig({ epoch: 0n, maximumFee: 0n, bps: 0 }, { epoch: FEE_EPOCH, maximumFee: UNCAPPED, bps })]);
    /** A mint charging `now` today and `later` from `from`, which is still ahead. */
    const scheduledFee = (now: number, later: number, from: bigint): Buffer =>
      mintBytes([transferFeeConfig({ epoch: FEE_EPOCH, maximumFee: UNCAPPED, bps: now }, { epoch: from, maximumFee: UNCAPPED, bps: later })]);
    const alertFor = (data: Buffer, currentEpoch = TODAY) => legFeeCeilingAlert({ mint: key(), facts: decodeMintFacts(data), currentEpoch });

    it("is spaced by the step the issuer has actually used: half the ceiling", () => {
      expect(LEG_FEE_STEP_BPS).toBe(50n);
      expect(LEG_FEE_WARN_BPS).toBe(MAX_LEG_FEE_BPS - LEG_FEE_STEP_BPS);
      expect(LEG_FEE_WARN_BPS).toBe(50n);
      // A band narrower than one observed step could be jumped clean over.
      expect(LEG_FEE_WARN_BPS + LEG_FEE_STEP_BPS).toBe(MAX_LEG_FEE_BPS);
    });

    it("says nothing about a mint that charges nothing, or one still under the band", () => {
      expect(alertFor(mintBytes([pausable]))).toBeNull();
      expect(alertFor(liveFee(0))).toBeNull();
      expect(alertFor(liveFee(49))).toBeNull();
      // One basis point into the band and it speaks: silence has to end somewhere
      // knowable, and this is the boundary.
      expect(alertFor(liveFee(50))).not.toBeNull();
    });

    it("warns one step under the ceiling, naming the leg, the live fee, the ceiling and the next step up", () => {
      const mint = key();
      const alert = legFeeCeilingAlert({ mint, facts: decodeMintFacts(liveFee(50)), currentEpoch: TODAY });
      expect(alert).not.toBeNull();
      if (alert === null) return;
      expect(alert.severity).toBe("warn");
      expect(alert.title).toContain("one issuer step under the ceiling");
      expect(alert.detail).toContain(mint.toBase58());
      expect(alert.detail).toContain("charges 50 bps to transfer in epoch 1036");
      expect(alert.detail).toContain("against the 100 bps ceiling");
      expect(alert.detail).toContain("50 bps under it");
      // WHAT HAPPENS AT THE NEXT STEP, in the words an operator has to act on.
      expect(alert.detail).toContain("takes it to 100 bps");
      expect(alert.detail).toContain("refuses the whole basket");
      expect(alert.detail).toContain("the SOL conversion with it");
      expect(alert.detail).toContain("no fee scheduled for a later epoch");
    });

    it("warns AT the ceiling — today's live state — and the basket is still bought", () => {
      // Read on mainnet 2026-09-20: 100 bps from epoch 1039, over 50 from 1032.
      const legs = [legOf(scheduledFee(50, 100, 1_039n))];
      // THE REFUSAL DOES NOT MOVE. 100 bps is admitted, deliberately — and the
      // notice is a separate call over the same legs, not a field on the verdict.
      expect(legAdmissionDecision({ legs, currentEpoch: 1_039n }).admit).toBe(true);
      const warnings = legFeeWarnings({ legs, currentEpoch: 1_039n });
      expect(warnings).toHaveLength(1);
      const alert = warnings[0]!;
      expect(alert.severity).toBe("warn");
      expect(alert.title).toContain("at the ceiling this keeper buys through");
      expect(alert.detail).toContain("charges 100 bps to transfer in epoch 1039");
      expect(alert.detail).toContain("the last rate that is admitted");
      expect(alert.detail).toContain("takes it to 150 bps");
    });

    it("carries the SCHEDULED fee, which is the only early notice there is, and calls a dated stop critical", () => {
      // 101 bps written for epoch 1039 while 50 is charged in 1038: the basket
      // is bought today and refused from a date already on chain, with nothing
      // signed or deployed here in between.
      const dated = scheduledFee(50, 101, 1_039n);
      expect(legAdmissionDecision({ legs: [legOf(dated)], currentEpoch: 1_038n }).admit).toBe(true);
      const alert = alertFor(dated, 1_038n);
      expect(alert).not.toBeNull();
      if (alert === null) return;
      expect(alert.severity).toBe("critical");
      expect(alert.title).toContain("will stop this basket");
      expect(alert.detail).toContain("A fee of 101 bps is ALREADY written for epoch 1039");
      expect(alert.detail).toContain("1 epoch(s) from now");
      expect(alert.detail).toContain("this whole basket stops being bought");
    });

    it("reports a scheduled rise the live fee gives no sign of, and keeps it a warning while it lands inside the ceiling", () => {
      // 0 bps today, 100 from epoch 1040: nothing about the LIVE fee is
      // remarkable, and the mint's own bytes already say the product is two
      // epochs from its last admitted rate.
      const rising = scheduledFee(0, 100, 1_040n);
      const alert = alertFor(rising, TODAY);
      expect(alert).not.toBeNull();
      if (alert === null) return;
      expect(alert.severity).toBe("warn");
      expect(alert.detail).toContain("charges 0 bps to transfer in epoch 1036");
      expect(alert.detail).toContain("A fee of 100 bps is ALREADY written for epoch 1040");
      expect(alert.detail).toContain("4 epoch(s) from now");
      expect(alert.detail).toContain("still at or under the ceiling");
    });

    it("survives a refusal caused by another leg: the basket's problem today does not eat the notice about next month", () => {
      const hooked = legOf(mintBytes([transferHook(key())]));
      const nearCeiling = legOf(liveFee(100));
      const legs = [hooked, nearCeiling];
      expect(legAdmissionDecision({ legs, currentEpoch: TODAY }).admit).toBe(false);
      const warnings = legFeeWarnings({ legs, currentEpoch: TODAY });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.detail).toContain(nearCeiling.mint.toBase58());
      // The hooked mint carries no fee at all, so it is refused and silent here.
      expect(warnings[0]!.detail).not.toContain(hooked.mint.toBase58());
    });

    it("keys on the RATE, so a fee that worsens is not muted by the warning it already sent", () => {
      const mint = key();
      const at = (bps: number) => legFeeCeilingAlert({ mint, facts: decodeMintFacts(liveFee(bps)), currentEpoch: TODAY })!;
      // alerts.ts deduplicates by key and holds a fired condition quiet for its
      // repeat window. Keyed on the mint alone, the 50 bps warning would mute
      // the 100 bps one that replaces it — the exact move this watches for.
      expect(at(50).key).not.toBe(at(100).key);
      expect(at(50).key).toBe(at(50).key);
      expect(at(100).key).toContain(mint.toBase58());
    });

    it("carries a context the alerter can actually send: every value a string, no bigint to throw inside fire()", () => {
      const alert = alertFor(scheduledFee(50, 101, 1_039n), 1_038n)!;
      // The alerter spreads context into JSON.stringify on the way to the
      // webhook, and a bigint throws there — on the one path whose whole purpose
      // is that silence is never the healthy state.
      expect(() => JSON.stringify({ ...alert.context })).not.toThrow();
      for (const value of Object.values(alert.context ?? {})) expect(typeof value).toBe("string");
      expect(alert.context).toMatchObject({
        feeBps: "50",
        ceilingBps: "100",
        epoch: "1038",
        nextStepBps: "100",
        scheduledFeeBps: "101",
        scheduledFromEpoch: "1039",
      });
    });

    it("fires for the live basket as mainnet holds it: two PreStocks legs, one warning each", () => {
      const legs = [legOf(preStocks()), legOf(preStocks())];
      expect(legAdmissionDecision({ legs, currentEpoch: TODAY }).admit).toBe(true);
      const warnings = legFeeWarnings({ legs, currentEpoch: TODAY });
      expect(warnings).toHaveLength(2);
      for (const leg of legs) {
        expect(warnings.some((alert) => alert.detail.includes(leg.mint.toBase58()))).toBe(true);
      }
    });

    it("says the fee has ALREADY gone when it has, instead of calling a refused rate the last one admitted", () => {
      // This runs over every leg whose bytes decoded, admitted or not, so it has
      // to be able to report a fee that is past the ceiling — and the basket is
      // genuinely stopped at that point, which is a critical, not a warning.
      const legs = [legOf(liveFee(150))];
      expect(legAdmissionDecision({ legs, currentEpoch: TODAY }).admit).toBe(false);
      const alert = legFeeWarnings({ legs, currentEpoch: TODAY })[0]!;
      expect(alert.severity).toBe("critical");
      expect(alert.title).toContain("above the ceiling");
      expect(alert.detail).toContain("charges 150 bps to transfer in epoch 1036");
      expect(alert.detail).toContain("already 50 bps OVER it");
      expect(alert.detail).toContain("Every sweep refuses the whole basket while this stands");
      // And it never claims a refused rate is one this keeper buys through.
      expect(alert.detail).not.toContain("the last rate that is admitted");
      expect(alert.detail).not.toContain("bps under it");
    });

    it("skips the legs it cannot read rather than guessing a fee out of them — they are already refused in words", () => {
      const broken = Buffer.alloc(170);
      broken.writeUInt8(1, 165);
      broken.writeUInt16LE(1, 166);
      broken.writeUInt16LE(108, 168); // 108 bytes that are not there
      const legs = [
        { mint: key(), account: null },
        legOf(liveFee(100), TOKEN_PROGRAM_ID), // not Token-2022: the extension means nothing
        legOf(broken),
      ];
      expect(legAdmissionDecision({ legs, currentEpoch: TODAY }).admit).toBe(false);
      expect(legFeeWarnings({ legs, currentEpoch: TODAY })).toEqual([]);
    });

    it("is CALLED over the very legs and the very epoch the refusal judged, which is the whole reason it is a second call", () => {
      // A WARNING NOBODY RECEIVES IS NOT A WARNING. Every assertion above this
      // one passed while this function had NO CALLER at all: eleven green tests
      // over a decision no operator could ever see. What that costs is pinned
      // here, in the one place where a future tidy-up would look.
      //
      // AND ONE ARRAY, NOT TWO. Both calls are pure and both walk the mint's
      // TLV, so a second `policy.legs.map(...)` — or a second read of the Clock
      // — would let the notice be about legs the refusal never judged, on an
      // epoch it never used. The tick hoists `legMints` and passes the same
      // `currentEpoch` to both, one line apart, and that is what reads back
      // here. The behaviour itself is exercised in test/accounts.test.ts,
      // through runInvestTick over a stub chain.
      const tick = readFileSync(fileURLToPath(new URL("../src/invest-tick.ts", import.meta.url)), "utf8");
      expect(tick).toMatch(/const admission = legAdmissionDecision\(\{ legs: legMints, currentEpoch \}\);/);
      expect(tick).toMatch(/found\.feeWarnings = legFeeWarnings\(\{ legs: legMints, currentEpoch \}\);/);
      // Exactly one array, built once, and one epoch read once.
      expect(tick.match(/const legMints = policy\.legs\.map\(/g)).toHaveLength(1);
      expect(tick.match(/const currentEpoch = clockInfo\.data\.readBigUInt64LE\(16\);/g)).toHaveLength(1);
      // AND THE WARNING IS COMPUTED BEFORE THE REFUSAL RETURNS. A basket
      // refused today for leg A's hook must still carry the notice about leg B.
      expect(tick.indexOf("found.feeWarnings = legFeeWarnings(")).toBeLessThan(
        tick.indexOf("if (!admission.admit) return { outcome: admission.outcome, detail: admission.detail };"),
      );
    });
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

describe("a leg's venue, at the moment the money would move", () => {
  const key = (): PublicKey => Keypair.generate().publicKey;

  /**
   * THE DRAINED VENUE, AS IT WAS MEASURED. FIGUREAI on 2026-09-20: 0.110274669
   * of the stock (nine decimals) against 31.91 USDC, mid 289.36 USDC/token.
   * check:legs had passed the same leg at 6,700 dollars two days earlier.
   */
  const DRAINED_STOCK = 110_274_669n;
  /** The live SPYx venue the same night, for what the bound costs where it is fine. */
  const LIVE_STOCK = 1_163_416_179n;

  /** The product's default purchase, one leg's share of it, and one leg of a 1,000-dollar cap split three ways. */
  const FIVE_DOLLARS = 5_000_000n;
  /**
   * THE WEIGHT'S OWN ARITHMETIC, NOT A THIRD. Three legs at 3333 bps is
   * legShare(5_000_000, 3333) = 1_666_500 raw, a hundred and sixty-six units
   * under an exact third: state.rs weights are basis points and the remainder
   * is not redistributed. Writing 1_666_666 here would be inventing a number
   * the keeper never spends.
   */
  const ONE_LEG_OF_THE_DEFAULT = 1_666_500n;
  const A_THIRD_OF_A_THOUSAND = 333_300_000n;

  /**
   * WHAT THE TURN TAKES OUT OF THE DRAINED VENUE at each of those sizes, at the
   * measured mid of 289.36 USDC/token, in the stock's nine decimals. These are
   * the spec's own figures and the whole point of the gate: at $5 the cover is
   * 7.4x and at $1.67 it is 20.1x, both far under 50 — and $5 is UNDER the ~$11
   * revert threshold, so this venue would have FILLED and taken the money.
   */
  const TAKE_AT_FIVE_DOLLARS = 14_936_000n;
  const TAKE_AT_ONE_LEG_OF_THE_DEFAULT = 5_473_455n;

  /** An SPL Token account as the chain serves one: 165 bytes, mint(32) owner(32) amount(u64 at 64). */
  function tokenAccountBytes(mint: PublicKey, owner: PublicKey, amount: bigint): Buffer {
    const data = Buffer.alloc(165);
    mint.toBuffer().copy(data, 0);
    owner.toBuffer().copy(data, 32);
    data.writeBigUInt64LE(amount, 64);
    // delegate, state, is_native, delegated_amount, close_authority: noise that
    // must not leak into a mint, an owner or a balance.
    data.fill(0xaf, 72, 165);
    return data;
  }

  interface Held {
    readonly mint: PublicKey;
    readonly amount: bigint;
    readonly owner?: PublicKey;
    readonly writable?: boolean;
    readonly vaultOwned?: boolean;
    readonly programOwner?: PublicKey;
    readonly bytes?: number;
  }

  /** A census over accounts a route names, built the way a turn builds one. */
  function censusOf(payMint: PublicKey, held: readonly Held[]): ReturnType<typeof censusVenueInventory> {
    const writable = new Set<string>();
    const vaultOwned = new Set<string>();
    const candidates = held.map((account) => {
      const address = key();
      if (account.writable !== false) writable.add(address.toBase58());
      if (account.vaultOwned === true) vaultOwned.add(address.toBase58());
      const full = tokenAccountBytes(account.mint, account.owner ?? key(), account.amount);
      return {
        address,
        owner: account.programOwner ?? TOKEN_2022_PROGRAM_ID,
        data: account.bytes === undefined ? full : full.subarray(0, account.bytes),
      };
    });
    return censusVenueInventory({ payMint, candidates, writable, vaultOwned });
  }

  /** One leg as the turn hands it to the gate: one hop, one venue, ARM 2 silent unless asked. */
  function legOf(input: {
    readonly mint?: PublicKey;
    readonly spend: bigint;
    readonly take: bigint;
    readonly held: readonly Held[];
    readonly label?: string;
    readonly impact?: ImpactProbe;
    readonly censusScope?: "every-hop" | "final-only";
  }): LegVenue {
    const mint = input.mint ?? key();
    const label = input.label ?? "Manifest";
    return {
      mint,
      spend: input.spend,
      venueLabels: [label],
      hops: [{ label, payMint: mint, takeRaw: input.take, census: censusOf(mint, input.held) }],
      censusScope: input.censusScope ?? "every-hop",
      impact: input.impact ?? { compared: false, why: "no probe was taken for this case" },
    };
  }

  const decide = (legs: readonly LegVenue[]): DepthDecision => legDepthDecision({ inMint: USDC_MINT, legs });

  it("reads a token account's mint, owner and balance out of its own bytes, and refuses bytes too short to hold them", () => {
    const mint = key();
    const owner = key();
    expect(decodeTokenAccountFacts(tokenAccountBytes(mint, owner, LIVE_STOCK))).toEqual({ mint, owner, amount: LIVE_STOCK });
    // 164 bytes decode into three valid-looking fields under a laxer minimum;
    // the 165 is what makes this the SPL layout and not three arbitrary reads.
    expect(() => decodeTokenAccountFacts(Buffer.alloc(164))).toThrow(/at least 165 bytes/);
  });

  it("REFUSES THE DRAINED VENUE AT THE PRODUCT'S OWN DEFAULT SIZE, one leg — 7.4x cover", () => {
    // THE CASE THE GATE EXISTS FOR, at the size that would actually have
    // filled. ARM 1 alone decides it: no probe, no second quote, no guess about
    // how Jupiter routes a small size.
    const leg = legOf({ spend: FIVE_DOLLARS, take: TAKE_AT_FIVE_DOLLARS, held: [{ mint: key(), amount: DRAINED_STOCK }] });
    // The cover the refusal is about, stated before it is asserted on.
    expect((Number(DRAINED_STOCK) / Number(TAKE_AT_FIVE_DOLLARS)).toFixed(1)).toBe("7.4");
    const held = legOf({
      spend: FIVE_DOLLARS,
      take: TAKE_AT_FIVE_DOLLARS,
      held: [{ mint: leg.mint, amount: DRAINED_STOCK }],
      mint: leg.mint,
    });
    const decision = decide([held]);
    expect(decision.deep).toBe(false);
    if (decision.deep) return;
    expect(decision.outcome).toBe("REFUSED");
    // Both figures and the cover, named: an operator cannot act on "a venue was thin".
    expect(decision.detail).toContain(`holds ${DRAINED_STOCK} raw`);
    expect(decision.detail).toContain(`against the ${TAKE_AT_FIVE_DOLLARS} this turn would move through it`);
    expect(decision.detail).toContain("7.4x cover");
    expect(decision.detail).toContain(`under the ${MIN_VENUE_INVENTORY_MULTIPLE}x`);
    expect(decision.detail).toContain(held.mint.toBase58());
  });

  it("REFUSES THE DRAINED VENUE AT THE DEFAULT SIZE ACROSS THREE LEGS — 20.1x cover, the number 50 was derived from", () => {
    // $5 across three legs at 3333 bps is $1.6667 each. The OLD in-side-reserve
    // gate gave 19.1x on this same case and the new inventory census gives
    // 20.1x, which is the two gates agreeing about the one case both can see —
    // so the 50x derivation transfers intact rather than being re-guessed.
    expect(legShare(FIVE_DOLLARS, 3_333)).toBe(ONE_LEG_OF_THE_DEFAULT);
    expect((Number(DRAINED_STOCK) / Number(TAKE_AT_ONE_LEG_OF_THE_DEFAULT)).toFixed(1)).toBe("20.1");
    const mint = key();
    const decision = decide([
      legOf({ mint, spend: ONE_LEG_OF_THE_DEFAULT, take: TAKE_AT_ONE_LEG_OF_THE_DEFAULT, held: [{ mint, amount: DRAINED_STOCK }] }),
    ]);
    expect(decision.deep).toBe(false);
    if (decision.deep) return;
    expect(decision.detail).toContain("20.1x cover");
  });

  it("refuses the drained venue AT EVERY BALANCE a real turn can reach, from the per-leg minimum up", () => {
    // "At any balance" is the doctrine, and a gate that only refuses large
    // turns is the check:legs mistake one file further down. The three sizes
    // are the smallest share that clears invest.rs's per-leg bar, the product
    // default, and one leg of a 1,000-dollar max_per_call split three ways.
    for (const [spend, take] of [
      [ONE_LEG_OF_THE_DEFAULT, TAKE_AT_ONE_LEG_OF_THE_DEFAULT],
      [FIVE_DOLLARS, TAKE_AT_FIVE_DOLLARS],
      [A_THIRD_OF_A_THOUSAND, (A_THIRD_OF_A_THOUSAND * TAKE_AT_FIVE_DOLLARS) / FIVE_DOLLARS],
    ] as const) {
      const mint = key();
      expect(decide([legOf({ mint, spend, take, held: [{ mint, amount: DRAINED_STOCK }] })]).deep).toBe(false);
    }
  });

  it("trades against a venue with room", () => {
    // The live SPYx venue, against a take it covers better than 50 times over.
    const mint = key();
    const take = LIVE_STOCK / 60n;
    expect(decide([legOf({ mint, spend: 83_000_000n, take, held: [{ mint, amount: LIVE_STOCK }] })])).toEqual({ deep: true });
    // AND THE BOUNDARY IS WHERE IT IS WRITTEN. Exactly 50x is deep; one raw
    // unit of inventory less is refused. A flip to `<=` moves both.
    const exact = 1_000_000n;
    expect(decide([legOf({ mint, spend: 1n, take: exact, held: [{ mint, amount: exact * MIN_VENUE_INVENTORY_MULTIPLE }] })])).toEqual({ deep: true });
    expect(decide([legOf({ mint, spend: 1n, take: exact, held: [{ mint, amount: exact * MIN_VENUE_INVENTORY_MULTIPLE - 1n }] })]).deep).toBe(false);
  });

  it("DOES NOT COUNT THE VAULT'S OWN HOLDINGS as the venue's inventory", () => {
    // THE FAILURE THAT LOOSENS ITSELF EVERY TURN. vaultTarget is in the route
    // by construction and the vault accumulates the stock it buys, so counting
    // it makes a drained venue look deeper the longer the vault has been
    // running. The two readings have to DIFFER here, or the case proves nothing.
    const mint = key();
    const venueHolds = 50_000_000n;
    const vaultHolds = 40_000_000_000n;
    const take = 10_000_000n;
    const held: Held[] = [
      { mint, amount: venueHolds },
      { mint, amount: vaultHolds, vaultOwned: true },
    ];
    // Counted together the cover is 4005x and the venue is admitted; the
    // venue's own 0.05 covers the take 5 times and is refused.
    expect((Number(venueHolds + vaultHolds) / Number(take)).toFixed(0)).toBe("4005");
    const decision = decide([legOf({ mint, spend: FIVE_DOLLARS, take, held })]);
    expect(decision.deep).toBe(false);
    if (decision.deep) return;
    expect(decision.detail).toContain(`holds ${venueHolds} raw`);
    expect(decision.detail).toContain("5.0x cover");
    // And the census counted ONE account, not two.
    expect(censusOf(mint, held)).toEqual({ counted: true, inventory: venueHolds, accounts: 1 });
  });

  it("does not count inventory the route marks READ-ONLY", () => {
    // A source of funds must be writable. An account holding ten of the target
    // that the route cannot debit admits a venue that cannot pay us from it.
    const mint = key();
    const census = censusOf(mint, [{ mint, amount: 10_000_000_000n, writable: false }]);
    expect(census.counted).toBe(false);
    if (census.counted) return;
    expect(census.why).toContain("no writable, non-vault token account holding");
    expect(decide([legOf({ mint, spend: FIVE_DOLLARS, take: 1n, held: [{ mint, amount: 10_000_000_000n, writable: false }] })]).deep).toBe(false);
  });

  it("refuses when no account in the route holds the mint being bought, and does not fall through to ARM 2", () => {
    // A venue whose payout account is absent, or an account list truncated by a
    // partial page. An unmeasurable depth is not a depth — and ARM 2 passing
    // must not rescue it, so this case hands ARM 2 a clean comparison.
    const mint = key();
    const clean: ImpactProbe = { compared: true, impactBps: 0n, ceilingBps: 25n };
    const decision = decide([
      legOf({ mint, spend: FIVE_DOLLARS, take: 1_000n, held: [{ mint: key(), amount: 10_000_000_000n }], impact: clean }),
    ]);
    expect(decision.deep).toBe(false);
    if (decision.deep) return;
    expect(decision.detail).toContain("an unmeasurable depth is not a depth");
  });

  it("ignores accounts that are not token accounts, and bytes too short to be one", () => {
    const mint = key();
    // Right mint at the right offset, wrong program owner: not a token account.
    expect(censusOf(mint, [{ mint, amount: 10_000_000_000n, programOwner: key() }]).counted).toBe(false);
    // The classic SPL Token program counts exactly as Token-2022 does.
    expect(censusOf(mint, [{ mint, amount: 7n, programOwner: TOKEN_PROGRAM_ID }])).toEqual({ counted: true, inventory: 7n, accounts: 1 });
    // 164 bytes is one short of the layout this gate decodes.
    expect(censusOf(mint, [{ mint, amount: 10_000_000_000n, bytes: 164 }]).counted).toBe(false);
  });

  it("ARM 1 PASSES concentrated liquidity sitting away from the price, and ARM 2 catches it", () => {
    // THE ONE CASE ARM 1 ALONE WOULD SPEND ON, and the reason ARM 2 exists. A
    // Meteora DLMM reserve holding 1,000 of the target covers the take 1000x —
    // a count of units cannot see WHERE those units sit — while the turn quotes
    // 400 bps worse than a sixteenth-sized probe on the SAME ammKey list.
    const mint = key();
    const inventory = 1_000_000_000_000n;
    const take = 1_000_000_000n;
    expect(decide([legOf({ mint, spend: FIVE_DOLLARS, take, held: [{ mint, amount: inventory }], label: "Meteora DLMM" })])).toEqual({ deep: true });

    const ceiling = maxTurnImpactBps(200n, 100n);
    expect(ceiling).toBe(25n);
    const decision = decide([
      legOf({
        mint,
        spend: FIVE_DOLLARS,
        take,
        held: [{ mint, amount: inventory }],
        label: "Meteora DLMM",
        impact: { compared: true, impactBps: 400n, ceilingBps: ceiling },
      }),
    ]);
    expect(decision.deep).toBe(false);
    if (decision.deep) return;
    expect(decision.detail).toContain("400 bps worse at this turn's size");
    expect(decision.detail).toContain("the units are there but not at this price");
  });

  it("ADMITS A UNIFORMLY BAD PRICE, because this gate measures depth at the turn's size and not price", () => {
    // THE TEST ASSERTS THE ADMISSION ON PURPOSE. Both quotes come from one
    // source in one instant, so a market quoted 30 % below fair value divides
    // out of the ratio and a count of units has no opinion about what a unit is
    // worth. The defences against a bad price are the owner's min_out_rate_wad,
    // enforced on chain as FloorTooLow, and invest.rs's measured delta. A test
    // asserting a REFUSAL here would encode the belief this gate must not create.
    const mint = key();
    const fairRate = impliedRateWad(1_000_000n, 3_456_000n);
    const badRate = (fairRate * 70n) / 100n;
    // Identical implied rates at both sizes: 30 % off, and no impact at all.
    expect(venueImpactBps(badRate, badRate)).toBe(0n);
    expect(decide([
      legOf({
        mint,
        spend: FIVE_DOLLARS,
        take: 1_000_000n,
        held: [{ mint, amount: 1_000_000_000n }],
        impact: { compared: true, impactBps: venueImpactBps(badRate, badRate), ceilingBps: 25n },
      }),
    ])).toEqual({ deep: true });
  });

  it("ARM 2 ABSTAINS when the probe re-routes, and ARM 1 alone still refuses the drained venue", () => {
    // MEASURED 2026-09-21, one instant, USDC -> ANTHROPIC: the 25 USD turn
    // routed Kipseli + Manifest and the 1 USD probe routed Byreal + Manifest.
    // Jupiter re-picks constantly, so an abstention must never read as a pass
    // AND must never refuse on its own — that would be the
    // fixture-randomises-the-field-under-dispute trap in a new costume.
    const mint = key();
    const abstained: ImpactProbe = { compared: false, why: "probe routed through Byreal + Manifest, the turn through Kipseli + Manifest" };
    const decision = decide([
      legOf({ mint, spend: FIVE_DOLLARS, take: TAKE_AT_FIVE_DOLLARS, held: [{ mint, amount: DRAINED_STOCK }], impact: abstained }),
    ]);
    expect(decision.deep).toBe(false);
    if (decision.deep) return;
    expect(decision.detail).toContain("7.4x cover");
    // AND A SOUND VENUE IS STILL BOUGHT while ARM 2 is blind: a gate that
    // refused every re-route would refuse routinely, and a gate that refuses
    // routinely is a gate an operator turns off.
    expect(decide([legOf({ mint, spend: FIVE_DOLLARS, take: 1n, held: [{ mint, amount: DRAINED_STOCK }], impact: abstained })])).toEqual({ deep: true });
  });

  it("refuses a leg that was censused at its FINAL HOP ONLY while ARM 2 also abstained — nothing measured it", () => {
    // THE ONE COMBINATION NEITHER ARM CATCHES ALONE. An intermediate hop
    // reported no out-amount, so only the last hop was counted; and the probe
    // took a different route, so there is no end-to-end number either. Both
    // arms are individually silent, which is exactly why this needs its own line.
    const mint = key();
    const deep: Held[] = [{ mint, amount: 1_000_000_000_000n }];
    const abstained: ImpactProbe = { compared: false, why: "the probe quote did not answer" };
    const decision = decide([
      legOf({ mint, spend: FIVE_DOLLARS, take: 1_000n, held: deep, censusScope: "final-only", impact: abstained }),
    ]);
    expect(decision.deep).toBe(false);
    if (decision.deep) return;
    expect(decision.detail).toContain("was measured at its final hop only");
    expect(decision.detail).toContain("the probe quote did not answer");

    // EITHER ARM ALONE IS ENOUGH, and the case has to show that too or it is
    // pinning the conjunction by coincidence.
    expect(decide([legOf({ mint, spend: FIVE_DOLLARS, take: 1_000n, held: deep, censusScope: "final-only", impact: { compared: true, impactBps: 1n, ceilingBps: 25n } })])).toEqual({ deep: true });
    expect(decide([legOf({ mint, spend: FIVE_DOLLARS, take: 1_000n, held: deep, censusScope: "every-hop", impact: abstained })])).toEqual({ deep: true });
  });

  it("refuses an INTERMEDIATE hop that is the thin one, on its own cover", () => {
    // USDC -> X -> ANTHROPIC, where the ANTHROPIC hop is deep and the USDC -> X
    // venue holds barely enough X. A gate that only censused the leg's final
    // hop would buy this.
    const intermediate = key();
    const target = key();
    const thinTake = 1_000_000n;
    const decision = decide([
      {
        mint: target,
        spend: FIVE_DOLLARS,
        venueLabels: ["Kipseli", "Manifest"],
        hops: [
          { label: "Kipseli", payMint: intermediate, takeRaw: thinTake, census: censusOf(intermediate, [{ mint: intermediate, amount: thinTake * 5n }]) },
          { label: "Manifest", payMint: target, takeRaw: 1_000n, census: censusOf(target, [{ mint: target, amount: 1_000_000_000_000n }]) },
        ],
        censusScope: "every-hop",
        impact: { compared: true, impactBps: 1n, ceilingBps: 25n },
      },
    ]);
    expect(decision.deep).toBe(false);
    if (decision.deep) return;
    expect(decision.detail).toContain("at its Kipseli hop");
    expect(decision.detail).toContain("5.0x cover");
    expect(decision.detail).toContain(intermediate.toBase58());
  });

  it("ONE SHALLOW LEG REFUSES THE WHOLE BASKET, the deep legs and the SOL conversion included", () => {
    // ALL OR NOTHING IS THE TYPE, NOT A CONVENTION: DepthDecision carries one
    // verdict and no per-leg outcome, so there is no shape this function could
    // return that says "buy two of the three". The deep legs are named nowhere
    // as bought, because they are not.
    const spyx = key();
    const anthropic = key();
    const figureai = key();
    const decision = decide([
      legOf({ mint: spyx, spend: FIVE_DOLLARS, take: 1_000n, held: [{ mint: spyx, amount: LIVE_STOCK }], label: "Byreal" }),
      legOf({ mint: anthropic, spend: FIVE_DOLLARS, take: 1_000n, held: [{ mint: anthropic, amount: LIVE_STOCK }], label: "Manifest" }),
      legOf({ mint: figureai, spend: FIVE_DOLLARS, take: TAKE_AT_FIVE_DOLLARS, held: [{ mint: figureai, amount: DRAINED_STOCK }], label: "Raydium CLMM" }),
    ]);
    expect(decision.deep).toBe(false);
    if (decision.deep) return;
    expect(decision.detail).toContain("refusing the whole basket of 3 leg(s), the deep ones included");
    expect(decision.detail).toContain("refusing to convert SOL toward it");
    // Only the leg at fault is named as a reason; the other two are not
    // reported as anything, because there is no per-leg outcome to report.
    expect(decision.detail).toContain(figureai.toBase58());
    expect(decision.detail).not.toContain(spyx.toBase58());
    expect(decision.detail).not.toContain(anthropic.toBase58());
  });

  it("refuses the whole basket when THE wSOL -> USDC CONVERT is the shallow side", () => {
    // venue_program is ONE owner-signed field, so the convert trades on the same
    // venue as the legs and is measured by the same function at a zero transfer
    // fee. A refused convert refuses the basket and vice versa — one verdict,
    // reached before the wrap, so the owner's SOL stays SOL.
    const stock = key();
    const convertTake = 100_000_000n;
    const decision = decide([
      legOf({ mint: stock, spend: FIVE_DOLLARS, take: 1_000n, held: [{ mint: stock, amount: LIVE_STOCK }] }),
      legOf({ mint: USDC_MINT, spend: 1_000_000_000n, take: convertTake, held: [{ mint: USDC_MINT, amount: convertTake * 10n }], label: "Whirlpool" }),
    ]);
    expect(decision.deep).toBe(false);
    if (decision.deep) return;
    expect(decision.detail).toContain(USDC_MINT.toBase58());
    expect(decision.detail).toContain("10.0x cover");
    expect(decision.detail).toContain("refusing the whole basket of 2 leg(s)");
  });

  it("judges no venue for a leg whose share of the budget rounds to nothing", () => {
    // The swap loop sends no transaction for it, so there is no spend to serve.
    const mint = key();
    expect(decide([legOf({ mint, spend: 0n, take: TAKE_AT_FIVE_DOLLARS, held: [{ mint, amount: DRAINED_STOCK }] })])).toEqual({ deep: true });
  });
});

describe("the numbers the two arms are drawn from", () => {
  it("keeps the inventory multiple at 50 and derives it from the incident, in out-units", () => {
    expect(MIN_VENUE_INVENTORY_MULTIPLE).toBe(50n);
    // The three-leg replay is the tighter of the two derivations and the one
    // the bound has to clear with room: 20.1x, so 50x.
    expect(Number(110_274_669n) / Number(5_473_455n)).toBeCloseTo(20.1, 1);
    expect(Number(110_274_669n) / Number(14_936_000n)).toBeCloseTo(7.4, 1);
  });

  it("probes at a sixteenth, never under a dollar", () => {
    expect(PROBE_DIVISOR).toBe(16n);
    expect(MIN_PROBE_RAW).toBe(1_000_000n);
    // 250 dollars probes at 15.625; 5 dollars probes at the floor, because a
    // 31-cent quote is one these venues were not observed to answer.
    expect(probeAmount(250_000_000n)).toBe(15_625_000n);
    expect(probeAmount(5_000_000n)).toBe(MIN_PROBE_RAW);
    // A turn already probe-sized leaves nothing to compare; the caller abstains.
    expect(probeAmount(1_000_000n)).toBe(MIN_PROBE_RAW);
  });

  it("derives impact from two implied rates and clamps a turn that quotes better than its probe", () => {
    // 100 out per 1 in against 101 out per 1 in is 99 bps of degradation.
    const probe = impliedRateWad(1_000_000n, 1_010_000n);
    const turn = impliedRateWad(100_000_000n, 100_000_000n);
    expect(venueImpactBps(turn, probe)).toBe(99n);
    // BETTER IS NOT CREDIT. A fixed per-hop fee is a larger share of a small
    // size, so a probe can legitimately come back worse than the turn.
    expect(venueImpactBps(probe, turn)).toBe(0n);
    // Nothing quoted prices nothing, and neither case may divide by zero.
    expect(impliedRateWad(0n, 5n)).toBe(0n);
    expect(venueImpactBps(turn, 0n)).toBe(0n);
  });

  it("gives impact a quarter of the usable tolerance, with a floor", () => {
    expect(IMPACT_TOLERANCE_DIVISOR).toBe(4n);
    expect(MIN_IMPACT_CEILING_BPS).toBe(5n);
    // ANTHROPIC today: 200 bps of slippage over a 100 bps fee leaves 100, of
    // which impact gets 25 and drift the other 75 — drift dominates, measured
    // at a 70 % swing in six minutes on the healthy venue.
    expect(maxTurnImpactBps(200n, 100n)).toBe(25n);
    // A zero-fee mint: the whole 200 is usable, so 50.
    expect(maxTurnImpactBps(200n, 0n)).toBe(50n);
    // CROSS-CHECK against a measurement taken for another purpose: 187.79 USDC
    // into the healthy venue measured ~27 bps when that mint charged 50 bps.
    expect(maxTurnImpactBps(200n, 50n)).toBe(37n);
    expect(27n).toBeLessThan(maxTurnImpactBps(200n, 50n));
    // A fee that swallows the whole tolerance still gets a finite, non-zero bar.
    expect(maxTurnImpactBps(200n, 200n)).toBe(MIN_IMPACT_CEILING_BPS);
    expect(maxTurnImpactBps(100n, 400n)).toBe(MIN_IMPACT_CEILING_BPS);
  });

  it("QUOTES STRICTLY ABOVE THE TRANSFER FEE, and by the margin that was measured to fill", () => {
    expect(MIN_SLIPPAGE_MARGIN_BPS).toBe(100n);
    // min-out.ts's own bound is untouched: that one is drawn around a captured
    // rate, this one is a floor under what the keeper asks Jupiter for.
    expect(SLIPPAGE_BPS).toBe(200n);
    // THE 100-BPS-FEE CASE, MEASURED ACROSS THE 1038 -> 1039 BOUNDARY.
    // ANTHROPIC's fee is 100 bps ACTIVE in epoch 1039. At 100 bps of slippage
    // Jupiter reverts the CPI with 0x1771 at 5, 25 and 250 USD — one raw unit
    // short, because Jupiter floors its deduction and Token-2022 ceils its fee.
    // At 200 it fills. So equality is provably fatal and this may never return it.
    expect(legSlippageBps(100n)).toBe(200n);
    expect(legSlippageBps(100n)).toBeGreaterThan(100n);
    // A zero-fee mint — wSOL -> USDC, the convert — keeps the plain 200.
    expect(legSlippageBps(0n)).toBe(200n);
    // AND THE DAY THE ISSUER MOVES TO 150, the quote widens by itself instead
    // of reverting every sweep with no explanation.
    expect(legSlippageBps(150n)).toBe(250n);
    expect(legSlippageBps(400n)).toBe(500n);
    // Whatever the fee, the margin above it is never smaller than the measured one.
    for (const fee of [0n, 1n, 50n, 99n, 100n, 101n, 150n, 999n]) {
      expect(legSlippageBps(fee) - fee).toBeGreaterThanOrEqual(MIN_SLIPPAGE_MARGIN_BPS);
    }
  });

  it("would never have quoted a fee rise to 150 bps at the margin that reverts", () => {
    // HALF OF THE MID-FLIGHT CASE. The other half — that 150 bps refuses the
    // whole basket through legAdmissionDecision, at TWO legs so the basket and
    // the leg cannot collapse into one number — is in "a leg's mint, before the
    // basket is bought", where the Token-2022 mint bytes are built.
    //
    // This half is the one that belongs to the quote: the epoch arrives between
    // two sweeps, and the keeper must never have taken a quote at 200 over 150.
    expect(legSlippageBps(150n)).toBe(250n);
    expect(legSlippageBps(150n)).not.toBe(SLIPPAGE_BPS);
    expect(legSlippageBps(150n) - 150n).toBe(MIN_SLIPPAGE_MARGIN_BPS);
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
