/**
 * Every number and date on the page goes through here, so two panels cannot
 * print the same dollar two ways.
 *
 * EVERYTHING IS UTC AND en-US, EXPLICITLY. A bare toLocaleDateString() formats
 * in the server's zone on the server and the visitor's zone in the browser,
 * and the two strings differ by up to a day — which React reports as a
 * hydration mismatch on every load. Pinning both is what makes the output
 * identical on both sides.
 *
 * AND THE ZONE IS SAID OUT LOUD, because these timestamps carry money: the same
 * rows are grouped into day headings and totalled into a "Today" tile. For an
 * owner in Lisbon a settlement at 00:30 local renders as 23:30 and files under
 * the day before, which is not a mistake as long as the page says which day it
 * means. Hydration needs the formatting to be deterministic; it never needed
 * the zone to go unnamed.
 */

import type { Side } from "@/mocks/types";

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const USD_COMPACT = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});

const NUMBER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

const COUNT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/**
 * WHAT A FIGURE NOBODY COULD READ PRINTS AS. The same components render the
 * sample and a live pension, and live has figures that are genuinely unknown —
 * prices unread, a window the loaded history does not cover. They are null, and
 * null is a dash, never $0.00: "unreadable" and "nothing" are different claims.
 */
export const UNKNOWN = "—";

/** "1,234" — a whole count, grouped like every other number on the page. */
export function count(value: number | null): string {
  return value === null ? UNKNOWN : COUNT.format(value);
}

/** "Bought NVDAx" / "Sold TSLAx" — the one way a fill is named, everywhere. */
export function fillLabel(side: Side, symbol: string): string {
  return `${side === "buy" ? "Bought" : "Sold"} ${symbol}`;
}

/** "$1,234.56" */
export function usd(value: number | null): string {
  return value === null ? UNKNOWN : USD.format(value);
}

/** "+$1.24" / "-$0.80" / "$0.00" — for anything that can go either way. */
export function usdSigned(value: number | null): string {
  if (value === null) return UNKNOWN;
  if (value > 0) return `+${USD.format(value)}`;
  if (value < 0) return `-${USD.format(-value)}`;
  return USD.format(0);
}

/** "$1.2K" — for axes and tight chips. */
export function usdCompact(value: number | null): string {
  return value === null ? UNKNOWN : USD_COMPACT.format(value);
}

const PERCENT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/**
 * 200 bps -> "2%", 25 -> "0.25%", 2000 -> "20%". Trailing zeros are dropped
 * because a rate is a setting, not a column; pass `digits` where a column
 * needs a fixed width.
 */
export function pct(bps: number | null, digits?: number): string {
  if (bps === null) return UNKNOWN;
  return digits === undefined ? `${PERCENT.format(bps / 100)}%` : `${(bps / 100).toFixed(digits)}%`;
}

/** "0.4821" — up to four decimals, trailing zeros dropped. */
export function shares(value: number): string {
  return NUMBER.format(value);
}

/** "FezjSX…gyXA" — addresses and signatures alike. */
export function shortHex(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 6)}…${value.slice(-4)}`;
}

/** "Sep 7" */
export function dayLabel(iso: string): string {
  const date = new Date(iso);
  return `${MONTHS[date.getUTCMonth()] ?? "?"} ${date.getUTCDate()}`;
}

/** "Sep 7, 2026" */
export function dateLabel(iso: string): string {
  return `${dayLabel(iso)}, ${new Date(iso).getUTCFullYear()}`;
}

/** "14:32 UTC" — the zone is on the label, not only in this file. */
export function clockLabel(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")} UTC`;
}

/**
 * "just now" / "4m ago" / "3h ago" / "2d ago", and the calendar date past a
 * week. `now` is a parameter, not Date.now(), for the reason at the top.
 */
export function timeAgo(iso: string, now: string): string {
  const seconds = Math.max(0, Math.floor((new Date(now).getTime() - new Date(iso).getTime()) / 1000));
  if (seconds < 90) return "just now";
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 129_600) return `${Math.round(seconds / 3600)}h ago`;
  if (seconds < 7 * 86_400) return `${Math.round(seconds / 86_400)}d ago`;
  return dayLabel(iso);
}

/**
 * "Today" / "Yesterday" / "Sep 5" — day headings, judged against the page's
 * `now` and never the clock. Accepts a day or a full timestamp.
 */
export function relativeDayLabel(date: string, now: string): string {
  const day = date.slice(0, 10);
  const today = now.slice(0, 10);
  if (day === today) return "Today";
  const yesterday = new Date(new Date(`${today}T00:00:00.000Z`).getTime() - 86_400_000).toISOString().slice(0, 10);
  if (day === yesterday) return "Yesterday";
  return dayLabel(day);
}
