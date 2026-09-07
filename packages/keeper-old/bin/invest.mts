#!/usr/bin/env tsx
// The investment path, end to end, from the command line.
//
//   npx tsx bin/invest.mts status     read-only: what the chain says and what it implies
//   npx tsx bin/invest.mts plan       adds the quote and the exact calldata. Sends nothing.
//   npx tsx bin/invest.mts live       actually buys. Requires the broadcast sentinel.
//
// WHY THREE VERBS RATHER THAN A FLAG. `status` answers "is anything wrong",
// `plan` answers "what exactly would be sent", and only `live` can spend. An
// operator who wants to look cannot accidentally buy, because looking and buying
// are different words rather than the same word with a flag.
//
// `live` ADDITIONALLY REQUIRES NUVEM_I_UNDERSTAND=i-understand-this-moves-real-funds.
// The sentinel is the same one the settlement runner uses, so an operator who has
// armed one has not silently armed the other: it is read fresh here.

import { createPublicClient, http, type Address, type Hex } from "viem";

import { decideInvestment } from "../src/investment.js";
import {
  hasInvestmentPath,
  readAdapterRegistry,
  readAdapterStatus,
  readBasketLegs,
  readInvestmentConfiguration,
  readPoolState,
  poolId,
  type InvestmentChainAccess,
} from "../src/investment-chain.js";
import { orderPair } from "../src/investment-state.js";
import { describePlan, planInvestment, type LegRoute } from "../src/investment-plan.js";
import { describeInvestPlan, submitInvestment, type InvestSigner } from "../src/investment-submit.js";
import { createPrivySigner } from "../src/privy-signer.js";
import { buildPrivyWalletIndex } from "../src/privy-wallets.js";

