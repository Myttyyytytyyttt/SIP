// The SIP program's admin verbs. scripts/sip-deploy.sh is the door: it checks
// the keys, the cluster and the binary, asks for confirmation, then runs one of
// these. Run alone, this file still refuses what matters: the wrong cluster, the
// wrong key, a Nuvem-era variable.
//
//   status [--allow-unconfigured]   read-only; exit 1 when anything differs from the decision below
//   init-config                     init_config(attester = settle), then set_keeper(settle)
//   set-keeper <address>            11111111111111111111111111111111 names nobody: owner-only cranking
//   set-attester <address>
//   pause | unpause                 set_protocol_paused; never gates withdraw, withdraw_token or unlink
//
// THE DECISION THIS CHECKS (owner, 2026-09-14): TWO KEYS. The admin wallet is
// the deployer, the upgrade authority and the config authority, and it never
// goes to a server; on mainnet it is pinned below. The settle wallet is the
// attester and the keeper, and its secret lives only in Railway. So: upgrade
// authority == config authority == admin, attester == keeper == settle, and
// admin != settle.
//
// ENVIRONMENT (sip-deploy.sh sets all of it):
//   SIP_DEPLOY_RPC           one RPC URL. Never printed: a Helius URL carries its key.
//   SIP_DEPLOY_CLUSTER       unset = mainnet only; "localnet" = a validator on this machine only
//   SIP_ADMIN_PUBKEY         the admin wallet's address; on mainnet only OWNER_ADMIN
//   SIP_ADMIN_KEYPAIR        its file, read only by the verbs that sign
//   SIP_SETTLE_PUBKEY        the settle wallet's address
//   SIP_PROGRAM_SO           the local binary (default target/deploy/sip_vault.so)
//   SIP_EXPECTED_SO_SHA256   when set, status also checks the local binary is the tested one
//   SIP_PROGRAM_ID           default: the IDL's address; any other id on localnet only
//   SIP_DEPLOY_CU_PRICE      priority fee, micro-lamports per compute unit (default 20000)

import { AnchorProvider, Program, Wallet, utils, type Idl } from "@coral-xyz/anchor";
import { ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
/** The owner's admin wallet. Moving the admin on mainnet is a code change, on purpose. */
const OWNER_ADMIN = new PublicKey("EE46GmYqiKwMve9qyriRYQ5MjQ4wR6t5kDA9B92VfGXg");
const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
/** As a keeper this names nobody: only a vault's own owner may crank it. */
const NOBODY = PublicKey.default;
// UpgradeableLoaderState is bincode: a u32 tag, then the variant's fields.
const TAG_PROGRAM = 2;
const TAG_PROGRAMDATA = 3;
/** tag u32 · slot u64 · Option tag u8 · authority 32. The loader keeps all 45 bytes even when the authority is None. */
const PROGRAMDATA_HEADER = 45;
/** Below this the keeper pays for few settlements. A warning, not a failure. */
const SETTLE_LOW_LAMPORTS = 0.05 * LAMPORTS_PER_SOL;
const POLL_MS = 500;
/** How long a read-back waits for an RPC node that lags behind the confirmation. */
const READ_BACK_ATTEMPTS = 20;
/** Refusals a node one slot behind can give. Nothing was sent, so signing again is safe. */
const TRANSIENT_REFUSAL = /blockhash not found|AccountNotInitialized|could not find account|account not found/i;
const SEND_ATTEMPTS = 3;
/** Past this, an RPC whose block height has stopped moving is not waited on any longer. */
const CONFIRM_WALL_MS = 120_000;

const PACKAGE = join(__dirname, "..");
const IDL = JSON.parse(readFileSync(join(PACKAGE, "idl", "sip_vault.json"), "utf8")) as Idl;

/** Refused before anything was sent. Exit code 3, so the shell can tell it apart from a transaction that failed. */
class Refused extends Error {}

type Cluster = "mainnet" | "localnet";

interface ProtocolConfig {
  authority: PublicKey;
  attester: PublicKey;
  keeper: PublicKey;
  pendingAuthority: PublicKey;
  paused: boolean;
  version: number;
}

interface Deployment {
  programData: PublicKey;
  slot: bigint;
  authority: PublicKey | null;
  /** Everything after the 45-byte header: the binary, then zero padding up to the account's size. */
  elf: Buffer;
  lamports: number;
}

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

/**
 * Never echoes its input: a secret key pasted into the wrong variable must not
 * reach the terminal. The round trip is the test, because a short string like
 * "1" decodes too and would name the all-zero key.
 */
function address(name: string, raw: string | undefined): PublicKey {
  if (raw === undefined) throw new Refused(`${name} is not set`);
  let key: PublicKey | undefined;
  try {
    key = new PublicKey(raw);
  } catch {
    key = undefined;
  }
  if (key === undefined || key.toBase58() !== raw) throw new Refused(`${name} is not a base58 address (the value is not shown)`);
  return key;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "<unparseable url>";
  }
}

