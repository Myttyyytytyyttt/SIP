// A throwaway solana-test-validator running the tested sip_vault binary, for the
// web's local proof, and nothing of it left behind once the proof is done.
//
// AN ADAPTED COPY of packages/solana-keeper/test-local/local-validator.ts, which
// is neither imported nor edited: its ports are fixed at 18999, where the keeper's
// own proof runs. This one binds 28999 (RPC), 29000 (its websocket), 29999
// (faucet), 30099 (gossip) and 30199-30299 (dynamic), and clones four accounts
// from mainnet, read-only: the USDC and SPYx mints and the two Raydium pools the
// vault screens price from; and one program with its executable data: Lighthouse,
// whose checks Phantom adds on mainnet (immutable there: no upgrade authority).
//
// THE BINARY IS THE ONE PUBLISHED, OR NOTHING STARTS. The .so comes from
// SIP_LOCAL_PROGRAM_SO, or ../../solana-program/target/deploy/sip_vault.so, and is
// refused unless its sha256 is the tested hash. It is preloaded at the program's
// real id with --upgradeable-program, and the ProgramData the validator serves is
// compared with those bytes once it is up. A path from the environment is named
// by its variable, never echoed.
//
// EVERY KEY IS MADE IN MEMORY, AND NONE OF THE OPERATOR'S IS READ. The upgrade
// authority reaches the validator as a base58 pubkey; --mint names a generated
// pubkey; -C names a config written into the temporary directory whose keypair
// path does not exist; HOME points there too. The child's environment loses
// every SIP_*, PRIVY_*, NUVEM_* and ANCHOR_* name.
//
// THE PORTS ARE ITS OWN, OR IT DOES NOT START. A port something else holds is
// reported by number and left alone: this file never stops a process it did not
// spawn. STOPPED EVEN WHEN A TEST FAILS: stop() runs from afterAll, and exit and
// signal hooks cover a worker that goes down first; SIGTERM to the spawned PID
// only, SIGKILL after 10 s, then the temporary directory is removed.
//
// CLONING READS MAINNET'S PUBLIC RPC, which throttles. A start that fails while
// cloning is tried once more, then fails loudly.
//
// PRELOADED ACCOUNTS. A caller may hand accounts to load at genesis (--account):
// the local proof gives the vault a SPYx holding built from a copy of a real
// Token-2022 account, since no freeze or mint authority is available locally.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createSocket } from "node:dgram";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { LIGHTHOUSE_PROGRAM, SOL_USDC_POOL, SPYX_MINT, SPYX_USDC_POOL, USDC_MINT } from "@sip/solana-core/client";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

/** sha256 of the sip_vault.so that was tested and is published to mainnet unchanged. */
export const TESTED_PROGRAM_SHA256 = "60e94348d7cf841ac4542b356ed1719047c33256a96894e3a12bdf32c63de823";

export const SIP_VAULT_PROGRAM_ID = new PublicKey("6kA9H9zQT6PW5xWkXoAFCS3NotxarzaYqj66mjMf9w4J");

export const LOCAL_PORTS = { rpc: 28_999, websocket: 29_000, faucet: 29_999, gossip: 30_099, dynamicFirst: 30_199, dynamicLast: 30_299 } as const;

/** What the validator clones from mainnet at start: the mints an owner-paid token account needs, and the pools the floors read. */
export const MAINNET_CLONES: readonly string[] = [USDC_MINT, SPYX_MINT, SOL_USDC_POOL, SPYX_USDC_POOL];
/** Upgradeable programs it clones with their executable data: Lighthouse, so Phantom's checks run on the real program. */
export const MAINNET_PROGRAM_CLONES: readonly string[] = [LIGHTHOUSE_PROGRAM];
const MAINNET_RPC = "https://api.mainnet-beta.solana.com";

