/**
 * EVERYTHING THE DASHBOARD'S CHARTS COMPUTE, as pure functions: UTC days and
 * Monday weeks, the window a chart shows, bars per day or per week, running
 * totals, each series' share, and the one number recharts needs to draw a bar.
 *
 * AMOUNTS STAY STRINGS until the last step. Sums are BigInt; the only Number
 * taken of an amount is `plotUnits`, which sizes a bar and the axis beside it.
 * Every figure a person reads in a tooltip is printed from the exact string the
 * row carries beside that number, never from the number.
 *
 * NO CLOCK. The window ends on the day the data was added up (its computedAt),
 * passed in: days after it are not zero, they are not known yet.
 *
 * A DAY NOBODY COULD READ IS NOT A ZERO. When a series is partial (the keeper
 * said its read was cut, or a row did not parse), a window day with no row may
 * hold settlements: its bucket is `unread`, its bar shows only what was read,
 * and its tooltip says so instead of printing 0.
 */

import { compact } from "@/lib/format";
import type { InvestedDay, Raw, StatsDay, UtcDay } from "@/lib/global-stats-model";

/** The series a chart can carry. Colour follows the series, never its position. */
export type SeriesKey = "saved" | "profit" | "volume" | "invested" | "pensions";

/**
 * THE PALETTE, one entry per series, its class strings spelled out whole so
 * Tailwind's scanner emits the variables the chart reads. Validated for
 * colour-blind separation on the card surfaces in both themes: emerald and
 * violet together, blue alone (blue and violet collapse under deuteranopia,
 * so they never share a chart).
 */
export const SERIES: Readonly<Record<SeriesKey, { readonly label: string; readonly color: string; readonly swatch: string }>> = {
  // Everything put aside, both modes together: the site's one accent, which means exactly that.
  saved: { label: "Put aside", color: "var(--color-emerald-600)", swatch: "bg-emerald-600" },
  profit: { label: "Profit", color: "var(--color-emerald-600)", swatch: "bg-emerald-600" },
  volume: { label: "Volume", color: "var(--color-violet-600)", swatch: "bg-violet-600" },
  invested: { label: "Invested", color: "var(--color-blue-600)", swatch: "bg-blue-600" },
  // A count of pensions belongs to no mode, so it wears no mode's colour: the site's neutral grey.
  pensions: { label: "Pensions", color: "var(--color-neutral-500)", swatch: "bg-neutral-500" },
};

export type Period = "day" | "week";
export type View = "period" | "cumulative" | "share";

/** How a series' raw units read. */
export interface Unit {
  readonly label: "SOL" | "USDC" | null;
  readonly decimals: 9 | 6 | 0;
}

/** One served day, every series of the chart present as digits ("0" is a true zero on a served day). */
export interface DayValues {
  readonly day: UtcDay;
  readonly values: Readonly<Record<string, Raw>>;
}

const DAY_MS = 86_400_000;

const dayMs = (day: UtcDay): number => Date.parse(`${day}T00:00:00.000Z`);

export function addDays(day: UtcDay, n: number): UtcDay {
  return new Date(dayMs(day) + n * DAY_MS).toISOString().slice(0, 10);
}

/** The Monday on or before `day`, UTC: the keeper's own week (its season starts Monday 00:00 UTC). */
export function weekStart(day: UtcDay): UtcDay {
  const weekday = new Date(dayMs(day)).getUTCDay();
  return addDays(day, -((weekday + 6) % 7));
}

/**
 * The days a daily chart shows, ascending, ending on `end`: at least `min`
 * (a young series is not stretched across the card) and at most `max`, and
 * reaching back to the first day when it fits.
 */
export function dayWindow(end: UtcDay, first: UtcDay | null, max = 30, min = 14): readonly UtcDay[] {
  const earliest = addDays(end, -(max - 1));
  const latest = addDays(end, -(min - 1));
  const start = first === null || first > latest ? latest : first < earliest ? earliest : first;
  const out: UtcDay[] = [];
  for (let day = start; day <= end; day = addDays(day, 1)) out.push(day);
  return out;
}

