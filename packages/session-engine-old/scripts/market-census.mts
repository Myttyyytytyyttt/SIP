// Profiles every wallet trading through a router, to size the addressable
// market: how many settleable session boundaries exist per purchase made.
//
//   MAINNET_RPC=... npx tsx scripts/market-census.mts [--blocks 400] [--from <l2>]
//
// DELIBERATELY CHEAP, AND HONEST ABOUT WHAT THAT COSTS.
//
// The full census (scripts/census.mts) needs three RPC calls per transaction —
// receipts for the true sender, traces for sell proceeds. At ~1,000
// transactions per wallet that is hours for a cohort this size.
//
// This uses two paginated calls per wallet, classifies by JOINING transfer
// records on transaction hash (an inbound token whose hash also carries native
// cash leaving the wallet was bought; one without arrived unsolicited), and then
// feeds those pseudo-transactions to the REAL detectSessions. So the metric is
// sessions-per-buy, directly comparable to the full census.
//
// An earlier version counted "fraction of distinct tokens that eventually sold"
// instead. That measure is worthless and it is worth recording why: it scored
// the heaviest accumulator in the cohort at 1.000 against a true 0.009. The
// wallet does close every position eventually — but it holds nine at once and
// re-buys constantly, so the portfolio never goes flat and there is no boundary
// to settle on. What gates settleability is CONCURRENCY, not eventual disposal.
//
// What this still cannot do: compute PnL, or see sell proceeds delivered by
// internal call. It counts boundaries, not earnings.

import { hexToBigInt, normalize } from "../src/chain.js";
import type { ClassifiedTx } from "../src/classify.js";
import { detectSessions, openSessionStatus } from "../src/detector.js";
import { httpRpcClient, type RpcClient } from "../src/rpc.js";

const argv = process.argv.slice(2);
const flag = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const url = process.env.MAINNET_RPC;
if (!url) {
  console.error("MAINNET_RPC is required.");
  process.exit(2);
}
const rpc = httpRpcClient(url, { attempts: 6 });
const GMGN_ROUTER = "0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc";
const scanBlocks = BigInt(flag("blocks") ?? 400);
const eraFrom = BigInt(flag("from") ?? 21_700_000);

interface Transfer {
  hash: string;
  blockNum: string;
  category: string;
  rawContract?: { address?: string; value?: string };
  value?: number;
}

async function pagedTransfers(client: RpcClient, wallet: string, key: string): Promise<Transfer[]> {
  const out: Transfer[] = [];
  let pageKey: string | undefined;
  do {
    const page = await client.call<{ transfers: Transfer[]; pageKey?: string }>("alchemy_getAssetTransfers", [
      {
        [key]: wallet,
        category: ["external", "erc20"],
        fromBlock: `0x${eraFrom.toString(16)}`,
        order: "asc",
        maxCount: "0x3e8",
        ...(pageKey ? { pageKey } : {}),
      },
    ]);
    out.push(...(page.transfers ?? []));
    pageKey = page.pageKey;
  } while (pageKey);
  return out;
}

interface Profile {
  wallet: string;
  buys: number;
  sells: number;
  distinctTokens: number;
  sessions: number;
  sessionsPerBuy: number;
  peakConcurrent: number;
  openNow: number;
  airdrops: number;
  profile: "round-tripper" | "mixed" | "accumulator";
}

async function profileWallet(client: RpcClient, wallet: string): Promise<Profile> {
  const [outbound, inbound] = await Promise.all([
    pagedTransfers(client, wallet, "fromAddress"),
    pagedTransfers(client, wallet, "toAddress"),
  ]);

  const cashOutHashes = new Set(
    outbound.filter((t) => t.category === "external" && (t.value ?? 0) > 0).map((t) => t.hash),
  );
  const amount = (t: Transfer) => hexToBigInt(t.rawContract?.value ?? "0x0");

  // Collapse transfers into one pseudo-transaction per hash: the unit the
  // detector reasons about is the transaction, not the transfer.
  const byHash = new Map<string, { block: bigint; deltas: Map<string, bigint>; cashOut: boolean }>();
  const touch = (hash: string, blockNum: string) => {
    const existing = byHash.get(hash);
    if (existing) return existing;
    const created = {
      block: hexToBigInt(blockNum),
      deltas: new Map<string, bigint>(),
      cashOut: cashOutHashes.has(hash),
    };
    byHash.set(hash, created);
    return created;
  };

  let airdrops = 0;
  const tokens = new Set<string>();
  for (const t of inbound) {
    if (t.category !== "erc20" || !t.rawContract?.address) continue;
    const token = normalize(t.rawContract.address);
    tokens.add(token);
    const entry = touch(t.hash, t.blockNum);
    entry.deltas.set(token, (entry.deltas.get(token) ?? 0n) + amount(t));
    if (!entry.cashOut) airdrops++;
  }
  for (const t of outbound) {
    if (t.category !== "erc20" || !t.rawContract?.address) continue;
    const token = normalize(t.rawContract.address);
    tokens.add(token);
    const entry = touch(t.hash, t.blockNum);
    entry.deltas.set(token, (entry.deltas.get(token) ?? 0n) - amount(t));
  }

  let buys = 0;
  let sells = 0;
  const classified: ClassifiedTx[] = [];
  for (const [hash, entry] of byHash) {
    const deltas = [...entry.deltas.entries()]
      .filter(([, delta]) => delta !== 0n)
      .map(([token, delta]) => ({ token, delta }));
    if (deltas.length === 0) continue;
    const gained = deltas.some((d) => d.delta > 0n);
    const lost = deltas.some((d) => d.delta < 0n);

    // Same shape rules as classify.ts, minus the receipt-level sender check.
    let kind: ClassifiedTx["kind"];
    if (gained && lost) {
      kind = "UNKNOWN";
    } else if (gained && entry.cashOut) {
      kind = "TRADE_BUY";
      buys++;
    } else if (gained) {
      kind = "AIRDROP_IN";
    } else {
      kind = "TRADE_SELL";
      sells++;
    }

    classified.push({
      hash,
      blockNumber: entry.block,
      kind,
      cashIn: kind === "TRADE_SELL" ? 1n : 0n,
      cashOut: entry.cashOut ? 1n : 0n,
      gasPaid: 0n,
      tokenDeltas: deltas,
      selfSent: kind !== "AIRDROP_IN",
      note: "",
    });
  }

  const sessions = detectSessions(classified);
  const open = openSessionStatus(classified);
  const sessionsPerBuy = buys === 0 ? 0 : sessions.length / buys;

  return {
    wallet,
    buys,
    sells,
    distinctTokens: tokens.size,
    sessions: sessions.length,
    sessionsPerBuy,
    peakConcurrent: sessions.reduce((m, s) => Math.max(m, s.peakConcurrentPositions), 0),
    openNow: open.openTokens.length,
    airdrops,
    profile: sessionsPerBuy >= 0.5 ? "round-tripper" : sessionsPerBuy >= 0.1 ? "mixed" : "accumulator",
  };
}

