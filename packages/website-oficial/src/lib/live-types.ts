/**
 * WHAT /api/solana-live ANSWERS, typed — mirroring @sip/solana-core's handler,
 * with every bigint as a decimal string (a u64 past 2^53 loses its last digit as
 * a JSON number, and lifetimeSaved is somebody's savings).
 *
 * The event shape is DERIVED from the core's VaultEvent rather than copied, so a
 * kind or a field added to the classifier cannot silently go unread here: the
 * mapped type below turns each bigint into the string it travels as, and
 * nothing else changes.
 */

import type { InvestmentReadiness, VaultEvent } from "@sip/solana-core/client";

import type { InvestmentPolicyJson, ReadStatus, VaultAccountJson, VaultStateJson, WalletLinkStatus } from "@/lib/vault-api";

/** The same object with every bigint field written as the decimal string it travels as. */
type AsJson<T> = { readonly [K in keyof T]: bigint extends T[K] ? (null extends T[K] ? string | null : string) : T[K] };

/** One classified event, as the route sends it. Distributes over VaultEvent's union. */
export type VaultEventJson = VaultEvent extends infer Event ? (Event extends object ? AsJson<Event> : never) : never;

export type VaultEventKindJson = VaultEventJson["kind"];

export interface LiveLinkJson {
  readonly address: string;
  readonly status: WalletLinkStatus;
  /** The vault this wallet saves into, when the link was read. */
  readonly vault: string | null;
  /** Null unless the link itself was read: a count nobody read is not a zero. */
  readonly epoch: string | null;
  readonly settlementNonce: string | null;
  readonly frontierSlot: string | null;
}

export interface LiveWalletJson {
  readonly wallet: string;
  /** "0" when the chain answered there is no such account; null when it could not be read. */
  readonly lamports: string | null;
  readonly link: LiveLinkJson;
}

export interface LiveDiscoveredLinkJson {
  readonly wallet: string;
  readonly address: string;
  readonly epoch: string;
  readonly settlementNonce: string;
  readonly frontierSlot: string;
}

export interface LiveSnapshotJson {
  readonly owner: string;
  readonly programId: string;
  /** The slot the accounts were read at; the chart leaves out what this did not cover. */
  readonly slot: number | null;
  /** The server's clock when it answered: every relative time on screen is against this. */
  readonly readAtMs: number;
  readonly vault: {
    readonly status: ReadStatus;
    readonly address: string;
    readonly lamports?: string;
    readonly rentFloor?: string;
    readonly withdrawableLamports?: string;
    readonly state?: VaultAccountJson;
  };
  readonly policy: { readonly status: ReadStatus; readonly address: string; readonly lamports?: string; readonly state?: InvestmentPolicyJson };
  readonly config: { readonly address: string; readonly status: ReadStatus; readonly exists: boolean; readonly paused: boolean | null };
  /** The same shape /api/solana-vault answers, so todaysLimits applies unchanged. */
  readonly prices: VaultStateJson["prices"];
  readonly vaultTokenAccounts: VaultStateJson["vaultTokenAccounts"];
  readonly rents: { readonly vault: string | null; readonly walletFloor: string | null };
  readonly wallets: readonly LiveWalletJson[];
  /** Null when the request did not ask to discover them. */
  readonly links: { readonly status: "exists" | "unreadable"; readonly items: readonly LiveDiscoveredLinkJson[] } | null;
}

export interface LiveEntryJson {
  readonly signature: string;
  readonly slot: number;
  readonly blockTime: number | null;
  readonly ok: boolean;
  readonly fee: string | null;
  readonly events: readonly VaultEventJson[];
}

export interface LiveActivityJson {
  readonly vault: string;
  /** "unreadable" is never an empty history: it is a history nobody could read. */
  readonly status: "exists" | "unreadable";
  readonly nextBefore: string | null;
  readonly entries: readonly LiveEntryJson[];
  /** More landed than one page holds: the head is reloaded rather than stitched. */
  readonly gap: boolean;
}

/**
 * ONE PAGE OF A WALLET'S LINK, which is a different stream and a different
 * kind of claim.
 *
 * The vault PDA sees everything the vault does, so a page of it is a slice of
 * the WHOLE history and "this page reached the beginning" licenses a window
 * total. A wallet's TradingLink sees only that wallet — but every settlement
 * touches exactly one link, and almost nothing else does, which is why the
 * dashboard reads settlements here and the feed reads them from the vault.
 *
 * ITS CURSOR IS DELIBERATELY NOT CALLED `nextBefore`. The two facts are not
 * interchangeable and must never arrive under one name; the route enforces it
 * by leaving `nextBefore` out of this shape entirely.
 */
export interface LiveLinkActivityJson {
  readonly scope: "link";
  readonly vault: string;
  readonly wallet: string;
  /** The link PDA whose signatures were listed. */
  readonly address: string;
  readonly status: "exists" | "unreadable";
  readonly nextBeforeLink: string | null;
  readonly entries: readonly LiveEntryJson[];
  /** Read, and the program tied it to another vault. Never counted as "nothing here". */
  readonly filtered: number;
  /** The RPC did not return the transaction: nothing is known about whose it was. */
  readonly unread: number;
  readonly gap: boolean;
}

