// /api/solana-tx through createSolanaTxHandler, with a stub upstream.

import { SystemProgram } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { SIP_PROGRAM_ID } from "../src/client/idl";
import { buildLinkWallet } from "../src/server/builders";
import { loadSolanaServerSettings } from "../src/server/config";
import { createSolanaTxHandler, type SolanaGate, type SolanaTxHandlerOptions } from "../src/server/handlers";
import { CLIENT_AGGREGATE_FACTOR, createWeightedLimiter } from "../src/server/rate-limit";
import { verifySignedTransaction } from "../src/server/verify-tx";
import { BLOCKHASH, SECRET_QUERY, UPSTREAM_1, b64, fakeFetch, jsonResponse, keypair, legacyTx, rpcResult, signWire, type UpstreamCall } from "./helpers";

const load = loadSolanaServerSettings({ SIP_SOLANA_RPC_URLS: UPSTREAM_1, SIP_SOLANA_PROGRAM_ID: SIP_PROGRAM_ID, SIP_TRUSTED_CLIENT_IP_HEADER: "x-envoy-external-address" });
if (!load.ok) throw new Error("test settings must load");
const OK_GATE: SolanaGate = { kind: "ok", settings: load.settings };
const SEND = load.settings.send;

const method = (call: UpstreamCall): string => (call.body as { method: string }).method;

function signedLink(): { base64: string; signature: string } {
  const owner = keypair();
  const wallet = keypair();
  const bytes = signWire(buildLinkWallet({ owner: owner.publicKey, wallet: wallet.publicKey, blockhash: BLOCKHASH }).txBase64, owner, wallet);
  const verified = verifySignedTransaction(bytes);
  if (!verified.ok) throw new Error(verified.detail);
  return { base64: b64(bytes), signature: verified.signature };
}

/** A signed System transfer: it never verifies (program_not_allowed). */
function signedTransfer(): string {
  const payer = keypair();
  return b64(legacyTx(payer.publicKey, [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: keypair().publicKey, lamports: 1 })], [payer]));
}

