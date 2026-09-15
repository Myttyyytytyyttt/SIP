/**
 * TRADING WALLETS: the Privy embedded Solana wallets a pension key trades from,
 * and the keeper's seat on each.
 *
 * Client-safe and pure, like pension-key.ts: it reads Privy's `User` and takes
 * Privy's methods as arguments, importing nothing from Privy at runtime. Every
 * rule below is testable without a browser; the components that call these are
 * wiring.
 *
 * THE SEAT is the solana-keeper's Privy signer (SIP_SOLANA_PRIVY_SIGNER_ID) on the
 * wallet, bounded by the keeper's policy (SIP_SOLANA_PRIVY_POLICY_ID) as that
 * signer's OVERRIDE policy. With it the keeper can push settle_v2 from the wallet
 * and nothing the policy does not allow. Three rules, each from the failure it
 * prevents:
 *
 * - NEVER A SIGNER WITHOUT ITS POLICY. Privy reads a missing or empty policyIds as
 *   "no policy applies", which is full permission, and the keeper indexes signer
 *   ids only, so an unbounded seat would go unnoticed. keeperSigners() returns null
 *   instead of a signer with no policy, and nothing is created.
 * - THE POLICY GOES ON THE SIGNER, NEVER ON THE WALLET. A wallet-level policy binds
 *   the owner as well, and its DENY exportPrivateKey would stop the user exporting
 *   the key to Axiom. Privy maps a signer's policyIds to override_policy_ids, and
 *   its React create takes no wallet policy at all.
 * - BORN SEATED. The signer goes into createWallet itself, so the wallet never
 *   exists without it and no create-then-grant gap can strand one. Privy attaches
 *   signers at creation only in TEE execution, which this Privy app runs.
 */

import type { User } from "@privy-io/react-auth";

import { EMBEDDED_CLIENT_TYPES } from "@/lib/pension-key";
import { privyFailure } from "@/lib/privy-failure";

export const SIGNER_VARIABLE = "SIP_SOLANA_PRIVY_SIGNER_ID";
export const POLICY_VARIABLE = "SIP_SOLANA_PRIVY_POLICY_ID";

/**
 * The most trading wallets this page creates for one account. Privy documents no
 * per-user cap, and its Solana create sends no idempotency key, so a runaway
 * (a stuck button, a script) would otherwise have no floor under it.
 */
export const MAX_TRADING_WALLETS = 10;

/** The part of the public configuration the seat is made from. */
export interface SeatConfig {
  readonly privySignerId: string | null;
  readonly privyPolicyId: string | null;
}

/** One signer, in the shape Privy's createWallet and addSigners take. Mutable arrays because Privy's types ask for them. */
export interface KeeperSigner {
  signerId: string;
  policyIds: string[];
}

/** Thrown before Privy is called when the seat is not configured. Its message names the variables. */
export class SeatNotConfigured extends Error {
  override readonly name = "SeatNotConfigured";
}

function trimmedId(value: string | null): string | null {
  const id = value?.trim() ?? "";
  return id === "" ? null : id;
}

/**
 * The signers to hand Privy: exactly the keeper's signer, with exactly its one
 * policy. Null when either id is missing or the two are the same id — never a
 * signer with an empty or absent policy list. A fresh array on every call.
 */
export function keeperSigners(config: SeatConfig): KeeperSigner[] | null {
  const signerId = trimmedId(config.privySignerId);
  const policyId = trimmedId(config.privyPolicyId);
  if (signerId === null || policyId === null || signerId === policyId) return null;
  return [{ signerId, policyIds: [policyId] }];
}

/** Why keeperSigners() is null, naming the variables to fix; null when the seat is configured. */
export function seatProblem(config: SeatConfig): string | null {
  const signerId = trimmedId(config.privySignerId);
  const policyId = trimmedId(config.privyPolicyId);
  const consequence = "Nothing is created or seated until it is fixed.";
  if (signerId === null && policyId === null) {
    return (
      `The keeper's seat is not configured: ${SIGNER_VARIABLE} and ${POLICY_VARIABLE} are unset on this deployment, ` +
      `and a trading wallet without the seat cannot put anything aside. ${consequence}`
    );
  }
  if (signerId === null) return `${SIGNER_VARIABLE} is unset on this deployment, so there is no keeper signer to seat. ${consequence}`;
  if (policyId === null) {
    return `${POLICY_VARIABLE} is unset on this deployment, and a signer without its policy would have full permission. ${consequence}`;
  }
  if (signerId === policyId) {
    return `${SIGNER_VARIABLE} and ${POLICY_VARIABLE} hold the same id, and no id is both a signer and a policy. ${consequence}`;
  }
  return null;
}

