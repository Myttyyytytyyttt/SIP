// Owner: loop. Every rule DESIGN.md §4 and §6 lay on the pass and the schedule
// has a test here, plus the two structural deviations tick.ts explains in its
// header (the scan stops at the margin; a window is persisted only once
// signed). No network: the chain is a mock that serves one fixture-shaped
// block — the recorded v3 GMGN buy, block 0x150ec51 — through the REAL
// discovery and the REAL venue decoder; the modules whose owners are still
// building (context, reconcile, root, snapshot, attest, pull, ledger) are
// injected through the pipeline seam, so the loop is tested as a loop.

import { readFileSync } from "node:fs";
import { concatHex, keccak256 } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LedgerConnectionLostError } from "../src/ledger/pg.js";
import { createLogger, silentLogger, type Logger } from "../src/log.js";
import { StateUnavailableError } from "../src/observe/context.js";
import { ACTIVE_VAULT_OF_SELECTOR, TRADING_ACCOUNT_LINKED_TOPIC, addressTopic } from "../src/observe/discover.js";
import { decodeVenueFill } from "../src/observe/venues/index.js";
import {
  PHASE0_PULL_GAS,
  REFUSAL_RETENTION_L2,
  createHeartbeat,
  pullGasFloorWei,
  runLoop,
  runTick,
  skipWhileRunning,
  type RefusalAges,
  type TickDeps,
  type TickPipeline,
  type TickSummary,
} from "../src/tick.js";
import { PullBroadcastError } from "../src/pull/submit.js";
import type {
  Address,
  AttestOutcome,
  BasketLeg,
  BlockContext,
  BlockRefusal,
  Candidate,
  DiscoveryResult,
  Exclusion,
  Fill,
  Hex,
  InvestOutcome,
  Ledger,
  PullIntent,
  PullOutcome,
  ReconcileOutcome,
  RpcClient,
  RpcReceipt,
  RpcTransaction,
  SettlementAttestation,
  TxWithReceipt,
  VaultSnapshot,
  VolumeWindow,
  WalletState,
  WindowStatus,
  WorkerConfig,
} from "../src/types.js";

// ── the recorded fixture, read directly ──────────────────────────────────────

const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/mainnet-4663.json", import.meta.url), "utf8")) as Record<string, unknown>;

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
    hash: t.hash, from: t.from, to: t.to, value: BigInt(t.value), nonce: Number(BigInt(t.nonce)), input: t.input,
    transactionIndex: Number(BigInt(t.transactionIndex)), blockNumber: BigInt(t.blockNumber),
  };
  const receipt: RpcReceipt = {
    transactionHash: r.transactionHash, from: r.from, to: r.to, status: r.status === "0x1" ? "success" : "reverted",
    gasUsed: BigInt(r.gasUsed), effectiveGasPrice: BigInt(r.effectiveGasPrice), blockNumber: BigInt(r.blockNumber),
    logs: r.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data, blockNumber: BigInt(l.blockNumber), transactionHash: l.transactionHash, logIndex: Number(BigInt(l.logIndex)) })),
  };
  return { tx, receipt };
}

// ── facts from DESIGN.md §1 ──────────────────────────────────────────────────

const CHAIN_ID = 4663;
const WALLET: Address = "0xc455bf7f16ebbc2b07cb26d1dd46194977974e7d";
const WALLET_B: Address = "0x1111111111111111111111111111111111111111";
const VAULT: Address = "0x2222222222222222222222222222222222222222";
const VAULT_B: Address = "0x3333333333333333333333333333333333333333";
// Addresses of a SIP deployment, invented here: no real deployment is pinned in
// the source any more, so a test cannot accidentally aim the worker at Nuvem's.
const FACTORY: Address = "0x1111111111111111111111111111111111111111";
const EXECUTOR: Address = "0x2222222222222222222222222222222222222222";
const TOKEN_V3: Address = "0x3792daef78e7c652c8ade7d1ad64fd398ed80056";
const TRANSFER: Hex = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO32: Hex = `0x${"0".repeat(64)}`;
const BUY_V3: Hex = "0x27259f99e2cbc54ff51e7193e020af3b3f69c021347448da59665c33c2eef882";
/** The block the v3 buy sits in; the fixture holds it with full transactions. */
const BLOCK = 0x150ec51n;
const BUY_NOTIONAL = 20_000_000_000_000_000n;
const BUY_FEE = 200_000_000_000_000n;
const MARGIN = 64n;
const SPAN = 10_000n;
const L1_OF_BLOCK: Hex = "0x1872a35";
const LINK_BLOCK = BLOCK - 5_000n;

const hex = (n: bigint): Hex => `0x${n.toString(16)}`;
const wei = (n: bigint): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const word = (address: Address): Hex => `0x${address.slice(2).padStart(64, "0")}`;

// ── a ledger that remembers everything, in order ─────────────────────────────

interface StoredWindow { id: number; window: VolumeWindow; status: WindowStatus; details: unknown[] }
interface StoredPull { windowId: number; intent: PullIntent | null; outcome: PullOutcome }

function recordingLedger() {
  const wallets = new Map<Address, { wallet: Address; vault: Address; cursorL2: bigint; owedTotalWei: bigint; collectedTotalWei: bigint }>();
  const fills = new Map<string, { fill: Fill; windowId: number | null }>();
  const exclusions: Exclusion[] = [];
  const refusals: BlockRefusal[] = [];
  const windows: StoredWindow[] = [];
  const pulls: StoredPull[] = [];
  const calls: string[] = [];
  const key = (wallet: Address, txHash: Hex) => `${wallet.toLowerCase()}|${txHash.toLowerCase()}`;

  const ledger: Ledger = {
    async upsertWallets(refs) {
      calls.push("upsertWallets");
      for (const ref of refs) {
        const existing = wallets.get(ref.address);
        if (existing === undefined) wallets.set(ref.address, { wallet: ref.address, vault: ref.vault, cursorL2: 0n, owedTotalWei: 0n, collectedTotalWei: 0n });
        else existing.vault = ref.vault;
      }
    },
    async walletStates() {
      calls.push("walletStates");
      return [...wallets.values()].map((w): WalletState => ({ ...w }));
    },
    async recordFills(list) {
      calls.push("recordFills");
      for (const fill of list) {
        const existing = fills.get(key(fill.wallet, fill.txHash));
        fills.set(key(fill.wallet, fill.txHash), { fill, windowId: existing?.windowId ?? null });
      }
    },
    async recordExclusions(list) { calls.push("recordExclusions"); exclusions.push(...list); },
    async recordRefusals(list) {
      calls.push("recordRefusals");
      for (const refusal of list) {
        const i = refusals.findIndex((r) => r.wallet === refusal.wallet && r.blockL2 === refusal.blockL2);
        if (i === -1) refusals.push(refusal); else refusals[i] = refusal;
      }
    },
    async advanceCursor(wallet, toL2) {
      calls.push(`advanceCursor:${toL2}`);
      const w = wallets.get(wallet);
      if (w === undefined) throw new Error(`unknown wallet ${wallet}`);
      w.cursorL2 = toL2;
    },
    async unwindowedFills(wallet, throughL2) {
      calls.push("unwindowedFills");
      return [...fills.values()]
        .filter((e) => e.windowId === null && e.fill.wallet === wallet && e.fill.blockL2 <= throughL2)
        .map((e) => e.fill)
        .sort((a, b) => (a.blockL2 === b.blockL2 ? a.txIndex - b.txIndex : a.blockL2 < b.blockL2 ? -1 : 1));
    },
    async openWindow(window) {
      calls.push("openWindow");
      const id = windows.length + 1;
      windows.push({ id, window, status: "OPEN", details: [] });
      for (const fill of window.fills) {
        const e = fills.get(key(fill.wallet, fill.txHash));
        if (e !== undefined) e.windowId = id;
      }
      return id;
    },
    async markWindow(id, status, detail) {
      calls.push(`markWindow:${status}`);
      const w = windows.find((x) => x.id === id);
      if (w === undefined) throw new Error(`unknown window ${id}`);
      w.status = status;
      w.details.push(detail);
    },
    async recordPull(windowId, intent, outcome) { calls.push(`recordPull:${outcome.kind}`); pulls.push({ windowId, intent, outcome }); },
    async addOwed(wallet, amount) {
      calls.push("addOwed");
      const w = wallets.get(wallet);
      if (w !== undefined) w.owedTotalWei += amount;
    },
    async addCollected(wallet, amount) {
      calls.push("addCollected");
      const w = wallets.get(wallet);
      if (w !== undefined) w.collectedTotalWei += amount;
    },
    async windowsByStatus(status, wallet) {
      calls.push("windowsByStatus");
      return windows
        .filter((w) => w.status === status && (wallet === undefined || w.window.wallet === wallet))
        .map((w) => ({ id: w.id, status: w.status, window: w.window, detail: w.details.at(-1) ?? null }));
    },
    async close() { calls.push("close"); },
  };
  return { ledger, wallets, fills, exclusions, refusals, windows, pulls, calls };
}

/** A wallet the ledger already knows, with its cursor where the test wants it. */
async function seeded(state: ReturnType<typeof recordingLedger>, wallet: Address, vault: Address, cursor: bigint) {
  await state.ledger.upsertWallets([{ address: wallet, vault }]);
  await state.ledger.advanceCursor(wallet, cursor);
  state.calls.length = 0;
}

// ── a chain that serves the fixture-shaped block ─────────────────────────────

type Handler = (method: string, params: readonly unknown[]) => unknown;

function mockRpc(handler: Handler) {
  const calls: { method: string; params: readonly unknown[] }[] = [];
  const rpc: RpcClient = {
    async call<T>(method: string, params: readonly unknown[] = []): Promise<T> {
      calls.push({ method, params });
      return handler(method, params) as T;
    },
  };
  return { rpc, calls };
}

/**
 * The chain as discovery sees it: a head, the factory's link log, the v3 buy's
 * token Transfer to the wallet, the recorded block with its one transaction,
 * empty blocks everywhere else, and the wallet's nonce stepping by one at BLOCK.
 */
