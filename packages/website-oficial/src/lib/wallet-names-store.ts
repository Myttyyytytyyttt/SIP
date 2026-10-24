/**
 * WHERE AN ACCOUNT'S WALLET NAMES ARE KEPT: one private JSON document per
 * Privy login in the Vercel Blob store the owner connected to the project
 * (owner, 10-23: "saverfi-share-links", private) — the same store, reached the
 * same way, as the short share links (lib/share-store.ts).
 *
 * THE SHORT LINKS' RULE FOR "IS THERE A STORE" (10-23, converged on
 * share-store.ts so the two never disagree): shareStoreAuthOf decides, and its
 * answer is passed to every call, so the SDK never goes looking for a
 * credential of its own. BLOB_READ_WRITE_TOKEN when set; otherwise
 * BLOB_STORE_ID with Vercel's OIDC token — on Vercel (VERCEL=1), where each
 * request carries one (the x-vercel-oidc-token header, read by @vercel/oidc
 * from the request context), or wherever VERCEL_OIDC_TOKEN is set. So the
 * store is called only INSIDE a request handler, while its request is in
 * flight — never at module load, never after the response.
 *
 * NOT CONFIGURED IS OFF. No store by that rule — local dev, tests, a fork's
 * deployment — and the route answers 503 names_off before any call, and the
 * browser shows the default names with no pencil. A BLOB_STORE_ID alone, off
 * Vercel, is no store: the SDK would otherwise mint a development OIDC token
 * from a CLI login, which this store (connected to Production and Preview
 * only) refuses, and a failed refresh logs the CLI out. (So do not `vercel
 * link` this package to "fix" that locally: SIP_WEB_BLOB_STUB=1 with any
 * BLOB_READ_WRITE_TOKEN is the local store, next.config.mjs.) The SDK itself is
 * loaded only once there is a store.
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
 * change over the other's, once. A read cut off halfway is a failed read,
 * never "no names": a save over it would erase every other name.
 *
 * A FAILURE IS SAID BY KIND (share-store.ts's ShareStoreError and kindOf):
 * the SDK's classes are renamed in a minified bundle, and its messages can
 * carry the store's id.
 */
import "server-only";

import { createHash } from "node:crypto";

import type { Env } from "@/lib/config";
import { ShareStoreError, kindOf, shareStoreAuthOf, type ShareStoreAuth } from "@/lib/share-store";
import { namesFrom } from "@/lib/wallet-names";

/** Every key this feature reads or writes starts here, and nothing else in the store is touched. */
export const WALLET_NAMES_PREFIX = "wallet-names/";

/** How long one store call may take before the request gives up on it. The SDK retries 5xx for minutes otherwise. */
export const WALLET_NAMES_STORE_TIMEOUT_MS = 6_000;

/** The document's path for one Privy user: a hash, so the store's listing never shows who. */
export function walletNamesPath(userId: string): string {
  return `${WALLET_NAMES_PREFIX}${createHash("sha256").update(userId, "utf8").digest("hex")}.json`;
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
  /** Throws a ShareStoreError when the store cannot answer. */
  read(userId: string): Promise<StoredNames>;
  /**
   * Saves `names` over the document read at `etag` (null: there was none), and answers the saved
   * document's etag. Throws WalletNamesConflict when it moved since — or, for a first save, when
   * another device's first save made it in between — and a ShareStoreError when the store cannot answer.
   */
  write(userId: string, names: Readonly<Record<string, string>>, etag: string | null): Promise<string>;
}

/** The document as stored. `v` lets a later shape be told apart from this one. */
interface NamesDocument {
  readonly v: 1;
  readonly names: Readonly<Record<string, string>>;
}

type BlobSdk = typeof import("@vercel/blob");

/**
 * The SDK, loaded at the first call as share-store.ts loads it, so a deployment
 * with no store never loads it. A one-line import() of this file's own: the
 * short links' is a closure inside blobShareStore, not a helper to share.
 */
const sdkOf = (): Promise<BlobSdk> => import("@vercel/blob");

/** Whether `error` is of the SDK's class `name`. Guarded: a stand-in SDK (the dev stub, a test's) may lack a class. */
function isA(sdk: BlobSdk, name: "BlobError" | "BlobPreconditionFailedError", error: unknown): error is Error {
  const kind: unknown = sdk[name];
  return typeof kind === "function" && error instanceof kind;
}

/** The private Blob store, reached with `auth` (shareStoreAuthOf) on every call. */
export function blobWalletNamesStore(auth: ShareStoreAuth): WalletNamesStore {
  return {
    async read(userId) {
      const blob = await sdkOf();
      let text: string;
      let etag: string;
      try {
        const found = await blob.get(walletNamesPath(userId), {
          access: "private",
          useCache: false,
          abortSignal: AbortSignal.timeout(WALLET_NAMES_STORE_TIMEOUT_MS),
          ...auth,
        });
        if (found === null || found.statusCode !== 200) return { names: {}, etag: null };
        // Read whole inside the deadline: a stream cut off halfway throws here, as a failed read.
        text = await new Response(found.stream).text();
        etag = found.blob.etag;
      } catch (error) {
        throw new ShareStoreError(kindOf(blob, error));
      }
      // A document that is not ours to read is no names — with its etag kept, so the next save replaces it
      // rather than every read and save failing on it for good. Only a document read whole gets here.
      let document: Partial<NamesDocument> | null = null;
      try {
        document = JSON.parse(text) as Partial<NamesDocument> | null;
      } catch {
        document = null;
      }
      return { names: namesFrom(document?.names), etag };
    },
    async write(userId, names, etag) {
      const blob = await sdkOf();
      const document: NamesDocument = { v: 1, names };
      try {
        const saved = await blob.put(walletNamesPath(userId), JSON.stringify(document), {
          access: "private",
          contentType: "application/json",
          addRandomSuffix: false,
          // The first save has no etag to match, so it may only create the document: two
          // devices making an account's first rename at once must not have one erase the other.
          ...(etag === null ? { allowOverwrite: false } : { ifMatch: etag }),
          // The shortest the store allows. Reads skip the cache anyway; this only bounds a stale edge copy.
          cacheControlMaxAge: 60,
          abortSignal: AbortSignal.timeout(WALLET_NAMES_STORE_TIMEOUT_MS),
          ...auth,
        });
        return saved.etag;
      } catch (error) {
        if (isA(blob, "BlobPreconditionFailedError", error)) throw new WalletNamesConflict();
        // The SDK has no class for "this blob already exists": only the store's words tell it
        // apart. Should the words ever differ, the lost race is a failed save the person sees
        // and repeats (the repeat reads the document), never a silent loss.
        if (etag === null && isA(blob, "BlobError", error) && /already exists/i.test(error.message)) throw new WalletNamesConflict();
        throw new ShareStoreError(kindOf(blob, error));
      }
    },
  };
}

/** The store this deployment keeps names in, or null: the short links' rule, since it is their store too. Read per request. */
export function walletNamesStoreOf(env: Env): WalletNamesStore | null {
  const auth = shareStoreAuthOf(env);
  return auth === null ? null : blobWalletNamesStore(auth);
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