/** A trading wallet as Privy's record of the user lists it. */
export interface TradingWallet {
  readonly address: string;
  /** Privy's wallet id — what `privy-policy verify --wallet` takes. Privy leaves it null until the wallet has a signer. */
  readonly id: string | null;
  /** The HD index Privy derived it at; null for an imported wallet. */
  readonly walletIndex: number | null;
  readonly imported: boolean;
}

/**
 * Every Privy embedded Solana wallet on the user, in HD order (imported ones
 * last), one entry per address. The pension key is never among them: it is an
 * external wallet, and Privy's walletClientType says so.
 */
export function tradingWalletsOf(user: User | null): TradingWallet[] {
  const byAddress = new Map<string, TradingWallet>();
  for (const account of user?.linkedAccounts ?? []) {
    if (account.type !== "wallet" || account.chainType !== "solana") continue;
    if (!EMBEDDED_CLIENT_TYPES.has(account.walletClientType ?? "")) continue;
    if (typeof account.address !== "string" || account.address === "" || byAddress.has(account.address)) continue;
    byAddress.set(account.address, {
      address: account.address,
      id: typeof account.id === "string" && account.id !== "" ? account.id : null,
      walletIndex: typeof account.walletIndex === "number" ? account.walletIndex : null,
      imported: account.imported === true,
    });
  }
  return [...byAddress.values()].sort(
    (a, b) =>
      (a.walletIndex ?? Number.MAX_SAFE_INTEGER) - (b.walletIndex ?? Number.MAX_SAFE_INTEGER) ||
      (a.address < b.address ? -1 : a.address > b.address ? 1 : 0),
  );
}

/** Privy's createWallet from @privy-io/react-auth/solana, narrowed to the one call this page makes. */
export type CreateWalletFn = (options: {
  createAdditional: boolean;
  signers: KeeperSigner[];
}) => Promise<{ wallet?: { address?: string } | undefined } | undefined>;

/**
 * Create a trading wallet born with the keeper's seat.
 *
 * REFUSES FIRST. With no seat configured it throws SeatNotConfigured before Privy
 * is called, so no wallet is minted for nothing.
 *
 * createAdditional: true, EVERY TIME. Without it Privy throws "User already has an
 * embedded wallet" once one exists; with it Privy derives the next HD index, which
 * is 0 for a first wallet. (Passing walletIndex instead throws in TEE mode.)
 *
 * Returns the address Privy reports, or null. Privy finds the new wallet by the
 * index it computed, so the caller reads the user record again rather than
 * trusting this alone.
 */
export async function createTradingWallet(createWallet: CreateWalletFn, config: SeatConfig): Promise<string | null> {
  const signers = keeperSigners(config);
  if (signers === null) throw new SeatNotConfigured(seatProblem(config) ?? "The keeper's seat is not configured.");
  const created = await createWallet({ createAdditional: true, signers });
  const address = created?.wallet?.address;
  return typeof address === "string" && address !== "" ? address : null;
}

/**
 * The keeper's seat on one wallet, as Privy's record of the user states it — read
 * on every call, never cached, never inferred from having asked for it:
 *
 * - "seated": listed as a trading wallet with delegated: true. Privy documents that
 *   a wallet with signers always has the flag set. The record does not say which
 *   signer or which policy — Privy's browser SDK exposes neither — so the binding
 *   itself is confirmed in the Privy dashboard, or by `privy-policy verify`.
 * - "missing": listed with delegated: false. Nothing can sign for it.
 * - "unknown": not listed as a trading wallet (one created a moment ago, or an
 *   address that is not one, like the pension key), or listed without the flag.
 */
export type SeatStatus = "seated" | "missing" | "unknown";

