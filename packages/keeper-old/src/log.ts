// Structured logging that cannot print a secret.
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
//   1. `Secret` never yields its value to a serializer. toString, toJSON and
//      node's inspect hook all return a label. `JSON.stringify(config)` is
//      therefore safe by construction, not by discipline.
//   2. `Redactor.scrub` substitutes every registered secret out of the FULLY
//      SERIALIZED line, so nested error messages, `error.stack`, viem's
//      metaMessages and anything an author forgot about are all covered. It runs
//      last, on a string, where there is nowhere left to hide.
//   3. A post-substitution assertion. If a registered value somehow survives
//      scrubbing, the whole line is discarded and replaced with a failure
//      marker. Losing a log line is an acceptable price; leaking a signing key
//      is not.
//
// Mechanism 2 is the one under test in test/log.test.ts against a real-looking
// 32-byte hex key.
//
// MECHANISM 3 USED TO BE UNABLE TO SEE THE CASE IT CITES. Its assertion was
// `contains()` over the same needle set `scrub()` had just substituted, so it
// could only fire if scrub had a bug — never for "the value was split by an
// escape sequence", which was the stated reason for its existence. A key logged
// as `${key.slice(0,20)} ${key.slice(20)}` was emitted whole and the assertion
// reported clean. `contains` now also tests the line with every non-hex
// character removed, which reassembles exactly that split and trips the
// suppression. See test/log.test.ts, "a key split by a separator".
//
// AND THE STATUS/STDOUT EXITS DO NOT GO THROUGH A LOGGER AT ALL. `GET /status`
// and `keeper status` serialize a payload straight to a socket, so anything that
// files a raw upstream error message into that payload bypasses all three
// mechanisms. `summarizeUpstreamError` is the sanctioned way to put an upstream
// failure into an operator-facing payload: it drops viem's metadata lines,
// substitutes the endpoint host, scrubs, and then refuses to return anything at
// all if either check still finds a secret.

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
 * Substitutes known-secret substrings out of arbitrary text.
 *
 * Registration deliberately expands each secret into several forms: with and
 * without the `0x` prefix, and in both cases. A private key written
 * `0xAbC…` in the environment is the same secret as `abc…` appearing inside a
 * viem error message, and only exact substring matching is trustworthy here —
 * pattern matching on "looks like a 32-byte hex string" would also redact
 * `ledgerRoot`, `sessionId` and every EIP-712 digest, which are precisely the
 * values an auditor needs.
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

  /**
   * True when `text` still contains any registered secret.
   *
   * TWO PASSES, AND THE SECOND ONE IS THE POINT. A literal `includes` can only
   * disagree with `scrub` if `scrub` is broken, which makes it useless as the
   * independent check mechanism 3 claims to be. The second pass strips every
   * character that cannot appear in a hex secret and re-tests, so a key that was
   * emitted with a space, a quote, a newline or a JSON escape sequence somewhere
   * in the middle — the exact scenario mechanism 3 was written for, and a
   * demonstrated bypass — is still detected. Only hex-body needles of 16+
   * characters take part: shorter ones, and the URL forms, would collide with
   * ordinary text once the separators are gone.
   */
  contains(text: string): boolean {
    if (this.#entries.some((entry) => text.includes(entry.needle))) return true;
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
    return out;
  }
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  readonly [key: string]: unknown;
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Derives a logger whose fields are merged into every line. */
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  readonly redactor: Redactor;
  /** Fields stamped onto every line: service, gitSha, dryRun, chainId, … */
  readonly base?: LogFields;
  /** Defaults to stdout. Tests capture lines instead. */
  readonly sink?: (line: string) => void;
  readonly minLevel?: LogLevel;
  /** Injectable for deterministic tests. */
  readonly now?: () => Date;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * viem appends the endpoint and the request body to transport errors as
 * separate lines. Even scrubbed, they are noise; unscrubbed they are the leak.
 * Dropping the whole line is strictly safer than trusting substitution to have
 * caught every form of the URL.
 *
 * The list matches packages/web/src/lib/vault.ts (which hit this same bug and
 * fixed it the same way), plus the two extra names viem emits on contract
 * errors. `Docs:` matters because viem appends a docs link built from the
 * failing action, and `Version:` because it is the last line of every viem
 * error and there is no reason to carry it into an operator payload.
 */
const METADATA_LINE = /^\s*(URL|Request body|Request Arguments|Details|Docs|Version):/i;

export function stripUpstreamMetadata(text: string): string {
  if (!text.includes("\n")) return text;
  return text
    .split("\n")
    .filter((line) => !METADATA_LINE.test(line))
    .join("\n");
}

/** What an endpoint becomes once it has been taken out of a message. */
const UPSTREAM = "<upstream RPC>";

/**
 * Substitutes the endpoint's host out of arbitrary text.
 *
 * This is the second, independent mechanism, and the division of labour is
 * deliberate: the `Redactor` already holds the FULL url (config.ts registers it
 * as a secret), which covers `origin + pathname` — the form that carries an
 * Alchemy key — while this covers the host and hostname forms that appear on
 * their own in DNS, TLS and connect errors. Neither needs the secret revealed:
 * `config.rpcHost` is already the parsed host and is safe to hold in the clear.
 */
export function redactUpstreamHost(text: string, rpcHost: string): string {
  if (rpcHost.length < 4) return text;
  let out = text;
  // Longest first, so replacing `host:port` does not leave a stray `:port`.
  const hostname = rpcHost.split(":")[0] ?? rpcHost;
  for (const form of hostname === rpcHost ? [rpcHost] : [rpcHost, hostname]) {
    if (form.length >= 4) out = out.split(form).join(UPSTREAM);
  }
  return out;
}

export interface UpstreamSummaryOptions {
  readonly redactor: Redactor;
  /** Host only, as `KeeperConfig.rpcHost` carries it. Never the full URL. */
  readonly rpcHost: string;
  /** Meaningful lines to keep. Two is enough to name a revert. */
  readonly take?: number;
  readonly maxChars?: number;
}

/**
 * The ONLY sanctioned way to put an upstream failure into a payload that leaves
 * the process without passing through the logger — `GET /status`, `keeper
 * status`, a `TickResult.detail`.
 *
 * A viem `HttpRequestError`'s `.message` is a multi-line blob whose second line
 * is `URL: <endpoint>`, and our endpoint carries an Alchemy API key. A routine
 * 429 was therefore enough to serve that key over an unauthenticated HTTP port.
 * So: name the error, drop viem's metadata lines, substitute the host,
 * substitute every registered secret, and if either check still finds something
 * afterwards return NOTHING but the error name. An operator losing the detail of
 * one failed read is cheap; publishing the endpoint credential is not.
 */
export function summarizeUpstreamError(error: unknown, options: UpstreamSummaryOptions): string {
  const name = error instanceof Error ? error.name : typeof error;
  const raw = error instanceof Error ? error.message : String(error);
  const cleaned = redactUpstreamHost(options.redactor.scrub(stripUpstreamMetadata(raw)), options.rpcHost);
  const lines = cleaned
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !METADATA_LINE.test(line));
  const body = lines.slice(0, options.take ?? 2).join(" ");
  const summary = (body === "" ? name : `${name}: ${body}`).slice(0, options.maxChars ?? 200);

  // The tripwire. Truncation can also re-expose a needle whose replacement was
  // cut in half, so this runs on the FINAL string, not the intermediate one.
  if (options.redactor.contains(summary)) return `${name}: <detail withheld: redaction tripwire>`;
  if (options.rpcHost.length >= 4 && summary.toLowerCase().includes(options.rpcHost.toLowerCase())) {
    return `${name}: <detail withheld: endpoint tripwire>`;
  }
  return summary;
}

