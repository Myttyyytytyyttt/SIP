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

import { PublicKey } from "@solana/web3.js";

import {
  PYTH_RECEIVER_PROGRAM,
  PYTH_SOL_USD_FEED,
  PYTH_USDC_USD_FEED,
  RAYDIUM_CLMM,
  SOL_USDC_POOL,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  TOKEN_PROGRAMS,
  USDC_MINT,
  WSOL_MINT,
} from "../client/addresses";
import { base58Encode, isBase58OfLength, isPubkey, isSignature, tryBase58Decode } from "../client/base58";
import { tryBase64Decode } from "../client/base64";
import type { ClassifiableEntry, SipInstructionCall, VaultTokenDelta } from "../client/activity";
import { decodeArgs, fieldOffset } from "../client/borsh";
import { PoolPriceError, legUsdcWad, solUsdcConvertWad } from "../client/clmm-price";
import { PythPriceError, solUsdcPythWad, type SolUsdcPythRate } from "../client/pyth-price";
import { CLASSIC_TOKEN_ACCOUNT_BYTES, OFFERED_LEGS } from "../client/product";
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
import { SIP_PROGRAM_ID, idlInstruction, matchInstruction } from "../client/idl";
import { deriveAta, deriveConfigPda, deriveInvestPda, deriveLinkPda, deriveVaultPda } from "./pda";
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
    return { kind: "unreadable", error: `the account is owned by ${account.owner}, not the SaverFi program; refusing to decode` };
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

/** The pools prices are read from, in order: SOL_USDC_POOL, then each offered leg's pool. */
export const PRICED_POOLS: readonly string[] = Object.freeze([SOL_USDC_POOL, ...OFFERED_LEGS.map((leg) => leg.pool)]);

/** An account as a read needs it: its owner, its lamports, and its bytes when they came as base64. */
export interface AccountSnapshot {
  readonly owner: string;
  readonly lamports: bigint;
  readonly data: Uint8Array | null;
}

/** null for an account the chain does not have; undefined for an answer that is not an account. */
function snapshotOf(account: unknown): AccountSnapshot | null | undefined {
  if (account === null) return null;
  const candidate = account as Partial<RpcAccount> | undefined;
  if (candidate === undefined || typeof candidate.owner !== "string" || typeof candidate.lamports !== "number" || !Number.isSafeInteger(candidate.lamports)) return undefined;
  return { owner: candidate.owner, lamports: BigInt(candidate.lamports), data: accountBytes(candidate as RpcAccount) };
}

/**
 * The rates from PRICED_POOLS' accounts, in that order. Each pool must exist, be
 * owned by Raydium CLMM, and hold its mints in the pinned order; anything else
 * throws PoolPriceError, because a floor is never guessed.
 */
export function poolPricesFromAccounts(accounts: readonly (AccountSnapshot | null | undefined)[], slot: number | null): PoolPrices {
  if (accounts.length !== PRICED_POOLS.length) throw new PoolPriceError("every priced pool must be read");
  const dataOf = (index: number): Uint8Array => {
    const account = accounts[index];
    if (account === null || account === undefined) throw new PoolPriceError(`the pool ${PRICED_POOLS[index]} does not exist`);
    if (account.owner !== RAYDIUM_CLMM) throw new PoolPriceError(`the pool ${PRICED_POOLS[index]} is owned by ${account.owner}, not Raydium CLMM`);
    if (account.data === null) throw new PoolPriceError(`the pool ${PRICED_POOLS[index]}'s data is not base64`);
    return account.data;
  };
  const convertWad = solUsdcConvertWad(dataOf(0)).wad;
  const legWads: Record<string, bigint> = {};
  OFFERED_LEGS.forEach((leg, index) => {
    legWads[leg.mint] = legUsdcWad(dataOf(index + 1), leg.mint).wad;
  });
  return { slot, convertWad, legWads };
}


// ── the pools' in-side reserves: the depth the keeper's gate measures ────────
//
// WHY A NUMBER CANNOT BE WRITTEN DOWN HERE. The panel's depth ceiling is a
// fraction of what a pool holds on the side a buy is PAID in, and that balance
// moves under it. The web's InvestingCard carries the last one anybody wrote
// down — 9,541,652,779 raw USDC in the ANTHROPIC/USDC pool at slot 448864213 —
// and two days later the same vault held 9,575,440,815, having been thousands of
// dollars lighter the night before that. A literal captured at a slot reads as
// current a month later and is wrong by then, so the reserve is read with
// everything else and the ceiling is arithmetic over it.
//
// THE IN SIDE, BECAUSE THAT IS THE SIDE THE KEEPER MEASURES. legDepthDecision
// (solana-keeper/src/invest-decision.ts) takes the pool's in_mint vault — not
// the stock vault — and refuses a turn whose per-leg spend is not covered
// MIN_POOL_DEPTH_MULTIPLE times over by it. The choice is copied here exactly,
// pair check included: a panel that measured the other side would promise
// precisely what the keeper then refuses.
//
// AND IT COSTS NO ROUND TRIP. The vault addresses live INSIDE the pool account
// (offsets 137 and 169), which is why the keeper needs a second
// getMultipleAccountsInfo for them — it reads pools an owner's policy names, at
// run time. This server reads a FIXED list of pools, and a Raydium CLMM vault is
// a PDA of ["pool_vault", pool, mint] under the CLMM program, so the address is
// known before any answer comes back and rides the same request. The derivation
// is never trusted on its own: the pool's own bytes must NAME the address that
// was asked for, or the reserve is unknown. A wrong seed cannot produce a wrong
// number here — only a missing one.

/** SPL Token's Account: mint(32) owner(32) amount(8, little-endian) — the amount at 64, in Token-2022 too. */
const TOKEN_ACCOUNT_AMOUNT_AT = 64;

/**
 * Raydium CLMM PoolState, at the offsets the keeper counts over the same bytes:
 * 8 disc, 1 bump, 32 amm_config, 32 owner, then token_mint_0 at 73, token_mint_1
 * at 105, token_vault_0 at 137, token_vault_1 at 169.
 */
const POOL_TOKEN_MINT_0_AT = 73;
const POOL_TOKEN_MINT_1_AT = 105;
const POOL_TOKEN_VAULT_0_AT = 137;
const POOL_TOKEN_VAULT_1_AT = 169;

/** Raydium CLMM's vault seed: ["pool_vault", pool, mint]. Checked against mainnet's own six vaults, and against each pool's bytes on every read. */
const POOL_VAULT_SEED = new TextEncoder().encode("pool_vault");

const RAYDIUM_CLMM_KEY = new PublicKey(RAYDIUM_CLMM);

/** Little-endian u64, the way i64At and u128At read their fields. */
function u64At(bytes: Uint8Array, at: number): bigint {
  let value = 0n;
  for (let i = 7; i >= 0; i--) value = (value << 8n) | BigInt(bytes[at + i]!);
  return value;
}

/** ["pool_vault", pool, mint] under the Raydium CLMM program: where that pool keeps that mint. */
export function deriveClmmPoolVault(pool: string, mint: string): string {
  return PublicKey.findProgramAddressSync([POOL_VAULT_SEED, new PublicKey(pool).toBytes(), new PublicKey(mint).toBytes()], RAYDIUM_CLMM_KEY)[0].toBase58();
}

/** One priced pool, the pair it must trade, and the vault its in-side reserve is read from. */
export interface PricedPoolPair {
  readonly pool: string;
  /** The side a spend is denominated in: sip-vault's in_mint, which this product pins to USDC. */
  readonly inMint: string;
  /** The other side — an offered leg, or wSOL for the pool the SOL hop converts through. */
  readonly otherMint: string;
  /** ["pool_vault", pool, inMint]: what the batch ASKS for. What it believes is what the pool's bytes name. */
  readonly inVault: string;
}

