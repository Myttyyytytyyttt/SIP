// Environment loading. Refuses to start rather than guessing.
//
// The governing rule of this file is that "unverified" is never permission to
// proceed. Every value that could silently produce a wrong settlement — the
// chain id, the trading account, the state directory, the broadcast gate — is
// either present and well-formed, or the process exits before it can do any
// work. Nothing here has a fallback that "probably works".
//
// TWO THINGS ARE DELIBERATELY ASYMMETRIC:
//
//   * DRY RUN NEEDS NO SPENDING KEY. In dry-run mode the trading account's
//     private key is never read from the environment at all. That is not an
//     optimisation, it is the enforcement of non-negotiable #1: a dry run
//     cannot broadcast because the process does not hold the key that could.
//     The only way to get that key loaded is to pass --broadcast AND set the
//     acknowledgement, both of which are checked here.
//
//   * BROADCASTING NEEDS AN EXACT SENTENCE. NUVEM_KEEPER_ALLOW_BROADCAST must
//     equal a specific literal string. A truthiness check would be enabled by
//     `=0`, `=false` and `=no`, all of which a human writes when they mean the
//     opposite.
//
// AND ONE RULE ABOUT WHAT A REFUSAL MAY SAY.
//
// No message built in this file ever contains an environment VALUE. Config
// validation runs before the logger exists, and bin/keeper.mts writes each
// problem straight to stderr, so a message that echoes what it read publishes it
// to container logs — which are shipped, rotated and pasted into bug reports. The
// variable one paste away from disaster is an address (NUVEM_TRADING_ACCOUNT is
// one word from "trading key"), and a 0x-prefixed 32-byte private key is a
// perfectly plausible thing to paste there. So a refusal names the VARIABLE, the
// shape it expected, and the SHAPE it got — length and character class, never
// content: see `shape()`. Three further layers back that up:
//
//   1. Any 0x+64-hex value found anywhere in the environment is registered with
//      the Redactor before validation begins, whatever variable it arrived in.
//      A key pasted into the wrong name is redacted from every log line even
//      though this file has no idea it is a key.
//   2. Every problem and warning string is scrubbed through that Redactor on the
//      way out, so a future author who interpolates a value still cannot leak it.
//   3. Key-shaped variables are read-and-deleted from the environment in EVERY
//      mode, so they leave /proc/<pid>/environ and `docker inspect` even on the
//      dry-run path that has no use for them.

import { readFileSync as nodeReadFileSync } from "node:fs";
import { isAddress } from "viem";
import { Redactor, Secret } from "./log.js";

/** The literal acknowledgement that, together with --broadcast, arms the keeper. */
export const BROADCAST_ACK = "i-understand-this-moves-real-funds";

/**
 * The live mainnet deployment, read from `factory.protocolConfiguration()` on
 * 2026-08-08 and verified address by address against it.
 *
 * These were previously a whole EARLIER deployment: four of the five addresses
 * pointed at contracts from a superseded release, and only `weth` happened to
 * survive. Nothing caught it, because every value here is a plausible address
 * and each is only consulted when its environment variable is absent — so the
 * stale ones stayed invisible until `attesterRegistry` (the one field nobody had
 * set) resolved to an old registry naming a different attester, and settlement
 * deferred with ATTESTER_MISMATCH.
 *
 * TREAT THESE AS A FALLBACK, NEVER AS TRUTH. `protocolConfiguration()` is
 * one-shot and immutable, so the factory address alone is enough to derive the
 * other four at runtime; a constant that disagrees with it is always the thing
 * that is wrong. Re-verify before trusting them after any redeployment.
 */
export const MAINNET = {
  chainId: 4663,
  factory: "0x783BDF0281090f21928398cC3Da19cFb64Fed15E",
  executor: "0xfA92ABF15dFAf470Cc8833Cb01464bD6CA139e16",
  // Deliberately NOT a default any more. A vault is per user, so a wrong guess
  // here is a settlement into a stranger's savings rather than a failed read.
  vault: "",
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  pauseController: "0x418B3406BC483eB66ca5570b6fF91cE9d090E8a7",
  attesterRegistry: "0x1a96be4a757e065fb8928a2e5ab2Ab24790Ec7de",
} as const;

export type KeeperMode = "dry-run" | "live";

