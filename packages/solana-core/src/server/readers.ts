// Server-side chain reads over the pool, with three honest outcomes.
//
// "exists", "missing" (the chain answered: there is no such account) and
// "unreadable" (it could not be asked, or what came back is not ours) are never
// conflated: offering create_vault when a read merely failed is how a user is
// asked to sign something the chain must refuse.
//
// Ported from Nuvem solana.ts (readSolanaVault, readSolanaLink, readSolanaPolicy,
// listVaultLinks, listVaultHoldings), keeping its anti-forgery gate — an account
// is decoded only when the SIP program owns it — and adding the V2 reads:
// ProtocolConfig, one-round-trip owner snapshots, and the vault history the
// browser relay no longer serves (getSignaturesForAddress, getTransaction and
// getProgramAccounts live here, behind the web's own routes).

import { RAYDIUM_CLMM, SOL_USDC_POOL, TOKEN_PROGRAMS } from "../client/addresses";
import { isBase58OfLength, isPubkey, isSignature, tryBase58Decode } from "../client/base58";
import { tryBase64Decode } from "../client/base64";
import { fieldOffset } from "../client/borsh";
import { PoolPriceError, legUsdcWad, solUsdcConvertWad } from "../client/clmm-price";
import { OFFERED_LEGS } from "../client/product";
import {
  SIP_ACCOUNT_SPACE,
  decodeInvestmentPolicy,
  decodeProtocolConfig,
  decodeSettledEvent,
  decodeTradingLink,
  decodeVault,
  type InvestmentPolicyState,
  type ProtocolConfigState,
  type SettledEvent,
  type TradingLinkState,
  type VaultState,
} from "../client/decoders";
import { SIP_PROGRAM_ID, matchInstruction } from "../client/idl";
import { deriveConfigPda, deriveInvestPda, deriveLinkPda, deriveVaultPda } from "./pda";
import { RpcAnswerError, type JsonRpcMember, type RpcPool } from "./rpc-pool";

export type ChainRead<T> =
  | { readonly kind: "exists"; readonly value: T }
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable"; readonly error: string };

interface RpcAccount {
  readonly data: unknown;
  readonly lamports: number;
  readonly owner: string;
}

const COMMITMENT = "confirmed";

function errorText(pool: RpcPool, error: unknown): string {
  return pool.scrub(error instanceof Error ? error.message : String(error));
}

function accountBytes(account: RpcAccount): Uint8Array | null {
  const data = account.data;
  if (!Array.isArray(data) || data[1] !== "base64" || typeof data[0] !== "string") return null;
  return tryBase64Decode(data[0]);
}

/** The anti-forgery gate, then the decoder. */
function decodeOwned<T>(account: RpcAccount | null | undefined, decode: (bytes: Uint8Array) => T): ChainRead<{ readonly state: T; readonly lamports: bigint }> {
  if (account === null || account === undefined) return { kind: "missing" };
  if (account.owner !== SIP_PROGRAM_ID) {
    return { kind: "unreadable", error: `the account is owned by ${account.owner}, not the SIP program; refusing to decode` };
  }
  const bytes = accountBytes(account);
  if (bytes === null) return { kind: "unreadable", error: "the account data is not base64" };
  try {
    return { kind: "exists", value: { state: decode(bytes), lamports: BigInt(account.lamports) } };
  } catch (error) {
    return { kind: "unreadable", error: error instanceof Error ? error.message : String(error) };
  }
}

function memberResult(members: readonly JsonRpcMember[], id: number): { ok: true; result: unknown } | { ok: false; error: string } {
  const member = members.find((candidate) => candidate?.id === id);
  if (member === undefined) return { ok: false, error: `the batch answer has no member ${id}` };
  if (member.error !== undefined && member.error !== null) return { ok: false, error: String(member.error.message ?? "error") };
  return { ok: true, result: member.result };
}

export interface VaultRead {
  readonly address: string;
  readonly state: VaultState;
  readonly lamports: bigint;
  /** Read from the RPC for the vault's size, not derived: rent parameters are consensus state. */
  readonly rentFloor: bigint;
  /** lamports − rentFloor, never negative: what withdraw() allows. */
  readonly withdrawableLamports: bigint;
}

