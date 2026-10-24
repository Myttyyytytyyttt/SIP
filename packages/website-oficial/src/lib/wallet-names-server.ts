/**
 * /api/wallet-names — AN ACCOUNT'S NAMES FOR ITS TRADING WALLETS (owner, 10-23:
 * "que el nombre de la trading wallet se pueda editar", saved to the account,
 * on every device, with no wallet signature).
 *
 *   GET                             → 200 {names: {<address>: <name>}}
 *   PUT {address, name}             → 200 {names}: the account's names after the save
 *       name null or ""             → that wallet goes back to its default name
 *   either, while saves are spent   → the same, with paused: true (no pencil)
 *
 * WHO: the caller's Privy access token, `Authorization: Bearer`, checked against
 * Privy's PUBLISHED keys (lib/privy-access-token.ts) — the web still holds no
 * Privy secret. A name is filed under that login and no other, so nobody can
 * read or change another account's names, and a request without a believable
 * session is 401 before the store is touched.
 *
 * WHERE: one private document per account in the project's Vercel Blob store
 * (lib/wallet-names-store.ts), the short links' store, found by their rule
 * (share-store.ts shareStoreAuthOf). Without a store the route is 503
 * names_off before anything else, and the browser shows the default names with
 * no pencil.
 *
 * WHAT IT COSTS — THE WHOLE STORE, NOT THESE NAMES ALONE (10-23). The store
 * also keeps the short share links (lib/share-store.ts), and Vercel counts the
 * two together: on Hobby, 2,000 "advanced" operations a month (a save here, a
 * record there) and 10,000 "simple" ones (a read that misses Blob's cache:
 * every read here, which skips it), and past either Blob is blocked for 30
 * days — reads too, so every short link already posted fails until then. The
 * short links are what the owner posts; the names are a convenience. So the
 * names get the small end, and a flood of them can spend only that:
 *   - THIS INSTANCE KEEPS A COPY of each account's names, from its last read or
 *     save, and answers from it for WALLET_NAMES_COPY_MS: a reload, a second tab,
 *     the dashboard then /wallets, a rename — none of them reads the store again.
 *   - A STORE READ is charged to the account (WALLET_NAMES_READS_PER_USER) and to
 *     this instance (WALLET_NAMES_READS_PER_DAY); a save to the account
 *     (WALLET_NAMES_WRITES_PER_USER) and to this instance
 *     (WALLET_NAMES_WRITES_PER_DAY), each a day. The client's own buckets come
 *     first, as on every /api route (SIP_TRUSTED_CLIENT_IP_HEADER).
 *   - A RE-READ — an account this instance already holds a copy of: a reload
 *     past the copy's minutes, or a save the copy calls unchanged — is also
 *     charged to the re-reads' share (WALLET_NAMES_REREADS_PER_DAY), a third of
 *     the instance's day (review, 10-23). Past it, the copy answers, of any age.
 *     So refreshing copies, an abuser's loop of unchanged saves included, takes
 *     at most a third of the day's reads, and the other two thirds are left for
 *     the accounts this instance holds no copy of — the ones that, refused,
 *     show the default names. The share adds no read to the sums below.
 *   - AN INSTANCE'S BUDGET FOUND SPENT COSTS ONE TOKEN, TO THE ACCOUNT THAT
 *     FINDS IT. A bucket cannot be read without spending it, so the account's
 *     is charged before the instance's: the request that finds the instance's
 *     empty has spent its account's token (a re-read, a token of the re-reads'
 *     share too), and the instance's is then known spent until it refills, so
 *     every request meanwhile is refused before anything is charged.
 *   - ONE INSTANCE, SPENT FLAT OUT FOR A 31-DAY MONTH (a full bucket, then 31
 *     days of refill: 32 days' worth): 32 × 5 = 160 saves and 32 × 30 = 960
 *     reads. The short links' own writes, at their budget: 32 × 20 = 640
 *     (SHARE_STORE_WRITES_PER_DAY, a fixed daily window, 32 of them at most).
 *     Their reads have NO monthly bound in code (review, 10-23): 120 a minute per
 *     instance (SHARE_STORE_READS_PER_MIN), and a code found missing is read
 *     again when asked once 5 minutes have passed (SHARE_STORE_MISS_MS). How
 *     small they stay rests on each instance's memory of the records it read
 *     and on Blob's CDN answering repeats, neither a monthly bound: theirs to
 *     bound in share-store.ts, not these sums'.
 *   - N, THE INSTANCES SPENT TO THE BRIM EACH DAY, on average over the month.
 *     At this traffic Vercel keeps about one instance per function warm in the
 *     project's one region (Fluid compute, its default, serves concurrent
 *     requests from one instance), and a deploy, a cold start after idle or a
 *     burst brings a fresh one, with full budgets. Planned at N =
 *     WALLET_NAMES_PLANNED_INSTANCES = 2; a day of many deploys brings more, and
 *     the quota sees the month's average.
 *   - THE MONTH AT N = 2, everything spent by an abuser: writes 2 × (640 + 160)
 *     = 1,600 of 2,000; reads 2 × 960 = 1,920 of 10,000 for the names, plus the
 *     short links', which have no monthly bound (above). A flood of names alone
 *     reaches a quota only at N ≥ 10.4 (reads; 12.5 for writes), more than three
 *     times the N ≥ 3.125 at which the short links' own writes do.
 *   - SPENT, THE NAMES DEGRADE AND NOTHING ELSE DOES. A read past its budget is
 *     the copy, of any age — names a little stale rather than none; an account
 *     this instance holds no copy of is refused names_budget, and the browser
 *     shows the default names with no pencil. A save past its budget is refused
 *     names_budget, and from then until it refills that account's answers —
 *     everyone's, when it was this instance's budget — say `paused`: the pencil
 *     hides (components/wallets/wallet-names-context.tsx).
 *   - WHAT THESE NUMBERS DO NOT STOP (review, 10-23), written down so nobody
 *     relies on more. Reads: once an instance's reads are spent — by ordinary
 *     sign-ins after a deploy, or by free accounts made to spend them, each
 *     account it holds no copy of costing one — every further such account sees
 *     its default names until a read refills, one every 48 minutes; the names
 *     stay in the store, and a page load once a read is back shows them. Saves:
 *     two accounts, four saves and one, pause renaming on that instance for
 *     everyone, one save back every 4.8 hours. Both are the price of the month
 *     above, and raising either is the owner's call: at 100 reads a day the
 *     names alone would be 2 × 3,200 = 6,400 of the 10,000; the saves fit at
 *     most 11 a day beside the short links' 1,280 at N = 2 (2 × 32 × 11 = 704
 *     of the 720 left).
 *   - A save that changes nothing writes nothing.
 * These are counters in one instance's memory, as the short links' are: they
 * bound what each instance spends, not how many instances there are — which is
 * why N is an assumption, written down. On Pro, with a spend limit, they can
 * grow.
 *
 * NOTHING PERSONAL IN THE LOGS: no token, no user id, no address, no name — a
 * refusal logs its status and code, a store failure its kind (share-store.ts's,
 * as the short links log theirs).
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
import { ShareStoreError } from "@/lib/share-store";
import { WalletNamesConflict, walletNamesStoreOf, type StoredNames, type WalletNamesStore } from "@/lib/wallet-names-store";

/** The largest PUT body: an address and a 32-character name are under 300 bytes. */
export const WALLET_NAMES_MAX_BODY_BYTES = 1_024;
/** Requests one client (IPv4 address, IPv6 /64) may make a minute, reads and saves together. Its network gets CLIENT_AGGREGATE_FACTOR times as many. */
export const WALLET_NAMES_PER_CLIENT_PER_MIN = 30;
/**
 * How long this instance answers an account's names from its own copy before it reads the store again.
 * Fifteen minutes, not five, since the reads were cut to the month (10-23): the copy is stale only when
 * another instance saved for the account meanwhile — at this traffic one usually serves everyone — and a save
 * from a stale copy still erases nothing (its etag no longer matches).
 */
