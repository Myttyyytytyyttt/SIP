/**
 * THE PUBLIC DASHBOARD'S NUMBERS: every SaverFi pension added up, and what this
 * page is willing to claim about each total.
 *
 * ONE MODEL, BUILT ONE WAY. The live page and the sample both hand a payload in
 * the keeper's wire shape to buildGlobalStats; the sample is not a second code
 * path that could drift from the real one, and the `source` it is built with is
 * what prints the "Sample data" badge — never the URL.
 *
 * THREE KINDS OF "NO NUMBER", KEPT APART:
 *   * not published yet — the keeper does not serve this figure (the daily
 *     series, what pensions invested, the split by mode). Reason
 *     "not-served-yet"; the page says so once, not in a wall of empty cards.
 *   * could not be read — the source failed, or a field was missing or
 *     malformed. A dash with a reason worded for a visitor.
 *   * a true zero — printed as 0 only where the payload proves it.
 *
 * WHY NOT LeaderboardData. parseLeaderboard rebuilds the board from the keys it
 * knows: a missing pension count comes back as 0 (src/lib/leaderboard.ts) and
 * the optional `stats` block a newer keeper adds is dropped. Right for a
 * ranking, wrong for a page of totals. So the counts and `stats` are read here
 * from the RAW body, and parseLeaderboard is used only as the test of "this is
 * a keeper's leaderboard at all" and for its checked rows.
 *
 * AMOUNTS ARE DECIMAL STRINGS (lamports, USDC raw) and their arithmetic is
 * BigInt. The model holds strings, safe integers, booleans and null only: it
 * crosses to the browser as props, and JSON round-trips it unchanged.
 *
 * Pure and client-safe: no clock, no "server-only", nothing from the sample.
 */

import { usdcRawForLamports } from "@/lib/amounts";
import { parseLeaderboard, type LeaderboardBodyResult, type LeaderboardEntry, type LeaderboardFailure } from "@/lib/leaderboard";

export type Reason =
  /** The keeper does not publish this figure yet. */
  | "not-served-yet"
  /** This deployment has no address for the settlement service. */
  | "source-unconfigured"
  /** The address is set but is not usable. */
  | "source-misconfigured"
  /** No answer: refused, unknown host, or out of time. */
  | "source-unreachable"
  /** It answered that it has nothing to give yet (503). */
  | "source-not-ready"
  /** Any other refusal. */
  | "source-refused"
  /** It answered, but not with anything this build understands. */
  | "source-not-understood"
  /** The answer was understood; this one field was missing or malformed. */
  | "field-unreadable"
  /** This deployment cannot read the chain, so it has no SOL price. */
  | "price-unconfigured"
  /** The price read failed or timed out. */
  | "price-unread";

export type Stat<T> = { readonly kind: "known"; readonly value: T } | { readonly kind: "unavailable"; readonly reason: Reason };

export const known = <T>(value: T): Stat<T> => ({ kind: "known", value });
export const unavailable = (reason: Reason): Stat<never> => ({ kind: "unavailable", reason });

/** Decimal digits: lamports or USDC raw units. Never a number. */
export type Raw = string;
/** A UTC calendar day, "YYYY-MM-DD". */
export type UtcDay = string;

/**
 * "complete": everything the settlement history recorded is in the figure.
 * NOT "exact": the history is a best-effort mirror of the chain, and a write it
 * lost is not in any total. "at-least": the read was cut, so the true figure is
 * higher.
 */
export type Bound = "complete" | "at-least";

export interface Counted {
  readonly count: number;
  readonly bound: Bound;
}

export interface SavedTotal {
  readonly lamports: Raw;
  readonly bound: Bound;
}

/**
 * What the trading behind the settlements moved. ALWAYS APPROXIMATE: it is a
 * usage measure made for ranking, measured by two different rules depending on
 * the pension's mode, and it can over-count as well as under-count — so it is
 * never "at least". `partial` says some pensions are not in it.
 */
