// Builds the reconciler's view of one (wallet, block): every transaction that
// touched the wallet, each with its receipt, plus cash at both block boundaries
// and whether the wallet has code. Owner: reconcile.
//
// Ported from the session engine of the project this was forked from (src/window.ts (block scan joined with)
// Transfer logs, receipt decoding, the 3-topic filter) and chain.ts (cashAt and
// the topic helpers). The old scanner walked a whole window and needed a tracer
// to see sell proceeds; this one looks at ONE block and lets the balance delta
// stand in for the tracer, which is why both boundaries are read here.
//
// Two sources for the transaction list, because neither is complete alone:
//
//   1. the block itself  - transactions the wallet SENT or was sent. This is the
//                          only place the log-less `approve` before every GMGN
//                          sell shows up. It emits no Transfer and costs real gas,
//                          and omitting it breaks reconciliation by exactly that gas.
//   2. Transfer logs     - transactions someone ELSE sent that moved a token to or
//                          from the wallet: airdrops, relayed sells. Neither `from`
//                          nor `to` names the wallet, so the block scan cannot see them.
//
// Balances are post-state at a block tag, so the block's own effect is
// balance(N) - balance(N-1). `eth_getBalance` at N-1 is archive data past 128
// blocks on Alchemy; a provider that cannot answer throws from the rpc layer and
// the caller records STATE_UNAVAILABLE for the block. Answers that arrive but
// cannot be used (a null block, a receipt from another height) are the same
// condition and throw StateUnavailableError here.

import { ERC20_TRANSFER_TOPIC, WETH } from "../chain/constants.js";
import type {
  Address,
  BlockContext,
  Hex,
  RpcClient,
  RpcLog,
  RpcReceipt,
  RpcTransaction,
  TxWithReceipt,
} from "../types.js";

/** Raw JSON-RPC shapes, hex-encoded strings. Decoded exactly once, here, into the bigint types of types.ts. */
interface RawTransaction {
  readonly hash: string;
  readonly from: string;
  readonly to: string | null;
  readonly value: string;
  readonly nonce: string;
  readonly input: string;
  readonly transactionIndex: string;
  readonly blockNumber: string;
}

interface RawBlock {
  readonly number: string;
  readonly transactions: readonly (RawTransaction | string)[];
}

interface RawLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly blockNumber: string;
  readonly transactionHash: string;
  readonly logIndex: string;
}

interface RawReceipt {
  readonly transactionHash: string;
  readonly from: string;
  readonly to: string | null;
  readonly status: string;
  readonly gasUsed: string;
  readonly effectiveGasPrice?: string;
  readonly logs: readonly RawLog[];
  readonly blockNumber: string;
}

/**
 * The chain answered, but with something this block cannot be built from: a
 * null block, a missing receipt, a receipt from another height, a log naming a
 * transaction the block does not list. None of these is "no activity"; every
 * one is "this endpoint does not have this block yet". The caller records the
 * block as STATE_UNAVAILABLE and retries it on a later tick.
 */
export class StateUnavailableError extends Error {
  constructor(
    readonly wallet: Address,
    readonly blockL2: bigint,
    detail: string,
  ) {
    super(`block ${blockL2} for ${wallet}: ${detail}`);
    this.name = "StateUnavailableError";
  }
}

// Hex helpers, ported from the session engine of the project this was forked from (src/chain.ts.)
export const hexToBigInt = (value: string): bigint => BigInt(value);
export const hexToNumber = (value: string): number => Number(BigInt(value));
export const toBlockTag = (block: bigint): Hex => `0x${block.toString(16)}`;
export const normalize = (address: string): Address => address.toLowerCase() as Address;
/** Left-pads an address to a 32-byte log topic. */
export const addressTopic = (address: Address): Hex => `0x${normalize(address).slice(2).padStart(64, "0")}`;
/** Decodes the 20-byte address out of a 32-byte log topic. */
export const topicAddress = (topic: string): Address => normalize(`0x${topic.slice(26)}`);
/** ERC-20 balanceOf(address) calldata, the exact bytes the recorded fixture carries. */
export const balanceOfCalldata = (holder: Address): Hex => `0x70a08231${normalize(holder).slice(2).padStart(64, "0")}`;

export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

