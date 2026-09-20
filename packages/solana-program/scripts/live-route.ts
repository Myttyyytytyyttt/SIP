// Builds a CURRENTLY-VALID swap route for a Raydium CLMM pool by reading the
// POOL'S OWN ACCOUNT — two RPC calls, no transaction history at all.
//
// WHAT THIS REPLACED, AND WHY. Until 2026-09-20 this file borrowed the route
// from a stranger's recent swap: it walked the pool's last 60 signatures in
// four pages, paused 1.2 s between getTransaction calls, and copied the amm
// config, the vaults and the observation account out of the first swap_v2 it
// recognised. Measured on mainnet that night:
//
//  * SOL/USDC 3ucNos4Nbum… — 618 signatures walked, 518 of them FAILED
//    transactions (84 %); the 60 signatures the walk actually read were about
//    six seconds of that pool. Three of five walks found no swap at all and
//    threw; the two that finished took 52-58 s, and one of those found only an
//    opposite-direction swap, so `observed` came back null and the convert went
//    out with min_out at the loose policy floor.
//  * SPYx/USDC 6truu3rZui… — 51 of 60 successful transactions are VERSION 1,
//    and the walk asked getTransaction with maxSupportedTransactionVersion: 0.
//    web3.js does not return null for those, it THROWS SolanaJSONRPCError, and
//    nothing caught it: the first read killed the turn. Six invest turns died
//    that way before one got through.
//
// None of that bought anything. liveTickArrays() already read the pool account
// on every single route, and every field the walk was copying is IN that
// account: ammConfig at 9, the vaults at 137 and 169, the observation at 201.
// Checked against 240 real swap_v2 instructions across the four pools SaverFi
// trades (60 each), the accounts derived here equal the accounts those swaps
// really used — 240 of 240 for the amm config, both vaults, the observation
// account and the mint pair. So the walk was paying minutes, and sometimes the
// whole turn, for bytes it already had.
//
// WHAT IS NO LONGER BORROWED, AND WHAT THAT COSTS. The old `observed` rate was
// what one real swap actually got, measured from the pool vaults' balance
// deltas. That is gone with the walk; the reference price is now the pool's own
// sqrt price, net of the fee its AmmConfig charges. This is NOT a stronger
// guarantee than the fill it replaces — a price read before a transaction is
// sent is still a price that can move, or be moved, before it lands — but it is
// never null and never minutes stale, and those were the two ways the old
// number failed in practice. min-out.ts keeps the 2 % tolerance around it, and
// the policy floor is still the hard bound underneath.

import { Connection, PublicKey } from "@solana/web3.js";
import { RAYDIUM_CLMM, type SwapV2Pool } from "./raydium-swap";

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

export interface LiveRoute extends SwapV2Pool {
  /** Where the route came from, for logs. Now always the pool's own state. */
  readonly capturedFrom: string;
  /**
   * Whether the route is oriented the way the caller asked.
   *
   * ALWAYS TRUE NOW, and kept only so callers and their logs do not change.
   * It used to mean "the swap we copied happened to run in our direction",
   * which was a property of a stranger's trade and false often enough to matter.
   * A route built from the pool's own state is built for the requested
   * direction or it throws, so there is no second case left to report.
   */
  readonly directionMatched: boolean;
  /**
   * The reference rate, as a raw-in / raw-out pair: the pool's current price
   * net of its own trade fee. min-out.ts turns it into the keeper's slippage
   * bound.
   *
   * Typed nullable because the LiveRoute shape is public and callers already
   * branch on null; this implementation never returns null.
   *
   * IT IS A MID PRICE, NOT A QUOTE. It ignores the price impact of our own
   * size, so it is very slightly optimistic — on the pools SaverFi trades, at
   * the $500 per-purchase cap, between 0,002 % and 0,36 %, all of it inside the
   * 2 % tolerance min-out.ts already applies. What it is NOT is a defence
   * against a sandwich: an attacker who moves the pool before this read moves
   * this number with it. The floor the owner signed is what stands underneath.
   */
  readonly observed: { readonly inRaw: bigint; readonly outRaw: bigint } | null;
}