/**
 * PRICED_POOLS again, each with its pair and its in-side vault, IN PRICED_POOLS'
 * ORDER — reserves are matched to pools by index, so the two lists are one list
 * read twice. readers.test.ts holds them equal.
 */
export const PRICED_POOL_PAIRS: readonly PricedPoolPair[] = Object.freeze(
  [{ pool: SOL_USDC_POOL, otherMint: WSOL_MINT }, ...OFFERED_LEGS.map((leg) => ({ pool: leg.pool, otherMint: leg.mint }))].map((entry) =>
    Object.freeze({ ...entry, inMint: USDC_MINT, inVault: deriveClmmPoolVault(entry.pool, USDC_MINT) }),
  ),
);

/** The in-side vault addresses, in PRICED_POOL_PAIRS' order: what the snapshot appends to the read it was already making. */
export const PRICED_POOL_IN_VAULTS: readonly string[] = Object.freeze(PRICED_POOL_PAIRS.map((entry) => entry.inVault));

/** One priced pool's in-side reserve, or the reason there is none to report. */
export interface PoolReserveRead {
  readonly pool: string;
  /** The mint the reserve is counted in: USDC, the side a buy is paid in. */
  readonly inMint: string;
  /** The other side of the pair, so a caller can match a reserve to a leg without knowing this order. */
  readonly otherMint: string;
  /** The vault this read asked for, and the one the pool's own bytes had to name. */
  readonly vault: string;
  /**
   * Raw in_mint units held there, or NULL when it could not be read.
   *
   * NULL IS NOT ZERO, and the distinction is the whole point: zero is a pool
   * that has been drained, which a panel should shout about; null is a pool
   * nobody managed to ask, which it must not dress up as a dead basket.
   */
  readonly amountRaw: bigint | null;
  /** Why amountRaw is null; null when it was read. */
  readonly unreadable: string | null;
}

export interface PoolReserves {
  /** The slot the pools and their vaults were read at, or null when the RPC did not say. */
  readonly slot: number | null;
  /** One entry per priced pool, in PRICED_POOL_PAIRS' order, always the same length. */
  readonly items: readonly PoolReserveRead[];
}

/**
 * Each priced pool's in-side reserve, from the pool accounts and the vault
 * accounts of the SAME answer, by index.
 *
 * TOTAL BY CONSTRUCTION. It throws for nothing: every failure becomes that one
 * pool's `unreadable`, and the other pools keep their figures. A reserve is the
 * cheapest fact in the payload and the least allowed to take anything else down
 * with it — the prices above are decided from their own slice, before this runs.
 *
 * FOUR THINGS ARE CHECKED before a number is believed, and any of them failing
 * gives null rather than zero: the pool is Raydium's; it trades exactly
 * in_mint against the mint pinned for it (the registry checked against the
 * chain, which is also the only way these offsets could mean something else);
 * the vault it names on the in side is the one this read asked for; and that
 * account is a token account of in_mint under a token program.
 */
export function poolReservesFromAccounts(
  pools: readonly (AccountSnapshot | null | undefined)[],
  vaults: readonly (AccountSnapshot | null | undefined)[],
  slot: number | null,
): PoolReserves {
  const items = PRICED_POOL_PAIRS.map((pair, index): PoolReserveRead => {
    const base = { pool: pair.pool, inMint: pair.inMint, otherMint: pair.otherMint, vault: pair.inVault };
    const unknown = (why: string): PoolReserveRead => ({ ...base, amountRaw: null, unreadable: why });
    if (pools.length !== PRICED_POOL_PAIRS.length || vaults.length !== PRICED_POOL_PAIRS.length) {
      return unknown("the read did not answer every priced pool and its vault");
    }

    const pool = pools[index];
    if (pool === null || pool === undefined) return unknown("the pool account was not read, and a depth that cannot be measured is not a depth");
    if (pool.owner !== RAYDIUM_CLMM) return unknown(`the pool is owned by ${pool.owner}, not Raydium CLMM`);
    if (pool.data === null || pool.data.length < POOL_TOKEN_VAULT_1_AT + 32) {
      return unknown(`a Raydium CLMM pool state is at least ${POOL_TOKEN_VAULT_1_AT + 32} bytes to reach its vaults; this account is ${pool.data === null ? "not base64" : `${pool.data.length} bytes`}`);
    }
    const data = pool.data;
    const at = (offset: number): string => base58Encode(data.subarray(offset, offset + 32));
    const [mint0, mint1] = [at(POOL_TOKEN_MINT_0_AT), at(POOL_TOKEN_MINT_1_AT)];
    // THE KEEPER'S OWN CHOICE, COPIED: legDepthDecision admits the pool only when
    // it trades in_mint against this leg, either way round, and then measures the
    // vault on in_mint's side.
    const inIsZero = mint0 === pair.inMint && mint1 === pair.otherMint;
    const inIsOne = mint1 === pair.inMint && mint0 === pair.otherMint;
    if (!inIsZero && !inIsOne) return unknown(`the pool trades ${mint0} against ${mint1}, not ${pair.inMint} against ${pair.otherMint}`);
    const named = at(inIsZero ? POOL_TOKEN_VAULT_0_AT : POOL_TOKEN_VAULT_1_AT);
    if (named !== pair.inVault) return unknown(`the pool names ${named} as its ${pair.inMint} vault, and this read asked for ${pair.inVault}`);

    const vault = vaults[index];
    if (vault === null || vault === undefined) return unknown("the pool's in-side vault was not read, and an unread reserve is not an empty one");
    if (!TOKEN_PROGRAMS.some((programId) => programId === vault.owner)) return unknown(`the vault is owned by ${vault.owner}, not a token program`);
    if (vault.data === null || vault.data.length < TOKEN_ACCOUNT_AMOUNT_AT + 8) {
      return unknown(`a token account is at least ${TOKEN_ACCOUNT_AMOUNT_AT + 8} bytes to reach its amount; this account is ${vault.data === null ? "not base64" : `${vault.data.length} bytes`}`);
    }
    const held = base58Encode(vault.data.subarray(0, 32));
    if (held !== pair.inMint) return unknown(`the vault holds ${held}, not ${pair.inMint}`);
    return { ...base, amountRaw: u64At(vault.data, TOKEN_ACCOUNT_AMOUNT_AT), unreadable: null };
  });
  return { slot, items };
}

/** What readPoolDepth asks for, in this order: every priced pool, then every priced pool's in-side vault. */
const POOL_DEPTH_ADDRESSES: readonly string[] = Object.freeze([...PRICED_POOLS, ...PRICED_POOL_IN_VAULTS]);

/** The rates and the reserves of the same pools, at the same slot, each with its OWN outcome. */
export interface PoolDepth {
  readonly prices: ChainRead<PoolPrices>;
  readonly reserves: ChainRead<PoolReserves>;
}

/**
 * The live rates behind the floors and the forms' dollar figures, and the
 * reserves behind the depth ceiling beside them: PRICED_POOLS and their in-side
 * vaults in ONE getMultipleAccounts.
 *
 * TWO OUTCOMES OUT OF ONE ANSWER, AND NEITHER CAN REACH THE OTHER. Anything but
 * every pool, ours, in order, leaves `prices` unreadable: a floor is never
 * guessed. A vault that is not what its pool names leaves that one reserve
 * unknown and nothing else — the prices were already decided, from their own
 * slice of the same answer, by the same function they always were.
 */
