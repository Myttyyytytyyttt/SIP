// What SIP offers a new vault and its first investment policy, decided once and
// kept beside the rules those values must pass. Browser-safe: the forms, the
// build route and the local proof read the same numbers.
//
// test/product.test.ts pins every value here to rules.ts and to the verifier's
// caps, so a changed default fails a test before it reaches a wallet.
//
// THE VOLUME DECISION IS ONE CONSTANT. The keeper cannot yet settle VOLUME from
// real trades (settle-decision.ts UNSUPPORTED_MODE), so a volume vault would
// receive nothing. Until the owner decides to build the volume meter, the web
// offers PROFIT only: the build route refuses mode 1 and the form greys it out.
// The program itself accepts VOLUME vaults from any client, which is intended.
//
// WHY THESE CAPS (review findings 1 and 2 on the program):
//  * max_contribution 0.06 SOL bounds one settlement. At about $100 a SOL it is
//    $6.00, $5.9999 after the SOL/USDC pool's 0.04 % fee, so one settle can fund
//    the first $5 buy down to about $83 a SOL. It does not bound how many
//    settlements run; nothing on chain does.
//  * wallet_reserve 0.05 SOL is the one web-chosen bound on a settle burst: a
//    settlement that would leave less than rent(0) + reserve is refused.
//  * max_per_call 1,000 USDC is the largest value that keeps convert at its
//    tightest program bound, 1 SOL per call (convert.rs compares lamports with
//    max(max_per_call, 1e9)). rules.ts's default, u64::MAX, leaves convert
//    unbounded per call. This overrides "caps at the maximum"; the owner confirms.
//  * max_rolling_30d = 31 × max_per_call: one maximum buy per day-bucket.
//
// AND AT max_per_call THE KEEPER BUYS NOTHING. This is a DEFECT, measured
// 2026-09-21 and still standing in the number below, not a decision. The
// arithmetic is the keeper's own, in solana-keeper/src/invest-decision.ts:
//  * a CONVERTING turn is tested at its worst reachable case, because the USDC
//    the convert will bring in does not exist yet — turnSpendCeiling takes
//    min(max_per_call, 30-day headroom), which on a fresh vault is the whole
//    1,000 USDC;
//  * legShare splits that by weight: at today's two equal legs, 500 USDC into
//    ONE pool;
//  * legDepthDecision then requires that pool's in-side reserve to cover the
//    spend MIN_POOL_DEPTH_MULTIPLE (50) times over — 25,000 USDC for a
//    500-USDC leg.
// ANTHROPIC/USDC held 9,541,652,779 raw USDC when it was last read (mainnet
// 2026-09-20, slot 448864213). That is 18.9x cover against 50x required, so
// EVERY converting turn is REFUSED at this default: no stock bought, no SOL
// converted, at any balance. The same pool admits 9,541.65 / 50 = $190.83 a leg,
// about $381.67 for a two-leg basket. The neck is therefore roughly $380, and a
// default near $100 would clear it about 3.8x over.
//
// WHAT SUCH A NUMBER IS CALIBRATED AGAINST, AND WHAT INVALIDATES IT. ONE pool's
// reserve, read ONCE, on ONE day. It is not a property of the product and no
// constant here can make it one: the same kind of reserve fell from about $6,700
// to $51 in two days on the leg this catalogue no longer offers. A third leg,
// different weights, a change in MIN_POOL_DEPTH_MULTIPLE, or that pool simply
// thinning all move the neck, and nothing in this file re-reads it. The gate
// that is always right is the keeper's, because it measures depth inside the
// turn against the amount that turn will really spend; a number here only
// decides whether the product's own default walks into that gate or clears it.
//
// WHY IT IS STILL 1,000. The web has already routed around it: InvestingCard's
// box starts at SUGGESTED_PER_BUY_RAW ($190, half the $380 ceiling) and no
// longer pre-fills this constant, so nobody signs $1,000 from the form today.
// Lowering the constant itself is a FOUR-FILE change, which the session that
// wrote this note was not scoped for — test/fixtures/owner-transactions.ts (the
// SET_INVEST_POLICY_GOLDEN_FLOORS wire and data hex are built from this value;
// reprint them with `pnpm --dir packages/solana-core exec tsx
// bin/print-owner-fixtures.mts`), test/handlers-build.test.ts (a pinned
// max_per_call, and a boundary case sized against 1,000), test/product.test.ts,
// and website-oficial/src/lib/vault-flows.test.ts: eleven tests in all. Leaving
// the number undocumented was the worse of the two options.