function fixtureChain(options: { head: bigint; nonceAfter?: bigint }): Handler {
  const buy = recorded<RawReceipt>("eth_getTransactionReceipt", [BUY_V3]);
  const tokenLeg = buy.logs[2];
  if (tokenLeg === undefined || tokenLeg.address !== TOKEN_V3) throw new Error("fixture changed: the v3 buy's token leg moved");
  const linkLog: RawLog = {
    address: FACTORY,
    topics: [TRADING_ACCOUNT_LINKED_TOPIC, addressTopic(WALLET), addressTopic(VAULT), ZERO32],
    data: "0x",
    blockNumber: hex(LINK_BLOCK),
    transactionHash: `0x${"ab".repeat(32)}`,
    logIndex: "0x0",
  };
  const inRange = (log: RawLog, filter: Record<string, unknown>) => {
    const n = BigInt(log.blockNumber);
    return n >= BigInt(filter["fromBlock"] as string) && n <= BigInt(filter["toBlock"] as string);
  };
  return (method, params) => {
    switch (method) {
      case "eth_blockNumber":
        return hex(options.head);
      case "eth_getBlockByNumber": {
        const [tag, full] = params as [Hex, boolean];
        const n = BigInt(tag);
        if (n > options.head) return null;
        if (full && n === BLOCK) return recorded<unknown>("eth_getBlockByNumber", [hex(BLOCK), true]);
        return { number: tag, l1BlockNumber: L1_OF_BLOCK, transactions: [] };
      }
      case "eth_getLogs": {
        const [filter] = params as [Record<string, unknown>];
        if (filter["address"] === FACTORY) return inRange(linkLog, filter) ? [linkLog] : [];
        const topics = filter["topics"] as unknown[];
        if (topics[0] !== TRANSFER) throw new Error(`unexpected getLogs topics ${JSON.stringify(topics)}`);
        const bought = Array.isArray(topics[2]) && topics[2].includes(addressTopic(WALLET));
        return bought && inRange(tokenLeg, filter) ? [tokenLeg] : [];
      }
      case "eth_call": {
        const [call] = params as [Record<string, unknown>];
        if (call["to"] === FACTORY && String(call["data"]).startsWith(ACTIVE_VAULT_OF_SELECTOR)) return word(VAULT);
        throw new Error(`unexpected eth_call ${JSON.stringify(call)}`);
      }
      case "eth_getTransactionCount": {
        const [, tag] = params as [Address, Hex];
        return BigInt(tag) < BLOCK ? "0x47" : hex(options.nonceAfter ?? 0x48n);
      }
      default:
        throw new Error(`mock has no ${method}`);
    }
  };
}

// ── the injected modules ─────────────────────────────────────────────────────

/** The v3 buy's BlockContext from the fixture: its tx, receipt and the balances around it. */
async function fixtureContext(_rpc: RpcClient, wallet: Address, blockL2: bigint): Promise<BlockContext> {
  if (blockL2 !== BLOCK) throw new Error(`no context for block ${blockL2}`);
  const entry = entryOf(BUY_V3);
  const nativeBefore = BigInt(recorded<Hex>("eth_getBalance", [WALLET, hex(BLOCK - 1n)]));
  const gas = entry.receipt.gasUsed * entry.receipt.effectiveGasPrice;
  const weth = BigInt(recorded<Hex>("eth_call", [{ to: "0x0bd7d308f8e1639fab988df18a8011f41eacad73", data: `0x70a08231${word(WALLET).slice(2)}` }, hex(BLOCK - 1n)]));
  return { wallet, blockL2, txs: [entry], nativeBefore, nativeAfter: nativeBefore - entry.tx.value - gas, wethBefore: weth, wethAfter: weth, hasCode: false };
}

/** A reconciler that only trusts venue decoders — enough to turn the recorded buy into the §1 truth. */
function venueOnlyReconcile(context: BlockContext): ReconcileOutcome {
  const fills: Fill[] = [];
  for (const entry of context.txs) {
    const venue = decodeVenueFill(entry, context.wallet);
    if (venue === null) continue;
    fills.push({ wallet: context.wallet, txHash: entry.tx.hash, blockL2: context.blockL2, txIndex: entry.tx.transactionIndex, ...venue, source: "venue" });
  }
  return { fills, exclusions: [], refusal: null };
}

const fakeRoot = (_chainId: number, _wallet: Address, fills: readonly Fill[]): Hex =>
  keccak256(concatHex([...fills.map((f) => f.txHash)].sort()));

function snapshotOf(overrides: Partial<VaultSnapshot> = {}): VaultSnapshot {
  return {
    vault: VAULT, account: WALLET, status: 1, bindingEpoch: 1n, policyNonce: 1n, settlementNonce: 3n, policyHash: ZERO32,
    adminEpoch: 0n, localPauseEpoch: 0n, globalPauseEpoch: 0n, attesterEpoch: 1n, activationBlockL1: 0n, savingsBps: 20,
    minContributionWei: 1_000_000_000_000n, maxPerSettlementWei: 2n ** 127n, tradingFloorWei: 0n, gasReserveWei: 0n,
    accountRollingRemainingWei: 2n ** 127n, aggregateRollingRemainingWei: 2n ** 127n, settlementPaused: false, protocolPaused: false,
    executor: EXECUTOR, frontierEndL2: 0n, nativeBalanceWei: 10n ** 18n, ...overrides,
  };
}

function attestationFor(window: VolumeWindow, snapshot: VaultSnapshot): SettlementAttestation {
  return {
    chainId: BigInt(CHAIN_ID), vault: window.vault, account: window.wallet, executor: EXECUTOR,
    bindingEpoch: snapshot.bindingEpoch, policyNonce: snapshot.policyNonce, settlementNonce: snapshot.settlementNonce,
    adminEpoch: snapshot.adminEpoch, localPauseEpoch: snapshot.localPauseEpoch, globalPauseEpoch: snapshot.globalPauseEpoch,
    attesterEpoch: snapshot.attesterEpoch, policyHash: snapshot.policyHash, sessionId: `0x${"11".repeat(32)}`, ledgerRoot: window.batchRoot,
    startBlock: 0n, endBlock: 0n, startBlockL2: window.startL2, endBlockL2: window.endL2, cashStart: 0n, cashEnd: window.sumNotionalWei,
    externalDeposits: 0n, externalWithdrawals: 0n, realizedProfit: window.sumNotionalWei, contribution: window.owedWei, validAfter: 0n, deadline: 600n,
  };
}

const SIGNATURE: Hex = `0x${"cd".repeat(65)}`;

const signedAttest: TickPipeline["attestPhase0"] = async (_rpc, _executor, window, snapshot) => ({
  kind: "SIGNED", attestation: attestationFor(window, snapshot), signature: SIGNATURE, contributionWei: window.owedWei,
});

const dryRunSubmit: TickPipeline["submitPull"] = async (_rpc, mode, _executor, window, attestation, signature, contributionWei) => {
  if (mode !== "dry-run") throw new Error("this fake only knows dry run");
  return { kind: "DRY_RUN", intent: { window, attestation, signature, contributionWei } };
};

const noWallets: TickPipeline["discoverLinkedWallets"] = async () => [];
const noGasFloor: TickPipeline["pullGasFloorWei"] = async () => 0n;
const attester = { address: WALLET_B, signTypedData: async () => SIGNATURE };
const throwingAttester = { address: WALLET_B, signTypedData: async (): Promise<Hex> => { throw new Error("must not sign"); } };

/** A discovery that nominates the given (wallet, block) pairs and vouches for everyone; records the ranges it was asked. */
function scriptedDiscover(pairs: readonly { wallet: Address; blockL2: bigint; incomplete?: boolean }[]) {
  const ranges: { fromBlock: bigint; toBlock: bigint }[] = [];
  const discover: TickPipeline["discover"] = async (_rpc, wallets, range) => {
    ranges.push({ ...range });
    const managed = new Set(wallets.map((w) => w.address));
    const candidates: Candidate[] = pairs
      .filter((p) => managed.has(p.wallet) && p.blockL2 >= range.fromBlock && p.blockL2 <= range.toBlock)
      .map((p, i) => ({ wallet: p.wallet, blockL2: p.blockL2, txHash: `0x${(i + 1).toString(16).padStart(64, "0")}` }));
    const incompleteWallets = [...new Set(pairs.filter((p) => p.incomplete === true && managed.has(p.wallet)).map((p) => p.wallet))];
    const result: DiscoveryResult = { fromBlock: range.fromBlock, toBlock: range.toBlock, candidates, incompleteWallets };
    return result;
  };
  return { discover, ranges };
}

/** A context with no transactions — enough for a scripted reconciler that decides by block number. */
const emptyContext: TickPipeline["buildBlockContext"] = async (_rpc, wallet, blockL2) => ({
  wallet, blockL2, txs: [], nativeBefore: 0n, nativeAfter: 0n, wethBefore: 0n, wethAfter: 0n, hasCode: false,
});

function fillAt(wallet: Address, blockL2: bigint, notionalWei: bigint): Fill {
  return {
    wallet, txHash: keccak256(`0x${blockL2.toString(16).padStart(64, "0")}${wallet.slice(2)}`), blockL2, txIndex: 0, side: "buy", venue: "gmgn",
    tokenIn: "native", tokenOut: TOKEN_V3, notionalWei, feeWei: notionalWei / 100n, source: "venue",
  };
}

// ── the crank (step 5) ───────────────────────────────────────────────────────

/** A one-leg basket. The pass never looks inside one; the crank's own tests do. */
const BASKET: readonly BasketLeg[] = [{ targetAsset: TOKEN_V3, weightBps: 10_000, minOutRateWad: 10n ** 18n }];

const wouldInvest = (vault: Address, account: Address, amountInWei: bigint): InvestOutcome => ({
  kind: "DRY_RUN",
  intent: {
    vault, account, amountInWei, legs: BASKET, minAmountsOut: [0n], deadline: 1_700_000_600n,
    expectedAdapterStatusEpoch: 1n, expectedInvestmentPolicyNonce: 4n,
  },
});

/** A crank that records every vault it was handed and answers with whatever the test scripted. */
function scriptedCrank(answer: (vault: Address, accounts: readonly Address[]) => InvestOutcome) {
  const calls: { vault: Address; accounts: readonly Address[]; mode: string; seat: unknown }[] = [];
  const crankVault: TickPipeline["crankVault"] = async (_rpc, mode, vault, accounts, seat) => {
    calls.push({ vault, accounts: [...accounts], mode, seat });
    return answer(vault, accounts);
  };
  return { crankVault, calls };
}

/** The resting state, and the default of every scripted pass: the vault has nothing to buy yet. */
const idleCrank: TickPipeline["crankVault"] = async () => ({ kind: "DEFERRED", reason: "NOTHING_TO_INVEST" });

