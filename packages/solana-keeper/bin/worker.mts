// A DISPATCHER WORKER PROCESS: s slots claiming vaults from the queue, one job
// per vault, every send through the fence (dispatcher ADR §3.2–§3.11, §4.4;
// plan P3a Q3). The job is src/worker-job.ts, the loop src/worker-loop.ts, the
// fence src/fenced-sender.ts.
//
// DARK. Production never starts this file: the Dockerfile's CMD is
// bin/keeper.mts, for both legacy roles, and test/dispatch-dark.test.ts holds
// that nothing those roles load reaches a dispatcher module. And even started,
// it does nothing until SIP_SOLANA_DISPATCH names a mode: unset is `off`, and an
// `off` worker says so and exits 0 before it opens a connection.
//
//   SIP_SOLANA_DISPATCH=shadow   keyless and dry; every would-be send gated as a
//                                'shadow' intent and nothing sent (plan P3b);
//   SIP_SOLANA_DISPATCH=on       armed; every settle, wrap, convert and leg gated
//                                before it leaves (F1), PROFIT carries in the gate.
//
// WHAT IT BUILDS, ONCE (the merge notes of P3a-1): the worker's two-connection
// pool and its store (createDispatchPool, DispatchStore), its RPC budget inside
// the pool's transport (RpcBudget, at the static floor until the scheduler hands
// out a quota), the QuotaFollower its heartbeat feeds from the worker row, the
// usage collector its heartbeat flushes into rpc_usage, and — under the
// jupiter-key cut — the Jupiter pacer the follower retunes to its share.
//
// SIGTERM: stop claiming, drain sends in flight for up to SIGTERM_DRAIN_MS, then
// release every vault still held (due now), close the worker row, exit 0.
//
// NOT HERE YET, said once: the per-wallet alert ladder the legacy sweep pages
// with (settleAlert, investFailedAlert, the seat alerts) and the Privy
// authorization-key check. A worker logs every money outcome and keeps the
// streaks in vault_work.streaks; the fleet's own alerts (lease-expired,
// fence-reject, queue-lag, scheduler-stale, pg-saturated) are the scheduler's
// (src/fleet-alerts.ts). Both are preconditions of P3c, not of a shadow.

import "../src/console-bridge.js";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { summarizeUpstreamError } from "@sip/solana-log";
import { PgCarryStore } from "../src/carry-store.js";
import { ConfigError, SIGNING_SECRET_VARS, loadConfig, type KeeperConfig } from "../src/config.js";
import { RpcUsageCollector } from "../src/credit-governor.js";
import { DispatchStore, PgRpcUsageFeed, createDispatchPool } from "../src/dispatch-store.js";
import { createJobChain, type JobWallet } from "../src/job-chain.js";
import { JupiterPacer, type JupiterAccess } from "../src/jupiter-pacer.js";
import { createKeeperLogger } from "../src/keeper-log.js";
import { WalkCache, readTransaction } from "../src/measure-window.js";
import { PolicyBoundaryBook, type OwnerHistoryReader } from "../src/policy-boundary.js";
import { runPreflight } from "../src/preflight.js";
import { PrivyAddressBook, confirmedSubmitter } from "../src/privy-address-book.js";
import { createPrivySolanaSigner, privyAddressSource, seatsSignable, type PrivySolanaConfig, type SolanaWalletSubmitter } from "../src/privy-signer.js";
import { KEYED_API, LITE_API } from "../src/program-scripts.js";
import { SolanaReadModel } from "../src/read-model.js";
import { RestBook } from "../src/rest-book.js";
import { RpcBudget } from "../src/rpc-budget.js";
import { poolFetch } from "../src/rpc-pool.js";
import { QuotaFollower, fleetQuotas } from "../src/rpc-quota.js";
import { loadLocalSigners } from "../src/signers.js";
import { keeperEnvOf, readWorkerSettings, workerRefusals, type WorkerSettings } from "../src/worker-config.js";
import { jobLogFields, runVaultJob, workerCarryReads, type JobKeys, type JobShared } from "../src/worker-job.js";
import { WorkerLoop } from "../src/worker-loop.js";

const log = createKeeperLogger();
const fields = (extra: Record<string, unknown>): Record<string, unknown> => ({ role: "dispatcher-worker", ...extra });

// --preflight: the whole module graph above has loaded under this runtime's own
// module system (the anchor BN trap is a load-time one), then the keeper's own
// invariants and builders, with no network, no keys and no environment.
if (process.argv.includes("--preflight")) {
  const result = await runPreflight();
  if (!result.ok) {
    log.error("worker preflight failed", fields({ program: result.program, invariants: result.invariants, failure: result.failure }));
    process.exit(1);
  }
  log.info("worker preflight", fields({ preflight: "ok", program: result.program }));
  process.exit(0);
}

