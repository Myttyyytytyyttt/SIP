// Tests for src/observe/discover.ts. Owner: discover.
//
// Two kinds of chain stand in for the network. `mockChain` is a hand-built
// endpoint that answers the standard JSON-RPC shapes from a block map — the
// OR-array scans were never recorded (DESIGN.md §0.5), so this is where they
// are proven. `fixtureChain` serves test/fixtures/mainnet-4663.json, recorded
// per wallet with a string topic; it maps a one-wallet OR array onto that key,
// and derives a nonce at an unrecorded height from the recorded blocks, which
// the recording holds in full for every window.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";
import { toEventSelector, toFunctionSelector, type Abi, type AbiEvent, type AbiFunction } from "viem";

import { ERC20_TRANSFER_TOPIC, WETH } from "../src/chain/constants.js";
import {
  ACTIVE_VAULT_OF_SELECTOR,
  TRADING_ACCOUNT_LINKED_TOPIC,
  TRADING_ACCOUNT_UNLINKED_TOPIC,
  addressTopic,
  discover,
  discoverLinkedWallets,
  nextScanFrom,
  topicAddress,
} from "../src/observe/discover.js";
import type { Address, Candidate, Hex, RpcClient, WalletRef } from "../src/types.js";

// ── actors ──────────────────────────────────────────────────────────────────

const A: Address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B: Address = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const THIRD: Address = "0xcccccccccccccccccccccccccccccccccccccccc";
const TOKEN: Address = "0x1111111111111111111111111111111111111111";
const NFT: Address = "0x2222222222222222222222222222222222222222";
const ROUTER: Address = "0x3333333333333333333333333333333333333333";
const FACTORY: Address = "0x4444444444444444444444444444444444444444";
const VAULT_A: Address = "0x5555555555555555555555555555555555555555";
const VAULT_B: Address = "0x6666666666666666666666666666666666666666";
const VAULT_OLD: Address = "0x7777777777777777777777777777777777777777";
const AIRDROPPER: Address = "0x8888888888888888888888888888888888888888";
const ZERO: Address = "0x0000000000000000000000000000000000000000";

const wallets = (...addresses: Address[]): WalletRef[] => addresses.map((address) => ({ address, vault: VAULT_A }));
const tx = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const hex = (n: bigint | number): Hex => `0x${n.toString(16)}`;
const word = (address: Address): Hex => `0x${address.slice(2).padStart(64, "0")}`;

const transfer = (token: Address, from: Address, to: Address, txHash: Hex): MockLog => ({
  address: token,
  topics: [ERC20_TRANSFER_TOPIC, addressTopic(from), addressTopic(to)],
  txHash,
});

// ── the hand-built endpoint ─────────────────────────────────────────────────

interface MockTx {
  readonly hash: Hex;
  readonly from: Address;
  readonly to: Address | null;
  readonly value?: bigint;
}
interface MockLog {
  readonly address: Address;
  readonly topics: readonly Hex[];
  readonly txHash: Hex;
}
interface MockBlock {
  readonly txs?: readonly MockTx[];
  readonly logs?: readonly MockLog[];
}
interface MockOptions {
  /** The endpoint's own head. A block above it does not exist here. */
  readonly head: bigint;
  readonly blocks?: Readonly<Record<string, MockBlock>>;
  /** Override the derived nonce (sent txs in blocks ≤ height); undefined keeps the derived one. */
  readonly nonceAt?: (wallet: Address, block: bigint, derived: number) => number | undefined;
  readonly activeVaultOf?: Readonly<Record<string, Address>>;
  /** Logs the endpoint returns for every eth_getLogs no matter the range asked (a misbehaving provider). */
  readonly spuriousLogs?: readonly { block: bigint; log: MockLog }[];
  readonly failing?: { method: string; error: Error };
}
interface Call {
  readonly method: string;
  readonly params: readonly unknown[];
}
type Recorded = RpcClient & { readonly calls: Call[] };