/** Every line printed passes here: web3.js errors can quote the request URL, and a Helius URL carries its key. */
function redact(text: string): string {
  const url = env("SIP_DEPLOY_RPC");
  const withoutUrl = url === undefined ? text : text.split(url).join(`<rpc ${hostOf(url)}>`);
  return withoutUrl.replace(/(api-key|api_key|apikey)=[^&\s"']+/gi, "$1=<redacted>");
}

const say = (line: string): void => console.log(redact(line));
const sol = (lamports: number): string => `${(lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL`;
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const oneLine = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
const configAddress = (programId: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([Buffer.from("config")], programId)[0];

async function connect(): Promise<{ connection: Connection; cluster: Cluster }> {
  const url = env("SIP_DEPLOY_RPC");
  if (url === undefined) throw new Refused("SIP_DEPLOY_RPC is not set (sip-deploy.sh takes it from SIP_SOLANA_RPC_URLS)");
  if (!/^https?:\/\/[A-Za-z0-9.-]+(:[0-9]+)?([/?#]|$)/.test(url)) {
    throw new Refused("SIP_DEPLOY_RPC does not start with http(s)://host (the value is not shown)");
  }
  const connection = new Connection(url, "confirmed");
  let genesis: string;
  try {
    genesis = await connection.getGenesisHash();
  } catch {
    throw new Refused(`the RPC at ${hostOf(url)} did not answer getGenesisHash`);
  }
  const wanted = env("SIP_DEPLOY_CLUSTER");
  if (genesis === MAINNET_GENESIS) {
    if (wanted !== undefined) throw new Refused(`SIP_DEPLOY_CLUSTER=${wanted} but ${hostOf(url)} is mainnet: unset it to act on mainnet`);
    return { connection, cluster: "mainnet" };
  }
  if (wanted !== "localnet") {
    throw new Refused(`${hostOf(url)} is not mainnet (genesis ${genesis.slice(0, 8)}…); a local drill sets SIP_DEPLOY_CLUSTER=localnet`);
  }
  if (!["127.0.0.1", "localhost"].includes(hostOf(url))) {
    throw new Refused("SIP_DEPLOY_CLUSTER=localnet only works against a validator on this machine");
  }
  return { connection, cluster: "localnet" };
}

function programIdFor(cluster: Cluster): PublicKey {
  const declared = new PublicKey((IDL as unknown as { address: string }).address);
  const raw = env("SIP_PROGRAM_ID");
  if (raw === undefined) return declared;
  const id = address("SIP_PROGRAM_ID", raw);
  if (!id.equals(declared) && cluster !== "localnet") {
    throw new Refused(`SIP_PROGRAM_ID ${id} is not the program's id ${declared}: another id is for local drills only`);
  }
  return id;
}

function adminAddress(cluster: Cluster): PublicKey {
  const admin = address("SIP_ADMIN_PUBKEY", env("SIP_ADMIN_PUBKEY"));
  if (cluster === "mainnet" && !admin.equals(OWNER_ADMIN)) {
    throw new Refused(`on mainnet the admin wallet is ${OWNER_ADMIN}, the owner's, and SIP_ADMIN_PUBKEY names ${admin}`);
  }
  return admin;
}

async function readDeployment(connection: Connection, programId: PublicKey): Promise<Deployment | null> {
  const program = await connection.getAccountInfo(programId);
  if (program === null) return null;
  if (
    !program.owner.equals(LOADER) ||
    !program.executable ||
    program.data.length < 36 ||
    program.data.readUInt32LE(0) !== TAG_PROGRAM
  ) {
    throw new Refused(`${programId} exists but is not a program of the upgradeable loader`);
  }
  const programData = new PublicKey(program.data.subarray(4, 36));
  const derived = PublicKey.findProgramAddressSync([programId.toBuffer()], LOADER)[0];
  if (!programData.equals(derived)) throw new Refused(`${programId} points at ProgramData ${programData}, not ${derived}`);
  const account = await connection.getAccountInfo(programData);
  if (account === null || account.data.length < PROGRAMDATA_HEADER || account.data.readUInt32LE(0) !== TAG_PROGRAMDATA) {
    throw new Refused(`the ProgramData account ${programData} is missing or malformed`);
  }
  return {
    programData,
    slot: account.data.readBigUInt64LE(4),
    authority: account.data[12] === 1 ? new PublicKey(account.data.subarray(13, PROGRAMDATA_HEADER)) : null,
    elf: account.data.subarray(PROGRAMDATA_HEADER),
    lamports: account.lamports,
  };
}

/** A read-only program handle gets a throwaway wallet: nothing it builds is ever signed. */
function programAt(connection: Connection, programId: PublicKey, signer?: Keypair): Program {
  const provider = new AnchorProvider(connection, new Wallet(signer ?? Keypair.generate()), { commitment: "confirmed" });
  return new Program({ ...IDL, address: programId.toBase58() } as Idl, provider);
}

async function readConfig(program: Program): Promise<ProtocolConfig | null> {
  const accounts = program.account as unknown as Record<string, { fetchNullable(key: PublicKey): Promise<unknown> }>;
  return (await accounts.protocolConfig.fetchNullable(configAddress(program.programId))) as ProtocolConfig | null;
}

async function status(allowUnconfigured: boolean): Promise<number> {
  const { connection, cluster } = await connect();
  const programId = programIdFor(cluster);
  const admin = adminAddress(cluster);
  const settleRaw = env("SIP_SETTLE_PUBKEY");
  const settle = settleRaw === undefined ? undefined : address("SIP_SETTLE_PUBKEY", settleRaw);
  const expected = env("SIP_EXPECTED_SO_SHA256")?.toLowerCase();

  let failures = 0;
  const row = (mark: string, label: string, detail: string): void => say(`  ${mark} ${label.padEnd(20)} ${detail}`);
  const pass = (label: string, detail: string): void => row("✓", label, detail);
  const note = (label: string, detail: string): void => row("·", label, detail);
  const fail = (label: string, detail: string): void => {
    failures += 1;
    row("✗", label, detail);
  };
  const named = (key: PublicKey): string => {
    if (key.equals(NOBODY)) return "nobody";
    if (key.equals(admin)) return `${key} (admin)`;
    if (settle?.equals(key)) return `${key} (settle)`;
    return key.toBase58();
  };
  const verdict = (): number => {
    say(failures === 0 ? "\nall checks pass" : `\n${failures} check(s) failed`);
    return failures === 0 ? 0 : 1;
  };

  say(`\nprogram ${programId} on ${cluster}`);
  const deployment = await readDeployment(connection, programId);
  if (deployment === null) {
    fail("deployed", "no: nothing at this address yet");
    return verdict();
  }
  note("ProgramData", `${deployment.programData} · last deployed at slot ${deployment.slot} · rent ${sol(deployment.lamports)}`);
  if (deployment.authority === null) fail("upgrade authority", "none: the program was made immutable");
  else if (deployment.authority.equals(admin)) pass("upgrade authority", named(deployment.authority));
  else fail("upgrade authority", `${deployment.authority}, not the admin wallet ${admin}`);

  say("\nbytes");
  const soPath = env("SIP_PROGRAM_SO") ?? join(PACKAGE, "target", "deploy", "sip_vault.so");
  let local: Buffer | null = null;
  try {
    local = readFileSync(soPath);
  } catch {
    fail("local binary", `none at ${soPath}`);
  }
  if (local !== null) {
    const localSha = sha256(local);
    note("local binary", `${soPath} · ${local.length} bytes · sha256 ${localSha}`);
    if (expected !== undefined) {
      if (expected === localSha) pass("tested binary", "the local binary's sha256 is SIP_EXPECTED_SO_SHA256");
      else fail("tested binary", `the local binary is not the tested binary (SIP_EXPECTED_SO_SHA256 is ${expected})`);
    }
    if (deployment.elf.length < local.length) {
      fail("on chain", `room for ${deployment.elf.length} bytes, less than the local ${local.length}: a different program`);
    } else {
      const chainSha = sha256(deployment.elf.subarray(0, local.length));
      const tail = deployment.elf.subarray(local.length);
      if (chainSha === localSha) pass("on chain", `the first ${local.length} bytes have the same sha256`);
      else fail("on chain", `sha256 ${chainSha}: the deployed bytes are not the local binary`);
      // A longer binary once deployed and then shrunk would leave bytes here.
      if (tail.every((byte) => byte === 0)) pass("padding", `${tail.length} bytes after the binary, all zero`);
      else fail("padding", `non-zero bytes after the first ${local.length}: a longer binary is deployed`);
    }
  }

  say("\nconfig");
  const config = await readConfig(programAt(connection, programId));
  if (config === null) {
    if (allowUnconfigured) note("config", "not initialised yet; next: sip-deploy.sh configure");
    else fail("config", "not initialised: run sip-deploy.sh configure");
  } else {
    note("address", configAddress(programId).toBase58());
    if (config.authority.equals(admin)) pass("authority", named(config.authority));
    else fail("authority", `${config.authority}, not the admin wallet ${admin}`);
    if (settle === undefined) {
      fail("attester / keeper", `attester ${named(config.attester)} · keeper ${named(config.keeper)}: SIP_SETTLE_PUBKEY is not set, so neither is checked`);
    } else {
      if (config.attester.equals(settle)) pass("attester", named(config.attester));
      else fail("attester", `${named(config.attester)}, not the settle wallet ${settle}`);
      if (config.keeper.equals(settle)) pass("keeper", named(config.keeper));
      else fail("keeper", `${named(config.keeper)}, not the settle wallet ${settle}`);
    }
    if (config.pendingAuthority.equals(NOBODY)) pass("pending authority", "none");
    else fail("pending authority", `a transfer to ${config.pendingAuthority} is waiting to be accepted`);
    if (config.paused) fail("protocol", "PAUSED: settle, link, wrap, convert and invest are stopped; withdrawals still work");
    else pass("protocol", "running");
    note("version", String(config.version));
  }

  say("\nwallets");
  if (settle !== undefined) {
    if (settle.equals(admin)) fail("two keys", "the settle wallet IS the admin wallet");
    else pass("two keys", "admin and settle are different wallets");
  }
  note("admin", `${admin} · ${sol(await connection.getBalance(admin))}`);
  if (settle !== undefined) {
    const lamports = await connection.getBalance(settle);
    row(lamports < SETTLE_LOW_LAMPORTS ? "!" : "·", "settle", `${settle} · ${sol(lamports)}${lamports < SETTLE_LOW_LAMPORTS ? ": low for the keeper's fees" : ""}`);
  }
  return verdict();
}

function loadAdmin(cluster: Cluster): Keypair {
  const path = env("SIP_ADMIN_KEYPAIR");
  if (path === undefined) throw new Refused("SIP_ADMIN_KEYPAIR is not set");
  const expected = adminAddress(cluster);
  let keypair: Keypair;
  try {
    keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]));
  } catch {
    // Not the parser's message: JSON.parse quotes the text around the error, and this text is a secret key.
    throw new Refused(`could not read a keypair from ${path}`);
  }
  if (!keypair.publicKey.equals(expected)) {
    throw new Refused(`${path} holds ${keypair.publicKey}, not the admin wallet ${expected}`);
  }
  return keypair;
}

function logsOf(error: unknown): string[] | undefined {
  const holder = (error ?? {}) as { logs?: unknown; transactionLogs?: unknown };
  return [holder.logs, holder.transactionLogs].find(Array.isArray) as string[] | undefined;
}

/** Only a preflight simulation that failed means the RPC kept the transaction to itself. */
function refusedBySimulation(error: unknown): boolean {
  return (logsOf(error)?.length ?? 0) > 0 || /simulation failed/i.test(oneLine(error));
}

/** The Anchor error a simulation logged, by name when the IDL knows its code. */
function programError(error: unknown): string {
  const logs = logsOf(error) ?? [];
  for (const line of logs) {
    const match = /Error Code: (\w+)\. Error Number: (\d+)\. Error Message: (.*?)\.?$/.exec(line);
    if (match) return `${match[1]} (${match[2]}): ${match[3]}`;
  }
  const message = oneLine(error);
  const custom = /custom program error: (0x[0-9a-f]+)/i.exec([message, ...logs].join("\n"));
  if (custom?.[1] !== undefined) {
    const code = Number.parseInt(custom[1], 16);
    const known = (IDL.errors ?? []).find((entry) => entry.code === code);
    return known === undefined ? `custom program error ${code}` : `${known.name} (${code}): ${known.msg ?? ""}`;
  }
  return message;
}

/**
 * Signs, sends and confirms by polling getSignatureStatuses over HTTP, never a
 * websocket notification, which tests/config-fixture.ts found to be lost
 * outright. The signature is known before sending, so an error from the send
 * itself (a 429, a timeout) is watched rather than reported as "not sent": only
 * a failed simulation proves the transaction never left.
 */
async function send(connection: Connection, cluster: Cluster, admin: Keypair, what: string, built: Transaction): Promise<void> {
  const price = Number(env("SIP_DEPLOY_CU_PRICE") ?? "20000");
  if (!Number.isInteger(price) || price < 0 || price > 5_000_000) {
    throw new Refused("SIP_DEPLOY_CU_PRICE must be a whole number of micro-lamports, at most 5000000");
  }

  let signature = "";
  let lastValidBlockHeight = 0;
  for (let attempt = 1; ; attempt += 1) {
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }),
      ...built.instructions,
    );
    const latest = await connection.getLatestBlockhash("confirmed");
    tx.feePayer = admin.publicKey;
    tx.recentBlockhash = latest.blockhash;
    tx.sign(admin);
    if (tx.signature === null) throw new Error(`${what} could not be signed`);
    signature = utils.bytes.bs58.encode(tx.signature);
    lastValidBlockHeight = latest.lastValidBlockHeight;
    try {
      await connection.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed", maxRetries: 5 });
      break;
    } catch (error) {
      if (!refusedBySimulation(error)) {
        say(`  ! sending ${what} returned an error, and it may still land, so its signature is watched: ${oneLine(error)}`);
        break;
      }
      const reason = programError(error);
      // A node a slot behind can refuse a fresh blockhash, or not see the account the previous verb created yet.
      const transient = TRANSIENT_REFUSAL.test([reason, oneLine(error), ...(logsOf(error) ?? [])].join("\n"));
      if (!transient || attempt >= SEND_ATTEMPTS) throw new Refused(`${what} was refused in simulation, nothing was sent: ${reason}`);
      say(`  ! ${what} was refused in simulation (${reason}); nothing was sent, so it is signed again with a fresh blockhash`);
      await sleep(2_000);
    }
  }
  say(`  … ${what}: ${signature}`);

  const landed = async (): Promise<boolean> => {
    const { value } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
    const found = value[0];
    if (found?.err) throw new Error(`${what} failed on chain (${signature}): ${JSON.stringify(found.err)}`);
    return found?.confirmationStatus === "confirmed" || found?.confirmationStatus === "finalized";
  };
  // An RPC whose block height stops moving would otherwise keep this loop alive for ever.
  const deadline = Date.now() + CONFIRM_WALL_MS;
  for (;;) {
    if (await landed()) break;
    if (Date.now() > deadline) {
      throw new Error(
        `${what} is not confirmed after ${CONFIRM_WALL_MS / 1000} s (${signature}): run status, then the verb again; it reads what is already done first.`,
      );
    }
    if ((await connection.getBlockHeight("confirmed")) > lastValidBlockHeight) {
      // One node's view: give a lagging one a few more looks before calling it.
      let late = false;
      for (let look = 0; look < 6 && !late; look += 1) {
        await sleep(POLL_MS);
        late = await landed();
      }
      if (late) break;
      throw new Error(
        `${what} did not land before its blockhash expired (${signature}), so it cannot land any more. ` +
          "Run the verb again: it reads what is already done first.",
      );
    }
    await sleep(POLL_MS);
  }
  say(`  ✓ ${what} confirmed${cluster === "mainnet" ? ` · https://solscan.io/tx/${signature}` : ""}`);
}

