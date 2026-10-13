// `anchor test` without anchor's validator: the whole tests/ suite (or the
// files named) against target/deploy/sip_vault.so and toy_venue.so, preloaded
// at their ids, upgradeable by a key made here, with the Pyth fixtures
// Anchor.toml lists, on rehearsal/validator.ts's own ports.
//
//   pnpm test:local                    every file in tests/
//   pnpm test:local tests/per-trade.ts one file
//
// It builds nothing: run `anchor build` first. The binary's sha256 is printed,
// so a green run names the bytes it proved.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { PACKAGE_DIR, SIP_VAULT_PROGRAM_ID, TOY_VENUE_PROGRAM_ID, pythFixtureAccounts, sha256File, startValidator } from "./validator";

async function main(): Promise<number> {
  const sipVault = join(PACKAGE_DIR, "target", "deploy", "sip_vault.so");
  const toyVenue = join(PACKAGE_DIR, "target", "deploy", "toy_venue.so");
  for (const path of [sipVault, toyVenue, join(PACKAGE_DIR, "target", "idl", "sip_vault.json")]) {
    if (!existsSync(path)) throw new Error(`${path} is missing: run anchor build first`);
  }
  console.log(`sip_vault.so sha256 ${sha256File(sipVault)}`);

  // The provider wallet is the genesis mint and both programs' upgrade
  // authority, as under anchor test: init_config checks the latter.
  const wallet = Keypair.generate();
  const validator = await startValidator({
    mint: wallet.publicKey,
    programs: [
      { id: SIP_VAULT_PROGRAM_ID, so: sipVault, authority: wallet.publicKey },
      { id: TOY_VENUE_PROGRAM_ID, so: toyVenue, authority: wallet.publicKey },
    ],
    accounts: pythFixtureAccounts(),
  });
  try {
    const files = process.argv.slice(2);
    const result = spawnSync(
      "npx",
      ["mocha", "--import=tsx", "--sort", "--exit", "-t", "180000", ...(files.length > 0 ? files : ["tests/**/*.ts"])],
      {
        cwd: PACKAGE_DIR,
        stdio: "inherit",
        env: { ...process.env, ANCHOR_PROVIDER_URL: validator.rpcUrl, ANCHOR_WALLET: validator.keyFile("provider-wallet", wallet) },
      },
    );
    return result.status ?? 1;
  } finally {
    const stopped = await validator.stop();
    console.log(`validator stopped: exited ${stopped.exited}, rpc refused ${stopped.rpcRefused}, temp dir gone ${stopped.dirGone}`);
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
