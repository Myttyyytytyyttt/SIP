// What a per-trade span owes, and when it is worth a settlement: ROUND-UP
// (mode 2) and FIXED AMOUNT (mode 3), dispatcher ADR §5.1–§5.5.
//
// PURE. No RPC, no clock, no database: the walk's counted trades come in (the
// same volume probe VOLUME uses, src/measure-volume.ts), each priced already —
// a round-up trade at the price tape's sample nearest its own time, or "late"
// at the settle-time Pyth price (src/price-tape.ts) — and out comes the number
// settle_v3 is attested for, with every row that made it. The settle turn
// (src/settle-tick.ts) signs it; the program checks it again on its own terms
// (per_trade.rs), so a mistake here is a refusal on chain, not a wrong charge.
//
// THE ARITHMETIC IS THE PROGRAM'S MIRROR's, NOT A COPY. roundupTradeLamports,
// roundupBoundLamports, fixedAmountLamports and pricesHash come from
// @sip/solana-program/per-trade (through src/program-scripts.ts), the file the
// program's vectors pin (tests/fixtures/per-trade-vectors.txt). This file only
// decides WHICH trades count and what each was worth.
//
// A COUNTED TRADE (ADR §5.1):
//   * the volume probe counted it (signed by the wallet, succeeded, not a flow,
//     a SOL leg against a token leg — measure-volume.ts's four rules);
//   * it is ABOVE the span's boundary: the newest change of mode, unit, F or a
//     minimum (src/policy-boundary.ts), and SIP_SOLANA_EXTRA_MODES_FROM_SLOT,
//     whichever is later. Trades at or below it are forgiven, never charged at a
//     later price (RT-7);
//   * ROUND-UP: its dollar value X = ⌊x·p / 10⁹⌋ is at least min_trade_cents
//     (RT-26). FIXED: its SOL leg x is at least min_trade_lamports.
//
// EVERY FLOOR ROUNDS IN THE TRADER'S FAVOUR, and a trade never saves more than
// itself (D-R2, D-R3): both are the mirror's.

import type { VolumeTrade } from "./measure-window.js";
import {
  MODE_FIXED,
  MODE_ROUNDUP,
  fixedAmountLamports,
  pricesHash,
  pythFloorHolds,
  roundupBoundLamports,
  roundupTradeLamports,
  type PricedTrade,
} from "./program-scripts.js";
import { PYTH_VERIFICATION_FULL, type PythPriceUpdate } from "./pyth.js";

/** One dollar cent, in micro-dollars: the unit a price_e6 and a trade's value are in. */
export const MICRO_USD_PER_CENT = 10_000n;
const LAMPORTS_PER_SOL = 1_000_000_000n;
const SECONDS_PER_DAY = 86_400;

/** The PerTradePolicy PDA's parameters and daily counter (state.rs; ADR §5.4), as this keeper read them. */
export interface PerTradePolicyParams {
  /** ROUND-UP's unit u, in cents: 100..=10 000, whole dollars. */
  readonly roundupUnitCents: number;
  /** FIXED's F, in lamports: 100 000..=100 000 000. */
  readonly fixedLamports: number;
  /** ROUND-UP's minimum trade, in cents. */
  readonly minTradeCents: number;
  /** FIXED's minimum SOL leg, in lamports. */
  readonly minTradeLamports: number;
  readonly dailyCapLamports: bigint;
  /** unix_timestamp / 86 400 of the last settle that wrote the counter. */
  readonly dayIndex: number;
  readonly daySavedLamports: bigint;
}

/** Where a round-up trade's price came from. */
export type PriceSource = "tape" | "late";

/** A price for one trade: the tape's sample nearest its time, or the settle-time read ("late"). */
export interface TradePrice {
  readonly priceUsdE6: bigint;
  readonly source: PriceSource;
}