function mockChain(options: MockOptions): Recorded {
  const calls: Call[] = [];
  const blocks = new Map<bigint, MockBlock>();
  for (const [key, block] of Object.entries(options.blocks ?? {})) blocks.set(BigInt(key), block);

  const rawTx = (t: MockTx, block: bigint, index: number): Record<string, unknown> => ({
    hash: t.hash,
    from: t.from,
    to: t.to,
    value: hex(t.value ?? 0n),
    nonce: hex(index),
    input: "0x",
    transactionIndex: hex(index),
    blockNumber: hex(block),
    blockHash: tx(Number(block)),
    gas: "0x5208",
    gasPrice: "0x1",
    type: "0x2",
    chainId: "0x1237",
  });
  const rawLog = (l: MockLog, block: bigint, index: number): Record<string, unknown> => ({
    address: l.address,
    topics: l.topics,
    data: "0x",
    blockNumber: hex(block),
    transactionHash: l.txHash,
    transactionIndex: "0x0",
    blockHash: tx(Number(block)),
    logIndex: hex(index),
    removed: false,
  });
  const rawBlock = (block: bigint, full: boolean): Record<string, unknown> => {
    const txs = blocks.get(block)?.txs ?? [];
    return {
      number: hex(block),
      hash: tx(Number(block)),
      parentHash: tx(Number(block) - 1),
      timestamp: hex(1_700_000_000n + block),
      l1BlockNumber: hex(block / 120n),
      gasUsed: "0x0",
      gasLimit: "0x1",
      baseFeePerGas: "0x1",
      miner: ZERO,
      transactions: full ? txs.map((t, i) => rawTx(t, block, i)) : txs.map((t) => t.hash),
    };
  };
  const derivedNonce = (wallet: Address, height: bigint): number => {
    let sent = 0;
    for (const [block, b] of blocks) {
      if (block > height) continue;
      for (const t of b.txs ?? []) if (t.from.toLowerCase() === wallet) sent += 1;
    }
    return sent;
  };
  const topicMatches = (want: unknown, have: Hex | undefined): boolean => {
    if (want === null || want === undefined) return true;
    if (have === undefined) return false;
    if (typeof want === "string") return want.toLowerCase() === have.toLowerCase();
    if (Array.isArray(want)) return want.some((w) => typeof w === "string" && w.toLowerCase() === have.toLowerCase());
    return false;
  };
  const addressMatches = (want: unknown, have: Address): boolean => {
    if (want === undefined) return true;
    if (typeof want === "string") return want.toLowerCase() === have;
    if (Array.isArray(want)) return want.some((w) => typeof w === "string" && w.toLowerCase() === have);
    return false;
  };

  return {
    calls,
    async call<T>(method: string, params: readonly unknown[] = []): Promise<T> {
      calls.push({ method, params });
      if (options.failing?.method === method) throw options.failing.error;
      switch (method) {
        case "eth_blockNumber":
          return hex(options.head) as T;
        case "eth_getBlockByNumber": {
          const [tag, full] = params as [string, boolean];
          const block = BigInt(tag);
          if (block > options.head) return null as T;
          return rawBlock(block, full) as T;
        }
        case "eth_getLogs": {
          const [filter] = params as [{ fromBlock: string; toBlock: string; address?: unknown; topics: readonly unknown[] }];
          const from = BigInt(filter.fromBlock);
          const to = BigInt(filter.toBlock);
          const out: Record<string, unknown>[] = [];
          for (const [block, b] of [...blocks.entries()].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) {
            if (block < from || block > to || block > options.head) continue;
            (b.logs ?? []).forEach((l, i) => {
              if (!addressMatches(filter.address, l.address)) return;
              if (!filter.topics.every((want, position) => topicMatches(want, l.topics[position]))) return;
              out.push(rawLog(l, block, i));
            });
          }
          for (const { block, log } of options.spuriousLogs ?? []) out.push(rawLog(log, block, 99));
          return out as T;
        }
        case "eth_getTransactionCount": {
          const [wallet, tag] = params as [Address, string];
          const height = BigInt(tag);
          const derived = derivedNonce(wallet, height);
          return hex(options.nonceAt?.(wallet, height, derived) ?? derived) as T;
        }
        case "eth_call": {
          const [{ to, data }] = params as [{ to: Address; data: Hex }, string];
          if (to.toLowerCase() !== FACTORY || !data.startsWith(ACTIVE_VAULT_OF_SELECTOR)) throw new Error(`mock: unexpected eth_call to ${to}`);
          const account = `0x${data.slice(10 + 24)}`.toLowerCase();
          return word(options.activeVaultOf?.[account] ?? ZERO) as T;
        }
        default:
          throw new Error(`mock: unhandled method ${method}`);
      }
    },
  };
}

const range = (fromBlock: bigint, toBlock: bigint) => ({ fromBlock, toBlock });
const SPAN = { maxLogSpan: 10_000n };
const logsCalls = (chain: Recorded) => chain.calls.filter((c) => c.method === "eth_getLogs");
const fullBlockReads = (chain: Recorded) =>
  chain.calls.filter((c) => c.method === "eth_getBlockByNumber" && (c.params as [string, boolean])[1] === true);
const nonceReads = (chain: Recorded) => chain.calls.filter((c) => c.method === "eth_getTransactionCount");
const filterOf = (call: Call) => (call.params as [{ fromBlock: string; toBlock: string; address?: unknown; topics: readonly unknown[] }])[0];
const keys = (candidates: readonly Candidate[]) => candidates.map((c) => `${c.wallet}|${c.blockL2}|${c.txHash}`);

// ── discover: the Transfer scans ────────────────────────────────────────────

