// The ledger, both backends.
//
// The memory ledger is the reference: every rule in src/ledger/pg.ts is proved against it with fills
// built from the recorded mainnet fixture and the truths of DESIGN.md §1. The Postgres backend is
// proved without a database: a fake session records every statement and its parameters, so what is
// checked is the SQL path — lock before DDL, DDL in order, lowercase and stringified parameters,
// transactions that roll back on a refusal, bigints parsed back from decimal strings, and the
// connection settings ported from the old keeper. The schema itself is pinned: structurally (the
// columns DESIGN.md names, wei as numeric(78,0), lowercase CHECKs, re-runnable statements) and by
// hash, so a drift is a deliberate edit of this file, never an accident.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { describe, expect, it } from "vitest";

import {
  LedgerBusyError,
  LedgerClosedError,
  LedgerConflictError,
  LedgerConnectionLostError,
  LedgerIdentityMismatchError,
  LedgerInputError,
  SIP_WORKER_LOCK_NAME,
  advisoryKeyFor,
  memoryLedger,
  openPgLedger,
  pgClientConfig,
  sslOptionsFor,
  workerApplicationName,
  type LockHolder,
  type PgSession,
  type SipLedger,
} from "../src/ledger/pg.js";
import { EXCLUSION_REASONS, PULL_OUTCOMES, REFUSAL_REASONS, SCHEMA_SQL, SIP_TABLES, WINDOW_STATUSES } from "../src/ledger/schema.js";
import type {
  Address,
  BlockRefusal,
  Exclusion,
  ExclusionReason,
  Fill,
  Hex,
  PullIntent,
  PullOutcome,
  RefusalReason,
  SettlementAttestation,
  VolumeWindow,
  WindowStatus,
} from "../src/types.js";

// ── the fixture, as the reconciler would have reduced it ─────────────────────

const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/mainnet-4663.json", import.meta.url), "utf8")) as Record<string, unknown>;
const WALLET: Address = "0xc455bf7f16ebbc2b07cb26d1dd46194977974e7d";
const VAULT: Address = "0x1111111111111111111111111111111111111111";
const OTHER_WALLET: Address = "0x2222222222222222222222222222222222222222";
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const padTopic = (address: string): string => `0x${"0".repeat(24)}${address.slice(2)}`;

interface FixtureReceipt {
  readonly blockNumber: string;
  readonly transactionIndex: string;
  readonly logs: readonly { readonly address: string; readonly topics: readonly string[] }[];
}

function receiptOf(hash: Hex): FixtureReceipt {
  const found = FIXTURE[`eth_getTransactionReceipt|${JSON.stringify([hash])}`];
  if (found === undefined || found === null) throw new Error(`fixture lacks the receipt of ${hash}`);
  return found as FixtureReceipt;
}

/** DESIGN.md §1, the four GMGN fills: gross notional and fee are the pinned truths; block, index and token leg come from the receipt. */
const TRUTH = [
  { tx: "0x27259f99e2cbc54ff51e7193e020af3b3f69c021347448da59665c33c2eef882", side: "buy", notional: 20_000_000_000_000_000n, fee: 200_000_000_000_000n, block: 22080593n, index: 1 },
  { tx: "0x5578486de21142788e3affadba58474f3bc37c68121ee232c8e16780513b8ae7", side: "buy", notional: 1_000_000_000_000_000n, fee: 10_000_000_000_000n, block: 21787563n, index: 26 },
  { tx: "0x0688bd572526847b44963792025681b36e02cb42c7ce1470ed2476654ce4570d", side: "sell", notional: 22_251_309_406_981_553n, fee: 222_513_094_069_815n, block: 22080837n, index: 7 },
  { tx: "0x0e5cd4ab4658c2a97eb64f02b42de93529ca9e45750c661621fca7f3eded6db7", side: "sell", notional: 906_846_740_302_383n, fee: 9_068_467_403_023n, block: 21787635n, index: 54 },
] as const;

function fixtureFills(): Fill[] {
  return TRUTH.map((t) => {
    const receipt = receiptOf(t.tx);
    const blockL2 = BigInt(receipt.blockNumber);
    const txIndex = Number(receipt.transactionIndex);
    expect(blockL2).toBe(t.block);
    expect(txIndex).toBe(t.index);
    const legTopic = t.side === "buy" ? 2 : 1;
    const token = receipt.logs.find(
      (l) => l.topics.length === 3 && l.topics[0] === TRANSFER && l.topics[legTopic] === padTopic(WALLET) && l.address.toLowerCase() !== WETH,
    );
    if (token === undefined) throw new Error(`no token leg in ${t.tx}`);
    const tokenAddress = token.address.toLowerCase() as Address;
    return {
      wallet: WALLET,
      txHash: t.tx,
      blockL2,
      txIndex,
      side: t.side,
      venue: "gmgn",
      tokenIn: t.side === "buy" ? "native" : tokenAddress,
      tokenOut: t.side === "buy" ? tokenAddress : "native",
      notionalWei: t.notional,
      feeWei: t.fee,
      source: "venue",
    };
  });
}

/** DESIGN.md §1, the exclusions. */
const EXCLUDED = [
  { tx: "0x37ba3063845c5e9bebf760d4aadb19723e9fbd6130e22249df6a06c27559b823", reason: "WETH_WRAP" },
  { tx: "0x88d5bf234f12dbdab839baecb602e82892ee8fe42d1fd51b641088d6f2f3e1c9", reason: "AIRDROP" },
  { tx: "0xd342d117634464f9c6c5b9b463dd8c0be1e638fdf623ea78334a097ad1cad186", reason: "NOT_A_TRADE" },
  { tx: "0xfdbaab699ee58900bcbdf63fc7a3a55ff86b7edf92b128dca8169c5f5c722617", reason: "NOT_A_TRADE" },
  { tx: "0x79f102cb36d09fef851dc9b8d05ebc01e3cf2db00bdf2c7172f6493e8caeaee7", reason: "NOT_A_TRADE" },
] as const;

function fixtureExclusions(): Exclusion[] {
  return EXCLUDED.map((e) => ({ wallet: WALLET, txHash: e.tx, blockL2: BigInt(receiptOf(e.tx).blockNumber), reason: e.reason }));
}

const SUM_NOTIONAL = TRUTH.reduce((acc, t) => acc + t.notional, 0n);
const SAVINGS_BPS = 20;
const owedFor = (sum: bigint): bigint => (sum * BigInt(SAVINGS_BPS)) / 10_000n;
const ROOT_A: Hex = `0x${"a".repeat(64)}`;
const ROOT_B: Hex = `0x${"b".repeat(64)}`;
const ROOT_C: Hex = `0x${"c".repeat(64)}`;

function windowOf(fills: readonly Fill[], startL2: bigint, endL2: bigint, batchRoot: Hex = ROOT_A, wallet: Address = WALLET): VolumeWindow {
  const sumNotionalWei = fills.reduce((acc, f) => acc + f.notionalWei, 0n);
  return { wallet, vault: VAULT, startL2, endL2, fills, sumNotionalWei, savingsBps: SAVINGS_BPS, owedWei: owedFor(sumNotionalWei), batchRoot };
}

const ZERO32: Hex = `0x${"0".repeat(64)}`;
function attestationOf(window: VolumeWindow, contribution: bigint): SettlementAttestation {
  return {
    chainId: 4663n,
    vault: window.vault,
    account: window.wallet,
    executor: "0xfa92abf15dfaf470cc8833cb01464bd6ca139e16",
    bindingEpoch: 1n,
    policyNonce: 0n,
    settlementNonce: 0n,
    adminEpoch: 0n,
    localPauseEpoch: 0n,
    globalPauseEpoch: 0n,
    attesterEpoch: 0n,
    policyHash: ZERO32,
    sessionId: ZERO32,
    ledgerRoot: window.batchRoot,
    startBlock: 100n,
    endBlock: 101n,
    startBlockL2: window.startL2,
    endBlockL2: window.endL2,
    cashStart: 0n,
    cashEnd: window.sumNotionalWei,
    externalDeposits: 0n,
    externalWithdrawals: 0n,
    realizedProfit: window.sumNotionalWei,
    contribution,
    validAfter: 1_000n,
    deadline: 1_660n,
  };
}

function intentOf(window: VolumeWindow, contribution: bigint, txHash: Hex, nonce = 7): PullIntent {
  return { window, attestation: attestationOf(window, contribution), signature: `0x${"1".repeat(130)}`, contributionWei: contribution, nonce, rawTx: "0x02f8aa", txHash };
}

async function seeded(): Promise<{ ledger: SipLedger; fills: Fill[] }> {
  const ledger = memoryLedger();
  await ledger.upsertWallets([{ address: WALLET, vault: VAULT }]);
  const fills = fixtureFills();
  await ledger.recordFills(fills);
  return { ledger, fills };
}

