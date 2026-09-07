// One account, running inside a process shared with many others.
//
// WHY THIS REPLACES A CHILD PROCESS. The supervisor used to spawn one
// `keeper.mts run` per account, for crash isolation. Measured, that isolation
// costs 73 MB per account while the account's own data costs 0.07 MB — a
// thousand to one. A hundred users came to 7.3 GB of Node runtimes and 7 MB of
// actual state.
//
//   node, bare .................. 35 MB
//   + tsx ....................... 75 MB   (tsx alone is 40 MB)
//   + the keeper's modules ..... 127 MB
//   + 100 accounts ............. 134 MB   (0.07 MB each)
//
// So the process boundary was the entire cost. What it bought — a fault in one
// account not reaching the others — is recovered here by catching per account,
// which covers every failure short of a native crash or an OOM, and those take
// a whole container down regardless of how it is arranged.
//
// THE THING THAT MUST NOT GO WRONG. Each account needs its own vault, its own
// ledger and its own signer, and in one process a leaked reference between two
// of them is a settlement into a stranger's savings. So the config is built
// through the SAME `loadConfig` the single-account binary uses, once per account
// with that account's variables overlaid — every validation, every refusal, every
// redaction, unchanged. Nothing here assembles a KeeperConfig by hand, because
// hand-assembly is where a vault would come from the wrong place.
//
// THE LOCK IS THE LEASE. Opening the journal takes a Postgres advisory lock on
// (chain, account). It is session scoped, so a killed process releases it with
// its socket — measured at zero seconds after SIGKILL. That is what lets several
// instances run at once with no coordination at all: each claims what it can get,
// and a dead instance's accounts are simply claimable again on the next sweep.

import { existsSync } from "node:fs";

import { loadConfig, type KeeperConfig } from "./config.js";
import { createViemChainAccess, type ChainAccess } from "./onchain.js";
import { httpRpcClient, failoverRpcClient, type RpcClient } from "./engine.js";
import { LocalJournalStore, type JournalStore } from "./journal-store.js";
import { Ledger, ENGINE_SCHEMA, LEDGER_SCHEMA } from "./ledger.js";
import { MirroredLedger } from "./ledger-mirrored.js";
import { LedgerBusyError, keeperApplicationName, type LockHolder } from "./ledger-pg.js";
import { runTick, type KeeperDeps, type TickResult } from "./keeper.js";
import { loadInvestmentConfig, type InvestmentConfig } from "./investment-config.js";
import { runInvestmentTick, type InvestmentTickReport } from "./investment-tick.js";
import type { InvestmentChainAccess } from "./investment-chain.js";
import type { Logger } from "./log.js";
import type { AttesterSigner } from "./attest.js";
import type { TradingSigner } from "./submit.js";

export interface AccountSpec {
  readonly account: `0x${string}`;
  readonly vault: `0x${string}`;
  /** Privy wallet id, so the signer can act as this account. */
  readonly walletId: string;
}

export interface RunnerEnvironment {
  /** The process environment, used as the base for every account's config. */
  readonly baseEnv: NodeJS.ProcessEnv;
  readonly broadcast: boolean;
  readonly logger: Logger;
  /** Built per account, because the signer must be bound to ONE wallet. */
  readonly makeTradingSigner: (spec: AccountSpec, config: KeeperConfig) => TradingSigner | null;
  readonly makeAttesterSigner: (config: KeeperConfig) => AttesterSigner | null;
  /** First-scan anchor for an account with no journal yet. */
  readonly firstAnchor: () => Promise<bigint>;
}

/**
 * What actually happened to the fallback start block, once the journal is open.
 *
 * A stateless container has no local index, so a fresh one always computes a
 * fallback anchor near the head. Whether that fallback is USED is a different
 * question, answered only by the durable journal: `keeper.ts` reads
 * `ledger.state.anchorBlockL2 ?? config.fromBlockL2`, so any account with
 * durable history resumes from its real watermark and the fallback is inert.
 *
 * Separated out because the two cases deserve opposite reactions and the
 * difference is one nullable field — the kind of distinction that gets collapsed
 * by accident and then quietly reported wrong for months.
 */