function post(body: unknown, headers: Record<string, string> = {}, ip = "203.0.113.10"): Request {
  return new Request("https://sip.example/api/solana-tx", {
    method: "POST",
    headers: { "content-type": "application/json", "x-envoy-external-address": ip, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

type Extra = Omit<SolanaTxHandlerOptions, "gate" | "fetch" | "now" | "onRefusal">;

function setup(respond: (call: UpstreamCall, signature: string) => Response, gate: SolanaGate = OK_GATE, extra: Extra = {}) {
  const link = signedLink();
  const upstream = fakeFetch((call) => respond(call, link.signature));
  const handler = createSolanaTxHandler({ gate: () => gate, fetch: upstream.fetch, now: () => 0, onRefusal: () => undefined, ...extra });
  return { handler, upstream, link };
}

const happy = (call: UpstreamCall, signature: string): Response =>
  method(call) === "simulateTransaction" ? rpcResult(call, { context: { slot: 321 }, value: { err: null, logs: ["Program log: Instruction: LinkWallet"], unitsConsumed: 5_000 } }) : rpcResult(call, signature);

type TxError = { code: string; message: string; logs?: string[]; signature?: string; explorerUrl?: string };

async function read(response: Response): Promise<{ status: number; json: { error?: TxError } & Record<string, unknown>; text: string }> {
  const text = await response.text();
  return { status: response.status, json: JSON.parse(text) as never, text };
}

describe("send", () => {
  it("a two-signer link is simulated with sigVerify, then sent without preflight, and answered with its signature", async () => {
    const { handler, upstream, link } = setup(happy);
    const response = await read(await handler.POST(post({ action: "send", signedTxBase64: link.base64 })));
    expect(response.status).toBe(200);
    expect(response.json).toEqual({ signature: link.signature, slot: 321, unitsConsumed: 5_000, explorerUrl: `https://solscan.io/tx/${link.signature}` });
    expect(upstream.calls.map(method)).toEqual(["simulateTransaction", "sendTransaction"]);
    const [simulate, send] = upstream.calls.map((call) => (call.body as { params: [string, Record<string, unknown>] }).params);
    expect(simulate![0]).toBe(link.base64);
    expect(simulate![1]).toMatchObject({ sigVerify: true, replaceRecentBlockhash: false });
    expect(send![1]).toMatchObject({ skipPreflight: true });
  });

  it("a failed simulation is 422 simulation_failed with logs, and nothing is sent", async () => {
    const { handler, upstream, link } = setup((call) => rpcResult(call, { context: { slot: 1 }, value: { err: { InstructionError: [0, { Custom: 6000 }] }, logs: ["Program log: nope"] } }));
    const response = await read(await handler.POST(post({ action: "send", signedTxBase64: link.base64 })));
    expect([response.status, response.json.error?.code]).toEqual([422, "simulation_failed"]);
    expect(response.json.error?.logs).toEqual(["Program log: nope"]);
    expect(upstream.calls.map(method)).toEqual(["simulateTransaction"]);
  });

  it("an expired blockhash tells the client to rebuild", async () => {
    const { handler, link } = setup((call) => rpcResult(call, { context: { slot: 1 }, value: { err: "BlockhashNotFound", logs: [] } }));
    const response = await read(await handler.POST(post({ action: "send", signedTxBase64: link.base64 })));
    expect([response.status, response.json.error?.code]).toEqual([422, "simulation_failed"]);
    expect(response.json.error?.message).toContain("rebuild");
  });

  it("a refused transaction (a System transfer) is 422 program_not_allowed with no upstream call", async () => {
    const { handler, upstream } = setup(happy);
    const response = await read(await handler.POST(post({ action: "send", signedTxBase64: signedTransfer() })));
    expect([response.status, response.json.error?.code]).toEqual([422, "program_not_allowed"]);
    expect(upstream.calls).toHaveLength(0);
  });

  it("the 7th send from one client within a minute is 429", async () => {
    const { handler } = setup(happy);
    for (let i = 0; i < SEND.perClientPerMin; i++) expect((await handler.POST(post({ action: "nothing" }))).status).toBe(400);
    const limited = await handler.POST(post({ action: "nothing" }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).not.toBeNull();
    expect((await handler.POST(post({ action: "nothing" }, {}, "198.51.100.1"))).status).toBe(400);
  });

  it.each([
    ["a build action (not in this task)", { action: "buildLinkWallet" }],
    ["an extra field", { action: "send", signedTxBase64: "AA==", owner: "x" }],
    ["non-base64", { action: "send", signedTxBase64: "!!!" }],
    ["base64 over 1644 characters", { action: "send", signedTxBase64: "A".repeat(1648) }],
    ["an array body", [1]],
  ])("%s is 400 bad_request", async (_, body) => {
    const { handler, upstream } = setup(happy);
    const response = await read(await handler.POST(post(body)));
    expect([response.status, response.json.error?.code]).toEqual([400, "bad_request"]);
    expect(upstream.calls).toHaveLength(0);
  });

  it("text/plain is 415, cross-site is 403, a body over 4096 bytes is 413, GET is 405, off-chain is 404", async () => {
    const { handler, upstream, link } = setup(happy);
    expect((await handler.POST(post({ action: "send", signedTxBase64: link.base64 }, { "content-type": "text/plain" }))).status).toBe(415);
    expect((await handler.POST(post({ action: "send", signedTxBase64: link.base64 }, { "sec-fetch-site": "cross-site" }))).status).toBe(403);
    expect((await handler.POST(post({ action: "send", signedTxBase64: link.base64, pad: "x".repeat(5_000) }))).status).toBe(413);
    expect(handler.GET().status).toBe(405);
    expect(upstream.calls).toHaveLength(0);
    const off = setup(happy, { kind: "disabled" });
    const response = await read(await off.handler.POST(post({ action: "send", signedTxBase64: link.base64 })));
    expect([response.status, response.json.error?.code]).toEqual([404, "not_enabled"]);
  });
});

describe("the send budgets", () => {
  it("junk from enough clients to spend the whole global budget spends none of it: a verified send from a fresh client still goes out", async () => {
    const { handler, upstream, link } = setup(happy);
    const clients = Math.ceil(SEND.globalPerMin / SEND.perClientPerMin) + 1;
    for (let client = 0; client < clients; client++) {
      // One address per /24, so neither a client bucket nor a network bucket is what refuses.
      for (let i = 0; i < SEND.perClientPerMin; i++) expect((await handler.POST(post({ action: "nothing" }, {}, `10.${client}.0.1`))).status).toBe(400);
    }
    const response = await read(await handler.POST(post({ action: "send", signedTxBase64: link.base64 }, {}, "198.51.100.77")));
    expect(response.status).toBe(200);
    expect(upstream.calls.map(method)).toEqual(["simulateTransaction", "sendTransaction"]);
  });

  it("the same with 60 junk bodies from 10 clients against a 60-send global budget", async () => {
    const { handler, upstream, link } = setup(happy, OK_GATE, { budget: createWeightedLimiter({ capacity: 60 }) });
    for (let client = 0; client < 10; client++) {
      for (let i = 0; i < 6; i++) expect((await handler.POST(post({ action: "nothing" }, {}, `10.${client}.0.1`))).status).toBe(400);
    }
    expect((await handler.POST(post({ action: "send", signedTxBase64: link.base64 }, {}, "198.51.100.77"))).status).toBe(200);
    expect(upstream.calls.map(method)).toEqual(["simulateTransaction", "sendTransaction"]);
  });

  it("a verification refusal spends no global budget; a verified send does", async () => {
    const { handler, upstream, link } = setup(happy, OK_GATE, { budget: createWeightedLimiter({ capacity: 1 }) });
    const refused = await read(await handler.POST(post({ action: "send", signedTxBase64: signedTransfer() }, {}, "203.0.113.1")));
    expect([refused.status, refused.json.error?.code]).toEqual([422, "program_not_allowed"]);
    expect((await handler.POST(post({ action: "send", signedTxBase64: link.base64 }, {}, "198.51.100.2"))).status).toBe(200);
    const spent = await handler.POST(post({ action: "send", signedTxBase64: link.base64 }, {}, "192.0.2.3"));
    const body = await read(spent);
    expect([body.status, body.json.error?.code]).toEqual([429, "rate_limited"]);
    expect(spent.headers.get("retry-after")).not.toBeNull();
    expect(upstream.calls.map(method)).toEqual(["simulateTransaction", "sendTransaction"]);
  });

  it("the /64s of one /48 share a network bucket; another /48 does not", async () => {
    const { handler } = setup(happy);
    const network = CLIENT_AGGREGATE_FACTOR * SEND.perClientPerMin;
    const statuses: number[] = [];
    for (let subnet = 1; subnet <= CLIENT_AGGREGATE_FACTOR + 1; subnet++) {
      for (let i = 0; i < SEND.perClientPerMin; i++) statuses.push((await handler.POST(post({ action: "nothing" }, {}, `2001:db8:0:ab0${subnet}::1`))).status);
    }
    expect(statuses.slice(0, network).every((status) => status === 400)).toBe(true);
    expect(statuses.slice(network).every((status) => status === 429)).toBe(true);
    expect((await handler.POST(post({ action: "nothing" }, {}, "2001:db8:1:ab01::1"))).status).toBe(400);
  });
});

describe("send-stage failures", () => {
  it("a sendTransaction the endpoint answered with HTTP 504 is 502 send_unconfirmed with the signature to confirm, never 'nothing was sent'", async () => {
    const timeout = setup((call, signature) => (method(call) === "sendTransaction" ? new Response("upstream timeout", { status: 504 }) : happy(call, signature)));
    const response = await read(await timeout.handler.POST(post({ action: "send", signedTxBase64: timeout.link.base64 })));
    expect([response.status, response.json.error?.code]).toEqual([502, "send_unconfirmed"]);
    expect(response.json.error?.signature).toBe(timeout.link.signature);
    expect(response.json.error?.explorerUrl).toBe(`https://solscan.io/tx/${timeout.link.signature}`);
    expect(response.json.error?.message).toContain("Confirm this signature");
    expect(response.text).not.toContain("nothing was sent");
    expect(timeout.upstream.calls.map(method)).toEqual(["simulateTransaction", "sendTransaction"]);
  });

  it("a simulation no endpoint answered is 502 upstream_unavailable: nothing was sent, and no signature is offered", async () => {
    const down = setup(() => new Response("", { status: 503 }));
    const response = await read(await down.handler.POST(post({ action: "send", signedTxBase64: down.link.base64 })));
    expect([response.status, response.json.error?.code]).toEqual([502, "upstream_unavailable"]);
    expect(response.json.error?.message).toContain("nothing was sent");
    expect(response.json.error).not.toHaveProperty("signature");
    expect(down.upstream.calls.map(method)).toEqual(["simulateTransaction"]);
  });

  it("every send-stage failure is 502, carries the signature, and never the endpoint", async () => {
    const unreachable = setup((call, signature) => {
      if (method(call) === "sendTransaction") throw new Error(`socket hang up ${UPSTREAM_1}`);
      return happy(call, signature);
    });
    const down = await read(await unreachable.handler.POST(post({ action: "send", signedTxBase64: unreachable.link.base64 })));
    expect([down.status, down.json.error?.code, down.json.error?.signature]).toEqual([502, "send_unconfirmed", unreachable.link.signature]);
    expect(down.text).not.toContain("nothing was sent");
    expect(down.text).not.toContain(SECRET_QUERY);
    expect(down.text).not.toContain("upstream.invalid");

    const refusing = setup((call, signature) =>
      method(call) === "sendTransaction" ? jsonResponse({ jsonrpc: "2.0", id: 1, error: { code: -32002, message: `refused by ${UPSTREAM_1}` } }) : happy(call, signature),
    );
    const refused = await read(await refusing.handler.POST(post({ action: "send", signedTxBase64: refusing.link.base64 })));
    expect([refused.status, refused.json.error?.code, refused.json.error?.signature]).toEqual([502, "send_failed", refusing.link.signature]);
    expect(refused.text).not.toContain(SECRET_QUERY);

    const mismatched = setup((call, signature) => (method(call) === "sendTransaction" ? rpcResult(call, "1".repeat(64)) : happy(call, signature)));
    const mismatch = await read(await mismatched.handler.POST(post({ action: "send", signedTxBase64: mismatched.link.base64 })));
    expect([mismatch.status, mismatch.json.error?.code, mismatch.json.error?.signature]).toEqual([502, "send_failed", mismatched.link.signature]);
  });
});
