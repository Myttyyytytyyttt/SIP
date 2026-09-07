#!/usr/bin/env node
// One process for the whole product — and now, one process for many accounts.
//
// WHO — discovered from the chain. VaultFactory emits TradingAccountLinked for
// every link in the system, so the user list is derivable from one contract's
// logs and confirmed against activeVaultOf. No user table to keep in sync, and
// nothing to restore if this host is rebuilt from scratch.
//
// HOW — Privy signs. This process holds one authorization key bounded by a
// policy, not N private keys. The policy allows exactly two calls: `settle` on
// the settlement executor, and `invest` on a vault with zero value attached.
//
// `invest` grants less than it sounds like. The assets, their weights, the price
// floors, the threshold and the ceilings all come from vault storage the admin
// signed for with their own wallet, and the output can only land in the vault
// itself. This process chooses the MOMENT, inside those bounds. It still cannot
// trade on a user's behalf, cannot move a token anywhere else, and cannot touch a
// wallet that has not added it as a signer.
//
// IT USED TO SPAWN A CHILD PER ACCOUNT, for crash isolation. Measured, that
// isolation cost 73 MB per account against 0.07 MB of actual state — a hundred
// users came to 7.3 GB of Node runtimes. Accounts now run in this process
// through AccountRunner, which contains a fault per account, and the memory is
// 134 MB for a hundred of them.
//
// SEVERAL INSTANCES MAY RUN AT ONCE, AND NEED NO COORDINATION. Claiming an
// account takes a Postgres advisory lock on (chain, account). An instance
// claims what it can get and skips what it cannot; a dead instance releases its
// locks with its socket — measured at zero seconds after SIGKILL — and its
// accounts are simply claimable again on the next sweep. There is no lease
// table because there does not need to be one.
//
// The broadcast gate is unchanged: --broadcast plus the same byte-for-byte
// sentinel the single-account keeper has always required.

import { createPublicClient, fallback, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

import { AccountRunner, type AccountSpec, type RunnerEnvironment } from "../src/account-runner.js";
import { describeInvestmentConfig, loadInvestmentConfig } from "../src/investment-config.js";
import { alertFor } from "../src/investment-tick.js";
import { ReadModel } from "../src/read-model.js";
import { isKnownSettlementExecutor } from "../src/engine.js";
import {
  PROTOCOL_CONFIGURATION_ABI,
  describeVerdict,
  resolveExpectation,
  verifyDeployment,
  type DeploymentVerdict,
} from "../src/verify-deployment.js";
import { createAlerter, createHeartbeat } from "../src/alerts.js";
import { skipWhileRunning } from "../src/cycle.js";
import { classifyLockHolder } from "../src/ledger-pg.js";
import { discoverManagedAccounts, nextScanFrom } from "../src/discovery.js";
import { buildPrivyWalletIndex } from "../src/privy-wallets.js";
import { createPrivySigner } from "../src/privy-signer.js";
import { createLogger, Redactor } from "../src/log.js";
import type { AttesterSigner } from "../src/attest.js";
import type { TradingSigner } from "../src/submit.js";
import type { KeeperConfig } from "../src/config.js";

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`${name} is not set.`);
  return value;
}

const rpcUrl = env("NUVEM_RPC_URL");
const factory = env("NUVEM_VAULT_FACTORY") as Address;
const fromBlock = BigInt(env("NUVEM_LOGS_FROM_BLOCK", "0"));
const sweepMs = Number(process.env.NUVEM_SUPERVISOR_SWEEP_MS ?? "60000");
/**
 * How far back a brand-new account starts scanning. Sessions that closed before
 * that block are never picked up, which is nothing for a user who links and then
 * trades and is real money for one who traded first — so it is reported.
 */
const lookback = BigInt(process.env.NUVEM_SUPERVISOR_FIRST_ANCHOR_LOOKBACK ?? "1000");
/**
 * How many accounts tick at once. This bounds RPC concurrency, not memory —
 * memory stopped being the constraint when the child processes went away.
 */
const concurrency = Number(process.env.NUVEM_SUPERVISOR_CONCURRENCY ?? "4");

const appId = process.env.PRIVY_APP_ID;
const appSecret = process.env.PRIVY_APP_SECRET;
const signerId = process.env.PRIVY_SIGNER_ID;
const authorizationKey =
  process.env.PRIVY_AUTHORIZATION_KEY ?? process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY;

const broadcast = process.argv.includes("--broadcast");

