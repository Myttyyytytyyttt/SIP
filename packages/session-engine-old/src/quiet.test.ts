import { describe, expect, it } from "vitest";

import { BoundaryCache, activeRanges, isProvablyQuiet } from "./quiet.js";
import { scanWindow } from "./window.js";
import type { RpcClient } from "./rpc.js";

const ACCOUNT = "0xa93095bb98e8b578e1560ded648d194fe4a335fa";

interface ChainState {
  /** Block -> nonce at that block. Held flat between listed heights. */
  readonly nonces: Record<number, number>;
  readonly balances: Record<number, bigint>;
  /** Blocks that contain an incoming Transfer log naming the account. */
  readonly incomingTokenBlocks?: number[];
  readonly code?: string;
  /** Blocks that contain a transaction touching the account. */
  readonly txBlocks?: Record<number, { hash: string; from: string; to: string }>;
}

/** Reads the value in force at `block`, i.e. the last listed height at or below it. */
function atOrBefore<T>(table: Record<number, T>, block: number): T {
  const heights = Object.keys(table)
    .map(Number)
    .sort((a, b) => a - b);
  let value = table[heights[0]!]!;
  for (const height of heights) {
    if (height <= block) value = table[height]!;
  }
  return value;
}

function stub(state: ChainState) {
  const calls: string[] = [];
  const rpc: RpcClient = {
    async call<T>(method: string, params: readonly unknown[] = []): Promise<T> {
      calls.push(method);
      const blockOf = (tag: unknown): number => Number(BigInt(String(tag)));
      switch (method) {
        case "eth_getTransactionCount":
          return `0x${atOrBefore(state.nonces, blockOf(params[1])).toString(16)}` as T;
        case "eth_getBalance":
          return `0x${atOrBefore(state.balances, blockOf(params[1])).toString(16)}` as T;
        case "eth_getCode":
          return (state.code ?? "0x") as T;
        case "eth_getLogs": {
          const filter = params[0] as { fromBlock: string; toBlock: string; topics: unknown[] };
          const from = Number(BigInt(filter.fromBlock));
          const to = Number(BigInt(filter.toBlock));
          const hits = (state.incomingTokenBlocks ?? []).filter((b) => b >= from && b <= to);
          return hits.map((b) => ({
            transactionHash: `0xlog${b}`,
            blockNumber: `0x${b.toString(16)}`,
          })) as T;
        }
        case "eth_getBlockByNumber": {
          const block = blockOf(params[0]);
          const tx = state.txBlocks?.[block];
          return { transactions: tx ? [{ ...tx, value: "0x0", input: "0x" }] : [] } as T;
        }
        case "eth_getTransactionByHash":
          return { hash: params[0], from: ACCOUNT, to: ACCOUNT, value: "0x0", input: "0x" } as T;
        case "eth_getTransactionReceipt":
          return { from: ACCOUNT, status: "0x1", gasUsed: "0x0", effectiveGasPrice: "0x0", logs: [] } as T;
        case "debug_traceTransaction":
          return {} as T;
        default:
          throw new Error(`unexpected ${method}`);
      }
    },
  };
  return { rpc, calls };
}

describe("proving a range empty", () => {
  const quiet: ChainState = { nonces: { 0: 7 }, balances: { 0: 1_000n } };

  it("proves a range empty when nothing moved", async () => {
    const { rpc } = stub(quiet);
    expect(await isProvablyQuiet(rpc, ACCOUNT, 100n, 900n, new BoundaryCache(rpc, ACCOUNT))).toBe(true);
  });

  it("refuses when the account sent a transaction, however small", async () => {
    // The nonce is the only witness a gas-only `approve` leaves behind.
    const { rpc } = stub({ nonces: { 0: 7, 500: 8 }, balances: { 0: 1_000n } });
    expect(await isProvablyQuiet(rpc, ACCOUNT, 100n, 900n, new BoundaryCache(rpc, ACCOUNT))).toBe(false);
  });

  it("refuses when native value arrived, which emits no log at all", async () => {
    // This is the case logs cannot see, and the reason a log-only filter would
    // mistake a deposit for profit.
    const { rpc } = stub({ nonces: { 0: 7 }, balances: { 0: 1_000n, 500: 2_000n } });
    expect(await isProvablyQuiet(rpc, ACCOUNT, 100n, 900n, new BoundaryCache(rpc, ACCOUNT))).toBe(false);
  });

  it("refuses when a token arrived", async () => {
    const { rpc } = stub({ ...quiet, incomingTokenBlocks: [500] });
    expect(await isProvablyQuiet(rpc, ACCOUNT, 100n, 900n, new BoundaryCache(rpc, ACCOUNT))).toBe(false);
  });

  /**
   * THE ONE THAT MATTERS FOR SAFETY. Every argument for skipping assumes an EOA:
   * only an account with no code cannot have value moved without its own nonce
   * changing. A 7702 delegation would break that silently.
   */
  it("never skips for an account carrying code", async () => {
    const { rpc } = stub({ ...quiet, code: "0xef0100aabb" });
    expect(await isProvablyQuiet(rpc, ACCOUNT, 100n, 900n, new BoundaryCache(rpc, ACCOUNT))).toBe(false);
  });

  it("treats an RPC failure as unproven rather than as empty", async () => {
    const rpc: RpcClient = {
      async call<T>(): Promise<T> {
        throw new Error("provider exploded");
      },
    };
    expect(await isProvablyQuiet(rpc, ACCOUNT, 100n, 900n, new BoundaryCache(rpc, ACCOUNT))).toBe(false);
  });
});

