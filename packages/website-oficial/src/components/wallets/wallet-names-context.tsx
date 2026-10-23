"use client";

/**
 * THE ACCOUNT'S OWN WALLET NAMES, FOR EVERY SCREEN THAT NAMES A WALLET (owner,
 * 10-23: names saved to the account, on every device, with no signature).
 *
 * Read once per login from /api/wallet-names with the session's Privy access
 * token, and held here, above the live dashboard and the wallets modal alike:
 * the live store lays them over the derived names (live-model.ts walletsOf),
 * and so does the Manage wallets list (TradingWalletsCard), so a wallet renamed
 * in one place is renamed in the column, the activity rows, the chips' tooltips,
 * the next-step notes and the modal at once.
 *
 * A RENAME SHOWS AT ONCE, and is taken back if the save fails: the name is set
 * here before the request, the server's answer replaces the list when it comes,
 * and a refusal puts the old name back — only for that wallet, and only while
 * nothing has renamed it since.
 *
 * NO STORE, NO PENCIL. `available` turns true only when the server answered the
 * read: a deployment without a store (503 names_off), a session the server
 * would not believe, or no answer at all leaves the derived names and no
 * pencil. Outside a host — the sample, a unit test — it is the same: nothing to
 * read, nothing offered.
 *
 * Nothing is written to the browser's storage: the names are the account's,
 * and a shared computer keeps none of them after the session ends.
 */

import { usePrivy } from "@privy-io/react-auth";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { RENAME_COPY } from "@/lib/live-copy";
import type { ApiFailure } from "@/lib/vault-api";
import { readWalletNames, saveWalletName } from "@/lib/wallet-names-client";

export type RenameResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

export interface WalletNamesValue {
  /** Whether a name can be saved here: the pencil shows only then. */
  readonly available: boolean;
  /** The account's own names, by address. Every other wallet shows its derived name. */
  readonly names: Readonly<Record<string, string>>;
  /** Saves `name` for `address`, null for back to the default name. Shown at once; the result says whether it held. */
  rename(address: string, name: string | null): Promise<RenameResult>;
}

const NO_NAMES: Readonly<Record<string, string>> = Object.freeze({});

/** Outside a host: no names, no pencil. */
const NONE: WalletNamesValue = Object.freeze({
  available: false,
  names: NO_NAMES,
  rename: async (): Promise<RenameResult> => ({ ok: false, message: RENAME_COPY.failed }),
});

/** Exported for tests, which hand a list its names without Privy; the app mounts WalletNamesHost. */
export const WalletNamesContext = createContext<WalletNamesValue>(NONE);

export function useWalletNames(): WalletNamesValue {
  return useContext(WalletNamesContext);
}

/** A read that failed for a moment is asked again once, after this long; one that says "off" or "not you" is not. */
const READ_RETRY_MS = 15_000;

/** `names` with `address` set to `name`, or removed when `name` is null. */
function withName(names: Readonly<Record<string, string>>, address: string, name: string | null): Readonly<Record<string, string>> {
  const next = { ...names };
  if (name === null) delete next[address];
  else next[address] = name;
  return next;
}

/** A refusal in the words the pencil shows for a moment: the server's own for a name it would not keep. */
function failureWords(failure: ApiFailure | null): string {
  if (failure === null) return RENAME_COPY.signIn;
  if (failure.status === 429) return RENAME_COPY.rateLimited;
  if (failure.status === 401) return RENAME_COPY.signIn;
  if ((failure.code === "bad_request" || failure.code === "too_many_names") && failure.message !== "") return failure.message;
  return RENAME_COPY.failed;
}

/** Mounted inside Providers, wherever the wallets are managed: the dashboard's frame and /wallets. */
export function WalletNamesHost({ children }: { readonly children: ReactNode }) {
  const { ready, authenticated, user, getAccessToken } = usePrivy();
  const userId = ready && authenticated && user !== null && user !== undefined ? user.id : null;
  // The latest token getter and user, read inside callbacks that must not be rebuilt on every render.
  const tokenOf = useRef(getAccessToken);
  tokenOf.current = getAccessToken;
  const owner = useRef(userId);
  owner.current = userId;

  const [names, setNamesState] = useState<Readonly<Record<string, string>>>(NO_NAMES);
  const [available, setAvailable] = useState(false);
  // A mirror of the names, so a rename reads what is on screen NOW, not what its render saw.
  const namesNow = useRef(names);
  const setNames = useCallback((next: Readonly<Record<string, string>>) => {
    namesNow.current = next;
    setNamesState(next);
  }, []);
  const saves = useRef(0);

  // ONE READ PER LOGIN. A new user starts from nothing, never from the last one's names.
  useEffect(() => {
    setNames(NO_NAMES);
    setAvailable(false);
    if (userId === null) return undefined;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = async (again: boolean): Promise<void> => {
      const token = await tokenOf.current().catch(() => null);
      if (!live || token === null) return;
      const result = await readWalletNames(token);
      if (!live) return;
      if (result.ok) {
        setNames(result.body.names);
        setAvailable(true);
        return;
      }
      // Off, or not believed: a setting or a session, not a moment. Anything else is asked once more.
      const settled = result.code === "names_off" || result.status === 401;
      if (!settled && again) timer = setTimeout(() => void read(false), READ_RETRY_MS);
    };
    void read(true);
    return () => {
      live = false;
      if (timer !== null) clearTimeout(timer);
    };
  }, [userId, setNames]);

  const rename = useCallback(
    async (address: string, name: string | null): Promise<RenameResult> => {
      const who = owner.current;
      if (who === null) return { ok: false, message: RENAME_COPY.signIn };
      const save = (saves.current += 1);
      const before = namesNow.current[address] ?? null;
      setNames(withName(namesNow.current, address, name));

      const token = await tokenOf.current().catch(() => null);
      const result = token === null ? null : await saveWalletName(token, address, name);
      // Signed out, or someone else signed in, while it was saving: nothing of this answer is theirs.
      if (owner.current !== who) return { ok: false, message: RENAME_COPY.failed };

      if (result !== null && result.ok) {
        // The server's whole list when this is the latest save; only this wallet's otherwise, so an
        // older answer arriving late never undoes a newer rename still on its way.
        setNames(save === saves.current ? result.body.names : withName(namesNow.current, address, result.body.names[address] ?? null));
        return { ok: true };
      }
      // Back to the name it had — unless something renamed it again since.
      if ((namesNow.current[address] ?? null) === name) setNames(withName(namesNow.current, address, before));
      return { ok: false, message: failureWords(result) };
    },
    [setNames],
  );

  const value = useMemo<WalletNamesValue>(() => ({ available: available && userId !== null, names: userId === null ? NO_NAMES : names, rename }), [available, userId, names, rename]);
  return <WalletNamesContext.Provider value={value}>{children}</WalletNamesContext.Provider>;
}
