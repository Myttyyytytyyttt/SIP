/**
 * BEFORE A KEY GOES TO PRIVY: every reason not to import it, read first.
 *
 * Importing is not undone. Once Privy holds the key with the keeper's seat on
 * it, the wallet stays on the account. So everything that can be known before is
 * checked before, on the address the key's private half opens
 * (src/lib/import-key.ts), and a check that could not be made refuses rather
 * than waves the key through.
 *
 * LOCAL FIRST, then the chain. The seat must be configurable (a key imported
 * without it could never save); the key must not be the pension key; it must not
 * be on this account already, as a trading wallet or as a wallet the account
 * connects; and the account must have room (MAX_TRADING_WALLETS counts created
 * and imported wallets alike, owner 10-08). Then /api/solana-vault's importCheck:
 *
 * - A KEY THAT OWNS A VAULT, OR HOLDS A PROTOCOL ROLE, IS REFUSED. The keeper's
 *   policy lets its seat sign any SaverFi instruction from the wallet, and only
 *   the keeper's own code limits that to settling. On a vault owner's key the
 *   same seat could sign that vault's owner instructions, and on the protocol's
 *   authority (or the one a transfer is pending to) and keeper keys the
 *   protocol's own. The attester signs no instruction — its settlement message
 *   needs signMessage, which the policy denies — and is refused anyway: no
 *   protocol key belongs in a trading wallet.
 * - A WALLET LINKED TO ANOTHER VAULT IS REFUSED: only that vault's owner can
 *   unlink it. One linked to THIS vault is imported and not linked again.
 * - HOLDINGS ARE SHOWN, AND MUST BE ACKNOWLEDGED (owner 10-08). The keeper counts
 *   gains in SOL from the link onwards and knows nothing of what was paid before,
 *   so tokens held now and sold later count, in full, as gain.
 *
 * Pure: the Privy record, the configuration and the chain's answer come in as
 * arguments.
 */

import type { User } from "@privy-io/react-auth";

import { formatSol, rawFrom } from "@/lib/amounts";
import { EMBEDDED_CLIENT_TYPES } from "@/lib/pension-key";
import { MAX_TRADING_WALLETS, keeperSigners, seatProblem, tradingWalletsOf, type SeatConfig } from "@/lib/trading-wallets";
import type { HoldingJson, ImportCheckJson } from "@/lib/vault-api";

export type PreflightRefusal =
  | "seat"
  | "pension_key"
  | "already_yours"
  | "connected_wallet"
  | "full"
  | "chain_unreadable"
  | "owns_vault"
  | "protocol_key"
  | "linked_elsewhere";

/** What the wallet holds besides SOL, when it holds anything. */
export interface HoldingsNotice {
  /** The holdings named (a few of them). */
  readonly holdings: readonly HoldingJson[];
  /** How many non-zero holdings there are in all; null when the listing was too large to read. */
  readonly count: number | null;
  /** Empty token accounts; null when the listing was too large to read. */
  readonly emptyAccounts: number | null;
}

export type Preflight =
  | { readonly kind: "refused"; readonly reason: PreflightRefusal; readonly message: string }
  /** Every local check passed: the chain is next. */
  | { readonly kind: "read_chain" }
  | {
      readonly kind: "go";
      /** False when the wallet is already linked to this vault: the import is all that is left. */
      readonly needsLink: boolean;
      /** The wallet's SOL right now; null when it could not be read. */
      readonly lamports: bigint | null;
      /** Null when it holds no token and no empty token account: nothing to acknowledge. */
      readonly holdings: HoldingsNotice | null;
    };

