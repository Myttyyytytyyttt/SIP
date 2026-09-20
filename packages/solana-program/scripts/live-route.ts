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
//
// WHAT THE WALK PROVED BY ACCIDENT, AND IS NOW PROVED ON PURPOSE. Needing a
// recent successful swap_v2 to copy meant a pool nobody had traded on could not
// produce a route at all. Deriving one from state removes that, so the pool's
// own status byte is read instead: bit 4 set is Raydium's "swaps disabled", and
// a route is refused rather than built for a venue that will reject it.
//
// AND IT HAS TO BE THE RATE THE VAULT'S OWN ACCOUNT WILL SEE. invest.rs checks
// `received >= min_out` against the vault_target ATA's own delta, and two of the
// basket's mints are Token-2022 with a TransferFeeConfig: the pool pays out one
// amount and the ATA is credited a smaller one. Read on mainnet 2026-09-20,
// Pren1FvF… (ANTHROPIC) and PreZad18… (FIGUREAI) both hold older {epoch 1032,
// 50 bps} / newer {epoch 1039, 100 bps}, and epoch 1039 was hours away. A quote
// gross of that fee spends 50 of min-out.ts's 200 bps of tolerance before any
// price impact, and 100 of 200 from epoch 1039 — on a $500 purchase whose own
// impact was measured at up to 36 bps. So every transfer fee on the way through
// is netted out of the reference rate here, and a fee this file cannot absorb
// is REFUSED rather than quoted around.

import { Connection, PublicKey } from "@solana/web3.js";
import { RAYDIUM_CLMM, type SwapV2Pool } from "./raydium-swap";

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

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
   * net of its own trade fee AND of any Token-2022 transfer fee either mint
   * charges on the way through. min-out.ts turns it into the keeper's slippage
   * bound, and the bound is compared on chain against the vault ATA's own
   * delta — which is what a transfer fee comes out of.
   *
   * Typed nullable because the LiveRoute shape is public and callers already
   * branch on null; this implementation never returns null.
   *
   * IT IS STILL A MID PRICE, NOT A QUOTE. It ignores the price impact of our own
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
const STATUS_AT = 389;
/**
 * Bit 4 of `status`, SET, is Raydium's own "swaps are disabled here".
 *
 * Raydium stores this the other way round from the way it reads: set_status_by_bit
 * ORs the bit in to DISABLE, and get_status_by_bit answers "normal" when the bit
 * is clear. All four pools SaverFi trades read status 0 on 2026-09-20.
 */
const SWAP_DISABLED_BIT = 1 << 4;

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

// ── Token-2022, TransferFeeConfig ─────────────────────────────────────────────
// A mint with extensions is longer than the 82-byte base mint: byte 165 says
// which kind of account it is (1 = mint) and the TLV entries start at 166, each
// a u16 type, a u16 length and that many bytes. TransferFeeConfig is type 1 and
// 108 bytes: two 32-byte authorities, the withheld amount (u64), then the older
// and newer TransferFee, 18 bytes each — epoch u64, maximum_fee u64, basis
// points u16. Read off ANTHROPIC and FIGUREAI on mainnet 2026-09-20, where the
// extension sits at 211 and the two schedules are 50 bps (epoch 1032) and
// 100 bps (epoch 1039).
const MINT_ACCOUNT_TYPE_AT = 165;
const MINT_ACCOUNT_TYPE = 1;
const EXTENSIONS_AT = 166;
const TRANSFER_FEE_CONFIG = 1;
/** older_transfer_fee, past the two authorities and the withheld amount. */
const OLDER_FEE_AT = 72;
const TRANSFER_FEE_BYTES = 18;
const BPS_DENOMINATOR = 10_000n;

/**
 * The transfer fee this file will quote around, in basis points.
 *
 * ABOVE THIS THE ROUTE REFUSES rather than quoting. min-out.ts allows 200 bps
 * of tolerance in total, and that budget has to cover the price impact of our
 * own size (measured at up to 36 bps at the $500 per-purchase cap on the
 * thinnest of these pools) and the drift between this read and the block the
 * swap lands in. A mint charging more than half of it leaves too little for
 * both, so the leg stops instead of being sent to fail on chain — which is what
 * the owner asked for when the PreStock issuer doubled its fee: if it is raised
 * again, the keeper stops investing.
 */
