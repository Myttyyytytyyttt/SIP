// A synthetic fleet of linked wallets, and the account bytes the chain would
// hold for them.
//
// NOTHING HERE RUNS IN PRODUCTION. src/bench/ exists for
// scripts/ceiling-bench.mts and its tests; no file the keeper boots imports it,
// and nothing in it is reachable from a settle, an invest or a refusal.
//
// THE BYTES ARE THE POINT. The bench drives the keeper's REAL sweep — the loop
// in bin/keeper.mts, unmodified — so every account this fleet serves is read by
// the keeper's own readers (src/accounts.ts) through Anchor's own coder. A
// fleet of plausible-looking JSON would be refused by those readers and the
// bench would measure a sweep of nothing but failures. Every layout below is
// state.rs's, field by field, in the same shape test/accounts.test.ts pins.
//
// WHAT MAKES A LINK IDLE OR HOT. The settle turn's first act is one cheap probe:
// getSignaturesForAddress(wallet, limit 1) at confirmed. A newest signature at
// or below the link's frontier is an IDLE user and the turn rests there —
// after which runInvestTick STILL RUNS, which is why an idle user costs six
// round trips and not one. A signature above the frontier is a HOT user, and the
// turn walks the window one getTransaction per transaction, sequentially. Those
// are the two costs the ceiling is made of, and the ratio between them is a
// parameter because a fleet where 1 % traded this minute behaves nothing like
// one where half of it did.

import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { investmentPolicyAddress } from "../accounts.js";
import { RAYDIUM_CLMM_PROGRAM, USDC_MINT } from "../invest-decision.js";
import { accountDiscriminator } from "../idl.js";

/** Solana's own rent: (128 + len) bytes at 3480 lamports per byte-year, two years exempt. */
export const rentExempt = (dataLength: number): number => (128 + dataLength) * 3480 * 2;

/** state.rs Vault is 125 bytes; a vault holding EXACTLY its rent floor has no free lamports to wrap. */
export const VAULT_SPACE = 125;
/** state.rs TradingLink: disc(8) wallet(32) vault(32) epoch(8) nonce(8) frontier(8) bump(1) reserved(32). */
export const TRADING_LINK_SPACE = 129;
/** state.rs ProtocolConfig. */
export const PROTOCOL_CONFIG_SPACE = 203;
/** state.rs InvestmentPolicy: the space of eight legs, however many are used. */
export const INVESTMENT_POLICY_SPACE = 970;

/** A deterministic, seed-derived 32-byte address. Off-curve is fine: nothing here signs. */
export function benchKey(seed: string): PublicKey {
  return new PublicKey(createHash("sha256").update(`sip-ceiling-bench:${seed}`).digest());
}

