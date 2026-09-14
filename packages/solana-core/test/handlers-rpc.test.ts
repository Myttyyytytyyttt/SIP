// /api/solana-rpc through createSolanaRpcHandler, with a stub upstream and a fake clock.

import { describe, expect, it } from "vitest";

import { SIP_PROGRAM_ID } from "../src/client/idl";
import { loadSolanaServerSettings } from "../src/server/config";
import { RELAY_MAX_IN_FLIGHT, RELAY_MAX_IN_FLIGHT_PER_CLIENT, createSolanaRpcHandler, type RefusalEvent, type SolanaGate } from "../src/server/handlers";
import { CLIENT_AGGREGATE_FACTOR, createWeightedLimiter } from "../src/server/rate-limit";
import { SECRET_QUERY, UPSTREAM_1, fakeFetch, rpcResult, type UpstreamCall } from "./helpers";

const load = loadSolanaServerSettings({ SIP_SOLANA_RPC_URLS: UPSTREAM_1, SIP_SOLANA_PROGRAM_ID: SIP_PROGRAM_ID, SIP_TRUSTED_CLIENT_IP_HEADER: "x-envoy-external-address" });
if (!load.ok) throw new Error("test settings must load");
const OK_GATE: SolanaGate = { kind: "ok", settings: load.settings };
const PER_CLIENT = load.settings.relay.perClientPerMin;

const tx = Buffer.alloc(200, 1).toString("base64");
const blockhashCall = (id: string | number = 1): Record<string, unknown> => ({ jsonrpc: "2.0", id, method: "getLatestBlockhash", params: [{ commitment: "confirmed" }] });
const slotCall = (id: string | number = 1): Record<string, unknown> => ({ jsonrpc: "2.0", id, method: "getSlot", params: [] });
/** Ten getGenesisHash calls: weight 10, all signing. */
const genesisBatch = Array.from({ length: 10 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "getGenesisHash", params: [] }));

