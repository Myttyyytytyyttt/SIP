// THE SHORT LINKS' STORE (owner, 10-23: "Cortos con Vercel Blob"): a card's
// record is written once and only then are its links short; anything the store
// does wrong — absent, slow, full, refusing, holding something else — and the
// links are the long ones, as before. A code is read from the store once per
// instance; one this server never made is not read at all. Nothing here
// reaches Vercel: the store is in memory, and so is the SDK under the adapter.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { toDashboardMock } from "@/lib/live-mock";
import { SHARE_BACKGROUNDS, shareCardOf, unitsOf, type ShareCardData, type ShareLinks } from "@/lib/live-share";
import { shareCardIdOf, shareRecordOf, shareRecordPath, shortShareLinks } from "@/lib/share-code";
import {
  BLOB_OIDC_TOKEN_ENV,
  BLOB_STORE_ID_ENV,
  BLOB_TOKEN_ENV,
  SHARE_RECORD_MAX_AGE_S,
  SHARE_STORE_MISS_MS,
  SHARE_STORE_READS_PER_MIN,
  SHARE_STORE_WRITE_MS,
  SHARE_STORE_WRITES_PER_DAY,
  ShareStoreError,
  blobShareStore,
  forgetShareStore,
  openSharedCard,
  shareStoreAuthOf,
  shortLinksOf,
} from "@/lib/share-store";
import { SHARE_SECRET_ENV, SHARE_SECRET_PREVIOUS_ENV, openShareToken, signShareLinks } from "@/lib/share-token";

import { OWNER, VAULT, WALLET_A, liveDashboard } from "../../test/fixtures/live-dashboard";
import { blobSdkMemory, memoryStore } from "../../test/fixtures/share-store-memory";

const sdk = vi.hoisted(() => ({ current: null as ReturnType<typeof import("../../test/fixtures/share-store-memory").blobSdkMemory> | null }));
vi.mock("@vercel/blob", async (importOriginal) => {
  const real = await importOriginal<typeof import("@vercel/blob")>();
  return {
    ...real,
    put: (...args: Parameters<ReturnType<typeof blobSdkMemory>["put"]>) => sdk.current!.put(...args),
    get: (...args: Parameters<ReturnType<typeof blobSdkMemory>["get"]>) => sdk.current!.get(...args),
  };
});

const SECRET = "a".repeat(64);
const KEY = Buffer.from(SECRET);
const BLOB_TOKEN = "vercel_blob_rw_TESTSTORE_THISISNOTAREALTOKEN";
const ENV = { [SHARE_SECRET_ENV]: SECRET };
const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);
const DAY = 86_400_000;

const page = toDashboardMock(liveDashboard(), { complete: false });
const card = (over: Partial<ShareCardData> = {}): ShareCardData => ({
  ...shareCardOf({ lifetimeSaved: 11_420_734_512n, stats: page.stats, rule: page.rule, now: page.now }),
  usdText: "$2,073.42",
  usdCompact: "$2.1K",
  streakDays: 13,
  basket: ["SPYx", "ANTHROPIC"],
  ...over,
});
const linksOf = (shown: ShareCardData = card()): ShareLinks => signShareLinks(shown, unitsOf(shown), KEY);
const allPaths = (links: ShareLinks): string[] => SHARE_BACKGROUNDS.flatMap((background) => Object.values(links[background]));
const isShort = (links: ShareLinks): boolean => allPaths(links).every((path) => /^\/c\/[0-9A-Za-z]{8}$/.test(path));

let warnings: string[] = [];
beforeEach(() => {
  forgetShareStore();
  sdk.current = blobSdkMemory();
  warnings = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => void warnings.push(args.map(String).join(" ")));
});
afterEach(() => {
  vi.restoreAllMocks();
  forgetShareStore();
});

/** Nothing anyone should not read in a log line: no token, no code, no record's path, no secret, no credential, no address. */
function expectQuietLogs(links: ShareLinks[]): void {
  const said = warnings.join("\n");
  for (const each of links) for (const path of allPaths(each)) expect(said).not.toContain(path.slice(3));
  for (const secret of [SECRET, BLOB_TOKEN, OWNER, VAULT, WALLET_A, ".json"]) expect(said).not.toContain(secret);
}

