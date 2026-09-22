// Does a real ANTHROPIC route fit in one transaction, and does it need tables?
//
// BUILT, NEVER SENT. This script holds no key, signs nothing and submits
// nothing: it asks Jupiter for a live quote, turns it into the very
// instructions invest_tick would send, and measures the three sizes that
// decide whether that send is possible at all —
//
//   legacy                  what invest-tick.ts built before 2026-09-21
//   v0, no lookup tables    the same accounts, versioned
//   v0, Jupiter's tables    what the keeper sends on a Jupiter venue
//
// against PACKET_DATA_SIZE (1,232 bytes), which is the whole question: a
// transaction over it cannot be sent at any price.
//
// WHY A SCRIPT AND NOT ONLY A TEST. The numbers belong to a live route, and a
// live route needs the network; test/invest-transaction.test.ts pins what this
// measured, offline, so the claim keeps being checked without one. Run this
// again when the route's shape is in doubt:
//
//   node_modules/.bin/tsx scripts/measure-route-size.mts
//   node_modules/.bin/tsx scripts/measure-route-size.mts --dump test/fixtures/anthropic-route.json
//
// The second form re-captures the fixture the test pins: the instruction this
// route really produced and the full contents of the tables it really named,
// so the test recompiles the same message the chain was offered.
//
// IT IS ALSO THE tsx PROOF. It reaches buildJupiterRoute and the transaction
// builders through src/program-scripts.ts — the same module graph
// `tsx bin/keeper.mts` loads — so a Jupiter name that does not survive the
// CommonJS/ESM unwrap fails here exactly as it would in production, which a
// vitest run cannot show (see program-scripts.ts, and docs/TESTING_TRAPS.md).

import { writeFileSync } from "node:fs";
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, PACKET_DATA_SIZE } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { idl } from "../src/idl.js";
import { budgetedInstructions, buildV0Transaction, investCall, lookupTablesOf, versionedTransactionBytes } from "../src/invest-tick.js";
import { SLIPPAGE_BPS } from "../src/min-out.js";
import { JUPITER_PROGRAM, buildJupiterRoute, investAmountIn, investMinOut, legacyTransactionBytes } from "../src/program-scripts.js";

// KEYLESS PUBLIC ENDPOINTS ONLY. This script is a measurement, not an
// operation: it must run for anyone reading the repository.
const RPC = "https://api.mainnet-beta.solana.com";

/** The owner's live vault, its policy, and the leg being measured. */
const VAULT = new PublicKey("EFXK995PV49Qz8xPSYMEUDBU5AKRR466JkgsfuGak5iU");
const POLICY = new PublicKey("8L6ifC8N4djEmPSajgFFSefnoW3Sm7EzdJSzeYemGX5D");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const ANTHROPIC = new PublicKey("Pren1FvFX6J3E4kXhJuCiAD5aDmGEb7qJRncwA8Lkhw");

/** $25, the size the 2026-09-20 basis runs used, in USDC's six decimals. */
const AMOUNT_IN = 25_000_000n;

const connection = new Connection(RPC, "confirmed");
const vaultIn = getAssociatedTokenAddressSync(USDC, VAULT, true, TOKEN_PROGRAM_ID);
const vaultTarget = getAssociatedTokenAddressSync(ANTHROPIC, VAULT, true, TOKEN_2022_PROGRAM_ID);

// A crank that exists only to be a public key: nothing here is signed, and the
// fee payer's IDENTITY is all a size measurement needs from it.
const crank = Keypair.generate();
const provider = new AnchorProvider(connection, {
  publicKey: crank.publicKey,
  signTransaction: async () => { throw new Error("this script signs nothing"); },
  signAllTransactions: async () => { throw new Error("this script signs nothing"); },
}, { commitment: "confirmed" });
const program = new Program(idl, provider);

const route = await buildJupiterRoute(connection, {
  vault: VAULT,
  vaultIn,
  vaultTarget,
  inputMint: USDC,
  targetMint: ANTHROPIC,
  amountIn: AMOUNT_IN,
  // STRICTLY ABOVE THE 100 bps TRANSFER FEE, measured: at 100 against 100 the
  // route reverts with Jupiter's 0x1771 at 5, 25 and 250 USD, and fills at 200.
  slippageBps: Number(SLIPPAGE_BPS),
  maxAge: { maxAgeMs: 60_000 },
});