function configOf(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    mode: "dry-run", chainId: CHAIN_ID, rpcUrls: ["http://unused.test"], factory: FACTORY, executor: EXECUTOR, logsFromBlock: LINK_BLOCK - 10n,
    databaseUrl: null, pollMs: 300_000, finalityMarginL2: MARGIN, maxLogSpan: SPAN, attesterPrivateKey: null, privy: null, ...overrides,
  };
}

function capturingLogger() {
  const lines: Record<string, unknown>[] = [];
  const log: Logger = createLogger({ json: true, sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>) });
  const events = (event: string) => lines.filter((l) => l["event"] === event);
  return { log, lines, events };
}

function depsOf(parts: Partial<TickDeps> & { rpc: RpcClient; ledger: Ledger }): TickDeps {
  return { config: configOf(), log: silentLogger(), attester, seat: null, ...parts };
}

/** The pipeline every scripted test starts from: real discovery is replaced, everything after it is the fake that says yes. */
function scriptedPipeline(parts: Partial<TickPipeline> = {}): Partial<TickPipeline> {
  return {
    discoverLinkedWallets: noWallets, buildBlockContext: emptyContext, batchRoot: fakeRoot, readVaultSnapshot: async () => snapshotOf(),
    attestPhase0: signedAttest, submitPull: dryRunSubmit, pullGasFloorWei: noGasFloor, crankVault: idleCrank, unixSeconds: () => 1_700_000_000n,
    // L1 = L2, so an activation floor can be stated in the same blocks the test already talks about.
    l1BlockOf: async (_rpc, blockL2) => blockL2, ...parts,
  };
}

// ── §2 loop: the fixture-shaped block, end to end ────────────────────────────

describe("a tick over one fixture-shaped block (DESIGN.md §2 loop, §6)", () => {
  const head = BLOCK + MARGIN + 6n;
  const closeAt = head - MARGIN;

  async function tick(logger: Logger = silentLogger()) {
    const state = recordingLedger();
    await seeded(state, WALLET, VAULT, BLOCK - 1n);
    const chain = mockRpc(fixtureChain({ head }));
    const submitCalls: { mode: string; seat: unknown; windowId: number }[] = [];
    const summary = await runTick(depsOf({ rpc: chain.rpc, ledger: state.ledger, log: logger }), {
      buildBlockContext: fixtureContext,
      reconcileBlock: venueOnlyReconcile,
      batchRoot: fakeRoot,
      readVaultSnapshot: async () => snapshotOf(),
      attestPhase0: signedAttest,
      submitPull: async (...args) => {
        submitCalls.push({ mode: args[1], seat: args[7], windowId: args[9] });
        return dryRunSubmit(...args);
      },
      pullGasFloorWei: noGasFloor,
      crankVault: idleCrank,
      unixSeconds: () => 1_700_000_000n,
    });
    return { state, chain, summary, submitCalls };
  }

  it("produces one fill, one open window behind the margin and one DRY_RUN pull", async () => {
    const { state, summary, submitCalls } = await tick();
    // The vault holds nothing yet — this pass's pull is a dry run — so step 5
    // defers it. `investDeferred`, not `deferred`: an unbought basket and a
    // window below its minimum are not the same event.
    const expected: TickSummary = {
      headL2: head, wallets: 1, fills: 1, exclusions: 0, refusals: 0, windowsOpened: 1, pulls: 1, deferred: 0, investments: 0, investDeferred: 1,
    };
    expect(summary).toEqual(expected);

    // The fill is the §1 truth, decoded by the real GMGN decoder from the recorded receipt.
    const fills = [...state.fills.values()].map((e) => e.fill);
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ wallet: WALLET, txHash: BUY_V3, blockL2: BLOCK, side: "buy", venue: "gmgn", notionalWei: BUY_NOTIONAL, feeWei: BUY_FEE, source: "venue" });

    // The window: the fill's block through the close line, at 20 bps of gross notional.
    expect(state.windows).toHaveLength(1);
    const stored = state.windows[0];
    expect(stored?.window).toMatchObject({ wallet: WALLET, vault: VAULT, startL2: BLOCK, endL2: closeAt, sumNotionalWei: BUY_NOTIONAL, savingsBps: 20, owedWei: (BUY_NOTIONAL * 20n) / 10_000n });
    expect(stored?.window.batchRoot).toBe(fakeRoot(CHAIN_ID, WALLET, fills));
    expect(stored?.status).toBe("OPEN");
    expect(stored?.details).toEqual([expect.objectContaining({ contributionWei: (BUY_NOTIONAL * 20n) / 10_000n }), expect.objectContaining({ dryRun: true })]);

    // The pull: dry run, recorded against the window, nothing collected.
    expect(state.pulls).toEqual([{ windowId: 1, intent: null, outcome: expect.objectContaining({ kind: "DRY_RUN" }) }]);
    expect(submitCalls).toEqual([{ mode: "dry-run", seat: null, windowId: 1 }]);
    expect(state.wallets.get(WALLET)).toMatchObject({ cursorL2: closeAt, owedTotalWei: (BUY_NOTIONAL * 20n) / 10_000n, collectedTotalWei: 0n });
  });

  it("orders the ledger writes: fills, cursor, then window -> owed -> SIGNED -> pull -> OPEN", async () => {
    const { state } = await tick();
    const order = state.calls.filter((c) => !["walletStates", "unwindowedFills", "upsertWallets", "windowsByStatus"].includes(c));
    expect(order).toEqual(["recordFills", `advanceCursor:${closeAt}`, "openWindow", "addOwed", "markWindow:SIGNED", "recordPull:DRY_RUN", "markWindow:OPEN"]);
    // The pass asks for what it already persisted BEFORE it builds anything new:
    // a window whose pull did not collect is picked up again, never stranded.
    expect(state.calls.filter((c) => c === "windowsByStatus")).toHaveLength(3);
    expect(state.calls.indexOf("windowsByStatus")).toBeLessThan(state.calls.indexOf("openWindow"));
  });

  it("asks the chain for exactly the range behind the margin, as OR-topic Transfer scans", async () => {
    const { chain } = await tick();
    const scans = chain.calls.filter((c) => c.method === "eth_getLogs").map((c) => c.params[0] as Record<string, unknown>).filter((f) => f["address"] === undefined);
    expect(scans).toHaveLength(2);
    for (const scan of scans) expect(scan).toMatchObject({ fromBlock: hex(BLOCK), toBlock: hex(closeAt) });
    expect(scans.map((s) => (s["topics"] as unknown[])[1])).toContainEqual([addressTopic(WALLET)]);
    expect(scans.map((s) => (s["topics"] as unknown[])[2])).toContainEqual([addressTopic(WALLET)]);
    // Nothing in the margin is read: the newest 64 blocks are the next pass's.
    const readBlocks = chain.calls.filter((c) => c.method === "eth_getBlockByNumber" && c.params[1] === true).map((c) => BigInt(c.params[0] as string));
    expect(readBlocks.every((n) => n <= closeAt)).toBe(true);
  });

  it("logs the would-be pull with its amounts in dry run (§6)", async () => {
    const logger = capturingLogger();
    await tick(logger.log);
    const [line] = logger.events("pull.dry_run");
    expect(line).toMatchObject({ wallet: WALLET, vault: VAULT, windowId: 1, fills: 1, sumNotionalWei: BUY_NOTIONAL.toString(), owedWei: ((BUY_NOTIONAL * 20n) / 10_000n).toString(), contributionWei: ((BUY_NOTIONAL * 20n) / 10_000n).toString() });
    expect(logger.events("block.fill")).toHaveLength(1);
    expect(logger.events("scan.chunk")).toHaveLength(1);
  });

  it("joins the factory's linked wallets with the ledger's, and picks up the link log", async () => {
    const state = recordingLedger();
    const chain = mockRpc(fixtureChain({ head }));
    await runTick(depsOf({ rpc: chain.rpc, ledger: state.ledger }), scriptedPipeline({ discoverLinkedWallets: undefined }));
    expect([...state.wallets.keys()]).toEqual([WALLET]);
    expect(state.wallets.get(WALLET)?.vault).toBe(VAULT);
    const factoryScan = chain.calls.find((c) => c.method === "eth_getLogs" && (c.params[0] as Record<string, unknown>)["address"] === FACTORY);
    expect(factoryScan?.params[0]).toMatchObject({ fromBlock: hex(LINK_BLOCK - 10n), toBlock: hex(head) });
  });
});

// ── §4: the margin, the cursor, the window ───────────────────────────────────

