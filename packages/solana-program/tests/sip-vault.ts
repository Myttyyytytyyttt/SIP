// Milestone 1: the vault lifecycle, exercised against a real local validator.
//
// THE TESTS THAT MATTER ARE THE REFUSALS. Anyone can write the happy path; the
// design's promises live in what is refused: a second vault for the same owner,
// a link the wallet did not sign, a withdraw by a stranger, a rate outside its
// mode's range, and a withdraw that would sink the account below rent exemption.
// And, since a Privy seat shares every trading wallet's key: an unlink by anyone
// but the owner, and a link without the wallet's own off-chain consent.

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Ed25519Program,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { assert } from "chai";
import { SipVault } from "../target/types/sip_vault";
import { MODE_PROFIT, MODE_VOLUME } from "../scripts/attestation";
import {
  linkConsentInstruction,
  linkConsentMessage,
  linkWalletWithConsent,
  type LinkConsentInputs,
} from "../scripts/link-consent";
import { configPdaFor, ensureConfig, pollingConfirm } from "./config-fixture";

describe("sip-vault M1", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.sipVault as Program<SipVault>;
  const connection = pollingConfirm(provider.connection);

  // The provider wallet is the vault owner throughout.
  const owner = provider.wallet.publicKey;
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), owner.toBuffer()],
    program.programId,
  );

  const tradingWallet = Keypair.generate();
  const [linkPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("link"), tradingWallet.publicKey.toBuffer()],
    program.programId,
  );

  const CAP = new anchor.BN(LAMPORTS_PER_SOL);
  const NO_RESERVE = new anchor.BN(0);

  // Every way a policy can be out of range, and the error that must name it.
  // The same table runs at creation and on every change, so an existing vault
  // cannot be steered anywhere a new one could not start.
  const BAD_POLICIES = [
    { label: "a profit rate of zero, the reachable trap", mode: MODE_PROFIT, skimBps: 0, volumeBps: 20, cap: CAP, error: "InvalidSkimBps" },
    { label: "a profit rate of 200 bps, inside the volume range", mode: MODE_PROFIT, skimBps: 200, volumeBps: 20, cap: CAP, error: "InvalidSkimBps" },
    { label: "a profit rate above 100%", mode: MODE_PROFIT, skimBps: 10_001, volumeBps: 20, cap: CAP, error: "InvalidSkimBps" },
    { label: "a volume rate of zero", mode: MODE_VOLUME, skimBps: 2_000, volumeBps: 0, cap: CAP, error: "InvalidVolumeBps" },
    { label: "a volume rate of 201 bps, inside the profit range", mode: MODE_VOLUME, skimBps: 2_000, volumeBps: 201, cap: CAP, error: "InvalidVolumeBps" },
    { label: "an out-of-range volume rate on a profit vault", mode: MODE_PROFIT, skimBps: 2_000, volumeBps: 500, cap: CAP, error: "InvalidVolumeBps" },
    { label: "a mode that does not exist", mode: 2, skimBps: 2_000, volumeBps: 20, cap: CAP, error: "InvalidMode" },
    { label: "a cap of zero, which would forgive every settlement", mode: MODE_PROFIT, skimBps: 2_000, volumeBps: 20, cap: new anchor.BN(0), error: "InvalidContributionCap" },
  ];

  // And the edges themselves, which must stay open. The two ranges meet between
  // 200 and 201, and 200 bps (2%) is the owner's own volume rate, so a bound
  // one short would refuse the product itself. Each pair is written in both
  // modes: the bounds hold whichever rate the vault applies.
  const EDGE_POLICIES = [
    { label: "volume 200, the product's 2%, beside profit 201", skimBps: 201, volumeBps: 200 },
    { label: "volume 1 beside profit 10000", skimBps: 10_000, volumeBps: 1 },
  ].flatMap((edge) =>
    [MODE_PROFIT, MODE_VOLUME].map((mode) => ({ ...edge, mode, label: `${edge.label}, mode ${mode}` })),
  );

  const expectPolicy = (
    vault: { skimMode: number; skimBps: number; volumeBps: number },
    edge: (typeof EDGE_POLICIES)[number],
  ) => {
    assert.strictEqual(vault.skimMode, edge.mode, `mode (${edge.label})`);
    assert.strictEqual(vault.skimBps, edge.skimBps, `profit rate (${edge.label})`);
    assert.strictEqual(vault.volumeBps, edge.volumeBps, `volume rate (${edge.label})`);
  };

  const expectFailure = async (p: Promise<unknown>, needle: string, what = "") => {
    try {
      await p;
    } catch (err) {
      assert.include(String(err), needle, `expected failure mentioning "${needle}" ${what}`);
      return;
    }
    assert.fail(`expected a failure mentioning "${needle}", but it succeeded ${what}`);
  };

  // link_wallet reads the protocol's pause switch, so the shared config must
  // exist before anything here links.
  before(async () => {
    await ensureConfig(program, provider.wallet.publicKey);
  });

  it("refuses every out-of-range policy at creation, each for its own reason", async () => {
    for (const bad of BAD_POLICIES) {
      await expectFailure(
        program.methods.createVaultV2(bad.mode, bad.skimBps, bad.volumeBps, bad.cap, NO_RESERVE).accounts({ owner }).rpc(),
        bad.error,
        `(${bad.label})`,
      );
    }
    assert.isNull(await connection.getAccountInfo(vaultPda), "and no vault was created");
  });

  it("accepts the edges of both ranges at creation: volume 200 beside profit 201, volume 1 beside profit 10000", async () => {
    for (const edge of EDGE_POLICIES) {
      // A fresh owner per edge, since one owner has one vault.
      const edgeOwner = Keypair.generate();
      await connection.confirmTransaction(await connection.requestAirdrop(edgeOwner.publicKey, LAMPORTS_PER_SOL));
      await program.methods
        .createVaultV2(edge.mode, edge.skimBps, edge.volumeBps, CAP, NO_RESERVE)
        .accounts({ owner: edgeOwner.publicKey })
        .signers([edgeOwner])
        .rpc();
      const [edgeVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), edgeOwner.publicKey.toBuffer()],
        program.programId,
      );
      expectPolicy(await program.account.vault.fetch(edgeVault), edge);
    }
  });

  it("creates the vault, and the address is a pure function of the owner", async () => {
    await program.methods.createVaultV2(MODE_PROFIT, 2_000, 20, CAP, NO_RESERVE).accounts({ owner }).rpc();

    const vault = await program.account.vault.fetch(vaultPda);
    assert.strictEqual(vault.owner.toBase58(), owner.toBase58());
    assert.strictEqual(vault.skimMode, MODE_PROFIT);
    assert.strictEqual(vault.skimBps, 2_000);
    assert.strictEqual(vault.volumeBps, 20);
    assert.strictEqual(vault.policyNonce.toNumber(), 0);
    assert.strictEqual(vault.maxContribution.toString(), CAP.toString());
    assert.strictEqual(vault.walletReserve.toNumber(), 0);
    assert.strictEqual(vault.version, 1);
    assert.strictEqual(vault.paused, false);
    assert.strictEqual(vault.lifetimeSaved.toNumber(), 0);
    // The new fields were carved out of the reserved bytes: the account did not grow.
    assert.strictEqual((await connection.getAccountInfo(vaultPda))!.data.length, 125);
  });

  it("refuses a second vault for the same owner", async () => {
    // `init` on an existing account: the SystemProgram create fails.
    await expectFailure(
      program.methods.createVaultV2(MODE_PROFIT, 1_000, 20, CAP, NO_RESERVE).accounts({ owner }).rpc(),
      "already in use",
    );
  });

  it("links a trading wallet with BOTH signatures and the wallet's own consent in one transaction", async () => {
    await linkWalletWithConsent(program, { owner, wallet: tradingWallet }).signers([tradingWallet]).rpc();

    const link = await program.account.tradingLink.fetch(linkPda);
    assert.strictEqual(link.wallet.toBase58(), tradingWallet.publicKey.toBase58());
    assert.strictEqual(link.vault.toBase58(), vaultPda.toBase58());
    assert.strictEqual(link.settlementNonce.toNumber(), 0);
    assert.isAbove(link.epoch.toNumber(), 0, "epoch records the creation slot");
  });

  it("refuses to link a wallet that did not sign", async () => {
    const victim = Keypair.generate();
    await expectFailure(
      linkWalletWithConsent(program, { owner, wallet: victim })
        // note: no .signers([victim])
        .rpc(),
      "Signature verification failed",
    );
  });

  it("refuses a second link for the same wallet — one wallet, one vault, by derivation", async () => {
    await expectFailure(
      linkWalletWithConsent(program, { owner, wallet: tradingWallet }).signers([tradingWallet]).rpc(),
      "already in use",
    );
  });

  it("holds SOL sent to it, and the owner withdraws — nobody else", async () => {
    // Fund the vault the way a settlement would leave it funded: plain lamports
    // on the PDA. (M2's settle does this via CPI; the account state is the same.)
    const deposit = LAMPORTS_PER_SOL; // 1 SOL
    const tx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: owner, toPubkey: vaultPda, lamports: deposit }),
    );
    await provider.sendAndConfirm(tx);

    // A stranger may not withdraw. The instruction derives the vault from the
    // signer's own key, so a stranger's derivation lands on a nonexistent
    // account — the design makes the theft unexpressible rather than forbidden.
    const stranger = Keypair.generate();
    const sig = await connection.requestAirdrop(stranger.publicKey, LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig);
    await expectFailure(
      program.methods
        .withdraw(new anchor.BN(1))
        .accounts({ owner: stranger.publicKey })
        .signers([stranger])
        .rpc(),
      "AccountNotInitialized",
    );

    const before = await connection.getBalance(vaultPda);
    const amount = Math.floor(deposit / 2);
    await program.methods.withdraw(new anchor.BN(amount)).accounts({ owner }).rpc();
    const after = await connection.getBalance(vaultPda);
    assert.strictEqual(before - after, amount);
  });

  it("refuses a withdraw that would sink the vault below rent exemption", async () => {
    const balance = await connection.getBalance(vaultPda);
    await expectFailure(
      program.methods.withdraw(new anchor.BN(balance)).accounts({ owner }).rpc(),
      "InsufficientVaultBalance",
    );
  });

  it("withdraw still works while paused — pause gates settle/invest, never exit", async () => {
    const setPaused = (paused: boolean) =>
      program.methods.setPolicyV2(MODE_PROFIT, 2_000, 20, paused, CAP, NO_RESERVE).accounts({ owner }).rpc();
    await setPaused(true);
    await program.methods.withdraw(new anchor.BN(1_000)).accounts({ owner }).rpc();
    // restore
    await setPaused(false);
  });

  it("moves the policy nonce on every policy write, even one that changes nothing", async () => {
    const nonce = async () => BigInt((await program.account.vault.fetch(vaultPda)).policyNonce.toString());
    const before = await nonce();
    await program.methods.setPolicyV2(MODE_PROFIT, 2_000, 20, false, CAP, NO_RESERVE).accounts({ owner }).rpc();
    assert.strictEqual(await nonce(), before + 1n);
  });

  /** unlink_wallet signed by `authority`, or by the owner (the provider) when null. */
  const unlinkSignedBy = (authority: Keypair | null) =>
    program.methods
      .unlinkWallet()
      .accountsPartial({
        authority: authority?.publicKey ?? owner,
        owner,
        vault: vaultPda,
        tradingLink: linkPda,
      })
      .signers(authority === null ? [] : [authority])
      .rpc();

  it("refuses an unlink signed by anyone but the owner, the wallet itself included, and the link survives", async () => {
    // A stranger with a valid signature is refused: signing is not authority.
    await expectFailure(unlinkSignedBy(Keypair.generate()), "UnlinkUnauthorized");

    // SO IS THE WALLET. It once could unlink itself, but its key is the one a
    // Privy seat signs with, and a seat able to free its wallet could co-sign a
    // link to any vault it liked.
    await expectFailure(unlinkSignedBy(tradingWallet), "UnlinkUnauthorized");

    const link = await program.account.tradingLink.fetch(linkPda);
    assert.strictEqual(link.vault.toBase58(), vaultPda.toBase58(), "the link still names the owner's vault");
  });

  it("the owner unlinks, and a relink with fresh consent gets a new epoch", async () => {
    const epochBefore = (await program.account.tradingLink.fetch(linkPda)).epoch.toNumber();

    await unlinkSignedBy(null);
    const closed = await connection.getAccountInfo(linkPda);
    assert.isNull(closed, "the link account is closed, freeing the address");

    // Relinking works and gets a NEW epoch — the attestation-replay guard.
    await linkWalletWithConsent(program, { owner, wallet: tradingWallet }).signers([tradingWallet]).rpc();
    const relinked = await program.account.tradingLink.fetch(linkPda);
    assert.isAbove(relinked.epoch.toNumber(), epochBefore, "a new life gets a new epoch");
  });

  it("set_policy_v2 refuses the same out-of-range policies on an existing vault, and changes nothing", async () => {
    const before = await program.account.vault.fetch(vaultPda);
    for (const bad of BAD_POLICIES) {
      await expectFailure(
        program.methods.setPolicyV2(bad.mode, bad.skimBps, bad.volumeBps, false, bad.cap, NO_RESERVE).accounts({ owner }).rpc(),
        bad.error,
        `(${bad.label})`,
      );
    }
    const after = await program.account.vault.fetch(vaultPda);
    assert.strictEqual(after.policyNonce.toString(), before.policyNonce.toString(), "a refused write moves no nonce");
    assert.strictEqual(after.skimMode, before.skimMode);
    assert.strictEqual(after.skimBps, before.skimBps);
    assert.strictEqual(after.volumeBps, before.volumeBps);
  });

  it("set_policy_v2 accepts the same edges on an existing vault, and each one lands as written", async () => {
    try {
      for (const edge of EDGE_POLICIES) {
        await program.methods
          .setPolicyV2(edge.mode, edge.skimBps, edge.volumeBps, false, CAP, NO_RESERVE)
          .accounts({ owner })
          .rpc();
        expectPolicy(await program.account.vault.fetch(vaultPda), edge);
      }
    } finally {
      // Back to the policy this vault was created with.
      await program.methods.setPolicyV2(MODE_PROFIT, 2_000, 20, false, CAP, NO_RESERVE).accounts({ owner }).rpc();
    }
  });
});

