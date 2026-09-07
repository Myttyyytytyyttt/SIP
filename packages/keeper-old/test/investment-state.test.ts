// The vault's investment slots, decoded.
//
// The vault answers these only as packed words, so the bit offsets below ARE the
// interface. A wrong offset does not throw — it returns a plausible number from
// the wrong field, and `enabled` read one bit out is a vault that reports itself
// switched off forever while its owner watches nothing happen.
//
// Every fixture here is either a value read off mainnet or one built to make a
// specific misreading visible.

import { describe, expect, it } from "vitest";

import {
  decodeInvestmentConfiguration,
  decodeLifetimeInvested,
  decodeSqrtPriceX96,
  decodeSwapFeePips,
  INVESTMENT_SLOT,
  orderPair,
  slotHex,
  VAULT_STORAGE_BASE,
} from "../src/investment-state.js";

const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as const;
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const;
const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC" as const;

describe("the slot map", () => {
  /**
   * Pinned against VaultLens.sol, which Solidity itself pins by writing a
   * distinct value into every field and reading it back. Deriving these on paper
   * got them wrong once: `settlementExecutor` packs `cohortId` and `adminEpoch`
   * into its spare twelve bytes and shifts everything below by a slot.
   */
  it("matches the offsets VaultLens uses", () => {
    expect(INVESTMENT_SLOT.lifetimeTotals - VAULT_STORAGE_BASE).toBe(46n);
    expect(INVESTMENT_SLOT.packed - VAULT_STORAGE_BASE).toBe(47n);
    expect(INVESTMENT_SLOT.adapterId - VAULT_STORAGE_BASE).toBe(48n);
    expect(INVESTMENT_SLOT.basketHash - VAULT_STORAGE_BASE).toBe(49n);
    expect(INVESTMENT_SLOT.limits - VAULT_STORAGE_BASE).toBe(50n);
    expect(INVESTMENT_SLOT.rollingCap - VAULT_STORAGE_BASE).toBe(51n);
  });

  it("renders a slot as a full 32-byte word", () => {
    const hex = slotHex(INVESTMENT_SLOT.packed);
    expect(hex).toMatch(/^0x[0-9a-f]{64}$/);
    expect(BigInt(hex)).toBe(INVESTMENT_SLOT.packed);
  });
});

