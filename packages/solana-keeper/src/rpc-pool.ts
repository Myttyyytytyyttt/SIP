// Several Solana endpoints behind one Connection, so a rate-limited provider
// does not stop the keeper.
//
// Ported from Nuvem's solana-lab keeper (keeper/src/rpc-pool.ts). What changed
// is WHERE THE LIST COMES FROM: Nuvem read five variables and always appended
// the public endpoint, so a keeper with none of them configured came up quietly
// on a throttled public node. SIP reads exactly one, SIP_SOLANA_RPC_URLS, in
// config.ts, and appends nothing: an operator who wants the public endpoint as
// the last resort lists it. The endpoints arrive as `Secret`s and are revealed
// only inside the request, because they carry API keys.
//
// WHY IT EXISTS AT ALL: one provider answering 429 took the website's entire
// read path down for a day. The keeper reads the chain on every sweep and
// writes on every settlement; it has strictly more to lose from one endpoint
// than a page load does.
//
// RETRYING A SEND IS SAFE. A Solana transaction is identified by its signature,
// so the same signed bytes arriving at two endpoints is one transaction, not
// two. That is what makes this sound underneath a keeper that moves money —
// and it is the reason this replaces the TRANSPORT rather than wrapping
// individual calls, which would have to reason about each one.

import type { Secret } from "@sip/solana-log";
import { RETRY_AFTER_HONOUR_MAX_MS, currentRpcContext, retryAfterMs, type RpcBudget } from "./rpc-budget.js";
import type { RpcMeter } from "./rpc-usage.js";

const COOLDOWN_MS = 30_000;

/** How an endpoint is named anywhere outside this function: its position, never its URL. */
export const endpointLabel = (index: number, total: number): string => `endpoint ${index + 1}/${total}`;

/**
 * A `fetch` for @solana/web3.js `Connection`.
 *
 * Connection takes ONE endpoint and threads it through every call it makes;
 * this replaces the transport underneath instead, ignoring the URL it was
 * constructed with. Anchor, the settle path and the invest path all inherit the
 * failover without a line of their own.
 *
 * `onFailover` reports which endpoint was set aside and why, so a silent
 * degradation shows up in the keeper's log rather than only in a latency graph.
 *
 * `onAnswer` reports which endpoint ANSWERED, which is the other half of that
 * question and the half /status needs: after a failover the keeper is quietly
 * running on a different provider, with different latency and a different rate
 * limit, and until this existed the only record of which one was a warning line
 * that had scrolled away. BY LABEL, NEVER BY URL — the URLs carry API keys, and
 * `endpointLabel` is the only name they get outside the request itself.
 *
 * NEITHER CALLBACK DECIDES ANYTHING. They are told what already happened, after
 * the choice of endpoint has been made and, for `onAnswer`, after the response
 * is in hand; a caller that throws from one breaks its own request and changes
 * no routing.
 *
 * `meter` IS TOLD THE SAME KIND OF THING, AND MORE QUIETLY (src/rpc-usage.ts):
 * the request it was handed — the JSON-RPC body is the only place the method is
 * written, so a per-method count can only be taken here — and how each attempt
 * at each endpoint ended. Unlike the two callbacks it CANNOT break a request:
 * every report to it is made inside a try of its own, because a meter is
 * instrumentation, and instrumentation that can fail a settle's send is an
 * outage it caused. Omitted, the pool behaves exactly as it did before it had
 * one; bin/ready.mts and the policy CLI pass none.
 *
 * `budget` IS THE DISPATCHER'S, AND ONLY THE DISPATCHER'S (src/rpc-budget.ts,
 * ADR §3.9). Given one, every attempt first waits for its tokens in its lane, a
 * 429 halves the process's rate, a `Retry-After` of at most 2 s is waited out on
 * the same endpoint once before the endpoint is set aside, and a job's signal
 * (withRpcLane) ends both the wait and the request. OMITTED — as every legacy
 * caller omits it: bin/keeper.mts, bin/ready.mts and the policy CLI — the pool
 * is the function below the `budget` branch, line for line what it was before
 * the budget existed, with no await added before any request
 * (test/rpc-budget-parity.test.ts).
 */