export function seatOf(user: User | null, address: string): SeatStatus {
  for (const account of user?.linkedAccounts ?? []) {
    if (account.type !== "wallet" || account.chainType !== "solana" || account.address !== address) continue;
    if (!EMBEDDED_CLIENT_TYPES.has(account.walletClientType ?? "")) continue;
    const delegated: unknown = account.delegated;
    return delegated === true ? "seated" : delegated === false ? "missing" : "unknown";
  }
  return "unknown";
}

/** Privy's addSigners (root @privy-io/react-auth: it has no Solana variant), narrowed to the call this page makes. */
export type AddSignersFn = (input: { address: string; signers: KeeperSigner[] }) => Promise<unknown>;

/** Privy's refreshUser: fetches the user record again and returns it. */
export type RefreshUserFn = () => Promise<User | null>;

/** The waits between grant attempts while Privy records a new wallet: the EVM web's 1, 2, 4, 6, 8 and 10 seconds. */
export const GRANT_BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000, 6_000, 8_000, 10_000];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The repair: grant the keeper its seat on a trading wallet whose record shows none.
 *
 * REFUSES FIRST, like createTradingWallet: never a signer without its policy.
 *
 * RE-READS BEFORE IT ADDS. Privy's addSigners appends to the wallet's existing
 * signers, so a grant on a wallet that turns out to be seated would seat the keeper
 * twice. The record is fetched again first, and if it now shows the seat nothing
 * is added. A re-read that fails grants nothing.
 *
 * ONLY THE PROPAGATION RACE IS RETRIED. A wallet created moments ago may not have
 * reached Privy's record, and Privy says "not associated with current user" until
 * it has; that is waited out on GRANT_BACKOFF_MS. Any other refusal is an answer,
 * and asking again does not change it.
 *
 * Only the wallet's owner, signed in here, can add a signer: the keeper can never
 * repair its own seat.
 */
export async function grantKeeperSeat({
  address,
  config,
  addSigners,
  refreshUser,
  wait = sleep,
}: {
  address: string;
  config: SeatConfig;
  addSigners: AddSignersFn;
  refreshUser: RefreshUserFn;
  wait?: (ms: number) => Promise<void>;
}): Promise<"granted" | "already-seated"> {
  const signers = keeperSigners(config);
  if (signers === null) throw new SeatNotConfigured(seatProblem(config) ?? "The keeper's seat is not configured.");

  if (seatOf(await refreshUser(), address) === "seated") return "already-seated";

  for (let attempt = 0; ; attempt += 1) {
    try {
      await addSigners({ address, signers });
      break;
    } catch (error) {
      const delay = GRANT_BACKOFF_MS[attempt];
      if (delay === undefined || privyFailure(error).kind !== "propagating") throw error;
      await wait(delay);
    }
  }

  // The badge reads Privy's record, so the record is read again. The grant itself has already succeeded.
  await refreshUser().catch(() => null);
  return "granted";
}

/** Privy's exportWallet from @privy-io/react-auth/solana. */
export type ExportWalletFn = (options: { address: string }) => Promise<void>;

/** Thrown before Privy is called when an address is not a trading wallet on this account. */
export class NotATradingWallet extends Error {
  override readonly name = "NotATradingWallet";
}

/**
 * Open Privy's export dialog for one trading wallet.
 *
 * ONLY A TRADING WALLET. The address must be a Privy embedded Solana wallet on this
 * user, so the pension key — an external wallet — can never be passed through.
 *
 * THE ADDRESS IS ALWAYS PASSED. Without one Privy exports the wallet at HD index 0,
 * which is the wrong one as soon as there are two.
 */
export async function exportTradingWallet({
  exportWallet,
  user,
  address,
}: {
  exportWallet: ExportWalletFn;
  user: User | null;
  address: string;
}): Promise<void> {
  if (!tradingWalletsOf(user).some((wallet) => wallet.address === address)) {
    throw new NotATradingWallet(
      "Only a trading wallet Privy holds on this account can be exported. The pension key stays in your own wallet app.",
    );
  }
  await exportWallet({ address });
}

/**
 * A failure from any of the above, for the page: this module's own refusals as they
 * are written, Privy's in words (privy-failure.ts), and null when the person only
 * closed Privy's dialog.
 */
export function failureText(error: unknown): string | null {
  if (error instanceof SeatNotConfigured || error instanceof NotATradingWallet) return error.message;
  const described = privyFailure(error);
  return described.kind === "exited" ? null : described.message;
}
