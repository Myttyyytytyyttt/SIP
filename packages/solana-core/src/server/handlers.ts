// /api/solana-rpc and /api/solana-tx as injectable Fetch handlers.
//
// The web's route files stay thin: they build one handler per process with a
// `gate` that reads SIP_CHAIN and the settings at request time, and export its
// POST and GET. Tests build fresh handlers with fake clocks, stub upstreams and
// their own limiters, so no state leaks between cases. Nothing here imports Next.
//
// ORDER, /api/solana-rpc: chain gate → cross-site refusal → content type → one
// token from the client's own bucket, then from its network's (before the body
// is read) → capped body read → validation → an in-flight slot → the remaining
// weight and the process-wide budgets → upstream, the slot given back in finally.
//
// ORDER, /api/solana-tx: the same up to validation → verification → the
// process-wide send budget → simulate and send. THE GLOBAL SEND BUDGET IS SPENT
// ONLY BY A TRANSACTION THAT VERIFIED and is about to reach the upstream: a junk
// body costs its sender's own buckets and nobody else's.
//
// A request refused early costs a header lookup.
//
// IN FLIGHT, NOT ONLY PER MINUTE. Token buckets bound how fast relays START, not
// how many are open, and each open relay holds up to its method's response cap
// (relay-policy.ts) while the upstream answer is read. So at most
// RELAY_MAX_IN_FLIGHT relays are open at once, RELAY_MAX_IN_FLIGHT_PER_CLIENT of
// them for one client, and the next one is answered at once (503 or 429, with
// retry-after), never queued.

import { tryBase64Decode } from "../client/base64";
import { solscanTx } from "../client/pda";
import type { SolanaServerSettings } from "./config";
import {
  CLIENT_AGGREGATE_FACTOR,
  clientIdentityFromHeaders,
  createWeightedLimiter,
  retryAfterSeconds,
  type ClientIdentity,
  type WeightedLimiter,
} from "./rate-limit";
import { MAX_RELAY_BODY_BYTES, MAX_TX_BASE64_CHARS, checkRelayBody, type JsonRpcId } from "./relay-policy";
import { ResponseTooLargeError, createRpcPool, type RpcPool } from "./rpc-pool";
import { simulateAndSend } from "./send";
import { verifySignedTransaction, type VerifyRefusal } from "./verify-tx";

export type SolanaGate =
  /** SIP_CHAIN is not solana: the route does not exist here (404). */
  | { readonly kind: "disabled" }
  /** SIP_CHAIN=solana but the settings have problems (503, no detail). */
  | { readonly kind: "invalid" }
  | { readonly kind: "ok"; readonly settings: SolanaServerSettings };

export interface RefusalEvent {
  readonly route: "solana-rpc" | "solana-tx";
  readonly status: number;
  readonly code: string;
  readonly method: string | null;
}

export interface SolanaRouteHandler {
  POST(request: Request): Promise<Response>;
  GET(): Response;
}

export interface SolanaRpcHandlerOptions {
  readonly gate: () => SolanaGate;
  /** Per client (IPv4 address, IPv6 /64), weighted. Default: capacity settings.relay.perClientPerMin. */
  readonly limiter?: WeightedLimiter;
  /** Per client network (IPv4 /24, IPv6 /48), weighted. Default: capacity CLIENT_AGGREGATE_FACTOR × settings.relay.perClientPerMin. */
  readonly aggregateLimiter?: WeightedLimiter;
  /** Process-wide, keyed "global". Defaults from settings.relay.signingGlobalPerMin / readsGlobalPerMin. */
  readonly signingBudget?: WeightedLimiter;
  readonly readsBudget?: WeightedLimiter;
  /** Default: createRpcPool(settings.rpcEndpoints, {fetch, redactor: settings.redactor}). */
  readonly pool?: RpcPool;
  /** Upstream relays open at once, process-wide; the next is answered 503 at once. Default RELAY_MAX_IN_FLIGHT. */
  readonly maxInFlight?: number;
  /** Upstream relays open at once for one client (its exact key); the next is answered 429 at once. Default RELAY_MAX_IN_FLIGHT_PER_CLIENT. */
  readonly maxInFlightPerClient?: number;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  /** Default: one console.warn line per second per route, carrying route, status, code and method only. */
  readonly onRefusal?: (event: RefusalEvent) => void;
}