export async function readPoolDepth(pool: RpcPool): Promise<PoolDepth> {
  let value: unknown[] | null = null;
  let slot: number | null = null;
  let failure = "getMultipleAccounts did not answer every pool";
  try {
    const result = await pool.call<{ context?: { slot?: unknown }; value?: unknown }>("getMultipleAccounts", [POOL_DEPTH_ADDRESSES, { encoding: "base64", commitment: COMMITMENT }]);
    const answered = result?.value;
    if (Array.isArray(answered) && answered.length === POOL_DEPTH_ADDRESSES.length) {
      value = answered as unknown[];
      slot = typeof result?.context?.slot === "number" ? result.context.slot : null;
    }
  } catch (error) {
    failure = error instanceof PoolPriceError ? error.message : errorText(pool, error);
  }
  if (value === null) return { prices: { kind: "unreadable", error: failure }, reserves: { kind: "unreadable", error: failure } };

  const poolAccounts = value.slice(0, PRICED_POOLS.length).map(snapshotOf);
  let prices: ChainRead<PoolPrices>;
  try {
    prices = { kind: "exists", value: poolPricesFromAccounts(poolAccounts, slot) };
  } catch (error) {
    prices = { kind: "unreadable", error: error instanceof PoolPriceError ? error.message : errorText(pool, error) };
  }
  let reserves: ChainRead<PoolReserves>;
  try {
    reserves = { kind: "exists", value: poolReservesFromAccounts(poolAccounts, value.slice(PRICED_POOLS.length).map(snapshotOf), slot) };
  } catch (error) {
    reserves = { kind: "unreadable", error: errorText(pool, error) };
  }
  return { prices, reserves };
}

/** Only the rates, for a caller that has no use for the reserves beside them: the same one call. */
export const readPoolPrices = async (pool: RpcPool): Promise<ChainRead<PoolPrices>> => (await readPoolDepth(pool)).prices;

// ── Pyth: beside the pools, never inside them ────────────────────────────────
//
// WHY THESE ARE NOT IN PRICED_POOLS. That constant is an offset basis, not a
// list of prices: the snapshot hands poolPricesFromAccounts a FIXED slice of one
// answer — values.slice(3, 3 + PRICED_POOLS.length) — and every index after it
// is counted from its length. A Pyth account inside PRICED_POOLS would be handed
// to the Raydium decoder, refused for the right reason, and would take the whole
// price panel down with it. Appended after the wallets, at the very END of the
// address array, a feed cannot reach that slice however the RPC answers it, and
// moves no index the pools, the links or the wallets are read at.
//
// WHY THE OWNER IS CHECKED HERE AND NOWHERE ELSE. A feed account is a PDA of the
// PUSH program, which does NOT own it — the RECEIVER does (addresses.ts spells
// out the pair). So a correct derivation proves nothing about who may write the
// bytes, and the bytes cannot say who wrote them: anyone who owns an account can
// fill it with a valid discriminator and the feed id we are looking for.
// decodePythPriceUpdate refuses the wrong FEED; only a read can refuse the wrong
// WRITER, so this one does, before a number is taken from it.

/**
 * The Clock sysvar, read in the same answer as the feeds so a publish age is
 * measured against the CHAIN's clock and never this host's: a server whose clock
 * has drifted must not be able to make a stale oracle look fresh, or a fresh one
 * stale. The keeper reads it the same way, in the same kind of one batch
 * (solana-keeper's invest-tick.ts).
 *
 * It sits here rather than in addresses.ts beside INSTRUCTIONS_SYSVAR, where it
 * belongs, only because that file was another session's while this was written.
 */
const SYSVAR_CLOCK = "SysvarC1ock11111111111111111111111111111111";

/** Clock is slot, epoch_start_timestamp, epoch and leader_schedule_epoch, THEN unix_timestamp: an i64 at byte 32, never byte 0. */
const CLOCK_UNIX_TIMESTAMP_AT = 32;
const CLOCK_BYTES = 40;

/** What the snapshot appends after its wallets, in this order: the chain's clock, then the two feeds. */
export const PYTH_SNAPSHOT_ADDRESSES: readonly string[] = Object.freeze([SYSVAR_CLOCK, PYTH_SOL_USD_FEED, PYTH_USDC_USD_FEED]);

export interface PythRead extends SolUsdcPythRate {
  /** The chain's unix_timestamp that ageSeconds was measured against, reported so the age can be checked rather than believed. */
  readonly chainUnixSeconds: bigint;
}

/** Two's complement over the 8 bytes at `at`, so a clock before 1970 reads negative instead of astronomical. */
function i64At(bytes: Uint8Array, at: number): bigint {
  let value = 0n;
  for (let i = 7; i >= 0; i--) value = (value << 8n) | BigInt(bytes[at + i]!);
  return value >= 1n << 63n ? value - (1n << 64n) : value;
}

/**
 * The oracle rate from PYTH_SNAPSHOT_ADDRESSES' accounts, in that order. Each
 * feed must exist, be owned by PYTH_RECEIVER_PROGRAM and carry the feed id
 * addresses.ts names for it, and the clock must be readable; anything else
 * throws PythPriceError, and the caller reports no oracle rather than a wrong one.
 *
 * THE CLOCK IS PART OF THE READ, not a detail of it. An age is the only thing
 * that separates a price from a number, so a rate whose age cannot be computed
 * is not published at all — reporting a WAD with no age invites exactly the use
 * a stale oracle must not have.
 */
export function pythFromAccounts(accounts: readonly (AccountSnapshot | null | undefined)[]): PythRead {
  if (accounts.length !== PYTH_SNAPSHOT_ADDRESSES.length) throw new PythPriceError("the chain's clock and both feeds must be read");
  const clock = accounts[0];
  if (clock === null || clock === undefined || clock.data === null || clock.data.length < CLOCK_BYTES) {
    throw new PythPriceError("the Clock sysvar could not be read, so a publish age would be this host's guess rather than the chain's");
  }
  const chainUnixSeconds = i64At(clock.data, CLOCK_UNIX_TIMESTAMP_AT);
  const feed = (index: number): Uint8Array => {
    const address = PYTH_SNAPSHOT_ADDRESSES[index]!;
    const account = accounts[index];
    if (account === null || account === undefined) throw new PythPriceError(`the feed ${address} does not exist`);
    if (account.owner !== PYTH_RECEIVER_PROGRAM) throw new PythPriceError(`the feed ${address} is owned by ${account.owner}, not the Pyth receiver ${PYTH_RECEIVER_PROGRAM}`);
    if (account.data === null) throw new PythPriceError(`the feed ${address}'s data is not base64`);
    return account.data;
  };
  return { ...solUsdcPythWad(feed(1), feed(2), chainUnixSeconds), chainUnixSeconds };
}

// ── the vault's token accounts ───────────────────────────────────────────────

export interface VaultTokenAccountTarget {
  readonly mint: string;
  /** ATA(vault, mint, tokenProgram). */
  readonly address: string;
  readonly tokenProgram: string;
  /** What the account takes once created: the size its rent is read for. */
  readonly bytes: number;
}

/** The vault's token accounts an investment policy needs, in the order the build route lists them: wSOL, USDC, then each offered leg. */
export function vaultTokenAccountTargets(vault: string): readonly VaultTokenAccountTarget[] {
  if (!isPubkey(vault)) throw new RangeError("vaultTokenAccountTargets: vault is not a base58 32-byte key");
  const entries = [
    { mint: WSOL_MINT, tokenProgram: TOKEN_PROGRAM, bytes: CLASSIC_TOKEN_ACCOUNT_BYTES },
    { mint: USDC_MINT, tokenProgram: TOKEN_PROGRAM, bytes: CLASSIC_TOKEN_ACCOUNT_BYTES },
    ...OFFERED_LEGS.map((leg) => ({ mint: leg.mint, tokenProgram: leg.tokenProgram, bytes: leg.tokenAccountBytes })),
  ];
  return entries.map((entry) => ({ ...entry, address: deriveAta(vault, entry.mint, entry.tokenProgram).toBase58() }));
}

/**
 * "exists" when the token program holds the account; "missing" when
 * CreateIdempotent must create it (no account, or only lamports someone sent to
 * the address first); "unreadable" for anything else, which no ATA address can be.
 */
export type TokenAccountStatus = "exists" | "missing" | "unreadable";

export function tokenAccountStatus(account: AccountSnapshot | null | undefined, tokenProgram: string): TokenAccountStatus {
  if (account === null) return "missing";
  if (account === undefined) return "unreadable";
  if (account.owner === tokenProgram) return "exists";
  if (account.owner === SYSTEM_PROGRAM && (account.data === null || account.data.length === 0)) return "missing";
  return "unreadable";
}

