// THE DEV-ONLY BLOB STUB (test/stubs/vercel-blob.ts), AS BOTH STORES CALL IT (10-23): the local proof of the
// short links and of the wallet names runs on it with SIP_WEB_BLOB_STUB=1, so it must keep the contract the
// real store keeps for each — a record written once and never over; a names document created once, then saved
// only over the etag it was read at. The real adapters run on top of it, over a temporary folder.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@vercel/blob", () => import("../../test/stubs/vercel-blob"));

import { blobShareStore } from "@/lib/share-store";
import { WalletNamesConflict, blobWalletNamesStore, walletNamesPath } from "@/lib/wallet-names-store";

const USER = "did:privy:stubuser000000000000000000a";
const WALLET = "TradingZeroP1aceho1der11111111111111111111";
const AUTH = { token: "stub-not-a-token" } as const;

let folder = "";
beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), "sip-blob-stub-"));
  vi.stubEnv("SIP_WEB_BLOB_STUB_DIR", folder);
});
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(folder, { recursive: true, force: true });
});

describe("the dev Blob stub", () => {
  it("keeps an account's names as the store does: created once, then saved only over the etag it was read at", async () => {
    const store = blobWalletNamesStore(AUTH);
    expect(await store.read(USER)).toEqual({ names: {}, etag: null });
    const first = await store.write(USER, { [WALLET]: "Axiom" }, null);
    // A second first save — another device's — is a conflict, not an overwrite.
    await expect(store.write(USER, { [WALLET]: "Other" }, null)).rejects.toBeInstanceOf(WalletNamesConflict);
    const read = await store.read(USER);
    expect(read).toEqual({ names: { [WALLET]: "Axiom" }, etag: first });
    const second = await store.write(USER, { [WALLET]: "Main" }, read.etag);
    expect(second).not.toBe(first);
    // A save over the etag it no longer has is refused, and changes nothing.
    await expect(store.write(USER, { [WALLET]: "Stale" }, first)).rejects.toBeInstanceOf(WalletNamesConflict);
    expect(await store.read(USER)).toEqual({ names: { [WALLET]: "Main" }, etag: second });
    expect(JSON.parse(readFileSync(join(folder, walletNamesPath(USER)), "utf8"))).toEqual({ v: 1, names: { [WALLET]: "Main" } });
    expect(readFileSync(join(folder, "gets.log"), "utf8")).toContain(`${walletNamesPath(USER)} (origin)`);
  });

  it("still keeps a short link's record as before: written once, never over, read back as written", async () => {
    const store = blobShareStore(AUTH);
    const signal = new AbortController().signal;
    await store.create("c/stubrecord.json", '{"t":"one"}', signal);
    await expect(store.create("c/stubrecord.json", '{"t":"two"}', signal)).rejects.toThrow();
    expect(await store.read("c/stubrecord.json", signal)).toBe('{"t":"one"}');
    expect(await store.read("c/missing.json", signal)).toBeNull();
  });
});