function post(body: unknown, headers: Record<string, string> = {}, ip = "203.0.113.10"): Request {
  return new Request("https://sip.example/api/solana-rpc", {
    method: "POST",
    headers: { "content-type": "application/json", "x-envoy-external-address": ip, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

interface SetupOptions {
  gate?: SolanaGate;
  respond?: (call: UpstreamCall) => Response | Promise<Response>;
  signingCapacity?: number;
  readsCapacity?: number;
  maxInFlight?: number;
}

function setup(options: SetupOptions = {}) {
  let clock = 0;
  const events: RefusalEvent[] = [];
  const upstream = fakeFetch(options.respond ?? ((call) => rpcResult(call, { context: { slot: 1 }, value: { blockhash: "abc", lastValidBlockHeight: 10 } })));
  const handler = createSolanaRpcHandler({
    gate: () => options.gate ?? OK_GATE,
    fetch: upstream.fetch,
    now: () => clock,
    onRefusal: (event) => events.push(event),
    ...(options.signingCapacity === undefined ? {} : { signingBudget: createWeightedLimiter({ capacity: options.signingCapacity }) }),
    ...(options.readsCapacity === undefined ? {} : { readsBudget: createWeightedLimiter({ capacity: options.readsCapacity }) }),
    ...(options.maxInFlight === undefined ? {} : { maxInFlight: options.maxInFlight }),
  });
  return { handler, upstream, events, advance: (ms: number) => (clock += ms) };
}

const bodies: string[] = [];
async function read(response: Response): Promise<{ status: number; json: { error?: { code: number; message: string }; id?: unknown } & Record<string, unknown>; text: string; headers: Headers }> {
  const text = await response.text();
  bodies.push(text, JSON.stringify([...response.headers]));
  return { status: response.status, json: JSON.parse(text) as never, text, headers: response.headers };
}

/** An upstream whose answers wait until the test releases them, so what is open at once can be counted. */
function heldUpstream() {
  const waiting: (() => void)[] = [];
  let open = 0;
  let peak = 0;
  return {
    respond: async (call: UpstreamCall): Promise<Response> => {
      open += 1;
      peak = Math.max(peak, open);
      await new Promise<void>((resolve) => waiting.push(resolve));
      open -= 1;
      return rpcResult(call, 1);
    },
    release: (): void => {
      for (const go of waiting.splice(0)) go();
    },
    get waiting(): number {
      return waiting.length;
    },
    get peak(): number {
      return peak;
    },
  };
}

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 2_000; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("the gate", () => {
  it("answers 404 when SIP_CHAIN is not solana, and 503 without detail when the settings are invalid", async () => {
    const disabled = await read(await setup({ gate: { kind: "disabled" } }).handler.POST(post(blockhashCall())));
    expect(disabled.status).toBe(404);
    const invalid = await read(await setup({ gate: { kind: "invalid" } }).handler.POST(post(blockhashCall())));
    expect(invalid.status).toBe(503);
    expect(invalid.text).not.toMatch(/SIP_|NUVEM_|variable/);
  });

  it("answers GET with 405", async () => {
    expect((await read(setup().handler.GET())).status).toBe(405);
  });
});

describe("a relayed call", () => {
  it("returns the upstream answer and forwards the re-serialised call", async () => {
    const { handler, upstream } = setup();
    const response = await read(await handler.POST(post('{"id":"7","method":"getLatestBlockhash","jsonrpc":"2.0","params":[{"commitment":"confirmed"}]}')));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]!.text).toBe('{"jsonrpc":"2.0","id":"7","method":"getLatestBlockhash","params":[{"commitment":"confirmed"}]}');
  });
});

describe("refused before any upstream call", () => {
  it.each([
    ["text/plain (a CORS-simple POST)", { "content-type": "text/plain" }, 415],
    ["no content type", { "content-type": "" }, 415],
    ["sec-fetch-site: cross-site", { "sec-fetch-site": "cross-site" }, 403],
  ])("%s", async (_, table, status) => {
    const headers = table as Record<string, string>;
    const { handler, upstream } = setup();
    const request = post(blockhashCall(), headers);
    if (headers["content-type"] === "") request.headers.delete("content-type");
    expect((await read(await handler.POST(request))).status).toBe(status);
    expect(upstream.calls).toHaveLength(0);
  });

  it("a declared Content-Length over 64 KiB is 413 without reading the body", async () => {
    const { handler, upstream } = setup();
    const exploding = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("the body was read");
      },
    });
    const fake = { headers: new Headers({ "content-type": "application/json", "content-length": "70000", "x-envoy-external-address": "203.0.113.1" }), body: exploding } as unknown as Request;
    expect((await read(await handler.POST(fake))).status).toBe(413);
    expect(upstream.calls).toHaveLength(0);
  });

  it("an undeclared body over 64 KiB is 413; invalid JSON is 400 -32700", async () => {
    const { handler, upstream } = setup();
    expect((await read(await handler.POST(post(`[${" ".repeat(64 * 1024)}]`)))).status).toBe(413);
    const bad = await read(await handler.POST(post("{not json")));
    expect([bad.status, bad.json.error?.code]).toEqual([400, -32700]);
    expect(upstream.calls).toHaveLength(0);
  });

  it("a batch of 11 is 413; sendTransaction is 403 with its id; getProgramAccounts is 403", async () => {
    const { handler, upstream } = setup();
    expect((await read(await handler.POST(post(Array.from({ length: 11 }, (_, i) => blockhashCall(i)))))).status).toBe(413);
    const send = await read(await handler.POST(post({ jsonrpc: "2.0", id: 99, method: "sendTransaction", params: [tx] })));
    expect([send.status, send.json.error?.code, send.json.id]).toEqual([403, -32601, 99]);
    expect((await read(await handler.POST(post({ jsonrpc: "2.0", id: 1, method: "getProgramAccounts", params: [SIP_PROGRAM_ID, {}] })))).status).toBe(403);
    expect(upstream.calls).toHaveLength(0);
  });
});