describe("the finality margin and the cursor (§4)", () => {
  it("does not scan a block until the margin has passed it; the next pass takes it", async () => {
    const state = recordingLedger();
    await seeded(state, WALLET, VAULT, BLOCK - 1n);
    const pipeline = { buildBlockContext: fixtureContext, reconcileBlock: venueOnlyReconcile, batchRoot: fakeRoot, readVaultSnapshot: async () => snapshotOf(), attestPhase0: signedAttest, submitPull: dryRunSubmit, pullGasFloorWei: noGasFloor };

    // head − margin = BLOCK − 1 = cursor: nothing to close, nothing to scan.
    const early = mockRpc(fixtureChain({ head: BLOCK + MARGIN - 1n }));
    const first = await runTick(depsOf({ rpc: early.rpc, ledger: state.ledger }), pipeline);
    expect(first).toMatchObject({ fills: 0, windowsOpened: 0, pulls: 0 });
    expect(early.calls.some((c) => c.method === "eth_getLogs" && (c.params[0] as Record<string, unknown>)["address"] === undefined)).toBe(false);
    expect(state.wallets.get(WALLET)?.cursorL2).toBe(BLOCK - 1n);

    // One block later the margin has passed BLOCK: (BLOCK − 1, BLOCK] closes.
    const later = mockRpc(fixtureChain({ head: BLOCK + MARGIN }));
    const second = await runTick(depsOf({ rpc: later.rpc, ledger: state.ledger }), pipeline);
    expect(second).toMatchObject({ fills: 1, windowsOpened: 1, pulls: 1, deferred: 0 });
    expect(state.windows[0]?.window).toMatchObject({ startL2: BLOCK, endL2: BLOCK });
    expect(state.wallets.get(WALLET)?.cursorL2).toBe(BLOCK);
  });

  it("starts a wallet the ledger has never advanced at the close line, not at genesis", async () => {
    const state = recordingLedger();
    const logger = capturingLogger();
    const head = BLOCK + MARGIN + 6n;
    const chain = mockRpc(fixtureChain({ head }));
    const summary = await runTick(depsOf({ rpc: chain.rpc, ledger: state.ledger, log: logger.log }), scriptedPipeline({ discoverLinkedWallets: undefined }));
    expect(summary).toMatchObject({ wallets: 1, fills: 0, windowsOpened: 0 });
    expect(state.wallets.get(WALLET)?.cursorL2).toBe(head - MARGIN);
    expect(logger.events("wallet.bootstrap")).toHaveLength(1);
    expect(chain.calls.some((c) => c.method === "eth_getLogs" && (c.params[0] as Record<string, unknown>)["address"] === undefined)).toBe(false);
  });

  it("chunks a wallet that is behind at maxLogSpan and loops within the tick (§6)", async () => {
    const state = recordingLedger();
    const cursor = 1_000_000n;
    await seeded(state, WALLET, VAULT, cursor);
    const scripted = scriptedDiscover([]);
    const head = cursor + 25_000n + MARGIN;
    const summary = await runTick(depsOf({ rpc: mockRpc(() => null).rpc, ledger: state.ledger }), scriptedPipeline({ blockNumber: async () => head, discover: scripted.discover }));
    expect(scripted.ranges).toEqual([
      { fromBlock: cursor + 1n, toBlock: cursor + 10_000n },
      { fromBlock: cursor + 10_001n, toBlock: cursor + 20_000n },
      { fromBlock: cursor + 20_001n, toBlock: cursor + 25_000n },
    ]);
    expect(summary).toMatchObject({ fills: 0, windowsOpened: 0 });
    expect(state.wallets.get(WALLET)?.cursorL2).toBe(cursor + 25_000n);
  });

  it("advances the cursor over a clean, empty range even with no window to close", async () => {
    const state = recordingLedger();
    await seeded(state, WALLET, VAULT, 500n);
    const scripted = scriptedDiscover([]);
    await runTick(depsOf({ rpc: mockRpc(() => null).rpc, ledger: state.ledger }), scriptedPipeline({ blockNumber: async () => 1_000n + MARGIN, discover: scripted.discover }));
    expect(state.wallets.get(WALLET)?.cursorL2).toBe(1_000n);
    expect(state.calls).toContain("advanceCursor:1000");
  });
});

describe("refusals (§3.5, §4)", () => {
  const B1 = 1_000_000n;
  const B2 = 1_000_010n;

  /** Refuses B1 — and, as a broken reconciler might, returns a fill alongside — and fills B2. */
  const reconcile = (context: BlockContext): ReconcileOutcome => {
    if (context.blockL2 === B1) {
      return { fills: [fillAt(context.wallet, B1, 5n * 10n ** 15n)], exclusions: [], refusal: { wallet: context.wallet, blockL2: B1, reason: "MULTI_FILL_BLOCK", detail: "two sell-shaped txs" } };
    }
    return { fills: [fillAt(context.wallet, context.blockL2, 10n ** 16n)], exclusions: [{ wallet: context.wallet, txHash: `0x${"ee".repeat(32)}`, blockL2: context.blockL2, reason: "NOT_A_TRADE" }], refusal: null };
  };

  it("holds the cursor before the first refused block; fills after it wait; the refused block's fills are voided", async () => {
    const state = recordingLedger();
    await seeded(state, WALLET, VAULT, B1 - 100n);
    const logger = capturingLogger();
    const scripted = scriptedDiscover([{ wallet: WALLET, blockL2: B1 }, { wallet: WALLET, blockL2: B2 }]);
    const summary = await runTick(
      depsOf({ rpc: mockRpc(() => null).rpc, ledger: state.ledger, log: logger.log }),
      scriptedPipeline({ blockNumber: async () => B2 + 100n + MARGIN, discover: scripted.discover, reconcileBlock: reconcile }),
    );
    expect(summary).toMatchObject({ fills: 1, exclusions: 1, refusals: 1, windowsOpened: 0, pulls: 0 });
    expect(state.refusals).toEqual([{ wallet: WALLET, blockL2: B1, reason: "MULTI_FILL_BLOCK", detail: "two sell-shaped txs" }]);
    expect([...state.fills.values()].map((e) => e.fill.blockL2)).toEqual([B2]);
    expect(state.wallets.get(WALLET)?.cursorL2).toBe(B1 - 1n);
    expect(state.windows).toHaveLength(0);
    expect(logger.events("block.refused")[0]).toMatchObject({ wallet: WALLET, blockL2: B1.toString(), reason: "MULTI_FILL_BLOCK" });
  });

  it("measures the retention from when the refusal was recorded, so a long catch-up still retries the block", async () => {
    const state = recordingLedger();
    await seeded(state, WALLET, VAULT, B1 - 100n);
    const scripted = scriptedDiscover([{ wallet: WALLET, blockL2: B1 }, { wallet: WALLET, blockL2: B2 }]);
    const ages: RefusalAges = new Map();
    // The block is already older than the retention the first time it is read —
    // a worker that was down for a day, or a wallet with a backlog behind it.
    let head = B1 + REFUSAL_RETENTION_L2 + 1n + MARGIN;
    const pass = () =>
      runTick(depsOf({ rpc: mockRpc(() => null).rpc, ledger: state.ledger }), {
        ...scriptedPipeline({ blockNumber: async () => head, discover: scripted.discover, reconcileBlock: reconcile }),
        refusalAges: ages,
      });

    const first = await pass();
    expect(first).toMatchObject({ refusals: 1, windowsOpened: 0, pulls: 0 });
    expect(state.wallets.get(WALLET)?.cursorL2).toBe(B1 - 1n);
    expect(state.windows).toHaveLength(0);

    // Only once it has been held for a whole retention window does the cursor step over it.
    head += REFUSAL_RETENTION_L2 + 1n;
    const second = await pass();
    // B2's fill was recorded on the first pass and is not read again; the block
    // is refused once more, and only now does the window take what waited on it.
    expect(second).toMatchObject({ refusals: 1, fills: 0, windowsOpened: 1, pulls: 1 });
    expect(state.wallets.get(WALLET)?.cursorL2).toBe(head - MARGIN);
    expect(state.windows[0]?.window.fills.map((f) => f.blockL2)).toEqual([B2]);
    expect(state.refusals.map((r) => r.blockL2)).toEqual([B1]);
  });

  it("refuses a block whose context cannot be read as STATE_UNAVAILABLE, and retries it on the next pass", async () => {
    const state = recordingLedger();
    await seeded(state, WALLET, VAULT, B1 - 100n);
    const scripted = scriptedDiscover([{ wallet: WALLET, blockL2: B1 }]);
    let attempts = 0;
    const flaky: TickPipeline["buildBlockContext"] = async (rpc, wallet, blockL2) => {
      attempts += 1;
      if (attempts === 1) throw new StateUnavailableError(wallet, blockL2, "eth_getBlockByNumber returned null; the endpoint does not have this block");
      return emptyContext(rpc, wallet, blockL2);
    };
    const pipeline = scriptedPipeline({ blockNumber: async () => B1 + 10n + MARGIN, discover: scripted.discover, buildBlockContext: flaky, reconcileBlock: (ctx) => ({ fills: [fillAt(ctx.wallet, ctx.blockL2, 10n ** 16n)], exclusions: [], refusal: null }) });
    const first = await runTick(depsOf({ rpc: mockRpc(() => null).rpc, ledger: state.ledger }), pipeline);
    expect(first).toMatchObject({ refusals: 1, fills: 0, windowsOpened: 0 });
    expect(state.refusals[0]).toMatchObject({ wallet: WALLET, blockL2: B1, reason: "STATE_UNAVAILABLE", detail: expect.stringContaining("does not have this block") });
    expect(state.wallets.get(WALLET)?.cursorL2).toBe(B1 - 1n);

    const second = await runTick(depsOf({ rpc: mockRpc(() => null).rpc, ledger: state.ledger }), pipeline);
    expect(second).toMatchObject({ refusals: 0, fills: 1, windowsOpened: 1 });
    expect(state.wallets.get(WALLET)?.cursorL2).toBe(B1 + 10n);
  });

  it("refuses a block an endpoint could not answer for, the same as an unusable answer", async () => {
    const state = recordingLedger();
    await seeded(state, WALLET, VAULT, B1 - 100n);
    const scripted = scriptedDiscover([{ wallet: WALLET, blockL2: B1 }]);
    const summary = await runTick(
      depsOf({ rpc: mockRpc(() => null).rpc, ledger: state.ledger }),
      scriptedPipeline({
        blockNumber: async () => B1 + 10n + MARGIN,
        discover: scripted.discover,
        buildBlockContext: async () => { throw new Error("fetch failed: socket hang up"); },
      }),
    );
    expect(summary).toMatchObject({ refusals: 1, fills: 0 });
    expect(state.refusals[0]).toMatchObject({ blockL2: B1, reason: "STATE_UNAVAILABLE" });
  });

  it("does not dress a bug as a refusal: an exception that is not a failed read ends the pass, at error", async () => {
    const state = recordingLedger();
    await seeded(state, WALLET, VAULT, B1 - 100n);
    const logger = capturingLogger();
    const scripted = scriptedDiscover([{ wallet: WALLET, blockL2: B1 }]);
    const bug = (): ReconcileOutcome => {
      throw new TypeError("cannot read properties of undefined (reading 'topics')");
    };
    await expect(
      runTick(
        depsOf({ rpc: mockRpc(() => null).rpc, ledger: state.ledger, log: logger.log }),
        scriptedPipeline({ blockNumber: async () => B1 + 10n + MARGIN, discover: scripted.discover, reconcileBlock: bug }),
      ),
    ).rejects.toThrow(TypeError);
    // Nothing was recorded as a refusal, so nothing retries it in silence, and
    // the cursor did not move over the block.
    expect(state.refusals).toHaveLength(0);
    expect(state.wallets.get(WALLET)?.cursorL2).toBe(B1 - 100n);
    expect(logger.events("block.reconcile_failed")[0]).toMatchObject({ wallet: WALLET, blockL2: B1.toString() });
  });
});

