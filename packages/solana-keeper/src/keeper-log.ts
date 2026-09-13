// The keeper's one way to write a line.
//
// EVERY LINE GOES THROUGH THE WORKER'S LOGGER (@sip/worker/log): JSON lines,
// scrubbed against the shared redactor that config.ts primes with every
// endpoint, credential and signing secret it reads, with a suppression marker in
// place of any line the scrub could not clean. Nuvem's supervisor wrote
// console.log(JSON.stringify(...)) directly, so the only thing between an RPC
// error that quoted its endpoint and the container log was the author's memory.

import { createLogger, sharedRedactor, type Logger, type Redactor } from "@sip/worker/log";

export const SERVICE = "sip-solana-keeper";

export type Level = "info" | "warn" | "error";

/** One integer from 0 to 255, with no leading zero. */
const BYTE = String.raw`(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)`;
/** Whitespace, a comma, or the JSON escape a newline or tab becomes inside a line. */
const SEPARATOR = String.raw`(?:[\s,]|\\[nrt])+`;

/**
 * Thirty-two or more byte values in a row: the decimal form of a seed or a
 * secret key, whether as a JSON array, a comma list, or util.inspect's padded
 * columns after JSON escaped their newlines.
 *
 * A SECOND NET UNDER THE REDACTOR, not a replacement for it. The redactor only
 * knows the forms of keys config.ts registered, and its tripwire only
 * reassembles hex. A key it never saw — printed as numbers by a library, or a
 * `number[]` copy of a local signer — matches neither, and nothing this keeper
 * writes legitimately carries 32 small integers in a row, so the whole line is
 * dropped for a marker.
 */
export const BYTE_RUN = new RegExp(String.raw`(?<![\d.])${BYTE}(?:${SEPARATOR}${BYTE}){31,}(?![\d.])`);

function withoutByteRuns(sink: (line: string) => void): (line: string) => void {
  return (line) => {
    if (!BYTE_RUN.test(line)) {
      sink(line);
      return;
    }
    let suppressedEvent: unknown;
    try {
      suppressedEvent = (JSON.parse(line) as { event?: unknown }).event;
    } catch {
      suppressedEvent = undefined;
    }
    // The worker's own suppression shape, so one search finds both kinds.
    sink(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        event: "log.suppressed",
        reason: "a run of byte values, the form a key's bytes print in",
        service: SERVICE,
        ...(typeof suppressedEvent === "string" ? { suppressedEvent } : {}),
      }),
    );
  };
}

export function createKeeperLogger(options: { readonly sink?: (line: string) => void; readonly redactor?: Redactor } = {}): Logger {
  const sink = options.sink ?? ((line: string): void => void process.stdout.write(`${line}\n`));
  return createLogger({
    json: true,
    base: { service: SERVICE },
    redactor: options.redactor ?? sharedRedactor,
    sink: withoutByteRuns(sink),
  });
}

const bigintSafe = (_key: string, value: unknown): unknown => (typeof value === "bigint" ? value.toString() : value);

export interface ChangeLog {
  /** Emits only when this key's content differs from the last line emitted for it. */
  change(key: string, event: string, fields?: Record<string, unknown>, level?: Level): void;
  /** Forgets a key, so its next line is emitted even if identical. */
  forget(key: string): void;
}

/**
 * Per-key dedupe for the sweep's per-wallet lines. Ported from Nuvem's
 * supervisor (logChange), unchanged in meaning.
 *
 * A keeper that repeats "no signer for 4T52…" every 60 seconds forever teaches
 * the operator to stop reading its logs — the one habit an operator of a keeper
 * cannot afford. A line is emitted when its CONTENT changes for its key
 * (including changing BACK), so state transitions always surface and steady
 * state is silent. Restarts clear it: after a deploy the first sweep narrates
 * everything once.
 */
export function createChangeLog(log: Logger): ChangeLog {
  const lastLine = new Map<string, string>();
  return {
    change(key, event, fields = {}, level = "info") {
      const line = `${event}|${JSON.stringify(fields, bigintSafe)}`;
      if (lastLine.get(key) === line) return;
      lastLine.set(key, line);
      log[level](event, fields);
    },
    forget(key) {
      lastLine.delete(key);
    },
  };
}