export interface TradedTotal {
  readonly lamports: Raw;
  readonly partial: boolean;
}

// ── Phase 2: the optional `stats` block, PARSED ───────────────────────────────

/** One mode on one day. */
export interface ModeCell {
  readonly savedRaw: Raw;
  /** What that day's settlements were charged on, approximate; null when not sent. */
  readonly tradedRaw: Raw | null;
  readonly settlements: number;
  /** Settlements that put something aside; null when not sent. */
  readonly payingSettlements: number | null;
}

export interface StatsDay {
  readonly day: UtcDay;
  /** Null on a served day: that mode had no settlement that day — a true zero. */
  readonly profit: ModeCell | null;
  readonly volume: ModeCell | null;
  /** Distinct pensions settled that day, ACROSS modes. Per-mode counts do not add up to it. */
  readonly pensions: number | null;
}

export interface InvestedDay {
  readonly day: UtcDay;
  /** The asset's mint address: the page names it from the catalogue. */
  readonly mint: string;
  /** USDC raw units spent. */
  readonly spentRaw: Raw;
  readonly buys: number;
}

export interface ModeTotals {
  readonly savedRaw: Raw;
  readonly settlements: number;
  readonly pensions: number | null;
}

export interface StatsBlock {
  /**
   * Members the keeper SENT that did not parse ("totals.savedRaw", "byMode",
   * "daily"…). Absent and unreadable are different claims: the first is "not
   * published yet", the second "this figure was missing from the answer".
   */
  readonly unreadable: readonly string[];
  /** When the service read these figures: a block it kept from an earlier read is older than the rankings beside it. */
  readonly computedAt: string | null;
  readonly totals: {
    readonly savedRaw: Raw | null;
    readonly tradedRaw: Raw | null;
    readonly settlements: number | null;
    readonly payingSettlements: number | null;
    readonly pensions: number | null;
  } | null;
  /**
   * false: the service says its bounded read was NOT cut — the only answer
   * that lets a total be called complete. true, or not said: lower bounds.
   */
  readonly truncated: boolean | null;
  readonly byMode: { readonly profit: ModeTotals | null; readonly volume: ModeTotals | null } | null;
  /** Ascending, one row per day. `dropped`: rows that did not parse. */
  readonly daily: { readonly rows: readonly StatsDay[]; readonly dropped: number } | null;
  readonly invested: {
    readonly spentRaw: Raw | null;
    readonly buys: number | null;
    /** Each asset all time, read whole by the service; null when not sent. */
    readonly byAsset: readonly AssetTotal[] | null;
    readonly daily: { readonly rows: readonly InvestedDay[]; readonly dropped: number } | null;
  } | null;
}

/** A series as a chart receives it: `partial` when some days could not be read. */
export interface Served<Row> {
  readonly rows: readonly Row[];
  /** Some days may be missing from `rows`: a day with no row is then unknown, not zero. */
  readonly partial: boolean;
}

/** What a pension can choose to buy: the app's own list, not the chain. */
export interface Shelf {
  readonly offered: readonly string[];
  readonly listed: number;
  /** mint -> symbol, for every catalogue entry. */
  readonly symbolOf: Readonly<Record<string, string>>;
  /** Every catalogue entry, in the catalogue's order, and whether a pension can pick it today. */
  readonly assets: readonly { readonly mint: string; readonly symbol: string; readonly name: string; readonly offered: boolean }[];
}

