// Typed reads over a bare RpcClient. Every hex quantity becomes a bigint here
// and nowhere else; every address leaves lowercase. Owner: chain.
//
// A null answer is never an empty answer. `eth_getBlockByNumber` for a height
// the node does not have returns null with no error, and so does a receipt for
// a transaction it has not seen; treating either as "nothing there" is how a
// scan quietly reads less than it claims. Both throw, and `getLogs` proves the
// node has each chunk's last block before asking for its logs.
//
// Ported from the session engine of the project this was forked from (src/chain.ts (cashAt, toL1Block,)
// transactionCountAt, erc20BalanceAt) and the keeper of the project this was forked from (src/discovery.ts
// :125-161 (the chunk loop and its coverage check).

import type { Address, Hex, RpcClient, RpcLog, RpcReceipt, RpcTransaction } from "../types.js";
import { BALANCE_OF_SELECTOR, WETH, addressWord, hexToBigInt, isHex, normalizeAddress, toBlockTag } from "./constants.js";

/** A node answered, but not with the shape or the block this module asked for. */
export class ChainReadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ChainReadError";
  }
}

/** The node does not have a block an `eth_getLogs` range ends at. See `getLogs`. */
export class CoverageError extends ChainReadError {
  constructor(
    readonly block: bigint,
    options?: { cause?: unknown },
  ) {
    super(
      `The RPC endpoint does not have block ${block}, so an eth_getLogs range ending there would be ` +
        "silently clamped to its own head and return fewer logs than exist. Refusing to report a scan " +
        "that did not happen — the caller must not advance a cursor past this.",
      options,
    );
    this.name = "CoverageError";
  }
}

// ── decoding ────────────────────────────────────────────────────────────────

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);

function object(value: unknown, what: string): JsonObject {
  if (!isObject(value)) throw new ChainReadError(`${what}: expected an object, got ${JSON.stringify(value)}`);
  return value;
}

function hex(value: unknown, what: string): Hex {
  if (!isHex(value)) throw new ChainReadError(`${what}: expected hex, got ${JSON.stringify(value)}`);
  return value.toLowerCase() as Hex;
}

function quantity(value: unknown, what: string): bigint {
  const raw = hex(value, what);
  if (raw.length < 3) throw new ChainReadError(`${what}: expected a quantity, got "0x"`);
  return hexToBigInt(raw);
}

function smallNumber(value: unknown, what: string): number {
  const big = quantity(value, what);
  const num = Number(big);
  if (!Number.isSafeInteger(num)) throw new ChainReadError(`${what}: ${big} does not fit a JS number`);
  return num;
}

function address(value: unknown, what: string): Address {
  if (typeof value !== "string") throw new ChainReadError(`${what}: expected an address, got ${JSON.stringify(value)}`);
  try {
    return normalizeAddress(value);
  } catch (error) {
    throw new ChainReadError(`${what}: ${(error as Error).message}`, { cause: error });
  }
}

function decodeLog(value: unknown, what: string): RpcLog {
  const log = object(value, what);
  const topics = log["topics"];
  if (!Array.isArray(topics)) throw new ChainReadError(`${what}.topics: expected an array`);
  return {
    address: address(log["address"], `${what}.address`),
    topics: topics.map((topic, i) => hex(topic, `${what}.topics[${i}]`)),
    data: hex(log["data"], `${what}.data`),
    blockNumber: quantity(log["blockNumber"], `${what}.blockNumber`),
    transactionHash: hex(log["transactionHash"], `${what}.transactionHash`),
    logIndex: smallNumber(log["logIndex"], `${what}.logIndex`),
  };
}

function decodeTransaction(value: unknown, what: string): RpcTransaction {
  const tx = object(value, what);
  const to = tx["to"];
  // A pending transaction has null blockNumber/transactionIndex. Nothing here
  // reads the mempool, so that shape is an error, not a tx at height 0.
  return {
    hash: hex(tx["hash"], `${what}.hash`),
    from: address(tx["from"], `${what}.from`),
    to: to === null || to === undefined ? null : address(to, `${what}.to`),
    value: quantity(tx["value"], `${what}.value`),
    nonce: smallNumber(tx["nonce"], `${what}.nonce`),
    input: hex(tx["input"], `${what}.input`),
    transactionIndex: smallNumber(tx["transactionIndex"], `${what}.transactionIndex`),
    blockNumber: quantity(tx["blockNumber"], `${what}.blockNumber`),
  };
}

function decodeReceipt(value: unknown, what: string): RpcReceipt {
  const receipt = object(value, what);
  const status = hex(receipt["status"], `${what}.status`);
  if (status !== "0x1" && status !== "0x0") throw new ChainReadError(`${what}.status: expected 0x1 or 0x0, got ${status}`);
  const logs = receipt["logs"];
  if (!Array.isArray(logs)) throw new ChainReadError(`${what}.logs: expected an array`);
  const to = receipt["to"];
  return {
    transactionHash: hex(receipt["transactionHash"], `${what}.transactionHash`),
    from: address(receipt["from"], `${what}.from`),
    to: to === null || to === undefined ? null : address(to, `${what}.to`),
    status: status === "0x1" ? "success" : "reverted",
    gasUsed: quantity(receipt["gasUsed"], `${what}.gasUsed`),
    effectiveGasPrice: quantity(receipt["effectiveGasPrice"], `${what}.effectiveGasPrice`),
    logs: logs.map((log, i) => decodeLog(log, `${what}.logs[${i}]`)),
    blockNumber: quantity(receipt["blockNumber"], `${what}.blockNumber`),
  };
}

