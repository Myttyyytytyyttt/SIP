// pnpm --dir packages/solana-core check:legs [rpc-url]
//
// The on-chain half of the catalogue (test/product.test.ts is the other half,
// and it can only pin the numbers to each other). client/product.ts names
// mints, token programs, decimals, account sizes, fees, floor pools and market
// readings that ONLY mainnet can confirm, and a wrong one is not a failed test
// but a policy whose buy reverts after the owner has signed it. Read-only: one
// getEpochInfo, two getMultipleAccounts and two keyless Jupiter quotes per
// asset, nothing signed, non-zero exit on the first OFFERED leg that does not
// hold up.
//
// ── WHAT THIS CHECK USED TO BE, AND WHY IT COULD NOT STAY ────────────────────
//
// It used to prove ROUTABILITY by reading one pool: the entry pinned a Raydium
// CLMM pool, the keeper swapped through that same pool, so measuring the pool's
// stock-side vault against ten times the largest purchase the shipped caps
// permit measured the actual counterparty. Both halves of that are now false.
//
//  1. THE ROUTE IS NOT PINNED ANY MORE. The keeper buys through Jupiter
//     (invest-decision.ts ROUTABLE_VENUES), which re-picks per quote. Measured
//     2026-09-21: a 200 USDC SPYx buy routed a DIFFERENT Raydium pool from the
//     pinned one — 8.3x apart in USDC held — and the same buy of ANTHROPIC
//     routed BisonFi + Manifest, touching the pinned pool not at all. A bar
//     applied to the pinned pool would have been a measurement of a market
//     nobody was trading in, carrying a fresh timestamp. That is worse than no
//     measurement, because the timestamp is what a reader trusts.
//
//  2. DEPTH IS NOT A POOL RESERVE ANY MORE. The venues this product must reach
//     are a CLOB (Manifest) and a DLMM (Meteora); neither has an in-side
//     reserve to read. The keeper's gate counts, in the turn, the inventory of
//     the accounts THE CHOSEN ROUTE NAMES, at MIN_VENUE_INVENTORY_MULTIPLE
//     cover, plus a two-quote impact probe.
//
// ── SO THIS CHECK IS NOW THREE CHECKS, AND ONE THING IT REFUSES TO DO ────────
//
//  A. THE MINT, unchanged and still the strongest half: owner, decimals, the
//     extension set the catalogue's tokenAccountBytes is derived from, the live
//     transfer fee against the epoch it is live in, and a null transfer hook.
//     These are facts about an account, and an account is what mainnet answers.
//
//  B. THE FLOOR SOURCE, which is what `floorPool` now means: the pinned pool
//     must exist, be Raydium CLMM, hold the pinned pair in the pinned order —
//     because that is what the build route reads a leg's min_out_rate_wad from
//     — and hold at least CATALOGUE_MIN_FLOOR_POOL_RAW of USDC, because a mid
//     that costs a few dollars to move is not a price. This is no longer a
//     routability bar and is not reported as one.
//
//  C. THE MARKET, re-measured the only way a build-time script honestly can:
//     two Jupiter quotes, at the catalogue's reference leg and at a sixteenth
//     of it, which is the shape of the keeper's ARM 2. It proves a USDC route
//     exists at the size this product buys at, and it prices the turn's own
//     impact against the ceiling the keeper allows.
//
//  D. WHAT IT WILL NOT PRETEND TO DO: take the keeper's ARM 1 census. That
//     census counts the route's accounts MINUS the vault's own, so it is per
//     vault and there is no vault here; and it is taken against the spend of a
//     turn whose size depends on a max_per_call and weights the owner has not
//     typed yet. The catalogue's DEPTH readings are therefore PRINTED WITH
//     THEIR DATE AND NOT RE-VERIFIED, and this script says so on every run
//     rather than letting a green line imply otherwise.
//
// AND IT STILL CANNOT PROTECT AGAINST A VENUE DRAINING. FIGUREAI's pool held
// roughly $6,700 when this check last passed it, about $51 two days later, and
// $2,786.97 the day after that. A build-time check is a screen, not a gate; the
// gate is the keeper's, inside the turn, at the size that turn really spends.
//
// ── WHAT FAILS AND WHAT ONLY SPEAKS ──────────────────────────────────────────
//
// An OFFERED leg that breaks any rule FAILS the run: it is on the shelf and the
// shelf is wrong. A refused asset that now looks admissible only prints a
// NOTICE, because a market that dips under a ceiling for an afternoon must not
// turn this script red — the way an asset joins the catalogue is a human taking
// a reading and writing it into the entry, which is exactly what a notice asks
// for. A refused asset whose recorded reason is now VISIBLY STALE also prints a
// notice naming the number that moved.

