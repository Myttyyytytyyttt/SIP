import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Address, Hex, RpcLog, RpcReceipt, RpcTransaction, TxWithReceipt, VenueDecoder, VenueFill } from "../src/types.js";
import { gmgn, GMGN_FEE_TOPIC, GMGN_FILL_TOPIC } from "../src/observe/venues/gmgn.js";
import { decodeVenueFill, VENUES } from "../src/observe/venues/index.js";

// ── the recorded fixture, read directly (no network, no dependency on other owners' stubs) ──────

const FIXTURE = JSON.parse(
  readFileSync(new URL("./fixtures/mainnet-4663.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

interface RawTx {
  hash: Hex; from: Address; to: Address | null; value: Hex; nonce: Hex; input: Hex; transactionIndex: Hex; blockNumber: Hex;
}
interface RawLog { address: Address; topics: Hex[]; data: Hex; blockNumber: Hex; transactionHash: Hex; logIndex: Hex }
interface RawReceipt {
  transactionHash: Hex; from: Address; to: Address | null; status: Hex; gasUsed: Hex; effectiveGasPrice: Hex; logs: RawLog[]; blockNumber: Hex;
}

function recorded<T>(method: string, params: readonly unknown[]): T {
  const key = `${method}|${JSON.stringify(params)}`;
  const value = FIXTURE[key];
  if (value === undefined) throw new Error(`fixture has no ${key}`);
  return value as T;
}

function entryOf(hash: Hex): TxWithReceipt {
  const t = recorded<RawTx>("eth_getTransactionByHash", [hash]);
  const r = recorded<RawReceipt>("eth_getTransactionReceipt", [hash]);
  const tx: RpcTransaction = {
    hash: t.hash,
    from: t.from,
    to: t.to,
    value: BigInt(t.value),
    nonce: Number(BigInt(t.nonce)),
    input: t.input,
    transactionIndex: Number(BigInt(t.transactionIndex)),
    blockNumber: BigInt(t.blockNumber),
  };
  const receipt: RpcReceipt = {
    transactionHash: r.transactionHash,
    from: r.from,
    to: r.to,
    status: r.status === "0x1" ? "success" : "reverted",
    gasUsed: BigInt(r.gasUsed),
    effectiveGasPrice: BigInt(r.effectiveGasPrice),
    blockNumber: BigInt(r.blockNumber),
    logs: r.logs.map((l) => ({
      address: l.address,
      topics: l.topics,
      data: l.data,
      blockNumber: BigInt(l.blockNumber),
      transactionHash: l.transactionHash,
      logIndex: Number(BigInt(l.logIndex)),
    })),
  };
  return { tx, receipt };
}

// ── facts from DESIGN.md §1 ─────────────────────────────────────────────────────────────────────

const WALLET: Address = "0xc455bf7f16ebbc2b07cb26d1dd46194977974e7d";
const ROUTER: Address = "0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc";
const WETH: Address = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const ZERO: Address = "0x0000000000000000000000000000000000000000";
const TOKEN_V3: Address = "0x3792daef78e7c652c8ade7d1ad64fd398ed80056";
const TOKEN_V4: Address = "0xfd608e846681b1c0dba48d572c4fbb26a2d6a0d4";
const TRANSFER: Hex = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const BUY_V3: Hex = "0x27259f99e2cbc54ff51e7193e020af3b3f69c021347448da59665c33c2eef882";
const BUY_V4: Hex = "0x5578486de21142788e3affadba58474f3bc37c68121ee232c8e16780513b8ae7";
const SELL_V3: Hex = "0x0688bd572526847b44963792025681b36e02cb42c7ce1470ed2476654ce4570d";
const SELL_V4: Hex = "0x0e5cd4ab4658c2a97eb64f02b42de93529ca9e45750c661621fca7f3eded6db7";

const NOT_FILLS: ReadonlyArray<readonly [label: string, hash: Hex]> = [
  ["approve before the v3 sell (same block, Approval only)", "0xc81c59bba769e844ae19cf7b4c7b2e7961334f22018ed70ad3edee6b64fcfb3e"],
  ["approve before the v4 sell (same block, Approval only)", "0x9f4590a239fd31553c219e1c019bbebad12aae87a389ab13938aae20bdac2e1e"],
  ["WETH.withdraw 2.5e15 (WETH_WRAP)", "0x37ba3063845c5e9bebf760d4aadb19723e9fbd6130e22249df6a06c27559b823"],
  ["airdrop, receipt.from ≠ wallet, 239 logs (AIRDROP)", "0x88d5bf234f12dbdab839baecb602e82892ee8fe42d1fd51b641088d6f2f3e1c9"],
  ["the old settle() to the executor (NOT_A_TRADE)", "0xd342d117634464f9c6c5b9b463dd8c0be1e638fdf623ea78334a097ad1cad186"],
  ["plain inbound 0.027 ETH, no logs (NOT_A_TRADE)", "0xfdbaab699ee58900bcbdf63fc7a3a55ff86b7edf92b128dca8169c5f5c722617"],
  ["plain outbound 0.0004 ETH (NOT_A_TRADE)", "0x79f102cb36d09fef851dc9b8d05ebc01e3cf2db00bdf2c7172f6493e8caeaee7"],
];

// ── mutation helpers for the synthetic cases ────────────────────────────────────────────────────

function padAddress(address: Address): Hex {
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
}
function word(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}
function words(data: Hex): string[] {
  const body = data.slice(2);
  const out: string[] = [];
  for (let i = 0; i < body.length; i += 64) out.push(body.slice(i, i + 64));
  return out;
}
function joinWords(ws: readonly string[]): Hex {
  return `0x${ws.join("")}`;
}
function setWord(data: Hex, index: number, value: bigint): Hex {
  const ws = words(data);
  ws[index] = word(value);
  return joinWords(ws);
}
function isFill(log: RpcLog): boolean {
  return log.address === ROUTER && log.topics[0] === GMGN_FILL_TOPIC;
}
function isFee(log: RpcLog): boolean {
  return log.address === ROUTER && log.topics[0] === GMGN_FEE_TOPIC;
}
function isTokenTransfer(log: RpcLog): boolean {
  return log.topics[0] === TRANSFER && log.address !== WETH;
}
function withLogs(entry: TxWithReceipt, edit: (logs: readonly RpcLog[]) => readonly RpcLog[]): TxWithReceipt {
  return { tx: entry.tx, receipt: { ...entry.receipt, logs: edit(entry.receipt.logs) } };
}
function withTx(entry: TxWithReceipt, patch: Partial<RpcTransaction>): TxWithReceipt {
  return { tx: { ...entry.tx, ...patch }, receipt: entry.receipt };
}
function mapLog(entry: TxWithReceipt, pick: (log: RpcLog) => boolean, edit: (log: RpcLog) => RpcLog): TxWithReceipt {
  return withLogs(entry, (logs) => logs.map((l) => (pick(l) ? edit(l) : l)));
}
function dropLog(entry: TxWithReceipt, pick: (log: RpcLog) => boolean): TxWithReceipt {
  return withLogs(entry, (logs) => logs.filter((l) => !pick(l)));
}
function fillData(entry: TxWithReceipt): Hex {
  const log = entry.receipt.logs.find(isFill);
  if (log === undefined) throw new Error("entry has no FILL log");
  return log.data;
}
function withFillData(entry: TxWithReceipt, data: Hex): TxWithReceipt {
  return mapLog(entry, isFill, (l) => ({ ...l, data }));
}

// ── the four recorded fills decode to the exact truths of DESIGN.md §1 ──────────────────────────

describe("gmgn: the four recorded fills", () => {
  it("decodes the v3-style buy: notional = tx.value = 2e16, fee 2e14, native → token", () => {
    const entry = entryOf(BUY_V3);
    expect(entry.tx.value).toBe(20_000_000_000_000_000n);
    expect(gmgn.decode(entry, WALLET)).toEqual<VenueFill>({
      side: "buy",
      venue: "gmgn",
      tokenIn: "native",
      tokenOut: TOKEN_V3,
      notionalWei: 20_000_000_000_000_000n,
      feeWei: 200_000_000_000_000n,
    });
  });

  it("decodes the v4 PoolManager buy: notional 1e15, fee 1e13", () => {
    const entry = entryOf(BUY_V4);
    expect(entry.tx.value).toBe(1_000_000_000_000_000n);
    expect(gmgn.decode(entry, WALLET)).toEqual<VenueFill>({
      side: "buy",
      venue: "gmgn",
      tokenIn: "native",
      tokenOut: TOKEN_V4,
      notionalWei: 1_000_000_000_000_000n,
      feeWei: 10_000_000_000_000n,
    });
  });

  it("decodes the v3-style sell GROSS: 22,251,309,406,981,553 = net 22,028,796,312,911,738 + fee 222,513,094,069,815", () => {
    const fill = gmgn.decode(entryOf(SELL_V3), WALLET);
    expect(fill).toEqual<VenueFill>({
      side: "sell",
      venue: "gmgn",
      tokenIn: TOKEN_V3,
      tokenOut: "native",
      notionalWei: 22_251_309_406_981_553n,
      feeWei: 222_513_094_069_815n,
    });
    // The net the wallet actually received is the gross minus the fee — the reconciler's step-4
    // identity depends on exactly this split.
    expect(fill !== null && fill.notionalWei - fill.feeWei).toBe(22_028_796_312_911_738n);
  });

  it("decodes the v4 sell GROSS: 906,846,740,302,383 = net 897,778,272,899,360 + fee 9,068,467,403,023", () => {
    const fill = gmgn.decode(entryOf(SELL_V4), WALLET);
    expect(fill).toEqual<VenueFill>({
      side: "sell",
      venue: "gmgn",
      tokenIn: TOKEN_V4,
      tokenOut: "native",
      notionalWei: 906_846_740_302_383n,
      feeWei: 9_068_467_403_023n,
    });
    expect(fill !== null && fill.notionalWei - fill.feeWei).toBe(897_778_272_899_360n);
  });

  it("measures a round trip on one basis: sell gross ≈ buy notional + pool move, never the net", () => {
    const buy = gmgn.decode(entryOf(BUY_V3), WALLET);
    const sell = gmgn.decode(entryOf(SELL_V3), WALLET);
    expect(buy?.side).toBe("buy");
    expect(sell?.side).toBe("sell");
    // Gross on both sides: the two fees are the router's 1 % of each gross leg.
    expect(buy !== null && buy.notionalWei / buy.feeWei).toBe(100n);
    expect(sell !== null && sell.notionalWei / sell.feeWei).toBe(100n);
  });

  it("accepts the wallet in any letter case (addresses are compared lowercase)", () => {
    const upper = `0x${WALLET.slice(2).toUpperCase()}` as Address;
    expect(gmgn.decode(entryOf(BUY_V3), upper)?.notionalWei).toBe(20_000_000_000_000_000n);
    expect(gmgn.decode(entryOf(SELL_V4), upper)?.notionalWei).toBe(906_846_740_302_383n);
  });

  it("names itself gmgn, and the fill says so", () => {
    expect(gmgn.name).toBe("gmgn");
    expect(gmgn.decode(entryOf(BUY_V4), WALLET)?.venue).toBe("gmgn");
  });
});

// ── everything in the fixture that is not a GMGN fill is null ───────────────────────────────────

describe("gmgn: recorded non-fills return null", () => {
  it.each(NOT_FILLS)("%s", (_label, hash) => {
    expect(gmgn.decode(entryOf(hash), WALLET)).toBeNull();
  });

  it("returns null for a recorded fill when asked about a different wallet", () => {
    const other: Address = "0x000000000000000000000000000000000000beef";
    expect(gmgn.decode(entryOf(BUY_V3), other)).toBeNull();
    expect(gmgn.decode(entryOf(SELL_V4), other)).toBeNull();
  });
});

// ── refuse rather than guess: every shape check returns null ────────────────────────────────────

describe("gmgn: shape checks refuse rather than guess", () => {
  it("a FILL without a FEE is null (buy and sell)", () => {
    expect(gmgn.decode(dropLog(entryOf(BUY_V3), isFee), WALLET)).toBeNull();
    expect(gmgn.decode(dropLog(entryOf(SELL_V3), isFee), WALLET)).toBeNull();
  });

  it("a FEE without a FILL is null", () => {
    expect(gmgn.decode(dropLog(entryOf(BUY_V4), isFill), WALLET)).toBeNull();
    expect(gmgn.decode(dropLog(entryOf(SELL_V4), isFill), WALLET)).toBeNull();
  });

  it("two FILL/FEE pairs in one tx (multi-fill, net only) is null", () => {
    const entry = withLogs(entryOf(SELL_V3), (logs) => [...logs, ...logs.filter((l) => isFill(l) || isFee(l))]);
    expect(gmgn.decode(entry, WALLET)).toBeNull();
  });

  it("one FILL but two FEEs is null", () => {
    const entry = withLogs(entryOf(BUY_V3), (logs) => [...logs, ...logs.filter(isFee)]);
    expect(gmgn.decode(entry, WALLET)).toBeNull();
  });

  it("router-shaped logs emitted by a contract that is not the router are null", () => {
    const impostor: Address = "0x00000000000000000000000000000000000d15ea";
    const entry = mapLog(entryOf(BUY_V3), (l) => isFill(l) || isFee(l), (l) => ({ ...l, address: impostor }));
    expect(gmgn.decode(entry, WALLET)).toBeNull();
  });

  it("a FILL whose sender or recipient topic is not the wallet is null", () => {
    const other = padAddress("0x000000000000000000000000000000000000beef");
    const senderSwapped = mapLog(entryOf(BUY_V3), isFill, (l) => ({ ...l, topics: [l.topics[0] ?? "0x", other, l.topics[2] ?? "0x", l.topics[3] ?? "0x"] }));
    const recipientSwapped = mapLog(entryOf(BUY_V3), isFill, (l) => ({ ...l, topics: [l.topics[0] ?? "0x", l.topics[1] ?? "0x", other, l.topics[3] ?? "0x"] }));
    expect(gmgn.decode(senderSwapped, WALLET)).toBeNull();
    expect(gmgn.decode(recipientSwapped, WALLET)).toBeNull();
  });

  it("a FILL with three topics instead of four is null", () => {
    const entry = mapLog(entryOf(SELL_V4), isFill, (l) => ({ ...l, topics: l.topics.slice(0, 3) }));
    expect(gmgn.decode(entry, WALLET)).toBeNull();
  });

  it("a FEE addressed to a different wallet is null", () => {
    const other = padAddress("0x000000000000000000000000000000000000beef");
    const entry = mapLog(entryOf(SELL_V3), isFee, (l) => ({ ...l, topics: [l.topics[0] ?? "0x", l.topics[1] ?? "0x", other] }));
    expect(gmgn.decode(entry, WALLET)).toBeNull();
  });

  it("a reverted receipt is null even with the logs present", () => {
    const base = entryOf(BUY_V3);
    const entry: TxWithReceipt = { tx: base.tx, receipt: { ...base.receipt, status: "reverted" } };
    expect(gmgn.decode(entry, WALLET)).toBeNull();
  });

  it("a call whose tx.to is not the router is null", () => {
    expect(gmgn.decode(withTx(entryOf(BUY_V3), { to: TOKEN_V3 }), WALLET)).toBeNull();
    expect(gmgn.decode(withTx(entryOf(BUY_V3), { to: null }), WALLET)).toBeNull();
  });

  it("a call whose tx.from is not the wallet is null", () => {
    const entry = withTx(entryOf(SELL_V3), { from: "0x000000000000000000000000000000000000beef" });
    expect(gmgn.decode(entry, WALLET)).toBeNull();
  });

  it("a buy whose FILL amountIn disagrees with tx.value is null", () => {
    const entry = withTx(entryOf(BUY_V3), { value: 20_000_000_000_000_001n });
    expect(gmgn.decode(entry, WALLET)).toBeNull();
    const shaved = withFillData(entryOf(BUY_V4), setWord(fillData(entryOf(BUY_V4)), 0, 999_999_999_999_999n));
    expect(gmgn.decode(shaved, WALLET)).toBeNull();
  });

  it("a buy with no 3-topic Transfer of the token to the wallet is null", () => {
    expect(gmgn.decode(dropLog(entryOf(BUY_V3), isTokenTransfer), WALLET)).toBeNull();
  });

  it("a 4-topic Transfer (ERC-721/404 mint shape) does not satisfy the buy cross-check", () => {
    const entry = mapLog(entryOf(BUY_V4), isTokenTransfer, (l) => ({ ...l, topics: [...l.topics, `0x${word(1n)}` as Hex] }));
    expect(gmgn.decode(entry, WALLET)).toBeNull();
  });

  it("a buy whose token Transfer is for a different token than the path says is null", () => {
    const entry = mapLog(entryOf(BUY_V3), isTokenTransfer, (l) => ({ ...l, address: TOKEN_V4 }));
    expect(gmgn.decode(entry, WALLET)).toBeNull();
  });

  it("a sell with no 3-topic Transfer of the token from the wallet is null", () => {
    expect(gmgn.decode(dropLog(entryOf(SELL_V4), isTokenTransfer), WALLET)).toBeNull();
  });

  it("direction contradiction: value = 0 with a buy-shaped path and token flowing TO the wallet is null", () => {
    // tx.value says sell; the path (WETH → token) and the Transfer (to the wallet) say buy.
    const entry = withTx(entryOf(BUY_V3), { value: 0n });
    expect(gmgn.decode(entry, WALLET)).toBeNull();
  });

  it("direction contradiction: value > 0 with a sell-shaped path is null", () => {
    // Even with amountIn patched to tx.value the path says token → cash, which is not a buy.
    const base = entryOf(SELL_V3);
    const entry = withTx(withFillData(base, setWord(fillData(base), 0, 5n)), { value: 5n });
    expect(gmgn.decode(entry, WALLET)).toBeNull();
  });

  it("a sell whose amountOut is zero is null", () => {
    const base = entryOf(SELL_V4);
    expect(gmgn.decode(withFillData(base, setWord(fillData(base), 1, 0n)), WALLET)).toBeNull();
  });

  it("FILL data that is not exactly 16 words is null", () => {
    const base = entryOf(SELL_V3);
    const fifteen = joinWords(words(fillData(base)).slice(0, 15));
    const seventeen = joinWords([...words(fillData(base)), word(0n)]);
    const ragged = `${fillData(base)}ab` as Hex;
    expect(gmgn.decode(withFillData(base, fifteen), WALLET)).toBeNull();
    expect(gmgn.decode(withFillData(base, seventeen), WALLET)).toBeNull();
    expect(gmgn.decode(withFillData(base, ragged), WALLET)).toBeNull();
  });

  it("an unknown pool kind (w05 ∉ {1, 2}) is null", () => {
    const base = entryOf(BUY_V3);
    expect(gmgn.decode(withFillData(base, setWord(fillData(base), 5, 3n)), WALLET)).toBeNull();
    expect(gmgn.decode(withFillData(base, setWord(fillData(base), 5, 0n)), WALLET)).toBeNull();
  });

  it("a token-for-token path (no cash leg) is null", () => {
    const base = entryOf(BUY_V3);
    const data = setWord(fillData(base), 6, BigInt(TOKEN_V4));
    expect(gmgn.decode(withFillData(base, data), WALLET)).toBeNull();
  });

  it("a path with two cash legs (WETH → address(0)) is null", () => {
    const base = entryOf(BUY_V3);
    const data = setWord(fillData(base), 7, BigInt(ZERO));
    expect(gmgn.decode(withFillData(base, data), WALLET)).toBeNull();
  });

  it("a path word that does not fit an address is null", () => {
    const base = entryOf(SELL_V4);
    const data = setWord(fillData(base), 6, 1n << 160n);
    expect(gmgn.decode(withFillData(base, data), WALLET)).toBeNull();
  });

  it("FEE data with fewer than two words is null", () => {
    const entry = mapLog(entryOf(SELL_V3), isFee, (l) => ({ ...l, data: joinWords(words(l.data).slice(0, 1)) }));
    expect(gmgn.decode(entry, WALLET)).toBeNull();
  });

  it("the fee is taken from the FEE log, not inferred: patching it moves the sell gross by the same amount", () => {
    const entry = mapLog(entryOf(SELL_V3), isFee, (l) => ({ ...l, data: setWord(l.data, 0, 1_000n) }));
    const fill = gmgn.decode(entry, WALLET);
    expect(fill?.feeWei).toBe(1_000n);
    expect(fill?.notionalWei).toBe(22_028_796_312_911_738n + 1_000n);
  });
});

// ── the registry ────────────────────────────────────────────────────────────────────────────────

describe("VENUES and decodeVenueFill", () => {
  it("lists gmgn first (trust order)", () => {
    expect(VENUES[0]).toBe(gmgn);
    expect(VENUES.map((v) => v.name)).toEqual(["gmgn"]);
  });

  it("returns the first decoder's fill, whose venue is that decoder's name", () => {
    const fill = decodeVenueFill(entryOf(SELL_V3), WALLET);
    expect(fill?.venue).toBe(gmgn.name);
    expect(fill?.notionalWei).toBe(22_251_309_406_981_553n);
  });

  it("returns null when no decoder recognises the transaction", () => {
    for (const [, hash] of NOT_FILLS) expect(decodeVenueFill(entryOf(hash), WALLET)).toBeNull();
  });

  it("honours trust order: a decoder that answers null passes through, the first non-null wins", () => {
    const calls: string[] = [];
    const silent: VenueDecoder = { name: "silent", decode: () => (calls.push("silent"), null) };
    const loud: VenueDecoder = {
      name: "loud",
      decode: () => (calls.push("loud"), { side: "buy", venue: "loud", tokenIn: "native", tokenOut: TOKEN_V3, notionalWei: 1n, feeWei: 0n }),
    };
    const never: VenueDecoder = { name: "never", decode: () => { throw new Error("must not be reached"); } };
    const fill = decodeVenueFill(entryOf(BUY_V3), WALLET, [silent, loud, never]);
    expect(fill?.venue).toBe("loud");
    expect(fill?.notionalWei).toBe(1n);
    expect(calls).toEqual(["silent", "loud"]);
  });
});
