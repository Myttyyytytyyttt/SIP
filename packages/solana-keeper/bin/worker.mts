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
// THE PER-TRADE MODES (ROUND-UP, FIXED: ADR §5, plan §3.4) are served only under
// SIP_SOLANA_EXTRA_MODES and its vault list (src/worker-config.ts), dry in the
// live world until SIP_SOLANA_EXTRA_MODES_LIVE=1, priced from the scheduler's
// price tape. Unset, a per-trade vault rests at UNSUPPORTED_MODE, as before.
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
// ITS ALERTS (P3c's preconditions, 2026-10-27): the legacy sweep's per-wallet and
// per-vault ladder, applied to each completed job (src/worker-alerts.ts: the same
// functions, the same keys, the streaks from vault_work.streaks); the seat alert
// where a wallet's Privy signer is resolved; and the Privy authorization-key
// check at boot and every AUTHORIZATION_KEY_RECHECK_MS. They go to the keeper's
// SIP_SOLANA_ALERT_WEBHOOK, titled "[worker] " (a shadow's "[worker, shadow] ").
// The fleet's own alerts (lease-expired, fence-reject, queue-lag,
// vault-unserved, pg-saturated) stay the scheduler's (src/fleet-alerts.ts) —
// all but scheduler-stale, which a worker raises too, from the tick age its
// beat reads with its quotas (SchedulerStaleWatch): with both scheduler
// replicas gone, the workers are the only dispatcher processes left to say so.

import "../src/console-bridge.js";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { summarizeUpstreamError } from "@sip/solana-log";
import { CARRY_STORE_ALERT_KEY, PgCarryStore, carryStoreAlert } from "../src/carry-store.js";
import { ConfigError, SIGNING_SECRET_VARS, loadConfig, type KeeperConfig } from "../src/config.js";
import { RpcUsageCollector } from "../src/credit-governor.js";
import { DispatchStore, PgRpcUsageFeed, createDispatchPool } from "../src/dispatch-store.js";
import { createJobChain, type JobWallet } from "../src/job-chain.js";
import { JupiterPacer, type JupiterAccess } from "../src/jupiter-pacer.js";
import { createAlerter } from "../src/alerts.js";
import { createKeeperLogger, scrubbedForExport } from "../src/keeper-log.js";
import { WalkCache, readTransaction } from "../src/measure-window.js";
import { PolicyBoundaryBook, type OwnerHistoryReader } from "../src/policy-boundary.js";
import { PgPriceTape, missingTapeColumns } from "../src/price-tape.js";
import { PYTH_SOL_USD_FEED } from "../src/pyth.js";
import { MODE_ROUNDUP_BYTE } from "../src/role-registry.js";
import type { PerTradeServing } from "../src/settle-modules.js";
import { runPreflight } from "../src/preflight.js";
import { PrivyAddressBook, confirmedSubmitter } from "../src/privy-address-book.js";
import {
  AUTHORIZATION_KEY_BROKEN,
  AuthorizationKeyUnreadable,
  compareWithQuorum,
  derivePrivyPublicKey,
  quorumReadVerdict,
  unreadableKeyVerdict,
  type AuthorizationKeyCheck,
  type AuthorizationKeyVerdict,
} from "../src/privy-authorization-key.js";
import {
  createPrivySolanaSigner,
  privyAddressSource,
  readPrivyKeyQuorum,
  seatsSignable,
  type PrivySolanaConfig,
  type SolanaWalletSubmitter,
} from "../src/privy-signer.js";
import { KEYED_API, LITE_API } from "../src/program-scripts.js";
import { SolanaReadModel } from "../src/read-model.js";
import { RestBook } from "../src/rest-book.js";
import { RpcBudget } from "../src/rpc-budget.js";
import { poolFetch } from "../src/rpc-pool.js";
import { QuotaFollower, fleetQuotas } from "../src/rpc-quota.js";
import { loadLocalSigners } from "../src/signers.js";
import { keeperEnvOf, readWorkerSettings, workerRefusals, type WorkerSettings } from "../src/worker-config.js";
import { jobLogFields, runVaultJob, workerCarryReads, type JobKeys, type JobShared } from "../src/worker-job.js";
import { jobAlerts } from "../src/worker-alerts.js";
import { SchedulerStaleWatch } from "../src/fleet-alerts.js";
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

