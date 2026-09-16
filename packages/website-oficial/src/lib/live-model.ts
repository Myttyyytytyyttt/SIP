/**
 * THE CHAIN'S ANSWER, TURNED INTO A SCREEN — pure, so every number on the
 * dashboard can be pinned by a test rather than trusted.
 *
 * THREE RULES RUN THROUGH ALL OF IT:
 *
 * 1. A TOKEN'S VALUE COMES FROM ITS RAW UNITS, NEVER FROM ITS DISPLAY AMOUNT.
 *    SPYx is a Token-2022 scaledUiAmount mint: its display amount carries a
 *    multiplier the issuer can change, so `uiAmount × price` drifts from what
 *    the tokens are actually worth. Shares are shown from the RPC's string;
 *    value is amountRaw × usdcRawPer1e8 / 1e8.
 *
 * 2. UNREADABLE IS NOT ZERO AND NOT MISSING. A price that could not be read
 *    makes a value null and the dollar column disappear; it never makes it $0.
 *    A vault that could not be read is its own stage, before "no vault", so the
 *    screen never offers to create one that may already exist.
 *
 * 3. A TOTAL IS ONLY SHOWN WHEN THE LOADED HISTORY COVERS IT. "Saved today" from
 *    a page that starts after today began is a smaller number wearing a
 *    complete one's name, so it is null instead.
 */

import { OFFERED_LEGS, USDC_MINT, VOLUME_MODE_OFFERED, WSOL_MINT, investmentReadiness, solscanTx, usdcRawPer1e8LegRaw, usdcRawPerSol } from "@sip/solana-core/client";

import { rawFrom, usdcRawForLamports } from "@/lib/amounts";
import type {
  LiveActivityJson,
  LiveChartPoint,
  LiveDashboard,
  LiveHoldingRow,
  LivePolicyLegView,
  LivePolicyView,
  LiveRow,
  LiveSnapshotJson,
  LiveStage,
  LiveStatsView,
  LiveVaultView,
  LiveWalletView,
  VaultEventJson,
} from "@/lib/live-types";
import { todaysLimits, usedInLast30Days } from "@/lib/invest-limits";
import type { InvestmentPolicyJson, VaultStateJson } from "@/lib/vault-api";

/** A plain SOL transfer under this is dust — a rent top-up or a dusting, not a saving worth a row. */
export const DUST_LAMPORTS = 100_000n;

const MODE_VOLUME = 1;
const legSymbolOf = (mint: string): string => OFFERED_LEGS.find((leg) => leg.mint === mint)?.symbol ?? "Token";

// ── the investment policy's floors, against today's prices ───────────────────

export interface FloorsState {
  readonly storedConvert: bigint | null;
  readonly liveConvert: bigint | null;
  readonly legs: readonly {
    readonly mint: string;
    readonly symbol: string;
    readonly weightBps: number;
    readonly floor: bigint | null;
    readonly live: bigint | null;
    readonly today: bigint | null;
  }[];
  /** Every stored floor and every live rate was readable. */
  readonly pricesKnown: boolean;
  /** …and each is still on the side of today's price that lets the keeper act. */
  readonly belowMarket: boolean;
}

/**
 * A stored policy's floors beside today's rates.
 *
 * A stored floor at or under today's rate lets the keeper act: SOL sells above
 * its floor, and a leg buys at least its floor's amount. Past that, buying waits
 * until the owner signs again — which the card says rather than looking broken.
 *
 * Shared by the wallets screen's InvestingCard and the live rule card, so the
 * two cannot disagree about whether a floor has been passed.
 */