describe("whether there is a store", () => {
  it("a static token first; else a store id with Vercel's OIDC token; else none — and never a value but trimmed", () => {
    expect(shareStoreAuthOf({ [BLOB_TOKEN_ENV]: ` ${BLOB_TOKEN} ` })).toEqual({ token: BLOB_TOKEN });
    expect(shareStoreAuthOf({ [BLOB_TOKEN_ENV]: BLOB_TOKEN, [BLOB_STORE_ID_ENV]: "store_abc", VERCEL: "1" })).toEqual({ token: BLOB_TOKEN });
    expect(shareStoreAuthOf({ [BLOB_STORE_ID_ENV]: "store_abc", VERCEL: "1" })).toEqual({ storeId: "store_abc" });
    expect(shareStoreAuthOf({ [BLOB_STORE_ID_ENV]: "store_abc", [BLOB_OIDC_TOKEN_ENV]: "eyJ.oidc" })).toEqual({ storeId: "store_abc" });
    // A store id with no OIDC token to use it: none — the SDK is never left to go and find credentials on its own.
    expect(shareStoreAuthOf({ [BLOB_STORE_ID_ENV]: "store_abc" })).toBeNull();
    expect(shareStoreAuthOf({ [BLOB_TOKEN_ENV]: "  ", VERCEL: "1" })).toBeNull();
    expect(shareStoreAuthOf({})).toBeNull();
  });
});