export interface KeeperLimits {
  /** Poll interval for the loop, milliseconds. */
  readonly pollMs: number;
  /**
   * L2 blocks left untouched at the head. Nothing inside the margin is
   * detected, verified or anchored, so a sequencer reorg cannot move a boundary
   * we already committed to.
   */
  readonly finalityMarginL2: bigint;
  /**
   * L1 blocks that must have passed beyond endBlockL1 before we sign.
   * SettlementExecutor requires `endBlock < block.number` in L1 space, and L1
   * advances ~every 12s, so a freshly closed session is briefly unsettleable.
   * Waiting is correct behaviour, not an error.
   */
  readonly l1Margin: bigint;
  /**
   * Widest session span the dense four-source verifier may be pointed at. The
   * dense scan is O(span) in eth_getBlockByNumber; a multi-million-block window
   * would exhaust the RPC budget and starve every other window.
   */
  readonly maxVerifySpanBlocks: bigint;
  /**
   * Widest DISCOVERY scan one tick may perform. A wider gap is scanned in PART,
   * one window per tick, until the keeper is current again.
   *
   * It used to abandon the tick entirely, on the reasoning that a truncated scan
   * answers from less evidence while looking like a full one. That is true of a
   * provider silently truncating a range; it is not true of deliberately asking
   * for a smaller window, which is a complete answer about less chain and is what
   * every ordinary tick already is. Refusing instead made falling behind
   * permanent — the gap grew every block and the keeper re-refused forever while
   * still logging healthy ticks.
   *
   * The default is sized from measurement, not taste. The engine's block scan
   * issues one sequential eth_getBlockByNumber per block; against the mainnet
   * endpoint that ran at ~21 blocks/second, so 2,000 blocks is ~95 seconds. The
   * chain produces ~7 L2 blocks/second, so 2,000 blocks is also ~5 minutes of
   * real time — comfortably more than one 30-second poll, which is what a tick
   * has to keep up with. Raising it trades a longer worst-case tick for a longer
   * outage the keeper can absorb without operator help.
   */
  readonly maxTickScanSpanBlocks: bigint;
  /** Circuit breaker: refuse any single contribution above this. */
  readonly maxContributionWei: bigint;
  /** Circuit breaker: refuse more than this many settlements in a rolling day. */
  readonly maxSettlementsPerDay: number;
  /** Hard ceiling on RPC calls in one tick. Exceeding it yields NO verdict. */
  readonly maxRpcCallsPerTick: number;
  /** Multiple of (gasLimit * maxFeePerGas) that must be spare beyond the contribution. */
  readonly gasHeadroom: bigint;
}

export interface KeeperConfig {
  readonly mode: KeeperMode;
  readonly rpcUrl: Secret;
  /** Host only. Safe to log; proves which endpoint is in use without the key. */
  readonly rpcHost: string;
  /** Endpoints tried, in order, when the primary cannot answer. */
  readonly rpcFallbackUrls: readonly Secret[];
  /** Hosts of the above, safe to log — the URLs carry API keys. */
  readonly rpcFallbackHosts: readonly string[];
  /** Where alerts are POSTed. Null means they are logged only. */
  readonly alertWebhook: Secret | null;
  /**
   * Postgres for the durable journal. Null keeps the journal local-only, which
   * is right for development and wrong for any host whose disk does not survive
   * a restart — an unresolved INTENT is lost with it.
   */
  readonly databaseUrl: Secret | null;
  /**
   * A mined transaction hash used once at startup to ask each endpoint whether
   * it supports debug_traceTransaction. Its content is irrelevant.
   */
  readonly probeTxHash: `0x${string}` | null;
  readonly chainId: number;
  readonly account: `0x${string}`;
  readonly factory: `0x${string}`;
  readonly executor: `0x${string}`;
  readonly vault: `0x${string}`;
  readonly pauseController: `0x${string}`;
  readonly attesterRegistry: `0x${string}`;
  readonly weth: `0x${string}`;
  readonly stateDir: string;
  /** First L2 block the watcher will ever look at. */
  readonly fromBlockL2: bigint;
  /** First L2 block SettlementExecuted logs are searched from during recovery. */
  readonly logsFromBlockL2: bigint;
  readonly limits: KeeperLimits;
  readonly attesterKey: Secret | null;
  /** Only ever non-null in live mode. See the header comment. */
  readonly tradingKey: Secret | null;
  readonly redactor: Redactor;
  /** True when the full settle calldata should be printed in the dry-run plan. */
  readonly printCalldata: boolean;
  /**
   * Heartbeat bind address, or null to run with no HTTP surface at all.
   * The container sets both; a local `tick` needs neither.
   */
  readonly httpHost: string | null;
  readonly httpPort: number | null;
  readonly gitSha: string;
}

