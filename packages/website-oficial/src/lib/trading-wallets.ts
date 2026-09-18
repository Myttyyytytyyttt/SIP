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
 *
 * A seat names the keeper's signer BY ITS ID. When the keeper's authorization key
 * is replaced (lost, exposed, rotated), the signer id changes, and every wallet
 * seated before still carries the old one — which Privy's record shows exactly
 * like a live seat. reseatKeeperSeat is the way back: the owner removes every
 * signer on the wallet, then the grant seats the current one.
 */

import type { User, WalletWithMetadata } from "@privy-io/react-auth";

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
 * What Privy's record of the user says about the signers on one wallet — read on
 * every call, never cached, never inferred from having asked for one:
 *
 * - "has-signer": listed as a trading wallet with delegated: true. Privy sets the
 *   flag for a wallet with ANY signer, and for a legacy on-device delegation too, so
 *   it proves that a signer exists — not that it is the keeper's, nor that it carries
 *   the keeper's policy, nor that it is the keeper's CURRENT signer rather than one
 *   from before a key rotation. Privy's browser SDK lists neither, and this web
 *   holds no app secret to ask Privy's API (load-config.ts refuses one by name). So
 *   there is no "seated" here: nothing this page can read proves it.
 *   `privy-policy verify --wallet <id> --policy <id>` reads the wallet's
 *   additional_signers, and stops with SIGNER_NOT_GRANTED or
 *   OVERRIDE_POLICY_MISMATCH unless the keeper's signer is there with exactly its policy.
 * - "missing": listed with delegated: false. Privy records no signer at all, so the
 *   keeper's seat is certainly missing and nothing can sign for the wallet.
 * - "unknown": not listed as a trading wallet (one created a moment ago, or an
 *   address that is not one, like the pension key), or listed without the flag.
 */
export type SeatStatus = "has-signer" | "missing" | "unknown";

export function seatOf(user: User | null, address: string): SeatStatus {
  const account = embeddedSolanaAccount(user, address);
  if (account === null) return "unknown";
  const delegated: unknown = account.delegated;
  return delegated === true ? "has-signer" : delegated === false ? "missing" : "unknown";
}

/** The Privy embedded Solana wallet on this record at this address, or null. */
function embeddedSolanaAccount(user: User | null, address: string): WalletWithMetadata | null {
  for (const account of user?.linkedAccounts ?? []) {
    if (account.type !== "wallet" || account.chainType !== "solana" || account.address !== address) continue;
    if (!EMBEDDED_CLIENT_TYPES.has(account.walletClientType ?? "")) continue;
    return account;
  }
  return null;
}

/** Privy's addSigners (root @privy-io/react-auth: it has no Solana variant), narrowed to the call this page makes. */
export type AddSignersFn = (input: { address: string; signers: KeeperSigner[] }) => Promise<unknown>;

/** Privy's refreshUser: fetches the user record again and returns it. */
export type RefreshUserFn = () => Promise<User | null>;

