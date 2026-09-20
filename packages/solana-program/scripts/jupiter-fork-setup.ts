// Phase 1 of the JUPITER fork proof: pick a route on mainnet, work out exactly
// which mainnet accounts a local validator must clone to execute it, and
// fabricate the one account a clone can never mint.
//
// WHY A FORK AT ALL, WHEN jupiter-sim.ts ALREADY SIMULATED ON MAINNET. The
// mainnet simulation answered what JUPITER credits a destination account
// (net, and whether the quote was gross or net). It could not answer what
// OUR PROGRAM does with that credit, because invest() was never in the
// transaction: there is no vault on mainnet holding USDC, and lending the
// vault PDA's signature needs invoke_signed from inside sip_vault. So the
// simulation marked the authority slot as an outer signer and skipped us.
// This phase sets up the other half: the real sip_vault bytes, a real vault
// PDA that really cannot sign, and a real Jupiter route it must forward.
//
// THE ROUTE IS BUILT BY jupiter-route.ts, NOT BY HAND. Every refusal that
// guards production guards this proof too, so a route that would never be
// signed is never cloned either.
//
// Writes, all under scripts/.local (gitignored):
//   jupiter-fork-admin.json    persisted upgrade authority / protocol admin
//   jupiter-fork-owner.json    persisted vault owner
//   jupiter-vault-usdc.json    a pre-funded SPL USDC account owned by the vault
//   jupiter-route.json         the verified route, its numbers, its accounts
//   jupiter-clones.txt         plain mainnet accounts to --clone
//   jupiter-programs.txt       executables to --clone-upgradeable-program
//
// NO KEY THAT COULD SIGN ON MAINNET IS READ OR WRITTEN, and nothing is sent:
// the two keypairs below are freshly generated local test identities whose
// only funding is a local airdrop.

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildJupiterRoute, JupiterRouteRefusal } from "./jupiter-route";

const LOCAL = join(__dirname, ".local");
const MAINNET = process.env["MAINNET_RPC"] ?? "https://api.mainnet-beta.solana.com";

const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

/**
 * FIGUREAI, and 5 USD, are not arbitrary — they are the only combination that
 * makes this proof both meaningful and cloneable:
 *
 *   * the mint is Token-2022 WITH A TRANSFER FEE, which is the entire question
 *     (a fee-free leg like SPYx would prove nothing about net-versus-gross);
 *   * at 5 USD Jupiter routes it in ONE HOP through Raydium CLMM, so the whole
 *     thing fits a legacy transaction and needs no address lookup tables —
 *     an ALT would have to be cloned too, and every address it indexes with it;
 *   * Raydium CLMM is the venue scripts/fork.sh already clones successfully,
 *     so the cloneability of its pool state is not a new unknown.
 *
 * ANTHROPIC was the other fee leg and is deliberately not used here: it needs
 * 2-3 hops (Whirlpool -> Mercurial -> Manifest at 5 USD, measured 2026-09-20),
 * which is a versioned transaction, several AMM programs, and their lookup
 * tables. That is a bigger clone, not a different proof.
 */
const TARGET = new PublicKey("PreZad18qfPtbxNpMtMuAuX2zVpvkEU8DnJx56faCWd");
const TARGET_NAME = "FIGUREAI";
const AMOUNT_IN = 5_000_000n; // 5 USDC
const SLIPPAGE_BPS = 200;

/** Enough for several invests plus the deliberate failures, which spend nothing. */
const USDC_FUND = 200_000_000n; // 200 USDC

/**
 * Programs the test validator already carries at genesis. Cloning these would
 * at best be redundant and at worst shadow the runtime's own builtins.
 */
const BUILTIN = new Set<string>([
  TOKEN_PROGRAM_ID.toBase58(),
  TOKEN_2022_PROGRAM_ID.toBase58(),
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", // associated token account
  "11111111111111111111111111111111", // system
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "ComputeBudget111111111111111111111111111111",
  "Sysvar1nstructions1111111111111111111111111",
]);