const sortedByBlock = (fills: readonly Fill[]): Fill[] => [...fills].sort((a, b) => (a.blockL2 < b.blockL2 ? -1 : a.blockL2 > b.blockL2 ? 1 : a.txIndex - b.txIndex));

// ── the memory ledger, rule by rule ──────────────────────────────────────────

describe("memory ledger: wallets", () => {
  it("a new wallet starts at the initial cursor with zero totals; a re-upsert refreshes the vault and nothing else", async () => {
    const ledger = memoryLedger({ initialCursorL2: 21_000_000n });
    await ledger.upsertWallets([{ address: WALLET, vault: VAULT }]);
    await ledger.advanceCursor(WALLET, 21_500_000n);
    await ledger.addOwed(WALLET, 5n);
    const other: Address = "0x3333333333333333333333333333333333333333";
    await ledger.upsertWallets([{ address: WALLET, vault: other }]);
    expect(await ledger.walletStates()).toEqual([{ wallet: WALLET, vault: other, cursorL2: 21_500_000n, owedTotalWei: 5n, collectedTotalWei: 0n }]);
  });

  it("lowercases addresses, orders states by address, and refuses what is not an address", async () => {
    const ledger = memoryLedger();
    await ledger.upsertWallets([
      { address: "0xC455BF7F16EBBC2B07CB26D1DD46194977974E7D", vault: VAULT.toUpperCase().replace("0X", "0x") as Address },
      { address: OTHER_WALLET, vault: VAULT },
    ]);
    const states = await ledger.walletStates();
    expect(states.map((s) => s.wallet)).toEqual([OTHER_WALLET, WALLET]);
    expect(states[1]?.vault).toBe(VAULT);
    await expect(ledger.upsertWallets([{ address: "0x1234" as Address, vault: VAULT }])).rejects.toBeInstanceOf(LedgerInputError);
  });

  it("owed and collected accumulate; owed - collected is the debt that carries forward (the savings rule)", async () => {
    const ledger = memoryLedger();
    await ledger.upsertWallets([{ address: WALLET, vault: VAULT }]);
    await ledger.addOwed(WALLET, 2n);
    await ledger.addOwed(WALLET, 3n);
    await ledger.addCollected(WALLET, 4n);
    const [state] = await ledger.walletStates();
    expect(state?.owedTotalWei).toBe(5n);
    expect(state?.collectedTotalWei).toBe(4n);
    expect((state?.owedTotalWei ?? 0n) - (state?.collectedTotalWei ?? 0n)).toBe(1n);
    await expect(ledger.addOwed(WALLET, -1n)).rejects.toBeInstanceOf(LedgerInputError);
    await expect(ledger.addOwed(OTHER_WALLET, 1n)).rejects.toBeInstanceOf(LedgerConflictError);
    await expect(ledger.addCollected(OTHER_WALLET, 1n)).rejects.toBeInstanceOf(LedgerConflictError);
  });

  it("the cursor only moves forward: a lagging head is nothing to close, not a rewind", async () => {
    const ledger = memoryLedger();
    await ledger.upsertWallets([{ address: WALLET, vault: VAULT }]);
    await ledger.advanceCursor(WALLET, 100n);
    await ledger.advanceCursor(WALLET, 90n);
    expect((await ledger.walletStates())[0]?.cursorL2).toBe(100n);
    await ledger.advanceCursor(WALLET, 100n);
    expect((await ledger.walletStates())[0]?.cursorL2).toBe(100n);
    await expect(ledger.advanceCursor(WALLET, -1n)).rejects.toBeInstanceOf(LedgerInputError);
    await expect(ledger.advanceCursor(OTHER_WALLET, 1n)).rejects.toBeInstanceOf(LedgerConflictError);
  });
});

describe("memory ledger: fills", () => {
  it("records the four fixture fills and returns them oldest first, exactly as recorded", async () => {
    const { ledger, fills } = await seeded();
    const got = await ledger.unwindowedFills(WALLET, 30_000_000n);
    expect(got).toEqual(sortedByBlock(fills));
    expect(got.map((f) => f.blockL2)).toEqual([21787563n, 21787635n, 22080593n, 22080837n]);
    expect(got.reduce((acc, f) => acc + f.notionalWei, 0n)).toBe(SUM_NOTIONAL);
    // A buy's notional is tx.value; a sell's is gross (net + fee). Both pinned in DESIGN.md §1.
    expect(got[2]).toMatchObject({ side: "buy", notionalWei: 20_000_000_000_000_000n, tokenIn: "native" });
    expect(got[3]).toMatchObject({ side: "sell", notionalWei: 22_028_796_312_911_738n + 222_513_094_069_815n, tokenOut: "native" });
  });

  it("throughL2 is inclusive and the wallet filter is exact", async () => {
    const { ledger } = await seeded();
    expect((await ledger.unwindowedFills(WALLET, 21787635n)).map((f) => f.blockL2)).toEqual([21787563n, 21787635n]);
    expect((await ledger.unwindowedFills(WALLET, 21787634n)).map((f) => f.blockL2)).toEqual([21787563n]);
    expect(await ledger.unwindowedFills(OTHER_WALLET, 30_000_000n)).toEqual([]);
  });

  it("re-recording is idempotent; an unwindowed fill may change; a windowed one may not", async () => {
    const { ledger, fills } = await seeded();
    const [first] = fills;
    if (first === undefined) throw new Error("no fills");
    await ledger.recordFills(fills);
    expect(await ledger.unwindowedFills(WALLET, 30_000_000n)).toHaveLength(4);

    // Retried block, better decode: the unwindowed row follows.
    await ledger.recordFills([{ ...first, notionalWei: first.notionalWei + 1n, source: "residual" }]);
    const changed = (await ledger.unwindowedFills(WALLET, 30_000_000n)).find((f) => f.txHash === first.txHash);
    expect(changed).toMatchObject({ notionalWei: first.notionalWei + 1n, source: "residual" });

    await ledger.recordFills([first]);
    await ledger.openWindow(windowOf([first], first.blockL2, first.blockL2));
    await expect(ledger.recordFills([first])).resolves.toBeUndefined();
    await expect(ledger.recordFills([{ ...first, notionalWei: 1n }])).rejects.toBeInstanceOf(LedgerConflictError);
  });

  it("refuses a fill for a wallet it does not know, malformed hashes, and negative wei", async () => {
    const ledger = memoryLedger();
    const [fill] = fixtureFills();
    if (fill === undefined) throw new Error("no fills");
    await expect(ledger.recordFills([fill])).rejects.toBeInstanceOf(LedgerConflictError);
    await ledger.upsertWallets([{ address: WALLET, vault: VAULT }]);
    await expect(ledger.recordFills([{ ...fill, txHash: "0xabc" as Hex }])).rejects.toBeInstanceOf(LedgerInputError);
    await expect(ledger.recordFills([{ ...fill, notionalWei: -1n }])).rejects.toBeInstanceOf(LedgerInputError);
    await expect(ledger.recordFills([{ ...fill, txIndex: -1 }])).rejects.toBeInstanceOf(LedgerInputError);
  });

  it("records the fixture's exclusions with their reasons and upserts on (wallet, tx)", async () => {
    const { ledger } = await seeded();
    const exclusions = fixtureExclusions();
    await ledger.recordExclusions(exclusions);
    await ledger.recordExclusions(exclusions);
    const got = await ledger.exclusions(WALLET);
    expect(got).toHaveLength(5);
    expect(got.map((e) => e.reason).sort()).toEqual(["AIRDROP", "NOT_A_TRADE", "NOT_A_TRADE", "NOT_A_TRADE", "WETH_WRAP"]);
    expect(got.find((e) => e.txHash.startsWith("0x37ba3063"))).toMatchObject({ reason: "WETH_WRAP", blockL2: 21774627n });
    // Exclusions never become fills.
    expect(await ledger.unwindowedFills(WALLET, 30_000_000n)).toHaveLength(4);
    expect(await ledger.exclusions(OTHER_WALLET)).toEqual([]);
  });
});

