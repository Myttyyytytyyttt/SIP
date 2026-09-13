// Milestone 2: settle — the attested session reaching the vault.
//
// THE TESTS THAT MATTER ARE THE REFUSALS, and here each one guards real money:
// a replayed attestation is the same profit settled twice; a forged signer is
// anyone printing themselves savings; a tampered profit is the attester's
// number inflated after signing; an overlapping window is one profitable
// stretch counted again; and a stale link epoch is a resurrected attestation
// from a link's previous life. Every one must die, and die for the RIGHT
// reason — the assertions check the error name, not just failure.

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { assert } from "chai";
import { SipVault } from "../target/types/sip_vault";
import { ensureConfig, TEST_ATTESTER } from "./config-fixture";
import { attestationInstruction, type AttestationInputs } from "../scripts/attestation";

describe("sip-vault M2: settle", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.sipVault as Program<SipVault>;
  const connection = provider.connection;

  // A FRESH owner, so these tests never depend on state the M1 file left.
  const owner = Keypair.generate();
  const wallet = Keypair.generate();
  const attester = TEST_ATTESTER;

  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), owner.publicKey.toBuffer()],
    program.programId,
  );
  const [linkPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("link"), wallet.publicKey.toBuffer()],
    program.programId,
  );

  const SKIM_BPS = 2_500; // a quarter, so expected contributions are legible

  const airdrop = async (to: PublicKey, sol: number) => {
    const sig = await connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig);
  };

  /** Waits until the chain's slot is strictly above `above`. */
  const slotAbove = async (above: bigint): Promise<bigint> => {
    for (;;) {
      const slot = BigInt(await connection.getSlot());
      if (slot > above) return slot;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };

  const linkState = async () => program.account.tradingLink.fetch(linkPda);

  /** Builds the attestation for the link's CURRENT nonce/epoch. */
  const freshAttestation = async (over: Partial<AttestationInputs> = {}) => {
    const link = await linkState();
    const end = await slotAbove(BigInt(link.frontierSlot.toString()) + 1n);
    const inputs: AttestationInputs = {
      programId: program.programId,
      wallet: wallet.publicKey,
      vault: vaultPda,
      linkEpoch: BigInt(link.epoch.toString()),
      settlementNonce: BigInt(link.settlementNonce.toString()),
      sessionStartSlot: BigInt(link.frontierSlot.toString()),
      sessionEndSlot: end,
      profitLamports: BigInt(LAMPORTS_PER_SOL), // 1 SOL of session profit
      ...over,
    };
    return inputs;
  };

  const settleTx = async (
    inputs: AttestationInputs,
    options: {
      signWith?: Keypair;
      argsOverride?: Partial<Pick<AttestationInputs, "sessionStartSlot" | "sessionEndSlot" | "profitLamports">>;
      skipEd25519?: boolean;
    } = {},
  ) => {
    const args = { ...inputs, ...options.argsOverride };
    const pre: TransactionInstruction[] = options.skipEd25519
      ? []
      : [attestationInstruction((options.signWith ?? attester).secretKey, inputs)];
    return program.methods
      .settle(
        new anchor.BN(args.sessionStartSlot.toString()),
        new anchor.BN(args.sessionEndSlot.toString()),
        new anchor.BN(args.profitLamports.toString()),
      )
      .accountsPartial({
        wallet: wallet.publicKey,
        vault: vaultPda,
        tradingLink: linkPda,
      })
      .preInstructions(pre)
      .signers([wallet])
      .rpc();
  };

  const expectSettleFailure = async (p: Promise<unknown>, needle: string) => {
    try {
      await p;
    } catch (err) {
      assert.include(String(err), needle, `expected failure mentioning "${needle}"`);
      return;
    }
    assert.fail(`expected a failure mentioning "${needle}", but it succeeded`);
  };

  before(async () => {
    await airdrop(owner.publicKey, 2);
    await airdrop(wallet.publicKey, 5);

    // Shared with every other spec — see config-fixture.ts. Created here only
    // if no spec has created it yet.
    await ensureConfig(program, provider.wallet.publicKey);

    await program.methods.createVault(SKIM_BPS).accounts({ owner: owner.publicKey }).signers([owner]).rpc();
    await program.methods
      .linkWallet()
      .accounts({ owner: owner.publicKey, wallet: wallet.publicKey })
      .signers([owner, wallet])
      .rpc();
  });

  it("settles an attested session: the vault's share arrives, the cursor advances", async () => {
    const inputs = await freshAttestation();
    const vaultBefore = await connection.getBalance(vaultPda);
    const walletBefore = await connection.getBalance(wallet.publicKey);

    await settleTx(inputs);

    const expectedContribution = (inputs.profitLamports * BigInt(SKIM_BPS)) / 10_000n;
    const vaultAfter = await connection.getBalance(vaultPda);
    assert.strictEqual(BigInt(vaultAfter - vaultBefore), expectedContribution, "vault received exactly the share");
    assert.isBelow(await connection.getBalance(wallet.publicKey), walletBefore, "the wallet paid it");

    const vault = await program.account.vault.fetch(vaultPda);
    assert.strictEqual(vault.lifetimeSaved.toString(), expectedContribution.toString());

    const link = await linkState();
    assert.strictEqual(link.settlementNonce.toString(), "1", "nonce advanced");
    assert.strictEqual(link.frontierSlot.toString(), inputs.sessionEndSlot.toString(), "frontier is the session end");
  });

  it("refuses the SAME attestation again — the replay is one comparison failing", async () => {
    // The link's nonce moved to 1; the old attestation signed nonce 0. The
    // window also now starts below the frontier, but the deeper guarantee is
    // the message mismatch, so pick a window that is still valid and let the
    // nonce alone kill it.
    const link = await linkState();
    const end = await slotAbove(BigInt(link.frontierSlot.toString()) + 1n);
    const stale = await freshAttestation({
      settlementNonce: 0n, // the spent nonce
      sessionStartSlot: BigInt(link.frontierSlot.toString()),
      sessionEndSlot: end,
    });
    await expectSettleFailure(settleTx(stale), "AttestationMismatch");
  });

  it("refuses an attestation signed by anyone but the attester", async () => {
    const impostor = Keypair.generate();
    const inputs = await freshAttestation();
    await expectSettleFailure(settleTx(inputs, { signWith: impostor }), "WrongAttester");
  });

  it("refuses a profit inflated after signing", async () => {
    const inputs = await freshAttestation();
    await expectSettleFailure(
      settleTx(inputs, { argsOverride: { profitLamports: inputs.profitLamports + 1n } }),
      "AttestationMismatch",
    );
  });

  it("refuses to settle with no Ed25519 instruction at all", async () => {
    const inputs = await freshAttestation();
    await expectSettleFailure(settleTx(inputs, { skipEd25519: true }), "AttestationMissing");
  });

  it("refuses a window that dips below the frontier", async () => {
    const link = await linkState();
    const frontier = BigInt(link.frontierSlot.toString());
    assert.isTrue(frontier > 0n, "a session has settled, so the frontier is set");
    const end = await slotAbove(frontier + 1n);
    const overlapping = await freshAttestation({
      sessionStartSlot: frontier - 1n, // reaches back into settled history
      sessionEndSlot: end,
    });
    await expectSettleFailure(settleTx(overlapping), "InvalidSessionWindow");
  });

  it("refuses a session that claims to end in the future", async () => {
    const inputs = await freshAttestation({
      sessionEndSlot: BigInt(await connection.getSlot()) + 5_000n,
    });
    await expectSettleFailure(settleTx(inputs), "InvalidSessionWindow");
  });

  it("refuses while paused — and withdraw still works, which is the whole point of pause's shape", async () => {
    await program.methods.setPolicy(SKIM_BPS, true).accounts({ owner: owner.publicKey }).signers([owner]).rpc();
    const inputs = await freshAttestation();
    await expectSettleFailure(settleTx(inputs), "VaultPaused");
    await program.methods
      .withdraw(new anchor.BN(1_000))
      .accounts({ owner: owner.publicKey })
      .signers([owner])
      .rpc();
    await program.methods.setPolicy(SKIM_BPS, false).accounts({ owner: owner.publicKey }).signers([owner]).rpc();
  });

  it("settles a SECOND session — the cursor is a cursor, not a one-shot", async () => {
    const inputs = await freshAttestation();
    assert.strictEqual(inputs.settlementNonce, 1n);
    await settleTx(inputs);
    const link = await linkState();
    assert.strictEqual(link.settlementNonce.toString(), "2");
  });

  it("a re-created link refuses its previous life's attestations", async () => {
    // Sign a VALID attestation for the current link, but do not send it.
    const resurrected = await freshAttestation();

    // The wallet unlinks itself and relinks: same wallet, same vault, nonce
    // back to zero — the exact shape that would replay if epoch did not exist.
    await program.methods
      .unlinkWallet()
      .accountsPartial({
        authority: wallet.publicKey,
        owner: owner.publicKey,
        vault: vaultPda,
        tradingLink: linkPda,
      })
      .signers([wallet])
      .rpc();
    await program.methods
      .linkWallet()
      .accounts({ owner: owner.publicKey, wallet: wallet.publicKey })
      .signers([owner, wallet])
      .rpc();

    const relinked = await linkState();
    assert.strictEqual(relinked.settlementNonce.toString(), "0", "the counter did restart");
    assert.notStrictEqual(relinked.epoch.toString(), resurrected.linkEpoch.toString(), "but the epoch moved");

    // The resurrected attestation names the old epoch (and a nonce the new
    // link would otherwise accept). One comparison kills it.
    const replayArgs = await freshAttestation({
      linkEpoch: resurrected.linkEpoch,
      settlementNonce: 0n,
    });
    await expectSettleFailure(settleTx(replayArgs), "AttestationMismatch");
  });
  // LAST IN THIS BLOCK ON PURPOSE: it performs a real settlement, which
  // advances the link's nonce, and the specs above assert exact nonces.
  it("rotates the attester: the old key stops working, the new one starts", async () => {
    // THE INSTRUCTION THIS EXERCISES DID NOT EXIST until the original mainnet
    // attester key leaked, at which point the config's attester was permanent
    // and unusable at the same time. A signing identity with no rotation path
    // is a countdown, so this proves the path both directions.
    const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
    const replacement = Keypair.generate();
    const setAttester = (who: Keypair) =>
      program.methods
        .setAttester(who.publicKey)
        .accountsPartial({ authority: provider.wallet.publicKey, config: configPda })
        .rpc();

    await setAttester(replacement);
    assert.isTrue((await program.account.protocolConfig.fetch(configPda)).attester.equals(replacement.publicKey));

    // The key that worked one line ago is now an impostor.
    await expectSettleFailure(settleTx(await freshAttestation(), { signWith: attester }), "WrongAttester");
    // And the new one settles for real.
    await settleTx(await freshAttestation(), { signWith: replacement });

    // A zero attester would leave settle permanently unverifiable, so it is
    // refused — unlike set_keeper, where the default usefully means "nobody".
    let zeroRefused: string | null = null;
    try {
      await program.methods
        .setAttester(PublicKey.default)
        .accountsPartial({ authority: provider.wallet.publicKey, config: configPda })
        .rpc();
    } catch (error) {
      zeroRefused = String((error as { error?: { errorCode?: { code?: string } } })?.error?.errorCode?.code ?? error);
    }
    assert.include(zeroRefused ?? "IT SUCCEEDED", "InvalidPolicy", "a zero attester must be refused");

    // Restored, because config-fixture.ts asserts this exact attester and the
    // specs share one validator.
    await setAttester(attester);
  });

});

