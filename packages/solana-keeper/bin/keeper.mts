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
import { createServer } from "node:http";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { sharedRedactor, summarizeUpstreamError } from "@sip/solana-log";
import { readVaultNullable, readVaults, type VaultState } from "../src/accounts.js";
import { createAlerter, describeDelivery } from "../src/alerts.js";
import {
  keysForTurn,
  missingLiveCondition,
  readChainSnapshot,
  verifySettleKey,
  type ChainSnapshot,
  type LiveVerification,
} from "../src/chain-state.js";
import { ConfigError, SIGNING_SECRET_VARS, loadConfig, type KeeperConfig } from "../src/config.js";
import { discoverLinks, type ManagedLink } from "../src/discovery.js";
import { accountDiscriminator, idl } from "../src/idl.js";
import {
  INVEST_FAILED_CRITICAL_STREAK,
  investFailedAlert,
  investFailedStreak,
  wrapShortAlert,
  wrapShortStreak,
} from "../src/invest-decision.js";
import { runInvestTick } from "../src/invest-tick.js";
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
import {
  buildPrivySolanaIndex,
  createPrivySolanaSigner,
  readPrivyKeyQuorum,
  unsignableNote,
  type PrivySolanaConfig,
  type PrivyWalletEntry,
  type SolanaWalletSubmitter,
} from "../src/privy-signer.js";
import { SolanaReadModel } from "../src/read-model.js";
import { poolFetch } from "../src/rpc-pool.js";
import { seatCheck, seatCheckNotice } from "../src/seat-check.js";
import { activeBps, settleAlert, settleThrewAlert, type CarryBook } from "../src/settle-decision.js";
import { runSettleTick, type SettleOutcome } from "../src/settle-tick.js";
import { loadLocalSigners, type LocalSigners } from "../src/signers.js";
import { KEEPER_LOCK_NAME, KeeperClaim, advisoryKeyFor } from "../src/singleton.js";
import { computeLeaderboard } from "../src/leaderboard.js";
import {
  decideHealth,
  httpHandler,
  renderLeaderboard,
  renderStatus,
  type KeeperStatus,
  type LeaderboardReply,
  type PendingCarry,
} from "../src/status.js";
import {
  SWEEP_SKIPPED_ALERT_KEY,
  SWEEP_SKIPPED_CRITICAL_STREAK,
  SWEEP_SLOW_ALERT_KEY,
  createSweepTimes,
  jupiterCalls,
  settleWalked,
  sweepSkippedAlert,
  sweepSlowAlert,
} from "../src/sweep-cost.js";
import {
  VAULT_READ_ALERT_KEY,
  VAULT_READ_CRITICAL_STREAK,
  createCarryWatch,
  foldInvestTurn,
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
const rpcFetch = poolFetch(
  config.rpcUrls,
  (message, fields) => {
    failovers += 1;
    log.warn(message, fields);
  },
  undefined,
  (at) => {
    rpcEndpointInUse = at;
  },
);
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

// History for the website. Absent DATABASE_URL it is a no-op; a write failure
// is a warning and never touches the settlement path. See src/read-model.ts.
const readModel = SolanaReadModel.create(config.databaseUrl, (message, fields) => log.warn(message, fields ?? {}));

/**
 * WAKING SOMEONE WHEN SAVINGS STOP.
 *
 * Every failure this keeper has actually had looked healthy from outside: a
 * wallet that never granted its signer, an RPC quietly throttling, a mirror
 * hanging with /health green. The symptom was always an ABSENCE — money that
 * did not arrive — and nothing reported absences to anyone. Conditions fire ONCE
 * and stay quiet until they clear; without a webhook they still reach the log.
 */
const alerter = createAlerter({
  webhookUrl: config.alertWebhook,
  minSeverity: config.alertMinSeverity,
  destination: config.alertChatId === null ? { kind: "webhook" } : { kind: "telegram", chatId: config.alertChatId },
  links: { statusUrl: config.statusUrl },
  log: (severity, line) => log[severity === "critical" ? "error" : "warn"](`alert ${severity}`, { detail: line }),
  // THE BODY LEAVES THE BOX, SO IT PASSES WHAT A LOG LINE PASSES. alerts.ts
  // builds its webhook payload itself and POSTs it raw; only the line above goes
  // through the redacting logger. Every alert `detail` in this file is either a
  // summarized upstream error or an exception's own text — anchor's, the SDK's,
  // a driver's — and the byte-run net exists precisely for a key none of them
  // ever registered.
  sanitize: (text) => scrubbedForExport(text),
});

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
 * The leg-fee alert keys that are STANDING: raised by the last sweep that
 * actually read a leg mint, and not yet cleared.
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
let legFeeStanding = new Set<string>();

/**
 * Consecutive sweeps whose ONE batched vault read failed. A sweep that degrades
 * to a read per link still settles every link whose vault it can read, so one
 * refused request is weather; three in a row is an endpoint that cannot serve
 * this program's accounts, and by then nothing has settled for three sweeps.
 */
let vaultReadFailures = 0;

const privyConfig: PrivySolanaConfig | null = config.signing?.privy ?? null;

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
 * What /status serves. An operator must be able to tell a HALTED keeper from a
 * WEDGED one without ssh: `lastSweepAt` moving = alive; an old timestamp with
 * the process up = wedged; the rest says what the last sweep actually saw.
 */
const health: KeeperStatus = {
  service: SERVICE,
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
    leaderboard = { body: renderLeaderboard(computeLeaderboard(days, new Date()), sharedRedactor) };
  } catch (error) {
    // A PAGE MUST NOT BE ABLE TO KILL THE KEEPER. This runs detached, under the
    // process's uncaughtException trap — which exits.
    log.warn("the leaderboard could not be computed (settlement unaffected)", { detail: summarizeUpstreamError(error) });
  }
}