describe("incomplete wallets (§2 discover, §4)", () => {
  it("records what it found but neither closes nor advances a wallet the scan cannot vouch for", async () => {
    const state = recordingLedger();
    await seeded(state, WALLET, VAULT, BLOCK - 1n);
    const logger = capturingLogger();
    // The nonce says two sent txs; the chain shows one. Discovery reads every
    // block in the range looking for the other, finds nothing, and says so.
    const chain = mockRpc(fixtureChain({ head: BLOCK + MARGIN + 6n, nonceAfter: 0x49n }));
    const summary = await runTick(depsOf({ rpc: chain.rpc, ledger: state.ledger, log: logger.log }), scriptedPipeline({ buildBlockContext: fixtureContext, reconcileBlock: venueOnlyReconcile }));
    expect(summary).toMatchObject({ fills: 1, windowsOpened: 0, pulls: 0 });
    expect(state.wallets.get(WALLET)?.cursorL2).toBe(BLOCK - 1n);
    expect(state.calls.filter((c) => c.startsWith("advanceCursor"))).toEqual([]);
    expect(logger.events("wallet.incomplete")).toHaveLength(1);
  });

  it("does not read a block again once its fill is recorded; the next complete pass closes it", async () => {
    const state = recordingLedger();
    await seeded(state, WALLET, VAULT, BLOCK - 1n);
    let contextReads = 0;
    const counted: TickPipeline["buildBlockContext"] = async (rpc, wallet, blockL2) => { contextReads += 1; return fixtureContext(rpc, wallet, blockL2); };
    const pipeline = scriptedPipeline({ buildBlockContext: counted, reconcileBlock: venueOnlyReconcile });
    await runTick(depsOf({ rpc: mockRpc(fixtureChain({ head: BLOCK + MARGIN + 6n, nonceAfter: 0x49n })).rpc, ledger: state.ledger }), pipeline);
    expect(contextReads).toBe(1);
    const summary = await runTick(depsOf({ rpc: mockRpc(fixtureChain({ head: BLOCK + MARGIN + 6n })).rpc, ledger: state.ledger }), pipeline);
    expect(contextReads).toBe(1);
    expect(summary).toMatchObject({ fills: 0, windowsOpened: 1, pulls: 1 });
    expect(state.windows[0]?.window.fills.map((f) => f.txHash)).toEqual([BUY_V3]);
  });

  it("closes the chunks before the one that came back incomplete", async () => {
    const state = recordingLedger();
    const cursor = 1_000_000n;
    await seeded(state, WALLET, VAULT, cursor);
    let chunk = 0;
    const discover: TickPipeline["discover"] = async (_rpc, _wallets, range) => {
      chunk += 1;
      return { fromBlock: range.fromBlock, toBlock: range.toBlock, candidates: [], incompleteWallets: chunk === 2 ? [WALLET] : [] };
    };
    await runTick(depsOf({ rpc: mockRpc(() => null).rpc, ledger: state.ledger }), scriptedPipeline({ blockNumber: async () => cursor + 25_000n + MARGIN, discover }));
    expect(chunk).toBe(3);
    expect(state.wallets.get(WALLET)?.cursorL2).toBe(cursor + 10_000n);
  });
});

// ── §4 minimum window, §5/§6 attest and pull ─────────────────────────────────

describe("the minimum window (§4)", () => {
  const B1 = 2_000_000n;
  const B2 = 2_000_500n;
  const small = 10n ** 14n; // 20 bps of 1e14 = 2e11 < the 1e12 minimum

  it("keeps a sub-minimum window growing across passes; the owed amount is never lost", async () => {
    const state = recordingLedger();
    await seeded(state, WALLET, VAULT, B1 - 10n);
    const logger = capturingLogger();
    const scripted = scriptedDiscover([{ wallet: WALLET, blockL2: B1 }, { wallet: WALLET, blockL2: B2 }]);
    const reconcile = (ctx: BlockContext): ReconcileOutcome => ({ fills: [fillAt(ctx.wallet, ctx.blockL2, small)], exclusions: [], refusal: null });
    const pipeline = scriptedPipeline({ discover: scripted.discover, reconcileBlock: reconcile });

    const first = await runTick(depsOf({ rpc: mockRpc(() => null).rpc, ledger: state.ledger, log: logger.log }), { ...pipeline, blockNumber: async () => B1 + 10n + MARGIN });
    expect(first).toMatchObject({ fills: 1, windowsOpened: 0, pulls: 0, deferred: 1 });
    expect(logger.events("window.growing")[0]).toMatchObject({ reason: "BELOW_MINIMUM", owedWei: ((small * 20n) / 10_000n).toString() });
    expect(state.wallets.get(WALLET)?.cursorL2).toBe(B1 + 10n);
    expect(state.wallets.get(WALLET)?.owedTotalWei).toBe(0n);

    // A second fill lifts the window over the minimum; it spans BOTH fills,
    // from the first one's block — below the cursor, above the last window.
    const second = await runTick(depsOf({ rpc: mockRpc(() => null).rpc, ledger: state.ledger, log: logger.log }), { ...pipeline, blockNumber: async () => B2 + 10n + MARGIN, readVaultSnapshot: async () => snapshotOf({ minContributionWei: 3n * 10n ** 11n }) });
    expect(second).toMatchObject({ fills: 1, windowsOpened: 1, pulls: 1, deferred: 0 });
    expect(state.windows[0]?.window).toMatchObject({ startL2: B1, endL2: B2 + 10n, sumNotionalWei: 2n * small, owedWei: (2n * small * 20n) / 10_000n });
    expect(state.windows[0]?.window.fills.map((f) => f.blockL2)).toEqual([B1, B2]);
    expect(state.wallets.get(WALLET)?.owedTotalWei).toBe((2n * small * 20n) / 10_000n);
  });

  it("waits below the pull's gas floor", async () => {
    const state = recordingLedger();
    await seeded(state, WALLET, VAULT, B1 - 10n);
    const logger = capturingLogger();
    const scripted = scriptedDiscover([{ wallet: WALLET, blockL2: B1 }]);
    const summary = await runTick(
      depsOf({ rpc: mockRpc(() => null).rpc, ledger: state.ledger, log: logger.log }),
      scriptedPipeline({ blockNumber: async () => B1 + 10n + MARGIN, discover: scripted.discover, reconcileBlock: (ctx) => ({ fills: [fillAt(ctx.wallet, ctx.blockL2, 10n ** 16n)], exclusions: [], refusal: null }), pullGasFloorWei: async () => 10n ** 18n }),
    );
    expect(summary).toMatchObject({ windowsOpened: 0, deferred: 1 });
    expect(logger.events("window.growing")[0]).toMatchObject({ reason: "BELOW_GAS_FLOOR", gasFloorWei: (10n ** 18n).toString() });
  });

  it("derives the default gas floor from eth_gasPrice at ~2× the Phase 0 pull gas", async () => {
    const chain = mockRpc((method) => (method === "eth_gasPrice" ? "0x10" : null));
    expect(await pullGasFloorWei(chain.rpc)).toBe(2n * PHASE0_PULL_GAS * 16n);
    await expect(pullGasFloorWei(mockRpc(() => 16).rpc)).rejects.toThrow(/eth_gasPrice/);
  });

  it("leaves fills at or below the vault's frontier out of the window (Phase 0 cannot take them)", async () => {
    const state = recordingLedger();
    await seeded(state, WALLET, VAULT, B1 - 10n);
    const logger = capturingLogger();
    const scripted = scriptedDiscover([{ wallet: WALLET, blockL2: B1 }, { wallet: WALLET, blockL2: B2 }]);
    const summary = await runTick(
      depsOf({ rpc: mockRpc(() => null).rpc, ledger: state.ledger, log: logger.log }),
      scriptedPipeline({ blockNumber: async () => B2 + 10n + MARGIN, discover: scripted.discover, reconcileBlock: (ctx) => ({ fills: [fillAt(ctx.wallet, ctx.blockL2, 10n ** 16n)], exclusions: [], refusal: null }), readVaultSnapshot: async () => snapshotOf({ frontierEndL2: B1 }) }),
    );
    expect(summary).toMatchObject({ fills: 2, windowsOpened: 1 });
    expect(state.windows[0]?.window.fills.map((f) => f.blockL2)).toEqual([B2]);
    expect(state.windows[0]?.window.startL2).toBe(B2);
    expect(logger.events("window.below_frontier")[0]).toMatchObject({ wallet: WALLET, fills: 1 });
    // The frontier-bound fill is still there, unwindowed and visible.
    expect(await state.ledger.unwindowedFills(WALLET, B2)).toHaveLength(1);
  });
});

