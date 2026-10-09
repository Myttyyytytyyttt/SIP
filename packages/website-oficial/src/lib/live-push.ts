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
 *
 * AND A READ COVERS WHAT IT COULD SEE, NOT THE NEWEST SLOT NAMED (review
 * 2026-10-09). A read takes its snapshot first and lands a second or so later,
 * and the notifications that arrived meanwhile are already in the state it is
 * applied to. Judged by the NEWEST slot named, a wallet that rings every slot
 * was never covered: every read was "behind", every change was the wallet's
 * first, and a busy trader bought a read every 10 s while "checking your latest
 * activity" never came up. So each wallet keeps the slots still outstanding
 * (WalletWatch.pending), a read covers the newest of them at or under its
 * snapshot's slot, and what came after stays outstanding as the remainder —
 * not urgent once the wallet is being checked, so it waits
 * PUSH_WALLET_FLOOR_MS like any later trade.
 *
 * AND A VAULT'S CHANGE ONLY ONCE THE HISTORY SHOWS IT TOO (diagnosis 10-09,
 * push D4). The snapshot is one getMultipleAccounts and the history a separate
 * getSignaturesForAddress, possibly answered by another node of the pool: a
 * read could take the vault's new balance and a page that has not indexed the
 * settle yet, clear the change, and leave the settled row to the next sweep a
 * minute later. So a change the vault or its token accounts rang for is
 * covered only when the history the read holds reaches its slot; otherwise it
 * stays for ONE follow-up read after the floor, and that read covers it
 * whatever its history says — a plain USDC transfer into the vault's token
 * account need not appear in the vault's own history at all, and must not buy
 * a read a minute.
 *
 * A HISTORY AHEAD OF ITS SNAPSHOT IS READ AGAIN AT ONCE (diagnosis 10-09,
 * inventory D4). Each read takes the snapshot first and the history second; a
 * settle landing between the two draws its "+$0.43" in the feed beside a Saved
 * so far, a Pending and a Next investment that do not have it, until a read at
 * least the 10 s floor later. historyAhead() names that case, and the hook
 * reads the snapshot once more inside the same read.
 *
 * AND THE PAGE CAN SAY WHAT IT HEARD BEFORE ANY READ HAS (UI plan 10-09, §5
 * item 2: "Trading wallet 1: activity seen on Solana" before the covering
 * read). heardOf() names the URGENT changes still outstanding — the vault's
 * own, and a wallet's first since its last saving — with the moment the
 * first of them was heard and the wallets among them. Each change keeps the
 * moment it was heard (PushState.heard), because a read can cover the first
 * of them and leave a later one, and "since when" is then the later one's.
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

/**
 * The most outstanding slots one wallet keeps. Past it the oldest stays and
 * the ones after it give way: a read whose snapshot is behind every newer slot
 * still covers the oldest, so it covers SOMETHING, and a hidden tab listening
 * to a wallet that rings every slot for an hour holds 64 numbers, not 9,000.
 */
export const PENDING_SLOTS_KEPT = 64;

/** `slots` with `slot` added: ascending, no repeats, at most PENDING_SLOTS_KEPT. */
function withSlot(slots: readonly number[], slot: number): readonly number[] {
  if (slots.includes(slot)) return slots;
  const next = [...slots, slot].sort((a, b) => a - b);
  return next.length <= PENDING_SLOTS_KEPT ? next : [next[0]!, ...next.slice(next.length - PENDING_SLOTS_KEPT + 1)];
}

/** A wallet the push saw change, and what reads have made of it. */
export interface WalletWatch {
  /**
   * The slots notifications named that no read has covered yet, ascending
   * (the newest last); empty when none is outstanding. Every one of them, not
   * only the newest: a read covers the newest it could see (afterRead).
   */
  readonly pending: readonly number[];
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
  readonly dirty: PushDirty | null;
  readonly wallets: Readonly<Record<string, WalletWatch>>;
  /**
   * WHEN EACH CHANGE STILL OUTSTANDING WAS HEARD, for heardOf. `dirty` keeps
   * one moment for the whole window — the one its debounce counts from, which
   * a remainder keeps — and a wallet's `pending` keeps slots, not moments. So
   * a read that covered the first change and left a later one would name the
   * first one's moment. Kept per notification and dropped with what covers it
   * (afterRead); absent reads as none (a state built before any was heard).
   */
  readonly heard?: readonly HeardChange[];
}

/** One notification the socket brought, kept while what it named is outstanding. */
export interface HeardChange {
  readonly address: string;
  readonly slot: number;
  /** When the socket first named this slot for this address, on this browser's clock. */
  readonly at: number;
  /** A trading wallet's change, rather than the vault's or one of its token accounts'. */
  readonly wallet: boolean;
}

