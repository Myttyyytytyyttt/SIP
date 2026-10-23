/**
 * /api/wallet-names — AN ACCOUNT'S NAMES FOR ITS TRADING WALLETS (owner, 10-23:
 * "que el nombre de la trading wallet se pueda editar", saved to the account,
 * on every device, with no wallet signature).
 *
 *   GET                             → 200 {names: {<address>: <name>}}
 *   PUT {address, name}             → 200 {names}: the account's names after the save
 *       name null or ""             → that wallet goes back to its default name
 *
 * WHO: the caller's Privy access token, `Authorization: Bearer`, checked against
 * Privy's PUBLISHED keys (lib/privy-access-token.ts) — the web still holds no
 * Privy secret. A name is filed under that login and no other, so nobody can
 * read or change another account's names, and a request without a believable
 * session is 401 before the store is touched.
 *
 * WHERE: one private document per account in the project's Vercel Blob store
 * (lib/wallet-names-store.ts). Without a store the route is 503 names_off before
 * anything else, and the browser shows the default names with no pencil.
 *
 * WHAT IT COSTS, AND WHY THE BUDGETS ARE SMALL. Every save is a put, an
 * "advanced operation"; on Vercel's Hobby plan the whole store gets 2,000 a
 * month, and running out shuts the store — the share links included — for the
 * rest of the period. So a save is charged three ways before it is made: the
 * client's own buckets (as every /api route charges, keyed on
 * SIP_TRUSTED_CLIENT_IP_HEADER), the account's (WALLET_NAMES_WRITES_PER_USER an
 * hour), and this instance's (WALLET_NAMES_WRITES_GLOBAL an hour, across
 * everyone). A save that changes nothing writes nothing. Reads are one get each,
 * from a budget of their own.
 *
 * NOTHING PERSONAL IN THE LOGS: no token, no user id, no address, no name — a
 * refusal logs its status and code, a store failure the error's class.
 */
import "server-only";

import { isPubkey } from "@sip/solana-core/client";
import {
  CLIENT_AGGREGATE_FACTOR,
  clientIdentityFromHeaders,
  createWeightedLimiter,
  isCrossSite,
  isJsonContentType,
  readBodyCapped,
  retryAfterSeconds,
  type WeightedLimiter,
} from "@sip/solana-core/server";
import type { JWTVerifyGetKey } from "jose";

import { readPrivyAppId, type ConfigProblem, type Env } from "@/lib/config";
import { solanaGate } from "@/lib/load-config";
import { bearerTokenOf, verifyPrivyAccessToken, type AccessCheck } from "@/lib/privy-access-token";
import { WALLET_NAMES_MAX, cleanWalletName } from "@/lib/wallet-names";
import { WalletNamesConflict, blobWalletNamesStore, walletNamesStoreConfigured, type WalletNamesStore } from "@/lib/wallet-names-store";

/** The largest PUT body: an address and a 32-character name are under 300 bytes. */
export const WALLET_NAMES_MAX_BODY_BYTES = 1_024;
/** Requests one client (IPv4 address, IPv6 /64) may make a minute, reads and saves together. Its network gets CLIENT_AGGREGATE_FACTOR times as many. */
export const WALLET_NAMES_PER_CLIENT_PER_MIN = 30;
/** Saves one account may make: this many at once, and this many an hour after. */
export const WALLET_NAMES_WRITES_PER_USER = 10;
/** Saves this instance makes an hour, across everyone. Hobby's store allows 2,000 a month in all. */
export const WALLET_NAMES_WRITES_GLOBAL = 20;
/** Reads this instance makes a minute, across everyone. */
export const WALLET_NAMES_READS_GLOBAL = 60;

const HOUR_MS = 60 * 60_000;
const GLOBAL = "global";
const FIELDS = ["address", "name"] as const;
const HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store" } as const;

/** What GET and a successful PUT answer. */
export interface WalletNamesAnswer {
  readonly names: Readonly<Record<string, string>>;
}

export type WalletNamesErrorCode =
  | "names_off"
  | "unavailable"
  | "cross_site"
  | "unsupported_media_type"
  | "payload_too_large"
  | "bad_request"
  | "rate_limited"
  | "too_many_names"
  | "names_unavailable"
  | Exclude<AccessCheck, { ok: true }>["code"];

interface Budgets {
  readonly exact: WeightedLimiter;
  readonly aggregate: WeightedLimiter;
  readonly writesPerUser: WeightedLimiter;
  readonly writesGlobal: WeightedLimiter;
  readonly readsGlobal: WeightedLimiter;
}

const BUDGETS = Symbol.for("sip.web.wallet-names.budgets");