describe("attest and pull (§5, §6)", () => {
  const B1 = 3_000_000n;
  const head = B1 + 10n + MARGIN;

  async function pass(parts: Partial<TickPipeline>, deps: Partial<TickDeps> = {}) {
    const state = recordingLedger();
    await seeded(state, WALLET, VAULT, B1 - 10n);
    const scripted = scriptedDiscover([{ wallet: WALLET, blockL2: B1 }]);
    const logger = capturingLogger();
    const summary = await runTick(
      depsOf({ rpc: mockRpc(() => null).rpc, ledger: state.ledger, log: logger.log, ...deps }),
      scriptedPipeline({ blockNumber: async () => head, discover: scripted.discover, reconcileBlock: (ctx) => ({ fills: [fillAt(ctx.wallet, ctx.blockL2, 10n ** 16n)], exclusions: [], refusal: null }), ...parts }),
    );
    return { state, summary, logger };
  }

  it("does not persist a window the attester deferred; its fills wait, unwindowed", async () => {
    let submitted = 0;
    const { state, summary, logger } = await pass({
      attestPhase0: async (): Promise<AttestOutcome> => ({ kind: "DEFERRED", reason: "L1_NOT_ADVANCED", detail: "endBlock == head" }),
      submitPull: async () => { submitted += 1; throw new Error("must not be called"); },
    });
    expect(summary).toMatchObject({ fills: 1, windowsOpened: 0, pulls: 0, deferred: 1 });
    expect(submitted).toBe(0);
    expect(state.windows).toHaveLength(0);
    expect(await state.ledger.unwindowedFills(WALLET, head)).toHaveLength(1);
    expect(logger.events("attest.deferred")[0]).toMatchObject({ reason: "L1_NOT_ADVANCED", detail: "endBlock == head" });
  });

  it("hands the signed attestation, the snapshot's pass and the seat to submitPull", async () => {
    const seen: unknown[][] = [];
    const seat = { walletIdOf: async () => "w1", signTransaction: async (): Promise<Hex> => "0x00" };
    const { state } = await pass({ submitPull: async (...args) => { seen.push(args); return dryRunSubmit(...args); } }, { seat });
    const args = seen[0];
    expect(args?.[1]).toBe("dry-run");
    expect(args?.[2]).toBe(EXECUTOR);
    expect(args?.[3]).toBe(state.windows[0]?.window);
    expect((args?.[4] as SettlementAttestation).ledgerRoot).toBe(state.windows[0]?.window.batchRoot);
    expect(args?.[5]).toBe(SIGNATURE);
    expect(args?.[6]).toBe(state.windows[0]?.window.owedWei);
    expect(args?.[7]).toBe(seat);
    expect(args?.[8]).toBe(state.ledger);
    expect(args?.[9]).toBe(1);
  });

  it("marks a SENT pull SUBMITTED and adds the contribution to collected, in order", async () => {
    const sent: TickPipeline["submitPull"] = async (_rpc, mode, _executor, window, attestation, signature, contributionWei) => {
      expect(mode).toBe("live");
      const intent: PullIntent = { window, attestation, signature, contributionWei, nonce: 7, rawTx: "0x02aa", txHash: `0x${"77".repeat(32)}` };
      return { kind: "SENT", intent };
    };
    const { state, summary, logger } = await pass({ submitPull: sent }, { config: configOf({ mode: "live" }) });
    expect(summary).toMatchObject({ windowsOpened: 1, pulls: 1, deferred: 0 });
    expect(state.windows[0]?.status).toBe("SUBMITTED");
    expect(state.windows[0]?.details.at(-1)).toMatchObject({ txHash: `0x${"77".repeat(32)}`, nonce: 7 });
    expect(state.pulls[0]?.intent?.txHash).toBe(`0x${"77".repeat(32)}`);
    // A BROADCAST IS NOT A RECEIPT: owed is on the account, collected is not —
    // the next pass reads the vault's frontier and credits what landed.
    expect(state.wallets.get(WALLET)).toMatchObject({ owedTotalWei: (10n ** 16n * 20n) / 10_000n, collectedTotalWei: 0n });
    const order = state.calls.filter((c) => ["openWindow", "addOwed", "markWindow:SIGNED", "recordPull:SENT", "markWindow:SUBMITTED", "addCollected"].includes(c));
    expect(order).toEqual(["openWindow", "addOwed", "markWindow:SIGNED", "recordPull:SENT", "markWindow:SUBMITTED"]);
    expect(logger.events("pull.sent")).toHaveLength(1);
  });

  it("keeps a SKIPPED pull's window OPEN with the reason, and collects nothing", async () => {
    const { state, summary, logger } = await pass({ submitPull: async () => ({ kind: "SKIPPED", reason: "SEAT_REVOKED", detail: "no app signer on the wallet" }) });
    expect(summary).toMatchObject({ windowsOpened: 1, pulls: 0, deferred: 1 });
    expect(state.windows[0]?.status).toBe("OPEN");
    expect(state.windows[0]?.details.at(-1)).toEqual({ skipped: "SEAT_REVOKED", detail: "no app signer on the wallet" });
    expect(state.pulls[0]?.outcome.kind).toBe("SKIPPED");
    expect(state.wallets.get(WALLET)?.collectedTotalWei).toBe(0n);
    expect(logger.events("pull.skipped")[0]).toMatchObject({ reason: "SEAT_REVOKED" });
  });

  it("blocks at the attestation when no attester signer is loaded; nothing is persisted", async () => {
    const { state, summary, logger } = await pass({ attestPhase0: async () => { throw new Error("must not be called"); } }, { attester: null });
    expect(summary).toMatchObject({ windowsOpened: 0, deferred: 1 });
    expect(state.windows).toHaveLength(0);
    expect(logger.events("attest.blocked")).toHaveLength(1);
  });

  it("defers a wallet whose live vault disagrees with the ledger's binding", async () => {
    const { state, summary, logger } = await pass({ readVaultSnapshot: async () => snapshotOf({ vault: VAULT_B }), attestPhase0: async () => { throw new Error("must not be called"); } });
    expect(summary).toMatchObject({ windowsOpened: 0, deferred: 1 });
    expect(state.windows).toHaveLength(0);
    expect(logger.events("wallet.vault_mismatch")[0]).toMatchObject({ ledgerVault: VAULT, chainVault: VAULT_B });
  });

  it("passes the pinned clock and the head to the attester", async () => {
    let seen: { unixSeconds: bigint; headL2: bigint } | null = null;
    await pass({ attestPhase0: async (rpc, executor, window, snapshot, signer, now) => { seen = now; return signedAttest(rpc, executor, window, snapshot, signer, now); }, unixSeconds: () => 1_234n });
    expect(seen).toEqual({ unixSeconds: 1_234n, headL2: head });
  });

  it("uses the snapshot's rate and vault for the window, and roots it over the fills", async () => {
    const { state } = await pass({ readVaultSnapshot: async () => snapshotOf({ savingsBps: 50 }) });
    const window = state.windows[0]?.window;
    expect(window).toMatchObject({ savingsBps: 50, owedWei: (10n ** 16n * 50n) / 10_000n, vault: VAULT });
    expect(window?.batchRoot).toBe(fakeRoot(CHAIN_ID, WALLET, window?.fills ?? []));
  });
});

describe("windows a previous pass could not collect (§4, review: stranded volume)", () => {
  const B1 = BLOCK;
  const head = B1 + MARGIN + 1n;
  const closeAt = head - MARGIN;
  const OWED = (10n ** 16n * 20n) / 10_000n;

  /** A pass that leaves a persisted window behind, then a second pass over the same ledger. */
  async function twoPasses(second: Partial<TickPipeline>, secondDeps: Partial<TickDeps> = {}) {
    const state = recordingLedger();
    await seeded(state, WALLET, VAULT, B1 - 10n);
    const first = scriptedDiscover([{ wallet: WALLET, blockL2: B1 }]);
    const logger = capturingLogger();
    const base = (parts: Partial<TickPipeline>, discover: Partial<TickPipeline>) =>
      runTick(depsOf({ rpc: mockRpc(() => null).rpc, ledger: state.ledger, log: logger.log, ...secondDeps }), scriptedPipeline({ blockNumber: async () => head, ...discover, ...parts }));
    // Pass 1: one fill becomes one window whose dry-run pull collects nothing.
    await base({ reconcileBlock: (ctx) => ({ fills: [fillAt(ctx.wallet, ctx.blockL2, 10n ** 16n)], exclusions: [], refusal: null }) }, { discover: first.discover });
    state.calls.length = 0;
    logger.lines.length = 0;
    // Pass 2: nothing new on chain — only what pass 1 left behind.
    const summary = await base(second, { discover: scriptedDiscover([]).discover });
    return { state, summary, logger };
  }

  it("picks up a window left OPEN by a dry run and attests it again, without touching its fills", async () => {
    const { state, summary, logger } = await twoPasses({});
    expect(state.windows).toHaveLength(1);
    expect(summary.windowsOpened).toBe(0);
    expect(state.calls).not.toContain("openWindow");
    expect(state.calls).toContain("markWindow:SIGNED");
    expect(state.calls.filter((c) => c === "addOwed")).toHaveLength(0);
    expect(state.wallets.get(WALLET)?.owedTotalWei).toBe(OWED);
    expect(logger.events("pull.dry_run")).toHaveLength(1);
  });

  it("credits what the chain says landed: a frontier past the window's end confirms it", async () => {
    const { state, summary, logger } = await twoPasses(
      { readVaultSnapshot: async () => snapshotOf({ frontierEndL2: closeAt }) },
    );
    expect(state.windows[0]?.status).toBe("CONFIRMED");
    expect(state.wallets.get(WALLET)).toMatchObject({ owedTotalWei: OWED, collectedTotalWei: OWED });
    expect(summary.pulls).toBe(1);
    expect(logger.events("pull.confirmed")).toHaveLength(1);
    // Confirmed, so nothing is re-attested and nothing is re-sent.
    expect(state.calls).not.toContain("markWindow:SIGNED");
    expect(state.pulls).toHaveLength(1);
  });

  it("does not open a new window in the same pass as a retry: one attestation is in flight per account", async () => {
    const state = recordingLedger();
    await seeded(state, WALLET, VAULT, B1 - 10n);
    const logger = capturingLogger();
    let headL2 = head;
    const run = (discover: Partial<TickPipeline>) =>
      runTick(depsOf({ rpc: mockRpc(() => null).rpc, ledger: state.ledger, log: logger.log }), scriptedPipeline({
        blockNumber: async () => headL2, ...discover,
        reconcileBlock: (ctx) => ({ fills: [fillAt(ctx.wallet, ctx.blockL2, 10n ** 16n)], exclusions: [], refusal: null }),
      }));
    await run({ discover: scriptedDiscover([{ wallet: WALLET, blockL2: B1 }]).discover });
    state.calls.length = 0;
    // A second fill arrives, on a later block, while the first window is still uncollected.
    headL2 = B1 + 2n + MARGIN;
    const summary = await run({ discover: scriptedDiscover([{ wallet: WALLET, blockL2: B1 + 2n }]).discover });
    expect(summary.windowsOpened).toBe(0);
    expect(state.windows).toHaveLength(1);
    expect(state.calls).toContain("recordFills");
  });

  it("treats a broadcast that threw as sent, never re-attesting the same nonce", async () => {
    const { state, logger } = await twoPasses({
      submitPull: async () => {
        throw new PullBroadcastError(
          { window: {} as VolumeWindow, attestation: {} as SettlementAttestation, signature: "0x", contributionWei: OWED, nonce: 9, rawTx: "0x02bb", txHash: `0x${"99".repeat(32)}` },
          new Error("connection reset after send"),
        );
      },
    });
    expect(state.windows[0]?.status).toBe("SUBMITTED");
    expect(state.windows[0]?.details.at(-1)).toMatchObject({ unresolved: true });
    expect(state.wallets.get(WALLET)?.collectedTotalWei).toBe(0n);
    expect(logger.events("pull.unresolved")).toHaveLength(1);
  });
});