import {
  CATALOGUE,
  CATALOGUE_MAX_FEE_BPS,
  CATALOGUE_MIN_FLOOR_POOL_RAW,
  CATALOGUE_MIN_VENUE_DEPTH_RAW,
  CATALOGUE_REFERENCE_LEG_RAW,
  CATALOGUE_VENUE_INVENTORY_MULTIPLE,
  DEFAULT_PUBKEY,
  OFFERED_LEGS,
  RAYDIUM_CLMM,
  USDC_MINT,
  base58Encode,
  decodeClmmPoolPrice,
  offerProblems,
  sizePenaltyCeilingBps,
  tryBase64Decode,
  CLMM_POOL_STATE_BYTES,
} from "../src/client/index";

const DEFAULT_RPC_URL = "https://api.mainnet-beta.solana.com";
const JUPITER_QUOTE_URL = "https://lite-api.jup.ag/swap/v1/quote";
const COMMITMENT = "confirmed";

/** The probe is a sixteenth of the turn, as invest-decision.ts probeAmount takes it. */
const PROBE_DIVISOR = 16n;

/** What the keeper's min-out.ts allows between a quote and its fill, and the budget sizePenaltyCeilingBps divides. */
const SLIPPAGE_BPS = 200;

// Token-2022 mint: decimals sit after mint_authority (COption<Pubkey>, 36) and
// supply (u64, 8). Every mint is padded to the 165-byte base account, then one
// account-type byte, then the TLV extensions: u16 type, u16 length, value.
const MINT_DECIMALS_AT = 44;
const MINT_EXTENSIONS_AT = 166;
const EXT_UNINITIALIZED = 0;
const EXT_TRANSFER_FEE_CONFIG = 1;
const EXT_TRANSFER_HOOK = 14;
const EXT_PAUSABLE = 26;

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

/** 165 base, 1 account type, then a 4-byte header plus its value per account-side extension. */
const ACCOUNT_BASE_BYTES = 166;
const IMMUTABLE_OWNER_BYTES = 4;
const PAUSABLE_ACCOUNT_BYTES = 4;
const TRANSFER_HOOK_ACCOUNT_BYTES = 5;
const TRANSFER_FEE_AMOUNT_BYTES = 12;

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
  if (addresses.length === 0) return [];
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

/** One quote as this script needs it: what came out, and the ORDERED venues it came out of. */
interface Quote {
  readonly outAmount: bigint;
  readonly ammKeys: readonly string[];
  readonly labels: readonly string[];
}