describe("the two Transfer scans", () => {
  it("send every wallet as an OR array in topic[1] (sold) and then in topic[2] (bought), one call each", async () => {
    const chain = mockChain({ head: 300n, blocks: { 150: { txs: [{ hash: tx(1), from: A, to: ROUTER }], logs: [transfer(TOKEN, ROUTER, A, tx(1))] } } });
    await discover(chain, wallets(B, A), range(100n, 200n), SPAN);

    const scans = logsCalls(chain).map(filterOf);
    expect(scans).toHaveLength(2);
    const walletSet = [addressTopic(A), addressTopic(B)];
    expect(scans[0]).toEqual({ fromBlock: "0x64", toBlock: "0xc8", topics: [ERC20_TRANSFER_TOPIC, walletSet, null] });
    expect(scans[1]).toEqual({ fromBlock: "0x64", toBlock: "0xc8", topics: [ERC20_TRANSFER_TOPIC, null, walletSet] });
    // No address filter: the trade can be on any token, that is the point.
    expect(scans[0]).not.toHaveProperty("address");
  });

  it("nominate a block from a 3-topic Transfer and merge every tx the wallet sent or received there", async () => {
    const chain = mockChain({
      head: 300n,
      blocks: {
        150: {
          txs: [
            { hash: tx(1), from: A, to: TOKEN }, // the log-less approve
            { hash: tx(2), from: A, to: ROUTER, value: 10n ** 15n }, // the buy
            { hash: tx(3), from: THIRD, to: ROUTER }, // somebody else's trade
            { hash: tx(4), from: THIRD, to: A, value: 5n }, // a plain inbound send
          ],
          logs: [transfer(TOKEN, ROUTER, A, tx(2)), transfer(TOKEN, ROUTER, THIRD, tx(3))],
        },
      },
    });
    const result = await discover(chain, wallets(A), range(100n, 200n), SPAN);

    expect(keys(result.candidates)).toEqual([`${A}|150|${tx(1)}`, `${A}|150|${tx(2)}`, `${A}|150|${tx(4)}`]);
    expect(result.incompleteWallets).toEqual([]);
    expect(result).toMatchObject({ fromBlock: 100n, toBlock: 200n });
  });

  it("skip 4-topic Transfers: an ERC-721/404 mint is not a token leg", async () => {
    const chain = mockChain({
      head: 300n,
      blocks: {
        150: {
          txs: [{ hash: tx(1), from: THIRD, to: NFT }],
          logs: [{ address: NFT, topics: [ERC20_TRANSFER_TOPIC, addressTopic(ZERO), addressTopic(A), tx(7)], txHash: tx(1) }],
        },
      },
    });
    const result = await discover(chain, wallets(A), range(100n, 200n), SPAN);
    expect(result.candidates).toEqual([]);
    expect(result.incompleteWallets).toEqual([]);
    expect(fullBlockReads(chain)).toHaveLength(0);
  });

  it("exclude WETH: cash changing pockets does not nominate a block", async () => {
    const chain = mockChain({
      head: 300n,
      blocks: { 150: { txs: [{ hash: tx(1), from: THIRD, to: WETH }], logs: [transfer(WETH, THIRD, A, tx(1))] } },
    });
    const result = await discover(chain, wallets(A), range(100n, 200n), SPAN);
    expect(result.candidates).toEqual([]);
    expect(result.incompleteWallets).toEqual([]);
    expect(fullBlockReads(chain)).toHaveLength(0);
  });

  it("still find the wallet's own WETH unwrap — through its nonce, not through its log", async () => {
    const chain = mockChain({
      head: 300n,
      blocks: { 150: { txs: [{ hash: tx(1), from: A, to: WETH }], logs: [transfer(WETH, A, ZERO, tx(1))] } },
    });
    const result = await discover(chain, wallets(A), range(100n, 200n), SPAN);
    expect(keys(result.candidates)).toEqual([`${A}|150|${tx(1)}`]);
    expect(result.incompleteWallets).toEqual([]);
  });

  it("make an airdrop a candidate through the log's own tx, which the wallet neither sent nor received", async () => {
    const chain = mockChain({
      head: 300n,
      blocks: { 150: { txs: [{ hash: tx(1), from: AIRDROPPER, to: TOKEN }], logs: [transfer(TOKEN, AIRDROPPER, A, tx(1))] } },
    });
    const result = await discover(chain, wallets(A), range(100n, 200n), SPAN);
    expect(keys(result.candidates)).toEqual([`${A}|150|${tx(1)}`]);
    expect(result.incompleteWallets).toEqual([]);
  });

  it("deduplicate a sell that arrives from its log and from the block read alike", async () => {
    const chain = mockChain({
      head: 300n,
      blocks: {
        150: {
          txs: [
            { hash: tx(1), from: A, to: TOKEN },
            { hash: tx(2), from: A, to: ROUTER },
          ],
          logs: [transfer(TOKEN, A, ROUTER, tx(2))],
        },
      },
    });
    const result = await discover(chain, wallets(A), range(100n, 200n), SPAN);
    expect(keys(result.candidates)).toEqual([`${A}|150|${tx(1)}`, `${A}|150|${tx(2)}`]);
    expect(fullBlockReads(chain)).toHaveLength(1);
  });

  it("read a block once for every wallet in it, and credit a wallet-to-wallet transfer to both", async () => {
    const chain = mockChain({
      head: 300n,
      blocks: {
        150: {
          txs: [
            { hash: tx(1), from: A, to: TOKEN },
            { hash: tx(2), from: B, to: ROUTER },
          ],
          logs: [transfer(TOKEN, A, B, tx(1)), transfer(TOKEN, ROUTER, B, tx(2))],
        },
        160: { txs: [{ hash: tx(3), from: B, to: ROUTER }], logs: [transfer(TOKEN, B, ROUTER, tx(3))] },
      },
    });
    const result = await discover(chain, wallets(A, B), range(100n, 200n), SPAN);
    expect(keys(result.candidates)).toEqual([`${A}|150|${tx(1)}`, `${B}|150|${tx(1)}`, `${B}|150|${tx(2)}`, `${B}|160|${tx(3)}`]);
    expect(fullBlockReads(chain).map((c) => (c.params as [string])[0])).toEqual(["0x96", "0xa0"]);
    expect(result.incompleteWallets).toEqual([]);
  });

  it("ignore a log the provider returns from outside the range asked for", async () => {
    const chain = mockChain({
      head: 300n,
      spuriousLogs: [{ block: 50n, log: transfer(TOKEN, ROUTER, A, tx(9)) }],
    });
    const result = await discover(chain, wallets(A), range(100n, 200n), SPAN);
    expect(result.candidates).toEqual([]);
    expect(fullBlockReads(chain)).toHaveLength(0);
  });

  it("lowercase every address, whatever case the wallet list or the node used", async () => {
    const mixed = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa" as Address;
    const chain = mockChain({
      head: 300n,
      blocks: { 150: { txs: [{ hash: tx(1), from: mixed, to: ROUTER }], logs: [transfer(TOKEN, ROUTER, A, tx(1))] } },
    });
    const result = await discover(chain, [{ address: mixed, vault: VAULT_A }], range(100n, 200n), SPAN);
    expect(keys(result.candidates)).toEqual([`${A}|150|${tx(1)}`]);
    expect(result.incompleteWallets).toEqual([]);
  });
});

