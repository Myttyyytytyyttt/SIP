"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

import { vaultFailureWords, type VaultApi, type VaultStateJson } from "@/lib/vault-api";

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
}

export const VaultScreenContext = createContext<VaultScreenValue | null>(null);

/** The screen's chain state and client, or null outside VaultScreen. */
export const useVaultScreen = (): VaultScreenValue | null => useContext(VaultScreenContext);

/** How long an unreadable view waits before it is read again: never under UNREADABLE_RETRY_MS, and never before the route's Retry-After. */
export function unreadableRetryMs(retryAfterSeconds: number | null | undefined): number {
  const asked = typeof retryAfterSeconds === "number" && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1_000 : 0;
  return Math.max(UNREADABLE_RETRY_MS, asked);
}

export function useVaultState(api: VaultApi, pensionKey: string, wallets: readonly string[]): { readonly view: VaultView; readonly refresh: () => void } {
  const [view, setView] = useState<VaultView>({ kind: "loading" });
  const [nonce, setNonce] = useState(0);
  const latest = useRef(0);
  // A string, so a new array with the same wallets does not read again.
  const walletsKey = wallets.join(",");

  useEffect(() => {
    const request = ++latest.current;
    let current = true;
    void api.state({ owner: pensionKey, wallets: walletsKey === "" ? [] : walletsKey.split(",") }).then((answer) => {
      if (!current || request !== latest.current) return;
      setView(answer.ok ? { kind: "ready", state: answer.body } : { kind: "unreadable", message: vaultFailureWords(answer), retryAfterSeconds: answer.retryAfterSeconds });
    });
    return () => {
      current = false;
    };
  }, [api, pensionKey, walletsKey, nonce]);

  // Keyed on the view object: every answer is a new one, so a read that fails
  // again schedules the next retry, and a readable answer clears the pending
  // one. A manual refresh meanwhile only reads once more; the older answer is
  // dropped by `latest` like any other.
  useEffect(() => {
    if (view.kind !== "unreadable") return;
    const timer = setTimeout(() => setNonce((value) => value + 1), unreadableRetryMs(view.retryAfterSeconds));
    return () => clearTimeout(timer);
  }, [view]);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);
  return { view, refresh };
}
