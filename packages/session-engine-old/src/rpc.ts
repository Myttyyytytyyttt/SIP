// JSON-RPC access, in three flavours: live, recording, and replay.
//
// The replay client throws on any request it has not seen. That is deliberate:
// if a change to the engine needs data the fixture does not contain, the test
// must fail loudly rather than quietly reconstruct a different answer from a
// smaller set of facts. A silently-degrading PnL engine is the exact failure
// mode this package exists to rule out.

export type RpcParams = readonly unknown[];

export interface RpcClient {
  call<T>(method: string, params?: RpcParams): Promise<T>;
}

/** Stable cache key. Params are hex strings and plain objects, so JSON is faithful. */
export function rpcKey(method: string, params: RpcParams = []): string {
  return `${method}|${JSON.stringify(params)}`;
}

export type Recording = Record<string, unknown>;

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
  readonly baseDelayMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Rate limiting and transient gateway errors, which are worth retrying. */
const isTransient = (status: number) => status === 429 || status === 502 || status === 503 || status === 504;

/** Wraps an error so the retry loop can tell "try again" from "give up". */
class RetryableError extends Error {
  constructor(readonly cause: unknown) {
    super("retryable");
  }
}

export function httpRpcClient(url: string, options: HttpRpcOptions = {}): RpcClient {
  const attempts = options.attempts ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 250;
  let id = 0;

  const attempt = async <T>(method: string, params: RpcParams): Promise<T> => {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      });
    } catch (error) {
      throw new RetryableError(error); // network-level failure
    }

    if (!response.ok) {
      const error = new RpcError(method, params, `HTTP ${response.status}`);
      if (isTransient(response.status)) throw new RetryableError(error);
      throw error;
    }

    const body = (await response.json()) as { result?: unknown; error?: { message: string } };
    if (body.error) {
      const error = new RpcError(method, params, body.error.message);
      // Providers also signal throttling inside a 200 response.
      if (/rate|limit|throttl|capacity|busy/i.test(body.error.message)) {
        throw new RetryableError(error);
      }
      throw error;
    }
    return body.result as T;
  };

  return {
    async call<T>(method: string, params: RpcParams = []): Promise<T> {
      // Backoff matters for real work, not politeness: a census over a wallet's
      // whole life issues tens of thousands of calls, and without retries a
      // single 429 aborts the scan mid-way. A truncated scan is worse than a
      // slow one, because it silently answers from less evidence.
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
export function recordingRpcClient(inner: RpcClient): RpcClient & { recording: Recording } {
  const recording: Recording = {};
  return {
    recording,
    async call<T>(method: string, params: RpcParams = []): Promise<T> {
      const key = rpcKey(method, params);
      if (key in recording) return recording[key] as T;
      const result = await inner.call<T>(method, params);
      recording[key] = result;
      return result;
    },
  };
}

export class UnrecordedRequestError extends Error {
  constructor(readonly method: string, readonly params: RpcParams) {
    super(
      `No fixture for ${method} ${JSON.stringify(params)}.\n` +
        "Re-record with `pnpm --dir packages/session-engine-old record-fixture` if this call is legitimately new.",
    );
    this.name = "UnrecordedRequestError";
  }
}

export function fixtureRpcClient(recording: Recording): RpcClient {
  return {
    async call<T>(method: string, params: RpcParams = []): Promise<T> {
      const key = rpcKey(method, params);
      if (!(key in recording)) throw new UnrecordedRequestError(method, params);
      return recording[key] as T;
    },
  };
}
