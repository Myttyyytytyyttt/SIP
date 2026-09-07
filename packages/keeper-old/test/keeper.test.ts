// The tick, end to end, against a synthetic chain.
//
// This is where the four non-negotiables meet. The fixture is a complete,
// self-consistent trading session — buy one token for 1 ETH, sell it for 1.5 ETH
// — assembled from the same four RPC sources the real engine reads, so
// buildSessionReport does genuine work: it reconciles the balance change to the
// wei, verifies delta-flatness against archival balances, and replays the
// inventory. Nothing is stubbed at the verdict level.
//
// The point is that a DRY RUN over a genuinely attestable, genuinely profitable
// session still sends nothing, and that the same window offered a second time is
// refused rather than settled twice.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { KeeperConfig } from "../src/config.js";
import type { RpcClient } from "../src/engine.js";
import {
  buildStatus,
  classifyRevert,
  failureHistory,
  revertBackoffMs,
  runTick,
  type KeeperDeps,
} from "../src/keeper.js";
import { ENGINE_SCHEMA, LEDGER_SCHEMA, Ledger, type LedgerInstance } from "../src/ledger.js";
import { Redactor, Secret, createLogger, type Logger } from "../src/log.js";
import {
  ACCOUNT,
  CHAIN_ID,
  EXECUTOR,
  FACTORY,
  LIMITS,
  TEST_ATTESTER,
  VAULT,
  countingAttesterSigner,
  forbiddenTradingSigner,
  settlementLog,
  stubChain,
  vaultSnapshot,
  type StubChain,
} from "./helpers.js";

const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const TOKEN = "0x00000000000000000000000000000000000000aa";
const ROUTER = "0x00000000000000000000000000000000000000bb";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const hex = (value: bigint): string => `0x${value.toString(16)}`;
const topic = (address: string): string => `0x${address.toLowerCase().slice(2).padStart(64, "0")}`;
const word = (value: bigint): string => `0x${value.toString(16).padStart(64, "0")}`;

const BUY_HASH = "0x1111111111111111111111111111111111111111111111111111111111111111";
const SELL_HASH = "0x2222222222222222222222222222222222222222222222222222222222222222";

const START_L2 = 100n;
const BUY_BLOCK = 101n;
const SELL_BLOCK = 105n;
const HEAD_L2 = 400n; // comfortably beyond the finality margin
const BALANCE_START = 5_000_000_000_000_000_000n;
const SPENT = 1_000_000_000_000_000_000n;
const PROCEEDS = 1_500_000_000_000_000_000n;
const BALANCE_END = BALANCE_START - SPENT + PROCEEDS;
const QTY = 1_000_000n;
/**
 * The L1 heights these L2 blocks map to. Chosen above the fixture's
 * activationBlockL1 (25,633,549) because the executor requires
 * `startBlock >= activationBlock`, and L1/L2 are millions apart on this chain.
 */
const L1_BASE = 25_700_000n;

/**
 * A synthetic Robinhood-Chain-shaped JSON-RPC endpoint.
 *
 * It answers only what the engine asks and throws on anything else, in the same
 * spirit as the engine's own fixture client: if a change needs data the fixture
 * does not contain, the test must fail loudly rather than quietly reconstruct a
 * different answer from a smaller set of facts.
 */
function syntheticRpc(options: { includeSession?: boolean } = {}): RpcClient & { calls: string[] } {
  const includeSession = options.includeSession !== false;
  const calls: string[] = [];

  const blockTxs = (block: bigint): unknown[] => {
    if (!includeSession) return [];
    if (block === BUY_BLOCK) {
      return [{ hash: BUY_HASH, from: ACCOUNT.toLowerCase(), to: ROUTER, value: hex(SPENT), input: "0xaabbccdd" }];
    }
    if (block === SELL_BLOCK) {
      return [{ hash: SELL_HASH, from: ACCOUNT.toLowerCase(), to: ROUTER, value: "0x0", input: "0xddccbbaa" }];
    }
    return [];
  };

  const balanceAt = (block: bigint): bigint => (block < BUY_BLOCK ? BALANCE_START : block < SELL_BLOCK ? BALANCE_START - SPENT : BALANCE_END);
  const tokenAt = (block: bigint): bigint => (includeSession && block >= BUY_BLOCK && block < SELL_BLOCK ? QTY : 0n);

  return {
    calls,
    async call<T>(method: string, params: readonly unknown[] = []): Promise<T> {
      calls.push(method);
      switch (method) {
        case "eth_getBlockByNumber": {
          const block = BigInt(params[0] as string);
          const full = params[1] === true;
          // The L1 mapping is read per block and never derived from an offset:
          // the L1/L2 gap on this chain moved ~900k in a single day.
          return (full
            ? { transactions: blockTxs(block) }
            : { hash: word(block), l1BlockNumber: hex(L1_BASE + block) }) as T;
        }
        case "eth_getLogs": {
          if (!includeSession) return [] as unknown as T;
          const filter = params[0] as { topics: (string | null)[] };
          const from = filter.topics[1];
          const to = filter.topics[2];
          const logs: unknown[] = [];
          // Token in on the buy (router -> wallet), token out on the sell.
          if (to === topic(ACCOUNT)) logs.push({ transactionHash: BUY_HASH, blockNumber: hex(BUY_BLOCK) });
          if (from === topic(ACCOUNT)) logs.push({ transactionHash: SELL_HASH, blockNumber: hex(SELL_BLOCK) });
          return logs as unknown as T;
        }
        case "eth_getTransactionByHash": {
          const hash = params[0] as string;
          return (hash === BUY_HASH
            ? { hash: BUY_HASH, from: ACCOUNT.toLowerCase(), to: ROUTER, value: hex(SPENT), input: "0xaabbccdd" }
            : { hash: SELL_HASH, from: ACCOUNT.toLowerCase(), to: ROUTER, value: "0x0", input: "0xddccbbaa" }) as T;
        }
        case "eth_getTransactionReceipt": {
          const hash = params[0] as string;
          const logs =
            hash === BUY_HASH
              ? [{ address: TOKEN, topics: [TRANSFER_TOPIC, topic(ROUTER), topic(ACCOUNT)], data: word(QTY) }]
              : [{ address: TOKEN, topics: [TRANSFER_TOPIC, topic(ACCOUNT), topic(ROUTER)], data: word(QTY) }];
          // Zero gas keeps the reconciliation identity readable; the engine's own
          // tests already cover the gas term.
          return { from: ACCOUNT.toLowerCase(), status: "0x1", gasUsed: "0x0", effectiveGasPrice: "0x0", logs } as T;
        }
        case "debug_traceTransaction": {
          const hash = params[0] as string;
          // The ONLY source of sell proceeds on this chain: the router unwraps
          // WETH and forwards native ETH by internal call, with no log at all.
          // The proceeds must sit in a CHILD frame — the engine skips the root
          // frame's value because the top-level transaction already accounts for
          // it, and double-counting it would break reconciliation.
          return (hash === SELL_HASH
            ? {
                from: ACCOUNT.toLowerCase(),
                to: ROUTER,
                value: "0x0",
                calls: [{ from: ROUTER, to: ACCOUNT.toLowerCase(), value: hex(PROCEEDS), calls: [] }],
              }
            : { from: ACCOUNT.toLowerCase(), to: ROUTER, value: hex(SPENT), calls: [] }) as T;
        }
        case "eth_getBalance":
          return hex(balanceAt(BigInt(params[1] as string))) as T;
        case "eth_call": {
          const call = params[0] as { to: string; data: string };
          const block = BigInt(params[1] as string);
          if (call.to.toLowerCase() === WETH) return word(0n) as T;
          if (call.to.toLowerCase() === TOKEN) return word(tokenAt(block)) as T;
          return "0x" as T;
        }
        case "eth_getTransactionCount": {
          const block = BigInt(params[1] as string);
          if (!includeSession) return "0x0" as T;
          // The completeness oracle: an independent fact the four sources cannot
          // influence. Two sends inside the window, so it must read 0 -> 2.
          return hex(block < BUY_BLOCK ? 0n : block < SELL_BLOCK ? 1n : 2n) as T;
        }
        default:
          throw new Error(`syntheticRpc has no answer for ${method}; add it deliberately`);
      }
    },
  };
}

