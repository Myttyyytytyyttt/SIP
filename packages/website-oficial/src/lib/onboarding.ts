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

import type { WriteProgress } from "@/hooks/use-vault-actions";
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