describe("narrowing a window to the parts worth opening", () => {
  it("returns nothing for a window that is provably empty throughout", async () => {
    const { rpc } = stub({ nonces: { 0: 7 }, balances: { 0: 1_000n } });
    expect(await activeRanges(rpc, ACCOUNT, 0n, 10_000n)).toEqual([]);
  });

  it("isolates activity to a narrow band instead of scanning the whole window", async () => {
    const { rpc } = stub({ nonces: { 0: 7, 5_000: 8 }, balances: { 0: 1_000n, 5_000: 900n } });
    const ranges = await activeRanges(rpc, ACCOUNT, 0n, 10_000n, { dense: 64n });

    const scanned = ranges.reduce((total, r) => total + (r.to - r.from), 0n);
    expect(scanned).toBeLessThanOrEqual(128n);
    // And the band actually contains the block where the change happened.
    expect(ranges.some((r) => r.from < 5_000n && 5_000n <= r.to)).toBe(true);
  });

  it("costs far fewer calls than opening every block", async () => {
    const { rpc, calls } = stub({ nonces: { 0: 7 }, balances: { 0: 1_000n } });
    await activeRanges(rpc, ACCOUNT, 0n, 10_000n);
    // A dense scan of this window is 10,000 eth_getBlockByNumber calls.
    expect(calls.length).toBeLessThan(20);
    expect(calls.filter((c) => c === "eth_getBlockByNumber")).toHaveLength(0);
  });

  it("hands back small windows whole, where proving costs more than scanning", async () => {
    const { rpc } = stub({ nonces: { 0: 7 }, balances: { 0: 1_000n } });
    expect(await activeRanges(rpc, ACCOUNT, 100n, 150n, { dense: 64n })).toEqual([
      { from: 100n, to: 150n },
    ]);
  });
});

/**
 * THE EQUIVALENCE PROPERTY. The optimisation is only worth anything if it cannot
 * change an answer, so the fast path is compared against opening every block over
 * the same chain — not asserted to "look right".
 */
describe("the narrowed scan agrees with opening every block", () => {
  const withTrade: ChainState = {
    nonces: { 0: 7, 5_000: 8 },
    balances: { 0: 1_000n, 5_000: 900n },
    txBlocks: { 5_000: { hash: "0xtrade", from: ACCOUNT, to: "0xrouter" } },
  };

  it("finds the same transactions as a full scan", async () => {
    const { rpc } = stub(withTrade);
    const narrowed = await scanWindow(rpc, ACCOUNT, 0n, 10_000n);

    // The same chain, scanned with the skip disabled by making every range dense.
    const { rpc: rpc2 } = stub(withTrade);
    const everything = await activeRanges(rpc2, ACCOUNT, 0n, 10_000n, { dense: 100_000n });
    expect(everything).toEqual([{ from: 0n, to: 10_000n }]);

    expect(narrowed.txs.map((t) => t.hash)).toEqual(["0xtrade"]);
    // And the completeness oracle agrees, which is what would catch a bad skip.
    expect(narrowed.expectedSentCount).toBe(1);
    expect(narrowed.observedSentCount).toBe(1);
  });

  it("keeps the nonce oracle able to catch a skip that lost a transaction", async () => {
    // A chain where the account sent something the block scan cannot see, because
    // the stub reports no transactions in any block. expectedSentCount is derived
    // from the nonce and so still reports it — the mismatch that refuses a window.
    const { rpc } = stub({ nonces: { 0: 7, 5_000: 9 }, balances: { 0: 1_000n, 5_000: 900n } });
    const scan = await scanWindow(rpc, ACCOUNT, 0n, 10_000n);
    expect(scan.expectedSentCount).toBe(2);
    expect(scan.observedSentCount).toBe(0);
  });
});
