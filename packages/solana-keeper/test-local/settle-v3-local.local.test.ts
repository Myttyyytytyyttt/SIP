// THE PER-TRADE MODES ON A REAL VALIDATOR (dispatcher ADR §5.8 L2, plan §3.4):
// the rehearsed per-trade sip_vault.so (sha256 802b9c9a…, NOT the binary on
// mainnet) at the program's real id, a ROUND-UP vault and a FIXED one each
// opened with create_vault_v2 (mode 0) + set_policy_v3 in ONE transaction, one
// real swap-shaped trade each (SOL out of the wallet, a token in, both signed),
// and then the dispatcher's own WORKER JOB — runVaultJob over createJobChain, the
// in-memory store, the fence — choosing the per-trade module by the vault's byte
// under SIP_SOLANA_EXTRA_MODES, reading its PerTradePolicy and Pyth's SOL/USD,
// pricing the trade from the tape, and sending [Ed25519SigVerify, settle_v3].
//
// WHAT IT PROVES, PER MODE: the settle lands; the vault gains exactly the charge
// (2 666 666 lamports for the ADR's $1.60 trade at $150; F for FIXED); the
// PerTradePolicy's day counter, the link's nonce and frontier move as settle_v3
// says; the two events say all of it — Settled unchanged (bps 10 000, owed =
// amount) and PerTradeSettled with the count, the price and the prices hash the
// keeper signed; and the fence's intent resolved landed. Then the next job
// rests (the loop guard): only our own settle sits above the frontier.
//
// EVERY KEY IS Keypair.generate(), IN MEMORY, the upgrade authority included.
// Pyth's SOL/USD at $150 is the program suite's fixture account
// (tests/fixtures/pyth/sol-usd-150.json), preloaded at its own address; the
// program accepts any account the Pyth receiver owns for the SOL/USD feed.
//
// NOT PART OF `pnpm test`: SIP_LOCAL_PER_TRADE_SO names the rehearsed binary and
// `pnpm --dir packages/solana-keeper test:local test-local/settle-v3-local.local.test.ts`
// runs it (Node 22, solana-test-validator 3.1.12). Without the variable it is skipped.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as anchor from "@coral-xyz/anchor";
import { createAssociatedTokenAccount, createMint, createMintToInstruction } from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, type Connection } from "@solana/web3.js";
import { linkWalletWithConsent } from "@sip/solana-program/link-consent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodePerTradePolicy, perTradePolicyAddress } from "../src/accounts.js";
import { createJobChain } from "../src/job-chain.js";
import { idl } from "../src/idl.js";
import { WalkCache, readTransaction } from "../src/measure-window.js";
import { method } from "../src/methods.js";
import { signatureBytes } from "../src/per-trade-base.js";
import { PolicyBoundaryBook, type OwnerHistoryReader } from "../src/policy-boundary.js";
import { MemoryPriceTape } from "../src/price-tape.js";
import { MODE_FIXED, MODE_ROUNDUP, pricesHash } from "../src/program-scripts.js";
import { MODE_FIXED_BYTE, MODE_ROUNDUP_BYTE } from "../src/role-registry.js";
import { runVaultJob, workerCarryReads, type JobHistory, type VaultJobDeps } from "../src/worker-job.js";
import { MemoryDb, MemoryDispatchStore } from "../test/memory-dispatch-store.js";
import { SIP_VAULT_PROGRAM_ID, startLocalValidator, type LocalValidator } from "./local-validator.js";

const SOL = BigInt(LAMPORTS_PER_SOL);
const FIXTURE = fileURLToPath(new URL("../../solana-program/tests/fixtures/pyth/sol-usd-150.json", import.meta.url));
const ORACLE = new PublicKey((JSON.parse(readFileSync(FIXTURE, "utf8")) as { pubkey: string }).pubkey);
const ED25519 = "Ed25519SigVerify111111111111111111111111111";
const SETTLE_V3 = [145, 62, 164, 103, 237, 99, 66, 46];
/** The ADR's worked example: a $1.60 trade at $150 owes 2 666 666 lamports at a $1 unit. */
const ROUNDUP_TRADE = 10_666_667n;
const ROUNDUP_OWED = 2_666_666n;
const FIXED_TRADE = 20_000_000n;
const F = 1_000_000;
const PRICE = 150_000_000n;

interface Saver {
  readonly name: "ROUND-UP" | "FIXED";
  readonly mode: number;
  readonly owner: Keypair;
  readonly wallet: Keypair;
  readonly vault: PublicKey;
  readonly link: PublicKey;
  readonly maxContribution: bigint;
  readonly trade: bigint;
  readonly owed: bigint;
}