export interface VaultTokenAccountRead {
  readonly mint: string;
  readonly address: string;
  readonly tokenProgram: string;
  readonly status: TokenAccountStatus;
  /**
   * What it holds, when it exists and the RPC parsed it as the vault's own account
   * of this mint; null otherwise. A build never trusts it: the build route reads
   * the account's bytes again (readWithdrawTokenSource).
   */
  readonly amountRaw: bigint | null;
  readonly decimals: number | null;
  /** The RPC's display amount, never computed from amountRaw (SPYx's is scaled); null with amountRaw. */
  readonly uiAmount: string | null;
}

interface ParsedTokenInfo {
  readonly mint?: unknown;
  readonly owner?: unknown;
  readonly tokenAmount?: { readonly amount?: unknown; readonly decimals?: unknown; readonly uiAmountString?: unknown } | null;
}

/** What a jsonParsed token account holds, when it is `vault`'s own account of `mint`; null for anything else. */
function parsedBalance(account: unknown, vault: string, mint: string): { readonly amountRaw: bigint; readonly decimals: number; readonly uiAmount: string } | null {
  const parsed = (account as { data?: { parsed?: { type?: unknown; info?: ParsedTokenInfo } } } | null | undefined)?.data?.parsed;
  const info = parsed?.info;
  if (parsed?.type !== "account" || info?.mint !== mint || info.owner !== vault) return null;
  const amount = info.tokenAmount?.amount;
  const decimals = info.tokenAmount?.decimals;
  const uiAmount = info.tokenAmount?.uiAmountString;
  if (typeof amount !== "string" || !/^[0-9]+$/.test(amount) || typeof decimals !== "number" || !Number.isInteger(decimals) || typeof uiAmount !== "string") return null;
  return { amountRaw: BigInt(amount), decimals, uiAmount };
}

/**
 * Whether each of vaultTokenAccountTargets(vault) exists, and what each holds, in
 * ONE getMultipleAccounts (jsonParsed). A failed read is unreadable as a whole.
 *
 * READ BY ADDRESS, NEVER LISTED. Anyone can open token accounts whose owner is
 * the vault, and enough of them make listVaultHoldings' answer too large to read.
 * These few addresses — wSOL, USDC and one per offered leg — stay one small
 * answer, so the wallets screen can always offer the vault's own.
 */
export async function readVaultTokenAccounts(pool: RpcPool, vault: string): Promise<ChainRead<readonly VaultTokenAccountRead[]>> {
  const targets = vaultTokenAccountTargets(vault);
  try {
    const result = await pool.call<{ value?: unknown }>("getMultipleAccounts", [targets.map((target) => target.address), { encoding: "jsonParsed", commitment: COMMITMENT }]);
    const value = result?.value;
    if (!Array.isArray(value) || value.length !== targets.length) return { kind: "unreadable", error: "getMultipleAccounts did not answer every token account" };
    return {
      kind: "exists",
      value: targets.map((target, index): VaultTokenAccountRead => {
        const status = tokenAccountStatus(snapshotOf(value[index]), target.tokenProgram);
        const balance = status === "exists" ? parsedBalance(value[index], vault, target.mint) : null;
        return {
          mint: target.mint,
          address: target.address,
          tokenProgram: target.tokenProgram,
          status,
          amountRaw: balance?.amountRaw ?? null,
          decimals: balance?.decimals ?? null,
          uiAmount: balance?.uiAmount ?? null,
        };
      }),
    };
  } catch (error) {
    return { kind: "unreadable", error: errorText(pool, error) };
  }
}

// ── a token withdrawal's source ──────────────────────────────────────────────

/** A token account, decoded from its own bytes. */
export interface TokenAccountRead {
  readonly address: string;
  /** The program that holds it: SPL Token or Token-2022. */
  readonly tokenProgram: string;
  readonly mint: string;
  /** Its owner field: the key that may move it. */
  readonly owner: string;
  readonly amountRaw: bigint;
  /** Its state byte says frozen. */
  readonly frozen: boolean;
}

/** SPL Token's Account: every token account's first 165 bytes. */
const TOKEN_ACCOUNT_BYTES = 165;
/** A multisig: the one size past 165 that is not an account with extensions. */
const TOKEN_MULTISIG_BYTES = 355;
/** Token-2022's AccountType byte, at 165, for an account. */
const TOKEN_2022_ACCOUNT_TYPE = 2;
/** The state byte: 0 uninitialized, 1 initialized, 2 frozen. */
const TOKEN_ACCOUNT_STATE_OFFSET = 108;

/**
 * An initialized token account from its bytes, or null for anything else: an
 * account no token program holds, a mint, a multisig, an uninitialized account.
 * SPL Token's accounts are exactly 165 bytes; Token-2022's are 165, or longer
 * with the account type byte at 165 saying Account.
 */
export function tokenAccountFromSnapshot(address: string, account: AccountSnapshot | null | undefined): TokenAccountRead | null {
  if (account === null || account === undefined || account.data === null) return null;
  const { owner: tokenProgram, data } = account;
  if (tokenProgram !== TOKEN_PROGRAM && tokenProgram !== TOKEN_2022_PROGRAM) return null;
  const shaped =
    data.length === TOKEN_ACCOUNT_BYTES ||
    (tokenProgram === TOKEN_2022_PROGRAM && data.length > TOKEN_ACCOUNT_BYTES && data.length !== TOKEN_MULTISIG_BYTES && data[TOKEN_ACCOUNT_BYTES] === TOKEN_2022_ACCOUNT_TYPE);
  const state = data[TOKEN_ACCOUNT_STATE_OFFSET];
  if (!shaped || (state !== 1 && state !== 2)) return null;
  return {
    address,
    tokenProgram,
    mint: base58Encode(data.subarray(0, 32)),
    owner: base58Encode(data.subarray(32, 64)),
    amountRaw: new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(64, true),
    frozen: state === 2,
  };
}

export interface WithdrawTokenSourceRead {
  readonly vaultAddress: string;
  readonly vault: ChainRead<AccountRead<VaultState>>;
  /** "exists" with null: the chain holds an account there, and it is not an initialized token account. */
  readonly source: ChainRead<TokenAccountRead | null>;
}

/**
 * What a token withdrawal is checked against before it is built, in ONE
 * getMultipleAccounts: the owner's vault, and the token account named as its
 * source, decoded from its own bytes. Nothing is listed, so no number of token
 * accounts anyone opens for the vault can make this unreadable.
 */
