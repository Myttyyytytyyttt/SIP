// Builds a REAL Jupiter sharedAccountsRoute instruction — the venue route
// invest() and convert() forward on mainnet, in place of one pinned Raydium
// pool.
//
// WHY JUPITER AT ALL. The pinned pool for one leg holds 52 USD of liquidity
// and reverts above ~11 USD; Jupiter routes the same token for 250 USD in a
// single hop. The bounty is PreStocks, not Raydium, and policy.venue_program
// is a field the vault OWNER signs — so switching venues is a signature, not a
// redeploy. The deployed program never changes.
//
// WHAT THE PROGRAM GUARANTEES, AND WHAT IT DOES NOT. invest.rs checks the
// passed program equals policy.venue_program and then invoke_signed's the
// caller's remaining_accounts and venue_data VERBATIM, marking only the vault
// PDA as a signer. Its whole safety is:
//   (1) refuse_unmeasured_vault_accounts — vault_in and vault_target must be
//       the only vault-owned token accounts anywhere in the route;
//   (2) the deltas — spent <= amount_in (Overspent) and received >= min_out
//       (FillTooSmall), both measured AROUND the single CPI;
//   (3) it has to fit in one transaction.
// Everything else — that the instruction is the one we think it is, that its
// signer slot is the vault, that the route delivers where we measure — is this
// file's job, BEFORE anything is signed. That is why every check below is a
// refusal with a name, not a warning.
//
// AND ONE OF THOSE CHECKS FACES THE OTHER WAY. Agreeing the instruction with
// the quote only proves the API was consistent with itself; both numbers move
// together if it answered a different question. The request is the only thing
// in this file that never came off the wire, so verifyQuoteAnswersRequest
// compares the quote to it before anything is derived — min_out most of all,
// which is computed from the quote's own slippageBps.
//
// (4) AND THE ONE THE GUARDS CANNOT SEE. Two of the three legs are Token-2022
// mints with a transfer fee (100 bps since epoch 1039, 50 before it,
// maximumFee u64::MAX). The credit a destination account receives is NET of
// that fee, so the delta the program measures is NET — while on a
// gross-quoting venue Jupiter's outAmount and otherAmountThreshold are GROSS.
// A min_out copied from either is then a number about different money. The two
// roundings also go opposite ways: Jupiter FLOORS its slippage deduction
// (threshold = out - floor(out*bps/1e4)) and Token-2022 CEILS its fee
// (net = out - ceil(out*bps/1e4)), so where the two rates are equal the net
// lands on the threshold MINUS ONE RAW UNIT.
//
// WHICH GUARD ACTUALLY FIRES, MEASURED — because an earlier version of this
// header asserted the wrong one. Run on a local validator with mainnet state
// cloned for a ONE-HOP Manifest route (a gross-quoting venue: gross drift
// 0.000 bps, credit drift -50.000 bps), USDC -> FIGUREAI, 5 USDC, local fee
// 50 bps, on 2026-09-20:
//
//   slippage 100 bps (above the fee)
//     quoted out 27,147,537   threshold 26,876,062   CREDIT 27,011,799
//     min_out = otherAmountThreshold is BELOW the credit -> ACCEPTED.
//     min_out = outAmount (27,147,537) is a whole fee above it
//       -> FillTooSmall 6020, ours, inside invest().
//     min_out = netOfVenueThreshold (26,741,681) -> accepted, margin 270,118.
//
//   slippage 50 bps (equal to the fee)
//     threshold 27,011,800, credit 27,011,799 — the off-by-one above — and
//     the transaction never reaches invest()'s fill guard at all:
//       Program JUP6Lkb... failed: custom program error: 0x1771
//     JUPITER's own 6001 inside the CPI, with our min_out (a deliberately
//     slack probe floor) playing no part.
//
// SO min_out = otherAmountThreshold DOES NOT REVERT WITH FillTooSmall, and
// saying it did was wrong in both directions: above the fee it is simply
// accepted, and at or below it Jupiter has already refused, because Jupiter
// checks its own threshold against the CREDITED amount. What does revert with
// FillTooSmall is a min_out taken from outAmount on a gross-quoting venue.
//
// netOfVenueThreshold is still the number to hand invest(), and for a reason
// that does not depend on any of this: it is below the credit under BOTH
// quoting bases by OUR arithmetic, so it stays right even if Jupiter's
// internal check stops being what it is today. It is a floor we can prove,
// not one we are borrowing.
//
// (5) WHAT THE REQUEST DOES NOT BOUND, AND IT IS THE PRICE.
// verifyQuoteAnswersRequest pins the mints, the amount in and the slippage —
// the three an API could otherwise have answered a different question with. It
// does not pin quote.outAmount, and nothing else here does either: a quote that
// answers our exact request at a terrible price is still a quote about our
// request, and netOfVenueThreshold is computed straight from it, so the vault's
// own minimum simply moves down with the price. THIS FILE DOES NOT CHECK THAT
// A ROUTE IS A GOOD DEAL, and it should not try: a route builder holds no
// independent price, and inventing one here would be a second oracle to trust
// on the way to the first.
//
// WHERE THE PRICE DEFENCE ACTUALLY LIVES — in the program, under a signature
// that is not ours. invest() computes
//   floor = amount_in * leg.min_out_rate_wad / 1e18
// from the policy the VAULT OWNER signed, and refuses any min_out below it
// with FloorTooLow (6019) BEFORE the CPI runs. A bad-price route therefore
// costs the vault a failed transaction, never a fill. That floor is per leg,
// it is the owner's number, and it is not this file's to choose.
//
// SO THE ONE THING THIS FILE CAN HONESTLY DO is check the SAME number the
// program will, when the caller already has it: pass `ownerFloorRateWad` and a
// route whose net threshold falls under the owner's floor is refused
// [below-owner-floor] here, before anything is signed, instead of on chain
// after a transaction has been spent. Leave it out and nothing in this file
// bounds the price — the route says so itself, with output.ownerFloor null —
// and the obligation is the caller's, discharged by the owner's policy on
// chain and nowhere else.
//
// (6) AND THE CONSEQUENCE THAT BITES FIRST, MEASURED AT THE EPOCH BOUNDARY.
// Jupiter quotes gross on some venues but checks its OWN threshold against what
// the destination is CREDITED, which is net. So on a gross-quoting venue the
// transfer fee is spent out of the slippage tolerance, and slippage_bps must be
// strictly GREATER than the fee or the swap cannot land at all — Jupiter itself
// reverts with 0x1771 (6001, slippage tolerance exceeded) before invest()'s
// guards ever run. Measured across the 1038 -> 1039 boundary on 2026-09-20,
// USDC -> ANTHROPIC, whose routes end on Manifest:
//   epoch 1038, fee  50 bps, slippage 100 bps -> fills, credit drift -50.0 bps
//   epoch 1039, fee 100 bps, slippage 100 bps -> Jupiter 0x1771 at 5, 25, 250 USD
//   epoch 1039, fee 100 bps, slippage 200 bps -> fills, credit drift -100.0 bps
// The usable tolerance is slippage_bps - fee_bps, and at equality it is not
// zero but negative by one raw unit, because Jupiter floors and Token-2022
// ceils. A venue that quotes NET is unaffected — FIGUREAI still filled at
// 100/100 — which is exactly why this cannot be configured per leg: the basis
// belongs to whichever AMM Jupiter picks for that quote, not to the mint.
//
// (7) AND THE THING THIS FILE CAN SEE BUT MUST NOT REFUSE.
// (6) is a fact about two numbers the builder already holds: the slippage the
// quote was taken at, and the destination mint's transfer fee. Their
// difference IS the usable tolerance on a gross-quoting venue, and at zero or
// below such a venue cannot fill at all.
//
// WHAT THE BUILDER CANNOT KNOW IS WHETHER THIS ROUTE IS ONE OF THOSE. The
// quoting basis belongs to whichever AMM makes the final transfer, Jupiter
// re-picks it per quote, and the instruction does not say which it chose —
// measured on 2026-09-20, the SAME mint at the SAME size answered gross
// through Manifest and net through Meteora DLMM, and FIGUREAI filled happily
// at 100 bps against a 100 bps fee because its route ended somewhere that
// quotes net. Refusing on the two numbers would therefore refuse routes that
// land, and this file has no third number to break the tie with.
//
// SO IT IS A WARNING WITH A NAME, NOT A REFUSAL. route.warnings carries
// `slippage-not-above-transfer-fee` with both rates and the tolerance left
// over, machine-readable, so the caller can re-quote wider, pin a net-quoting
// venue, or spend the transaction knowingly — a decision that needs more than
// this file has. WHAT IT KNOWS: the two rates and their difference. WHAT IT
// DOES NOT: which venue will fill, and so whether the difference bites.
//
// AND THE TWO NUMBERS TO HAND invest() BOTH HAVE NAMES NOW: investAmountIn()
// for amount_in and investMinOut() for min_out, each re-derived at the moment
// it becomes an argument, so RouteOutput's fields stay numbers to READ rather
// than a menu to pick a min_out out of.

import { createHash } from "node:crypto";
// AccountMeta IS A TYPE (see raydium-swap.ts for the full story): a
// value-position import of it survives only by erasure, and the day it stops,
// the keeper does not boot.
import type { AccountMeta, Connection } from "@solana/web3.js";
import { PACKET_DATA_SIZE, PublicKey, TransactionInstruction, TransactionMessage } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getTransferFeeConfig,
  unpackMint,
} from "@solana/spl-token";

export const JUPITER_PROGRAM = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");

// RECOMPUTED, NOT TRANSCRIBED — this project has been bitten twice by copied
// selectors. Both are Anchor's sha256("global:<name>")[..8]; the measured
// mainnet bytes are asserted against the computation at module load.
export const SHARED_ACCOUNTS_ROUTE_DISC = createHash("sha256")
  .update("global:shared_accounts_route")
  .digest()
  .subarray(0, 8);
export const ROUTE_DISC = createHash("sha256").update("global:route").digest().subarray(0, 8);
if (SHARED_ACCOUNTS_ROUTE_DISC.toString("hex") !== "c1209b3341d69c81") {
  throw new Error(`shared_accounts_route discriminator drifted: ${SHARED_ACCOUNTS_ROUTE_DISC.toString("hex")}`);
}

