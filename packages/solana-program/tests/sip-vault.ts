// Milestone 1: the vault lifecycle, exercised against a real local validator.
//
// THE TESTS THAT MATTER ARE THE REFUSALS. Anyone can write the happy path; the
// design's promises live in what is refused: a second vault for the same owner,
// a link the wallet did not sign, a withdraw by a stranger, a rate outside its
// mode's range, and a withdraw that would sink the account below rent exemption.

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { assert } from "chai";
import { SipVault } from "../target/types/sip_vault";
import { MODE_PROFIT, MODE_VOLUME } from "../scripts/attestation";

describe("sip-vault M1", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.sipVault as Program<SipVault>;
  const connection = provider.connection;

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
    { label: "a profit rate of 100 bps, inside the volume range", mode: MODE_PROFIT, skimBps: 100, volumeBps: 20, cap: CAP, error: "InvalidSkimBps" },
    { label: "a profit rate above 100%", mode: MODE_PROFIT, skimBps: 10_001, volumeBps: 20, cap: CAP, error: "InvalidSkimBps" },
    { label: "a volume rate of zero", mode: MODE_VOLUME, skimBps: 2_000, volumeBps: 0, cap: CAP, error: "InvalidVolumeBps" },
    { label: "a volume rate of 101 bps, inside the profit range", mode: MODE_VOLUME, skimBps: 2_000, volumeBps: 101, cap: CAP, error: "InvalidVolumeBps" },
    { label: "an out-of-range volume rate on a profit vault", mode: MODE_PROFIT, skimBps: 2_000, volumeBps: 500, cap: CAP, error: "InvalidVolumeBps" },
    { label: "a mode that does not exist", mode: 2, skimBps: 2_000, volumeBps: 20, cap: CAP, error: "InvalidMode" },
    { label: "a cap of zero, which would forgive every settlement", mode: MODE_PROFIT, skimBps: 2_000, volumeBps: 20, cap: new anchor.BN(0), error: "InvalidContributionCap" },
  ];

  const expectFailure = async (p: Promise<unknown>, needle: string, what = "") => {
    try {
      await p;
    } catch (err) {
      assert.include(String(err), needle, `expected failure mentioning "${needle}" ${what}`);
      return;
    }
    assert.fail(`expected a failure mentioning "${needle}", but it succeeded ${what}`);
  };

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

  it("links a trading wallet with BOTH signatures in one transaction", async () => {
    await program.methods
      .linkWallet()
      .accounts({ owner, wallet: tradingWallet.publicKey })
      .signers([tradingWallet])
      .rpc();

    const link = await program.account.tradingLink.fetch(linkPda);
    assert.strictEqual(link.wallet.toBase58(), tradingWallet.publicKey.toBase58());
    assert.strictEqual(link.vault.toBase58(), vaultPda.toBase58());
    assert.strictEqual(link.settlementNonce.toNumber(), 0);
    assert.isAbove(link.epoch.toNumber(), 0, "epoch records the creation slot");
  });

  it("refuses to link a wallet that did not sign", async () => {
    const victim = Keypair.generate();
    await expectFailure(
      program.methods
        .linkWallet()
        .accounts({ owner, wallet: victim.publicKey })
        // note: no .signers([victim])
        .rpc(),
      "Signature verification failed",
    );
  });

  it("refuses a second link for the same wallet — one wallet, one vault, by derivation", async () => {
    await expectFailure(
      program.methods
        .linkWallet()
        .accounts({ owner, wallet: tradingWallet.publicKey })
        .signers([tradingWallet])
        .rpc(),
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

  it("the wallet can unlink itself without the owner, and relink elsewhere", async () => {
    // Fund the trading wallet so it can pay its own unlink fee.
    const sig = await connection.requestAirdrop(tradingWallet.publicKey, LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig);

    const epochBefore = (await program.account.tradingLink.fetch(linkPda)).epoch.toNumber();

    // A stranger with a valid signature is still refused: signing is not
    // authority.
    const stranger = Keypair.generate();
    const strangerSig = await connection.requestAirdrop(stranger.publicKey, LAMPORTS_PER_SOL);
    await connection.confirmTransaction(strangerSig);
    await expectFailure(
      program.methods
        .unlinkWallet()
        .accountsPartial({
          authority: stranger.publicKey,
          owner,
          vault: vaultPda,
          tradingLink: linkPda,
        })
        .signers([stranger])
        .rpc(),
      "UnlinkUnauthorized",
    );

    await program.methods
      .unlinkWallet()
      .accountsPartial({
        authority: tradingWallet.publicKey,
        owner,
        vault: vaultPda,
        tradingLink: linkPda,
      })
      .signers([tradingWallet])
      .rpc();

    const closed = await connection.getAccountInfo(linkPda);
    assert.isNull(closed, "the link account is closed, freeing the address");

    // Relinking works and gets a NEW epoch — the attestation-replay guard.
    await program.methods
      .linkWallet()
      .accounts({ owner, wallet: tradingWallet.publicKey })
      .signers([tradingWallet])
      .rpc();
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
});
