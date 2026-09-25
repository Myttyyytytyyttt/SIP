/**
 * WHAT /prices READS, ALL OF IT ON THE SERVER, AND WHAT IT DOES WHEN A SOURCE
 * WILL NOT ANSWER.
 *
 * WHY SERVER-SIDE IS NOT A PREFERENCE HERE. The app ships a pinned
 * Content-Security-Policy (scripts/check-csp.mts holds the golden string) whose
 * connect-src lists this origin, Privy and the public Solana WebSocket, and
 * nothing else. A browser fetch to prestocks.com would need a new origin in that
 * policy for one public page — so the page does its reading before the first
 * paint and ships numbers, not a fetch. A judge with no wallet, no session and
 * JavaScript off still sees every figure.
 *
 * TWO RPC CALLS, BOTH BATCHED, AND THE FIRST IS THE ONE THE APP ALREADY MAKES.
 * readPoolDepth (solana-core/server/readers.ts) is the existing single
 * getMultipleAccounts over PRICED_POOLS and their in-side vaults; it gives the
 * pool mids and the live USDC depth with the mint-order and vault-identity
 * checks already written. The second batch is this page's own: the chain's Clock
 * beside the three Pyth push accounts and the two mints, so an age is measured
 * against the CHAIN's clock and a fee is resolved against the CHAIN's epoch —
 * never this host's wall clock, which on Vercel is not even the same machine
 * twice.
 *
 * EVERY FIGURE CARRIES ITS PROVENANCE OR IT IS NOT SHOWN. A price gets an age or
 * the slot it was read at; a fee gets the epoch it applies in; a third-party
 * number gets the third party's name. That is why almost nothing here returns a
 * bare value: it returns a Reading, and a Reading that failed carries the reason
 * as copy the page prints.
 *
 * NOTHING HERE IS A KEEPER INPUT. The page reads the keeper's live oracle
 * constants to explain them (prices-guard.ts) and reads no keeper secret, signs
 * nothing, and changes nothing. packages/solana-keeper is untouched.
 */
import "server-only";

import {
  ANTHROPIC_MINT,
  ANTHROPIC_USDC_POOL,
  CATALOGUE,
  CATALOGUE_MIN_VENUE_DEPTH_RAW,
  CATALOGUE_REFERENCE_LEG_RAW,
  CATALOGUE_VENUE_INVENTORY_MULTIPLE,
  OFFER_RULES,
  PRESTOCKS_POWERS,
  PYTH_RECEIVER_PROGRAM,
  PYTH_SOL_USD_FEED,
  PYTH_SOL_USD_FEED_ID_HEX,
  PYTH_SPYX_USD_FEED,
  PYTH_SPYX_USD_FEED_ID_HEX,
  PYTH_USDC_USD_FEED,
  PYTH_USDC_USD_FEED_ID_HEX,
  SOL_USDC_POOL,
  SPYX_MINT,
  SPYX_USDC_POOL,
  decodeMintTransferFee,
  decodePythPriceUpdate,
  feeToNetBps,
  offerProblems,
  pythRateWad,
  type MintTransferFeeSchedule,
  type OfferRule,
  type PythPriceUpdate,
} from "@sip/solana-core/client";
import { SYSVAR_CLOCK, clockEpochOf, createRpcPool, readPoolDepth, type AccountSnapshot, type RpcPool } from "@sip/solana-core/server";

import { solanaGate } from "./load-config";
import {
  MULTIPLIER_ONE,
  attempt,
  deviationBps,
  effectiveMultiplier,
  decodeScaledUiAmountConfig,
  failed,
  legMicroUsdPerUiToken,
  pythMicroUsd,
  reads,
  solMicroUsdFromConvertWad,
  type EffectiveMultiplier,
  type Reading,
} from "./prices-units";
import { KEEPER_ORACLE_GUARD } from "./prices-guard";

/** Where the PreStocks marks come from: public, keyless, and read from the server only. */
export const PRESTOCKS_API_URL = "https://prestocks.com/api/prestocks";

/** How long this page waits on a third party before calling it unread. A judge's page must paint. */
const PRESTOCKS_TIMEOUT_MS = 6_000;

/**
 * THE MARKED SEAM — Pyth Hermes, equity feeds, deliberately NOT wired.
 *
 * Hermes serves Pyth's off-chain feeds, including the equity indices this
 * product would want for a PreStock's underlying (Equity.Index.ANTHROPIC/USD is
 * the shape of the symbol), behind a credential. This build reads the NAME of
 * the variable that credential would arrive in and nothing else: it makes no
 * request, holds no token, and has no code path that could send one. When the
 * variable is absent — which is every environment today, including production —
 * the page states that the underlying is not read, which is the honest reading
 * of an index nobody here has a feed for.
 *
 * TO FILL IT: set the variable in the deployment, then implement the fetch HERE,
 * server-side, returning a Reading with a publish age like every other figure on
 * the page. Do not reach for it from the browser: the CSP's connect-src would
 * refuse the origin, and it would put the credential in the bundle.
 */
