// Signs and broadcasts a Solana transaction AS THE TRADING WALLET, via Privy —
// no private key on this machine.
//
// Ported from Nuvem's solana-lab keeper (keeper/src/privy-signer.ts). The app
// secret and the authorization key now arrive as `Secret`s and are revealed only
// inside the SDK calls; nothing else changed.
//
// THE TRUST MODEL, ported from the EVM keeper's privy-signer.ts. This process
// never holds a wallet key. It holds ONE authorization key, registered as a
// signer on each trading wallet during onboarding (addSigners), and Privy acts
// only when a request carries that key's signature AND satisfies the wallet's
// policy.
//
// WHY signAndSendTransaction AND NOT signTransaction — this is the whole reason
// the file looks like this. Privy's SOLANA POLICIES can only gate four methods:
// '*', 'exportPrivateKey', 'signAndSendTransaction' and 'signMessage'.
// `signTransaction` is NOT among them, so a keeper built on it would run with a
// signer the policy could not constrain — an unbounded credential wearing the
// costume of a bounded one. Sending through Privy keeps the program allowlist
// in force, and costs nothing: the transaction is already complete when it
// leaves here.
//
// The attester's Ed25519 instruction rides INSIDE the serialized transaction,
// so Privy adds only the wallet's signature and broadcasts. Nothing about the
// attestation passes through Privy's hands as data it could alter.

import { PrivyClient } from "@privy-io/node";
import { PublicKey, VersionedTransaction, Transaction } from "@solana/web3.js";
import type { Secret } from "@sip/worker/log";

/** CAIP-2 for Solana mainnet-beta. */
export const SOLANA_MAINNET_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

export interface PrivySolanaConfig {
  readonly appId: string;
  readonly appSecret: Secret;
  /** The app authorization key registered as a signer on the wallet. */
  readonly authorizationKey: Secret;
  /** Defaults to mainnet-beta. */
  readonly caip2?: string;
}

export interface SolanaWalletSubmitter {
  readonly address: PublicKey;
  /** Signs as the wallet and broadcasts; returns the transaction signature. */
  submit(transaction: Transaction | VersionedTransaction): Promise<string>;
}

/**
 * What resolving an address against Privy can answer. THREE outcomes, not a
 * nullable — because "not our wallet" and "our wallet, but it never granted the
 * keeper's signer" look identical from the outside and demand different fixes
 * (nothing vs. re-running the onboarding registration).
 */
export type PrivySolanaResolution =
  | { readonly outcome: "SIGNER"; readonly signer: SolanaWalletSubmitter }
  | { readonly outcome: "NOT_A_PRIVY_WALLET" }
  | { readonly outcome: "SIGNER_NOT_GRANTED"; readonly granted: readonly string[] };

/** One wallet as Privy reports it: its id and the signers granted on it. */
export interface PrivyWalletEntry {
  readonly walletId: string;
  readonly granted: readonly string[];
}

const clientFor = (config: PrivySolanaConfig): PrivyClient =>
  new PrivyClient({ appId: config.appId, appSecret: config.appSecret.reveal() });

/**
 * ONE pass over the app's Solana wallets, indexed by address.
 *
 * WHY AN INDEX AND NOT A LOOKUP PER WALLET. The per-wallet version rescanned
 * the entire list every time, so a sweep over N linked wallets made N full
 * paginated scans — O(N²) API calls per minute, forever. A trader running a
 * BUNDLE (a dozen wallets is ordinary on Solana) turns that into hundreds of
 * requests a sweep and eventual rate limiting, which surfaces as settlements
 * that mysteriously stop. Built once per sweep, it is one scan regardless of N.
 */
export async function buildPrivySolanaIndex(
  config: PrivySolanaConfig,
): Promise<ReadonlyMap<string, PrivyWalletEntry>> {
  const privy = clientFor(config);
  const index = new Map<string, PrivyWalletEntry>();
  for await (const wallet of privy.wallets().list({ chain_type: "solana" })) {
    const w = wallet as { id?: string; address?: string; additional_signers?: { signer_id?: string }[] };
    if (typeof w.address !== "string" || typeof w.id !== "string") continue;
    index.set(w.address, {
      walletId: w.id,
      granted: (w.additional_signers ?? [])
        .map((signer) => signer?.signer_id)
        .filter((id): id is string => typeof id === "string"),
    });
  }
  return index;
}

/**
 * Resolves a trading wallet address to its Privy wallet id and returns a
 * submitter.
 *
 * IT READS THE INDEX, and builds one only if none was handed to it. A
 * per-wallet lookup is N requests where the index is one scan, so the index
 * wins for every N above one. Use the parameter; the fallback exists for
 * callers with a single wallet.
 *
 * ERRORS PROPAGATE. Two layers of catch-to-null once dressed a missing SDK
 * method up as "wallet has no signer" — a user problem that was ours. An absent
 * entry means the address is not in this app; a failed listing throws.
 *
 * `expectedSignerId` (the key quorum id) turns "found" into "found AND
 * signable": when given and absent from the wallet's additional_signers, the
 * submit would be refused by Privy anyway, so the keeper learns it here, once,
 * as a reportable fact instead of a failed attempt per sweep forever.
 */
export async function createPrivySolanaSigner(
  config: PrivySolanaConfig,
  address: PublicKey,
  expectedSignerId?: string,
  /** The sweep's index. Omitted, one is built for this call alone. */
  index?: ReadonlyMap<string, PrivyWalletEntry>,
): Promise<PrivySolanaResolution> {
  const resolved = (index ?? (await buildPrivySolanaIndex(config))).get(address.toBase58());
  if (resolved === undefined) return { outcome: "NOT_A_PRIVY_WALLET" };
  const { walletId, granted } = resolved;
  if (expectedSignerId !== undefined && !granted.includes(expectedSignerId)) {
    return { outcome: "SIGNER_NOT_GRANTED", granted: [...granted] };
  }

  const signer: SolanaWalletSubmitter = {
    address,
    async submit(transaction) {
      const serialized =
        transaction instanceof VersionedTransaction
          ? Buffer.from(transaction.serialize())
          : transaction.serialize({ requireAllSignatures: false, verifySignatures: false });

      // `transaction` goes at the TOP level: this SDK builds the raw `params`
      // object itself (a base64 string in, {transaction, encoding} out). The
      // first version nested a hand-built `params`, which the SDK's own
      // overwrote with {transaction: undefined}, and Privy answered 400
      // `params.transaction` is required — an error naming a field this file
      // believed it had sent.
      const response = await clientFor(config)
        .wallets()
        .solana()
        .signAndSendTransaction(walletId, {
          caip2: (config.caip2 ?? SOLANA_MAINNET_CAIP2) as `${string}:${string}`,
          transaction: serialized.toString("base64"),
          authorization_context: { authorization_private_keys: [config.authorizationKey.reveal()] },
        });

      const hash = response.hash;
      if (typeof hash !== "string") {
        // A policy refusal is a rejected request; a shape change is a success
        // with nothing usable in it. Refusing here keeps the second from being
        // mistaken for a broadcast that happened.
        throw new Error(
          "Privy returned no transaction hash — the policy refused this settle, or the API shape " +
            "changed. Treat the settlement as NOT sent.",
        );
      }
      return hash;
    },
  };
  return { outcome: "SIGNER", signer };
}
