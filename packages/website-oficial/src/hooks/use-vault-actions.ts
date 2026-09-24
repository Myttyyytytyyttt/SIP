"use client";

// THE SOLANA ENTRY: useWallets, useSignTransaction and useSignMessage for Solana standard wallets, Phantom and Privy's alike.
import { useSignMessage, useSignTransaction, useWallets } from "@privy-io/react-auth/solana";
import { createContext, createElement, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

import { useVaultScreen } from "@/hooks/use-vault-state";
import { createAndLinkFlow, type CreateAndLinkOutcome } from "@/lib/create-and-link";
import { pensionSigner, tradingSigners, type SignMessageFn, type SignTransactionFn } from "@/lib/signing-wallets";
import type { CreateWalletFn, RefreshUserFn, SeatConfig } from "@/lib/trading-wallets";
import type { BuiltTransactionJson, InvestmentPolicyJson, VaultApi } from "@/lib/vault-api";
import { FAILURE_COPY } from "@/lib/vault-copy";
import {
  checkAgainFlow,
  createVaultFlow,
  investPolicyFlow,
  linkWalletFlow,
  setPolicyFlow,
  pauseInvestingFlow,
  withdrawFlow,
  withdrawTokenFlow,
  awaitsConfirmation,
  type FlowResult,
  type FlowStep,
  type LinkWalletResult,
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
 * A link's consent signature is kept in memory FOR THE WHOLE SCREEN, keyed by
 * pension key and trading wallet, so "Link this wallet" after an expired approval
 * window reuses it — and so does a link that a chained create started and a row
 * finishes. It is dropped once the link lands or the server refuses it.
 *
 * AN UNCONFIRMED LINK BELONGS TO THE WALLET, NOT TO THE BUTTON THAT SENT IT, and
 * is kept on the lock under the same key. The card's chained press and the
 * wallet's own row are different writers, so each seeing only its own sent-and-
 * unconfirmed link left the other one offering a second link for the same wallet:
 * both would be signed and sent, one landing and the other burning its fee.
 *
 * CREATE-AND-LINK IS ONE WRITE. The wallet's creation and its link run under a
 * single hold of the screen's lock, so nothing else can start between them; the
 * chain itself is src/lib/create-and-link.ts, and only the wiring is here.
 *
 * WHILE PHANTOM ASKS, the checked build answer rides in the progress, so a card
 * can show what is being signed (an investment policy's floors).
 */

type ConnectedWallet = ReturnType<typeof useWallets>["wallets"][number];

export type WriteKind = "create" | "createLink" | "link" | "rule" | "policy" | "withdraw" | "withdrawToken";

export type WriteProgress =
  | { readonly phase: "idle" }
  | { readonly phase: "running"; readonly kind: WriteKind; readonly step: FlowStep; readonly built: BuiltTransactionJson | null }
  | { readonly phase: "finished"; readonly kind: WriteKind; readonly result: FlowResult };

export interface CreateRequest {
  readonly mode: number;
  readonly maxContribution: bigint;
  readonly walletReserve: bigint;
  /** The profit rate in basis points; the product's default when absent. */
  readonly skimBps?: number;
}

export interface InvestRequest {
  /** USDC raw units. */
  readonly maxPerCall: bigint;
  /** USDC raw units. */
  readonly maxRolling30d: bigint;
  readonly enabled: boolean;
  /** USDC raw units, the least one LEG may be given; the product's default when absent. */
  readonly minInvestment?: bigint;
  /** The basket by mint, in basis points summing to exactly 10,000; equal shares when absent. */
  readonly weights?: ReadonlyMap<string, number>;
  /** A venue NAME, never a program id; the product's default when absent. */
  readonly venue?: string;
}

export interface TokenWithdrawRequest {
  readonly mint: string;
  readonly amountRaw: bigint;
  /** The vault account the screen showed the holding in, and its token program. */
  readonly vaultTokenAccount: string;
  readonly tokenProgram: string;
}

export interface WriteLock {
  /** The key of the write in progress, or null. */
  readonly holder: string | null;
  acquire(key: string): boolean;
  release(key: string): void;
  /** Consent signatures this screen already has, by `<pensionKey>:<tradingAddress>`. Shared, so one is signed once however it is retried. */
  readonly consents: Map<string, Uint8Array>;
  /** The links this screen has sent and cannot confirm, by the same key. Shared, so no second link for one wallet is offered anywhere. */
  readonly unconfirmedLinks: ReadonlySet<string>;
  setUnconfirmedLink(target: string, awaiting: boolean): void;
}

/** The lock's own context. Exported so a test can render the screen as it is mid-write; the app always takes it from VaultWriteLock. */
export const WriteLockContext = createContext<WriteLock | null>(null);

/** The key one trading wallet's link to one pension key's vault is kept under: its consent, and its wait for confirmation. */
const linkKey = (pensionKey: string, tradingAddress: string): string => `${pensionKey}:${tradingAddress}`;

const NO_LINKS: ReadonlySet<string> = new Set();

/** The screen-wide lock every vault write takes. */
export function VaultWriteLock({ children }: { readonly children?: ReactNode }) {
  const [holder, setHolder] = useState<string | null>(null);
  const held = useRef<string | null>(null);
  const consents = useRef(new Map<string, Uint8Array>());
  // State, not a ref: every writer on the screen re-renders when a link starts or stops waiting.
  const [unconfirmedLinks, setUnconfirmedLinks] = useState<ReadonlySet<string>>(NO_LINKS);
  const lock = useMemo<WriteLock>(
    () => ({
      holder,
      consents: consents.current,
      unconfirmedLinks,
      setUnconfirmedLink: (target, awaiting) =>
        setUnconfirmedLinks((current) => {
          if (current.has(target) === awaiting) return current;
          const next = new Set(current);
          if (awaiting) next.add(target);
          else next.delete(target);
          return next;
        }),
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
    [holder, unconfirmedLinks],
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
  "policy_missing",
  "already_paused",
  "balance_moved",
]);

/** The vault's own rule, all six fields, as setPolicy writes them. */
export interface VaultRuleRequest {
  readonly mode: number;
  readonly skimBps: number;
  readonly volumeBps: number;
  readonly paused: boolean;
  readonly maxContribution: bigint;
  readonly walletReserve: bigint;
}

type LastRequest =
  | { readonly kind: "create"; readonly input: CreateRequest }
  | { readonly kind: "rule"; readonly input: VaultRuleRequest }
  | { readonly kind: "link"; readonly tradingAddress: string }
  | { readonly kind: "policy"; readonly input: InvestRequest }
  | { readonly kind: "pause"; readonly policy: InvestmentPolicyJson }
  | { readonly kind: "withdraw"; readonly lamports: bigint }
  | { readonly kind: "withdrawToken"; readonly input: TokenWithdrawRequest };

interface FlowHooks {
  readonly onStep: (step: FlowStep) => void;
  readonly onBuilt: (body: BuiltTransactionJson) => void;
}

/** What the trading wallets card hands the chained write: Privy's methods, and where its own answers go. */
export interface CreateAndLinkRequest {
  readonly createWallet: CreateWalletFn;
  readonly config: SeatConfig;
  readonly refreshUser: RefreshUserFn;
  /** The address Privy named, the moment it named it: the list shows the wallet before anything else can stop. */
  readonly onCreated: (address: string) => void;
  readonly onOutcome: (outcome: CreateAndLinkOutcome) => void;
}

/** One card's or one row's writes, under the screen's lock. `key` names the writer ("vault", "link:<address>", "policy", "withdraw:sol"…). */
export function useVaultWrite(key: string) {
  const screen = useVaultScreen();
  const lock = useContext(WriteLockContext);
  const { wallets } = useWallets();
  const { signTransaction } = useSignTransaction();
  const { signMessage } = useSignMessage();
  const [progress, setProgress] = useState<WriteProgress>({ phase: "idle" });
  const lastRequest = useRef<LastRequest | null>(null);
  /**
   * The connected wallets as they are WHEN A FLOW ASKS, not as they were when the
   * handler was made. A chained create-and-link starts before Privy lists the new
   * wallet, and the signers must see the list that has it.
   */
  const walletsRef = useRef(wallets);
  walletsRef.current = wallets;
  /** The screen's chain state as it is WHEN A FLOW ASKS: a chained create reads it after Privy's dialog, not before. */
  const screenRef = useRef(screen);
  screenRef.current = screen;

  // One input per call, never Privy's variadic form: each input would sign its own bytes.
  const signOne = useCallback<SignTransactionFn<ConnectedWallet>>((input) => signTransaction(input), [signTransaction]);
  const signMessageOne = useCallback<SignMessageFn<ConnectedWallet>>((input) => signMessage(input), [signMessage]);

  const run = useCallback(
    async (kind: WriteKind, flow: (hooks: FlowHooks) => Promise<FlowResult | null>, after?: (result: FlowResult | null) => void): Promise<void> => {
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
        // null: the flow has nothing for the progress to show (a chained create that stopped before
        // its link — no transaction was built, and "Refused" would be the wrong word for a wallet
        // that was in fact created). Its card says what happened in its own words instead.
        const result = await flow(hooks);
        after?.(result);
        if (result === null) {
          setProgress({ phase: "idle" });
          return;
        }
        setProgress({ phase: "finished", kind, result });
        if (result.ok || (result.kind === "refused" && result.code !== undefined && REFRESH_AFTER.has(result.code))) screen.refresh();
      } catch {
        const result: FlowResult = { ok: false, kind: "refused", message: FAILURE_COPY.unknown };
        after?.(result);
        setProgress({ phase: "finished", kind, result });
      } finally {
        lock.release(key);
      }
    },
    [screen, lock, key],
  );

  /**
   * After any write that may have SENT a link: the screen remembers, under the
   * wallet's own key, whether that link is still waiting to be confirmed. Read by
   * the card's chained press and by every row (`awaitingLink`), so a link this
   * screen sent is never offered a second time from somewhere else while the
   * first one may still land. "Check again" clears it by resolving it.
   */
  const rememberLink = useCallback(
    (result: FlowResult | null): void => {
      const last = lastRequest.current;
      if (screen === null || lock === null || last === null || last.kind !== "link") return;
      lock.setUnconfirmedLink(linkKey(screen.pensionKey, last.tradingAddress), awaitsConfirmation(result));
    },
    [screen, lock],
  );

  const createVault = useCallback(
    (input: CreateRequest): Promise<void> => {
      if (screen === null) return Promise.resolve();
      lastRequest.current = { kind: "create", input };
      const { api, pensionKey } = screen;
      return run("create", ({ onStep, onBuilt }) =>
        createVaultFlow(
          { api, onStep, onBuilt, signers: pensionSigner({ wallets, pensionKey, signTransaction: signOne }) },
          { pensionKey, mode: input.mode, maxContribution: input.maxContribution, walletReserve: input.walletReserve, ...(input.skimBps === undefined ? {} : { skimBps: input.skimBps }) },
        ),
      );
    },
    [screen, run, wallets, signOne],
  );

  /**
   * The vault's own rule, signed again. EVERY FIELD TRAVELS because
   * set_policy_v2 writes all six -- the caller sends the vault's current values
   * back beside the one it is changing, so nothing is overwritten by a guess.
   */
  const setPolicy = useCallback(
    (input: VaultRuleRequest): Promise<void> => {
      if (screen === null) return Promise.resolve();
      lastRequest.current = { kind: "rule", input };
      const { api, pensionKey } = screen;
      return run("rule", ({ onStep, onBuilt }) =>
        setPolicyFlow({ api, onStep, onBuilt, signers: pensionSigner({ wallets, pensionKey, signTransaction: signOne }) }, { pensionKey, ...input }),
      );
    },
    [screen, run, wallets, signOne],
  );

  /** One link, from the wallets THIS MOMENT holds and the consent the screen already has. Used alone, and by the chained create. */
  const runLink = useCallback(
    (pensionKey: string, api: VaultApi, tradingAddress: string, hooks: FlowHooks): Promise<LinkWalletResult> => {
      const cacheKey = linkKey(pensionKey, tradingAddress);
      const wallets = walletsRef.current;
      return linkWalletFlow(
        {
          api,
          onStep: hooks.onStep,
          onBuilt: hooks.onBuilt,
          pension: pensionSigner({ wallets, pensionKey, signTransaction: signOne }),
          trading: tradingSigners({ wallets, pensionKey, tradingAddress, signTransaction: signOne, signMessage: signMessageOne }),
        },
        { pensionKey, tradingAddress, consentSignature: lock?.consents.get(cacheKey) ?? null },
      ).then((outcome) => {
        if (outcome.consentSignature === null) lock?.consents.delete(cacheKey);
        else lock?.consents.set(cacheKey, outcome.consentSignature);
        return outcome;
      });
    },
    [lock, signOne, signMessageOne],
  );

  const link = useCallback(
    (tradingAddress: string): Promise<void> => {
      if (screen === null) return Promise.resolve();
      lastRequest.current = { kind: "link", tradingAddress };
      const { api, pensionKey } = screen;
      return run("link", (hooks) => runLink(pensionKey, api, tradingAddress, hooks), rememberLink);
    },
    [screen, run, runLink, rememberLink],
  );

  /**
   * ONE PRESS: create a trading wallet, then link it, under one hold of the lock.
   *
   * WHAT THE PROGRESS SHOWS is the link's own ladder with the create in front of
   * it. A stop between the two is NOT rendered as a refused transaction — the
   * wallet exists, and the card says so in its own words (`onOutcome`), so the
   * flow answers null and the progress goes back to idle rather than reading
   * "Refused" over a wallet that was in fact created.
   *
   * "BUILD AGAIN" AFTER THIS NEVER CREATES A SECOND WALLET: the last request is
   * recorded as a plain link on the address Privy named, the moment it names it.
   */
  /** The chain as the screen holds it at this instant: the read may have landed while Privy's dialog was open. */
  const chainNow = useCallback(() => {
    const view = screenRef.current?.view;
    if (view === undefined || view.kind === "unreadable") return null;
    return view.kind === "ready" ? view.state : "loading";
  }, []);

  const createAndLink = useCallback(
    (request: CreateAndLinkRequest): Promise<void> => {
      if (screen === null) return Promise.resolve();
      lastRequest.current = null;
      const { api, pensionKey } = screen;
      return run("createLink", async (hooks) => {
        const outcome = await createAndLinkFlow({
          createWallet: request.createWallet,
          config: request.config,
          refreshUser: request.refreshUser,
          chain: chainNow,
          signable: () => walletsRef.current.map((wallet) => wallet.address),
          link: (address) => runLink(pensionKey, api, address, hooks),
          onStep: hooks.onStep,
          onCreated: (address) => {
            lastRequest.current = { kind: "link", tradingAddress: address };
            request.onCreated(address);
          },
        });
        request.onOutcome(outcome);
        return outcome.link;
      }, rememberLink);
    },
    [screen, run, runLink, chainNow, rememberLink],
  );

  const investPolicy = useCallback(
    (input: InvestRequest): Promise<void> => {
      if (screen === null) return Promise.resolve();
      lastRequest.current = { kind: "policy", input };
      const { api, pensionKey, view } = screen;
      // The pool rates THIS SCREEN is showing as the button is pressed: the flow
      // refuses a build whose own live rates are far from them. Read here rather
      // than carried in the request, so "Build again" is judged against what is
      // on screen now and not against a reading from minutes ago.
      const shownPrices = view.kind === "ready" ? view.state.prices : null;
      return run("policy", ({ onStep, onBuilt }) =>
        investPolicyFlow(
          { api, onStep, onBuilt, signers: pensionSigner({ wallets, pensionKey, signTransaction: signOne }) },
          {
            pensionKey,
            maxPerCall: input.maxPerCall,
            maxRolling30d: input.maxRolling30d,
            enabled: input.enabled,
            minInvestment: input.minInvestment,
            weights: input.weights,
            venue: input.venue,
            shownPrices,
          },
        ),
      );
    },
    [screen, run, wallets, signOne],
  );

  /** Pause: the policy on screen, signed again with investing off. It reads no prices. */
  const pauseInvesting = useCallback(
    (policy: InvestmentPolicyJson): Promise<void> => {
      if (screen === null) return Promise.resolve();
      lastRequest.current = { kind: "pause", policy };
      const { api, pensionKey } = screen;
      return run("policy", ({ onStep, onBuilt }) =>
        pauseInvestingFlow({ api, onStep, onBuilt, signers: pensionSigner({ wallets, pensionKey, signTransaction: signOne }) }, { pensionKey, policy }),
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
      case "rule":
        return setPolicy(last.input);
      case "policy":
        return investPolicy(last.input);
      case "pause":
        return pauseInvesting(last.policy);
      case "withdraw":
        return withdraw(last.lamports);
      case "withdrawToken":
        return withdrawToken(last.input);
    }
  }, [createVault, setPolicy, link, investPolicy, pauseInvesting, withdraw, withdrawToken]);

  /** "Check again": confirms the signature the send route already took. It never builds or signs. */
  const checkAgain = useCallback((): Promise<void> => {
    if (screen === null || progress.phase !== "finished") return Promise.resolve();
    const { result, kind } = progress;
    if (result.ok || result.kind !== "unconfirmed") return Promise.resolve();
    const { signature, lastValidBlockHeight } = result;
    const { api } = screen;
    return run(kind, ({ onStep }) => checkAgainFlow({ api, onStep }, { signature, lastValidBlockHeight }), rememberLink);
  }, [screen, progress, run, rememberLink]);

  const dismiss = useCallback(() => setProgress({ phase: "idle" }), []);

  const holder = lock?.holder ?? null;
  const unconfirmed = progress.phase === "finished" && awaitsConfirmation(progress.result);
  const unconfirmedLinks = lock?.unconfirmedLinks ?? NO_LINKS;
  const pensionKey = screen?.pensionKey ?? null;
  return {
    progress,
    /** This writer's write is in progress. */
    running: holder === key,
    /** Another writer on the screen holds the lock. */
    busyElsewhere: holder !== null && holder !== key,
    /** A sent transaction awaits confirmation: nothing new is offered until it is checked. */
    unconfirmed,
    /** This wallet's link was sent from somewhere on this screen and is not confirmed: no second link for it may be offered. */
    awaitingLink: (address: string): boolean => pensionKey !== null && unconfirmedLinks.has(linkKey(pensionKey, address)),
    /** Some link on this screen was sent and is not confirmed, so a chained press would race it. */
    awaitingAnyLink: unconfirmedLinks.size > 0,
    createVault,
    setPolicy,
    createAndLink,
    link,
    investPolicy,
    pauseInvesting,
    withdraw,
    withdrawToken,
    buildAgain,
    checkAgain,
    dismiss,
  } as const;
}
