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
 * never "No activity yet". Every later read commits its snapshot at once, over
 * rows that are already on screen.
 *
 * A LATE ANSWER FOR AN OLDER REQUEST IS DROPPED (a request counter, as
 * useVaultState does), and changing pension key resets everything — nothing read
 * for the previous key stays on screen for the next one.
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

import { activityTroubleFrom, createLiveApi, type LiveActivityTrouble } from "@/lib/live-api";
import { appendOlder, headCursor, mergeHead, newestSignature } from "@/lib/live-activity-store";
import { backfillLinkSettlements, backfillSpend, chainSaysSettled, forgetBackfillSpend, holdsSettlement, settlementWallets, shouldBackfill } from "@/lib/live-backfill";
import { LIVE_COPY } from "@/lib/live-copy";
import { firstPaintGate } from "@/lib/first-paint";
import { toLiveDashboard } from "@/lib/live-model";
import { anyActive, pendingSteps } from "@/lib/live-pending";
import {
  EMPTY_PUSH,
  afterRead,
  baselineOf,
  heardLate,
  movedSince,
  notified,
  pushReadDelayMs,
  recallPush,
  rememberPush,
  resynced,
  showReadWanted,
  walletChangesOf,
  walletEnds,
  watchedAddresses,
  watchedWallets,
  type PushState,
} from "@/lib/live-push";
import { MANUAL_FLOOR_MS, nextActivityRetryMs, nextDelayMs, nextManualDelayMs, pendingPollWanted } from "@/lib/live-schedule";
import { browserSocket, watchAccounts, type ChainWatch } from "@/lib/live-socket";
import type { LiveActivityJson, LiveDashboard, LiveEntryJson, LiveSnapshotJson } from "@/lib/live-types";
import { vaultFailureWords, type ApiFailure } from "@/lib/vault-api";

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

