// Captures REAL account bytes for packages/web's decoder to be pinned against.
//
// The web reads Solana vaults with a hand-rolled decoder (no @solana/web3.js
// dependency there), and a hand-rolled decoder tested against hand-written
// bytes proves nothing — both copies would share the same misunderstanding. So
// this script has the REAL program write the accounts on a local validator and
// dumps their base64 exactly as any RPC will serve them. The web's
// check-solana-decode guard replays those bytes through its decoder and
// compares field by field against the values recorded here.
//
// Run from program/:  (validator running, program deployed)
//   npx tsx scripts/dump-fixtures.ts
//
// Output: ../../web/scripts/fixtures/solana-accounts.json

import * as anchor from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const OUT = join(__dirname, "../../../web/scripts/fixtures/solana-accounts.json");

async function main() {
  process.env.ANCHOR_PROVIDER_URL ??= "http://127.0.0.1:8899";
  process.env.ANCHOR_WALLET ??= `${process.env.HOME}/.config/solana/id.json`;
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.sipVault;

  const owner = provider.wallet.publicKey;
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), owner.toBuffer()],
    program.programId,
  );
  const tradingWallet = Keypair.generate();
  const [linkPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("link"), tradingWallet.publicKey.toBuffer()],
    program.programId,
  );

  // Values chosen to be non-symmetric, so a decoder that swaps two fields
  // cannot pass by luck: skim 3_777 bps, and a deposit that is not round.
  const SKIM_BPS = 3_777;
  const DEPOSIT = Math.floor(1.234567891 * LAMPORTS_PER_SOL);

  await program.methods.createVault(SKIM_BPS).accounts({ owner }).rpc();
  await program.methods
    .linkWallet()
    .accounts({ owner, wallet: tradingWallet.publicKey })
    .signers([tradingWallet])
    .rpc();
  await provider.sendAndConfirm(
    new Transaction().add(
      SystemProgram.transfer({ fromPubkey: owner, toPubkey: vaultPda, lamports: DEPOSIT }),
    ),
  );

  // A policy too, with NON-SYMMETRIC values for the same reason as the skim:
  // a decoder that swaps min/perCall or misreads the u128 must not pass by
  // luck. The mint is a throwaway pubkey — the policy stores it, nothing
  // dereferences it here.
  const [policyPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("invest"), vaultPda.toBuffer()],
    program.programId,
  );
  const legMint = Keypair.generate().publicKey;
  await program.methods
    .setInvestPolicy(
      [{ mint: legMint, weightBps: 10_000, minOutRateWad: new anchor.BN("1234567890123456") }],
      new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK"),
      new anchor.BN("98765432109876543"),
      new anchor.BN("1111111"),
      new anchor.BN("22222222"),
      new anchor.BN("333333333"),
      true,
    )
    .accountsPartial({ owner, vault: vaultPda, policy: policyPda })
    .rpc();

  const vaultInfo = await provider.connection.getAccountInfo(vaultPda);
  const linkInfo = await provider.connection.getAccountInfo(linkPda);
  const policyInfo = await provider.connection.getAccountInfo(policyPda);
  if (!vaultInfo || !linkInfo || !policyInfo) throw new Error("accounts not found after creation");

  const vaultState = await program.account.vault.fetch(vaultPda);
  const linkState = await program.account.tradingLink.fetch(linkPda);
  const policyState = await program.account.investmentPolicy.fetch(policyPda);

  const fixture = {
    _readme:
      "Captured by solana-lab/program/scripts/dump-fixtures.ts from a local validator. " +
      "The base64 is EXACTLY what getAccountInfo serves; `expected` is what the deployed " +
      "program's own client decoded. Regenerate after ANY change to state.rs.",
    capturedAt: new Date().toISOString(),
    programId: program.programId.toBase58(),
    vault: {
      address: vaultPda.toBase58(),
      lamports: vaultInfo.lamports,
      dataBase64: vaultInfo.data.toString("base64"),
      expected: {
        owner: vaultState.owner.toBase58(),
        version: vaultState.version,
        paused: vaultState.paused,
        skimBps: vaultState.skimBps,
        lifetimeSaved: vaultState.lifetimeSaved.toString(),
        createdAt: vaultState.createdAt.toString(),
      },
    },
    tradingLink: {
      address: linkPda.toBase58(),
      lamports: linkInfo.lamports,
      dataBase64: linkInfo.data.toString("base64"),
      expected: {
        wallet: linkState.wallet.toBase58(),
        vault: linkState.vault.toBase58(),
        epoch: linkState.epoch.toString(),
        settlementNonce: linkState.settlementNonce.toString(),
        frontierSlot: linkState.frontierSlot.toString(),
      },
    },
  };

  mkdirSync(dirname(OUT), { recursive: true });
  (fixture as Record<string, unknown>).policy = {
    _source: "local validator — regenerate-parity twin of the mainnet capture",
    address: policyPda.toBase58(),
    dataBase64: policyInfo.data.toString("base64"),
    expected: {
      vault: policyState.vault.toBase58(),
      enabled: policyState.enabled,
      venueProgram: policyState.venueProgram.toBase58(),
      legsLen: policyState.legs.length,
      leg0Mint: policyState.legs[0].mint.toBase58(),
      leg0WeightBps: policyState.legs[0].weightBps,
      leg0MinOutRateWad: policyState.legs[0].minOutRateWad.toString(),
      minConvertRateWad: policyState.minConvertRateWad.toString(),
      minInvestment: policyState.minInvestment.toString(),
      maxPerCall: policyState.maxPerCall.toString(),
      maxRolling30d: policyState.maxRolling30D.toString(),
      lifetimeInvested: policyState.lifetimeInvested.toString(),
      policyNonce: policyState.policyNonce.toString(),
    },
    // The web's builder pin (real mainnet instruction bytes) lives in
    // solana-mainnet-pin.json, which this script deliberately never writes:
    // regenerating local fixtures must not be able to delete a mainnet capture.
  };

  writeFileSync(OUT, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`fixtures written to ${OUT}`);
  console.log(`  vault ${vaultPda.toBase58()} (${vaultInfo.data.length} bytes)`);
  console.log(`  link  ${linkPda.toBase58()} (${linkInfo.data.length} bytes)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