/** Errors do not survive JSON.stringify; flatten them before it runs. */
function normalizeValue(value: unknown): unknown {
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
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value && typeof value === "object") {
    if (typeof (value as { toJSON?: unknown }).toJSON === "function") {
      return (value as { toJSON: () => unknown }).toJSON();
    }
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) out[key] = normalizeValue(inner);
    return out;
  }
  return value;
}

export function createLogger(options: LoggerOptions): Logger {
  const { redactor } = options;
  const sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date());
  const floor = LEVEL_ORDER[options.minLevel ?? "info"];

  const build = (base: LogFields): Logger => {
    const emit = (level: LogLevel, msg: string, fields?: LogFields): void => {
      if (LEVEL_ORDER[level] < floor) return;
      const line = { ts: now().toISOString(), level, msg, ...base, ...(fields ?? {}) };
      let text: string;
      try {
        text = JSON.stringify(normalizeValue(line));
      } catch {
        // A circular or otherwise unserializable field must not silence the log.
        text = JSON.stringify({ ts: now().toISOString(), level, msg, logError: "unserializable fields" });
      }
      const scrubbed = redactor.scrub(text);
      if (redactor.contains(scrubbed)) {
        // Mechanism 3. Substitution failed — either scrub is broken, or the value
        // was split by a separator or an escape sequence, which `contains` now
        // detects by re-testing the line with the separators removed. Drop the
        // payload entirely rather than ship it.
        sink(
          JSON.stringify({
            ts: now().toISOString(),
            level: "error",
            msg: "log line suppressed: redaction failed",
            suppressedMsg: msg,
          }),
        );
        return;
      }
      sink(scrubbed);
    };

    return {
      debug: (msg, fields) => emit("debug", msg, fields),
      info: (msg, fields) => emit("info", msg, fields),
      warn: (msg, fields) => emit("warn", msg, fields),
      error: (msg, fields) => emit("error", msg, fields),
      child: (fields) => build({ ...base, ...fields }),
    };
  };

  return build(options.base ?? {});
}

/** A logger that discards everything. Useful in tests that assert on state. */
export function silentLogger(): Logger {
  return createLogger({ redactor: new Redactor(), sink: () => {}, minLevel: "error" });
}