export interface GlobalStatsModel {
  readonly source: "live" | "sample";
  readonly feed: { readonly ok: true; readonly contract: "totals-only" | "with-stats" } | { readonly ok: false; readonly reason: Reason };
  /** When the keeper last added it all up. */
  readonly computedAt: Stat<string>;
  /**
   * The last UTC day the daily series cover: the day the `stats` block was
   * read (its own computedAt, else the payload's). Charts end here — a later
   * day is not a quiet one, it is one nobody has read yet. Null without series.
   */
  readonly seriesEnd: UtcDay | null;
  /** When the `stats` block itself was read: older than computedAt when the service kept a block it could not re-read. */
  readonly statsComputedAt: string | null;
  /**
   * The first day is the history's first, not just the oldest day a cut read
   * reached: only then can a page say "since" or "from" it.
   */
  readonly firstDayProven: boolean;
  /** known(null): the payload says there is no settlement yet. */
  readonly firstDay: Stat<UtcDay | null>;
  readonly lastDay: Stat<UtcDay | null>;
  readonly saved: Stat<SavedTotal>;
  readonly traded: Stat<TradedTotal>;
  /** Pensions with at least one settlement: not users, not pensions created. */
  readonly pensions: Stat<Counted>;
  /** Every settlement, both modes, the ones that put nothing aside included. */
  readonly settlements: Stat<Counted>;
  /** Settlements that put something aside. */
  readonly payingSettlements: Stat<Counted>;
  /**
   * SOL put aside per settlement that put something aside — computed only when
   * both come from the same read. known(null): none has put anything aside yet.
   */
  readonly average: Stat<SavedTotal | null>;
  readonly invested: Stat<{
    readonly usdcRaw: Raw;
    readonly buys: number | null;
    readonly bound: Bound;
    /** Null when the split per asset is not known (not sent, and no whole daily series to rebuild it from). */
    readonly byAsset: readonly AssetTotal[] | null;
  }>;
  /** A side that is null had no settlement in that mode: a true zero. */
  readonly byMode: Stat<{ readonly profit: ModeTotals | null; readonly volume: ModeTotals | null; readonly bound: Bound }>;
  /** USDC raw per 1 SOL. */
  readonly solPrice: Stat<Raw>;
  readonly shelf: Shelf;
  readonly daily: Stat<Served<StatsDay>>;
  readonly investedDaily: Stat<Served<InvestedDay>>;
  /**
   * The leaderboard's all-time top, in its own order (by score): the pensions
   * a visitor can check one by one. The board is cut to 100 by the keeper.
   */
  readonly leaders: Stat<readonly Leader[]>;
}

/** What pensions spent on one asset, all time. */
export interface AssetTotal {
  readonly mint: string;
  readonly usdcRaw: Raw;
  readonly buys: number;
}

/** One pension as the all-time board ranks it. */
export interface Leader {
  readonly rank: number;
  /** The pension's vault address. */
  readonly subject: string;
  readonly savedRaw: Raw;
  /** Approximate; null from a keeper too old to send it. */
  readonly tradedRaw: Raw | null;
  readonly settlements: number;
  readonly activeDays: number;
}

/** How many of the board's pensions the page lists. */
export const LEADERS_SHOWN = 8;

// ── Readers: a network answer is not a type ──────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Digits only (1-39 of them, as rawFrom accepts). A JSON number is refused: it may already have been rounded. */
export function readDigits(value: unknown): Raw | null {
  return typeof value === "string" && /^[0-9]{1,39}$/.test(value) ? value : null;
}

/** A count: a safe, non-negative JSON integer. A string "1" is not a count. */
export function readCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** "YYYY-MM-DD" that is a real calendar day: "2026-02-30" is refused. */
export function readUtcDay(value: unknown): UtcDay | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10) === value ? value : null;
}

/**
 * A UTC ISO timestamp ("2026-10-06T18:00:00.000Z"), returned in Date's own
 * form. Only the Z form: the charts take their last day from its first ten
 * characters, and an offset or a bare number would put that day elsewhere.
 */
export function readInstant(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?Z$/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function sumRaw(values: readonly Raw[]): Raw {
  return values.reduce((total, value) => total + BigInt(value), 0n).toString();
}

/** Whole UTC days from `from` to `to`. */
export function daysBetween(from: UtcDay, to: UtcDay): number {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000);
}

