// Chain state for the build and vault handlers' tests: SIP accounts encoded
// through the IDL, Raydium pools with a chosen sqrt price, and a JSON-RPC stub
// that answers from a map. No network; the endpoint is an .invalid host.

import {
  CLMM_TOKEN_MINT_0_AT,
  CLMM_TOKEN_MINT_1_AT,
  CLMM_TOKEN_VAULT_0_AT,
  CLMM_TOKEN_VAULT_1_AT,
} from "@sip/solana-program/clmm-layout";

import {
  ANTHROPIC_MINT,
  ANTHROPIC_USDC_POOL,
  RAYDIUM_CLMM,
  SOL_USDC_POOL,
  SPYX_MINT,
  SPYX_USDC_POOL,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
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
 * The two legs are OFFERED_LEGS' two, in order, each at LEG_POOLS' 95 % floor,
 * and the weights are basketWeightsBps(2) written out — 5,000 and 5,000,
 * summing to exactly 10,000. Written out rather than derived: this fixture
 * stands for what an owner already signed, so it must be able to disagree with
 * today's catalogue. (It shrank with the catalogue when FIGUREAI's leg was
 * withdrawn; nothing forces it to, and a test that needs a stale basket passes
 * its own `legs`, as pauseInvesting's does.)
 */
export const policyAccount = (vault: string, fields: Record<string, unknown> = {}): Uint8Array =>
  sipAccount("InvestmentPolicy", {
    vault,
    enabled: true,
    venue_program: RAYDIUM_CLMM,
    in_mint: USDC_MINT,
    legs: [
      { mint: SPYX_MINT, weight_bps: 5_000, min_out_rate_wad: 124_719_467_624_105_690n },
      { mint: ANTHROPIC_MINT, weight_bps: 5_000, min_out_rate_wad: 5_277_777_777_777_777_778n },
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

/**
 * A Raydium CLMM PoolState with the fields a price is read from and, when
 * `vaults` is given, the two token vaults at 137 and 169.
 *
 * NO VAULTS BY DEFAULT, which is not an oversight: a pool whose vault fields are
 * all-zero names the system program as its reserve account, and that is exactly
 * what a reserve read must refuse. Every caller that means the pool to be whole
 * passes the pair mainnet really holds.
 */
export function clmmPoolAccount(
  mint0: string,
  mint1: string,
  sqrtPriceX64: bigint,
  decimals: readonly [number, number] = [9, 6],
  vaults?: readonly [string, string],
): Uint8Array {
  const bytes = new Uint8Array(CLMM_POOL_STATE_BYTES);
  bytes.set(CLMM_POOL_STATE_DISCRIMINATOR, 0);
  // THE WRITER USES THE READER'S OWN OFFSETS, from @sip/solana-program/clmm-layout,
  // so the two cannot drift apart. The price of that is that they can drift
  // TOGETHER: move the shared layout and every reserve test still agrees with
  // itself over bytes mainnet does not have. readers.test.ts is what catches
  // that, by asserting the constants, and what this writes, against typed literals.
  bytes.set(tryBase58Decode(mint0)!, CLMM_TOKEN_MINT_0_AT);
  bytes.set(tryBase58Decode(mint1)!, CLMM_TOKEN_MINT_1_AT);
  if (vaults !== undefined) {
    bytes.set(tryBase58Decode(vaults[0])!, CLMM_TOKEN_VAULT_0_AT);
    bytes.set(tryBase58Decode(vaults[1])!, CLMM_TOKEN_VAULT_1_AT);
  }
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
 * sqrt_price_x64 of the PreStocks pool. UNLIKE THE TWO ABOVE, THIS IS CHOSEN,
 * NOT OBSERVED: this repo has no recorded mainnet reading of that pool, so
 * rather than invent a mainnet-looking number it is built from a round dollar
 * price anyone can redo by hand. A fixture that cannot be checked is worse than
 * no fixture, and one that decodes to an absurd price is worse still.
 *
 * A leg pool holds mint0 = the leg (d decimals) and mint1 = USDC (6), so its
 * stored price is USDC raw per leg raw, which at P dollars a whole token is
 * P x 10^(6-d), and sqrt_price_x64 = isqrt(P x 2^128 / 10^(d-6)). ANTHROPIC
 * carries 9 decimals, so the price is P/1000:
 *   * ANTHROPIC at $180 a token -> 0.18 -> 7,826,290,695,199,669,327
 * The integer square root truncates, so a rate need not land on a round number,
 * and LEG_POOLS writes down exactly what decodes rather than what was aimed at.
 */
export const ANTHROPIC_SQRT_PRICE = 7_826_290_695_199_669_327n;

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
  /** token_vault_0 at offset 137: the leg's own vault, as mainnet's pool names it. */
  readonly vault0: string;
  /** token_vault_1 at offset 169: the USDC vault — the IN side, the one the reserve panel reads. */
  readonly usdcVault: string;
  /** What that USDC vault held at MAINNET_VAULT_SLOT, in raw USDC. */
  readonly usdcReserve: bigint;
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
 * SPYx's four are the mainnet goldens. ANTHROPIC's follow from the chosen sqrt
 * price above: 1e18 x 10^(d-6) / P, then 95 % of it, then
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
    vault0: "CiQuPAfYp5v82vijk6u7wqFnaZqtGdJfUUSjDKAtT9ML",
    usdcVault: "3EmW8zJDHrfgwpQJAt1oD6nxgQZLUwrCRSKk8Gr3iKRF",
    usdcReserve: 2_110_084_527_716n,
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
    vault0: "FgHMtKqgquroXWykub1XgLBhtH98m7E9QwFWeyDYLEEn",
    usdcVault: "FZmwQEZqNiSPx1CbATM9uEbAr67iXYV2n2Az6tjGEGmh",
    usdcReserve: 9_575_440_815n,
  }),
]);

/**
 * WHERE THE VAULT ADDRESSES AND RESERVES COME FROM: mainnet, at slot 448882962,
 * read straight out of each pool account's bytes at 137 and 169 and each vault's
 * amount at 64.
 *
 * THEY ARE LITERALS AND NOT DERIVATIONS, for the reason every rate above is one:
 * readers.ts works the same addresses out as PDAs of ["pool_vault", pool, mint]
 * under the CLMM program, and a fixture that derived them with that same rule
 * would be comparing the rule against itself. Written down from the chain, they
 * pin the rule to what Raydium actually did.
 */
export const MAINNET_VAULT_SLOT = 448_882_962;

/** The wSOL/USDC pool's two vaults: wSOL at 137, USDC at 169. */
export const SOL_POOL_VAULT_0 = "4ct7br2vTPzfdmY3S5HLtTxcGSBfn6pnw98hsS6v359A";
export const SOL_POOL_USDC_VAULT = "5it83u57VRrVgc51oNV19TTmAJuffPx5GtGwQr7gQNUo";
/** What the wSOL/USDC pool's USDC vault held at MAINNET_VAULT_SLOT, in raw USDC. */
export const SOL_POOL_USDC_RESERVE = 3_539_005_980_271n;

/** The wSOL/USDC pool as the chain holds it: Raydium CLMM, mint0 wSOL, at SOL_SQRT_PRICE, naming its two real vaults. */
const solPoolAccount = (): AccountJson =>
  accountInfo(RAYDIUM_CLMM, clmmPoolAccount(WSOL_MINT, USDC_MINT, SOL_SQRT_PRICE, [9, 6], [SOL_POOL_VAULT_0, SOL_POOL_USDC_VAULT]));

/** One leg's pool as the chain holds it: Raydium CLMM, mint0 the leg, mint1 USDC, naming its two real vaults. */
const legPoolAccount = (leg: LegPoolFixture): AccountJson =>
  accountInfo(RAYDIUM_CLMM, clmmPoolAccount(leg.mint, USDC_MINT, leg.sqrtPriceX64, [leg.decimals, 6], [leg.vault0, leg.usdcVault]));

/**
 * A pool's token vault as the chain holds it: classic SPL Token, holding `mint`,
 * OWNED BY THE POOL ITSELF — which is what mainnet's three really record at byte
 * 32, and not a detail worth inventing differently.
 */
export const poolVaultAccount = (pool: string, mint: string, amount: bigint): AccountJson =>
  accountInfo(TOKEN_PROGRAM, tokenAccountData({ mint, owner: pool, amount }), localRent(165));

/**
 * Every priced pool's IN-SIDE vault as [address, account] pairs, in PRICED_POOLS'
 * order, for a StubChain's map. Spread beside pricedPoolEntries() by any test
 * that means the reserves to be readable; a test that leaves them out is a test
 * about a reserve nobody could read, which must come back unknown and not zero.
 */
export const pricedPoolVaultEntries = (): [string, AccountJson][] => [
  [SOL_POOL_USDC_VAULT, poolVaultAccount(SOL_USDC_POOL, USDC_MINT, SOL_POOL_USDC_RESERVE)],
  ...LEG_POOLS.map((leg): [string, AccountJson] => [leg.usdcVault, poolVaultAccount(leg.pool, USDC_MINT, leg.usdcReserve)]),
];

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