/** What the hook holds; `available` is worked out from the cursor, never stored beside it. */
type OlderState = Omit<LiveOlder, "available">;

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

  const [snapshot, setSnapshot] = useState<LiveSnapshotJson | null>(null);
  const [entries, setEntries] = useState<readonly LiveEntryJson[]>([]);
  /**
   * ROWS READ FROM THE TRADING WALLETS' LINKS, kept in their OWN list.
   *
   * They are never merged into `entries`, and that is the whole safety of this.
   * Every window total on the screen rests on the vault page being a contiguous
   * slice of one stream; a wallet's link is a slice of a different one. Poured
   * into the same list they would move the oldest loaded settlement backwards
   * while leaving holes above it, `covers()` would start claiming "Saved this
   * week", and a link page carrying `gap` would make mergeHead throw the
   * vault's whole loaded history away. The model takes the two apart.
   */
  const [linkEntries, setLinkEntries] = useState<readonly LiveEntryJson[]>([]);
  const [activityMeta, setActivityMeta] = useState<Pick<LiveActivityJson, "status" | "nextBefore"> | null>(null);
  const [failure, setFailure] = useState<{ readonly message: string; readonly retryAt: number | null; readonly since: number } | null>(null);
  const [failures, setFailures] = useState(0);
  const [lastReadAt, setLastReadAt] = useState<number | null>(null);
  const [older, setOlder] = useState<OlderState>({ busy: false, retryAt: null, message: null, complete: false });
  /**
   * The last history read's trouble, or null when it was read.
   *
   * A BOOLEAN THREW AWAY THE ONE USEFUL THING IN IT. The route answers a 429
   * with retry-after — often a second or two — and the hook collapsed the whole
   * answer to "unreadable", so the sidebar waited out the full sweep and the
   * Retry button had nothing to say about when it would help.
   */
  const [activityTrouble, setActivityTrouble] = useState<LiveActivityTrouble | null>(null);
  // State, not only the ref below: the poll must re-arm when a read FINISHES,
  // and a ref changing does not re-run the effect that would do it.
  const [reading, setReading] = useState(false);
  const [tick, setTick] = useState(0);
  /** What the chain said changed, and what the reads have made of it (live-push.ts). */
  const [push, setPush] = useState<PushState>(() => (pensionKey !== null && wantsActivity ? recallPush(pensionKey).push : EMPTY_PUSH));

  // Everything a late answer must be checked against before it is believed.
  const request = useRef(0);
  const entriesRef = useRef<readonly LiveEntryJson[]>([]);
  entriesRef.current = entries;
  const linkEntriesRef = useRef<readonly LiveEntryJson[]>([]);
  linkEntriesRef.current = linkEntries;
  const snapshotRef = useRef<LiveSnapshotJson | null>(null);
  snapshotRef.current = snapshot;
  const activityMetaRef = useRef<Pick<LiveActivityJson, "status" | "nextBefore"> | null>(null);
  activityMetaRef.current = activityMeta;
  const readingRef = useRef(false);
  const lastReadRef = useRef<number | null>(null);
  lastReadRef.current = lastReadAt;
  const failuresRef = useRef(0);
  failuresRef.current = failures;
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

  // A DIFFERENT PENSION KEY IS A DIFFERENT PENSION: nothing carries over.
  useEffect(() => {
    request.current += 1;
    setSnapshot(null);
    setEntries([]);
    setLinkEntries([]);
    setActivityMeta(null);
    setFailure(null);
    setFailures(0);
    setLastReadAt(null);
    setOlder({ busy: false, retryAt: null, message: null, complete: false });
    setActivityTrouble(null);
    // What the push heard and the last read's balances outlive a remount (live-push.ts recallPush).
    setPush(pensionKey !== null && wantsActivity ? recallPush(pensionKey).push : EMPTY_PUSH);
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
          // The last good data stays on screen; only the note changes.
          setFailures((count) => count + 1);
          setFailure({ message: wordsFor(answered), retryAt: answered.retryAfterSeconds === null ? null : Date.now() + answered.retryAfterSeconds * 1_000, since: Date.now() });
          setLastReadAt(Date.now());
          return true;
        }
        // THE FIRST PAINT WAITS FOR THE HISTORY — see the top of the file.
        // Drawn once, whichever way this read goes on: at once for every later
        // read, and for the first when its history settles or the bound runs out.
        const holdFirstPaint = snapshotRef.current === null && wantsActivity && answered.body.vault.status === "exists";
        // A good answer ends the previous failure NOW: held, it would otherwise
        // leave "could not be read" and a live Retry over an answer already in.
        if (holdFirstPaint) {
          setFailures(0);
          setFailure(null);
        }
        const gate = firstPaintGate({ hold: holdFirstPaint, commit: () => setSnapshot(answered.body), stale, waitMs: FIRST_PAINT_WAIT_MS });
        // Whether this read read the history too: only then may a wallet's change reach the page (live-push.ts).
        let historyRead = false;
        // The settlements this read can see, for where each wallet's last saving left it (walletEnds).
        const seen: LiveEntryJson[] = [...entriesRef.current, ...linkEntriesRef.current];

        try {
          // No vault, no history: the route would answer an empty page, so it is not asked.
          // And a caller that does not draw the history does not buy it either.
          if (wantsActivity && answered.body.vault.status === "exists") {
            const until = newestSignature(entriesRef.current);
            const page = await api.activity({ owner: pensionKey, limit: ACTIVITY_PAGE, ...(until === null ? {} : { until }) });
            if (stale()) return true;
            // CARRIED, NOT DROPPED. A page that failed, or one the route marked
            // unreadable, leaves the rows already on screen alone and tells the
            // feed it could not read — never "No activity yet".
            // CARRIED WITH ITS RETRY-AFTER, not collapsed to a flag. `attempts`
            // counts only the early re-reads this trouble has already bought, so
            // one refusal buys one faster question and no more.
            setActivityTrouble((held) => activityTroubleFrom(page, { attempts: early ? (held?.attempts ?? 0) + 1 : 0, now: Date.now() }));
            if (page.ok && page.body.status === "exists") {
              historyRead = true;
              // A POLL DOES NOT REDEFINE WHERE THE HISTORY ENDS. It asked only for
              // what is new, and its "nothing more to page" is about that window.
              const cursor = headCursor({
                polled: until !== null,
                gap: page.body.gap,
                page: page.body.nextBefore,
                held: activityMetaRef.current?.nextBefore ?? null,
              });
              setActivityMeta({ status: page.body.status, nextBefore: cursor });
              setEntries((held) => (until === null ? mergeHead([], { entries: page.body.entries, gap: true }) : mergeHead(held, { entries: page.body.entries, gap: page.body.gap })));
              // One place decides whether the loaded history is complete, and it
              // is the same cursor the stats and Load older read.
              setOlder((current) => ({ ...current, complete: cursor === null }));

              // THE SETTLEMENT THE STATE RECORDS IS FETCHED, NOT DENIED.
              //
              // What is held once this page lands, mergeHead's way: a gap
              // REPLACED the head, so what was under it is gone. For the decision
              // only — a manual page appended while this read was in flight can
              // at worst make it ask for a page it need not have.
              const loaded = until === null || page.body.gap ? page.body.entries : [...page.body.entries, ...entriesRef.current];
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
                // `activityMeta` nor `older`: these rows say nothing whatever
                // about how much of the VAULT's history is loaded, and a failure
                // of a read nobody asked for is not the Load older button's.
                if (filled.entries.length > 0) setLinkEntries((held) => appendOlder(held, filled.entries));
                seen.push(...filled.entries);
              }
            }
          }
        } finally {
          // Whatever the history did — answered, failed, or needed no round —
          // the page is drawn with it. Only an answer overtaken by a newer read
          // draws nothing (the gate asks).
          gate.release();
        }
        setFailures(0);
        setFailure(null);
        // What the chain rang about and this read has now seen — and what moved
        // that nobody heard, from the balances against the last read's.
        if (wantsActivity) {
          const moved = movedSince(recallPush(pensionKey).baseline, answered.body);
          rememberPush(pensionKey, { baseline: baselineOf(answered.body) });
          const ends = walletEnds(answered.body, seen);
          setPush((held) => afterRead(heardLate(held, moved), { slot: answered.body.slot, historyRead, readAtMs: answered.body.readAtMs, ends }));
        }
        setLastReadAt(Date.now());
        return true;
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
    });
    watchRef.current = watch;
    return () => {
      watch.close();
      if (watchRef.current === watch) watchRef.current = null;
    };
  }, [pensionKey, wantsActivity, hasWatched, wsUrl]);
  // A changed set — a wallet linked, a token account created — is resubscribed, not reopened.
  useEffect(() => {
    watchRef.current?.setAddresses(watched === "" ? [] : watched.split(","));
  }, [watched, pensionKey, wantsActivity, hasWatched, wsUrl]);

  /*
   * THE READ A PUSH BUYS (live-push.ts pushReadDelayMs): one, at the end of the
   * debounce window, never sooner than the floor after the last read, never
   * before a retry-after, never while backing off, hidden, or reading. A read
   * that answered from before the change leaves it standing, and this asks
   * again after the floor.
   */
  useEffect(() => {
    if (pensionKey === null) return undefined;
    const visible = typeof document === "undefined" || document.visibilityState === "visible";
    const delay = pushReadDelayMs({ dirty: push.dirty, now: Date.now(), lastReadAt, visible, reading, failures, retryAt });
    if (delay === null) return undefined;
    const timer = window.setTimeout(() => {
      // Hidden since this was armed: the change stays, and the tab reads it when it is looked at again.
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      void read(false).then((ran) => {
        if (ran) setTick((count) => count + 1);
      });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [pensionKey, push.dirty, lastReadAt, reading, failures, retryAt, tick, read]);

  const refresh = useCallback(
    (options: { readonly discover?: boolean } = {}): void => {
      const delay = nextManualDelayMs({ lastReadAt: lastReadRef.current, now: Date.now(), retryAfterSeconds: null });
      // Clicking twice, or closing the modal straight after opening it, must not
      // spend a minute's tokens in a second.
      if (delay <= 0) void read(options.discover ?? false);
      else window.setTimeout(() => void read(options.discover ?? false), Math.min(delay, MANUAL_FLOOR_MS));
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
    void api.activity({ owner: pensionKey, limit: ACTIVITY_PAGE, before }).then((page) => {
      olderBusyRef.current = false;
      if (page.ok) {
        setEntries((held) => appendOlder(held, page.body.entries));
        setActivityMeta({ status: page.body.status, nextBefore: page.body.nextBefore });
        setOlder({ busy: false, retryAt: null, message: null, complete: page.body.nextBefore === null });
        return;
      }
      setOlder({
        busy: false,
        retryAt: page.retryAfterSeconds === null ? null : Date.now() + page.retryAfterSeconds * 1_000,
        message: wordsFor(page),
        complete: false,
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
    if (pensionKey === null) return undefined;
    const visible = typeof document === "undefined" || document.visibilityState === "visible";
    const pending = pendingPollWanted({ active: pendingActive, activeSince: activeSinceRef.current, now: Date.now(), activityRetryAt: activityTrouble?.retryAt ?? null });
    const delay = nextDelayMs({ failures, retryAfterSeconds: null, visible, lastReadAt, now: Date.now(), reading, pending });
    if (delay === null) return undefined;
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

    const timer = window.setTimeout(() => {
      // Only a read that actually RAN re-arms the poll. A call that turned back
      // at the in-flight guard re-arms nothing: the read already running will,
      // when it finishes and `reading` falls.
      void read(false, soon !== null && when === soon).then((ran) => {
        if (ran) setTick((count) => count + 1);
      });
    }, when);
    return () => window.clearTimeout(timer);
  }, [pensionKey, failures, lastReadAt, failure, activityTrouble, tick, read, reading, pendingActive]);

  const cursor = activityMeta?.nextBefore ?? null;
  const olderView = useMemo((): LiveOlder => ({ ...older, available: cursor !== null }), [older, cursor]);

  // Drawn, a history to read, and neither an answer nor a failure yet.
  const activityPending = wantsActivity && snapshot !== null && snapshot.vault.status === "exists" && activityMeta === null && activityTrouble === null;

  return {
    view,
    refresh,
    loadOlder,
    older: olderView,
    activityUnreadable: activityTrouble !== null,
    activityRetryAt: activityTrouble?.retryAt ?? null,
    activityPending,
  };
}