describe("memory ledger: refusals (§3.5, §4)", () => {
  it("a refusal voids the block's unwindowed fills, hides the block from the window builder, and counts its sightings", async () => {
    const { ledger, fills } = await seeded();
    const refused = sortedByBlock(fills)[2];
    if (refused === undefined) throw new Error("no fills");
    const refusal: BlockRefusal = { wallet: WALLET, blockL2: refused.blockL2, reason: "STATE_UNAVAILABLE", detail: "eth_getBalance at N-1 timed out" };
    await ledger.recordRefusals([refusal]);
    expect((await ledger.unwindowedFills(WALLET, 30_000_000n)).map((f) => f.txHash)).not.toContain(refused.txHash);

    await ledger.recordRefusals([{ ...refusal, reason: "UNEXPLAINED_INFLOW", detail: "+58 wei" }]);
    const [stored] = await ledger.refusals(WALLET);
    expect(stored).toMatchObject({ wallet: WALLET, blockL2: refused.blockL2, reason: "UNEXPLAINED_INFLOW", detail: "+58 wei", timesSeen: 2 });
    expect(stored?.firstSeenAt).toBeDefined();
    expect(await ledger.refusals(OTHER_WALLET)).toEqual([]);

    // Recording a fill for the block afterwards, in the documented order, is the retry succeeding.
    await ledger.recordFills([refused]);
    expect(await ledger.refusals(WALLET)).toEqual([]);
    expect((await ledger.unwindowedFills(WALLET, 30_000_000n)).map((f) => f.txHash)).toContain(refused.txHash);
  });

  it("an exclusion on the block, or an explicit clear, lifts the refusal too", async () => {
    const { ledger } = await seeded();
    await ledger.recordRefusals([
      { wallet: WALLET, blockL2: 22_000_000n, reason: "MULTI_FILL_BLOCK" },
      { wallet: WALLET, blockL2: 22_000_001n, reason: "UNDECODED_SELL" },
    ]);
    await ledger.recordExclusions([{ wallet: WALLET, txHash: ROOT_B, blockL2: 22_000_000n, reason: "REVERTED" }]);
    expect((await ledger.refusals(WALLET)).map((r) => r.blockL2)).toEqual([22_000_001n]);
    await ledger.clearRefusals(WALLET, [22_000_001n]);
    expect(await ledger.refusals(WALLET)).toEqual([]);
  });

  it("a refusal recorded after a fill of the same block wins: unwindowedFills hides it and openWindow refuses it", async () => {
    const { ledger, fills } = await seeded();
    const [a] = sortedByBlock(fills);
    if (a === undefined) throw new Error("no fills");
    await ledger.recordRefusals([{ wallet: WALLET, blockL2: a.blockL2, reason: "WALLET_HAS_CODE" }]);
    expect((await ledger.unwindowedFills(WALLET, 30_000_000n)).map((f) => f.txHash)).not.toContain(a.txHash);
    // Even a caller holding the fill object cannot window it while the block is refused.
    await ledger.recordFills([a]);
    await ledger.recordRefusals([{ wallet: WALLET, blockL2: a.blockL2, reason: "WALLET_HAS_CODE" }]);
    await expect(ledger.openWindow(windowOf([a], a.blockL2, a.blockL2))).rejects.toBeInstanceOf(LedgerConflictError);
  });

  it("never voids a windowed fill: it was attested", async () => {
    const { ledger, fills } = await seeded();
    const [a] = sortedByBlock(fills);
    if (a === undefined) throw new Error("no fills");
    const id = await ledger.openWindow(windowOf([a], a.blockL2, a.blockL2));
    await ledger.recordRefusals([{ wallet: WALLET, blockL2: a.blockL2, reason: "STATE_UNAVAILABLE" }]);
    const [window] = await ledger.windows({ wallet: WALLET });
    expect(window?.id).toBe(id);
    expect(window?.fills.map((f) => f.txHash)).toEqual([a.txHash]);
  });

  it("refuses a refusal for an unknown wallet", async () => {
    const ledger = memoryLedger();
    await expect(ledger.recordRefusals([{ wallet: WALLET, blockL2: 1n, reason: "INCOMPLETE_RANGE" }])).rejects.toBeInstanceOf(LedgerConflictError);
  });
});

describe("memory ledger: windows (§4)", () => {
  it("closes a window: tags its fills, returns an id, and hands them back with the window", async () => {
    const { ledger, fills } = await seeded();
    const ordered = sortedByBlock(fills);
    const window = windowOf(ordered, 1n, 22_100_000n);
    const id = await ledger.openWindow(window);
    expect(id).toBe(1);
    expect(await ledger.unwindowedFills(WALLET, 30_000_000n)).toEqual([]);
    const [stored] = await ledger.windows({ wallet: WALLET, status: "OPEN" });
    expect(stored).toMatchObject({ id, wallet: WALLET, vault: VAULT, startL2: 1n, endL2: 22_100_000n, sumNotionalWei: SUM_NOTIONAL, owedWei: owedFor(SUM_NOTIONAL), savingsBps: SAVINGS_BPS, batchRoot: ROOT_A, status: "OPEN", detail: null });
    expect(stored?.fills).toEqual(ordered);
    expect(await ledger.windows({ status: "SIGNED" })).toEqual([]);
  });

  it("closes only up to the block before the first refusal; the fills after it wait, then close in a second window", async () => {
    const { ledger, fills } = await seeded();
    const ordered = sortedByBlock(fills);
    const refusedBlock = 22_080_600n; // between the third and fourth fixture fills, itself fill-less
    await ledger.recordRefusals([{ wallet: WALLET, blockL2: refusedBlock, reason: "UNEXPLAINED_INFLOW", detail: "+1 wei" }]);
    const head = 22_090_000n;
    const margin = 64n;
    const closeAt = refusedBlock - 1n; // §4: the block before the first refused block, not head - margin
    const first = await ledger.unwindowedFills(WALLET, closeAt);
    expect(first.map((f) => f.blockL2)).toEqual([21787563n, 21787635n, 22080593n]);
    const w1 = windowOf(first, 1n, closeAt, ROOT_A);
    const id1 = await ledger.openWindow(w1);
    await ledger.advanceCursor(WALLET, closeAt);
    await ledger.addOwed(WALLET, w1.owedWei);
    expect((await ledger.unwindowedFills(WALLET, head - margin)).map((f) => f.blockL2)).toEqual([22080837n]);

    // The refusal cleared on a later tick (state read succeeded): the rest closes from cursor + 1.
    await ledger.clearRefusals(WALLET, [refusedBlock]);
    const [cursorState] = await ledger.walletStates();
    const second = await ledger.unwindowedFills(WALLET, head - margin);
    const w2 = windowOf(second, (cursorState?.cursorL2 ?? 0n) + 1n, head - margin, ROOT_B);
    const id2 = await ledger.openWindow(w2);
    await ledger.advanceCursor(WALLET, head - margin);
    await ledger.addOwed(WALLET, w2.owedWei);
    expect(id2).toBe(id1 + 1);
    expect(await ledger.unwindowedFills(WALLET, head)).toEqual([]);
    const [state] = await ledger.walletStates();
    expect(state?.cursorL2).toBe(head - margin);
    expect(state?.owedTotalWei).toBe(owedFor(w1.sumNotionalWei) + owedFor(w2.sumNotionalWei));
    expect((await ledger.windows({ wallet: WALLET })).map((w) => [w.startL2, w.endL2])).toEqual([
      [1n, closeAt],
      [closeAt + 1n, head - margin],
    ]);
  });

  it("refuses to window a fill twice, an unknown fill, a fill outside the range, another wallet's fill, or a fill listed twice", async () => {
    const { ledger, fills } = await seeded();
    const [a, b] = sortedByBlock(fills);
    if (a === undefined || b === undefined) throw new Error("no fills");
    await ledger.openWindow(windowOf([a], a.blockL2, a.blockL2, ROOT_A));
    await expect(ledger.openWindow(windowOf([a], a.blockL2 + 1n, a.blockL2 + 1n, ROOT_B))).rejects.toThrow(/already in window 1/);
    const unknown: Fill = { ...b, txHash: ROOT_C };
    await expect(ledger.openWindow(windowOf([unknown], b.blockL2, b.blockL2, ROOT_B))).rejects.toThrow(/not in the ledger/);
    await expect(ledger.openWindow(windowOf([b], b.blockL2 + 1n, b.blockL2 + 5n, ROOT_B))).rejects.toThrow(/outside/);
    await ledger.upsertWallets([{ address: OTHER_WALLET, vault: VAULT }]);
    await expect(ledger.openWindow(windowOf([b], b.blockL2, b.blockL2, ROOT_B, OTHER_WALLET))).rejects.toThrow(/belongs to/);
    await expect(ledger.openWindow(windowOf([b, b], b.blockL2, b.blockL2, ROOT_B))).rejects.toThrow(/listed twice/);
    // Nothing above tagged b: it is still there for the next honest attempt.
    expect((await ledger.unwindowedFills(WALLET, 30_000_000n)).map((f) => f.txHash)).toContain(b.txHash);
  });

  it("refuses an empty window, an inverted range, a savings rate out of range, and a range overlapping a live window — but not a FAILED one", async () => {
    const { ledger, fills } = await seeded();
    const [a, b] = sortedByBlock(fills);
    if (a === undefined || b === undefined) throw new Error("no fills");
    await expect(ledger.openWindow(windowOf([], 1n, 10n))).rejects.toBeInstanceOf(LedgerInputError);
    await expect(ledger.openWindow(windowOf([a], a.blockL2, a.blockL2 - 1n))).rejects.toBeInstanceOf(LedgerInputError);
    await expect(ledger.openWindow({ ...windowOf([a], a.blockL2, a.blockL2), savingsBps: 10_001 })).rejects.toBeInstanceOf(LedgerInputError);
    const id = await ledger.openWindow(windowOf([a], 1n, a.blockL2 + 10n, ROOT_A));
    await expect(ledger.openWindow(windowOf([b], a.blockL2 + 10n, b.blockL2, ROOT_B))).rejects.toThrow(/overlaps live window/);
    await ledger.markWindow(id, "FAILED", { reason: "reverted on chain" });
    // The FAILED window releases its range; its fill stays tagged, so the retry is the same window re-marked, not a new one.
    const id2 = await ledger.openWindow(windowOf([b], a.blockL2 + 10n, b.blockL2, ROOT_B));
    expect(id2).toBe(id + 1);
    await expect(ledger.openWindow(windowOf([a], 1n, a.blockL2, ROOT_C))).rejects.toThrow(/already in window/);
  });

  it("marks status with a bigint-safe detail, keeps the detail when none is given, and treats CONFIRMED as terminal", async () => {
    const { ledger, fills } = await seeded();
    const [a] = sortedByBlock(fills);
    if (a === undefined) throw new Error("no fills");
    const id = await ledger.openWindow(windowOf([a], a.blockL2, a.blockL2));
    await ledger.markWindow(id, "OPEN", { reason: "L1_NOT_ADVANCED", headL1: 123n });
    expect((await ledger.windows())[0]?.detail).toEqual({ reason: "L1_NOT_ADVANCED", headL1: "123" });
    await ledger.markWindow(id, "SIGNED");
    expect((await ledger.windows())[0]).toMatchObject({ status: "SIGNED", detail: { reason: "L1_NOT_ADVANCED" } });
    await ledger.markWindow(id, "SUBMITTED", { txHash: ROOT_B });
    await ledger.markWindow(id, "CONFIRMED", null);
    expect((await ledger.windows())[0]).toMatchObject({ status: "CONFIRMED", detail: null });
    await expect(ledger.markWindow(id, "OPEN")).rejects.toBeInstanceOf(LedgerConflictError);
    await expect(ledger.markWindow(id, "FAILED")).rejects.toBeInstanceOf(LedgerConflictError);
    await expect(ledger.markWindow(id, "CONFIRMED")).resolves.toBeUndefined();
    await expect(ledger.markWindow(999, "OPEN")).rejects.toBeInstanceOf(LedgerConflictError);
  });

  it("a FAILED window may reopen", async () => {
    const { ledger, fills } = await seeded();
    const [a] = sortedByBlock(fills);
    if (a === undefined) throw new Error("no fills");
    const id = await ledger.openWindow(windowOf([a], a.blockL2, a.blockL2));
    await ledger.markWindow(id, "FAILED");
    await ledger.markWindow(id, "OPEN");
    expect((await ledger.windows({ status: "OPEN" })).map((w) => w.id)).toEqual([id]);
  });
});

