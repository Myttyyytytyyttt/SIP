// The verifier, with real serialized transactions signed by throwaway keys.

import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Ed25519Program,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import {
  ATA_PROGRAM,
  ED25519_PROGRAM,
  INSTRUCTIONS_SYSVAR,
  MEMO_PROGRAM,
  RAYDIUM_CLMM,
  SPYX_MINT,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  USDC_MINT,
  WSOL_MINT,
} from "../src/client/addresses";
import { base58Encode } from "../src/client/base58";
import { base64Encode } from "../src/client/base64";
import { OLD_NUVEM_PROGRAM_ID, SIP_PROGRAM_ID, instructionDiscriminator } from "../src/client/idl";
import { linkConsentMessage } from "../src/client/link-consent";
import { ownerComputeBudget } from "../src/client/product";
import {
  buildCreateVaultV2,
  buildLinkWallet,
  buildSetInvestPolicy,
  buildUnlinkWallet,
  buildWithdraw,
  prepareLinkWalletConsent,
  sipInstruction,
  type BuiltTransaction,
} from "../src/server/builders";
import { deriveAta, deriveConfigPda, deriveInvestPda, deriveLinkPda, deriveVaultPda } from "../src/server/pda";
import { MAX_TX_BASE64_CHARS, MAX_TX_BYTES } from "../src/server/relay-policy";
import { verifySignedTransaction, type VerifyRefusal } from "../src/server/verify-tx";
import { FIRST_POLICY_VAULT_TOKEN_ACCOUNTS, GOLDEN_CONVERT_FLOOR_WAD, GOLDEN_SPYX_FLOOR_WAD } from "./fixtures/owner-transactions";
import { BLOCKHASH, b64, fromB64, keypair, legacyTx, signBytes, signWire, signedLinkWallet } from "./helpers";

const vaultPolicy = { mode: 1, skimBps: 2_000, volumeBps: 200, maxContribution: 1_000_000_000n, walletReserve: 5_000_000n };

function expectRefusal(bytes: Uint8Array, reason: VerifyRefusal | readonly VerifyRefusal[]): void {
  const result = verifySignedTransaction(bytes);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    const allowed = typeof reason === "string" ? [reason] : reason;
    expect(allowed, result.detail).toContain(result.reason);
  }
}

type LinkAccount = "vault" | "trading_link" | "config";

/** link_wallet alone, by the IDL, with its PDAs unless overridden. */
function linkInstruction(owner: PublicKey, wallet: PublicKey, overrides: Partial<Record<LinkAccount, PublicKey>> = {}): TransactionInstruction {
  return sipInstruction("link_wallet", { owner, wallet, vault: deriveVaultPda(owner), trading_link: deriveLinkPda(wallet), config: deriveConfigPda(), ...overrides }, {});
}

/** The SIP_LINK_V1 bytes for linking `wallet` to `owner`'s vault, on `programId`. */
const consentBytes = (owner: PublicKey, wallet: PublicKey, programId: string = SIP_PROGRAM_ID): Uint8Array =>
  linkConsentMessage({ programId, wallet: wallet.toBase58(), vault: deriveVaultPda(owner).toBase58(), owner: owner.toBase58() });

/**
 * An Ed25519SigVerify instruction as web3.js writes it. By default the wallet's
 * genuine consent; `key` is the public key it names, `signer` who actually
 * signed, `message` the bytes signed.
 */
function consentInstruction(
  owner: PublicKey,
  wallet: Keypair,
  options: { readonly key?: PublicKey; readonly signer?: Keypair; readonly message?: Uint8Array; readonly instructionIndex?: number } = {},
): TransactionInstruction {
  const message = options.message ?? consentBytes(owner, wallet.publicKey);
  const signer = options.signer ?? wallet;
  return Ed25519Program.createInstructionWithPublicKey({
    publicKey: (options.key ?? signer.publicKey).toBytes(),
    message,
    signature: signBytes(signer, message),
    instructionIndex: options.instructionIndex,
  });
}