const BROADCAST_SENTINEL = "i-understand-this-moves-real-funds";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is not set. See docs/runbooks for the full list.`);
  }
  return value;
}

const verb = process.argv[2] ?? "status";
if (!["status", "plan", "live"].includes(verb)) {
  console.error(`unknown verb "${verb}". Use status, plan or live.`);
  process.exit(2);
}

const rpcUrl = required("NUVEM_RPC_URL");
const vault = required("NUVEM_VAULT") as Address;
const poolManager = required("NUVEM_POOL_MANAGER") as Address;
const usdg = required("NUVEM_USDG") as Address;
const weth = required("NUVEM_WETH_ADDRESS") as Address;
const logsFromBlock = BigInt(process.env.NUVEM_LOGS_FROM_BLOCK ?? "0");
/**
 * Who would send the purchase. The vault admin, or any ACTIVE trading account —
 * the keeper already holds one of the latter, which is why automating this needs
 * no new key. There is no default: estimating from the wrong address reverts
 * `Unauthorized()` and blames the plan.
 */
const sender = required("NUVEM_KEEPER_ACCOUNT") as Address;

/**
 * The pool parameters per stock, as pinned in the deployed adapter.
 *
 * READ FROM THE ENVIRONMENT RATHER THAN GUESSED, because "which pool" is the
 * single decision that separates a 0.30% fill from a 95% one — mainnet carries
 * hookless NVDA/USDG pools at 85%, 90% and 99.9% with real liquidity. The keeper
 * must quote the SAME pool the adapter will trade in, or its floor describes a
 * trade that will not happen.
 */
/**
 * PER STOCK, not one pair of numbers for the whole basket.
 *
 * The adapter pins `fee` and `tickSpacing` PER TARGET ASSET. Applying one scalar
 * to every leg quotes at least one leg of any mixed basket against a pool the
 * adapter will never trade in — and the floor then describes a trade that will
 * not happen, which is worse than no floor because it looks like one.
 *
 * Format: NUVEM_STOCK_POOLS="0xNVDA:3000:60,0xSPY:500:10"
 */
const stockPools = new Map<string, { fee: number; tickSpacing: number }>();
for (const entry of (process.env.NUVEM_STOCK_POOLS ?? "").split(",").filter((e) => e.trim() !== "")) {
  const [asset, fee, tickSpacing] = entry.split(":");
  if (asset === undefined || fee === undefined || tickSpacing === undefined) {
    throw new Error(`NUVEM_STOCK_POOLS entry "${entry}" is not <asset>:<fee>:<tickSpacing>`);
  }
  stockPools.set(asset.toLowerCase(), { fee: Number(fee), tickSpacing: Number(tickSpacing) });
}
const wethUsdgFee = Number(process.env.NUVEM_WETH_USDG_FEE ?? "500");
const wethUsdgTickSpacing = Number(process.env.NUVEM_WETH_USDG_TICK_SPACING ?? "10");

const client = createPublicClient({ transport: http(rpcUrl) });
const chain: InvestmentChainAccess = {
  call: async (to, data) => (await client.request({ method: "eth_call", params: [{ to, data }, "latest"] })) as Hex,
  getLogs: async (filter) =>
    (await client.request({
      method: "eth_getLogs",
      params: [
        {
          address: filter.address,
          topics: filter.topics,
          fromBlock: `0x${filter.fromBlock.toString(16)}`,
          toBlock: filter.toBlock === "latest" ? "latest" : `0x${filter.toBlock.toString(16)}`,
        },
      ],
    } as never)) as readonly { data: Hex; topics: Hex[] }[],
  getBlockNumber: () => client.getBlockNumber(),
};

const out = (label: string, value: unknown): void => console.log(`  ${label.padEnd(26)} ${String(value)}`);

console.log(`\nnuvem invest · ${verb} · vault ${vault}\n`);

// ── what the chain says ──────────────────────────────────────────────────────

if (!(await hasInvestmentPath(chain, vault))) {
  console.log("  This vault runs an implementation WITHOUT the investment path.");
  console.log("  `extsload` does not exist on it, so no investment state can be read —");
  console.log("  and `invest()` does not exist either. Nothing is wrong with the RPC.");
  console.log("");
  console.log("  Every vault on mainnet is in this state until the cohort beacon is");
  console.log("  upgraded. See reports/ for the governance sequence.");
  process.exit(0);
}

const config = await readInvestmentConfiguration(chain, vault);
const registry = await readAdapterRegistry(chain, vault);
const wethBalance = (await client.readContract({
  address: weth,
  abi: [
    {
      type: "function",
      name: "balanceOf",
      stateMutability: "view",
      inputs: [{ name: "a", type: "address" }],
      outputs: [{ type: "uint256" }],
    },
  ],
  functionName: "balanceOf",
  args: [vault],
})) as bigint;

out("adapterRegistry", registry);
out("investmentEnabled", config.enabled);
out("investmentPaused", config.paused);
out("policyNonce", config.policyNonce);
out("adapterId", config.adapterId);
out("basketHash", config.basketHash);
out("minInvestmentWei", config.minInvestmentWei);
out("maxPerCallWei", config.maxPerCallWei);
out("maxRolling30dWei", config.maxRolling30dWei);
out("vault WETH balance", wethBalance);

const adapter =
  registry === "0x0000000000000000000000000000000000000000"
    ? { adapter: registry, statusEpoch: 0n, active: false }
    : await readAdapterStatus(chain, registry, config.adapterId);
out("adapter", adapter.adapter);
out("adapter active", adapter.active);
out("adapterStatusEpoch", adapter.statusEpoch);

const recovery = await readBasketLegs(chain, vault, config.basketHash, logsFromBlock);
out("basket legs recovered", recovery.kind === "LEGS" ? recovery.legs.length : `NOT_FOUND — ${recovery.detail}`);

// ── should it buy ────────────────────────────────────────────────────────────

const decision = decideInvestment({
  wethBalance,
  enabled: config.enabled,
  paused: config.paused,
  basketHash: config.basketHash,
  adapterId: config.adapterId,
  minInvestmentWei: config.minInvestmentWei,
  maxPerCallWei: config.maxPerCallWei,
  // The rolling cap needs its own read; until then the ceiling is the honest bound.
  capRemaining: config.maxRolling30dWei,
  adapterActive: adapter.active,
  knownBasketLegs: recovery.kind === "LEGS" ? recovery.legs.length : 0,
});

console.log(`\ndecision: ${decision.kind}`);
if (decision.kind !== "INVEST") {
  console.log(`  ${JSON.stringify(decision)}`);
  process.exit(0);
}
if (recovery.kind !== "LEGS") process.exit(1);
out("amountIn", decision.amountIn);

if (verb === "status") process.exit(0);

// ── what exactly would be sent ───────────────────────────────────────────────

const pools = new Map<string, LegRoute>();
const wu = orderPair(weth, usdg);
const wethToUsdg = await readPoolState(
  chain,
  poolManager,
  poolId(wu.currency0, wu.currency1, wethUsdgFee, wethUsdgTickSpacing),
  wu.currency0.toLowerCase() === weth.toLowerCase(),
);
for (const leg of recovery.legs) {
  const pinned = stockPools.get(leg.targetAsset.toLowerCase());
  if (pinned === undefined) {
    console.error(
      `\nNUVEM_STOCK_POOLS has no entry for ${leg.targetAsset}, which is in the vault's basket.\n` +
        "Refusing rather than guessing: mainnet carries hookless pools for this pair at 85%, 90%\n" +
        "and 99.9% fees with real liquidity, so a wrong pool is not a rounding error.",
    );
    process.exit(1);
  }
  const us = orderPair(usdg, leg.targetAsset);
  pools.set(leg.targetAsset.toLowerCase(), {
    kind: "STOCK" as const,
    wethToUsdg,
    usdgToStock: await readPoolState(
      chain,
      poolManager,
      poolId(us.currency0, us.currency1, pinned.fee, pinned.tickSpacing),
      us.currency0.toLowerCase() === usdg.toLowerCase(),
    ),
  });
}

