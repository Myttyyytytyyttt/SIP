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

/** What a backfill has already spent on one pension key. */
export interface BackfillSpend {
  rounds: number;
  /** A round came back without failing: the answer is known, found or not. */
  done: boolean;
  /** When a failed round said it could be retried. Round two waits for it. */
  retryAt: number | null;
}

const SPENT = new Map<string, BackfillSpend>();

/**
 * WHAT THIS TAB HAS ALREADY SPENT ON `pensionKey` — held in the module, not in
 * the hook, because the hook's refs die with the component and what they were
 * counting is real read tokens.
 *
 * The app has separate routes (/, /activity, /wallets), so walking away and
 * back REMOUNTS the hook. With the count in a ref, every remount re-paid the
 * whole round: a mount already costs snapshotDiscover (5) plus a page (1 + up
 * to 15), and two backfill pages are 32 more — about 53 of the 60 read tokens a
 * client gets in a minute, refilling at one a second. A second mount ten
 * seconds later found roughly 17, and it was the ACTIVITY PAGE that got
 * refused: spendReads(1) passed, spendMore(15) did not, and the feed said the
 * history could not be read. Two mounts cost 42 before this existed and both
 * went through.
 *
 * So a clean round is paid ONCE per pension key per tab. The rows it fetched do
 * die with the component, and they are not bought again: the screen says
 * plainly that the settlement is older than the loaded history, which is true
 * and costs nothing, and "Load older" is there for anyone who wants them back.
 *
 * SAFE AT MODULE SCOPE because the read path only ever runs from an effect —
 * nothing here is touched while a page is rendered on the server, so one
 * process's map is never shared between two people's pension keys.
 */
export function backfillSpend(pensionKey: string): BackfillSpend {
  const held = SPENT.get(pensionKey);
  if (held !== undefined) return held;
  const fresh: BackfillSpend = { rounds: 0, done: false, retryAt: null };
  SPENT.set(pensionKey, fresh);
  return fresh;
}

/**
 * Forget what was spent on this key, because the history it bought is gone.
 *
 * A head page carrying `gap` REPLACES the whole store (mergeHead), throwing
 * away every older page underneath it — and on this vault a gap is not exotic:
 * it is what happens whenever more than fifteen signatures land between two
 * polls, and most of its signatures are keeper upkeep. Without this the loaded
 * history holds no settlement again while the state still says one exists, the
 * card falls back to saying so, and a latched `done` means the two cheap pages
 * that would fix it are never asked for again until the tab is reloaded.
 */
export function forgetBackfillSpend(pensionKey: string): void {
  SPENT.delete(pensionKey);
}

const positive = (text: string | null | undefined): boolean => (rawFrom(text) ?? 0n) > 0n;

/**
 * THE CHAIN'S OWN STATE says this pension has settled at least once — which is
 * a different fact from what the loaded signatures happen to show, and the one
 * the screen must not contradict.
 *
 * Either witness is enough: the vault's lifetimeSaved, which only ever moves on
 * a settlement, or a link's settlement nonce, which counts them. A nonce nobody
 * could read is not a zero, so it simply does not vote.
 *
 * AND THE LINK HAS TO BE THIS VAULT'S. A Privy wallet seated in an OLDER vault
 * is read here with status "other_vault" and its own nonce (readers.ts), and
 * re-seating one is a thing this app does. Counting that nonce would send every
 * mount of a brand-new vault paging back through two pages — up to 32 of the
 * client's 60 read tokens a minute, on a read path already spending ~21 — for a
 * settlement that cannot be in this vault's history at all. live-model.ts
 * scopes its own claim the same way (`linkStatus === "this_vault"`), so the
 * screen said "none yet" while the fetch went looking anyway.
 *
 * `links.items` needs no such filter: that list is read by a memcmp on the
 * vault field, so every link in it is this vault's by construction.
 */
export function chainSaysSettled(snapshot: LiveSnapshotJson): boolean {
  if (positive(snapshot.vault.state?.lifetimeSaved)) return true;
  if (snapshot.wallets.some((wallet) => wallet.link.status === "this_vault" && positive(wallet.link.settlementNonce))) return true;
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
  /** When the last round's failure said it could be retried, or null. */
  readonly retryAt: number | null;
  /** The read's own clock, so the rule stays pure. */
  readonly now: number;
}

/** Whether this read should page back for the settlement the state records. */
export function shouldBackfill(input: BackfillDecision): boolean {
  if (!input.chainSettled || input.loadedHasSettlement) return false;
  if (input.cursor === null || input.manualBusy || input.done) return false;
  // A round cut short by 429 must not be retried into the same empty bucket:
  // the limiter refills at one token a second, and the failure said how long.
  if (input.retryAt !== null && input.now < input.retryAt) return false;
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
