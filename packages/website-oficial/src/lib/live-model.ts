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
  LiveEntryJson,
  LiveChartPoint,
  LiveDashboard,
  LiveDiscoveredLinkJson,
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

function holdingsOf(
  snapshot: LiveSnapshotJson,
  vault: LiveVaultView,
  policy: LivePolicyView,
): { rows: LiveHoldingRow[]; worthNow: bigint | null; notInvested: bigint | null; rentOnly: bigint | null } {
  const prices = snapshot.prices;
  const perSol = rawFrom(prices?.usdcRawPerSol);
  const rows: LiveHoldingRow[] = [];

  // SOL: what a withdrawal could take. The rent Solana keeps is noted, not counted as spendable.
  //
  // ZERO IS NOT A HOLDING. wSOL, USDC and every leg already guard on `> 0n`;
  // SOL did not, so a vault holding nothing but its own rent led the table with
  // "SOL — 0 shares — $0.00" and a line of rent jargon. The rent is still said,
  // once, in prose: `rentOnly` below carries it to the footnotes.
  const withdrawable = vault.withdrawable;
  if (vault.exists && withdrawable !== null && withdrawable > 0n) {
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

  // The vault exists, it holds only the rent, and so there is no SOL row to
  // carry that fact. Null whenever a row does say it, or there is nothing to say.
  const rentOnly = vault.exists && withdrawable !== null && withdrawable === 0n ? vault.rentFloor : null;

  return { rows: withWeights, worthNow, notInvested: sum(["sol", "wsol", "usdc"]), rentOnly };
}

const walletLabel = (index: number): string => `Trading wallet ${index + 1}`;

/** The most wallets one snapshot asks about, and so the most this screen can list. */
const MAX_WALLET_ROWS = 10;

interface WalletsRead {
  readonly rows: LiveWalletView[];
  /**
   * More wallets than the snapshot can carry were found, so the list is cut.
   *
   * A TOTAL OVER A CUT LIST IS NOT THAT TOTAL. The lifetime settlement count is
   * summed from these links' own nonces, and summing ten of twelve is a smaller
   * number wearing a complete one's name — the same error an unreadable nonce
   * makes, and it is answered the same way: unknown, not smaller.
   */
  readonly truncated: boolean;
}

function walletsOf(snapshot: LiveSnapshotJson, privyWallets: readonly string[], walletFloor: bigint | null, walletReserve: bigint | null): WalletsRead {
  const bySnapshot = new Map(snapshot.wallets.map((wallet) => [wallet.wallet, wallet]));
  const canSettleOf = (lamports: bigint | null): boolean | null => {
    if (lamports === null || walletFloor === null || walletReserve === null) return null;
    // settle.rs refuses a settlement that would leave less than rent(0) + reserve,
    // so EXACTLY the floor plus the reserve is already too little.
    return lamports > walletFloor + walletReserve;
  };

  // EVERY candidate first, and the cap afterwards, so the count of what was left
  // out is known rather than lost inside the loop that dropped it.
  //
  // Privy's HD order leads: these are the wallets this account actually owns.
  // Then links found on chain for wallets Privy does not list here — the vault
  // saves from them all the same, so hiding them would understate the pension.
  interface Candidate {
    readonly address: string;
    readonly label: string;
    readonly source: LiveWalletView["source"];
    readonly link: LiveDiscoveredLinkJson | null;
  }
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  privyWallets.forEach((address, index) => {
    if (seen.has(address)) return;
    seen.add(address);
    candidates.push({ address, label: walletLabel(index), source: "privy", link: null });
  });
  for (const link of snapshot.links?.items ?? []) {
    if (seen.has(link.wallet)) continue;
    seen.add(link.wallet);
    candidates.push({ address: link.wallet, label: "Linked wallet", source: "chain", link });
  }

  const rows = candidates.slice(0, MAX_WALLET_ROWS).map((candidate): LiveWalletView => {
    const read = bySnapshot.get(candidate.address);
    const lamports = rawFrom(read?.lamports);
    const { link } = candidate;
    return {
      address: candidate.address,
      label: candidate.label,
      source: candidate.source,
      lamports,
      linkAddress: link?.address ?? read?.link.address ?? "",
      // A wallet the chain itself reported a link for is linked here; one Privy
      // named but the snapshot could not read is unreadable, never "not linked".
      linkStatus: read?.link.status ?? (link === null ? "unreadable" : "this_vault"),
      settlementNonce: rawFrom(link === null ? read?.link.settlementNonce : link.settlementNonce),
      canSettle: canSettleOf(lamports),
    };
  });

  return { rows, truncated: candidates.length > MAX_WALLET_ROWS };
}

const isoOf = (blockTime: number | null): string | null => (blockTime === null ? null : new Date(blockTime * 1_000).toISOString());

interface Visible {
  readonly rows: LiveRow[];
  /**
   * The events the feed leaves out, as rows — not merely counted.
   *
   * They were DISCARDED before, so "12 account upkeep transactions hidden" was
   * a claim nobody could check against Solscan, and a page where every
   * transaction was upkeep drew "No activity yet" over fifteen real ones.
   */
  readonly hidden: LiveRow[];
  readonly hiddenUpkeep: number;
  readonly hiddenDust: number;
}

/** One entry's events as feed rows, with its Solscan link. */
function rowsIn(entries: readonly LiveEntryJson[], keep: (event: VaultEventJson) => boolean): LiveRow[] {
  const rows: LiveRow[] = [];
  for (const entry of entries) {
    for (const event of entry.events) {
      if (!keep(event)) continue;
      rows.push({ signature: entry.signature, at: isoOf(entry.blockTime), blockTime: entry.blockTime, ok: entry.ok, explorerUrl: solscanTx(entry.signature), event });
    }
  }
  return rows;
}

function rowsOf(activity: LiveActivityJson | null): Visible {
  const rows: LiveRow[] = [];
  const hidden: LiveRow[] = [];
  let hiddenUpkeep = 0;
  let hiddenDust = 0;
  for (const entry of activity?.entries ?? []) {
    for (const event of entry.events) {
      const row: LiveRow = {
        signature: entry.signature,
        at: isoOf(entry.blockTime),
        blockTime: entry.blockTime,
        ok: entry.ok,
        explorerUrl: solscanTx(entry.signature),
        event,
      };
      if (event.kind === "upkeep") {
        hiddenUpkeep += 1;
        hidden.push(row);
        continue;
      }
      // A rent top-up is not something anyone saved; it is counted, not listed.
      if (event.kind === "received_sol" && BigInt(event.lamports) < DUST_LAMPORTS) {
        hiddenDust += 1;
        hidden.push(row);
        continue;
      }
      rows.push(row);
    }
  }
  return { rows, hidden, hiddenUpkeep, hiddenDust };
}

type SettledEventJson = Extract<VaultEventJson, { kind: "settled" }>;

interface LoadedSettlement {
  readonly paid: bigint;
  /** What the rule measured this settlement against: the profit, or the volume. */
  readonly base: bigint;
  readonly capped: boolean;
  readonly at: string | null;
  readonly blockTime: number | null;
  readonly slot: number;
}

/** Every settlement these entries hold, newest first, that the snapshot's slot covers. */
function settlementsIn(entries: readonly LiveEntryJson[], slot: number | null): LoadedSettlement[] {
  const out: LoadedSettlement[] = [];
  for (const entry of entries) {
    // A settlement the snapshot's lifetimeSaved does not yet include would push
    // the curve above the total it is worked back from.
    if (slot !== null && entry.slot > slot) continue;
    for (const event of entry.events) {
      if (event.kind !== "settled") continue;
      const settled = event as SettledEventJson;
      out.push({
        paid: BigInt(settled.paid),
        base: BigInt(settled.baseLamports),
        capped: settled.capped,
        at: isoOf(entry.blockTime),
        blockTime: entry.blockTime,
        slot: entry.slot,
      });
    }
  }
  return out;
}

/**
 * The two streams' entries as ONE list, newest first, one row per signature.
 *
 * THE VAULT'S COPY WINS. A link page is scoped per entry to this vault
 * (scopeEntryToVault) and so carries only the instructions the program tied
 * here; the vault page is unfiltered. For a settlement of this vault the two
 * are the same row, but preferring the unfiltered one means a signature can
 * never appear with fewer events than the feed already drew for it.
 *
 * SORTED, BECAUSE THE TWO STREAMS INTERLEAVE IN TIME. Everything downstream —
 * the newest settlement, the curve's order, the oldest loaded moment — reads
 * this list as newest first, which is free while it is one contiguous page and
 * false the moment a second stream is poured in. blockTime leads and the slot
 * breaks its ties; a row the chain gave no block time keeps its place by slot.
 */
function mergeStreams(vault: readonly LiveEntryJson[], link: readonly LiveEntryJson[]): LiveEntryJson[] {
  const seen = new Set(vault.map((entry) => entry.signature));
  const merged = [...vault, ...link.filter((entry) => !seen.has(entry.signature))];
  return merged.sort((left, right) => (right.blockTime ?? 0) - (left.blockTime ?? 0) || right.slot - left.slot);
}

/** The oldest moment the loaded history speaks for. Entries arrive newest first. */
function loadedSince(entries: readonly LiveEntryJson[]): number | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const blockTime = entries[index]!.blockTime;
    if (blockTime !== null) return blockTime;
  }
  return null;
}

