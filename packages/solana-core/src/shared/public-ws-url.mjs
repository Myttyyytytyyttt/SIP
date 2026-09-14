// The one validator for SIP_SOLANA_PUBLIC_WS_URL, in plain JavaScript so that
// both the TypeScript server config and the web's security-headers.mjs (which
// Node loads without a TypeScript loader) import the SAME rule.
//
// WHY SO STRICT. This URL is handed to every browser (Privy's rpcSubscriptions)
// and its origin goes into the CSP. A key-free public WebSocket needs no path, no
// query and no credentials; a provider key lives in exactly those places. So
// they are refused outright, and so is any URL on an RPC host or quoting any
// secret-looking part of an RPC URL — a keyed endpoint must never reach a page.

export const DEFAULT_PUBLIC_WS_URL = "wss://api.mainnet-beta.solana.com";

const LOOPBACK = /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])$/;
const MIN_SECRET_PART = 6;

function tryUrl(raw) {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** The parts of an RPC URL that can carry a credential on their own. */
function secretParts(url) {
  const parts = [];
  for (const value of url.searchParams.values()) parts.push(value);
  for (const segment of url.pathname.split("/")) parts.push(decodeURIComponent(segment));
  parts.push(url.username, url.password);
  return parts.filter((part) => part.length >= MIN_SECRET_PART);
}

/**
 * @param {string | undefined} raw SIP_SOLANA_PUBLIC_WS_URL
 * @param {readonly string[]} rpcUrls the entries of SIP_SOLANA_RPC_URLS
 * @returns {{ ok: true, url: string, defaulted: boolean } | { ok: false, reason: string }}
 */
export function checkPublicWsUrl(raw, rpcUrls) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text === "") return { ok: true, url: DEFAULT_PUBLIC_WS_URL, defaulted: true };
  const parsed = tryUrl(text);
  if (parsed === null) return { ok: false, reason: "is not a URL" };
  const loopback = LOOPBACK.test(parsed.hostname);
  if (parsed.protocol !== "wss:" && !(parsed.protocol === "ws:" && loopback)) {
    return { ok: false, reason: "must be a wss:// URL (ws:// only for a loopback host)" };
  }
  if (parsed.username !== "" || parsed.password !== "") return { ok: false, reason: "must not carry credentials" };
  if (text.includes("?") || text.includes("#")) return { ok: false, reason: "must not have a query string or fragment" };
  if (parsed.pathname !== "" && parsed.pathname !== "/") return { ok: false, reason: "must not have a path" };
  for (const entry of rpcUrls) {
    const rpc = tryUrl(String(entry).trim());
    if (rpc === null) continue;
    if (rpc.hostname.toLowerCase() === parsed.hostname.toLowerCase()) {
      return { ok: false, reason: "is on the same host as an SIP_SOLANA_RPC_URLS endpoint, which carries a key" };
    }
    // Case-insensitive: a key that lands in a host is lowercased by every URL parser.
    const lowered = text.toLowerCase();
    if (secretParts(rpc).some((part) => lowered.includes(part.toLowerCase()))) {
      return { ok: false, reason: "contains part of an SIP_SOLANA_RPC_URLS endpoint" };
    }
  }
  return { ok: true, url: `${parsed.protocol}//${parsed.host}`, defaulted: false };
}
