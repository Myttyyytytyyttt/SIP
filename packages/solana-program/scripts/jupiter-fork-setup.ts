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

import { Connection, Keypair, PACKET_DATA_SIZE, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildJupiterRoute,
  investAmountIn,
  investMinOut,
  JupiterRouteRefusal,
  routeWarning,
  v0TransactionBytes,
} from "./jupiter-route";

/**
 * WHERE PHASE 1 WRITES, resolved LAZILY rather than at module load. This file
 * is imported by the keeper's suite — type-only, so the typecheck gate covers
 * it, and for real by the venueFlags test — and `__dirname` does not exist
 * under the ESM transform vitest applies. Inside a function it is only touched
 * when phase 1 actually runs.
 */
function localDir(): string {
  return join(__dirname, ".local");
}
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

/**
 * The things the EXPERIMENT varies, taken from argv — not from the
 * environment, so a run is reproducible from the command line that is printed
 * with it:
 *
 *   --slippage <bps>   default 200
 *   --dexes <a,b,...>  the only venues allowed; default, Jupiter picks
 *   --exclude <a,b,..> venues to keep out; default Hadron, as jupiter-sim.ts
 *                      does, because every route built through it reverted
 *                      with that venue's own 0x3c under simulation — a route
 *                      that cannot execute is not worth a clone
 *
 * THE DEFAULT EXCLUSION APPLIES ONLY WHEN NOTHING IS PINNED, and that is not a
 * nicety — it is what keeps the documented command runnable. Jupiter's quote
 * endpoint refuses the two lists together, measured today:
 *
 *   GET /swap/v1/quote?...&dexes=Manifest&excludeDexes=Hadron
 *     -> HTTP 400 {"error":"Cannot set dexes and exclude dexes at the same time"}
 *
 * An earlier version of this file added the Hadron default unconditionally,
 * which made every `--dexes` run die at the API before it ever asked its
 * question — including the one this harness's own header documents. A pinned
 * allow-list already forecloses Hadron, so there is nothing to add; a run that
 * states BOTH flags is refused here, by name, instead of turning into
 * Jupiter's 400.
 *
 * WHY THE VENUE HAS TO BE PINNABLE. Whether a quote is gross or net belongs to
 * the AMM that makes the final transfer, and Jupiter re-picks it per quote. A
 * claim about a gross-quoting venue therefore cannot be tested by re-quoting
 * until one turns up; it has to be asked for. Measured 2026-09-20:
 * USDC -> FIGUREAI with `--dexes Manifest` is a ONE-HOP route on a
 * gross-quoting venue, which is exactly the leg this harness can clone.
 *
 * AND A PIN IS A REQUEST THE MARKET MAY NOT BE ABLE TO ANSWER. Re-run later
 * the same day, `--dexes Manifest` on that pair answered
 * {"error":"No routes found"}: Manifest no longer carried a direct
 * USDC -> FIGUREAI leg at that hour, while the unpinned quote routed through
 * Raydium CLMM. A NO_ROUTES_FOUND from a pinned run is the market moving, not
 * this harness breaking — see the note at the head of jupiter-fork.sh.
 */
export interface VenueFlags {
  readonly slippageBps: number;
  /** The only venues allowed. Empty means Jupiter picks. */
  readonly dexes: readonly string[];
  /** Venues kept out. Empty whenever `dexes` is non-empty; see above. */
  readonly excludeDexes: readonly string[];
}