/**
 * The curve, worked BACKWARDS from the vault's own lifetimeSaved.
 *
 * The total is a fact on chain; the loaded page is a window onto how it got
 * there. So the newest point IS lifetimeSaved, and each earlier point subtracts
 * what landed after it — rather than summing a partial page forward and drawing
 * a curve that ends below the number in the hero.
 *
 * A WINDOW WITH NO SETTLEMENT IN IT STILL HAS A TRUE CURVE, and it is FLAT. The
 * vault's total only moves when a settlement lands, so across a window holding
 * none it stood exactly where it stands now — which is what the line says,
 * drawn from the oldest loaded row to the read's own clock. Drawing nothing
 * there was how "The chart starts with your first settlement" came to sit over
 * a pension that had settled the day before: the settlement was real, it was
 * simply older than fifteen signatures of keeper upkeep.
 */
function chartOf(settlements: readonly LoadedSettlement[], lifetimeSaved: bigint | null, nowMs: number, since: number | null): LiveChartPoint[] | null {
  if (lifetimeSaved === null) return null;
  if (settlements.length === 0) {
    // Nothing saved yet: the chart really does start with the first settlement.
    // And with no loaded row there is no window to be flat across, so the
    // caption says that instead of claiming one.
    if (lifetimeSaved <= 0n || since === null || since * 1_000 >= nowMs) return null;
    return [
      { at: new Date(since * 1_000).toISOString(), totalLamports: lifetimeSaved },
      { at: new Date(nowMs).toISOString(), totalLamports: lifetimeSaved },
    ];
  }
  // Oldest first, so each point can subtract what came after it.
  const oldestFirst = [...settlements].reverse();
  const points: LiveChartPoint[] = [];
  const totalLoaded = oldestFirst.reduce((total, entry) => total + entry.paid, 0n);

  // THE LOADED HISTORY HOLDS MORE THAN THE VAULT'S OWN TOTAL, so working back
  // from lifetimeSaved would start the curve below zero — a "saved so far" that
  // is less than nothing. It is reachable whenever the snapshot's slot is
  // unknown (readers.ts leaves it null when the RPC answer omits context.slot),
  // because settlementsOf can then leave nothing out: a settlement that landed
  // between the snapshot and the activity page is counted here while the
  // vault's lifetimeSaved does not include it yet. Coverage cannot be verified,
  // so no curve is drawn rather than a wrong one — the stats below still report
  // every settlement that was loaded, and the feed still lists them.
  if (lifetimeSaved < totalLoaded) return null;

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
/** The sample's strip is thirteen weeks; the live series is never longer. */
const DAILY_DAYS = 91;

function statsOf(
  settlements: readonly LoadedSettlement[],
  activity: LiveActivityJson | null,
  /** The settlements the VAULT page alone holds: the only ones a window may be summed from. */
  vaultSettlements: readonly LoadedSettlement[],
  shown: readonly LoadedSettlement[],
  rows: readonly LiveRow[],
  wallets: WalletsRead,
  nowMs: number,
  lifetimeSaved: bigint | null,
  /** The vault's own creation, in seconds: where a fully loaded history begins. */
  createdAt: bigint | null,
): LiveStatsView {
  const paid = settlements.map((entry) => entry.paid);
  const lifetimeNonces = wallets.rows.filter((wallet) => wallet.linkStatus === "this_vault").map((wallet) => wallet.settlementNonce);
  // One nonce nobody could read makes the LIFETIME count unknown, not smaller —
  // and so does a link list the snapshot had to cut, which is the same error
  // reached by a different road: a sum of ten of twelve links is not a lifetime.
  const settlementsLifetime =
    wallets.truncated || lifetimeNonces.some((nonce) => nonce === null)
      ? null
      : lifetimeNonces.reduce<bigint>((total, nonce) => total + (nonce ?? 0n), 0n);

  // WHEN A WINDOW MAY BE SUMMED AT ALL, and the three answers are not
  // interchangeable.
  //
  // EVERY ONE, PROVED BY ARITHMETIC. The vault's lifetimeSaved only ever moves
  // on a settlement, so when what is loaded adds up to exactly that total,
  // nothing is missing — from any window, whichever stream the rows came from.
  // This is the arm the link pages earn: one settlement of 0.0366 SOL beside a
  // lifetimeSaved of 0.0366 SOL is a complete history and can be said to be.
  //
  // OR THE VAULT PAGE REACHED THE BEGINNING, or it reaches back past the
  // window's start. Both of those rest on the vault page being a CONTIGUOUS
  // slice of one stream, so they are asked of the VAULT's settlements only. A
  // link page is one wallet's slice: merging it moves the oldest loaded
  // settlement backwards while leaving holes above it, and the sum would be
  // some of the window wearing the whole window's name.
  const everySettlement = lifetimeSaved !== null && lifetimeSaved > 0n && paid.reduce((total, amount) => total + amount, 0n) === lifetimeSaved;
  const complete = activity !== null && activity.status === "exists" && activity.nextBefore === null;
  const oldestVault = vaultSettlements.length === 0 ? null : vaultSettlements[vaultSettlements.length - 1]!.blockTime;
  const covers = (since: number): boolean => everySettlement || complete || (oldestVault !== null && oldestVault * 1_000 <= since);
  const sumSince = (since: number): bigint | null =>
    covers(since) ? settlements.filter((entry) => entry.blockTime !== null && entry.blockTime * 1_000 >= since).reduce((total, entry) => total + entry.paid, 0n) : null;

  const startOfToday = Date.UTC(new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth(), new Date(nowMs).getUTCDate());

  /*
   * THE DAYS THE LOADED HISTORY CAN SPEAK FOR, one by one — the series the
   * sample's 13-week strip, its active days and its streaks are all made of.
   *
   * A DAY IS ONLY LISTED WHEN IT IS WHOLE. With every settlement loaded (by
   * arithmetic, or because the vault page reached its beginning) that is every
   * day since the vault was made. Otherwise the vault page is contiguous down
   * to its oldest settlement and no further, so the day that settlement landed
   * on may have lost its morning: the series starts the day AFTER. A day with
   * no settlement in a covered span is a true zero; a day outside it is not in
   * the list at all, which is the difference between "saved nothing" and "not
   * known".
   *
   * THIRTEEN WEEKS AT MOST, which is the sample's own scale.
   */
  const whole = everySettlement || complete;
  const oldestLoaded = settlements.length === 0 ? null : settlements[settlements.length - 1]!.blockTime;
  const firstWholeDay = (() => {
    if (whole) {
      const since = createdAt !== null && createdAt > 0n ? Number(createdAt) * 1_000 : oldestLoaded !== null ? oldestLoaded * 1_000 : null;
      return since === null ? null : Math.floor(since / DAY_MS) * DAY_MS;
    }
    return oldestVault === null ? null : Math.floor((oldestVault * 1_000) / DAY_MS) * DAY_MS + DAY_MS;
  })();
  const dailySaved: { readonly day: string; readonly lamports: bigint }[] = [];
  if (firstWholeDay !== null) {
    const from = Math.max(firstWholeDay, startOfToday - (DAILY_DAYS - 1) * DAY_MS);
    const byDay = new Map<number, bigint>();
    for (const entry of settlements) {
      if (entry.blockTime === null) continue;
      const day = Math.floor((entry.blockTime * 1_000) / DAY_MS) * DAY_MS;
      byDay.set(day, (byDay.get(day) ?? 0n) + entry.paid);
    }
    for (let day = from; day <= startOfToday; day += DAY_MS) {
      dailySaved.push({ day: new Date(day).toISOString().slice(0, 10), lamports: byDay.get(day) ?? 0n });
    }
  }

  // WHAT THE RULE MEASURED, which is the sample's "Volume" slot on a vault that
  // measures profit: the gains a slice was taken from. A LIFETIME figure only
  // when every settlement is loaded; the month only when the month is covered.
  const baseSince = (since: number): bigint | null =>
    covers(since) ? settlements.filter((entry) => entry.blockTime !== null && entry.blockTime * 1_000 >= since).reduce((total, entry) => total + entry.base, 0n) : null;

  // WHAT THE STATE SAYS HAPPENED, BESIDE WHAT THE LOADED PAGES HOLD. The
  // vault's own total only moves on a settlement, and a link's nonce counts
  // them; either one saying "at least one" while the loaded history holds none
  // is the case every "none yet" on this screen was wrong about. A nonce nobody
  // could read does not vote — and a truncated link list cannot hide this,
  // because one positive nonce is enough.
  const stateSettled = (lifetimeSaved ?? 0n) > 0n || lifetimeNonces.some((nonce) => nonce !== null && nonce > 0n);

  // WHAT THE FEED IS LISTING, which is not the same list as the one the curve
  // is drawn from. `settlements` has had the snapshot's slot filter applied —
  // rightly, because the curve is worked backwards from a lifetimeSaved that
  // does not include a settlement newer than the snapshot. rowsOf applies no
  // such filter, so that settlement IS on the screen.
  //
  // The two differ by one case, and it is not a rare one: the hook reads the
  // snapshot first and the activity page second (use-live-dashboard.ts), so a
  // settle landing between the two reads is ALWAYS newer than snapshot.slot.
  // Deciding these two fields from the filtered list printed "Last settlement —
  // none yet" and "No settlement landed in this window" directly above a
  // settlement row a few seconds old, and cleared only on the next poll.
  //
  // So the two statements ABOUT THE HISTORY are made from the history: whether
  // the screen holds a settlement at all, and when the newest one it holds
  // landed. It is the same test live-backfill.ts's holdsSettlement makes before
  // paging back for one, and live-model.test.ts pins that they agree.
  return {
    settlementsLifetime,
    settledOutsideHistory: stateSettled && shown.length === 0,
    loadedSettlements: settlements.length,
    loadedSavedLamports: paid.reduce((total, amount) => total + amount, 0n),
    biggestPaid: paid.length === 0 ? null : paid.reduce((most, amount) => (amount > most ? amount : most), 0n),
    cappedCount: settlements.filter((entry) => entry.capped).length,
    lastSettlementAt: shown[0]?.at ?? null,
    savedTodayLamports: sumSince(startOfToday),
    savedThisWeekLamports: sumSince(nowMs - 7 * DAY_MS),
    savedThisMonthLamports: sumSince(nowMs - 30 * DAY_MS),
    gainsMeasuredLamports: whole ? settlements.reduce((total, entry) => total + entry.base, 0n) : null,
    gainsThisMonthLamports: baseSince(nowMs - 30 * DAY_MS),
    dailySaved,
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
  /**
   * Rows read from the trading wallets' LINK streams, where the settlements
   * are. Kept apart from `activity` all the way down here, and never merged
   * into it by the caller, because two of the three arms of a window claim rest
   * on the vault page being one contiguous slice.
   */
  readonly linkEntries?: readonly LiveEntryJson[];
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

  // THE FEED IS THE VAULT'S HISTORY AND ONLY THE VAULT'S. A link page is a
  // wallet's slice, so listing it here would scatter rows into a column whose
  // counts, day headings and "since" all describe one contiguous page.
  const visible = rowsOf(activity);

  // THE SETTLEMENTS ARE BOTH STREAMS. The vault's own page is mostly keeper
  // upkeep; the links are where the settlements live. Merged, deduped by
  // signature and re-sorted, because everything below reads newest-first.
  const vaultEntries = activity?.entries ?? [];
  const merged = mergeStreams(vaultEntries, input.linkEntries ?? []);
  const settlements = settlementsIn(merged, snapshot.slot);
  const vaultSettlements = settlementsIn(vaultEntries, snapshot.slot);
  // Unfiltered by the snapshot's slot: what the SCREEN holds, which is what
  // "last settlement" and "not in the loaded history" are statements about.
  const shown = settlementsIn(merged, null);
  // THE STRIP IS NOT THE FEED, and after the links it cannot be. The feed is
  // the vault's own contiguous page; a settlement read from a wallet's link is
  // deliberately not in it, and the strip exists to show settlements. So the
  // chips come from both streams while the column beside them stays one.
  const settlementRows = rowsIn(merged, (event) => event.kind === "settled");
  const stats = statsOf(settlements, activity, vaultSettlements, shown, visible.rows, wallets, nowMs, vault.lifetimeSaved, vault.createdAt);

  return {
    stage: stageOf(vault, wallets.rows, stats.settlementsLifetime, stats.loadedSettlements),
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
    rentOnlyLamports: holdings.rentOnly,
    wallets: wallets.rows,
    rows: visible.rows,
    hiddenRows: visible.hidden,
    settlementRows,
    hiddenUpkeep: visible.hiddenUpkeep,
    hiddenDust: visible.hiddenDust,
    chart: chartOf(settlements, vault.lifetimeSaved, nowMs, loadedSince(merged)),
    stats,
    // Quoted by the "no vault yet" card, which must name the cost before anyone
    // is asked to sign for it.
    rents: { vault: rawFrom(snapshot.rents.vault), walletFloor: rawFrom(snapshot.rents.walletFloor) },
  };
}

/** Re-exported so the live rule card reads the same limits the wallets screen does. */
export { todaysLimits, usedInLast30Days };