export interface LiveSnapshotRequest {
  readonly owner: string;
  readonly wallets: readonly string[];
  readonly discover: boolean;
}

export interface LiveActivityRequest {
  readonly owner: string;
  readonly limit?: number;
  readonly before?: string;
  readonly until?: string;
}

export interface LiveLinkActivityRequest {
  readonly owner: string;
  /** The trading wallet whose link PDA is listed. Never the pension key. */
  readonly wallet: string;
  readonly limit?: number;
  readonly before?: string;
}

// ── the view model: what the dashboard actually draws ────────────────────────

/**
 * How far along this pension is. The FIRST that matches wins, and
 * `vault_unreadable` comes before `no_vault` on purpose: offering to create a
 * vault that may already exist asks someone to sign what the chain must refuse.
 */
export type LiveStage = "vault_unreadable" | "no_vault" | "no_trading_wallet" | "not_linked" | "waiting_first_settlement" | "active";

export interface LiveVaultView {
  readonly address: string;
  /** The read's own outcome. "missing" and "unreadable" are different answers and must stay so. */
  readonly status: ReadStatus;
  readonly exists: boolean;
  readonly lamports: bigint | null;
  readonly rentFloor: bigint | null;
  /** lamports − rentFloor: what a withdrawal can take. */
  readonly withdrawable: bigint | null;
  readonly lifetimeSaved: bigint | null;
  /** Unix seconds, as the vault records it. */
  readonly createdAt: bigint | null;
  /** 0 profit, 1 volume. */
  readonly mode: number | null;
  /** The rate OF THAT MODE: skimBps for profit, volumeBps for volume. */
  readonly rateBps: number | null;
  readonly maxContribution: bigint | null;
  readonly walletReserve: bigint | null;
  readonly paused: boolean | null;
  /** A volume vault while the keeper cannot measure volume: nothing is settled into it. */
  readonly volumeNotOffered: boolean;
}

export type LiveHoldingKind = "sol" | "wsol" | "usdc" | "leg";

export interface LiveHoldingRow {
  readonly key: string;
  readonly symbol: string;
  readonly mint: string | null;
  readonly kind: LiveHoldingKind;
  /** Raw units: what a transfer moves. */
  readonly amountRaw: bigint;
  /** The RPC's display amount. NEVER derived from amountRaw: SPYx's is scaled. */
  readonly uiAmount: string | null;
  /** USDC raw units at today's pool prices; null when the prices could not be read. */
  readonly valueUsdcRaw: bigint | null;
  /** Legs only: what it is now, and what the policy asked for. */
  readonly weightBps: number | null;
  readonly targetWeightBps: number | null;
  /** The SOL row only: what Solana keeps and a withdrawal cannot take. */
  readonly rentFloor: bigint | null;
}

export interface LiveWalletView {
  readonly address: string;
  readonly label: string;
  /** "chain": a link found on chain for a wallet Privy does not list on this account. */
  readonly source: "privy" | "chain";
  readonly lamports: bigint | null;
  readonly linkAddress: string;
  readonly linkStatus: WalletLinkStatus;
  readonly settlementNonce: bigint | null;
  /** Whether it holds more than the floor plus the reserve, so a settlement could run at all. Null when unknown. */
  readonly canSettle: boolean | null;
}

export interface LivePolicyLegView {
  readonly mint: string;
  readonly symbol: string;
  readonly weightBps: number;
  readonly storedFloorWad: bigint | null;
  readonly liveWad: bigint | null;
  readonly todayPer1e8: bigint | null;
  readonly storedCeilingPer1e8: bigint | null;
}

export interface LivePolicyView {
  readonly status: ReadStatus;
  readonly address: string;
  readonly enabled: boolean | null;
  readonly legs: readonly LivePolicyLegView[];
  readonly minInvestment: bigint | null;
  readonly maxPerCall: bigint | null;
  readonly maxRolling30d: bigint | null;
  readonly usedLast30d: bigint | null;
  readonly lifetimeInvested: bigint | null;
  /**
   * The newest UTC day the policy's own day-buckets record a buy on, and the
   * USDC that whole day spent (invest-limits.ts lastInvestedDay). Null when no
   * bucket holds a buy, or there is no readable policy.
   */
  readonly lastInvestedDay: { readonly day: string; readonly usdcRaw: bigint } | null;
  readonly storedSolFloorPerSol: bigint | null;
  readonly todayPerSol: bigint | null;
  /** Both floors readable, and each still on the right side of today's price. */
  readonly pricesKnown: boolean;
  readonly belowMarket: boolean;
  /** Whether the next sweep can buy, from the USDC the vault actually holds. Null when there is nothing to say. */
  readonly readiness: InvestmentReadiness | null;
}