/**
 * Fixed account slots of sharedAccountsRoute, read off three real mainnet
 * builds on 2026-09-20 (USDC->SPYx 1 hop / 32 accounts, USDC->FIGUREAI 1 hop /
 * 30, USDC->ANTHROPIC 2 hops / 48). The prefix is identical in all three; only
 * the per-AMM tail after slot 12 changes.
 *
 * Slot 5 is Jupiter's programDestinationTokenAccount, and it is NOT pinned to
 * one value: it is sometimes Jupiter's own account and sometimes ours. Pinning
 * it would refuse honest routes. It is not ignored either — see
 * refuse_unmodelled_fee_path below, which is about what its being Jupiter's
 * own account MEANS for a mint that charges a transfer fee.
 */
export const SLOT_USER_TRANSFER_AUTHORITY = 2;
export const SLOT_SOURCE_TOKEN_ACCOUNT = 3;
export const SLOT_PROGRAM_DESTINATION_TOKEN_ACCOUNT = 5;
export const SLOT_DESTINATION_TOKEN_ACCOUNT = 6;
/** Slots 0..12 are the fixed prefix; anything shorter is not this instruction. */
const FIXED_PREFIX_ACCOUNTS = 13;

/**
 * sharedAccountsRoute's data ends with a FIXED 19-byte tail:
 *   in_amount(u64) quoted_out_amount(u64) slippage_bps(u16) platform_fee_bps(u8)
 *
 * READ BACKWARD, STILL. The tail is position-independent, and it is the only
 * part of the data that carries money. Decoding the route plan in front of it
 * would mean a width table for a Swap enum whose variants change whenever
 * Jupiter integrates an AMM — a layout we would be re-pinning forever.
 *
 * BUT `data.length` ALONE MUST NOT DECIDE WHERE IT STARTS. See
 * decodeRouteAmounts: the plan is WALKED, without being decoded, so that a
 * trailing byte cannot slide all four numbers at once.
 */
const DATA_TAIL_LEN = 19;

/** disc(8) + id(u8): where the route_plan vec's u32 length sits. */
const DATA_PLAN_COUNT_OFFSET = 9;
/** disc(8) + id(u8) + route_plan len(u32): where the plan's first step starts. */
const DATA_PLAN_START = 13;
/** percent(u8) input_index(u8) output_index(u8) close every RoutePlanStep. */
const ROUTE_PLAN_STEP_TRAILER_LEN = 3;
/** A Swap variant is at least its own one-byte discriminant. */
const SWAP_MIN_LEN = 1;

export type RefusalCondition =
  | "request-drift"
  | "quote-mode"
  | "venue-program"
  | "discriminator"
  | "account-count"
  | "data-length"
  | "route-plan"
  | "user-transfer-authority"
  | "source-account"
  | "destination-account"
  | "unmeasured-vault-account"
  | "unmodelled-fee-path"
  | "amounts-drift"
  | "platform-fee"
  | "venue-threshold"
  | "below-owner-floor"
  | "route-age"
  | "extra-instructions";

/** A refusal names its condition, so a caller can log which guard said no. */
export class JupiterRouteRefusal extends Error {
  readonly condition: RefusalCondition;
  /**
   * The message WITHOUT the `jupiter route refused [...]` prefix, so a caller
   * that knows something the refusal could not can extend it rather than
   * parse it back out of `message`.
   */
  readonly reason: string;
  constructor(condition: RefusalCondition, message: string) {
    super(`jupiter route refused [${condition}]: ${message}`);
    this.name = "JupiterRouteRefusal";
    this.condition = condition;
    this.reason = message;
  }
}

/**
 * A condition the builder CAN SEE but MUST NOT DECIDE — so it is attached to
 * the route instead of thrown.
 *
 * `slippage-not-above-transfer-fee`: the quote's slippage is at or below the
 * destination mint's transfer fee, which leaves zero or negative usable
 * tolerance ON A GROSS-QUOTING VENUE. Measured across the 1038 -> 1039
 * boundary: at equality Jupiter reverts the CPI with 0x1771 (6001) before
 * invest()'s guards run, one raw unit short, because Jupiter floors its
 * deduction and Token-2022 ceils its fee. A NET-quoting venue is unaffected,
 * and which one will fill is not knowable at build time — see section (7) of
 * the header for why this is not a refusal.
 */
export type RouteWarningCondition = "slippage-not-above-transfer-fee";

/**
 * A named, machine-readable signal on the route. BRANCH ON `condition` AND ON
 * THE NUMBERS; `message` is for the log line, and parsing it back out would be
 * the same mistake as parsing a refusal's message.
 */
export interface RouteWarning {
  readonly condition: RouteWarningCondition;
  readonly slippageBps: number;
  readonly transferFeeBps: number;
  /** slippage_bps - fee_bps: what is left for price movement on a gross-quoting venue. */
  readonly usableToleranceBps: number;
  readonly message: string;
}

/** The warning of that condition this route carries, or null. */
export function routeWarning(route: JupiterRoute, condition: RouteWarningCondition): RouteWarning | null {
  return route.warnings.find((warning) => warning.condition === condition) ?? null;
}

/**
 * The warnings a route of this shape carries. Pure, and exported, so a caller
 * holding a request and a fee can ask the question before it spends a quote on
 * it — the harness does exactly that before it starts a run.
 */
export function routeWarningsFor(request: RouteRequest, transferFee: TransferFeeRate): RouteWarning[] {
  const warnings: RouteWarning[] = [];
  const usableToleranceBps = request.slippageBps - transferFee.basisPoints;
  if (transferFee.basisPoints > 0 && usableToleranceBps <= 0) {
    warnings.push({
      condition: "slippage-not-above-transfer-fee",
      slippageBps: request.slippageBps,
      transferFeeBps: transferFee.basisPoints,
      usableToleranceBps,
      message:
        `quoted at ${request.slippageBps} bps of slippage against a ${transferFee.basisPoints} bps transfer fee, ` +
        `leaving ${usableToleranceBps} bps of usable tolerance. On a venue that quotes GROSS, Jupiter derives its ` +
        "threshold from the gross quote and enforces it against the CREDITED (net) amount, so the fee is spent out " +
        "of the tolerance and the swap reverts inside the CPI with Jupiter's own 0x1771 (6001) before invest()'s " +
        "guards run — at equality by a single raw unit, because Jupiter floors its deduction and Token-2022 ceils " +
        "its fee. A venue that quotes NET is unaffected, and which one this route will fill on belongs to the AMM " +
        "Jupiter picks, which is not knowable here — so this is a warning and not a refusal",
    });
  }
  return warnings;
}

// A FUNCTION DECLARATION, deliberately: TypeScript only treats a call as
// unreachable — and so only narrows what follows it — when the callee is a
// declaration or an explicitly annotated name. As a bare `const` arrow, every
// check below would still see `T | undefined` after its own refusal.
function refuse(condition: RefusalCondition, message: string): never {
  throw new JupiterRouteRefusal(condition, message);
}

// ---------------------------------------------------------------------------
// The Token-2022 transfer fee: gross in, net out.
// ---------------------------------------------------------------------------

export interface TransferFeeRate {
  /** The epoch this rate takes effect in (the config's own `epoch` field). */
  readonly epoch: bigint;
  readonly basisPoints: number;
  readonly maximumFee: bigint;
}

export interface DestinationTransferFee {
  readonly mint: string;
  /** The epoch the read was taken in. */
  readonly epoch: number;
  /** The rate in force RIGHT NOW. */
  readonly current: TransferFeeRate;
  /**
   * A rate scheduled for a LATER epoch, if one is pending. Both PreStocks legs
   * carry one: 50 bps until epoch 1038, 100 bps from 1039. An epoch boundary
   * is roughly two days, so a route quoted today can land under the new rate —
   * which is why `worstCase` exists and why min_out should be taken from it.
   */
  readonly pending: TransferFeeRate | null;
  /**
   * The schedule a min_out must survive, from worstCaseTransferFee with no
   * gross to compare at — so an UPPER ENVELOPE of the two when neither is
   * worse everywhere, not necessarily either one of them. Read that function
   * before using this field for anything but a min_out.
   */
  readonly worstCase: TransferFeeRate;
}

const NO_FEE: TransferFeeRate = { epoch: 0n, basisPoints: 0, maximumFee: 0n };

/**
 * Which of the two configured rates applies in `epoch`, exactly as Token-2022
 * itself decides it: the newer rate the moment its epoch arrives, the older one
 * until then. Hardcoding 50 or 100 would be a number that silently expires.
 */
export function transferFeeForEpoch(
  config: { readonly olderTransferFee: TransferFeeRate; readonly newerTransferFee: TransferFeeRate },
  epoch: bigint,
): TransferFeeRate {
  return epoch >= config.newerTransferFee.epoch ? config.newerTransferFee : config.olderTransferFee;
}

/**
 * The fee Token-2022 withholds on a transfer of `gross`, mirroring
 * calculate_fee: the basis-point product rounded UP, capped at maximumFee.
 *
 * THE ROUNDING IS THE POINT. Jupiter rounds its own slippage deduction down.
 * One up, one down, equal rates — and the net lands a raw unit below the
 * venue's threshold. Measured on a cloned gross-quoting route at slippage 50
 * against a 50 bps fee: threshold 27,011,800, credit 27,011,799, and Jupiter
 * reverted the CPI with 0x1771 before invest()'s guard was reached.
 */
export function transferFeeOn(gross: bigint, fee: TransferFeeRate): bigint {
  if (fee.basisPoints === 0 || gross <= 0n) return 0n;
  const raw = (gross * BigInt(fee.basisPoints) + 9_999n) / 10_000n;
  return raw < fee.maximumFee ? raw : fee.maximumFee;
}

/** What a destination account is actually CREDITED when `gross` is sent to it. */
export function netOfTransferFee(gross: bigint, fee: TransferFeeRate): bigint {
  return gross - transferFeeOn(gross, fee);
}

/**
 * Which of two fee schedules a min_out has to survive.
 *
 * THE RATE ALONE DOES NOT DECIDE IT, AND THAT IS THE CORRECTION. This used to
 * be `pending.basisPoints > current.basisPoints ? pending : current`, which is
 * the worst case only while the cap never binds. Token-2022 caps the
 * withholding at maximumFee, so a LOWER rate with a HIGHER cap withholds more
 * on everything past the crossing point: on a gross of 10,000,000, 50 bps
 * uncapped withholds 50,000 where 100 bps capped at 1,000 withholds 1,000.
 * Picking 100 there understates the fee by 49,000 raw units.
 *
 * WITH A `gross`, IT IS EXACT — the COMPUTED fee for each schedule is
 * compared, which is the only comparison that answers the question at that
 * amount.
 *
 * WITHOUT ONE, IT IS AN ENVELOPE AND SAYS SO. readDestinationTransferFee runs
 * before any quote exists, so it has no gross. When one schedule is worse at
 * every gross — its rate AND its cap at least as large — that schedule is
 * returned. When neither dominates, the crossing point is a number this
 * function was not given, so it returns the pair's upper envelope: the higher
 * rate with the higher cap, which withholds at least as much as either one
 * everywhere. That is not a schedule the mint carries, and the conservatism
 * runs in the safe direction: a larger fee makes min_out SMALLER, and a
 * min_out that is too small costs the vault nothing, while one that is too
 * large reverts a transaction that was already signed.
 *
 * TODAY'S MINTS ARE THE EASY CASE. Both PreStocks schedules set maximumFee to
 * u64::MAX, so the caps tie, the higher rate dominates, and this returns
 * exactly what the old line did.
 */