const INSTANCE: LedgerInstance = {
  chainId: CHAIN_ID,
  factory: FACTORY,
  executor: EXECUTOR,
  vault: VAULT,
  account: ACCOUNT,
  ledgerSchema: LEDGER_SCHEMA,
  engineSchema: ENGINE_SCHEMA,
};

const dirs: string[] = [];
const openLedgers: Ledger[] = [];
function freshLedger(): Ledger {
  const dir = mkdtempSync(join(tmpdir(), "nuvem-tick-"));
  dirs.push(dir);
  const ledger = Ledger.open({ dir, instance: INSTANCE, noLock: true });
  openLedgers.push(ledger);
  return ledger;
}
afterEach(() => {
  // The store is a real database file now, and Windows will not unlink one that
  // is still open. Close before removing.
  while (openLedgers.length > 0) {
    try {
      openLedgers.pop()?.close();
    } catch {
      /* already closed */
    }
  }
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function testConfig(over: Partial<KeeperConfig> = {}): KeeperConfig {
  const redactor = new Redactor();
  return {
    mode: "dry-run",
    rpcUrl: new Secret("https://example.invalid/v2/key", "rpcUrl"),
    rpcHost: "example.invalid",
    databaseUrl: null,
    probeTxHash: null,
    alertWebhook: null,
    rpcFallbackHosts: [],
    rpcFallbackUrls: [],
    chainId: CHAIN_ID,
    account: ACCOUNT,
    factory: FACTORY,
    executor: EXECUTOR,
    vault: VAULT,
    pauseController: "0x390FA085C9D7fe78763685039249AA724eA56cf5",
    attesterRegistry: "0x3d23f31A31Ec52aD84A45B35BBAF11b535DE8204",
    weth: WETH as `0x${string}`,
    stateDir: ".unused",
    fromBlockL2: START_L2,
    logsFromBlockL2: 0n,
    limits: { ...LIMITS, finalityMarginL2: 64n, maxTickScanSpanBlocks: 20_000n },
    attesterKey: null,
    tradingKey: null,
    redactor,
    printCalldata: false,
    httpHost: null,
    httpPort: null,
    gitSha: "test",
    ...over,
  };
}

function capture(): { lines: string[]; logger: Logger } {
  const lines: string[] = [];
  return { lines, logger: createLogger({ redactor: new Redactor(), sink: (l) => lines.push(l), base: { dryRun: true } }) };
}

/**
 * A stub chain whose L1 head is comfortably past this fixture's L1 boundaries.
 * The executor requires `endBlock < block.number` in L1 space, so a stub whose L1
 * head sat below the window would defer every tick with L1_NOT_ADVANCED — which
 * is correct behaviour, and not what these tests are about.
 *
 * `settlementNonce: 0n` IS PART OF THE FIXTURE, not a convenience. A vault that
 * reports a non-zero settlementNonce has settled before, and a journal with no
 * record of that settlement does not know the boundary it must not cross — so the
 * keeper now refuses every window in that state (see "a wiped volume"). A fixture
 * that wants a clean tick has to describe an account that has genuinely never
 * settled; the previous default described one that had, and every test built on it
 * was quietly asserting behaviour on a blind keeper.
 */
function tickChain(over: Parameters<typeof stubChain>[0] = {}): StubChain {
  return stubChain({
    headBlockL2: HEAD_L2,
    l1BlockNumber: L1_BASE + 10_000n,
    snapshot: vaultSnapshot({ settlementNonce: 0n }),
    ...over,
  });
}

function deps(over: Partial<KeeperDeps> = {}): KeeperDeps & { chain: StubChain } {
  const chain = (over.chain as StubChain | undefined) ?? tickChain();
  return {
    config: testConfig(),
    rpc: syntheticRpc(),
    ledger: over.ledger ?? freshLedger(),
    logger: capture().logger,
    attesterSigner: countingAttesterSigner(),
    tradingSigner: null,
    ...over,
    // Last, so the resolved StubChain wins over anything in `over`.
    chain,
  } as KeeperDeps & { chain: StubChain };
}

describe("guards that run before anything else", () => {
  it("aborts on a chain id mismatch without reading the vault", async () => {
    // viem asserts the chain only on wallet writes, never on reads, so a testnet
    // endpoint answers every read plausibly. This is the cheapest catastrophe
    // available and it is checked first, uncached, every tick.
    const chain = tickChain({ chainId: 46630 });
    const result = await runTick(deps({ chain }));
    expect(result.outcome).toBe("CHAIN_MISMATCH");
    expect(chain.calls).toEqual(["getChainId"]);
  });

  it("refuses to do anything while the degraded latch is set", async () => {
    const ledger = freshLedger();
    ledger.ensureHeader({ settlementNonce: 1n, lifetimeContribution: 0n });
    ledger.append("DEGRADED", { reason: "NONCE_UNRECONCILED", detail: "planted by a test" });
    const result = await runTick(deps({ ledger }));
    expect(result.outcome).toBe("DEGRADED");
    // No discovery happened: the synthetic RPC was never touched.
    expect(ledger.state.counts.CHECKPOINT).toBe(0);
    ledger.close();
  });

  /**
   * Previously this asserted a refusal, and the refusal was a dead end: once the
   * gap passed the limit the keeper declined to scan, the gap kept growing, and
   * it declined forever while still logging ordinary-looking ticks. The tick now
   * scans as much as the limit allows and advances, so a keeper that falls
   * behind walks back to the head instead of stopping for good.
   */
  it("scans a bounded window when far behind rather than refusing forever", async () => {
    const config = testConfig({ fromBlockL2: 0n, limits: { ...LIMITS, maxTickScanSpanBlocks: 10n } });
    const result = await runTick(deps({ config }));
    expect(result.outcome).not.toBe("CATCHUP_TOO_WIDE");
    expect(result.outcome).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// A DAMAGED STORE IS NOT AN EMPTY ONE, AT TICK LEVEL.
//
// The unit-level behaviour is in ledger.test.ts. What is proved here is the
// consequence that matters: over a genuinely attestable, genuinely profitable
// session — the exact fixture that produces a DRY_RUN and a real signature two
// blocks below — a damaged store produces NO SIGNATURE AT ALL. Not a refused
// attestation, not an unsent one: the attester is never called.
// ---------------------------------------------------------------------------
describe("a damaged store settles nothing, and signs nothing", () => {
  /** A ledger whose file is zero bytes: the shape a disk-full write leaves behind. */
  function damagedLedger(): Ledger {
    const dir = mkdtempSync(join(tmpdir(), "nuvem-damaged-"));
    dirs.push(dir);
    writeFileSync(join(dir, "keeper-4663-0x0b503606-0xc455bf7f.db"), "");
    const ledger = Ledger.open({ dir, instance: INSTANCE, noLock: true });
    openLedgers.push(ledger);
    return ledger;
  }

  it("refuses the whole tick before a single RPC call, and NEVER signs", async () => {
    const ledger = damagedLedger();
    expect(ledger.state.condition).toBe("DAMAGED");

    const signer = countingAttesterSigner();
    const chain = tickChain({
      previewContribution: 100_000_000_000_000_000n,
      snapshot: vaultSnapshot({ settlementNonce: 0n, accountBalanceWei: 10_000_000_000_000_000_000n }),
    });
    const result = await runTick(
      deps({
        ledger,
        chain,
        attesterSigner: signer,
        tradingSigner: forbiddenTradingSigner(),
        config: testConfig({ limits: { ...LIMITS, maxContributionWei: 1_000_000_000_000_000_000n } }),
      }),
    );

    expect(result.outcome).toBe("STORE_REFUSED");
    expect(result.detail).toContain("STORE_DAMAGED");
    // NO SIGNATURE. This is the assertion the whole block exists for.
    expect(signer.signCount()).toBe(0);
    // And nothing was broadcast, which in dry run would have thrown anyway.
    expect(chain.sentRaw).toHaveLength(0);
    // Not one RPC call: the store is checked before the chain is touched.
    expect(chain.calls).toEqual([]);
    // The store recorded nothing either — not even the DEGRADED it would like to.
    expect(ledger.state.counts.CONFIRMED).toBe(0);
    expect(ledger.state.counts.INTENT).toBe(0);
  });

  it("says so on `keeper status`, without throwing", async () => {
    const ledger = damagedLedger();
    const status = await buildStatus(deps({ ledger }));
    const store = status.store as Record<string, unknown>;
    expect(store.condition).toBe("DAMAGED");
    expect(store.integrityOk).toBe(false);
    expect(store.settleable).toBe(false);
    expect(String(store.detail)).toContain("ZERO BYTES");
  });
});

describe("a quiet wallet", () => {
  it("advances the anchor and reports no candidate", async () => {
    const ledger = freshLedger();
    const result = await runTick(deps({ ledger, rpc: syntheticRpc({ includeSession: false }) }));
    expect(result.outcome).toBe("NO_CANDIDATE");
    expect(ledger.state.anchorBlockL2).toBe(HEAD_L2 - 64n);
    expect(ledger.state.counts.CHECKPOINT).toBe(1);
    ledger.close();
  });
});

describe("a real session, in dry run", () => {
  it("verifies, attests, and sends absolutely nothing", async () => {
    const ledger = freshLedger();
    const { lines, logger } = capture();
    const signer = countingAttesterSigner();
    // 20% of a 0.5 ETH profit, and a balance that comfortably covers it plus the
    // trading floor, the gas reserve and a gas headroom.
    const chain = tickChain({
      previewContribution: 100_000_000_000_000_000n,
      snapshot: vaultSnapshot({ settlementNonce: 0n, accountBalanceWei: 10_000_000_000_000_000_000n }),
    });
    const d = deps({
      ledger,
      logger,
      chain,
      attesterSigner: signer,
      // A signer that throws if touched, to prove the dry run cannot reach it.
      tradingSigner: forbiddenTradingSigner(),
      config: testConfig({ limits: { ...LIMITS, maxContributionWei: 1_000_000_000_000_000_000n } }),
    });

    const result = await runTick(d);

    expect(result.outcome).toBe("DRY_RUN");
    // The engine did real work and vouched for the window.
    expect(result.report?.verdict).toBe("ATTESTABLE");
    expect(result.report?.reasons).toEqual([]);
    expect(result.report?.startBlockL2).toBe(START_L2);
    expect(result.report?.endBlockL2).toBe(SELL_BLOCK);
    // 5.5 ETH out, 5 ETH in, no external flows, no gas.
    expect(result.report?.realizedProfit).toBe(PROCEEDS - SPENT);
    expect(result.report?.reconciliation.residualWei).toBe(0n);
    // The attested range is L1, read per block.
    expect(result.report?.startBlockL1).toBe(L1_BASE + START_L2);
    expect(result.report?.endBlockL1).toBe(L1_BASE + SELL_BLOCK);

    // An attestation WAS built and signed — that is what a dry run is for.
    expect(signer.signCount()).toBe(1);
    // And nothing reached the wire.
    expect(chain.sentRaw).toEqual([]);
    expect(chain.calls).not.toContain("sendRawTransaction");
    expect(chain.calls).not.toContain("getPendingTransactionCount");

    // The journal recorded an inert DRYRUN and no progress at all.
    expect(ledger.state.counts.DRYRUN).toBe(1);
    expect(ledger.state.counts.INTENT).toBe(0);
    expect(ledger.state.settledSessionIds.size).toBe(0);
    expect(ledger.state.settledFrontierL2).toBeNull();
    expect(ledger.state.settlementCount).toBe(0);

    // The decision line carries the four numbers the contract cannot check
    // against history, plus the plan, plus the mode.
    const decision = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.decision === "DRYRUN");
    expect(decision).toBeDefined();
    expect(decision?.cashStart).toBe(BALANCE_START.toString());
    expect(decision?.cashEnd).toBe(BALANCE_END.toString());
    expect(decision?.externalDeposits).toBe("0");
    expect(decision?.externalWithdrawals).toBe("0");
    expect(decision?.contributionBps).toBe("2000");
    expect(decision?.dryRun).toBe(true);
    const wouldSend = decision?.wouldSend as Record<string, unknown>;
    expect(wouldSend.to).toBe(EXECUTOR);
    expect(wouldSend.from).toBe(ACCOUNT);
    expect(wouldSend.nonce).toBeNull();
    expect(wouldSend.valueWei).toBe("100000000000000000");

    // Every line, without exception, says which mode it was.
    for (const line of lines) expect(JSON.parse(line)).toHaveProperty("dryRun");

    ledger.close();
  });

  it("refuses the window when the engine cannot vouch for it, and records it terminal", async () => {
    // Break reconciliation by exactly one wei: the balance the chain reports no
    // longer matches what the movements predict. This is the shape of a scan that
    // missed something, and it must refuse rather than settle a number nobody can
    // defend.
    const inner = syntheticRpc();
    const rpc: RpcClient = {
      async call<T>(method: string, params: readonly unknown[] = []): Promise<T> {
        if (method === "eth_getBalance" && BigInt(params[1] as string) === SELL_BLOCK) {
          return hex(BALANCE_END + 1n) as T;
        }
        return inner.call<T>(method, params);
      },
    };
    const ledger = freshLedger();
    const signer = countingAttesterSigner();
    const chain = tickChain();

    const result = await runTick(deps({ ledger, rpc, chain, attesterSigner: signer }));

    expect(result.outcome).toBe("REFUSED");
    expect(result.report?.reasons).toContain("NOT_RECONCILED");
    // No signature, and no chain calls beyond the reads the tick already made.
    expect(signer.signCount()).toBe(0);
    expect(chain.calls).not.toContain("deriveSessionId");
    expect(chain.calls).not.toContain("previewContribution");
    // Recorded terminal, so the next tick does not re-verify it forever.
    expect(ledger.state.terminalWindows.get(`${START_L2}:${SELL_BLOCK}`)).toBe("REFUSED");
    ledger.close();
  });

  it("skips a window the chain has already settled, rather than settling it twice", async () => {
    // The crash-after-broadcast case in its most general form: the local ledger
    // knows nothing, and the chain has a SettlementExecuted for this exact
    // sessionId. The chain wins.
    const ledger = freshLedger();
    const signer = countingAttesterSigner();
    const base = tickChain();
    // The stub derives sessionId from bindingEpoch and BOTH ranges — the L1 pair
    // the contract checks against block.number and the L2 pair it progresses on —
    // which is what the real contract folds in, so this is the sessionId this
    // very window will produce.
    const sessionId = await base.deriveSessionId({
      chainId: BigInt(CHAIN_ID),
      vault: VAULT,
      account: ACCOUNT,
      bindingEpoch: 1n,
      startBlockL1: L1_BASE + START_L2,
      endBlockL1: L1_BASE + SELL_BLOCK,
      startBlockL2: START_L2,
      endBlockL2: SELL_BLOCK,
      ledgerRoot: "0x00",
    });
    const chain = tickChain({ settlementLogs: [settlementLog({ sessionId, account: ACCOUNT })] });

    const result = await runTick(deps({ ledger, chain, attesterSigner: signer }));

    expect(result.outcome).toBe("SKIPPED");
    expect(result.detail).toContain("CHAIN_NOVELTY");
    expect(chain.sentRaw).toEqual([]);
    expect(ledger.state.terminalWindows.get(`${START_L2}:${SELL_BLOCK}`)).toBe("ALREADY_SETTLED");
    ledger.close();
  });

  it("skips a window already recorded in the local ledger", async () => {
    const ledger = freshLedger();
    ledger.ensureHeader({ settlementNonce: 0n, lifetimeContribution: 0n });
    // A settlement whose L1 end boundary is at or beyond this window's start, so
    // progression refuses it — the same rule PersonalVault enforces.
    //
    // settlementNonce 0n against a chain nonce of 1n IS the fixture: a chain nonce
    // of N means nonces 0..N-1 were consumed, and reconcile now refuses unless the
    // journal can name every one of them.
    ledger.append("CONFIRMED", {
      startBlockL2: 1n,
      // OVERLAPS IN L2 TOO, which is what makes this a replay rather than an L1
      // range collision. A prior settlement that ends before this window in L2 but
      // at or after it in L1 is a different thing entirely — a genuinely new
      // session the vault will refuse forever — and it now gets its own outcome
      // (see "L1 range collapse is reported as lost revenue").
      endBlockL2: SELL_BLOCK,
      sessionId: "0xaaaa000000000000000000000000000000000000000000000000000000000099",
      bindingEpoch: 1n,
      settlementNonce: 0n,
      startBlockL1: L1_BASE - 10n,
      endBlockL1: L1_BASE + SELL_BLOCK,
      ledgerRoot: "0x00",
      contribution: 1n,
      realizedProfit: 1n,
      txHash: "0xbbbb000000000000000000000000000000000000000000000000000000000099",
      blockNumberL2: 3n,
      gasUsed: 1n,
      source: "own",
    });
    const signer = countingAttesterSigner();
    // settlementNonce must now read 1 for recovery to reconcile: one consumed
    // nonce, and the journal names it.
    const chain = tickChain({ snapshot: vaultSnapshot({ settlementNonce: 1n }) });

    const result = await runTick(deps({ ledger, chain, attesterSigner: signer }));

    expect(result.outcome).toBe("SKIPPED");
    // PROGRESSION_L2, the EPOCH-INDEPENDENT replay rule. It is checked before the
    // epoch-scoped L1 mirror precisely so that a bindingEpoch rebind cannot
    // re-arm this refusal, and so that reaching PROGRESSION_L1 can only ever mean
    // "genuinely new session, chain not ready" — see the L1 range collapse tests.
    expect(result.detail).toMatch(/PROGRESSION_L2/);
    expect(chain.sentRaw).toEqual([]);
    ledger.close();
  });
});

/**
 * A viem transport error, shaped exactly as viem builds one. The second line is
 * the whole problem: our endpoint carries an Alchemy API key, and a routine 429
 * is enough to produce this.
 */
const LEAKY_RPC = "https://robinhood-mainnet.g.alchemy.com/v2/AbCdEf1234567890SecretKey";
const LEAKY_HOST = "robinhood-mainnet.g.alchemy.com";
const LEAKY_KEY = "AbCdEf1234567890SecretKey";

function transportError(): Error {
  const error = new Error(
    [
      "HTTP request failed.",
      "",
      `URL: ${LEAKY_RPC}`,
      'Request body: {"method":"eth_chainId","params":[]}',
      "",
      "Details: fetch failed",
      "Version: viem@2.55.8",
    ].join("\n"),
  );
  error.name = "HttpRequestError";
  return Object.assign(error, {
    shortMessage: "HTTP request failed.",
    metaMessages: [`URL: ${LEAKY_RPC}`, 'Request body: {"method":"eth_chainId"}'],
  });
}

function leakyConfig(): KeeperConfig {
  return testConfig({
    rpcUrl: new Secret(LEAKY_RPC, "rpcUrl"),
    rpcHost: LEAKY_HOST,
    redactor: new Redactor().register(LEAKY_RPC, "rpcUrl"),
  });
}

describe("/status and `keeper status` cannot serve the RPC API key", () => {
  it("summarizes a transport error instead of storing it, so neither the key nor the host escapes", async () => {
    // This payload leaves the process two ways that never touch the redacting
    // logger — send(200, payload) on the unauthenticated /status port, and
    // process.stdout.write in `keeper status`. Both used to carry viem's raw
    // message, whose `URL:` line is well inside the old 200-character slice.
    const ledger = freshLedger();
    const boom = (): never => {
      throw transportError();
    };
    const chain = {
      ...tickChain(),
      getChainId: async () => boom(),
      getHeadBlockL2: async () => boom(),
      readVaultSnapshot: async () => boom(),
    } as unknown as StubChain;

    const status = await buildStatus(deps({ ledger, chain, config: leakyConfig() }));
    const text = JSON.stringify(status);

    expect(text).not.toContain(LEAKY_KEY);
    expect(text).not.toContain("AbCdEf");
    expect(text).not.toContain(LEAKY_HOST);
    expect(text).not.toContain("alchemy.com");
    expect(text).not.toContain("URL:");
    expect(text).not.toContain("Request body");

    // "Unknown" is still said out loud, and the error is still named — a failed
    // read must never be reported as a zero or a false.
    const chainId = status.chainIdObserved as { ok: boolean; error: string };
    expect(chainId.ok).toBe(false);
    expect(chainId.error).toContain("HttpRequestError");
    expect(chainId.error).toContain("HTTP request failed.");
    expect(status.chainOk).toBe(false);
    ledger.close();
  });

  it("withholds the detail entirely if a secret somehow survives the scrub", async () => {
    // The tripwire, exercised with a redactor that reports the secret present and
    // substitutes nothing. Losing the detail of one failed read is cheap.
    const ledger = freshLedger();
    const honest = new Redactor().register(LEAKY_RPC, "rpcUrl");
    const sabotaged = Object.assign(Object.create(Object.getPrototypeOf(honest)), honest) as Redactor;
    Object.defineProperty(sabotaged, "scrub", { value: (text: string) => text });
    Object.defineProperty(sabotaged, "contains", { value: (text: string) => text.includes("HTTP") });
    const config = testConfig({ rpcUrl: new Secret(LEAKY_RPC, "rpcUrl"), rpcHost: LEAKY_HOST, redactor: sabotaged });
    const chain = {
      ...tickChain(),
      getChainId: async (): Promise<number> => {
        throw transportError();
      },
    } as unknown as StubChain;

    const status = await buildStatus(deps({ ledger, chain, config }));
    const chainId = status.chainIdObserved as { ok: boolean; error: string };
    expect(chainId.error).toContain("withheld");
    expect(chainId.error).not.toContain(LEAKY_KEY);
    ledger.close();
  });

  it("does not put the endpoint host in the payload even on the happy path", async () => {
    const ledger = freshLedger();
    const status = await buildStatus(deps({ ledger, config: leakyConfig() }));
    expect(JSON.stringify(status)).not.toContain("alchemy.com");
    ledger.close();
  });
});

describe("a wiped volume", () => {
  it("refuses every window when the chain has settlements the journal cannot name", async () => {
    // THE STATE-LOSS CASE, in the shape production actually produces it: an empty
    // state directory against a vault that has already settled once. The header
    // used to be written here from the CHAIN's nonce, which made the journal agree
    // with the chain by construction and left every idempotency map empty while
    // reporting itself reconciled.
    const ledger = freshLedger();
    const signer = countingAttesterSigner();
    const chain = tickChain({ snapshot: vaultSnapshot({ settlementNonce: 1n }) });

    const result = await runTick(deps({ ledger, chain, attesterSigner: signer }));

    expect(result.outcome).toBe("DEGRADED");
    expect(result.detail).toMatch(/COLD_START_UNACCOUNTED|UNACCOUNTED_SETTLEMENTS/);
    // Nothing was signed, nothing was discovered, and no baseline was invented.
    expect(signer.signCount()).toBe(0);
    expect(chain.sentRaw).toEqual([]);
    expect(ledger.state.counts.CHECKPOINT).toBe(0);
    expect(ledger.state.header?.baselineSettlementNonce).toBeUndefined();
    ledger.close();
  });

  it("says so on /status rather than reporting itself reconciled", async () => {
    const ledger = freshLedger();
    const chain = tickChain({ snapshot: vaultSnapshot({ settlementNonce: 1n }) });
    const status = await buildStatus(deps({ ledger, chain }));
    const history = status.history as Record<string, unknown>;
    expect(history.accounted).toBe(false);
    expect(history.chainSettlementNonce).toBe("1");
    expect(history.journalSettlementRecords).toBe(0);
    ledger.close();
  });

  it("writes a DERIVED baseline once history is accounted for, never the live nonce", async () => {
    // One adopted settlement in the journal against a chain nonce of 1 means the
    // baseline is 0 — arithmetic, not an assumption.
    const ledger = freshLedger();
    ledger.append("ADOPTED", {
      startBlockL2: 0n,
      endBlockL2: 0n,
      sessionId: "0xaaaa000000000000000000000000000000000000000000000000000000000042",
      bindingEpoch: 1n,
      settlementNonce: 0n,
      startBlockL1: L1_BASE - 5_000n,
      endBlockL1: L1_BASE - 4_000n,
      ledgerRoot: "0x00",
      contribution: 403_370_889_498_747n,
      realizedProfit: 2_016_854_447_493_738n,
      txHash: "0xd342d1170000000000000000000000000000000000000000000000000000cad18",
      blockNumberL2: 22_086_130n,
      gasUsed: 0n,
      source: "adopted",
    });
    const chain = tickChain({
      snapshot: vaultSnapshot({ settlementNonce: 1n, lifetimeContribution: 403_370_889_498_747n }),
    });

    await runTick(deps({ ledger, chain, rpc: syntheticRpc({ includeSession: false }) }));

    expect(ledger.state.header?.baselineSettlementNonce).toBe(0n);
    expect(ledger.state.header?.baselineLifetimeContribution).toBe(0n);
    ledger.close();
  });
});

describe("L1 range collapse is reported as lost revenue, not as a duplicate", () => {
  /**
   * A settled window in L2 space well before this session, whose L1 end sits
   * where the caller chooses relative to this session's L1 start.
   *
   * `offset` 0 puts the previous L1 end EXACTLY on this session's L1 start — the
   * round-tripper, which the vault now accepts. `offset` 1 puts it ABOVE, so
   * this session's L1 range runs backwards while its L2 range runs forwards,
   * which is incoherent and still refused.
   */
  function seedCollidingSettlement(ledger: Ledger, offset: bigint): void {
    ledger.ensureHeader({ settlementNonce: 0n, lifetimeContribution: 0n });
    ledger.append("CONFIRMED", {
      startBlockL2: 1n,
      endBlockL2: 50n, // strictly below START_L2, so this session is genuinely NEW
      sessionId: "0xaaaa000000000000000000000000000000000000000000000000000000000099",
      bindingEpoch: 1n,
      settlementNonce: 0n,
      startBlockL1: L1_BASE - 10n,
      endBlockL1: L1_BASE + START_L2 + offset,
      ledgerRoot: "0x00",
      contribution: 1n,
      realizedProfit: 1n,
      txHash: "0xbbbb000000000000000000000000000000000000000000000000000000000099",
      blockNumberL2: 3n,
      gasUsed: 1n,
      source: "own",
    });
  }

  it("settles a session whose L1 start lands on the previous L1 end", async () => {
    // END TO END, THROUGH runTick, of the case the redeploy exists for. The
    // previous settlement's L1 end IS this session's L1 start; the L2 ranges are
    // disjoint and forward. Before the change this returned L1_RANGE_COLLAPSED
    // and burned the window terminal. It must now reach the submit path — and
    // reach it as an ordinary settlement, with nothing recorded as forfeited.
    const ledger = freshLedger();
    seedCollidingSettlement(ledger, 0n);
    const chain = tickChain({
      snapshot: vaultSnapshot({ settlementNonce: 1n, accountBalanceWei: 10_000_000_000_000_000_000n }),
      previewContribution: 100_000_000_000_000_000n,
    });
    const d = deps({
      ledger,
      chain,
      config: testConfig({ limits: { ...LIMITS, maxContributionWei: 1_000_000_000_000_000_000n } }),
    });

    const result = await runTick(d);

    expect(result.outcome).toBe("DRY_RUN");
    expect(ledger.state.terminalWindows.get(`${START_L2}:${SELL_BLOCK}`)).toBeUndefined();
    const status = await buildStatus(d);
    expect((status.l1RangeCollapsed as { count: number }).count).toBe(0);
    ledger.close();
  });

  it("names the forfeited profit and does not claim the window was already settled", async () => {
    const ledger = freshLedger();
    seedCollidingSettlement(ledger, 1n);
    const { lines, logger } = capture();
    const chain = tickChain({
      snapshot: vaultSnapshot({ settlementNonce: 1n, accountBalanceWei: 10_000_000_000_000_000_000n }),
      previewContribution: 100_000_000_000_000_000n,
    });

    const result = await runTick(
      deps({
        ledger,
        logger,
        chain,
        config: testConfig({ limits: { ...LIMITS, maxContributionWei: 1_000_000_000_000_000_000n } }),
      }),
    );

    expect(result.outcome).toBe("L1_RANGE_COLLAPSED");
    expect(result.detail).toContain("forfeited");
    expect(result.detail).toContain((PROCEEDS - SPENT).toString());
    expect(result.detail).toContain("NOT a replay");
    // The label an operator will actually investigate, not ALREADY_SETTLED.
    expect(ledger.state.terminalWindows.get(`${START_L2}:${SELL_BLOCK}`)).toBe("L1_RANGE_COLLAPSED");
    expect(chain.sentRaw).toEqual([]);

    const warned = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l.reasonCode === "L1_RANGE_COLLAPSED");
    expect(warned?.forfeitedRealizedProfitWei).toBe((PROCEEDS - SPENT).toString());
    expect(warned?.forfeitedContributionWei).toBe("100000000000000000");
    ledger.close();
  });

  it("counts every occurrence on /status so the revenue cost is visible", async () => {
    const ledger = freshLedger();
    seedCollidingSettlement(ledger, 1n);
    const chain = tickChain({
      snapshot: vaultSnapshot({ settlementNonce: 1n, accountBalanceWei: 10_000_000_000_000_000_000n }),
      previewContribution: 100_000_000_000_000_000n,
    });
    const d = deps({
      ledger,
      chain,
      config: testConfig({ limits: { ...LIMITS, maxContributionWei: 1_000_000_000_000_000_000n } }),
    });
    await runTick(d);

    const status = await buildStatus(d);
    const collapsed = status.l1RangeCollapsed as { count: number; windows: { window: string; detail: string }[] };
    expect(collapsed.count).toBe(1);
    expect(collapsed.windows[0]?.window).toBe(`${START_L2}:${SELL_BLOCK}`);
    // The note must describe the condition that ACTUALLY produced this outcome.
    // It used to say the attestation schema was too coarse and that fixing it
    // needed a contract change; the schema now carries the L2 range and that
    // sentence would send an operator to fix something already fixed.
    expect(collapsed.windows[0]?.detail).toContain("RUNS BACKWARDS");
    expect(collapsed.windows[0]?.detail).not.toContain("contract change");
    ledger.close();
  });

  it("still refuses, honestly, when the prior settlement's L2 window is unknown", async () => {
    // An ADOPTED record whose L2 window could not be recovered carries 0 in both
    // slots, and 0 there means UNKNOWN, never "block zero". The settled L2
    // frontier is therefore unknown, so "new session" and "replay" are genuinely
    // indistinguishable. Refusing is right; claiming lost revenue would not be,
    // and burning the window under the ALREADY_SETTLED label — which is what used
    // to happen — hides a recoverable condition behind the one reason code an
    // operator never investigates.
    const ledger = freshLedger();
    ledger.ensureHeader({ settlementNonce: 0n, lifetimeContribution: 0n });
    ledger.append("ADOPTED", {
      startBlockL2: 0n,
      endBlockL2: 0n,
      sessionId: "0xcccc000000000000000000000000000000000000000000000000000000000099",
      bindingEpoch: 1n,
      settlementNonce: 0n,
      startBlockL1: L1_BASE - 10n,
      endBlockL1: L1_BASE + START_L2,
      ledgerRoot: "0x00",
      contribution: 1n,
      realizedProfit: 1n,
      txHash: "0xdddd000000000000000000000000000000000000000000000000000000000099",
      blockNumberL2: 3n,
      gasUsed: 1n,
      source: "adopted",
    });
    const chain = tickChain({
      snapshot: vaultSnapshot({ settlementNonce: 1n, accountBalanceWei: 10_000_000_000_000_000_000n }),
      previewContribution: 100_000_000_000_000_000n,
    });

    const result = await runTick(
      deps({
        ledger,
        chain,
        config: testConfig({ limits: { ...LIMITS, maxContributionWei: 1_000_000_000_000_000_000n } }),
      }),
    );

    expect(result.outcome).toBe("SKIPPED");
    expect(result.detail).toContain("COVERAGE_UNRESOLVED");
    expect(result.detail).toContain("keeper recover");
    expect(ledger.state.coverageUnresolved).toBe(1);
    // NOT recorded terminal: this is a recoverable condition, and burning the
    // window forever would forfeit real savings over a fixable log-scan floor.
    expect(ledger.state.terminalWindows.size).toBe(0);
    ledger.close();
  });
});

describe("a revert is not a reason to try again", () => {
  const REVERTS = [
    "NonProgressiveBlockRange",
    "SessionAlreadyUsed",
    "ContributionBelowMinimum",
    "InvalidSettlementNonce",
    "InvalidAccountState",
  ] as const;

  it("classifies every revert that cannot succeed on retry as permanent", () => {
    for (const revert of REVERTS) {
      const error = new Error(`The contract function "settle" reverted.\n\nError: ${revert}(25635384, 25635381)`);
      const verdict = classifyRevert(error);
      expect(verdict.kind).toBe("PERMANENT");
      if (verdict.kind === "PERMANENT") expect(verdict.revert).toBe(revert);
    }
  });

  it("treats a nonce race, an underpriced replacement and an RPC failure as transient", () => {
    for (const message of ["nonce too low", "replacement transaction underpriced", "HTTP request failed."]) {
      expect(classifyRevert(new Error(message)).kind).toBe("TRANSIENT");
    }
  });

  it("finds a revert name in viem's metaMessages, not only in the message", () => {
    const error = Object.assign(new Error("The contract function \"settle\" reverted."), {
      metaMessages: ["Error: SessionAlreadyUsed(bytes32 sessionId)"],
    });
    expect(classifyRevert(error).kind).toBe("PERMANENT");
  });

  it("backs off exponentially and then stops growing", () => {
    expect(revertBackoffMs(0)).toBe(0);
    expect(revertBackoffMs(1)).toBe(60_000);
    expect(revertBackoffMs(2)).toBe(120_000);
    expect(revertBackoffMs(3)).toBe(240_000);
    // Capped, so a long-lived keeper cannot schedule a retry a century out.
    expect(revertBackoffMs(50)).toBe(30 * 60_000);
    expect(revertBackoffMs(500)).toBe(30 * 60_000);
  });

  /** One reverted attempt for the window this fixture's session occupies. */
  function seedReverts(ledger: Ledger, count: number): void {
    ledger.ensureHeader({ settlementNonce: 0n, lifetimeContribution: 0n });
    for (let i = 0; i < count; i++) {
      ledger.append("FAILED", {
        startBlockL2: START_L2,
        endBlockL2: SELL_BLOCK,
        sessionId: `0xeeee00000000000000000000000000000000000000000000000000000000000${i}`,
        txHash: `0xffff00000000000000000000000000000000000000000000000000000000000${i}`,
        reason: "mined with status 0: gas burned, no funds moved, EOA nonce consumed",
      });
    }
  }

  it("counts reverts per window from the journal, which records no other progress for them", () => {
    const ledger = freshLedger();
    seedReverts(ledger, 2);
    const history = failureHistory(ledger);
    expect(history.perWindow.get(`${START_L2}:${SELL_BLOCK}`)?.attempts).toBe(2);
    expect(history.consecutive).toBe(2);
    // And the derived state still records no progress at all for them, correctly.
    expect(ledger.state.settledFrontierL2).toBeNull();
    expect(ledger.state.chainGuardL1.size).toBe(0);
    expect(ledger.state.settlementCount).toBe(0);
    ledger.close();
  });

  it("defers instead of re-signing while the backoff is running", async () => {
    const ledger = freshLedger();
    seedReverts(ledger, 1);
    const signer = countingAttesterSigner();
    const chain = tickChain();

    const result = await runTick(deps({ ledger, chain, attesterSigner: signer }));

    expect(result.outcome).toBe("DEFERRED");
    expect(result.detail).toContain("REVERT_BACKOFF");
    // The saving is the point: no dense verification and no signature.
    expect(signer.signCount()).toBe(0);
    expect(chain.calls).not.toContain("deriveSessionId");
    // And the anchor is NOT advanced past a window we still mean to settle.
    expect(ledger.state.counts.CHECKPOINT).toBe(0);
    ledger.close();
  });

  it("abandons the window after two reverts rather than retrying it forever", async () => {
    const ledger = freshLedger();
    seedReverts(ledger, 2);
    const signer = countingAttesterSigner();
    const chain = tickChain();

    const result = await runTick(deps({ ledger, chain, attesterSigner: signer }));

    expect(result.outcome).toBe("SKIPPED");
    expect(result.detail).toContain("REVERT_LIMIT");
    expect(signer.signCount()).toBe(0);
    expect(ledger.state.terminalWindows.get(`${START_L2}:${SELL_BLOCK}`)).toBe("REFUSED");
    // Checkpointed, so the window is not rediscovered on the next poll — the
    // missing checkpoint was half of the original unbounded retry.
    expect(ledger.state.counts.CHECKPOINT).toBe(1);
    ledger.close();
  });

  it("latches DEGRADED after three consecutive reverts so a human has to look", async () => {
    const ledger = freshLedger();
    seedReverts(ledger, 3);
    const result = await runTick(deps({ ledger, chain: tickChain() }));
    expect(result.outcome).toBe("DEGRADED");
    expect(result.detail).toContain("REVERT_BREAKER");
    expect(ledger.state.degraded?.reason).toBe("REVERT_BREAKER");
    ledger.close();
  });
});

describe("the attester address is logged, the key never is", () => {
  it("names the attester in the decision line", async () => {
    const ledger = freshLedger();
    const { lines, logger } = capture();
    const chain = tickChain({
      previewContribution: 100_000_000_000_000_000n,
      snapshot: vaultSnapshot({ settlementNonce: 0n, accountBalanceWei: 10_000_000_000_000_000_000n }),
    });
    await runTick(
      deps({
        ledger,
        logger,
        chain,
        config: testConfig({ limits: { ...LIMITS, maxContributionWei: 1_000_000_000_000_000_000n } }),
      }),
    );
    const joined = lines.join("\n");
    // The address is public, it is the thing being held accountable, and a
    // mismatch against the registry is a top failure mode.
    expect(joined).toContain(TEST_ATTESTER.address);
    // The key is not.
    expect(joined).not.toContain("4c0883a69102937d");
    ledger.close();
  });
});
