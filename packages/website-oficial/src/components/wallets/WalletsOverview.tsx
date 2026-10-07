"use client";

/**
 * THE OVERVIEW: the tab the Manage wallets modal opens on (owner, 10-06). The
 * whole setup at a glance — what needs doing, the pension key, one tile per
 * area — and every part leads to the tab that manages it.
 *
 * IT READS AND NEVER WRITES. Everything here comes from what the screen already
 * holds: the one chain read of VaultScreen (useVaultScreen) and Privy's record
 * of the trading wallets (usePrivy, through the same pure functions the rows
 * use). It starts no fetch and creates no writer, and it never mounts a card:
 * each card lives once, in its own tab, where its write progress and its
 * "not confirmed yet" guard survive a tab switch. A second VaultCard here would
 * be a second writer under the same name, reporting the first one's signature
 * as its own.
 *
 * NOTHING UNREAD IS PRINTED AS A NUMBER. A read that failed, or that has not
 * answered, shows "—" or says it could not be read; a 0 here always means the
 * chain said 0. A read that still belongs to the previous pension key
 * (useVaultState keeps its last answer when the key changes) counts as loading.
 *
 * THE DERIVATIONS ARE PURE (overviewOf, attentionOf) so the tests can hold them
 * without rendering, and so useWalletsAttention — the dots on the tab rail —
 * can never disagree with the rows this tab shows.
 */