export function worstCaseTransferFee(a: TransferFeeRate, b: TransferFeeRate, gross?: bigint): TransferFeeRate {
  if (gross !== undefined) return transferFeeOn(gross, b) > transferFeeOn(gross, a) ? b : a;
  if (a.basisPoints >= b.basisPoints && a.maximumFee >= b.maximumFee) return a;
  if (b.basisPoints >= a.basisPoints && b.maximumFee >= a.maximumFee) return b;
  return {
    epoch: a.epoch >= b.epoch ? a.epoch : b.epoch,
    basisPoints: a.basisPoints >= b.basisPoints ? a.basisPoints : b.basisPoints,
    maximumFee: a.maximumFee >= b.maximumFee ? a.maximumFee : b.maximumFee,
  };
}

/**
 * Reads the destination mint's transfer-fee config from the chain.
 *
 * A mint with no TransferFeeConfig extension (SPYx) reports zero, so callers
 * never branch on "is this leg a fee mint" — they just apply the rate.
 */
export async function readDestinationTransferFee(
  connection: Connection,
  mint: PublicKey,
): Promise<DestinationTransferFee> {
  const [info, epochInfo] = await Promise.all([
    connection.getAccountInfo(mint, "confirmed"),
    connection.getEpochInfo("confirmed"),
  ]);
  if (info === null) throw new Error(`mint ${mint.toBase58()} does not exist`);
  const epoch = epochInfo.epoch;
  const config = getTransferFeeConfig(unpackMint(mint, info, info.owner));
  if (config === null) {
    return { mint: mint.toBase58(), epoch, current: NO_FEE, pending: null, worstCase: NO_FEE };
  }
  const rate = (fee: { epoch: bigint; transferFeeBasisPoints: number; maximumFee: bigint }): TransferFeeRate => ({
    epoch: BigInt(fee.epoch),
    basisPoints: fee.transferFeeBasisPoints,
    maximumFee: BigInt(fee.maximumFee),
  });
  const older = rate(config.olderTransferFee);
  const newer = rate(config.newerTransferFee);
  const current = transferFeeForEpoch({ olderTransferFee: older, newerTransferFee: newer }, BigInt(epoch));
  const pending = newer.epoch > BigInt(epoch) ? newer : null;
  const worstCase = pending === null ? current : worstCaseTransferFee(current, pending);
  return { mint: mint.toBase58(), epoch, current, pending, worstCase };
}

// ---------------------------------------------------------------------------
// The keyless endpoints.
// ---------------------------------------------------------------------------

const LITE_API = "https://lite-api.jup.ag/swap/v1";

export interface JupiterQuote {
  readonly inputMint: string;
  readonly outputMint: string;
  readonly inAmount: string;
  readonly outAmount: string;
  readonly otherAmountThreshold: string;
  readonly swapMode: string;
  readonly slippageBps: number;
  /**
   * The slot Jupiter priced at. Optional in the type because it is the API's
   * to send; a quote without it is a quote whose age in slots cannot be
   * stated, and verifyRouteFresh says so rather than assuming zero.
   */
  readonly contextSlot?: number;
  /** Jupiter's own service time for the quote, in SECONDS. */
  readonly timeTaken?: number;
  readonly routePlan: ReadonlyArray<{
    readonly swapInfo: {
      readonly label?: string;
      /** This hop's own mints. A multi-hop route names its intermediates here and nowhere else. */
      readonly inputMint?: string;
      readonly outputMint?: string;
      /**
       * The slot at which Jupiter last refreshed THIS AMM's state — a string
       * in the JSON. It can sit a long way behind contextSlot: measured on
       * 2026-09-20, 25 USDC quotes, USDC -> SPYx via Byreal lagged 10 and 17
       * slots, while USDC -> FIGUREAI's Raydium CLMM hop lagged 1,705 and
       * 2,176 — about a quarter of an hour. So contextSlot alone UNDERSTATES
       * how old the priced state is, which is why the slot check below
       * measures from the oldest hop, and why a TIGHT maxAgeSlots would
       * refuse routes Jupiter serves every day. It is a knob with a measured
       * caveat, not a default.
       */
      readonly updateContextSlot?: string | number;
    };
  }>;
}

export interface JupiterInstruction {
  readonly programId: string;
  readonly accounts: ReadonlyArray<{ readonly pubkey: string; readonly isSigner: boolean; readonly isWritable: boolean }>;
  readonly data: string;
}

export interface JupiterSwapInstructions {
  readonly swapInstruction: JupiterInstruction;
  readonly setupInstructions?: readonly JupiterInstruction[] | null;
  readonly cleanupInstruction?: JupiterInstruction | null;
  readonly tokenLedgerInstruction?: JupiterInstruction | null;
  readonly otherInstructions?: readonly JupiterInstruction[] | null;
  readonly addressLookupTableAddresses?: readonly string[] | null;
}

async function getJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(25_000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${url} answered ${response.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text) as unknown;
}

export async function fetchJupiterQuote(params: {
  readonly inputMint: PublicKey;
  readonly outputMint: PublicKey;
  readonly amountIn: bigint;
  readonly slippageBps: number;
  readonly onlyDirectRoutes?: boolean;
  /**
   * Venues to keep out of the route, by Jupiter's own label.
   *
   * NOT A PREFERENCE — A PRECONDITION. A venue that cannot execute in
   * simulation cannot be used by this vault at all: Privy simulates before the
   * policy runs, so such a route is refused upstairs, and if it ever were
   * signed it would burn the transaction. Measured on 2026-09-20: every route
   * through `Hadron` reverted with that venue's own error 0x3c under
   * simulateTransaction — both PreStocks legs at 5, 25 and 250 USD, and again
   * with the compute limit raised from 400k to 1.4M, with nothing in
   * otherInstructions that we had dropped.
   */
  readonly excludeDexes?: readonly string[];
  /**
   * The ONLY venues the route may use, by Jupiter's own label.
   *
   * NOT FOR PRODUCTION ROUTING — for experiments whose subject is the venue.
   * Whether a quote is gross or net belongs to the AMM that makes the final
   * transfer, so an experiment about that basis has to be able to say which
   * AMM, instead of re-quoting until Jupiter happens to pick one.
   */
  readonly dexes?: readonly string[];
}): Promise<JupiterQuote> {
  const query = new URLSearchParams({
    inputMint: params.inputMint.toBase58(),
    outputMint: params.outputMint.toBase58(),
    amount: params.amountIn.toString(),
    slippageBps: String(params.slippageBps),
    swapMode: "ExactIn",
    // Intermediates the vault never holds an account for: Jupiter's shared
    // accounts carry them, but a long tail token widens the route past what
    // one transaction fits.
    restrictIntermediateTokens: "true",
    ...(params.onlyDirectRoutes === true ? { onlyDirectRoutes: "true" } : {}),
    ...(params.excludeDexes !== undefined && params.excludeDexes.length > 0
      ? { excludeDexes: params.excludeDexes.join(",") }
      : {}),
    ...(params.dexes !== undefined && params.dexes.length > 0 ? { dexes: params.dexes.join(",") } : {}),
  });
  return (await getJson(`${LITE_API}/quote?${query.toString()}`)) as JupiterQuote;
}

