#!/usr/bin/env node
// SIP's Solana keeper: one process, every linked wallet, in a loop.
//
// Ported from Nuvem's solana-lab keeper (keeper/bin/supervisor.mts) — the process
// that turned a one-wallet drill into a product. It discovers every TradingLink
// on sip-vault, measures each wallet's unsettled span, attests, settles through
// settle_v2, and invests what accumulated — forever, without anyone typing
// anything. This file wires; the decisions live in src/ and are tested there.
//
// WHO — from the chain. Every link is a PDA, so getProgramAccounts returns the
// complete current set. No user table, nothing to migrate, and no log watermark
// that can silently step over a user.
//
// SAFETY, ported unchanged in spirit:
//   * DRY RUN BY DEFAULT, AND A DRY RUN HOLDS NO KEY. Nuvem's supervisor loaded
//     the crank and attester secrets at startup even in dry run, and exited
//     without them. Here a dry run reads no signing secret (src/config.ts), takes
//     the attester and crank identities from the on-chain ProtocolConfig, and
//     measures and reports what it would settle.
//   * ONE CYCLE AT A TIME. An overrunning cycle is skipped, never stacked.
//   * A FAILURE IS CONTAINED PER WALLET; one bad link never ends the sweep.
//   * NOTHING UNPROVEN MOVES MONEY. A broken balance chain refuses to attest.
//
// LIVE IS A CONJUNCTION, asked every sweep and served by /status as the first
// missing condition (src/chain-state.ts): armed — SIP_SOLANA_BROADCAST=1 with the
// exact sentence, which config.ts only accepts with a settle key that parses —
// AND the on-chain ProtocolConfig names that key as both attester and keeper AND
// this instance holds the sip-solana-keeper claim.

// FIRST, so every library that prints while loading prints through the redactor.
import "../src/console-bridge.js";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { sharedRedactor, summarizeUpstreamError } from "@sip/solana-log";
import { readVaultNullable, readVaults, type VaultState } from "../src/accounts.js";
import { createAlerter, describeDelivery, type Alerter, type AlerterOptions } from "../src/alerts.js";
import {
  keysForTurn,
  missingLiveCondition,
  readChainSnapshot,
  verifySettleKey,
  type ChainSnapshot,
  type LiveVerification,
} from "../src/chain-state.js";
import { ClaimWatch } from "../src/claim-watch.js";
import { ConfigError, SIGNING_SECRET_VARS, loadConfig, type KeeperConfig } from "../src/config.js";
import {
  DependencyWatch,
  answerOutcome,
  depDownAlerts,
  gatedAlerter,
  isJupiterHost,
  observeGlobalFetch,
  unansweredOutcome,
  watchedRpcFetch,
} from "../src/dependency-watch.js";
import { discoverLinks, discoverLinksPreferringV2, rereadLinks, type DiscoveryReport, type ManagedLink } from "../src/discovery.js";
import {
  LEGACY_SELECT_ALERT_KEY,
  LEGACY_SELECT_CRITICAL_STREAK,
  LegacySelector,
  carryOnlyInMemoryVaults,
  legacySelectAlert,
  leftAloneDetail,
  partitionLegacyTurns,
} from "../src/dispatch-select.js";
import { DISCOVERY_STALE_ALERT_KEY, LastKnownGoodDiscovery, discoveryStaleAlert } from "../src/discovery-lkg.js";
import { CoalescedRefresh } from "../src/board-refresh.js";
import {
  DOORBELL_DEAF_ALERT_KEY,
  Doorbell,
  doorbellDeafAlert,
  turnRests,
  type DoorLink,
  type TurnInvest,
  type TurnSettle,
} from "../src/doorbell.js";
import { createDoorbellWebhookSync, createHooksRoute } from "../src/doorbell-wiring.js";
import { DOORBELL_SYNC_ALERT_KEY } from "../src/helius-webhooks.js";
import { accountDiscriminator, idl } from "../src/idl.js";
import {
  INVEST_FAILED_CRITICAL_STREAK,
  investFailedAlert,
  investFailedStreak,
  wrapShortAlert,
  wrapShortStreak,
} from "../src/invest-decision.js";
import { CrankSender, SIGTERM_DRAIN_MS } from "../src/explicit-send.js";
import { runInvestTick, type InvestResult } from "../src/invest-tick.js";
import { investLeavesSnapshotTrue, readSweepState, restVerdictReadAt, settleLeavesSnapshotTrue, type InvestSnapshot } from "../src/invest-snapshot.js";
import { JupiterPacer, type JupiterAccess } from "../src/jupiter-pacer.js";
import { SERVICE, createChangeLog, createKeeperLogger, scrubbedForExport } from "../src/keeper-log.js";
import { runPreflight } from "../src/preflight.js";
import {
  AUTHORIZATION_KEY_BROKEN,
  type AuthorizationKeyCheck,
  AuthorizationKeyUnreadable,
  compareWithQuorum,
  derivePrivyPublicKey,
  notCheckedVerdict,
  quorumReadVerdict,
  unreadableKeyVerdict,
  type AuthorizationKeyVerdict,
} from "../src/privy-authorization-key.js";
import { PrivyAddressBook, confirmedSubmitter } from "../src/privy-address-book.js";
import {
  buildPrivySolanaIndex,
  createPrivySolanaSigner,
  privyAddressSource,
  readPrivyKeyQuorum,
  seatsSignable,
  unsignableNote,
  type PrivySolanaConfig,
  type PrivyWalletEntry,
  type SolanaWalletSubmitter,
} from "../src/privy-signer.js";
import { SolanaReadModel, type DatabaseObserver } from "../src/read-model.js";
import { poolFetch } from "../src/rpc-pool.js";
import { CREDIT_BURN_ALERT_KEY, countConfirmations, createRpcUsage, creditBurnAlert, heliusRestFetch } from "../src/rpc-usage.js";
import { createPrivyUsage } from "../src/privy-usage.js";
import { seatCheck, seatCheckNotice } from "../src/seat-check.js";
import { activeBps, measurementStart, settleAlert, settleRetryStreak, settleThrewAlert, type CarryBook } from "../src/settle-decision.js";
import { runSettleTick, type SettleDeps, type SettleOutcome, type SettleSend } from "../src/settle-tick.js";
import { loadLocalSigners, type LocalSigners } from "../src/signers.js";
import { KeeperClaim, advisoryKeyFor } from "../src/singleton.js";
import { tradeNotional } from "../src/measure-volume.js";
import { PolicyBoundaryBook, type OwnerHistoryReader } from "../src/policy-boundary.js";
import { readTransaction, WalkCache, type WalkCounters } from "../src/measure-window.js";
import { RestBook } from "../src/rest-book.js";
import { DurableCarries, PgCarryStore, createCarryPool } from "../src/carry-store.js";
import { KEYED_API, LITE_API, MODE_PROFIT } from "../src/program-scripts.js";
import { measuredBase, resolvesSignerFor, roleProfile, unreachable } from "../src/role-registry.js";
import { createVolumeBase } from "../src/volume-base.js";
import { previewLastSettled, previewVolume, type PreviewBook } from "../src/volume-preview.js";
import { computeLeaderboard } from "../src/leaderboard.js";
import { computeGlobalStats, type GlobalStats } from "../src/global-stats.js";
import {
  createHeartbeatServer,
  decideHealth,
  healthStaleAfterMs,
  httpHandler,
  renderLeaderboard,
  renderStatus,
  type DoorbellStatus,
  type HealthReport,
  type KeeperStatus,
  type LeaderboardReply,
  type OpsStatus,
  type PendingCarry,
} from "../src/status.js";
import {
  SWEEP_SKIPPED_ALERT_KEY,
  SWEEP_SKIPPED_CRITICAL_STREAK,
  SWEEP_SLOW_ALERT_KEY,
  createSweepTimes,
  createTurnTimers,
  jupiterCalls,
  settleWalked,
  sweepSkippedAlert,
  sweepSlowAlert,
  walkSweepReport,
} from "../src/sweep-cost.js";
import {
  JUPITER_BUDGET_ALERT_KEY,
  JupiterAnswers,
  PRIVY_BURN_ALERT_KEY,
  PRIVY_INDEX_ALERT_KEY,
  RPC_FALLBACK_ALERT_KEY,
  jupiterBudgetAlert,
  privyBurnAlert,
  privyIndexAlert,
  rpcFallbackAlert,
  type AlertDecision,
} from "../src/usage-alerts.js";
import { DIGEST_ALERT_KEY, WarnDigest } from "../src/warn-digest.js";
import { WATCHDOG_EXIT_CODE, startWatchdog, watchdogExitAlert, type Watchdog } from "../src/watchdog.js";
import {
  VAULT_READ_ALERT_KEY,
  VAULT_READ_CRITICAL_STREAK,
  createCarryWatch,
  foldInvestTurn,
  legFeeAlert,
  LegFeeBook,
  SigningRoutes,
  vaultReadAlert,
  type VaultInvestSweep,
} from "../src/sweep-decision.js";

const log = createKeeperLogger();

// --preflight: the module graph above has loaded, which is half the proof. The
// other half is the invariants and the four money-path instruction builders,
// checked with no network, no keys and no env.
if (process.argv.includes("--preflight")) {
  const result = await runPreflight();
  if (!result.ok) {
    log.error("preflight failed", { program: result.program, invariants: result.invariants, failure: result.failure });
    process.exit(1);
  }
  log.info("preflight", { preflight: "ok", program: result.program, invariants: result.invariants });
  process.exit(0);
}

// A crash is a line like any other: Node's default handler writes the stack
// straight to stderr, past the redactor, and a stack can quote an endpoint.
process.on("uncaughtException", (error) => {
  log.error("uncaught exception", { detail: summarizeUpstreamError(error, { take: 5, maxChars: 1_000 }) });
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  log.error("unhandled rejection", { detail: summarizeUpstreamError(reason, { take: 5, maxChars: 1_000 }) });
  process.exit(1);
});

/**
 * EXIT 2 IS "YOU HAVE TO CHANGE SOMETHING" (the worker's convention): a restart
 * loop over an environment variable fixes nothing, and the problem list says
 * exactly what to change without echoing a value.
 */
let config: KeeperConfig;
try {
  config = loadConfig(process.env);
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  log.error("configuration refused", { problems: error.problems });
  process.exit(2);
}
// Gone for the rest of the process's life, deleted by NAME: a child process or a
// crash handler that dumps process.env finds nothing. In a dry run they were
// never read; armed, config.ts already holds what it needs.
for (const name of SIGNING_SECRET_VARS) delete process.env[name];
for (const warning of config.warnings) log.warn("configuration warning", { detail: warning });

/**
 * WHAT THIS KEEPER DOES, AS DATA (src/role-registry.ts). Every place below that
 * differs between the keepers reads it here — the alert prefix, the lock, the
 * crank alert, whose signer is resolved, which modes are settled and measured
 * how, who invests, the banner — rather than comparing the role to a literal.
 * A two-way comparison sends any role it was not written for into its else
 * branch, which here was the profit keeper's: its lock, its settles, its buying.
 */
const profile = roleProfile(config.role);

const programId = new PublicKey(config.programId);
const TRADING_LINK_DISC = accountDiscriminator("TradingLink");

/**
 * WHEN THE SWEEP LAST MOVED, and the only clock /health is allowed to read.
 *
 * IT MEANS "STILL WORKING", NOT "STARTED WORKING". This was stamped once at the
 * top of each sweep, which cannot tell a wedged sweep from one making steady
 * progress: one backlogged VOLUME wallet against a throttled endpoint spends the
 * whole ten-minute bound inside a single turn — up to MAX_SIGNATURES
 * getTransaction reads, each bounded only by the pool's 30 s timeout — so
 * /health answered 503 mid-sweep, Railway restarted the container, and the fresh
 * process re-ran the same walk against the same endpoint and 503'd again, losing
 * every pending carry on each pass. It is now advanced wherever the sweep
 * demonstrably moves: a sweep begins, a link's turn begins, an RPC call comes
 * back. A genuinely wedged sweep advances none of them and still answers 503.
 *
 * NOT `health.lastSweepAt`, which is written near the END of a sweep, after the
 * chain read, the discovery and the batched vault read have each succeeded; a
 * sweep that throws anywhere above it leaves it untouched forever, and a
 * staleness rule on that clock would read an RPC outage as a wedged process and
 * hand Railway a restart loop, which has never once fixed an RPC.
 */
let lastProgressAt: number | null = null;
const noteProgress = (): void => {
  lastProgressAt = Date.now();
};

// FAILOVER UNDER THE TRANSPORT, not around each call. Connection threads one
// endpoint through everything it does; replacing its `fetch` gives Anchor, the
// settle path and the invest path the same failover without a line of their own.
/**
 * WHICH ENDPOINT IS ANSWERING, AND HOW OFTEN ONE HAS BEEN SET ASIDE.
 *
 * A failover is silent by design — that is the point of putting the pool under
 * the transport — and it is also the single change that most moves the numbers
 * an operator sizes this keeper on: another provider, another latency, another
 * rate limit. Until now the only record was a warning line in a log that
 * scrolls. BY LABEL, NEVER BY URL: SIP_SOLANA_RPC_URLS carries API keys and
 * /status is public (src/rpc-pool.ts, endpointLabel).
 *
 * `let`s rather than fields on `health`, because that object is built further
 * down this file and these callbacks are installed before it exists. They are
 * folded in where the page is rendered, exactly as pendingCarries is.
 */
let failovers = 0;
let rpcEndpointInUse: string | null = null;
/**
 * THE REST OF L1a (src/cuts.ts, OPS_TOKENS): each piece that keeps state, built
 * only while its token is named and null otherwise — and every line below that
 * reaches one asks it through that null, so with none named nothing here runs.
 *
 *   * dep-down: the shared dependencies, told how each request ended where it
 *     already passes — the RPC pool just below, the Privy clients' fetch, the
 *     global fetch for Jupiter's host, the read model's round trips — and one
 *     page per dependency that is down (src/dependency-watch.ts).
 *   * jupiter-budget (and dep-down, which needs the same observation): what
 *     Jupiter's host answered, 429s by sweep (src/usage-alerts.ts).
 *   * claim-flap: the claim's takeovers, losses and regains (src/claim-watch.ts).
 *   * warn-digest: the day's warnings, for one message at 08:00 UTC (src/warn-digest.ts).
 *
 * The watchdog (watchdog-exit) is started further down, once the claim it
 * releases exists.
 */
const depWatch: DependencyWatch | null = config.cuts.has("dep-down") ? new DependencyWatch() : null;
const jupiterAnswers: JupiterAnswers | null = config.cuts.has("dep-down") || config.cuts.has("jupiter-budget") ? new JupiterAnswers() : null;
const claimWatch: ClaimWatch | null = config.cuts.has("claim-flap") ? new ClaimWatch() : null;
const warnDigest: WarnDigest | null = config.cuts.has("warn-digest") ? new WarnDigest(Date.now()) : null;
// JUPITER'S ROUTE BUILDER TAKES NO FETCH (it lives in @sip/solana-program and
// calls the global one), so its answers are seen there, for its host only: every
// other request passes through untouched (observeGlobalFetch). Its 429s are
// jupiter-budget's, never dep-down's — being throttled is not being down.
if (jupiterAnswers !== null) {
  observeGlobalFetch(globalThis, isJupiterHost, (answer, error) => {
    const at = Date.now();
    jupiterAnswers.record(answer, at);
    if (depWatch !== null && answer !== 429) depWatch.record("jupiter", at, answer === "unanswered" ? unansweredOutcome(error) : answerOutcome(answer));
  });
}
/**
 * WHAT THIS KEEPER ASKS OF ITS PROVIDERS, AND WHAT IT COSTS (ADR L1a). The RPC
 * meter is told every request the pool is handed and how each endpoint
 * answered (src/rpc-usage.ts); the Privy meter every request a Privy client of
 * this process makes and every settle signature by mode (src/privy-usage.ts);
 * the turn timers what a settle and a send take. All three are read only by
 * /status and by credit-burn, which is off until SIP_SOLANA_CREDIT_BUDGET_DAY is
 * set. NONE OF THEM IS ASKED ANYTHING BEFORE A DECISION: they are told after.
 */
const rpcUsage = createRpcUsage({
  archivalCredits: config.archivalCredits,
  archivalCreditsSource: config.archivalCreditsSource,
  budgetPerDay: config.creditBudgetPerDay,
  startedAt: Date.now(),
});
// UNDER dep-down, the same fetch also tells the Privy watch how each request
// ended (onAnswer: an answer, or a 5xx, 408, 429 or no answer at all); without
// it, the meter exactly as it was.
const privyUsage = createPrivyUsage({
  startedAt: Date.now(),
  ...(depWatch === null
    ? {}
    : {
        onAnswer: (answer: number | "unanswered", error?: unknown) =>
          depWatch.record("privy", Date.now(), answer === "unanswered" ? unansweredOutcome(error) : answerOutcome(answer)),
      }),
});
const turnTimers = createTurnTimers();
const pooledFetch = poolFetch(
  config.rpcUrls,
  (message, fields) => {
    failovers += 1;
    log.warn(message, fields);
  },
  undefined,
  (at) => {
    rpcEndpointInUse = at;
  },
  rpcUsage,
);
/**
 * Under dep-down, the pool's own verdict on each request: an answer, or the
 * pool's one throw, which it makes only once every endpoint has refused
 * (watchedRpcFetch). Without the token, the pool itself.
 */
const rpcFetch: typeof fetch = depWatch === null ? pooledFetch : watchedRpcFetch(pooledFetch, depWatch);
/**
 * The same transport, plus the one thing /health needs: AN ANSWER FROM THE CHAIN
 * IS PROGRESS. Every RPC call this process makes goes through here — Anchor's
 * reads, the measure walk, the settle sends — so a sweep grinding through a
 * backlog keeps the clock moving without a progress callback threaded down the
 * settle path. Only a RETURNED response stamps: a throw leaves the clock alone.
 */
