// Collects every value movement touching the wallet inside a block window.
//
// Four sources, because no single one is complete on this chain:
//
//   1. block scan       - finds transactions the wallet SENT that move nothing,
//                         notably the `approve` before each GMGN sell. Those emit
//                         no Transfer and cost real gas, so omitting them breaks
//                         reconciliation by exactly the gas.
//   2. eth_getLogs      - ERC-20 Transfer in either direction.
//   3. receipts         - gas actually paid, and the true sender.
//   4. callTracer       - internal native transfers. This is the ONLY source of
//                         sell proceeds: the GMGN router unwraps WETH and forwards
//                         native ETH by internal call, with no log and no
//                         top-level transaction. trace_* and the asset-transfer
//                         "internal" category do not exist on this chain.
//
// Completeness is then checked against the wallet's nonce delta, which is an
// independent fact the four sources cannot influence.

import {
  TRANSFER_TOPIC,
  addressTopic,
  hexToBigInt,
  normalize,
  toBlockTag,
  topicAddress,
  transactionCountAt,
} from "./chain.js";
import { activeRanges } from "./quiet.js";
import type { RpcClient } from "./rpc.js";

export interface NativeMove {
  readonly from: string;
  readonly to: string;
  readonly value: bigint;
  /** True when discovered through the tracer rather than the transaction itself. */
  readonly internal: boolean;
}

export interface TokenMove {
  readonly token: string;
  readonly from: string;
  readonly to: string;
  readonly value: bigint;
}

export interface RawTx {
  readonly hash: string;
  readonly blockNumber: bigint;
  /** receipt.from — who actually paid gas. Not necessarily the wallet. */
  readonly sender: string;
  readonly to: string | null;
  readonly input: string;
  readonly success: boolean;
  /** Gas cost borne by the wallet; zero when the wallet did not send the tx. */
  readonly gasPaid: bigint;
  readonly nativeMoves: readonly NativeMove[];
  readonly tokenMoves: readonly TokenMove[];
}

export interface WindowScan {
  readonly startBlock: bigint;
  readonly endBlock: bigint;
  readonly txs: readonly RawTx[];
  /** Transactions the wallet sent, per its own nonce. The completeness oracle. */
  readonly expectedSentCount: number;
  readonly observedSentCount: number;
}

interface RpcTx {
  hash: string;
  from: string;
  to: string | null;
  value: string;
  input: string;
}

interface RpcReceipt {
  from: string;
  status: string;
  gasUsed: string;
  effectiveGasPrice?: string;
  logs: { address: string; topics: string[]; data: string }[];
}

interface TraceFrame {
  from?: string;
  to?: string;
  value?: string;
  error?: string;
  calls?: TraceFrame[];
}

/** Walks a callTracer tree and yields every frame that actually moved native value. */
function collectInternalMoves(frame: TraceFrame | undefined, wallet: string, out: NativeMove[], depth = 0): void {
  if (!frame) return;
  // A reverted frame moved nothing, and neither did anything beneath it.
  if (frame.error === undefined) {
    const value = frame.value ? hexToBigInt(frame.value) : 0n;
    if (value > 0n && depth > 0) {
      const from = normalize(frame.from ?? "");
      const to = normalize(frame.to ?? "");
      if (from === wallet || to === wallet) {
        out.push({ from, to, value, internal: true });
      }
    }
    for (const child of frame.calls ?? []) collectInternalMoves(child, wallet, out, depth + 1);
  }
}

