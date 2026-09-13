// THE WHOLE PRODUCT, ONE SCRIPT, ZERO MAINNET FEES:
//
//   session traded ──► MEASURED from chain history (not declared)
//        ──► attested (Ed25519 signs the measured number)
//        ──► settled  (skim% of measured profit -> vault, in SOL)
//        ──► wrapped  (vault SOL -> vault wSOL)
//        ──► converted (wSOL -> USDC via the REAL cloned Raydium pool)
//        ──► invested  (USDC -> NVDAx via the REAL cloned Raydium pool)
//
// This closes the gap the product owner spotted: previously the drill DECLARED
// the profit it had itself simulated; here the attester signs whatever
// measure-session computed from the validator's own history, and every later
// step consumes the previous one's real output.

import * as anchor from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotent,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { attestationInstruction, MODE_PROFIT } from "./attestation";
import { measureCashSession } from "./measure-session";
import { buildSwapV2AccountMetas, buildSwapV2Data, MEMO_PROGRAM, RAYDIUM_CLMM } from "./raydium-swap";

const nvdaxPool = JSON.parse(readFileSync(join(__dirname, "../../harness/raydium/pool-accounts.json"), "utf8"));
const nvdaxTicks: string[] = JSON.parse(readFileSync(join(__dirname, "../../harness/raydium/tick-arrays.json"), "utf8"));
const wsolSwap = JSON.parse(readFileSync(join(__dirname, "../../harness/raydium/captured-swap-wsol.json"), "utf8"));

const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const NVDAX = new PublicKey("Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh");
const sol = (l: bigint | number): string => `${(Number(l) / 1e9).toFixed(6)} SOL`;

