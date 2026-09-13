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

import type { Secret } from "@sip/worker/log";

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
 */
export function poolFetch(
  urls: readonly Secret[],
  onFailover?: (message: string, fields: Record<string, unknown>) => void,
  timeoutMs = 30_000,
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

  return (async (_input: unknown, init?: RequestInit): Promise<Response> => {
    const refusals: string[] = [];
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
        refusals.push(`${at} ${error instanceof Error ? error.name : "unknown"}`);
        onFailover?.("solana endpoint set aside", { at, detail: error instanceof Error ? error.name : "unknown" });
        continue;
      }
      if (!response.ok) {
        downUntil.set(index, Date.now() + COOLDOWN_MS);
        refusals.push(`${at} HTTP ${response.status}`);
        onFailover?.("solana endpoint set aside", { at, detail: `HTTP ${response.status}` });
        continue;
      }
      downUntil.delete(index);
      return response;
    }
    throw new Error(`every Solana endpoint refused (${refusals.join("; ")})`);
  }) as typeof fetch;
}