/** USDC -> mint at `amount` raw USDC. null when Jupiter will not price it, which is itself an answer. */
async function quote(mint: string, amount: bigint): Promise<Quote | { readonly problem: string }> {
  const url = `${JUPITER_QUOTE_URL}?inputMint=${USDC_MINT}&outputMint=${mint}&amount=${amount}&slippageBps=${SLIPPAGE_BPS}&swapMode=ExactIn`;
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    return { problem: `the quoter could not be reached: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!response.ok) return { problem: `the quoter answered HTTP ${response.status} for ${amount} raw USDC — no route at that size` };
  const body = (await response.json()) as { outAmount?: string; routePlan?: { swapInfo?: { ammKey?: string; label?: string } }[] };
  if (typeof body.outAmount !== "string" || !Array.isArray(body.routePlan)) return { problem: "the quoter answered no route plan" };
  return {
    outAmount: BigInt(body.outAmount),
    ammKeys: body.routePlan.map((step) => step.swapInfo?.ammKey ?? ""),
    labels: body.routePlan.map((step) => step.swapInfo?.label ?? "an unnamed venue"),
  };
}

const isQuote = (value: Quote | { problem: string }): value is Quote => "outAmount" in value;

/** ORDERED, and an unnamed hop never matches: the keeper's sameVenues, restated. */
const sameVenues = (turn: readonly string[], probe: readonly string[]): boolean =>
  turn.length === probe.length && turn.length > 0 && turn.every((key, index) => key.length > 0 && key === probe[index]);

/**
 * How much worse the turn's rate is than the probe's, in basis points, in
 * integers: (probeRate - turnRate) / probeRate, with rate = out / in.
 * Negative means the turn quoted BETTER, which happens and is not a problem.
 */
function sizePenaltyBps(turnIn: bigint, turn: Quote, probeIn: bigint, probe: Quote): bigint {
  const turnCross = turn.outAmount * probeIn;
  const probeCross = probe.outAmount * turnIn;
  if (probeCross === 0n) return 0n;
  return ((probeCross - turnCross) * 10_000n) / probeCross;
}

/** A USDC raw amount as dollars. For the report only; every comparison below is on raw integers. */
const usd = (raw: bigint): string => `$${(Number(raw) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const rpcUrl = process.argv[2] ?? DEFAULT_RPC_URL;

/** A problem with an OFFERED leg: the run fails on these. */
const problems: string[] = [];
/** Something a human should look at, on any asset: the run does not fail on these. */
const notices: string[] = [];
const lines: string[] = [];

const offeredMints = new Set(OFFERED_LEGS.map((leg) => leg.mint));

const { epoch: currentEpochNumber } = await rpc<{ epoch: number }>(rpcUrl, "getEpochInfo", [{ commitment: COMMITMENT }]);
const currentEpoch = BigInt(currentEpochNumber);

const mints = CATALOGUE.map((asset) => asset.mint);
const floorPools = CATALOGUE.map((asset) => asset.floorPool).filter((pool): pool is string => pool !== null);
const [mintAccounts, poolAccounts] = await Promise.all([readAccounts(rpcUrl, mints), readAccounts(rpcUrl, floorPools)]);
const poolByAddress = new Map(floorPools.map((address, index) => [address, poolAccounts[index]!]));

// The vaults are named by the pools, so they take a second round trip.
const vaultAddresses: string[] = [];
for (const account of poolAccounts) {
  if (account === null || account.data.length !== CLMM_POOL_STATE_BYTES) continue;
  vaultAddresses.push(keyAt(account.data, VAULT0_AT), keyAt(account.data, VAULT1_AT));
}
const vaultAccounts = await readAccounts(rpcUrl, vaultAddresses);
const vaultByAddress = new Map(vaultAddresses.map((address, index) => [address, vaultAccounts[index]!]));

const probeRaw = CATALOGUE_REFERENCE_LEG_RAW / PROBE_DIVISOR;

for (const [index, asset] of CATALOGUE.entries()) {
  const offered = offeredMints.has(asset.mint);
  const say = (problem: string): void => void (offered ? problems : notices).push(`${asset.symbol}: ${problem}`);
  const note: string[] = [];
  const detail: string[] = [];

  // ── A. THE MINT ────────────────────────────────────────────────────────────
  const mint = mintAccounts[index]!;
  let liveFeeBps: number | null = null;
  if (mint === null) say(`its mint ${asset.mint} does not exist`);
  else {
    if (mint.owner !== asset.tokenProgram) say(`its mint is owned by ${mint.owner}, not the declared token program ${asset.tokenProgram}`);
    const decimals = mint.data[MINT_DECIMALS_AT];
    if (decimals !== asset.decimals) say(`its mint has ${decimals} decimals, the catalogue says ${asset.decimals}`);

    let extensions: MintExtension[] = [];
    try {
      extensions = mintExtensions(mint.data);
    } catch (error) {
      say(`its mint's extensions cannot be walked: ${error instanceof Error ? error.message : String(error)}`);
    }

    const hook = extensions.find((extension) => extension.type === EXT_TRANSFER_HOOK);
    if (hook === undefined) note.push("no transfer hook");
    else {
      const program = keyAt(hook.value, HOOK_PROGRAM_AT);
      if (program !== DEFAULT_PUBKEY) say(`its mint's transfer hook names program ${program}; only a null hook is relayable, a real one needs transfer_checked_with_transfer_hook`);
      else note.push("hook null");
    }

    const feeConfig = extensions.find((extension) => extension.type === EXT_TRANSFER_FEE_CONFIG);
    if (feeConfig === undefined) {
      liveFeeBps = 0;
      // THE STRONGER FACT, AND THE ONLY PLACE IT CAN BE CHECKED. A Token-2022
      // mint's extensions are fixed at initialisation, so a mint with no
      // TransferFeeConfig cannot be given one by anybody, ever. That is what
      // the catalogue's xStocks group claims, and this is what confirms it.
      note.push("fee 0 bps, NO transfer-fee extension: none can be added to an initialised mint");
    } else {
      const { fee, which } = activeTransferFee(feeConfig.value, currentEpoch);
      liveFeeBps = fee.bps;
      if (fee.bps > CATALOGUE_MAX_FEE_BPS) say(`its mint charges ${fee.bps} bps to transfer (the ${which} fee, live from epoch ${fee.epoch}); the ceiling is ${CATALOGUE_MAX_FEE_BPS}`);
      else if (fee.bps === CATALOGUE_MAX_FEE_BPS) note.push(`fee ${fee.bps} bps — EXACTLY THE CEILING, zero margin (${which}, from epoch ${fee.epoch})`);
      else note.push(`fee ${fee.bps} bps (${which}, from epoch ${fee.epoch}, epoch now ${currentEpoch})`);
      // A FEE RISE THE ISSUER HAS ALREADY WRITTEN DOWN, printed so the rise is
      // read here rather than discovered by a sweep. The ceiling is compared
      // with >, so a scheduled fee EQUAL to it is still admitted.
      const scheduled = transferFeeAt(feeConfig.value, NEWER_FEE_AT);
      if (currentEpoch < scheduled.epoch) {
        note.push(`SCHEDULED ${scheduled.bps} bps from epoch ${scheduled.epoch}${scheduled.bps >= CATALOGUE_MAX_FEE_BPS ? ` — AT OR OVER THE ${CATALOGUE_MAX_FEE_BPS} BPS CEILING` : ""}`);
      }
    }

    // THE SIZE THE OWNER'S RENT IS QUOTED FOR, DERIVED FROM THE SAME BYTES.
    const derivedBytes =
      ACCOUNT_BASE_BYTES +
      IMMUTABLE_OWNER_BYTES +
      (extensions.some((extension) => extension.type === EXT_PAUSABLE) ? PAUSABLE_ACCOUNT_BYTES : 0) +
      (hook === undefined ? 0 : TRANSFER_HOOK_ACCOUNT_BYTES) +
      (feeConfig === undefined ? 0 : TRANSFER_FEE_AMOUNT_BYTES);
    if (derivedBytes !== asset.tokenAccountBytes) {
      say(`its mint's extensions imply a ${derivedBytes}-byte token account, the catalogue says ${asset.tokenAccountBytes}: the owner would be quoted the wrong rent`);
    }

    if (asset.fee !== null && liveFeeBps !== null && liveFeeBps !== asset.fee.bps) {
      const drift = `the catalogue recorded ${asset.fee.bps} bps on ${asset.fee.readOn} (epoch ${asset.fee.epoch}) and the mint now charges ${liveFeeBps}`;
      if (offered) say(drift);
      else notices.push(`${asset.symbol}: ${drift}`);
    }
  }

  // ── B. THE FLOOR SOURCE ────────────────────────────────────────────────────
  if (asset.floorPool === null) note.push("no floor pool pinned");
  else {
    const pool = poolByAddress.get(asset.floorPool) ?? null;
    if (pool === null) say(`its floor pool ${asset.floorPool} does not exist`);
    else if (pool.owner !== RAYDIUM_CLMM) say(`its floor pool is owned by ${pool.owner}, not Raydium CLMM ${RAYDIUM_CLMM}`);
    else if (pool.data.length !== CLMM_POOL_STATE_BYTES) say(`its floor pool is ${pool.data.length} bytes, a Raydium CLMM pool is ${CLMM_POOL_STATE_BYTES}`);
    else {
      try {
        // decodeClmmPoolPrice reads mint0 at 73 and mint1 at 105, the offsets
        // the floors are priced from: the same bytes, checked the same way.
        const price = decodeClmmPoolPrice(pool.data);
        if (price.mint0 !== asset.mint || price.mint1 !== USDC_MINT) {
          say(`its floor pool holds mint0 ${price.mint0} and mint1 ${price.mint1}; the floor needs mint0 ${asset.mint} and mint1 ${USDC_MINT}`);
        } else {
          note.push(`floor pool ${short(asset.floorPool)}, mint0/mint1 pinned, decimals ${price.decimals0}/${price.decimals1}`);
        }
      } catch (error) {
        say(`its floor pool does not decode: ${error instanceof Error ? error.message : String(error)}`);
      }

      const usdcVaultAddress = keyAt(pool.data, VAULT1_AT);
      const usdcVault = vaultByAddress.get(usdcVaultAddress) ?? null;
      if (usdcVault === null) say(`its floor pool's USDC vault ${usdcVaultAddress} does not exist: the pool holds nothing to price against`);
      else if (keyAt(usdcVault.data, 0) !== USDC_MINT) say(`its floor pool's second vault holds ${keyAt(usdcVault.data, 0)}, not USDC`);
      else {
        const held = u64At(usdcVault.data, TOKEN_AMOUNT_AT);
        detail.push(`          floor source holds ${usd(held)} of USDC (needs ${usd(CATALOGUE_MIN_FLOOR_POOL_RAW)} for its mid to be a price, not a number anyone can set)`);
        if (held < CATALOGUE_MIN_FLOOR_POOL_RAW) {
          say(`its floor pool holds ${usd(held)} of USDC, under ${usd(CATALOGUE_MIN_FLOOR_POOL_RAW)}: a mid that cheap to move is not a price to sign a floor against`);
        }
        if (asset.floorPoolUsdc !== null) {
          const recorded = asset.floorPoolUsdc.usdcRaw;
          const movedBps = recorded === 0n ? 0n : ((held - recorded) * 10_000n) / recorded;
          detail.push(`          the catalogue recorded ${usd(recorded)} on ${asset.floorPoolUsdc.readOn}: ${movedBps >= 0n ? "+" : ""}${movedBps} bps since`);
        }
      }
    }
  }

  // ── C. THE MARKET ──────────────────────────────────────────────────────────
  const turn = await quote(asset.mint, CATALOGUE_REFERENCE_LEG_RAW);
  const probe = await quote(asset.mint, probeRaw);
  if (!isQuote(turn)) say(`no USDC route at the ${usd(CATALOGUE_REFERENCE_LEG_RAW)} reference leg: ${turn.problem}`);
  else if (!isQuote(probe)) detail.push(`          the ${usd(probeRaw)} probe found no route (${probe.problem}), so the turn's own impact could not be measured`);
  else {
    const penalty = sizePenaltyBps(CATALOGUE_REFERENCE_LEG_RAW, turn, probeRaw, probe);
    const ceiling = sizePenaltyCeilingBps(liveFeeBps ?? CATALOGUE_MAX_FEE_BPS);
    const scope = sameVenues(turn.ammKeys, probe.ammKeys) ? "same venues, the keeper's own ARM 2 scope" : "DIFFERENT venues, so the keeper's ARM 2 would abstain and this is the coarser screening number";
    detail.push(`          ${usd(CATALOGUE_REFERENCE_LEG_RAW)} routes ${turn.labels.join(" + ")}, the ${usd(probeRaw)} probe routes ${probe.labels.join(" + ")}`);
    detail.push(`          size penalty ${penalty} bps against a ceiling of ${ceiling} (${scope})`);
    if (penalty > BigInt(ceiling)) {
      say(`a ${usd(CATALOGUE_REFERENCE_LEG_RAW)} buy quotes ${penalty} bps worse than a ${usd(probeRaw)} probe, over the ${ceiling} bps this keeper allows a turn's own impact`);
    }
    if (asset.sizePenalty !== null) {
      detail.push(`          the catalogue recorded ${asset.sizePenalty.bps} bps on ${asset.sizePenalty.readOn}`);
    }
  }

  // ── D. THE DEPTH THE CATALOGUE RECORDS AND THIS SCRIPT DOES NOT RE-TAKE ────
  if (asset.depth === null) detail.push("          depth: NEVER MEASURED");
  else {
    detail.push(
      `          depth: ${usd(asset.depth.usdcRaw)} at ${asset.depth.venue} (${asset.depth.scope}, read ${asset.depth.readOn}) — NOT re-verified here; ` +
        `the bar is ${usd(CATALOGUE_MIN_VENUE_DEPTH_RAW)}, ${CATALOGUE_VENUE_INVENTORY_MULTIPLE}x the ${usd(CATALOGUE_REFERENCE_LEG_RAW)} reference leg`,
    );
  }
  if (asset.quarantinedUntil !== null) detail.push(`          held out until ${asset.quarantinedUntil}; clearing that date means taking a fresh reading, not deleting the line`);

  // ── THE CATALOGUE'S OWN VERDICT, BESIDE THE LIVE ONE ──────────────────────
  const recorded = offerProblems(asset);
  const failed = (offered ? problems : notices).some((problem) => problem.startsWith(`${asset.symbol}: `));
  lines.push(`  ${offered ? (failed ? "FAIL" : " ok ") : "  - "}  ${asset.symbol.padEnd(11)} ${asset.group.padEnd(9)} ${note.join(", ")}`);
  if (recorded.length > 0) for (const problem of recorded) lines.push(`          refused on ${problem.rule}: ${problem.why}`);
  lines.push(...detail);

  // A refused asset that the live readings no longer refuse is a reading
  // somebody should take, not a failure: the catalogue changes by measurement.
  if (!offered && !failed && recorded.every((problem) => problem.rule === "DEPTH" || problem.rule === "PRICE_AT_SIZE")) {
    notices.push(`${asset.symbol}: every rule it is recorded as failing is one this run re-measured, and it passed. Take a reading and consider offering it.`);
  }
}

console.log(`check:legs against ${rpcUrl} (epoch ${currentEpoch}) and ${JUPITER_QUOTE_URL}: ${CATALOGUE.length} assets, ${OFFERED_LEGS.length} offered.`);
console.log(`  the reference leg is ${usd(CATALOGUE_REFERENCE_LEG_RAW)}: max_per_call split across a full basket, which is the share one turn can push into one leg.`);
console.log("  what this run proves: the mints, the floor sources, and a live route at that size. What it does NOT prove: the keeper's own ARM 1 census, which is per vault and is taken inside the turn.");
for (const line of lines) console.log(line);

if (notices.length > 0) console.log(`\ncheck:legs notices (these do not fail the run):\n${notices.map((notice) => `  - ${notice}`).join("\n")}`);

if (problems.length > 0) {
  console.error(`\ncheck:legs FAILED on an OFFERED leg:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
  process.exit(1);
}
console.log(`\ncheck:legs ok: every offered leg is what the catalogue says it is, its floor source is a real Raydium CLMM pool with a price worth signing against, and a ${usd(CATALOGUE_REFERENCE_LEG_RAW)} USDC route exists for it today.`);
