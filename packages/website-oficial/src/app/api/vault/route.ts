/**
 * The wallets page's one read, executed on the server against the configured
 * RPC. New in this wave; the reads it composes are ports (see src/lib/vault.ts).
 *
 *   GET /api/vault?admin=0x…    the pension key's vault and its trading wallets
 *   GET /api/vault?account=0x…  which vault, if any, an address already trades for
 *
 * WHY SERVER-SIDE AND NOT IN THE BROWSER:
 *   1. The RPC URL for this deployment carries an Alchemy API key. A browser-side
 *      viem client would publish it to every visitor.
 *   2. Reads are pinned to chain 4663 and to our own transport, so they cannot be
 *      answered by whatever chain the user's wallet happens to be on.
 *   3. No CORS requirement on the RPC endpoint.
 *
 * THROTTLED LIKE /api/rpc, AND FOR THE SAME REASON. This route is
 * unauthenticated — it answers questions about addresses anyone can name — and
 * one call costs the metered upstream a chain check plus a factory read, and
 * for an admin a log scan and one read per trading wallet. So the same
 * in-process token bucket guards it, keyed on the same trusted client address.
 * The bucket is PER PROCESS (two replicas are two buckets, a restart is a
 * refill); an edge rate limit is what a deployment that needs a real one uses.
 *
 * WHAT A FAILURE LOOKS LIKE, BY DESIGN. A read that fails never degrades into a
 * plausible answer: `vault: null` is only ever said when the factory SAID zero,
 * and a failed lookup is a non-2xx with the reason. The page renders that as
 * "unknown" — never as "no vault yet", which would offer to create a second one.
 * The one partial answer this route gives is the wallet list, and it comes with
 * `accountsError` set whenever it might be incomplete.
 */

import { getAddress, isAddress, type Address } from "viem";

import type { ApiError, VaultAccountView, VaultByAccountResponse, VaultByAdminResponse } from "@/lib/api-types";
import { loadConfig } from "@/lib/config";
import { jsonResponse } from "@/lib/serialize";
import {
  activeVaultOf,
  createReadClient,
  listTradingAccounts,
  readTradingAccount,
  vaultOfAdmin,
  verifyChain,
  type Read,
  type TradingAccountView,
} from "@/lib/vault";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Per-client token bucket — the same shape and the same numbers as
// src/app/api/rpc/route.ts. Duplicated rather than shared because the two
// routes have no module between them yet; the moment a third caller needs it,
// it belongs in src/lib.
// ---------------------------------------------------------------------------

const BUCKET_CAPACITY = 60;
const REFILL_PER_MS = BUCKET_CAPACITY / 60_000;
/** An address idle this long is forgotten, so the map cannot grow without bound. */
const BUCKET_IDLE_MS = 5 * 60_000;
/** Sweep idle buckets every N requests rather than on a timer — no handle to leak. */
const SWEEP_EVERY = 256;

const buckets = new Map<string, { tokens: number; updatedAt: number }>();
let requestsSinceSweep = 0;

/**
 * Headers the EDGE writes from the socket it sees, preferred over
 * `x-forwarded-for` — which is appended to, so its first entry is whatever the
 * client sent, and a caller rotating it would get a fresh bucket per request.
 * See the long version in src/app/api/rpc/route.ts, including what this trusts.
 */
const TRUSTED_CLIENT_IP_HEADERS = [
  "cf-connecting-ip",
  "x-vercel-forwarded-for",
  "x-envoy-external-address",
  "fly-client-ip",
  "true-client-ip",
  "x-real-ip",
] as const;

function clientKey(request: Request): string {
  for (const name of TRUSTED_CLIENT_IP_HEADERS) {
    const value = request.headers.get(name)?.trim();
    if (value !== undefined && value !== "") return value;
  }
  const first = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (first !== undefined && first !== "") return first;
  return "unknown";
}

/** Takes one token for `key`. Returns how many ms until one is available, or 0 when taken. */
function take(key: string, now: number): number {
  requestsSinceSweep += 1;
  if (requestsSinceSweep >= SWEEP_EVERY) {
    requestsSinceSweep = 0;
    for (const [other, bucket] of buckets) {
      if (now - bucket.updatedAt > BUCKET_IDLE_MS) buckets.delete(other);
    }
  }
  const bucket = buckets.get(key) ?? { tokens: BUCKET_CAPACITY, updatedAt: now };
  bucket.tokens = Math.min(BUCKET_CAPACITY, bucket.tokens + (now - bucket.updatedAt) * REFILL_PER_MS);
  bucket.updatedAt = now;
  buckets.set(key, bucket);
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return 0;
  }
  return Math.ceil((1 - bucket.tokens) / REFILL_PER_MS);
}

