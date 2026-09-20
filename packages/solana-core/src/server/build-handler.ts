// /api/solana-build and /api/solana-vault as injectable Fetch handlers.
//
// WHY TWO NEW ROUTES, NOT ACTIONS ON /api/solana-tx. That route is a tested,
// send-only contract, and its process-wide budget is spent only by transactions
// that verified; unsigned builds and chain reads would muddy both. It stays the
// only way onto the chain, and handlers.ts is not touched: the few helpers
// below that mirror its private ones are copied, not shared, for that reason.
//
// WHY THE SERVER BUILDS. The builders are pinned byte for byte to Anchor's coder
// and check a link consent with node:crypto before compiling, and every build
// needs reads the browser relay refuses. Building here leaves the relay's
// allowlist as it is and keeps one pinned copy of every account list.
//
// NOTHING HERE IS AUTHORITY. Both routes are unauthenticated on purpose: they
// read public chain state and return unsigned bytes. The owner's signature is
// the authorization; the browser checks the bytes against what the person asked
// for before anyone signs; /api/solana-tx verifies and simulates what comes back.
// No key, no signing, no blockhash from the client, no new setting.
//
// ORDER: settings gate (503) → cross-site (403) → application/json (415) → a
// weighted take from the client's bucket, then its network's (429, before the
// body is read) → body ≤ 2048 bytes (413) → exact fields per action (400) →
// refusals that need no chain (400, 422) → the rest of the action's read weight
// from the client's buckets, then all of it from the reads budget both routes
// share (429) → chain reads and their refusals (409, 502) → getLatestBlockhash
// (confirmed) → the builder → 200. A malformed request costs its sender's own
// buckets and no RPC quota.
//
// THE RATIO HOLDS HERE TOO (config.ts). A client's buckets are charged at least
// the upstream calls its request makes, so one address spends at most
// relay.perClientPerMin read tokens a minute: 60 of 1,800, thirty addresses
// deep. /api/solana-build and /api/solana-vault draw on ONE reads budget per
// process (sharedBuildReadsBudget), counted in config.ts's upstream sizing.
//
// THE WIRE. Bigints travel as decimal strings, both ways. Refusals are
// {error:{code, message, ...}}, the shape /api/solana-tx answers with. No upstream
// text is ever returned: a read that failed is "unreadable", with no detail.

import { RAYDIUM_CLMM, TOKEN_PROGRAM, USDC_MINT, WSOL_MINT } from "../client/addresses";
import { classifyVaultEntry } from "../client/activity";
import { isPubkey, isSignature } from "../client/base58";
import { tryBase64Decode } from "../client/base64";
import { PoolPriceError, floorWad, usdcRawPer1e8LegRaw, usdcRawPerSol } from "../client/clmm-price";
import { SIP_ACCOUNT_SPACE } from "../client/decoders";
import { SIP_PROGRAM_ID } from "../client/idl";
import type { PythPriceUpdate } from "../client/pyth-price";
import {
  BUNDLED_VAULT_TOKEN_ACCOUNT_CREATES,
  CLASSIC_TOKEN_ACCOUNT_BYTES,
  CONVERT_FLOOR_MARGIN_BPS,
  DEFAULT_INVEST_CAPS,
  DEFAULT_VAULT_POLICY,
  LEG_FLOOR_MARGIN_BPS,
  OFFERED_LEGS,
  SIGNATURE_FEE_LAMPORTS,
  VOLUME_MODE_OFFERED,
  basketWeightsBps,
  ownerComputeBudget,
  priorityFeeLamports,
  type ComputeBudget,
} from "../client/product";
import {
  LEG_WEIGHT_TOTAL_BPS,
  MODE_PROFIT,
  MODE_VOLUME,
  U64_MAX,
  defaultInvestPolicy,
  investPolicyProblems,
  vaultPolicyProblems,
  type InvestPolicyInput,
  type VaultPolicyInput,
} from "../client/rules";
import {
  BuildError,
  LinkConsentError,
  WalletIsOwnerError,
  buildCreateVaultV2,
  buildLinkWallet,
  buildSetInvestPolicy,
  buildSetPolicyV2,
  buildWithdraw,
  buildWithdrawToken,
  checkLinkConsent,
  prepareLinkWalletConsent,
} from "./builders";
import type { SolanaServerSettings } from "./config";
import { isCrossSite, isJsonContentType, readBodyCapped, type SolanaGate, type SolanaRouteHandler } from "./handlers";
import { deriveAta, deriveVaultPda } from "./pda";
import { CLIENT_AGGREGATE_FACTOR, clientIdentityFromHeaders, createWeightedLimiter, retryAfterSeconds, type WeightedLimiter } from "./rate-limit";
import {
  MAX_WALLET_LINKS,
  PRICED_POOLS,
  listVaultHoldings,
  listVaultSignatures,
  readLiveSnapshot,
  readVaultTransactions,
  poolPricesFromAccounts,
  readBlockhashAndRents,
  readBuildBatch,
  readLinkPrerequisites,
  readOwnerAccounts,
  readPoolPrices,
  readRents,
  readVault,
  readVaultTokenAccounts,
  readWalletLinks,
  readWithdrawTokenSource,
  tokenAccountStatus,
  vaultTokenAccountTargets,
  type AccountSnapshot,
  type ChainRead,
  type PoolPrices,
  type PythRead,
} from "./readers";
import { createRpcPool, type RpcPool } from "./rpc-pool";

export type SolanaBuildErrorCode =
  | "unavailable"
  | "method_not_allowed"
  | "cross_site"
  | "unsupported_media_type"
  | "rate_limited"
  | "payload_too_large"
  | "bad_request"
  /** mode 1 while the web does not offer VOLUME. */
  | "volume_not_offered"
  /** The rule is not one validate_policy accepts; `problems` says why. */
  | "invalid_policy"
  | "wallet_is_owner"
  | "vault_exists"
  | "vault_missing"
  /** The protocol config does not exist yet: link_wallet cannot pass. */
  | "config_missing"
  | "protocol_paused"
  /** ["link", wallet] exists; `vault` names the vault it saves into. */
  | "wallet_already_linked"
  /** The consent signature is not the trading wallet's over this link's SIP_LINK_V1 bytes. */
  | "link_consent_invalid"
  /** A withdrawal of nothing. */
  | "zero_amount"
  /** More SOL than the vault can release above its rent floor; `withdrawableLamports` says how much it can. */
  | "above_withdrawable"
  /** The account a token withdrawal names holds none of this mint for this vault: gone, not a token account, another vault's, another mint, or empty. */
  | "not_held"
  /** More of this mint than the vault holds; `heldRaw` says how much it does. */
  | "above_holding"
  /** A pinned pool could not be priced (missing, not Raydium CLMM's, mints swapped): no floor is guessed. */
  | "price_unavailable"
  /** A mint the policy names is not held by the token program SIP expects; `mint` names it. */
  | "mint_unexpected"
  /** pauseInvesting: the vault has no investment policy to pause. */
  | "policy_missing"
  /** pauseInvesting: the stored policy is already paused. */
  | "already_paused"
  /** A chain read failed or answered something that is not ours: nothing was offered. */
  | "unreadable"
  /** The blockhash could not be read: nothing was built. */
  | "upstream_unavailable"
  | "internal_error";

export interface BuildRefusalEvent {
  readonly route: "solana-build" | "solana-vault" | "solana-live";
  readonly status: number;
  readonly code: string;
  readonly action: string | null;
}

export interface SolanaBuildHandlerOptions {
  readonly gate: () => SolanaGate;
  /** Per client (IPv4 address, IPv6 /64), weighted. Default: capacity settings.relay.perClientPerMin. */
  readonly limiter?: WeightedLimiter;
  /** Per client network (IPv4 /24, IPv6 /48), weighted. Default: capacity CLIENT_AGGREGATE_FACTOR × settings.relay.perClientPerMin. */
  readonly aggregateLimiter?: WeightedLimiter;
  /** Process-wide, keyed "global", in upstream JSON-RPC calls. Default: the one budget both routes share, sharedBuildReadsBudget(settings.relay.readsGlobalPerMin). */
  readonly readsBudget?: WeightedLimiter;
  /** Default: createRpcPool(settings.rpcEndpoints, {fetch, redactor: settings.redactor}). */
  readonly pool?: RpcPool;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  /** Default: one console.warn line per second per route, carrying route, status, code and action only. */
  readonly onRefusal?: (event: BuildRefusalEvent) => void;
  /** Whether mode 1 (VOLUME) is built. Default VOLUME_MODE_OFFERED. */
  readonly volumeOffered?: boolean;
}

export type SolanaVaultHandlerOptions = Omit<SolanaBuildHandlerOptions, "volumeOffered">;