export async function fetchJupiterSwapInstructions(params: {
  readonly quote: JupiterQuote;
  readonly vault: PublicKey;
  readonly vaultTarget: PublicKey;
}): Promise<JupiterSwapInstructions> {
  const body = {
    quoteResponse: params.quote,
    userPublicKey: params.vault.toBase58(),
    // SHARED ACCOUNTS ARE FORCED, NOT PREFERRED. The plain `route` instruction
    // threads USER-owned intermediate ATAs through the swap; every one of them
    // is a vault-owned token account the deltas do not measure, so guard (1)
    // refuses the whole call. Shared accounts keep the intermediates in
    // Jupiter's own program accounts, and the only vault accounts left in the
    // route are the two we measure. The discriminator check below is what
    // proves the flag was honoured.
    //
    // AND IT NARROWS THE VENUE SET, which the caller has to expect. Some
    // venues have no shared-accounts form at all: on 2026-09-20, quoting
    // USDC -> FIGUREAI with the CLMM/DLMM venues excluded produced a route
    // whose /swap-instructions answered HTTP 400 with
    //   {"error":"Simple AMMs are not supported with shared accounts",
    //    "errorCode":"NOT_SUPPORTED"}
    // That is not a refusal of ours and not a bug — it is Jupiter saying this
    // particular route cannot be built the only way we can use it. A caller
    // that must trade re-quotes with that venue excluded. It must NOT fall
    // back to the plain `route` instruction, which guard (1) refuses anyway.
    useSharedAccounts: true,
    // The vault PDA cannot sign the outer transaction, so it cannot pay for
    // an ATA it does not have; the wrap/unwrap helpers would also add
    // instructions our single-CPI invest can never forward.
    wrapAndUnwrapSol: false,
    // The vault is a PDA, off curve; Jupiter's account probing is not what
    // decides whether our accounts exist — our own invest constraints are.
    skipUserAccountsRpcCalls: true,
    destinationTokenAccount: params.vaultTarget.toBase58(),
    dynamicComputeUnitLimit: false,
    asLegacyTransaction: false,
  };
  return (await getJson(`${LITE_API}/swap-instructions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })) as JupiterSwapInstructions;
}

// ---------------------------------------------------------------------------
// The verification, and the shape invest()/convert() can consume.
// ---------------------------------------------------------------------------

/** What the instruction's own bytes say about the money, read from the tail. */
export interface RouteAmounts {
  readonly inAmount: bigint;
  readonly quotedOutAmount: bigint;
  readonly slippageBps: number;
  readonly platformFeeBps: number;
}

/**
 * Does a plan of `steps` RoutePlanSteps fit the bytes from `planStart` and end
 * EXACTLY at `planEnd`?
 *
 * WHAT IT WALKS, AND WHAT IT REFUSES TO PRETEND TO KNOW. Each step is
 * `swap: Swap, percent: u8, input_index: u8, output_index: u8`. The three
 * trailing bytes are fixed width; the Swap in front of them is not, and a
 * width table for its variants is the thing this file has always refused to
 * re-pin. So the walk does not decode a single swap. It asks a weaker question
 * that is still enough to anchor the tail: is there ANY reading of this region
 * as `steps` steps whose three trailing bytes could each be a real trailer?
 *
 *   percent is a split share, 1..=100 — Jupiter's encoder writes neither 0 nor
 *   more than 100.
 *   input_index and output_index address the route's own accounts, so both sit
 *   below the instruction's account count whenever the caller supplies it.
 *
 * MEASURED, on the captured mainnet SPYx build (36 B, one step `28 64 00 01`):
 * the plan ends at byte 17 and that is the only reading. Append one, two,
 * three or four bytes to that same instruction and every reading of the
 * shifted region needs a percent of 0, an input_index of 64, an input_index of
 * 120, or a percent of 125 — all impossible — so the shift is refused instead
 * of being read as a wider Swap.
 *
 * WHAT IT DOES NOT PROVE. A shift whose displaced bytes happen to look like a
 * trailer still reads, and this says nothing about the swap bytes it stepped
 * over. It is an anchor, not a decoder: it stops `data.length` from being the
 * only thing that decides where the money is read.
 */
function routePlanEndsExactlyAt(
  data: Buffer,
  steps: number,
  planStart: number,
  planEnd: number,
  accountCount: number | undefined,
): boolean {
  const trailerAt = (at: number): boolean => {
    const percent = data.readUInt8(at);
    if (percent < 1 || percent > 100) return false;
    if (accountCount === undefined) return true;
    return data.readUInt8(at + 1) < accountCount && data.readUInt8(at + 2) < accountCount;
  };
  // Every byte offset the plan could have reached after `step` steps. The walk
  // is breadth-first rather than greedy on purpose: the earliest byte that
  // looks like a trailer is not necessarily the real one, and a greedy walk
  // that took it would refuse an honest route whose swap payload happens to
  // contain one.
  let reachable = new Set<number>([planStart]);
  for (let step = 0; step < steps; step += 1) {
    const next = new Set<number>();
    for (const start of reachable) {
      for (let swap = SWAP_MIN_LEN; start + swap + ROUTE_PLAN_STEP_TRAILER_LEN <= planEnd; swap += 1) {
        if (trailerAt(start + swap)) next.add(start + swap + ROUTE_PLAN_STEP_TRAILER_LEN);
      }
    }
    if (next.size === 0) return false;
    reachable = next;
  }
  return reachable.has(planEnd);
}

/**
 * The money, read out of the instruction's own bytes — ANCHORED AT BOTH ENDS.
 *
 * WHAT `data.length` USED TO BE, AND WHY THAT WAS NOT ENOUGH. It was a lower
 * bound and nothing else: `tail = data.length - DATA_TAIL_LEN`, with no
 * statement at all about what sat in front of it. One trailing byte moves all
 * four numbers together — in_amount, quoted_out_amount, slippage_bps,
 * platform_fee_bps — and those four are exactly what the request-drift and
 * venue-threshold checks compare against. A shifted read can therefore AGREE
 * WITH ITSELF, because the same wrong offset feeds both sides of every
 * comparison built on it. That is the one failure mode the rest of this file
 * is constructed to prevent, so it cannot be left to a subtraction.
 *
 * SO THE FRONT IS WALKED TOO: discriminator(8), id(u8), the route_plan vec's
 * u32 length, and then the plan itself — see routePlanEndsExactlyAt, which
 * walks it without decoding it. The tail is read only when the plan ends
 * exactly where the tail begins.
 *
 * `accountCount` is the instruction's own account count, which bounds each
 * step's two indices. Optional because the arithmetic here is a unit test with
 * no account list; every caller inside this file passes it, and it is what
 * makes a two-byte shift refusable rather than merely unlikely.
 */
export function decodeRouteAmounts(data: Buffer, accountCount?: number): RouteAmounts {
  if (data.length < DATA_PLAN_START + DATA_TAIL_LEN) {
    refuse(
      "data-length",
      `instruction data is ${data.length} bytes, too short to carry the ${DATA_PLAN_START}-byte route-plan header ` +
        `and the ${DATA_TAIL_LEN}-byte amount tail`,
    );
  }
  const tail = data.length - DATA_TAIL_LEN;
  const planLen = tail - DATA_PLAN_START;
  const steps = data.readUInt32LE(DATA_PLAN_COUNT_OFFSET);
  if (steps === 0) {
    refuse("route-plan", "the route plan says it has no steps, so nothing in the data anchors the amount tail");
  }
  const smallest = steps * (SWAP_MIN_LEN + ROUTE_PLAN_STEP_TRAILER_LEN);
  if (smallest > planLen) {
    refuse(
      "route-plan",
      `the route plan says ${steps} step(s), needing at least ${smallest} bytes, but only ${planLen} sit between ` +
        `the header and the amount tail at byte ${tail}`,
    );
  }
  if (!routePlanEndsExactlyAt(data, steps, DATA_PLAN_START, tail, accountCount)) {
    refuse(
      "route-plan",
      `the route plan's ${steps} step(s) cannot end at byte ${tail}, where the ${DATA_TAIL_LEN}-byte amount tail is ` +
        `read from; these ${data.length} bytes are not the layout we decode, and every amount below would be read ` +
        "at an offset the data does not agree with",
    );
  }
  return {
    inAmount: data.readBigUInt64LE(tail),
    quotedOutAmount: data.readBigUInt64LE(tail + 8),
    slippageBps: data.readUInt16LE(tail + 16),
    platformFeeBps: data.readUInt8(tail + 18),
  };
}

/**
 * The venue's own floor, recomputed from the instruction's bytes:
 * out - floor(out * bps / 10_000). Jupiter's quote reports the same number as
 * `otherAmountThreshold`, and the two are cross-checked below — if they ever
 * disagree we do not understand the venue's guarantee, and a min_out derived
 * from a guarantee we do not understand is not protection.
 */
export function venueThresholdFrom(amounts: RouteAmounts): bigint {
  return amounts.quotedOutAmount - (amounts.quotedOutAmount * BigInt(amounts.slippageBps)) / 10_000n;
}

/** u64::MAX, the ceiling invest()'s own `u64::try_from` puts on the floor. */
const U64_MAX = 18_446_744_073_709_551_615n;

/**
 * The owner-signed floor invest() will compute for this call, to the raw unit:
 *
 *   floor = amount_in * leg.min_out_rate_wad / 1e18      (u128, truncating)
 *
 * MIRRORED, NOT APPROXIMATED. invest.rs does exactly this and then requires
 * `min_out >= floor && min_out > 0`, so a number computed any other way here
 * would refuse routes the program accepts or, worse, pass ones it will not.
 * BigInt division truncates like Rust's, and the u64 conversion the program
 * does after it is the reason a rate that overflows is a refusal rather than a
 * wrapped number.
 */
export function ownerFloorFor(amountIn: bigint, minOutRateWad: bigint): bigint {
  return (amountIn * minOutRateWad) / 1_000_000_000_000_000_000n;
}

export interface RouteOutput {
  /**
   * Jupiter's outAmount, verbatim.
   *
   * GROSS ONLY ON A GROSS-QUOTING VENUE, WHICH THIS FILE CANNOT TELL. Measured
   * on 2026-09-20: ANTHROPIC ending on Manifest was credited a whole transfer
   * fee BELOW this number, while the same mint at the same size ending on
   * Meteora DLMM was credited it to the raw unit. The basis belongs to the AMM
   * that makes the final transfer and Jupiter re-picks it per quote, so the
   * word that used to sit here without a condition was true of the case that
   * had been measured and false of the one beside it.
   *
   * ON EITHER BASIS THIS IS NOT A min_out: it is the one candidate measured
   * reverting with FillTooSmall 6020. investMinOut() returns the one to pass.
   */
  readonly quotedOut: bigint;
  /**
   * Jupiter's otherAmountThreshold, verbatim — the venue's own floor, stated
   * on the same basis as `quotedOut` above, and therefore on the same unknown.
   */
  readonly venueThreshold: bigint;
  /**
   * The rate used for the two net numbers below, applied ONCE — which the
   * route's own shape has to earn; see the unmodelled-fee-path refusal.
   */
  readonly transferFee: TransferFeeRate;
  /**
   * `quotedOut` net of that fee.
   *
   * WHAT THE VAULT'S DELTA READS ON A GROSS-QUOTING VENUE, if the venue fills
   * exactly the quote. On a NET-quoting one the identical fill credits
   * `quotedOut` itself and this number is a whole fee low — measured both ways
   * on 2026-09-20. It is here to be read and compared against a fill, never to
   * be passed as min_out.
   */
  readonly netOfQuotedOut: bigint;
  /**
   * What the vault's delta reads in the venue's OWN worst case, under the
   * WORSE of the two quoting bases — and therefore a min_out that cannot fire
   * on a fill the venue accepted, proved by our own arithmetic rather than by
   * Jupiter's internal check. This is the number to hand invest().
   *
   * `venueThreshold` is not, though not for the reason this file used to give:
   * measured, min_out = venueThreshold does not revert with FillTooSmall (see
   * the header). It is simply a floor we would be borrowing from Jupiter
   * instead of one we can state.
   */
  readonly netOfVenueThreshold: bigint;
  /**
   * The OWNER'S per-leg floor this route was checked against, or null when the
   * caller stated no rate — in which case nothing in this file bounded the
   * price, and the route says so rather than letting a reader assume it did.
   * See section (5) of the header.
   */
  readonly ownerFloor: bigint | null;
}

/**
 * The exact wire size of a LEGACY transaction carrying these instructions,
 * signed once per required signer.
 *
 * SERIALIZED, NOT ESTIMATED. web3.js's own compiler does the deduplication of
 * repeated keys, the writable/signer partitioning and the compact-u16 lengths;
 * an estimate has to reproduce all three and is wrong the first time a route
 * repeats a program id. PACKET_DATA_SIZE comes from web3.js too rather than
 * being typed out as 1,232.
 */
export function legacyTransactionBytes(payer: PublicKey, instructions: readonly TransactionInstruction[]): number {
  const message = new TransactionMessage({
    payerKey: payer,
    // A PLACEHOLDER: a blockhash is 32 bytes whatever it says, and asking an
    // RPC for a real one would make a size measurement need a network.
    recentBlockhash: PublicKey.default.toBase58(),
    instructions: [...instructions],
  }).compileToLegacyMessage();
  return 1 + 64 * message.header.numRequiredSignatures + message.serialize().length;
}