import { usePrivy, type User } from "@privy-io/react-auth";
import { CATALOGUE, MODE_VOLUME } from "@sip/solana-core/client";
import {
  ArrowUpFromLine,
  ChartLine,
  ChevronRight,
  Circle,
  CircleAlert,
  CircleCheck,
  CirclePause,
  LogOut,
  RefreshCw,
  TriangleAlert,
  Vault,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { useMemo, type ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { AddressLine } from "@/components/wallets/AddressLine";
import { rowStatus, type RowLink, type RowStatus } from "@/components/wallets/TradingWalletRow";
import { tokenRows } from "@/components/wallets/WithdrawCard";
import { useVaultScreen, type VaultView } from "@/hooks/use-vault-state";
import { formatSol, formatSolAtMost, rawFrom } from "@/lib/amounts";
import { LABEL, MONO } from "@/lib/classes";
import { LIVE_COPY } from "@/lib/live-copy";
import { policyRoom } from "@/lib/live-model";
import { symbolOfMint } from "@/lib/live-symbols";
import { SETTINGS_COPY } from "@/lib/settings-copy";
import { seatOf, tradingWalletsOf, type SeatStatus } from "@/lib/trading-wallets";
import { cn } from "@/lib/utils";
import type { VaultStateJson } from "@/lib/vault-api";
import { OVERVIEW_COPY, VAULT_COPY, WALLETS_COPY, ratePercent, shortAddress } from "@/lib/vault-copy";
import type { WalletsSection } from "@/lib/wallets-sections";

// ── the derivations ─────────────────────────────────────────────────────────

/** A trading wallet as the overview counts it: its address, and Privy's record of its seat. */
export interface OverviewWallet {
  readonly address: string;
  readonly seat: SeatStatus;
}

/** Privy's trading wallets, never the pension key itself (as VaultScreen reads them), each with its seat. */
export function overviewWallets(user: User | null, pensionKey: string): OverviewWallet[] {
  return tradingWalletsOf(user)
    .filter((wallet) => wallet.address !== pensionKey)
    .map((wallet) => ({ address: wallet.address, seat: seatOf(user, wallet.address) }));
}

export interface WalletCounts {
  readonly total: number;
  /** Wallets the chain read says are linked to this vault, whatever their seat. */
  readonly linked: number;
  /** Wallets whose link the chain read answered, either way. */
  readonly linkKnown: number;
  /** Each wallet once, by the status its row shows (rowStatus). */
  readonly byStatus: Readonly<Record<RowStatus, number>>;
}

export type VaultTile =
  | { readonly kind: "loading" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "missing" }
  | {
      readonly kind: "exists";
      readonly balance: bigint | null;
      /** Null when the vault's own account was not decoded. */
      readonly mode: "profit" | "volume" | null;
      readonly rateBps: number | null;
      readonly lifetimeSaved: bigint | null;
      readonly paused: boolean;
    };

export type InvestingTile =
  | { readonly kind: "loading" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "needs-vault" }
  | { readonly kind: "missing" }
  | { readonly kind: "exists"; readonly enabled: boolean; readonly symbols: readonly string[] };

export type WithdrawTile =
  | { readonly kind: "loading" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "needs-vault" }
  /** `tokens`: how many tokens the vault holds a balance of, or null when they could not be read. */
  | { readonly kind: "exists"; readonly withdrawable: bigint | null; readonly tokens: number | null };

/** Stored price limits that no longer let every buy through: policyRoom's words, exactly as the gear's dot reads them. */
export type PriceLimitsAttention = "passed" | "no-route" | "some-routes";

export interface Overview {
  /** "failed": the route did not answer, or it answered without the vault. */
  readonly read: "loading" | "failed" | "ready";
  readonly protocolPaused: boolean;
  readonly vaultPaused: boolean;
  readonly vault: VaultTile;
  readonly wallets: WalletCounts;
  readonly investing: InvestingTile;
  readonly withdraw: WithdrawTile;
  readonly priceLimits: PriceLimitsAttention | null;
  /**
   * The four setup steps of LIVE_COPY.noVault.steps, done or not — or null when
   * the read cannot say (loading, or the vault or investing unread): a step is
   * never called missing on a read that did not answer.
   */
  readonly steps: readonly [boolean, boolean, boolean, boolean] | null;
}

/** The tab each setup step is done in, in LIVE_COPY.noVault.steps' order. */
export const STEP_SECTIONS = ["vault", "trading", "trading", "investing"] as const satisfies readonly WalletsSection[];

const NO_STATUS: Readonly<Record<RowStatus, number>> = { linked: 0, "not-linked": 0, elsewhere: 0, paused: 0, "needs-permission": 0, checking: 0 };

/** The link a row's status is built from: anything the read did not answer is "unknown", never "missing" (TradingWalletRow's rule). */
function linkOf(state: VaultStateJson | null, address: string): RowLink {
  const entry = state?.walletLinks.find((link) => link.wallet === address);
  return entry === undefined || entry.status === "unreadable" ? "unknown" : entry.status;
}

function countWallets(state: VaultStateJson | null, wallets: readonly OverviewWallet[]): WalletCounts {
  const paused = state?.config.paused === true || state?.vault.state?.paused === true;
  const byStatus = { ...NO_STATUS };
  let linked = 0;
  let linkKnown = 0;
  for (const wallet of wallets) {
    const link = linkOf(state, wallet.address);
    byStatus[rowStatus(wallet.seat, link, paused)] += 1;
    if (link === "this_vault") linked += 1;
    if (link !== "unknown") linkKnown += 1;
  }
  return { total: wallets.length, linked, linkKnown, byStatus };
}

/** A mint's symbol: the app's own names first, then the catalogue's, else the address shortened — never an invented ticker. */
export function symbolFor(mint: string): string {
  return symbolOfMint(mint) ?? CATALOGUE.find((asset) => asset.mint === mint)?.symbol ?? shortAddress(mint);
}

/**
 * EVERYTHING THE OVERVIEW SHOWS, from the screen's view and Privy's wallets.
 *
 * `pensionKey` guards the view: a ready state read for another owner is the
 * previous key's answer, still on screen while the new one loads.
 */
export function overviewOf(view: VaultView | null, wallets: readonly OverviewWallet[], pensionKey: string): Overview {
  const current = view === null || (view.kind === "ready" && view.state.owner !== pensionKey) ? ({ kind: "loading" } as const) : view;

  if (current.kind === "loading") {
    return {
      read: "loading",
      protocolPaused: false,
      vaultPaused: false,
      vault: { kind: "loading" },
      wallets: countWallets(null, wallets),
      investing: { kind: "loading" },
      withdraw: { kind: "loading" },
      priceLimits: null,
      steps: null,
    };
  }

  if (current.kind === "unreadable") {
    return {
      read: "failed",
      protocolPaused: false,
      vaultPaused: false,
      vault: { kind: "unreadable" },
      wallets: countWallets(null, wallets),
      investing: { kind: "unreadable" },
      withdraw: { kind: "unreadable" },
      priceLimits: null,
      steps: null,
    };
  }

  const { state } = current;
  const { vault, policy } = state;
  const account = vault.state;
  const exists = vault.status === "exists";

  const vaultTile: VaultTile =
    vault.status === "unreadable"
      ? { kind: "unreadable" }
      : vault.status === "missing"
        ? { kind: "missing" }
        : {
            kind: "exists",
            balance: rawFrom(vault.lamports),
            mode: account === undefined ? null : account.skimMode === MODE_VOLUME ? "volume" : "profit",
            // The rate of the mode the vault actually measures, never the other one (VaultCard's rule).
            rateBps: account === undefined ? null : account.skimMode === MODE_VOLUME ? account.volumeBps : account.skimBps,
            lifetimeSaved: rawFrom(account?.lifetimeSaved),
            paused: account?.paused === true,
          };

  const investing: InvestingTile =
    vault.status === "unreadable"
      ? { kind: "unreadable" }
      : vault.status === "missing"
        ? { kind: "needs-vault" }
        : policy.status === "missing"
          ? { kind: "missing" }
          : policy.status === "exists" && policy.state !== undefined
            ? { kind: "exists", enabled: policy.state.enabled, symbols: policy.state.legs.map((leg) => symbolFor(leg.mint)) }
            : { kind: "unreadable" };

  const tokens = tokenRows(state);
  const withdraw: WithdrawTile =
    vault.status === "unreadable"
      ? { kind: "unreadable" }
      : vault.status === "missing"
        ? { kind: "needs-vault" }
        : { kind: "exists", withdrawable: rawFrom(vault.withdrawableLamports), tokens: tokens.source === "unreadable" ? null : tokens.rows.length };

  // The gear's own judgement (LiveRulePanel): a floor the market passed, or a leg no route can buy at.
  const room = policy.status === "exists" && policy.state !== undefined ? policyRoom(policy.state, state.prices) : null;
  const priceLimits = room === "passed" || room === "no-route" || room === "some-routes" ? room : null;

  const counts = countWallets(state, wallets);
  const linkedHere = state.walletLinks.some((link) => link.status === "this_vault");
  // The link step is known when a link is there, when the read answered for every wallet, or when there is
  // no vault to link to. Otherwise a link the read did not answer (unreadable, or a wallet too new to have
  // been asked about) may well exist, and the list waits rather than call the step missing.
  const linkStepKnown = !exists || linkedHere || counts.linkKnown === counts.total;
  const stepsKnown = vault.status !== "unreadable" && policy.status !== "unreadable" && linkStepKnown;

  return {
    read: vault.status === "unreadable" ? "failed" : "ready",
    protocolPaused: state.config.paused === true,
    vaultPaused: exists && account?.paused === true,
    vault: vaultTile,
    wallets: counts,
    investing,
    withdraw,
    priceLimits,
    steps: stepsKnown
      ? [exists, counts.total > 0, linkedHere, policy.status === "exists"]
      : null,
  };
}

/** Wallets that stop saving for a reason the owner can fix in the Trading wallets tab: no permission, or no link. */
export function walletsToFix(overview: Overview): { readonly needPermission: number; readonly notLinked: number } | null {
  if (overview.vault.kind !== "exists") return null;
  const needPermission = overview.wallets.byStatus["needs-permission"];
  const notLinked = overview.wallets.byStatus["not-linked"];
  return needPermission + notLinked > 0 ? { needPermission, notLinked } : null;
}

/**
 * WHICH TABS DESERVE A DOT: the same reasons the overview's own rows give,
 * and nothing else. The overview itself never gets one — it is where the
 * rows are.
 */
export function attentionOf(overview: Overview): ReadonlySet<WalletsSection> {
  const sections = new Set<WalletsSection>();
  if (overview.read === "failed") sections.add("vault");
  if (walletsToFix(overview) !== null) sections.add("trading");
  if (overview.priceLimits !== null) sections.add("investing");
  return sections;
}

const NOTHING: ReadonlySet<WalletsSection> = new Set();

/** The tab rail's dots, read from the shared screen state only. */
export function useWalletsAttention(): ReadonlySet<WalletsSection> {
  const screen = useVaultScreen();
  const { user } = usePrivy();
  const view = screen?.view ?? null;
  const pensionKey = screen?.pensionKey ?? null;
  return useMemo(() => (pensionKey === null ? NOTHING : attentionOf(overviewOf(view, overviewWallets(user, pensionKey), pensionKey))), [view, pensionKey, user]);
}

// ── the tab ─────────────────────────────────────────────────────────────────

export function WalletsOverview({
  pensionKey,
  onDisconnect,
  onSelect,
}: {
  readonly pensionKey: string;
  readonly onDisconnect: () => void;
  readonly onSelect: (section: WalletsSection) => void;
}): ReactNode {
  const screen = useVaultScreen();
  const { user } = usePrivy();
  const view = screen?.view ?? null;
  const wallets = useMemo(() => overviewWallets(user, pensionKey), [user, pensionKey]);
  const overview = useMemo(() => overviewOf(view, wallets, pensionKey), [view, wallets, pensionKey]);

  return (
    <div className="@container space-y-4">
      <AttentionRows overview={overview} onRefresh={() => screen?.refresh()} onSelect={onSelect} setupGoesTo={nextStepSection(overview.steps)} />
      <PensionKeyCard address={pensionKey} onDisconnect={onDisconnect} />
      <Tiles overview={overview} onSelect={onSelect} />
      {overview.steps !== null ? <SetupSteps steps={overview.steps} onSelect={onSelect} /> : null}
    </div>
  );
}

/** The tab "Getting set up" points at (its first step not done), or null when it is not shown. */
export function nextStepSection(steps: Overview["steps"]): WalletsSection | null {
  if (steps === null) return null;
  const next = steps.indexOf(false);
  return next === -1 ? null : (STEP_SECTIONS[next] ?? null);
}

/**
 * ONE LINE EACH, ONLY WHEN IT APPLIES, AT MOST ONE BUTTON. Red is kept for a
 * read that failed: the rest are states to know about, not errors.
 *
 * ONE WAY INTO EACH TAB. When "Getting set up" already ends in a button to the
 * same tab (a wallet not linked while no wallet is linked yet), the row keeps
 * its sentence and drops its own button: two identical buttons on one screen
 * read as two different things to do.
 */
function AttentionRows({
  overview,
  onRefresh,
  onSelect,
  setupGoesTo,
}: {
  readonly overview: Overview;
  readonly onRefresh: () => void;
  readonly onSelect: (section: WalletsSection) => void;
  readonly setupGoesTo: WalletsSection | null;
}) {
  const fix = walletsToFix(overview);
  const limitsLine =
    overview.priceLimits === "passed" ? SETTINGS_COPY.refreshNeeded : overview.priceLimits === "no-route" ? SETTINGS_COPY.refreshNoRoute : overview.priceLimits === "some-routes" ? SETTINGS_COPY.refreshSomeRoutes : null;

  const rows: ReactNode[] = [];
  if (overview.read === "failed") {
    rows.push(
      <Notice key="read" icon={CircleAlert} tone="failed" text={OVERVIEW_COPY.readFailed}>
        <Button type="button" variant="outline" size="sm" onClick={() => onRefresh()}>
          <RefreshCw aria-hidden />
          {OVERVIEW_COPY.readAgain}
        </Button>
      </Notice>,
    );
  }
  if (overview.protocolPaused) rows.push(<Notice key="protocol" icon={CirclePause} tone="amber" text={OVERVIEW_COPY.protocolPaused} />);
  // Turned back on from the gear on the pension page, and only there: said, not offered.
  if (overview.vaultPaused) rows.push(<Notice key="vault" icon={CirclePause} tone="amber" text={OVERVIEW_COPY.vaultPaused} />);
  if (limitsLine !== null) {
    rows.push(
      <Notice key="limits" icon={TriangleAlert} tone="amber" text={limitsLine}>
        {setupGoesTo === "investing" ? null : <GoTo section="investing" onSelect={onSelect} />}
      </Notice>,
    );
  }
  if (fix !== null) {
    rows.push(
      <Notice key="wallets" icon={TriangleAlert} tone="amber" text={OVERVIEW_COPY.walletsToFix(fix.needPermission, fix.notLinked)}>
        {setupGoesTo === "trading" ? null : <GoTo section="trading" onSelect={onSelect} />}
      </Notice>,
    );
  }
  return rows.length === 0 ? null : <div className="space-y-2">{rows}</div>;
}

function Notice({ icon: Icon, tone, text, children }: { readonly icon: LucideIcon; readonly tone: "failed" | "amber"; readonly text: string; readonly children?: ReactNode }) {
  const failed = tone === "failed";
  return (
    <div className={cn("flex items-start gap-2 rounded-lg border px-3 py-2 text-sm", failed ? "border-destructive/40 bg-destructive/5" : "bg-muted/40")}>
      <Icon className={cn("mt-0.5 size-4 shrink-0", failed ? "text-destructive" : "text-amber-600 dark:text-amber-400")} aria-hidden />
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2">
        <p role={failed ? "alert" : undefined} className={cn("min-w-0 flex-[1_1_14rem]", failed && "text-destructive")}>
          {text}
        </p>
        {children}
      </div>
    </div>
  );
}

/** A button into another tab, named after it. A button and never a link: a re-seat cancels every link's click. */
function GoTo({ section, onSelect }: { readonly section: WalletsSection; readonly onSelect: (section: WalletsSection) => void }) {
  return (
    <Button type="button" variant="outline" size="sm" onClick={() => onSelect(section)}>
      {OVERVIEW_COPY.goTo(WALLETS_COPY.tabs[section])}
      <ChevronRight aria-hidden />
    </Button>
  );
}

/** What the pension key card used to say, word for word: it is the overview's first card now. */
function PensionKeyCard({ address, onDisconnect }: { readonly address: string; readonly onDisconnect: () => void }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{OVERVIEW_COPY.pensionKey}</CardTitle>
        <CardDescription>{OVERVIEW_COPY.pensionKeyDescription}</CardDescription>
        <CardAction>
          <Button type="button" variant="outline" size="sm" onClick={() => onDisconnect()}>
            <LogOut aria-hidden />
            {OVERVIEW_COPY.disconnect}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-1">
        <div className={LABEL}>{OVERVIEW_COPY.address}</div>
        <AddressLine address={address} />
      </CardContent>
    </Card>
  );
}

type TileSection = Exclude<WalletsSection, "overview">;

/** The rail's icons, so a tile and the tab it opens look like the same thing. */
const SECTION_ICON: Readonly<Record<TileSection, LucideIcon>> = { vault: Vault, trading: Wallet, investing: ChartLine, withdraw: ArrowUpFromLine };

/** One tile's face: `figure` puts the value in the numbers' mono; a word or a "—" stays in the text face. */
interface TileFace {
  readonly value: string;
  readonly figure: boolean;
  readonly sub: string;
  readonly paused?: boolean;
  /** The figure unrounded, when the value is a rounded SOL amount. */
  readonly exact?: string;
}

/**
 * A tile is a glance, so its SOL is rounded to four places (formatSolAtMost: a
 * positive amount never reads as 0). The exact figure is one press away, in the
 * tab the tile opens, and in the figure's own title.
 */
const sol = (lamports: bigint | null): TileFace["value"] => (lamports === null ? OVERVIEW_COPY.notRead : OVERVIEW_COPY.sol(formatSolAtMost(lamports, 4)));
const exactSol = (lamports: bigint | null): string | undefined => (lamports === null ? undefined : OVERVIEW_COPY.sol(formatSol(lamports)));
const unread: TileFace = { value: OVERVIEW_COPY.notRead, figure: false, sub: OVERVIEW_COPY.couldNotRead };
const needsVault: TileFace = { value: OVERVIEW_COPY.notRead, figure: false, sub: OVERVIEW_COPY.needsVault };

export function vaultFace(tile: Exclude<VaultTile, { kind: "loading" }>): TileFace {
  if (tile.kind === "unreadable") return unread;
  if (tile.kind === "missing") return { value: OVERVIEW_COPY.vaultMissing, figure: false, sub: OVERVIEW_COPY.vaultMissingLine };
  const mode = tile.mode === "volume" ? SETTINGS_COPY.modeVolume : SETTINGS_COPY.modeProfit;
  const sub =
    tile.mode === null || tile.rateBps === null
      ? OVERVIEW_COPY.couldNotRead
      : OVERVIEW_COPY.vaultLine(mode, ratePercent(tile.rateBps), tile.lifetimeSaved === null ? null : formatSolAtMost(tile.lifetimeSaved, 4));
  const exact = exactSol(tile.balance);
  return { value: sol(tile.balance), figure: tile.balance !== null, sub, paused: tile.paused, ...(exact === undefined ? {} : { exact }) };
}

export function walletsFace(counts: WalletCounts, vault: VaultTile["kind"]): TileFace {
  if (counts.total === 0) return { value: OVERVIEW_COPY.walletsNone, figure: false, sub: OVERVIEW_COPY.walletsNoneLine };
  const { byStatus } = counts;
  // Without a vault there is nothing to link to: "being checked" would promise an answer that cannot come.
  // But a wallet with no permission, or still linked to another vault, will not simply be linked once the
  // vault exists, so those are said first, as the Trading wallets tab says them.
  if (vault === "missing") {
    const sub =
      byStatus["needs-permission"] > 0
        ? OVERVIEW_COPY.walletsNeedPermission(byStatus["needs-permission"])
        : byStatus.elsewhere > 0
          ? OVERVIEW_COPY.walletsElsewhere(byStatus.elsewhere)
          : OVERVIEW_COPY.walletsNeedVault;
    return { value: OVERVIEW_COPY.walletsCount(counts.total), figure: true, sub };
  }
  // Before any link was read, a "0 of 3 linked" would be a 0 nobody read: the count alone, then.
  const value = counts.linkKnown === 0 ? OVERVIEW_COPY.walletsCount(counts.total) : OVERVIEW_COPY.walletsLinked(counts.linked, counts.total);
  const sub =
    byStatus["needs-permission"] > 0
      ? OVERVIEW_COPY.walletsNeedPermission(byStatus["needs-permission"])
      : byStatus["not-linked"] > 0
        ? OVERVIEW_COPY.walletsNotLinked(byStatus["not-linked"])
        : byStatus.checking > 0
          ? OVERVIEW_COPY.walletsChecking(byStatus.checking)
          : byStatus.elsewhere > 0
            ? OVERVIEW_COPY.walletsElsewhere(byStatus.elsewhere)
            : OVERVIEW_COPY.walletsAllLinked;
  return { value, figure: true, sub };
}

export function investingFace(tile: Exclude<InvestingTile, { kind: "loading" }>): TileFace {
  if (tile.kind === "unreadable") return unread;
  if (tile.kind === "needs-vault") return needsVault;
  if (tile.kind === "missing") return { value: OVERVIEW_COPY.investingMissing, figure: false, sub: OVERVIEW_COPY.investingMissingLine };
  return {
    value: tile.enabled ? OVERVIEW_COPY.investingOn : OVERVIEW_COPY.investingPaused,
    figure: false,
    sub: tile.symbols.length === 0 ? OVERVIEW_COPY.investingNothingPicked : tile.symbols.join(" · "),
  };
}

export function withdrawFace(tile: Exclude<WithdrawTile, { kind: "loading" }>): TileFace {
  if (tile.kind === "unreadable") return unread;
  if (tile.kind === "needs-vault") return needsVault;
  const sub = tile.tokens === null ? OVERVIEW_COPY.tokensUnread : tile.tokens > 0 ? OVERVIEW_COPY.withdrawTokens(tile.tokens) : OVERVIEW_COPY.withdrawLine;
  const exact = exactSol(tile.withdrawable);
  return { value: sol(tile.withdrawable), figure: tile.withdrawable !== null, sub, ...(exact === undefined ? {} : { exact }) };
}

const TILE_GRID = "grid gap-3 @md:grid-cols-2";

function Tiles({ overview, onSelect }: { readonly overview: Overview; readonly onSelect: (section: WalletsSection) => void }) {
  const { vault, investing, withdraw } = overview;
  if (overview.read === "loading" || vault.kind === "loading" || investing.kind === "loading" || withdraw.kind === "loading") {
    return (
      // role="status" and a spoken line: an aria-label on a plain div is not read out.
      <div role="status" className={TILE_GRID} aria-busy="true">
        <span className="sr-only">{OVERVIEW_COPY.tilesLoading}</span>
        {(["vault", "trading", "investing", "withdraw"] as const).map((section) => (
          // The tile's three lines at their own heights, so nothing moves when the read answers.
          <div key={section} className="flex flex-col gap-2 rounded-xl border bg-card p-4 shadow-xs">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-7 w-32" />
            <Skeleton className="h-4 w-40 max-w-full" />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className={TILE_GRID}>
      <Tile section="vault" face={vaultFace(vault)} onSelect={onSelect} />
      <Tile section="trading" face={walletsFace(overview.wallets, vault.kind)} onSelect={onSelect} />
      <Tile section="investing" face={investingFace(investing)} onSelect={onSelect} />
      <Tile section="withdraw" face={withdrawFace(withdraw)} onSelect={onSelect} />
    </div>
  );
}

/**
 * A TILE IS ONE NATIVE BUTTON, styled as a card, and never the ui Button: the
 * whole-screen test records every ui Button's label, and a tile is a way into
 * a tab, not an action. Everything inside it is a span, as a button's content
 * must be.
 */
function Tile({ section, face, onSelect }: { readonly section: TileSection; readonly face: TileFace; readonly onSelect: (section: WalletsSection) => void }) {
  const Icon = SECTION_ICON[section];
  return (
    <button
      type="button"
      data-overview-tile={section}
      onClick={() => onSelect(section)}
      className="flex min-w-0 flex-col items-stretch gap-2 rounded-xl border bg-card p-4 text-left shadow-xs transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <span className={cn(LABEL, "flex items-center gap-2")}>
        <Icon className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{WALLETS_COPY.tabs[section]}</span>
        <ChevronRight className="ml-auto size-4 shrink-0" aria-hidden />
      </span>
      <span className="flex flex-wrap items-center gap-2">
        <span className={cn("text-xl leading-7 font-semibold", face.figure && MONO)} title={face.exact}>
          {face.value}
        </span>
        {face.paused === true ? <Badge variant="secondary">{VAULT_COPY.paused}</Badge> : null}
      </span>
      <span className="text-xs text-muted-foreground">{face.sub}</span>
    </button>
  );
}

/**
 * GETTING SET UP: the dashboard's own four steps (LiveNextStep), shown only
 * while one is missing, with one way forward — into the tab of the first step
 * not done.
 */
function SetupSteps({ steps, onSelect }: { readonly steps: readonly [boolean, boolean, boolean, boolean]; readonly onSelect: (section: WalletsSection) => void }) {
  const next = steps.indexOf(false);
  if (next === -1) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{OVERVIEW_COPY.setupTitle}</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2">
          {LIVE_COPY.noVault.steps.map((label, index) => {
            const done = steps[index] === true;
            const section = STEP_SECTIONS[index] ?? "vault";
            return (
              <li key={label} className="flex min-h-8 flex-wrap items-center gap-2 text-sm">
                {done ? <CircleCheck className="size-4 shrink-0 text-emerald-700 dark:text-emerald-400" aria-hidden /> : <Circle className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
                <span className={done ? "text-muted-foreground line-through" : undefined}>{label}</span>
                <span className="sr-only">{done ? OVERVIEW_COPY.stepDone : OVERVIEW_COPY.stepTodo}</span>
                {index === next ? (
                  <Button type="button" variant="outline" size="sm" className="ml-auto" onClick={() => onSelect(section)}>
                    {OVERVIEW_COPY.goTo(WALLETS_COPY.tabs[section])}
                    <ChevronRight aria-hidden />
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
