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
// refusals that need no chain (400, 422) → the process-wide reads budget (429)
// → chain reads and their refusals (409, 502) → getLatestBlockhash (confirmed)
// → the builder → 200. A malformed request costs its sender's own buckets and
// no RPC quota.
//
// THE WIRE. Bigints travel as decimal strings, both ways. Refusals are
// {error:{code, message, ...}}, the shape /api/solana-tx answers with. No upstream
// text is ever returned: a read that failed is "unreadable", with no detail.

import { isPubkey } from "../client/base58";
import { tryBase64Decode } from "../client/base64";
import { usdcRawPer1e8LegRaw, usdcRawPerSol } from "../client/clmm-price";
import { SIP_ACCOUNT_SPACE } from "../client/decoders";
import { SIP_PROGRAM_ID } from "../client/idl";
import { DEFAULT_VAULT_POLICY, OFFERED_LEGS, SIGNATURE_FEE_LAMPORTS, VOLUME_MODE_OFFERED, ownerComputeBudget, priorityFeeLamports, type ComputeBudget } from "../client/product";
import { MODE_PROFIT, MODE_VOLUME, U64_MAX, vaultPolicyProblems, type VaultPolicyInput } from "../client/rules";
import { BuildError, LinkConsentError, WalletIsOwnerError, buildCreateVaultV2, buildLinkWallet, checkLinkConsent, prepareLinkWalletConsent } from "./builders";
import type { SolanaServerSettings } from "./config";
import { isCrossSite, isJsonContentType, readBodyCapped, type SolanaGate, type SolanaRouteHandler } from "./handlers";
import { deriveVaultPda } from "./pda";
import { CLIENT_AGGREGATE_FACTOR, clientIdentityFromHeaders, createWeightedLimiter, retryAfterSeconds, type WeightedLimiter } from "./rate-limit";
import {
  MAX_WALLET_LINKS,
  readBlockhashAndRents,
  readLinkPrerequisites,
  readOwnerAccounts,
  readPoolPrices,
  readRents,
  readWalletLinks,
  type ChainRead,
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
  /** A chain read failed or answered something that is not ours: nothing was offered. */
  | "unreadable"
  /** The blockhash could not be read: nothing was built. */
  | "upstream_unavailable"
  | "internal_error";

export interface BuildRefusalEvent {
  readonly route: "solana-build" | "solana-vault";
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
  /** Process-wide, keyed "global", in upstream JSON-RPC calls. Default: capacity settings.relay.readsGlobalPerMin. */
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
/** Upstream JSON-RPC calls each action may make, taken from the process-wide reads budget before the first one. */
export const BUILD_READS_WEIGHT = { createVault: 4, prepareLink: 1, link: 3, state: 6 } as const;

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
}

type Dispatch = (action: string, fields: Readonly<Record<string, unknown>>, served: Served) => Promise<Response>;

function createRoute(route: BuildRefusalEvent["route"], options: SolanaBuildHandlerOptions, dispatch: Dispatch): SolanaRouteHandler {
  const now = options.now ?? Date.now;
  const onRefusal = options.onRefusal ?? sampledWarn();
  const volumeOffered = options.volumeOffered ?? VOLUME_MODE_OFFERED;
  const state = memoBySettings((settings) => ({
    exact: options.limiter ?? createWeightedLimiter({ capacity: settings.relay.perClientPerMin }),
    aggregate: options.aggregateLimiter ?? createWeightedLimiter({ capacity: CLIENT_AGGREGATE_FACTOR * settings.relay.perClientPerMin }),
    reads: options.readsBudget ?? createWeightedLimiter({ capacity: settings.relay.readsGlobalPerMin }),
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
          const wait = reads.take(GLOBAL, weight, now());
          return wait > 0 ? limited(wait, "SIP is reading Solana for many people right now.") : null;
        },
      };
      try {
        return await dispatch(fields.action, fields, served);
      } catch {
        // A reader or builder bug, never a person's mistake: no detail leaves.
        return refuse(500, "internal_error", "SIP could not prepare this. Nothing was built.");
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

const unreadable = (served: Served): Response => served.refuse(502, "unreadable", "SIP could not read Solana just now. Nothing was built.");
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
      if (error instanceof LinkConsentError) return served.refuse(422, "link_consent_invalid", "Your trading wallet's signature does not match SIP's link consent.");
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
    return served.refuse(409, "config_missing", "Linking opens once SIP's program is configured on Solana. Your vault, investing and withdrawals already work.");
  }
  if (reads.config.value.state.paused) return served.refuse(409, "protocol_paused", "SIP is paused, so linking waits. Withdrawals still work.");
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
    if (error instanceof LinkConsentError) return served.refuse(422, "link_consent_invalid", "Your trading wallet's signature does not match SIP's link consent.");
    throw error;
  }
  return json(200, { ...built, costs: costs(chain.value.rents[0]!, 2, computeBudget) });
}

/** POST /api/solana-build: unsigned owner transactions (createVault, link) and the link consent (prepareLink). */
export function createSolanaBuildHandler(options: SolanaBuildHandlerOptions): SolanaRouteHandler {
  return createRoute("solana-build", options, async (action, fields, served) => {
    switch (action) {
      case "createVault":
        return createVault(fields, served);
      case "prepareLink":
        return linkWallet(fields, served, false);
      case "link":
        return linkWallet(fields, served, true);
      default:
        return served.refuse(400, "bad_request", "action must be createVault, prepareLink or link.");
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
 * rents the forms quote, and the live pool prices. Every read keeps its own
 * outcome, and "unreadable" is never reported as "missing".
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
    const [accounts, links, prices, rents] = await Promise.all([
      readOwnerAccounts(served.pool, owner),
      readWalletLinks(served.pool, vaultAddress, wallets as string[]),
      readPoolPrices(served.pool),
      readRents(served.pool, [SIP_ACCOUNT_SPACE.Vault, SIP_ACCOUNT_SPACE.TradingLink]),
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
      rents: rents.kind === "exists" ? { vault: rents.value[0], link: rents.value[1] } : null,
      prices:
        prices.kind === "exists"
          ? {
              slot: prices.value.slot,
              convertWad: prices.value.convertWad,
              usdcRawPerSol: usdcRawPerSol(prices.value.convertWad),
              legs: OFFERED_LEGS.map((leg) => {
                const wad = prices.value.legWads[leg.mint]!;
                return { symbol: leg.symbol, mint: leg.mint, wad, usdcRawPer1e8: usdcRawPer1e8LegRaw(wad) };
              }),
            }
          : null,
    });
  });
}
