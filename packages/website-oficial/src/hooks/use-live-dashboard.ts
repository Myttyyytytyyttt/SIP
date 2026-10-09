"use client";

/**
 * WHAT THE CONNECTED DASHBOARD KNOWS OF SOLANA, and when it asks again.
 *
 * One snapshot and one page of history on mount, then a poll at the keeper's own
 * sweep — never faster, because reading twice a minute shows the same numbers
 * twice and spends a key the keeper shares. The one exception is a step the
 * keeper is about to take with the vault's money (src/lib/live-pending.ts):
 * while one is under way the poll runs every 20 s, for at most five minutes at
 * a stretch (live-schedule.ts PENDING_POLL_MS). A hidden tab polls not at all.
 *
 * AND THE CHAIN RINGS (owner, 2026-10-09: a trade made elsewhere showed nothing
 * here until a reload). One WebSocket to the key-free public endpoint watches
 * the linked trading wallets, the vault and its USDC and wSOL accounts
 * (src/lib/live-socket.ts); a change buys ONE read, debounced and never sooner
 * than the manual floor after the last, never through a retry-after or a
 * backoff (src/lib/live-push.ts). The socket stays open while the tab is
 * hidden and reads nothing then: the tab reads when it is looked at again —
 * on visibilitychange or focus, as soon as the last read is the floor old.
 * A wallet's change reaches the page, as "checking your latest activity",
 * only once a read at or past it has read the history too.
 *
 * AND THE PAGE CAN SAY HOW LIVE IT IS (owner, 10-09: "necesito que la página
 * en general sea live… que aparezca en forma de loadings"). The socket never
 * gives up now (live-socket.ts), comes back at once when the tab is looked at,
 * takes focus or the network returns, and reports its state; `live`
 * hands the page that state, whether a read is out, what change was heard
 * and not yet read (and on which wallets), when the last good read landed,
 * when a refresh stops waiting, when the next read is due and whether the
 * reads are backing off, and a count of the reads committed — the data a
 * "Live" dot, an "updating" shimmer, an "updated 12 s ago", a Retry enabled
 * at the right moment and a "next try at" need (UI plan 10-09, §5).
 * While the push is wanted and not live, a visible tab reads every 20 s
 * instead of every minute (live-schedule.ts UNHEARD_POLL_MS): the poll is
 * then all it has. A 429 that cadence earns puts it back on the minute until
 * a read succeeds, and is not counted toward the backoff.
 *
 * A POLL ASKS ONLY FOR WHAT IS NEW: `until` the newest signature already held,
 * so a quiet minute costs one getSignaturesForAddress and nothing else. The rows
 * already loaded ARE the cache; nothing is re-read to draw them again.
 *
 * A FAILED POLL KEEPS THE LAST GOOD DATA and says it is stale, with when it will
 * try again. It never falls back to the sample, and it never blanks the screen:
 * numbers that were true a minute ago, labelled as such, beat an empty page.
 *
 * A HISTORY NOBODY COULD READ IS NOT AN EMPTY ONE. A failed activity page — and
 * a 200 the route marked unreadable — leaves here as `activityUnreadable`, so
 * the feed says it could not be read and offers a retry. Dropped, it drew "No
 * activity yet" beside a Settlements tile reading 3, which is a false statement
 * about somebody's pension held until the next sweep.
 *
 * AND IT LEAVES ITS RETRY-AFTER WITH IT. The route says WHEN this browser may
 * ask again, often a second or two on a bucket that refills at a token a
 * second; collapsing the answer to a boolean threw that away, so the sidebar
 * said "could not be read" for the rest of the minute over a problem that had
 * already cleared. The next read is brought forward to the moment the server
 * named — once, and never earlier than the manual floor — and NOTHING is backed
 * off, because the snapshot's own leg succeeded and every figure on the screen
 * is current.
 *
 * THE FIRST PAINT WAITS FOR THE HISTORY (owner, 09-24). The snapshot answers
 * first, and committing it alone drew half a second of "No activity yet", "0
 * events · 0 settlements", a chart saying the savings are "not in the history
 * loaded here" and a Load older that could do nothing — a pension that looked
 * as though it had lost its past. So the FIRST snapshot of a pension is held
 * until its head page and the settlement round below have answered (or
 * failed) — but never longer than FIRST_PAINT_WAIT_MS after the snapshot
 * itself answered (lib/first-paint.ts): a slow history must not keep the
 * balances, the rule and the next step behind a skeleton. If the bound comes
 * first, the feed says the history is still being read (`activityPending`),
 * never "No activity yet".
 *
 * AND EVERY READ COMMITS ONCE (UI plan 10-09, §5 item 7). Every later read
 * used to commit its snapshot at once and its head page when that answered,
 * so each poll drew new balances over old rows for a second: a converting
 * line vanished before the "Converted" row that ended it, a fresh saving drew
 * as "slow". Now a read gathers its snapshot (or the re-read a history ahead
 * of it bought), its head page and the round's link rows, and commits them in
 * ONE state update (lib/live-commit.ts commitRead) — the failure cleared, the
 * push's coverage and the read's end in the same render. Only the first paint
 * may draw its snapshot early, at the bound.
 *
 * A LATE ANSWER FOR AN OLDER REQUEST IS DROPPED (a request counter, as
 * useVaultState does), and changing pension key resets everything — nothing read
 * for the previous key stays on screen for the next one. What was ASKED for it
 * ends there too, and on unmount: a refresh deferred to the floor is cleared,
 * and the read out and a Load older page answer into nothing (keyEpoch).
 *
 * A PAGE OF SIGNATURES IS NOT A PAGE OF SETTLEMENTS. When the chain's own state
 * says a settlement happened and the loaded page holds none — twelve of fifteen
 * signatures being keeper upkeep is enough — this read pages back for it itself,
 * bounded, in this same path: live-backfill.ts holds the rule and the cost.
 *
 * AND IT IS PAID ONCE PER PENSION, NOT ONCE PER MOUNT. What a round spent is
 * kept per pension key in that module rather than in a ref here, because this
 * hook remounts whenever someone walks to /wallets and back, and a round costs
 * about half the read tokens a client gets in a minute. A failure of that
 * round stays out of "Load older" too: nobody pressed it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useSolanaConfigOrNull } from "@/app/providers";

import { createLiveApi } from "@/lib/live-api";
import { newestSignature } from "@/lib/live-activity-store";
import { backfillLinkSettlements, backfillSpend, chainSaysSettled, forgetBackfillSpend, holdsSettlement, settlementWallets, shouldBackfill } from "@/lib/live-backfill";
import { EMPTY_LIVE_DATA, commitRead, forgottenData, historyComplete, paintFirst, withOlderPage, type LiveData, type ReadCommit } from "@/lib/live-commit";
import { LIVE_COPY } from "@/lib/live-copy";
import { firstPaintGate } from "@/lib/first-paint";
import { toLiveDashboard } from "@/lib/live-model";
import { anyActive, pendingSteps } from "@/lib/live-pending";
import {
  EMPTY_PUSH,
  afterRead,
  baselineOf,
  heardLate,
  heardOf,
  historyAhead,
  movedSince,
  newestSlotOf,
  notified,
  pushReadDelayMs,
  recallPush,
  rememberPush,
  resynced,
  sameHeard,
  showReadWanted,
  walletChangesOf,
  walletEnds,
  watchedAddresses,
  watchedWallets,
  type PushHeard,
  type PushState,
} from "@/lib/live-push";
import {
  MANUAL_FLOOR_MS,
  backingOffOf,
  manualReadyAt,
  nextActivityRetryMs,
  nextDelayMs,
  nextManualDelayMs,
  nextReadAtOf,
  pendingPollWanted,
  refusalBacksOff,
  unheardPollWanted,
} from "@/lib/live-schedule";
import { browserSocket, watchAccounts, type ChainWatch, type SocketState } from "@/lib/live-socket";
import type { LiveDashboard, LiveEntryJson } from "@/lib/live-types";
import { vaultFailureWords, type ApiFailure } from "@/lib/vault-api";
import { vaultStampOf, type VaultStamp } from "@/lib/vault-follow";

/** Signatures one page asks for. The route's own cap. */
export const ACTIVITY_PAGE = 15;
/** The most wallets one snapshot can ask about. */
const MAX_WALLETS = 10;
/** After this long without a good read, the stale note adds that the numbers may be out of date. */
export const STALE_WARNING_MS = 5 * 60_000;
/**
 * The longest the first paint waits for the history, counted from the moment
 * the snapshot answered. A healthy head page and one wallet's link page answer
 * in about a second together; a slow RPC, or ten wallets paged twice each, must
 * not hold the whole page behind a skeleton.
 */