/**
 * Held on globalThis like the share route's, so every bundle of this route
 * shares one set. The hourly buckets are remembered for the hour they take to
 * refill: a bucket forgotten sooner would come back full.
 */
function defaultBudgets(): Budgets {
  const holder = globalThis as unknown as Record<symbol, Budgets | undefined>;
  return (holder[BUDGETS] ??= {
    exact: createWeightedLimiter({ capacity: WALLET_NAMES_PER_CLIENT_PER_MIN }),
    aggregate: createWeightedLimiter({ capacity: CLIENT_AGGREGATE_FACTOR * WALLET_NAMES_PER_CLIENT_PER_MIN }),
    writesPerUser: createWeightedLimiter({ capacity: WALLET_NAMES_WRITES_PER_USER, refillPerMinute: WALLET_NAMES_WRITES_PER_USER / 60, idleMs: HOUR_MS }),
    writesGlobal: createWeightedLimiter({ capacity: WALLET_NAMES_WRITES_GLOBAL, refillPerMinute: WALLET_NAMES_WRITES_GLOBAL / 60, idleMs: HOUR_MS }),
    readsGlobal: createWeightedLimiter({ capacity: WALLET_NAMES_READS_GLOBAL }),
  });
}

export interface WalletNamesRouteOptions {
  /** Read at each request. Default: process.env. */
  readonly env?: Env;
  /** Default: the Vercel Blob store, when the environment names one. */
  readonly store?: WalletNamesStore;
  /** Privy's keys. Default: its published set for the app id in the environment. Tests pass a local set. */
  readonly keys?: JWTVerifyGetKey;
  readonly budgets?: Partial<Budgets>;
  readonly now?: () => number;
  /** Default: one console.warn line per second, carrying status and code only. */
  readonly onRefusal?: (event: { readonly status: number; readonly code: string }) => void;
}

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...extra } });
}

function sampledWarn(): (event: { readonly status: number; readonly code: string }) => void {
  let last = 0;
  return (event) => {
    const at = Date.now();
    if (at - last < 1_000) return;
    last = at;
    console.warn(JSON.stringify({ event: "wallet_names.refusal", ...event }));
  };
}

/** A store call that failed: its class only, never its message (it can carry the store's id) and never whose names. */
function logStoreFailure(error: unknown): void {
  const kind = error instanceof Error ? error.constructor.name : typeof error;
  console.warn(JSON.stringify({ event: "wallet_names.store_failed", error: kind }));
}