const trackedFetch: typeof fetch = async (input, init) => {
  const response = await rpcFetch(input, init);
  noteProgress();
  return response;
};
const connection = new Connection(config.rpcUrls[0]!.reveal(), {
  commitment: "confirmed",
  fetch: trackedFetch,
});
// THE ONE CALL THE POOL CANNOT SEE: Anchor's sendAndConfirm, behind every invest
// send, confirms on a websocket web3.js opens beside the transport. Counted and
// timed around the call, which runs and answers exactly as it did
// (countConfirmations, src/rpc-usage.ts).
countConfirmations(connection, {
  started: () => rpcUsage.webSocketConfirmation(),
  ended: (ms) => turnTimers.record("investConfirmMs", ms),
});

/**
 * What one live settle send took and how it ended (SettleDeps.onSend): its two
 * waits go to the turn timers, and a send through Privy is one signature on the
 * free tier, counted by the mode it charged.
 */
function noteSettleSend(send: SettleSend): void {
  turnTimers.record("settleSubmitMs", send.submitMs);
  if (send.confirmMs !== null) turnTimers.record("settleConfirmMs", send.confirmMs);
  if (send.route === "privy") privyUsage.signature(send.mode, send.ended !== "threw");
}

/** The four usage blocks of /status, read at the moment of the request: each is a sliding window. */
function usageStatus(): Pick<KeeperStatus, "rpc" | "privy" | "jupiter" | "turnTimes"> {
  const now = Date.now();
  return { rpc: rpcUsage.report(now), privy: privyUsage.report(now), jupiter: jupiterCalls.report(now), turnTimes: turnTimers.report() };
}

/** Armed only. The attester and the crank are this one key during the hackathon. */
const settleKeypair: Keypair | null = config.signing?.settleKey.keypair() ?? null;

type ProviderWallet = ConstructorParameters<typeof anchor.AnchorProvider>[1];
const refuseToSign = async (): Promise<never> => {
  throw new Error("dry run: this keeper holds no key and signs nothing");
};
/**
 * The provider's wallet in a dry run: a public key and two methods that refuse.
 * Anchor wants a wallet to build a provider; a dry run has nothing to give it,
 * and no dry turn calls these — they exist so that if something ever does, it
 * fails loudly instead of signing.
 */
const providerWallet: ProviderWallet =
  settleKeypair !== null
    ? new anchor.Wallet(settleKeypair)
    : { publicKey: PublicKey.default, signTransaction: refuseToSign, signAllTransactions: refuseToSign };
const provider = new anchor.AnchorProvider(connection, providerWallet, { commitment: "confirmed" });
const program = new anchor.Program(idl, provider);

/**
 * THE `explicit-send` CUT (src/explicit-send.ts, L1d). Without the token, null,
 * and every crank transaction goes through Anchor's `.rpc()` and
 * `provider.sendAndConfirm`, as always. With it: the same transactions, signed
 * by the same wallet, sent in the keeper's own order with isLive() asked before
 * each one, no wrap/convert/invest for QUIET_AFTER_TAKEOVER_MS after this
 * process starts or takes the claim, and a SIGTERM drain.
 *
 * isLive IS ASKED THROUGH A CLOSURE because it is defined below, beside the
 * claim — and because the sender must never hold a cached answer to it.
 */
const crankSender: CrankSender | null = config.cuts.has("explicit-send")
  ? new CrankSender({
      connection,
      wallet: provider.wallet,
      isLive: () => isLive(),
      onConfirmed: (ms) => turnTimers.record("investConfirmMs", ms),
    })
  : null;

// History for the website. Absent DATABASE_URL it is a no-op; a write failure
// is a warning and never touches the settlement path. See src/read-model.ts.
// Under dep-down, each round trip also tells the Postgres watch whether the
// database answered (databaseAnswered, src/read-model.ts); without it, nothing.
const databaseObserver: DatabaseObserver | undefined =
  depWatch === null ? undefined : (answered) => depWatch.record("database", Date.now(), answered ? { ok: true } : { ok: false, reason: "no answer from the database" });
const readModel = SolanaReadModel.create(config.databaseUrl, (message, fields) => log.warn(message, fields ?? {}), databaseObserver);

/**
 * WAKING SOMEONE WHEN SAVINGS STOP.
 *
 * Every failure this keeper has actually had looked healthy from outside: a
 * wallet that never granted its signer, an RPC quietly throttling, a mirror
 * hanging with /health green. The symptom was always an ABSENCE — money that
 * did not arrive — and nothing reported absences to anyone. Conditions fire ONCE
 * and stay quiet until they clear; without a webhook they still reach the log.
 */
const alerterOptions: AlerterOptions = {
  webhookUrl: config.alertWebhook,
  minSeverity: config.alertMinSeverity,
  destination: config.alertChatId === null ? { kind: "webhook" } : { kind: "telegram", chatId: config.alertChatId },
  links: { statusUrl: config.statusUrl },
  // A KEEPER OTHER THAN THE PROFIT ONE SAYS WHO IT IS in the one chat both keepers
  // send to (its profile's alertTitlePrefix; the profit keeper's titles go as fired).
  ...(profile.alertTitlePrefix === null ? {} : { titlePrefix: profile.alertTitlePrefix }),
  log: (severity, line) => log[severity === "critical" ? "error" : "warn"](`alert ${severity}`, { detail: line }),
  // THE BODY LEAVES THE BOX, SO IT PASSES WHAT A LOG LINE PASSES. alerts.ts
  // builds its webhook payload itself and POSTs it raw; only the line above goes
  // through the redacting logger. Every alert `detail` in this file is either a
  // summarized upstream error or an exception's own text — anchor's, the SDK's,
  // a driver's — and the byte-run net exists precisely for a key none of them
  // ever registered.
  sanitize: (text) => scrubbedForExport(text),
};
const baseAlerter = createAlerter(alerterOptions);
/**
 * WHAT EVERY LINE BELOW FIRES INTO. With neither dep-down nor warn-digest named,
 * the alerter above itself. With them: the dependency gate first, which holds
 * what a down dependency explains (gatedAlerter), then the digest's tap, which
 * counts what is still raised (WarnDigest.tap) — so a held warn is not also
 * summarized tomorrow as if it had stood on its own.
 */
const tappedAlerter: Alerter = warnDigest === null ? baseAlerter : warnDigest.tap(baseAlerter);
const alerter: Alerter = depWatch === null ? tappedAlerter : gatedAlerter(tappedAlerter, depWatch);
/**
 * The digest's own sender (warn-digest): the same destination, title prefix and
 * redactor as every alert, with a threshold of `warn`, so the day's summary of
 * warnings reaches the chat as the warning it is (src/warn-digest.ts says why
 * it is not dressed as a critical). Nothing else is ever fired on it.
 */
const digestAlerter: Alerter | null = warnDigest === null ? null : createAlerter({ ...alerterOptions, minSeverity: "warn" });

/**
 * THE ALERT LINE ON /status, AS A FACT RATHER THAN A RESTATEMENT.
 *
 * Built from two environment variables, "telegram: critical and above" reads
 * exactly the same whether every message was accepted or every one was refused
 * 403 because the bot was blocked or was never spoken to. The owner reads that
 * line as proof the box works. It never was: it proved the URL parsed.
 *
 * So it carries what the alerter actually saw. Refreshed at the end of every
 * sweep, like health.history — and never the URL, which is a credential, on an
 * endpoint that is public and unauthenticated.
 */
function describeAlerts(): string {
  if (config.alertWebhook === null) return "log-only";
  return describeDelivery(config.alertChatId === null ? "webhook" : "telegram", config.alertMinSeverity, alerter.delivery());
}

const changes = createChangeLog(log);

/**
 * Sweeps in a row this armed instance has been demoted to dry run because the
 * claim is held elsewhere. A HANDOVER IS NOT AN OUTAGE: the sweep after a deploy
 * routinely finds the outgoing instance's lock still held, and it clears itself.
 * A lock that is STILL held five minutes later is a stale one, and while it
 * lasts this keeper charges nothing at all — which is exactly the silent failure
 * the alerts exist for. Same shape as SETTLE_RETRY_CRITICAL_AFTER.
 */
let notActingSweeps = 0;
const NOT_ACTING_CRITICAL_AFTER = 5;

/**
 * Sweeps in a row each wallet's settle came back RETRY. Any other outcome
 * removes the wallet; settleAlert pages critical once the count reaches
 * SETTLE_RETRY_CRITICAL_AFTER.
 */
const settleRetries = new Map<string, number>();

/**
 * The losses zero settles carried forward, per link state (LossCarry,
 * src/settle-decision.ts). IN MEMORY: a restart forgets every pending carry, and
 * that is the only way a loss is forgotten without the wallet's own 100 signed
 * transactions (ZERO_BASE_MIN_TXS).
 */
const settleCarries: CarryBook = new Map();

/**
 * SIP_SOLANA_CARRY_STORE (src/carry-store.ts): the carries in Postgres as well
 * (`dual`) or instead (`on`), so a restart no longer forgets one. NULL IS `off`,
 * which is today: the book above is all there is. config.ts refuses a store
 * without DATABASE_URL, or on a role that carries no loss, so a non-null store
 * always has a database and a mode that uses it.
 *
 * ITS OWN POOL, of one connection (createCarryPool): a settle must never queue
 * for its carry behind the read model's fire-and-forget history writes. ITS OWN
 * WRITER ID, new every boot, so a successor tells the old container's rows from
 * its own (on's gate).
 */
const carryStore: DurableCarries | null =
  config.carryStore === "off" || config.databaseUrl === null
    ? null
    : new DurableCarries(
        config.carryStore,
        new PgCarryStore(
          createCarryPool(config.databaseUrl, (message, fields) => log.warn(message, fields)),
          `${profile.lockName}:${randomUUID()}`,
        ),
        {
          fire: (alert) => alerter.fire(alert),
          clear: (key) => alerter.clear(key),
          warn: (message, fields) => log.warn(message, fields),
          // UNDER dep-down, its round trips count toward the database's, as the read
          // model's do: it is a table in the same database.
          ...(databaseObserver === undefined ? {} : { observe: databaseObserver }),
        },
      );

/**
 * What the settle walks read, kept between sweeps (WalkCache, src/measure-window.ts):
 * a span that did not settle is walked again from the same frontier, and only what
 * the cache does not hold is fetched again — mostly what is new since. IN MEMORY:
 * after a restart, each window is fetched once more.
 */
const walkCache = new WalkCache();

/**
 * THE MIGRATION'S SELECTION (src/dispatch-select.ts), only under
 * SIP_SOLANA_DISPATCH: every sweep reads sip_solana.vault_work, leaves alone —
 * settle and invest — every vault it does not call `legacy`, and writes this
 * process's receipt (legacy_process) in the same statement. NULL IS `off`, which
 * is today: no statement, no receipt, every selected turn runs. config.ts refuses
 * the variable without DATABASE_URL, so a selector always has a database.
 */
const legacySelector: LegacySelector | null =
  config.dispatch === "off"
    ? null
    : new LegacySelector({
        role: config.role,
        mode: config.dispatch,
        processId: randomUUID(),
        deployment: process.env["RAILWAY_DEPLOYMENT_ID"]?.trim() || null,
        host: hostname(),
        carryStore: config.carryStore,
        run: (text, values) => readModel.statement(text, values),
      });

/**
 * The `rest-skip` cut's memos (src/rest-book.ts): which settled links rest on
 * their own settle, so a probe that shows nothing new returns their IDLE without
 * walking. ONLY WITH THE TOKEN; null is today, where every such link walks every
 * sweep. IN MEMORY: after a restart each settled link walks once more.
 */
const restBook: RestBook | null = config.cuts.has("rest-skip") ? new RestBook() : null;

/**
 * What the carry book holds, for /status. The book is keyed by LINK and an
 * operator thinks in wallets, so each sweep leaves behind the pairing it just
 * discovered; a carry whose link is gone from the chain shows a null wallet
 * rather than disappearing. The watch only reads the book — see createCarryWatch.
 *
 * WHEN each carry started waiting is stamped by the SWEEP, through record()
 * below, not by this projection: a "since" created at the moment of the first
 * page view is the reader's clock, not the loss's.
 */
const carryWatch = createCarryWatch();
const linkWallets = new Map<string, string>();
const pendingCarries = (): readonly PendingCarry[] => carryWatch.observe(settleCarries, (link) => linkWallets.get(link) ?? null, Date.now());

/**
 * Consecutive invest turns, per vault, that found more free SOL than the crank
 * could front. One large settlement wraps in slices over a few sweeps; a crank
 * that stays short of a vault leaves its savings unwrapped, and one between
 * 0.02 and 0.025 SOL wraps nothing at all while crank-low stays silent.
 */
const wrapShort = new Map<string, number>();

/**
 * Consecutive FAILED invest turns, per vault. Only REFUSED used to alert, so a
 * vault that had stopped buying logged one warn line per sweep and paged nobody.
 */
const investFailed = new Map<string, number>();

/**
 * The leg-fee alert keys that are STANDING: raised by the last turn of some
 * vault that actually read a leg mint, and not yet cleared.
 *
 * WHY A SET OF KEYS AND NOT A COUNT PER VAULT. The key legFeeCeilingAlert
 * builds is `leg-fee:<mint>:<worst bps>` — the MINT and the RATE, with no vault
 * in it, deliberately (src/invest-decision.ts says why: a key of the mint alone
 * would let a 50 bps warning mute the 100 bps that replaced it for the whole
 * repeat window). Two vaults holding the same leg are therefore one condition
 * and one message, which is what an operator wants; so the bookkeeping that
 * decides when to CLEAR has to be the same shape — per key, across the sweep —
 * rather than per vault, where one vault's clear would silence another's.
 *
 * WHAT CLEARING IS FOR. alerts.ts holds a fired condition quiet for the repeat
 * window and re-fires only on an escalation. Without a clear, a fee that drops
 * back under the band and rises again inside that window would say nothing the
 * second time. With it, the next occurrence alerts at once — and because the
 * rate is IN the key, a fee that worsens raises a new key immediately while the
 * old one is cleared in the same pass, so nothing rings on unchanged.
 *
 * ONLY A SWEEP THAT LOOKED MAY CLEAR. A turn that refused on the in_mint, the
 * venue or an unroutable basket never reads a mint at all, and a sweep of
 * nothing but those turns has learned nothing about any fee. Treating its
 * silence as "the condition went away" would clear a standing warning and then
 * re-raise it on the next sweep that did read — one message per sweep, forever,
 * which is precisely the alarm this deduplication exists to prevent.
 */
// PER VAULT SINCE THE DOORBELL. The paragraphs above were written when every
// sweep turned every vault, so "the sweep did not raise it" meant "nobody has
// it". Now a vault can simply not be turned this sweep, and its silence is not
// evidence of anything: each vault keeps what its own last looking turn raised,
// and what stands is their union (LegFeeBook and reconcileLegFees,
// src/sweep-decision.ts, which own that state so no call site can fold a sweep
// against the wrong one).
const legFeeBook = new LegFeeBook();

/**
 * Consecutive sweeps whose ONE batched vault read failed. A sweep that degrades
 * to a read per link still settles every link whose vault it can read, so one
 * refused request is weather; three in a row is an endpoint that cannot serve
 * this program's accounts, and by then nothing has settled for three sweeps.
 */
let vaultReadFailures = 0;

/** WHICH ROUTE CAN SIGN FOR EACH WALLET, across sweeps (SigningRoutes, src/sweep-decision.ts, says why). */
const signingRoutes = new SigningRoutes();

/**
 * WHO THIS KEEPER IS RESPONSIBLE FOR, AND WHERE THAT LIST CAME FROM (L3,
 * src/discovery-lkg.ts). With SIP_SOLANA_DISCOVERY_LKG_MS at 0 — the default —
 * it remembers nothing and a failed listing fails the sweep, as it always has.
 */
const linkDiscovery = new LastKnownGoodDiscovery(config.discoveryLkgMs);

/**
 * THE VOLUME KEEPER'S POLICY BOUNDARIES (src/policy-boundary.ts): where each
 * volume span starts being chargeable, read from the vault owner's own history
 * and kept while nothing new reaches it. The profit keeper never asks.
 */
const policyBoundaries = new PolicyBoundaryBook();
/** The volume keeper's last preview per PROFIT link (src/volume-preview.ts). */
const volumePreviews: PreviewBook = new Map();
const ownerHistoryReader: OwnerHistoryReader = {
  signatures: (owner, options, commitment) =>
    connection.getSignaturesForAddress(
      owner,
      options.before === undefined ? { limit: options.limit } : { before: options.before, limit: options.limit },
      commitment,
    ),
  transaction: (signature, commitment) => readTransaction(connection, signature, commitment),
};

/**
 * THE DOORBELL (src/doorbell.ts): Helius tells this keeper which wallets and
 * vaults moved, so a sweep turns those, whatever has not come to rest, anything
 * new, and a rotating safety slice — instead of every link. Off without
 * SIP_SOLANA_DOORBELL_SECRET, and then every sweep is a full pass, exactly as
 * before it existed.
 */
const doorbell = new Doorbell(config.doorbellSecret !== null);
/**
 * The wallets and vaults of the latest discovery: the only strings a delivery
 * can ring. Replaced whole each sweep, never grown from a delivery.
 */
let knownAddresses: ReadonlySet<string> = new Set<string>();
/** The webhook kept in step with discovery, reporting into the doorbell (src/doorbell-wiring.ts). */
const webhookSync = createDoorbellWebhookSync({
  apiKey: config.heliusApiKey,
  secret: config.doorbellSecret,
  url: config.doorbellUrl,
  doorbell,
  log: (level, message, fields) => log[level](message, fields),
  // ITS REQUESTS ARE ON THE SAME HELIUS BILL: an edit is 100 credits. Counted by
  // verb and then made unchanged (heliusRestFetch); the URL, which carries the
  // key, is never read.
  fetch: heliusRestFetch(rpcUsage),
});
/** The /status block, folded in at render like pendingCarries: the receiver can change it between sweeps. */
const doorbellStatus = (): DoorbellStatus => ({
  ...doorbell.status(Date.now()),
  webhook: webhookSync.status(),
  apiKeySource: config.heliusApiKeySource,
});

