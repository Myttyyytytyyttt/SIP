#!/usr/bin/env node
// The binary: `tick` runs one pass and prints its summary; `run` passes every
// config.pollMs with a heartbeat line per pass. Dry run by default.
//
// WHAT IS WIRED HERE AND NOWHERE ELSE: the config, the logger, the RPC failover
// over the configured endpoints, the ledger (Postgres, or memory when no
// database is configured), and the two signers. The pass itself lives in
// src/tick.ts and is tested there; this file has no tests, so it holds no
// logic beyond choosing between the things it wires.
//
// THE SIGNERS ARE WHERE THE MODE BITES (DESIGN.md §0.1, §0.2):
// - live: the attester key from config (read only under the byte-exact
//   sentinel) signs attestations and holds no funds; the Privy seat signs the
//   wallet's own pull inside the app's policy. This process never holds a
//   trading key.
// - dry run: no key exists in this process at all. The attester is a stand-in
//   that borrows the REGISTERED attester's address from AttesterRegistry and
//   answers every signature with 65 zero bytes. That lets the pass run the
//   attestation preflight, the digest cross-check and the contribution
//   preview for real — "everything except signing and sending" (§6) — while
//   submitPull returns DRY_RUN before any signer is touched, so the placeholder
//   never reaches the chain and could not validate there if it did. The seat is
//   null: nothing in dry run may be able to sign a pull.

import { decodeAbiParameters, toFunctionSelector } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import type { AttesterSigner } from "../src/attest/phase0.js";
import { ConfigError, loadConfig } from "../src/config.js";
import { memoryLedger, openPgLedger } from "../src/ledger/pg.js";
import { createLogger, type Logger } from "../src/log.js";
import { privySeatSigner, type SeatSigner } from "../src/pull/privy.js";
import { httpRpcClient } from "../src/rpc/client.js";
import { failoverRpcClient } from "../src/rpc/failover.js";
import { runLoop, runTick, type TickDeps } from "../src/tick.js";
import type { Address, Hex, RpcClient, WorkerConfig } from "../src/types.js";

const USAGE = "usage: worker <tick|run>\n  tick  one pass, print the TickSummary as JSON, exit\n  run   a pass every SIP_POLL_MS with a heartbeat line per pass\n";

/**
 * EXIT 2 IS "YOU HAVE TO CHANGE SOMETHING", and it is the whole point of the
 * problem list: a stack trace over an environment variable tells the operator
 * nothing they can act on, and a supervisor that sees a crash will restart into
 * the identical misconfiguration for as long as it is deployed.
 */
