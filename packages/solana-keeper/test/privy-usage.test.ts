// What the keeper asks of Privy (src/privy-usage.ts): requests by kind, counted
// in the fetch every Privy client of the keeper takes, and settle signatures by
// the mode they charged.
//
// THROUGH THE REAL SDK, OVER A FETCH THAT NEVER LEAVES THE PROCESS, as
// test/privy-signer.test.ts does: the wallet index is the keeper's own
// buildPrivySolanaIndex, paging as the SDK pages, and the send is the keeper's
// own signer. The counting fetch sits between the SDK and the fake, so what is
// counted is what the SDK really sends. The app secret is a throwaway string,
// the authorization key comes from the SDK's local generateP256KeyPair, and the
// test checks that no id, header or secret reaches a report.

import { generateP256KeyPair } from "@privy-io/node";
import { Secret } from "@sip/solana-log";
import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { PRIVY_API_URL, buildPrivySolanaIndex, createPrivySolanaSigner, readPrivyKeyQuorum, type PrivySolanaConfig } from "../src/privy-signer.js";
import { PRIVY_FREE_SIGNATURES_PER_MONTH, createPrivyUsage, modeLabel, privyCallKind } from "../src/privy-usage.js";
import { MODE_PROFIT_BYTE, MODE_VOLUME_BYTE } from "../src/role-registry.js";
import { buildTestSettle } from "./settle-transaction.js";

const T0 = 1_760_000_000_000;
const APP_SECRET = "privy-app-secret-NeverCounted-0001";
const SIGNER_ID = "keeperQuorum000000000001";
const WALLET_ID = "privyWalletNeverCounted0001";

/** A fetch that answers as `answer` says: a JSON body and a status. */
function answering(answer: (url: URL, method: string) => { status: number; body: unknown }): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const { status, body } = answer(url, init?.method ?? "GET");
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

const configFor = (fetch: typeof globalThis.fetch, authorizationKey = "unused"): PrivySolanaConfig => ({
  appId: "sipprivyapp0000000000000001",
  appSecret: new Secret(APP_SECRET, "privyAppSecret"),
  authorizationKey: new Secret(authorizationKey, "privyAuthorizationKey"),
  fetch,
});

describe("which request is which", () => {
  it("tells the listing's pages, a settle's rpc and the quorum read apart by method and path shape", () => {
    expect(privyCallKind("GET", `${PRIVY_API_URL}/v1/wallets?chain_type=solana&cursor=abc`)).toBe("walletsList");
    expect(privyCallKind("POST", `${PRIVY_API_URL}/v1/wallets/${WALLET_ID}/rpc`)).toBe("walletRpc");
    expect(privyCallKind("GET", `${PRIVY_API_URL}/v1/key_quorums/${SIGNER_ID}`)).toBe("keyQuorum");
    expect(privyCallKind("GET", `${PRIVY_API_URL}/v1/wallets/${WALLET_ID}`)).toBe("other");
    expect(privyCallKind("POST", `${PRIVY_API_URL}/v1/wallets`)).toBe("other");
    expect(privyCallKind("GET", "not a url")).toBe("other");
  });

  it("names a mode by the registry's row, and a byte it has no row for by the byte", () => {
    expect(modeLabel(MODE_PROFIT_BYTE)).toBe("profit");
    expect(modeLabel(MODE_VOLUME_BYTE)).toBe("volume");
    expect(modeLabel(7)).toBe("mode-7");
  });
});

