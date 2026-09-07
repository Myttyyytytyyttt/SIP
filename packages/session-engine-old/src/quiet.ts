// Proving a block range empty without opening the blocks in it.
//
// The dense scan costs one `eth_getBlockByNumber` per block, and it must, because
// three of the things that move a trading wallet's cash emit no log at all: the
// gas-only `approve` before each GMGN sell, plain native transfers, and the sell
// proceeds themselves, which arrive by internal call. Logs alone would miss the
// money.
//
// But a trading wallet is idle almost all of the time, and the dense scan pays
// full price for that idleness. Ten thousand quiet blocks cost ten thousand calls
// to discover nothing. This module makes that case cost three.
//
// THE PROOF, AND WHY IT IS A PROOF RATHER THAN A GUESS.
//
// For an account with no code, in a range (from, to]:
//
//   nonce unchanged   =>  the account sent NOTHING. An EOA cannot move native
//                         value, cannot move a token, and cannot spend gas
//                         without a transaction of its own, and every such
//                         transaction increments the nonce.
//   balance unchanged =>  nothing arrived either. Given the above, nothing left,
//                         so any incoming value would show here — including
//                         internal transfers, which is exactly what the tracer
//                         is otherwise needed for.
//   no Transfer logs  =>  no token arrived. Outgoing tokens are already excluded
//                         by the nonce; incoming ones always emit.
//
// Together these cover every way the wallet's cash — native or WETH — could have
// changed. Not "probably did not change": could not have.
//
// THE CODE CHECK IS LOAD-BEARING. All three arguments assume an EOA. An account
// with code can have value moved by someone ELSE calling into it, with no nonce
// change of its own, so the fast path is refused outright for such accounts.
// Privy embedded wallets are EOAs; an EIP-7702 delegation would make one not, and
// this must keep being correct if that ever happens.
//
// EVERY UNCERTAINTY FALLS BACK TO SCANNING. An RPC error, an account with code,
// anything unproven: the answer is "not proven quiet", which costs a dense scan
// and nothing else. Being wrong in the other direction would skip real money.

import { TRANSFER_TOPIC, addressTopic, hexToBigInt, toBlockTag } from "./chain.js";
import type { RpcClient } from "./rpc.js";

/**
 * Boundary facts about the account, cached per block.
 *
 * Bisection asks about the same boundaries repeatedly — the midpoint of one
 * range is an endpoint of the next — so caching turns the recursion's overhead
 * from quadratic into roughly one pair of calls per distinct block.
 */
export class BoundaryCache {
  readonly #rpc: RpcClient;
  readonly #account: string;
  readonly #nonces = new Map<string, number>();
  readonly #balances = new Map<string, bigint>();
  #hasCode: boolean | null = null;

  constructor(rpc: RpcClient, account: string) {
    this.#rpc = rpc;
    this.#account = account;
  }

  async nonceAt(block: bigint): Promise<number> {
    const key = block.toString();
    const cached = this.#nonces.get(key);
    if (cached !== undefined) return cached;
    const raw = await this.#rpc.call<string>("eth_getTransactionCount", [
      this.#account,
      toBlockTag(block),
    ]);
    const value = Number(hexToBigInt(raw));
    this.#nonces.set(key, value);
    return value;
  }

  async balanceAt(block: bigint): Promise<bigint> {
    const key = block.toString();
    const cached = this.#balances.get(key);
    if (cached !== undefined) return cached;
    const raw = await this.#rpc.call<string>("eth_getBalance", [this.#account, toBlockTag(block)]);
    const value = hexToBigInt(raw);
    this.#balances.set(key, value);
    return value;
  }

  /** Whether the account carries code. Asked once; the answer gates the fast path. */
  async hasCode(): Promise<boolean> {
    if (this.#hasCode !== null) return this.#hasCode;
    const code = await this.#rpc.call<string>("eth_getCode", [this.#account, "latest"]);
    this.#hasCode = code !== undefined && code !== null && code !== "0x" && code !== "0x0";
    return this.#hasCode;
  }
}

/**
 * Can anything at all have happened to this account in (from, to]?
 *
 * Returns true only when proven empty. Anything else — including any failure to
 * establish the facts — returns false, which costs a dense scan.
 */
export async function isProvablyQuiet(
  rpc: RpcClient,
  account: string,
  from: bigint,
  to: bigint,
  cache: BoundaryCache,
): Promise<boolean> {
  if (to <= from) return true;

  try {
    // An account with code can be moved by someone else's transaction, so none
    // of the three arguments below hold for it.
    if (await cache.hasCode()) return false;

    const [nonceFrom, nonceTo] = await Promise.all([cache.nonceAt(from), cache.nonceAt(to)]);
    if (nonceFrom !== nonceTo) return false;

    const [balanceFrom, balanceTo] = await Promise.all([cache.balanceAt(from), cache.balanceAt(to)]);
    if (balanceFrom !== balanceTo) return false;

    // Only INCOMING tokens remain possible, and those always emit. One call
    // covers the whole range regardless of how wide it is.
    const topic = addressTopic(account);
    const logs = await rpc.call<unknown[]>("eth_getLogs", [
      {
        fromBlock: toBlockTag(from + 1n),
        toBlock: toBlockTag(to),
        topics: [TRANSFER_TOPIC, null, topic],
      },
    ]);
    if (logs.length > 0) return false;

    return true;
  } catch {
    // Unproven is not the same as empty. Scanning costs calls; skipping wrongly
    // costs someone their savings.
    return false;
  }
}

/**
 * Splits (from, to] into the sub-ranges that need opening block by block.
 *
 * Bisection rather than fixed chunks: a wallet that traded once in a wide window
 * has its activity isolated in a few halvings, while fixed chunks would pay full
 * price for whichever chunk contains it. Ranges at or below `dense` are returned
 * whole, because below that the proof costs more than the scan it saves.
 */
export async function activeRanges(
  rpc: RpcClient,
  account: string,
  from: bigint,
  to: bigint,
  options: { readonly dense?: bigint; readonly cache?: BoundaryCache } = {},
): Promise<{ readonly from: bigint; readonly to: bigint }[]> {
  const dense = options.dense ?? 64n;
  const cache = options.cache ?? new BoundaryCache(rpc, account);

  if (to <= from) return [];
  if (to - from <= dense) return [{ from, to }];

  if (await isProvablyQuiet(rpc, account, from, to, cache)) return [];

  const mid = from + (to - from) / 2n;
  const [left, right] = await Promise.all([
    activeRanges(rpc, account, from, mid, { dense, cache }),
    activeRanges(rpc, account, mid, to, { dense, cache }),
  ]);
  return [...left, ...right];
}
