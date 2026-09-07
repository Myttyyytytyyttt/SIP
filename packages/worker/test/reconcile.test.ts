// Tests for the reconcile owner: src/observe/reconcile.ts and src/observe/context.ts.
//
// No network. The recorded mainnet fixture was captured per old-engine WINDOW,
// so balances exist at window edges, not at N-1 and N of each block, and each
// block was trimmed to the wallet's own transactions. Contexts are therefore
// built by replaying the fixture through buildBlockContext with a small overlay:
// per-block balances derived from the recorded edges (quiet blocks in between,
// as the nonce deltas and Transfer logs prove), single-block Transfer logs
// rebuilt from the recorded receipts, and eth_getCode answered "0x".
//
// The derivation keeps the checks honest: within a window the FIRST block's
// after-balance is derived from its own tx.value and gas (chain facts, not the
// truth table), so the LAST block closes against the recorded end balance and
// §3.4's zero-wei identity is a real test of the sell accounting.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ERC20_TRANSFER_TOPIC, WETH } from "../src/chain/constants.js";
import {
  StateUnavailableError,
  addressTopic,
  balanceOfCalldata,
  buildBlockContext,
  toBlockTag,
} from "../src/observe/context.js";
import { reconcileBlock } from "../src/observe/reconcile.js";
import type {
  Address,
  BlockContext,
  Hex,
  Recording,
  RpcClient,
  RpcLog,
  RpcParams,
  TxWithReceipt,
  VenueDecoder,
  VenueFill,
} from "../src/types.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/mainnet-4663.json", import.meta.url), "utf8")) as Recording;

const WALLET: Address = "0xc455bf7f16ebbc2b07cb26d1dd46194977974e7d";
const TOKEN_V3: Address = "0x3792daef78e7c652c8ade7d1ad64fd398ed80056";
const TOKEN_V4: Address = "0xfd608e846681b1c0dba48d572c4fbb26a2d6a0d4";

const key = (method: string, params: RpcParams): string => `${method}|${JSON.stringify(params)}`;

/** Serves the overlay, then the recording, and remembers every key it was asked. Never the network. */
function mockRpc(overlay: Recording = {}, calls: string[] = []): RpcClient {
  return {
    async call<T>(method: string, params: RpcParams = []): Promise<T> {
      const k = key(method, params);
      calls.push(k);
      if (k in overlay) return overlay[k] as T;
      if (k in fixture) return fixture[k] as T;
      throw new Error(`unrecorded request: ${k}`);
    },
  };
}

const TX = {
  buyV3: "0x27259f99e2cbc54ff51e7193e020af3b3f69c021347448da59665c33c2eef882",
  buyV4: "0x5578486de21142788e3affadba58474f3bc37c68121ee232c8e16780513b8ae7",
  sellV3: "0x0688bd572526847b44963792025681b36e02cb42c7ce1470ed2476654ce4570d",
  sellV4: "0x0e5cd4ab4658c2a97eb64f02b42de93529ca9e45750c661621fca7f3eded6db7",
  approveV3: "0xc81c59bba769e844ae19cf7b4c7b2e7961334f22018ed70ad3edee6b64fcfb3e",
  approveV4: "0x9f4590a239fd31553c219e1c019bbebad12aae87a389ab13938aae20bdac2e1e",
  unwrap: "0x37ba3063845c5e9bebf760d4aadb19723e9fbd6130e22249df6a06c27559b823",
  airdrop: "0x88d5bf234f12dbdab839baecb602e82892ee8fe42d1fd51b641088d6f2f3e1c9",
  settle: "0xd342d117634464f9c6c5b9b463dd8c0be1e638fdf623ea78334a097ad1cad186",
  inbound: "0xfdbaab699ee58900bcbdf63fc7a3a55ff86b7edf92b128dca8169c5f5c722617",
  outbound: "0x79f102cb36d09fef851dc9b8d05ebc01e3cf2db00bdf2c7172f6493e8caeaee7",
} as const;
const ALL_TX: readonly Hex[] = Object.values(TX);

const BLOCK = {
  buyV3: 22080593n,
  sellV3: 22080837n,
  buyV4: 21787563n,
  sellV4: 21787635n,
  unwrap: 21774627n,
  airdrop: 21799709n,
  settle: 22086139n,
  inbound: 22078504n,
  outbound: 21844342n,
} as const;

interface RawTx {
  readonly hash: string;
  readonly from: string;
  readonly to: string | null;
  readonly value: string;
  readonly blockNumber: string;
  readonly transactionIndex: string;
}
interface RawLog {
  readonly topics: readonly string[];
}
interface RawReceipt {
  readonly gasUsed: string;
  readonly effectiveGasPrice: string;
  readonly logs: readonly RawLog[];
}

const rawTx = (hash: string): RawTx => fixture[key("eth_getTransactionByHash", [hash])] as RawTx;
const rawReceipt = (hash: string): RawReceipt => fixture[key("eth_getTransactionReceipt", [hash])] as RawReceipt;
const gasOf = (hash: string): bigint => BigInt(rawReceipt(hash).gasUsed) * BigInt(rawReceipt(hash).effectiveGasPrice);
const valueOf = (hash: string): bigint => BigInt(rawTx(hash).value);
const recordedNative = (block: bigint): bigint => BigInt(fixture[key("eth_getBalance", [WALLET, toBlockTag(block)])] as string);
const recordedWeth = (block: bigint): bigint =>
  BigInt(fixture[key("eth_call", [{ to: WETH, data: balanceOfCalldata(WALLET) }, toBlockTag(block)])] as string);
const hex = (n: bigint): string => `0x${n.toString(16)}`;
const word = (n: bigint): string => `0x${n.toString(16).padStart(64, "0")}`;

interface Cash {
  readonly nativeBefore: bigint;
  readonly nativeAfter: bigint;
  readonly wethBefore: bigint;
  readonly wethAfter: bigint;
}

/** The overlay that turns the window-recorded fixture into one block's worth of answers. */
function overlayFor(block: bigint, cash: Cash, code = "0x"): Recording {
  const tag = toBlockTag(block);
  const previous = toBlockTag(block - 1n);
  const blockKey = key("eth_getBlockByNumber", [tag, true]);
  const recorded = fixture[blockKey] as { readonly transactions: readonly RawTx[] } & Record<string, unknown>;
  // The recorder trimmed each block to the wallet's own transactions. One that
  // touched the wallet only through a log (the airdrop) goes back in from its
  // own record, where a real block would list it.
  const inBlock = ALL_TX.map(rawTx).filter((tx) => BigInt(tx.blockNumber) === block);
  const listed = new Set(recorded.transactions.map((tx) => tx.hash));
  const transactions = [...recorded.transactions, ...inBlock.filter((tx) => !listed.has(tx.hash))];
  const topic = addressTopic(WALLET);
  const transfers = inBlock.flatMap((tx) => rawReceipt(tx.hash).logs).filter((log) => log.topics[0] === ERC20_TRANSFER_TOPIC);
  const balanceOf = { to: WETH, data: balanceOfCalldata(WALLET) };
  return {
    [blockKey]: { ...recorded, transactions },
    [key("eth_getLogs", [{ fromBlock: tag, toBlock: tag, topics: [ERC20_TRANSFER_TOPIC, topic] }])]: transfers.filter(
      (log) => log.topics[1] === topic,
    ),
    [key("eth_getLogs", [{ fromBlock: tag, toBlock: tag, topics: [ERC20_TRANSFER_TOPIC, null, topic] }])]: transfers.filter(
      (log) => log.topics[2] === topic,
    ),
    [key("eth_getBalance", [WALLET, previous])]: hex(cash.nativeBefore),
    [key("eth_getBalance", [WALLET, tag])]: hex(cash.nativeAfter),
    [key("eth_call", [balanceOf, previous])]: word(cash.wethBefore),
    [key("eth_call", [balanceOf, tag])]: word(cash.wethAfter),
    [key("eth_getCode", [WALLET, tag])]: code,
  };
}