import { ANTHROPIC_MINT, ANTHROPIC_USDC_POOL, SPYX_MINT, SPYX_USDC_POOL, TOKEN_2022_PROGRAM } from "./addresses";
import type { OwnerInstructionName } from "./idl";
import { DEFAULT_RATES, MODE_PROFIT, type VaultPolicyInput } from "./rules";

/** The owner's open decision on VOLUME, off until the keeper can measure volume. Changing it must change a test. */
export const VOLUME_MODE_OFFERED: boolean = false;

/** What create_vault_v2 is built with when the request names nothing else. Both rates travel in both modes. */
export const DEFAULT_VAULT_POLICY: Readonly<VaultPolicyInput> = Object.freeze({
  mode: MODE_PROFIT,
  skimBps: DEFAULT_RATES.profitBps,
  volumeBps: DEFAULT_RATES.volumeBps,
  maxContribution: 60_000_000n,
  walletReserve: 50_000_000n,
});

/** The first investment policy's caps, in USDC raw units (6 decimals): $1,000 per buy, $31,000 per 30 days. */
export const DEFAULT_INVEST_CAPS = Object.freeze({ maxPerCall: 1_000_000_000n, maxRolling30d: 31_000_000_000n });

/** The convert floor sits this far under the live SOL/USDC pool price: 10 %. */
export const CONVERT_FLOOR_MARGIN_BPS = 1_000;
/** A leg's floor sits this far under the live pool rate: 5 %, so at most about 5.3 % over today's price is paid. */
export const LEG_FLOOR_MARGIN_BPS = 500;

/** A classic SPL Token account (the vault's wSOL and USDC accounts): 165 bytes. Its rent is read from the chain, never derived. */
export const CLASSIC_TOKEN_ACCOUNT_BYTES = 165;

export interface OfferedLeg {
  readonly symbol: string;
  readonly name: string;
  readonly mint: string;
  /** The Raydium CLMM pool (mint0 = this leg, mint1 = USDC) its floor is read from. */
  readonly pool: string;
  readonly tokenProgram: string;
  readonly decimals: number;
  /** What the Associated Token Account program allocates for this mint, extensions included: the size its rent is read for. */
  readonly tokenAccountBytes: number;
}

