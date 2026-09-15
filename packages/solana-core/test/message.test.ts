// The browser-safe wire reader, against web3.js's own compiler and serializer.

import { ComputeBudgetProgram, Keypair, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction, type PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { COMPUTE_BUDGET_PROGRAM } from "../src/client/addresses";
import { tryBase58Decode } from "../src/client/base58";
import { SIP_PROGRAM_ID } from "../src/client/idl";
import {
  WireFormatError,
  encodeSetComputeUnitLimit,
  encodeSetComputeUnitPrice,
  isSignerIndex,
  isWritableIndex,
  isZeroSignature,
  parseLegacyMessage,
  readComputeBudget,
  readShortVec,
  spliceSignature,
  splitWire,
} from "../src/client/message";
import { toHex } from "../src/client/idl";
import { buildCreateVaultV2, buildLinkWallet, prepareLinkWalletConsent } from "../src/server/builders";
import { BLOCKHASH, fromB64, keypair, signBytes, signWire } from "./helpers";

function legacy(feePayer: PublicKey, instructions: TransactionInstruction[]): Transaction {
  return new Transaction({ feePayer, recentBlockhash: BLOCKHASH }).add(...instructions);
}

describe("parseLegacyMessage and splitWire against web3.js", () => {
  it("one signer: the header, keys, blockhash and instructions compileMessage wrote, and the slots serialize wrote", () => {
    const owner = keypair();
    const tx = legacy(owner.publicKey, [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
      new TransactionInstruction({ programId: keypair().publicKey, keys: [{ pubkey: owner.publicKey, isSigner: true, isWritable: true }, { pubkey: keypair().publicKey, isSigner: false, isWritable: false }], data: Buffer.from([9, 8, 7]) }),
    ]);
    const compiled = tx.compileMessage();
    const wire = Uint8Array.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));

    const parts = splitWire(wire);
    expect(parts.signatures).toHaveLength(1);
    expect(isZeroSignature(parts.signatures[0]!)).toBe(true);
    expect(toHex(parts.message)).toBe(toHex(Uint8Array.from(compiled.serialize())));

    const parsed = parseLegacyMessage(parts.message);
    expect(parsed.header).toEqual({
      numRequiredSignatures: compiled.header.numRequiredSignatures,
      numReadonlySignedAccounts: compiled.header.numReadonlySignedAccounts,
      numReadonlyUnsignedAccounts: compiled.header.numReadonlyUnsignedAccounts,
    });
    expect(parsed.keys).toEqual(compiled.accountKeys.map((key) => key.toBase58()));
    expect(parsed.recentBlockhash).toBe(BLOCKHASH);
    expect(parsed.instructions.map((instruction) => [instruction.programIdIndex, instruction.accountIndexes, toHex(instruction.data)])).toEqual(
      compiled.instructions.map((instruction) => [instruction.programIdIndex, instruction.accounts, toHex(tryBase58Decode(instruction.data)!)]),
    );
    expect(parsed.instructions[0]!.programId).toBe(COMPUTE_BUDGET_PROGRAM);
    parsed.keys.forEach((_, index) => {
      expect(isSignerIndex(parsed, index)).toBe(compiled.isAccountSigner(index));
      expect(isWritableIndex(parsed, index)).toBe(compiled.isAccountWritable(index));
    });
  });

  it("two signers: a built link, each signature slot where VersionedTransaction.serialize put it", () => {
    const owner = keypair();
    const wallet = keypair();
    const consent = fromB64(prepareLinkWalletConsent({ owner: owner.publicKey, wallet: wallet.publicKey }).consentMessageBase64);
    const built = buildLinkWallet({ owner: owner.publicKey, wallet: wallet.publicKey, consentSignature: signBytes(wallet, consent), blockhash: BLOCKHASH });
    const signed = signWire(built.txBase64, owner, wallet);
    const web3 = VersionedTransaction.deserialize(signed);

    const parts = splitWire(signed);
    expect(parts.signatures.map(toHex)).toEqual(web3.signatures.map((signature) => toHex(signature)));
    expect(toHex(parts.message)).toBe(toHex(web3.message.serialize()));
    const parsed = parseLegacyMessage(parts.message);
    expect(parsed.header.numRequiredSignatures).toBe(2);
    expect(parsed.keys.slice(0, 2)).toEqual([owner.publicKey.toBase58(), wallet.publicKey.toBase58()]);
    expect(parsed.instructions.map((instruction) => instruction.programId)).toEqual(["Ed25519SigVerify111111111111111111111111111", SIP_PROGRAM_ID]);
    expect(parsed.instructions[1]!.accountKeys).toEqual(Object.values(built.accounts));
  });
});