describe("rate limits", () => {
  it("the defaults: 60 per client, and a global budget 25 or more clients deep", () => {
    expect(PER_CLIENT).toBe(60);
    expect(load.settings.relay.signingGlobalPerMin / PER_CLIENT).toBeGreaterThanOrEqual(25);
    expect(load.settings.relay.readsGlobalPerMin / PER_CLIENT).toBeGreaterThanOrEqual(25);
  });

  it("the call past the per-client allowance within a minute is 429 with retry-after; another client still passes", async () => {
    const { handler } = setup();
    for (let i = 0; i < PER_CLIENT; i++) expect((await handler.POST(post(blockhashCall(i)))).status).toBe(200);
    const limited = await read(await handler.POST(post(blockhashCall(PER_CLIENT + 1))));
    expect([limited.status, limited.json.error?.code]).toEqual([429, -32005]);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect((await handler.POST(post(blockhashCall(), {}, "198.51.100.20"))).status).toBe(200);
  });

  it("charges weights: two batches of ten simulations spend the 60-token bucket", async () => {
    const { handler } = setup({ signingCapacity: 10_000 });
    const batch = Array.from({ length: 10 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "simulateTransaction", params: [tx, { encoding: "base64", sigVerify: false }] }));
    for (let i = 0; i < PER_CLIENT / 30; i++) expect((await handler.POST(post(batch))).status).toBe(200);
    expect((await handler.POST(post(batch))).status).toBe(429);
  });

  it("rotating a spoofable header does not mint buckets", async () => {
    const { handler } = setup();
    let limited = 0;
    for (let i = 0; i < 130; i++) {
      const response = await handler.POST(post(blockhashCall(i), { "cf-connecting-ip": `198.51.100.${i % 250}`, "x-forwarded-for": `10.0.${i}.1` }));
      if (response.status === 429) limited += 1;
    }
    expect(limited).toBe(130 - PER_CLIENT);
  });

  it("the /64s of one /48 share a network bucket and are refused together; another /48 is not", async () => {
    const { handler } = setup();
    const statuses: number[][] = [];
    for (let subnet = 1; subnet <= CLIENT_AGGREGATE_FACTOR + 1; subnet++) {
      const mine: number[] = [];
      for (let i = 0; i < PER_CLIENT / 10; i++) mine.push((await handler.POST(post(genesisBatch, {}, `2001:db8:0:ab0${subnet}::1`))).status);
      statuses.push(mine);
    }
    expect(statuses.slice(0, CLIENT_AGGREGATE_FACTOR).flat().every((status) => status === 200)).toBe(true);
    expect(statuses[CLIENT_AGGREGATE_FACTOR]!.every((status) => status === 429)).toBe(true);
    expect((await handler.POST(post(blockhashCall(), {}, "2001:db8:0:ab09::1"))).status).toBe(429);
    expect((await handler.POST(post(blockhashCall(), {}, "2001:db8:1:ab01::1"))).status).toBe(200);
  });

  it("with the default limits, five /48s each spending every /64's whole allowance leave signing open for a sixth client", async () => {
    const { handler } = setup();
    for (let network = 1; network <= 5; network++) {
      for (let subnet = 1; subnet <= CLIENT_AGGREGATE_FACTOR; subnet++) {
        for (let i = 0; i < PER_CLIENT / 10; i++) expect((await handler.POST(post(genesisBatch, {}, `2001:db8:${network}:${subnet}::1`))).status).toBe(200);
      }
    }
    const victim = await read(await handler.POST(post(blockhashCall(), {}, "198.51.100.8")));
    expect(victim.status).toBe(200);
    const fee = await read(await handler.POST(post({ jsonrpc: "2.0", id: 2, method: "getFeeForMessage", params: [tx] }, {}, "198.51.100.9")));
    expect(fee.status).toBe(200);
  });

  it("the signing budget is process-wide, and exhausted reads never starve signing", async () => {
    const signing = setup({ signingCapacity: 30 });
    const sims = Array.from({ length: 10 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "simulateTransaction", params: [tx, { encoding: "base64" }] }));
    expect((await signing.handler.POST(post(sims, {}, "203.0.113.1"))).status).toBe(200);
    expect((await signing.handler.POST(post(sims, {}, "203.0.113.2"))).status).toBe(429);

    const reads = setup({ readsCapacity: 30 });
    const accounts = Array.from({ length: 10 }, (_, i) => ({
      jsonrpc: "2.0",
      id: i,
      method: "getTokenAccountsByOwner",
      params: ["11111111111111111111111111111111", { mint: "11111111111111111111111111111111" }, { encoding: "jsonParsed" }],
    }));
    expect((await reads.handler.POST(post(accounts, {}, "203.0.113.3"))).status).toBe(200);
    expect((await reads.handler.POST(post(accounts, {}, "203.0.113.4"))).status).toBe(429);
    expect((await reads.handler.POST(post(blockhashCall(), {}, "203.0.113.5"))).status).toBe(200);
  });

  it("refills with time", async () => {
    const { handler, advance } = setup();
    for (let i = 0; i < PER_CLIENT; i++) await handler.POST(post(blockhashCall(i)));
    expect((await handler.POST(post(blockhashCall()))).status).toBe(429);
    advance(1_000);
    expect((await handler.POST(post(blockhashCall()))).status).toBe(200);
  });
});