function parseObject(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** `names` with `address` set to `name`, or removed when `name` is null. */
function withName(names: Readonly<Record<string, string>>, address: string, name: string | null): Record<string, string> {
  const next = { ...names };
  if (name === null) delete next[address];
  else next[address] = name;
  return next;
}

export function walletNamesRoute(options: WalletNamesRouteOptions = {}): { GET(request: Request): Promise<Response>; PUT(request: Request): Promise<Response> } {
  const env = (): Env => options.env ?? process.env;
  const now = options.now ?? Date.now;
  const onRefusal = options.onRefusal ?? sampledWarn();
  const budgets = (): Budgets => ({ ...defaultBudgets(), ...options.budgets });
  const store = (): WalletNamesStore => options.store ?? blobWalletNamesStore();

  const refuse = (status: number, code: WalletNamesErrorCode, message: string, more: Record<string, unknown> = {}, extra: Record<string, string> = {}): Response => {
    onRefusal({ status, code });
    return json(status, { error: { code, message, ...more } }, extra);
  };
  const limited = (waitMs: number, what: string): Response => {
    const seconds = retryAfterSeconds(waitMs);
    return refuse(429, "rate_limited", `${what} Retry in ${seconds} s.`, { retryAfterSeconds: seconds }, { "retry-after": String(seconds) });
  };

  /**
   * EVERY REQUEST, IN THIS ORDER: off before anything, the gate, cross-site, the
   * client's buckets, then who it is. A client already refused is not verified,
   * so a flood of junk tokens costs no key-set fetch.
   */
  async function admit(request: Request): Promise<{ readonly ok: true; readonly userId: string; readonly budgets: Budgets } | { readonly ok: false; readonly response: Response }> {
    const settings = env();
    if (!walletNamesStoreConfigured(settings)) {
      return { ok: false, response: json(503, { error: { code: "names_off", message: "Wallet names are not kept on this deployment." } }) };
    }
    const gate = solanaGate(settings);
    if (gate.kind === "invalid") return { ok: false, response: refuse(503, "unavailable", "This deployment is not configured.") };
    if (isCrossSite(request)) return { ok: false, response: refuse(403, "cross_site", "Cross-site requests are refused.") };

    const held = budgets();
    const identity = clientIdentityFromHeaders(request.headers, gate.settings.trustedClientIpHeader);
    const at = now();
    // The client's own bucket first: a client already refused spends nothing of its neighbours'.
    const own = held.exact.take(identity.exact, 1, at);
    const wait = own > 0 ? own : held.aggregate.take(identity.aggregate, 1, at);
    if (wait > 0) return { ok: false, response: limited(wait, "Too many requests from this client.") };

    // The token's audience: this app's id, read as the pages read it, and refused as they refuse it.
    const problems: ConfigProblem[] = [];
    const appId = readPrivyAppId(settings, true, problems)?.value ?? null;
    if (appId === null || problems.length > 0) return { ok: false, response: refuse(503, "unavailable", "This deployment is not configured.") };
    const access = await verifyPrivyAccessToken(bearerTokenOf(request), { appId, keys: options.keys, now });
    if (!access.ok) {
      const message = access.status === 503 ? "Your session could not be checked just now." : "Sign in again to name your wallets.";
      return { ok: false, response: refuse(access.status, access.code, message) };
    }
    return { ok: true, userId: access.userId, budgets: held };
  }

  const unavailable = (error: unknown): Response => {
    logStoreFailure(error);
    return refuse(503, "names_unavailable", "Your wallet names could not be reached just now.");
  };

  return {
    async GET(request) {
      const admitted = await admit(request);
      if (!admitted.ok) return admitted.response;
      const wait = admitted.budgets.readsGlobal.take(GLOBAL, 1, now());
      if (wait > 0) return limited(wait, "SaverFi is reading many wallet names right now.");
      try {
        const { names } = await store().read(admitted.userId);
        return json(200, { names } satisfies WalletNamesAnswer);
      } catch (error) {
        return unavailable(error);
      }
    },

    async PUT(request) {
      const admitted = await admit(request);
      if (!admitted.ok) return admitted.response;
      if (!isJsonContentType(request)) return refuse(415, "unsupported_media_type", "Content-Type must be application/json.");

      const body = await readBodyCapped(request, WALLET_NAMES_MAX_BODY_BYTES);
      if (!body.ok) {
        return body.reason === "too_large"
          ? refuse(413, "payload_too_large", `Request body exceeds ${WALLET_NAMES_MAX_BODY_BYTES} bytes.`)
          : refuse(400, "bad_request", "The request body could not be read.");
      }
      const fields = parseObject(body.bytes);
      if (fields === null) return refuse(400, "bad_request", "The body must be a JSON object.");
      const extra = Object.keys(fields).find((name) => !(FIELDS as readonly string[]).includes(name));
      if (extra !== undefined) return refuse(400, "bad_request", `Unexpected field ${extra.slice(0, 40)}.`);
      const { address, name } = fields;
      if (!isPubkey(address)) return refuse(400, "bad_request", "address must be a base58 32-byte Solana address.");
      if (name !== null && typeof name !== "string") return refuse(400, "bad_request", "name must be a string, or null for the default name.");
      const cleaned = cleanWalletName(name ?? "");
      if (!cleaned.ok) return refuse(400, "bad_request", cleaned.message);

      const names = store();
      const { userId, budgets: held } = admitted;
      /** One read, the edit, one save — or the answer that no save is needed. */
      const attempt = async (): Promise<Response | "conflict"> => {
        const read = await names.read(userId);
        const current = read.names[address] ?? null;
        if (current === cleaned.name) return json(200, { names: read.names } satisfies WalletNamesAnswer);
        if (current === null && cleaned.name !== null && Object.keys(read.names).length >= WALLET_NAMES_MAX) {
          return refuse(409, "too_many_names", `An account keeps at most ${WALLET_NAMES_MAX} wallet names.`);
        }
        // Charged only for a save that will be made: the account first, then everyone's.
        const at = now();
        const mine = held.writesPerUser.take(userId, 1, at);
        if (mine > 0) return limited(mine, "Too many renames from this account.");
        const everyone = held.writesGlobal.take(GLOBAL, 1, at);
        if (everyone > 0) return limited(everyone, "SaverFi is saving many wallet names right now.");
        const next = withName(read.names, address, cleaned.name);
        try {
          await names.write(userId, next, read.etag);
        } catch (error) {
          if (error instanceof WalletNamesConflict) return "conflict";
          throw error;
        }
        return json(200, { names: next } satisfies WalletNamesAnswer);
      };

      try {
        // Another device saved in between: read what it saved, and apply this change over it — once.
        const first = await attempt();
        if (first !== "conflict") return first;
        const second = await attempt();
        return second === "conflict" ? unavailable(new WalletNamesConflict()) : second;
      } catch (error) {
        return unavailable(error);
      }
    },
  };
}