describe("memory ledger: pulls", () => {
  it("records a dry run (no hash, the would-be contribution), a skip (nothing sent), and a send (hash and nonce)", async () => {
    const { ledger, fills } = await seeded();
    const window = windowOf(sortedByBlock(fills), 1n, 22_100_000n);
    const id = await ledger.openWindow(window);
    const contribution = owedFor(SUM_NOTIONAL);
    const intent = intentOf(window, contribution, ROOT_B, 7);

    const dry: PullOutcome = { kind: "DRY_RUN", intent: { window, attestation: intent.attestation, signature: intent.signature, contributionWei: contribution } };
    await ledger.recordPull(id, null, dry);
    const skipped: PullOutcome = { kind: "SKIPPED", reason: "SEAT_REVOKED", detail: "no app signer on the wallet" };
    await ledger.recordPull(id, null, skipped);
    await ledger.recordPull(id, intent, { kind: "SENT", intent });

    const pulls = await ledger.pulls(id);
    expect(pulls.map((p) => p.outcome)).toEqual(["DRY_RUN", "SKIPPED", "SENT"]);
    expect(pulls[0]).toMatchObject({ windowId: id, txHash: null, nonce: null, contributionWei: contribution });
    expect(pulls[0]?.detail).toMatchObject({ kind: "DRY_RUN", contributionWei: contribution.toString(), attestation: { contribution: contribution.toString(), ledgerRoot: ROOT_A } });
    expect(pulls[1]).toMatchObject({ txHash: null, contributionWei: 0n, detail: { kind: "SKIPPED", reason: "SEAT_REVOKED", detail: "no app signer on the wallet" } });
    expect(pulls[2]).toMatchObject({ txHash: ROOT_B, nonce: 7, contributionWei: contribution });
    expect(pulls[2]?.detail).toMatchObject({ kind: "SENT", rawTx: "0x02f8aa", nonce: 7 });
    // The window's fills are not repeated inside the pull: they are tagged with the window id.
    expect(JSON.stringify(pulls[2]?.detail)).not.toContain('"fills"');
    expect(await ledger.pulls()).toHaveLength(3);
    expect(await ledger.pulls(id + 1)).toEqual([]);
  });

  it("the intent recorded before the send and the outcome after it are one row", async () => {
    const { ledger, fills } = await seeded();
    const window = windowOf(sortedByBlock(fills), 1n, 22_100_000n);
    const id = await ledger.openWindow(window);
    const intent = intentOf(window, 5n, ROOT_B, 3);
    await ledger.recordPull(id, intent, { kind: "SKIPPED", reason: "SIGNER_UNAVAILABLE" });
    await ledger.recordPull(id, intent, { kind: "SENT", intent });
    const pulls = await ledger.pulls(id);
    expect(pulls).toHaveLength(1);
    expect(pulls[0]).toMatchObject({ txHash: ROOT_B, nonce: 3, outcome: "SENT", contributionWei: 5n });
  });

  it("refuses a pull for an unknown window, and a raw tx hash that already belongs to another window", async () => {
    const { ledger, fills } = await seeded();
    const [a, b] = sortedByBlock(fills);
    if (a === undefined || b === undefined) throw new Error("no fills");
    const w1 = windowOf([a], a.blockL2, a.blockL2, ROOT_A);
    const w2 = windowOf([b], b.blockL2, b.blockL2, ROOT_B);
    const id1 = await ledger.openWindow(w1);
    const id2 = await ledger.openWindow(w2);
    const intent = intentOf(w1, 1n, ROOT_C);
    await expect(ledger.recordPull(99, intent, { kind: "SENT", intent })).rejects.toBeInstanceOf(LedgerConflictError);
    await ledger.recordPull(id1, intent, { kind: "SENT", intent });
    await expect(ledger.recordPull(id2, intent, { kind: "SENT", intent })).rejects.toBeInstanceOf(LedgerConflictError);
  });
});

describe("memory ledger: close", () => {
  it("is idempotent and every call afterwards throws", async () => {
    const ledger = memoryLedger();
    await ledger.close();
    await ledger.close();
    await expect(ledger.walletStates()).rejects.toBeInstanceOf(LedgerClosedError);
    await expect(ledger.upsertWallets([])).rejects.toBeInstanceOf(LedgerClosedError);
    await expect(ledger.recordFills([])).rejects.toBeInstanceOf(LedgerClosedError);
    await expect(ledger.addOwed(WALLET, 1n)).rejects.toBeInstanceOf(LedgerClosedError);
  });
});

// ── the schema, pinned ───────────────────────────────────────────────────────

/** The statement that creates a table, with its body. */
function tableDdl(name: string): string {
  const found = SCHEMA_SQL.find((s) => s.startsWith(`CREATE TABLE IF NOT EXISTS ${name} (`));
  if (found === undefined) throw new Error(`no CREATE TABLE for ${name}`);
  return found;
}

function columnsOf(name: string): string[] {
  const body = tableDdl(name).slice(tableDdl(name).indexOf("(") + 1);
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[a-z0-9_]+\s/.test(line) && !/^(CHECK|PRIMARY|FOREIGN|UNIQUE)\b/.test(line))
    .map((line) => line.split(/\s+/)[0] ?? "");
}

