// Who is this keeper responsible for? Ask the chain, not a database.
//
// Ported from Nuvem's solana-lab keeper (keeper/src/discovery.ts), unchanged in
// substance: TradingLink kept its 129-byte layout in sip-vault.
//
// THE SOLANA ANSWER IS BETTER THAN THE EVM ONE. On Robinhood Chain, discovery
// replays VaultFactory's TradingAccountLinked/Unlinked LOGS in order and then
// confirms each candidate against activeVaultOf — a history that can be
// truncated by a node whose head lags.
//
// Here, every link is an ACCOUNT: the TradingLink PDA. getProgramAccounts
// returns the complete CURRENT set in one call — state, not history. There is
// no watermark to advance, no rescan margin, no "a node clamped my toBlock and
// I stepped over a user forever". An unlinked wallet's account is CLOSED, so it
// simply stops being returned.
//
// The cost is that getProgramAccounts is heavy and some RPCs throttle or
// paginate it; that is a provider problem with a provider answer (a keyed
// endpoint), not a correctness one.
//
// AND IT IS PRICED AS HEAVY. Helius bills getProgramAccounts at 10 credits, and
// both keepers list every sweep: 2 × 1,440 × 10 = 28,800 credits a day for a
// list of four accounts, the largest fixed line of the bill (dispatcher ADR
// §2.3.1, C6). Helius's own getProgramAccountsV2 answers the same question at 1
// credit per page of up to 10,000 accounts. It is Helius-only, so it is tried
// FIRST and today's call stays as the fallback in the same sweep — behind the
// `gpa-v2` token (src/cuts.ts), off unless named.

import { Connection, PublicKey } from "@solana/web3.js";

/** Mirrors state.rs TradingLink: disc(8) wallet(32) vault(32) epoch(8) nonce(8) frontier(8) bump(1) reserved(32). */
export const TRADING_LINK_SPACE = 129;

export interface ManagedLink {
  readonly linkAddress: PublicKey;
  readonly wallet: PublicKey;
  readonly vault: PublicKey;
  readonly epoch: bigint;
  readonly settlementNonce: bigint;
  readonly frontierSlot: bigint;
}

const u64 = (data: Buffer, offset: number): bigint => data.readBigUInt64LE(offset);

/**
 * One TradingLink account's bytes as the link the keeper turns, or null when
 * they are not one.
 *
 * THE ONE DECODER every path shares — the V1 listing, the V2 pages and L3's
 * fresh re-read — so the three can never disagree about what a link is. The
 * size is checked here as well as in the listing's filter: the re-read asks for
 * accounts BY ADDRESS, and an address that once held a link can hold anything
 * after a close.
 */
export function decodeTradingLink(address: PublicKey, data: Buffer, discriminator: Buffer): ManagedLink | null {
  if (data.length !== TRADING_LINK_SPACE) return null;
  if (!data.subarray(0, 8).equals(discriminator)) return null;
  return {
    linkAddress: address,
    wallet: new PublicKey(data.subarray(8, 40)),
    vault: new PublicKey(data.subarray(40, 72)),
    epoch: u64(data, 72),
    settlementNonce: u64(data, 80),
    frontierSlot: u64(data, 88),
  };
}

/**
 * Every trading link this program currently knows about.
 *
 * The dataSize filter is the whole selector: only TradingLink accounts are 129
 * bytes, so vaults, policies and the config never enter the result. The
 * discriminator is checked too, because a future account type could share the
 * size and silently decode into nonsense.
 */
export async function discoverLinks(
  connection: Connection,
  programId: PublicKey,
  discriminator: Buffer,
): Promise<ManagedLink[]> {
  const accounts = await connection.getProgramAccounts(programId, {
    commitment: "confirmed",
    filters: [{ dataSize: TRADING_LINK_SPACE }],
  });

  const links: ManagedLink[] = [];
  for (const { pubkey, account } of accounts) {
    const link = decodeTradingLink(pubkey, account.data, discriminator);
    if (link !== null) links.push(link);
  }
  return links;
}

/**
 * Accounts per getProgramAccountsV2 page: Helius's maximum. One page — one
 * credit — holds every link this program will have for a long while.
 */
export const GPA_V2_PAGE_LIMIT = 10_000;

/**
 * Pages one V2 listing may walk before it gives up: a million links at the
 * maximum page size. Past it the listing throws, which falls back to V1 in the
 * same sweep — a cursor that never ends is a provider bug, and a loop that
 * follows it forever is a keeper that never settles anybody.
 */
export const GPA_V2_MAX_PAGES = 100;

/** Which call produced a sweep's link list. */
export type DiscoveryMethod = "v1" | "v2" | "v1-fallback";

export interface DiscoveryReport {
  readonly links: ManagedLink[];
  readonly method: DiscoveryMethod;
  /** Requests the listing cost, V2 pages and the fallback's V1 call together. */
  readonly requests: number;
  /** Why V2 was not used, when it was tried and the sweep fell back. */
  readonly fallbackReason?: string;
}

