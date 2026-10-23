// /api/wallet-names as wired in this app (owner, 10-23: a trading wallet's name, saved to the account, no
// signature): off without a store, then the gate, cross-site, the client's buckets, the Privy session — checked
// against a local key set, so nothing reaches Privy — and the names, kept in an in-memory store with the Blob
// store's contract (etags and create-only first saves included), behind this instance's copies and the daily
// budgets that keep the store inside Hobby's month. No network.

import { SIP_PROGRAM_ID } from "@sip/solana-core/client";
import { createWeightedLimiter } from "@sip/solana-core/server";
import { Keypair } from "@solana/web3.js";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { WALLET_NAMES_MAX, WALLET_NAME_COPY } from "@/lib/wallet-names";
import {
  WALLET_NAMES_COPY_MS,
  WALLET_NAMES_MAX_BODY_BYTES,
  WALLET_NAMES_READS_PER_DAY,
  WALLET_NAMES_READS_PER_USER,
  WALLET_NAMES_WRITES_PER_DAY,
  WALLET_NAMES_WRITES_PER_USER,
  walletNamesBudgets,
  walletNamesRoute,
  type WalletNamesCopies,
  type WalletNamesRouteOptions,
} from "@/lib/wallet-names-server";
import { WalletNamesConflict, memoryWalletNamesStore, walletNamesPath, type WalletNamesStore } from "@/lib/wallet-names-store";

const APP_ID = "cmtrt36tb00080dlbrda5aqam";
const ALICE = "did:privy:alice00000000000000000000a";
const BOB = "did:privy:bob0000000000000000000000b";
const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);
const ENV = {
  SIP_SOLANA_RPC_URLS: "https://upstream.invalid/?api-key=NAMESROUTESECRET",
  SIP_SOLANA_PROGRAM_ID: SIP_PROGRAM_ID,
  SIP_TRUSTED_CLIENT_IP_HEADER: "x-real-ip",
  PRIVY_APP_ID: APP_ID,
  BLOB_STORE_ID: "store_test",
} as const;

let keys: JWTVerifyGetKey;
let signer: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

beforeAll(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  signer = pair.privateKey;
  keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256" }] });
});

const tokenFor = (userId: string, expiresAt = Math.floor(NOW / 1_000) + 3_600): Promise<string> =>
  new SignJWT({ sid: "session" })
    .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: "k1" })
    .setIssuer("privy.io")
    .setAudience(APP_ID)
    .setSubject(userId)
    .setIssuedAt(Math.floor(NOW / 1_000) - 60)
    .setExpirationTime(expiresAt)
    .sign(signer);

let lastIp = 0;
const freshIp = (): string => `198.51.100.${(lastIp = (lastIp % 250) + 1)}`;
const someWallet = (): string => Keypair.generate().publicKey.toBase58();

/** The route with its own budgets, copies, store and keys, so no test spends another's. */
function routeWith(over: Partial<WalletNamesRouteOptions> = {}) {
  const store = memoryWalletNamesStore();
  const refusals: { status: number; code: string }[] = [];
  const route = walletNamesRoute({
    env: ENV,
    store,
    keys,
    now: () => NOW,
    onRefusal: (event) => refusals.push(event),
    copies: new Map(),
    ...over,
    budgets: {
      exact: createWeightedLimiter({ capacity: 30 }),
      aggregate: createWeightedLimiter({ capacity: 120 }),
      readsPerUser: createWeightedLimiter({ capacity: 20 }),
      readsGlobal: createWeightedLimiter({ capacity: 60 }),
      writesPerUser: createWeightedLimiter({ capacity: 10 }),
      writesGlobal: createWeightedLimiter({ capacity: 20 }),
      ...over.budgets,
    },
  });
  return { route, store, refusals };
}

/** A memory store that counts what it is asked: each read and each save is one of the month's operations. */
function countingStore() {
  const store = memoryWalletNamesStore();
  const read = vi.spyOn(store, "read");
  const write = vi.spyOn(store, "write");
  return { store, read, write };
}