describe("schema", () => {
  it("is pinned: a change here is a deliberate edit, never drift", () => {
    expect(SCHEMA_SQL).toHaveLength(29);
    expect(createHash("sha256").update(SCHEMA_SQL.join("\n")).digest("hex")).toBe("3081ada790f3efcf4e1b02300607eab7d3fc52a291f096c1b1440268154c76fc");
  });

  it("is re-runnable, one statement per element, syntactically balanced, and free of bind placeholders", () => {
    const openers = /^(CREATE TABLE IF NOT EXISTS|CREATE UNIQUE INDEX IF NOT EXISTS|CREATE INDEX IF NOT EXISTS|CREATE OR REPLACE FUNCTION|DROP TRIGGER IF EXISTS|CREATE TRIGGER) /;
    for (const statement of SCHEMA_SQL) {
      expect(statement).toMatch(openers);
      expect(statement.trimEnd().endsWith(";")).toBe(true);
      expect((statement.match(/\(/g) ?? []).length).toBe((statement.match(/\)/g) ?? []).length);
      expect((statement.match(/\$\$/g) ?? []).length % 2).toBe(0);
      expect(statement).not.toMatch(/\$[0-9]/);
      // Only a function body may carry more than one semicolon.
      if (!statement.startsWith("CREATE OR REPLACE FUNCTION")) expect((statement.match(/;/g) ?? []).length).toBe(1);
    }
    // Every trigger is dropped before it is created, so the list re-runs.
    const triggers = SCHEMA_SQL.filter((s) => s.startsWith("CREATE TRIGGER ")).map((s) => s.split(/\s+/)[2]);
    for (const name of triggers) expect(SCHEMA_SQL.some((s) => s.startsWith(`DROP TRIGGER IF EXISTS ${name} ON`))).toBe(true);
  });

  it("creates the six tables of DESIGN.md §2 plus the identity pin, and sip_window before the fill that references it", () => {
    for (const name of SIP_TABLES) expect(() => tableDdl(name)).not.toThrow();
    const order = SCHEMA_SQL.filter((s) => s.startsWith("CREATE TABLE")).map((s) => s.split(/\s+/)[5]);
    expect(order).toEqual([...SIP_TABLES]);
    expect(order.indexOf("sip_window")).toBeLessThan(order.indexOf("sip_fill"));
  });

  it("carries the columns DESIGN.md names, with the primary keys it names", () => {
    expect(columnsOf("sip_wallet")).toEqual(expect.arrayContaining(["address", "vault", "cursor_l2", "owed_total_wei", "collected_total_wei"]));
    expect(tableDdl("sip_wallet")).toMatch(/address\s+TEXT PRIMARY KEY/);
    expect(columnsOf("sip_fill")).toEqual(
      expect.arrayContaining(["wallet", "tx_hash", "block_l2", "tx_index", "side", "venue", "token_in", "token_out", "notional_wei", "fee_wei", "source", "window_id"]),
    );
    expect(tableDdl("sip_fill")).toContain("PRIMARY KEY (wallet, tx_hash)");
    expect(tableDdl("sip_fill")).toMatch(/window_id\s+INTEGER REFERENCES sip_window\(id\)/);
    expect(columnsOf("sip_exclusion")).toEqual(expect.arrayContaining(["wallet", "tx_hash", "block_l2", "reason"]));
    expect(columnsOf("sip_refusal")).toEqual(expect.arrayContaining(["wallet", "block_l2", "reason", "detail"]));
    expect(tableDdl("sip_refusal")).toContain("PRIMARY KEY (wallet, block_l2)");
    expect(columnsOf("sip_window")).toEqual(
      expect.arrayContaining(["id", "wallet", "vault", "start_l2", "end_l2", "batch_root", "sum_notional_wei", "owed_wei", "status", "detail"]),
    );
    expect(tableDdl("sip_window")).toMatch(/id\s+SERIAL PRIMARY KEY/);
    expect(tableDdl("sip_window")).toMatch(/detail\s+JSONB/);
    expect(columnsOf("sip_pull")).toEqual(expect.arrayContaining(["window_id", "tx_hash", "nonce", "contribution_wei", "outcome", "detail"]));
  });

  it("holds wei as numeric(78,0), heights as BIGINT, and addresses and hashes as lowercase-checked text", () => {
    for (const statement of SCHEMA_SQL.filter((s) => s.startsWith("CREATE TABLE"))) {
      for (const line of statement.split("\n")) {
        const column = line.trim().split(/\s+/)[0] ?? "";
        if (column.endsWith("_wei")) expect(line).toMatch(/NUMERIC\(78,0\)/);
        if (column.endsWith("_l2")) expect(line).toMatch(/\bBIGINT\b/);
        if (column === "tx_hash" || column === "batch_root") expect(line).toContain("~ '^0x[0-9a-f]{64}$'");
        if (column === "address" || column === "vault" || column === "factory" || column === "executor") expect(line).toContain("~ '^0x[0-9a-f]{40}$'");
      }
    }
    expect(tableDdl("sip_fill")).toContain("token_in = 'native' OR token_in ~ '^0x[0-9a-f]{40}$'");
  });

  it("states the load-bearing rules as constraints: one live window per bound and root, windowed fills immutable, CONFIRMED terminal", () => {
    expect(SCHEMA_SQL).toContain("CREATE UNIQUE INDEX IF NOT EXISTS sip_window_live_start ON sip_window(wallet, start_l2) WHERE status <> 'FAILED';");
    expect(SCHEMA_SQL).toContain("CREATE UNIQUE INDEX IF NOT EXISTS sip_window_live_end ON sip_window(wallet, end_l2) WHERE status <> 'FAILED';");
    expect(SCHEMA_SQL).toContain("CREATE UNIQUE INDEX IF NOT EXISTS sip_window_live_root ON sip_window(wallet, batch_root) WHERE status <> 'FAILED';");
    expect(SCHEMA_SQL).toContain("CREATE UNIQUE INDEX IF NOT EXISTS sip_pull_tx_hash ON sip_pull(tx_hash) WHERE tx_hash IS NOT NULL;");
    const fillGuard = SCHEMA_SQL.find((s) => s.startsWith("CREATE OR REPLACE FUNCTION sip_fill_guard()"));
    expect(fillGuard).toContain("OLD.window_id IS NOT NULL AND NEW.window_id IS DISTINCT FROM OLD.window_id");
    expect(fillGuard).toContain("NEW.notional_wei IS DISTINCT FROM OLD.notional_wei");
    const windowGuard = SCHEMA_SQL.find((s) => s.startsWith("CREATE OR REPLACE FUNCTION sip_window_guard()"));
    expect(windowGuard).toContain("OLD.status = 'CONFIRMED' AND NEW.status IS DISTINCT FROM OLD.status");
    expect(windowGuard).toContain("NEW.batch_root       IS DISTINCT FROM OLD.batch_root");
    expect(SCHEMA_SQL.some((s) => s.startsWith("CREATE TRIGGER sip_fill_keep_windowed BEFORE DELETE ON sip_fill"))).toBe(true);
    expect(SCHEMA_SQL.some((s) => s.startsWith("CREATE TRIGGER sip_window_keep BEFORE DELETE ON sip_window"))).toBe(true);
  });

  it("enumerations mirror src/types.ts in both directions", () => {
    // Compile-time, both ways: every DDL value is a type member, and every type member is in the DDL.
    const exclusions: readonly ExclusionReason[] = EXCLUSION_REASONS;
    const refusals: readonly RefusalReason[] = REFUSAL_REASONS;
    const statuses: readonly WindowStatus[] = WINDOW_STATUSES;
    const outcomes: readonly PullOutcome["kind"][] = PULL_OUTCOMES;
    const everyExclusion: Record<ExclusionReason, true> = { TOKEN_FOR_TOKEN: true, WETH_WRAP: true, AIRDROP: true, NOT_A_TRADE: true, SELF_TRANSFER: true, REVERTED: true };
    const everyRefusal: Record<RefusalReason, true> = { MULTI_FILL_BLOCK: true, UNEXPLAINED_INFLOW: true, WALLET_HAS_CODE: true, STATE_UNAVAILABLE: true, INCOMPLETE_RANGE: true, UNDECODED_SELL: true };
    const everyStatus: Record<WindowStatus, true> = { OPEN: true, SIGNED: true, SUBMITTED: true, CONFIRMED: true, FAILED: true };
    const everyOutcome: Record<PullOutcome["kind"], true> = { DRY_RUN: true, SENT: true, SKIPPED: true };
    expect([...exclusions].sort()).toEqual(Object.keys(everyExclusion).sort());
    expect([...refusals].sort()).toEqual(Object.keys(everyRefusal).sort());
    expect([...statuses].sort()).toEqual(Object.keys(everyStatus).sort());
    expect([...outcomes].sort()).toEqual(Object.keys(everyOutcome).sort());
    // And the DDL carries each list verbatim.
    for (const reason of exclusions) expect(tableDdl("sip_exclusion")).toContain(`'${reason}'`);
    for (const reason of refusals) expect(tableDdl("sip_refusal")).toContain(`'${reason}'`);
    for (const status of statuses) expect(tableDdl("sip_window")).toContain(`'${status}'`);
    for (const outcome of outcomes) expect(tableDdl("sip_pull")).toContain(`'${outcome}'`);
  });
});

// ── the Postgres backend, against a fake session ─────────────────────────────

interface Call {
  readonly text: string;
  readonly values: readonly unknown[];
}

type Answer = (values: readonly unknown[]) => { rows: unknown[]; rowCount: number | null };

interface Fake {
  readonly session: PgSession;
  readonly calls: Call[];
  readonly sql: () => string[];
  readonly ended: () => boolean;
  readonly dropConnection: (message: string) => void;
  readonly answer: (pattern: RegExp, fn: Answer) => void;
}

