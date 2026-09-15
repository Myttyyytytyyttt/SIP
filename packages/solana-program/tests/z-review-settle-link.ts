// Review gate: three findings on settle_v2 and the trading link.
//
// FINDING 6 (ed25519_introspection.rs:77-80). The Ed25519 offset table is
// hostile input. Each of its three instruction-index fields
// (signature_instruction_index, public_key_instruction_index,
// message_instruction_index) tells the RUNTIME's precompile which instruction
// to read that component from. The introspection reader instead reads the
// pubkey and message from the Ed25519 instruction's OWN data at the given
// offsets. If a field is allowed to point at ANOTHER instruction, the runtime
// verifies one (key, signature, message) triple while the program compares a
// different one it read from its own bytes — a signature by a key of the
// attacker's choosing passes as the attester's. Lines 78-80 forbid any
// instruction-index that is not u16::MAX (the "current instruction" sentinel)
// or this very instruction. Each test below forges exactly that: an Ed25519
// instruction, immediately before settle_v2 / link_wallet, one of whose
// index fields points at a SECOND Ed25519 instruction that carries a genuine
// signature by another key over the expected bytes. The forged instruction
// still verifies at the runtime (the cross-referenced component is byte-for-byte
// what the reader would have found locally), so the transaction reaches the
// program, which refuses it with AttestationMalformed — the shared shape refusal
// (settle's ATTESTATION_REFUSALS.malformed and link_wallet's
// LINK_CONSENT_REFUSALS.malformed are both NuvemError::AttestationMalformed,
// #6009). For settle there are also the two other shape refusals: an Ed25519
// instruction carrying two signatures (count != 1), and a truncated header.
//
// FINDING 17 (LinkVaultMismatch, #6003). A trading link is keyed by wallet, but
// carries the vault it belongs to. unlink_wallet and settle_v2 both constrain
// `trading_link.vault == vault.key()`, so neither can be pointed at a link that
// belongs to a different vault. Proven from both instructions.
//
// FINDING 18 (settle_v2's reserve/window boundaries). The trading wallet's
// balance after paying a settlement must stay at or above its own rent-exempt
// floor plus the owner's configured reserve (settle.rs:146-148). Tested at the
// exact boundary (accepted), one lamport past it (WalletBelowReserve, #6032),
// and with a zero reserve where only the rent floor remains. Plus the window
// rule (start must be strictly below end, InvalidSessionWindow #6012) and the
// inclusive deadline (now <= valid_until_slot).
//
// SHARED STATE. Every vault, wallet, link and mint here is freshly generated per
// test. This file never touches the shared ProtocolConfig's attester, keeper,
// authority or pause switch, so there is nothing for an after() hook to restore.
// Named z-review-* so mocha's --sort runs it after every existing spec; it
// shares their one validator and one ProtocolConfig (attester = TEST_ATTESTER).

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Ed25519Program,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import { assert } from "chai";
import { SipVault } from "../target/types/sip_vault";
import { configPdaFor, ensureConfig, pollingConfirm, TEST_ATTESTER } from "./config-fixture";
import { attestationInstruction, attestationMessage, MODE_PROFIT, type AttestationInputs } from "../scripts/attestation";
import { linkConsentMessage, linkWalletWithConsent } from "../scripts/link-consent";