export const WALLET_NAMES_COPY_MS = 15 * 60_000;
/** Accounts whose copy this instance keeps, at most: the least recently used is dropped first. */
export const WALLET_NAMES_COPIES_MAX = 5_000;
/** Store reads one account may cause: this many at once, and this many a day after. A signed-in page reads once, and the copy answers most. */
export const WALLET_NAMES_READS_PER_USER = 6;
/** Store reads this instance makes a day, across everyone: 960 in a 31-day month at most, of the store's 10,000 (the header's sums). */
export const WALLET_NAMES_READS_PER_DAY = 30;
/**
 * Of those, the most a day may refresh a copy this instance already holds (review, 10-23): a third. A refresh
 * only makes a copy younger, and past this share the copy answers; a first read is the difference between an
 * account's names and the default ones, so at least the other 20 are kept for accounts with no copy here.
 */
export const WALLET_NAMES_REREADS_PER_DAY = 10;
/** Saves one account may make: this many at once, and this many a day after — three wallets named and a typo put right. */
export const WALLET_NAMES_WRITES_PER_USER = 4;
/** Saves this instance makes a day, across everyone: 160 in a 31-day month at most, of the store's 2,000 (the header's sums). */
export const WALLET_NAMES_WRITES_PER_DAY = 5;
/** N in the header's sums: the instances whose budgets a flood spends to the brim each day, on average over a month. */
export const WALLET_NAMES_PLANNED_INSTANCES = 2;
/** Accounts this instance remembers a refused save for, at most (the oldest forgotten first). */
const PAUSES_MAX = 5_000;