/**
 * The Privy signing config, with a fetch that COUNTS each request by kind and
 * then makes it unchanged (privyUsage.fetch, src/privy-usage.ts). It goes in
 * through the fetch every Privy client already takes (pinnedPrivyClient), so
 * the client, its host, its log level and its one attempt are exactly as
 * before. Null in a dry run, as it always was: nothing is read, nothing counted.
 */
const privyConfig: PrivySolanaConfig | null =
  config.signing?.privy === null || config.signing?.privy === undefined ? null : { ...config.signing.privy, fetch: privyUsage.fetch() };

/**
 * THE `privy-address` CUT (src/privy-address-book.ts): each wallet's Privy
 * record by its address, remembered, instead of a listing of the whole app every
 * sweep. Null — today's per-sweep index — unless the token is set, and always
 * null in a dry run, which resolves no signer at all.
 *
 * "SIGNABLE" IS createPrivySolanaSigner's OWN RULE (seatsSignable), with the
 * same two ids: it decides how soon a record is asked again, never whether
 * anything is signed.
 */
const privyBook: PrivyAddressBook | null =
  privyConfig !== null && config.cuts.has("privy-address")
    ? new PrivyAddressBook(privyAddressSource(privyConfig), {
        signable: (entry) => seatsSignable(entry.seats, config.privySignerId ?? undefined, config.privyPolicyId ?? undefined),
      })
    : null;

// SAYING WHAT IS NOT BEING CHECKED, once per process rather than once per sweep.
// Which of the three states the two public ids amount to, and what each costs,
// is seatCheckNotice's (src/seat-check.ts). Names only, never values.
//
// IT USED TO ASK ABOUT THE POLICY ID ALONE, and so said nothing at all about the
// combination that widens signing: a policy id with NO signer id leaves no seat
// to look for, the grant check is skipped with it, and every Solana wallet in
// the app is signed for — while /status showed a populated policy id, which
// reads as "an unbounded seat would be refused". That one pages, because no
// page an operator opens would show it. A dry run holds no privyConfig, so
// nothing here can fire for a keeper that signs nothing.
if (privyConfig !== null) {
  const notice = seatCheckNotice(config.privySignerId, config.privyPolicyId);
  if (notice !== null) {
    log[notice.severity === "critical" ? "error" : "warn"](notice.message, { detail: notice.detail });
    if (notice.alert !== null) alerter.fire(notice.alert);
  }
}

/** One key, so a boot that fixes the pairing resolves what the boot before it raised. */
const AUTHORIZATION_KEY_ALERT_KEY = "privy-authorization-key";

/**
 * Sweeps between re-checks of the pairing. At the default cadence this is about
 * half an hour.
 *
 * ONCE AT BOOT WAS NOT ENOUGH, for two reasons that both end at the same page.
 * A key removed from the quorum, or a quorum whose keys were rotated, leaves
 * /status saying "matches" for as long as the process lives — a statement about
 * a moment that may be days old. And a boot that could not reach Privy leaves
 * "quorum-unreadable" there forever, with nothing ever retrying: the protection
 * this check exists to give silently does not exist. Both are exactly the state
 * an operator opens /status to resolve. One GET per half hour is less than one
 * sweep already spends.
 */
const AUTHORIZATION_KEY_EVERY_SWEEPS = 30;

/**
 * Consecutive unreadable attempts before the UNKNOWN itself is worth an alert.
 *
 * A dropped connection proves nothing about the pairing, and paging for one
 * would teach an operator to ignore this alert — but a pairing that has gone
 * unchecked for half a day is its own fault, because the protection is off.
 */
const AUTHORIZATION_KEY_UNREADABLE_STREAK = 3;

/** Consecutive quorum-unreadable verdicts; any other verdict ends the run. */
let authorizationKeyUnreadable = 0;

/** The verdict last reported, so a change re-fires instead of being deduped by the one before it. */
let lastAuthorizationKeyCheck: AuthorizationKeyCheck | null = null;

/**
 * Establishes, at start-up, whether the configured authorization key belongs to
 * the configured key quorum — and says so in /status next to seatCheck.
 *
 * WHY AT BOOT. Every other signal a keeper emits is healthy when this pairing is
 * wrong: it arms, it takes the claim, it resolves a Privy signer for each wallet,
 * it measures the trades correctly. Privy refuses only at the send, with 401 "No
 * valid authorization signatures were provided" — so without this, the first
 * thing that ever reveals the fault is a settlement that should have moved a
 * user's money, and an operator reading /status before that sees nothing wrong.
 * The check costs one local derivation and one GET, less than the wallet listing
 * every sweep already does.
 *
 * IT ARMS AND REPORTS LOUDLY; IT DOES NOT REFUSE TO ARM. The tempting reading is
 * "a keeper that cannot sign should not pretend to run", and it is wrong here,
 * for three reasons that all point the same way:
 *
 *   * RAILWAY RESTARTS WHAT CRASHES. A refusal to start is not a stop, it is a
 *     loop — and each turn of it takes /status and /health down with the process.
 *     The page an operator would open to read the verdict is the page the
 *     refusal destroys. bin/keeper.mts already refuses to exit mid-run for
 *     exactly this reason, and src/status.ts records that a restart has never
 *     once fixed an upstream.
 *   * IT WOULD STOP A WORKING MONEY PATH TO REPORT A BROKEN ONE. This key gates
 *     the settle send alone. The invest half runs on the local crank keypair and
 *     needs no Privy at all, so a keeper that refuses to arm stops buying
 *     baskets that it could still buy.
 *   * THE VERDICT IS ONLY USEFUL WHERE IT CAN BE READ. Armed, the fault is a
 *     critical alert AND a field on /status AND a line in the start-up banner.
 *     Crash-looping, it is a line in a log that scrolls past a restart.
 *
 * The settle key's own boot refusal (process.exit(2) above) is the opposite
 * precedent and stays that way: a settle key that is readable and wrong is this
 * process acting as the wrong attester, which is not a thing to report and carry
 * on doing.
 *
 * A DRY RUN PERFORMS NO CHECK AT ALL, and keeps its promise: privyConfig is null
 * by construction when no signing secret was read (src/config.ts), so the key is
 * never revealed and no request is made. With no signer id there is nothing to
 * compare against, and seatCheck already pages for that on its own.
 */
async function establishAuthorizationKey(): Promise<void> {
  const signerId = config.privySignerId;
  if (privyConfig === null || signerId === null) return;
  const { verdict, detail } = await authorizationKeyVerdict(privyConfig, signerId);

  // STAMPED WITH THE VERDICT, ALWAYS TOGETHER. A verdict with no date is a claim
  // about an unknown moment, and the one an operator reads mid-outage is exactly
  // the one where "since when?" decides what it means.
  health.signing = { ...health.signing, authorizationKey: verdict.check, authorizationKeyAt: new Date().toISOString() };
  const broken = AUTHORIZATION_KEY_BROKEN.has(verdict.check);
  // A CHANGED CONDITION IS A NEW CONDITION. The alerter dedupes by key alone, so
  // without this a warn raised half an hour ago would swallow the critical that
  // replaces it — the one transition an operator must not miss.
  const changed = lastAuthorizationKeyCheck !== verdict.check;
  if (changed && lastAuthorizationKeyCheck !== null) alerter.clear(AUTHORIZATION_KEY_ALERT_KEY);
  lastAuthorizationKeyCheck = verdict.check;
  authorizationKeyUnreadable = verdict.check === "quorum-unreadable" ? authorizationKeyUnreadable + 1 : 0;
  const context = {
    signerId,
    verdict: verdict.check,
    // PUBLIC KEYS ONLY. This is the comparison an operator has to make by eye,
    // and the private key is in neither half of it.
    derivedPublicKey: verdict.derivedPublicKey,
    registeredPublicKeys: verdict.registered?.map((entry) => entry.publicKey) ?? null,
    nestedKeyQuorumIds: verdict.unresolvedMembers?.keyQuorumIds ?? null,
    memberUsers: verdict.unresolvedMembers?.users ?? null,
    authorizationThreshold: verdict.authorizationThreshold,
    meaning: verdict.meaning,
    next: verdict.next,
    ...(detail === null ? {} : { detail }),
  };
  if (verdict.check === "matches") {
    // On a cadence, only when it CHANGED: a healthy pairing restated every half
    // hour forever is the habit that teaches an operator to skim these lines.
    if (changed) log.info("privy authorization key belongs to the signer quorum", context);
    alerter.clear(AUTHORIZATION_KEY_ALERT_KEY);
    return;
  }
  log[broken ? "error" : "warn"]("privy authorization key", context);
  // UNKNOWN IS NOT WRONG: a dropped connection proves nothing about the pairing,
  // and paging for the first one would teach an operator to ignore this alert.
  // BUT AN UNKNOWN THAT PERSISTS IS ITS OWN FAULT: after this many attempts the
  // protection has simply been off for hours, and that is worth saying once.
  if (verdict.check === "quorum-unreadable" && authorizationKeyUnreadable < AUTHORIZATION_KEY_UNREADABLE_STREAK) return;
  const unknown = verdict.check === "quorum-unreadable";
  alerter.fire({
    key: AUTHORIZATION_KEY_ALERT_KEY,
    severity: broken ? "critical" : "warn",
    title: broken
      ? "The keeper's authorization key does not belong to its signer quorum"
      : unknown
        ? "The keeper has not been able to check its authorization key for hours"
        : "The keeper's authorization key could not be checked against its signer quorum",
    detail: `${verdict.meaning} ${verdict.next}`,
    context: {
      signerId,
      derivedPublicKey: verdict.derivedPublicKey,
      ...(unknown ? { consecutiveAttempts: authorizationKeyUnreadable } : {}),
    },
  });
}

/**
 * The same check again, on a slow cadence, from inside the sweep.
 *
 * A dry run still performs none: establishAuthorizationKey returns before
 * revealing anything when privyConfig is null, and this adds no path around it.
 * Failures are swallowed here on purpose — a check that cannot run must not end
 * a sweep that is moving money, and the next turn of the cadence tries again.
 */
async function reestablishAuthorizationKey(): Promise<void> {
  if (health.sweeps % AUTHORIZATION_KEY_EVERY_SWEEPS !== 0) return;
  try {
    await establishAuthorizationKey();
  } catch (error) {
    log.warn("the authorization key could not be re-checked this sweep", { detail: summarizeUpstreamError(error, { take: 3, maxChars: 400 }) });
  }
}

/** The local derivation, then the quorum read — each failing into its own verdict, neither sending the key. */
async function authorizationKeyVerdict(
  privy: PrivySolanaConfig,
  signerId: string,
): Promise<{ readonly verdict: AuthorizationKeyVerdict; readonly detail: string | null }> {
  let derived: string;
  try {
    // REVEALED INSIDE THE CALL THAT NEEDS IT, and nowhere else. What comes back
    // is a PUBLIC key: safe on the status page, and safe in a log line.
    derived = derivePrivyPublicKey(privy.authorizationKey.reveal());
  } catch (error) {
    if (!(error instanceof AuthorizationKeyUnreadable)) throw error;
    // NOTHING WAS SENT ANYWHERE: a value that is not a key is not a question for Privy.
    return { verdict: unreadableKeyVerdict(), detail: error.message };
  }
  try {
    return { verdict: compareWithQuorum(derived, await readPrivyKeyQuorum(privy, signerId)), detail: null };
  } catch (error) {
    return { verdict: quorumReadVerdict(error, derived), detail: summarizeUpstreamError(error, { take: 3, maxChars: 400 }) };
  }
}

function signingRoute(): string {
  if (config.signing === null) return "not resolved — a dry run reads no signing secret";
  const routes = [
    config.signing.privy !== null ? "privy" : null,
    config.signing.localSignersDir !== null ? "local-keypairs" : null,
  ].filter((route): route is string => route !== null);
  return routes.length === 0 ? "none" : routes.join(" + ");
}

const startedAtMs = Date.now();

/**
 * WHAT /health ANSWERS, AND THE ONE VERDICT THE WATCHDOG EXITS ON: decideHealth
 * over the progress clock (src/status.ts). One function for both, so the bound
 * and the meaning of "moved" cannot drift apart.
 */
const healthNow = (): HealthReport => decideHealth({ now: Date.now(), startedAt: startedAtMs, lastProgressAt, sweepMs: config.sweepMs });

/**
 * What /status serves. An operator must be able to tell a HALTED keeper from a
 * WEDGED one without ssh: `lastSweepAt` moving = alive; an old timestamp with
 * the process up = wedged; the rest says what the last sweep actually saw.
 */
const health: KeeperStatus = {
  service: SERVICE,
  role: config.role,
  startedAt: new Date(startedAtMs).toISOString(),
  program: programId.toBase58(),
  programDeployed: null,
  config: null,
  // Resolved below, once the chain has been read and the claim tried: /status
  // must never say "live" on the strength of the arming flags alone.
  mode: "starting",
  armed: config.armed,
  missingLiveCondition: null,
  sweepMs: config.sweepMs,
  pools: config.pools.size,
  sweeps: 0,
  lastSweepAt: null,
  lastSweepLinks: null,
  lastSweepError: null,
  // WHAT A SWEEP COSTS. Every one of these is filled by the sweep below and by
  // nothing else; they decide nothing and are read by an operator asking how
  // many users fit in one interval. Null means "no sweep has finished yet",
  // which is a different fact from zero.
  skipped: 0,
  consecutiveSkips: 0,
  lastSweepMs: null,
  sweepMsP50: null,
  sweepMsP90: null,
  linksDiscovered: null,
  linksTriaged: null,
  lastSweepPhaseMs: null,
  lastSweepWalk: null,
  // Folded in at render from the transport's own callbacks, which are installed
  // before this object exists; these two are the placeholders that keep the
  // shape whole.
  rpcEndpointInUse: null,
  failovers: 0,
  jupiterCallsPerSweep: null,
  crank: { pubkey: null, lamports: null },
  signing: {
    route: signingRoute(),
    privyAppId: config.privyAppId,
    privySignerId: config.privySignerId,
    privyPolicyId: config.privyPolicyId,
    // Neither id answers "would an unbounded seat be refused?" on its own.
    seatCheck: seatCheck(config.privySignerId, config.privyPolicyId),
    // Established at start-up, below, before the first sweep, and again on a slow
    // cadence: a dry run leaves it "not-checked" forever, having read no key.
    authorizationKey: "not-checked",
    authorizationKeyAt: null,
    secretsRead: config.signing !== null,
    settleKey: config.signing?.settleKey.publicKey.toBase58() ?? null,
    wallets: null,
  },
  history: "not checked yet",
  alerts: describeAlerts(),
  wallets: {},
  // Projected from the carry book at each request, below: a sweep in flight can
  // record one, and a stale copy here would say a restart costs nothing.
  pendingCarries: [],
  doorbell: doorbellStatus(),
};

/**
 * THE RANKINGS, ON A CADENCE OF THEIR OWN.
 *
 * NOT INSIDE THE SWEEP. A leaderboard is a page and a sweep is money: a slow
 * database must never be able to delay a settlement by one query. NOT PER
 * REQUEST either — the route is public and unauthenticated, so what it costs to
 * answer must not depend on who is asking.
 *
 * THE LAST GOOD ONE SURVIVES A BLINKING DATABASE: a failed read leaves the
 * previous payload in place, whose own computedAt says how old it is, and only
 * a keeper that has never computed one reports that it has none.
 */
const LEADERBOARD_REFRESH_MS = 120_000;
/**
 * How often the history verdict is asked again. A SNAPSHOT GOES STALE, and this
 * one is read by a human deciding whether to act: preflight runs once at boot,
 * so an operator who applies a migration while this process is running reads
 * "BROKEN — missing volume_raw" for as long as the container lives, although
 * the writes started working the moment the column existed. It goes wrong in
 * the other direction too — a column dropped under a running keeper leaves
 * /status saying "on" while every row is refused. Five minutes of lag on a line
 * nobody polls per second, against a verdict that is never more than that old.
 */
const HISTORY_RECHECK_MS = 300_000;
let leaderboard: LeaderboardReply = { unavailable: "the rankings have not been computed yet" };
/**
 * The dashboard's `stats` block, served beside the rankings: THE LAST GOOD ONE.
 * A stats read that fails keeps this in place, so a blinking database does not
 * blank the charts; only a keeper that has never read one serves no block, and
 * the page then draws what the rankings alone can say.
 */
let lastGoodStats: (GlobalStats & { readonly computedAt: string }) | null = null;
/** How long a stats block nobody could re-read is still served: a day. */
const STATS_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

/**
 * Re-asks whether history can be written, and says so ONLY WHEN THE ANSWER
 * CHANGES — a line every five minutes repeating what is already on /status is
 * noise, and the transition is the event: somebody fixed the schema, or
 * something broke it.
 */
async function refreshHistoryVerdict(): Promise<void> {
  if (!readModel.enabled) return;
  try {
    const verdict = await readModel.preflight();
    if (verdict.detail === health.history) return;
    const previous = health.history;
    health.history = verdict.detail;
    if (verdict.ok) log.info("the read model became usable", { was: previous, now: verdict.detail });
    else log.warn("the read model stopped being usable", { was: previous, now: verdict.detail });
  } catch (error) {
    // NEVER FATAL, like every other thing this file does with the database:
    // this runs detached, under the process's uncaughtException trap.
    log.warn("the read model verdict could not be re-checked", { detail: summarizeUpstreamError(error) });
  }
}

