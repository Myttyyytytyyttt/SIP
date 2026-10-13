// The per-trade price tape (src/price-tape.ts; ADR §5.2.3): what a sample is,
// which sample a trade gets, the sampler's bookkeeping, and the golden path from
// the committed mainnet Pyth bytes to an attested round-up amount.

import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { MAX_PYTH_AGE_SECONDS, MAX_PYTH_CONF_BPS } from "../src/invest-decision.js";
import { perTradeCharge, signatureBytes } from "../src/per-trade-base.js";
import {
  MemoryPriceTape,
  TAPE_LOOKUP_SECONDS,
  TAPE_MAX_AGE_SECONDS,
  TAPE_MAX_CONF_BPS,
  TAPE_PENDING_MAX,
  TAPE_RETENTION_DAYS,
  TapeSampler,
  pickSample,
  sampleSolUsd,
  toUsdE6,
  type PriceTapeWriter,
  type TapeSample,
} from "../src/price-tape.js";
import { MODE_ROUNDUP, attestationV3Message, pricesHash } from "../src/program-scripts.js";
import { PYTH_RECEIVER_PROGRAM } from "../src/pyth.js";
import { pythSolUsdBytes, trade } from "./per-trade-fixtures.js";

const NOW = 1_800_000_000;
const sol = (price: bigint, publishTime: number, conf?: bigint) => ({ owner: PYTH_RECEIVER_PROGRAM, data: pythSolUsdBytes({ price, publishTime: BigInt(publishTime), ...(conf === undefined ? {} : { conf }) }) });
const sample = (publishTime: number, priceE6 = 150_000_000n): TapeSample => ({ publishTime, slot: BigInt(publishTime), priceE6, confE6: 0n });

describe("the tape's rules are the invest guard's", () => {
  it("keeps a read only within 60 s and 50 bps, invest-decision.ts's own MAX_PYTH_AGE_SECONDS and MAX_PYTH_CONF_BPS", () => {
    expect(BigInt(TAPE_MAX_AGE_SECONDS)).toBe(MAX_PYTH_AGE_SECONDS);
    expect(TAPE_MAX_CONF_BPS).toBe(MAX_PYTH_CONF_BPS);
    expect(TAPE_LOOKUP_SECONDS).toBe(120);
    expect(TAPE_RETENTION_DAYS).toBe(35);
  });
});

describe("toUsdE6", () => {
  it("converts Pyth's exponent to micro-dollars, flooring", () => {
    expect(toUsdE6(15_000_000_099n, -8)).toBe(150_000_000n);
    expect(toUsdE6(150_000_000n, -6)).toBe(150_000_000n);
    expect(toUsdE6(1_500_000n, -4)).toBe(150_000_000n);
  });
});

describe("sampleSolUsd: what the sampler keeps", () => {
  it("keeps a fresh, tight SOL/USD read from the receiver, in micro-dollars", () => {
    expect(sampleSolUsd(sol(15_012_345_678n, NOW - 60), NOW, 7n)).toEqual({ sample: { publishTime: NOW - 60, slot: 7n, priceE6: 150_123_456n, confE6: 15_012n } });
    // Published ahead of the sampler's clock: fresher than the clock can tell, and kept.
    expect(sampleSolUsd(sol(15_000_000_000n, NOW + 5), NOW, 7n)).toHaveProperty("sample");
  });

  it("rejects every read it must not price a trade with, and says why", () => {
    const reason = (info: Parameters<typeof sampleSolUsd>[0]) => {
      const read = sampleSolUsd(info, NOW, 1n);
      return "rejected" in read ? read.rejected : "kept";
    };
    expect(reason(null)).toBe("missing");
    expect(reason({ owner: Keypair.generate().publicKey, data: sol(1n, NOW).data })).toBe("wrong-owner");
    expect(reason({ owner: PYTH_RECEIVER_PROGRAM, data: pythSolUsdBytes({ price: 1n, publishTime: BigInt(NOW), feedIdHex: "11".repeat(32) }) })).toBe("undecodable");
    expect(reason({ owner: PYTH_RECEIVER_PROGRAM, data: Buffer.alloc(134) })).toBe("undecodable");
    expect(reason(sol(-5n, NOW))).toBe("not-a-price");
    expect(reason(sol(15_000_000_000n, NOW - 61))).toBe("stale");
    // 50 bps is the ceiling; 51 is past it.
    expect(reason(sol(10_000_000_000n, NOW, 50_000_000n))).toBe("kept");
    expect(reason(sol(10_000_000_000n, NOW, 51_000_000n))).toBe("wide");
  });
});