// ---------------------------------------------------------------------------

const senders = new Map<string, number>();

// An explicit list exists so the cheap proxy can be checked against wallets
// already measured by the full census. A proxy nobody validated is a guess.
const explicit = flag("wallets");
if (explicit) {
  for (const wallet of explicit.split(",")) senders.set(normalize(wallet.trim()), 0);
  process.stderr.write(`profiling ${senders.size} supplied wallet(s)\n`);
} else {
  process.stderr.write("finding wallets that traded through the router ... ");
  const head = hexToBigInt(await rpc.call<string>("eth_blockNumber", []));
  for (let block = head - scanBlocks; block < head; block += 1n) {
    const rpcBlock = await rpc.call<{ transactions: { from: string; to: string | null }[] } | null>(
      "eth_getBlockByNumber",
      [`0x${block.toString(16)}`, true],
    );
    for (const tx of rpcBlock?.transactions ?? []) {
      if (tx.to && normalize(tx.to) === GMGN_ROUTER) {
        const from = normalize(tx.from);
        senders.set(from, (senders.get(from) ?? 0) + 1);
      }
    }
  }
  process.stderr.write(`${senders.size}\n`);
}

const profiles: Profile[] = [];
let index = 0;
for (const wallet of senders.keys()) {
  index++;
  try {
    profiles.push(await profileWallet(rpc, wallet));
  } catch (error) {
    process.stderr.write(`  ${wallet} failed: ${error instanceof Error ? error.message.slice(0, 50) : ""}\n`);
  }
  if (index % 10 === 0) process.stderr.write(`  profiled ${index}/${senders.size}\n`);
}

const bucket = (name: Profile["profile"]) => profiles.filter((p) => p.profile === name);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const median = (xs: number[]) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};
const share = (n: number) => `${((100 * n) / Math.max(profiles.length, 1)).toFixed(1)}%`;

const totalBuys = sum(profiles.map((p) => p.buys));
const totalSessions = sum(profiles.map((p) => p.sessions));

console.log(
  JSON.stringify(
    {
      walletsFound: senders.size,
      walletsProfiled: profiles.length,
      eraFrom: eraFrom.toString(),
      buckets: {
        roundTripper: { count: bucket("round-tripper").length, share: share(bucket("round-tripper").length) },
        mixed: { count: bucket("mixed").length, share: share(bucket("mixed").length) },
        accumulator: { count: bucket("accumulator").length, share: share(bucket("accumulator").length) },
      },
      sessionsPerBuy: {
        median: median(profiles.map((p) => p.sessionsPerBuy)).toFixed(3),
        mean: (sum(profiles.map((p) => p.sessionsPerBuy)) / Math.max(profiles.length, 1)).toFixed(3),
      },
      // The number that sizes the market: across the whole cohort, how many
      // settleable boundaries exist per purchase made.
      totalBuys,
      totalSessions,
      cohortSessionsPerBuy: totalBuys === 0 ? "n/a" : (totalSessions / totalBuys).toFixed(3),
      walletsWithOpenPositions: profiles.filter((p) => p.openNow > 0).length,
      airdropsTotal: sum(profiles.map((p) => p.airdrops)),
      walletsReceivingAirdrops: profiles.filter((p) => p.airdrops > 0).length,
      detail: profiles.sort((a, b) => b.sessionsPerBuy - a.sessionsPerBuy),
    },
    null,
    2,
  ),
);
