// Chain state for the build and vault handlers' tests: SIP accounts encoded
// through the IDL, Raydium pools with a chosen sqrt price, and a JSON-RPC stub
// that answers from a map. No network; the endpoint is an .invalid host.

import {
  ANTHROPIC_MINT,
  ANTHROPIC_USDC_POOL,
  FIGUREAI_MINT,
  FIGUREAI_USDC_POOL,
  RAYDIUM_CLMM,
  SOL_USDC_POOL,
  SPYX_MINT,
  SPYX_USDC_POOL,
  TOKEN_2022_PROGRAM,
  USDC_MINT,
  WSOL_MINT,
} from "../src/client/addresses";
import { tryBase58Decode } from "../src/client/base58";
import { encodeStruct } from "../src/client/borsh";
import { CLMM_POOL_STATE_BYTES, CLMM_POOL_STATE_DISCRIMINATOR } from "../src/client/clmm-price";
import { SIP_ACCOUNT_SPACE } from "../src/client/decoders";
import { accountDiscriminator } from "../src/client/idl";
import { BLOCKHASH, UPSTREAM_1, accountInfo, jsonResponse, keypair, type UpstreamCall } from "./helpers";

export type AccountJson = ReturnType<typeof accountInfo>;

/** The local validator's rent: 6,960 lamports per byte, the 128 bytes of overhead included. */
export const localRent = (size: number): number => (size + 128) * 6_960;

function sipAccount(name: "Vault" | "TradingLink" | "ProtocolConfig" | "InvestmentPolicy", fields: Record<string, unknown>): Uint8Array {
  const body = encodeStruct(name, fields);
  const bytes = new Uint8Array(SIP_ACCOUNT_SPACE[name]);
  bytes.set(accountDiscriminator(name), 0);
  bytes.set(body, 8);
  return bytes;
}

export const vaultAccount = (owner: string, fields: Record<string, unknown> = {}): Uint8Array =>
  sipAccount("Vault", {
    owner,
    bump: 255,
    version: 2,
    paused: false,
    skim_bps: 2_000,
    lifetime_saved: 0n,
    created_at: 1_789_495_565n,
    skim_mode: 0,
    volume_bps: 200,
    policy_nonce: 0n,
    max_contribution: 60_000_000n,
    wallet_reserve: 50_000_000n,
    _reserved: new Array(37).fill(0),
    ...fields,
  });

export const linkAccount = (wallet: string, vault: string): Uint8Array =>
  sipAccount("TradingLink", { wallet, vault, epoch: 7n, settlement_nonce: 0n, frontier_slot: 0n, bump: 254, _reserved: new Array(32).fill(0) });

export const configAccount = (paused: boolean): Uint8Array =>
  sipAccount("ProtocolConfig", {
    authority: keypair().publicKey.toBase58(),
    attester: keypair().publicKey.toBase58(),
    bump: 253,
    keeper: keypair().publicKey.toBase58(),
    pending_authority: "11111111111111111111111111111111",
    paused,
    version: 2,
    _reserved: new Array(64).fill(0),
  });

/**
 * An InvestmentPolicy for `vault`: the whole catalogue at the golden floors, $10
 * per buy and $50 per 30 days, as the first mainnet test types them.
 *
 * The three legs are OFFERED_LEGS' three, in order, each at LEG_POOLS' 95 %
 * floor, and the weights are basketWeightsBps(3) written out — 3,334 on the
 * first leg and 3,333 on the other two, summing to exactly 10,000. Written out
 * rather than derived: this fixture stands for what an owner already signed, so
 * it must be able to disagree with today's catalogue.
 */
export const policyAccount = (vault: string, fields: Record<string, unknown> = {}): Uint8Array =>
  sipAccount("InvestmentPolicy", {
    vault,
    enabled: true,
    venue_program: RAYDIUM_CLMM,
    in_mint: USDC_MINT,
    legs: [
      { mint: SPYX_MINT, weight_bps: 3_334, min_out_rate_wad: 124_719_467_624_105_690n },
      { mint: ANTHROPIC_MINT, weight_bps: 3_333, min_out_rate_wad: 5_277_777_777_777_777_778n },
      { mint: FIGUREAI_MINT, weight_bps: 3_333, min_out_rate_wad: 23_750_000_000_000_000_001n },
    ],
    min_convert_rate_wad: 90_034_840_399_943_305n,
    min_investment: 5_000_000n,
    max_per_call: 10_000_000n,
    max_rolling_30d: 50_000_000n,
    bucket_days: new Array(31).fill(0),
    bucket_amounts: new Array(31).fill(0n),
    lifetime_invested: 0n,
    policy_nonce: 1n,
    bump: 252,
    _reserved: new Array(32).fill(0),
    ...fields,
  });