const fixtureContext = (block: bigint, cash: Cash): Promise<BlockContext> => buildBlockContext(mockRpc(overlayFor(block, cash)), WALLET, block);

// ── per-block cash, anchored on the recorded window edges ───────────────────

// Window (22080592, 22080850]: v3 buy at 22080593, approve + v3 sell at
// 22080837, nothing else (nonce 0x47 -> 0x4a is exactly those three).
const windowV3 = { start: recordedNative(22080592n), end: recordedNative(22080850n), weth: recordedWeth(22080592n) };
const afterBuyV3 = windowV3.start - valueOf(TX.buyV3) - gasOf(TX.buyV3);
const CASH_BUY_V3: Cash = { nativeBefore: windowV3.start, nativeAfter: afterBuyV3, wethBefore: windowV3.weth, wethAfter: windowV3.weth };
const CASH_SELL_V3: Cash = { nativeBefore: afterBuyV3, nativeAfter: windowV3.end, wethBefore: windowV3.weth, wethAfter: windowV3.weth };

// Window (21787560, 21787640]: v4 buy at 21787563, approve + v4 sell at 21787635.
const windowV4 = { start: recordedNative(21787560n), end: recordedNative(21787640n), weth: recordedWeth(21787560n) };
const afterBuyV4 = windowV4.start - valueOf(TX.buyV4) - gasOf(TX.buyV4);
const CASH_BUY_V4: Cash = { nativeBefore: windowV4.start, nativeAfter: afterBuyV4, wethBefore: windowV4.weth, wethAfter: windowV4.weth };
const CASH_SELL_V4: Cash = { nativeBefore: afterBuyV4, nativeAfter: windowV4.end, wethBefore: windowV4.weth, wethAfter: windowV4.weth };

// Single-transaction windows: the recorded edges are the block's own boundaries.
const edges = (start: bigint, end: bigint): Cash => ({
  nativeBefore: recordedNative(start),
  nativeAfter: recordedNative(end),
  wethBefore: recordedWeth(start),
  wethAfter: recordedWeth(end),
});
const CASH_UNWRAP = edges(21774620n, 21774630n);
const CASH_AIRDROP = edges(21799700n, 21799720n);
const CASH_SETTLE = edges(22086130n, 22086150n);
const CASH_INBOUND = edges(22078500n, 22078510n);
const CASH_OUTBOUND = edges(21844340n, 21844345n);

// ── the truth table of DESIGN.md §1 as a venue decoder ──────────────────────

const TRUTH: Record<string, VenueFill> = {
  [TX.buyV3]: { side: "buy", venue: "gmgn", tokenIn: "native", tokenOut: TOKEN_V3, notionalWei: 20_000_000_000_000_000n, feeWei: 200_000_000_000_000n },
  [TX.buyV4]: { side: "buy", venue: "gmgn", tokenIn: "native", tokenOut: TOKEN_V4, notionalWei: 1_000_000_000_000_000n, feeWei: 10_000_000_000_000n },
  [TX.sellV3]: { side: "sell", venue: "gmgn", tokenIn: TOKEN_V3, tokenOut: "native", notionalWei: 22_251_309_406_981_553n, feeWei: 222_513_094_069_815n },
  [TX.sellV4]: { side: "sell", venue: "gmgn", tokenIn: TOKEN_V4, tokenOut: "native", notionalWei: 906_846_740_302_383n, feeWei: 9_068_467_403_023n },
};
const truthVenue: VenueDecoder = { name: "gmgn-truth", decode: (entry) => TRUTH[entry.tx.hash] ?? null };
const NO_VENUES: readonly VenueDecoder[] = [];

function single<T>(items: readonly T[]): T {
  expect(items).toHaveLength(1);
  const [first] = items;
  if (first === undefined) throw new Error("unreachable: length asserted");
  return first;
}

// ── synthetic building blocks ───────────────────────────────────────────────

const OTHER: Address = "0x00000000000000000000000000000000000000aa";
const ROUTER: Address = "0x00000000000000000000000000000000000000bb";
const TOKEN_A: Address = "0x00000000000000000000000000000000000000a1";
const TOKEN_B: Address = "0x00000000000000000000000000000000000000b2";
const ZERO: Address = "0x0000000000000000000000000000000000000000";
const ETH = 1_000_000_000_000_000_000n;
const GAS_USED = 21_000n;
const GAS_PRICE = 1_000_000_000n;
const GAS = GAS_USED * GAS_PRICE;
const SYNTH_BLOCK = 5_000_000n;
const hashN = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;

function transfer(token: Address, from: Address, to: Address, amount: bigint, txHash: Hex, logIndex: number): RpcLog {
  return {
    address: token,
    topics: [ERC20_TRANSFER_TOPIC, addressTopic(from), addressTopic(to)],
    data: word(amount) as Hex,
    blockNumber: SYNTH_BLOCK,
    transactionHash: txHash,
    logIndex,
  };
}
function nftTransfer(token: Address, from: Address, to: Address, tokenId: bigint, txHash: Hex, logIndex: number): RpcLog {
  return {
    address: token,
    topics: [ERC20_TRANSFER_TOPIC, addressTopic(from), addressTopic(to), word(tokenId) as Hex],
    data: "0x",
    blockNumber: SYNTH_BLOCK,
    transactionHash: txHash,
    logIndex,
  };
}

interface EntrySpec {
  readonly n: number;
  readonly from: Address;
  readonly to: Address | null;
  readonly value?: bigint;
  readonly status?: "success" | "reverted";
  readonly logs?: (hash: Hex) => readonly RpcLog[];
  readonly gasUsed?: bigint;
}
function entry(spec: EntrySpec): TxWithReceipt {
  const hash = hashN(spec.n);
  return {
    tx: { hash, from: spec.from, to: spec.to, value: spec.value ?? 0n, nonce: spec.n, input: "0x", transactionIndex: spec.n, blockNumber: SYNTH_BLOCK },
    receipt: {
      transactionHash: hash,
      from: spec.from,
      to: spec.to,
      status: spec.status ?? "success",
      gasUsed: spec.gasUsed ?? GAS_USED,
      effectiveGasPrice: GAS_PRICE,
      logs: spec.status === "reverted" ? [] : (spec.logs?.(hash) ?? []),
      blockNumber: SYNTH_BLOCK,
    },
  };
}
interface ContextSpec {
  readonly txs: readonly TxWithReceipt[];
  readonly nativeDelta?: bigint;
  readonly wethDelta?: bigint;
  readonly hasCode?: boolean;
}
function context(spec: ContextSpec): BlockContext {
  return {
    wallet: WALLET,
    blockL2: SYNTH_BLOCK,
    txs: spec.txs,
    nativeBefore: 10n * ETH,
    nativeAfter: 10n * ETH + (spec.nativeDelta ?? 0n),
    wethBefore: 2n * ETH,
    wethAfter: 2n * ETH + (spec.wethDelta ?? 0n),
    hasCode: spec.hasCode ?? false,
  };
}
const sellShaped = (n: number, token: Address = TOKEN_A): TxWithReceipt =>
  entry({ n, from: WALLET, to: ROUTER, logs: (h) => [transfer(token, WALLET, ROUTER, 1000n, h, 0)] });
const buyShaped = (n: number, value: bigint, token: Address = TOKEN_A): TxWithReceipt =>
  entry({ n, from: WALLET, to: ROUTER, value, logs: (h) => [transfer(token, ROUTER, WALLET, 1000n, h, 0)] });

// ═════════════════════════════════════════════════════════════════════════════