export interface AccountRead<T> {
  readonly address: string;
  readonly state: T;
  readonly lamports: bigint;
}

async function readOne<T>(pool: RpcPool, address: string, decode: (bytes: Uint8Array) => T): Promise<ChainRead<AccountRead<T>>> {
  if (!isPubkey(address)) return { kind: "unreadable", error: "not a base58 32-byte address" };
  try {
    const result = await pool.call<{ value: RpcAccount | null }>("getAccountInfo", [address, { encoding: "base64", commitment: COMMITMENT }]);
    const read = decodeOwned(result?.value, decode);
    return read.kind === "exists" ? { kind: "exists", value: { address, ...read.value } } : read;
  } catch (error) {
    return { kind: "unreadable", error: errorText(pool, error) };
  }
}

function withRent(address: string, read: ChainRead<{ state: VaultState; lamports: bigint }>, floor: unknown): ChainRead<VaultRead> {
  if (read.kind !== "exists") return read;
  if (typeof floor !== "number" || !Number.isSafeInteger(floor)) return { kind: "unreadable", error: "the rent floor could not be read" };
  const rentFloor = BigInt(floor);
  const free = read.value.lamports - rentFloor;
  return { kind: "exists", value: { address, state: read.value.state, lamports: read.value.lamports, rentFloor, withdrawableLamports: free > 0n ? free : 0n } };
}

/** One vault by address, with its rent floor, in one batch round trip. */
export async function readVault(pool: RpcPool, vault: string): Promise<ChainRead<VaultRead>> {
  if (!isPubkey(vault)) return { kind: "unreadable", error: "not a base58 32-byte address" };
  try {
    const members = await pool.batch([
      { id: 1, method: "getAccountInfo", params: [vault, { encoding: "base64", commitment: COMMITMENT }] },
      { id: 2, method: "getMinimumBalanceForRentExemption", params: [SIP_ACCOUNT_SPACE.Vault] },
    ]);
    const info = memberResult(members, 1);
    if (!info.ok) return { kind: "unreadable", error: pool.scrub(info.error) };
    const read = decodeOwned((info.result as { value?: RpcAccount | null })?.value, decodeVault);
    if (read.kind !== "exists") return read;
    const floor = memberResult(members, 2);
    return floor.ok ? withRent(vault, read, floor.result) : { kind: "unreadable", error: pool.scrub(floor.error) };
  } catch (error) {
    return { kind: "unreadable", error: errorText(pool, error) };
  }
}

export const readLink = (pool: RpcPool, link: string): Promise<ChainRead<AccountRead<TradingLinkState>>> => readOne(pool, link, decodeTradingLink);

export const readPolicy = (pool: RpcPool, policy: string): Promise<ChainRead<AccountRead<InvestmentPolicyState>>> =>
  readOne(pool, policy, decodeInvestmentPolicy);

/** The protocol config at ["config"]. `paused` there stops settle and invest for every vault. */
export const readProtocolConfig = (pool: RpcPool): Promise<ChainRead<AccountRead<ProtocolConfigState>>> =>
  readOne(pool, deriveConfigPda().toBase58(), decodeProtocolConfig);

export interface OwnerAccounts {
  readonly owner: string;
  readonly vaultAddress: string;
  readonly policyAddress: string;
  readonly configAddress: string;
  readonly vault: ChainRead<VaultRead>;
  readonly policy: ChainRead<AccountRead<InvestmentPolicyState>>;
  readonly config: ChainRead<AccountRead<ProtocolConfigState>>;
}