export const HERMES_EQUITY_CREDENTIAL_VARIABLE = "SIP_PYTH_HERMES_CREDENTIAL";

/** The equity symbol this seam is for, shown on the page as the thing that is missing. */
export const HERMES_EQUITY_SYMBOL = "Equity.Index.ANTHROPIC/USD";

export type HermesEquitySeam =
  | { readonly kind: "absent"; readonly variable: string; readonly symbol: string }
  | { readonly kind: "configured-not-wired"; readonly variable: string; readonly symbol: string };

/** The seam's state from an environment that may not hold the variable. Never returns the value, only whether there is one. */
export function hermesEquitySeam(env: Readonly<Record<string, string | undefined>> = process.env): HermesEquitySeam {
  const present = (env[HERMES_EQUITY_CREDENTIAL_VARIABLE] ?? "").trim() !== "";
  return { kind: present ? "configured-not-wired" : "absent", variable: HERMES_EQUITY_CREDENTIAL_VARIABLE, symbol: HERMES_EQUITY_SYMBOL };
}

// ── the chain's own clock and epoch ──────────────────────────────────────────

const CLOCK_BYTES = 40;
const CLOCK_UNIX_TIMESTAMP_AT = 32;
const SYSVAR_PROGRAM = "Sysvar1111111111111111111111111111111111111";

function i64At(bytes: Uint8Array, at: number): bigint {
  let value = 0n;
  for (let i = 7; i >= 0; i--) value = (value << 8n) | BigInt(bytes[at + i]!);
  return value >= 1n << 63n ? value - (1n << 64n) : value;
}

export interface ChainClock {
  /** unix_timestamp out of the Clock sysvar: the clock every age on this page is measured against. */
  readonly unixSeconds: bigint;
  /** The epoch every transfer fee on this page is resolved against. */
  readonly epoch: bigint;
}

/** The Clock sysvar's time and epoch, or the reason neither may be trusted. Owner-checked: a clock nobody vouches for ages nothing. */
export function chainClockFrom(account: AccountSnapshot | null | undefined): Reading<ChainClock> {
  if (account === null || account === undefined) return failed("the Clock sysvar was not returned by the read, so no age on this page could be measured against the chain");
  if (account.owner !== SYSVAR_PROGRAM) return failed(`the Clock sysvar account is owned by ${account.owner}, not the sysvar program`);
  if (account.data === null || account.data.length < CLOCK_BYTES) return failed("the Clock sysvar's data is not the 40 bytes an age and an epoch are read from");
  const epoch = clockEpochOf(account);
  if (epoch === null) return failed("the Clock sysvar's epoch could not be read");
  return reads({ unixSeconds: i64At(account.data, CLOCK_UNIX_TIMESTAMP_AT), epoch });
}

// ── one Pyth push account ────────────────────────────────────────────────────

export interface FeedRead {
  readonly address: string;
  readonly label: string;
  readonly feedIdHex: string;
  /** The price in MICRO_USD. */
  readonly microUsd: bigint;
  /** The confidence interval, same unit. */
  readonly confMicroUsd: bigint;
  /** Seconds the publish sits behind the CHAIN's clock. Negative means ahead of it. */
  readonly ageSeconds: bigint;
  readonly publishTime: bigint;
  /** The raw integer and exponent, so a reader can re-derive the price from the bytes. */
  readonly price: bigint;
  readonly expo: number;
  /** The decoded account, kept so the oracle's own rate helper (pythRateWad) can be reused rather than re-derived. */
  readonly update: PythPriceUpdate;
}

/**
 * One push account, decoded for the feed the caller EXPECTS and refused unless
 * the RECEIVER owns it.
 *
 * BOTH CHECKS, ALWAYS. The address is a PDA of the push program, so a correct
 * derivation says nothing about who may write the bytes; the receiver's
 * ownership is the only thing that does. And the bytes must carry the feed id
 * asked for, or the page would be pricing whatever feed somebody else chose.
 */