// ── reads ───────────────────────────────────────────────────────────────────

export async function blockNumber(rpc: RpcClient): Promise<bigint> {
  return quantity(await rpc.call<unknown>("eth_blockNumber", []), "eth_blockNumber");
}

/** The raw block, or null when the node does not have it (a null result is how geth says so). */
async function blockOrNull(rpc: RpcClient, blockL2: bigint, fullTransactions: boolean): Promise<JsonObject | null> {
  const what = `eth_getBlockByNumber(${blockL2})`;
  const raw = await rpc.call<unknown>("eth_getBlockByNumber", [toBlockTag(blockL2), fullTransactions]);
  if (raw === null || raw === undefined) return null;
  const block = object(raw, what);
  // A proxy in front of a pool can answer with the wrong block. The height is
  // in the answer, so it is checked.
  const number = block["number"];
  if (number !== undefined && quantity(number, `${what}.number`) !== blockL2) {
    throw new ChainReadError(`${what}: node answered with block ${quantity(number, `${what}.number`)}`);
  }
  return block;
}

/**
 * Maps an L2 block height to the L1 height Solidity sees.
 *
 * Robinhood Chain is Arbitrum Nitro: `block.number` in a contract returns the L1
 * number, while eth_blockNumber and every log carry the L2 number, millions
 * apart. The attested range must be L1; balances must be read at L2. Mixing them
 * makes every settlement revert with InvalidBlockRange.
 */
export async function l1BlockOf(rpc: RpcClient, blockL2: bigint): Promise<bigint> {
  const block = await blockOrNull(rpc, blockL2, false);
  if (block === null) throw new ChainReadError(`Block ${blockL2} is not available on this endpoint; its L1 height cannot be read.`);
  const l1 = block["l1BlockNumber"];
  if (l1 === undefined || l1 === null) {
    throw new ChainReadError(
      `Block ${blockL2} has no l1BlockNumber. This chain is not Arbitrum Nitro; the L2->L1 ` +
        "block mapping must be revisited before any attestation is built.",
    );
  }
  return quantity(l1, `eth_getBlockByNumber(${blockL2}).l1BlockNumber`);
}

/** Native balance at the END of `blockL2` (eth_getBalance reports post-state). */
export async function nativeBalanceAt(rpc: RpcClient, address: Address, blockL2: bigint): Promise<bigint> {
  const params = [normalizeAddress(address), toBlockTag(blockL2)];
  return quantity(await rpc.call<unknown>("eth_getBalance", params), `eth_getBalance(${address}, ${blockL2})`);
}

/**
 * ERC-20 balance at the END of `blockL2`.
 *
 * An address with no code returns empty data rather than reverting. That is
 * not an error and must not abort the scan: a contract that does not exist yet
 * holds no balance for anyone, so the honest answer is zero. This is the common
 * case, not a corner case: traders here buy tokens minted minutes earlier. A
 * genuine revert still throws from the RPC layer and still refuses.
 */
export async function erc20BalanceAt(rpc: RpcClient, token: Address, account: Address, blockL2: bigint): Promise<bigint> {
  const what = `balanceOf(${account}) on ${token} at ${blockL2}`;
  const result = await rpc.call<unknown>("eth_call", [
    { to: normalizeAddress(token), data: `${BALANCE_OF_SELECTOR}${addressWord(account)}` },
    toBlockTag(blockL2),
  ]);
  if (result === "0x" || result === "") return 0n;
  return quantity(result, what);
}

export async function wethBalanceAt(rpc: RpcClient, address: Address, blockL2: bigint): Promise<bigint> {
  return erc20BalanceAt(rpc, WETH, address, blockL2);
}

/** Transactions SENT by `address` up to and including `blockL2`; the discovery cross-check. */
export async function nonceAt(rpc: RpcClient, address: Address, blockL2: bigint): Promise<number> {
  const params = [normalizeAddress(address), toBlockTag(blockL2)];
  return smallNumber(await rpc.call<unknown>("eth_getTransactionCount", params), `eth_getTransactionCount(${address}, ${blockL2})`);
}

/** True when the address holds bytecode at `blockL2` — a contract, or an EIP-7702 delegation (0xef0100…). */
export async function hasCodeAt(rpc: RpcClient, address: Address, blockL2: bigint): Promise<boolean> {
  const code = hex(await rpc.call<unknown>("eth_getCode", [normalizeAddress(address), toBlockTag(blockL2)]), `eth_getCode(${address}, ${blockL2})`);
  return code.length > 2;
}

