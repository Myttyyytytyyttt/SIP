// The mainnet drill: the whole chain against LIVE Solana mainnet, small money.
//
//   session -> profit MEASURED from real history -> attested -> settled ->
//   wrapped -> converted (live wSOL/USDC route) -> invested (live NVDAx route)
//
// ROLES COLLAPSE INTO THE OPERATOR. The wallet at ANCHOR_WALLET is owner,
// market and crank at once — this is a drill, not the product. Only two other
// keys exist, both persisted under scripts/.local/ and NEVER committed:
// the trading wallet and the attester (which must match the on-chain config,
// which mainnet.sh deploy initialised).
//
// WHAT IT SPENDS. The capital and the "profit" move between the operator's
// own pockets (operator -> trading wallet); the settled share becomes NVDAx
// in a vault the operator owns and can withdraw. The true burn is transaction
// fees plus two small pool fees — cents.
//
// Run through mainnet.sh, which sets the env:   ./scripts/mainnet.sh drill

import * as anchor from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Connection,
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
} from "@solana/spl-token";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { attestationInstruction, MODE_PROFIT } from "./attestation";
import { linkWalletWithConsent } from "./link-consent";
import { measureCashSession } from "./measure-session";
import { fetchLiveRoute } from "./live-route";
import { buildSwapV2AccountMetas, buildSwapV2Data, MEMO_PROGRAM, RAYDIUM_CLMM } from "./raydium-swap";
import { recordDrillHistory } from "./record-history";

const LOCAL = join(__dirname, ".local");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const NVDAX = new PublicKey("Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh");
const WSOL_USDC_POOL = new PublicKey("3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv");
const NVDAX_POOL = new PublicKey("49iMatQtoyabsYAQc8GafVq6aeBFVDxSRH44oiatyyw6");

const PROFIT_SOL = Number(process.env.NUVEM_DRILL_PROFIT_SOL ?? "0.2");
const CAPITAL_SOL = 0.02;
const sol = (l: bigint | number): string => `${(Number(l) / 1e9).toFixed(6)} SOL`;