process.on("uncaughtException", (error) => {
  log.error("uncaught exception", fields({ detail: summarizeUpstreamError(error, { take: 5, maxChars: 1_000 }) }));
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  log.error("unhandled rejection", fields({ detail: summarizeUpstreamError(reason, { take: 5, maxChars: 1_000 }) }));
  process.exit(1);
});

// ── configuration: the worker's own four, then the keeper's ──────────────────
const read = readWorkerSettings(process.env);
if ("problems" in read) {
  log.error("configuration refused", fields({ problems: read.problems }));
  process.exit(2);
}
const settings: WorkerSettings = read.settings;
if (settings.mode === "off") {
  log.info("SIP_SOLANA_DISPATCH is off (unset is off): this worker claims nothing, opens no connection and exits", fields({}));
  process.exit(0);
}
let config: KeeperConfig;
try {
  config = loadConfig(keeperEnvOf(process.env));
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  log.error("configuration refused", fields({ problems: error.problems }));
  process.exit(2);
}
for (const name of SIGNING_SECRET_VARS) delete process.env[name];
for (const warning of config.warnings) log.warn("configuration warning", fields({ detail: warning }));
const refusals = workerRefusals(config, settings);
if (refusals.length > 0) {
  log.error("configuration refused", fields({ problems: refusals }));
  process.exit(2);
}
if (config.carryStore !== "off") {
  log.warn("SIP_SOLANA_CARRY_STORE is a legacy keeper's: a worker always writes its PROFIT carries inside the settle's gate", fields({}));
}
if (config.doorbellSecret !== null) {
  log.warn("the doorbell secret is the scheduler's (ADR §3.11): a worker answers no webhook and does not use it", fields({}));
}

const workerId = `worker:${hostname()}:${randomUUID()}`;
const version = process.env["RAILWAY_GIT_COMMIT_SHA"]?.slice(0, 40) ?? "local";
const programId = new PublicKey(config.programId);
const world = settings.mode === "shadow" ? "shadow" : "live";

// ── the store: two connections, the replica's whole budget (ADR §3.11) ───────
const pool = createDispatchPool(config.databaseUrl!, "worker", workerId.slice(0, 60), (message, extra) => log.warn(message, fields(extra)));
const store = new DispatchStore(pool, workerId, world);
const history = SolanaReadModel.overPool(pool, (message, extra) => log.warn(message, fields(extra ?? {})));

// ── the RPC budget: the floor until the scheduler hands out a quota ──────────
const collector = new RpcUsageCollector({ workerId });
const jupiterKey = config.cuts.has("jupiter-key");
const floor = fleetQuotas({
  planRps: settings.planRps,
  liveWorkers: 0,
  maxWorkers: settings.workersMax,
  ...(jupiterKey ? { jupiterPerMinute: config.jupiterCallsPerMinute } : {}),
});
const budget = new RpcBudget({ ratePerSecond: floor.floorRps, defaultLane: "hot", usage: collector });
const transport = poolFetch(config.rpcUrls, (message, extra) => log.warn(message, fields(extra)), undefined, undefined, undefined, budget);
const jupiter: JupiterAccess | null = jupiterKey
  ? {
      baseUrl: config.jupiterApiKey === null ? LITE_API : KEYED_API,
      apiKey: config.jupiterApiKey,
      pacer: new JupiterPacer({ perMinute: Math.max(1, floor.floorJupiterPerMinute ?? config.jupiterCallsPerMinute) }),
    }
  : null;
const follower = new QuotaFollower({
  budget,
  pacer: jupiter?.pacer ?? null,
  floorRps: floor.floorRps,
  floorJupiterPerMinute: jupiter === null ? null : floor.floorJupiterPerMinute,
  maxRps: floor.fleetRps,
});
const usageFeed = new PgRpcUsageFeed(pool);

// ── keys: a live worker's only ────────────────────────────────────────────────
const settleKeypair: Keypair | null = config.signing?.settleKey.keypair() ?? null;
const refuse = async (): Promise<never> => {
  throw new Error("this worker holds no key and signs nothing");
};
const providerWallet: JobWallet =
  settleKeypair !== null ? new anchor.Wallet(settleKeypair) : { publicKey: PublicKey.default, signTransaction: refuse, signAllTransactions: refuse };
const privyConfig: PrivySolanaConfig | null = config.signing?.privy ?? null;
/** C8 (ADR §3.9): each wallet's Privy record by its address. A worker never lists the whole app per job. */
const privyBook: PrivyAddressBook | null =
  privyConfig === null
    ? null
    : new PrivyAddressBook(privyAddressSource(privyConfig), {
        signable: (entry) => seatsSignable(entry.seats, config.privySignerId ?? undefined, config.privyPolicyId ?? undefined),
      });
