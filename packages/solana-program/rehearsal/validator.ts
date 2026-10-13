// A throwaway solana-test-validator for this package's on-chain proofs, on its
// own ports, with every key made here and nothing of it left behind.
//
// WHY NOT `anchor test`. It binds 8899, which parallel sessions use, and its
// validator is left to read the operator's ~/.config/solana. This one follows
// the keeper's test-local/local-validator.ts: --mint names a key generated
// here, -C names a config written into the temporary directory, HOME points
// there too, and the child's environment loses every SIP_SOLANA_* and ANCHOR_*
// name. Nothing here reads a key it did not write.
//
// THE PORTS ARE ITS OWN, OR IT DOES NOT START. RPC 28999 (websocket 29000),
// faucet 29999, gossip 30099, dynamic 30199-30299: clear of anchor test's 8899,
// the deploy drill's 18899 and the keeper's local proof at 18999. A busy port
// is reported by number and left alone; this file never stops a process it did
// not spawn. SIP_REHEARSAL_RPC_PORT moves the whole block.
//
// THE CLI IS ALWAYS GIVEN THE URL, THE CONFIG AND THE KEY. solanaCli() runs
// `solana -C <temp config> -u <this validator> -k <a key written here>`, so a
// command can never fall back to the operator's cluster or keypair.
//
// STOPPED EVEN WHEN A TEST FAILS: SIGTERM to the spawned PID, SIGKILL after
// 10 s, then the temporary directory, ledger and keys included, is removed.

import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

export const SIP_VAULT_PROGRAM_ID = new PublicKey("6kA9H9zQT6PW5xWkXoAFCS3NotxarzaYqj66mjMf9w4J");
export const TOY_VENUE_PROGRAM_ID = new PublicKey("GxTSkuWudYQZpoyeD88tfx8LLWfcU1x213AAv3kraTYH");
export const UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

/** sha256 of the sip_vault.so published to mainnet on 2026-09-15 (563,656 bytes). */
export const DEPLOYED_PROGRAM_SHA256 = "60e94348d7cf841ac4542b356ed1719047c33256a96894e3a12bdf32c63de823";

export const PACKAGE_DIR = join(__dirname, "..");
export const PYTH_FIXTURE_DIR = join(PACKAGE_DIR, "tests", "fixtures", "pyth");

const READY_TIMEOUT_MS = 90_000;
const STOP_GRACE_MS = 10_000;

export function rehearsalPorts() {
  const rpc = Number(process.env.SIP_REHEARSAL_RPC_PORT || 28_999);
  if (!Number.isInteger(rpc) || rpc < 1_024 || rpc > 60_000) throw new Error("SIP_REHEARSAL_RPC_PORT is not a port between 1024 and 60000");
  return { rpc, websocket: rpc + 1, faucet: rpc + 1_000, gossip: rpc + 1_100, dynamicFirst: rpc + 1_200, dynamicLast: rpc + 1_300 };
}

export const sha256File = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

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

function childEnvironment(home?: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith("SIP_SOLANA_") || name.startsWith("ANCHOR_")) continue;
    environment[name] = value;
  }
  if (home !== undefined) environment.HOME = home;
  return environment;
}

/** The Pyth fixture accounts every proof preloads: tests/fixtures/pyth/*.json, by the address each file names. */
export function pythFixtureAccounts(): { address: string; file: string }[] {
  return readdirSync(PYTH_FIXTURE_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const file = join(PYTH_FIXTURE_DIR, name);
      return { address: (JSON.parse(readFileSync(file, "utf8")) as { pubkey: string }).pubkey, file };
    });
}

export const pythFixture = (name: string): PublicKey =>
  new PublicKey((JSON.parse(readFileSync(join(PYTH_FIXTURE_DIR, `${name}.json`), "utf8")) as { pubkey: string }).pubkey);

export interface PreloadedProgram {
  readonly id: PublicKey;
  readonly so: string;
  /** Upgradeable by this key; preloaded with --upgradeable-program. */
  readonly authority: PublicKey;
}

export interface ValidatorOptions {
  readonly programs: readonly PreloadedProgram[];
  readonly accounts?: readonly { address: string; file: string }[];
  /** The genesis mint, which holds the cluster's SOL. */
  readonly mint: PublicKey;
  /**
   * Copy mainnet's ACTIVE FEATURE SET into genesis (--clone-feature-set), so a
   * loader instruction behaves as it would on mainnet. A read of public
   * feature accounts from https://api.mainnet-beta.solana.com, nothing else.
   */
  readonly mainnetFeatures?: boolean;
}