/** A V2 listing that could not be used. Its message names what was wrong, never a URL. */
export class GpaV2Unavailable extends Error {
  override readonly name = "GpaV2Unavailable";
  constructor(
    message: string,
    /** Requests already spent when it gave up. */
    readonly requests: number,
  ) {
    super(message);
  }
}

let rpcIds = 0;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * One V2 page's `result`, read without trusting it.
 *
 * THE SHAPE, FROM HELIUS'S PAGE (re-read 2026-10-12, docs/api-reference/rpc/
 * http/getprogramaccountsv2): without `withContext`, `result` is
 * `{ accounts: [{ pubkey, account: { data, owner, … } }], paginationKey }`, the
 * key base-58 or null. A `withContext: true` request wraps the same page under
 * `result.value`; this one never sends it, and an answer wrapped anyway is read
 * the same way rather than refused, because the page inside is identical.
 *
 * ANYTHING ELSE IS MALFORMED, and a malformed page is not partly used: the
 * caller discards every page it has and falls back to V1. A listing is the set
 * of people this keeper charges, and half of one is worse than the old call.
 */
function readV2Page(
  result: unknown,
  programId: PublicKey,
): { readonly accounts: readonly { readonly pubkey: PublicKey; readonly data: Buffer }[]; readonly paginationKey: string | null } | string {
  const page = isRecord(result) && isRecord(result["value"]) && !("accounts" in result) ? result["value"] : result;
  if (!isRecord(page) || !Array.isArray(page["accounts"])) return "the result carries no accounts array";
  const key = page["paginationKey"];
  if (key !== null && key !== undefined && typeof key !== "string") return "paginationKey is neither a string nor null";
  const accounts: { pubkey: PublicKey; data: Buffer }[] = [];
  for (const entry of page["accounts"] as unknown[]) {
    if (!isRecord(entry) || typeof entry["pubkey"] !== "string" || !isRecord(entry["account"])) return "an entry is not { pubkey, account }";
    const account = entry["account"];
    const data = account["data"];
    if (!Array.isArray(data) || data[1] !== "base64" || typeof data[0] !== "string") return "an entry's data is not [base64, \"base64\"]";
    // OWNED BY THE PROGRAM, OR NOT A LINK. V1 cannot answer otherwise — it is
    // the definition of the call — and V2 is a provider's extension: checked.
    if (account["owner"] !== programId.toBase58()) return "an entry is not owned by the program";
    let pubkey: PublicKey;
    try {
      pubkey = new PublicKey(entry["pubkey"]);
    } catch {
      return "an entry's pubkey is not a base-58 public key";
    }
    accounts.push({ pubkey, data: Buffer.from(data[0], "base64") });
  }
  return { accounts, paginationKey: typeof key === "string" && key !== "" ? key : null };
}

/**
 * Every trading link, through Helius's getProgramAccountsV2.
 *
 * HAND-BUILT JSON-RPC OVER THE KEEPER'S OWN TRANSPORT. web3.js has no method
 * for it, and `rpc` is the pool's fetch (src/rpc-pool.ts) — the same one the
 * Connection uses — so the request inherits the failover, the cooldown and
 * /health's progress clock, and is named by position, never by URL.
 *
 * PAGINATION TO THE END. Helius ends a listing ONLY with a null paginationKey:
 * a page shorter than the limit, even an empty one carrying a key, is not the
 * end, because its filters run after the page is cut (the page's own warning).
 * So a four-link fleet may cost two pages, two credits, against V1's ten.
 *
 * THROWS GpaV2Unavailable for anything it cannot use — a JSON-RPC error (the
 * non-Helius endpoint's "method not found" arrives as HTTP 200, which the pool
 * does not fail over on), a malformed page, too many pages, or a transport
 * failure — and the caller falls back to V1 in the same sweep.
 */
