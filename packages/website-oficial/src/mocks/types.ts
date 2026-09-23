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
 *
 * THE LIVE PENSION FILLS IT TOO (src/lib/live-mock.ts), and that is why some
 * fields are wider than the sample needs. The sample never produces a null; a
 * live pension does, for a price that could not be read or a window its loaded
 * history does not cover — and null prints as a dash, never as $0. `symbol` is
 * a string because live assets are not in the sample's ticker list, and `logo`
 * carries art chosen by MINT (src/lib/asset-art.ts), since two issuers can
 * share a ticker. Every widening is one the sample's data satisfies unchanged.
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

/** Every sample ticker has a mark under public/stocks/<symbol>.png; live rows pass `logo` instead. */
export function tickerLogo(symbol: string): string {
  return `/stocks/${symbol}.png`;
}

export interface Wallet {
  readonly address: string;
  readonly network: string;
  readonly label: string;
  readonly balanceUsd: number | null;
}

export interface SavingsTarget {
  readonly symbol: string;
  /** Art chosen by mint; falls back to tickerLogo(symbol). */
  readonly logo?: string;
  /** Share of every investment that goes to this symbol; targets sum to 10 000. */
  readonly weightBps: number;
}

export interface SavingsRule {
  /**
   * What the rate is taken from. The sample is a volume vault; a live one today
   * measures realized profit, whose rates run 2.01–100 % rather than 0.01–2 %.
   * Absent means volume, which is what the sample always was.
   */
  readonly mode?: "volume" | "profit";
  /** Basis points of every fill's notional — 200 is 2% of volume, the most the SIP program accepts. */
  readonly rateBps: number;
  /** The pile invests once it reaches this. */
  readonly thresholdUsd: number | null;
  readonly targets: readonly SavingsTarget[];
  readonly paused: boolean;
}

export type Side = "buy" | "sell";

/** One fill. Buys and sells alike put their slice aside. */
export interface Trade {
  readonly id: string;
  readonly at: string;
  readonly symbol: string;
  readonly logo?: string;
  /**
   * The chip's tooltip, when it is not a fill. A live chip is a settlement —
   * "Saved from Trading wallet 1 · 20 % of $21.40 profit · 4m ago" — and has no
   * side or size to name.
   */
  readonly detail?: string;
  /** Where the chip leads: the transaction on the explorer. */
  readonly href?: string;
  /** Absent on a live chip: a settlement is a slice of a session, not a buy or a sell. */
  readonly side?: Side;
  /** The fill's size in dollars — the volume the rate applies to. On a live chip, what the rule measured. */
  readonly notionalUsd: number | null;
  /** notional × rate: what this fill put aside. THE STRIP'S NUMBER. */
  readonly savedUsd: number | null;
  /** The transaction's signature, base58. */
  readonly txHash: string;
}

interface EventBase {
  readonly id: string;
  /** Null when the chain gave the transaction no block time: it goes under "Time unknown". */
  readonly at: string | null;
  /** The transaction's signature, base58. */
  readonly txHash: string;
  /** The transaction on the explorer. When set, the row is a link to it. */
  readonly href?: string;
}

/** A fill and, in the same breath, what it put aside. */
export interface TradeEvent extends EventBase {
  readonly kind: "trade";
  readonly tradeId: string;
  readonly symbol: string;
  readonly side: Side;
  readonly notionalUsd: number;
  readonly savedUsd: number;
  readonly rateBps: number;
}

/** The pension spending the pile on a target. */
export interface InvestedEvent extends EventBase {
  readonly kind: "invested";
  readonly symbol: string;
  readonly logo?: string;
  readonly shares: number;
  /** The quantity exactly as the chain wrote it, when it must not be re-rounded. */
  readonly sharesText?: string;
  readonly priceUsd: number | null;
  readonly amountUsd: number | null;
}

export interface DepositEvent extends EventBase {
  readonly kind: "deposit";
  readonly amountUsd: number;
}

/**
 * WHAT A LIVE PENSION HAS IN PLACE OF A FILL: a settlement. The chain never
 * sees the trades, only the slice the rule took from a session of them, so a
 * live feed's green rows are these — drawn with the trade row's own markup.
 */
export interface SavedEvent extends EventBase {
  readonly kind: "saved";
  /** "Trading wallet 1". */
  readonly from: string;
  /** In place of "Saved from …" — "Settled from …, nothing to save" when nothing moved. */
  readonly title?: string;
  /** "20 % of $21.40 profit" — the rate and what it was taken from. */
  readonly basis: string;
  readonly savedUsd: number | null;
  /** The rule's ceiling cut this one short; the rest is not carried over. */
  readonly note?: string;
  readonly logo?: string;
}

/**
 * Everything else a vault's history holds — converted, wrapped, withdrew,
 * received, policy signed, linked… — which the sample has no row for and a live
 * page must not drop (a withdrawal least of all). Its words are made where the
 * live rows are made (partsOf in LiveActivityRow.tsx), not here.
 */
