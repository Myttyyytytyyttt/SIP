/**
 * WHAT ONE READ OF A LIVE PENSION PUTS ON SCREEN, AND THAT IT PUTS IT THERE
 * ONCE (UI plan 2026-10-09, §5 item 7, its "most important ask").
 *
 * A read takes the snapshot first and the history second. Every read after
 * the first used to commit its snapshot the moment it answered and its head
 * page a second or so later, so each poll drew "new balances, old rows" and
 * then "new rows": a converting line vanished — its SOL gone from the
 * snapshot — a second before the "Converted" row that ended it arrived, and a
 * fresh saving could draw for that second as a step "Not done since…". Two
 * different pages, both false, on every read that moved anything.
 *
 * So the hook keeps what a read brings in ONE state (LiveData), and a read
 * changes it in ONE update: commitRead, with the snapshot it stands on (the
 * re-read a history ahead of it bought, when it did — live-push.ts
 * historyAhead), its head page or that page's trouble, and the settlements
 * the round read from the links. Pure, so the rule is a test and not a timing.
 *
 * THE ONE EXCEPTION IS THE FIRST PAINT (lib/first-paint.ts): a pension's first
 * snapshot may be drawn alone when its history is slower than
 * FIRST_PAINT_WAIT_MS — the feed then says it is still reading — and the
 * read's commit follows. paintFirst draws only onto a store holding no
 * snapshot, so it can never be the commit that takes a line away.
 *
 * WHAT ONE COMMIT CANNOT PROMISE: a row the read did not get. A read whose
 * history failed commits its snapshot without one (the figures are current;
 * the feed says the history could not be read), and a history from a node
 * that has not indexed the newest transaction yet is the follow-up read's to
 * complete (live-push.ts, push D4).
 */

import { activityTroubleFrom, type LiveActivityTrouble } from "@/lib/live-api";
import { appendOlder, headCursor, mergeHead } from "@/lib/live-activity-store";
import type { LiveActivityJson, LiveEntryJson, LiveSnapshotJson } from "@/lib/live-types";
import type { ApiResult } from "@/lib/vault-api";

/** What the reads of one pension key have put on screen. */
export interface LiveData {
  readonly snapshot: LiveSnapshotJson | null;
  /** The vault's own history, newest first: one contiguous slice (live-activity-store.ts). */
  readonly entries: readonly LiveEntryJson[];
  /**
   * ROWS READ FROM THE TRADING WALLETS' LINKS, kept in their OWN list. Never
   * merged into `entries`: every window total rests on the vault page being one
   * contiguous slice, and a link is a slice of a different stream.
   */
  readonly linkEntries: readonly LiveEntryJson[];
  /** Whether the vault's history was read, and where the loaded part of it ends; null before a head page was read. */
  readonly activityMeta: Pick<LiveActivityJson, "status" | "nextBefore"> | null;
  /** The last head page's trouble — failed, or unreadable — with its retry-after; null when it was read. */
  readonly activityTrouble: LiveActivityTrouble | null;
  /**
   * How many reads have committed: one more with every commitRead, never with
   * the first paint's early draw or an older page. It never goes back, not
   * even when the pension key changes, so "it moved" always means "a read
   * landed whole".
   */
  readonly readId: number;
  /** When the snapshot on screen was committed, on this browser's clock: the early first paint, or a read's commit. Null before either. */
  readonly committedAt: number | null;
}

export const EMPTY_LIVE_DATA: LiveData = {
  snapshot: null,
  entries: [],
  linkEntries: [],
  activityMeta: null,
  activityTrouble: null,
  readId: 0,
  committedAt: null,
};

/** A DIFFERENT PENSION KEY IS A DIFFERENT PENSION: nothing read for the last one stays — but the count goes on. */
export const forgottenData = (held: LiveData): LiveData => ({ ...EMPTY_LIVE_DATA, readId: held.readId });

