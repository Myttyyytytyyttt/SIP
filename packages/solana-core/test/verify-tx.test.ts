// The verifier, with real serialized transactions signed by throwaway keys.

import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { MEMO_PROGRAM, USDC_MINT } from "../src/client/addresses";
import { base58Encode } from "../src/client/base58";
import { OLD_NUVEM_PROGRAM_ID, SIP_PROGRAM_ID, instructionDiscriminator } from "../src/client/idl";
import {
  buildCreateVaultV2,
  buildLinkWallet,
  buildSetInvestPolicy,
  buildUnlinkWallet,
  buildWithdraw,
  sipInstruction,
} from "../src/server/builders";
import { deriveLinkPda, deriveVaultPda } from "../src/server/pda";
import { verifySignedTransaction, type VerifyRefusal } from "../src/server/verify-tx";
import { BLOCKHASH, b64, fromB64, keypair, legacyTx, signWire } from "./helpers";

const vaultPolicy = { mode: 1, skimBps: 2_000, volumeBps: 10, maxContribution: 1_000_000_000n, walletReserve: 5_000_000n };

function expectRefusal(bytes: Uint8Array, reason: VerifyRefusal | readonly VerifyRefusal[]): void {
  const result = verifySignedTransaction(bytes);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    const allowed = typeof reason === "string" ? [reason] : reason;
    expect(allowed, result.detail).toContain(result.reason);
  }
}

function linkInstruction(owner: PublicKey, wallet: PublicKey): TransactionInstruction {
  return sipInstruction("link_wallet", { owner, wallet, vault: deriveVaultPda(owner), trading_link: deriveLinkPda(wallet) }, {});
}

describe("accepted", () => {
  it("(a) create_vault_v2 signed by its owner; the signature is base58 of signature 1", () => {
    const owner = keypair();
    const built = buildCreateVaultV2({ owner: owner.publicKey, ...vaultPolicy, blockhash: BLOCKHASH });
    const signed = signWire(built.txBase64, owner);
    const result = verifySignedTransaction(signed, { programId: SIP_PROGRAM_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.signature).toBe(base58Encode(VersionedTransaction.deserialize(signed).signatures[0]!));
    expect(result.feePayer).toBe(owner.publicKey.toBase58());
    expect(result.instruction.name).toBe("create_vault_v2");
    expect(result.instruction.args).toEqual({ mode: 1, skim_bps: 2_000, volume_bps: 10, max_contribution: 1_000_000_000n, wallet_reserve: 5_000_000n });
    expect(result.wireBase64).toBe(b64(signed));
    expect(result.version).toBe("legacy");
  });

  it("(b) link_wallet signed owner first, then the trading wallet", () => {
    const owner = keypair();
    const wallet = keypair();
    const built = buildLinkWallet({ owner: owner.publicKey, wallet: wallet.publicKey, blockhash: BLOCKHASH });
    const result = verifySignedTransaction(signWire(built.txBase64, owner, wallet));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feePayer).toBe(owner.publicKey.toBase58());
    expect(result.signers).toEqual([owner.publicKey.toBase58(), wallet.publicKey.toBase58()]);
    expect(result.instruction.accounts.wallet).toBe(wallet.publicKey.toBase58());
  });

  it("(c) link_wallet with a SetComputeUnitPrice(10_000) prepended before signing", () => {
    const owner = keypair();
    const wallet = keypair();
    const bytes = legacyTx(owner.publicKey, [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }), linkInstruction(owner.publicKey, wallet.publicKey)], [owner, wallet]);
    const result = verifySignedTransaction(bytes);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.computeBudget.microLamports).toBe(10_000n);
      expect(result.instructions.map((instruction) => instruction.name)).toEqual(["SetComputeUnitPrice", "link_wallet"]);
    }
  });

  it("(d) the same link as a v0 message with no lookup tables", () => {
    const owner = keypair();
    const wallet = keypair();
    const message = new TransactionMessage({ payerKey: owner.publicKey, recentBlockhash: BLOCKHASH, instructions: [linkInstruction(owner.publicKey, wallet.publicKey)] }).compileToV0Message();
    const tx = new VersionedTransaction(message);
    tx.sign([owner, wallet]);
    const result = verifySignedTransaction(tx.serialize());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.version).toBe(0);
  });

  it("(e) withdraw, and set_invest_policy with USDC in and one leg", () => {
    const owner = keypair();
    const withdraw = buildWithdraw({ owner: owner.publicKey, lamports: 1_000n, blockhash: BLOCKHASH });
    expect(verifySignedTransaction(signWire(withdraw.txBase64, owner)).ok).toBe(true);
    const policy = buildSetInvestPolicy({
      owner: owner.publicKey,
      blockhash: BLOCKHASH,
      legs: [{ mint: keypair().publicKey.toBase58(), weightBps: 10_000, minOutRateWad: 10n ** 15n }],
      inMint: USDC_MINT,
      minConvertRateWad: 10n ** 12n,
      minInvestment: 1_000_000n,
      maxPerCall: 50_000_000n,
      maxRolling30d: 500_000_000n,
      enabled: true,
    });
    const result = verifySignedTransaction(signWire(policy.txBase64, owner));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.instruction.args.in_mint).toBe(USDC_MINT);
  });

  it("unlink_wallet by the owner, and by the wallet with the owner paying", () => {
    const owner = keypair();
    const wallet = keypair();
    const byOwner = buildUnlinkWallet({ owner: owner.publicKey, wallet: wallet.publicKey, blockhash: BLOCKHASH });
    expect(verifySignedTransaction(signWire(byOwner.txBase64, owner)).ok).toBe(true);
    const byWallet = buildUnlinkWallet({ owner: owner.publicKey, wallet: wallet.publicKey, blockhash: BLOCKHASH, by: "wallet" });
    const result = verifySignedTransaction(signWire(byWallet.txBase64, owner, wallet));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.instruction.accounts.authority).toBe(wallet.publicKey.toBase58());
  });
});

