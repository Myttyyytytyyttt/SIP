// Fetches a CURRENTLY-VALID swap route for a Raydium CLMM pool by reading the
// most recent real swap_v2 on it — the runtime version of the capture scripts.
//
// WHY NOT DERIVE THE TICK ARRAYS. They move with the price; a fixture captured
// yesterday points at arrays the pool may no longer cross, and deriving them
// needs the pool's tickCurrent + tickSpacing + the PDA math — more layout to
// pin. A swap that landed minutes ago PROVES its account list works at the
// current price. Prefer a swap in OUR direction (its arrays cover our path);
// accept the freshest of any direction as fallback for small sizes, where the
// active array is shared.

import { createHash } from "node:crypto";
import bs58 from "bs58";
import { Connection, PublicKey } from "@solana/web3.js";
import { RAYDIUM_CLMM, type SwapV2Pool } from "./raydium-swap";

const SWAP_V2_DISC = createHash("sha256").update("global:swap_v2").digest().subarray(0, 8).toString("hex");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

export interface LiveRoute extends SwapV2Pool {
  readonly capturedFrom: string;
  readonly directionMatched: boolean;
  /**
   * The price the captured swap ACTUALLY got, in raw units, taken from the
   * pool vaults' own balance deltas in that transaction — a market observation,
   * not a quote from anywhere.
   *
   * Null unless `directionMatched`. Inverting an opposite-direction swap's rate
   * would cross the spread and hand back an optimistic number, and an
   * optimistic bound on a slippage guard is worse than no bound at all: it
   * looks like protection.
   */
  readonly observed: { readonly inRaw: bigint; readonly outRaw: bigint } | null;
}

/**
 * The tick arrays the pool needs RIGHT NOW, derived from its own state.
 *
 * WHY NOT THE ONES IN THE COPIED SWAP. Everything else this file borrows from a
 * stranger's recent transaction is stable — the amm config, the vaults, the
 * observation account do not change. Tick arrays do: which one comes first is a
 * function of the pool's CURRENT tick, so a swap from an hour ago carries the
 * arrays that were right an hour ago. On 2026-08-27 the keeper's convert failed
 * with Raydium's InvalidFirstTickArrayAccount, "Left: -22140, Right: -22320" —
 * three arrays of drift between the borrowed route and the live price. Copying
 * them was always a bug waiting for the price to move.
 *
 * THE FIRST ONE IS THE ONE RAYDIUM CHECKS, and it is the array containing
 * `tick_current`. The rest are the next ones in the direction the swap pushes
 * the price: down when the input is token 0, up otherwise. Only arrays that
 * actually exist are passed — an uninitialised account would fail to
 * deserialise inside the CPI, which is a worse error than a short list.
 */
export async function liveTickArrays(
  connection: Connection,
  pool: PublicKey,
  inputMint: PublicKey,
): Promise<PublicKey[]> {
  const account = await connection.getAccountInfo(pool, "confirmed");
  if (account === null) throw new Error(`pool ${pool.toBase58()} does not exist`);
  const data = account.data;
  // Raydium CLMM PoolState, offsets counted so the arithmetic can be checked:
  // 8 disc, 1 bump, 32 ammConfig, 32 owner, 32 mint0, 32 mint1, 32 vault0,
  // 32 vault1, 32 observation, 1 dec0, 1 dec1 -> tickSpacing at 235,
  // liquidity(16) + sqrtPrice(16) -> tickCurrent at 269.
  if (data.length < 273) throw new Error(`pool ${pool.toBase58()} is not a CLMM pool state`);
  const mint0 = new PublicKey(data.subarray(73, 105));
  const tickSpacing = data.readUInt16LE(235);
  const tickCurrent = data.readInt32LE(269);
  if (tickSpacing === 0) throw new Error(`pool ${pool.toBase58()} reports a zero tick spacing`);

  const perArray = tickSpacing * TICK_ARRAY_SIZE;
  // Math.floor rounds toward -Infinity, which is what a tick array start index
  // needs: a naive truncation puts negative ticks in the array above their own.
  const start = Math.floor(tickCurrent / perArray) * perArray;
  // zeroForOne — input is token 0 — pushes the price DOWN, so the swap walks
  // into lower arrays; the other direction walks up.
  const step = inputMint.equals(mint0) ? -perArray : perArray;

  const wanted = [start, start + step, start + 2 * step];
  const addresses = wanted.map((index) => {
    // The start index is BIG-endian in the seed. Little-endian derives a
    // different, valid-looking address that simply is not this pool's array.
    const seed = Buffer.alloc(4);
    seed.writeInt32BE(index);
    return PublicKey.findProgramAddressSync([Buffer.from("tick_array"), pool.toBuffer(), seed], RAYDIUM_CLMM)[0];
  });

  const infos = await connection.getMultipleAccountsInfo(addresses, "confirmed");
  const live = addresses.filter((_, index) => infos[index] !== null);
  if (live.length === 0 || infos[0] === null) {
    throw new Error(
      `pool ${pool.toBase58()} has no initialised tick array at ${start} — the tick the pool reports has no liquidity`,
    );
  }
  return live;
}

/** Reads the freshest working route for `pool`, preferring inputMint-first. */
const TICK_ARRAY_SIZE = 60;

