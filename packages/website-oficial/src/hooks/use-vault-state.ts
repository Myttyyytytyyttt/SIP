"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { vaultFailureWords, type VaultApi, type VaultStateJson } from "@/lib/vault-api";
import { VAULT_OPEN_FLOOR_MS, createFloorGate, vaultPollDelayMs } from "@/lib/vault-follow";

/**
 * WHAT THE WALLETS SCREEN KNOWS OF THE CHAIN: POST /api/solana-vault on mount,
 * whenever the trading wallets change, and after each landed write (refresh).
 *
 * "unreadable" here means the route itself did not answer usefully (a network
 * failure, a 503, a rate limit); a 200 whose vault read failed is "ready" with
 * vault.status "unreadable", and the cards say so. A refresh keeps the last
 * answer on screen until the next one arrives, and a late answer for an older
 * request is dropped.
 *
 * AN UNREADABLE ANSWER IS READ AGAIN BY ITSELF (owner, 09-25). One failed read
 * used to leave every card that waits on this view — VaultCard, InvestingCard,
 * the live start-buying card, the Vault settings gear — dead until a reload.
 * While the view stays "unreadable" it is read again after the longer of
 * UNREADABLE_RETRY_MS and the route's own Retry-After, for as long as the route
 * keeps failing. A 200 whose vault read failed is "ready" and is NOT retried
 * here: the route answered, and its cards say what it could not read.
 *
 * AND IT FOLLOWS THE CHAIN (diagnosis 10-09, inventory D2: the modal showed
 * the vault as it was when the page mounted, whatever had landed since). Two
 * ways, both in src/lib/vault-follow.ts: catchUp(), the read nobody pressed —
 * the dashboard calls it when its live store saw the vault move and when the
 * Manage wallets modal opens — and, with `poll`, a read every sweep while the
 * tab is visible plus one on returning to it, for /wallets, where nothing
 * else is reading.
 *
 * A READ NOBODY PRESSED KEEPS WHAT IS ON SCREEN. A catch-up or a poll that
 * fails — a 429 from a bucket the person never touched — leaves a ready view
 * where it is, instead of turning every card into "could not be read" over
 * numbers that were right a moment ago; the next one tries again. Refresh and
 * Retry, which someone pressed, still say what happened.
 *
 * `refreshing` is true while a read is out over a view already on screen —
 * "loading" says the first one — so a card can show the Refresh it was given
 * as busy rather than dead.
 */

/** The shortest wait before an unreadable view is read again: 15 s. */
export const UNREADABLE_RETRY_MS = 15_000;

export type VaultView =
  | { readonly kind: "loading" }
  /** `retryAfterSeconds`: the route's own Retry-After (a 429's), or null when it named none. */
  | { readonly kind: "unreadable"; readonly message: string; readonly retryAfterSeconds?: number | null }
  | { readonly kind: "ready"; readonly state: VaultStateJson };

export interface VaultScreenValue {
  readonly pensionKey: string;
  readonly view: VaultView;
  /** Reads the state again. Takes no argument, so it is safe as a click handler's body. */
  readonly refresh: () => void;
  readonly api: VaultApi;
  /**
   * A read is out over a view already on screen (VaultStateStore.refreshing).
   * Optional only so a test's hand-built screen need not name it; the screen
   * VaultScreen mounts always does.
   */
  readonly refreshing?: boolean;
  /** A read nobody pressed, under a floor (VaultStateStore.catchUp). Optional for the same reason. */
  readonly catchUp?: (floorMs?: number) => void;
}

export const VaultScreenContext = createContext<VaultScreenValue | null>(null);

/** The screen's chain state and client, or null outside VaultScreen. */
export const useVaultScreen = (): VaultScreenValue | null => useContext(VaultScreenContext);

/** How long an unreadable view waits before it is read again: never under UNREADABLE_RETRY_MS, and never before the route's Retry-After. */
export function unreadableRetryMs(retryAfterSeconds: number | null | undefined): number {
  const asked = typeof retryAfterSeconds === "number" && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1_000 : 0;
  return Math.max(UNREADABLE_RETRY_MS, asked);
}

/**
 * What a failed answer leaves on screen: the failure — unless nobody pressed
 * for this read and a ready view is already drawn, which then stays.
 */
export function viewAfterFailure(held: VaultView, failed: VaultView, quiet: boolean): VaultView {
  return quiet && held.kind === "ready" ? held : failed;
}

export interface VaultStateOptions {
  /**
   * Read every VAULT_POLL_MS while the tab is visible, and on returning to it
   * (VAULT_OPEN_FLOOR_MS after the last read began). For a screen nothing else
   * keeps current: /wallets. Default false — the dashboard's shared screen
   * follows its live store instead (useVaultFollowsLive).
   */
  readonly poll?: boolean;
}