describe("refused", () => {
  it("(f) a link carrying only the owner's signature: missing_signature", () => {
    const owner = keypair();
    const wallet = keypair();
    const built = buildLinkWallet({ owner: owner.publicKey, wallet: wallet.publicKey, blockhash: BLOCKHASH });
    expectRefusal(signWire(built.txBase64, owner), "missing_signature");
  });

  it("(g) a link whose wallet signed a different message: bad_signature", () => {
    const owner = keypair();
    const wallet = keypair();
    const real = VersionedTransaction.deserialize(fromB64(buildLinkWallet({ owner: owner.publicKey, wallet: wallet.publicKey, blockhash: BLOCKHASH }).txBase64));
    real.sign([owner]);
    const otherHash = base58Encode(Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 2) & 0xff));
    const other = VersionedTransaction.deserialize(fromB64(buildLinkWallet({ owner: owner.publicKey, wallet: wallet.publicKey, blockhash: otherHash }).txBase64));
    other.sign([wallet]);
    real.signatures[1] = other.signatures[1]!;
    expectRefusal(real.serialize(), "bad_signature");
  });

  it("(h) a hand-built link_wallet naming the owner twice: wallet_is_owner", () => {
    const owner = keypair();
    const ix = new TransactionInstruction({
      programId: new PublicKey(SIP_PROGRAM_ID),
      keys: [
        { pubkey: owner.publicKey, isSigner: true, isWritable: true },
        { pubkey: owner.publicKey, isSigner: true, isWritable: false },
        { pubkey: deriveVaultPda(owner.publicKey), isSigner: false, isWritable: false },
        { pubkey: deriveLinkPda(owner.publicKey), isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(instructionDiscriminator("link_wallet")),
    });
    expectRefusal(legacyTx(owner.publicKey, [ix], [owner]), ["wallet_is_owner", "signature_count"]);
  });

  it("(i) a System transfer: program_not_allowed", () => {
    const owner = keypair();
    const transfer = SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: keypair().publicKey, lamports: 1 });
    expectRefusal(legacyTx(owner.publicKey, [transfer], [owner]), "program_not_allowed");
  });

  it("(j) Nuvem's old program, as the program or as any account: old_program", () => {
    const owner = keypair();
    const asProgram = new TransactionInstruction({ programId: new PublicKey(OLD_NUVEM_PROGRAM_ID), keys: [{ pubkey: owner.publicKey, isSigner: true, isWritable: true }], data: Buffer.from(instructionDiscriminator("link_wallet")) });
    expectRefusal(legacyTx(owner.publicKey, [asProgram], [owner]), "old_program");
    const asAccount = sipInstruction("withdraw", { owner: owner.publicKey, vault: new PublicKey(OLD_NUVEM_PROGRAM_ID) }, { amount: 1n });
    expectRefusal(legacyTx(owner.publicKey, [asAccount], [owner]), "old_program");
  });

  it("(k) a settle_v2 discriminator signed by a throwaway wallet: instruction_not_allowed", () => {
    const wallet = keypair();
    const data = new Uint8Array(8 + 1 + 32);
    data.set(instructionDiscriminator("settle_v2"), 0);
    const ix = new TransactionInstruction({ programId: new PublicKey(SIP_PROGRAM_ID), keys: [{ pubkey: wallet.publicKey, isSigner: true, isWritable: true }], data: Buffer.from(data) });
    expectRefusal(legacyTx(wallet.publicKey, [ix], [wallet]), "instruction_not_allowed");
  });

  it("(l) an unknown discriminator: unknown_discriminator", () => {
    const owner = keypair();
    const ix = new TransactionInstruction({ programId: new PublicKey(SIP_PROGRAM_ID), keys: [{ pubkey: owner.publicKey, isSigner: true, isWritable: true }], data: Buffer.from("deadbeef00000000", "hex") });
    expectRefusal(legacyTx(owner.publicKey, [ix], [owner]), "unknown_discriminator");
  });

  it("(m) two SIP instructions: instruction_count", () => {
    const owner = keypair();
    const withdraw = (): TransactionInstruction => sipInstruction("withdraw", { owner: owner.publicKey, vault: deriveVaultPda(owner.publicKey) }, { amount: 1n });
    expectRefusal(legacyTx(owner.publicKey, [withdraw(), withdraw()], [owner]), "instruction_count");
  });

  it("(n) a v0 transaction with an address lookup table: lookup_tables", () => {
    const owner = keypair();
    const wallet = keypair();
    const table = new AddressLookupTableAccount({
      key: keypair().publicKey,
      state: { deactivationSlot: BigInt("18446744073709551615"), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: [deriveVaultPda(owner.publicKey)] },
    });
    const message = new TransactionMessage({ payerKey: owner.publicKey, recentBlockhash: BLOCKHASH, instructions: [linkInstruction(owner.publicKey, wallet.publicKey)] }).compileToV0Message([table]);
    expect(message.addressTableLookups.length).toBeGreaterThan(0);
    const tx = new VersionedTransaction(message);
    tx.sign([owner, wallet]);
    expectRefusal(tx.serialize(), "lookup_tables");
  });

  it("(o) a unit price above the cap, a heap-frame request, and a repeated budget instruction: compute_budget_invalid", () => {
    const owner = keypair();
    const withdraw = sipInstruction("withdraw", { owner: owner.publicKey, vault: deriveVaultPda(owner.publicKey) }, { amount: 1n });
    expectRefusal(legacyTx(owner.publicKey, [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000_000 }), withdraw], [owner]), "compute_budget_invalid");
    expectRefusal(legacyTx(owner.publicKey, [ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }), withdraw], [owner]), "compute_budget_invalid");
    expectRefusal(
      legacyTx(owner.publicKey, [ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), withdraw], [owner]),
      "compute_budget_invalid",
    );
    expectRefusal(legacyTx(owner.publicKey, [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_001 }), withdraw], [owner]), "compute_budget_invalid");
  });

  it("(p) garbage, empty and oversized input", () => {
    let seed = 7;
    const random = Uint8Array.from({ length: 300 }, () => (seed = (seed * 1103515245 + 12345) & 0xff));
    expectRefusal(random, ["undecodable", "non_canonical"]);
    expectRefusal(new Uint8Array(0), "undecodable");
    expectRefusal(new Uint8Array(1233), "too_large");
  });

  it("(q) a withdraw with a second signer beside its owner: signature_count", () => {
    const owner = keypair();
    const payer = keypair();
    const withdraw = sipInstruction("withdraw", { owner: owner.publicKey, vault: deriveVaultPda(owner.publicKey) }, { amount: 1n });
    expectRefusal(legacyTx(payer.publicKey, [withdraw], [payer, owner]), "signature_count");
  });

  it("a hand-built withdraw whose owner does not sign, paid and signed by a stranger alone: account_binding", () => {
    const owner = keypair();
    const stranger = keypair();
    const data = new Uint8Array(16);
    data.set(instructionDiscriminator("withdraw"), 0);
    new DataView(data.buffer).setBigUint64(8, 1n, true);
    const ix = new TransactionInstruction({
      programId: new PublicKey(SIP_PROGRAM_ID),
      keys: [
        { pubkey: owner.publicKey, isSigner: false, isWritable: true },
        { pubkey: deriveVaultPda(owner.publicKey), isSigner: false, isWritable: true },
      ],
      data: Buffer.from(data),
    });
    expectRefusal(legacyTx(stranger.publicKey, [ix], [stranger]), "account_binding");
  });

  it("a create_vault_v2 whose owner meta is not a signer, signed by a stranger alone: account_binding", () => {
    const owner = keypair();
    const stranger = keypair();
    const ix = sipInstruction(
      "create_vault_v2",
      { owner: owner.publicKey, vault: deriveVaultPda(owner.publicKey), system_program: SystemProgram.programId },
      { mode: 1, skim_bps: 2_000, volume_bps: 10, max_contribution: 1_000_000_000n, wallet_reserve: 5_000_000n },
    );
    ix.keys = ix.keys.map((meta) => (meta.pubkey.equals(owner.publicKey) ? { ...meta, isSigner: false } : meta));
    expectRefusal(legacyTx(stranger.publicKey, [ix], [stranger]), "account_binding");
  });

  it("(r) a Memo instruction beside link_wallet: program_not_allowed", () => {
    const owner = keypair();
    const wallet = keypair();
    const memo = new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM), keys: [], data: Buffer.from("hello") });
    expectRefusal(legacyTx(owner.publicKey, [linkInstruction(owner.publicKey, wallet.publicKey), memo], [owner, wallet]), "program_not_allowed");
  });

  it("bytes that decode but are not canonical (an over-long length prefix, or a trailing byte): non_canonical", () => {
    const owner = keypair();
    const signed = signWire(buildWithdraw({ owner: owner.publicKey, lamports: 1n, blockhash: BLOCKHASH }).txBase64, owner);
    expect(signed[0]).toBe(1);
    const overlong = new Uint8Array(signed.length + 1);
    overlong.set([0x81, 0x00], 0);
    overlong.set(signed.subarray(1), 2);
    expectRefusal(overlong, ["non_canonical", "undecodable"]);
    const trailing = new Uint8Array(signed.length + 1);
    trailing.set(signed, 0);
    expectRefusal(trailing, ["non_canonical", "undecodable"]);
    expect(verifySignedTransaction(signed).ok).toBe(true);
  });

  it("an unlink paid by a stranger, and three signers", () => {
    const owner = keypair();
    const wallet = keypair();
    const stranger = keypair();
    const unlink = sipInstruction("unlink_wallet", { authority: owner.publicKey, owner: owner.publicKey, vault: deriveVaultPda(owner.publicKey), trading_link: deriveLinkPda(wallet.publicKey) }, {});
    expectRefusal(legacyTx(stranger.publicKey, [unlink], [stranger, owner]), "account_binding");
    const link = linkInstruction(owner.publicKey, wallet.publicKey);
    expectRefusal(legacyTx(stranger.publicKey, [link], [stranger, owner, wallet]), "signature_count");
  });

  it("refuses to run with a configured program id that is not the IDL's", () => {
    expect(() => verifySignedTransaction(new Uint8Array(10), { programId: OLD_NUVEM_PROGRAM_ID })).toThrow(/not the sip_vault IDL/);
  });

  it("never needs a network: a random key set is refused or accepted from bytes alone", () => {
    const signer = Keypair.generate();
    expect(verifySignedTransaction(legacyTx(signer.publicKey, [SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: signer.publicKey, lamports: 0 })], [signer])).ok).toBe(false);
  });
});