export function feedFrom(
  label: string,
  address: string,
  expectedFeedIdHex: string,
  account: AccountSnapshot | null | undefined,
  chainUnixSeconds: bigint,
): Reading<FeedRead> {
  if (account === null || account === undefined) return failed(`the ${label} push account ${address} was not returned by the read`);
  if (account.owner !== PYTH_RECEIVER_PROGRAM) return failed(`the ${label} push account is owned by ${account.owner}, not the Pyth receiver ${PYTH_RECEIVER_PROGRAM}`);
  if (account.data === null) return failed(`the ${label} push account's data did not come back as bytes`);
  return attempt(`the ${label} push account could not be decoded`, () => {
    const update = decodePythPriceUpdate(account.data!, expectedFeedIdHex);
    return {
      address,
      label,
      feedIdHex: update.feedIdHex,
      microUsd: pythMicroUsd(update.price, update.expo),
      confMicroUsd: pythMicroUsd(update.conf === 0n ? 1n : update.conf, update.expo),
      ageSeconds: chainUnixSeconds - update.publishTime,
      publishTime: update.publishTime,
      price: update.price,
      expo: update.expo,
      update,
    };
  });
}

// ── the mints ────────────────────────────────────────────────────────────────

const MINT_DECIMALS_AT = 44;
const MINT_SUPPLY_AT = 36;
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

export interface MintRead {
  readonly mint: string;
  readonly decimals: number;
  readonly supplyRaw: bigint;
  /** The multiplier IN FORCE at the chain's clock, and the one written for later if there is one. */
  readonly multiplier: EffectiveMultiplier;
  /** Whether the mint carries the scaledUiAmount extension at all — "multiplier 1" and "no extension" are different facts. */
  readonly scaled: boolean;
  /** The TransferFeeConfig's two records, or null when the mint carries no fee extension and never can. */
  readonly fee: MintTransferFeeSchedule | null;
}

/** A mint's decimals, supply, live scaledUiAmount multiplier and fee schedule, or the reason the page cannot price that token. */
export function mintFrom(mint: string, account: AccountSnapshot | null | undefined, chainUnixSeconds: bigint): Reading<MintRead> {
  if (account === null || account === undefined) return failed(`the mint ${mint} was not returned by the read, and a token's price cannot be scaled without its mint`);
  if (account.owner !== TOKEN_2022_PROGRAM) return failed(`the mint ${mint} is owned by ${account.owner}, not Token-2022`);
  if (account.data === null || account.data.length < MINT_DECIMALS_AT + 1) return failed(`the mint ${mint}'s data did not come back as bytes`);
  return attempt(`the mint ${mint} could not be read`, () => {
    const data = account.data!;
    const config = decodeScaledUiAmountConfig(data);
    return {
      mint,
      decimals: data[MINT_DECIMALS_AT]!,
      supplyRaw: i64At(data, MINT_SUPPLY_AT),
      multiplier: effectiveMultiplier(config, chainUnixSeconds),
      scaled: config !== null,
      fee: decodeMintTransferFee(data),
    };
  });
}

/** The fee a mint charges IN the given epoch, and the one already written for a later one. Both are the mint's own bytes, not a table. */
export interface FeeInForce {
  readonly bps: number;
  /** The first epoch that rate applies in. */
  readonly sinceEpoch: bigint;
  readonly scheduled: { readonly bps: number; readonly fromEpoch: bigint } | null;
  /** What a floor signed today must net, which is the HIGHER of the two (solana-core feeToNetBps says why). */
  readonly netBps: number;
}

export function feeInForce(schedule: MintTransferFeeSchedule | null, epoch: bigint): FeeInForce | null {
  if (schedule === null) return null;
  const arrived = epoch >= schedule.newer.epoch;
  const live = arrived ? schedule.newer : schedule.older;
  return {
    bps: live.bps,
    sinceEpoch: live.epoch,
    scheduled: arrived || schedule.newer.epoch <= schedule.older.epoch ? null : { bps: schedule.newer.bps, fromEpoch: schedule.newer.epoch },
    netBps: feeToNetBps(schedule, epoch),
  };
}

// ── prestocks.com ────────────────────────────────────────────────────────────

export interface PreStocksMark {
  /** The issuer's own mark for one UI-scaled token. */
  readonly markMicroUsd: bigint;
  /** The issuer's token price for one UI-scaled token: what a buyer pays them. */
  readonly tokenMicroUsd: bigint;
  /** The supply the API reports, in UI tokens × 1e9, so it can be compared with the mint's own supply without a float. */
  readonly supplyNano: bigint;
  /** The mint the API itself names for the symbol. Never trusted from the symbol alone. */
  readonly contract: string;
}

const microFrom = (value: unknown, what: string): bigint => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`${what} is not a positive number in the API's answer`);
  return BigInt(Math.round(value * 1e6));
};

