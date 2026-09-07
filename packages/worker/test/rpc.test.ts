// Owner: rpc. Every rule DESIGN.md §2 (rpc) states has a test here:
// retry on 429 then success, fixture client throws UnrecordedRequestError with
// a helpful message, failover switches on fault and recovers. No network.

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RpcError,
  UnrecordedRequestError,
  fixtureRpcClient,
  httpRpcClient,
  recordingRpcClient,
  rpcKey,
  withoutUrls,
} from "../src/rpc/client.js";
import { failoverRpcClient, isEndpointFault, type FailoverEvent } from "../src/rpc/failover.js";
import type { Recording, RpcClient, RpcParams } from "../src/types.js";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/mainnet-4663.json", import.meta.url), "utf8"),
) as Recording;

/** §1: the fixture wallet, and two heights the fixture recorded for it. */
const WALLET = "0xc455bf7f16ebbc2b07cb26d1dd46194977974e7d";
const BUY_V3_TX = "0x27259f99e2cbc54ff51e7193e020af3b3f69c021347448da59665c33c2eef882";

/** A URL shaped like a provider's, key and all. Nothing may echo it. */
const KEY = "0123456789abcdef0123456789abcdef";
const URL_WITH_KEY = `https://rpc.example.test/v2/${KEY}`;

// ── helpers ───────────────────────────────────────────────────────────────────

type Reply = { readonly status: number; readonly body?: unknown; readonly text?: string } | Error;

