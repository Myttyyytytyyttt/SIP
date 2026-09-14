#!/usr/bin/env node
// Builds the pinned stock configuration for NuvemStockAdapter, from the chain.
//
//   node scripts/discover-stock-pools.mjs --rpc <url> [--limit N] [--out report.json]
//
// WHY THIS EXISTS RATHER THAN A HAND-WRITTEN LIST. The adapter pins one
// `(fee, tickSpacing)` per stock, immutably, and that pair IS the choice of
// counterparty — there is no oracle behind it any more. Choosing wrong is not a
// rounding error: mainnet carries HOOKLESS USDG/stock pools at 85%, 90%, 95% and
// 99.9% with real liquidity, and one at 1% that is 74 bps worse and 31x shallower
// than the right one. All of them are initialised, all of them fill, and all of
// them pass every structural check the adapter makes.
//
// So the numbers are measured, and the measurement is written down.
//
// THREE SOURCES, EACH DOING ONE THING:
//
//   1. Uniswap Labs' token list gives CANDIDATES. It is third-party curation,
//      not the issuer's word — Robinhood publishes no machine-readable list, its
//      docs only say the table is "generated live from the on-chain asset
//      registry" without naming it. So the list is where to look, never proof.
//   2. The chain gives IDENTITY: `ACCESS_CONTROLLED_REGISTRY` and the shared
//      proxy codehash. This is what rejects the entries on the list that are not
//      stock tokens at all — measured, exactly one of 201: CASHCAT.
//   3. `Initialize` events plus live liquidity give the POOL.
//
// WHAT IT STILL CANNOT DO, and nobody should read the output as claiming it: the
// structural checks do not establish that a token is the stock it says it is.
// `Stock.initialize(uid, name, symbol)` has no role check on this chain, so a
// clone carries the same registry, the same codehash and the symbol "NVDA" and
// passes all of it. Two "Fake NVDA" tokens even have hookless USDG pools at
// exactly fee 3000 / tickSpacing 60. Being on Uniswap's curated list is the only
// thing separating them here, and that is a judgement made by someone else.

import { writeFileSync } from "node:fs";
import {
  createPublicClient,
  encodeAbiParameters,
  http,
  keccak256,
  toEventSelector,
  toFunctionSelector,
} from "viem";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);

const RPC = args.get("--rpc") ?? process.env.NUVEM_RPC_URL;
if (!RPC) {
  console.error("usage: node scripts/discover-stock-pools.mjs --rpc <url> [--limit N] [--out report.json]");
  process.exit(2);
}
const LIMIT = args.get("--limit") ? Number(args.get("--limit")) : Infinity;
const OUT = args.get("--out") ?? "stock-pools.json";

// ── the pinned world ─────────────────────────────────────────────────────────

const TOKEN_LIST = "https://tokens.uniswap.org";
const CHAIN_ID = 4663;
const POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const STOCK_REGISTRY = "0xe10b6f6B275de231345c20D14Ab812db62151b00";
const STOCK_CODEHASH = "0x6c1fdd40002dcb440c7fff6a84171404d279ccb057803b65826f7546acd65630";

/**
 * One percent, matching `DeployStockAdapter.MAX_PLAUSIBLE_POOL_FEE`.
 *
 * The two numbers must agree or this script recommends configurations the deploy
 * script then refuses — which reads as a broken tool rather than as a policy.
 * Both were 10% and both moved: at 10% the sweep returned pools at 5% and 10% as
 * acceptable, and only a human reading the output stopped them.
 */
const MAX_PLAUSIBLE_FEE = 10_000;

/**
 * THE FILTER IS A MEASURED COST, NOT A LIQUIDITY NUMBER.
 *
 * It began as `liquidity >= 1e12` and that was wrong in a way worth recording:
 * v4's `liquidity` is √(x·y) in the pool's own units, so it is not comparable
 * across pools with different prices and different decimals. QQQ/USDG holds
 * 4.28e13 — forty times the threshold — and a $100 purchase through it costs
 * 824 bps. At $500 it costs 3,041. At $5,000, 8,128. It passed a filter that
 * NVDA passed with 30 bps, because the two numbers were never the same quantity.
 *
 * So the test is the only thing anyone actually cares about: simulate a purchase
 * and price it. A pool that cannot fill this size for a sane cost is not a pool
 * this protocol can use, whatever its liquidity reads.
 */
const PROBE_USD = 500;
const MAX_PROBE_COST_BPS = 100;