/** The Mondays a weekly chart shows, ending with `end`'s week; same rule, in weeks. */
export function weekWindow(end: UtcDay, first: UtcDay | null, max = 26, min = 8): readonly UtcDay[] {
  const last = weekStart(end);
  const earliest = addDays(last, -7 * (max - 1));
  const latest = addDays(last, -7 * (min - 1));
  const firstWeek = first === null ? null : weekStart(first);
  const start = firstWeek === null || firstWeek > latest ? latest : firstWeek < earliest ? earliest : firstWeek;
  const out: UtcDay[] = [];
  for (let week = start; week <= last; week = addDays(week, 7)) out.push(week);
  return out;
}

export interface Bucket {
  /** The bucket's first day: the day itself, or its week's Monday. */
  readonly key: UtcDay;
  readonly values: Readonly<Record<string, Raw>>;
  readonly total: Raw;
  /** The bucket holding the last day added up: that day was still running, so it is "so far". */
  readonly soFar: boolean;
  /** A day in it could not be read: its figures are lower bounds, and an empty one is unknown, not zero. */
  readonly unread: boolean;
}

const zeros = (series: readonly string[]): Record<string, bigint> => Object.fromEntries(series.map((key) => [key, 0n]));

const toBucket = (key: UtcDay, sums: Readonly<Record<string, bigint>>, series: readonly string[], soFar: boolean, unread: boolean): Bucket => ({
  key,
  values: Object.fromEntries(series.map((name) => [name, (sums[name] ?? 0n).toString()])),
  total: series.reduce((total, name) => total + (sums[name] ?? 0n), 0n).toString(),
  soFar,
  unread,
});

/**
 * Which window days could not be read: every day with no row when the series
 * is partial (a dropped row has no day anyone can trust), and the days named
 * as missing whatever the series says.
 */
export function unreadDays(rows: readonly DayValues[], partial: boolean, missing: readonly UtcDay[] = []): (day: UtcDay) => boolean {
  const served = new Set(rows.map((row) => row.day));
  const named = new Set(missing);
  return (day) => named.has(day) || (partial && !served.has(day));
}

/**
 * The served rows, summed into the window's buckets. A window day with no row
 * is a true zero unless `unread` says it could not be read; rows outside the
 * window are left to `carryIn`.
 */
export function bucketize(
  rows: readonly DayValues[],
  window: readonly UtcDay[],
  period: Period,
  series: readonly string[],
  end: UtcDay,
  unread: (day: UtcDay) => boolean = () => false,
): readonly Bucket[] {
  const keyOf = (day: UtcDay): UtcDay => (period === "day" ? day : weekStart(day));
  const sums = new Map<UtcDay, Record<string, bigint>>(window.map((key) => [key, zeros(series)]));
  for (const row of rows) {
    if (row.day > end) continue;
    const sum = sums.get(keyOf(row.day));
    if (sum === undefined) continue;
    for (const name of series) sum[name] = (sum[name] ?? 0n) + BigInt(row.values[name] ?? "0");
  }
  const endKey = keyOf(end);
  const daysOf = (key: UtcDay): UtcDay[] => (period === "day" ? [key] : [0, 1, 2, 3, 4, 5, 6].map((n) => addDays(key, n)).filter((day) => day <= end));
  return window.map((key) => toBucket(key, sums.get(key) ?? zeros(series), series, key === endKey, daysOf(key).some(unread)));
}

/** Everything before the window, so a running total's last bar is the all-time figure, not the window's. */
export function carryIn(rows: readonly DayValues[], firstWindowDay: UtcDay, series: readonly string[]): Readonly<Record<string, Raw>> {
  const sums = zeros(series);
  for (const row of rows) {
    if (row.day >= firstWindowDay) continue;
    for (const name of series) sums[name] = (sums[name] ?? 0n) + BigInt(row.values[name] ?? "0");
  }
  return Object.fromEntries(series.map((name) => [name, (sums[name] ?? 0n).toString()]));
}

/**
 * Running totals from `carry` on. Once a day could not be read — before the
 * window (`carryUnread`) or inside it — every later running total is a lower
 * bound, and says so.
 */