export type ConfigResult =
  | { readonly ok: true; readonly config: KeeperConfig; readonly warnings: readonly string[] }
  | {
      readonly ok: false;
      readonly problems: readonly string[];
      /**
       * Returned on the FAILURE branch too, already primed with every secret the
       * load found. `problems` is scrubbed through it before it is handed back,
       * so a caller may write those strings out directly; the redactor is here so
       * a caller that formats anything else about the failure can scrub that too.
       */
      readonly redactor: Redactor;
    };

export interface LoadConfigOptions {
  readonly env: NodeJS.ProcessEnv;
  /** --broadcast on the command line. Necessary but not sufficient. */
  readonly broadcastFlag?: boolean;
  readonly accountOverride?: string;
  readonly printCalldata?: boolean;
  /** Commands that only read the journal do not need a signing key. */
  readonly requireAttesterKey?: boolean;
}

const first = (env: NodeJS.ProcessEnv, names: readonly string[]): string | undefined => {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value.trim() !== "") return value.trim();
  }
  return undefined;
};

const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;
const HEX = /^0x[0-9a-fA-F]*$/;

/**
 * Describes a rejected environment value WITHOUT reproducing any of it.
 *
 * Length and character class are enough to diagnose every mistake that actually
 * happens — a truncated address, a decimal where hex was wanted, a stray quote,
 * a pasted private key — and none of them is enough to use. Deliberately not
 * even a prefix: the first four bytes of a signing key are four bytes of a
 * signing key, and there is no diagnostic that needs them.
 *
 * The key-shaped case gets its own sentence because it is the one mistake with a
 * catastrophic version: a variable holding what is unmistakably a private key is
 * worth saying out loud so the operator rotates it instead of just fixing the
 * typo.
 */
function shape(value: string): string {
  if (value.length === 0) return "an empty value";
  if (PRIVATE_KEY.test(value)) {
    return (
      `a ${value.length}-character value shaped exactly like a 0x-prefixed 32-byte private key ` +
      "(the value itself is withheld — if a signing key was pasted into this variable, treat it " +
      "as exposed and rotate it)"
    );
  }
  const kind = /^\s+$/.test(value)
    ? "whitespace-only"
    : HEX.test(value)
      ? "0x-prefixed hex"
      : /^[+-]?[0-9]+$/.test(value)
        ? "decimal-integer"
        : /^[+-]?[0-9]*\.[0-9]+$/.test(value)
          ? "decimal-fraction"
          : "neither-hex-nor-numeric";
  return `a ${value.length}-character ${kind} value`;
}

/**
 * Reads a private key, preferring a file over an environment variable, and
 * removes the variable from `process.env` once read.
 *
 * The file form is preferred because an environment variable is visible in
 * `/proc/<pid>/environ`, in `docker inspect`, and to every child process the
 * keeper spawns. Deleting it after the read closes the first two for the
 * lifetime of the process; it is not a substitute for using a file.
 *
 * THE DELETE AND THE REGISTRATION ARE UNCONDITIONAL. Both used to happen only on
 * the branch that consumed the value, which left two gaps: a key supplied inline
 * while a *_KEY_FILE also won stayed in the environment and was unknown to the
 * Redactor, and the whole trading-key read was skipped outside live mode, so the
 * container's normal dry-run operation kept its spending key in /proc/1/environ
 * for the life of the process and the logger could not have redacted it. Reading
 * and registering always, and gating only what the CALLER is handed, closes both
 * without weakening "a dry run holds no spending key".
 */
