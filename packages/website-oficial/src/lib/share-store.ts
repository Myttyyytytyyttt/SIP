/**
 * WHERE A SHORT LINK IS KEPT, AND HOW A PAGE OPENS ONE (owner, 10-23:
 * "Cortos con Vercel Blob"; the format is lib/share-code.ts). /api/share keeps
 * a card's record here before it answers (shortLinksOf), and /c/<code> and its
 * picture read it back (openSharedCard), in a PRIVATE Vercel Blob store: no
 * record has a public address, and only this server's credentials read one.
 *
 * ON ONLY WITH A STORE. Connecting a Blob store to the project in Vercel's
 * dashboard gives the deployment BLOB_READ_WRITE_TOKEN, or BLOB_STORE_ID for
 * Vercel's OIDC token (shareStoreAuthOf). Neither, and every link is the long
 * one, exactly as before — said once in the log, naming the variables and
 * never a value. The SDK is loaded only once a store is there.
 *
 * NEVER BREAKS A SHARE. The record is written as /api/share's last step, held
 * to SHARE_STORE_WRITE_MS; a store that is missing, slow, refusing, over its
 * quota or past this instance's budget, and the dialog gets the long link,
 * which needs no store at all and works for as long as the secret does. A
 * short link is only ever handed out once its record is in the store.
 *
 * WHAT IT COSTS, BOUNDED (Vercel Blob on Hobby: 2,000 writes and 10,000
 * uncached reads a month, and Blob blocked for 30 days past either):
 *   writes  one per distinct card — new figures, a new day — and none for a card
 *           this instance has written already; at most SHARE_STORE_WRITES_PER_DAY
 *           per instance. A card exists only for a vault on chain, so nobody can
 *           invent new ones by asking.
 *   reads   one per card per instance, and kept for the instance's life: a code
 *           is the same card forever. A record is stored with a year's cache, so
 *           Blob's own CDN answers a read again without an operation. A code this
 *           server never made is refused before any read (share-code.ts), and at
 *           most SHARE_STORE_READS_PER_MIN reads per minute per instance reach
 *           the store.
 *   pages   /c/<code> and its picture are cached at Vercel's CDN for a year
 *           (next.config.mjs, components/share-og.tsx): a code never changes.
 *
 * A LOG LINE SAYS WHAT FAILED, NOT WITH WHAT: the kind of failure only, at most
 * once a minute per kind — never a token, a code, a path, or the store's
 * credentials.
 */
import "server-only";

import type { Env } from "@/lib/config";
import type { ShareLinks } from "@/lib/live-share";
import {
  mayBeShareCode,
  openShareRecord,
  readShareRecord,
  shareCardIdOf,
  shareCodeOf,
  shareRecordOf,
  shareRecordPath,
  shortShareLinks,
  type ShareRecord,
} from "@/lib/share-code";
import { openShareToken, shareKeysOf, type cardOfPayload } from "@/lib/share-token";

export const BLOB_TOKEN_ENV = "BLOB_READ_WRITE_TOKEN";
export const BLOB_STORE_ID_ENV = "BLOB_STORE_ID";
export const BLOB_OIDC_TOKEN_ENV = "VERCEL_OIDC_TOKEN";

/** The longest /api/share waits for the store before it answers with the long link: Post on X waits 4 s for the whole answer (share-link-client.ts). */
export const SHARE_STORE_WRITE_MS = 1_500;
/** The longest a page or a picture waits for a record. */
export const SHARE_STORE_READ_MS = 3_000;
/** Records written per instance per day, at most. */
export const SHARE_STORE_WRITES_PER_DAY = 100;
/** Records read from the store per instance per minute, at most (a read kept in memory is not one). */
export const SHARE_STORE_READS_PER_MIN = 120;
/** How long a code found missing is believed. */
export const SHARE_STORE_MISS_MS = 5 * 60_000;
/** How long Blob's CDN may keep a record: it never changes. */
export const SHARE_RECORD_MAX_AGE_S = 31_536_000;

const RECORD_MAX_BYTES = 8_192;
const MAX_KEPT = 5_000;
const MINUTE = 60_000;
const DAY = 86_400_000;

// ── the store ────────────────────────────────────────────────────────────────