const DEFAULT_PROGRAM_SO = fileURLToPath(new URL("../../solana-program/target/deploy/sip_vault.so", import.meta.url));
const UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const READY_TIMEOUT_MS = 120_000;
const STOP_GRACE_MS = 10_000;
const OUTPUT_TAIL_CHARS = 16_000;
const REFUSED_PREFIXES = ["SIP_", "PRIVY_", "NUVEM_", "ANCHOR_"];

export interface StoppedValidator {
  readonly exited: boolean;
  readonly rpcRefused: boolean;
  readonly tempDirGone: boolean;
}

export interface LocalValidator {
  /** HTTP only; nothing here opens a websocket. */
  readonly connection: Connection;
  readonly rpcUrl: string;
  /** Idempotent. */
  stop(): Promise<StoppedValidator>;
}

/** An account preloaded at genesis with --account: the JSON solana-test-validator reads, written into the temporary directory. */
export interface PreloadedAccount {
  readonly pubkey: string;
  readonly json: unknown;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The binary to preload, refused unless it is the tested one. */
export function testedProgramBinary(): string {
  const fromEnvironment = process.env.SIP_LOCAL_PROGRAM_SO;
  const path = fromEnvironment === undefined || fromEnvironment === "" ? DEFAULT_PROGRAM_SO : fromEnvironment;
  const named = path === DEFAULT_PROGRAM_SO ? DEFAULT_PROGRAM_SO : "the file SIP_LOCAL_PROGRAM_SO names";
  if (!existsSync(path)) throw new Error(`${named} does not exist: the local proof runs only the tested sip_vault.so, and never builds one`);
  const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (sha256 !== TESTED_PROGRAM_SHA256) throw new Error(`refusing ${named}: its sha256 is ${sha256}, not the tested ${TESTED_PROGRAM_SHA256}`);
  return path;
}

export function localPortList(): number[] {
  const ports: number[] = [LOCAL_PORTS.rpc, LOCAL_PORTS.websocket, LOCAL_PORTS.faucet, LOCAL_PORTS.gossip];
  for (let port = LOCAL_PORTS.dynamicFirst; port <= LOCAL_PORTS.dynamicLast; port++) ports.push(port);
  return ports;
}

/** Whether a TCP connect to `port` on `host` is refused: nothing listens there. An address family the machine lacks counts as refused. */
export function tcpRefused(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    socket.setTimeout(2_000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => resolve(["ECONNREFUSED", "EADDRNOTAVAIL", "ENETUNREACH", "EAFNOSUPPORT"].includes(error.code ?? "")));
  });
}

function tcpBindable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

function udpBindable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createSocket("udp4");
    socket.once("error", () => {
      socket.close();
      resolve(false);
    });
    socket.bind({ address: "127.0.0.1", port, exclusive: true }, () => socket.close(() => resolve(true)));
  });
}

/** The ports something else holds: a TCP connect, a TCP bind and a UDP bind per port, one port at a time. */
export async function busyPorts(): Promise<number[]> {
  const verdicts = await Promise.all(localPortList().map(async (port) => ((await tcpRefused(port)) && (await tcpBindable(port)) && (await udpBindable(port)) ? null : port)));
  return verdicts.filter((port): port is number => port !== null);
}

function childEnvironment(home?: string): NodeJS.ProcessEnv {
  const environment: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (REFUSED_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    environment[name] = value;
  }
  if (home !== undefined) environment.HOME = home;
  // This process's own environment, less the refused names: NODE_ENV comes along when it was set.
  return environment as NodeJS.ProcessEnv;
}