export interface SolanaTxHandlerOptions {
  readonly gate: () => SolanaGate;
  /** Per client (IPv4 address, IPv6 /64). Default: capacity settings.send.perClientPerMin. */
  readonly limiter?: WeightedLimiter;
  /** Per client network (IPv4 /24, IPv6 /48). Default: capacity CLIENT_AGGREGATE_FACTOR × settings.send.perClientPerMin. */
  readonly aggregateLimiter?: WeightedLimiter;
  /** Process-wide, keyed "global", spent only by a verified transaction about to be simulated. Default: settings.send.globalPerMin. */
  readonly budget?: WeightedLimiter;
  readonly pool?: RpcPool;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly onRefusal?: (event: RefusalEvent) => void;
}

export type SolanaTxErrorCode =
  | VerifyRefusal
  | "not_enabled"
  | "unavailable"
  | "method_not_allowed"
  | "cross_site"
  | "unsupported_media_type"
  | "rate_limited"
  | "payload_too_large"
  | "bad_request"
  | "simulation_failed"
  | "send_failed"
  /** sendTransaction went upstream and no endpoint acknowledged it: the answer carries the signature to confirm. */
  | "send_unconfirmed"
  /** The simulation could not be asked: nothing was sent. */
  | "upstream_unavailable";

/** The largest /api/solana-tx body: {"action":"send","signedTxBase64":"<1644 chars>"} with room to spare. */
export const MAX_TX_REQUEST_BYTES = 4096;

/** Upstream relays open at once, process-wide. Each holds at most its body's response cap while its answer is read. */
export const RELAY_MAX_IN_FLIGHT = 32;
/** Relays open at once for one client: room for the few calls a wallet's signing UI fires in parallel, and no more. */
export const RELAY_MAX_IN_FLIGHT_PER_CLIENT = 6;

const GLOBAL = "global";

// ── HTTP helpers ─────────────────────────────────────────────────────────────

export const isCrossSite = (request: Request): boolean => request.headers.get("sec-fetch-site")?.trim().toLowerCase() === "cross-site";

/** The media type is application/json (parameters such as charset allowed). A CORS-simple text/plain POST is not. */
export function isJsonContentType(request: Request): boolean {
  const raw = request.headers.get("content-type");
  return raw !== null && raw.split(";")[0]!.trim().toLowerCase() === "application/json";
}

/** Reads at most `maxBytes`: Content-Length first (without reading), then the stream itself. */
export async function readBodyCapped(request: Request, maxBytes: number): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; reason: "too_large" | "unreadable" }> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, reason: "too_large" };
  if (request.body === null) return { ok: true, bytes: new Uint8Array(0) };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return { ok: true, bytes };
}

function parseJson(bytes: Uint8Array): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown };
  } catch {
    return { ok: false };
  }
}

const RPC_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } as const;
const API_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store" } as const;

function rpcError(status: number, code: number, message: string, id: JsonRpcId = null, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), { status, headers: { ...RPC_HEADERS, ...extra } });
}

const bigintSafe = (_key: string, value: unknown): unknown => (typeof value === "bigint" ? value.toString() : value);

function apiResponse(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, bigintSafe), { status, headers: { ...API_HEADERS, ...extra } });
}

function apiError(status: number, code: SolanaTxErrorCode, message: string, more: Record<string, unknown> = {}, extra: Record<string, string> = {}): Response {
  return apiResponse(status, { error: { code, message, ...more } }, extra);
}

function sampledWarn(): (event: RefusalEvent) => void {
  const last = new Map<string, number>();
  return (event) => {
    const at = Date.now();
    if (at - (last.get(event.route) ?? 0) < 1_000) return;
    last.set(event.route, at);
    console.warn(JSON.stringify({ event: "solana.refusal", ...event }));
  };
}

/** Rebuilds per-process state only when the settings' limits or endpoints actually change (a restart, in practice). */
function memoBySettings<T>(build: (settings: SolanaServerSettings) => T): (settings: SolanaServerSettings) => T {
  let key: string | null = null;
  let value: T | null = null;
  return (settings) => {
    const next = JSON.stringify([
      settings.relay,
      settings.send,
      settings.trustedClientIpHeader,
      settings.rpcEndpoints.length,
      // Compared, never stored anywhere that serializes: this closure is the only holder.
      settings.rpcEndpoints.map((endpoint) => endpoint.reveal()),
    ]);
    if (key !== next || value === null) {
      key = next;
      value = build(settings);
    }
    return value;
  };
}