function decodeTransaction(raw: RawTransaction): RpcTransaction {
  return {
    hash: raw.hash.toLowerCase() as Hex,
    from: normalize(raw.from),
    to: raw.to === null || raw.to === undefined ? null : normalize(raw.to),
    value: hexToBigInt(raw.value),
    nonce: hexToNumber(raw.nonce),
    input: raw.input as Hex,
    transactionIndex: hexToNumber(raw.transactionIndex),
    blockNumber: hexToBigInt(raw.blockNumber),
  };
}

function decodeLog(raw: RawLog): RpcLog {
  return {
    address: normalize(raw.address),
    topics: raw.topics.map((topic) => topic.toLowerCase() as Hex),
    data: raw.data as Hex,
    blockNumber: hexToBigInt(raw.blockNumber),
    transactionHash: raw.transactionHash.toLowerCase() as Hex,
    logIndex: hexToNumber(raw.logIndex),
  };
}

function decodeReceipt(raw: RawReceipt, wallet: Address, blockL2: bigint): RpcReceipt {
  const status = raw.status === "0x1" ? "success" : raw.status === "0x0" ? "reverted" : null;
  if (status === null) {
    throw new StateUnavailableError(wallet, blockL2, `receipt ${raw.transactionHash} has status ${raw.status}, neither 0x1 nor 0x0`);
  }
  // Gas is priced by what was actually charged. A receipt without it would make
  // gasPaid read as zero, and the block would then refuse every tick on a
  // mismatch it cannot name; better to say so once, here.
  if (raw.effectiveGasPrice === undefined) {
    throw new StateUnavailableError(wallet, blockL2, `receipt ${raw.transactionHash} carries no effectiveGasPrice`);
  }
  return {
    transactionHash: raw.transactionHash.toLowerCase() as Hex,
    from: normalize(raw.from),
    to: raw.to === null || raw.to === undefined ? null : normalize(raw.to),
    status,
    gasUsed: hexToBigInt(raw.gasUsed),
    effectiveGasPrice: hexToBigInt(raw.effectiveGasPrice),
    logs: raw.logs.map(decodeLog),
    blockNumber: hexToBigInt(raw.blockNumber),
  };
}

/**
 * Builds the BlockContext for one (wallet, block): the wallet's transactions in
 * the block (sent, received, or named by a 3-topic Transfer log) with receipts
 * in transactionIndex order, native and WETH balances at N-1 and N, and whether
 * the wallet has code at N.
 *
 * Throws StateUnavailableError when the chain's answers cannot be assembled
 * into one consistent block; lets rpc-layer errors propagate. Either way the
 * caller records STATE_UNAVAILABLE and retries the block later.
 */
