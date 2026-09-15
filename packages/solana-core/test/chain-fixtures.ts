// Chain state for the build and vault handlers' tests: SIP accounts encoded
// through the IDL, Raydium pools with a chosen sqrt price, and a JSON-RPC stub
// that answers from a map. No network; the endpoint is an .invalid host.

import { tryBase58Decode } from "../src/client/base58";
import { encodeStruct } from "../src/client/borsh";
import { CLMM_POOL_STATE_BYTES, CLMM_POOL_STATE_DISCRIMINATOR } from "../src/client/clmm-price";
import { SIP_ACCOUNT_SPACE } from "../src/client/decoders";
import { accountDiscriminator } from "../src/client/idl";
import { BLOCKHASH, UPSTREAM_1, accountInfo, jsonResponse, keypair, type UpstreamCall } from "./helpers";

export type AccountJson = ReturnType<typeof accountInfo>;

/** The local validator's rent: 6,960 lamports per byte, the 128 bytes of overhead included. */
export const localRent = (size: number): number => (size + 128) * 6_960;

function sipAccount(name: "Vault" | "TradingLink" | "ProtocolConfig", fields: Record<string, unknown>): Uint8Array {
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

export interface StubChain {
  readonly accounts: Map<string, AccountJson | null>;
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
      case "getMultipleAccounts":
        return { jsonrpc: "2.0", id, result: { context, value: (params[0] as string[]).map((address) => chain.accounts.get(address) ?? null) } };
      case "getAccountInfo":
        return { jsonrpc: "2.0", id, result: { context, value: chain.accounts.get(params[0] as string) ?? null } };
      case "getMinimumBalanceForRentExemption":
        return { jsonrpc: "2.0", id, result: localRent(params[0] as number) };
      case "getLatestBlockhash":
        return { jsonrpc: "2.0", id, result: { context, value: { blockhash: BLOCKHASH, lastValidBlockHeight: chain.lastValidBlockHeight ?? 300_000_150 } } };
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