async function main() {
  process.env.ANCHOR_PROVIDER_URL ??= "http://127.0.0.1:8899";
  process.env.ANCHOR_WALLET ??= `${process.env.HOME}/.config/solana/id.json`;
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.sipVault;
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  // Fresh actors per run: owner, trading wallet, attester, market, crank.
  const owner = Keypair.generate();
  const wallet = Keypair.generate();
  const attester = Keypair.generate();
  const market = Keypair.generate();
  const crank = Keypair.generate();
  for (const kp of [owner, market, crank]) {
    await connection.confirmTransaction(await connection.requestAirdrop(kp.publicKey, 3 * LAMPORTS_PER_SOL));
  }

  const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from("vault"), owner.publicKey.toBuffer()], program.programId);
  const [linkPda] = PublicKey.findProgramAddressSync([Buffer.from("link"), wallet.publicKey.toBuffer()], program.programId);
  const [policyPda] = PublicKey.findProgramAddressSync([Buffer.from("invest"), vaultPda.toBuffer()], program.programId);
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);

  // ── setup: config, vault, link ─────────────────────────────────────────────
  if ((await connection.getAccountInfo(configPda)) === null) {
    await program.methods.initConfig(attester.publicKey).accounts({ authority: provider.wallet.publicKey }).rpc();
  } else {
    throw new Error("config already initialised by a previous run — restart the validator (fork.sh does)");
  }
  const SKIM_BPS = 2_000;
  await program.methods
    .createVaultV2(MODE_PROFIT, SKIM_BPS, 20, new anchor.BN(10 * LAMPORTS_PER_SOL), new anchor.BN(0))
    .accounts({ owner: owner.publicKey })
    .signers([owner])
    .rpc();
  await program.methods
    .linkWallet()
    .accounts({ owner: owner.publicKey, wallet: wallet.publicKey })
    .signers([owner, wallet])
    .rpc();
  console.log(`vault ${vaultPda.toBase58()}  wallet ${wallet.publicKey.toBase58()}`);

  // ── 1. the SESSION: capital arrives, trades win and lose ──────────────────
  // The airdrop and capital transfer are PURE transfers -> classified as
  // deposits. The "trades" carry a memo instruction, so the classifier counts
  // their cash effect toward profit — the same shape a DEX interaction has.
  const memo = (text: string) =>
    new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [], data: Buffer.from(text) });

  await provider.sendAndConfirm(
    new Transaction().add(
      SystemProgram.transfer({ fromPubkey: market.publicKey, toPubkey: wallet.publicKey, lamports: 2 * LAMPORTS_PER_SOL }),
    ),
    [market],
  ); // capital: an external deposit

  await provider.sendAndConfirm(
    new Transaction()
      .add(SystemProgram.transfer({ fromPubkey: market.publicKey, toPubkey: wallet.publicKey, lamports: 0.8 * LAMPORTS_PER_SOL }))
      .add(memo("trade win")),
    [market],
  );
  await provider.sendAndConfirm(
    new Transaction()
      .add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: market.publicKey, lamports: 0.3 * LAMPORTS_PER_SOL }))
      .add(memo("trade loss")),
    [wallet],
  );

  // ── 2. MEASURE from history — the number is not declared anywhere ────────
  const measured = await measureCashSession(connection, wallet.publicKey);
  console.log(
    `measured: ${measured.txCount} txs, chain breaks ${measured.chainBreaks}, ` +
      `cashΔ ${sol(measured.cashDelta)}, deposits ${sol(measured.deposits)}, ` +
      `withdrawals ${sol(measured.withdrawals)} ⇒ PROFIT ${sol(measured.profitLamports)}`,
  );
  if (measured.chainBreaks !== 0) throw new Error("completeness oracle broke — refusing to attest");
  if (measured.profitLamports <= 0n) throw new Error("no profit measured — nothing to settle");

  // ── 3. ATTEST the measured number, 4. SETTLE it ───────────────────────────
  const link = await program.account.tradingLink.fetch(linkPda);
  const end = BigInt(await connection.getSlot());
  const vaultPolicy = await program.account.vault.fetch(vaultPda);
  const inputs = {
    programId: program.programId,
    wallet: wallet.publicKey,
    vault: vaultPda,
    linkEpoch: BigInt(link.epoch.toString()),
    settlementNonce: BigInt(link.settlementNonce.toString()),
    sessionStartSlot: BigInt(link.frontierSlot.toString()),
    sessionEndSlot: end,
    baseLamports: measured.profitLamports,
    mode: MODE_PROFIT,
    bps: vaultPolicy.skimBps,
    policyNonce: BigInt(vaultPolicy.policyNonce.toString()),
    validUntilSlot: end + 150n,
  };
  const vaultBefore = BigInt(await connection.getBalance(vaultPda));
  await program.methods
    .settleV2(
      inputs.mode,
      new anchor.BN(inputs.sessionStartSlot.toString()),
      new anchor.BN(inputs.sessionEndSlot.toString()),
      new anchor.BN(inputs.baseLamports.toString()),
      new anchor.BN(inputs.validUntilSlot.toString()),
    )
    .accountsPartial({ wallet: wallet.publicKey, vault: vaultPda, tradingLink: linkPda })
    .preInstructions([attestationInstruction(attester.secretKey, inputs)])
    .signers([wallet])
    .rpc();
  const settled = BigInt(await connection.getBalance(vaultPda)) - vaultBefore;
  const expected = (measured.profitLamports * BigInt(SKIM_BPS)) / 10_000n;
  if (settled !== expected) throw new Error(`settled ${settled} != expected ${expected}`);
  console.log(`settled: ${sol(settled)} (${SKIM_BPS / 100}% of MEASURED profit) -> vault`);

  // ── 5. WRAP: vault SOL -> vault wSOL ──────────────────────────────────────
  const vaultWsol = await createAssociatedTokenAccountIdempotent(connection, payer, NATIVE_MINT, vaultPda, undefined, TOKEN_PROGRAM_ID, undefined, true);
  const vaultUsdc = await createAssociatedTokenAccountIdempotent(connection, payer, USDC, vaultPda, undefined, TOKEN_PROGRAM_ID, undefined, true);
  const vaultStock = await createAssociatedTokenAccountIdempotent(connection, payer, NVDAX, vaultPda, undefined, TOKEN_2022_PROGRAM_ID, undefined, true);

  const wrapAmount = settled; // wrap everything that was just saved
  await program.methods
    .wrapSol(new anchor.BN(wrapAmount.toString()))
    .accountsPartial({ crank: crank.publicKey, vault: vaultPda, vaultWsol, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
    .signers([crank])
    .rpc();
  console.log(`wrapped: ${sol(wrapAmount)} -> wSOL`);

  // ── policy: Raydium pinned, NVDAx leg, convert floor $30/SOL-equivalent ───
  const legs = [{ mint: NVDAX, weightBps: 10_000, minOutRateWad: new anchor.BN((10n ** 15n).toString()) }];
  await program.methods
    .setInvestPolicy(
      legs, RAYDIUM_CLMM,
      new anchor.BN("30000000000000000"), // 0.03 USDC-raw per lamport ≈ $30/SOL floor
      new anchor.BN("1000000"), new anchor.BN("20000000"), new anchor.BN("30000000"), true,
    )
    .accountsPartial({ owner: owner.publicKey, vault: vaultPda, policy: policyPda })
    .signers([owner])
    .rpc();

  // ── 6. CONVERT wSOL -> USDC through the REAL cloned pool ──────────────────
  const wa = wsolSwap.accounts;
  const wsolPool = {
    ammConfig: new PublicKey(wa[1]),
    poolState: new PublicKey(wa[2]),
    inputVault: new PublicKey(wa[5]),
    outputVault: new PublicKey(wa[6]),
    observationState: new PublicKey(wa[7]),
    inputMint: NATIVE_MINT,
    outputMint: USDC,
    inputTokenProgram: TOKEN_PROGRAM_ID,
    outputTokenProgram: TOKEN_PROGRAM_ID,
    tickArrays: (wa.slice(13) as string[]).map((t) => new PublicKey(t)),
  };
  // min_out from the policy floor (± the crank may be tighter): $30/SOL equiv.
  const convertMinOut = (wrapAmount * 30_000_000_000_000_000n) / 10n ** 18n;
  const convertArgs = { payer: vaultPda, inputTokenAccount: vaultWsol, outputTokenAccount: vaultUsdc, amountIn: wrapAmount, minAmountOut: convertMinOut };
  const convertIx = await program.methods
    .convert(new anchor.BN(wrapAmount.toString()), new anchor.BN(convertMinOut.toString()), buildSwapV2Data(convertArgs))
    .accountsPartial({ crank: crank.publicKey, vault: vaultPda, policy: policyPda, vaultWsol, vaultIn: vaultUsdc, venueProgram: RAYDIUM_CLMM })
    .remainingAccounts(buildSwapV2AccountMetas(wsolPool, convertArgs).map((m) => ({ ...m, isSigner: false })))
    .instruction();
  await provider.sendAndConfirm(
    new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 })).add(convertIx),
    [crank],
  );
  const usdcBalance = BigInt((await connection.getTokenAccountBalance(vaultUsdc)).value.amount);
  console.log(`converted: ${sol(wrapAmount)} -> ${Number(usdcBalance) / 1e6} USDC (real Raydium wSOL/USDC pool)`);

  // ── 7. INVEST USDC -> NVDAx through the REAL cloned pool ──────────────────
  const investAmount = usdcBalance < 20_000_000n ? usdcBalance : 20_000_000n;
  // The leg floor is amountIn * minOutRateWad / 1e18; the crank must ask for at
  // least that. Computed from the ACTUAL amount, not hard-coded — with ~15 USDC
  // converted, a fixed 5_000 sat below the floor and the guard (correctly) bit.
  const investMinOut = (investAmount * 10n ** 15n) / 10n ** 18n;
  const investArgs = { payer: vaultPda, inputTokenAccount: vaultUsdc, outputTokenAccount: vaultStock, amountIn: investAmount, minAmountOut: investMinOut };
  const nvdaxRoute = {
    ammConfig: new PublicKey(nvdaxPool.ammConfig),
    poolState: new PublicKey(nvdaxPool.pool),
    inputVault: new PublicKey(nvdaxPool.tokenVault1),
    outputVault: new PublicKey(nvdaxPool.tokenVault0),
    observationState: new PublicKey(nvdaxPool.observationKey),
    inputMint: USDC,
    outputMint: NVDAX,
    inputTokenProgram: TOKEN_PROGRAM_ID,
    outputTokenProgram: TOKEN_2022_PROGRAM_ID,
    tickArrays: nvdaxTicks.map((t) => new PublicKey(t)),
  };
  const investIx = await program.methods
    .invest(0, new anchor.BN(investAmount.toString()), new anchor.BN(investMinOut.toString()), buildSwapV2Data(investArgs))
    .accountsPartial({ crank: crank.publicKey, vault: vaultPda, policy: policyPda, vaultIn: vaultUsdc, vaultTarget: vaultStock, targetMint: NVDAX, venueProgram: RAYDIUM_CLMM })
    .remainingAccounts(buildSwapV2AccountMetas(nvdaxRoute, investArgs).map((m) => ({ ...m, isSigner: false })))
    .instruction();
  await provider.sendAndConfirm(
    new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 })).add(investIx),
    [crank],
  );

  const stock = BigInt((await connection.getTokenAccountBalance(vaultStock)).value.amount);
  const policy = await program.account.investmentPolicy.fetch(policyPda);
  console.log(`invested: ${Number(investAmount) / 1e6} USDC -> ${Number(stock) / 1e8} NVDAx (raw)`);
  console.log(`\n════ E2E COMPLETE ════`);
  console.log(`  profit MEASURED from history : ${sol(measured.profitLamports)}`);
  console.log(`  settled to vault (20%)       : ${sol(settled)}`);
  console.log(`  wrapped -> converted         : ${Number(usdcBalance) / 1e6} USDC`);
  console.log(`  invested                     : ${Number(investAmount) / 1e6} USDC`);
  console.log(`  vault now holds              : ${Number(stock) / 1e8} NVDAx (raw units)`);
  console.log(`  lifetime_invested (measured) : ${Number(policy.lifetimeInvested) / 1e6} USDC`);
}

main().catch((e) => {
  console.error(`\n✗ ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