const MAX_TRANSFER_FEE_BPS = 100;

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
  // THE VENUE'S OWN SWITCH, which is the one field that says whether this pool
  // will accept a swap at all. It matters here because the walk this file
  // replaced needed a recent SUCCESSFUL swap_v2 to copy, which was an accidental
  // liveness proof: a paused pool made fetchLiveRoute throw before anything was
  // built. A route derived from state has no such accident in it, so the check
  // is made on purpose — otherwise a paused pool yields a well-formed route and
  // the keeper buys an ATA and a reverting invest transaction, per leg, per
  // sweep, with an opaque Raydium error at the end of it. These are
  // issuer-controlled pools and the bit is the issuer's to set.
  const status = data[STATUS_AT]!;
  if ((status & SWAP_DISABLED_BIT) !== 0) {
    throw new Error(
      `pool ${pool.toBase58()} has swaps switched off in its own status byte ` +
        `(0b${status.toString(2).padStart(8, "0")}) — the venue is not accepting trades`,
    );
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

export interface TransferFeeSchedule {
  /** In force until `newer.epoch`. */
  readonly older: { readonly epoch: bigint; readonly bps: number };
  readonly newer: { readonly epoch: bigint; readonly bps: number };
}

const feeAt = (data: Buffer, at: number): { readonly epoch: bigint; readonly bps: number } => ({
  epoch: data.readBigUInt64LE(at),
  bps: data.readUInt16LE(at + 16),
});

/**
 * The mint's Token-2022 transfer fee schedule, or null when it charges none.
 *
 * A classic SPL mint is 82 bytes and has no extensions at all; a Token-2022
 * mint may have many, in any order, so they are WALKED rather than looked up at
 * a fixed offset — the three SaverFi trades carry between eight and ten, and
 * the fee config sits third in two of them and nowhere in the other.
 */
export function transferFeeSchedule(mint: PublicKey, account: { readonly owner: PublicKey; readonly data: Buffer }): TransferFeeSchedule | null {
  if (!account.owner.equals(TOKEN_2022_PROGRAM)) return null;
  const { data } = account;
  if (data.length <= MINT_ACCOUNT_TYPE_AT) return null;
  if (data[MINT_ACCOUNT_TYPE_AT]! !== MINT_ACCOUNT_TYPE) {
    throw new Error(`${mint.toBase58()} is a Token-2022 account of type ${data[MINT_ACCOUNT_TYPE_AT]!}, not a mint`);
  }
  for (let at = EXTENSIONS_AT; at + 4 <= data.length; ) {
    const type = data.readUInt16LE(at);
    const length = data.readUInt16LE(at + 2);
    const body = at + 4;
    if (body + length > data.length) {
      throw new Error(`mint ${mint.toBase58()} has a Token-2022 extension running past the end of the account`);
    }
    if (type === TRANSFER_FEE_CONFIG) {
      if (length < OLDER_FEE_AT + 2 * TRANSFER_FEE_BYTES) {
        throw new Error(`mint ${mint.toBase58()} has a ${length}-byte TransferFeeConfig, too short to hold both schedules`);
      }
      return { older: feeAt(data, body + OLDER_FEE_AT), newer: feeAt(data, body + OLDER_FEE_AT + TRANSFER_FEE_BYTES) };
    }
    // Type 0 is uninitialised padding: nothing past it is an extension.
    if (type === 0) break;
    at = body + length;
  }
  return null;
}

/**
 * The fee in force at `epoch`, by Token-2022's own rule: the newer schedule
 * from its own epoch onward, the older one before it.
 */
export function feeInForce(schedule: TransferFeeSchedule, epoch: bigint): number {
  return epoch >= schedule.newer.epoch ? schedule.newer.bps : schedule.older.bps;
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
  // The two mints ride along in the batch that was already being sent: their
  // own programs and their own transfer fees both come out of these bytes.
  const infos = await connection.getMultipleAccountsInfo([state.ammConfig, extension, inputMint, outputMint, ...arrays], "confirmed");
  const [configInfo, extensionInfo, inputMintInfo, outputMintInfo, ...arrayInfos] = infos;

  if (configInfo == null) throw new Error(`pool ${pool.toBase58()} names an amm config that does not exist`);
  const tradeFeeRate = decodeTradeFeeRate(state, configInfo.owner, configInfo.data);

  if (inputMintInfo == null) throw new Error(`the input mint ${inputMint.toBase58()} does not exist`);
  if (outputMintInfo == null) throw new Error(`the output mint ${outputMint.toBase58()} does not exist`);

  // EACH SIDE'S TOKEN PROGRAM IS THE MINT'S OWN OWNER, read rather than assumed:
  // swap_v2 makes its transfers through the program named here, and one that is
  // not the mint's cannot make them at all. The output side is the caller's
  // declaration, so it is checked against the chain instead of replacing it —
  // a keeper asking for the wrong program should hear about it here, not in an
  // opaque CPI failure.
  const inputTokenProgram = inputMintInfo.owner;
  if (!inputTokenProgram.equals(TOKEN_PROGRAM) && !inputTokenProgram.equals(TOKEN_2022_PROGRAM)) {
    throw new Error(`the input mint ${inputMint.toBase58()} is owned by ${inputTokenProgram.toBase58()}, which is not an SPL token program`);
  }
  if (!outputMintInfo.owner.equals(outputTokenProgram)) {
    throw new Error(
      `the output mint ${outputMint.toBase58()} is owned by ${outputMintInfo.owner.toBase58()}, ` +
        `not the ${outputTokenProgram.toBase58()} this route was asked to build for`,
    );
  }

  const [inputFeeBps, outputFeeBps] = await transferFeeBps(connection, [
    { mint: inputMint, account: inputMintInfo },
    { mint: outputMint, account: outputMintInfo },
  ]);

  const live = liveOf(pool, state, arrays, arrayInfos);

  return {
    ammConfig: state.ammConfig,
    poolState: pool,
    inputVault: inputIsMint0 ? state.vault0 : state.vault1,
    outputVault: inputIsMint0 ? state.vault1 : state.vault0,
    observationState: state.observation,
    inputMint,
    outputMint,
    inputTokenProgram,
    outputTokenProgram,
    tickArrays: extensionInfo == null ? live : [extension, ...live],
    capturedFrom: `pool state, slot ${context.slot}`,
    directionMatched: true,
    observed: observedRate(state.sqrtPriceX64, tradeFeeRate, inputIsMint0, inputFeeBps!, outputFeeBps!),
  };
}

/**
 * What each mint takes out of a transfer of itself, right now, in basis points.
 *
 * THE EPOCH IS ONLY ASKED FOR WHEN IT DECIDES SOMETHING. A classic SPL mint, or
 * a Token-2022 one whose two schedules charge the same, answers without it — so
 * the SOL/USDC convert still costs exactly two RPC calls, and only a leg whose
 * issuer has a fee change pending pays for a third.
 *
 * A FEE THIS FILE CANNOT QUOTE AROUND STOPS THE ROUTE. Nothing downstream would
 * notice a quote that is quietly 1 % optimistic: min_out would simply be too
 * high for the fill, and invest.rs would refuse it on chain, per leg, per sweep,
 * after the transaction had already been paid for.
 */
async function transferFeeBps(
  connection: Connection,
  mints: readonly { readonly mint: PublicKey; readonly account: { readonly owner: PublicKey; readonly data: Buffer } }[],
): Promise<number[]> {
  const schedules = mints.map(({ mint, account }) => ({ mint, schedule: transferFeeSchedule(mint, account) }));
  const undecided = schedules.some(({ schedule }) => schedule !== null && schedule.older.bps !== schedule.newer.bps);
  const epoch = undecided ? BigInt((await connection.getEpochInfo()).epoch) : 0n;
  return schedules.map(({ mint, schedule }) => {
    if (schedule === null) return 0;
    const bps = feeInForce(schedule, epoch);
    if (bps > MAX_TRANSFER_FEE_BPS) {
      throw new Error(
        `mint ${mint.toBase58()} charges a ${bps} bps Token-2022 transfer fee ` +
          `(${schedule.older.bps} bps until epoch ${schedule.newer.epoch}, ${schedule.newer.bps} bps from it), ` +
          `over the ${MAX_TRANSFER_FEE_BPS} bps this route will quote around — the leg stops rather than quoting past it`,
      );
    }
    return bps;
  });
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
 * The pool's price as a raw-in / raw-out pair, net of every fee between the
 * vault's own account and the pool's.
 *
 * sqrt_price_x64 squares to token1-raw per token0-raw times 2^128, so the two
 * directions are that ratio and its inverse; Raydium takes its fee off the
 * INPUT before swapping, so the net rate is scaled by (1e6 - feeRate)/1e6.
 * Both sides are kept as exact integers rather than reduced to a rate, because
 * min-out.ts multiplies by the amount before it divides and that ordering is
 * what keeps the bound exact.
 *
 * THE TWO TRANSFER FEES SIT ON EITHER SIDE OF THAT. What the pool swaps is what
 * arrives in its vault, so an input fee shrinks the amount that is traded; what
 * the vault ATA is credited is what survives the way back, so an output fee
 * shrinks the result again. Both are exact multiplications and both are applied
 * here, because the number this returns is compared on chain against the ATA's
 * own delta.
 *
 * The maximum_fee ceiling on a TransferFee is deliberately NOT modelled. Where
 * it binds, the real fee is smaller than the rate netted here, so the quote is
 * low and min_out ends up loose — the safe direction. Both PreStock mints read
 * u64::MAX for it today, so it binds nowhere.
 */
function observedRate(
  sqrtPriceX64: bigint,
  tradeFeeRate: bigint,
  inputIsMint0: boolean,
  inputFeeBps: number,
  outputFeeBps: number,
): { readonly inRaw: bigint; readonly outRaw: bigint } {
  const priceX128 = sqrtPriceX64 * sqrtPriceX64;
  // One scale on each side, so the ratio is exact and the fees compose.
  const gross = FEE_DENOMINATOR * BPS_DENOMINATOR * BPS_DENOMINATOR;
  const net = (FEE_DENOMINATOR - tradeFeeRate) * (BPS_DENOMINATOR - BigInt(inputFeeBps)) * (BPS_DENOMINATOR - BigInt(outputFeeBps));
  return inputIsMint0
    ? { inRaw: Q128 * gross, outRaw: priceX128 * net }
    : { inRaw: priceX128 * gross, outRaw: Q128 * net };
}