/** Every transaction in the block, in transactionIndex order. Throws when the node lacks the block. */
export async function blockTransactions(rpc: RpcClient, blockL2: bigint): Promise<readonly RpcTransaction[]> {
  const what = `eth_getBlockByNumber(${blockL2}, true)`;
  const block = await blockOrNull(rpc, blockL2, true);
  if (block === null) throw new ChainReadError(`Block ${blockL2} is not available on this endpoint; its transactions cannot be listed.`);
  const transactions = block["transactions"];
  if (!Array.isArray(transactions)) throw new ChainReadError(`${what}.transactions: expected an array`);
  return transactions
    .map((tx, i) => decodeTransaction(tx, `${what}.transactions[${i}]`))
    .sort((a, b) => a.transactionIndex - b.transactionIndex);
}

export async function receipt(rpc: RpcClient, txHash: Hex): Promise<RpcReceipt> {
  const what = `eth_getTransactionReceipt(${txHash})`;
  const raw = await rpc.call<unknown>("eth_getTransactionReceipt", [txHash]);
  if (raw === null || raw === undefined) throw new ChainReadError(`${what}: no receipt — the transaction is pending or unknown to this endpoint.`);
  return decodeReceipt(raw, what);
}

export async function transaction(rpc: RpcClient, txHash: Hex): Promise<RpcTransaction> {
  const what = `eth_getTransactionByHash(${txHash})`;
  const raw = await rpc.call<unknown>("eth_getTransactionByHash", [txHash]);
  if (raw === null || raw === undefined) throw new ChainReadError(`${what}: unknown to this endpoint.`);
  return decodeTransaction(raw, what);
}

export interface LogFilter {
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly address?: Address | readonly Address[];
  /** Positional; an inner array is an OR over that position, null is a wildcard. Sent verbatim. */
  readonly topics: readonly (Hex | readonly Hex[] | null)[];
}

/**
 * THE ENDPOINT MUST ACTUALLY HAVE the block a chunk ends at, and this is
 * checked before the chunk rather than assumed.
 *
 * `eth_getLogs` has no coverage receipt: a geth-family node whose head is below
 * the requested `toBlock` CLAMPS it and returns the shorter list with no error
 * and no indication it read less than asked. A caller that then records
 * `toBlock` as scanned has stepped over blocks nobody read. It is reachable
 * whenever the head and the logs can come from different nodes: a fallback
 * transport, or any URL that fronts a pool. One block read per chunk turns a
 * silent short read into a refusal.
 */
async function assertCovered(rpc: RpcClient, block: bigint): Promise<void> {
  let covered: JsonObject | null;
  try {
    covered = await blockOrNull(rpc, block, false);
  } catch (error) {
    throw new CoverageError(block, { cause: error });
  }
  if (covered === null) throw new CoverageError(block);
}

const byBlockThenIndex = (a: RpcLog, b: RpcLog): number =>
  a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1;

/**
 * `eth_getLogs` over `[fromBlock, toBlock]`, in chunks of at most `maxSpan`
 * blocks, each preceded by a coverage check on its last block. Returns the logs
 * sorted by (blockNumber, logIndex). An inverted range is empty and makes no
 * calls: the head moved backwards, there is nothing to read.
 *
 * Providers cap the span and the cap is not discoverable, so the scan is
 * chunked rather than optimistic: a provider that truncates a too-wide range
 * returns FEWER logs, which would look like a quiet wallet rather than like a
 * failed read (keeper-old/src/discovery.ts:65-71).
 */
export async function getLogs(rpc: RpcClient, filter: LogFilter, maxSpan: bigint): Promise<readonly RpcLog[]> {
  if (maxSpan < 1n) throw new RangeError(`maxSpan must be at least 1 block, got ${maxSpan}`);
  const logs: RpcLog[] = [];
  for (let start = filter.fromBlock; start <= filter.toBlock; start += maxSpan) {
    const end = start + maxSpan - 1n > filter.toBlock ? filter.toBlock : start + maxSpan - 1n;
    await assertCovered(rpc, end);
    const raw = await rpc.call<unknown>("eth_getLogs", [chunkFilter(filter, start, end)]);
    const what = `eth_getLogs(${start}..${end})`;
    if (!Array.isArray(raw)) throw new ChainReadError(`${what}: expected an array, got ${JSON.stringify(raw)}`);
    for (const [i, entry] of raw.entries()) logs.push(decodeLog(entry, `${what}[${i}]`));
  }
  return logs.sort(byBlockThenIndex);
}

/** Key order is part of the recorded-fixture contract: fromBlock, toBlock, [address], topics. */
function chunkFilter(filter: LogFilter, start: bigint, end: bigint): JsonObject {
  const out: JsonObject = { fromBlock: toBlockTag(start), toBlock: toBlockTag(end) };
  if (filter.address !== undefined) {
    out["address"] = typeof filter.address === "string" ? normalizeAddress(filter.address) : filter.address.map(normalizeAddress);
  }
  out["topics"] = filter.topics;
  return out;
}