/** A scripted fetch: one reply per call, in order; records every request. */
function fakeFetch(replies: readonly Reply[]) {
  const queue = [...replies];
  const calls: { readonly url: string; readonly init: RequestInit }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = queue.shift();
    if (next === undefined) throw new Error("fakeFetch: no reply scripted for this call");
    if (next instanceof Error) throw next;
    const text = next.text ?? JSON.stringify(next.body);
    return new Response(text, { status: next.status, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

const ok = (result: unknown): Reply => ({ status: 200, body: { jsonrpc: "2.0", id: 0, result } });
const rpcError = (message: string): Reply => ({ status: 200, body: { jsonrpc: "2.0", id: 0, error: { code: -32000, message } } });

function bodyOf(call: { readonly init: RequestInit }): { jsonrpc: string; id: number; method: string; params: unknown } {
  return JSON.parse(String(call.init.body)) as { jsonrpc: string; id: number; method: string; params: unknown };
}

/** An endpoint whose behaviour is a function of the call; records what it was asked. */
function endpoint(behaviour: (method: string, params: RpcParams) => unknown) {
  const calls: string[] = [];
  const client: RpcClient = {
    async call<T>(method: string, params: RpcParams = []): Promise<T> {
      calls.push(method);
      return behaviour(method, params) as T;
    },
  };
  return { client, calls };
}

const answering = (value: unknown) => endpoint(() => value);
const faulting = (message: string) =>
  endpoint((method, params) => {
    throw new RpcError(method, params, message);
  });

function collectEvents() {
  const events: FailoverEvent[] = [];
  return { events, onEvent: (event: FailoverEvent) => events.push(event) };
}

afterEach(() => {
  vi.useRealTimers();
});

// ── rpcKey ────────────────────────────────────────────────────────────────────

describe("rpcKey", () => {
  it("is the fixture's key format: method|JSON(params)", () => {
    const key = rpcKey("eth_getTransactionCount", [WALLET, "0x150ec50"]);
    expect(key).toBe(`eth_getTransactionCount|["${WALLET}","0x150ec50"]`);
    expect(Object.hasOwn(fixture, key)).toBe(true);
  });

  it("defaults params to an empty list", () => {
    expect(rpcKey("eth_blockNumber")).toBe("eth_blockNumber|[]");
  });

  it("is faithful to nested objects and parameter order", () => {
    const params = [{ to: "0x0bd7", data: "0x70a0" }, "0x1"] as const;
    expect(rpcKey("eth_call", params)).toBe('eth_call|[{"to":"0x0bd7","data":"0x70a0"},"0x1"]');
    expect(rpcKey("eth_call", [...params].reverse())).not.toBe(rpcKey("eth_call", params));
  });
});

// ── fixtureRpcClient ──────────────────────────────────────────────────────────

describe("fixtureRpcClient", () => {
  it("replays a recorded call from the mainnet fixture", async () => {
    const rpc = fixtureRpcClient(fixture);
    await expect(rpc.call<string>("eth_getTransactionCount", [WALLET, "0x150ec50"])).resolves.toBe("0x47");
    const receipt = await rpc.call<{ blockNumber: string; from: string }>("eth_getTransactionReceipt", [BUY_V3_TX]);
    expect(receipt.blockNumber).toBe("0x150ec51");
    expect(receipt.from.toLowerCase()).toBe(WALLET);
  });

  it("throws UnrecordedRequestError, naming the call and the near misses, for anything not recorded", async () => {
    const rpc = fixtureRpcClient(fixture);
    const params = [WALLET, "latest"];
    const failure = await rpc.call("eth_getBalance", params).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(UnrecordedRequestError);
    if (!(failure instanceof UnrecordedRequestError)) throw new Error("unreachable");
    expect(failure.name).toBe("UnrecordedRequestError");
    expect(failure.method).toBe("eth_getBalance");
    expect(failure.params).toEqual(params);
    // The message says which key was asked for, what the fixture does hold for
    // that method, and how to add the entry if the call is legitimately new.
    expect(failure.message).toContain(`No fixture for eth_getBalance|["${WALLET}","latest"]`);
    expect(failure.message).toMatch(/holds 14 eth_getBalance call\(s\)/);
    expect(failure.message).toContain("eth_getBalance|[");
    expect(failure.message).toContain("recordingRpcClient");
    expect(failure.message).toContain("test/fixtures/mainnet-4663.json");
  });

  it("says so when the fixture has no call of that method at all", async () => {
    const failure = await fixtureRpcClient({})
      .call("eth_blockNumber")
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(UnrecordedRequestError);
    expect((failure as Error).message).toContain("holds no eth_blockNumber call at all");
  });

  it("an unrecorded request is an answer, never an endpoint fault", async () => {
    const failure = await fixtureRpcClient({})
      .call("eth_blockNumber")
      .catch((error: unknown) => error);
    expect(isEndpointFault(failure)).toBe(false);
  });

  it("hands each caller its own copy of a recorded result", async () => {
    const rpc = fixtureRpcClient(fixture);
    const first = await rpc.call<{ logs: unknown[] }>("eth_getTransactionReceipt", [BUY_V3_TX]);
    const second = await rpc.call<{ logs: unknown[] }>("eth_getTransactionReceipt", [BUY_V3_TX]);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    first.logs.length = 0;
    const third = await rpc.call<{ logs: unknown[] }>("eth_getTransactionReceipt", [BUY_V3_TX]);
    expect(third.logs.length).toBe(second.logs.length);
  });
});

// ── recordingRpcClient ────────────────────────────────────────────────────────

describe("recordingRpcClient", () => {
  it("records every answer under rpcKey and serves repeats without asking again", async () => {
    const inner = answering("0x47");
    const rpc = recordingRpcClient(inner.client);

    await expect(rpc.call("eth_getTransactionCount", [WALLET, "0x150ec50"])).resolves.toBe("0x47");
    await expect(rpc.call("eth_getTransactionCount", [WALLET, "0x150ec50"])).resolves.toBe("0x47");

    expect(inner.calls).toEqual(["eth_getTransactionCount"]);
    expect(rpc.recording).toEqual({ [rpcKey("eth_getTransactionCount", [WALLET, "0x150ec50"])]: "0x47" });
  });

  it("produces a recording that replays through fixtureRpcClient", async () => {
    const live = endpoint((method) => (method === "eth_blockNumber" ? "0x150ed52" : null));
    const recorder = recordingRpcClient(live.client);
    await recorder.call("eth_blockNumber");
    await recorder.call("eth_getBlockByNumber", ["0x1", false]);

    const replay = fixtureRpcClient(recorder.recording);
    await expect(replay.call("eth_blockNumber")).resolves.toBe("0x150ed52");
    await expect(replay.call("eth_getBlockByNumber", ["0x1", false])).resolves.toBeNull();
    await expect(replay.call("eth_getBlockByNumber", ["0x2", false])).rejects.toBeInstanceOf(UnrecordedRequestError);
  });
});

// ── httpRpcClient ─────────────────────────────────────────────────────────────

describe("httpRpcClient", () => {
  it("retries a 429 and returns the answer that follows", async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 429, text: "Too Many Requests" }, ok("0x47")]);
    const rpc = httpRpcClient(URL_WITH_KEY, { baseDelayMs: 0, fetch: fetchImpl });

    await expect(rpc.call("eth_getTransactionCount", [WALLET, "0x150ec50"])).resolves.toBe("0x47");

    expect(calls).toHaveLength(2);
    const first = calls[0];
    const second = calls[1];
    if (first === undefined || second === undefined) throw new Error("unreachable");
    expect(first.url).toBe(URL_WITH_KEY);
    expect(first.init.method).toBe("POST");
    expect(first.init.headers).toEqual({ "content-type": "application/json" });
    expect(bodyOf(first)).toEqual({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionCount", params: [WALLET, "0x150ec50"] });
    expect(bodyOf(second).id).toBe(2);
  });

  it("retries 502, 503 and 504 the same way", async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 502 }, { status: 503 }, { status: 504 }, ok("0x1")]);
    const rpc = httpRpcClient(URL_WITH_KEY, { baseDelayMs: 0, fetch: fetchImpl });
    await expect(rpc.call("eth_blockNumber")).resolves.toBe("0x1");
    expect(calls).toHaveLength(4);
  });

  it("retries throttling that arrives inside a 200 body", async () => {
    const { fetchImpl, calls } = fakeFetch([
      rpcError("rate limit exceeded"),
      rpcError("Your app has exceeded its compute units per second capacity"),
      rpcError("server busy"),
      ok("0x2"),
    ]);
    const rpc = httpRpcClient(URL_WITH_KEY, { baseDelayMs: 0, fetch: fetchImpl });
    await expect(rpc.call("eth_blockNumber")).resolves.toBe("0x2");
    expect(calls).toHaveLength(4);
  });

  it("retries a transport failure and a non-JSON body", async () => {
    const { fetchImpl, calls } = fakeFetch([
      new TypeError("fetch failed", { cause: new Error("connect ECONNRESET") }),
      { status: 200, text: "<html>challenge</html>" },
      ok("0x3"),
    ]);
    const rpc = httpRpcClient(URL_WITH_KEY, { baseDelayMs: 0, fetch: fetchImpl });
    await expect(rpc.call("eth_blockNumber")).resolves.toBe("0x3");
    expect(calls).toHaveLength(3);
  });

  it("does not retry a non-transient HTTP status", async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 401, text: "unauthorized" }, ok("0x1")]);
    const rpc = httpRpcClient(URL_WITH_KEY, { baseDelayMs: 0, fetch: fetchImpl });
    const failure = await rpc.call("eth_blockNumber").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RpcError);
    // THE PROVIDER'S OWN WORDS ARE THE DIAGNOSIS. A bare "HTTP 400" once hid the
    // sentence "you can make eth_getLogs requests with up to a 10 block range",
    // which was the entire cause of a dead scan, so the body rides along —
    // scrubbed and truncated like every other message this client builds.
    expect((failure as Error).message).toBe("eth_blockNumber failed: HTTP 401: unauthorized");
    expect(calls).toHaveLength(1);
  });

  it("keeps the key out of an HTTP error even when the body echoes the URL", async () => {
    const { fetchImpl } = fakeFetch([{ status: 400, text: `bad request for ${URL_WITH_KEY}` }, ok("0x1")]);
    const rpc = httpRpcClient(URL_WITH_KEY, { baseDelayMs: 0, fetch: fetchImpl });
    const failure = await rpc.call("eth_getLogs", [{}]).catch((error: unknown) => error);
    const message = (failure as Error).message;
    expect(message).toContain("HTTP 400");
    expect(message).not.toContain(URL_WITH_KEY);
  });

  it("surfaces a real JSON-RPC error immediately, with method and params attached", async () => {
    const { fetchImpl, calls } = fakeFetch([rpcError("execution reverted"), ok("0x")]);
    const rpc = httpRpcClient(URL_WITH_KEY, { baseDelayMs: 0, fetch: fetchImpl });
    const params = [{ to: "0xfa92abf15dfaf470cc8833cb01464bd6ca139e16", data: "0x" }, "latest"];
    const failure = await rpc.call("eth_call", params).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RpcError);
    if (!(failure instanceof RpcError)) throw new Error("unreachable");
    expect(failure.name).toBe("RpcError");
    expect(failure.message).toBe("eth_call failed: execution reverted");
    expect(failure.method).toBe("eth_call");
    expect(failure.params).toEqual(params);
    expect(calls).toHaveLength(1);
    // And this is precisely the kind of error failover must NOT act on.
    expect(isEndpointFault(failure)).toBe(false);
  });

  it("gives up after `attempts` tries and throws the last transient error", async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 429 }, { status: 429 }, { status: 429 }, ok("never")]);
    const rpc = httpRpcClient(URL_WITH_KEY, { attempts: 3, baseDelayMs: 0, fetch: fetchImpl });
    const failure = await rpc.call("eth_blockNumber").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RpcError);
    expect((failure as Error).message).toBe("eth_blockNumber failed: HTTP 429");
    expect(calls).toHaveLength(3);
    // Exhausted throttling IS an endpoint fault: this is where failover takes over.
    expect(isEndpointFault(failure)).toBe(true);
  });

  it("never lets the URL, and the key in it, into an error message", async () => {
    const leaky = new TypeError("fetch failed", {
      cause: new Error(`request to ${URL_WITH_KEY} failed, reason: getaddrinfo ENOTFOUND rpc.example.test`),
    });
    const { fetchImpl } = fakeFetch([leaky, leaky, rpcError(`forbidden origin ${URL_WITH_KEY}`)]);
    const rpc = httpRpcClient(URL_WITH_KEY, { attempts: 3, baseDelayMs: 0, fetch: fetchImpl });

    const failure = await rpc.call("eth_blockNumber").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RpcError);
    const message = (failure as Error).message;
    expect(message).toContain("forbidden origin <rpc>");
    expect(message).not.toContain(KEY);
    expect(message).not.toContain("https://");

    // The transport message keeps its diagnostic value minus the URL.
    const { fetchImpl: onlyTransport } = fakeFetch([leaky]);
    const transportFailure = await httpRpcClient(URL_WITH_KEY, { attempts: 1, fetch: onlyTransport })
      .call("eth_blockNumber")
      .catch((error: unknown) => error);
    const transportMessage = (transportFailure as Error).message;
    expect(transportMessage).toContain("fetch failed");
    expect(transportMessage).toContain("ENOTFOUND");
    expect(transportMessage).not.toContain(KEY);
  });

  it("backs off 250 ms, then 500, then 1000 by default", async () => {
    vi.useFakeTimers();
    const { fetchImpl, calls } = fakeFetch([{ status: 429 }, { status: 429 }, { status: 429 }, { status: 429 }]);
    const rpc = httpRpcClient(URL_WITH_KEY, { attempts: 4, fetch: fetchImpl });
    const outcome = rpc.call("eth_blockNumber").catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(249);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(499);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(4);

    expect(await outcome).toBeInstanceOf(RpcError);
  });

  it("sends [] when params are omitted and passes a null result through as null", async () => {
    const { fetchImpl, calls } = fakeFetch([ok(null)]);
    const rpc = httpRpcClient(URL_WITH_KEY, { fetch: fetchImpl });
    await expect(rpc.call("eth_getBlockByNumber")).resolves.toBeNull();
    const only = calls[0];
    if (only === undefined) throw new Error("unreachable");
    expect(bodyOf(only).params).toEqual([]);
  });
});