if (fromBlock === 0n) {
  // Scanning a live chain from genesis is not slow, it is a timeout that reads
  // as "this deployment has no users".
  console.error(
    "NUVEM_LOGS_FROM_BLOCK is 0. Set it to the block the factory was deployed at; " +
      "scanning from genesis will be truncated or time out, and an empty result " +
      "here is indistinguishable from having no users.",
  );
  process.exit(2);
}

const BROADCAST_SENTINEL = "i-understand-this-moves-real-funds";
if (broadcast && process.env.NUVEM_KEEPER_ALLOW_BROADCAST !== BROADCAST_SENTINEL) {
  // SAY WHAT IS WRONG WITH IT, not merely that something is. The comparison is
  // byte for byte on purpose — a truthiness check would be armed by "0",
  // "false" and "no" — but "not the exact sentinel" sends an operator to stare
  // at a value that looks identical, because the usual cause is a trailing
  // space or newline a dashboard added when it was pasted.
  //
  // The sentinel is a public literal, not a credential, so describing the value
  // received leaks nothing. It is still described by SHAPE rather than printed:
  // a variable can always end up holding something it should not, and a key
  // pasted into the wrong field must not reach a log.
  const got = process.env.NUVEM_KEEPER_ALLOW_BROADCAST;
  let diagnosis: string;
  if (got === undefined) {
    diagnosis = "It is not set at all.";
  } else if (got.trim() === BROADCAST_SENTINEL) {
    diagnosis =
      `It matches except for surrounding whitespace (${got.length} characters, expected ` +
      `${BROADCAST_SENTINEL.length}). Re-enter it with no leading or trailing space or newline.`;
  } else if (got.trim().toLowerCase() === BROADCAST_SENTINEL) {
    diagnosis = "It matches except for capitalisation. The comparison is case sensitive.";
  } else if (got.trim() === "") {
    diagnosis = "It is set but empty.";
  } else {
    diagnosis = `It holds ${got.length} characters that are not the sentinel.`;
  }
  console.error(
    "--broadcast was passed but NUVEM_KEEPER_ALLOW_BROADCAST is not the exact sentinel " +
      `"${BROADCAST_SENTINEL}". ${diagnosis} Refusing to start.`,
  );
  process.exit(2);
}

if (broadcast && process.env.DATABASE_URL === undefined && process.env.NUVEM_KEEPER_DATABASE_URL === undefined) {
  // Without a database there is no advisory lock, so two instances would both
  // claim every account and both form intents against the same frontier. The
  // chain refuses the second, so it is wasted gas rather than a double
  // settlement — but broadcasting from an unlocked keeper is not a thing to do
  // on purpose.
  console.error(
    "--broadcast without a DATABASE_URL. The per-account lock lives in Postgres, so " +
      "nothing would stop a second instance claiming the same accounts. Configure the " +
      "database, or run without --broadcast.",
  );
  process.exit(2);
}

const rpcFallbackUrls = (process.env.NUVEM_KEEPER_RPC_FALLBACK_URLS ?? process.env.NUVEM_RPC_FALLBACK_URLS ?? "")
  .split(",")
  .map((url) => url.trim())
  .filter((url) => url !== "");

const redactor = new Redactor();
if (process.env.DATABASE_URL) redactor.register(process.env.DATABASE_URL, "databaseUrl");
redactor.register(rpcUrl, "rpcUrl");
// THE FALLBACKS TOO. Only the primary was registered, and viem's fallback
// re-throws the LAST transport's error — so the one error that reaches
// `sweep cycle failed` and the alert webhook is the fallback's, with its URL in
// the message. A fallback may carry an API key exactly like the primary.
for (const [index, url] of rpcFallbackUrls.entries()) {
  redactor.register(url, `rpcFallbackUrl${index}`);
}
const logger = createLogger({ redactor, base: { service: "@nuvem/keeper-supervisor" } });
const alerter = createAlerter({ webhookUrl: process.env.NUVEM_ALERT_WEBHOOK });
// The website's history mirror. DISABLED without a database — never fails the
// keeper — and it reuses the journal's own DATABASE_URL. RH writes to nuvem_rh.
const readModel = ReadModel.create(
  "nuvem_rh",
  logger,
  process.env.NUVEM_KEEPER_DATABASE_URL ?? process.env.DATABASE_URL,
);