// ── discover: the nonce reconciliation ──────────────────────────────────────

describe("the nonce reconciliation", () => {
  it("reads the nonce just before the range and at its end, for every wallet", async () => {
    const chain = mockChain({ head: 300n });
    await discover(chain, wallets(A, B), range(100n, 200n), SPAN);
    expect(nonceReads(chain).map((c) => c.params)).toEqual([
      [A, "0x63"],
      [A, "0xc8"],
      [B, "0x63"],
      [B, "0xc8"],
    ]);
  });

  it("treats the nonce before block 0 as zero rather than asking for block -1", async () => {
    const chain = mockChain({ head: 300n });
    const result = await discover(chain, wallets(A), range(0n, 200n), SPAN);
    expect(nonceReads(chain).map((c) => c.params)).toEqual([[A, "0xc8"]]);
    expect(result.incompleteWallets).toEqual([]);
  });

  it("locates a log-less native send by bisecting on the nonce instead of leaving the wallet incomplete", async () => {
    const chain = mockChain({ head: 2000n, blocks: { 400: { txs: [{ hash: tx(1), from: A, to: THIRD, value: 10n ** 15n }] } } });
    const result = await discover(chain, wallets(A), range(1n, 1000n), SPAN);

    expect(keys(result.candidates)).toEqual([`${A}|400|${tx(1)}`]);
    expect(result.incompleteWallets).toEqual([]);
    // One block read, and at most 2·log2(span) nonce reads on top of the two the check itself makes.
    expect(fullBlockReads(chain).map((c) => (c.params as [string])[0])).toEqual(["0x190"]);
    expect(nonceReads(chain).length).toBeLessThanOrEqual(2 + 2 * 10);
  });

  it("locates two log-less sends in different blocks", async () => {
    const chain = mockChain({
      head: 2000n,
      blocks: {
        123: { txs: [{ hash: tx(1), from: A, to: THIRD, value: 1n }] },
        877: { txs: [{ hash: tx(2), from: A, to: VAULT_A, value: 2n }] }, // the vault pull looks exactly like this
      },
    });
    const result = await discover(chain, wallets(A), range(1n, 1000n), SPAN);
    expect(keys(result.candidates)).toEqual([`${A}|123|${tx(1)}`, `${A}|877|${tx(2)}`]);
    expect(result.incompleteWallets).toEqual([]);
    expect(fullBlockReads(chain)).toHaveLength(2);
  });

  it("reads every block when bisecting would cost more than that", async () => {
    const chain = mockChain({ head: 300n, blocks: { 102: { txs: [{ hash: tx(1), from: A, to: THIRD, value: 1n }] } } });
    const result = await discover(chain, wallets(A), range(100n, 104n), SPAN);
    expect(keys(result.candidates)).toEqual([`${A}|102|${tx(1)}`]);
    expect(result.incompleteWallets).toEqual([]);
    expect(fullBlockReads(chain).map((c) => (c.params as [string])[0])).toEqual(["0x64", "0x65", "0x66", "0x67", "0x68"]);
    expect(nonceReads(chain)).toHaveLength(2);
  });

  it("flags a wallet whose blocks cannot explain the nonce, and still returns what it found", async () => {
    // The node's nonce jumps by two at block 700, but block 700 holds no tx of
    // A's: a truncated block, or a capped provider. Nothing to attest there.
    const chain = mockChain({
      head: 2000n,
      blocks: {
        400: { txs: [{ hash: tx(1), from: A, to: ROUTER, value: 1n }], logs: [transfer(TOKEN, ROUTER, A, tx(1))] },
        500: { txs: [{ hash: tx(2), from: B, to: ROUTER, value: 1n }], logs: [transfer(TOKEN, ROUTER, B, tx(2))] },
      },
      nonceAt: (wallet, block, derived) => (wallet === A && block >= 700n ? derived + 2 : undefined),
    });
    const result = await discover(chain, wallets(A, B), range(1n, 1000n), SPAN);
    expect(result.incompleteWallets).toEqual([A]);
    expect(keys(result.candidates)).toEqual([`${A}|400|${tx(1)}`, `${B}|500|${tx(2)}`]);
    expect(fullBlockReads(chain).map((c) => (c.params as [string])[0])).toContain("0x2bc");
  });

  it("flags a wallet whose nonce says it sent fewer txs than the blocks show", async () => {
    const chain = mockChain({
      head: 300n,
      blocks: { 150: { txs: [{ hash: tx(1), from: A, to: ROUTER }], logs: [transfer(TOKEN, ROUTER, A, tx(1))] } },
      nonceAt: (wallet) => (wallet === A ? 0 : undefined),
    });
    const result = await discover(chain, wallets(A), range(100n, 200n), SPAN);
    expect(result.incompleteWallets).toEqual([A]);
    expect(keys(result.candidates)).toEqual([`${A}|150|${tx(1)}`]);
  });

  it("does not disturb a complete wallet when another one is incomplete", async () => {
    const chain = mockChain({
      head: 300n,
      blocks: { 150: { txs: [{ hash: tx(1), from: B, to: ROUTER }], logs: [transfer(TOKEN, ROUTER, B, tx(1))] } },
      nonceAt: (wallet, block) => (wallet === A && block === 200n ? 5 : undefined),
    });
    const result = await discover(chain, wallets(A, B), range(100n, 200n), SPAN);
    expect(result.incompleteWallets).toEqual([A]);
    expect(keys(result.candidates)).toEqual([`${B}|150|${tx(1)}`]);
  });
});

