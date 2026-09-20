// Answers, on mainnet and by simulation, the one question the deployed
// program's guards cannot answer for us: does Jupiter quote GROSS or NET of a
// Token-2022 transfer fee, and therefore what min_out can invest() be handed
// without rejecting a good fill.
//
// WHY THIS CANNOT BE REASONED OUT. invest() measures `received` as the vault
// target account's balance delta around the CPI. A Token-2022 mint with a
// transfer fee credits the destination NET and parks the fee in the account's
// own withheld field, so the delta is net. Jupiter's `outAmount` and
// `otherAmountThreshold` are numbers about the swap, and whether they are
// before or after that withholding is a property of Jupiter's integrations,
// not of anything we control or can read off a struct. It is measurable, and
// that is all — so it is measured here, per leg and per size, and the whole
// rest of the venue switch rests on the answer.
//
// HOW THE MEASUREMENT IS MADE EXACT. The destination is a token account whose
// balance AND whose TransferFeeAmount.withheldAmount are both read before and
// after. The withheld delta is precisely the fee this one transfer paid, so
//     gross = credit + withheld
// is a decomposition, not an inference: if `gross` lands on Jupiter's quoted
// outAmount, Jupiter quoted gross; if `credit` does, it quoted net. No
// tolerance, no "about equal", nothing to argue with.
//
// NOTHING IS EVER SENT. Every transaction here is built unsigned, with
// zero-filled signature slots, and handed to simulateTransaction with
// sigVerify false and replaceRecentBlockhash true. There is no keypair in this
// file and no code path that could broadcast one.
//
// THE STAND-IN USER. A vault with no USDC cannot demonstrate a swap, and
// simulation will not invent a balance, so the swap is simulated as an
// EXISTING funded mainnet USDC holder — a plain system-owned wallet, verified
// at startup to hold the SOL and the USDC the run needs. It signs nothing: the
// simulator is told not to verify signatures. Its role is exactly the vault
// PDA's role in the real call, which is why the route is built through the same
// builder, with the same flags, and put through the same refusals.
//
// THE ONE DIFFERENCE FROM THE REAL CALL, stated plainly. invest() forwards the
// route as remaining_accounts and marks the vault PDA a signer for the inner
// CPI via invoke_signed; here there is no invest() wrapper, so the same slot —
// SLOT_USER_TRANSFER_AUTHORITY — is marked a signer in the OUTER instruction
// instead. It is the same single authority, lent the same way; everything else,
// every account and every byte of data, is what the builder returned.
//
// Run (reads and simulations only):
//   node_modules/.bin/tsx scripts/jupiter-sim.ts
//   node_modules/.bin/tsx scripts/jupiter-sim.ts --sizes 5,25,250 --legs ANTHROPIC
//   node_modules/.bin/tsx scripts/jupiter-sim.ts --json /tmp/sim.json

import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
  type SimulatedTransactionAccountInfo,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  getMint,
  getTransferFeeAmount,
  unpackAccount,
} from "@solana/spl-token";
import {
  SLOT_USER_TRANSFER_AUTHORITY,
  buildJupiterRoute,
  netOfTransferFee,
  readDestinationTransferFee,
  type DestinationTransferFee,
  type JupiterRoute,
  type TransferFeeRate,
} from "./jupiter-route";

const MAINNET = "https://api.mainnet-beta.solana.com";
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

/**
 * The three legs of the basket. SPYx carries NO transfer fee and is the
 * control: if the harness reported a fee there, the harness would be the thing
 * that is wrong.
 */
const LEGS: ReadonlyArray<{ readonly name: string; readonly mint: PublicKey }> = [
  { name: "SPYx", mint: new PublicKey("XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W") },
  { name: "ANTHROPIC", mint: new PublicKey("Pren1FvFX6J3E4kXhJuCiAD5aDmGEb7qJRncwA8Lkhw") },
  { name: "FIGUREAI", mint: new PublicKey("PreZad18qfPtbxNpMtMuAuX2zVpvkEU8DnJx56faCWd") },
];