export const FIRST_PAINT_WAIT_MS = 1_500;

export interface LiveStale {
  readonly message: string;
  /** When the next attempt is due, so the note can count down. */
  readonly retryAt: number | null;
  readonly since: number;
}

export type LiveView =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "unreadable"; readonly message: string; readonly retryAt: number | null }
  | { readonly kind: "ready"; readonly data: LiveDashboard; readonly stale: LiveStale | null };

export interface LiveOlder {
  readonly busy: boolean;
  readonly retryAt: number | null;
  readonly message: string | null;
  /** No older page to load: the whole history is here. */
  readonly complete: boolean;
  /**
   * There IS an older page to ask for: a head page came back and named where
   * the next one starts. False before any history was read, and after a read
   * that failed — then "Load older" would press on nothing, so it is not drawn.
   */
  readonly available: boolean;
}

/**
 * What the hook holds; `available` and `complete` are worked out from the
 * cursor, never stored beside it (live-commit.ts historyComplete).
 */
type OlderState = Omit<LiveOlder, "available" | "complete">;

/**
 * HOW LIVE THE PAGE IS, for whatever draws it (owner, 10-09; UI plan 10-09,
 * §5 items 1-7). Data only: the page decides how a "Live" dot, a shimmer or
 * a "checking…" looks. Every moment is this browser's clock (Date.now()).
 */
export interface LiveLiveness {
  /**
   * The chain's push. "live": the socket is open and EVERY address it watches
   * is confirmed — a change shows within seconds. "connecting": a socket is
   * being opened, or it is open and some address is not confirmed yet (refused
   * and being asked again, live-socket.ts). "off": closed and waiting for its
   * next attempt, or no endpoint to open. Under either of those two the page
   * is on its 20 s poll. "none": no socket is wanted — no pension key (the
   * sample), a caller that draws no history, or no vault to watch yet.
   */
  readonly socket: SocketState | "none";
  /**
   * The read of the snapshot and the head page is out right now (the first
   * one included: view "loading" says that one apart). Not Load older, which
   * has its own `older.busy`.
   */
  readonly reading: boolean;
  /**
   * WHAT THE CHAIN SAID CHANGED THAT NO READ HAS COVERED YET (live-push.ts
   * heardOf): `at`, when the first such change was heard; `wallets`, the
   * trading wallets among them, sorted — empty when only the vault or its
   * token accounts rang. Null once a read that ANSWERED covered every one of
   * them, the vault's follow-up read included; a failed read leaves it as it
   * was, and so does a read whose history failed for a wallet's change.
   *
   * Only URGENT changes: the vault's own (the keeper's step, a deposit), or a
   * wallet's first change since its last saving. Not a wallet already being
   * checked trading on — its "checking your latest activity" line is already
   * up, and for a busy trader that change is outstanding all the time: an
   * "updating" that never went away (review 2026-10-09). A wallet's change
   * becomes that line (walletChanges) in the same commit that clears it here.
   * The same object while nothing in it changed (sameHeard).
   */
  readonly heard: PushHeard | null;
  /**
   * When the last GOOD commit landed: a read's (readId moved with it), or the
   * first paint's early draw of a pension's first snapshot. Null before
   * either. A failed read never moves it.
   */
  readonly lastReadAt: number | null;
  /**
   * From when refresh() reads AT ONCE instead of deferring: MANUAL_FLOOR_MS
   * after the last read finished — a failed one included — and 0 before any
   * (live-schedule.ts manualReadyAt). A retry-after is not in it: refresh()
   * does not wait for one, so a Retry compares it itself. While `reading`, a
   * refresh adds nothing: the read already out is the answer.
   */
  readonly refreshReadyAt: number;
  /**
   * When the next read nobody asked for is due — the poll's timer or the
   * push's, whichever is earlier (live-schedule.ts nextReadAtOf). Null while
   * the tab is hidden (no timer runs then), while a read is out — in the very
   * render that sets `reading`, not one frame after it — and when none is
   * scheduled.
   */
  readonly nextReadAt: number | null;
  /**
   * The reads are backing off: a failed read put the poll on two to five
   * minutes, or a 429 the 20 s cadence earned put it back on the minute
   * (live-schedule.ts backingOffOf). A history-only refusal is not one: the
   * snapshot was read, and its retry brings the next read earlier.
   */
  readonly backingOff: boolean;
  /**
   * How many reads have committed — snapshot and head page TOGETHER, in one
   * update (live-commit.ts commitRead) — since this hook mounted. Moves once
   * per read, never on the first paint's early draw, a failure or Load older,
   * and never goes back, not even when the pension key changes: when it moves,
   * everything one read brought is on screen at once.
   */
  readonly readId: number;
}