// ── discover: edges and failures ────────────────────────────────────────────

describe("discovery edges", () => {
  it("makes no call for an empty wallet set", async () => {
    const chain = mockChain({ head: 300n });
    const result = await discover(chain, [], range(100n, 200n), SPAN);
    expect(result).toEqual({ fromBlock: 100n, toBlock: 200n, candidates: [], incompleteWallets: [] });
    expect(chain.calls).toEqual([]);
  });

  it("makes no call for an inverted range: the head moved backwards", async () => {
    const chain = mockChain({ head: 300n });
    const result = await discover(chain, wallets(A), range(200n, 100n), SPAN);
    expect(result).toEqual({ fromBlock: 200n, toBlock: 100n, candidates: [], incompleteWallets: [] });
    expect(chain.calls).toEqual([]);
  });

  it("is an error, not a quiet wallet, when the endpoint does not have toBlock", async () => {
    const chain = mockChain({ head: 150n, blocks: { 120: { txs: [{ hash: tx(1), from: A, to: ROUTER }], logs: [transfer(TOKEN, ROUTER, A, tx(1))] } } });
    await expect(discover(chain, wallets(A), range(100n, 200n), SPAN)).rejects.toThrow(/does not have block 200/);
  });

  it("propagates an RPC failure instead of reporting no activity", async () => {
    const chain = mockChain({ head: 300n, failing: { method: "eth_getLogs", error: new Error("429 rate limited") } });
    await expect(discover(chain, wallets(A), range(100n, 200n), SPAN)).rejects.toThrow("429 rate limited");
  });

  it("chunks the scans through the chain layer when the range is wider than maxLogSpan", async () => {
    const chain = mockChain({
      head: 300n,
      blocks: {
        105: { txs: [{ hash: tx(1), from: A, to: ROUTER }], logs: [transfer(TOKEN, ROUTER, A, tx(1))] },
        125: { txs: [{ hash: tx(2), from: A, to: ROUTER }], logs: [transfer(TOKEN, A, ROUTER, tx(2))] },
      },
    });
    const result = await discover(chain, wallets(A), range(100n, 124n), { maxLogSpan: 10n });
    const bounds = logsCalls(chain).map((c) => [filterOf(c).fromBlock, filterOf(c).toBlock]);
    expect(bounds).toEqual([
      ["0x64", "0x6d"],
      ["0x6e", "0x77"],
      ["0x78", "0x7c"],
      ["0x64", "0x6d"],
      ["0x6e", "0x77"],
      ["0x78", "0x7c"],
    ]);
    expect(keys(result.candidates)).toEqual([`${A}|105|${tx(1)}`]);
    expect(result.incompleteWallets).toEqual([]);
  });

  it("round-trips an address through its topic and rejects a topic that is not one", () => {
    expect(addressTopic(A)).toBe(`0x000000000000000000000000${A.slice(2)}`);
    expect(topicAddress(addressTopic(A))).toBe(A);
    expect(topicAddress(undefined)).toBeNull();
    // A tokenId or a hash is 32 bytes too; only twelve leading zero bytes make an address.
    expect(topicAddress(`0x01${"0".repeat(62)}`)).toBeNull();
    expect(topicAddress(ERC20_TRANSFER_TOPIC)).toBeNull();
    expect(topicAddress(A)).toBeNull();
  });
});

// ── discover: the recorded mainnet windows ──────────────────────────────────

const FIXTURE_WALLET: Address = "0xc455bf7f16ebbc2b07cb26d1dd46194977974e7d";
const recording = JSON.parse(readFileSync(new URL("./fixtures/mainnet-4663.json", import.meta.url), "utf8")) as Record<string, unknown>;