// ── What a sum over the board may claim ──────────────────────────────────────

/**
 * The keeper reads at most this many (pension, day) groups, newest first
 * (LEADERBOARD_DAY_LIMIT in packages/solana-keeper/src/read-model.ts; a test
 * holds the two equal). Past it the oldest days are silently left out.
 */
export const HISTORY_GROUP_LIMIT = 50_000;

/**
 * EVERY PENSION IS ON THE BOARD: as many distinct rows as pensions counted.
 * Needs no copy of the keeper's 100-row cut — equal counts means nobody was
 * cut and no row was dropped by the parser. It can say "no" when the sum is in
 * fact whole (a pension whose every day put nothing aside is counted but not
 * ranked), and that direction is the safe one.
 */
export function boardCoversEveryone(rows: readonly LeaderboardEntry[], pensions: number | null): boolean {
  return pensions !== null && rows.length === pensions && new Set(rows.map((row) => row.subject)).size === rows.length;
}

/**
 * THE KEEPER'S BOUNDED READ CANNOT HAVE BEEN FULL. It read at most one group
 * per pension per day, so it read at most pensions × days-in-the-span groups;
 * under the limit, nothing was cut. Unknown inputs prove nothing.
 */
export function historyWindowProvablyOpen(pensions: number | null, firstDay: UtcDay | null, lastDay: UtcDay | null): boolean {
  if (pensions === 0) return true;
  if (pensions === null || firstDay === null || lastDay === null) return false;
  const span = daysBetween(firstDay, lastDay);
  // A first day after the last proves nothing about anything.
  if (span < 0) return false;
  return BigInt(pensions) * BigInt(span + 1) < BigInt(HISTORY_GROUP_LIMIT);
}

/**
 * The two totals from TODAY'S payload: the all-time board, summed. Only the
 * `total` board: on the volume board `amountRaw` is what was traded, not saved.
 */
export function totalsFromBoard(
  rows: readonly LeaderboardEntry[],
  pensions: number | null,
  firstDay: UtcDay | null,
  lastDay: UtcDay | null,
): { readonly saved: Stat<SavedTotal>; readonly traded: Stat<TradedTotal> } {
  const whole = boardCoversEveryone(rows, pensions) && historyWindowProvablyOpen(pensions, firstDay, lastDay);
  if (rows.length === 0) {
    // An empty board is "nothing yet" only when the count says nobody settled.
    if (pensions === 0) return { saved: known({ lamports: "0", bound: "complete" }), traded: known({ lamports: "0", partial: false }) };
    return { saved: unavailable("field-unreadable"), traded: unavailable("field-unreadable") };
  }
  const saved = known<SavedTotal>({ lamports: sumRaw(rows.map((row) => row.amountRaw)), bound: whole ? "complete" : "at-least" });
  const measured = rows.flatMap((row) => (row.volumeRaw === undefined ? [] : [row.volumeRaw]));
  const traded: Stat<TradedTotal> =
    measured.length === 0 ? unavailable("field-unreadable") : known({ lamports: sumRaw(measured), partial: !whole || measured.length < rows.length });
  return { saved, traded };
}

// ── The optional `stats` block (Phase 2) ─────────────────────────────────────

/** How many daily rows a page keeps. More is the newest this many, and the series says it is partial. */
export const MAX_DAILY_ROWS = 2_000;

function readModeCell(value: unknown): ModeCell | null {
  if (!isRecord(value)) return null;
  const savedRaw = readDigits(value["savedRaw"]);
  const settlements = readCount(value["settlements"]);
  if (savedRaw === null || settlements === null) return null;
  return { savedRaw, tradedRaw: readDigits(value["tradedRaw"]), settlements, payingSettlements: readCount(value["payingSettlements"]) };
}

