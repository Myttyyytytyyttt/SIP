// A worker job's stub world (test/worker-job.test.ts, test/worker-pg.test.ts):
// one or more wallets' chains (test/settle-world.ts) behind a JobChain whose
// heights the test moves, the job's keys, a recording history, and an invest
// stand-in that sends real crank transactions through the job's sender.

import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey, Transaction, TransactionMessage, VersionedTransaction, type Connection } from "@solana/web3.js";
import { configAddress, type ProtocolConfigState, type VaultState } from "../src/accounts.js";
import type { SigningWallet } from "../src/explicit-send.js";
import { signatureOf } from "../src/fenced-sender.js";
import { idl } from "../src/idl.js";
import type { InvestDeps, InvestResult } from "../src/invest-tick.js";
import type { JobChain, VaultRead } from "../src/job-chain.js";
import { WalkCache } from "../src/measure-window.js";
import { PolicyBoundaryBook } from "../src/policy-boundary.js";
import { MODE_PROFIT } from "../src/program-scripts.js";
import type { InvestmentRow, SettlementRow } from "../src/read-model.js";
import { workerCarryReads, type JobHistory, type JobKeys, type VaultJobDeps, type WorkerJobStore } from "../src/worker-job.js";
import { CRANK, investInstruction, wrapTransaction } from "./crank-txs.js";
import { MemoryDb } from "./memory-dispatch-store.js";
import { SettleWorld, vaultOf } from "./settle-world.js";

export const crankWallet: SigningWallet = {
  publicKey: CRANK.publicKey,
  async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
    if (tx instanceof Transaction) tx.partialSign(CRANK);
    else (tx as VersionedTransaction).sign([CRANK]);
    return tx;
  },
};

export const config = (paused = false): ProtocolConfigState => ({
  address: configAddress(new PublicKey(idl.address)),
  authority: PublicKey.default,
  attester: CRANK.publicKey,
  keeper: CRANK.publicKey,
  pendingAuthority: PublicKey.default,
  paused,
  version: 1,
});

export interface ChainState {
  finalized: bigint;
  confirmed: bigint;
  vault: VaultState | null;
  links: SettleWorld[];
  config: ProtocolConfigState | null;
}

/**
 * A JobChain over one or more wallets' worlds (the first one's connection serves
 * every RPC), whose heights the test moves. Every raw send records how many
 * intents the store held at that moment, so a test can say each one was gated
 * first, and answers with the transaction's real id, as a node does.
 */
export function jobChain(worlds: readonly SettleWorld[], intents: () => number | Promise<number>, state: Partial<ChainState> = {}) {
  const s: ChainState = { finalized: 5_000n, confirmed: 5_020n, vault: vaultOf(MODE_PROFIT), links: [...worlds], config: config(), ...state };
  const calls: string[] = [];
  const base = worlds[0]!.connection(calls);
  const intentsAtSend: number[] = [];
  const required: bigint[] = [];
  const connection = new Proxy(base as object, {
    get(target, prop) {
      if (prop === "getBlockHeight") return async () => Number(s.confirmed);
      if (prop === "sendRawTransaction") {
        return async (bytes: Uint8Array, ...rest: unknown[]) => {
          intentsAtSend.push(await intents());
          await (target as Connection).sendRawTransaction(bytes as Buffer, ...(rest as []));
          return signatureOf(VersionedTransaction.deserialize(bytes)) ?? "unsigned";
        };
      }
      return (target as Record<string | symbol, unknown>)[prop];
    },
  }) as Connection;
  const refuse = async (): Promise<never> => {
    throw new Error("the program's provider signs nothing here");
  };
  const program = new anchor.Program(idl, new anchor.AnchorProvider(connection, { publicKey: PublicKey.default, signTransaction: refuse, signAllTransactions: refuse }, { commitment: "confirmed" }));
  const chain: JobChain = {
    connection,
    program,
    requireSlot: (slot) => void required.push(slot),
    get requiredSlot() {
      return required.at(-1) ?? null;
    },
    finalizedHeight: async () => s.finalized,
    confirmedHeight: async () => s.confirmed,
    finalizedPoint: async () => ({ height: s.finalized, slot: s.finalized + 20_000_000n }),
    statuses: async (signatures) => signatures.map(() => null),
    latestBlockhash: async () => ({ blockhash: "3Nx5J6yqnGRrZ2mYqPSgDh1ZrmQnrgjSvJnBeCxMwGWk", lastValidBlockHeight: Number(s.confirmed) + 150 }),
    readVault: async (): Promise<VaultRead> => ({
      vault: s.vault,
      links: s.links.map((world) => world.link).sort((a, b) => (a.linkAddress.toBase58() < b.linkAddress.toBase58() ? -1 : 1)),
      config: s.config,
      crankLamports: 2_000_000_000n,
    }),
  };
  return { chain, state: s, calls, intentsAtSend, required };
}

