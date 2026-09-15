"use client";

// THE SOLANA ENTRY: useWallets, useSignTransaction and useSignMessage for Solana standard wallets, Phantom and Privy's alike.
import { useSignMessage, useSignTransaction, useWallets } from "@privy-io/react-auth/solana";
import { createContext, createElement, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

import { useVaultScreen } from "@/hooks/use-vault-state";
import { pensionSigner, tradingSigners, type SignMessageFn, type SignTransactionFn } from "@/lib/signing-wallets";
import type { BuiltTransactionJson } from "@/lib/vault-api";
import { FAILURE_COPY } from "@/lib/vault-copy";
import {
  checkAgainFlow,
  createVaultFlow,
  investPolicyFlow,
  linkWalletFlow,
  withdrawFlow,
  withdrawTokenFlow,
  type FlowResult,
  type FlowStep,
} from "@/lib/vault-flows";

/**
 * THE VAULT WRITES, WIRED TO PRIVY: Phantom and the trading wallets from
 * useWallets, their signatures from useSignTransaction and useSignMessage, into
 * the pure flows of src/lib/vault-flows.ts.
 *
 * ONE WRITE AT A TIME FOR THE WHOLE SCREEN. VaultWriteLock holds the key of the
 * write in progress; a ref closes the gap before React re-renders, so a second
 * click anywhere on the screen (the vault card, another wallet's row, investing,
 * a withdrawal) starts nothing. Wallet approvals that overlap would fight over
 * Phantom's window and the blockhash's lifetime.
 *
 * EXPLICIT CALLS ONLY. Every action takes the values it needs and no event; the
 * signers hand Privy explicit objects (src/lib/signing-wallets.ts).
 *
 * A link's consent signature is kept in memory for this row, so "Link this
 * wallet" after an expired approval window reuses it; it is dropped once the
 * link lands or the server refuses it.
 *
 * WHILE PHANTOM ASKS, the checked build answer rides in the progress, so a card
 * can show what is being signed (an investment policy's floors).
 */

type ConnectedWallet = ReturnType<typeof useWallets>["wallets"][number];

export type WriteKind = "create" | "link" | "policy" | "withdraw" | "withdrawToken";

export type WriteProgress =
  | { readonly phase: "idle" }
  | { readonly phase: "running"; readonly kind: WriteKind; readonly step: FlowStep; readonly built: BuiltTransactionJson | null }
  | { readonly phase: "finished"; readonly kind: WriteKind; readonly result: FlowResult };

export interface CreateRequest {
  readonly mode: number;
  readonly maxContribution: bigint;
  readonly walletReserve: bigint;
}

export interface InvestRequest {
  /** USDC raw units. */
  readonly maxPerCall: bigint;
  /** USDC raw units. */
  readonly maxRolling30d: bigint;
  readonly enabled: boolean;
}

export interface TokenWithdrawRequest {
  readonly mint: string;
  readonly amountRaw: bigint;
  /** The vault account the screen showed the holding in, and its token program. */
  readonly vaultTokenAccount: string;
  readonly tokenProgram: string;
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
const REFRESH_AFTER = new Set([
  "vault_exists",
  "vault_missing",
  "config_missing",
  "protocol_paused",
  "wallet_already_linked",
  "already_exists",
  "above_withdrawable",
  "not_held",
  "above_holding",
  "mint_unexpected",
]);

type LastRequest =
  | { readonly kind: "create"; readonly input: CreateRequest }
  | { readonly kind: "link"; readonly tradingAddress: string }
  | { readonly kind: "policy"; readonly input: InvestRequest }
  | { readonly kind: "withdraw"; readonly lamports: bigint }
  | { readonly kind: "withdrawToken"; readonly input: TokenWithdrawRequest };

interface FlowHooks {
  readonly onStep: (step: FlowStep) => void;
  readonly onBuilt: (body: BuiltTransactionJson) => void;
}

/** One card's or one row's writes, under the screen's lock. `key` names the writer ("vault", "link:<address>", "policy", "withdraw:sol"…). */
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
    async (kind: WriteKind, flow: (hooks: FlowHooks) => Promise<FlowResult>): Promise<void> => {
      if (screen === null || lock === null || !lock.acquire(key)) return;
      let built: BuiltTransactionJson | null = null;
      setProgress({ phase: "running", kind, step: "preparing", built });
      const hooks: FlowHooks = {
        onStep: (step) => setProgress({ phase: "running", kind, step, built }),
        onBuilt: (body) => {
          built = body;
        },
      };
      try {
        const result = await flow(hooks);
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
      return run("create", ({ onStep, onBuilt }) =>
        createVaultFlow(
          { api, onStep, onBuilt, signers: pensionSigner({ wallets, pensionKey, signTransaction: signOne }) },
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
      return run("link", async ({ onStep, onBuilt }) => {
        const outcome = await linkWalletFlow(
          {
            api,
            onStep,
            onBuilt,
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

  const investPolicy = useCallback(
    (input: InvestRequest): Promise<void> => {
      if (screen === null) return Promise.resolve();
      lastRequest.current = { kind: "policy", input };
      const { api, pensionKey } = screen;
      return run("policy", ({ onStep, onBuilt }) =>
        investPolicyFlow(
          { api, onStep, onBuilt, signers: pensionSigner({ wallets, pensionKey, signTransaction: signOne }) },
          { pensionKey, maxPerCall: input.maxPerCall, maxRolling30d: input.maxRolling30d, enabled: input.enabled },
        ),
      );
    },
    [screen, run, wallets, signOne],
  );

  const withdraw = useCallback(
    (lamports: bigint): Promise<void> => {
      if (screen === null) return Promise.resolve();
      lastRequest.current = { kind: "withdraw", lamports };
      const { api, pensionKey } = screen;
      return run("withdraw", ({ onStep, onBuilt }) =>
        withdrawFlow({ api, onStep, onBuilt, signers: pensionSigner({ wallets, pensionKey, signTransaction: signOne }) }, { pensionKey, lamports }),
      );
    },
    [screen, run, wallets, signOne],
  );

  const withdrawToken = useCallback(
    (input: TokenWithdrawRequest): Promise<void> => {
      if (screen === null) return Promise.resolve();
      lastRequest.current = { kind: "withdrawToken", input };
      const { api, pensionKey } = screen;
      return run("withdrawToken", ({ onStep, onBuilt }) =>
        withdrawTokenFlow(
          { api, onStep, onBuilt, signers: pensionSigner({ wallets, pensionKey, signTransaction: signOne }) },
          { pensionKey, mint: input.mint, amountRaw: input.amountRaw, vaultTokenAccount: input.vaultTokenAccount, tokenProgram: input.tokenProgram },
        ),
      );
    },
    [screen, run, wallets, signOne],
  );

  /** "Build again": the last write, built fresh with the wallets and the prices as they are now. */
  const buildAgain = useCallback((): Promise<void> => {
    const last = lastRequest.current;
    if (last === null) return Promise.resolve();
    switch (last.kind) {
      case "create":
        return createVault(last.input);
      case "link":
        return link(last.tradingAddress);
      case "policy":
        return investPolicy(last.input);
      case "withdraw":
        return withdraw(last.lamports);
      case "withdrawToken":
        return withdrawToken(last.input);
    }
  }, [createVault, link, investPolicy, withdraw, withdrawToken]);

  /** "Check again": confirms the signature the send route already took. It never builds or signs. */
  const checkAgain = useCallback((): Promise<void> => {
    if (screen === null || progress.phase !== "finished") return Promise.resolve();
    const { result, kind } = progress;
    if (result.ok || result.kind !== "unconfirmed") return Promise.resolve();
    const { signature, lastValidBlockHeight } = result;
    const { api } = screen;
    return run(kind, ({ onStep }) => checkAgainFlow({ api, onStep }, { signature, lastValidBlockHeight }));
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
    investPolicy,
    withdraw,
    withdrawToken,
    buildAgain,
    checkAgain,
    dismiss,
  } as const;
}