export function floorsState(policy: InvestmentPolicyJson, prices: VaultStateJson["prices"]): FloorsState {
  const limits = todaysLimits(prices);
  const storedConvert = rawFrom(policy.minConvertRateWad);
  const liveConvert = rawFrom(prices?.convertWad);
  const legs = policy.legs.map((leg) => ({
    mint: leg.mint,
    symbol: legSymbolOf(leg.mint),
    weightBps: leg.weightBps,
    floor: rawFrom(leg.minOutRateWad),
    live: rawFrom(prices?.legs.find((entry) => entry.mint === leg.mint)?.wad),
    today: limits?.legs.find((entry) => entry.mint === leg.mint)?.todayPer1e8 ?? null,
  }));
  const pricesKnown = storedConvert !== null && liveConvert !== null && legs.every((leg) => leg.floor !== null && leg.live !== null);
  const belowMarket = pricesKnown && storedConvert <= liveConvert && legs.every((leg) => leg.floor! <= leg.live!);
  return { storedConvert, liveConvert, legs, pricesKnown, belowMarket };
}

// ── the pieces ───────────────────────────────────────────────────────────────

function vaultView(snapshot: LiveSnapshotJson): LiveVaultView {
  const { vault } = snapshot;
  const state = vault.state;
  const exists = vault.status === "exists" && state !== undefined;
  const mode = state === undefined ? null : state.skimMode;
  return {
    address: vault.address,
    status: vault.status,
    exists,
    lamports: rawFrom(vault.lamports),
    rentFloor: rawFrom(vault.rentFloor),
    withdrawable: rawFrom(vault.withdrawableLamports),
    lifetimeSaved: rawFrom(state?.lifetimeSaved),
    createdAt: rawFrom(state?.createdAt),
    mode,
    // The rate of the mode the vault actually measures, never the other one.
    rateBps: state === undefined ? null : mode === MODE_VOLUME ? state.volumeBps : state.skimBps,
    maxContribution: rawFrom(state?.maxContribution),
    walletReserve: rawFrom(state?.walletReserve),
    paused: state?.paused ?? null,
    volumeNotOffered: mode === MODE_VOLUME && !VOLUME_MODE_OFFERED,
  };
}

function policyView(snapshot: LiveSnapshotJson, usdcHeld: bigint | null, nowMs: number): LivePolicyView {
  const { policy, prices } = snapshot;
  const state = policy.state;
  const limits = todaysLimits(prices);
  const empty: LivePolicyView = {
    status: policy.status,
    address: policy.address,
    enabled: null,
    legs: [],
    minInvestment: null,
    maxPerCall: null,
    maxRolling30d: null,
    usedLast30d: null,
    lifetimeInvested: null,
    storedSolFloorPerSol: null,
    todayPerSol: limits?.todayPerSol ?? null,
    pricesKnown: false,
    belowMarket: false,
    readiness: null,
  };
  if (policy.status !== "exists" || state === undefined) return empty;

  const floors = floorsState(state, prices);
  const legs: LivePolicyLegView[] = floors.legs.map((leg) => ({
    mint: leg.mint,
    symbol: leg.symbol,
    weightBps: leg.weightBps,
    storedFloorWad: leg.floor,
    liveWad: leg.live,
    todayPer1e8: leg.today,
    storedCeilingPer1e8: leg.floor === null || leg.floor <= 0n ? null : usdcRawPer1e8LegRaw(leg.floor),
  }));
  const minInvestment = rawFrom(state.minInvestment);
  const maxPerCall = rawFrom(state.maxPerCall);
  return {
    ...empty,
    enabled: state.enabled,
    legs,
    minInvestment,
    maxPerCall,
    maxRolling30d: rawFrom(state.maxRolling30d),
    usedLast30d: usedInLast30Days(state.bucketDays, state.bucketAmounts, nowMs / 1_000),
    lifetimeInvested: rawFrom(state.lifetimeInvested),
    storedSolFloorPerSol: floors.storedConvert === null || floors.storedConvert <= 0n ? null : usdcRawPerSol(floors.storedConvert),
    pricesKnown: floors.pricesKnown,
    belowMarket: floors.belowMarket,
    readiness:
      usdcHeld === null || minInvestment === null || maxPerCall === null ? null : investmentReadiness(usdcHeld, state.legs, minInvestment, maxPerCall),
  };
}

