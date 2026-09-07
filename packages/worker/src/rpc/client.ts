// JSON-RPC access, in three flavours: live, recording, and replay.
//
// Ported from packages/session-engine-old/src/rpc.ts (owner: rpc). The shapes
// RpcClient / RpcParams / Recording now live in ../types.ts and nothing else
// changed in shape. What did change: a transport failure or a non-JSON body
// becomes an RpcError whose message never carries the endpoint URL — an
// Alchemy key lives in the URL's path, and the log Redactor only knows 64-hex
// strings, so the URL must be kept out of every error at the source.
//
// The replay client throws on any request it has not seen. That is deliberate:
// if a change to the worker needs data the fixture does not contain, the test
// must fail loudly rather than quietly reconstruct a different answer from a
// smaller set of facts. A silently-degrading volume meter is the exact failure
// mode this package exists to rule out — fabricated volume is unforgivable.

import type { Recording, RpcClient, RpcParams } from "../types.js";

/** Stable cache key. Params are hex strings and plain objects, so JSON is faithful. */
export function rpcKey(method: string, params: RpcParams = []): string {
  return `${method}|${JSON.stringify(params)}`;
}

export class RpcError extends Error {
  constructor(
    readonly method: string,
    readonly params: RpcParams,
    message: string,
  ) {
    super(`${method} failed: ${message}`);
    this.name = "RpcError";
  }
}

export interface HttpRpcOptions {
  /** Attempts per call, including the first. */
  readonly attempts?: number;
  /** Delay before the second attempt; every later attempt doubles it. */
  readonly baseDelayMs?: number;
  /** Injected for tests, which must never reach the network. Defaults to the global fetch. */
  readonly fetch?: typeof globalThis.fetch;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Rate limiting and transient gateway errors, which are worth retrying. */
const isTransient = (status: number) => status === 429 || status === 502 || status === 503 || status === 504;

/** Providers also signal throttling inside a 200 response. */
const THROTTLED = /rate|limit|throttl|capacity|busy/i;

const URL_PATTERN = /https?:\/\/[^\s'"`)>\]]+/gi;

/**
 * NOTHING THAT LEAVES THIS MODULE MAY NAME AN ENDPOINT. Node's fetch errors,
 * undici causes and gateway pages all like to echo the URL, and the URL is
 * where the API key lives. Every message is passed through here before it is
 * attached to an error; the failover layer scrubs its events with it too.
 */
export function withoutUrls(text: string): string {
  return text.replace(URL_PATTERN, "<rpc>");
}

/** One line for an unknown thrown value, including a fetch error's cause. */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  return cause instanceof Error ? `${error.message}: ${cause.message}` : error.message;
}

/** Wraps an error so the retry loop can tell "try again" from "give up". */
class RetryableError extends Error {
  constructor(readonly cause: unknown) {
    super("retryable");
  }
}

interface JsonRpcBody {
  readonly result?: unknown;
  readonly error?: { readonly message?: unknown; readonly code?: unknown } | null;
}

export function httpRpcClient(url: string, options: HttpRpcOptions = {}): RpcClient {
  const attempts = options.attempts ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 250;
  const doFetch = options.fetch ?? globalThis.fetch;
  let id = 0;

  // Belt and braces: the exact configured URL is split out even when it does not
  // look like a URL to the pattern (a bare host, a mangled scheme). An empty
  // url would split on every character, so it is only ever split when non-empty.
  const scrub = (text: string) => withoutUrls(url.length > 0 ? text.split(url).join("<rpc>") : text);

  const attempt = async <T>(method: string, params: RpcParams): Promise<T> => {
    let response: Response;
    try {
      response = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      });
    } catch (error) {
      // Network-level failure: DNS, TLS, reset. Worth retrying; rebuilt here so
      // the URL never rides along in the message.
      throw new RetryableError(new RpcError(method, params, `fetch failed: ${scrub(describeError(error))}`));
    }