/** How this server reaches the store: a static token, or a store id for Vercel's OIDC token. */
export type ShareStoreAuth = { readonly token: string } | { readonly storeId: string };

/**
 * THE STORE'S CREDENTIALS, or null when there is none. A static token first,
 * passed to every call, so the SDK never goes looking for another one. Without
 * it, BLOB_STORE_ID with an OIDC token: on Vercel (VERCEL=1) the platform hands
 * the function one; elsewhere only when VERCEL_OIDC_TOKEN is set.
 */
export function shareStoreAuthOf(env: Env = process.env): ShareStoreAuth | null {
  const token = env[BLOB_TOKEN_ENV]?.trim() ?? "";
  if (token !== "") return { token };
  const storeId = env[BLOB_STORE_ID_ENV]?.trim() ?? "";
  const oidc = env.VERCEL === "1" || (env[BLOB_OIDC_TOKEN_ENV]?.trim() ?? "") !== "";
  return storeId !== "" && oidc ? { storeId } : null;
}

/** A failure of the store, by kind — what the log says, and all it says. */
export class ShareStoreError extends Error {
  constructor(readonly kind: string) {
    super(kind);
    this.name = "ShareStoreError";
  }
}

/** What the routes need of a store; a fake one in tests. */
export interface ShareStore {
  /** Writes `body` at `path` if nothing is there. Throws otherwise, whatever the reason — something already there included. */
  create(path: string, body: string, signal: AbortSignal): Promise<void>;
  /** What `path` holds, or null when nothing is there. Throws when the store cannot answer. */
  read(path: string, signal: AbortSignal): Promise<string | null>;
}

type BlobSdk = typeof import("@vercel/blob");

/** The SDK's error, as a kind — matched by class, since a minified bundle renames them. */
function kindOf(sdk: BlobSdk, error: unknown): string {
  const kinds: readonly (readonly [unknown, string])[] = [
    [sdk.BlobStoreSuspendedError, "store_suspended"],
    [sdk.BlobAccessError, "forbidden"],
    [sdk.BlobStoreNotFoundError, "store_not_found"],
    [sdk.BlobServiceRateLimited, "rate_limited"],
    [sdk.BlobServiceNotAvailable, "service_unavailable"],
    [sdk.BlobRequestAbortedError, "aborted"],
    [sdk.BlobUnknownError, "unknown_error"],
    [sdk.BlobError, "refused"],
  ];
  for (const [kind, name] of kinds) if (typeof kind === "function" && error instanceof kind) return name;
  return "network";
}

async function textOf(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > RECORD_MAX_BYTES) {
      void reader.cancel().catch(() => undefined);
      throw new ShareStoreError("record_too_large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * THE PRIVATE BLOB STORE: put with no overwrite and no random suffix, so a
 * path is written once and keeps its name; get through Blob's CDN, which may
 * keep a record a year since it never changes. The SDK's own retries are
 * bounded by the caller's deadline (within).
 */
export function blobShareStore(auth: ShareStoreAuth): ShareStore {
  const sdk = (): Promise<BlobSdk> => import("@vercel/blob");
  return {
    async create(path, body, signal) {
      const blob = await sdk();
      try {
        await blob.put(path, body, {
          access: "private",
          addRandomSuffix: false,
          allowOverwrite: false,
          contentType: "application/json",
          cacheControlMaxAge: SHARE_RECORD_MAX_AGE_S,
          abortSignal: signal,
          ...auth,
        });
      } catch (error) {
        throw new ShareStoreError(kindOf(blob, error));
      }
    },
    async read(path, signal) {
      const blob = await sdk();
      try {
        const found = await blob.get(path, { access: "private", abortSignal: signal, ...auth });
        if (found === null) return null;
        if (found.statusCode !== 200) throw new ShareStoreError(`status_${found.statusCode}`);
        return await textOf(found.stream);
      } catch (error) {
        throw error instanceof ShareStoreError ? error : new ShareStoreError(kindOf(blob, error));
      }
    },
  };
}

/** The store this deployment has, or null. */
export const shareStoreOf = (env: Env = process.env): ShareStore | null => {
  const auth = shareStoreAuthOf(env);
  return auth === null ? null : blobShareStore(auth);
};

/** `run`, given at most `ms`: then its signal aborts and this rejects, whatever the SDK is still waiting on. */
async function within<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ShareStoreError("timeout"));
    }, ms);
  });
  try {
    return await Promise.race([run(controller.signal), late]);
  } finally {
    clearTimeout(timer);
  }
}

