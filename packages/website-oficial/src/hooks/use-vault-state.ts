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
 */

export type VaultView =
  | { readonly kind: "loading" }
  | { readonly kind: "unreadable"; readonly message: string }
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
      setView(answer.ok ? { kind: "ready", state: answer.body } : { kind: "unreadable", message: vaultFailureWords(answer) });
    });
    return () => {
      current = false;
    };
  }, [api, pensionKey, walletsKey, nonce]);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);
  return { view, refresh };
}
