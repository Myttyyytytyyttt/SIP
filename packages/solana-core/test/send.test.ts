// Simulate-then-send against a stub upstream.

import { describe, expect, it } from "vitest";

import { buildWithdraw } from "../src/server/builders";
import { createRpcPool } from "../src/server/rpc-pool";
import { simulateAndSend } from "../src/server/send";
import { verifySignedTransaction, type VerifiedTransaction } from "../src/server/verify-tx";
import { BLOCKHASH, SECRET_QUERY, UPSTREAM_1, fakeFetch, jsonResponse, keypair, rpcResult, signWire, type UpstreamCall } from "./helpers";

function verifiedWithdraw(): VerifiedTransaction {
  const owner = keypair();
  const result = verifySignedTransaction(signWire(buildWithdraw({ owner: owner.publicKey, lamports: 5n, blockhash: BLOCKHASH }).txBase64, owner));
  if (!result.ok) throw new Error(result.detail);
  return result;
}

const method = (call: UpstreamCall): string => (call.body as { method: string }).method;
const params = (call: UpstreamCall): unknown[] => (call.body as { params: unknown[] }).params;

describe("simulateAndSend", () => {
  it("simulates with sigVerify and the real blockhash, then sends without preflight, and returns the verified signature", async () => {
    const verified = verifiedWithdraw();
    const upstream = fakeFetch((call) =>
      method(call) === "simulateTransaction"
        ? rpcResult(call, { context: { slot: 99 }, value: { err: null, logs: ["Program log: ok"], unitsConsumed: 1_234 } })
        : rpcResult(call, verified.signature),
    );
    const outcome = await simulateAndSend(createRpcPool([UPSTREAM_1], { fetch: upstream.fetch }), verified);
    expect(outcome).toEqual({ ok: true, signature: verified.signature, slot: 99, unitsConsumed: 1_234 });
    expect(upstream.calls.map(method)).toEqual(["simulateTransaction", "sendTransaction"]);
    expect(params(upstream.calls[0]!)).toEqual([verified.wireBase64, { encoding: "base64", sigVerify: true, replaceRecentBlockhash: false, commitment: "confirmed" }]);
    expect(params(upstream.calls[1]!)).toEqual([verified.wireBase64, { encoding: "base64", skipPreflight: true, maxRetries: 5 }]);
  });

  it("stops at a failed simulation, keeping the last 20 log lines, scrubbed, and never sends", async () => {
    const logs = Array.from({ length: 25 }, (_, i) => `line ${i}`);
    logs[24] = `Program log: fetched ${UPSTREAM_1}`;
    const upstream = fakeFetch((call) => rpcResult(call, { context: { slot: 1 }, value: { err: { InstructionError: [0, { Custom: 6001 }] }, logs } }));
    const outcome = await simulateAndSend(createRpcPool([UPSTREAM_1], { fetch: upstream.fetch }), verifiedWithdraw());
    expect(outcome).toMatchObject({ ok: false, stage: "simulate", reason: "rejected", err: { InstructionError: [0, { Custom: 6001 }] } });
    if (outcome.ok || outcome.reason !== "rejected") return;
    expect(outcome.logs).toHaveLength(20);
    expect(outcome.logs[0]).toBe("line 5");
    expect(JSON.stringify(outcome)).not.toContain(SECRET_QUERY);
    expect(upstream.calls.map(method)).toEqual(["simulateTransaction"]);
  });

  it("reports an expired blockhash as the simulation error BlockhashNotFound", async () => {
    const upstream = fakeFetch((call) => rpcResult(call, { context: { slot: 1 }, value: { err: "BlockhashNotFound", logs: [] } }));
    expect(await simulateAndSend(createRpcPool([UPSTREAM_1], { fetch: upstream.fetch }), verifiedWithdraw())).toMatchObject({ stage: "simulate", reason: "rejected", err: "BlockhashNotFound" });
  });

  it("treats a JSON-RPC refusal of the simulation as a rejection of the transaction", async () => {
    const upstream = fakeFetch(() => jsonResponse({ jsonrpc: "2.0", id: 1, error: { code: -32003, message: "Transaction signature verification failure" } }));
    const outcome = await simulateAndSend(createRpcPool([UPSTREAM_1], { fetch: upstream.fetch }), verifiedWithdraw());
    expect(outcome).toMatchObject({ ok: false, stage: "simulate", reason: "rejected", err: { code: -32003 } });
  });

  it("says unavailable, with no URL, when no endpoint answers", async () => {
    const upstream = fakeFetch(() => {
      throw new TypeError(`fetch failed ${UPSTREAM_1}`);
    });
    const outcome = await simulateAndSend(createRpcPool([UPSTREAM_1], { fetch: upstream.fetch }), verifiedWithdraw());
    expect(outcome).toMatchObject({ ok: false, stage: "simulate", reason: "unavailable" });
    expect(JSON.stringify(outcome)).not.toContain("upstream.invalid");
  });

  it("refuses a returned signature that is not the transaction's", async () => {
    const upstream = fakeFetch((call) =>
      method(call) === "simulateTransaction" ? rpcResult(call, { context: { slot: 1 }, value: { err: null, logs: [] } }) : rpcResult(call, "1".repeat(64)),
    );
    expect(await simulateAndSend(createRpcPool([UPSTREAM_1], { fetch: upstream.fetch }), verifiedWithdraw())).toMatchObject({ ok: false, stage: "send", reason: "signature_mismatch" });
  });

  it("reports a send-stage JSON-RPC error as a rejection at send, scrubbed", async () => {
    const upstream = fakeFetch((call) =>
      method(call) === "simulateTransaction"
        ? rpcResult(call, { context: { slot: 1 }, value: { err: null, logs: [] } })
        : jsonResponse({ jsonrpc: "2.0", id: 1, error: { code: -32002, message: `node behind ${UPSTREAM_1}`, data: { err: "AccountInUse", logs: ["a"] } } }),
    );
    const outcome = await simulateAndSend(createRpcPool([UPSTREAM_1], { fetch: upstream.fetch }), verifiedWithdraw());
    expect(outcome).toMatchObject({ ok: false, stage: "send", reason: "rejected", err: "AccountInUse", logs: ["a"] });
    expect(JSON.stringify(outcome)).not.toContain(SECRET_QUERY);
  });
});