function refuseToStart(what: string, error: unknown): never {
  process.stderr.write(`${what}\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}

const command = process.argv[2] ?? "tick";
let config: WorkerConfig;
try {
  config = loadConfig(process.env);
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  refuseToStart("The worker's configuration is not usable:", error);
}
const log = createLogger({
  json: process.stdout.isTTY !== true,
  base: { service: "sip-worker", mode: config.mode, chainId: config.chainId },
});
log.info("worker.start", {
  command,
  mode: config.mode,
  chainId: config.chainId,
  rpcEndpoints: config.rpcUrls.length,
  ledger: config.databaseUrl === null ? "memory" : "postgres",
  pollMs: config.pollMs,
  finalityMarginL2: config.finalityMarginL2,
  maxLogSpan: config.maxLogSpan,
  factory: config.factory,
  executor: config.executor,
});

if (command !== "tick" && command !== "run") {
  process.stderr.write(USAGE);
  process.exit(2);
}

// ── wiring ──────────────────────────────────────────────────────────────────

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const lower = (address: string): Address => address.toLowerCase() as Address;

/** Endpoints are identified by position, never by URL — a key lives in the URL's path. */
const rpc: RpcClient = failoverRpcClient(
  config.rpcUrls.map((url) => httpRpcClient(url)),
  {
    // ALL_FAILED is not a degraded read, it is the chain gone: no endpoint
    // answered, the pass is blind, and nothing is being skimmed. At warn it
    // sits in the same bucket as the ordinary switch that costs nothing.
    onEvent: (event) => {
      if (event.kind === "ALL_FAILED") log.error("rpc.failover", { ...event });
      else if (event.kind === "RECOVERED") log.info("rpc.failover", { ...event });
      else log.warn("rpc.failover", { ...event });
    },
  },
);

/** The registered attester's address, read the way keeper-old/src/onchain.ts read it (AttesterRegistry.attester()). */

/** The attester registry this deployment was configured with, straight from the factory. */
async function attesterRegistryOf(client: RpcClient, config: WorkerConfig): Promise<Address> {
  const data = toFunctionSelector("protocolConfiguration()");
  const raw = await client.call<unknown>("eth_call", [{ to: config.factory, data }, "latest"]);
  if (typeof raw !== "string" || raw.length < 2 + 64 * 4) {
    throw new Error(`VaultFactory ${config.factory} did not answer protocolConfiguration(); is it a SIP factory?`);
  }
  const [, , attesterRegistry] = decodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }],
    raw as Hex,
  );
  return attesterRegistry.toLowerCase() as Address;
}

async function registeredAttester(client: RpcClient): Promise<Address> {
  const data: Hex = toFunctionSelector("attester()");
  // THE REGISTRY IS THE FACTORY'S, NOT A CONSTANT. Nuvem pinned it; SIP asks the
  // configured factory which registry its own protocol was configured with, so a
  // worker can never read the attester of one deployment while settling into
  // another.
  const registry = await attesterRegistryOf(client, config);
  const result = await client.call<unknown>("eth_call", [{ to: registry, data }, "latest"]);
  if (typeof result !== "string" || result.length < 66) {
    throw new Error(`AttesterRegistry ${registry} returned no data for attester(); is the factory address right?`);
  }
  const [attester] = decodeAbiParameters([{ type: "address" }], result as Hex);
  return lower(attester);
}

/** 65 zero bytes: shaped like a signature, valid nowhere. */
const PLACEHOLDER_SIGNATURE: Hex = `0x${"00".repeat(65)}`;

async function makeAttester(cfg: WorkerConfig, client: RpcClient, logger: Logger): Promise<AttesterSigner | null> {
  if (cfg.mode === "live") {
    if (cfg.attesterPrivateKey === null) {
      // loadConfig refuses this combination; the check stays because an armed
      // worker that cannot attest would otherwise run and only find out per wallet.
      throw new Error("live mode without an attester key: refusing to start");
    }
    const account = privateKeyToAccount(cfg.attesterPrivateKey);
    // Wrapped so the signer surface is exactly the one attest/phase0.ts
    // declares: nothing else on a LocalAccount is reachable, and the key is
    // never handed to another module (keeper-old keeper-supervisor.mts).
    return {
      address: lower(account.address),
      signTypedData: (args) => account.signTypedData(args as never),
    };
  }
  try {
    const address = await registeredAttester(client);
    logger.info("attester.dry_run", { address, detail: "borrowing the registered attester's address; signatures are placeholders" });
    return { address, signTypedData: async () => PLACEHOLDER_SIGNATURE };
  } catch (error) {
    // Without an address the preflight cannot be rehearsed; the pass says so
    // per window (attest.blocked) rather than this process refusing to start.
    logger.warn("attester.unavailable", { detail: describe(error) });
    return null;
  }
}

function makeSeat(cfg: WorkerConfig): SeatSigner | null {
  if (cfg.mode !== "live" || cfg.privy === null) return null;
  return privySeatSigner({
    appId: cfg.privy.appId,
    appSecret: cfg.privy.appSecret,
    authorizationPrivateKey: cfg.privy.authorizationPrivateKey,
    // Omitting this threw inside seatSignerOver at module load, so arming the
    // worker killed it before the first pass every time.
    signerId: cfg.privy.signerId,
  });
}

/**
 * The mode and the identity are what make the lock legible: `application_name`
 * says which worker holds it (an unlabelled holder reads as "dry-run", so a
 * live worker that omits the mode reports itself as the harmless one), and the
 * identity pin refuses a database that was written by a worker watching a
 * different chain, factory or executor.
 */
async function openLedger() {
  if (config.databaseUrl === null) return memoryLedger();
  try {
    return await openPgLedger(config.databaseUrl, {
      mode: config.mode,
      identity: { chainId: config.chainId, factory: config.factory, executor: config.executor },
    });
  } catch (error) {
    // Held by someone else, pinned to another deployment, or simply unreachable:
    // none of them gets better by trying the pass anyway.
    log.error("ledger.unavailable", { detail: describe(error) });
    refuseToStart("The worker cannot take the ledger:", error);
  }
}

const ledger = await openLedger();
const deps: TickDeps = {
  rpc,
  ledger,
  config,
  log,
  attester: await makeAttester(config, rpc, log),
  seat: makeSeat(config),
};

const jsonReplacer = (_key: string, value: unknown): unknown => (typeof value === "bigint" ? value.toString() : value);

async function closeQuietly(): Promise<void> {
  try {
    await ledger.close();
  } catch (error) {
    log.warn("ledger.close_failed", { detail: describe(error) });
  }
}

// ── commands ────────────────────────────────────────────────────────────────

if (command === "tick") {
  try {
    const summary = await runTick(deps);
    process.stdout.write(`${JSON.stringify(summary, jsonReplacer)}\n`);
    await closeQuietly();
    process.exit(0);
  } catch (error) {
    log.error("worker.tick_failed", { detail: describe(error) });
    await closeQuietly();
    process.exit(1);
  }
}

const stop = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    log.info("worker.signal", { signal });
    stop.abort();
  });
}
try {
  await runLoop(deps, { pollMs: config.pollMs, signal: stop.signal });
} catch (error) {
  // The loop only ends this way when it can no longer be the single writer
  // (a lost ledger connection takes the advisory lock with it). Non-zero, so
  // the supervisor restarts a worker that takes the lock afresh.
  log.error("worker.exit", { detail: describe(error) });
  await closeQuietly();
  process.exit(1);
}
await closeQuietly();
process.exit(0);