// ── Raydium CLMM PoolState, 1544 bytes ────────────────────────────────────────
// Offsets counted so the arithmetic can be checked: 8 disc, 1 bump, 32 ammConfig,
// 32 owner, 32 mint0, 32 mint1, 32 vault0, 32 vault1, 32 observation, 1 dec0,
// 1 dec1 -> tickSpacing at 235, liquidity(16) + sqrtPrice(16) -> tickCurrent at
// 269. All read off mainnet on 2026-09-20 for the four pools SaverFi trades;
// packages/solana-core/src/client/clmm-price.ts decodes the price fields of the
// same account for the web's floors.
export const POOL_STATE_BYTES = 1544;
const POOL_STATE_DISCRIMINATOR = "f7ede3f5d7c3de46";
const AMM_CONFIG_AT = 9;
const MINT0_AT = 73;
const MINT1_AT = 105;
const VAULT0_AT = 137;
const VAULT1_AT = 169;
const OBSERVATION_AT = 201;
const TICK_SPACING_AT = 235;
const SQRT_PRICE_AT = 253;
const TICK_CURRENT_AT = 269;

// ── Raydium CLMM AmmConfig, 117 bytes ─────────────────────────────────────────
// 8 disc, 1 bump, 2 index, 32 owner, 4 protocolFeeRate -> tradeFeeRate at 47,
// then tickSpacing at 51. The denominator is 1e6: the four pools read 400, 1000,
// 2500 and 10000, i.e. 0,04 %, 0,10 %, 0,25 % and 1,00 %, which is exactly what
// those venues advertise.
const AMM_CONFIG_BYTES = 117;
const AMM_CONFIG_DISCRIMINATOR = "daf42168cbcb2b6f";
const TRADE_FEE_RATE_AT = 47;
const CONFIG_TICK_SPACING_AT = 51;
const FEE_DENOMINATOR = 1_000_000n;

const TICK_ARRAY_SIZE = 60;
const Q128 = 1n << 128n;

/** u128 little-endian, the way both Raydium and clmm-price.ts store one. */
function u128At(data: Buffer, at: number): bigint {
  let value = 0n;
  for (let i = 15; i >= 0; i--) value = (value << 8n) | BigInt(data[at + i]!);
  return value;
}

interface PoolState {
  readonly ammConfig: PublicKey;
  readonly mint0: PublicKey;
  readonly mint1: PublicKey;
  readonly vault0: PublicKey;
  readonly vault1: PublicKey;
  readonly observation: PublicKey;
  readonly tickSpacing: number;
  readonly sqrtPriceX64: bigint;
  readonly tickCurrent: number;
}

/**
 * The pool account's fields, with the account's OWNER checked.
 *
 * Bytes alone cannot say who wrote them: any program can create a 1544-byte
 * account whose first eight bytes are Raydium's discriminator, and a route
 * built from one would hand a swap to accounts an attacker chose. The owner
 * check is the part that makes the rest of this file safe to trust.
 */
