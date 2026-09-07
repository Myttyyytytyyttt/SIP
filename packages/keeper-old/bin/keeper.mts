#!/usr/bin/env -S npx tsx
// The keeper CLI.
//
//   tsx bin/keeper.mts                           the loop, dry run (the DEFAULT)
//   tsx bin/keeper.mts tick                      one pass, dry run
//   tsx bin/keeper.mts status                    operator view, no writes
//   tsx bin/keeper.mts journal                   dump and verify the hash chain
//   tsx bin/keeper.mts verify --start A --end B   one explicit window, dry run
//   tsx bin/keeper.mts recover                   what the CHAIN says is settled
//
// No arguments runs the LOOP, because that is how the container image invokes
// this file (packages/keeper-old/Dockerfile ends in `CMD []`, and compose adds
// `command: ["--broadcast"]` only to arm it). Loop-versus-one-pass has nothing
// to do with whether anything is broadcast.
//
// DRY RUN IS THE DEFAULT AND NEEDS NO FLAG. Broadcasting requires BOTH
// `--broadcast` AND `NUVEM_KEEPER_ALLOW_BROADCAST` set to the exact literal
// string checked in src/config.ts. Running this file with no arguments performs a
// dry run; it cannot do anything else, because outside live mode the process
// never even reads a key capable of sending a transaction.

import { readFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { buildAttestation, type AttesterSigner } from "../src/attest.js";
import { describeConfig, loadConfig, type KeeperConfig } from "../src/config.js";
import { buildSessionReport, failoverRpcClient, httpRpcClient, probeEndpoints, type RpcClient } from "../src/engine.js";
import { buildStatus, runLoop, runTick, type KeeperDeps } from "../src/keeper.js";
import {
  ENGINE_SCHEMA,
  LEDGER_SCHEMA,
  Ledger,
  LedgerIdentityError,
  LedgerLockedError,
} from "../src/ledger.js";
import { startHealthServer } from "../src/health.js";
import { createLogger, type Logger } from "../src/log.js";
import { createViemChainAccess, type ChainAccess } from "../src/onchain.js";
import { enumerateChainSettlements } from "../src/reconcile.js";
import { createAlerter, createHeartbeat } from "../src/alerts.js";
import { MirroredLedger } from "../src/ledger-mirrored.js";
import { LocalJournalStore, type JournalStore } from "../src/journal-store.js";
import { createPrivySigner } from "../src/privy-signer.js";
import { describePlan, planSettlement, type TradingSigner } from "../src/submit.js";

const argv = process.argv.slice(2);
const KNOWN_COMMANDS = ["run", "tick", "status", "journal", "verify", "recover"] as const;
// The DEFAULT IS THE LOOP, because the container image's ENTRYPOINT invokes this
// file with no arguments at all and expects a long-running service (see
// packages/keeper-old/Dockerfile: `CMD []`, plus a HEALTHCHECK against /health).
// Defaulting to a single pass would make the container exit immediately and be
// restarted forever. It is still a DRY RUN — the loop mode has no bearing on
// whether anything is broadcast; only --broadcast plus the env acknowledgement do.
// Flags that consume the NEXT argument. Without this list, `--env-file ../.env`
// makes the path itself look like a subcommand — which is exactly the kind of
// silent misparse that would run the wrong thing.
const VALUE_FLAGS = new Set([
  "--env-file",
  "--account",
  "--start",
  "--end",
  "--replay-from",
  "--max-ticks",
  "--acknowledge-degraded",
  "--note",
]);
const positional = ((): string | undefined => {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg.startsWith("--")) {
      if (VALUE_FLAGS.has(arg)) i += 1;
      continue;
    }
    return arg;
  }
  return undefined;
})();
const command = positional ?? "run";
if (positional !== undefined && !(KNOWN_COMMANDS as readonly string[]).includes(positional)) {
  process.stderr.write(
    `unknown command ${JSON.stringify(positional)}. Expected one of: ${KNOWN_COMMANDS.join(", ")}
`,
  );
  process.exit(2);
}
const has = (name: string): boolean => argv.includes(`--${name}`);
const flag = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};
const flagAll = (name: string): string[] => {
  const out: string[] = [];
  for (const [index, arg] of argv.entries()) {
    if (arg === `--${name}`) {
      const value = argv[index + 1];
      if (value !== undefined) out.push(value);
    }
  }
  return out;
};

