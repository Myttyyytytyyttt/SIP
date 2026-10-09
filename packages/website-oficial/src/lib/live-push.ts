/**
 * THE CHAIN RINGS, THE DASHBOARD READS (owner, 2026-10-09: "hago una trade y si
 * vuelvo a saverfi no veo nada en processing… solo si hago refresh").
 *
 * The live dashboard used to learn of a change only from its own poll: once a
 * minute while the tab was visible, never while it was hidden. Now one
 * WebSocket per open live dashboard (src/lib/live-socket.ts) subscribes to the
 * accounts a change would show up in — each linked trading wallet, the vault,
 * and the vault's USDC and wSOL accounts — on the KEY-FREE public endpoint
 * the browser already uses for Privy (config.solanaWsUrl). A notification
 * says only "this account changed at slot S"; this module decides what that
 * buys, and it is pure so the whole policy is a table a test can pin.
 *
 * ONE NOTIFICATION, OR A BURST OF THEM, IS ONE READ. A settle lands SOL in the
 * vault and changes the wallet in the same slot, and a wrap follows a moment
 * later: the first change opens a PUSH_DEBOUNCE_MS window, everything inside
 * it rides along, and the read happens once at its end.
 *
 * IT NEVER BUYS A READ THE SCHEDULE WOULD REFUSE. Never sooner than
 * MANUAL_FLOOR_MS after the previous read, never before a retry-after the
 * server named (the snapshot's own, or the history's, which every read also
 * asks for), never while the reads are backing off after failures — then the
 * backoff's own read clears the change — and never while a read is in flight
 * (that read re-arms this when it finishes).
 *
 * A BUSY TRADER DOES NOT BUY A READ PER TRADE. A trading wallet changes with
 * every trade — measured on mainnet, a busy account rang once a slot, 325
 * times in 150 s — and a read costs at least five of the 60 tokens a minute
 * one address gets (/api/solana-live), shared by every tab it has open. So
 * only an URGENT change waits the manual floor: the vault or its token
 * accounts (the keeper's own steps), or a wallet's FIRST change since its last
 * saving — the one that puts "checking your latest activity" up. Any other
 * change of a wallet already being checked waits PUSH_WALLET_FLOOR_MS. Worst
 * case per tab: six reads a minute while the vault itself changes every few
 * seconds, which only the keeper and deposits do; two a minute for a wallet
 * that trades continuously (three while a step's faster poll runs). The poll
 * alone is one.
 *
 * A HIDDEN TAB STILL LISTENS AND DOES NOT READ. The socket costs the keyed RPC
 * nothing; a read does. So a change while hidden is remembered, and the tab
 * reads the moment it is looked at again (showReadWanted).
 *
 * A CHANGE IS COVERED BY A READ AT OR PAST ITS SLOT. The snapshot names the
 * slot it read at; a read that answered from before the change (a node a slot
 * behind the public one) leaves the change standing, and the next read after
 * the floor picks it up. A wallet's change is only handed to the page — for
 * the "checking your latest activity" step (live-pending.ts) — once a read at
 * or past its slot ALSO read the history, because the keeper's own settlement
 * changes the wallet too, and only the history can tell the page it was that.
 */

import { USDC_MINT, WSOL_MINT } from "@sip/solana-core/client";

import { MEASURING_HIDE_MS } from "@/lib/live-pending";
import { MANUAL_FLOOR_MS } from "@/lib/live-schedule";
import type { LiveEntryJson, LiveSnapshotJson, LiveWalletChange } from "@/lib/live-types";

/** A change opens a window this long; everything inside it is one read. */
export const PUSH_DEBOUNCE_MS = 1_500;

/** The floor for a change that is not urgent: a wallet already being checked trading again. */
export const PUSH_WALLET_FLOOR_MS = 30_000;

/**
 * How long a wallet's change is kept once a read has seen it: as long as any
 * row shows it (live-pending.ts MEASURING_HIDE_MS). Past it nothing would draw
 * it, and a change after that starts its own clock.
 */
export const WALLET_CHANGE_FORGET_MS = MEASURING_HIDE_MS;

/** The most addresses one dashboard subscribes to: the snapshot's ten wallets, the vault and two token accounts. */
export const MAX_WATCHED = 13;

/**
 * WHAT ONE DASHBOARD WATCHES, sorted so the same set is the same string.
 *
 * Only wallets whose link says THIS vault: a wallet saving elsewhere, or not
 * linked at all, cannot produce a saving here, and its trades are not this
 * page's to announce. The token accounts are watched whether or not they exist
 * yet: the vault's first conversion creates its USDC account, and a
 * subscription to an address with no account rings when one appears.
 */
