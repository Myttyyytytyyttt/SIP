// The live dashboard's client: what it sends, and what each failure becomes.

import { describe, expect, it, vi } from "vitest";

import { createLiveApi, liveFailureWords } from "@/lib/live-api";
import { FAILURE_COPY } from "@/lib/vault-copy";
import type { ApiFailure } from "@/lib/vault-api";

const OWNER = "PensionKeyP1aceho1der111111111111111111111";
const WALLET = "TradingZeroP1aceho1der11111111111111111111";
const SIGNATURE = "5".repeat(88);

const answering = (response: () => Response) => {
  const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => response());
  return { fetch, api: createLiveApi({ origin: "http://localhost:3015/", fetch: fetch as unknown as typeof globalThis.fetch }) };
};

const sentBody = (fetch: ReturnType<typeof vi.fn>, call = 0): Record<string, unknown> => JSON.parse(String(fetch.mock.calls[call]![1]?.body)) as Record<string, unknown>;

describe("what it sends", () => {
  it("posts both actions to this app's own route under the given origin", async () => {
    const { fetch, api } = answering(() => new Response(JSON.stringify({ owner: OWNER }), { status: 200 }));

    await api.snapshot({ owner: OWNER, wallets: [WALLET], discover: true });
    expect(fetch.mock.calls[0]![0]).toBe("http://localhost:3015/api/solana-live");
    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: "POST", headers: { "content-type": "application/json" } });
    expect(sentBody(fetch, 0)).toEqual({ action: "snapshot", owner: OWNER, wallets: [WALLET], discover: true });

    await api.activity({ owner: OWNER, limit: 15 });
    expect(sentBody(fetch, 1)).toEqual({ action: "activity", owner: OWNER, limit: 15 });
  });

  it("sends only the cursor it was given: the route refuses a field it did not expect", async () => {
    const { fetch, api } = answering(() => new Response("{}", { status: 200 }));
    await api.activity({ owner: OWNER });
    expect(sentBody(fetch, 0)).toEqual({ action: "activity", owner: OWNER });

    await api.activity({ owner: OWNER, until: SIGNATURE });
    expect(sentBody(fetch, 1)).toEqual({ action: "activity", owner: OWNER, until: SIGNATURE });
    expect(sentBody(fetch, 1)).not.toHaveProperty("before");

    await api.activity({ owner: OWNER, before: SIGNATURE, limit: 3 });
    expect(sentBody(fetch, 2)).toEqual({ action: "activity", owner: OWNER, limit: 3, before: SIGNATURE });
  });

  it("copies the wallet list, so a later change to the caller's array cannot alter what was sent", async () => {
    const { fetch, api } = answering(() => new Response("{}", { status: 200 }));
    const wallets = [WALLET];
    await api.snapshot({ owner: OWNER, wallets, discover: false });
    wallets.push("LaterP1aceho1der1111111111111111111111111");
    expect(sentBody(fetch, 0).wallets).toEqual([WALLET]);
  });
});

describe("what comes back", () => {
  it("a 200 is the body, typed", async () => {
    const { api } = answering(() => new Response(JSON.stringify({ vault: "v", status: "exists", entries: [], nextBefore: null, gap: false }), { status: 200 }));
    const answer = await api.activity({ owner: OWNER });
    expect(answer).toMatchObject({ ok: true, status: 200 });
    expect(answer.ok && answer.body.status).toBe("exists");
  });

  it("a 429 keeps its retry-after, so the dashboard can count down instead of guessing", async () => {
    const { api } = answering(
      () =>
        new Response(JSON.stringify({ error: { code: "rate_limited", message: "Too many requests from this client. Retry in 9 s.", retryAfterSeconds: 9 } }), {
          status: 429,
          headers: { "retry-after": "9" },
        }),
    );
    const answer = await api.snapshot({ owner: OWNER, wallets: [], discover: false });
    expect(answer).toMatchObject({ ok: false, status: 429, code: "rate_limited", retryAfterSeconds: 9 });
    expect(answer.ok === false && liveFailureWords(answer)).toBe("Too many requests just now. Try again in 9 s.");
  });

  it("a request that never got an answer is a network failure, in words — not a thrown error", async () => {
    const api = createLiveApi({
      fetch: (async () => {
        throw new TypeError("Failed to fetch");
      }) as typeof globalThis.fetch,
    });
    const answer = await api.snapshot({ owner: OWNER, wallets: [], discover: false });
    expect(answer).toMatchObject({ ok: false, status: 0, code: "network" });
    expect(answer.ok === false && liveFailureWords(answer)).toBe(FAILURE_COPY.network);
  });

  it("a 503 says this deployment cannot serve Live", async () => {
    const { api } = answering(() => new Response(JSON.stringify({ error: { code: "unavailable", message: "Solana is not available on this deployment." } }), { status: 503 }));
    const answer = await api.snapshot({ owner: OWNER, wallets: [], discover: false });
    expect(answer).toMatchObject({ ok: false, status: 503, code: "unavailable" });
    expect(answer.ok === false && liveFailureWords(answer)).toBe(FAILURE_COPY.unavailable);
  });

  it("a body that is not JSON is still a failure with words, never a crash", async () => {
    const { api } = answering(() => new Response("<html>gateway</html>", { status: 502 }));
    const answer = await api.activity({ owner: OWNER });
    expect(answer).toMatchObject({ ok: false, status: 502, code: "http_502" });
    expect(answer.ok === false && liveFailureWords(answer)).toBe(FAILURE_COPY.unknown);
  });

  it("a 200 whose body is not an object is a failure, not a body nobody can read", async () => {
    const { api } = answering(() => new Response("[]", { status: 200 }));
    const answer = await api.snapshot({ owner: OWNER, wallets: [], discover: false });
    expect(answer.ok).toBe(false);
  });
});

describe("liveFailureWords", () => {
  it("uses the same sentences the vault screens use", () => {
    const failure = (code: string, status = 502): ApiFailure => ({ ok: false, status, code, message: "", retryAfterSeconds: null, body: {} });
    expect(liveFailureWords(failure("unreadable"))).toContain("could not read Solana");
    expect(liveFailureWords(failure("upstream_unavailable"))).toBe(FAILURE_COPY.upstream);
  });
});