// ── per instance: what is written, what is read, the budgets, the log ───────

interface Window {
  start: number;
  used: number;
}
interface Opened {
  readonly at: number;
  readonly record: Promise<ShareRecord | null>;
  /** Once read: whether nothing was there. */
  missing?: boolean;
}
interface StoreState {
  /** A card's id → the record this instance knows is in the store under it. */
  readonly written: Map<string, string>;
  /** A card's id → its record as read (null: not there), or being read. */
  readonly opened: Map<string, Opened>;
  readonly writes: Window;
  readonly reads: Window;
  /** A log line's kind → when it was last said. */
  readonly said: Map<string, number>;
}

const STATE = Symbol.for("sip.web.share.store");

/** Held on globalThis like the share route's own state, so every bundle in this process shares one. */
function stateOf(): StoreState {
  const holder = globalThis as unknown as Record<symbol, StoreState | undefined>;
  return (holder[STATE] ??= { written: new Map(), opened: new Map(), writes: { start: 0, used: 0 }, reads: { start: 0, used: 0 }, said: new Map() });
}

/** For tests: forget everything this instance kept. */
export function forgetShareStore(): void {
  delete (globalThis as unknown as Record<symbol, unknown>)[STATE];
}

/** One more of `limit` in a window of `span` ms: false once they are spent. */
function spend(window: Window, limit: number, span: number, now: number): boolean {
  if (now - window.start >= span) {
    window.start = now;
    window.used = 0;
  }
  if (window.used >= limit) return false;
  window.used += 1;
  return true;
}

function keep<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  if (map.size >= MAX_KEPT) map.delete(map.keys().next().value as K);
  map.set(key, value);
}

/** A line in the log, at most once a minute per kind ("off": once per process). Names, never values. */
function say(kind: string, now: number): void {
  const state = stateOf();
  const last = state.said.get(kind);
  if (last !== undefined && (kind === "off" || now - last < MINUTE)) return;
  state.said.set(kind, now);
  if (kind === "off") {
    console.warn(
      JSON.stringify({
        event: "web.share.short_links_off",
        names: [BLOB_TOKEN_ENV, BLOB_STORE_ID_ENV],
        message: `Short share links are off: no Blob store (${BLOB_TOKEN_ENV}, or ${BLOB_STORE_ID_ENV} with Vercel's OIDC token). Post on X posts the long /c/<token> link.`,
      }),
    );
    return;
  }
  const outcome = kind.startsWith("read_") ? "the short link's page is asked to try again" : "the dialog was given the long links";
  console.warn(JSON.stringify({ event: "web.share.short_link_store", kind, message: `The share link store did not answer as expected: ${outcome}.` }));
}

const kindOfFailure = (error: unknown): string => (error instanceof ShareStoreError ? error.kind : "unexpected");

// ── /api/share: the short links ──────────────────────────────────────────────

export interface ShortLinkOptions {
  /** Default: process.env. */
  readonly env?: Env;
  /** Default: the deployment's (shareStoreOf); null: none. */
  readonly store?: ShareStore | null;
  readonly now?: () => number;
}

/**
 * The record in the store: written now, or found there already — written by
 * another instance or an earlier deployment — and then it must be exactly this
 * one. Anything else under the card's id (two cards, one id: 1 in 57 billion
 * per pair) and the card keeps its long links.
 */