// ── client buckets and in-flight slots ───────────────────────────────────────

interface ClientBuckets {
  readonly exact: WeightedLimiter;
  readonly aggregate: WeightedLimiter;
}

/** Charges the client's own bucket, then its network's. Its own first: a client already refused spends nothing of its neighbours'. */
function takeClient(buckets: ClientBuckets, identity: ClientIdentity, cost: number, at: number): number {
  const wait = buckets.exact.take(identity.exact, cost, at);
  return wait > 0 ? wait : buckets.aggregate.take(identity.aggregate, cost, at);
}

interface InFlight {
  /** Takes a slot for `key`, or says which cap is full. */
  acquire(key: string): "ok" | "busy" | "client_busy";
  release(key: string): void;
}

/** Counters, not a queue. The per-client map only holds clients with a relay open, so it is bounded by `max`. */
function createInFlight(max: number, maxPerClient: number): InFlight {
  if (!(max >= 1) || !(maxPerClient >= 1)) throw new Error("in-flight caps must be at least 1");
  let open = 0;
  const perClient = new Map<string, number>();
  return {
    acquire(key) {
      const mine = perClient.get(key) ?? 0;
      if (mine >= maxPerClient) return "client_busy";
      if (open >= max) return "busy";
      open += 1;
      perClient.set(key, mine + 1);
      return "ok";
    },
    release(key) {
      open = Math.max(0, open - 1);
      const mine = (perClient.get(key) ?? 0) - 1;
      if (mine > 0) perClient.set(key, mine);
      else perClient.delete(key);
    },
  };
}

// ── /api/solana-rpc ──────────────────────────────────────────────────────────