describe("the account's activation floor (§5, review: a pause that stalls the wallet)", () => {
  const B1 = 3_000_000n;
  const B2 = 3_000_010n;
  const oneFill = (ctx: BlockContext): ReconcileOutcome => ({ fills: [fillAt(ctx.wallet, ctx.blockL2, 10n ** 16n)], exclusions: [], refusal: null });

  it("leaves fills below the activation block out of the window, and says how many and why", async () => {
    const state = recordingLedger();
    await seeded(state, WALLET, VAULT, B1 - 10n);
    const logger = capturingLogger();
    const scripted = scriptedDiscover([{ wallet: WALLET, blockL2: B1 }, { wallet: WALLET, blockL2: B2 }]);
    const summary = await runTick(
      depsOf({ rpc: mockRpc(() => null).rpc, ledger: state.ledger, log: logger.log }),
      scriptedPipeline({
        blockNumber: async () => B2 + MARGIN + 1n,
        discover: scripted.discover,
        reconcileBlock: oneFill,
        readVaultSnapshot: async () => snapshotOf({ activationBlockL1: B2 }),
      }),
    );
    // The window holds only what the vault could accept; the older fill stays
    // recorded and unwindowed rather than being faked into a range above it.
    expect(summary.windowsOpened).toBe(1);
    expect(state.windows[0]?.window).toMatchObject({ startL2: B2, fills: [expect.objectContaining({ blockL2: B2 })] });
    expect([...state.fills.values()].find((e) => e.fill.blockL2 === B1)?.windowId).toBeNull();
    expect(logger.events("window.below_activation")[0]).toMatchObject({ wallet: WALLET, fills: 1, activationBlockL1: B2.toString() });
  });

  it("opens nothing when every fill is below the floor, and the pass goes on", async () => {
    const state = recordingLedger();
    await seeded(state, WALLET, VAULT, B1 - 10n);
    const logger = capturingLogger();
    const scripted = scriptedDiscover([{ wallet: WALLET, blockL2: B1 }]);
    const summary = await runTick(
      depsOf({ rpc: mockRpc(() => null).rpc, ledger: state.ledger, log: logger.log }),
      scriptedPipeline({
        blockNumber: async () => B2 + MARGIN + 1n,
        discover: scripted.discover,
        reconcileBlock: oneFill,
        readVaultSnapshot: async () => snapshotOf({ activationBlockL1: B2 }),
      }),
    );
    expect(summary).toMatchObject({ fills: 1, windowsOpened: 0, pulls: 0 });
    expect(state.windows).toHaveLength(0);
    expect(logger.events("window.below_activation")[0]).toMatchObject({ fills: 1 });
    // The cursor still moved, so the next block above the floor is windowed normally.
    expect(state.wallets.get(WALLET)?.cursorL2).toBe(B2 + 1n);
  });

  it("voids a persisted window the floor has risen past and opens a new one above it, in the same pass", async () => {
    const state = recordingLedger();
    await seeded(state, WALLET, VAULT, B1 - 10n);
    const logger = capturingLogger();
    let headL2 = B1 + MARGIN + 1n;
    let activationBlockL1 = 0n;
    const run = (discover: TickPipeline["discover"]) =>
      runTick(
        depsOf({ rpc: mockRpc(() => null).rpc, ledger: state.ledger, log: logger.log }),
        scriptedPipeline({
          blockNumber: async () => headL2,
          discover,
          reconcileBlock: oneFill,
          readVaultSnapshot: async () => snapshotOf({ activationBlockL1 }),
        }),
      );

    await run(scriptedDiscover([{ wallet: WALLET, blockL2: B1 }]).discover);
    expect(state.windows[0]?.status).toBe("OPEN");
    logger.lines.length = 0;

    // The admin pauses and unpauses: the binding is re-established and the
    // activation floor lands above everything the first pass recorded.
    activationBlockL1 = B2;
    headL2 = B2 + MARGIN + 1n;
    const summary = await run(scriptedDiscover([{ wallet: WALLET, blockL2: B2 }]).discover);

    expect(state.windows[0]?.status).toBe("FAILED");
    expect(logger.events("window.void_below_activation")[0]).toMatchObject({ wallet: WALLET, windowId: 1, activationBlockL1: B2.toString() });
    // The wallet is not stalled: the pass opens a window over the new fill.
    expect(summary.windowsOpened).toBe(1);
    expect(state.windows[1]?.window.fills.map((f) => f.blockL2)).toEqual([B2]);
  });

  it("asks the chain for no L1 height at all when the account has no activation floor", async () => {
    const state = recordingLedger();
    await seeded(state, WALLET, VAULT, B1 - 10n);
    const asked: bigint[] = [];
    const summary = await runTick(
      depsOf({ rpc: mockRpc(() => null).rpc, ledger: state.ledger }),
      scriptedPipeline({
        blockNumber: async () => B1 + MARGIN + 1n,
        discover: scriptedDiscover([{ wallet: WALLET, blockL2: B1 }]).discover,
        reconcileBlock: oneFill,
        l1BlockOf: async (_rpc, blockL2) => {
          asked.push(blockL2);
          return blockL2;
        },
      }),
    );
    expect(summary.windowsOpened).toBe(1);
    expect(asked).toEqual([]);
  });
});

// ── step 5: the crank, per vault (assessment §4.6) ───────────────────────────

describe("step 5: the vault buys what the pulls left it (assessment §4.6)", () => {
  const B1 = 5_000_000n;
  const head = B1 + 10n + MARGIN;
  const oneFill = (ctx: BlockContext): ReconcileOutcome => ({ fills: [fillAt(ctx.wallet, ctx.blockL2, 10n ** 16n)], exclusions: [], refusal: null });
  const chain = () => mockRpc(() => null).rpc;

  it("pulls first and invests after, and hands the crank a vault rather than a window", async () => {
    const state = recordingLedger();
    await seeded(state, WALLET, VAULT, B1 - 10n);
    const order: string[] = [];
    const crank = scriptedCrank((vault) => {
      order.push("invest");
      return wouldInvest(vault, WALLET, 3n * 10n ** 15n);
    });
    const logger = capturingLogger();
    const summary = await runTick(
      depsOf({ rpc: chain(), ledger: state.ledger, log: logger.log }),
      scriptedPipeline({
        blockNumber: async () => head,
        discover: scriptedDiscover([{ wallet: WALLET, blockL2: B1 }]).discover,
        reconcileBlock: oneFill,
        submitPull: async (...args) => {
          order.push("pull");
          return dryRunSubmit(...args);
        },
        crankVault: crank.crankVault,
      }),
    );
    expect(summary).toMatchObject({ fills: 1, windowsOpened: 1, pulls: 1, investments: 1, investDeferred: 0 });
    // THE ORDER IS THE POINT: the crank spends what earlier passes collected, so
    // it runs after this pass has pulled, never among the wallets.
    expect(order).toEqual(["pull", "invest"]);
    expect(crank.calls).toEqual([{ vault: VAULT, accounts: [WALLET], mode: "dry-run", seat: null }]);
    expect(logger.events("invest.dry_run")[0]).toMatchObject({ vault: VAULT, account: WALLET, amountInWei: (3n * 10n ** 15n).toString() });
  });

  it("a crank that says wait defers that vault and nothing else", async () => {
    const state = recordingLedger();
    await seeded(state, WALLET, VAULT, B1 - 10n);
    const logger = capturingLogger();
    const crank = scriptedCrank(() => ({ kind: "DEFERRED", reason: "BELOW_MINIMUM", detail: "3 wei investable, the vault's minimum is 4" }));
    const summary = await runTick(
      depsOf({ rpc: chain(), ledger: state.ledger, log: logger.log }),
      scriptedPipeline({
        blockNumber: async () => head,
        discover: scriptedDiscover([{ wallet: WALLET, blockL2: B1 }]).discover,
        reconcileBlock: oneFill,
        crankVault: crank.crankVault,
      }),
    );
    expect(summary).toMatchObject({ windowsOpened: 1, pulls: 1, investments: 0, investDeferred: 1 });
    // Its own counter: the window closed and pulled perfectly well. A basket
    // that is not bought yet is not a deferred window.
    expect(summary.deferred).toBe(0);
    expect(logger.events("invest.deferred")[0]).toMatchObject({
      vault: VAULT,
      accounts: 1,
      reason: "BELOW_MINIMUM",
      detail: "3 wei investable, the vault's minimum is 4",
    });
  });

  it("a crank that throws is contained: the next vault still gets its pass, with the reason on the record", async () => {
    const state = recordingLedger();
    await seeded(state, WALLET, VAULT, B1 - 10n);
    await seeded(state, WALLET_B, VAULT_B, B1 - 10n);
    const logger = capturingLogger();
    const crank = scriptedCrank((vault) => {
      if (vault === VAULT) throw new Error("the adapter registry would not answer");
      return wouldInvest(vault, WALLET_B, 10n ** 15n);
    });
    const summary = await runTick(
      depsOf({ rpc: chain(), ledger: state.ledger, log: logger.log }),
      scriptedPipeline({
        blockNumber: async () => head,
        discover: scriptedDiscover([{ wallet: WALLET, blockL2: B1 }, { wallet: WALLET_B, blockL2: B1 + 1n }]).discover,
        reconcileBlock: oneFill,
        readVaultSnapshot: async (_rpc, _factory, _executor, account) =>
          account === WALLET ? snapshotOf() : snapshotOf({ vault: VAULT_B, account: WALLET_B }),
        crankVault: crank.crankVault,
      }),
    );
    expect(summary).toMatchObject({ wallets: 2, pulls: 2, investments: 1, investDeferred: 1 });
    expect(logger.events("invest.failed")[0]).toMatchObject({ vault: VAULT, accounts: 1, detail: "the adapter registry would not answer" });
    // Both vaults were asked, in address order: the throw did not end the loop.
    expect(crank.calls.map((call) => call.vault)).toEqual([VAULT, VAULT_B]);
  });

  it("two wallets on one vault produce ONE invest attempt", async () => {
    const state = recordingLedger();
    await seeded(state, WALLET, VAULT, B1 - 10n);
    await seeded(state, WALLET_B, VAULT, B1 - 10n);
    const crank = scriptedCrank((vault, accounts) => wouldInvest(vault, accounts[0] ?? WALLET, 10n ** 15n));
    const summary = await runTick(
      depsOf({ rpc: chain(), ledger: state.ledger }),
      scriptedPipeline({
        blockNumber: async () => head,
        discover: scriptedDiscover([{ wallet: WALLET, blockL2: B1 }, { wallet: WALLET_B, blockL2: B1 + 1n }]).discover,
        reconcileBlock: oneFill,
        readVaultSnapshot: async (_rpc, _factory, _executor, account) => snapshotOf({ account }),
        crankVault: crank.crankVault,
      }),
    );
    // Two wallets, two windows, two pulls — and ONE invest: `invest()` spends
    // the vault's whole WETH balance against one hashed basket, so a second
    // call would buy nothing and pay for the revert. Both wallets are handed
    // over, because only the crank knows which of them may sign.
    expect(summary).toMatchObject({ wallets: 2, windowsOpened: 2, pulls: 2, investments: 1, investDeferred: 0 });
    expect(crank.calls).toHaveLength(1);
    expect(crank.calls[0]).toMatchObject({ vault: VAULT, accounts: [WALLET, WALLET_B] });
  });
});

