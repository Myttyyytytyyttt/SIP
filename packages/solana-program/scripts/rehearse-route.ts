// REHEARSAL: proves fetchLiveRoute's derived route against real mainnet swaps.
//
// READ-ONLY. It builds no transaction, holds no keypair, and never calls a
// send: the only RPC methods it uses are getAccountInfo, getMultipleAccounts,
// getSignaturesForAddress and getTransaction. Run it before trusting a change
// to live-route.ts.
//
// WHAT IT CHECKS, per pool: the route fetchLiveRoute derives from the pool
// account, against one real recent swap_v2 on that same pool — every account
// the swap used, side by side with ours, plus the rate that swap actually got
// against the rate we would have quoted. A route that borrowed its accounts
// from a swap could not be checked this way at all; it agreed with its source
// by construction. This one has to earn it.
//
// THE TWO RATES ARE PUT IN THE SAME TERMS FIRST. Our quote is what a TAKER'S
// OWN ACCOUNT sees: gross in, net out, every Token-2022 transfer fee taken off.
// A real fill measured at the pool's vaults is the other way round — the input
// vault gained what survived the fee, the output vault paid before it — so the
// fee both mints charge is read from chain and the measured pair is converted
// back to the taker's side of it. Comparing the two raw would show a 50 bps gap
// on the PreStock pools that is nothing but this.
//
// WHY IT READS VERSION 1. The pools SaverFi trades are full of version-1
// transactions — 51 of 60 on SPYx the night this was written — and web3.js
// THROWS rather than returning null when asked for one above its stated
// maxSupportedTransactionVersion. That throw is what used to kill invest turns.
// Here the ceiling is raised so the survey sees the traffic that is really
// there rather than the tenth of it that is version 0.
//
//   pnpm --filter @sip/solana-program exec tsx scripts/rehearse-route.ts
//   …             …               … scripts/rehearse-route.ts "SPYx/USDC"

import { createHash } from "node:crypto";
import bs58 from "bs58";
import { Connection, PublicKey } from "@solana/web3.js";
import { RAYDIUM_CLMM } from "./raydium-swap";
import { feeInForce, fetchLiveRoute, transferFeeSchedule, type LiveRoute } from "./live-route";

const RPC = process.env.SIP_SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const SWAP_V2_DISC = createHash("sha256").update("global:swap_v2").digest().subarray(0, 8).toString("hex");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");

/** The four pools the keeper routes through, and the direction it goes. */
const POOLS = [
  { name: "SOL/USDC", pool: "3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv", input: WSOL, output: USDC },
  { name: "SPYx/USDC", pool: "6truu3rZuiB9rKQg4VYC3Dt3QwV7DgwGqXrYUcrvnDDE", input: USDC, output: new PublicKey("XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W") },
  { name: "ANTHROPIC/USDC", pool: "47MsbowAJnPPt6jgSGLK4hdCtKqRRcKT5pTFHPV7WBPt", input: USDC, output: new PublicKey("Pren1FvFX6J3E4kXhJuCiAD5aDmGEb7qJRncwA8Lkhw") },
  { name: "FIGUREAI/USDC", pool: "HvpDt29EdGcKkFMLkUgvAJDP5oDFLaYG4jnVZnRsHduM", input: USDC, output: new PublicKey("PreZad18qfPtbxNpMtMuAuX2zVpvkEU8DnJx56faCWd") },
] as const;

/** Public RPC throttles; every read that is not the route itself is paced. */
const PACE_MS = 420;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface RealSwap {
  readonly signature: string;
  readonly version: string;
  readonly accounts: readonly PublicKey[];
  readonly inputIsMint0: boolean;
  /** Null when the transaction holds more than one swap on this pool: a netted rate belongs to no single trade. */
  readonly realized: { readonly inRaw: bigint; readonly outRaw: bigint } | null;
}

