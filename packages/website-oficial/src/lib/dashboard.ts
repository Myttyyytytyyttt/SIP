/**
 * THE DASHBOARD, FROM REAL ROWS — and the one place that decides it cannot be.
 *
 * `src/mocks/types.ts` is the contract: every panel on `/` types against it and
 * `src/mocks/data.ts` is one deterministic instance of it. This module produces
 * a SECOND instance, from the worker's ledger (packages/worker/src/ledger/
 * schema.ts) and the chain reads in src/lib/vault.ts. Nothing in the contract
 * changes; if a field cannot be derived it is said to be absent, never invented.
 *
 * SERVER-ONLY. It holds a `pg` pool and builds a viem client from
 * ServerConfig.rpcUrl, which carries an API key. A `'use client'` module may
 * `import type` from here and nothing else.
 *
 * THE PAGE MUST NEVER BREAK. Every way this can fail — no DATABASE_URL, a
 * database that will not answer, a pension key with no vault, an RPC on the
 * wrong chain — ends in the same place: the seeded mock, `source: "mock"`, and a
 * notice saying which of those it was. A dashboard that 500s tells the user
 * nothing; a dashboard that says "this is example data because X" tells them
 * everything.
 *
 * SAME DISCIPLINE AS src/lib/vault.ts AND src/lib/skims.ts: a value that could
 * not be read is reported, never rendered as a zero. The two places where this
 * bites hardest are the holdings table (there is no position read on this build
 * of PersonalVault, so the table is empty and the notice says why) and the
 * symbol column (see `symbolFor`).
 */

import { Pool } from "pg";
import { getAddress, type Address, type PublicClient } from "viem";

import type { ServerConfig } from "@/lib/config";
import { shortHex } from "@/lib/format";
import { redactSecrets } from "@/lib/redact";
import {
  createReadClient,
  listTradingAccounts,
  readTradingAccount,
  vaultOfAdmin,
  verifyChain,
} from "@/lib/vault";
import { mock } from "@/mocks";
import type {
  ActivityEvent,
  DashboardMock,
  Holding,
  SavingsDay,
  SavingsPoint,
  SavingsRule,
  SavingsStats,
  Side,
  Ticker,
  Trade,
  Wallet,
} from "@/mocks/types";

// ---------------------------------------------------------------------------
// UNITS
// ---------------------------------------------------------------------------

/**
 * PLACEHOLDER. THE PRICE FEED REPLACES THIS AND NOTHING ELSE.
 *
 * The contract in src/mocks/types.ts is denominated in dollars; the ledger and
 * the chain are denominated in wei. Chain 4663 has no oracle wired into this
 * build and inventing one — a quote scraped at render time, a hard-coded feed
 * address — would produce numbers nobody could reproduce. So every USD figure
 * on a live dashboard is exactly `wei × ETH_USD / 1e18`, this constant is the
 * only conversion in the file, and `noticeFor` says so on screen every time.
 *
 * When a feed exists: delete this, take the rate as an argument, and keep the
 * notice for the moments the feed itself is unavailable.
 */
export const ETH_USD = 3000;

/** Wei are exact; dollars are for display, so the float appears only here. */
const usdFromWei = (wei: bigint): number => round2((Number(wei) / 1e18) * ETH_USD);

const round2 = (value: number): number => Math.round(value * 100) / 100;
const round6 = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;

const DAY_MS = 86_400_000;

/**
 * How far back the daily series and the curve are built. The chart offers 30d
 * and 90d; a year of days is a 365-element array, which is nothing, and it
 * bounds the page for a wallet that has been trading since the beginning.
 */
const MAX_DAYS = 365;

/** How many fills the strip and the feed carry. The strip shows 40, the feed scrolls. */
const RECENT_FILLS = 200;

// ---------------------------------------------------------------------------
// The result
// ---------------------------------------------------------------------------