/** The genuine consent with its data edited: the shapes the program refuses. */
function editedConsent(owner: PublicKey, wallet: Keypair, edit: (data: Uint8Array, view: DataView) => Uint8Array | void): TransactionInstruction {
  const data = Uint8Array.from(consentInstruction(owner, wallet).data);
  const replaced = edit(data, new DataView(data.buffer)) ?? data;
  return new TransactionInstruction({ programId: new PublicKey(ED25519_PROGRAM), keys: [], data: Buffer.from(replaced) });
}

/** `before`, then link_wallet (or `link`), then `after`, paid by the owner and signed by the owner and the wallet. */
function linkTx(owner: Keypair, wallet: Keypair, before: TransactionInstruction[], options: { readonly link?: TransactionInstruction; readonly after?: TransactionInstruction[] } = {}): Uint8Array {
  return legacyTx(owner.publicKey, [...before, options.link ?? linkInstruction(owner.publicKey, wallet.publicKey), ...(options.after ?? [])], [owner, wallet]);
}

/** The link transaction exactly as the builder returns it, unsigned. */
function builtLink(owner: Keypair, wallet: Keypair, blockhash = BLOCKHASH): BuiltTransaction {
  const consent = fromB64(prepareLinkWalletConsent({ owner: owner.publicKey, wallet: wallet.publicKey }).consentMessageBase64);
  return buildLinkWallet({ owner: owner.publicKey, wallet: wallet.publicKey, consentSignature: signBytes(wallet, consent), blockhash });
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
    expect(result.instruction.args).toEqual({ mode: 1, skim_bps: 2_000, volume_bps: 200, max_contribution: 1_000_000_000n, wallet_reserve: 5_000_000n });
    expect(result.wireBase64).toBe(b64(signed));
    expect(result.version).toBe("legacy");
  });

  it("(b) link_wallet as the builder makes it: the wallet's consent, then link_wallet, signed owner first, then the wallet", () => {
    const owner = keypair();
    const wallet = keypair();
    const signed = signedLinkWallet(owner, wallet);
    expect(signed.length).toBeLessThanOrEqual(MAX_TX_BYTES);
    expect(base64Encode(signed).length).toBeLessThanOrEqual(MAX_TX_BASE64_CHARS);
    const result = verifySignedTransaction(signed, { programId: SIP_PROGRAM_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feePayer).toBe(owner.publicKey.toBase58());
    expect(result.signers).toEqual([owner.publicKey.toBase58(), wallet.publicKey.toBase58()]);
    expect(result.instruction.accounts).toMatchObject({
      wallet: wallet.publicKey.toBase58(),
      vault: deriveVaultPda(owner.publicKey).toBase58(),
      config: deriveConfigPda().toBase58(),
      instructions_sysvar: INSTRUCTIONS_SYSVAR,
    });
    expect(result.instructions).toEqual([
      { program: ED25519_PROGRAM, name: "Ed25519SigVerify" },
      { program: SIP_PROGRAM_ID, name: "link_wallet" },
    ]);
  });

  it("(c) the consent reads its own data wherever it sits: budget instructions prepended, and an explicit own index", () => {
    const owner = keypair();
    const wallet = keypair();
    const priced = verifySignedTransaction(linkTx(owner, wallet, [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }), consentInstruction(owner.publicKey, wallet)]));
    expect(priced.ok).toBe(true);
    if (priced.ok) {
      expect(priced.computeBudget.microLamports).toBe(10_000n);
      expect(priced.instructions.map((instruction) => instruction.name)).toEqual(["SetComputeUnitPrice", "Ed25519SigVerify", "link_wallet"]);
    }
    const budget = [ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 })];
    expect(verifySignedTransaction(linkTx(owner, wallet, [...budget, consentInstruction(owner.publicKey, wallet, { instructionIndex: 2 })])).ok).toBe(true);
    const ownIndexZero = editedConsent(owner.publicKey, wallet, (_, view) => {
      for (const at of [4, 8, 14]) view.setUint16(at, 0, true);
    });
    expect(verifySignedTransaction(linkTx(owner, wallet, [ownIndexZero])).ok).toBe(true);
  });

  it("(d) the same link as a v0 message with no lookup tables", () => {
    const owner = keypair();
    const wallet = keypair();
    const message = new TransactionMessage({
      payerKey: owner.publicKey,
      recentBlockhash: BLOCKHASH,
      instructions: [consentInstruction(owner.publicKey, wallet), linkInstruction(owner.publicKey, wallet.publicKey)],
    }).compileToV0Message();
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

  it("unlink_wallet by the owner, alone", () => {
    const owner = keypair();
    const wallet = keypair();
    const built = buildUnlinkWallet({ owner: owner.publicKey, wallet: wallet.publicKey, blockhash: BLOCKHASH });
    const result = verifySignedTransaction(signWire(built.txBase64, owner));
    expect(result.ok).toBe(true);
    if (result.ok) expect([result.signers, result.instruction.accounts.authority]).toEqual([[owner.publicKey.toBase58()], owner.publicKey.toBase58()]);
  });
});

