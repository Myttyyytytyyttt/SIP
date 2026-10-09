"use client";

import { useEffect, useMemo, useState } from "react";

import { holdUntil, nextRelease, releaseDue, type Holds } from "@/components/live/use-hold";
import type { WashTone } from "@/components/live/Wash";
import { formatSol, formatSolAtMost, rawFrom } from "@/lib/amounts";
import { clockLabel, usd } from "@/lib/format";
import { LIVE_COPY } from "@/lib/live-copy";
import type { LiveDashboard, LiveRow } from "@/lib/live-types";
// The leaf, not the barrel: `@/mocks` also re-exports the seeded dataset (no-mock-import.test.ts).
import type { Trade } from "@/mocks/types";

/**
 * WHAT JUST ARRIVED (10-09, plan P3; owner, 10-09: "a short wash on a genuinely
 * new row or chip, and the hero pill").
 *
 * A row is ARRIVED when the read that brought it is the first to hold it AND it
 * is newer than everything the page already showed. Both, keyed by SIGNATURE:
 *
 *   - "not shown before" alone would flash every row of an older page someone
 *     asked for (Load older), and every settlement the page went and found on a
 *     wallet's link (the backfill) — old money, newly on screen;
 *   - "newer" is measured against the newest SLOT the page had shown, never
 *     `data.slot`: the snapshot has already moved past a row whose history has
 *     not landed (G4), so against it nothing would ever count as new.
 *
 * WHY THE SIGNATURE AND NOT A ROW'S ID. Ids count per list (live-mock.ts
 * idsFor), so `sig:0` names a different event in the strip and in the column;
 * the transaction is the one name every surface shares. A settle that pays two
 * wallets is one signature and two chips, and both arrive.
 *
 * NOTHING ARRIVES ON A FIRST PAINT, and these all are one:
 *   - the page's first frame for this pension key, or a remount (a walk to
 *     /activity and back): nothing to compare with;
 *   - another pension key: another history;
 *   - the history going from on its way to read, or from unreadable to read:
 *     what it brings was there before, the page just could not see it;
 *   - nothing loaded before — the vault's first rows, the history's first page;
 *   - a head that kept none of the rows shown before: more landed than one
 *     page holds, the head was REPLACED rather than merged (`gap`,
 *     live-activity-store.ts mergeHead), and fifteen flashes would be noise.
 * WHEN UNSURE, NOTHING IS MARKED: a missed wash costs nothing, a false one says
 * money moved when it did not.
 *
 * NOTHING ARRIVES FOR A PRICE. Dollars are re-priced on every read, so nothing
 * here looks at one: a snapshot with new prices and the same rows marks
 * nothing, and so does the snapshot-only commit before a read's history lands
 * (use-read-settled.ts) — rows change only with the history's own commit, so
 * this needs no settled view to wait for.
 *
 * HELD FOR ARRIVAL_HOLD_MS OF BROWSER TIME on one timer (use-hold.ts): the wash
 * fades in 2.4 s and keeps its edge for the rest. Worked out ONCE, in LiveBody,
 * and handed to every copy — the column is mounted twice (the aside and the
 * header's sheet), and two copies must not flash on clocks of their own. The
 * arrival is decided during the render, so a new row's first frame already
 * wears its wash, and a chip's entrance does not start from a chip already
 * drawn.
 *
 * Hidden rows (upkeep, dust) count as SHOWN — they are loaded, and behind a
 * disclosure — and never as ARRIVED: the machinery's account-keeping is not news.
 */

/** How long an arrived row or chip keeps its mark. */
export const ARRIVAL_HOLD_MS = 30_000;
/** How long the hero's pill stays, in the page's own data time, unless another saving replaces it. */
export const PILL_MS = 10 * 60_000;

/** One commit as this sees it: whose pension, the rows it holds, and where the history stands. */
export interface ArrivalFrame {
  readonly key: string;
  readonly data: Pick<LiveDashboard, "rows" | "hiddenRows" | "settlementRows" | "nowMs">;
  readonly activityPending: boolean;
  readonly activityUnreadable: boolean;
}

/** What the page had shown, as of the last commit. */
export interface ArrivalBase {
  readonly key: string;
  readonly activityPending: boolean;
  readonly activityUnreadable: boolean;
  /** Every signature loaded: the vault's page, shown or hidden, and the settlements from both streams. */
  readonly seen: ReadonlySet<string>;
  /** The vault's page alone. A head that kept none of these was replaced. */
  readonly page: ReadonlySet<string>;
  /** The newest slot among everything loaded; null when nothing is. */
  readonly newest: number | null;
}

