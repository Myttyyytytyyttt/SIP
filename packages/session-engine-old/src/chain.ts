// Robinhood Chain constants and the two primitives every other module needs:
// the definition of "cash", and the L2 -> L1 block mapping.

import type { RpcClient } from "./rpc.js";

export const CHAIN_ID = 4663;

/** Canonical WETH pinned permanently by VaultFactory.configureProtocol. */
export const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73" as const;
/** The canary deployment's executor. Superseded, kept so its windows still read. */
export const SETTLEMENT_EXECUTOR = "0xce676c73bd9fb76a73058ec135106b81a5abd0f5" as const;
export const CANARY_VAULT = "0xf7309dc8e1914a5c3848250cec54ebe7a20d8255" as const;

/** The executor of the 2026-08-08 deployment. Superseded; kept so its windows read. */
export const SETTLEMENT_EXECUTOR_V2 = "0x5d037fe7fd65745ba51ddb433aa5b17e965d46ac" as const;

/**
 * The live executor, from `factory.protocolConfiguration()` on factory
 * 0x783BDF0281090f21928398cC3Da19cFb64Fed15E, read from chain 2026-08-17.
 *
 * Added BEFORE its first settlement, which is the only time adding it is cheap.
 * The comment below has now been proved twice: V2 was missing for the whole life
 * of its deployment, and V3 was missing at the moment a keeper was already
 * holding an account and one signature away from settling against it.
 */
export const SETTLEMENT_EXECUTOR_V3 = "0xfa92abf15dfaf470cc8833cb01464bd6ca139e16" as const;

/**
 * Every SettlementExecutor this engine must recognise, oldest first.
 *
 * This is a HISTORY, not a pointer at the current deployment. The engine's job
 * is to reconstruct windows that already happened, and a window that contains a
 * settlement must be readable forever — including after the executor is
 * replaced. `configureProtocol` is one-shot, so an executor is never amended in
 * place; a new one is a new address, and both must classify.
 *
 * The redeploy that promoted startBlockL2/endBlockL2 into the attestation forced
 * exactly that, and V2 below is its address.
 *
 * AN OMISSION HERE IS NOT A DEGRADED READ, IT IS A PERMANENT REFUSAL. A
 * settle-shaped call to an address missing from this list classifies as UNKNOWN,
 * and one UNKNOWN rejects its whole window forever. V2 sat undeployed in this
 * list for the entire life of the new deployment, so every settlement it ever
 * made would have been unreadable. Whenever `configureProtocol` names a new
 * executor, it belongs here in the same change.
 */
export const SETTLEMENT_EXECUTORS = [
  SETTLEMENT_EXECUTOR,
  SETTLEMENT_EXECUTOR_V2,
  SETTLEMENT_EXECUTOR_V3,
] as const;

/** keccak256("Transfer(address,address,uint256)") */
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as const;

/**
 * SettlementExecutor.settle(SettlementAttestation,bytes), current shape.
 *
 * Guarded: scripts/check-settle-selector.mts fails the build when this disagrees
 * with the compiled ABI in @nuvem/contracts-artifacts, and `pnpm test` runs the
 * guard before vitest. That guard exists because the failure it prevents is a
 * quiet one — see LEGACY_SETTLE_SELECTORS.
 */
export const SETTLE_SELECTOR = "0xc8f2629d" as const;

/**
 * Selectors of settle() overloads that are no longer compiled but are still in
 * chain history, oldest first.
 *
 * 0xf38ac34f is settle() as it was before startBlockL2/endBlockL2 became real
 * attestation fields. It is the selector of the only settlement on mainnet
 * today (tx 0xd342d117…cad186), and test/fixtures/mainnet-4663.json records it.
 * Dropping it would not error anywhere: the transaction would simply stop being
 * a SETTLEMENT and start being UNKNOWN, which refuses every window containing
 * it. The history the engine is trusted to reproduce would become unreadable.
 *
 * Append-only. An entry leaves this list only when the chain it describes does.
 */
export const LEGACY_SETTLE_SELECTORS = ["0xf38ac34f"] as const;

/** Current plus historical, which is what classification must match against. */
export const SETTLE_SELECTORS = [SETTLE_SELECTOR, ...LEGACY_SETTLE_SELECTORS] as const;

export type SettlementCallMatch =
  | { readonly kind: "SETTLEMENT"; readonly selector: string }
  | { readonly kind: "UNRECOGNISED_EXECUTOR"; readonly selector: string }
  | { readonly kind: "NOT_SETTLEMENT" };

/**
 * Decides whether a transaction is a settle() call, and says so in three states
 * rather than two.
 *
 * The third state is the point. Matching `to` against a fixed address and the
 * input against a fixed selector, and treating any miss as "ordinary
 * transaction", is how a settlement stops being recognised without anything
 * reporting it: the contribution then reads as cash that left the wallet through
 * an opaque contract call. UNRECOGNISED_EXECUTOR keeps the refusal but names the
 * cause, so a missing entry in SETTLEMENT_EXECUTORS after a redeploy surfaces as
 * "the executor moved" instead of as an unexplained refusal.
 *
 * Note the asymmetry, and that it is deliberate: a known selector to an unknown
 * address REFUSES the window. It never counts as a settlement. Anyone can deploy
 * a contract with the same four leading bytes, and trusting the selector alone
 * would let a stranger's call be added back into realized profit.
 */