/** A Raydium CLMM PoolState with the fields a price is read from. */
export function clmmPoolAccount(mint0: string, mint1: string, sqrtPriceX64: bigint, decimals: readonly [number, number] = [9, 6]): Uint8Array {
  const bytes = new Uint8Array(CLMM_POOL_STATE_BYTES);
  bytes.set(CLMM_POOL_STATE_DISCRIMINATOR, 0);
  bytes.set(tryBase58Decode(mint0)!, 73);
  bytes.set(tryBase58Decode(mint1)!, 105);
  bytes[233] = decimals[0];
  bytes[234] = decimals[1];
  let value = sqrtPriceX64;
  for (let i = 0; i < 16; i++, value >>= 8n) bytes[253 + i] = Number(value & 0xffn);
  return bytes;
}

/** sqrt_price_x64 of the wSOL/USDC and SPYx/USDC pools at mainnet slot 447313239. */
export const SOL_SQRT_PRICE = 5_834_501_654_111_004_443n;
export const SPYX_SQRT_PRICE = 50_911_325_114_989_095_030n;

/**
 * sqrt_price_x64 of the two PreStocks pools. UNLIKE THE TWO ABOVE, THESE ARE
 * CHOSEN, NOT OBSERVED: this repo has no recorded mainnet reading of either
 * pool, so rather than invent a mainnet-looking number they are built from a
 * round dollar price anyone can redo by hand. A fixture that cannot be checked
 * is worse than no fixture, and one that decodes to an absurd price is worse still.
 *
 * A leg pool holds mint0 = the leg (d decimals) and mint1 = USDC (6), so its
 * stored price is USDC raw per leg raw, which at P dollars a whole token is
 * P x 10^(6-d), and sqrt_price_x64 = isqrt(P x 2^128 / 10^(d-6)). Both PreStocks
 * carry 9 decimals, so the price is P/1000:
 *   * ANTHROPIC at $180 a token -> 0.18 -> 7,826,290,695,199,669,327
 *   * FIGUREAI  at  $40 a token -> 0.04 -> 3,689,348,814,741,910,323
 * The integer square root truncates, so FIGUREAI's rate lands two raw units
 * above a round 25e18 rather than on it. That is left alone: no real pool sits
 * on a round number either, and LEG_POOLS writes down exactly what decodes.
 */
export const ANTHROPIC_SQRT_PRICE = 7_826_290_695_199_669_327n;
export const FIGUREAI_SQRT_PRICE = 3_689_348_814_741_910_323n;

/** One offered leg's pool, and every rate a test compares a reader's answer to. */
export interface LegPoolFixture {
  readonly symbol: string;
  readonly mint: string;
  readonly pool: string;
  /** The leg's decimals. mint1 is always USDC at 6. */
  readonly decimals: number;
  readonly sqrtPriceX64: bigint;
  /** legUsdcWad: leg raw out per USDC raw in, x 1e18. */
  readonly legWad: bigint;
  /** floorWad(legWad, LEG_FLOOR_MARGIN_BPS = 500): the floor set_invest_policy stores. */
  readonly floorWad: bigint;
  /** usdcRawPer1e8LegRaw(legWad): what 1e8 raw units cost at today's rate. */
  readonly usdcRawPer1e8: bigint;
  /** usdcRawPer1e8LegRaw(floorWad): the most the floor lets be paid for 1e8 raw units. */
  readonly maxUsdcRawPer1e8: bigint;
}

/**
 * Every offered leg's pool, in OFFERED_LEGS' order — which is PRICED_POOLS'
 * order once the wSOL/USDC pool is taken off the front.
 *
 * EVERY RATE HERE IS A LITERAL, worked out once and written down, never
 * re-derived from sqrtPriceX64 by the same functions the tests exercise. A test
 * that compares readPoolPrices' answer to `legWad` is therefore still comparing
 * it to a constant, exactly as it did when the numbers were typed inline; naming
 * them only stops the same constant being retyped in four files.
 *
 * SPYx's four are the mainnet goldens. The PreStocks' follow from the chosen
 * sqrt prices above: 1e18 x 10^(d-6) / P, then 95 % of it, then
 * ceil(1e8 x 1e18 / wad) of each.
 *
 * Every figure here is a RAW rate, never a display price. SPYx's 761,709,474
 * USDC raw per 1e8 raw units is what the chain charges; its scaledUiAmount
 * multiplier moves what a wallet shows without moving this, which is exactly why
 * no floor in this repo is ever taken from a uiAmount.
 */
