// Where the worker looks for a wallet's trades, and how it knows it looked everywhere.
//
// A trade leaves an ERC-20 `Transfer` with the wallet in topic[1] (it sold) or
// topic[2] (it bought), so ONE `eth_getLogs` per direction, with every managed
// wallet as an OR array in that topic, answers "who moved a token in this range"
// for all wallets at once — cost in ACTIVITY, not in users. But a log is a
// filter, never an authority (keeper-old discovery.ts, accountsWithLogActivity):
// the approve before every GMGN sell, a native send and the vault's own pull
// emit no Transfer at all. So every block a log nominates is read in full and
// every tx the wallet sent or received there is a candidate too; then the nonce
// delta over the range is compared with the sent txs actually found. A provider
// that answers a capped range with an EMPTY list and no error (keeper-old
// discovery.ts:65-71) shows up here as fewer sent txs than the nonce says, and
// that wallet's range must not close.
//
// Ported from the keeper of the project this was forked from (src/discovery.ts: the factory-log discovery)
// (TradingAccountLinked/Unlinked, `activeVaultOf` as authority), the OR-array
// Transfer scan and `nextScanFrom`. The per-block union and the nonce
// reconciliation are new to this worker.

import { decodeAbiParameters, encodeAbiParameters, toEventSelector, toFunctionSelector } from "viem";

import { ERC20_TRANSFER_TOPIC, WETH } from "../chain/constants.js";
import { blockTransactions, getLogs, nonceAt } from "../chain/reads.js";
import type { Address, Candidate, DiscoveryResult, Hex, RpcClient, RpcLog, WalletRef } from "../types.js";

// VaultFactory.sol emits these on every link and unlink, for the WHOLE system,
// so the complete, current set of (trading account, vault) pairs is derivable
// from one contract's logs. Fragments as keeper-old/src/discovery.ts used them;
// test/discover.test.ts pins them to @nuvem/contracts-artifacts.
export const TRADING_ACCOUNT_LINKED_TOPIC: Hex = toEventSelector("TradingAccountLinked(address,address,bytes32)");
export const TRADING_ACCOUNT_UNLINKED_TOPIC: Hex = toEventSelector("TradingAccountUnlinked(address,address,bytes32)");
export const ACTIVE_VAULT_OF_SELECTOR: Hex = toFunctionSelector("activeVaultOf(address)");

const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

function lower(address: string): Address {
  return address.toLowerCase() as Address;
}

/** An address as a 32-byte log topic: what `eth_getLogs` wants in an indexed position. */
export function addressTopic(address: Address): Hex {
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
}

/** The address a topic carries, or null when the topic is not a left-padded address at all. */
export function topicAddress(topic: Hex | undefined): Address | null {
  if (topic === undefined || topic.length !== 66) return null;
  if (!/^0x0{24}[0-9a-fA-F]{40}$/.test(topic)) return null;
  return lower(`0x${topic.slice(26)}`);
}

/**
 * Every buy, sell, approve, send and pull the managed wallets made in the range,
 * as (wallet, block, tx) candidates for the reconciler — and the wallets for
 * which this scan cannot vouch.
 */
export async function discover(
  rpc: RpcClient,
  wallets: readonly WalletRef[],
  range: { fromBlock: bigint; toBlock: bigint },
  options: { maxLogSpan: bigint },
): Promise<DiscoveryResult> {
  const { fromBlock, toBlock } = range;
  const managed = new Set<Address>();
  for (const wallet of wallets) managed.add(lower(wallet.address));

  // Nothing to look for, or the head moved backwards: nothing was read, so
  // there is nothing to reconcile and nobody to flag.
  if (managed.size === 0 || fromBlock > toBlock) {
    return { fromBlock, toBlock, candidates: [], incompleteWallets: [] };
  }

  const scan = new RangeScan(rpc, managed, fromBlock, toBlock);
  await scan.nominateFromTransferLogs(options.maxLogSpan);
  await scan.readNominatedBlocks();
  const incompleteWallets = await scan.reconcileNonces();
  return { fromBlock, toBlock, candidates: scan.candidates(), incompleteWallets };
}

/** One discovery pass over one range: the state the three steps share. */
class RangeScan {
  private readonly found = new Map<string, Candidate>();
  private readonly nominated = new Set<bigint>();
  private readonly read = new Set<bigint>();
  /** wallet -> block -> txs the wallet SENT there (what the nonce delta must explain). */
  private readonly sent = new Map<Address, Map<bigint, number>>();

  constructor(
    private readonly rpc: RpcClient,
    private readonly managed: ReadonlySet<Address>,
    private readonly fromBlock: bigint,
    private readonly toBlock: bigint,
  ) {}

  /**
   * Step 1. Sender OR recipient: a sell moves the token out, a buy moves it in,
   * and either one means the wallet was trading (keeper-old discovery.ts).
   */
  async nominateFromTransferLogs(maxLogSpan: bigint): Promise<void> {
    const walletSet: Hex[] = [...this.managed].sort().map(addressTopic);
    const filter = { fromBlock: this.fromBlock, toBlock: this.toBlock };
    const sold = await getLogs(this.rpc, { ...filter, topics: [ERC20_TRANSFER_TOPIC, walletSet, null] }, maxLogSpan);
    const bought = await getLogs(this.rpc, { ...filter, topics: [ERC20_TRANSFER_TOPIC, null, walletSet] }, maxLogSpan);
    for (const log of sold) this.nominate(log);
    for (const log of bought) this.nominate(log);
  }