async function refreshLeaderboard(): Promise<void> {
  if (!readModel.enabled) {
    leaderboard = { unavailable: "this keeper has no database, so it keeps no history to rank" };
    return;
  }
  try {
    const days = await readModel.leaderboardDays();
    if (days === null) {
      if (!("body" in leaderboard)) leaderboard = { unavailable: "the history could not be read" };
      return;
    }
    // AFTER THE DAYS, NEVER BESIDE THEM: one connection is all the settlement
    // writes have while the claim pins the other, so the two reads take turns.
    // AND NEVER IN THE RANKINGS' WAY: a stats read or a stats computation that
    // fails leaves the last good block in place, and the board still refreshes.
    try {
      const statsRows = await readModel.globalStatsRows();
      // ITS OWN computedAt: a kept block is older than the rankings beside it,
      // and the page must end its charts on the day THIS was read — a later
      // day is not a quiet one, it is one nobody has read yet.
      if (statsRows !== null) lastGoodStats = { ...computeGlobalStats(statsRows.settlements, statsRows.investments), computedAt: new Date().toISOString() };
      // A KEPT BLOCK HAS AN AGE LIMIT: past a day, figures nobody could re-read
      // are dropped, and the page says the charts are unavailable instead.
      else if (lastGoodStats !== null && Date.now() - Date.parse(lastGoodStats.computedAt) > STATS_MAX_AGE_MS) lastGoodStats = null;
    } catch (error) {
      log.warn("the global stats could not be computed (the rankings still refresh)", { detail: summarizeUpstreamError(error) });
    }
    const stats = lastGoodStats;
    leaderboard = {
      body: renderLeaderboard({ ...computeLeaderboard(days, new Date()), ...(stats === null ? {} : { stats }) }, sharedRedactor),
    };
  } catch (error) {
    // A PAGE MUST NOT BE ABLE TO KILL THE KEEPER. This runs detached, under the
    // process's uncaughtException trap — which exits.
    log.warn("the leaderboard could not be computed (settlement unaffected)", { detail: summarizeUpstreamError(error) });
  }
}

/**
 * THE `board-timer` CUT (src/board-refresh.ts). Without the token, null: a
 * settle recomputes the rankings at once and the timer recomputes them on its
 * own, as they always have — two recomputes can overlap, and ten settles in one
 * sweep start ten. With it, every trigger goes through one CoalescedRefresh: one
 * recompute in flight, one queued, at most one start every 15 s.
 */
const boardRefresh: CoalescedRefresh | null = config.cuts.has("board-timer") ? new CoalescedRefresh(refreshLeaderboard) : null;

/**
 * THE `jupiter-key` CUT (src/jupiter-pacer.ts). Without the token, null, and
 * every buying turn quotes lite-api.jup.ag keyless and unpaced, as it always
 * has. With it: api.jup.ag and the key when SIP_SOLANA_JUPITER_API_KEY is set
 * (today's host when it is not), and ONE pacer for the process — the budget is
 * the organisation's, so two pacers in one process would each grant what the
 * other already spent.
 */
const jupiterAccess: JupiterAccess | null = config.cuts.has("jupiter-key")
  ? {
      baseUrl: config.jupiterApiKey === null ? LITE_API : KEYED_API,
      apiKey: config.jupiterApiKey,
      pacer: new JupiterPacer({ perMinute: config.jupiterCallsPerMinute }),
    }
  : null;
/**
 * THE `invest-batch` CUT (src/invest-snapshot.ts), and only on a keeper that
 * invests: the volume keeper never runs an invest turn, so it keeps today's
 * vault read whatever the token says. With it, the sweep's one vault batch also
 * reads every turned vault's policy and two ATAs and the four accounts every
 * invest turn reads, and a turn whose at-rest decision sends nothing is decided
 * from that.
 */
const investBatch = config.cuts.has("invest-batch") && profile.invests;
/** What the invest-batch cut has done since boot, for /status (`cuts.investBatch`). Null without it. */
const investBatchStats = investBatch
  ? { sweeps: 0, requests: 0, decidedFromSnapshot: 0, rereadFresh: 0, investedAfterReread: 0, dirtyFresh: 0, batchFailed: 0 }
  : null;
// /status's per-minute view judged against the budget the pacer enforces, not
// the keyless 30 — only under the token, so a keeper without it reads as before.
if (jupiterAccess !== null) jupiterCalls.setBudgetPerMinute(jupiterAccess.pacer.perMinute);

/**
 * /status's two blocks for the cuts, folded in at render like the doorbell's:
 * where the last sweep's links came from, and what each cut that keeps counters
 * has done. Additive: a keeper with no cut and no L3 serves `cuts.on: []` and a
 * discovery block that says "v1, fresh", which is what it always did. And the
 * `ops` block of the SIP_SOLANA_CUTS tokens that are not cuts (opsStatusBlock),
 * which is absent unless one of them is named.
 *
 * AND THE LOSS-CARRY STORE'S, only when SIP_SOLANA_CARRY_STORE is dual or on:
 * ABSENT WHILE `off`, so a keeper without the variable serves the page it served
 * before the store existed, key for key.
 */
function cutsStatusBlocks(): Pick<KeeperStatus, "discovery" | "cuts" | "carryStore" | "ops" | "dispatch"> {
  return {
    discovery: linkDiscovery.status(Date.now()),
    cuts: {
      on: [...config.cuts],
      privyAddressBook: privyBook?.status() ?? null,
      board: boardRefresh?.status() ?? null,
      // Only while the token is on: absent, the block is the one it always was.
      ...(jupiterAccess === null
        ? {}
        : { jupiter: { host: new URL(jupiterAccess.baseUrl).host, keyed: jupiterAccess.apiKey !== null, ...jupiterAccess.pacer.status() } }),
      // ABSENT, NOT NULL, WITHOUT ITS TOKEN: a keeper with no new cut serves the
      // page it served before this one existed, key for key.
      ...(restBook === null ? {} : { restSkip: restBook.status() }),
      ...(investBatchStats === null ? {} : { investBatch: { ...investBatchStats } }),
      ...(crankSender === null ? {} : { explicitSend: crankSender.status() }),
    },
    ...(carryStore === null ? {} : { carryStore: carryStore.status() }),
    ...opsStatusBlock(),
    // THE MIGRATION'S SELECTION, and ABSENT WITHOUT SIP_SOLANA_DISPATCH: the page of before, key for key.
    ...(legacySelector === null ? {} : { dispatch: legacySelector.status() }),
  };
}

/**
 * /status's `ops` block (OpsStatus, src/status.ts), folded in at render: one
 * sub-block per OPS token that keeps state, and NO BLOCK AT ALL while none is
 * named — the page is then byte for byte the one served before these existed.
 */
function opsStatusBlock(): Pick<KeeperStatus, "ops"> {
  const now = Date.now();
  const ops: OpsStatus = {
    ...(watchdog === null
      ? {}
      : {
          progress: {
            exitAfterMs: healthStaleAfterMs(config.sweepMs),
            lastProgressAt: lastProgressAt === null ? null : new Date(lastProgressAt).toISOString(),
            checks: watchdog.checks(),
            exitCode: WATCHDOG_EXIT_CODE,
          },
        }),
    ...(depWatch === null ? {} : { deps: depWatch.status(now) }),
    ...(jupiterAnswers === null ? {} : { jupiterAnswers: jupiterAnswers.status() }),
    ...(claimWatch === null ? {} : { claim: claimWatch.status() }),
    ...(warnDigest === null ? {} : { digest: warnDigest.status() }),
  };
  return Object.keys(ops).length === 0 ? {} : { ops };
}

/** Asks for the rankings to be recomputed: the timer's way in and a settlement's. Never awaited. */
function requestBoard(): void {
  if (boardRefresh === null) void refreshLeaderboard();
  else boardRefresh.request();
}

// The heartbeat, only when a port is provided (Railway injects PORT; the image
// bakes 8080). Started BEFORE the first chain read, so a slow endpoint delays
// the first sweep and never the probe — and, because the probe answers 503 for
// a process that has stopped sweeping, the same slow endpoint must not make it
// answer 503 either: before anything has moved the clock is this process's own
// start, which gives booting the whole bound (decideHealth, src/status.ts).
/**
 * POST /hooks/helius, when the doorbell is on. Authenticated in constant time
 * against the secret, answered at once, ingested after the reply
 * (src/status.ts, receiveDelivery). A delivery it could not read whole makes
 * the next sweep a full pass; a refused one is only counted, because a flood
 * of wrong guesses must not become a flood of log lines.
 */
const hooks = createHooksRoute({
  secret: config.doorbellSecret,
  doorbell,
  known: () => knownAddresses,
  log: (level, message, fields) => log[level](message, fields),
});

if (config.port !== null) {
  const port = config.port;
  const server = createHeartbeatServer(
    httpHandler(
      () =>
        renderStatus({ ...health, ...usageStatus(), pendingCarries: pendingCarries(), rpcEndpointInUse, failovers, doorbell: doorbellStatus(), ...cutsStatusBlocks() }, sharedRedactor),
      healthNow,
      () => leaderboard,
      hooks,
    ),
  );
  // Its request and header timeouts are set by createHeartbeatServer: a slow
  // body must not hold a socket on the server that answers /health.
  server
    .on("error", (error) => {
      log.error("heartbeat server failed", { port, detail: summarizeUpstreamError(error) });
      process.exit(1);
    })
    .listen(port, () => log.info("heartbeat listening", { port }));
}

let verification: LiveVerification | null = null;

/**
 * ONE KEEPER ACTS AT A TIME.
 *
 * Railway overlaps the old and new container on every deploy, so two of these
 * run concurrently as a matter of course. The on-chain frontier already stops a
 * double SETTLE, but nothing stopped two instances wrapping, converting and
 * investing the same vault. A keeper that does not hold the claim DOWNGRADES TO
 * DRY RUN rather than exiting: it keeps sweeping, keeps answering /status, and
 * keeps reporting what it would have done. The key is the worker's derivation
 * over the name "sip-solana-keeper".
 */
const claim: KeeperClaim = new KeeperClaim({
  armed: config.armed,
  // No database, no lock. The keeper acts anyway and says so at startup: an
  // operator running two armed instances without one should know it is on them.
  unenforced: !readModel.enabled,
  attempt: () =>
    // EACH ROLE ITS OWN LOCK (its profile's lockName): the volume keeper never waits
    // on, or takes over, the profit keeper's.
    readModel.claimSingleton(advisoryKeyFor(profile.lockName), () => {
      claim.release();
      // /status stops saying "live" now, not at the next sweep. The remaining
      // turns of a sweep in progress ask isLive() again and act dry.
      health.mode = "dry-run";
      health.missingLiveCondition = liveBlocker();
      log.error("the keeper claim was lost with its database session — acting stops until it is claimed again");
      claimWatch?.lost(Date.now(), "session-dropped");
      alerter.fire({
        key: "claim-lost",
        severity: "critical",
        title: "The keeper lost its single-keeper claim",
        detail: "Its database session dropped. It sweeps as a dry run and retries the claim every sweep.",
      });
    }),
  onTakeover: () => {
    log.info("took over as the acting keeper");
    // THE explicit-send CUT: a new holder buys nothing until the previous one's
    // last transaction can no longer land unseen (the takeover quiet period).
    crankSender?.noteTakeover();
    alerter.clear("not-acting");
    alerter.clear("claim-lost");
    // claim-flap: A SECOND TAKEOVER BY THIS SAME PROCESS IS A REGAIN, and pages
    // (src/claim-watch.ts); a container's first one is a deploy and says nothing.
    const regained = claimWatch?.takeover(Date.now()) ?? null;
    if (regained !== null) alerter.fire(regained);
  },
});

const liveBlocker = (): string | null =>
  // UNDER THE explicit-send CUT, A DRAINING PROCESS IS NOT LIVE: after SIGTERM no
  // turn is handed a key — no settle and no buy starts — while a crank send
  // already on the wire is confirmed. Without the cut crankSender is null and
  // this falls through to the line it always was.
  (crankSender?.draining === true ? "draining after SIGTERM: no new send starts while the last ones confirm" : null) ??
  missingLiveCondition({ armed: config.armed, verification, claimLive: claim.live, lockName: profile.lockName }) ??
  // `on` ACTS ONLY OVER A STORE THAT IS THERE (carryStore.liveBlocker); null otherwise.
  carryStore?.liveBlocker() ??
  null;
/** Never cached by a caller — always asked. */
const isLive = (): boolean => liveBlocker() === null;

/**
 * THE WATCHDOG (src/watchdog.ts), under `watchdog-exit`: once the sweep has not
 * moved for /health's own bound — healthNow, the same verdict on the same clock —
 * it logs, pages once, releases the claim as SIGTERM would, and exits with
 * WATCHDOG_EXIT_CODE so Railway's ON_FAILURE policy starts a fresh process.
 * Started here, before the chain is first read, so a boot that hangs is covered
 * too. Without the token, null: a wedged keeper stays up, as it always has.
 */
const watchdog: Watchdog | null = config.cuts.has("watchdog-exit")
  ? startWatchdog({
      health: healthNow,
      beforeExit: (report) => {
        log.error("watchdog: the sweep has stopped moving — exiting so Railway starts a fresh process", {
          quietForMs: report.quietForMs,
          staleAfterMs: report.staleAfterMs,
          exitCode: WATCHDOG_EXIT_CODE,
        });
        alerter.fire(watchdogExitAlert(report));
        if (config.armed && readModel.enabled && claim.held) claim.release();
      },
      exit: (code) => process.exit(code),
    })
  : null;

function applySnapshot(snapshot: ChainSnapshot): void {
  // THIS READ'S ANSWER, null when it could not say, never an earlier sweep's.
  // A remembered "not deployed" once kept a dead RPC looking like a healthy
  // zero-link sweep (status.ts documents null for exactly this).
  health.programDeployed = snapshot.programDeployed;
  if (!snapshot.configReadable) {
    // The last config that was READ stays on show, because null would claim it
    // does not exist. Its balance is not served as current, though: a crank
    // that empties during an RPC outage must not look funded. Nuvem's
    // supervisor nulled it the same way.
    health.crank = { pubkey: health.crank.pubkey, lamports: null };
    return;
  }
  const onChain = snapshot.config;
  const named = (key: PublicKey): string | null => (key.equals(PublicKey.default) ? null : key.toBase58());
  health.config =
    onChain === null
      ? null
      : {
          address: onChain.address.toBase58(),
          authority: onChain.authority.toBase58(),
          attester: onChain.attester.toBase58(),
          keeper: named(onChain.keeper),
          pendingAuthority: named(onChain.pendingAuthority),
          paused: onChain.paused,
          version: onChain.version,
        };
  // THE CRANK IS WHOEVER THE CHAIN AUTHORIZES, not whoever this process holds a
  // key for: wrap_sol, convert and invest refuse every other signer.
  health.crank = {
    pubkey: health.config?.keeper ?? null,
    lamports: snapshot.crankLamports === null ? null : snapshot.crankLamports.toString(),
  };
}

/**
 * Armed only: is the settle key the deployment's attester AND keeper? Returns the
 * new verification; the caller stores it, so the comparison below still sees the
 * previous one and logs only transitions.
 */
function verifyLive(snapshot: ChainSnapshot, atStartup: boolean): LiveVerification | null {
  if (config.signing === null) return null;
  const next = verifySettleKey(config.signing.settleKey.publicKey, snapshot);
  if (next.kind === "mismatch") {
    if (atStartup) {
      // READABLE AND WRONG REFUSES TO START. Every attestation would be refused
      // with WrongAttester, or every crank by may_crank: a keeper that can only
      // burn fees failing is a configuration error, not a degraded mode.
      log.error("refusing to start: the settle key is not the deployment's attester and keeper", { detail: next.detail });
      process.exit(2);
    }
    // Mid-run the config changed under us. Exiting would take /status down with
    // it, so the keeper stays up, stays dry, lets another instance have the
    // claim, and says so as loudly as it can.
    alerter.fire({
      key: "settle-key-mismatch",
      severity: "critical",
      title: "The settle key no longer matches the on-chain ProtocolConfig",
      detail: next.detail,
    });
    if (readModel.enabled && config.armed && claim.held) {
      claim.release();
      claimWatch?.lost(Date.now(), "settle-key-mismatch");
    }
  } else {
    alerter.clear("settle-key-mismatch");
  }
  if (verification?.kind !== next.kind) {
    if (next.kind === "verified") {
      log.info("settle key verified against the on-chain ProtocolConfig", { settleKey: config.signing.settleKey.publicKey.toBase58() });
    } else {
      log.warn("settle key not verified", { result: next.kind, detail: next.detail });
    }
  }
  return next;
}

let cycleRunning = false;
/** Whether the sweep in flight has selected links it has not finished turning. */
let selectionOutstanding = false;
/** When the sweep now running began, so a skip can say how long it has been waiting. */
let cycleStartedAt: number | null = null;
/**
 * The last SWEEP_TIMES_KEPT sweep durations, for the percentiles on /status.
 * BOUNDED: this process runs for weeks, and an unbounded array is a leak in the
 * one process that must not be restarted to be fixed.
 */
const sweepTimes = createSweepTimes();

/**
 * What the sweep that just ended cost, written to /status and judged against the
 * interval it has to fit in.
 *
 * CALLED FROM THE `finally` AND AFTER `cycleRunning` IS CLEARED. Everything here
 * is measurement: if any of it threw while the flag was still set, it would
 * wedge the keeper in exactly the way this instrumentation exists to report.
 */