describe("refused", () => {
  it("(f) a link carrying only the owner's signature: missing_signature", () => {
    const owner = keypair();
    const wallet = keypair();
    expectRefusal(signWire(builtLink(owner, wallet).txBase64, owner), "missing_signature");
  });

  it("(g) a link whose wallet signed a different message: bad_signature", () => {
    const owner = keypair();
    const wallet = keypair();
    const real = VersionedTransaction.deserialize(fromB64(builtLink(owner, wallet).txBase64));
    real.sign([owner]);
    const otherHash = base58Encode(Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 2) & 0xff));
    const other = VersionedTransaction.deserialize(fromB64(builtLink(owner, wallet, otherHash).txBase64));
    other.sign([wallet]);
    real.signatures[1] = other.signatures[1]!;
    expectRefusal(real.serialize(), "bad_signature");
  });

  it("(h) a hand-built link_wallet naming the owner twice, with the owner's own consent: wallet_is_owner", () => {
    const owner = keypair();
    const ix = sipInstruction(
      "link_wallet",
      { owner: owner.publicKey, wallet: owner.publicKey, vault: deriveVaultPda(owner.publicKey), trading_link: deriveLinkPda(owner.publicKey), config: deriveConfigPda() },
      {},
    );
    expectRefusal(legacyTx(owner.publicKey, [consentInstruction(owner.publicKey, owner), ix], [owner]), "wallet_is_owner");
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

  it("(k2) wrap_sol, convert and invest are refused whatever their data: instruction_not_allowed", () => {
    const crank = keypair();
    for (const name of ["wrap_sol", "convert", "invest"]) {
      const ix = new TransactionInstruction({ programId: new PublicKey(SIP_PROGRAM_ID), keys: [{ pubkey: crank.publicKey, isSigner: true, isWritable: true }], data: Buffer.from(instructionDiscriminator(name)) });
      expectRefusal(legacyTx(crank.publicKey, [ix], [crank]), "instruction_not_allowed");
    }
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
    const message = new TransactionMessage({
      payerKey: owner.publicKey,
      recentBlockhash: BLOCKHASH,
      instructions: [consentInstruction(owner.publicKey, wallet), linkInstruction(owner.publicKey, wallet.publicKey)],
    }).compileToV0Message([table]);
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

  it("a create_vault_v2 whose system_program is not the System program: account_binding", () => {
    const owner = keypair();
    const ix = sipInstruction("create_vault_v2", { owner: owner.publicKey, vault: deriveVaultPda(owner.publicKey) }, { mode: 1, skim_bps: 2_000, volume_bps: 10, max_contribution: 1n, wallet_reserve: 0n });
    ix.keys = ix.keys.map((meta, index) => (index === 2 ? { ...meta, pubkey: keypair().publicKey } : meta));
    expectRefusal(legacyTx(owner.publicKey, [ix], [owner]), "account_binding");
  });

  it("(r) a Memo instruction beside link_wallet: program_not_allowed", () => {
    const owner = keypair();
    const wallet = keypair();
    const memo = new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM), keys: [], data: Buffer.from("hello") });
    expectRefusal(linkTx(owner, wallet, [consentInstruction(owner.publicKey, wallet)], { after: [memo] }), "program_not_allowed");
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

  it("a link with three signers: signature_count", () => {
    const owner = keypair();
    const wallet = keypair();
    const stranger = keypair();
    const link = linkInstruction(owner.publicKey, wallet.publicKey);
    expectRefusal(legacyTx(stranger.publicKey, [consentInstruction(owner.publicKey, wallet), link], [stranger, owner, wallet]), "signature_count");
  });

  it("refuses to run with a configured program id that is not the IDL's", () => {
    expect(() => verifySignedTransaction(new Uint8Array(10), { programId: OLD_NUVEM_PROGRAM_ID })).toThrow(/not the sip_vault IDL/);
  });

  it("never needs a network: a random key set is refused or accepted from bytes alone", () => {
    const signer = Keypair.generate();
    expect(verifySignedTransaction(legacyTx(signer.publicKey, [SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: signer.publicKey, lamports: 0 })], [signer])).ok).toBe(false);
  });
});

