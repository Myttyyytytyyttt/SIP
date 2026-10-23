/**
 * THE BROWSER'S SIDE OF /api/wallet-names (owner, 10-23; the server's is
 * lib/wallet-names-server.ts): read the account's names, save one.
 *
 * The caller's Privy access token goes in `Authorization: Bearer`, which is why
 * this is not createJsonPoster — that transport sends no header of the
 * caller's. The answer is read by the same rules as every other route's
 * (createJsonPoster().result): a refusal keeps its code and retry-after, and a
 * request that never got an answer is a network failure, never a throw.
 *
 * Same-origin and no-store: the CSP needs nothing new, and no browser or CDN
 * cache keeps a name the account has since changed.
 */

import { createJsonPoster, type Answer, type ApiResult } from "@/lib/vault-api";
import { namesFrom } from "@/lib/wallet-names";

export const WALLET_NAMES_PATH = "/api/wallet-names";

/** What both calls answer when they succeed: the account's names, after any save. */
export interface WalletNames {
  readonly names: Readonly<Record<string, string>>;
}

interface CallOptions {
  readonly fetch?: typeof fetch;
}

async function call(method: "GET" | "PUT", token: string, body: unknown, options: CallOptions): Promise<ApiResult<WalletNames>> {
  // Looked up at call time, and never detached from its global: a bare reference throws "Illegal invocation" in browsers.
  const send = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  let answer: Answer | null = null;
  try {
    const response = await send(WALLET_NAMES_PATH, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: "no-store",
    });
    const text = await response.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      json = null;
    }
    const retry = Number(response.headers.get("retry-after") ?? "");
    answer = { status: response.status, json, retryAfterSeconds: Number.isFinite(retry) && retry > 0 ? retry : null };
  } catch {
    answer = null;
  }
  const result = createJsonPoster().result<{ readonly names?: unknown }>(answer);
  // Only well-formed names reach the screen, whatever the answer carried.
  return result.ok ? { ok: true, status: result.status, body: { names: namesFrom(result.body.names) } } : result;
}

/** The account's names. A 503 names_off means this deployment keeps none: show the defaults, offer no pencil. */
export const readWalletNames = (token: string, options: CallOptions = {}): Promise<ApiResult<WalletNames>> => call("GET", token, undefined, options);

/** Saves `name` for `address` (null: back to the default name), and answers every name the account has after it. */
export const saveWalletName = (token: string, address: string, name: string | null, options: CallOptions = {}): Promise<ApiResult<WalletNames>> =>
  call("PUT", token, { address, name }, options);