export interface DashboardLoad {
  /** "mock" means every number below is the seeded example, not this user's. */
  readonly source: "live" | "mock";
  readonly data: DashboardMock;
  /**
   * Why the data is what it is: the reason the mock is showing, or — on a live
   * dashboard — the placeholder rate and anything that could not be read.
   * Rendered by <DashboardSource>; null only when there is nothing to say.
   */
  readonly notice: string | null;
}

function sample(notice: string): DashboardLoad {
  return { source: "mock", data: mock, notice };
}

// ---------------------------------------------------------------------------
// Symbols
// ---------------------------------------------------------------------------

/**
 * THE SYMBOL SLOT CARRIES AN ADDRESS UNTIL A TOKEN CATALOGUE EXISTS.
 *
 * The ledger records token addresses; nothing in this repo maps a 4663 token
 * address to one of the fifteen tickers the page draws marks for. Picking the
 * nearest name would put a real logo — and a real company — on a token that is
 * not it, which is worse than showing no mark at all. So the short address is
 * shown, `/stocks/0x…png` 404s, and the alt text carries the meaning.
 *
 * The cast is the price of saying that through a contract whose `symbol` is a
 * closed union of the tickers the mock trades. When the catalogue arrives it
 * replaces this function and the cast goes with it.
 */
function symbolFor(token: string): Ticker {
  return (token === "native" ? "ETH" : shortHex(token)) as Ticker;
}

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

/**
 * Mirrors src/lib/skims.ts (and, before it, the keeper's ledger-pg.ts): managed
 * Postgres terminates TLS with a certificate the default chain rejects, so
 * encrypt with relaxed validation unless somebody explicitly typed
 * `sslmode=disable`, which no provider hands out.
 */
function sslOptionsFor(connectionString: string): { rejectUnauthorized: false } | false {
  let mode: string | null;
  try {
    mode = new URL(connectionString).searchParams.get("sslmode");
  } catch {
    return { rejectUnauthorized: false };
  }
  return mode?.toLowerCase() === "disable" ? false : { rejectUnauthorized: false };
}

// One pool per server process, rebuilt only if the URL changes. This is a read
// path for one page, not the worker's loop, hence the small ceiling.
let pool: Pool | null = null;
let poolUrl: string | null = null;

function getPool(url: string): Pool {
  if (pool !== null && poolUrl === url) return pool;
  pool?.end().catch(() => {});
  pool = new Pool({
    connectionString: url,
    ssl: sslOptionsFor(url),
    max: 3,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
  pool.on("error", () => {}); // an idle client erroring must not take the server down
  poolUrl = url;
  return pool;
}

/**
 * A reason fit for a browser. pg's messages carry a host, a port, a user name
 * or — from a URL parse — the connection string itself, and this string is
 * rendered in the banner. The Postgres-shaped things are stripped here; the
 * shared redactor then sweeps every URL- and key-shaped run, as on every route.
 */
function safeReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const scrubbed = raw
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g, "[host]")
    .replace(/\b[a-z0-9.-]+\.[a-z]{2,}:\d{1,5}\b/gi, "[host]")
    .replace(/for user "[^"]*"/gi, "for user")
    .replace(/\s+/g, " ")
    .trim();
  const cleaned = redactSecrets(scrubbed);
  if (cleaned === "") return "the ledger could not be read";
  return cleaned.length > 160 ? `${cleaned.slice(0, 159)}…` : cleaned;
}

/** numeric(78,0)::text -> bigint. Anything else is a malformed row, and a malformed row is not a number. */
function toWei(value: unknown, column: string): bigint {
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  throw new Error(`ledger column ${column} is not an integer`);
}

function toCount(value: unknown, column: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  throw new Error(`ledger column ${column} is not a count`);
}

function toText(value: unknown, column: string): string {
  if (typeof value === "string") return value;
  throw new Error(`ledger column ${column} is not text`);
}

/** timestamptz -> ISO 8601 UTC. pg hands back a Date; a driver configured otherwise hands back a string. */
function toIso(value: unknown, column: string): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  throw new Error(`ledger column ${column} is not a timestamp`);
}

