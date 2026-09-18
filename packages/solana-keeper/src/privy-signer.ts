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
//
// ONE CLIENT FACTORY, ONE ATTEMPT, ONE SHAPE. Every Privy client in the keeper
// comes from pinnedPrivyClient below, so where the app secret goes and how often
// a request is sent are decided in one place. A settle leaves once, under an
// idempotency key of its own, and only as [Ed25519SigVerify, settle_v2] paid by
// the wallet: the policy bounds this signer by program, and assertSettleShape
// bounds it by instruction.

import { PrivyClient } from "@privy-io/node";
import { Ed25519Program, PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import type { Secret } from "@sip/solana-log";
import { SIP_PROGRAM_ID, instructionDiscriminator } from "./idl.js";
import type { KeyQuorumLike } from "./privy-authorization-key.js";
import { seatVerdict, seatsFor, type SignerSeat } from "./privy-policy.js";

/** CAIP-2 for Solana mainnet-beta. */
export const SOLANA_MAINNET_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

/**
 * Privy's production API, pinned in code. A Privy client built without apiUrl
 * takes PRIVY_API_BASE_URL from the environment and sends the app secret to
 * whatever host that names; loadConfig refuses the variable as well.
 */
export const PRIVY_API_URL = "https://api.privy.io";

export interface PrivySolanaConfig {
  readonly appId: string;
  readonly appSecret: Secret;
  /** The app authorization key registered as a signer on the wallet. */
  readonly authorizationKey: Secret;
  /** Defaults to mainnet-beta. */
  readonly caip2?: string;
  /** Tests only: a fetch that answers in-process, so the signer's requests are checked with no network. */
  readonly fetch?: typeof globalThis.fetch;
}

export interface SolanaSubmitOptions {
  /**
   * Sent as privy-idempotency-key, inside the request's authorization
   * signature. NEW FOR EVERY ATTEMPT: on /rpc Privy caches a 4xx or a 5xx
   * against the key for 24 hours and replays it, so a key reused after a 504
   * could only ever be answered 504 (docs.privy.io, api-reference/
   * idempotency-keys). settle-tick.ts's settleIdempotencyKey makes one per
   * attempt.
   */
  readonly idempotencyKey: string;
}

export interface SolanaWalletSubmitter {
  readonly address: PublicKey;
  /**
   * Signs as the wallet and broadcasts, in one request; returns the transaction
   * signature. Refuses anything but assertSettleShape's pair, sending nothing.
   */
  submit(transaction: Transaction, options: SolanaSubmitOptions): Promise<string>;
}

/**
 * What resolving an address against Privy can answer. FOUR outcomes, not a
 * nullable — because "not our wallet", "our wallet, but it never granted the
 * keeper's signer" and "our signer is seated, bounded by nothing" look identical
 * from the outside and demand different fixes: nothing, re-running the
 * onboarding registration, and re-seating the signer WITH its policy.
 */
export type PrivySolanaResolution =
  | { readonly outcome: "SIGNER"; readonly signer: SolanaWalletSubmitter }
  | { readonly outcome: "NOT_A_PRIVY_WALLET" }
  | { readonly outcome: "SIGNER_NOT_GRANTED"; readonly granted: readonly string[] }
  | {
      readonly outcome: "SEAT_NOT_BOUNDED";
      readonly granted: readonly string[];
      /** What each of this signer's seats carries, in `privy-policy verify`'s own shape. */
      readonly overridePolicyIds: readonly (readonly string[])[];
    };

/** One wallet as Privy reports it: its id, and every signer seated on it with what bounds that seat. */
export interface PrivyWalletEntry {
  readonly walletId: string;
  readonly seats: readonly SignerSeat[];
}

/** The seats of one wallet, keeping only what Privy actually sent as strings. */
function readSeats(signers: readonly { signer_id?: string; override_policy_ids?: string[] }[] | undefined): readonly SignerSeat[] {
  return (signers ?? [])
    .filter((signer): signer is { signer_id: string; override_policy_ids?: string[] } => typeof signer?.signer_id === "string")
    .map((signer) => ({
      signerId: signer.signer_id,
      overridePolicyIds: (signer.override_policy_ids ?? []).filter((id): id is string => typeof id === "string"),
    }));
}

export interface PinnedPrivyClientOptions {
  readonly appId: string;
  /** Revealed by the caller, inside the call that builds the client. */
  readonly appSecret: string;
  /** Tests only: a fetch that answers in-process. */
  readonly fetch?: typeof globalThis.fetch;
  /** How many times the SDK re-sends a failed request. 0: one attempt. */
  readonly maxRetries?: number;
}

/**
 * THE ONE PLACE A PRIVY CLIENT IS BUILT. The signer below, the policy CLI's
 * client (privy-policy-client.ts) and bin/ready.mts all take theirs from here,
 * and test/privy-client-sites.test.ts fails the day a second construction
 * appears anywhere in src/ or bin/.
 *
 * WHAT IS PINNED, AND WHY:
 *   * apiUrl and logLevel. Left out, the SDK reads PRIVY_API_BASE_URL and
 *     PRIVY_API_LOG from the environment: the first sends the app secret to
 *     whatever host it names, the second logs request details. loadConfig
 *     refuses both by name, and PRIVY_API_CUSTOM_HEADERS, which no option can
 *     override.
 *   * maxRetries 0: ONE ATTEMPT PER REQUEST. The SDK's default re-sends up to
 *     twice on 408, 409, 429, 5xx and dropped connections, POSTs included, with
 *     backoff sleeps in between (client.js shouldRetry). On /rpc a re-send under
 *     the same idempotency key only replays the cached error, and a POST sent
 *     without one — a key quorum — can land twice. The keeper's own loop is the
 *     retry: the next sweep reads the link again, measures anew, and sends under
 *     a new key.
 */
export function pinnedPrivyClient({ appId, appSecret, fetch, maxRetries = 0 }: PinnedPrivyClientOptions): PrivyClient {
  return new PrivyClient({
    appId,
    appSecret,
    apiUrl: PRIVY_API_URL,
    logLevel: "warn",
    maxRetries,
    ...(fetch === undefined ? {} : { fetch }),
  });
}

const clientFor = (config: PrivySolanaConfig): PrivyClient =>
  pinnedPrivyClient({ appId: config.appId, appSecret: config.appSecret.reveal(), fetch: config.fetch });

/** sip-vault, as the exported IDL names it: the only program a settle calls. */
const SIP_PROGRAM = new PublicKey(SIP_PROGRAM_ID);

/** settle_v2's discriminator, from the exported IDL: [5, 41, 238, 141, 219, 81, 39, 145]. */
const SETTLE_V2_DISCRIMINATOR = instructionDiscriminator("settle_v2");

/**
 * Throws unless `transaction` is exactly what a settle sends: the attester's
 * Ed25519SigVerify, then settle_v2 on `programId`, paid by `wallet`.
 *
 * WHY THE SHAPE IS CHECKED HERE AND NOT LEFT TO THE POLICY. The keeper's Privy
 * policy (privy-policy.ts) allows any transaction made entirely of sip-vault and
 * Ed25519SigVerify instructions, because Privy's solana_program_instruction
 * source sees program ids and never instruction data. So the policy would let
 * this signer send link_wallet, a second settle_v2, or an Ed25519 instruction
 * that declares extra signatures only to charge the wallet a fee for each. None
 * of those is a settle, and the keeper builds nothing else, so anything else is
 * a bug and never leaves.
 *
 * WHAT IS REQUIRED, READ FROM settle.rs AND ed25519_introspection.rs:
 *   * exactly two instructions, the Ed25519SigVerify one FIRST. settle_v2 reads
 *     the instruction at its own index minus one and refuses AttestationMissing
 *     when that is not the precompile, and the keeper sends nothing besides;
 *   * the Ed25519SigVerify instruction names no accounts and declares ONE
 *     signature in a header the program can read (data.len() >= 16 and
 *     data[0] == 1, its AttestationMalformed checks), so the wallet pays for one;
 *   * the second instruction is `programId` with settle_v2's discriminator.
 *     link_wallet, the other sip-vault instruction that reads a preceding
 *     Ed25519 check, is refused;
 *   * the fee payer is the wallet the signer signs as: settle_v2's `wallet` is
 *     the Signer that pays the contribution, and a transaction someone else
 *     pays for is not this wallet's settle.
 *
 * A LEGACY Transaction, as settle-tick.ts builds it. A VersionedTransaction can
 * load accounts from lookup tables no local check reads, so the signer takes none.
 */
export function assertSettleShape(transaction: Transaction, programId: PublicKey, wallet: PublicKey): void {
  const refuse = (what: string): never => {
    throw new Error(
      `refusing to send a transaction that is not a settle: ${what}. Only [Ed25519SigVerify, settle_v2] paid by the ` +
        "trading wallet leaves through its signer; nothing was sent",
    );
  };
  const count = transaction.instructions.length;
  if (count !== 2) refuse(`it has ${count} instruction${count === 1 ? "" : "s"}, not 2`);
  const [verify, settle] = transaction.instructions as [TransactionInstruction, TransactionInstruction];
  if (!verify.programId.equals(Ed25519Program.programId)) refuse(`instruction 0 calls ${verify.programId.toBase58()}, not Ed25519SigVerify`);
  if (verify.keys.length !== 0) {
    refuse(`the Ed25519SigVerify instruction names ${verify.keys.length} account${verify.keys.length === 1 ? "" : "s"}, and it takes none`);
  }
  if (verify.data.length < 16 || verify.data[0] !== 1) refuse("the Ed25519SigVerify instruction does not declare exactly one signature");
  if (!settle.programId.equals(programId)) refuse(`instruction 1 calls ${settle.programId.toBase58()}, not sip-vault ${programId.toBase58()}`);
  if (settle.data.length < 8 || !settle.data.subarray(0, 8).equals(SETTLE_V2_DISCRIMINATOR)) refuse("instruction 1 is not settle_v2");
  if (transaction.feePayer === undefined || !transaction.feePayer.equals(wallet)) {
    refuse(`it is paid by ${transaction.feePayer?.toBase58() ?? "no fee payer"}, not the wallet ${wallet.toBase58()}`);
  }
}

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
    // override_policy_ids RIDES IN THIS LISTING. It is a field of
    // WalletAdditionalSignerItem, so what bounds each seat is read here with no
    // request of its own. The narrowing cast used to leave it out, and every
    // reader downstream was then structurally unable to tell a seat bounded by
    // the keeper's policy from one bounded by nothing.
    const w = wallet as {
      id?: string;
      address?: string;
      additional_signers?: { signer_id?: string; override_policy_ids?: string[] }[];
    };
    if (typeof w.address !== "string" || typeof w.id !== "string") continue;
    index.set(w.address, { walletId: w.id, seats: readSeats(w.additional_signers) });
  }
  return index;
}

