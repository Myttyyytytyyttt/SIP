// TypeScript mirror of programs/sip-vault/src/per_trade.rs: what a per-trade
// window (ROUND-UP = mode 2, FIXED = mode 3) owes, the bound and the price
// floor settle_v3 holds it to, and the prices hash its attestation signs.
//
// THE SAME NUMBERS OR A REFUSAL ON CHAIN. The keeper prices trades with these
// functions and the program checks the result with their Rust twins, so both
// are pinned to tests/fixtures/per-trade-vectors.txt, which a third
// implementation (per-trade-vectors.py, Python's unbounded integers and exact
// fractions) computed from the formulas alone: tests/per-trade-vectors.ts here,
// per_trade.rs's unit tests there.
//
// BIGINT ONLY. Lamports × micro-dollars passes 2^53 for any trade worth a few
// dollars, and passes u64 for large ones, so no `number` carries an amount.
// Every floor rounds in the trader's favour.

import { createHash } from "node:crypto";

export const MICRO_USD_PER_CENT = 10_000n;
export const LAMPORTS_PER_SOL = 1_000_000_000n;
const U64_MAX = (1n << 64n) - 1n;
const U32_MAX = 0xffff_ffff;

/** No price feed's exponent is further from zero; settle_v3 refuses one that is. */
export const PYTH_MAX_EXPO = 18;

function u64(value: bigint, what: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value > U64_MAX) throw new RangeError(`${what} is a u64 bigint, not ${String(value)}`);
  return value;
}

function u16(value: number, what: string): bigint {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new RangeError(`${what} is a u16, not ${value}`);
  return BigInt(value);
}

function u32(value: number, what: string): bigint {
  if (!Number.isInteger(value) || value < 0 || value > U32_MAX) throw new RangeError(`${what} is a u32, not ${value}`);
  return BigInt(value);
}

/**
 * One counted trade's round-up in lamports. The trade is worth
 * X = ⌊x·p / 10⁹⌋ micro-dollars; it saves r = min((u − X mod u) mod u, X) with
 * u = unitCents × 10⁴, so an exact multiple saves 0 and no trade saves more than
 * itself; r is paid as ⌊r·10⁹ / p⌋ lamports. Throws on a zero price or unit.
 */
export function roundupTradeLamports(xLamports: bigint, priceUsdE6: bigint, unitCents: number): bigint {
  const x = u64(xLamports, "the trade's lamports");
  const p = u64(priceUsdE6, "the price");
  const u = u16(unitCents, "the unit") * MICRO_USD_PER_CENT;
  if (p === 0n) throw new RangeError("a round-up needs a price above zero");
  if (u === 0n) throw new RangeError("a round-up needs a unit above zero");
  const worth = (x * p) / LAMPORTS_PER_SOL;
  const roundUp = (u - (worth % u)) % u;
  return ((roundUp < worth ? roundUp : worth) * LAMPORTS_PER_SOL) / p;
}

/** The most a ROUND-UP window may owe on chain: tradeCount × ⌈u·10⁹ / priceMin⌉. */
export function roundupBoundLamports(tradeCount: number, unitCents: number, priceMinUsdE6: bigint): bigint {
  const count = u32(tradeCount, "the trade count");
  const u = u16(unitCents, "the unit") * MICRO_USD_PER_CENT;
  const priceMin = u64(priceMinUsdE6, "the lowest price");
  if (priceMin === 0n) throw new RangeError("a round-up bound needs a price above zero");
  const numerator = u * LAMPORTS_PER_SOL;
  return count * ((numerator + priceMin - 1n) / priceMin);
}

/** What a FIXED window owes: tradeCount × F, exactly. */
export function fixedAmountLamports(tradeCount: number, fixedLamports: number): bigint {
  return u32(tradeCount, "the trade count") * u32(fixedLamports, "the fixed amount");
}

/**
 * Whether settle_v3 accepts `priceMinUsdE6` against a Pyth price: at least half
 * of it, compared exactly (2 × priceMin × 10⁻⁶ ≥ price × 10^expo, no rounding).
 * A non-positive price or an exponent beyond ±18 never holds.
 */
export function pythFloorHolds(priceMinUsdE6: bigint, pythPrice: bigint, pythExpo: number): boolean {
  const priceMin = u64(priceMinUsdE6, "the lowest price");
  if (typeof pythPrice !== "bigint" || pythPrice <= 0n) return false;
  if (!Number.isInteger(pythExpo) || pythExpo < -PYTH_MAX_EXPO || pythExpo > PYTH_MAX_EXPO) return false;
  const shift = -6 - pythExpo;
  return shift >= 0 ? 2n * priceMin * 10n ** BigInt(shift) >= pythPrice : 2n * priceMin >= pythPrice * 10n ** BigInt(-shift);
}

export interface PricedTrade {
  readonly slot: bigint;
  /** The transaction signature's 64 raw bytes. */
  readonly signature: Uint8Array;
  /** The SOL/USD price the trade was valued at, micro-dollars per SOL. */
  readonly priceUsdE6: bigint;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  return Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(b.buffer, b.byteOffset, b.byteLength));
}

/**
 * The prices hash a ROUND-UP attestation signs: sha256 over
 * (signature 64 ‖ priceUsdE6 u64 LE) of every counted trade, ordered by slot,
 * then by the signature's raw bytes. Anyone holding the per-trade rows can
 * recompute it. The empty window hashes to sha256 of nothing.
 */
export function pricesHash(trades: readonly PricedTrade[]): Buffer {
  for (const trade of trades) {
    if (trade.signature.length !== 64) throw new RangeError(`a signature is 64 bytes, not ${trade.signature.length}`);
    u64(trade.slot, "a trade's slot");
    u64(trade.priceUsdE6, "a trade's price");
  }
  const ordered = [...trades].sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : compareBytes(a.signature, b.signature)));
  const hash = createHash("sha256");
  for (const trade of ordered) {
    const price = Buffer.alloc(8);
    price.writeBigUInt64LE(trade.priceUsdE6);
    hash.update(trade.signature);
    hash.update(price);
  }
  return hash.digest();
}

/** settle_v3's four prices_hash arguments: word i is bytes 8i..8i+8 of the hash, little-endian. */
export function pricesHashWords(hash: Uint8Array): [bigint, bigint, bigint, bigint] {
  if (hash.length !== 32) throw new RangeError(`a prices hash is 32 bytes, not ${hash.length}`);
  const bytes = Buffer.from(hash.buffer, hash.byteOffset, hash.byteLength);
  return [0, 1, 2, 3].map((index) => bytes.readBigUInt64LE(index * 8)) as [bigint, bigint, bigint, bigint];
}