// venue_data IS THE ROUTE'S OWN BLOB, not a hand-assembled swap record. This
// script passed a `swap` object until 2026-09-21 — a shape investCall stopped
// taking when the venue moved to Jupiter — and nothing noticed, because
// tsconfig.json included neither scripts/ nor this file and vitest collects
// neither. It is in the include list now, so the image's own typecheck is what
// keeps the advertised tsx proof from rotting again.
const invest = await investCall(
  program,
  { crank: crank.publicKey, vault: VAULT, policy: POLICY, vaultIn, vaultTarget, targetMint: ANTHROPIC, venueProgram: route.venueProgram },
  { legIndex: 0, amountIn: investAmountIn(route), minOut: investMinOut(route), venueData: route.venueData },
)
  .remainingAccounts(route.remainingAccounts.map((m) => ({ ...m, isSigner: false })))
  .instruction();

const instructions = budgetedInstructions([invest]);
const tableAddresses = lookupTablesOf(route);
const tables = (await Promise.all(tableAddresses.map((a) => connection.getAddressLookupTable(a))))
  .map(({ value }, index) => {
    if (value === null) throw new Error(`lookup table ${tableAddresses[index]!.toBase58()} is not on chain`);
    return value;
  });

// A PLACEHOLDER BLOCKHASH: 32 bytes whatever it says, and a size measurement
// that needed a fresh one would need the chain to agree to be measured.
const blockhash = PublicKey.default.toBase58();
const legacy = legacyTransactionBytes(crank.publicKey, instructions);
const v0Bare = versionedTransactionBytes(buildV0Transaction({ payer: crank.publicKey, recentBlockhash: blockhash, instructions, lookupTables: [] }));
const tabled = buildV0Transaction({ payer: crank.publicKey, recentBlockhash: blockhash, instructions, lookupTables: tables });
const v0Tabled = versionedTransactionBytes(tabled);
// THE ARITHMETIC CHECKS ITSELF against web3.js, on the one of the three that
// is small enough for web3.js to serialize at all.
const serialized = tabled.serialize().length;
if (serialized !== v0Tabled) throw new Error(`versionedTransactionBytes said ${v0Tabled}, serialize() said ${serialized}`);

const dumpAt = process.argv.indexOf("--dump");
if (dumpAt >= 0) {
  const path = process.argv[dumpAt + 1];
  if (path === undefined) throw new Error("--dump needs a path");
  writeFileSync(path, `${JSON.stringify({
    capturedAt: new Date().toISOString(),
    leg: "USDC -> ANTHROPIC",
    amountIn: AMOUNT_IN.toString(),
    slippageBps: Number(SLIPPAGE_BPS),
    hops: route.hops,
    labels: route.labels,
    payer: crank.publicKey.toBase58(),
    instruction: {
      programId: invest.programId.toBase58(),
      keys: invest.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
      data: invest.data.toString("base64"),
    },
    lookupTables: tables.map((table, index) => ({
      address: tableAddresses[index]!.toBase58(),
      addresses: table.state.addresses.map((a) => a.toBase58()),
    })),
    bytes: { legacy, v0NoTables: v0Bare, v0WithTables: v0Tabled },
  }, null, 2)}\n`, "utf8");
  console.error(`wrote ${path}`);
}

const fits = (bytes: number) => (bytes <= PACKET_DATA_SIZE ? "fits" : `OVER by ${bytes - PACKET_DATA_SIZE}`);
console.log(JSON.stringify({
  measuredAt: new Date().toISOString(),
  leg: "USDC -> ANTHROPIC",
  amountIn: AMOUNT_IN.toString(),
  slippageBps: Number(SLIPPAGE_BPS),
  hops: route.hops,
  labels: route.labels,
  venue: route.venueProgram.toBase58(),
  venueIsJupiter: route.venueProgram.equals(JUPITER_PROGRAM),
  routeAccounts: route.remainingAccounts.length,
  lookupTables: tableAddresses.map((a) => a.toBase58()),
  addressesInTables: tables.map((t) => t.state.addresses.length),
  packetLimit: PACKET_DATA_SIZE,
  bytes: { legacy, v0NoTables: v0Bare, v0WithTables: v0Tabled },
  verdict: { legacy: fits(legacy), v0NoTables: fits(v0Bare), v0WithTables: fits(v0Tabled) },
  warnings: route.warnings.map((w) => w.condition),
}, null, 2));