/** One trade of the span, as the per-trade rows on /status and the Live page show it (ADR §5.2.6). */
export interface PerTradeRow {
  readonly signature: string;
  readonly slot: bigint;
  readonly blockTime: number | null;
  /** x: the SOL the trade moved, in lamports (measure-volume.ts). */
  readonly lamports: bigint;
  /**
   * charged: counted, and part of the amount. forgiven: at or below the span's
   * boundary. below-minimum: under min_trade. Only `charged` rows are counted,
   * hashed and owed.
   */
  readonly status: "charged" | "forgiven" | "below-minimum";
  /** ROUND-UP only: the price it was valued at and where that came from; null for FIXED and forgiven rows. */
  readonly priceUsdE6: bigint | null;
  readonly priceSource: PriceSource | null;
  /** ROUND-UP only: X = ⌊x·p / 10⁹⌋ micro-dollars. */
  readonly worthUsdE6: bigint | null;
  /** What this trade owes: its round-up in lamports, or F; 0 when not charged. */
  readonly owedLamports: bigint;
}

/** What a span owes, ready to be attested (src/settle-tick.ts builds SIP_SETTLE_V3 from it). */
export interface PerTradeCharge {
  readonly mode: typeof MODE_ROUNDUP | typeof MODE_FIXED;
  /** Σ per-trade round-ups, or tradeCount × F: what is owed before any cap. */
  readonly amountLamports: bigint;
  /** Charged trades. */
  readonly tradeCount: number;
  /** ROUND-UP: the lowest price used (the settle-time price when nothing was charged). FIXED: 0. */
  readonly priceMinUsdE6: bigint;
  /** ROUND-UP: pricesHash over the charged trades. FIXED: 32 zero bytes. */
  readonly pricesHash: Buffer;
  /** ROUND-UP: unit cents. FIXED: F. What settle_v3 rebuilds from the PDA. */
  readonly modeParam: bigint;
  /** ROUND-UP: min_trade_cents. FIXED: min_trade_lamports. */
  readonly minTrade: bigint;
  /** Every trade the probe counted, oldest first, with what became of it. */
  readonly rows: readonly PerTradeRow[];
  /** Charged trades priced at settle time because the tape had no sample within the lookup window. */
  readonly latePriced: number;
  /**
   * The oldest charged trade's block time, for the cadence clock. Null when
   * nothing was charged, or when a charged trade has no block time (it cannot
   * be aged, so the span is not made to wait on it).
   */
  readonly oldestChargedAt: number | null;
  /** True when a charged trade had no block time. */
  readonly unagedCharge: boolean;
}

