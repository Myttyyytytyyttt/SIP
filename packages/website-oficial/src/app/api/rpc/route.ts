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

import { EVM_ROUTE_OFF_MESSAGE, evmRouteGate, loadEvmConfig } from "@/lib/config";
import { clientKey, createLimiter, retryAfterSeconds } from "@/lib/rate-limit";

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
//
// The buckets and the client identity are shared with /api/vault and live in
// src/lib/rate-limit.ts, including WHY `x-forwarded-for` is consulted last, what
// the edge headers trust, and SIP_TRUSTED_CLIENT_IP_HEADER, which pins the
// identity to the one header the edge writes. Unset, the rule is the one this
// route always had. When nothing identifies a caller, every such caller shares
// one bucket — which throttles a misconfigured deployment rather than leaving it
// open, and is the right way round.
// ---------------------------------------------------------------------------

const BUCKET_CAPACITY = 60;
const limiter = createLimiter({ capacity: BUCKET_CAPACITY });

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
  // An EVM relay: under SIP_CHAIN=solana it does not exist on this deployment.
  const gate = evmRouteGate(process.env);
  if (gate.kind === "solana") {
    return rpcError(404, -32601, `${EVM_ROUTE_OFF_MESSAGE} The Solana relay is /api/solana-rpc.`);
  }
  if (gate.kind === "invalid") {
    return rpcError(503, -32000, "This deployment is not configured: SIP_CHAIN is neither evm nor solana.");
  }

  const load = loadEvmConfig(process.env, { needPrivyAppId: false });
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
  const waitMs = limiter.take(clientKey(request), 1, Date.now());
  if (waitMs > 0) {
    const retryAfter = String(retryAfterSeconds(waitMs));
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