export type AnchorReport =
  /** No local index and no durable history. Earlier sessions really are lost. */
  | { readonly kind: "FIRST_START"; readonly anchor: bigint }
  /** Postgres had the watermark. The fallback was computed and never used. */
  | { readonly kind: "RESUMED"; readonly anchor: bigint; readonly unusedFallback: bigint };

export function anchorReport(
  fallback: bigint | null,
  durable: bigint | null,
): AnchorReport | null {
  // The local index survived, so no fallback was ever computed and there is
  // nothing to report either way.
  if (fallback === null) return null;
  if (durable === null) return { kind: "FIRST_START", anchor: fallback };
  return { kind: "RESUMED", anchor: durable, unusedFallback: fallback };
}

/**
 * Halt reasons THIS BUILD CAN NO LONGER PRODUCE.
 *
 * A DEGRADED latch is durable on purpose: it survives restarts so a keeper that
 * stopped for a reason nobody understood cannot quietly resume. But it outlives
 * the CHECK that wrote it, and that is a different situation. When the check is
 * deleted, its latches become a permanent refusal citing a rule the code no
 * longer has — and clearing them needed an operator with DATABASE_URL running
 * `keeper.mts run --acknowledge-degraded <seq>`, which nobody outside Railway
 * can do. Two production accounts sat in exactly that state.
 *
 * SO THE RULE IS NARROW AND SELF-LIMITING: a latch clears itself only if this
 * build cannot raise its reason any more. It can never swallow a live halt,
 * because a reason still in use is by definition not in this set.
 *
 * WHAT MUST NEVER GO IN HERE: anything reconcile.ts raises. Those mean the chain
 * and the journal disagree about settled money, and they are the only halts that
 * carry `unaccountedBelow` — a bound that travels into the RESUMED record and
 * RAISES acknowledgedNonceFloor. Auto-clearing one would move a safety floor
 * with nobody looking. Every entry below is raised in attest.ts and nowhere
 * else, which is what makes clearing it inert; a test enforces that.
 */
export const RETIRED_HALT_REASONS: ReadonlySet<string> = new Set([
  // Retired 2026-08-29. Was an absolute ceiling on one settlement
  // (NUVEM_KEEPER_MAX_CONTRIBUTION_WEI, default 0.001 ETH) that halted on any
  // larger profit. Replaced in attest.ts by a bound derived from the policy
  // itself, which fires on an impossible number rather than a big one.
  "CONTRIBUTION_CIRCUIT_BREAKER",
]);

/**
 * Clears a latch left behind by a check that no longer exists.
 *
 * Says so loudly at warn level: a latch disappearing is exactly the kind of
 * event that must not be silent, even when it is correct.
 */
export function clearRetiredHalt(ledger: JournalStore, logger: Logger): boolean {
  const degraded = ledger.state.degraded;
  if (degraded === null || !RETIRED_HALT_REASONS.has(degraded.reason)) return false;
  ledger.append("RESUMED", {
    acknowledgedSeq: degraded.seq,
    note: `auto-resumed: ${degraded.reason} is retired and this build cannot raise it`,
  });
  logger.warn("cleared a halt left by a retired check", {
    reason: degraded.reason,
    acknowledgedSeq: degraded.seq,
    detail: degraded.detail,
  });
  return true;
}

/** Why an account is not being worked on. Each needs a different response. */
export type ClaimFailure =
  /**
   * `holder` is the difference between "a sibling replica is settling for this
   * user" and "a dead container is sitting on the lock and nobody is". Absent
   * when the database would not say.
   */
  | { readonly kind: "HELD_ELSEWHERE"; readonly detail: string; readonly holder?: LockHolder }
  | { readonly kind: "MISCONFIGURED"; readonly problems: readonly string[] }
  | { readonly kind: "FAILED"; readonly detail: string };

