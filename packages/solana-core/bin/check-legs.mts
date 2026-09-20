// pnpm --dir packages/solana-core check:legs [rpc-url]
//
// The on-chain half of the catalogue (test/product.test.ts is the other half,
// and it can only pin the numbers to each other). OFFERED_LEGS names mints,
// token programs, decimals, account sizes and pools that ONLY mainnet can
// confirm, and a wrong one is not a failed test but a policy whose buy reverts
// after the owner has signed it. Read-only: one getEpochInfo and two
// getMultipleAccounts, nothing signed, non-zero exit on the first leg that does
// not hold up.
//
// STRUCTURAL VALIDITY IS NOT ROUTABILITY. PreStocks mints other than the one
// offered here have Raydium CLMM/USDC pools with the right owner, the right
// 1544 bytes and the right mint order, and no liquidity whatever: a buy finds no
// route through them. So the pool's own token vaults are read too, and a leg
// whose stock-side vault could not serve the largest purchase this product's own
// caps permit fails however perfect its layout.
//
// AND THAT BAR USED TO BE THE WRONG ONE. It asked for ten DEFAULT_PURCHASE_USDC_RAW
// buys — ten times $5, fifty dollars — which is not a number this product can
// produce. max_per_call caps the WHOLE BASKET, not each leg: the keeper takes
// perCall = min(usdc, max_per_call) and then splits it by weight_bps
// (solana-keeper/src/invest-tick.ts), so ONE turn can put max_per_call times a
// leg's weight into ONE pool. At the caps the build route ships that is $500 a
// leg, a hundred times the bar that was being measured — which is how a pool
// holding about $51 was passed two days before it had to serve a real sweep.

import {
  DEFAULT_INVEST_CAPS,
  DEFAULT_PUBKEY,
  DEFAULT_PURCHASE_USDC_RAW,
  LEG_WEIGHT_TOTAL_BPS,
  OFFERED_LEGS,
  RAYDIUM_CLMM,
  USDC_MINT,
  WAD,
  base58Encode,
  basketWeightsBps,
  decodeClmmPoolPrice,
  defaultInvestPolicy,
  legWadFromSqrtPrice,
  tryBase64Decode,
  CLMM_POOL_STATE_BYTES,
} from "../src/client/index";

const DEFAULT_RPC_URL = "https://api.mainnet-beta.solana.com";
const COMMITMENT = "confirmed";

/** The most a leg's mint may charge to transfer, in bps. ANTHROPIC charges 50; past this it is a different product and the floors stop covering the buy. */
const MAX_LEG_FEE_BPS = 100;

/**
 * How many times over the pool's stock-side vault must cover the LARGEST single
 * purchase the shipped caps permit, at the pool's own rate, before its depth
 * counts as real.
 *
 * WHAT THIS MARGIN IS AND IS NOT. The vault balance is a HARD bound — a swap
 * cannot pay out stock the pool does not hold, so a vault under one purchase is
 * a leg that provably cannot be bought. It is only a CRUDE PROXY for price
 * impact, which needs the tick liquidity map this checker does not read: a CLMM
 * concentrates its liquidity, so the impact of a given buy is not a function of
 * the vault total. Passing this bar is therefore necessary and never sufficient.
 *
 * The ten is for DRIFT between this check and the sweep that relies on it, and
 * it is not a theoretical worry: FIGUREAI's pool held roughly $6,700 when it
 * last passed here and about $51 two days later, while still passing the $50 bar
 * this file used to apply. Ten times the largest permitted purchase is the
 * stated margin. Both figures are printed per leg so it can be read, not assumed.
 */
const MIN_VAULT_COVER = 10n;

// Token-2022 mint: decimals sit after mint_authority (COption<Pubkey>, 36) and
// supply (u64, 8). Every mint is padded to the 165-byte base account, then one
// account-type byte, then the TLV extensions: u16 type, u16 length, value.
const MINT_DECIMALS_AT = 44;
const MINT_EXTENSIONS_AT = 166;
const EXT_UNINITIALIZED = 0;
const EXT_TRANSFER_FEE_CONFIG = 1;
const EXT_TRANSFER_HOOK = 14;

// A TransferFeeConfig's value: transfer_fee_config_authority (32),
// withdraw_withheld_authority (32), withheld_amount (u64), then two TransferFee
// records of 18 bytes each — epoch (u64), maximum_fee (u64), basis points (u16).
const OLDER_FEE_AT = 72;
const NEWER_FEE_AT = 90;
const FEE_BPS_AT = 16;