function fakeSession(setup: { locked?: boolean; holder?: LockHolder; instance?: { chain_id: string; factory: string; executor: string } } = {}): Fake {
  const calls: Call[] = [];
  const answers: [RegExp, Answer][] = [];
  let listener: ((error: Error) => void) | null = null;
  let ended = false;
  const session: PgSession = {
    async query<R extends pg.QueryResultRow>(text: string, values: readonly unknown[] = []): Promise<{ rows: R[]; rowCount: number | null }> {
      calls.push({ text, values });
      const scripted = answers.find(([pattern]) => pattern.test(text));
      if (scripted !== undefined) return scripted[1](values) as { rows: R[]; rowCount: number | null };
      if (/pg_try_advisory_lock/.test(text)) return { rows: [{ locked: setup.locked ?? true }] as unknown as R[], rowCount: 1 };
      if (/pg_stat_activity/.test(text)) {
        const holder = setup.holder;
        if (holder === undefined) return { rows: [], rowCount: 0 };
        return {
          rows: [{ application_name: holder.applicationName ?? "", backend_start: holder.since === null ? null : new Date(holder.since), state: holder.state }] as unknown as R[],
          rowCount: 1,
        };
      }
      if (/FROM sip_instance/.test(text)) return { rows: (setup.instance === undefined ? [] : [setup.instance]) as unknown as R[], rowCount: setup.instance === undefined ? 0 : 1 };
      return { rows: [], rowCount: 1 };
    },
    async end() {
      ended = true;
    },
    on(_event: "error", fn: (error: Error) => void) {
      listener = fn;
      return undefined;
    },
  };
  return {
    session,
    calls,
    sql: () => calls.map((c) => c.text),
    ended: () => ended,
    dropConnection: (message) => {
      if (listener === null) throw new Error("no error listener attached");
      listener(new Error(message));
    },
    answer: (pattern, fn) => {
      answers.unshift([pattern, fn]);
    },
  };
}

async function openFake(fake: Fake, options: Parameters<typeof openPgLedger>[1] = {}): Promise<SipLedger> {
  return openPgLedger("postgres://user:pw@db.example/sip", { ...options, connect: async () => fake.session });
}

const DB_URL = "postgres://user:pw@db.example/sip";

describe("pg ledger: open", () => {
  it("connects with the ported settings: mode-first application_name, relaxed TLS, keepalive and timeouts", async () => {
    const fake = fakeSession();
    let config: pg.ClientConfig | null = null;
    await openPgLedger(DB_URL, {
      mode: "live",
      env: { RAILWAY_DEPLOYMENT_ID: "deadbeefcafe", RAILWAY_REPLICA_ID: "0123456789" },
      connect: async (c) => {
        config = c;
        return fake.session;
      },
    });
    const c = config as pg.ClientConfig | null;
    expect(c?.application_name).toBe("sip-worker live d:deadbeef r:01234567");
    expect(c?.ssl).toEqual({ rejectUnauthorized: false });
    expect(c?.keepAlive).toBe(true);
    expect(c?.connectionTimeoutMillis).toBe(10_000);
    expect(c?.statement_timeout).toBe(30_000);
    expect(c?.query_timeout).toBe(45_000);
    expect(c?.idle_in_transaction_session_timeout).toBe(60_000);
    expect(c?.connectionString).toBe(DB_URL);
  });

  it("takes the advisory lock with try_ (never the blocking form) BEFORE any DDL, then runs SCHEMA_SQL in order", async () => {
    const fake = fakeSession();
    await openFake(fake);
    const sql = fake.sql();
    expect(sql[0]).toBe("SELECT pg_try_advisory_lock($1) AS locked");
    expect(sql[0]).not.toContain("pg_advisory_lock(");
    expect(fake.calls[0]?.values).toEqual([advisoryKeyFor(SIP_WORKER_LOCK_NAME).toString()]);
    expect(sql.slice(1, 1 + SCHEMA_SQL.length)).toEqual([...SCHEMA_SQL]);
    expect(sql).toHaveLength(1 + SCHEMA_SQL.length);
    expect(fake.ended()).toBe(false);
  });

  it("when another worker holds the lock, names it, runs no DDL, and closes the connection", async () => {
    const fake = fakeSession({ locked: false, holder: { applicationName: "sip-worker dry-run d:abcd1234", since: "2026-09-07T10:00:00.000Z", state: "idle" } });
    const error = await openFake(fake).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LedgerBusyError);
    expect((error as LedgerBusyError).message).toContain("sip-worker dry-run d:abcd1234");
    expect((error as LedgerBusyError).message).toContain("2026-09-07T10:00:00.000Z");
    expect((error as LedgerBusyError).holder?.state).toBe("idle");
    // The holder was looked up on the same connection, before it was closed; no DDL ran.
    expect(fake.sql().some((s) => s.includes("pg_stat_activity"))).toBe(true);
    expect(fake.sql().some((s) => s.startsWith("CREATE"))).toBe(false);
    expect(fake.ended()).toBe(true);
  });

  it("still reports busy when the holder cannot be identified", async () => {
    const fake = fakeSession({ locked: false });
    const error = await openFake(fake).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LedgerBusyError);
    expect((error as LedgerBusyError).holder).toBeUndefined();
    expect(fake.ended()).toBe(true);
  });

  it("pins the deployment identity on first open and refuses a different one later", async () => {
    const identity = { chainId: 4663, factory: "0x783BDF0281090F21928398CC3DA19CFB64FED15E" as Address, executor: "0xfa92abf15dfaf470cc8833cb01464bd6ca139e16" as Address };
    const fresh = fakeSession();
    await openFake(fresh, { identity });
    const insert = fresh.calls.find((c) => c.text.startsWith("INSERT INTO sip_instance"));
    expect(insert?.values).toEqual(["4663", "0x783bdf0281090f21928398cc3da19cfb64fed15e", "0xfa92abf15dfaf470cc8833cb01464bd6ca139e16"]);

    const other = fakeSession({ instance: { chain_id: "4663", factory: "0x0000000000000000000000000000000000000001", executor: "0xfa92abf15dfaf470cc8833cb01464bd6ca139e16" } });
    const error = await openFake(other, { identity }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LedgerIdentityMismatchError);
    expect((error as Error).message).toContain("factory: 0x0000000000000000000000000000000000000001 != 0x783bdf0281090f21928398cc3da19cfb64fed15e");
    expect(other.ended()).toBe(true);
  });

  it("a dropped connection is recorded by the listener and surfaces on the next call; close() then ends without unlocking", async () => {
    const fake = fakeSession();
    const ledger = await openFake(fake);
    fake.dropConnection("terminating connection due to administrator command");
    const error = await ledger.walletStates().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LedgerConnectionLostError);
    expect((error as Error).message).toContain("administrator command");
    await ledger.close();
    expect(fake.sql().some((s) => s.includes("pg_advisory_unlock_all"))).toBe(false);
    expect(fake.ended()).toBe(true);
  });

  it("close() releases the lock explicitly, ends the session, and is idempotent", async () => {
    const fake = fakeSession();
    const ledger = await openFake(fake);
    await ledger.close();
    await ledger.close();
    expect(fake.sql().filter((s) => s === "SELECT pg_advisory_unlock_all()")).toHaveLength(1);
    expect(fake.ended()).toBe(true);
    await expect(ledger.walletStates()).rejects.toBeInstanceOf(LedgerClosedError);
  });

  it("pg.Client satisfies the session slice the ledger uses", () => {
    const accepts = (session: PgSession): PgSession => session;
    expect(accepts(new pg.Client({ connectionString: DB_URL }))).toBeDefined();
  });
});