describe("pickSample: the trade's price", () => {
  const tape = [sample(1_000), sample(1_060), sample(1_300)];
  it("takes the newest at or before the trade within 120 s", () => {
    expect(pickSample(tape, 1_000)?.publishTime).toBe(1_000);
    expect(pickSample(tape, 1_059)?.publishTime).toBe(1_000);
    expect(pickSample(tape, 1_180)?.publishTime).toBe(1_060);
  });
  it("else the oldest after it within 120 s", () => {
    expect(pickSample(tape, 940)?.publishTime).toBe(1_000);
    expect(pickSample(tape, 1_181)?.publishTime).toBe(1_300);
  });
  it("else none: the trade is priced late", () => {
    expect(pickSample(tape, 879)).toBeNull();
    expect(pickSample([sample(1_000)], 1_121)).toBeNull();
    expect(pickSample([], 1_000)).toBeNull();
  });
});

describe("MemoryPriceTape", () => {
  it("keeps the first sample of a publish, prunes by publish time, and answers every time", async () => {
    const tape = new MemoryPriceTape();
    await tape.record(sample(1_000, 1n));
    await tape.record(sample(1_000, 2n));
    await tape.record(sample(2_000));
    expect(tape.size).toBe(2);
    expect((await tape.pricesAt([1_010, 5_000])).get(1_010)?.priceE6).toBe(1n);
    expect((await tape.pricesAt([5_000])).get(5_000)).toBeNull();
    expect(await tape.prune(1_500)).toBe(1);
    expect(tape.size).toBe(1);
  });
});

describe("TapeSampler", () => {
  it("writes each new publish once, counts repeats and rejections, and reports them", async () => {
    const tape = new MemoryPriceTape();
    const sampler = new TapeSampler(tape);
    expect(await sampler.sample(sol(15_000_000_000n, NOW - 1), NOW, 1n)).toEqual({ kind: "written" });
    expect(await sampler.sample(sol(15_000_000_000n, NOW - 1), NOW + 1, 2n)).toEqual({ kind: "repeated" });
    expect(await sampler.sample(sol(15_000_000_000n, NOW - 100), NOW, 3n)).toMatchObject({ kind: "rejected", reason: "stale" });
    expect(await sampler.sample(null, NOW, 4n)).toMatchObject({ kind: "rejected", reason: "missing" });
    expect(tape.size).toBe(1);
    expect(sampler.status()).toMatchObject({ sampled: 4, written: 1, repeated: 1, rejected: { stale: 1, missing: 1 }, pending: 0, writeFailures: 0, lastPublishTime: NOW - 1 });
  });

  it("holds what Postgres would not take and writes it, oldest first, once it does", async () => {
    const written: number[] = [];
    let down = true;
    const writer: PriceTapeWriter = {
      record: async (s) => {
        if (down) throw new Error("connection refused");
        written.push(s.publishTime);
      },
      prune: async () => 0,
    };
    const sampler = new TapeSampler(writer);
    expect(await sampler.sample(sol(15_000_000_000n, NOW), NOW, 1n)).toEqual({ kind: "held" });
    expect(await sampler.sample(sol(15_000_000_000n, NOW + 1), NOW + 1, 2n)).toEqual({ kind: "held" });
    expect(sampler.status()).toMatchObject({ pending: 2, writeFailures: 2 });
    down = false;
    // The same publish read again still flushes what was held.
    expect(await sampler.sample(sol(15_000_000_000n, NOW + 1), NOW + 2, 3n)).toEqual({ kind: "repeated" });
    expect(written).toEqual([NOW, NOW + 1]);
    expect(sampler.status().pending).toBe(0);
  });

  it("holds at most TAPE_PENDING_MAX, dropping the oldest", async () => {
    const sampler = new TapeSampler({ record: async () => Promise.reject(new Error("down")), prune: async () => 0 });
    for (let i = 0; i < TAPE_PENDING_MAX + 5; i++) await sampler.sample(sol(15_000_000_000n, NOW + i), NOW + i, BigInt(i));
    expect(sampler.status().pending).toBe(TAPE_PENDING_MAX);
  });

  it("prunes 35 days back, at most hourly", async () => {
    const cuts: number[] = [];
    const sampler = new TapeSampler({ record: async () => undefined, prune: async (before) => (cuts.push(before), 3) });
    expect(await sampler.prune(NOW)).toBe(3);
    expect(await sampler.prune(NOW + 3_599)).toBeNull();
    expect(await sampler.prune(NOW + 3_600)).toBe(3);
    expect(cuts).toEqual([NOW - 35 * 86_400, NOW + 3_600 - 35 * 86_400]);
  });
});