/** A transaction signature's 64 raw bytes, from its base58: what pricesHash hashes. */
export function signatureBytes(signature: string): Buffer {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = 0n;
  for (const char of signature) {
    const digit = ALPHABET.indexOf(char);
    if (digit < 0) throw new RangeError(`a transaction signature is base58, and ${JSON.stringify(signature)} is not`);
    value = value * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (value > 0n) {
    bytes.unshift(Number(value & 0xffn));
    value >>= 8n;
  }
  for (const char of signature) {
    if (char !== "1") break;
    bytes.unshift(0);
  }
  if (bytes.length !== 64) throw new RangeError(`a transaction signature is 64 bytes, and ${signature} decodes to ${bytes.length}`);
  return Buffer.from(bytes);
}

/**
 * Everything a per-trade span owes, trade by trade. `priceOf` is asked for each
 * ROUND-UP trade above the boundary (never for FIXED); `settlePriceUsdE6` is the
 * price an empty ROUND-UP window signs as its price_min (settle_v3 refuses a
 * zero one even with nothing to charge), and FIXED's is ignored.
 *
 * THROWS ON A CALLER BUG, never on a trader's data: a mode that is not per-trade,
 * a missing price, an amount past the bound the program holds it to.
 */
export function perTradeCharge(input: {
  readonly mode: number;
  readonly trades: readonly VolumeTrade[];
  /** Trades at or below this slot are forgiven; null charges every one. */
  readonly boundarySlot: bigint | null;
  readonly policy: PerTradePolicyParams;
  readonly priceOf: (trade: VolumeTrade) => TradePrice;
  readonly settlePriceUsdE6: bigint | null;
}): PerTradeCharge {
  const { mode, policy } = input;
  if (mode !== MODE_ROUNDUP && mode !== MODE_FIXED) throw new Error(`skim_mode ${mode} is not a per-trade mode`);
  const roundUp = mode === MODE_ROUNDUP;
  const rows: PerTradeRow[] = [];
  const hashed: PricedTrade[] = [];
  let amount = 0n;
  let count = 0;
  let priceMin: bigint | null = null;
  let latePriced = 0;
  let oldest: number | null = null;
  let unaged = false;
  const minWorth = BigInt(policy.minTradeCents) * MICRO_USD_PER_CENT;
  const minLamports = BigInt(policy.minTradeLamports);
  for (const trade of input.trades) {
    const base = { signature: trade.signature, slot: trade.slot, blockTime: trade.blockTime, lamports: trade.lamports };
    if (input.boundarySlot !== null && trade.slot <= input.boundarySlot) {
      rows.push({ ...base, status: "forgiven", priceUsdE6: null, priceSource: null, worthUsdE6: null, owedLamports: 0n });
      continue;
    }
    let owed: bigint;
    let row: Pick<PerTradeRow, "priceUsdE6" | "priceSource" | "worthUsdE6">;
    if (roundUp) {
      const price = input.priceOf(trade);
      if (price.priceUsdE6 <= 0n) throw new Error(`trade ${trade.signature} was priced at ${price.priceUsdE6}; a round-up needs a positive price`);
      const worth = (trade.lamports * price.priceUsdE6) / LAMPORTS_PER_SOL;
      row = { priceUsdE6: price.priceUsdE6, priceSource: price.source, worthUsdE6: worth };
      if (worth < minWorth) {
        rows.push({ ...base, status: "below-minimum", ...row, owedLamports: 0n });
        continue;
      }
      owed = roundupTradeLamports(trade.lamports, price.priceUsdE6, policy.roundupUnitCents);
      hashed.push({ slot: trade.slot, signature: signatureBytes(trade.signature), priceUsdE6: price.priceUsdE6 });
      if (priceMin === null || price.priceUsdE6 < priceMin) priceMin = price.priceUsdE6;
      if (price.source === "late") latePriced += 1;
    } else {
      row = { priceUsdE6: null, priceSource: null, worthUsdE6: null };
      if (trade.lamports < minLamports) {
        rows.push({ ...base, status: "below-minimum", ...row, owedLamports: 0n });
        continue;
      }
      owed = BigInt(policy.fixedLamports);
    }
    rows.push({ ...base, status: "charged", ...row, owedLamports: owed });
    amount += owed;
    count += 1;
    if (trade.blockTime === null) unaged = true;
    else if (oldest === null || trade.blockTime < oldest) oldest = trade.blockTime;
  }

  if (roundUp) {
    const signedPrice = priceMin ?? input.settlePriceUsdE6;
    if (signedPrice === null || signedPrice <= 0n) {
      throw new Error("a ROUND-UP window signs a positive price_min even with nothing charged, and no settle-time price was given");
    }
    // THE PROGRAM'S BOUND, HELD HERE TOO: it cannot fail for an amount this
    // function summed (each round-up is under u·10⁹/p ≤ u·10⁹/price_min), so a
    // failure is a defect in this file, and nothing is signed.
    const bound = roundupBoundLamports(count, policy.roundupUnitCents, signedPrice);
    if (amount > bound) throw new Error(`a ROUND-UP window summed ${amount} lamports over ${count} trades, past the program's bound ${bound}`);
    return {
      mode: MODE_ROUNDUP,
      amountLamports: amount,
      tradeCount: count,
      priceMinUsdE6: signedPrice,
      pricesHash: pricesHash(hashed),
      modeParam: BigInt(policy.roundupUnitCents),
      minTrade: BigInt(policy.minTradeCents),
      rows,
      latePriced,
      oldestChargedAt: unaged ? null : oldest,
      unagedCharge: unaged,
    };
  }
  // FIXED IS count × F EXACTLY, the program's own product (D-F1).
  const product = fixedAmountLamports(count, policy.fixedLamports);
  if (product !== amount) throw new Error(`a FIXED window summed ${amount} lamports over ${count} trades, not ${product}`);
  return {
    mode: MODE_FIXED,
    amountLamports: product,
    tradeCount: count,
    priceMinUsdE6: 0n,
    pricesHash: Buffer.alloc(32),
    modeParam: BigInt(policy.fixedLamports),
    minTrade: BigInt(policy.minTradeLamports),
    rows,
    latePriced: 0,
    oldestChargedAt: unaged ? null : oldest,
    unagedCharge: unaged,
  };
}

/** The UTC day settle_v3 counts a saving on: unix seconds / 86 400 (per_trade.rs, day_index_of). */
export function dayIndexOf(nowSeconds: number): number {
  return Math.floor(nowSeconds / SECONDS_PER_DAY);
}

/**
 * What settle_v3 moves for `amount`, computed as the program computes it: the
 * amount, clipped by max_contribution and by what is left of the UTC day's cap,
 * the counter rolled to zero on a new day (per_trade.rs, rolled_day and
 * per_trade_paid). `headroom` is that day's room before this settle.
 *
 * THE KEEPER'S CLOCK, NOT THE CHAIN'S. Within seconds of midnight the two can
 * name different days; the program's own answer then differs from this one, and
 * a payment the reserve check did not size for is refused WalletBelowReserve —
 * a resting BELOW_RESERVE, never a wrong charge.
 */
export function perTradePaid(args: {
  readonly amountLamports: bigint;
  readonly maxContribution: bigint;
  readonly policy: Pick<PerTradePolicyParams, "dailyCapLamports" | "dayIndex" | "daySavedLamports">;
  readonly nowSeconds: number;
}): { readonly paid: bigint; readonly headroom: bigint; readonly today: number; readonly savedToday: bigint } {
  const today = dayIndexOf(args.nowSeconds);
  const savedToday = args.policy.dayIndex === today ? args.policy.daySavedLamports : 0n;
  const headroom = args.policy.dailyCapLamports > savedToday ? args.policy.dailyCapLamports - savedToday : 0n;
  let paid = args.amountLamports;
  if (args.maxContribution < paid) paid = args.maxContribution;
  if (headroom < paid) paid = headroom;
  return { paid, headroom, today, savedToday };
}

/**
 * The daily counter after a settle_v3 that paid `paidLamports` at `nowSeconds`,
 * as the program writes it (per_trade.rs rolled_day, then settle_v3.rs): on the
 * counter's own day the payment is added, on any other the counter starts again
 * from it. A zero payment still moves the counter to today. The keeper's clock
 * names the day, with perTradePaid's caveat at midnight.
 */
export function perTradeCounterAfter(
  policy: Pick<PerTradePolicyParams, "dayIndex" | "daySavedLamports">,
  paidLamports: bigint,
  nowSeconds: number,
): { readonly dayIndex: number; readonly daySavedLamports: bigint } {
  const today = dayIndexOf(nowSeconds);
  const before = policy.dayIndex === today ? policy.daySavedLamports : 0n;
  return { dayIndex: today, daySavedLamports: before + paidLamports };
}

/** Whether a span with charged trades settles now, or waits — and until when. */
export type PerTradeCadence =
  | { readonly settle: true; readonly why: "size" | "clock" | "unaged" }
  | { readonly settle: false; readonly dueAt: number; readonly detail: string };

/**
 * THE CADENCE (ADR §5.5, RT-2 and RT-23 amended). A span with charged trades
 * settles when EITHER
 *   (a) SIZE: what it owes is at least half of max_contribution — and only while
 *       the day has headroom: a vault at its daily cap never settles on size,
 *       or it would send a zero payment every time a trade arrived;
 *   (b) CLOCK: its oldest charged trade is `maxWaitSeconds` old (one hour at
 *       launch, PER_TRADE_MAX_WAIT_SECONDS).
 * At headroom 0 only the clock fires, so such a link sends at most one forgiving
 * zero payment per clock period. A charged trade with no block time cannot be
 * aged and is not made to wait. A span that is only the oldest prefix of a
 * backlog never waits, and that rule is the caller's (settle-decision.ts).
 */
export function perTradeCadence(args: {
  readonly charge: Pick<PerTradeCharge, "amountLamports" | "tradeCount" | "oldestChargedAt" | "unagedCharge">;
  readonly maxContribution: bigint;
  readonly headroom: bigint;
  readonly nowSeconds: number;
  readonly maxWaitSeconds: number;
}): PerTradeCadence {
  const { charge } = args;
  if (charge.tradeCount === 0) throw new Error("the per-trade cadence is asked only about a span with charged trades");
  if (args.headroom > 0n && charge.amountLamports * 2n >= args.maxContribution) return { settle: true, why: "size" };
  if (charge.unagedCharge || charge.oldestChargedAt === null) return { settle: true, why: "unaged" };
  const dueAt = charge.oldestChargedAt + args.maxWaitSeconds;
  if (args.nowSeconds >= dueAt) return { settle: true, why: "clock" };
  const why =
    args.headroom === 0n
      ? "the vault has saved its daily cap today, so it settles on the clock alone"
      : `under half of max_contribution ${args.maxContribution}`;
  return {
    settle: false,
    dueAt,
    detail:
      `${charge.tradeCount} charged trade(s) owe ${charge.amountLamports} lamports, ${why}; they settle at ` +
      `${new Date(dueAt * 1_000).toISOString()}, ${args.maxWaitSeconds / 60} minutes after the oldest`,
  };
}

/** settle_v3 refuses a Pyth publish more than a day older than its clock (per_trade.rs, pyth_is_fresh). */
export const ORACLE_FRESH_SECONDS = 86_400;

/**
 * Why settle_v3 would refuse a ROUND-UP window's price against this Pyth read,
 * or null when it would not (per_trade.rs, require_pyth_floor): the read must be
 * fully verified (Full), published no more than ORACLE_FRESH_SECONDS before
 * `nowSeconds`, and the signed price_min must be at least half of its price.
 *
 * HELD BEFORE ANYTHING IS SIGNED. A keeper that scaled Pyth's exponent wrong by a
 * power of ten would value a $1.60 trade at $0.016 and charge all of it; the
 * program refuses that (RT-1), and so does this, a turn earlier and for free.
 * The owner and the feed were checked where the account was read.
 */
export function oracleRefusal(update: PythPriceUpdate, priceMinUsdE6: bigint, nowSeconds: number): string | null {
  if (update.verification.variant !== PYTH_VERIFICATION_FULL) {
    return "the Pyth SOL/USD account holds a partially verified update, and settle_v3 reads only a fully verified one (OracleAccountInvalid)";
  }
  // A WORKER'S CLOCK IS FRACTIONAL (Date.now() / 1000): floored, as the chain's unix_timestamp is.
  if (update.publishTime < BigInt(Math.floor(nowSeconds)) - BigInt(ORACLE_FRESH_SECONDS)) {
    return `the Pyth SOL/USD account was published at ${update.publishTime}, more than a day before now, and settle_v3 would refuse it (OracleStale)`;
  }
  if (!pythFloorHolds(priceMinUsdE6, update.price, update.expo)) {
    return (
      `the window's lowest price ${priceMinUsdE6} µ$/SOL is under half of Pyth's ${update.price}e${update.expo}, and settle_v3 would refuse it ` +
      "(PriceBelowOracleFloor): a price this far below the oracle is a pricing defect or a market that more than doubled inside the window"
    );
  }
  return null;
}