/** Vault, policy and protocol config for one owner in ONE round trip (getMultipleAccounts + the rent floor). */
export async function readOwnerAccounts(pool: RpcPool, owner: string): Promise<OwnerAccounts> {
  if (!isPubkey(owner)) throw new RangeError("readOwnerAccounts: owner is not a base58 32-byte key");
  const vaultAddress = deriveVaultPda(owner).toBase58();
  const policyAddress = deriveInvestPda(vaultAddress).toBase58();
  const configAddress = deriveConfigPda().toBase58();
  const base = { owner, vaultAddress, policyAddress, configAddress };
  const failAll = (error: string): OwnerAccounts => {
    const unreadable = { kind: "unreadable" as const, error };
    return { ...base, vault: unreadable, policy: unreadable, config: unreadable };
  };
  try {
    const members = await pool.batch([
      { id: 1, method: "getMultipleAccounts", params: [[vaultAddress, policyAddress, configAddress], { encoding: "base64", commitment: COMMITMENT }] },
      { id: 2, method: "getMinimumBalanceForRentExemption", params: [SIP_ACCOUNT_SPACE.Vault] },
    ]);
    const accounts = memberResult(members, 1);
    if (!accounts.ok) return failAll(pool.scrub(accounts.error));
    const value = (accounts.result as { value?: unknown })?.value;
    if (!Array.isArray(value) || value.length !== 3) return failAll("getMultipleAccounts did not answer three accounts");
    const [vaultAccount, policyAccount, configAccount] = value as (RpcAccount | null)[];
    const floor = memberResult(members, 2);
    const vaultRead = decodeOwned(vaultAccount, decodeVault);
    const as = <T>(address: string, read: ChainRead<{ state: T; lamports: bigint }>): ChainRead<AccountRead<T>> =>
      read.kind === "exists" ? { kind: "exists", value: { address, ...read.value } } : read;
    return {
      ...base,
      vault: vaultRead.kind !== "exists" ? vaultRead : floor.ok ? withRent(vaultAddress, vaultRead, floor.result) : { kind: "unreadable", error: pool.scrub(floor.error) },
      policy: as(policyAddress, decodeOwned(policyAccount, decodeInvestmentPolicy)),
      config: as(configAddress, decodeOwned(configAccount, decodeProtocolConfig)),
    };
  } catch (error) {
    return failAll(errorText(pool, error));
  }
}

export interface VaultLink {
  /** The TradingLink PDA. */
  readonly address: string;
  readonly state: TradingLinkState;
}

/**
 * Every wallet currently linked to `vault`: unlink CLOSES the account, so
 * existence is membership. The RPC narrows by size and by the vault field; the
 * decoder then re-reads that field, because the RPC is not the trust boundary.
 */
export async function listVaultLinks(pool: RpcPool, vault: string): Promise<ChainRead<readonly VaultLink[]>> {
  if (!isPubkey(vault)) return { kind: "unreadable", error: "not a base58 32-byte address" };
  try {
    const result = await pool.call<readonly { pubkey: string; account: RpcAccount }[]>("getProgramAccounts", [
      SIP_PROGRAM_ID,
      {
        encoding: "base64",
        commitment: COMMITMENT,
        filters: [{ dataSize: SIP_ACCOUNT_SPACE.TradingLink }, { memcmp: { offset: 8 + fieldOffset("TradingLink", "vault"), bytes: vault } }],
      },
    ]);
    if (!Array.isArray(result)) return { kind: "unreadable", error: "getProgramAccounts did not answer a list" };
    const links: VaultLink[] = [];
    for (const entry of result) {
      const read = decodeOwned(entry?.account, decodeTradingLink);
      if (read.kind === "exists" && read.value.state.vault === vault && isPubkey(entry.pubkey)) {
        links.push({ address: entry.pubkey, state: read.value.state });
      }
    }
    return { kind: "exists", value: links };
  } catch (error) {
    return { kind: "unreadable", error: errorText(pool, error) };
  }
}

export interface VaultHolding {
  /** The token account holding it: what withdraw_token's vaultToken should be. */
  readonly tokenAccount: string;
  readonly mint: string;
  /** Raw units: what a transfer moves. */
  readonly amountRaw: bigint;
  readonly decimals: number;
  /**
   * The RPC's display amount. NOT derivable from amountRaw for xStocks
   * (Token-2022 scaledUiAmount): display this, transfer amountRaw.
   */
  readonly uiAmount: string;
  readonly tokenProgram: string;
}