/**
 * One symbol's marks from the PreStocks API, checked rather than cast.
 *
 * THE SYMBOL IS NOT AN IDENTITY (solana-core/client/product.ts says so at
 * length: a token search for these symbols answers with impostors). So the entry
 * is matched by symbol AND its own contract_address must be the mint this
 * repository pinned; anything else is refused with that reason on the page.
 */
export function preStocksMarkFrom(body: unknown, symbol: string, expectedMint: string): Reading<PreStocksMark> {
  if (!Array.isArray(body)) return failed("the PreStocks API did not answer with a list");
  const entry = body.find((item) => typeof item === "object" && item !== null && (item as { symbol?: unknown }).symbol === symbol) as Record<string, unknown> | undefined;
  if (entry === undefined) return failed(`the PreStocks API's answer holds no ${symbol} entry`);
  const contract = entry["contract_address"];
  if (typeof contract !== "string" || contract !== expectedMint) {
    return failed(`the PreStocks API names ${typeof contract === "string" ? contract : "no mint"} for ${symbol}, and this page only prices the mint pinned in @sip/solana-core (${expectedMint})`);
  }
  return attempt(`the PreStocks API's ${symbol} entry could not be read`, () => ({
    markMicroUsd: microFrom(entry["markPrice"], "markPrice"),
    tokenMicroUsd: microFrom(entry["tokenPrice"], "tokenPrice"),
    supplyNano: BigInt(Math.round(Number(entry["supply"]) * 1e9)),
    contract,
  }));
}

