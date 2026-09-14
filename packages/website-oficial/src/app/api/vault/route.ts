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
import { EVM_ROUTE_OFF_MESSAGE, evmRouteGate, loadEvmConfig } from "@/lib/config";
import { clientKey, createLimiter, retryAfterSeconds } from "@/lib/rate-limit";
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
// Per-client token bucket — the same numbers as src/app/api/rpc/route.ts, and
// now the same module: src/lib/rate-limit.ts holds the buckets and the rule for
// who a client is (edge headers over `x-forwarded-for`, or the one header
// SIP_TRUSTED_CLIENT_IP_HEADER names). Each route keeps its own buckets.
// ---------------------------------------------------------------------------

const BUCKET_CAPACITY = 60;
const limiter = createLimiter({ capacity: BUCKET_CAPACITY });

/**
 * Not jsonResponse, only because this one answer carries a `retry-after` and
 * that helper takes no headers. A client that cannot read the header still gets
 * the wait in words.
 */
function tooManyRequests(waitMs: number): Response {
  const retryAfter = String(retryAfterSeconds(waitMs));
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
  // An EVM route: under SIP_CHAIN=solana it does not exist on this deployment.
  const gate = evmRouteGate(process.env);
  if (gate.kind === "solana") return jsonResponse({ error: EVM_ROUTE_OFF_MESSAGE }, 404);
  if (gate.kind === "invalid") {
    return jsonResponse({ error: "This deployment is not configured.", problems: [gate.problem] }, 503);
  }

  // Before the parameters are even looked at, so a flood costs this process a
  // header lookup and nothing upstream.
  const waitMs = limiter.take(clientKey(request), 1, Date.now());
  if (waitMs > 0) return tooManyRequests(waitMs);

  const url = new URL(request.url);
  const adminParam = url.searchParams.get("admin");
  const accountParam = url.searchParams.get("account");

  if ((adminParam === null) === (accountParam === null)) {
    return jsonResponse({ error: "Pass exactly one of `admin` or `account`." }, 400);
  }

  const load = loadEvmConfig(process.env, { needPrivyAppId: false });
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