describe("in flight", () => {
  it(`never has more than ${RELAY_MAX_IN_FLIGHT} upstream relays open at once; the rest are 503 with retry-after at once`, async () => {
    const held = heldUpstream();
    const { handler, upstream } = setup({ respond: held.respond });
    const settled: Response[] = [];
    const all = Array.from({ length: 50 }, (_, i) =>
      handler.POST(post(slotCall(i), {}, `10.${i}.0.1`)).then((response) => {
        settled.push(response);
        return response;
      }),
    );
    await until(() => held.waiting === RELAY_MAX_IN_FLIGHT && settled.length === 50 - RELAY_MAX_IN_FLIGHT, "the relay to fill");
    expect(upstream.calls).toHaveLength(RELAY_MAX_IN_FLIGHT);
    for (const response of settled) {
      const busy = await read(response);
      expect([busy.status, busy.json.error?.code, busy.headers.get("retry-after")]).toEqual([503, -32005, "1"]);
    }
    held.release();
    const statuses = (await Promise.all(all)).map((response) => response.status);
    expect(statuses.filter((status) => status === 200)).toHaveLength(RELAY_MAX_IN_FLIGHT);
    expect(held.peak).toBe(RELAY_MAX_IN_FLIGHT);

    // Every slot came back.
    const again = Array.from({ length: RELAY_MAX_IN_FLIGHT }, (_, i) => handler.POST(post(slotCall(i), {}, `10.${i}.1.1`)));
    await until(() => held.waiting === RELAY_MAX_IN_FLIGHT, "the relay to fill again");
    held.release();
    expect((await Promise.all(again)).every((response) => response.status === 200)).toBe(true);
    expect(held.peak).toBe(RELAY_MAX_IN_FLIGHT);
  });

  it(`holds one client to ${RELAY_MAX_IN_FLIGHT_PER_CLIENT} open relays (429 with retry-after); another client still reaches the upstream`, async () => {
    const held = heldUpstream();
    const { handler, upstream } = setup({ respond: held.respond });
    const settled: Response[] = [];
    const mine = Array.from({ length: RELAY_MAX_IN_FLIGHT_PER_CLIENT + 1 }, (_, i) =>
      handler.POST(post(slotCall(i), {}, "203.0.113.50")).then((response) => {
        settled.push(response);
        return response;
      }),
    );
    await until(() => held.waiting === RELAY_MAX_IN_FLIGHT_PER_CLIENT && settled.length === 1, "one client's slots to fill");
    const refused = await read(settled[0]!);
    expect([refused.status, refused.json.error?.code, refused.headers.get("retry-after")]).toEqual([429, -32005, "1"]);
    const other = handler.POST(post(slotCall(99), {}, "198.51.100.50"));
    await until(() => held.waiting === RELAY_MAX_IN_FLIGHT_PER_CLIENT + 1, "the other client to reach the upstream");
    held.release();
    expect((await other).status).toBe(200);
    expect((await Promise.all(mine)).filter((response) => response.status === 200)).toHaveLength(RELAY_MAX_IN_FLIGHT_PER_CLIENT);
    expect(upstream.calls).toHaveLength(RELAY_MAX_IN_FLIGHT_PER_CLIENT + 1);
  });

  it("gives the slot back when the upstream fails and when a budget refuses", async () => {
    let fail = true;
    const { handler } = setup({
      maxInFlight: 1,
      signingCapacity: 30,
      respond: (call) => {
        if (fail) throw new Error("socket hang up");
        return rpcResult(call, 1);
      },
    });
    expect((await handler.POST(post(slotCall(1), {}, "203.0.113.60"))).status).toBe(502);
    fail = false;
    const sims = Array.from({ length: 10 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "simulateTransaction", params: [tx, { encoding: "base64" }] }));
    expect((await handler.POST(post(sims, {}, "198.51.100.61"))).status).toBe(200);
    expect((await handler.POST(post(sims, {}, "192.0.2.62"))).status).toBe(429);
    expect((await handler.POST(post(slotCall(2), {}, "10.9.9.63"))).status).toBe(200);
  });
});

