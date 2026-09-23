// The endpoint pool's two reports: which endpoint was SET ASIDE, and which one
// ANSWERED.
//
// WHY THE SECOND ONE MATTERS ENOUGH TO TEST. A failover is silent by design —
// the pool sits under the transport precisely so no call site has to know — and
// it is also the change that most moves the numbers this keeper is sized on:
// another provider, another latency, another rate limit. A keeper quietly
// running on its last endpoint reads the same on /status as one running on its
// first, and the ceiling it can hold is not the same.
//
// AND NEITHER REPORT MAY CARRY A URL. SIP_SOLANA_RPC_URLS holds API keys,
// /status is unauthenticated on a public domain, and a provider URL with a key
// in it is a credential for somebody else's bill.

import { Secret } from "@sip/solana-log";
import { afterEach, describe, expect, it, vi } from "vitest";
import { endpointLabel, poolFetch } from "../src/rpc-pool.js";

const FIRST = "https://rpc.example.test/?api-key=FirstKeyNeverServed";
const SECOND = "https://rpc2.example.test/?api-key=SecondKeyNeverServed";
const urls = [new Secret(FIRST, "rpcUrl:0"), new Secret(SECOND, "rpcUrl:1")];

const ok = (): Response => new Response("{}", { status: 200 });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the endpoint pool", () => {
  it("reports which endpoint answered, by label and never by URL", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok()));
    const answered: string[] = [];
    const fetcher = poolFetch(urls, undefined, undefined, (at) => answered.push(at));
    await fetcher("ignored");
    await fetcher("ignored");
    expect(answered).toEqual([endpointLabel(0, 2), endpointLabel(0, 2)]);
    for (const at of answered) {
      expect(at).not.toContain("api-key");
      expect(at).not.toContain("example.test");
    }
  });

  it("names the endpoint that took over after one was set aside", async () => {
    // THE WHOLE REASON THIS EXISTS: after the first endpoint is put on cooldown
    // the keeper is on a different provider, and nothing said so anywhere a
    // human reads. `onFailover` reports the one that LEFT; only this says which
    // one is carrying the sweeps now.
    const responses = vi.fn(async (url: string) => (url === FIRST ? new Response("rate limited", { status: 429 }) : ok()));
    vi.stubGlobal("fetch", responses);
    const failovers: string[] = [];
    const answered: string[] = [];
    const fetcher = poolFetch(
      urls,
      (_message, fields) => failovers.push(String(fields.at)),
      undefined,
      (at) => answered.push(at),
    );
    await fetcher("ignored");
    expect(failovers).toEqual([endpointLabel(0, 2)]);
    expect(answered).toEqual([endpointLabel(1, 2)]);
  });

  it("reports nothing when every endpoint refuses, because nothing answered", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 500 })));
    const answered: string[] = [];
    const fetcher = poolFetch(urls, undefined, undefined, (at) => answered.push(at));
    await expect(fetcher("ignored")).rejects.toThrow("every Solana endpoint refused");
    expect(answered).toEqual([]);
  });

  it("works with no callbacks at all: the other two callers pass none", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok()));
    await expect(poolFetch(urls)("ignored")).resolves.toBeInstanceOf(Response);
  });
});