// wrap_sol (M6 prerequisite): the vault's settled SOL becomes wSOL, from where
// invest() routes it to USDC and on to a stock. Appended here because this
// suite already has a funded vault.
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotent, NATIVE_MINT, TOKEN_PROGRAM_ID as TP } from "@solana/spl-token";

describe("sip-vault: wrap_sol", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.sipVault as Program<SipVault>;
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  it("wraps vault SOL into the vault's own wSOL account, floor untouched", async () => {
    const o = Keypair.generate();
    await connection.confirmTransaction(await connection.requestAirdrop(o.publicKey, 3 * LAMPORTS_PER_SOL));
    const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from("vault"), o.publicKey.toBuffer()], program.programId);
    const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
    await program.methods.createVault(2_000).accounts({ owner: o.publicKey }).signers([o]).rpc();
    // Fund the vault with 1 SOL as a settlement would.
    const fund = new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: vaultPda, lamports: LAMPORTS_PER_SOL }));
    await provider.sendAndConfirm(fund);

    const vaultWsol = await createAssociatedTokenAccountIdempotent(connection, payer, NATIVE_MINT, vaultPda, undefined, TP, undefined, true);
    const crank = Keypair.generate();
    await connection.confirmTransaction(await connection.requestAirdrop(crank.publicKey, LAMPORTS_PER_SOL));

    const wrap = () =>
      program.methods.wrapSol(new anchor.BN((LAMPORTS_PER_SOL / 2).toString()))
        .accountsPartial({ crank: crank.publicKey, vault: vaultPda, vaultWsol, tokenProgram: TP, systemProgram: SystemProgram.programId })
        .signers([crank]).rpc();

    // A STRANGER MAY NOT WRAP SOMEONE ELSE'S SOL. This assertion is the whole
    // reason `config.keeper` exists: wrap_sol and convert took a bare Signer,
    // so any funded account could turn a vault's SOL into wSOL and then sell it
    // through a pool of its own choosing. `crank` here is exactly that
    // stranger — a fresh keypair, airdropped, related to nothing.
    let refused: string | null = null;
    try {
      await wrap();
    } catch (error) {
      refused = String((error as { error?: { errorCode?: { code?: string } } })?.error?.errorCode?.code ?? error);
    }
    assert.include(refused ?? "IT SUCCEEDED", "UnauthorizedCrank", "an unrelated signer must not be able to wrap this vault's SOL");

    const stillZero = BigInt((await connection.getTokenAccountBalance(vaultWsol)).value.amount);
    assert.strictEqual(stillZero, 0n, "and nothing moved");

    // Named as the keeper, the SAME account is allowed — proving the refusal
    // is about authority and not about some unrelated breakage.
    await program.methods.setKeeper(crank.publicKey)
      .accountsPartial({ authority: provider.wallet.publicKey, config: configPda })
      .rpc();

    await wrap();

    const wsol = BigInt((await connection.getTokenAccountBalance(vaultWsol)).value.amount);
    assert.strictEqual(wsol, BigInt(LAMPORTS_PER_SOL / 2), "half a SOL is now wSOL in the vault's account");

    // And the panic switch: unsetting the keeper closes the door again rather
    // than reopening it to everyone, which is what `Pubkey::default()` meaning
    // "nobody" buys.
    await program.methods.setKeeper(PublicKey.default)
      .accountsPartial({ authority: provider.wallet.publicKey, config: configPda })
      .rpc();
    let refusedAgain: string | null = null;
    try {
      await wrap();
    } catch (error) {
      refusedAgain = String((error as { error?: { errorCode?: { code?: string } } })?.error?.errorCode?.code ?? error);
    }
    assert.include(refusedAgain ?? "IT SUCCEEDED", "UnauthorizedCrank", "clearing the keeper must fail closed, not open");
  });
});