describe("/api/share's links: short once the record is kept", () => {
  it("a new card: one write, then six short links — which open to the long ones' cards", async () => {
    const store = memoryStore();
    const links = linksOf();
    const short = await shortLinksOf(links, KEY, { env: ENV, store, now: () => NOW });
    expect(isShort(short)).toBe(true);
    expect(store.created).toEqual([shareRecordPath(shareCardIdOf(shareRecordOf(links)!, KEY))]);
    expect(JSON.parse(store.records.get(store.created[0]!)!)).toEqual(shareRecordOf(links));
    for (const background of SHARE_BACKGROUNDS) {
      for (const unit of ["usd", "sol"] as const) {
        const opened = await openSharedCard(short[background][unit]!.slice(3), { env: ENV, store, now: () => NOW });
        expect(opened).toEqual({ kind: "card", opened: openShareToken(links[background][unit]!.slice(3), ENV) });
      }
    }
    // What this instance wrote, it does not read back.
    expect(store.reads).toEqual([]);
  });

  it("the same card twice: the same links, and still one write", async () => {
    const store = memoryStore();
    const first = await shortLinksOf(linksOf(), KEY, { env: ENV, store, now: () => NOW });
    const again = await shortLinksOf(linksOf(), KEY, { env: ENV, store, now: () => NOW + 1_000 });
    expect(again).toEqual(first);
    expect(store.created).toHaveLength(1);
    expect(store.refused).toEqual([]);
  });

  it("asked by another instance (or after a deploy): the record is there already — read back, it is this card's, so the same short links", async () => {
    const store = memoryStore();
    const first = await shortLinksOf(linksOf(), KEY, { env: ENV, store, now: () => NOW });
    forgetShareStore();
    const elsewhere = await shortLinksOf(linksOf(), KEY, { env: ENV, store, now: () => NOW });
    expect(elsewhere).toEqual(first);
    expect([store.created.length, store.refused.length, store.reads.length]).toEqual([1, 1, 1]);
  });

  it("something else under the card's id: the long links, never a code that would open another card", async () => {
    const store = memoryStore();
    const links = linksOf();
    store.records.set(shareRecordPath(shareCardIdOf(shareRecordOf(links)!, KEY)), JSON.stringify({ v: 1, t: ["x.y", null, null, null, null, null] }));
    expect(await shortLinksOf(links, KEY, { env: ENV, store, now: () => NOW })).toBe(links);
    expectQuietLogs([links]);
    expect(warnings.join("\n")).toContain('"kind":"write_conflict"');
  });

  it("no store: exactly the long links, as before — said once, naming the variables and no value", async () => {
    const links = linksOf();
    expect(await shortLinksOf(links, KEY, { env: ENV, now: () => NOW })).toBe(links);
    expect(await shortLinksOf(links, KEY, { env: { ...ENV, [BLOB_STORE_ID_ENV]: "store_abc" }, now: () => NOW })).toBe(links);
    expect(await shortLinksOf(links, KEY, { env: ENV, store: null, now: () => NOW })).toBe(links);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("web.share.short_links_off");
    expect(warnings[0]).toContain(BLOB_TOKEN_ENV);
    expect(warnings[0]).toContain(BLOB_STORE_ID_ENV);
    expect(sdk.current!.calls).toEqual([]);
    expectQuietLogs([links]);
  });

  it("a store over its quota, unreachable or refusing: the long links, and the kind of failure in the log, once a minute", async () => {
    const store = memoryStore();
    const links = linksOf();
    for (const kind of ["store_suspended", "network", "forbidden"]) {
      store.failure = new ShareStoreError(kind);
      expect(await shortLinksOf(links, KEY, { env: ENV, store, now: () => NOW })).toBe(links);
      expect(await shortLinksOf(links, KEY, { env: ENV, store, now: () => NOW + 1_000 })).toBe(links);
    }
    expect(warnings.map((line) => JSON.parse(line).kind)).toEqual(["write_store_suspended", "write_network", "write_forbidden"]);
    expect(store.created).toEqual([]);
    expectQuietLogs([links]);
    // Back: the very next ask is short.
    store.failure = null;
    expect(isShort(await shortLinksOf(links, KEY, { env: ENV, store, now: () => NOW + 2_000 }))).toBe(true);
  });

  it("a store that hangs: the long links within SHARE_STORE_WRITE_MS, so Post on X is never kept waiting by it", async () => {
    const store = memoryStore();
    store.delayMs = 30_000;
    const links = linksOf();
    const started = Date.now();
    expect(await shortLinksOf(links, KEY, { env: ENV, store, now: () => NOW })).toBe(links);
    expect(Date.now() - started).toBeLessThan(SHARE_STORE_WRITE_MS + 1_000);
    expect(warnings.join("\n")).toContain('"kind":"write_timeout"');
  });

  it(`at most ${SHARE_STORE_WRITES_PER_DAY} writes a day per instance: past them, long links — and none of them kept from the next day`, async () => {
    const store = memoryStore();
    // Some short: a card whose two variants drew one tag keeps that one long (share-code.ts).
    const someShort = (links: ShareLinks): boolean => allPaths(links).some((path) => /^\/c\/[0-9A-Za-z]{8}$/.test(path));
    for (let i = 0; i < SHARE_STORE_WRITES_PER_DAY; i += 1) {
      expect(someShort(await shortLinksOf(linksOf(card({ usdText: `$${i + 1}.00`, usdCompact: `$${i + 1}` })), KEY, { env: ENV, store, now: () => NOW + i }))).toBe(true);
      expect(store.created).toHaveLength(i + 1);
    }
    const over = linksOf(card({ usdText: "$999.00", usdCompact: "$999" }));
    expect(await shortLinksOf(over, KEY, { env: ENV, store, now: () => NOW + 1_000 })).toBe(over);
    expect(store.created).toHaveLength(SHARE_STORE_WRITES_PER_DAY);
    // A card already written costs nothing, budget or not.
    expect(someShort(await shortLinksOf(linksOf(card({ usdText: "$1.00", usdCompact: "$1" })), KEY, { env: ENV, store, now: () => NOW + 2_000 }))).toBe(true);
    expect(store.created).toHaveLength(SHARE_STORE_WRITES_PER_DAY);
    expect(someShort(await shortLinksOf(over, KEY, { env: ENV, store, now: () => NOW + DAY }))).toBe(true);
    expect(warnings.join("\n")).toContain('"kind":"write_budget"');
  });
});