export function cumulative(buckets: readonly Bucket[], carry: Readonly<Record<string, Raw>>, series: readonly string[], carryUnread = false): readonly Bucket[] {
  const running = Object.fromEntries(series.map((name) => [name, BigInt(carry[name] ?? "0")]));
  let unread = carryUnread;
  return buckets.map((bucket) => {
    for (const name of series) running[name] = (running[name] ?? 0n) + BigInt(bucket.values[name] ?? "0");
    unread = unread || bucket.unread;
    return toBucket(bucket.key, running, series, bucket.soFar, unread);
  });
}

/**
 * Each series' share of a bucket in basis points, summing to exactly 10,000
 * (the last series takes the remainder). Null when the bucket is empty: there
 * is no share of nothing.
 */
export function shareBps(bucket: Bucket, series: readonly string[]): Readonly<Record<string, number>> | null {
  const total = BigInt(bucket.total);
  if (total === 0n) return null;
  const out: Record<string, number> = {};
  let given = 0;
  series.forEach((name, index) => {
    const bps = index === series.length - 1 ? 10_000 - given : Number((BigInt(bucket.values[name] ?? "0") * 10_000n) / total);
    out[name] = bps;
    given += bps;
  });
  return out;
}

/**
 * THE ONE NUMBER TAKEN OF AN AMOUNT: a bar's height. The BigInt division comes
 * first, so what becomes a Number is far below 2^53 for any plausible total —
 * and nothing printed is read from it.
 */
export function plotUnits(raw: Raw, decimals: 9 | 6 | 0): number {
  const value = BigInt(raw);
  if (decimals === 9) return Number(value / 1_000n) / 1e6;
  if (decimals === 6) return Number(value / 100n) / 1e4;
  return Number(value);
}

/** A row as recharts draws it: one geometry number per series, and the exact strings beside them. */
export interface PlotRow {
  readonly key: UtcDay;
  readonly soFar: boolean;
  readonly unread: boolean;
  readonly exact: Readonly<Record<string, Raw>>;
  readonly total: Raw;
  /** Basis points per series; null on an empty bucket, and on one that could not be read whole. */
  readonly shares: Readonly<Record<string, number>> | null;
  /** The lowest and highest series DRAWN in this row: who gets the rounded top, who sits on the axis. */
  readonly bottom: string | null;
  readonly top: string | null;
  readonly [geometry: string]: unknown;
}

export function toPlotRows(buckets: readonly Bucket[], view: View, series: readonly string[], decimals: 9 | 6 | 0): readonly PlotRow[] {
  return buckets.map((bucket) => {
    // A share of a partly read bucket is a share of the wrong total: none is drawn.
    const shares = bucket.unread ? null : shareBps(bucket, series);
    const geometry: Record<string, number> = Object.fromEntries(
      series.map((name) => [name, view === "share" ? (shares?.[name] ?? 0) / 100 : plotUnits(bucket.values[name] ?? "0", decimals)]),
    );
    // From the geometry, not the amounts: an amount too small to draw must not take the rounded top from the segment under it.
    const present = series.filter((name) => (geometry[name] ?? 0) > 0);
    return {
      ...geometry,
      key: bucket.key,
      soFar: bucket.soFar,
      unread: bucket.unread,
      exact: bucket.values,
      total: bucket.total,
      shares,
      bottom: present[0] ?? null,
      top: present.at(-1) ?? null,
    };
  });
}

/** An axis tick: "0.05", "12.5", "1.2K". The unit is said once, in the card. */
export function axisTick(value: number): string {
  if (!Number.isFinite(value)) return "";
  if (Math.abs(value) >= 1_000) return compact(value);
  return String(Number(value.toFixed(Math.abs(value) < 1 ? 3 : 2)));
}

// ── From the model's served rows to a chart's day values ─────────────────────

const cellSaved = (cell: { readonly savedRaw: Raw } | null): Raw => cell?.savedRaw ?? "0";
const cellCount = (cell: { readonly settlements: number } | null): Raw => String(cell?.settlements ?? 0);

/** SOL put aside per day, by mode. */
export const savedByDay = (rows: readonly StatsDay[]): readonly DayValues[] =>
  rows.map((row) => ({ day: row.day, values: { profit: cellSaved(row.profit), volume: cellSaved(row.volume) } }));

