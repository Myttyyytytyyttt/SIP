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
 * nothing has renamed it since. A wallet whose save is still on its way keeps
 * the name it shows whatever another wallet's answer says, so two renames in a
 * row never flicker the first one back to its old name.
 *
 * NO STORE, NO PENCIL. `available` turns true only when the server answered the
 * read: a deployment without a store (503 names_off), a session the server
 * would not believe, or no answer at all leaves the derived names and no
 * pencil. Outside a host — the sample, a unit test — it is the same: nothing to
 * read, nothing offered. `account` is true from the sign-in on, before the read
 * lands, so a name keeps the height the pencil will give it and nothing moves
 * when it appears.
 *
 * Nothing is written to the browser's storage: the names are the account's,
 * and a shared computer keeps none of them after the session ends.
 */

import { usePrivy } from "@privy-io/react-auth";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { RENAME_COPY } from "@/lib/live-copy";
import type { ApiFailure } from "@/lib/vault-api";
import { WALLET_NAME_COPY } from "@/lib/wallet-names";
import { readWalletNames, saveWalletName } from "@/lib/wallet-names-client";

/** A failed save in the words that stand in the name's place, and the sentence behind them when there is one. */
export interface RenameFailure {
  readonly message: string;
  readonly detail: string | null;
}

export type RenameResult = { readonly ok: true } | ({ readonly ok: false } & RenameFailure);

export interface WalletNamesValue {
  /** Whether a login's names are read here: from the sign-in on, before the read lands. */
  readonly account: boolean;
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
  account: false,
  available: false,
  names: NO_NAMES,
  rename: async (): Promise<RenameResult> => ({ ok: false, message: RENAME_COPY.failed, detail: null }),
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

/** One save, as its answer finds it. */
export interface SaveAnswer {
  readonly address: string;
  /** What it saved: a name, or null for the default. */
  readonly name: string | null;
  /** The wallet's own name when the save began (null: its default). */
  readonly before: string | null;
  /** This save's number, and the newest save's: they are equal when no save began after it. */
  readonly save: number;
  readonly newest: number;
  /** Whether it is still this wallet's latest save — no rename of the same wallet began after it. */
  readonly latest: boolean;
  /** The wallets with a save still on its way (this one left out when this was its latest). */
  readonly pending: ReadonlySet<string>;
  /** The server's names after the save; null when it failed. */
  readonly answer: Readonly<Record<string, string>> | null;
}

/**
 * WHAT ONE SAVE'S ANSWER DOES TO THE NAMES ON SCREEN (`shown`), kept out of the
 * hook so the races can be tested without a DOM.
 *   - The newest save's answer is the whole list, the latest there is — except
 *     that a wallet with a save still on its way keeps the name it shows.
 *   - An older answer, arriving late, sets its own wallet only, and only while
 *     no newer rename of that wallet began.
 *   - A failure puts the wallet's old name back, unless a newer rename of it is
 *     on its way or already put another name there.
 */
export function namesAfterAnswer(shown: Readonly<Record<string, string>>, settled: SaveAnswer): Readonly<Record<string, string>> {
  const { address, name, before, save, newest, latest, pending, answer } = settled;
  if (answer !== null) {
    if (save === newest) {
      let next = answer;
      for (const other of pending) next = withName(next, other, shown[other] ?? null);
      return next;
    }
    return latest ? withName(shown, address, answer[address] ?? null) : shown;
  }
  const stillOurs = latest || (!pending.has(address) && (shown[address] ?? null) === name);
  return stillOurs ? withName(shown, address, before) : shown;
}

/** A refusal of what was typed, by the rule it broke (lib/wallet-names.ts says the rule; this says it short). */
export function refusalWords(rule: string): RenameFailure {
  if (rule === WALLET_NAME_COPY.tooLong) return { message: RENAME_COPY.tooLong, detail: rule };
  if (rule === WALLET_NAME_COPY.forbidden) return { message: RENAME_COPY.forbidden, detail: rule };
  return { message: RENAME_COPY.failed, detail: rule };
}

/** A refused save in the words the pencil shows for a moment; the server's own sentence, when it gave one, behind them. */
function failureWords(failure: ApiFailure | null): RenameFailure {
  if (failure === null || failure.status === 401) return { message: RENAME_COPY.signIn, detail: null };
  if (failure.status === 429) return { message: RENAME_COPY.rateLimited, detail: null };
  if (failure.code === "too_many_names") return { message: RENAME_COPY.tooManyNames, detail: failure.message === "" ? null : failure.message };
  if (failure.code === "bad_request" && failure.message !== "") return refusalWords(failure.message);
  return { message: RENAME_COPY.failed, detail: null };
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
  // The latest save still on its way, by wallet: its answer, and no other's, decides that wallet's name.
  const pending = useRef(new Map<string, number>());

  // ONE READ PER LOGIN. A new user starts from nothing, never from the last one's names.
  useEffect(() => {
    setNames(NO_NAMES);
    setAvailable(false);
    pending.current.clear();
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
      if (who === null) return { ok: false, message: RENAME_COPY.signIn, detail: null };
      const save = (saves.current += 1);
      pending.current.set(address, save);
      const before = namesNow.current[address] ?? null;
      setNames(withName(namesNow.current, address, name));

      const token = await tokenOf.current().catch(() => null);
      const result = token === null ? null : await saveWalletName(token, address, name);
      // Signed out, or someone else signed in, while it was saving: nothing of this answer is theirs.
      if (owner.current !== who) return { ok: false, message: RENAME_COPY.failed, detail: null };
      // Whether this is still the latest save for this wallet: a newer one's answer decides it otherwise.
      const latest = pending.current.get(address) === save;
      if (latest) pending.current.delete(address);
      const answer = result !== null && result.ok ? result.body.names : null;
      setNames(namesAfterAnswer(namesNow.current, { address, name, before, save, newest: saves.current, latest, pending: new Set(pending.current.keys()), answer }));
      if (result !== null && result.ok) return { ok: true };
      return { ok: false, ...failureWords(result) };
    },
    [setNames],
  );

  const value = useMemo<WalletNamesValue>(
    () => ({ account: userId !== null, available: available && userId !== null, names: userId === null ? NO_NAMES : names, rename }),
    [available, userId, names, rename],
  );
  return <WalletNamesContext.Provider value={value}>{children}</WalletNamesContext.Provider>;
}