export async function scanWindow(
  rpc: RpcClient,
  wallet: string,
  startBlock: bigint,
  endBlock: bigint,
): Promise<WindowScan> {
  const account = normalize(wallet);

  // 1 + 2: candidate transaction hashes, from a block scan and from logs.
  //
  // The block scan is narrowed to the sub-ranges that cannot be PROVEN empty.
  // Skipping is safe only because the proof covers every way this account's cash
  // could move (see quiet.ts), and unsafe to get wrong, so anything unproven is
  // scanned. The nonce reconciliation at the end of this function is unchanged
  // and remains the independent check: a range wrongly skipped would show up
  // there as a sent transaction nobody observed, and refuse the settlement.
  const candidates = new Map<string, bigint>();
  const ranges = await activeRanges(rpc, account, startBlock, endBlock);
  for (const range of ranges) {
    for (let block = range.from + 1n; block <= range.to; block += 1n) {
      const rpcBlock = await rpc.call<{ transactions: RpcTx[] } | null>("eth_getBlockByNumber", [
        toBlockTag(block),
        true,
      ]);
      // A NULL BLOCK IS A MISSING ANSWER, NOT AN EMPTY ONE. Providers return
      // null for a block they do not have — a lagging replica, a pruned archive,
      // a node still syncing. Reading that as "no transactions here" silently
      // deletes whatever was in it, and the only downstream witness is the nonce
      // oracle, which sees just the transactions this account SENT. An incoming
      // transfer would slip through as profit.
      //
      // Failing here converts a silent wrong answer into a retry, and then into
      // a refusal. That matters far more with more than one endpoint, where a
      // fallback that is a few blocks behind is an ordinary occurrence.
      if (rpcBlock === null || rpcBlock === undefined) {
        throw new Error(
          `eth_getBlockByNumber returned null for block ${block}. The endpoint does not have ` +
            "this block; treating it as empty would silently drop its transactions.",
        );
      }
      for (const tx of rpcBlock.transactions ?? []) {
        if (normalize(tx.from) === account || (tx.to && normalize(tx.to) === account)) {
          candidates.set(tx.hash, block);
        }
      }
    }
  }

  for (const topics of [
    [TRANSFER_TOPIC, addressTopic(account)],
    [TRANSFER_TOPIC, null, addressTopic(account)],
  ]) {
    const logs = await rpc.call<{ transactionHash: string; blockNumber: string }[]>("eth_getLogs", [
      { fromBlock: toBlockTag(startBlock + 1n), toBlock: toBlockTag(endBlock), topics },
    ]);
    for (const log of logs) candidates.set(log.transactionHash, hexToBigInt(log.blockNumber));
  }

  // 3 + 4: enrich each candidate with its receipt and its internal value flows.
  const txs: RawTx[] = [];
  for (const [hash, blockNumber] of [...candidates.entries()].sort((a, b) =>
    a[1] === b[1] ? a[0].localeCompare(b[0]) : Number(a[1] - b[1]),
  )) {
    const [tx, receipt] = await Promise.all([
      rpc.call<RpcTx>("eth_getTransactionByHash", [hash]),
      rpc.call<RpcReceipt>("eth_getTransactionReceipt", [hash]),
    ]);
    const sender = normalize(receipt.from);
    const success = receipt.status === "0x1";

    const nativeMoves: NativeMove[] = [];
    const topLevelValue = hexToBigInt(tx.value);
    if (success && topLevelValue > 0n) {
      const from = normalize(tx.from);
      const to = tx.to ? normalize(tx.to) : "";
      if (from === account || to === account) {
        nativeMoves.push({ from, to, value: topLevelValue, internal: false });
      }
    }
    if (success) {
      const trace = await rpc.call<TraceFrame>("debug_traceTransaction", [hash, { tracer: "callTracer" }]);
      collectInternalMoves(trace, account, nativeMoves);
    }

    // Failed transactions still burn gas and still count against cash.
    const gasPaid =
      sender === account
        ? hexToBigInt(receipt.gasUsed) * hexToBigInt(receipt.effectiveGasPrice ?? "0x0")
        : 0n;

    const tokenMoves: TokenMove[] = [];
    for (const log of receipt.logs) {
      // ERC-721 and ERC-404 share ERC-20's Transfer topic but carry the tokenId
      // in topics[3] and leave data empty, giving four topics instead of three.
      // They move no fungible balance, so ignoring them is lossless for the cash
      // identity — and decoding one throws, because BigInt("0x") is a
      // SyntaxError. That crash is not hypothetical: it fires on ordinary GMGN
      // buys of tokens that mint an NFT as a side effect, and it aborts the whole
      // scan rather than refusing the window.
      if (log.topics[0] !== TRANSFER_TOPIC || log.topics.length !== 3) continue;
      const from = topicAddress(log.topics[1]!);
      const to = topicAddress(log.topics[2]!);
      if (from !== account && to !== account) continue;
      tokenMoves.push({ token: normalize(log.address), from, to, value: hexToBigInt(log.data) });
    }

    txs.push({
      hash,
      blockNumber,
      sender,
      to: tx.to ? normalize(tx.to) : null,
      input: tx.input,
      success,
      gasPaid,
      nativeMoves,
      tokenMoves,
    });
  }

  const [countStart, countEnd] = await Promise.all([
    transactionCountAt(rpc, account, startBlock),
    transactionCountAt(rpc, account, endBlock),
  ]);

  return {
    startBlock,
    endBlock,
    txs,
    expectedSentCount: countEnd - countStart,
    observedSentCount: txs.filter((tx) => tx.sender === account).length,
  };
}