interface LedgerFill {
  readonly wallet: string;
  readonly txHash: string;
  readonly at: string;
  readonly side: Side;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly notionalWei: bigint;
}

interface LedgerDay {
  readonly wallet: string;
  /** YYYY-MM-DD, UTC. */
  readonly date: string;
  readonly fills: number;
  readonly notionalWei: bigint;
}

interface LedgerPull {
  readonly id: number;
  readonly txHash: string | null;
  readonly at: string;
  readonly contributionWei: bigint;
}

interface LedgerWallet {
  readonly address: string;
  readonly owedTotalWei: bigint;
  readonly collectedTotalWei: bigint;
  /** The rate the last window actually attested with; null when no window closed yet. */
  readonly lastSavingsBps: number | null;
}

interface Ledger {
  readonly wallets: readonly LedgerWallet[];
  /** Newest first, capped at RECENT_FILLS. */
  readonly recent: readonly LedgerFill[];
  /** Every day of every wallet — the aggregate the totals are built from, not a sample. */
  readonly days: readonly LedgerDay[];
  /** The biggest fill of each wallet, so "Biggest" is a lifetime fact and not a fact about `recent`. */
  readonly biggest: readonly LedgerFill[];
  readonly firstFillAt: string | null;
  /** Newest first, capped; `pullCount` is the real total. */
  readonly pulls: readonly LedgerPull[];
  readonly pullCount: number;
}

type LedgerRead = { readonly ok: true; readonly ledger: Ledger } | { readonly ok: false; readonly reason: string };

/**
 * Everything the page needs about one vault, in five statements on one
 * connection. The totals come from a GROUP BY over ALL fills rather than from
 * the capped list, because a hero figure computed from "the last 200" would be
 * wrong the moment somebody trades more than that — and wrong quietly.
 *
 * `wallet = ANY($2)` rather than a join on the vault: sip_fill's wallets are the
 * sip_wallet rows already read, and the addresses are stored lowercase (the
 * schema CHECKs it), so the array is exact and the plan is an index scan.
 */