// ── its alerts: the keeper's destination, told apart in the one chat ─────────
const alerter = createAlerter({
  webhookUrl: config.alertWebhook,
  minSeverity: config.alertMinSeverity,
  destination: config.alertChatId === null ? { kind: "webhook" } : { kind: "telegram", chatId: config.alertChatId },
  links: { statusUrl: config.statusUrl },
  titlePrefix: world === "shadow" ? "[worker, shadow] " : "[worker] ",
  log: (severity, line) => log[severity === "critical" ? "error" : "warn"](`alert ${severity}`, fields({ detail: line })),
  // THE BODY LEAVES THE BOX: what a log line passes, as every keeper alert (bin/keeper.mts).
  sanitize: (text) => scrubbedForExport(text),
});
if (world === "live" && config.alertWebhook === null) {
  log.warn("armed with no alert destination: a failed settle or buy on a queue vault reaches only this log", fields({}));
}
/** scheduler-stale from this side (src/fleet-alerts.ts): fed by every beat that answered, never by one that failed. */
const schedulerWatch = new SchedulerStaleWatch({ alerter });

// ── the store: two connections, the replica's whole budget (ADR §3.11) ───────
const pool = createDispatchPool(config.databaseUrl!, "worker", workerId.slice(0, 60), (message, extra) => log.warn(message, fields(extra)));
const store = new DispatchStore(pool, workerId, world);
const history = SolanaReadModel.overPool(pool, (message, extra) => log.warn(message, fields(extra ?? {})));

// ── the per-trade modes: none unless SIP_SOLANA_EXTRA_MODES names them ───────
// A worker that prices ROUND-UP trades needs the tape's table, refused by name at
// boot rather than met as a RETRY on every round-up turn.
if (settings.extraModes?.modes.has(MODE_ROUNDUP_BYTE) === true) {
  let missingTape: string[];
  try {
    missingTape = await missingTapeColumns(pool);
  } catch (error) {
    log.error("worker: the database could not be asked at boot", fields({ detail: summarizeUpstreamError(error) }));
    await pool.end().catch(() => undefined);
    process.exit(1);
  }
  if (missingTape.length > 0) {
    log.error("worker: SIP_SOLANA_EXTRA_MODES serves roundup and the price tape's table is not in this database; apply sql/sip_solana.sql with setup-read-model", fields({ missing: missingTape }));
    process.exit(2);
  }
}
const perTrade: PerTradeServing | null =
  settings.extraModes === null ? null : { ...settings.extraModes, tape: new PgPriceTape(pool), oracle: PYTH_SOL_USD_FEED };

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
// THE PACER IS BUILT AT THE ORGANISATION'S WHOLE MINUTE, AND RUNS AT THE FLOOR.
// The minute a JupiterPacer is built with is its CEILING: the never-fits bound,
// and the most retune (src/jupiter-pacer.ts) will ever grant. Built at the floor
// — the minute over SIP_SOLANA_WORKERS_MAX — it clamped every hand-out to the
// floor: one worker alive of a fleet of two was handed the whole minute by the
// scheduler and spent half of it for as long as it ran, and refused any basket
// over that half as never-fits ("raise SIP_SOLANA_JUPITER_CALLS_PER_MINUTE")
// while its row said it could buy it.
//
// THE FLOOR STILL APPLIES UNTIL THE FIRST HAND-OUT. The follower below retunes
// the pacer to the floor in its own constructor — the next statement, with
// nothing awaited between, before the loop starts and so before any job can
// reserve a call — and again whenever the quota it last heard was written more
// than QUOTA_STALE_MS ago (src/rpc-quota.ts). Only a row the scheduler wrote in
// the last two minutes lifts it, and the scheduler divides the minute among
// EVERY worker alive (handOutQuotas), a deploy's outgoing replica included. So a
// replica that boots beside the one it replaces runs at the floor, exactly as
// before, and both come down to the overlap's share at the first beat that
// hears it. What the floor itself allows is unchanged: at WORKERS_MAX=1 it is
// the whole minute, so the two replicas of an overlap can each run at it until
// their beats hear the scheduler's next hand-out — up to one of its ticks and
// one beat — and the pacer's backoff after a 429 is what covers that window,
// as it did before this ceiling moved. ABOVE WORKERS_MAX=1 THAT WINDOW IS NEW:
// an outgoing replica that was the only worker alive keeps the whole minute it
// was handed, not the floor, so for that one tick and beat the overlap can
// spend the minute plus the new replica's floor, where before this change no
// replica ever ran above the floor. The same 429 backoff covers it. A floor of
// zero — a minute smaller than WORKERS_MAX — is taken as one call: retune
// refuses anything under one, and a refused retune would leave the pacer at its
// ceiling.
const jupiterFloorPerMinute = Math.max(1, floor.floorJupiterPerMinute ?? config.jupiterCallsPerMinute);
const jupiter: JupiterAccess | null = jupiterKey
  ? {
      baseUrl: config.jupiterApiKey === null ? LITE_API : KEYED_API,
      apiKey: config.jupiterApiKey,
      pacer: new JupiterPacer({ perMinute: config.jupiterCallsPerMinute }),
    }
  : null;
