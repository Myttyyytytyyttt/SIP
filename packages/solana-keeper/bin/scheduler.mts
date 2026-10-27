#!/usr/bin/env node
// THE DISPATCHER'S SCHEDULER PROCESS (Q2): the `keeper-scheduler` service of
// dispatcher ADR §3.11, two replicas, one acting under the advisory lock
// `sip-solana-scheduler`. This file wires; what a tick decides is
// src/scheduler.ts's, tested there.
//
// DARK. Production starts bin/keeper.mts (the Dockerfile's CMD); nothing starts
// this file. And it does nothing unless SIP_SOLANA_DISPATCH is `shadow` or
// `on`: unset or `off`, it reads no other variable, opens no connection and
// exits 0.
//
// WHAT IT HOLDS (ADR §3.11): DATABASE_URL, the RPC endpoints, the Helius key and
// the doorbell secret, the alert webhook. NO SIGNING KEY, NO PRIVY KEY, NO
// JUPITER KEY: src/scheduler-config.ts refuses to start with any of them
// present. It is the replica on the public domain.
//
// WHAT RUNS IN IT:
//   * the tick, every SIP_SOLANA_SWEEP_MS (src/scheduler.ts) — the holder
//     schedules, the other replica asks for the lock;
//   * the receiver at POST /hooks/helius, on BOTH replicas, writing bells to
//     Postgres (src/fleet-receiver.ts) — when a doorbell secret is set;
//   * the fleet's /status and /health from Postgres (src/fleet-status.ts),
//     read every 15 s on both replicas, with the five fleet alerts
//     (src/fleet-alerts.ts) raised by the holder;
//   * /leaderboard, debounced, on both replicas (src/scheduler-board.ts);
//   * the auto-arm (src/auto-arm.ts), run by the tick of the holder under `on`
//     when SIP_SOLANA_AUTO_ARM=on: the vaults it enrolled as 'draining' armed by
//     the handover's own `arm` (src/handover.ts), on the pool's connection,
//     with the chain's two heights read through the budgeted Connection;
//   * the process's own `worker` row (kind scheduler), its rpc_usage flushed
//     on the same 10 s beat, and its RPC bucket at the scheduler's share of
//     the plan (ADR §3.9: 8 of the fleet's 40 requests a second, lane `sched`);
//   * the watchdog (src/watchdog.ts), ALWAYS ON HERE: a tick that has not
//     moved for max(3 ticks, 10 min) exits the process with code 3, its
//     session — and the lock — die with it, and the standby takes over at its
//     next tick (ADR §3.11 "Health", §4.9 row 15). Railway's ON_FAILURE starts
//     a fresh one.
//
// CONNECTIONS (ADR §3.11): the pool's ONE (SCHEDULER_POOL_MAX) on each replica,
// plus the lock's pinned session on the holder: 2 + 1. A standby opens a
// connection for the length of its lock attempt, once a tick.

