// What a per-trade span owes (src/per-trade-base.ts): which trades count, what
// each was worth, the arithmetic the program checks (ADR §5.2.4), the cap and
// the day, the cadence (§5.5), and the oracle check held before signing
// (§5.2.5, RT-1).

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ORACLE_FRESH_SECONDS,
  dayIndexOf,
  oracleRefusal,
  perTradeCadence,
  perTradeCharge,
  perTradePaid,
  signatureBytes,
  type PerTradePolicyParams,
  type TradePrice,
} from "../src/per-trade-base.js";
import { MODE_FIXED, MODE_PROFIT, MODE_ROUNDUP, MODE_VOLUME, pricesHash, roundupBoundLamports } from "../src/program-scripts.js";
import { PYTH_SOL_USD_FEED_ID_HEX, decodePythPriceUpdate } from "../src/pyth.js";
import { PER_TRADE_MAX_WAIT_SECONDS } from "../src/role-registry.js";
import { base58, pythSolUsdBytes, signatureFor, trade } from "./per-trade-fixtures.js";

/** ADR §5.2.4's worked example: SOL at $150, a $1 unit, a $1 minimum. */
const P150 = 150_000_000n;
const POLICY: PerTradePolicyParams = {
  roundupUnitCents: 100,
  fixedLamports: 1_000_000,
  minTradeCents: 100,
  minTradeLamports: 10_000_000,
  dailyCapLamports: 300_000_000n,
  dayIndex: 0,
  daySavedLamports: 0n,
};
const at150: (t: unknown) => TradePrice = () => ({ priceUsdE6: P150, source: "tape" });
const NOW = 1_800_000_000;

describe("perTradeCharge: ROUND-UP", () => {
  it("prices the ADR's $1.60 trade at $150 to exactly 2,666,666 lamports", () => {
    const charge = perTradeCharge({ mode: MODE_ROUNDUP, trades: [trade("a", 500, 10_666_667n, NOW)], boundarySlot: null, policy: POLICY, priceOf: at150, settlePriceUsdE6: P150 });
    expect(charge.amountLamports).toBe(2_666_666n);
    expect(charge.tradeCount).toBe(1);
    expect(charge.priceMinUsdE6).toBe(P150);
    expect(charge.modeParam).toBe(100n);
    expect(charge.minTrade).toBe(100n);
    expect(charge.rows[0]).toMatchObject({ status: "charged", worthUsdE6: 1_600_000n, owedLamports: 2_666_666n, priceSource: "tape" });
    // Within the bound the program holds it to: count × ⌈u·10⁹ / price_min⌉.
    expect(charge.amountLamports <= roundupBoundLamports(1, 100, P150)).toBe(true);
  });

  it("saves nothing on an exact multiple, never more than the trade itself, and floors in the trader's favour", () => {
    // $2.00 exactly: 13,333,334 lamports is $2.0000001 → X = 2,000,000 µ$ → r = 0.
    const exact = perTradeCharge({ mode: MODE_ROUNDUP, trades: [trade("e", 1, 13_333_334n, NOW)], boundarySlot: null, policy: POLICY, priceOf: at150, settlePriceUsdE6: P150 });
    expect(exact.amountLamports).toBe(0n);
    expect(exact.tradeCount).toBe(1);
    // A $1 unit with a $0 minimum: a dust trade of $0.30 saves at most its own $0.30.
    const dust = perTradeCharge({
      mode: MODE_ROUNDUP,
      trades: [trade("d", 1, 2_000_000n, NOW)],
      boundarySlot: null,
      policy: { ...POLICY, minTradeCents: 0 },
      priceOf: at150,
      settlePriceUsdE6: P150,
    });
    const worth = dust.rows[0]!.worthUsdE6!;
    expect(worth).toBe(300_000n);
    // r = min(700 000, 300 000) = 300 000 µ$ → ⌊300 000 · 10⁹ / 1.5·10⁸⌋ = 2 000 000 lamports: the whole trade, never more.
    expect(dust.amountLamports).toBe(2_000_000n);
    expect(dust.amountLamports <= 2_000_000n).toBe(true);
  });

  it("counts only trades above the boundary and at least the minimum, hashing exactly those, by slot", () => {
    const trades = [
      trade("forgiven", 100, 50_000_000n, NOW - 300),
      trade("small", 201, 5_000_000n, NOW - 200), // $0.75 < $1
      trade("late", 203, 20_000_000n, null),
      trade("taped", 202, 10_666_667n, NOW - 100),
    ];
    const priceOf = (t: { readonly blockTime: number | null }): TradePrice =>
      t.blockTime === null ? { priceUsdE6: 160_000_000n, source: "late" } : { priceUsdE6: P150, source: "tape" };
    const charge = perTradeCharge({ mode: MODE_ROUNDUP, trades, boundarySlot: 150n, policy: POLICY, priceOf, settlePriceUsdE6: 160_000_000n });
    expect(charge.rows.map((row) => row.status)).toEqual(["forgiven", "below-minimum", "charged", "charged"]);
    expect(charge.tradeCount).toBe(2);
    expect(charge.latePriced).toBe(1);
    expect(charge.priceMinUsdE6).toBe(P150);
    expect(charge.unagedCharge).toBe(true);
    expect(charge.oldestChargedAt).toBeNull();
    // The hash covers the two charged trades, at their own prices, ordered by slot whatever the walk's order.
    expect(charge.pricesHash.equals(pricesHash([
      { slot: 202n, signature: signatureBytes(signatureFor("taped")), priceUsdE6: P150 },
      { slot: 203n, signature: signatureBytes(signatureFor("late")), priceUsdE6: 160_000_000n },
    ]))).toBe(true);
    // $3.20 at $160 rounds to $4: 0.80 / 160 SOL = 5,000,000 lamports; plus the $1.60 trade's 2,666,666.
    expect(charge.amountLamports).toBe(2_666_666n + 5_000_000n);
  });

  it("signs the settle-time price and sha256 of nothing for a window with nothing charged", () => {
    const charge = perTradeCharge({ mode: MODE_ROUNDUP, trades: [], boundarySlot: null, policy: POLICY, priceOf: at150, settlePriceUsdE6: 151_000_000n });
    expect(charge).toMatchObject({ amountLamports: 0n, tradeCount: 0, priceMinUsdE6: 151_000_000n, oldestChargedAt: null });
    expect(charge.pricesHash.equals(createHash("sha256").digest())).toBe(true);
    expect(() => perTradeCharge({ mode: MODE_ROUNDUP, trades: [], boundarySlot: null, policy: POLICY, priceOf: at150, settlePriceUsdE6: null })).toThrow(/positive price_min/);
  });
});

