// A throwaway solana-test-validator running the tested sip_vault binary, and
// nothing of it left behind once the proof is done.
//
// THE BINARY IS THE ONE PUBLISHED, OR NOTHING STARTS. The proof says something
// only about the bytes that go to mainnet, so the .so comes from
// SIP_LOCAL_PROGRAM_SO, or target/deploy/sip_vault.so under the repository root,
// and is refused unless its sha256 is the tested hash. It is preloaded at the
// program's real id with --upgradeable-program, and the ProgramData the
// validator serves is compared with those bytes once it is up. Nothing here
// runs anchor build, test or deploy: anchor test builds first, and a build can
// replace the tested binary.
//
// EVERY KEY IS MADE IN MEMORY, AND NONE OF THE OPERATOR'S IS READ. The upgrade
// authority reaches the validator as a base58 pubkey, which
// solana-test-validator 3.1.12 accepts where a keypair path would go. Left to
// its defaults, the validator loads ~/.config/solana/cli/config.yml and then the
// keypair it names, to pick the genesis mint; so --mint names a generated pubkey,
// -C names a config written into the temporary directory, and HOME points there
// too. The child's environment also loses every SIP_SOLANA_* and ANCHOR_* name.
//
// THE PORTS ARE ITS OWN, OR IT DOES NOT START. 18999 (RPC), 19000 (its
// websocket), 19999 (faucet), 20099 (gossip) and 20199-20299 (dynamic) sit clear
// of anchor test's 8899 and the deploy drill's 18899, both of which parallel
// sessions run. A port something else holds is reported by number and left
// alone: this file never stops a process it did not spawn, and never by name.
//
// STOPPED EVEN WHEN A TEST FAILS. stop() runs from afterAll, and the exit and
// signal hooks installed at start cover a worker that goes down first: SIGTERM to
// the spawned PID only, SIGKILL after 10 s, then the temporary directory, ledger
// and all, is removed.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createSocket } from "node:dgram";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { pollingConfirm } from "./polling-confirm.js";

/** sha256 of the sip_vault.so that was tested and is published to mainnet unchanged. */
export const TESTED_PROGRAM_SHA256 = "60e94348d7cf841ac4542b356ed1719047c33256a96894e3a12bdf32c63de823";

/** sip-vault's program id, the one the published binary declares. */
export const SIP_VAULT_PROGRAM_ID = new PublicKey("6kA9H9zQT6PW5xWkXoAFCS3NotxarzaYqj66mjMf9w4J");

export const LOCAL_PORTS = {
  rpc: 18_999,
  websocket: 19_000,
  faucet: 19_999,
  gossip: 20_099,
  dynamicFirst: 20_199,
  dynamicLast: 20_299,
} as const;

const DEFAULT_PROGRAM_SO = fileURLToPath(new URL("../../solana-program/target/deploy/sip_vault.so", import.meta.url));
const UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
/** How long the program account may take to appear, executable, after the spawn. */
const READY_TIMEOUT_MS = 60_000;
/** How long SIGTERM is given before SIGKILL. */
const STOP_GRACE_MS = 10_000;
/** The validator's own stdout and stderr kept in memory, for a start that fails. */
const OUTPUT_TAIL_CHARS = 16_000;

export interface StoppedValidator {
  /** The spawned process has exited: exitCode or signalCode is set. */
  readonly exited: boolean;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  /** A TCP connect to 127.0.0.1:18999 is refused now. */
  readonly rpcRefused: boolean;
  /** The temporary directory, ledger included, no longer exists. */
  readonly tempDirGone: boolean;
  /** Where the validator's log was copied with SIP_LOCAL_KEEP_LOG=1, or null. */
  readonly keptLog: string | null;
}

