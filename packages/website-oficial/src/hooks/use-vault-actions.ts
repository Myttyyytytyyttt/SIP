"use client";

// THE SOLANA ENTRY: useWallets, useSignTransaction and useSignMessage for Solana standard wallets, Phantom and Privy's alike.
import { useSignMessage, useSignTransaction, useWallets } from "@privy-io/react-auth/solana";
import { createContext, createElement, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

import { useVaultScreen } from "@/hooks/use-vault-state";
import { pensionSigner, tradingSigners, type SignMessageFn, type SignTransactionFn } from "@/lib/signing-wallets";
import { FAILURE_COPY } from "@/lib/vault-copy";
import { checkAgainFlow, createVaultFlow, linkWalletFlow, type FlowResult, type FlowStep } from "@/lib/vault-flows";

/**
 * THE VAULT WRITES, WIRED TO PRIVY: Phantom and the trading wallets from
 * useWallets, their signatures from useSignTransaction and useSignMessage, into
 * the pure flows of src/lib/vault-flows.ts.
 *
 * ONE WRITE AT A TIME FOR THE WHOLE SCREEN. VaultWriteLock holds the key of the
 * write in progress; a ref closes the gap before React re-renders, so a second
 * click anywhere on the screen (the vault card, another wallet's row) starts
 * nothing. Wallet approvals that overlap would fight over Phantom's window and
 * the blockhash's lifetime.
 *
 * EXPLICIT CALLS ONLY. Every action takes the values it needs and no event; the
 * signers hand Privy explicit objects (src/lib/signing-wallets.ts).
 *
 * A link's consent signature is kept in memory for this row, so "Link this
 * wallet" after an expired approval window reuses it; it is dropped once the
 * link lands or the server refuses it.
 */

type ConnectedWallet = ReturnType<typeof useWallets>["wallets"][number];

export type WriteKind = "create" | "link";

export type WriteProgress =
  | { readonly phase: "idle" }
  | { readonly phase: "running"; readonly kind: WriteKind; readonly step: FlowStep }
  | { readonly phase: "finished"; readonly kind: WriteKind; readonly result: FlowResult };

export interface CreateRequest {
  readonly mode: number;
  readonly maxContribution: bigint;
  readonly walletReserve: bigint;
}

interface WriteLock {
  /** The key of the write in progress, or null. */
  readonly holder: string | null;
  acquire(key: string): boolean;
  release(key: string): void;
}

const WriteLockContext = createContext<WriteLock | null>(null);

/** The screen-wide lock every vault write takes. */
export function VaultWriteLock({ children }: { readonly children?: ReactNode }) {
  const [holder, setHolder] = useState<string | null>(null);
  const held = useRef<string | null>(null);
  const lock = useMemo<WriteLock>(
    () => ({
      holder,
      acquire: (key) => {
        if (held.current !== null) return false;
        held.current = key;
        setHolder(key);
        return true;
      },
      release: (key) => {
        if (held.current !== key) return;
        held.current = null;
        setHolder(null);
      },
    }),
    [holder],
  );
  return createElement(WriteLockContext.Provider, { value: lock }, children);
}

/** Outcomes after which the page's picture of the chain is stale. */
const REFRESH_AFTER = new Set(["vault_exists", "vault_missing", "config_missing", "protocol_paused", "wallet_already_linked", "already_exists"]);

type LastRequest = { readonly kind: "create"; readonly input: CreateRequest } | { readonly kind: "link"; readonly tradingAddress: string };

/** One card's or one row's writes, under the screen's lock. `key` names the writer ("vault", "link:<address>"). */
export function useVaultWrite(key: string) {
  const screen = useVaultScreen();
  const lock = useContext(WriteLockContext);
  const { wallets } = useWallets();
  const { signTransaction } = useSignTransaction();
  const { signMessage } = useSignMessage();
  const [progress, setProgress] = useState<WriteProgress>({ phase: "idle" });
  const consents = useRef(new Map<string, Uint8Array>());
  const lastRequest = useRef<LastRequest | null>(null);

  // One input per call, never Privy's variadic form: each input would sign its own bytes.
  const signOne = useCallback<SignTransactionFn<ConnectedWallet>>((input) => signTransaction(input), [signTransaction]);
  const signMessageOne = useCallback<SignMessageFn<ConnectedWallet>>((input) => signMessage(input), [signMessage]);

  const run = useCallback(
    async (kind: WriteKind, flow: (onStep: (step: FlowStep) => void) => Promise<FlowResult>): Promise<void> => {
      if (screen === null || lock === null || !lock.acquire(key)) return;
      setProgress({ phase: "running", kind, step: "preparing" });
      try {
        const result = await flow((step) => setProgress({ phase: "running", kind, step }));
        setProgress({ phase: "finished", kind, result });
        if (result.ok || (result.kind === "refused" && result.code !== undefined && REFRESH_AFTER.has(result.code))) screen.refresh();
      } catch {
        setProgress({ phase: "finished", kind, result: { ok: false, kind: "refused", message: FAILURE_COPY.unknown } });
      } finally {
        lock.release(key);
      }
    },
    [screen, lock, key],
  );

  const createVault = useCallback(
    (input: CreateRequest): Promise<void> => {
      if (screen === null) return Promise.resolve();
      lastRequest.current = { kind: "create", input };
      const { api, pensionKey } = screen;
      return run("create", (onStep) =>
        createVaultFlow(
          { api, onStep, signers: pensionSigner({ wallets, pensionKey, signTransaction: signOne }) },
          { pensionKey, mode: input.mode, maxContribution: input.maxContribution, walletReserve: input.walletReserve },
        ),
      );
    },
    [screen, run, wallets, signOne],
  );

  const link = useCallback(
    (tradingAddress: string): Promise<void> => {
      if (screen === null) return Promise.resolve();
      lastRequest.current = { kind: "link", tradingAddress };
      const { api, pensionKey } = screen;
      const cacheKey = `${pensionKey}:${tradingAddress}`;
      return run("link", async (onStep) => {
        const outcome = await linkWalletFlow(
          {
            api,
            onStep,
            pension: pensionSigner({ wallets, pensionKey, signTransaction: signOne }),
            trading: tradingSigners({ wallets, pensionKey, tradingAddress, signTransaction: signOne, signMessage: signMessageOne }),
          },
          { pensionKey, tradingAddress, consentSignature: consents.current.get(cacheKey) ?? null },
        );
        if (outcome.consentSignature === null) consents.current.delete(cacheKey);
        else consents.current.set(cacheKey, outcome.consentSignature);
        return outcome;
      });
    },
    [screen, run, wallets, signOne, signMessageOne],
  );

  /** "Build again": the last write, built fresh with the wallets as they are now. */
  const buildAgain = useCallback((): Promise<void> => {
    const last = lastRequest.current;
    if (last === null) return Promise.resolve();
    return last.kind === "create" ? createVault(last.input) : link(last.tradingAddress);
  }, [createVault, link]);

  /** "Check again": confirms the signature the send route already took. It never builds or signs. */
  const checkAgain = useCallback((): Promise<void> => {
    if (screen === null || progress.phase !== "finished") return Promise.resolve();
    const { result, kind } = progress;
    if (result.ok || result.kind !== "unconfirmed") return Promise.resolve();
    const { signature, lastValidBlockHeight } = result;
    const { api } = screen;
    return run(kind, (onStep) => checkAgainFlow({ api, onStep }, { signature, lastValidBlockHeight }));
  }, [screen, progress, run]);

  const dismiss = useCallback(() => setProgress({ phase: "idle" }), []);

  const holder = lock?.holder ?? null;
  const unconfirmed = progress.phase === "finished" && !progress.result.ok && progress.result.kind === "unconfirmed";
  return {
    progress,
    /** This writer's write is in progress. */
    running: holder === key,
    /** Another writer on the screen holds the lock. */
    busyElsewhere: holder !== null && holder !== key,
    /** A sent transaction awaits confirmation: nothing new is offered until it is checked. */
    unconfirmed,
    createVault,
    link,
    buildAgain,
    checkAgain,
    dismiss,
  } as const;
}
