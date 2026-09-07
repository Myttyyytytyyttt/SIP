// Phase 2 of the Raydium fork test: buy real NVDAx with the vault's fabricated
// USDC, through invest()'s opaque venue route, against MAINNET pool state
// cloned into the local validator. No mainnet fee is paid.
//
// This is the whole point of "punto 1": the vault buying a real tokenised
// stock, proven locally, with the exact swap_v2 instruction production will
// send — invest() forwarding it, lending only the vault PDA's signature, and
// measuring the input and output deltas.

import * as anchor from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotent,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSwapV2AccountMetas, buildSwapV2Data, RAYDIUM_CLMM } from "./raydium-swap";

const LOCAL = join(__dirname, ".local");
const pool = JSON.parse(readFileSync(join(__dirname, "../../harness/raydium/captured-swap.json"), "utf8"));
const poolInfo = JSON.parse(readFileSync(join(__dirname, "../../harness/raydium/pool-accounts.json"), "utf8"));
const tickArrays: string[] = JSON.parse(readFileSync(join(__dirname, "../../harness/raydium/tick-arrays.json"), "utf8"));

const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const NVDAX = new PublicKey("Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh");

async function main() {
  process.env.ANCHOR_PROVIDER_URL ??= "http://127.0.0.1:8899";
  process.env.ANCHOR_WALLET ??= `${process.env.HOME}/.config/solana/id.json`;
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.nuvemVault;
  const connection = provider.connection;

  const owner = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(LOCAL, "fork-owner.json"), "utf8"))));
  const crank = Keypair.generate();
  await connection.confirmTransaction(await connection.requestAirdrop(owner.publicKey, 2e9));
  await connection.confirmTransaction(await connection.requestAirdrop(crank.publicKey, 2e9));

  const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from("vault"), owner.publicKey.toBuffer()], program.programId);
  const [policyPda] = PublicKey.findProgramAddressSync([Buffer.from("invest"), vaultPda.toBuffer()], program.programId);
  const vaultUsdc = getAssociatedTokenAddressSync(USDC, vaultPda, true, TOKEN_PROGRAM_ID);

  // create_vault (owner) — the vault PDA now exists; its USDC ATA was injected.
  await program.methods.createVault(2_000).accounts({ owner: owner.publicKey }).signers([owner]).rpc();
  const payer = (provider.wallet as anchor.Wallet).payer;
  const vaultStock = await createAssociatedTokenAccountIdempotent(
    connection, payer, NVDAX, vaultPda, undefined, TOKEN_2022_PROGRAM_ID, undefined, true,
  );

  const usdcBefore = BigInt((await connection.getTokenAccountBalance(vaultUsdc)).value.amount);
  console.log(`vault USDC before: ${Number(usdcBefore) / 1e6}`);

  // Policy: pin Raydium, floor at ~0.9x a rough rate. invest()'s delta guard is
  // the real floor; the policy floor only has to be legal and not-looser-than.
  const AMOUNT_IN = 5_000_000n; // 5 USDC
  const legs = [{ mint: NVDAX, weightBps: 10_000, minOutRateWad: new anchor.BN((10n ** 15n).toString()) }];
  await program.methods
    .setInvestPolicy(legs, RAYDIUM_CLMM, new anchor.BN("30000000000000000"), new anchor.BN("1000000"), new anchor.BN("20000000"), new anchor.BN("30000000"), true)
    .accountsPartial({ owner: owner.publicKey, vault: vaultPda, policy: policyPda })
    .signers([owner])
    .rpc();

  // The real swap_v2 route, vault PDA as payer.
  const MIN_OUT = 5_000n;
  const metas = buildSwapV2AccountMetas(
    {
      ammConfig: new PublicKey(poolInfo.ammConfig),
      poolState: new PublicKey(poolInfo.pool),
      inputVault: new PublicKey(poolInfo.tokenVault1), // USDC vault
      outputVault: new PublicKey(poolInfo.tokenVault0), // NVDAx vault
      observationState: new PublicKey(poolInfo.observationKey),
      inputMint: USDC,
      outputMint: NVDAX,
      inputTokenProgram: TOKEN_PROGRAM_ID,
      outputTokenProgram: TOKEN_2022_PROGRAM_ID,
      tickArrays: tickArrays.map((t) => new PublicKey(t)),
    },
    { payer: vaultPda, inputTokenAccount: vaultUsdc, outputTokenAccount: vaultStock, amountIn: AMOUNT_IN, minAmountOut: MIN_OUT },
  );
  const venueData = buildSwapV2Data({ payer: vaultPda, inputTokenAccount: vaultUsdc, outputTokenAccount: vaultStock, amountIn: AMOUNT_IN, minAmountOut: MIN_OUT });

  // Loosen invest's own account list to REMAINING accounts = the whole swap
  // route. invest marks only the vault PDA as signer.
  const ix = await program.methods
    .invest(0, new anchor.BN(AMOUNT_IN.toString()), new anchor.BN(MIN_OUT.toString()), venueData)
    .accountsPartial({
      crank: crank.publicKey, vault: vaultPda, policy: policyPda,
      vaultIn: vaultUsdc, vaultTarget: vaultStock, targetMint: NVDAX, venueProgram: RAYDIUM_CLMM,
    })
    .remainingAccounts(metas.map((m) => ({ ...m, isSigner: false })))
    .instruction();

  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
    .add(ix);
  const sig = await provider.sendAndConfirm(tx, [crank], { skipPreflight: false });

  const usdcAfter = BigInt((await connection.getTokenAccountBalance(vaultUsdc)).value.amount);
  const stockAfter = BigInt((await connection.getTokenAccountBalance(vaultStock)).value.amount);
  console.log(`\n✓ BOUGHT — tx ${sig}`);
  console.log(`  USDC spent : ${Number(usdcBefore - usdcAfter) / 1e6} USDC`);
  console.log(`  NVDAx got  : ${Number(stockAfter) / 1e8} NVDAx`);
  const p = await program.account.investmentPolicy.fetch(policyPda);
  console.log(`  lifetime invested (measured): ${Number(p.lifetimeInvested) / 1e6} USDC`);
}

main().catch((e) => {
  console.error(`\n✗ ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