// FIRST, so every library that prints while loading prints through the redactor.
import "../src/console-bridge.js";
import { randomUUID } from "node:crypto";
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { sharedRedactor, summarizeUpstreamError } from "@sip/solana-log";
import { createAlerter } from "../src/alerts.js";
import { AutoArm, PgAutoArmStore } from "../src/auto-arm.js";
import { ConfigError } from "../src/config.js";
import { CreditGovernor, RpcUsageCollector } from "../src/credit-governor.js";
import { DispatchStore, HEARTBEAT_EVERY_MS, PgRpcUsageFeed, createDispatchPool } from "../src/dispatch-store.js";
import { FleetAlerts } from "../src/fleet-alerts.js";
import { PgFleetStore, missingFleetColumns } from "../src/fleet-pg.js";
import { BELL_DELAY_MS, FleetReceiver } from "../src/fleet-receiver.js";
import {
  FLEET_STATUS_REFRESH_MS,
  FleetStatusReader,
  decideFleetHealth,
  fleetStatusView,
  renderFleetStatus,
  samplePool,
  type FleetStatusView,
} from "../src/fleet-status.js";
import { Handover, readChainHeights } from "../src/handover.js";
import { WebhookSync, createHeliusWebhookClient } from "../src/helius-webhooks.js";
import { accountDiscriminator, idl } from "../src/idl.js";
import { createKeeperLogger, scrubbedForExport } from "../src/keeper-log.js";
import { SolanaReadModel } from "../src/read-model.js";
import { PgPriceTape, TapeSampler, missingTapeColumns } from "../src/price-tape.js";
import { RpcBudget } from "../src/rpc-budget.js";
import { poolFetch } from "../src/rpc-pool.js";
import { fleetQuotas } from "../src/rpc-quota.js";
import { heliusRestFetch } from "../src/rpc-usage.js";
import { BOARD_TIMER_MS, FleetBoard } from "../src/scheduler-board.js";
import { createSchedulerChain } from "../src/scheduler-chain.js";
import { autoArmRuns, loadSchedulerConfig, readDispatchMode, type SchedulerConfig } from "../src/scheduler-config.js";
import { PgSchedulerLock, PgSchedulerStore, missingSchedulerColumns, schedulerLockClient } from "../src/scheduler-pg.js";
import { SCHEDULER_LOCK_NAME, Scheduler, type SchedulerWebhook } from "../src/scheduler.js";
import { advisoryKeyFor } from "../src/singleton.js";
import { authorizationMatcher, createHeartbeatServer, httpHandler } from "../src/status.js";
import { startWatchdog, watchdogExitAlert } from "../src/watchdog.js";

const log = createKeeperLogger();

// --preflight: the module graph above has loaded, which is the whole proof for
// a process that builds no transaction. No env, no network.
if (process.argv.includes("--preflight")) {
  log.info("scheduler preflight", { preflight: "ok" });
  process.exit(0);
}

process.on("uncaughtException", (error) => {
  log.error("scheduler: uncaught exception", { detail: summarizeUpstreamError(error, { take: 5, maxChars: 1_000 }) });
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  log.error("scheduler: unhandled rejection", { detail: summarizeUpstreamError(reason, { take: 5, maxChars: 1_000 }) });
  process.exit(1);
});

// SIP_SOLANA_DISPATCH FIRST, AND NOTHING ELSE WHILE IT IS OFF.
const dispatchRead = readDispatchMode(process.env["SIP_SOLANA_DISPATCH"]);
if ("problem" in dispatchRead) {
  log.error("scheduler: configuration refused", { problems: [dispatchRead.problem] });
  process.exit(2);
}
if (dispatchRead.mode === "off") {
  log.info("scheduler: SIP_SOLANA_DISPATCH is off, so the scheduler does not run", { dispatch: "off" });
  process.exit(0);
}

let config: SchedulerConfig;
try {
  config = loadSchedulerConfig(process.env);
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  log.error("scheduler: configuration refused", { problems: error.problems });
  process.exit(2);
}
for (const warning of config.warnings) log.warn("scheduler: configuration warning", { detail: warning });
const base = config.base;
const databaseUrl = base.databaseUrl!;

const processId = `scheduler-${randomUUID()}`;
const version = process.env["RAILWAY_GIT_COMMIT_SHA"]?.slice(0, 12) ?? "local";
const startedAt = Date.now();
/** When the tick last MOVED: /health's and the watchdog's one clock. */
let lastProgressAt: number | null = null;
const progress = (): void => {
  lastProgressAt = Date.now();
};
const healthNow = () => decideFleetHealth({ role: "scheduler", now: Date.now(), startedAt, lastProgressAt, intervalMs: base.sweepMs });