interface AdminContext {
  connection: Connection;
  cluster: Cluster;
  programId: PublicKey;
  admin: Keypair;
  deployment: Deployment;
  program: Program;
  /** Drills only: send what the checks here would refuse, to prove the program refuses it too. */
  skipPrecheck: boolean;
}

async function adminContext(): Promise<AdminContext> {
  const { connection, cluster } = await connect();
  const skipPrecheck = env("SIP_ADMIN_SKIP_PRECHECK") === "1";
  if (skipPrecheck && cluster !== "localnet") throw new Refused("SIP_ADMIN_SKIP_PRECHECK is for local drills only");
  const programId = programIdFor(cluster);
  const admin = loadAdmin(cluster);
  const deployment = await readDeployment(connection, programId);
  if (deployment === null) throw new Refused(`${programId} is not deployed on ${cluster}`);
  return { connection, cluster, programId, admin, deployment, program: programAt(connection, programId, admin), skipPrecheck };
}

/** The config, refused when it is missing or when the admin wallet is not its authority. */
async function configFor(ctx: AdminContext): Promise<ProtocolConfig> {
  const config = await readConfig(ctx.program);
  if (config === null) throw new Refused("the config is not initialised: run sip-deploy.sh configure");
  if (!ctx.skipPrecheck && !config.authority.equals(ctx.admin.publicKey)) {
    throw new Refused(`the config's authority is ${config.authority}, not the admin wallet ${ctx.admin.publicKey}`);
  }
  return config;
}