// ── withoutUrls ───────────────────────────────────────────────────────────────

describe("withoutUrls", () => {
  it("replaces every http(s) URL and leaves the rest of the text alone", () => {
    expect(withoutUrls(`fetch ${URL_WITH_KEY} then http://b.test/x failed`)).toBe("fetch <rpc> then <rpc> failed");
    expect(withoutUrls("HTTP 503")).toBe("HTTP 503");
  });
});

// ── isEndpointFault ───────────────────────────────────────────────────────────

describe("isEndpointFault", () => {
  it.each([
    "eth_blockNumber failed: fetch failed: connect ECONNRESET",
    "eth_blockNumber failed: HTTP 503",
    "eth_blockNumber failed: HTTP 429",
    "eth_getLogs failed: rate limit exceeded",
    "eth_getLogs failed: Your app has exceeded its compute units",
    "eth_getLogs failed: request timed out",
    "debug_traceTransaction failed: the method does not exist/is not available",
    "eth_blockNumber failed: non-JSON response body",
    "eth_getBlockByNumber returned null for block 0x150ed52",
  ])("a fault: %s", (message) => {
    expect(isEndpointFault(new Error(message))).toBe(true);
  });

  it.each([
    "eth_call failed: execution reverted",
    "eth_call failed: execution reverted: SettlementLimitExceeded",
    "eth_sendRawTransaction failed: insufficient funds for gas * price + value",
    "eth_sendRawTransaction failed: nonce too low",
    "eth_getLogs failed: invalid argument 0: hex string without 0x prefix",
    "No fixture for eth_getBalance|[\"0x\",\"latest\"]",
    "something nobody has seen before",
  ])("an answer: %s", (message) => {
    expect(isEndpointFault(new Error(message))).toBe(false);
  });

  it("classifies non-Error throwables by their string form", () => {
    expect(isEndpointFault("HTTP 502")).toBe(true);
    expect(isEndpointFault(42)).toBe(false);
  });
});