const INITIALIZE_TOPIC = toEventSelector(
  "Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)",
);
const EXTSLOAD = toFunctionSelector("extsload(bytes32)");
const REGISTRY_GETTER = toFunctionSelector("ACCESS_CONTROLLED_REGISTRY()");

const client = createPublicClient({ transport: http(RPC) });
const pad = (address) => `0x${address.toLowerCase().replace("0x", "").padStart(64, "0")}`;

async function extsload(target, slot) {
  const raw = await client.request({
    method: "eth_call",
    params: [{ to: target, data: `${EXTSLOAD}${slot.toString(16).padStart(64, "0")}` }, "latest"],
  });
  return BigInt(raw);
}

function poolId(currency0, currency1, fee, tickSpacing) {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [currency0, currency1, fee, tickSpacing, "0x0000000000000000000000000000000000000000"],
    ),
  );
}

/**
 * What a PROBE_USD purchase costs through this pool, in basis points.
 *
 * Exact-in within the current tick, which is the same arithmetic the keeper
 * quotes with. Returns null when the pool cannot be priced at all — an inverted
 * pair or an empty one — rather than a number that looks like an answer.
 */
function probeCostBps(sqrtPriceX96, liquidity, feePips, usdgIsCurrency0) {
  if (liquidity === 0n || sqrtPriceX96 === 0n) return null;
  const Q96 = 2n ** 96n;
  // USDG has 6 decimals; the probe is spent, so it is always the input.
  const amountIn = BigInt(PROBE_USD) * 10n ** 6n;
  const net = amountIn - (amountIn * BigInt(feePips)) / 1_000_000n;
  const price = Number(sqrtPriceX96) ** 2 / Number(Q96) ** 2;

  let out;
  if (usdgIsCurrency0) {
    const denominator = liquidity * Q96 + net * sqrtPriceX96;
    if (denominator === 0n) return null;
    const next = (liquidity * Q96 * sqrtPriceX96 + denominator - 1n) / denominator;
    if (next >= sqrtPriceX96) return null;
    out = (liquidity * (sqrtPriceX96 - next)) / Q96;
  } else {
    const next = sqrtPriceX96 + (net * Q96) / liquidity;
    const numerator = liquidity * Q96 * (next - sqrtPriceX96);
    const denominator = next * sqrtPriceX96;
    if (denominator === 0n) return null;
    out = numerator / denominator;
  }
  if (out <= 0n) return null;

  // Stock tokens are 18-decimal; USDG is 6. The mid price follows the sort order.
  const stockPerUsdg = usdgIsCurrency0 ? price / 1e12 : 1 / (price * 1e12);
  const fair = PROBE_USD * stockPerUsdg;
  if (!Number.isFinite(fair) || fair <= 0) return null;
  return (1 - Number(out) / 1e18 / fair) * 10_000;
}

async function poolLiquidity(id) {
  const base = BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [id, 6n])));
  const [slot0, liquidity] = await Promise.all([extsload(POOL_MANAGER, base), extsload(POOL_MANAGER, base + 3n)]);
  return { sqrtPriceX96: slot0 & ((1n << 160n) - 1n), liquidity };
}

// ── 1. candidates ────────────────────────────────────────────────────────────

console.log(`reading ${TOKEN_LIST} …`);
const list = await fetch(TOKEN_LIST).then((r) => r.json());
const candidates = list.tokens.filter((t) => t.chainId === CHAIN_ID).slice(0, LIMIT);
console.log(`  ${list.name} v${Object.values(list.version).join(".")} — ${candidates.length} tokens on chain ${CHAIN_ID}\n`);

// ── 2. identity, then 3. pools ───────────────────────────────────────────────

const accepted = [];
const rejected = [];
let done = 0;