interface TokenHolding {
  readonly amountRaw: bigint;
  readonly uiAmount: string | null;
}

/** What the vault's own account of `mint` holds, or null when it was not read. */
function tokenOf(snapshot: LiveSnapshotJson, mint: string): TokenHolding | null {
  if (snapshot.vaultTokenAccounts.status !== "exists") return null;
  const account = snapshot.vaultTokenAccounts.items.find((item) => item.mint === mint);
  if (account === undefined || account.status !== "exists") return null;
  const amountRaw = rawFrom(account.amountRaw);
  return amountRaw === null ? null : { amountRaw, uiAmount: account.uiAmount ?? null };
}

function holdingsOf(snapshot: LiveSnapshotJson, vault: LiveVaultView, policy: LivePolicyView): { rows: LiveHoldingRow[]; worthNow: bigint | null; notInvested: bigint | null } {
  const prices = snapshot.prices;
  const perSol = rawFrom(prices?.usdcRawPerSol);
  const rows: LiveHoldingRow[] = [];

  // SOL: what a withdrawal could take. The rent Solana keeps is noted, not counted as spendable.
  const withdrawable = vault.withdrawable;
  if (vault.exists && withdrawable !== null) {
    rows.push({
      key: "SOL",
      symbol: "SOL",
      mint: null,
      kind: "sol",
      amountRaw: withdrawable,
      uiAmount: null,
      valueUsdcRaw: perSol === null ? null : usdcRawForLamports(withdrawable, perSol),
      weightBps: null,
      targetWeightBps: null,
      rentFloor: vault.rentFloor,
    });
  }

  const wsol = tokenOf(snapshot, WSOL_MINT);
  if (wsol !== null && wsol.amountRaw > 0n) {
    rows.push({
      key: WSOL_MINT,
      symbol: "wSOL",
      mint: WSOL_MINT,
      kind: "wsol",
      amountRaw: wsol.amountRaw,
      uiAmount: wsol.uiAmount,
      // Wrapped SOL is SOL: the same price, never a separate one.
      valueUsdcRaw: perSol === null ? null : usdcRawForLamports(wsol.amountRaw, perSol),
      weightBps: null,
      targetWeightBps: null,
      rentFloor: null,
    });
  }

  const usdc = tokenOf(snapshot, USDC_MINT);
  if (usdc !== null && usdc.amountRaw > 0n) {
    rows.push({
      key: USDC_MINT,
      symbol: "USDC",
      mint: USDC_MINT,
      kind: "usdc",
      amountRaw: usdc.amountRaw,
      uiAmount: usdc.uiAmount,
      // A dollar is a dollar: counted at $1 rather than priced against itself.
      //
      // BUT THE DOLLAR COLUMN IS ALL OR NOTHING. With no prices read, the total
      // is unknown, and one row still showing $5.00 beside a total that says
      // "unavailable" is the badge disagreeing with the numbers under it.
      valueUsdcRaw: prices === null ? null : usdc.amountRaw,
      weightBps: null,
      targetWeightBps: null,
      rentFloor: null,
    });
  }

  for (const leg of OFFERED_LEGS) {
    const held = tokenOf(snapshot, leg.mint);
    if (held === null || held.amountRaw === 0n) continue;
    const per1e8 = rawFrom(prices?.legs.find((entry) => entry.mint === leg.mint)?.usdcRawPer1e8);
    rows.push({
      key: leg.mint,
      symbol: leg.symbol,
      mint: leg.mint,
      kind: "leg",
      amountRaw: held.amountRaw,
      // The RPC's display amount. Recomputing it from amountRaw would be wrong for a scaled mint.
      uiAmount: held.uiAmount,
      // RAW units at the pool rate, never uiAmount × price.
      valueUsdcRaw: per1e8 === null ? null : (held.amountRaw * per1e8) / 100_000_000n,
      weightBps: null,
      targetWeightBps: policy.legs.find((entry) => entry.mint === leg.mint)?.weightBps ?? null,
      rentFloor: null,
    });
  }

  const sum = (kinds: readonly LiveHoldingRow["kind"][]): bigint | null => {
    const parts = rows.filter((row) => kinds.includes(row.kind));
    if (parts.some((row) => row.valueUsdcRaw === null)) return null;
    return parts.reduce((total, row) => total + (row.valueUsdcRaw ?? 0n), 0n);
  };
  const worthNow = sum(["sol", "wsol", "usdc", "leg"]);
  const invested = rows.filter((row) => row.kind === "leg").reduce((total, row) => total + (row.valueUsdcRaw ?? 0n), 0n);

  // A leg's share of what is actually invested, which is what "vs target" compares against.
  const withWeights = rows.map((row): LiveHoldingRow => {
    if (row.kind !== "leg" || row.valueUsdcRaw === null || invested <= 0n) return row;
    return { ...row, weightBps: Number((row.valueUsdcRaw * 10_000n) / invested) };
  });

  return { rows: withWeights, worthNow, notInvested: sum(["sol", "wsol", "usdc"]) };
}