/**
 * The stocks a policy can buy from the web: two, both Token-2022, each priced
 * from its own Raydium CLMM pool against USDC. bin/check-legs.mts asserts every
 * number below against mainnet, depth included — a pool can be structurally
 * perfect and still route nothing.
 *
 * THE BYTES, PER LEG. Each is 165 for the base account, the account type (1),
 * then one header (4) plus its value for every extension the mint requires:
 *  * SPYx, 179: ImmutableOwner (4), PausableAccount (4), TransferHookAccount (5).
 *  * ANTHROPIC, 191: those same 179, plus TransferFeeAmount (4 + an 8-byte
 *    withheld amount).
 *
 * ANTHROPIC NOW CHARGES 100 BPS TO TRANSFER, AND THIS PARAGRAPH SAID 50 UNTIL
 * IT WAS WRONG. Its mint carries a live transfer-fee extension — with
 * maximum_fee at u64::MAX, so nothing caps it — which lands on the amount
 * RECEIVED, not the amount sent. A leg floor priced from the pool alone does not
 * see it.
 *
 * THE FEE'S HISTORY, AND WHY NO SENTENCE HERE IS THE SOURCE OF IT. The issuer
 * writes this number whenever it likes, at an epoch boundary, and the mint is
 * the only place it is true. Read on mainnet 2026-09-21: older{epoch 1032,
 * 50 bps}, newer{epoch 1039, 100 bps}, and getEpochInfo answers 1039 — so the
 * scheduled rise the previous version of this comment called "not hypothetical"
 * HAS FIRED, and the 50 written here outlived its own measurement for a day.
 * MAX_LEG_FEE_BPS is 100 and invest-decision.ts refuses on `fee.bps > MAX`, so
 * ANTHROPIC is admitted today with EXACTLY ZERO MARGIN: one more issuer write
 * refuses the whole basket and the SOL conversion with it, permanently, until
 * the fee comes back down. Read the fee from the mint, never from this file.
 * SPYx has no transfer fee. ANTHROPIC's transfer_hook program id is null: a real
 * hook would need transfer_checked_with_transfer_hook, which the program does not
 * call.
 *
 * WHY FIGUREAI IS NOT OFFERED, though addresses.ts still names its mint and pool
 * and this file deliberately leaves them there. NOTHING IS WRONG WITH THE MINT:
 * it is the same Token-2022 shape as ANTHROPIC — 9 decimals, null hook, the same
 * issuer key, the same 191-byte token account. ITS PINNED POOL IS EMPTY. Read on
 * mainnet 2026-09-20 (epoch 1038), HvpDt2…HduM held 0.110274669 FIGUREAI and
 * 31.91 USDC — about $51 all told, down from roughly $6,700 two days earlier,
 * when check:legs last passed it. A buy over about $11 reverts.
 *
 * AND A SINGLE-HOP USDC BUY IS ALL SAVERFI CAN DO TODAY. The program pins the
 * venue PROGRAM and not the route — invest.rs takes the account list from the
 * crank — and the keeper brings exactly one Raydium CLMM swap_v2 per leg,
 * through the single pool its registry holds for that mint
 * (solana-keeper/src/invest-tick.ts: deps.pools.get(mint), then fetchLiveRoute).
 * No multi-hop, no second venue, and a mint with no configured pool refuses the
 * WHOLE basket before anything moves. So a leg whose one pool is empty is an
 * unbuyable leg however good its mint is — and `pool` below is both that route
 * and where the leg's floor is priced.
 *
 * A basket holding it would buy SPYx and ANTHROPIC every sweep, revert on
 * FIGUREAI, and repeat — and the legs already bought STAY bought, so the basket
 * drifts off the weights the owner signed while the dashboard reports a failure.
 * The leg comes back when its pool has depth, and bin/check-legs.mts is the gate
 * that says so: run it against mainnet before re-adding the entry below.
 */
export const OFFERED_LEGS: readonly OfferedLeg[] = Object.freeze([
  Object.freeze({ symbol: "SPYx", name: "SP500 xStock", mint: SPYX_MINT, pool: SPYX_USDC_POOL, tokenProgram: TOKEN_2022_PROGRAM, decimals: 8, tokenAccountBytes: 179 }),
  Object.freeze({ symbol: "ANTHROPIC", name: "Anthropic PreStock", mint: ANTHROPIC_MINT, pool: ANTHROPIC_USDC_POOL, tokenProgram: TOKEN_2022_PROGRAM, decimals: 9, tokenAccountBytes: 191 }),
]);

/** Each of `count` legs' weight, summing to exactly 10,000 bps: equal shares, any remainder on the first leg. */
export function basketWeightsBps(count: number): number[] {
  if (!Number.isInteger(count) || count < 1) throw new RangeError("a basket has at least one leg");
  const share = Math.floor(10_000 / count);
  return Array.from({ length: count }, (_, index) => (index === 0 ? share + (10_000 - share * count) : share));
}

export interface ComputeBudget {
  /** SetComputeUnitLimit. */
  readonly unitLimit: number;
  /** SetComputeUnitPrice, in micro-lamports per unit. */
  readonly microLamports: bigint;
}

