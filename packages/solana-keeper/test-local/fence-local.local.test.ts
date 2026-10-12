// THE FENCE WITH REAL MONEY ON A THROWAWAY CHAIN (dispatcher ADR §4.9 rows 1 and
// 2; plan P3b "money proof": "real wrap_sol sends, and a worker killed between
// gate and confirm leaves a successor that waits and wraps nothing more").
//
// ONE VALIDATOR RUNNING THE PUBLISHED sip_vault BYTES, ONE THROWAWAY POSTGRES 16.
// local-validator.ts refuses any binary but the tested one (sha256 60e94348…);
// the store is src/dispatch-store.ts on the database KEEPER_TEST_PG_URL names
// (loopback only), created and dropped by this file. Every job is the worker's
// own runVaultJob over a JobChain to the validator: the real takeover, the real
// plan floor, the real settle turn (an IDLE wallet), the real fenced CrankSender.
//
// THE INVEST TURN IS A STAND-IN, AND ONLY UP TO ITS WRAP. runInvestTick quotes
// Jupiter before it wraps anything (its all-or-nothing gate), and a local chain
// has no Jupiter. So the stand-in does what the turn's wrap does — reads the
// vault's free SOL fresh, and wraps exactly that with invest-tick.ts's own
// wrapSolCall, behind the idempotent wSOL account create — through the sender
// the job hands it. The fence cannot tell the difference: it sees the same
// signed wrap_sol.
//
// EVERY KEY IS Keypair.generate(), IN MEMORY, and lives as long as this file.
//
// NOT PART OF `pnpm test`: `pnpm --dir packages/solana-keeper test:local`, with
// SIP_LOCAL_PROGRAM_SO naming the tested binary and KEEPER_TEST_PG_URL a
// throwaway server on the loopback. Without the database it is skipped and says why.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as anchor from "@coral-xyz/anchor";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { ComputeBudgetProgram, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, type Connection } from "@solana/web3.js";
import { Secret } from "@sip/solana-log";
import { linkWalletWithConsent } from "@sip/solana-program/link-consent";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { investmentPolicyAddress } from "../src/accounts.js";
import { DispatchStore, createDispatchPool } from "../src/dispatch-store.js";
import { idl } from "../src/idl.js";
import { JUPITER_V6_PROGRAM, USDC_MINT } from "../src/invest-decision.js";
import { wrapSolCall, type InvestDeps, type InvestResult } from "../src/invest-tick.js";
import { createJobChain } from "../src/job-chain.js";
import { WalkCache } from "../src/measure-window.js";
import { method } from "../src/methods.js";
import { PolicyBoundaryBook } from "../src/policy-boundary.js";
import { MODE_PROFIT } from "../src/program-scripts.js";
import { SolanaReadModel } from "../src/read-model.js";
import { runVaultJob, workerCarryReads, type JobEnd, type JobKeys, type VaultJobDeps, type WorkerJobStore } from "../src/worker-job.js";
import { SIP_VAULT_PROGRAM_ID, startLocalValidator, type LocalValidator } from "./local-validator.js";

const URL_RAW = process.env["KEEPER_TEST_PG_URL"];
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const usable = ((): boolean => {
  if (URL_RAW === undefined || URL_RAW.trim() === "") return false;
  if (!LOOPBACK.has(new URL(URL_RAW).hostname)) throw new Error("KEEPER_TEST_PG_URL must point at the loopback; it names another host");
  return true;
})();

const SCHEMA_SQL = readFileSync(fileURLToPath(new URL("../sql/sip_solana.sql", import.meta.url)), "utf8");
const SOL = BigInt(LAMPORTS_PER_SOL);
/** What the vault holds free each time a wrap is to be proved: 0.25 SOL. */
const FREE = SOL / 4n;

const authority = Keypair.generate();
const settleKey = Keypair.generate();
const owner = Keypair.generate();
const wallet = Keypair.generate();
const vault = PublicKey.findProgramAddressSync([Buffer.from("vault"), owner.publicKey.toBuffer()], SIP_VAULT_PROGRAM_ID)[0];
const link = PublicKey.findProgramAddressSync([Buffer.from("link"), wallet.publicKey.toBuffer()], SIP_VAULT_PROGRAM_ID)[0];
const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, vault, true, TOKEN_PROGRAM_ID);