export function classifySettlementCall(to: string | null, input: string): SettlementCallMatch {
  const selector = SETTLE_SELECTORS.find((candidate) => input.startsWith(candidate));
  if (selector === undefined) return { kind: "NOT_SETTLEMENT" };
  // A contract creation has no `to` at all. It is not a settlement, and it is
  // not a mystery either: settle() is a call, never a deployment.
  if (to === null) return { kind: "NOT_SETTLEMENT" };
  const target = normalize(to);
  return SETTLEMENT_EXECUTORS.some((executor) => executor === target)
    ? { kind: "SETTLEMENT", selector }
    : { kind: "UNRECOGNISED_EXECUTOR", selector };
}

/**
 * True when `to` is a SettlementExecutor this engine recognises.
 *
 * Used to classify a settlement by WHERE THE CASH WENT rather than by who sent
 * the transaction. `settle` is the only payable entry on the executor — there is
 * no `receive` and no `fallback` (SettlementExecutor.sol:80) — so native value
 * arriving at one of these addresses from the wallet can only be a contribution.
 */
export function isKnownSettlementExecutor(to: string): boolean {
  const target = normalize(to);
  return SETTLEMENT_EXECUTORS.some((executor) => executor === target);
}

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

export const hexToBigInt = (value: string): bigint => BigInt(value);
export const toBlockTag = (block: bigint): string => `0x${block.toString(16)}`;
export const normalize = (address: string): string => address.toLowerCase();

/** Left-pads an address to a 32-byte log topic. */
export const addressTopic = (address: string): string =>
  `0x${normalize(address).slice(2).padStart(64, "0")}`;

/** Decodes the 20-byte address out of a 32-byte log topic. */
export const topicAddress = (topic: string): string => `0x${topic.slice(26)}`.toLowerCase();

export interface Cash {
  readonly native: bigint;
  readonly weth: bigint;
  /** What SettlementExecutor.calculateRealizedProfit means by cash. */
  readonly total: bigint;
}

/**
 * Cash held by `account` at the END of block `block`.
 *
 * `eth_getBalance` and `eth_call` at a block tag both report post-state, so a
 * window of (start, end] is measured as cashAt(end) - cashAt(start).
 */
export async function cashAt(rpc: RpcClient, account: string, block: bigint): Promise<Cash> {
  const tag = toBlockTag(block);
  const [nativeHex, wethHex] = await Promise.all([
    rpc.call<string>("eth_getBalance", [account, tag]),
    rpc.call<string>("eth_call", [
      { to: WETH, data: `0x70a08231${normalize(account).slice(2).padStart(64, "0")}` },
      tag,
    ]),
  ]);
  const native = hexToBigInt(nativeHex);
  const weth = hexToBigInt(wethHex);
  return { native, weth, total: native + weth };
}

/**
 * Maps an L2 block height to the L1 height Solidity sees.
 *
 * Robinhood Chain is Arbitrum Nitro: `block.number` in a contract returns the L1
 * number, while eth_blockNumber and every log carry the L2 number, millions
 * apart. The attested range must be L1; balances must be read at L2. Mixing them
 * makes every settlement revert with InvalidBlockRange.
 */
export async function toL1Block(rpc: RpcClient, l2Block: bigint): Promise<bigint> {
  const block = await rpc.call<{ l1BlockNumber?: string }>("eth_getBlockByNumber", [
    toBlockTag(l2Block),
    false,
  ]);
  if (block?.l1BlockNumber === undefined) {
    throw new Error(
      `Block ${l2Block} has no l1BlockNumber. This chain is not Arbitrum Nitro; the L2->L1 ` +
        "block mapping must be revisited before any attestation is built.",
    );
  }
  return hexToBigInt(block.l1BlockNumber);
}

export async function transactionCountAt(
  rpc: RpcClient,
  account: string,
  block: bigint,
): Promise<number> {
  return Number(hexToBigInt(await rpc.call<string>("eth_getTransactionCount", [account, toBlockTag(block)])));
}

export async function erc20BalanceAt(
  rpc: RpcClient,
  token: string,
  account: string,
  block: bigint,
): Promise<bigint> {
  const result = await rpc.call<string>("eth_call", [
    { to: token, data: `0x70a08231${normalize(account).slice(2).padStart(64, "0")}` },
    toBlockTag(block),
  ]);
  // An address with no code returns empty data rather than reverting. That is
  // not an error and must not abort the scan: a contract that does not exist yet
  // holds no balance for anyone, so the honest answer is zero.
  //
  // This is the common case, not a corner case. Traders here buy tokens minted
  // minutes earlier, so a session's opening boundary routinely sits before the
  // token was deployed. A genuine revert still throws from the RPC layer and
  // still refuses, which is the distinction that matters.
  if (result === "0x" || result === "") return 0n;
  return hexToBigInt(result);
}