function noteSweepCost(
  elapsedMs: number,
  phases: KeeperStatus["lastSweepPhaseMs"],
  linksTriaged: number | null,
  walkAtStart: WalkCounters,
): void {
  health.lastSweepMs = elapsedMs;
  sweepTimes.add(elapsedMs);
  health.sweepMsP50 = sweepTimes.p50();
  health.sweepMsP90 = sweepTimes.p90();
  health.lastSweepPhaseMs = phases;
  health.linksTriaged = linksTriaged;
  health.jupiterCallsPerSweep = jupiterCalls.sweepTotal();
  health.lastSweepWalk = walkSweepReport(walkAtStart, walkCache.counters, walkCache.size);
  // A SWEEP FINISHED, so the run of skipped ones is over. The total stands: it
  // is the count of users that went unserved, and it is not undone by a later
  // sweep going through.
  health.consecutiveSkips = 0;
  alerter.clear(SWEEP_SKIPPED_ALERT_KEY);
  // AND THE WARNING THAT COMES BEFORE THE SKIP. Fired from p90 rather than from
  // this one sweep, so a single slow pass does not page and a trend does.
  const slow = sweepSlowAlert({ p90Ms: health.sweepMsP90, sweepMs: config.sweepMs, samples: sweepTimes.length });
  if (slow === null) alerter.clear(SWEEP_SLOW_ALERT_KEY);
  else alerter.fire(slow);
  // WHAT THE SWEEP ASKED OF ITS PROVIDERS, frozen as the "last sweep" figures;
  // the doorbell's delivered transactions are billed too, one credit each.
  // LAST IN THIS FUNCTION, so nothing added here can keep the skip run above
  // from ending or the sweep-slow warning from being asked.
  rpcUsage.webhookEventsSeen(doorbell.deliveryCounts().accepted);
  rpcUsage.endSweep();
  privyUsage.endSweep();
  // AND WHETHER THIS SERVICE IS BURNING THROUGH ITS SHARE OF THE CREDITS. Off
  // until SIP_SOLANA_CREDIT_BUDGET_DAY is set: with no budget creditBurnAlert
  // neither fires nor clears.
  const burn = creditBurnAlert(rpcUsage.report(Date.now()));
  if (burn.fire !== null) alerter.fire(burn.fire);
  else if (burn.clear) alerter.clear(CREDIT_BURN_ALERT_KEY);
  // AND THE REST OF L1a's ALERTS, each only under its token. LAST, for the same
  // reason the meters are: nothing added here can keep anything above from running.
  noteOpsAfterSweep();
}

/** One of usage-alerts.ts's decisions, applied: raise it, or clear its key. */
function applyDecision(key: string, decision: AlertDecision): void {
  if (decision.fire !== null) alerter.fire(decision.fire);
  else if (decision.clear) alerter.clear(key);
}

/**
 * What the rest of L1a asks once a sweep has ended, failed or not: the
 * dependencies that are down (dep-down), the four alerts on L1a's counters
 * (privy-burn, privy-index, rpc-fallback, jupiter-budget), and whether the
 * day's digest is due (warn-digest). Each line asks its token first; with none
 * named this function does nothing at all.
 */
function noteOpsAfterSweep(): void {
  const now = Date.now();
  if (depWatch !== null) {
    const down = depDownAlerts(depWatch, now);
    for (const key of down.clear) alerter.clear(key);
    for (const page of down.fire) alerter.fire(page);
  }
  if (config.cuts.has("privy-burn")) applyDecision(PRIVY_BURN_ALERT_KEY, privyBurnAlert(privyUsage.report(now)));
  if (config.cuts.has("privy-index")) applyDecision(PRIVY_INDEX_ALERT_KEY, privyIndexAlert(privyUsage.report(now)));
  if (config.cuts.has("rpc-fallback")) {
    applyDecision(
      RPC_FALLBACK_ALERT_KEY,
      rpcFallbackAlert({ endpointInUse: rpcEndpointInUse, endpointSinceMs: rpcUsage.report(now).endpointSinceMs, endpoints: config.rpcUrls.length }),
    );
  }
  if (config.cuts.has("jupiter-budget") && jupiterAnswers !== null) {
    applyDecision(
      JUPITER_BUDGET_ALERT_KEY,
      jupiterBudgetAlert({
        usage: jupiterCalls.report(now),
        http429ThisSweep: jupiterAnswers.http429ThisSweep(),
        lastHttp429At: jupiterAnswers.lastHttp429At(),
        live: isLive(),
        now,
      }),
    );
  }
  // THE DIGEST ON ITS OWN SENDER, cleared first so a day's message is never
  // read as the "(x2)" repeat of yesterday's.
  if (warnDigest !== null && digestAlerter !== null && warnDigest.due(now)) {
    digestAlerter.clear(DIGEST_ALERT_KEY);
    digestAlerter.fire(warnDigest.take(now));
  }
}

/**
 * THE LEGACY KEEPER'S SHARE OF A SELECTION, under SIP_SOLANA_DISPATCH: the
 * sweep's one read of vault_work (and its receipt), then the selected turns split
 * into the ones still this keeper's and the ones it leaves alone
 * (src/dispatch-select.ts). A READ THAT FAILED LEAVES EVERY TURN ALONE: a delay,
 * never a vault acted on by two actors. Each turn left alone says so on /status
 * — its row, and a signing route that is not counted as signable — and is not
 * told to the doorbell, which keeps selecting it at no cost.
 */
async function legacyTurns<T extends { readonly link: { readonly vault: string; readonly wallet: string; readonly managed: ManagedLink } }>(
  selector: LegacySelector,
  selected: readonly T[],
  links: readonly ManagedLink[],
  live: boolean,
): Promise<readonly T[]> {
  // THE VAULTS WHOSE LOSS CARRY LIVES ONLY IN THIS PROCESS'S MEMORY: a worker could
  // not see it, so the receipt names them and no handover arms them. Without a
  // carry store, every carry memory holds; under `dual`, one whose Postgres write
  // failed — that write is best-effort; under `on`, none: the database is first.
  const carryVaults = carryOnlyInMemoryVaults(links, settleCarries, carryStore === null ? null : carryStore.memoryOnlyLinks(settleCarries));
  const read = await selector.read({ live, carryVaults, now: Date.now() });
  if (read.ok) {
    alerter.clear(LEGACY_SELECT_ALERT_KEY);
  } else {
    log.warn("vault_work could not be read; this sweep settles and invests nothing", { detail: read.detail, consecutive: read.streak });
    if (read.streak === LEGACY_SELECT_CRITICAL_STREAK) alerter.clear(LEGACY_SELECT_ALERT_KEY);
    alerter.fire(legacySelectAlert(read.streak, read.detail));
  }
  const { act, left } = partitionLegacyTurns(selected, (turn) => turn.link.vault, read.ok ? read.view : null);
  const at = new Date().toISOString();
  for (const { turn, reason } of left) {
    const wallet = turn.link.wallet;
    const route = `not resolved (left alone: ${reason})`;
    signingRoutes.set(wallet, route);
    health.wallets[wallet] = { settle: "LEFT_ALONE", invest: "LEFT_ALONE", signing: route, detail: leftAloneDetail(reason, selector.mode), at };
  }
  const leftVaults = new Set(left.map(({ turn }) => turn.link.vault));
  selector.noteLeft(
    left.map(({ turn, reason }) => ({ wallet: turn.link.wallet, vault: turn.link.vault, reason })),
    carryVaults.filter((vault) => leftVaults.has(vault)),
  );
  changes.change(
    "legacy-select",
    left.length === 0 ? "every selected vault is the legacy keepers'" : "vaults left alone: not the legacy keepers'",
    left.length === 0 ? {} : { leftAlone: left.length, reasons: [...new Set(left.map(({ reason }) => reason))].sort() },
  );
  return act;
}