const follower = new QuotaFollower({
  budget,
  pacer: jupiter?.pacer ?? null,
  floorRps: floor.floorRps,
  floorJupiterPerMinute: jupiter === null ? null : jupiterFloorPerMinute,
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
          if (view.failed.has(address)) {
            // SAID, because the settle then reads NO_SIGNER and blames the wallet's seat, which is not the cause.
            log.warn("the Privy lookup for this wallet failed this turn; it is not signed for until it answers", fields({ wallet: address }));
            return local;
          }
          const resolution = await createPrivySolanaSigner(privyConfig, wallet, config.privySignerId ?? undefined, view.index, config.privyPolicyId ?? undefined);
          // THE LEGACY KEEPER'S SEAT ALERT (bin/keeper.mts), same key: a seat with no
          // policy of its own could sign anything with that wallet, and nothing else
          // here would say so. Cleared on every other outcome.
          if (resolution.outcome === "SEAT_NOT_BOUNDED") {
            alerter.fire({
              key: `seat-unbounded:${address}`,
              severity: "critical",
              title: "A trading wallet seats the keeper's signer with no policy of its own",
              detail:
                "Nothing is signed for it. A seat without exactly the keeper's override policy could sign any " +
                "message, send any transaction and export that wallet's key. Re-seat it from the web and check it " +
                "with `privy-policy verify`.",
              context: { wallet: address, overridePolicyIds: resolution.overridePolicyIds, expected: config.privyPolicyId },
            });
          } else {
            alerter.clear(`seat-unbounded:${address}`);
          }
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
  perTrade,
};
/** The keeper the last job's config named: read in the same request as the next job's vault. */
let crankHint: PublicKey | null = null;

/** Per vault, the leg-fee warnings its last looking turn raised (what the legacy sweep's legFeeLooked keeps). */
const legFeeRaised = new Map<string, ReadonlySet<string>>();
/** Since when settles have waited on the loss-carry store; null while they do not. */
let carryWaitingSince: number | null = null;

/**
 * A VAULT WHOSE JOBS NEVER FINISH: they throw before any wallet turn ends, or run
 * past their ceiling. Such a job writes no streaks and reaches no per-wallet
 * alert, and the legacy keeper's equivalents (sweep-failed, the vault-read ladder,
 * its watchdog) do not exist here. Counted per vault in this process: a warn on
 * the first, critical on the JOB_FAILING_CRITICAL_STREAK-th in a row; the next
 * completed job clears it.
 */
const JOB_FAILING_CRITICAL_STREAK = 3;
const jobFailing = new Map<string, number>();
function onJobEnd(vault: string, how: "complete" | "threw" | "aborted", detail: string): void {
  const key = `job-failing:${vault}`;
  if (how === "complete") {
    if (jobFailing.delete(vault)) alerter.clear(key);
    return;
  }
  const streak = (jobFailing.get(vault) ?? 0) + 1;
  jobFailing.set(vault, streak);
  alerter.fire({
    key,
    severity: streak >= JOB_FAILING_CRITICAL_STREAK ? "critical" : "warn",
    title: how === "threw" ? "A worker's jobs on a vault keep throwing before they finish" : "A worker's jobs on a vault keep running past their ceiling",
    detail: `${streak} in a row: ${detail}. Nothing is settled or bought for this vault while it lasts.`,
    context: { vault },
  });
}

const loop = new WorkerLoop({
  store,
  slots: settings.slots,
  onJobEnd,
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
    // THE LEGACY SWEEP'S LADDER, for this vault's wallets and its invest: cleared, then fired.
    try {
      const legFeeKeys = legFeeRaised.get(claimed.vault);
      const rules = jobAlerts(end, legFeeKeys === undefined ? {} : { legFeeKeys });
      for (const key of rules.clear) alerter.clear(key);
      for (const alert of rules.fire) alerter.fire(alert);
      if (rules.legFeeKeys !== undefined) legFeeRaised.set(claimed.vault, rules.legFeeKeys);
      // THE SHARED LOSS-CARRY STORE: a settle that waited on it pages nothing per
      // wallet (settleAlert), so the store pages once, critical once it has kept
      // failing (carryStoreAlert's rule); the first job that did not wait clears it.
      if (rules.carryWaited) {
        carryWaitingSince ??= Date.now();
        alerter.fire(carryStoreAlert("on", "read", "a PROFIT settle on a queue vault waited on the store", Date.now() - carryWaitingSince));
      } else if (end.kind === "complete" && end.report.settles.length > 0 && carryWaitingSince !== null) {
        carryWaitingSince = null;
        alerter.clear(CARRY_STORE_ALERT_KEY);
      }
    } catch (error) {
      // An alert that cannot be raised never fails a job that moved money.
      log.warn("the job's alerts could not be raised", fields({ vault: claimed.vault, detail: summarizeUpstreamError(error) }));
    }
    return end;
  },
  beat: async () => {
    await follower.refresh(
      store.quotaSource(
        () => ({ busy: loop.busy, stats: loop.stats() }),
        (tickAgeMs) => void schedulerWatch.observe(tickAgeMs),
      ),
    );
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
  extraModes:
    settings.extraModes === null
      ? "off"
      : {
          modes: [...settings.extraModes.modes].sort(),
          vaults: settings.extraModes.vaults === "*" ? "*" : settings.extraModes.vaults.size,
          live: settings.extraModes.live,
          fromSlot: settings.extraModes.fromSlot?.toString() ?? null,
        },
}));

