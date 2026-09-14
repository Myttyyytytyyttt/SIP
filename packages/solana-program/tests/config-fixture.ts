// The one ProtocolConfig every spec file shares, and why it has to be shared.
//
// `init_config` is first-caller-wins against a single PDA, so on one validator
// exactly one spec may create it — but since the crank authorization landed,
// EVERY spec that invests, converts or wraps needs it to exist, and settle
// needs its attester to be a key the tests hold the secret for. Whoever runs
// first would otherwise decide the attester, and the loser would fail for a
// reason that has nothing to do with what it was testing.
//
// So the attester is DERIVED FROM A FIXED SEED rather than generated: any spec
// may create the config, and every spec can still sign attestations that
// verify against it. Deterministic keys are a test-only device — this file is
// never imported by the program, the keeper, or either web app.

import * as anchor from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  TransactionExpiredTimeoutError,
  type Commitment,
  type Connection,
  type RpcResponseAndContext,
  type SignatureResult,
  type TransactionConfirmationStrategy,
} from "@solana/web3.js";

/** How long a confirmation is polled before the transaction is reported lost. */
const CONFIRM_DEADLINE_MS = 60_000;
const CONFIRM_POLL_MS = 250;
const PROCESSED_LEVEL: readonly string[] = ["processed", "recent"];
const FINALIZED_LEVEL: readonly string[] = ["finalized", "root", "max"];

/**
 * Confirms transactions by polling getSignatureStatuses over HTTP, instead of
 * waiting for web3.js's websocket signature notification.
 *
 * WHY. On a run with nothing else on the machine, 11 transactions failed with
 * TransactionExpiredTimeoutError ("not confirmed in 30.00 seconds") while the
 * validator log showed every one of them rooted: the notification never
 * reached the client. Anchor's .rpc() confirms by signature alone, which is
 * exactly that wait, so a lost notification failed a test, or a before-all
 * hook and every test under it, for nothing the program did. The
 * {signature, blockhash, lastValidBlockHeight} form waits on the same
 * subscription, so switching to it cures nothing.
 *
 * Every spec file runs its provider's connection through this before any test
 * starts. It replaces confirmTransaction on that one instance, so .rpc(),
 * provider.sendAndConfirm, spl-token's helpers and direct calls all use it.
 * The answer keeps web3.js's shape: a transaction that failed on chain returns
 * its err (Anchor still throws ConfirmError), and one that never shows up
 * throws TransactionExpiredTimeoutError after 60 s.
 */
export function pollingConfirm(connection: Connection): Connection {
  const confirm = async (
    strategy: TransactionConfirmationStrategy | string,
    commitment?: Commitment,
  ): Promise<RpcResponseAndContext<SignatureResult>> => {
    const signature = typeof strategy === "string" ? strategy : strategy.signature;
    const abortSignal = typeof strategy === "string" ? undefined : strategy.abortSignal;
    const wanted: string = commitment ?? connection.commitment ?? "confirmed";
    const reached = (status: string): boolean =>
      status === "finalized" ||
      (status === "confirmed" && !FINALIZED_LEVEL.includes(wanted)) ||
      (status === "processed" && PROCESSED_LEVEL.includes(wanted));
    const deadline = Date.now() + CONFIRM_DEADLINE_MS;
    for (;;) {
      // Anchor's maxRetries: 0 path passes a timeout signal and resends on its TimeoutError.
      if (abortSignal?.aborted) throw abortSignal.reason;
      const { context, value } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
      const status = value[0];
      if (status) {
        if (status.err) return { context, value: { err: status.err } };
        // A node that omits confirmationStatus reports a rooted transaction as confirmations: null.
        if (reached(status.confirmationStatus ?? (status.confirmations === null ? "finalized" : "processed"))) {
          return { context, value: { err: null } };
        }
      }
      if (Date.now() >= deadline) throw new TransactionExpiredTimeoutError(signature, CONFIRM_DEADLINE_MS / 1000);
      await new Promise((resolve) => setTimeout(resolve, CONFIRM_POLL_MS));
    }
  };
  (connection as unknown as { confirmTransaction: typeof confirm }).confirmTransaction = confirm;
  return connection;
}

/** The attester every spec signs with, and that the shared config names. */
export const TEST_ATTESTER = Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, i) => (i + 7) % 251));

export const configPdaFor = (programId: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([Buffer.from("config")], programId)[0];

const UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

/** Where the loader records this program's upgrade authority. init_config reads it. */
export const programDataFor = (programId: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([programId.toBuffer()], UPGRADEABLE_LOADER)[0];

/**
 * Creates the config if it is not there, and returns its address.
 *
 * REFUSES A CONFIG WITH THE WRONG ATTESTER rather than limping on: that means
 * a stale validator ledger from before this fixture existed, and the settle
 * specs would fail later with a signature error that points nowhere near the
 * cause.
 */
export async function ensureConfig(
  // The Program type differs per workspace target; the shape used here is all
  // that matters and pinning it would drag both IDL types into this file.
  program: { programId: PublicKey; account: any; methods: any },
  authority: PublicKey,
): Promise<PublicKey> {
  const configPda = configPdaFor(program.programId);
  const existing = await program.account.protocolConfig.fetchNullable(configPda);
  if (existing === null) {
    await program.methods
      .initConfig(TEST_ATTESTER.publicKey)
      .accountsPartial({ authority, programData: programDataFor(program.programId) })
      .rpc();
    return configPda;
  }
  if (!existing.attester.equals(TEST_ATTESTER.publicKey)) {
    throw new Error(
      `the config at ${configPda.toBase58()} names attester ${existing.attester.toBase58()}, not the shared ` +
        `test attester ${TEST_ATTESTER.publicKey.toBase58()} — restart the validator with a clean ledger`,
    );
  }
  return configPda;
}

/** Names who may crank. Every spec sets this explicitly; none inherits it. */
export async function setKeeper(
  program: { programId: PublicKey; methods: any },
  authority: PublicKey,
  keeper: PublicKey,
): Promise<void> {
  await program.methods
    .setKeeper(keeper)
    .accountsPartial({ authority, config: configPdaFor(program.programId) })
    .rpc();
}

// Keeps `anchor` imported for the ambient types the helpers above rely on.
export type Provider = anchor.AnchorProvider;