function readModeTotals(value: unknown): ModeTotals | null {
  if (!isRecord(value)) return null;
  const savedRaw = readDigits(value["savedRaw"]);
  const settlements = readCount(value["settlements"]);
  if (savedRaw === null || settlements === null) return null;
  return { savedRaw, settlements, pensions: readCount(value["pensions"]) };
}

/** Ascending by `keyOf`, unparseable and repeated rows dropped and counted, at most MAX_DAILY_ROWS (the newest). */
function readRows<Row>(value: unknown, parse: (row: unknown) => Row | null, keyOf: (row: Row) => string): { readonly rows: readonly Row[]; readonly dropped: number } | null {
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  const rows: Row[] = [];
  let dropped = 0;
  for (const raw of value) {
    const row = parse(raw);
    if (row === null || seen.has(keyOf(row))) {
      dropped += 1;
      continue;
    }
    seen.add(keyOf(row));
    rows.push(row);
  }
  rows.sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));
  const kept = rows.slice(-MAX_DAILY_ROWS);
  return { rows: kept, dropped: dropped + (rows.length - kept.length) };
}

function readStatsDay(value: unknown): StatsDay | null {
  if (!isRecord(value)) return null;
  const day = readUtcDay(value["day"]);
  if (day === null) return null;
  const profit = readModeCell(value["profit"]);
  const volume = readModeCell(value["volume"]);
  // A mode the row names but that does not parse is not a zero: the row goes.
  if ((value["profit"] !== undefined && profit === null) || (value["volume"] !== undefined && volume === null)) return null;
  if (profit === null && volume === null) return null;
  return { day, profit, volume, pensions: readCount(value["pensions"]) };
}

/** The per-asset totals: every row must parse, or the list is unreadable — a missing asset would shift every share. */
function readAssetTotals(value: unknown): readonly AssetTotal[] | null {
  if (!Array.isArray(value)) return null;
  const rows: AssetTotal[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) return null;
    const mint = typeof raw["mint"] === "string" && raw["mint"] !== "" ? raw["mint"] : null;
    const usdcRaw = readDigits(raw["spentRaw"]);
    const buys = readCount(raw["buys"]);
    if (mint === null || usdcRaw === null || buys === null) return null;
    rows.push({ mint, usdcRaw, buys });
  }
  return rows;
}

function readInvestedDay(value: unknown): InvestedDay | null {
  if (!isRecord(value)) return null;
  const day = readUtcDay(value["day"]);
  const mint = typeof value["mint"] === "string" && value["mint"] !== "" ? value["mint"] : null;
  const spentRaw = readDigits(value["spentRaw"]);
  const buys = readCount(value["buys"]);
  if (day === null || mint === null || spentRaw === null || buys === null) return null;
  return { day, mint, spentRaw, buys };
}

/**
 * The block a newer keeper adds beside the board. EVERY MEMBER IS OPTIONAL and
 * each is parsed on its own: a malformed member is null, never a refusal of the
 * rest, and a malformed block is null — the page then behaves exactly as it
 * does with today's keeper. A `v` other than 1 is a contract this build does
 * not know, and is ignored whole.
 */