/**
 * The same measurement for the VERSIONED (v0) message a caller actually sends,
 * carrying no address lookup tables.
 *
 * TWO BYTES MORE THAN THE LEGACY FORM, AND MEASURED RATHER THAN ASSUMED: a v0
 * message adds the 0x80 version prefix and a compact-u16 count of
 * address-table lookups, one byte when there are none. It matters because the
 * fork harness predicted its size from the legacy form and then sent a v0 one:
 * 951 B predicted against 953 B sent on 2026-09-20, and 1,016 against 1,018 on
 * the re-run. Two bytes is nothing until the route is two bytes from the
 * limit, at which point the prediction says it fits and the send says it does
 * not.
 */
export function v0TransactionBytes(payer: PublicKey, instructions: readonly TransactionInstruction[]): number {
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: PublicKey.default.toBase58(),
    instructions: [...instructions],
  }).compileToV0Message();
  return 1 + 64 * message.header.numRequiredSignatures + message.serialize().length;
}

/** Does a legacy transaction of this size still fit in one packet? */
export function fitsLegacyTransaction(bytes: number): boolean {
  return bytes <= PACKET_DATA_SIZE;
}

/**
 * WHEN THIS ROUTE WAS PRICED. Without it a caller cannot tell a route quoted a
 * second ago from one quoted minutes ago, and the difference is not cosmetic:
 * min_out is derived from the quote's own numbers, so a stale quote is a LOOSE
 * MINIMUM — the vault would accept a fill measured against a price that has
 * since moved.
 *
 * THERE IS DELIBERATELY NO "built at" STAMP. A stamp taken when the builder
 * finished is always younger than the quote it carries, so it would make a
 * slow build look fresh; what a caller has to know is when JUPITER priced,
 * which is these fields.
 */
export interface RouteAge {
  /** Date.now() when the quote RESPONSE arrived. Read by the caller; this file has no clock. */
  readonly quotedAtMs: number;
  /** The quote's contextSlot, or null if it did not carry one. */
  readonly quotedAtSlot: number | null;
  /** The oldest per-hop updateContextSlot: the oldest state the price rests on. */
  readonly oldestHopSlot: number | null;
  /** Which hop that was, so a refusal can name it. */
  readonly oldestHopLabel: string | null;
  /** Jupiter's own timeTaken, converted to milliseconds. */
  readonly quoteTimeTakenMs: number | null;
}

/** How old a caller is willing to let a route be. At least one bound is required. */
export interface AgeTolerance {
  /** Wall-clock age of the quote, in milliseconds. */
  readonly maxAgeMs?: number;
  /**
   * Age in slots, measured from the OLDEST state the route rests on.
   *
   * READ updateContextSlot ABOVE BEFORE PICKING A NUMBER. A live one-hop route
   * measured 19 slots behind; a live two-hop one measured 2,177, because one
   * AMM's cached state was a quarter of an hour old. Anything under a couple
   * of thousand refuses the second kind.
   */
  readonly maxAgeSlots?: number;
}

/** The oldest slot this route's price rests on: the quote's, or an older hop's. */
export function pricedAtSlot(age: RouteAge): number | null {
  const candidates = [age.quotedAtSlot, age.oldestHopSlot].filter((slot): slot is number => slot !== null);
  return candidates.length === 0 ? null : Math.min(...candidates);
}

/**
 * Refuses a route older than the caller's tolerance.
 *
 * PURE, AND THE CLOCK COMES IN AS AN ARGUMENT — both so this is a unit test
 * and so a caller can re-run it immediately before signing, which is the check
 * that actually matters: a verification can only prove the route was fresh at
 * the moment it ran.
 *
 * AND IT IS NOT OPTIONAL ANY MORE. verifySharedAccountsRoute calls this as its
 * last step, against the clock and the tolerance its caller supplies, so a
 * route cannot be verified without being aged — which was the hole: the
 * context carried quotedAtMs and no tolerance, the age was assembled, and
 * nothing ever compared it to anything. Only buildJupiterRoute checked, and a
 * route is verified again when it is about to be SIGNED, which is later.
 *
 * A tolerance that states NEITHER bound is itself refused. "How stale is too
 * stale" is a decision, and a route nobody made it for is the state this
 * whole type exists to end.
 */
export function verifyRouteFresh(
  route: JupiterRoute,
  observed: { readonly nowMs: number; readonly slot?: number },
  tolerance: AgeTolerance,
): void {
  if (tolerance.maxAgeMs === undefined && tolerance.maxAgeSlots === undefined) {
    refuse("route-age", "no freshness tolerance was stated; a route nobody aged is a min_out nobody sized");
  }
  const age = route.age;
  if (observed.nowMs < age.quotedAtMs) {
    refuse("route-age", `the clock reads ${observed.nowMs}, before the quote arrived at ${age.quotedAtMs}`);
  }
  if (tolerance.maxAgeMs !== undefined) {
    const ageMs = observed.nowMs - age.quotedAtMs;
    if (ageMs > tolerance.maxAgeMs) {
      refuse("route-age", `the quote is ${ageMs} ms old, past the ${tolerance.maxAgeMs} ms this caller allows`);
    }
  }
  if (tolerance.maxAgeSlots !== undefined) {
    const priced = pricedAtSlot(age);
    if (priced === null) {
      refuse("route-age", "the quote carried no contextSlot and no hop slot, so its age in slots cannot be stated");
    }
    if (observed.slot === undefined) {
      refuse("route-age", `maxAgeSlots ${tolerance.maxAgeSlots} was asked for but no current slot was supplied`);
    }
    // A NEGATIVE AGE IS NOT AN ERROR. Jupiter's contextSlot is read at its own
    // commitment; a getSlot("confirmed") of ours can legitimately trail it.
    // Only a route priced too far in the PAST is refused.
    const ageSlots = observed.slot - priced;
    if (ageSlots > tolerance.maxAgeSlots) {
      const which =
        age.oldestHopSlot !== null && age.oldestHopSlot === priced
          ? ` (the ${age.oldestHopLabel ?? "?"} hop's own state, ${
              age.quotedAtSlot === null ? "?" : age.quotedAtSlot - priced
            } slots behind the quote)`
          : "";
      refuse(
        "route-age",
        `the route is priced at slot ${priced}${which}, ${ageSlots} slots behind the current ${observed.slot}, ` +
          `past the ${tolerance.maxAgeSlots} this caller allows`,
      );
    }
  }
}

export interface JupiterRoute {
  /** Hand to invest/convert as `venue_program`; must equal policy.venue_program. */
  readonly venueProgram: PublicKey;
  /**
   * Hand to `.remainingAccounts(...)` AS IS.
   *
   * EVERY isSigner IS ALREADY false, and must stay false. The vault PDA sits
   * in slot 2 and Jupiter marks it a signer; a signer flag in the OUTER
   * instruction would make the transaction demand a signature the PDA cannot
   * produce. invest.rs re-marks exactly that one key as a signer for the inner
   * CPI, which is the whole authority the program lends. Every existing caller
   * re-maps `isSigner: false` by hand at the call site; this builder does it
   * once, here.
   */
  readonly remainingAccounts: readonly AccountMeta[];
  /** Hand to invest/convert as `venue_data`. */
  readonly venueData: Buffer;
  /** Jupiter's tables. Needed to fit a multi-hop route in one transaction. */
  readonly lookupTableAddresses: readonly PublicKey[];
  readonly vault: PublicKey;
  readonly vaultIn: PublicKey;
  readonly vaultTarget: PublicKey;
  /**
   * WHAT WE ASKED FOR, echoed back — and the ONLY amount a caller may hand
   * invest() as amount_in. There is deliberately no `route.amountIn` field:
   * one would read like the number to forward while holding Jupiter's, and a
   * caller forwarding it would let the API decide what the vault spends.
   * Use investAmountIn(route), which returns this and re-checks it.
   */
  readonly request: RouteRequest;
  /** When Jupiter priced this. See RouteAge, and verifyRouteFresh. */
  readonly age: RouteAge;
  readonly output: RouteOutput;
  /** What the INSTRUCTION's own bytes say. Jupiter's numbers, for comparison. */
  readonly amounts: RouteAmounts;
  readonly hops: number;
  readonly labels: readonly string[];
  /**
   * CONDITIONS THIS BUILDER CAN SEE AND CANNOT DECIDE, empty when there are
   * none. Read them with routeWarning(); see RouteWarningCondition, and
   * section (7) of the header for why a warning here is not a refusal.
   */
  readonly warnings: readonly RouteWarning[];
  /**
   * THE ROUTE'S OWN SIZE, MEASURED: the exact wire bytes of a legacy
   * transaction carrying this one instruction and one signature.
   *
   * WHAT THIS REPLACES. The field here used to be a boolean,
   * `requiresVersionedTransaction`, computed as `hops > 1` and justified by a
   * single ~1,130 B sample — a hop count standing in for a size. It is not a
   * size: one-hop builds range 28-32 accounts and 36-40 bytes of data, which
   * is hundreds of bytes of spread, and nothing about a second hop says the
   * total crossed a limit. Measured: the captured 32-account, 36-byte SPYx
   * route is 941 B alone — the old sample was 1,130 — because 32 listed
   * accounts are only 23 distinct ones once the compiler deduplicates them.
   *
   * WHAT A CALLER STILL HAS TO DO. This is the route alone. invest() adds its
   * program id, its eight named accounts (minus any already here — the venue
   * program is), its own data, and whatever else the caller sends; only the
   * caller knows that, so the caller measures it with legacyTransactionBytes()
   * over its real instruction list and compares with fitsLegacyTransaction().
   * Measured on the cloned fork run, the whole invest-wrapped transaction with
   * a compute-budget instruction came to 953 B for a 28-key Manifest route.
   */
  readonly legacyBytes: number;
}

