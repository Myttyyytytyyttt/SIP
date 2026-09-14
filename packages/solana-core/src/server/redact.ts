// Keeping endpoint URLs out of every string that leaves this package.
//
// The house rule is SIP's logger's (packages/solana-log/src/log.ts): a credential
// is held in a value that will not serialize, revealed only at the point of use,
// and every outgoing string is scrubbed. It is re-implemented here in a few
// lines rather than imported, so the web image does not take in another
// workspace package for two classes.

const URL_PATTERN = /\b(?:https?|wss?):\/\/[^\s"'<>`)]+/gi;
const MIN_NEEDLE = 6;

/** Replaces every http(s)/ws(s) URL in `text` with `<url>`. */
export const stripUrls = (text: string): string => text.replace(URL_PATTERN, "<url>");

const tryUrl = (raw: string): URL | null => {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
};

/**
 * Scrubs registered URLs AND their credential-bearing parts: a library message
 * can quote a host or an `api-key` value without the rest of the URL.
 */
export class UrlRedactor {
  #needles: string[] = [];

  register(raw: string): this {
    const parsed = tryUrl(raw);
    const parts = [raw];
    if (parsed !== null) {
      parts.push(parsed.href, parsed.host, parsed.hostname, parsed.search, parsed.username, parsed.password);
      for (const value of parsed.searchParams.values()) parts.push(value);
      for (const segment of parsed.pathname.split("/")) parts.push(segment);
    }
    for (const part of parts) {
      if (part.length >= MIN_NEEDLE && !this.#needles.includes(part)) this.#needles.push(part);
    }
    this.#needles.sort((a, b) => b.length - a.length);
    return this;
  }

  scrub(text: string): string {
    let out = stripUrls(text);
    for (const needle of this.#needles) {
      if (out.includes(needle)) out = out.split(needle).join("<redacted>");
    }
    return out;
  }

  /** True when a registered needle survives in `text`. */
  leaks(text: string): boolean {
    return this.#needles.some((needle) => text.includes(needle));
  }
}

const marker = (label: string): string => `<redacted:${label}>`;

/**
 * One RPC endpoint URL, unreachable by JSON.stringify, spread or util.inspect.
 * `reveal()` is called inside the fetch and nowhere else.
 */
export class RpcEndpoint {
  readonly #url: string;

  constructor(
    url: string,
    readonly label: string,
  ) {
    this.#url = url;
  }

  reveal(): string {
    return this.#url;
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

/** Endpoints from plain URL strings (tests, scripts), each registered with `redactor`. */
export function rpcEndpoints(urls: readonly string[], redactor?: UrlRedactor): RpcEndpoint[] {
  return urls.map((url, index) => {
    redactor?.register(url);
    return new RpcEndpoint(url, `rpcUrl:${index}`);
  });
}
