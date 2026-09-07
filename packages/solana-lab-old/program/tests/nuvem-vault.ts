// Milestone 1: the vault lifecycle, exercised against a real local validator.
//
// THE TESTS THAT MATTER ARE THE REFUSALS. Anyone can write the happy path; the
// design's promises live in what is refused: a second vault for the same owner,
// a link the wallet did not sign, a withdraw by a stranger, a skim of zero, and
// a withdraw that would sink the account below rent exemption.

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
import { NuvemVault } from "../target/types/nuvem_vault";

describe("nuvem-vault M1", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.nuvemVault as Program<NuvemVault>;
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

  const expectFailure = async (p: Promise<unknown>, needle: string) => {
    try {
      await p;
    } catch (err) {
      assert.include(String(err), needle, `expected failure mentioning "${needle}"`);
      return;
    }
    assert.fail(`expected a failure mentioning "${needle}", but it succeeded`);
  };

  it("refuses a skim of zero — the reachable trap dies at the door", async () => {
    await expectFailure(
      program.methods.createVault(0).accounts({ owner }).rpc(),
      "InvalidSkimBps",
    );
  });

  it("creates the vault, and the address is a pure function of the owner", async () => {
    await program.methods.createVault(2_000).accounts({ owner }).rpc();

    const vault = await program.account.vault.fetch(vaultPda);
    assert.strictEqual(vault.owner.toBase58(), owner.toBase58());
    assert.strictEqual(vault.skimBps, 2_000);
    assert.strictEqual(vault.version, 1);
    assert.strictEqual(vault.paused, false);
    assert.strictEqual(vault.lifetimeSaved.toNumber(), 0);
  });

  it("refuses a second vault for the same owner", async () => {
    // `init` on an existing account: the SystemProgram create fails.
    await expectFailure(
      program.methods.createVault(1_000).accounts({ owner }).rpc(),
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
    await program.methods.setPolicy(2_000, true).accounts({ owner }).rpc();
    await program.methods.withdraw(new anchor.BN(1_000)).accounts({ owner }).rpc();
    // restore
    await program.methods.setPolicy(2_000, false).accounts({ owner }).rpc();
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

  it("set_policy refuses the zero-skim trap for existing vaults too", async () => {
    await expectFailure(
      program.methods.setPolicy(0, false).accounts({ owner }).rpc(),
      "InvalidSkimBps",
    );
  });
});