export const PREFLIGHT_COPY = {
  pensionKey: "This is your pension key. It stays in your own wallet app, and it can never be a trading wallet.",
  alreadyYours: "This wallet is already one of your trading wallets: it is in the list below.",
  connectedWallet:
    "This address is a wallet your account connects from its own app, not one SaverFi holds. Importing it is not supported. Nothing was sent.",
  full: `Your account already has ${MAX_TRADING_WALLETS} trading wallets, created or imported, which is the most SaverFi keeps for one account.`,
  chainUnreadable:
    "SaverFi could not read this wallet on Solana, so nothing was sent. Try again in a moment; if it keeps happening, this wallet cannot be imported here.",
  ownsVault:
    "This key owns a SaverFi vault, so it cannot be a trading wallet: SaverFi's permission on it would also reach that vault. Nothing was sent.",
  protocolKey: "This key holds a role in running SaverFi's protocol, so it cannot be a trading wallet. Nothing was sent.",
  linkedElsewhere: "This wallet is linked to another SaverFi vault. Only that vault's owner can unlink it. Nothing was sent.",
} as const;

const refused = (reason: PreflightRefusal, message: string): Preflight => ({ kind: "refused", reason, message });

/** Whether `address` is a Solana wallet on this account that Privy does not hold (one it connects, like Phantom). */
function connectedOnAccount(user: User | null, address: string): boolean {
  return (user?.linkedAccounts ?? []).some(
    (account) => account.type === "wallet" && account.chainType === "solana" && account.address === address && !EMBEDDED_CLIENT_TYPES.has(account.walletClientType ?? ""),
  );
}

/**
 * The verdict on importing the wallet at `address` into `user`'s account, for
 * `pensionKey`'s vault. `check` is importCheck's answer — the body, or null
 * while it has not been asked; a failed request is "unreadable" and refuses.
 */
export function importPreflight(input: {
  readonly address: string;
  readonly pensionKey: string;
  readonly user: User | null;
  readonly config: SeatConfig;
  readonly check: ImportCheckJson | "unreadable" | null;
}): Preflight {
  const { address, pensionKey, user, config, check } = input;
  if (keeperSigners(config) === null) return refused("seat", seatProblem(config) ?? "The keeper's seat is not configured.");
  if (address === pensionKey) return refused("pension_key", PREFLIGHT_COPY.pensionKey);
  const wallets = tradingWalletsOf(user);
  if (wallets.some((wallet) => wallet.address === address)) return refused("already_yours", PREFLIGHT_COPY.alreadyYours);
  if (connectedOnAccount(user, address)) return refused("connected_wallet", PREFLIGHT_COPY.connectedWallet);
  if (wallets.length >= MAX_TRADING_WALLETS) return refused("full", PREFLIGHT_COPY.full);
  if (check === null) return { kind: "read_chain" };

  // An answer about another address, or another owner, is no answer about this one.
  if (check === "unreadable" || check.wallet !== address || check.owner !== pensionKey) return refused("chain_unreadable", PREFLIGHT_COPY.chainUnreadable);
  // A vault comes first: it is the reason that matters most, and it holds whatever the link says.
  if (check.ownVault.status === "exists") return refused("owns_vault", PREFLIGHT_COPY.ownsVault);
  if (check.ownVault.status !== "missing") return refused("chain_unreadable", PREFLIGHT_COPY.chainUnreadable);
  if (check.protocolRole === "unreadable") return refused("chain_unreadable", PREFLIGHT_COPY.chainUnreadable);
  if (check.protocolRole !== "none") return refused("protocol_key", PREFLIGHT_COPY.protocolKey);
  if (check.link.status === "other_vault") return refused("linked_elsewhere", PREFLIGHT_COPY.linkedElsewhere);
  if (check.link.status === "unreadable") return refused("chain_unreadable", PREFLIGHT_COPY.chainUnreadable);
  const go = { kind: "go" as const, needsLink: check.link.status === "missing", lamports: rawFrom(check.lamports) };
  // A listing too large to read is a wallet with very many token accounts: it is warned about, never waved through
  // and never refused for good.
  if (check.tokens.status === "too_many") return { ...go, holdings: { holdings: [], count: null, emptyAccounts: null } };
  // Without the token read there is nothing to warn with, and the warning is the condition of going on.
  if (check.tokens.status !== "exists" || check.tokens.emptyAccounts === null) return refused("chain_unreadable", PREFLIGHT_COPY.chainUnreadable);

  const { items, emptyAccounts } = check.tokens;
  const count = check.tokens.count ?? items.length;
  return { ...go, holdings: count === 0 && emptyAccounts === 0 ? null : { holdings: items, count, emptyAccounts } };
}