/**
 * WHAT THE PAGE HAS HEARD AND NOT YET READ (heardOf): the moment the first
 * outstanding urgent change was heard, on this browser's clock, and the
 * trading wallets among those changes — sorted, empty when only the vault or
 * its token accounts rang.
 */
export interface PushHeard {
  readonly at: number;
  readonly wallets: readonly string[];
}

/** Something changed that no read has covered yet. */
export interface PushDirty {
  /**
   * When the window opened, on this browser's clock: the first change, or the
   * one that made it urgent. A remainder a read left keeps it: the floor after
   * that read is what it waits.
   */
  readonly since: number;
  /** The newest slot any outstanding notification named. */
  readonly slot: number;
  /** Whether any of it waits only the manual floor (the vault's machinery, or a wallet's first change). */
  readonly urgent: boolean;
  /** The newest slot the vault or one of its token accounts rang at; absent when only wallets rang. The history must reach it too. */
  readonly vaultSlot?: number;
  /** A read already reached `slot` and its history did not reach vaultSlot: this is the one follow-up read, covered by any answer at or past `slot`. */
  readonly followUp?: true;
}

export const EMPTY_PUSH: PushState = { dirty: null, wallets: {} };

/**
 * One notification. `wallet` is true when the address is a trading wallet
 * (rather than the vault or one of its token accounts). The window opens at
 * the FIRST uncovered change and later ones do not move it: a chain that keeps
 * changing must not postpone its own read forever.
 */
export function notified(state: PushState, input: { readonly address: string; readonly slot: number; readonly now: number; readonly wallet: boolean }): PushState {
  const held = input.wallet ? (state.wallets[input.address] ?? { pending: [], covered: null }) : null;
  // Urgent: the vault's machinery, or a wallet not already being checked.
  const urgent = held === null || held.covered?.open !== true;
  const before = state.dirty;
  // THE WINDOW OPENS AGAIN WHEN THE CHANGE TURNS URGENT (push D4). A vault
  // change arriving while a busy wallet's change waited out its 30 s floor kept
  // that change's old `since`, so it got no debounce at all: its read could
  // fire 0.2 s after the confirmation, before the wrap that follows a settle.
  const since = before === null || (urgent && !before.urgent) ? input.now : before.since;
  // The vault's own newest slot. A newer one owes its own follow-up; a wallet's change leaves both as they were.
  const vaultSlot = held === null ? Math.max(before?.vaultSlot ?? input.slot, input.slot) : before?.vaultSlot;
  const followUp = held === null && vaultSlot !== before?.vaultSlot ? undefined : before?.followUp;
  const dirty: PushDirty = {
    since,
    slot: Math.max(before?.slot ?? input.slot, input.slot),
    urgent: (before?.urgent ?? false) || urgent,
    ...(vaultSlot === undefined ? {} : { vaultSlot }),
    ...(followUp === undefined ? {} : { followUp }),
  };
  const known = state.heard ?? [];
  const heard = known.some((change) => change.address === input.address && change.slot === input.slot)
    ? known
    : [...known, { address: input.address, slot: input.slot, at: input.now, wallet: input.wallet }];
  if (held === null) return { ...state, dirty, heard: boundedHeard(heard, state.wallets) };
  const wallets = { ...state.wallets, [input.address]: { ...held, pending: withSlot(held.pending, input.slot) } };
  return { dirty, wallets, heard: boundedHeard(heard, wallets) };
}

/**
 * The heard moments a state may keep: a wallet's, only for the slots its
 * `pending` still holds (withSlot's bound is theirs); the vault side's, the
 * first heard and the last PENDING_SLOTS_KEPT - 1, as withSlot keeps slots —
 * the first is the one heardOf names.
 */