async function readLedger(databaseUrl: string, vault: Address): Promise<LedgerRead> {
  const key = vault.toLowerCase();
  try {
    const client = await getPool(databaseUrl).connect();
    try {
      // The last window's savings_bps travels with the wallet: it is what the
      // worker attested with, and the only rate available when the chain read
      // of the account fails.
      const wallets = await client.query(
        `SELECT w.address,
                w.owed_total_wei::text      AS owed_total_wei,
                w.collected_total_wei::text AS collected_total_wei,
                (SELECT n.savings_bps
                   FROM sip_window n
                  WHERE n.wallet = w.address
                  ORDER BY n.id DESC
                  LIMIT 1)                  AS savings_bps
           FROM sip_wallet w
          WHERE lower(w.vault) = $1
          ORDER BY w.address`,
        [key],
      );

      const addresses = wallets.rows.map((row) => toText(row.address, "sip_wallet.address").toLowerCase());
      const empty: Ledger = {
        wallets: [],
        recent: [],
        days: [],
        biggest: [],
        firstFillAt: null,
        pulls: [],
        pullCount: 0,
      };
      if (addresses.length === 0) return { ok: true, ledger: empty };

      const ledgerWallets: LedgerWallet[] = wallets.rows.map((row) => ({
        address: toText(row.address, "sip_wallet.address").toLowerCase(),
        owedTotalWei: toWei(row.owed_total_wei, "sip_wallet.owed_total_wei"),
        collectedTotalWei: toWei(row.collected_total_wei, "sip_wallet.collected_total_wei"),
        lastSavingsBps: row.savings_bps === null || row.savings_bps === undefined ? null : toCount(row.savings_bps, "sip_window.savings_bps"),
      }));

      // THE FILL HAS NO BLOCK TIME. sip_fill records block_l2 and created_at —
      // when the observer wrote the row — and nothing else about time. Reading
      // the block's own timestamp would be one RPC call per row for a feed that
      // is already ordered by block. So created_at is the timestamp on screen,
      // and it is a few minutes late by construction, never wrong by a day.
      const recent = await client.query(
        `SELECT wallet, tx_hash, created_at, side, token_in, token_out, notional_wei::text AS notional_wei
           FROM sip_fill
          WHERE wallet = ANY($1::text[])
          ORDER BY block_l2 DESC, tx_index DESC
          LIMIT ${RECENT_FILLS}`,
        [addresses],
      );

      const days = await client.query(
        `SELECT wallet,
                to_char((created_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day,
                count(*)::int                                                AS fills,
                sum(notional_wei)::text                                      AS notional_wei
           FROM sip_fill
          WHERE wallet = ANY($1::text[])
          GROUP BY 1, 2`,
        [addresses],
      );

      // One row per wallet, so the comparison that decides "biggest" can apply
      // each wallet's own rate rather than assuming they share one.
      const biggest = await client.query(
        `SELECT DISTINCT ON (wallet)
                wallet, tx_hash, created_at, side, token_in, token_out, notional_wei::text AS notional_wei
           FROM sip_fill
          WHERE wallet = ANY($1::text[])
          ORDER BY wallet, notional_wei DESC, block_l2 ASC`,
        [addresses],
      );

      const first = await client.query(
        `SELECT min(created_at) AS first_at FROM sip_fill WHERE wallet = ANY($1::text[])`,
        [addresses],
      );

      // A pull that was only simulated (DRY_RUN) or never attempted (SKIPPED)
      // moved no money, so it is not an event in anybody's pension.
      const pulls = await client.query(
        `SELECT p.id, p.tx_hash, p.created_at, p.contribution_wei::text AS contribution_wei,
                count(*) OVER ()                                        AS total
           FROM sip_pull p
           JOIN sip_window w ON w.id = p.window_id
          WHERE lower(w.vault) = $1
            AND p.outcome = 'SENT'
          ORDER BY p.created_at DESC
          LIMIT 200`,
        [key],
      );

      const asFill = (row: Record<string, unknown>): LedgerFill => ({
        wallet: toText(row.wallet, "sip_fill.wallet").toLowerCase(),
        txHash: toText(row.tx_hash, "sip_fill.tx_hash"),
        at: toIso(row.created_at, "sip_fill.created_at"),
        side: toText(row.side, "sip_fill.side") === "sell" ? "sell" : "buy",
        tokenIn: toText(row.token_in, "sip_fill.token_in"),
        tokenOut: toText(row.token_out, "sip_fill.token_out"),
        notionalWei: toWei(row.notional_wei, "sip_fill.notional_wei"),
      });

      const firstRow = first.rows[0];
      const firstAt = firstRow?.first_at ?? null;

      return {
        ok: true,
        ledger: {
          wallets: ledgerWallets,
          recent: recent.rows.map(asFill),
          days: days.rows.map((row) => ({
            wallet: toText(row.wallet, "sip_fill.wallet").toLowerCase(),
            date: toText(row.day, "sip_fill.created_at"),
            fills: toCount(row.fills, "count(*)"),
            notionalWei: toWei(row.notional_wei, "sum(sip_fill.notional_wei)"),
          })),
          biggest: biggest.rows.map(asFill),
          firstFillAt: firstAt === null ? null : toIso(firstAt, "min(sip_fill.created_at)"),
          pulls: pulls.rows.map((row) => ({
            id: toCount(row.id, "sip_pull.id"),
            txHash: row.tx_hash === null || row.tx_hash === undefined ? null : toText(row.tx_hash, "sip_pull.tx_hash"),
            at: toIso(row.created_at, "sip_pull.created_at"),
            contributionWei: toWei(row.contribution_wei, "sip_pull.contribution_wei"),
          })),
          pullCount: pulls.rows.length === 0 ? 0 : toCount(pulls.rows[0]?.total, "count(*) OVER ()"),
        },
      };
    } finally {
      client.release();
    }
  } catch (error) {
    return { ok: false, reason: safeReason(error) };
  }
}

