// The browser's side of /api/wallet-names (owner, 10-23): the session's token in Authorization: Bearer and
// nowhere else, same-origin and no-store, the names read through the same rules the input applies, and a
// refusal read as every other route's is. A recording fetch stands in for the network.

import { describe, expect, it, vi } from "vitest";

import { WALLET_NAMES_PATH, readWalletNames, saveWalletName } from "@/lib/wallet-names-client";

const WALLET = "TradingZeroP1aceho1der11111111111111111111";

function answering(status: number, body: unknown, headers: Record<string, string> = {}) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers }));
}

describe("readWalletNames", () => {
  it("GETs the same-origin route with the token as a bearer, never in the URL, and never cached", async () => {
    const fetch = answering(200, { names: { [WALLET]: "Axiom" } });
    expect(await readWalletNames("tok.en.value", { fetch })).toEqual({ ok: true, status: 200, body: { names: { [WALLET]: "Axiom" } } });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(WALLET_NAMES_PATH);
    expect(String(url)).not.toContain("tok.en.value");
    expect(init).toMatchObject({ method: "GET", cache: "no-store", headers: { authorization: "Bearer tok.en.value" } });
    expect(init).not.toHaveProperty("body");
  });

  it("drops anything in the answer that is not an address with a valid name", async () => {
    const fetch = answering(200, { names: { [WALLET]: "a\nb", junk: "x" } });
    expect(await readWalletNames("t", { fetch })).toMatchObject({ ok: true, body: { names: {} } });
  });

  it("reads a store that is off as names_off, and no answer as a network failure", async () => {
    expect(await readWalletNames("t", { fetch: answering(503, { error: { code: "names_off", message: "off" } }) })).toMatchObject({ ok: false, status: 503, code: "names_off" });
    const down = vi.fn(async () => Promise.reject(new TypeError("offline")));
    expect(await readWalletNames("t", { fetch: down })).toMatchObject({ ok: false, status: 0, code: "network" });
  });
});

describe("saveWalletName", () => {
  it("PUTs the address and the name as JSON, null for back to the default", async () => {
    const fetch = answering(200, { names: {} });
    await saveWalletName("t", WALLET, "Axiom", { fetch });
    await saveWalletName("t", WALLET, null, { fetch });
    const [, first] = fetch.mock.calls[0]!;
    expect(first).toMatchObject({ method: "PUT", cache: "no-store", headers: { authorization: "Bearer t", "content-type": "application/json" } });
    expect(JSON.parse(first!.body as string)).toEqual({ address: WALLET, name: "Axiom" });
    expect(JSON.parse(fetch.mock.calls[1]![1]!.body as string)).toEqual({ address: WALLET, name: null });
  });

  it("keeps a refusal's code, words and retry-after", async () => {
    const fetch = answering(429, { error: { code: "rate_limited", message: "Too many renames from this account. Retry in 30 s.", retryAfterSeconds: 30 } }, { "retry-after": "30" });
    expect(await saveWalletName("t", WALLET, "x", { fetch })).toMatchObject({ ok: false, status: 429, code: "rate_limited", retryAfterSeconds: 30 });
  });
});
