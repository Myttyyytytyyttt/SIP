// Structured logging that cannot print a secret.
//
// Ported from the keeper of the project this was forked from (src/log.ts (Secret, Redactor, the three)
// overlapping mechanisms, normalizeValue, stripUpstreamMetadata and
// summarizeUpstreamError). Two things are new and both come from DESIGN.md
// §0.6: the Redactor also masks ANY 64-hex run by shape, and a module-level
// `sharedRedactor` is the logger's default so config.ts can prime it without a
// redactor field on the frozen WorkerConfig.
//
// This module exists because of one specific, very cheap accident: viem
// annotates every transport error with the endpoint it called ("URL: https://…"
// plus "Request body: …"). Our endpoint carries an Alchemy API key. A routine
// 429 on a busy trading day would therefore publish that key into container
// logs, which are shipped, rotated, and pasted into bug reports. The attester
// private key is worse: it appears in nothing today, but one `console.log(config)`
// away from appearing forever.
//
// So secrets are protected by THREE independent mechanisms, deliberately
// overlapping, because any one of them can quietly stop working:
//
//   1. `Secret` never yields its value to a serializer, and config.ts gives the
//      WorkerConfig object a toJSON/inspect hook that returns only its safe
//      description. `JSON.stringify(config)` is therefore safe by construction,
//      not by discipline.
//   2. `Redactor.scrub` substitutes every registered secret out of the FULLY
//      SERIALIZED line and then masks every remaining 64-hex run, so nested
//      error messages, `error.stack`, viem's metaMessages and anything an author
//      forgot about are all covered. It runs last, on a string, where there is
//      nowhere left to hide.
//   3. A post-substitution assertion. If a registered value — or any 64-hex run —
//      somehow survives scrubbing, the whole line is discarded and replaced with
//      a failure marker. Losing a log line is an acceptable price; leaking a
//      signing key is not.
//
// THE SHAPE MASK IS A DELIBERATE TRADE. keeper-old matched only registered
// needles, because a 32-byte hex pattern also matches ledgerRoot, sessionId and
// every EIP-712 digest. DESIGN.md §0.6 chooses the mask anyway: the worker's
// audit trail is the ledger and the TickSummary, not the log stream, and a key
// that reaches a log line from somewhere config.ts never saw (a library error, a
// pasted value) is exactly the accident the mask closes. The mask keeps an 8-hex
// SHA-256 fingerprint so an operator can still correlate one hash across lines
// without being able to recover it.
//
// MECHANISM 3 USED TO BE UNABLE TO SEE THE CASE IT CITES. Its assertion was
// `contains()` over the same needle set `scrub()` had just substituted, so it
// could only fire if scrub had a bug — never for "the value was split by an
// escape sequence", which was the stated reason for its existence. `contains`
// therefore also tests the line with every non-hex character removed, which
// reassembles exactly that split and trips the suppression.

import { createHash } from "node:crypto";

/** Redacted stand-in emitted wherever a secret would have been. */
const marker = (label: string): string => `<redacted:${label}>`;

/**
 * A string that will not serialize.
 *
 * The value lives in a private field, so it is unreachable by
 * `Object.entries`, spread, `structuredClone` or `JSON.stringify`. Call
 * `reveal()` at exactly the point of use — a signer, a fetch — and never store
 * the result anywhere that outlives the call.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string, readonly label: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  /** Length is safe to expose and is useful for "is this key even plausible?". */
  get length(): number {
    return this.#value.length;
  }

  toString(): string {
    return marker(this.label);
  }

  toJSON(): string {
    return marker(this.label);
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return marker(this.label);
  }
}

interface RedactionEntry {
  readonly needle: string;
  readonly label: string;
}

/** A hex string with no `0x` prefix and nothing else in it. */
const HEX_BODY = /^[0-9a-fA-F]+$/;

/**
 * A run of EXACTLY 64 hex characters, optionally 0x-prefixed, that is not part
 * of a longer hex run. Exactly 64 and not "64 or more": a 65-byte signature or
 * a calldata blob is not a key, and an operator reading a revert wants them.
 */