interface Window {
  readonly from: bigint;
  readonly to: bigint;
  readonly why: string;
  readonly expect: readonly { block: bigint; tx: Hex }[];
}

/** The seven windows the fixture was recorded over, and DESIGN.md §1's truth for each. */
const WINDOWS: readonly Window[] = [
  {
    from: 0x150ec51n,
    to: 0x150ed52n,
    why: "GMGN v3-style buy; approve and sell in one block",
    expect: [
      { block: 22080593n, tx: "0x27259f99e2cbc54ff51e7193e020af3b3f69c021347448da59665c33c2eef882" },
      { block: 22080837n, tx: "0x0688bd572526847b44963792025681b36e02cb42c7ce1470ed2476654ce4570d" },
      { block: 22080837n, tx: "0xc81c59bba769e844ae19cf7b4c7b2e7961334f22018ed70ad3edee6b64fcfb3e" },
    ],
  },
  {
    from: 0x15101f3n,
    to: 0x1510206n,
    why: "the old settle() to the executor: no Transfer log, found by nonce",
    expect: [{ block: 22086139n, tx: "0xd342d117634464f9c6c5b9b463dd8c0be1e638fdf623ea78334a097ad1cad186" }],
  },
  {
    from: 0x14ca315n,
    to: 0x14ca328n,
    why: "airdrop: receipt.from is not the wallet, the log's tx is the candidate",
    expect: [{ block: 21799709n, tx: "0x88d5bf234f12dbdab839baecb602e82892ee8fe42d1fd51b641088d6f2f3e1c9" }],
  },
  {
    from: 0x14c411dn,
    to: 0x14c4126n,
    why: "WETH.withdraw: its log is excluded, its nonce is not",
    expect: [{ block: 21774627n, tx: "0x37ba3063845c5e9bebf760d4aadb19723e9fbd6130e22249df6a06c27559b823" }],
  },
  {
    from: 0x14d5175n,
    to: 0x14d5179n,
    why: "plain outbound 0.0004 ETH: no log, found by nonce",
    expect: [{ block: 21844342n, tx: "0x79f102cb36d09fef851dc9b8d05ebc01e3cf2db00bdf2c7172f6493e8caeaee7" }],
  },
  {
    from: 0x150e425n,
    to: 0x150e42en,
    why: "plain inbound 0.027 ETH: no log and no nonce change — cash, not volume, and invisible here",
    expect: [],
  },
  {
    from: 0x14c73a9n,
    to: 0x14c73f8n,
    why: "GMGN v4 buy; approve and v4 sell in one block",
    expect: [
      { block: 21787563n, tx: "0x5578486de21142788e3affadba58474f3bc37c68121ee232c8e16780513b8ae7" },
      { block: 21787635n, tx: "0x0e5cd4ab4658c2a97eb64f02b42de93529ca9e45750c661621fca7f3eded6db7" },
      { block: 21787635n, tx: "0x9f4590a239fd31553c219e1c019bbebad12aae87a389ab13938aae20bdac2e1e" },
    ],
  },
];

/**
 * The recording, served to a scan that asks with OR arrays. A one-wallet array
 * becomes the string the recorder sent; a trailing wildcard is dropped as the
 * recorder dropped it; a header-only block is derived from its full twin; and a
 * nonce at an unrecorded height inside a window is the recorded nonce before
 * the window plus the wallet's txs in the recorded blocks up to that height.
 */
function fixtureChain(): Recorded {
  const calls: Call[] = [];
  const key = (method: string, params: readonly unknown[]) => `${method}|${JSON.stringify(params)}`;
  const lookup = (method: string, params: readonly unknown[]): unknown => {
    const k = key(method, params);
    if (!(k in recording)) throw new Error(`unrecorded: ${k}`);
    return recording[k];
  };
  const fullBlock = (block: bigint): { transactions: { hash: Hex; from: Address }[] } | undefined =>
    recording[key("eth_getBlockByNumber", [hex(block), true])] as { transactions: { hash: Hex; from: Address }[] } | undefined;

  return {
    calls,
    async call<T>(method: string, params: readonly unknown[] = []): Promise<T> {
      calls.push({ method, params });
      if (method === "eth_getLogs") {
        const [filter] = params as [{ fromBlock: string; toBlock: string; address?: unknown; topics: readonly unknown[] }];
        const topics = filter.topics.map((t) => (Array.isArray(t) && t.length === 1 ? t[0] : t));
        while (topics.length > 0 && topics[topics.length - 1] === null) topics.pop();
        const normalized: Record<string, unknown> = { fromBlock: filter.fromBlock, toBlock: filter.toBlock };
        if (filter.address !== undefined) normalized["address"] = filter.address;
        normalized["topics"] = topics;
        return lookup(method, [normalized]) as T;
      }
      if (method === "eth_getBlockByNumber") {
        const [tag, full] = params as [string, boolean];
        if (key(method, params) in recording) return recording[key(method, params)] as T;
        const twin = full ? undefined : fullBlock(BigInt(tag));
        if (twin === undefined) throw new Error(`unrecorded: ${key(method, params)}`);
        return { ...twin, transactions: twin.transactions.map((t) => t.hash) } as T;
      }
      if (method === "eth_getTransactionCount") {
        if (key(method, params) in recording) return recording[key(method, params)] as T;
        const [wallet, tag] = params as [Address, string];
        const height = BigInt(tag);
        const window = WINDOWS.find((w) => height >= w.from && height <= w.to);
        if (window === undefined) throw new Error(`unrecorded: ${key(method, params)}`);
        let nonce = Number(BigInt(lookup(method, [wallet, hex(window.from - 1n)]) as string));
        for (let block = window.from; block <= height; block += 1n) {
          const b = fullBlock(block);
          if (b === undefined) throw new Error(`unrecorded: ${key("eth_getBlockByNumber", [hex(block), true])}`);
          nonce += b.transactions.filter((t) => t.from.toLowerCase() === wallet).length;
        }
        return hex(nonce) as T;
      }
      return lookup(method, params) as T;
    },
  };
}

