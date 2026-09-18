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
import { createAlerter } from "../src/alerts.js";
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
import { SERVICE, createChangeLog, createKeeperLogger } from "../src/keeper-log.js";
import { runPreflight } from "../src/preflight.js";
import {
  buildPrivySolanaIndex,
  createPrivySolanaSigner,
  type PrivySolanaConfig,
  type PrivyWalletEntry,
  type SolanaWalletSubmitter,
} from "../src/privy-signer.js";
import { SolanaReadModel } from "../src/read-model.js";
import { poolFetch } from "../src/rpc-pool.js";
import { seatCheck, seatCheckNotice } from "../src/seat-check.js";
import { activeBps, settleAlert, type CarryBook } from "../src/settle-decision.js";
import { runSettleTick } from "../src/settle-tick.js";
import { loadLocalSigners, type LocalSigners } from "../src/signers.js";
import { KEEPER_LOCK_NAME, KeeperClaim, advisoryKeyFor } from "../src/singleton.js";
import { decideHealth, httpHandler, renderStatus, type KeeperStatus, type PendingCarry } from "../src/status.js";
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
const rpcFetch = poolFetch(config.rpcUrls, (message, fields) => log.warn(message, fields));
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
  log: (severity, line) => log[severity === "critical" ? "error" : "warn"](`alert ${severity}`, { detail: line }),
});

const changes = createChangeLog(log);

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
  crank: { pubkey: null, lamports: null },
  signing: {
    route: signingRoute(),
    privyAppId: config.privyAppId,
    privySignerId: config.privySignerId,
    privyPolicyId: config.privyPolicyId,
    // Neither id answers "would an unbounded seat be refused?" on its own.
    seatCheck: seatCheck(config.privySignerId, config.privyPolicyId),
    secretsRead: config.signing !== null,
    settleKey: config.signing?.settleKey.publicKey.toBase58() ?? null,
    wallets: null,
  },
  history: "not checked yet",
  wallets: {},
  // Projected from the carry book at each request, below: a sweep in flight can
  // record one, and a stale copy here would say a restart costs nothing.
  pendingCarries: [],
};

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
      () => renderStatus({ ...health, pendingCarries: pendingCarries() }, sharedRedactor),
      () => decideHealth({ now: Date.now(), startedAt: startedAtMs, lastProgressAt, sweepMs: config.sweepMs }),
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

async function sweep(): Promise<void> {
  if (cycleRunning) {
    log.warn("cycle skipped: the previous one is still running");
    return;
  }
  cycleRunning = true;
  // /health's clock. A sweep that throws below still counts as a sweep that
  // happened, so an endpoint outage is reported by sweep-failed and /status,
  // never by restarting the container. Stamped again at every link's turn and
  // at every RPC answer, so a sweep that is slow is not read as one that is
  // wedged — the restart that would follow only re-runs the same slow work.
  noteProgress();
  try {
    const snapshot = await readChainSnapshot(connection, program);
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
          alerter.fire({
            key: "not-acting",
            severity: "warn",
            title: "Armed, but another keeper holds the claim",
            detail: "This instance is sweeping in dry run. If no other instance is running, its lock is stale.",
          });
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
      links = await discoverLinks(connection, programId, TRADING_LINK_DISC);
    }
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

    health.sweeps += 1;
    health.lastSweepAt = new Date().toISOString();
    health.lastSweepLinks = links.length;
    health.lastSweepError = null;
    alerter.clear("sweep-failed");
    const signingRoutes = new Map<string, string>();
    /** Each vault's invest turns for THIS sweep, folded; the streaks are applied once from it below. */
    const investSweep = new Map<string, VaultInvestSweep>();
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
      const wallet = link.wallet.toBase58();
      const vaultAddr = link.vault.toBase58();
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
              // are an unfinished onboarding, and /status showing them is
              // enough; this one is the credential on Railway being able to do
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
                  resolution.outcome === "NOT_A_PRIVY_WALLET"
                    ? "wallet is not a Privy wallet in this app"
                    : resolution.outcome === "SIGNER_NOT_GRANTED"
                      ? "wallet has not granted the keeper's signer — re-run the onboarding registration (step 3)"
                      : "wallet seats the keeper's signer without the keeper's policy — re-seat it with the policy (step 3)",
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
          // Recorded from what the tick MEASURED, and only when every field is
          // present: a settle whose receipt was not read in time has no
          // contribution to record, and a guessed row is worse than no row.
          if (
            settle.outcome === "SETTLED" &&
            settle.signature !== undefined &&
            settle.baseLamports !== undefined &&
            settle.mode !== undefined &&
            settle.settledLamports !== undefined &&
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
              contributionRaw: settle.settledLamports,
              txRef: settle.signature,
              height: settle.endSlot,
            });
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
        const investTurn = keysForTurn(isLive, { settleKey: settleKeypair, walletSigner: null });
        const invest = await runInvestTick({
          connection,
          program,
          vault: link.vault,
          crank: investTurn.settleKey,
          crankLamports: snapshot.crankLamports,
          pools: config.pools,
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
        // COUNTED PER SWEEP, NOT PER TURN. Both streaks are keyed by VAULT and
        // this loop runs per LINK, so a vault with three linked wallets advanced
        // them three times in one sweep and paged critical after a single sweep —
        // the escalation that is meant to say "three sweeps in a row". The turn
        // above still runs for every link, because it moves money; only the
        // counting moved, to just after this loop.
        investSweep.set(vaultAddr, foldInvestTurn(investSweep.get(vaultAddr), invest));

        // /status always reflects the latest condition, deduped or not.
        signingRoutes.set(wallet, route);
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
        log.error("wallet turn threw", { wallet, detail });
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
    cycleRunning = false;
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
  // The website's calendar and history come from here. "off" and "BROKEN" both
  // mean the site will show an empty past for vaults that really did settle.
  history: history.detail,
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

await sweep();
setInterval(() => void sweep(), config.sweepMs);