async function keepRecord(store: ShareStore, path: string, body: string, signal: AbortSignal): Promise<void> {
  try {
    await store.create(path, body, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    const there = await store.read(path, signal).catch(() => null);
    if (there === body) return;
    throw there === null ? error : new ShareStoreError("conflict");
  }
}

/**
 * THE LINKS THE DIALOG IS HANDED: short, once the card's record is in the
 * store; the long ones, as signed, otherwise — never an error, never a wait
 * past SHARE_STORE_WRITE_MS.
 */
export async function shortLinksOf(links: ShareLinks, key: Buffer, options: ShortLinkOptions = {}): Promise<ShareLinks> {
  const now = (options.now ?? Date.now)();
  const store = options.store === undefined ? shareStoreOf(options.env ?? process.env) : options.store;
  if (store === null) {
    say("off", now);
    return links;
  }
  const record = shareRecordOf(links);
  if (record === null) return links;
  const id = shareCardIdOf(record, key);
  const body = JSON.stringify(record);
  const state = stateOf();
  if (state.written.get(id) !== body) {
    if (!spend(state.writes, SHARE_STORE_WRITES_PER_DAY, DAY, now)) {
      say("write_budget", now);
      return links;
    }
    try {
      await within(SHARE_STORE_WRITE_MS, (signal) => keepRecord(store, shareRecordPath(id), body, signal));
    } catch (error) {
      say(`write_${kindOfFailure(error)}`, now);
      return links;
    }
    keep(state.written, id, body);
    // What this instance just wrote is what it would read.
    keep(state.opened, id, { at: now, record: Promise.resolve(record) });
  }
  return shortShareLinks(links, record, key);
}

// ── /c/<code> and its picture ───────────────────────────────────────────────

/** A /c/ page's card: found, not there (a 404), or not readable just now (try again). */
export type SharedCardOpen =
  | { readonly kind: "card"; readonly opened: ReturnType<typeof cardOfPayload> }
  | { readonly kind: "missing" }
  | { readonly kind: "unavailable" };

const MISSING: SharedCardOpen = { kind: "missing" };

/**
 * The record of card `id`: kept, being read, or read now, within the read
 * budget. A record found is kept for good — a code is the same card forever —
 * one found missing for SHARE_STORE_MISS_MS, and a read in flight is shared by
 * whoever asks meanwhile (a page's metadata and its body ask at once). Throws
 * when the store cannot answer; that is not kept.
 */
function recordOf(id: string, store: ShareStore, now: number): Promise<ShareRecord | null> {
  const state = stateOf();
  const kept = state.opened.get(id);
  if (kept !== undefined && !(kept.missing === true && now - kept.at >= SHARE_STORE_MISS_MS)) return kept.record;
  if (!spend(state.reads, SHARE_STORE_READS_PER_MIN, MINUTE, now)) {
    say("read_budget", now);
    return Promise.reject(new ShareStoreError("read_budget"));
  }
  const record = within(SHARE_STORE_READ_MS, (signal) => store.read(shareRecordPath(id), signal)).then((text) => (text === null ? null : readShareRecord(text)));
  const entry: Opened = { at: now, record };
  keep(state.opened, id, entry);
  record.then(
    (found) => {
      entry.missing = found === null;
    },
    (error: unknown) => {
      if (state.opened.get(id) === entry) state.opened.delete(id);
      say(`read_${kindOfFailure(error)}`, now);
    },
  );
  return record;
}

export interface OpenOptions {
  /** Default: process.env. */
  readonly env?: Env;
  /** Default: the deployment's (shareStoreOf); null: none. */
  readonly store?: ShareStore | null;
  readonly now?: () => number;
}

/**
 * THE CARD A /c/ ADDRESS NAMES: a long token, verified as it always was, with
 * no store; or a short code — its tag first, then its record, then the token
 * in it (share-code.ts). Missing is a 404; unavailable — the store did not
 * answer, or this instance's reads are spent — is a "try again", never cached.
 */
export async function openSharedCard(param: string, options: OpenOptions = {}): Promise<SharedCardOpen> {
  const env = options.env ?? process.env;
  const code = shareCodeOf(param);
  if (code === null) {
    const opened = openShareToken(param, env);
    return opened === null ? MISSING : { kind: "card", opened };
  }
  const keys = shareKeysOf(env);
  if (keys === null || !mayBeShareCode(code, keys.verify)) return MISSING;
  const store = options.store === undefined ? shareStoreOf(env) : options.store;
  if (store === null) return MISSING;
  let record: ShareRecord | null;
  try {
    record = await recordOf(code.id, store, (options.now ?? Date.now)());
  } catch {
    return { kind: "unavailable" };
  }
  const opened = record === null ? null : openShareRecord(code, record, keys.verify);
  return opened === null ? MISSING : { kind: "card", opened };
}
