// A Token-2022 mint's transfer fee, out of the mint's own bytes. Browser-safe,
// bigint only.
//
// WHY THE BUILD ROUTE NEEDS IT. The keeper refuses a whole basket from the
// epoch a chosen leg's fee goes over its ceiling (CATALOGUE_MAX_FEE_BPS), so
// server/build-handler.ts reads each leg's fee and refuses to build such a
// basket (fee_over_ceiling). Until 2026-10-08 it also netted each leg's signed
// floor of this fee; it signs no price floor now (product.ts
// LIVE_PRICE_FLOOR_WAD). netOfTransferFeeWad below is kept for the website,
// which still judges a policy signed before that day against the keeper's rule
// (website-oficial invest-limits.ts keeperVenueThresholdWad).
//
// THE SAME WALK AS THE KEEPER'S decodeMintFacts (invest-decision.ts), which
// this package may not import (the keeper's package.json is what ships to
// Railway, and the repo forbids the dependency in both directions): the 82-byte
// base, zero padding to 165, AccountType::Mint at 165, then TLV entries from
// 166 until an Uninitialized (0) type or the end. A layout this walk does not
// understand THROWS: a fee read out of bytes that did not parse is a number
// nobody should judge a basket with.

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
 * The fee a leg must be judged at in `currentEpoch`, in bps: the rate in force
 * now, or a rate already written for a LATER epoch, whichever is higher.
 *
 * WHAT IT IS FOR SINCE 2026-10-08. The build route no longer nets any floor of
 * it (policies sign LIVE_PRICE_FLOOR_WAD, product.ts); it judges a chosen leg
 * against the keeper's fee ceiling with it (build-handler.ts fee_over_ceiling).
 *
 * WHY THE HIGHER, AND WHY NOT SIMPLY THE LIVE ONE. The fee moves at an epoch
 * boundary with nobody's signature, and the keeper refuses a basket from the
 * epoch a leg's fee goes over its ceiling. Read 2026-09-24 in epoch 1041,
 * ANTHROPIC charged 100 and had 300 written for 1043: a basket judged on the
 * live 100 alone would not see a rise that was already on chain. The keeper
 * sizes its slippage the same way (invest-decision.ts worstCaseTransferFee),
 * for the same reason.
 *
 * WHY `older` IS IGNORED ONCE `newer` HAS ARRIVED. From newer.epoch on, older
 * is history — a fee the mint no longer charges and never will again unless it
 * is written anew — so a cut that has landed is judged as the cut.
 *
 * maximum_fee IS NOT APPLIED. It caps the fee on large transfers, so the full
 * rate over-states a capped mint's fee, never under-states it. Every PreStocks
 * mint read on 2026-09-24 had maximum_fee u64::MAX, so today the rate is the
 * fee.
 */
export function worstCaseFeeBps(schedule: MintTransferFeeSchedule | null, currentEpoch: bigint): number {
  if (schedule === null) return 0;
  if (currentEpoch >= schedule.newer.epoch) return schedule.newer.bps;
  return Math.max(schedule.older.bps, schedule.newer.bps);
}

/**
 * `wad` less a `feeBps` transfer fee, rounded down: what a leg rate becomes
 * once Token-2022 has withheld the fee from the transfer into the vault. The
 * website models the keeper's threshold on a route whose last hop quotes net
 * with it (invest-limits.ts keeperVenueThresholdWad), to judge a floor signed
 * before 2026-10-08. Token-2022 rounds its fee UP, so this can sit one raw
 * unit over a real credit; that judgement is a screen, and no gate reads it.
 */
export function netOfTransferFeeWad(wad: bigint, feeBps: number): bigint {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) throw new RangeError("a transfer fee is 0 to 10,000 bps");
  return (wad * BigInt(10_000 - feeBps)) / 10_000n;
}
