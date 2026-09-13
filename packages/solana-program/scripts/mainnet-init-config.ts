// init_config for mainnet — run by mainnet.sh in the same breath as the deploy,
// because first-caller-wins. Generates and persists the mainnet attester on
// first run; refuses nothing on rerun if the config already matches.
import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LOCAL = join(__dirname, ".local");

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.sipVault;

  const path = join(LOCAL, "mainnet-attester.json");
  let attester: Keypair;
  if (existsSync(path)) {
    attester = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
  } else {
    attester = Keypair.generate();
    mkdirSync(LOCAL, { recursive: true });
    writeFileSync(path, JSON.stringify([...attester.secretKey]));
  }

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
  const existing = await program.account.protocolConfig.fetchNullable(configPda);
  if (existing !== null) {
    if (existing.attester.equals(attester.publicKey)) {
      console.log(`config already initialised with OUR attester ${attester.publicKey.toBase58()} — ok`);
      return;
    }
    throw new Error(
      `config already initialised with a DIFFERENT attester ${existing.attester.toBase58()} — ` +
        "someone won the first-caller race. Close and redeploy under a NEW id, faster this time.",
    );
  }
  await program.methods.initConfig(attester.publicKey).accounts({ authority: provider.wallet.publicKey }).rpc();
  console.log(`config initialised, attester ${attester.publicKey.toBase58()} (key in scripts/.local/, NOT committed)`);
}

main().catch((e) => { console.error(`✗ ${e instanceof Error ? e.message : e}`); process.exit(1); });