export interface OtherEvent extends EventBase {
  readonly kind: "other";
  readonly title: string;
  readonly sub: string | null;
  readonly amount: string | null;
  /** Which glyph leads the row, when it has no asset `logo` of its own. */
  readonly icon: "wrap" | "convert" | "withdraw" | "vault" | "rule" | "policy" | "link" | "unlink" | "receive" | "failed" | "upkeep" | "other";
  readonly logo?: string;
  /** Muted, with a Failed badge. */
  readonly failed?: boolean;
}

/** A discriminated union so a row renders by `kind` with no optional soup. */
export type ActivityEvent = TradeEvent | InvestedEvent | DepositEvent | SavedEvent | OtherEvent;
export type ActivityKind = ActivityEvent["kind"];

export interface Holding {
  readonly symbol: string;
  readonly logo?: string;
  readonly shares: number;
  /**
   * The quantity EXACTLY as the chain's RPC wrote it. SPYx is a scaledUiAmount
   * mint: its display amount carries a multiplier its raw units do not, so a
   * live row is printed from this and never re-rounded through shares().
   */
  readonly sharesText?: string;
  readonly costUsd: number | null;
  readonly valueUsd: number | null;
  /** Actual share of the invested value today. */
  readonly weightBps: number | null;
  /** The rule's intended share, for comparison. */
  readonly targetWeightBps: number | null;
}

/** One point of the cumulative curve — the hero's figure at that date. */
export interface SavingsPoint {
  readonly date: string;
  readonly total: number;
}

export interface SavingsDay {
  readonly date: string;
  readonly savedUsd: number | null;
  readonly volumeUsd: number | null;
  readonly trades: number | null;
}

export interface SavingsStats {
  /** Lifetime contributions. THE HERO. */
  readonly totalSavedUsd: number | null;
  /** Holdings at today's prices plus the pending cash. */
  readonly pensionValueUsd: number | null;
  /** The holdings at today's prices — what the invested slices are worth now, not what they cost. */
  readonly holdingsUsd: number | null;
  readonly costUsd: number | null;
  readonly unrealizedUsd: number | null;
  /** Put aside but not yet invested — accumulating toward the threshold. */
  readonly pendingUsd: number | null;
  readonly thresholdUsd: number | null;
  readonly savedTodayUsd: number | null;
  readonly savedThisWeekUsd: number | null;
  readonly savedThisMonthUsd: number | null;
  /** Lifetime volume the rate was applied to. */
  readonly volumeUsd: number | null;
  readonly volumeThisMonthUsd: number | null;
  readonly trades: number | null;
  readonly avgSavedPerTradeUsd: number | null;
  /** The single fill that put the most aside. */
  readonly bestTradeSavedUsd: number | null;
  readonly bestTradeId: string | null;
  /** How many times the pile reached the threshold and was invested. */
  readonly investments: number;
  readonly activeDays: number | null;
  readonly currentStreakDays: number | null;
  readonly longestStreakDays: number | null;
  readonly firstSaveAt: string | null;
  readonly projectedYearUsd: number | null;
  /**
   * What "Next investment" counts toward the threshold, where that is not the
   * whole pending pile. On a live vault only the USDC already converted is
   * ready to buy with; the SOL and wSOL still waiting are pending but not yet
   * this. Absent means the sample's own reading: pendingUsd.
   */
  readonly readyToInvestUsd?: number | null;
  /**
   * The words a live page puts on the tiles whose sample names would claim
   * something the chain does not record — "Settlements" where the sample says
   * trades, "Gains measured" where it says volume. Absent means the sample's.
   */
  readonly vocabulary?: "settlements";
  /**
   * The days `days` spans are only the ones the loaded history can vouch for,
   * and the biggest is over what is loaded — true when every settlement is.
   */
  readonly complete?: boolean;
  /**
   * WHAT ONLY A LIVE PAGE HAS TO SAY ABOUT ITS FIGURES. Absent on the sample,
   * whose numbers need no qualifying.
   *
   * `pricedToday`: every dollar here is SOL at the one price this read — true
   * when that price was read, false when it was not (and the dollars are null).
   * `totalSavedSol`: the hero's exact figure in the chain's own unit, for its
   * tooltip and for when there is no price to show it in dollars.
   * `settledOutsideHistory`: the vault's state records a settlement the loaded
   * history does not hold, so nothing may say "none yet".
   * `holdingsUnreadable`: the token list could not be read — not "holds nothing".
   */
  readonly pricedToday?: boolean;
  readonly totalSavedSol?: string | null;
  readonly settledOutsideHistory?: boolean;
  readonly holdingsUnreadable?: boolean;
}

export interface DashboardMock {
  /** The instant the mock was "read". Every relative time is against this. */
  readonly now: string;
  /** Null on a live pension with no single wallet to lead with (none, or several with none uniquely linked). */
  readonly wallet: Wallet | null;
  /**
   * The unit `curve` is in, when it is not dollars. A live page whose prices
   * could not be read draws its curve in the chain's own SOL rather than not at
   * all; every other dollar figure is then null.
   */
  readonly unit?: "SOL";
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