export function parseStatsBlock(value: unknown): StatsBlock | null {
  if (!isRecord(value)) return null;
  if (value["v"] !== undefined && value["v"] !== 1) return null;

  const unreadable: string[] = [];
  /** A member read on its own: absent is null and nothing more; sent but unreadable is null AND named. */
  const read = <T>(name: string, raw: unknown, parse: (raw: unknown) => T | null): T | null => {
    if (raw === undefined) return null;
    const parsed = parse(raw);
    if (parsed === null) unreadable.push(name);
    return parsed;
  };
  const record = (name: string, raw: unknown): Record<string, unknown> | null => read(name, raw, (v) => (isRecord(v) ? v : null));

  const t = record("totals", value["totals"]);
  const totals =
    t === null
      ? null
      : {
          savedRaw: read("totals.savedRaw", t["savedRaw"], readDigits),
          tradedRaw: read("totals.tradedRaw", t["tradedRaw"], readDigits),
          settlements: read("totals.settlements", t["settlements"], readCount),
          payingSettlements: read("totals.payingSettlements", t["payingSettlements"], readCount),
          pensions: read("totals.pensions", t["pensions"], readCount),
        };

  // ONE UNREADABLE SIDE SINKS THE SPLIT: a side drawn as 0 would hand the
  // other one 100 %. An ABSENT side is that mode's true zero (no settlement in it).
  const m = record("byMode", value["byMode"]);
  const profit = m === null ? null : readModeTotals(m["profit"]);
  const volume = m === null ? null : readModeTotals(m["volume"]);
  const sideUnread = m !== null && ((m["profit"] !== undefined && profit === null) || (m["volume"] !== undefined && volume === null));
  if (sideUnread) unreadable.push("byMode");
  // Sent with neither side: no settlement in either mode yet — known, and empty.
  const byMode = m === null || sideUnread ? null : { profit, volume };

  const daily = read("daily", value["daily"], (raw) => readRows(raw, readStatsDay, (row) => row.day));

  const i = record("invested", value["invested"]);
  const invested =
    i === null
      ? null
      : {
          spentRaw: read("invested.spentRaw", i["spentRaw"], readDigits),
          buys: read("invested.buys", i["buys"], readCount),
          byAsset: read("invested.byAsset", i["byAsset"], readAssetTotals),
          daily: read("invested.daily", i["daily"], (raw) => readRows(raw, readInvestedDay, (row) => `${row.day} ${row.mint}`)),
        };

  return {
    unreadable,
    computedAt: read("computedAt", value["computedAt"], readInstant),
    totals,
    truncated: read("truncated", value["truncated"], (raw) => (typeof raw === "boolean" ? raw : null)),
    byMode,
    daily,
    invested,
  };
}

// ── The model ────────────────────────────────────────────────────────────────

export function failureReason(failure: LeaderboardFailure): Reason {
  switch (failure) {
    case "unconfigured":
      return "source-unconfigured";
    case "misconfigured":
      return "source-misconfigured";
    case "timeout":
    case "unreachable":
      return "source-unreachable";
    case "not-ready":
      return "source-not-ready";
    case "refused":
      return "source-refused";
  }
}

/** What a SOL total comes to at today's price, in USDC raw units. Either side unknown, the dollars are unknown — the price's reason first. */
export function dollarsFor(lamports: Stat<{ readonly lamports: Raw }>, price: Stat<Raw>): Stat<Raw> {
  if (price.kind === "unavailable") return price;
  if (lamports.kind === "unavailable") return lamports;
  return known(usdcRawForLamports(BigInt(lamports.value.lamports), BigInt(price.value)).toString());
}

/** Every figure unavailable for one reason: a whole source that could not be read. */
function nothing(input: { readonly source: "live" | "sample"; readonly reason: Reason; readonly price: Stat<Raw>; readonly shelf: Shelf }): GlobalStatsModel {
  const none = unavailable(input.reason);
  return {
    source: input.source,
    feed: { ok: false, reason: input.reason },
    computedAt: none,
    seriesEnd: null,
    statsComputedAt: null,
    firstDayProven: false,
    firstDay: none,
    lastDay: none,
    saved: none,
    traded: none,
    pensions: none,
    settlements: none,
    payingSettlements: none,
    average: none,
    invested: none,
    byMode: none,
    solPrice: input.price,
    shelf: input.shelf,
    daily: none,
    investedDaily: none,
    leaders: none,
  };
}

/** A coverage day: JSON null is "no settlement yet", a real day is that day, anything else is unreadable. */
function coverageDay(value: unknown): Stat<UtcDay | null> {
  if (value === null) return known(null);
  const day = readUtcDay(value);
  return day === null ? unavailable("field-unreadable") : known(day);
}

