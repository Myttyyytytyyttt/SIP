/**
 * The one door an error text passes through before it can reach a browser.
 * Ported from the Nuvem dashboard's src/lib/vault.ts redaction block (HEAD
 * fd927b0), split out so every route can reach it without importing the read
 * client.
 *
 * viem annotates every transport error with the endpoint it called:
 *
 *   HTTP request failed.
 *   URL: https://…/v2/<ALCHEMY API KEY>
 *   Request body: {"method":"eth_call",…}
 *   Details: fetch failed
 *   Version: viem@2.55.8
 *
 * NUVEM_RPC_URL is explicitly allowed to carry an API key because it is meant to
 * stay server-side, so ANY error text that can reach a client must have that URL
 * removed. Note this fires on the paths that matter most: an unreachable
 * endpoint, a timeout, or an Alchemy 429 are all HttpRequestError, so a plain
 * rate-limit would otherwise publish the key to the browser.
 *
 * THREE INDEPENDENT MECHANISMS, deliberately. Dropping viem's `URL:` line
 * depends on its formatting, which is not a stable contract; substituting the
 * configured URL cannot quietly stop working; and the shape-based sweep below
 * catches a key that arrived through some path nobody threaded a config into.
 * Any one alone would be enough today.
 */

const UPSTREAM = "<upstream RPC>";

/** viem's trailing metadata lines. `URL:` and `Request body:` must never ship. */
export const METADATA_LINE = /^(URL|Request body|Docs|Version):/i;

/** Every occurrence of the configured upstream, in every form it could appear. */
export function redactUpstream(text: string, rpcUrl: string): string {
  if (rpcUrl === "") return text;
  let out = text.split(rpcUrl).join(UPSTREAM);
  try {
    const url = new URL(rpcUrl);
    // Longest first: replacing the origin before origin+pathname would leave the
    // path (which is where an Alchemy key lives) stranded in the output.
    for (const form of [url.origin + url.pathname, url.origin, url.host, url.hostname]) {
      if (form !== "") out = out.split(form).join(UPSTREAM);
    }
  } catch {
    // Not a parseable URL; the literal substitution above still applied.
  }
  return out;
}

/**
 * Anything URL- or key-shaped, regardless of where it came from.
 *
 *   - every http(s)/ws(s) URL, because a URL in an error is a URL that carried
 *     something — a key in its path, a query token, an internal host;
 *   - every 64-hex-digit run: a private key, or a bytes32 that nobody needs to
 *     read in an error message. 40-digit addresses are LEFT ALONE — a named
 *     revert such as `VaultAdminAlreadyRegistered(0x…, 0x…)` is the whole point
 *     of showing the error;
 *   - every long mixed run of letters and digits (32+, both kinds present),
 *     which is what an API key or bearer token looks like and what no English
 *     word or number does. A 0x-prefixed 40-hex ADDRESS is the one such run
 *     that is exempt, by an explicit lookahead, for the reason above.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(?:https?|wss?):\/\/[^\s"'<>)\]]+/gi, "<url>")
    .replace(/\b0x[0-9a-fA-F]{64,}\b/g, "<hex>")
    .replace(/\b(?!0x[0-9a-fA-F]{40}\b)(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{32,}\b/g, "<key>");
}

/**
 * A client-safe summary of a failed call: the first `take` meaningful lines,
 * with the upstream endpoint scrubbed and every URL- or key-shaped token
 * stripped. Two lines is the useful default for a revert — viem puts
 * "The contract function "createVault" reverted." on the first and
 * "Error: VaultAdminAlreadyRegistered(address vaultAdmin, address vault)" on the
 * second.
 */
export function errorSummary(error: unknown, rpcUrl: string, take = 1): string {
  const raw = error instanceof Error ? error.message : String(error);
  const lines = redactSecrets(redactUpstream(raw, rpcUrl))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !METADATA_LINE.test(line));
  if (lines.length === 0) return error instanceof Error ? error.name : "unknown error";
  return lines.slice(0, take).join(" ");
}