async function fetchPreStocks(fetchImpl: typeof fetch, symbol: string, mint: string): Promise<Reading<PreStocksMark>> {
  try {
    const response = await fetchImpl(PRESTOCKS_API_URL, {
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(PRESTOCKS_TIMEOUT_MS),
    });
    if (!response.ok) return failed(`prestocks.com answered HTTP ${response.status} for ${PRESTOCKS_API_URL}`);
    return preStocksMarkFrom(await response.json(), symbol, mint);
  } catch (error) {
    return failed(`prestocks.com could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ── the model the page renders ───────────────────────────────────────────────

/** A price beside the oracle or the issuer's price it is being compared with, in one unit, with the gap between them. */
export interface Comparison {
  readonly poolMicroUsd: bigint;
  readonly referenceMicroUsd: bigint;
  /** Pool against reference, bps of the reference, signed. Null when the two are NOT comparable — see `incomparable`. */
  readonly bps: bigint | null;
  /** Why no gap is shown. Null when one is. */
  readonly incomparable: string | null;
}

export interface SolBlock {
  readonly pool: Reading<{ readonly microUsd: bigint; readonly wad: bigint; readonly slot: number | null; readonly pool: string }>;
  readonly oracle: Reading<{ readonly microUsd: bigint; readonly wad: bigint; readonly sol: FeedRead; readonly usdc: FeedRead; readonly stalestAgeSeconds: bigint }>;
  readonly deviation: Reading<bigint>;
  /** What the keeper's LIVE constants would say about this reading, and the constants themselves. */
  readonly guard: Reading<{ readonly wouldConvert: boolean; readonly reasons: readonly string[] }>;
}

export interface EquityBlock {
  readonly symbol: string;
  readonly mintAddress: string;
  readonly poolAddress: string;
  readonly feedAddress: string;
  readonly pool: Reading<{ readonly microUsd: bigint; readonly wad: bigint; readonly slot: number | null }>;
  readonly mint: Reading<MintRead>;
  readonly feed: Reading<FeedRead>;
  readonly premium: Reading<Comparison>;
}

export interface AnthropicBlock {
  readonly symbol: string;
  readonly mintAddress: string;
  readonly poolAddress: string;
  readonly pool: Reading<{ readonly microUsd: bigint; readonly wad: bigint; readonly slot: number | null }>;
  readonly mint: Reading<MintRead>;
  readonly api: Reading<PreStocksMark>;
  readonly fee: Reading<FeeInForce | null>;
  /** The units question, answered before any premium: whether the two sides count the same token. */
  readonly units: Reading<{ readonly comparable: boolean; readonly why: string }>;
  readonly premiumOverToken: Reading<Comparison>;
  readonly premiumOverMark: Reading<Comparison>;
  readonly depth: Reading<{ readonly usdcRaw: bigint; readonly pool: string; readonly slot: number | null }>;
}

export interface ShelfRow {
  readonly symbol: string;
  readonly name: string;
  readonly group: string;
  readonly mint: string;
  readonly offered: boolean;
  readonly failures: readonly { readonly rule: OfferRule; readonly ruleText: string; readonly why: string }[];
}

export interface PricesModel {
  /** The server's own clock, stated as such and used for nothing but "this page was built at". */
  readonly builtAt: string;
  readonly chain: Reading<ChainClock>;
  readonly slot: number | null;
  readonly sol: SolBlock;
  readonly spyx: EquityBlock;
  readonly anthropic: AnthropicBlock;
  readonly shelf: readonly ShelfRow[];
  readonly hermes: HermesEquitySeam;
  readonly reference: {
    readonly legRaw: bigint;
    readonly venueMultiple: bigint;
    readonly minVenueRaw: bigint;
  };
  readonly guard: typeof KEEPER_ORACLE_GUARD;
  /** What the issuer of all eight PreStocks can do to a holder, as @sip/solana-core read it. Not this page's sentence to write. */
  readonly issuer: typeof PRESTOCKS_POWERS;
}

/** The addresses this page's own batch asks for, in this order. */
export const PRICES_SNAPSHOT_ADDRESSES: readonly string[] = Object.freeze([
  SYSVAR_CLOCK,
  PYTH_SOL_USD_FEED,
  PYTH_USDC_USD_FEED,
  PYTH_SPYX_USD_FEED,
  SPYX_MINT,
  ANTHROPIC_MINT,
]);

/** null for an account the chain does not have; undefined for an answer that is not an account. Mirrors readers.ts's own snapshotOf. */
function snapshotOf(account: unknown): AccountSnapshot | null | undefined {
  if (account === null) return null;
  const candidate = account as { owner?: unknown; lamports?: unknown; data?: unknown } | undefined;
  if (candidate === undefined || typeof candidate.owner !== "string" || typeof candidate.lamports !== "number") return undefined;
  const data = candidate.data;
  const base64 = Array.isArray(data) && typeof data[0] === "string" && data[1] === "base64" ? (data[0] as string) : null;
  return { owner: candidate.owner, lamports: BigInt(candidate.lamports), data: base64 === null ? null : new Uint8Array(Buffer.from(base64, "base64")) };
}

const shelf = (): readonly ShelfRow[] =>
  CATALOGUE.map((asset) => {
    const failures = offerProblems(asset);
    return {
      symbol: asset.symbol,
      name: asset.name,
      group: asset.group,
      mint: asset.mint,
      offered: failures.length === 0,
      failures: failures.map((failure) => ({ rule: failure.rule, ruleText: OFFER_RULES[failure.rule], why: failure.why })),
    };
  });

const comparison = (poolMicroUsd: bigint, referenceMicroUsd: bigint, incomparable: string | null): Comparison => ({
  poolMicroUsd,
  referenceMicroUsd,
  bps: incomparable === null ? deviationBps(poolMicroUsd, referenceMicroUsd) : null,
  incomparable,
});

/** The first reason among readings a later figure depended on, or null when they all read. */
/** A ChainRead that is not `exists`, as copy: "unreadable" carries its reason, and "missing" is a fact of its own. */
function whyNot(read: { readonly kind: string; readonly error?: string }, what: string): string {
  return read.kind === "unreadable" && typeof read.error === "string" ? read.error : `the chain answered no ${what}`;
}

function blockedBy(...readings: readonly Reading<unknown>[]): string | null {
  for (const reading of readings) if (!reading.ok) return reading.why;
  return null;
}

export interface PricesLoadOptions {
  readonly pool?: RpcPool;
  readonly fetch?: typeof fetch;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * The whole page's data. It throws for nothing: a gate that cannot be opened, an
 * RPC that will not answer and a third party that times out each become the
 * copy of the block they belong to, and the other blocks keep their figures.
 */
export async function loadPrices(options: PricesLoadOptions = {}): Promise<PricesModel> {
  const builtAt = new Date().toISOString();
  const env = options.env ?? process.env;
  const fetchImpl = options.fetch ?? fetch;
  const hermes = hermesEquitySeam(env);
  const gate = solanaGate(env);

  if (options.pool === undefined && gate.kind !== "ok") {
    const why = "this deployment's Solana settings are incomplete, so no chain read was attempted (SIP_SOLANA_RPC_URLS)";
    return degraded({ builtAt, why, hermes, api: await fetchPreStocks(fetchImpl, "ANTHROPIC", ANTHROPIC_MINT) });
  }
  const pool = options.pool ?? createRpcPool(gate.kind === "ok" ? gate.settings.rpcEndpoints : [], { fetch: options.fetch, redactor: gate.kind === "ok" ? gate.settings.redactor : undefined });

  // THREE SOURCES, ONE ROUND TRIP EACH, IN PARALLEL: the app's existing pool
  // read, this page's own account batch, and the issuer's API. None can delay
  // the others, and none can fail the others.
  const [depth, batch, api] = await Promise.all([
    readPoolDepth(pool).catch((error: unknown) => {
      const why = `the pinned pools could not be read: ${pool.scrub(error instanceof Error ? error.message : String(error))}`;
      return { prices: { kind: "unreadable" as const, error: why }, reserves: { kind: "unreadable" as const, error: why } };
    }),
    (async (): Promise<Reading<readonly (AccountSnapshot | null | undefined)[]>> => {
      try {
        const answer = await pool.call<{ context?: { slot?: unknown }; value?: unknown }>("getMultipleAccounts", [PRICES_SNAPSHOT_ADDRESSES, { encoding: "base64", commitment: "confirmed" }]);
        const value = answer?.value;
        if (!Array.isArray(value) || value.length !== PRICES_SNAPSHOT_ADDRESSES.length) return failed("the read did not answer the chain's clock, the three push accounts and the two mints");
        return reads(value.map(snapshotOf));
      } catch (error) {
        return failed(`the clock, feeds and mints could not be read: ${pool.scrub(error instanceof Error ? error.message : String(error))}`);
      }
    })(),
    fetchPreStocks(fetchImpl, "ANTHROPIC", ANTHROPIC_MINT),
  ]);

  const prices = depth.prices;
  const reserves = depth.reserves;
  const slot = prices.kind === "exists" ? prices.value.slot : null;

  const chain: Reading<ChainClock> = batch.ok ? chainClockFrom(batch.value[0]) : failed(batch.why);
  const chainUnix = chain.ok ? chain.value.unixSeconds : 0n;

  // ── SOL ───────────────────────────────────────────────────────────────────
  const solPool: SolBlock["pool"] =
    prices.kind === "exists"
      ? attempt("the SOL/USDC pool mid could not be taken", () => ({ microUsd: solMicroUsdFromConvertWad(prices.value.convertWad), wad: prices.value.convertWad, slot: prices.value.slot, pool: SOL_USDC_POOL }))
      : failed(whyNot(prices, "pinned pool accounts"));

  // Every account figure depends on the same two things: the batch answering, and
  // the chain's clock being readable. One reason, stated once, for all of them.
  const unread = blockedBy(batch, chain);
  const solFeed = batch.ok && unread === null ? feedFrom("SOL/USD", PYTH_SOL_USD_FEED, PYTH_SOL_USD_FEED_ID_HEX, batch.value[1], chainUnix) : failed(unread ?? "the read did not answer");
  const usdcFeed = batch.ok && unread === null ? feedFrom("USDC/USD", PYTH_USDC_USD_FEED, PYTH_USDC_USD_FEED_ID_HEX, batch.value[2], chainUnix) : failed(unread ?? "the read did not answer");

  const oracle: SolBlock["oracle"] =
    solFeed.ok && usdcFeed.ok
      ? attempt("the oracle's SOL/USDC rate could not be taken", () => {
          // 9 lamport decimals over USDC's 6: the same call, in the same unit, the
          // keeper's own gate compares in (client/pyth-price.ts solUsdcPythWad).
          const wad = pythRateWad(solFeed.value.update, usdcFeed.value.update, 9, 6);
          const stalest = solFeed.value.ageSeconds > usdcFeed.value.ageSeconds ? solFeed.value.ageSeconds : usdcFeed.value.ageSeconds;
          return { microUsd: solMicroUsdFromConvertWad(wad), wad, sol: solFeed.value, usdc: usdcFeed.value, stalestAgeSeconds: stalest };
        })
      : failed(blockedBy(solFeed, usdcFeed) ?? "the oracle pair did not read");

  const deviation: Reading<bigint> =
    solPool.ok && oracle.ok ? attempt("the deviation could not be taken", () => deviationBps(solPool.value.wad, oracle.value.wad)) : failed("the deviation needs both the pool's mid and the oracle's rate, and one of them did not read");

  const guard: SolBlock["guard"] = !oracle.ok
    ? failed("with no oracle rate there is nothing for the guard to compare, which is itself a refusal: the keeper does not convert without Pyth")
    : reads(
        (() => {
          const stale = oracle.value.stalestAgeSeconds > KEEPER_ORACLE_GUARD.maxAgeSeconds;
          const wide = deviation.ok && (deviation.value > KEEPER_ORACLE_GUARD.maxDeviationBps || -deviation.value > KEEPER_ORACLE_GUARD.maxDeviationBps);
          const reasons: string[] = [];
          if (stale) reasons.push(`the stalest of the two publishes is ${oracle.value.stalestAgeSeconds} s behind the chain's clock, past the ${KEEPER_ORACLE_GUARD.maxAgeSeconds} s bar`);
          if (wide && deviation.ok) reasons.push(`the pool and the oracle are ${deviation.value} bps apart, past the ${KEEPER_ORACLE_GUARD.maxDeviationBps} bps bar`);
          if (!deviation.ok) reasons.push("the pool's mid did not read, so the deviation arm cannot be evaluated from this page");
          return { wouldConvert: !stale && !wide && deviation.ok, reasons };
        })(),
      );

  // ── the two token blocks ──────────────────────────────────────────────────
  const legWad = (mint: string): Reading<{ readonly wad: bigint; readonly slot: number | null }> => {
    if (prices.kind !== "exists") return failed(whyNot(prices, "pinned pool accounts"));
    const wad = prices.value.legWads[mint];
    return wad === undefined ? failed(`no pinned Raydium CLMM/USDC pool mid was read for ${mint}`) : reads({ wad, slot: prices.value.slot });
  };

  const spyxMint = batch.ok && unread === null ? mintFrom(SPYX_MINT, batch.value[4], chainUnix) : failed(unread ?? "the read did not answer");
  const anthropicMint = batch.ok && unread === null ? mintFrom(ANTHROPIC_MINT, batch.value[5], chainUnix) : failed(unread ?? "the read did not answer");
  const spyxFeed = batch.ok && unread === null ? feedFrom("Crypto.SPYX/USD", PYTH_SPYX_USD_FEED, PYTH_SPYX_USD_FEED_ID_HEX, batch.value[3], chainUnix) : failed(unread ?? "the read did not answer");

  const tokenPool = (mint: string, mintRead: Reading<MintRead>): Reading<{ readonly microUsd: bigint; readonly wad: bigint; readonly slot: number | null }> => {
    const wad = legWad(mint);
    if (!wad.ok) return wad;
    if (!mintRead.ok) return failed(`${mintRead.why} — a raw pool rate cannot be turned into a price per token without the mint's decimals and multiplier`);
    return attempt("the pool mid could not be turned into a price per token", () => ({
      microUsd: legMicroUsdPerUiToken(wad.value.wad, mintRead.value.decimals, mintRead.value.multiplier.e12),
      wad: wad.value.wad,
      slot: wad.value.slot,
    }));
  };

  const spyxPool = tokenPool(SPYX_MINT, spyxMint);
  const anthropicPool = tokenPool(ANTHROPIC_MINT, anthropicMint);

  const spyx: EquityBlock = {
    symbol: "SPYx",
    mintAddress: SPYX_MINT,
    poolAddress: SPYX_USDC_POOL,
    feedAddress: PYTH_SPYX_USD_FEED,
    pool: spyxPool,
    mint: spyxMint,
    feed: spyxFeed,
    premium:
      spyxPool.ok && spyxFeed.ok
        ? attempt("the premium could not be taken", () => comparison(spyxPool.value.microUsd, spyxFeed.value.microUsd, null))
        : failed(blockedBy(spyxPool, spyxFeed) ?? "neither side of the comparison read"),
  };

  // UNITS FIRST. The API quotes dollars per UI-SCALED token; the pool trades raw
  // units. They are comparable only once the mint's decimals AND its live
  // scaledUiAmount multiplier are folded in — and the proof that the API really
  // is quoting the UI token is the mint's own supply: raw supply ÷ 10^decimals ×
  // multiplier must be the `supply` the API reports. If it is not, this page
  // shows the two numbers side by side and NO premium.
  const units: AnthropicBlock["units"] = !anthropicMint.ok
    ? failed(anthropicMint.why)
    : !api.ok
      ? failed(api.why)
      : attempt("the units could not be checked", () => {
          const mintRead = anthropicMint.value;
          // supply in UI tokens × 1e9, from the mint: raw × multiplier ÷ 10^decimals.
          const uiSupplyNano = (mintRead.supplyRaw * mintRead.multiplier.e12 * 1_000_000_000n) / (MULTIPLIER_ONE * 10n ** BigInt(mintRead.decimals));
          const apiNano = api.value.supplyNano;
          const gap = uiSupplyNano > apiNano ? uiSupplyNano - apiNano : apiNano - uiSupplyNano;
          // A tolerance of one part in a million covers the API's own rounding and nothing else.
          const comparable = apiNano > 0n && gap * 1_000_000n <= apiNano;
          const scale = `${mintRead.decimals} decimals`;
          return {
            comparable,
            why: comparable
              ? `the mint's own supply, read from the same account as the fee (${mintRead.supplyRaw} raw at ${scale}, scaledUiAmount multiplier ${mintRead.multiplier.value}), is the supply the API reports, so the API's dollars are dollars per UI-SCALED token and the pool's raw mid — scaled the same way — is the same quantity`
              : `the mint's supply comes to ${uiSupplyNano} nano-tokens (${mintRead.supplyRaw} raw at ${scale}, multiplier ${mintRead.multiplier.value}) and the API reports ${apiNano}: the two are not counting the same token, so this page shows both prices and NO premium`,
          };
        });

  const priced = (reference: bigint | null, why: string | null): Reading<Comparison> => {
    if (!anthropicPool.ok) return failed(anthropicPool.why);
    if (reference === null) return failed(why ?? "no reference price read");
    const incomparable = units.ok ? (units.value.comparable ? null : units.value.why) : units.why;
    return attempt("the comparison could not be taken", () => comparison(anthropicPool.value.microUsd, reference, incomparable));
  };

  const anthropicReserve = reserves.kind === "exists" ? reserves.value.items.find((item) => item.pool === ANTHROPIC_USDC_POOL) : undefined;
  const depthReading: AnthropicBlock["depth"] =
    reserves.kind !== "exists"
      ? failed(whyNot(reserves, "in-side vault for the pinned pools"))
      : anthropicReserve === undefined
        ? failed(`the read returned no in-side reserve for ${ANTHROPIC_USDC_POOL}`)
        : anthropicReserve.amountRaw === null
          ? failed(anthropicReserve.unreadable ?? "the pool's USDC side could not be counted")
          : reads({ usdcRaw: anthropicReserve.amountRaw, pool: ANTHROPIC_USDC_POOL, slot: reserves.value.slot });

  const anthropic: AnthropicBlock = {
    symbol: "ANTHROPIC",
    mintAddress: ANTHROPIC_MINT,
    poolAddress: ANTHROPIC_USDC_POOL,
    pool: anthropicPool,
    mint: anthropicMint,
    api,
    fee: anthropicMint.ok && chain.ok ? reads(feeInForce(anthropicMint.value.fee, chain.value.epoch)) : failed(blockedBy(anthropicMint, chain) ?? "the mint's fee did not read"),
    units,
    premiumOverToken: priced(api.ok ? api.value.tokenMicroUsd : null, api.ok ? null : api.why),
    premiumOverMark: priced(api.ok ? api.value.markMicroUsd : null, api.ok ? null : api.why),
    depth: depthReading,
  };

  return {
    builtAt,
    chain,
    slot,
    sol: { pool: solPool, oracle, deviation, guard },
    spyx,
    anthropic,
    shelf: shelf(),
    hermes,
    reference: { legRaw: CATALOGUE_REFERENCE_LEG_RAW, venueMultiple: CATALOGUE_VENUE_INVENTORY_MULTIPLE, minVenueRaw: CATALOGUE_MIN_VENUE_DEPTH_RAW },
    guard: KEEPER_ORACLE_GUARD,
    issuer: PRESTOCKS_POWERS,
  };
}