/** USD, converted with USDC's six decimals. */
const DEFAULT_SIZES = [5, 25, 250];
const DEFAULT_SLIPPAGE_BPS = 100;

/**
 * A funded mainnet USDC holder, used ONLY as the swap's user in simulation.
 * Discovered by reading recent USDC transactions, not from any key material:
 * a system-owned wallet, 0.47 SOL, ~34,200 USDC on 2026-09-20. Overridable
 * with --user; every assumption about it is re-checked at startup, so a
 * spent-down wallet fails loudly instead of quietly simulating nothing.
 */
const DEFAULT_USER = new PublicKey("62Q9eeDY3eM8A5CnprBGYMPShdBjAzdpBdr71QHsS8dS");

/** The measured 2-hop route burns ~90k CU; this is headroom, not a guess. */
const COMPUTE_UNITS = 600_000;

/** lite-api.jup.ag tolerates about 30 requests a minute, and each leg makes two. */
const JUPITER_PACING_MS = 2_500;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Args {
  readonly user: PublicKey;
  readonly sizes: readonly number[];
  readonly legs: readonly string[];
  readonly slippageBps: number;
  readonly rpc: string;
  readonly json: string | null;
  /** Ask Jupiter for single-hop routes only — the knob that changes which AMM fills the last hop. */
  readonly onlyDirect: boolean;
  readonly excludeDexes: readonly string[];
}

function parseArgs(argv: readonly string[]): Args {
  const get = (flag: string): string | null => {
    const at = argv.indexOf(flag);
    return at >= 0 && at + 1 < argv.length ? argv[at + 1]! : null;
  };
  const legs = get("--legs");
  const sizes = get("--sizes");
  const user = get("--user");
  const slippage = get("--slippage");
  return {
    user: user === null ? DEFAULT_USER : new PublicKey(user),
    sizes: sizes === null ? DEFAULT_SIZES : sizes.split(",").map((s) => Number(s.trim())),
    legs: legs === null ? LEGS.map((leg) => leg.name) : legs.split(",").map((s) => s.trim()),
    slippageBps: slippage === null ? DEFAULT_SLIPPAGE_BPS : Number(slippage),
    rpc: get("--rpc") ?? MAINNET,
    json: get("--json"),
    onlyDirect: argv.includes("--direct"),
    // EXCLUDED BECAUSE IT CANNOT BE MEASURED, AND CANNOT BE USED. Every route
    // Jupiter built through Hadron on 2026-09-20 reverted with that venue's own
    // error 0x3c inside simulateTransaction — both fee legs, all three sizes,
    // and again with the compute limit raised to 1.4M, with nothing in
    // otherInstructions that we had dropped. A venue whose swap does not
    // simulate is a venue this vault cannot use at all, because Privy
    // simulates before the policy runs. Pass `--exclude ""` to put it back and
    // watch the rows fail; the failures name the program that said no.
    excludeDexes: (get("--exclude") ?? "Hadron").split(",").map((s) => s.trim()).filter((s) => s.length > 0),
  };
}

/** Raw units of a token account, read the way venue_route.rs reads them. */
function decodeSimulatedAccount(
  address: PublicKey,
  account: SimulatedTransactionAccountInfo | null,
): { readonly amount: bigint; readonly withheld: bigint } {
  if (account === null) return { amount: 0n, withheld: 0n };
  // The RPC returns [payload, encoding]; a node that answered in some other
  // shape has not told us the balance, and a zero here would read as "the
  // swap credited nothing" — the exact wrong answer to the exact question.
  const encoded = account.data[0];
  if (encoded === undefined) {
    throw new Error(`the simulator returned ${address.toBase58()} without base64 data`);
  }
  const data = Buffer.from(encoded, "base64");
  const unpacked = unpackAccount(
    address,
    { data, owner: new PublicKey(account.owner), lamports: account.lamports, executable: account.executable, rentEpoch: 0 },
    new PublicKey(account.owner),
  );
  const withheld = getTransferFeeAmount(unpacked);
  return { amount: unpacked.amount, withheld: withheld === null ? 0n : withheld.withheldAmount };
}