describe("perTradeCharge: FIXED", () => {
  it("is count × F exactly, counts a SOL leg at the minimum and not under it, and signs no price", () => {
    const trades = [trade("1", 10, 10_000_000n, NOW), trade("2", 11, 9_999_999n, NOW), trade("3", 12, 1_000_000_000n, NOW), trade("0", 5, 50_000_000n, NOW)];
    const charge = perTradeCharge({
      mode: MODE_FIXED,
      trades,
      boundarySlot: 5n,
      policy: POLICY,
      priceOf: () => {
        throw new Error("FIXED is never priced");
      },
      settlePriceUsdE6: null,
    });
    expect(charge.rows.map((row) => row.status)).toEqual(["charged", "below-minimum", "charged", "forgiven"]);
    expect(charge).toMatchObject({ mode: MODE_FIXED, amountLamports: 2_000_000n, tradeCount: 2, priceMinUsdE6: 0n, modeParam: 1_000_000n, minTrade: 10_000_000n, latePriced: 0 });
    expect(charge.pricesHash.equals(Buffer.alloc(32))).toBe(true);
  });

  it("refuses to charge a mode that is not per-trade", () => {
    for (const mode of [MODE_PROFIT, MODE_VOLUME, 4]) {
      expect(() => perTradeCharge({ mode, trades: [], boundarySlot: null, policy: POLICY, priceOf: at150, settlePriceUsdE6: P150 })).toThrow(/not a per-trade mode/);
    }
  });
});

describe("perTradePaid: the per-settle cap and the UTC day's cap, as settle_v3 clips", () => {
  const today = dayIndexOf(NOW);
  it("clips by max_contribution, then by what is left of today, and a new day starts at zero", () => {
    const policy = { dailyCapLamports: 300_000_000n, dayIndex: today, daySavedLamports: 280_000_000n };
    expect(perTradePaid({ amountLamports: 100_000_000n, maxContribution: 60_000_000n, policy, nowSeconds: NOW })).toEqual({ paid: 20_000_000n, headroom: 20_000_000n, today, savedToday: 280_000_000n });
    expect(perTradePaid({ amountLamports: 100_000_000n, maxContribution: 60_000_000n, policy: { ...policy, dayIndex: today - 1 }, nowSeconds: NOW }).paid).toBe(60_000_000n);
    expect(perTradePaid({ amountLamports: 5n, maxContribution: 60_000_000n, policy, nowSeconds: NOW }).paid).toBe(5n);
    expect(perTradePaid({ amountLamports: 5n, maxContribution: 60_000_000n, policy: { ...policy, daySavedLamports: 300_000_000n }, nowSeconds: NOW })).toMatchObject({ paid: 0n, headroom: 0n });
    expect(dayIndexOf(86_399)).toBe(0);
    expect(dayIndexOf(86_400)).toBe(1);
  });
});