const alerter = createAlerter({
  webhookUrl: base.alertWebhook,
  minSeverity: base.alertMinSeverity,
  destination: base.alertChatId === null ? { kind: "webhook" } : { kind: "telegram", chatId: base.alertChatId },
  links: { statusUrl: base.statusUrl },
  // TOLD APART FROM THE LEGACY KEEPERS in the one chat they all send to.
  titlePrefix: config.dispatch === "shadow" ? "[scheduler, shadow] " : "[scheduler] ",
  log: (severity, line) => log[severity === "critical" ? "error" : "warn"](`alert ${severity}`, { detail: line }),
  sanitize: (text) => scrubbedForExport(text),
});

// ── the chain, through the scheduler's share of the plan ─────────────────────
const shares = fleetQuotas({ planRps: config.planRps, liveWorkers: 0, maxWorkers: config.workersMax, jupiterPerMinute: config.jupiterCallsPerMinute });
const collector = new RpcUsageCollector({ workerId: processId });
const budget = new RpcBudget({ ratePerSecond: shares.schedulerRps, defaultLane: "sched", usage: collector });
const pooled = poolFetch(base.rpcUrls, (message, fields) => log.warn(message, fields), undefined, undefined, undefined, budget);
/** AN ANSWER FROM THE CHAIN IS PROGRESS (bin/keeper.mts's trackedFetch): a tick grinding through a slow listing is not a wedged one. */
const trackedFetch: typeof fetch = async (input, init) => {
  const response = await pooled(input, init);
  progress();
  return response;
};
const connection = new Connection(base.rpcUrls[0]!.reveal(), { commitment: "confirmed", fetch: trackedFetch });
const refuseToSign = async (): Promise<never> => {
  throw new Error("the scheduler holds no key and signs nothing");
};
const program = new anchor.Program(
  idl,
  new anchor.AnchorProvider(connection, { publicKey: PublicKey.default, signTransaction: refuseToSign, signAllTransactions: refuseToSign }, { commitment: "confirmed" }),
);
const chain = createSchedulerChain({
  connection,
  program,
  discriminator: accountDiscriminator("TradingLink"),
  gpaV2: config.cuts.has("gpa-v2"),
  rpc: trackedFetch,
  // SIP_SOLANA_PRICE_TAPE: the SOL/USD account rides in the snapshot's first request.
  priceTape: config.priceTape,
});

// ── Postgres ─────────────────────────────────────────────────────────────────
const pool = createDispatchPool(databaseUrl, "scheduler", `sip-scheduler:${processId.slice(-8)}`, (message, fields) => log.warn(message, fields));
const store = new DispatchStore(pool, processId, config.dispatch === "shadow" ? "shadow" : "live");
const fleetStore = new PgFleetStore(pool);
const schedulerStore = new PgSchedulerStore(pool);
const usageFeed = new PgRpcUsageFeed(pool);

// THE TABLES, BY NAME, BEFORE ANYTHING IS WRITTEN: a database without them is
// "run setup-read-model", not a first tick that fails on a missing column. A
// database that cannot be asked at all ends the process here, through the
// redacting logger (never Node's own fatal print, which quotes what it likes),
// with exit 1: Railway's ON_FAILURE tries again, which is right for an outage.
let missing: string[];
try {
  missing = [...(await missingFleetColumns(pool)), ...(await missingSchedulerColumns(pool)), ...(config.priceTape ? await missingTapeColumns(pool) : [])];
  if (missing.length === 0) await store.registerProcess("scheduler", version, 0);
} catch (error) {
  log.error("scheduler: the database could not be asked at boot", { detail: summarizeUpstreamError(error) });
  await pool.end().catch(() => undefined);
  process.exit(1);
}
if (missing.length > 0) {
  log.error("scheduler: the dispatcher's tables are not in this database; apply sql/sip_solana.sql with setup-read-model", { missing: [...new Set(missing)] });
  process.exit(2);
}