async function readTokenAccount(
  connection: Connection,
  address: PublicKey,
): Promise<{ readonly amount: bigint; readonly withheld: bigint }> {
  const info = await connection.getAccountInfo(address, "confirmed");
  if (info === null) return { amount: 0n, withheld: 0n };
  const unpacked = unpackAccount(address, info, info.owner);
  const withheld = getTransferFeeAmount(unpacked);
  return { amount: unpacked.amount, withheld: withheld === null ? 0n : withheld.withheldAmount };
}

export interface LegMeasurement {
  readonly leg: string;
  readonly mint: string;
  readonly usd: number;
  readonly amountIn: bigint;
  readonly hops: number;
  readonly labels: readonly string[];
  /** Jupiter's outAmount, verbatim. */
  readonly quotedOut: bigint;
  /** Jupiter's otherAmountThreshold, verbatim. */
  readonly venueThreshold: bigint;
  /** What the destination account's balance ACTUALLY rose by in simulation. */
  readonly credit: bigint;
  /** What Token-2022 withheld on that same transfer. */
  readonly withheld: bigint;
  /** credit + withheld: the money the venue actually delivered. */
  readonly grossDelivered: bigint;
  /**
   * What the source USDC account fell by between the pre-read and the
   * simulated post-state.
   *
   * INDICATIVE ONLY, AND IT SAYS SO. The destination is a fresh account nobody
   * else touches, so its delta is exactly this swap's credit. The source is a
   * LIVE third party's wallet whose balance moves between the two reads, so a
   * deviation here measures other people's transactions, not ours. An ExactIn
   * swap spends exactly `amountIn` by construction — Jupiter encodes it in the
   * instruction — so `spent != amountIn` is the contamination, not a finding
   * about the route.
   */
  readonly spent: bigint;
  readonly feeCurrent: TransferFeeRate;
  readonly feeWorstCase: TransferFeeRate;
  /** The AMM that made the FINAL transfer — the one the fee is taken on. */
  readonly lastHop: string;
  readonly computeUnits: number | null;
  readonly txBytes: number;
}

/**
 * Which hypothesis this row's fill actually matches.
 *
 * The comparison is against the PRICE DRIFT, not against zero: a quote and a
 * simulation are taken at different slots, and an orderbook leg moves between
 * them. The two hypotheses are a whole transfer fee apart — 50 or 100 bps —
 * while the drift measured here is under a basis point, so they never come
 * close to being confusable. Both drifts are printed so that stops being a
 * claim and starts being something the reader can check.
 */
export type QuoteBasis = "gross" | "net" | "no-fee";

export function classify(row: LegMeasurement): {
  readonly basis: QuoteBasis;
  readonly grossDriftBps: number;
  readonly creditDriftBps: number;
} {
  const bps = (actual: bigint, quoted: bigint): number => (Number(actual - quoted) / Number(quoted)) * 10_000;
  const grossDriftBps = bps(row.grossDelivered, row.quotedOut);
  const creditDriftBps = bps(row.credit, row.quotedOut);
  if (row.feeCurrent.basisPoints === 0) return { basis: "no-fee", grossDriftBps, creditDriftBps };
  const basis = Math.abs(grossDriftBps) <= Math.abs(creditDriftBps) ? "gross" : "net";
  return { basis, grossDriftBps, creditDriftBps };
}

/**
 * The largest min_out that cannot reject an honest fill, under BOTH
 * hypotheses at once.
 *
 * The venue's own guarantee is otherAmountThreshold, and Jupiter enforces it
 * inside the CPI — a fill below it reverts there, before our guard ever runs.
 * So min_out does not have to reproduce the venue's bound; it only has to not
 * fire on a fill the venue accepted. The worst such fill credits the vault:
 *   - threshold - fee(threshold)   if the quote was GROSS,
 *   - threshold                     if the quote was NET.
 * The first is smaller, so it is the one to use — for every leg, whichever
 * basis that leg's route happens to quote in today.
 */