/** Every non-zero token balance the vault owns, under both token programs. */
export async function listVaultHoldings(pool: RpcPool, vault: string): Promise<ChainRead<readonly VaultHolding[]>> {
  if (!isPubkey(vault)) return { kind: "unreadable", error: "not a base58 32-byte address" };
  try {
    const members = await pool.batch(
      TOKEN_PROGRAMS.map((programId, index) => ({
        id: index + 1,
        method: "getTokenAccountsByOwner",
        params: [vault, { programId }, { encoding: "jsonParsed", commitment: COMMITMENT }],
      })),
    );
    const holdings: VaultHolding[] = [];
    for (const [index, tokenProgram] of TOKEN_PROGRAMS.entries()) {
      const answer = memberResult(members, index + 1);
      if (!answer.ok) return { kind: "unreadable", error: pool.scrub(answer.error) };
      const value = (answer.result as { value?: unknown })?.value;
      if (!Array.isArray(value)) return { kind: "unreadable", error: "getTokenAccountsByOwner did not answer a list" };
      for (const entry of value as { pubkey?: string; account?: { data?: { parsed?: { info?: Record<string, unknown> } } } }[]) {
        const info = entry.account?.data?.parsed?.info as
          | { mint?: string; owner?: string; tokenAmount?: { amount?: string; decimals?: number; uiAmountString?: string } }
          | undefined;
        const amount = info?.tokenAmount?.amount;
        if (info === undefined || typeof amount !== "string" || !/^[0-9]+$/.test(amount) || !isPubkey(info.mint) || !isPubkey(entry.pubkey)) continue;
        if (info.owner !== undefined && info.owner !== vault) continue;
        if (amount === "0") continue;
        holdings.push({
          tokenAccount: entry.pubkey,
          mint: info.mint,
          amountRaw: BigInt(amount),
          decimals: Number(info.tokenAmount?.decimals ?? 0),
          uiAmount: String(info.tokenAmount?.uiAmountString ?? ""),
          tokenProgram,
        });
      }
    }
    return { kind: "exists", value: holdings };
  } catch (error) {
    return { kind: "unreadable", error: errorText(pool, error) };
  }
}

// ── the vault screens' reads ─────────────────────────────────────────────────

const addressed = <T>(address: string, read: ChainRead<{ state: T; lamports: bigint }>): ChainRead<AccountRead<T>> =>
  read.kind === "exists" ? { kind: "exists", value: { address, ...read.value } } : read;

/** How many trading wallets one read asks about: one getMultipleAccounts. */
export const MAX_WALLET_LINKS = 10;

export type WalletLinkStatus = "missing" | "this_vault" | "other_vault" | "unreadable";

export interface WalletLinkRead {
  readonly wallet: string;
  /** ["link", wallet] */
  readonly link: string;
  readonly status: WalletLinkStatus;
  /** The vault the link saves into, when it was read. */
  readonly vault: string | null;
}

/**
 * Where each trading wallet saves: ["link", wallet] for up to MAX_WALLET_LINKS
 * wallets in ONE getMultipleAccounts, compared with `vault` (the pension key's).
 * "missing" only when the chain answered null. A link the SIP program does not
 * own, that does not decode, or that names another wallet is "unreadable", and
 * so is every wallet when the read fails: offering a link over any of them would
 * ask for signatures the chain refuses.
 */