  private nominate(log: RpcLog): void {
    // ERC-721/404 mints share the Transfer topic with a fourth, indexed
    // tokenId; they are not a token leg and they break the decoders.
    if (log.topics.length !== 3) return;
    // WETH moving is a wrap, an unwrap or cash changing pockets — never a
    // trade's token leg. The reconciler sees it anyway through the wallet's
    // own txs and the WETH balance; as a nominator it would only read
    // wrap/unwrap as sell/buy.
    if (lower(log.address) === WETH) return;
    // A log outside the range we asked for is a provider bug; crediting it to
    // this range would double-count it against another.
    if (log.blockNumber < this.fromBlock || log.blockNumber > this.toBlock) return;
    for (const position of [1, 2] as const) {
      const wallet = topicAddress(log.topics[position]);
      if (wallet === null || !this.managed.has(wallet)) continue;
      // The log's own tx is a candidate even when the wallet neither sent nor
      // received it — that is what an airdrop looks like.
      this.add(wallet, log.blockNumber, log.transactionHash);
      this.nominated.add(log.blockNumber);
    }
  }

  /** Step 2. Every nominated block, read once for all wallets. */
  async readNominatedBlocks(): Promise<void> {
    for (const block of [...this.nominated].sort(compareBigint)) await this.readBlock(block);
  }

  private async readBlock(block: bigint): Promise<void> {
    if (this.read.has(block)) return;
    this.read.add(block);
    const txs = await blockTransactions(this.rpc, block);
    for (const tx of txs) {
      const from = lower(tx.from);
      const to = tx.to === null ? null : lower(tx.to);
      if (this.managed.has(from)) {
        // The log-less approve, the native send, the vault pull: all here.
        this.add(from, block, tx.hash);
        this.countSent(from, block);
      }
      if (to !== null && this.managed.has(to)) this.add(to, block, tx.hash);
    }
  }

  private add(wallet: Address, blockL2: bigint, txHash: Hex): void {
    const hash = lower(txHash);
    const key = `${wallet}|${blockL2}|${hash}`;
    if (!this.found.has(key)) this.found.set(key, { wallet, blockL2, txHash: hash });
  }

  private countSent(wallet: Address, block: bigint): void {
    let perBlock = this.sent.get(wallet);
    if (perBlock === undefined) {
      perBlock = new Map();
      this.sent.set(wallet, perBlock);
    }
    perBlock.set(block, (perBlock.get(block) ?? 0) + 1);
  }

  private sentIn(wallet: Address, lo: bigint, hi: bigint): number {
    let total = 0;
    for (const [block, count] of this.sent.get(wallet) ?? []) {
      if (block >= lo && block <= hi) total += count;
    }
    return total;
  }

  /**
   * Step 3. The nonce is the chain's own count of what the wallet sent, so
   * `nonceAt(toBlock) − nonceAt(fromBlock − 1)` must equal the sent txs this
   * scan found. When it does not, the missing txs are first LOCATED — the
   * nonce is monotonic in the block height, so bisecting on it finds each
   * unread block with a sent tx in ~2·log2(span) reads — because a native send
   * or the vault's own pull sits in a block no Transfer log nominates, and a
   * wallet left incomplete for that would stay incomplete on every later tick.
   * A wallet that still does not add up after the search is reported, never
   * guessed at.
   */
  async reconcileNonces(): Promise<readonly Address[]> {
    const incomplete: Address[] = [];
    for (const wallet of [...this.managed].sort()) {
      const before = this.fromBlock === 0n ? 0 : await nonceAt(this.rpc, wallet, this.fromBlock - 1n);
      const after = await nonceAt(this.rpc, wallet, this.toBlock);
      const expected = after - before;
      if (expected > this.sentIn(wallet, this.fromBlock, this.toBlock)) {
        await this.locateUnreadSent(wallet, before, after);
      }
      // Fewer than the nonce says: a provider capped or truncated a read. More:
      // the nonce came from a node behind the blocks. Either way this scan
      // cannot vouch for the range.
      if (expected !== this.sentIn(wallet, this.fromBlock, this.toBlock)) incomplete.push(wallet);
    }
    return incomplete;
  }

  private async locateUnreadSent(wallet: Address, nonceBefore: number, nonceAfter: number): Promise<void> {
    const span = this.toBlock - this.fromBlock + 1n;
    const missing = BigInt(nonceAfter - nonceBefore - this.sentIn(wallet, this.fromBlock, this.toBlock));
    const unread = span - BigInt(this.read.size);
    // Bisection costs about 2·log2(span) nonce reads per missing block; when
    // that is no cheaper than reading every block left, read every block.
    if (missing * 2n * BigInt(bitLength(span)) >= unread) {
      for (let block = this.fromBlock; block <= this.toBlock; block += 1n) await this.readBlock(block);
      return;
    }
    await this.bisect(wallet, this.fromBlock, this.toBlock, nonceBefore, nonceAfter);
  }

