// A Token-2022 mint's transfer fee, out of the mint's own bytes. Browser-safe,
// bigint only.
//
// WHY THE BUILD ROUTE NEEDS IT. A leg's min_out_rate_wad is checked by
// invest.rs against `received` — the destination account's balance DELTA,
// which is what Token-2022 credits AFTER withholding the mint's transfer fee.
// The rate the floor is taken from (clmm-price.ts legWadFromSqrtPrice) is a
// Raydium CLMM pool's sqrt_price squared: a mid, GROSS of that fee, because the
// pool prices what leaves its vault and the fee is withheld on the way out.
// MEASURED 2026-09-24, slot 450109719: ANTHROPIC's floor pool mid put $5 at
// 4,783,107 raw, and Jupiter quoting the SAME pool alone answered 4,723,099 —
// 125.45 bps under, which is the pool's 25 bps tier plus the mint's 100 bps
// fee. So a floor signed at 95 % of the mid leaves the market 5 % minus the
// fee, and at the 300 bps the issuer wrote for epoch 1043, about 2 %.
// server/build-handler.ts takes the fee off first (legFloorWad below); this
// reads it.
//
// THE SAME WALK AS THE KEEPER'S decodeMintFacts (invest-decision.ts), which
// this package may not import (the keeper's package.json is what ships to
// Railway, and the repo forbids the dependency in both directions): the 82-byte
// base, zero padding to 165, AccountType::Mint at 165, then TLV entries from
// 166 until an Uninitialized (0) type or the end. A layout this walk does not
// understand THROWS: a fee read out of bytes that did not parse is a number
// nobody should sign a floor with.

import { floorWad } from "./clmm-price";
import { legFloorMarginBps } from "./product";

/** Something about a mint's bytes this walk does not understand. The build route refuses rather than guess a fee. */
export class TransferFeeReadError extends Error {
  override readonly name = "TransferFeeReadError";
}

/** One TransferFee record: the first epoch it applies in, its cap in raw units, and its rate. */
export interface MintTransferFee {
  readonly epoch: bigint;
  readonly maximumFee: bigint;
  readonly bps: number;
}

/** A mint's TransferFeeConfig: the fee in force and the one written to replace it. */
export interface MintTransferFeeSchedule {
  readonly older: MintTransferFee;
  readonly newer: MintTransferFee;
}

/** spl-token's Mint, before any extension. A mint with none is exactly this long. */
const MINT_BASE_BYTES = 82;
/** Token-2022's BASE_ACCOUNT_LENGTH: the AccountType byte of a mint carrying extensions sits here, the TLV from the byte after. */
const BASE_ACCOUNT_BYTES = 165;
const ACCOUNT_TYPE_MINT = 1;
const EXT_UNINITIALIZED = 0;
const EXT_TRANSFER_FEE_CONFIG = 1;
/** authority(32) withdraw_withheld_authority(32) withheld_amount(8) older(18) newer(18). */
const TRANSFER_FEE_CONFIG_BYTES = 108;
const OLDER_AT = 72;
const NEWER_AT = 90;

const u16At = (bytes: Uint8Array, at: number): number => bytes[at]! | (bytes[at + 1]! << 8);

function u64At(bytes: Uint8Array, at: number): bigint {
  let value = 0n;
  for (let i = 7; i >= 0; i--) value = (value << 8n) | BigInt(bytes[at + i]!);
  return value;
}

const feeAt = (bytes: Uint8Array, at: number): MintTransferFee => ({ epoch: u64At(bytes, at), maximumFee: u64At(bytes, at + 8), bps: u16At(bytes, at + 16) });

/**
 * The mint's TransferFeeConfig, or null when it carries none — a classic SPL
 * mint, or a Token-2022 mint without the extension, which charges nothing and
 * never can (extensions are fixed at initialisation). Throws
 * TransferFeeReadError on any layout it does not recognise.
 */