export function watchedAddresses(snapshot: LiveSnapshotJson | null): string[] {
  if (snapshot === null || snapshot.vault.status !== "exists") return [];
  const tokens = snapshot.vaultTokenAccounts.items.filter((item) => item.mint === USDC_MINT || item.mint === WSOL_MINT).map((item) => item.address);
  return [...new Set([...watchedWallets(snapshot), snapshot.vault.address, ...tokens])].sort();
}

/** The trading wallets among them: a change to one of these is somebody's activity, not the keeper's machinery. */
export function watchedWallets(snapshot: LiveSnapshotJson | null): string[] {
  if (snapshot === null || snapshot.vault.status !== "exists") return [];
  const out = new Set<string>();
  for (const wallet of snapshot.wallets) if (wallet.link.status === "this_vault") out.add(wallet.wallet);
  for (const link of snapshot.links?.items ?? []) out.add(link.wallet);
  return [...out].sort().slice(0, MAX_WATCHED - 3);
}

/** A wallet the push saw change, and what reads have made of it. */
export interface WalletWatch {
  /** The newest slot a notification named that no read has covered yet; null when none is outstanding. */
  readonly pendingSlot: number | null;
  /**
   * The newest change a read covered — at or past its slot, with the history
   * read. `atMs` is the server's clock at the read that covered the FIRST
   * change since the wallet's last saving (or since the last one was
   * forgotten): later changes move the slot, never the clock, so a wallet that
   * keeps trading cannot keep a loader turning. `open` is whether, at the last
   * read, nothing had ended it yet (a settlement at or past it, or the link's
   * frontier).
   */
  readonly covered: { readonly slot: number; readonly atMs: number; readonly open: boolean } | null;
}

export interface PushState {
  /**
   * Something changed that no read has covered yet: since when (this browser's
   * clock), the newest slot named, and whether any of it was urgent (the
   * floor it waits).
   */
  readonly dirty: { readonly since: number; readonly slot: number; readonly urgent: boolean } | null;
  readonly wallets: Readonly<Record<string, WalletWatch>>;
}

export const EMPTY_PUSH: PushState = { dirty: null, wallets: {} };

/**
 * One notification. `wallet` is true when the address is a trading wallet
 * (rather than the vault or one of its token accounts). The window opens at
 * the FIRST uncovered change and later ones do not move it: a chain that keeps
 * changing must not postpone its own read forever.
 */
export function notified(state: PushState, input: { readonly address: string; readonly slot: number; readonly now: number; readonly wallet: boolean }): PushState {
  const held = input.wallet ? (state.wallets[input.address] ?? { pendingSlot: null, covered: null }) : null;
  // Urgent: the vault's machinery, or a wallet not already being checked.
  const urgent = held === null || held.covered?.open !== true;
  const dirty =
    state.dirty === null
      ? { since: input.now, slot: input.slot, urgent }
      : { since: state.dirty.since, slot: Math.max(state.dirty.slot, input.slot), urgent: state.dirty.urgent || urgent };
  if (held === null) return { ...state, dirty };
  const pendingSlot = Math.max(held.pendingSlot ?? input.slot, input.slot);
  return { dirty, wallets: { ...state.wallets, [input.address]: { ...held, pendingSlot } } };
}

/**
 * The socket came back after a gap: whatever changed while it was down rang
 * nobody. One read covers it — slot 0, so any answer at all does — and that
 * read compares each wallet's balance with the last read's (movedSince).
 */
export const resynced = (state: PushState, now: number): PushState => ({ ...state, dirty: state.dirty ?? { since: now, slot: 0, urgent: false } });

/**
 * WHAT A WALLET HELD AT THE LAST READ: its balance and its link's settlement
 * count, at the slot that read answered from.
 *
 * The push hears a change only while its socket is open. A change made while
 * it was not — the page left for /wallets and came back, or a phone dropped
 * the backgrounded socket — rang nobody, but it moved the wallet's balance
 * (every transaction the wallet signs pays its fee). So each read compares the
 * balance with the previous one, and a wallet that moved is taken as changed
 * at the earliest slot it could have: the slot after the previous read. That
 * lower bound is what keeps it honest — a settlement or a frontier at or past
 * it ends the step — and a link whose settlement count moved in between is not
 * taken at all: the keeper's own settlement moved the balance, and whatever
 * else happened is left to the socket.
 *
 * A fresh tab or a reload has no previous read, and starts from this one.
 */