let validator: LocalValidator | undefined;
let connection: Connection;
let program: anchor.Program;
let admin: pg.Pool | undefined;
let db: pg.Pool;
const database = `keeper_fence_local_${process.pid}_${Date.now()}`;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function airdrop(to: PublicKey, amount: bigint): Promise<void> {
  let signature: string | undefined;
  for (let attempt = 1; signature === undefined; attempt++) {
    try {
      signature = await connection.requestAirdrop(to, Number(amount));
    } catch (error) {
      if (attempt === 20) throw error;
      await sleep(500);
    }
  }
  await connection.confirmTransaction(signature, "confirmed");
}

/** The owner tops the vault up so it holds exactly FREE above its rent floor. */
async function fundVaultTo(free: bigint): Promise<void> {
  const info = await connection.getAccountInfo(vault, "confirmed");
  const floor = BigInt(await connection.getMinimumBalanceForRentExemption(info!.data.length));
  const missing = free - (BigInt(info!.lamports) - floor);
  if (missing > 0n) {
    // A PRICE OF ITS OWN, so a second top-up of the same amount is a different message: web3.js will not sign
    // the same one twice over a cached blockhash, and waits for a new one instead.
    const unique = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 + Math.floor(Math.random() * 1_000) });
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(unique, SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: vault, lamports: Number(missing) })),
      [owner],
      { commitment: "confirmed" },
    );
  }
}

const wsolBalance = async (): Promise<bigint> => {
  const info = await connection.getAccountInfo(wsol, "confirmed");
  return info === null ? 0n : BigInt((await connection.getTokenAccountBalance(wsol, "confirmed")).value.amount);
};

/**
 * THE WRAP OF AN INVEST TURN, AND NOTHING AFTER IT (the header): the vault's free
 * SOL read fresh through the job's connection, then wrap_sol for exactly that,
 * through the job's fenced sender. Records what it saw.
 */
function wrapEverything(seen: bigint[]) {
  return async (deps: InvestDeps): Promise<InvestResult> => {
    const info = await deps.connection.getAccountInfo(deps.vault, "confirmed");
    const floor = BigInt(await deps.connection.getMinimumBalanceForRentExemption(info!.data.length));
    const free = BigInt(info!.lamports) - floor;
    seen.push(free);
    if (free <= 0n) return { outcome: "IDLE", detail: "nothing free to wrap" };
    const transaction = await wrapSolCall(deps.program, { crank: deps.crank!.publicKey, vault: deps.vault, policy: investmentPolicyAddress(deps.program.programId, deps.vault), vaultWsol: wsol }, free)
      .preInstructions([createAssociatedTokenAccountIdempotentInstruction(deps.crank!.publicKey, wsol, deps.vault, NATIVE_MINT, TOKEN_PROGRAM_ID)])
      .transaction();
    await deps.sender!.sendLegacy(transaction, [deps.crank!]);
    return { outcome: "INVESTED", detail: `wrapped ${free}`, wrap: { free, allowance: free, wrapped: free, short: false } };
  };
}

/** One worker job, as bin/worker.mts runs one — over `transport` for its chain, and `store` for its fence. */
function job(store: WorkerJobStore, seen: bigint[], transport: typeof fetch = globalThis.fetch): (claimed: Parameters<typeof runVaultJob>[0]) => Promise<JobEnd> {
  const providerWallet = new anchor.Wallet(settleKey);
  const keys: JobKeys = { settleKey, wallet: providerWallet, signerFor: async () => wallet };
  const deps = (chainTransport: typeof fetch): VaultJobDeps => ({
    store,
    chain: createJobChain({ transport: chainTransport, rpcUrl: connection.rpcEndpoint, wallet: providerWallet }),
    history: SolanaReadModel.overPool(db, () => undefined),
    keys,
    shared: {
      walkCache: new WalkCache(),
      restBook: null,
      boundaries: new PolicyBoundaryBook(),
      ownerHistory: { signatures: async () => [], transaction: async () => null },
      jupiter: null,
      investBatch: false,
      carryReads: workerCarryReads({ carryFor: async () => null }),
    },
    mayAct: () => null,
    softDeadlineAt: Number.POSITIVE_INFINITY,
    log: () => undefined,
    invest: wrapEverything(seen),
  });
  return (claimed) => runVaultJob(claimed, deps(transport));
}

const intents = async () =>
  (await db.query<{ id: string; kind: string; state: string; fence: string; signature: string | null; plan_cleared_height: string | null; resolved_height: string | null }>(
    "SELECT id, kind, state, fence, signature, plan_cleared_height, resolved_height FROM sip_solana.send_intent ORDER BY id",
  )).rows;
const audit = async () => (await new DispatchStore(db, "auditor").overlapAudit()).map(String);