export async function buildBlockContext(rpc: RpcClient, wallet: Address, blockL2: bigint): Promise<BlockContext> {
  if (blockL2 < 1n) throw new Error(`block ${blockL2} has no predecessor to measure cash against`);
  const account = normalize(wallet);
  const tag = toBlockTag(blockL2);
  const previous = toBlockTag(blockL2 - 1n);
  const topic = addressTopic(account);
  const wethBalanceOf = { to: WETH, data: balanceOfCalldata(account) };

  const [block, sentLogs, receivedLogs, nativeBeforeHex, nativeAfterHex, wethBeforeHex, wethAfterHex, code] =
    await Promise.all([
      rpc.call<RawBlock | null>("eth_getBlockByNumber", [tag, true]),
      rpc.call<readonly RawLog[] | null>("eth_getLogs", [{ fromBlock: tag, toBlock: tag, topics: [ERC20_TRANSFER_TOPIC, topic] }]),
      rpc.call<readonly RawLog[] | null>("eth_getLogs", [
        { fromBlock: tag, toBlock: tag, topics: [ERC20_TRANSFER_TOPIC, null, topic] },
      ]),
      rpc.call<string | null>("eth_getBalance", [account, previous]),
      rpc.call<string | null>("eth_getBalance", [account, tag]),
      rpc.call<string | null>("eth_call", [wethBalanceOf, previous]),
      rpc.call<string | null>("eth_call", [wethBalanceOf, tag]),
      rpc.call<string | null>("eth_getCode", [account, tag]),
    ]);

  // A NULL BLOCK IS A MISSING ANSWER, NOT AN EMPTY ONE. Providers return null
  // for a block they do not have — a lagging replica, a pruned archive, a node
  // still syncing. Reading that as "no transactions here" silently deletes
  // whatever was in it. (Ported from session-engine-old/src/window.ts.)
  if (block === null || block === undefined) {
    throw new StateUnavailableError(account, blockL2, "eth_getBlockByNumber returned null; the endpoint does not have this block");
  }
  if (hexToBigInt(block.number) !== blockL2) {
    throw new StateUnavailableError(account, blockL2, `eth_getBlockByNumber answered with block ${hexToBigInt(block.number)}`);
  }
  if (sentLogs === null || sentLogs === undefined || receivedLogs === null || receivedLogs === undefined) {
    throw new StateUnavailableError(account, blockL2, "eth_getLogs returned null for the block");
  }
  const answered = (label: string, value: string | null | undefined): string => {
    if (value === null || value === undefined) throw new StateUnavailableError(account, blockL2, `${label} returned null`);
    return value;
  };
  const nativeBefore = hexToBigInt(answered("eth_getBalance(N-1)", nativeBeforeHex));
  const nativeAfter = hexToBigInt(answered("eth_getBalance(N)", nativeAfterHex));
  const wethBefore = wordToBigInt(answered("WETH.balanceOf(N-1)", wethBeforeHex));
  const wethAfter = wordToBigInt(answered("WETH.balanceOf(N)", wethAfterHex));
  const codeAt = answered("eth_getCode(N)", code);

  const byHash = new Map<string, RawTransaction>();
  for (const tx of block.transactions) {
    if (typeof tx === "string") {
      throw new StateUnavailableError(account, blockL2, "eth_getBlockByNumber returned hashes where full transactions were requested");
    }
    byHash.set(tx.hash.toLowerCase(), tx);
  }

  // Source 1: sent by or addressed to the wallet.
  const wanted = new Map<string, RawTransaction>();
  for (const [hash, tx] of byHash) {
    if (normalize(tx.from) === account || (tx.to !== null && tx.to !== undefined && normalize(tx.to) === account)) {
      wanted.set(hash, tx);
    }
  }
  // Source 2: named by a Transfer log in either direction.
  for (const log of [...sentLogs, ...receivedLogs]) {
    // ERC-721 and ERC-404 share ERC-20's Transfer topic but carry the tokenId in
    // topics[3], giving four topics instead of three. They move no fungible
    // balance, so a transaction known only through one of them is not a cash
    // event. (Ported from session-engine-old/src/window.ts.)
    if (log.topics.length !== 3) continue;
    const hash = log.transactionHash.toLowerCase();
    if (wanted.has(hash)) continue;
    const tx = byHash.get(hash);
    // The same endpoint served both the block and the log. A log naming a
    // transaction the block does not list is not a transaction to skip; it is
    // two answers from two views of the chain.
    if (tx === undefined) {
      throw new StateUnavailableError(account, blockL2, `Transfer log names tx ${hash} but the block does not list it`);
    }
    wanted.set(hash, tx);
  }

  const ordered = [...wanted.values()].sort((a, b) => hexToNumber(a.transactionIndex) - hexToNumber(b.transactionIndex));
  const rawReceipts = await Promise.all(
    ordered.map((tx) => rpc.call<RawReceipt | null>("eth_getTransactionReceipt", [tx.hash])),
  );

  const txs: TxWithReceipt[] = [];
  for (let i = 0; i < ordered.length; i += 1) {
    const raw = ordered[i];
    const rawReceipt = rawReceipts[i];
    if (raw === undefined) continue;
    if (rawReceipt === null || rawReceipt === undefined) {
      throw new StateUnavailableError(account, blockL2, `eth_getTransactionReceipt returned null for ${raw.hash}`);
    }
    const tx = decodeTransaction(raw);
    const receipt = decodeReceipt(rawReceipt, account, blockL2);
    if (tx.blockNumber !== blockL2 || receipt.blockNumber !== blockL2 || receipt.transactionHash !== tx.hash) {
      throw new StateUnavailableError(
        account,
        blockL2,
        `tx ${tx.hash} reports block ${tx.blockNumber}, its receipt block ${receipt.blockNumber} for ${receipt.transactionHash}`,
      );
    }
    txs.push({ tx, receipt });
  }

  return {
    wallet: account,
    blockL2,
    txs,
    nativeBefore,
    nativeAfter,
    wethBefore,
    wethAfter,
    hasCode: codeAt !== "0x" && codeAt !== "",
  };
}

/**
 * Decodes one ABI word. An address with no code answers eth_call with empty
 * data rather than reverting; canonical WETH has code, so for it an empty
 * answer is still zero balance and never a crash. (Ported from
 * session-engine-old/src/chain.ts erc20BalanceAt.)
 */
export function wordToBigInt(data: string): bigint {
  if (data === "0x" || data === "") return 0n;
  return hexToBigInt(data);
}
