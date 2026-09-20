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
// (4) AND THE ONE THE GUARDS CANNOT SEE. Two of the three legs are Token-2022
// mints with a transfer fee (50 bps now, 100 bps from epoch 1039, maximumFee
// u64::MAX). The credit a destination account receives is NET of that fee, so
// the delta the program measures is NET — while Jupiter's outAmount and
// otherAmountThreshold are GROSS. A min_out copied from the threshold is a
// number about different money. Worse, the two roundings go opposite ways:
// Jupiter FLOORS its slippage deduction (threshold = out - floor(out*bps/1e4))
// and Token-2022 CEILS its fee (net = out - ceil(out*bps/1e4)), so at epoch
// 1039, where both rates are 100 bps, the net is the threshold MINUS ONE RAW
// UNIT even at zero slippage. min_out = otherAmountThreshold does not merely
// have no margin; it reverts. Hence netOfVenueThreshold below, which is the
// largest min_out the venue's own guarantee actually covers.
//
// (5) AND THE CONSEQUENCE THAT BITES FIRST, MEASURED AT THE EPOCH BOUNDARY.
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

import { createHash } from "node:crypto";
// AccountMeta IS A TYPE (see raydium-swap.ts for the full story): a
// value-position import of it survives only by erasure, and the day it stops,
// the keeper does not boot.
import type { AccountMeta, Connection } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
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
 * Slot 5 is NOT pinned on purpose: it is Jupiter's programDestinationTokenAccount
 * and it is sometimes Jupiter's own account (SPYx) and sometimes ours
 * (ANTHROPIC, FIGUREAI). Pinning it would refuse honest routes.
 */
export const SLOT_USER_TRANSFER_AUTHORITY = 2;
export const SLOT_SOURCE_TOKEN_ACCOUNT = 3;
export const SLOT_DESTINATION_TOKEN_ACCOUNT = 6;
/** Slots 0..12 are the fixed prefix; anything shorter is not this instruction. */
const FIXED_PREFIX_ACCOUNTS = 13;

/**
 * sharedAccountsRoute's data ends with a FIXED 19-byte tail:
 *   in_amount(u64) quoted_out_amount(u64) slippage_bps(u16) platform_fee_bps(u8)
 *
 * READ BACKWARD, ALWAYS. Forward parsing would have to walk the route plan,
 * whose Swap enum is variable-width and whose variants change whenever Jupiter
 * integrates an AMM — a layout we would be re-pinning forever. The tail is
 * position-independent, and it is the only part of the data that carries money.
 */
const DATA_TAIL_LEN = 19;

export type RefusalCondition =
  | "quote-mode"
  | "venue-program"
  | "discriminator"
  | "account-count"
  | "data-length"
  | "user-transfer-authority"
  | "source-account"
  | "destination-account"
  | "unmeasured-vault-account"
  | "amounts-drift"
  | "platform-fee"
  | "venue-threshold"
  | "extra-instructions";

