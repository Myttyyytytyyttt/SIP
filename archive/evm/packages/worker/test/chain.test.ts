// Owner: chain. Every read decodes against the recorded mainnet fixture; the
// chunking and coverage rules run against a scripted RpcClient because the
// fixture was recorded one wallet at a time with a single span.

import { readFileSync } from "node:fs";
import { isAddress, toEventSelector } from "viem";
import { describe, expect, it } from "vitest";

import {
  BALANCE_OF_SELECTOR,
  CHAIN_ID,
  ERC20_TRANSFER_TOPIC,
  FACTORY_LINKED_TOPIC,
  FACTORY_UNLINKED_TOPIC,
  GMGN_FEE_TOPIC,
  GMGN_FILL_TOPIC,
  GMGN_ROUTER,
  UNISWAP_V4_POOL_MANAGER,
  WETH,
  ZERO_ADDRESS,
  ZERO_TOPIC,
  addressTopic,
  addressWord,
  hexToBigInt,
  isHex,
  normalizeAddress,
  toBlockTag,
  topicAddress,
} from "../src/chain/constants.js";
import {
  ChainReadError,
  CoverageError,
  blockNumber,
  blockTransactions,
  erc20BalanceAt,
  getLogs,
  hasCodeAt,
  l1BlockOf,
  nativeBalanceAt,
  nonceAt,
  receipt,
  transaction,
  wethBalanceAt,
} from "../src/chain/reads.js";
import type { Address, Hex, Recording, RpcClient, RpcLog, RpcParams } from "../src/types.js";

// ── harness ─────────────────────────────────────────────────────────────────

const recording = JSON.parse(readFileSync(new URL("./fixtures/mainnet-4663.json", import.meta.url), "utf8")) as Recording;

/** Mirrors rpc/client.ts `rpcKey` so this file does not depend on another owner's progress. */
const keyOf = (method: string, params: RpcParams): string => `${method}|${JSON.stringify(params)}`;

function fixtureClient(): RpcClient & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async call<T>(method: string, params: RpcParams = []): Promise<T> {
      const key = keyOf(method, params);
      calls.push(key);
      if (!(key in recording)) throw new Error(`unrecorded: ${key}`);
      return recording[key] as T;
    },
  };
}

interface Call {
  readonly method: string;
  readonly params: RpcParams;
}

