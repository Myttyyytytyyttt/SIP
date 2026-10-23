/**
 * WHERE AN ACCOUNT'S WALLET NAMES ARE KEPT: one private JSON document per
 * Privy login in the Vercel Blob store the owner connected to the project
 * (owner, 10-23: "saverfi-share-links", private).
 *
 * KEYLESS. Vercel connected the store the new way: the project carries
 * BLOB_STORE_ID and no BLOB_READ_WRITE_TOKEN, and each request authenticates
 * with the OIDC token Vercel hands that request (the x-vercel-oidc-token
 * header, read by @vercel/oidc from the request context). So the store is
 * called only INSIDE a request handler, while its request is in flight —
 * never at module load, never after the response. @vercel/blob 2.8.2 picks
 * OIDC + BLOB_STORE_ID by itself; nothing here names a credential.
 *
 * NOT CONFIGURED IS OFF. With neither BLOB_STORE_ID nor a read-write token —
 * local dev, tests, a fork's deployment — the route answers 503 names_off
 * before any call, and the browser shows the default names with no pencil.
 * (Do not `vercel link` inside this package to "fix" that locally: @vercel/oidc
 * would then mint a development token from the CLI login, which this store,
 * connected to Production and Preview only, refuses.)
 *
 * ONE DOCUMENT PER ACCOUNT, at wallet-names/<sha256 of the Privy user id>.json:
 * a read is one get(), a save one put(), and nothing is ever listed — list() is
 * the expensive operation, and nothing here needs it. The path never carries
 * the user id itself, and every path this file builds is under wallet-names/:
 * the store also holds the share links, which this file never touches.
 *
 * FRESH READS. A name is overwritten in place, and the CDN may serve the old
 * document for up to a minute after; a rename followed by a reload must show
 * the new name, so reads go to the origin (useCache: false) — which is why
 * every read is a billed operation, and why the route keeps its own copy and
 * reads here as seldom as it can (lib/wallet-names-server.ts).
 *
 * NO SAVE ERASES ANOTHER. A save carries the etag of the read it edits
 * (ifMatch); the very first, with no document to match, may only CREATE one
 * (allowOverwrite: false). Either way, a document another device saved in
 * between makes this save a conflict, and the route re-reads and applies its
 * change over the other's, once.
 */
import "server-only";

import { createHash } from "node:crypto";

import { BlobError, BlobPreconditionFailedError, get, put } from "@vercel/blob";

import type { Env } from "@/lib/config";
import { namesFrom } from "@/lib/wallet-names";

/** Every key this feature reads or writes starts here, and nothing else in the store is touched. */
export const WALLET_NAMES_PREFIX = "wallet-names/";

/** How long one store call may take before the request gives up on it. The SDK retries 5xx for minutes otherwise. */
export const WALLET_NAMES_STORE_TIMEOUT_MS = 6_000;

/** The document's path for one Privy user: a hash, so the store's listing never shows who. */
export function walletNamesPath(userId: string): string {
  return `${WALLET_NAMES_PREFIX}${createHash("sha256").update(userId, "utf8").digest("hex")}.json`;
}

/** Whether this deployment has a store to keep names in. Read per request, like every other setting. */
export function walletNamesStoreConfigured(env: Env): boolean {
  const set = (name: string): boolean => (env[name]?.trim() ?? "") !== "";
  return set("BLOB_STORE_ID") || set("BLOB_READ_WRITE_TOKEN");
}

/** One account's names as read, with the version a save must match (null: no document yet). */
export interface StoredNames {
  readonly names: Readonly<Record<string, string>>;
  readonly etag: string | null;
}

/** A save lost a race with another device's: re-read, re-apply, try once more. */
export class WalletNamesConflict extends Error {
  constructor() {
    super("The names changed since they were read.");
  }
}

export interface WalletNamesStore {
  read(userId: string): Promise<StoredNames>;
  /**
   * Saves `names` over the document read at `etag` (null: there was none), and answers the saved
   * document's etag. Throws WalletNamesConflict when it moved since — or, for a first save, when
   * another device's first save made it in between.
   */
  write(userId: string, names: Readonly<Record<string, string>>, etag: string | null): Promise<string>;
}

/** The document as stored. `v` lets a later shape be told apart from this one. */
interface NamesDocument {
  readonly v: 1;
  readonly names: Readonly<Record<string, string>>;
}

/** The Vercel Blob store, keyless on Vercel. */
export function blobWalletNamesStore(): WalletNamesStore {
  return {
    async read(userId) {
      const found = await get(walletNamesPath(userId), {
        access: "private",
        useCache: false,
        abortSignal: AbortSignal.timeout(WALLET_NAMES_STORE_TIMEOUT_MS),
      });
      if (found === null || found.statusCode !== 200) return { names: {}, etag: null };
      // A document that is not ours to read is no names — with its etag kept, so the next save replaces it
      // rather than every read and save failing on it for good.
      const document = (await new Response(found.stream).json().catch(() => null)) as Partial<NamesDocument> | null;
      return { names: namesFrom(document?.names), etag: found.blob.etag };
    },
    async write(userId, names, etag) {
      const document: NamesDocument = { v: 1, names };
      try {
        const saved = await put(walletNamesPath(userId), JSON.stringify(document), {
          access: "private",
          contentType: "application/json",
          addRandomSuffix: false,
          // The first save has no etag to match, so it may only create the document: two
          // devices making an account's first rename at once must not have one erase the other.
          ...(etag === null ? { allowOverwrite: false } : { ifMatch: etag }),
          // The shortest the store allows. Reads skip the cache anyway; this only bounds a stale edge copy.
          cacheControlMaxAge: 60,
          abortSignal: AbortSignal.timeout(WALLET_NAMES_STORE_TIMEOUT_MS),
        });
        return saved.etag;
      } catch (error) {
        if (error instanceof BlobPreconditionFailedError) throw new WalletNamesConflict();
        // The SDK has no class for "this blob already exists": only the store's words tell it
        // apart. Should the words ever differ, the lost race is a failed save the person sees
        // and repeats (the repeat reads the document), never a silent loss.
        if (etag === null && error instanceof BlobError && /already exists/i.test(error.message)) throw new WalletNamesConflict();
        throw error;
      }
    },
  };
}

/** An in-memory store, for tests: the same contract, etags and create-only first saves included. */
export function memoryWalletNamesStore(): WalletNamesStore & { readonly documents: Map<string, StoredNames> } {
  const documents = new Map<string, StoredNames>();
  let version = 0;
  return {
    documents,
    async read(userId) {
      return documents.get(walletNamesPath(userId)) ?? { names: {}, etag: null };
    },
    async write(userId, names, etag) {
      const path = walletNamesPath(userId);
      if (etag === null ? documents.has(path) : documents.get(path)?.etag !== etag) throw new WalletNamesConflict();
      version += 1;
      const saved = `"v${version}"`;
      documents.set(path, { names: { ...names }, etag: saved });
      return saved;
    },
  };
}