export function poolFetch(
  urls: readonly Secret[],
  onFailover?: (message: string, fields: Record<string, unknown>) => void,
  timeoutMs = 30_000,
  onAnswer?: (at: string) => void,
  meter?: RpcMeter,
  budget?: RpcBudget,
): typeof fetch {
  // Per pool and keyed by POSITION, so the cooldown table holds no URL either.
  const downUntil = new Map<number, number>();

  const usable = (): readonly number[] => {
    const now = Date.now();
    const all = urls.map((_, index) => index);
    const live = all.filter((index) => (downUntil.get(index) ?? 0) <= now);
    // A total outage and a total cooldown look identical from here, and calling
    // nobody guarantees the failure that calling everybody only risks.
    return live.length > 0 ? live : all;
  };

  /** A report to the meter that can only ever be lost, never thrown. */
  const metered = (report: (meter: RpcMeter) => void): void => {
    if (meter === undefined) return;
    try {
      report(meter);
    } catch {
      // The request goes on, counted or not.
    }
  };

  if (budget !== undefined) {
    return budgetedPoolFetch({ urls, onFailover, timeoutMs, onAnswer, metered, usable, downUntil, budget });
  }

  return (async (_input: unknown, init?: RequestInit): Promise<Response> => {
    const refusals: string[] = [];
    // COUNTED ONCE, BEFORE ANY ENDPOINT IS TRIED: what the keeper ASKED for,
    // whichever endpoint answers and whether any does. The attempts below say
    // where it went.
    metered((m) => m.request(init?.body));
    for (const index of usable()) {
      const at = endpointLabel(index, urls.length);
      let response: Response;
      try {
        response = await fetch(urls[index]!.reveal(), {
          method: init?.method ?? "POST",
          headers: init?.headers ?? { "content-type": "application/json" },
          body: typeof init?.body === "string" ? init.body : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        // NEVER THE URL, AND NOT EVEN THE MESSAGE: undici's messages can quote
        // the host and the request. The error's NAME says timeout vs refused.
        downUntil.set(index, Date.now() + COOLDOWN_MS);
        metered((m) => m.attempt(at, "unreachable"));
        refusals.push(`${at} ${error instanceof Error ? error.name : "unknown"}`);
        onFailover?.("solana endpoint set aside", { at, detail: error instanceof Error ? error.name : "unknown" });
        continue;
      }
      metered((m) => m.attempt(at, response.status));
      if (!response.ok) {
        downUntil.set(index, Date.now() + COOLDOWN_MS);
        refusals.push(`${at} HTTP ${response.status}`);
        onFailover?.("solana endpoint set aside", { at, detail: `HTTP ${response.status}` });
        continue;
      }
      downUntil.delete(index);
      onAnswer?.(at);
      return response;
    }
    throw new Error(`every Solana endpoint refused (${refusals.join("; ")})`);
  }) as typeof fetch;
}

/** What poolFetch hands its budgeted twin: the same endpoints, callbacks, meter and cooldown table. */
interface BudgetedPool {
  readonly urls: readonly Secret[];
  readonly onFailover: ((message: string, fields: Record<string, unknown>) => void) | undefined;
  readonly timeoutMs: number;
  readonly onAnswer: ((at: string) => void) | undefined;
  readonly metered: (report: (meter: RpcMeter) => void) => void;
  readonly usable: () => readonly number[];
  readonly downUntil: Map<number, number>;
  readonly budget: RpcBudget;
}

/**
 * The pool with a budget: the same endpoints in the same order, the same
 * cooldown, the same reports — and three differences, each the ADR's (§3.9):
 *
 *   * EVERY ATTEMPT WAITS FOR ITS TOKENS FIRST, in the lane its async context
 *     names (withRpcLane), so a dispatcher process asks its provider for no
 *     more than its quota — a second's burst aside. A failover attempt takes
 *     tokens too: it is another request the provider sees.
 *   * A 429 IS TOLD TO THE BUDGET, which halves the rate, and a `Retry-After` of
 *     at most RETRY_AFTER_HONOUR_MAX_MS is waited out on the SAME endpoint, once,
 *     before that endpoint is set aside — a provider that names a short wait is
 *     not down, and moving to the fallback would trade its answer for a slower
 *     one. Past 2 s, or without the header, the endpoint is set aside exactly as
 *     without a budget. The retry carries the same body, so a retried send is the
 *     same signed bytes (the header's RETRYING A SEND IS SAFE).
 *   * A JOB'S SIGNAL (the worker's 6-minute ceiling) ends the wait for tokens and
 *     the request in flight, and is rethrown as itself: a job that ran out of
 *     time is not an endpoint that failed, so no endpoint is set aside for it.
 */
function budgetedPoolFetch(pool: BudgetedPool): typeof fetch {
  const { urls, onFailover, timeoutMs, onAnswer, metered, usable, downUntil, budget } = pool;
  return (async (_input: unknown, init?: RequestInit): Promise<Response> => {
    const refusals: string[] = [];
    const signal = currentRpcContext()?.signal;
    metered((m) => m.request(init?.body));
    let first = true;
    for (const index of usable()) {
      const at = endpointLabel(index, urls.length);
      let response: Response | null = null;
      let retriedHere = false;
      for (;;) {
        const permit = await budget.admit(init?.body, { first });
        first = false;
        try {
          const timeout = AbortSignal.timeout(timeoutMs);
          response = await fetch(urls[index]!.reveal(), {
            method: init?.method ?? "POST",
            headers: init?.headers ?? { "content-type": "application/json" },
            body: typeof init?.body === "string" ? init.body : undefined,
            signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]),
          });
        } catch (error) {
          budget.answered(permit, "unreachable");
          if (signal?.aborted === true) throw signal.reason ?? error;
          downUntil.set(index, Date.now() + COOLDOWN_MS);
          metered((m) => m.attempt(at, "unreachable"));
          refusals.push(`${at} ${error instanceof Error ? error.name : "unknown"}`);
          onFailover?.("solana endpoint set aside", { at, detail: error instanceof Error ? error.name : "unknown" });
          response = null;
          break;
        }
        budget.answered(permit, response.status);
        if (response.status === 429 && !retriedHere) {
          const wait = retryAfterMs(response.headers.get("retry-after"), Date.now());
          if (wait !== null && wait <= RETRY_AFTER_HONOUR_MAX_MS) {
            retriedHere = true;
            metered((m) => m.attempt(at, 429));
            void response.body?.cancel().catch(() => undefined);
            await budget.pause(wait, signal);
            continue;
          }
        }
        break;
      }
      if (response === null) continue;
      const answer = response;
      metered((m) => m.attempt(at, answer.status));
      if (!answer.ok) {
        downUntil.set(index, Date.now() + COOLDOWN_MS);
        refusals.push(`${at} HTTP ${answer.status}`);
        onFailover?.("solana endpoint set aside", { at, detail: `HTTP ${answer.status}` });
        continue;
      }
      downUntil.delete(index);
      onAnswer?.(at);
      return answer;
    }
    throw new Error(`every Solana endpoint refused (${refusals.join("; ")})`);
  }) as typeof fetch;
}