describe("reconcileBlock on the recorded mainnet blocks (DESIGN.md §1 truths)", () => {
  it("GMGN v3 buy 0x27259f99: venue fill with notional = tx.value = 20e15 and fee 2e14; the block closes at 0 wei", async () => {
    const ctx = await fixtureContext(BLOCK.buyV3, CASH_BUY_V3);
    const out = reconcileBlock(ctx, [truthVenue]);
    expect(out.refusal).toBeNull();
    const fill = single(out.fills);
    expect(fill).toMatchObject({
      wallet: WALLET,
      txHash: TX.buyV3,
      blockL2: BLOCK.buyV3,
      txIndex: 1,
      side: "buy",
      venue: "gmgn",
      tokenIn: "native",
      tokenOut: TOKEN_V3,
      notionalWei: 20_000_000_000_000_000n,
      feeWei: 200_000_000_000_000n,
      source: "venue",
    });
    expect(fill.notionalWei).toBe(valueOf(TX.buyV3));
    expect(out.exclusions).toHaveLength(0);
  });

  it("the same buy without a decoder is a value-sourced fill: notional = tx.value, venue unknown, no fee", async () => {
    const out = reconcileBlock(await fixtureContext(BLOCK.buyV3, CASH_BUY_V3), NO_VENUES);
    expect(out.refusal).toBeNull();
    expect(single(out.fills)).toMatchObject({
      side: "buy",
      venue: "unknown",
      tokenIn: "native",
      tokenOut: TOKEN_V3,
      notionalWei: 20_000_000_000_000_000n,
      feeWei: 0n,
      source: "value",
    });
  });

  it("GMGN v3 sell 0x0688bd57 with its same-block approve: gross 22,251,309,406,981,553, fee 222,513,094,069,815; the approve is gas-only and closes against the recorded balance", async () => {
    const ctx = await fixtureContext(BLOCK.sellV3, CASH_SELL_V3);
    expect(ctx.txs.map((t) => t.tx.hash)).toEqual([TX.approveV3, TX.sellV3]);
    const out = reconcileBlock(ctx, [truthVenue]);
    expect(out.refusal).toBeNull();
    expect(single(out.fills)).toMatchObject({
      txHash: TX.sellV3,
      txIndex: 7,
      side: "sell",
      venue: "gmgn",
      tokenIn: TOKEN_V3,
      tokenOut: "native",
      notionalWei: 22_251_309_406_981_553n,
      feeWei: 222_513_094_069_815n,
      source: "venue",
    });
    // Net 22,028,796,312,911,738 = gross - fee, and that is what the balance moved by (plus both gas terms).
    expect(22_251_309_406_981_553n - 222_513_094_069_815n).toBe(22_028_796_312_911_738n);
    expect(CASH_SELL_V3.nativeAfter - CASH_SELL_V3.nativeBefore).toBe(22_028_796_312_911_738n - gasOf(TX.sellV3) - gasOf(TX.approveV3));
    expect(single(out.exclusions)).toMatchObject({ txHash: TX.approveV3, reason: "NOT_A_TRADE", blockL2: BLOCK.sellV3 });
  });

  it("the same sell without a decoder is a residual fill equal to the NET proceeds 22,028,796,312,911,738 (fee invisible, never above gross)", async () => {
    const out = reconcileBlock(await fixtureContext(BLOCK.sellV3, CASH_SELL_V3), NO_VENUES);
    expect(out.refusal).toBeNull();
    expect(single(out.fills)).toMatchObject({
      txHash: TX.sellV3,
      side: "sell",
      venue: "unknown",
      tokenIn: TOKEN_V3,
      tokenOut: "native",
      notionalWei: 22_028_796_312_911_738n,
      feeWei: 0n,
      source: "residual",
    });
    expect(single(out.exclusions).reason).toBe("NOT_A_TRADE");
  });

  it("omitting the same-block approve leaves exactly its gas unexplained: UNEXPLAINED_INFLOW naming the gap (this is the +58.5 ppm the per-tx formula got wrong)", async () => {
    const ctx = await fixtureContext(BLOCK.sellV3, CASH_SELL_V3);
    const withoutApprove: BlockContext = { ...ctx, txs: ctx.txs.filter((t) => t.tx.hash !== TX.approveV3) };
    for (const venues of [[truthVenue]]) {
      const out = reconcileBlock(withoutApprove, venues);
      expect(out.fills).toHaveLength(0);
      expect(out.exclusions).toHaveLength(0);
      expect(out.refusal).toMatchObject({ wallet: WALLET, blockL2: BLOCK.sellV3, reason: "UNEXPLAINED_INFLOW" });
      expect(out.refusal?.detail).toContain((-gasOf(TX.approveV3)).toString());
    }
    // Without a decoder the residual simply absorbs the approve's gas as "proceeds" — which is
    // exactly why the block scan must find it. Shown here so the number is on record.
    const residual = single(reconcileBlock(withoutApprove, NO_VENUES).fills);
    expect(residual.notionalWei).toBe(22_028_796_312_911_738n - gasOf(TX.approveV3));
  });

  it("GMGN v4 buy 0x5578486d: notional 1e15, fee 1e13", async () => {
    const out = reconcileBlock(await fixtureContext(BLOCK.buyV4, CASH_BUY_V4), [truthVenue]);
    expect(out.refusal).toBeNull();
    expect(single(out.fills)).toMatchObject({
      txHash: TX.buyV4,
      txIndex: 26,
      side: "buy",
      tokenOut: TOKEN_V4,
      notionalWei: 1_000_000_000_000_000n,
      feeWei: 10_000_000_000_000n,
      source: "venue",
    });
    const plain = reconcileBlock(await fixtureContext(BLOCK.buyV4, CASH_BUY_V4), NO_VENUES);
    expect(single(plain.fills)).toMatchObject({ notionalWei: 1_000_000_000_000_000n, source: "value", tokenOut: TOKEN_V4 });
  });

  it("GMGN v4 sell 0x0e5cd4ab with its approve: gross 906,846,740,302,383, net 897,778,272,899,360, fee 9,068,467,403,023", async () => {
    const ctx = await fixtureContext(BLOCK.sellV4, CASH_SELL_V4);
    expect(ctx.txs.map((t) => t.tx.transactionIndex)).toEqual([53, 54]);
    const out = reconcileBlock(ctx, [truthVenue]);
    expect(out.refusal).toBeNull();
    expect(single(out.fills)).toMatchObject({
      txHash: TX.sellV4,
      side: "sell",
      tokenIn: TOKEN_V4,
      notionalWei: 906_846_740_302_383n,
      feeWei: 9_068_467_403_023n,
      source: "venue",
    });
    expect(single(out.exclusions)).toMatchObject({ txHash: TX.approveV4, reason: "NOT_A_TRADE" });
    const residual = reconcileBlock(ctx, NO_VENUES);
    expect(single(residual.fills)).toMatchObject({ notionalWei: 897_778_272_899_360n, source: "residual" });
  });

  it("WETH.withdraw 0x37ba3063 (2.5e15) is WETH_WRAP, not a fill: native up, WETH down, cash unchanged but for gas", async () => {
    const ctx = await fixtureContext(BLOCK.unwrap, CASH_UNWRAP);
    expect(ctx.wethBefore - ctx.wethAfter).toBe(2_500_000_000_000_000n);
    expect(ctx.nativeAfter - ctx.nativeBefore).toBe(2_500_000_000_000_000n - gasOf(TX.unwrap));
    const out = reconcileBlock(ctx, [truthVenue]);
    expect(out.refusal).toBeNull();
    expect(out.fills).toHaveLength(0);
    expect(single(out.exclusions)).toMatchObject({ txHash: TX.unwrap, reason: "WETH_WRAP" });
  });

  it("airdrop 0x88d5bf23 (receipt.from ≠ wallet, 239 logs) is AIRDROP with no gas term: cash unchanged although the tx burned gas", async () => {
    const ctx = await fixtureContext(BLOCK.airdrop, CASH_AIRDROP);
    const airdrop = single(ctx.txs);
    expect(airdrop.receipt.from).not.toBe(WALLET);
    expect(airdrop.tx.to).not.toBe(WALLET);
    expect(airdrop.receipt.logs).toHaveLength(239);
    expect(airdrop.receipt.gasUsed * airdrop.receipt.effectiveGasPrice).toBeGreaterThan(0n);
    expect(ctx.nativeAfter).toBe(ctx.nativeBefore);
    const out = reconcileBlock(ctx, [truthVenue]);
    expect(out.refusal).toBeNull();
    expect(out.fills).toHaveLength(0);
    expect(single(out.exclusions)).toMatchObject({ txHash: TX.airdrop, reason: "AIRDROP" });
  });

  it("the old settle() 0xd342d117 to executor 0xce676c73 is NOT_A_TRADE (outbound value, no token in)", async () => {
    const out = reconcileBlock(await fixtureContext(BLOCK.settle, CASH_SETTLE), [truthVenue]);
    expect(out.refusal).toBeNull();
    expect(out.fills).toHaveLength(0);
    expect(single(out.exclusions)).toMatchObject({ txHash: TX.settle, reason: "NOT_A_TRADE" });
  });

  it("plain inbound 0.027 ETH 0xfdbaab69 is NOT_A_TRADE and counts as nativeIn", async () => {
    const ctx = await fixtureContext(BLOCK.inbound, CASH_INBOUND);
    expect(ctx.nativeAfter - ctx.nativeBefore).toBe(27_000_000_000_000_000n);
    const out = reconcileBlock(ctx, [truthVenue]);
    expect(out.refusal).toBeNull();
    expect(out.fills).toHaveLength(0);
    expect(single(out.exclusions)).toMatchObject({ txHash: TX.inbound, reason: "NOT_A_TRADE" });
  });

  it("plain outbound 0.0004 ETH 0x79f102cb is NOT_A_TRADE", async () => {
    const out = reconcileBlock(await fixtureContext(BLOCK.outbound, CASH_OUTBOUND), [truthVenue]);
    expect(out.refusal).toBeNull();
    expect(out.fills).toHaveLength(0);
    expect(single(out.exclusions)).toMatchObject({ txHash: TX.outbound, reason: "NOT_A_TRADE" });
  });

  it("every recorded block places every transaction: fills + exclusions == txs, no refusal, both with and without decoders", async () => {
    const blocks: readonly (readonly [bigint, Cash])[] = [
      [BLOCK.buyV3, CASH_BUY_V3],
      [BLOCK.sellV3, CASH_SELL_V3],
      [BLOCK.buyV4, CASH_BUY_V4],
      [BLOCK.sellV4, CASH_SELL_V4],
      [BLOCK.unwrap, CASH_UNWRAP],
      [BLOCK.airdrop, CASH_AIRDROP],
      [BLOCK.settle, CASH_SETTLE],
      [BLOCK.inbound, CASH_INBOUND],
      [BLOCK.outbound, CASH_OUTBOUND],
    ];
    for (const [block, cash] of blocks) {
      const ctx = await fixtureContext(block, cash);
      for (const venues of [[truthVenue], NO_VENUES]) {
        const out = reconcileBlock(ctx, venues);
        expect(out.refusal, `block ${block}`).toBeNull();
        expect(out.fills.length + out.exclusions.length, `block ${block}`).toBe(ctx.txs.length);
        for (const fill of out.fills) expect(fill.notionalWei).toBeGreaterThan(0n);
      }
    }
  });

  it("a venue decoder that mis-states a buy is caught by the block identity, not trusted", async () => {
    const wrong: VenueDecoder = {
      name: "wrong",
      decode: (e) => (e.tx.hash === TX.buyV3 ? { ...TRUTH[TX.buyV3], notionalWei: 21_000_000_000_000_000n } as VenueFill : null),
    };
    const out = reconcileBlock(await fixtureContext(BLOCK.buyV3, CASH_BUY_V3), [wrong]);
    expect(out.fills).toHaveLength(0);
    expect(out.refusal).toMatchObject({ reason: "UNEXPLAINED_INFLOW" });
    expect(out.refusal?.detail).toContain("1000000000000000 wei more");
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe("reconcileBlock §3.2 shapes (synthetic)", () => {
  it("REVERTED: a reverted send moved no value but its gas is charged", () => {
    const out = reconcileBlock(context({ txs: [entry({ n: 0, from: WALLET, to: OTHER, value: ETH, status: "reverted" })], nativeDelta: -GAS }), NO_VENUES);
    expect(out.refusal).toBeNull();
    expect(out.fills).toHaveLength(0);
    expect(single(out.exclusions).reason).toBe("REVERTED");
  });

  it("REVERTED from someone else costs the wallet nothing", () => {
    const out = reconcileBlock(context({ txs: [entry({ n: 0, from: OTHER, to: WALLET, value: ETH, status: "reverted" })] }), NO_VENUES);
    expect(out.refusal).toBeNull();
    expect(single(out.exclusions).reason).toBe("REVERTED");
  });

  it("SELF_TRANSFER: value to itself, only gas leaves", () => {
    const out = reconcileBlock(context({ txs: [entry({ n: 0, from: WALLET, to: WALLET, value: ETH })], nativeDelta: -GAS }), NO_VENUES);
    expect(out.refusal).toBeNull();
    expect(single(out.exclusions).reason).toBe("SELF_TRANSFER");
  });

  it("TOKEN_FOR_TOKEN: tokens both ways, no cash leg", () => {
    const swap = entry({ n: 0, from: WALLET, to: ROUTER, logs: (h) => [transfer(TOKEN_A, WALLET, ROUTER, 5n, h, 0), transfer(TOKEN_B, ROUTER, WALLET, 7n, h, 1)] });
    const out = reconcileBlock(context({ txs: [swap], nativeDelta: -GAS }), NO_VENUES);
    expect(out.refusal).toBeNull();
    expect(out.fills).toHaveLength(0);
    expect(single(out.exclusions).reason).toBe("TOKEN_FOR_TOKEN");
  });

  it("tokens both ways WITH a cash leg is more than one fill: MULTI_FILL_BLOCK", () => {
    const swap = entry({ n: 0, from: WALLET, to: ROUTER, value: ETH, logs: (h) => [transfer(TOKEN_A, WALLET, ROUTER, 5n, h, 0), transfer(TOKEN_B, ROUTER, WALLET, 7n, h, 1)] });
    const out = reconcileBlock(context({ txs: [swap], nativeDelta: -ETH - GAS }), NO_VENUES);
    expect(out.refusal).toMatchObject({ reason: "MULTI_FILL_BLOCK" });
  });

  it("WETH_WRAP (deposit): value to WETH and the same amount minted back", () => {
    const wrap = entry({ n: 0, from: WALLET, to: WETH, value: ETH, logs: (h) => [transfer(WETH, ZERO, WALLET, ETH, h, 0)] });
    const out = reconcileBlock(context({ txs: [wrap], nativeDelta: -ETH - GAS, wethDelta: ETH }), NO_VENUES);
    expect(out.refusal).toBeNull();
    expect(single(out.exclusions).reason).toBe("WETH_WRAP");
  });

  it("a wrap whose WETH did not all come back is not silently a wrap: the identity refuses it", () => {
    const wrap = entry({ n: 0, from: WALLET, to: ROUTER, value: ETH, logs: (h) => [transfer(WETH, ZERO, WALLET, ETH / 2n, h, 0)] });
    const out = reconcileBlock(context({ txs: [wrap], nativeDelta: -ETH - GAS, wethDelta: ETH / 2n }), NO_VENUES);
    expect(out.refusal).toMatchObject({ reason: "UNEXPLAINED_INFLOW" });
  });

  it("buy paid in WETH: no tx.value, WETH out and a token in; notional = the WETH, tokenIn = WETH", () => {
    const buy = entry({ n: 0, from: WALLET, to: ROUTER, logs: (h) => [transfer(WETH, WALLET, ROUTER, 3n * ETH, h, 0), transfer(TOKEN_A, ROUTER, WALLET, 9n, h, 1)] });
    const out = reconcileBlock(context({ txs: [buy], nativeDelta: -GAS, wethDelta: -3n * ETH }), NO_VENUES);
    expect(out.refusal).toBeNull();
    expect(single(out.fills)).toMatchObject({ side: "buy", tokenIn: WETH, tokenOut: TOKEN_A, notionalWei: 3n * ETH, source: "value" });
  });

  it("buy paid in native plus a WETH leg: notional = value + WETH sent", () => {
    const buy = entry({ n: 0, from: WALLET, to: ROUTER, value: ETH, logs: (h) => [transfer(WETH, WALLET, ROUTER, 2n * ETH, h, 0), transfer(TOKEN_A, ROUTER, WALLET, 9n, h, 1)] });
    const out = reconcileBlock(context({ txs: [buy], nativeDelta: -ETH - GAS, wethDelta: -2n * ETH }), NO_VENUES);
    expect(out.refusal).toBeNull();
    expect(single(out.fills)).toMatchObject({ side: "buy", tokenIn: "native", notionalWei: 3n * ETH, source: "value" });
  });

  it("a buy that also received WETH cannot be priced from tx.value: UNEXPLAINED_INFLOW", () => {
    const buy = entry({ n: 0, from: WALLET, to: ROUTER, value: ETH, logs: (h) => [transfer(TOKEN_A, ROUTER, WALLET, 9n, h, 0), transfer(WETH, ROUTER, WALLET, ETH / 10n, h, 1)] });
    const out = reconcileBlock(context({ txs: [buy], nativeDelta: -ETH - GAS, wethDelta: ETH / 10n }), NO_VENUES);
    expect(out.refusal).toMatchObject({ reason: "UNEXPLAINED_INFLOW" });
  });

  it("one payment delivering several tokens is several fills netted: MULTI_FILL_BLOCK", () => {
    const buy = entry({ n: 0, from: WALLET, to: ROUTER, value: ETH, logs: (h) => [transfer(TOKEN_A, ROUTER, WALLET, 9n, h, 0), transfer(TOKEN_B, ROUTER, WALLET, 9n, h, 1)] });
    const out = reconcileBlock(context({ txs: [buy], nativeDelta: -ETH - GAS }), NO_VENUES);
    expect(out.refusal).toMatchObject({ reason: "MULTI_FILL_BLOCK" });
  });

  it("4-topic Transfers are ERC-721/404 mints and are skipped: a paid mint is NOT_A_TRADE, not a buy", () => {
    const mint = entry({ n: 0, from: WALLET, to: ROUTER, value: ETH, logs: (h) => [nftTransfer(TOKEN_A, ZERO, WALLET, 1n, h, 0)] });
    const out = reconcileBlock(context({ txs: [mint], nativeDelta: -ETH - GAS }), NO_VENUES);
    expect(out.refusal).toBeNull();
    expect(out.fills).toHaveLength(0);
    expect(single(out.exclusions).reason).toBe("NOT_A_TRADE");
  });

  it("a buy whose token mints an NFT as a side effect is still one buy of the ERC-20", () => {
    const buy = entry({ n: 0, from: WALLET, to: ROUTER, value: ETH, logs: (h) => [transfer(TOKEN_A, ROUTER, WALLET, 9n, h, 0), nftTransfer(TOKEN_B, ZERO, WALLET, 1n, h, 1)] });
    const out = reconcileBlock(context({ txs: [buy], nativeDelta: -ETH - GAS }), NO_VENUES);
    expect(out.refusal).toBeNull();
    expect(single(out.fills)).toMatchObject({ side: "buy", tokenOut: TOKEN_A, notionalWei: ETH });
  });

  it("gas-only (approve): no value, no logs — NOT_A_TRADE, its gas counted", () => {
    const out = reconcileBlock(context({ txs: [entry({ n: 0, from: WALLET, to: TOKEN_A })], nativeDelta: -GAS }), NO_VENUES);
    expect(out.refusal).toBeNull();
    expect(single(out.exclusions).reason).toBe("NOT_A_TRADE");
    const missedGas = reconcileBlock(context({ txs: [entry({ n: 0, from: WALLET, to: TOKEN_A })], nativeDelta: 0n }), NO_VENUES);
    expect(missedGas.refusal).toMatchObject({ reason: "UNEXPLAINED_INFLOW" });
  });

  it("a token that arrives in a self-sent tx with nothing paid is a claim, not a trade", () => {
    const claim = entry({ n: 0, from: WALLET, to: ROUTER, logs: (h) => [transfer(TOKEN_A, ROUTER, WALLET, 9n, h, 0)] });
    const out = reconcileBlock(context({ txs: [claim], nativeDelta: -GAS }), NO_VENUES);
    expect(out.refusal).toBeNull();
    expect(out.fills).toHaveLength(0);
    expect(single(out.exclusions).reason).toBe("NOT_A_TRADE");
  });

  it("AIRDROP with value attached: the native counts as nativeIn and the block still closes", () => {
    const drop = entry({ n: 0, from: OTHER, to: WALLET, value: ETH / 4n, logs: (h) => [transfer(TOKEN_A, OTHER, WALLET, 9n, h, 0)] });
    const out = reconcileBlock(context({ txs: [drop], nativeDelta: ETH / 4n }), NO_VENUES);
    expect(out.refusal).toBeNull();
    expect(single(out.exclusions).reason).toBe("AIRDROP");
  });

  it("a WETH deposit from a third party is a plain inbound: NOT_A_TRADE, cash explained by the log", () => {
    const deposit = entry({ n: 0, from: OTHER, to: WETH, logs: (h) => [transfer(WETH, OTHER, WALLET, ETH, h, 0)] });
    const out = reconcileBlock(context({ txs: [deposit], wethDelta: ETH }), NO_VENUES);
    expect(out.refusal).toBeNull();
    expect(single(out.exclusions).reason).toBe("NOT_A_TRADE");
  });

  it("a token leaving the wallet in a tx it did not send (relayed or delegated sell) refuses: UNDECODED_SELL", () => {
    const relayed = entry({ n: 0, from: OTHER, to: ROUTER, logs: (h) => [transfer(TOKEN_A, WALLET, ROUTER, 9n, h, 0)] });
    const out = reconcileBlock(context({ txs: [relayed], nativeDelta: ETH }), NO_VENUES);
    expect(out.refusal).toMatchObject({ reason: "UNDECODED_SELL" });
    expect(out.refusal?.detail).toContain("did not send");
  });

  it("WETH pulled from the wallet by an approved spender in a tx it did not send refuses", () => {
    const pulled = entry({ n: 0, from: OTHER, to: ROUTER, logs: (h) => [transfer(WETH, WALLET, ROUTER, ETH, h, 0)] });
    const out = reconcileBlock(context({ txs: [pulled], wethDelta: -ETH }), NO_VENUES);
    expect(out.refusal).toMatchObject({ reason: "UNEXPLAINED_INFLOW" });
  });

  it("a self-sent tx that receives WETH with nothing leaving is cash without a counterparty movement: refused", () => {
    const claim = entry({ n: 0, from: WALLET, to: ROUTER, logs: (h) => [transfer(WETH, ROUTER, WALLET, ETH, h, 0)] });
    const out = reconcileBlock(context({ txs: [claim], nativeDelta: -GAS, wethDelta: ETH }), NO_VENUES);
    expect(out.refusal).toMatchObject({ reason: "UNEXPLAINED_INFLOW" });
  });

  it("venue decoders come first and the first to answer wins, regardless of shape", () => {
    const opaque = entry({ n: 0, from: WALLET, to: ROUTER, value: ETH });
    const first: VenueDecoder = {
      name: "first",
      decode: () => ({ side: "sell", venue: "first", tokenIn: TOKEN_A, tokenOut: "native", notionalWei: 5n * ETH, feeWei: ETH / 100n }),
    };
    const second: VenueDecoder = { name: "second", decode: () => ({ side: "buy", venue: "second", tokenIn: "native", tokenOut: TOKEN_A, notionalWei: ETH, feeWei: 0n }) };
    // The sell's gross minus fee came back; the tx.value the decoder knows about is part of what it reports.
    const out = reconcileBlock(context({ txs: [opaque], nativeDelta: 5n * ETH - ETH / 100n - GAS }), [first, second]);
    expect(out.refusal).toBeNull();
    expect(single(out.fills)).toMatchObject({ venue: "first", side: "sell", notionalWei: 5n * ETH, feeWei: ETH / 100n, source: "venue" });
  });

  it("a decoder that returns null falls through to the balance rules", () => {
    const silent: VenueDecoder = { name: "silent", decode: () => null };
    const out = reconcileBlock(context({ txs: [buyShaped(0, ETH)], nativeDelta: -ETH - GAS }), [silent]);
    expect(single(out.fills)).toMatchObject({ source: "value", notionalWei: ETH });
  });

  it("transactions are placed in index order even when the context lists them out of order", () => {
    const out = reconcileBlock(context({ txs: [sellShaped(3), entry({ n: 1, from: WALLET, to: TOKEN_A })], nativeDelta: 4n * ETH - 2n * GAS }), NO_VENUES);
    expect(out.refusal).toBeNull();
    expect(out.exclusions.map((e) => e.txHash)).toEqual([hashN(1)]);
    expect(single(out.fills)).toMatchObject({ txHash: hashN(3), txIndex: 3, notionalWei: 4n * ETH, source: "residual" });
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe("reconcileBlock §3.3 residual and §3.4 identity (synthetic)", () => {
  it("one undecoded sell beside the approve of its own block: residual = cashDelta + gasPaid", () => {
    const approve = entry({ n: 1, from: WALLET, to: TOKEN_A });
    const proceeds = 4n * ETH;
    const out = reconcileBlock(context({ txs: [approve, sellShaped(2)], nativeDelta: proceeds - 2n * GAS }), NO_VENUES);
    expect(out.refusal).toBeNull();
    expect(single(out.fills)).toMatchObject({ side: "sell", tokenIn: TOKEN_A, tokenOut: "native", notionalWei: proceeds, feeWei: 0n, source: "residual", venue: "unknown" });
    expect(single(out.exclusions).reason).toBe("NOT_A_TRADE");
  });

  it("the residual does not leak a WETH-priced buy or a venue fill sharing the block", () => {
    const buy = entry({
      n: 0,
      from: WALLET,
      to: ROUTER,
      logs: (h) => [transfer(WETH, WALLET, ROUTER, ETH, h, 0), transfer(TOKEN_B, ROUTER, WALLET, 1000n, h, 1)],
    });
    const venueSell = entry({ n: 1, from: WALLET, to: ROUTER });
    const venue: VenueDecoder = {
      name: "v",
      decode: (e) => (e.tx.hash === hashN(1) ? { side: "sell", venue: "v", tokenIn: TOKEN_B, tokenOut: "native", notionalWei: 2n * ETH, feeWei: ETH / 50n } : null),
    };
    const proceeds = 3n * ETH;
    const delta = (2n * ETH - ETH / 50n) + proceeds - 3n * GAS;
    const out = reconcileBlock(context({ txs: [buy, venueSell, sellShaped(2)], nativeDelta: delta, wethDelta: -ETH }), [venue]);
    expect(out.refusal).toBeNull();
    expect(out.fills.map((f) => [f.source, f.notionalWei])).toEqual([
      ["value", ETH],
      ["venue", 2n * ETH],
      ["residual", proceeds],
    ]);
  });

  it("a sell paid in WETH by the venue: the residual comes from the WETH leg and tokenOut is WETH", () => {
    const sell = entry({ n: 0, from: WALLET, to: ROUTER, logs: (h) => [transfer(TOKEN_A, WALLET, ROUTER, 9n, h, 0), transfer(WETH, ROUTER, WALLET, 4n * ETH, h, 1)] });
    const out = reconcileBlock(context({ txs: [sell], nativeDelta: -GAS, wethDelta: 4n * ETH }), NO_VENUES);
    expect(out.refusal).toBeNull();
    expect(single(out.fills)).toMatchObject({ side: "sell", tokenOut: WETH, notionalWei: 4n * ETH, source: "residual" });
  });

  it("UNDECODED_SELL: a sell-shaped tx whose block shows no positive proceeds", () => {
    const out = reconcileBlock(context({ txs: [sellShaped(0)], nativeDelta: -GAS }), NO_VENUES);
    expect(out.fills).toHaveLength(0);
    expect(out.refusal).toMatchObject({ reason: "UNDECODED_SELL" });
    expect(out.refusal?.detail).toContain("residual is 0 wei");
  });

  it("MULTI_FILL_BLOCK: two undecoded sells share one delta", () => {
    const out = reconcileBlock(context({ txs: [sellShaped(0, TOKEN_A), sellShaped(1, TOKEN_B)], nativeDelta: 7n * ETH - 2n * GAS }), NO_VENUES);
    expect(out.fills).toHaveLength(0);
    expect(out.refusal).toMatchObject({ reason: "MULTI_FILL_BLOCK" });
    expect(out.refusal?.detail).toContain(hashN(0));
    expect(out.refusal?.detail).toContain(hashN(1));
  });

  it("MULTI_FILL_BLOCK is decided before the inflow check", () => {
    const inbound = entry({ n: 2, from: OTHER, to: WALLET, value: ETH });
    const out = reconcileBlock(context({ txs: [sellShaped(0, TOKEN_A), sellShaped(1, TOKEN_B), inbound], nativeDelta: 8n * ETH - 2n * GAS }), NO_VENUES);
    expect(out.refusal).toMatchObject({ reason: "MULTI_FILL_BLOCK" });
  });

  it("UNEXPLAINED_INFLOW: native arrived from outside in the block of an undecoded sell", () => {
    const inbound = entry({ n: 1, from: OTHER, to: WALLET, value: ETH });
    const out = reconcileBlock(context({ txs: [sellShaped(0), inbound], nativeDelta: 5n * ETH - GAS }), NO_VENUES);
    expect(out.fills).toHaveLength(0);
    expect(out.refusal).toMatchObject({ reason: "UNEXPLAINED_INFLOW" });
    expect(out.refusal?.detail).toContain(ETH.toString());
  });

  it("UNEXPLAINED_INFLOW: WETH deposited from outside in the block of an undecoded sell", () => {
    const deposit = entry({ n: 1, from: OTHER, to: WETH, logs: (h) => [transfer(WETH, OTHER, WALLET, ETH, h, 0)] });
    const out = reconcileBlock(context({ txs: [sellShaped(0), deposit], nativeDelta: 4n * ETH - GAS, wethDelta: ETH }), NO_VENUES);
    expect(out.refusal).toMatchObject({ reason: "UNEXPLAINED_INFLOW" });
  });

  it("a decoded venue sell in a block with an inbound is fine: only the residual needs a quiet block", () => {
    const venueSell = entry({ n: 0, from: WALLET, to: ROUTER });
    const inbound = entry({ n: 1, from: OTHER, to: WALLET, value: ETH });
    const venue: VenueDecoder = {
      name: "v",
      decode: (e) => (e.tx.hash === hashN(0) ? { side: "sell", venue: "v", tokenIn: TOKEN_A, tokenOut: "native", notionalWei: 2n * ETH, feeWei: 0n } : null),
    };
    const out = reconcileBlock(context({ txs: [venueSell, inbound], nativeDelta: 3n * ETH - GAS }), [venue]);
    expect(out.refusal).toBeNull();
    expect(single(out.fills).notionalWei).toBe(2n * ETH);
    expect(single(out.exclusions).reason).toBe("NOT_A_TRADE");
  });

  it("§3.4: cash that moved without a transaction to explain it refuses, difference in detail", () => {
    const send = entry({ n: 0, from: WALLET, to: OTHER, value: ETH });
    const out = reconcileBlock(context({ txs: [send], nativeDelta: -GAS }), NO_VENUES);
    expect(out.refusal).toMatchObject({ reason: "UNEXPLAINED_INFLOW" });
    expect(out.refusal?.detail).toContain(`${ETH} wei more`);
    const empty = reconcileBlock(context({ txs: [], nativeDelta: ETH }), NO_VENUES);
    expect(empty.refusal).toMatchObject({ reason: "UNEXPLAINED_INFLOW" });
    const quiet = reconcileBlock(context({ txs: [] }), NO_VENUES);
    expect(quiet).toEqual({ fills: [], exclusions: [], refusal: null });
  });

  it("§3.5: a refusal voids every fill and exclusion of the block", () => {
    const venue: VenueDecoder = {
      name: "v",
      decode: (e) => (e.tx.hash === hashN(0) ? { side: "buy", venue: "v", tokenIn: "native", tokenOut: TOKEN_A, notionalWei: ETH, feeWei: 0n } : null),
    };
    const relayed = entry({ n: 2, from: OTHER, to: ROUTER, logs: (h) => [transfer(TOKEN_B, WALLET, ROUTER, 9n, h, 0)] });
    const out = reconcileBlock(context({ txs: [buyShaped(0, ETH), entry({ n: 1, from: WALLET, to: TOKEN_A }), relayed], nativeDelta: -ETH - 2n * GAS }), [venue]);
    expect(out.refusal).toMatchObject({ wallet: WALLET, blockL2: SYNTH_BLOCK, reason: "UNDECODED_SELL" });
    expect(out.fills).toEqual([]);
    expect(out.exclusions).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════

// The residual is the one number §3.4 can never contradict, because it is
// defined as whatever §3.4 would otherwise call missing. These are the two ways
// a stranger or a sibling transaction could write it.
describe("reconcileBlock: the residual has to be provable", () => {
  it("a second wallet-sent tx carrying value refuses: its internal refund would be booked as proceeds", () => {
    const proceeds = 4n * ETH;
    const refund = ETH / 10n;
    // The wallet paid ETH/2 into a contract that handed ETH/10 straight back by
    // internal call: no log, no receipt field, only a balance that is ETH/10
    // higher than the transactions explain. Priced as a residual it would have
    // charged this user for 4.1 ETH of volume against a 4 ETH sale.
    const send = entry({ n: 0, from: WALLET, to: OTHER, value: ETH / 2n });
    const out = reconcileBlock(
      context({ txs: [send, sellShaped(1)], nativeDelta: proceeds - ETH / 2n + refund - 2n * GAS }),
      NO_VENUES,
    );
    expect(out.fills).toEqual([]);
    expect(out.exclusions).toEqual([]);
    expect(out.refusal).toMatchObject({ wallet: WALLET, blockL2: SYNTH_BLOCK, reason: "UNEXPLAINED_INFLOW" });
    expect(out.refusal?.detail).toContain(hashN(0));
  });

  it("the same block without the value-bearing tx prices the sale itself, not the block", () => {
    const proceeds = 4n * ETH;
    const out = reconcileBlock(context({ txs: [sellShaped(1)], nativeDelta: proceeds - GAS }), NO_VENUES);
    expect(single(out.fills)).toMatchObject({ notionalWei: proceeds, source: "residual" });
  });

  it("a native-priced buy beside the sell refuses too: routers refund what the swap did not spend", () => {
    const out = reconcileBlock(
      context({ txs: [buyShaped(0, ETH, TOKEN_B), sellShaped(1)], nativeDelta: 3n * ETH - ETH - 2n * GAS }),
      NO_VENUES,
    );
    expect(out.refusal).toMatchObject({ reason: "UNEXPLAINED_INFLOW" });
    expect(out.refusal?.detail).toContain("native value");
  });

  it("paid in WETH, the proceeds are stated: a leftover bigger than the WETH leg refuses", () => {
    const sell = entry({ n: 0, from: WALLET, to: ROUTER, logs: (h) => [transfer(TOKEN_A, WALLET, ROUTER, 9n, h, 0), transfer(WETH, ROUTER, WALLET, 4n * ETH, h, 1)] });
    const out = reconcileBlock(context({ txs: [sell], nativeDelta: ETH - GAS, wethDelta: 4n * ETH }), NO_VENUES);
    expect(out.fills).toEqual([]);
    expect(out.refusal).toMatchObject({ reason: "UNEXPLAINED_INFLOW" });
    expect(out.refusal?.detail).toContain(`${4n * ETH} wei of WETH`);
  });

  it("the value-bearing sibling is named whether it paid out or the sell shares its gas", () => {
    const pull = entry({ n: 2, from: WALLET, to: ROUTER, value: ETH / 3n });
    const out = reconcileBlock(context({ txs: [sellShaped(0), entry({ n: 1, from: WALLET, to: TOKEN_A }), pull], nativeDelta: 2n * ETH - 3n * GAS }), NO_VENUES);
    expect(out.refusal).toMatchObject({ reason: "UNEXPLAINED_INFLOW" });
    expect(out.refusal?.detail).toContain(hashN(2));
  });
});

// ═════════════════════════════════════════════════════════════════════════════

// A Transfer log's indexed fields are written by whoever emits it, and a log is
// all it takes to nominate a block. A stranger must not be able to park a
// wallet's cursor behind a refusal for the whole retention window.
describe("reconcileBlock: a stranger's Transfer log cannot hold the cursor", () => {
  const spam = entry({ n: 0, from: OTHER, to: ROUTER, logs: (h) => [transfer(TOKEN_A, WALLET, ROUTER, 9n, h, 0)] });

  it("a log claiming the wallet sent a token, in a block where the wallet sent nothing and cash did not move, is excluded", () => {
    const out = reconcileBlock(context({ txs: [spam] }), NO_VENUES);
    expect(out.refusal).toBeNull();
    expect(out.fills).toEqual([]);
    expect(single(out.exclusions)).toMatchObject({ wallet: WALLET, txHash: hashN(0), blockL2: SYNTH_BLOCK, reason: "AIRDROP" });
  });

  it("the same log still refuses when the block moved the wallet's cash: that could be a real relayed sell", () => {
    const out = reconcileBlock(context({ txs: [spam], nativeDelta: ETH }), NO_VENUES);
    expect(out.refusal).toMatchObject({ reason: "UNDECODED_SELL" });
  });

  it("the same log still refuses when the wallet itself transacted in the block", () => {
    const approve = entry({ n: 1, from: WALLET, to: TOKEN_A });
    const out = reconcileBlock(context({ txs: [spam, approve], nativeDelta: -GAS }), NO_VENUES);
    expect(out.refusal).toMatchObject({ reason: "UNDECODED_SELL" });
  });

  it("a spam log naming the wallet as recipient of a junk token was already only an exclusion", () => {
    const junk = entry({ n: 0, from: OTHER, to: ROUTER, logs: (h) => [transfer(TOKEN_B, OTHER, WALLET, 9n, h, 0)] });
    const out = reconcileBlock(context({ txs: [junk] }), NO_VENUES);
    expect(out.refusal).toBeNull();
    expect(single(out.exclusions).reason).toBe("AIRDROP");
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe("reconcileBlock §3.1 wallets with code", () => {
  it("a sell-shaped tx without a decoder refuses WALLET_HAS_CODE", () => {
    const out = reconcileBlock(context({ txs: [sellShaped(0)], nativeDelta: 4n * ETH - GAS, hasCode: true }), NO_VENUES);
    expect(out.fills).toHaveLength(0);
    expect(out.refusal).toMatchObject({ reason: "WALLET_HAS_CODE" });
  });

  it("a value-priced buy is a fill the balance rules produced, so it refuses too", () => {
    const out = reconcileBlock(context({ txs: [buyShaped(0, ETH)], nativeDelta: -ETH - GAS, hasCode: true }), NO_VENUES);
    expect(out.refusal).toMatchObject({ reason: "WALLET_HAS_CODE" });
  });

  it("a venue-decoded fill is allowed, and the exclusions still place", () => {
    const venue: VenueDecoder = {
      name: "v",
      decode: (e) => (e.tx.hash === hashN(0) ? { side: "sell", venue: "v", tokenIn: TOKEN_A, tokenOut: "native", notionalWei: 4n * ETH, feeWei: 0n } : null),
    };
    const out = reconcileBlock(context({ txs: [sellShaped(0), entry({ n: 1, from: WALLET, to: TOKEN_A })], nativeDelta: 4n * ETH - 2n * GAS, hasCode: true }), [venue]);
    expect(out.refusal).toBeNull();
    expect(single(out.fills)).toMatchObject({ source: "venue", notionalWei: 4n * ETH });
    expect(single(out.exclusions).reason).toBe("NOT_A_TRADE");
  });

  it("WALLET_HAS_CODE takes precedence over the residual and inflow checks", () => {
    const inbound = entry({ n: 1, from: OTHER, to: WALLET, value: ETH });
    const out = reconcileBlock(context({ txs: [sellShaped(0), inbound], nativeDelta: 5n * ETH - GAS, hasCode: true }), NO_VENUES);
    expect(out.refusal).toMatchObject({ reason: "WALLET_HAS_CODE" });
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe("buildBlockContext", () => {
  it("reads the block, both Transfer directions, both balances at N-1 and N, code, and one receipt per wallet tx — nothing else", async () => {
    const calls: string[] = [];
    const ctx = await buildBlockContext(mockRpc(overlayFor(BLOCK.sellV3, CASH_SELL_V3), calls), WALLET, BLOCK.sellV3);
    const tag = "0x150ed45";
    const topic = addressTopic(WALLET);
    const balanceOf = { to: WETH, data: balanceOfCalldata(WALLET) };
    expect(calls).toEqual([
      key("eth_getBlockByNumber", [tag, true]),
      key("eth_getLogs", [{ fromBlock: tag, toBlock: tag, topics: [ERC20_TRANSFER_TOPIC, topic] }]),
      key("eth_getLogs", [{ fromBlock: tag, toBlock: tag, topics: [ERC20_TRANSFER_TOPIC, null, topic] }]),
      key("eth_getBalance", [WALLET, "0x150ed44"]),
      key("eth_getBalance", [WALLET, tag]),
      key("eth_call", [balanceOf, "0x150ed44"]),
      key("eth_call", [balanceOf, tag]),
      key("eth_getCode", [WALLET, tag]),
      key("eth_getTransactionReceipt", [TX.approveV3]),
      key("eth_getTransactionReceipt", [TX.sellV3]),
    ]);
    expect(ctx).toMatchObject({ wallet: WALLET, blockL2: BLOCK.sellV3, hasCode: false, ...CASH_SELL_V3 });
    expect(ctx.txs.map((t) => [t.tx.hash, t.tx.transactionIndex, t.tx.nonce])).toEqual([
      [TX.approveV3, 6, 72],
      [TX.sellV3, 7, 73],
    ]);
    const sell = ctx.txs[1];
    expect(sell?.tx).toMatchObject({ from: WALLET, to: "0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc", value: 0n, blockNumber: BLOCK.sellV3 });
    expect(sell?.receipt).toMatchObject({ from: WALLET, status: "success", gasUsed: 188_011n, effectiveGasPrice: 27_848_000n, blockNumber: BLOCK.sellV3 });
    expect(sell?.receipt.logs).toHaveLength(6);
    expect(sell?.receipt.logs[0]).toMatchObject({ transactionHash: TX.sellV3, blockNumber: BLOCK.sellV3, logIndex: 53 });
    expect(sell?.receipt.logs[0]?.address).toBe(WETH);
  });

  it("finds a transaction the wallet neither sent nor received through its Transfer log (the airdrop)", async () => {
    const ctx = await buildBlockContext(mockRpc(overlayFor(BLOCK.airdrop, CASH_AIRDROP)), WALLET, BLOCK.airdrop);
    const airdrop = single(ctx.txs);
    expect(airdrop.tx).toMatchObject({ hash: TX.airdrop, from: "0xcc051fed5cdcc3680aab268bea050dabbb99efe3", to: "0x2d5ce1a124f8c96eb271a606ff1f6b4da09ecdad", transactionIndex: 1 });
    expect(airdrop.receipt.status).toBe("success");
  });

  it("a 4-topic Transfer naming a transaction the block does not list is ignored; a 3-topic one is a provider inconsistency", async () => {
    const tag = toBlockTag(BLOCK.outbound);
    const topic = addressTopic(WALLET);
    const ghost = "0x" + "ab".repeat(32);
    const nft = { address: TOKEN_A, topics: [ERC20_TRANSFER_TOPIC, addressTopic(ZERO), topic, word(1n)], data: "0x", blockNumber: tag, transactionHash: ghost, logIndex: "0x0" };
    const base = overlayFor(BLOCK.outbound, CASH_OUTBOUND);
    const inKey = key("eth_getLogs", [{ fromBlock: tag, toBlock: tag, topics: [ERC20_TRANSFER_TOPIC, null, topic] }]);
    const withNft = await buildBlockContext(mockRpc({ ...base, [inKey]: [nft] }), WALLET, BLOCK.outbound);
    expect(withNft.txs.map((t) => t.tx.hash)).toEqual([TX.outbound]);
    const erc20 = { ...nft, topics: nft.topics.slice(0, 3), data: word(1n) };
    await expect(buildBlockContext(mockRpc({ ...base, [inKey]: [erc20] }), WALLET, BLOCK.outbound)).rejects.toThrow(StateUnavailableError);
  });

  it("a null block is a missing answer, not an empty one", async () => {
    const overlay = { ...overlayFor(BLOCK.outbound, CASH_OUTBOUND), [key("eth_getBlockByNumber", [toBlockTag(BLOCK.outbound), true])]: null };
    await expect(buildBlockContext(mockRpc(overlay), WALLET, BLOCK.outbound)).rejects.toThrow(StateUnavailableError);
    await expect(buildBlockContext(mockRpc(overlay), WALLET, BLOCK.outbound)).rejects.toThrow(/does not have this block/);
  });

  it("a null receipt, a receipt from another height, and a block with hashes only all throw StateUnavailableError", async () => {
    const base = overlayFor(BLOCK.outbound, CASH_OUTBOUND);
    const receiptKey = key("eth_getTransactionReceipt", [TX.outbound]);
    await expect(buildBlockContext(mockRpc({ ...base, [receiptKey]: null }), WALLET, BLOCK.outbound)).rejects.toThrow(StateUnavailableError);
    const elsewhere = { ...(fixture[receiptKey] as Record<string, unknown>), blockNumber: "0x1" };
    await expect(buildBlockContext(mockRpc({ ...base, [receiptKey]: elsewhere }), WALLET, BLOCK.outbound)).rejects.toThrow(/reports block/);
    const blockKey = key("eth_getBlockByNumber", [toBlockTag(BLOCK.outbound), true]);
    const hashesOnly = { ...(base[blockKey] as Record<string, unknown>), transactions: [TX.outbound] };
    await expect(buildBlockContext(mockRpc({ ...base, [blockKey]: hashesOnly }), WALLET, BLOCK.outbound)).rejects.toThrow(/hashes where full/);
    const wrongHeight = { ...(base[blockKey] as Record<string, unknown>), number: "0x1" };
    await expect(buildBlockContext(mockRpc({ ...base, [blockKey]: wrongHeight }), WALLET, BLOCK.outbound)).rejects.toThrow(/answered with block 1/);
  });

  it("eth_getCode other than 0x means hasCode, and the wallet address is normalised", async () => {
    const ctx = await buildBlockContext(mockRpc(overlayFor(BLOCK.outbound, CASH_OUTBOUND, "0xef0100" + "11".repeat(20))), WALLET.toUpperCase().replace("0X", "0x") as Address, BLOCK.outbound);
    expect(ctx.hasCode).toBe(true);
    expect(ctx.wallet).toBe(WALLET);
    const out = reconcileBlock(ctx, NO_VENUES);
    expect(out.refusal).toBeNull();
  });

  it("block 0 has no predecessor", async () => {
    await expect(buildBlockContext(mockRpc(), WALLET, 0n)).rejects.toThrow(/no predecessor/);
  });
});