describe("perTradeCadence (ADR §5.5)", () => {
  const charged = (amount: bigint, oldest: number | null) => ({ amountLamports: amount, tradeCount: 1, oldestChargedAt: oldest, unagedCharge: oldest === null });
  const args = { maxContribution: 60_000_000n, headroom: 300_000_000n, nowSeconds: NOW, maxWaitSeconds: PER_TRADE_MAX_WAIT_SECONDS };

  it("settles on size at half of max_contribution, on the clock an hour after the oldest trade, and on a trade it cannot age", () => {
    expect(perTradeCadence({ ...args, charge: charged(30_000_000n, NOW) })).toEqual({ settle: true, why: "size" });
    expect(perTradeCadence({ ...args, charge: charged(29_999_999n, NOW - 3_600) })).toEqual({ settle: true, why: "clock" });
    expect(perTradeCadence({ ...args, charge: charged(1n, null) })).toEqual({ settle: true, why: "unaged" });
    expect(perTradeCadence({ ...args, charge: charged(29_999_999n, NOW - 3_599) })).toMatchObject({ settle: false, dueAt: NOW + 1 });
  });

  it("never settles on size at headroom 0, however much is owed", () => {
    expect(perTradeCadence({ ...args, headroom: 0n, charge: charged(10_000_000_000n, NOW - 60) })).toMatchObject({ settle: false, dueAt: NOW - 60 + 3_600 });
    expect(perTradeCadence({ ...args, headroom: 0n, charge: charged(10_000_000_000n, NOW - 60) })).toMatchObject({ detail: expect.stringContaining("daily cap") });
  });

  it("per-trade-cadence: headroom 0 and a trade every minute → ≤ 1 settle per clock period", () => {
    // Six hours of a bot trading every minute, each trade owing far more than
    // half the cap, on a vault already at its daily cap: only the clock may fire.
    let pending: number[] = [];
    let settles = 0;
    const start = NOW;
    for (let minute = 0; minute < 6 * 60; minute++) {
      const now = start + minute * 60;
      pending.push(now);
      const cadence = perTradeCadence({
        maxContribution: 60_000_000n,
        headroom: 0n,
        nowSeconds: now,
        maxWaitSeconds: PER_TRADE_MAX_WAIT_SECONDS,
        charge: { amountLamports: BigInt(pending.length) * 50_000_000n, tradeCount: pending.length, oldestChargedAt: Math.min(...pending), unagedCharge: false },
      });
      if (cadence.settle) {
        settles += 1;
        pending = [];
      }
    }
    expect(settles).toBeGreaterThan(0);
    expect(settles).toBeLessThanOrEqual(6);
  });

  it("is asked only about a span with charged trades", () => {
    expect(() => perTradeCadence({ ...args, charge: { amountLamports: 0n, tradeCount: 0, oldestChargedAt: null, unagedCharge: false } })).toThrow(/charged trades/);
  });
});

describe("oracleRefusal: settle_v3's Pyth floor, held before anything is signed (RT-1)", () => {
  const update = (price: bigint, over: { readonly publishTime?: bigint; readonly variant?: 0 | 1; readonly expo?: number } = {}) =>
    decodePythPriceUpdate(pythSolUsdBytes({ price, publishTime: over.publishTime ?? BigInt(NOW), variant: over.variant ?? 1, expo: over.expo ?? -8 }), PYTH_SOL_USD_FEED_ID_HEX);

  it("passes at exactly half the oracle and refuses a micro-dollar under it", () => {
    // Pyth at $150.00000000 (expo -8); half is $75 = 75,000,000 µ$.
    expect(oracleRefusal(update(15_000_000_000n), 75_000_000n, NOW)).toBeNull();
    expect(oracleRefusal(update(15_000_000_000n), 74_999_999n, NOW)).toMatch(/PriceBelowOracleFloor/);
    // A price ABOVE the oracle only lowers the amount: never refused.
    expect(oracleRefusal(update(15_000_000_000n), 900_000_000n, NOW)).toBeNull();
  });

  it("refuses a price wrong by 10² — the exponent scaled by 10⁴ instead of 10² — before signing", () => {
    // pythPrice 15_000_000_000 at expo -8 read with the wrong scale is $1.50: 1,500,000 µ$.
    expect(oracleRefusal(update(15_000_000_000n), 1_500_000n, NOW)).toMatch(/PriceBelowOracleFloor/);
  });

  it("refuses a feed more than a day stale and a partially verified update, as settle_v3 would", () => {
    expect(oracleRefusal(update(15_000_000_000n, { publishTime: BigInt(NOW - ORACLE_FRESH_SECONDS) }), P150, NOW)).toBeNull();
    expect(oracleRefusal(update(15_000_000_000n, { publishTime: BigInt(NOW - ORACLE_FRESH_SECONDS - 1) }), P150, NOW)).toMatch(/OracleStale/);
    expect(oracleRefusal(update(15_000_000_000n, { variant: 0 }), P150, NOW)).toMatch(/OracleAccountInvalid/);
  });
});

describe("signatureBytes", () => {
  it("decodes a signature's base58 to its 64 raw bytes, leading zeros included, and refuses anything else", () => {
    const raw = Buffer.alloc(64, 7);
    raw[0] = 0;
    raw[1] = 0;
    expect(signatureBytes(base58(raw)).equals(raw)).toBe(true);
    expect(() => signatureBytes("tx-1")).toThrow(/base58/);
    expect(() => signatureBytes(base58(Buffer.alloc(32, 9)))).toThrow(/64 bytes/);
  });
});