describe("pyth-fixture-to-attested-amount (ADR §5.2.5's golden path)", () => {
  // The committed mainnet SOL/USD account (packages/solana-core/test/fixtures/pyth-accounts.ts):
  // price 10_259_321_149 at expo -8, published at 1_789_699_386.
  const FIXTURES = "pyth-accounts";
  it("goes from the receiver's bytes to the sample, the round-up and the signed amount, every number computed independently", async () => {
    const core = (await import(`../../solana-core/test/fixtures/${FIXTURES}.ts`)) as { readonly PYTH_SOL_USD_ACCOUNT: Uint8Array; readonly PYTH_FIXTURE_PUBLISH_TIME: bigint };
    const publish = Number(core.PYTH_FIXTURE_PUBLISH_TIME);
    const read = sampleSolUsd({ owner: PYTH_RECEIVER_PROGRAM, data: core.PYTH_SOL_USD_ACCOUNT }, publish + 15, 447_956_907n);
    expect(read).toEqual({ sample: { publishTime: 1_789_699_386, slot: 447_956_907n, priceE6: 102_593_211n, confE6: 13_845n } });
    const tape = new MemoryPriceTape();
    await tape.record((read as { sample: TapeSample }).sample);
    // Two trades a few seconds after the publish: 0.01 SOL ($1.025932) and 0.123456789 SOL ($12.665828).
    const trades = [trade("golden-1", 500, 10_000_000n, publish + 4), trade("golden-2", 501, 123_456_789n, publish + 9)];
    const prices = await tape.pricesAt(trades.map((t) => t.blockTime!));
    const charge = perTradeCharge({
      mode: MODE_ROUNDUP,
      trades,
      boundarySlot: null,
      policy: { roundupUnitCents: 100, fixedLamports: 1_000_000, minTradeCents: 100, minTradeLamports: 10_000_000, dailyCapLamports: 300_000_000n, dayIndex: 0, daySavedLamports: 0n },
      priceOf: (t) => ({ priceUsdE6: prices.get(t.blockTime!)!.priceE6, source: "tape" }),
      settlePriceUsdE6: 102_593_211n,
    });
    // Python's integers, from the formulas alone: 9_494_468 + 3_257_252.
    expect(charge.rows.map((row) => row.owedLamports)).toEqual([9_494_468n, 3_257_252n]);
    expect(charge.amountLamports).toBe(12_751_720n);
    const message = attestationV3Message({
      programId: new PublicKey(Buffer.alloc(32, 1)),
      wallet: new PublicKey(Buffer.alloc(32, 2)),
      vault: new PublicKey(Buffer.alloc(32, 3)),
      linkEpoch: 1n,
      settlementNonce: 0n,
      sessionStartSlot: 400n,
      sessionEndSlot: 501n,
      amountLamports: charge.amountLamports,
      mode: MODE_ROUNDUP,
      policyNonce: 2n,
      validUntilSlot: 700n,
      tradeCount: charge.tradeCount,
      priceMinUsdE6: charge.priceMinUsdE6,
      modeParam: charge.modeParam,
      minTrade: charge.minTrade,
      pricesHash: charge.pricesHash,
    });
    expect(message.readBigUInt64LE(144)).toBe(12_751_720n);
    expect(message.readUInt32LE(169)).toBe(2);
    expect(message.readBigUInt64LE(173)).toBe(102_593_211n);
    expect(message.subarray(197).equals(pricesHash(trades.map((t) => ({ slot: t.slot, signature: signatureBytes(t.signature), priceUsdE6: 102_593_211n }))))).toBe(true);
  });
});