/** Settlements per day, by mode. */
export const settlementsByDay = (rows: readonly StatsDay[]): readonly DayValues[] =>
  rows.map((row) => ({ day: row.day, values: { profit: cellCount(row.profit), volume: cellCount(row.volume) } }));

/**
 * Distinct pensions settled per day. A day that did not send its count is
 * LEFT OUT, not zeroed, and named in `missing` so its bar says "not read".
 */
export function pensionsByDay(rows: readonly StatsDay[]): { readonly rows: readonly DayValues[]; readonly missing: readonly UtcDay[] } {
  const kept = rows.flatMap((row) => (row.pensions === null ? [] : [{ day: row.day, values: { pensions: String(row.pensions) } }]));
  return { rows: kept, missing: rows.flatMap((row) => (row.pensions === null ? [row.day] : [])) };
}

/** USDC spent by pensions per day, every asset together. */
export function investedByDay(rows: readonly InvestedDay[]): readonly DayValues[] {
  const sums = new Map<UtcDay, bigint>();
  for (const row of rows) sums.set(row.day, (sums.get(row.day) ?? 0n) + BigInt(row.spentRaw));
  return [...sums.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, usdc]) => ({ day, values: { invested: usdc.toString() } }));
}

/** SOL put aside per day, both modes together: the running total's input. */
export const savedTotalByDay = (rows: readonly StatsDay[]): readonly DayValues[] =>
  rows.map((row) => ({ day: row.day, values: { saved: (BigInt(cellSaved(row.profit)) + BigInt(cellSaved(row.volume))).toString() } }));

/**
 * What each day's settlements were charged on, by mode. A mode that settled
 * that day without sending the figure leaves the day out, named in `missing`:
 * its bar would otherwise read as a smaller day than it was.
 */
export function tradedByDay(rows: readonly StatsDay[]): { readonly rows: readonly DayValues[]; readonly missing: readonly UtcDay[] } {
  const kept: DayValues[] = [];
  const missing: UtcDay[] = [];
  for (const row of rows) {
    const unsent = [row.profit, row.volume].some((cell) => cell !== null && cell.tradedRaw === null);
    if (unsent) missing.push(row.day);
    else kept.push({ day: row.day, values: { profit: row.profit?.tradedRaw ?? "0", volume: row.volume?.tradedRaw ?? "0" } });
  }
  return { rows: kept, missing };
}

/**
 * How much a running total grew over the last `days` days up to `end`, in
 * basis points of where it stood before them. Null when it stood at nothing
 * (growth from zero is not a percentage) or nothing is known.
 */
export function growthBps(rows: readonly DayValues[], end: UtcDay, days: number, series: readonly string[]): number | null {
  const from = addDays(end, -days);
  let before = 0n;
  let now = 0n;
  for (const row of rows) {
    if (row.day > end) continue;
    const value = series.reduce((sum, name) => sum + BigInt(row.values[name] ?? "0"), 0n);
    now += value;
    if (row.day <= from) before += value;
  }
  if (before === 0n) return null;
  return Number(((now - before) * 10_000n) / before);
}

/**
 * Bars for a sparkline: the last `days` days to `end`, one geometry number per
 * day scaled to 0..1 against the tallest. Null when any of those days could not
 * be read — a gap would read as a zero day.
 */
export function sparkBars(rows: readonly DayValues[], end: UtcDay, days: number, series: readonly string[], unread: (day: UtcDay) => boolean): readonly number[] | null {
  const window = Array.from({ length: days }, (_, index) => addDays(end, index - days + 1));
  if (window.some(unread)) return null;
  const byDay = new Map(rows.map((row) => [row.day, series.reduce((sum, name) => sum + BigInt(row.values[name] ?? "0"), 0n)]));
  const values = window.map((day) => byDay.get(day) ?? 0n);
  const top = values.reduce((max, value) => (value > max ? value : max), 0n);
  if (top === 0n) return values.map(() => 0);
  return values.map((value) => Number((value * 1_000n) / top) / 1_000);
}
