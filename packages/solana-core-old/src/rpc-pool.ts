// One Solana RPC call, several endpoints, and a rule for when to give up on one.
//
// WHY THIS EXISTS. nuvem.fund spent a day answering "the vault could not be
// read" because its single RPC endpoint was returning 429 to every request,
// while the same endpoint answered instantly from a laptop. One rate-limited
// provider took the whole product's read path down, and nothing in the app
// could route around it. A read path with one endpoint is a read path with one
// point of failure, and this is a product whose entire front page is reads.
//
// THE ORDER IS THE OPERATOR'S, and the public endpoint is genuinely last: it
// refuses getProgramAccounts for most callers and rate-limits cloud egress hard,
// so it is a way to keep showing SOMETHING rather than a peer of the others.
//
// WHAT IT WILL NOT DO is treat an ANSWER as a failure. A JSON-RPC error that
// says "invalid param" is the endpoint working correctly; asking three more
// providers the same malformed question wastes three more providers' quota and
// hides the bug. Only transport failures, HTTP rejections, and the specific
// JSON-RPC errors that mean "not from me" (rate limits, unsupported methods)
// move to the next endpoint.

/** Where a failing endpoint sits out before it is tried again. */
const COOLDOWN_MS = 30_000;

/**
 * The public endpoint, and the reason it is only ever last.
 *
 * It rejects getProgramAccounts for most callers and throttles server traffic
 * aggressively — good enough to keep a balance on screen, not good enough to
 * run on. Included because "degraded" beats "blank".
 */
export const PUBLIC_SOLANA_RPC = "https://api.mainnet-beta.solana.com";

/**
 * The endpoints to try, in order: the operator's first choice, their second,
 * then the public one.
 *
 * DEDUPED AND ORDER-PRESERVING, so setting both variables to the same URL does
 * not silently halve the retry budget into two attempts at one dead host.
 */