export interface LamportsBaseline {
  readonly slot: number;
  readonly wallets: Readonly<Record<string, { readonly lamports: string; readonly nonce: string | null }>>;
}

export function baselineOf(snapshot: LiveSnapshotJson): LamportsBaseline | null {
  if (snapshot.slot === null || snapshot.vault.status !== "exists") return null;
  const linked = new Set(watchedWallets(snapshot));
  const wallets: Record<string, { lamports: string; nonce: string | null }> = {};
  for (const wallet of snapshot.wallets) {
    if (!linked.has(wallet.wallet) || wallet.lamports === null) continue;
    wallets[wallet.wallet] = { lamports: wallet.lamports, nonce: wallet.link.settlementNonce };
  }
  return { slot: snapshot.slot, wallets };
}

/** The wallets whose balance moved since `baseline`, each at the earliest slot it could have. */
export function movedSince(baseline: LamportsBaseline | null, snapshot: LiveSnapshotJson): { readonly wallet: string; readonly slot: number }[] {
  const now = baselineOf(snapshot);
  if (baseline === null || now === null || now.slot <= baseline.slot) return [];
  const moved: { wallet: string; slot: number }[] = [];
  for (const [wallet, held] of Object.entries(now.wallets)) {
    const before = baseline.wallets[wallet];
    if (before === undefined || before.lamports === held.lamports) continue;
    // A settlement in between explains the move, or hides what else did: not taken.
    if (before.nonce === null || held.nonce === null || before.nonce !== held.nonce) continue;
    moved.push({ wallet, slot: baseline.slot + 1 });
  }
  return moved;
}

/** Changes found by a read rather than heard: outstanding, like a notification, unless a newer one already is. */
export function heardLate(state: PushState, moved: readonly { readonly wallet: string; readonly slot: number }[]): PushState {
  if (moved.length === 0) return state;
  const wallets = { ...state.wallets };
  for (const { wallet, slot } of moved) {
    const held = wallets[wallet] ?? { pendingSlot: null, covered: null };
    if ((held.pendingSlot ?? -1) >= slot || (held.covered?.slot ?? -1) >= slot) continue;
    wallets[wallet] = { ...held, pendingSlot: slot };
  }
  return { ...state, wallets };
}

/**
 * WHERE EACH WALLET'S LAST SAVING LEFT IT, as one read sees it: the newer of
 * its link's frontier and its newest successful settlement among `entries`.
 * A change at or before it is ended.
 */
export function walletEnds(snapshot: LiveSnapshotJson, entries: readonly LiveEntryJson[]): Record<string, number> {
  const ends: Record<string, number> = {};
  const raise = (wallet: string, slot: number): void => {
    if (Number.isSafeInteger(slot) && slot > (ends[wallet] ?? -1)) ends[wallet] = slot;
  };
  for (const wallet of snapshot.wallets) if (wallet.link.frontierSlot !== null) raise(wallet.wallet, Number(wallet.link.frontierSlot));
  for (const link of snapshot.links?.items ?? []) raise(link.wallet, Number(link.frontierSlot));
  for (const entry of entries) {
    if (!entry.ok) continue;
    for (const event of entry.events) if (event.kind === "settled") raise(event.wallet, entry.slot);
  }
  return ends;
}

/**
 * WHAT A READ THAT ANSWERED COVERED. `slot` is the snapshot's; null when it
 * named none, and then the change is taken as covered rather than read again
 * and again over a field the server could not fill. `historyRead` is whether
 * the same read also read the vault's history: without it a wallet's change
 * stays outstanding, because the history is what tells a trade from the
 * keeper's own settlement. `readAtMs` is the server's clock, the one the page
 * times every step by.
 */