describe("spliceSignature", () => {
  it("puts a signature in its slot, leaves the input alone, and round-trips through web3.js", () => {
    const owner = keypair();
    const unsigned = fromB64(buildCreateVaultV2({ owner: owner.publicKey, mode: 0, skimBps: 2_000, volumeBps: 200, maxContribution: 1n, walletReserve: 0n, blockhash: BLOCKHASH }).txBase64);
    const signed = signWire(Buffer.from(unsigned).toString("base64"), owner);
    const signature = splitWire(signed).signatures[0]!;
    const spliced = spliceSignature(unsigned, 0, signature);
    expect(toHex(spliced)).toBe(toHex(signed));
    expect(isZeroSignature(splitWire(unsigned).signatures[0]!)).toBe(true);
    expect(toHex(Uint8Array.from(VersionedTransaction.deserialize(spliced).serialize()))).toBe(toHex(spliced));
    expect(() => spliceSignature(unsigned, 1, signature)).toThrow(WireFormatError);
    expect(() => spliceSignature(unsigned, 0, signature.subarray(0, 63))).toThrow(WireFormatError);
  });
});

describe("refusals", () => {
  it("a v0 message is refused", () => {
    const payer = keypair();
    const message = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: BLOCKHASH,
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1 })],
    }).compileToV0Message();
    const wire = Uint8Array.from(new VersionedTransaction(message).serialize());
    expect(() => parseLegacyMessage(splitWire(wire).message)).toThrow(/v0/);
  });

  it("trailing bytes, a truncated message, an index past the keys and empty bytes are refused", () => {
    const owner = Keypair.generate();
    const message = Uint8Array.from(legacy(owner.publicKey, [ComputeBudgetProgram.setComputeUnitLimit({ units: 5 })]).compileMessage().serialize());
    expect(() => parseLegacyMessage(Uint8Array.from([...message, 0]))).toThrow(/follow the last instruction/);
    expect(() => parseLegacyMessage(message.subarray(0, message.length - 1))).toThrow(WireFormatError);
    const badIndex = message.slice();
    // The single instruction's program index sits right after the instruction count.
    const programIndexAt = 3 + 1 + 32 * 2 + 32 + 1;
    badIndex[programIndexAt] = 9;
    expect(() => parseLegacyMessage(badIndex)).toThrow(/does not carry/);
    expect(() => splitWire(new Uint8Array(0))).toThrow(WireFormatError);
    expect(() => splitWire(Uint8Array.from([2, ...new Uint8Array(64)]))).toThrow(WireFormatError);
  });

  it("compact-u16 lengths: shortest encoding only, at most 3 bytes, at most u16", () => {
    expect(readShortVec(Uint8Array.from([0x7f]), 0)).toEqual({ value: 127, next: 1 });
    expect(readShortVec(Uint8Array.from([0x80, 0x01]), 0)).toEqual({ value: 128, next: 2 });
    expect(readShortVec(Uint8Array.from([0xff, 0xff, 0x03]), 0)).toEqual({ value: 0xffff, next: 3 });
    expect(() => readShortVec(Uint8Array.from([0x80, 0x00]), 0)).toThrow(/shortest/);
    expect(() => readShortVec(Uint8Array.from([0xff, 0xff, 0x04]), 0)).toThrow(WireFormatError);
    expect(() => readShortVec(Uint8Array.from([0x80]), 0)).toThrow(WireFormatError);
  });
});

describe("ComputeBudget data", () => {
  it("encodes as web3.js's ComputeBudgetProgram does and reads back", () => {
    expect(toHex(encodeSetComputeUnitLimit(60_000))).toBe(toHex(Uint8Array.from(ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }).data)));
    expect(toHex(encodeSetComputeUnitPrice(100_000n))).toBe(toHex(Uint8Array.from(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }).data)));
    expect(readComputeBudget(encodeSetComputeUnitLimit(60_000))).toEqual({ kind: "unitLimit", units: 60_000 });
    expect(readComputeBudget(encodeSetComputeUnitPrice(5_000_000n))).toEqual({ kind: "unitPrice", microLamports: 5_000_000n });
    expect(readComputeBudget(Uint8Array.from([1, 0, 0, 0, 0]))).toBeNull();
    expect(() => encodeSetComputeUnitLimit(-1)).toThrow(RangeError);
    expect(() => encodeSetComputeUnitPrice(-1n)).toThrow(RangeError);
  });
});