export async function readWalletLinks(pool: RpcPool, vault: string, wallets: readonly string[]): Promise<readonly WalletLinkRead[]> {
  if (!isPubkey(vault)) throw new RangeError("readWalletLinks: vault is not a base58 32-byte key");
  if (wallets.length > MAX_WALLET_LINKS || !wallets.every((wallet) => isPubkey(wallet))) {
    throw new RangeError(`readWalletLinks: 0 to ${MAX_WALLET_LINKS} base58 32-byte wallets`);
  }
  if (wallets.length === 0) return [];
  const links = wallets.map((wallet) => deriveLinkPda(wallet).toBase58());
  const allUnreadable = (): WalletLinkRead[] => wallets.map((wallet, index) => ({ wallet, link: links[index]!, status: "unreadable", vault: null }));
  let value: unknown;
  try {
    value = (await pool.call<{ value?: unknown }>("getMultipleAccounts", [links, { encoding: "base64", commitment: COMMITMENT }]))?.value;
  } catch {
    return allUnreadable();
  }
  if (!Array.isArray(value) || value.length !== wallets.length) return allUnreadable();
  return wallets.map((wallet, index): WalletLinkRead => {
    const link = links[index]!;
    const read = decodeOwned((value as unknown[])[index] as RpcAccount | null, decodeTradingLink);
    if (read.kind === "missing") return { wallet, link, status: "missing", vault: null };
    if (read.kind === "unreadable" || read.value.state.wallet !== wallet) return { wallet, link, status: "unreadable", vault: null };
    return { wallet, link, status: read.value.state.vault === vault ? "this_vault" : "other_vault", vault: read.value.state.vault };
  });
}

export interface LinkPrerequisites {
  readonly vaultAddress: string;
  readonly configAddress: string;
  readonly linkAddress: string;
  readonly vault: ChainRead<AccountRead<VaultState>>;
  readonly config: ChainRead<AccountRead<ProtocolConfigState>>;
  /** Unreadable, not exists, when the account at ["link", wallet] names another wallet. */
  readonly link: ChainRead<AccountRead<TradingLinkState>>;
}

/** What link_wallet loads: the owner's vault, the protocol config and ["link", wallet], in ONE getMultipleAccounts. */
export async function readLinkPrerequisites(pool: RpcPool, owner: string, wallet: string): Promise<LinkPrerequisites> {
  if (!isPubkey(owner) || !isPubkey(wallet)) throw new RangeError("readLinkPrerequisites: owner and wallet are base58 32-byte keys");
  const vaultAddress = deriveVaultPda(owner).toBase58();
  const configAddress = deriveConfigPda().toBase58();
  const linkAddress = deriveLinkPda(wallet).toBase58();
  const base = { vaultAddress, configAddress, linkAddress };
  const failAll = (error: string): LinkPrerequisites => {
    const unreadable = { kind: "unreadable" as const, error };
    return { ...base, vault: unreadable, config: unreadable, link: unreadable };
  };
  try {
    const result = await pool.call<{ value?: unknown }>("getMultipleAccounts", [[vaultAddress, configAddress, linkAddress], { encoding: "base64", commitment: COMMITMENT }]);
    const value = result?.value;
    if (!Array.isArray(value) || value.length !== 3) return failAll("getMultipleAccounts did not answer three accounts");
    const [vaultAccount, configAccount, linkAccount] = value as (RpcAccount | null)[];
    const link = addressed(linkAddress, decodeOwned(linkAccount, decodeTradingLink));
    return {
      ...base,
      vault: addressed(vaultAddress, decodeOwned(vaultAccount, decodeVault)),
      config: addressed(configAddress, decodeOwned(configAccount, decodeProtocolConfig)),
      link: link.kind === "exists" && link.value.state.wallet !== wallet ? { kind: "unreadable", error: "the account at ['link', wallet] names another wallet" } : link,
    };
  } catch (error) {
    return failAll(errorText(pool, error));
  }
}

export interface PoolPrices {
  /** The slot the pools were read at, or null when the RPC did not say. */
  readonly slot: number | null;
  /** USDC raw per lamport × 1e18, from SOL_USDC_POOL. */
  readonly convertWad: bigint;
  /** Each offered leg's raw units per USDC raw unit × 1e18, from its own pool, by mint. */
  readonly legWads: Readonly<Record<string, bigint>>;
}

/**
 * The live rates behind the floors and the forms' dollar figures: SOL_USDC_POOL
 * and every offered leg's pool in ONE getMultipleAccounts. Each pool must exist,
 * be owned by Raydium CLMM, and hold its mints in the pinned order. Anything else
 * is unreadable: a floor is never guessed.
 */