// ── failoverRpcClient ─────────────────────────────────────────────────────────

describe("failoverRpcClient", () => {
  it("needs at least one endpoint", () => {
    expect(() => failoverRpcClient([])).toThrow(/at least one endpoint/);
  });

  it("serves from the preferred endpoint and never touches the fallback while it answers", async () => {
    const primary = answering("0x1");
    const fallback = answering("0x2");
    const { events, onEvent } = collectEvents();
    const rpc = failoverRpcClient([primary.client, fallback.client], { onEvent });

    await expect(rpc.call("eth_blockNumber")).resolves.toBe("0x1");
    await expect(rpc.call("eth_blockNumber")).resolves.toBe("0x1");

    expect(primary.calls).toHaveLength(2);
    expect(fallback.calls).toHaveLength(0);
    expect(events).toEqual([]);
  });

  it("switches on a fault, reports it by position, and stays switched", async () => {
    const primary = faulting("HTTP 503");
    const fallback = answering("0x2");
    const { events, onEvent } = collectEvents();
    const rpc = failoverRpcClient([primary.client, fallback.client], { onEvent });

    await expect(rpc.call("eth_blockNumber")).resolves.toBe("0x2");
    expect(events).toEqual([{ kind: "SWITCHED", from: 0, to: 1, reason: "eth_blockNumber failed: HTTP 503" }]);

    // ORDER IS PREFERENCE: after the switch the fallback is asked first, and the
    // demoted primary is not spent one wasted call per request.
    await expect(rpc.call("eth_getBalance", [WALLET, "0x1"])).resolves.toBe("0x2");
    expect(primary.calls).toEqual(["eth_blockNumber"]);
    expect(fallback.calls).toEqual(["eth_blockNumber", "eth_getBalance"]);
    expect(events).toHaveLength(1);
  });

  it("emits events without URLs even when the fault names one", async () => {
    const primary = faulting(`fetch failed: request to ${URL_WITH_KEY} failed`);
    const fallback = answering("0x2");
    const { events, onEvent } = collectEvents();
    const rpc = failoverRpcClient([primary.client, fallback.client], { onEvent });

    await rpc.call("eth_blockNumber");
    const only = events[0];
    if (only === undefined || only.kind !== "SWITCHED") throw new Error("expected a SWITCHED event");
    expect(only.reason).not.toContain(KEY);
    expect(only.reason).not.toContain("https://");
    expect(only.reason).toContain("fetch failed");
  });

  it("re-probes the preferred endpoint after probeAfterMs and recovers", async () => {
    let clock = 1_000_000;
    let primaryDown = true;
    const primary = endpoint((method, params) => {
      if (primaryDown) throw new RpcError(method, params, "HTTP 429");
      return "0x1";
    });
    const fallback = answering("0x2");
    const { events, onEvent } = collectEvents();
    const rpc = failoverRpcClient([primary.client, fallback.client], { probeAfterMs: 60_000, now: () => clock, onEvent });

    await expect(rpc.call("eth_blockNumber")).resolves.toBe("0x2"); // demoted at t=0
    primaryDown = false;

    clock += 59_999;
    await expect(rpc.call("eth_blockNumber")).resolves.toBe("0x2"); // not yet
    expect(primary.calls).toHaveLength(1);

    clock += 1;
    await expect(rpc.call("eth_blockNumber")).resolves.toBe("0x1"); // probed, answered
    expect(events).toEqual([
      { kind: "SWITCHED", from: 0, to: 1, reason: "eth_blockNumber failed: HTTP 429" },
      { kind: "RECOVERED", to: 0 },
    ]);

    clock += 1;
    await expect(rpc.call("eth_blockNumber")).resolves.toBe("0x1"); // back to normal service
    expect(primary.calls).toHaveLength(3);
    expect(fallback.calls).toHaveLength(2);
    expect(events).toHaveLength(2);
  });

  it("a failed probe re-arms the timer instead of flapping", async () => {
    let clock = 0;
    const primary = faulting("HTTP 503");
    const fallback = answering("0x2");
    const { events, onEvent } = collectEvents();
    const rpc = failoverRpcClient([primary.client, fallback.client], { probeAfterMs: 60_000, now: () => clock, onEvent });

    await rpc.call("eth_blockNumber"); // demoted at t=0
    clock = 60_000;
    await expect(rpc.call("eth_blockNumber")).resolves.toBe("0x2"); // probe fails, demoted again at t=60000
    expect(primary.calls).toHaveLength(2);
    expect(events.map((event) => event.kind)).toEqual(["SWITCHED", "SWITCHED"]);

    clock = 119_999;
    await rpc.call("eth_blockNumber");
    expect(primary.calls).toHaveLength(2); // not probed before the full interval since the LAST failure

    clock = 120_000;
    await rpc.call("eth_blockNumber");
    expect(primary.calls).toHaveLength(3);
  });

  it("propagates an answer of no without trying the fallback", async () => {
    const primary = faulting("execution reverted");
    const fallback = answering("0x2");
    const { events, onEvent } = collectEvents();
    const rpc = failoverRpcClient([primary.client, fallback.client], { onEvent });

    const failure = await rpc.call("eth_call", []).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RpcError);
    expect((failure as Error).message).toBe("eth_call failed: execution reverted");
    expect(fallback.calls).toHaveLength(0);
    expect(events).toEqual([]);
  });

  it("does not fail over on an unrecorded fixture request", async () => {
    const fallback = answering("0x2");
    const rpc = failoverRpcClient([fixtureRpcClient({}), fallback.client]);
    await expect(rpc.call("eth_blockNumber")).rejects.toBeInstanceOf(UnrecordedRequestError);
    expect(fallback.calls).toHaveLength(0);
  });

  it("reports ALL_FAILED, distinctly, when no endpoint can answer", async () => {
    const primary = faulting("HTTP 503");
    const fallback = faulting("fetch failed: connect ETIMEDOUT");
    const { events, onEvent } = collectEvents();
    const rpc = failoverRpcClient([primary.client, fallback.client], { onEvent });

    const failure = await rpc.call("eth_getLogs", [{ fromBlock: "0x1" }]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RpcError);
    if (!(failure instanceof RpcError)) throw new Error("unreachable");
    expect(failure.message).toBe(
      "eth_getLogs failed: all 2 endpoint(s) failed; last: eth_getLogs failed: fetch failed: connect ETIMEDOUT",
    );
    expect(failure.method).toBe("eth_getLogs");
    expect(events).toEqual([
      { kind: "ALL_FAILED", method: "eth_getLogs", reason: "eth_getLogs failed: fetch failed: connect ETIMEDOUT" },
    ]);
    expect(primary.calls).toHaveLength(1);
    expect(fallback.calls).toHaveLength(1);
  });

  it("survives a request whose serving endpoint dies mid-flight by wrapping around", async () => {
    let fallbackDown = false;
    const primary = answering("0x1");
    const fallback = endpoint((method, params) => {
      if (fallbackDown) throw new RpcError(method, params, "HTTP 502");
      return "0x2";
    });
    const { events, onEvent } = collectEvents();
    const clients = [faulting("HTTP 503").client, fallback.client, primary.client];
    const rpc = failoverRpcClient(clients, { onEvent });

    await expect(rpc.call("eth_blockNumber")).resolves.toBe("0x2"); // 0 faults → 1 serves
    fallbackDown = true;
    await expect(rpc.call("eth_blockNumber")).resolves.toBe("0x1"); // 1 faults → 2 serves
    expect(events.map((event) => event.kind)).toEqual(["SWITCHED", "SWITCHED"]);
    expect(events[1]).toEqual({ kind: "SWITCHED", from: 1, to: 2, reason: "eth_blockNumber failed: HTTP 502" });
  });

  it("serves the mainnet fixture through a dead primary", async () => {
    const { events, onEvent } = collectEvents();
    const rpc = failoverRpcClient([faulting("HTTP 429").client, fixtureRpcClient(fixture)], { onEvent });

    await expect(rpc.call<string>("eth_getTransactionCount", [WALLET, "0x150ec50"])).resolves.toBe("0x47");
    await expect(rpc.call<string>("eth_getBalance", [WALLET, "0x150ed52"])).resolves.toBe("0x6d0a1c54e7a666");
    expect(events).toEqual([{ kind: "SWITCHED", from: 0, to: 1, reason: "eth_getTransactionCount failed: HTTP 429" }]);
  });
});