/** One prepare at a time: two slots warming a cold book at once would list the app twice. */
let privyQueue: Promise<unknown> = Promise.resolve();
const localSigners = config.signing?.localSignersDir ? loadLocalSigners(config.signing.localSignersDir) : null;
const keys: JobKeys | null =
  settleKeypair === null
    ? null
    : {
        settleKey: settleKeypair,
        wallet: providerWallet as JobKeys["wallet"],
        async signerFor(wallet: PublicKey): Promise<SolanaWalletSubmitter | Keypair | null> {
          const address = wallet.toBase58();
          const local = localSigners?.signers.get(address) ?? null;
          if (privyConfig === null || privyBook === null) return local;
          const prepared = privyQueue.then(() => privyBook.prepare([address], Date.now()));
          privyQueue = prepared.catch(() => undefined);
          const view = await prepared;
          if (view.failed.has(address)) return local;
          const resolution = await createPrivySolanaSigner(privyConfig, wallet, config.privySignerId ?? undefined, view.index, config.privyPolicyId ?? undefined);
          if (resolution.outcome === "SIGNER") return confirmedSubmitter(resolution.signer, privyBook);
          log.warn("no Privy signer for this wallet", fields({ wallet: address, outcome: resolution.outcome }));
          return local;
        },
      };

// ── what jobs share in this process (src/worker-job.ts says why each is safe) ─
const processConnection = new Connection(config.rpcUrls[0]!.reveal(), { commitment: "confirmed", fetch: transport });
const ownerHistory: OwnerHistoryReader = {
  signatures: (owner, options, commitment) =>
    processConnection.getSignaturesForAddress(owner, options.before === undefined ? { limit: options.limit } : { before: options.before, limit: options.limit }, commitment),
  transaction: (signature, commitment) => readTransaction(processConnection, signature, commitment),
};
const shared: JobShared = {
  walkCache: new WalkCache(),
  restBook: config.cuts.has("rest-skip") ? new RestBook() : null,
  boundaries: new PolicyBoundaryBook(),
  ownerHistory,
  jupiter,
  investBatch: config.cuts.has("invest-batch"),
  carryReads: workerCarryReads(new PgCarryStore(pool, workerId)),
};
/** The keeper the last job's config named: read in the same request as the next job's vault. */
let crankHint: PublicKey | null = null;

const loop = new WorkerLoop({
  store,
  slots: settings.slots,
  log: (level, message, extra) => log[level](message, fields(extra)),
  runJob: async (claimed, control) => {
    const chain = createJobChain({
      transport,
      rpcUrl: config.rpcUrls[0]!.reveal(),
      wallet: providerWallet,
      crankHint: () => crankHint,
      onCrank: (keeper) => {
        crankHint = keeper;
      },
    });
    const end = await runVaultJob(claimed, {
      store,
      chain,
      history,
      keys,
      shared,
      mayAct: control.mayAct,
      softDeadlineAt: control.softDeadlineAt,
      log: (level, message, extra) => log[level](message, fields(extra)),
      onGate: control.onGate,
      onSender: control.onSender,
    });
    // EACH WALLET'S SETTLE BY ADDRESS, beside the outcomes: what the local shadow compares with production's /status.
    log.info(end.kind === "complete" ? "job done" : "job stopped", fields(jobLogFields(end)));
    return end;
  },
  beat: async () => {
    await follower.refresh(store.quotaSource(() => ({ busy: loop.busy, stats: loop.stats() })));
    await collector.flush(usageFeed);
  },
});

await store.registerProcess("worker", version, settings.slots);
log.info("worker starting", fields({
  world,
  slots: settings.slots,
  workersMax: settings.workersMax,
  floorRps: floor.floorRps,
  cuts: [...config.cuts].sort(),
  program: programId.toBase58(),
  keys: keys === null ? "none (shadow: dry, keyless)" : "settle key and wallet signers",
}));

let stopping = false;
const shutdown = async (signal: string): Promise<void> => {
  if (stopping) return;
  stopping = true;
  log.info("worker stopping", fields({ signal, busy: loop.busy }));
  const drained = await loop.stop();
  await collector.flush(usageFeed).catch(() => undefined);
  await store.processStopped().catch((error: unknown) => log.warn("the worker row could not be closed", fields({ detail: summarizeUpstreamError(error) })));
  await pool.end().catch(() => undefined);
  log.info("worker stopped", fields({ drained: drained.drained, releasedOnSigterm: drained.released }));
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
await loop.start();