describe("decoding the packed configuration word", () => {
  /**
   * The live vault, read from mainnet: every investment slot is zero, because no
   * deployed implementation has ever written there. A decoder that invented a
   * non-zero nonce or a true flag from an all-zero word would be inventing a
   * configuration nobody set.
   */
  it("reports an untouched vault as unconfigured rather than as anything", () => {
    const config = decodeInvestmentConfiguration({
      packed: 0n,
      adapterId: 0n,
      basketHash: 0n,
      limits: 0n,
      rollingCap: 0n,
    });
    expect(config.enabled).toBe(false);
    expect(config.paused).toBe(false);
    expect(config.policyNonce).toBe(0n);
    expect(config.basketHash).toBe(`0x${"0".repeat(64)}`);
    expect(config.minInvestmentWei).toBe(0n);
  });

  /**
   * WHAT ACTUALLY MATTERS HERE IS THE OFFSET, NOT THE MASK WIDTH.
   *
   * Solidity gives each `bool` a whole byte, so `enabled` sits at bit 64 and
   * `paused` at bit 72. Masking with `& 1n` instead of `& 0xffn` is measurably
   * EQUIVALENT — mutating it breaks no test, and correctly so, because Solidity
   * only ever writes 0 or 1 into that byte.
   *
   * The offset is a different matter: reading `paused` as bit 65, one along from
   * `enabled`, gives the right answer whenever both flags are false and whenever
   * only `enabled` is set. So this fixture sets `paused` ALONE, which is the one
   * arrangement that separates the two readings — and mutating the offset does
   * fail it.
   */
  it("reads paused without reading enabled, and the other way round", () => {
    const onlyPaused = decodeInvestmentConfiguration({
      packed: 1n << 72n,
      adapterId: 0n,
      basketHash: 0n,
      limits: 0n,
      rollingCap: 0n,
    });
    expect(onlyPaused.paused).toBe(true);
    expect(onlyPaused.enabled).toBe(false);

    const onlyEnabled = decodeInvestmentConfiguration({
      packed: 1n << 64n,
      adapterId: 0n,
      basketHash: 0n,
      limits: 0n,
      rollingCap: 0n,
    });
    expect(onlyEnabled.enabled).toBe(true);
    expect(onlyEnabled.paused).toBe(false);
  });

  /** A nonce large enough to collide with the flags if the mask were wrong. */
  it("keeps a large nonce out of the flag bytes", () => {
    const config = decodeInvestmentConfiguration({
      packed: ((1n << 64n) - 1n) | (1n << 64n) | (1n << 72n),
      adapterId: 0n,
      basketHash: 0n,
      limits: 0n,
      rollingCap: 0n,
    });
    expect(config.policyNonce).toBe((1n << 64n) - 1n);
    expect(config.enabled).toBe(true);
    expect(config.paused).toBe(true);
  });

  /**
   * The two limits share a word, low half first. Deliberately different values
   * an order of magnitude apart: equal ones would let a swapped decode pass.
   */
  it("puts the threshold in the low half and the per-call ceiling in the high", () => {
    const min = 300_000_000_000_000n;
    const perCall = 5_000_000_000_000_000_000n;
    const config = decodeInvestmentConfiguration({
      packed: 0n,
      adapterId: 0n,
      basketHash: 0n,
      limits: min | (perCall << 128n),
      rollingCap: 42n,
    });
    expect(config.minInvestmentWei).toBe(min);
    expect(config.maxPerCallWei).toBe(perCall);
    expect(config.maxRolling30dWei).toBe(42n);
  });

  it("renders hashes as full words rather than trimming leading zeros", () => {
    const config = decodeInvestmentConfiguration({
      packed: 0n,
      adapterId: 1n,
      basketHash: 255n,
      limits: 0n,
      rollingCap: 0n,
    });
    expect(config.adapterId).toBe(`0x${"0".repeat(63)}1`);
    expect(config.basketHash).toBe(`0x${"0".repeat(62)}ff`);
  });
});

describe("lifetime totals", () => {
  /**
   * Read from the live vault: S+46 is 0x…0171ca9109d70f, which is
   * 406,589,807,384,335 wei of lifetime CONTRIBUTIONS with the upper half clean.
   * `aggregateLifetimeInvested` packs into that upper half, so it must read zero
   * — a decoder taking the whole word would report the contributions as if the
   * vault had already invested them.
   */
  it("reads zero invested from the live vault's word", () => {
    expect(decodeLifetimeInvested(0x171ca9109d70fn)).toBe(0n);
  });

  it("reads the upper half when there is one", () => {
    const invested = 123_456_789n;
    expect(decodeLifetimeInvested(0x171ca9109d70fn | (invested << 128n))).toBe(invested);
  });
});

describe("pool state", () => {
  /** The live WETH/USDG slot0, whose low 160 bits are the price. */
  it("takes sqrtPriceX96 from the low 160 bits", () => {
    const sqrtP = 3435887068360568108188696n;
    // Real slot0 words carry tick and fee data above the price.
    const withUpperBits = sqrtP | (12345n << 160n);
    expect(decodeSqrtPriceX96(withUpperBits)).toBe(sqrtP);
  });
});

/**
 * THE FEE, AND THE BUG THAT HID IN IT.
 *
 * These two words are real `slot0` values, read from the pinned mainnet pools.
 * They exist because `decodeSwapFeePips` was added to fix a 6.23 bps error and
 * had NO coverage at all: the quote tests carry `feePips: 625` as a literal, so
 * mutating the decoder to ignore the protocol fee entirely — the original bug —
 * broke nothing. A fix with no test is a fix waiting to be undone.
 */