function readKey(
  env: NodeJS.ProcessEnv,
  fileVars: readonly string[],
  envVars: readonly string[],
  label: string,
  problems: string[],
  readFileSync: (path: string) => string,
  redactor: Redactor,
): Secret | null {
  // Take the inline value out of the environment FIRST and unconditionally,
  // before anything else can read it and before any crash handler can dump the
  // environment — whether or not a file is about to win, and whatever mode we
  // are in.
  const inline = first(env, envVars);
  for (const name of envVars) delete env[name];
  if (inline) redactor.register(inline, `${label}:${envVars[0]}`);

  const file = first(env, fileVars);
  if (file) {
    if (PRIVATE_KEY.test(file)) {
      // Do not even try to open it: the failed-open error message would carry
      // the path, and the path here IS a key.
      problems.push(
        `${fileVars[0]} must be a path to a file containing the key, but it holds ${shape(file)}.`,
      );
      return null;
    }
    let raw: string;
    try {
      raw = readFileSync(file).trim();
    } catch (error) {
      problems.push(`${fileVars[0]} points at ${file}, which could not be read: ${(error as Error).message}`);
      return null;
    }
    if (raw.length > 0) redactor.register(raw, `${label}:${fileVars[0]}`);
    if (!PRIVATE_KEY.test(raw)) {
      problems.push(
        `${fileVars[0]} points at ${file}, which does not contain a 0x-prefixed 32-byte hex ` +
          `private key: the file holds ${shape(raw)}.`,
      );
      return null;
    }
    return new Secret(raw, label);
  }

  if (!inline) return null;
  if (!PRIVATE_KEY.test(inline)) {
    problems.push(
      `${envVars[0]} is not a 0x-prefixed 32-byte hex private key (66 characters): it holds ` +
        `${shape(inline)}.`,
    );
    return null;
  }
  return new Secret(inline, label);
}

function address(
  value: string | undefined,
  fallback: string,
  name: string,
  problems: string[],
): `0x${string}` {
  const candidate = value ?? fallback;
  if (!isAddress(candidate, { strict: false })) {
    problems.push(
      `${name} is not a valid address — expected 0x followed by 40 hex characters (42 in total), ` +
        `got ${shape(candidate)}.`,
    );
    return "0x0000000000000000000000000000000000000000";
  }
  return candidate as `0x${string}`;
}

function positiveBigInt(
  value: string | undefined,
  fallback: bigint,
  name: string,
  problems: string[],
): bigint {
  if (value === undefined) return fallback;
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    problems.push(`${name} must be an integer, got ${shape(value)}.`);
    return fallback;
  }
  if (parsed < 0n) {
    problems.push(`${name} must not be negative, got ${shape(value)}.`);
    return fallback;
  }
  return parsed;
}

function positiveNumber(
  value: string | undefined,
  fallback: number,
  name: string,
  problems: string[],
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    problems.push(`${name} must be a positive number, got ${shape(value)}.`);
    return fallback;
  }
  return parsed;
}