function persisted(name: string): Keypair {
  const path = join(LOCAL, `${name}.json`);
  if (existsSync(path)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
  const kp = Keypair.generate();
  mkdirSync(LOCAL, { recursive: true });
  writeFileSync(path, JSON.stringify([...kp.secretKey]));
  return kp;
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.sipVault;
  const connection: Connection = provider.connection;
  const operator = (provider.wallet as anchor.Wallet).payer;

  const wallet = persisted("mainnet-trading-wallet");
  const attester = persisted("mainnet-attester");

  const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from("vault"), operator.publicKey.toBuffer()], program.programId);
  const [linkPda] = PublicKey.findProgramAddressSync([Buffer.from("link"), wallet.publicKey.toBuffer()], program.programId);
  const [policyPda] = PublicKey.findProgramAddressSync([Buffer.from("invest"), vaultPda.toBuffer()], program.programId);
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);

  // ── sanity: the on-chain attester must be OUR attester ─────────────────────
  const config = await program.account.protocolConfig.fetchNullable(configPda);
  if (config === null) throw new Error("no ProtocolConfig — run `./scripts/mainnet.sh deploy` first");
  if (!config.attester.equals(attester.publicKey)) {
    throw new Error(
      `on-chain attester ${config.attester.toBase58()} != local ${attester.publicKey.toBase58()} — ` +
        "the config was initialised with a different key",
    );
  }

  // ── vault + link (idempotent) ──────────────────────────────────────────────
  if ((await connection.getAccountInfo(vaultPda)) === null) {
    await program.methods
      .createVaultV2(MODE_PROFIT, 2_000, 20, new anchor.BN(LAMPORTS_PER_SOL), new anchor.BN(0))
      .accounts({ owner: operator.publicKey })
      .rpc();
    console.log(`vault created: ${vaultPda.toBase58()}`);
  }
  if ((await connection.getAccountInfo(linkPda)) === null) {
    // The wallet's own off-chain consent rides immediately before link_wallet.
    await linkWalletWithConsent(program, { owner: operator.publicKey, wallet }).signers([wallet]).rpc();
    console.log(`trading wallet linked: ${wallet.publicKey.toBase58()}`);
  }

  // ── 1. the session: capital (pure transfer) + a memo-tagged win ───────────
  const memo = (text: string) =>
    new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [], data: Buffer.from(text) });
  await provider.sendAndConfirm(
    new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: operator.publicKey,
        toPubkey: wallet.publicKey,
        lamports: Math.floor(CAPITAL_SOL * LAMPORTS_PER_SOL),
      }),
    ),
  );
  await provider.sendAndConfirm(
    new Transaction()
      .add(
        SystemProgram.transfer({
          fromPubkey: operator.publicKey,
          toPubkey: wallet.publicKey,
          lamports: Math.floor(PROFIT_SOL * LAMPORTS_PER_SOL),
        }),
      )
      .add(memo("nuvem drill: session win")),
  );
  console.log(`session played: ${CAPITAL_SOL} SOL capital (deposit) + ${PROFIT_SOL} SOL win (memo-tagged)`);

  // ── 2. measure from REAL mainnet history ───────────────────────────────────
  const measured = await measureCashSession(connection, wallet.publicKey, 30);
  console.log(
    `measured: ${measured.txCount} txs, breaks ${measured.chainBreaks}, ` +
      `cashΔ ${sol(measured.cashDelta)}, dep ${sol(measured.deposits)}, wd ${sol(measured.withdrawals)} ` +
      `⇒ PROFIT ${sol(measured.profitLamports)}`,
  );
  if (measured.chainBreaks !== 0) throw new Error("completeness oracle broke — refusing to attest");

  // The link's frontier bounds what is already settled; only settle new profit.
  const link = await program.account.tradingLink.fetch(linkPda);
  if (measured.profitLamports <= 0n) throw new Error("no unsettled profit measured");

  // ── 3+4. attest the measured number, settle it ─────────────────────────────
  const vaultPolicy = await program.account.vault.fetch(vaultPda);
  const sessionEndSlot = BigInt(await connection.getSlot());
  const inputs = {
    programId: program.programId,
    wallet: wallet.publicKey,
    vault: vaultPda,
    linkEpoch: BigInt(link.epoch.toString()),
    settlementNonce: BigInt(link.settlementNonce.toString()),
    sessionStartSlot: BigInt(link.frontierSlot.toString()),
    sessionEndSlot,
    baseLamports: measured.profitLamports,
    mode: MODE_PROFIT,
    bps: vaultPolicy.skimBps,
    policyNonce: BigInt(vaultPolicy.policyNonce.toString()),
    validUntilSlot: sessionEndSlot + 150n,
  };
  const vaultBefore = BigInt(await connection.getBalance(vaultPda));
  const settleSig = await program.methods
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
  console.log(`settled: ${sol(settled)} (20% of MEASURED profit) -> vault`);

  // ── 5. wrap ────────────────────────────────────────────────────────────────
  const vaultWsol = await createAssociatedTokenAccountIdempotent(connection, operator, NATIVE_MINT, vaultPda, undefined, TOKEN_PROGRAM_ID, undefined, true);
  const vaultUsdc = await createAssociatedTokenAccountIdempotent(connection, operator, USDC, vaultPda, undefined, TOKEN_PROGRAM_ID, undefined, true);
  const vaultStock = await createAssociatedTokenAccountIdempotent(connection, operator, NVDAX, vaultPda, undefined, TOKEN_2022_PROGRAM_ID, undefined, true);
  // ── policy (idempotent-ish: set every run, owner signs anyway) ─────────────
  // BEFORE the wrap: wrap_sol refuses a vault whose owner has not enabled a
  // policy with a conversion floor, which is every vault on its first run.
  const legs = [{ mint: NVDAX, weightBps: 10_000, minOutRateWad: new anchor.BN((10n ** 15n).toString()) }];
  await program.methods
    .setInvestPolicy(
      legs, RAYDIUM_CLMM,
      USDC,
      new anchor.BN("30000000000000000"), // convert floor ≈ $30/SOL
      new anchor.BN("1000000"), new anchor.BN("50000000"), new anchor.BN("100000000"), true,
    )
    .accountsPartial({ owner: operator.publicKey, vault: vaultPda, policy: policyPda })
    .rpc();

  await program.methods
    .wrapSol(new anchor.BN(settled.toString()))
    .accountsPartial({ crank: operator.publicKey, vault: vaultPda, policy: policyPda, vaultWsol, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
    .rpc();
  console.log(`wrapped: ${sol(settled)} -> wSOL`);

  // ── 6. convert via a LIVE route ────────────────────────────────────────────
  console.log("fetching live wSOL/USDC route…");
  const convertRoute = await fetchLiveRoute(connection, WSOL_USDC_POOL, NATIVE_MINT, USDC, TOKEN_PROGRAM_ID);
  console.log(`  route from ${convertRoute.capturedFrom.slice(0, 16)}… (directionMatched=${convertRoute.directionMatched})`);
  const convertMinOut = (settled * 30_000_000_000_000_000n) / 10n ** 18n; // the $30/SOL floor
  const convertArgs = { payer: vaultPda, inputTokenAccount: vaultWsol, outputTokenAccount: vaultUsdc, amountIn: settled, minAmountOut: convertMinOut };
  await provider.sendAndConfirm(
    new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
      .add(
        await program.methods
          .convert(new anchor.BN(settled.toString()), new anchor.BN(convertMinOut.toString()), buildSwapV2Data(convertArgs))
          .accountsPartial({ crank: operator.publicKey, vault: vaultPda, policy: policyPda, vaultWsol, vaultIn: vaultUsdc, venueProgram: RAYDIUM_CLMM })
          .remainingAccounts(buildSwapV2AccountMetas(convertRoute, convertArgs).map((m) => ({ ...m, isSigner: false })))
          .instruction(),
      ),
  );
  const usdcBalance = BigInt((await connection.getTokenAccountBalance(vaultUsdc)).value.amount);
  console.log(`converted: ${sol(settled)} -> ${Number(usdcBalance) / 1e6} USDC`);

  // ── 7. invest via a LIVE route ─────────────────────────────────────────────
  console.log("fetching live USDC/NVDAx route…");
  const investRoute = await fetchLiveRoute(connection, NVDAX_POOL, USDC, NVDAX, TOKEN_2022_PROGRAM_ID);
  console.log(`  route from ${investRoute.capturedFrom.slice(0, 16)}… (directionMatched=${investRoute.directionMatched})`);
  const investAmount = usdcBalance < 50_000_000n ? usdcBalance : 50_000_000n;
  const investMinOut = (investAmount * 10n ** 15n) / 10n ** 18n;
  const investArgs = { payer: vaultPda, inputTokenAccount: vaultUsdc, outputTokenAccount: vaultStock, amountIn: investAmount, minAmountOut: investMinOut };
  const stockBefore = BigInt((await connection.getTokenAccountBalance(vaultStock)).value.amount);
  const investSig = await provider.sendAndConfirm(
    new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
      .add(
        await program.methods
          .invest(0, new anchor.BN(investAmount.toString()), new anchor.BN(investMinOut.toString()), buildSwapV2Data(investArgs))
          .accountsPartial({ crank: operator.publicKey, vault: vaultPda, policy: policyPda, vaultIn: vaultUsdc, vaultTarget: vaultStock, targetMint: NVDAX, venueProgram: RAYDIUM_CLMM })
          .remainingAccounts(buildSwapV2AccountMetas(investRoute, investArgs).map((m) => ({ ...m, isSigner: false })))
          .instruction(),
      ),
  );
  const stockAfter = BigInt((await connection.getTokenAccountBalance(vaultStock)).value.amount);

  console.log(`\n════ MAINNET DRILL COMPLETE ════`);
  console.log(`  profit MEASURED  : ${sol(measured.profitLamports)}`);
  console.log(`  settled (20%)    : ${sol(settled)}`);
  console.log(`  converted        : ${Number(usdcBalance) / 1e6} USDC`);
  console.log(`  bought           : ${Number(stockAfter - stockBefore) / 1e8} NVDAx (raw units)`);
  console.log(`\n  vault  ${vaultPda.toBase58()}`);
  console.log(`  link   ${linkPda.toBase58()}`);
  console.log(`  (paste both into the web dev panel with NUVEM_SOLANA_RPC_URL set to mainnet)`);

  // Persist to the website's read model (nuvem_solana), best-effort.
  await recordDrillHistory(
    { addr: vaultPda.toBase58(), owner: operator.publicKey.toBase58(), skimBps: 2_000 },
    { walletAddr: wallet.publicKey.toBase58() },
    {
      walletAddr: wallet.publicKey.toBase58(),
      nonce: inputs.settlementNonce,
      vaultAddr: vaultPda.toBase58(),
      profitRaw: measured.profitLamports,
      contributionRaw: settled,
      txRef: settleSig,
      slot: inputs.sessionEndSlot,
    },
    {
      vaultAddr: vaultPda.toBase58(),
      target: NVDAX.toBase58(),
      spentRaw: investAmount,
      receivedRaw: stockAfter - stockBefore,
      txRef: investSig,
      slot: inputs.sessionEndSlot,
    },
  );
}

main().catch((e) => {
  console.error(`\n✗ ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
