// The program suite's HTTP-polling confirmTransaction, for the local proof's
// Connection.
//
// A COPY OF packages/solana-program/tests/config-fixture.ts:27-84, byte for byte
// below the imports. That file is not among @sip/solana-program's `exports`, and it
// also carries the suite's fixed-seed attester, which nothing in the keeper may
// import. The keeper's own settle turn already confirms by polling (settle-tick.ts
// `landing`); this covers everything else the proof sends through Anchor's .rpc()
// and web3.js's sendAndConfirmTransaction, which would otherwise wait on a
// websocket notification a local validator is known to drop.

import {
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