/** The validator serves the tested bytes, upgradeable by `authority` (the loader's bincode layout, as the keeper's copy reads it). */
async function checkPreloadedProgram(connection: Connection, authority: PublicKey, binary: Buffer): Promise<void> {
  const [programData] = PublicKey.findProgramAddressSync([SIP_VAULT_PROGRAM_ID.toBuffer()], UPGRADEABLE_LOADER);
  const program = await connection.getAccountInfo(SIP_VAULT_PROGRAM_ID, "confirmed");
  if (program === null || !program.owner.equals(UPGRADEABLE_LOADER) || program.data.length < 36 || program.data.readUInt32LE(0) !== 2 || !new PublicKey(program.data.subarray(4, 36)).equals(programData)) {
    throw new Error(`the program account at ${SIP_VAULT_PROGRAM_ID.toBase58()} is not an upgradeable program pointing at ${programData.toBase58()}`);
  }
  const data = (await connection.getAccountInfo(programData, "confirmed"))?.data;
  if (data === undefined || data.length < 45 || data.readUInt32LE(0) !== 3 || data[12] !== 1) throw new Error(`ProgramData ${programData.toBase58()} is missing or records no upgrade authority`);
  const recorded = new PublicKey(data.subarray(13, 45));
  if (!recorded.equals(authority)) throw new Error(`ProgramData names upgrade authority ${recorded.toBase58()}, not this run's ${authority.toBase58()}`);
  const elf = data.subarray(45);
  if (elf.length < binary.length || !elf.subarray(0, binary.length).equals(binary) || elf.subarray(binary.length).some((byte) => byte !== 0)) {
    throw new Error("the ProgramData the validator serves does not hold the tested binary's bytes");
  }
}