const HEX64_SOURCE = "(?<![0-9a-fA-F])(?:0[xX])?[0-9a-fA-F]{64}(?![0-9a-fA-F])";
const HEX64_ALL = new RegExp(HEX64_SOURCE, "g");
// A global regex is stateful under `test`; the detector gets its own instance.
const HEX64_ANY = new RegExp(HEX64_SOURCE);

/**
 * Non-reversible tag for a masked 64-hex value: the first 8 hex of the SHA-256
 * of its lowercase body, so `0xABC…`, `0xabc…` and `abc…` share one tag and a
 * tx hash can be followed across lines. Eight hex of a 256-bit digest cannot be
 * inverted, and confirming a *guessed* key is already free on-chain.
 */
export function hex64Fingerprint(value: string): string {
  const body = (/^0x/i.test(value) ? value.slice(2) : value).toLowerCase();
  return createHash("sha256").update(body).digest("hex").slice(0, 8);
}

/**
 * Substitutes known-secret substrings out of arbitrary text, then masks every
 * 64-hex run that is left.
 *
 * Registration deliberately expands each secret into several forms: with and
 * without the `0x` prefix, and in both cases. A private key written
 * `0xAbC…` in the environment is the same secret as `abc…` appearing inside a
 * viem error message. Registered needles are substituted FIRST so that a known
 * secret is labelled with the variable to rotate, not with an anonymous
 * fingerprint.
 */
export class Redactor {
  #entries: RedactionEntry[] = [];

  register(secret: Secret | string, label?: string): this {
    const raw = secret instanceof Secret ? secret.reveal() : secret;
    const name = label ?? (secret instanceof Secret ? secret.label : "secret");
    if (raw.length === 0) return this;

    const forms = new Set<string>([raw, raw.toLowerCase(), raw.toUpperCase()]);
    // A hex secret is routinely quoted both ways. Redact the bare body too, so a
    // key that arrives 0x-prefixed is still caught if something strips it.
    if (/^0x[0-9a-fA-F]+$/.test(raw)) {
      const body = raw.slice(2);
      for (const form of [body, body.toLowerCase(), body.toUpperCase()]) forms.add(form);
    }

    for (const needle of forms) {
      // Very short needles would redact half the log. 8 hex chars is already
      // 4 bytes of entropy; nothing legitimate collides with a real key prefix.
      if (needle.length < 8) continue;
      this.#entries.push({ needle, label: name });
    }
    // Longest first, so the 0x-prefixed form wins over its own bare body and the
    // replacement is not left holding a stray "0x".
    this.#entries.sort((a, b) => b.needle.length - a.needle.length);
    return this;
  }

  /** How many needles are registered. Diagnostic only; never the needles. */
  get size(): number {
    return this.#entries.length;
  }

  /**
   * True when `text` still contains any registered secret or any 64-hex run.
   *
   * THREE PASSES, AND THE THIRD ONE IS THE POINT. A literal `includes` can only
   * disagree with `scrub` if `scrub` is broken, which makes it useless as the
   * independent check mechanism 3 claims to be. The last pass strips every
   * character that cannot appear in a hex secret and re-tests, so a key that was
   * emitted with a space, a quote, a newline or a JSON escape sequence somewhere
   * in the middle — the exact scenario mechanism 3 was written for, and a
   * demonstrated bypass — is still detected. Only hex-body needles of 16+
   * characters take part: shorter ones, and the URL forms, would collide with
   * ordinary text once the separators are gone.
   */
  contains(text: string): boolean {
    if (this.#entries.some((entry) => text.includes(entry.needle))) return true;
    if (HEX64_ANY.test(text)) return true;
    const hexOnly = text.replace(/[^0-9a-fA-F]/g, "");
    if (hexOnly.length < 16) return false;
    return this.#entries.some(
      (entry) => entry.needle.length >= 16 && HEX_BODY.test(entry.needle) && hexOnly.includes(entry.needle),
    );
  }