export interface LiveDashboardStore {
  readonly view: LiveView;
  /** Read again now (subject to the 10 s floor). `discover` also re-lists the vault's links. */
  readonly refresh: (options?: { readonly discover?: boolean }) => void;
  readonly loadOlder: () => void;
  readonly older: LiveOlder;
  /** The last history read failed, or the route could not read it: the feed says so instead of "none yet". */
  readonly activityUnreadable: boolean;
  /** When the server said the history may be asked for again; null when it named no time. */
  readonly activityRetryAt: number | null;
  /**
   * The page is drawn and its history has not answered yet — the first paint's
   * bound came first. The feed says it is reading, never "No activity yet".
   */
  readonly activityPending: boolean;
  /** How live the page is: the push's state, a read out, a change heard, the last good read, the schedule, the read count (LiveLiveness). */
  readonly live: LiveLiveness;
  /**
   * What of the last committed snapshot the vault screen draws (vault-follow.ts
   * vaultStampOf), so the shell can re-read that screen when the vault moved
   * (useVaultFollowsLive). Null before a snapshot, or without a vault.
   */
  readonly vaultStamp: VaultStamp | null;
}

/** The later of two moments, either of which may be absent. */
const latestOf = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.max(a, b));

const wordsFor = (failure: ApiFailure): string =>
  failure.status === 429 || failure.code === "rate_limited"
    ? LIVE_COPY.rateLimited(failure.retryAfterSeconds)
    : failure.code === "network"
      ? LIVE_COPY.network
      : failure.code === "unavailable"
        ? LIVE_COPY.deploymentUnavailable
        : vaultFailureWords(failure);

