// More than one RPC endpoint, because one is a single point of failure for the
// whole product.
//
// This is not hypothetical. A monthly capacity limit on the only endpoint took
// the keeper down for hours: `debug_traceTransaction` is a hard dependency, so
// without it no session can be measured and nothing is ever saved. The chain was
// fine, the contracts were fine, and every user silently stopped saving.
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

import { RpcError, type RpcClient, type RpcParams } from "./rpc.js";

export interface FailoverEndpoint {
  /** Human-readable, for logs and alerts. Must never contain the API key. */
  readonly name: string;
  readonly client: RpcClient;
}

export interface FailoverOptions {
  /** How long before the preferred endpoint is probed again after failing. */
  readonly probeAfterMs?: number;
  /** Injected for tests. */
  readonly now?: () => number;
  /**
   * Called when the serving endpoint changes, and when every endpoint has
   * failed. This is the alerting hook: losing an endpoint is survivable and
   * losing all of them is an outage, and the two must not look the same.
   */
  readonly onEvent?: (event: FailoverEvent) => void;
}

export type FailoverEvent =
  | { readonly kind: "SWITCHED"; readonly from: string; readonly to: string; readonly reason: string }
  | { readonly kind: "ALL_FAILED"; readonly method: string; readonly reason: string }
  | { readonly kind: "RECOVERED"; readonly to: string };

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
  return (
    // Transport: fetch rejected, socket closed, DNS, TLS.
    /fetch failed|network|socket|ECONN|ETIMEDOUT|EAI_AGAIN|terminated/i.test(message) ||
    // Capacity: the case that actually took this system down.
    /rate|limit|throttl|capacity|busy|quota|exceeded|too many requests|429/i.test(message) ||
    // Server-side: the endpoint is unwell, the chain has said nothing.
    /HTTP 5\d\d|internal error|service unavailable|timeout|timed out/i.test(message) ||
    // Capability: an endpoint without the tracer cannot serve this engine at all.
    /does not exist|not available|unsupported method|method not found/i.test(message) ||
    // The scanner's own guard for a block an endpoint does not have.
    /returned null for block/i.test(message)
  );
}

export interface EndpointCapability {
  readonly name: string;
  /** Answers ordinary reads: balances, nonces, logs, blocks. */
  readonly reads: boolean;
  /**
   * Answers `debug_traceTransaction`. WITHOUT THIS AN ENDPOINT CANNOT MEASURE A
   * SESSION AT ALL — the GMGN router unwraps WETH and forwards native ETH by
   * internal call, with no log and no top-level transaction, so the tracer is
   * the only source of sell proceeds.
   */
  readonly traces: boolean;
}

/**
 * What each endpoint can actually do, asked once at startup.
 *
 * A fallback that serves reads but not traces is REAL but PARTIAL cover: it
 * keeps discovery and status alive while making settlement impossible. Left
 * unstated that reads as full redundancy, and the difference only becomes
 * apparent during the outage it was supposed to cover.
 */
export async function probeEndpoints(
  endpoints: readonly FailoverEndpoint[],
  /** Any mined transaction hash. Its content is irrelevant; only support is. */
  sampleTxHash: string,
): Promise<EndpointCapability[]> {
  const results: EndpointCapability[] = [];
  for (const endpoint of endpoints) {
    let reads = false;
    let traces = false;
    try {
      await endpoint.client.call<string>("eth_blockNumber", []);
      reads = true;
    } catch {
      reads = false;
    }
    try {
      await endpoint.client.call<unknown>("debug_traceTransaction", [
        sampleTxHash,
        { tracer: "callTracer" },
      ]);
      traces = true;
    } catch (error) {
      // Only a MISSING METHOD means no tracer. Any other failure — an unknown
      // hash, a timeout — says nothing about capability, and reporting it as
      // "cannot trace" would condemn a perfectly good endpoint.
      const message = error instanceof Error ? error.message : String(error);
      traces = !/does not exist|not available|unsupported method|method not found/i.test(message);
    }
    results.push({ name: endpoint.name, reads, traces });
  }
  return results;
}

/**
 * A client that serves from the first endpoint that can answer.
 *
 * Every endpoint is tried once per call before giving up, so a single request
 * survives one endpoint dying mid-flight.
 *
 * AFTER A SWITCH IT STAYS SWITCHED, BUT NOT FOREVER. Retrying the preferred
 * endpoint on every call would spend one wasted call per request for the whole
 * outage — and a scan issues one call per block, so that is a doubling of cost
 * exactly when a provider is already unhappy. Never retrying it is worse in a
 * different way: a single blip would demote the good endpoint permanently, and
 * the fallback is a fallback because it is the lesser one. So the preferred
 * endpoint is probed again once `probeAfterMs` has passed, which heals a
 * capacity limit that resets without operator action and without flapping.
 */
export function failoverRpcClient(
  endpoints: readonly FailoverEndpoint[],
  options: FailoverOptions = {},
): RpcClient {
  if (endpoints.length === 0) throw new Error("failoverRpcClient needs at least one endpoint.");

  const probeAfterMs = options.probeAfterMs ?? 60_000;
  const now = options.now ?? (() => Date.now());

  let serving = 0;
  let degraded = false;
  /** When the preferred endpoint last failed, so it can be probed again later. */
  let demotedAt: number | null = null;

  return {
    async call<T>(method: string, params: RpcParams = []): Promise<T> {
      let lastFault: unknown;

      // Time to give the preferred endpoint another chance.
      if (serving !== 0 && demotedAt !== null && now() - demotedAt >= probeAfterMs) {
        serving = 0;
        demotedAt = null;
      }

      for (let hop = 0; hop < endpoints.length; hop += 1) {
        const index = (serving + hop) % endpoints.length;
        const endpoint = endpoints[index]!;
        try {
          const result = await endpoint.client.call<T>(method, params);
          if (index !== serving) {
            const from = endpoints[serving]!.name;
            if (serving === 0) demotedAt = now();
            serving = index;
            options.onEvent?.({
              kind: "SWITCHED",
              from,
              to: endpoint.name,
              reason: lastFault instanceof Error ? lastFault.message : String(lastFault),
            });
          } else if (degraded) {
            degraded = false;
            options.onEvent?.({ kind: "RECOVERED", to: endpoint.name });
          }
          return result;
        } catch (error) {
          if (!isEndpointFault(error)) throw error; // an answer, not a fault
          lastFault = error;
          degraded = true;
        }
      }

      const reason = lastFault instanceof Error ? lastFault.message : String(lastFault);
      options.onEvent?.({ kind: "ALL_FAILED", method, reason });
      throw new RpcError(
        method,
        params,
        `all ${endpoints.length} endpoint(s) failed; last: ${reason}`,
      );
    },
  };
}
