// What Phantom does to a transaction it signs on mainnet, for tests: Lighthouse
// checks inserted into the message SaverFi built, and the message recompiled:
// post-state checks after the dapp's instructions, and sometimes a block of
// pre-state checks right after its compute budget (client/lighthouse.ts cites
// the transactions).
//
// THE BYTES ARE PHANTOM'S SHAPES. Each guard below is laid out exactly like
// Lighthouse instructions decoded from successful mainnet transactions whose
// checks match what x402 recorded from Phantom (kinds 6 and 10 at log level 4);
// only the amounts, programs and accounts are this test's:
//   payer   06 04 03 | 00 <u64 min> 04 | 03 00 00 | 01 <u64 0> 00
//           AssertAccountInfoMulti [Lamports >= min, KnownOwner == System, DataLength == 0]
//           as in 2pDyATfUgASHKRAvFe1TKBSBEdViQwjSugqDmNGTavSBaA2fng5eWCrvsgVGisWhmABipMehQ7WDRYEEUHnwnNER, instruction 3
//   system  06 04 02 | 03 00 00 | 01 <u64 0> 00
//           AssertAccountInfoMulti [KnownOwner == System, DataLength == 0]
//           as in 5WJy7Dwhu8HXhM8SwUCNo3D37yx1JRqPGb2SLeLyKfU91pKJxt1ddJ6t8o2rPkHnpwr9Z6Kyp8Rz9dDaQwNQNoy9, instruction 5
//   token   0a 04 04 | 02 <u64 min> 04 | 03 00 00 | 06 <u64 0> 05 | 08
//           AssertTokenAccountMulti [Amount >= min, Delegate == None, DelegatedAmount <= 0, OwnerIsDerived]
//           as in 2rBcyCGbUAVMFZHKRGAGWT1ZJ2xU1LcynN2yz588ghT5EjxC81UHxt7fPnp6eqVZV8zVC3RQq4r38xyZ7SQwavie, instruction 8
//   owner   06 04 01 | 02 <program> 00
//           AssertAccountInfoMulti [Owner == program]
//           as in 2zTL5TKpQsrKWAtdkfrZ3XPKGWCXpJtzPsWG9CVRf5EkZonx9TWKCsSe1d2McFc6DcdKbTEi9aBRzjrz88GqP8Jd, instruction 3
// and ahead of the dapp's instructions, on an account before it changes:
//   created 06 04 01 | 00 <u64 0> 00
//           AssertAccountInfoMulti [Lamports == 0], on an account about to be created
//           as in 37v2uzTK8ue91KSKR8zT8hRkYuSDS5Zox6UF8ghZ8bp4kkmDkCg2mJKSY5DafBoxWkv8DwXwMoEcfPae2vW9fPxe, instruction 6
//   pretoken 0a 04 03 | 03 00 00 | 06 <u64 0> 05 | 08
//           AssertTokenAccountMulti [Delegate == None, DelegatedAmount <= 0, OwnerIsDerived]
//           as in 37v2uzTK8ue91KSKR8zT8hRkYuSDS5Zox6UF8ghZ8bp4kkmDkCg2mJKSY5DafBoxWkv8DwXwMoEcfPae2vW9fPxe, instruction 3
// (system and owner appear there too: instructions 5 and 4.)
// Phantom names each checked account read-only and unsigned.

import { Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";

import { LIGHTHOUSE_PROGRAM } from "../src/client/addresses";

export const LIGHTHOUSE = new PublicKey(LIGHTHOUSE_PROGRAM);

const u64 = (value: bigint): Uint8Array => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
};

export const concat = (...parts: readonly (number | Uint8Array)[]): Uint8Array => Uint8Array.from(parts.flatMap((part) => (typeof part === "number" ? [part] : [...part])));

export const GUARD_DATA = {
  payer: (minLamports: bigint): Uint8Array => concat(6, 4, 3, 0, u64(minLamports), 4, 3, 0, 0, 1, u64(0n), 0),
  system: (): Uint8Array => concat(6, 4, 2, 3, 0, 0, 1, u64(0n), 0),
  token: (minAmount: bigint): Uint8Array => concat(10, 4, 4, 2, u64(minAmount), 4, 3, 0, 0, 6, u64(0n), 5, 8),
  owner: (program: PublicKey | string): Uint8Array => concat(6, 4, 1, 2, new PublicKey(program).toBytes(), 0),
  created: (): Uint8Array => concat(6, 4, 1, 0, u64(0n), 0),
  pretoken: (): Uint8Array => concat(10, 4, 3, 3, 0, 0, 6, u64(0n), 5, 8),
};

export interface GuardMeta {
  readonly isSigner?: boolean;
  readonly isWritable?: boolean;
  readonly programId?: PublicKey;
}

/** A Lighthouse instruction checking `account`, named read-only and unsigned unless `meta` says otherwise. */
export const guard = (data: Uint8Array, account: PublicKey | string, meta: GuardMeta = {}): TransactionInstruction =>
  new TransactionInstruction({
    programId: meta.programId ?? LIGHTHOUSE,
    keys: [{ pubkey: new PublicKey(account), isSigner: meta.isSigner ?? false, isWritable: meta.isWritable ?? false }],
    data: Buffer.from(data),
  });

export interface PhantomRewrite {
  readonly guards: readonly TransactionInstruction[];
  /** The instruction index the guards are inserted at; after every instruction when absent. */
  readonly at?: number;
  /** Pre-state checks inserted right after SaverFi's compute-budget pair (instruction index 2), after `guards` are. */
  readonly leading?: readonly TransactionInstruction[];
  readonly version?: "legacy" | 0;
  /** Any further change to the decompiled message, before it is compiled. */
  readonly edit?: (message: TransactionMessage) => void;
}

/** `unsigned` as Phantom rewrites it, before anyone signs: decompiled, the guards inserted, compiled again. */
export function rewriteAsPhantom(unsigned: Uint8Array, rewrite: PhantomRewrite): VersionedTransaction {
  const message = TransactionMessage.decompile(VersionedTransaction.deserialize(unsigned).message);
  message.instructions.splice(rewrite.at ?? message.instructions.length, 0, ...rewrite.guards);
  message.instructions.splice(2, 0, ...(rewrite.leading ?? []));
  rewrite.edit?.(message);
  return new VersionedTransaction(rewrite.version === 0 ? message.compileToV0Message() : message.compileToLegacyMessage());
}

/** The rewritten transaction signed by each signer in turn over the same message: Phantom's slot, then a co-signer's. */
export function signedAsPhantom(unsigned: Uint8Array, rewrite: PhantomRewrite, ...signers: readonly Keypair[]): Uint8Array {
  const tx = rewriteAsPhantom(unsigned, rewrite);
  for (const signer of signers) tx.sign([signer]);
  return Uint8Array.from(tx.serialize());
}
