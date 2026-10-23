// The Blob store as this feature calls it (owner, 10-23): found by the short links' rule and reached with the
// credential that rule names, passed to every call (share-store.ts shareStoreAuthOf) — private, one document per
// login under wallet-names/, read from the origin rather than the CDN, saved over the etag it was read at, and
// never listed; a failure said by kind. @vercel/blob is replaced by a recorder: nothing reaches Vercel.

import { describe, expect, it, vi } from "vitest";

const blob = vi.hoisted(() => {
  // The SDK's shapes: every error is a BlobError, its message prefixed "Vercel Blob: ".
  class BlobError extends Error {
    constructor(message: string) {
      super(`Vercel Blob: ${message}`);
    }
  }
  class BlobPreconditionFailedError extends BlobError {
    constructor() {
      super("Precondition failed: ETag mismatch.");
    }
  }
  class BlobStoreSuspendedError extends BlobError {
    constructor() {
      super("This store has been suspended.");
    }
  }
  return {
    BlobError,
    BlobPreconditionFailedError,
    BlobStoreSuspendedError,
    get: vi.fn(),
    put: vi.fn(),
    list: vi.fn(),
    del: vi.fn(),
  };
});
// The real module under the recorder, so every class the error kinds name is there (share-store.ts kindOf).
vi.mock("@vercel/blob", async (importOriginal) => ({ ...(await importOriginal<typeof import("@vercel/blob")>()), ...blob }));

import { ShareStoreError } from "@/lib/share-store";
import { WALLET_NAMES_PREFIX, WalletNamesConflict, blobWalletNamesStore, walletNamesPath, walletNamesStoreOf } from "@/lib/wallet-names-store";

const USER = "did:privy:cm1testuser0000000000000a";
/** As Vercel connected the store: a store id, for the request's OIDC token. */
const KEYLESS = { storeId: "store_abc" } as const;
const TOKEN = { token: "vercel_blob_rw_TESTSTORE_THISISNOTAREALTOKEN" } as const;
const WALLET = "TradingZeroP1aceho1der11111111111111111111";

const stream = (value: unknown): ReadableStream<Uint8Array> => new Response(JSON.stringify(value)).body!;