describe("the wallet's link consent", () => {
  it("link_wallet with no Ed25519SigVerify before it, alone or behind a budget instruction: link_consent_missing", () => {
    const owner = keypair();
    const wallet = keypair();
    expectRefusal(linkTx(owner, wallet, []), "link_consent_missing");
    expectRefusal(linkTx(owner, wallet, [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 })]), "link_consent_missing");
  });

  it("an Ed25519SigVerify anywhere but immediately before link_wallet: ed25519_misplaced", () => {
    const owner = keypair();
    const wallet = keypair();
    const consent = (): TransactionInstruction => consentInstruction(owner.publicKey, wallet);
    // A budget instruction between the consent and the link.
    expectRefusal(linkTx(owner, wallet, [consent(), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 })]), "ed25519_misplaced");
    // Two consents.
    expectRefusal(linkTx(owner, wallet, [consent(), consent()]), "ed25519_misplaced");
    // After the link.
    expectRefusal(linkTx(owner, wallet, [], { after: [consent()] }), "ed25519_misplaced");
    // Beside another owner instruction.
    const withdraw = sipInstruction("withdraw", { owner: owner.publicKey, vault: deriveVaultPda(owner.publicKey) }, { amount: 1n });
    expectRefusal(legacyTx(owner.publicKey, [consent(), withdraw], [owner]), "ed25519_misplaced");
    const unlink = sipInstruction("unlink_wallet", { authority: owner.publicKey, owner: owner.publicKey, vault: deriveVaultPda(owner.publicKey), trading_link: deriveLinkPda(wallet.publicKey) }, {});
    expectRefusal(legacyTx(owner.publicKey, [consent(), unlink], [owner]), "ed25519_misplaced");
  });

  it("an Ed25519SigVerify checking 0 or 2 signatures: ed25519_signature_count", () => {
    const owner = keypair();
    const wallet = keypair();
    for (const count of [0, 2]) {
      const consent = editedConsent(owner.publicKey, wallet, (data) => {
        data[0] = count;
      });
      expectRefusal(linkTx(owner, wallet, [consent]), "ed25519_signature_count");
    }
  });

  it("an Ed25519SigVerify shorter than its header, or listing an account: ed25519_malformed", () => {
    const owner = keypair();
    const wallet = keypair();
    expectRefusal(linkTx(owner, wallet, [editedConsent(owner.publicKey, wallet, (data) => data.slice(0, 10))]), "ed25519_malformed");
    const genuine = consentInstruction(owner.publicKey, wallet);
    const withAccount = new TransactionInstruction({ programId: genuine.programId, keys: [{ pubkey: owner.publicKey, isSigner: false, isWritable: false }], data: genuine.data });
    expectRefusal(linkTx(owner, wallet, [withAccount]), "ed25519_malformed");
  });

  it("an Ed25519SigVerify reading from another instruction or past its own data: ed25519_offsets", () => {
    const owner = keypair();
    const wallet = keypair();
    // The message read out of instruction 1: link_wallet's own data.
    expectRefusal(linkTx(owner, wallet, [editedConsent(owner.publicKey, wallet, (_, view) => view.setUint16(14, 1, true))]), "ed25519_offsets");
    // The public key read from instruction 1.
    expectRefusal(linkTx(owner, wallet, [editedConsent(owner.publicKey, wallet, (_, view) => view.setUint16(8, 1, true))]), "ed25519_offsets");
    // A message one byte longer than the data holds.
    expectRefusal(linkTx(owner, wallet, [editedConsent(owner.publicKey, wallet, (_, view) => view.setUint16(12, 141, true))]), "ed25519_offsets");
    // A signature offset whose 64 bytes run past the end.
    expectRefusal(linkTx(owner, wallet, [editedConsent(owner.publicKey, wallet, (data, view) => view.setUint16(2, data.length - 63, true))]), "ed25519_offsets");
  });

  it("a consent verifying another key than the wallet's: link_consent_wrong_signer", () => {
    const owner = keypair();
    const wallet = keypair();
    const stranger = keypair();
    expectRefusal(linkTx(owner, wallet, [consentInstruction(owner.publicKey, wallet, { signer: stranger })]), "link_consent_wrong_signer");
    // The owner "consenting" for the wallet.
    expectRefusal(linkTx(owner, wallet, [consentInstruction(owner.publicKey, wallet, { signer: owner })]), "link_consent_wrong_signer");
  });

  it("the wallet's genuine signature over other bytes — another owner's vault, another deployment, a truncated consent: link_consent_mismatch", () => {
    const owner = keypair();
    const wallet = keypair();
    const other = keypair().publicKey;
    expectRefusal(linkTx(owner, wallet, [consentInstruction(owner.publicKey, wallet, { message: consentBytes(other, wallet.publicKey) })]), "link_consent_mismatch");
    expectRefusal(linkTx(owner, wallet, [consentInstruction(owner.publicKey, wallet, { message: consentBytes(owner.publicKey, wallet.publicKey, OLD_NUVEM_PROGRAM_ID) })]), "link_consent_mismatch");
    expectRefusal(linkTx(owner, wallet, [consentInstruction(owner.publicKey, wallet, { message: consentBytes(owner.publicKey, wallet.publicKey).subarray(0, 139) })]), "link_consent_mismatch");
  });

  it("the wallet's key and the right bytes with a signature that does not verify: link_consent_bad_signature", () => {
    const owner = keypair();
    const wallet = keypair();
    expectRefusal(linkTx(owner, wallet, [consentInstruction(owner.publicKey, wallet, { key: wallet.publicKey, signer: keypair() })]), "link_consent_bad_signature");
    const flipped = editedConsent(owner.publicKey, wallet, (data) => {
      data[48] = data[48]! ^ 1;
    });
    expectRefusal(linkTx(owner, wallet, [flipped]), "link_consent_bad_signature");
  });

  it("link_wallet's accounts at the wrong addresses, with a genuine consent: account_binding", () => {
    const owner = keypair();
    const wallet = keypair();
    const consent = (): TransactionInstruction => consentInstruction(owner.publicKey, wallet);
    for (const account of ["vault", "trading_link", "config"] as const) {
      expectRefusal(linkTx(owner, wallet, [consent()], { link: linkInstruction(owner.publicKey, wallet.publicKey, { [account]: keypair().publicKey }) }), "account_binding");
    }
    // The fixed addresses: 5 is the instructions sysvar, 6 the System program.
    for (const index of [5, 6]) {
      const ix = linkInstruction(owner.publicKey, wallet.publicKey);
      ix.keys = ix.keys.map((meta, position) => (position === index ? { ...meta, pubkey: keypair().publicKey } : meta));
      expectRefusal(linkTx(owner, wallet, [consent()], { link: ix }), "account_binding");
    }
    // A consent AND a vault for another owner agree with each other, not with the owner who signs.
    const other = keypair().publicKey;
    expectRefusal(
      linkTx(owner, wallet, [consentInstruction(owner.publicKey, wallet, { message: consentBytes(other, wallet.publicKey) })], {
        link: linkInstruction(owner.publicKey, wallet.publicKey, { vault: deriveVaultPda(other) }),
      }),
      "account_binding",
    );
  });
});