describe("the effective swap fee", () => {
  // WETH/USDG: lpFee 500, protocolFee 125 -> 625
  const WETH_USDG_SLOT0 = 205700626957838899953564782158229023648850915035853007021591302797n;
  // USDG/NVDA: lpFee 3000, protocolFee 500 -> 3499
  const USDG_NVDA_SLOT0 = 1234178647065076656731217521463323191303702096311274296337420321123n;

  it("composes the protocol fee with the lp fee, from real mainnet words", () => {
    expect(decodeSwapFeePips(WETH_USDG_SLOT0, true)).toBe(625);
    expect(decodeSwapFeePips(USDG_NVDA_SLOT0, true)).toBe(3499);
  });

  /**
   * THE FAILURE THAT ACTUALLY HAPPENED: taking the PoolKey's fee, which is the
   * lpFee alone. Asserting the decoded value is NOT 500 or 3000 pins the
   * distinction rather than the arithmetic.
   */
  it("does not return the lp fee alone, which is what the PoolKey carries", () => {
    expect(decodeSwapFeePips(WETH_USDG_SLOT0, true)).not.toBe(500);
    expect(decodeSwapFeePips(USDG_NVDA_SLOT0, true)).not.toBe(3000);
  });

  /**
   * Price and fee share one word and must not bleed into each other.
   *
   * The price is asserted as a RANGE, not a constant: it is a live pool and it
   * moved between two reads a few minutes apart while the fees did not. Pinning
   * the exact number would make this test fail for the one reason that is not a
   * bug.
   */
  it("reads sqrtPriceX96 and the fee out of the same word without collision", () => {
    const sqrtP = decodeSqrtPriceX96(WETH_USDG_SLOT0);
    expect(sqrtP).toBeGreaterThan(3n * 10n ** 24n);
    expect(sqrtP).toBeLessThan(4n * 10n ** 24n);
    expect(sqrtP).toBeLessThan(1n << 160n);
    expect(decodeSwapFeePips(WETH_USDG_SLOT0, true)).toBe(625);
  });

  /** The two directions are separate 12-bit halves, not one number. */
  it("takes the half matching the direction of the swap", () => {
    // protocolFee = 0x111 one-for-zero, 0x222 zero-for-one; lpFee 3000.
    const word = (0x111n << 12n) | 0x222n;
    const slot0 = (word << 184n) | (3000n << 208n);
    const zeroForOne = decodeSwapFeePips(slot0, true);
    const oneForZero = decodeSwapFeePips(slot0, false);
    expect(zeroForOne).not.toBe(oneForZero);
    // 0x222 = 546, 0x111 = 273, each composed with lpFee 3000.
    expect(zeroForOne).toBe(546 + 3000 - Math.floor((546 * 3000) / 1_000_000));
    expect(oneForZero).toBe(273 + 3000 - Math.floor((273 * 3000) / 1_000_000));
  });

  /** A pool with no protocol fee is the lpFee, and that must still work. */
  it("returns the lp fee when there is no protocol fee", () => {
    expect(decodeSwapFeePips(3000n << 208n, true)).toBe(3000);
  });
});

describe("ordering a pair", () => {
  /**
   * An inverted PoolKey is not an error anywhere — it hashes to a pool that does
   * not exist, every read returns zero, and the keeper reports "the pinned pool
   * is empty". Cause and symptom are far apart, so the ordering is done here.
   */
  it("sorts by address regardless of argument order", () => {
    const a = orderPair(WETH, USDG);
    const b = orderPair(USDG, WETH);
    expect(a).toEqual(b);
    expect(a.currency0).toBe(WETH);
    expect(a.currency1).toBe(USDG);
  });

  it("matches the sort the adapter's pinned keys assume", () => {
    // WETH 0x0bd7… < USDG 0x5fc5… < NVDA 0xd060…
    expect(orderPair(WETH, USDG).currency0).toBe(WETH);
    expect(orderPair(USDG, NVDA).currency0).toBe(USDG);
    // So the route spends currency0 on both hops.
    expect(orderPair(WETH, USDG).zeroForOneIs).toBe(WETH);
    expect(orderPair(USDG, NVDA).zeroForOneIs).toBe(USDG);
  });
});
