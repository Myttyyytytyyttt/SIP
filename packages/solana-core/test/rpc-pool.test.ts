// The endpoint pool: failover rules, the byte cap, and no URL in any message.

import { describe, expect, it } from "vitest";

import {
  ResponseTooLargeError,
  RpcAnswerError,
  RpcUnavailableError,
  UpstreamLeakError,
  createRpcPool,
} from "../src/server/rpc-pool";
import { SECRET_QUERY, UPSTREAM_1, UPSTREAM_2, fakeFetch, jsonResponse, rpcResult } from "./helpers";

const SECRETS = [SECRET_QUERY, "upstream.invalid", "second.invalid", "PATHTOKEN456", "https://"];

const expectClean = (text: string): void => {
  for (const secret of SECRETS) expect(text).not.toContain(secret);
};

describe("failover", () => {
  it("moves past an HTTP 429 to the next endpoint", async () => {
    const upstream = fakeFetch((call) => (call.url === UPSTREAM_1 ? new Response("slow down", { status: 429 }) : rpcResult(call, 42)));
    const pool = createRpcPool([UPSTREAM_1, UPSTREAM_2], { fetch: upstream.fetch });
    await expect(pool.call("getSlot", [])).resolves.toBe(42);
    expect(upstream.calls.map((call) => call.url)).toEqual([UPSTREAM_1, UPSTREAM_2]);
    expect(pool.coolingDown()).toEqual([0]);
  });

  it("treats a JSON-RPC rate limit as the endpoint's fault", async () => {
    const upstream = fakeFetch((call) =>
      call.url === UPSTREAM_1 ? jsonResponse({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: "Too many requests" } }) : rpcResult(call, "ok"),
    );
    const pool = createRpcPool([UPSTREAM_1, UPSTREAM_2], { fetch: upstream.fetch });
    await expect(pool.call("getSlot", [])).resolves.toBe("ok");
  });

  it("returns a genuine 'Computational budget exceeded' as an answer, without asking the next endpoint", async () => {
    const upstream = fakeFetch(() =>
      jsonResponse({ jsonrpc: "2.0", id: 1, error: { code: -32002, message: "Transaction simulation failed: Computational budget exceeded", data: { logs: ["x"] } } }),
    );
    const pool = createRpcPool([UPSTREAM_1, UPSTREAM_2], { fetch: upstream.fetch });
    const error = await pool.call("sendTransaction", ["AA=="]).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RpcAnswerError);
    expect((error as RpcAnswerError).code).toBe(-32002);
    expect((error as RpcAnswerError).data).toEqual({ logs: ["x"] });
    expect(upstream.calls).toHaveLength(1);
    expect(pool.coolingDown()).toEqual([]);
  });

  // -32015 in the node's own words: a transaction newer than the request's
  // maxSupportedTransactionVersion. It says "is not supported", and it is about
  // the REQUEST, so every endpoint gives the same answer.
  const versionRefused = (id: unknown) => ({
    jsonrpc: "2.0",
    id,
    error: {
      code: -32015,
      message: 'Transaction version (2) is not supported by the requesting client. Please try the request again with the following configuration parameter: "maxSupportedTransactionVersion": 2',
    },
  });

  it("returns a batch where EVERY member is -32015 as the members' own errors, and benches nobody", async () => {
    // Measured live on 2026-09-23: a page of one version 1 transaction, asked for
    // 0, benched mainnet's endpoint for 30 s and failed the whole page.
    const upstream = fakeFetch((call) => jsonResponse((call.body as { id: number }[]).map((member) => versionRefused(member.id))));
    const pool = createRpcPool([UPSTREAM_1, UPSTREAM_2], { fetch: upstream.fetch });
    const members = await pool.batch([
      { id: 1, method: "getTransaction", params: ["a", { maxSupportedTransactionVersion: 1 }] },
      { id: 2, method: "getTransaction", params: ["b", { maxSupportedTransactionVersion: 1 }] },
    ]);
    expect(members.map((member) => [member.id, member.error?.code])).toEqual([
      [1, -32015],
      [2, -32015],
    ]);
    expect(upstream.calls).toHaveLength(1);
    expect(pool.coolingDown()).toEqual([]);
  });

  it("throws a lone -32015 as the answer it is, without asking the next endpoint", async () => {
    const upstream = fakeFetch(() => jsonResponse(versionRefused(1)));
    const pool = createRpcPool([UPSTREAM_1, UPSTREAM_2], { fetch: upstream.fetch });
    const error = await pool.call("getTransaction", ["a", { maxSupportedTransactionVersion: 1 }]).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RpcAnswerError);
    expect((error as RpcAnswerError).code).toBe(-32015);
    expect(upstream.calls).toHaveLength(1);
    expect(pool.coolingDown()).toEqual([]);
  });

  it.each(["Method getProgramAccounts is not supported on this plan", "Unsupported method: getProgramAccounts"])(
    "still fails over on a method the endpoint does not serve (%s): only -32015 is exempted, and by its code",
    async (message) => {
      const upstream = fakeFetch((call) => (call.url === UPSTREAM_1 ? jsonResponse({ jsonrpc: "2.0", id: 1, error: { code: -32601, message } }) : rpcResult(call, [])));
      const pool = createRpcPool([UPSTREAM_1, UPSTREAM_2], { fetch: upstream.fetch });
      await expect(pool.call("getProgramAccounts", ["x"])).resolves.toEqual([]);
      expect(pool.coolingDown()).toEqual([0]);
    },
  );

  it("names every refusal by position and never by URL, host or key", async () => {
    const upstream = fakeFetch((call) => {
      if (call.url === UPSTREAM_1) throw new TypeError(`connect ECONNREFUSED ${UPSTREAM_1}`);
      return new Response(`bad gateway for ${UPSTREAM_2}`, { status: 502 });
    });
    const pool = createRpcPool([UPSTREAM_1, UPSTREAM_2], { fetch: upstream.fetch });
    const error = await pool.call("getSlot", []).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RpcUnavailableError);
    const message = (error as Error).message;
    expect(message).toContain("every Solana endpoint refused");
    expect(message).toContain("endpoint 1/2 TypeError");
    expect(message).toContain("endpoint 2/2 HTTP 502");
    expectClean(message);
    expectClean(JSON.stringify(pool));
  });

  it("scrubs URLs and key parts out of an upstream error message", async () => {
    const upstream = fakeFetch(() => jsonResponse({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: `invalid param at ${UPSTREAM_1} key ${SECRET_QUERY}` } }));
    const pool = createRpcPool([UPSTREAM_1], { fetch: upstream.fetch });
    const error = (await pool.call("getBalance", ["x"]).catch((caught: unknown) => caught)) as Error;
    expect(error).toBeInstanceOf(RpcAnswerError);
    expectClean(error.message);
  });

  it("keys its cooldown by position and retries a benched endpoint after 30 s", async () => {
    let clock = 1_000;
    let failFirst = true;
    const upstream = fakeFetch((call) => (call.url === UPSTREAM_1 && failFirst ? new Response("", { status: 503 }) : rpcResult(call, call.url === UPSTREAM_1 ? 1 : 2)));
    const pool = createRpcPool([UPSTREAM_1, UPSTREAM_2], { fetch: upstream.fetch, now: () => clock });
    expect(await pool.call("getSlot", [])).toBe(2);
    failFirst = false;
    expect(await pool.call("getSlot", [])).toBe(2);
    expect(upstream.calls.map((call) => call.url)).toEqual([UPSTREAM_1, UPSTREAM_2, UPSTREAM_2]);
    clock += 30_001;
    expect(await pool.call("getSlot", [])).toBe(1);
    expect(pool.coolingDown()).toEqual([]);
  });

  it("treats a non-array batch answer as the endpoint's fault", async () => {
    const upstream = fakeFetch((call) => (call.url === UPSTREAM_1 ? jsonResponse({ jsonrpc: "2.0", id: null, error: { message: "batch disabled" } }) : jsonResponse([{ jsonrpc: "2.0", id: 1, result: 9 }])));
    const pool = createRpcPool([UPSTREAM_1, UPSTREAM_2], { fetch: upstream.fetch });
    expect(await pool.batch([{ id: 1, method: "getSlot", params: [] }])).toEqual([{ jsonrpc: "2.0", id: 1, result: 9 }]);
  });
});