/** The largest build or state body: a link with its consent signature is under 300 bytes. */
export const MAX_BUILD_REQUEST_BYTES = 2048;
/** What one build or state request takes from its client's buckets, before its body is read. */
export const BUILD_REQUEST_WEIGHT = 3;
/**
 * Upstream JSON-RPC calls each action may make. Before the first one, the
 * client's buckets are charged what this weight exceeds BUILD_REQUEST_WEIGHT by,
 * so a request costs its client at least the calls it makes; then the shared
 * reads budget is charged all of it.
 *
 * investPolicy is EIGHT, not the seven it was while the basket had one leg:
 * readOwnerAccounts 2 (the accounts, and the vault's rent), then readBuildBatch 6
 * — the blockhash, the accounts, and ONE RENT PER DISTINCT SIZE, which the three
 * legs made four: InvestmentPolicy 970, the classic 165, SPYx's 179 and 191 for
 * each PreStocks account. A weight under the calls made is an under-charge in
 * the rate limiter, so the next leg with a new account size moves this again;
 * handlers-build.test.ts pins it against what the route really spends.
 *
 * setPolicy is THREE: readVault 2 (the account and the rent floor its
 * withdrawable is measured against) + readBuildBatch 1 (the blockhash). It asks
 * for no rent of its own — set_policy_v2 opens no account — so it costs what
 * withdraw costs, and the same test pins it.
 */
export const BUILD_READS_WEIGHT = { createVault: 4, setPolicy: 3, prepareLink: 1, link: 3, investPolicy: 8, pauseInvesting: 3, withdraw: 3, withdrawToken: 4, state: 12 } as const;

/**
 * Upstream JSON-RPC calls /api/solana-live's actions make. A snapshot is one
 * batch of four members, five when it also lists the vault's links; an activity
 * page is one getSignaturesForAddress, and then one getTransaction per signature
 * charged separately (spendMore) once their number is known.
 *
 * Pyth costs nothing here. Its two feeds and the chain's clock ride at the tail
 * of a getMultipleAccounts that was already being sent, so the oracle added
 * addresses to a member rather than a member to the batch, and the dashboard's
 * upstream cost is what it was.
 */
export const LIVE_READS_WEIGHT = { snapshot: 4, snapshotDiscover: 5, signatures: 1 } as const;

/**
 * Signatures one activity page reads. Smaller than MAX_ACTIVITY_PAGE: the page
 * is charged a token per transaction, and a dashboard polling every minute must
 * stay well inside one client's 60.
 */
export const MAX_LIVE_ACTIVITY_PAGE = 15;

const SHARED_READS_BUDGETS = Symbol.for("@sip/solana-core/build-handler/reads-budgets");

/**
 * The reads budget /api/solana-build and /api/solana-vault share in this process,
 * one per capacity. It is held on globalThis, so the two route bundles reach the
 * same buckets however the server bundled them; each process (each Vercel
 * instance) still has its own.
 */
export function sharedBuildReadsBudget(capacity: number): WeightedLimiter {
  const holder = globalThis as unknown as Record<symbol, Map<number, WeightedLimiter> | undefined>;
  const budgets = (holder[SHARED_READS_BUDGETS] ??= new Map<number, WeightedLimiter>());
  let budget = budgets.get(capacity);
  if (budget === undefined) {
    budget = createWeightedLimiter({ capacity });
    budgets.set(capacity, budget);
  }
  return budget;
}

/** Above this max_per_call, convert is no longer held to its tightest program bound, 1 SOL per call (convert.rs compares lamports with max(max_per_call, 1e9)). */
export const CONVERT_TIGHTEST_MAX_PER_CALL = 1_000_000_000n;

const GLOBAL = "global";
const HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store" } as const;

const bigintSafe = (_key: string, value: unknown): unknown => (typeof value === "bigint" ? value.toString() : value);

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, bigintSafe), { status, headers: { ...HEADERS, ...extra } });
}