/** A refusal names its condition, so a caller can log which guard said no. */
export class JupiterRouteRefusal extends Error {
  readonly condition: RefusalCondition;
  constructor(condition: RefusalCondition, message: string) {
    super(`jupiter route refused [${condition}]: ${message}`);
    this.name = "JupiterRouteRefusal";
    this.condition = condition;
  }
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
  /** max(current, pending) — the rate a min_out must survive. */
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
 * One up, one down, same 100 bps — and the net lands a raw unit below the
 * venue's threshold.
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
  const worstCase = pending !== null && pending.basisPoints > current.basisPoints ? pending : current;
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
  readonly routePlan: ReadonlyArray<{ readonly swapInfo: { readonly label?: string } }>;
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

export function decodeRouteAmounts(data: Buffer): RouteAmounts {
  if (data.length < 8 + DATA_TAIL_LEN) {
    refuse("data-length", `instruction data is ${data.length} bytes, too short to carry the amount tail`);
  }
  const tail = data.length - DATA_TAIL_LEN;
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

export interface RouteOutput {
  /** Jupiter's outAmount, verbatim. GROSS: before the mint's transfer fee. */
  readonly quotedOut: bigint;
  /** Jupiter's otherAmountThreshold, verbatim. Also GROSS. */
  readonly venueThreshold: bigint;
  /** The rate used for the two net numbers below. */
  readonly transferFee: TransferFeeRate;
  /** What the vault's delta reads if the venue fills exactly the quote. */
  readonly netOfQuotedOut: bigint;
  /**
   * What the vault's delta reads in the venue's OWN worst case — and therefore
   * the largest min_out that cannot revert with FillTooSmall. This is the
   * number to hand invest(); `venueThreshold` is not.
   */
  readonly netOfVenueThreshold: bigint;
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
  readonly amountIn: bigint;
  readonly output: RouteOutput;
  readonly amounts: RouteAmounts;
  readonly hops: number;
  readonly labels: readonly string[];
  /**
   * Measured wrapped in our invest: one hop is ~1,130 B and fits a legacy
   * transaction; two hops are ~1,308-1,400 B against a 1,232 B limit and need
   * a v0 transaction with `lookupTableAddresses`.
   */
  readonly requiresVersionedTransaction: boolean;
}

export interface VerifyContext {
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
    // A fill that lands anywhere else measures zero and reverts FillTooSmall
    // after the money has already left — the delta is taken around the CPI.
    refuse(
      "destination-account",
      `slot ${SLOT_DESTINATION_TOKEN_ACCOUNT} delivers to ${destination?.pubkey ?? "absent"}, not the measured vault_target ${context.vaultTarget.toBase58()}`,
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

  const amounts = decodeRouteAmounts(data);
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

  const output: RouteOutput = {
    quotedOut: amounts.quotedOutAmount,
    venueThreshold,
    transferFee: context.transferFee,
    netOfQuotedOut: netOfTransferFee(amounts.quotedOutAmount, context.transferFee),
    netOfVenueThreshold: netOfTransferFee(venueThreshold, context.transferFee),
  };

  const hops = quote.routePlan.length;
  return {
    venueProgram: JUPITER_PROGRAM,
    remainingAccounts: keys.map((key) => ({
      pubkey: new PublicKey(key.pubkey),
      isSigner: false,
      isWritable: key.isWritable,
    })),
    venueData: data,
    lookupTableAddresses: (response.addressLookupTableAddresses ?? []).map((address) => new PublicKey(address)),
    vault: context.vault,
    vaultIn: context.vaultIn,
    vaultTarget: context.vaultTarget,
    amountIn: amounts.inAmount,
    output,
    amounts,
    hops,
    labels: quote.routePlan.map((step) => step.swapInfo.label ?? "?"),
    requiresVersionedTransaction: hops > 1,
  };
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
  readonly onlyDirectRoutes?: boolean;
  /** Venues to keep out of the route; see fetchJupiterQuote. */
  readonly excludeDexes?: readonly string[];
  /**
   * Take the transfer fee from the rate that may be in force when the
   * transaction LANDS rather than the one in force now. Default true: the
   * PreStocks legs step 50 -> 100 bps at epoch 1039, an epoch is about two
   * days, and a min_out that was right at build time and wrong at land time
   * reverts after the spend.
   */
  readonly useWorstCaseTransferFee?: boolean;
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
  const quote = await fetchJupiterQuote({
    inputMint: params.inputMint,
    outputMint: params.targetMint,
    amountIn: params.amountIn,
    slippageBps: params.slippageBps,
    ...(params.onlyDirectRoutes === true ? { onlyDirectRoutes: true } : {}),
    ...(params.excludeDexes === undefined ? {} : { excludeDexes: params.excludeDexes }),
  });
  const response = await fetchJupiterSwapInstructions({
    quote,
    vault: params.vault,
    vaultTarget: params.vaultTarget,
  });

  const fee = await readDestinationTransferFee(connection, params.targetMint);
  const vaultOwnedTokenAccounts = await findVaultOwnedTokenAccounts(
    connection,
    params.vault,
    response.swapInstruction.accounts.map((key) => key.pubkey),
    [params.inputMint, params.targetMint],
  );

  return verifySharedAccountsRoute(quote, response, {
    vault: params.vault,
    vaultIn: params.vaultIn,
    vaultTarget: params.vaultTarget,
    vaultOwnedTokenAccounts,
    transferFee: params.useWorstCaseTransferFee === false ? fee.current : fee.worstCase,
  });
}