/** A deterministic 64-byte signature, base58, of the length the chain's really are. */
export function benchSignature(seed: string): string {
  const digest = createHash("sha512").update(`sip-ceiling-bench-sig:${seed}`).digest();
  return base58(digest);
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** base58, so the bench depends on no encoder the keeper does not already carry. */
export function base58(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let out = "";
  while (value > 0n) {
    out = B58[Number(value % 58n)]! + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out === "" ? "1" : out;
}

export interface BenchLink {
  readonly index: number;
  readonly linkAddress: PublicKey;
  readonly wallet: PublicKey;
  readonly vault: PublicKey;
  readonly policy: PublicKey;
  /** The settled frontier. The probe compares the newest signature's slot against it. */
  readonly frontierSlot: number;
  /** Transactions this wallet has above its frontier: 0 for an idle user. */
  readonly txAbove: number;
}

export interface FleetShape {
  /** How many links getProgramAccounts returns. */
  readonly links: number;
  /** The fraction of them with something to settle, 0..1. */
  readonly hotRatio: number;
  /** Transactions above the frontier for each hot link. The walk reads the oldest 300 of them. */
  readonly hotTxCount: number;
  readonly programId: PublicKey;
  readonly seed: number;
}

/**
 * The fleet a sweep discovers.
 *
 * THE HOT ONES ARE FIRST, DELIBERATELY. Real fleets interleave, but the sweep is
 * a sequential loop and the bench's question is how long the whole pass takes,
 * which is a sum and does not care about the order. Putting them first makes the
 * log readable: the expensive turns are visibly at the top of the pass.
 */
export function buildFleet(shape: FleetShape): readonly BenchLink[] {
  if (!Number.isInteger(shape.links) || shape.links < 0) throw new Error(`a fleet holds a whole number of links, not ${shape.links}`);
  if (!(shape.hotRatio >= 0 && shape.hotRatio <= 1)) throw new Error(`hotRatio is a fraction of the fleet in 0..1, not ${shape.hotRatio}`);
  const hot = Math.round(shape.links * shape.hotRatio);
  const links: BenchLink[] = [];
  for (let index = 0; index < shape.links; index++) {
    const wallet = benchKey(`${shape.seed}:wallet:${index}`);
    const vault = benchKey(`${shape.seed}:vault:${index}`);
    links.push({
      index,
      linkAddress: benchKey(`${shape.seed}:link:${index}`),
      wallet,
      vault,
      policy: investmentPolicyAddress(shape.programId, vault),
      frontierSlot: 400_000_000,
      txAbove: index < hot ? shape.hotTxCount : 0,
    });
  }
  return links;
}

/** One transaction in a synthetic wallet's history, oldest first. */
export interface BenchTx {
  readonly signature: string;
  readonly slot: number;
  /** The wallet's lamports before and after, fee included; the walk chains post to the next pre. */
  readonly pre: number;
  readonly post: number;
}

/**
 * A hot wallet's history: one ANCHOR at or below the frontier, then `txAbove`
 * transactions above it, oldest first, with an unbroken balance chain.
 *
 * THE CHAIN HAS TO HOLD. measureSince checks every transaction's pre against the
 * previous post and counts a mismatch as a break; enough breaks and the
 * measurement is refused as incomplete, and the bench would be timing a sweep of
 * refusals rather than a sweep of settles.
 *
 * AND IT HAS TO BE PROFITABLE, or the turn rests one step early. Every entry is
 * a WINNING swap — 0.001 SOL in, one fee out — so a PROFIT vault's base is
 * positive and the turn goes all the way through the attestation build, the fee
 * quote, the wallet's balance and the reserve check to a dry-run "would settle".
 * A losing history stops at NO_PROFIT before any of that, and the expensive lane
 * would be missing the last four round trips it really costs.
 */
export function buildHistory(link: BenchLink): readonly BenchTx[] {
  const FEE = 5_000;
  const NOTIONAL = 1_000_000;
  let balance = 2_000_000_000;
  const out: BenchTx[] = [];
  const step = (signature: string, slot: number): void => {
    const pre = balance;
    balance = pre + NOTIONAL - FEE;
    out.push({ signature, slot, pre, post: balance });
  };
  // The anchor sits BELOW the frontier: the walk stops at the first signature at
  // or below it, and reads that one for the balance the window opens on.
  step(benchSignature(`${link.index}:anchor`), link.frontierSlot - 1);
  for (let i = 0; i < link.txAbove; i++) step(benchSignature(`${link.index}:${i}`), link.frontierSlot + 1 + i);
  return out;
}

/** The fee every synthetic transaction pays, and the fee the stub prices a settle at. */
export const BENCH_FEE_LAMPORTS = 5_000;
/** The program every synthetic trade invokes: a venue, so the walk counts it as trading and not as an external flow. */
export const BENCH_VENUE_PROGRAM = RAYDIUM_CLMM_PROGRAM;

interface VaultBytesInput {
  readonly owner: PublicKey;
  readonly skimMode: number;
  readonly skimBps: number;
  readonly volumeBps: number;
}

/** state.rs Vault, field by field, as test/accounts.test.ts lays one out. */
export function vaultBytes(v: VaultBytesInput): Buffer {
  const buf = Buffer.alloc(VAULT_SPACE);
  accountDiscriminator("Vault").copy(buf, 0);
  v.owner.toBuffer().copy(buf, 8);
  buf.writeUInt8(253, 40); // bump
  buf.writeUInt8(1, 41); // version
  buf.writeUInt8(0, 42); // paused
  buf.writeUInt16LE(v.skimBps, 43);
  buf.writeBigUInt64LE(0n, 45); // lifetime_saved
  buf.writeBigInt64LE(1_757_000_000n, 53); // created_at
  buf.writeUInt8(v.skimMode, 61);
  buf.writeUInt16LE(v.volumeBps, 62);
  buf.writeBigUInt64LE(1n, 64); // policy_nonce
  // A cap no synthetic window reaches, so a dry-run turn reports the whole
  // contribution rather than one clipped to the cap by the fixture.
  buf.writeBigUInt64LE(1_000_000_000n, 72); // max_contribution
  buf.writeBigUInt64LE(0n, 80); // wallet_reserve
  return buf;
}

/** state.rs TradingLink, the 129 bytes src/discovery.ts reads by offset. */
export function tradingLinkBytes(link: BenchLink): Buffer {
  const buf = Buffer.alloc(TRADING_LINK_SPACE);
  accountDiscriminator("TradingLink").copy(buf, 0);
  link.wallet.toBuffer().copy(buf, 8);
  link.vault.toBuffer().copy(buf, 40);
  buf.writeBigUInt64LE(1n, 72); // epoch
  buf.writeBigUInt64LE(7n, 80); // settlement_nonce
  buf.writeBigUInt64LE(BigInt(link.frontierSlot), 88);
  buf.writeUInt8(254, 96); // bump
  return buf;
}

/** state.rs ProtocolConfig. The attester and the keeper are one key, as the deployment's are. */
export function protocolConfigBytes(authority: PublicKey, crank: PublicKey): Buffer {
  const buf = Buffer.alloc(PROTOCOL_CONFIG_SPACE);
  accountDiscriminator("ProtocolConfig").copy(buf, 0);
  authority.toBuffer().copy(buf, 8);
  crank.toBuffer().copy(buf, 40); // attester
  buf.writeUInt8(252, 72); // bump
  crank.toBuffer().copy(buf, 73); // keeper
  PublicKey.default.toBuffer().copy(buf, 105); // pending_authority
  buf.writeUInt8(0, 137); // paused
  buf.writeUInt8(2, 138); // version
  return buf;
}

function u128(buf: Buffer, offset: number, value: bigint): void {
  buf.writeBigUInt64LE(value & 0xffff_ffff_ffff_ffffn, offset);
  buf.writeBigUInt64LE(value >> 64n, offset + 8);
}

/**
 * state.rs InvestmentPolicy: enabled, in USDC, with one leg and a minimum the
 * bench's vaults never clear.
 *
 * ENABLED ON PURPOSE, AND IT NEVER BUYS. A vault with no policy would end the
 * invest turn after ONE account read, and the whole point of the measurement is
 * that an idle user costs SIX round trips: the policy, the vault-and-clock-and-
 * two-oracles batch, the rent floor and the two token accounts all get read
 * before the turn rests. So the policy is real and the turn goes all the way to
 * the balances — which are zero, under a minimum that is not, so it rests at
 * IDLE. NOTHING REACHES JUPITER: the venue is only consulted past that rest, so
 * the bench makes no request to any host but its own stub. That is asserted in
 * test/bench-chain-stub.test.ts and enforced at runtime by the offline guard.
 */
export function investmentPolicyBytes(vault: PublicKey): Buffer {
  const buf = Buffer.alloc(INVESTMENT_POLICY_SPACE);
  accountDiscriminator("InvestmentPolicy").copy(buf, 0);
  vault.toBuffer().copy(buf, 8);
  buf.writeUInt8(1, 40); // enabled
  BENCH_VENUE_PROGRAM.toBuffer().copy(buf, 41); // venue_program
  USDC_MINT.toBuffer().copy(buf, 73); // in_mint
  buf.writeUInt32LE(1, 105); // legs.len()
  let at = 109;
  benchKey("leg-mint").toBuffer().copy(buf, at);
  buf.writeUInt16LE(10_000, at + 32); // weight_bps
  u128(buf, at + 34, 1n); // min_out_rate_wad
  at += 50;
  u128(buf, at, 1n); // min_convert_rate_wad: non-zero, so conversion is switched ON
  at += 16;
  buf.writeBigUInt64LE(1_000_000_000n, at); // min_investment: a floor no bench vault clears
  at += 8;
  buf.writeBigUInt64LE(1_000_000_000n, at); // max_per_call
  at += 8;
  buf.writeBigUInt64LE(1_000_000_000_000n, at); // max_rolling_30d
  at += 8 + 124 + 248; // bucket_days, bucket_amounts: all zero
  buf.writeBigUInt64LE(0n, at); // lifetime_invested
  at += 8;
  buf.writeBigUInt64LE(1n, at); // policy_nonce
  at += 8;
  buf.writeUInt8(251, at); // bump
  return buf;
}

/** The Clock sysvar: 40 bytes, unix_timestamp an i64 at byte 32, epoch a u64 at 16. */
export function clockBytes(unixSeconds: bigint, slot: bigint, epoch: bigint): Buffer {
  const buf = Buffer.alloc(40);
  buf.writeBigUInt64LE(slot, 0);
  buf.writeBigInt64LE(unixSeconds - 172_800n, 8);
  buf.writeBigUInt64LE(epoch, 16);
  buf.writeBigUInt64LE(epoch + 1n, 24);
  buf.writeBigInt64LE(unixSeconds, 32);
  return buf;
}

/**
 * A Pyth PriceUpdateV2 at VerificationLevel::Full, 134 bytes.
 *
 * THE CHAIN CARRIES THESE, SO THE STUB MUST TOO: the invest turn reads both
 * feeds in the same request as the vault and the Clock, and a stub that served
 * neither would still cost the same round trip — but would rest the SOL hop for
 * a reason the bench invented rather than measured.
 */
export function priceUpdateBytes(feedIdHex: string, price: bigint, publishTime: bigint): Buffer {
  const buf = Buffer.alloc(134);
  buf.set([0x22, 0xf1, 0x23, 0x63, 0x9d, 0x7e, 0xf4, 0xcd], 0); // PriceUpdateV2's discriminator
  buf.set(benchKey("pyth-write-authority").toBytes(), 8);
  buf.writeUInt8(1, 40); // VerificationLevel::Full
  buf.set(Buffer.from(feedIdHex, "hex"), 41);
  buf.writeBigInt64LE(price, 73);
  buf.writeBigUInt64LE(1_000n, 81); // conf
  buf.writeInt32LE(-8, 89); // expo
  buf.writeBigInt64LE(publishTime, 93);
  buf.writeBigInt64LE(publishTime - 1n, 101);
  buf.writeBigInt64LE(price, 109); // ema_price
  buf.writeBigUInt64LE(1_000n, 117);
  buf.writeBigUInt64LE(400_000_000n, 125);
  return buf;
}
