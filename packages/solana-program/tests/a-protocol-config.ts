// The protocol config: who may create it, how its authority moves, and what the
// global pause stops and does not stop.
//
// THIS FILE IS NAMED TO RUN FIRST. The init gate can only be tested while the
// config does not exist, and every other spec creates it in its `before` hook.
// Anchor.toml runs mocha with --sort, and the first test refuses to proceed if
// the config is already there, so a reordering fails loudly instead of silently
// testing nothing.

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { assert } from "chai";
import { SipVault } from "../target/types/sip_vault";
import { configPdaFor, ensureConfig, programDataFor } from "./config-fixture";

describe("sip-vault: protocol config", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.sipVault as Program<SipVault>;
  const connection = provider.connection;
  const authority = provider.wallet.publicKey;
  const configPda = configPdaFor(program.programId);
  const programData = programDataFor(program.programId);
  const stranger = Keypair.generate();
  const successor = Keypair.generate();

  const expectFailure = async (p: Promise<unknown>, needle: string) => {
    try {
      await p;
    } catch (err) {
      assert.include(String(err), needle, `expected failure mentioning "${needle}"`);
      return;
    }
    assert.fail(`expected failure mentioning "${needle}", but it succeeded`);
  };

  const fund = async (to: PublicKey, sol: number) => {
    const signature = await connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
    const latest = await connection.getLatestBlockhash();
    await connection.confirmTransaction({ signature, ...latest }, "confirmed");
  };

  before(async () => {
    await fund(stranger.publicKey, 2);
    await fund(successor.publicKey, 2);
  });

  it("refuses init_config from anyone but the program's upgrade authority", async () => {
    const existing = await program.account.protocolConfig.fetchNullable(configPda);
    assert.isNull(existing, "another spec created the config first: this test would prove nothing");
    await expectFailure(
      program.methods
        .initConfig(Keypair.generate().publicKey)
        .accountsPartial({ authority: stranger.publicKey, programData })
        .signers([stranger])
        .rpc(),
      "NotUpgradeAuthority",
    );
  });

  it("the upgrade authority creates it: no transfer pending, not paused, version 2", async () => {
    await ensureConfig(program, authority);
    const config = await program.account.protocolConfig.fetch(configPda);
    assert.isTrue(config.authority.equals(authority));
    assert.isTrue(config.pendingAuthority.equals(PublicKey.default));
    assert.isFalse(config.paused);
    assert.equal(config.version, 2);
  });

  it("a stranger cannot propose a new authority", async () => {
    await expectFailure(
      program.methods
        .transferAuthority(stranger.publicKey)
        .accountsPartial({ authority: stranger.publicKey, config: configPda })
        .signers([stranger])
        .rpc(),
      "ConstraintHasOne",
    );
  });

  it("refuses to propose the default key", async () => {
    await expectFailure(
      program.methods.transferAuthority(PublicKey.default).accountsPartial({ authority, config: configPda }).rpc(),
      "InvalidAuthority",
    );
  });

  it("proposing changes nothing until the proposed key signs; only that key can accept", async () => {
    await program.methods.transferAuthority(successor.publicKey).accountsPartial({ authority, config: configPda }).rpc();
    let config = await program.account.protocolConfig.fetch(configPda);
    assert.isTrue(config.authority.equals(authority), "a proposal must not move the authority");
    assert.isTrue(config.pendingAuthority.equals(successor.publicKey));

    await expectFailure(
      program.methods
        .acceptAuthority()
        .accountsPartial({ pendingAuthority: stranger.publicKey, config: configPda })
        .signers([stranger])
        .rpc(),
      "NotPendingAuthority",
    );

    await program.methods
      .acceptAuthority()
      .accountsPartial({ pendingAuthority: successor.publicKey, config: configPda })
      .signers([successor])
      .rpc();
    config = await program.account.protocolConfig.fetch(configPda);
    assert.isTrue(config.authority.equals(successor.publicKey));
    assert.isTrue(config.pendingAuthority.equals(PublicKey.default), "an accepted proposal is cleared");

    // Handed back, so every other spec still finds the provider wallet in charge.
    await program.methods
      .transferAuthority(authority)
      .accountsPartial({ authority: successor.publicKey, config: configPda })
      .signers([successor])
      .rpc();
    await program.methods.acceptAuthority().accountsPartial({ pendingAuthority: authority, config: configPda }).rpc();
    config = await program.account.protocolConfig.fetch(configPda);
    assert.isTrue(config.authority.equals(authority));
  });

  it("only the authority pauses the protocol, and withdraw keeps working while it is paused", async () => {
    await expectFailure(
      program.methods
        .setProtocolPaused(true)
        .accountsPartial({ authority: stranger.publicKey, config: configPda })
        .signers([stranger])
        .rpc(),
      "ConstraintHasOne",
    );

    // A vault of its own, so this spec leaves the provider's vault to sip-vault.ts.
    const owner = successor;
    const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), owner.publicKey.toBuffer()], program.programId);
    await program.methods.createVaultV2(0, 2000, 20, new anchor.BN(1_000_000_000), new anchor.BN(0)).accounts({ owner: owner.publicKey }).signers([owner]).rpc();
    await provider.sendAndConfirm(
      new Transaction().add(SystemProgram.transfer({ fromPubkey: authority, toPubkey: vault, lamports: 100_000_000 })),
    );

    await program.methods.setProtocolPaused(true).accountsPartial({ authority, config: configPda }).rpc();
    assert.isTrue((await program.account.protocolConfig.fetch(configPda)).paused);

    const before = await connection.getBalance(vault);
    await program.methods.withdraw(new anchor.BN(1_000)).accounts({ owner: owner.publicKey }).signers([owner]).rpc();
    assert.equal(await connection.getBalance(vault), before - 1_000, "withdraw must work while the protocol is paused");

    await program.methods.setProtocolPaused(false).accountsPartial({ authority, config: configPda }).rpc();
    assert.isFalse((await program.account.protocolConfig.fetch(configPda)).paused);
  });
});