// ---------------------------------------------------------------------------
// The chain side: the rate, and what the wallet is worth
// ---------------------------------------------------------------------------

interface ChainSide {
  /** Lowercase trading-wallet address -> its savingsBps, as the vault holds it today. */
  readonly rates: ReadonlyMap<string, number>;
  /** PersonalVault refuses to pull less than this; see `thresholdUsd` below. */
  readonly minContributionWei: bigint | null;
  readonly balanceWei: bigint | null;
  /** Everything that could not be read, phrased for the banner. */
  readonly problems: readonly string[];
}

async function readChainSide(
  client: PublicClient,
  config: ServerConfig,
  vault: Address,
  primary: Address | null,
): Promise<ChainSide> {
  const rates = new Map<string, number>();
  const problems: string[] = [];
  let minContributionWei: bigint | null = null;
  let balanceWei: bigint | null = null;

  const accounts = await listTradingAccounts(client, config, vault);
  if (!accounts.ok) {
    problems.push(`the vault's trading wallets could not be listed (${accounts.error})`);
  } else {
    for (const account of accounts.value) {
      const view = await readTradingAccount(client, vault, account);
      if (!view.ok) {
        problems.push(`${shortHex(account)} could not be read (${view.error})`);
        continue;
      }
      rates.set(account.toLowerCase(), view.value.savingsBps);
      // Every account carries one; the smallest is the one that actually gates.
      const candidate = view.value.policy.minContributionWei;
      minContributionWei = minContributionWei === null || candidate < minContributionWei ? candidate : minContributionWei;
    }
  }

  if (primary !== null) {
    try {
      balanceWei = await client.getBalance({ address: primary });
    } catch {
      // The balance is a nicety on the wallet card; its absence is not worth a
      // line in the banner, and a fabricated zero would read as an empty wallet.
      balanceWei = null;
    }
  }

  return { rates, minContributionWei, balanceWei, problems };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** notional × rate, in wei, before anything becomes a float. */
const savedWei = (notionalWei: bigint, bps: number): bigint => (notionalWei * BigInt(Math.max(0, Math.round(bps)))) / 10_000n;

/**
 * The wallet whose trades describe this pension: the one that moved the most
 * volume. The wallet card holds one address and the rule shows one rate, so
 * both are decided here, once, and the balance is read for the same address the
 * card names.
 */
function busiestWallet(ledger: Ledger): string | null {
  const volume = new Map<string, bigint>();
  for (const day of ledger.days) {
    volume.set(day.wallet, (volume.get(day.wallet) ?? 0n) + day.notionalWei);
  }
  return (
    [...ledger.wallets]
      .sort((left, right) => {
        const delta = (volume.get(right.address) ?? 0n) - (volume.get(left.address) ?? 0n);
        return delta > 0n ? 1 : delta < 0n ? -1 : left.address.localeCompare(right.address);
      })
      .at(0)?.address ?? null
  );
}

function buildDashboard(ledger: Ledger, chain: ChainSide, vault: Address, nowIso: string): DashboardMock {
  const rateOf = (wallet: string): number => {
    const onchain = chain.rates.get(wallet);
    if (onchain !== undefined) return onchain;
    return ledger.wallets.find((row) => row.address === wallet)?.lastSavingsBps ?? 0;
  };

  const primary = busiestWallet(ledger);

  const rule: SavingsRule = {
    rateBps: primary === null ? 0 : rateOf(primary),
    /**
     * There is no investment threshold on chain 4663 yet — Phase 0 pulls into
     * the vault and stops there. What DOES gate the pile is the account's
     * `minContributionWei`: below it the executor will not pull at all. That is
     * the honest live reading of "the pile moves once it reaches this".
     */
    thresholdUsd: chain.minContributionWei === null ? 0 : usdFromWei(chain.minContributionWei),
    // The basket lives in a contract this build does not have; an empty list is
    // "we do not know what it invests in", which is the truth.
    targets: [],
    paused: false,
  };

  // ── trades ──────────────────────────────────────────────────────────────
  //
  // A buy pays cash for `token_out`; a sell hands over `token_in`. The other
  // leg is the cash leg, which is what the notional is already denominated in.
  const filled = ledger.recent.map((fill) => {
    const traded = fill.side === "buy" ? fill.tokenOut : fill.tokenIn;
    const other = fill.side === "buy" ? fill.tokenIn : fill.tokenOut;
    const rateBps = rateOf(fill.wallet);
    const trade: Trade = {
      id: `${fill.wallet}:${fill.txHash}`,
      at: fill.at,
      symbol: symbolFor(traded === "native" ? other : traded),
      side: fill.side,
      notionalUsd: usdFromWei(fill.notionalWei),
      savedUsd: usdFromWei(savedWei(fill.notionalWei, rateBps)),
      txHash: fill.txHash,
    };
    return { trade, rateBps };
  });
  const trades: Trade[] = filled.map((row) => row.trade);

  // ── activity: the fills, and the pulls that carried their slices in ──────
  const activity: ActivityEvent[] = [
    ...filled.map(({ trade, rateBps }) => ({
      kind: "trade" as const,
      id: `trade:${trade.id}`,
      at: trade.at,
      txHash: trade.txHash,
      tradeId: trade.id,
      symbol: trade.symbol,
      side: trade.side,
      notionalUsd: trade.notionalUsd,
      savedUsd: trade.savedUsd,
      rateBps,
    })),
    /**
     * A pull is the pension actually receiving money, which is the event the
     * feed's "invested" row was built for. It buys nothing yet — Phase 0 moves
     * ETH into the vault and leaves it there — so the row describes the ETH
     * itself: `shares` is the amount of ETH, `priceUsd` is the rate it was
     * valued at. Nothing here pretends a target was bought.
     */
    ...ledger.pulls.map((pull) => ({
      kind: "invested" as const,
      id: `pull:${pull.id}`,
      at: pull.at,
      txHash: pull.txHash ?? "",
      symbol: symbolFor("native"),
      shares: round6(Number(pull.contributionWei) / 1e18),
      priceUsd: ETH_USD,
      amountUsd: usdFromWei(pull.contributionWei),
    })),
  ].sort((left, right) => right.at.localeCompare(left.at));

  // ── days and the curve ──────────────────────────────────────────────────
  //
  // One bucket per UTC day from the first fill to today, gaps included: the
  // chart's x-axis and every "last N days" figure below read positionally, so a
  // missing day would silently shift a week into a fortnight.
  const savedByDay = new Map<string, bigint>();
  const volumeByDay = new Map<string, bigint>();
  const fillsByDay = new Map<string, number>();
  for (const day of ledger.days) {
    const bps = rateOf(day.wallet);
    savedByDay.set(day.date, (savedByDay.get(day.date) ?? 0n) + savedWei(day.notionalWei, bps));
    volumeByDay.set(day.date, (volumeByDay.get(day.date) ?? 0n) + day.notionalWei);
    fillsByDay.set(day.date, (fillsByDay.get(day.date) ?? 0) + day.fills);
  }

  const nowMs = Date.parse(nowIso);
  const todayMs = Date.UTC(
    new Date(nowMs).getUTCFullYear(),
    new Date(nowMs).getUTCMonth(),
    new Date(nowMs).getUTCDate(),
  );
  const earliest = [...savedByDay.keys()].sort().at(0);
  const firstMs = earliest === undefined ? todayMs : Date.parse(`${earliest}T00:00:00.000Z`);
  const startMs = Math.max(firstMs, todayMs - (MAX_DAYS - 1) * DAY_MS);

  const days: SavingsDay[] = [];
  for (let ms = startMs; ms <= todayMs; ms += DAY_MS) {
    const date = isoDay(ms);
    days.push({
      date,
      savedUsd: usdFromWei(savedByDay.get(date) ?? 0n),
      volumeUsd: usdFromWei(volumeByDay.get(date) ?? 0n),
      trades: fillsByDay.get(date) ?? 0,
    });
  }

  // The curve opens on the day before the first save, at zero, so the area has
  // a baseline to rise from — the same shape the mock produces.
  const curve: SavingsPoint[] = [{ date: isoDay(startMs - DAY_MS), total: 0 }];
  let running = 0;
  for (const day of days) {
    running = round2(running + day.savedUsd);
    curve.push({ date: day.date, total: running });
  }

  // ── totals ──────────────────────────────────────────────────────────────
  const totalSavedUsd = running;
  const volumeUsd = round2(days.reduce((sum, day) => sum + day.volumeUsd, 0));
  const sumLast = (count: number, pick: (day: SavingsDay) => number): number =>
    round2(days.slice(-count).reduce((sum, day) => sum + pick(day), 0));
  const fills = days.reduce((sum, day) => sum + day.trades, 0);

  const owedWei = ledger.wallets.reduce((sum, row) => sum + row.owedTotalWei, 0n);
  const collectedWei = ledger.wallets.reduce((sum, row) => sum + row.collectedTotalWei, 0n);
  const pendingWei = owedWei > collectedWei ? owedWei - collectedWei : 0n;

  /**
   * WHAT "HOLDINGS" MEANS BEFORE THERE IS AN INVESTMENT PATH. The pension holds
   * exactly what has been pulled into the vault: ETH, uninvested. So
   * `holdingsUsd` is the collected total and `costUsd` is the same number —
   * ETH valued at the rate it was counted at cannot have moved against itself,
   * so `unrealizedUsd` is zero and says so rather than inventing a gain. The
   * holdings TABLE stays empty (there is no position read on this build of
   * PersonalVault) and the notice explains that; the identities the panels rely
   * on — pension = holdings + pending, unrealized = holdings − cost — hold.
   */
  const holdingsUsd = usdFromWei(collectedWei);
  const pendingUsd = usdFromWei(pendingWei);
  const holdings: readonly Holding[] = [];

  const best = ledger.biggest.reduce<{ id: string; savedUsd: number } | null>((top, fill) => {
    const saved = usdFromWei(savedWei(fill.notionalWei, rateOf(fill.wallet)));
    return top === null || saved > top.savedUsd ? { id: `${fill.wallet}:${fill.txHash}`, savedUsd: saved } : top;
  }, null);

  let currentStreakDays = 0;
  {
    let index = days.length - 1;
    // Today is not over; an empty today does not break the streak.
    if (days[index]?.savedUsd === 0) index -= 1;
    for (; index >= 0; index -= 1) {
      if ((days[index]?.savedUsd ?? 0) === 0) break;
      currentStreakDays += 1;
    }
  }
  let longestStreakDays = 0;
  let run = 0;
  for (const day of days) {
    run = day.savedUsd > 0 ? run + 1 : 0;
    if (run > longestStreakDays) longestStreakDays = run;
  }

  const stats: SavingsStats = {
    totalSavedUsd,
    pensionValueUsd: round2(holdingsUsd + pendingUsd),
    holdingsUsd,
    costUsd: holdingsUsd,
    unrealizedUsd: 0,
    pendingUsd,
    thresholdUsd: rule.thresholdUsd,
    savedTodayUsd: sumLast(1, (day) => day.savedUsd),
    savedThisWeekUsd: sumLast(7, (day) => day.savedUsd),
    savedThisMonthUsd: sumLast(30, (day) => day.savedUsd),
    volumeUsd,
    volumeThisMonthUsd: sumLast(30, (day) => day.volumeUsd),
    trades: fills,
    avgSavedPerTradeUsd: fills > 0 ? round2(totalSavedUsd / fills) : 0,
    bestTradeSavedUsd: best?.savedUsd ?? 0,
    bestTradeId: best?.id ?? null,
    investments: ledger.pullCount,
    activeDays: days.filter((day) => day.savedUsd > 0).length,
    currentStreakDays,
    longestStreakDays,
    firstSaveAt: ledger.firstFillAt,
    projectedYearUsd: days.length > 0 ? round2((totalSavedUsd / days.length) * 365) : 0,
  };

  // ── the wallet card ─────────────────────────────────────────────────────
  //
  // The card holds one address (see busiestWallet); with no trading wallet
  // observed yet the vault itself is the only address there is to name.
  const wallet: Wallet = {
    address: primary === null ? vault : getAddress(primary),
    network: "Robinhood Chain",
    label:
      primary === null
        ? "Pension vault"
        : ledger.wallets.length > 1
          ? `Trading wallet 1 of ${ledger.wallets.length}`
          : "Trading wallet",
    balanceUsd: chain.balanceWei === null ? 0 : usdFromWei(chain.balanceWei),
  };

  return { now: nowIso, wallet, rule, stats, curve, days, holdings, trades, activity };
}

/**
 * What the banner says on a live dashboard. The placeholder rate leads, because
 * every figure on the page depends on it and nothing else on the page admits it.
 */
function noticeFor(ledger: Ledger, chain: ChainSide): string {
  const parts = [
    // No toLocale* anywhere in a render path, not even on the server: see WEB_WALLETS.md §0.3.
    `Amounts are converted at a placeholder rate of $${ETH_USD} per ETH — this deployment has no price feed yet.`,
    "Nothing is invested yet — what is collected sits in the vault as ETH — so the holdings table is empty and the threshold shown is the smallest amount the vault will pull.",
  ];
  if (ledger.wallets.length === 0) {
    parts.push("No trading wallet of this pension has been observed yet.");
  } else if (ledger.days.length === 0) {
    parts.push("No fills have been recorded for this pension yet.");
  }
  if (chain.problems.length > 0) {
    parts.push(`Some readings are missing: ${chain.problems.join("; ")}.`);
  }
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

/**
 * One dashboard for one pension key. `admin` is the pension key (the vault
 * ADMIN, never a trading wallet); null means nobody is identified, which is the
 * ordinary case on a page nobody has connected a wallet to.
 *
 * Never throws and never returns a half-built dashboard: every failure below
 * comes back as the mock plus the reason.
 */
export async function loadDashboard(config: ServerConfig, admin: Address | null): Promise<DashboardLoad> {
  if (admin === null) {
    return sample("No pension key is connected, so this is example data. Connect one on the wallets page to see your own.");
  }
  if (config.databaseUrl === null) {
    return sample("The worker's ledger is not configured on this deployment (no DATABASE_URL), so this is example data.");
  }

  const client = createReadClient(config);
  // Once, before anything else: an RPC serving another chain answers every
  // question below with a confident zero. See verifyChain.
  const chainId = await verifyChain(client);
  if (!chainId.ok) {
    return sample(`${chainId.error} This is example data.`);
  }

  const vault = await vaultOfAdmin(client, config, admin);
  if (!vault.ok) {
    return sample(`The vault of this pension key could not be read (${vault.error}), so this is example data.`);
  }
  if (vault.value === null) {
    return sample("This pension key has no vault yet, so this is example data. Create one on the wallets page.");
  }

  const read = await readLedger(config.databaseUrl, vault.value);
  if (!read.ok) {
    return sample(`The worker's ledger could not be read (${read.reason}), so this is example data.`);
  }

  const ledger = read.ledger;
  const primary = busiestWallet(ledger);
  const chain = await readChainSide(client, config, vault.value, primary === null ? null : getAddress(primary));

  return {
    source: "live",
    data: buildDashboard(ledger, chain, vault.value, new Date().toISOString()),
    notice: noticeFor(ledger, chain),
  };
}
