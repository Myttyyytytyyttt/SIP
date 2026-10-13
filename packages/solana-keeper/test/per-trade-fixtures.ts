// Bytes for the per-trade tests: a PerTradePolicy laid out byte for byte as
// state.rs declares it (ADR §5.4: 104 bytes, discriminator 4a5e12f4fc1859b9),
// a Pyth SOL/USD PriceUpdateV2 as the receiver writes it, and transaction
// signatures that are real base58 of 64 bytes (pricesHash hashes the raw bytes).

import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { accountDiscriminator } from "../src/idl.js";
import type { VolumeTrade } from "../src/measure-window.js";
import { PYTH_RECEIVER_PROGRAM, PYTH_SOL_USD_FEED_ID_HEX } from "../src/pyth.js";

export interface PolicyBytesInput {
  readonly vault: PublicKey;
  readonly roundupUnitCents?: number;
  readonly fixedLamports?: number;
  readonly minTradeCents?: number;
  readonly minTradeLamports?: number;
  readonly dailyCapLamports?: bigint;
  readonly dayIndex?: number;
  readonly daySavedLamports?: bigint;
}

/** state.rs PerTradePolicy: vault 8..40, bump 40, version 41, unit 42, F 44, min cents 48, min lamports 50, cap 54, day 62, saved 66, reserved 74..104. */
export function perTradePolicyBytes(input: PolicyBytesInput): Buffer {
  const buf = Buffer.alloc(104);
  accountDiscriminator("PerTradePolicy").copy(buf, 0);
  input.vault.toBuffer().copy(buf, 8);
  buf.writeUInt8(253, 40);
  buf.writeUInt8(1, 41);
  buf.writeUInt16LE(input.roundupUnitCents ?? 100, 42);
  buf.writeUInt32LE(input.fixedLamports ?? 1_000_000, 44);
  buf.writeUInt16LE(input.minTradeCents ?? 100, 48);
  buf.writeUInt32LE(input.minTradeLamports ?? 10_000_000, 50);
  buf.writeBigUInt64LE(input.dailyCapLamports ?? 300_000_000n, 54);
  buf.writeUInt32LE(input.dayIndex ?? 0, 62);
  buf.writeBigUInt64LE(input.daySavedLamports ?? 0n, 66);
  return buf;
}

export interface PythBytesInput {
  /** i64 at `expo`; 15_000_000_000 at -8 is $150. */
  readonly price: bigint;
  readonly expo?: number;
  readonly conf?: bigint;
  readonly publishTime: bigint;
  /** 1 Full (the default, every mainnet sample), 0 Partial. */
  readonly variant?: 0 | 1;
  readonly feedIdHex?: string;
}

/** A PriceUpdateV2's 134 bytes: discriminator, write authority, verification level, then the 92-byte body. */
export function pythSolUsdBytes(input: PythBytesInput): Buffer {
  const buf = Buffer.alloc(134);
  Buffer.from([0x22, 0xf1, 0x23, 0x63, 0x9d, 0x7e, 0xf4, 0xcd]).copy(buf, 0);
  const variant = input.variant ?? 1;
  buf.writeUInt8(variant, 40);
  let at = 41;
  if (variant === 0) {
    buf.writeUInt8(5, 41);
    at = 42;
  }
  Buffer.from(input.feedIdHex ?? PYTH_SOL_USD_FEED_ID_HEX, "hex").copy(buf, at);
  buf.writeBigInt64LE(input.price, at + 32);
  buf.writeBigUInt64LE(input.conf ?? input.price / 10_000n, at + 40);
  buf.writeInt32LE(input.expo ?? -8, at + 48);
  buf.writeBigInt64LE(input.publishTime, at + 52);
  buf.writeBigInt64LE(input.publishTime - 1n, at + 60);
  buf.writeBigInt64LE(input.price, at + 68);
  buf.writeBigUInt64LE(input.conf ?? input.price / 10_000n, at + 76);
  buf.writeBigUInt64LE(1n, at + 84);
  return buf;
}

/** The account as a getMultipleAccountsInfo answer carries it. */
export function pythAccount(input: PythBytesInput, owner: PublicKey = PYTH_RECEIVER_PROGRAM) {
  return { data: pythSolUsdBytes(input), owner, lamports: 1_000_000, executable: false, rentEpoch: 0 };
}

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** base58 of bytes: what a signature looks like on the wire. */
export function base58(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let out = "";
  while (value > 0n) {
    out = ALPHABET[Number(value % 58n)]! + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out;
}

/** A deterministic, real-shaped signature: base58 of 64 bytes derived from `seed`. */
export function signatureFor(seed: string): string {
  const half = createHash("sha256").update(seed).digest();
  return base58(Buffer.concat([half, createHash("sha256").update(half).digest()]));
}

/** A counted trade as the walk's volume probe records it. */
export function trade(seed: string, slot: number, lamports: bigint, blockTime: number | null): VolumeTrade {
  return { signature: signatureFor(seed), slot: BigInt(slot), blockTime, lamports };
}