const walletLabel = (index: number): string => `Trading wallet ${index + 1}`;

function walletsOf(snapshot: LiveSnapshotJson, privyWallets: readonly string[], walletFloor: bigint | null, walletReserve: bigint | null): LiveWalletView[] {
  const bySnapshot = new Map(snapshot.wallets.map((wallet) => [wallet.wallet, wallet]));
  const canSettleOf = (lamports: bigint | null): boolean | null => {
    if (lamports === null || walletFloor === null || walletReserve === null) return null;
    // settle.rs refuses a settlement that would leave less than rent(0) + reserve,
    // so EXACTLY the floor plus the reserve is already too little.
    return lamports > walletFloor + walletReserve;
  };

  const out: LiveWalletView[] = [];
  const seen = new Set<string>();
  // Privy's HD order first: these are the wallets this account actually owns.
  privyWallets.forEach((address, index) => {
    if (seen.has(address)) return;
    seen.add(address);
    const read = bySnapshot.get(address);
    const lamports = rawFrom(read?.lamports);
    out.push({
      address,
      label: walletLabel(index),
      source: "privy",
      lamports,
      linkAddress: read?.link.address ?? "",
      linkStatus: read?.link.status ?? "unreadable",
      settlementNonce: rawFrom(read?.link.settlementNonce),
      canSettle: canSettleOf(lamports),
    });
  });

  // Then links found on chain for wallets Privy does not list here: the vault
  // saves from them all the same, so hiding them would understate the pension.
  for (const link of snapshot.links?.items ?? []) {
    if (seen.has(link.wallet) || out.length >= 10) continue;
    seen.add(link.wallet);
    const read = bySnapshot.get(link.wallet);
    const lamports = rawFrom(read?.lamports);
    out.push({
      address: link.wallet,
      label: "Linked wallet",
      source: "chain",
      lamports,
      linkAddress: link.address,
      linkStatus: read?.link.status ?? "this_vault",
      settlementNonce: rawFrom(link.settlementNonce),
      canSettle: canSettleOf(lamports),
    });
  }
  return out.slice(0, 10);
}

const isoOf = (blockTime: number | null): string | null => (blockTime === null ? null : new Date(blockTime * 1_000).toISOString());

interface Visible {
  readonly rows: LiveRow[];
  readonly hiddenUpkeep: number;
  readonly hiddenDust: number;
}

function rowsOf(activity: LiveActivityJson | null): Visible {
  const rows: LiveRow[] = [];
  let hiddenUpkeep = 0;
  let hiddenDust = 0;
  for (const entry of activity?.entries ?? []) {
    for (const event of entry.events) {
      if (event.kind === "upkeep") {
        hiddenUpkeep += 1;
        continue;
      }
      // A rent top-up is not something anyone saved; it is counted, not listed.
      if (event.kind === "received_sol" && BigInt(event.lamports) < DUST_LAMPORTS) {
        hiddenDust += 1;
        continue;
      }
      rows.push({
        signature: entry.signature,
        at: isoOf(entry.blockTime),
        blockTime: entry.blockTime,
        ok: entry.ok,
        explorerUrl: solscanTx(entry.signature),
        event,
      });
    }
  }
  return { rows, hiddenUpkeep, hiddenDust };
}

