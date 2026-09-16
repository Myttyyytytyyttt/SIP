/**
 * THE LOADED HISTORY, kept in one list: pure, so paging and polling cannot
 * quietly duplicate or lose a row.
 *
 * A POLL ASKS ONLY FOR WHAT IS NEW (`until` the newest signature it already
 * holds), so the ordinary answer is a handful of rows to put on top. Rows are
 * keyed by signature, which is unique on chain, and the FRESHER copy of a row
 * wins: a transaction first seen at confirmed commitment can be read again.
 *
 * A GAP IS NOT STITCHED. When more landed than one page holds, the server says
 * so, and the head is REPLACED rather than merged: a merged head would leave an
 * invisible hole in the middle of someone's history, and a hole nobody can see
 * is worse than a page that reloaded.
 */

/** The least a stored row must have. The dashboard's own row type is richer. */
export interface HasSignature {
  readonly signature: string;
}

/** At most this many rows are kept in a tab: a bound on memory, not on history. */
export const MAX_STORED_ENTRIES = 500;

const cap = <T>(rows: readonly T[]): T[] => (rows.length <= MAX_STORED_ENTRIES ? [...rows] : rows.slice(0, MAX_STORED_ENTRIES));

/** Newest first, one row per signature, the FIRST occurrence winning. */
function dedupe<T extends HasSignature>(rows: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    if (seen.has(row.signature)) continue;
    seen.add(row.signature);
    out.push(row);
  }
  return out;
}

export interface HeadPage<T extends HasSignature> {
  readonly entries: readonly T[];
  /** The server could not see how much it missed: the head is replaced, not merged. */
  readonly gap: boolean;
}

/**
 * A fresh head page on top of what is held. The page's rows come first, so a row
 * read again replaces the copy already on screen.
 */
export function mergeHead<T extends HasSignature>(existing: readonly T[], page: HeadPage<T>): T[] {
  if (page.gap) return cap(dedupe(page.entries));
  return cap(dedupe([...page.entries, ...existing]));
}

/** An older page, appended under what is held ("Load older"). */
export function appendOlder<T extends HasSignature>(existing: readonly T[], older: readonly T[]): T[] {
  return cap(dedupe([...existing, ...older]));
}

/** The newest signature held, which is what the next poll asks `until`. */
export const newestSignature = <T extends HasSignature>(rows: readonly T[]): string | null => rows[0]?.signature ?? null;

export interface HeadCursorInput {
  /** The request carried `until`: it asked only for what is NEW, not for the history. */
  readonly polled: boolean;
  /** More landed than one page holds, so the head was REPLACED rather than merged. */
  readonly gap: boolean;
  /** The cursor this page answered with. */
  readonly page: string | null;
  /** The cursor already held, from the last page that actually defined one. */
  readonly held: string | null;
}

/**
 * WHERE THE LOADED HISTORY ENDS, once a page has arrived.
 *
 * A POLL IS NOT ENTITLED TO AN OPINION ABOUT THIS. It asks `until` the newest
 * row already held, so a quiet minute answers an empty list — and the route
 * reads any under-full list as "nothing more to page", which is true of the
 * poll's own window and false of the history behind it.
 *
 * Taking that null would mark a PARTIAL history complete, with two visible
 * consequences: the stats would sum the one loaded page and present it as Today
 * and This week — smaller numbers wearing complete ones' names — and Load older
 * would refuse to page back at all, its cursor having been erased.
 *
 * So a poll keeps the cursor the head page defined. Only a page that really
 * defines the tail sets it: a first read, or a poll whose `gap` replaced the
 * head outright and with it everything the old cursor pointed past.
 */
export function headCursor(input: HeadCursorInput): string | null {
  return !input.polled || input.gap ? input.page : input.held;
}