describe("the requests, counted in the SDK's own fetch", () => {
  it("counts every page of the wallet listing, for the sweep and for the day", async () => {
    const usage = createPrivyUsage({ startedAt: T0, now: () => T0 });
    const pages = answering((url) =>
      url.searchParams.get("cursor") === null
        ? { status: 200, body: { data: [{ id: "w1", address: Keypair.generate().publicKey.toBase58(), chain_type: "solana" }], next_cursor: "page-2" } }
        : { status: 200, body: { data: [{ id: "w2", address: Keypair.generate().publicKey.toBase58(), chain_type: "solana" }], next_cursor: null } },
    );
    usage.startSweep();
    const index = await buildPrivySolanaIndex(configFor(usage.fetch(pages)));
    usage.endSweep();

    // The index is exactly what it would have been: the counting fetch changed nothing.
    expect(index.size).toBe(2);
    const report = usage.report(T0 + 60_000);
    expect(report.listPagesLastSweep).toBe(2);
    expect(report.callsLastSweep).toBe(2);
    expect(report.callsPerDay).toEqual({ walletsList: 2 });
    expect(report.failedPerDay).toBe(0);
  });

  it("counts the quorum read, and a request Privy refused or never answered as failed, with 429s apart", async () => {
    const usage = createPrivyUsage({ startedAt: T0, now: () => T0 });
    const refusing = answering(() => ({ status: 429, body: { error: "too many requests" } }));
    await expect(readPrivyKeyQuorum(configFor(usage.fetch(refusing)), SIGNER_ID)).rejects.toThrow();
    const unanswered = usage.fetch(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(unanswered(`${PRIVY_API_URL}/v1/key_quorums/${SIGNER_ID}`, { method: "GET" })).rejects.toThrow("fetch failed");

    const report = usage.report(T0 + 1);
    expect(report.callsPerDay).toEqual({ keyQuorum: 2 });
    expect(report.failedPerDay).toBe(2);
    expect(report.http429PerDay).toBe(1);
  });

  it("counts a settle's send as one walletRpc, and hands the signer exactly Privy's answer", async () => {
    const usage = createPrivyUsage({ startedAt: T0, now: () => T0 });
    const settle = await buildTestSettle();
    const pair = await generateP256KeyPair();
    const privy = answering(() => ({ status: 200, body: { method: "signAndSendTransaction", data: { hash: "settle-hash" } } }));
    const resolution = await createPrivySolanaSigner(
      configFor(usage.fetch(privy), pair.privateKey),
      settle.wallet,
      SIGNER_ID,
      new Map([[settle.wallet.toBase58(), { walletId: WALLET_ID, seats: [{ signerId: SIGNER_ID, overridePolicyIds: [] }] }]]),
    );
    if (resolution.outcome !== "SIGNER") throw new Error(`expected a signer, got ${resolution.outcome}`);
    await expect(resolution.signer.submit(settle.transaction, { idempotencyKey: "a".repeat(64) })).resolves.toBe("settle-hash");

    const report = usage.report(T0 + 1);
    expect(report.callsPerDay).toEqual({ walletRpc: 1 });
    // NO ID, NO SECRET, NO KEY in anything it serves.
    const served = JSON.stringify(report);
    for (const secret of [WALLET_ID, APP_SECRET, pair.privateKey, SIGNER_ID]) expect(served).not.toContain(secret);
  });

  it("returns the inner fetch's answer itself, and its throw itself", async () => {
    const usage = createPrivyUsage({ startedAt: T0 });
    const answer = new Response("{}", { status: 503 });
    expect(await usage.fetch(async () => answer)(`${PRIVY_API_URL}/v1/wallets`)).toBe(answer);
    const failure = new TypeError("fetch failed");
    await expect(
      usage.fetch(async () => {
        throw failure;
      })(`${PRIVY_API_URL}/v1/wallets`),
    ).rejects.toBe(failure);
  });
});

describe("signatures by mode", () => {
  it("counts each mode apart, a send that threw apart from both, and projects the month against the free tier", () => {
    const clock = { now: T0 };
    const usage = createPrivyUsage({ startedAt: T0, now: () => clock.now });
    usage.signature(MODE_PROFIT_BYTE, true);
    usage.signature(MODE_VOLUME_BYTE, true);
    usage.signature(MODE_VOLUME_BYTE, true);
    usage.signature(MODE_VOLUME_BYTE, false);

    const report = usage.report(T0 + 3_600_000);
    expect(report.signaturesPerDay).toEqual({ profit: 1, volume: 2 });
    expect(report.signThrewPerDay).toBe(1);
    expect(report.signaturesSinceBoot).toEqual({ profit: 1, volume: 2 });
    // Three in an hour: 72 a day, 2,160 a month.
    expect(report.signaturesMonthEstimate).toBe(2_160);
    expect(report.freeSignaturesPerMonth).toBe(PRIVY_FREE_SIGNATURES_PER_MONTH);

    // Ten seconds in, the same three signatures project nothing: too little was watched.
    expect(usage.report(T0 + 10_000).signaturesMonthEstimate).toBeNull();

    // A day later the window has forgotten them; the since-boot count has not.
    const later = usage.report(T0 + 25 * 3_600_000);
    expect(later.signaturesPerDay).toEqual({});
    expect(later.signaturesSinceBoot).toEqual({ profit: 1, volume: 2 });
  });
});

describe("the wallet index", () => {
  it("keeps the last build's time and counts failures, in a row and in total", () => {
    const usage = createPrivyUsage({ startedAt: T0 });
    usage.indexBuilt(180, true);
    usage.indexBuilt(30_000, false);
    usage.indexBuilt(30_000, false);
    expect(usage.report(T0 + 1)).toMatchObject({ indexMs: 30_000, indexFailures: 2, consecutiveIndexFailures: 2 });
    usage.indexBuilt(200, true);
    usage.fallbackLookup();
    expect(usage.report(T0 + 1)).toMatchObject({ indexMs: 200, indexFailures: 2, consecutiveIndexFailures: 0, fallbackLookups: 1 });
  });
});

describe("onAnswer (dep-down's Privy watch)", () => {
  it("is told each request's status, or 'unanswered' with what was thrown — after the fact, with the answer unchanged", async () => {
    const told: (number | string)[] = [];
    const usage = createPrivyUsage({ startedAt: T0, onAnswer: (answer) => void told.push(answer) });
    const answer = new Response("{}", { status: 503 });
    expect(await usage.fetch(async () => answer)(`${PRIVY_API_URL}/v1/wallets`)).toBe(answer);
    expect(await usage.fetch(async () => new Response("{}", { status: 200 }))(`${PRIVY_API_URL}/v1/wallets`)).toBeInstanceOf(Response);
    const failure = new TypeError("fetch failed");
    let thrown: unknown;
    const refused = createPrivyUsage({
      startedAt: T0,
      onAnswer: (kind, error) => {
        told.push(kind);
        thrown = error;
      },
    });
    await expect(
      refused.fetch(async () => {
        throw failure;
      })(`${PRIVY_API_URL}/v1/wallets`),
    ).rejects.toBe(failure);
    expect(told).toEqual([503, 200, "unanswered"]);
    expect(thrown).toBe(failure);
  });

  it("cannot change an answer by throwing", async () => {
    const usage = createPrivyUsage({
      startedAt: T0,
      onAnswer: () => {
        throw new Error("observer broke");
      },
    });
    const answer = new Response("{}", { status: 200 });
    expect(await usage.fetch(async () => answer)(`${PRIVY_API_URL}/v1/wallets`)).toBe(answer);
  });
});