/**
 * Not jsonResponse, only because this one answer carries a `retry-after` and
 * that helper takes no headers. A client that cannot read the header still gets
 * the wait in words.
 */
function tooManyRequests(waitMs: number): Response {
  const retryAfter = String(Math.max(1, Math.ceil(waitMs / 1000)));
  const body: ApiError = {
    error: `Rate limit: ${BUCKET_CAPACITY} requests a minute per client. Retry in ${retryAfter} s.`,
  };
  return new Response(JSON.stringify(body), {
    status: 429,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store, private",
      "retry-after": retryAfter,
    },
  });
}

function parseAddress(value: string | null): Address | null {
  if (value === null || !isAddress(value)) return null;
  return getAddress(value);
}

export async function GET(request: Request): Promise<Response> {
  // Before the parameters are even looked at, so a flood costs this process a
  // header lookup and nothing upstream.
  const waitMs = take(clientKey(request), Date.now());
  if (waitMs > 0) return tooManyRequests(waitMs);

  const url = new URL(request.url);
  const adminParam = url.searchParams.get("admin");
  const accountParam = url.searchParams.get("account");

  if ((adminParam === null) === (accountParam === null)) {
    return jsonResponse({ error: "Pass exactly one of `admin` or `account`." }, 400);
  }

  const load = loadConfig(process.env, { needPrivyAppId: false });
  if (!load.ok) {
    return jsonResponse({ error: "This deployment is not configured.", problems: load.problems }, 503);
  }
  const config = load.config;
  const client = createReadClient(config);

  // Once per request, before any contract read: a wrong-chain RPC answers every
  // question below with a confident zero. See verifyChain.
  const chain = await verifyChain(client);
  if (!chain.ok) {
    return jsonResponse({ error: chain.error }, 502);
  }

  if (accountParam !== null) {
    const account = parseAddress(accountParam);
    if (account === null) {
      return jsonResponse({ error: "`account` must be a valid EVM address." }, 400);
    }
    const linked = await activeVaultOf(client, config, account);
    if (!linked.ok) {
      return jsonResponse({ error: `VaultFactory.activeVaultOf could not be read: ${linked.error}` }, 502);
    }
    return jsonResponse({ activeVaultOf: linked.value } satisfies VaultByAccountResponse);
  }

  const admin = parseAddress(adminParam);
  if (admin === null) {
    return jsonResponse({ error: "`admin` must be a valid EVM address." }, 400);
  }

  const vault = await vaultOfAdmin(client, config, admin);
  if (!vault.ok) {
    return jsonResponse({ error: `VaultFactory.vaultOfAdmin could not be read: ${vault.error}` }, 502);
  }
  if (vault.value === null) {
    return jsonResponse({
      vault: null,
      cohortId: config.cohortId,
      accounts: [],
      accountsError: null,
    } satisfies VaultByAdminResponse);
  }

  const vaultAddress = vault.value;
  const discovered = await listTradingAccounts(client, config, vaultAddress);
  if (!discovered.ok) {
    return jsonResponse({
      vault: vaultAddress,
      cohortId: config.cohortId,
      accounts: [],
      accountsError: `The trading-wallet list could not be recovered from the vault's logs: ${discovered.error}`,
    } satisfies VaultByAdminResponse);
  }

  const reads: readonly (readonly [Address, Read<TradingAccountView>])[] = await Promise.all(
    discovered.value.map(async (address) => [address, await readTradingAccount(client, vaultAddress, address)] as const),
  );

  const accounts: VaultAccountView[] = [];
  const unreadable: string[] = [];
  for (const [address, read] of reads) {
    if (!read.ok) {
      unreadable.push(`${address}: ${read.error}`);
      continue;
    }
    // NONE is "the vault has never heard of this address". It cannot come from
    // an address the vault's own logs named, so seeing it means the RPC and the
    // logs disagree — reported, not rendered as a wallet with no status.
    if (read.value.status === "NONE") {
      unreadable.push(`${address}: named in the vault's logs but getTradingAccount reports no account`);
      continue;
    }
    accounts.push({
      address,
      status: read.value.status,
      savingsBps: read.value.savingsBps,
      inviteDeadline: read.value.inviteDeadline,
      inviteNonce: read.value.inviteNonce,
      inviteAdminEpoch: read.value.inviteAdminEpoch,
    });
  }

  return jsonResponse({
    vault: vaultAddress,
    cohortId: config.cohortId,
    accounts,
    accountsError:
      unreadable.length === 0
        ? null
        : `${unreadable.length} of ${reads.length} trading wallet(s) could not be read and are missing from the list — ${unreadable.join("; ")}`,
  } satisfies VaultByAdminResponse);
}