/** Every chain figure unread, for the same reason, with whatever the third party did answer. The page still renders. */
function degraded(input: { builtAt: string; why: string; hermes: HermesEquitySeam; api: Reading<PreStocksMark> }): PricesModel {
  const why = failed(input.why);
  return {
    builtAt: input.builtAt,
    chain: why,
    slot: null,
    sol: { pool: why, oracle: why, deviation: why, guard: why },
    spyx: { symbol: "SPYx", mintAddress: SPYX_MINT, poolAddress: SPYX_USDC_POOL, feedAddress: PYTH_SPYX_USD_FEED, pool: why, mint: why, feed: why, premium: why },
    anthropic: {
      symbol: "ANTHROPIC",
      mintAddress: ANTHROPIC_MINT,
      poolAddress: ANTHROPIC_USDC_POOL,
      pool: why,
      mint: why,
      api: input.api,
      fee: why,
      units: why,
      premiumOverToken: why,
      premiumOverMark: why,
      depth: why,
    },
    shelf: shelf(),
    hermes: input.hermes,
    reference: { legRaw: CATALOGUE_REFERENCE_LEG_RAW, venueMultiple: CATALOGUE_VENUE_INVENTORY_MULTIPLE, minVenueRaw: CATALOGUE_MIN_VENUE_DEPTH_RAW },
    guard: KEEPER_ORACLE_GUARD,
    issuer: PRESTOCKS_POWERS,
  };
}