    if (!response.ok) {
      // THE PROVIDER'S OWN MESSAGE IS THE DIAGNOSIS. A bare "HTTP 400" cost an
      // afternoon: the body said, in words, that the plan capped eth_getLogs to
      // ten blocks. It is scrubbed like every other message here, so the key in
      // the URL cannot ride along, and truncated so a wall of HTML cannot.
      let detail = "";
      try {
        const text = (await response.text()).trim();
        if (text !== "") detail = `: ${scrub(text).slice(0, 300)}`;
      } catch {
        // A body that cannot be read is not worth failing differently over.
      }
      const error = new RpcError(method, params, `HTTP ${response.status}${detail}`);
      if (isTransient(response.status)) throw new RetryableError(error);
      throw error;
    }

    let body: JsonRpcBody;
    try {
      body = (await response.json()) as JsonRpcBody;
    } catch {
      // A 200 that is not JSON is a gateway or challenge page, not the node:
      // the chain has said nothing, so it is worth one more try.
      throw new RetryableError(new RpcError(method, params, "non-JSON response body"));
    }

    if (body.error !== undefined && body.error !== null) {
      const message = typeof body.error.message === "string" ? body.error.message : JSON.stringify(body.error);
      const error = new RpcError(method, params, scrub(message));
      if (THROTTLED.test(message)) throw new RetryableError(error);
      throw error;
    }
    // `null` is a real answer (an unknown block) and must reach the caller as such.
    return body.result as T;
  };

  return {
    async call<T>(method: string, params: RpcParams = []): Promise<T> {
      // Backoff matters for real work, not politeness: a sweep over every bound
      // wallet issues thousands of calls, and without retries a single 429
      // aborts the scan mid-way. A truncated scan is worse than a slow one,
      // because it silently answers from less evidence. Absorbing throttling
      // here is also what keeps a lone 429 from tripping failover (§4.1).
      let last: unknown;
      for (let i = 0; i < attempts; i++) {
        if (i > 0) await sleep(baseDelayMs * 2 ** (i - 1));
        try {
          return await attempt<T>(method, params);
        } catch (error) {
          if (error instanceof RetryableError) {
            last = error.cause;
            continue;
          }
          throw error; // a real error: surface it immediately
        }
      }
      throw last instanceof Error ? last : new RpcError(method, params, "exhausted retries");
    },
  };
}

/** Wraps a live client and accumulates every response for later replay. */
export function recordingRpcClient(inner: RpcClient): RpcClient & { readonly recording: Recording } {
  const recording: Recording = {};
  return {
    recording,
    async call<T>(method: string, params: RpcParams = []): Promise<T> {
      const key = rpcKey(method, params);
      if (Object.hasOwn(recording, key)) return recording[key] as T;
      const result = await inner.call<T>(method, params);
      recording[key] = result;
      return result;
    },
  };
}

export class UnrecordedRequestError extends Error {
  constructor(
    readonly method: string,
    readonly params: RpcParams,
    /** Keys the fixture does hold for this method, so a near miss is visible. */
    recordedForMethod: readonly string[] = [],
  ) {
    const examples = recordedForMethod.slice(0, 3).map((key) => `  ${key}`);
    const known =
      recordedForMethod.length === 0
        ? `The fixture holds no ${method} call at all.`
        : `The fixture holds ${recordedForMethod.length} ${method} call(s), e.g.\n${examples.join("\n")}`;
    super(
      `No fixture for ${rpcKey(method, params)}.\n` +
        `${known}\n` +
        "Keys are `${method}|${JSON.stringify(params)}`: check lowercase addresses, hex quantities and a height " +
        "rather than a block tag before assuming the call is new. If it is legitimately new, record it once with " +
        "recordingRpcClient against a live endpoint and add the entry to test/fixtures/mainnet-4663.json.",
    );
    this.name = "UnrecordedRequestError";
  }
}

export function fixtureRpcClient(recording: Recording): RpcClient {
  return {
    async call<T>(method: string, params: RpcParams = []): Promise<T> {
      const key = rpcKey(method, params);
      if (!Object.hasOwn(recording, key)) {
        const prefix = `${method}|`;
        const recordedForMethod = Object.keys(recording).filter((k) => k.startsWith(prefix));
        throw new UnrecordedRequestError(method, params, recordedForMethod);
      }
      // A fresh copy per call: a caller that mutates a receipt must not poison
      // the next test's view of the same recorded fact.
      return structuredClone(recording[key]) as T;
    },
  };
}
