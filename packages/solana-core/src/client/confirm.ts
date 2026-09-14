// Confirming a signature the server broadcast, from the browser, through the
// same-origin relay. Browser-safe; the RPC call is injected.
//
// WHY A HELPER. /api/solana-tx sends once and returns; it does not poll. A
// transaction that was sent but dropped stays "no status" forever unless the
// caller also watches the block height: once it passes the build's
// lastValidBlockHeight the blockhash can no longer land, and the honest answer
// is "expired — rebuild and sign again", not an endless spinner. Both calls this
// makes (getSignatureStatuses, getBlockHeight) are in the relay allowlist.

import { isSignature } from "./base58";

export type RpcCall = (method: string, params: readonly unknown[]) => Promise<unknown>;

export interface ConfirmOptions {
  /** One JSON-RPC call through /api/solana-rpc; resolves to `result`, rejects on an error. */
  readonly rpc: RpcCall;
  readonly signature: string;
  /** From the build: past this block height the transaction can no longer land. */
  readonly lastValidBlockHeight: number | bigint;
  /** Default "confirmed". */
  readonly commitment?: "confirmed" | "finalized";
  /** Default 1500 ms. */
  readonly pollMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly signal?: AbortSignal;
}

export type ConfirmOutcome =
  | { readonly status: "confirmed" | "finalized"; readonly slot: number }
  | { readonly status: "failed"; readonly slot: number; readonly err: unknown }
  | { readonly status: "expired"; readonly blockHeight: number };

interface SignatureStatus {
  readonly slot: number;
  readonly err: unknown;
  readonly confirmationStatus?: "processed" | "confirmed" | "finalized" | null;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function readStatus(result: unknown): SignatureStatus | null {
  const value = (result as { value?: unknown } | null)?.value;
  if (!Array.isArray(value)) throw new Error("getSignatureStatuses answered without a value array");
  const first = value[0] as SignatureStatus | null | undefined;
  return first ?? null;
}

function reached(status: SignatureStatus, commitment: "confirmed" | "finalized"): boolean {
  if (status.confirmationStatus === "finalized") return true;
  return commitment === "confirmed" && status.confirmationStatus === "confirmed";
}

export async function confirmSignature(options: ConfirmOptions): Promise<ConfirmOutcome> {
  if (!isSignature(options.signature)) throw new Error("confirmSignature: not a base58 64-byte signature");
  const commitment = options.commitment ?? "confirmed";
  const pollMs = options.pollMs ?? 1_500;
  const sleep = options.sleep ?? defaultSleep;
  const lastValid = BigInt(options.lastValidBlockHeight);

  const check = async (): Promise<ConfirmOutcome | null> => {
    const status = readStatus(await options.rpc("getSignatureStatuses", [[options.signature]]));
    if (status === null) return null;
    if (status.err !== null && status.err !== undefined) return { status: "failed", slot: status.slot, err: status.err };
    if (reached(status, commitment)) return { status: status.confirmationStatus === "finalized" ? "finalized" : "confirmed", slot: status.slot };
    return null;
  };

  for (;;) {
    options.signal?.throwIfAborted();
    const outcome = await check();
    if (outcome !== null) return outcome;
    const height = await options.rpc("getBlockHeight", [{ commitment: "confirmed" }]);
    if (typeof height !== "number" && typeof height !== "bigint") throw new Error("getBlockHeight answered without a number");
    if (BigInt(height) > lastValid) {
      // ONE LAST LOOK: it may have landed in the final valid block.
      const last = await check();
      return last ?? { status: "expired", blockHeight: Number(height) };
    }
    await sleep(pollMs);
  }
}
