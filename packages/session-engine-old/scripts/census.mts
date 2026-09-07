// Measures what fraction of a wallet's real trading is settleable.
//
//   MAINNET_RPC=... npx tsx scripts/census.mts --wallet 0x.. [--max-verify 40] [--max-span 20000]
//
// TWO DIFFERENT SCANS, ON PURPOSE.
//
// Detection uses a SPARSE source: alchemy_getAssetTransfers finds the blocks
// where value moved, and only those blocks are fetched. That is sound for
// detection because only TRADE_BUY and TRADE_SELL move the state machine, and
// both move value. Gas-only transactions such as `approve` are invisible to this
// source, and they are irrelevant to a boundary.
//
// Verification uses the full four-source scan via buildSessionReport, which is
// dense over the session's own span and therefore DOES see the approves. That
// matters because they cost real gas and would otherwise break reconciliation.
//
// So: a boundary found cheaply, then checked expensively. Never the reverse.

import { classifyWindow, type ClassifiedTx } from "../src/classify.js";
import { detectSessions, openSessionStatus } from "../src/detector.js";
import { httpRpcClient, type RpcClient } from "../src/rpc.js";
import { buildSessionReport } from "../src/session.js";
import { TRANSFER_TOPIC, hexToBigInt, normalize, topicAddress } from "../src/chain.js";
import type { NativeMove, RawTx, TokenMove } from "../src/window.js";

const argv = process.argv.slice(2);
const flag = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const url = process.env.MAINNET_RPC;
const walletArg = flag("wallet");
if (!url || !walletArg) {
  console.error("Usage: MAINNET_RPC=... npx tsx scripts/census.mts --wallet 0x.. [--max-verify N] [--max-span N]");
  process.exit(2);
}
const wallet = normalize(walletArg);
const maxVerify = Number(flag("max-verify") ?? 40);
// Restricts the census to one era. A wallet's ancient pre-GMGN history contains
// shapes the classifier rightly refuses (token-for-token swaps, contract claims),
// and averaging those together with current trading answers a question nobody
// asked. Default 0 means the whole life.
const fromBlock = BigInt(flag("from") ?? 0);
const maxSpan = BigInt(flag("max-span") ?? 20_000);
const rpc = httpRpcClient(url, { attempts: 6 });

interface Transfer {
  hash: string;
  blockNum: string;
}

/** Every block where value moved for this wallet, in either direction. */
async function activityHashes(client: RpcClient): Promise<Map<string, bigint>> {
  const found = new Map<string, bigint>();
  for (const key of ["fromAddress", "toAddress"]) {
    let pageKey: string | undefined;
    do {
      const page = await client.call<{ transfers: Transfer[]; pageKey?: string }>(
        "alchemy_getAssetTransfers",
        [{ [key]: wallet, category: ["external", "erc20"], order: "asc", maxCount: "0x3e8", ...(pageKey ? { pageKey } : {}) }],
      );
      for (const t of page.transfers ?? []) {
        const block = hexToBigInt(t.blockNum);
        if (block >= fromBlock) found.set(t.hash, block);
      }
      pageKey = page.pageKey;
    } while (pageKey);
  }
  return found;
}

interface RpcReceipt {
  from: string;
  status: string;
  gasUsed: string;
  effectiveGasPrice?: string;
  logs: { address: string; topics: string[]; data: string }[];
}
interface TraceFrame { from?: string; to?: string; value?: string; error?: string; calls?: TraceFrame[] }

function internalMoves(frame: TraceFrame | undefined, out: NativeMove[], depth = 0): void {
  if (!frame || frame.error !== undefined) return;
  const value = frame.value ? hexToBigInt(frame.value) : 0n;
  if (value > 0n && depth > 0) {
    const from = normalize(frame.from ?? "");
    const to = normalize(frame.to ?? "");
    if (from === wallet || to === wallet) out.push({ from, to, value, internal: true });
  }
  for (const child of frame.calls ?? []) internalMoves(child, out, depth + 1);
}

