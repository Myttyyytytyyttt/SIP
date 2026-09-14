// Milestone 2: settle — the attested session reaching the vault.
//
// THE TESTS THAT MATTER ARE THE REFUSALS, and here each one guards real money:
// a replayed attestation is the same window settled twice; a forged signer is
// anyone printing themselves savings; a tampered base is the attester's number
// inflated after signing; an overlapping window is one stretch counted again; a
// stale link epoch is a resurrected attestation from a link's previous life.
// Since V2, an attestation made for the other mode, another rate or an older
// policy is the one that nearly charged a volume figure at a profit rate. Every
// one must die, and die for the RIGHT reason — the assertions check the error
// name, not just failure.

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
import { configPdaFor, ensureConfig, setKeeper, TEST_ATTESTER } from "./config-fixture";
import { attestationInstruction, MODE_PROFIT, MODE_VOLUME, type AttestationInputs } from "../scripts/attestation";
import { linkWalletWithConsent } from "../scripts/link-consent";

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

  const SOL = BigInt(LAMPORTS_PER_SOL);
  const SKIM_BPS = 2_500; // a quarter, so expected contributions are legible
  const VOLUME_BPS = 20; // 0.2% of notional

  interface Policy {
    mode: number;
    skimBps: number;
    volumeBps: number;
    paused: boolean;
    maxContribution: bigint;
    walletReserve: bigint;
  }
  // The cap sits well above any single test's contribution, so only the test
  // that is about the cap ever meets it.
  const POLICY: Policy = {
    mode: MODE_PROFIT,
    skimBps: SKIM_BPS,
    volumeBps: VOLUME_BPS,
    paused: false,
    maxContribution: 10n * SOL,
    walletReserve: 0n,
  };
  const bn = (value: bigint) => new anchor.BN(value.toString());

  /** Every write bumps the vault's policy nonce, even one that changes nothing. */
  const setPolicy = (over: Partial<Policy> = {}) => {
    const p = { ...POLICY, ...over };
    return program.methods
      .setPolicyV2(p.mode, p.skimBps, p.volumeBps, p.paused, bn(p.maxContribution), bn(p.walletReserve))
      .accounts({ owner: owner.publicKey })
      .signers([owner])
      .rpc();
  };

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

  /**
   * Builds the attestation for the link's CURRENT nonce and epoch and the
   * vault's CURRENT mode, rate and policy nonce — what an honest keeper signs.
   */
  const freshAttestation = async (over: Partial<AttestationInputs> = {}) => {
    const link = await linkState();
    const vault = await program.account.vault.fetch(vaultPda);
    const end = await slotAbove(BigInt(link.frontierSlot.toString()) + 1n);
    const inputs: AttestationInputs = {
      programId: program.programId,
      wallet: wallet.publicKey,
      vault: vaultPda,
      linkEpoch: BigInt(link.epoch.toString()),
      settlementNonce: BigInt(link.settlementNonce.toString()),
      sessionStartSlot: BigInt(link.frontierSlot.toString()),
      sessionEndSlot: end,
      baseLamports: SOL, // 1 SOL of session profit
      mode: vault.skimMode,
      bps: vault.skimMode === MODE_VOLUME ? vault.volumeBps : vault.skimBps,
      policyNonce: BigInt(vault.policyNonce.toString()),
      validUntilSlot: end + 10_000n,
      ...over,
    };
    return inputs;
  };

  const settleTx = async (
    inputs: AttestationInputs,
    options: {
      signWith?: Keypair;
      argsOverride?: Partial<
        Pick<AttestationInputs, "mode" | "sessionStartSlot" | "sessionEndSlot" | "baseLamports" | "validUntilSlot">
      >;
      skipEd25519?: boolean;
    } = {},
  ) => {
    const args = { ...inputs, ...options.argsOverride };
    const pre: TransactionInstruction[] = options.skipEd25519
      ? []
      : [attestationInstruction((options.signWith ?? attester).secretKey, inputs)];
    return program.methods
      .settleV2(
        args.mode,
        bn(args.sessionStartSlot),
        bn(args.sessionEndSlot),
        bn(args.baseLamports),
        bn(args.validUntilSlot),
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

  /** The `Settled` event a settlement emitted, read back from its logs. */
  const settledEvent = async (signature: string) => {
    const parser = new anchor.EventParser(program.programId, new anchor.BorshCoder(program.idl));
    for (let attempt = 0; attempt < 40; attempt++) {
      const tx = await connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (tx?.meta?.logMessages) {
        for (const event of parser.parseLogs(tx.meta.logMessages)) {
          if (event.name.toLowerCase() === "settled") {
            return event.data as {
              mode: number;
              baseLamports: anchor.BN;
              bps: number;
              owed: anchor.BN;
              paid: anchor.BN;
              settlementNonce: anchor.BN;
              sessionEndSlot: anchor.BN;
              linkEpoch: anchor.BN;
              sessionStartSlot: anchor.BN;
              policyNonce: anchor.BN;
            };
          }
        }
        throw new Error("the settlement emitted no Settled event");
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`settlement ${signature} never became visible`);
  };

  before(async () => {
    await airdrop(owner.publicKey, 2);
    await airdrop(wallet.publicKey, 5);

    // Shared with every other spec — see config-fixture.ts. Created here only
    // if no spec has created it yet.
    await ensureConfig(program, provider.wallet.publicKey);

    await program.methods
      .createVaultV2(POLICY.mode, POLICY.skimBps, POLICY.volumeBps, bn(POLICY.maxContribution), bn(POLICY.walletReserve))
      .accounts({ owner: owner.publicKey })
      .signers([owner])
      .rpc();
    await linkWalletWithConsent(program, { owner: owner.publicKey, wallet }).signers([owner, wallet]).rpc();
  });

  it("settles an attested session: the vault's share arrives, the cursor advances", async () => {
    const inputs = await freshAttestation();
    const vaultBefore = await connection.getBalance(vaultPda);
    const walletBefore = await connection.getBalance(wallet.publicKey);

    await settleTx(inputs);

    const expectedContribution = (inputs.baseLamports * BigInt(SKIM_BPS)) / 10_000n;
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

  it("refuses a base inflated after signing", async () => {
    const inputs = await freshAttestation();
    await expectSettleFailure(
      settleTx(inputs, { argsOverride: { baseLamports: inputs.baseLamports + 1n } }),
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
    await setPolicy({ paused: true });
    const inputs = await freshAttestation();
    await expectSettleFailure(settleTx(inputs), "VaultPaused");
    await program.methods
      .withdraw(new anchor.BN(1_000))
      .accounts({ owner: owner.publicKey })
      .signers([owner])
      .rpc();
    await setPolicy();
  });

  it("refuses while the PROTOCOL is paused, even with the vault running — and withdraw still works", async () => {
    const config = configPdaFor(program.programId);
    const pause = (paused: boolean) =>
      program.methods.setProtocolPaused(paused).accountsPartial({ authority: provider.wallet.publicKey, config }).rpc();
    await pause(true);
    try {
      const inputs = await freshAttestation();
      await expectSettleFailure(settleTx(inputs), "ProtocolPaused");
      await program.methods.withdraw(new anchor.BN(1_000)).accounts({ owner: owner.publicKey }).signers([owner]).rpc();
    } finally {
      await pause(false);
    }
  });

  it("settles a SECOND session — the cursor is a cursor, not a one-shot", async () => {
    const inputs = await freshAttestation();
    assert.strictEqual(inputs.settlementNonce, 1n);
    await settleTx(inputs);
    const link = await linkState();
    assert.strictEqual(link.settlementNonce.toString(), "2");
  });

  // ── V2: the number means what the vault says it means ────────────────────

  it("refuses an attestation for the OTHER mode, by name, when the caller says so", async () => {
    const inputs = await freshAttestation({ mode: MODE_VOLUME, bps: VOLUME_BPS });
    await expectSettleFailure(settleTx(inputs), "SkimModeMismatch");
  });

  it("refuses a volume attestation passed off as profit — the mode is inside the signed bytes", async () => {
    // The caller claims PROFIT, the vault's mode, so the name check passes.
    // The attester signed VOLUME, so the bytes do not.
    const inputs = await freshAttestation({ mode: MODE_VOLUME, bps: VOLUME_BPS });
    await expectSettleFailure(settleTx(inputs, { argsOverride: { mode: MODE_PROFIT } }), "AttestationMismatch");
  });

  it("refuses an attestation signed at another rate", async () => {
    // Right mode, wrong rate: the volume rate applied to a profit figure.
    const inputs = await freshAttestation({ bps: VOLUME_BPS });
    await expectSettleFailure(settleTx(inputs), "AttestationMismatch");
  });

  it("refuses an attestation that crossed a policy change — even one that changed nothing", async () => {
    const inputs = await freshAttestation();
    await setPolicy(); // identical values; the policy nonce moves anyway
    await expectSettleFailure(settleTx(inputs), "AttestationMismatch");
  });

  it("refuses an attestation past its deadline", async () => {
    const inputs = await freshAttestation();
    await expectSettleFailure(settleTx({ ...inputs, validUntilSlot: inputs.sessionEndSlot - 1n }), "AttestationExpired");
  });

  it("clips at the owner's cap, and the event records what was owed and what was paid", async () => {
    const cap = SOL / 10n; // a quarter of 1 SOL owes 0.25; the owner allows 0.1 per settlement
    await setPolicy({ maxContribution: cap });
    try {
      const inputs = await freshAttestation();
      const vaultBefore = BigInt(await connection.getBalance(vaultPda));
      const signature = await settleTx(inputs);

      assert.strictEqual(BigInt(await connection.getBalance(vaultPda)) - vaultBefore, cap, "exactly the cap moved");
      const event = await settledEvent(signature);
      assert.strictEqual(event.owed.toString(), (SOL / 4n).toString(), "owed is the full quarter");
      assert.strictEqual(event.paid.toString(), cap.toString(), "paid is the cap");
      assert.strictEqual(event.settlementNonce.toString(), inputs.settlementNonce.toString());
      assert.strictEqual(event.sessionEndSlot.toString(), inputs.sessionEndSlot.toString());
      // The appended fields: which life of the link was settled (its nonce
      // restarts on relink, its epoch does not), where the window began, and
      // the policy the attestation was signed against.
      assert.strictEqual(event.linkEpoch.toString(), inputs.linkEpoch.toString(), "the link's epoch");
      assert.strictEqual(event.sessionStartSlot.toString(), inputs.sessionStartSlot.toString(), "the window's start");
      assert.strictEqual(event.policyNonce.toString(), inputs.policyNonce.toString(), "the vault's policy nonce");
      assert.strictEqual((await linkState()).frontierSlot.toString(), inputs.sessionEndSlot.toString(), "the window is settled");
    } finally {
      await setPolicy();
    }
  });

  it("settles a zero base: nothing moves and the frontier still advances, so a quiet wallet never wedges", async () => {
    const before = await linkState();
    const inputs = await freshAttestation({ baseLamports: 0n });
    const vaultBefore = await connection.getBalance(vaultPda);

    await settleTx(inputs);

    const after = await linkState();
    assert.strictEqual(await connection.getBalance(vaultPda), vaultBefore, "nothing moved");
    assert.strictEqual(after.settlementNonce.toString(), (BigInt(before.settlementNonce.toString()) + 1n).toString());
    assert.strictEqual(after.frontierSlot.toString(), inputs.sessionEndSlot.toString());
  });

  it("refuses a payment that would dip into the wallet's reserve, and leaves the window open", async () => {
    await setPolicy({ walletReserve: 1_000n * SOL });
    try {
      const before = await linkState();
      await expectSettleFailure(settleTx(await freshAttestation()), "WalletBelowReserve");
      const after = await linkState();
      assert.strictEqual(after.frontierSlot.toString(), before.frontierSlot.toString(), "the frontier did not move");
      assert.strictEqual(after.settlementNonce.toString(), before.settlementNonce.toString(), "nor the nonce");
    } finally {
      await setPolicy();
    }
  });

  it("in VOLUME mode it charges the volume rate on notional, and a profit attestation stops working", async () => {
    await setPolicy({ mode: MODE_VOLUME });
    try {
      const notional = 10n * SOL;
      const profitShaped = await freshAttestation({ mode: MODE_PROFIT, bps: SKIM_BPS, baseLamports: notional });
      await expectSettleFailure(settleTx(profitShaped), "SkimModeMismatch");

      const inputs = await freshAttestation({ baseLamports: notional });
      assert.strictEqual(inputs.mode, MODE_VOLUME);
      assert.strictEqual(inputs.bps, VOLUME_BPS);
      const vaultBefore = BigInt(await connection.getBalance(vaultPda));
      await settleTx(inputs);
      assert.strictEqual(
        BigInt(await connection.getBalance(vaultPda)) - vaultBefore,
        (notional * BigInt(VOLUME_BPS)) / 10_000n,
        "0.2% of 10 SOL, not 25%",
      );
    } finally {
      await setPolicy();
    }
  });

  it("in VOLUME mode at 200 bps, the owner's own 2%, the vault gains notional x 200 / 10000 and the event says 200", async () => {
    // The product's volume rate is the top edge of its range (state.rs), so the
    // edge is settled for real here, not only accepted by set_policy_v2.
    const PRODUCT_VOLUME_BPS = 200;
    await setPolicy({ mode: MODE_VOLUME, volumeBps: PRODUCT_VOLUME_BPS });
    try {
      const notional = 10n * SOL;
      const inputs = await freshAttestation({ baseLamports: notional });
      assert.strictEqual(inputs.mode, MODE_VOLUME);
      assert.strictEqual(inputs.bps, PRODUCT_VOLUME_BPS);
      const expected = (notional * BigInt(PRODUCT_VOLUME_BPS)) / 10_000n;

      const vaultBefore = BigInt(await connection.getBalance(vaultPda));
      const signature = await settleTx(inputs);
      assert.strictEqual(BigInt(await connection.getBalance(vaultPda)) - vaultBefore, expected, "2% of 10 SOL is 0.2 SOL, not 25%");

      const event = await settledEvent(signature);
      assert.strictEqual(event.mode, MODE_VOLUME, "the event names the mode");
      assert.strictEqual(event.bps, PRODUCT_VOLUME_BPS, "and the rate that was charged");
      assert.strictEqual(event.baseLamports.toString(), notional.toString(), "on the attested notional");
      assert.strictEqual(event.owed.toString(), expected.toString());
      assert.strictEqual(event.paid.toString(), expected.toString(), "under the cap, what was owed is what was paid");
    } finally {
      await setPolicy();
    }
  });

  it("a re-created link refuses its previous life's attestations", async () => {
    // Sign a VALID attestation for the current link, but do not send it.
    const resurrected = await freshAttestation();

    // The owner unlinks the wallet and relinks it: same wallet, same vault,
    // nonce back to zero — the exact shape that would replay if epoch did not
    // exist.
    await program.methods
      .unlinkWallet()
      .accountsPartial({
        authority: owner.publicKey,
        owner: owner.publicKey,
        vault: vaultPda,
        tradingLink: linkPda,
      })
      .signers([owner])
      .rpc();
    await linkWalletWithConsent(program, { owner: owner.publicKey, wallet }).signers([owner, wallet]).rpc();

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
  const authority = provider.wallet.publicKey;

  interface FundedVault {
    readonly owner: Keypair;
    readonly vaultPda: PublicKey;
    readonly policyPda: PublicKey;
    readonly vaultWsol: PublicKey;
  }

  /** A fresh owner's vault holding 1 SOL above rent, as a settlement leaves it, and its wSOL account. */
  const fundedVault = async (): Promise<FundedVault> => {
    const o = Keypair.generate();
    await connection.confirmTransaction(await connection.requestAirdrop(o.publicKey, 3 * LAMPORTS_PER_SOL));
    const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from("vault"), o.publicKey.toBuffer()], program.programId);
    const [policyPda] = PublicKey.findProgramAddressSync([Buffer.from("invest"), vaultPda.toBuffer()], program.programId);
    await program.methods
      .createVaultV2(MODE_PROFIT, 2_000, 20, new anchor.BN(LAMPORTS_PER_SOL), new anchor.BN(0))
      .accounts({ owner: o.publicKey })
      .signers([o])
      .rpc();
    const fund = new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: vaultPda, lamports: LAMPORTS_PER_SOL }));
    await provider.sendAndConfirm(fund);
    const vaultWsol = await createAssociatedTokenAccountIdempotent(connection, payer, NATIVE_MINT, vaultPda, undefined, TP, undefined, true);
    return { owner: o, vaultPda, policyPda, vaultWsol };
  };

  /**
   * The owner's investment policy. wrap_sol reads only `enabled` and the
   * conversion floor; the venue and mints are placeholders it never touches.
   */
  const setInvestPolicy = (v: FundedVault, over: { enabled?: boolean; minConvertRateWad?: bigint } = {}) =>
    program.methods
      .setInvestPolicy(
        [{ mint: Keypair.generate().publicKey, weightBps: 10_000, minOutRateWad: new anchor.BN(1) }],
        Keypair.generate().publicKey,
        Keypair.generate().publicKey,
        new anchor.BN((over.minConvertRateWad ?? 30_000_000_000_000_000n).toString()),
        new anchor.BN(1),
        new anchor.BN(1),
        new anchor.BN(1),
        over.enabled ?? true,
      )
      .accountsPartial({ owner: v.owner.publicKey, vault: v.vaultPda, policy: v.policyPda })
      .signers([v.owner])
      .rpc();

  const wrap = (v: FundedVault, crank: Keypair) =>
    program.methods
      .wrapSol(new anchor.BN((LAMPORTS_PER_SOL / 2).toString()))
      .accountsPartial({
        crank: crank.publicKey,
        vault: v.vaultPda,
        policy: v.policyPda,
        vaultWsol: v.vaultWsol,
        tokenProgram: TP,
        systemProgram: SystemProgram.programId,
      })
      .signers([crank])
      .rpc();

  /** The error code a call was refused with, or "IT SUCCEEDED". */
  const refusal = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
    } catch (error) {
      return String((error as { error?: { errorCode?: { code?: string } } })?.error?.errorCode?.code ?? error);
    }
    return "IT SUCCEEDED";
  };

  const wsolOf = async (v: FundedVault) => BigInt((await connection.getTokenAccountBalance(v.vaultWsol)).value.amount);

  const fundedCrank = async () => {
    const crank = Keypair.generate();
    await connection.confirmTransaction(await connection.requestAirdrop(crank.publicKey, LAMPORTS_PER_SOL));
    return crank;
  };

  it("wraps vault SOL into the vault's own wSOL account, floor untouched", async () => {
    const v = await fundedVault();
    // A vault is wrapped only once its owner has opted into converting.
    await setInvestPolicy(v);
    const crank = await fundedCrank();

    // A STRANGER MAY NOT WRAP SOMEONE ELSE'S SOL. This assertion is the whole
    // reason `config.keeper` exists: wrap_sol and convert took a bare Signer,
    // so any funded account could turn a vault's SOL into wSOL and then sell it
    // through a pool of its own choosing. `crank` here is exactly that
    // stranger — a fresh keypair, airdropped, related to nothing.
    assert.include(await refusal(wrap(v, crank)), "UnauthorizedCrank", "an unrelated signer must not be able to wrap this vault's SOL");
    assert.strictEqual(await wsolOf(v), 0n, "and nothing moved");

    // Named as the keeper, the SAME account is allowed — proving the refusal
    // is about authority and not about some unrelated breakage.
    await setKeeper(program, authority, crank.publicKey);

    await wrap(v, crank);
    assert.strictEqual(await wsolOf(v), BigInt(LAMPORTS_PER_SOL / 2), "half a SOL is now wSOL in the vault's account");

    // And the panic switch: unsetting the keeper closes the door again rather
    // than reopening it to everyone, which is what `Pubkey::default()` meaning
    // "nobody" buys.
    await setKeeper(program, authority, PublicKey.default);
    assert.include(await refusal(wrap(v, crank)), "UnauthorizedCrank", "clearing the keeper must fail closed, not open");
  });

  // THE OWNER'S OWN BRAKES, held against the one crank an owner cannot turn
  // away any other way: the keeper the config names. wrap_sol once ignored all
  // of them, so a keeper could wrap a paused vault, or one that never opted
  // into investing, and front-run its owner's withdraw.
  describe("refuses even the named keeper", () => {
    let crank: Keypair;

    before(async () => {
      crank = await fundedCrank();
      await setKeeper(program, authority, crank.publicKey);
    });

    after(async () => {
      await setKeeper(program, authority, PublicKey.default);
    });

    it("for a vault with no investment policy, which never opted into converting", async () => {
      const v = await fundedVault();
      assert.include(await refusal(wrap(v, crank)), "AccountNotInitialized");
      assert.strictEqual(await wsolOf(v), 0n, "nothing was wrapped");
    });

    it("while the owner's policy is disabled, or names no conversion floor", async () => {
      const v = await fundedVault();
      await setInvestPolicy(v, { enabled: false });
      assert.include(await refusal(wrap(v, crank)), "InvestingDisabled");
      await setInvestPolicy(v, { minConvertRateWad: 0n });
      assert.include(await refusal(wrap(v, crank)), "FloorTooLow");
      assert.strictEqual(await wsolOf(v), 0n, "nothing was wrapped");
    });

    it("for a vault its owner paused, and wraps once the owner resumes it", async () => {
      const v = await fundedVault();
      await setInvestPolicy(v);
      const setPaused = (paused: boolean) =>
        program.methods
          .setPolicyV2(MODE_PROFIT, 2_000, 20, paused, new anchor.BN(LAMPORTS_PER_SOL), new anchor.BN(0))
          .accounts({ owner: v.owner.publicKey })
          .signers([v.owner])
          .rpc();

      await setPaused(true);
      assert.include(await refusal(wrap(v, crank)), "VaultPaused", "the owner's pause is the brake against this very keeper");
      assert.strictEqual(await wsolOf(v), 0n, "the owner's SOL is still SOL, withdrawable in full");

      await setPaused(false);
      await wrap(v, crank);
      assert.strictEqual(await wsolOf(v), BigInt(LAMPORTS_PER_SOL / 2), "an enabled policy on a running vault wraps");
    });
  });
});