/** The rows a person sees, once each: the vault's page, then the settlements only a wallet's link holds — the column's own union (live-mock.ts). */
export function visibleRows(data: ArrivalFrame["data"]): readonly LiveRow[] {
  const onPage = new Set(data.rows.map((row) => row.signature));
  return [...data.rows, ...data.settlementRows.filter((row) => !onPage.has(row.signature))];
}

export function baseOf(frame: ArrivalFrame): ArrivalBase {
  const { rows, hiddenRows, settlementRows } = frame.data;
  const page = new Set([...rows, ...hiddenRows].map((row) => row.signature));
  const seen = new Set(page);
  let newest: number | null = null;
  for (const row of [...rows, ...hiddenRows, ...settlementRows]) {
    seen.add(row.signature);
    if (newest === null || row.slot > newest) newest = row.slot;
  }
  return { key: frame.key, activityPending: frame.activityPending, activityUnreadable: frame.activityUnreadable, seen, page, newest };
}

const overlaps = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => {
  for (const value of b) if (a.has(value)) return true;
  return false;
};

/**
 * The pure core: what `frame` brought that `prev` had not shown, by the rules at
 * the top. `base` is what the next commit compares with.
 */
export function arrivalsOf(prev: ArrivalBase | null, frame: ArrivalFrame): { readonly base: ArrivalBase; readonly arrived: readonly LiveRow[] } {
  const base = baseOf(frame);
  const none = { base, arrived: [] } as const;
  // A first paint, a remount: nothing to compare with.
  if (prev === null) return none;
  // Another pension is another history.
  if (prev.key !== frame.key) return none;
  // The history coming into view: from on its way, or from unreadable.
  if (prev.activityPending && !frame.activityPending) return none;
  if (prev.activityUnreadable && !frame.activityUnreadable) return none;
  // Nothing loaded before, or nothing of the vault's page: these are its first rows.
  if (prev.newest === null || prev.page.size === 0) return none;
  // The head was replaced, not merged (a gap): none of the rows shown before is still there.
  if (!overlaps(prev.page, base.page)) return none;
  const newest = prev.newest;
  const arrived = visibleRows(frame.data).filter((row) => !prev.seen.has(row.signature) && row.slot > newest);
  return { base, arrived };
}

/**
 * THE WASH'S COLOUR, by what the row is (classes.ts Tone): green a saving that
 * moved money, blue a buy, mustard a change to how the pension behaves, grey
 * the rest — and a transaction that did not land is grey too, never green: the
 * edge says something arrived, not that it went well.
 */
export function arrivalTone(row: LiveRow): WashTone {
  if (!row.ok) return "quiet";
  const event = row.event;
  switch (event.kind) {
    case "settled":
      return (rawFrom(event.paid) ?? 0n) > 0n ? "saved" : "quiet";
    case "invested":
      return "invest";
    case "vault_created":
    case "rule_changed":
    case "policy_signed":
    case "linked":
    case "unlinked":
      return "setting";
    default:
      return "quiet";
  }
}

/** A settlement that moved money: what the hero's pill counts. */
export const isSaving = (row: LiveRow): boolean => row.ok && row.event.kind === "settled" && (rawFrom(row.event.paid) ?? 0n) > 0n;

/** What one commit brought, for the announcer: `seq` names the commit, so the same words twice are still two announcements. */
export interface ArrivalNews {
  readonly seq: number;
  readonly rows: readonly LiveRow[];
}

/** The last commit that brought a saving, and the page's data clock when it did: the hero's pill. */
export interface ArrivalSaving {
  readonly rows: readonly LiveRow[];
  readonly atMs: number;
}

/** What the hook keeps between commits. */
export interface ArrivalTrack {
  readonly frame: ArrivalFrame;
  readonly base: ArrivalBase;
  readonly holds: Holds;
  readonly news: ArrivalNews | null;
  readonly saving: ArrivalSaving | null;
}

const NO_HOLDS: Holds = new Map();

export function startArrivals(frame: ArrivalFrame): ArrivalTrack {
  return { frame, base: baseOf(frame), holds: NO_HOLDS, news: null, saving: null };
}

/**
 * The track after `frame` is committed, at browser time `now`. A commit that
 * brought nothing keeps every mark, the news and the pill as they were. A
 * saving replaces the pill; a conversion or a buy that follows it does not —
 * it is that very saving on its way into the basket, not a new one.
 */