/**
 * The supervisor's own chain reader, WITH FAILOVER.
 *
 * It used to be a bare `http(rpcUrl)`, unlike every per-account runner, which
 * goes through the engine's `failoverRpcClient`. That asymmetry mattered: this
 * client does discovery, and repeated failures on any one chunk throw the whole
 * cycle into "sweep cycle failed", so no new account is claimed until the next
 * one — a keeper that looks alive and picks nobody up.
 *
 * viem's own `fallback` is used rather than the engine's client because discovery
 * speaks the `PublicClient` interface, and swapping that would be a rewrite for
 * a robustness fix. Same fallback list the runners read.
 *
 * USED FOR ONE-OFF READS ONLY — the deployment check and the first anchor. Those
 * are single requests with nothing to be consistent with, and a lagging endpoint
 * makes the anchor EARLIER, which scans more rather than less.
 *
 * DISCOVERY DOES NOT USE IT. See `discoveryEndpoints`.
 */
const client = createPublicClient({
  transport:
    rpcFallbackUrls.length === 0
      ? http(rpcUrl)
      : fallback([http(rpcUrl), ...rpcFallbackUrls.map((url) => http(url))]),
});

/**
 * One endpoint at a time for discovery, pinned for the whole sweep.
 *
 * WHY NOT THE `fallback` CLIENT ABOVE. viem's fallback is per-request and
 * stateless: it restarts at the primary for every call and steps forward only on
 * error. So `eth_blockNumber` and the `eth_getLogs` calls that follow it can be
 * answered by DIFFERENT nodes at different heights — and a node whose head is
 * below the requested `toBlock` clamps it and returns the shorter list with no
 * error. Recording that head as scanned steps permanently over blocks nobody
 * read, and the user who linked in them is never discovered.
 *
 * That was live: the primary at its compute cap fails the expensive
 * `eth_getLogs` and passes the cheap `eth_blockNumber`, and the public fallback
 * sits thousands of blocks behind. The 2,000-block overlap buys about 200 seconds
 * of lag; the gap between those two endpoints was far wider.
 *
 * So the whole scan is attempted against one endpoint, and `discoverManagedAccounts`
 * reads the head through that same client — plus it now refuses outright if the
 * endpoint does not have the block it is about to scan up to. Belt and braces,
 * because a single URL can still front a pool.
 */
const discoveryEndpoints = [rpcUrl, ...rpcFallbackUrls].map((url) => ({
  // The host only. A URL may carry an API key and this is a log field.
  host: (() => {
    try {
      return new URL(url).host;
    } catch {
      return "unparseable";
    }
  })(),
  client: createPublicClient({ transport: http(url) }),
}));

/** Accounts this instance holds, keyed lowercase. Holding one IS holding its lock. */
const held = new Map<string, AccountRunner>();

/**
 * How far back each sweep re-reads on top of what it already scanned.
 *
 * A reorg that REMOVES a link needs nothing: `activeVaultOf` is read fresh every
 * sweep and reports the truth. This margin is for the other direction — a link
 * that lands in a block the watermark stepped over. 2,000 blocks is ~3.3 minutes
 * of chain at 0.1s blocks, thirty times the engine's own finality margin, and it
 * is free: a sweep's new span plus this is still one 10,000-block chunk.
 */
const DISCOVERY_RESCAN_BLOCKS = 2_000n;

/** Every address discovery has ever seen named. Grows only; see discovery.ts. */
let discoveryCandidates: ReadonlySet<string> = new Set();
/** Head of the last successful discovery scan, or null before the first. */
let discoveryScannedTo: bigint | null = null;
/** Accounts that cannot be configured. Reported, and not retried every sweep. */
const broken = new Set<string>();
let stopping = false;
/** Consecutive sweeps that found users and claimed none. See the backstop alert. */
let idleSweeps = 0;
/** Two sweeps of grace, so a rolling redeploy does not page anyone. */
const IDLE_SWEEPS_BEFORE_ALARM = Number(process.env.NUVEM_SUPERVISOR_IDLE_SWEEPS_BEFORE_ALARM ?? "3");

const runnerEnv: RunnerEnvironment = {
  baseEnv: process.env,
  broadcast,
  logger,
  makeAttesterSigner: (config: KeeperConfig): AttesterSigner | null => {
    if (!config.attesterKey) return null;
    const account = privateKeyToAccount(config.attesterKey.reveal() as Hex);
    // Wrapped so the signer surface is exactly the one attest.ts declares:
    // nothing else on a LocalAccount is reachable, and the key is never handed
    // to another module.
    return {
      address: account.address,
      signTypedData: (args) => account.signTypedData(args as never),
    };
  },
  makeTradingSigner: (spec: AccountSpec, config: KeeperConfig): TradingSigner | null => {
    // Privy only. The raw-key path exists in the single-account binary for a
    // wallet you own yourself; here it would mean this process holding every
    // user's private key, which is the custody model signers replaced.
    if (appId === undefined || appSecret === undefined || authorizationKey === undefined) return null;
    return createPrivySigner({
      appId,
      appSecret,
      authorizationKey,
      walletId: spec.walletId,
      address: config.account,
    });
  },
  firstAnchor: async () => {
    const head = await client.getBlockNumber();
    return head > lookback ? head - lookback : 0n;
  },
};