describe("set_invest_policy's vault token accounts (rules 8b and 13b)", () => {
  /** set_invest_policy's arguments for a basket of `legs`, at the golden floors. */
  const policyArgs = (legs: readonly string[]) => ({
    legs: legs.map((mint) => ({ mint, weight_bps: 10_000 / legs.length, min_out_rate_wad: GOLDEN_SPYX_FLOOR_WAD })),
    venue_program: RAYDIUM_CLMM,
    in_mint: USDC_MINT,
    min_convert_rate_wad: GOLDEN_CONVERT_FLOOR_WAD,
    min_investment: 2_500_000n,
    max_per_call: 1_000_000_000n,
    max_rolling_30d: 31_000_000_000n,
    enabled: true,
  });

  function policyInstruction(owner: PublicKey, legs: readonly string[] = [SPYX_MINT]): TransactionInstruction {
    const vault = deriveVaultPda(owner);
    return sipInstruction("set_invest_policy", { owner, vault, policy: deriveInvestPda(vault) }, policyArgs(legs));
  }

  interface Slots {
    funder: PublicKey;
    funderSigns: boolean;
    account: PublicKey;
    wallet: PublicKey;
    mint: PublicKey;
    system: PublicKey;
    tokenProgram: PublicKey;
    data: number[];
  }

  /** A CreateIdempotent for `owner`'s vault's `mint` account, as the builder writes it, with any slot replaced. */
  function createAccount(owner: PublicKey, mint: string, tokenProgram: string, overrides: Partial<Slots> = {}): TransactionInstruction {
    const vault = deriveVaultPda(owner);
    const slots: Slots = {
      funder: owner,
      funderSigns: true,
      account: deriveAta(vault, mint, tokenProgram),
      wallet: vault,
      mint: new PublicKey(mint),
      system: new PublicKey(SYSTEM_PROGRAM),
      tokenProgram: new PublicKey(tokenProgram),
      data: [1],
      ...overrides,
    };
    return new TransactionInstruction({
      programId: new PublicKey(ATA_PROGRAM),
      keys: [
        { pubkey: slots.funder, isSigner: slots.funderSigns, isWritable: true },
        { pubkey: slots.account, isSigner: false, isWritable: true },
        { pubkey: slots.wallet, isSigner: false, isWritable: false },
        { pubkey: slots.mint, isSigner: false, isWritable: false },
        { pubkey: slots.system, isSigner: false, isWritable: false },
        { pubkey: slots.tokenProgram, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(slots.data),
    });
  }

  const wsolAccount = (owner: PublicKey, overrides: Partial<Slots> = {}): TransactionInstruction => createAccount(owner, WSOL_MINT, TOKEN_PROGRAM, overrides);
  const budget = (): TransactionInstruction[] => [ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 })];

  it("accepted: the builder's first policy behind its compute budget with 0, 1, 2 or 3 of the vault's accounts, up to 6 instructions", () => {
    for (let count = 0; count <= 3; count++) {
      const owner = keypair();
      const built = buildSetInvestPolicy({
        owner: owner.publicKey,
        blockhash: BLOCKHASH,
        legs: [{ mint: SPYX_MINT, weightBps: 10_000, minOutRateWad: GOLDEN_SPYX_FLOOR_WAD }],
        minConvertRateWad: GOLDEN_CONVERT_FLOOR_WAD,
        minInvestment: 5_000_000n,
        maxPerCall: 1_000_000_000n,
        maxRolling30d: 31_000_000_000n,
        enabled: true,
        computeBudget: ownerComputeBudget("set_invest_policy"),
        vaultTokenAccounts: FIRST_POLICY_VAULT_TOKEN_ACCOUNTS.slice(0, count),
      });
      const result = verifySignedTransaction(signWire(built.txBase64, owner));
      expect(result.ok, result.ok ? "" : result.detail).toBe(true);
      if (!result.ok) continue;
      expect(result.instructions.map((instruction) => instruction.name)).toEqual([
        "SetComputeUnitLimit",
        "SetComputeUnitPrice",
        ...new Array<string>(count).fill("CreateIdempotent"),
        "set_invest_policy",
      ]);
    }
  });

  it("a well-formed CreateIdempotent beside withdraw: program_not_allowed", () => {
    const owner = keypair();
    const withdraw = sipInstruction("withdraw", { owner: owner.publicKey, vault: deriveVaultPda(owner.publicKey) }, { amount: 1n });
    expectRefusal(legacyTx(owner.publicKey, [...budget(), wsolAccount(owner.publicKey), withdraw], [owner]), "program_not_allowed");
  });

  it.each<[string, number[]]>([
    ["Create (data [])", []],
    ["RecoverNested (data [2])", [2]],
  ])("%s instead of CreateIdempotent: vault_account_invalid", (_, data) => {
    const owner = keypair();
    expectRefusal(legacyTx(owner.publicKey, [...budget(), wsolAccount(owner.publicKey, { data }), policyInstruction(owner.publicKey)], [owner]), "vault_account_invalid");
  });

  it("a funder that is not the fee payer: vault_account_invalid", () => {
    const owner = keypair();
    const funded = wsolAccount(owner.publicKey, { funder: keypair().publicKey, funderSigns: false });
    expectRefusal(legacyTx(owner.publicKey, [funded, policyInstruction(owner.publicKey)], [owner]), "vault_account_invalid");
  });

  it("an account for another owner's vault, at that vault's own ATA: vault_account_invalid", () => {
    const owner = keypair();
    const otherVault = deriveVaultPda(keypair().publicKey);
    const theirs = wsolAccount(owner.publicKey, { wallet: otherVault, account: deriveAta(otherVault, WSOL_MINT, TOKEN_PROGRAM) });
    expectRefusal(legacyTx(owner.publicKey, [...budget(), theirs, policyInstruction(owner.publicKey)], [owner]), "vault_account_invalid");
  });

  it("a mint that is neither wSOL, the in-mint nor a leg: vault_account_invalid", () => {
    const owner = keypair();
    const stray = createAccount(owner.publicKey, keypair().publicKey.toBase58(), TOKEN_PROGRAM);
    expectRefusal(legacyTx(owner.publicKey, [stray, policyInstruction(owner.publicKey)], [owner]), "vault_account_invalid");
  });

  it("an account that is not ATA(vault, mint, program), including the SPYx account under the wrong token program: vault_account_invalid", () => {
    const owner = keypair();
    const vault = deriveVaultPda(owner.publicKey);
    for (const account of [keypair().publicKey, deriveAta(vault, SPYX_MINT, TOKEN_PROGRAM)]) {
      const wrong = createAccount(owner.publicKey, SPYX_MINT, TOKEN_2022_PROGRAM, { account });
      expectRefusal(legacyTx(owner.publicKey, [wrong, policyInstruction(owner.publicKey)], [owner]), "vault_account_invalid");
    }
  });

  it("Memo in the token program's slot: vault_account_invalid", () => {
    const owner = keypair();
    const memo = wsolAccount(owner.publicKey, { tokenProgram: new PublicKey(MEMO_PROGRAM), account: keypair().publicKey });
    expectRefusal(legacyTx(owner.publicKey, [memo, policyInstruction(owner.publicKey)], [owner]), "vault_account_invalid");
  });

  it("another key in the System program's slot: vault_account_invalid", () => {
    const owner = keypair();
    const system = wsolAccount(owner.publicKey, { system: keypair().publicKey });
    expectRefusal(legacyTx(owner.publicKey, [system, policyInstruction(owner.publicKey)], [owner]), "vault_account_invalid");
  });

  it("a CreateIdempotent after set_invest_policy: vault_account_invalid", () => {
    const owner = keypair();
    expectRefusal(legacyTx(owner.publicKey, [...budget(), policyInstruction(owner.publicKey), wsolAccount(owner.publicKey)], [owner]), "vault_account_invalid");
  });

  it("the same mint twice: vault_account_invalid", () => {
    const owner = keypair();
    expectRefusal(legacyTx(owner.publicKey, [wsolAccount(owner.publicKey), wsolAccount(owner.publicKey), policyInstruction(owner.publicKey)], [owner]), "vault_account_invalid");
  });

  it("four accounts, even for four mints a two-leg policy names: vault_account_invalid", () => {
    const owner = keypair();
    const second = keypair().publicKey.toBase58();
    const creates = [
      wsolAccount(owner.publicKey),
      createAccount(owner.publicKey, USDC_MINT, TOKEN_PROGRAM),
      createAccount(owner.publicKey, SPYX_MINT, TOKEN_2022_PROGRAM),
      createAccount(owner.publicKey, second, TOKEN_PROGRAM),
    ];
    expectRefusal(legacyTx(owner.publicKey, [...creates, policyInstruction(owner.publicKey, [SPYX_MINT, second])], [owner]), "vault_account_invalid");
  });

  it("five instructions with no token-account instruction, and seven with three: instruction_count", () => {
    const owner = keypair();
    const withdraw = sipInstruction("withdraw", { owner: owner.publicKey, vault: deriveVaultPda(owner.publicKey) }, { amount: 1n });
    expectRefusal(legacyTx(owner.publicKey, [...budget(), ...budget(), withdraw], [owner]), "instruction_count");
    const creates = [wsolAccount(owner.publicKey), createAccount(owner.publicKey, USDC_MINT, TOKEN_PROGRAM), createAccount(owner.publicKey, SPYX_MINT, TOKEN_2022_PROGRAM)];
    const memo = new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM), keys: [], data: Buffer.from("x") });
    expectRefusal(legacyTx(owner.publicKey, [...budget(), memo, ...creates, policyInstruction(owner.publicKey)], [owner]), "instruction_count");
  });

  it("link_wallet behind its compute budget is still [CU limit, CU price, Ed25519SigVerify, link_wallet], and verifies", () => {
    const owner = keypair();
    const wallet = keypair();
    const consent = fromB64(prepareLinkWalletConsent({ owner: owner.publicKey, wallet: wallet.publicKey }).consentMessageBase64);
    const built = buildLinkWallet({ owner: owner.publicKey, wallet: wallet.publicKey, consentSignature: signBytes(wallet, consent), blockhash: BLOCKHASH, computeBudget: ownerComputeBudget("link_wallet") });
    const result = verifySignedTransaction(signWire(built.txBase64, owner, wallet));
    expect(result.ok, result.ok ? "" : result.detail).toBe(true);
    if (result.ok) expect(result.instructions.map((instruction) => instruction.name)).toEqual(["SetComputeUnitLimit", "SetComputeUnitPrice", "Ed25519SigVerify", "link_wallet"]);
  });
});

