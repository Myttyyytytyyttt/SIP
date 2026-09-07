// Chain facts for Robinhood Chain 4663, and the hex/topic primitives every read
// and every decoder needs. Owner: chain.
//
// Ported from packages/session-engine-old/src/chain.ts (addresses, executor
// history, hex helpers) and packages/keeper-old/src/config.ts (MAINNET).

import type { Address, Hex } from "../types.js";

export const CHAIN_ID = 4663;

/** Canonical WETH pinned permanently by VaultFactory.configureProtocol. */
export const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73" as const;
/** The GMGN router: emits FILL and FEE (both indexed by wallet) on every trade. */
export const GMGN_ROUTER = "0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc" as const;
/** Uniswap v4 PoolManager; appears in FILL word 13 when the pool is v4. */
export const UNISWAP_V4_POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951" as const;
/** keccak256("Transfer(address,address,uint256)") */
export const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as const;

/**
 * The live mainnet deployment (08-16 topology), read from
 * `factory.protocolConfiguration()` and verified address by address.
 *
 * TREAT THESE AS A FALLBACK, NEVER AS TRUTH. `protocolConfiguration()` is
 * one-shot and immutable, so the factory address alone is enough to derive the
 * others at runtime; a constant that disagrees with it is always the thing that
 * is wrong. Re-verify before trusting them after any redeployment.
 */
export const VAULT_FACTORY = "0x783bdf0281090f21928398cc3da19cfb64fed15e" as const;
export const PAUSE_CONTROLLER = "0x418b3406bc483eb66ca5570b6ff91ce9d090e8a7" as const;
export const ATTESTER_REGISTRY = "0x1a96be4a757e065fb8928a2e5ab2ab24790ec7de" as const;

/** The canary deployment's executor. Superseded; the fixture's only settle() went here. */
export const SETTLEMENT_EXECUTOR_CANARY = "0xce676c73bd9fb76a73058ec135106b81a5abd0f5" as const;
/** The executor of the 2026-08-08 deployment. Superseded. */
export const SETTLEMENT_EXECUTOR_V2 = "0x5d037fe7fd65745ba51ddb433aa5b17e965d46ac" as const;
/**
 * The live executor, from `factory.protocolConfiguration()` on factory
 * 0x783BDF…Fed15E, read from chain 2026-08-17. Added BEFORE its first
 * settlement, which is the only time adding it is cheap.
 */
export const SETTLEMENT_EXECUTOR = "0xfa92abf15dfaf470cc8833cb01464bd6ca139e16" as const;

/**
 * Every SettlementExecutor that ever received a pull on this chain, oldest first.
 *
 * This is a HISTORY, not a pointer at the current deployment. `configureProtocol`
 * is one-shot, so an executor is never amended in place; a new one is a new
 * address, and cash that left a wallet towards any of them is a contribution,
 * not a trade. AN OMISSION HERE IS NOT A DEGRADED READ: whenever
 * `configureProtocol` names a new executor, it belongs here in the same change.
 */
export const SETTLEMENT_EXECUTORS = [SETTLEMENT_EXECUTOR_CANARY, SETTLEMENT_EXECUTOR_V2, SETTLEMENT_EXECUTOR] as const;

// ── GMGN router events (DESIGN.md §1) ───────────────────────────────────────

/**
 * FILL: topics `[sig, wallet, wallet, 0x0]`, data 16 words — w00 amountIn,
 * w01 amountOut (NET of fee on sells), w05 = 1 (v3-style) | 2 (v4), w06..w08
 * path/pool addresses (v4 puts the PoolManager in w13), w09 = 10000, w10 = 200.
 */
export const GMGN_FILL_TOPIC = "0x8619026a40d38bedb4002fe511cea4bc4a9b336710efe8f21a61869a7ee0f02a" as const;
/** FEE: topics `[sig, 0x0, wallet]`, data 2 words — w00 fee wei, w01 unix timestamp. */
export const GMGN_FEE_TOPIC = "0x205442d60b70af1203d43cab62352c3b69b94f091be32fe683198057282b5c92" as const;

// ── VaultFactory events (keeper-old/src/discovery.ts) ───────────────────────

/** keccak256("TradingAccountLinked(address,address,bytes32)") — indexed (tradingAccount, vault, vaultId). */
export const FACTORY_LINKED_TOPIC = "0xf4399d99bbb6fe9adcd825701524ba54ab7250bb5525af6180e38a5720e46cbc" as const;
/** keccak256("TradingAccountUnlinked(address,address,bytes32)") — same indexed fields. */
export const FACTORY_UNLINKED_TOPIC = "0x55ff53476233b47a92b08a9dcaf8704c43d725da107611dfe78dc44b66e991a4" as const;

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
/** The zero address as a 32-byte topic: FEE topics[1], mint/burn Transfer counterparties. */
export const ZERO_TOPIC = "0x0000000000000000000000000000000000000000000000000000000000000000" as const;
/** balanceOf(address) */
export const BALANCE_OF_SELECTOR = "0x70a08231" as const;

// ── primitives ──────────────────────────────────────────────────────────────

const HEX = /^0x[0-9a-fA-F]*$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;

export const isHex = (value: unknown): value is Hex => typeof value === "string" && HEX.test(value);

/** Decodes a JSON-RPC quantity. "0x" is not a number and must not become 0n by accident. */
export function hexToBigInt(value: string): bigint {
  if (!HEX.test(value) || value.length < 3) throw new TypeError(`not a hex quantity: ${JSON.stringify(value)}`);
  return BigInt(value);
}

/** The block tag JSON-RPC wants: unpadded lowercase hex. */
export function toBlockTag(block: bigint): Hex {
  if (block < 0n) throw new RangeError(`block height cannot be negative: ${block}`);
  return `0x${block.toString(16)}`;
}

/** Lowercases and validates an address; every address that leaves this module went through here. */
export function normalizeAddress(value: string): Address {
  const lower = value.toLowerCase();
  if (!ADDRESS.test(lower)) throw new TypeError(`not an address: ${JSON.stringify(value)}`);
  return lower as Address;
}

/** The address as a 32-byte ABI word, without the 0x: what eth_call data and topics are made of. */
export const addressWord = (address: string): string => normalizeAddress(address).slice(2).padStart(64, "0");

/** Left-pads an address to a 32-byte log topic. */
export const addressTopic = (address: string): Hex => `0x${addressWord(address)}`;

/** Decodes the 20-byte address out of a 32-byte log topic. */
export function topicAddress(topic: string): Address {
  if (!HEX.test(topic) || topic.length !== 66) throw new TypeError(`not a 32-byte topic: ${JSON.stringify(topic)}`);
  return normalizeAddress(`0x${topic.slice(26)}`);
}