/** Reads the config until it shows the change, because the node answering may lag the one that confirmed. */
async function readBack(ctx: AdminContext, what: string, done: (config: ProtocolConfig) => boolean): Promise<ProtocolConfig> {
  for (let attempt = 0; attempt < READ_BACK_ATTEMPTS; attempt += 1) {
    const config = await readConfig(ctx.program);
    if (config !== null && done(config)) return config;
    await sleep(POLL_MS);
  }
  throw new Error(`${what} confirmed, but the config still reads back without it after ${(READ_BACK_ATTEMPTS * POLL_MS) / 1000} s: run status`);
}

function printConfig(config: ProtocolConfig): void {
  const show = (key: PublicKey): string => (key.equals(NOBODY) ? "nobody" : key.toBase58());
  say(`  authority ${show(config.authority)}`);
  say(`  attester  ${show(config.attester)}`);
  say(`  keeper    ${show(config.keeper)}`);
  say(`  protocol  ${config.paused ? "PAUSED" : "running"}`);
}

async function initConfig(): Promise<void> {
  const ctx = await adminContext();
  const settle = address("SIP_SETTLE_PUBKEY", env("SIP_SETTLE_PUBKEY"));
  if (settle.equals(ctx.admin.publicKey)) {
    throw new Refused("the settle wallet must not be the admin wallet: the admin key never goes to a server, the settle key lives on one");
  }
  if (settle.equals(NOBODY)) throw new Refused("the settle wallet cannot be 11111111111111111111111111111111");
  const authority = ctx.deployment.authority;
  if (!ctx.skipPrecheck && (authority === null || !authority.equals(ctx.admin.publicKey))) {
    throw new Refused(`the program's upgrade authority is ${authority ?? "none"}, not the admin wallet ${ctx.admin.publicKey}: init_config would be refused`);
  }

  let config = await readConfig(ctx.program);
  if (config === null) {
    const tx = await ctx.program.methods
      .initConfig(settle)
      .accountsPartial({ authority: ctx.admin.publicKey, programData: ctx.deployment.programData })
      .transaction();
    await send(ctx.connection, ctx.cluster, ctx.admin, "init_config(attester = settle)", tx);
    config = await readBack(ctx, "init_config", (read) => read.attester.equals(settle));
  } else if (!config.authority.equals(ctx.admin.publicKey)) {
    throw new Refused(`the config is already initialised with authority ${config.authority}, not the admin wallet`);
  } else if (!config.attester.equals(settle)) {
    throw new Refused(`the config is already initialised with attester ${config.attester}: rotate it deliberately with set-attester`);
  } else {
    say("  · init_config was already done, with the settle wallet as attester");
  }

  if (config.keeper.equals(settle)) {
    say("  · the keeper is already the settle wallet");
  } else {
    const tx = await ctx.program.methods
      .setKeeper(settle)
      .accountsPartial({ authority: ctx.admin.publicKey, config: configAddress(ctx.programId) })
      .transaction();
    await send(ctx.connection, ctx.cluster, ctx.admin, "set_keeper(settle)", tx);
    config = await readBack(ctx, "set_keeper", (read) => read.keeper.equals(settle));
  }
  printConfig(config);
}