export function solanaRpcUrls(env: NodeJS.ProcessEnv): readonly string[] {
  const out: string[] = [];
  for (const raw of [env.NUVEM_SOLANA_RPC_URL, env.NUVEM_SOLANA_RPC_URL2, PUBLIC_SOLANA_RPC]) {
    const url = raw?.trim();
    if (url === undefined || url === "") continue;
    if (!/^https?:\/\//i.test(url)) continue;
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

/** Failing endpoints sit out, so a dead primary is not re-tried on every call. */
const downUntil = new Map<string, number>();

const usable = (urls: readonly string[]): readonly string[] => {
  const now = Date.now();
  const live = urls.filter((url) => (downUntil.get(url) ?? 0) <= now);
  // ALL OF THEM IN COOLDOWN IS NOT A REASON TO STOP TRYING. A total outage and
  // a total cooldown look identical from here, and refusing to call anyone
  // guarantees the failure that retrying only risks.
  return live.length > 0 ? live : urls;
};

/**
 * Whether a JSON-RPC error means "ask someone else" rather than "your request
 * was wrong".
 *
 * Providers signal exhaustion at the JSON layer as often as at the HTTP one —
 * a 200 carrying `{error: {code: -32005}}` is a rate limit wearing a success
 * status — and the public endpoint reports its disabled methods this way too.
 */
function isEndpointFault(error: { code?: number; message?: string } | undefined): boolean {
  if (error === undefined) return false;
  if (error.code === -32005 || error.code === -32004) return true;
  const message = (error.message ?? "").toLowerCase();
  return (
    message.includes("rate limit") ||
    message.includes("too many requests") ||
    message.includes("exceeded") ||
    message.includes("is not supported") ||
    message.includes("unsupported") ||
    message.includes("disabled") ||
    message.includes("excluded from account secondary indexes")
  );
}

interface Attempt {
  readonly ok: boolean;
  readonly body?: unknown;
  readonly why?: string;
}

async function post(url: string, payload: unknown, timeoutMs: number): Promise<Attempt> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // NEVER THE URL IN A MESSAGE. These endpoints carry API keys in their query
    // string and these strings reach the browser.
    return { ok: false, why: error instanceof Error ? error.name : "unknown error" };
  }
  if (!response.ok) return { ok: false, why: `HTTP ${response.status}` };
  try {
    return { ok: true, body: await response.json() };
  } catch {
    return { ok: false, why: "the response was not JSON" };
  }
}

/** Marks an endpoint as sitting out, and says which one for the log. */
const benched = (url: string, urls: readonly string[]): string => {
  downUntil.set(url, Date.now() + COOLDOWN_MS);
  return `endpoint ${urls.indexOf(url) + 1}/${urls.length}`;
};

/**
 * One JSON-RPC call, across the pool.
 *
 * Throws only when EVERY endpoint refused, and the message names each one by
 * position and reason — never by URL.
 */
export async function poolRpc(
  urls: readonly string[],
  method: string,
  params: unknown[],
  timeoutMs = 20_000,
): Promise<unknown> {
  if (urls.length === 0) throw new Error(`RPC ${method}: no Solana endpoint is configured`);
  const refusals: string[] = [];
  for (const url of usable(urls)) {
    const attempt = await post(url, { jsonrpc: "2.0", id: 1, method, params }, timeoutMs);
    if (!attempt.ok) {
      refusals.push(`${benched(url, urls)} ${attempt.why}`);
      continue;
    }
    const body = attempt.body as { result?: unknown; error?: { code?: number; message?: string } };
    if (body.error !== undefined) {
      if (isEndpointFault(body.error)) {
        refusals.push(`${benched(url, urls)} ${body.error.message ?? "refused"}`);
        continue;
      }
      // A real answer: the request was wrong, and every other endpoint would
      // say so too.
      throw new Error(`RPC ${method}: ${body.error.message ?? "unknown error"}`);
    }
    downUntil.delete(url);
    return body.result;
  }
  throw new Error(`RPC ${method} was refused by every endpoint (${refusals.join("; ")})`);
}

/**
 * A JSON-RPC BATCH across the pool: many calls, one round trip, same failover.
 *
 * Returns the raw member array. Order is not promised by the protocol, so
 * callers match on `id` — see solana-activity.ts.
 */
export async function poolRpcBatch(
  urls: readonly string[],
  payload: readonly { id: number; method: string; params: unknown[] }[],
  timeoutMs = 20_000,
): Promise<readonly { id?: number; result?: unknown; error?: { message?: string } }[]> {
  if (payload.length === 0) return [];
  if (urls.length === 0) throw new Error("RPC batch: no Solana endpoint is configured");
  const body = payload.map((p) => ({ jsonrpc: "2.0", ...p }));
  const refusals: string[] = [];
  for (const url of usable(urls)) {
    const attempt = await post(url, body, timeoutMs);
    if (!attempt.ok) {
      refusals.push(`${benched(url, urls)} ${attempt.why}`);
      continue;
    }
    // A batch answered with a single object rather than an array is either a
    // top-level error or a provider that does not do batching — both are
    // reasons to try the next endpoint, not to read it as "no results".
    if (!Array.isArray(attempt.body)) {
      const single = attempt.body as { error?: { code?: number; message?: string } };
      refusals.push(`${benched(url, urls)} ${single.error?.message ?? "did not answer a batch"}`);
      continue;
    }
    const members = attempt.body as { id?: number; result?: unknown; error?: { code?: number; message?: string } }[];
    // If the WHOLE batch came back as endpoint faults, this endpoint is out of
    // budget rather than the request being wrong.
    if (members.length > 0 && members.every((m) => isEndpointFault(m.error))) {
      refusals.push(`${benched(url, urls)} ${members[0]?.error?.message ?? "refused every member"}`);
      continue;
    }
    downUntil.delete(url);
    return members;
  }
  throw new Error(`RPC batch was refused by every endpoint (${refusals.join("; ")})`);
}

/**
 * A `fetch` for @solana/web3.js `Connection`, so Anchor and the keeper get the
 * same failover without a line of their own.
 *
 * Connection takes ONE endpoint and threads it through every call it makes;
 * this replaces the transport underneath it instead, ignoring the URL the
 * Connection was constructed with. That keeps the failover in one file rather
 * than scattered across every `program.methods.…` call site.
 *
 * SENDING IS SAFE TO RETRY: a Solana transaction is identified by its
 * signature, so the same signed bytes arriving at two endpoints is one
 * transaction, not two. That is what makes this sound for a keeper that writes.
 */
export function poolFetch(urls: readonly string[], timeoutMs = 30_000): typeof fetch {
  return (async (_input: unknown, init?: RequestInit): Promise<Response> => {
    const payload = typeof init?.body === "string" ? init.body : "";
    const refusals: string[] = [];
    for (const url of usable(urls)) {
      let response: Response;
      try {
        response = await fetch(url, {
          method: init?.method ?? "POST",
          headers: init?.headers ?? { "content-type": "application/json" },
          body: payload,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        refusals.push(`${benched(url, urls)} ${error instanceof Error ? error.name : "unknown"}`);
        continue;
      }
      if (!response.ok) {
        refusals.push(`${benched(url, urls)} HTTP ${response.status}`);
        continue;
      }
      downUntil.delete(url);
      return response;
    }
    throw new Error(`Solana RPC refused by every endpoint (${refusals.join("; ")})`);
  }) as typeof fetch;
}