/** A TransferHook's value: authority (32), then the hook's program id. The null key means no hook program is invoked. */
const HOOK_PROGRAM_AT = 32;

// PoolState's token vaults, the two 32-byte fields after mint0 (73) and mint1
// (105), which clmm-price.ts reads. A token account's amount, classic or
// Token-2022, sits after mint (32) and owner (32).
const VAULT0_AT = 137;
const VAULT1_AT = 169;
const TOKEN_AMOUNT_AT = 64;

const u16At = (bytes: Uint8Array, at: number): number => bytes[at]! | (bytes[at + 1]! << 8);

function u64At(bytes: Uint8Array, at: number): bigint {
  let value = 0n;
  for (let i = 7; i >= 0; i--) value = (value << 8n) | BigInt(bytes[at + i]!);
  return value;
}

const keyAt = (bytes: Uint8Array, at: number): string => base58Encode(bytes.subarray(at, at + 32));

const short = (key: string): string => `${key.slice(0, 6)}…${key.slice(-4)}`;

interface MintExtension {
  readonly type: number;
  readonly value: Uint8Array;
}

/** Every TLV extension of a mint, in order. A classic SPL mint, or a Token-2022 mint with none, has no bytes past the base account. */
function mintExtensions(data: Uint8Array): MintExtension[] {
  const found: MintExtension[] = [];
  let at = MINT_EXTENSIONS_AT;
  while (at + 4 <= data.length) {
    const type = u16At(data, at);
    const length = u16At(data, at + 2);
    // Uninitialized is the padding past the last extension, not an extension.
    if (type === EXT_UNINITIALIZED) break;
    if (at + 4 + length > data.length) throw new Error(`extension ${type} claims ${length} bytes, ${at + 4 + length - data.length} past the end of the account`);
    found.push({ type, value: data.subarray(at + 4, at + 4 + length) });
    at += 4 + length;
  }
  return found;
}

interface TransferFee {
  readonly epoch: bigint;
  readonly bps: number;
}

const transferFeeAt = (value: Uint8Array, at: number): TransferFee => ({ epoch: u64At(value, at), bps: u16At(value, at + FEE_BPS_AT) });

/** The fee the chain applies right now: the newer one from its epoch onwards, the older one until then. */
function activeTransferFee(value: Uint8Array, currentEpoch: bigint): { readonly fee: TransferFee; readonly which: string } {
  const newer = transferFeeAt(value, NEWER_FEE_AT);
  if (currentEpoch >= newer.epoch) return { fee: newer, which: "newer" };
  return { fee: transferFeeAt(value, OLDER_FEE_AT), which: "older" };
}

let nextRequestId = 1;