export interface LocalValidator {
  /** HTTP only: confirmTransaction polls, and nothing here opens a websocket. */
  readonly connection: Connection;
  readonly pid: number;
  /** The validator's log while it runs, inside the directory stop() removes. Public keys only. */
  readonly logPath: string;
  /** Idempotent: a second call returns the first call's report. */
  stop(): Promise<StoppedValidator>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The binary to preload, refused unless it is the tested one.
 *
 * NAMED, NOT ECHOED. A path taken from SIP_LOCAL_PROGRAM_SO is referred to by the
 * variable's name in every message, so an environment value is never printed.
 */
export function testedProgramBinary(): string {
  const fromEnvironment = process.env.SIP_LOCAL_PROGRAM_SO;
  const path = fromEnvironment === undefined || fromEnvironment === "" ? DEFAULT_PROGRAM_SO : fromEnvironment;
  const named = path === DEFAULT_PROGRAM_SO ? DEFAULT_PROGRAM_SO : "the file SIP_LOCAL_PROGRAM_SO names";
  if (!existsSync(path)) {
    throw new Error(`${named} does not exist: the local proof runs only the tested sip_vault.so, and never builds one`);
  }
  const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (sha256 !== TESTED_PROGRAM_SHA256) {
    throw new Error(`refusing ${named}: its sha256 is ${sha256}, not the tested ${TESTED_PROGRAM_SHA256}`);
  }
  return path;
}

/** Every port the validator binds, in the order they are named above. */
export function localPortList(): number[] {
  const ports: number[] = [LOCAL_PORTS.rpc, LOCAL_PORTS.websocket, LOCAL_PORTS.faucet, LOCAL_PORTS.gossip];
  for (let port = LOCAL_PORTS.dynamicFirst; port <= LOCAL_PORTS.dynamicLast; port++) ports.push(port);
  return ports;
}

/** Whether a TCP connect to the port on loopback is refused: nothing listens there. */
export function tcpRefused(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(2_000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => resolve(error.code === "ECONNREFUSED"));
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

/**
 * The ports something else holds.
 *
 * THREE LOOKS PER PORT, ONE AT A TIME. A connect that is not refused is a TCP
 * listener, on loopback or on every address. A bind is the only way to see a UDP
 * socket, and the TCP bind catches a socket that is bound and not listening.
 * Sequential per port, so the check's own listener is never what the connect
 * finds.
 */
export async function busyPorts(): Promise<number[]> {
  const verdicts = await Promise.all(
    localPortList().map(async (port) => ((await tcpRefused(port)) && (await tcpBindable(port)) && (await udpBindable(port)) ? null : port)),
  );
  return verdicts.filter((port): port is number => port !== null);
}

/** The child's environment: this process's, without a single SIP_SOLANA_* or ANCHOR_* name. */
function childEnvironment(home?: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith("SIP_SOLANA_") || name.startsWith("ANCHOR_")) continue;
    environment[name] = value;
  }
  if (home !== undefined) environment.HOME = home;
  return environment;
}

/**
 * Checks the validator is serving the tested bytes, upgradeable by `authority`.
 *
 * THE LOADER'S OWN LAYOUT, bincode: a u32 variant tag, then for Program (2) the
 * ProgramData address, and for ProgramData (3) a u64 slot, an Option<Pubkey>
 * upgrade authority and, from byte 45, the ELF. init_config reads that authority,
 * so a mismatch here is every setup step failing later with NotUpgradeAuthority.
 */
async function checkPreloadedProgram(connection: Connection, authority: PublicKey, binary: Buffer): Promise<void> {
  const [programData] = PublicKey.findProgramAddressSync([SIP_VAULT_PROGRAM_ID.toBuffer()], UPGRADEABLE_LOADER);
  const program = await connection.getAccountInfo(SIP_VAULT_PROGRAM_ID, "confirmed");
  if (
    program === null ||
    !program.owner.equals(UPGRADEABLE_LOADER) ||
    program.data.length < 36 ||
    program.data.readUInt32LE(0) !== 2 ||
    !new PublicKey(program.data.subarray(4, 36)).equals(programData)
  ) {
    throw new Error(`the program account at ${SIP_VAULT_PROGRAM_ID.toBase58()} is not an upgradeable program pointing at ${programData.toBase58()}`);
  }
  const data = (await connection.getAccountInfo(programData, "confirmed"))?.data;
  if (data === undefined || data.length < 45 || data.readUInt32LE(0) !== 3 || data[12] !== 1) {
    throw new Error(`ProgramData ${programData.toBase58()} is missing or records no upgrade authority`);
  }
  const recorded = new PublicKey(data.subarray(13, 45));
  if (!recorded.equals(authority)) {
    throw new Error(`ProgramData names upgrade authority ${recorded.toBase58()}, not this run's ${authority.toBase58()}`);
  }
  const elf = data.subarray(45);
  if (elf.length < binary.length || !elf.subarray(0, binary.length).equals(binary) || elf.subarray(binary.length).some((byte) => byte !== 0)) {
    throw new Error("the ProgramData the validator serves does not hold the tested binary's bytes");
  }
}

/**
 * Starts the validator with the tested binary preloaded, upgradeable by
 * `authority`, and returns once the program is executable and its ProgramData
 * checked. Fails loudly, never as a skip: a Node that is not 22, no
 * solana-test-validator on PATH, a binary that is not the tested one, or a busy
 * port each stop the run before anything is spawned.
 */
