import { describe, expect, it } from "vitest";

import { failoverRpcClient, isEndpointFault } from "./failover.js";
import type { RpcClient } from "./rpc.js";

/** An endpoint that answers, or fails, according to a script. */
function endpoint(name: string, behaviour: (method: string) => unknown) {
  const seen: string[] = [];
  const client: RpcClient = {
    async call<T>(method: string): Promise<T> {
      seen.push(method);
      const result = behaviour(method);
      if (result instanceof Error) throw result;
      return result as T;
    },
  };
  return { name, client, seen };
}

describe("what counts as an endpoint fault", () => {
  /**
   * The distinction the whole design rests on. Failing over on a real answer
   * would mask a genuine error behind a second endpoint returning the identical
   * genuine error, one retry later — turning a clear failure into a confusing
   * one.
   */
  it("treats inability to answer as a fault", () => {
    for (const message of [
      "fetch failed",
      "HTTP 503",
      "Monthly capacity limit exceeded",
      "429 Too Many Requests",
      "the method debug_traceTransaction does not exist/is not available",
      "request timed out",
      "eth_getBlockByNumber returned null for block 42",
    ]) {
      expect(isEndpointFault(new Error(message)), message).toBe(true);
    }
  });

  it("treats an answer as an answer, however unwelcome", () => {
    for (const message of [
      "execution reverted",
      "ERC20Permit: invalid signature",
      "invalid argument 0: hex string has odd length",
      "nonce too low",
      "insufficient funds for gas",
    ]) {
      expect(isEndpointFault(new Error(message)), message).toBe(false);
    }
  });
});

describe("serving from more than one endpoint", () => {
  it("uses the first endpoint while it works, and never consults the second", async () => {
    const a = endpoint("a", () => "0x1");
    const b = endpoint("b", () => "0x2");
    const rpc = failoverRpcClient([a, b]);

    expect(await rpc.call("eth_blockNumber")).toBe("0x1");
    expect(b.seen).toHaveLength(0);
  });

  it("moves to the next endpoint when the first cannot answer", async () => {
    const a = endpoint("a", () => new Error("Monthly capacity limit exceeded"));
    const b = endpoint("b", () => "0x2");
    const events: string[] = [];
    const rpc = failoverRpcClient([a, b], { onEvent: (e) => events.push(e.kind) });

    expect(await rpc.call("eth_blockNumber")).toBe("0x2");
    expect(events).toContain("SWITCHED");
  });

  it("stays on the fallback rather than paying a wasted call per request", async () => {
    // A scan issues one call per block, so retrying a down endpoint every time
    // doubles the cost of an outage.
    let aFails = true;
    const a = endpoint("a", () => (aFails ? new Error("HTTP 503") : "0x1"));
    const b = endpoint("b", () => "0x2");
    let clock = 0;
    const rpc = failoverRpcClient([a, b], { probeAfterMs: 60_000, now: () => clock });

    await rpc.call("eth_blockNumber");
    aFails = false;
    const before = a.seen.length;
    expect(await rpc.call("eth_blockNumber")).toBe("0x2");
    expect(a.seen.length).toBe(before);
  });

  it("probes the preferred endpoint again later, so a reset quota heals itself", async () => {
    let aFails = true;
    const a = endpoint("a", () => (aFails ? new Error("Monthly capacity limit exceeded") : "0x1"));
    const b = endpoint("b", () => "0x2");
    let clock = 0;
    const rpc = failoverRpcClient([a, b], { probeAfterMs: 60_000, now: () => clock });

    await rpc.call("eth_blockNumber");
    aFails = false;
    clock += 61_000;
    // Without this the good endpoint stays demoted forever after one blip, and
    // the fallback is a fallback because it is the lesser one.
    expect(await rpc.call("eth_blockNumber")).toBe("0x1");
  });

  /**
   * The failure this exists to prevent: one provider's quota ran out and every
   * settlement stopped, with the chain and the contracts perfectly healthy.
   */
  it("reports an outage distinctly when no endpoint can answer", async () => {
    const a = endpoint("a", () => new Error("fetch failed"));
    const b = endpoint("b", () => new Error("HTTP 502"));
    const events: string[] = [];
    const rpc = failoverRpcClient([a, b], { onEvent: (e) => events.push(e.kind) });

    await expect(rpc.call("eth_blockNumber")).rejects.toThrow(/all 2 endpoint\(s\) failed/);
    expect(events).toContain("ALL_FAILED");
  });

  it("propagates a real error immediately instead of asking everyone else", async () => {
    const a = endpoint("a", () => new Error("execution reverted"));
    const b = endpoint("b", () => "0x2");
    const rpc = failoverRpcClient([a, b]);

    await expect(rpc.call("eth_call")).rejects.toThrow(/execution reverted/);
    expect(b.seen).toHaveLength(0);
  });

  it("never names a URL in an event, because URLs carry API keys", async () => {
    const a = endpoint("alchemy-host", () => new Error("fetch failed"));
    const b = endpoint("backup-host", () => "0x2");
    const events: { from?: string; to?: string }[] = [];
    const rpc = failoverRpcClient([a, b], { onEvent: (e) => events.push(e as never) });

    await rpc.call("eth_blockNumber");
    for (const event of events) {
      expect(JSON.stringify(event)).not.toMatch(/https?:\/\//);
    }
  });
});