export function useLiveDashboard(input: {
  readonly pensionKey: string | null;
  readonly privyWallets: readonly string[];
  /** Which of privyWallets were imported: they are named apart (src/lib/wallet-labels.ts). */
  readonly importedWallets?: readonly string[];
  /**
   * Whether this caller needs the HISTORY as well as the snapshot. Default true.
   *
   * FALSE IS NOT AN OPTIMISATION, IT IS A CORRECTION. A caller that wants only
   * a balance — the leaderboard's header chip — was paying for a page of
   * signatures and then for the backfill round behind it, and the round's cost
   * is remembered per pension key in a module map that outlives the component
   * (live-backfill.ts). So a connected visit to /leaderboard spent the whole
   * backfill budget on a chip that reads none of it, and the dashboard, mounted
   * a moment later, found `done` already true and never paged back for the
   * settlement it then said it could not find.
   */
  readonly activity?: boolean;
}): LiveDashboardStore {
  const { pensionKey } = input;
  const wantsActivity = input.activity ?? true;
  const api = useMemo(() => createLiveApi(), []);
  // A string, so a new array with the same wallets does not read again.
  const walletsKey = input.privyWallets.join(",");
  const importedKey = (input.importedWallets ?? []).join(",");

  /**
   * WHAT THE READS BROUGHT, IN ONE STATE (lib/live-commit.ts LiveData): the
   * snapshot, the vault's rows, the rows read from the links, where the loaded
   * history ends, the history's trouble, and the count of reads committed.
   * One state so a read changes all of it in ONE update (commitRead): the
   * figures never move apart from the rows that explain them.
   *
   * THE LINK ROWS ARE KEPT IN THEIR OWN LIST, `linkEntries`, and never merged
   * into `entries`, and that is the whole safety of them. Every window total on
   * the screen rests on the vault page being a contiguous slice of one stream;
   * a wallet's link is a slice of a different one. Poured into the same list
   * they would move the oldest loaded settlement backwards while leaving holes
   * above it, `covers()` would start claiming "Saved this week", and a link
   * page carrying `gap` would make mergeHead throw the vault's whole loaded
   * history away. The model takes the two apart.
   *
   * THE HISTORY'S TROUBLE KEEPS ITS RETRY-AFTER. A boolean threw away the one
   * useful thing in it: the route answers a 429 with retry-after — often a
   * second or two — and the hook collapsed the whole answer to "unreadable",
   * so the sidebar waited out the full sweep and the Retry button had nothing
   * to say about when it would help.
   */
  const [store, setStore] = useState<LiveData>(EMPTY_LIVE_DATA);
  const { snapshot, entries, linkEntries, activityMeta, activityTrouble } = store;
  const [failure, setFailure] = useState<{ readonly message: string; readonly retryAt: number | null; readonly since: number } | null>(null);
  const [failures, setFailures] = useState(0);
  /**
   * A read the 20 s unheard cadence bought came back 429, and none has
   * succeeded since: the poll is back on the minute, and nothing is backed off
   * (live-schedule.ts refusalBacksOff). The bucket is per client, so three
   * visible tabs behind one NAT on that cadence overspend it together.
   */
  const [unheardRefused, setUnheardRefused] = useState(false);
  /** When the last read FINISHED, failed or not: the floor every schedule counts from. The last GOOD one is store.committedAt. */
  const [lastReadAt, setLastReadAt] = useState<number | null>(null);
  /** What the socket last said of itself (live-socket.ts onState); null while this hook has none open. */
  const [socketState, setSocketState] = useState<SocketState | null>(null);
  const [older, setOlder] = useState<OlderState>({ busy: false, retryAt: null, message: null });
  // State, not only the ref below: the poll must re-arm when a read FINISHES,
  // and a ref changing does not re-run the effect that would do it.
  const [reading, setReading] = useState(false);
  const [tick, setTick] = useState(0);
  /** What the chain said changed, and what the reads have made of it (live-push.ts). */
  const [push, setPush] = useState<PushState>(() => (pensionKey !== null && wantsActivity ? recallPush(pensionKey).push : EMPTY_PUSH));
  /**
   * WHETHER THE TAB IS LOOKED AT, as state: the poll's and the push's timers
   * are armed and cleared with it, so a hidden tab has none running — a timer
   * armed a moment before the tab was hidden used to fire into it and read —
   * and `live.nextReadAt` is null exactly while that is so.
   */
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState === "visible");
  /** When the poll's and the push's timers fire, as armed; null while either is not. `live.nextReadAt` is the earlier. */
  const [pollAt, setPollAt] = useState<number | null>(null);
  const [pushAt, setPushAt] = useState<number | null>(null);

  // Everything a late answer must be checked against before it is believed.
  const request = useRef(0);
  const entriesRef = useRef<readonly LiveEntryJson[]>([]);
  entriesRef.current = entries;
  const linkEntriesRef = useRef<readonly LiveEntryJson[]>([]);
  linkEntriesRef.current = linkEntries;
  const snapshotRef = useRef<LiveData["snapshot"]>(null);
  snapshotRef.current = snapshot;
  const readingRef = useRef(false);
  const lastReadRef = useRef<number | null>(null);
  lastReadRef.current = lastReadAt;
  const failuresRef = useRef(0);
  failuresRef.current = failures;
  /** Whether the poll last armed was the unheard cadence's: a refusal it earned is not a failure. */
  const unheardRef = useRef(false);
  /** The later of the snapshot's and the history's retry-after: every read asks for both. */
  const retryAt = latestOf(failure?.retryAt ?? null, activityTrouble?.retryAt ?? null);
  const retryAtRef = useRef<number | null>(null);
  retryAtRef.current = retryAt;
  // ONE READER OF THE TAIL, in a ref rather than in state: the backfill takes
  // this before it awaits, so a click arriving in the same tick as the
  // setOlder below still finds the tail taken.
  const olderBusyRef = useRef(false);
  olderBusyRef.current = older.busy;
  // What the backfill has already spent on THIS pension key is NOT here: it is
  // in live-backfill.ts, per key, for as long as the tab lives. A ref dies with
  // the component, and the app's own routes remount this hook — so every
  // remount re-paid a round that had already answered, out of the same 60 read
  // tokens a minute the activity page is paid from.
  /**
   * WHICH PENSION ON SCREEN AN ANSWER OR A TIMER BELONGS TO: moved when the key
   * changes and when the hook unmounts (the reset effect's cleanup). Load older
   * and a deferred refresh take it when they start and are believed only while
   * it has not moved. The request counter cannot serve: every read moves it,
   * and a poll landing during Load older is no reason to drop the older page.
   */
  const keyEpoch = useRef(0);
  /**
   * THE ONE REFRESH DEFERRED TO THE FLOOR (refresh()), and whether a press
   * folded into it asked to re-list the links. Null while none is waiting.
   */
  const deferred = useRef<{ readonly timer: number; discover: boolean } | null>(null);

  // A DIFFERENT PENSION KEY IS A DIFFERENT PENSION: nothing carries over — but
  // the read count goes on, so a read for the new key still reads as one.
  useEffect(() => {
    request.current += 1;
    setStore(forgottenData);
    setFailure(null);
    setFailures(0);
    setUnheardRefused(false);
    setLastReadAt(null);
    setOlder({ busy: false, retryAt: null, message: null });
    // What the push heard and the last read's balances outlive a remount (live-push.ts recallPush).
    setPush(pensionKey !== null && wantsActivity ? recallPush(pensionKey).push : EMPTY_PUSH);
    /*
     * AND WHAT WAS ASKED FOR THIS KEY ENDS WITH IT, on a key change and on
     * unmount alike (review 2026-10-09). A refresh deferred to the floor could
     * fire after either: it read with the key it was armed for and took the
     * newest request number — so nothing marked it stale — and could commit
     * pension A's snapshot and rows into pension B's store; or, unmounted, it
     * spent a read and wrote its balances as the push's baseline
     * (rememberPush) while the change they showed was dropped with the
     * component, so the next mount would never see that move. The read still
     * out when the hook goes is dropped the same way, and a late Load older
     * page for the old key too (keyEpoch).
     */
    return () => {
      keyEpoch.current += 1;
      request.current += 1;
      if (deferred.current !== null) window.clearTimeout(deferred.current.timer);
      deferred.current = null;
    };
  }, [pensionKey, wantsActivity]);
  // Kept for the next remount — only by a caller that draws the history.
  useEffect(() => {
    if (pensionKey !== null && wantsActivity) rememberPush(pensionKey, { push });
  }, [pensionKey, wantsActivity, push]);

  const read = useCallback(
    /** `early` marks the extra read a 429's retry-after bought, so it is counted. */
    async (discover: boolean, early = false): Promise<boolean> => {
      // FALSE means no read happened. The poll re-arms on this answer, and a
      // call that turned back at the guard must not re-arm as though one had
      // just finished — that is the 0 ms loop.
      if (pensionKey === null || readingRef.current) return false;
      readingRef.current = true;
      setReading(true);
      const mine = ++request.current;
      const stale = (): boolean => mine !== request.current;
      try {
        const wallets = [...new Set(walletsKey === "" ? [] : walletsKey.split(","))];
        // Wallets the chain says are linked but Privy does not list here.
        for (const link of snapshotRef.current?.links?.items ?? []) {
          if (wallets.length >= MAX_WALLETS) break;
          if (!wallets.includes(link.wallet)) wallets.push(link.wallet);
        }
        const answered = await api.snapshot({ owner: pensionKey, wallets: wallets.slice(0, MAX_WALLETS), discover });
        if (stale()) return true;
        if (!answered.ok) {
          // The last good data stays on screen; only the note changes. A 429
          // the unheard cadence earned puts the poll back on the minute
          // instead of counting toward the backoff (live-schedule.ts).
          const rateLimited = answered.status === 429 || answered.code === "rate_limited";
          if (refusalBacksOff({ rateLimited, unheard: unheardRef.current, failures: failuresRef.current })) setFailures((count) => count + 1);
          else setUnheardRefused(true);
          setFailure({ message: wordsFor(answered), retryAt: answered.retryAfterSeconds === null ? null : Date.now() + answered.retryAfterSeconds * 1_000, since: Date.now() });
          setLastReadAt(Date.now());
          return true;
        }
        // THE FIRST PAINT WAITS FOR THE HISTORY — see the top of the file. Only
        // the first snapshot of a pension is held, and only it may be drawn
        // before the read commits: at the bound, if the history is slower.
        // Every later read draws nothing until its one commit below.
        const holdFirstPaint = snapshotRef.current === null && wantsActivity && answered.body.vault.status === "exists";
        // A good answer ends the previous failure NOW: held, it would otherwise
        // leave "could not be read" and a live Retry over an answer already in.
        if (holdFirstPaint) {
          setFailures(0);
          setFailure(null);
        }
        // The moment is taken outside the updater, which React may run twice.
        const paint = (): void => {
          const at = Date.now();
          setStore((held) => paintFirst(held, answered.body, at));
        };
        const gate = holdFirstPaint ? firstPaintGate({ hold: true, commit: paint, stale, waitMs: FIRST_PAINT_WAIT_MS }) : null;
        // Whether this read read the history too: only then may a wallet's change reach the page (live-push.ts).
        let historyRead = false;
        // What its page brought, and the newest slot the history holds once it landed (live-push.ts afterRead).
        let pageEntries: readonly LiveEntryJson[] = [];
        let historySlot: number | null = null;
        // The settlements this read can see, for where each wallet's last saving left it (walletEnds).
        const seen: LiveEntryJson[] = [...entriesRef.current, ...linkEntriesRef.current];
        // WHAT THIS READ COMMITS BESIDE ITS SNAPSHOT, gathered here and put on
        // screen once, below: the head page as it answered, and the rows the
        // settlement round read from the links.
        let history: ReadCommit["history"] = null;
        const linkRows: LiveEntryJson[] = [];

        try {
          // No vault, no history: the route would answer an empty page, so it is not asked.
          // And a caller that does not draw the history does not buy it either.
          if (wantsActivity && answered.body.vault.status === "exists") {
            const until = newestSignature(entriesRef.current);
            const page = await api.activity({ owner: pensionKey, limit: ACTIVITY_PAGE, ...(until === null ? {} : { until }) });
            if (stale()) return true;
            // CARRIED, NOT DROPPED, and committed with the snapshot. A page that
            // failed, or one the route marked unreadable, leaves the rows
            // already on screen alone and tells the feed it could not read —
            // never "No activity yet" — with its retry-after (commitRead).
            history = { page, until, early, answeredAt: Date.now() };
            if (page.ok && page.body.status === "exists") {
              historyRead = true;
              pageEntries = page.body.entries;

              // THE SETTLEMENT THE STATE RECORDS IS FETCHED, NOT DENIED.
              //
              // What is held once this page lands, mergeHead's way: a gap
              // REPLACED the head, so what was under it is gone. For the decision
              // only — a manual page appended while this read was in flight can
              // at worst make it ask for a page it need not have.
              const loaded = until === null || page.body.gap ? page.body.entries : [...page.body.entries, ...entriesRef.current];
              historySlot = newestSlotOf(loaded);
              seen.push(...page.body.entries);
              // A GAP THREW THE HISTORY AWAY, so what a round already bought is
              // gone with it and the round may be bought once more.
              if (page.body.gap) forgetBackfillSpend(pensionKey);
              const spend = backfillSpend(pensionKey);
              // THE SETTLEMENT IS LOOKED FOR WHERE SETTLEMENTS ARE, which is each
              // trading wallet's own link and not the vault. The round no longer
              // touches the vault's cursor at all, so it cannot race "Load older"
              // and no longer takes the tail from it.
              const links = settlementWallets(answered.body);
              if (
                shouldBackfill({
                  chainSettled: chainSaysSettled(answered.body),
                  loadedHasSettlement: holdsSettlement(loaded) || holdsSettlement(linkEntriesRef.current),
                  wallets: links.length,
                  manualBusy: olderBusyRef.current,
                  rounds: spend.rounds,
                  done: spend.done,
                  retryAt: spend.retryAt,
                  now: Date.now(),
                })
              ) {
                spend.rounds += 1;
                const filled = await backfillLinkSettlements({
                  wallets: links,
                  fetchPage: (wallet, before) =>
                    api.linkActivity({ owner: pensionKey, wallet, limit: ACTIVITY_PAGE, ...(before === null ? {} : { before }) }),
                });
                // A stale round touches nothing: the pension key that changed
                // under it already reset everything else.
                if (stale()) return true;
                // A round that came back cleanly is the answer, found or not.
                // Only one cut short by a failure is worth asking again, and not
                // before the bucket it emptied has refilled.
                spend.done = filled.failure === null && !filled.unreadable;
                spend.retryAt = filled.failure === null || filled.failure.retryAfterSeconds === null ? null : Date.now() + filled.failure.retryAfterSeconds * 1_000;
                // INTO THE LINK LIST, NEVER INTO `entries`, and touching neither
                // the vault's cursor nor `older` (commitRead): these rows say
                // nothing whatever about how much of the VAULT's history is
                // loaded, and a failure of a read nobody asked for is not the
                // Load older button's.
                linkRows.push(...filled.entries);
                seen.push(...filled.entries);
              }
            }
          }

          // THE HISTORY CAME BACK AHEAD OF THE SNAPSHOT (live-push.ts
          // historyAhead): a saving, a conversion or a buy landed between the
          // two calls, and the feed would show its row beside a Saved so far, a
          // Pending and a Next investment that do not have it — for the 10 s
          // floor. So the snapshot is read once more, now, inside this read: no
          // floor applies to it, and its answer is not checked again. It costs
          // one snapshot (4 client tokens, 5 when discovering), only when this
          // happens. A refusal leaves the first answer, which was good, to be
          // committed. Either way it is committed WITH the page, below.
          let current = answered.body;
          if (historyAhead(pageEntries, current.slot)) {
            const again = await api.snapshot({ owner: pensionKey, wallets: wallets.slice(0, MAX_WALLETS), discover });
            if (stale()) return true;
            if (again.ok && again.body.vault.status === "exists" && (again.body.slot ?? 0) >= (current.slot ?? 0)) {
              current = again.body;
            }
          }

          // ONE COMMIT (lib/live-commit.ts): the snapshot, its head page and the
          // round's link rows in one update, so no figure moves apart from the
          // rows that explain it — a converting line leaves in the same render
          // as the "Converted" row that ended it. The first paint's bound has
          // nothing left to draw. Everything after it is synchronous: the
          // failure cleared, the push's coverage and the read's end land in
          // the same render.
          gate?.cancel();
          const at = Date.now();
          setStore((held) => commitRead(held, { snapshot: current, history, linkRows, at }));
          setFailures(0);
          setFailure(null);
          setUnheardRefused(false);
          // What the chain rang about and this read has now seen — and what moved
          // that nobody heard, from the balances against the last read's.
          if (wantsActivity) {
            const moved = movedSince(recallPush(pensionKey).baseline, current);
            rememberPush(pensionKey, { baseline: baselineOf(current) });
            const ends = walletEnds(current, seen);
            setPush((held) => afterRead(heardLate(held, moved), { slot: current.slot, historyRead, readAtMs: current.readAtMs, ends, historySlot }));
          }
          setLastReadAt(Date.now());
          return true;
        } finally {
          // A read that ended WITHOUT its commit — it threw — still draws the
          // first snapshot it answered with rather than a skeleton for good.
          // Only an answer overtaken by a newer read draws nothing (the gate
          // asks), and after the commit the gate has nothing left to draw.
          gate?.release();
        }
      } finally {
        readingRef.current = false;
        setReading(false);
      }
    },
    [api, pensionKey, walletsKey, wantsActivity],
  );

  // The first read, and a fresh one whenever the wallet list changes: a wallet
  // created a moment ago must appear without waiting out a sweep.
  useEffect(() => {
    if (pensionKey === null) return;
    void read(true);
  }, [pensionKey, walletsKey, read]);

  // COMING BACK TO THE TAB reads once, at once, when the last read is the
  // manual floor old — not a sweep (live-push.ts showReadWanted) — and never
  // before a retry-after or through a backoff. Focus as well as visibility: a
  // window brought forward beside another is visible all along.
  useEffect(() => {
    if (pensionKey === null || typeof document === "undefined") return undefined;
    const onShow = (): void => {
      if (document.visibilityState !== "visible") return;
      if (showReadWanted({ lastReadAt: lastReadRef.current, now: Date.now(), failures: failuresRef.current, retryAt: retryAtRef.current })) void read(false);
      setTick((count) => count + 1);
    };
    document.addEventListener("visibilitychange", onShow);
    window.addEventListener("focus", onShow);
    return () => {
      document.removeEventListener("visibilitychange", onShow);
      window.removeEventListener("focus", onShow);
    };
  }, [pensionKey, read]);

  // WHETHER THE TAB IS LOOKED AT, kept as state for the timers below: hidden,
  // neither the poll nor the push has one armed, and nothing says a read is due.
  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const onVisibility = (): void => setVisible(document.visibilityState === "visible");
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  /*
   * THE SOCKET (live-socket.ts). One per open live dashboard — never for a
   * caller that does not draw the history (the leaderboard's balance chip),
   * never before there is a pension key, so never in the sample. Opened on the
   * key-free WebSocket the server validated for Privy; closed, after
   * unsubscribing, when the key changes, the page leaves live mode or unmounts.
   */
  const wsUrl = useSolanaConfigOrNull()?.solanaWsUrl ?? null;
  const watched = useMemo(() => watchedAddresses(snapshot).join(","), [snapshot]);
  const watchedRef = useRef("");
  watchedRef.current = watched;
  const watchRef = useRef<ChainWatch | null>(null);
  // Nothing to watch, no socket: the endpoint closes one with no subscription, and a vault created later opens it then.
  const hasWatched = watched !== "";
  useEffect(() => {
    if (pensionKey === null || !wantsActivity || !hasWatched || wsUrl === null || typeof WebSocket === "undefined") return undefined;
    const watch = watchAccounts({
      url: wsUrl,
      addresses: watchedRef.current === "" ? [] : watchedRef.current.split(","),
      open: browserSocket,
      onChange: (address, slot) => {
        const wallet = watchedWallets(snapshotRef.current).includes(address);
        setPush((held) => notified(held, { address, slot, now: Date.now(), wallet }));
      },
      onResync: () => setPush((held) => resynced(held, Date.now())),
      onState: setSocketState,
    });
    watchRef.current = watch;
    return () => {
      watch.close();
      if (watchRef.current === watch) watchRef.current = null;
      setSocketState(null);
    };
  }, [pensionKey, wantsActivity, hasWatched, wsUrl]);
  // A changed set — a wallet linked, a token account created — is resubscribed, not reopened.
  useEffect(() => {
    watchRef.current?.setAddresses(watched === "" ? [] : watched.split(","));
  }, [watched, pensionKey, wantsActivity, hasWatched, wsUrl]);

  // THE SOCKET COMES BACK WITH THE PAGE (live-socket.ts reconnect): on
  // returning to the tab and on focus, at once unless it tried a moment ago
  // (WAKE_FLOOR_MS), keeping its count — a focus is no news about the
  // endpoint; and when the network comes back, at once with its count started
  // again, hidden or not: a hidden tab still listens. A socket that is working
  // is left alone, so a focus costs nothing.
  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const wake = (): void => {
      if (document.visibilityState === "visible") watchRef.current?.reconnect();
    };
    const online = (): void => watchRef.current?.reconnect({ network: true });
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    window.addEventListener("online", online);
    return () => {
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", online);
    };
  }, []);

  /*
   * WHAT THE PAGE CAN SAY OF THE PUSH. "none" when no socket is wanted;
   * "off" when one is and it cannot open here (no endpoint, no WebSocket);
   * otherwise what the socket last said, "connecting" until it has.
   */
  const socketWanted = pensionKey !== null && wantsActivity && hasWatched;
  const socket: SocketState | "none" = !socketWanted ? "none" : wsUrl === null || typeof WebSocket === "undefined" ? "off" : (socketState ?? "connecting");

  /*
   * THE READ A PUSH BUYS (live-push.ts pushReadDelayMs): one, at the end of the
   * debounce window, never sooner than the floor after the last read, never
   * before a retry-after, never while backing off, hidden, or reading. A read
   * that answered from before the change leaves it standing, and this asks
   * again after the floor.
   */
  useEffect(() => {
    if (pensionKey === null) {
      setPushAt(null);
      return undefined;
    }
    const delay = pushReadDelayMs({ dirty: push.dirty, now: Date.now(), lastReadAt, visible, reading, failures, retryAt });
    // When it fires, for `live.nextReadAt`; null when nothing is armed.
    setPushAt(delay === null ? null : Date.now() + delay);
    if (delay === null) return undefined;
    const timer = window.setTimeout(() => {
      // Hidden since this was armed: the change stays, and the tab reads it when it is looked at again.
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      void read(false).then((ran) => {
        if (ran) setTick((count) => count + 1);
      });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [pensionKey, push.dirty, lastReadAt, visible, reading, failures, retryAt, tick, read]);

  const refresh = useCallback(
    (options: { readonly discover?: boolean } = {}): void => {
      const discover = options.discover ?? false;
      const delay = nextManualDelayMs({ lastReadAt: lastReadRef.current, now: Date.now(), retryAfterSeconds: null });
      // Clicking twice, or closing the modal straight after opening it, must not
      // spend a minute's tokens in a second.
      if (delay <= 0) {
        void read(discover);
        return;
      }
      // ONE DEFERRED READ, held in a ref so the key's reset can clear it: a
      // press inside the floor joins the one already waiting, and keeps its
      // `discover` — two timers used to fire together, the second turned back
      // by the first's guard, and a re-listing asked by it was lost.
      if (deferred.current !== null) {
        deferred.current.discover ||= discover;
        return;
      }
      const epoch = keyEpoch.current;
      const armed: { timer: number; discover: boolean } = { timer: 0, discover };
      armed.timer = window.setTimeout(() => {
        if (deferred.current === armed) deferred.current = null;
        // Armed for a pension no longer on screen: the reset clears this timer, and this is the guard behind it.
        if (epoch !== keyEpoch.current) return;
        void read(armed.discover);
      }, Math.min(delay, MANUAL_FLOOR_MS));
      deferred.current = armed;
    },
    [read],
  );

  const loadOlder = useCallback((): void => {
    const before = activityMeta?.nextBefore ?? null;
    // The ref as well as the state: a backfill holds the tail from inside a
    // read, before React has re-rendered with its `busy`.
    if (pensionKey === null || before === null || older.busy || olderBusyRef.current) return;
    olderBusyRef.current = true;
    setOlder((current) => ({ ...current, busy: true, message: null }));
    const epoch = keyEpoch.current;
    void api.activity({ owner: pensionKey, limit: ACTIVITY_PAGE, before }).then((page) => {
      /*
       * AN OLDER PAGE OF A PENSION NO LONGER ON SCREEN TOUCHES NOTHING (review
       * 2026-10-09). Answering late, it appended the old key's rows to the new
       * key's forgotten store and set the cursor to the old key's; the new
       * key's first read would then ask `until` one of those signatures and
       * merge its page over them. Not even `busy`: the reset already cleared
       * it, and a Load older of the new pension's may be out by now.
       */
      if (epoch !== keyEpoch.current) return;
      olderBusyRef.current = false;
      if (page.ok) {
        // Under the rows held, with the cursor it names: no read of the chain's present, so the count and the clock stay.
        setStore((held) => withOlderPage(held, page.body));
        setOlder({ busy: false, retryAt: null, message: null });
        return;
      }
      setOlder({
        busy: false,
        retryAt: page.retryAfterSeconds === null ? null : Date.now() + page.retryAfterSeconds * 1_000,
        message: wordsFor(page),
      });
    });
  }, [api, pensionKey, activityMeta, older.busy]);

  const walletChanges = useMemo(() => walletChangesOf(push), [push]);

  const view = useMemo((): LiveView => {
    if (pensionKey === null) return { kind: "idle" };
    if (snapshot === null) {
      if (failure === null) return { kind: "loading" };
      return { kind: "unreadable", message: failure.message, retryAt: failure.retryAt };
    }
    const data = toLiveDashboard({
      snapshot,
      activity: activityMeta === null ? null : { vault: snapshot.vault.address, status: activityMeta.status, nextBefore: activityMeta.nextBefore, entries, gap: false },
      linkEntries,
      privyWallets: walletsKey === "" ? [] : walletsKey.split(","),
      importedWallets: importedKey === "" ? [] : importedKey.split(","),
      walletChanges,
    });
    const stale =
      failure === null
        ? null
        : {
            message: Date.now() - failure.since >= STALE_WARNING_MS ? `${failure.message} ${LIVE_COPY.staleLong}` : failure.message,
            retryAt: failure.retryAt,
            since: failure.since,
          };
    return { kind: "ready", data, stale };
  }, [pensionKey, snapshot, entries, linkEntries, activityMeta, failure, walletsKey, importedKey, walletChanges]);

  /*
   * WHETHER A STEP IS UNDER WAY (src/lib/live-pending.ts), from the model the
   * page draws — and, in activeSinceRef, when this stretch of them began.
   */
  const pendingActive = wantsActivity && view.kind === "ready" && anyActive(pendingSteps(view.data));
  const activeSinceRef = useRef<number | null>(null);
  useEffect(() => {
    if (!pendingActive) activeSinceRef.current = null;
    else if (activeSinceRef.current === null) activeSinceRef.current = Date.now();
  }, [pendingActive, pensionKey]);

  // THE POLL. Re-armed after each read, and never while the tab is hidden.
  //
  // FASTER WHILE SOMETHING IS ON ITS WAY (live-schedule.ts PENDING_POLL_MS): a
  // conversion or a buy the keeper is about to make, so its loader gives way to
  // the real row soon after it lands. Only for a caller that draws the history
  // — the leaderboard's balance chip shows no step — and only for
  // PENDING_POLL_MAX_MS of one stretch, counted from activeSinceRef.
  useEffect(() => {
    if (pensionKey === null) {
      setPollAt(null);
      return undefined;
    }
    const pending = pendingPollWanted({ active: pendingActive, activeSince: activeSinceRef.current, now: Date.now(), activityRetryAt: activityTrouble?.retryAt ?? null });
    // NOTHING WILL RING (live-schedule.ts UNHEARD_POLL_MS): the push is wanted and not live, so the poll is all there is.
    const unheard = unheardPollWanted({ socket, activityRetryAt: activityTrouble?.retryAt ?? null, now: Date.now(), refused: unheardRefused });
    unheardRef.current = unheard;
    const delay = nextDelayMs({ failures, retryAfterSeconds: null, visible, lastReadAt, now: Date.now(), reading, pending, unheard });
    if (delay === null) {
      setPollAt(null);
      return undefined;
    }
    const retryAt = failure?.retryAt ?? null;
    const wait = retryAt === null ? delay : Math.max(delay, retryAt - Date.now());

    // ONE LEG WAS REFUSED AND SAID WHEN TO COME BACK. The snapshot succeeded —
    // every figure on the screen is current — so nothing is backed off; the
    // next ordinary read is simply brought forward to the moment the server
    // named, and only once. Never earlier than the manual floor, because a
    // retry-after of zero would otherwise spend a page's tokens immediately.
    const early = nextActivityRetryMs({ retryAt: activityTrouble?.retryAt ?? null, attempts: activityTrouble?.attempts ?? 0, now: Date.now() });
    const soon = early === null ? null : Math.max(early, MANUAL_FLOOR_MS);
    const when = soon === null ? Math.max(0, wait) : Math.min(Math.max(0, wait), soon);
    // When it fires, for `live.nextReadAt`.
    setPollAt(Date.now() + when);

    const timer = window.setTimeout(() => {
      // Only a read that actually RAN re-arms the poll. A call that turned back
      // at the in-flight guard re-arms nothing: the read already running will,
      // when it finishes and `reading` falls.
      void read(false, soon !== null && when === soon).then((ran) => {
        if (ran) setTick((count) => count + 1);
      });
    }, when);
    return () => window.clearTimeout(timer);
  }, [pensionKey, failures, lastReadAt, failure, activityTrouble, tick, read, reading, visible, pendingActive, socket, unheardRefused]);

  const cursor = activityMeta?.nextBefore ?? null;
  const complete = historyComplete(store);
  const olderView = useMemo((): LiveOlder => ({ ...older, complete, available: cursor !== null }), [older, complete, cursor]);

  // Drawn, a history to read, and neither an answer nor a failure yet.
  const activityPending = wantsActivity && snapshot !== null && snapshot.vault.status === "exists" && activityMeta === null && activityTrouble === null;

  /*
   * HOW LIVE THE PAGE IS (LiveLiveness). `heard` keeps its object while what it
   * says is the same (sameHeard): a wallet ringing every slot changes `push`
   * every 400 ms, and the page must not see a new "heard" each time.
   */
  const heardRef = useRef<PushHeard | null>(null);
  const heardNow = heardOf(push);
  if (!sameHeard(heardRef.current, heardNow)) heardRef.current = heardNow;
  const heard = heardRef.current;
  const refreshReadyAt = manualReadyAt(lastReadAt);
  // `reading` from this render, not from the effect that clears the timers after it has painted (nextReadAtOf).
  const nextReadAt = nextReadAtOf({ visible, reading, pollAt, pushAt });
  const backingOff = backingOffOf({ failures, refused: unheardRefused });
  const { readId, committedAt } = store;
  const live = useMemo(
    (): LiveLiveness => ({ socket, reading, heard, lastReadAt: committedAt, refreshReadyAt, nextReadAt, backingOff, readId }),
    [socket, reading, heard, committedAt, refreshReadyAt, nextReadAt, backingOff, readId],
  );
  const vaultStamp = useMemo(() => vaultStampOf(snapshot), [snapshot]);

  return {
    view,
    refresh,
    loadOlder,
    older: olderView,
    activityUnreadable: activityTrouble !== null,
    activityRetryAt: activityTrouble?.retryAt ?? null,
    activityPending,
    live,
    vaultStamp,
  };
}