export function decodeMintTransferFee(data: Uint8Array): MintTransferFeeSchedule | null {
  if (!(data instanceof Uint8Array) || data.length < MINT_BASE_BYTES) {
    throw new TransferFeeReadError(`a mint account is at least ${MINT_BASE_BYTES} bytes; this one is ${data instanceof Uint8Array ? data.length : "not bytes"}`);
  }
  if (data.length <= BASE_ACCOUNT_BYTES) return null;
  const accountType = data[BASE_ACCOUNT_BYTES]!;
  if (accountType !== ACCOUNT_TYPE_MINT) {
    throw new TransferFeeReadError(`byte ${BASE_ACCOUNT_BYTES} of this mint is ${accountType}, not the ${ACCOUNT_TYPE_MINT} Token-2022 writes for a mint`);
  }
  let at = BASE_ACCOUNT_BYTES + 1;
  while (at + 4 <= data.length) {
    const type = u16At(data, at);
    if (type === EXT_UNINITIALIZED) break;
    const length = u16At(data, at + 2);
    const start = at + 4;
    if (start + length > data.length) throw new TransferFeeReadError(`extension ${type} claims ${length} bytes at ${start}, past the end of a ${data.length}-byte mint`);
    if (type === EXT_TRANSFER_FEE_CONFIG) {
      if (length !== TRANSFER_FEE_CONFIG_BYTES) throw new TransferFeeReadError(`TransferFeeConfig is ${TRANSFER_FEE_CONFIG_BYTES} bytes; this mint carries ${length}`);
      return { older: feeAt(data, start + OLDER_AT), newer: feeAt(data, start + NEWER_AT) };
    }
    at = start + length;
  }
  return null;
}

/**
 * The fee a floor signed in `currentEpoch` must leave room for, in bps: the
 * rate in force now, or a rate already written for a LATER epoch, whichever is
 * higher.
 *
 * WHY THE HIGHER, AND WHY NOT SIMPLY THE LIVE ONE. A floor is signed once and
 * stands until the owner signs again; the fee moves at an epoch boundary with
 * nobody's signature. Read 2026-09-24 in epoch 1041, ANTHROPIC charged 100 and
 * had 300 written for 1043: a floor netted of the live 100 would leave the
 * market 5 % for two days and about 3 % from then on for the life of the
 * policy. Netting the written 300 costs the owner 2 % of floor headroom for
 * those two days and nothing after. The keeper sizes its slippage the same way
 * (invest-decision.ts worstCaseTransferFee), for the same reason.
 *
 * WHY `older` IS IGNORED ONCE `newer` HAS ARRIVED. From newer.epoch on, older
 * is history — a fee the mint no longer charges and never will again unless it
 * is written anew — so a cut that has landed is netted as the cut.
 *
 * maximum_fee IS NOT APPLIED. It caps the fee on large transfers, so netting
 * the full rate over-nets a capped mint: a LOWER floor, never a floor the
 * credit cannot reach. Every PreStocks mint read on 2026-09-24 had maximum_fee
 * u64::MAX, so today the rate is the fee.
 */
export function feeToNetBps(schedule: MintTransferFeeSchedule | null, currentEpoch: bigint): number {
  if (schedule === null) return 0;
  if (currentEpoch >= schedule.newer.epoch) return schedule.newer.bps;
  return Math.max(schedule.older.bps, schedule.newer.bps);
}

/**
 * `wad` less a `feeBps` transfer fee, rounded down: what a leg rate becomes
 * once Token-2022 has withheld the fee from the transfer into the vault.
 *
 * ROUNDED DOWN, AND TOKEN-2022 ROUNDS ITS FEE UP. The two disagree by at most
 * one raw unit per transfer — a floor could sit one unit above a credit exactly
 * at the rate — and the margin of at least 5 % taken after this (legFloorWad) is over
 * 100,000 raw units on a $2.50 ANTHROPIC leg (half the $5 minimum purchase;
 * about 2.39 million raw units at the mid measured 2026-09-24), so the unit is
 * noise inside it.
 */
export function netOfTransferFeeWad(wad: bigint, feeBps: number): bigint {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) throw new RangeError("a transfer fee is 0 to 10,000 bps");
  return (wad * BigInt(10_000 - feeBps)) / 10_000n;
}

/**
 * The floor a policy signed now carries for a leg: the pool's GROSS mid, less
 * the leg's transfer fee, less legFloorMarginBps(fee) — the one arithmetic the
 * build signs (server/build-handler.ts liveFloors), the page previews
 * (invest-limits.ts) and the page re-checks before signing (vault-flows.ts).
 * 95 % of the net mid at a fee of 100 bps or less; 93 % of it at 300.
 */
export function legFloorWad(midWad: bigint, feeBps: number): bigint {
  return floorWad(netOfTransferFeeWad(midWad, feeBps), legFloorMarginBps(feeBps));
}