export interface LiveRow {
  readonly signature: string;
  /** ISO 8601 UTC, from the transaction's block time; null when the chain did not say. */
  readonly at: string | null;
  readonly blockTime: number | null;
  readonly ok: boolean;
  readonly explorerUrl: string | null;
  readonly event: VaultEventJson;
}

export interface LiveChartPoint {
  readonly at: string;
  /** Lifetime saved as at that moment, in lamports. */
  readonly totalLamports: bigint;
}

export interface LiveStatsView {
  /** Every settlement the links record, not only the loaded ones. */
  readonly settlementsLifetime: bigint | null;
  /**
   * THE STATE RECORDS A SETTLEMENT THE LOADED HISTORY DOES NOT HOLD — the
   * vault's own total moved, or a link's nonce counted one, and not one of them
   * is in the pages read so far. Nothing on the screen may say "none yet" while
   * this is true.
   */
  readonly settledOutsideHistory: boolean;
  readonly loadedSettlements: number;
  readonly loadedSavedLamports: bigint;
  readonly biggestPaid: bigint | null;
  readonly cappedCount: number;
  readonly lastSettlementAt: string | null;
  /** Null unless the LOADED history covers the window: a partial sum would read as a real total. */
  readonly savedTodayLamports: bigint | null;
  readonly savedThisWeekLamports: bigint | null;
  /** The last thirty days, under the same coverage rule as the week. */
  readonly savedThisMonthLamports: bigint | null;
  /**
   * What the rule measured across every settlement — the trading gains on a
   * profit vault, the volume on a volume one. Null unless EVERY settlement is
   * loaded: a partial sum here would be a lifetime figure that is not one.
   */
  readonly gainsMeasuredLamports: bigint | null;
  /** The same over the last thirty days, when those days are covered. */
  readonly gainsThisMonthLamports: bigint | null;
  /**
   * One entry per UTC day the loaded history can vouch for, oldest first,
   * ending today; at most thirteen weeks. A day that is not whole is absent,
   * never zero.
   */
  readonly dailySaved: readonly { readonly day: string; readonly lamports: bigint }[];
  readonly investmentsLoaded: number;
}

export interface LiveDashboard {
  readonly stage: LiveStage;
  readonly slot: number | null;
  /** The server's clock when it answered: every relative time is against this. */
  readonly nowMs: number;
  readonly vault: LiveVaultView;
  /** Protocol-wide pause; null when the config could not be read, so no pause is claimed either way. */
  readonly protocolPaused: boolean | null;
  readonly policy: LivePolicyView;
  readonly prices: LiveSnapshotJson["prices"];
  readonly holdings: readonly LiveHoldingRow[];
  readonly tokensReadable: boolean;
  /** Everything the vault holds, at today's prices; null when they could not be read. */
  readonly worthNowUsdcRaw: bigint | null;
  /** SOL, wSOL and USDC: saved but not yet in the basket. */
  readonly notInvestedUsdcRaw: bigint | null;
  /**
   * The vault's SOL is rent and nothing else, so there is no SOL row to say so.
   * Null whenever a row does say it, or there is no vault. The footnote under
   * the holdings reads it — the fact is never dropped, only moved out of a
   * table row that would otherwise be entirely zeroes.
   */
  readonly rentOnlyLamports: bigint | null;
  readonly wallets: readonly LiveWalletView[];
  readonly rows: readonly LiveRow[];
  /**
   * Every settlement the screen holds, newest first, from BOTH streams — the
   * vault's page and the trading wallets' links.
   *
   * Not a subset of `rows`, and that is deliberate. `rows` is the vault's own
   * contiguous page, which is what the feed's counts, day headings and "since"
   * all describe; a settlement found on a wallet's link is not part of it. The
   * strip shows settlements, so it reads this.
   */
  readonly settlementRows: readonly LiveRow[];
  /**
   * The rows the feed leaves out, newest first: the keeper's own account-keeping
   * and sub-dust transfers. Counted in `hiddenUpkeep`/`hiddenDust` AND kept, so
   * the count can be opened and checked rather than merely asserted.
   */
  readonly hiddenRows: readonly LiveRow[];
  /** Account-keeping transactions and dust transfers, counted rather than listed. */
  readonly hiddenUpkeep: number;
  readonly hiddenDust: number;
  /**
   * Null when there is nothing true to draw: nothing saved yet, or not one row
   * loaded to be flat across. A window holding no settlement is a FLAT line at
   * the vault's own total, not an empty chart.
   */
  readonly chart: readonly LiveChartPoint[] | null;
  readonly stats: LiveStatsView;
  /**
   * What Solana charges, read in the same batch. `vault` is what creating one
   * costs and is quoted BEFORE there is a vault; `walletFloor` is rent(0), the
   * floor settle.rs refuses to leave a trading wallet under.
   */
  readonly rents: { readonly vault: bigint | null; readonly walletFloor: bigint | null };
}