describe("the recorded mainnet windows", () => {
  for (const window of WINDOWS) {
    it(`${hex(window.from)}..${hex(window.to)}: ${window.why}`, async () => {
      const chain = fixtureChain();
      const result = await discover(chain, [{ address: FIXTURE_WALLET, vault: VAULT_A }], range(window.from, window.to), SPAN);
      expect(keys(result.candidates)).toEqual(window.expect.map((e) => `${FIXTURE_WALLET}|${e.block}|${e.tx}`));
      expect(result.incompleteWallets).toEqual([]);
    });
  }

  it("never asks the network for anything the recording cannot answer", async () => {
    for (const window of WINDOWS) {
      await expect(discover(fixtureChain(), wallets(FIXTURE_WALLET), range(window.from, window.to), SPAN)).resolves.toBeDefined();
    }
  });
});

// ── discoverLinkedWallets ───────────────────────────────────────────────────

const linked = (account: Address, vault: Address, txHash: Hex): MockLog => ({
  address: FACTORY,
  topics: [TRADING_ACCOUNT_LINKED_TOPIC, addressTopic(account), addressTopic(vault), tx(1)],
  txHash,
});
const unlinked = (account: Address, vault: Address, txHash: Hex): MockLog => ({
  address: FACTORY,
  topics: [TRADING_ACCOUNT_UNLINKED_TOPIC, addressTopic(account), addressTopic(vault), tx(1)],
  txHash,
});