describe("blobWalletNamesStore", () => {
  it("reads the login's one document from the origin, privately, and keeps its etag", async () => {
    blob.get.mockResolvedValueOnce({ statusCode: 200, stream: stream({ v: 1, names: { [WALLET]: "Axiom", junk: "x" } }), headers: new Headers(), blob: { etag: '"e1"' } });
    expect(await blobWalletNamesStore(KEYLESS).read(USER)).toEqual({ names: { [WALLET]: "Axiom" }, etag: '"e1"' });
    const [path, options] = blob.get.mock.calls.at(-1)!;
    expect(path).toBe(walletNamesPath(USER));
    expect(options).toMatchObject({ access: "private", useCache: false, storeId: "store_abc" });
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
    // The store id the rule found, and no token: the SDK pairs it with the request's OIDC token, and looks for nothing else.
    expect(options).not.toHaveProperty("token");
  });

  it("passes a read-write token, when that is what the rule found, to reads and saves alike — and no store id", async () => {
    blob.get.mockResolvedValueOnce(null);
    blob.put.mockResolvedValueOnce({ etag: '"t1"' });
    const store = blobWalletNamesStore(TOKEN);
    await store.read(USER);
    await store.write(USER, {}, null);
    for (const options of [blob.get.mock.calls.at(-1)![1], blob.put.mock.calls.at(-1)![2]]) {
      expect(options).toMatchObject(TOKEN);
      expect(options).not.toHaveProperty("storeId");
    }
  });

  it("reads no document as no names, with no etag", async () => {
    blob.get.mockResolvedValueOnce(null);
    expect(await blobWalletNamesStore(KEYLESS).read(USER)).toEqual({ names: {}, etag: null });
  });

  it("reads a document it cannot parse as no names, keeping its etag so the next save replaces it", async () => {
    blob.get.mockResolvedValueOnce({ statusCode: 200, stream: new Response("{not json").body!, headers: new Headers(), blob: { etag: '"bad"' } });
    expect(await blobWalletNamesStore(KEYLESS).read(USER)).toEqual({ names: {}, etag: '"bad"' });
  });

  it("fails a read cut off halfway, rather than reading it as no names a save would then erase", async () => {
    const cut = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"v":1,"names":{"'));
        controller.error(new TypeError("terminated"));
      },
    });
    blob.get.mockResolvedValueOnce({ statusCode: 200, stream: cut, headers: new Headers(), blob: { etag: '"e1"' } });
    await expect(blobWalletNamesStore(KEYLESS).read(USER)).rejects.toBeInstanceOf(ShareStoreError);
  });

  it("saves over the etag it read and answers the new one; a first save may only create the document", async () => {
    blob.put.mockResolvedValue({ etag: '"e2"' });
    expect(await blobWalletNamesStore(KEYLESS).write(USER, { [WALLET]: "Axiom" }, '"e1"')).toBe('"e2"');
    const [path, body, options] = blob.put.mock.calls.at(-1)!;
    expect(path).toBe(walletNamesPath(USER));
    expect(JSON.parse(body as string)).toEqual({ v: 1, names: { [WALLET]: "Axiom" } });
    expect(options).toMatchObject({ access: "private", contentType: "application/json", addRandomSuffix: false, ifMatch: '"e1"', cacheControlMaxAge: 60 });
    expect(options).not.toHaveProperty("allowOverwrite");

    await blobWalletNamesStore(KEYLESS).write(USER, {}, null);
    expect(blob.put.mock.calls.at(-1)![2]).toMatchObject({ allowOverwrite: false });
    expect(blob.put.mock.calls.at(-1)![2]).not.toHaveProperty("ifMatch");
  });

  it("turns a moved etag, or a first save that found a document, into a conflict the route re-reads on", async () => {
    blob.put.mockRejectedValueOnce(new blob.BlobPreconditionFailedError());
    await expect(blobWalletNamesStore(KEYLESS).write(USER, {}, '"old"')).rejects.toBeInstanceOf(WalletNamesConflict);
    blob.put.mockRejectedValueOnce(new blob.BlobError("This blob already exists, use `allowOverwrite: true` if you want to overwrite it."));
    await expect(blobWalletNamesStore(KEYLESS).write(USER, {}, null)).rejects.toBeInstanceOf(WalletNamesConflict);
  });

  it("says any other failure by kind, as the short links do, never with the store's words", async () => {
    blob.put.mockRejectedValueOnce(new Error("store store_abc down"));
    await expect(blobWalletNamesStore(KEYLESS).write(USER, {}, '"old"')).rejects.toMatchObject({ kind: "network" });
    blob.put.mockRejectedValueOnce(new blob.BlobError("Bad request"));
    await expect(blobWalletNamesStore(KEYLESS).write(USER, {}, null)).rejects.toMatchObject({ kind: "refused" });
    blob.get.mockRejectedValueOnce(new blob.BlobStoreSuspendedError());
    const failed = await blobWalletNamesStore(KEYLESS).read(USER).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(ShareStoreError);
    expect(failed).toMatchObject({ kind: "store_suspended" });
    expect(String((failed as Error).message)).not.toContain("store_abc");
  });

  it("never lists or deletes: the store also holds the share links", () => {
    expect(blob.list).not.toHaveBeenCalled();
    expect(blob.del).not.toHaveBeenCalled();
  });
});

describe("walletNamesPath", () => {
  it("is a hash of the login under the feature's prefix: the store's listing never shows who", () => {
    expect(walletNamesPath(USER)).toMatch(new RegExp(`^${WALLET_NAMES_PREFIX}[0-9a-f]{64}\\.json$`));
    expect(walletNamesPath(USER)).not.toContain("privy");
    expect(walletNamesPath(USER)).toBe(walletNamesPath(USER));
    expect(walletNamesPath(USER)).not.toBe(walletNamesPath(`${USER}b`));
  });
});

describe("walletNamesStoreOf: the short links' rule, since it is their store too", () => {
  it("is a store with a read-write token, or a store id with Vercel's OIDC token — on Vercel, or with the token set", async () => {
    for (const env of [{ BLOB_READ_WRITE_TOKEN: TOKEN.token }, { BLOB_STORE_ID: "store_abc", VERCEL: "1" }, { BLOB_STORE_ID: "store_abc", VERCEL_OIDC_TOKEN: "eyJ.oidc" }]) {
      expect(walletNamesStoreOf(env), JSON.stringify(env)).not.toBeNull();
    }
    // And it is reached with what the rule found: the token first, whatever else is set.
    blob.get.mockResolvedValueOnce(null);
    await walletNamesStoreOf({ BLOB_READ_WRITE_TOKEN: TOKEN.token, BLOB_STORE_ID: "store_abc", VERCEL: "1" })!.read(USER);
    expect(blob.get.mock.calls.at(-1)![1]).toMatchObject(TOKEN);
  });

  it("is none with a store id alone off Vercel — a CLI login would mint a token the store refuses — and none with nothing or blanks", () => {
    expect(walletNamesStoreOf({ BLOB_STORE_ID: "store_abc" })).toBeNull();
    expect(walletNamesStoreOf({})).toBeNull();
    expect(walletNamesStoreOf({ BLOB_STORE_ID: "  ", BLOB_READ_WRITE_TOKEN: "", VERCEL: "1" })).toBeNull();
  });
});
