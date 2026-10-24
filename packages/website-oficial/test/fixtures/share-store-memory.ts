// IN-MEMORY STAND-INS FOR THE SHORT LINKS' STORE (src/lib/share-store.ts), so
// no test reaches Vercel Blob: one at the store's own interface, and one at the
// SDK's — put and get, the only two calls the store makes — for tests that go
// through the real adapter (vi.mock("@vercel/blob")). Both count every call and
// can be told to fail or to hang.

import type { ShareStore } from "@/lib/share-store";

/** Waits `ms`, or rejects as soon as `signal` aborts. */
function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((done, fail) => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      fail(new Error("aborted"));
    });
  });
}

export interface MemoryStore extends ShareStore {
  /** path → what is stored there. */
  readonly records: Map<string, string>;
  /** Paths written. */
  readonly created: string[];
  /** Paths a write was refused at, because something was there. */
  readonly refused: string[];
  /** Paths read. */
  readonly reads: string[];
  /** Thrown by every call while set. */
  failure: Error | null;
  /** Every call waits this long first. */
  delayMs: number;
}

export function memoryStore(): MemoryStore {
  const store: MemoryStore = {
    records: new Map(),
    created: [],
    refused: [],
    reads: [],
    failure: null,
    delayMs: 0,
    async create(path, body, signal) {
      await delay(store.delayMs, signal);
      if (store.failure !== null) throw store.failure;
      if (store.records.has(path)) {
        store.refused.push(path);
        throw new Error("This blob already exists");
      }
      store.records.set(path, body);
      store.created.push(path);
    },
    async read(path, signal) {
      await delay(store.delayMs, signal);
      if (store.failure !== null) throw store.failure;
      store.reads.push(path);
      return store.records.get(path) ?? null;
    },
  };
  return store;
}

interface SdkCall {
  readonly op: "put" | "get";
  readonly path: string;
  readonly options: Readonly<Record<string, unknown>>;
}

/** @vercel/blob's put and get over a Map: what the real adapter calls, recorded. */
export function blobSdkMemory() {
  const sdk = {
    records: new Map<string, string>(),
    calls: [] as SdkCall[],
    /** Makes the error every call throws while set. */
    failure: null as (() => unknown) | null,
    async put(path: string, body: unknown, options: Record<string, unknown>) {
      sdk.calls.push({ op: "put", path, options });
      if (sdk.failure !== null) throw sdk.failure();
      if (sdk.records.has(path) && options.allowOverwrite !== true) throw new Error("Vercel Blob: This blob already exists, use `allowOverwrite: true` if you want to overwrite it.");
      sdk.records.set(path, String(body));
      return { pathname: path, url: `https://store.private.blob.vercel-storage.com/${path}`, downloadUrl: "", contentType: "application/json", contentDisposition: "", etag: "x" };
    },
    async get(path: string, options: Record<string, unknown>) {
      sdk.calls.push({ op: "get", path, options });
      if (sdk.failure !== null) throw sdk.failure();
      const text = sdk.records.get(path);
      if (text === undefined) return null;
      return { statusCode: 200 as const, stream: new Response(text).body!, headers: new Headers(), blob: { pathname: path, contentType: "application/json", size: text.length } };
    },
    reset() {
      sdk.records.clear();
      sdk.calls.length = 0;
      sdk.failure = null;
    },
  };
  return sdk;
}