describe("fault containment", () => {
  it("one wallet's failure is logged and the others still get their pass", async () => {
    const B1 = 4_000_000n;
    const state = recordingLedger();
    await seeded(state, WALLET, VAULT, B1 - 10n);
    await seeded(state, WALLET_B, VAULT_B, B1 - 10n);
    const logger = capturingLogger();
    const scripted = scriptedDiscover([{ wallet: WALLET, blockL2: B1 }, { wallet: WALLET_B, blockL2: B1 + 1n }]);
    const summary = await runTick(
      depsOf({ rpc: mockRpc(() => null).rpc, ledger: state.ledger, log: logger.log }),
      scriptedPipeline({
        blockNumber: async () => B1 + 10n + MARGIN,
        discover: scripted.discover,
        reconcileBlock: (ctx) => ({ fills: [fillAt(ctx.wallet, ctx.blockL2, 10n ** 16n)], exclusions: [], refusal: null }),
        readVaultSnapshot: async (_rpc, _factory, _executor, account) => {
          if (account === WALLET) throw new Error("vault read timed out");
          return snapshotOf({ vault: VAULT_B, account: WALLET_B });
        },
      }),
    );
    expect(summary).toMatchObject({ wallets: 2, fills: 2, windowsOpened: 1, pulls: 1, deferred: 1 });
    expect(logger.events("wallet.failed")[0]).toMatchObject({ wallet: WALLET, detail: "vault read timed out" });
    expect(state.windows[0]?.window.wallet).toBe(WALLET_B);
    // Both cursors advanced: the range was clean; only the window failed.
    expect(state.wallets.get(WALLET)?.cursorL2).toBe(B1 + 10n);
  });

  it("carries the factory-scan watermark between passes, with the margin as rescan overlap", async () => {
    const state = recordingLedger();
    const ranges: { fromBlock: bigint; toBlock: bigint }[] = [];
    const linked: TickPipeline["discoverLinkedWallets"] = async (_rpc, _factory, range) => { ranges.push(range); return []; };
    const factoryScan = { scannedTo: null as bigint | null };
    const config = configOf({ logsFromBlock: 100n });
    const deps = depsOf({ rpc: mockRpc(() => null).rpc, ledger: state.ledger, config });
    await runTick(deps, { ...scriptedPipeline({ blockNumber: async () => 5_000n, discoverLinkedWallets: linked }), factoryScan });
    await runTick(deps, { ...scriptedPipeline({ blockNumber: async () => 5_050n, discoverLinkedWallets: linked }), factoryScan });
    await runTick(deps, scriptedPipeline({ blockNumber: async () => 5_100n, discoverLinkedWallets: linked }));
    expect(ranges).toEqual([
      { fromBlock: 100n, toBlock: 5_000n },
      { fromBlock: 5_000n - MARGIN, toBlock: 5_050n },
      // A lone `tick` has no previous pass: the operator's floor.
      { fromBlock: 100n, toBlock: 5_100n },
    ]);
    expect(factoryScan.scannedTo).toBe(5_050n);
  });
});

// ── the schedule: skipWhileRunning, heartbeat, runLoop ───────────────────────

describe("skipWhileRunning (ported from keeper-old cycle.ts)", () => {
  it("skips a call that arrives while the previous one is running, and says so", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let runs = 0;
    let skips = 0;
    const cycle = skipWhileRunning(async () => { runs += 1; await gate; }, () => { skips += 1; });
    const first = cycle();
    await cycle();
    expect(runs).toBe(1);
    expect(skips).toBe(1);
    release();
    await first;
    await cycle();
    expect(runs).toBe(2);
  });

  it("releases the latch when the body throws", async () => {
    let calls = 0;
    const cycle = skipWhileRunning(async () => { calls += 1; if (calls === 1) throw new Error("boom"); }, () => { throw new Error("must not skip"); });
    await expect(cycle()).rejects.toThrow("boom");
    await cycle();
    expect(calls).toBe(2);
  });
});

describe("the heartbeat watchdog (ported from keeper-old alerts.ts)", () => {
  it("fires once when passes stop completing, and resets on the next beat", () => {
    let t = 0;
    const logger = capturingLogger();
    const heartbeat = createHeartbeat({ log: logger.log, name: "worker", silenceMs: 1_000, now: () => t });
    t = 500;
    expect(heartbeat.check()).toBe(false);
    t = 1_000;
    expect(heartbeat.check()).toBe(true);
    expect(heartbeat.check()).toBe(false);
    expect(logger.events("worker.silent")).toHaveLength(1);
    expect(logger.events("worker.silent")[0]).toMatchObject({ quietForMs: 1_000 });
    heartbeat.beat();
    t = 2_500;
    expect(heartbeat.check()).toBe(true);
  });
});

describe("runLoop (§2 loop: heartbeat per pass, never overlaps)", () => {
  afterEach(() => vi.useRealTimers());

  /** A loop whose passes wait on a gate the test opens: how long a pass takes is the test's decision. */
  function controllableLoop(options: { pollMs: number; silenceMs?: number; watchdogMs?: number; failFirst?: boolean; ledgerLostOnPass?: number }) {
    vi.useFakeTimers();
    const gates: (() => void)[] = [];
    let inflight = 0;
    let peak = 0;
    let passes = 0;
    const blockNumber: TickPipeline["blockNumber"] = async () => {
      passes += 1;
      inflight += 1;
      peak = Math.max(peak, inflight);
      try {
        if (options.ledgerLostOnPass === passes) throw new LedgerConnectionLostError("the server closed the connection");
        if (options.failFirst === true && passes === 1) throw new Error("rpc down");
        await new Promise<void>((resolve) => gates.push(resolve));
        return 1_000n;
      } finally {
        inflight -= 1;
      }
    };
    const logger = capturingLogger();
    const stop = new AbortController();
    const state = recordingLedger();
    const done = runLoop(depsOf({ rpc: mockRpc(() => null).rpc, ledger: state.ledger, log: logger.log }), {
      pollMs: options.pollMs,
      signal: stop.signal,
      silenceMs: options.silenceMs,
      watchdogMs: options.watchdogMs,
      pipeline: scriptedPipeline({ blockNumber, discover: async (_r, _w, range) => ({ ...range, candidates: [], incompleteWallets: [] }) }),
    });
    // Handled here as well as in the test, so a loop that ends by rejecting does
    // not read as an unhandled rejection before the test gets to await it.
    void done.catch(() => undefined);
    const open = async () => {
      const gate = gates.shift();
      if (gate === undefined) throw new Error("no pass is waiting");
      gate();
      await vi.advanceTimersByTimeAsync(0);
    };
    return { done, stop, logger, open, passes: () => passes, peak: () => peak, waiting: () => gates.length };
  }

  it("runs the first pass before the interval exists, then one per interval, skipping while one is running", async () => {
    const loop = controllableLoop({ pollMs: 1_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(loop.passes()).toBe(1);
    // The interval does not exist yet: time passing does not start a second pass.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(loop.passes()).toBe(1);
    await loop.open();
    expect(loop.logger.events("worker.heartbeat")).toHaveLength(1);
    expect(loop.logger.events("worker.heartbeat")[0]).toMatchObject({ pass: 1, headL2: "1000", wallets: 0 });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(loop.passes()).toBe(2);
    // The next firing lands while pass 2 is still waiting: skipped, not queued.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(loop.passes()).toBe(2);
    expect(loop.logger.events("worker.skip")).toHaveLength(1);
    await loop.open();
    expect(loop.logger.events("worker.heartbeat")).toHaveLength(2);
    expect(loop.peak()).toBe(1);

    loop.stop.abort();
    await vi.advanceTimersByTimeAsync(0);
    await loop.done;
    expect(loop.logger.events("worker.stop")[0]).toMatchObject({ passes: 2 });
  });

  it("logs a failed pass and keeps going", async () => {
    const loop = controllableLoop({ pollMs: 1_000, failFirst: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(loop.logger.events("worker.tick_failed")[0]).toMatchObject({ pass: 1, detail: "rpc down" });
    await vi.advanceTimersByTimeAsync(1_000);
    await loop.open();
    expect(loop.logger.events("worker.heartbeat")[0]).toMatchObject({ pass: 2 });
    loop.stop.abort();
    await loop.done;
  });

  it("ends the loop and rejects when the ledger connection is lost: its advisory lock went with it", async () => {
    const loop = controllableLoop({ pollMs: 1_000, ledgerLostOnPass: 2 });
    await vi.advanceTimersByTimeAsync(0);
    await loop.open();
    expect(loop.logger.events("worker.heartbeat")).toHaveLength(1);

    // Pass 2 finds the connection gone. Nothing is retried: a second worker may
    // already hold the lock, and two of them would pull the same fills twice.
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(loop.done).rejects.toBeInstanceOf(LedgerConnectionLostError);
    expect(loop.logger.events("worker.ledger_lost")[0]).toMatchObject({ pass: 2 });
    expect(loop.logger.events("worker.tick_failed")).toHaveLength(0);
    expect(loop.logger.events("worker.stop")[0]).toMatchObject({ passes: 2, fatal: expect.stringContaining("advisory lock") });

    // The interval is gone with it: time passing starts no further pass.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(loop.passes()).toBe(2);
  });

  it("never starts the interval when the very first pass loses the ledger", async () => {
    const loop = controllableLoop({ pollMs: 1_000, ledgerLostOnPass: 1 });
    await vi.advanceTimersByTimeAsync(0);
    await expect(loop.done).rejects.toBeInstanceOf(LedgerConnectionLostError);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(loop.passes()).toBe(1);
  });

  it("says so when no pass completes for longer than the silence, and waits for the pass in flight on stop", async () => {
    const loop = controllableLoop({ pollMs: 1_000, silenceMs: 2_500, watchdogMs: 500 });
    await vi.advanceTimersByTimeAsync(0);
    await loop.open();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(loop.passes()).toBe(2);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(loop.logger.events("worker.silent")).toHaveLength(1);
    expect(loop.logger.events("worker.skip").length).toBeGreaterThan(0);

    let settled = false;
    void loop.done.then(() => { settled = true; });
    loop.stop.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await loop.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    expect(loop.logger.events("worker.heartbeat")).toHaveLength(2);
  });
});