const planned = planInvestment({
  legs: recovery.legs,
  amountIn: decision.amountIn,
  pools,
  expectedBasketHash: config.basketHash,
  policyNonce: config.policyNonce,
  adapterStatusEpoch: adapter.statusEpoch,
  // 90 SECONDS, NOT 600. Measured against this route's own swap history, the
  // worst adverse move over 600s is 61.5 bps — wider than the 50 bps tolerance,
  // so a transaction sitting that long could land outside its own floor and
  // revert after paying gas. Over 90s the worst case is inside the budget.
  deadline: Math.floor(Date.now() / 1000) + 90,
});

if (planned.kind === "REFUSED") {
  console.log(`\nREFUSED: ${planned.reason}`);
  process.exit(1);
}
console.log(`\n${describePlan(planned.call)}`);

// ── send, only when every word says to ───────────────────────────────────────

const live = verb === "live";
if (live && process.env.NUVEM_I_UNDERSTAND !== BROADCAST_SENTINEL) {
  console.error(`\nlive requires NUVEM_I_UNDERSTAND=${BROADCAST_SENTINEL}`);
  process.exit(3);
}

/**
 * The signer, built only when the verb is `live`.
 *
 * NOT BUILT IN DRY RUNS AT ALL. Constructing it reads the Privy app secret and
 * the authorization key out of the environment, and a `plan` that will never sign
 * anything has no business touching either.
 *
 * THE WALLET ID IS LOOKED UP FROM THE ADDRESS, NOT SUPPLIED ALONGSIDE IT.
 * Privy identifies a wallet by id while every other part of this system speaks
 * addresses, so taking both invites them to disagree — and a wrong id yields a
 * perfectly working signer for a DIFFERENT account: the estimate passes for the
 * authorised sender, the signature comes from an account the vault refuses, and
 * the gas is spent on a guaranteed revert.
 *
 * The first version of this function took both and then "checked" them by
 * comparing `signer.address` to `sender` — which is vacuous, because
 * `createPrivySigner` returns whatever address it was handed. Deriving the id
 * makes the mismatch unrepresentable instead of unchecked.
 */
async function buildSigner(): Promise<InvestSigner> {
  const index = await buildPrivyWalletIndex({
    appId: required("PRIVY_APP_ID"),
    appSecret: required("PRIVY_APP_SECRET"),
    signerId: process.env.PRIVY_SIGNER_ID,
  });
  const wallet = index.get(sender.toLowerCase());
  if (wallet === undefined) {
    throw new Error(
      `Privy has no wallet for ${sender}. Nothing was sent. The keeper can only sign for wallets ` +
        "this app manages, so either the address is wrong or the wallet belongs to another app.",
    );
  }
  if (!wallet.signable) {
    throw new Error(
      `Privy wallet ${wallet.walletId} (${wallet.address}) does not carry this app's signer on its ` +
        "additional signers, so a signature would be refused. Nothing was sent.",
    );
  }
  return createPrivySigner({
    appId: required("PRIVY_APP_ID"),
    appSecret: required("PRIVY_APP_SECRET"),
    authorizationKey: required("PRIVY_AUTHORIZATION_KEY"),
    walletId: wallet.walletId,
    address: wallet.address,
  });
}

const signer = live ? await buildSigner() : null;

const result = await submitInvestment({
  live,
  chain: {
    estimateGas: (args) => client.estimateGas({ account: args.from, to: args.to, data: args.data }),
    getFeeQuote: async () => {
      const fees = await client.estimateFeesPerGas();
      return {
        maxFeePerGas: fees.maxFeePerGas ?? 1_000_000_000n,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? 0n,
      };
    },
    getPendingTransactionCount: (address) => client.getTransactionCount({ address, blockTag: "pending" }),
    sendRawTransaction: (raw) => client.sendRawTransaction({ serializedTransaction: raw }),
    waitForReceipt: async (hash, timeoutMs) => {
      try {
        const receipt = await client.waitForTransactionReceipt({ hash, timeout: timeoutMs });
        return { status: receipt.status, gasUsed: receipt.gasUsed };
      } catch {
        return null;
      }
    },
  },
  vault,
  chainId: await client.getChainId(),
  call: planned.call,
  from: sender,
  signer,
});

console.log(`\nresult: ${result.kind}`);
if (result.kind === "DRY_RUN") console.log(JSON.stringify(describeInvestPlan(result.plan), null, 2));
if (result.kind === "BLOCKED") console.log(`  ${result.reason}: ${result.detail}`);
if (result.kind === "CONFIRMED") console.log(`  tx ${result.txHash}  gas ${result.gasUsed}`);
if (result.kind === "FAILED") console.log(`  reverted: ${result.txHash}`);
if (result.kind === "UNRESOLVED") console.log(`  sent, no receipt: ${result.txHash}`);
