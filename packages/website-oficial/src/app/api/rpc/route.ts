/**
 * A deliberately narrow JSON-RPC relay, and the ONLY reason it exists:
 *
 * A wallet asked to add chain 4663 (wallet_addEthereumChain, which fires because
 * MetaMask has never seen this chain) needs an RPC URL it can reach from the
 * user's browser. The configured upstream carries an Alchemy API key, so handing
 * that URL to the wallet would publish the key to every visitor. This route gives
 * the wallet a same-origin endpoint instead and keeps the key on the server.
 * Ported from the Nuvem dashboard's src/app/api/rpc/route.ts (HEAD fd927b0),
 * with the per-IP token bucket HEAD documented as missing.
 *
 * NO PAGE READ COMES THROUGH HERE. Those run server-side in /api/vault and
 * /api/create-vault, against the upstream directly.
 *
 * HONEST LIMITS. This is an unauthenticated relay in front of a metered endpoint.
 * The method allowlist below removes the expensive and dangerous surface
 * (debug_*, trace_*, admin_*, personal_*, subscriptions, filters), body and
 * batch sizes are capped, and each client IP gets 60 requests a minute from an
 * in-memory bucket. That bucket is PER PROCESS: two replicas are two buckets,
 * and a restart is a refill. If that matters for your deployment, do one of:
 *   - set NUVEM_PUBLIC_RPC_URL to a key-free public endpoint, which switches this
 *     relay off entirely; or
 *   - set NUVEM_DISABLE_RPC_PROXY=1 TOGETHER WITH a public endpoint — on its own
 *     it leaves the browser with no RPC at all, which loadConfig now refuses; or
 *   - put a rate limiter in front of /api/rpc at your edge.
 */

import { loadConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

/**
 * Everything a wallet needs to treat chain 4663 as a normal network: identity,
 * balances, nonce, fees, gas estimation, broadcast, receipts, and reads. Nothing
 * else. Note eth_sendRawTransaction is included because a wallet using this as
 * its network endpoint must be able to broadcast — the transaction is already
 * signed by the user, so relaying it grants no authority.
 */
const ALLOWED_METHODS: ReadonlySet<string> = new Set([
  "eth_chainId",
  "net_version",
  "web3_clientVersion",
  "eth_blockNumber",
  "eth_getBalance",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_getTransactionCount",
  "eth_call",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getLogs",
  "eth_sendRawTransaction",
  "eth_syncing",
]);

const MAX_BODY_BYTES = 128 * 1024;
const MAX_BATCH = 20;

// ---------------------------------------------------------------------------
// Per-IP token bucket: 60 requests a minute, refilled continuously.
// ---------------------------------------------------------------------------

const BUCKET_CAPACITY = 60;
const REFILL_PER_MS = BUCKET_CAPACITY / 60_000;
/** An address idle this long is forgotten, so the map cannot grow without bound. */
const BUCKET_IDLE_MS = 5 * 60_000;
/** Sweep idle buckets every N requests rather than on a timer — no handle to leak. */
const SWEEP_EVERY = 256;

interface Bucket {
  tokens: number;
  updatedAt: number;
}

const buckets = new Map<string, Bucket>();
let requestsSinceSweep = 0;

/**
 * The address the request came from — and WHY `x-forwarded-for` is the last
 * thing consulted rather than the first.
 *
 * `x-forwarded-for` is appended to, not replaced, so its first entry is
 * whatever the CLIENT sent. A caller who rotates that header gets a fresh
 * bucket per request and the limit stops existing. The headers below are the
 * other kind: each is written by the edge that terminates the connection, from
 * the socket it sees, overwriting anything the client sent. Railway (Envoy)
 * sets `x-envoy-external-address`; the rest are here so a move to Cloudflare,
 * Vercel or Fly does not silently re-open the hole. `x-real-ip` is last of
 * them because it is a convention rather than one platform's guarantee.
 *
 * THE ASSUMPTION, STATED: this trusts those names because the deployment is
 * behind exactly one of those edges. Run this process with a port exposed
 * directly to the internet and a client can set any of them — as it can set
 * `x-forwarded-for` today. The relay is not the last line of defence for that
 * deployment; an edge rate limit is.
 *
 * When nothing is set, every caller shares one bucket — which throttles a
 * misconfigured deployment rather than leaving it open, and is the right way
 * round.
 */
const TRUSTED_CLIENT_IP_HEADERS = [
  "cf-connecting-ip",
  "x-vercel-forwarded-for",
  "x-envoy-external-address",
  "fly-client-ip",
  "true-client-ip",
  "x-real-ip",
] as const;

function clientKey(request: Request): string {
  for (const name of TRUSTED_CLIENT_IP_HEADERS) {
    const value = request.headers.get(name)?.trim();
    if (value !== undefined && value !== "") return value;
  }
  const first = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (first !== undefined && first !== "") return first;
  return "unknown";
}

/** Takes one token for `key`. Returns how many ms until one is available, or 0 when taken. */
function take(key: string, now: number): number {
  requestsSinceSweep += 1;
  if (requestsSinceSweep >= SWEEP_EVERY) {
    requestsSinceSweep = 0;
    for (const [other, bucket] of buckets) {
      if (now - bucket.updatedAt > BUCKET_IDLE_MS) buckets.delete(other);
    }
  }
  const bucket = buckets.get(key) ?? { tokens: BUCKET_CAPACITY, updatedAt: now };
  bucket.tokens = Math.min(BUCKET_CAPACITY, bucket.tokens + (now - bucket.updatedAt) * REFILL_PER_MS);
  bucket.updatedAt = now;
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    buckets.set(key, bucket);
    return 0;
  }
  buckets.set(key, bucket);
  return Math.ceil((1 - bucket.tokens) / REFILL_PER_MS);
}

