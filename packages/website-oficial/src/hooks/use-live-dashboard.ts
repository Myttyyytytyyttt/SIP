"use client";

/**
 * WHAT THE CONNECTED DASHBOARD KNOWS OF SOLANA, and when it asks again.
 *
 * One snapshot and one page of history on mount, then a poll at the keeper's own
 * sweep — never faster, because reading twice a minute shows the same numbers
 * twice and spends a key the keeper shares. A hidden tab polls not at all.
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
 * A LATE ANSWER FOR AN OLDER REQUEST IS DROPPED (a request counter, as
 * useVaultState does), and changing pension key resets everything — nothing read
 * for the previous key stays on screen for the next one.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { activityWasUnreadable, createLiveApi } from "@/lib/live-api";
import { appendOlder, mergeHead, newestSignature } from "@/lib/live-activity-store";
import { LIVE_COPY } from "@/lib/live-copy";
import { toLiveDashboard } from "@/lib/live-model";
import { MANUAL_FLOOR_MS, nextDelayMs, nextManualDelayMs, shouldRefreshOnShow } from "@/lib/live-schedule";
import type { LiveActivityJson, LiveDashboard, LiveEntryJson, LiveSnapshotJson } from "@/lib/live-types";
import { vaultFailureWords, type ApiFailure } from "@/lib/vault-api";

/** Signatures one page asks for. The route's own cap. */
export const ACTIVITY_PAGE = 15;
/** The most wallets one snapshot can ask about. */
const MAX_WALLETS = 10;
/** After this long without a good read, the stale note adds that the numbers may be out of date. */
export const STALE_WARNING_MS = 5 * 60_000;

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
}

export interface LiveDashboardStore {
  readonly view: LiveView;
  /** Read again now (subject to the 10 s floor). `discover` also re-lists the vault's links. */
  readonly refresh: (options?: { readonly discover?: boolean }) => void;
  readonly loadOlder: () => void;
  readonly older: LiveOlder;
  /** The last history read failed, or the route could not read it: the feed says so instead of "none yet". */
  readonly activityUnreadable: boolean;
}

const wordsFor = (failure: ApiFailure): string =>
  failure.status === 429 || failure.code === "rate_limited"
    ? LIVE_COPY.rateLimited(failure.retryAfterSeconds)
    : failure.code === "network"
      ? LIVE_COPY.network
      : failure.code === "unavailable"
        ? LIVE_COPY.deploymentUnavailable
        : vaultFailureWords(failure);