for (const token of candidates) {
  done += 1;
  const label = `[${String(done).padStart(3)}/${candidates.length}] ${token.symbol.padEnd(8)}`;

  // IDENTITY FIRST, so a non-stock token costs one call rather than a log scan.
  let registry = null;
  try {
    const raw = await client.request({
      method: "eth_call",
      params: [{ to: token.address, data: REGISTRY_GETTER }, "latest"],
    });
    registry = `0x${raw.slice(-40)}`;
  } catch {
    /* answered nothing: not a stock proxy */
  }
  if (registry === null || registry.toLowerCase() !== STOCK_REGISTRY.toLowerCase()) {
    rejected.push({ ...token, why: "does not point at the stock registry — not a Robinhood Stock Token" });
    console.log(`${label} rejected: not a stock token`);
    continue;
  }

  const proof = await client.request({ method: "eth_getProof", params: [token.address, [], "latest"] });
  if (proof.codeHash.toLowerCase() !== STOCK_CODEHASH.toLowerCase()) {
    rejected.push({ ...token, why: `codehash ${proof.codeHash} is not the shared stock-proxy hash` });
    console.log(`${label} rejected: wrong codehash`);
    continue;
  }

  // POOLS. Filtered on both currencies as indexed topics, so the node returns
  // only this pair — the alternative is one enormous scan the RPC caps at 10,000
  // logs and silently truncates.
  const [c0, c1] = BigInt(USDG) < BigInt(token.address) ? [USDG, token.address] : [token.address, USDG];
  let logs;
  try {
    logs = await client.request({
      method: "eth_getLogs",
      params: [{ address: POOL_MANAGER, topics: [INITIALIZE_TOPIC, null, pad(c0), pad(c1)], fromBlock: "0x0", toBlock: "latest" }],
    });
  } catch (error) {
    rejected.push({ ...token, why: `pool scan failed: ${error.shortMessage ?? error.message}` });
    console.log(`${label} rejected: pool scan failed`);
    continue;
  }

  const seen = new Map();
  for (const log of logs) {
    const d = log.data.slice(2);
    const fee = Number(BigInt(`0x${d.slice(0, 64)}`));
    const tickSpacing = Number(BigInt.asIntN(24, BigInt(`0x${d.slice(64, 128)}`)));
    const hooks = `0x${d.slice(128 + 24, 192)}`;
    // HOOKLESS ONLY. The adapter's PoolKey fixes hooks at the zero address, so a
    // hooked pool is a different id it cannot reach — quoting one would describe
    // a trade that cannot happen.
    if (BigInt(hooks) !== 0n) continue;
    seen.set(`${fee}:${tickSpacing}`, { fee, tickSpacing });
  }

  const measured = [];
  for (const { fee, tickSpacing } of seen.values()) {
    const id = poolId(c0, c1, fee, tickSpacing);
    const { sqrtPriceX96, liquidity } = await poolLiquidity(id);
    if (sqrtPriceX96 === 0n) continue; // never initialised
    measured.push({
      fee,
      tickSpacing,
      liquidity: liquidity.toString(),
      liquidityBig: liquidity,
      costBps: probeCostBps(sqrtPriceX96, liquidity, fee, c0.toLowerCase() === USDG.toLowerCase()),
    });
  }

  const viable = measured
    .filter((p) => p.fee <= MAX_PLAUSIBLE_FEE && p.costBps !== null && p.costBps <= MAX_PROBE_COST_BPS)
    .sort((a, b) => a.costBps - b.costBps);

  if (viable.length === 0) {
    const traps = measured.filter((p) => p.fee > MAX_PLAUSIBLE_FEE).length;
    const shallow = measured.filter((p) => p.fee <= MAX_PLAUSIBLE_FEE && (p.costBps === null || p.costBps > MAX_PROBE_COST_BPS)).length;
    rejected.push({
      ...token,
      why:
        `no hookless pool that can fill $${PROBE_USD} under ${MAX_PROBE_COST_BPS} bps. ` +
        `${measured.length} initialised pool(s): ${traps} with a confiscatory fee, ${shallow} too shallow`,
      pools: measured.map(({ liquidityBig, ...rest }) => rest),
    });
    console.log(`${label} rejected: no viable pool (${measured.length} found, ${traps} confiscatory, ${shallow} too shallow)`);
    continue;
  }

  const best = viable[0];
  accepted.push({
    symbol: token.symbol,
    name: token.name,
    address: token.address,
    fee: best.fee,
    tickSpacing: best.tickSpacing,
    liquidity: best.liquidity,
    costBps: Number(best.costBps.toFixed(2)),
    // EVERY ALTERNATIVE IS RECORDED, not just the winner. "Why this pool and not
    // that one" is the question anyone reviewing an immutable deployment will
    // ask, and it cannot be answered from a single number.
    alternatives: viable.slice(1, 6).map(({ liquidityBig, ...rest }) => ({
      ...rest,
      costBps: Number(rest.costBps.toFixed(2)),
    })),
    rejectedPools: measured
      .filter((p) => p.fee > MAX_PLAUSIBLE_FEE || p.costBps === null || p.costBps > MAX_PROBE_COST_BPS)
      .map(({ liquidityBig, ...rest }) => ({
        ...rest,
        costBps: rest.costBps === null ? null : Number(rest.costBps.toFixed(2)),
        why: rest.fee > MAX_PLAUSIBLE_FEE ? "confiscatory fee" : "too shallow to fill the probe",
      })),
  });
  console.log(
    `${label} ok  fee=${String(best.fee).padStart(6)} ts=${String(best.tickSpacing).padStart(5)} ` +
      `L=${best.liquidity.padStart(22)}  (${viable.length - 1} other viable, ${measured.length - viable.length} refused)`,
  );
}