const DAY_MS = 24 * 60 * 60_000;
const PER_DAY = 1 / (24 * 60);
const GLOBAL = "global";
const FIELDS = ["address", "name"] as const;
const HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store" } as const;

/** What GET and a successful PUT answer. */
export interface WalletNamesAnswer {
  readonly names: Readonly<Record<string, string>>;
  /** Present, and true, while a save by this account would be refused for its budget or this instance's: no pencil. */
  readonly paused?: true;
}

export type WalletNamesErrorCode =
  | "names_off"
  | "unavailable"
  | "cross_site"
  | "unsupported_media_type"
  | "payload_too_large"
  | "bad_request"
  | "rate_limited"
  | "names_budget"
  | "too_many_names"
  | "names_unavailable"
  | Exclude<AccessCheck, { ok: true }>["code"];

export interface WalletNamesBudgets {
  readonly exact: WeightedLimiter;
  readonly aggregate: WeightedLimiter;
  readonly readsPerUser: WeightedLimiter;
  readonly readsGlobal: WeightedLimiter;
  /** The re-reads' share of readsGlobal: a re-read is charged to both. */
  readonly rereadsGlobal: WeightedLimiter;
  readonly writesPerUser: WeightedLimiter;
  readonly writesGlobal: WeightedLimiter;
  /** Until when (ms) a save is known to be refused: by account (its user id), or for everyone ("global"). Learnt from a refusal, since a bucket cannot be read without spending it. */
  readonly paused: Map<string, number>;
  /** Until when (ms) this instance's reads ("reads") or re-reads ("rereads") are known to be spent, learnt the same way: a read refused by either then charges its account nothing. */
  readonly readsSpent: Map<string, number>;
}

/** One account's names as this instance last read or saved them, and when (ms). */
interface HeldNames extends StoredNames {
  readonly at: number;
}

/** This instance's copies, by Privy user id, least recently used first. Memory only: never written anywhere. */
export type WalletNamesCopies = Map<string, HeldNames>;

const BUDGETS = Symbol.for("sip.web.wallet-names.budgets");
const COPIES = Symbol.for("sip.web.wallet-names.copies");

/** A bucket of `capacity` that refills `capacity` a day, remembered the day it takes to refill: one forgotten sooner would come back full. */
const daily = (capacity: number): WeightedLimiter => createWeightedLimiter({ capacity, refillPerMinute: capacity * PER_DAY, idleMs: DAY_MS });

/** A fresh set of the route's budgets, at their production sizes. Exported so a test can spend one. */
export function walletNamesBudgets(): WalletNamesBudgets {
  return {
    exact: createWeightedLimiter({ capacity: WALLET_NAMES_PER_CLIENT_PER_MIN }),
    aggregate: createWeightedLimiter({ capacity: CLIENT_AGGREGATE_FACTOR * WALLET_NAMES_PER_CLIENT_PER_MIN }),
    readsPerUser: daily(WALLET_NAMES_READS_PER_USER),
    readsGlobal: daily(WALLET_NAMES_READS_PER_DAY),
    rereadsGlobal: daily(WALLET_NAMES_REREADS_PER_DAY),
    writesPerUser: daily(WALLET_NAMES_WRITES_PER_USER),
    writesGlobal: daily(WALLET_NAMES_WRITES_PER_DAY),
    paused: new Map(),
    readsSpent: new Map(),
  };
}

/**
 * Held on globalThis like the share route's, so every bundle of this route
 * shares one set, and one set of copies.
 */
function defaultBudgets(): WalletNamesBudgets {
  const holder = globalThis as unknown as Record<symbol, WalletNamesBudgets | undefined>;
  return (holder[BUDGETS] ??= walletNamesBudgets());
}

function defaultCopies(): WalletNamesCopies {
  const holder = globalThis as unknown as Record<symbol, WalletNamesCopies | undefined>;
  return (holder[COPIES] ??= new Map());
}

