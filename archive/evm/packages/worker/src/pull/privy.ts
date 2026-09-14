// The Privy seat: how a pull gets signed WITHOUT the worker holding a trading key.
//
// Ported from the keeper of the project this was forked from (src/privy-signer.ts and privy-wallets.ts.)
//
// WHY THIS EXISTS. `submit.ts` needs a signer for the trading wallet, because
// `SettlementExecutor.settle` resolves the vault from `msg.sender`. The only
// other way to satisfy that is the wallet's own private key — total custody of
// the user's whole wallet, which a service cannot ask a stranger for.
//
// Privy signers replace it. The user's wallet stays theirs; the app is added as
// a *signer* with a POLICY, and Privy's enclave refuses anything the policy does
// not allow. The credential this process holds is an authorization key that can
// only ask Privy to sign, and only within that policy — it cannot move a token,
// cannot trade on the user's behalf, and cannot be used anywhere else.
//
// WHAT THIS IS NOT. The containment is enforced by Privy's policy engine, not by
// a contract. That is a weaker guarantee than an on-chain module and it should
// be described that way: "we cannot take your money because Privy will not let
// us", not "check the chain yourself". The policy is therefore the security
// boundary. And the seat is a claim about the SIGNING PATH, never about the
// funds: an exported key is a second signer without a policy, which is why the
// pull is best-effort and never a promise.
//
// `signTransaction` and not `sendTransaction`, on purpose: the worker must hold
// the serialized bytes — and therefore the hash — before the network sees them.
// Privy's `eth_signTransaction` returns exactly that.
//
// WHOSE SEAT, NOT WHETHER THERE IS ONE. The wallet is ours to sign for only if
// OUR signer id is among its additional signers; the user may seat another app
// tomorrow, and that signer answers to them, not to us. The id is
// `PRIVY_SIGNER_ID`, the same one the website seats new wallets with.
//
// THE SEAT IS READ FRESH, EVERY TIME. `walletIdOf` is the join between the two
// worlds — the chain speaks addresses, Privy's signing API speaks wallet ids —
// and it is also the only place that can answer a question the chain cannot:
// does this wallet still grant us a signer? The user can remove every signer
// through Privy's API with no UI of ours, so the answer is never cached: one
// request per pull, and `null` when the seat is gone. A signature already
// issued but not yet broadcast survives the revocation; that window is closed
// by submit.ts's ordering (sign → record → send, in one pass), not here.

import { PrivyClient } from "@privy-io/node";
import { getAddress } from "viem";

import type { Address, Hex } from "../types.js";

/** A signer that produces a raw signed EIP-1559 transaction for a given wallet through Privy's server API. */
export interface SeatSigner {
  /** null when the wallet has no active app signer (the user revoked the seat) — checked fresh every time. */
  walletIdOf(address: Address): Promise<string | null>;
  signTransaction(walletId: string, tx: { to: Address; data: Hex; value: bigint; nonce: number; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; chainId: number }): Promise<Hex>;
}

/** The unsigned transaction a seat is asked to sign; the same shape `SeatSigner.signTransaction` takes. */
export type SeatTransaction = Parameters<SeatSigner["signTransaction"]>[1];

export interface SeatConfig {
  readonly appId: string;
  readonly appSecret: string;
  /** The authorization private key registered as a signer on the wallets (passed to the SDK verbatim; it strips its own `wallet-auth:` prefix). */
  readonly authorizationPrivateKey: string;
  /**
   * The key quorum id of OUR seat: `PRIVY_SIGNER_ID`, the same value the website
   * seats wallets with (docs/architecture/WEB_WALLETS.md §1). A wallet counts as
   * seated only when that id is among its additional signers — without it ANY
   * additional signer would answer for ours, and the pull would be built against
   * a seat we do not hold. Optional in the type only so `config.ts` can start
   * passing it without a red build in between; `seatSignerOver` refuses to
   * construct a seat without it.
   */
  readonly signerId?: string;
}

/** The subset of a Privy wallet record the seat decision reads. Field names are Privy's. */
export interface PrivyWalletRecord {
  readonly id: string;
  readonly address: string;
  readonly chain_type?: string;
  /** The app's seats. Empty (or absent) after the user removes every signer. */
  readonly additional_signers?: readonly { readonly signer_id?: string }[] | null;
  /** Non-null once archived: an archived wallet cannot be asked to sign. */
  readonly archived_at?: number | null;
}

/**
 * The two Privy calls the seat makes, behind an interface so tests hand in a
 * fake and the real SDK is adapted exactly once, in `privySeatApi`.
 */
export interface SeatApi {
  /** Every wallet of this app at `address` (Privy normalises to EIP-55; matching here is case-insensitive). */
  walletsAt(address: Address): Promise<readonly PrivyWalletRecord[]>;
  /** Privy's `eth_signTransaction`; the raw response, validated by the caller. */
  signTransaction(walletId: string, tx: SeatTransaction, authorizationPrivateKey: string): Promise<unknown>;
}