/** The history the job writes, recorded in order. */
export function history() {
  const settlements: SettlementRow[] = [];
  const investments: InvestmentRow[] = [];
  const order: string[] = [];
  const writer: JobHistory = {
    recordSettlement: async (row) => (settlements.push(row), order.push(`settlement:${row.txRef}`), true),
    recordInvestment: async (row) => (investments.push(row), order.push(`investment:${row.txRef}`), true),
    recordLink: async () => true,
  };
  return { writer, settlements, investments, order };
}

/** A vault on the queue whose links are these worlds'. */
export function queued(db: MemoryDb, worlds: readonly SettleWorld[]) {
  const vault = worlds[0]!.link.vault.toBase58();
  for (const world of worlds) world.link = { ...world.link, vault: worlds[0]!.link.vault };
  db.addVault(vault);
  db.links.set(vault, worlds.map((world) => world.link.linkAddress.toBase58()));
  return vault;
}

export const keysFor = (worlds: readonly SettleWorld[]): JobKeys => ({
  settleKey: CRANK,
  wallet: crankWallet,
  signerFor: async (wallet) => worlds.find((world) => world.wallet.equals(wallet))?.walletKey ?? null,
});

export function deps(store: WorkerJobStore, chain: JobChain, over: Partial<VaultJobDeps> = {}): VaultJobDeps {
  const failing = { carryFor: async () => null };
  return {
    store,
    chain,
    history: history().writer,
    keys: null,
    shared: {
      walkCache: new WalkCache(),
      restBook: null,
      boundaries: new PolicyBoundaryBook(),
      ownerHistory: { signatures: async () => [], transaction: async () => null },
      jupiter: null,
      investBatch: false,
      carryReads: workerCarryReads(failing),
    },
    mayAct: () => null,
    softDeadlineAt: Number.POSITIVE_INFINITY,
    log: () => undefined,
    ...over,
  };
}

/** The invest stand-in: a wrap and one leg through the job's sender, as runInvestTick sends them. */
export function buyingInvest(program: anchor.Program, options: { readonly omitPurchase?: boolean } = {}) {
  const seen: InvestDeps[] = [];
  const invest = async (investDeps: InvestDeps): Promise<InvestResult> => {
    seen.push(investDeps);
    if (!investDeps.live) {
      return { outcome: "INVESTED", detail: "DRY RUN — would wrap 5000000 lamports and invest", wrap: { free: 5_000_000n, allowance: 5_000_000n, wrapped: 5_000_000n, short: false } };
    }
    const sender = investDeps.sender!;
    await sender.sendLegacy(await wrapTransaction(program, 5_000_000n), [investDeps.crank!]);
    const leg = await investInstruction(program, 2_000_000n);
    const signature = await sender.sendVersioned(
      (recentBlockhash) => new VersionedTransaction(new TransactionMessage({ payerKey: CRANK.publicKey, recentBlockhash, instructions: [leg] }).compileToV0Message()),
      [investDeps.crank!],
    );
    if (options.omitPurchase === true) return { outcome: "FAILED", detail: "the basket broke after its first leg" };
    return {
      outcome: "INVESTED",
      detail: "bought 100% leg",
      purchases: [{ target: Keypair.generate().publicKey.toBase58(), spentRaw: 2_000_000n, receivedRaw: 7n, signature, slot: 12_345n }],
    };
  };
  return { invest, seen };
}