export interface Validator {
  readonly connection: Connection;
  readonly rpcUrl: string;
  /** A directory removed at stop(), for keys and files a proof writes. */
  readonly dir: string;
  /** Writes a keypair into dir() and returns its path, for the CLI. */
  keyFile(name: string, keypair: Keypair): string;
  /** `solana -C <dir config> -u <rpcUrl> -k <keyFile> …args`. */
  solanaCli(keyFile: string, args: readonly string[], timeoutMs?: number): SpawnSyncReturns<string>;
  stop(): Promise<{ exited: boolean; rpcRefused: boolean; dirGone: boolean }>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function startValidator(options: ValidatorOptions): Promise<Validator> {
  if (!process.versions.node.startsWith("22.")) throw new Error(`Node 22 is required; this is Node ${process.versions.node}`);
  const version = spawnSync("solana-test-validator", ["--version"], { encoding: "utf8", env: childEnvironment() });
  if (version.error !== undefined || version.status !== 0) throw new Error("solana-test-validator is not on PATH");
  const ports = rehearsalPorts();
  const portList = [ports.rpc, ports.websocket, ports.faucet, ports.gossip];
  const busy: number[] = [];
  for (const port of portList) if (!(await tcpRefused(port))) busy.push(port);
  if (busy.length > 0) throw new Error(`refusing to start: port(s) ${busy.join(", ")} are in use; nothing was stopped`);

  const base = process.env.SIP_REHEARSAL_TMPDIR || tmpdir();
  const dir = mkdtempSync(join(base, "sip-vault-rehearsal-"));
  const ledger = join(dir, "ledger");
  const home = join(dir, "home");
  mkdirSync(home);
  const rpcUrl = `http://127.0.0.1:${ports.rpc}`;
  const cliConfig = join(dir, "cli-config.yml");
  // Every field solana needs to parse it, and a keypair_path that does not
  // exist: with an incomplete file the CLI would fall back to the default config.
  writeFileSync(
    cliConfig,
    ["---", `json_rpc_url: "${rpcUrl}"`, `websocket_url: "ws://127.0.0.1:${ports.websocket}/"`, `keypair_path: "${join(dir, "no-signer")}"`, "address_labels: {}", "commitment: confirmed", ""].join("\n"),
  );

  const args = [
    "--reset",
    "--quiet",
    "--ledger",
    ledger,
    "--bind-address",
    "127.0.0.1",
    "--rpc-port",
    String(ports.rpc),
    "--faucet-port",
    String(ports.faucet),
    "--gossip-port",
    String(ports.gossip),
    "--dynamic-port-range",
    `${ports.dynamicFirst}-${ports.dynamicLast}`,
    "--mint",
    options.mint.toBase58(),
    "--config",
    cliConfig,
  ];
  for (const program of options.programs) args.push("--upgradeable-program", program.id.toBase58(), program.so, program.authority.toBase58());
  for (const account of options.accounts ?? []) args.push("--account", account.address, account.file);
  if (options.mainnetFeatures === true) args.push("--url", "https://api.mainnet-beta.solana.com", "--clone-feature-set");

  const child = spawn("solana-test-validator", args, { env: childEnvironment(home), stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const keep = (chunk: Buffer): void => {
    output = (output + chunk.toString("utf8")).slice(-16_000);
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
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

  let stopped: Promise<{ exited: boolean; rpcRefused: boolean; dirGone: boolean }> | null = null;
  const stop = () =>
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
      return { exited: hasExited(), rpcRefused: await tcpRefused(ports.rpc), dirGone: !existsSync(dir) };
    })());

  const keyFile = (name: string, keypair: Keypair): string => {
    const path = join(dir, `${name}.json`);
    writeFileSync(path, JSON.stringify(Array.from(keypair.secretKey)), { mode: 0o600 });
    return path;
  };
  const solanaCli = (key: string, cliArgs: readonly string[], timeoutMs = 600_000): SpawnSyncReturns<string> =>
    spawnSync("solana", ["-C", cliConfig, "-u", rpcUrl, "-k", key, ...cliArgs], {
      encoding: "utf8",
      env: { ...childEnvironment(home), NO_COLOR: "1" },
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });

  const connection = new Connection(rpcUrl, { commitment: "confirmed" });
  try {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      if (hasExited()) throw new Error(`solana-test-validator exited (code ${child.exitCode}) before it served`);
      const ready = await Promise.all(options.programs.map((program) => connection.getAccountInfo(program.id).catch(() => null)));
      // A program loaded at genesis is executable at once but invocable only
      // from a later slot ("Program is not deployed" before that).
      const slot = await connection.getSlot().catch(() => 0);
      if (ready.every((account) => account?.executable === true) && slot >= 2) break;
      if (Date.now() >= deadline) throw new Error(`the validator did not serve every program within ${READY_TIMEOUT_MS / 1_000} s`);
      await sleep(500);
    }
  } catch (error) {
    const logPath = join(ledger, "validator.log");
    const logTail = existsSync(logPath) ? readFileSync(logPath, "utf8").slice(-4_000) : "(no validator.log)";
    await stop();
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n--- output ---\n${output.slice(-4_000)}\n--- log ---\n${logTail}`);
  }
  return { connection, rpcUrl, dir, keyFile, solanaCli, stop };
}

/** ProgramData's address, length, lamports, upgrade authority and the ELF bytes it holds (from byte 45). */
export async function readProgramData(connection: Connection, programId: PublicKey) {
  const [address] = PublicKey.findProgramAddressSync([programId.toBuffer()], UPGRADEABLE_LOADER);
  const account = await connection.getAccountInfo(address, "confirmed");
  if (account === null || account.data.readUInt32LE(0) !== 3) throw new Error(`no ProgramData at ${address.toBase58()}`);
  const authority = account.data[12] === 1 ? new PublicKey(account.data.subarray(13, 45)) : null;
  return { address, length: account.data.length, lamports: account.lamports, authority, elf: account.data.subarray(45) };
}

/** Whether ProgramData holds exactly `binary` followed only by zero bytes. */
export function holdsBinary(elf: Buffer, binary: Buffer): boolean {
  return elf.length >= binary.length && elf.subarray(0, binary.length).equals(binary) && elf.subarray(binary.length).every((byte) => byte === 0);
}
