/**
 * The Solana twin of /api/rpc, and it exists for one narrow reason:
 *
 * Privy's EMBEDDED-wallet UIs need a Solana RPC of their own. Before signing,
 * the modal estimates the fee (getFeeForMessage) and simulates the transaction
 * (simulateTransaction); with no RPC configured, `useSolanaRpcClient` throws
 * "No RPC configuration found for chain solana:mainnet" and takes the page down
 * with it. External wallets never hit this path — Phantom simulates on its own
 * side — which is why the Solana page worked until the first embedded trading
 * wallet appeared.
 *
 * The configured Solana upstream carries a Helius API key, so it cannot be the
 * URL the browser is given. This route hands the browser a same-origin endpoint
 * and keeps the key on the server, exactly as /api/rpc does for chain 4663.
 *
 * NOTHING ELSE IN THIS APP READS THROUGH HERE. /api/solana-tx and the vault
 * reader talk to the upstream directly, server-side.
 *
 * HONEST LIMITS. This is an unauthenticated relay in front of a metered
 * endpoint. The allowlist below keeps it to the read methods a signing UI
 * needs, and body and batch sizes are capped, but nothing here rate-limits by
 * IP. If that matters for your deployment, set NUVEM_SOLANA_PUBLIC_RPC_URL to a
 * key-free endpoint — that switches this relay off — or put a rate limiter in
 * front of /api/solana-rpc at your edge.
 */

import { loadSolanaConfig } from "../index";
import { poolFetch } from "../rpc-pool";

/**
 * What a signing UI legitimately asks for: anchor the transaction, price it,
 * simulate it, and read the accounts it touches. Nothing that mutates.
 *
 * sendTransaction is NOT relayed. The EVM twin allows eth_sendRawTransaction
 * because a wallet using it as its network endpoint must be able to broadcast,
 * but nothing here is a network endpoint: this app's own Solana transactions go
 * out through /api/solana-tx, which builds what it sends. Leaving broadcast off
 * keeps the relay read-only.
 */
const ALLOWED_METHODS: ReadonlySet<string> = new Set([
  "getAccountInfo",
  "getBalance",
  "getBlockHeight",
  "getEpochInfo",
  "getFeeForMessage",
  "getGenesisHash",
  "getHealth",
  "getLatestBlockhash",
  "getMinimumBalanceForRentExemption",
  "getMultipleAccounts",
  "getRecentPrioritizationFees",
  "getSignatureStatuses",
  "getSlot",
  "getTokenAccountBalance",
  "getTokenAccountsByOwner",
  "getTransaction",
  "getVersion",
  "simulateTransaction",
]);

const MAX_BODY_BYTES = 128 * 1024;
const MAX_BATCH = 20;

function rpcError(status: number, code: number, message: string, id: unknown = null): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

interface RpcCall {
  readonly method?: unknown;
  readonly id?: unknown;
}

export async function handleSolanaRpc(request: Request): Promise<Response> {
  const config = loadSolanaConfig(process.env);
  if (config.kind === "DISABLED") return rpcError(503, -32000, "The Solana lab is not configured on this deployment.");
  if (config.kind === "INVALID") return rpcError(503, -32000, config.problems.join("; "));

  // An operator-supplied key-free endpoint makes this relay dead weight, and an
  // open relay nobody uses is a liability nobody asked for. Same switch-off rule
  // as /api/rpc.
  if ((process.env.NUVEM_SOLANA_PUBLIC_RPC_URL?.trim() ?? "") !== "") {
    return rpcError(404, -32601, "The relay is off because NUVEM_SOLANA_PUBLIC_RPC_URL is set — use it directly.");
  }

  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    return rpcError(413, -32600, `Request body exceeds ${MAX_BODY_BYTES} bytes.`);
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return rpcError(400, -32700, "Parse error: body is not valid JSON.");
  }

  const calls: RpcCall[] = Array.isArray(body) ? (body as RpcCall[]) : [body as RpcCall];
  if (calls.length === 0) return rpcError(400, -32600, "Empty batch.");
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
    // RELAYED THROUGH THE POOL, not to one host. The body is the caller's raw
    // JSON-RPC — possibly a batch — so it is forwarded verbatim rather than
    // rebuilt; poolFetch only decides WHICH endpoint receives it, and moves on
    // when one answers with a rejection instead of an answer.
    const upstream = await poolFetch(config.rpcUrls, 20_000)("", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: text,
    });
    const payload = await upstream.text();
    return new Response(payload, {
      status: upstream.status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  } catch (error) {
    // The upstream URL is never echoed back: it is the thing being protected.
    const reason = error instanceof Error ? error.name : "unknown error";
    return rpcError(502, -32603, `Upstream Solana RPC did not answer (${reason}).`);
  }
}

export function handleSolanaRpcGet(): Response {
  return rpcError(405, -32600, "This endpoint accepts POSTed JSON-RPC only.");
}