/** One read, whole: what commitRead puts on screen in one update. */
export interface ReadCommit {
  /** The snapshot the read stands on: its first answer, or the re-read a history ahead of it bought. */
  readonly snapshot: LiveSnapshotJson;
  /** The vault's head page as it answered; null when the read asked for none (no vault, or a caller that draws no history). */
  readonly history: {
    readonly page: ApiResult<LiveActivityJson>;
    /** The newest signature the read asked `until`; null for a first page, which defines where the loaded history ends. */
    readonly until: string | null;
    /** The read was the early one a refusal's retry-after bought: it counts toward that trouble's attempts. */
    readonly early: boolean;
    /** When the page answered, on this browser's clock: a retry-after counts from it. */
    readonly answeredAt: number;
  } | null;
  /** The settlements the round read from the links: into `linkEntries`, never into `entries`. */
  readonly linkRows: readonly LiveEntryJson[];
  /** When the commit is made, on this browser's clock. */
  readonly at: number;
}

/**
 * ONE READ, COMMITTED WHOLE. The snapshot replaces the last; a head page that
 * was read goes on top of the rows already loaded (or replaces them: a first
 * page, a gap) and says where the loaded history ends (headCursor); one that
 * failed, or that the route marked unreadable, leaves the rows and the cursor
 * as they were and carries its trouble. The rows held are the ones in `held`
 * — an older page loaded while the read was out stays under the new head.
 */
export function commitRead(held: LiveData, read: ReadCommit): LiveData {
  let { entries, activityMeta, activityTrouble } = held;
  if (read.history !== null) {
    const { page, until, early, answeredAt } = read.history;
    // CARRIED WITH ITS RETRY-AFTER, not collapsed to a flag. `attempts` counts
    // only the early re-reads this trouble has already bought, so one refusal
    // buys one faster question and no more.
    activityTrouble = activityTroubleFrom(page, { attempts: early ? (held.activityTrouble?.attempts ?? 0) + 1 : 0, now: answeredAt });
    if (page.ok && page.body.status === "exists") {
      // A POLL DOES NOT REDEFINE WHERE THE HISTORY ENDS (live-activity-store.ts headCursor).
      activityMeta = {
        status: page.body.status,
        nextBefore: headCursor({ polled: until !== null, gap: page.body.gap, page: page.body.nextBefore, held: held.activityMeta?.nextBefore ?? null }),
      };
      entries = until === null ? mergeHead([], { entries: page.body.entries, gap: true }) : mergeHead(held.entries, { entries: page.body.entries, gap: page.body.gap });
    }
  }
  return {
    snapshot: read.snapshot,
    entries,
    linkEntries: read.linkRows.length === 0 ? held.linkEntries : appendOlder(held.linkEntries, read.linkRows),
    activityMeta,
    activityTrouble,
    readId: held.readId + 1,
    committedAt: read.at,
  };
}

/**
 * THE FIRST PAINT, DRAWN EARLY: the snapshot alone, when the history has not
 * answered within FIRST_PAINT_WAIT_MS. Only onto a store that holds no
 * snapshot — a later read never draws early, so no figure can change on
 * screen apart from the rows that explain it. The read's commit follows; the
 * count moves then.
 */
export function paintFirst(held: LiveData, snapshot: LiveSnapshotJson, at: number): LiveData {
  if (held.snapshot !== null) return held;
  return { ...held, snapshot, committedAt: at };
}

/** An older page (Load older), appended under the rows held. Not a read of the chain's present: the count and the clock stay. */
export const withOlderPage = (held: LiveData, page: LiveActivityJson): LiveData => ({
  ...held,
  entries: appendOlder(held.entries, page.entries),
  activityMeta: { status: page.status, nextBefore: page.nextBefore },
});

/**
 * WHETHER THE LOADED HISTORY IS THE WHOLE HISTORY: a head page — or the last
 * older page — named no cursor to page from. Worked out from the cursor, never
 * stored beside it, so the two cannot disagree.
 */
export const historyComplete = (data: Pick<LiveData, "activityMeta">): boolean => data.activityMeta !== null && data.activityMeta.nextBefore === null;