type SettledEventJson = Extract<VaultEventJson, { kind: "settled" }>;

interface LoadedSettlement {
  readonly paid: bigint;
  readonly capped: boolean;
  readonly at: string | null;
  readonly blockTime: number | null;
  readonly slot: number;
}

/** Every settlement the loaded history holds, newest first, that the snapshot's slot covers. */
function settlementsOf(activity: LiveActivityJson | null, slot: number | null): LoadedSettlement[] {
  const out: LoadedSettlement[] = [];
  for (const entry of activity?.entries ?? []) {
    // A settlement the snapshot's lifetimeSaved does not yet include would push
    // the curve above the total it is worked back from.
    if (slot !== null && entry.slot > slot) continue;
    for (const event of entry.events) {
      if (event.kind !== "settled") continue;
      const settled = event as SettledEventJson;
      out.push({ paid: BigInt(settled.paid), capped: settled.capped, at: isoOf(entry.blockTime), blockTime: entry.blockTime, slot: entry.slot });
    }
  }
  return out;
}

/**
 * The curve, worked BACKWARDS from the vault's own lifetimeSaved.
 *
 * The total is a fact on chain; the loaded page is a window onto how it got
 * there. So the newest point IS lifetimeSaved, and each earlier point subtracts
 * what landed after it — rather than summing a partial page forward and drawing
 * a curve that ends below the number in the hero.
 */
function chartOf(settlements: readonly LoadedSettlement[], lifetimeSaved: bigint | null, nowMs: number): LiveChartPoint[] | null {
  if (settlements.length === 0 || lifetimeSaved === null) return null;
  // Oldest first, so each point can subtract what came after it.
  const oldestFirst = [...settlements].reverse();
  const points: LiveChartPoint[] = [];
  const totalLoaded = oldestFirst.reduce((total, entry) => total + entry.paid, 0n);

  const oldest = oldestFirst[0]!;
  const baselineAt = oldest.blockTime === null ? new Date(nowMs).toISOString() : new Date((oldest.blockTime - 1) * 1_000).toISOString();
  points.push({ at: baselineAt, totalLamports: lifetimeSaved - totalLoaded });

  let running = lifetimeSaved - totalLoaded;
  for (const entry of oldestFirst) {
    running += entry.paid;
    points.push({ at: entry.at ?? new Date(nowMs).toISOString(), totalLamports: running });
  }
  points.push({ at: new Date(nowMs).toISOString(), totalLamports: lifetimeSaved });
  return points;
}

const DAY_MS = 86_400_000;

function statsOf(
  settlements: readonly LoadedSettlement[],
  activity: LiveActivityJson | null,
  rows: readonly LiveRow[],
  wallets: readonly LiveWalletView[],
  nowMs: number,
): LiveStatsView {
  const paid = settlements.map((entry) => entry.paid);
  const lifetimeNonces = wallets.filter((wallet) => wallet.linkStatus === "this_vault").map((wallet) => wallet.settlementNonce);
  // One nonce nobody could read makes the LIFETIME count unknown, not smaller.
  const settlementsLifetime = lifetimeNonces.some((nonce) => nonce === null)
    ? null
    : lifetimeNonces.reduce<bigint>((total, nonce) => total + (nonce ?? 0n), 0n);

  // The loaded history covers a window when it is complete, or when it reaches
  // back past the window's start. Otherwise a sum of it is not that window's total.
  const complete = activity !== null && activity.status === "exists" && activity.nextBefore === null;
  const oldestBlockTime = settlements.length === 0 ? null : settlements[settlements.length - 1]!.blockTime;
  const covers = (since: number): boolean => complete || (oldestBlockTime !== null && oldestBlockTime * 1_000 <= since);
  const sumSince = (since: number): bigint | null =>
    covers(since) ? settlements.filter((entry) => entry.blockTime !== null && entry.blockTime * 1_000 >= since).reduce((total, entry) => total + entry.paid, 0n) : null;

  const startOfToday = Date.UTC(new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth(), new Date(nowMs).getUTCDate());

  return {
    settlementsLifetime,
    loadedSettlements: settlements.length,
    loadedSavedLamports: paid.reduce((total, amount) => total + amount, 0n),
    biggestPaid: paid.length === 0 ? null : paid.reduce((most, amount) => (amount > most ? amount : most), 0n),
    cappedCount: settlements.filter((entry) => entry.capped).length,
    lastSettlementAt: settlements[0]?.at ?? null,
    savedTodayLamports: sumSince(startOfToday),
    savedThisWeekLamports: sumSince(nowMs - 7 * DAY_MS),
    investmentsLoaded: rows.filter((row) => row.event.kind === "invested").length,
  };
}

