// Every chain read the investment path needs, and nothing else.
//
// WHY IT IS SEPARATE FROM ChainAccess. That interface exists for settlement and
// is implemented once against viem and once against a fake in tests; bolting nine
// investment reads onto it would force every existing fake to grow methods no
// settlement test uses. This is its own narrow surface, so the settlement fakes
// stay untouched and the investment fakes stay small.
//
// WHAT IS DELIBERATELY NOT HERE: any decision. This module answers "what does the
// chain say", `decideInvestment` answers "should we", `planInvestment` answers
// "with what arguments". Keeping reads separate from judgement is what lets the
// judgement be tested exhaustively without an RPC.
//
// ONE READ IS NOT A READ AT ALL. The basket legs are recovered from an event, not
// from storage, because the vault stores only their hash — so `readBasketLegs`
// can fail in ways no eth_call can report, and it says so rather than returning
// an empty basket. An empty basket and an unreadable one look identical from the
// outside and mean completely different things.

import {
  decodeAbiParameters,
  decodeEventLog,
  encodeAbiParameters,
  keccak256,
  toEventSelector,
  toFunctionSelector,
  type Abi,
  type Address,
  type Hex,
} from "viem";

import type { BasketLeg } from "./investment-plan.js";
import {
  decodeInvestmentConfiguration,
  decodeSqrtPriceX96,
  decodeSwapFeePips,
  INVESTMENT_SLOT,
  POOL_MANAGER_POOLS_SLOT,
  POOL_STATE_LIQUIDITY_OFFSET,
  POOL_STATE_SLOT0_OFFSET,
  slotHex,
  type InvestmentConfiguration,
} from "./investment-state.js";
import type { PoolState } from "./quote.js";

// EVERY SELECTOR BELOW IS DERIVED FROM ITS SIGNATURE, never transcribed. A
// hand-copied selector is four bytes with no provenance: the first draft of this
// file carried 0x8f2b8d31 for ADAPTER_REGISTRY(), which is not that function, and
// nothing would have failed until an eth_call returned empty returndata that
// decoded to the zero address — a keeper reporting "no adapter registry" about a
// vault that has one.
export const EXTSLOAD_SELECTOR = toFunctionSelector("extsload(bytes32)");

/**
 * The raw access this module needs. Deliberately three methods: anything wider
 * would make the fake in tests a second implementation of viem.
 */
export interface InvestmentChainAccess {
  /** eth_call, returning raw returndata. */
  call(to: Address, data: Hex): Promise<Hex>;
  /** eth_getLogs, narrowed by the caller. */
  getLogs(filter: {
    address: Address;
    topics: (Hex | null)[];
    fromBlock: bigint;
    toBlock: bigint | "latest";
  }): Promise<readonly { data: Hex; topics: Hex[] }[]>;
  getBlockNumber(): Promise<bigint>;
}

const word = (value: Hex): bigint => BigInt(value);

/**
 * What an ERC-4626 says it would mint for `assets` of its underlying.
 *
 * previewDeposit AND NOT convertToShares, and not a share price either: EIP-4626
 * forbids previewDeposit from promising more than `deposit` delivers, so a floor
 * built on it can only ever be conservative. A vault with a deposit fee makes
 * every other method optimistic, and optimistic is the wrong direction for a
 * number whose whole job is to be a lower bound.
 *
 * Returns 0 when the call reverts, which a refusing or unreadable vault does —
 * and the planner turns a zero quote into a refusal rather than a purchase.
 */
export async function readPreviewDeposit(
  chain: InvestmentChainAccess,
  vault: Address,
  assets: bigint,
): Promise<bigint> {
  if (assets <= 0n) return 0n;
  const selector = toFunctionSelector("function previewDeposit(uint256) view returns (uint256)");
  try {
    return word(await chain.call(vault, `${selector}${encodeAbiParameters([{ type: "uint256" }], [assets]).slice(2)}` as Hex));
  } catch {
    return 0n;
  }
}

async function extsload(chain: InvestmentChainAccess, target: Address, slot: bigint): Promise<bigint> {
  return word(await chain.call(target, `${EXTSLOAD_SELECTOR}${slotHex(slot).slice(2)}` as Hex));
}

// ---------------------------------------------------------------------------
// The vault
// ---------------------------------------------------------------------------

/**
 * Whether this vault's implementation has the investment path at all.
 *
 * THE FIRST THING ANY OPERATOR HITS TODAY, because every vault on mainnet still
 * runs the pre-investment implementation: `extsload` does not exist on it, so the
 * eth_call reverts with empty returndata. Left unhandled that surfaces as a viem
 * stack trace about a failed RPC request — which reads like the endpoint is
 * broken, and sends whoever is on call to the wrong place entirely.
 *
 * `extsload` is the right probe rather than a version getter: it is the function
 * every investment read goes through, so if it answers, they all can.
 */