function boundedHeard(heard: readonly HeardChange[], wallets: Readonly<Record<string, WalletWatch>>): readonly HeardChange[] {
  const mine = heard.filter((change) => (change.wallet ? wallets[change.address]?.pending.includes(change.slot) === true : true));
  const vault = mine.filter((change) => !change.wallet);
  if (vault.length <= PENDING_SLOTS_KEPT) return mine;
  const kept = new Set([vault[0]!, ...vault.slice(vault.length - PENDING_SLOTS_KEPT + 1)]);
  return mine.filter((change) => change.wallet || kept.has(change));
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
    const held = wallets[wallet] ?? { pending: [], covered: null };
    if ((held.pending.at(-1) ?? -1) >= slot || (held.covered?.slot ?? -1) >= slot) continue;
    wallets[wallet] = { ...held, pending: withSlot(held.pending, slot) };
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
 * What is left of `dirty` after a read: nothing once the snapshot reached its
 * slot — unless the vault rang, the history this read holds has not reached
 * that slot, and this was not already the follow-up. Then it stays, marked as
 * the follow-up, urgent, so it waits the manual floor and not a sweep.
 *
 * A SNAPSHOT SHORT OF THE NEWEST SLOT LEAVES ONLY WHAT IT DID NOT REACH, and
 * that remainder is urgent only for what still is: the vault's own change
 * past the snapshot (or its follow-up), or a wallet whose outstanding slots
 * are past it and that is not being checked after this read (`wallets`, as
 * this read left them). A wallet already being checked trading on during the
 * read is not urgent — it used to keep the whole of `dirty` urgent, read after
 * read, for as long as the wallet kept trading.
 */
function coveredDirty(
  dirty: PushDirty | null,
  reached: (slot: number) => boolean,
  historySlot: number | null,
  wallets: Readonly<Record<string, WalletWatch>>,
): PushDirty | null {
  if (dirty === null) return null;
  if (reached(dirty.slot)) {
    if (dirty.vaultSlot === undefined || dirty.followUp === true) return null;
    if (historySlot !== null && historySlot >= dirty.vaultSlot) return null;
    return { ...dirty, urgent: true, followUp: true };
  }
  let slot = -1;
  let urgent = false;
  let vault: Pick<PushDirty, "vaultSlot" | "followUp"> = {};
  if (dirty.vaultSlot !== undefined) {
    if (!reached(dirty.vaultSlot)) vault = { vaultSlot: dirty.vaultSlot, ...(dirty.followUp === true ? { followUp: true as const } : {}) };
    else if (dirty.followUp !== true && !(historySlot !== null && historySlot >= dirty.vaultSlot)) vault = { vaultSlot: dirty.vaultSlot, followUp: true };
    if (vault.vaultSlot !== undefined) {
      slot = vault.vaultSlot;
      urgent = true;
    }
  }
  for (const watch of Object.values(wallets)) {
    const unseen = watch.pending.filter((pending) => !reached(pending));
    if (unseen.length === 0) continue;
    slot = Math.max(slot, unseen[unseen.length - 1]!);
    if (watch.covered?.open !== true) urgent = true;
  }
  if (slot < 0) return null;
  return { since: dirty.since, slot, urgent, ...vault };
}

/** The newest slot among `entries`, or null when there are none. */
export function newestSlotOf(entries: readonly LiveEntryJson[]): number | null {
  let newest: number | null = null;
  for (const entry of entries) if (Number.isSafeInteger(entry.slot) && (newest === null || entry.slot > newest)) newest = entry.slot;
  return newest;
}

/**
 * The kinds of row that move a figure the SNAPSHOT draws — Saved so far, the
 * chart and the stats (settlements, filtered at the snapshot's slot), Pending,
 * the Next investment bar, the holdings. A settlement is the case the
 * diagnosis named; a wrap, a conversion or a buy newer than the snapshot draws
 * the same disagreement between the feed and the figures beside it. Keeper
 * upkeep, a rule or a link moves none of those, and buys no extra read.
 */
const MOVES_FIGURES: ReadonlySet<string> = new Set(["settled", "wrapped", "converted", "invested", "withdrew_sol", "withdrew_token", "received_sol"]);

/**
 * WHETHER THE HISTORY JUST READ IS AHEAD OF THE SNAPSHOT READ BEFORE IT: a
 * transaction that succeeded at a slot past the snapshot's and moved a figure
 * it draws. The hook then reads the snapshot once more within the same read —
 * past the floor, because it is the same read, and once, because the second
 * answer is not checked again. A snapshot that named no slot cannot be
 * compared, and is not.
 */
export function historyAhead(entries: readonly LiveEntryJson[], snapshotSlot: number | null): boolean {
  if (snapshotSlot === null) return false;
  return entries.some((entry) => entry.ok && entry.slot > snapshotSlot && entry.events.some((event) => MOVES_FIGURES.has(event.kind)));
}

/**
 * WHAT A READ THAT ANSWERED COVERED. `slot` is the snapshot's; null when it
 * named none, and then the change is taken as covered rather than read again
 * and again over a field the server could not fill. `historyRead` is whether
 * the same read also read the vault's history: without it a wallet's change
 * stays outstanding, because the history is what tells a trade from the
 * keeper's own settlement. `readAtMs` is the server's clock, the one the page
 * times every step by.
 *
 * `state` is the state as the read LANDS — notifications that arrived while it
 * was out included — so each wallet is covered at the newest outstanding slot
 * at or under `slot`, and the slots past it stay outstanding (see the top of
 * the file: a read covers what it could see).
 */
export function afterRead(
  state: PushState,
  input: {
    readonly slot: number | null;
    readonly historyRead: boolean;
    readonly readAtMs: number;
    /** Each wallet's end as this read sees it (walletEnds); a wallet missing from it has none known. */
    readonly ends?: Readonly<Record<string, number>>;
    /**
     * The newest slot of the vault's history as this read holds it, once its
     * page landed (newestSlotOf); null or absent when it holds none. Ignored
     * unless historyRead. A vault's change needs it at or past vaultSlot.
     */
    readonly historySlot?: number | null;
  },
): PushState {
  const reached = (slot: number): boolean => input.slot === null || input.slot >= slot;
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
    // The newest outstanding slot this read could see; what came after it stays outstanding.
    const seen = watch.pending.filter(reached);
    if (seen.length > 0 && input.historyRead) {
      const slot = seen[seen.length - 1]!;
      next = {
        pending: watch.pending.filter((pending) => !reached(pending)),
        covered: { slot, atMs: ongoing && held !== null ? held.atMs : input.readAtMs, open: !ended(address, slot) },
      };
    }
    // Forgotten once it is old and nothing is outstanding.
    if (next.pending.length === 0 && (next.covered === null || input.readAtMs - next.covered.atMs > WALLET_CHANGE_FORGET_MS)) continue;
    wallets[address] = next;
  }
  const historySlot = input.historyRead ? (input.historySlot ?? null) : null;
  const dirty = coveredDirty(state.dirty, reached, historySlot, wallets);
  // WHAT IS STILL OUTSTANDING KEEPS THE MOMENT IT WAS HEARD. A wallet's change,
  // while its slot is still pending. The vault's, while `dirty` still owes the
  // vault a read and this one did not cover it: coveredDirty's own test, slot
  // by slot — reached, and the history at or past it unless this was already
  // the follow-up, which any answer at or past it covers.
  const followUp = state.dirty?.followUp === true;
  const heard = (state.heard ?? []).filter((change) =>
    change.wallet
      ? wallets[change.address]?.pending.includes(change.slot) === true
      : dirty?.vaultSlot !== undefined && !(reached(change.slot) && (followUp || (historySlot !== null && historySlot >= change.slot))),
  );
  return { dirty, wallets, heard };
}