export function loadConfig(
  options: LoadConfigOptions,
  io: { readFileSync?: (path: string) => string } = {},
): ConfigResult {
  const env = options.env;
  const problems: string[] = [];
  const warnings: string[] = [];
  // Injectable so the config tests never touch a real filesystem.
  const readFileSync = io.readFileSync ?? ((path: string) => nodeReadFileSync(path, "utf8"));

  // --- redaction, built FIRST -------------------------------------------------
  //
  // It used to be constructed at the end, after validation, and was not attached
  // to the failure branch at all — so every refusal message reached stderr with
  // nothing watching it. It is now the first thing that exists, and it is primed
  // before a single value is validated.
  //
  // The sweep below is the part that catches the accident this file cannot
  // otherwise see: a 0x+64-hex value is registered no matter WHICH variable it
  // arrived in, so a signing key pasted into NUVEM_TRADING_ACCOUNT (one word from
  // "trading key") is redacted from every subsequent log line even though nothing
  // here knows it is a key. Shape matching is safe in this direction: the values
  // an auditor must be able to read — ledgerRoot, sessionId, EIP-712 digests —
  // come from the chain and from the engine, never from the environment, so they
  // are not in this needle set. The label names the variable, so the marker in a
  // log line tells the operator exactly which one to rotate.
  const redactor = new Redactor();
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const trimmed = value.trim();
    if (PRIVATE_KEY.test(trimmed)) redactor.register(trimmed, `possible-key:${name}`);
  }

  // --- the broadcast gate, evaluated first so its outcome shapes everything ---
  //
  // Read RAW, not trimmed. Every other setting is trimmed for convenience, but
  // the arming sentinel is compared byte for byte: the failure mode of strictness
  // is a confusing refusal, which is safe, while the failure mode of leniency is
  // a broadcast nobody intended. The error message names whitespace explicitly so
  // the refusal is not actually confusing.
  const ack = env.NUVEM_KEEPER_ALLOW_BROADCAST;
  const ackValid = ack === BROADCAST_ACK;
  const broadcastFlag = options.broadcastFlag === true;
  const mode: KeeperMode = broadcastFlag && ackValid ? "live" : "dry-run";

  if (broadcastFlag && !ackValid) {
    problems.push(
      "--broadcast was passed but NUVEM_KEEPER_ALLOW_BROADCAST is not set to the exact " +
        `string ${JSON.stringify(BROADCAST_ACK)} — compared byte for byte, so surrounding ` +
        "whitespace does not count. Both the flag and this variable are required; neither " +
        "alone arms the keeper.",
    );
  }
  if (!broadcastFlag && ackValid) {
    warnings.push(
      "NUVEM_KEEPER_ALLOW_BROADCAST is set but --broadcast was not passed. Staying in dry-run mode.",
    );
  }

  // --- RPC -------------------------------------------------------------------
  const rpcUrlRaw = first(env, ["NUVEM_KEEPER_RPC_URL", "NUVEM_RPC_URL", "MAINNET_RPC", "RPC_URL"]);
  // Registered the moment it is read, not at the end: the URL carries the API key
  // and the next few lines can already fail.
  if (rpcUrlRaw) redactor.register(rpcUrlRaw, "rpcUrl");
  let rpcHost = "<unset>";
  if (!rpcUrlRaw) {
    problems.push("NUVEM_RPC_URL (or NUVEM_KEEPER_RPC_URL / MAINNET_RPC) is required.");
  } else {
    try {
      rpcHost = new URL(rpcUrlRaw).host;
    } catch {
      problems.push("NUVEM_RPC_URL is not a valid URL.");
    }
  }
  const rpcUrl = new Secret(rpcUrlRaw ?? "", "rpcUrl");

  // Fallback endpoints, in preference order after the primary.
  //
  // One endpoint is a single point of failure for the whole product, and not
  // hypothetically: a monthly capacity limit on the only provider stopped every
  // settlement for hours. debug_traceTransaction is a hard dependency, so an
  // endpoint that cannot serve it cannot measure a session, and a keeper that
  // cannot measure saves nothing while looking perfectly healthy.
  const fallbackRaw = first(env, ["NUVEM_KEEPER_RPC_FALLBACK_URLS", "NUVEM_RPC_FALLBACK_URLS"]);
  const rpcFallbackUrls: Secret[] = [];
  const rpcFallbackHosts: string[] = [];
  for (const candidate of (fallbackRaw ?? "").split(",").map((part) => part.trim()).filter(Boolean)) {
    redactor.register(candidate, "rpcFallbackUrl");
    try {
      rpcFallbackHosts.push(new URL(candidate).host);
      rpcFallbackUrls.push(new Secret(candidate, "rpcFallbackUrl"));
    } catch {
      problems.push("An entry in NUVEM_RPC_FALLBACK_URLS is not a valid URL.");
    }
  }

  // Where alerts go. Optional, and its absence is a warning rather than a
  // problem: an unmonitored keeper still works, it just fails quietly, and
  // failing quietly is how every outage in this system has started.
  const alertWebhook = first(env, ["NUVEM_KEEPER_ALERT_WEBHOOK", "NUVEM_ALERT_WEBHOOK"]);
  if (alertWebhook) redactor.register(alertWebhook, "alertWebhook");

  const databaseUrlRaw = first(env, ["NUVEM_KEEPER_DATABASE_URL", "DATABASE_URL"]);
  if (databaseUrlRaw) {
    // Registered before anything can fail: the URL carries the database password.
    redactor.register(databaseUrlRaw, "databaseUrl");
    try {
      const parsed = new URL(databaseUrlRaw);
      // Supabase's transaction pooler (6543) does not keep a session, and
      // pg_advisory_lock is session scoped — it would appear to be granted and
      // hold nothing, so two keepers would run on one account believing they
      // were alone. Refused here rather than discovered as a duplicate later.
      if (parsed.port === "6543") {
        problems.push(
          "DATABASE_URL points at port 6543, the transaction pooler. Advisory locks are " +
            "session scoped and do not survive it, so two keepers could run on one account. " +
            "Use the session pooler on port 5432.",
        );
      }
    } catch {
      problems.push("DATABASE_URL is not a valid URL.");
    }
  }

  const probeTxRaw = first(env, ["NUVEM_KEEPER_PROBE_TX", "NUVEM_PROBE_TX"]);
  const probeTxHash =
    probeTxRaw && /^0x[0-9a-fA-F]{64}$/.test(probeTxRaw) ? (probeTxRaw as `0x${string}`) : null;
  if (probeTxRaw && probeTxHash === null) {
    problems.push(`NUVEM_PROBE_TX must be a 32-byte transaction hash, got ${shape(probeTxRaw)}.`);
  }

  // --- chain -----------------------------------------------------------------
  const chainIdRaw = first(env, ["NUVEM_KEEPER_CHAIN_ID", "NUVEM_CHAIN_ID"]);
  const chainId = Number(chainIdRaw ?? MAINNET.chainId);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    problems.push(`NUVEM_CHAIN_ID must be a positive integer, got ${shape(chainIdRaw ?? "")}.`);
  }

  // --- the trading account ---------------------------------------------------
  const accountRaw = options.accountOverride ?? first(env, ["NUVEM_KEEPER_ACCOUNT", "NUVEM_TRADING_ACCOUNT"]);
  if (!accountRaw) {
    problems.push(
      "The trading account is required (--account 0x… or NUVEM_KEEPER_ACCOUNT). " +
        "SettlementExecutor resolves the vault from msg.sender, so this address IS the settler.",
    );
  }
  const account = address(accountRaw, "0x0000000000000000000000000000000000000000", "NUVEM_KEEPER_ACCOUNT", problems);

  // --- addresses -------------------------------------------------------------
  const factory = address(first(env, ["NUVEM_VAULT_FACTORY"]), MAINNET.factory, "NUVEM_VAULT_FACTORY", problems);
  const executor = address(first(env, ["NUVEM_SETTLEMENT_EXECUTOR"]), MAINNET.executor, "NUVEM_SETTLEMENT_EXECUTOR", problems);
  const vault = address(first(env, ["NUVEM_KEEPER_VAULT", "NUVEM_VAULT"]), MAINNET.vault, "NUVEM_KEEPER_VAULT", problems);
  const pauseController = address(first(env, ["NUVEM_PAUSE_CONTROLLER"]), MAINNET.pauseController, "NUVEM_PAUSE_CONTROLLER", problems);
  const attesterRegistry = address(first(env, ["NUVEM_ATTESTER_REGISTRY"]), MAINNET.attesterRegistry, "NUVEM_ATTESTER_REGISTRY", problems);
  const weth = address(first(env, ["NUVEM_WETH"]), MAINNET.weth, "NUVEM_WETH", problems);

  // --- state -----------------------------------------------------------------
  const stateDir = first(env, ["NUVEM_KEEPER_STATE_DIR"]) ?? ".keeper-state";
  const fromBlockL2 = positiveBigInt(first(env, ["NUVEM_KEEPER_FROM_BLOCK"]), 0n, "NUVEM_KEEPER_FROM_BLOCK", problems);
  // Public endpoints commonly cap the eth_getLogs range. Recovery scans
  // SettlementExecuted from here, so keep it near the vault's deployment era
  // rather than at genesis.
  const logsFromBlockL2 = positiveBigInt(
    first(env, ["NUVEM_KEEPER_LOGS_FROM_BLOCK", "NUVEM_LOGS_FROM_BLOCK"]),
    0n,
    "NUVEM_KEEPER_LOGS_FROM_BLOCK",
    problems,
  );

  // --- limits ----------------------------------------------------------------
  const limits: KeeperLimits = {
    pollMs: positiveNumber(first(env, ["NUVEM_KEEPER_POLL_MS"]), 30_000, "NUVEM_KEEPER_POLL_MS", problems),
    finalityMarginL2: positiveBigInt(first(env, ["NUVEM_KEEPER_FINALITY_MARGIN_L2"]), 64n, "NUVEM_KEEPER_FINALITY_MARGIN_L2", problems),
    l1Margin: positiveBigInt(first(env, ["NUVEM_KEEPER_L1_MARGIN"]), 2n, "NUVEM_KEEPER_L1_MARGIN", problems),
    maxVerifySpanBlocks: positiveBigInt(first(env, ["NUVEM_KEEPER_MAX_VERIFY_SPAN_BLOCKS"]), 20_000n, "NUVEM_KEEPER_MAX_VERIFY_SPAN_BLOCKS", problems),
    maxTickScanSpanBlocks: positiveBigInt(first(env, ["NUVEM_KEEPER_MAX_TICK_SCAN_SPAN_BLOCKS"]), 2_000n, "NUVEM_KEEPER_MAX_TICK_SCAN_SPAN_BLOCKS", problems),
    maxContributionWei: positiveBigInt(first(env, ["NUVEM_KEEPER_MAX_CONTRIBUTION_WEI"]), 1_000_000_000_000_000n, "NUVEM_KEEPER_MAX_CONTRIBUTION_WEI", problems),
    maxSettlementsPerDay: positiveNumber(first(env, ["NUVEM_KEEPER_MAX_SETTLEMENTS_PER_DAY"]), 8, "NUVEM_KEEPER_MAX_SETTLEMENTS_PER_DAY", problems),
    maxRpcCallsPerTick: positiveNumber(first(env, ["NUVEM_KEEPER_MAX_RPC_CALLS_PER_TICK"]), 5_000, "NUVEM_KEEPER_MAX_RPC_CALLS_PER_TICK", problems),
    gasHeadroom: positiveBigInt(first(env, ["NUVEM_KEEPER_GAS_HEADROOM"]), 2n, "NUVEM_KEEPER_GAS_HEADROOM", problems),
  };
  if (limits.maxVerifySpanBlocks === 0n) problems.push("NUVEM_KEEPER_MAX_VERIFY_SPAN_BLOCKS must be non-zero.");
  if (limits.maxContributionWei === 0n) problems.push("NUVEM_KEEPER_MAX_CONTRIBUTION_WEI must be non-zero.");
  // RETIRED 2026-08-29, AND SAID OUT LOUD RATHER THAN DELETED IN SILENCE.
  //
  // This was an absolute ceiling on a single settlement and attest.ts no longer
  // consults it: a fixed wei amount cannot tell a bug from a good trade, and in
  // production it halted two accounts for earning 0.019 ETH against a 0.001 ETH
  // limit picked in a lab. The check that replaced it is derived from the vault's
  // own policy, so there is nothing left to tune.
  //
  // The variable is still PARSED so that a deployment which sets it keeps
  // starting — pulling it out from under a running Railway service would turn a
  // stale setting into a refusal to boot. But an operator who sets it is asking
  // for a protection that no longer exists, and silence would let them believe
  // they had it.
  if (first(env, ["NUVEM_KEEPER_MAX_CONTRIBUTION_WEI"]) !== undefined) {
    warnings.push(
      "NUVEM_KEEPER_MAX_CONTRIBUTION_WEI is retired and ignored. A settlement is now bounded by " +
        "the vault's own policy (profit x savingsBps, maxPerSettlementWei, maxRolling30dWei), " +
        "which scales with the user instead of needing a number chosen in advance. Unset it.",
    );
  }

  // --- the heartbeat surface -------------------------------------------------
  // Absent or 0 means no HTTP server. The container image sets both; a one-shot
  // `tick` on a laptop should not bind a port just to exit again.
  const httpPortRaw = first(env, ["NUVEM_KEEPER_HTTP_PORT"]);
  let httpPort: number | null = null;
  if (httpPortRaw !== undefined && httpPortRaw !== "0") {
    const parsed = Number(httpPortRaw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
      problems.push(`NUVEM_KEEPER_HTTP_PORT must be a port number or 0, got ${shape(httpPortRaw)}.`);
    } else {
      httpPort = parsed;
    }
  }

  // --- keys ------------------------------------------------------------------
  const attesterKey = readKey(
    env,
    ["NUVEM_ATTESTER_KEY_FILE"],
    ["NUVEM_ATTESTER_PRIVATE_KEY"],
    "attesterKey",
    problems,
    readFileSync,
    redactor,
  );
  if (attesterKey) redactor.register(attesterKey);
  if (options.requireAttesterKey !== false && attesterKey === null) {
    problems.push(
      "An attester key is required to build an attestation. Set NUVEM_ATTESTER_KEY_FILE " +
        "(preferred) or NUVEM_ATTESTER_PRIVATE_KEY.",
    );
  }

  // The spending key is EXPOSED only in live mode. See the header comment: that is
  // the mechanical half of "dry run by default", and it is unchanged — outside
  // live mode `config.tradingKey` is null, so the process holds nothing a signer
  // can be built from.
  //
  // What it is not any more is UNREAD. It is read in every mode, which is what
  // takes it out of process.env and puts it in the Redactor's needle set; only the
  // handover is gated. Complaints about a malformed value are gated too: outside
  // live mode a broken spending key is not a reason to refuse to start, because
  // nothing is going to use it — but it is worth a warning, because the operator
  // who set it clearly meant to arm the keeper.
  const tradingProblems: string[] = [];
  const tradingKeyFound = readKey(
    env,
    ["NUVEM_TRADING_KEY_FILE"],
    ["TRADING_OWNER_PRIVATE_KEY", "NUVEM_TRADING_OWNER_PRIVATE_KEY"],
    "tradingKey",
    tradingProblems,
    readFileSync,
    redactor,
  );
  if (tradingKeyFound) redactor.register(tradingKeyFound);
  const tradingKey: Secret | null = mode === "live" ? tradingKeyFound : null;
  if (mode === "live") {
    problems.push(...tradingProblems);
    // A Privy signer satisfies the same requirement WITHOUT the key: the wallet
    // signs inside Privy under a policy, so msg.sender is still the trading
    // account. Demanding a raw key here would make the non-custodial path
    // unusable, which is the opposite of the point.
    // Both spellings, because the key is generated by a script that has to name
    // it somewhere and a near-miss is invisible until live mode: the value is
    // present, correct and simply not looked at, so the keeper reports "no
    // signer" while the operator is looking straight at one in their .env.
    const privySigner =
      env.PRIVY_APP_ID !== undefined &&
      env.PRIVY_APP_SECRET !== undefined &&
      first(env, ["PRIVY_AUTHORIZATION_KEY", "PRIVY_AUTHORIZATION_PRIVATE_KEY"]) !== undefined &&
      env.PRIVY_WALLET_ID !== undefined;
    if (tradingKey === null && !privySigner) {
      problems.push(
        "Live mode needs something that can sign AS the trading account, because " +
          "SettlementExecutor.settle resolves the vault from msg.sender. Either set a Privy " +
          "signer (PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_AUTHORIZATION_KEY, PRIVY_WALLET_ID), " +
          "which keeps the key inside Privy, or the account's own key " +
          "(NUVEM_TRADING_KEY_FILE / TRADING_OWNER_PRIVATE_KEY), which is total custody of it.",
      );
    }
  } else if (tradingProblems.length > 0) {
    warnings.push(
      "A trading-key variable is set but is not usable, and dry-run mode does not need it. " +
        "It has been removed from the environment and registered for redaction. " +
        tradingProblems.join(" "),
    );
  }

  // Scrubbed on the way out. Nothing above interpolates a value into a message —
  // that is the actual fix — and this is the guarantee that stays true if someone
  // later forgets, because bin/keeper.mts writes both of these arrays straight to
  // stderr before any logger exists.
  const scrub = (text: string): string => redactor.scrub(text);

  if (problems.length > 0) return { ok: false, problems: problems.map(scrub), redactor };

  return {
    ok: true,
    warnings: warnings.map(scrub),
    config: {
      mode,
      rpcUrl,
      rpcHost,
      rpcFallbackUrls,
      rpcFallbackHosts,
      alertWebhook: alertWebhook ? new Secret(alertWebhook, "alertWebhook") : null,
      probeTxHash,
      databaseUrl: databaseUrlRaw ? new Secret(databaseUrlRaw, "databaseUrl") : null,
      chainId,
      account,
      factory,
      executor,
      vault,
      pauseController,
      attesterRegistry,
      weth,
      stateDir,
      fromBlockL2,
      logsFromBlockL2,
      limits,
      attesterKey,
      tradingKey,
      redactor,
      printCalldata: options.printCalldata === true,
      httpHost: httpPort === null ? null : first(env, ["NUVEM_KEEPER_HTTP_HOST"]) ?? "127.0.0.1",
      httpPort,
      gitSha: first(env, ["NUVEM_KEEPER_GIT_SHA", "GIT_SHA", "RAILWAY_GIT_COMMIT_SHA"]) ?? "unknown",
    },
  };
}

/** Fields of the config that are safe to put in a log line or /status payload. */
export function describeConfig(config: KeeperConfig): Record<string, unknown> {
  return {
    mode: config.mode,
    chainIdExpected: config.chainId,
    rpcHost: config.rpcHost,
    account: config.account,
    vault: config.vault,
    executor: config.executor,
    factory: config.factory,
    stateDir: config.stateDir,
    fromBlockL2: config.fromBlockL2.toString(),
    attesterKeyPresent: config.attesterKey !== null,
    tradingKeyPresent: config.tradingKey !== null,
    limits: {
      pollMs: config.limits.pollMs,
      finalityMarginL2: config.limits.finalityMarginL2.toString(),
      l1Margin: config.limits.l1Margin.toString(),
      maxVerifySpanBlocks: config.limits.maxVerifySpanBlocks.toString(),
      maxContributionWei: config.limits.maxContributionWei.toString(),
      maxSettlementsPerDay: config.limits.maxSettlementsPerDay,
      maxRpcCallsPerTick: config.limits.maxRpcCallsPerTick,
      gasHeadroom: config.limits.gasHeadroom.toString(),
    },
    gitSha: config.gitSha,
  };
}