const saver = (name: Saver["name"], mode: number, maxContribution: bigint, trade: bigint, owed: bigint): Saver => {
  const owner = Keypair.generate();
  const wallet = Keypair.generate();
  return {
    name,
    mode,
    owner,
    wallet,
    vault: PublicKey.findProgramAddressSync([Buffer.from("vault"), owner.publicKey.toBuffer()], SIP_VAULT_PROGRAM_ID)[0],
    link: PublicKey.findProgramAddressSync([Buffer.from("link"), wallet.publicKey.toBuffer()], SIP_VAULT_PROGRAM_ID)[0],
    maxContribution,
    trade,
    owed,
  };
};

const authority = Keypair.generate();
const settleKey = Keypair.generate();
const market = Keypair.generate();
// Each cap is at most twice what the one trade owes, so the span settles on size at once (ADR §5.5).
const roundUp = saver("ROUND-UP", MODE_ROUNDUP, 4_000_000n, ROUNDUP_TRADE, ROUNDUP_OWED);
const fixed = saver("FIXED", MODE_FIXED, 1_500_000n, FIXED_TRADE, BigInt(F));
const savers = [roundUp, fixed] as const;

const usable = (process.env.SIP_LOCAL_PER_TRADE_SO ?? "") !== "";
let validator: LocalValidator | undefined;
let connection: Connection;
let program: anchor.Program;
let mint: PublicKey;
const atas = new Map<Saver["name"], PublicKey>();
const tape = new MemoryPriceTape();
const trades = new Map<Saver["name"], { readonly signature: string; readonly slot: bigint }>();

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const big = (value: anchor.BN): bigint => BigInt(value.toString());

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

async function finalized(signature: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const { value } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
    if (value[0]?.confirmationStatus === "finalized") return;
    if (Date.now() >= deadline) throw new Error(`${signature} was not finalized within 90 s`);
    await sleep(250);
  }
}

/** One worker job over the vault, as bin/worker.mts runs it, with the per-trade modes served live. */
async function job(s: Saver) {
  const db = new MemoryDb(Date.now());
  db.addVault(s.vault.toBase58());
  db.links.set(s.vault.toBase58(), [s.link.toBase58()]);
  const store = new MemoryDispatchStore(db, "local-worker", "live");
  const wallet = new anchor.Wallet(settleKey);
  const chain = createJobChain({ transport: fetch, rpcUrl: `http://127.0.0.1:18999`, wallet });
  const ownerHistory: OwnerHistoryReader = {
    signatures: (owner, options, commitment) => connection.getSignaturesForAddress(owner, options.before === undefined ? { limit: options.limit } : { before: options.before, limit: options.limit }, commitment),
    transaction: (signature, commitment) => readTransaction(connection, signature, commitment),
  };
  const settlements: unknown[] = [];
  const history: JobHistory = {
    recordSettlement: async (row) => (settlements.push(row), true),
    recordInvestment: async () => true,
    recordLink: async () => true,
  };
  const deps: VaultJobDeps = {
    store,
    chain,
    history,
    keys: { settleKey, wallet, signerFor: async (address) => savers.find((candidate) => candidate.wallet.publicKey.equals(address))?.wallet ?? null },
    shared: {
      walkCache: new WalkCache(),
      restBook: null,
      boundaries: new PolicyBoundaryBook(),
      ownerHistory,
      jupiter: null,
      investBatch: false,
      carryReads: workerCarryReads({ carryFor: async () => null }),
      perTrade: { modes: new Set([MODE_ROUNDUP_BYTE, MODE_FIXED_BYTE]), vaults: new Set([s.vault.toBase58()]), live: true, fromSlot: null, tape, oracle: ORACLE },
    },
    mayAct: () => null,
    softDeadlineAt: Number.POSITIVE_INFINITY,
    log: () => undefined,
    // THE INVEST IS NOT THIS PROOF'S: no policy, nothing bought.
    invest: async () => ({ outcome: "NO_POLICY", detail: "this proof's vaults have no investment policy" }),
  };
  const claimed = (await store.claim(1))[0]!;
  const end = await runVaultJob(claimed, deps);
  return { end, db, settlements };
}

