/**
 * CREATING A TRADING WALLET AND LINKING IT, as one pure flow.
 *
 * The owner's ask: one press. Privy mints the wallet, then the same press runs
 * the link (src/lib/vault-flows.ts's linkWalletFlow). Nothing about either
 * transaction changes here — this module only decides what happens BETWEEN them,
 * and what is said when the chain stops.
 *
 * THE CREATE COMES FIRST AND IS NEVER UNDONE. Once Privy answers, a real wallet
 * exists on the account, seated, whatever happens next. So every stop below
 * carries the address and says the wallet is there; a stop is never phrased as
 * "nothing happened", and the caller shows the wallet in the list with its own
 * Link to vault (src/components/wallets/LinkControl.tsx).
 *
 * NO VAULT IS EVER CREATED TO UNBLOCK THE CHAIN. Linking needs a vault, and a
 * vault costs rent that never comes back and carries a mode and limits the owner
 * chooses. With none, the flow stops after the create and says so.
 *
 * THE SEAT IS NOT WAITED FOR. A wallet is born seated (the keeper's signer with
 * its policy goes into createWallet itself), and Privy's record can read "unknown"
 * for seconds afterwards while the seat is perfectly real. Linking does not need
 * the seat, so nothing here reads it: the row's badge does, and says only what
 * Privy's record can prove.
 *
 * WHAT IS WAITED FOR is the one thing the link cannot do without: this session
 * being able to sign for the new wallet. Privy's useWallets lists it a moment
 * after the create, and the wait is bounded (READY_BACKOFF_MS); past that the
 * wallet is kept and the link is left to its row.
 *
 * Client-safe and pure, like vault-flows.ts: Privy's methods, the chain and the
 * link all arrive as arguments, so every state below is testable without a browser.
 */

import { rawFrom } from "@/lib/amounts";
import { createTradingWallet, failureText, keeperSigners, seatProblem, type CreateWalletFn, type RefreshUserFn, type SeatConfig } from "@/lib/trading-wallets";
import type { VaultStateJson } from "@/lib/vault-api";
import { CREATE_LINK_COPY, LINK_COPY, VAULT_COPY } from "@/lib/vault-copy";
import type { FlowStep, LinkWalletResult } from "@/lib/vault-flows";

/** Why the chain cannot take a link right now. */
export type LinkGateCode = "needs_vault" | "vault_unreadable" | "needs_config" | "config_unreadable" | "paused";

export interface LinkGate {
  readonly code: LinkGateCode;
  readonly message: string;
}

/**
 * What the chain says about linking anything to this pension key's vault, in the
 * words the row already uses; null when it can be linked. One place, so the card's
 * chained flow and each row's own button never disagree.
 */
export function linkGate(state: VaultStateJson): LinkGate | null {
  if (state.vault.status === "missing") return { code: "needs_vault", message: LINK_COPY.needsVault };
  if (state.vault.status === "unreadable") return { code: "vault_unreadable", message: VAULT_COPY.unreadable };
  if (state.config.status === "missing") return { code: "needs_config", message: LINK_COPY.needsConfig };
  if (state.config.status === "unreadable") return { code: "config_unreadable", message: LINK_COPY.unreadable };
  if (state.config.paused === true) return { code: "paused", message: LINK_COPY.paused };
  return null;
}

/** The screen's view of the chain, as much of it as one press needs (src/hooks/use-vault-state.ts's VaultView). */
export type LinkChainView =
  | { readonly kind: "loading" }
  | { readonly kind: "unreadable"; readonly message: string }
  | { readonly kind: "ready"; readonly state: VaultStateJson };

/** What one press will do, and so what may be said before it is pressed. */
export type PressPlan =
  /** It will create the wallet and link it. `linkRent` is null when the rent has not been read: no amount may be invented. */
  | { readonly links: true; readonly linkRent: bigint | null }
  /** It will only create the wallet, for this reason, in the chain's own words. */
  | { readonly links: false; readonly reason: string };

/**
 * WHAT ONE PRESS WILL DO, from the screen's view of the chain.
 *
 * THREE CASES, NEVER TWO. A read still in flight is not a read that FAILED. While
 * it loads, the press may still link — the flow reads the chain again after the
 * create, and by then it usually has it — so the whole promise stands. A failed
 * read cannot take a link: the flow would stop at `chain_unknown` after minting a
 * wallet nobody asked for on its own, so the press promises the create alone,
 * with the read's own words. Folding the two into one "the chain says nothing
 * against it" announced Phantom and rent that never came.
 *
 * AN AMOUNT THAT WAS NOT READ IS NEVER WRITTEN. `linkRent` is the chain's, or null.
 */