export function advanceArrivals(track: ArrivalTrack, frame: ArrivalFrame, now: number): ArrivalTrack {
  const { base, arrived } = arrivalsOf(track.base, frame);
  if (arrived.length === 0) return { ...track, frame, base };
  const savings = arrived.filter(isSaving);
  return {
    frame,
    base,
    holds: holdUntil(track.holds, arrived.map((row) => row.signature), now + ARRIVAL_HOLD_MS),
    news: { seq: (track.news?.seq ?? 0) + 1, rows: arrived },
    saving: savings.length === 0 ? track.saving : { rows: savings, atMs: frame.data.nowMs },
  };
}

const sameFrame = (a: ArrivalFrame, b: ArrivalFrame): boolean =>
  a.data === b.data && a.key === b.key && a.activityPending === b.activityPending && a.activityUnreadable === b.activityUnreadable;

export interface Arrivals {
  /** The signatures still marked: every row and chip of one of these wears the wash. */
  readonly arrived: ReadonlySet<string>;
  /** What the last commit that brought anything brought; null before one did. */
  readonly news: ArrivalNews | null;
  /** The last saving that arrived; null before one did. */
  readonly saving: ArrivalSaving | null;
}

/** Once, in LiveBody: every copy of every surface reads the same marks. */
export function useArrivals(frame: ArrivalFrame): Arrivals {
  const [track, setTrack] = useState<ArrivalTrack>(() => startArrivals(frame));
  // A new commit: worked out now, so the frame that first draws a new row already marks it.
  let current = track;
  if (!sameFrame(track.frame, frame)) {
    current = advanceArrivals(track, frame, Date.now());
    setTrack(current);
  }

  const due = nextRelease(current.holds);
  useEffect(() => {
    if (due === null) return;
    // Released as at `due` at the least: a timer may wake a millisecond early (use-hold.ts).
    const timer = setTimeout(
      () =>
        setTrack((held) => {
          const holds = releaseDue(held.holds, Math.max(Date.now(), due));
          return holds === held.holds ? held : { ...held, holds };
        }),
      Math.max(0, due - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [due]);

  const arrived = useMemo<ReadonlySet<string>>(() => new Set(current.holds.keys()), [current.holds]);
  return { arrived, news: current.news, saving: current.saving };
}

// ── the hero's pill ──────────────────────────────────────────────────────────

/** The pill's face, and what hovering it says. */
export interface HeroPill {
  readonly text: string;
  readonly title: string | null;
}

/** Whether the pill still shows: for PILL_MS of the page's data time after its saving arrived. */
export const pillShown = (saving: ArrivalSaving | null, nowMs: number): boolean => saving !== null && nowMs - saving.atMs < PILL_MS;

/** A positive amount never reads as nothing (strip-chip.tsx faceOf). */
const dollars = (value: number): string => (value > 0 && value < 0.005 ? "<$0.01" : usd(value));

/**
 * "+$0.43 saved · 14:32 UTC", or "+$0.86 · 2 savings · 14:33 UTC" — the newest
 * one's time. IN THE ADAPTER'S OWN DOLLARS: each saving's chip (`trades`,
 * live-mock.ts), never a difference of the lifetime total, which the price
 * moves on every read. A saving with no chip, or a chip no price could value,
 * and the pill says SOL instead: the chain's own figure, rounded on the face
 * and whole on hover. The time is the clock alone: the saving has only just
 * arrived. [B] dated, once whenLabel lands.
 */
export function heroPillOf(saving: ArrivalSaving | null, trades: readonly Trade[]): HeroPill | null {
  if (saving === null || saving.rows.length === 0) return null;
  let lamports = 0n;
  for (const row of saving.rows) if (row.event.kind === "settled") lamports += rawFrom(row.event.paid) ?? 0n;
  const signatures = new Set(saving.rows.map((row) => row.signature));
  const chips = trades.filter((trade) => signatures.has(trade.txHash));
  const charted = new Set(chips.map((trade) => trade.txHash));
  const priced = charted.size === signatures.size && chips.every((trade) => trade.savedUsd !== null);
  const sum = chips.reduce((total, trade) => total + (trade.savedUsd ?? 0), 0);

  const face = priced ? dollars(sum) : `${formatSolAtMost(lamports, 4)} SOL`;
  const count = saving.rows.length;
  const amount = count === 1 ? LIVE_COPY.heroPill.saved(face) : LIVE_COPY.heroPill.savings(face, count);
  const newest = saving.rows.reduce<LiveRow | null>((best, row) => (row.at !== null && (best === null || row.slot > best.slot) ? row : best), null);
  return {
    text: newest === null || newest.at === null ? amount : `${amount} · ${clockLabel(newest.at)}`,
    title: priced ? LIVE_COPY.heroPill.atPrice(formatSol(lamports)) : LIVE_COPY.heroPill.sol(formatSol(lamports)),
  };
}
