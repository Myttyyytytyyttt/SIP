// The ceiling bench reaches nobody but its own stub, and this is the proof
// rather than the promise.
//
// THE THING BEING PREVENTED IS A LOAD TEST AGAINST SOMEBODY ELSE'S ENDPOINT.
// The bench drives the keeper's real sweep, and the real sweep has paths that
// call out — Jupiter for a quote and a route build, the alert webhook, Privy.
// The synthetic fleet is shaped so no turn reaches any of them, but "shaped so"
// is an argument about a code path, and this is a wrapper that does not care
// which path asked: anything but the loopback throws, and the host it tried is
// recorded so the run can report it.
//
// THE HOST, NEVER THE URL. An RPC endpoint's URL carries a provider's API key,
// and what this records ends up in the bench's own output.

import { describe, expect, it } from "vitest";
import { OFFLINE_REFUSAL, installOfflineGuard, isLoopbackTarget } from "../src/bench/offline.js";

describe("what a bench process is allowed to talk to", () => {
  it("is this machine, by every spelling of it", () => {
    for (const target of ["http://127.0.0.1:8899", "http://localhost:3000/status", "http://[::1]:1/", "http://0.0.0.0:9/"]) {
      expect(isLoopbackTarget(target), target).toBe(true);
    }
  });

  it("is nobody else — not a provider, not a venue, not a webhook", () => {
    for (const target of [
      "https://mainnet.helius-rpc.com/?api-key=x",
      "https://api.mainnet-beta.solana.com",
      "https://lite-api.jup.ag/swap/v1/quote",
      "https://api.telegram.org/botX/sendMessage",
      "https://auth.privy.io/api/v1/wallets",
    ]) {
      expect(isLoopbackTarget(target), target).toBe(false);
    }
  });

  it("refuses what it cannot parse, because the safe reading of an unknown target is 'not local'", () => {
    expect(isLoopbackTarget("not a url")).toBe(false);
    expect(isLoopbackTarget("")).toBe(false);
    // A host that merely CONTAINS the loopback's spelling is a different host.
    expect(isLoopbackTarget("https://localhost.attacker.example/rpc")).toBe(false);
    expect(isLoopbackTarget("https://127.0.0.1.example.com/rpc")).toBe(false);
  });
});

describe("the guard the bench installs in its keeper child", () => {
  it("throws on a request that leaves the loopback, and records the HOST and not the key in the URL", async () => {
    const original = globalThis.fetch;
    try {
      const guard = installOfflineGuard();
      await expect(globalThis.fetch("https://mainnet.helius-rpc.com/?api-key=SECRET")).rejects.toThrow(OFFLINE_REFUSAL);
      expect(guard.blocked).toEqual(["mainnet.helius-rpc.com"]);
      expect(JSON.stringify(guard.blocked)).not.toContain("SECRET");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("lets the stub on the loopback through untouched", async () => {
    const original = globalThis.fetch;
    let sawUrl: string | null = null;
    globalThis.fetch = (async (input: unknown) => {
      sawUrl = String(input);
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      const guard = installOfflineGuard();
      const response = await globalThis.fetch("http://127.0.0.1:1234/");
      expect(response.status).toBe(200);
      expect(sawUrl).toBe("http://127.0.0.1:1234/");
      expect(guard.blocked).toEqual([]);
    } finally {
      globalThis.fetch = original;
    }
  });
});
