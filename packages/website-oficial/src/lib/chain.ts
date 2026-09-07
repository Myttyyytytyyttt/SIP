/**
 * Chain 4663 (Robinhood Chain, an Arbitrum Nitro L2) is absent from viem/chains
 * and from Privy's built-in list. `defineChain` is the documented escape hatch,
 * and the resulting object is passed to PrivyProvider exactly like a viem/chains
 * export. Ported from the Nuvem dashboard's src/lib/chain.ts (HEAD fd927b0).
 *
 * This module is CLIENT-SAFE on purpose: it holds no RPC client and no
 * privileged URL. The read client lives in vault.ts, which only ever runs on the
 * server. It also imports nothing from config.ts, so config.ts can import the
 * chain id from here without a cycle.
 *
 * TWO THINGS TO KNOW BEFORE EDITING.
 *
 * 1. NO `contracts.multicall3`. viem uses that address for automatic read
 *    batching. If it is wrong or undeployed on 4663, every batched read is routed
 *    through a nonexistent address and reverts. Leaving it out makes viem fall
 *    back to individual eth_call, which is correct and safe. Do not add it
 *    without an onchain-verified Multicall3 deployment.
 *
 * 2. Solidity `block.number` on this chain is the *L1* block number, millions
 *    above the L2 height `eth_blockNumber` returns. `activationBlock` and
 *    `revocationBlock` are on the L1 clock; the chain head this app reads, and
 *    the block numbers in eth_getLogs, are on the L2 clock. Never subtract one
 *    from the other, and never render either without saying which it is.
 */

import { defineChain, type Chain } from "viem";

export const ROBINHOOD_CHAIN_ID = 4663 as const;

/**
 * Measured live on 2026-07-29: 0.1002 s per L2 block, 12.04 s per L1 block,
 * 120.2 L2 blocks per L1 block, with the L1 number 3,551,127 ABOVE the L2 number
 * on that day. The offset is not a constant — it grew by about 2.65M over the
 * following day — so it is deliberately not stated as a number anywhere a reader
 * could be tempted to subtract with it.
 */
export const L2_BLOCKS_PER_L1_BLOCK = 120;

export const BLOCK_NUMBER_NOTE =
  "L1 block number. Solidity block.number on Robinhood Chain is the L1 height, " +
  "millions above the L2 height this chain's RPC reports, and the gap between " +
  "them is not constant — so it cannot be compared with the L2 chain head or " +
  "turned into an 'N blocks ago'.";

export const L2_BLOCK_NUMBER_NOTE =
  "L2 block number — the chain's own height, which is what eth_blockNumber and " +
  "eth_getLogs use. About " +
  String(L2_BLOCKS_PER_L1_BLOCK) +
  " L2 blocks pass per L1 block, so this number is far BELOW any L1 block number " +
  "on this page. The two are never comparable.";

/**
 * A wallet-facing RPC URL made absolute.
 *
 * The default `walletRpcUrl` is the same-origin relay `/api/rpc`, and it is
 * relative because loadConfig() has no request to read an origin from. That is
 * fine for the server, which never hands the chain to a wallet — but
 * wallet_addEthereumChain needs an ABSOLUTE URL (MetaMask rejects anything
 * else, silently, and the chain simply never gets added). So a relative value
 * is resolved against the page's own origin in the browser, and left as it is
 * anywhere `location` does not exist. Nothing here reaches the rendered
 * markup, so the two answers cannot cause a hydration mismatch.
 */
function absoluteRpcUrl(walletRpcUrl: string): string {
  if (!walletRpcUrl.startsWith("/")) return walletRpcUrl;
  const origin = typeof globalThis.location === "undefined" ? null : globalThis.location.origin;
  return origin === null ? walletRpcUrl : `${origin}${walletRpcUrl}`;
}

/**
 * The chain object handed to Privy and, through it, to the wallet. Its rpcUrls
 * entry is the WALLET-facing URL — it is what MetaMask receives via
 * wallet_addEthereumChain for a chain it has never seen, so it must be publicly
 * reachable and must not carry an API key. No server read uses it: the read
 * client in vault.ts sets its own transport.
 */
export function robinhoodChain(walletRpcUrl: string, explorerUrl: string | null = null): Chain {
  return defineChain({
    id: ROBINHOOD_CHAIN_ID,
    name: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [absoluteRpcUrl(walletRpcUrl)] } },
    ...(explorerUrl ? { blockExplorers: { default: { name: "Explorer", url: explorerUrl } } } : {}),
  });
}

export function explorerAddressUrl(explorerUrl: string | null, address: string): string | null {
  if (!explorerUrl) return null;
  return `${explorerUrl.replace(/\/+$/, "")}/address/${address}`;
}

export function explorerTxUrl(explorerUrl: string | null, hash: string): string | null {
  if (!explorerUrl) return null;
  return `${explorerUrl.replace(/\/+$/, "")}/tx/${hash}`;
}