// link_wallet: consent a Privy seat cannot give.
//
// In production the trading wallet's key is shared with a Privy seat whose
// policy can allow or deny a program, never one of its instructions, so the
// wallet's signature on a transaction says nothing about its user. link_wallet
// reads back an Ed25519 verification of the wallet's SIP_LINK_V1 consent
// instead, which only signMessage in the user's own session produces. Every
// transaction refused below is one the seat could have signed.
describe("sip-vault: link_wallet needs the wallet's own consent", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.sipVault as Program<SipVault>;
  const connection = pollingConfirm(provider.connection);

  // Owners with vaults of their own, so nothing here leans on M1's state.
  const owner = Keypair.generate();
  const stranger = Keypair.generate();

  const vaultOf = (who: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("vault"), who.toBuffer()], program.programId)[0];
  const linkOf = (wallet: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("link"), wallet.toBuffer()], program.programId)[0];
  const consentFor = (wallet: PublicKey, forOwner: PublicKey): LinkConsentInputs => ({
    programId: program.programId,
    wallet,
    vault: vaultOf(forOwner),
    owner: forOwner,
  });

  const expectFailure = async (p: Promise<unknown>, needle: string) => {
    try {
      await p;
    } catch (err) {
      assert.include(String(err), needle, `expected failure mentioning "${needle}"`);
      return;
    }
    assert.fail(`expected a failure mentioning "${needle}", but it succeeded`);
  };

  const createVault = async (who: Keypair) => {
    await connection.confirmTransaction(await connection.requestAirdrop(who.publicKey, 2 * LAMPORTS_PER_SOL));
    await program.methods
      .createVaultV2(MODE_PROFIT, 2_000, 20, new anchor.BN(LAMPORTS_PER_SOL), new anchor.BN(0))
      .accounts({ owner: who.publicKey })
      .signers([who])
      .rpc();
  };

  /**
   * One Ed25519SigVerify instruction verifying the signatures of two
   * single-signature ones. Each web3.js instruction is laid out as count,
   * padding, a 14-byte offsets struct, then key 32 · signature 64 · message.
   */
  const twoSignatures = (first: TransactionInstruction, second: TransactionInstruction): TransactionInstruction => {
    const parts = [first, second].map(({ data }) => ({
      key: data.subarray(16, 48),
      signature: data.subarray(48, 112),
      message: data.subarray(112),
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
    return new TransactionInstruction({
      programId: Ed25519Program.programId,
      keys: [],
      data: Buffer.concat([header, ...bodies]),
    });
  };

  before(async () => {
    await ensureConfig(program, provider.wallet.publicKey);
    await createVault(owner);
    await createVault(stranger);
  });

  it("refuses a link with no consent, or with a genuine one anywhere but immediately before it", async () => {
    const wallet = Keypair.generate();
    await expectFailure(
      linkWalletWithConsent(program, { owner: owner.publicKey, wallet, consent: [] }).signers([owner, wallet]).rpc(),
      "LinkConsentMissing",
    );

    // Only the instruction immediately before link_wallet is read, so a real
    // consent one instruction earlier is no consent at all.
    const genuine = linkConsentInstruction(wallet.secretKey, consentFor(wallet.publicKey, owner.publicKey));
    await expectFailure(
      linkWalletWithConsent(program, {
        owner: owner.publicKey,
        wallet,
        consent: [genuine, ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })],
      })
        .signers([owner, wallet])
        .rpc(),
      "LinkConsentMissing",
    );
    assert.isNull(await connection.getAccountInfo(linkOf(wallet.publicKey)), "no link was created");
  });

  it("refuses a consent signed by any key but the wallet's", async () => {
    const wallet = Keypair.generate();
    // The right bytes, signed by the owner: the wallet itself never agreed.
    const forged = linkConsentInstruction(owner.secretKey, consentFor(wallet.publicKey, owner.publicKey));
    await expectFailure(
      linkWalletWithConsent(program, { owner: owner.publicKey, wallet, consent: [forged] }).signers([owner, wallet]).rpc(),
      "LinkConsentWrongSigner",
    );
    assert.isNull(await connection.getAccountInfo(linkOf(wallet.publicKey)), "no link was created");
  });

  it("refuses a consent the wallet gave for another vault: a seat cannot carry it to a stranger's", async () => {
    const wallet = Keypair.generate();
    // THE ATTACK. The user's session signed consent to link this wallet to the
    // owner's vault. Whoever holds the wallet's seat co-signs a stranger's
    // link_wallet and brings that genuine consent along.
    const genuine = linkConsentInstruction(wallet.secretKey, consentFor(wallet.publicKey, owner.publicKey));
    await expectFailure(
      linkWalletWithConsent(program, { owner: stranger.publicKey, wallet, consent: [genuine] })
        .signers([stranger, wallet])
        .rpc(),
      "LinkConsentMismatch",
    );
    assert.isNull(
      await connection.getAccountInfo(linkOf(wallet.publicKey)),
      "the wallet's link address is still free for the owner it consented to",
    );
  });

  it("refuses consent bytes without the 0xFF lead", async () => {
    const wallet = Keypair.generate();
    // Everything but the lead byte: "SIP_LINK_V1" and the four keys, what a
    // client that dropped the prefix would have the wallet sign.
    const unled = linkConsentMessage(consentFor(wallet.publicKey, owner.publicKey)).subarray(1);
    const consent = Ed25519Program.createInstructionWithPrivateKey({ privateKey: wallet.secretKey, message: unled });
    await expectFailure(
      linkWalletWithConsent(program, { owner: owner.publicKey, wallet, consent: [consent] }).signers([owner, wallet]).rpc(),
      "LinkConsentMismatch",
    );
  });

  it("refuses an Ed25519 instruction with two signatures, even when one is the wallet's consent", async () => {
    const wallet = Keypair.generate();
    const consent = linkConsentInstruction(wallet.secretKey, consentFor(wallet.publicKey, owner.publicKey));
    const unrelated = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: owner.secretKey,
      message: Buffer.from("a second signature, riding along"),
    });
    await expectFailure(
      linkWalletWithConsent(program, { owner: owner.publicKey, wallet, consent: [twoSignatures(consent, unrelated)] })
        .signers([owner, wallet])
        .rpc(),
      "AttestationMalformed",
    );
  });

  it("refuses to link a wallet to a vault it owns itself", async () => {
    // Even with a genuine consent. One key on both sides of a vault is one key
    // a seat shares: it could set that vault's policy and crank its funds.
    const both = Keypair.generate();
    await createVault(both);
    await expectFailure(
      linkWalletWithConsent(program, { owner: both.publicKey, wallet: both }).signers([both]).rpc(),
      "WalletIsOwner",
    );
    assert.isNull(await connection.getAccountInfo(linkOf(both.publicKey)), "no link was created");
  });

  it("refuses to link while the protocol is paused: a pause freezes the link graph", async () => {
    const wallet = Keypair.generate();
    const config = configPdaFor(program.programId);
    const pause = (paused: boolean) =>
      program.methods.setProtocolPaused(paused).accountsPartial({ authority: provider.wallet.publicKey, config }).rpc();
    await pause(true);
    try {
      await expectFailure(
        linkWalletWithConsent(program, { owner: owner.publicKey, wallet }).signers([owner, wallet]).rpc(),
        "ProtocolPaused",
      );
    } finally {
      await pause(false);
    }
    assert.isNull(await connection.getAccountInfo(linkOf(wallet.publicKey)), "no link was created");
  });

  it("links when the consent immediately before names this program, wallet, vault and owner", async () => {
    const wallet = Keypair.generate();
    await linkWalletWithConsent(program, { owner: owner.publicKey, wallet }).signers([owner, wallet]).rpc();
    const link = await program.account.tradingLink.fetch(linkOf(wallet.publicKey));
    assert.isTrue(link.wallet.equals(wallet.publicKey));
    assert.isTrue(link.vault.equals(vaultOf(owner.publicKey)), "the vault the consent named");
  });
});