function stageOf(vault: LiveVaultView, wallets: readonly LiveWalletView[], settlementsLifetime: bigint | null, loadedSettlements: number): LiveStage {
  // THE READ'S OWN OUTCOME DECIDES, not the absence of numbers: a missing vault
  // has no lamports either, and telling someone their pension is unreadable when
  // they simply have not made one yet is as wrong as the other way round.
  // Unreadable comes first, so a vault that MAY exist is never offered for creation.
  if (!vault.exists) return vault.status === "unreadable" ? "vault_unreadable" : "no_vault";
  if (wallets.length === 0) return "no_trading_wallet";
  if (!wallets.some((wallet) => wallet.linkStatus === "this_vault")) return "not_linked";
  const everSettled = (settlementsLifetime !== null && settlementsLifetime > 0n) || loadedSettlements > 0 || (vault.lifetimeSaved ?? 0n) > 0n;
  return everSettled ? "active" : "waiting_first_settlement";
}

export interface LiveDashboardInput {
  readonly snapshot: LiveSnapshotJson;
  readonly activity: LiveActivityJson | null;
  /** The Privy embedded wallets on this account, in HD order. */
  readonly privyWallets: readonly string[];
}

/** The whole screen, from one snapshot and the history loaded so far. */
export function toLiveDashboard(input: LiveDashboardInput): LiveDashboard {
  const { snapshot, activity, privyWallets } = input;
  const nowMs = snapshot.readAtMs;
  const vault = vaultView(snapshot);
  const usdc = tokenOf(snapshot, USDC_MINT);
  const policy = policyView(snapshot, usdc?.amountRaw ?? null, nowMs);
  const holdings = holdingsOf(snapshot, vault, policy);
  const wallets = walletsOf(snapshot, privyWallets, rawFrom(snapshot.rents.walletFloor), vault.walletReserve);
  const visible = rowsOf(activity);
  const settlements = settlementsOf(activity, snapshot.slot);
  const stats = statsOf(settlements, activity, visible.rows, wallets, nowMs);

  return {
    stage: stageOf(vault, wallets, stats.settlementsLifetime, stats.loadedSettlements),
    slot: snapshot.slot,
    nowMs,
    vault,
    protocolPaused: snapshot.config.status === "exists" ? snapshot.config.paused : null,
    policy,
    prices: snapshot.prices,
    holdings: holdings.rows,
    tokensReadable: snapshot.vaultTokenAccounts.status === "exists",
    worthNowUsdcRaw: holdings.worthNow,
    notInvestedUsdcRaw: holdings.notInvested,
    wallets,
    rows: visible.rows,
    hiddenUpkeep: visible.hiddenUpkeep,
    hiddenDust: visible.hiddenDust,
    chart: chartOf(settlements, vault.lifetimeSaved, nowMs),
    stats,
  };
}

/** Re-exported so the live rule card reads the same limits the wallets screen does. */
export { todaysLimits, usedInLast30Days };