async function buildRawTx(client: RpcClient, hash: string, blockNumber: bigint): Promise<RawTx> {
  const [tx, receipt] = await Promise.all([
    client.call<{ from: string; to: string | null; value: string; input: string }>("eth_getTransactionByHash", [hash]),
    client.call<RpcReceipt>("eth_getTransactionReceipt", [hash]),
  ]);
  const sender = normalize(receipt.from);
  const success = receipt.status === "0x1";

  const nativeMoves: NativeMove[] = [];
  const topLevel = hexToBigInt(tx.value);
  if (success && topLevel > 0n) {
    const from = normalize(tx.from);
    const to = tx.to ? normalize(tx.to) : "";
    if (from === wallet || to === wallet) nativeMoves.push({ from, to, value: topLevel, internal: false });
  }
  if (success) {
    const trace = await client.call<TraceFrame>("debug_traceTransaction", [hash, { tracer: "callTracer" }]);
    internalMoves(trace, nativeMoves);
  }

  const tokenMoves: TokenMove[] = [];
  for (const log of receipt.logs) {
    if (log.topics[0] !== TRANSFER_TOPIC || log.topics.length !== 3) continue;
    const from = topicAddress(log.topics[1]!);
    const to = topicAddress(log.topics[2]!);
    if (from !== wallet && to !== wallet) continue;
    tokenMoves.push({ token: normalize(log.address), from, to, value: hexToBigInt(log.data) });
  }

  return {
    hash,
    blockNumber,
    sender,
    to: tx.to ? normalize(tx.to) : null,
    input: tx.input,
    success,
    gasPaid: sender === wallet ? hexToBigInt(receipt.gasUsed) * hexToBigInt(receipt.effectiveGasPrice ?? "0x0") : 0n,
    nativeMoves,
    tokenMoves,
  };
}

// ---------------------------------------------------------------------------

process.stderr.write("discovering activity ... ");
const activity = await activityHashes(rpc);
process.stderr.write(`${activity.size} transactions\n`);

const raw: RawTx[] = [];
let done = 0;
for (const [hash, block] of activity) {
  raw.push(await buildRawTx(rpc, hash, block));
  if (++done % 100 === 0) process.stderr.write(`  enriched ${done}/${activity.size}\n`);
}
raw.sort((a, b) => (a.blockNumber === b.blockNumber ? 0 : a.blockNumber < b.blockNumber ? -1 : 1));

const classified: ClassifiedTx[] = classifyWindow(raw, wallet);
const sessions = detectSessions(classified);
const open = openSessionStatus(classified);

const kinds: Record<string, number> = {};
for (const tx of classified) kinds[tx.kind] = (kinds[tx.kind] ?? 0) + 1;

// Verify a bounded sample: the dense scan is O(span), and a handful of sessions
// span millions of blocks. Report what was skipped rather than hiding it.
const verifiable = sessions.filter((s) => s.spanBlocks <= maxSpan);
const tooWide = sessions.length - verifiable.length;
const sample = verifiable.slice(-maxVerify); // most recent, closest to current behaviour

let attestable = 0;
let refused = 0;
let errored = 0;
// Settleable is not the same as productive: the executor contributes nothing for
// a non-positive result, so a session can be perfectly attestable and still
// generate no savings. Tracked separately because conflating them would
// overstate what the product actually collects.
let profitable = 0;
const perSession: { window: string; verdict: string; profitWei: string }[] = [];
let profitAttestable = 0n;
let profitRefused = 0n;
const reasonCounts: Record<string, number> = {};

for (const [i, session] of sample.entries()) {
  process.stderr.write(`  verifying ${i + 1}/${sample.length} (${session.startBlockL2}..${session.endBlockL2}) `);
  try {
    const report = await buildSessionReport({
      rpc,
      wallet,
      startBlockL2: session.startBlockL2,
      endBlockL2: session.endBlockL2,
      replayStartBlockL2: session.startBlockL2,
    });
    perSession.push({
      window: `(${session.startBlockL2}, ${session.endBlockL2}]`,
      verdict: report.verdict,
      profitWei: report.realizedProfit.toString(),
    });
    if (report.verdict === "ATTESTABLE") {
      attestable++;
      if (report.realizedProfit > 0n) profitable++;
      profitAttestable += report.realizedProfit;
    } else {
      refused++;
      profitRefused += report.realizedProfit;
      for (const reason of report.reasons) reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
    }
    process.stderr.write(`${report.verdict}\n`);
  } catch (error) {
    errored++;
    process.stderr.write(`ERROR ${error instanceof Error ? error.message.slice(0, 60) : ""}\n`);
  }
}

const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`);

console.log(
  JSON.stringify(
    {
      wallet,
      transactions: classified.length,
      kinds,
      sessionsDetected: sessions.length,
      sessionsTooWideToVerify: tooWide,
      verified: sample.length,
      attestable,
      refused,
      errored,
      settleableFraction: pct(attestable, sample.length),
      profitableSessions: profitable,
      profitableFractionOfAttestable: pct(profitable, attestable),
      perSession,
      refusalReasons: reasonCounts,
      profitAttestableWei: profitAttestable.toString(),
      profitRefusedWei: profitRefused.toString(),
      currentState: open.state,
      openPositions: open.openTokens.length,
      sessionSpanBlocks: {
        min: sessions.length ? sessions.reduce((m, s) => (s.spanBlocks < m ? s.spanBlocks : m), sessions[0]!.spanBlocks).toString() : "0",
        max: sessions.length ? sessions.reduce((m, s) => (s.spanBlocks > m ? s.spanBlocks : m), 0n).toString() : "0",
      },
    },
    null,
    2,
  ),
);
