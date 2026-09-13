// Milestone 3: invest — the vault buying, behind RH's guard surface, through
// an OPAQUE route the program does not understand and MEASURES instead.
//
// The venue pulls the input and pushes the output, exactly like Raydium's
// swap_v2; invest() lends only the vault PDA's signature and trusts nothing —
// it measures both deltas. The venue can be told to underdeliver (FillTooSmall)
// or over-pull (Overspent), which honest mainnet liquidity never can, and both
// guards are proven against real token movement. The target mint is Token-2022
// with 8 decimals, the exact shape of xStocks.

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AccountMeta, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotent,
  createMint,
  mintTo,
} from "@solana/spl-token";
import { assert } from "chai";
import { SipVault } from "../target/types/sip_vault";
import { configPdaFor, ensureConfig, setKeeper } from "./config-fixture";
import { ToyVenue } from "../target/types/toy_venue";

const WAD = 10n ** 18n;

describe("sip-vault M3: invest", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.sipVault as Program<SipVault>;
  const venue = anchor.workspace.toyVenue as Program<ToyVenue>;
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const owner = Keypair.generate();
  const crank = Keypair.generate();
  const stranger = Keypair.generate();
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);

  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), owner.publicKey.toBuffer()],
    program.programId,
  );
  const [policyPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("invest"), vaultPda.toBuffer()],
    program.programId,
  );

  // Three pool variants: 0 honest, 1 skims 100%, 2 over-pulls 50%.
  const HONEST = 0, SKIMMER = 1, OVERPULLER = 2;
  const poolPda = (variant: number) =>
    PublicKey.findProgramAddressSync([Buffer.from("pool"), Buffer.from([variant])], venue.programId)[0];

  let usdc: PublicKey, stock: PublicKey;
  let vaultUsdc: PublicKey, vaultStock: PublicKey;
  const venueUsdc: Record<number, PublicKey> = {};
  const venueStock: Record<number, PublicKey> = {};

  const RATE_WAD = (WAD * 4n) / 100n; // 0.04 stock per USDC unit
  const expectedOut = (amountIn: bigint) => (amountIn * RATE_WAD) / WAD;

  const legs = (over: Partial<{ weightBps: number; minOutRateWad: bigint }> = {}) => [
    {
      mint: stock,
      weightBps: over.weightBps ?? 10_000,
      minOutRateWad: new anchor.BN((over.minOutRateWad ?? (RATE_WAD * 95n) / 100n).toString()),
    },
  ];

  const setPolicy = async (over: Partial<{
    enabled: boolean; minInvestment: bigint; maxPerCall: bigint; maxRolling: bigint;
    legsOverride: ReturnType<typeof legs>;
  }> = {}) =>
    program.methods
      .setInvestPolicy(
        over.legsOverride ?? legs(),
        venue.programId,
        new anchor.BN("30000000000000000"), // convert floor: 0.03 USDC-raw per lamport (unused by toy tests)
        new anchor.BN((over.minInvestment ?? 1_000_000n).toString()),
        new anchor.BN((over.maxPerCall ?? 100_000_000n).toString()),
        new anchor.BN((over.maxRolling ?? 400_000_000n).toString()),
        over.enabled ?? true,
      )
      .accountsPartial({ owner: owner.publicKey, vault: vaultPda, policy: policyPda })
      .signers([owner])
      .rpc();

  // venue_data = [amount_in, min_out] LE; remaining accounts in the venue's order.
  const venueData = (amountIn: bigint, minOut: bigint) => {
    const b = Buffer.alloc(16);
    b.writeBigUInt64LE(amountIn, 0);
    b.writeBigUInt64LE(minOut, 8);
    return b;
  };
  const remaining = (variant: number): AccountMeta[] => [
    { pubkey: poolPda(variant), isSigner: false, isWritable: false },
    { pubkey: vaultUsdc, isSigner: false, isWritable: true },
    { pubkey: venueUsdc[variant]!, isSigner: false, isWritable: true },
    { pubkey: venueStock[variant]!, isSigner: false, isWritable: true },
    { pubkey: vaultStock, isSigner: false, isWritable: true },
    { pubkey: vaultPda, isSigner: false, isWritable: false }, // invest marks it signer
    { pubkey: usdc, isSigner: false, isWritable: false },
    { pubkey: stock, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  const invest = async (amountIn: bigint, minOut: bigint, variant = HONEST, signer: Keypair = crank) =>
    program.methods
      .invest(0, new anchor.BN(amountIn.toString()), new anchor.BN(minOut.toString()), venueData(amountIn, minOut))
      .accountsPartial({
        crank: signer.publicKey,
        vault: vaultPda,
        policy: policyPda,
        vaultIn: vaultUsdc,
        vaultTarget: vaultStock,
        targetMint: stock,
        venueProgram: venue.programId,
      })
      .remainingAccounts(remaining(variant))
      .signers([signer])
      .rpc();

  const expectFailure = async (p: Promise<unknown>, needle: string) => {
    try {
      await p;
    } catch (err) {
      assert.include(String(err), needle, `expected "${needle}"`);
      return;
    }
    assert.fail(`expected a failure mentioning "${needle}", but it succeeded`);
  };
  const stockBal = async () => BigInt((await connection.getTokenAccountBalance(vaultStock)).value.amount);
  const usdcBal = async () => BigInt((await connection.getTokenAccountBalance(vaultUsdc)).value.amount);

  before(async () => {
    for (const kp of [owner, crank, stranger]) {
      const sig = await connection.requestAirdrop(kp.publicKey, 2 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig);
    }

    // The config decides who may crank; the fixture makes it exist exactly once
    // per validator no matter which spec file runs first.
    await ensureConfig(program, provider.wallet.publicKey);
    // Named explicitly rather than inherited: another spec clears the keeper to
    // prove the panic switch, and a test that depends on file order is a test
    // that fails for the wrong reason one day.
    await setKeeper(program, provider.wallet.publicKey, crank.publicKey);

    await program.methods.createVault(2_000).accounts({ owner: owner.publicKey }).signers([owner]).rpc();

    usdc = await createMint(connection, payer, payer.publicKey, null, 6);
    stock = await createMint(connection, payer, payer.publicKey, null, 8, Keypair.generate(), undefined, TOKEN_2022_PROGRAM_ID);

    vaultUsdc = await createAssociatedTokenAccountIdempotent(connection, payer, usdc, vaultPda, undefined, TOKEN_PROGRAM_ID, undefined, true);
    vaultStock = await createAssociatedTokenAccountIdempotent(connection, payer, stock, vaultPda, undefined, TOKEN_2022_PROGRAM_ID, undefined, true);
    await mintTo(connection, payer, usdc, vaultUsdc, payer, 2_000_000_000, [], undefined, TOKEN_PROGRAM_ID);

    for (const [variant, skim, overpull] of [[HONEST, 0, 0], [SKIMMER, 10_000, 0], [OVERPULLER, 0, 5_000]] as const) {
      const pool = poolPda(variant);
      venueUsdc[variant] = await createAssociatedTokenAccountIdempotent(connection, payer, usdc, pool, undefined, TOKEN_PROGRAM_ID, undefined, true);
      venueStock[variant] = await createAssociatedTokenAccountIdempotent(connection, payer, stock, pool, undefined, TOKEN_2022_PROGRAM_ID, undefined, true);
      await mintTo(connection, payer, stock, venueStock[variant], payer, 10_000_000_000, [], undefined, TOKEN_2022_PROGRAM_ID);
      await venue.methods
        .initPool(variant, new anchor.BN(RATE_WAD.toString()), skim, overpull)
        .accountsPartial({ payer: payer.publicKey, pool })
        .rpc();
    }
  });

  it("refuses a policy whose weights do not sum to 10000", async () => {
    await expectFailure(setPolicy({ legsOverride: legs({ weightBps: 9_999 }) }), "InvalidPolicy");
  });
  it("refuses a zero floor: 'accept any price' is not a policy", async () => {
    await expectFailure(setPolicy({ legsOverride: legs({ minOutRateWad: 0n }) }), "InvalidPolicy");
  });
  it("refuses contradictory caps", async () => {
    await expectFailure(setPolicy({ minInvestment: 200_000_000n, maxPerCall: 100_000_000n }), "InvalidPolicy");
  });

  it("accepts the real policy", async () => {
    await setPolicy();
    const p = await program.account.investmentPolicy.fetch(policyPda);
    assert.strictEqual(p.enabled, true);
    assert.strictEqual(p.policyNonce.toString(), "1");
  });

  it("refuses a stranger's crank — the route is caller-chosen, so the caller must not be", async () => {
    await setPolicy();
    // Exactly the honest route the keeper uses; the ONLY difference is who
    // signs. That is what makes this a test of authority rather than of luck.
    let refused: string | null = null;
    try {
      await invest(10_000_000n, expectedOut(10_000_000n), HONEST, stranger);
    } catch (error) {
      refused = String((error as { error?: { errorCode?: { code?: string } } })?.error?.errorCode?.code ?? error);
    }
    assert.include(refused ?? "IT SUCCEEDED", "UnauthorizedCrank", "only the owner or the named keeper may spend the vault's in-asset");
  });

  it("invests: the named keeper triggers it, the delta lands in the vault's ATA", async () => {
    const amountIn = 10_000_000n;
    const minOut = expectedOut(amountIn);
    const stockBefore = await stockBal();
    const usdcBefore = await usdcBal();

    await invest(amountIn, minOut);

    assert.strictEqual((await stockBal()) - stockBefore, minOut, "fill measured, not assumed");
    assert.strictEqual(usdcBefore - (await usdcBal()), amountIn, "exactly amount_in was spent");
    const p = await program.account.investmentPolicy.fetch(policyPda);
    assert.strictEqual(p.lifetimeInvested.toString(), amountIn.toString(), "recorded the MEASURED spend");
  });

  it("refuses a crank min_out below the user's floor", async () => {
    const amountIn = 10_000_000n;
    const floor = (amountIn * ((RATE_WAD * 95n) / 100n)) / WAD;
    await expectFailure(invest(amountIn, floor - 1n), "FloorTooLow");
  });
  it("refuses below the minimum investment", async () => {
    await expectFailure(invest(999_999n, 1n), "BelowMinimum");
  });
  it("refuses above the per-call maximum", async () => {
    await expectFailure(invest(100_000_001n, expectedOut(100_000_001n)), "AboveMaximum");
  });

  it("refuses when the rolling cap has no room", async () => {
    await invest(100_000_000n, expectedOut(100_000_000n));
    await invest(100_000_000n, expectedOut(100_000_000n));
    await invest(100_000_000n, expectedOut(100_000_000n));
    await expectFailure(invest(100_000_000n, expectedOut(100_000_000n)), "RollingCapExhausted");
  });

  it("refuses while disabled, and while paused", async () => {
    await setPolicy({ enabled: false });
    await expectFailure(invest(10_000_000n, expectedOut(10_000_000n)), "InvestingDisabled");
    await setPolicy({ enabled: true, maxRolling: 400_000_000n });
    await program.methods.setPolicy(2_000, true).accounts({ owner: owner.publicKey }).signers([owner]).rpc();
    await expectFailure(invest(10_000_000n, expectedOut(10_000_000n)), "VaultPaused");
    await program.methods.setPolicy(2_000, false).accounts({ owner: owner.publicKey }).signers([owner]).rpc();
  });

  it("refuses while the PROTOCOL is paused, even with the vault and policy enabled", async () => {
    const config = configPdaFor(program.programId);
    const pause = (paused: boolean) =>
      program.methods.setProtocolPaused(paused).accountsPartial({ authority: provider.wallet.publicKey, config }).rpc();
    await pause(true);
    try {
      await expectFailure(invest(10_000_000n, expectedOut(10_000_000n)), "ProtocolPaused");
    } finally {
      await pause(false);
    }
  });

  it("THE FILL GUARD: a venue that under-delivers reverts everything, spend included", async () => {
    const usdcBefore = await usdcBal();
    const stockBefore = await stockBal();
    // The skimmer pool delivers 0; any positive min_out fails.
    await expectFailure(invest(10_000_000n, expectedOut(10_000_000n), SKIMMER), "FillTooSmall");
    assert.strictEqual(await usdcBal(), usdcBefore, "spend unwound");
    assert.strictEqual(await stockBal(), stockBefore, "nothing arrived");
  });

  it("THE SPEND GUARD: a venue that over-pulls the input reverts everything", async () => {
    const usdcBefore = await usdcBal();
    // Over-puller takes 150% of amount_in; the honest fill still clears min_out,
    // so ONLY the overspend guard can catch this.
    await expectFailure(invest(10_000_000n, expectedOut(10_000_000n), OVERPULLER), "Overspent");
    assert.strictEqual(await usdcBal(), usdcBefore, "the over-pull unwound");
  });

  it("refuses a venue that is not the pinned one", async () => {
    // Point venue_program at nuvem itself; the pin rejects it before any CPI.
    await expectFailure(
      program.methods
        .invest(0, new anchor.BN("10000000"), new anchor.BN(expectedOut(10_000_000n).toString()), venueData(10_000_000n, expectedOut(10_000_000n)))
        .accountsPartial({
          crank: crank.publicKey, vault: vaultPda, policy: policyPda,
          vaultIn: vaultUsdc, vaultTarget: vaultStock, targetMint: stock,
          venueProgram: program.programId,
        })
        .remainingAccounts(remaining(HONEST))
        .signers([crank])
        .rpc(),
      "WrongVenue",
    );
  });
});