describe("unlink_wallet: the owner alone", () => {
  const unlink = (authority: PublicKey, owner: PublicKey, wallet: PublicKey, vaultOwner: PublicKey = owner): TransactionInstruction =>
    sipInstruction("unlink_wallet", { authority, owner, vault: deriveVaultPda(vaultOwner), trading_link: deriveLinkPda(wallet) }, {});

  it("the wallet as its own authority, even with the owner paying and signing: account_binding", () => {
    const owner = keypair();
    const wallet = keypair();
    expectRefusal(legacyTx(owner.publicKey, [unlink(wallet.publicKey, owner.publicKey, wallet.publicKey)], [owner, wallet]), "account_binding");
  });

  it("the wallet as authority and fee payer, alone: account_binding", () => {
    const owner = keypair();
    const wallet = keypair();
    const ix = unlink(wallet.publicKey, owner.publicKey, wallet.publicKey);
    // The owner meta is only the rent destination; the wallet signs and pays.
    expectRefusal(legacyTx(wallet.publicKey, [ix], [wallet]), "account_binding");
  });

  it("an owner's unlink paid by a stranger: account_binding", () => {
    const owner = keypair();
    const wallet = keypair();
    const stranger = keypair();
    expectRefusal(legacyTx(stranger.publicKey, [unlink(owner.publicKey, owner.publicKey, wallet.publicKey)], [stranger, owner]), "account_binding");
  });

  it("an owner naming a vault that is not ['vault', owner]: account_binding", () => {
    const owner = keypair();
    const wallet = keypair();
    const other = keypair().publicKey;
    expectRefusal(legacyTx(owner.publicKey, [unlink(owner.publicKey, owner.publicKey, wallet.publicKey, other)], [owner]), "account_binding");
  });
});