// ── the Privy authorization key, at boot and on a cadence (bin/keeper.mts's rule) ─
// WHY: every other signal is healthy when the key does not belong to the signer
// quorum; Privy refuses only at the send, so the first sign of it would be a
// settle of a user's money that does not go out. It arms and reports loudly; it
// does not refuse to start (the legacy keeper's reasons, establishAuthorizationKey).
// A shadow worker reads no signing secret, so privyConfig is null and nothing runs.
const AUTHORIZATION_KEY_ALERT_KEY = "privy-authorization-key";
const AUTHORIZATION_KEY_RECHECK_MS = 30 * 60_000;
/** Unreadable quorum reads in a row before the unknown itself is worth saying. */
const AUTHORIZATION_KEY_UNREADABLE_STREAK = 3;
let authorizationKeyUnreadable = 0;
let lastAuthorizationKeyCheck: AuthorizationKeyCheck | null = null;
async function checkAuthorizationKey(): Promise<void> {
  const signerId = config.privySignerId;
  if (privyConfig === null || signerId === null) return;
  let verdict: AuthorizationKeyVerdict;
  let detail: string | null = null;
  try {
    // REVEALED INSIDE THE CALL THAT NEEDS IT; what comes back is a PUBLIC key.
    const derived = derivePrivyPublicKey(privyConfig.authorizationKey.reveal());
    try {
      verdict = compareWithQuorum(derived, await readPrivyKeyQuorum(privyConfig, signerId));
    } catch (error) {
      verdict = quorumReadVerdict(error, derived);
      detail = summarizeUpstreamError(error, { take: 3, maxChars: 400 });
    }
  } catch (error) {
    if (!(error instanceof AuthorizationKeyUnreadable)) throw error;
    verdict = unreadableKeyVerdict();
    detail = error.message;
  }
  const changed = lastAuthorizationKeyCheck !== verdict.check;
  if (changed && lastAuthorizationKeyCheck !== null) alerter.clear(AUTHORIZATION_KEY_ALERT_KEY);
  lastAuthorizationKeyCheck = verdict.check;
  authorizationKeyUnreadable = verdict.check === "quorum-unreadable" ? authorizationKeyUnreadable + 1 : 0;
  const context = { signerId, verdict: verdict.check, derivedPublicKey: verdict.derivedPublicKey, meaning: verdict.meaning, next: verdict.next, ...(detail === null ? {} : { detail }) };
  if (verdict.check === "matches") {
    if (changed) log.info("privy authorization key belongs to the signer quorum", fields(context));
    alerter.clear(AUTHORIZATION_KEY_ALERT_KEY);
    return;
  }
  const broken = AUTHORIZATION_KEY_BROKEN.has(verdict.check);
  log[broken ? "error" : "warn"]("privy authorization key", fields(context));
  if (verdict.check === "quorum-unreadable" && authorizationKeyUnreadable < AUTHORIZATION_KEY_UNREADABLE_STREAK) return;
  const unknown = verdict.check === "quorum-unreadable";
  alerter.fire({
    key: AUTHORIZATION_KEY_ALERT_KEY,
    severity: broken ? "critical" : "warn",
    title: broken
      ? "The worker's authorization key does not belong to its signer quorum"
      : unknown
        ? "The worker has not been able to check its authorization key for hours"
        : "The worker's authorization key could not be checked against its signer quorum",
    detail: `${verdict.meaning} ${verdict.next}`,
    context: { signerId, derivedPublicKey: verdict.derivedPublicKey, ...(unknown ? { consecutiveAttempts: authorizationKeyUnreadable } : {}) },
  });
}
const recheckAuthorizationKey = (): void =>
  void checkAuthorizationKey().catch((error: unknown) =>
    log.warn("the authorization key could not be checked", fields({ detail: summarizeUpstreamError(error, { take: 3, maxChars: 400 }) })),
  );
recheckAuthorizationKey();
const authorizationKeyTimer = privyConfig === null ? null : setInterval(recheckAuthorizationKey, AUTHORIZATION_KEY_RECHECK_MS);

let stopping = false;
const shutdown = async (signal: string): Promise<void> => {
  if (stopping) return;
  stopping = true;
  if (authorizationKeyTimer !== null) clearInterval(authorizationKeyTimer);
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