export function createSolanaRpcHandler(options: SolanaRpcHandlerOptions): SolanaRouteHandler {
  const now = options.now ?? Date.now;
  const onRefusal = options.onRefusal ?? sampledWarn();
  const inFlight = createInFlight(options.maxInFlight ?? RELAY_MAX_IN_FLIGHT, options.maxInFlightPerClient ?? RELAY_MAX_IN_FLIGHT_PER_CLIENT);
  const state = memoBySettings((settings) => ({
    clients: {
      exact: options.limiter ?? createWeightedLimiter({ capacity: settings.relay.perClientPerMin }),
      aggregate: options.aggregateLimiter ?? createWeightedLimiter({ capacity: CLIENT_AGGREGATE_FACTOR * settings.relay.perClientPerMin }),
    },
    signing: options.signingBudget ?? createWeightedLimiter({ capacity: settings.relay.signingGlobalPerMin }),
    reads: options.readsBudget ?? createWeightedLimiter({ capacity: settings.relay.readsGlobalPerMin }),
    pool: options.pool ?? createRpcPool(settings.rpcEndpoints, { fetch: options.fetch, redactor: settings.redactor }),
  }));

  const refuse = (status: number, code: number, reason: string, message: string, method: string | null, id: JsonRpcId = null, extra: Record<string, string> = {}): Response => {
    onRefusal({ route: "solana-rpc", status, code: reason, method });
    return rpcError(status, code, message, id, extra);
  };
  const limited = (waitMs: number, method: string | null): Response => {
    const seconds = retryAfterSeconds(waitMs);
    return refuse(429, -32005, "rate_limited", `Rate limited. Retry in ${seconds} s.`, method, null, { "retry-after": String(seconds) });
  };
  const busy = (which: "busy" | "client_busy", method: string): Response =>
    which === "client_busy"
      ? refuse(429, -32005, "client_in_flight", "Too many requests in flight from this client. Retry in 1 s.", method, null, { "retry-after": "1" })
      : refuse(503, -32005, "relay_busy", "The relay is at capacity. Retry in 1 s.", method, null, { "retry-after": "1" });

  return {
    async POST(request: Request): Promise<Response> {
      const gate = options.gate();
      if (gate.kind === "disabled") return rpcError(404, -32601, "Solana is not enabled on this deployment.");
      if (gate.kind === "invalid") return rpcError(503, -32000, "The Solana relay is not available.");
      const settings = gate.settings;
      if (isCrossSite(request)) return refuse(403, -32600, "cross_site", "Cross-site requests are not relayed.", null);
      if (!isJsonContentType(request)) return refuse(415, -32600, "unsupported_media_type", "Content-Type must be application/json.", null);

      const { clients, signing, reads, pool } = state(settings);
      const identity = clientIdentityFromHeaders(request.headers, settings.trustedClientIpHeader);
      const at = now();
      const firstWait = takeClient(clients, identity, 1, at);
      if (firstWait > 0) return limited(firstWait, null);

      const body = await readBodyCapped(request, MAX_RELAY_BODY_BYTES);
      if (!body.ok) {
        return body.reason === "too_large"
          ? refuse(413, -32600, "payload_too_large", `Request body exceeds ${MAX_RELAY_BODY_BYTES} bytes.`, null)
          : refuse(400, -32700, "unreadable", "The request body could not be read.", null);
      }
      const parsed = parseJson(body.bytes);
      if (!parsed.ok) return refuse(400, -32700, "parse_error", "Parse error: the body is not valid JSON.", null);

      const checked = checkRelayBody(parsed.value);
      if (!checked.ok) return refuse(checked.status, checked.code, checked.status === 403 ? "method_not_relayed" : "invalid", checked.message, checked.method, checked.id);

      const method = checked.methods.length === 1 ? checked.methods[0]! : "batch";
      // The slot before the remaining charges, so a relay at capacity spends nobody's budget.
      const slot = inFlight.acquire(identity.exact);
      if (slot !== "ok") return busy(slot, method);
      try {
        if (checked.weight > 1) {
          const wait = takeClient(clients, identity, checked.weight - 1, at);
          if (wait > 0) return limited(wait, method);
        }
        for (const [budget, cost] of [
          [signing, checked.poolWeights.signing],
          [reads, checked.poolWeights.reads],
        ] as const) {
          if (cost === 0) continue;
          const wait = budget.take(GLOBAL, cost, at);
          if (wait > 0) return limited(wait, method);
        }

        const upstream = await pool.relay(checked.forwardBody, { maxResponseBytes: checked.maxResponseBytes });
        return new Response(upstream.text, { status: upstream.status, headers: RPC_HEADERS });
      } catch (error) {
        if (error instanceof ResponseTooLargeError) return refuse(502, -32603, "upstream_too_large", "The upstream response was too large to relay.", method);
        // Never the error text: it is about endpoints, and endpoints carry keys.
        return refuse(502, -32603, "upstream_unavailable", "Upstream RPC did not answer.", method);
      } finally {
        inFlight.release(identity.exact);
      }
    },

    GET(): Response {
      return rpcError(405, -32600, "This endpoint accepts POSTed JSON-RPC only.", null, { allow: "POST" });
    },
  };
}

// ── /api/solana-tx ───────────────────────────────────────────────────────────

