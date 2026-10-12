// The three crank transactions as runInvestTick builds them — wrap_sol, convert
// and one invest leg — through the very builders it calls (src/invest-tick.ts),
// offline: every account a made-up key, no Connection asked anything. For the
// fence's tests, which must see real sip-vault instructions to name them.

import * as anchor from "@coral-xyz/anchor";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { idl } from "../src/idl.js";
import { JUPITER_V6_PROGRAM } from "../src/invest-decision.js";
import { convertCall, investCall, wrapSolCall } from "../src/invest-tick.js";

const refuse = async (): Promise<never> => {
  throw new Error("the offline program signs nothing");
};

/** A Program whose Connection throws if it is ever asked anything. */
export function offlineProgram(): anchor.Program {
  const connection = new Connection("http://127.0.0.1:1", { fetch: (async () => Promise.reject(new Error("offline"))) as unknown as typeof fetch });
  return new anchor.Program(idl, new anchor.AnchorProvider(connection, { publicKey: PublicKey.default, signTransaction: refuse, signAllTransactions: refuse }, { commitment: "confirmed" }));
}

const key = (): PublicKey => Keypair.generate().publicKey;
const venueData = Buffer.from("c1209b3341d69c81deadbeef", "hex");

export const CRANK = Keypair.fromSeed(new Uint8Array(32).fill(9));

/** wrap_sol(amount), behind an idempotent ATA create, as the wrap's `.transaction()` builds it. */
export async function wrapTransaction(program: anchor.Program, lamports: bigint): Promise<Transaction> {
  return wrapSolCall(program, { crank: CRANK.publicKey, vault: key(), policy: key(), vaultWsol: key() }, lamports)
    .preInstructions([SystemProgram.transfer({ fromPubkey: CRANK.publicKey, toPubkey: key(), lamports: 0 })])
    .transaction();
}

/** convert(amount_in, …), behind the compute budget, as sendWithBudget's legacy branch builds it. */
export async function convertTransaction(program: anchor.Program, amountIn: bigint): Promise<Transaction> {
  const ix = await convertCall(
    program,
    { crank: CRANK.publicKey, vault: key(), policy: key(), vaultWsol: key(), vaultIn: key(), venueProgram: JUPITER_V6_PROGRAM },
    { amountIn, minOut: 1n, venueData },
  ).instruction();
  return new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ix);
}

/** invest(leg, amount_in, …) in a v0 message, as sendWithBudget's lookup-table branch builds it. */
export async function investTransaction(program: anchor.Program, amountIn: bigint, blockhash: string): Promise<VersionedTransaction> {
  const ix = await investCall(
    program,
    { crank: CRANK.publicKey, vault: key(), policy: key(), vaultIn: key(), vaultTarget: key(), targetMint: key(), venueProgram: JUPITER_V6_PROGRAM },
    { legIndex: 1, amountIn, minOut: 1n, venueData },
  ).instruction();
  const message = new TransactionMessage({
    payerKey: CRANK.publicKey,
    recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ix],
  }).compileToV0Message();
  return new VersionedTransaction(message);
}

/** One invest leg's instruction, built ahead so a v0 message can be compiled around any blockhash synchronously. */
export async function investInstruction(program: anchor.Program, amountIn: bigint) {
  return investCall(
    program,
    { crank: CRANK.publicKey, vault: key(), policy: key(), vaultIn: key(), vaultTarget: key(), targetMint: key(), venueProgram: JUPITER_V6_PROGRAM },
    { legIndex: 0, amountIn, minOut: 1n, venueData },
  ).instruction();
}
