/**
 * THE SETTLEMENT THE STATE KNOWS ABOUT, FETCHED RATHER THAN DENIED.
 *
 * A page of history is fifteen SIGNATURES, not fifteen settlements, and the
 * vault's newest signatures are mostly the keeper's own upkeep. On 2026-09-19
 * twelve of the fifteen newest were upkeep and the one real settlement sat at
 * position 24, so the dashboard drew "SETTLEMENTS 1 — 0 in loaded history",
 * "LAST SETTLEMENT none yet" and "The chart starts with your first settlement"
 * over a pension that had settled nineteen hours earlier.
 *
 * Two answers to that, and this module is the first: when the CHAIN'S OWN STATE
 * says a settlement happened — the vault's lifetimeSaved moved, or a link's
 * settlement nonce counted one — and the loaded page holds none, the dashboard
 * pages back for it ITSELF instead of waiting for someone to press "Load
 * older". (The second answer is in live-model.ts: whatever the history holds,
 * nothing is claimed that the state contradicts.)
 *
 * BOUNDED, BECAUSE READS ARE RATIONED. A client has 60 read tokens a minute
 * (DEFAULT_RELAY_LIMITS.perClientPerMin); the mount read already spends a
 * snapshot (4, or 5 discovering links) plus a page (1 + one per transaction,
 * so up to 16). BACKFILL_PAGES is 2 — at most 32 more tokens, ~53 of the 60 in
 * that minute — and BACKFILL_ROUNDS caps it at two rounds per pension key, the
 * second only reachable when the first was cut short by a failure. A poll never
 * pays it twice: a round that came back cleanly is the end of it, whether or
 * not it found the settlement, and only a different pension key starts again.
 *
 * ONE READER OF THE TAIL. The decision stands down while a manual "Load older"
 * is in flight, and the hook holds the same busy flag for the backfill's own
 * duration, so the two cannot page from the same cursor at once.
 *
 * Pure and transport-free: `fetchPage` is the dashboard's own api.activity, so
 * the backfill goes through the same route, the same limiter and the same
 * failure words as every other read.
 */

import { rawFrom } from "@/lib/amounts";
import type { LiveActivityJson, LiveEntryJson, LiveSnapshotJson } from "@/lib/live-types";
import type { ApiFailure, ApiResult } from "@/lib/vault-api";

/** Older pages one backfill round may ask for, beyond the page it starts from. */
export const BACKFILL_PAGES = 2;
/** Rounds one pension key may spend. The second exists only to retry a round a failure cut short. */
export const BACKFILL_ROUNDS = 2;

const positive = (text: string | null | undefined): boolean => (rawFrom(text) ?? 0n) > 0n;

/**
 * THE CHAIN'S OWN STATE says this pension has settled at least once — which is
 * a different fact from what the loaded signatures happen to show, and the one
 * the screen must not contradict.
 *
 * Either witness is enough: the vault's lifetimeSaved, which only ever moves on
 * a settlement, or a link's settlement nonce, which counts them. A nonce nobody
 * could read is not a zero, so it simply does not vote.
 */
export function chainSaysSettled(snapshot: LiveSnapshotJson): boolean {
  if (positive(snapshot.vault.state?.lifetimeSaved)) return true;
  if (snapshot.wallets.some((wallet) => positive(wallet.link.settlementNonce))) return true;
  return (snapshot.links?.items ?? []).some((link) => positive(link.settlementNonce));
}

/** Whether any loaded row IS a settlement. The events are the route's own classification. */
export const holdsSettlement = (entries: readonly LiveEntryJson[]): boolean =>
  entries.some((entry) => entry.events.some((event) => event.kind === "settled"));

export interface BackfillDecision {
  /** The state says a settlement exists: chainSaysSettled(). */
  readonly chainSettled: boolean;
  /** The loaded history already holds one, so there is nothing to go looking for. */
  readonly loadedHasSettlement: boolean;
  /** Where the loaded history ends. Null means it reaches the beginning: there is no older page. */
  readonly cursor: string | null;
  /** A manual "Load older" is in flight. It owns the tail; the backfill stands down. */
  readonly manualBusy: boolean;
  /** Rounds already spent on this pension key. */
  readonly rounds: number;
  /** A round already came back without failing: the answer is known, and asking again buys nothing. */
  readonly done: boolean;
}

/** Whether this read should page back for the settlement the state records. */
export function shouldBackfill(input: BackfillDecision): boolean {
  if (!input.chainSettled || input.loadedHasSettlement) return false;
  if (input.cursor === null || input.manualBusy || input.done) return false;
  return input.rounds < BACKFILL_ROUNDS;
}

export interface BackfillOutcome {
  /** The rows the round read, newest first, to append under what is already held. */
  readonly entries: readonly LiveEntryJson[];
  /** Where the history ends now: null when the round reached the beginning. A page that failed does not move it. */
  readonly cursor: string | null;
  readonly pages: number;
  /** A settlement was found, so the round stopped there. */
  readonly found: boolean;
  /** The POST failed. The round is not the answer, and may be retried once. */
  readonly failure: ApiFailure | null;
  /** The route answered 200 saying it could not read the history — which is not an empty one either. */
  readonly unreadable: boolean;
}

/**
 * Page back from `cursor`, at most `maxPages` pages, stopping at the first page
 * that holds a settlement.
 *
 * EVERY ROW IT READ COMES BACK, even from a round a failure cut short: the
 * pages that did land are history the screen would otherwise have to read
 * again. The cursor moves only for pages that actually arrived, so a manual
 * "Load older" afterwards continues from where this stopped rather than
 * repeating it or skipping past it.
 */
export async function backfillSettlements(input: {
  readonly cursor: string;
  readonly maxPages?: number;
  readonly fetchPage: (before: string) => Promise<ApiResult<LiveActivityJson>>;
}): Promise<BackfillOutcome> {
  const maxPages = input.maxPages ?? BACKFILL_PAGES;
  const entries: LiveEntryJson[] = [];
  let cursor: string | null = input.cursor;
  let pages = 0;

  while (cursor !== null && pages < maxPages) {
    const page: ApiResult<LiveActivityJson> = await input.fetchPage(cursor);
    pages += 1;
    if (!page.ok) return { entries, cursor, pages, found: false, failure: page, unreadable: false };
    // A history nobody could read is not an empty one: stop, and say which it was.
    if (page.body.status !== "exists") return { entries, cursor, pages, found: false, failure: null, unreadable: true };
    entries.push(...page.body.entries);
    cursor = page.body.nextBefore;
    if (holdsSettlement(page.body.entries)) return { entries, cursor, pages, found: true, failure: null, unreadable: false };
  }

  return { entries, cursor, pages, found: false, failure: null, unreadable: false };
}
