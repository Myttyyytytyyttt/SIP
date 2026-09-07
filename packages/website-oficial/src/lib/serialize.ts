/**
 * The server reads the chain and the browser renders the result, so responses
 * have to survive JSON. They are full of `bigint` (wei, epochs, block numbers),
 * which `JSON.stringify` throws on. Ported from the Nuvem dashboard's
 * src/lib/serialize.ts (HEAD fd927b0).
 *
 * Every bigint is tagged as `{"$bigint":"…"}` and restored on the client. Tagging
 * rather than stringifying is deliberate: a wei amount silently arriving as the
 * string "1000000000000000000" would compare and add wrongly without ever
 * throwing, and this app compares wei against wei. A wrong comparison here is a
 * wrong answer on screen.
 */

const TAG = "$bigint";

interface TaggedBigint {
  readonly [TAG]: string;
}

function isTagged(value: unknown): value is TaggedBigint {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.keys(value).length === 1 &&
    typeof (value as Record<string, unknown>)[TAG] === "string"
  );
}

/** JSON text with bigints tagged. Use as a Response body. */
export function stringifyTagged(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    typeof inner === "bigint" ? { [TAG]: inner.toString() } : inner,
  );
}

/** Inverse of stringifyTagged. Throws on malformed input, which the caller reports. */
export function parseTagged<T>(text: string): T {
  return JSON.parse(text, (_key, inner: unknown) => (isTagged(inner) ? BigInt(inner[TAG]) : inner)) as T;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(stringifyTagged(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // These responses describe one wallet's live onchain state. Caching them,
      // at any layer, would show one user another user's vault.
      "cache-control": "no-store, private",
    },
  });
}