describe("sip-vault review: settle_v2 and the trading link (findings 6, 17, 18)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.sipVault as Program<SipVault>;
  const connection = pollingConfirm(provider.connection);

  // The profit rate every vault here is created with. A quarter, so a base of
  // 4x an amount owes exactly that amount and the reserve arithmetic is legible.
  const SKIM_BPS = 2_500;

  // ── error identities. errors.rs only ever appends, so code AND number are stable. ──
  interface Refusal {
    readonly code: string;
    readonly number: number;
  }
  const ATTESTATION_MALFORMED: Refusal = { code: "AttestationMalformed", number: 6009 };
  const LINK_VAULT_MISMATCH: Refusal = { code: "LinkVaultMismatch", number: 6003 };
  const WALLET_BELOW_RESERVE: Refusal = { code: "WalletBelowReserve", number: 6032 };
  const INVALID_SESSION_WINDOW: Refusal = { code: "InvalidSessionWindow", number: 6012 };
  const ATTESTATION_EXPIRED: Refusal = { code: "AttestationExpired", number: 6028 };

  // ── Ed25519 instruction layout, shared by web3.js and the on-chain reader. ──
  // Header (16 B): count u8, padding u8, then one 14-byte offsets struct of
  // seven u16s. A single-signature body follows: key 32, signature 64, message.
  const PUBKEY_OFFSET = 16;
  const SIG_OFFSET = 48;
  const MSG_OFFSET = 112;
  // Byte offsets of the three instruction-index u16 fields inside the header,
  // matching u16_at(4)/u16_at(8)/u16_at(14) in ed25519_introspection.rs.
  const SIG_IX_FIELD = 4;
  const PUBKEY_IX_FIELD = 8;
  const MSG_IX_FIELD = 14;

  const bn = (value: number | bigint) => new anchor.BN(value.toString());

  const airdropExact = async (to: PublicKey, lamports: number) => {
    const signature = await connection.requestAirdrop(to, lamports);
    await connection.confirmTransaction(signature);
  };

  const vaultOf = (owner: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("vault"), owner.toBuffer()], program.programId)[0];
  const linkOf = (wallet: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("link"), wallet.toBuffer()], program.programId)[0];

  /** Waits until the chain's slot is strictly above `above`. */
  const slotAbove = async (above: number): Promise<number> => {
    for (;;) {
      const slot = await connection.getSlot();
      if (slot > above) return slot;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };

  /** Fails unless `call` is refused with exactly this program error, by name and number. */
  const expectRefusal = async (call: Promise<unknown>, refusal: Refusal, what: string) => {
    let succeeded = false;
    let thrown: unknown = null;
    try {
      await call;
      succeeded = true;
    } catch (error) {
      thrown = error;
    }
    assert.isFalse(succeeded, `${what}: expected ${refusal.code}, but it succeeded`);
    const errorCode = (thrown as { error?: { errorCode?: { code?: string; number?: number } } } | null)?.error
      ?.errorCode;
    assert.strictEqual(errorCode?.code, refusal.code, `${what}: refused for another reason: ${String(thrown).slice(0, 400)}`);
    assert.strictEqual(errorCode?.number, refusal.number, `${what}: ${refusal.code} must keep its number`);
  };

  interface Linked {
    readonly owner: Keypair;
    readonly wallet: Keypair;
    readonly vault: PublicKey;
    readonly link: PublicKey;
  }

  /**
   * A fresh owner's vault with a fresh wallet linked to it. `walletLamports` is
   * airdropped to the wallet and nothing else touches its balance (the owner,
   * not the wallet, pays the vault's and link's rent, and the provider pays
   * fees), so the wallet holds exactly `walletLamports` when it settles.
   */
  const makeLinked = async (opts: {
    walletLamports: number;
    walletReserve?: number;
    maxContribution?: number;
  }): Promise<Linked> => {
    const owner = Keypair.generate();
    const wallet = Keypair.generate();
    await airdropExact(owner.publicKey, 2 * LAMPORTS_PER_SOL);
    await airdropExact(wallet.publicKey, opts.walletLamports);
    await program.methods
      .createVaultV2(MODE_PROFIT, SKIM_BPS, 20, bn(opts.maxContribution ?? LAMPORTS_PER_SOL), bn(opts.walletReserve ?? 0))
      .accounts({ owner: owner.publicKey })
      .signers([owner])
      .rpc();
    await linkWalletWithConsent(program, { owner: owner.publicKey, wallet }).signers([owner, wallet]).rpc();
    return { owner, wallet, vault: vaultOf(owner.publicKey), link: linkOf(wallet.publicKey) };
  };

  /** A fresh owner's vault, with no wallet linked. */
  const makeVault = async (): Promise<{ owner: Keypair; vault: PublicKey }> => {
    const owner = Keypair.generate();
    await airdropExact(owner.publicKey, 2 * LAMPORTS_PER_SOL);
    await program.methods
      .createVaultV2(MODE_PROFIT, SKIM_BPS, 20, bn(LAMPORTS_PER_SOL), bn(0))
      .accounts({ owner: owner.publicKey })
      .signers([owner])
      .rpc();
    return { owner, vault: vaultOf(owner.publicKey) };
  };

  /** The attestation an honest keeper would sign for this link's current state. */
  const attInputsFor = async (l: Linked, over: Partial<AttestationInputs> = {}): Promise<AttestationInputs> => {
    const link = await program.account.tradingLink.fetch(l.link);
    const vault = await program.account.vault.fetch(l.vault);
    const frontier = Number(link.frontierSlot.toString());
    const end = await slotAbove(frontier + 1);
    return {
      programId: program.programId,
      wallet: l.wallet.publicKey,
      vault: l.vault,
      linkEpoch: BigInt(link.epoch.toString()),
      settlementNonce: BigInt(link.settlementNonce.toString()),
      sessionStartSlot: BigInt(frontier),
      sessionEndSlot: BigInt(end),
      baseLamports: BigInt(LAMPORTS_PER_SOL),
      mode: vault.skimMode,
      bps: vault.skimMode === 1 ? vault.volumeBps : vault.skimBps,
      policyNonce: BigInt(vault.policyNonce.toString()),
      validUntilSlot: BigInt(end + 10_000),
      ...over,
    };
  };

  /** A low-level settle_v2 call: the accounts and pre-instructions are the caller's to choose. */
  const settleCall = (params: {
    wallet: Keypair;
    vault: PublicKey;
    link: PublicKey;
    mode: number;
    start: number | bigint;
    end: number | bigint;
    base: number | bigint;
    validUntil: number | bigint;
    pre: TransactionInstruction[];
  }) =>
    program.methods
      .settleV2(params.mode, bn(params.start), bn(params.end), bn(params.base), bn(params.validUntil))
      .accountsPartial({ wallet: params.wallet.publicKey, vault: params.vault, tradingLink: params.link })
      .preInstructions(params.pre)
      .signers([params.wallet])
      .rpc();

  /** settle_v2 with a genuine attester signature over `inputs`, sent for `l`. */
  const genuineSettle = (l: Linked, inputs: AttestationInputs) =>
    settleCall({
      wallet: l.wallet,
      vault: l.vault,
      link: l.link,
      mode: inputs.mode,
      start: inputs.sessionStartSlot,
      end: inputs.sessionEndSlot,
      base: inputs.baseLamports,
      validUntil: inputs.validUntilSlot,
      pre: [attestationInstruction(TEST_ATTESTER.secretKey, inputs)],
    });

  const genuineEd25519 = (secretKey: Uint8Array, message: Buffer) =>
    Ed25519Program.createInstructionWithPrivateKey({ privateKey: secretKey, message });

  /**
   * A byte-for-byte copy of `genuine` whose one instruction-index field (at
   * `fieldOffset` in the header) points at another instruction in the
   * transaction (index `targetIx`) instead of at itself. Because the copy is
   * identical to `genuine` at every offset, the runtime reads the cross-
   * referenced component out of `genuine` and finds the same bytes, so the
   * forged instruction still verifies — only the on-chain reader's stricter
   * self-reference check can catch it. `signerSlot`, when given, overwrites the
   * copy's own public-key field, so that the program's would-be signer check
   * (which it never reaches) could not have caught it instead.
   */
  const crossReference = (
    genuine: TransactionInstruction,
    fieldOffset: number,
    targetIx: number,
    signerSlot?: Buffer,
  ): TransactionInstruction => {
    const data = Buffer.from(genuine.data);
    data.writeUInt16LE(targetIx, fieldOffset);
    if (signerSlot !== undefined) signerSlot.copy(data, PUBKEY_OFFSET);
    return new TransactionInstruction({ programId: Ed25519Program.programId, keys: [], data });
  };

  /**
   * One Ed25519 instruction that verifies the signatures of two single-signature
   * ones (count = 2). Mirrors the layout web3.js emits, self-referential
   * throughout, so both signatures verify at the runtime and only the program's
   * count != 1 check refuses it.
   */
  const twoSignatures = (first: TransactionInstruction, second: TransactionInstruction): TransactionInstruction => {
    const parts = [first, second].map(({ data }) => ({
      key: data.subarray(PUBKEY_OFFSET, SIG_OFFSET),
      signature: data.subarray(SIG_OFFSET, MSG_OFFSET),
      message: data.subarray(MSG_OFFSET),
    }));
    const header = Buffer.alloc(2 + 14 * parts.length);
    header.writeUInt8(parts.length, 0);
    const bodies: Buffer[] = [];
    let at = header.length;
    parts.forEach((part, index) => {
      const offsets = 2 + 14 * index;
      header.writeUInt16LE(at + 32, offsets); // signature
      header.writeUInt16LE(0xffff, offsets + 2); // ...in this instruction
      header.writeUInt16LE(at, offsets + 4); // public key
      header.writeUInt16LE(0xffff, offsets + 6);
      header.writeUInt16LE(at + 96, offsets + 8); // message
      header.writeUInt16LE(part.message.length, offsets + 10);
      header.writeUInt16LE(0xffff, offsets + 12);
      bodies.push(part.key, part.signature, part.message);
      at += 96 + part.message.length;
    });
    return new TransactionInstruction({ programId: Ed25519Program.programId, keys: [], data: Buffer.concat([header, ...bodies]) });
  };

  /** rent-exempt minimum for a 0-data account: the trading wallet's own floor. */
  let rent0 = 0;

  before(async () => {
    await ensureConfig(program, provider.wallet.publicKey);
    rent0 = await connection.getMinimumBalanceForRentExemption(0);
  });

  // ── FINDING 6: a cross-referenced Ed25519 offset table is refused ──────────

  interface IndexField {
    readonly label: string;
    readonly offset: number;
    /** True for the field that decides which key the runtime reads: overwrite the copy's own key slot. */
    readonly overridesSigner: boolean;
  }
  const INDEX_FIELDS: readonly IndexField[] = [
    { label: "public_key_instruction_index", offset: PUBKEY_IX_FIELD, overridesSigner: true },
    { label: "message_instruction_index", offset: MSG_IX_FIELD, overridesSigner: false },
    { label: "signature_instruction_index", offset: SIG_IX_FIELD, overridesSigner: false },
  ];

  describe("FINDING 6: settle_v2 refuses an Ed25519 instruction whose offset table points elsewhere", () => {
    for (const field of INDEX_FIELDS) {
      it(`refuses when ${field.label} points at another instruction carrying a valid signature by another key`, async () => {
        const l = await makeLinked({ walletLamports: LAMPORTS_PER_SOL });
        const inputs = await attInputsFor(l);
        const expected = attestationMessage(inputs);

        // The SECOND instruction: a genuine Ed25519 verification of the expected
        // attestation bytes, but by an impostor key, not the configured attester.
        const impostor = Keypair.generate();
        const other = genuineEd25519(impostor.secretKey, expected);
        // The FORGED instruction, immediately before settle: identical to `other`
        // save for the one index field, which now names `other` (index 0). For
        // the public-key field, the copy's own key slot is set to the attester,
        // so the program's signer check could not have been what refused it.
        const forged = crossReference(
          other,
          field.offset,
          0,
          field.overridesSigner ? Buffer.from(TEST_ATTESTER.publicKey.toBuffer()) : undefined,
        );

        // Order: [other (0), forged (1), settle (2)]. The reader looks at index
        // 1 (forged), whose flipped field names index 0 — neither u16::MAX nor
        // the current instruction — so lines 78-80 fire before any byte compare.
        await expectRefusal(
          settleCall({
            wallet: l.wallet,
            vault: l.vault,
            link: l.link,
            mode: inputs.mode,
            start: inputs.sessionStartSlot,
            end: inputs.sessionEndSlot,
            base: inputs.baseLamports,
            validUntil: inputs.validUntilSlot,
            pre: [other, forged],
          }),
          ATTESTATION_MALFORMED,
          `settle with ${field.label} cross-referenced`,
        );
      });
    }

    it("refuses an Ed25519 instruction that verifies two signatures (count != 1)", async () => {
      const l = await makeLinked({ walletLamports: LAMPORTS_PER_SOL });
      const inputs = await attInputsFor(l);
      // The first signature is the genuine attestation; a count != 1 kills the
      // whole instruction regardless of what the second one carries.
      const genuine = attestationInstruction(TEST_ATTESTER.secretKey, inputs);
      const rider = genuineEd25519(Keypair.generate().secretKey, Buffer.from("a second signature, riding along"));
      await expectRefusal(
        settleCall({
          wallet: l.wallet,
          vault: l.vault,
          link: l.link,
          mode: inputs.mode,
          start: inputs.sessionStartSlot,
          end: inputs.sessionEndSlot,
          base: inputs.baseLamports,
          validUntil: inputs.validUntilSlot,
          pre: [twoSignatures(genuine, rider)],
        }),
        ATTESTATION_MALFORMED,
        "settle with a two-signature Ed25519 instruction",
      );
    });

    it("refuses a truncated Ed25519 header (a zero-signature stub the runtime lets through)", async () => {
      const l = await makeLinked({ walletLamports: LAMPORTS_PER_SOL });
      const inputs = await attInputsFor(l);
      // count = 0, length 2: the runtime verifies nothing and accepts it, so the
      // transaction reaches the program, which sees data.len() < 16 -> malformed.
      const truncated = new TransactionInstruction({
        programId: Ed25519Program.programId,
        keys: [],
        data: Buffer.from([0, 0]),
      });
      await expectRefusal(
        settleCall({
          wallet: l.wallet,
          vault: l.vault,
          link: l.link,
          mode: inputs.mode,
          start: inputs.sessionStartSlot,
          end: inputs.sessionEndSlot,
          base: inputs.baseLamports,
          validUntil: inputs.validUntilSlot,
          pre: [truncated],
        }),
        ATTESTATION_MALFORMED,
        "settle with a truncated Ed25519 header",
      );
    });
  });

  describe("FINDING 6: link_wallet refuses an Ed25519 consent whose offset table points elsewhere", () => {
    let owner: Keypair;
    let vault: PublicKey;

    before(async () => {
      const made = await makeVault();
      owner = made.owner;
      vault = made.vault;
    });

    for (const field of INDEX_FIELDS) {
      it(`refuses when ${field.label} points at another instruction carrying a valid signature by another key`, async () => {
        const wallet = Keypair.generate();
        const expected = linkConsentMessage({
          programId: program.programId,
          wallet: wallet.publicKey,
          vault,
          owner: owner.publicKey,
        });

        // A genuine consent over the expected bytes, but signed by an impostor,
        // not by the wallet. link_wallet's expected signer is the wallet, so the
        // public-key field's copy carries the wallet's key in its own slot.
        const impostor = Keypair.generate();
        const other = genuineEd25519(impostor.secretKey, expected);
        const forged = crossReference(
          other,
          field.offset,
          0,
          field.overridesSigner ? Buffer.from(wallet.publicKey.toBuffer()) : undefined,
        );

        await expectRefusal(
          linkWalletWithConsent(program, { owner: owner.publicKey, wallet, consent: [other, forged] })
            .signers([owner, wallet])
            .rpc(),
          ATTESTATION_MALFORMED,
          `link_wallet with ${field.label} cross-referenced`,
        );
        assert.isNull(await connection.getAccountInfo(linkOf(wallet.publicKey)), "no link was created");
      });
    }
  });

  // ── FINDING 17: a link cannot be paired with a vault it does not name ───────

  describe("FINDING 17: LinkVaultMismatch guards both instructions", () => {
    it("unlink_wallet refuses a second owner unlinking another vault's link, and the link survives", async () => {
      const a = await makeLinked({ walletLamports: LAMPORTS_PER_SOL });
      const b = await makeVault();

      // b.owner presents their own vault (b.vault) but a.wallet's link (which
      // belongs to a.vault). trading_link.vault (a.vault) != vault.key (b.vault).
      await expectRefusal(
        program.methods
          .unlinkWallet()
          .accountsPartial({
            authority: b.owner.publicKey,
            owner: b.owner.publicKey,
            vault: b.vault,
            tradingLink: a.link,
          })
          .signers([b.owner])
          .rpc(),
        LINK_VAULT_MISMATCH,
        "unlink_wallet with a foreign link",
      );

      const link = await program.account.tradingLink.fetch(a.link);
      assert.isTrue(link.vault.equals(a.vault), "the link still names the vault it was created for");
      assert.isNotNull(await connection.getAccountInfo(a.link), "and the link account was not closed");
    });

    it("settle_v2 refuses a linked wallet settled against a different vault, and moves no lamports", async () => {
      const a = await makeLinked({ walletLamports: LAMPORTS_PER_SOL });
      const b = await makeVault();

      // A correctly-signed attestation naming the OTHER vault (b.vault): even so,
      // the account constraint refuses the pairing before the handler runs.
      const bVault = await program.account.vault.fetch(b.vault);
      const aLink = await program.account.tradingLink.fetch(a.link);
      const end = await slotAbove(Number(aLink.frontierSlot.toString()) + 1);
      const attestation: AttestationInputs = {
        programId: program.programId,
        wallet: a.wallet.publicKey,
        vault: b.vault,
        linkEpoch: BigInt(aLink.epoch.toString()),
        settlementNonce: BigInt(aLink.settlementNonce.toString()),
        sessionStartSlot: BigInt(Number(aLink.frontierSlot.toString())),
        sessionEndSlot: BigInt(end),
        baseLamports: BigInt(0),
        mode: bVault.skimMode,
        bps: bVault.skimMode === 1 ? bVault.volumeBps : bVault.skimBps,
        policyNonce: BigInt(bVault.policyNonce.toString()),
        validUntilSlot: BigInt(end + 10_000),
      };

      const walletBefore = await connection.getBalance(a.wallet.publicKey);
      const vaultBefore = await connection.getBalance(b.vault);

      await expectRefusal(
        settleCall({
          wallet: a.wallet,
          vault: b.vault,
          link: a.link,
          mode: attestation.mode,
          start: attestation.sessionStartSlot,
          end: attestation.sessionEndSlot,
          base: attestation.baseLamports,
          validUntil: attestation.validUntilSlot,
          pre: [attestationInstruction(TEST_ATTESTER.secretKey, attestation)],
        }),
        LINK_VAULT_MISMATCH,
        "settle against a vault the link does not name",
      );

      assert.strictEqual(await connection.getBalance(a.wallet.publicKey), walletBefore, "no lamports left the wallet");
      assert.strictEqual(await connection.getBalance(b.vault), vaultBefore, "and none reached the other vault");
      const link = await program.account.tradingLink.fetch(a.link);
      assert.isTrue(link.vault.equals(a.vault), "the link still names its own vault");
    });
  });

  // ── FINDING 18: the reserve floor, the window, and the deadline boundary ────

  describe("FINDING 18: settle_v2 wallet-reserve and window boundaries", () => {
    // owed = base * SKIM_BPS / 10000; with SKIM_BPS = 2500, base = 4 * P owes P.
    const P = 20_000_000; // the contribution one settlement moves
    const BASE = 80_000_000; // 4 * P

    it("passes when the wallet is left at exactly rent-exempt(0) + reserve", async () => {
      const reserve = 50_000_000;
      const l = await makeLinked({
        walletReserve: reserve,
        maxContribution: LAMPORTS_PER_SOL,
        walletLamports: P + rent0 + reserve, // balance - paid == floor, exactly
      });
      const inputs = await attInputsFor(l, { baseLamports: BigInt(BASE) });
      const vaultBefore = await connection.getBalance(l.vault);

      await genuineSettle(l, inputs);

      assert.strictEqual(
        await connection.getBalance(l.wallet.publicKey),
        rent0 + reserve,
        "the wallet is left at exactly its floor: rent-exempt(0) + reserve",
      );
      assert.strictEqual(
        (await connection.getBalance(l.vault)) - vaultBefore,
        P,
        "the vault received exactly the contribution",
      );
    });

    it("refuses one lamport past the boundary with WalletBelowReserve, and moves nothing", async () => {
      const reserve = 50_000_000;
      const l = await makeLinked({
        walletReserve: reserve,
        maxContribution: LAMPORTS_PER_SOL,
        walletLamports: P + rent0 + reserve - 1, // one lamport short of the floor
      });
      const inputs = await attInputsFor(l, { baseLamports: BigInt(BASE) });
      const walletBefore = await connection.getBalance(l.wallet.publicKey);
      const vaultBefore = await connection.getBalance(l.vault);
      const linkBefore = await program.account.tradingLink.fetch(l.link);

      await expectRefusal(genuineSettle(l, inputs), WALLET_BELOW_RESERVE, "one lamport past the reserve floor");

      assert.strictEqual(await connection.getBalance(l.wallet.publicKey), walletBefore, "the wallet is untouched");
      assert.strictEqual(await connection.getBalance(l.vault), vaultBefore, "nothing reached the vault");
      const linkAfter = await program.account.tradingLink.fetch(l.link);
      assert.strictEqual(linkAfter.frontierSlot.toString(), linkBefore.frontierSlot.toString(), "the frontier held");
      assert.strictEqual(linkAfter.settlementNonce.toString(), linkBefore.settlementNonce.toString(), "the nonce held");
    });

    it("with a zero reserve, still refuses a payment that dips below the wallet's own rent floor", async () => {
      const l = await makeLinked({
        walletReserve: 0,
        maxContribution: LAMPORTS_PER_SOL,
        walletLamports: P + rent0 - 1, // balance - paid == rent-exempt(0) - 1
      });
      const inputs = await attInputsFor(l, { baseLamports: BigInt(BASE) });
      const walletBefore = await connection.getBalance(l.wallet.publicKey);
      const vaultBefore = await connection.getBalance(l.vault);

      await expectRefusal(genuineSettle(l, inputs), WALLET_BELOW_RESERVE, "one lamport below the rent floor, reserve 0");

      assert.strictEqual(await connection.getBalance(l.wallet.publicKey), walletBefore, "the wallet is untouched");
      assert.strictEqual(await connection.getBalance(l.vault), vaultBefore, "nothing reached the vault");
    });

    it("refuses a window whose start equals its end (InvalidSessionWindow)", async () => {
      const l = await makeLinked({ walletLamports: LAMPORTS_PER_SOL });
      const inputs = await attInputsFor(l);
      const at = inputs.sessionEndSlot; // a slot at or below now, at or above the frontier

      // The window rule (start >= frontier && end > start) is checked before the
      // Ed25519 introspection, so no attestation instruction is needed to reach
      // it; start == end fails end > start.
      await expectRefusal(
        settleCall({
          wallet: l.wallet,
          vault: l.vault,
          link: l.link,
          mode: inputs.mode,
          start: at,
          end: at,
          base: BigInt(0),
          validUntil: inputs.validUntilSlot,
          pre: [],
        }),
        INVALID_SESSION_WINDOW,
        "a start == end window",
      );
    });

    it("treats valid_until_slot == the current slot as inside the deadline (inclusive)", async () => {
      const l = await makeLinked({ walletLamports: LAMPORTS_PER_SOL });

      // The exclusive side, deterministic: a deadline strictly in the past is
      // AttestationExpired. base 0 so nothing moves; this only exercises the
      // deadline gate (settle.rs:91), which is checked before the window.
      const past = await attInputsFor(l, { baseLamports: BigInt(0), validUntilSlot: BigInt(0) });
      await expectRefusal(
        settleCall({
          wallet: l.wallet,
          vault: l.vault,
          link: l.link,
          mode: past.mode,
          start: past.sessionStartSlot,
          end: past.sessionEndSlot,
          base: BigInt(0),
          validUntil: BigInt(0),
          pre: [attestationInstruction(TEST_ATTESTER.secretKey, past)],
        }),
        ATTESTATION_EXPIRED,
        "a deadline in the past",
      );

      // The inclusive edge, by SIMULATION. A landed transaction cannot pin it on
      // a free-running validator: the newest slot a client can read is the
      // processed one, and a transaction always executes in a later bank, so a
      // valid_until equal to that slot has always passed by the time it runs.
      // (Runner, run 1: all 12 landed attempts passed preflight and were refused
      // on chain at settle.rs:91, and Anchor 0.32.1 rethrew each one as a
      // SendTransactionError with no logs, "Unknown action 'undefined'".)
      // simulateTransaction runs this program against ONE bank and reports that
      // bank's slot as context.slot, which is the slot Clock::get() handed the
      // handler. So at context.slot == valid_until the handler must accept
      // (now <= valid_until), and past it must refuse with AttestationExpired
      // and nothing else. The bank never predates the slot read just before.
      const payer = (provider.wallet as anchor.Wallet).payer;
      const seen: string[] = [];
      let pinned = false;
      for (let attempt = 0; attempt < 20 && !pinned; attempt++) {
        const inputs = await attInputsFor(l, { baseLamports: BigInt(0) });
        const validUntil = await connection.getSlot();
        const tx = await program.methods
          .settleV2(inputs.mode, bn(inputs.sessionStartSlot), bn(inputs.sessionEndSlot), bn(0), bn(validUntil))
          .accountsPartial({ wallet: l.wallet.publicKey, vault: l.vault, tradingLink: l.link })
          .preInstructions([
            attestationInstruction(TEST_ATTESTER.secretKey, { ...inputs, validUntilSlot: BigInt(validUntil) }),
          ])
          .transaction();
        tx.feePayer = provider.wallet.publicKey;
        const { context, value } = await connection.simulateTransaction(tx, [payer, l.wallet]);
        const now = context.slot;
        const logs = value.logs ?? [];
        const where = `simulated at slot ${now} with valid_until ${validUntil}`;
        assert.isAtLeast(now, validUntil, `${where}: the bank predates the slot read before it`);
        if (value.err === null) {
          assert.strictEqual(now, validUntil, `${where}: accepted past its deadline`);
          assert.include(logs, `Program ${program.programId.toBase58()} success`, `${where}: settle_v2 itself succeeded`);
          pinned = true;
        } else {
          const code = anchor.AnchorError.parse(logs)?.error.errorCode.code;
          assert.strictEqual(
            code,
            ATTESTATION_EXPIRED.code,
            `${where}: refused for a non-deadline reason: ${JSON.stringify(value.err)} | ${logs.join(" | ")}`,
          );
          assert.isAbove(now, validUntil, `${where}: AttestationExpired at its own deadline slot, so the deadline is exclusive`);
          seen.push(`${where}: AttestationExpired`);
        }
      }
      assert.isTrue(pinned, `no simulation ran in the slot it named as valid_until in 20 attempts: ${seen.join("; ")}`);
    });
  });
});