const get = (token: string | null, headers: Record<string, string> = {}) =>
  new Request("https://saverfi.cash/api/wallet-names", {
    headers: { "x-real-ip": freshIp(), ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...headers },
  });

const put = (token: string | null, body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://saverfi.cash/api/wallet-names", {
    method: "PUT",
    headers: { "x-real-ip": freshIp(), "content-type": "application/json", ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const codeOf = async (response: Response): Promise<string> => ((await response.json()) as { error: { code: string } }).error.code;

describe("off, unconfigured, and refused before anyone is believed", () => {
  it("is 503 names_off without a store, before the gate, the session or a single read", async () => {
    const store = { read: vi.fn(), write: vi.fn() } satisfies WalletNamesStore;
    const { BLOB_STORE_ID: _off, ...env } = ENV;
    const { route } = routeWith({ env, store });
    const response = await route.GET(get(await tokenFor(ALICE)));
    expect(response.status).toBe(503);
    expect(await codeOf(response)).toBe("names_off");
    expect((await route.PUT(put(await tokenFor(ALICE), { address: someWallet(), name: "x" }))).status).toBe(503);
    expect(store.read).not.toHaveBeenCalled();
  });

  it("counts a read-write token as a store too, for a deployment connected the older way", async () => {
    const { BLOB_STORE_ID: _off, ...env } = ENV;
    const { route } = routeWith({ env: { ...env, BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_x" } });
    expect((await route.GET(get(await tokenFor(ALICE)))).status).toBe(200);
  });

  it("is 503 unavailable on a deployment whose Solana settings or Privy app id are missing", async () => {
    const { SIP_TRUSTED_CLIENT_IP_HEADER: _gate, ...noGate } = ENV;
    expect(await codeOf(await routeWith({ env: noGate }).route.GET(get(await tokenFor(ALICE))))).toBe("unavailable");
    const { PRIVY_APP_ID: _app, ...noApp } = ENV;
    expect(await codeOf(await routeWith({ env: noApp }).route.GET(get(await tokenFor(ALICE))))).toBe("unavailable");
  });

  it("refuses a cross-site request", async () => {
    const response = await routeWith().route.GET(get(await tokenFor(ALICE), { "sec-fetch-site": "cross-site" }));
    expect(response.status).toBe(403);
    expect(await codeOf(response)).toBe("cross_site");
  });

  it("is 401 with no token, a bad one, or an expired one — and the store is never asked", async () => {
    const store = { read: vi.fn(), write: vi.fn() } satisfies WalletNamesStore;
    const { route } = routeWith({ store });
    for (const [token, code] of [
      [null, "no_token"],
      ["junk.junk.junk", "token_invalid"],
      [await tokenFor(ALICE, Math.floor(NOW / 1_000) - 1), "token_expired"],
    ] as const) {
      const response = await route.GET(get(token));
      expect(response.status).toBe(401);
      expect(await codeOf(response)).toBe(code);
    }
    expect(store.read).not.toHaveBeenCalled();
  });

  it("is 503, not 401, when Privy's keys cannot be read", async () => {
    const unreachable: JWTVerifyGetKey = async () => {
      throw new TypeError("fetch failed");
    };
    const response = await routeWith({ keys: unreachable }).route.GET(get(await tokenFor(ALICE)));
    expect(response.status).toBe(503);
    expect(await codeOf(response)).toBe("auth_unavailable");
  });
});

describe("the names, saved to the account", () => {
  it("reads none at first, saves one, and reads it back at once — private and never cached", async () => {
    const { route, store } = routeWith();
    const token = await tokenFor(ALICE);
    const wallet = someWallet();
    const first = await route.GET(get(token));
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    expect(await first.json()).toEqual({ names: {} });

    const saved = await route.PUT(put(token, { address: wallet, name: "  Axiom main " }));
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ names: { [wallet]: "Axiom main" } });
    expect(await (await route.GET(get(token))).json()).toEqual({ names: { [wallet]: "Axiom main" } });

    // Filed under a hash of the login, under the feature's own prefix, and nowhere else.
    expect([...store.documents.keys()]).toEqual([walletNamesPath(ALICE)]);
    expect(walletNamesPath(ALICE)).toMatch(/^wallet-names\/[0-9a-f]{64}\.json$/);
    expect(walletNamesPath(ALICE)).not.toContain("alice");
  });

  it("keeps each account's names apart", async () => {
    const { route } = routeWith();
    const wallet = someWallet();
    await route.PUT(put(await tokenFor(ALICE), { address: wallet, name: "Alice's" }));
    expect(await (await route.GET(get(await tokenFor(BOB)))).json()).toEqual({ names: {} });
  });

  it("goes back to the default name on null or empty", async () => {
    const { route } = routeWith();
    const token = await tokenFor(ALICE);
    const [a, b] = [someWallet(), someWallet()];
    await route.PUT(put(token, { address: a, name: "One" }));
    await route.PUT(put(token, { address: b, name: "Two" }));
    expect(await (await route.PUT(put(token, { address: a, name: null }))).json()).toEqual({ names: { [b]: "Two" } });
    expect(await (await route.PUT(put(token, { address: b, name: "  " }))).json()).toEqual({ names: {} });
  });

  it("writes nothing, and spends no save, when the name is already what was asked", async () => {
    const store = memoryWalletNamesStore();
    const write = vi.spyOn(store, "write");
    const writesPerUser = createWeightedLimiter({ capacity: 1, refillPerMinute: 1 / 60 });
    const { route } = routeWith({ store, budgets: { writesPerUser } });
    const token = await tokenFor(ALICE);
    const wallet = someWallet();
    expect((await route.PUT(put(token, { address: wallet, name: "Same" }))).status).toBe(200);
    for (let i = 0; i < 3; i += 1) expect((await route.PUT(put(token, { address: wallet, name: "Same" }))).status).toBe(200);
    expect((await route.PUT(put(token, { address: someWallet(), name: null }))).status).toBe(200);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("applies a save over another device's that landed in between, once", async () => {
    const store = memoryWalletNamesStore();
    const { route } = routeWith({ store });
    const token = await tokenFor(ALICE);
    const [mine, theirs] = [someWallet(), someWallet()];
    await route.PUT(put(token, { address: theirs, name: "Before" }));
    // Another instance saves for the same account: this instance's copy is now older than the store.
    const stored = await store.read(ALICE);
    await store.write(ALICE, { ...stored.names, [theirs]: "Theirs" }, stored.etag);
    const response = await route.PUT(put(token, { address: mine, name: "Mine" }));
    expect(await response.json()).toEqual({ names: { [theirs]: "Theirs", [mine]: "Mine" } });
    expect((await store.read(ALICE)).names).toEqual({ [theirs]: "Theirs", [mine]: "Mine" });
  });

  it("keeps both of two first saves that cross: the first may only create the document", async () => {
    const store = memoryWalletNamesStore();
    const { route } = routeWith({ store });
    const [mine, theirs] = [someWallet(), someWallet()];
    // The other device's very first save lands between this request's read (no document yet) and its write.
    const realRead = store.read.bind(store);
    let raced = false;
    vi.spyOn(store, "read").mockImplementation(async (userId) => {
      const read = await realRead(userId);
      if (!raced) {
        raced = true;
        await store.write(userId, { [theirs]: "Theirs" }, null);
      }
      return read;
    });
    const response = await route.PUT(put(await tokenFor(ALICE), { address: mine, name: "Mine" }));
    expect(await response.json()).toEqual({ names: { [theirs]: "Theirs", [mine]: "Mine" } });
  });

  it("is 503 names_unavailable when the store fails, and the log names the error's class, never the user, a name or a token", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failing = {
      read: async () => {
        throw new Error(`store store_test said no for ${ALICE}`);
      },
      write: async () => '"never"',
    } satisfies WalletNamesStore;
    const token = await tokenFor(ALICE);
    const response = await routeWith({ store: failing }).route.GET(get(token));
    expect(response.status).toBe(503);
    expect(await codeOf(response)).toBe("names_unavailable");
    const logged = warn.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain('"error":"Error"');
    expect(logged).not.toContain(ALICE);
    expect(logged).not.toContain(token);
    expect(logged).not.toContain("store_test");
    warn.mockRestore();
  });

  it("gives up after a second lost race rather than looping", async () => {
    const store = { read: async () => ({ names: {}, etag: '"v1"' }), write: async (): Promise<string> => Promise.reject(new WalletNamesConflict()) } satisfies WalletNamesStore;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await routeWith({ store }).route.PUT(put(await tokenFor(ALICE), { address: someWallet(), name: "x" }));
    expect(response.status).toBe(503);
    warn.mockRestore();
  });
});

describe("what a save may carry", () => {
  it("refuses anything but a Solana address, a name the box would take, or null", async () => {
    const { route } = routeWith();
    const token = await tokenFor(ALICE);
    const wallet = someWallet();
    for (const body of [
      { address: "not-an-address", name: "x" },
      { address: "0x0000000000000000000000000000000000000001", name: "x" },
      { address: wallet, name: 7 },
      { address: wallet },
      { address: wallet, name: "x", extra: true },
      { address: wallet, name: "a".repeat(33) },
      { address: wallet, name: "two\nlines" },
      ["not", "an", "object"],
    ]) {
      const response = await route.PUT(put(token, body));
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await codeOf(response)).toBe("bad_request");
    }
    const tooLong = await route.PUT(put(token, { address: wallet, name: "a".repeat(33) }));
    expect(((await tooLong.json()) as { error: { message: string } }).error.message).toBe(WALLET_NAME_COPY.tooLong);
  });

  it("refuses a body that is not JSON, or too large", async () => {
    const { route } = routeWith();
    const token = await tokenFor(ALICE);
    expect((await route.PUT(put(token, { address: someWallet(), name: "x" }, { "content-type": "text/plain" }))).status).toBe(415);
    expect((await route.PUT(put(token, "{nope"))).status).toBe(400);
    expect((await route.PUT(put(token, JSON.stringify({ address: someWallet(), name: "x".repeat(WALLET_NAMES_MAX_BODY_BYTES) })))).status).toBe(413);
  });

  it("keeps at most WALLET_NAMES_MAX names, and still lets one be renamed or cleared at the cap", async () => {
    const { route, store } = routeWith();
    const full = Object.fromEntries(Array.from({ length: WALLET_NAMES_MAX }, (_, index) => [someWallet(), `W${index}`]));
    await store.write(ALICE, full, null);
    const token = await tokenFor(ALICE);
    const response = await route.PUT(put(token, { address: someWallet(), name: "One more" }));
    expect(response.status).toBe(409);
    expect(await codeOf(response)).toBe("too_many_names");
    const first = Object.keys(full)[0]!;
    expect((await route.PUT(put(token, { address: first, name: "Renamed" }))).status).toBe(200);
    expect((await route.PUT(put(token, { address: first, name: null }))).status).toBe(200);
  });
});

describe("this instance's copy: the store is read as seldom as it can be", () => {
  it("answers a reload, a second tab and a save from its copy, and reads the store again only once the copy is old", async () => {
    const { store, read, write } = countingStore();
    let clock = NOW;
    const { route } = routeWith({ store, now: () => clock });
    const token = await tokenFor(ALICE);
    const wallet = someWallet();
    for (let i = 0; i < 5; i += 1) expect((await route.GET(get(token))).status).toBe(200);
    expect(read).toHaveBeenCalledTimes(1);
    expect((await route.PUT(put(token, { address: wallet, name: "Main" }))).status).toBe(200);
    expect(read).toHaveBeenCalledTimes(1);
    expect(await (await route.GET(get(token))).json()).toEqual({ names: { [wallet]: "Main" } });
    expect(read).toHaveBeenCalledTimes(1);
    clock += WALLET_NAMES_COPY_MS;
    expect(await (await route.GET(get(token))).json()).toEqual({ names: { [wallet]: "Main" } });
    expect(read).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("shows another instance's save once its copy is old, and confirms with the store a save its copy calls unchanged", async () => {
    const store = memoryWalletNamesStore();
    let clock = NOW;
    const here = routeWith({ store, now: () => clock }).route;
    const there = routeWith({ store, now: () => clock }).route;
    const token = await tokenFor(ALICE);
    const wallet = someWallet();
    await here.PUT(put(token, { address: wallet, name: "Old" }));
    await there.PUT(put(token, { address: wallet, name: "New" }));
    // Here still holds "Old"; a save of "Old" from here must not be answered as already done.
    expect(await (await here.PUT(put(token, { address: wallet, name: "Old" }))).json()).toEqual({ names: { [wallet]: "Old" } });
    expect((await store.read(ALICE)).names).toEqual({ [wallet]: "Old" });
    await there.PUT(put(token, { address: wallet, name: "Newer" }));
    clock += WALLET_NAMES_COPY_MS;
    expect(await (await here.GET(get(token))).json()).toEqual({ names: { [wallet]: "Newer" } });
  });

  it("past the account's reads, answers its copy of any age, and refuses only when it holds no copy", async () => {
    const { store, read } = countingStore();
    const copies: WalletNamesCopies = new Map();
    let clock = NOW;
    const { route } = routeWith({ store, copies, now: () => clock, budgets: { readsPerUser: createWeightedLimiter({ capacity: 1, refillPerMinute: 1 / 1_440 }) } });
    const token = await tokenFor(ALICE);
    expect((await route.GET(get(token))).status).toBe(200);
    clock += 3 * WALLET_NAMES_COPY_MS;
    expect((await route.GET(get(token))).status).toBe(200);
    expect(read).toHaveBeenCalledTimes(1);
    // The copy gone (dropped as least recently used, say), and the account's reads spent: told when to retry.
    copies.clear();
    const refused = await route.GET(get(token));
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).not.toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe("the month, at the budgets' production sizes (Hobby: 10,000 reads and 2,000 saves a month, store-wide)", () => {
  const MINUTE = 60_000;
  const DAY = 24 * 60 * MINUTE;
  /** A session that outlives the simulated day. */
  const dayToken = (userId: string): Promise<string> => tokenFor(userId, Math.floor((NOW + 2 * DAY) / 1_000));

  it("holds one instance, spent flat out every minute of a 31-day month, inside the month", () => {
    const budgets = walletNamesBudgets();
    let reads = 0;
    let writes = 0;
    for (let at = NOW; at < NOW + 31 * DAY; at += MINUTE) {
      if (budgets.readsGlobal.take("global", 1, at) === 0) reads += 1;
      if (budgets.writesGlobal.take("global", 1, at) === 0) writes += 1;
    }
    // A full bucket at the start, then a day's refill for each of the 31 days.
    expect(reads).toBeLessThanOrEqual(WALLET_NAMES_READS_PER_DAY * 32);
    expect(writes).toBeLessThanOrEqual(WALLET_NAMES_WRITES_PER_DAY * 32);
    expect(WALLET_NAMES_READS_PER_DAY * 32).toBeLessThan(10_000);
    expect(WALLET_NAMES_WRITES_PER_DAY * 32).toBeLessThan(2_000);
  });

  it("lets a script reading one account all day cost a day of that account's reads, and answers it all the same", async () => {
    const { store, read } = countingStore();
    let clock = NOW;
    const { route } = routeWith({ store, now: () => clock, budgets: walletNamesBudgets() });
    const token = await dayToken(ALICE);
    for (; clock < NOW + DAY; clock += MINUTE) {
      const response = await route.GET(get(token));
      expect(response.status).toBe(200);
    }
    expect(read.mock.calls.length).toBeLessThanOrEqual(2 * WALLET_NAMES_READS_PER_USER);
  });

  it("lets a script saving the same name all day cost one save and a day of the account's reads", async () => {
    const { store, read, write } = countingStore();
    let clock = NOW;
    const { route } = routeWith({ store, now: () => clock, budgets: walletNamesBudgets() });
    const token = await dayToken(ALICE);
    const wallet = someWallet();
    for (; clock < NOW + DAY; clock += MINUTE) {
      expect((await route.PUT(put(token, { address: wallet, name: "Same" }))).status).toBe(200);
    }
    expect(write).toHaveBeenCalledTimes(1);
    expect(read.mock.calls.length).toBeLessThanOrEqual(2 * WALLET_NAMES_READS_PER_USER);
  });

  it("lets a crowd of accounts renaming all day save no more than the instance's day", async () => {
    const { store, write } = countingStore();
    let clock = NOW;
    const { route } = routeWith({ store, now: () => clock, budgets: walletNamesBudgets() });
    const crowd = await Promise.all(Array.from({ length: 12 }, (_, index) => dayToken(`did:privy:crowd${String(index).padStart(21, "0")}`)));
    const statuses = new Set<number>();
    for (; clock < NOW + DAY; clock += 30 * MINUTE) {
      for (const token of crowd) statuses.add((await route.PUT(put(token, { address: someWallet(), name: "x" }))).status);
    }
    expect(write.mock.calls.length).toBeLessThanOrEqual(2 * WALLET_NAMES_WRITES_PER_DAY);
    expect(write.mock.calls.length).toBeGreaterThanOrEqual(WALLET_NAMES_WRITES_PER_DAY);
    expect([...statuses].sort()).toEqual([200, 429]);
    // No one account took the day: each is held to its own.
    expect(WALLET_NAMES_WRITES_PER_USER).toBeLessThan(WALLET_NAMES_WRITES_PER_DAY);
  });
});

describe("the budgets", () => {
  it("limits one client, with a retry-after, before it is verified", async () => {
    const { route } = routeWith({ budgets: { exact: createWeightedLimiter({ capacity: 2 }) } });
    const token = await tokenFor(ALICE);
    const ip = { "x-real-ip": "203.0.113.9" };
    expect((await route.GET(get(token, ip))).status).toBe(200);
    expect((await route.GET(get(token, ip))).status).toBe(200);
    const limited = await route.GET(get("junk", ip));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).not.toBeNull();
    expect(await codeOf(limited)).toBe("rate_limited");
    // Another client is not held back by it.
    expect((await route.GET(get(token))).status).toBe(200);
  });

  it("limits one account's saves, from any address", async () => {
    const { route } = routeWith({ budgets: { writesPerUser: createWeightedLimiter({ capacity: 2, refillPerMinute: 2 / 1_440 }) } });
    const alice = await tokenFor(ALICE);
    expect((await route.PUT(put(alice, { address: someWallet(), name: "a" }))).status).toBe(200);
    expect((await route.PUT(put(alice, { address: someWallet(), name: "b" }))).status).toBe(200);
    expect((await route.PUT(put(alice, { address: someWallet(), name: "c" }))).status).toBe(429);
    // Bob still saves; Alice still reads.
    expect((await route.PUT(put(await tokenFor(BOB), { address: someWallet(), name: "d" }))).status).toBe(200);
    expect((await route.GET(get(alice))).status).toBe(200);
  });

  it("limits this instance's saves, across every account", async () => {
    const { route } = routeWith({ budgets: { writesGlobal: createWeightedLimiter({ capacity: 2, refillPerMinute: 2 / 1_440 }) } });
    expect((await route.PUT(put(await tokenFor(ALICE), { address: someWallet(), name: "a" }))).status).toBe(200);
    expect((await route.PUT(put(await tokenFor(BOB), { address: someWallet(), name: "b" }))).status).toBe(200);
    const third = await route.PUT(put(await tokenFor("did:privy:carol000000000000000000000c"), { address: someWallet(), name: "c" }));
    expect(third.status).toBe(429);
    expect(await codeOf(third)).toBe("rate_limited");
  });

  it("limits this instance's store reads, across every account", async () => {
    const { route } = routeWith({ budgets: { readsGlobal: createWeightedLimiter({ capacity: 1, refillPerMinute: 1 / 1_440 }) } });
    expect((await route.GET(get(await tokenFor(ALICE)))).status).toBe(200);
    expect((await route.GET(get(await tokenFor(BOB)))).status).toBe(429);
  });

  it("logs refusals by status and code only", async () => {
    const { route, refusals } = routeWith();
    await route.GET(get(null));
    expect(refusals).toEqual([{ status: 401, code: "no_token" }]);
  });
});