describe("discovering who the worker is responsible for", () => {
  it("finds every linked account and the vault it currently belongs to", async () => {
    const chain = mockChain({
      head: 1000n,
      blocks: { 10: { logs: [linked(B, VAULT_B, tx(1))] }, 20: { logs: [linked(A, VAULT_A, tx(2))] } },
      activeVaultOf: { [A]: VAULT_A, [B]: VAULT_B },
    });
    const result = await discoverLinkedWallets(chain, FACTORY, range(1n, 100n), SPAN);
    expect(result).toEqual([
      { address: A, vault: VAULT_A },
      { address: B, vault: VAULT_B },
    ]);

    const [scan] = logsCalls(chain).map(filterOf);
    expect(scan).toEqual({
      fromBlock: "0x1",
      toBlock: "0x64",
      address: FACTORY,
      topics: [[TRADING_ACCOUNT_LINKED_TOPIC, TRADING_ACCOUNT_UNLINKED_TOPIC]],
    });
    const reads = chain.calls.filter((c) => c.method === "eth_call").map((c) => c.params);
    expect(reads).toEqual([
      [{ to: FACTORY, data: `${ACTIVE_VAULT_OF_SELECTOR}${word(A).slice(2)}` }, "latest"],
      [{ to: FACTORY, data: `${ACTIVE_VAULT_OF_SELECTOR}${word(B).slice(2)}` }, "latest"],
    ]);
  });

  it("drops an account the chain no longer links, however it appeared in the logs", async () => {
    const chain = mockChain({
      head: 1000n,
      blocks: { 10: { logs: [linked(A, VAULT_A, tx(1)), linked(B, VAULT_B, tx(2))] }, 20: { logs: [unlinked(B, VAULT_B, tx(3))] } },
      activeVaultOf: { [A]: VAULT_A },
    });
    expect(await discoverLinkedWallets(chain, FACTORY, range(1n, 100n), SPAN)).toEqual([{ address: A, vault: VAULT_A }]);
  });

  it("keeps an account whose only log in the range is an unlink, when the chain says it is linked again", async () => {
    const chain = mockChain({ head: 1000n, blocks: { 10: { logs: [unlinked(A, VAULT_OLD, tx(1))] } }, activeVaultOf: { [A]: VAULT_A } });
    expect(await discoverLinkedWallets(chain, FACTORY, range(1n, 100n), SPAN)).toEqual([{ address: A, vault: VAULT_A }]);
  });

  it("takes the vault from activeVaultOf, not from the log", async () => {
    const chain = mockChain({ head: 1000n, blocks: { 10: { logs: [linked(A, VAULT_OLD, tx(1))] } }, activeVaultOf: { [A]: VAULT_A } });
    expect(await discoverLinkedWallets(chain, FACTORY, range(1n, 100n), SPAN)).toEqual([{ address: A, vault: VAULT_A }]);
  });

  it("ignores the same events emitted by another contract", async () => {
    const chain = mockChain({
      head: 1000n,
      blocks: { 10: { logs: [{ ...linked(A, VAULT_A, tx(1)), address: ROUTER }] } },
      activeVaultOf: { [A]: VAULT_A },
    });
    expect(await discoverLinkedWallets(chain, FACTORY, range(1n, 100n), SPAN)).toEqual([]);
  });

  it("chunks a range wider than maxLogSpan without losing a link", async () => {
    const chain = mockChain({
      head: 1000n,
      blocks: { 5: { logs: [linked(A, VAULT_A, tx(1))] }, 15: { logs: [linked(B, VAULT_B, tx(2))] }, 25: { logs: [linked(THIRD, VAULT_OLD, tx(3))] } },
      activeVaultOf: { [A]: VAULT_A, [B]: VAULT_B, [THIRD]: VAULT_OLD },
    });
    const result = await discoverLinkedWallets(chain, FACTORY, range(1n, 30n), { maxLogSpan: 10n });
    expect(result.map((w) => w.address)).toEqual([A, B, THIRD]);
    expect(logsCalls(chain).map((c) => [filterOf(c).fromBlock, filterOf(c).toBlock])).toEqual([
      ["0x1", "0xa"],
      ["0xb", "0x14"],
      ["0x15", "0x1e"],
    ]);
  });

  it("is an error, not an empty system, when the factory answers no data", async () => {
    const chain = mockChain({ head: 1000n, blocks: { 10: { logs: [linked(A, VAULT_A, tx(1))] } } });
    const original = chain.call.bind(chain);
    const broken: RpcClient = {
      call: async <T,>(method: string, params?: readonly unknown[]) => (method === "eth_call" ? ("0x" as T) : original<T>(method, params)),
    };
    await expect(discoverLinkedWallets(broken, FACTORY, range(1n, 100n), SPAN)).rejects.toThrow(/returned no data/);
  });

  it("makes no call for an inverted range", async () => {
    const chain = mockChain({ head: 1000n });
    expect(await discoverLinkedWallets(chain, FACTORY, range(100n, 1n), SPAN)).toEqual([]);
    expect(chain.calls).toEqual([]);
  });

  it("uses the event and function selectors the deployed VaultFactory ABI declares", () => {
    const require = createRequire(import.meta.url);
    const artifact = require("@nuvem/contracts-artifacts/artifacts/VaultFactory") as { abi: Abi };
    const event = (name: string): AbiEvent => {
      const item = artifact.abi.find((i) => i.type === "event" && i.name === name);
      if (item === undefined || item.type !== "event") throw new Error(`no event ${name} in VaultFactory ABI`);
      return item;
    };
    const fn = artifact.abi.find((i): i is AbiFunction => i.type === "function" && i.name === "activeVaultOf");
    if (fn === undefined) throw new Error("no activeVaultOf in VaultFactory ABI");

    expect(TRADING_ACCOUNT_LINKED_TOPIC).toBe(toEventSelector(event("TradingAccountLinked")));
    expect(TRADING_ACCOUNT_UNLINKED_TOPIC).toBe(toEventSelector(event("TradingAccountUnlinked")));
    expect(ACTIVE_VAULT_OF_SELECTOR).toBe(toFunctionSelector(fn));
    // Pinned, so a silent ABI change is a red test and not a quiet empty wallet list.
    expect(TRADING_ACCOUNT_LINKED_TOPIC).toBe("0xf4399d99bbb6fe9adcd825701524ba54ab7250bb5525af6180e38a5720e46cbc");
    expect(TRADING_ACCOUNT_UNLINKED_TOPIC).toBe("0x55ff53476233b47a92b08a9dcaf8704c43d725da107611dfe78dc44b66e991a4");
    expect(ACTIVE_VAULT_OF_SELECTOR).toBe("0xb989920e");
  });
});

// ── nextScanFrom ────────────────────────────────────────────────────────────

describe("advancing the factory-scan watermark", () => {
  const deployedAt = 1_000n;

  it("starts at the factory's deployment block when nothing has been scanned", () => {
    expect(nextScanFrom({ deployedAt, scannedTo: null, rescan: 50n })).toBe(deployedAt);
  });

  it("never starts above what was already scanned, at any distance", () => {
    for (const scannedTo of [1_000n, 1_001n, 1_049n, 1_050n, 5_000n, 10n ** 9n]) {
      expect(nextScanFrom({ deployedAt, scannedTo, rescan: 50n })).toBeLessThanOrEqual(scannedTo);
    }
  });

  it("re-reads exactly the overlap once there is room for it", () => {
    expect(nextScanFrom({ deployedAt, scannedTo: 5_000n, rescan: 50n })).toBe(4_950n);
  });

  it("clamps to the deployment block rather than reaching below it", () => {
    expect(nextScanFrom({ deployedAt, scannedTo: 1_020n, rescan: 50n })).toBe(deployedAt);
  });

  it("accepts a zero overlap without stepping over anything", () => {
    expect(nextScanFrom({ deployedAt, scannedTo: 5_000n, rescan: 0n })).toBe(5_000n);
  });
});