export const LEG_POOLS: readonly LegPoolFixture[] = Object.freeze([
  Object.freeze({
    symbol: "SPYx",
    mint: SPYX_MINT,
    pool: SPYX_USDC_POOL,
    decimals: 8,
    sqrtPriceX64: SPYX_SQRT_PRICE,
    legWad: 131_283_650_130_637_569n,
    floorWad: 124_719_467_624_105_690n,
    usdcRawPer1e8: 761_709_474n,
    maxUsdcRawPer1e8: 801_799_446n,
  }),
  Object.freeze({
    symbol: "ANTHROPIC",
    mint: ANTHROPIC_MINT,
    pool: ANTHROPIC_USDC_POOL,
    decimals: 9,
    sqrtPriceX64: ANTHROPIC_SQRT_PRICE,
    legWad: 5_555_555_555_555_555_556n,
    floorWad: 5_277_777_777_777_777_778n,
    usdcRawPer1e8: 18_000_000n,
    maxUsdcRawPer1e8: 18_947_369n,
  }),
  Object.freeze({
    symbol: "FIGUREAI",
    mint: FIGUREAI_MINT,
    pool: FIGUREAI_USDC_POOL,
    decimals: 9,
    sqrtPriceX64: FIGUREAI_SQRT_PRICE,
    legWad: 25_000_000_000_000_000_002n,
    floorWad: 23_750_000_000_000_000_001n,
    usdcRawPer1e8: 4_000_000n,
    maxUsdcRawPer1e8: 4_210_527n,
  }),
]);

/** The wSOL/USDC pool as the chain holds it: Raydium CLMM, mint0 wSOL, at SOL_SQRT_PRICE. */
const solPoolAccount = (): AccountJson => accountInfo(RAYDIUM_CLMM, clmmPoolAccount(WSOL_MINT, USDC_MINT, SOL_SQRT_PRICE));

/** One leg's pool as the chain holds it: Raydium CLMM, mint0 the leg, mint1 USDC. */
const legPoolAccount = (leg: LegPoolFixture): AccountJson => accountInfo(RAYDIUM_CLMM, clmmPoolAccount(leg.mint, USDC_MINT, leg.sqrtPriceX64, [leg.decimals, 6]));

/**
 * PRICED_POOLS' accounts as [address, account] pairs, in that order, for a
 * StubChain's map. A chain that means to price the whole catalogue spreads these
 * rather than listing pools by hand: a test meaning to spoil ONE pool must then
 * say so, instead of passing because two others were never there.
 */
export const pricedPoolEntries = (): [string, AccountJson][] => [
  [SOL_USDC_POOL, solPoolAccount()],
  ...LEG_POOLS.map((leg): [string, AccountJson] => [leg.pool, legPoolAccount(leg)]),
];

/** A mint account held by `tokenProgram`: only its owner is read. */
export const mintAccount = (tokenProgram: string): AccountJson => accountInfo(tokenProgram, new Uint8Array(82), 1_461_600);

/** A token account held by `tokenProgram`: only its owner is read. */
export const tokenAccountInfo = (tokenProgram: string, bytes = 165): AccountJson => accountInfo(tokenProgram, new Uint8Array(bytes), localRent(bytes));

/**
 * A token account's real bytes: SPL Token's Account layout (mint, owner, amount,
 * state at 108), and past 165 bytes Token-2022's account type byte, 2, at 165.
 */
export function tokenAccountData(fields: { readonly mint: string; readonly owner: string; readonly amount: bigint; readonly state?: number; readonly bytes?: number }): Uint8Array {
  const bytes = new Uint8Array(fields.bytes ?? 165);
  bytes.set(tryBase58Decode(fields.mint)!, 0);
  bytes.set(tryBase58Decode(fields.owner)!, 32);
  new DataView(bytes.buffer).setBigUint64(64, fields.amount, true);
  bytes[108] = fields.state ?? 1;
  if (bytes.length > 165) bytes[165] = 2;
  return bytes;
}

