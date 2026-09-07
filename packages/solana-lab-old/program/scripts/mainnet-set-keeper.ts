// set_keeper for mainnet — the second half of the upgrade that closed the
// permissionless crank.
//
// WHY IT IS ITS OWN STEP, AND WHY THE ORDER IS NOT NEGOTIABLE. Before this
// upgrade `wrap_sol` and `convert` accepted any signer, so a stranger could
// wrap a vault's SOL and sell it through a pool they controlled. The new
// program refuses every crank except the vault's own owner and the ONE keeper
// named here — and a config whose keeper is still the default pubkey names
// NOBODY, deliberately, so it fails closed. That is the safe state, and it is
// also the state the live config lands in the instant the upgrade goes out:
// its old `_reserved` bytes are all zero.
//
// CONSEQUENCE: between `solana program deploy` and this script, the keeper is
// dead in the water — every wrap and convert it attempts returns
// UnauthorizedCrank. Vault owners can still withdraw throughout (withdraw was
// never crank-gated), so nobody is locked out of their money; only automation
// stops. Run this immediately after the upgrade.
//
// Usage:  ANCHOR_PROVIDER_URL=... ANCHOR_WALLET=... npx tsx scripts/mainnet-set-keeper.ts <keeper-pubkey>
//         ...and pass the DEFAULT pubkey (11111111111111111111111111111111) to
//         disarm the keeper entirely — the panic switch, if its key is ever
//         suspected. That closes the door; it does not reopen it to everyone.
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

async function main() {
  const raw = process.argv[2];
  if (raw === undefined) throw new Error("usage: mainnet-set-keeper.ts <keeper-pubkey | 11111111111111111111111111111111>");
  let keeper: PublicKey;
  try {
    keeper = new PublicKey(raw);
  } catch {
    throw new Error(`"${raw}" is not a base58 pubkey`);
  }

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.nuvemVault;

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
  const existing = await program.account.protocolConfig.fetchNullable(configPda);
  if (existing === null) throw new Error(`no config at ${configPda.toBase58()} — run init-config first`);

  // NAMED BEFORE IT FAILS. has_one = authority means the program rejects a
  // wrong signer, but it rejects it with a constraint error that does not say
  // WHICH key it wanted, and the authority is a key someone has to go find.
  if (!existing.authority.equals(provider.wallet.publicKey)) {
    throw new Error(
      `this wallet is ${provider.wallet.publicKey.toBase58()} but the config's authority is ` +
        `${existing.authority.toBase58()} — only that key may set the keeper`,
    );
  }
  if (existing.keeper.equals(keeper)) {
    console.log(`keeper is already ${keeper.toBase58()} — nothing to do`);
    return;
  }

  const before = existing.keeper.equals(PublicKey.default) ? "nobody (owner-only)" : existing.keeper.toBase58();
  await program.methods.setKeeper(keeper).accountsPartial({ authority: provider.wallet.publicKey, config: configPda }).rpc();

  const after = await program.account.protocolConfig.fetch(configPda);
  if (!after.keeper.equals(keeper)) throw new Error("the write did not stick — read back a different keeper");
  console.log(`keeper: ${before}  ->  ${keeper.equals(PublicKey.default) ? "nobody (owner-only)" : keeper.toBase58()}`);
  console.log(`attester unchanged: ${after.attester.toBase58()}`);
}

main().catch((e) => { console.error(`✗ ${e instanceof Error ? e.message : e}`); process.exit(1); });
