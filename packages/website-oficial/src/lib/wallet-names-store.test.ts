// The Blob store as this feature calls it (owner, 10-23): keyless — no credential named anywhere — private,
// one document per login under wallet-names/, read from the origin rather than the CDN, saved over the etag it
// was read at, and never listed. @vercel/blob is replaced by a recorder: nothing reaches Vercel.

import { describe, expect, it, vi } from "vitest";

const blob = vi.hoisted(() => {
  class BlobPreconditionFailedError extends Error {}
  return {
    BlobPreconditionFailedError,
    get: vi.fn(),
    put: vi.fn(),
    list: vi.fn(),
    del: vi.fn(),
  };
});
vi.mock("@vercel/blob", () => blob);

import { WALLET_NAMES_PREFIX, WalletNamesConflict, blobWalletNamesStore, walletNamesPath, walletNamesStoreConfigured } from "@/lib/wallet-names-store";

const USER = "did:privy:cm1testuser0000000000000a";
const WALLET = "TradingZeroP1aceho1der11111111111111111111";

const stream = (value: unknown): ReadableStream<Uint8Array> => new Response(JSON.stringify(value)).body!;

describe("blobWalletNamesStore", () => {
  it("reads the login's one document from the origin, privately, and keeps its etag", async () => {
    blob.get.mockResolvedValueOnce({ statusCode: 200, stream: stream({ v: 1, names: { [WALLET]: "Axiom", junk: "x" } }), headers: new Headers(), blob: { etag: '"e1"' } });
    expect(await blobWalletNamesStore().read(USER)).toEqual({ names: { [WALLET]: "Axiom" }, etag: '"e1"' });
    const [path, options] = blob.get.mock.calls.at(-1)!;
    expect(path).toBe(walletNamesPath(USER));
    expect(options).toMatchObject({ access: "private", useCache: false });
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
    // No credential is passed: on Vercel the SDK takes the request's OIDC token and BLOB_STORE_ID itself.
    expect(options).not.toHaveProperty("token");
  });

  it("reads no document as no names, with no etag", async () => {
    blob.get.mockResolvedValueOnce(null);
    expect(await blobWalletNamesStore().read(USER)).toEqual({ names: {}, etag: null });
  });

  it("reads a document it cannot parse as no names, keeping its etag so the next save replaces it", async () => {
    blob.get.mockResolvedValueOnce({ statusCode: 200, stream: new Response("{not json").body!, headers: new Headers(), blob: { etag: '"bad"' } });
    expect(await blobWalletNamesStore().read(USER)).toEqual({ names: {}, etag: '"bad"' });
  });

  it("saves over the etag it read, and a first save with nothing to match", async () => {
    blob.put.mockResolvedValue({});
    await blobWalletNamesStore().write(USER, { [WALLET]: "Axiom" }, '"e1"');
    const [path, body, options] = blob.put.mock.calls.at(-1)!;
    expect(path).toBe(walletNamesPath(USER));
    expect(JSON.parse(body as string)).toEqual({ v: 1, names: { [WALLET]: "Axiom" } });
    expect(options).toMatchObject({ access: "private", contentType: "application/json", addRandomSuffix: false, ifMatch: '"e1"', cacheControlMaxAge: 60 });
    expect(options).not.toHaveProperty("allowOverwrite");

    await blobWalletNamesStore().write(USER, {}, null);
    expect(blob.put.mock.calls.at(-1)![2]).toMatchObject({ allowOverwrite: true });
    expect(blob.put.mock.calls.at(-1)![2]).not.toHaveProperty("ifMatch");
  });

  it("turns a moved etag into a conflict the route re-reads on, and passes any other failure on", async () => {
    blob.put.mockRejectedValueOnce(new blob.BlobPreconditionFailedError());
    await expect(blobWalletNamesStore().write(USER, {}, '"old"')).rejects.toBeInstanceOf(WalletNamesConflict);
    blob.put.mockRejectedValueOnce(new Error("store down"));
    await expect(blobWalletNamesStore().write(USER, {}, '"old"')).rejects.toThrow("store down");
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

describe("walletNamesStoreConfigured", () => {
  it("is on with BLOB_STORE_ID (keyless) or a read-write token, and off with neither or blanks", () => {
    expect(walletNamesStoreConfigured({ BLOB_STORE_ID: "store_abc" })).toBe(true);
    expect(walletNamesStoreConfigured({ BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_abc" })).toBe(true);
    expect(walletNamesStoreConfigured({})).toBe(false);
    expect(walletNamesStoreConfigured({ BLOB_STORE_ID: "  ", BLOB_READ_WRITE_TOKEN: "" })).toBe(false);
  });
});