// ── the receiver, the page, the rankings ─────────────────────────────────────
const receiver =
  base.doorbellSecret === null
    ? null
    : new FleetReceiver({
        store: fleetStore,
        authorized: authorizationMatcher(base.doorbellSecret),
        log: (level, message, fields) => log[level](message, fields ?? {}),
      });
// legacy-orphaned only under `on`: a shadow scheduler's database serves no user,
// and no legacy keeper writes receipts to it. SIP_SOLANA_LEGACY_ROLES=none is
// the operator saying the legacy keepers are retired (src/fleet-alerts.ts).
const legacyRetired = config.legacyRoles.length === 0;
const fleetAlerts = new FleetAlerts({ alerter, windowMs: base.sweepMs, legacy: config.dispatch === "on" ? { retired: legacyRetired } : null });
const board = new FleetBoard({
  readModel: SolanaReadModel.overPool(pool, (message, fields) => log.warn(message, fields ?? {})),
  log: (_level, message, fields) => log.warn(message, fields ?? {}),
});

// THE WEBHOOK SYNC: built only where it could ever run — `on`, a Helius key, a
// URL and the secret — and run by the tick only by the lock holder, only while
// fleet.webhook_owner says the webhook is the scheduler's (plan design detail 2).
let watched: ReadonlySet<string> | null = null;
const webhookSync =
  config.dispatch === "on" && base.heliusApiKey !== null && base.doorbellSecret !== null && base.doorbellUrl !== null
    ? new WebhookSync({
        client: createHeliusWebhookClient({
          apiKey: base.heliusApiKey,
          alsoScrub: [base.doorbellSecret],
          // ITS REQUESTS ARE ON THE HELIUS BILL: counted into rpc_usage by verb.
          fetch: heliusRestFetch({
            heliusRest: (verb) =>
              collector.count("helius-rest", "sched", verb === "POST" || verb === "PUT" || verb === "DELETE" ? "webhookWrite" : "webhookUnpriced", 1, Date.now()),
          }),
        }),
        url: base.doorbellUrl,
        secret: base.doorbellSecret,
        onSynced: (report) => {
          watched = report.watched;
          // THE SYNC'S WORD ON THE HEADER reaches this replica's receiver; the other learns it from its first delivery.
          if (report.authConfirmed) receiver?.confirmAuthorization();
          // WHAT THE EDIT ADDED RINGS, so a link the webhook could not hear until now is turned once more after it (Doorbell.setWatched).
          if (report.added.length > 0) {
            void fleetStore.ring({ addresses: report.added, signatures: [], bellDelayMs: BELL_DELAY_MS }).catch((error: unknown) => {
              log.warn("the webhook's new addresses could not be rung; asking for a full pass", { detail: summarizeUpstreamError(error) });
              void fleetStore.requestFullPass("the webhook's new addresses could not be rung").catch(() => undefined);
            });
          }
          if (report.gap !== null) {
            log.warn("Helius dropped deliveries before this sync; the next tick is a full pass", { gap: report.gap });
            void fleetStore.requestFullPass(`the webhook was just repaired (${report.gap})`).catch(() => undefined);
          }
        },
        log: (level, message, fields) => log[level](message, fields),
        deliveries: () => receiver?.deliveryCounts() ?? { accepted: 0, rejected: 0, rejectedSinceAccepted: 0 },
      })
    : null;
if (webhookSync?.manageable === true) watched = new Set<string>();
const webhook: SchedulerWebhook | null =
  webhookSync === null
    ? null
    : {
        tick: (input) => void webhookSync.tick({ acting: true, addresses: input.addresses, now: input.now })?.catch(() => undefined),
        watched: () => watched,
        alert: () => webhookSync.syncAlert(),
      };