/**
 * The holdings notice, in words. Shown with a checkbox; the import waits for it. Three shapes: tokens (named, the
 * rest counted), a listing too large to read, and empty token accounts alone — each says what it is, and what
 * turning it into SOL later does. wSOL is in the list: unwrapping it is no sale, and still counts.
 */
export const HOLDINGS_COPY = {
  title: "This wallet holds more than SOL",
  titleTooMany: "This wallet has too many token accounts to list",
  titleEmptyOnly: "This wallet has empty token accounts",
  body:
    "SaverFi counts this wallet's gains in SOL from the moment it is linked, and it does not know what you paid for " +
    "anything you hold before that. In profit mode, if you later sell any of these for SOL — or unwrap wSOL — all the " +
    "SOL they bring counts as gain, and your rate of it is put aside into your vault, which can be much more than your " +
    "rate of what you really made.",
  emptyAccounts: (count: number): string =>
    `It also has ${count} empty token ${count === 1 ? "account" : "accounts"}. Closing one gives back about 0.002 SOL, which counts as gain too.`,
  emptyOnly: (count: number): string =>
    `It has ${count} empty token ${count === 1 ? "account" : "accounts"}. Closing one after the wallet is linked gives back about 0.002 SOL, which counts as gain, and in profit mode your rate of it is put aside.`,
  /** Too many to list: closing them is the biggest part (about 0.002 SOL back from each, and there are thousands). */
  tooManyClosing:
    "Closing any of its token accounts after the wallet is linked gives back about 0.002 SOL each, which counts as gain too; with this many, that can add up to several SOL.",
  avoid: "To avoid this, sell or move these before you import the wallet.",
  avoidTooMany: "To avoid this, sell, move or close these before you import the wallet.",
  avoidEmptyOnly: "To avoid this, close them before you import the wallet.",
  acknowledge: "I understand: selling or unwrapping these after the wallet is linked counts as gain.",
  acknowledgeTooMany: "I understand: selling, unwrapping or closing these after the wallet is linked counts as gain.",
  acknowledgeEmptyOnly: "I understand: closing them after the wallet is linked counts as gain.",
  /** Already linked: measured from that link, so nothing done before the import keeps a sale out — only moving tokens away does. */
  avoidLinked:
    "This wallet is measured from when it was linked, or from its last settlement, so selling, unwrapping or closing these now counts too. Moving tokens to another wallet does not.",
  avoidLinkedEmptyOnly: "This wallet is measured from when it was linked, or from its last settlement, so closing them now counts too.",
  startingPoint: (sol: string): string => `It holds ${sol} SOL now. The SOL in the wallet itself when it is linked is its starting point, never counted as gain.`,
  /**
   * Said on every import. This page does not read these: stake accounts could be listed, positions in other apps in
   * general cannot. Unstaking alone moves no SOL on Solana — the later withdrawal does — so the advice is to withdraw.
   */
  elsewhere:
    "SOL that comes back to this wallet later from anything but a plain transfer — withdrawn stake, or lending, perps or limit orders in other apps — counts as gain too. To keep it out, bring it back into the wallet before you import: withdraw staked SOL, not just unstake it.",
  /** The same, for a wallet already linked to this vault: it is measured from that link, so there is nothing to do before. */
  elsewhereLinked:
    "SOL that comes back to this wallet from anything but a plain transfer — withdrawn stake, or lending, perps or limit orders in other apps — counts as gain too, including what came back since it was linked or since its last settlement.",
} as const;

/** The SOL line, or null when the balance was not read. */
export const startingPointLine = (lamports: bigint | null): string | null => (lamports === null ? null : HOLDINGS_COPY.startingPoint(formatSol(lamports)));