export async function hasInvestmentPath(chain: InvestmentChainAccess, vault: Address): Promise<boolean> {
  try {
    await extsload(chain, vault, INVESTMENT_SLOT.packed);
    return true;
  } catch {
    return false;
  }
}

export async function readInvestmentConfiguration(
  chain: InvestmentChainAccess,
  vault: Address,
): Promise<InvestmentConfiguration> {
  const [packed, adapterId, basketHash, limits, rollingCap] = await Promise.all([
    extsload(chain, vault, INVESTMENT_SLOT.packed),
    extsload(chain, vault, INVESTMENT_SLOT.adapterId),
    extsload(chain, vault, INVESTMENT_SLOT.basketHash),
    extsload(chain, vault, INVESTMENT_SLOT.limits),
    extsload(chain, vault, INVESTMENT_SLOT.rollingCap),
  ]);
  return decodeInvestmentConfiguration({ packed, adapterId, basketHash, limits, rollingCap });
}

/** `ADAPTER_REGISTRY()`, an implementation immutable rather than a storage slot. */
export const ADAPTER_REGISTRY_SELECTOR = toFunctionSelector("ADAPTER_REGISTRY()");

export async function readAdapterRegistry(chain: InvestmentChainAccess, vault: Address): Promise<Address> {
  const raw = await chain.call(vault, ADAPTER_REGISTRY_SELECTOR);
  return `0x${raw.slice(-40)}` as Address;
}

// ---------------------------------------------------------------------------
// The adapter registry
// ---------------------------------------------------------------------------

export interface AdapterStatus {
  readonly adapter: Address;
  readonly statusEpoch: bigint;
  readonly active: boolean;
}

const REGISTRY_SELECTOR = {
  statusEpoch: toFunctionSelector("adapterStatusEpoch(bytes32)"),
  isActive: toFunctionSelector("isAdapterActive(bytes32)"),
  getAdapter: toFunctionSelector("getAdapter(bytes32)"),
} as const;

/**
 * Resolves the vault's adapter and the epoch `invest` will be pinned against.
 *
 * THE EPOCH IS READ, NOT ASSUMED, AND IT IS WHY THIS IS THREE CALLS.
 * `invest` takes `expectedAdapterStatusEpoch` and the registry reverts if it has
 * moved on — that is the compare-and-swap protecting a vault from transacting
 * through an adapter the guardian deactivated between the keeper's read and the
 * transaction landing. Reading the epoch and passing it through is the whole
 * point; defaulting it would disable the guard while looking correct.
 */
export async function readAdapterStatus(
  chain: InvestmentChainAccess,
  registry: Address,
  adapterId: Hex,
): Promise<AdapterStatus> {
  const call = (selector: Hex): Promise<Hex> => chain.call(registry, `${selector}${adapterId.slice(2)}` as Hex);
  const [epochRaw, activeRaw, adapterRaw] = await Promise.all([
    call(REGISTRY_SELECTOR.statusEpoch),
    call(REGISTRY_SELECTOR.isActive),
    call(REGISTRY_SELECTOR.getAdapter),
  ]);
  return {
    adapter: `0x${adapterRaw.slice(-40)}` as Address,
    statusEpoch: word(epochRaw),
    active: word(activeRaw) === 1n,
  };
}

// ---------------------------------------------------------------------------
// The basket, which lives in an event
// ---------------------------------------------------------------------------

export type BasketRecovery =
  | { readonly kind: "LEGS"; readonly legs: readonly BasketLeg[] }
  /** No log carries this hash. NOT the same as an empty basket. */
  | { readonly kind: "NOT_FOUND"; readonly detail: string };

const INVESTMENT_POLICY_UPDATED_ABI = [
  {
    type: "event",
    name: "InvestmentPolicyUpdated",
    inputs: [
      { name: "policyNonce", type: "uint64", indexed: true },
      { name: "basketHash", type: "bytes32", indexed: true },
      { name: "adapterId", type: "bytes32", indexed: true },
      { name: "enabled", type: "bool", indexed: false },
      { name: "minInvestmentWei", type: "uint128", indexed: false },
      { name: "maxPerCallWei", type: "uint128", indexed: false },
      { name: "maxRolling30dWei", type: "uint128", indexed: false },
      { name: "encodedLegs", type: "bytes", indexed: false },
    ],
    anonymous: false,
  },
] as const satisfies Abi;

export const INVESTMENT_POLICY_UPDATED_TOPIC = toEventSelector(
  "InvestmentPolicyUpdated(uint64,bytes32,bytes32,bool,uint128,uint128,uint128,bytes)",
);

/**
 * Recovers the legs behind a stored basket hash.
 *
 * FILTERED ON THE HASH ITSELF, which is an indexed topic. That is not an
 * optimisation: it means the node can only return logs for the basket the vault
 * currently holds, so a superseded policy cannot be picked up by accident. The
 * keccak check afterwards is still worth its one hash, because the topic match is
 * asserted by the node rather than by us, and a node returning wrong logs is a
 * real failure mode.
 */