// ── the scheduler ────────────────────────────────────────────────────────────
const lock = new PgSchedulerLock({
  client: () => schedulerLockClient(databaseUrl, `sip-scheduler-lock:${processId.slice(-8)}`),
  key: advisoryKeyFor(SCHEDULER_LOCK_NAME),
  onLost: (detail) => log.warn("the scheduler lock's session failed", { detail }),
});
// THE AUTO-ARM: always built, so /status says whether it runs; it acts only
// under `on` with SIP_SOLANA_AUTO_ARM=on (autoArmRuns), and only in the holder's tick.
const autoArm = new AutoArm({
  enabled: autoArmRuns(config),
  legacyRoles: config.legacyRoles,
  store: new PgAutoArmStore(pool),
  handover: new Handover(pool),
  // READ ONLY, processed first — the operator's command's own reader — through the budgeted pool.
  heights: () => readChainHeights(connection),
  log: (level, message, fields) => log[level](message, fields ?? {}),
});
const governor = new CreditGovernor({
  feed: usageFeed,
  planCreditsPerMonth: config.planCreditsPerMonth,
  archivalCredits: base.archivalCredits,
  archivalCreditsSource: base.archivalCreditsSource,
});
const scheduler = new Scheduler({
  id: processId,
  mode: config.dispatch,
  tickMs: base.sweepMs,
  lock,
  store: schedulerStore,
  fullPass: fleetStore,
  intents: store,
  chain,
  quotas: () => store.handOutQuotas({ planRps: config.planRps, maxWorkers: config.workersMax, jupiterPerMinute: config.jupiterCallsPerMinute }),
  governor,
  pruneUsage: (beforeMs) => usageFeed.prune(beforeMs),
  alerter,
  log: (level, message, fields) => log[level](message, fields ?? {}),
  lamportsFilter: config.cuts.has("lamports-filter"),
  doorbellSecret: base.doorbellSecret !== null,
  webhook,
  progress,
  // SIP_SOLANA_PRICE_TAPE=on: one SOL/USD sample a tick into sip_solana.sol_price_tape. Off: none.
  tape: config.priceTape ? new TapeSampler(new PgPriceTape(pool)) : null,
  autoArm,
});

const reader = new FleetStatusReader({
  source: fleetStore,
  onSnapshot: (snapshot) => {
    fleetAlerts.observeSnapshot(snapshot, { acting: scheduler.acting });
    board.observeDirty(snapshot.scheduler?.boardDirtyAt ?? null);
  },
});

const render = (): string => {
  const view: FleetStatusView & Record<string, unknown> = {
    ...fleetStatusView({
      role: "scheduler",
      processId,
      startedAt,
      version,
      health: healthNow(),
      reader,
      receiver,
      alerts: fleetAlerts,
    }),
    dispatch: config.dispatch,
    cuts: config.named,
    scheduler: scheduler.status(),
    leaderboard: board.status(),
    rpcBudget: budget.status(),
    usage: collector.status(),
    webhook: webhookSync?.status() ?? null,
  };
  return renderFleetStatus(view, sharedRedactor);
};

if (base.port !== null) {
  const port = base.port;
  createHeartbeatServer(httpHandler(render, healthNow, () => board.reply(), receiver?.route() ?? null))
    .on("error", (error) => {
      log.error("scheduler: heartbeat server failed", { port, detail: summarizeUpstreamError(error) });
      process.exit(1);
    })
    .listen(port, () => log.info("scheduler: listening", { port }));
}

let stopping = false;
const timers: ReturnType<typeof setInterval>[] = [];
/** No more ticks, beats or board turns from this process: the first step of both ways out. */
const stopTicking = (): void => {
  stopping = true;
  for (const timer of timers.splice(0)) clearInterval(timer);
  scheduler.stop();
};

const watchdog = startWatchdog({
  health: healthNow,
  beforeExit: (report) => {
    log.error("watchdog: the scheduler's tick has stopped moving — exiting so Railway starts a fresh process", {
      quietForMs: report.quietForMs,
      staleAfterMs: report.staleAfterMs,
    });
    alerter.fire({ ...watchdogExitAlert(report), title: "The scheduler is restarting itself: its tick stopped moving" });
    // THE TICKS STOP BEFORE THE SESSION GOES: otherwise this process's next tick
    // takes the lock straight back during the exit's grace. Then the session
    // goes, so the standby can take the lock while this process is still exiting.
    stopTicking();
    lock.release();
  },
  exit: (code) => process.exit(code),
});