async function sweep(): Promise<void> {
  if (cycleRunning) {
    // COUNTED AND ESCALATED, WHICH IT NEVER USED TO BE. This was one log line:
    // no counter, no field on /status, no alert. A keeper whose sweeps are all
    // being dropped looks exactly like a keeper with nothing to do — `sweeps`
    // stops climbing in both cases, and /health reads the progress clock, which
    // a skip does not touch. It has already happened once, for hours (see the
    // per-wallet catch below, where the turn that threw left this flag set).
    health.skipped += 1;
    health.consecutiveSkips += 1;
    const waitingMs = cycleStartedAt === null ? null : Date.now() - cycleStartedAt;
    log.warn("cycle skipped: the previous one is still running", {
      skipped: health.skipped,
      consecutiveSkips: health.consecutiveSkips,
      runningForMs: waitingMs,
    });
    // The alerter dedupes by key alone, so the standing warning is cleared at
    // the escalation or it would swallow the critical — vaultReadAlert's rule.
    if (health.consecutiveSkips === SWEEP_SKIPPED_CRITICAL_STREAK) alerter.clear(SWEEP_SKIPPED_ALERT_KEY);
    alerter.fire(
      sweepSkippedAlert(
        health.consecutiveSkips,
        `the previous sweep has been running for ${waitingMs ?? "an unknown number of"} ms, over a ${config.sweepMs} ms interval; ` +
          "nobody in this pass was settled",
      ),
    );
    return;
  }
  cycleRunning = true;
  const cycleBeganAt = Date.now();
  cycleStartedAt = cycleBeganAt;
  // ZEROED AT THE TOP, READ IN THE `finally`: one sweep runs at a time, so the
  // count between those two points is this sweep's.
  jupiterCalls.startSweep();
  // AND THE 429s JUPITER ANSWERS THIS SWEEP (jupiter-budget, dep-down), on the same terms.
  jupiterAnswers?.startSweep();
  // AND THE RPC AND PRIVY METERS' PER-SWEEP COUNTS, on the same terms.
  rpcUsage.startSweep();
  privyUsage.startSweep();
  // The walk cache counts since boot; the `finally` reports this sweep's difference.
  const walkAtStart = walkCache.counters;
  // WHERE THIS SWEEP'S MILLISECONDS WENT. Declared out here so the `finally`
  // can publish them even when the sweep throws halfway: a failed sweep's
  // shape is the most interesting one there is.
  let chainReadMs = 0;
  let discoveryMs = 0;
  let vaultReadMs = 0;
  let triageMs = 0;
  let expensiveMs = 0;
  let privyIndexMs = 0;
  let linksTriaged = 0;
  // /health's clock. A sweep that throws below still counts as a sweep that
  // happened, so an endpoint outage is reported by sweep-failed and /status,
  // never by restarting the container. Stamped again at every link's turn and
  // at every RPC answer, so a sweep that is slow is not read as one that is
  // wedged — the restart that would follow only re-runs the same slow work.
  noteProgress();
  try {
    const chainReadAt = Date.now();
    const snapshot = await readChainSnapshot(connection, program);
    chainReadMs = Date.now() - chainReadAt;
    applySnapshot(snapshot);
    if (snapshot.errors.length > 0) changes.change("chain-read", "chain read incomplete", { errors: snapshot.errors }, "warn");
    else changes.change("chain-read", "chain read complete", {});

    if (config.armed) {
      verification = verifyLive(snapshot, false);
      // CLAIMED ONLY ONCE VERIFIED. The handover: the instance meant to be
      // acting takes over as soon as the outgoing one lets go — but an instance
      // that could not act must not sit on the claim another one could act with.
      if (verification?.kind === "verified") {
        await claim.ensure();
        if (!claim.live) {
          notActingSweeps += 1;
          const stale = notActingSweeps >= NOT_ACTING_CRITICAL_AFTER;
          alerter.fire({
            key: "not-acting",
            severity: stale ? "critical" : "warn",
            title: "Armed, but another keeper holds the claim",
            detail: stale
              ? `This instance has been sweeping in dry run for ${notActingSweeps} sweeps and has charged nothing. ` +
                "No other instance should be holding the claim for this long: its lock is stale."
              : "This instance is sweeping in dry run. If no other instance is running, its lock is stale.",
          });
        } else if (notActingSweeps > 0) {
          notActingSweeps = 0;
          alerter.clear("not-acting");
        }
      }
    }
    // A CARRY STORE THAT WAS NOT READY, OR NOT SEEDED, IS ASKED AGAIN, every sweep
    // until it is: an operator who runs setup-read-model, or a database that comes
    // back, should not need a restart. Once both are done this asks nothing.
    if (carryStore !== null) await carryStore.prepare(settleCarries);
    // For this sweep's own line and /status only. Every turn below asks
    // isLive() again before it is handed a key.
    const liveAtStart = isLive();
    health.mode = liveAtStart ? "live" : "dry-run";
    health.missingLiveCondition = liveBlocker();

    // THE PROGRAM NOT BEING THERE IS A STATE, NOT AN ERROR. Before Tuesday's
    // deploy there is no sip-vault on mainnet: no config, no links. The sweep
    // still runs, says so once, and reports zero links rather than asking a
    // public endpoint for every account of a program that does not exist.
    //
    // DECIDED ON THIS SWEEP'S READ. When the read could not say (null),
    // discovery runs anyway: against a dead endpoint it throws, and the sweep
    // fails loudly with sweep-failed, as Nuvem's did. It no longer counts a
    // healthy sweep of zero links.
    let links: ManagedLink[] = [];
    // WHETHER THIS SWEEP'S LIST IS A LISTING (L3). A last-known-good sweep turns
    // everybody it remembers, re-read fresh, but it has not SEEN the program's
    // accounts, so the webhook's address list does not follow it (below).
    let listedFresh = true;
    if (snapshot.programDeployed === false) {
      changes.change("program", "the program is not deployed on this cluster — nothing to sweep", { program: programId.toBase58() }, "warn");
    } else {
      if (snapshot.programDeployed === true) changes.change("program", "the program is deployed", { program: programId.toBase58() });
      const discoveryAt = Date.now();
      // THE LISTING: today's getProgramAccounts, or — under the gpa-v2 cut —
      // Helius's paginated V2 with today's call as the fallback in this same
      // sweep (src/discovery.ts). V2 goes over trackedFetch, the Connection's own
      // transport, so it inherits the failover and moves /health's clock.
      const list = (): Promise<DiscoveryReport> =>
        config.cuts.has("gpa-v2")
          ? discoverLinksPreferringV2(connection, programId, TRADING_LINK_DISC, trackedFetch)
          : discoverLinks(connection, programId, TRADING_LINK_DISC).then((found) => ({ links: found, method: "v1" as const, requests: 1 }));
      // AND L3 AROUND IT: with SIP_SOLANA_DISCOVERY_LKG_MS at 0 this is the
      // listing and nothing else, its error propagating unchanged.
      const found = await linkDiscovery.discover(
        list,
        (addresses) => rereadLinks(connection, addresses, programId, TRADING_LINK_DISC),
        Date.now(),
      );
      links = found.links;
      discoveryMs = Date.now() - discoveryAt;
      if (found.source === "lkg") {
        listedFresh = false;
        const detail = summarizeUpstreamError(found.failure, { take: 3, maxChars: 500 });
        log.warn("the link listing failed; this sweep turns the last-known-good list, every link re-read fresh", {
          links: links.length,
          lkgAgeMs: found.lkgAgeMs,
          consecutiveFailures: found.consecutiveFailures,
          detail,
        });
        // WARN, THEN CRITICAL ONCE THE LIST IS OLDER THAN 10 MINUTES: an
        // escalation breaks through the alerter's dedupe on its own (src/alerts.ts).
        alerter.fire(discoveryStaleAlert(found.consecutiveFailures, found.lkgAgeMs ?? 0, detail));
      } else {
        alerter.clear(DISCOVERY_STALE_ALERT_KEY);
        // WHICH CALL LISTED THEM, said once per change: a keeper that fell back
        // to V1 is paying ten credits a sweep again, and that should be visible.
        if (config.cuts.has("gpa-v2")) {
          changes.change(
            "discovery-method",
            found.method === "v2" ? "discovery through getProgramAccountsV2" : "discovery fell back to getProgramAccounts",
            found.fallbackReason === undefined ? {} : { reason: found.fallbackReason },
            found.method === "v2" ? "info" : "warn",
          );
        }
      }
    }
    // FOUND, WHICH IS NOT THE SAME AS SERVED. `linksTriaged` below counts the
    // ones that actually got a turn; when the two differ somebody was not
    // looked at, and that is the number the owner needs before he has users.
    // Under the doorbell they differ by design, and /status's doorbell.lanes
    // says why each turned link was turned.
    health.linksDiscovered = links.length;

    // THE AUTHORITY'S EMERGENCY SWITCH, from this sweep's config read. While it
    // is on, every turn below rests as PAUSED; said once here, on change. Read
    // BEFORE the selection, because its release rings no wallet's bell and so
    // makes the doorbell turn everyone.
    const protocolPaused = snapshot.config?.paused === true;

    // WHO THIS SWEEP TURNS (src/doorbell.ts). Everything discovered is still
    // KNOWN — linkWallets, health.linksDiscovered, the addresses a delivery can
    // ring, the webhook's address list — and only the turns below are a
    // selection. A full pass when the doorbell is off or not trusted, on the
    // first sweep, on a takeover, on the protocol's unpause and after a lost
    // delivery; otherwise the bell, whatever has not come to rest, anything new
    // or not yet watched, and a rotating safety slice.
    const doorLinks: (DoorLink & { readonly managed: ManagedLink })[] = links.map((link) => ({
      link: link.linkAddress.toBase58(),
      wallet: link.wallet.toBase58(),
      vault: link.vault.toBase58(),
      managed: link,
    }));
    knownAddresses = new Set(doorLinks.flatMap((link) => [link.wallet, link.vault]));
    const selection = doorbell.select({ links: doorLinks, now: Date.now(), sweepMs: config.sweepMs, protocolPaused, live: liveAtStart });
    // AND, UNDER SIP_SOLANA_DISPATCH, ONLY THE ONES THAT ARE STILL THE LEGACY
    // KEEPERS' (legacyTurns below): a vault vault_work hands to the queue is not
    // turned at all — no vault read, no Privy lookup, no settle, no invest.
    // Without the variable this is the selection, untouched.
    const turns = legacySelector === null ? selection.turns : await legacyTurns(legacySelector, selection.turns, links, liveAtStart);
    // Set until the loop below has turned every selected link; a sweep that
    // throws before then asks the next one to turn everybody.
    selectionOutstanding = turns.length > 0;
    changes.change(
      "doorbell-pass",
      selection.fullReason === null ? "doorbell: turning a selection" : "doorbell: full pass",
      selection.fullReason === null ? {} : { reason: selection.fullReason },
    );
    // THE WEBHOOK FOLLOWS THE DISCOVERY, detached and one at a time: a slow
    // Helius API delays the webhook, never a settle. Only the acting keeper
    // manages it; with no links there is nothing to watch, and an empty list is
    // never sent over a full one.
    // AND ONLY A LISTED ONE (L3). A remembered list is the last listing minus
    // whatever closed since — the webhook already watches the last listing — and
    // it is blind to anything created since. An edit made from it buys nothing
    // the next fresh listing will not, costs 100 credits, and lands while the
    // provider is already refusing reads.
    if (knownAddresses.size > 0 && listedFresh) void webhookSync.tick({ acting: liveAtStart, addresses: [...knownAddresses], now: Date.now() });
    // EVERY VAULT THE LINKS NAME, IN ONE REQUEST. Each settle turn read its own
    // vault, and the history mirror read it again after every SETTLED.
    //
    // ONE REFUSED READ NO LONGER ENDS THE SWEEP. A throttled getMultipleAccounts
    // fell to the sweep's own catch below: nothing settled for anybody, and one
    // hiccup from a public endpoint paged critical. The sweep now degrades to a
    // read per link, so every link whose vault IS readable still settles, and the
    // failure warns — pages only once it keeps happening (vaultReadAlert).
    //
    // NOT A READ PER LINK ON A GOOD SWEEP: the batch exists to remove exactly
    // those requests, and it fails hardest when the endpoint is already
    // throttling. The fallback is lazy and cached, so a degraded sweep reads each
    // distinct vault at most once, and only for the links it actually reaches.
    let vaults: ReadonlyMap<string, VaultState | null> | null = null;
    /**
     * THE invest-batch CUT: each turned vault's at-rest invest state, read in the
     * same batch as the vaults. Null without the cut, and null when the batch
     * failed — the degraded path below then runs with no snapshot at all, which
     * is today's degraded path exactly.
     */
    let investSnapshots: ReadonlyMap<string, InvestSnapshot> | null = null;
    /**
     * Vaults this sweep has already settled into, or sent anything for. Their
     * snapshot was read before that money moved, so their later invest turns
     * read fresh — "settle, then buy in the same turn" keeps working.
     */
    const dirtyVaults = new Set<string>();
    const vaultReadAt = Date.now();
    try {
      // ONLY THE VAULTS THIS SWEEP TURNS: a vault nobody is turned for is a read nobody uses.
      if (investBatch) {
        const state = await readSweepState(connection, program, turns.map((turn) => turn.link.managed.vault));
        vaults = state.vaults;
        investSnapshots = state.invest;
        if (investBatchStats !== null) {
          investBatchStats.sweeps += 1;
          investBatchStats.requests += state.requests;
        }
      } else {
        vaults = await readVaults(program, turns.map((turn) => turn.link.managed.vault));
      }
      vaultReadFailures = 0;
      alerter.clear(VAULT_READ_ALERT_KEY);
    } catch (error) {
      vaultReadFailures += 1;
      if (investBatchStats !== null) investBatchStats.batchFailed += 1;
      const detail = summarizeUpstreamError(error, { take: 3, maxChars: 500 });
      log.warn("the batched vault read failed; this sweep reads one vault per link instead", { links: turns.length, detail });
      // The alerter dedupes by key alone, so the standing warning is cleared at
      // the escalation or it would swallow the critical, as invest-failed does.
      if (vaultReadFailures === VAULT_READ_CRITICAL_STREAK) alerter.clear(VAULT_READ_ALERT_KEY);
      alerter.fire(vaultReadAlert(vaultReadFailures, detail));
    } finally {
      // TIMED ON BOTH PATHS. A read that was refused is the expensive one — it
      // waited for a timeout and then left every link to a read of its own —
      // and a phase timing that only counted the good case would hide it.
      vaultReadMs = Date.now() - vaultReadAt;
    }
    /**
     * The degraded path's read, cached per distinct vault for this sweep. The
     * promise is awaited by the turn that creates it, so a rejection is always
     * handled; links sharing that vault get the same answer without asking again.
     *
     * NULLABLE, LIKE THE BATCH IT STANDS IN FOR. readVaultNullable answers null
     * for "the chain has no account there" and throws for "the request failed" —
     * opposite conditions that Anchor's fetch() collapses into one throw.
     */
    const degradedReads = new Map<string, Promise<VaultState | null>>();
    const vaultForLink = (link: ManagedLink): Promise<VaultState | null> => {
      const key = link.vault.toBase58();
      const reading = degradedReads.get(key) ?? readVaultNullable(program, link.vault);
      degradedReads.set(key, reading);
      return reading;
    };

    // The pause switch itself was read above, before the selection.
    if (snapshot.config !== null) {
      changes.change(
        "protocol-paused",
        protocolPaused ? "the protocol is paused by its authority — settle and invest rest for every vault" : "the protocol is not paused",
        {},
        protocolPaused ? "warn" : "info",
      );
    }

    // SIGNERS ONLY WHEN ARMED. Resolving a wallet's signer needs the Privy app
    // secret or a key directory, and a dry run holds neither.
    let localSigners: LocalSigners | null = null;
    if (config.signing?.localSignersDir) {
      localSigners = loadLocalSigners(config.signing.localSignersDir);
      if (localSigners.problem !== null) changes.change("local-signers", "local signers unavailable", { detail: localSigners.problem }, "warn");
      for (const file of localSigners.skipped) changes.change(`signer-file:${file}`, "signer file is not a JSON array secret key; skipped", { file }, "warn");
    }
    // ONE Privy scan for the whole sweep. Resolving per wallet made N full
    // paginated scans for N linked wallets. A failure here is not fatal: each
    // wallet falls back to its own lookup, and a local keypair still works.
    let privyIndex: ReadonlyMap<string, PrivyWalletEntry> | undefined;
    /**
     * UNDER THE privy-address CUT: the wallets whose record could not be read
     * this sweep. Their turns get "none (privy lookup failed)", exactly what a
     * failed per-wallet fallback gives them today — and never a listing of their own.
     */
    let privyLookupFailed: ReadonlyMap<string, string> = new Map();
    if (privyConfig !== null && turns.length > 0) {
      // TIMED ON BOTH PATHS, like the vault read: a listing that failed after
      // paging for a minute is the expensive case, not the free one. And on
      // both ROUTES: under the privy-address cut this phase is the book's
      // prepare, which lists nothing per sweep, so it is timed here and never
      // reported as an index build (privyUsage.indexBuilt stays the listing's);
      // its own lookups and failures are in /status's cuts.privyAddressBook.
      const privyIndexAt = Date.now();
      /** Whether this sweep's listing was built — null under the book, which built none. */
      let indexBuilt: boolean | null = null;
      try {
        if (privyBook !== null) {
          // ONLY THE WALLETS A TURN WILL RESOLVE: the turn loop's own condition
          // (settlesThisVault), so the book asks Privy about nobody the sweep
          // would not have asked about. Never throws: a failure is the wallet's.
          const resolving = turns
            .filter(({ link }) => vaults === null || resolvesSignerFor(profile, vaults.get(link.vault)?.skimMode))
            .map(({ link }) => link.wallet);
          const view = await privyBook.prepare(resolving, Date.now());
          privyIndex = view.index;
          privyLookupFailed = view.failed;
        } else {
          indexBuilt = false;
          try {
            privyIndex = await buildPrivySolanaIndex(privyConfig);
            indexBuilt = true;
          } catch (error) {
            log.warn("privy wallet index failed; falling back to per-wallet lookups", { detail: summarizeUpstreamError(error) });
          }
        }
      } finally {
        privyIndexMs = Date.now() - privyIndexAt;
        if (indexBuilt !== null) privyUsage.indexBuilt(privyIndexMs, indexBuilt);
        turnTimers.record("privyIndexMs", privyIndexMs);
      }
    }

    // THE CRANK PAYS FOR EVERY MOVE and nothing was watching it. Empty, every
    // invest turn fails for every vault at once, in a loop, with /health still
    // green. Read from config.keeper's balance, reported in /status, and warned
    // about BEFORE it bites.
    const keeperKey = health.crank.pubkey;
    // THE PROFIT KEEPER'S CONDITION (crankAlert): it is the one that spends the crank.
    // The volume keeper holds the same key and never cranks, so it does not page for it too.
    if (profile.crankAlert && keeperKey !== null && snapshot.crankLamports !== null) {
      const crankLamports = snapshot.crankLamports;
      if (crankLamports < 20_000_000n) {
        changes.change("crank-balance", "crank is running low — investing stops when it empties", { crank: keeperKey, lamports: crankLamports });
        alerter.fire({
          key: "crank-low",
          severity: crankLamports < 5_000_000n ? "critical" : "warn",
          title: "The keeper's crank is running out of SOL",
          detail: `${crankLamports} lamports left; investing stops for every vault when it empties`,
          context: { crank: keeperKey },
        });
      } else {
        changes.forget("crank-balance");
        alerter.clear("crank-low");
      }
    }

    health.alerts = describeAlerts();
    health.sweeps += 1;
    health.lastSweepAt = new Date().toISOString();
    health.lastSweepLinks = links.length;
    health.lastSweepError = null;
    alerter.clear("sweep-failed");
    // Routes persist across sweeps (signingRoutes above); a wallet that is no
    // longer discovered stops being counted.
    const discoveredWallets = new Set(doorLinks.map((link) => link.wallet));
    signingRoutes.prune(discoveredWallets);
    // And the Privy records the book holds for wallets nobody links any more.
    privyBook?.prune(discoveredWallets);
    // So does what the walks kept for it.
    walkCache.prune(discoveredWallets);
    // And a memo for a link this sweep no longer discovered (rest-skip): keyed by link.
    restBook?.prune(new Set(doorLinks.map((link) => link.managed.linkAddress.toBase58())));
    /** Each vault's invest turns for THIS sweep, folded; the streaks are applied once from it below. */
    const investSweep = new Map<string, VaultInvestSweep>();
    /**
     * The leg-fee keys each vault's turns raised THIS sweep — only for vaults
     * with a turn that got as far as reading a leg mint. Reconciled per vault
     * once below (legFeeBook.fold).
     */
    const legFeeLooked = new Map<string, Set<string>>();
    // THE LINK-TO-WALLET PAIRING /status NEEDS, from the set this sweep just
    // discovered. The carry book is keyed by link; an operator reads wallets.
    // Replaced, not merged, so an unlinked wallet stops being named.
    linkWallets.clear();
    for (const link of links) linkWallets.set(link.linkAddress.toBase58(), link.wallet.toBase58());
    log.info("sweep", {
      links: links.length,
      turned: turns.length,
      ...(legacySelector === null ? {} : { leftAlone: legacySelector.status().leftAloneLastSweep }),
      ...(selection.fullReason === null ? { lanes: selection.lanes } : { fullPass: selection.fullReason }),
      localKeypairs: localSigners?.signers.size ?? 0,
      mode: liveAtStart ? "live" : "dry-run",
      ...(liveAtStart ? {} : { missingLiveCondition: health.missingLiveCondition }),
    });

    for (const { link: door, lane } of turns) {
      const link = door.managed;
      // THE SWEEP MOVED: another turn is starting. A pass whose turns keep
      // beginning is working, however long the whole pass takes; one wedged
      // inside a turn stops stamping here and /health answers 503, as it should.
      noteProgress();
      const turnAt = Date.now();
      const wallet = link.wallet.toBase58();
      const vaultAddr = link.vault.toBase58();
      // WHICH LANE THIS TURN'S TIME BELONGS TO, and it cannot be known until the
      // settle has answered: the cheap probe and the window walk are the same
      // call from out here. Null while it is unknown — a turn that threw before
      // an outcome is charged to the expensive lane, which over-states that lane
      // and never under-states it.
      let settleOutcome: SettleOutcome | null = null;
      // WHICH HALF OF THE TURN IS RUNNING, for the catch below. One try wraps the
      // settle AND the invest, so a catch that assumed "settle" would page "a
      // settlement turn threw" for an exception thrown while buying a basket —
      // naming the wrong money path, and clearing the other one's alerts.
      let phase: "settle" | "invest" = "settle";
      /** What this turn leaves behind for the doorbell: whether it may rest. A turn that threw may not. */
      let doorTurn: { readonly settle: TurnSettle; readonly invest: TurnInvest | null; readonly wrapShort?: boolean } = {
        settle: "THREW",
        invest: null,
      };
      /**
       * Where this turn's invest half read its at-rest state: "snapshot" when the
       * invest-batch cut decided it from the sweep's batch, which was read before
       * this turn began. The doorbell is told the batch's time for such a turn
       * (restVerdictReadAt), so a bell that rang after the batch is not answered by
       * a rest that could not have seen it. Never set without the cut.
       */
      let investReads: InvestResult["reads"];
      try {
        // Prefer Privy (no local key); fall back to a local keypair if present.
        // A resolution FAILURE is logged with its real reason and falls back.
        let walletSigner: SolanaWalletSubmitter | Keypair | null = null;
        // WHICH ROUTE CAN SIGN FOR THIS WALLET, reported per wallet rather than
        // inferred from a total, so "can this thing settle on its own yet?" has
        // an answer in /status.
        let route = "not resolved (dry run)";
        // THE VOLUME KEEPER RESOLVES NO SIGNER FOR A VAULT IT DOES NOT SETTLE: it would
        // only repeat the profit keeper's seat alerts for the same wallet and spend
        // Privy calls on a turn that stops at the mode. Unread vaults are resolved, by
        // every keeper; the rest is the profile's signerScope (resolvesSignerFor).
        const settlesThisVault = vaults === null || resolvesSignerFor(profile, vaults.get(vaultAddr)?.skimMode);
        if (config.signing !== null && !settlesThisVault) route = "not resolved (the profit keeper settles this vault)";
        if (config.signing !== null && settlesThisVault) {
          walletSigner = localSigners?.signers.get(wallet) ?? null;
          route = walletSigner !== null ? "local-keypair" : "none";
          const lookupFailed = privyLookupFailed.get(wallet);
          if (privyConfig !== null && lookupFailed !== undefined) {
            // THE BOOK COULD NOT ASK (privy-address): the same route and the same
            // warning a failed per-wallet lookup gives today, and no listing.
            if (walletSigner === null) route = "none (privy lookup failed)";
            log.warn("privy signer resolution failed", { wallet, detail: lookupFailed });
          } else if (privyConfig !== null) {
            // WITHOUT THE SWEEP'S INDEX, THIS RESOLUTION LISTS EVERY WALLET IN
            // THE APP FOR ONE WALLET: counted, because N of them is the cliff.
            // Under the book the index is always there, so this never counts.
            if (privyIndex === undefined) privyUsage.fallbackLookup();
            try {
              const resolution = await createPrivySolanaSigner(
                privyConfig,
                link.wallet,
                config.privySignerId ?? undefined,
                privyIndex,
                // Undefined when the policy id is not configured, and the
                // refusal is then unreachable rather than switched off.
                config.privyPolicyId ?? undefined,
              );
              // AN UNBOUNDED SEAT PAGES, unlike the other two refusals. Those
              // are the owner's to fix from the web (Re-seat keeper, Grant
              // keeper permission), and /status showing them is enough; this one is the credential on Railway being able to do
              // anything at all with that wallet, which nobody would notice by
              // reading a status page. Cleared on every other outcome, so a
              // re-seated wallet alerts again if it ever breaks twice.
              if (resolution.outcome === "SEAT_NOT_BOUNDED") {
                alerter.fire({
                  key: `seat-unbounded:${wallet}`,
                  severity: "critical",
                  title: "A trading wallet seats the keeper's signer with no policy of its own",
                  detail:
                    "Nothing is signed for it. A seat without exactly the keeper's override policy could sign any " +
                    "message, send any transaction and export that wallet's key. Re-seat it from the web and check it " +
                    "with `privy-policy verify`.",
                  context: { wallet, overridePolicyIds: resolution.overridePolicyIds, expected: config.privyPolicyId },
                });
              } else {
                alerter.clear(`seat-unbounded:${wallet}`);
              }
              if (resolution.outcome === "SIGNER") {
                // UNDER privy-address THE SEAT IS ASKED ABOUT AGAIN RIGHT BEFORE A
                // SEND, and a send Privy refuses makes the book ask again next turn
                // (confirmedSubmitter); without the cut, the signer as it always was.
                walletSigner = privyBook === null ? resolution.signer : confirmedSubmitter(resolution.signer, privyBook);
                route = "privy";
              } else if (walletSigner === null) {
                // EVERY REASON STARTS WITH "none": the signing summary below
                // counts a wallet unsignable by that prefix.
                route =
                  resolution.outcome === "NOT_A_PRIVY_WALLET"
                    ? "none (not a Privy wallet)"
                    : resolution.outcome === "SIGNER_NOT_GRANTED"
                      ? "none (signer not granted)"
                      : "none (seat not bounded by the keeper's policy)";
                changes.change(
                  `signer:${wallet}`,
                  unsignableNote(resolution),
                  {
                    wallet,
                    ...(resolution.outcome === "SIGNER_NOT_GRANTED" ? { granted: resolution.granted } : {}),
                    ...(resolution.outcome === "SEAT_NOT_BOUNDED"
                      ? { overridePolicyIds: resolution.overridePolicyIds, expected: config.privyPolicyId }
                      : {}),
                  },
                );
              }
            } catch (error) {
              if (walletSigner === null) route = "none (privy lookup failed)";
              log.warn("privy signer resolution failed", { wallet, detail: summarizeUpstreamError(error) });
            }
          }
        }

        // No key reaches a turn that is not live: the attester, the wallet
        // signer and the crank are passed only when every live condition holds
        // AT THAT TURN (keysForTurn, src/chain-state.ts). A claim lost halfway
        // through a sweep takes the keys away from the next turn, not the next
        // sweep.
        // RECORDED AS SOON AS IT IS KNOWN, not at the end of the turn. It used to
        // be the last line of the try, so a wallet whose turn threw was never
        // counted at all and /status reported signing {signable: 0, of: 0} —
        // during exactly the incident an operator opens /status to read. The
        // route is fully resolved here, well before anything is sent.
        signingRoutes.set(wallet, route);

        const settleTurn = keysForTurn(isLive, { settleKey: settleKeypair, walletSigner });
        // NULL MEANS THE CHAIN HAS NO ACCOUNT THERE, never "could not read"
        // (src/accounts.ts) — AND BOTH PATHS NOW SAY IT THE SAME WAY.
        // runSettleTick turns a null vault into a FAILED settlement and
        // settleAlert pages critical for that wallet. The degraded read used
        // Anchor's fetch(), which THROWS "Account does not exist" for an absent
        // account, indistinguishable at a catch from a refused request: a link
        // whose vault had genuinely gone away therefore produced one contained
        // log line and NO page, but only on the sweeps where the batch had
        // already failed — the sweeps where nobody was looking at that wallet.
        // A failed REQUEST still throws into the catch below, which is the one
        // line that case deserves: it is weather, and the batch's own alert
        // already names it.
        const vaultState = vaults !== null ? (vaults.get(vaultAddr) ?? null) : await vaultForLink(link);
        // THE VOLUME KEEPER'S MEASUREMENT, and only the volume keeper's: the probe
        // counts what each transaction traded (src/measure-volume.ts), the base
        // charges what came after the last change of mode or rate at the vault's
        // cadence (src/volume-base.ts). The profit keeper passes neither.
        // WHICH ONE A TURN GETS is the vault's mode's base source, and only when this
        // keeper's profile settles that mode (measuredBase): a vault it does not
        // settle stops at the mode before anything is measured.
        let volumeTurn: Pick<SettleDeps, "volumeProbe" | "volumeBase"> = {};
        if (vaultState !== null) {
          const base = measuredBase(profile, vaultState.skimMode);
          switch (base) {
            case null:
            case "balance-chain":
              break;
            // NO LEGACY ROLE SETTLES A PER-TRADE BYTE (src/role-registry.ts, T-O1), so
            // measuredBase answers null for one and this case is never reached; were it,
            // the turn would carry no per-trade seam and rest at UNSUPPORTED_MODE.
            case "per-trade":
              break;
            case "trade-notional":
              volumeTurn = {
                volumeProbe: tradeNotional,
                volumeBase: createVolumeBase({
                  volumeBps: vaultState.volumeBps,
                  boundary: () =>
                    policyBoundaries.boundary({
                      reader: ownerHistoryReader,
                      programId: programId.toBase58(),
                      vault: link.vault,
                      owner: vaultState.owner,
                      from: measurementStart(link),
                      current: { mode: vaultState.skimMode, volumeBps: vaultState.volumeBps },
                    }),
                  nowSeconds: () => Date.now() / 1000,
                }),
              };
              break;
            default:
              unreachable(base);
          }
        }
        const settleAt = Date.now();
        const settle = await runSettleTick({
          connection,
          program,
          link,
          vault: vaultState,
          attester: settleTurn.settleKey,
          walletSigner: settleTurn.walletSigner,
          live: settleTurn.live,
          protocolPaused,
          carries: settleCarries,
          // EXACTLY ONE KEEPER SETTLES EACH MODE (its profile's settles).
          settles: profile.settles,
          ...volumeTurn,
          walkCache,
          // THE `rest-skip` CUT, only with its token (src/rest-book.ts).
          ...(restBook === null ? {} : { restBook }),
          // THE LOSS-CARRY STORE, only when SIP_SOLANA_CARRY_STORE is dual or on.
          ...(carryStore === null ? {} : { carryStore }),
          // TOLD AFTER EACH SEND, never asked before one (SettleDeps.onSend).
          onSend: noteSettleSend,
        });
        settleOutcome = settle.outcome;
        // THE invest-batch CUT: a settle that may have moved SOL into the vault
        // makes the batch's picture of it stale for the rest of this sweep.
        if (investSnapshots !== null && !settleLeavesSnapshotTrue(settle.outcome)) dirtyVaults.add(vaultAddr);
        // A HOT SETTLE'S WALL TIME, the number the dispatcher is sized on and
        // nobody had measured. Only a LIVE turn that SETTLED: a resting turn's
        // time is the sweep's triage lane, already on /status, and a dry run's
        // "would settle" is also SETTLED but sends nothing and waits for no
        // confirmation, so its time would understate the very number wanted.
        if (settleTurn.live && settle.outcome === "SETTLED") turnTimers.record("settleSettledMs", Date.now() - settleAt);
        // EVERY TRANSACTION THIS KEEPER SENDS MUST COME BACK THROUGH THE
        // WEBHOOK: it touches the wallet and the vault, both watched. One that
        // does not come back makes the doorbell deaf (src/doorbell.ts).
        if (settle.signature !== undefined) doorbell.expectEcho(settle.signature, Date.now(), [wallet, vaultAddr]);
        // MONEY EVENTS always log and clear the dedupe key — a SETTLED, a RETRY
        // or a real FAILED is news every time. The resting states each log ONCE
        // on change; they stay visible in /status instead, which never dedupes.
        if (settle.outcome === "SETTLED" || settle.outcome === "FAILED" || settle.outcome === "RETRY") {
          // A VAULT THAT MOVED ANYTHING BUT settle_v2's OWN ARITHMETIC warns,
          // every time: the tick's detail names both amounts.
          const amountDiffers =
            settle.settledLamports !== undefined && settle.expectedLamports !== undefined && settle.settledLamports !== settle.expectedLamports;
          const level = settle.outcome === "FAILED" ? "error" : settle.outcome === "RETRY" || amountDiffers ? "warn" : "info";
          log[level](`settle ${settle.outcome.toLowerCase()}`, {
            wallet,
            vault: vaultAddr,
            detail: settle.detail,
            signature: settle.signature,
          });
          changes.forget(`settle:${wallet}`);
          // THE RECEIPT SAYS HOW MUCH; THE ATTESTATION SAYS WHAT WAS OWED, and
          // when the first cannot be read the second is not a guess. A settle
          // that lands and whose receipt read returns null — routine, because
          // the pool can route that read to an endpoint behind the one that
          // just confirmed — used to write NO ROW, and nothing backfills: after
          // the RPC's history window that settlement is gone from the mirror
          // forever. `expectedLamports` is expectedContribution(base, bps,
          // maxContribution), which is settle_v2's own arithmetic over a base, a
          // rate and a policy nonce the chain verified byte for byte inside the
          // attestation it accepted. If the settle landed, that is what moved.
          // STILL UNCOVERED: when Privy signs and broadcasts and then answers
          // 504, the keeper never learns the signature, and tx_ref is NOT NULL.
          // Closing that means finding the signature afterwards by the new
          // nonce, which is a bigger change than this one.
          if (
            settle.outcome === "SETTLED" &&
            settle.signature !== undefined &&
            settle.baseLamports !== undefined &&
            settle.mode !== undefined &&
            settle.expectedLamports !== undefined &&
            settle.nonce !== undefined &&
            settle.endSlot !== undefined
          ) {
            // THE WHOLE MIRROR IS OFF THE SETTLEMENT PATH. Awaiting it here once
            // stopped that wallet's turn while `cycleRunning` stayed true, so
            // every later sweep logged "cycle skipped" and nobody was settled.
            // The owner and skim are READ FROM THE VAULT, never assumed: the one
            // this turn settled against, from the sweep's batched read, so the
            // mirror no longer costs a request of its own. A failed write warns
            // inside the read model and never throws, like recordSettlement's.
            // THE RATE THIS SETTLEMENT WAS CHARGED AT, not the vault's PROFIT
            // rate. The row used to take skim_bps whatever the mode, so a VOLUME
            // vault's mirror claimed the profit rate — at the demo rates, 5000 bps
            // for a vault actually charged 200. activeBps is the program's own
            // branch (Vault::active_bps) and the same value the attestation this
            // settle carried was built from.
            if (vaultState !== null) {
              void readModel.recordLink(vaultAddr, vaultState.owner.toBase58(), activeBps(vaultState), wallet);
            }
            void readModel.recordSettlement({
              walletAddr: wallet,
              nonce: settle.nonce,
              vaultAddr,
              mode: settle.mode,
              // THE ATTESTED BASE, as the Settled event records it: in PROFIT mode,
              // net of any loss an earlier zero settle carried into the window.
              baseRaw: settle.baseLamports,
              contributionRaw: settle.settledLamports ?? settle.expectedLamports,
              // WHAT THE WINDOW TRADED, not what it saved: the leaderboard's
              // volume board ranks on this. A turn that measured nothing
              // records 0 rather than leaving the column to a default nobody
              // chose — the two are the same number, and only one is a decision.
              // THE VOLUME KEEPER RECORDS ITS OWN MEASURE, the one it charges on
              // (volumeLamports); the profit keeper's is unchanged.
              volumeRaw: settle.volumeLamports ?? settle.tradedLamports ?? 0n,
              txRef: settle.signature,
              height: settle.endSlot,
              // THE CHAIN'S CLOCK, NOT THIS PROCESS'S, whenever the receipt gave
              // one: the board groups by UTC day, and a settle either side of
              // midnight must land on the day it happened — the same day a
              // rebuild from the chain would give it.
              ...(settle.blockTimeMs === undefined ? {} : { at: new Date(settle.blockTimeMs) }),
            })
              // THE BOARD CHANGES EXACTLY HERE, so it is recomputed here — or,
              // under the board-timer cut, within 15 s with the settles beside
              // it — and not two minutes later: somebody who just saved and went
              // to look must not find a ranking that has never heard of them. AFTER the
              // write resolves, because the write is fire-and-forget and a
              // refresh racing it would read the row that is not there yet.
              .then(() => requestBoard());
          }
        } else {
          changes.change(`settle:${wallet}`, `settle ${settle.outcome.toLowerCase()}`, { wallet, vault: vaultAddr, detail: settle.detail });
        }
        // WHO IS WOKEN, AND FOR WHAT, is settleAlert's (src/settle-decision.ts),
        // where a test pins the rule for every outcome. What it resolves is
        // cleared first, then what it raises is fired. A RETRY is counted per
        // wallet, sweep after sweep, and any other outcome resets the count.
        // A RETRY THAT WAITED ON THE LOSS-CARRY STORE (`waitingOn`, set only when
        // SIP_SOLANA_CARRY_STORE is on) is the store's, every wallet's at once: it
        // neither counts here nor pages per wallet, and the store pages once
        // (src/carry-store.ts, CARRY_STORE_ALERT_KEY). Without a store, today's count.
        const consecutiveRetries = settleRetryStreak(settleRetries.get(wallet) ?? 0, settle.outcome, settle.waitingOn);
        if (consecutiveRetries === 0) settleRetries.delete(wallet);
        else settleRetries.set(wallet, consecutiveRetries);
        const settleAlerts = settleAlert(settle.outcome, { wallet, vault: vaultAddr }, settle.detail, consecutiveRetries, settle.waitingOn);
        for (const key of settleAlerts.clear) alerter.clear(key);
        if (settleAlerts.fire !== null) alerter.fire(settleAlerts.fire);

        // THE VOLUME KEEPER NEVER INVESTS. The profit keeper invests every vault,
        // whatever its mode, so each vault has exactly one keeper buying for it.
        // Its /status row says what it did instead: a VOLUME vault's settle, or a
        // PROFIT vault's preview of what VOLUME mode would charge.
        investing: {
        if (!profile.invests) {
          let detail = settle.detail;
          // THE PREVIEW IS A DRY RUN'S ONLY (dryRunPreview). It walks a span the profit
          // keeper settles, on the same Helius account; an acting volume keeper's job is
          // to settle VOLUME vaults, and it does not spend reads describing the others.
          if (
            profile.dryRunPreview &&
            !settleTurn.live &&
            vaultState !== null &&
            vaultState.skimMode === MODE_PROFIT &&
            settle.outcome === "UNSUPPORTED_MODE"
          ) {
            try {
              detail = await previewVolume({ connection, program, link, vault: vaultState, book: volumePreviews });
              // AND THE LAST SETTLED WINDOW: the pending span is usually empty, because
              // the profit keeper settles a win within a minute.
              const last = await previewLastSettled({ connection, program, link, vault: vaultState, book: volumePreviews });
              if (last !== null) detail = `${detail} ${last}`;
            } catch (error) {
              detail = `${settle.detail}; the volume preview could not be read: ${summarizeUpstreamError(error, { take: 2, maxChars: 300 })}`;
            }
          }
          doorTurn = { settle: settle.outcome, invest: null };
          health.wallets[wallet] = { settle: settle.outcome, invest: profile.notInvesting, signing: route, detail, at: new Date().toISOString() };
          break investing;
        }
        // Asked again: the settle turn above can take long enough for the claim
        // to go.
        phase = "invest";
        const investTurn = keysForTurn(isLive, { settleKey: settleKeypair, walletSigner: null });
        const investSnapshot = investSnapshots === null || dirtyVaults.has(vaultAddr) ? undefined : investSnapshots.get(vaultAddr);
        const investAt = Date.now();
        const invest = await runInvestTick({
          connection,
          program,
          vault: link.vault,
          crank: investTurn.settleKey,
          crankLamports: snapshot.crankLamports,
          // config.pools NO LONGER GOES IN. The invest path took a mint -> Raydium
          // pool registry and refused any leg missing from it; under Jupiter there
          // is no pool to name, and a leg Jupiter cannot route is refused by the
          // depth gate itself, before the wrap. The setting is still parsed and
          // still counted in the status line, because operators' environments
          // carry it and a config key that starts erroring is its own outage.
          live: investTurn.live,
          protocolPaused,
          // THE jupiter-key CUT, only while its token is on (jupiterAccess above).
          ...(jupiterAccess === null ? {} : { jupiter: jupiterAccess }),
          // THE invest-batch CUT: the batch's picture of this vault, unless this
          // sweep already moved money into or out of it.
          ...(investSnapshot === undefined ? {} : { snapshot: investSnapshot }),
          // THE explicit-send CUT, only while its token is on (crankSender above).
          ...(crankSender === null ? {} : { sender: crankSender }),
        });
        investReads = invest.reads;
        if (investSnapshots !== null) {
          if (!investLeavesSnapshotTrue(invest.outcome)) dirtyVaults.add(vaultAddr);
          if (investBatchStats !== null) {
            if (invest.reads === "snapshot") investBatchStats.decidedFromSnapshot += 1;
            else if (invest.reads === "fresh") {
              investBatchStats.rereadFresh += 1;
              if (investTurn.live && invest.outcome === "INVESTED") investBatchStats.investedAfterReread += 1;
            } else investBatchStats.dirtyFresh += 1;
          }
        }
        // The same rule for a basket: a live turn that INVESTED, sends and all.
        if (investTurn.live && invest.outcome === "INVESTED") turnTimers.record("investInvestedMs", Date.now() - investAt);
        // INVESTED/FAILED/REFUSED always log; NO_POLICY, IDLE and PAUSED log on change.
        if (invest.outcome === "INVESTED" || invest.outcome === "FAILED" || invest.outcome === "REFUSED") {
          log[invest.outcome === "INVESTED" ? "info" : "warn"](`invest ${invest.outcome.toLowerCase()}`, { vault: vaultAddr, detail: invest.detail });
          changes.forget(`invest:${vaultAddr}`);
          // `purchases` is absent on a DRY RUN, which is the point: a dry run
          // must never leave a purchase in the history. EVERY confirmed leg is
          // recorded — including the ones that confirmed before a later leg
          // broke the basket, because those moved real money.
          for (const purchase of invest.purchases ?? []) {
            void readModel.recordInvestment({
              vaultAddr,
              target: purchase.target,
              spentRaw: purchase.spentRaw,
              receivedRaw: purchase.receivedRaw,
              txRef: purchase.signature,
              height: purchase.slot,
            });
          }
          // A basket the keeper cannot buy is money that should be buying and
          // is not — the absence-shaped failure the alerter exists for.
          if (invest.outcome === "REFUSED") {
            alerter.fire({
              key: `invest-refused:${vaultAddr}`,
              severity: "warn",
              title: "A basket cannot be bought",
              detail: invest.detail,
              context: { vault: vaultAddr },
            });
          } else {
            alerter.clear(`invest-refused:${vaultAddr}`);
          }
        } else {
          changes.change(`invest:${vaultAddr}`, `invest ${invest.outcome.toLowerCase()}`, { vault: vaultAddr, detail: invest.detail });
        }
        // A LEG'S TRANSFER FEE WALKING TOWARD THE CEILING, raised beside the
        // refusal above and in the same shape: a keyed alert the alerter
        // deduplicates, cleared once the condition goes away. A WARN is sent
        // once per condition rather than every 30 minutes, a critical keeps
        // repeating (legFeeAlert, src/sweep-decision.ts, says why).
        //
        // OUTSIDE THAT BRANCH, BECAUSE THE WARNING IS NOT ABOUT THE OUTCOME.
        // `invest-refused` fires only on REFUSED and is one of the three
        // outcomes that always log. This fires on ANY turn that read the leg
        // mints — an INVESTED basket whose ANTHROPIC leg sits EXACTLY on
        // MAX_LEG_FEE_BPS (300 from epoch 1043, already written on chain) is
        // the live case, and it is the healthiest-looking
        // outcome there is. A warning only an unhealthy turn can carry is a
        // warning that arrives the sweep after it was useful.
        //
        // AND IT CHANGES NOTHING ELSE. No outcome, no purchase, no detail: the
        // turn above already decided everything it decides.
        // `undefined` means this turn stopped before the mints and learned
        // nothing; an EMPTY array means it looked and found nothing to say. Only
        // the second is evidence that a standing warning has gone — for THIS
        // vault, which is all a turn can speak for.
        if (invest.feeWarnings !== undefined) {
          const raised = legFeeLooked.get(vaultAddr) ?? new Set<string>();
          for (const alert of invest.feeWarnings) {
            raised.add(alert.key);
            alerter.fire(legFeeAlert(alert));
          }
          legFeeLooked.set(vaultAddr, raised);
        }
        for (const purchase of invest.purchases ?? []) doorbell.expectEcho(purchase.signature, Date.now(), [vaultAddr]);

        // COUNTED PER SWEEP, NOT PER TURN. Both streaks are keyed by VAULT and
        // this loop runs per LINK, so a vault with three linked wallets advanced
        // them three times in one sweep and paged critical after a single sweep —
        // the escalation that is meant to say "three sweeps in a row". The turn
        // above still runs for every link, because it moves money; only the
        // counting moved, to just after this loop.
        investSweep.set(vaultAddr, foldInvestTurn(investSweep.get(vaultAddr), invest));

        doorTurn = { settle: settle.outcome, invest: invest.outcome, wrapShort: invest.wrap?.short === true };

        // /status always reflects the latest condition, deduped or not.
        health.wallets[wallet] = {
          settle: settle.outcome,
          invest: invest.outcome,
          signing: route,
          detail: settle.outcome === "SETTLED" || settle.outcome === "NO_PROFIT" ? invest.detail : settle.detail,
          at: new Date().toISOString(),
        };
        }
      } catch (error) {
        // Contained per wallet: one bad link must not end the sweep.
        const detail = summarizeUpstreamError(error, { take: 3, maxChars: 500 });
        log.error("wallet turn threw", { wallet, phase, detail });
        // AND ESCALATED, WHICH IT NEVER USED TO BE. settleAlert and the invest
        // streaks are both applied from INSIDE this try, so they were reachable
        // only by a turn that RETURNED an outcome. An exception unwound past all
        // of it to here, which wrote a THREW row on /status and logged a line and
        // fired nothing — so a keeper could sweep for hours settling nobody, with
        // every escalation intact and none of it reachable. The one failure mode
        // that paged nobody was the one nobody had written a handler for.
        //
        // THE LADDER IS EXTENDED, NOT REPLACED. A throw in the settle half fires
        // the SAME `settle-failed:<wallet>` key a FAILED settle fires, with its
        // own title: it is the same condition — this wallet is not being settled —
        // so a second key would page twice for one fault and would not be cleared
        // by the SETTLED that eventually fixes it. A throw in the invest half is
        // folded in as a FAILED invest turn, so the existing per-vault streak
        // warns on the first and pages critical on the third, exactly as a
        // returned FAILED does. Which half is which is what `phase` is for.
        // THE invest-batch CUT: a turn that threw, in either half, may have sent
        // something its vault's snapshot does not show. It reads fresh from here on.
        if (investSnapshots !== null) dirtyVaults.add(vaultAddr);
        if (phase === "settle") {
          const threw = settleThrewAlert({ wallet, vault: vaultAddr }, detail);
          for (const key of threw.clear) alerter.clear(key);
          if (threw.fire !== null) alerter.fire(threw.fire);
          // The streak is counted from turns that returned; this one did not.
          settleRetries.delete(wallet);
        } else {
          investSweep.set(vaultAddr, foldInvestTurn(investSweep.get(vaultAddr), { outcome: "FAILED", detail }));
          if (settleOutcome !== null) doorTurn = { settle: settleOutcome, invest: "THREW" };
        }
        // COUNTED EVEN THOUGH IT THREW: a wallet missing from this map is a
        // wallet /status does not count at all, which reads as a smaller fleet
        // rather than a broken one. Set above as soon as the route was resolved;
        // this covers a throw from before that point.
        if (!signingRoutes.has(wallet)) signingRoutes.set(wallet, health.wallets[wallet]?.signing ?? "not resolved");
        // AND SAID ON THE PAGE. health.wallets is assigned at the END of the
        // turn, so a throw left this wallet's row holding the LAST GOOD settle
        // and its timestamp: /status read "settled fine, a minute ago" for a
        // wallet whose turn had been failing for hours. The signing route is
        // kept from the last turn that got that far, because this throw can come
        // from before it was resolved.
        health.wallets[wallet] = {
          settle: "THREW",
          invest: "THREW",
          signing: health.wallets[wallet]?.signing ?? "not resolved",
          detail,
          at: new Date().toISOString(),
        };
      }
      // WHAT THE DOORBELL LEARNS FROM THIS TURN, outside the try so a throw is
      // recorded too (as busy). A link turned only by the safety rotation that
      // had work waiting and no bell is the evidence the webhook missed it. A
      // rest decided from the invest-batch snapshot is dated by the batch, not by
      // this turn's start (restVerdictReadAt, src/invest-snapshot.ts).
      const restReadAt = restVerdictReadAt(turnAt, vaultReadAt, investReads);
      if (doorbell.recordTurn(door, lane, turnRests(doorTurn), Date.now(), `${doorTurn.settle}/${doorTurn.invest ?? "none"}`, restReadAt)) {
        log.warn("doorbell: a link the webhook never rang had work waiting (possible miss)", {
          wallet,
          vault: vaultAddr,
          settle: doorTurn.settle,
          invest: doorTurn.invest,
        });
      }
      // OUTSIDE THE TRY AND ITS CATCH, so a turn that threw is still counted as
      // a user who was LOOKED AT — it was, expensively — and its milliseconds
      // are still charged to a lane. A wallet missing from these totals would
      // read as a smaller fleet rather than a failing one, which is the same
      // mistake the signing summary already made once.
      const turnMs = Date.now() - turnAt;
      if (settleOutcome !== null && !settleWalked(settleOutcome)) triageMs += turnMs;
      else expensiveMs += turnMs;
      linksTriaged += 1;
    }

    // THE LOSSES THIS SWEEP LEFT WAITING, STAMPED ON THE KEEPER'S OWN CLOCK.
    //
    // The stamp used to be created by the /status projection, which was its only
    // caller — so it was born on the first human page view. A loss carried at
    // 09:00 by a keeper that ran all day was reported "since 17:00" to the
    // operator who opened /status before a redeploy, which is precisely the
    // reader this was built for: they read an eight-hour wait as something that
    // had just appeared, deployed, and the restart dropped the carry. Railway
    // probes /health, which never renders the status, so nothing else was ever
    // going to stamp it. One observation per sweep, storing nothing new.
    carryWatch.record(settleCarries, Date.now());

    // ONE ADVANCE PER VAULT PER SWEEP, however many wallets that vault has linked.
    // A vault whose turns all threw before investing contributes nothing and its
    // streak stands, exactly as it did when a throw skipped these lines.
    for (const [vaultAddr, folded] of investSweep) {
      // A CRANK THAT STAYS SHORT OF A VAULT, told on the third SWEEP in a row.
      // Any sweep that did not find it short — nothing to wrap, a crank that
      // covered it, a pause, conversion off — ends the run and clears it.
      const shortStreak = wrapShortStreak(wrapShort.get(vaultAddr) ?? 0, folded.wrap?.short === true);
      const shortAlert = folded.wrap === undefined ? null : wrapShortAlert(vaultAddr, shortStreak, folded.wrap);
      if (shortStreak === 0) {
        wrapShort.delete(vaultAddr);
        alerter.clear(`wrap-short:${vaultAddr}`);
      } else {
        wrapShort.set(vaultAddr, shortStreak);
        if (shortAlert !== null) alerter.fire(shortAlert);
      }
      // AN INVESTMENT THAT KEEPS FAILING: warned on the first sweep, critical on
      // the third in a row. The alerter dedupes by key alone, so the warning
      // standing under the same key is cleared first, or it would swallow the
      // escalation. REFUSED holds the count; every other outcome ends it.
      const failedStreak = investFailedStreak(investFailed.get(vaultAddr) ?? 0, folded.outcome);
      if (folded.outcome === "FAILED") {
        investFailed.set(vaultAddr, failedStreak);
        if (failedStreak === INVEST_FAILED_CRITICAL_STREAK) alerter.clear(`invest-failed:${vaultAddr}`);
        alerter.fire(investFailedAlert(vaultAddr, failedStreak, folded.detail));
      } else if (failedStreak === 0) {
        investFailed.delete(vaultAddr);
        alerter.clear(`invest-failed:${vaultAddr}`);
      }
    }

    // AND THE LEG-FEE WARNINGS THIS SWEEP NO LONGER RAISES, cleared once for
    // the whole sweep rather than per vault — the keys are keyed by mint and
    // rate, not by vault, so two vaults sharing a leg share the condition and
    // must share the clear (the legFeeBook comment says why).
    //
    // A SWEEP THAT NEVER READ A MINT CLEARS NOTHING. Otherwise a sweep of
    // nothing but early refusals would drop every standing key and the next
    // real read would raise them all again: one message per sweep, forever,
    // which is exactly how an operator learns to ignore this channel.
    // PER VAULT NOW: a vault this sweep did not turn keeps what its last
    // looking turn raised, so its warning is neither cleared nor re-raised by
    // the rotation.
    for (const key of legFeeBook.fold(legFeeLooked, new Set(doorLinks.map((link) => link.vault)))) alerter.clear(key);

    // EVERY SELECTED LINK HAS HAD ITS TURN.
    selectionOutstanding = false;

    // THE DOORBELL'S OWN TWO ALERTS. doorbell-deaf: it was trusted and is not
    // now, so every sweep is a full pass again — nothing is missed, but the
    // webhook needs a look. doorbell-sync: the webhook cannot be kept in step.
    if (doorbell.enabled) {
      const deaf = doorbellDeafAlert(doorbell.trust(Date.now()), doorbell.everTrusted);
      if (deaf.fire !== null) alerter.fire(deaf.fire);
      else if (deaf.clear) alerter.clear(DOORBELL_DEAF_ALERT_KEY);
      const sync = webhookSync.syncAlert();
      if (sync.fire !== null) alerter.fire(sync.fire);
      else if (sync.clear) alerter.clear(DOORBELL_SYNC_ALERT_KEY);
    }

    // THE OPERATOR'S FIRST QUESTION, answered once per change: how many of these
    // wallets can this process settle WITHOUT a human?
    const routes = signingRoutes.values();
    const signable = routes.filter((r) => r === "privy" || r === "local-keypair").length;
    health.signing = { ...health.signing, wallets: config.signing === null ? null : { signable, of: routes.length } };
    changes.change(
      "signing-summary",
      "signing routes",
      config.signing === null
        ? { resolved: false, of: routes.length, mode: "dry-run — nothing is sent and no signer is resolved" }
        : {
            signable,
            of: routes.length,
            privy: routes.filter((r) => r === "privy").length,
            localKeypair: routes.filter((r) => r === "local-keypair").length,
            unsignable: routes.filter((r) => r.startsWith("none")).length,
            mode: isLive() ? "live" : "dry-run — nothing is sent",
          },
    );

    // AND, EVERY SO OFTEN, WHETHER THIS KEEPER CAN STILL SIGN AT ALL. Last, so a
    // slow Privy delays nothing that moves money, and after health.sweeps has
    // been advanced, so the cadence counts sweeps that actually happened.
    await reestablishAuthorizationKey();
  } catch (error) {
    // A SELECTION NOBODY FINISHED TURNING is a set of bells nobody answered:
    // they aged in the hold while the sweep failed, so the next sweep turns
    // everybody rather than trusting a hold that may have lapsed.
    if (selectionOutstanding) doorbell.requestFullPass("the previous sweep failed before it turned every link it selected");
    selectionOutstanding = false;
    health.lastSweepError = summarizeUpstreamError(error, { take: 3, maxChars: 500 });
    log.error("sweep cycle failed", { detail: health.lastSweepError });
    // dep-down: A SWEEP THAT ENDED ON THE POOL'S "EVERY ENDPOINT REFUSED" IS THE
    // RPC DOWN, at once (DependencyWatch.sweepFailureCause): the generic
    // sweep-failed below is then held by the gate, and dep-down:rpc pages
    // instead from noteSweepCost. Any other failure is still sweep-failed.
    const failedOn = depWatch?.sweepFailureCause(cycleBeganAt) ?? null;
    if (failedOn !== null) depWatch?.sweepFailedOn(failedOn, health.lastSweepError);
    alerter.fire({
      key: "sweep-failed",
      severity: "critical",
      title: "The keeper's sweep is failing",
      detail: health.lastSweepError,
    });
  } finally {
    // THE FLAG FIRST, BEFORE ANY MEASUREMENT. Everything below this line counts
    // and times; if any of it threw while the flag was still set, every later
    // sweep would be skipped forever — the precise wedge this instrumentation
    // was added to report, caused by the instrumentation. For the same reason
    // the accounting has a catch of its own: /status losing a number is a page
    // with a gap in it, and a keeper that stops sweeping is an outage.
    cycleRunning = false;
    cycleStartedAt = null;
    try {
      noteSweepCost(
        Date.now() - cycleBeganAt,
        { chainReadMs, discoveryMs, vaultReadMs, triageMs, expensiveMs, privyIndexMs },
        linksTriaged,
        walkAtStart,
      );
    } catch (error) {
      log.warn("the sweep's own cost could not be recorded (the sweep itself is unaffected)", {
        detail: summarizeUpstreamError(error),
      });
    }
  }
}