export async function readPoolPrices(pool: RpcPool): Promise<ChainRead<PoolPrices>> {
  const pools = [SOL_USDC_POOL, ...OFFERED_LEGS.map((leg) => leg.pool)];
  try {
    const result = await pool.call<{ context?: { slot?: unknown }; value?: unknown }>("getMultipleAccounts", [pools, { encoding: "base64", commitment: COMMITMENT }]);
    const value = result?.value;
    if (!Array.isArray(value) || value.length !== pools.length) return { kind: "unreadable", error: "getMultipleAccounts did not answer every pool" };
    const dataOf = (index: number): Uint8Array => {
      const account = value[index] as RpcAccount | null | undefined;
      if (account === null || account === undefined) throw new PoolPriceError(`the pool ${pools[index]} does not exist`);
      if (account.owner !== RAYDIUM_CLMM) throw new PoolPriceError(`the pool ${pools[index]} is owned by ${account.owner}, not Raydium CLMM`);
      const bytes = accountBytes(account);
      if (bytes === null) throw new PoolPriceError(`the pool ${pools[index]}'s data is not base64`);
      return bytes;
    };
    const convertWad = solUsdcConvertWad(dataOf(0)).wad;
    const legWads: Record<string, bigint> = {};
    OFFERED_LEGS.forEach((leg, index) => {
      legWads[leg.mint] = legUsdcWad(dataOf(index + 1), leg.mint).wad;
    });
    const slot = typeof result?.context?.slot === "number" ? result.context.slot : null;
    return { kind: "exists", value: { slot, convertWad, legWads } };
  } catch (error) {
    return { kind: "unreadable", error: error instanceof PoolPriceError ? error.message : errorText(pool, error) };
  }
}

export interface RecentBlockhashRead {
  readonly blockhash: string;
  readonly lastValidBlockHeight: number;
}

async function rentsAndBlockhash(
  pool: RpcPool,
  sizes: readonly number[],
  withBlockhash: boolean,
): Promise<ChainRead<{ readonly rents: readonly bigint[]; readonly recent: RecentBlockhashRead | null }>> {
  if (!sizes.every((size) => Number.isSafeInteger(size) && size >= 0)) throw new RangeError("rent sizes are byte counts");
  try {
    const rentCalls = sizes.map((size, index) => ({ id: index + 2, method: "getMinimumBalanceForRentExemption", params: [size] }));
    const members = await pool.batch(withBlockhash ? [{ id: 1, method: "getLatestBlockhash", params: [{ commitment: COMMITMENT }] }, ...rentCalls] : rentCalls);
    const rents: bigint[] = [];
    for (const index of sizes.keys()) {
      const answer = memberResult(members, index + 2);
      if (!answer.ok) return { kind: "unreadable", error: pool.scrub(answer.error) };
      if (typeof answer.result !== "number" || !Number.isSafeInteger(answer.result) || answer.result < 0) return { kind: "unreadable", error: "a rent-exempt minimum is not a number" };
      rents.push(BigInt(answer.result));
    }
    if (!withBlockhash) return { kind: "exists", value: { rents, recent: null } };
    const latest = memberResult(members, 1);
    if (!latest.ok) return { kind: "unreadable", error: pool.scrub(latest.error) };
    const answered = (latest.result as { value?: { blockhash?: unknown; lastValidBlockHeight?: unknown } } | null)?.value;
    const blockhash = answered?.blockhash;
    const lastValidBlockHeight = answered?.lastValidBlockHeight;
    if (!isBase58OfLength(blockhash, 32) || typeof lastValidBlockHeight !== "number" || !Number.isSafeInteger(lastValidBlockHeight)) {
      return { kind: "unreadable", error: "getLatestBlockhash did not answer a blockhash with its last valid block height" };
    }
    return { kind: "exists", value: { rents, recent: { blockhash, lastValidBlockHeight } } };
  } catch (error) {
    return { kind: "unreadable", error: errorText(pool, error) };
  }
}

/** Rent-exempt minimums for `sizes` (bytes, without the 128 of overhead), in one batch. Read, never derived. */
export async function readRents(pool: RpcPool, sizes: readonly number[]): Promise<ChainRead<readonly bigint[]>> {
  const read = await rentsAndBlockhash(pool, sizes, false);
  return read.kind === "exists" ? { kind: "exists", value: read.value.rents } : read;
}

