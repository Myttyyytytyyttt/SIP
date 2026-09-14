// More than one RPC endpoint, because one is a single point of failure for the
// whole product.
//
// Ported from the session engine of the project this was forked from (src/failover.ts (owner: rpc). Not)
// ported: the tracer capability probe — this worker measures volume from logs,
// receipts and balances, and no endpoint on 4663 serves debug/trace. Endpoints
// arrive as bare clients and are named by position, so an event can never
// carry a URL, and the key inside it, into a log.
//
// This is not hypothetical. A monthly capacity limit on the only endpoint took
// the old keeper down for hours: the chain was fine, the contracts were fine,
// and every user silently stopped saving.
//
// WHAT FAILS OVER AND WHAT DOES NOT. An endpoint is switched away from when it
// cannot answer — network failure, throttling, a 5xx, or a method it does not
// implement. It is NOT switched away from when it answers and the answer is
// unwelcome: a revert, a bad parameter, an invalid signature. Those are facts
// about the chain, identical everywhere, and retrying them elsewhere would turn
// a clear error into a confusing one while hiding a real bug.
//
// ORDER IS PREFERENCE, NOT ROUND ROBIN. The first endpoint is used until it
// fails; the next then serves until IT fails. There is no load balancing,
// because spreading a wei-exact scan across providers is how two half-answers
// get stitched into one wrong answer.
//
// A 429 IS ABSORBED BEFORE IT GETS HERE. httpRpcClient retries throttling with
// backoff (5 attempts, 250 ms doubling), so a capacity fault reaching this
// layer is sustained, not a blip. Switching on it is not "failover mid-sweep on
// one 429" (assessment §4.1); it is the outage the fallback exists for.

import { RpcError, withoutUrls } from "./client.js";
import type { RpcClient, RpcParams } from "../types.js";

export interface FailoverOptions {
  /** How long before the preferred endpoint is probed again after failing. */
  readonly probeAfterMs?: number;
  /** Injected for tests. */
  readonly now?: () => number;
  /**
   * Called when the serving endpoint changes, when the preferred one is back,
   * and when every endpoint has failed. This is the alerting hook: losing an
   * endpoint is survivable and losing all of them is an outage, and the two
   * must not look the same. Endpoints are identified by their position in the
   * list handed to failoverRpcClient — never by URL.
   */
  readonly onEvent?: (event: FailoverEvent) => void;
}

export type FailoverEvent =
  | { readonly kind: "SWITCHED"; readonly from: number; readonly to: number; readonly reason: string }
  | { readonly kind: "ALL_FAILED"; readonly method: string; readonly reason: string }
  | { readonly kind: "RECOVERED"; readonly to: number };

/**
 * A message that is the chain answering, whatever else it happens to contain.
 * Checked FIRST: a revert reason or a custom error name may well include
 * "limit" or "rate", and that must not read as a capacity fault.
 */
const IS_AN_ANSWER =
  /execution reverted|revert|invalid argument|invalid params|invalid opcode|insufficient funds|nonce too low|already known|replacement transaction|no fixture for/i;

/**
 * Whether an error means "this endpoint could not answer" rather than "the
 * answer is no".
 *
 * Deliberately conservative: anything unrecognised is treated as an ANSWER and
 * propagated. Failing over on a real error would mask it behind a second
 * endpoint giving the identical real error, one retry later.
 */
export function isEndpointFault(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (IS_AN_ANSWER.test(message)) return false;
  return (
    // Transport: fetch rejected, socket closed, DNS, TLS.
    /fetch failed|network|socket|ECONN|ETIMEDOUT|EAI_AGAIN|terminated/i.test(message) ||
    // Capacity: the case that actually took this system down.
    /rate|limit|throttl|capacity|busy|quota|exceeded|too many requests|429/i.test(message) ||
    // Server-side: the endpoint is unwell, the chain has said nothing.
    /HTTP 5\d\d|internal error|service unavailable|timeout|timed out|non-JSON response/i.test(message) ||
    // Capability: an endpoint that lacks a method cannot serve this worker at all.
    /does not exist|not available|unsupported method|method not found/i.test(message) ||
    // The scanner's own guard for a block an endpoint does not have.
    /returned null for block/i.test(message)
  );
}

const describeFault = (fault: unknown): string =>
  withoutUrls(fault instanceof Error ? fault.message : String(fault));

/**
 * A client that serves from the first endpoint that can answer.
 *
 * Every endpoint is tried once per call before giving up, so a single request
 * survives one endpoint dying mid-flight.
 *
 * AFTER A SWITCH IT STAYS SWITCHED, BUT NOT FOREVER. Retrying the preferred
 * endpoint on every call would spend one wasted call per request for the whole
 * outage — and a sweep issues one call per candidate block, so that is a
 * doubling of cost exactly when a provider is already unhappy. Never retrying
 * it is worse in a different way: a single blip would demote the good endpoint
 * permanently, and the fallback is a fallback because it is the lesser one. So
 * the preferred endpoint is probed again once `probeAfterMs` has passed, which
 * heals a capacity limit that resets without operator action and without
 * flapping: a failed probe re-arms the timer, it does not shorten it.
 */
export function failoverRpcClient(clients: readonly RpcClient[], options: FailoverOptions = {}): RpcClient {
  if (clients.length === 0) throw new Error("failoverRpcClient needs at least one endpoint.");

  const probeAfterMs = options.probeAfterMs ?? 60_000;
  const now = options.now ?? (() => Date.now());

  let serving = 0;
  /** When the preferred endpoint was last demoted, so it can be probed again later. */
  let demotedAt: number | null = null;

  return {
    async call<T>(method: string, params: RpcParams = []): Promise<T> {
      let lastFault: unknown;

      // Time to give the preferred endpoint another chance.
      if (serving !== 0 && demotedAt !== null && now() - demotedAt >= probeAfterMs) {
        serving = 0;
      }

      for (let hop = 0; hop < clients.length; hop += 1) {
        const index = (serving + hop) % clients.length;
        const client = clients[index];
        if (client === undefined) continue; // the list is non-empty; this is for noUncheckedIndexedAccess
        try {
          const result = await client.call<T>(method, params);
          if (index !== serving) {
            options.onEvent?.({ kind: "SWITCHED", from: serving, to: index, reason: describeFault(lastFault) });
            if (serving === 0) demotedAt = now();
            serving = index;
          }
          if (index === 0 && demotedAt !== null) {
            // The preferred endpoint answered after a demotion: back to normal.
            demotedAt = null;
            options.onEvent?.({ kind: "RECOVERED", to: 0 });
          }
          return result;
        } catch (error) {
          if (!isEndpointFault(error)) throw error; // an answer, not a fault
          lastFault = error;
        }
      }

      const reason = describeFault(lastFault);
      options.onEvent?.({ kind: "ALL_FAILED", method, reason });
      throw new RpcError(method, params, `all ${clients.length} endpoint(s) failed; last: ${reason}`);
    },
  };
}
