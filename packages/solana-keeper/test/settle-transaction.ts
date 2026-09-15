// A settle transaction built as settle-tick.ts builds it, for the tests that
// check what may leave through a trading wallet's signer.
//
// THE KEEPER'S OWN BUILDERS, NOT A COPY: settleInstruction and settleTransaction
// from settle-tick.ts, and the attestation instruction the program's scripts
// sign, over a Program on the exported IDL. Its connection refuses every call,
// because building a settle reads nothing. Every key is Keypair.generate().

import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, type Transaction } from "@solana/web3.js";
import type { ManagedLink } from "../src/discovery.js";
import { idl } from "../src/idl.js";
import { attestationInstruction } from "../src/program-scripts.js";
import { attestationInputs } from "../src/settle-decision.js";
import { settleInstruction, settleTransaction } from "../src/settle-tick.js";

export interface TestSettle {
  readonly transaction: Transaction;
  readonly programId: PublicKey;
  /** The trading wallet: the fee payer, and settle_v2's `wallet`. */
  readonly wallet: PublicKey;
  readonly link: ManagedLink;
  readonly blockhash: string;
}

const EPOCH = 300_000_000n;

/** One PROFIT settle of a 1 SOL base for a fresh wallet, attested by a fresh key. */
export async function buildTestSettle(): Promise<TestSettle> {
  const programId = new PublicKey(idl.address);
  const wallet = Keypair.generate().publicKey;
  const link: ManagedLink = {
    linkAddress: PublicKey.findProgramAddressSync([Buffer.from("link"), wallet.toBuffer()], programId)[0],
    wallet,
    vault: Keypair.generate().publicKey,
    epoch: EPOCH,
    settlementNonce: 4n,
    frontierSlot: 0n,
  };
  const connection = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== "string" || prop === "then") return undefined;
        return () => {
          throw new Error(`unexpected RPC call while building a settle: ${prop}`);
        };
      },
    },
  ) as unknown as Connection;
  const refuse = async (): Promise<never> => {
    throw new Error("building a settle signs nothing");
  };
  const program = new anchor.Program(
    idl,
    new anchor.AnchorProvider(connection, { publicKey: PublicKey.default, signTransaction: refuse, signAllTransactions: refuse }, { commitment: "confirmed" }),
  );
  const inputs = attestationInputs({
    programId,
    link,
    vault: { skimMode: 0, skimBps: 2_000, volumeBps: 200, policyNonce: 1n },
    from: EPOCH,
    endSlot: EPOCH + 5n,
    baseLamports: 1_000_000_000n,
    currentSlot: EPOCH + 140n,
  });
  const blockhash = Keypair.generate().publicKey.toBase58();
  const transaction = settleTransaction(
    { blockhash, lastValidBlockHeight: 1_000 },
    wallet,
    attestationInstruction(Keypair.generate().secretKey, inputs),
    await settleInstruction(program, link, inputs),
  );
  return { transaction, programId, wallet, link, blockhash };
}