describe.skipIf(!usable)("the per-trade modes on a local validator: settle_v3 through the worker's own job (needs SIP_LOCAL_PER_TRADE_SO)", () => {
  beforeAll(async () => {
    expect(idl.address).toBe(SIP_VAULT_PROGRAM_ID.toBase58());
    expect(idl.instructions.find((instruction) => instruction.name === "settle_v3")?.discriminator).toEqual(SETTLE_V3);
    validator = await startLocalValidator(authority.publicKey, { binary: "per-trade", accounts: [{ address: ORACLE.toBase58(), file: FIXTURE }] });
    connection = validator.connection;
    program = new anchor.Program(idl, new anchor.AnchorProvider(connection, new anchor.Wallet(authority), { commitment: "confirmed" }));
  });

  afterAll(async () => {
    if (validator === undefined) return;
    const stopped = await validator.stop();
    expect(stopped.exited).toBe(true);
    expect(stopped.rpcRefused).toBe(true);
    expect(stopped.tempDirGone).toBe(true);
  });

  it("opens a ROUND-UP and a FIXED vault with create_vault_v2 + set_policy_v3 in one transaction each, and links their wallets", async () => {
    await Promise.all([
      airdrop(authority.publicKey, 5n * SOL),
      airdrop(settleKey.publicKey, SOL),
      airdrop(market.publicKey, 5n * SOL),
      ...savers.flatMap((s) => [airdrop(s.owner.publicKey, 2n * SOL), airdrop(s.wallet.publicKey, 2n * SOL)]),
    ]);
    const [programData] = PublicKey.findProgramAddressSync([program.programId.toBuffer()], new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"));
    const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
    await method(program, "initConfig")(settleKey.publicKey).accountsPartial({ authority: authority.publicKey, programData }).rpc();
    await method(program, "setKeeper")(settleKey.publicKey).accountsPartial({ authority: authority.publicKey, config }).rpc();
    // THE TOKEN THE TRADES BUY, and each wallet's account of it, before any link: not in any window.
    mint = await createMint(connection, market, market.publicKey, null, 6, undefined, { commitment: "confirmed" });
    for (const s of savers) atas.set(s.name, await createAssociatedTokenAccount(connection, market, mint, s.wallet.publicKey, { commitment: "confirmed" }));

    for (const s of savers) {
      const create = await method(program, "createVaultV2")(0, 2_000, 200, new anchor.BN(s.maxContribution.toString()), new anchor.BN(0)).accountsPartial({ owner: s.owner.publicKey }).instruction();
      const policy = await method(program, "setPolicyV3")(s.mode, 100, F, 100, 10_000_000, new anchor.BN((300_000_000).toString()), new anchor.BN(s.maxContribution.toString()), new anchor.BN(0), false)
        .accountsPartial({ owner: s.owner.publicKey, vault: s.vault, perTradePolicy: perTradePolicyAddress(program.programId, s.vault) })
        .instruction();
      await sendAndConfirmTransaction(connection, new Transaction().add(create, policy), [s.owner], { commitment: "confirmed" });
      await linkWalletWithConsent(program, { owner: s.owner.publicKey, wallet: s.wallet }).signers([s.owner, s.wallet]).rpc();
      const vault = program.coder.accounts.decode<{ skimMode: number }>("vault", (await connection.getAccountInfo(s.vault, "confirmed"))!.data);
      expect(vault.skimMode, s.name).toBe(s.mode);
      const policyInfo = await connection.getAccountInfo(perTradePolicyAddress(program.programId, s.vault), "confirmed");
      expect(decodePerTradePolicy(program, perTradePolicyAddress(program.programId, s.vault), policyInfo!.data)).toMatchObject({ roundupUnitCents: 100, fixedLamports: F, daySavedLamports: 0n });
    }
  });

  it("each wallet makes one swap-shaped trade — SOL out, a token in, both signed — and the tape has SOL at $150 for its minute", async () => {
    for (const s of savers) {
      const ata = atas.get(s.name);
      if (ata === undefined) throw new Error("the setup step did not complete");
      const tx = new Transaction({ feePayer: s.wallet.publicKey }).add(
        SystemProgram.transfer({ fromPubkey: s.wallet.publicKey, toPubkey: market.publicKey, lamports: Number(s.trade) }),
        createMintToInstruction(mint, ata, market.publicKey, 1_000_000n),
      );
      const signature = await sendAndConfirmTransaction(connection, tx, [s.wallet, market], { commitment: "confirmed" });
      const receipt = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      expect(receipt?.blockTime, "the local validator stamps a block time").not.toBeNull();
      await tape.record({ publishTime: receipt!.blockTime!, slot: BigInt(receipt!.slot), priceE6: PRICE, confE6: 0n });
      trades.set(s.name, { signature, slot: BigInt(receipt!.slot) });
    }
    for (const s of savers) await finalized(trades.get(s.name)!.signature);
  });

  for (const s of savers) {
    it(`${s.name}: the worker's job settles it through settle_v3 — exactly the charge, the day counter, the nonce and frontier, both events, the intent landed`, async () => {
      const trade = trades.get(s.name);
      if (trade === undefined) throw new Error("the trade step did not complete");
      const vaultBefore = BigInt(await connection.getBalance(s.vault, "confirmed"));
      const { end, db, settlements } = await job(s);
      expect(end.kind).toBe("complete");
      expect(end.report.module).toBe(s.name);
      const turn = end.report.settles[0]!;
      expect(turn.outcome, turn.detail).toBe("SETTLED");
      expect(turn.perTrade).toEqual([expect.objectContaining({ status: "charged", owed: s.owed.toString(), lamports: s.trade.toString() })]);

      // THE MONEY: what moved is the charge, clipped by nothing here.
      expect(BigInt(await connection.getBalance(s.vault, "confirmed")) - vaultBefore).toBe(s.owed);
      const policy = decodePerTradePolicy(program, perTradePolicyAddress(program.programId, s.vault), (await connection.getAccountInfo(perTradePolicyAddress(program.programId, s.vault), "confirmed"))!.data)!;
      expect(policy.daySavedLamports).toBe(s.owed);
      const link = program.coder.accounts.decode<{ settlementNonce: anchor.BN; frontierSlot: anchor.BN }>("tradingLink", (await connection.getAccountInfo(s.link, "confirmed"))!.data);
      expect(big(link.settlementNonce)).toBe(1n);
      expect(big(link.frontierSlot) >= trade.slot).toBe(true);

      // THE FENCE: one settle intent, landed.
      expect(db.intents.map((row) => [row.kind, row.state, row.amountRaw])).toEqual([["settle", "landed", s.owed]]);
      expect(settlements).toEqual([expect.objectContaining({ mode: s.mode, baseRaw: s.owed, contributionRaw: s.owed })]);

      // THE TRANSACTION AND ITS EVENTS.
      const signature = db.intents[0]!.signature!;
      const receipt = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      const keys = receipt!.transaction.message.getAccountKeys();
      expect(receipt!.transaction.message.compiledInstructions.map((ix) => keys.get(ix.programIdIndex)!.toBase58())).toEqual([ED25519, program.programId.toBase58()]);
      const parser = new anchor.EventParser(program.programId, new anchor.BorshCoder(program.idl));
      const events = [...parser.parseLogs(receipt!.meta!.logMessages ?? [])];
      expect(events.map((event) => event.name.toLowerCase())).toEqual(["settled", "pertradesettled"]);
      const settled = events[0]!.data as { mode: number; bps: number; owed: anchor.BN; paid: anchor.BN; baseLamports: anchor.BN };
      expect([settled.mode, settled.bps, big(settled.owed), big(settled.paid), big(settled.baseLamports)]).toEqual([s.mode, 10_000, s.owed, s.owed, s.owed]);
      const perTrade = events[1]!.data as { tradeCount: number; priceMinUsdE6: anchor.BN; pricesHash: number[]; modeParam: anchor.BN; daySavedLamports: anchor.BN };
      expect([perTrade.tradeCount, big(perTrade.daySavedLamports)]).toEqual([1, s.owed]);
      if (s.mode === MODE_ROUNDUP) {
        expect(big(perTrade.priceMinUsdE6)).toBe(PRICE);
        expect(Buffer.from(perTrade.pricesHash).equals(pricesHash([{ slot: trade.slot, signature: signatureBytes(trade.signature), priceUsdE6: PRICE }]))).toBe(true);
        expect(big(perTrade.modeParam)).toBe(100n);
      } else {
        expect(big(perTrade.priceMinUsdE6)).toBe(0n);
        expect(perTrade.pricesHash).toEqual(new Array(32).fill(0));
        expect(big(perTrade.modeParam)).toBe(BigInt(F));
      }
      console.log(`per-trade local proof: ${s.name} settled ${s.owed} lamports through settle_v3; ${signature}`);

      // THE NEXT JOB RESTS: only our own settle sits above the frontier (once it is final).
      await finalized(signature);
      const next = await job(s);
      expect(next.end.report.settles.map((t) => t.outcome)).toEqual(["IDLE"]);
      expect(next.db.intents).toEqual([]);
    });
  }
});