  scrub(text: string): string {
    let out = text;
    for (const entry of this.#entries) {
      if (out.includes(entry.needle)) out = out.split(entry.needle).join(marker(entry.label));
    }
    return out.replace(HEX64_ALL, (run) => marker(`hex64:${hex64Fingerprint(run)}`));
  }
}

/**
 * The process-wide needle set. `loadConfig` registers every secret it reads
 * here and `createLogger` falls back to it when given no redactor, so the two
 * files meet without a redactor field on the frozen WorkerConfig. Tests that
 * assert on labels pass their own `new Redactor()`.
 */
export const sharedRedactor = new Redactor();

export type LogLevel = "info" | "warn" | "error";

export interface LogFields {
  readonly [key: string]: unknown;
}

/** The contract every module logs through. Three levels; fields are data, never prose. */
export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export interface LoggerOptions {
  /** JSON lines when true. Defaults to "stdout is not a TTY" (DESIGN.md §2). */
  readonly json?: boolean;
  /** Defaults to `sharedRedactor`. */
  readonly redactor?: Redactor;
  /** Fields stamped onto every line: service, mode, chainId, … */
  readonly base?: LogFields;
  /** Defaults to stdout. Tests capture lines instead. */
  readonly sink?: (line: string) => void;
  readonly minLevel?: LogLevel;
  /** Injectable for deterministic tests. */
  readonly now?: () => Date;
}

const LEVEL_ORDER: Record<LogLevel, number> = { info: 20, warn: 30, error: 40 };

/**
 * viem appends the endpoint and the request body to transport errors as
 * separate lines. Even scrubbed, they are noise; unscrubbed they are the leak.
 * Dropping the whole line is strictly safer than trusting substitution to have
 * caught every form of the URL.
 *
 * `Docs:` matters because viem appends a docs link built from the failing
 * action, and `Version:` because it is the last line of every viem error and
 * there is no reason to carry it into an operator payload.
 */
const METADATA_LINE = /^\s*(URL|Request body|Request Arguments|Details|Docs|Version):/i;

export function stripUpstreamMetadata(text: string): string {
  if (!text.includes("\n")) return text;
  return text
    .split("\n")
    .filter((line) => !METADATA_LINE.test(line))
    .join("\n");
}

/** Deeper than any log field has a reason to be; also what stops a cycle. */
const MAX_DEPTH = 32;

/** Errors and bigints do not survive JSON.stringify; flatten them before it runs. */
function normalizeValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "<depth limit>";
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Secret) return value.toJSON();
  // A key carried as bytes bypasses redaction entirely: Buffer has a toJSON, so
  // it would serialize as {"type":"Buffer","data":[172,9,116,…]} — the key's
  // bytes in a form no registered needle matches and `contains` cannot see.
  // Nothing in this package has a reason to log bytes, so refuse rather than
  // encode. This check MUST precede the toJSON branch below.
  if (value instanceof ArrayBuffer) return `<binary:${value.byteLength} bytes>`;
  if (ArrayBuffer.isView(value)) return `<binary:${value.byteLength} bytes>`;
  if (value instanceof Error) {
    const extra = value as Error & { shortMessage?: string; metaMessages?: string[] };
    return {
      name: value.name,
      message: stripUpstreamMetadata(extra.shortMessage ?? value.message),
      stack: stripUpstreamMetadata(value.stack ?? ""),
      ...(extra.metaMessages ? { metaMessages: extra.metaMessages.map(stripUpstreamMetadata) } : {}),
    };
  }
  if (Array.isArray(value)) return value.map((inner) => normalizeValue(inner, depth + 1));
  if (value && typeof value === "object") {
    if (typeof (value as { toJSON?: unknown }).toJSON === "function") {
      // The config object's guard lands here: its toJSON returns the safe
      // description. Normalize the result too; a toJSON may still hold bigints.
      const json = (value as { toJSON: () => unknown }).toJSON();
      return json === value ? "<unserializable>" : normalizeValue(json, depth + 1);
    }
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) out[key] = normalizeValue(inner, depth + 1);
    return out;
  }
  return value;
}