function decodePoolState(pool: PublicKey, owner: PublicKey, data: Buffer): PoolState {
  if (!owner.equals(RAYDIUM_CLMM)) {
    throw new Error(`pool ${pool.toBase58()} is owned by ${owner.toBase58()}, not Raydium CLMM`);
  }
  if (data.length !== POOL_STATE_BYTES) {
    throw new Error(`pool ${pool.toBase58()} is ${data.length} bytes, a Raydium CLMM pool is ${POOL_STATE_BYTES}`);
  }
  if (data.subarray(0, 8).toString("hex") !== POOL_STATE_DISCRIMINATOR) {
    throw new Error(`pool ${pool.toBase58()} is not a Raydium CLMM PoolState`);
  }
  const tickSpacing = data.readUInt16LE(TICK_SPACING_AT);
  if (tickSpacing === 0) throw new Error(`pool ${pool.toBase58()} reports a zero tick spacing`);
  const sqrtPriceX64 = u128At(data, SQRT_PRICE_AT);
  if (sqrtPriceX64 === 0n) throw new Error(`pool ${pool.toBase58()} reports a zero sqrt price`);
  return {
    ammConfig: new PublicKey(data.subarray(AMM_CONFIG_AT, AMM_CONFIG_AT + 32)),
    mint0: new PublicKey(data.subarray(MINT0_AT, MINT0_AT + 32)),
    mint1: new PublicKey(data.subarray(MINT1_AT, MINT1_AT + 32)),
    vault0: new PublicKey(data.subarray(VAULT0_AT, VAULT0_AT + 32)),
    vault1: new PublicKey(data.subarray(VAULT1_AT, VAULT1_AT + 32)),
    observation: new PublicKey(data.subarray(OBSERVATION_AT, OBSERVATION_AT + 32)),
    tickSpacing,
    sqrtPriceX64,
    tickCurrent: data.readInt32LE(TICK_CURRENT_AT),
  };
}

/**
 * The tick arrays a swap out of `inputMint` would cross, newest state, and the
 * pool's tick-array bitmap extension.
 *
 * THE FIRST ARRAY IS THE ONE RAYDIUM CHECKS, and it is the array containing
 * `tick_current`. The rest are the next ones in the direction the swap pushes
 * the price: down when the input is token 0, up otherwise. On 2026-08-27 a
 * convert failed with Raydium's InvalidFirstTickArrayAccount, "Left: -22140,
 * Right: -22320" — three arrays of drift between a route copied from an old
 * transaction and the live price. They are computed, never copied.
 */
function tickArrayAddresses(pool: PublicKey, state: PoolState, inputIsMint0: boolean): PublicKey[] {
  const perArray = state.tickSpacing * TICK_ARRAY_SIZE;
  // Math.floor rounds toward -Infinity, which is what a tick array start index
  // needs: a naive truncation puts negative ticks in the array above their own.
  const start = Math.floor(state.tickCurrent / perArray) * perArray;
  // zeroForOne — input is token 0 — pushes the price DOWN, so the swap walks
  // into lower arrays; the other direction walks up.
  const step = inputIsMint0 ? -perArray : perArray;
  return [start, start + step, start + 2 * step].map((index) => {
    // The start index is BIG-endian in the seed. Little-endian derives a
    // different, valid-looking address that simply is not this pool's array.
    const seed = Buffer.alloc(4);
    seed.writeInt32BE(index);
    return PublicKey.findProgramAddressSync([Buffer.from("tick_array"), pool.toBuffer(), seed], RAYDIUM_CLMM)[0];
  });
}

/**
 * The pool's tick-array bitmap extension account.
 *
 * WHY IT IS IN THE ROUTE AT ALL. The 1024 bits the pool carries at offset 904
 * only cover the ticks near the middle of the range; a pool whose price has
 * walked far from where it started keeps the rest of its map here, and a swap
 * that has to search past the default bitmap cannot find the next initialised
 * tick without it. Every route this file built before 2026-09-20 omitted it.
 *
 * WHERE IT GOES. First in remaining accounts, i.e. account [13] of swap_v2,
 * ahead of the tick arrays. That is where 210 of the 240 real swaps surveyed
 * put it (SPYx 60/60, SOL/USDC 56/60, ANTHROPIC 48/60, FIGUREAI 46/60); the
 * other 30 put it one or three slots later, and 2 ANTHROPIC swaps left it out
 * entirely. First is both the commonest convention and Raydium's own SDK's.
 *
 * AN EMPTY EXTENSION IS STILL PASSED. SPYx's holds no set bits at all and its
 * swaps carry it regardless — an extension with nothing in it answers "no
 * initialised ticks out here", which is an answer, and the account has to be
 * present for the program to read it. It is left out only when it does not
 * exist on chain, which for a pool Raydium created is not a case that arises.
 */