/**
 * An account this process has claimed and is ticking.
 *
 * Holding one means holding its advisory lock, so the runner is also the claim:
 * releasing it (close) is what lets another instance take the account over.
 */
export class AccountRunner {
  private constructor(
    readonly spec: AccountSpec,
    readonly config: KeeperConfig,
    private readonly deps: KeeperDeps,
    private readonly ledger: JournalStore,
    private readonly logger: Logger,
    /** Null when investing is not configured. Settlement is unaffected. */
    private readonly investment: InvestmentConfig | null,
    private readonly rpcUrl: string,
  ) {}

  /**
   * A purchase that was broadcast and whose receipt never arrived.
   *
   * HELD IN MEMORY ON PURPOSE, and it is worth saying why that is enough. It is
   * a hint, not a record: losing it on restart makes the next tick treat the
   * vault as having nothing outstanding, and the WORST case is one purchase
   * skipped — because `invest()` re-reads the balance and the caps, and the
   * lifetime counter it compares against is the chain's. What it can never
   * cause is a double purchase, which is the only outcome that costs money.
   */
  private outstanding: InvestmentTickReport["outstanding"] = null;

  /**
   * Claims an account, or explains why not.
   *
   * Returns a failure rather than throwing, because a supervisor sweeping fifty
   * accounts must be able to skip one and carry on. The three failures are NOT
   * the same and must not be collapsed: another instance holding the lock is
   * normal and needs no action, a bad configuration needs a human, and an
   * unexpected error needs to be seen.
   */
  static async claim(
    spec: AccountSpec,
    env: RunnerEnvironment,
  ): Promise<AccountRunner | ClaimFailure> {
    // The account's own variables overlaid on the process environment, then run
    // through the ordinary loader. A hand-built config would skip the checks
    // that stop a settlement going to the wrong vault.
    const stateDir = `${env.baseEnv.NUVEM_KEEPER_STATE_DIR ?? ".keeper-state"}/${spec.account.toLowerCase()}`;

    const accountEnv: NodeJS.ProcessEnv = {
      ...env.baseEnv,
      NUVEM_KEEPER_ACCOUNT: spec.account,
      NUVEM_VAULT: spec.vault,
      PRIVY_WALLET_ID: spec.walletId,
      // Each account keeps its own local index next to the others.
      NUVEM_KEEPER_STATE_DIR: stateDir,
      // One process, so only the supervisor may own a status port.
      NUVEM_KEEPER_HTTP_PORT: "0",
    };

    // AN ACCOUNT WITH NO JOURNAL NEEDS A STARTING HEIGHT, and only the supervisor
    // knows the account is new. Without this the keeper falls back to its
    // configured default — block 0 — and walks the whole chain one window per
    // tick. A live deployment did exactly that: 212 ticks in, its anchor was at
    // 6,330,000 against a head of 35,748,202, and it was going to spend hours
    // scanning history that predates the account existing.
    //
    // It is not a hang, which is what makes it easy to miss: every tick reports
    // NO_CANDIDATE in a few hundred milliseconds and looks perfectly healthy.
    // Only the anchor tells you.
    // NOTE THE ORDER. The anchor has to be decided here, because it goes into
    // the config, and the config is built before the journal is opened. So at
    // this point it is not yet known whether it will actually be used: it is a
    // FALLBACK, and `keeper.ts` prefers `ledger.state.anchorBlockL2` whenever the
    // durable journal has one. Which it does on every redeploy, because the
    // container is stateless by design and the history lives in Postgres.
    //
    // Saying "sessions before this block are not picked up" HERE therefore cried
    // wolf on every single restart — alarming, and false whenever the journal has
    // history. It is now said after the journal is open, when it is known to be
    // true. A warning that is usually wrong is worse than no warning: it is the
    // one nobody reads on the day it is right.
    let fallbackAnchor: bigint | null = null;
    if (!existsSync(stateDir)) {
      fallbackAnchor = await env.firstAnchor();
      accountEnv.NUVEM_KEEPER_FROM_BLOCK = fallbackAnchor.toString();
    }

    const loaded = loadConfig({ env: accountEnv, broadcastFlag: env.broadcast });
    if (!loaded.ok) return { kind: "MISCONFIGURED", problems: loaded.problems };
    const config = loaded.config;

    const logger = env.logger.child({ account: spec.account });
    let ledger: JournalStore;
    try {
      ledger = await openJournal(config, env, logger);
    } catch (error) {
      if (error instanceof LedgerBusyError) {
        return {
          kind: "HELD_ELSEWHERE",
          detail: error.message,
          ...(error.holder === undefined ? {} : { holder: error.holder }),
        };
      }
      return { kind: "FAILED", detail: error instanceof Error ? error.message : String(error) };
    }

    clearRetiredHalt(ledger, logger);

    // INVESTING IS OPTIONAL AND ITS FAILURES ARE ITS OWN. An operator running
    // only settlement must not have a keeper refuse to start over a pool
    // parameter — but a configuration that is PRESENT and wrong is a hard error,
    // because a half-configured investment path that quietly does nothing is the
    // exact failure this subsystem exists to prevent.
    const investment = loadInvestmentConfig(accountEnv);
    if (investment.kind === "INVALID") {
      // THE JOURNAL IS ALREADY OPEN, so its advisory lock is HELD. Returning
      // without closing leaves this process holding the lock for an account it
      // has just marked permanently broken: the supervisor never retries a
      // broken account, and no other instance can claim it either, so the
      // account is unreachable until this process dies. The catch below closes
      // for exactly this reason — this branch was added after it and did not.
      await ledger.close();
      return { kind: "MISCONFIGURED", problems: investment.problems };
    }

    // Now the journal is open, so the fallback's fate is known rather than guessed.
    const report = anchorReport(fallbackAnchor, ledger.state.anchorBlockL2);
    if (report?.kind === "FIRST_START") {
      logger.warn("first start for this account", {
        anchorBlockL2: report.anchor.toString(),
        note: "no durable history for this account; sessions that closed before this block are not picked up",
      });
    } else if (report?.kind === "RESUMED") {
      logger.info("resumed from the durable journal", {
        anchorBlockL2: report.anchor.toString(),
        unusedFallback: report.unusedFallback.toString(),
        note: "the local index was rebuilt from Postgres; no sessions are skipped",
      });
    }

    try {
      let rpcCalls = 0;
      const count = (): void => {
        rpcCalls += 1;
      };
      const rpc = countedRpc(config, count);
      const chain: ChainAccess = createViemChainAccess({
        rpcUrl: config.rpcUrl.reveal(),
        chainId: config.chainId,
        factory: config.factory,
        executor: config.executor,
        vault: config.vault,
        account: config.account,
        pauseController: config.pauseController,
        attesterRegistry: config.attesterRegistry,
        weth: config.weth,
      } as never);

      const deps: KeeperDeps = {
        config,
        chain,
        rpc,
        ledger,
        logger,
        attesterSigner: env.makeAttesterSigner(config),
        tradingSigner: env.makeTradingSigner(spec, config),
        rpcCalls: () => rpcCalls,
      };

      return new AccountRunner(
        spec,
        config,
        deps,
        ledger,
        logger,
        investment.kind === "OK" ? investment.config : null,
        config.rpcUrl.reveal(),
      );
    } catch (error) {
      // The lock is held by the ledger, so a half-built runner must release it
      // or the account is unreachable until this process dies.
      await ledger.close();
      return { kind: "FAILED", detail: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * One tick, with its failure contained.
   *
   * A throw here would otherwise end the sweep and stop every OTHER account from
   * being ticked — the exact blast radius the separate processes existed to
   * prevent, reintroduced by an unhandled exception.
   */
  async tick(): Promise<TickResult | { readonly outcome: "THREW"; readonly detail: string }> {
    try {
      return await runTick(this.deps);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error("tick threw; this account is skipped, the others continue", { detail });
      return { outcome: "THREW", detail };
    }
  }

  /**
   * One turn of the investment loop for this account's vault.
   *
   * SEPARATE FROM `tick()`, NOT FOLDED INTO IT. Settlement and investment fail
   * independently: a settle that reverts must not stop a purchase the vault can
   * afford, and a pool that has gone shallow must not stop realised profit
   * reaching the vault. Two calls, two outcomes, two alerts.
   *
   * Returns null when investing is not configured, which is not a state worth
   * reporting every tick.
   */
  async investmentTick(): Promise<InvestmentTickReport | null> {
    if (this.investment === null) return null;
    const inv = this.investment;

    try {
      const chain: InvestmentChainAccess = {
        call: async (to, data) =>
          (await this.deps.rpc.call("eth_call", [{ to, data }, "latest"])) as `0x${string}`,
        getLogs: async (filter) =>
          (await this.deps.rpc.call("eth_getLogs", [
            {
              address: filter.address,
              topics: filter.topics,
              fromBlock: `0x${filter.fromBlock.toString(16)}`,
              toBlock: filter.toBlock === "latest" ? "latest" : `0x${filter.toBlock.toString(16)}`,
            },
          ])) as readonly { data: `0x${string}`; topics: `0x${string}`[] }[],
        getBlockNumber: async () => this.deps.chain.getHeadBlockL2(),
      };

      const report = await runInvestmentTick({
        chain,
        submitChain: {
          estimateGas: async (args) =>
            BigInt((await this.deps.rpc.call("eth_estimateGas", [
              { from: args.from, to: args.to, data: args.data },
            ])) as string),
          getFeeQuote: async () => {
            const quote = await this.deps.chain.getFeeQuote();
            return { maxFeePerGas: quote.maxFeePerGas, maxPriorityFeePerGas: quote.maxPriorityFeePerGas };
          },
          getPendingTransactionCount: (a) => this.deps.chain.getPendingTransactionCount(a),
          sendRawTransaction: (raw) => this.deps.chain.sendRawTransaction(raw),
          waitForReceipt: async (hash, timeoutMs) => {
            const receipt = await this.deps.chain.waitForReceipt(hash, timeoutMs);
            return receipt === null ? null : { status: receipt.status, gasUsed: receipt.gasUsed };
          },
        },
        logger: this.logger,
        vault: this.spec.vault,
        // THE ACCOUNT, NOT THE VAULT. `_requireInvestmentAuthority` admits the
        // vault admin or an ACTIVE trading account; the vault is neither, and
        // estimating from it reverts Unauthorized() while looking like a bad plan.
        sender: this.spec.account,
        weth: this.config.weth,
        usdg: inv.usdg,
        poolManager: inv.poolManager,
        chainId: this.config.chainId,
        wethUsdgFee: inv.wethUsdgFee,
        wethUsdgTickSpacing: inv.wethUsdgTickSpacing,
        stockPools: inv.stockPools,
        sharesQuoters: inv.sharesQuoters,
        logsFromBlock: BigInt(this.config.logsFromBlockL2),
        readWethBalance: async () =>
          BigInt(
            (await this.deps.rpc.call("eth_call", [
              {
                to: this.config.weth,
                data: `0x70a08231${this.spec.vault.slice(2).toLowerCase().padStart(64, "0")}`,
              },
              "latest",
            ])) as string,
          ),
        signer: this.deps.tradingSigner,
        live: this.config.mode === "live",
        outstanding: this.outstanding,
        receiptTimeoutMs: inv.receiptTimeoutMs,
        toleranceBps: inv.toleranceBps,
      });

      this.outstanding = report.outstanding;
      return report;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error("investment tick threw; settlement is unaffected", { detail });
      // NOT CLEARED. A throw says nothing about whether a pending purchase
      // landed, and forgetting it here is the one way this loop could buy twice.
      return { outcome: "FAILED", detail, outstanding: this.outstanding };
    }
  }

  /**
   * Why this account's journal died, or null while it is healthy.
   *
   * A runner whose connection dropped holds no advisory lock and can write
   * nothing, but it is still in the supervisor's `held` map — so it is neither
   * settling nor claimable by anyone else. Checked after each tick so that
   * state lasts one sweep instead of until the container restarts.
   */
  get lost(): string | null {
    return this.ledger.lost;
  }

  /** Releases the advisory lock, making the account claimable elsewhere. */
  async release(): Promise<void> {
    await this.ledger.close();
  }
}

/**
 * The journal, durable when a database is configured and local when not.
 *
 * A first start has no watermark, so the anchor comes from the supervisor —
 * only it knows the account is new. Sessions that closed before that block are
 * not picked up, which is nothing for a user who links and then trades and is
 * real money for one who traded first, so the caller reports it.
 */
async function openJournal(
  config: KeeperConfig,
  env: RunnerEnvironment,
  logger: Logger,
): Promise<JournalStore> {
  const instance = {
    chainId: config.chainId,
    factory: config.factory,
    executor: config.executor,
    vault: config.vault,
    account: config.account,
    ledgerSchema: LEDGER_SCHEMA,
    engineSchema: ENGINE_SCHEMA,
  };

  const databaseUrl = config.databaseUrl?.reveal();
  if (databaseUrl !== undefined) {
    const mirrored = await MirroredLedger.open({
      connectionString: databaseUrl,
      dir: config.stateDir,
      instance,
      // Named so that a keeper which cannot get this lock can report who has it,
      // and above all whether that holder is armed. See keeperApplicationName.
      applicationName: keeperApplicationName({ broadcast: env.broadcast, env: env.baseEnv }),
    });
    // SAID OUT LOUD, not left to be inferred from the absence of the warning
    // below. Durability is the one property that cannot be checked from the
    // outside without opening the database, and "no warning appeared" is a
    // terrible way to learn that a journal will survive the next redeploy.
    logger.info("journal is durable", { schema: mirrored.durableLocation });
    return mirrored;
  }

  // Naming what was looked for turns "it is not working" into "I named it
  // wrong". An EMPTY value counts as absent (config.ts treats a blank string as
  // unset), which is easy to produce by accident in a dashboard that lets you
  // create a variable before you have its value.
  logger.warn("journal is LOCAL ONLY", {
    lookedFor: ["NUVEM_KEEPER_DATABASE_URL", "DATABASE_URL"],
    detail:
      "Neither variable is set to a non-empty value, so this account's journal lives only " +
      "on this filesystem. On a host whose disk does not survive a restart that loses every " +
      "unresolved INTENT, and the per-account advisory lock does not exist at all — a second " +
      "instance could claim this same account.",
  });
  return new LocalJournalStore(Ledger.open({ dir: config.stateDir, instance }));
}

/** The engine's RPC client, with failover, counting calls for the tick budget. */
function countedRpc(config: KeeperConfig, count: () => void): RpcClient {
  const endpoints = [
    { name: config.rpcHost, client: httpRpcClient(config.rpcUrl.reveal(), { attempts: 6 }) },
    ...config.rpcFallbackUrls.map((url, index) => ({
      name: config.rpcFallbackHosts[index] ?? `fallback-${index}`,
      client: httpRpcClient(url.reveal(), { attempts: 6 }),
    })),
  ];
  const inner = failoverRpcClient(endpoints);
  return {
    async call<T>(method: string, params: readonly unknown[] = []): Promise<T> {
      count();
      return inner.call<T>(method, params);
    },
  };
}