/** A token account as getMultipleAccounts answers it with jsonParsed. */
export function parsedTokenAccount(fields: { readonly tokenProgram: string; readonly mint: string; readonly owner: string; readonly amount: string; readonly decimals: number; readonly uiAmountString: string; readonly bytes?: number }) {
  const space = fields.bytes ?? 165;
  return {
    data: {
      program: fields.tokenProgram === TOKEN_2022_PROGRAM ? "spl-token-2022" : "spl-token",
      parsed: { type: "account", info: { mint: fields.mint, owner: fields.owner, state: "initialized", isNative: false, tokenAmount: { amount: fields.amount, decimals: fields.decimals, uiAmountString: fields.uiAmountString } } },
      space,
    },
    lamports: localRent(space),
    owner: fields.tokenProgram,
    executable: false,
    rentEpoch: 0,
    space,
  };
}

/** One jsonParsed token account getTokenAccountsByOwner lists for its owner. */
export interface StubTokenAccount {
  readonly pubkey: string;
  readonly mint: string;
  readonly amount: string;
  readonly decimals: number;
  readonly uiAmountString: string;
  readonly tokenProgram: string;
}

export interface StubChain {
  readonly accounts: Map<string, AccountJson | null>;
  /** What getMultipleAccounts answers for these addresses when asked for jsonParsed; `accounts` otherwise. */
  readonly parsedAccounts?: Map<string, unknown>;
  /** getTokenAccountsByOwner's answers, by owner. */
  readonly tokenAccounts?: Map<string, readonly StubTokenAccount[]>;
  readonly slot?: number;
  readonly lastValidBlockHeight?: number;
  /** Every call fails at the transport, quoting the endpoint, so a test can prove the quote never leaves. */
  down?: boolean;
}

type RpcRequest = { readonly id?: unknown; readonly method?: string; readonly params?: readonly unknown[] };

/** A fetch responder answering single and batch JSON-RPC bodies from `chain`. */
export function answerRpc(chain: StubChain): (call: UpstreamCall) => Response {
  const one = (request: RpcRequest): Record<string, unknown> => {
    const id = request.id ?? 1;
    const context = { slot: chain.slot ?? 321 };
    const params = request.params ?? [];
    switch (request.method) {
      case "getMultipleAccounts": {
        const parsed = (params[1] as { encoding?: string } | undefined)?.encoding === "jsonParsed";
        const answer = (address: string): unknown => (parsed && chain.parsedAccounts?.has(address) ? chain.parsedAccounts.get(address) : (chain.accounts.get(address) ?? null));
        return { jsonrpc: "2.0", id, result: { context, value: (params[0] as string[]).map(answer) } };
      }
      case "getAccountInfo":
        return { jsonrpc: "2.0", id, result: { context, value: chain.accounts.get(params[0] as string) ?? null } };
      case "getMinimumBalanceForRentExemption":
        return { jsonrpc: "2.0", id, result: localRent(params[0] as number) };
      case "getLatestBlockhash":
        return { jsonrpc: "2.0", id, result: { context, value: { blockhash: BLOCKHASH, lastValidBlockHeight: chain.lastValidBlockHeight ?? 300_000_150 } } };
      case "getTokenAccountsByOwner": {
        const owner = params[0] as string;
        const programId = (params[1] as { programId?: string } | undefined)?.programId;
        const listed = (chain.tokenAccounts?.get(owner) ?? []).filter((entry) => entry.tokenProgram === programId);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            context,
            value: listed.map((entry) => ({
              pubkey: entry.pubkey,
              account: {
                data: { parsed: { info: { mint: entry.mint, owner, tokenAmount: { amount: entry.amount, decimals: entry.decimals, uiAmountString: entry.uiAmountString } } } },
                owner: entry.tokenProgram,
                lamports: localRent(165),
                executable: false,
                rentEpoch: 0,
                space: 165,
              },
            })),
          },
        };
      }
      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `the stub has no ${String(request.method)}` } };
    }
  };
  return (call) => {
    if (chain.down === true) throw new Error(`socket hang up ${UPSTREAM_1}`);
    return jsonResponse(Array.isArray(call.body) ? (call.body as RpcRequest[]).map(one) : one(call.body as RpcRequest));
  };
}

/** Every JSON-RPC method the stub was asked, batches flattened. */
export const methodsOf = (calls: readonly UpstreamCall[]): string[] =>
  calls.flatMap((call) => (Array.isArray(call.body) ? (call.body as RpcRequest[]).map((request) => String(request.method)) : [String((call.body as RpcRequest).method)]));