// The heartbeat, only when a port is provided (Railway injects PORT; the image
// bakes 8080). Started BEFORE the first chain read, so a slow endpoint delays
// the first sweep and never the probe — and, because the probe answers 503 for
// a process that has stopped sweeping, the same slow endpoint must not make it
// answer 503 either: before anything has moved the clock is this process's own
// start, which gives booting the whole bound (decideHealth, src/status.ts).
if (config.port !== null) {
  const port = config.port;
  createServer(
    httpHandler(
      () => renderStatus({ ...health, pendingCarries: pendingCarries(), rpcEndpointInUse, failovers }, sharedRedactor),
      () => decideHealth({ now: Date.now(), startedAt: startedAtMs, lastProgressAt, sweepMs: config.sweepMs }),
      () => leaderboard,
    ),
  )
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
    readModel.claimSingleton(advisoryKeyFor(KEEPER_LOCK_NAME), () => {
      claim.release();
      // /status stops saying "live" now, not at the next sweep. The remaining
      // turns of a sweep in progress ask isLive() again and act dry.
      health.mode = "dry-run";
      health.missingLiveCondition = liveBlocker();
      log.error("the keeper claim was lost with its database session — acting stops until it is claimed again");
      alerter.fire({
        key: "claim-lost",
        severity: "critical",
        title: "The keeper lost its single-keeper claim",
        detail: "Its database session dropped. It sweeps as a dry run and retries the claim every sweep.",
      });
    }),
  onTakeover: () => {
    log.info("took over as the acting keeper");
    alerter.clear("not-acting");
    alerter.clear("claim-lost");
  },
});

const liveBlocker = (): string | null =>
  missingLiveCondition({ armed: config.armed, verification, claimLive: claim.live });