export function afterRead(
  state: PushState,
  input: {
    readonly slot: number | null;
    readonly historyRead: boolean;
    readonly readAtMs: number;
    /** Each wallet's end as this read sees it (walletEnds); a wallet missing from it has none known. */
    readonly ends?: Readonly<Record<string, number>>;
  },
): PushState {
  const reached = (slot: number): boolean => input.slot === null || input.slot >= slot;
  const dirty = state.dirty !== null && !reached(state.dirty.slot) ? state.dirty : null;
  const ended = (address: string, slot: number): boolean => {
    const end = input.ends?.[address];
    return end !== undefined && end >= slot;
  };
  const wallets: Record<string, WalletWatch> = {};
  for (const [address, watch] of Object.entries(state.wallets)) {
    const held = watch.covered;
    // Still the same stretch: something covered, nothing has ended it, and still drawn.
    const ongoing = held !== null && held.open && !ended(address, held.slot) && input.readAtMs - held.atMs <= WALLET_CHANGE_FORGET_MS;
    let next: WalletWatch = held === null ? watch : { ...watch, covered: { ...held, open: ongoing } };
    if (watch.pendingSlot !== null && input.historyRead && reached(watch.pendingSlot)) {
      const slot = watch.pendingSlot;
      next = { pendingSlot: null, covered: { slot, atMs: ongoing && held !== null ? held.atMs : input.readAtMs, open: !ended(address, slot) } };
    }
    // Forgotten once it is old and nothing is outstanding.
    if (next.pendingSlot === null && (next.covered === null || input.readAtMs - next.covered.atMs > WALLET_CHANGE_FORGET_MS)) continue;
    wallets[address] = next;
  }
  return { dirty, wallets };
}

/** The changes the page may draw: covered ones only, newest slot per wallet. */
export const walletChangesOf = (state: PushState): LiveWalletChange[] =>
  Object.entries(state.wallets).flatMap(([wallet, watch]) => (watch.covered === null ? [] : [{ wallet, slot: watch.covered.slot, sinceMs: watch.covered.atMs }]));

export interface PushReadInput {
  readonly dirty: PushState["dirty"];
  readonly now: number;
  /** When the last read finished (success or failure); null when none has. */
  readonly lastReadAt: number | null;
  readonly visible: boolean;
  readonly reading: boolean;
  /** Consecutive failed reads: while any, the poll's backoff decides and a push buys nothing. */
  readonly failures: number;
  /** The latest moment a server said not to ask before (the snapshot's or the history's retry-after); null when none. */
  readonly retryAt: number | null;
}

/**
 * Milliseconds until the read a change buys, or NULL for "none to schedule":
 * nothing changed, the tab is hidden, a read is in flight, or the reads are
 * backing off.
 */
export function pushReadDelayMs(input: PushReadInput): number | null {
  if (input.dirty === null || !input.visible || input.reading || input.failures > 0) return null;
  const debounce = input.dirty.since + PUSH_DEBOUNCE_MS - input.now;
  const floor = input.lastReadAt === null ? 0 : input.lastReadAt + (input.dirty.urgent ? MANUAL_FLOOR_MS : PUSH_WALLET_FLOOR_MS) - input.now;
  const retry = input.retryAt === null ? 0 : input.retryAt - input.now;
  return Math.max(0, debounce, floor, retry);
}

/**
 * COMING BACK TO THE TAB (visibilitychange to visible, or window focus): read
 * at once when the last read is MANUAL_FLOOR_MS old — not a whole sweep, which
 * is what made a trade made in another tab invisible here until a reload — and
 * nothing that would ask before a retry-after, or through a backoff (the
 * poll's own timer, re-armed on the same event, decides that). A change the
 * socket heard while the tab was hidden is read by pushReadDelayMs the moment
 * the tab is visible, under the same floor.
 */
/**
 * WHAT OUTLIVES A REMOUNT. The dashboard's hook remounts whenever someone
 * walks to /wallets and back; the changes the push heard, and the balances
 * the last read saw, are kept per pension key for as long as the tab lives —
 * so a trade made while the page was away is still found when it comes back.
 * Only a caller that draws the history keeps them (the leaderboard's chip
 * reads a snapshot too, and must not move the baseline the dashboard compares
 * against).
 */
export interface PushMemory {
  readonly push: PushState;
  readonly baseline: LamportsBaseline | null;
}

const memories = new Map<string, PushMemory>();

export const recallPush = (key: string): PushMemory => memories.get(key) ?? { push: EMPTY_PUSH, baseline: null };

export function rememberPush(key: string, memory: Partial<PushMemory>): void {
  memories.set(key, { ...recallPush(key), ...memory });
}

export function showReadWanted(input: { readonly lastReadAt: number | null; readonly now: number; readonly failures: number; readonly retryAt: number | null }): boolean {
  if (input.failures > 0) return false;
  if (input.retryAt !== null && input.retryAt > input.now) return false;
  return input.lastReadAt === null || input.now - input.lastReadAt >= MANUAL_FLOOR_MS;
}