describe("pg ledger: SQL path", () => {
  it("upserts wallets lowercase, at the initial cursor, inside one transaction", async () => {
    const fake = fakeSession();
    const ledger = await openFake(fake, { initialCursorL2: 21_000_000n });
    fake.calls.length = 0;
    await ledger.upsertWallets([{ address: "0xC455BF7F16EBBC2B07CB26D1DD46194977974E7D", vault: VAULT }]);
    expect(fake.sql()[0]).toBe("BEGIN");
    expect(fake.sql().at(-1)).toBe("COMMIT");
    const insert = fake.calls[1];
    expect(insert?.text).toContain("ON CONFLICT (address) DO UPDATE SET vault = EXCLUDED.vault");
    expect(insert?.values).toEqual([WALLET, VAULT, "21000000"]);
    fake.calls.length = 0;
    await ledger.upsertWallets([]);
    expect(fake.calls).toEqual([]);
  });

  it("reads wallet states back as bigints from decimal strings, including a full-width numeric", async () => {
    const fake = fakeSession();
    const ledger = await openFake(fake);
    const huge = "9".repeat(78);
    fake.answer(/FROM sip_wallet ORDER BY address/, () => ({
      rows: [{ address: WALLET, vault: VAULT, cursor_l2: "22080837", owed_total_wei: huge, collected_total_wei: "0" }],
      rowCount: 1,
    }));
    expect(await ledger.walletStates()).toEqual([{ wallet: WALLET, vault: VAULT, cursorL2: 22080837n, owedTotalWei: BigInt(huge), collectedTotalWei: 0n }]);
  });

  it("records fills with stringified wei and blocks, then clears the blocks' refusals, all in one transaction", async () => {
    const fake = fakeSession();
    const ledger = await openFake(fake);
    fake.answer(/INSERT INTO sip_fill/, () => ({ rows: [{ window_id: null }], rowCount: 1 }));
    fake.calls.length = 0;
    const fills = sortedByBlock(fixtureFills());
    await ledger.recordFills(fills);
    const sql = fake.sql();
    expect(sql[0]).toBe("BEGIN");
    expect(sql.at(-1)).toBe("COMMIT");
    const inserts = fake.calls.filter((c) => c.text.startsWith("INSERT INTO sip_fill"));
    expect(inserts).toHaveLength(4);
    expect(inserts[0]?.text).toContain("WHERE sip_fill.window_id IS NULL");
    expect(inserts[0]?.values).toEqual([WALLET, fills[0]?.txHash, "21787563", 26, "buy", "gmgn", "native", fills[0]?.tokenOut, "1000000000000000", "10000000000000", "venue"]);
    const clears = fake.calls.filter((c) => c.text.startsWith("DELETE FROM sip_refusal"));
    expect(clears.map((c) => c.values)).toEqual([
      [WALLET, "21787563"],
      [WALLET, "21787635"],
      [WALLET, "22080593"],
      [WALLET, "22080837"],
    ]);
  });

  it("a windowed fill re-recorded identically is a no-op; differently, a conflict that rolls the batch back", async () => {
    const fake = fakeSession();
    const ledger = await openFake(fake);
    const [fill] = sortedByBlock(fixtureFills());
    if (fill === undefined) throw new Error("no fills");
    const stored = {
      wallet: fill.wallet,
      tx_hash: fill.txHash,
      block_l2: fill.blockL2.toString(),
      tx_index: fill.txIndex,
      side: fill.side,
      venue: fill.venue,
      token_in: fill.tokenIn,
      token_out: fill.tokenOut,
      notional_wei: fill.notionalWei.toString(),
      fee_wei: fill.feeWei.toString(),
      source: fill.source,
      window_id: 3,
    };
    // The upsert's WHERE excluded the windowed row: no rows returned.
    fake.answer(/INSERT INTO sip_fill/, () => ({ rows: [], rowCount: 0 }));
    fake.answer(/FROM sip_fill WHERE wallet = \$1 AND tx_hash = \$2/, () => ({ rows: [stored], rowCount: 1 }));
    fake.calls.length = 0;
    await ledger.recordFills([fill]);
    expect(fake.sql().at(-1)).toBe("COMMIT");

    fake.calls.length = 0;
    await expect(ledger.recordFills([{ ...fill, notionalWei: fill.notionalWei + 1n }])).rejects.toThrow(/committed to window 3/);
    expect(fake.sql().at(-1)).toBe("ROLLBACK");
  });

  it("a refusal upserts with its sighting count and voids only the block's unwindowed fills", async () => {
    const fake = fakeSession();
    const ledger = await openFake(fake);
    fake.calls.length = 0;
    await ledger.recordRefusals([{ wallet: WALLET, blockL2: 22080593n, reason: "MULTI_FILL_BLOCK", detail: "two sell-shaped txs" }]);
    const upsert = fake.calls[1];
    expect(upsert?.text).toContain("times_seen = sip_refusal.times_seen + 1");
    expect(upsert?.values).toEqual([WALLET, "22080593", "MULTI_FILL_BLOCK", "two sell-shaped txs"]);
    const voids = fake.calls[2];
    expect(voids?.text).toBe("DELETE FROM sip_fill WHERE wallet = $1 AND block_l2 = $2 AND window_id IS NULL");
    expect(voids?.values).toEqual([WALLET, "22080593"]);
    expect(fake.sql().at(-1)).toBe("COMMIT");
  });

  it("unwindowedFills asks for unwindowed, unrefused fills at or below the height, oldest first, and parses the rows", async () => {
    const fake = fakeSession();
    const ledger = await openFake(fake);
    const [fill] = sortedByBlock(fixtureFills());
    if (fill === undefined) throw new Error("no fills");
    fake.answer(/FROM sip_fill f/, () => ({
      rows: [
        {
          wallet: fill.wallet,
          tx_hash: fill.txHash,
          block_l2: fill.blockL2.toString(),
          tx_index: String(fill.txIndex),
          side: fill.side,
          venue: fill.venue,
          token_in: fill.tokenIn,
          token_out: fill.tokenOut,
          notional_wei: fill.notionalWei.toString(),
          fee_wei: fill.feeWei.toString(),
          source: fill.source,
          window_id: null,
        },
      ],
      rowCount: 1,
    }));
    fake.calls.length = 0;
    const got = await ledger.unwindowedFills(WALLET, 22_000_000n);
    expect(got).toEqual([fill]);
    const query = fake.calls[0];
    expect(query?.text).toContain("f.window_id IS NULL");
    expect(query?.text).toContain("NOT EXISTS (SELECT 1 FROM sip_refusal r");
    expect(query?.text).toContain("ORDER BY f.block_l2, f.tx_index");
    expect(query?.values).toEqual([WALLET, "22000000"]);
  });

  it("openWindow checks the live overlap, inserts, tags every fill under rule 6's WHERE, and returns the id", async () => {
    const fake = fakeSession();
    const ledger = await openFake(fake);
    fake.answer(/SELECT address FROM sip_wallet/, () => ({ rows: [{ address: WALLET }], rowCount: 1 }));
    fake.answer(/INSERT INTO sip_window/, () => ({ rows: [{ id: "42" }], rowCount: 1 }));
    fake.calls.length = 0;
    const fills = sortedByBlock(fixtureFills());
    const id = await ledger.openWindow(windowOf(fills, 1n, 22_100_000n));
    expect(id).toBe(42);
    const sql = fake.sql();
    expect(sql[0]).toBe("BEGIN");
    expect(sql.at(-1)).toBe("COMMIT");
    const overlap = fake.calls.find((c) => c.text.includes("status <> 'FAILED' AND start_l2 <= $3::bigint AND end_l2 >= $2::bigint"));
    expect(overlap?.values).toEqual([WALLET, "1", "22100000"]);
    const insert = fake.calls.find((c) => c.text.startsWith("INSERT INTO sip_window"));
    expect(insert?.values).toEqual([WALLET, VAULT, "1", "22100000", ROOT_A, SUM_NOTIONAL.toString(), owedFor(SUM_NOTIONAL).toString(), SAVINGS_BPS]);
    const tags = fake.calls.filter((c) => c.text.startsWith("UPDATE sip_fill f SET window_id = $1"));
    expect(tags).toHaveLength(4);
    expect(tags[0]?.text).toContain("f.window_id IS NULL");
    expect(tags[0]?.text).toContain("NOT EXISTS (SELECT 1 FROM sip_refusal r");
    expect(tags[0]?.values).toEqual([42, WALLET, fills[0]?.txHash, "1", "22100000"]);
  });

  it("openWindow rolls back when a fill cannot be tagged, or when the range overlaps a live window", async () => {
    const fake = fakeSession();
    const ledger = await openFake(fake);
    fake.answer(/SELECT address FROM sip_wallet/, () => ({ rows: [{ address: WALLET }], rowCount: 1 }));
    fake.answer(/INSERT INTO sip_window/, () => ({ rows: [{ id: 1 }], rowCount: 1 }));
    fake.answer(/UPDATE sip_fill f SET window_id/, () => ({ rows: [], rowCount: 0 }));
    const [a] = sortedByBlock(fixtureFills());
    if (a === undefined) throw new Error("no fills");
    fake.calls.length = 0;
    await expect(ledger.openWindow(windowOf([a], a.blockL2, a.blockL2))).rejects.toBeInstanceOf(LedgerConflictError);
    expect(fake.sql().at(-1)).toBe("ROLLBACK");

    fake.answer(/status <> 'FAILED' AND start_l2 <=/, () => ({ rows: [{ id: 9, start_l2: "1", end_l2: "30000000" }], rowCount: 1 }));
    fake.calls.length = 0;
    await expect(ledger.openWindow(windowOf([a], a.blockL2, a.blockL2))).rejects.toThrow(/overlaps live window 9/);
    expect(fake.sql().some((s) => s.startsWith("INSERT INTO sip_window"))).toBe(false);
    expect(fake.sql().at(-1)).toBe("ROLLBACK");
  });

  it("markWindow refuses to move a CONFIRMED window, updates status alone when no detail is given, and stores detail as bigint-safe jsonb", async () => {
    const fake = fakeSession();
    const ledger = await openFake(fake);
    fake.answer(/SELECT status FROM sip_window/, () => ({ rows: [{ status: "CONFIRMED" }], rowCount: 1 }));
    await expect(ledger.markWindow(5, "OPEN")).rejects.toBeInstanceOf(LedgerConflictError);
    expect(fake.sql().at(-1)).toBe("ROLLBACK");

    fake.answer(/SELECT status FROM sip_window/, () => ({ rows: [{ status: "OPEN" }], rowCount: 1 }));
    fake.calls.length = 0;
    await ledger.markWindow(5, "SIGNED");
    const plain = fake.calls.find((c) => c.text.startsWith("UPDATE sip_window"));
    expect(plain?.text).not.toContain("detail");
    expect(plain?.values).toEqual([5, "SIGNED"]);

    fake.calls.length = 0;
    await ledger.markWindow(5, "OPEN", { reason: "BELOW_MINIMUM", owedWei: 123n });
    const withDetail = fake.calls.find((c) => c.text.startsWith("UPDATE sip_window"));
    expect(withDetail?.text).toContain("detail = $3::jsonb");
    expect(withDetail?.values).toEqual([5, "OPEN", '{"reason":"BELOW_MINIMUM","owedWei":"123"}']);

    fake.answer(/SELECT status FROM sip_window/, () => ({ rows: [], rowCount: 0 }));
    await expect(ledger.markWindow(6, "OPEN")).rejects.toThrow(/no window 6/);
  });

  it("recordPull inserts a hash-less row for a dry run and upserts on the raw tx hash for a send", async () => {
    const fake = fakeSession();
    const ledger = await openFake(fake);
    fake.answer(/SELECT id FROM sip_window WHERE id = \$1/, () => ({ rows: [{ id: 4 }], rowCount: 1 }));
    fake.answer(/SELECT window_id FROM sip_pull WHERE tx_hash/, () => ({ rows: [], rowCount: 0 }));
    const window = windowOf(sortedByBlock(fixtureFills()), 1n, 22_100_000n);
    const intent = intentOf(window, 77n, ROOT_B, 9);

    fake.calls.length = 0;
    await ledger.recordPull(4, null, { kind: "DRY_RUN", intent: { window, attestation: intent.attestation, signature: intent.signature, contributionWei: 77n } });
    const dry = fake.calls.find((c) => c.text.startsWith("INSERT INTO sip_pull"));
    expect(dry?.text).toContain("VALUES ($1, NULL, NULL, $2, $3, $4::jsonb)");
    expect(dry?.values?.[0]).toBe(4);
    expect(dry?.values?.[1]).toBe("77");
    expect(dry?.values?.[2]).toBe("DRY_RUN");
    expect(JSON.parse(String(dry?.values?.[3]))).toMatchObject({ kind: "DRY_RUN", contributionWei: "77", attestation: { ledgerRoot: ROOT_A, contribution: "77" } });

    fake.calls.length = 0;
    await ledger.recordPull(4, intent, { kind: "SENT", intent });
    const sent = fake.calls.find((c) => c.text.startsWith("INSERT INTO sip_pull"));
    expect(sent?.text).toContain("ON CONFLICT (tx_hash) WHERE tx_hash IS NOT NULL DO UPDATE SET");
    expect(sent?.values?.slice(0, 5)).toEqual([4, ROOT_B, 9, "77", "SENT"]);
    expect(JSON.parse(String(sent?.values?.[5]))).toMatchObject({ kind: "SENT", rawTx: "0x02f8aa", txHash: ROOT_B, nonce: 9 });

    fake.answer(/SELECT window_id FROM sip_pull WHERE tx_hash/, () => ({ rows: [{ window_id: "3" }], rowCount: 1 }));
    await expect(ledger.recordPull(4, intent, { kind: "SENT", intent })).rejects.toThrow(/recorded for window 3/);
    expect(fake.sql().at(-1)).toBe("ROLLBACK");
  });

  it("advanceCursor uses GREATEST and refuses an unknown wallet; the totals add numeric and refuse negatives before any query", async () => {
    const fake = fakeSession();
    const ledger = await openFake(fake);
    fake.calls.length = 0;
    await ledger.advanceCursor(WALLET, 22_080_837n);
    expect(fake.calls[0]?.text).toContain("GREATEST(cursor_l2, $2::bigint)");
    expect(fake.calls[0]?.values).toEqual([WALLET, "22080837"]);
    fake.answer(/UPDATE sip_wallet SET cursor_l2/, () => ({ rows: [], rowCount: 0 }));
    await expect(ledger.advanceCursor(OTHER_WALLET, 1n)).rejects.toBeInstanceOf(LedgerConflictError);

    fake.calls.length = 0;
    await ledger.addOwed(WALLET, 5n);
    await ledger.addCollected(WALLET, 3n);
    expect(fake.calls[0]?.text).toContain("owed_total_wei = owed_total_wei + $2::numeric");
    expect(fake.calls[0]?.values).toEqual([WALLET, "5"]);
    expect(fake.calls[1]?.text).toContain("collected_total_wei = collected_total_wei + $2::numeric");
    fake.calls.length = 0;
    await expect(ledger.addOwed(WALLET, -1n)).rejects.toBeInstanceOf(LedgerInputError);
    expect(fake.calls).toEqual([]);
    fake.answer(/UPDATE sip_wallet SET owed_total_wei/, () => ({ rows: [], rowCount: 0 }));
    await expect(ledger.addOwed(OTHER_WALLET, 1n)).rejects.toBeInstanceOf(LedgerConflictError);
  });

  it("windows() rebuilds a VolumeWindow from its row and its tagged fills", async () => {
    const fake = fakeSession();
    const ledger = await openFake(fake);
    const fills = sortedByBlock(fixtureFills());
    fake.answer(/FROM sip_window\s+WHERE/, () => ({
      rows: [
        {
          id: 7,
          wallet: WALLET,
          vault: VAULT,
          start_l2: "1",
          end_l2: "22100000",
          batch_root: ROOT_A,
          sum_notional_wei: SUM_NOTIONAL.toString(),
          owed_wei: owedFor(SUM_NOTIONAL).toString(),
          savings_bps: 20,
          status: "OPEN",
          detail: { reason: "L1_NOT_ADVANCED" },
        },
      ],
      rowCount: 1,
    }));
    fake.answer(/FROM sip_fill WHERE window_id = ANY/, () => ({
      rows: fills.map((f) => ({
        wallet: f.wallet,
        tx_hash: f.txHash,
        block_l2: f.blockL2.toString(),
        tx_index: f.txIndex,
        side: f.side,
        venue: f.venue,
        token_in: f.tokenIn,
        token_out: f.tokenOut,
        notional_wei: f.notionalWei.toString(),
        fee_wei: f.feeWei.toString(),
        source: f.source,
        window_id: 7,
      })),
      rowCount: 4,
    }));
    const [window] = await ledger.windows({ wallet: WALLET, status: "OPEN" });
    expect(window).toEqual({ ...windowOf(fills, 1n, 22_100_000n), id: 7, status: "OPEN", detail: { reason: "L1_NOT_ADVANCED" } });
    const query = fake.calls.find((c) => c.text.includes("FROM sip_window"));
    expect(query?.values).toEqual([WALLET, "OPEN"]);
  });
});

