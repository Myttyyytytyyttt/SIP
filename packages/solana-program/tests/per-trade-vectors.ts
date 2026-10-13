// scripts/per-trade.ts against the shared vectors: the same file
// programs/sip-vault/src/per_trade.rs's unit tests read, which
// tests/fixtures/per-trade-vectors.py computed from the formulas alone.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert } from "chai";
import {
  fixedAmountLamports,
  pricesHash,
  pricesHashWords,
  pythFloorHolds,
  roundupBoundLamports,
  roundupTradeLamports,
} from "../scripts/per-trade";

const VECTORS = readFileSync(join(__dirname, "fixtures", "per-trade-vectors.txt"), "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "" && !line.startsWith("#"))
  .map((line) => line.trim().split(/\s+/));
const rows = (kind: string) => VECTORS.filter((fields) => fields[0] === kind).map((fields) => fields.slice(1));

describe("per-trade arithmetic, against the shared vectors", () => {
  it("round-up: every vector, and never more than the trade itself", () => {
    const vectors = rows("roundup");
    assert.isAtLeast(vectors.length, 10);
    for (const [x, p, unit, , , lamports] of vectors) {
      const got = roundupTradeLamports(BigInt(x), BigInt(p), Number(unit));
      assert.strictEqual(got, BigInt(lamports), `x ${x} p ${p} unit ${unit}`);
      assert.isTrue(got <= BigInt(x));
    }
  });

  it("round-up: the owner's $1.60 at $150 saves $0.40, 2,666,666 lamports", () => {
    assert.strictEqual(roundupTradeLamports(10_666_667n, 150_000_000n, 100), 2_666_666n);
  });

  it("round-up: refuses to guess without a price or a unit", () => {
    assert.throws(() => roundupTradeLamports(1n, 0n, 100), /price/);
    assert.throws(() => roundupTradeLamports(1n, 1n, 0), /unit/);
    assert.throws(() => roundupTradeLamports(-1n, 1n, 100), /u64/);
    assert.throws(() => roundupTradeLamports(1n << 64n, 1n, 100), /u64/);
  });

  it("the bound: every vector", () => {
    const vectors = rows("bound");
    assert.isAtLeast(vectors.length, 5);
    for (const [count, unit, priceMin, bound] of vectors) {
      assert.strictEqual(roundupBoundLamports(Number(count), Number(unit), BigInt(priceMin)), BigInt(bound));
    }
  });

  it("the Pyth floor: every vector", () => {
    const vectors = rows("floor");
    assert.isAtLeast(vectors.length, 10);
    for (const [priceMin, price, expo, holds] of vectors) {
      assert.strictEqual(pythFloorHolds(BigInt(priceMin), BigInt(price), Number(expo)), holds === "1", `${priceMin} vs ${price}e${expo}`);
    }
  });

  it("fixed: trade count times F", () => {
    assert.strictEqual(fixedAmountLamports(7, 1_000_000), 7_000_000n);
    assert.strictEqual(fixedAmountLamports(0xffff_ffff, 100_000_000), 429_496_729_500_000_000n);
  });

  it("the prices hash: every vector, ordered by slot and then by signature bytes", () => {
    const one = Buffer.alloc(64, 0x11);
    const two = Buffer.alloc(64, 0x22);
    const named: Record<string, Buffer> = {
      empty: pricesHash([]),
      one: pricesHash([{ slot: 500n, signature: one, priceUsdE6: 150_000_000n }]),
      two_slots: pricesHash([
        { slot: 501n, signature: one, priceUsdE6: 151_234_567n },
        { slot: 500n, signature: two, priceUsdE6: 150_000_000n },
      ]),
      two_same_slot: pricesHash([
        { slot: 500n, signature: two, priceUsdE6: 150_000_000n },
        { slot: 500n, signature: one, priceUsdE6: 151_234_567n },
      ]),
    };
    const vectors = rows("priceshash");
    assert.strictEqual(vectors.length, Object.keys(named).length);
    for (const [name, hex] of vectors) assert.strictEqual(named[name]?.toString("hex"), hex, name);
    assert.throws(() => pricesHash([{ slot: 1n, signature: Buffer.alloc(63), priceUsdE6: 1n }]), /64 bytes/);
    assert.throws(() => pricesHashWords(Buffer.alloc(31)), /32 bytes/);
  });
});