function parseObject(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function sampledWarn(): (event: BuildRefusalEvent) => void {
  const last = new Map<string, number>();
  return (event) => {
    const at = Date.now();
    if (at - (last.get(event.route) ?? 0) < 1_000) return;
    last.set(event.route, at);
    console.warn(JSON.stringify({ event: "solana.refusal", ...event }));
  };
}

/** Rebuilds per-process state only when the settings' limits or endpoints change, as handlers.ts does. */
function memoBySettings<T>(build: (settings: SolanaServerSettings) => T): (settings: SolanaServerSettings) => T {
  let key: string | null = null;
  let value: T | null = null;
  return (settings) => {
    const next = JSON.stringify([
      settings.relay,
      settings.trustedClientIpHeader,
      settings.rpcEndpoints.length,
      // Compared, never stored anywhere that serializes: this closure is the only holder.
      settings.rpcEndpoints.map((endpoint) => endpoint.reveal()),
    ]);
    if (key !== next || value === null) {
      key = next;
      value = build(settings);
    }
    return value;
  };
}

interface Served {
  readonly pool: RpcPool;
  readonly volumeOffered: boolean;
  refuse(status: number, code: SolanaBuildErrorCode, message: string, more?: Record<string, unknown>): Response;
  /** Takes `weight` from the process-wide reads budget: null when taken, otherwise the 429 to answer. */
  spendReads(weight: number): Response | null;
  /**
   * Takes `calls` MORE tokens, in full, from the client's own bucket, then its
   * network's, then the shared reads budget. For a read whose size is only known
   * after an earlier one answered (a page of N transactions): charging before the
   * batch means a client out of tokens is refused with no upstream call wasted.
   */
  spendMore(calls: number): Response | null;
}

type Dispatch = (action: string, fields: Readonly<Record<string, unknown>>, served: Served) => Promise<Response>;

function createRoute(route: BuildRefusalEvent["route"], options: SolanaBuildHandlerOptions, dispatch: Dispatch): SolanaRouteHandler {
  const now = options.now ?? Date.now;
  const onRefusal = options.onRefusal ?? sampledWarn();
  const volumeOffered = options.volumeOffered ?? VOLUME_MODE_OFFERED;
  const state = memoBySettings((settings) => ({
    exact: options.limiter ?? createWeightedLimiter({ capacity: settings.relay.perClientPerMin }),
    aggregate: options.aggregateLimiter ?? createWeightedLimiter({ capacity: CLIENT_AGGREGATE_FACTOR * settings.relay.perClientPerMin }),
    reads: options.readsBudget ?? sharedBuildReadsBudget(settings.relay.readsGlobalPerMin),
    pool: options.pool ?? createRpcPool(settings.rpcEndpoints, { fetch: options.fetch, redactor: settings.redactor }),
  }));

  return {
    async POST(request: Request): Promise<Response> {
      const gate = options.gate();
      if (gate.kind === "invalid") return json(503, { error: { code: "unavailable", message: "Solana is not available on this deployment." } });

      let action: string | null = null;
      const refuse = (status: number, code: SolanaBuildErrorCode, message: string, more: Record<string, unknown> = {}, extra: Record<string, string> = {}): Response => {
        onRefusal({ route, status, code, action });
        return json(status, { error: { code, message, ...more } }, extra);
      };
      const limited = (waitMs: number, what: string): Response => {
        const seconds = retryAfterSeconds(waitMs);
        return refuse(429, "rate_limited", `${what} Retry in ${seconds} s.`, { retryAfterSeconds: seconds }, { "retry-after": String(seconds) });
      };

      if (isCrossSite(request)) return refuse(403, "cross_site", "Cross-site requests are refused.");
      if (!isJsonContentType(request)) return refuse(415, "unsupported_media_type", "Content-Type must be application/json.");

      const settings = gate.settings;
      const { exact, aggregate, reads, pool } = state(settings);
      const identity = clientIdentityFromHeaders(request.headers, settings.trustedClientIpHeader);
      const at = now();
      // The client's own bucket first: a client already refused spends nothing of its neighbours'.
      const ownWait = exact.take(identity.exact, BUILD_REQUEST_WEIGHT, at);
      const clientWait = ownWait > 0 ? ownWait : aggregate.take(identity.aggregate, BUILD_REQUEST_WEIGHT, at);
      if (clientWait > 0) return limited(clientWait, "Too many requests from this client.");

      const body = await readBodyCapped(request, MAX_BUILD_REQUEST_BYTES);
      if (!body.ok) {
        return body.reason === "too_large"
          ? refuse(413, "payload_too_large", `Request body exceeds ${MAX_BUILD_REQUEST_BYTES} bytes.`)
          : refuse(400, "bad_request", "The request body could not be read.");
      }
      const fields = parseObject(body.bytes);
      if (fields === null) return refuse(400, "bad_request", "The body must be a JSON object.");
      if (typeof fields.action !== "string") return refuse(400, "bad_request", "The body needs an action.");
      action = fields.action.slice(0, 40);

      const served: Served = {
        pool,
        volumeOffered,
        refuse: (status, code, message, more) => refuse(status, code, message, more),
        spendReads: (weight) => {
          const readsAt = now();
          // The client first, for every call past what it already paid: its own bucket, then its network's.
          const rest = weight - BUILD_REQUEST_WEIGHT;
          if (rest > 0) {
            const own = exact.take(identity.exact, rest, readsAt);
            const client = own > 0 ? own : aggregate.take(identity.aggregate, rest, readsAt);
            if (client > 0) return limited(client, "Too many requests from this client.");
          }
          const wait = reads.take(GLOBAL, weight, readsAt);
          return wait > 0 ? limited(wait, "SaverFi is reading Solana for many people right now.") : null;
        },
        spendMore: (calls) => {
          if (!(calls > 0)) return null;
          const moreAt = now();
          const own = exact.take(identity.exact, calls, moreAt);
          const client = own > 0 ? own : aggregate.take(identity.aggregate, calls, moreAt);
          if (client > 0) return limited(client, "Too many requests from this client.");
          const wait = reads.take(GLOBAL, calls, moreAt);
          return wait > 0 ? limited(wait, "SaverFi is reading Solana for many people right now.") : null;
        },
      };
      try {
        return await dispatch(fields.action, fields, served);
      } catch {
        // A reader or builder bug, never a person's mistake: no detail leaves.
        return refuse(500, "internal_error", "SaverFi could not prepare this. Nothing was built.");
      }
    },

    GET(): Response {
      return json(405, { error: { code: "method_not_allowed", message: "This endpoint accepts POST only." } }, { allow: "POST" });
    },
  };
}

// ── field checks ─────────────────────────────────────────────────────────────

function unexpectedField(fields: Readonly<Record<string, unknown>>, allowed: readonly string[]): string | null {
  const extra = Object.keys(fields).find((name) => !allowed.includes(name));
  return extra === undefined ? null : `Unexpected field ${extra.slice(0, 40)}.`;
}

const U64_TEXT = /^(0|[1-9][0-9]{0,19})$/;

/** A u64 written as a decimal string, or null. */
function decimalU64(value: unknown): bigint | null {
  if (typeof value !== "string" || !U64_TEXT.test(value)) return null;
  const parsed = BigInt(value);
  return parsed <= U64_MAX ? parsed : null;
}

/**
 * THE VENUES A POLICY MAY NAME, BY NAME, AND THE ONLY PLACE A NAME BECOMES A
 * PROGRAM. venue_program is the program the vault's invest instruction is told
 * to CPI into, so a request that could put an arbitrary base58 key there would
 * be asking the vault to trust a program nobody vetted. The browser therefore
 * names a venue and this table translates it; a key, even a well-formed one,
 * even Raydium's own, is not a name and is refused.
 *
 * A Map, not an object: `{}["constructor"]` is a function, and a lookup table
 * reached from request text must not answer for a key it does not hold.
 *
 * One entry today. Raydium CLMM is the only venue the keeper can route through
 * (client/clmm-price.ts prices its pools, and PRICED_POOLS pins them), so the
 * list is one long on purpose, not by omission.
 */
const VENUE_PROGRAMS = new Map<string, string>([["raydium-clmm", RAYDIUM_CLMM]]);

/** The venue names investPolicy accepts. What the panel offers; the programs behind them never leave the server. */
export const OFFERED_VENUES: readonly string[] = Object.freeze([...VENUE_PROGRAMS.keys()]);

/** The venue a request that names none is built with: today's behaviour, unchanged. */
const DEFAULT_VENUE = "raydium-clmm";

/** The vault modes setPolicy accepts, by name. createVault's numeric `mode` is untouched. */
const VAULT_MODES = new Map<string, number>([
  ["profit", MODE_PROFIT],
  ["volume", MODE_VOLUME],
]);

const unreadable = (served: Served): Response => served.refuse(502, "unreadable", "SaverFi could not read Solana just now. Nothing was built.");
const upstreamUnavailable = (served: Served): Response => served.refuse(502, "upstream_unavailable", "Solana did not answer with a recent blockhash. Nothing was built.");

function costs(rentLamports: bigint, signatures: number, budget: ComputeBudget): Record<string, bigint> {
  return { rentLamports, signatureFeeLamports: SIGNATURE_FEE_LAMPORTS * BigInt(signatures), priorityFeeLamports: priorityFeeLamports(budget) };
}

// ── /api/solana-build ────────────────────────────────────────────────────────

const CREATE_VAULT_FIELDS = ["action", "owner", "mode", "maxContribution", "walletReserve", "skimBps", "volumeBps"] as const;

async function createVault(fields: Readonly<Record<string, unknown>>, served: Served): Promise<Response> {
  const extra = unexpectedField(fields, CREATE_VAULT_FIELDS);
  if (extra !== null) return served.refuse(400, "bad_request", extra);
  const owner = fields.owner;
  if (!isPubkey(owner)) return served.refuse(400, "bad_request", "owner must be a base58 32-byte public key.");
  const mode = fields.mode;
  if (mode !== MODE_PROFIT && mode !== MODE_VOLUME) return served.refuse(400, "bad_request", "mode must be 0 (profit) or 1 (volume).");
  const maxContribution = fields.maxContribution === undefined ? DEFAULT_VAULT_POLICY.maxContribution : decimalU64(fields.maxContribution);
  const walletReserve = fields.walletReserve === undefined ? DEFAULT_VAULT_POLICY.walletReserve : decimalU64(fields.walletReserve);
  if (maxContribution === null || walletReserve === null) {
    return served.refuse(400, "bad_request", "maxContribution and walletReserve are lamports, written as decimal strings.");
  }
  for (const name of ["skimBps", "volumeBps"] as const) {
    if (fields[name] !== undefined && !Number.isInteger(fields[name])) return served.refuse(400, "bad_request", `${name} must be an integer number of basis points.`);
  }
  if (mode === MODE_VOLUME && !served.volumeOffered) return served.refuse(400, "volume_not_offered", "Volume mode is not offered yet.");
  const policy: VaultPolicyInput = {
    mode,
    skimBps: (fields.skimBps as number | undefined) ?? DEFAULT_VAULT_POLICY.skimBps,
    volumeBps: (fields.volumeBps as number | undefined) ?? DEFAULT_VAULT_POLICY.volumeBps,
    maxContribution,
    walletReserve,
  };
  const problems = vaultPolicyProblems(policy);
  if (problems.length > 0) return served.refuse(400, "invalid_policy", "The program would refuse this vault rule.", { problems });

  const spent = served.spendReads(BUILD_READS_WEIGHT.createVault);
  if (spent !== null) return spent;
  const accounts = await readOwnerAccounts(served.pool, owner);
  // A failed read never offers create: the vault may exist.
  if (accounts.vault.kind === "unreadable") return unreadable(served);
  if (accounts.vault.kind === "exists") {
    const stored = accounts.vault.value.state;
    return served.refuse(409, "vault_exists", "This pension key already has a vault.", {
      vault: accounts.vaultAddress,
      rule: { mode: stored.skimMode, skimBps: stored.skimBps, volumeBps: stored.volumeBps, maxContribution: stored.maxContribution, walletReserve: stored.walletReserve },
    });
  }

  const chain = await readBlockhashAndRents(served.pool, [SIP_ACCOUNT_SPACE.Vault]);
  if (chain.kind !== "exists") return upstreamUnavailable(served);
  const computeBudget = ownerComputeBudget("create_vault_v2");
  let built;
  try {
    built = buildCreateVaultV2({ owner, ...policy, ...chain.value.recent, computeBudget });
  } catch (error) {
    if (error instanceof BuildError) return served.refuse(400, "invalid_policy", "The program would refuse this vault rule.", { problems: error.problems });
    throw error;
  }
  return json(200, { ...built, costs: costs(chain.value.rents[0]!, 1, computeBudget) });
}

const SET_POLICY_FIELDS = ["action", "owner", "mode", "skimBps", "volumeBps", "paused", "maxContribution", "walletReserve"] as const;

/**
 * The sentence the panel must show before the owner signs a setPolicy, and the
 * one thing that separates it from an investPolicy change.
 *
 * VERIFIED IN THE PROGRAM, NOT ASSUMED. set_policy.rs's handler ends with
 * `vault.policy_nonce = vault.policy_nonce.checked_add(1)` — on every call, even
 * one that changes nothing — and settle.rs builds the message it verifies with
 * `policy_nonce: vault.policy_nonce`, so an attestation the attester signed
 * against the old nonce is a different byte string after this lands and can no
 * longer verify. set_invest_policy.rs bumps `policy.policy_nonce`, a counter on
 * the InvestmentPolicy account that the attestation does not carry, and never
 * touches the vault's: changing the basket strands nothing.
 */
const POLICY_NONCE_NOTICE =
  "Signing this moves your vault's policy nonce, and every settlement your trading wallets already have in flight stops being valid: the keeper has to sign them again against the new rule, so a saving in progress may be delayed. Changing what your basket buys does not do this.";

/**
 * setPolicy: set_policy_v2, the vault's OWN rule — its mode, both rates, whether
 * it is paused, the per-settlement cap and the reserve a trading wallet keeps.
 * Until now the cap could only be chosen when the vault was created.
 *
 * EVERY FIELD IS REQUIRED, and this is the one action where that is the kind
 * thing to do. set_policy_v2 writes all six, so a field left out of the request
 * cannot mean "leave it alone" — it would mean "overwrite it with whatever the
 * server guessed". The stored rule comes back in the answer so the panel can
 * show what each one is changing from.
 */
async function setPolicy(fields: Readonly<Record<string, unknown>>, served: Served): Promise<Response> {
  const extra = unexpectedField(fields, SET_POLICY_FIELDS);
  if (extra !== null) return served.refuse(400, "bad_request", extra);
  const owner = fields.owner;
  if (!isPubkey(owner)) return served.refuse(400, "bad_request", "owner must be a base58 32-byte public key.");
  const mode = typeof fields.mode === "string" ? VAULT_MODES.get(fields.mode) : undefined;
  if (mode === undefined) return served.refuse(400, "bad_request", `mode must be ${[...VAULT_MODES.keys()].join(" or ")}.`);
  for (const name of ["skimBps", "volumeBps"] as const) {
    if (!Number.isInteger(fields[name])) return served.refuse(400, "bad_request", `${name} must be an integer number of basis points.`);
  }
  if (typeof fields.paused !== "boolean") return served.refuse(400, "bad_request", "paused must be true or false.");
  const maxContribution = decimalU64(fields.maxContribution);
  const walletReserve = decimalU64(fields.walletReserve);
  if (maxContribution === null || walletReserve === null) {
    return served.refuse(400, "bad_request", "maxContribution and walletReserve are lamports, written as decimal strings. set_policy_v2 writes every field, so both must be named.");
  }
  if (mode === MODE_VOLUME && !served.volumeOffered) return served.refuse(400, "volume_not_offered", "Volume mode is not offered yet.");
  const policy: VaultPolicyInput = { mode, skimBps: fields.skimBps as number, volumeBps: fields.volumeBps as number, maxContribution, walletReserve };
  // The chain's own rule, through the one model of validate_policy there is.
  const problems = vaultPolicyProblems(policy);
  if (problems.length > 0) return served.refuse(400, "invalid_policy", "The program would refuse this vault rule.", { problems });

  const spent = served.spendReads(BUILD_READS_WEIGHT.setPolicy);
  if (spent !== null) return spent;
  const vault = await readVault(served.pool, deriveVaultPda(owner).toBase58());
  if (vault.kind === "unreadable") return unreadable(served);
  if (vault.kind === "missing") return served.refuse(409, "vault_missing", "Create your vault first.");
  const stored = vault.value.state;
  // checked_add in set_policy.rs: at u64 max the program refuses the whole call,
  // so nothing is offered and the answer never quotes a nonce that cannot exist.
  if (stored.policyNonce >= U64_MAX) {
    return served.refuse(409, "invalid_policy", "This vault's policy nonce cannot move again. Nothing was built.", { problems: ["policy_nonce is at its u64 maximum: set_policy_v2 would overflow it"] });
  }

  const batch = await readBuildBatch(served.pool, { addresses: [], sizes: [] });
  if (batch.kind !== "exists") return upstreamUnavailable(served);
  const computeBudget = ownerComputeBudget("set_policy_v2");
  let built;
  try {
    built = buildSetPolicyV2({ owner, ...policy, paused: fields.paused, ...batch.value.recent, computeBudget });
  } catch (error) {
    if (error instanceof BuildError) return served.refuse(400, "invalid_policy", "The program would refuse this vault rule.", { problems: error.problems });
    throw error;
  }
  return json(200, {
    ...built,
    // What the vault holds now, so the panel can show the rule this replaces.
    current: {
      mode: stored.skimMode,
      skimBps: stored.skimBps,
      volumeBps: stored.volumeBps,
      paused: stored.paused,
      maxContribution: stored.maxContribution,
      walletReserve: stored.walletReserve,
      policyNonce: stored.policyNonce,
    },
    policyNonce: { current: stored.policyNonce, next: stored.policyNonce + 1n, invalidatesSettlementsInFlight: true, notice: POLICY_NONCE_NOTICE },
    costs: costs(0n, 1, computeBudget),
  });
}

const PREPARE_LINK_FIELDS = ["action", "owner", "wallet"] as const;
const LINK_FIELDS = ["action", "owner", "wallet", "consentSignature"] as const;

/** prepareLink (the consent to sign) and link (the transaction, once signed). Both re-run every refusal against the chain. */
async function linkWallet(fields: Readonly<Record<string, unknown>>, served: Served, withTransaction: boolean): Promise<Response> {
  const extra = unexpectedField(fields, withTransaction ? LINK_FIELDS : PREPARE_LINK_FIELDS);
  if (extra !== null) return served.refuse(400, "bad_request", extra);
  const { owner, wallet, consentSignature } = fields;
  if (!isPubkey(owner) || !isPubkey(wallet)) return served.refuse(400, "bad_request", "owner and wallet must be base58 32-byte public keys.");
  if (withTransaction && (typeof consentSignature !== "string" || tryBase64Decode(consentSignature)?.length !== 64)) {
    return served.refuse(400, "bad_request", "consentSignature must be the trading wallet's 64-byte signature, in standard base64.");
  }
  if (owner === wallet) return served.refuse(400, "wallet_is_owner", "A trading wallet cannot be your pension key.");
  if (withTransaction) {
    try {
      checkLinkConsent({ owner, wallet, consentSignature: consentSignature as string });
    } catch (error) {
      if (error instanceof LinkConsentError) return served.refuse(422, "link_consent_invalid", "Your trading wallet's signature does not match SaverFi's link consent.");
      if (error instanceof WalletIsOwnerError) return served.refuse(400, "wallet_is_owner", "A trading wallet cannot be your pension key.");
      throw error;
    }
  }

  const spent = served.spendReads(withTransaction ? BUILD_READS_WEIGHT.link : BUILD_READS_WEIGHT.prepareLink);
  if (spent !== null) return spent;
  const reads = await readLinkPrerequisites(served.pool, owner, wallet);
  if (reads.vault.kind === "unreadable" || reads.config.kind === "unreadable" || reads.link.kind === "unreadable") return unreadable(served);
  if (reads.vault.kind === "missing") return served.refuse(409, "vault_missing", "Create your vault first.");
  if (reads.config.kind === "missing") {
    return served.refuse(409, "config_missing", "Linking opens once SaverFi's program is configured on Solana. Your vault, investing and withdrawals already work.");
  }
  if (reads.config.value.state.paused) return served.refuse(409, "protocol_paused", "SaverFi is paused, so linking waits. Withdrawals still work.");
  if (reads.link.kind === "exists") {
    const linkedTo = reads.link.value.state.vault;
    return served.refuse(
      409,
      "wallet_already_linked",
      linkedTo === reads.vaultAddress ? "This wallet is already linked to your vault." : "This wallet saves into another vault. Only that vault's owner can unlink it.",
      { vault: linkedTo },
    );
  }

  if (!withTransaction) return json(200, prepareLinkWalletConsent({ owner, wallet }));

  const chain = await readBlockhashAndRents(served.pool, [SIP_ACCOUNT_SPACE.TradingLink]);
  if (chain.kind !== "exists") return upstreamUnavailable(served);
  const computeBudget = ownerComputeBudget("link_wallet");
  let built;
  try {
    built = buildLinkWallet({ owner, wallet, consentSignature: consentSignature as string, ...chain.value.recent, computeBudget });
  } catch (error) {
    if (error instanceof LinkConsentError) return served.refuse(422, "link_consent_invalid", "Your trading wallet's signature does not match SaverFi's link consent.");
    throw error;
  }
  return json(200, { ...built, costs: costs(chain.value.rents[0]!, 2, computeBudget) });
}

// ── set_invest_policy ────────────────────────────────────────────────────────

const INVEST_POLICY_FIELDS = ["action", "owner", "maxPerCall", "maxRolling30d", "enabled", "minInvestment", "weights", "venue"] as const;

/**
 * WEIGHTS ARE READ BY MINT, NEVER BY POSITION. The catalogue the owner saw and
 * the catalogue the server builds from are two reads of OFFERED_LEGS separated
 * by a deploy; if their ORDER ever differed, a positional weight would land on
 * the wrong stock and nothing would fail — the sum would still be 10,000 and the
 * chain would accept it. Keyed by mint, the same disagreement is a mint that is
 * offered and unnamed, or named and not offered, and both are refused here.
 *
 * NOTHING IS REPAIRED. A missing leg is not filled in at the share that would
 * make the sum work, a sum of 9,999 is not normalised, and the entries are not
 * reordered: each is a different basket from the one the owner asked for, and a
 * refusal that names what was wrong is the only honest answer. Returns the
 * weights by mint, or the sentence that says why there are none.
 */
function weightsByMint(value: unknown, inMint: string): { readonly ok: true; readonly byMint: ReadonlyMap<string, number> } | { readonly ok: false; readonly problem: string } {
  const no = (problem: string) => ({ ok: false, problem }) as const;
  if (!Array.isArray(value)) return no("weights must be an array of { mint, weightBps }, one entry per stock SaverFi offers.");
  const byMint = new Map<string, number>();
  let total = 0;
  for (const [index, entry] of value.entries()) {
    const at = `weights[${index}]`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return no(`${at} must be an object { mint, weightBps }.`);
    const fields = entry as Record<string, unknown>;
    const extra = unexpectedField(fields, ["mint", "weightBps"]);
    if (extra !== null) return no(`${at}: ${extra}`);
    const { mint, weightBps } = fields;
    if (!isPubkey(mint)) return no(`${at}.mint must be a base58 32-byte mint address.`);
    if (byMint.has(mint)) return no(`${at} names ${mint} again: a stock takes one weight.`);
    if (mint === inMint) return no(`${at} names ${mint}, the currency the basket spends: it cannot also be bought.`);
    if (!Number.isInteger(weightBps) || (weightBps as number) <= 0) return no(`${at}.weightBps must be a whole number of basis points greater than zero.`);
    byMint.set(mint, weightBps as number);
    total += weightBps as number;
  }
  const offered = OFFERED_LEGS.map((leg) => leg.mint);
  const unnamed = offered.filter((mint) => !byMint.has(mint));
  if (unnamed.length > 0) return no(`weights names no share for ${unnamed.join(", ")}. Every stock SaverFi offers takes a weight; none is filled in for you.`);
  const unoffered = [...byMint.keys()].filter((mint) => !offered.includes(mint));
  if (unoffered.length > 0) return no(`weights names ${unoffered.join(", ")}, which SaverFi does not offer.`);
  // Last, so a basket that is the right stocks but the wrong shares says so
  // rather than being reported as a shape problem.
  if (total !== LEG_WEIGHT_TOTAL_BPS) return no(`the weights must add up to exactly ${LEG_WEIGHT_TOTAL_BPS} basis points; these add up to ${total}.`);
  return { ok: true, byMint };
}

interface LiveFloors {
  readonly convertWad: bigint;
  readonly convertFloor: bigint;
  /** In OFFERED_LEGS' order. */
  readonly legWads: readonly bigint[];
  readonly legFloors: readonly bigint[];
}

/** Today's rates from PRICED_POOLS' accounts and the floors under them, or null when a pool is not what SIP pins. */
function liveFloors(pools: readonly (AccountSnapshot | null)[], slot: number | null): LiveFloors | null {
  try {
    const prices = poolPricesFromAccounts(pools, slot);
    const legWads = OFFERED_LEGS.map((leg) => prices.legWads[leg.mint]!);
    return {
      convertWad: prices.convertWad,
      convertFloor: floorWad(prices.convertWad, CONVERT_FLOOR_MARGIN_BPS),
      legWads,
      legFloors: legWads.map((wad) => floorWad(wad, LEG_FLOOR_MARGIN_BPS)),
    };
  } catch (error) {
    if (error instanceof PoolPriceError) return null;
    throw error;
  }
}

/**
 * investPolicy: set_invest_policy for the offered basket, with floors read from
 * the pinned pools at build time and every vault token account the vault lacks
 * created ahead of it at the owner's expense. Floors, legs and in-mint are
 * SIP's; the request may name the caps, the minimum purchase, the share each
 * offered stock takes and the venue — by name — and whether investing is on.
 * Every one of those is optional, and absent it is built exactly as before:
 * equal shares over the catalogue, the $5-split minimum, Raydium CLMM.
 */
async function investPolicy(fields: Readonly<Record<string, unknown>>, served: Served): Promise<Response> {
  const extra = unexpectedField(fields, INVEST_POLICY_FIELDS);
  if (extra !== null) return served.refuse(400, "bad_request", extra);
  const owner = fields.owner;
  if (!isPubkey(owner)) return served.refuse(400, "bad_request", "owner must be a base58 32-byte public key.");
  const maxPerCall = fields.maxPerCall === undefined ? DEFAULT_INVEST_CAPS.maxPerCall : decimalU64(fields.maxPerCall);
  const maxRolling30d = fields.maxRolling30d === undefined ? DEFAULT_INVEST_CAPS.maxRolling30d : decimalU64(fields.maxRolling30d);
  if (maxPerCall === null || maxRolling30d === null) return served.refuse(400, "bad_request", "maxPerCall and maxRolling30d are USDC raw units, written as decimal strings.");
  // The same decimal-string parser the caps use: a $30,000 cap is 30,000,000,000
  // raw, and a double stops being exact well before a u64 does.
  const minInvestment = fields.minInvestment === undefined ? defaultInvestPolicy(OFFERED_LEGS.length).minInvestment : decimalU64(fields.minInvestment);
  if (minInvestment === null) return served.refuse(400, "bad_request", "minInvestment is a USDC raw amount (6 decimals), written as a decimal string: \"5000000\" is $5.00.");
  const enabled = fields.enabled ?? true;
  if (typeof enabled !== "boolean") return served.refuse(400, "bad_request", "enabled must be true or false.");

  const equalShares = basketWeightsBps(OFFERED_LEGS.length);
  const weights =
    fields.weights === undefined
      ? { ok: true as const, byMint: new Map(OFFERED_LEGS.map((leg, index) => [leg.mint, equalShares[index]!])) }
      : weightsByMint(fields.weights, USDC_MINT);
  if (!weights.ok) return served.refuse(400, "bad_request", weights.problem);

  // A NAME, NEVER A KEY. VENUE_PROGRAMS is the only translation, and it lives here.
  const venue = fields.venue === undefined ? DEFAULT_VENUE : fields.venue;
  const venueProgram = typeof venue === "string" ? VENUE_PROGRAMS.get(venue) : undefined;
  if (venueProgram === undefined) {
    return served.refuse(400, "bad_request", `venue must be one of: ${OFFERED_VENUES.join(", ")}. It is a venue's name, never a program address.`);
  }

  const policyAt = (convertFloor: bigint, legFloors: readonly bigint[]): InvestPolicyInput => ({
    legs: OFFERED_LEGS.map((leg, index) => ({ mint: leg.mint, weightBps: weights.byMint.get(leg.mint)!, minOutRateWad: legFloors[index]! })),
    venueProgram,
    inMint: USDC_MINT,
    minConvertRateWad: convertFloor,
    minInvestment,
    maxPerCall,
    maxRolling30d,
    enabled,
  });
  // The caps against the $5 minimum need no chain.
  const capProblems = investPolicyProblems(policyAt(1n, OFFERED_LEGS.map(() => 1n)));
  if (capProblems.length > 0) return served.refuse(400, "invalid_policy", "The program would refuse these limits.", { problems: capProblems });

  const spent = served.spendReads(BUILD_READS_WEIGHT.investPolicy);
  if (spent !== null) return spent;
  const accounts = await readOwnerAccounts(served.pool, owner);
  // A policy that could not be read might exist: its rent is not quoted over a guess.
  if (accounts.vault.kind === "unreadable" || accounts.policy.kind === "unreadable") return unreadable(served);
  if (accounts.vault.kind === "missing") return served.refuse(409, "vault_missing", "Create your vault first.");

  const targets = vaultTokenAccountTargets(accounts.vaultAddress);
  const mints = [{ mint: USDC_MINT, tokenProgram: TOKEN_PROGRAM }, ...OFFERED_LEGS.map((leg) => ({ mint: leg.mint, tokenProgram: leg.tokenProgram }))];
  const sizes = [...new Set([SIP_ACCOUNT_SPACE.InvestmentPolicy, ...targets.map((target) => target.bytes)])];
  const batch = await readBuildBatch(served.pool, { addresses: [...PRICED_POOLS, ...mints.map((entry) => entry.mint), ...targets.map((target) => target.address)], sizes });
  if (batch.kind !== "exists") return unreadable(served);
  const chain = batch.value;
  const rentFor = (size: number): bigint => chain.rents[sizes.indexOf(size)]!;

  const floors = liveFloors(chain.accounts.slice(0, PRICED_POOLS.length), chain.slot);
  if (floors === null) return served.refuse(502, "price_unavailable", "SaverFi could not read today's prices from Raydium, so no floor was set. Nothing was built.");
  for (const [index, entry] of mints.entries()) {
    if (chain.accounts[PRICED_POOLS.length + index]?.owner !== entry.tokenProgram) {
      return served.refuse(409, "mint_unexpected", "A token this policy names is not held by the token program SaverFi expects. Nothing was built.", { mint: entry.mint });
    }
  }
  const statuses = targets.map((target, index) => tokenAccountStatus(chain.accounts[PRICED_POOLS.length + mints.length + index], target.tokenProgram));
  if (statuses.includes("unreadable")) return unreadable(served);

  const policy = policyAt(floors.convertFloor, floors.legFloors);
  const problems = investPolicyProblems(policy);
  if (problems.length > 0) return served.refuse(400, "invalid_policy", "The program would refuse this policy.", { problems });
  const missing = targets.filter((_, index) => statuses[index] === "missing");
  // ONLY THE FIRST FEW MISSING ACCOUNTS RIDE ALONG. A three-leg basket needs
  // five, and five creations do not fit a signed transaction once Phantom has
  // added its checks (BUNDLED_VAULT_TOKEN_ACCOUNT_CREATES carries the bytes).
  // The rest are left to the keeper, which creates every one of them
  // idempotently at the crank's expense on the first invest tick, so the policy
  // still works the moment it lands.
  const bundled = missing.slice(0, BUNDLED_VAULT_TOKEN_ACCOUNT_CREATES);
  const created = new Set(bundled.map((target) => target.address));
  const computeBudget = ownerComputeBudget("set_invest_policy");
  let built;
  try {
    built = buildSetInvestPolicy({ owner, ...policy, ...chain.recent, computeBudget, vaultTokenAccounts: bundled.map(({ mint, tokenProgram }) => ({ mint, tokenProgram })) });
  } catch (error) {
    if (error instanceof BuildError) return served.refuse(400, "invalid_policy", "The program would refuse this policy.", { problems: error.problems });
    throw error;
  }

  const policyExists = accounts.policy.kind === "exists";
  const policyRentLamports = policyExists ? 0n : rentFor(SIP_ACCOUNT_SPACE.InvestmentPolicy);
  // What THIS transaction's creations cost the owner. An unbundled account's rent is the crank's.
  const tokenAccountRentLamports = bundled.reduce((total, target) => total + rentFor(target.bytes), 0n);
  return json(200, {
    ...built,
    policyExists,
    floors: {
      slot: chain.slot,
      marginBps: { convert: CONVERT_FLOOR_MARGIN_BPS, leg: LEG_FLOOR_MARGIN_BPS },
      liveConvertWad: floors.convertWad,
      convertWad: floors.convertFloor,
      usdcRawPerSol: usdcRawPerSol(floors.convertWad),
      floorUsdcRawPerSol: usdcRawPerSol(floors.convertFloor),
      legs: OFFERED_LEGS.map((leg, index) => ({
        symbol: leg.symbol,
        mint: leg.mint,
        liveWad: floors.legWads[index]!,
        wad: floors.legFloors[index]!,
        usdcRawPer1e8: usdcRawPer1e8LegRaw(floors.legWads[index]!),
        maxUsdcRawPer1e8: usdcRawPer1e8LegRaw(floors.legFloors[index]!),
      })),
    },
    // Every account the policy needs, in the builder's order, and whether this
    // transaction creates it. A target that is missing and not created here is
    // the keeper's to open: it lists as create false, like one that already exists.
    vaultTokenAccounts: targets.map((target) => ({ mint: target.mint, address: target.address, tokenProgram: target.tokenProgram, create: created.has(target.address) })),
    costs: { ...costs(policyRentLamports + tokenAccountRentLamports, 1, computeBudget), policyRentLamports, tokenAccountRentLamports },
    warnings: maxPerCall > CONVERT_TIGHTEST_MAX_PER_CALL ? ["convert_per_call_above_1_sol"] : [],
  });
}

const PAUSE_INVESTING_FIELDS = ["action", "owner"] as const;

/**
 * pauseInvesting: set_invest_policy re-signing the policy the vault holds, every
 * leg, floor, venue, in-mint and cap as stored, with investing off. It reads no
 * pool. A pause is the owner's control to stop the keeper investing, so it must
 * work when the pinned pools cannot be priced (closed, migrated, a changed
 * layout) or while the prices are why the owner wants to stop. Signing again and
 * resuming set new floors, and read today's prices (investPolicy).
 */
async function pauseInvesting(fields: Readonly<Record<string, unknown>>, served: Served): Promise<Response> {
  const extra = unexpectedField(fields, PAUSE_INVESTING_FIELDS);
  if (extra !== null) return served.refuse(400, "bad_request", extra);
  const owner = fields.owner;
  if (!isPubkey(owner)) return served.refuse(400, "bad_request", "owner must be a base58 32-byte public key.");

  const spent = served.spendReads(BUILD_READS_WEIGHT.pauseInvesting);
  if (spent !== null) return spent;
  const accounts = await readOwnerAccounts(served.pool, owner);
  if (accounts.vault.kind === "unreadable" || accounts.policy.kind === "unreadable") return unreadable(served);
  if (accounts.vault.kind === "missing") return served.refuse(409, "vault_missing", "Create your vault first.");
  if (accounts.policy.kind === "missing") return served.refuse(409, "policy_missing", "Your vault has no investment policy to pause.");
  const stored = accounts.policy.value.state;
  if (!stored.enabled) return served.refuse(409, "already_paused", "Investing is already paused.");

  const policy: InvestPolicyInput = {
    legs: stored.legs.map((leg) => ({ mint: leg.mint, weightBps: leg.weightBps, minOutRateWad: leg.minOutRateWad })),
    venueProgram: stored.venueProgram,
    inMint: stored.inMint,
    minConvertRateWad: stored.minConvertRateWad,
    minInvestment: stored.minInvestment,
    maxPerCall: stored.maxPerCall,
    maxRolling30d: stored.maxRolling30d,
    enabled: false,
  };
  const problems = investPolicyProblems(policy);
  if (problems.length > 0) return served.refuse(409, "invalid_policy", "The program would refuse this policy signed again. Nothing was built.", { problems });

  const batch = await readBuildBatch(served.pool, { addresses: [], sizes: [] });
  if (batch.kind !== "exists") return upstreamUnavailable(served);
  const computeBudget = ownerComputeBudget("set_invest_policy");
  let built;
  try {
    built = buildSetInvestPolicy({ owner, ...policy, ...batch.value.recent, computeBudget });
  } catch (error) {
    if (error instanceof BuildError) return served.refuse(409, "invalid_policy", "The program would refuse this policy signed again. Nothing was built.", { problems: error.problems });
    throw error;
  }
  return json(200, { ...built, policyExists: true, costs: costs(0n, 1, computeBudget) });
}

// ── withdraw and withdraw_token ──────────────────────────────────────────────

const WITHDRAW_FIELDS = ["action", "owner", "lamports"] as const;

/** withdraw: SOL out of the vault, at most what it holds above its rent floor. No pause gates it. */
async function withdraw(fields: Readonly<Record<string, unknown>>, served: Served): Promise<Response> {
  const extra = unexpectedField(fields, WITHDRAW_FIELDS);
  if (extra !== null) return served.refuse(400, "bad_request", extra);
  const owner = fields.owner;
  if (!isPubkey(owner)) return served.refuse(400, "bad_request", "owner must be a base58 32-byte public key.");
  const lamports = decimalU64(fields.lamports);
  if (lamports === null) return served.refuse(400, "bad_request", "lamports is an amount of lamports, written as a decimal string.");
  if (lamports === 0n) return served.refuse(400, "zero_amount", "The amount must be more than zero.");

  const spent = served.spendReads(BUILD_READS_WEIGHT.withdraw);
  if (spent !== null) return spent;
  const vault = await readVault(served.pool, deriveVaultPda(owner).toBase58());
  if (vault.kind === "unreadable") return unreadable(served);
  if (vault.kind === "missing") return served.refuse(409, "vault_missing", "Create your vault first.");
  const { withdrawableLamports } = vault.value;
  if (lamports > withdrawableLamports) {
    return served.refuse(422, "above_withdrawable", "That is more than the vault can release: it keeps its rent reserve.", { withdrawableLamports });
  }

  const batch = await readBuildBatch(served.pool, { addresses: [], sizes: [] });
  if (batch.kind !== "exists") return upstreamUnavailable(served);
  const computeBudget = ownerComputeBudget("withdraw");
  const built = buildWithdraw({ owner, lamports, ...batch.value.recent, computeBudget });
  return json(200, { ...built, withdrawableLamports, costs: costs(0n, 1, computeBudget) });
}

const WITHDRAW_TOKEN_FIELDS = ["action", "owner", "mint", "amountRaw", "vaultToken"] as const;

/**
 * withdrawToken: tokens out of the vault account the screen showed, to the
 * owner's own associated account. The request names that account, and it is read
 * by address, from its own bytes: a token account whose owner field is the
 * vault, of this mint, holding at least the amount. Its token program is the one
 * the chain says holds it, never the request's.
 *
 * NEVER A LISTING. Anyone can open token accounts whose owner is the vault, and
 * enough of them make getTokenAccountsByOwner's answer too large to read. A build
 * that needed that listing could be stopped for good; this one reads two
 * accounts, however many others exist.
 */
async function withdrawToken(fields: Readonly<Record<string, unknown>>, served: Served): Promise<Response> {
  const extra = unexpectedField(fields, WITHDRAW_TOKEN_FIELDS);
  if (extra !== null) return served.refuse(400, "bad_request", extra);
  const { owner, mint, vaultToken } = fields;
  if (!isPubkey(owner) || !isPubkey(mint) || !isPubkey(vaultToken)) return served.refuse(400, "bad_request", "owner, mint and vaultToken must be base58 32-byte public keys.");
  const amountRaw = decimalU64(fields.amountRaw);
  if (amountRaw === null) return served.refuse(400, "bad_request", "amountRaw is an amount of the token's raw units, written as a decimal string.");
  if (amountRaw === 0n) return served.refuse(400, "zero_amount", "The amount must be more than zero.");

  const spent = served.spendReads(BUILD_READS_WEIGHT.withdrawToken);
  if (spent !== null) return spent;
  const read = await readWithdrawTokenSource(served.pool, owner, vaultToken);
  if (read.vault.kind === "unreadable" || read.source.kind === "unreadable") return unreadable(served);
  if (read.vault.kind === "missing") return served.refuse(409, "vault_missing", "Create your vault first.");
  const source = read.source.kind === "exists" ? read.source.value : null;
  // Gone, not a token account, not the vault's, or another mint: for this vault, that account holds none of this token.
  if (source === null || source.owner !== read.vaultAddress || source.mint !== mint || source.amountRaw === 0n) {
    return served.refuse(422, "not_held", "Your vault holds none of this token.");
  }
  if (amountRaw > source.amountRaw) return served.refuse(422, "above_holding", "Your vault holds less of this token than that.", { heldRaw: source.amountRaw });

  const ownerTokenAccount = deriveAta(owner, mint, source.tokenProgram).toBase58();
  // What the owner's account takes if withdraw_token must create it: known for classic accounts and the offered legs.
  const size = source.tokenProgram === TOKEN_PROGRAM ? CLASSIC_TOKEN_ACCOUNT_BYTES : (OFFERED_LEGS.find((leg) => leg.mint === mint)?.tokenAccountBytes ?? null);
  const batch = await readBuildBatch(served.pool, { addresses: [ownerTokenAccount], sizes: size === null ? [] : [size] });
  if (batch.kind !== "exists") return upstreamUnavailable(served);
  const ownerTokenAccountExists = tokenAccountStatus(batch.value.accounts[0], source.tokenProgram) === "exists";
  const computeBudget = ownerComputeBudget("withdraw_token");
  const built = buildWithdrawToken({ owner, mint, tokenProgram: source.tokenProgram, amountRaw, vaultToken: source.address, ...batch.value.recent, computeBudget });
  // wSOL arrives as SOL: the program closes the owner's wSOL account in the same instruction, so its rent comes straight back.
  const ownerTokenAccountRentLamports = ownerTokenAccountExists || mint === WSOL_MINT ? 0n : (batch.value.rents[0] ?? null);
  return json(200, {
    ...built,
    heldRaw: source.amountRaw,
    ownerTokenAccountExists,
    ownerTokenAccountRentLamports,
    costs: costs(ownerTokenAccountRentLamports ?? 0n, 1, computeBudget),
  });
}

/** POST /api/solana-build: unsigned owner transactions (createVault, setPolicy, link, investPolicy, pauseInvesting, withdraw, withdrawToken) and the link consent (prepareLink). */
export function createSolanaBuildHandler(options: SolanaBuildHandlerOptions): SolanaRouteHandler {
  return createRoute("solana-build", options, async (action, fields, served) => {
    switch (action) {
      case "createVault":
        return createVault(fields, served);
      case "setPolicy":
        return setPolicy(fields, served);
      case "prepareLink":
        return linkWallet(fields, served, false);
      case "link":
        return linkWallet(fields, served, true);
      case "investPolicy":
        return investPolicy(fields, served);
      case "pauseInvesting":
        return pauseInvesting(fields, served);
      case "withdraw":
        return withdraw(fields, served);
      case "withdrawToken":
        return withdrawToken(fields, served);
      default:
        return served.refuse(400, "bad_request", "action must be createVault, setPolicy, prepareLink, link, investPolicy, pauseInvesting, withdraw or withdrawToken.");
    }
  });
}

// ── /api/solana-vault ────────────────────────────────────────────────────────

const STATE_FIELDS = ["action", "owner", "wallets"] as const;

function readView<T>(address: string, read: ChainRead<T>, view: (value: T) => Record<string, unknown>): Record<string, unknown> {
  return read.kind === "exists" ? { status: "exists", address, ...view(read.value) } : { status: read.kind, address };
}

/**
 * POST /api/solana-vault {"action":"state","owner","wallets":[…]}: the owner's
 * vault, policy and the protocol config, where each trading wallet saves, the
 * vault's token holdings and whether its policy token accounts exist, the rents
 * the forms quote, and the live pool prices. Every read keeps its own outcome,
 * and "unreadable" is never reported as "missing".
 */
export function createSolanaVaultHandler(options: SolanaVaultHandlerOptions): SolanaRouteHandler {
  return createRoute("solana-vault", options, async (action, fields, served) => {
    if (action !== "state") return served.refuse(400, "bad_request", 'Only {"action":"state"} is served.');
    const extra = unexpectedField(fields, STATE_FIELDS);
    if (extra !== null) return served.refuse(400, "bad_request", extra);
    const { owner, wallets } = fields;
    if (!isPubkey(owner)) return served.refuse(400, "bad_request", "owner must be a base58 32-byte public key.");
    if (!Array.isArray(wallets) || wallets.length > MAX_WALLET_LINKS || !wallets.every(isPubkey) || new Set(wallets).size !== wallets.length) {
      return served.refuse(400, "bad_request", `wallets must list 0 to ${MAX_WALLET_LINKS} distinct base58 32-byte addresses.`);
    }

    const spent = served.spendReads(BUILD_READS_WEIGHT.state);
    if (spent !== null) return spent;
    const vaultAddress = deriveVaultPda(owner).toBase58();
    const rentSizes = [SIP_ACCOUNT_SPACE.Vault, SIP_ACCOUNT_SPACE.TradingLink, SIP_ACCOUNT_SPACE.InvestmentPolicy, CLASSIC_TOKEN_ACCOUNT_BYTES, ...OFFERED_LEGS.map((leg) => leg.tokenAccountBytes)];
    const [accounts, links, prices, rents, holdings, tokenAccounts] = await Promise.all([
      readOwnerAccounts(served.pool, owner),
      readWalletLinks(served.pool, vaultAddress, wallets as string[]),
      readPoolPrices(served.pool),
      readRents(served.pool, rentSizes),
      listVaultHoldings(served.pool, vaultAddress),
      readVaultTokenAccounts(served.pool, vaultAddress),
    ]);

    return json(200, {
      owner,
      programId: SIP_PROGRAM_ID,
      vault: readView(accounts.vaultAddress, accounts.vault, (vault) => ({
        lamports: vault.lamports,
        rentFloor: vault.rentFloor,
        withdrawableLamports: vault.withdrawableLamports,
        state: vault.state,
      })),
      policy: readView(accounts.policyAddress, accounts.policy, (policy) => ({ lamports: policy.lamports, state: policy.state })),
      config: {
        address: accounts.configAddress,
        status: accounts.config.kind,
        exists: accounts.config.kind === "exists",
        paused: accounts.config.kind === "exists" ? accounts.config.value.state.paused : null,
      },
      walletLinks: links,
      // Non-zero balances under both token programs; uiAmount is the RPC's display amount, amountRaw what moves.
      holdings: holdings.kind === "exists" ? { status: "exists", items: holdings.value } : { status: "unreadable", items: [] },
      // The accounts an investment policy needs (wSOL, USDC, each leg) and whether each exists.
      vaultTokenAccounts: tokenAccounts.kind === "exists" ? { status: "exists", items: tokenAccounts.value } : { status: "unreadable", items: [] },
      rents:
        rents.kind === "exists"
          ? {
              vault: rents.value[0],
              link: rents.value[1],
              policy: rents.value[2],
              tokenAccount: rents.value[3],
              legTokenAccounts: Object.fromEntries(OFFERED_LEGS.map((leg, index) => [leg.mint, rents.value[4 + index]])),
            }
          : null,
      // One copy of this shape, shared with /api/solana-live below.
      prices: pricesView(prices),
    });
  });
}

// ── /api/solana-live ─────────────────────────────────────────────────────────

const SNAPSHOT_FIELDS = ["action", "owner", "wallets", "discover"] as const;
const ACTIVITY_FIELDS = ["action", "owner", "limit", "before", "until"] as const;

/** The pool prices as both /api/solana-vault and /api/solana-live report them. */
function pricesView(prices: ChainRead<PoolPrices>): Record<string, unknown> | null {
  if (prices.kind !== "exists") return null;
  return {
    slot: prices.value.slot,
    convertWad: prices.value.convertWad,
    usdcRawPerSol: usdcRawPerSol(prices.value.convertWad),
    legs: OFFERED_LEGS.map((leg) => {
      const wad = prices.value.legWads[leg.mint]!;
      return { symbol: leg.symbol, mint: leg.mint, wad, usdcRawPer1e8: usdcRawPer1e8LegRaw(wad) };
    }),
  };
}

/**
 * Pyth's SOL/USDC as /api/solana-live reports it, BESIDE the pool prices and
 * never folded into them: the point of a second source is that it is a second
 * source, and a panel that averaged the two would hide exactly the disagreement
 * worth showing. null when the oracle could not be read — which the pool prices
 * above neither cause nor feel.
 */
function pythView(pyth: ChainRead<PythRead>): Record<string, unknown> | null {
  if (pyth.kind !== "exists") return null;
  const feed = (update: PythPriceUpdate): Record<string, unknown> => ({
    price: update.price,
    conf: update.conf,
    // A number, not a bigint: a decimal exponent of ±18 at the widest.
    expo: update.expo,
    publishTime: update.publishTime,
    postedSlot: update.postedSlot,
  });
  return {
    // USDC raw per lamport × 1e18 — the unit prices.convertWad is in, so the
    // oracle and the venue can be compared without either becoming a display price.
    wad: pyth.value.wad,
    // Measured against the CHAIN's clock, reported here beside it so the reader
    // can check the subtraction instead of trusting it. The pair is only as
    // fresh as its staler leg, and a clock the host holds is no part of this.
    ageSeconds: pyth.value.ageSeconds,
    chainUnixSeconds: pyth.value.chainUnixSeconds,
    sol: feed(pyth.value.sol),
    usdc: feed(pyth.value.usdc),
  };
}

/** snapshot: the whole live dashboard in one batch. */
async function liveSnapshot(fields: Readonly<Record<string, unknown>>, served: Served, now: () => number): Promise<Response> {
  const extra = unexpectedField(fields, SNAPSHOT_FIELDS);
  if (extra !== null) return served.refuse(400, "bad_request", extra);
  const { owner, wallets, discover } = fields;
  if (!isPubkey(owner)) return served.refuse(400, "bad_request", "owner must be a base58 32-byte public key.");
  if (!Array.isArray(wallets) || wallets.length > MAX_WALLET_LINKS || !wallets.every(isPubkey) || new Set(wallets).size !== wallets.length) {
    return served.refuse(400, "bad_request", `wallets must list 0 to ${MAX_WALLET_LINKS} distinct base58 32-byte addresses.`);
  }
  if ((wallets as string[]).includes(owner)) return served.refuse(400, "bad_request", "A trading wallet cannot be your pension key.");
  if (typeof discover !== "boolean") return served.refuse(400, "bad_request", "discover must be true or false.");

  const spent = served.spendReads(discover ? LIVE_READS_WEIGHT.snapshotDiscover : LIVE_READS_WEIGHT.snapshot);
  if (spent !== null) return spent;
  const snapshot = await readLiveSnapshot(served.pool, { owner, wallets: wallets as string[], discover });

  return json(200, {
    owner,
    programId: SIP_PROGRAM_ID,
    slot: snapshot.slot,
    readAtMs: now(),
    vault: readView(snapshot.vaultAddress, snapshot.vault, (vault) => ({
      lamports: vault.lamports,
      rentFloor: vault.rentFloor,
      withdrawableLamports: vault.withdrawableLamports,
      state: vault.state,
    })),
    policy: readView(snapshot.policyAddress, snapshot.policy, (policy) => ({ lamports: policy.lamports, state: policy.state })),
    config: {
      address: snapshot.configAddress,
      status: snapshot.config.kind,
      exists: snapshot.config.kind === "exists",
      paused: snapshot.config.kind === "exists" ? snapshot.config.value.state.paused : null,
    },
    prices: pricesView(snapshot.prices),
    // A SIBLING of prices, never a field inside it: the pool is what SaverFi
    // trades against, the oracle is what says so from outside the venue.
    pyth: pythView(snapshot.pyth),
    vaultTokenAccounts:
      snapshot.tokenAccounts.kind === "exists" ? { status: "exists", items: snapshot.tokenAccounts.value } : { status: "unreadable", items: [] },
    rents: { vault: snapshot.rents.vault, walletFloor: snapshot.rents.walletFloor },
    wallets: snapshot.wallets.map((wallet) => ({
      wallet: wallet.wallet,
      lamports: wallet.lamports,
      link: {
        address: wallet.link.address,
        status: wallet.link.status,
        vault: wallet.link.vault,
        // Null unless the link itself was read: a count nobody read is not a zero.
        epoch: wallet.link.state?.epoch ?? null,
        settlementNonce: wallet.link.state?.settlementNonce ?? null,
        frontierSlot: wallet.link.state?.frontierSlot ?? null,
      },
    })),
    links:
      snapshot.links === null
        ? null
        : snapshot.links.kind === "exists"
          ? {
              status: "exists",
              items: snapshot.links.value.map((link) => ({
                wallet: link.state.wallet,
                address: link.address,
                epoch: link.state.epoch,
                settlementNonce: link.state.settlementNonce,
                frontierSlot: link.state.frontierSlot,
              })),
            }
          : { status: "unreadable", items: [] },
  });
}

/** activity: one page of the vault's history, every transaction already classified. */
async function liveActivity(fields: Readonly<Record<string, unknown>>, served: Served): Promise<Response> {
  const extra = unexpectedField(fields, ACTIVITY_FIELDS);
  if (extra !== null) return served.refuse(400, "bad_request", extra);
  const { owner, before, until } = fields;
  if (!isPubkey(owner)) return served.refuse(400, "bad_request", "owner must be a base58 32-byte public key.");
  const limit = fields.limit === undefined ? MAX_LIVE_ACTIVITY_PAGE : fields.limit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIVE_ACTIVITY_PAGE) {
    return served.refuse(400, "bad_request", `limit must be a whole number from 1 to ${MAX_LIVE_ACTIVITY_PAGE}.`);
  }
  if (before !== undefined && until !== undefined) return served.refuse(400, "bad_request", "Name before or until, not both.");
  if (before !== undefined && !isSignature(before)) return served.refuse(400, "bad_request", "before must be a base58 64-byte signature.");
  if (until !== undefined && !isSignature(until)) return served.refuse(400, "bad_request", "until must be a base58 64-byte signature.");

  const spent = served.spendReads(LIVE_READS_WEIGHT.signatures);
  if (spent !== null) return spent;
  const vault = deriveVaultPda(owner).toBase58();
  const page = await listVaultSignatures(served.pool, vault, {
    limit,
    ...(typeof before === "string" ? { before } : {}),
    ...(typeof until === "string" ? { until } : {}),
  });
  if (page.kind !== "exists") return json(200, { vault, status: "unreadable", nextBefore: null, entries: [], gap: false });

  const listed = page.value.listed;
  // The transactions are charged BEFORE the batch, now that their number is
  // known: a client without the tokens is refused and nothing upstream is spent.
  if (listed.length > 0) {
    const more = served.spendMore(listed.length);
    if (more !== null) return more;
  }
  const read = await readVaultTransactions(served.pool, vault, listed);
  if (read.kind !== "exists") return json(200, { vault, status: "unreadable", nextBefore: null, entries: [], gap: false });

  return json(200, {
    vault,
    status: "exists",
    nextBefore: page.value.nextBefore,
    entries: read.value.map((entry) => ({
      signature: entry.signature,
      slot: entry.slot,
      blockTime: entry.blockTime,
      ok: entry.ok,
      fee: entry.fee,
      events: classifyVaultEntry(entry),
    })),
    // A full page against `until` means more landed than one page holds: the
    // client reloads its head rather than stitching a hole it cannot see.
    gap: typeof until === "string" && listed.length === limit,
  });
}

/**
 * POST /api/solana-live: what the connected dashboard reads, and nothing else.
 *
 * Its per-client buckets are its OWN (createRoute builds fresh limiters per
 * handler), so the Manage wallets modal's /api/solana-vault reads cannot starve
 * the dashboard or the other way round. Upstream it charges the ONE reads budget
 * the build and vault routes already share, so the exposure on the Helius key
 * the keeper shares does not grow.
 */
export function createSolanaLiveHandler(options: SolanaVaultHandlerOptions): SolanaRouteHandler {
  const now = options.now ?? Date.now;
  return createRoute("solana-live", options, async (action, fields, served) => {
    switch (action) {
      case "snapshot":
        return liveSnapshot(fields, served, now);
      case "activity":
        return liveActivity(fields, served);
      default:
        return served.refuse(400, "bad_request", 'action must be "snapshot" or "activity".');
    }
  });
}