/** The latest confirmed blockhash and the rent-exempt minimums for `sizes`, in ONE batch: what a build needs, read once. */
export async function readBlockhashAndRents(
  pool: RpcPool,
  sizes: readonly number[],
): Promise<ChainRead<{ readonly recent: RecentBlockhashRead; readonly rents: readonly bigint[] }>> {
  const read = await rentsAndBlockhash(pool, sizes, true);
  if (read.kind !== "exists" || read.value.recent === null) return read.kind === "exists" ? { kind: "unreadable", error: "no blockhash" } : read;
  return { kind: "exists", value: { recent: read.value.recent, rents: read.value.rents } };
}

// ── history ──────────────────────────────────────────────────────────────────

const INVOKE = /^Program (\S+) invoke \[\d+\]$/;
const EXIT = /^Program (\S+) (?:success|failed\b.*)$/;
const DATA = /^Program data: (.+)$/;

/**
 * Settled events from a transaction's log lines, scoped to the SIP program: a
 * `Program data:` line counts only while the SIP program is the one executing,
 * so another program cannot log bytes that read as a settlement.
 */
export function settledEventsFromLogs(logs: readonly string[] | null | undefined): SettledEvent[] {
  if (!Array.isArray(logs)) return [];
  const stack: string[] = [];
  const events: SettledEvent[] = [];
  for (const line of logs) {
    if (typeof line !== "string") continue;
    const invoke = INVOKE.exec(line);
    if (invoke !== null) {
      stack.push(invoke[1]!);
      continue;
    }
    const exit = EXIT.exec(line);
    if (exit !== null) {
      if (stack[stack.length - 1] === exit[1]) stack.pop();
      continue;
    }
    const data = DATA.exec(line);
    if (data === null || stack[stack.length - 1] !== SIP_PROGRAM_ID) continue;
    for (const part of data[1]!.trim().split(/\s+/)) {
      const bytes = tryBase64Decode(part);
      if (bytes === null) continue;
      try {
        events.push(decodeSettledEvent(bytes));
      } catch {
        // Another event type, or not an event: not a settlement.
      }
    }
  }
  return events;
}

export interface VaultActivityEntry {
  readonly signature: string;
  readonly slot: number;
  readonly blockTime: number | null;
  /** False when the transaction failed on chain. */
  readonly ok: boolean;
  readonly err: unknown;
  readonly fee: bigint | null;
  /** Top-level SIP instructions by IDL name (from their discriminators, not from log text). */
  readonly sipInstructions: readonly string[];
  /** The vault's SOL balance change in this transaction; null when the transaction could not be read. */
  readonly vaultLamportsDelta: bigint | null;
  readonly settled: readonly SettledEvent[];
}

export interface VaultActivityPage {
  readonly entries: readonly VaultActivityEntry[];
  /** Pass as `before` for the next page; null at the end. */
  readonly nextBefore: string | null;
}

export const MAX_ACTIVITY_PAGE = 25;

interface RpcTransaction {
  readonly slot?: number;
  readonly blockTime?: number | null;
  readonly meta?: {
    readonly err?: unknown;
    readonly fee?: number;
    readonly preBalances?: readonly number[];
    readonly postBalances?: readonly number[];
    readonly logMessages?: readonly string[] | null;
    readonly loadedAddresses?: { readonly writable?: readonly string[]; readonly readonly?: readonly string[] };
  } | null;
  readonly transaction?: {
    readonly message?: {
      readonly accountKeys?: readonly string[];
      readonly instructions?: readonly { readonly programIdIndex: number; readonly data: string }[];
    };
  };
}

