// Library console output, routed through the keeper's redacting logger.
//
// IMPORTED FIRST by every binary, before any library, because some libraries
// print while they load: bigint-buffer (under @solana/spl-token) warns about its
// missing native bindings at require time, and web3.js later writes websocket
// errors with console.error, quoting a URL derived from an endpoint that carries
// a provider key. Routed here, each one is a JSON line scrubbed like every other.
//
// TO STDERR, so a binary's own output on stdout — --preflight's single JSON
// line, ready's checklist — stays exactly what it says it is.
//
// BYTES ARE REFUSED BEFORE format() SEES THEM. The logger turns a Buffer or a
// Uint8Array into `<binary:N bytes>`, but only while it is still bytes. format()
// runs util.inspect first, which prints a Uint8Array as column-padded decimals
// over several lines, so the bridge used to hand the logger a finished string
// in which console.log(keypair) was the key's 64 bytes as a decimal list: a form
// none of config.ts's registered needles match and the tripwire's hex pass
// cannot reassemble. The arguments are walked with the logger's own byte rule
// first, and keeper-log.ts drops any line still holding a run of byte values.

import { format } from "node:util";
import { createKeeperLogger } from "./keeper-log.js";

/** Deeper than any library's console argument has a reason to be. */
const MAX_DEPTH = 6;
const INSPECT = Symbol.for("nodejs.util.inspect.custom");

const binary = (bytes: number): string => `<binary:${bytes} bytes>`;

/**
 * A console argument that util.format can print without printing a key:
 * every ArrayBuffer and typed array, at any depth, becomes its length.
 *
 * - Primitives pass through: a string is scrubbed by the logger afterwards.
 * - An object with its own util.inspect hook passes through: Secret, SettleKey
 *   and the frozen config already print only what is safe.
 * - An object with a toJSON is printed as that toJSON, the logger's rule.
 * - An Error is copied with its message and stack and its own properties
 *   walked, so an error that carries a signer is not a way around the walk.
 * - Any other object becomes a plain object of its own enumerable entries, each
 *   walked. A web3.js Keypair prints `{ _keypair: { publicKey: '<binary:32
 *   bytes>', secretKey: '<binary:64 bytes>' } }`.
 */
export function sanitizeConsoleArg(value: unknown, depth = 0, ancestors: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;
  if (value instanceof ArrayBuffer) return binary(value.byteLength);
  if (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer) return binary(value.byteLength);
  if (ArrayBuffer.isView(value)) return binary(value.byteLength);
  if (typeof value === "function") return value;
  if (depth > MAX_DEPTH) return "<depth limit>";
  if (ancestors.has(value)) return "<circular>";
  if (typeof (value as { [INSPECT]?: unknown })[INSPECT] === "function") return value;
  if (value instanceof Date || value instanceof RegExp) return value;

  ancestors.add(value);
  try {
    const walk = (inner: unknown): unknown => sanitizeConsoleArg(inner, depth + 1, ancestors);
    if (value instanceof Error) {
      const copy = new Error(value.message);
      for (const [key, inner] of [
        ["name", value.name],
        ["stack", value.stack],
      ] as const) {
        Object.defineProperty(copy, key, { value: inner, enumerable: false, writable: true, configurable: true });
      }
      for (const [key, inner] of Object.entries(value)) (copy as unknown as Record<string, unknown>)[key] = walk(inner);
      if ("cause" in value) {
        Object.defineProperty(copy, "cause", { value: walk(value.cause), enumerable: false, writable: true, configurable: true });
      }
      const errors = (value as { errors?: unknown }).errors;
      if (Array.isArray(errors)) {
        Object.defineProperty(copy, "errors", { value: errors.map(walk), enumerable: false, writable: true, configurable: true });
      }
      return copy;
    }
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === "function") {
      const json: unknown = toJSON.call(value);
      return json === value ? "<unserializable>" : walk(json);
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value instanceof Map) return new Map([...value].map(([key, inner]) => [walk(key), walk(inner)]));
    if (value instanceof Set) return new Set([...value].map(walk));
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) out[key] = walk(inner);
    return out;
  } finally {
    ancestors.delete(value);
  }
}

const consoleLog = createKeeperLogger({ sink: (line) => process.stderr.write(`${line}\n`) });
const levels = { log: "info", info: "info", debug: "info", warn: "warn", error: "error" } as const;
for (const [method, level] of Object.entries(levels) as [keyof typeof levels, "info" | "warn" | "error"][]) {
  console[method] = (...args: unknown[]): void =>
    consoleLog[level]("console", { text: format(...args.map((arg) => sanitizeConsoleArg(arg))) });
}