export function createSolanaTxHandler(options: SolanaTxHandlerOptions): SolanaRouteHandler {
  const now = options.now ?? Date.now;
  const onRefusal = options.onRefusal ?? sampledWarn();
  const state = memoBySettings((settings) => ({
    clients: {
      exact: options.limiter ?? createWeightedLimiter({ capacity: settings.send.perClientPerMin }),
      aggregate: options.aggregateLimiter ?? createWeightedLimiter({ capacity: CLIENT_AGGREGATE_FACTOR * settings.send.perClientPerMin }),
    },
    budget: options.budget ?? createWeightedLimiter({ capacity: settings.send.globalPerMin }),
    pool: options.pool ?? createRpcPool(settings.rpcEndpoints, { fetch: options.fetch, redactor: settings.redactor }),
  }));

  const refuse = (status: number, code: SolanaTxErrorCode, message: string, more: Record<string, unknown> = {}, extra: Record<string, string> = {}): Response => {
    onRefusal({ route: "solana-tx", status, code, method: "send" });
    return apiError(status, code, message, more, extra);
  };
  const limited = (waitMs: number): Response => {
    const seconds = retryAfterSeconds(waitMs);
    return refuse(429, "rate_limited", `Too many sends. Retry in ${seconds} s.`, {}, { "retry-after": String(seconds) });
  };

  return {
    async POST(request: Request): Promise<Response> {
      const gate = options.gate();
      if (gate.kind === "disabled") return apiError(404, "not_enabled", "Solana is not enabled on this deployment.");
      if (gate.kind === "invalid") return apiError(503, "unavailable", "Solana sending is not available.");
      const settings = gate.settings;
      if (isCrossSite(request)) return refuse(403, "cross_site", "Cross-site requests are refused.");
      if (!isJsonContentType(request)) return refuse(415, "unsupported_media_type", "Content-Type must be application/json.");

      const { clients, budget, pool } = state(settings);
      const identity = clientIdentityFromHeaders(request.headers, settings.trustedClientIpHeader);
      // The client's own buckets only: the process-wide budget waits for a transaction that verifies.
      const clientWait = takeClient(clients, identity, 1, now());
      if (clientWait > 0) return limited(clientWait);

      const body = await readBodyCapped(request, MAX_TX_REQUEST_BYTES);
      if (!body.ok) {
        return body.reason === "too_large"
          ? refuse(413, "payload_too_large", `Request body exceeds ${MAX_TX_REQUEST_BYTES} bytes.`)
          : refuse(400, "bad_request", "The request body could not be read.");
      }
      const parsed = parseJson(body.bytes);
      if (!parsed.ok || parsed.value === null || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
        return refuse(400, "bad_request", "The body must be a JSON object.");
      }
      const fields = parsed.value as Record<string, unknown>;
      if (fields.action !== "send") return refuse(400, "bad_request", 'Only {"action":"send"} is served.');
      const extra = Object.keys(fields).filter((name) => name !== "action" && name !== "signedTxBase64");
      if (extra.length > 0) return refuse(400, "bad_request", `Unexpected field ${extra[0]!.slice(0, 40)}.`);
      const encoded = fields.signedTxBase64;
      const bytes = typeof encoded === "string" && encoded.length <= MAX_TX_BASE64_CHARS ? tryBase64Decode(encoded) : null;
      if (bytes === null || bytes.length === 0) {
        return refuse(400, "bad_request", `signedTxBase64 must be standard base64 of at most ${MAX_TX_BASE64_CHARS} characters.`);
      }

      const verified = verifySignedTransaction(bytes, { programId: settings.programId });
      if (!verified.ok) return refuse(422, verified.reason, verified.detail);

      // Only now the process-wide budget: this transaction verified and is about to reach the upstream.
      const globalWait = budget.take(GLOBAL, 1, now());
      if (globalWait > 0) return limited(globalWait);

      const outcome = await simulateAndSend(pool, verified);
      if (outcome.ok) {
        return apiResponse(200, {
          signature: outcome.signature,
          slot: outcome.slot,
          unitsConsumed: outcome.unitsConsumed,
          explorerUrl: solscanTx(outcome.signature),
        });
      }
      if (outcome.stage === "simulate") {
        if (outcome.reason === "rejected") {
          const expired = outcome.err === "BlockhashNotFound";
          return refuse(
            422,
            "simulation_failed",
            expired ? "The blockhash expired before the transaction was sent: rebuild it and sign again." : "The transaction failed simulation; nothing was sent.",
            { err: outcome.err, logs: outcome.logs },
          );
        }
        return refuse(502, "upstream_unavailable", "The Solana endpoints did not answer the simulation; nothing was sent.");
      }

      // FROM HERE sendTransaction went upstream with these bytes, and an endpoint
      // that took them before failing (maxRetries 5) can still land them. So every
      // answer carries the signature: the client confirms it before it asks the
      // owner to sign again, or a second withdraw can land.
      const sent = { signature: verified.signature, explorerUrl: solscanTx(verified.signature) };
      if (outcome.reason === "unavailable") {
        return refuse(
          502,
          "send_unconfirmed",
          "The endpoint did not confirm receipt; the transaction may still land. Confirm this signature (getSignatureStatuses until lastValidBlockHeight passes) before signing again.",
          sent,
        );
      }
      if (outcome.reason === "rejected") {
        return refuse(502, "send_failed", "The endpoint refused to send the transaction. Confirm this signature before signing again.", {
          ...sent,
          err: outcome.err,
          logs: outcome.logs,
        });
      }
      return refuse(502, "send_failed", "The endpoint answered with a signature that is not this transaction's. Confirm this signature before signing again.", sent);
    },

    GET(): Response {
      return apiError(405, "method_not_allowed", "This endpoint accepts POST only.", {}, { allow: "POST" });
    },
  };
}