// ---------------------------------------------------------------------------
// A minimal dotenv reader. The repo keeps its credentials in several gitignored
// files (.env, .env.mainnet, .env.docker) and a real dry run needs values from
// more than one, so --env-file is repeatable. Deliberately no dependency: a
// package that holds a signing key should not pull in code to parse its own
// config. Values are never echoed.
// ---------------------------------------------------------------------------
function loadEnvFile(path: string, env: NodeJS.ProcessEnv): number {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    process.stderr.write(`cannot read --env-file ${path}: ${(error as Error).message}\n`);
    process.exit(2);
  }
  let count = 0;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // Real environment variables win over files, so an explicit export can
    // always override a checked-in default.
    if (env[key] === undefined || env[key] === "") {
      env[key] = value;
      count += 1;
    }
  }
  return count;
}

for (const path of flagAll("env-file")) {
  const count = loadEnvFile(path, process.env);
  process.stderr.write(`loaded ${count} variable name(s) from ${path}\n`);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const readOnly = command === "status" || command === "journal" || command === "recover";
const result = loadConfig({
  env: process.env,
  broadcastFlag: has("broadcast"),
  accountOverride: flag("account"),
  printCalldata: has("print-calldata"),
  requireAttesterKey: !readOnly,
});

if (!result.ok) {
  process.stderr.write("Refusing to start. Configuration problems:\n");
  for (const problem of result.problems) process.stderr.write(`  - ${problem}\n`);
  process.exit(2);
}
const config: KeeperConfig = result.config;
for (const warning of result.warnings) process.stderr.write(`warning: ${warning}\n`);

const logger: Logger = createLogger({
  redactor: config.redactor,
  minLevel: has("debug") ? "debug" : "info",
  base: {
    service: "@nuvem/keeper",
    // On EVERY line, not just the decision: a log that does not say whether it
    // was live is useless in an incident.
    dryRun: config.mode !== "live",
    mode: config.mode,
    chainIdExpected: config.chainId,
    account: config.account,
    gitSha: config.gitSha,
    engineSchema: ENGINE_SCHEMA,
  },
});

// ---------------------------------------------------------------------------
// NOTHING REACHES THE TERMINAL EXCEPT THROUGH THE REDACTOR.
//
// `main().catch` covers the main promise and the health server catches its own
// two paths, but a rejection from a detached promise, or a throw inside a timer
// or a socket callback, escapes both and is printed by node's DEFAULT handler —
// which has never heard of the Redactor. Given that a viem transport error's
// message carries the endpoint URL, and the endpoint carries an Alchemy API key,
// that default printer is a direct route for the key to reach stderr.
//
// Both handlers exit non-zero. An unhandled rejection in a process that signs
// transactions is not a condition to keep running through: the state it leaves
// behind is unknown, and startup recovery is built to resolve exactly that.
// ---------------------------------------------------------------------------
process.on("unhandledRejection", (reason: unknown) => {
  logger.error("fatal: unhandled rejection", { error: reason instanceof Error ? reason : new Error(String(reason)) });
  process.exit(1);
});
process.on("uncaughtException", (error: Error) => {
  logger.error("fatal: uncaught exception", { error });
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
// The budget is PER TICK, not for the life of the process: a keeper that runs for
// months would otherwise trip a cumulative ceiling and then never recover.
// `tickBaseline` is reset after every tick by runLoop's onTick hook.
let rpcCalls = 0;
let tickBaseline = 0;
const countCall = (): void => {
  rpcCalls += 1;
  if (rpcCalls - tickBaseline > config.limits.maxRpcCallsPerTick) {
    // A hard stop, not a throttle. Budget exhaustion must be indistinguishable
    // in effect from "did not look" — it may never degrade into a partial verdict,
    // because a partial verdict looks exactly like a full one.
    throw new Error(
      `RPC call budget exhausted (${rpcCalls - tickBaseline} calls this tick, limit ` +
        `${config.limits.maxRpcCallsPerTick}). Aborting rather than answering from a partial scan.`,
    );
  }
};

const chain: ChainAccess = createViemChainAccess({
  rpcUrl: config.rpcUrl.reveal(),
  chainId: config.chainId,
  executor: config.executor,
  vault: config.vault,
  factory: config.factory,
  pauseController: config.pauseController,
  attesterRegistry: config.attesterRegistry,
  onCall: countCall,
});

const alerter = createAlerter({
  webhookUrl: config.alertWebhook?.reveal(),
  log: (severity, line) => {
    if (severity === "critical") logger.error("alert", { line });
    else logger.warn("alert", { line });
  },
});

const engineRpc: RpcClient = (() => {
  // Endpoints in preference order: the configured primary, then any fallbacks.
  // Only the HOSTS are named in events — the URLs carry API keys.
  const endpoints = [
    { name: config.rpcHost, client: httpRpcClient(config.rpcUrl.reveal(), { attempts: 6 }) },
    ...config.rpcFallbackUrls.map((url, index) => ({
      name: config.rpcFallbackHosts[index] ?? `fallback-${index}`,
      client: httpRpcClient(url.reveal(), { attempts: 6 }),
    })),
  ];

  // Reported at startup, once, because a fallback that cannot trace is REAL but
  // PARTIAL cover — it keeps reads alive while leaving settlement impossible.
  // Discovering that during the outage it was meant to cover is too late.
  if (endpoints.length > 1 && config.probeTxHash !== null) {
    void probeEndpoints(endpoints, config.probeTxHash)
      .then((caps) => {
        for (const cap of caps) {
          logger.info("rpc endpoint", { endpoint: cap.name, reads: cap.reads, traces: cap.traces });
        }
        const tracers = caps.filter((c) => c.traces);
        if (tracers.length <= 1) {
          alerter.fire({
            key: "single-tracer",
            severity: "warn",
            title: "Only one endpoint can measure sessions",
            detail:
              `${tracers.map((c) => c.name).join(", ") || "no endpoint"} supports ` +
              "debug_traceTransaction. The others cover reads only, so if this one fails " +
              "nothing can be measured and no settlement will happen — redundancy for " +
              "discovery, none for saving.",
            context: { tracers: tracers.map((c) => c.name), endpoints: caps.length },
          });
        }
      })
      .catch(() => {
        // A probe that fails says nothing about the endpoints and must not stop
        // the keeper from starting.
      });
  }

  const inner = failoverRpcClient(endpoints, {
    onEvent: (event) => {
      if (event.kind === "SWITCHED") {
        alerter.fire({
          key: "rpc-switched",
          severity: "warn",
          title: `RPC endpoint switched to ${event.to}`,
          detail: `${event.from} could not answer: ${event.reason}`,
          context: { from: event.from, to: event.to },
        });
      } else if (event.kind === "ALL_FAILED") {
        // The outage that has actually happened. Every session becomes
        // unmeasurable, so nobody saves anything, and the chain looks fine.
        alerter.fire({
          key: "rpc-all-failed",
          severity: "critical",
          title: "Every RPC endpoint failed",
          detail:
            `No endpoint could serve ${event.method}: ${event.reason}. ` +
            "Sessions cannot be measured, so no settlement will happen until this clears.",
          context: { method: event.method },
        });
      } else {
        alerter.clear("rpc-switched");
        alerter.clear("rpc-all-failed");
      }
    },
  });

  return {
    async call<T>(method: string, params: readonly unknown[] = []): Promise<T> {
      countCall();
      return inner.call<T>(method, params);
    },
  };
})();

const attesterAccount = config.attesterKey ? privateKeyToAccount(config.attesterKey.reveal() as Hex) : null;
// Wrapped rather than passed through so the signer surface is exactly the one
// attest.ts / submit.ts declare: nothing else on a LocalAccount is reachable
// from the keeper, and the key itself is never handed to another module.
const attesterSigner: AttesterSigner | null = attesterAccount
  ? {
      address: attesterAccount.address,
      signTypedData: (args) => attesterAccount.signTypedData(args as never),
    }
  : null;

// TWO WAYS TO BE THE TRADING ACCOUNT, and the difference is the whole custody story.
//
// Privy first, deliberately. When it is configured the process holds an
// authorization key that can only ASK Privy to sign, bounded by a policy — it
// cannot move a token or trade. The raw-key path below is total custody of the
// user's wallet, which is why multi-user was impossible; it survives only for
// running against a wallet you own yourself.
const privySignerEnv = {
  appId: process.env.PRIVY_APP_ID,
  appSecret: process.env.PRIVY_APP_SECRET,
  // Both spellings — see the note in config.ts. The two must agree, or the
  // keeper validates a signer it then fails to build.
  authorizationKey:
    process.env.PRIVY_AUTHORIZATION_KEY ?? process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY,
  walletId: process.env.PRIVY_WALLET_ID,
};
const privyConfigured =
  privySignerEnv.appId !== undefined &&
  privySignerEnv.appSecret !== undefined &&
  privySignerEnv.authorizationKey !== undefined &&
  privySignerEnv.walletId !== undefined;

const tradingAccount = config.tradingKey ? privateKeyToAccount(config.tradingKey.reveal() as Hex) : null;
const tradingSigner: TradingSigner | null = privyConfigured
  ? createPrivySigner({
      appId: privySignerEnv.appId as string,
      appSecret: privySignerEnv.appSecret as string,
      authorizationKey: privySignerEnv.authorizationKey as string,
      walletId: privySignerEnv.walletId as string,
      address: config.account,
    })
  : tradingAccount
    ? {
        address: tradingAccount.address,
        signTransaction: (transaction) => tradingAccount.signTransaction(transaction as never),
      }
    : null;

/**
 * Opens the journal, mirrored to Postgres when one is configured.
 *
 * WITHOUT A DATABASE_URL THIS IS THE OLD BEHAVIOUR, and on an ephemeral
 * filesystem the old behaviour loses unresolved intents on every redeploy. That
 * is correct for local development and for tests; it is not correct on Railway,
 * and the log below says which one is in force rather than leaving it to be
 * discovered after a container is replaced.
 */
async function openLedger(): Promise<JournalStore> {
  const databaseUrl = config.databaseUrl?.reveal();
  if (databaseUrl !== undefined) {
    const mirrored = await MirroredLedger.open({
      connectionString: databaseUrl,
      dir: config.stateDir,
      instance: {
        chainId: config.chainId,
        factory: config.factory,
        executor: config.executor,
        vault: config.vault,
        account: config.account,
        ledgerSchema: LEDGER_SCHEMA,
        engineSchema: ENGINE_SCHEMA,
      },
      noLock: readOnly,
      forceUnlock: has("force-unlock"),
    });
    logger.info("journal is durable", { schema: mirrored.durableLocation });
    return mirrored;
  }
  logger.warn("journal is LOCAL ONLY", {
    detail:
      "No DATABASE_URL is set, so the journal lives only on this filesystem. On a host " +
      "whose disk does not survive a restart, an unresolved INTENT is lost with it.",
  });
  return new LocalJournalStore(openLocalLedger());
}

function openLocalLedger(): Ledger {
  try {
    const ledger = logReclaim(Ledger.open({
      dir: config.stateDir,
      instance: {
        chainId: config.chainId,
        factory: config.factory,
        executor: config.executor,
        vault: config.vault,
        account: config.account,
        ledgerSchema: LEDGER_SCHEMA,
        engineSchema: ENGINE_SCHEMA,
      },
      noLock: readOnly,
      forceUnlock: has("force-unlock"),
    }));
    return ledger;
  } catch (error) {
    if (error instanceof LedgerIdentityError || error instanceof LedgerLockedError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(3);
    }
    throw error;
  }
}

/**
 * A reclaimed lock MUST be logged loudly, and until now nothing in production
 * read `lockReclaimed` at all — only the tests did. It means the previous keeper
 * died without releasing, which is also the case in which its last transaction
 * was rolled back mid-write and an INTENT may be sitting unresolved.
 */
function logReclaim(ledger: Ledger): Ledger {
  if (ledger.lockReclaimed !== null) {
    logger.warn("took over a state lock its recorded holder could not still have been holding", {
      why: ledger.lockReclaimed.why,
      previous: ledger.lockReclaimed.previous,
      detail:
        "the previous keeper did not release this lock, so it did not exit cleanly. Its last write was " +
        "either committed or rolled back whole; recovery resolves any open intent against the chain.",
    });
  }
  // A DAMAGED store is reported before anything else and in the plainest terms
  // available. The read-only commands below still run — an operator has to be able
  // to SEE the damage during the incident this exists for — but nothing settles
  // through it, and this line is what says so on the way past. Written to stderr
  // as well as logged, because `keeper status` puts JSON on stdout and an operator
  // piping it into jq would otherwise never see this.
  if (ledger.state.condition === "DAMAGED") {
    logger.error("THE STORE IS DAMAGED; it will not be settled from and it was not repaired", {
      decision: "HALT",
      reasonCode: "STORE_DAMAGED",
      storeCondition: ledger.state.condition,
      store: ledger.journalPath,
      detail: ledger.state.integrityDetail,
    });
    // Scrubbed on the way out, like everything else that reaches a terminal. The
    // detail names a FILE PATH — node:sqlite messages carry them and their wording
    // is new on this Node — and a path is not a credential, but the scrub is what
    // guarantees a future field cannot smuggle one out through this line.
    process.stderr.write(
      config.redactor.scrub(
        `STORE DAMAGED: ${ledger.state.integrityDetail ?? "the store could not be read"}\n`,
      ),
    );
  } else if (!ledger.state.integrityOk) {
    logger.error("the store's integrity is NOT intact; nothing will be settled from it", {
      storeCondition: ledger.state.condition,
      detail: ledger.state.integrityDetail,
      store: ledger.journalPath,
    });
  }
  for (const warning of ledger.permissionWarnings) {
    // Never fatal. The mode is advisory on Windows and refused outright by some
    // container storage drivers, and losing the ability to start over a permission
    // bit would be a worse trade than the bit is worth.
    logger.warn("could not tighten the store's file mode to 0600", { detail: warning });
  }
  return ledger;
}

const big = (_key: string, value: unknown): unknown => (typeof value === "bigint" ? value.toString() : value);

/**
 * The last gate on the two exits that do NOT go through the logger: stdout for
 * `keeper status`, and the HTTP body for `GET /status`.
 *
 * `buildStatus` already summarizes every upstream error it stores, so this is
 * belt and braces — but these are the two places a future field could reintroduce
 * the leak without anyone noticing, and scrubbing a JSON string costs nothing.
 */
const renderStatus = (status: Record<string, unknown>): string =>
  config.redactor.scrub(JSON.stringify(status, big, 2));

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
async function main(): Promise<number> {
  if (command === "journal") {
    // THE STORE IS NO LONGER READABLE WITH `cat`. That was the JSONL format's
    // stated decisive advantage, and revoking it silently would remove a
    // capability the design treats as decisive — so this command IS the
    // replacement: every record, in order, with its seq and its decoded body,
    // and a non-zero exit when integrity is not intact.
    const ledger = await openLedger();
    const { records, integrityOk, integrityDetail, rejected, condition } = ledger.readRecords();
    process.stdout.write(`store:   ${ledger.journalPath}\n`);
    // ABSENT / HEALTHY / DAMAGED, on its own line and before the record count,
    // because "0 records" and "DAMAGED" mean opposite things and the count alone
    // cannot tell them apart. That conflation is the defect this prints its way out of.
    process.stdout.write(`state:   ${condition}\n`);
    process.stdout.write(`records: ${records.length}  integrity: ${integrityOk ? "intact" : "NOT INTACT"}\n`);
    if (!integrityOk) {
      process.stdout.write(`         ${integrityDetail ?? "unknown"}\n`);
      if (rejected.length > 0) {
        process.stdout.write(`         records NOT admitted (edited after they were written): ${rejected.join(", ")}\n`);
      }
    }
    process.stdout.write("\n");
    for (const record of records) {
      process.stdout.write(`${String(record.seq).padStart(4, "0")} ${record.ts} ${record.type}\n`);
      process.stdout.write(`     ${JSON.stringify(record.body, big)}\n`);
    }
    ledger.close();
    return integrityOk ? 0 : 1;
  }

  if (command === "recover") {
    // "What does the CHAIN say this account has already settled?"
    //
    // This is the total-state-loss path, run deliberately and read-only. It
    // matters because PersonalVault exposes NO getter for lastEndBlock or
    // usedSessions — they are private namespaced storage — so the only supported
    // way to recover the settled boundaries is to enumerate the indexed
    // SettlementExecuted logs and ABI-decode each settle transaction's calldata.
    // If this command can rebuild the history, so can startup recovery, and the
    // local journal is genuinely a cache rather than the record.
    const observedChainId = await chain.getChainId();
    if (observedChainId !== config.chainId) {
      logger.error("chain id mismatch; refusing", { chainIdObserved: observedChainId, chainIdExpected: config.chainId });
      return 4;
    }
    const snapshot = await chain.readVaultSnapshot(config.account);
    const { settlements, undecodable } = await enumerateChainSettlements(chain, config.account, config.logsFromBlockL2);
    logger.info("settlement history recovered from chain alone", {
      account: config.account,
      settlementNonce: snapshot.settlementNonce.toString(),
      lifetimeContribution: snapshot.lifetimeContribution.toString(),
      found: settlements.length,
      undecodable,
      contributionSum: settlements.reduce((sum, s) => sum + s.contribution, 0n).toString(),
      settlements: settlements.map((s) => ({
        sessionId: s.sessionId,
        txHash: s.txHash,
        blockNumberL2: s.blockNumberL2.toString(),
        bindingEpoch: s.bindingEpoch.toString(),
        settlementNonce: s.settlementNonce.toString(),
        windowL1: [s.startBlockL1.toString(), s.endBlockL1.toString()],
        ledgerRoot: s.ledgerRoot,
        contribution: s.contribution.toString(),
        realizedProfit: s.realizedProfit.toString(),
      })),
    });
    return undecodable.length > 0 ? 1 : 0;
  }

  if (command === "status") {
    const ledger = await openLedger();
    const deps = buildDeps(ledger);
    const status = await buildStatus(deps);
    process.stdout.write(`${renderStatus(status)}\n`);
    ledger.close();
    return 0;
  }

  if (command === "verify") {
    // A single explicit window, end to end, without touching the ledger. This is
    // the closest analogue of `node scripts/settle.mjs --start --end` and it
    // exists for exactly the same reason: to look at one window a human has
    // chosen, in full, before trusting the watcher to choose windows itself.
    const start = flag("start");
    const end = flag("end");
    if (!start || !end) {
      process.stderr.write("verify needs --start <l2Block> --end <l2Block>\n");
      return 2;
    }
    const startBlockL2 = BigInt(start);
    const endBlockL2 = BigInt(end);
    const replayFrom = flag("replay-from");

    const observedChainId = await chain.getChainId();
    logger.info("verifying one explicit window", {
      chainIdObserved: observedChainId,
      rpcHost: config.rpcHost,
      windowL2: [startBlockL2.toString(), endBlockL2.toString()],
    });
    if (observedChainId !== config.chainId) {
      logger.error("chain id mismatch; refusing", { chainIdObserved: observedChainId, chainIdExpected: config.chainId });
      return 4;
    }

    const report = await buildSessionReport({
      rpc: engineRpc,
      wallet: config.account,
      startBlockL2,
      endBlockL2,
      replayStartBlockL2: replayFrom !== undefined ? BigInt(replayFrom) : startBlockL2,
    });

    logger.info("engine report", {
      verdict: report.verdict,
      reasons: report.reasons,
      windowL2: [report.startBlockL2.toString(), report.endBlockL2.toString()],
      windowL1: [report.startBlockL1.toString(), report.endBlockL1.toString()],
      cashStart: report.cashStart.toString(),
      cashEnd: report.cashEnd.toString(),
      externalDeposits: report.externalDeposits.toString(),
      externalWithdrawals: report.externalWithdrawals.toString(),
      realizedProfit: report.realizedProfit.toString(),
      naiveDelta: report.naiveDelta.toString(),
      residualWei: report.reconciliation.residualWei.toString(),
      gasPaid: report.gasPaid.toString(),
      zeroBasisRealized: report.zeroBasisRealized.toString(),
      positionsRoot: report.positionsRoot,
      ledgerRootV2: report.ledgerRootV2,
      // BOTH roots. The v2/legacy divergence is the reason a sessionId novelty
      // check cannot be trusted on its own — the canary's already-settled window
      // re-derives to a different sessionId under the v2 root than the one the
      // chain recorded — so hiding the legacy root removes the one field that
      // makes the divergence visible during an incident.
      ledgerRootLegacy: report.ledgerRootLegacy,
      transactions: report.transactions.map((tx) => `${tx.kind} ${tx.hash.slice(0, 12)}…`),
    });

    if (report.verdict !== "ATTESTABLE") {
      logger.warn("refusing to attest; pick a window the engine can vouch for", {
        decision: "REFUSE",
        reasons: report.reasons,
      });
      return 1;
    }
    if (attesterSigner === null) {
      logger.error("no attester key loaded; cannot build the attestation");
      return 2;
    }

    const snapshot = await chain.readVaultSnapshot(config.account);
    const currentL1Block = await chain.getL1BlockNumber(await chain.getHeadBlockL2());
    const attested = await buildAttestation({
      chain,
      signer: attesterSigner,
      report,
      snapshot,
      chainId: config.chainId,
      account: config.account,
      vault: config.vault,
      executor: config.executor,
      currentL1Block,
      limits: config.limits,
    });
    logger.info("attestation outcome", { kind: attested.kind, ...("reason" in attested ? { reason: attested.reason } : {}), ...("detail" in attested ? { detail: attested.detail } : {}) });
    if (attested.kind !== "READY") return 1;

    // The SAME plan builder the live path uses, so what is printed here is
    // byte-identical to what would go on the wire — including the gas estimate,
    // which runs the whole settle against current state and reports its revert if
    // there is one. That revert is often the most useful line in the output: for a
    // window that has already been settled it is the vault's own SessionAlreadyUsed
    // guard talking.
    const plan = await planSettlement({
      chain,
      logger,
      attestation: attested.attestation,
      signature: attested.signature,
      digest: attested.digest,
      chainId: config.chainId,
      executor: config.executor,
      account: config.account,
      nonce: null,
    });
    logger.info("DRY RUN: this is exactly what would be sent", {
      decision: "DRYRUN",
      wouldSend: describePlan(plan, config.printCalldata),
    });
    return 0;
  }

  const ledger = await openLedger();
  const deps = buildDeps(ledger);

  if (has("acknowledge-degraded")) {
    const seq = Number(flag("acknowledge-degraded"));
    if (!Number.isInteger(seq)) {
      process.stderr.write("--acknowledge-degraded needs the journal seq of the DEGRADED record\n");
      ledger.close();
      return 2;
    }
    if (ledger.state.degraded === null) {
      process.stderr.write("the keeper is not degraded; nothing to acknowledge\n");
      ledger.close();
      return 0;
    }
    if (ledger.state.degraded.seq !== seq) {
      process.stderr.write(
        `the open DEGRADED record is at seq ${ledger.state.degraded.seq}, not ${seq}. ` +
          "Acknowledging requires naming the exact record, so a stale script cannot clear a new halt.\n",
      );
      ledger.close();
      return 2;
    }
    ledger.append("RESUMED", { acknowledgedSeq: seq, note: flag("note") ?? "acknowledged by operator" });
    logger.warn("degraded latch cleared by operator", { acknowledgedSeq: seq });
    ledger.close();
    return 0;
  }

  logger.info("keeper starting", describeConfig(config));
  if (config.mode === "live") {
    logger.warn("LIVE MODE: real funds will move if a window is attestable", {
      maxContributionWei: config.limits.maxContributionWei.toString(),
      maxSettlementsPerDay: config.limits.maxSettlementsPerDay,
    });
  }

  let exitCode = 0;
  try {
    if (command === "run") {
      const controller = new AbortController();
      const stop = (): void => {
        // A SIGTERM can land between "wrote the INTENT record" and "got the
        // receipt". Finishing the current tick resolves that in flight rather
        // than leaving it for startup recovery. Being killed there is still
        // safe — recovery resolves the intent against the chain — but resolving
        // it now is cheaper than resolving it later.
        logger.info("stop signal received; finishing the current tick");
        controller.abort();
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);

      const startedAtMs = Date.now();
      let lastTickAtMs: number | null = null;
      if (config.httpPort !== null && config.httpHost !== null) {
        startHealthServer({
          host: config.httpHost,
          port: config.httpPort,
          logger,
          health: () => {
            const ageS = lastTickAtMs === null ? null : (Date.now() - lastTickAtMs) / 1000;
            // Wedged only. A degraded latch, a tripped breaker or an unreachable
            // RPC must NOT fail the probe: a halted keeper has to stay up to
            // explain itself, and restarting fixes none of those.
            const budgetS = (config.limits.pollMs * 10) / 1000;
            const elapsedS = (Date.now() - startedAtMs) / 1000;
            const wedged = ageS === null ? elapsedS > budgetS : ageS > budgetS;
            return {
              service: "@nuvem/keeper",
              mode: config.mode,
              uptimeS: Math.round(elapsedS),
              lastTickAgeS: ageS === null ? null : Math.round(ageS),
              wedged,
            };
          },
          // Routed through the redactor on the way out. `startHealthServer`
          // serializes whatever this resolves to straight to an unauthenticated
          // socket, so the scrub happens here rather than being trusted to the
          // HTTP layer.
          status: async () => JSON.parse(renderStatus(await buildStatus(deps))) as Record<string, unknown>,
        });
      }

      const maxTicksFlag = flag("max-ticks");
      // The watchdog for the condition that raises no event of its own: a
      // process that is up and no longer working. Every other alert fires
      // because something went wrong; this one fires because nothing happens at
      // all, which is what a wedged keeper looks like from outside.
      const heartbeat = createHeartbeat({
        alerter,
        name: `keeper ${config.account}`,
        silenceMs: Math.max(config.limits.pollMs * 10, 10 * 60 * 1000),
      });
      const watchdog = setInterval(() => heartbeat.check(), 60_000);
      watchdog.unref();

      await runLoop(deps, {
        signal: controller.signal,
        onTick: (result) => {
          lastTickAtMs = Date.now();
          tickBaseline = rpcCalls;
          heartbeat.beat();

          // Outcomes that mean this account is not saving, and will not start
          // saving without someone acting. A settlement that reverted is money
          // the user earned and did not receive.
          if (result?.outcome === "DEGRADED" || result?.outcome === "STORE_REFUSED") {
            alerter.fire({
              key: `halted:${config.account}`,
              severity: "critical",
              title: `Keeper halted for ${config.account}`,
              detail: `${result.outcome}: ${result.detail ?? "no detail"}. Nothing will settle until this is resolved.`,
              context: { account: config.account, outcome: result.outcome },
            });
          } else if (result?.outcome === "SETTLE_FAILED" || result?.outcome === "L1_RANGE_COLLAPSED") {
            alerter.fire({
              key: `settle-failed:${config.account}`,
              severity: "critical",
              title: `Settlement failed for ${config.account}`,
              detail: `${result.outcome}: ${result.detail ?? "no detail"}. This is realised profit that did not reach the vault.`,
              context: { account: config.account, outcome: result.outcome },
            });
          } else if (result?.outcome === "SETTLED") {
            alerter.clear(`settle-failed:${config.account}`);
            alerter.clear(`halted:${config.account}`);
          }
        },
        ...(maxTicksFlag !== undefined ? { maxTicks: Number(maxTicksFlag) } : {}),
      });
    } else {
      rpcCalls = 0;
      const outcome = await runTick(deps);
      if (outcome.outcome === "RPC_ERROR" || outcome.outcome === "CHAIN_MISMATCH") exitCode = 4;
      if (outcome.outcome === "DEGRADED") exitCode = 5;
      // A store that refused a write — DAMAGED, or a schema constraint that
      // proved the keeper was about to do something it must not — is a HALT, and
      // a halt must not report success. It shared exit 0 with "nothing to do",
      // which is the one code a monitoring script reads as "all well": exactly
      // the conflation of "empty" and "damaged" this whole change is about.
      if (outcome.outcome === "STORE_REFUSED") exitCode = 5;
      // Its own code because it is revenue lost, not a duplicate refused, and a
      // wrapper script should be able to count it without parsing log lines.
      if (outcome.outcome === "L1_RANGE_COLLAPSED") exitCode = 6;
      if (outcome.outcome === "SETTLE_FAILED") exitCode = 7;
    }
  } finally {
    ledger.close();
  }
  return exitCode;
}

function buildDeps(ledger: JournalStore): KeeperDeps {
  return {
    config,
    chain,
    rpc: engineRpc,
    ledger,
    logger,
    attesterSigner,
    tradingSigner,
    rpcCalls: () => rpcCalls,
  };
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    // Even here the redacting logger is used: an unhandled viem transport error
    // carries the endpoint URL, and the endpoint carries an API key.
    logger.error("fatal", { error });
    process.exit(1);
  });