/**
 * A key quorum's registered PUBLIC keys, by id.
 *
 * APP CREDENTIALS ONLY. GET /v1/key_quorums takes no authorization signature —
 * the SDK threads prepareRequest through update and delete alone — so this reads
 * the ground truth even when the authorization key is the very thing in doubt.
 * That is what makes a boot-time check of the pairing possible at all.
 *
 * ERRORS PROPAGATE, so the caller can tell 401 from 404 from a dropped
 * connection (quorumReadVerdict, privy-authorization-key.ts). Nothing here
 * interprets, and no secret is returned: an authorization key's PUBLIC half is
 * public by construction.
 */
export async function readPrivyKeyQuorum(config: PrivySolanaConfig, keyQuorumId: string): Promise<KeyQuorumLike> {
  const quorum = await clientFor(config).keyQuorums().get(keyQuorumId);
  return {
    id: quorum.id,
    authorizationKeys: (quorum.authorization_keys ?? []).map((entry) => ({ publicKey: entry.public_key, displayName: entry.display_name })),
  };
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
 *
 * `expectedPolicyId` turns that into "found, signable AND BOUNDED". A seat is
 * what makes this keeper's one authorization key able to act as a trading
 * wallet; the policy attached as that seat's override is the ONLY thing
 * narrowing it to sip-vault transactions. A seat without it can sign any
 * message, send any transaction and export the wallet's key, so the keeper
 * declines to use it at all rather than trusting that nobody else ever holds
 * the key.
 *
 * OMITTED, IT CANNOT REFUSE. The rule is reached only through this parameter,
 * never read from a config inside: with no policy id configured the caller
 * passes nothing and the refusal below is unreachable code, which is a stronger
 * guarantee than a flag someone can default to true later. The same applies
 * with no `expectedSignerId`: there is then no seat to look for, and the whole
 * check is skipped rather than guessed at.
 */
export async function createPrivySolanaSigner(
  config: PrivySolanaConfig,
  address: PublicKey,
  expectedSignerId?: string,
  /** The sweep's index. Omitted, one is built for this call alone. */
  index?: ReadonlyMap<string, PrivyWalletEntry>,
  /** The policy that must bound this signer's seat. Omitted, the seat's bound is not examined. */
  expectedPolicyId?: string,
): Promise<PrivySolanaResolution> {
  const resolved = (index ?? (await buildPrivySolanaIndex(config))).get(address.toBase58());
  if (resolved === undefined) return { outcome: "NOT_A_PRIVY_WALLET" };
  const { walletId, seats } = resolved;
  const granted = seats.map((seat) => seat.signerId);
  if (expectedSignerId !== undefined && !granted.includes(expectedSignerId)) {
    return { outcome: "SIGNER_NOT_GRANTED", granted: [...granted] };
  }
  if (expectedSignerId !== undefined && expectedPolicyId !== undefined) {
    // verify's rule, from the one function both call: exactly one override
    // policy id, and this one.
    if (seatVerdict(seats, expectedSignerId, expectedPolicyId) === "NOT_BOUNDED") {
      return {
        outcome: "SEAT_NOT_BOUNDED",
        granted: [...granted],
        overridePolicyIds: seatsFor(seats, expectedSignerId).map((seat) => [...seat.overridePolicyIds]),
      };
    }
  }

  const signer: SolanaWalletSubmitter = {
    address,
    async submit(transaction, { idempotencyKey }) {
      // THE SIGNER ITSELF REFUSES ANYTHING BUT A SETTLE, whoever calls it.
      // settle-tick.ts checks the same shape before either route sends, so a
      // refusal here is a new caller, never a settle turn.
      assertSettleShape(transaction, SIP_PROGRAM, address);
      const serialized = transaction.serialize({ requireAllSignatures: false, verifySignatures: false });

      // `transaction` goes at the TOP level: this SDK builds the raw `params`
      // object itself (a base64 string in, {transaction, encoding} out). The
      // first version nested a hand-built `params`, which the SDK's own
      // overwrote with {transaction: undefined}, and Privy answered 400
      // `params.transaction` is required — an error naming a field this file
      // believed it had sent. `idempotency_key` sits there too: the SDK takes it
      // out of the body and sends it as privy-idempotency-key, signed into the
      // authorization signature with the rest of the request.
      const response = await clientFor(config)
        .wallets()
        .solana()
        .signAndSendTransaction(walletId, {
          caip2: (config.caip2 ?? SOLANA_MAINNET_CAIP2) as `${string}:${string}`,
          transaction: serialized.toString("base64"),
          authorization_context: { authorization_private_keys: [config.authorizationKey.reveal()] },
          idempotency_key: idempotencyKey,
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