/** The process's beat: its row, its rpc_usage, its pool's pressure. */
async function beat(): Promise<void> {
  try {
    await store.beatProcess(0);
  } catch (error) {
    log.warn("the scheduler's worker row could not be beaten", { detail: summarizeUpstreamError(error) });
  }
  const flushed = await collector.flush(usageFeed);
  if ("failed" in flushed) log.warn("the scheduler's rpc_usage could not be flushed; kept for the next beat", { kept: flushed.kept });
  fleetAlerts.observePools([samplePool(pool)]);
}

log.info("scheduler starting", {
  dispatch: config.dispatch,
  scheduler: processId,
  version,
  lock: SCHEDULER_LOCK_NAME,
  tickMs: base.sweepMs,
  endpoints: base.rpcUrls.length,
  cuts: config.named,
  schedulerRps: shares.schedulerRps,
  planRps: config.planRps,
  workersMax: config.workersMax,
  doorbell: base.doorbellSecret === null ? "off — no bell can reach this replica" : "on — the receiver writes bells to Postgres",
  webhook: webhookSync === null ? "not managed here" : "managed by the lock holder while fleet.webhook_owner is 'scheduler'",
  priceTape: config.priceTape ? "on — the lock holder samples SOL/USD into sip_solana.sol_price_tape every tick" : "off",
  autoArm: autoArm.enabled
    ? `on — the lock holder arms the vaults it enrolled as draining; acting receipts required from: ${config.legacyRoles.length === 0 ? "none (legacy keepers retired)" : config.legacyRoles.join(", ")}`
    : "off — a vault enrolled as draining waits for dispatch-handover arm",
  legacyOrphaned:
    config.dispatch !== "on"
      ? "off — not evaluated under shadow"
      : legacyRetired
        ? "on — SIP_SOLANA_LEGACY_ROLES=none: a linked vault still 'legacy', or new vaults going there, warns at once and pages at 30 min"
        : "on — warns when a linked vault is still 'legacy' (or new vaults go there) and no legacy keeper has read in 15 min; pages at 30 min",
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    stopTicking();
    watchdog.stop();
    // THE RECEIVER'S BELLS FIRST (bounded), then the lock, then the row: a
    // delivery already answered 200 is written before the process goes.
    const drained = receiver === null ? Promise.resolve() : Promise.race([receiver.idle(), new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
    void drained
      .then(() => {
        lock.release();
        return store.processStopped().catch(() => undefined);
      })
      .then(() => collector.flush(usageFeed).catch(() => undefined))
      .finally(() => {
        log.info("scheduler stopped", { signal });
        void pool.end().catch(() => undefined);
        process.exit(0);
      });
  });
}

const runTick = async (): Promise<void> => {
  if (stopping) return;
  const report = await scheduler.tick();
  if (report.kind === "acted") {
    log.info("scheduler tick", {
      tookOver: report.tookOver,
      discovery: report.discovery,
      fullPass: report.fullReason,
      lanes: report.lanes,
      autoArmed: report.autoArmed.length,
      due: report.marked.length,
      completedIdle: report.completedIdle.length,
      leftBusy: report.leftBusy,
    });
  }
};

board.request();
void reader.refresh();
void beat();
await runTick();
timers.push(setInterval(() => void runTick(), base.sweepMs));
timers.push(setInterval(() => board.request(), BOARD_TIMER_MS));
timers.push(setInterval(() => void reader.refresh(), FLEET_STATUS_REFRESH_MS));
timers.push(setInterval(() => void beat(), HEARTBEAT_EVERY_MS));