describe("the response cap", () => {
  it("aborts a streamed 3 MiB relay answer at 2 MiB, reading no further", async () => {
    let enqueued = 0;
    let cancelled = false;
    const upstream = fakeFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (enqueued >= 3 * 1024 * 1024) {
                controller.close();
                return;
              }
              enqueued += 64 * 1024;
              controller.enqueue(new Uint8Array(64 * 1024).fill(32));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200 },
        ),
    );
    const pool = createRpcPool([UPSTREAM_1, UPSTREAM_2], { fetch: upstream.fetch });
    await expect(pool.relay('{"jsonrpc":"2.0","id":1,"method":"getSlot","params":[]}')).rejects.toBeInstanceOf(ResponseTooLargeError);
    expect(cancelled).toBe(true);
    expect(enqueued).toBeLessThan(2.5 * 1024 * 1024);
    // Too large is the answer's size, not the endpoint's health: nobody is benched or retried.
    expect(upstream.calls).toHaveLength(1);
    expect(pool.coolingDown()).toEqual([]);
  });

  it("refuses a declared Content-Length over the cap without reading the body", async () => {
    const upstream = fakeFetch(() => new Response("{}", { status: 200, headers: { "content-length": String(3 * 1024 * 1024) } }));
    const pool = createRpcPool([UPSTREAM_1], { fetch: upstream.fetch });
    await expect(pool.relay("{}")).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  it("lets a relay caller lower its cap, never raise it past 2 MiB", async () => {
    const size = { bytes: 100 * 1024 };
    const upstream = fakeFetch(() => new Response(`"${"x".repeat(size.bytes)}"`, { status: 200 }));
    const pool = createRpcPool([UPSTREAM_1], { fetch: upstream.fetch });
    await expect(pool.relay("{}", { maxResponseBytes: 64 * 1024 })).rejects.toBeInstanceOf(ResponseTooLargeError);
    await expect(pool.relay("{}", { maxResponseBytes: 256 * 1024 })).resolves.toMatchObject({ status: 200 });
    size.bytes = 3 * 1024 * 1024;
    await expect(pool.relay("{}", { maxResponseBytes: 8 * 1024 * 1024 })).rejects.toBeInstanceOf(ResponseTooLargeError);
  });
});