function persistedIdentity(name: string): Keypair {
  const path = join(LOCAL, name);
  if (existsSync(path)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
  const kp = Keypair.generate();
  writeFileSync(path, JSON.stringify([...kp.secretKey]));
  return kp;
}

/**
 * An SPL Token account, byte for byte. A cloned validator holds USDC's mint
 * account but not its mint AUTHORITY, so USDC cannot be minted locally — the
 * vault's balance has to be injected at genesis through --account. Same
 * reasoning, and the same 165-byte layout, as scripts/fork-setup.ts.
 */
function fabricateUsdcAccount(address: PublicKey, owner: PublicKey, amount: bigint): unknown {
  const data = Buffer.alloc(165);
  USDC.toBuffer().copy(data, 0);
  owner.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  data.writeUInt8(1, 108); // AccountState::Initialized
  return {
    pubkey: address.toBase58(),
    account: {
      lamports: 2_039_280, // rent-exempt for 165 bytes
      data: [data.toString("base64"), "base64"],
      owner: TOKEN_PROGRAM_ID.toBase58(),
      executable: false,
      rentEpoch: 0,
    },
  };
}

async function main(): Promise<void> {
  mkdirSync(LOCAL, { recursive: true });
  const programId = new PublicKey(
    JSON.parse(readFileSync(join(__dirname, "../target/idl/sip_vault.json"), "utf8")).address as string,
  );
  const connection = new Connection(MAINNET, "confirmed");

  const admin = persistedIdentity("jupiter-fork-admin.json");
  const owner = persistedIdentity("jupiter-fork-owner.json");
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), owner.publicKey.toBuffer()], programId);
  const vaultIn = getAssociatedTokenAddressSync(USDC, vault, true, TOKEN_PROGRAM_ID);
  const vaultTarget = getAssociatedTokenAddressSync(TARGET, vault, true, TOKEN_2022_PROGRAM_ID);

  console.log(`route: 5 USDC -> ${TARGET_NAME}, slippage ${SLIPPAGE_BPS} bps, via lite-api.jup.ag`);
  let route;
  try {
    route = await buildJupiterRoute(connection, {
      vault,
      vaultIn,
      vaultTarget,
      inputMint: USDC,
      targetMint: TARGET,
      amountIn: AMOUNT_IN,
      slippageBps: SLIPPAGE_BPS,
      // One hop or nothing: a multi-hop route needs lookup tables, and every
      // address they index would have to be cloned as well.
      onlyDirectRoutes: true,
    });
  } catch (error) {
    if (error instanceof JupiterRouteRefusal) {
      console.error(`\nREFUSED (${error.condition}): ${error.message}`);
      console.error("The builder rejected this route; nothing was cloned and nothing was built.");
    }
    throw error;
  }

  if (route.requiresVersionedTransaction) {
    throw new Error(
      `route came back with ${route.hops} hops (${route.labels.join(" -> ")}); this proof only clones a single-hop route`,
    );
  }

  // Which accounts the local validator has to be given. The vault's own two
  // token accounts are excluded on purpose: vault_in is fabricated below and
  // vault_target is created against the local validator after boot, because
  // neither exists on mainnet and an ATA for a Token-2022 mint with extensions
  // is far safer created by the ATA program than assembled by hand here.
  const ours = new Set<string>([vault.toBase58(), vaultIn.toBase58(), vaultTarget.toBase58()]);
  // Array.from, not [...set]: this package's tsconfig targets ES6 with an
  // es2015 lib, under which spreading a Set widens its element type to unknown.
  const candidates = Array.from(
    new Set<string>(route.remainingAccounts.map((meta) => meta.pubkey.toBase58())),
  ).filter((key) => !ours.has(key) && !BUILTIN.has(key));

  const infos = await connection.getMultipleAccountsInfo(
    candidates.map((key) => new PublicKey(key)),
    "confirmed",
  );
  const programs: string[] = [];
  const accounts: string[] = [];
  const absent: string[] = [];
  infos.forEach((info, index) => {
    const key = candidates[index]!;
    // A non-existent account is a PDA the route only ever uses as a signer or
    // a seed (Jupiter's event authority is one); there is nothing to copy, and
    // --clone on it would abort the validator.
    if (info === null) absent.push(key);
    // --clone copies a program's account but NOT its executable data, which
    // leaves an unloadable program; --clone-upgradeable-program copies both.
    else if (info.executable) programs.push(key);
    else accounts.push(key);
  });

  writeFileSync(join(LOCAL, "jupiter-vault-usdc.json"), JSON.stringify(fabricateUsdcAccount(vaultIn, vault, USDC_FUND), null, 1));
  writeFileSync(join(LOCAL, "jupiter-clones.txt"), `${accounts.join("\n")}\n`);
  writeFileSync(join(LOCAL, "jupiter-programs.txt"), `${programs.join("\n")}\n`);
  writeFileSync(
    join(LOCAL, "jupiter-route.json"),
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        target: { name: TARGET_NAME, mint: TARGET.toBase58() },
        amountIn: AMOUNT_IN.toString(),
        slippageBps: SLIPPAGE_BPS,
        hops: route.hops,
        labels: route.labels,
        venueProgram: route.venueProgram.toBase58(),
        venueData: route.venueData.toString("base64"),
        remainingAccounts: route.remainingAccounts.map((meta) => ({
          pubkey: meta.pubkey.toBase58(),
          isSigner: meta.isSigner,
          isWritable: meta.isWritable,
        })),
        // Jupiter's own numbers, kept verbatim. The min_out this proof uses is
        // NOT taken from here: it is recomputed against the fee the LOCAL
        // validator's epoch puts in force, which is not mainnet's epoch.
        quotedOut: route.output.quotedOut.toString(),
        venueThreshold: route.output.venueThreshold.toString(),
        mainnetTransferFeeBps: route.output.transferFee.basisPoints,
        mainnetNetOfVenueThreshold: route.output.netOfVenueThreshold.toString(),
        vault: vault.toBase58(),
        vaultIn: vaultIn.toBase58(),
        vaultTarget: vaultTarget.toBase58(),
        admin: admin.publicKey.toBase58(),
        owner: owner.publicKey.toBase58(),
      },
      null,
      1,
    ),
  );

  console.log(`  hops        : ${route.hops} [${route.labels.join(" -> ")}]`);
  console.log(`  quoted out  : ${route.output.quotedOut}`);
  console.log(`  threshold   : ${route.output.venueThreshold}`);
  console.log(`  mainnet fee : ${route.output.transferFee.basisPoints} bps (epoch-dependent; local epoch may differ)`);
  console.log(`  route keys  : ${route.remainingAccounts.length} (${accounts.length} to clone, ${programs.length} programs, ${absent.length} absent)`);
  if (absent.length > 0) console.log(`  absent      : ${absent.join(", ")}`);
  console.log(`PROGRAM=${programId.toBase58()}`);
  console.log(`ADMIN=${admin.publicKey.toBase58()}`);
  console.log(`OWNER=${owner.publicKey.toBase58()}`);
  console.log(`VAULT=${vault.toBase58()}`);
  console.log(`VAULT_USDC=${vaultIn.toBase58()}`);
  console.log(`VAULT_TARGET=${vaultTarget.toBase58()}`);
}

main().catch((error) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