/** The newest real swap_v2 on `pool`, preferring one in the keeper's direction. */
async function findRealSwap(
  connection: Connection,
  pool: PublicKey,
  mint0: PublicKey,
  wantInputIsMint0: boolean,
  budget: number,
): Promise<{ swap: RealSwap | null; read: number; failed: number; threw: number; versions: Record<string, number> }> {
  let before: string | undefined;
  let read = 0;
  let failed = 0;
  let threw = 0;
  const versions: Record<string, number> = {};
  let anyDirection: RealSwap | null = null;

  for (let page = 0; page < 8 && read < budget; page++) {
    const batch = await connection.getSignaturesForAddress(pool, { limit: 100, before }, "confirmed");
    if (batch.length === 0) break;
    before = batch[batch.length - 1]!.signature;
    for (const info of batch) {
      if (read >= budget) break;
      if (info.err !== null) {
        failed += 1;
        continue;
      }
      read += 1;
      await sleep(PACE_MS);
      let tx;
      try {
        // Version 1 is real traffic on these pools; a ceiling of 0 throws on it.
        tx = await connection.getTransaction(info.signature, { maxSupportedTransactionVersion: 1, commitment: "confirmed" });
      } catch {
        threw += 1;
        continue;
      }
      if (!tx || !tx.meta) continue;
      versions[String(tx.version)] = (versions[String(tx.version)] ?? 0) + 1;
      const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses ?? undefined });
      const candidates: { programIdIndex: number; accountKeyIndexes: number[]; data: Buffer }[] =
        tx.transaction.message.compiledInstructions.map((ix) => ({
          programIdIndex: ix.programIdIndex,
          accountKeyIndexes: [...ix.accountKeyIndexes],
          data: Buffer.from(ix.data),
        }));
      for (const inner of tx.meta.innerInstructions ?? []) {
        for (const ix of inner.instructions) {
          candidates.push({
            programIdIndex: ix.programIdIndex,
            accountKeyIndexes: [...(ix as unknown as { accounts: number[] }).accounts],
            // Inner instruction data is BASE58 in the RPC's json encoding.
            data: Buffer.from(bs58.decode((ix as unknown as { data: string }).data)),
          });
        }
      }
      const swapsHere = candidates.filter(
        (ix) =>
          keys.get(ix.programIdIndex)?.equals(RAYDIUM_CLMM) === true &&
          ix.data.length >= 41 &&
          ix.data.subarray(0, 8).toString("hex") === SWAP_V2_DISC &&
          keys.get(ix.accountKeyIndexes[2]!)?.equals(pool) === true,
      );
      for (const ix of swapsHere) {
        const accounts = ix.accountKeyIndexes.map((i) => keys.get(i)!);
        const inputIsMint0 = accounts[11]!.equals(mint0);
        // The vaults' own balance deltas, and only when this transaction holds
        // exactly one swap on this pool: an arbitrage bundle or a split order
        // nets two trades into a rate that belongs to neither.
        let realized: { inRaw: bigint; outRaw: bigint } | null = null;
        if (swapsHere.length === 1) {
          const delta = (address: PublicKey): bigint => {
            const at = (list: typeof tx.meta.preTokenBalances) =>
              (list ?? []).find((b) => keys.get(b.accountIndex)?.equals(address));
            return (
              BigInt(at(tx.meta!.postTokenBalances)?.uiTokenAmount.amount ?? "0") -
              BigInt(at(tx.meta!.preTokenBalances)?.uiTokenAmount.amount ?? "0")
            );
          };
          const gained = delta(accounts[5]!);
          const paid = -delta(accounts[6]!);
          if (gained > 0n && paid > 0n) realized = { inRaw: gained, outRaw: paid };
        }
        const swap: RealSwap = { signature: info.signature, version: String(tx.version), accounts, inputIsMint0, realized };
        if (inputIsMint0 === wantInputIsMint0) return { swap, read, failed, threw, versions };
        anyDirection = anyDirection ?? swap;
      }
    }
  }
  return { swap: anyDirection, read, failed, threw, versions };
}

const same = (a: PublicKey | undefined, b: PublicKey | undefined): boolean => a !== undefined && b !== undefined && a.equals(b);
const short = (key: PublicKey): string => `${key.toBase58().slice(0, 8)}…`;

/** Rate in output-raw per 1e9 input-raw, for a readable side-by-side. */
const per1e9 = (rate: { readonly inRaw: bigint; readonly outRaw: bigint }): bigint =>
  (1_000_000_000n * rate.outRaw) / rate.inRaw;