/**
 * The unit limit every owner transaction carries, per SIP instruction. Every
 * owner transaction carries both compute-budget instructions, because Phantom
 * rewrites an unsigned transaction's fees only when it has none. The local proof
 * requires each landing to consume at most half of its limit.
 */
export const OWNER_TX_COMPUTE: Readonly<Record<OwnerInstructionName, number>> = Object.freeze({
  create_vault_v2: 60_000,
  set_policy_v2: 40_000,
  link_wallet: 100_000,
  unlink_wallet: 40_000,
  withdraw: 40_000,
  withdraw_token: 200_000,
  set_invest_policy: 300_000,
});

/**
 * How many of a vault's missing token accounts the build route bundles ahead of
 * set_invest_policy, at the owner's expense: the first two of
 * vaultTokenAccountTargets' order, wSOL and USDC. The keeper creates every other
 * one idempotently at the crank's expense on the first invest tick
 * (solana-keeper/src/invest-tick.ts calls createAssociatedTokenAccountIdempotent
 * for wSOL, USDC and each leg), so an unbundled leg costs the owner nothing and
 * delays nothing.
 *
 * WHY TWO, MEASURED WITH THIS REPO'S OWN BUILDERS AND THE REAL LIGHTHOUSE
 * REWRITE (test/lighthouse.test.ts's sizes case re-measures it in CI; legacy
 * wire, signed, with Phantom's leading and trailing blocks as
 * test/phantom-rewrite.ts takes them from mainnet). AT TODAY'S TWO LEGS:
 *   * two creations: 1,008 bytes of MAX_TX_BYTES = 1,232, 224 to spare (1,010 as
 *     v0, and 1,029/1,031 with Phantom's trailing block saturated at
 *     MAX_TRAILING_WALLET_GUARDS — a worst case of 201 bytes spare).
 *   * three creations: 1,162 bytes, 70 to spare, AND Phantom's blocks are already
 *     full at 4 leading and 6 trailing, so there is no room left for a single
 *     further assertion. Seventy bytes that cannot absorb one more check is not a
 *     margin. (At three legs the same two numbers were 1,058 and 1,212, the
 *     second leaving twenty: this got better with the leg, not safe.)
 *
 * AND RAISING MAX_VAULT_TOKEN_ACCOUNT_CREATES IS NOT THE FIX. Bundling all four
 * of today's targets is refused by the builder itself — MAX_VAULT_TOKEN_ACCOUNT_CREATES
 * is 3 — and it would be refused by the relay anyway, because every extra
 * creation also buys one more leading and one more trailing wallet guard: five
 * leading and seven trailing, past MAX_LEADING_WALLET_GUARDS (4) and
 * MAX_TRAILING_WALLET_GUARDS (6). The wire gets worse with the cap, not better.
 * The verifier's cap stays 3: it bounds what the relay accepts, and the one-leg
 * golden still creates three.
 */
export const BUNDLED_VAULT_TOKEN_ACCOUNT_CREATES = 2;

/** The priority price of every owner transaction. The verifier's cap is 5,000,000. */
export const OWNER_TX_MICROLAMPORTS = 100_000n;

/** Solana's base fee per required signature. */
export const SIGNATURE_FEE_LAMPORTS = 5_000n;

/** The compute budget an owner transaction for `name` is built with. */
export const ownerComputeBudget = (name: OwnerInstructionName): ComputeBudget => ({ unitLimit: OWNER_TX_COMPUTE[name], microLamports: OWNER_TX_MICROLAMPORTS });

/** What the priority price costs on top of the signature fees: ceil(limit × price / 1e6), as the runtime charges it. */
export function priorityFeeLamports(budget: ComputeBudget): bigint {
  const microLamports = BigInt(budget.unitLimit) * budget.microLamports;
  return (microLamports + 999_999n) / 1_000_000n;
}