function entryFrom(vault: string, signature: string, slot: number, blockTime: number | null, err: unknown, tx: RpcTransaction | null): VaultActivityEntry {
  if (tx === null || tx.transaction?.message === undefined) {
    return { signature, slot, blockTime, ok: err === null, err, fee: null, sipInstructions: [], vaultLamportsDelta: null, settled: [] };
  }
  const message = tx.transaction.message;
  const keys = [...(message.accountKeys ?? []), ...(tx.meta?.loadedAddresses?.writable ?? []), ...(tx.meta?.loadedAddresses?.readonly ?? [])];
  const sipInstructions: string[] = [];
  for (const instruction of message.instructions ?? []) {
    if (keys[instruction.programIdIndex] !== SIP_PROGRAM_ID) continue;
    const data = tryBase58DecodeLong(instruction.data);
    const matched = data === null ? null : matchInstruction(data);
    sipInstructions.push(matched?.name ?? "unknown");
  }
  const index = keys.indexOf(vault);
  const pre = tx.meta?.preBalances?.[index];
  const post = tx.meta?.postBalances?.[index];
  return {
    signature,
    slot: tx.slot ?? slot,
    blockTime: tx.blockTime ?? blockTime,
    ok: (tx.meta?.err ?? err) === null,
    err: tx.meta?.err ?? err,
    fee: typeof tx.meta?.fee === "number" ? BigInt(tx.meta.fee) : null,
    sipInstructions,
    vaultLamportsDelta: index >= 0 && typeof pre === "number" && typeof post === "number" ? BigInt(post) - BigInt(pre) : null,
    settled: settledEventsFromLogs(tx.meta?.logMessages),
  };
}

/** Instruction data can be longer than any key or signature, so it gets its own decoder bound. */
function tryBase58DecodeLong(text: string): Uint8Array | null {
  if (typeof text !== "string" || text.length > 2_000) return null;
  if (text.length <= 88) return tryBase58Decode(text);
  // Split-free long decode: same alphabet, BigInt accumulation.
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const char of text) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) return null;
    n = n * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const char of text) {
    if (char !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

/**
 * One page of the vault's history, newest first: getSignaturesForAddress (at most
 * 25) then every transaction in ONE batch. Server-side only — the browser relay
 * does not serve either method.
 */
export async function listVaultActivity(
  pool: RpcPool,
  vault: string,
  options: { readonly limit?: number; readonly before?: string } = {},
): Promise<ChainRead<VaultActivityPage>> {
  const limit = options.limit ?? MAX_ACTIVITY_PAGE;
  if (!isPubkey(vault)) return { kind: "unreadable", error: "not a base58 32-byte address" };
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ACTIVITY_PAGE) throw new RangeError(`listVaultActivity: limit must be 1..${MAX_ACTIVITY_PAGE}`);
  if (options.before !== undefined && !isSignature(options.before)) throw new RangeError("listVaultActivity: before must be a signature");
  try {
    const signatures = await pool.call<readonly { signature: string; slot: number; blockTime?: number | null; err: unknown }[]>("getSignaturesForAddress", [
      vault,
      { limit, commitment: COMMITMENT, ...(options.before === undefined ? {} : { before: options.before }) },
    ]);
    if (!Array.isArray(signatures)) return { kind: "unreadable", error: "getSignaturesForAddress did not answer a list" };
    const listed = signatures.filter((entry) => isSignature(entry?.signature));
    if (listed.length === 0) return { kind: "exists", value: { entries: [], nextBefore: null } };
    const members = await pool.batch(
      listed.map((entry, index) => ({
        id: index + 1,
        method: "getTransaction",
        params: [entry.signature, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: COMMITMENT }],
      })),
    );
    const entries = listed.map((entry, index) => {
      const answer = memberResult(members, index + 1);
      const tx = answer.ok ? ((answer.result as RpcTransaction | null) ?? null) : null;
      return entryFrom(vault, entry.signature, entry.slot, entry.blockTime ?? null, entry.err ?? null, tx);
    });
    return { kind: "exists", value: { entries, nextBefore: listed.length === limit ? listed[listed.length - 1]!.signature : null } };
  } catch (error) {
    if (error instanceof RpcAnswerError) return { kind: "unreadable", error: pool.scrub(error.message) };
    return { kind: "unreadable", error: errorText(pool, error) };
  }
}