export async function fetchLiveRoute(
  connection: Connection,
  pool: PublicKey,
  inputMint: PublicKey,
  outputMint: PublicKey,
  outputTokenProgram: PublicKey,
): Promise<LiveRoute> {
  // A busy pool's newest signatures are mostly position churn and oracle
  // touches; the swaps are sparse among them. Walk back in pages until one
  // page yields a swap, bounded so a dead pool still errors promptly.
  const sigs: Awaited<ReturnType<typeof connection.getSignaturesForAddress>> = [];
  let before: string | undefined;
  for (let page = 0; page < 4; page++) {
    const batch = await connection.getSignaturesForAddress(pool, { limit: 15, before }, "confirmed");
    if (batch.length === 0) break;
    sigs.push(...batch);
    before = batch[batch.length - 1]!.signature;
  }
  let fallback: LiveRoute | null = null;
  let nulls = 0;

  for (const info of sigs) {
    if (info.err !== null) continue;
    // Public RPCs throttle hard; a paced walk beats a burst that dies on 429.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const tx = await connection.getTransaction(info.signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    if (!tx || !tx.meta) {
      nulls += 1;
      continue;
    }
    // keys.get() resolves static + lookup-table indexes in the canonical
    // order; a hand-rolled concat got the order wrong and silently resolved
    // program ids to the wrong accounts.
    const keys = tx.transaction.message.getAccountKeys({
      accountKeysFromLookups: tx.meta.loadedAddresses ?? undefined,
    });
    const candidates = [...tx.transaction.message.compiledInstructions];
    for (const inner of tx.meta.innerInstructions ?? []) {
      // Inner instructions arrive in a slightly different shape; normalise.
      for (const ix of inner.instructions) {
        candidates.push({
          programIdIndex: ix.programIdIndex,
          accountKeyIndexes: (ix as { accounts: number[] }).accounts,
          // Inner instruction data arrives BASE58-encoded in the RPC's json
          // encoding — decoding it as base64 silently never matches any
          // discriminator, which is exactly how this line failed first.
          data: Buffer.from(bs58.decode((ix as { data: string }).data)),
        } as never);
      }
    }
    for (const ix of candidates) {
      if (!keys.get(ix.programIdIndex)?.equals(RAYDIUM_CLMM)) continue;
      const data = Buffer.isBuffer(ix.data) ? ix.data : Buffer.from(ix.data);
      if (data.length < 41 || data.subarray(0, 8).toString("hex") !== SWAP_V2_DISC) continue;
      const accounts = ix.accountKeyIndexes.map((i) => keys.get(i)!);
      if (!accounts[2]?.equals(pool)) continue;

      const swapInputMint = accounts[11]!;
      const matched = swapInputMint.equals(inputMint);

      // What that swap paid and received, from the pool's own vaults.
      //
      // TRANSACTION-WIDE BALANCES ARE THE WHOLE TRANSACTION, not this
      // instruction. A tx containing two swaps on the same pool — an arbitrage
      // bundle, a router splitting an order, a sandwich — nets them together
      // and yields a rate that belongs to no single trade. Since this number
      // becomes the keeper's slippage bound, a poisoned observation is a
      // poisoned guard, and an attacker can choose what lands in a block.
      //
      // So the observation is only trusted when this transaction contains
      // EXACTLY ONE swap_v2 against this pool. Anything else falls back to the
      // policy floor and is reported as such — a bound we cannot justify is
      // worse than an admitted absence of one.
      const swapsOnThisPool = candidates.filter((other) => {
        if (!keys.get(other.programIdIndex)?.equals(RAYDIUM_CLMM)) return false;
        const otherData = Buffer.isBuffer(other.data) ? other.data : Buffer.from(other.data);
        if (otherData.length < 41 || otherData.subarray(0, 8).toString("hex") !== SWAP_V2_DISC) return false;
        return keys.get(other.accountKeyIndexes[2]!)?.equals(pool) === true;
      }).length;

      let observed: { inRaw: bigint; outRaw: bigint } | null = null;
      if (matched && swapsOnThisPool === 1) {
        const vaultIn = accounts[5]!.toBase58();
        const vaultOut = accounts[6]!.toBase58();
        const delta = (address: string): bigint => {
          const before = (tx.meta?.preTokenBalances ?? []).find(
            (b) => keys.get(b.accountIndex)?.toBase58() === address,
          );
          const after = (tx.meta?.postTokenBalances ?? []).find(
            (b) => keys.get(b.accountIndex)?.toBase58() === address,
          );
          return BigInt(after?.uiTokenAmount.amount ?? "0") - BigInt(before?.uiTokenAmount.amount ?? "0");
        };
        const gained = delta(vaultIn);
        const paid = -delta(vaultOut);
        if (gained > 0n && paid > 0n) observed = { inRaw: gained, outRaw: paid };
      }
      const route: LiveRoute = {
        ammConfig: accounts[1]!,
        poolState: pool,
        // A direction-matched swap's vaults are already (in, out); an opposite
        // swap's are flipped relative to ours.
        inputVault: matched ? accounts[5]! : accounts[6]!,
        outputVault: matched ? accounts[6]! : accounts[5]!,
        observationState: accounts[7]!,
        inputMint,
        outputMint,
        inputTokenProgram: TOKEN_PROGRAM,
        outputTokenProgram,
        tickArrays: accounts.slice(13),
        capturedFrom: info.signature,
        directionMatched: matched,
        observed,
      };
      // THE TICK ARRAYS ARE REPLACED, NOT BORROWED. Computed here, at the end
      // of the walk rather than the start, because the walk itself paces for
      // seconds and the price does not wait for it.
      if (matched) return { ...route, tickArrays: await liveTickArrays(connection, pool, inputMint) };
      fallback = fallback ?? route;
    }
  }
  if (fallback) return { ...fallback, tickArrays: await liveTickArrays(connection, pool, inputMint) };
  throw new Error(
    `no recent swap_v2 found on pool ${pool.toBase58()} ` +
      `(${sigs.length} sigs, ${nulls} unfetchable — a throttling RPC returns null without erroring; ` +
      "use a keyed RPC like Helius, or rerun in a minute)",
  );
}
