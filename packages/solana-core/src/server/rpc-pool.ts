// One Solana JSON-RPC call, several endpoints, and a rule for giving up on one.
//
// Ported from Nuvem packages/solana-core/src/rpc-pool.ts (poolRpc, poolRpcBatch,
// poolFetch) with the keeper's corrections:
//
//  * THE LIST IS PASSED IN. There is no env read and no public endpoint appended;
//    SIP_SOLANA_RPC_URLS is the whole list, in the operator's order.
//  * THE COOLDOWN IS PER POOL AND KEYED BY POSITION, so no table in memory holds
//    a keyed URL (Nuvem keyed a module-level map by URL).
//  * "exceeded" AND "disabled" NO LONGER BENCH AN ENDPOINT. A genuine
//    "Computational budget exceeded" is an answer about the transaction, and
//    benching every endpoint for 30 s over it took reads down with it.
//  * RESPONSES ARE READ WITH A HARD BYTE CAP, streamed, so one getMultipleAccounts
//    on large accounts cannot hold hundreds of MB in the only web process.
//  * NO URL LEAVES. Transport errors are named by `error.name` only (undici's
//    messages can quote the host); JSON-RPC messages pass through the redactor.
//
// WHAT IT WILL NOT DO is treat an ANSWER as a failure: "invalid param" is the
// endpoint working correctly, and asking the next provider wastes its quota.

import { RpcEndpoint, UrlRedactor, stripUrls } from "./redact";

export const DEFAULT_COOLDOWN_MS = 30_000;
export const DEFAULT_TIMEOUT_MS = 20_000;
/** Server-side reads (a page of history, the links of one vault). */
export const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
/** The most the browser relay passes through for any one body; each method's own cap is lower (relay-policy.ts). */
export const RELAY_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export const endpointLabel = (index: number, total: number): string => `endpoint ${index + 1}/${total}`;

/** Every endpoint refused. The message names positions and reasons, never URLs. */
export class RpcUnavailableError extends Error {
  override readonly name = "RpcUnavailableError";
  constructor(
    what: string,
    readonly refusals: readonly string[],
  ) {
    super(`${what}: every Solana endpoint refused (${refusals.join("; ") || "no endpoint is configured"})`);
  }
}

/** A real JSON-RPC error answer (the request was wrong, or the chain said no). Message already scrubbed. */
export class RpcAnswerError extends Error {
  override readonly name = "RpcAnswerError";
  constructor(
    readonly method: string,
    readonly code: number | null,
    message: string,
    readonly data: unknown,
  ) {
    super(`RPC ${method}: ${message}`);
  }
}

export class ResponseTooLargeError extends Error {
  override readonly name = "ResponseTooLargeError";
  constructor(readonly limitBytes: number) {
    super(`the upstream response exceeded ${limitBytes} bytes`);
  }
}

/** A registered endpoint secret appeared in an upstream answer; it is not forwarded. */
export class UpstreamLeakError extends Error {
  override readonly name = "UpstreamLeakError";
  constructor() {
    super("the upstream answer quoted part of an endpoint URL and was withheld");
  }
}

export interface JsonRpcErrorBody {
  readonly code?: number;
  readonly message?: string;
  readonly data?: unknown;
}

export interface JsonRpcMember {
  readonly id?: unknown;
  readonly result?: unknown;
  readonly error?: JsonRpcErrorBody;
}

/** A JSON-RPC error that means "ask someone else", not "your request was wrong". */
export function isEndpointFault(error: JsonRpcErrorBody | undefined): boolean {
  if (error === undefined || error === null) return false;
  if (error.code === -32005 || error.code === -32004) return true;
  const message = (typeof error.message === "string" ? error.message : "").toLowerCase();
  return (
    message.includes("rate limit") ||
    message.includes("too many requests") ||
    message.includes("is not supported") ||
    message.includes("unsupported") ||
    message.includes("excluded from account secondary indexes")
  );
}

export interface RpcPoolOptions {
  /** Defaults to globalThis.fetch, looked up at call time. */
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly cooldownMs?: number;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  /** Receives every endpoint URL; scrubs every error string. One is created when absent. */
  readonly redactor?: UrlRedactor;
  readonly onFailover?: (event: { readonly at: string; readonly detail: string }) => void;
}