/** Privy takes quantities as hex strings; viem hands us bigints. */
const quantity = (value: bigint): string => `0x${value.toString(16)}`;

/**
 * The pure seat decision. Returns the wallet id of the one ethereum wallet at
 * `address` that carries OUR seat — `signerId` among its additional signers —
 * else null. Exported so the rule is testable without a client.
 */
export function seatOf(wallets: readonly PrivyWalletRecord[], address: Address, signerId: string): string | null {
  const wanted = address.toLowerCase();
  for (const wallet of wallets) {
    if (typeof wallet.id !== "string" || typeof wallet.address !== "string") continue;
    if (wallet.address.toLowerCase() !== wanted) continue;
    if (wallet.chain_type !== undefined && wallet.chain_type !== "ethereum") continue;
    if (wallet.archived_at !== undefined && wallet.archived_at !== null) continue;
    const signers = wallet.additional_signers;
    if (!Array.isArray(signers) || signers.length === 0) continue;
    // A seat is OURS or it is nobody's: a second app on the same wallet is a
    // signer we cannot use, and counting it would turn a revoked seat into a
    // Privy refusal at signing time instead of a clean SEAT_REVOKED skip.
    if (signers.some((signer) => signer?.signer_id === signerId)) return wallet.id;
  }
  return null;
}

/**
 * The signer id, or a refusal to build a seat at all. Missing configuration is
 * not a wallet whose seat is gone — it is a worker that cannot tell the two
 * apart — so it stops the process at construction rather than mislabelling
 * every wallet it later looks at.
 */
export function requireSignerId(signerId: string | undefined): string {
  const id = signerId?.trim();
  if (id === undefined || id === "") {
    throw new Error(
      "The Privy seat needs the app's signer id (PRIVY_SIGNER_ID — the key quorum the website seats wallets with). " +
        "Without it every additional signer on a wallet counts as ours, and a pull would be planned against a seat we do not hold.",
    );
  }
  return id;
}

/** Builds the seat over any `SeatApi`. `privySeatSigner` uses the real one; tests use a fake. */
export function seatSignerOver(api: SeatApi, config: Pick<SeatConfig, "authorizationPrivateKey" | "signerId">): SeatSigner {
  const signerId = requireSignerId(config.signerId);
  return {
    async walletIdOf(address) {
      // Fresh per call, by design: see the header.
      const wallets = await api.walletsAt(address);
      return seatOf(wallets, address, signerId);
    },

    async signTransaction(walletId, tx) {
      const response = await api.signTransaction(walletId, tx, config.authorizationPrivateKey);
      const signed = (response as { signed_transaction?: unknown } | null | undefined)?.signed_transaction;
      if (typeof signed !== "string" || !signed.startsWith("0x")) {
        // A policy refusal arrives as a rejected request, but a SHAPE change
        // arrives as a success with nothing usable in it. Refusing here keeps
        // that from being mistaken for a signature.
        throw new Error(
          "Privy returned no `signed_transaction`. Either the policy refused this call or the " +
            "API response shape changed; nothing was broadcast.",
        );
      }
      return signed as Hex;
    },
  };
}

/** The real SDK behind `SeatApi`. Nothing else in the worker imports @privy-io/node. */
export function privySeatApi(config: Pick<SeatConfig, "appId" | "appSecret">): SeatApi {
  const privy = new PrivyClient({ appId: config.appId, appSecret: config.appSecret });

  return {
    async walletsAt(address) {
      const found: PrivyWalletRecord[] = [];
      // `list` is paginated by the SDK's async iterator; filtered by address it
      // is one small page, and it is the documented join (wallets.list) rather
      // than a by-address getter that 404s on "absent" and "archived" alike.
      for await (const wallet of privy.wallets().list({ address: getAddress(address), chain_type: "ethereum" })) {
        found.push(wallet as unknown as PrivyWalletRecord);
      }
      return found;
    },

    async signTransaction(walletId, tx, authorizationPrivateKey) {
      return privy
        .wallets()
        .ethereum()
        .signTransaction(walletId, {
          params: {
            transaction: {
              to: tx.to,
              value: quantity(tx.value),
              data: tx.data,
              nonce: tx.nonce,
              chain_id: tx.chainId,
              gas_limit: quantity(tx.gas),
              max_fee_per_gas: quantity(tx.maxFeePerGas),
              max_priority_fee_per_gas: quantity(tx.maxPriorityFeePerGas),
              type: 2,
            },
          },
          authorization_context: {
            authorization_private_keys: [authorizationPrivateKey],
          },
        });
    },
  };
}

/** Port of keeper-old privy-signer.ts + privy-wallets.ts (authorization key, wallets.list join, seat read fresh per call). */
export function privySeatSigner(config: SeatConfig): SeatSigner {
  return seatSignerOver(privySeatApi(config), config);
}
