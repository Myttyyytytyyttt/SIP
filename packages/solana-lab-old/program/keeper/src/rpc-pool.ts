// Several Solana endpoints behind one Connection, so a rate-limited provider
// does not stop the keeper.
//
// WHY THE LAB CARRIES ITS OWN COPY. packages/solana-core-old has an equivalent
// module, but solana-lab is deliberately outside the pnpm workspace (PLAN.md
// §"el laboratorio"), so importing across that boundary would tie the lab's
// build to the product's. Same reasoning as read-model.ts. The shared thing is
// the ENV CONTRACT — NUVEM_SOLANA_RPC_URL, then NUVEM_SOLANA_RPC_URL2, then the
// public endpoint — not the code.
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

const COOLDOWN_MS = 30_000;

export const PUBLIC_SOLANA_RPC = "https://api.mainnet-beta.solana.com";

/**
 * The endpoints to try, in order.
 *
 * Accepts the keeper's own NUVEM_SOLANA_MAINNET_RPC and ANCHOR_PROVIDER_URL as
 * first choices too, because that is what this process has always been
 * configured with and a rename is not worth an outage.
 */
export function keeperRpcUrls(env: NodeJS.ProcessEnv): readonly string[] {
  const out: string[] = [];
  for (const raw of [
    env.NUVEM_SOLANA_MAINNET_RPC,
    env.NUVEM_SOLANA_RPC_URL,
    env.ANCHOR_PROVIDER_URL,
    env.NUVEM_SOLANA_RPC_URL2,
    env.NUVEM_SOLANA_MAINNET_RPC2,
    PUBLIC_SOLANA_RPC,
  ]) {
    const url = raw?.trim();
    if (url === undefined || url === "") continue;
    if (!/^https?:\/\//i.test(url)) continue;
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

const downUntil = new Map<string, number>();

const usable = (urls: readonly string[]): readonly string[] => {
  const now = Date.now();
  const live = urls.filter((url) => (downUntil.get(url) ?? 0) <= now);
  // A total outage and a total cooldown look identical from here, and calling
  // nobody guarantees the failure that calling everybody only risks.
  return live.length > 0 ? live : urls;
};

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
  urls: readonly string[],
  onFailover?: (message: string, fields: Record<string, unknown>) => void,
  timeoutMs = 30_000,
): typeof fetch {
  return (async (_input: unknown, init?: RequestInit): Promise<Response> => {
    const refusals: string[] = [];
    for (const url of usable(urls)) {
      const at = `endpoint ${urls.indexOf(url) + 1}/${urls.length}`;
      let response: Response;
      try {
        response = await fetch(url, {
          method: init?.method ?? "POST",
          headers: init?.headers ?? { "content-type": "application/json" },
          body: typeof init?.body === "string" ? init.body : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        // NEVER THE URL. These carry API keys in their query string.
        downUntil.set(url, Date.now() + COOLDOWN_MS);
        refusals.push(`${at} ${error instanceof Error ? error.name : "unknown"}`);
        onFailover?.("solana endpoint set aside", { at, detail: error instanceof Error ? error.name : "unknown" });
        continue;
      }
      if (!response.ok) {
        downUntil.set(url, Date.now() + COOLDOWN_MS);
        refusals.push(`${at} HTTP ${response.status}`);
        onFailover?.("solana endpoint set aside", { at, detail: `HTTP ${response.status}` });
        continue;
      }
      downUntil.delete(url);
      return response;
    }
    throw new Error(`every Solana endpoint refused (${refusals.join("; ")})`);
  }) as typeof fetch;
}