export function useLiveDashboard(input: { readonly pensionKey: string | null; readonly privyWallets: readonly string[] }): LiveDashboardStore {
  const { pensionKey } = input;
  const api = useMemo(() => createLiveApi(), []);
  // A string, so a new array with the same wallets does not read again.
  const walletsKey = input.privyWallets.join(",");

  const [snapshot, setSnapshot] = useState<LiveSnapshotJson | null>(null);
  const [entries, setEntries] = useState<readonly LiveEntryJson[]>([]);
  const [activityMeta, setActivityMeta] = useState<Pick<LiveActivityJson, "status" | "nextBefore"> | null>(null);
  const [failure, setFailure] = useState<{ readonly message: string; readonly retryAt: number | null; readonly since: number } | null>(null);
  const [failures, setFailures] = useState(0);
  const [lastReadAt, setLastReadAt] = useState<number | null>(null);
  const [older, setOlder] = useState<LiveOlder>({ busy: false, retryAt: null, message: null, complete: false });
  const [activityUnreadable, setActivityUnreadable] = useState(false);
  const [tick, setTick] = useState(0);

  // Everything a late answer must be checked against before it is believed.
  const request = useRef(0);
  const entriesRef = useRef<readonly LiveEntryJson[]>([]);
  entriesRef.current = entries;
  const snapshotRef = useRef<LiveSnapshotJson | null>(null);
  snapshotRef.current = snapshot;
  const readingRef = useRef(false);
  const lastReadRef = useRef<number | null>(null);
  lastReadRef.current = lastReadAt;

  // A DIFFERENT PENSION KEY IS A DIFFERENT PENSION: nothing carries over.
  useEffect(() => {
    request.current += 1;
    setSnapshot(null);
    setEntries([]);
    setActivityMeta(null);
    setFailure(null);
    setFailures(0);
    setLastReadAt(null);
    setOlder({ busy: false, retryAt: null, message: null, complete: false });
    setActivityUnreadable(false);
  }, [pensionKey]);

  const read = useCallback(
    async (discover: boolean): Promise<void> => {
      if (pensionKey === null || readingRef.current) return;
      readingRef.current = true;
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
        if (stale()) return;
        if (!answered.ok) {
          // The last good data stays on screen; only the note changes.
          setFailures((count) => count + 1);
          setFailure({ message: wordsFor(answered), retryAt: answered.retryAfterSeconds === null ? null : Date.now() + answered.retryAfterSeconds * 1_000, since: Date.now() });
          setLastReadAt(Date.now());
          return;
        }
        setSnapshot(answered.body);

        // No vault, no history: the route would answer an empty page, so it is not asked.
        if (answered.body.vault.status === "exists") {
          const until = newestSignature(entriesRef.current);
          const page = await api.activity({ owner: pensionKey, limit: ACTIVITY_PAGE, ...(until === null ? {} : { until }) });
          if (stale()) return;
          // CARRIED, NOT DROPPED. A page that failed, or one the route marked
          // unreadable, leaves the rows already on screen alone and tells the
          // feed it could not read — never "No activity yet".
          setActivityUnreadable(activityWasUnreadable(page));
          if (page.ok && page.body.status === "exists") {
            setActivityMeta({ status: page.body.status, nextBefore: page.body.nextBefore });
            setEntries((held) => (until === null ? mergeHead([], { entries: page.body.entries, gap: true }) : mergeHead(held, { entries: page.body.entries, gap: page.body.gap })));
            if (until === null) setOlder((current) => ({ ...current, complete: page.body.nextBefore === null }));
          }
        }
        setFailures(0);
        setFailure(null);
        setLastReadAt(Date.now());
      } finally {
        readingRef.current = false;
      }
    },
    [api, pensionKey, walletsKey],
  );

  // The first read, and a fresh one whenever the wallet list changes: a wallet
  // created a moment ago must appear without waiting out a sweep.
  useEffect(() => {
    if (pensionKey === null) return;
    void read(true);
  }, [pensionKey, walletsKey, read]);

  // THE POLL. Re-armed after each read, and never while the tab is hidden.
  useEffect(() => {
    if (pensionKey === null) return undefined;
    const visible = typeof document === "undefined" || document.visibilityState === "visible";
    const delay = nextDelayMs({ failures, retryAfterSeconds: null, visible, lastReadAt, now: Date.now() });
    if (delay === null) return undefined;
    const retryAt = failure?.retryAt ?? null;
    const wait = retryAt === null ? delay : Math.max(delay, retryAt - Date.now());
    const timer = window.setTimeout(() => {
      void read(false).finally(() => setTick((count) => count + 1));
    }, Math.max(0, wait));
    return () => window.clearTimeout(timer);
  }, [pensionKey, failures, lastReadAt, failure, tick, read]);

  // Coming back to a tab whose numbers are a sweep old reads once, at once.
  useEffect(() => {
    if (pensionKey === null || typeof document === "undefined") return undefined;
    const onShow = (): void => {
      if (document.visibilityState !== "visible") return;
      if (shouldRefreshOnShow(lastReadRef.current, Date.now())) void read(false);
      setTick((count) => count + 1);
    };
    document.addEventListener("visibilitychange", onShow);
    return () => document.removeEventListener("visibilitychange", onShow);
  }, [pensionKey, read]);

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
    if (pensionKey === null || before === null || older.busy) return;
    setOlder((current) => ({ ...current, busy: true, message: null }));
    void api.activity({ owner: pensionKey, limit: ACTIVITY_PAGE, before }).then((page) => {
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

  const view = useMemo((): LiveView => {
    if (pensionKey === null) return { kind: "idle" };
    if (snapshot === null) {
      if (failure === null) return { kind: "loading" };
      return { kind: "unreadable", message: failure.message, retryAt: failure.retryAt };
    }
    const data = toLiveDashboard({
      snapshot,
      activity: activityMeta === null ? null : { vault: snapshot.vault.address, status: activityMeta.status, nextBefore: activityMeta.nextBefore, entries, gap: false },
      privyWallets: walletsKey === "" ? [] : walletsKey.split(","),
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
  }, [pensionKey, snapshot, entries, activityMeta, failure, walletsKey]);

  return { view, refresh, loadOlder, older, activityUnreadable };
}