describe("/c/<code>: read once per instance, and only for a code this server could have made", () => {
  async function written(store = memoryStore()) {
    const links = linksOf();
    const short = await shortLinksOf(links, KEY, { env: ENV, store, now: () => NOW });
    forgetShareStore();
    return { store, links, short, code: short.vault.usd!.slice(3) };
  }

  it("a code: its card, read from the store once; asked again, or by two at once, not read again", async () => {
    const { store, links, code } = await written();
    const [a, b] = await Promise.all([openSharedCard(code, { env: ENV, store, now: () => NOW }), openSharedCard(code, { env: ENV, store, now: () => NOW })]);
    const expected = { kind: "card", opened: openShareToken(links.vault.usd!.slice(3), ENV) };
    expect([a, b]).toEqual([expected, expected]);
    expect(await openSharedCard(code, { env: ENV, store, now: () => NOW + 365 * DAY })).toEqual(expected);
    expect(store.reads).toHaveLength(1);
  });

  it("a long token: as it always was, and the store is never asked — with one or without", async () => {
    const { store, links } = await written();
    expect(await openSharedCard(links.grid.sol!.slice(3), { env: ENV, store })).toEqual({ kind: "card", opened: openShareToken(links.grid.sol!.slice(3), ENV) });
    expect(await openSharedCard(links.grid.sol!.slice(3), { env: ENV, store: null })).toMatchObject({ kind: "card" });
    expect(store.reads).toEqual([]);
  });

  it("a code this server never made: missing, and the store is not asked", async () => {
    const { store, code } = await written();
    const guesses = ["AAAAAAAA", "zzzzzzzz", `${code.slice(0, 7)}${code[7] === "a" ? "b" : "a"}`, `${code.slice(0, 6)}${code[6] === "a" ? "b" : "a"}${code[7]}`];
    for (const guess of guesses) expect(await openSharedCard(guess, { env: ENV, store, now: () => NOW }), guess).toEqual({ kind: "missing" });
    expect(store.reads).toEqual([]);
  });

  it("a code whose record is not there: missing — believed for SHARE_STORE_MISS_MS, then asked again", async () => {
    const store = memoryStore();
    const links = linksOf(card({ usdText: "$5.00", usdCompact: "$5" }));
    const code = shortShareLinks(links, shareRecordOf(links)!, KEY).grid.usd!.slice(3);
    expect(await openSharedCard(code, { env: ENV, store, now: () => NOW })).toEqual({ kind: "missing" });
    expect(await openSharedCard(code, { env: ENV, store, now: () => NOW + SHARE_STORE_MISS_MS - 1 })).toEqual({ kind: "missing" });
    expect(store.reads).toHaveLength(1);
    await shortLinksOf(links, KEY, { env: ENV, store, now: () => NOW });
    forgetShareStore();
    expect(await openSharedCard(code, { env: ENV, store, now: () => NOW + SHARE_STORE_MISS_MS })).toMatchObject({ kind: "card" });
  });

  it("a stored record with a token changed by one character: missing — the MAC refuses it", async () => {
    const { store, code } = await written();
    const [path, text] = [...store.records][0]!;
    const record = JSON.parse(text) as { v: 1; t: (string | null)[] };
    const t = record.t.map((token) => (token === null ? null : `${token.slice(0, 12)}${token[12] === "A" ? "B" : "A"}${token.slice(13)}`));
    store.records.set(path, JSON.stringify({ v: 1, t }));
    expect(await openSharedCard(code, { env: ENV, store, now: () => NOW })).toEqual({ kind: "missing" });
  });

  it("a store that cannot answer: unavailable — a try-again, not a 404 — and not kept: the next ask reads", async () => {
    const { store, code } = await written();
    store.failure = new ShareStoreError("store_suspended");
    expect(await openSharedCard(code, { env: ENV, store, now: () => NOW })).toEqual({ kind: "unavailable" });
    store.failure = null;
    expect(await openSharedCard(code, { env: ENV, store, now: () => NOW + 1 })).toMatchObject({ kind: "card" });
    expect(warnings.join("\n")).toContain('"kind":"read_store_suspended"');
    expectQuietLogs([]);
  });

  it(`at most ${SHARE_STORE_READS_PER_MIN} reads a minute per instance reach the store; past them, unavailable`, async () => {
    const store = memoryStore();
    const codes: string[] = [];
    for (let i = 0; codes.length <= SHARE_STORE_READS_PER_MIN; i += 1) {
      const links = linksOf(card({ usdText: `$${i + 1}.00`, usdCompact: `$${i + 1}` }));
      codes.push(shortShareLinks(links, shareRecordOf(links)!, KEY).grid.usd!.slice(3));
    }
    for (const code of codes.slice(0, SHARE_STORE_READS_PER_MIN)) expect(await openSharedCard(code, { env: ENV, store, now: () => NOW })).toEqual({ kind: "missing" });
    expect(await openSharedCard(codes.at(-1)!, { env: ENV, store, now: () => NOW + 1 })).toEqual({ kind: "unavailable" });
    expect(store.reads).toHaveLength(SHARE_STORE_READS_PER_MIN);
    expect(await openSharedCard(codes.at(-1)!, { env: ENV, store, now: () => NOW + 60_000 })).toEqual({ kind: "missing" });
  });

  it("links off, or no store: a code is missing; while a rotation settles, one made under the previous secret opens", async () => {
    const { store, code } = await written();
    expect(await openSharedCard(code, { env: {}, store })).toEqual({ kind: "missing" });
    expect(await openSharedCard(code, { env: ENV, store: null })).toEqual({ kind: "missing" });
    expect(await openSharedCard(code, { env: ENV })).toEqual({ kind: "missing" });
    const rotated = { [SHARE_SECRET_ENV]: "n".repeat(64), [SHARE_SECRET_PREVIOUS_ENV]: SECRET };
    expect(await openSharedCard(code, { env: rotated, store, now: () => NOW })).toMatchObject({ kind: "card" });
  });
});