describe("relay", () => {
  it("returns the upstream text on success", async () => {
    const upstream = fakeFetch(() => new Response('{"jsonrpc":"2.0","id":"1","result":{"value":{"blockhash":"abc"}}}', { status: 200 }));
    const pool = createRpcPool([UPSTREAM_1], { fetch: upstream.fetch });
    await expect(pool.relay('{"jsonrpc":"2.0","id":"1","method":"getLatestBlockhash","params":[]}')).resolves.toEqual({
      status: 200,
      text: '{"jsonrpc":"2.0","id":"1","result":{"value":{"blockhash":"abc"}}}',
    });
    expect(upstream.calls[0]!.text).toBe('{"jsonrpc":"2.0","id":"1","method":"getLatestBlockhash","params":[]}');
  });

  it("withholds an answer that quotes a registered endpoint part", async () => {
    const upstream = fakeFetch(() => jsonResponse({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: `your key ${SECRET_QUERY} is wrong` } }));
    const pool = createRpcPool([UPSTREAM_1], { fetch: upstream.fetch });
    await expect(pool.relay("{}")).rejects.toBeInstanceOf(UpstreamLeakError);
  });

  it("fails over when every member of a batch is rate limited", async () => {
    const upstream = fakeFetch((call) =>
      call.url === UPSTREAM_1 ? jsonResponse([{ jsonrpc: "2.0", id: 1, error: { code: -32005, message: "rate limit" } }]) : jsonResponse([{ jsonrpc: "2.0", id: 1, result: 1 }]),
    );
    const pool = createRpcPool([UPSTREAM_1, UPSTREAM_2], { fetch: upstream.fetch });
    expect((await pool.relay("[]")).text).toBe('[{"jsonrpc":"2.0","id":1,"result":1}]');
  });
});