function scripted(answer: (method: string, params: RpcParams) => unknown): RpcClient & { readonly calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async call<T>(method: string, params: RpcParams = []): Promise<T> {
      calls.push({ method, params });
      return answer(method, params) as T;
    },
  };
}

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no item at ${index}`);
  return item;
}

const rawBlock = (tag: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  number: tag,
  l1BlockNumber: "0x1",
  transactions: [],
  ...extra,
});

const rawLog = (block: bigint, logIndex: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  address: "0x3792DAEF78E7C652C8ADE7D1AD64FD398ED80056",
  topics: [ERC20_TRANSFER_TOPIC],
  data: "0x",
  blockNumber: toBlockTag(block),
  transactionHash: `0x${block.toString(16).padStart(60, "0")}${logIndex.toString(16).padStart(4, "0")}`,
  logIndex: `0x${logIndex.toString(16)}`,
  ...extra,
});

/** Answers every block, unless it is listed as missing (null, the way geth says "I do not have it"). */
const nodeWithLogs = (logsFor: (from: bigint, to: bigint) => unknown[], missing: readonly bigint[] = []) =>
  scripted((method, params) => {
    if (method === "eth_getBlockByNumber") {
      const tag = at(params, 0);
      if (typeof tag !== "string") throw new Error("bad tag");
      return missing.includes(hexToBigInt(tag)) ? null : rawBlock(tag);
    }
    if (method === "eth_getLogs") {
      const filter = at(params, 0) as { fromBlock: string; toBlock: string };
      return logsFor(hexToBigInt(filter.fromBlock), hexToBigInt(filter.toBlock));
    }
    throw new Error(`unexpected ${method}`);
  });

const logRanges = (client: { readonly calls: Call[] }): [string, string][] =>
  client.calls
    .filter((c) => c.method === "eth_getLogs")
    .map((c) => {
      const filter = at(c.params, 0) as { fromBlock: string; toBlock: string };
      return [filter.fromBlock, filter.toBlock];
    });

// ── the recorded facts (DESIGN.md §1) ───────────────────────────────────────

const WALLET: Address = "0xc455bf7f16ebbc2b07cb26d1dd46194977974e7d";
const WALLET_TOPIC = "0x000000000000000000000000c455bf7f16ebbc2b07cb26d1dd46194977974e7d";

const BUY_V3 = "0x27259f99e2cbc54ff51e7193e020af3b3f69c021347448da59665c33c2eef882" as const;
const SELL_V3 = "0x0688bd572526847b44963792025681b36e02cb42c7ce1470ed2476654ce4570d" as const;
const APPROVE_V3 = "0xc81c59bba769e844ae19cf7b4c7b2e7961334f22018ed70ad3edee6b64fcfb3e" as const;
const BUY_V4 = "0x5578486de21142788e3affadba58474f3bc37c68121ee232c8e16780513b8ae7" as const;
const AIRDROP = "0x88d5bf234f12dbdab839baecb602e82892ee8fe42d1fd51b641088d6f2f3e1c9" as const;

const BUY_V3_BLOCK = 22080593n; // 0x150ec51
const SELL_V3_BLOCK = 22080837n; // 0x150ed45, shared with APPROVE_V3
const V3_RANGE = { fromBlock: 22080593n, toBlock: 22080850n }; // 0x150ec51..0x150ed52
const V4_RANGE = { fromBlock: 21787561n, toBlock: 21787640n }; // 0x14c73a9..0x14c73f8
const SELL_V4_BLOCK = 21787635n; // 0x14c73f3, shared with its approve
const WITHDRAW_BLOCK = 21774627n; // 0x14c4123, WETH.withdraw 2.5e15
const INBOUND_BLOCK = 22078504n; // 0x150e428, plain inbound 0.027 ETH

// ── constants ───────────────────────────────────────────────────────────────

describe("chain/constants", () => {
  it("pins chain 4663 and lowercase, valid addresses", () => {
    expect(CHAIN_ID).toBe(4663);
    for (const address of [
      WETH,
      GMGN_ROUTER,
      UNISWAP_V4_POOL_MANAGER,
      ZERO_ADDRESS,
    ]) {
      expect(isAddress(address)).toBe(true);
      expect(address).toBe(address.toLowerCase());
    }
  });

  it("topics are 32-byte hex and the event selectors match viem", () => {
    for (const topic of [ERC20_TRANSFER_TOPIC, GMGN_FILL_TOPIC, GMGN_FEE_TOPIC, FACTORY_LINKED_TOPIC, FACTORY_UNLINKED_TOPIC, ZERO_TOPIC]) {
      expect(isHex(topic)).toBe(true);
      expect(topic).toHaveLength(66);
    }
    expect(ERC20_TRANSFER_TOPIC).toBe(toEventSelector("Transfer(address,address,uint256)"));
    expect(FACTORY_LINKED_TOPIC).toBe(toEventSelector("TradingAccountLinked(address,address,bytes32)"));
    expect(FACTORY_UNLINKED_TOPIC).toBe(toEventSelector("TradingAccountUnlinked(address,address,bytes32)"));
    expect(BALANCE_OF_SELECTOR).toBe("0x70a08231");
  });

  it("GMGN FILL and FEE topics are the ones the router emitted for the recorded buy", async () => {
    const r = await receipt(fixtureClient(), BUY_V3);
    const fromRouter = r.logs.filter((log) => log.address === GMGN_ROUTER);
    const fill = fromRouter.find((log) => log.topics[0] === GMGN_FILL_TOPIC);
    const fee = fromRouter.find((log) => log.topics[0] === GMGN_FEE_TOPIC);
    if (fill === undefined || fee === undefined) throw new Error("router logs missing");
    // FILL: topics [sig, wallet, wallet, 0x0]; w00 = amountIn = tx.value.
    expect(fill.topics).toEqual([GMGN_FILL_TOPIC, WALLET_TOPIC, WALLET_TOPIC, ZERO_TOPIC]);
    expect(hexToBigInt(fill.data.slice(0, 66))).toBe(20_000_000_000_000_000n);
    expect((fill.data.length - 2) / 64).toBe(16);
    // FEE: topics [sig, 0x0, wallet]; w00 = fee wei.
    expect(fee.topics).toEqual([GMGN_FEE_TOPIC, ZERO_TOPIC, WALLET_TOPIC]);
    expect(hexToBigInt(fee.data.slice(0, 66))).toBe(200_000_000_000_000n);
    expect((fee.data.length - 2) / 64).toBe(2);
  });

  it("WETH is the contract the recorded withdraw was sent to", async () => {
    const txs = await blockTransactions(fixtureClient(), WITHDRAW_BLOCK);
    const withdraw = txs.find((tx) => tx.hash.startsWith("0x37ba3063"));
    expect(withdraw?.to).toBe(WETH);
    expect(withdraw?.from).toBe(WALLET);
  });

  it("hexToBigInt decodes quantities and refuses non-quantities", () => {
    expect(hexToBigInt("0x0")).toBe(0n);
    expect(hexToBigInt("0xff")).toBe(255n);
    expect(hexToBigInt("0x150ed52")).toBe(22080850n);
    expect(hexToBigInt("0x6d0a1c54e7a666")).toBe(30_691_889_261_291_110n);
    expect(() => hexToBigInt("0x")).toThrow(TypeError);
    expect(() => hexToBigInt("12")).toThrow(TypeError);
    expect(() => hexToBigInt("0xzz")).toThrow(TypeError);
  });

  it("toBlockTag is unpadded lowercase hex and refuses negatives", () => {
    expect(toBlockTag(0n)).toBe("0x0");
    expect(toBlockTag(22080850n)).toBe("0x150ed52");
    expect(() => toBlockTag(-1n)).toThrow(RangeError);
  });

  it("normalizeAddress lowercases and validates", () => {
    expect(normalizeAddress("0xc455bF7f16ebbc2b07cb26D1Dd46194977974E7d")).toBe(WALLET);
    expect(() => normalizeAddress("0x1234")).toThrow(TypeError);
    expect(() => normalizeAddress("c455bf7f16ebbc2b07cb26d1dd46194977974e7d")).toThrow(TypeError);
  });

  it("addressTopic/topicAddress round-trip and match the recorded getLogs filter", () => {
    expect(addressTopic(WALLET)).toBe(WALLET_TOPIC);
    expect(addressTopic("0xc455bF7f16ebbc2b07cb26D1Dd46194977974E7d")).toBe(WALLET_TOPIC);
    expect(addressWord(WALLET)).toBe(WALLET_TOPIC.slice(2));
    expect(topicAddress(WALLET_TOPIC)).toBe(WALLET);
    expect(topicAddress(ZERO_TOPIC)).toBe(ZERO_ADDRESS);
    expect(() => topicAddress("0x1234")).toThrow(TypeError);
    expect(keyOf("eth_getLogs", [{ fromBlock: "0x150ec51", toBlock: "0x150ed52", topics: [ERC20_TRANSFER_TOPIC, WALLET_TOPIC] }]) in recording).toBe(true);
  });
});

// ── decoding ────────────────────────────────────────────────────────────────

describe("chain/reads decoding", () => {
  it("blockNumber decodes the head as bigint", async () => {
    const rpc = scripted(() => "0x150ed52");
    expect(await blockNumber(rpc)).toBe(22080850n);
    expect(rpc.calls).toEqual([{ method: "eth_blockNumber", params: [] }]);
  });

  it("l1BlockOf reads l1BlockNumber from the recorded block", async () => {
    const rpc = fixtureClient();
    expect(await l1BlockOf(rpc, 22080850n)).toBe(25635384n);
    expect(await l1BlockOf(rpc, 21787640n)).toBe(25632945n);
    expect(rpc.calls).toEqual([keyOf("eth_getBlockByNumber", ["0x150ed52", false]), keyOf("eth_getBlockByNumber", ["0x14c73f8", false])]);
  });

  it("l1BlockOf refuses a missing block, a block without l1BlockNumber, and the wrong block", async () => {
    await expect(l1BlockOf(scripted(() => null), 5n)).rejects.toThrow(ChainReadError);
    await expect(l1BlockOf(scripted((_m, p) => ({ number: at(p, 0), transactions: [] })), 5n)).rejects.toThrow(/Arbitrum Nitro/);
    await expect(l1BlockOf(scripted(() => rawBlock("0x4")), 5n)).rejects.toThrow(/answered with block 4/);
  });

  it("nativeBalanceAt decodes wei at the requested height", async () => {
    const rpc = fixtureClient();
    expect(await nativeBalanceAt(rpc, WALLET, 22080850n)).toBe(30_691_889_261_291_110n);
    expect(await nativeBalanceAt(rpc, WALLET, 22080592n)).toBe(28_675_034_813_797_372n);
    expect(rpc.calls[0]).toBe(keyOf("eth_getBalance", [WALLET, "0x150ed52"]));
  });

  it("wethBalanceAt reads balanceOf on canonical WETH; the withdraw block moves it by exactly 2.5e15", async () => {
    const rpc = fixtureClient();
    expect(await wethBalanceAt(rpc, WALLET, 22080592n)).toBe(2_554_927_094_374_287n);
    const before = await wethBalanceAt(rpc, WALLET, WITHDRAW_BLOCK - 7n); // 0x14c411c, the recorded N-1 of that range
    const after = await wethBalanceAt(rpc, WALLET, WITHDRAW_BLOCK + 3n); // 0x14c4126
    expect(before - after).toBe(2_500_000_000_000_000n);
    expect(rpc.calls[0]).toBe(keyOf("eth_call", [{ to: WETH, data: `${BALANCE_OF_SELECTOR}${WALLET_TOPIC.slice(2)}` }, "0x150ec50"]));
  });

  it("erc20BalanceAt: empty return data is zero, and the address is lowercased into the call", async () => {
    const rpc = scripted(() => "0x");
    const token: Address = "0x3792daef78e7c652c8ade7d1ad64fd398ed80056";
    expect(await erc20BalanceAt(rpc, token, "0xc455bF7f16ebbc2b07cb26D1Dd46194977974E7d", 7n)).toBe(0n);
    expect(rpc.calls).toEqual([{ method: "eth_call", params: [{ to: token, data: `${BALANCE_OF_SELECTOR}${WALLET_TOPIC.slice(2)}` }, "0x7"] }]);
    expect(await erc20BalanceAt(scripted(() => ""), token, WALLET, 7n)).toBe(0n);
    expect(await erc20BalanceAt(scripted(() => "0x000000000000000000000000000000000000000000000000000913b151e31f8f"), token, WALLET, 7n)).toBe(
      2_554_927_094_374_287n,
    );
    await expect(erc20BalanceAt(scripted(() => "nope"), token, WALLET, 7n)).rejects.toThrow(ChainReadError);
  });

  it("nonceAt: the delta over a range equals the sent transactions in the truth table", async () => {
    const rpc = fixtureClient();
    // v3 range: buy, approve, sell — three sent.
    expect(await nonceAt(rpc, WALLET, V3_RANGE.fromBlock - 1n)).toBe(71);
    expect(await nonceAt(rpc, WALLET, V3_RANGE.toBlock)).toBe(74);
    // v4 range: buy, approve, sell — three sent.
    expect(await nonceAt(rpc, WALLET, V4_RANGE.fromBlock - 1n)).toBe(55);
    expect(await nonceAt(rpc, WALLET, V4_RANGE.toBlock)).toBe(58);
    expect(rpc.calls[0]).toBe(keyOf("eth_getTransactionCount", [WALLET, "0x150ec50"]));
  });

  it("hasCodeAt: empty code is false; bytecode or an EIP-7702 delegation is true", async () => {
    expect(await hasCodeAt(scripted(() => "0x"), WALLET, 1n)).toBe(false);
    expect(await hasCodeAt(scripted(() => "0x6080604052"), WALLET, 1n)).toBe(true);
    expect(await hasCodeAt(scripted(() => `0xef0100${WALLET.slice(2)}`), WALLET, 1n)).toBe(true);
    await expect(hasCodeAt(scripted(() => null), WALLET, 1n)).rejects.toThrow(ChainReadError);
    const rpc = scripted(() => "0x");
    await hasCodeAt(rpc, "0xc455bF7f16ebbc2b07cb26D1Dd46194977974E7d", 22080850n);
    expect(rpc.calls).toEqual([{ method: "eth_getCode", params: [WALLET, "0x150ed52"] }]);
  });

  it("blockTransactions: the sell block holds the approve and the sell, in index order, fully typed", async () => {
    const txs = await blockTransactions(fixtureClient(), SELL_V3_BLOCK);
    expect(txs.map((tx) => tx.hash)).toEqual([APPROVE_V3, SELL_V3]);
    const approve = at(txs, 0);
    expect(approve).toEqual({
      hash: APPROVE_V3,
      from: WALLET,
      to: "0x3792daef78e7c652c8ade7d1ad64fd398ed80056",
      value: 0n,
      nonce: 72,
      input: approve.input,
      transactionIndex: 6,
      blockNumber: SELL_V3_BLOCK,
    });
    expect(approve.input.startsWith("0x095ea7b3")).toBe(true); // approve(address,uint256)
    const sell = at(txs, 1);
    expect(sell.to).toBe(GMGN_ROUTER);
    expect(sell.value).toBe(0n);
    expect(sell.nonce).toBe(73);
    expect(sell.transactionIndex).toBe(7);
  });

  it("blockTransactions: the v4 sell block and the plain inbound send decode to the truth table", async () => {
    const rpc = fixtureClient();
    const v4 = await blockTransactions(rpc, SELL_V4_BLOCK);
    expect(v4.map((tx) => [tx.hash.slice(0, 10), tx.transactionIndex, tx.nonce])).toEqual([
      ["0x9f4590a2", 53, 56],
      ["0x0e5cd4ab", 54, 57],
    ]);
    const inbound = await blockTransactions(rpc, INBOUND_BLOCK);
    const send = inbound.find((tx) => tx.to === WALLET);
    expect(send?.hash.startsWith("0xfdbaab69")).toBe(true);
    expect(send?.from).not.toBe(WALLET);
    expect(send?.value).toBe(27_000_000_000_000_000n);
  });

  it("blockTransactions sorts by index, keeps a null `to`, and refuses a missing block", async () => {
    const tx = (index: number, to: string | null) => ({
      hash: `0x${index.toString(16).padStart(64, "0")}`,
      from: "0xC455bF7f16ebbc2b07cb26D1Dd46194977974E7d",
      to,
      value: "0x0",
      nonce: "0x1",
      input: "0x",
      transactionIndex: `0x${index.toString(16)}`,
      blockNumber: "0x5",
    });
    const rpc = scripted(() => rawBlock("0x5", { transactions: [tx(9, null), tx(2, WALLET)] }));
    const txs = await blockTransactions(rpc, 5n);
    expect(txs.map((t) => t.transactionIndex)).toEqual([2, 9]);
    expect(at(txs, 1).to).toBeNull();
    expect(at(txs, 0).from).toBe(WALLET);
    expect(rpc.calls).toEqual([{ method: "eth_getBlockByNumber", params: ["0x5", true] }]);
    await expect(blockTransactions(scripted(() => null), 5n)).rejects.toThrow(/not available/);
    await expect(blockTransactions(scripted(() => rawBlock("0x5", { transactions: "0xabc" })), 5n)).rejects.toThrow(ChainReadError);
  });

  it("receipt decodes the v3 sell: success, gas terms, six logs led by the WETH transfer", async () => {
    const r = await receipt(fixtureClient(), SELL_V3);
    expect(r.transactionHash).toBe(SELL_V3);
    expect(r.from).toBe(WALLET);
    expect(r.to).toBe(GMGN_ROUTER);
    expect(r.status).toBe("success");
    expect(r.gasUsed).toBe(188_011n);
    expect(r.effectiveGasPrice).toBe(27_848_000n);
    expect(r.blockNumber).toBe(SELL_V3_BLOCK);
    expect(r.logs).toHaveLength(6);
    const first = at(r.logs, 0);
    expect(first.address).toBe(WETH);
    expect(first.logIndex).toBe(53);
    expect(first.blockNumber).toBe(SELL_V3_BLOCK);
    expect(first.transactionHash).toBe(SELL_V3);
    expect(first.topics[0]).toBe(ERC20_TRANSFER_TOPIC);
    // The sell's token leg: a 3-topic Transfer with the wallet in topics[1].
    const leg = r.logs.find((log) => log.address !== WETH && log.topics[0] === ERC20_TRANSFER_TOPIC && log.topics[1] === WALLET_TOPIC);
    expect(leg?.topics).toHaveLength(3);
  });

  it("receipt: the airdrop was not sent by the wallet and carries 239 logs", async () => {
    const r = await receipt(fixtureClient(), AIRDROP);
    expect(r.from).not.toBe(WALLET);
    expect(r.logs).toHaveLength(239);
    expect(r.blockNumber).toBe(21799709n);
  });

  it("receipt: reverted status, unknown status, and no receipt", async () => {
    const raw = (status: unknown) => ({
      transactionHash: SELL_V3,
      from: WALLET,
      to: null,
      status,
      gasUsed: "0x1",
      effectiveGasPrice: "0x2",
      logs: [],
      blockNumber: "0x3",
    });
    const reverted = await receipt(scripted(() => raw("0x0")), SELL_V3);
    expect(reverted.status).toBe("reverted");
    expect(reverted.to).toBeNull();
    await expect(receipt(scripted(() => raw("0x2")), SELL_V3)).rejects.toThrow(ChainReadError);
    await expect(receipt(scripted(() => null), SELL_V3)).rejects.toThrow(/pending or unknown/);
  });

  it("transaction decodes the v3 buy: value is the notional in the truth table", async () => {
    const tx = await transaction(fixtureClient(), BUY_V3);
    expect(tx.hash).toBe(BUY_V3);
    expect(tx.from).toBe(WALLET);
    expect(tx.to).toBe(GMGN_ROUTER);
    expect(tx.value).toBe(20_000_000_000_000_000n);
    expect(tx.nonce).toBe(71);
    expect(tx.transactionIndex).toBe(1);
    expect(tx.blockNumber).toBe(BUY_V3_BLOCK);
    expect(tx.input.startsWith("0x4d819a2a")).toBe(true);
    const v4 = await transaction(fixtureClient(), BUY_V4);
    expect(v4.value).toBe(1_000_000_000_000_000n);
    expect(v4.blockNumber).toBe(21787563n);
  });

  it("transaction refuses an unknown hash and a pending (unmined) shape", async () => {
    await expect(transaction(scripted(() => null), BUY_V3)).rejects.toThrow(ChainReadError);
    const pending = { hash: BUY_V3, from: WALLET, to: WALLET, value: "0x0", nonce: "0x1", input: "0x", transactionIndex: null, blockNumber: null };
    await expect(transaction(scripted(() => pending), BUY_V3)).rejects.toThrow(/transactionIndex/);
  });

  it("decoded addresses are lowercase even when the node checksums them", async () => {
    const rpc = scripted(() => [rawLog(5n, 1)]);
    const logs = await getLogsSingle(rpc);
    expect(at(logs, 0).address).toBe("0x3792daef78e7c652c8ade7d1ad64fd398ed80056");
  });
});

/** One chunk over a one-block range, for tests about log shape rather than chunking. */
async function getLogsSingle(rpc: RpcClient): Promise<readonly RpcLog[]> {
  const answering = scripted((method, params) => (method === "eth_getBlockByNumber" ? rawBlock(at(params, 0)) : rpc.call(method, params)));
  return getLogs(answering, { fromBlock: 5n, toBlock: 5n, topics: [ERC20_TRANSFER_TOPIC] }, 10n);
}

// ── getLogs: fixture ────────────────────────────────────────────────────────

describe("chain/reads getLogs against the fixture", () => {
  it("finds the v3 sell leg (wallet in topics[1]) after proving coverage of toBlock", async () => {
    const rpc = fixtureClient();
    const logs = await getLogs(rpc, { ...V3_RANGE, topics: [ERC20_TRANSFER_TOPIC, WALLET_TOPIC] }, 10_000n);
    expect(logs).toHaveLength(1);
    const leg = at(logs, 0);
    expect(leg.transactionHash).toBe(SELL_V3);
    expect(leg.blockNumber).toBe(SELL_V3_BLOCK);
    expect(leg.logIndex).toBe(54);
    expect(leg.address).toBe("0x3792daef78e7c652c8ade7d1ad64fd398ed80056");
    expect(leg.topics).toHaveLength(3);
    expect(rpc.calls).toEqual([
      keyOf("eth_getBlockByNumber", ["0x150ed52", false]),
      keyOf("eth_getLogs", [{ fromBlock: "0x150ec51", toBlock: "0x150ed52", topics: [ERC20_TRANSFER_TOPIC, WALLET_TOPIC] }]),
    ]);
  });

  it("finds the v3 buy leg (wallet in topics[2])", async () => {
    const logs = await getLogs(fixtureClient(), { ...V3_RANGE, topics: [ERC20_TRANSFER_TOPIC, null, WALLET_TOPIC] }, 10_000n);
    expect(logs.map((log) => [log.transactionHash, log.blockNumber, log.logIndex])).toEqual([[BUY_V3, BUY_V3_BLOCK, 2]]);
  });

  it("finds both v4 legs in their range", async () => {
    const rpc = fixtureClient();
    const sells = await getLogs(rpc, { ...V4_RANGE, topics: [ERC20_TRANSFER_TOPIC, WALLET_TOPIC] }, 10_000n);
    const buys = await getLogs(rpc, { ...V4_RANGE, topics: [ERC20_TRANSFER_TOPIC, null, WALLET_TOPIC] }, 10_000n);
    expect(sells.map((log) => [log.transactionHash.slice(0, 10), log.blockNumber, log.logIndex])).toEqual([["0x0e5cd4ab", SELL_V4_BLOCK, 48]]);
    expect(buys.map((log) => [log.transactionHash, log.blockNumber, log.logIndex])).toEqual([[BUY_V4, 21787563n, 44]]);
    expect(at(sells, 0).address).toBe(at(buys, 0).address);
  });
});

// ── getLogs: chunking and coverage ──────────────────────────────────────────

describe("chain/reads getLogs chunking", () => {
  it("a 25,000-block range at maxSpan 10,000 is three calls with exact bounds, each behind a coverage check", async () => {
    const rpc = nodeWithLogs(() => []);
    const logs = await getLogs(rpc, { fromBlock: 0n, toBlock: 24_999n, topics: [ERC20_TRANSFER_TOPIC] }, 10_000n);
    expect(logs).toEqual([]);
    expect(logRanges(rpc)).toEqual([
      ["0x0", "0x270f"],
      ["0x2710", "0x4e1f"],
      ["0x4e20", "0x61a7"],
    ]);
    expect(rpc.calls.map((c) => [c.method, at(c.params, 0)])).toEqual([
      ["eth_getBlockByNumber", "0x270f"],
      ["eth_getLogs", { fromBlock: "0x0", toBlock: "0x270f", topics: [ERC20_TRANSFER_TOPIC] }],
      ["eth_getBlockByNumber", "0x4e1f"],
      ["eth_getLogs", { fromBlock: "0x2710", toBlock: "0x4e1f", topics: [ERC20_TRANSFER_TOPIC] }],
      ["eth_getBlockByNumber", "0x61a7"],
      ["eth_getLogs", { fromBlock: "0x4e20", toBlock: "0x61a7", topics: [ERC20_TRANSFER_TOPIC] }],
    ]);
    expect(rpc.calls.filter((c) => c.method === "eth_getBlockByNumber").every((c) => at(c.params, 1) === false)).toBe(true);
  });

  it("an exact multiple, a single block, and a span wider than the range", async () => {
    const twenty = nodeWithLogs(() => []);
    await getLogs(twenty, { fromBlock: 1n, toBlock: 20_000n, topics: [] }, 10_000n);
    expect(logRanges(twenty)).toEqual([
      ["0x1", "0x2710"],
      ["0x2711", "0x4e20"],
    ]);
    const one = nodeWithLogs(() => []);
    await getLogs(one, { fromBlock: 77n, toBlock: 77n, topics: [] }, 10_000n);
    expect(logRanges(one)).toEqual([["0x4d", "0x4d"]]);
    const wide = nodeWithLogs(() => []);
    await getLogs(wide, { fromBlock: 10n, toBlock: 12n, topics: [] }, 10_000n);
    expect(logRanges(wide)).toEqual([["0xa", "0xc"]]);
  });

  it("an inverted range is empty and makes no calls; maxSpan below 1 is refused", async () => {
    const rpc = nodeWithLogs(() => [rawLog(1n, 0)]);
    expect(await getLogs(rpc, { fromBlock: 10n, toBlock: 9n, topics: [] }, 10_000n)).toEqual([]);
    expect(rpc.calls).toEqual([]);
    await expect(getLogs(rpc, { fromBlock: 1n, toBlock: 2n, topics: [] }, 0n)).rejects.toThrow(RangeError);
    expect(rpc.calls).toEqual([]);
  });

  it("coverage failure surfaces as a CoverageError, not as the shorter list", async () => {
    // The node has chunk 1 but not the block chunk 2 ends at.
    const rpc = nodeWithLogs((from) => [rawLog(from, 0)], [19_999n]);
    const attempt = getLogs(rpc, { fromBlock: 0n, toBlock: 24_999n, topics: [] }, 10_000n);
    await expect(attempt).rejects.toThrow(CoverageError);
    await expect(attempt).rejects.toThrow(/block 19999/);
    await expect(attempt).rejects.toBeInstanceOf(ChainReadError);
    // Chunk 1 was read; chunk 2 was never asked for, and nothing was returned.
    expect(logRanges(rpc)).toEqual([["0x0", "0x270f"]]);
  });

  it("coverage failure when the block read itself fails keeps the cause", async () => {
    const rpc = scripted((method) => {
      if (method === "eth_getBlockByNumber") throw new Error("HTTP 429");
      return [];
    });
    const attempt = getLogs(rpc, { fromBlock: 0n, toBlock: 9n, topics: [] }, 10n);
    await expect(attempt).rejects.toThrow(CoverageError);
    const error = await attempt.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CoverageError);
    if (error instanceof CoverageError) {
      expect(error.block).toBe(9n);
      expect((error.cause as Error).message).toBe("HTTP 429");
    }
    expect(rpc.calls.map((c) => c.method)).toEqual(["eth_getBlockByNumber"]);
  });

  it("coverage failure when a proxy answers with a different block", async () => {
    const rpc = scripted((method) => (method === "eth_getBlockByNumber" ? rawBlock("0x8") : []));
    await expect(getLogs(rpc, { fromBlock: 0n, toBlock: 9n, topics: [] }, 10n)).rejects.toThrow(CoverageError);
  });

  it("returns logs sorted by (blockNumber, logIndex) whatever order the chunks came back in", async () => {
    const rpc = nodeWithLogs((from, to) => (from === 0n ? [rawLog(to, 7), rawLog(to, 3), rawLog(from + 1n, 9)] : [rawLog(from, 0), rawLog(from + 1n, 5), rawLog(from, 1)]));
    const logs = await getLogs(rpc, { fromBlock: 0n, toBlock: 19n, topics: [] }, 10n);
    expect(logs.map((log) => [log.blockNumber, log.logIndex])).toEqual([
      [1n, 9],
      [9n, 3],
      [9n, 7],
      [10n, 0],
      [10n, 1],
      [11n, 5],
    ]);
  });

  it("passes OR-topic arrays and nulls through verbatim, normalizes the address filter, and omits it when absent", async () => {
    const wallets: Hex[] = [addressTopic(WALLET), addressTopic(ZERO_ADDRESS)];
    const topics = [ERC20_TRANSFER_TOPIC, wallets, null] as const;
    const rpc = nodeWithLogs(() => []);
    await getLogs(rpc, { fromBlock: 1n, toBlock: 1n, topics }, 10n);
    const sent = at(at(rpc.calls.filter((c) => c.method === "eth_getLogs"), 0).params, 0) as Record<string, unknown>;
    expect(Object.keys(sent)).toEqual(["fromBlock", "toBlock", "topics"]);
    expect(sent["topics"]).toEqual([ERC20_TRANSFER_TOPIC, wallets, null]);

    const filtered = nodeWithLogs(() => []);
    await getLogs(filtered, { fromBlock: 1n, toBlock: 1n, address: "0x65050A9B7E5075A2BA5CED7B1B64EE66262C40DC", topics: [] }, 10n);
    const one = at(at(filtered.calls.filter((c) => c.method === "eth_getLogs"), 0).params, 0) as Record<string, unknown>;
    expect(Object.keys(one)).toEqual(["fromBlock", "toBlock", "address", "topics"]);
    expect(one["address"]).toBe(GMGN_ROUTER);

    const many = nodeWithLogs(() => []);
    await getLogs(many, { fromBlock: 1n, toBlock: 1n, address: ["0x65050A9B7E5075A2BA5CED7B1B64EE66262C40DC", WETH], topics: [] }, 10n);
    const list = at(at(many.calls.filter((c) => c.method === "eth_getLogs"), 0).params, 0) as Record<string, unknown>;
    expect(list["address"]).toEqual([GMGN_ROUTER, WETH]);
  });

  it("a non-array answer or a malformed log is a ChainReadError", async () => {
    const notArray = scripted((method) => (method === "eth_getBlockByNumber" ? rawBlock("0x1") : { logs: [] }));
    await expect(getLogs(notArray, { fromBlock: 1n, toBlock: 1n, topics: [] }, 10n)).rejects.toThrow(ChainReadError);
    const badLog = nodeWithLogs(() => [rawLog(1n, 0, { logIndex: "0x" })]);
    await expect(getLogs(badLog, { fromBlock: 1n, toBlock: 1n, topics: [] }, 10n)).rejects.toThrow(/logIndex/);
    const badTopic = nodeWithLogs(() => [rawLog(1n, 0, { topics: ["nope"] })]);
    await expect(getLogs(badTopic, { fromBlock: 1n, toBlock: 1n, topics: [] }, 10n)).rejects.toThrow(/topics\[0\]/);
  });
});