export function safeMinOut(venueThreshold: bigint, fee: TransferFeeRate): bigint {
  return netOfTransferFee(venueThreshold, fee);
}

async function measureLeg(
  connection: Connection,
  args: Args,
  leg: { readonly name: string; readonly mint: PublicKey },
  usd: number,
  fee: DestinationTransferFee,
  lookupTableCache: Map<string, AddressLookupTableAccount>,
): Promise<LegMeasurement> {
  const amountIn = BigInt(Math.round(usd * 1_000_000));
  const source = getAssociatedTokenAddressSync(USDC, args.user, true, TOKEN_PROGRAM_ID);
  const destination = getAssociatedTokenAddressSync(leg.mint, args.user, true, TOKEN_2022_PROGRAM_ID);

  // EVERYTHING THAT CAN BE READ BEFORE THE QUOTE IS READ BEFORE THE QUOTE.
  // A quote describes a market at a moment, and the fill it is compared against
  // should be as near that moment as the network allows — so the balances are
  // read first, the lookup tables are cached across rows, and there is no
  // getLatestBlockhash at all, because replaceRecentBlockhash makes the
  // simulator supply its own.
  //
  // THIS WAS NOT WHAT FIXED HADRON, and the note is here so nobody re-derives
  // a cause that was already ruled out: shortening this window changed nothing
  // about that venue's 0x3c, and neither did raising the compute limit from
  // 400k to 1.4M. Those routes are excluded instead. What the short window
  // does buy is smaller drift between the quoted number and the credited one,
  // which is the difference the whole file is measuring.
  const before = await Promise.all([readTokenAccount(connection, destination), readTokenAccount(connection, source)]);

  // THE SAME BUILDER, THE SAME REFUSALS, THE SAME FLAGS. A JupiterRouteRefusal
  // here is a row that does not measure, and it SHOULD be: a route the builder
  // would not hand to invest() is not a route whose fill tells us anything
  // about invest().
  const route: JupiterRoute = await buildJupiterRoute(connection, {
    vault: args.user,
    vaultIn: source,
    vaultTarget: destination,
    inputMint: USDC,
    targetMint: leg.mint,
    amountIn,
    slippageBps: args.slippageBps,
    ...(args.onlyDirect ? { onlyDirectRoutes: true } : {}),
    excludeDexes: args.excludeDexes,
    // The current epoch's rate, so the reported prediction is about the fill we
    // are about to simulate. The worst case is reported separately, alongside.
    useWorstCaseTransferFee: false,
  });

  const keys = route.remainingAccounts.map((meta, index) => ({
    pubkey: meta.pubkey,
    isWritable: meta.isWritable,
    // The one difference from invest(), and it is invest()'s own difference:
    // the program lends the vault PDA's signature to exactly this slot.
    isSigner: index === SLOT_USER_TRANSFER_AUTHORITY,
  }));
  const swap = new TransactionInstruction({ programId: route.venueProgram, keys, data: route.venueData });

  const lookupTables: AddressLookupTableAccount[] = [];
  for (const address of route.lookupTableAddresses) {
    const cached = lookupTableCache.get(address.toBase58());
    if (cached !== undefined) {
      lookupTables.push(cached);
      continue;
    }
    const fetched = await connection.getAddressLookupTable(address, { commitment: "confirmed" });
    if (fetched.value !== null) {
      lookupTableCache.set(address.toBase58(), fetched.value);
      lookupTables.push(fetched.value);
    }
  }

  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS }),
    // invest() requires vault_target to already exist; in simulation the
    // stand-in user's ATA may not, so it is created idempotently here. It is
    // setup, not route: the swap instruction below is untouched.
    createAssociatedTokenAccountIdempotentInstruction(
      args.user,
      destination,
      args.user,
      leg.mint,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    ),
    swap,
  ];
  // A PLACEHOLDER, and deliberately one: replaceRecentBlockhash tells the
  // simulator to substitute its own, so asking the RPC for one would only add
  // a round trip between the quote and the fill it is meant to describe.
  const message = new TransactionMessage({
    payerKey: args.user,
    recentBlockhash: PublicKey.default.toBase58(),
    instructions,
  }).compileToV0Message(lookupTables);
  const transaction = new VersionedTransaction(message);

  const simulation = await connection.simulateTransaction(transaction, {
    // NOT SIGNED, AND NOT SENDABLE. Both flags are what make an unsigned
    // transaction executable in the simulator and nowhere else.
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: "confirmed",
    accounts: { encoding: "base64", addresses: [destination.toBase58(), source.toBase58()] },
  });

  if (simulation.value.err !== null) {
    // NAME THE PROGRAM THAT SAID NO. "Custom(60)" on its own is unattributable
    // — it could be Jupiter, an AMM, or the token program — and a row that
    // cannot be attributed cannot be acted on.
    const logs = simulation.value.logs ?? [];
    const failed = logs.filter((line) => / failed: /.test(line)).map((line) => line.replace(/^Program /, ""));
    const culprit = failed.length > 0 ? failed[0]! : "no program reported a failure";
    throw new Error(
      `${leg.name} ${usd} USD simulation reverted: ${JSON.stringify(simulation.value.err)} — ${culprit}` +
        ` [route ${route.labels.join(" > ")}]\n    ${logs.slice(-12).join("\n    ")}`,
    );
  }

  const after = [
    decodeSimulatedAccount(destination, simulation.value.accounts?.[0] ?? null),
    decodeSimulatedAccount(source, simulation.value.accounts?.[1] ?? null),
  ];
  const credit = after[0]!.amount - before[0]!.amount;
  const withheld = after[0]!.withheld - before[0]!.withheld;

  return {
    leg: leg.name,
    mint: leg.mint.toBase58(),
    usd,
    amountIn,
    hops: route.hops,
    labels: route.labels,
    quotedOut: route.output.quotedOut,
    venueThreshold: route.output.venueThreshold,
    credit,
    withheld,
    grossDelivered: credit + withheld,
    spent: before[1]!.amount - after[1]!.amount,
    feeCurrent: fee.current,
    feeWorstCase: fee.worstCase,
    lastHop: route.labels[route.labels.length - 1] ?? "?",
    computeUnits: simulation.value.unitsConsumed ?? null,
    txBytes: transaction.serialize().length,
  };
}

