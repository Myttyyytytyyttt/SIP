// A DEV-ONLY STAND-IN FOR @vercel/blob, for the short share links' proof.
//
// The short links' store (src/lib/share-store.ts) is a private Vercel Blob
// store, which exists only in production, and no proof may call the real one.
// So with SIP_WEB_BLOB_STUB=1 in development, next.config.mjs aliases the SDK
// to this file: put and get — the only two calls the store makes — over a
// folder, SIP_WEB_BLOB_STUB_DIR, one file per record. What the proof needs to
// see and to break is a file away:
//   <dir>/c/<id>.json   a record, as put wrote it (edit it to tamper with one)
//   <dir>/puts.log      one line per put that wrote, one per put refused
//   <dir>/gets.log      one line per get
//   <dir>/fail          when present, every call throws the error its text
//                       names: "suspended" (over the quota), "network", "slow"
//                       (answers after 10 s)
//
// IT MUST NEVER REACH PRODUCTION: the alias is gated on NODE_ENV and on the
// flag, and this module throws on import in a production build.
// scripts/next-config.test.ts pins all of it.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

if (process.env.NODE_ENV === "production") {
  throw new Error("test/stubs/vercel-blob.ts was imported in a production build. It is a proof stub and must never ship.");
}

export class BlobError extends Error {
  constructor(message: string) {
    super(`Vercel Blob: ${message}`);
  }
}
export class BlobStoreSuspendedError extends BlobError {
  constructor() {
    super("This store has been suspended.");
  }
}
export class BlobAccessError extends BlobError {
  constructor() {
    super("Access denied, please provide a valid token for this resource.");
  }
}
export class BlobStoreNotFoundError extends BlobError {
  constructor() {
    super("This store does not exist.");
  }
}
export class BlobServiceRateLimited extends BlobError {}
export class BlobServiceNotAvailable extends BlobError {}
export class BlobRequestAbortedError extends BlobError {}
export class BlobUnknownError extends BlobError {}

const dir = (): string => {
  const at = process.env.SIP_WEB_BLOB_STUB_DIR ?? "";
  if (at === "") throw new BlobStoreNotFoundError();
  return resolve(at);
};

const log = (name: string, line: string): void => appendFileSync(join(dir(), name), `${new Date().toISOString()} ${line}\n`);

/** The failure the proof asked for, if any. */
async function failure(signal: AbortSignal | undefined): Promise<void> {
  const marker = join(dir(), "fail");
  if (!existsSync(marker)) return;
  const kind = readFileSync(marker, "utf8").trim();
  if (kind === "suspended") throw new BlobStoreSuspendedError();
  if (kind === "slow") {
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(done, 10_000);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        fail(new BlobRequestAbortedError("The request was aborted."));
      });
    });
    return;
  }
  throw new TypeError("fetch failed");
}

/** Only what the store asks for: a private, named, never-overwritten JSON record. */
interface PutOptions {
  readonly access: string;
  readonly addRandomSuffix?: boolean;
  readonly allowOverwrite?: boolean;
  readonly contentType?: string;
  readonly cacheControlMaxAge?: number;
  readonly abortSignal?: AbortSignal;
  readonly token?: string;
  readonly storeId?: string;
}

export async function put(pathname: string, body: string, options: PutOptions): Promise<{ pathname: string; url: string }> {
  if (options.access !== "private" || options.addRandomSuffix !== false || options.allowOverwrite !== false) throw new BlobError("the stub takes only private, named, never-overwritten records");
  await failure(options.abortSignal);
  const file = join(dir(), pathname);
  mkdirSync(dirname(file), { recursive: true });
  try {
    writeFileSync(file, body, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    log("puts.log", `refused ${pathname} (exists)`);
    throw new BlobError("This blob already exists, use `allowOverwrite: true` if you want to overwrite it. Or `addRandomSuffix: true` to generate a unique filename.");
  }
  log("puts.log", `wrote ${pathname} ${Buffer.byteLength(body)} bytes cache=${options.cacheControlMaxAge} type=${options.contentType}`);
  return { pathname, url: `https://stub.private.blob.vercel-storage.com/${pathname}` };
}

export async function get(pathname: string, options: { readonly access: string; readonly abortSignal?: AbortSignal }) {
  if (options.access !== "private") throw new BlobError("the stub reads only private records");
  await failure(options.abortSignal);
  log("gets.log", pathname);
  const file = join(dir(), pathname);
  if (!existsSync(file)) return null;
  const bytes = readFileSync(file);
  return {
    statusCode: 200 as const,
    stream: new Response(bytes).body!,
    headers: new Headers({ "content-type": "application/json" }),
    blob: { pathname, contentType: "application/json", size: bytes.length },
  };
}