/** The waits between grant attempts while Privy records a new wallet: the EVM web's 1, 2, 4, 6, 8 and 10 seconds. */
export const GRANT_BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000, 6_000, 8_000, 10_000];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The repair: grant the keeper its seat on a trading wallet whose record shows no signer.
 *
 * REFUSES FIRST, like createTradingWallet: never a signer without its policy.
 *
 * RE-READS BEFORE IT ADDS, AND ADDS NOTHING TO A WALLET WITH A SIGNER. Privy's
 * addSigners appends to the wallet's existing signers, so a grant on a wallet that
 * already carries the keeper would seat it twice; on a legacy on-device delegation it
 * returns without adding anything. The record is fetched again first, and if it now
 * shows any signer nothing is added. A re-read that fails grants nothing.
 *
 * ONLY THE PROPAGATION RACE IS RETRIED. A wallet created moments ago may not have
 * reached Privy's record, and Privy says "not associated with current user" until
 * it has; that is waited out on GRANT_BACKOFF_MS. Any other refusal is an answer,
 * and asking again does not change it.
 *
 * Only the wallet's owner, signed in here, can add a signer: the keeper can never
 * repair its own seat.
 *
 * A WRONG SIGNER IS NOT REPAIRED HERE. A wallet whose signer is another key quorum,
 * the keeper's without its policy, or the keeper's from before a key rotation reads
 * "has-signer" exactly like the keeper's seat, so this adds nothing to it. That is
 * reseatKeeperSeat's: Privy's removeSigners, which removes every signer on the
 * wallet, then this grant.
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
}): Promise<"granted" | "has-signer"> {
  const signers = keeperSigners(config);
  if (signers === null) throw new SeatNotConfigured(seatProblem(config) ?? "The keeper's seat is not configured.");

  if (seatOf(await refreshUser(), address) === "has-signer") return "has-signer";

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

/** Privy's removeSigners (root @privy-io/react-auth, like addSigners), narrowed. It names no signer: it removes EVERY one. */
export type RemoveSignersFn = (input: { address: string }) => Promise<unknown>;

/** Thrown before Privy is asked to remove anything. Its message says why, and that nothing was removed. */
export class ReseatRefused extends Error {
  override readonly name = "ReseatRefused";
}

/**
 * Where a re-seat stopped once Privy had been asked to remove the signers:
 *
 * - "removal-unconfirmed": removeSigners failed, and Privy's record does not show
 *   the wallet without signers. Nothing was added.
 * - "record-still-lists-a-signer": Privy accepted the removal, but its record
 *   still lists a signer after every wait. Nothing was added.
 * - "removed-not-added": THE PARTIAL STATE. The record shows no signer and the
 *   grant failed. Only the owner can sign for the wallet, and nothing is put
 *   aside from it until the seat is back — which the row's own Grant does,
 *   because the record now reads "missing".
 * - "signer-reappeared": the record showed no signer, then one this page did not add.
 *
 * None of them is ever "done", and each message says what to press next.
 */
export type ReseatStage = "removal-unconfirmed" | "record-still-lists-a-signer" | "removed-not-added" | "signer-reappeared";

export class ReseatIncomplete extends Error {
  override readonly name = "ReseatIncomplete";
  readonly stage: ReseatStage;

  constructor(stage: ReseatStage, message: string) {
    super(message);
    this.stage = stage;
  }
}

/** The re-seat's words. The web is in English; the button names match the row's labels exactly. */
export const RESEAT_COPY = {
  button: "Re-seat keeper",
  running: "Re-seating…",
  confirmTitle: "Remove every signer on this wallet, then seat the keeper again?",
  confirmBody:
    "This removes EVERY signer on this wallet — the keeper's, if it is there, and any other — and then adds the " +
    "keeper's signer with its policy. Between the two steps only you can sign for this wallet, and nothing is put " +
    "aside from it. If the second step fails, the wallet says No seat, and Grant keeper permission puts the seat back.",
  confirm: "Remove every signer and re-seat",
  cancel: "Cancel",
  done:
    "Done: Privy removed every signer on this wallet, then added the keeper's signer with its policy. The keeper " +
    "checks its seat on its next sweep.",
  grantedOnly:
    "Privy's record already showed no signer on this wallet, so nothing was removed; the keeper's signer was added " +
    "with its policy.",
  notATradingWallet: "Re-seat works only on a trading wallet Privy holds on this account. Nothing was removed.",
  notPerWallet:
    "Re-seat is not available for this wallet. Privy removes the signers of one wallet at a time only from a TEE " +
    "wallet it lists with its own wallet id, and its record does not show this one that way; for other wallets its " +
    "removal revokes the signers of every wallet on your account. Nothing was removed.",
  notListed: "Privy's record does not list this wallet's signers right now, so nothing was removed. Check again in a moment.",
  removalUnconfirmed: "Privy did not confirm that it removed this wallet's signers, and nothing was added.",
  recordShowsSigner: "Privy's record still shows a signer on this wallet.",
  recordUnreadable: "This page could not read from Privy's record whether the old signer is still there.",
  pressAgain: "Press Re-seat keeper again when that is fixed; if the wallet says No seat by then, press Grant keeper permission instead.",
  recordLags:
    "Privy accepted removing this wallet's signers, but its record still shows a signer after every wait, so the " +
    "keeper's seat was not added yet: adding it now could seat it next to a signer on its way out. Press Re-seat " +
    "keeper again in a minute.",
  removedNotAdded: "Every signer is off this wallet now, but the keeper's seat was NOT added.",
  removedNotAddedNext:
    "The wallet is safe: only you can sign for it. But nothing is put aside from it until the seat is back — press " +
    "Grant keeper permission on this wallet.",
  signerReappeared:
    "Privy's record showed no signer on this wallet, then a signer this page did not add, so the keeper's seat was " +
    "not added. Press Re-seat keeper again.",
} as const;

/** Sentences joined with one space, the blank ones dropped. */
const sentences = (...parts: readonly (string | null)[]): string => parts.filter((part): part is string => part !== null && part !== "").join(" ");

/**
 * Why Privy's removeSigners must not be called for this wallet, or null when it may.
 *
 * PRIVY REMOVES PER WALLET ONLY FROM A TEE WALLET. @privy-io/react-auth 3.36.0's
 * removeSigners finds the address among the user's wallets with walletClientType
 * "privy", and clears THAT wallet's additional_signers only when it has a server
 * id and recoveryMethod "privy-v2" — the SDK's own isUnifiedWallet. For any other
 * wallet it calls Privy's legacy revoke, which takes no address and revokes EVERY
 * delegated wallet on the account. Those three conditions are read here, from the
 * record, before anything is sent.
 */
export function reseatRefusal(user: User | null, address: string): string | null {
  const account = embeddedSolanaAccount(user, address);
  if (account === null) return RESEAT_COPY.notATradingWallet;
  const recovery: unknown = account.recoveryMethod;
  const id: unknown = account.id;
  if (account.walletClientType !== "privy" || typeof id !== "string" || id === "" || recovery !== "privy-v2") {
    return RESEAT_COPY.notPerWallet;
  }
  return null;
}

/**
 * RE-SEAT: remove every signer on a trading wallet, then seat the keeper's current
 * signer with its policy. The repair for a seat that names a signer the keeper no
 * longer holds the key to — and for any other wrong seat, since this page cannot
 * tell them apart (seatOf).
 *
 * WHY REMOVE-ALL-THEN-ADD. The React SDK offers nothing narrower: removeSigners
 * takes only an address and clears every signer, and addSigners appends. Both
 * are, underneath, one owner-signed update of the wallet's additional_signers,
 * but that update is not exposed. So there is a moment with no signer at all. It
 * is the SAFE side — only the owner can sign — and the partial state it can leave
 * is exactly the "missing" seat the row already repairs in one press.
 *
 * REFUSES FIRST: never a signer without its policy (keeperSigners), and nothing
 * sent for a wallet Privy would not remove per wallet (reseatRefusal). The record
 * is read afresh first, and a failed read sends nothing.
 *
 * A RECORD THAT ALREADY SHOWS NO SIGNER IS ONLY GRANTED ("granted"): a previous
 * re-seat's removal may be what it shows.
 *
 * THE RECORD MUST SHOW NO SIGNER BEFORE ANYTHING IS ADDED. grantKeeperSeat adds
 * nothing to a record that shows one, so a record still catching up with the
 * removal would otherwise end in a wallet with no signer under a "Has a signer"
 * badge. The record is re-read on GRANT_BACKOFF_MS until it shows none.
 *
 * THEN THE GRANT, AS IT IS: its refusals, its re-read and its propagation backoff
 * all hold. Any stop after the removal is a ReseatIncomplete (ReseatStage), never
 * "reseated".
 */
export async function reseatKeeperSeat({
  address,
  config,
  removeSigners,
  addSigners,
  refreshUser,
  wait = sleep,
}: {
  address: string;
  config: SeatConfig;
  removeSigners: RemoveSignersFn;
  addSigners: AddSignersFn;
  refreshUser: RefreshUserFn;
  wait?: (ms: number) => Promise<void>;
}): Promise<"reseated" | "granted"> {
  if (keeperSigners(config) === null) throw new SeatNotConfigured(seatProblem(config) ?? "The keeper's seat is not configured.");

  const before = await refreshUser();
  const removing = seatOf(before, address) !== "missing";
  if (removing) {
    const refusal = reseatRefusal(before, address);
    if (refusal !== null) throw new ReseatRefused(refusal);
    if (seatOf(before, address) === "unknown") throw new ReseatRefused(RESEAT_COPY.notListed);

    let refused: unknown = null;
    try {
      // An explicit object, never a click event: the address is the only thing removeSigners reads.
      await removeSigners({ address });
    } catch (error) {
      refused = error;
    }

    for (let attempt = 0; ; attempt += 1) {
      // A failed read is no answer: it counts as "not shown without signers", never as removed.
      const seen = seatOf(await refreshUser().catch(() => null), address);
      // Removed, whatever removeSigners answered: its own re-read of the user can fail after the removal landed.
      if (seen === "missing") break;
      if (refused !== null) {
        throw new ReseatIncomplete(
          "removal-unconfirmed",
          sentences(
            RESEAT_COPY.removalUnconfirmed,
            seen === "has-signer" ? RESEAT_COPY.recordShowsSigner : RESEAT_COPY.recordUnreadable,
            failureText(refused),
            RESEAT_COPY.pressAgain,
          ),
        );
      }
      const delay = GRANT_BACKOFF_MS[attempt];
      if (delay === undefined) throw new ReseatIncomplete("record-still-lists-a-signer", RESEAT_COPY.recordLags);
      await wait(delay);
    }
  }

  let granted: "granted" | "has-signer";
  try {
    granted = await grantKeeperSeat({ address, config, addSigners, refreshUser, wait });
  } catch (error) {
    throw new ReseatIncomplete("removed-not-added", sentences(RESEAT_COPY.removedNotAdded, failureText(error), RESEAT_COPY.removedNotAddedNext));
  }
  if (granted === "has-signer") throw new ReseatIncomplete("signer-reappeared", RESEAT_COPY.signerReappeared);
  return removing ? "reseated" : "granted";
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
  if (
    error instanceof SeatNotConfigured ||
    error instanceof NotATradingWallet ||
    error instanceof ReseatRefused ||
    error instanceof ReseatIncomplete
  ) {
    return error.message;
  }
  const described = privyFailure(error);
  return described.kind === "exited" ? null : described.message;
}