/**
 * WHAT THE CALLER ASKED FOR, kept so the answer can be checked against it.
 *
 * EVERY OTHER CROSS-CHECK IN THIS FILE CLOSES A LOOP BETWEEN TWO NUMBERS
 * JUPITER SUPPLIED. `amounts-drift` agrees the instruction's tail with the
 * quote JSON; `venue-threshold` recomputes otherAmountThreshold from that same
 * tail. Both would still pass if the API had answered a DIFFERENT question —
 * a larger amount, a wider slippage, another mint — because both numbers would
 * have drifted together. And the number that comes out the far end is min_out:
 * the floor the vault will accept is derived from `slippageBps`, so a quote
 * answering 900 bps to a request for 50 sets a floor nine times looser than
 * the one we chose, and nothing downstream would notice.
 *
 * So the loop has to be closed at the one place it can be: the request is OURS,
 * it never comes off the wire, and the quote is compared to it the moment it
 * arrives.
 *
 * AND THE REQUEST BOUNDS THE QUESTION, NOT THE ANSWER. There is no field here
 * for a price, and that is deliberate: a quote answering these exact four
 * things at a terrible rate passes every check in this file, because nothing
 * in it holds an independent price to judge the answer against. The bound on
 * the price is the vault owner's signed `min_out_rate_wad`, enforced by
 * invest() as FloorTooLow — see section (5) of the header, and
 * VerifyContext.ownerFloorRateWad, which checks that same floor here when the
 * caller has it.
 */
export interface RouteRequest {
  readonly inputMint: PublicKey;
  readonly targetMint: PublicKey;
  readonly amountIn: bigint;
  readonly slippageBps: number;
}

/**
 * Refuses a quote that answers a different question than the one asked.
 *
 * Called TWICE on purpose: once in buildJupiterRoute the instant the quote
 * lands — before it is posted to /swap-instructions, before a fee is read,
 * before anything is derived from it — and once inside
 * verifySharedAccountsRoute, so a caller that verifies a route it assembled
 * some other way cannot skip it. Pure: no network, no clock.
 */
export function verifyQuoteAnswersRequest(quote: JupiterQuote, request: RouteRequest): void {
  if (quote.inputMint !== request.inputMint.toBase58() || quote.outputMint !== request.targetMint.toBase58()) {
    refuse(
      "request-drift",
      `the quote is ${quote.inputMint} -> ${quote.outputMint}, not the requested ` +
        `${request.inputMint.toBase58()} -> ${request.targetMint.toBase58()}`,
    );
  }
  if (BigInt(quote.inAmount) !== request.amountIn) {
    refuse("request-drift", `the quote spends ${quote.inAmount}, not the requested amount_in ${request.amountIn}`);
  }
  if (quote.slippageBps !== request.slippageBps) {
    // This one decides min_out. A wider slippage than we asked for is a floor
    // the API chose for us, and it is the whole reason this check exists.
    refuse(
      "request-drift",
      `the quote came back at ${quote.slippageBps} bps of slippage, not the requested ${request.slippageBps}; ` +
        "min_out is derived from this number and would be the API's choice, not ours",
    );
  }
}

/**
 * The amount to hand invest() as amount_in — the CALLER'S, re-checked here.
 *
 * WHY A FUNCTION AND NOT A FIELD. invest() spends up to amount_in out of
 * vault_in and only refuses ABOVE it (Overspent); a number that arrived from
 * the API is therefore an API-chosen ceiling on the vault's own money. The
 * request is ours, so it is what this returns — and the instruction's own tail
 * is compared to it once more at the moment it becomes an argument, because
 * this is the last point before the bytes and the number are signed together.
 * Under a route from verifySharedAccountsRoute the two already agree; this
 * fires for a JupiterRoute assembled some other way.
 */
export function investAmountIn(route: JupiterRoute): bigint {
  if (route.amounts.inAmount !== route.request.amountIn) {
    refuse(
      "request-drift",
      `the instruction spends ${route.amounts.inAmount} but ${route.request.amountIn} was requested; ` +
        "amount_in is the caller's number, never the route's",
    );
  }
  return route.request.amountIn;
}

/**
 * The min_out to hand invest() — RECOMPUTED here, not read off a field.
 *
 * WHY A SIBLING OF investAmountIn(). RouteOutput holds four numbers and a
 * caller has to pick one; the first it meets is `quotedOut`, which carries the
 * most reassuring name and is the ONE candidate measured reverting with
 * FillTooSmall 6020 on a gross-quoting venue. Every wrong pick fails closed —
 * the transaction reverts and the vault keeps its principal — but "it fails
 * closed" is not an answer to "which number do I pass", and the first caller
 * to ask was a colleague, not an attacker.
 *
 * WHAT THE RE-CHECK IS FOR, and it is the same one investAmountIn does: under
 * a route from verifySharedAccountsRoute the derivation below already ran and
 * agreed. This fires for a JupiterRoute assembled some other way, at the last
 * point before the bytes and the number are signed together — the venue floor
 * is recomputed from the INSTRUCTION's own tail rather than trusted from
 * `output`, and the fee is applied to it once more.
 *
 * WHY THIS NUMBER. netOfVenueThreshold is below the credit under BOTH quoting
 * bases by our own arithmetic, so it never depends on Jupiter's internal check
 * staying what it is today. See section (4) of the header.
 */
export function investMinOut(route: JupiterRoute): bigint {
  const threshold = venueThresholdFrom(route.amounts);
  if (threshold !== route.output.venueThreshold) {
    refuse(
      "venue-threshold",
      `the instruction's own bytes give a venue floor of ${threshold}, but the route reports ` +
        `${route.output.venueThreshold}; min_out is derived from that floor and the two do not agree`,
    );
  }
  const minOut = netOfTransferFee(threshold, route.output.transferFee);
  if (minOut !== route.output.netOfVenueThreshold) {
    refuse(
      "venue-threshold",
      `the venue floor ${threshold} net of ${route.output.transferFee.basisPoints} bps is ${minOut}, but the route ` +
        `reports ${route.output.netOfVenueThreshold} as its net threshold`,
    );
  }
  if (minOut <= 0n) {
    refuse("venue-threshold", `the route's net threshold is ${minOut}, and invest() requires min_out > 0`);
  }
  if (route.output.ownerFloor !== null && minOut < route.output.ownerFloor) {
    refuse(
      "below-owner-floor",
      `this min_out would be ${minOut}, under the owner's own floor of ${route.output.ownerFloor}; invest() would ` +
        "refuse it with FloorTooLow after the transaction was spent",
    );
  }
  return minOut;
}

export interface VerifyContext {
  /** What was asked for. The quote is refused unless it answers exactly this. */
  readonly request: RouteRequest;
  /**
   * Date.now() the moment the quote response arrived, read by the CALLER.
   * This function has no clock: a route's age is measured from when its quote
   * was taken, and only the caller was there when it was.
   */
  readonly quotedAtMs: number;
  /**
   * The clock, and the chain's slot, AT THE MOMENT OF THIS VERIFICATION —
   * again read by the caller, because this function still has no clock of its
   * own. `slot` is only needed when the tolerance states maxAgeSlots.
   */
  readonly observed: { readonly nowMs: number; readonly slot?: number };
  /**
   * REQUIRED, AND THE POINT OF THE PAIR ABOVE. How old a price this
   * verification is willing to accept. A verification that states no tolerance
   * is refused, exactly as verifyRouteFresh refuses one: min_out is derived
   * from the quote's numbers, so a route nobody aged is a floor nobody sized.
   */
  readonly maxAge: AgeTolerance;
  readonly vault: PublicKey;
  readonly vaultIn: PublicKey;
  readonly vaultTarget: PublicKey;
  /**
   * Every token account in the route that the VAULT owns, resolved by the
   * caller — on chain by owner bytes, and by ATA derivation under both token
   * programs. Not from the API's labels: the labels are the thing under test.
   */
  readonly vaultOwnedTokenAccounts: ReadonlySet<string>;
  readonly transferFee: TransferFeeRate;
  /**
   * The vault owner's own `leg.min_out_rate_wad` for this leg, if the caller
   * has it. OPTIONAL, AND THE ONLY PRICE BOUND IN THIS FILE: with it, a route
   * whose net threshold falls under the floor invest() will compute is refused
   * here instead of on chain; without it, the price is bounded by the owner's
   * policy and by nothing else. Section (5) of the header says why it is not
   * this file's job to hold a price of its own.
   */
  readonly ownerFloorRateWad?: bigint;
}

/**
 * Refuses anything that is not the instruction we believe we asked for. Pure:
 * no network, no clock, no connection — so every refusal below is a unit test.
 */