describe.skipIf(!usable)("fence-local: the fence with real wrap_sol sends (a throwaway validator and Postgres 16)", () => {
  beforeAll(async () => {
    expect(idl.address).toBe(SIP_VAULT_PROGRAM_ID.toBase58());
    validator = await startLocalValidator(authority.publicKey);
    connection = validator.connection;
    program = new anchor.Program(idl, new anchor.AnchorProvider(connection, new anchor.Wallet(authority), { commitment: "confirmed" }));

    admin = new pg.Pool({ connectionString: URL_RAW!, max: 1 });
    admin.on("error", () => undefined);
    await admin.query(`CREATE DATABASE ${database}`);
    const url = new URL(URL_RAW!);
    url.pathname = `/${database}`;
    db = new pg.Pool({ connectionString: url.toString(), max: 4 });
    db.on("error", () => undefined);
    await db.query(SCHEMA_SQL);

    await Promise.all([airdrop(authority.publicKey, 5n * SOL), airdrop(settleKey.publicKey, 3n * SOL), airdrop(owner.publicKey, 5n * SOL), airdrop(wallet.publicKey, SOL)]);
    const [programData] = PublicKey.findProgramAddressSync([program.programId.toBuffer()], new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"));
    const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
    await method(program, "initConfig")(settleKey.publicKey).accountsPartial({ authority: authority.publicKey, programData }).rpc();
    await method(program, "setKeeper")(settleKey.publicKey).accountsPartial({ authority: authority.publicKey, config }).rpc();
    await method(program, "createVaultV2")(MODE_PROFIT, 2_000, 200, new anchor.BN((10n * SOL).toString()), new anchor.BN("10000000"))
      .accountsPartial({ owner: owner.publicKey })
      .signers([owner])
      .rpc();
    await linkWalletWithConsent(program, { owner: owner.publicKey, wallet }).signers([owner, wallet]).rpc();
    // CONVERSION ON: wrap_sol refuses a vault whose policy is disabled or names no conversion floor.
    await method(program, "setInvestPolicy")(
      [{ mint: Keypair.generate().publicKey, weightBps: 10_000, minOutRateWad: new anchor.BN(1) }],
      JUPITER_V6_PROGRAM,
      USDC_MINT,
      new anchor.BN(1),
      new anchor.BN(1),
      new anchor.BN(1_000_000_000),
      new anchor.BN(10_000_000_000),
      true,
    )
      .accountsPartial({ owner: owner.publicKey })
      .signers([owner])
      .rpc();

    // THE QUEUE, AS THE SCHEDULER WOULD LEAVE IT: the vault on 'queue', its link in keeper_link.
    const linked = program.coder.accounts.decode<{ epoch: anchor.BN }>("tradingLink", (await connection.getAccountInfo(link, "confirmed"))!.data);
    await db.query("INSERT INTO sip_solana.vault_work (vault_addr, system, skim_mode) VALUES ($1, 'queue', 0)", [vault.toBase58()]);
    await db.query(
      "INSERT INTO sip_solana.keeper_link (link_addr, wallet_addr, vault_addr, epoch, settlement_nonce, frontier_slot, seen_slot) VALUES ($1, $2, $3, $4, 0, 0, 1)",
      [link.toBase58(), wallet.publicKey.toBase58(), vault.toBase58(), linked.epoch.toString()],
    );
  });

  afterAll(async () => {
    await db?.end().catch(() => undefined);
    if (admin !== undefined) {
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`).catch(() => undefined);
      await admin.end();
    }
    if (validator !== undefined) {
      const stopped = await validator.stop();
      expect(stopped.exited).toBe(true);
      expect(stopped.tempDirGone).toBe(true);
    }
  });

  /** Claims the vault (due now) for `store`, as a CLAIM would. */
  async function claim(store: DispatchStore) {
    await db.query("UPDATE sip_solana.vault_work SET due_at = clock_timestamp() WHERE vault_addr = $1", [vault.toBase58()]);
    const [claimed] = await store.claim(1);
    if (claimed === undefined) throw new Error("the vault could not be claimed");
    return claimed;
  }

  it("Postgres unreachable at the gate: the wrap is signed and dropped — zero sends — and with the database back it wraps once", async () => {
    await fundVaultTo(FREE);
    const store = new DispatchStore(db, "worker-dbdown");
    const deadPool = createDispatchPool(new Secret("postgres://nobody:nothing@127.0.0.1:1/none", "databaseUrl"), "worker", "fence-local-dead", () => undefined);
    const dead = new DispatchStore(deadPool, "worker-dbdown");
    // EVERYTHING BUT THE GATE GOES TO THE LIVE DATABASE; THE GATE FINDS NONE.
    const halfDown: WorkerJobStore = {
      holder: store.holder,
      world: store.world,
      priorIntents: (held) => store.priorIntents(held),
      resolveIntent: (id, outcome, height) => store.resolveIntent(id, outcome, height),
      recordSignature: (id, signature) => store.recordSignature(id, signature),
      linksOf: (address) => store.linksOf(address),
      markBoardDirty: () => store.markBoardDirty(),
      gate: (intent, options) => dead.gate(intent, options),
      gateOneStatement: (intent) => dead.gateOneStatement(intent),
    };
    const seen: bigint[] = [];
    const before = await wsolBalance();
    const claimed = await claim(store);
    const end = await job(halfDown, seen)(claimed);
    expect(seen).toEqual([FREE]);
    expect(end.report.invest?.outcome).toBe("THREW");
    expect(await wsolBalance()).toBe(before);
    expect(await intents()).toEqual([]);
    await deadPool.end().catch(() => undefined);
    if (end.kind === "complete") await store.complete(claimed, { ...end.completion, dueInSeconds: 0 });
    else await store.release(claimed, end.reason);

    const again = await claim(store);
    const done = await job(store, seen)(again);
    expect(done.report.invest?.outcome).toBe("INVESTED");
    expect(await wsolBalance()).toBe(before + FREE);
    const rows = await intents();
    expect(rows.map((row) => [row.kind, row.state])).toEqual([["wrap", "landed"]]);
    if (done.kind === "complete") await store.complete(again, done.completion);
    expect(await audit()).toEqual([]);
  });

  it("a worker killed between its wrap's gate and its confirmation: the successor waits it out, then wraps NOTHING more", async () => {
    await fundVaultTo(FREE);
    const before = await wsolBalance();
    const preexisting = (await intents()).length;

    // WORKER A: gates and sends its wrap, then never hears back — its confirmation polls hang, as a process that died would.
    const storeA = new DispatchStore(db, "worker-a");
    const seenA: bigint[] = [];
    const deaf: typeof fetch = async (input, init) => {
      if (typeof init?.body === "string" && init.body.includes('"getSignatureStatuses"')) return new Promise<Response>(() => undefined);
      return globalThis.fetch(input, init);
    };
    const claimedA = await claim(storeA);
    void job(storeA, seenA, deaf)(claimedA).catch(() => undefined);
    const deadline = Date.now() + 60_000;
    while ((await intents()).length === preexisting) {
      if (Date.now() > deadline) throw new Error("worker A never gated its wrap");
      await sleep(100);
    }
    const [wrapA] = (await intents()).slice(preexisting);
    expect(wrapA).toMatchObject({ kind: "wrap", state: "intent", signature: expect.any(String) });
    // A IS GONE: its lease runs out, as 45 s without a heartbeat would leave it.
    await db.query("UPDATE sip_solana.vault_work SET lease_until = clock_timestamp() - interval '1 second' WHERE vault_addr = $1", [vault.toBase58()]);

    // WORKER B: claims, and its jobs wait until A's wrap has landed and is final before planning.
    const storeB = new DispatchStore(db, "worker-b");
    const seenB: bigint[] = [];
    const outcomes: string[] = [];
    let finished: JobEnd | null = null;
    let resolvedByB = 0;
    for (let attempt = 0; attempt < 20 && finished === null; attempt++) {
      const claimedB = await claim(storeB);
      const end = await job(storeB, seenB)(claimedB);
      if (end.kind !== "complete") throw new Error(`worker B stopped: ${end.reason}`);
      outcomes.push(end.completion.outcome);
      resolvedByB += end.report.resolvedAtTakeover;
      await storeB.complete(claimedB, { ...end.completion, dueInSeconds: 0 });
      if (end.completion.outcome.startsWith("WAITING")) await sleep(2_000);
      else finished = end;
    }
    expect(finished).not.toBeNull();
    // A's WRAP WAS RESOLVED BY B's TAKEOVER, from its signature's status — never by A, which never heard back.
    expect(resolvedByB).toBe(1);
    // B SAW THE VAULT ONLY AFTER A's WRAP: nothing free, nothing wrapped, nothing sent.
    expect(seenB).toEqual([0n]);
    expect(finished!.report.invest?.outcome).toBe("IDLE");
    expect(await wsolBalance()).toBe(before + FREE);
    const rows = (await intents()).slice(preexisting);
    expect(rows.map((row) => [row.kind, row.state, row.fence])).toEqual([["wrap", "landed", wrapA!.fence]]);
    expect(await audit()).toEqual([]);
  });
});