/**
 * WHAT THE PAGE HAS HEARD AND NOT YET READ: the urgent changes still
 * outstanding, or null when there are none.
 *
 * URGENT, BECAUSE THAT IS WHAT HAS NOTHING ELSE ON SCREEN. The vault's own
 * change (the keeper's step, a deposit) has no line until the read lands; a
 * wallet's FIRST change since its last saving has none either, until the read
 * that covers it hands it to the page as "checking your latest activity"
 * (walletChangesOf). A wallet already being checked trading on is NOT heard:
 * its line is already up, and for a busy trader that change is outstanding
 * all the time — an "updating" that never went away (review 2026-10-09).
 *
 * NULL ONCE A READ THAT ANSWERED COVERED EVERY ONE OF THEM — the vault's
 * follow-up read included (afterRead). A read that failed covers nothing and
 * changes nothing here; nor does a socket that came back (resynced: nobody
 * heard anything) or a change a read found rather than heard (heardLate).
 * And a read whose HISTORY failed covers no wallet's change: its slot stays
 * pending, so it stays heard — even with `dirty` gone, the next poll being
 * the read that will cover it.
 */
export function heardOf(state: PushState): PushHeard | null {
  let at: number | null = null;
  const wallets = new Set<string>();
  for (const change of state.heard ?? []) {
    if (change.wallet) {
      const watch = state.wallets[change.address];
      if (watch === undefined || !watch.pending.includes(change.slot) || watch.covered?.open === true) continue;
      wallets.add(change.address);
    } else if (state.dirty?.vaultSlot === undefined) continue;
    if (at === null || change.at < at) at = change.at;
  }
  return at === null ? null : { at, wallets: [...wallets].sort() };
}

/** Whether two answers of heardOf say the same: the page keeps one object while nothing it shows changed. */
export const sameHeard = (a: PushHeard | null, b: PushHeard | null): boolean =>
  a === b || (a !== null && b !== null && a.at === b.at && a.wallets.length === b.wallets.length && a.wallets.every((wallet, index) => wallet === b.wallets[index]));

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