export function verifySharedAccountsRoute(
  quote: JupiterQuote,
  response: JupiterSwapInstructions,
  context: VerifyContext,
): JupiterRoute {
  // FIRST, BEFORE ANY OTHER CHECK. Everything below agrees the instruction
  // with the quote; this is the only check that agrees the quote with us.
  verifyQuoteAnswersRequest(quote, context.request);

  if (quote.swapMode !== "ExactIn") {
    refuse("quote-mode", `swapMode is ${quote.swapMode}; invest() spends an exact amount_in`);
  }

  // Our invest forwards ONE instruction. Anything Jupiter says must also run —
  // a wSOL wrap, a token-ledger read, a cleanup close — simply would not, and
  // the route would half-execute or revert. An idempotent ATA create for the
  // destination is the one exception: skipUserAccountsRpcCalls makes Jupiter
  // emit it blindly, and invest() requires vault_target to exist anyway.
  const setup = response.setupInstructions ?? [];
  const strays = setup.filter((ix) => ix.programId !== ASSOCIATED_TOKEN_PROGRAM_ID.toBase58());
  if (strays.length > 0) {
    refuse("extra-instructions", `setup needs ${strays.map((ix) => ix.programId).join(", ")}, which invest() cannot forward`);
  }
  if (response.cleanupInstruction != null) {
    refuse("extra-instructions", "the route needs a cleanup instruction, which invest() cannot forward");
  }
  if (response.tokenLedgerInstruction != null) {
    refuse("extra-instructions", "the route needs a token-ledger instruction, which invest() cannot forward");
  }
  if ((response.otherInstructions ?? []).length > 0) {
    refuse("extra-instructions", `the route needs ${(response.otherInstructions ?? []).length} extra instructions`);
  }

  const instruction = response.swapInstruction;
  if (instruction.programId !== JUPITER_PROGRAM.toBase58()) {
    refuse("venue-program", `instruction targets ${instruction.programId}, not ${JUPITER_PROGRAM.toBase58()}`);
  }

  const data = Buffer.from(instruction.data, "base64");
  const disc = data.subarray(0, 8);
  if (!disc.equals(SHARED_ACCOUNTS_ROUTE_DISC)) {
    const plain = disc.equals(ROUTE_DISC)
      ? " — this is the plain `route`, whose user-owned intermediate ATAs guard (1) refuses"
      : "";
    refuse("discriminator", `data starts ${disc.toString("hex")}, not ${SHARED_ACCOUNTS_ROUTE_DISC.toString("hex")}${plain}`);
  }

  const keys = instruction.accounts;
  if (keys.length < FIXED_PREFIX_ACCOUNTS) {
    refuse("account-count", `${keys.length} accounts, fewer than sharedAccountsRoute's ${FIXED_PREFIX_ACCOUNTS}-slot prefix`);
  }

  const authority = keys[SLOT_USER_TRANSFER_AUTHORITY];
  if (authority === undefined || authority.pubkey !== context.vault.toBase58()) {
    refuse(
      "user-transfer-authority",
      `slot ${SLOT_USER_TRANSFER_AUTHORITY} is ${authority?.pubkey ?? "absent"}, not the vault ${context.vault.toBase58()}`,
    );
  }
  if (!authority.isSigner) {
    refuse(
      "user-transfer-authority",
      `slot ${SLOT_USER_TRANSFER_AUTHORITY} is not marked a signer; this is not the layout we verified`,
    );
  }

  const source = keys[SLOT_SOURCE_TOKEN_ACCOUNT];
  if (source === undefined || source.pubkey !== context.vaultIn.toBase58()) {
    refuse(
      "source-account",
      `slot ${SLOT_SOURCE_TOKEN_ACCOUNT} spends ${source?.pubkey ?? "absent"}, not the measured vault_in ${context.vaultIn.toBase58()}`,
    );
  }
  const destination = keys[SLOT_DESTINATION_TOKEN_ACCOUNT];
  if (destination === undefined || destination.pubkey !== context.vaultTarget.toBase58()) {
    // A fill that lands anywhere else measures zero in the account invest()
    // watches — the delta is taken around the CPI — so it reverts FillTooSmall.
    // AND THE REVERT TAKES THE SWAP WITH IT: Solana rolls the whole
    // transaction back, so what the vault loses is the attempt and the fee
    // paid for it, not the principal. That is still a signed transaction that
    // cannot land, which is why it is refused here instead of on chain.
    refuse(
      "destination-account",
      `slot ${SLOT_DESTINATION_TOKEN_ACCOUNT} delivers to ${destination?.pubkey ?? "absent"}, not the measured vault_target ${context.vaultTarget.toBase58()}`,
    );
  }

  // THE NET MODEL HAS A PRECONDITION, AND THIS IS IT.
  //
  // netOfVenueThreshold subtracts the mint's transfer fee ONCE. That is right
  // only when the last Token-2022 transfer into vault_target is the only one
  // between the AMM's output and the vault's credit. When slot 5 — Jupiter's
  // programDestinationTokenAccount — is the vault target itself, the AMM pays
  // straight into the account we measure and there is exactly one such
  // transfer. When it is JUPITER'S OWN account, the output lands there first
  // and is forwarded to us, which on a fee-bearing mint is TWO transfers and
  // TWO fees — and then a min_out modelling one fee sits ABOVE the credit, so
  // invest() reverts with FillTooSmall. THE REVERT UNDOES THE SWAP WITH IT:
  // Solana rolls the whole transaction back, so the vault loses the attempt
  // and the fee paid for it, not the principal. It is refused here anyway,
  // because a transaction that was signed and cannot land is the cost this
  // file exists to avoid.
  //
  // NEVER OBSERVED, AND THEREFORE NEVER MEASURED. Every fee-bearing build seen
  // so far puts the vault target in slot 5: FIGUREAI and ANTHROPIC on
  // 2026-09-20, and five more builds the same day across both legs, one to
  // three hops, venue pinned and unpinned. The only route with Jupiter's own
  // account in slot 5 was SPYx, which carries no transfer fee at all — so the
  // double-fee case has never actually happened, and the arithmetic for it has
  // never been checked against a fill.
  //
  // So it is refused rather than guessed. To settle it, run jupiter-sim.ts on
  // a route with this shape: it reports credit, withheld and quoted side by
  // side, and one fee versus two is the difference between
  // `credit + withheld == quotedOut` and a whole fee short of it.
  const programDestination = keys[SLOT_PROGRAM_DESTINATION_TOKEN_ACCOUNT];
  if (
    context.transferFee.basisPoints > 0 &&
    (programDestination === undefined || programDestination.pubkey !== context.vaultTarget.toBase58())
  ) {
    refuse(
      "unmodelled-fee-path",
      `slot ${SLOT_PROGRAM_DESTINATION_TOKEN_ACCOUNT} is ${programDestination?.pubkey ?? "absent"}, not the vault target ` +
        `${context.vaultTarget.toBase58()}, and ${context.transferFee.basisPoints} bps of transfer fee would then be ` +
        "charged twice on the way in; the net model subtracts it once and has never been measured against this shape",
    );
  }

  // Guard (1), applied here rather than discovered on chain: any vault-owned
  // token account in the route that is not one of the two measured ones is a
  // balance the venue may spend and the deltas cannot see.
  const measured = new Set([context.vaultIn.toBase58(), context.vaultTarget.toBase58()]);
  const unmeasured = [...new Set(keys.map((key) => key.pubkey))].filter(
    (key) => context.vaultOwnedTokenAccounts.has(key) && !measured.has(key),
  );
  if (unmeasured.length > 0) {
    refuse(
      "unmeasured-vault-account",
      `the route lists vault-owned token account(s) ${unmeasured.join(", ")} that invest() does not measure`,
    );
  }

  // The account count bounds each step's two indices; see decodeRouteAmounts.
  const amounts = decodeRouteAmounts(data, keys.length);
  if (
    amounts.inAmount !== BigInt(quote.inAmount) ||
    amounts.quotedOutAmount !== BigInt(quote.outAmount) ||
    amounts.slippageBps !== quote.slippageBps
  ) {
    refuse(
      "amounts-drift",
      `instruction carries in=${amounts.inAmount} out=${amounts.quotedOutAmount} bps=${amounts.slippageBps}, ` +
        `the quote says in=${quote.inAmount} out=${quote.outAmount} bps=${quote.slippageBps}`,
    );
  }
  if (amounts.platformFeeBps !== 0) {
    // A platform fee is taken out of the output, so the vault's delta would be
    // smaller than anything derived from outAmount. Refuse rather than model it.
    refuse("platform-fee", `the route charges ${amounts.platformFeeBps} bps of platform fee out of the vault's fill`);
  }

  const venueThreshold = BigInt(quote.otherAmountThreshold);
  const recomputed = venueThresholdFrom(amounts);
  if (recomputed !== venueThreshold) {
    refuse(
      "venue-threshold",
      `the quote's otherAmountThreshold ${venueThreshold} is not out - floor(out*bps/1e4) = ${recomputed}; ` +
        "the venue's own floor is not the number we think it is",
    );
  }

  const netOfVenueThreshold = netOfTransferFee(venueThreshold, context.transferFee);

  // THE ONLY PRICE BOUND IN THIS FILE, AND IT IS THE OWNER'S NUMBER.
  // Everything above agrees the answer with the question; none of it asks
  // whether the answer is a good one, and netOfVenueThreshold comes straight
  // off quote.outAmount, so a terrible price simply lowers the vault's own
  // minimum with it. The floor that stops that is signed by the vault owner
  // and enforced by invest() before the CPI; when the caller has it, the same
  // number is checked here, where a refusal costs no transaction.
  let ownerFloor: bigint | null = null;
  if (context.ownerFloorRateWad !== undefined) {
    ownerFloor = ownerFloorFor(context.request.amountIn, context.ownerFloorRateWad);
    if (ownerFloor > U64_MAX) {
      refuse(
        "below-owner-floor",
        `the owner's floor for ${context.request.amountIn} in at rate ${context.ownerFloorRateWad} is ${ownerFloor}, ` +
          "past u64; invest() refuses that policy outright",
      );
    }
    if (netOfVenueThreshold <= 0n) {
      refuse("below-owner-floor", "the route's net threshold is zero, and invest() requires min_out > 0");
    }
    if (netOfVenueThreshold < ownerFloor) {
      refuse(
        "below-owner-floor",
        `this route's min_out would be ${netOfVenueThreshold}, under the owner's own floor of ${ownerFloor} ` +
          `(${context.request.amountIn} in at ${context.ownerFloorRateWad} wad); invest() would refuse it with ` +
          "FloorTooLow after the transaction was spent. The quote answered our question at a price the owner did not sign for",
      );
    }
  }

  const output: RouteOutput = {
    quotedOut: amounts.quotedOutAmount,
    venueThreshold,
    transferFee: context.transferFee,
    netOfQuotedOut: netOfTransferFee(amounts.quotedOutAmount, context.transferFee),
    netOfVenueThreshold,
    ownerFloor,
  };

  // THE AGE, ASSEMBLED FROM WHAT THE QUOTE ACTUALLY CARRIES. contextSlot and
  // timeTaken used to be dropped at the type boundary; the per-hop
  // updateContextSlot never crossed it at all, and it is the older number.
  let oldestHopSlot: number | null = null;
  let oldestHopLabel: string | null = null;
  for (const step of quote.routePlan) {
    const raw = step.swapInfo.updateContextSlot;
    if (raw === undefined) continue;
    const slot = Number(raw);
    if (!Number.isFinite(slot)) continue;
    if (oldestHopSlot === null || slot < oldestHopSlot) {
      oldestHopSlot = slot;
      oldestHopLabel = step.swapInfo.label ?? "?";
    }
  }
  const age: RouteAge = {
    quotedAtMs: context.quotedAtMs,
    quotedAtSlot: quote.contextSlot ?? null,
    oldestHopSlot,
    oldestHopLabel,
    quoteTimeTakenMs: quote.timeTaken === undefined ? null : Math.round(quote.timeTaken * 1_000),
  };

  const hops = quote.routePlan.length;
  const remainingAccounts: AccountMeta[] = keys.map((key) => ({
    pubkey: new PublicKey(key.pubkey),
    isSigner: false,
    isWritable: key.isWritable,
  }));

  // A FEE PAYER THAT IS NOT IN THE ROUTE, because the real one is not either:
  // a crank key costs its own 32-byte entry and its own signature, and a payer
  // that happened to collide with a route key would undercount both.
  const inRoute = new Set(remainingAccounts.map((meta) => meta.pubkey.toBase58()));
  let probePayer = PublicKey.unique();
  for (let tries = 0; inRoute.has(probePayer.toBase58()) && tries < 64; tries += 1) probePayer = PublicKey.unique();
  const legacyBytes = legacyTransactionBytes(probePayer, [
    new TransactionInstruction({ programId: JUPITER_PROGRAM, keys: remainingAccounts, data }),
  ]);

  const route: JupiterRoute = {
    venueProgram: JUPITER_PROGRAM,
    remainingAccounts,
    venueData: data,
    lookupTableAddresses: (response.addressLookupTableAddresses ?? []).map((address) => new PublicKey(address)),
    vault: context.vault,
    vaultIn: context.vaultIn,
    vaultTarget: context.vaultTarget,
    request: context.request,
    age,
    output,
    amounts,
    hops,
    labels: quote.routePlan.map((step) => step.swapInfo.label ?? "?"),
    // SEEN HERE, DECIDED ELSEWHERE. Section (7) of the header: the tolerance
    // left over after the transfer fee only bites on a gross-quoting venue,
    // and which venue fills is not in anything this function was handed.
    warnings: routeWarningsFor(context.request, context.transferFee),
    legacyBytes,
  };

  // LAST, AND INSIDE THIS FUNCTION RATHER THAN AFTER IT. Everything above is
  // about shape and is true whenever it was checked; this one is about a
  // price, and is only true at the instant it runs. It sits here so that no
  // verification can return a route it never aged — including the verification
  // a caller runs just before signing, which is the one that decides whether a
  // min_out sized against this quote is still a floor worth having.
  verifyRouteFresh(route, context.observed, context.maxAge);
  return route;
}