async function setRole(role: "keeper" | "attester", raw: string | undefined): Promise<void> {
  const ctx = await adminContext();
  const key = address(`the new ${role}`, raw);
  if (key.equals(ctx.admin.publicKey)) throw new Refused(`the admin wallet cannot be the ${role}: its key never goes to a server`);
  if (role === "attester" && key.equals(NOBODY)) throw new Refused("an attester of 111…1 would stop every settlement: pause instead");
  const pick = (config: ProtocolConfig): PublicKey => (role === "keeper" ? config.keeper : config.attester);
  const before = await configFor(ctx);
  if (pick(before).equals(key)) {
    say(`  · the ${role} is already ${key.equals(NOBODY) ? "nobody" : key.toBase58()}`);
    return;
  }
  const method = role === "keeper" ? ctx.program.methods.setKeeper(key) : ctx.program.methods.setAttester(key);
  const tx = await method.accountsPartial({ authority: ctx.admin.publicKey, config: configAddress(ctx.programId) }).transaction();
  await send(ctx.connection, ctx.cluster, ctx.admin, `set_${role}`, tx);
  printConfig(await readBack(ctx, `set_${role}`, (read) => pick(read).equals(key)));
}

async function setPaused(paused: boolean): Promise<void> {
  const ctx = await adminContext();
  const before = await configFor(ctx);
  if (before.paused === paused) {
    say(`  · the protocol is already ${paused ? "paused" : "running"}`);
    return;
  }
  const tx = await ctx.program.methods
    .setProtocolPaused(paused)
    .accountsPartial({ authority: ctx.admin.publicKey, config: configAddress(ctx.programId) })
    .transaction();
  await send(ctx.connection, ctx.cluster, ctx.admin, `set_protocol_paused(${paused})`, tx);
  printConfig(await readBack(ctx, "set_protocol_paused", (read) => read.paused === paused));
}

const USAGE = "usage: sip-admin.ts status [--allow-unconfigured] | init-config | set-keeper <address> | set-attester <address> | pause | unpause";

async function main(): Promise<number> {
  const nuvem = Object.keys(process.env).filter((name) => name.startsWith("NUVEM_"));
  if (nuvem.length > 0) throw new Refused(`Nuvem-era variables are set (${nuvem.join(", ")}): this tool speaks SIP_* only`);
  const [verb, ...rest] = process.argv.slice(2);
  switch (verb) {
    case "status":
      return status(rest.includes("--allow-unconfigured"));
    case "init-config":
      await initConfig();
      return 0;
    case "set-keeper":
      await setRole("keeper", rest[0]);
      return 0;
    case "set-attester":
      await setRole("attester", rest[0]);
      return 0;
    case "pause":
      await setPaused(true);
      return 0;
    case "unpause":
      await setPaused(false);
      return 0;
    default:
      console.error(USAGE);
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`✗ ${redact(error instanceof Error ? error.message : String(error))}`);
    process.exit(error instanceof Refused ? 3 : 1);
  },
);