export function pressPlan(view: LinkChainView | null): PressPlan {
  if (view === null || view.kind === "loading") return { links: true, linkRent: null };
  if (view.kind === "unreadable") return { links: false, reason: view.message };
  const gate = linkGate(view.state);
  return gate === null ? { links: true, linkRent: rawFrom(view.state.rents?.link) } : { links: false, reason: gate.message };
}

/** Where a chained press stopped before the link ran. */
export type CreateAndLinkStopKind =
  /** Refused before Privy was called: the keeper's seat is not configured. Nothing was created. */
  | "seat"
  /** Privy refused, or its dialog was closed. Nothing was created. */
  | "create"
  /** Privy created a wallet and did not name it. */
  | "no_address"
  /** Created; the chain cannot take a link (no vault, no config, paused…). */
  | "gate"
  /** Created; the screen's read of Solana is not usable, so nothing was attempted. */
  | "chain_unknown"
  /** Created; this session cannot sign for it yet. */
  | "not_ready";

export interface CreateAndLinkStop {
  readonly kind: CreateAndLinkStopKind;
  /** Words for the person; null ONLY when Privy's dialog was closed, which is a choice and not a failure, and nothing is shown. */
  readonly message: string | null;
  /** The chain's own reason, when `kind` is "gate". */
  readonly gate: LinkGateCode | null;
}

export interface CreateAndLinkOutcome {
  /** The address Privy named, or null when nothing was created. A wallet may exist anyway: see `stop`. */
  readonly created: string | null;
  /** The link's own result, when the link ran; null when the chain stopped first. */
  readonly link: LinkWalletResult | null;
  /** Why it stopped before the link; null when the link ran. */
  readonly stop: CreateAndLinkStop | null;
}

export interface CreateAndLinkDeps {
  readonly createWallet: CreateWalletFn;
  readonly config: SeatConfig;
  readonly refreshUser: RefreshUserFn;
  /** The chain as the screen holds it, read after the create: "loading" while it is not known, null when the read failed. */
  readonly chain: () => VaultStateJson | "loading" | null;
  /** The addresses this session can sign for right now. Read again on every attempt: Privy lists a new wallet a moment late. */
  readonly signable: () => readonly string[];
  /** Runs the link transaction for the created address. */
  readonly link: (address: string) => Promise<LinkWalletResult>;
  readonly onStep?: (step: FlowStep) => void;
  /** Called the moment Privy names the wallet — before anything else can stop — so the list shows it at once. */
  readonly onCreated?: (address: string) => void;
  readonly wait?: (ms: number) => Promise<void>;
  readonly readyBackoffMs?: readonly number[];
}

/** The waits between readings of Privy's connected wallets while it lists a wallet just created. */
export const READY_BACKOFF_MS: readonly number[] = [250, 500, 1_000, 2_000, 3_000];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const stopped = (kind: CreateAndLinkStopKind, message: string | null, created: string | null, gate: LinkGateCode | null = null): CreateAndLinkOutcome => ({
  created,
  link: null,
  stop: { kind, message, gate },
});

/** Waits, bounded, for this session to be able to sign for `address`. */
async function signableSoon(deps: CreateAndLinkDeps, address: string): Promise<boolean> {
  const backoff = deps.readyBackoffMs ?? READY_BACKOFF_MS;
  const wait = deps.wait ?? sleep;
  if (deps.signable().includes(address)) return true;
  for (const delay of backoff) {
    await wait(delay);
    if (deps.signable().includes(address)) return true;
  }
  return false;
}

/** Create a trading wallet, then link it to the pension key's vault, in one press. */
export async function createAndLinkFlow(deps: CreateAndLinkDeps): Promise<CreateAndLinkOutcome> {
  // Refuses before Privy, exactly as a plain create does: no wallet is minted for a seat that cannot be given.
  if (keeperSigners(deps.config) === null) {
    return stopped("seat", seatProblem(deps.config) ?? "The keeper's seat is not configured.", null);
  }

  deps.onStep?.("creating_wallet");
  let address: string | null;
  try {
    address = await createTradingWallet(deps.createWallet, deps.config);
  } catch (error) {
    // A wallet can exist even after a throw, so the record is read again either way; failureText is null for a closed dialog.
    await deps.refreshUser().catch(() => null);
    return stopped("create", failureText(error), null);
  }
  await deps.refreshUser().catch(() => null);
  if (address === null) return stopped("no_address", CREATE_LINK_COPY.noAddress, null);
  deps.onCreated?.(address);

  const chain = deps.chain();
  if (chain === "loading" || chain === null) return stopped("chain_unknown", CREATE_LINK_COPY.chainUnknown, address);
  const gate = linkGate(chain);
  if (gate !== null) return stopped("gate", gate.message, address, gate.code);

  if (!(await signableSoon(deps, address))) return stopped("not_ready", CREATE_LINK_COPY.notReady, address);

  return { created: address, link: await deps.link(address), stop: null };
}