export async function readWithdrawTokenSource(pool: RpcPool, owner: string, source: string): Promise<WithdrawTokenSourceRead> {
  if (!isPubkey(owner) || !isPubkey(source)) throw new RangeError("readWithdrawTokenSource: owner and source are base58 32-byte keys");
  const vaultAddress = deriveVaultPda(owner).toBase58();
  const failAll = (error: string): WithdrawTokenSourceRead => {
    const unreadable = { kind: "unreadable" as const, error };
    return { vaultAddress, vault: unreadable, source: unreadable };
  };
  try {
    const result = await pool.call<{ value?: unknown }>("getMultipleAccounts", [[vaultAddress, source], { encoding: "base64", commitment: COMMITMENT }]);
    const value = result?.value;
    if (!Array.isArray(value) || value.length !== 2) return failAll("getMultipleAccounts did not answer two accounts");
    const snapshot = snapshotOf(value[1]);
    return {
      vaultAddress,
      vault: addressed(vaultAddress, decodeOwned(value[0] as RpcAccount | null, decodeVault)),
      source:
        snapshot === undefined
          ? { kind: "unreadable", error: "getMultipleAccounts answered something that is not an account" }
          : snapshot === null
            ? { kind: "missing" }
            : { kind: "exists", value: tokenAccountFromSnapshot(source, snapshot) },
    };
  } catch (error) {
    return failAll(errorText(pool, error));
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

export interface BuildBatch {
  /** The slot getMultipleAccounts answered at, or null when none was asked or it did not say. */
  readonly slot: number | null;
  readonly recent: RecentBlockhashRead;
  /** In the order of `sizes`. */
  readonly rents: readonly bigint[];
  /** In the order of `addresses`; null where the chain has no account. */
  readonly accounts: readonly (AccountSnapshot | null)[];
}

/** One getMultipleAccounts is asked for at most this many addresses. */
export const MAX_BUILD_BATCH_ADDRESSES = 100;

/**
 * What a build reads right before it compiles, in ONE batch: the latest confirmed
 * blockhash, the accounts at `addresses` and the rent-exempt minimums for `sizes`.
 * A member that fails, or answers anything that is not what was asked, makes the
 * whole read unreadable: nothing is compiled over half an answer.
 */
export async function readBuildBatch(pool: RpcPool, input: { readonly addresses: readonly string[]; readonly sizes: readonly number[] }): Promise<ChainRead<BuildBatch>> {
  const { addresses, sizes } = input;
  if (addresses.length > MAX_BUILD_BATCH_ADDRESSES || !addresses.every((address) => isPubkey(address))) {
    throw new RangeError(`readBuildBatch: 0 to ${MAX_BUILD_BATCH_ADDRESSES} base58 32-byte addresses`);
  }
  if (!sizes.every((size) => Number.isSafeInteger(size) && size >= 0)) throw new RangeError("rent sizes are byte counts");
  const accountsId = 2;
  const rentId = (index: number): number => 3 + index;
  try {
    const calls: { id: number; method: string; params: unknown[] }[] = [{ id: 1, method: "getLatestBlockhash", params: [{ commitment: COMMITMENT }] }];
    if (addresses.length > 0) calls.push({ id: accountsId, method: "getMultipleAccounts", params: [addresses, { encoding: "base64", commitment: COMMITMENT }] });
    sizes.forEach((size, index) => calls.push({ id: rentId(index), method: "getMinimumBalanceForRentExemption", params: [size] }));
    const members = await pool.batch(calls);

    const latest = memberResult(members, 1);
    if (!latest.ok) return { kind: "unreadable", error: pool.scrub(latest.error) };
    const answered = (latest.result as { value?: { blockhash?: unknown; lastValidBlockHeight?: unknown } } | null)?.value;
    const blockhash = answered?.blockhash;
    const lastValidBlockHeight = answered?.lastValidBlockHeight;
    if (!isBase58OfLength(blockhash, 32) || typeof lastValidBlockHeight !== "number" || !Number.isSafeInteger(lastValidBlockHeight)) {
      return { kind: "unreadable", error: "getLatestBlockhash did not answer a blockhash with its last valid block height" };
    }

    let slot: number | null = null;
    const accounts: (AccountSnapshot | null)[] = [];
    if (addresses.length > 0) {
      const answer = memberResult(members, accountsId);
      if (!answer.ok) return { kind: "unreadable", error: pool.scrub(answer.error) };
      const result = answer.result as { context?: { slot?: unknown }; value?: unknown } | null;
      if (!Array.isArray(result?.value) || result.value.length !== addresses.length) return { kind: "unreadable", error: "getMultipleAccounts did not answer every address" };
      for (const account of result.value) {
        const snapshot = snapshotOf(account);
        if (snapshot === undefined) return { kind: "unreadable", error: "getMultipleAccounts answered something that is not an account" };
        accounts.push(snapshot);
      }
      slot = typeof result.context?.slot === "number" ? result.context.slot : null;
    }

    const rents: bigint[] = [];
    for (const index of sizes.keys()) {
      const answer = memberResult(members, rentId(index));
      if (!answer.ok) return { kind: "unreadable", error: pool.scrub(answer.error) };
      if (typeof answer.result !== "number" || !Number.isSafeInteger(answer.result) || answer.result < 0) return { kind: "unreadable", error: "a rent-exempt minimum is not a number" };
      rents.push(BigInt(answer.result));
    }
    return { kind: "exists", value: { slot, recent: { blockhash, lastValidBlockHeight }, rents, accounts } };
  } catch (error) {
    return { kind: "unreadable", error: errorText(pool, error) };
  }
}

// ── the live dashboard's one read ────────────────────────────────────────────

/** One trading wallet as the live dashboard reads it: what it holds, and where it saves. */
export interface LiveWalletRead {
  readonly wallet: string;
  /**
   * 0 when the chain answered that there is no such account; NULL when the read
   * failed. "It could not be read" is never shown as "it holds nothing".
   */
  readonly lamports: bigint | null;
  readonly link: {
    /** ["link", wallet] */
    readonly address: string;
    readonly status: WalletLinkStatus;
    /** The vault the link saves into, when it was read. */
    readonly vault: string | null;
    /**
     * The link itself, kept whole: readWalletLinks drops epoch, settlementNonce
     * and frontierSlot, and the dashboard counts settlements with them.
     */
    readonly state: TradingLinkState | null;
  };
}

export interface LiveSnapshot {
  /** The context slot of the account read, so the chart can leave out what it did not cover. */
  readonly slot: number | null;
  readonly owner: string;
  readonly vaultAddress: string;
  readonly policyAddress: string;
  readonly configAddress: string;
  readonly vault: ChainRead<VaultRead>;
  readonly policy: ChainRead<AccountRead<InvestmentPolicyState>>;
  readonly config: ChainRead<AccountRead<ProtocolConfigState>>;
  readonly prices: ChainRead<PoolPrices>;
  /** The oracle, apart from the venue: unreadable whenever a feed is, and never able to make `prices` unreadable. */
  readonly pyth: ChainRead<PythRead>;
  /**
   * What each priced pool holds on the side a buy is PAID in — the depth the
   * keeper's gate measures — so a panel can recompute its ceiling instead of
   * quoting a figure with a date on it. Beside `prices`, never inside it, and
   * unable to make it unreadable.
   */
  readonly reserves: ChainRead<PoolReserves>;
  readonly tokenAccounts: ChainRead<readonly VaultTokenAccountRead[]>;
  readonly rents: {
    readonly vault: bigint | null;
    /** rent(0): settle.rs's wallet floor, under which a settlement is refused. */
    readonly walletFloor: bigint | null;
  };
  readonly wallets: readonly LiveWalletRead[];
  /** Every link on chain, when `discover` asked for them; null when it did not. */
  readonly links: ChainRead<readonly VaultLink[]> | null;
}

export interface LiveSnapshotInput {
  readonly owner: string;
  /** 0 to MAX_WALLET_LINKS distinct trading wallets, none of them the owner. */
  readonly wallets: readonly string[];
  /** Also list every link the vault has on chain (getProgramAccounts). */
  readonly discover: boolean;
}

/** At most this many addresses go into the snapshot's getMultipleAccounts: 3 + 4 pools + 10 links + 10 wallets + the clock and 2 feeds + one vault per pool. */
export const MAX_LIVE_SNAPSHOT_ADDRESSES = 3 + PRICED_POOLS.length + 2 * MAX_WALLET_LINKS + PYTH_SNAPSHOT_ADDRESSES.length + PRICED_POOL_IN_VAULTS.length;

/**
 * EVERYTHING THE LIVE DASHBOARD SHOWS, IN ONE ROUND TRIP: the vault, its policy,
 * the protocol config, the pinned pools' prices, Pyth's view of SOL/USDC beside
 * them, the vault's own wSOL, USDC and per-leg accounts, two rents, each trading
 * wallet's balance and link — and, on demand, every link the vault has on chain.
 *
 * ONE BATCH, FIVE MEMBERS. A dashboard that polls every minute cannot afford a
 * read per fact, and the Helius key is the keeper's too.
 *
 * EVERY PART KEEPS ITS OWN OUTCOME, and decodeOwned stays the anti-forgery gate:
 * a link that names another wallet is unreadable, a pool the pinned check refuses
 * makes prices unreadable rather than wrong, and a member that fails takes down
 * only its own part. A failed batch makes every part unreadable — never missing,
 * because "no vault" is an invitation to create one the chain would refuse.
 *
 * READ BY ADDRESS, NEVER LISTED: the vault's token accounts are its own
 * associated addresses, so no number of accounts anyone opens for the vault can
 * make this unreadable (the reason readVaultTokenAccounts gives).
 *
 * THE ORACLE RIDES AT THE TAIL, and costs this batch nothing it was not already
 * paying: three more addresses in a getMultipleAccounts that was being sent
 * anyway. Appended AFTER the wallets it can reach neither the pools' fixed slice
 * nor any wallet's index, so a dead feed degrades to no oracle and leaves every
 * other part of the answer — the prices above all — exactly as it was.
 */
export async function readLiveSnapshot(pool: RpcPool, input: LiveSnapshotInput): Promise<LiveSnapshot> {
  const { owner, wallets, discover } = input;
  if (!isPubkey(owner)) throw new RangeError("readLiveSnapshot: owner is not a base58 32-byte key");
  if (wallets.length > MAX_WALLET_LINKS) throw new RangeError(`readLiveSnapshot: at most ${MAX_WALLET_LINKS} wallets`);
  if (!wallets.every((wallet) => isPubkey(wallet))) throw new RangeError("readLiveSnapshot: every wallet is a base58 32-byte key");
  if (new Set(wallets).size !== wallets.length) throw new RangeError("readLiveSnapshot: the wallets must be distinct");
  if (wallets.includes(owner)) throw new RangeError("readLiveSnapshot: a trading wallet cannot be the owner");

  const vaultAddress = deriveVaultPda(owner).toBase58();
  const policyAddress = deriveInvestPda(vaultAddress).toBase58();
  const configAddress = deriveConfigPda().toBase58();
  const linkAddresses = wallets.map((wallet) => deriveLinkPda(wallet).toBase58());
  const targets = vaultTokenAccountTargets(vaultAddress);
  const base = { owner, vaultAddress, policyAddress, configAddress };

  const failAll = (error: string): LiveSnapshot => {
    const unreadable = { kind: "unreadable" as const, error };
    return {
      ...base,
      slot: null,
      vault: unreadable,
      policy: unreadable,
      config: unreadable,
      prices: unreadable,
      pyth: unreadable,
      reserves: unreadable,
      tokenAccounts: unreadable,
      rents: { vault: null, walletFloor: null },
      wallets: wallets.map((wallet, index) => ({
        wallet,
        lamports: null,
        link: { address: linkAddresses[index]!, status: "unreadable" as const, vault: null, state: null },
      })),
      links: discover ? unreadable : null,
    };
  };

  // The tail is the only safe place for an account no existing index expects:
  // the pools are read from a fixed slice and the wallets from offsets counted
  // off PRICED_POOLS' length, so nothing appended here can be handed to either.
  // The vaults go AFTER the oracle for the same reason the oracle went after the
  // wallets: the oracle's index is counted off the wallets, so anything past it
  // moves nothing, and a vault can never be handed to the Raydium decoder.
  const addresses = [vaultAddress, policyAddress, configAddress, ...PRICED_POOLS, ...linkAddresses, ...wallets, ...PYTH_SNAPSHOT_ADDRESSES, ...PRICED_POOL_IN_VAULTS];
  const ACCOUNTS = 1;
  const TOKENS = 2;
  const RENT_VAULT = 3;
  const RENT_ZERO = 4;
  const LINKS = 5;

  try {
    const calls: { id: number; method: string; params: unknown[] }[] = [
      { id: ACCOUNTS, method: "getMultipleAccounts", params: [addresses, { encoding: "base64", commitment: COMMITMENT }] },
      { id: TOKENS, method: "getMultipleAccounts", params: [targets.map((target) => target.address), { encoding: "jsonParsed", commitment: COMMITMENT }] },
      { id: RENT_VAULT, method: "getMinimumBalanceForRentExemption", params: [SIP_ACCOUNT_SPACE.Vault] },
      { id: RENT_ZERO, method: "getMinimumBalanceForRentExemption", params: [0] },
    ];
    if (discover) {
      calls.push({
        id: LINKS,
        method: "getProgramAccounts",
        params: [
          SIP_PROGRAM_ID,
          {
            encoding: "base64",
            commitment: COMMITMENT,
            filters: [{ dataSize: SIP_ACCOUNT_SPACE.TradingLink }, { memcmp: { offset: 8 + fieldOffset("TradingLink", "vault"), bytes: vaultAddress } }],
          },
        ],
      });
    }
    const members = await pool.batch(calls);

    // ── member 1: the accounts ────────────────────────────────────────────────
    const answered = memberResult(members, ACCOUNTS);
    const accountsResult = answered.ok ? (answered.result as { context?: { slot?: unknown }; value?: unknown } | null) : null;
    const values = Array.isArray(accountsResult?.value) && accountsResult.value.length === addresses.length ? (accountsResult.value as (RpcAccount | null)[]) : null;
    const accountsError = !answered.ok ? pool.scrub(answered.error) : values === null ? "getMultipleAccounts did not answer every address" : null;
    const slot = typeof accountsResult?.context?.slot === "number" ? accountsResult.context.slot : null;
    const accountsUnreadable = { kind: "unreadable" as const, error: accountsError ?? "" };

    // ── members 3 and 4: the rents ────────────────────────────────────────────
    const rentOf = (id: number): bigint | null => {
      const answer = memberResult(members, id);
      return answer.ok && typeof answer.result === "number" && Number.isSafeInteger(answer.result) && answer.result >= 0 ? BigInt(answer.result) : null;
    };
    const vaultRent = rentOf(RENT_VAULT);
    const walletFloor = rentOf(RENT_ZERO);

    // ── the vault, its policy and the config ──────────────────────────────────
    const vaultRead = accountsError !== null ? accountsUnreadable : decodeOwned(values![0], decodeVault);
    const vault: ChainRead<VaultRead> =
      vaultRead.kind !== "exists"
        ? vaultRead
        : vaultRent === null
          ? { kind: "unreadable", error: "the rent floor could not be read" }
          : withRent(vaultAddress, vaultRead, Number(vaultRent));

    // ── the pinned pools ──────────────────────────────────────────────────────
    const poolAccounts = accountsError !== null ? [] : values!.slice(3, 3 + PRICED_POOLS.length).map(snapshotOf);
    let prices: ChainRead<PoolPrices>;
    if (accountsError !== null) {
      prices = accountsUnreadable;
    } else {
      try {
        prices = { kind: "exists", value: poolPricesFromAccounts(poolAccounts, slot) };
      } catch (error) {
        // A pool that is not the one SIP pins gives NO price, never a wrong one.
        prices = { kind: "unreadable", error: error instanceof PoolPriceError ? error.message : errorText(pool, error) };
      }
    }

    // ── the oracle at the tail ────────────────────────────────────────────────
    // Its OWN outcome, its OWN error handling. A feed that is missing, owned by
    // somebody else or unreadable answers "no oracle" here and changes not one
    // byte of `prices` above, which was already decided from its own slice.
    const pythAt = 3 + PRICED_POOLS.length + 2 * wallets.length;
    let pyth: ChainRead<PythRead>;
    if (accountsError !== null) {
      pyth = accountsUnreadable;
    } else {
      try {
        pyth = { kind: "exists", value: pythFromAccounts(values!.slice(pythAt, pythAt + PYTH_SNAPSHOT_ADDRESSES.length).map(snapshotOf)) };
      } catch (error) {
        pyth = { kind: "unreadable", error: error instanceof PythPriceError ? error.message : errorText(pool, error) };
      }
    }

    // ── the reserves at the very tail ─────────────────────────────────────────
    // Read from the SAME pool accounts the prices were decided from and the
    // vaults appended behind the oracle, in their own outcome. The decode is
    // total — a spoiled pool or an unreadable vault is that one entry's reason
    // and nothing else — and the catch is here only so that a reserve could
    // never, by any route, throw its way out of this function and take the
    // prices, the vault and the links down with it.
    const reservesAt = pythAt + PYTH_SNAPSHOT_ADDRESSES.length;
    let reserves: ChainRead<PoolReserves>;
    if (accountsError !== null) {
      reserves = accountsUnreadable;
    } else {
      try {
        reserves = {
          kind: "exists",
          value: poolReservesFromAccounts(poolAccounts, values!.slice(reservesAt, reservesAt + PRICED_POOL_IN_VAULTS.length).map(snapshotOf), slot),
        };
      } catch (error) {
        reserves = { kind: "unreadable", error: errorText(pool, error) };
      }
    }

    // ── each trading wallet, and where it saves ───────────────────────────────
    const linkAt = 3 + PRICED_POOLS.length;
    const walletAt = linkAt + wallets.length;
    const walletReads = wallets.map((wallet, index): LiveWalletRead => {
      const address = linkAddresses[index]!;
      if (accountsError !== null) return { wallet, lamports: null, link: { address, status: "unreadable", vault: null, state: null } };
      const account = snapshotOf(values![walletAt + index]);
      const lamports = account === null || account === undefined ? 0n : account.lamports;
      const read = decodeOwned(values![linkAt + index], decodeTradingLink);
      if (read.kind === "missing") return { wallet, lamports, link: { address, status: "missing", vault: null, state: null } };
      // An account at ["link", wallet] naming another wallet is not this wallet's link.
      if (read.kind === "unreadable" || read.value.state.wallet !== wallet) {
        return { wallet, lamports, link: { address, status: "unreadable", vault: null, state: null } };
      }
      const state = read.value.state;
      return { wallet, lamports, link: { address, status: state.vault === vaultAddress ? "this_vault" : "other_vault", vault: state.vault, state } };
    });

    // ── member 2: the vault's own token accounts ──────────────────────────────
    const tokensAnswer = memberResult(members, TOKENS);
    const tokensValue = tokensAnswer.ok ? (tokensAnswer.result as { value?: unknown } | null)?.value : undefined;
    const tokenAccounts: ChainRead<readonly VaultTokenAccountRead[]> =
      !tokensAnswer.ok
        ? { kind: "unreadable", error: pool.scrub(tokensAnswer.error) }
        : !Array.isArray(tokensValue) || tokensValue.length !== targets.length
          ? { kind: "unreadable", error: "getMultipleAccounts did not answer every token account" }
          : {
              kind: "exists",
              value: targets.map((target, index): VaultTokenAccountRead => {
                const status = tokenAccountStatus(snapshotOf(tokensValue[index]), target.tokenProgram);
                const balance = status === "exists" ? parsedBalance(tokensValue[index], vaultAddress, target.mint) : null;
                return {
                  mint: target.mint,
                  address: target.address,
                  tokenProgram: target.tokenProgram,
                  status,
                  amountRaw: balance?.amountRaw ?? null,
                  decimals: balance?.decimals ?? null,
                  uiAmount: balance?.uiAmount ?? null,
                };
              }),
            };

    // ── member 5: every link on chain ─────────────────────────────────────────
    let links: ChainRead<readonly VaultLink[]> | null = null;
    if (discover) {
      const answer = memberResult(members, LINKS);
      if (!answer.ok) {
        links = { kind: "unreadable", error: pool.scrub(answer.error) };
      } else if (!Array.isArray(answer.result)) {
        links = { kind: "unreadable", error: "getProgramAccounts did not answer a list" };
      } else {
        const found: VaultLink[] = [];
        for (const entry of answer.result as readonly { pubkey?: string; account?: RpcAccount }[]) {
          const read = decodeOwned(entry?.account, decodeTradingLink);
          // The RPC's filter is not the trust boundary: the field is read again.
          if (read.kind === "exists" && read.value.state.vault === vaultAddress && isPubkey(entry.pubkey)) {
            found.push({ address: entry.pubkey, state: read.value.state });
          }
        }
        links = { kind: "exists", value: found };
      }
    }

    return {
      ...base,
      slot,
      vault,
      policy: accountsError !== null ? accountsUnreadable : addressed(policyAddress, decodeOwned(values![1], decodeInvestmentPolicy)),
      config: accountsError !== null ? accountsUnreadable : addressed(configAddress, decodeOwned(values![2], decodeProtocolConfig)),
      prices,
      pyth,
      reserves,
      tokenAccounts,
      rents: { vault: vaultRent, walletFloor },
      wallets: walletReads,
      links,
    };
  } catch (error) {
    return failAll(errorText(pool, error));
  }
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

/**
 * One transaction of a vault's history. It satisfies ClassifiableEntry, so
 * classifyVaultEntry (browser-safe) names it without ever reaching the server.
 */
export interface VaultActivityEntry extends ClassifiableEntry {
  readonly err: unknown;
  readonly fee: bigint | null;
  /** Top-level SIP instructions by IDL name (from their discriminators, not from log text). */
  readonly sipInstructions: readonly string[];
}

export interface VaultActivityPage {
  readonly entries: readonly VaultActivityEntry[];
  /** Pass as `before` for the next page; null at the end. */
  readonly nextBefore: string | null;
}

export const MAX_ACTIVITY_PAGE = 25;

/** One token balance as getTransaction reports it, before or after. */
interface RpcTokenBalance {
  readonly accountIndex?: number;
  readonly mint?: string;
  /** Whose account it is. Absent on old answers, and then the balance is not used. */
  readonly owner?: string;
  readonly uiTokenAmount?: { readonly amount?: string; readonly decimals?: number; readonly uiAmountString?: string };
}

interface RpcTransaction {
  readonly slot?: number;
  readonly blockTime?: number | null;
  readonly meta?: {
    readonly err?: unknown;
    readonly fee?: number;
    readonly preBalances?: readonly number[];
    readonly postBalances?: readonly number[];
    readonly preTokenBalances?: readonly RpcTokenBalance[];
    readonly postTokenBalances?: readonly RpcTokenBalance[];
    readonly logMessages?: readonly string[] | null;
    readonly loadedAddresses?: { readonly writable?: readonly string[]; readonly readonly?: readonly string[] };
  } | null;
  readonly transaction?: {
    readonly message?: {
      readonly accountKeys?: readonly string[];
      readonly instructions?: readonly { readonly programIdIndex: number; readonly data: string; readonly accounts?: readonly number[] }[];
    };
  };
}

/**
 * An instruction's arguments by IDL name, or null when the data did not decode.
 * A `bytes` argument (convert and invest carry venue_data) is DROPPED: it is an
 * opaque venue blob, it can be large, and no row ever shows it.
 */
function decodedArgs(name: string, data: Uint8Array): Readonly<Record<string, unknown>> | null {
  try {
    const kept: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(decodeArgs(name, data))) {
      if (value instanceof Uint8Array) continue;
      kept[field] = value;
    }
    return kept;
  } catch {
    return null;
  }
}

/** The instruction's accounts under their IDL names, as far as the transaction lists them. */
function namedAccounts(name: string, indexes: readonly number[] | undefined, keys: readonly string[]): Readonly<Record<string, string>> {
  const named: Record<string, string> = {};
  if (indexes === undefined) return named;
  try {
    idlInstruction(name).accounts.forEach((account, position) => {
      const at = indexes[position];
      const address = at === undefined ? undefined : keys[at];
      if (address !== undefined) named[account.name] = address;
    });
  } catch {
    // "unknown" is not an IDL instruction, so it has no account names.
  }
  return named;
}

const rawAmount = (balance: RpcTokenBalance | undefined): string => {
  const amount = balance?.uiTokenAmount?.amount;
  return typeof amount === "string" && /^[0-9]+$/.test(amount) ? amount : "0";
};

const uiAmountOf = (balance: RpcTokenBalance | undefined): string => {
  const ui = balance?.uiTokenAmount?.uiAmountString;
  return typeof ui === "string" && ui !== "" ? ui : "0";
};

/**
 * The token balances of accounts the VAULT owns, joined by accountIndex. A side
 * the transaction did not carry counts as "0" (an account created or emptied
 * here), and a balance whose owner is not the vault is not this vault's business.
 */
function vaultTokenDeltasOf(vault: string, keys: readonly string[], meta: RpcTransaction["meta"]): VaultTokenDelta[] {
  const sides = new Map<number, { pre?: RpcTokenBalance; post?: RpcTokenBalance }>();
  const gather = (list: readonly RpcTokenBalance[] | undefined, side: "pre" | "post"): void => {
    for (const balance of list ?? []) {
      const index = balance?.accountIndex;
      // Without an owner the RPC has not said whose account it is; it is not read as the vault's.
      if (typeof index !== "number" || !Number.isInteger(index) || balance.owner !== vault) continue;
      const found = sides.get(index) ?? {};
      found[side] = balance;
      sides.set(index, found);
    }
  };
  gather(meta?.preTokenBalances, "pre");
  gather(meta?.postTokenBalances, "post");

  const deltas: VaultTokenDelta[] = [];
  for (const [index, side] of [...sides.entries()].sort((left, right) => left[0] - right[0])) {
    const either = side.post ?? side.pre;
    const account = keys[index];
    const mint = either?.mint;
    if (account === undefined || typeof mint !== "string") continue;
    const decimals = either?.uiTokenAmount?.decimals;
    deltas.push({
      account,
      mint,
      decimals: typeof decimals === "number" && Number.isInteger(decimals) ? decimals : 0,
      preRaw: rawAmount(side.pre),
      postRaw: rawAmount(side.post),
      preUi: uiAmountOf(side.pre),
      postUi: uiAmountOf(side.post),
    });
  }
  return deltas;
}

function entryFrom(vault: string, signature: string, slot: number, blockTime: number | null, err: unknown, tx: RpcTransaction | null): VaultActivityEntry {
  if (tx === null || tx.transaction?.message === undefined) {
    // readable false: the signature is known and its body is not. Everything
    // below is empty because nothing was READ, not because nothing happened.
    return { signature, slot, blockTime, ok: err === null, err, fee: null, readable: false, sipInstructions: [], instructions: [], vaultLamportsDelta: null, vaultTokenDeltas: [], settled: [] };
  }
  const message = tx.transaction.message;
  const keys = [...(message.accountKeys ?? []), ...(tx.meta?.loadedAddresses?.writable ?? []), ...(tx.meta?.loadedAddresses?.readonly ?? [])];
  const instructions: SipInstructionCall[] = [];
  for (const instruction of message.instructions ?? []) {
    if (keys[instruction.programIdIndex] !== SIP_PROGRAM_ID) continue;
    const data = tryBase58DecodeLong(instruction.data);
    const matched = data === null ? null : matchInstruction(data);
    const name = matched?.name ?? "unknown";
    instructions.push({
      name,
      args: matched === null || data === null ? null : decodedArgs(name, data),
      accounts: namedAccounts(name, instruction.accounts, keys),
    });
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
    readable: true,
    sipInstructions: instructions.map((call) => call.name),
    instructions,
    vaultLamportsDelta: index >= 0 && typeof pre === "number" && typeof post === "number" ? BigInt(post) - BigInt(pre) : null,
    vaultTokenDeltas: vaultTokenDeltasOf(vault, keys, tx.meta ?? null),
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

/** One signature of a vault's history, as getSignaturesForAddress lists it. */
export interface VaultSignature {
  readonly signature: string;
  readonly slot: number;
  readonly blockTime: number | null;
  readonly err: unknown;
}

export interface VaultSignaturePage {
  readonly listed: readonly VaultSignature[];
  /** Pass as `before` for the next page; null at the end. */
  readonly nextBefore: string | null;
}

/**
 * ONE getSignaturesForAddress. Split from the transactions below so a handler can
 * charge its client for the N transactions it is about to read BEFORE it reads
 * them: a client out of tokens is then refused with no upstream call wasted.
 *
 * `until` stops at a signature already known, which is what a poll asks for.
 */
export async function listVaultSignatures(
  pool: RpcPool,
  vault: string,
  options: { readonly limit?: number; readonly before?: string; readonly until?: string } = {},
): Promise<ChainRead<VaultSignaturePage>> {
  const limit = options.limit ?? MAX_ACTIVITY_PAGE;
  if (!isPubkey(vault)) return { kind: "unreadable", error: "not a base58 32-byte address" };
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ACTIVITY_PAGE) throw new RangeError(`listVaultSignatures: limit must be 1..${MAX_ACTIVITY_PAGE}`);
  if (options.before !== undefined && !isSignature(options.before)) throw new RangeError("listVaultSignatures: before must be a signature");
  if (options.until !== undefined && !isSignature(options.until)) throw new RangeError("listVaultSignatures: until must be a signature");
  try {
    const signatures = await pool.call<readonly { signature: string; slot: number; blockTime?: number | null; err: unknown }[]>("getSignaturesForAddress", [
      vault,
      {
        limit,
        commitment: COMMITMENT,
        ...(options.before === undefined ? {} : { before: options.before }),
        ...(options.until === undefined ? {} : { until: options.until }),
      },
    ]);
    if (!Array.isArray(signatures)) return { kind: "unreadable", error: "getSignaturesForAddress did not answer a list" };
    const listed = signatures
      .filter((entry) => isSignature(entry?.signature))
      .map((entry): VaultSignature => ({ signature: entry.signature, slot: entry.slot, blockTime: entry.blockTime ?? null, err: entry.err ?? null }));
    return { kind: "exists", value: { listed, nextBefore: listed.length === limit ? listed[listed.length - 1]!.signature : null } };
  } catch (error) {
    if (error instanceof RpcAnswerError) return { kind: "unreadable", error: pool.scrub(error.message) };
    return { kind: "unreadable", error: errorText(pool, error) };
  }
}

/** Every listed transaction in ONE batch. A member that failed is that entry's own `readable: false`, not a failed page. */
export async function readVaultTransactions(pool: RpcPool, vault: string, listed: readonly VaultSignature[]): Promise<ChainRead<readonly VaultActivityEntry[]>> {
  if (!isPubkey(vault)) return { kind: "unreadable", error: "not a base58 32-byte address" };
  if (listed.length === 0) return { kind: "exists", value: [] };
  try {
    const members = await pool.batch(
      listed.map((entry, index) => ({
        id: index + 1,
        method: "getTransaction",
        params: [entry.signature, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: COMMITMENT }],
      })),
    );
    return {
      kind: "exists",
      value: listed.map((entry, index) => {
        const answer = memberResult(members, index + 1);
        const tx = answer.ok ? ((answer.result as RpcTransaction | null) ?? null) : null;
        return entryFrom(vault, entry.signature, entry.slot, entry.blockTime, entry.err, tx);
      }),
    };
  } catch (error) {
    if (error instanceof RpcAnswerError) return { kind: "unreadable", error: pool.scrub(error.message) };
    return { kind: "unreadable", error: errorText(pool, error) };
  }
}

/**
 * One page of the vault's history, newest first: the two calls above, composed.
 * Server-side only — the browser relay serves neither method.
 */
export async function listVaultActivity(
  pool: RpcPool,
  vault: string,
  options: { readonly limit?: number; readonly before?: string } = {},
): Promise<ChainRead<VaultActivityPage>> {
  const page = await listVaultSignatures(pool, vault, options);
  if (page.kind !== "exists") return page;
  const entries = await readVaultTransactions(pool, vault, page.value.listed);
  if (entries.kind !== "exists") return entries;
  return { kind: "exists", value: { entries: entries.value, nextBefore: page.value.nextBefore } };
}