export interface CallOptions {
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export interface RpcPool {
  readonly size: number;
  /** One call; resolves to `result`. Throws RpcAnswerError, RpcUnavailableError or ResponseTooLargeError. */
  call<T = unknown>(method: string, params: readonly unknown[], options?: CallOptions): Promise<T>;
  /** One batch round trip; members are matched by id by the caller. */
  batch(calls: readonly { readonly id: number | string; readonly method: string; readonly params: readonly unknown[] }[], options?: CallOptions): Promise<readonly JsonRpcMember[]>;
  /**
   * Forwards an already-validated JSON-RPC body; returns the upstream JSON text on HTTP 200. The answer is
   * capped at options.maxResponseBytes, which can only lower RELAY_MAX_RESPONSE_BYTES, never raise it.
   */
  relay(bodyText: string, options?: CallOptions): Promise<{ readonly status: number; readonly text: string }>;
  scrub(text: string): string;
  /** Positions currently sitting out. Holds no URL. */
  coolingDown(): readonly number[];
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ResponseTooLargeError(maxBytes);
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ResponseTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

type Attempt = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly why: string };

export function createRpcPool(endpoints: readonly (RpcEndpoint | string)[], options: RpcPoolOptions = {}): RpcPool {
  const redactor = options.redactor ?? new UrlRedactor();
  const list = endpoints.map((endpoint, index) => {
    if (typeof endpoint === "string") {
      redactor.register(endpoint);
      return new RpcEndpoint(endpoint, `rpcUrl:${index}`);
    }
    redactor.register(endpoint.reveal());
    return endpoint;
  });
  const total = list.length;
  const now = options.now ?? Date.now;
  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const downUntil = new Map<number, number>();
  const scrub = (text: string): string => redactor.scrub(stripUrls(text));

  const usable = (): number[] => {
    const at = now();
    const all = list.map((_, index) => index);
    const live = all.filter((index) => (downUntil.get(index) ?? 0) <= at);
    // A total outage and a total cooldown look identical from here, and calling
    // nobody guarantees the failure that calling everybody only risks.
    return live.length > 0 ? live : all;
  };

  const bench = (index: number, detail: string, refusals: string[]): void => {
    downUntil.set(index, now() + cooldownMs);
    const at = endpointLabel(index, total);
    const clean = scrub(detail).slice(0, 160);
    refusals.push(`${at} ${clean}`);
    options.onFailover?.({ at, detail: clean });
  };

  const attempt = async (index: number, body: string, call: CallOptions | undefined): Promise<Attempt> => {
    const fetchImpl = options.fetch ?? globalThis.fetch;
    let response: Response;
    try {
      response = await fetchImpl(list[index]!.reveal(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(call?.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (error) {
      return { ok: false, why: error instanceof Error ? error.name : "unknown error" };
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, why: `HTTP ${response.status}` };
    }
    try {
      return { ok: true, text: await readCapped(response, call?.maxResponseBytes ?? options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES) };
    } catch (error) {
      // Too large is the ANSWER's size, not the endpoint's health: every
      // endpoint would send the same bytes, so it is thrown, not failed over.
      if (error instanceof ResponseTooLargeError) throw error;
      return { ok: false, why: error instanceof Error ? error.name : "the body could not be read" };
    }
  };

  const parse = (text: string): unknown => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  };

  return {
    size: total,
    scrub,
    coolingDown: () => [...downUntil.entries()].filter(([, until]) => until > now()).map(([index]) => index),

    async call<T>(method: string, params: readonly unknown[], call?: CallOptions): Promise<T> {
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
      const refusals: string[] = [];
      for (const index of usable()) {
        const result = await attempt(index, body, call);
        if (!result.ok) {
          bench(index, result.why, refusals);
          continue;
        }
        const parsed = parse(result.text) as JsonRpcMember | undefined;
        if (parsed === undefined || parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          bench(index, "the response was not a JSON-RPC object", refusals);
          continue;
        }
        if (parsed.error !== undefined && parsed.error !== null) {
          if (isEndpointFault(parsed.error)) {
            bench(index, parsed.error.message ?? "refused", refusals);
            continue;
          }
          downUntil.delete(index);
          throw new RpcAnswerError(method, typeof parsed.error.code === "number" ? parsed.error.code : null, scrub(String(parsed.error.message ?? "error")), parsed.error.data);
        }
        downUntil.delete(index);
        return parsed.result as T;
      }
      throw new RpcUnavailableError(`RPC ${method}`, refusals);
    },

    async batch(calls, call) {
      if (calls.length === 0) return [];
      const body = JSON.stringify(calls.map((entry) => ({ jsonrpc: "2.0", id: entry.id, method: entry.method, params: entry.params })));
      const refusals: string[] = [];
      for (const index of usable()) {
        const result = await attempt(index, body, call);
        if (!result.ok) {
          bench(index, result.why, refusals);
          continue;
        }
        const parsed = parse(result.text);
        if (!Array.isArray(parsed)) {
          const single = parsed as JsonRpcMember | undefined;
          bench(index, single?.error?.message ?? "did not answer a batch", refusals);
          continue;
        }
        const members = parsed as JsonRpcMember[];
        if (members.length > 0 && members.every((member) => isEndpointFault(member?.error))) {
          bench(index, members[0]?.error?.message ?? "refused every member", refusals);
          continue;
        }
        downUntil.delete(index);
        return members.map((member) =>
          member?.error ? { ...member, error: { ...member.error, message: scrub(String(member.error.message ?? "error")) } } : member,
        );
      }
      throw new RpcUnavailableError("RPC batch", refusals);
    },

    async relay(bodyText, call) {
      const maxResponseBytes = Math.min(call?.maxResponseBytes ?? RELAY_MAX_RESPONSE_BYTES, RELAY_MAX_RESPONSE_BYTES);
      const refusals: string[] = [];
      for (const index of usable()) {
        const result = await attempt(index, bodyText, { ...call, maxResponseBytes });
        if (!result.ok) {
          bench(index, result.why, refusals);
          continue;
        }
        const parsed = parse(result.text);
        if (parsed === undefined) {
          bench(index, "the response was not JSON", refusals);
          continue;
        }
        const members = (Array.isArray(parsed) ? parsed : [parsed]) as JsonRpcMember[];
        if (members.length > 0 && members.every((member) => isEndpointFault(member?.error))) {
          bench(index, members[0]?.error?.message ?? "refused", refusals);
          continue;
        }
        // THE TRIPWIRE, not a rewrite: account data can legitimately carry URLs
        // (Token-2022 metadata), so the text is not edited — but an answer that
        // quotes a registered endpoint part is not forwarded at all.
        if (redactor.leaks(result.text)) throw new UpstreamLeakError();
        downUntil.delete(index);
        return { status: 200, text: result.text };
      }
      throw new RpcUnavailableError("relay", refusals);
    },
  };
}