describe("the private Blob store under it (the SDK in memory)", () => {
  it("writes once, private, under its own name, never over anything, a year in Blob's cache — with the token it was given", async () => {
    const store = blobShareStore({ token: BLOB_TOKEN });
    const signal = new AbortController().signal;
    await store.create("c/abcdef.json", '{"v":1}', signal);
    expect(sdk.current!.calls).toEqual([
      {
        op: "put",
        path: "c/abcdef.json",
        options: { access: "private", addRandomSuffix: false, allowOverwrite: false, contentType: "application/json", cacheControlMaxAge: SHARE_RECORD_MAX_AGE_S, abortSignal: signal, token: BLOB_TOKEN },
      },
    ]);
    expect(await store.read("c/abcdef.json", signal)).toBe('{"v":1}');
    expect(sdk.current!.calls[1]).toEqual({ op: "get", path: "c/abcdef.json", options: { access: "private", abortSignal: signal, token: BLOB_TOKEN } });
    expect(await store.read("c/nothere.json", signal)).toBeNull();
    await expect(store.create("c/abcdef.json", '{"v":1}', signal)).rejects.toBeInstanceOf(ShareStoreError);
  });

  it("with OIDC: the store id, and no token of its own", async () => {
    const store = blobShareStore({ storeId: "store_abc" });
    await store.create("c/abcdef.json", "{}", new AbortController().signal);
    expect(sdk.current!.calls[0]!.options).toMatchObject({ storeId: "store_abc" });
    expect(sdk.current!.calls[0]!.options).not.toHaveProperty("token");
  });

  it("the SDK's errors become kinds, matched by class: what the log may say", async () => {
    const blob = await import("@vercel/blob");
    const store = blobShareStore({ token: BLOB_TOKEN });
    const signal = new AbortController().signal;
    for (const [error, kind] of [
      [new blob.BlobStoreSuspendedError(), "store_suspended"],
      [new blob.BlobAccessError(), "forbidden"],
      [new blob.BlobStoreNotFoundError(), "store_not_found"],
      [new blob.BlobServiceRateLimited(30), "rate_limited"],
      [new blob.BlobServiceNotAvailable(), "service_unavailable"],
      [new blob.BlobUnknownError(), "unknown_error"],
      [new blob.BlobError("This blob already exists"), "refused"],
      [new TypeError("fetch failed"), "network"],
    ] as const) {
      sdk.current!.failure = () => error;
      await expect(store.create("c/x.json", "{}", signal)).rejects.toMatchObject({ kind });
      await expect(store.read("c/x.json", signal)).rejects.toMatchObject({ kind });
    }
  });

  it("a record larger than any this server writes is refused, not read whole", async () => {
    sdk.current!.records.set("c/big.json", "x".repeat(20_000));
    await expect(blobShareStore({ token: BLOB_TOKEN }).read("c/big.json", new AbortController().signal)).rejects.toMatchObject({ kind: "record_too_large" });
  });

  it("end to end from the environment: BLOB_READ_WRITE_TOKEN set, links short through the SDK; one put, then a code opens with one get", async () => {
    const env = { ...ENV, [BLOB_TOKEN_ENV]: BLOB_TOKEN };
    const links = linksOf();
    const short = await shortLinksOf(links, KEY, { env, now: () => NOW });
    expect(isShort(short)).toBe(true);
    forgetShareStore();
    expect(await openSharedCard(short.streaks.sol!.slice(3), { env, now: () => NOW })).toEqual({ kind: "card", opened: openShareToken(links.streaks.sol!.slice(3), ENV) });
    expect(sdk.current!.calls.map((call) => call.op)).toEqual(["put", "get"]);
    expectQuietLogs([links, short]);
  });
});