if (config.armed && !readModel.enabled) {
  log.warn(
    "no DATABASE_URL, so the single-keeper lock is NOT enforced — if two armed instances run at once, both will invest",
  );
}

// THE CHAIN FIRST: who the attester and the crank are, and whether this keeper
// may act as them. Armed and readable-but-wrong ends here with exit 2.
const initial = await readChainSnapshot(connection, program);
applySnapshot(initial);
if (config.armed) {
  verification = verifyLive(initial, true);
  if (verification?.kind === "verified") {
    await claim.ensure();
    if (!claim.held) log.warn("another keeper holds the claim — running as a DRY RUN and retrying every sweep");
  }
}
// THE CARRY STORE BEFORE THE FIRST SWEEP: whether its table is there (in `on`,
// the keeper does not act until it is), and every row it holds into memory, so
// `dual` decides with what `on` wrote and /status shows the carries a deploy
// would otherwise have dropped (src/carry-store.ts, seed).
if (carryStore !== null) {
  await carryStore.prepare(settleCarries);
  const { notReady, dbOnlyAtBoot, lastProblem } = carryStore.status();
  log.info("loss-carry store", { mode: carryStore.mode, notReady, dbOnlyAtBoot, lastProblem });
}
health.mode = isLive() ? "live" : "dry-run";
health.missingLiveCondition = liveBlocker();

