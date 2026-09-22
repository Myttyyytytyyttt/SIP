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
 * goes and gets it ITSELF instead of waiting for someone to press "Load
 * older". (The second answer is in live-model.ts: whatever the history holds,
 * nothing is claimed that the state contradicts.)
 *
 * AND IT LOOKS WHERE THE SETTLEMENTS ARE, which is not the vault. Only
 * link_wallet, settle and unlink_wallet ever touch a wallet's TradingLink, so
 * that stream is nearly pure settlements while the vault's is mostly the
 * keeper's own upkeep. The same two pages now buy thirty settlements instead of
 * thirty rent top-ups, at the identical cost — and the rows come back through
 * the same route, scoped per entry to this vault by the program's own words
 * (scopeEntryToVault), because a link is keyed by the wallet and one address's
 * stream can span two vaults' lives.
 *
 * WHAT IT READS IS KEPT APART FROM THE VAULT'S HISTORY, deliberately, and the
 * hook never merges the two lists. Every window total on the screen rests on
 * the vault page being a CONTIGUOUS slice of one stream; a wallet-scoped page
 * is not, and merging it would move the oldest loaded settlement backwards
 * while leaving holes above it — a sum of some of a window wearing the whole
 * window's name.
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
import type { LiveEntryJson, LiveLinkActivityJson, LiveSnapshotJson } from "@/lib/live-types";
import type { ApiFailure, ApiResult } from "@/lib/vault-api";

/**
 * Pages one backfill round may ask for, ACROSS ALL WALLETS. Two, because a
 * client has 60 read tokens a minute and the mount read already spends about
 * 21 of them; a page is 1 + one per transaction, so two are up to 32 more.
 */
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
  /**
   * How many wallets' links there are to page: settlementWallets().length.
   *
   * This REPLACED the vault's own `nextBefore` cursor, and the difference is the
   * point. A link stream starts at its own head with no `before`, so the vault's
   * cursor says nothing about whether there is anything to ask — and an absent
   * cursor used to read as "there is more", which sent the round re-fetching the
   * head page at 18 tokens a time.
   */
  readonly wallets: number;
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

/** Whether this read should page the links for the settlement the state records. */
export function shouldBackfill(input: BackfillDecision): boolean {
  if (!input.chainSettled || input.loadedHasSettlement) return false;
  if (input.wallets === 0 || input.manualBusy || input.done) return false;
  // A round cut short by 429 must not be retried into the same empty bucket:
  // the limiter refills at one token a second, and the failure said how long.
  if (input.retryAt !== null && input.now < input.retryAt) return false;
  return input.rounds < BACKFILL_ROUNDS;
}

/** The wallets whose links this vault's settlements can be in, most useful first. */
export function settlementWallets(snapshot: LiveSnapshotJson, max = 2): string[] {
  const out: string[] = [];
  const add = (wallet: string): void => {
    if (out.length < max && !out.includes(wallet)) out.push(wallet);
  };
  // A link that has counted a settlement leads: it is the one that certainly
  // has something to find. `links.items` is read by a memcmp on the vault
  // field, so every link in it is this vault's by construction.
  for (const link of snapshot.links?.items ?? []) if (positive(link.settlementNonce)) add(link.wallet);
  for (const wallet of snapshot.wallets) if (wallet.link.status === "this_vault" && positive(wallet.link.settlementNonce)) add(wallet.wallet);
  // Then any link of this vault at all: a nonce nobody could read is not a zero.
  for (const link of snapshot.links?.items ?? []) add(link.wallet);
  for (const wallet of snapshot.wallets) if (wallet.link.status === "this_vault") add(wallet.wallet);
  return out;
}

export interface LinkRoundOutcome {
  /** The rows the round read, newest first within each wallet. */
  readonly entries: readonly LiveEntryJson[];
  readonly pages: number;
  /** A settlement was found. */
  readonly found: boolean;
  /** The POST failed. The round is not the answer, and may be retried once. */
  readonly failure: ApiFailure | null;
  /** The route answered 200 saying it could not read the history — not an empty one either. */
  readonly unreadable: boolean;
}

/**
 * Page each wallet's LINK for the settlements the vault's own total records.
 *
 * WHY THE LINK AND NOT THE VAULT. Only link_wallet, settle and unlink_wallet
 * ever touch a TradingLink, so its signature stream is nearly pure
 * settlements — while the vault PDA's newest fifteen were twelve keeper upkeep
 * on the day this was written. The same two pages that bought thirty upkeep
 * rows buy thirty settlements, at the identical cost.
 *
 * EACH WALLET STARTS AT ITS OWN HEAD, with no `before`: a link cursor and a
 * vault cursor are different streams and one may never be handed to the other.
 *
 * THE BUDGET IS THE ROUND'S, NOT EACH WALLET'S. `maxPages` is spent across them
 * in order, so two wallets cost what one did.
 */
export async function backfillLinkSettlements(input: {
  readonly wallets: readonly string[];
  readonly maxPages?: number;
  readonly fetchPage: (wallet: string, before: string | null) => Promise<ApiResult<LiveLinkActivityJson>>;
}): Promise<LinkRoundOutcome> {
  const maxPages = input.maxPages ?? BACKFILL_PAGES;
  const entries: LiveEntryJson[] = [];
  let pages = 0;
  let found = false;

  for (const wallet of input.wallets) {
    let cursor: string | null = null;
    // eslint-disable-next-line no-constant-condition
    while (pages < maxPages) {
      const page: ApiResult<LiveLinkActivityJson> = await input.fetchPage(wallet, cursor);
      pages += 1;
      if (!page.ok) return { entries, pages, found, failure: page, unreadable: false };
      // A history nobody could read is not an empty one: stop, and say which.
      if (page.body.status !== "exists") return { entries, pages, found, failure: null, unreadable: true };
      entries.push(...page.body.entries);
      if (holdsSettlement(page.body.entries)) found = true;
      cursor = page.body.nextBeforeLink;
      // This wallet's stream reaches its beginning: nothing older to ask it for.
      if (cursor === null) break;
    }
    if (pages >= maxPages) break;
  }

  return { entries, pages, found, failure: null, unreadable: false };
}