async function main(): Promise<void> {
  const only = process.argv[2];
  const connection = new Connection(RPC, "confirmed");
  console.log(`rehearsing routes against ${RPC}`);
  console.log(`READ-ONLY: no transaction is built or sent.`);
  // The epoch decides which of a mint's two fee schedules is in force, so it is
  // read once and printed: a rehearsal run either side of an issuer's change
  // should say plainly which side it was on.
  const epoch = BigInt((await connection.getEpochInfo()).epoch);
  console.log(`epoch ${epoch}\n`);
  const verdicts: string[] = [];

  /** What the mint takes out of a transfer of itself, right now. */
  const feeBpsOf = (mint: PublicKey, account: { readonly owner: PublicKey; readonly data: Buffer }): number => {
    const schedule = transferFeeSchedule(mint, account);
    return schedule === null ? 0 : feeInForce(schedule, epoch);
  };

  for (const entry of POOLS) {
    if (only !== undefined && only !== entry.name) continue;
    const pool = new PublicKey(entry.pool);
    console.log(`━━ ${entry.name}  ${entry.pool}`);

    // The output mint's own program, read from chain rather than assumed:
    // the legs are Token-2022 and USDC is not.
    const outputMintAccount = await connection.getAccountInfo(entry.output, "confirmed");
    if (outputMintAccount === null) throw new Error(`${entry.name}: the output mint does not exist`);
    const outputTokenProgram = outputMintAccount.owner;
    const outputFeeBps = feeBpsOf(entry.output, outputMintAccount);
    await sleep(PACE_MS);
    const inputMintAccount = await connection.getAccountInfo(entry.input, "confirmed");
    if (inputMintAccount === null) throw new Error(`${entry.name}: the input mint does not exist`);
    const inputFeeBps = feeBpsOf(entry.input, inputMintAccount);

    const started = Date.now();
    let route: LiveRoute;
    try {
      route = await fetchLiveRoute(connection, pool, entry.input, entry.output, outputTokenProgram);
    } catch (error) {
      console.log(`   VERDICT: FAIL — the route could not be built: ${(error as Error).message}\n`);
      verdicts.push(`${entry.name}: FAIL (route)`);
      continue;
    }
    const elapsed = Date.now() - started;
    console.log(`   route built in ${(elapsed / 1000).toFixed(2)} s from ${route.capturedFrom}`);
    console.log(`   in ${short(route.inputMint)} -> out ${short(route.outputMint)}  (output program ${short(outputTokenProgram)})`);
    console.log(`   ammConfig ${short(route.ammConfig)}  inputVault ${short(route.inputVault)}  outputVault ${short(route.outputVault)}  observation ${short(route.observationState)}`);
    console.log(`   transfer fee at epoch ${epoch}: ${inputFeeBps} bps in, ${outputFeeBps} bps out`);
    console.log(`   remaining accounts: ${route.tickArrays.map(short).join(" ")}`);

    // Which way round the pool is, so the real swap can be compared in its own
    // direction rather than ours.
    const poolAccount = (await connection.getAccountInfo(pool, "confirmed"))!;
    const mint0 = new PublicKey(poolAccount.data.subarray(73, 105));
    const keeperInputIsMint0 = entry.input.equals(mint0);

    await sleep(PACE_MS);
    const found = await findRealSwap(connection, pool, mint0, keeperInputIsMint0, 40);
    console.log(
      `   survey: ${found.read} successful signatures read, ${found.failed} failed ones skipped, ` +
        `${found.threw} unreadable, versions ${JSON.stringify(found.versions)}`,
    );
    if (found.swap === null) {
      console.log(`   VERDICT: INCONCLUSIVE — no real swap_v2 found to compare against\n`);
      verdicts.push(`${entry.name}: INCONCLUSIVE (no swap)`);
      continue;
    }
    const swap = found.swap;
    const aligned = swap.inputIsMint0 === keeperInputIsMint0;
    console.log(`   compared with ${swap.signature.slice(0, 20)}… (version ${swap.version}, ${aligned ? "same" : "opposite"} direction)`);

    // OUR ROUTE FOR THAT SWAP'S DIRECTION. When the freshest real swap runs the
    // other way, the honest comparison is against the route we would build for
    // ITS direction, not an inversion of ours that crosses the spread twice.
    let mine = route;
    if (!aligned) {
      await sleep(PACE_MS);
      // The reverse leg pays out whatever the keeper puts IN — wSOL or USDC,
      // both classic SPL Token — so the output program flips to that one.
      mine = await fetchLiveRoute(connection, pool, entry.output, entry.input, TOKEN_PROGRAM);
    }

    const checks: [string, boolean, string][] = [
      ["ammConfig", same(mine.ammConfig, swap.accounts[1]), `${short(mine.ammConfig)} vs ${short(swap.accounts[1]!)}`],
      ["poolState", same(mine.poolState, swap.accounts[2]), `${short(mine.poolState)} vs ${short(swap.accounts[2]!)}`],
      ["inputVault", same(mine.inputVault, swap.accounts[5]), `${short(mine.inputVault)} vs ${short(swap.accounts[5]!)}`],
      ["outputVault", same(mine.outputVault, swap.accounts[6]), `${short(mine.outputVault)} vs ${short(swap.accounts[6]!)}`],
      ["observationState", same(mine.observationState, swap.accounts[7]), `${short(mine.observationState)} vs ${short(swap.accounts[7]!)}`],
      ["inputMint", same(mine.inputMint, swap.accounts[11]), `${short(mine.inputMint)} vs ${short(swap.accounts[11]!)}`],
      ["outputMint", same(mine.outputMint, swap.accounts[12]), `${short(mine.outputMint)} vs ${short(swap.accounts[12]!)}`],
    ];

    // The bitmap extension: ours must be the account that swap carried, when it
    // carried one at all.
    const extension = PublicKey.findProgramAddressSync(
      [Buffer.from("pool_tick_array_bitmap_extension"), pool.toBuffer()],
      RAYDIUM_CLMM,
    )[0];
    const theirExtensionAt = swap.accounts.findIndex((key) => key.equals(extension));
    const ourExtensionAt = mine.tickArrays.findIndex((key) => key.equals(extension));
    checks.push([
      "bitmapExtension",
      ourExtensionAt === 0,
      theirExtensionAt === -1
        ? `we pass it first; that swap passed none`
        : `we pass it at remaining[0] (account [13]); that swap passed it at account [${theirExtensionAt}]`,
    ]);

    // The tick arrays are NOT expected to equal that swap's: they follow the
    // live tick, and that swap ran at whatever tick it found. What must hold is
    // that the first one we pass is the array holding the CURRENT tick.
    const tickSpacing = poolAccount.data.readUInt16LE(235);
    const tickCurrent = poolAccount.data.readInt32LE(269);
    const perArray = tickSpacing * 60;
    const startSeed = Buffer.alloc(4);
    startSeed.writeInt32BE(Math.floor(tickCurrent / perArray) * perArray);
    const currentArray = PublicKey.findProgramAddressSync([Buffer.from("tick_array"), pool.toBuffer(), startSeed], RAYDIUM_CLMM)[0];
    const firstArray = mine.tickArrays[ourExtensionAt === 0 ? 1 : 0];
    const overlap = mine.tickArrays.filter((key) => swap.accounts.slice(13).some((k) => k.equals(key))).length;
    checks.push([
      "firstTickArray",
      same(firstArray, currentArray),
      `${firstArray === undefined ? "none" : short(firstArray)} holds tick ${tickCurrent} (spacing ${tickSpacing}); ${overlap} of ${mine.tickArrays.length} accounts also in that swap`,
    ]);

    for (const [name, ok, detail] of checks) console.log(`     ${ok ? "OK  " : "FAIL"} ${name.padEnd(17)} ${detail}`);

    // The price: our net quote against what that swap's taker really got.
    let priceLine = "no single-swap fill to compare (that transaction held more than one swap on this pool)";
    let priceOk = true;
    if (swap.realized !== null && mine.observed !== null) {
      // The fees on the direction that swap actually ran, which is the direction
      // `mine` was built for.
      const feeIn = BigInt(aligned ? inputFeeBps : outputFeeBps);
      const feeOut = BigInt(aligned ? outputFeeBps : inputFeeBps);
      // Back to the taker's own side of both fees: the input vault gained what
      // survived the fee on the way in, the output vault paid before the fee on
      // the way out.
      const takerIn = (swap.realized.inRaw * 10_000n) / (10_000n - feeIn);
      const takerOut = (swap.realized.outRaw * (10_000n - feeOut)) / 10_000n;
      const ours = per1e9(mine.observed);
      const theirs = per1e9({ inRaw: takerIn, outRaw: takerOut });
      const gapBps = theirs === 0n ? 0n : ((ours - theirs) * 10_000n) / theirs;
      priceOk = gapBps > -500n && gapBps < 500n;
      priceLine =
        `ours ${ours} out-raw per 1e9 in-raw, that fill's taker got ${theirs} ` +
        `(vaults moved ${per1e9(swap.realized)}, ${feeIn}/${feeOut} bps of transfer fee either side) — ` +
        `${gapBps >= 0n ? "+" : ""}${gapBps} bps (ours is a mid price net of fees; a real fill also pays impact)`;
    } else if (mine.observed === null) {
      priceOk = false;
      priceLine = "FAIL — the route quoted no rate at all";
    }
    console.log(`     ${priceOk ? "OK  " : "FAIL"} ${"price".padEnd(17)} ${priceLine}`);

    const accountsOk = checks.every(([, ok]) => ok);
    const verdict = accountsOk && priceOk ? "PASS" : "FAIL";
    console.log(`   VERDICT: ${verdict}\n`);
    verdicts.push(`${entry.name}: ${verdict} (route in ${(elapsed / 1000).toFixed(2)} s)`);
  }

  console.log("━━ summary");
  for (const line of verdicts) console.log(`   ${line}`);
  if (verdicts.some((line) => line.includes("FAIL"))) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