export async function listLinksV2(
  rpc: typeof fetch,
  programId: PublicKey,
  discriminator: Buffer,
  options: { readonly pageLimit?: number; readonly maxPages?: number } = {},
): Promise<{ readonly links: ManagedLink[]; readonly requests: number }> {
  const pageLimit = options.pageLimit ?? GPA_V2_PAGE_LIMIT;
  const maxPages = options.maxPages ?? GPA_V2_MAX_PAGES;
  const links: ManagedLink[] = [];
  let paginationKey: string | null = null;
  let requests = 0;
  do {
    if (requests >= maxPages) {
      throw new GpaV2Unavailable(`getProgramAccountsV2 was still paginating after ${maxPages} pages`, requests);
    }
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: `sip-gpa-v2-${(rpcIds += 1)}`,
      method: "getProgramAccountsV2",
      params: [
        programId.toBase58(),
        {
          commitment: "confirmed",
          encoding: "base64",
          filters: [{ dataSize: TRADING_LINK_SPACE }],
          limit: pageLimit,
          ...(paginationKey === null ? {} : { paginationKey }),
        },
      ],
    });
    requests += 1;
    let reply: unknown;
    try {
      const response = await rpc("about:sip-gpa-v2", { method: "POST", headers: { "content-type": "application/json" }, body });
      reply = await response.json();
    } catch (error) {
      // THE NAME, NOT THE MESSAGE: the pool's own refusal names endpoints by
      // position, but a fetch error from below it can quote the host.
      throw new GpaV2Unavailable(`getProgramAccountsV2 could not be asked (${error instanceof Error ? error.name : "unknown"})`, requests);
    }
    if (!isRecord(reply)) throw new GpaV2Unavailable("getProgramAccountsV2 answered something that is not a JSON-RPC reply", requests);
    if (reply["error"] !== undefined && reply["error"] !== null) {
      const error = reply["error"];
      const code = isRecord(error) && typeof error["code"] === "number" ? error["code"] : "no code";
      throw new GpaV2Unavailable(`getProgramAccountsV2 answered a JSON-RPC error (${code})`, requests);
    }
    const page = readV2Page(reply["result"], programId);
    if (typeof page === "string") throw new GpaV2Unavailable(`getProgramAccountsV2 answered a malformed page: ${page}`, requests);
    for (const { pubkey, data } of page.accounts) {
      const link = decodeTradingLink(pubkey, data, discriminator);
      if (link !== null) links.push(link);
    }
    paginationKey = page.paginationKey;
  } while (paginationKey !== null);
  return { links, requests };
}

/**
 * Every trading link, V2 first and V1 as the fallback IN THE SAME SWEEP.
 *
 * NOTHING IS LATCHED. A sweep that fell back tries V2 again next time: an
 * endpoint 1 that was down for a minute must not cost the V2 saving for the
 * rest of the container's life, and an endpoint that never speaks V2 costs one
 * failed request a sweep, which is free on a provider that does not bill it.
 *
 * DEDUPLICATED BY ADDRESS. A listing over more than one page is not atomic; an
 * account that moves between pages could be returned twice, and a link turned
 * twice in one sweep would be measured twice. V1 is one call and needs nothing.
 */
export async function discoverLinksPreferringV2(
  connection: Connection,
  programId: PublicKey,
  discriminator: Buffer,
  rpc: typeof fetch,
  options: { readonly pageLimit?: number; readonly maxPages?: number } = {},
): Promise<DiscoveryReport> {
  try {
    const { links, requests } = await listLinksV2(rpc, programId, discriminator, options);
    const seen = new Set<string>();
    const unique = links.filter((link) => {
      const key = link.linkAddress.toBase58();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { links: unique, method: "v2", requests };
  } catch (error) {
    const spent = error instanceof GpaV2Unavailable ? error.requests : 1;
    const fallbackReason = error instanceof GpaV2Unavailable ? error.message : `getProgramAccountsV2 failed (${error instanceof Error ? error.name : "unknown"})`;
    // V1's own failure propagates unchanged: it is today's sweep-failed, or L3's.
    const links = await discoverLinks(connection, programId, discriminator);
    return { links, method: "v1-fallback", requests: spent + 1, fallbackReason };
  }
}

/** getMultipleAccounts takes at most 100 addresses per request. */
export const MULTIPLE_ACCOUNTS_CHUNK = 100;

/**
 * The links at `addresses`, read FRESH from the chain: L3's re-read.
 *
 * WHY NOT JUST THE CACHED LINKS. The attester signs the link's NONCE and
 * FRONTIER (attestation.rs), and both move at every settle; a sweep that turned
 * a cached ManagedLink would measure from a stale frontier and attest a nonce
 * the program refuses — or, worse, one it accepts for a window already charged.
 * So the last-known-good list keeps only ADDRESSES, and every field the money
 * path reads comes from this read.
 *
 * A CLOSED LINK DISAPPEARS: an address that answers no account, an account the
 * program no longer owns, or bytes that are not a TradingLink is dropped — the
 * same as the listing would have dropped it. A REFUSED REQUEST THROWS, so a
 * sweep that can neither list nor re-read fails as it does today.
 */
export async function rereadLinks(
  connection: Connection,
  addresses: readonly PublicKey[],
  programId: PublicKey,
  discriminator: Buffer,
): Promise<ManagedLink[]> {
  const links: ManagedLink[] = [];
  for (let start = 0; start < addresses.length; start += MULTIPLE_ACCOUNTS_CHUNK) {
    const chunk = addresses.slice(start, start + MULTIPLE_ACCOUNTS_CHUNK);
    const accounts = await connection.getMultipleAccountsInfo([...chunk], "confirmed");
    chunk.forEach((address, index) => {
      const account = accounts[index];
      if (account === null || account === undefined || !account.owner.equals(programId)) return;
      const link = decodeTradingLink(address, account.data, discriminator);
      if (link !== null) links.push(link);
    });
  }
  return links;
}