export interface VaultStateStore {
  readonly view: VaultView;
  /** Read again now, as someone pressed for it: a failure shows. */
  readonly refresh: () => void;
  /** A read is out over a view already on screen ("loading" says the first one). */
  readonly refreshing: boolean;
  /**
   * A read nobody pressed: at once when the last read began `floorMs` ago
   * (default VAULT_OPEN_FLOOR_MS, 10 s), otherwise once when it has
   * (createFloorGate). A failure keeps a ready view on screen.
   */
  readonly catchUp: (floorMs?: number) => void;
}

export function useVaultState(api: VaultApi, pensionKey: string, wallets: readonly string[], options: VaultStateOptions = {}): VaultStateStore {
  const poll = options.poll ?? false;
  const [view, setView] = useState<VaultView>({ kind: "loading" });
  const [nonce, setNonce] = useState(0);
  /** The request whose answer is awaited, or null when none is out. */
  const [awaited, setAwaited] = useState<number | null>(null);
  /** When the last answer came, good or not: the poll counts from it. */
  const [answeredAt, setAnsweredAt] = useState<number | null>(null);
  /** Moves when the tab is looked at again, so the poll re-arms. */
  const [shown, setShown] = useState(0);
  const latest = useRef(0);
  // A string, so a new array with the same wallets does not read again.
  const walletsKey = wallets.join(",");

  /*
   * ONE READ, however it was asked for. A late answer for an older request is
   * dropped by `latest`; `quiet` is a read nobody pressed (viewAfterFailure).
   * The returned function drops this one's answer — the effect's cleanup.
   */
  const gateRef = useRef<ReturnType<typeof createFloorGate> | null>(null);
  const run = useCallback(
    (quiet: boolean): (() => void) => {
      const request = ++latest.current;
      let current = true;
      gateRef.current?.started();
      setAwaited(request);
      void api.state({ owner: pensionKey, wallets: walletsKey === "" ? [] : walletsKey.split(",") }).then((answer) => {
        if (!current || request !== latest.current) return;
        setAwaited(null);
        setAnsweredAt(Date.now());
        if (answer.ok) {
          setView({ kind: "ready", state: answer.body });
          return;
        }
        const failed: VaultView = { kind: "unreadable", message: vaultFailureWords(answer), retryAfterSeconds: answer.retryAfterSeconds };
        setView((held) => viewAfterFailure(held, failed, quiet));
      });
      return () => {
        current = false;
      };
    },
    [api, pensionKey, walletsKey],
  );
  // The gate outlives renders; what it runs is always the newest key's read.
  const runRef = useRef(run);
  runRef.current = run;
  if (gateRef.current === null) gateRef.current = createFloorGate({ run: () => void runRef.current(true) });
  // A read kept for later belongs to the key it was asked for: a new key, or leaving, drops it.
  useEffect(() => () => gateRef.current?.dispose(), [run]);

  // On mount, whenever the key or the wallets change, and on refresh(): a read someone asked for.
  useEffect(() => run(false), [run, nonce]);

  // Keyed on the view object: every answer is a new one, so a read that fails
  // again schedules the next retry, and a readable answer clears the pending
  // one. A manual refresh meanwhile only reads once more; the older answer is
  // dropped by `latest` like any other.
  useEffect(() => {
    if (view.kind !== "unreadable") return;
    const timer = setTimeout(() => setNonce((value) => value + 1), unreadableRetryMs(view.retryAfterSeconds));
    return () => clearTimeout(timer);
  }, [view]);

  const catchUp = useCallback((floorMs: number = VAULT_OPEN_FLOOR_MS) => gateRef.current?.ask(floorMs), []);

  // /wallets' OWN POLL: a sweep after the last answer, only while visible and
  // with nothing out; re-armed by each answer and by the tab being looked at.
  useEffect(() => {
    if (!poll || typeof document === "undefined" || document.visibilityState !== "visible" || awaited !== null) return undefined;
    const timer = setTimeout(() => {
      if (document.visibilityState === "visible") runRef.current(true);
    }, vaultPollDelayMs({ answeredAt, now: Date.now() }));
    return () => clearTimeout(timer);
  }, [poll, answeredAt, awaited, shown]);

  // COMING BACK TO /wallets reads once, under the person's floor, and re-arms the poll.
  useEffect(() => {
    if (!poll || typeof document === "undefined") return undefined;
    const onShow = (): void => {
      if (document.visibilityState !== "visible") return;
      catchUp(VAULT_OPEN_FLOOR_MS);
      setShown((count) => count + 1);
    };
    document.addEventListener("visibilitychange", onShow);
    window.addEventListener("focus", onShow);
    return () => {
      document.removeEventListener("visibilitychange", onShow);
      window.removeEventListener("focus", onShow);
    };
  }, [poll, catchUp]);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);
  const refreshing = awaited !== null && view.kind !== "loading";
  return useMemo(() => ({ view, refresh, refreshing, catchUp }), [view, refresh, refreshing, catchUp]);
}