function rpcError(status: number, code: number, message: string, id: unknown = null, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extraHeaders },
  });
}

interface RpcCall {
  readonly method?: unknown;
  readonly id?: unknown;
}

export async function POST(request: Request): Promise<Response> {
  const load = loadConfig(process.env, { needPrivyAppId: false });
  if (!load.ok) {
    return rpcError(503, -32000, "This deployment is not configured: no upstream RPC is set.");
  }
  const config = load.config;

  if (config.rpcProxyDisabled) {
    return rpcError(404, -32601, "The RPC relay is disabled on this deployment (NUVEM_DISABLE_RPC_PROXY).");
  }
  if (!config.rpcRelayInUse) {
    return rpcError(404, -32601, "The RPC relay is off because NUVEM_PUBLIC_RPC_URL is set — use that endpoint directly.");
  }

  // Throttled BEFORE the body is read, so a flood costs this process a header
  // lookup and nothing else.
  const waitMs = take(clientKey(request), Date.now());
  if (waitMs > 0) {
    const retryAfter = String(Math.max(1, Math.ceil(waitMs / 1000)));
    return rpcError(429, -32005, `Rate limit: ${BUCKET_CAPACITY} requests a minute per client. Retry in ${retryAfter} s.`, null, {
      "retry-after": retryAfter,
    });
  }

  // Content-Length FIRST, so an oversized body is refused without being read;
  // then the actual byte count, because a declared length is a claim and
  // `String.length` counts UTF-16 units — a body of multi-byte characters is
  // larger in bytes than in characters, which is the direction that matters.
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return rpcError(413, -32600, `Request body exceeds ${MAX_BODY_BYTES} bytes.`);
  }
  const raw = await request.arrayBuffer();
  if (raw.byteLength > MAX_BODY_BYTES) {
    return rpcError(413, -32600, `Request body exceeds ${MAX_BODY_BYTES} bytes.`);
  }
  const text = new TextDecoder().decode(raw);

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return rpcError(400, -32700, "Parse error: body is not valid JSON.");
  }

  const calls: RpcCall[] = Array.isArray(body) ? (body as RpcCall[]) : [body as RpcCall];
  if (calls.length === 0) {
    return rpcError(400, -32600, "Empty batch.");
  }
  if (calls.length > MAX_BATCH) {
    return rpcError(413, -32600, `Batch of ${calls.length} exceeds the limit of ${MAX_BATCH}.`);
  }
  for (const call of calls) {
    if (typeof call?.method !== "string") {
      return rpcError(400, -32600, "Invalid request: every entry needs a string `method`.", call?.id ?? null);
    }
    if (!ALLOWED_METHODS.has(call.method)) {
      return rpcError(
        403,
        -32601,
        `Method ${call.method} is not relayed by this endpoint. Allowed: ${[...ALLOWED_METHODS].sort().join(", ")}.`,
        call.id ?? null,
      );
    }
  }

  try {
    const upstream = await fetch(config.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: text,
      // A wallet call that hangs should fail fast rather than hold a connection.
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });
    const payload = await upstream.text();
    return new Response(payload, {
      status: upstream.status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  } catch (error) {
    // The upstream URL is never echoed back: it is the thing being protected.
    const reason = error instanceof Error ? error.name : "unknown error";
    return rpcError(502, -32603, `Upstream RPC did not answer (${reason}).`);
  }
}

export function GET(): Response {
  return rpcError(405, -32600, "This endpoint accepts POSTed JSON-RPC only.");
}