// BEFORE THE FIRST SWEEP, so an armed keeper knows whether it can sign before it
// has any money to move — and the banner below can say so.
await establishAuthorizationKey();

// ASKED BEFORE THE BANNER, so the banner can tell the truth about it. A mirror
// that is off, or pointed at a database without the schema, is invisible from
// every other signal this process emits.
const history = await readModel.preflight();
health.history = history.detail;
if (!history.ok && readModel.enabled) log.warn("read model is not usable", { detail: history.detail });

log.info("keeper starting", {
  program: programId.toBase58(),
  programDeployed: health.programDeployed,
  // FROM THE CHAIN, not from a key this process holds: a dry run holds none.
  attester: health.config?.attester ?? null,
  crank: health.crank.pubkey,
  config: health.config === null ? (initial.configReadable ? "does not exist" : "unreadable") : "read",
  role: profile.banner,
  endpoints: config.rpcUrls.length,
  sweepMs: config.sweepMs,
  pools: config.pools.size,
  // FROM isLive(), NOT FROM THE FLAGS. An instance that lost the claim once
  // announced itself as LIVE while settling nothing — the single most
  // misleading line it could print.
  mode: isLive() ? "LIVE — settlements and purchases will be broadcast" : "dry run — nothing will be sent",
  missingLiveCondition: health.missingLiveCondition,
  settleKey: health.signing.settleKey,
  signing: health.signing.route,
  // "matches" or nothing else: every other value means a settle Privy will refuse,
  // or a pairing nobody has established.
  authorizationKey: health.signing.authorizationKey,
  // The website's calendar and history come from here. "off" and "BROKEN" both
  // mean the site will show an empty past for vaults that really did settle.
  history: history.detail,
  alerts: health.alerts,
  // WHETHER A SWEEP TURNS A SELECTION OR EVERYBODY, and who keeps the webhook.
  // Never the secret or the key: whether they exist, and where the key came from.
  doorbell: config.doorbellSecret === null ? "off — every sweep turns every link" : "on — every sweep is a full pass until the first event",
  doorbellWebhook: webhookSync.status().reason ?? "managed",
  heliusApiKey: config.heliusApiKeySource,
});

/**
 * LET GO PROMPTLY. The advisory lock lives on the held session, so without this
 * a redeployed container keeps its claim until the connection eventually dies —
 * and the new instance, which is the one meant to be acting, runs dry for as
 * long as that takes. The image runs tsx directly, so the signal Railway sends
 * reaches this process.
 */
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    // THE explicit-send CUT'S DRAIN (ADR §4.3 item 4): stop starting sends, give
    // a crank send already on the wire up to SIGTERM_DRAIN_MS to confirm, THEN
    // let the claim go — so the successor cannot read balances its predecessor's
    // last transaction is about to change. It needs Railway's
    // RAILWAY_DEPLOYMENT_DRAINING_SECONDS >= 30; at 0 the process is killed
    // first and the successor's quiet period covers the gap instead.
    if (crankSender !== null) {
      crankSender.beginDrain();
      health.mode = "dry-run";
      health.missingLiveCondition = liveBlocker();
      void crankSender.idle(SIGTERM_DRAIN_MS).then((drained) => {
        log.info("drained the crank's sends", { signal, drained, sender: crankSender.status().drain });
        if (config.armed && readModel.enabled && claim.held) {
          log.info("releasing the keeper claim", { signal });
          claim.release();
        }
        process.exit(0);
      });
      return;
    }
    if (config.armed && readModel.enabled && claim.held) {
      log.info("releasing the keeper claim", { signal });
      claim.release();
    }
    process.exit(0);
  });
}

// DETACHED, BOTH OF THEM. The first sweep is what this process exists for and
// it does not wait for a page's query; the rankings catch up a moment later.
requestBoard();
setInterval(requestBoard, LEADERBOARD_REFRESH_MS);
// NO IMMEDIATE CALL: the boot preflight above just answered this, and asking
// twice in one second would only cost a connection to say the same thing.
setInterval(() => void refreshHistoryVerdict(), HISTORY_RECHECK_MS);

await sweep();
setInterval(() => void sweep(), config.sweepMs);