function bitmapExtensionAddress(pool: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool_tick_array_bitmap_extension"), pool.toBuffer()],
    RAYDIUM_CLMM,
  )[0];
}

/**
 * The tick arrays the pool needs RIGHT NOW, derived from its own state.
 *
 * Kept exported at its old signature; fetchLiveRoute no longer calls it,
 * because it reads the pool account once and shares it with everything else.
 */
export async function liveTickArrays(
  connection: Connection,
  pool: PublicKey,
  inputMint: PublicKey,
): Promise<PublicKey[]> {
  const account = await connection.getAccountInfo(pool, "confirmed");
  if (account === null) throw new Error(`pool ${pool.toBase58()} does not exist`);
  const state = decodePoolState(pool, account.owner, account.data);
  const addresses = tickArrayAddresses(pool, state, inputMint.equals(state.mint0));
  const infos = await connection.getMultipleAccountsInfo(addresses, "confirmed");
  return liveOf(pool, state, addresses, infos);
}

/** The initialised ones, in order, insisting the pool's own array exists. */
function liveOf(
  pool: PublicKey,
  state: PoolState,
  addresses: readonly PublicKey[],
  infos: readonly ({ readonly data: Buffer } | null)[],
): PublicKey[] {
  // Only arrays that actually exist are passed — an uninitialised account would
  // fail to deserialise inside the CPI, which is a worse error than a short list.
  const live = addresses.filter((_, index) => infos[index] != null);
  if (infos[0] == null) {
    throw new Error(
      `pool ${pool.toBase58()} has no initialised tick array at the tick it reports ` +
        `(${state.tickCurrent}, spacing ${state.tickSpacing}) — the tick the pool reports has no liquidity`,
    );
  }
  return live;
}

/**
 * The route for `inputMint` -> `outputMint` on `pool`, from the pool's state.
 *
 * TWO RPC CALLS: the pool account (with its slot), then one
 * getMultipleAccountsInfo for the amm config, the bitmap extension and the
 * three candidate tick arrays. Everything else is derivation.
 */
export async function fetchLiveRoute(
  connection: Connection,
  pool: PublicKey,
  inputMint: PublicKey,
  outputMint: PublicKey,
  outputTokenProgram: PublicKey,
): Promise<LiveRoute> {
  const { context, value: account } = await connection.getAccountInfoAndContext(pool, "confirmed");
  if (account === null) throw new Error(`pool ${pool.toBase58()} does not exist`);
  const state = decodePoolState(pool, account.owner, account.data);

  // WHICH WAY ROUND THE POOL IS, checked rather than assumed. The vaults, and
  // the direction the price walks, both follow from this one bit, and getting
  // it backwards builds a route that looks entirely well-formed and sells what
  // it was meant to buy.
  const inputIsMint0 = inputMint.equals(state.mint0);
  if (!inputIsMint0 && !inputMint.equals(state.mint1)) {
    throw new Error(
      `pool ${pool.toBase58()} holds ${state.mint0.toBase58()} and ${state.mint1.toBase58()}, ` +
        `not the input mint ${inputMint.toBase58()}`,
    );
  }
  const expectedOutput = inputIsMint0 ? state.mint1 : state.mint0;
  if (!outputMint.equals(expectedOutput)) {
    throw new Error(
      `pool ${pool.toBase58()} pays ${expectedOutput.toBase58()} for ${inputMint.toBase58()}, ` +
        `not the requested ${outputMint.toBase58()}`,
    );
  }

  const extension = bitmapExtensionAddress(pool);
  const arrays = tickArrayAddresses(pool, state, inputIsMint0);
  const infos = await connection.getMultipleAccountsInfo([state.ammConfig, extension, ...arrays], "confirmed");
  const [configInfo, extensionInfo, ...arrayInfos] = infos;

  if (configInfo == null) throw new Error(`pool ${pool.toBase58()} names an amm config that does not exist`);
  const tradeFeeRate = decodeTradeFeeRate(state, configInfo.owner, configInfo.data);

  const live = liveOf(pool, state, arrays, arrayInfos);

  return {
    ammConfig: state.ammConfig,
    poolState: pool,
    inputVault: inputIsMint0 ? state.vault0 : state.vault1,
    outputVault: inputIsMint0 ? state.vault1 : state.vault0,
    observationState: state.observation,
    inputMint,
    outputMint,
    inputTokenProgram: TOKEN_PROGRAM,
    outputTokenProgram,
    tickArrays: extensionInfo == null ? live : [extension, ...live],
    capturedFrom: `pool state, slot ${context.slot}`,
    directionMatched: true,
    observed: observedRate(state.sqrtPriceX64, tradeFeeRate, inputIsMint0),
  };
}