describe("pg ledger: ported helpers", () => {
  it("advisoryKeyFor is deterministic, signed 64-bit, and distinct per name", () => {
    const key = advisoryKeyFor(SIP_WORKER_LOCK_NAME);
    expect(key).toBe(advisoryKeyFor("sip-worker"));
    expect(key).not.toBe(advisoryKeyFor("nuvem-keeper"));
    expect(key >= -(2n ** 63n) && key < 2n ** 63n).toBe(true);
  });

  it("workerApplicationName puts the mode first, shortens the ids, and never exceeds 63 bytes", () => {
    expect(workerApplicationName({ mode: "dry-run", env: {} })).toBe("sip-worker dry-run");
    expect(workerApplicationName({ mode: "live", env: { SIP_WORKER_DEPLOYMENT_ID: "abcdefghijkl", SIP_WORKER_REPLICA_ID: "" } })).toBe("sip-worker live d:abcdefgh");
    expect(workerApplicationName({ mode: "live", env: { RAILWAY_DEPLOYMENT_ID: "x".repeat(100), RAILWAY_REPLICA_ID: "y".repeat(100) } }).length).toBeLessThanOrEqual(63);
  });

  it("sslOptionsFor relaxes the chain check by default and disables TLS only on an explicit sslmode=disable", () => {
    expect(sslOptionsFor("postgres://u:p@h/db")).toEqual({ rejectUnauthorized: false });
    expect(sslOptionsFor("postgres://u:p@h/db?sslmode=require")).toEqual({ rejectUnauthorized: false });
    expect(sslOptionsFor("postgres://u:p@h/db?sslmode=disable")).toBe(false);
    expect(sslOptionsFor("postgres://u:p@h/db?sslmode=DISABLE")).toBe(false);
    expect(sslOptionsFor("not a url")).toEqual({ rejectUnauthorized: false });
  });

  it("pgClientConfig defaults the mode to dry-run, which is the label that makes a stale holder visible", () => {
    expect(pgClientConfig("postgres://u:p@h/db", { env: {} }).application_name).toBe("sip-worker dry-run");
  });
});
