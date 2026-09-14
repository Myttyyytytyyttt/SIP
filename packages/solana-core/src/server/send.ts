// Simulate, then send — after verify-tx.ts has passed the transaction.
//
// THE SIMULATION IS THE PREFLIGHT, with sigVerify:true and the real blockhash, so
// a transaction that would fail on chain (or whose blockhash expired while two
// people signed it) is refused with the program's own logs before a lamport of
// fee is spent. The send then skips preflight, and the signature the endpoint
// returns must be the one the verifier computed.
//
// NO POLLING. The caller confirms with getSignatureStatuses through
// /api/solana-rpc (client/confirm.ts); holding a request open here would tie up
// the only web process for as long as the network takes.

import { ResponseTooLargeError, RpcAnswerError, RpcUnavailableError, UpstreamLeakError, type RpcPool } from "./rpc-pool";
import type { VerifiedTransaction } from "./verify-tx";

export const LOG_TAIL_LINES = 20;

export type SendOutcome =
  | { readonly ok: true; readonly signature: string; readonly slot: number | null; readonly unitsConsumed: number | null }
  /** The chain refused it in simulation (err is the RPC's TransactionError, e.g. "BlockhashNotFound" or {InstructionError:[0,{Custom:6001}]}). */
  | { readonly ok: false; readonly stage: "simulate"; readonly reason: "rejected"; readonly err: unknown; readonly logs: readonly string[] }
  /** The endpoints could not be asked, or answered unusably. */
  | { readonly ok: false; readonly stage: "simulate" | "send"; readonly reason: "unavailable"; readonly message: string }
  /** sendTransaction answered with a JSON-RPC error. */
  | { readonly ok: false; readonly stage: "send"; readonly reason: "rejected"; readonly err: unknown; readonly logs: readonly string[]; readonly message: string }
  | { readonly ok: false; readonly stage: "send"; readonly reason: "signature_mismatch"; readonly message: string };

interface SimulationValue {
  readonly err: unknown;
  readonly logs?: readonly string[] | null;
  readonly unitsConsumed?: number | null;
}

const tail = (pool: RpcPool, logs: unknown): string[] =>
  Array.isArray(logs) ? logs.slice(-LOG_TAIL_LINES).map((line) => pool.scrub(String(line)).slice(0, 400)) : [];

function unavailable(stage: "simulate" | "send", pool: RpcPool, error: unknown): SendOutcome {
  const message =
    error instanceof RpcUnavailableError || error instanceof ResponseTooLargeError || error instanceof UpstreamLeakError
      ? error.message
      : error instanceof Error
        ? error.name
        : "unknown error";
  return { ok: false, stage, reason: "unavailable", message: pool.scrub(message) };
}

export async function simulateAndSend(pool: RpcPool, verified: VerifiedTransaction): Promise<SendOutcome> {
  let slot: number | null = null;
  let unitsConsumed: number | null = null;
  try {
    const simulated = await pool.call<{ context?: { slot?: number }; value?: SimulationValue }>("simulateTransaction", [
      verified.wireBase64,
      { encoding: "base64", sigVerify: true, replaceRecentBlockhash: false, commitment: "confirmed" },
    ]);
    const value = simulated?.value;
    if (value === undefined || value === null) return { ok: false, stage: "simulate", reason: "unavailable", message: "simulateTransaction answered without a value" };
    slot = typeof simulated.context?.slot === "number" ? simulated.context.slot : null;
    unitsConsumed = typeof value.unitsConsumed === "number" ? value.unitsConsumed : null;
    if (value.err !== null && value.err !== undefined) {
      return { ok: false, stage: "simulate", reason: "rejected", err: value.err, logs: tail(pool, value.logs) };
    }
  } catch (error) {
    if (error instanceof RpcAnswerError) {
      // e.g. -32003 "Transaction signature verification failure": a refusal of
      // this transaction, not of the endpoint.
      const data = error.data as { logs?: unknown; err?: unknown } | undefined;
      return {
        ok: false,
        stage: "simulate",
        reason: "rejected",
        err: data?.err ?? { code: error.code, message: pool.scrub(error.message) },
        logs: tail(pool, data?.logs),
      };
    }
    return unavailable("simulate", pool, error);
  }

  let returned: unknown;
  try {
    returned = await pool.call<string>("sendTransaction", [verified.wireBase64, { encoding: "base64", skipPreflight: true, maxRetries: 5 }]);
  } catch (error) {
    if (error instanceof RpcAnswerError) {
      const data = error.data as { logs?: unknown; err?: unknown } | undefined;
      return { ok: false, stage: "send", reason: "rejected", err: data?.err ?? null, logs: tail(pool, data?.logs), message: pool.scrub(error.message) };
    }
    return unavailable("send", pool, error);
  }
  if (returned !== verified.signature) {
    return { ok: false, stage: "send", reason: "signature_mismatch", message: "the endpoint returned a signature that is not this transaction's" };
  }
  return { ok: true, signature: verified.signature, slot, unitsConsumed };
}