// ── the WETH/USDG leg, which every purchase also crosses ─────────────────────

const [w0, w1] = BigInt(WETH) < BigInt(USDG) ? [WETH, USDG] : [USDG, WETH];
const wethLogs = await client.request({
  method: "eth_getLogs",
  params: [{ address: POOL_MANAGER, topics: [INITIALIZE_TOPIC, null, pad(w0), pad(w1)], fromBlock: "0x0", toBlock: "latest" }],
});
const wethSeen = new Map();
for (const log of wethLogs) {
  const d = log.data.slice(2);
  const fee = Number(BigInt(`0x${d.slice(0, 64)}`));
  const tickSpacing = Number(BigInt.asIntN(24, BigInt(`0x${d.slice(64, 128)}`)));
  if (BigInt(`0x${d.slice(128 + 24, 192)}`) !== 0n) continue;
  wethSeen.set(`${fee}:${tickSpacing}`, { fee, tickSpacing });
}
const wethMeasured = [];
for (const { fee, tickSpacing } of wethSeen.values()) {
  const { sqrtPriceX96, liquidity } = await poolLiquidity(poolId(w0, w1, fee, tickSpacing));
  if (sqrtPriceX96 === 0n) continue;
  wethMeasured.push({ fee, tickSpacing, liquidity, liquidityStr: liquidity.toString() });
}
wethMeasured.sort((a, b) => (a.liquidity < b.liquidity ? 1 : -1));
const wethBest = wethMeasured.find((p) => p.fee <= MAX_PLAUSIBLE_FEE);

// ── output ───────────────────────────────────────────────────────────────────

const report = {
  generatedAtBlock: (await client.getBlockNumber()).toString(),
  chainId: CHAIN_ID,
  tokenList: { url: TOKEN_LIST, name: list.name, version: list.version },
  thresholds: { maxPlausibleFeePips: MAX_PLAUSIBLE_FEE, probeUsd: PROBE_USD, maxProbeCostBps: MAX_PROBE_COST_BPS },
  wethUsdg: wethBest
    ? { fee: wethBest.fee, tickSpacing: wethBest.tickSpacing, liquidity: wethBest.liquidityStr }
    : null,
  accepted,
  rejected,
};
writeFileSync(OUT, JSON.stringify(report, null, 2));

console.log(`\n${"─".repeat(78)}`);
console.log(`accepted ${accepted.length}   rejected ${rejected.length}   report: ${OUT}`);
if (wethBest) {
  console.log(`WETH/USDG  fee=${wethBest.fee} tickSpacing=${wethBest.tickSpacing} L=${wethBest.liquidityStr}`);
}
console.log(`\nDeploy configuration — paste into the environment of DeployStockAdapter:\n`);
console.log(`export NUVEM_WETH_USDG_FEE=${wethBest?.fee ?? "?"}`);
console.log(`export NUVEM_WETH_USDG_TICK_SPACING=${wethBest?.tickSpacing ?? "?"}`);
console.log(`export NUVEM_STOCKS=${accepted.map((a) => a.address).join(",")}`);
console.log(`export NUVEM_STOCK_FEES=${accepted.map((a) => a.fee).join(",")}`);
console.log(`export NUVEM_STOCK_TICK_SPACINGS=${accepted.map((a) => a.tickSpacing).join(",")}`);
console.log(`\nAnd for the keeper, which must quote the SAME pools:\n`);
console.log(`export NUVEM_STOCK_POOLS=${accepted.map((a) => `${a.address}:${a.fee}:${a.tickSpacing}`).join(",")}`);
console.log(
  `\nEVERY ADDRESS ABOVE CAME FROM A THIRD-PARTY LIST. The chain confirms each one is a\n` +
    `stock proxy with the right registry and codehash — it does NOT confirm the symbol is\n` +
    `the company it names. A clone passes all of it. Read the list before you deploy.`,
);