/**
 * The pool's trade fee, in millionths, with the config's OWN tick spacing used
 * as the proof that the offset is right.
 *
 * AmmConfig carries tick_spacing four bytes after trade_fee_rate, and the pool
 * carries the same number at 235. If the two agree, this file is reading the
 * layout it thinks it is; if they ever disagree, the fee at 47 is some other
 * field and netting the price by it would quietly loosen every min_out the
 * keeper sends. Measured today: 1, 10, 60 and 60, config and pool alike.
 */
function decodeTradeFeeRate(state: PoolState, owner: PublicKey, data: Buffer): bigint {
  if (!owner.equals(RAYDIUM_CLMM)) {
    throw new Error(`amm config ${state.ammConfig.toBase58()} is owned by ${owner.toBase58()}, not Raydium CLMM`);
  }
  if (data.length !== AMM_CONFIG_BYTES || data.subarray(0, 8).toString("hex") !== AMM_CONFIG_DISCRIMINATOR) {
    throw new Error(`amm config ${state.ammConfig.toBase58()} is not a Raydium CLMM AmmConfig`);
  }
  const configTickSpacing = data.readUInt16LE(CONFIG_TICK_SPACING_AT);
  if (configTickSpacing !== state.tickSpacing) {
    throw new Error(
      `amm config ${state.ammConfig.toBase58()} reports tick spacing ${configTickSpacing} but the pool reports ` +
        `${state.tickSpacing} — the AmmConfig layout this file reads the fee from has moved`,
    );
  }
  const tradeFeeRate = BigInt(data.readUInt32LE(TRADE_FEE_RATE_AT));
  if (tradeFeeRate >= FEE_DENOMINATOR) {
    throw new Error(`amm config ${state.ammConfig.toBase58()} charges ${tradeFeeRate}/1e6, which is the whole trade`);
  }
  return tradeFeeRate;
}

/**
 * The pool's price as a raw-in / raw-out pair, net of the trade fee.
 *
 * sqrt_price_x64 squares to token1-raw per token0-raw times 2^128, so the two
 * directions are that ratio and its inverse; Raydium takes its fee off the
 * INPUT before swapping, so the net rate is scaled by (1e6 - feeRate)/1e6.
 * Both sides are kept as exact integers rather than reduced to a rate, because
 * min-out.ts multiplies by the amount before it divides and that ordering is
 * what keeps the bound exact.
 */
function observedRate(
  sqrtPriceX64: bigint,
  tradeFeeRate: bigint,
  inputIsMint0: boolean,
): { readonly inRaw: bigint; readonly outRaw: bigint } {
  const priceX128 = sqrtPriceX64 * sqrtPriceX64;
  const net = FEE_DENOMINATOR - tradeFeeRate;
  return inputIsMint0
    ? { inRaw: Q128 * FEE_DENOMINATOR, outRaw: priceX128 * net }
    : { inRaw: priceX128 * FEE_DENOMINATOR, outRaw: Q128 * net };
}