/**
 * THE PAGE'S WHOLE MODEL, from one keeper answer.
 *
 * Each figure takes the first source that parses: the `stats` block when a
 * keeper sends it, else today's board and coverage. What only `stats` can give
 * is "not-served-yet" without it.
 */
export function buildGlobalStats(input: {
  readonly source: "live" | "sample";
  readonly feed: LeaderboardBodyResult;
  readonly price: Stat<Raw>;
  readonly shelf: Shelf;
}): GlobalStatsModel {
  const { source, feed, price, shelf } = input;
  if (!feed.ok) return nothing({ source, reason: failureReason(feed.failure), price, shelf });
  const board = parseLeaderboard(feed.body);
  if (board === null || !isRecord(feed.body)) return nothing({ source, reason: "source-not-understood", price, shelf });

  const body = feed.body;
  const coverage = isRecord(body["coverage"]) ? body["coverage"] : {};
  const stats = parseStatsBlock(body["stats"]);
  // ONLY AN EXPLICIT false IS PROOF that the service's read was not cut. Not
  // saying is not saying "whole": every figure from `stats` is then "at least".
  const proven = stats?.truncated === false;
  const bound: Bound = proven ? "complete" : "at-least";
  /** Why a `stats`-only figure is missing: never sent, or sent and unreadable. */
  const missing = (...names: readonly string[]): Stat<never> =>
    unavailable(names.some((name) => stats?.unreadable.includes(name) === true) ? "field-unreadable" : "not-served-yet");

  const computedAt = readInstant(body["computedAt"]);
  const coveredFirst = coverageDay(coverage["firstDay"]);
  const coveredLast = coverageDay(coverage["lastDay"]);
  // A first day after the last is not a span: neither end can be believed.
  const inverted = coveredFirst.kind === "known" && coveredLast.kind === "known" && coveredFirst.value !== null && coveredLast.value !== null && coveredFirst.value > coveredLast.value;
  const firstDay: Stat<UtcDay | null> = inverted ? unavailable("field-unreadable") : coveredFirst;
  const lastDay: Stat<UtcDay | null> = inverted ? unavailable("field-unreadable") : coveredLast;
  const coveredPensions = readCount(coverage["subjects"]);
  const coveredSettlements = readCount(coverage["settlements"]);
  const first = firstDay.kind === "known" ? firstDay.value : null;
  const last = lastDay.kind === "known" ? lastDay.value : null;
  const windowOpen = historyWindowProvablyOpen(coveredPensions, first, last);

  // A count from `stats` is whole only when the service said its read was not
  // cut; a count from coverage only when the bounded read provably was not.
  const counted = (fromStats: number | null | undefined, fromCoverage: number | null): Stat<Counted> => {
    if (fromStats !== null && fromStats !== undefined) return known({ count: fromStats, bound });
    if (fromCoverage !== null) return known({ count: fromCoverage, bound: windowOpen ? "complete" : "at-least" });
    return unavailable("field-unreadable");
  };

  const fromBoard = totalsFromBoard(board.boards.total.all, coveredPensions, first, last);
  const savedRaw = stats?.totals?.savedRaw ?? null;
  const tradedRaw = stats?.totals?.tradedRaw ?? null;
  const saved: Stat<SavedTotal> = savedRaw !== null ? known({ lamports: savedRaw, bound }) : fromBoard.saved;
  const traded: Stat<TradedTotal> = tradedRaw !== null ? known({ lamports: tradedRaw, partial: !proven }) : fromBoard.traded;

  const served = <Row>(block: { readonly rows: readonly Row[]; readonly dropped: number } | null | undefined, why: Stat<never>): Stat<Served<Row>> =>
    block === null || block === undefined ? why : known({ rows: block.rows, partial: block.dropped > 0 || !proven });

  const paying = stats?.totals?.payingSettlements ?? null;
  const payingSettlements: Stat<Counted> = paying === null ? missing("totals", "totals.payingSettlements") : known({ count: paying, bound });
  // THE SAME READ ON BOTH SIDES OF THE DIVISION: a total summed from the
  // ranking board over a count from `stats` would be a ratio of two different
  // histories. And a ratio of two lower bounds is neither: "≈", not "at least".
  const average: Stat<SavedTotal | null> =
    payingSettlements.kind === "unavailable"
      ? payingSettlements
      : savedRaw === null
        ? unavailable("field-unreadable")
        : payingSettlements.value.count === 0
          ? known(null)
          : known({ lamports: (BigInt(savedRaw) / BigInt(payingSettlements.value.count)).toString(), bound });

  const investedDaily = served(stats?.invested?.daily, missing("invested", "invested.daily"));
  const investedRaw = stats?.invested?.spentRaw ?? null;
  // Per asset: the service's own all-time totals when it sends them; else
  // rebuilt from a WHOLE daily series only — a partial one would understate
  // some assets and not others; else not known at all.
  const sentByAsset = stats?.invested?.byAsset ?? null;
  const byAsset: readonly AssetTotal[] | null =
    sentByAsset !== null
      ? [...sentByAsset].sort((a, b) => (BigInt(b.usdcRaw) > BigInt(a.usdcRaw) ? 1 : BigInt(b.usdcRaw) < BigInt(a.usdcRaw) ? -1 : a.mint < b.mint ? -1 : 1))
      : investedDaily.kind === "known" && !investedDaily.value.partial
      ? Object.entries(
          investedDaily.value.rows.reduce<Record<string, { usdc: bigint; buys: number }>>((sums, row) => {
            const sum = sums[row.mint] ?? { usdc: 0n, buys: 0 };
            sums[row.mint] = { usdc: sum.usdc + BigInt(row.spentRaw), buys: sum.buys + row.buys };
            return sums;
          }, {}),
        )
          .map(([mint, sum]) => ({ mint, usdcRaw: sum.usdc.toString(), buys: sum.buys }))
          .sort((a, b) => (BigInt(b.usdcRaw) > BigInt(a.usdcRaw) ? 1 : BigInt(b.usdcRaw) < BigInt(a.usdcRaw) ? -1 : a.mint < b.mint ? -1 : 1))
      : null;

  return {
    source,
    feed: { ok: true, contract: stats === null ? "totals-only" : "with-stats" },
    computedAt: computedAt === null ? unavailable("field-unreadable") : known(computedAt),
    seriesEnd: stats === null ? null : (stats.computedAt ?? computedAt)?.slice(0, 10) ?? null,
    statsComputedAt: stats?.computedAt ?? null,
    firstDayProven: windowOpen,
    firstDay,
    lastDay,
    saved,
    traded,
    pensions: counted(stats?.totals?.pensions, coveredPensions),
    settlements: counted(stats?.totals?.settlements, coveredSettlements),
    payingSettlements,
    average,
    invested: investedRaw === null ? missing("invested", "invested.spentRaw") : known({ usdcRaw: investedRaw, buys: stats?.invested?.buys ?? null, bound, byAsset }),
    byMode: stats?.byMode === null || stats?.byMode === undefined ? missing("byMode") : known({ ...stats.byMode, bound }),
    solPrice: price,
    shelf,
    daily: served(stats?.daily, missing("daily")),
    investedDaily,
    leaders: known(
      [...board.boards.total.all]
        .sort((a, b) => a.rank - b.rank)
        .slice(0, LEADERS_SHOWN)
        .map((entry) => ({
        rank: entry.rank,
        subject: entry.subject,
        savedRaw: entry.amountRaw,
        tradedRaw: entry.volumeRaw ?? null,
        settlements: entry.settles,
        activeDays: entry.activeDays,
      })),
    ),
  };
}