const units = (raw: bigint, decimals: number): string =>
  (Number(raw) / 10 ** decimals).toLocaleString("en-US", { maximumFractionDigits: decimals });

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const connection = new Connection(args.rpc, "confirmed");

  const epoch = await connection.getEpochInfo("confirmed");
  const hoursLeft = ((epoch.slotsInEpoch - epoch.slotIndex) * 0.4) / 3600;
  console.log(`rpc       ${args.rpc}`);
  console.log(`epoch     ${epoch.epoch} (slot ${epoch.slotIndex}/${epoch.slotsInEpoch}, ~${hoursLeft.toFixed(2)} h to ${epoch.epoch + 1})`);

  // The stand-in user is checked, not assumed: a wallet that has moved on
  // should stop the run, not silently make every row a revert.
  const userInfo = await connection.getAccountInfo(args.user, "confirmed");
  if (userInfo === null) throw new Error(`stand-in user ${args.user.toBase58()} does not exist`);
  const source = getAssociatedTokenAddressSync(USDC, args.user, true, TOKEN_PROGRAM_ID);
  const sourceBalance = (await readTokenAccount(connection, source)).amount;
  const needed = BigInt(Math.round(Math.max(...args.sizes) * 1_000_000));
  console.log(
    `user      ${args.user.toBase58()} (${(userInfo.lamports / 1e9).toFixed(4)} SOL, ${units(sourceBalance, 6)} USDC in ${source.toBase58()})`,
  );
  if (sourceBalance < needed) {
    throw new Error(`stand-in user holds ${units(sourceBalance, 6)} USDC, the largest size needs ${units(needed, 6)}`);
  }
  console.log(
    `slippage  ${args.slippageBps} bps    sizes ${args.sizes.join(", ")} USD` +
      (args.excludeDexes.length > 0 ? `    excluding ${args.excludeDexes.join(", ")}` : "") +
      "\n",
  );

  const lookupTableCache = new Map<string, AddressLookupTableAccount>();
  const rows: LegMeasurement[] = [];
  const failures: { leg: string; usd: number; reason: string }[] = [];
  const decimals = new Map<string, number>();
  const fees = new Map<string, DestinationTransferFee>();

  for (const leg of LEGS.filter((candidate) => args.legs.includes(candidate.name))) {
    const fee = await readDestinationTransferFee(connection, leg.mint);
    fees.set(leg.name, fee);
    const mint = await getMint(connection, leg.mint, "confirmed", TOKEN_2022_PROGRAM_ID);
    decimals.set(leg.name, mint.decimals);
    console.log(
      `${leg.name.padEnd(10)} ${leg.mint.toBase58()}  decimals ${mint.decimals}  ` +
        `fee now ${fee.current.basisPoints} bps` +
        (fee.pending === null ? "" : `, ${fee.pending.basisPoints} bps from epoch ${fee.pending.epoch}`),
    );
    for (const usd of args.sizes) {
      await sleep(JUPITER_PACING_MS);
      // A leg that reverts is a result, not a crash. A venue can refuse a size
      // (a thin direct pool), a quote can go stale between the build and the
      // simulation, and either one killing an eight-row run would throw away
      // the seven rows that DID measure something. The row is reported with
      // its reason and left out of the verdict.
      let row: LegMeasurement;
      try {
        row = await measureLeg(connection, args, leg, usd, fee, lookupTableCache);
      } catch (error: unknown) {
        failures.push({ leg: leg.name, usd, reason: error instanceof Error ? error.message : String(error) });
        console.log(`  ${String(usd).padStart(4)} USD  NOT MEASURED: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`);
        continue;
      }
      rows.push(row);
      const d = mint.decimals;
      console.log(
        `  ${String(usd).padStart(4)} USD  ${row.hops} hop  ${row.labels.join(" > ").padEnd(24)}  ` +
          `quoted ${row.quotedOut.toString().padStart(13)}  threshold ${row.venueThreshold.toString().padStart(13)}  ` +
          `credit ${row.credit.toString().padStart(13)}  withheld ${row.withheld.toString().padStart(10)}  ` +
          `spent ${
            row.spent === row.amountIn
              ? "exact"
              : `${row.spent > row.amountIn ? "+" : ""}${row.spent - row.amountIn} vs amount_in (live wallet moved)`
          }  ` +
          `(${units(row.credit, d)} ${leg.name}, ${row.computeUnits ?? "?"} CU, ${row.txBytes} B)`,
      );
    }
  }

  // ---------------------------------------------------------------------
  // The verdict, computed from the rows rather than asserted.
  // ---------------------------------------------------------------------
  console.log("\n  leg / size      last hop         quoted out   actual credit     withheld   credit+withheld   gross drift   credit drift   basis");
  const classified = rows.map((row) => ({ row, ...classify(row) }));
  for (const { row, basis, grossDriftBps, creditDriftBps } of classified) {
    console.log(
      `  ${(row.leg + " " + row.usd).padEnd(15)} ${row.lastHop.padEnd(14)} ${row.quotedOut.toString().padStart(12)} ` +
        `${row.credit.toString().padStart(15)} ${row.withheld.toString().padStart(12)} ${row.grossDelivered.toString().padStart(17)} ` +
        `${grossDriftBps.toFixed(3).padStart(13)} ${creditDriftBps.toFixed(3).padStart(14)}   ${basis.toUpperCase()}`,
    );
  }

  if (failures.length > 0) {
    console.log(`\n  ${failures.length} row(s) did not measure:`);
    for (const failure of failures) console.log(`    ${failure.leg} ${failure.usd} USD — ${failure.reason.split("\n")[0]}`);
  }

  const feeRows = classified.filter((entry) => entry.row.feeCurrent.basisPoints > 0);
  const grossRows = feeRows.filter((entry) => entry.basis === "gross");
  const netRows = feeRows.filter((entry) => entry.basis === "net");
  console.log(
    `\nVERDICT   ${rows.length} fills simulated, ${feeRows.length} on a mint with a transfer fee.` +
      `\n          quoted GROSS (vault is credited a fee LESS than outAmount): ${grossRows.length} ` +
      `[${[...new Set(grossRows.map((entry) => `${entry.row.leg} via ${entry.row.lastHop}`))].join(", ") || "none"}]` +
      `\n          quoted NET   (vault is credited outAmount exactly):         ${netRows.length} ` +
      `[${[...new Set(netRows.map((entry) => `${entry.row.leg} via ${entry.row.lastHop}`))].join(", ") || "none"}]`,
  );
  if (grossRows.length > 0 && netRows.length > 0) {
    console.log(
      "          THE BASIS IS NOT A PROPERTY OF THE MINT. It tracks the AMM that makes the final\n" +
        "          transfer, and Jupiter re-picks that per quote, per size, per moment. A min_out rule\n" +
        "          that reads the basis off the leg is a rule that breaks the day the route moves.",
    );
  }

  // What each candidate min_out does to the venue's OWN worst allowed fill —
  // which is the question, not what it does to the lucky fill we happened to
  // simulate. Jupiter reverts inside the CPI below otherAmountThreshold, so a
  // fill AT the threshold is the worst one our guard will ever be shown.
  console.log("\nThe worst fill the venue still allows, and what each candidate min_out does to it:");
  console.log("  leg / size      threshold   worst credit if GROSS   worst credit if NET   min_out=threshold   min_out=net(threshold)");
  for (const row of rows) {
    const worstIfGross = netOfTransferFee(row.venueThreshold, row.feeWorstCase);
    const worstIfNet = row.venueThreshold;
    const safe = safeMinOut(row.venueThreshold, row.feeWorstCase);
    const verdictFor = (minOut: bigint): string =>
      worstIfGross >= minOut && worstIfNet >= minOut ? "survives" : "REVERTS FillTooSmall";
    console.log(
      `  ${(row.leg + " " + row.usd).padEnd(15)} ${row.venueThreshold.toString().padStart(12)} ` +
        `${worstIfGross.toString().padStart(23)} ${worstIfNet.toString().padStart(21)}   ` +
        `${verdictFor(row.venueThreshold).padEnd(19)} ${verdictFor(safe)} (${safe})`,
    );
  }
  console.log(
    `\nmin_out RULE  min_out = otherAmountThreshold - ceil(otherAmountThreshold * feeBps / 10_000),` +
      `\n              with feeBps read from the DESTINATION mint at the epoch the transaction will LAND` +
      `\n              (worst case of current and pending). That is jupiter-route.ts's` +
      `\n              output.netOfVenueThreshold. It survives both bases, so it never depends on which` +
      `\n              AMM Jupiter picked, and it gives up nothing real: Jupiter already enforces the` +
      `\n              threshold inside the CPI, so our guard is a backstop, not the slippage bound.`,
  );

  if (args.json !== null) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      args.json,
      JSON.stringify(
        { epoch: epoch.epoch, user: args.user.toBase58(), slippageBps: args.slippageBps, onlyDirect: args.onlyDirect, rows, failures },
        (_key, value) => (typeof value === "bigint" ? value.toString() : value),
        2,
      ),
    );
    console.log(`\nwrote ${args.json}`);
  }
}

// Only when run directly: importing this file for its types must not fire
// eighteen network calls.
if (process.argv[1] !== undefined && process.argv[1].endsWith("jupiter-sim.ts")) {
  main().catch((error: unknown) => {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}

export { measureLeg };