export async function startLocalValidator(authority: PublicKey): Promise<LocalValidator> {
  if (!process.versions.node.startsWith("22.")) {
    throw new Error(`the local proof needs Node 22 (@solana/web3.js does not load on Node 20); this is Node ${process.versions.node}`);
  }
  const version = spawnSync("solana-test-validator", ["--version"], { encoding: "utf8", env: childEnvironment() });
  if (version.error !== undefined || version.status !== 0) {
    throw new Error("solana-test-validator is not on PATH, or `solana-test-validator --version` failed");
  }
  const so = testedProgramBinary();
  const binary = readFileSync(so);
  const busy = await busyPorts();
  if (busy.length > 0) {
    throw new Error(
      `refusing to start: port(s) ${busy.join(", ")} are in use. Nothing was stopped; ` +
        "free them, or wait for whatever holds them to finish",
    );
  }

  const dir = mkdtempSync(join(tmpdir(), "sip-local-proof-"));
  const ledger = join(dir, "ledger");
  const home = join(dir, "home");
  mkdirSync(home);
  const cliConfig = join(dir, "cli-config.yml");
  const rpcUrl = `http://127.0.0.1:${LOCAL_PORTS.rpc}`;
  const websocketUrl = `ws://127.0.0.1:${LOCAL_PORTS.websocket}`;
  // No signer in it: keypair_path names a file that does not exist, and --mint
  // below means the validator never looks for one anyway.
  writeFileSync(
    cliConfig,
    [
      "---",
      `json_rpc_url: "${rpcUrl}"`,
      `websocket_url: "${websocketUrl}/"`,
      `keypair_path: "${join(dir, "no-signer")}"`,
      "address_labels: {}",
      "commitment: confirmed",
      "",
    ].join("\n"),
  );

  const child = spawn(
    "solana-test-validator",
    [
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
      "--upgradeable-program",
      SIP_VAULT_PROGRAM_ID.toBase58(),
      so,
      authority.toBase58(),
    ],
    { env: childEnvironment(home), stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  const keep = (chunk: Buffer): void => {
    output = (output + chunk.toString("utf8")).slice(-OUTPUT_TAIL_CHARS);
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  child.once("error", (error) => keep(Buffer.from(`spawn error: ${error.message}\n`)));

  // --quiet sends the validator's log to <ledger>/validator.log.
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

  // THE LAST RESORT, SYNCHRONOUS. An exit hook cannot wait for SIGTERM to be
  // honoured, so it kills outright; a signal hook does the same and exits with
  // the signal's conventional status.
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
      let keptLog: string | null = null;
      if (process.env.SIP_LOCAL_KEEP_LOG === "1" && existsSync(logPath)) {
        keptLog = join(tmpdir(), `sip-local-validator-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
        copyFileSync(logPath, keptLog);
        console.log(`local proof: the validator's log is kept at ${keptLog} (public keys only)`);
      }
      rmSync(dir, { recursive: true, force: true });
      return {
        exited: hasExited(),
        exitCode: child.exitCode,
        signalCode: child.signalCode,
        rpcRefused: await tcpRefused(LOCAL_PORTS.rpc),
        tempDirGone: !existsSync(dir),
        keptLog,
      };
    })());

  const connection = pollingConfirm(new Connection(rpcUrl, { commitment: "confirmed", wsEndpoint: websocketUrl }));
  try {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      if (hasExited()) {
        throw new Error(`solana-test-validator exited (code ${child.exitCode}, signal ${child.signalCode}) before the program was executable`);
      }
      const account = await connection.getAccountInfo(SIP_VAULT_PROGRAM_ID, "confirmed").catch(() => null);
      if (account?.executable === true) break;
      if (Date.now() >= deadline) {
        throw new Error(`the program account was not executable within ${READY_TIMEOUT_MS / 1_000} s of the spawn`);
      }
      await sleep(500);
    }
    await checkPreloadedProgram(connection, authority, binary);
  } catch (error) {
    // A START THAT FAILED STOPS WHAT IT STARTED, and says why in the
    // validator's own words: afterAll has no handle to stop it with.
    const logTail = existsSync(logPath) ? readFileSync(logPath, "utf8").slice(-4_000) : "(no validator.log was written)";
    await stop();
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n--- validator output ---\n${output.slice(-4_000)}\n--- validator.log tail ---\n${logTail}`,
    );
  }

  return { connection, pid: child.pid ?? -1, logPath, stop };
}