async function startOnce(authority: PublicKey, so: string, binary: Buffer, preloaded: readonly PreloadedAccount[]): Promise<LocalValidator> {
  const busy = await busyPorts();
  if (busy.length > 0) throw new Error(`refusing to start: port(s) ${busy.join(", ")} are in use. Nothing was stopped.`);

  const dir = mkdtempSync(join(tmpdir(), "sip-web-proof-"));
  const ledger = join(dir, "ledger");
  const home = join(dir, "home");
  mkdirSync(home);
  const cliConfig = join(dir, "cli-config.yml");
  const rpcUrl = `http://127.0.0.1:${LOCAL_PORTS.rpc}`;
  writeFileSync(
    cliConfig,
    ["---", `json_rpc_url: "${rpcUrl}"`, `websocket_url: "ws://127.0.0.1:${LOCAL_PORTS.websocket}/"`, `keypair_path: "${join(dir, "no-signer")}"`, "address_labels: {}", "commitment: confirmed", ""].join("\n"),
  );
  const accountArgs = preloaded.flatMap((account) => {
    const file = join(dir, `${account.pubkey}.account.json`);
    writeFileSync(file, JSON.stringify(account.json));
    return ["--account", account.pubkey, file];
  });

  const args = [
    "--reset",
    "--quiet",
    "--ledger",
    ledger,
    "--bind-address",
    "127.0.0.1",
    "--rpc-port",
    String(LOCAL_PORTS.rpc),
    "--faucet-port",
    String(LOCAL_PORTS.faucet),
    "--gossip-port",
    String(LOCAL_PORTS.gossip),
    "--dynamic-port-range",
    `${LOCAL_PORTS.dynamicFirst}-${LOCAL_PORTS.dynamicLast}`,
    "--mint",
    Keypair.generate().publicKey.toBase58(),
    "--config",
    cliConfig,
    "--url",
    MAINNET_RPC,
    ...MAINNET_CLONES.flatMap((address) => ["--clone", address]),
    ...MAINNET_PROGRAM_CLONES.flatMap((address) => ["--clone-upgradeable-program", address]),
    ...accountArgs,
    "--upgradeable-program",
    SIP_VAULT_PROGRAM_ID.toBase58(),
    so,
    authority.toBase58(),
  ];
  const child = spawn("solana-test-validator", args, { env: childEnvironment(home), stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const keep = (chunk: Buffer): void => {
    output = (output + chunk.toString("utf8")).slice(-OUTPUT_TAIL_CHARS);
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  child.once("error", (error) => keep(Buffer.from(`spawn error: ${error.message}\n`)));

  const logPath = join(ledger, "validator.log");
  const hasExited = (): boolean => child.exitCode !== null || child.signalCode !== null;
  const exitWithin = (ms: number): Promise<boolean> =>
    new Promise((resolve) => {
      if (hasExited()) return resolve(true);
      const onExit = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        child.off("exit", onExit);
        resolve(hasExited());
      }, ms);
      child.once("exit", onExit);
    });

  const killNow = (): void => {
    if (!hasExited()) child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    killNow();
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.once("exit", killNow);
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  let stopped: Promise<StoppedValidator> | null = null;
  const stop = (): Promise<StoppedValidator> =>
    (stopped ??= (async () => {
      process.off("exit", killNow);
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      if (!hasExited()) {
        child.kill("SIGTERM");
        if (!(await exitWithin(STOP_GRACE_MS))) {
          child.kill("SIGKILL");
          await exitWithin(STOP_GRACE_MS);
        }
      }
      rmSync(dir, { recursive: true, force: true });
      return { exited: hasExited(), rpcRefused: await tcpRefused(LOCAL_PORTS.rpc), tempDirGone: !existsSync(dir) };
    })());

  const connection = new Connection(rpcUrl, { commitment: "confirmed", disableRetryOnRateLimit: true });
  try {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      if (hasExited()) throw new Error(`solana-test-validator exited (code ${child.exitCode}, signal ${child.signalCode}) before the program was executable`);
      const account = await connection.getAccountInfo(SIP_VAULT_PROGRAM_ID, "confirmed").catch(() => null);
      if (account?.executable === true) break;
      if (Date.now() >= deadline) throw new Error(`the program account was not executable within ${READY_TIMEOUT_MS / 1_000} s of the spawn`);
      await sleep(500);
    }
    await checkPreloadedProgram(connection, authority, binary);
    for (const address of MAINNET_CLONES) {
      if ((await connection.getAccountInfo(new PublicKey(address), "confirmed")) === null) throw new Error(`the clone of ${address} is missing`);
    }
    for (const address of MAINNET_PROGRAM_CLONES) {
      if ((await connection.getAccountInfo(new PublicKey(address), "confirmed"))?.executable !== true) throw new Error(`the cloned program ${address} is not executable`);
    }
    for (const account of preloaded) {
      if ((await connection.getAccountInfo(new PublicKey(account.pubkey), "confirmed")) === null) throw new Error(`the preloaded account ${account.pubkey} is missing`);
    }
  } catch (error) {
    const logTail = existsSync(logPath) ? readFileSync(logPath, "utf8").slice(-4_000) : "(no validator.log was written)";
    await stop();
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n--- validator output ---\n${output.slice(-4_000)}\n--- validator.log tail ---\n${logTail}`);
  }
  return { connection, rpcUrl, stop };
}

/**
 * Starts the validator with the tested binary preloaded, upgradeable by
 * `authority`, and returns once the program is executable, its ProgramData
 * checked and the clones present. Fails loudly, never as a skip.
 */
export async function startLocalValidator(authority: PublicKey, options: { readonly accounts?: readonly PreloadedAccount[] } = {}): Promise<LocalValidator> {
  if (!process.versions.node.startsWith("22.")) throw new Error(`the local proof needs Node 22; this is Node ${process.versions.node}`);
  const version = spawnSync("solana-test-validator", ["--version"], { encoding: "utf8", env: childEnvironment() });
  if (version.error !== undefined || version.status !== 0) throw new Error("solana-test-validator is not on PATH, or `solana-test-validator --version` failed");
  const so = testedProgramBinary();
  const binary = readFileSync(so);
  const preloaded = options.accounts ?? [];
  try {
    return await startOnce(authority, so, binary, preloaded);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (!/429|too many requests|rate limit|clone|failed to fetch/i.test(text)) throw error;
    // Mainnet's public RPC throttles: one more try, then the failure stands.
    await sleep(10_000);
    return startOnce(authority, so, binary, preloaded);
  }
}