/**
 * EVERY mint the route touches: the two ends, and each hop's own.
 *
 * WHY THE ENDS ARE NOT ENOUGH. The vault-ownership pass exists to catch a
 * token account the vault owns that the program's two deltas do not measure.
 * It has two halves, and a multi-hop route slips between them: the on-chain
 * half only sees accounts that ALREADY EXIST, and the derivation half was
 * given the input and target mints alone, so it built four candidate ATAs and
 * nothing at all for an intermediate. A vault ATA for an intermediate mint
 * that does not exist yet was therefore invisible to both — and it is exactly
 * the account a route could create and then spend, unmeasured.
 *
 * The intermediates are only ever named inside routePlan, which is why they
 * are read out of it here rather than asked of the caller.
 */
export function routeMints(quote: JupiterQuote, inputMint: PublicKey, targetMint: PublicKey): PublicKey[] {
  const seen = new Set<string>([inputMint.toBase58(), targetMint.toBase58()]);
  const mints = [inputMint, targetMint];
  for (const step of quote.routePlan) {
    for (const mint of [step.swapInfo.inputMint, step.swapInfo.outputMint]) {
      if (mint === undefined || seen.has(mint)) continue;
      seen.add(mint);
      mints.push(new PublicKey(mint));
    }
  }
  return mints;
}

/**
 * Every token account in `keys` that the vault owns.
 *
 * TWO PASSES, BECAUSE NEITHER ALONE IS ENOUGH. The on-chain pass reads the
 * owner bytes the way venue_route.rs does, and so sees non-ATA vault accounts
 * the derivation cannot guess. The derivation pass covers accounts that do not
 * exist yet — a route may list an ATA it intends to create, and an account that
 * is empty at read time is not an account the venue cannot fill and then spend.
 * The API's own `pubkey` labels are never consulted; they are the claim under test.
 *
 * `mints` MUST BE EVERY MINT THE ROUTE TOUCHES, not just the two ends — see
 * routeMints above. Both passes are blind to an intermediate the derivation
 * was never handed.
 */
export async function findVaultOwnedTokenAccounts(
  connection: Connection,
  vault: PublicKey,
  keys: readonly string[],
  mints: readonly PublicKey[],
): Promise<Set<string>> {
  const unique = [...new Set(keys)];
  const found = new Set<string>();

  const derived = new Set<string>();
  for (const mint of mints) {
    for (const program of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      // allowOwnerOffCurve: the vault IS a PDA, so the on-curve check would
      // throw on every single derivation.
      derived.add(getAssociatedTokenAddressSync(mint, vault, true, program).toBase58());
    }
  }
  for (const key of unique) if (derived.has(key)) found.add(key);

  for (let offset = 0; offset < unique.length; offset += 100) {
    const page = unique.slice(offset, offset + 100).map((key) => new PublicKey(key));
    const infos = await connection.getMultipleAccountsInfo(page, "confirmed");
    infos.forEach((info, index) => {
      if (info === null) return;
      const byToken = info.owner.equals(TOKEN_PROGRAM_ID) || info.owner.equals(TOKEN_2022_PROGRAM_ID);
      // 165 bytes is all of an SPL Token account and the prefix of every
      // Token-2022 one; the owner sits at 32..64 in both. Same reasoning, and
      // the same offsets, as venue_route.rs.
      if (!byToken || info.data.length < 165) return;
      if (info.data.subarray(32, 64).equals(vault.toBuffer())) found.add(page[index]!.toBase58());
    });
  }
  return found;
}

export interface BuildJupiterRouteParams {
  readonly vault: PublicKey;
  readonly vaultIn: PublicKey;
  readonly vaultTarget: PublicKey;
  readonly inputMint: PublicKey;
  readonly targetMint: PublicKey;
  readonly amountIn: bigint;
  readonly slippageBps: number;
  /**
   * REQUIRED, AND ON PURPOSE. Every caller has to say how old a quote it is
   * willing to sign against, because min_out comes off that quote's numbers.
   * Checked once here, against the clock at build time; a caller that holds a
   * route for a while re-runs verifyRouteFresh before it signs.
   */
  readonly maxAge: AgeTolerance;
  readonly onlyDirectRoutes?: boolean;
  /** Venues to keep out of the route; see fetchJupiterQuote. */
  readonly excludeDexes?: readonly string[];
  /** The only venues allowed, for experiments about the venue; see fetchJupiterQuote. */
  readonly dexes?: readonly string[];
  /**
   * Take the transfer fee from the rate that may be in force when the
   * transaction LANDS rather than the one in force now. Default true: the
   * PreStocks legs step 50 -> 100 bps at epoch 1039, an epoch is about two
   * days, and a min_out that was right at build time and wrong at land time
   * reverts after the spend.
   */
  readonly useWorstCaseTransferFee?: boolean;
  /**
   * The vault owner's `leg.min_out_rate_wad` for this leg, if the caller has
   * it. See VerifyContext.ownerFloorRateWad, and section (5) of the header:
   * this is the only bound in this file on what the route costs.
   */
  readonly ownerFloorRateWad?: bigint;
}

/**
 * Quote it, build it, and refuse it unless every condition holds.
 *
 * NO KEY, NO SIGNATURE, NO SEND. This returns bytes and account lists; whether
 * they are ever signed is somebody else's decision, made somewhere else.
 */
export async function buildJupiterRoute(
  connection: Connection,
  params: BuildJupiterRouteParams,
): Promise<JupiterRoute> {
  const request: RouteRequest = {
    inputMint: params.inputMint,
    targetMint: params.targetMint,
    amountIn: params.amountIn,
    slippageBps: params.slippageBps,
  };

  // THE FRESHNESS WINDOW BELONGS TO THE PRICE, NOT TO US, so nothing that can
  // be read without the quote is read inside it. The destination mint's
  // transfer-fee config and the epoch depend on the target mint alone, and
  // they used to be fetched AFTER the quote had landed — two RPC round trips
  // charged to the caller's maxAgeMs, on top of the two that genuinely need
  // the quote. Started here, they overlap the quote's own round trip and cost
  // the window nothing.
  //
  // WHAT IS LEFT INSIDE THE WINDOW, AND WHY IT CANNOT LEAVE: the
  // /swap-instructions POST, which is the quote being turned into bytes, and
  // the vault-ownership read, which is over the keys that POST returned.
  // Those two are the builder's irreducible cost, and on a slow RPC they are
  // still age — the price really is that much older. A refusal says so
  // explicitly below, so "our RPC was slow" never reads as "the price moved".
  const feeRead = readDestinationTransferFee(connection, params.targetMint);
  // Awaited after the quote, so a rejection here must not surface as an
  // unhandled one while the quote is still in flight.
  void feeRead.catch(() => undefined);

  // STAMPED THE INSTANT IT LANDS, before the round trips below, so the age a
  // caller reads is the quote's and not the builder's.
  const quote = await fetchJupiterQuote({
    inputMint: params.inputMint,
    outputMint: params.targetMint,
    amountIn: params.amountIn,
    slippageBps: params.slippageBps,
    ...(params.onlyDirectRoutes === true ? { onlyDirectRoutes: true } : {}),
    ...(params.excludeDexes === undefined ? {} : { excludeDexes: params.excludeDexes }),
    ...(params.dexes === undefined ? {} : { dexes: params.dexes }),
  });
  const quotedAtMs = Date.now();
  // BEFORE THE QUOTE IS USED FOR ANYTHING — including being posted straight
  // back to /swap-instructions, which is what turns a drifted quote into an
  // instruction we would otherwise go on to verify against that same quote.
  verifyQuoteAnswersRequest(quote, request);

  const response = await fetchJupiterSwapInstructions({
    quote,
    vault: params.vault,
    vaultTarget: params.vaultTarget,
  });

  const fee = await feeRead;
  const vaultOwnedTokenAccounts = await findVaultOwnedTokenAccounts(
    connection,
    params.vault,
    response.swapInstruction.accounts.map((key) => key.pubkey),
    routeMints(quote, params.inputMint, params.targetMint),
  );

  // The slot is only read when a slot bound was asked for: an RPC round trip
  // nobody stated a tolerance for is a round trip that buys nothing.
  const slot = params.maxAge.maxAgeSlots === undefined ? undefined : await connection.getSlot("confirmed");
  try {
    return verifySharedAccountsRoute(quote, response, {
      request,
      quotedAtMs,
      // The freshness check happens INSIDE the verification, so the clock is
      // read here, as late as it can be and still be the clock that check uses.
      observed: { nowMs: Date.now(), ...(slot === undefined ? {} : { slot }) },
      maxAge: params.maxAge,
      vault: params.vault,
      vaultIn: params.vaultIn,
      vaultTarget: params.vaultTarget,
      vaultOwnedTokenAccounts,
      transferFee: params.useWorstCaseTransferFee === false ? fee.current : fee.worstCase,
      ...(params.ownerFloorRateWad === undefined ? {} : { ownerFloorRateWad: params.ownerFloorRateWad }),
    });
  } catch (error) {
    // A ROUTE-AGE REFUSAL FROM A BUILD NAMES THE BUILDER'S OWN SHARE. The age
    // is real either way, but a caller reading "the quote is 41,000 ms old"
    // cannot tell a market that moved from an RPC that stalled, and the two
    // call for opposite responses: re-quote, or fix the endpoint.
    if (error instanceof JupiterRouteRefusal && error.condition === "route-age") {
      refuse(
        "route-age",
        `${error.reason}; ${Date.now() - quotedAtMs} ms of that age is this builder's own post-quote round ` +
          "trips (/swap-instructions and the vault-account read), not price movement",
      );
    }
    throw error;
  }
}