/** Never cached by a caller — always asked. */
const isLive = (): boolean => liveBlocker() === null;

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
    if (readModel.enabled && config.armed && claim.held) claim.release();
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
function noteSweepCost(elapsedMs: number, phases: KeeperStatus["lastSweepPhaseMs"], linksTriaged: number | null): void {
  health.lastSweepMs = elapsedMs;
  sweepTimes.add(elapsedMs);
  health.sweepMsP50 = sweepTimes.p50();
  health.sweepMsP90 = sweepTimes.p90();
  health.lastSweepPhaseMs = phases;
  health.linksTriaged = linksTriaged;
  health.jupiterCallsPerSweep = jupiterCalls.sweepTotal();
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
  // WHERE THIS SWEEP'S MILLISECONDS WENT. Declared out here so the `finally`
  // can publish them even when the sweep throws halfway: a failed sweep's
  // shape is the most interesting one there is.
  let chainReadMs = 0;
  let discoveryMs = 0;
  let vaultReadMs = 0;
  let triageMs = 0;
  let expensiveMs = 0;
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
    if (snapshot.programDeployed === false) {
      changes.change("program", "the program is not deployed on this cluster — nothing to sweep", { program: programId.toBase58() }, "warn");
    } else {
      if (snapshot.programDeployed === true) changes.change("program", "the program is deployed", { program: programId.toBase58() });
      const discoveryAt = Date.now();
      links = await discoverLinks(connection, programId, TRADING_LINK_DISC);
      discoveryMs = Date.now() - discoveryAt;
    }
    // FOUND, WHICH IS NOT THE SAME AS SERVED. `linksTriaged` below counts the
    // ones that actually got a turn; when the two differ somebody was not
    // looked at, and that is the number the owner needs before he has users.
    health.linksDiscovered = links.length;
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
    const vaultReadAt = Date.now();
    try {
      vaults = await readVaults(program, links.map((link) => link.vault));
      vaultReadFailures = 0;
      alerter.clear(VAULT_READ_ALERT_KEY);
    } catch (error) {
      vaultReadFailures += 1;
      const detail = summarizeUpstreamError(error, { take: 3, maxChars: 500 });
      log.warn("the batched vault read failed; this sweep reads one vault per link instead", { links: links.length, detail });
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

    // THE AUTHORITY'S EMERGENCY SWITCH, from this sweep's config read. While it
    // is on, every turn below rests as PAUSED; said once here, on change.
    const protocolPaused = snapshot.config?.paused === true;
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
    if (privyConfig !== null && links.length > 0) {
      try {
        privyIndex = await buildPrivySolanaIndex(privyConfig);
      } catch (error) {
        log.warn("privy wallet index failed; falling back to per-wallet lookups", { detail: summarizeUpstreamError(error) });
      }
    }

    // THE CRANK PAYS FOR EVERY MOVE and nothing was watching it. Empty, every
    // invest turn fails for every vault at once, in a loop, with /health still
    // green. Read from config.keeper's balance, reported in /status, and warned
    // about BEFORE it bites.
    const keeperKey = health.crank.pubkey;
    if (keeperKey !== null && snapshot.crankLamports !== null) {
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
    const signingRoutes = new Map<string, string>();
    /** Each vault's invest turns for THIS sweep, folded; the streaks are applied once from it below. */
    const investSweep = new Map<string, VaultInvestSweep>();
    /** Every leg-fee alert key raised anywhere in THIS sweep, reconciled against legFeeStanding once below. */
    const legFeeRaised = new Set<string>();
    /** Whether ANY turn this sweep got as far as reading a leg mint. Nothing is cleared until one did. */
    let legFeeLooked = false;
    // THE LINK-TO-WALLET PAIRING /status NEEDS, from the set this sweep just
    // discovered. The carry book is keyed by link; an operator reads wallets.
    // Replaced, not merged, so an unlinked wallet stops being named.
    linkWallets.clear();
    for (const link of links) linkWallets.set(link.linkAddress.toBase58(), link.wallet.toBase58());
    log.info("sweep", {
      links: links.length,
      localKeypairs: localSigners?.signers.size ?? 0,
      mode: liveAtStart ? "live" : "dry-run",
      ...(liveAtStart ? {} : { missingLiveCondition: health.missingLiveCondition }),
    });

    for (const link of links) {
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
      try {
        // Prefer Privy (no local key); fall back to a local keypair if present.
        // A resolution FAILURE is logged with its real reason and falls back.
        let walletSigner: SolanaWalletSubmitter | Keypair | null = null;
        // WHICH ROUTE CAN SIGN FOR THIS WALLET, reported per wallet rather than
        // inferred from a total, so "can this thing settle on its own yet?" has
        // an answer in /status.
        let route = "not resolved (dry run)";
        if (config.signing !== null) {
          walletSigner = localSigners?.signers.get(wallet) ?? null;
          route = walletSigner !== null ? "local-keypair" : "none";
          if (privyConfig !== null) {
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
                walletSigner = resolution.signer;
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
        });
        settleOutcome = settle.outcome;
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
              volumeRaw: settle.tradedLamports ?? 0n,
              txRef: settle.signature,
              height: settle.endSlot,
              // THE CHAIN'S CLOCK, NOT THIS PROCESS'S, whenever the receipt gave
              // one: the board groups by UTC day, and a settle either side of
              // midnight must land on the day it happened — the same day a
              // rebuild from the chain would give it.
              ...(settle.blockTimeMs === undefined ? {} : { at: new Date(settle.blockTimeMs) }),
            })
              // THE BOARD CHANGES EXACTLY HERE, so it is recomputed here and
              // not two minutes later: somebody who just saved and went to look
              // must not find a ranking that has never heard of them. AFTER the
              // write resolves, because the write is fire-and-forget and a
              // refresh racing it would read the row that is not there yet.
              .then(() => refreshLeaderboard());
          }
        } else {
          changes.change(`settle:${wallet}`, `settle ${settle.outcome.toLowerCase()}`, { wallet, vault: vaultAddr, detail: settle.detail });
        }
        // WHO IS WOKEN, AND FOR WHAT, is settleAlert's (src/settle-decision.ts),
        // where a test pins the rule for every outcome. What it resolves is
        // cleared first, then what it raises is fired. A RETRY is counted per
        // wallet, sweep after sweep, and any other outcome resets the count.
        const consecutiveRetries = settle.outcome === "RETRY" ? (settleRetries.get(wallet) ?? 0) + 1 : 0;
        if (consecutiveRetries === 0) settleRetries.delete(wallet);
        else settleRetries.set(wallet, consecutiveRetries);
        const settleAlerts = settleAlert(settle.outcome, { wallet, vault: vaultAddr }, settle.detail, consecutiveRetries);
        for (const key of settleAlerts.clear) alerter.clear(key);
        if (settleAlerts.fire !== null) alerter.fire(settleAlerts.fire);

        // Asked again: the settle turn above can take long enough for the claim
        // to go.
        phase = "invest";
        const investTurn = keysForTurn(isLive, { settleKey: settleKeypair, walletSigner: null });
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
        });
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
        // deduplicates, cleared once the condition goes away.
        //
        // OUTSIDE THAT BRANCH, BECAUSE THE WARNING IS NOT ABOUT THE OUTCOME.
        // `invest-refused` fires only on REFUSED and is one of the three
        // outcomes that always log. This fires on ANY turn that read the leg
        // mints — an INVESTED basket whose ANTHROPIC leg sits EXACTLY on
        // MAX_LEG_FEE_BPS is the live case, and it is the healthiest-looking
        // outcome there is. A warning only an unhealthy turn can carry is a
        // warning that arrives the sweep after it was useful.
        //
        // AND IT CHANGES NOTHING ELSE. No outcome, no purchase, no detail: the
        // turn above already decided everything it decides.
        for (const alert of invest.feeWarnings ?? []) {
          legFeeRaised.add(alert.key);
          alerter.fire(alert);
        }
        // `undefined` means this turn stopped before the mints and learned
        // nothing; an EMPTY array means it looked and found nothing to say. Only
        // the second is evidence that a standing warning has gone.
        if (invest.feeWarnings !== undefined) legFeeLooked = true;

        // COUNTED PER SWEEP, NOT PER TURN. Both streaks are keyed by VAULT and
        // this loop runs per LINK, so a vault with three linked wallets advanced
        // them three times in one sweep and paged critical after a single sweep —
        // the escalation that is meant to say "three sweeps in a row". The turn
        // above still runs for every link, because it moves money; only the
        // counting moved, to just after this loop.
        investSweep.set(vaultAddr, foldInvestTurn(investSweep.get(vaultAddr), invest));

        // /status always reflects the latest condition, deduped or not.
        health.wallets[wallet] = {
          settle: settle.outcome,
          invest: invest.outcome,
          signing: route,
          detail: settle.outcome === "SETTLED" || settle.outcome === "NO_PROFIT" ? invest.detail : settle.detail,
          at: new Date().toISOString(),
        };
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
        if (phase === "settle") {
          const threw = settleThrewAlert({ wallet, vault: vaultAddr }, detail);
          for (const key of threw.clear) alerter.clear(key);
          if (threw.fire !== null) alerter.fire(threw.fire);
          // The streak is counted from turns that returned; this one did not.
          settleRetries.delete(wallet);
        } else {
          investSweep.set(vaultAddr, foldInvestTurn(investSweep.get(vaultAddr), { outcome: "FAILED", detail }));
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
    // must share the clear (legFeeStanding says why).
    //
    // A SWEEP THAT NEVER READ A MINT CLEARS NOTHING. Otherwise a sweep of
    // nothing but early refusals would drop every standing key and the next
    // real read would raise them all again: one message per sweep, forever,
    // which is exactly how an operator learns to ignore this channel.
    if (legFeeLooked) {
      for (const key of legFeeStanding) if (!legFeeRaised.has(key)) alerter.clear(key);
      legFeeStanding = legFeeRaised;
    }

    // THE OPERATOR'S FIRST QUESTION, answered once per change: how many of these
    // wallets can this process settle WITHOUT a human?
    const routes = [...signingRoutes.values()];
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
    health.lastSweepError = summarizeUpstreamError(error, { take: 3, maxChars: 500 });
    log.error("sweep cycle failed", { detail: health.lastSweepError });
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
        { chainReadMs, discoveryMs, vaultReadMs, triageMs, expensiveMs },
        linksTriaged,
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
    if (config.armed && readModel.enabled && claim.held) {
      log.info("releasing the keeper claim", { signal });
      claim.release();
    }
    process.exit(0);
  });
}

// DETACHED, BOTH OF THEM. The first sweep is what this process exists for and
// it does not wait for a page's query; the rankings catch up a moment later.
void refreshLeaderboard();
setInterval(() => void refreshLeaderboard(), LEADERBOARD_REFRESH_MS);
// NO IMMEDIATE CALL: the boot preflight above just answered this, and asking
// twice in one second would only cost a connection to say the same thing.
setInterval(() => void refreshHistoryVerdict(), HISTORY_RECHECK_MS);

await sweep();
setInterval(() => void sweep(), config.sweepMs);
