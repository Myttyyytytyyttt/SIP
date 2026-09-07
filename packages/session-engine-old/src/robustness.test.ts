// Regressions for three defects found by sweeping real GMGN trader wallets.
//
// All three shared one property that made them worse than a wrong answer: two
// aborted the scan instead of refusing the window, and the third refused
// nothing at all while quietly stamping a cost basis it had no way to know.
//
// Hand-built fixtures rather than recorded chain data, because each case is
// about one specific byte pattern and a 1.5 MB recording would obscure it.

import { describe, expect, it } from "vitest";
import { erc20BalanceAt, TRANSFER_TOPIC } from "./chain.js";
import { classifyTx } from "./classify.js";
import { fixtureRpcClient, rpcKey, type Recording } from "./rpc.js";
import { scanWindow } from "./window.js";
import type { RawTx } from "./window.js";

const WALLET = "0xc455bf7f16ebbc2b07cb26d1dd46194977974e7d";
const TOKEN_A = "0xaaaa000000000000000000000000000000000001";
const TOKEN_B = "0xbbbb000000000000000000000000000000000002";
const topic = (address: string) => `0x${address.slice(2).padStart(64, "0")}`;

describe("ERC-721 Transfer logs must not abort the scan", () => {
  // ERC-721 shares ERC-20's Transfer topic but puts the tokenId in topics[3]
  // and leaves data empty. Decoding it was BigInt("0x"), a SyntaxError that
  // killed the whole run. It fires on ordinary GMGN buys of tokens that mint an
  // NFT as a side effect, so it is common, not exotic.
  const buildRecording = (): Recording => {
    const block = 100n;
    const recording: Recording = {};
    recording[rpcKey("eth_getBlockByNumber", ["0x64", true])] = {
      transactions: [{ hash: "0xtx", from: WALLET, to: TOKEN_A, value: "0x0", input: "0x4d819a2a" }],
    };
    for (const topics of [
      [TRANSFER_TOPIC, topic(WALLET)],
      [TRANSFER_TOPIC, null, topic(WALLET)],
    ]) {
      recording[rpcKey("eth_getLogs", [{ fromBlock: "0x64", toBlock: "0x64", topics }])] = [];
    }
    recording[rpcKey("eth_getTransactionByHash", ["0xtx"])] = {
      hash: "0xtx", from: WALLET, to: TOKEN_A, value: "0x0", input: "0x4d819a2a",
    };
    recording[rpcKey("eth_getTransactionReceipt", ["0xtx"])] = {
      from: WALLET, status: "0x1", gasUsed: "0x5208", effectiveGasPrice: "0x1",
      logs: [
        // The poison: four topics, empty data.
        { address: TOKEN_B, topics: [TRANSFER_TOPIC, topic(TOKEN_A), topic(WALLET), "0x8b8"], data: "0x" },
        // A normal ERC-20 leg in the same receipt, which must survive.
        { address: TOKEN_A, topics: [TRANSFER_TOPIC, topic(TOKEN_A), topic(WALLET)], data: `0x${(1000n).toString(16).padStart(64, "0")}` },
      ],
    };
    recording[rpcKey("debug_traceTransaction", ["0xtx", { tracer: "callTracer" }])] = { calls: [] };
    recording[rpcKey("eth_getTransactionCount", [WALLET, "0x63"])] = "0x0";
    recording[rpcKey("eth_getTransactionCount", [WALLET, "0x64"])] = "0x1";
    void block;
    return recording;
  };

  it("ignores the non-fungible leg and keeps the fungible one", async () => {
    const scan = await scanWindow(fixtureRpcClient(buildRecording()), WALLET, 99n, 100n);
    expect(scan.txs).toHaveLength(1);
    expect(scan.txs[0]!.tokenMoves).toHaveLength(1);
    expect(scan.txs[0]!.tokenMoves[0]!.token).toBe(TOKEN_A);
    expect(scan.txs[0]!.tokenMoves[0]!.value).toBe(1000n);
  });
});

describe("a token that does not exist yet has a balance of zero", () => {
  // eth_call against an address with no code returns empty data rather than
  // reverting. Traders here buy tokens minted minutes earlier, so a session's
  // opening boundary routinely predates the token's deployment. Throwing there
  // made the correct window for a sniper permanently unrunnable.
  it("reads empty return data as zero rather than throwing", async () => {
    const recording: Recording = {};
    const call = { to: TOKEN_A, data: `0x70a08231${WALLET.slice(2).padStart(64, "0")}` };
    recording[rpcKey("eth_call", [call, "0x64"])] = "0x";
    await expect(erc20BalanceAt(fixtureRpcClient(recording), TOKEN_A, WALLET, 100n)).resolves.toBe(0n);
  });

  it("still decodes a real balance normally", async () => {
    const recording: Recording = {};
    const call = { to: TOKEN_A, data: `0x70a08231${WALLET.slice(2).padStart(64, "0")}` };
    recording[rpcKey("eth_call", [call, "0x64"])] = `0x${(42n).toString(16).padStart(64, "0")}`;
    await expect(erc20BalanceAt(fixtureRpcClient(recording), TOKEN_A, WALLET, 100n)).resolves.toBe(42n);
  });
});

describe("one payment delivering several tokens", () => {
  // Found live: a single GMGN buy that delivered two different tokens. The old
  // rule called it TRADE_BUY and stamped CASH_BASIS on both lots, so selling
  // either one later would report profit it never earned. There is no price
  // available to split the cost, so the only honest answer is to refuse.
  const twoTokenBuy: RawTx = {
    hash: "0xmulti",
    blockNumber: 1n,
    sender: WALLET,
    to: "0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc",
    input: "0x4d819a2a",
    success: true,
    gasPaid: 1000n,
    nativeMoves: [{ from: WALLET, to: "0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc", value: 5_000n, internal: false }],
    tokenMoves: [
      { token: TOKEN_A, from: TOKEN_A, to: WALLET, value: 100n },
      { token: TOKEN_B, from: TOKEN_B, to: WALLET, value: 200n },
    ],
  };

  it("refuses instead of inventing a cost split", () => {
    const classified = classifyTx(twoTokenBuy, WALLET);
    expect(classified.kind).toBe("UNKNOWN");
    expect(classified.note).toMatch(/not divisible/);
  });

  it("still accepts an ordinary single-token buy", () => {
    const single = { ...twoTokenBuy, tokenMoves: [twoTokenBuy.tokenMoves[0]!] };
    expect(classifyTx(single, WALLET).kind).toBe("TRADE_BUY");
  });
});