/** One `key=value` for the human form. Bare when it reads fine bare; JSON otherwise. */
function humanValue(value: unknown): string {
  if (typeof value === "string" && /^[^\s"=]+$/.test(value)) return value;
  const json = JSON.stringify(value);
  return json === undefined ? String(value) : json;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const redactor = options.redactor ?? sharedRedactor;
  const json = options.json ?? process.stdout.isTTY !== true;
  const sink =
    options.sink ??
    ((line: string): void => {
      process.stdout.write(`${line}\n`);
    });
  const now = options.now ?? (() => new Date());
  const floor = LEVEL_ORDER[options.minLevel ?? "info"];
  const base = options.base ?? {};

  const render = (level: LogLevel, event: string, fields: LogFields): string => {
    const ts = now().toISOString();
    if (json) return JSON.stringify(normalizeValue({ ts, level, event, ...base, ...fields }));
    const pairs = Object.entries({ ...base, ...fields }).map(([key, value]) => `${key}=${humanValue(normalizeValue(value))}`);
    return [ts, level.toUpperCase().padEnd(5), event, ...pairs].join(" ");
  };

  const emit = (level: LogLevel, event: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[level] < floor) return;
    let text: string;
    try {
      text = render(level, event, fields ?? {});
    } catch {
      // A field that still defeats normalizeValue must not silence the log.
      text = JSON.stringify({ ts: now().toISOString(), level, event, logError: "unserializable fields" });
    }
    const scrubbed = redactor.scrub(text);
    if (redactor.contains(scrubbed)) {
      // Mechanism 3. Substitution failed — either scrub is broken, or the value
      // was split by a separator or an escape sequence, which `contains` detects
      // by re-testing the line with the separators removed. Drop the payload
      // entirely rather than ship it.
      sink(
        JSON.stringify({
          ts: now().toISOString(),
          level: "error",
          event: "log.suppressed",
          reason: "redaction failed",
          suppressedEvent: event,
        }),
      );
      return;
    }
    sink(scrubbed);
  };

  return {
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
  };
}

/** A logger that discards everything. Useful in tests that assert on state. */
export function silentLogger(): Logger {
  return createLogger({ redactor: new Redactor(), sink: () => {}, minLevel: "error", json: true });
}

export interface UpstreamSummaryOptions {
  /** Defaults to `sharedRedactor`. */
  readonly redactor?: Redactor;
  /** Meaningful lines to keep. Two is enough to name a revert. */
  readonly take?: number;
  readonly maxChars?: number;
}

/**
 * The ONLY sanctioned way to put an upstream failure into a payload that leaves
 * the process without passing through the logger — a `TickSummary`, a ledger
 * `detail`, a refusal's `detail`.
 *
 * A viem `HttpRequestError`'s `.message` is a multi-line blob whose second line
 * is `URL: <endpoint>`, and our endpoint carries an Alchemy API key. A routine
 * 429 was therefore enough to serve that key over an unauthenticated HTTP port
 * in keeper-old. So: name the error, drop viem's metadata lines, substitute
 * every registered secret, and if the check still finds something afterwards
 * return NOTHING but the error name. An operator losing the detail of one
 * failed read is cheap; publishing the endpoint credential is not.
 */
export function summarizeUpstreamError(error: unknown, options: UpstreamSummaryOptions = {}): string {
  const redactor = options.redactor ?? sharedRedactor;
  const name = error instanceof Error ? error.name : typeof error;
  const raw = error instanceof Error ? error.message : String(error);
  const lines = redactor
    .scrub(stripUpstreamMetadata(raw))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !METADATA_LINE.test(line));
  const body = lines.slice(0, options.take ?? 2).join(" ");
  const summary = (body === "" ? name : `${name}: ${body}`).slice(0, options.maxChars ?? 200);

  // The tripwire runs on the FINAL string, not the intermediate one.
  if (redactor.contains(summary)) return `${name}: <detail withheld: redaction tripwire>`;
  return summary;
}