export async function readBasketLegs(
  chain: InvestmentChainAccess,
  vault: Address,
  basketHash: Hex,
  fromBlock: bigint,
): Promise<BasketRecovery> {
  if (basketHash === `0x${"0".repeat(64)}`) {
    return { kind: "NOT_FOUND", detail: "the vault has never had a basket set" };
  }

  const logs = await chain.getLogs({
    address: vault,
    topics: [INVESTMENT_POLICY_UPDATED_TOPIC, null, basketHash],
    fromBlock,
    toBlock: "latest",
  });

  if (logs.length === 0) {
    return {
      kind: "NOT_FOUND",
      detail:
        `no InvestmentPolicyUpdated log carries basket ${basketHash} at or after block ${fromBlock}. ` +
        "The legs exist only in that event, so this basket cannot be acted on until the log is reachable — " +
        "widen the scan range or use an archive endpoint.",
    };
  }

  // Last wins: the same basket can be set more than once, and the newest log is
  // the one whose other fields describe the live policy.
  const log = logs[logs.length - 1]!;
  let encodedLegs: Hex;
  try {
    const decoded = decodeEventLog({
      abi: INVESTMENT_POLICY_UPDATED_ABI,
      data: log.data,
      topics: log.topics as [Hex, ...Hex[]],
    });
    encodedLegs = (decoded.args as { encodedLegs: Hex }).encodedLegs;
  } catch (error) {
    return { kind: "NOT_FOUND", detail: `the log could not be decoded: ${(error as Error).message}` };
  }

  if (keccak256(encodedLegs) !== basketHash) {
    return {
      kind: "NOT_FOUND",
      detail:
        `the log's encodedLegs hash to ${keccak256(encodedLegs)} but the vault stores ${basketHash}; ` +
        "the endpoint returned a log that does not match the topic it was filtered on",
    };
  }

  const [legs] = decodeAbiBasket(encodedLegs);
  return { kind: "LEGS", legs };
}

/**
 * `abi.decode(bytes, (BasketLeg[]))`, mirroring `encodeBasket` field for field.
 *
 * The parameter description is written out again rather than shared with the
 * encoder ON PURPOSE: if the two were one constant, a wrong edit would change
 * both and the round-trip test would still pass while the hash diverged from
 * Solidity's. Two independent spellings mean the parity vectors can catch it.
 */
function decodeAbiBasket(encoded: Hex): [readonly BasketLeg[]] {
  const [raw] = decodeAbiParameters(
    [
      {
        type: "tuple[]",
        components: [
          { name: "targetAsset", type: "address" },
          { name: "weightBps", type: "uint16" },
          { name: "minOutRateWad", type: "uint128" },
        ],
      },
    ],
    encoded,
  );
  return [
    (raw as readonly { targetAsset: Address; weightBps: number; minOutRateWad: bigint }[]).map((leg) => ({
      targetAsset: leg.targetAsset,
      weightBps: Number(leg.weightBps),
      minOutRateWad: leg.minOutRateWad,
    })),
  ];
}

// ---------------------------------------------------------------------------
// Uniswap v4 pools
// ---------------------------------------------------------------------------

export function poolId(currency0: Address, currency1: Address, fee: number, tickSpacing: number): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [currency0, currency1, fee, tickSpacing, "0x0000000000000000000000000000000000000000"],
    ),
  );
}

/**
 * Reads a pool's price and depth straight out of the PoolManager's storage.
 *
 * WHY extsload RATHER THAN A QUOTER. There is no deployed Quoter on this chain
 * that this repo has verified, and a quote from an unverified contract is a
 * number whose provenance nobody can state. Two storage words are auditable.
 */
export async function readPoolState(
  chain: InvestmentChainAccess,
  poolManager: Address,
  id: Hex,
  zeroForOne: boolean,
): Promise<PoolState> {
  const base = BigInt(
    keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [id, POOL_MANAGER_POOLS_SLOT])),
  );
  const [slot0, liquidity] = await Promise.all([
    extsload(chain, poolManager, base + POOL_STATE_SLOT0_OFFSET),
    extsload(chain, poolManager, base + POOL_STATE_LIQUIDITY_OFFSET),
  ]);
  // THE FEE COMES OUT OF slot0, NOT OUT OF THE PoolKey. The key carries only the
  // lpFee; the pool also charges a protocol fee that a separate controller sets
  // and can change. Taking the key's number understated every quote by 6.23 bps
  // on the two pinned pools. See decodeSwapFeePips.
  return {
    sqrtPriceX96: decodeSqrtPriceX96(slot0),
    liquidity,
    feePips: decodeSwapFeePips(slot0, zeroForOne),
    zeroForOne,
  };
}
