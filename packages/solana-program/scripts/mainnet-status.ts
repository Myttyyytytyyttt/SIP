// Read-only status: config, vault, balances — what the operator quotes.
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.sipVault;
  const operator = provider.wallet.publicKey;

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
  const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from("vault"), operator.toBuffer()], program.programId);

  const config = await program.account.protocolConfig.fetchNullable(configPda);
  console.log(`  config      ${config === null ? "NOT INITIALISED" : `attester ${config.attester.toBase58()}`}`);
  const vault = await program.account.vault.fetchNullable(vaultPda);
  if (vault === null) {
    console.log(`  vault       none for ${operator.toBase58()} (the drill creates it)`);
  } else {
    const lamports = await provider.connection.getBalance(vaultPda);
    console.log(`  vault       ${vaultPda.toBase58()}`);
    console.log(`  skim        ${vault.skimBps} bps   paused ${vault.paused}`);
    console.log(`  balance     ${(lamports / 1e9).toFixed(6)} SOL   lifetime saved ${(Number(vault.lifetimeSaved) / 1e9).toFixed(6)} SOL`);
  }
}

main().catch((e) => { console.error(`✗ ${e instanceof Error ? e.message : e}`); process.exit(1); });