  /** `nonceLo` is the nonce just before `lo`, `nonceHi` the nonce at `hi`. */
  private async bisect(wallet: Address, lo: bigint, hi: bigint, nonceLo: number, nonceHi: number): Promise<void> {
    const unaccounted = nonceHi - nonceLo - this.sentIn(wallet, lo, hi);
    if (unaccounted <= 0) return;
    if (lo === hi) {
      await this.readBlock(lo);
      return;
    }
    const mid = lo + (hi - lo) / 2n;
    const nonceMid = await nonceAt(this.rpc, wallet, mid);
    await this.bisect(wallet, lo, mid, nonceLo, nonceMid);
    await this.bisect(wallet, mid + 1n, hi, nonceMid, nonceHi);
  }

  candidates(): readonly Candidate[] {
    return [...this.found.values()].sort(
      (a, b) => a.wallet.localeCompare(b.wallet) || compareBigint(a.blockL2, b.blockL2) || a.txHash.localeCompare(b.txHash),
    );
  }
}

function compareBigint(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function bitLength(n: bigint): number {
  return n <= 0n ? 0 : n.toString(2).length;
}

// Who is this worker responsible for? Ask the chain, not a database.
//
// The logs are a HISTORY, not a state: an account can be linked, unlinked and
// linked again. Replaying them in order gives the latest intent, but the
// authority is `activeVaultOf`, which is read back for every candidate. A log
// this scan missed — a range cap, a reorg, an RPC that silently truncated —
// then shows up as a candidate whose on-chain state disagrees, and it is
// dropped rather than settled against a stale vault.
// (keeper-old/src/discovery.ts, discoverManagedAccounts)
export async function discoverLinkedWallets(
  rpc: RpcClient,
  factory: Address,
  range: { fromBlock: bigint; toBlock: bigint },
  options: { maxLogSpan: bigint },
): Promise<readonly WalletRef[]> {
  if (range.fromBlock > range.toBlock) return [];
  const logs = await getLogs(
    rpc,
    {
      fromBlock: range.fromBlock,
      toBlock: range.toBlock,
      address: lower(factory),
      topics: [[TRADING_ACCOUNT_LINKED_TOPIC, TRADING_ACCOUNT_UNLINKED_TOPIC]],
    },
    options.maxLogSpan,
  );

  const candidates = new Set<Address>();
  for (const log of logs) {
    // Both LINK and UNLINK add a candidate. Resolving which is current is the
    // job of activeVaultOf below; treating an unlink as "forget it" here would
    // lose an account that was later re-linked in a range this loop already
    // passed.
    const account = topicAddress(log.topics[1]);
    if (account !== null) candidates.add(account);
  }

  const linked: WalletRef[] = [];
  for (const account of [...candidates].sort()) {
    const vault = await activeVaultOf(rpc, lower(factory), account);
    if (vault === ZERO_ADDRESS) continue;
    linked.push({ address: account, vault });
  }
  return linked;
}

/** `VaultFactory.activeVaultOf(account)` at the head: the zero address means "not linked". */
export async function activeVaultOf(rpc: RpcClient, factory: Address, account: Address): Promise<Address> {
  const data: Hex = `${ACTIVE_VAULT_OF_SELECTOR}${encodeAbiParameters([{ type: "address" }], [account]).slice(2)}`;
  const result = await rpc.call<Hex>("eth_call", [{ to: factory, data }, "latest"]);
  if (typeof result !== "string" || result.length < 66) {
    // No data is a factory that is not there, not a factory with no users:
    // "no wallets" from a wrong address would look like every user leaving.
    throw new Error(`VaultFactory ${factory} returned no data for activeVaultOf(${account}); is the factory address right?`);
  }
  const [vault] = decodeAbiParameters([{ type: "address" }], result);
  return lower(vault);
}

/**
 * Where the next factory scan starts, given where the last one finished.
 *
 * IT MUST NEVER RETURN A BLOCK ABOVE WHAT WAS ALREADY SCANNED. A gap here is the
 * worst shape of bug this module can have: the missed range holds a
 * `TradingAccountLinked` nobody ever reads again, so a real user is simply never
 * settled for, and every sweep afterwards reports a healthy, smaller count.
 * That is why this is a named function with its own tests rather than an
 * expression inside the sweep — it is four lines and it is load-bearing.
 *
 * `rescan` is overlap, not paranoia: it re-reads the tail so a link landing in a
 * block the watermark stepped over is still picked up.
 * (keeper-old/src/discovery.ts, nextScanFrom)
 */
export function nextScanFrom(options: {
  /** The factory's deployment block. Never scan below it; there is nothing there. */
  readonly deployedAt: bigint;
  /** Head of the last successful scan, or null before the first one. */
  readonly scannedTo: bigint | null;
  readonly rescan: bigint;
}): bigint {
  if (options.scannedTo === null) return options.deployedAt;
  const back = options.scannedTo - options.rescan;
  return back < options.deployedAt ? options.deployedAt : back;
}