/** Runs `limit` promises at a time. Bounds RPC pressure, not memory. */
async function inBatches<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += limit) {
    await Promise.all(items.slice(i, i + limit).map(run));
  }
}

/**
 * Discovery against ONE endpoint, falling to the next only on a real failure.
 *
 * Pinned rather than per-request, so the head and the logs come from the same
 * node. See `discoveryEndpoints` for what goes wrong otherwise.
 */
async function discoverPinned(scanFrom: bigint) {
  let lastError: unknown = null;
  for (const endpoint of discoveryEndpoints) {
    try {
      return await discoverManagedAccounts({
        client: endpoint.client,
        factory,
        fromBlock: scanFrom,
        // NO `toBlock`. Discovery reads the head through this same client, so the
        // range it scans is one this endpoint can actually answer.
        knownCandidates: discoveryCandidates,
      });
    } catch (error) {
      lastError = error;
      // SAID OUT LOUD. A silent switch is how a lagging endpoint became invisible.
      logger.warn("discovery endpoint failed; trying the next", {
        host: endpoint.host,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  throw lastError instanceof Error ? lastError : new Error("every discovery endpoint failed");
}

async function sweep(): Promise<void> {
  // ── read the history once, then only what is new ─────────────────────────
  //
  // This used to pass `fromBlock` — the factory's deployment block — on EVERY
  // sweep, so the whole history was re-read every 60 seconds: 152 `eth_getLogs`
  // per sweep against the current factory, 218,880 a day, growing by another 86
  // per sweep every day, with zero users. It was the single largest line in the
  // RPC bill and none of it was new information.
  //
  // Safe because the candidate set only ever grows — see `knownCandidates` in
  // discovery.ts — and because every candidate is still confirmed against
  // `activeVaultOf` on every sweep. The authority does not change; only how much
  // history is re-read to reach it.
  //
  // HELD IN MEMORY, NOT PERSISTED, and that is a deliberate trade. A restart pays
  // for one full scan, which is cheap at once per deploy and needs no schema. It
  // is also safe from a crash loop: `verifyDeployment` exits before the first
  // sweep, so a misconfigured keeper never reaches this at all.
  const scanFrom = nextScanFrom({
    deployedAt: fromBlock,
    scannedTo: discoveryScannedTo,
    rescan: DISCOVERY_RESCAN_BLOCKS,
  });

  const discovery = await discoverPinned(scanFrom);
  discoveryCandidates = discovery.candidates;
  // ADVANCED TO WHAT WAS SCANNED, not to a head read separately.
  //
  // This was `= head`, from an `eth_blockNumber` issued before the scan and,
  // under a per-request fallback transport, potentially by a different node than
  // the one that read the logs. It asserted a coverage nobody checked. It is now
  // the `toBlock` discovery itself used and verified it could answer.
  //
  // Only after a successful scan: a throw leaves the watermark where it was, so
  // the next sweep re-reads the range that failed rather than stepping over it.
  discoveryScannedTo = discovery.toBlock;

  let wallets = new Map<string, { walletId: string; signable: boolean }>();
  if (appId !== undefined && appSecret !== undefined) {
    wallets = await buildPrivyWalletIndex({ appId, appSecret, signerId });
  }

  const linked = new Set(discovery.accounts.map((a) => a.account.toLowerCase()));
  let elsewhere = 0;
  let unsignable = 0;
  let foreign = 0;
  /** Who holds what this instance could not claim. Empty when Postgres would not say. */
  const holders = new Set<string>();

  for (const managed of discovery.accounts) {
    const key = managed.account.toLowerCase();
    if (held.has(key) || broken.has(key)) continue;

    const privy = wallets.get(key);
    // Three states, and they are NOT the same. "No signer" is permanent and
    // needs the user to act; "not a Privy wallet" is somebody running their own
    // keeper; only the third is ours to drive.
    if (privy === undefined) {
      foreign += 1;
      continue;
    }
    if (!privy.signable) {
      unsignable += 1;
      alerter.fire({
        key: `no-signer:${key}`,
        severity: "warn",
        title: `${managed.account} never granted a signer`,
        detail:
          "The wallet is linked on chain but this app cannot sign for it, so it will never " +
          "settle. That needs the user to act, not a retry.",
        context: { account: managed.account },
      });
      continue;
    }

    const spec: AccountSpec = { account: managed.account, vault: managed.vault, walletId: privy.walletId };
    const claim = await AccountRunner.claim(spec, runnerEnv);

    if (claim instanceof AccountRunner) {
      held.set(key, claim);
      logger.info("claimed", { account: managed.account, vault: managed.vault, mode: broadcast ? "live" : "dry-run" });
      continue;
    }

    if (claim.kind === "HELD_ELSEWHERE") {
      // Ordinary in a multi-instance deployment, and not an error: somebody
      // else is settling for this user.
      elsewhere += 1;
      const holder = claim.holder;
      if (holder?.applicationName != null) holders.add(holder.applicationName);
      const since = holder?.since === null || holder?.since === undefined ? "" : `, open since ${holder.since}`;
      const verdict = classifyLockHolder(holder);

      // NOT ONE OF OURS. A lock held by something this code cannot identify as a
      // keeper is an orphan — a pooled backend that outlived the keeper that
      // took it, which is exactly what happened here — or a stranger. Either
      // way nobody is settling for this user, and no retry fixes it.
      if (verdict.kind === "NOT_A_KEEPER") {
        alerter.fire({
          key: `foreign-holder:${key}`,
          severity: "critical",
          title: `${managed.account} is locked by something that is not a keeper`,
          detail:
            `The advisory lock is held by ${verdict.name}${since}, which does not identify itself ` +
            "as a Nuvem keeper. Nothing is being settled for this user and retrying will not " +
            "change that. If this is a connection pooler, the lock outlived the keeper that took " +
            "it and the holding backend has to be terminated.",
          context: { account: managed.account, holder: verdict.name },
        });
        continue;
      }
      alerter.clear(`foreign-holder:${key}`);

      // A KEEPER, BUT AN IDLE ONE. This instance is armed and the holder is not:
      // it reads exactly like a healthy multi-instance deployment while the only
      // instance working the account cannot send anything.
      if (broadcast && !verdict.armed) {
        alerter.fire({
          key: `dry-run-holder:${key}`,
          severity: "critical",
          title: `A dry-run keeper holds ${managed.account}, and this one is armed`,
          detail:
            `The lock is held by "${holder?.applicationName}"${since}. That instance will never ` +
            "broadcast and this one cannot claim the account, so nothing is being settled for " +
            "this user. Stop the older deployment.",
          context: { account: managed.account, holder: holder?.applicationName },
        });
      } else {
        alerter.clear(`dry-run-holder:${key}`);
      }
      continue;
    }
    if (claim.kind === "MISCONFIGURED") {
      broken.add(key);
      alerter.fire({
        key: `misconfigured:${key}`,
        severity: "critical",
        title: `Cannot configure a keeper for ${managed.account}`,
        detail: `${claim.problems.join(" ")} This account is linked and is NOT being settled for.`,
        context: { account: managed.account },
      });
      continue;
    }
    logger.error("claim failed", { account: managed.account, detail: claim.detail });
  }

  // Anyone unlinked on chain is released, which also frees their lock. Their
  // logs still name them, so this is the only thing that tells "left" from
  // "never seen".
  for (const [key, runner] of [...held]) {
    if (linked.has(key)) continue;
    logger.info("released; no longer linked on chain", { account: runner.spec.account });
    held.delete(key);
    await runner.release();
  }

  // THE BACKSTOP, and the one alert that does not care WHY.
  //
  // Every other check here names a cause, and this outage got through all of
  // them because its cause was one nobody had thought of. Users exist and this
  // instance is working none of them: that is worth waking someone for whatever
  // the reason turns out to be. Sustained, because a redeploy legitimately shows
  // it for a sweep or two while the previous container lets go.
  if (discovery.accounts.length > 0 && held.size === 0) {
    idleSweeps += 1;
    if (idleSweeps >= IDLE_SWEEPS_BEFORE_ALARM) {
      alerter.fire({
        key: "holding-nothing",
        severity: "critical",
        title: `${discovery.accounts.length} account(s) linked and this keeper holds none`,
        detail:
          `${idleSweeps} consecutive sweeps have found accounts on chain and claimed none of ` +
          "them. No settlement can happen from this instance. If no other instance is holding " +
          "them, every linked user is unserved.",
        context: { linked: discovery.accounts.length, sweeps: idleSweeps },
      });
    }
  } else {
    idleSweeps = 0;
    alerter.clear("holding-nothing");
  }

  logger.info("sweep", {
    linked: discovery.accounts.length,
    held: held.size,
    // WHAT THIS SWEEP ACTUALLY READ. Without it there is no way to tell an
    // incremental sweep from one re-reading the whole chain — both print the same
    // `linked` count and take about the same wall time, and the difference is two
    // orders of magnitude on the bill. `logChunks` is the number billed.
    scannedFrom: scanFrom.toString(),
    scannedTo: discovery.toBlock.toString(),
    logChunks: discovery.chunks,
    ...(elsewhere > 0 ? { heldByOtherInstances: elsewhere } : {}),
    // NAMED, because the count alone cannot tell a healthy sibling from a stale
    // container nobody remembered to stop.
    ...(holders.size > 0 ? { heldBy: [...holders] } : {}),
    ...(unsignable > 0 ? { awaitingSignerGrant: unsignable } : {}),
    ...(foreign > 0 ? { notPrivyWallets: foreign } : {}),
    ...(broken.size > 0 ? { misconfigured: broken.size } : {}),
    ...(wallets.size === 0 ? { warning: "Privy not configured — nothing can be driven" } : {}),
  });
}

/** One pass over everything this instance holds. Failures are per account. */
async function tickAll(): Promise<void> {
  const runners = [...held.values()];
  if (runners.length === 0) return;

  await inBatches(runners, concurrency, async (runner) => {
    const result = await runner.tick();

    // A DEAD CONNECTION IS NOT A FAILED TICK. Its advisory lock is already gone
    // and it can never write again, so keeping it in `held` produces the worst
    // of both: this instance settles nothing for the user, and no other instance
    // may claim them either, while every sweep reports the account as held.
    // Dropping it here means the next sweep re-claims it on a fresh connection.
    const lost = runner.lost;
    if (lost !== null) {
      const key = runner.spec.account.toLowerCase();
      held.delete(key);
      await runner.release();
      logger.warn("released; the journal connection was lost", { account: runner.spec.account, detail: lost });
      alerter.fire({
        key: `journal-lost:${key}`,
        severity: "warn",
        title: `Journal connection lost for ${runner.spec.account}`,
        detail: `${lost} The account was released and will be re-claimed on the next sweep. If this repeats, the database is dropping connections.`,
        context: { account: runner.spec.account },
      });
      return;
    }
    alerter.clear(`journal-lost:${runner.spec.account.toLowerCase()}`);

    if (result.outcome === "THREW") {
      alerter.fire({
        key: `threw:${runner.spec.account.toLowerCase()}`,
        severity: "critical",
        title: `Tick threw for ${runner.spec.account}`,
        detail: `${result.detail} The other accounts continued; this one is not settling.`,
        context: { account: runner.spec.account },
      });
      return;
    }
    alerter.clear(`threw:${runner.spec.account.toLowerCase()}`);
    if (result.outcome === "SETTLE_FAILED" || result.outcome === "L1_RANGE_COLLAPSED") {
      alerter.fire({
        key: `settle-failed:${runner.spec.account.toLowerCase()}`,
        severity: "critical",
        title: `Settlement failed for ${runner.spec.account}`,
        detail: `${result.outcome}: ${result.detail ?? "no detail"}. This is realised profit that did not reach the vault.`,
        context: { account: runner.spec.account },
      });
    } else if (result.outcome === "SETTLED") {
      alerter.clear(`settle-failed:${runner.spec.account.toLowerCase()}`);
      // RECORD IT FOR THE WEBSITE, best-effort. A failure here is logged inside
      // recordSettlement and never touches the settlement that already landed.
      if (result.plan && result.report && result.txHash) {
        void readModel.recordSettlement({
          walletAddr: runner.spec.account,
          nonce: result.plan.attestation.settlementNonce,
          vaultAddr: runner.spec.vault,
          profitRaw: result.report.realizedProfit,
          contributionRaw: result.plan.value,
          txRef: result.txHash,
          height: result.settledBlockL2 ?? 0n,
        });
      }
    }

    // ── the investment turn ─────────────────────────────────────────────────
    //
    // AFTER SETTLEMENT AND INDEPENDENT OF IT. A settle that reverted must not
    // stop a purchase the vault can already afford, and a shallow pool must not
    // stop realised profit reaching the vault. Running it after means a
    // contribution that landed this tick is available to invest on the next one
    // rather than a poll later.
    const investment = await runner.investmentTick();
    if (investment === null) return; // not configured; nothing to say

    const key = `invest:${runner.spec.account.toLowerCase()}`;
    // WHICH OUTCOMES NEED A HUMAN lives in `alertFor`, next to the outcomes
    // themselves and under test — an if/else here is what let REFUSED fall
    // between the branches and vanish.
    const wrong = alertFor(investment.outcome);

    if (wrong !== null) {
      const context = {
        account: runner.spec.account,
        vault: runner.spec.vault,
        ...(investment.txHash ? { txHash: investment.txHash } : {}),
      };
      // BOTH, AND THE LOG LINE IS NOT REDUNDANT. `alerter` writes plain text to
      // stdout/stderr and dedupes for 30 minutes, so a repeating condition
      // prints once and then goes quiet, and none of it is findable by filtering
      // the JSON `message` field a log viewer indexes. The structured line is
      // what an operator can actually search for after the fact.
      logger[wrong.severity === "critical" ? "error" : "warn"](`investment ${investment.outcome.toLowerCase()}`, {
        ...context,
        detail: investment.detail,
      });
      alerter.fire({
        key,
        severity: wrong.severity,
        title: `Investment ${wrong.what} for ${runner.spec.vault}`,
        detail: investment.detail,
        context,
      });
      return;
    }
    alerter.clear(key);
    if (investment.outcome === "BOUGHT" || investment.outcome === "RECONCILED") {
      logger.info(`investment ${investment.outcome.toLowerCase()}`, {
        vault: runner.spec.vault,
        detail: investment.detail,
        ...(investment.txHash ? { txHash: investment.txHash } : {}),
      });
      // Best-effort history. RH buys a whole basket in one tx, so the target is
      // "basket" and received is not a single number; the spend and the tx are.
      if (investment.outcome === "BOUGHT" && investment.txHash && investment.amountIn) {
        void readModel.recordInvestment({
          vaultAddr: runner.spec.vault,
          target: "basket",
          spentRaw: investment.amountIn,
          receivedRaw: 0n,
          txRef: investment.txHash,
          height: 0n,
        });
      }
    }
  });
}

const heartbeat = createHeartbeat({
  alerter,
  name: "supervisor",
  silenceMs: Math.max(sweepMs * 5, 5 * 60 * 1000),
});
const watchdog = setInterval(() => heartbeat.check(), 60_000);
watchdog.unref();

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info("stopping", { signal, held: held.size });
  // Releasing frees every advisory lock, so another instance can take these
  // accounts immediately rather than waiting for a socket to time out.
  for (const runner of held.values()) await runner.release();
  process.exit(0);
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void shutdown(signal));
}

// STATED AT STARTUP, not discovered from the absence of purchases. "The vault
// is not buying" and "this keeper was never asked to buy" look identical in a
// log that only reports what happened.
const investmentConfig = loadInvestmentConfig(process.env);
if (investmentConfig.kind === "INVALID") {
  logger.error("investing is configured and unusable; every account will refuse to claim", {
    problems: investmentConfig.problems,
  });
}

// ASKED BEFORE THE BANNER, so the banner can tell the truth about it. A mirror
// that is off, or pointed at a database without the schema, is invisible from
// every other signal this process emits — and "is the keeper actually working?"
// is a question that has now been asked of both chains more than once.
const history = await readModel.preflight();
if (!history.ok && process.env.DATABASE_URL !== undefined) {
  logger.warn(`read model is not usable: ${history.detail}`);
}

logger.info("supervisor starting", {
  factory,
  sweepMs,
  concurrency,
  mode: broadcast ? "LIVE — settlements may be broadcast" : "dry run — nothing will be sent",
  durable: process.env.DATABASE_URL !== undefined,
  // The website's calendar and per-wallet history come from here. "off" and
  // "BROKEN" both mean the site shows an empty past for vaults that did settle.
  history: history.detail,
  investing: describeInvestmentConfig(investmentConfig),
  // WHICH BUILD IS THIS. Without it, telling a redeploy from a stale container
  // means comparing log SHAPES across commits and hoping some field moved —
  // which cost most of an afternoon the first time it mattered. Railway sets
  // RAILWAY_GIT_COMMIT_SHA itself; the other two are for everywhere else.
  gitSha:
    process.env.NUVEM_KEEPER_GIT_SHA ??
    process.env.GIT_SHA ??
    process.env.RAILWAY_GIT_COMMIT_SHA ??
    "unknown",
});

// ── does the configuration describe the deployment it points at? ─────────────
//
// BEFORE ANY ACCOUNT IS CLAIMED, and fatal when it fails. `configureProtocol` is
// one-shot, so the factory address alone determines the other four for the life
// of that factory — which makes this one eth_call, and makes any disagreement
// the configuration being wrong rather than the chain.
//
// This runs AFTER the line above on purpose: an operator who is about to be
// stopped should still get the factory, the mode and the build that stopped.
{
  const expectation = resolveExpectation(process.env, factory);
  let verdict: DeploymentVerdict;
  try {
    const [weth, pauseController, attesterRegistry, settlementExecutor] = await client.readContract({
      address: factory,
      abi: PROTOCOL_CONFIGURATION_ABI,
      functionName: "protocolConfiguration",
    });
    verdict = verifyDeployment(expectation, { weth, pauseController, attesterRegistry, settlementExecutor });
  } catch (error) {
    verdict = { kind: "UNREADABLE", detail: error instanceof Error ? error.message : String(error) };
  }

  if (verdict.kind === "MATCHES") {
    // THE ENGINE HAS ITS OWN LIST, AND IT IS NOT DERIVED FROM THIS ONE.
    // `SETTLEMENT_EXECUTORS` in session-engine is a HISTORY — every executor that
    // ever settled, so old windows stay readable — and a new one has to be added
    // to it by hand. An address missing from that list does not degrade a read:
    // a settle-shaped call to it classifies as UNKNOWN, and one UNKNOWN refuses
    // its whole window forever, poisoning every later window that contains it.
    //
    // So the damage is silent, permanent, and only starts at the FIRST
    // settlement — long after any configuration check has passed. Both previous
    // executors were missing from that list at some point; the second was caught
    // with a keeper already holding an account and one signature from settling.
    if (!isKnownSettlementExecutor(expectation.executor)) {
      console.error(
        `\nThe settlement engine does not recognise executor ${expectation.executor}.\n\n` +
          "It is not in SETTLEMENT_EXECUTORS (packages/session-engine-old/src/chain.ts). That list is\n" +
          "a history rather than a pointer, so a new executor has to be added to it explicitly.\n\n" +
          "This is refused rather than warned about because the failure is invisible and permanent:\n" +
          "settlements would be broadcast successfully and then classify as UNKNOWN when read back,\n" +
          "and one UNKNOWN rejects its whole window forever — including every later window that\n" +
          "contains it. Add the address, lowercased, and rebuild.\n",
      );
      process.exit(2);
    }
    logger.info("deployment verified", { factory, executorKnownToEngine: true });
  } else {
    // Plain stderr rather than the logger: this is a block of prose an operator
    // reads once and acts on, and JSON-escaping it into a single field is how
    // instructions become unreadable at the moment they are needed.
    console.error(`\n${describeVerdict(verdict, factory)}\n`);
    process.exit(2);
  }
}

await sweep();
await tickAll();
heartbeat.beat();

// ONE CYCLE AT A TIME. `setInterval` fires on the clock whether or not the last
// cycle finished, and a cycle can outrun the interval — not through `sweep`, which
// is one chunk now, but through `tickAll`: it ticks every held account, and this
// deployment's own logs carry 44 ticks longer than 60 seconds, the longest 72.8s
// against a 60s interval. Two in flight runs `runTick` twice concurrently on the
// same runner and the same journal.
//
// (The FIRST sweep cannot overlap anything — it is awaited above, before this
// interval exists. Measured: a cold 863-chunk sweep produced no skips at all.)
const runCycle = skipWhileRunning(
  async () => {
    try {
      await sweep();
      await tickAll();
      heartbeat.beat();
    } catch (error) {
      // A failed cycle must not end the process: the accounts it holds are
      // still claimed, and dropping out would release them for no reason.
      const detail = error instanceof Error ? error.message : String(error);
      logger.error("sweep cycle failed", { detail });
      alerter.fire({
        key: "sweep-failed",
        severity: "warn",
        title: "Supervisor cycle failed",
        detail: `${detail}. Held accounts stay claimed; new users are not being picked up.`,
      });
    }
  },
  () => logger.warn("skipping this cycle; the previous one is still running", { sweepMs }),
);

setInterval(() => {
  if (stopping) return;
  void runCycle();
}, sweepMs);