async function rpc<T>(url: string, method: string, params: readonly unknown[]): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextRequestId++, method, params }),
  });
  if (!response.ok) throw new Error(`${method}: the RPC answered HTTP ${response.status}`);
  const body = (await response.json()) as { result?: T; error?: { message?: string } };
  if (body.error !== undefined) throw new Error(`${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
  if (body.result === undefined) throw new Error(`${method}: the RPC answered no result`);
  return body.result;
}

interface Account {
  readonly owner: string;
  readonly data: Uint8Array;
}

/** getMultipleAccounts for `addresses`, in that order. null for an account the chain does not have; anything unreadable throws. */
async function readAccounts(url: string, addresses: readonly string[]): Promise<(Account | null)[]> {
  const result = await rpc<{ value?: unknown }>(url, "getMultipleAccounts", [addresses, { encoding: "base64", commitment: COMMITMENT }]);
  const value = result.value;
  if (!Array.isArray(value) || value.length !== addresses.length) throw new Error("getMultipleAccounts did not answer every address");
  return value.map((account, index) => {
    if (account === null) return null;
    const candidate = account as { owner?: unknown; data?: unknown };
    const data = Array.isArray(candidate.data) ? tryBase64Decode(candidate.data[0]) : null;
    if (typeof candidate.owner !== "string" || data === null) throw new Error(`${addresses[index]}: the RPC did not answer base64 account data`);
    return { owner: candidate.owner, data };
  });
}

/** What `usdcRaw` buys at the pool's own rate: legWad is leg raw per USDC raw × 1e18. */
const legRawFor = (usdcRaw: bigint, legWad: bigint): bigint => (usdcRaw * legWad) / WAD;

/** A USDC raw amount as dollars. For the report only; every comparison below is on raw integers. */
const usd = (raw: bigint): string => `$${(Number(raw) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** `have / need` to two decimals, from integers. For the report only. */
const times = (have: bigint, need: bigint): string => (need === 0n ? "∞" : `${Number((have * 100n) / need) / 100}×`);

// ── THE BAR, DERIVED FROM THE CAPS THIS PRODUCT SHIPS ────────────────────────
//
// WHAT ONE TURN CAN PUT INTO ONE POOL IS max_per_call × THAT LEG'S WEIGHT.
// src/server/build-handler.ts builds set_invest_policy with
// DEFAULT_INVEST_CAPS.maxPerCall unless the request names another, and with
// basketWeightsBps(OFFERED_LEGS.length); the keeper then takes
// perCall = min(usdc, max_per_call) and splits THAT by the same weights. So the
// largest single purchase a pool must serve is the product of the two, and it is
// read from the shipped constants here rather than written down.
//
// min_investment is the other end of the same range — defaultInvestPolicy's
// DEFAULT_PURCHASE_USDC_RAW over the leg count — and is printed as context, not
// as the bar: it is the smallest turn, and a pool that can only serve the
// smallest turn is exactly the pool this check exists to refuse.
//
// rules.ts's own defaultInvestPolicy leaves max_per_call at u64::MAX; the PRODUCT
// overrides it with DEFAULT_INVEST_CAPS, and the override is what ships, so the
// override is what is measured. A request naming a LARGER cap buys more than was
// checked here, which is the owner's to do and the owner's to size a pool for.
const SHIPPED_WEIGHTS_BPS = basketWeightsBps(OFFERED_LEGS.length);
const SHIPPED_MIN_INVESTMENT = defaultInvestPolicy(OFFERED_LEGS.length).minInvestment;
const SHIPPED_MAX_PER_CALL = DEFAULT_INVEST_CAPS.maxPerCall;

/** `usdcRaw` split off for a leg of `weightBps`, exactly as invest-tick.ts splits it. */
const legShare = (usdcRaw: bigint, weightBps: number): bigint => (usdcRaw * BigInt(weightBps)) / BigInt(LEG_WEIGHT_TOTAL_BPS);

const rpcUrl = process.argv[2] ?? DEFAULT_RPC_URL;

const problems: string[] = [];
const lines: string[] = [];

const { epoch: currentEpochNumber } = await rpc<{ epoch: number }>(rpcUrl, "getEpochInfo", [{ commitment: COMMITMENT }]);
const currentEpoch = BigInt(currentEpochNumber);

const mints = OFFERED_LEGS.map((leg) => leg.mint);
const pools = OFFERED_LEGS.map((leg) => leg.pool);
const [mintAccounts, poolAccounts] = await Promise.all([readAccounts(rpcUrl, mints), readAccounts(rpcUrl, pools)]);

// The vaults are named by the pools, so they take a second round trip. A pool
// that did not decode contributes nothing to read: its leg has already failed.
const vaultAddresses: string[] = [];
poolAccounts.forEach((account) => {
  if (account === null || account.data.length !== CLMM_POOL_STATE_BYTES) return;
  vaultAddresses.push(keyAt(account.data, VAULT0_AT), keyAt(account.data, VAULT1_AT));
});
const vaultAccounts = vaultAddresses.length > 0 ? await readAccounts(rpcUrl, vaultAddresses) : [];
const vaultByAddress = new Map(vaultAddresses.map((address, index) => [address, vaultAccounts[index]!]));

for (const [index, leg] of OFFERED_LEGS.entries()) {
  const fail = (problem: string): void => void problems.push(`${leg.symbol}: ${problem}`);
  const note: string[] = [];
  /** The depth arithmetic, printed under this leg's line: required and available, side by side. */
  const depth: string[] = [];

  // ── the mint ───────────────────────────────────────────────────────────────
  const mint = mintAccounts[index]!;
  if (mint === null) fail(`its mint ${leg.mint} does not exist`);
  else {
    if (mint.owner !== leg.tokenProgram) fail(`its mint is owned by ${mint.owner}, not the declared token program ${leg.tokenProgram}`);
    const decimals = mint.data[MINT_DECIMALS_AT];
    if (decimals !== leg.decimals) fail(`its mint has ${decimals} decimals, the catalogue says ${leg.decimals}`);

    let extensions: MintExtension[] = [];
    try {
      extensions = mintExtensions(mint.data);
    } catch (error) {
      fail(`its mint's extensions cannot be walked: ${error instanceof Error ? error.message : String(error)}`);
    }

    const hook = extensions.find((extension) => extension.type === EXT_TRANSFER_HOOK);
    if (hook === undefined) note.push("no transfer hook");
    else {
      const program = keyAt(hook.value, HOOK_PROGRAM_AT);
      if (program !== DEFAULT_PUBKEY) fail(`its mint's transfer hook names program ${program}; only a null hook is relayable, a real one needs transfer_checked_with_transfer_hook`);
      else note.push("hook null");
    }

    const feeConfig = extensions.find((extension) => extension.type === EXT_TRANSFER_FEE_CONFIG);
    if (feeConfig === undefined) note.push("fee 0 bps (no extension)");
    else {
      const { fee, which } = activeTransferFee(feeConfig.value, currentEpoch);
      if (fee.bps > MAX_LEG_FEE_BPS) fail(`its mint charges ${fee.bps} bps to transfer (the ${which} fee, live from epoch ${fee.epoch}); the ceiling is ${MAX_LEG_FEE_BPS}`);
      note.push(`fee ${fee.bps} bps (${which}, from epoch ${fee.epoch}, epoch now ${currentEpoch})`);
      // A FEE RISE THE ISSUER HAS ALREADY WRITTEN DOWN. The newer record is not
      // live yet, so it cannot fail this run — but it is what the chain will
      // charge from its epoch, and an epoch is hours. Printed so the rise is read
      // here rather than discovered by a sweep; the ceiling is compared with >,
      // so a scheduled fee EQUAL to it is still admitted.
      const scheduled = transferFeeAt(feeConfig.value, NEWER_FEE_AT);
      if (currentEpoch < scheduled.epoch) {
        note.push(`SCHEDULED ${scheduled.bps} bps from epoch ${scheduled.epoch}${scheduled.bps >= MAX_LEG_FEE_BPS ? ` — AT OR OVER THE ${MAX_LEG_FEE_BPS} BPS CEILING` : ""}`);
      }
    }
    note.push(`${mint.data.length} B mint`);
  }

  // ── the pool ───────────────────────────────────────────────────────────────
  const pool = poolAccounts[index]!;
  if (pool === null) {
    fail(`its pool ${leg.pool} does not exist`);
    lines.push(`  FAIL  ${leg.symbol.padEnd(9)} ${note.join(", ")}`);
    continue;
  }
  if (pool.owner !== RAYDIUM_CLMM) fail(`its pool is owned by ${pool.owner}, not Raydium CLMM ${RAYDIUM_CLMM}`);
  if (pool.data.length !== CLMM_POOL_STATE_BYTES) {
    fail(`its pool is ${pool.data.length} bytes, a Raydium CLMM pool is ${CLMM_POOL_STATE_BYTES}`);
    lines.push(`  FAIL  ${leg.symbol.padEnd(9)} ${note.join(", ")}`);
    continue;
  }

  let legWad: bigint | null = null;
  try {
    // decodeClmmPoolPrice reads mint0 at 73 and mint1 at 105, the offsets the
    // floors are priced from: the same bytes, checked the same way.
    const price = decodeClmmPoolPrice(pool.data);
    if (price.mint0 !== leg.mint || price.mint1 !== USDC_MINT) {
      fail(`its pool holds mint0 ${price.mint0} and mint1 ${price.mint1}; the floor needs mint0 ${leg.mint} and mint1 ${USDC_MINT}`);
    } else {
      legWad = legWadFromSqrtPrice(price.sqrtPriceX64);
      note.push(`pool ${short(leg.pool)} ${pool.data.length} B, mint0/mint1 pinned, decimals ${price.decimals0}/${price.decimals1}`);
    }
  } catch (error) {
    fail(`its pool does not decode: ${error instanceof Error ? error.message : String(error)}`);
  }

  // ── the depth, which no layout can vouch for ───────────────────────────────
  if (legWad !== null) {
    const stockVaultAddress = keyAt(pool.data, VAULT0_AT);
    const usdcVaultAddress = keyAt(pool.data, VAULT1_AT);
    const stockVault = vaultByAddress.get(stockVaultAddress) ?? null;
    const usdcVault = vaultByAddress.get(usdcVaultAddress) ?? null;
    if (stockVault === null || usdcVault === null) fail(`one of its pool's token vaults (${stockVaultAddress}, ${usdcVaultAddress}) does not exist: the pool holds nothing`);
    else if (keyAt(stockVault.data, 0) !== leg.mint || keyAt(usdcVault.data, 0) !== USDC_MINT) {
      fail(`its pool's vaults hold ${keyAt(stockVault.data, 0)} and ${keyAt(usdcVault.data, 0)}, not ${leg.mint} and USDC`);
    } else {
      const stockRaw = u64At(stockVault.data, TOKEN_AMOUNT_AT);
      const usdcRaw = u64At(usdcVault.data, TOKEN_AMOUNT_AT);
      const weightBps = SHIPPED_WEIGHTS_BPS[index]!;
      const largestBuy = legShare(SHIPPED_MAX_PER_CALL, weightBps);
      const smallestBuy = legShare(SHIPPED_MIN_INVESTMENT, weightBps);
      // At the pool's OWN rate, before any price impact: the least the pool must
      // hand over for that buy, which is already more than it would really pay.
      const perLargestBuy = legRawFor(largestBuy, legWad);
      const required = perLargestBuy * MIN_VAULT_COVER;
      // BOTH FIGURES, ALWAYS, PASS OR FAIL. A bar whose margin is only visible
      // when it trips is a bar nobody watches approaching.
      depth.push(
        `          one turn buys ${usd(smallestBuy)}–${usd(largestBuy)} of ${leg.symbol} here ` +
          `(${weightBps} bps of min_investment ${usd(SHIPPED_MIN_INVESTMENT)} – max_per_call ${usd(SHIPPED_MAX_PER_CALL)})`,
      );
      depth.push(`          need ${required} raw ${leg.symbol} = ${MIN_VAULT_COVER}× the ${perLargestBuy} raw that largest buy takes`);
      depth.push(`          have ${stockRaw} raw ${leg.symbol} (${times(stockRaw, perLargestBuy)} one largest buy, ${times(stockRaw, required)} the bar), ${usdcRaw} raw USDC on the other side`);
      if (perLargestBuy === 0n) fail(`its pool prices the largest permitted purchase, ${usd(largestBuy)}, at zero leg raw units: the rate is unusable`);
      else if (stockRaw < required) {
        fail(
          `its pool's ${leg.symbol} vault holds ${stockRaw} raw units, under ${required} — ${MIN_VAULT_COVER}× the ${usd(largestBuy)} one turn can push into this one pool ` +
            `(${weightBps} bps of max_per_call ${usd(SHIPPED_MAX_PER_CALL)}), which at this pool's own rate takes ${perLargestBuy} raw units. ` +
            `It covers ${times(stockRaw, perLargestBuy)} of a single such buy. A structurally perfect pool with no depth routes nothing.`,
        );
      }
    }
  }

  const failed = problems.some((problem) => problem.startsWith(`${leg.symbol}: `));
  lines.push(`  ${failed ? "FAIL" : " ok "}  ${leg.symbol.padEnd(9)} ${note.join(", ")}`);
  lines.push(...depth);
}

console.log(`check:legs against ${rpcUrl} (epoch ${currentEpoch}), ${OFFERED_LEGS.length} legs:`);
console.log(
  `  shipped caps: max_per_call ${usd(SHIPPED_MAX_PER_CALL)} for the WHOLE basket, min_investment ${usd(SHIPPED_MIN_INVESTMENT)} ` +
    `(${usd(DEFAULT_PURCHASE_USDC_RAW)} / ${OFFERED_LEGS.length} legs), weights ${SHIPPED_WEIGHTS_BPS.join("/")} bps`,
);
console.log(`  the bar: one turn splits max_per_call by weight, so each pool must hold ${MIN_VAULT_COVER}× what its own largest share buys.`);
for (const line of lines) console.log(line);

if (problems.length > 0) {
  console.error(`\ncheck:legs FAILED:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
  process.exit(1);
}
console.log(`check:legs ok: every leg's mint and pool is what OFFERED_LEGS says, fees at or under ${MAX_LEG_FEE_BPS} bps, and every pool holds ${MIN_VAULT_COVER}× its largest permitted purchase.`);