describe("response caps", () => {
  const padded = (bytes: { value: number }) => (call: UpstreamCall) => rpcResult(call, { context: { slot: 1 }, value: { padding: "A".repeat(bytes.value) } });
  const accountCall = { jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [SIP_PROGRAM_ID, { encoding: "base64" }] };

  it("a 300 KiB getAccountInfo answer is 502 too large; a 64 KiB one passes", async () => {
    const size = { value: 300 * 1024 };
    const { handler } = setup({ respond: padded(size) });
    const big = await read(await handler.POST(post(accountCall, {}, "203.0.113.71")));
    expect([big.status, big.json.error?.code]).toEqual([502, -32603]);
    expect(big.json.error?.message).toContain("too large");
    size.value = 64 * 1024;
    expect((await handler.POST(post(accountCall, {}, "198.51.100.72"))).status).toBe(200);
  });

  it("a blockhash may not come back as 100 KiB, but a batch of two may: a body's cap is its calls' caps summed", async () => {
    const size = { value: 100 * 1024 };
    const { handler } = setup({ respond: padded(size) });
    expect((await read(await handler.POST(post(blockhashCall(), {}, "203.0.113.73")))).status).toBe(502);
    expect((await handler.POST(post([blockhashCall(1), blockhashCall(2)], {}, "198.51.100.74"))).status).toBe(200);
  });

  it("the old 2 MiB oversized answer is still 502", async () => {
    const { handler } = setup({ respond: () => new Response("x".repeat(2 * 1024 * 1024 + 1), { status: 200 }) });
    const response = await read(await handler.POST(post(blockhashCall())));
    expect(response.status).toBe(502);
    expect(response.json.error?.message).toContain("too large");
  });
});

describe("upstream failures and secrecy", () => {
  it("an upstream error quoting the URL is 502 with no trace of it", async () => {
    const { handler, events } = setup({
      respond: () => {
        throw new Error(`connect ECONNREFUSED ${UPSTREAM_1}`);
      },
    });
    const response = await read(await handler.POST(post(blockhashCall())));
    expect([response.status, response.json.error?.code]).toEqual([502, -32603]);
    expect(response.text).not.toContain(SECRET_QUERY);
    expect(response.text).not.toContain("upstream.invalid");
    expect(JSON.stringify(events)).not.toContain(SECRET_QUERY);
  });

  it("no response on any path carried the endpoint key", () => {
    expect(bodies.length).toBeGreaterThan(10);
    for (const body of bodies) {
      expect(body).not.toContain(SECRET_QUERY);
      expect(body).not.toContain("upstream.invalid");
    }
  });
});