export interface WalletNamesRouteOptions {
  /** Read at each request. Default: process.env. */
  readonly env?: Env;
  /** Default: the Vercel Blob store, when the environment has one (walletNamesStoreOf). Whether names are on is the environment's say either way. */
  readonly store?: WalletNamesStore;
  /** Privy's keys. Default: its published set for the app id in the environment. Tests pass a local set. */
  readonly keys?: JWTVerifyGetKey;
  readonly budgets?: Partial<WalletNamesBudgets>;
  /** Default: this instance's, on globalThis. Tests pass their own. */
  readonly copies?: WalletNamesCopies;
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

/** A store call that failed: its kind, or else its class — never its message (it can carry the store's id) and never whose names. */
function logStoreFailure(error: unknown): void {
  const kind = error instanceof ShareStoreError ? error.kind : error instanceof Error ? error.constructor.name : typeof error;
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
  const budgets = (): WalletNamesBudgets => ({ ...defaultBudgets(), ...options.budgets });
  const copies = (): WalletNamesCopies => options.copies ?? defaultCopies();

  const remember = (userId: string, stored: StoredNames): void => {
    const held = copies();
    held.delete(userId);
    held.set(userId, { names: stored.names, etag: stored.etag, at: now() });
    for (const oldest of held.keys()) {
      if (held.size <= WALLET_NAMES_COPIES_MAX) break;
      held.delete(oldest);
    }
  };

  const refuse = (status: number, code: WalletNamesErrorCode, message: string, more: Record<string, unknown> = {}, extra: Record<string, string> = {}): Response => {
    onRefusal({ status, code });
    return json(status, { error: { code, message, ...more } }, extra);
  };
  const limited = (waitMs: number, what: string, code: "rate_limited" | "names_budget" = "rate_limited"): Response => {
    const seconds = retryAfterSeconds(waitMs);
    return refuse(429, code, `${what} Retry in ${seconds} s.`, { retryAfterSeconds: seconds }, { "retry-after": String(seconds) });
  };
  /** A save refused for a day's budget — the account's (`key` its id) or everyone's — remembered until it refills, so every answer meanwhile says `paused`. */
  const spent = (held: WalletNamesBudgets, key: string, waitMs: number, what: string): Response => {
    held.paused.delete(key);
    held.paused.set(key, now() + waitMs);
    for (const oldest of held.paused.keys()) {
      if (held.paused.size <= PAUSES_MAX) break;
      held.paused.delete(oldest);
    }
    return limited(waitMs, what, "names_budget");
  };
  /** The names, as GET and a successful PUT answer them: `paused` while this account's save would be refused. */
  const answer = (names: Readonly<Record<string, string>>, userId: string, held: WalletNamesBudgets): Response => {
    const at = now();
    const paused = (held.paused.get(GLOBAL) ?? 0) > at || (held.paused.get(userId) ?? 0) > at;
    return json(200, (paused ? { names, paused: true } : { names }) satisfies WalletNamesAnswer);
  };

  /**
   * EVERY REQUEST, IN THIS ORDER: off before anything, the gate, cross-site, the
   * client's buckets, then who it is. A client already refused is not verified,
   * so a flood of junk tokens costs no key-set fetch.
   */
  async function admit(
    request: Request,
  ): Promise<{ readonly ok: true; readonly userId: string; readonly budgets: WalletNamesBudgets; readonly store: WalletNamesStore } | { readonly ok: false; readonly response: Response }> {
    const settings = env();
    // The short links' rule, read per request (wallet-names-store.ts): no store, no names — before anything else.
    const configured = walletNamesStoreOf(settings);
    if (configured === null) {
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
    return { ok: true, userId: access.userId, budgets: held, store: options.store ?? configured };
  }

  const unavailable = (error: unknown): Response => {
    logStoreFailure(error);
    return refuse(503, "names_unavailable", "Your wallet names could not be reached just now.");
  };

  /**
   * ONE STORE READ, CHARGED — or how long until it could be, and whose budget
   * says so. A share of this instance's known to be spent refuses it before
   * anything is charged; then the account's bucket, then the re-reads' share
   * (a `reread` only), then the instance's: narrowest first, so a refusal by a
   * wider one has spent only narrower tokens, and is remembered (readsSpent).
   */
  const chargeRead = (held: WalletNamesBudgets, userId: string, reread: boolean, at: number): { readonly waitMs: number; readonly account: boolean } | null => {
    const shares: readonly (readonly [string, WeightedLimiter])[] = reread
      ? [
          ["rereads", held.rereadsGlobal],
          ["reads", held.readsGlobal],
        ]
      : [["reads", held.readsGlobal]];
    for (const [share] of shares) {
      const until = held.readsSpent.get(share) ?? 0;
      if (until > at) return { waitMs: until - at, account: false };
    }
    const mine = held.readsPerUser.take(userId, 1, at);
    if (mine > 0) return { waitMs: mine, account: true };
    for (const [share, bucket] of shares) {
      const wait = bucket.take(GLOBAL, 1, at);
      if (wait > 0) {
        held.readsSpent.set(share, at + wait);
        return { waitMs: wait, account: false };
      }
    }
    return null;
  };

  /**
   * AN ACCOUNT'S NAMES FOR ONE REQUEST. "copy": this instance's copy while it is
   * young, the store otherwise. "store": the store, whatever the copy's age. A
   * store read is charged as chargeRead says — a re-read when this instance
   * holds a copy; with a budget spent, a copy of any age answers (`fromCopy`),
   * and only an account with no copy here is refused. A store failure throws,
   * and leaves the copy as it was.
   */
  const namesOf = async (userId: string, held: WalletNamesBudgets, store: WalletNamesStore, mode: "copy" | "store"): Promise<{ readonly stored: StoredNames; readonly fromCopy: boolean } | Response> => {
    const copy = copies().get(userId) ?? null;
    const at = now();
    if (mode === "copy" && copy !== null && at - copy.at < WALLET_NAMES_COPY_MS) return { stored: copy, fromCopy: true };
    const refused = chargeRead(held, userId, copy !== null, at);
    if (refused !== null) {
      if (copy !== null) return { stored: copy, fromCopy: true };
      return limited(refused.waitMs, refused.account ? "This account's wallet names were read as often as they may be today." : "Wallet names are paused for now.", "names_budget");
    }
    const stored = await store.read(userId);
    remember(userId, stored);
    return { stored, fromCopy: false };
  };

  return {
    async GET(request) {
      const admitted = await admit(request);
      if (!admitted.ok) return admitted.response;
      try {
        const had = await namesOf(admitted.userId, admitted.budgets, admitted.store, "copy");
        if (had instanceof Response) return had;
        return answer(had.stored.names, admitted.userId, admitted.budgets);
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

      const { userId, budgets: held, store } = admitted;
      /**
       * The names, the edit, one save — or the answer that no save is needed. "confirm": the copy
       * says the name is already this, and a copy can be older than another instance's save, so
       * the store is asked before anything is answered.
       */
      const attempt = async (mode: "copy" | "store"): Promise<Response | "conflict" | "confirm"> => {
        const had = await namesOf(userId, held, store, mode);
        if (had instanceof Response) return had;
        const read = had.stored;
        const current = read.names[address] ?? null;
        if (current === cleaned.name) return had.fromCopy && mode === "copy" ? "confirm" : answer(read.names, userId, held);
        if (current === null && cleaned.name !== null && Object.keys(read.names).length >= WALLET_NAMES_MAX) {
          return refuse(409, "too_many_names", `An account keeps at most ${WALLET_NAMES_MAX} wallet names.`);
        }
        // Charged for a save that will be made: the account first, then everyone's. Only the save that finds
        // everyone's spent has paid its account's token for nothing; until it refills (`paused`), a save is
        // refused before either is charged.
        const at = now();
        const everyoneUntil = held.paused.get(GLOBAL) ?? 0;
        if (everyoneUntil > at) return limited(everyoneUntil - at, "Renaming wallets is paused for now.", "names_budget");
        const mine = held.writesPerUser.take(userId, 1, at);
        if (mine > 0) return spent(held, userId, mine, "This account has renamed its wallets as often as it may today.");
        const everyone = held.writesGlobal.take(GLOBAL, 1, at);
        if (everyone > 0) return spent(held, GLOBAL, everyone, "Renaming wallets is paused for now.");
        const next = withName(read.names, address, cleaned.name);
        try {
          remember(userId, { names: next, etag: await store.write(userId, next, read.etag) });
        } catch (error) {
          // Moved, or perhaps saved before it failed: either way the copy no longer says what the store holds.
          copies().delete(userId);
          if (error instanceof WalletNamesConflict) return "conflict";
          throw error;
        }
        return answer(next, userId, held);
      };

      try {
        let outcome = await attempt("copy");
        if (outcome === "confirm") outcome = await attempt("store");
        // Another device saved in between: read what it saved, and apply this change over it — once.
        if (outcome === "conflict") outcome = await attempt("store");
        return outcome === "conflict" || outcome === "confirm" ? unavailable(new WalletNamesConflict()) : outcome;
      } catch (error) {
        return unavailable(error);
      }
    },
  };
}
