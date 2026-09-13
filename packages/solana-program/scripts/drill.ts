// The whole flow, one command: what the keeper will do in production, played
// by a script against the local validator.
//
//   1. ensure the ProtocolConfig exists (attester = a persisted local keypair)
//   2. ensure the provider wallet has a vault, and a trading wallet is linked
//   3. simulate a profitable session: a "market" pays the trading wallet
//   4. attest the session (sign with the attester) and settle it
//   5. print before/after, plus the addresses to paste into the web's
//      dev-panel "Solana lab" card
//
// Run it twice and watch the nonce advance and the frontier move — that is the
// cursor working. The attester and trading wallet persist under scripts/.local/
// (gitignored), so repeated runs exercise the SAME vault the way repeated real
// sessions would.
//
// Usage, from program/:
//   solana-test-validator --reset          (terminal 1)
//   anchor deploy && npx tsx scripts/drill.ts   (terminal 2, repeatable)

import * as anchor from "@coral-xyz/anchor";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { attestationInstruction } from "./attestation";

const LOCAL_DIR = join(__dirname, ".local");
const PROFIT_SOL = 0.5;

function persistedKeypair(name: string): Keypair {
  const path = join(LOCAL_DIR, `${name}.json`);
  if (existsSync(path)) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
  }
  const keypair = Keypair.generate();
  mkdirSync(LOCAL_DIR, { recursive: true });
  writeFileSync(path, JSON.stringify([...keypair.secretKey]));
  return keypair;
}

const sol = (lamports: number | bigint): string => `${(Number(lamports) / 1e9).toFixed(9)} SOL`;

async function main() {
  process.env.ANCHOR_PROVIDER_URL ??= "http://127.0.0.1:8899";
  process.env.ANCHOR_WALLET ??= `${process.env.HOME}/.config/solana/id.json`;
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.sipVault;
  const connection = provider.connection;
  const owner = provider.wallet.publicKey;

  const attester = persistedKeypair("attester");
  const wallet = persistedKeypair("trading-wallet");

  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), owner.toBuffer()],
    program.programId,
  );
  const [linkPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("link"), wallet.publicKey.toBuffer()],
    program.programId,
  );
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);

  // ── 1. config ──────────────────────────────────────────────────────────────
  const existingConfig = await connection.getAccountInfo(configPda);
  if (existingConfig === null) {
    await program.methods.initConfig(attester.publicKey).accounts({ authority: owner }).rpc();
    console.log(`config initialised, attester ${attester.publicKey.toBase58()}`);
  } else {
    const config = await program.account.protocolConfig.fetch(configPda);
    if (!config.attester.equals(attester.publicKey)) {
      console.error(
        "The config on this validator names a DIFFERENT attester (probably from a test run).\n" +
          "Restart it clean —  solana-test-validator --reset  — then `anchor deploy` and rerun.",
      );
      process.exit(2);
    }
  }

  // ── 2. vault + link ────────────────────────────────────────────────────────
  if ((await connection.getAccountInfo(vaultPda)) === null) {
    await program.methods.createVault(2_000).accounts({ owner }).rpc();
    console.log(`vault created (skim 20%): ${vaultPda.toBase58()}`);
  }
  if ((await connection.getAccountInfo(linkPda)) === null) {
    await program.methods
      .linkWallet()
      .accounts({ owner, wallet: wallet.publicKey })
      .signers([wallet])
      .rpc();
    console.log(`trading wallet linked: ${wallet.publicKey.toBase58()}`);
  }

  if ((await connection.getBalance(wallet.publicKey)) < 1 * LAMPORTS_PER_SOL) {
    const sig = await connection.requestAirdrop(wallet.publicKey, 3 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig);
    console.log("trading wallet funded with 3 SOL");
  }

  // ── 3. the session: the market pays the trader ─────────────────────────────
  const market = Keypair.generate();
  const airdropSig = await connection.requestAirdrop(market.publicKey, 2 * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(airdropSig);

  const profitLamports = BigInt(Math.floor(PROFIT_SOL * LAMPORTS_PER_SOL));
  await provider.sendAndConfirm(
    new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: market.publicKey,
        toPubkey: wallet.publicKey,
        lamports: Number(profitLamports),
      }),
    ),
    [market],
  );
  console.log(`session simulated: the market paid the trader ${sol(profitLamports)}`);

  // ── 4. attest + settle ─────────────────────────────────────────────────────
  const link = await program.account.tradingLink.fetch(linkPda);
  const frontier = BigInt(link.frontierSlot.toString());
  let end = BigInt(await connection.getSlot());
  while (end <= frontier) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    end = BigInt(await connection.getSlot());
  }

  const inputs = {
    programId: program.programId,
    wallet: wallet.publicKey,
    vault: vaultPda,
    linkEpoch: BigInt(link.epoch.toString()),
    settlementNonce: BigInt(link.settlementNonce.toString()),
    sessionStartSlot: frontier,
    sessionEndSlot: end,
    profitLamports,
  };

  const vaultBefore = await connection.getBalance(vaultPda);
  const vaultStateBefore = await program.account.vault.fetch(vaultPda);

  await program.methods
    .settle(
      new anchor.BN(inputs.sessionStartSlot.toString()),
      new anchor.BN(inputs.sessionEndSlot.toString()),
      new anchor.BN(inputs.profitLamports.toString()),
    )
    .accountsPartial({ wallet: wallet.publicKey, vault: vaultPda, tradingLink: linkPda })
    .preInstructions([attestationInstruction(attester.secretKey, inputs)])
    .signers([wallet])
    .rpc();

  // ── 5. the receipt ─────────────────────────────────────────────────────────
  const vaultAfter = await connection.getBalance(vaultPda);
  const vaultState = await program.account.vault.fetch(vaultPda);
  const linkAfter = await program.account.tradingLink.fetch(linkPda);

  console.log("\n── settled ──────────────────────────────────────────────");
  console.log(`  session profit        ${sol(profitLamports)}`);
  console.log(`  vault share (20%)     ${sol(vaultAfter - vaultBefore)}`);
  console.log(`  vault balance         ${sol(vaultBefore)} -> ${sol(vaultAfter)}`);
  console.log(
    `  lifetime saved        ${sol(BigInt(vaultStateBefore.lifetimeSaved.toString()))} -> ${sol(BigInt(vaultState.lifetimeSaved.toString()))}`,
  );
  console.log(`  settlement nonce      ${link.settlementNonce} -> ${linkAfter.settlementNonce}`);
  console.log(`  frontier slot         ${link.frontierSlot} -> ${linkAfter.frontierSlot}`);
  console.log("\n── paste into the web dev panel (Solana lab card) ───────");
  console.log(`  vault  ${vaultPda.toBase58()}`);
  console.log(`  link   ${linkPda.toBase58()}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
