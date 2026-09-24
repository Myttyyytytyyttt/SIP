/**
 * THE NEW-USER SETUP'S DECISIONS, pure: whether it is wanted, what its vault
 * step may offer, and when a create has landed. The frame and the host ask these
 * functions; onboarding.test.ts pins every branch.
 *
 * TWO READS OF ONE ACCOUNT. The page reads a connected key's vault twice: the
 * shared vault screen (wallets-host.tsx, one read, again after every write) and
 * the live store (only while the page is Live). The setup opens only while
 * NEITHER says a vault exists, and it never offers Create on a read that failed
 * or has not answered — a vault that may exist is never offered for creation.
 */

import { DEFAULT_VAULT_POLICY, OFFERED_LEGS } from "@sip/solana-core/client";

import type { WriteProgress } from "@/hooks/use-vault-actions";
import { evenPercents } from "@/lib/basket-picker";
import type { BasketChoice } from "@/lib/onboarding-memory";
import type { VaultScreenValue, VaultView } from "@/hooks/use-vault-state";
import type { DashboardKind, VaultPresence } from "@/lib/dashboard-mode";
import type { LiveStage } from "@/lib/live-types";

/** What the shared vault screen says about THIS key's vault. */
export function vaultPresenceOf(screen: VaultScreenValue | null, pensionKey: string | null): VaultPresence {
  if (screen === null || pensionKey === null || screen.pensionKey !== pensionKey) return "reading";
  const { view } = screen;
  if (view.kind === "loading") return "reading";
  if (view.kind === "unreadable") return "unreadable";
  // The view is not reset when the key changes (use-vault-state.ts), so an
  // answer about another key is no answer about this one.
  if (view.state.owner !== pensionKey) return "reading";
  return view.state.vault.status;
}

/** Live stages that can only come from a vault that exists. */
const HAS_VAULT: ReadonlySet<LiveStage> = new Set<LiveStage>(["no_trading_wallet", "not_linked", "waiting_first_settlement", "active"]);

export interface OnboardingWantedInput {
  readonly kind: DashboardKind;
  readonly closed: boolean;
  readonly vault: VaultPresence;
  /** The live store's stage, or null while it has not answered. */
  readonly liveStage: LiveStage | null;
  /**
   * The setup has been on screen for this key, or was asked for. Once it has,
   * a read that fails or is in flight keeps it up — showing its own skeleton or
   * Retry — instead of pulling it away from under the person.
   */
  readonly engaged: boolean;
}

/** Whether the frame wants the setup on screen. */
export function onboardingWanted(input: OnboardingWantedInput): boolean {
  const { kind, closed, vault, liveStage, engaged } = input;
  if (kind !== "live" || closed) return false;
  if (liveStage !== null && HAS_VAULT.has(liveStage)) return false;
  if (vault === "missing") return true;
  if (vault === "exists") return false;
  return engaged;
}

/**
 * Whether the page's ways into the vault ("Manage wallets", the no-vault card's
 * Create vault) should open the setup instead of the wallets modal: this key
 * has no vault — the vault read says so, or it is in flight or failed and the
 * live read says so.
 * Then there is one way to make a vault on the page, and it is the setup. A read
 * that failed with nothing else to go on keeps the wallets modal, which has its
 * own honest states: the setup is never offered to a key that may have a vault.
 */
export function setupIsTheDoor(vault: VaultPresence, liveStage: LiveStage | null): boolean {
  if (liveStage !== null && HAS_VAULT.has(liveStage)) return false;
  if (vault === "missing") return true;
  // The vault read is in flight or failed, and the live read has already said there is none.
  return (vault === "reading" || vault === "unreadable") && liveStage === "no_vault";
}

/** How a create through the setup has ended, as the host remembers it. */
export type OnboardingCreated = "celebrating" | "done" | null;

/** A celebration stays up whatever the reads say; a finished setup never reopens. */
export const onboardingOpen = (wanted: boolean, created: OnboardingCreated): boolean => created === "celebrating" || (created === null && wanted);

/** The write's progress says a vault was just created. */
export const landedCreate = (progress: WriteProgress): boolean => progress.phase === "finished" && progress.kind === "create" && progress.result.ok;

/** What the vault step may show: a skeleton, Retry, or the form. */
export type VaultStepRead = "reading" | "unreadable" | "form";