/** Pure, and exported, so the command in the header is covered by a test. */
export function venueFlags(argv: readonly string[]): VenueFlags {
  const flag = (name: string): string | null => {
    const at = argv.indexOf(`--${name}`);
    return at === -1 ? null : argv[at + 1] ?? null;
  };
  const slippageBps = Number(flag("slippage") ?? 200);
  if (!Number.isInteger(slippageBps) || slippageBps < 0) throw new Error(`--slippage must be a whole number of bps`);
  const split = (value: string): readonly string[] =>
    value
      .split(",")
      .map((label) => label.trim())
      .filter((label) => label.length > 0);
  const dexes = split(flag("dexes") ?? "");
  const exclude = flag("exclude");
  if (dexes.length > 0 && exclude !== null) {
    throw new Error(
      "--dexes and --exclude cannot both be given: Jupiter answers " +
        '400 "Cannot set dexes and exclude dexes at the same time". An allow-list already excludes everything else.',
    );
  }
  return { slippageBps, dexes, excludeDexes: dexes.length > 0 ? [] : split(exclude ?? "Hadron") };
}

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
  const path = join(localDir(), name);
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
  const { slippageBps: SLIPPAGE_BPS, dexes: DEXES, excludeDexes: EXCLUDE_DEXES } = venueFlags(process.argv);
  mkdirSync(localDir(), { recursive: true });
  const programId = new PublicKey(
    JSON.parse(readFileSync(join(__dirname, "../target/idl/sip_vault.json"), "utf8")).address as string,
  );
  const connection = new Connection(MAINNET, "confirmed");

  const admin = persistedIdentity("jupiter-fork-admin.json");
  const owner = persistedIdentity("jupiter-fork-owner.json");
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), owner.publicKey.toBuffer()], programId);
  const vaultIn = getAssociatedTokenAddressSync(USDC, vault, true, TOKEN_PROGRAM_ID);
  const vaultTarget = getAssociatedTokenAddressSync(TARGET, vault, true, TOKEN_2022_PROGRAM_ID);

  console.log(
    `route: 5 USDC -> ${TARGET_NAME}, slippage ${SLIPPAGE_BPS} bps, ` +
      `${DEXES.length === 0 ? "venue picked by Jupiter" : `venue pinned to ${DEXES.join("/")}`}` +
      `${EXCLUDE_DEXES.length === 0 ? "" : ` (excluding ${EXCLUDE_DEXES.join("/")})`}, via lite-api.jup.ag`,
  );
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
      // This route is not signed against mainnet prices — it is cloned and
      // replayed on a local validator whose accounts are fetched right after.
      // The bound that matters here is that the capture is one coherent
      // moment, not that the price is current.
      maxAge: { maxAgeMs: 30_000 },
      // One hop or nothing: a multi-hop route needs lookup tables, and every
      // address they index would have to be cloned as well.
      onlyDirectRoutes: true,
      ...(DEXES.length === 0 ? {} : { dexes: DEXES }),
      ...(EXCLUDE_DEXES.length === 0 ? {} : { excludeDexes: EXCLUDE_DEXES }),
    });
  } catch (error) {
    if (error instanceof JupiterRouteRefusal) {
      console.error(`\nREFUSED (${error.condition}): ${error.message}`);
      console.error("The builder rejected this route; nothing was cloned and nothing was built.");
    }
    throw error;
  }

  // A CONDITION THE BUILDER SAW AND COULD NOT DECIDE. It is not a refusal —
  // whether the tolerance left after the transfer fee matters depends on which
  // AMM fills, which no build-time check knows — but a run that is about to
  // clone a gross-quoting venue on purpose should be told before it spends the
  // clone. See section (7) of jupiter-route.ts's header.
  const tolerance = routeWarning(route, "slippage-not-above-transfer-fee");
  if (tolerance !== null) console.log(`  WARNING     ${tolerance.condition}: ${tolerance.message}`);

  // WHAT THIS PROOF ACTUALLY NEEDS, MEASURED — and it is not a hop count, and
  // not the absence of a lookup table either. Phase 3 compiles its own message
  // with NO tables and the route's accounts written out in full, so a table in
  // Jupiter's response costs this harness nothing; measured today, the same
  // one-hop Manifest route came back with a table when Jupiter picked it and
  // without one when it was pinned, and both would replay identically. What
  // the harness cannot survive is the transaction not FITTING, so that is what
  // is checked, over the instruction phase 3 will really send.
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
  const [policyPda] = PublicKey.findProgramAddressSync([Buffer.from("invest"), vault.toBuffer()], programId);
  // MEASURED IN THE FORM PHASE 3 ACTUALLY SENDS, which is a v0 message: the
  // legacy form is two bytes smaller (the version prefix and the empty
  // address-table-lookup count), so predicting from it under-reported every
  // run — 951 B against 953 B sent, and 1,016 against 1,018 on the re-run.
  const investBytes = v0TransactionBytes(owner.publicKey, [
    // 5 bytes of SetComputeUnitLimit, as phase 3 sends.
    new TransactionInstruction({
      programId: new PublicKey("ComputeBudget111111111111111111111111111111"),
      keys: [],
      data: Buffer.alloc(5),
    }),
    new TransactionInstruction({
      programId,
      keys: [
        { pubkey: owner.publicKey, isSigner: true, isWritable: true }, // crank
        ...[configPda, vault, policyPda, vaultIn, vaultTarget, TARGET, route.venueProgram].map((pubkey) => ({
          pubkey,
          isSigner: false,
          isWritable: true,
        })),
        ...route.remainingAccounts,
      ],
      // 8 discriminator + leg_index u8 + amount_in u64 + min_out u64 + 4-byte vec length.
      data: Buffer.alloc(29 + route.venueData.length),
    }),
  ]);
  console.log(`  invest tx   : ${investBytes} B of ${PACKET_DATA_SIZE} as a v0 message (route alone, legacy, ${route.legacyBytes} B)`);
  if (investBytes > PACKET_DATA_SIZE) {
    throw new Error(
      `invest() wrapped around this ${route.hops}-hop route (${route.labels.join(" -> ")}) is ${investBytes} B, ` +
        `past the ${PACKET_DATA_SIZE} one transaction carries; phase 3 cannot send it without a lookup table it cannot clone`,
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

  writeFileSync(join(localDir(), "jupiter-vault-usdc.json"), JSON.stringify(fabricateUsdcAccount(vaultIn, vault, USDC_FUND), null, 1));
  writeFileSync(join(localDir(), "jupiter-clones.txt"), `${accounts.join("\n")}\n`);
  writeFileSync(join(localDir(), "jupiter-programs.txt"), `${programs.join("\n")}\n`);
  writeFileSync(
    join(localDir(), "jupiter-route.json"),
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        target: { name: TARGET_NAME, mint: TARGET.toBase58() },
        // WHAT THE VAULT WILL SPEND, AND WHAT THE ROUTE SAYS IT WILL, as two
        // separate fields. Phase 3 hands the first to invest() as amount_in;
        // the second is Jupiter's own number, recorded so the proof can show
        // they agree instead of assuming it. investAmountIn refuses if they
        // ever do not.
        requestedAmountIn: investAmountIn(route).toString(),
        instructionInAmount: route.amounts.inAmount.toString(),
        slippageBps: SLIPPAGE_BPS,
        dexes: DEXES,
        excludeDexes: EXCLUDE_DEXES,
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
        // THE SIBLING OF requestedAmountIn ABOVE, and the same reasoning:
        // investMinOut re-derives the number from the instruction's own tail
        // instead of copying a field, so a route assembled some other way
        // cannot put a min_out in this file that its bytes do not support.
        mainnetNetOfVenueThreshold: investMinOut(route).toString(),
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
  console.log(`  route alone : ${route.legacyBytes} B as a legacy transaction (${route.remainingAccounts.length} keys, ${route.venueData.length} B of data)`);
  if (route.lookupTableAddresses.length > 0) {
    console.log(`  tables      : ${route.lookupTableAddresses.length}, ignored — phase 3 writes every account out in full`);
  }
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

// Only when run directly: the keeper's suite imports this module (type-only
// for the typecheck gate, and for real to test venueFlags), and an import must
// not fire phase 1's network calls.
if (process.argv[1] !== undefined && process.argv[1].endsWith("jupiter-fork-setup.ts")) {
  main().catch((error) => {
    console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
