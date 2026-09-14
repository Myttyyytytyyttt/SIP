// Chain facts for Robinhood Chain 4663, and the hex/topic primitives every read
// and every decoder needs. Owner: chain.
//
// Ported from the session engine of the project this was forked from (src/chain.ts (addresses, executor)
// history, hex helpers) and the keeper of the project this was forked from (src/config.ts (MAINNET).

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
/**
 * NUVEM'S DEPLOYMENTS ARE GONE ON PURPOSE, and no address replaces them here.
 *
 * SIP does not reuse them. Their vaults hold trading accounts whose savings rate
 * is a PERCENTAGE OF PROFIT — 1000 to 3000 bps, read from chain on 2026-09-08 —
 * while this product's rate is BASIS POINTS OF VOLUME. Phase 0 feeds the volume
 * through the executor's cash fields, so pointing at one of those accounts would
 * apply 20% to a notional and skim a hundred times what the user agreed to.
 *
 * The factory, the executor, the pause controller and the attester registry are
 * therefore CONFIGURATION, never constants: they come from SIP_VAULT_FACTORY and
 * SIP_SETTLEMENT_EXECUTOR, and the worker refuses to start without them. Chain
 * facts below (WETH, the routers, the topics) stay pinned, because those belong
 * to the chain rather than to a deployment.
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