export function vaultStepRead(view: VaultView, pensionKey: string): VaultStepRead {
  if (view.kind === "loading") return "reading";
  if (view.kind === "unreadable") return "unreadable";
  // An answer about another key is no answer about this one: never a form on it.
  if (view.state.owner !== pensionKey) return "reading";
  if (view.state.vault.status === "unreadable") return "unreadable";
  // A vault that exists never gets the form, even for the moment before the setup closes.
  return view.state.vault.status === "missing" ? "form" : "reading";
}

export type OnboardingBodyStep = "welcome" | "vault" | "ready";

/**
 * THE RATE THE SETUP OFFERS, in basis points (owner, 09-24): a bar from 5 % to
 * 50 % in whole percents, and four presets under it. The program takes any
 * profit rate from 2.01 % to 100 % (PROFIT_BPS_MIN..MAX); this is the part of
 * that a first vault is offered, and the dashboard's rule card can move it
 * anywhere in the program's range later. It starts at the product's 20 %.
 */
export const SETUP_RATE = {
  min: 500,
  max: 5_000,
  step: 100,
  presets: [1_000, 1_500, 2_000, 3_000],
  initial: DEFAULT_VAULT_POLICY.skimBps,
} as const;

/** A rate from the bar, held to the setup's range and its whole-percent steps. */
export function setupRate(bps: number): number {
  if (!Number.isFinite(bps)) return SETUP_RATE.initial;
  const stepped = Math.round(bps / SETUP_RATE.step) * SETUP_RATE.step;
  return Math.min(SETUP_RATE.max, Math.max(SETUP_RATE.min, stepped));
}

// ── what the savings become ──────────────────────────────────────────────────

/**
 * THE STOCKS THE SETUP OFFERS: the shelf exactly as the catalogue admits it
 * today (OFFERED_LEGS — SPYx and ANTHROPIC on 09-24), never a hand-written
 * list, so the setup cannot offer a stock the build route would refuse.
 */
export const SETUP_STOCKS: readonly { readonly mint: string; readonly symbol: string; readonly name: string }[] = OFFERED_LEGS.map((leg) => ({
  mint: leg.mint,
  symbol: leg.symbol,
  name: leg.name,
}));

export const SOL_CHOICE: BasketChoice = { kind: "sol" };

/**
 * A press on one tile. SOL IS ONE OR THE OTHER WITH STOCKS, because that is
 * what the chain can do today: once a vault has an investing policy the keeper
 * converts all of its SOL, so "some SOL, some stocks" cannot be honoured.
 * Pressing SOL keeps SOL; pressing a stock adds or removes it; removing the
 * last stock goes back to SOL. The stocks keep the shelf's order.
 */
export function toggleBasket(choice: BasketChoice, target: "sol" | string): BasketChoice {
  if (target === "sol") return SOL_CHOICE;
  if (!SETUP_STOCKS.some((stock) => stock.mint === target)) return choice;
  const current = choice.kind === "stocks" ? choice.mints : [];
  const next = current.includes(target) ? current.filter((mint) => mint !== target) : [...current, target];
  const ordered = SETUP_STOCKS.map((stock) => stock.mint).filter((mint) => next.includes(mint));
  return ordered.length === 0 ? SOL_CHOICE : { kind: "stocks", mints: ordered };
}

/** A stored choice held to today's shelf: a stock no longer offered is dropped, and nothing left is SOL. */
export function basketOnShelf(choice: BasketChoice | null): BasketChoice {
  if (choice === null || choice.kind === "sol") return SOL_CHOICE;
  const mints = SETUP_STOCKS.map((stock) => stock.mint).filter((mint) => choice.mints.includes(mint));
  return mints.length === 0 ? SOL_CHOICE : { kind: "stocks", mints };
}

/** The chosen stocks at their equal whole-percent shares (evenPercents, the settings form's own split). */
export function basketSplit(choice: BasketChoice): readonly { readonly mint: string; readonly symbol: string; readonly percent: number }[] {
  if (choice.kind === "sol") return [];
  const stocks = SETUP_STOCKS.filter((stock) => choice.mints.includes(stock.mint));
  if (stocks.length === 0) return [];
  const percents = evenPercents(stocks.length);
  return stocks.map((stock, index) => ({ mint: stock.mint, symbol: stock.symbol, percent: percents[index]! }));
}
