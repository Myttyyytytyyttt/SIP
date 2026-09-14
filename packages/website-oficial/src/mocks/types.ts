/**
 * THE SHAPE THE BACKEND WILL HAVE TO PRODUCE. Every component on the page
 * types against this file and nothing else; src/mocks/data.ts is one
 * deterministic instance of it. Swapping the mock for a fetch later means
 * satisfying these interfaces, not touching a component.
 *
 * THIS EXAMPLE IS A VOLUME-MODE VAULT. SIP measures a linked wallet's trading
 * one of two ways, chosen per vault: as volume (a slice of the size of every
 * buy and every sell) or as realized profit (a slice of what the trading
 * made). The demo rates are 2% of volume and 20% of realized profit. This
 * contract, and the mock that fills it, model the volume rule only: every
 * fill puts its slice aside, whatever the side and whether or not the trade
 * made money. It accumulates, and once the pile reaches the threshold the
 * pension invests it in the targets.
 *
 * All money is USD as a plain number (dollars, not cents). All times are ISO
 * 8601 UTC strings. All rates are basis points — 200 bps is 2%.
 */

export const TICKERS = [
  "NVDAx",
  "TSLAx",
  "SPYx",
  "INDEX",
  "pHOOD3x",
  "pBTC3x",
  "GLDx",
  "QQQx",
  "HOODx",
  "AAPLx",
  "MSTRx",
  "COINx",
  "CASHCAT",
  "PLTRx",
  "METAx",
] as const;

export type Ticker = (typeof TICKERS)[number];

/** Every ticker has a mark under public/stocks/<symbol>.png. */
export function tickerLogo(symbol: Ticker): string {
  return `/stocks/${symbol}.png`;
}

export interface Wallet {
  readonly address: string;
  readonly network: string;
  readonly label: string;
  readonly balanceUsd: number;
}

export interface SavingsTarget {
  readonly symbol: Ticker;
  /** Share of every investment that goes to this symbol; targets sum to 10 000. */
  readonly weightBps: number;
}

export interface SavingsRule {
  /** Basis points of every fill's notional — 200 is 2% of volume, the most the SIP program accepts. */
  readonly rateBps: number;
  /** The pile invests once it reaches this. */
  readonly thresholdUsd: number;
  readonly targets: readonly SavingsTarget[];
  readonly paused: boolean;
}

export type Side = "buy" | "sell";

/** One fill. Buys and sells alike put their slice aside. */
export interface Trade {
  readonly id: string;
  readonly at: string;
  readonly symbol: Ticker;
  readonly side: Side;
  /** The fill's size in dollars — the volume the rate applies to. */
  readonly notionalUsd: number;
  /** notional × rate: what this fill put aside. THE STRIP'S NUMBER. */
  readonly savedUsd: number;
  /** The transaction's signature, base58. */
  readonly txHash: string;
}

interface EventBase {
  readonly id: string;
  readonly at: string;
  /** The transaction's signature, base58. */
  readonly txHash: string;
}

/** A fill and, in the same breath, what it put aside. */
export interface TradeEvent extends EventBase {
  readonly kind: "trade";
  readonly tradeId: string;
  readonly symbol: Ticker;
  readonly side: Side;
  readonly notionalUsd: number;
  readonly savedUsd: number;
  readonly rateBps: number;
}

/** The pension spending the pile on a target. */
export interface InvestedEvent extends EventBase {
  readonly kind: "invested";
  readonly symbol: Ticker;
  readonly shares: number;
  readonly priceUsd: number;
  readonly amountUsd: number;
}

export interface DepositEvent extends EventBase {
  readonly kind: "deposit";
  readonly amountUsd: number;
}

/** A discriminated union so a row renders by `kind` with no optional soup. */
export type ActivityEvent = TradeEvent | InvestedEvent | DepositEvent;
export type ActivityKind = ActivityEvent["kind"];

export interface Holding {
  readonly symbol: Ticker;
  readonly shares: number;
  readonly costUsd: number;
  readonly valueUsd: number;
  /** Actual share of the invested value today. */
  readonly weightBps: number;
  /** The rule's intended share, for comparison. */
  readonly targetWeightBps: number;
}

/** One point of the cumulative curve — the hero's figure at that date. */
export interface SavingsPoint {
  readonly date: string;
  readonly total: number;
}

export interface SavingsDay {
  readonly date: string;
  readonly savedUsd: number;
  readonly volumeUsd: number;
  readonly trades: number;
}

export interface SavingsStats {
  /** Lifetime contributions. THE HERO. */
  readonly totalSavedUsd: number;
  /** Holdings at today's prices plus the pending cash. */
  readonly pensionValueUsd: number;
  /** The holdings at today's prices — what the invested slices are worth now, not what they cost. */
  readonly holdingsUsd: number;
  readonly costUsd: number;
  readonly unrealizedUsd: number;
  /** Put aside but not yet invested — accumulating toward the threshold. */
  readonly pendingUsd: number;
  readonly thresholdUsd: number;
  readonly savedTodayUsd: number;
  readonly savedThisWeekUsd: number;
  readonly savedThisMonthUsd: number;
  /** Lifetime volume the rate was applied to. */
  readonly volumeUsd: number;
  readonly volumeThisMonthUsd: number;
  readonly trades: number;
  readonly avgSavedPerTradeUsd: number;
  /** The single fill that put the most aside. */
  readonly bestTradeSavedUsd: number;
  readonly bestTradeId: string | null;
  /** How many times the pile reached the threshold and was invested. */
  readonly investments: number;
  readonly activeDays: number;
  readonly currentStreakDays: number;
  readonly longestStreakDays: number;
  readonly firstSaveAt: string | null;
  readonly projectedYearUsd: number;
}

export interface DashboardMock {
  /** The instant the mock was "read". Every relative time is against this. */
  readonly now: string;
  readonly wallet: Wallet;
  readonly rule: SavingsRule;
  readonly stats: SavingsStats;
  readonly curve: readonly SavingsPoint[];
  readonly days: readonly SavingsDay[];
  readonly holdings: readonly Holding[];
  /** Newest first. */
  readonly trades: readonly Trade[];
  /** Newest first. */
  readonly activity: readonly ActivityEvent[];
}
