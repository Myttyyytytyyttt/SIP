// invest: the decision (policy.ts) and the crank (crank.ts). No network — the
// vault, its factory, the adapter registry and the pause controller are
// simulated by an `RpcClient` that decodes the calldata with the REAL artifact
// ABIs and answers from a state object, and a throwaway viem account stands in
// for Privy's enclave so the raw bytes — and therefore the transaction hash —
// are real.
//
// The pinned vectors (STORAGE_LOCATION, the slot numbers, BASKET_HASH) are
// computed here from first principles — VaultLens.sol's own source for the
// slots, a hand-built abi.encode for the hash — and must never be regenerated
// from the code under test.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  concat,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  hexToBigInt,
  keccak256,
  numberToHex,
  padHex,
  parseTransaction,
  toFunctionSelector,
  toHex,
  type Abi,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { abis } from "@nuvem/contracts-artifacts";

import { PAUSE_ABI, VAULT_ABI, VAULT_STORAGE_LOCATION } from "../src/attest/snapshot.js";
import {
  ADAPTER_REGISTRY_ABI,
  INVEST_DEADLINE_SECONDS,
  InvestBroadcastError,
  InvestError,
  SLOT_ADAPTER_ID,
  SLOT_BASKET_HASH,
  SLOT_INVESTMENT_LIMITS,
  SLOT_INVESTMENT_PACKED,
  SLOT_PAUSE_CONTROLLER,
  SLOT_WETH,
  BASKET_LOG_SPAN,
  BASKET_SPANS_PER_PASS,
  authorizedAccounts,
  cachedBasketSource,
  crankVault,
  decodeBasketLegs,
  decodeInvestmentLimits,
  decodeInvestmentPacked,
  encodeInvestCalldata,
  logBasketSource,
  planInvestment,
  readInvestSnapshot,
  runInvestCrank,
  submitInvestment,
  type BasketSource,
  type InvestSnapshot,
} from "../src/invest/crank.js";
import { basketHashOf, decideInvestment, legAmounts, zeroMinAmountsOut, type AdapterStatus } from "../src/invest/policy.js";
import type { SeatSigner, SeatTransaction } from "../src/pull/privy.js";
import type { Address, BasketLeg, Hex, InvestIntent, InvestOutcome, Ledger, RpcClient, RpcParams, VaultInvestmentPolicy } from "../src/types.js";

// ── the cast ────────────────────────────────────────────────────────────────

const CHAIN_ID = 4663;
const VAULT: Address = "0x1111111111111111111111111111111111111111";
const WALLET: Address = "0xc455bf7f16ebbc2b07cb26d1dd46194977974e7d";
const WALLET_B: Address = "0xcc051fed5cdcc3680aab268bea050dabbb99efe3";
const ADMIN: Address = "0xad1111111111111111111111111111111111111a";
const WETH: Address = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const PAUSE_CONTROLLER: Address = "0xbabe000000000000000000000000000000000001";
const REGISTRY: Address = "0xbabe000000000000000000000000000000000002";
const ADAPTER: Address = "0xadab000000000000000000000000000000000003";
const TOKEN_A: Address = "0xaaaa000000000000000000000000000000000001";
const TOKEN_B: Address = "0xbbbb000000000000000000000000000000000002";
const ADAPTER_ID: Hex = `0x${"77".repeat(32)}`;
const HEAD = 21_700_000n;
const NOW = 1_700_000_000n;

/** ~$5 of ETH at the sizes this protocol actually settles at. */
const MIN_INVESTMENT = 1_500_000_000_000_000n;
const MAX_PER_CALL = 10n ** 18n;
const ROLLING_REMAINING = 5n * 10n ** 18n;

const BASKET: readonly BasketLeg[] = [
  { targetAsset: TOKEN_A, weightBps: 6_000, minOutRateWad: 2_000_000_000_000_000_000n },
  { targetAsset: TOKEN_B, weightBps: 4_000, minOutRateWad: 3_000_000_000_000_000_000n },
];

/**
 * `keccak256(abi.encode(BasketLeg[]))`, assembled by hand: the array is dynamic,
 * so the head is a 0x20 offset, then the length, then three words per leg. This
 * is the vault's preimage written out rather than asked for.
 */
const BASKET_HASH: Hex = keccak256(
  concat([
    padHex("0x20", { size: 32 }),
    padHex(toHex(BASKET.length), { size: 32 }),
    ...BASKET.flatMap((leg) => [padHex(leg.targetAsset, { size: 32 }), padHex(toHex(leg.weightBps), { size: 32 }), padHex(toHex(leg.minOutRateWad), { size: 32 })]),
  ]),
);

const POLICY_NONCE = 4n;
const STATUS_EPOCH = 9n;

// ── the simulated chain ─────────────────────────────────────────────────────

interface SimState {
  head: bigint;
  chainId: number;
  policyNonce: bigint;
  /** What the pre-send re-read answers, when it differs from the snapshot's. */
  livePolicyNonce: bigint | null;
  enabled: boolean;
  paused: boolean;
  protocolPaused: boolean;
  adapterId: Hex;
  basketHash: Hex;
  minInvestmentWei: bigint;
  maxPerCallWei: bigint;
  rollingRemainingWei: bigint;
  wethBalanceWei: bigint;
  accountStatus: number;
  vaultAdmin: Address;
  adapter: Address;
  adapterActive: boolean;
  statusEpoch: bigint;
  /** null makes eth_estimateGas revert, exactly as a node refusing the call would. */
  estimateGas: bigint | null;
  baseFeePerGas: bigint;
  priorityFee: bigint;
  txCount: number;
  nativeBalanceWei: bigint;
  sendError: Error | null;
  /** The `InvestmentPolicyUpdated` emission the log source will find, if any. */
  policyLog: { legs: readonly BasketLeg[]; policyNonce: bigint; basketHash: Hex; blockL2: bigint } | null;
}

const baseState = (): SimState => ({
  head: HEAD,
  chainId: CHAIN_ID,
  policyNonce: POLICY_NONCE,
  livePolicyNonce: null,
  enabled: true,
  paused: false,
  protocolPaused: false,
  adapterId: ADAPTER_ID,
  basketHash: BASKET_HASH,
  minInvestmentWei: MIN_INVESTMENT,
  maxPerCallWei: MAX_PER_CALL,
  rollingRemainingWei: ROLLING_REMAINING,
  wethBalanceWei: 4_000_000_000_000_000n,
  accountStatus: 2,
  vaultAdmin: ADMIN,
  adapter: ADAPTER,
  adapterActive: true,
  statusEpoch: STATUS_EPOCH,
  estimateGas: 700_000n,
  baseFeePerGas: 100_000_000n,
  priorityFee: 0n,
  txCount: 7,
  nativeBalanceWei: 10n ** 17n,
  sendError: null,
  policyLog: { legs: BASKET, policyNonce: POLICY_NONCE, basketHash: BASKET_HASH, blockL2: HEAD - 1_000n },
});

interface Call {
  readonly method: string;
  readonly params: RpcParams;
}
interface SimRpc extends RpcClient {
  readonly calls: Call[];
  readonly state: SimState;
  readonly sent: Hex[];
}

const encode = (abi: Abi, functionName: string, value: unknown): Hex => encodeFunctionResult({ abi, functionName, result: value as never });

const word = (value: bigint): Hex => numberToHex(value, { size: 32 });

/** The `InvestmentPolicyUpdated` log the vault would have emitted for `state.policyLog`. */
function policyLogOf(state: SimState): Record<string, unknown> | null {
  const emission = state.policyLog;
  if (emission === null) return null;
  const encodedLegs = encodeAbiParameters(
    [{ type: "tuple[]", components: [{ name: "targetAsset", type: "address" }, { name: "weightBps", type: "uint16" }, { name: "minOutRateWad", type: "uint128" }] }],
    [emission.legs],
  );
  return {
    address: VAULT,
    topics: [
      keccak256(toHex("InvestmentPolicyUpdated(uint64,bytes32,bytes32,bool,uint128,uint128,uint128,bytes)")),
      padHex(toHex(emission.policyNonce), { size: 32 }),
      emission.basketHash,
      ADAPTER_ID,
    ],
    data: encodeAbiParameters(
      [{ type: "bool" }, { type: "uint128" }, { type: "uint128" }, { type: "uint128" }, { type: "bytes" }],
      [state.enabled, state.minInvestmentWei, state.maxPerCallWei, state.rollingRemainingWei, encodedLegs],
    ),
    blockNumber: numberToHex(emission.blockL2),
    transactionHash: `0x${"cd".repeat(32)}`,
    logIndex: "0x0",
  };
}

function extsload(state: SimState, slot: bigint): Hex {
  if (slot === SLOT_INVESTMENT_PACKED) {
    return word(state.policyNonce | (state.enabled ? 1n << 64n : 0n) | (state.paused ? 1n << 72n : 0n));
  }
  if (slot === SLOT_ADAPTER_ID) return state.adapterId;
  if (slot === SLOT_BASKET_HASH) return state.basketHash;
  if (slot === SLOT_INVESTMENT_LIMITS) return word(state.minInvestmentWei | (state.maxPerCallWei << 128n));
  if (slot === SLOT_WETH) return word(hexToBigInt(WETH));
  if (slot === SLOT_PAUSE_CONTROLLER) return word(hexToBigInt(PAUSE_CONTROLLER));
  return word(0n);
}

function ethCall(state: SimState, to: Address, data: Hex): Hex {
  const target = to.toLowerCase();
  if (target === VAULT) {
    const { functionName, args } = decodeFunctionData({ abi: VAULT_ABI, data });
    switch (functionName) {
      case "extsload":
        return encode(VAULT_ABI, functionName, extsload(state, hexToBigInt(String(args?.[0]) as Hex)));
      case "investmentRollingCapStatus":
        return encode(VAULT_ABI, functionName, {
          cap: state.rollingRemainingWei,
          spent: 0n,
          remaining: state.rollingRemainingWei,
          nextReleaseAt: 0,
          nextReleaseAmount: 0n,
        });
      case "investmentPolicyNonce":
        return encode(VAULT_ABI, functionName, state.livePolicyNonce ?? state.policyNonce);
      case "ADAPTER_REGISTRY":
        return encode(VAULT_ABI, functionName, REGISTRY);
      case "vaultAdmin":
        return encode(VAULT_ABI, functionName, state.vaultAdmin);
      case "getTradingAccount":
        return encode(VAULT_ABI, functionName, tradingAccount(state));
      default:
        break;
    }
  }
  if (target === REGISTRY) {
    const { functionName } = decodeFunctionData({ abi: ADAPTER_REGISTRY_ABI, data });
    if (functionName === "getAdapter") return encode(ADAPTER_REGISTRY_ABI, functionName, state.adapter);
    if (functionName === "isAdapterActive") return encode(ADAPTER_REGISTRY_ABI, functionName, state.adapterActive);
    if (functionName === "adapterStatusEpoch") return encode(ADAPTER_REGISTRY_ABI, functionName, state.statusEpoch);
  }
  if (target === PAUSE_CONTROLLER) {
    const { functionName } = decodeFunctionData({ abi: PAUSE_ABI, data });
    if (functionName === "paused") return encode(PAUSE_ABI, functionName, state.protocolPaused);
  }
  // balanceOf(address) on WETH: the raw selector `chain/reads.ts` uses.
  if (target === WETH && data.startsWith("0x70a08231")) return word(state.wethBalanceWei);
  // An address without code answers with empty data, exactly like a node would.
  return "0x";
}

/** The struct `getTradingAccount` returns; only `status` matters to the crank. */
const tradingAccount = (state: SimState): Record<string, unknown> => ({
  status: state.accountStatus,
  platformId: `0x${"00".repeat(32)}`,
  bindingEpoch: 3n,
  policyNonce: 1n,
  inviteNonce: 0n,
  inviteAdminEpoch: 0n,
  settlementNonce: 0n,
  activationBlock: 0n,
  revocationBlock: 0n,
  inviteDeadline: 0,
  policy: {
    savingsBps: 20,
    minContributionWei: 0n,
    maxPerSettlementWei: 0n,
    maxRolling30dWei: 0n,
    tradingFloorWei: 0n,
    gasReserveWei: 0n,
  },
});

function simRpc(overrides: Partial<SimState> = {}): SimRpc {
  const state: SimState = { ...baseState(), ...overrides };
  const calls: Call[] = [];
  const sent: Hex[] = [];
  return {
    calls,
    state,
    sent,
    async call<T>(method: string, params: RpcParams = []): Promise<T> {
      calls.push({ method, params });
      switch (method) {
        case "eth_blockNumber":
          return numberToHex(state.head) as T;
        case "eth_chainId":
          return numberToHex(BigInt(state.chainId)) as T;
        case "eth_call": {
          const [call] = params as [{ to: Address; data: Hex }, string];
          return ethCall(state, call.to, call.data) as T;
        }
        case "eth_getBlockByNumber": {
          // The node answers about the block it was ASKED for: `getLogs` checks
          // coverage by reading the last block of every chunk.
          const [tag] = params as [string, boolean];
          const number = tag === "latest" ? state.head : hexToBigInt(tag as Hex);
          if (number > state.head) return null as T;
          return { number: numberToHex(number), baseFeePerGas: numberToHex(state.baseFeePerGas) } as T;
        }
        case "eth_maxPriorityFeePerGas":
          return numberToHex(state.priorityFee) as T;
        case "eth_getTransactionCount":
          return numberToHex(BigInt(state.txCount)) as T;
        case "eth_getBalance":
          return numberToHex(state.nativeBalanceWei) as T;
        case "eth_estimateGas":
          if (state.estimateGas === null) throw new Error("execution reverted: InsufficientInvestmentOutput");
          return numberToHex(state.estimateGas) as T;
        case "eth_getLogs": {
          // Range-aware, because the basket source walks BACKWARDS in spans and
          // a mock that answers every range would hide that.
          const log = policyLogOf(state);
          if (log === null) return [] as T;
          const [filter] = params as [{ fromBlock: Hex; toBlock: Hex }];
          const at = hexToBigInt(log["blockNumber"] as Hex);
          const inRange = at >= hexToBigInt(filter.fromBlock) && at <= hexToBigInt(filter.toBlock);
          return (inRange ? [log] : []) as T;
        }
        case "eth_sendRawTransaction": {
          if (state.sendError !== null) throw state.sendError;
          sent.push((params as [Hex])[0]);
          return keccak256((params as [Hex])[0]) as T;
        }
        default:
          throw new Error(`simRpc: unexpected method ${method}`);
      }
    },
  };
}

/** An rpc that must never be called: the dry-run proof, and the "nothing was broadcast" proof. */
const throwingRpc: RpcClient = {
  async call(method: string): Promise<never> {
    throw new Error(`rpc.${method} must not be called`);
  },
};

const throwingSeat: SeatSigner = {
  async walletIdOf(): Promise<never> {
    throw new Error("seat.walletIdOf must not be called");
  },
  async signTransaction(): Promise<never> {
    throw new Error("seat.signTransaction must not be called");
  },
};

/** A seat backed by a throwaway local account: the signature is real, so keccak256(raw) is the real hash. */
const localSeat = (
  events: string[],
  options: { walletId?: string | null; signError?: Error } = {},
): SeatSigner & { readonly signed: SeatTransaction[] } => {
  const account = privateKeyToAccount(generatePrivateKey());
  const signed: SeatTransaction[] = [];
  return {
    signed,
    async walletIdOf() {
      events.push("seat.walletIdOf");
      return options.walletId === undefined ? "wallet-id-1" : options.walletId;
    },
    async signTransaction(_walletId, tx) {
      events.push("seat.signTransaction");
      if (options.signError) throw options.signError;
      signed.push(tx);
      return account.signTransaction({
        to: tx.to,
        data: tx.data,
        value: tx.value,
        nonce: tx.nonce,
        gas: tx.gas,
        maxFeePerGas: tx.maxFeePerGas,
        maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
        chainId: tx.chainId,
        type: "eip1559",
      });
    },
  };
};

const staticBasket = (legs: readonly BasketLeg[] | null = BASKET): BasketSource => ({
  async legsFor() {
    return legs;
  },
});

/**
 * A ledger that answers the one question the crank asks it and refuses every
 * other: the crank must journal an intent and touch nothing else.
 */
function recordingLedger(): { readonly ledger: Ledger; readonly records: { vault: Address; intent: InvestIntent | null; outcome: InvestOutcome }[] } {
  const records: { vault: Address; intent: InvestIntent | null; outcome: InvestOutcome }[] = [];
  const refuse = (name: string) => (): never => {
    throw new Error(`ledger.${name} must not be called by the crank`);
  };
  const ledger = {
    upsertWallets: refuse("upsertWallets"),
    walletStates: refuse("walletStates"),
    recordFills: refuse("recordFills"),
    recordExclusions: refuse("recordExclusions"),
    recordRefusals: refuse("recordRefusals"),
    advanceCursor: refuse("advanceCursor"),
    unwindowedFills: refuse("unwindowedFills"),
    openWindow: refuse("openWindow"),
    markWindow: refuse("markWindow"),
    recordPull: refuse("recordPull"),
    addOwed: refuse("addOwed"),
    addCollected: refuse("addCollected"),
    windowsByStatus: refuse("windowsByStatus"),
    close: refuse("close"),
    async recordInvestment(vault: Address, intent: InvestIntent | null, outcome: InvestOutcome) {
      records.push({ vault, intent, outcome });
    },
  } as unknown as Ledger;
  return { ledger, records };
}

/** A ledger the crank must not reach AT ALL — recordInvestment included: the dry-run proof. */
const refusingLedger = (): Ledger =>
  ({
    ...recordingLedger().ledger,
    async recordInvestment(): Promise<never> {
      throw new Error("ledger.recordInvestment must not be called: nothing was broadcast");
    },
  }) as Ledger;

const crankArgs = (rpc: RpcClient, extra: Partial<Parameters<typeof runInvestCrank>[0]> = {}): Parameters<typeof runInvestCrank>[0] => ({
  rpc,
  mode: "dry-run",
  vault: VAULT,
  accounts: [WALLET],
  seat: null,
  ledger: recordingLedger().ledger,
  nowSeconds: NOW,
  headL2: HEAD,
  basket: staticBasket(),
  ...extra,
});

// ── policy.ts: the decision ─────────────────────────────────────────────────

const policyOf = (overrides: Partial<VaultInvestmentPolicy> = {}): VaultInvestmentPolicy => ({
  enabled: true,
  paused: false,
  protocolPaused: false,
  policyNonce: POLICY_NONCE,
  adapterId: hexToBigInt(ADAPTER_ID),
  basketHash: BASKET_HASH,
  legs: BASKET,
  minInvestmentWei: MIN_INVESTMENT,
  maxPerCallWei: MAX_PER_CALL,
  rollingRemainingWei: ROLLING_REMAINING,
  wethBalanceWei: 4_000_000_000_000_000n,
  ...overrides,
});

const adapterOf = (overrides: Partial<AdapterStatus> = {}): AdapterStatus => ({
  adapter: ADAPTER,
  active: true,
  statusEpoch: STATUS_EPOCH,
  ...overrides,
});

describe("invest/policy — the basket hash is the compare-and-swap", () => {
  it("hashes abi.encode(BasketLeg[]) — checked against a hand-built preimage", () => {
    expect(basketHashOf(BASKET)).toBe(BASKET_HASH);
    // Order is part of the commitment, and so is every field.
    expect(basketHashOf([...BASKET].reverse())).not.toBe(BASKET_HASH);
    const first = BASKET[0];
    if (first === undefined) throw new Error("basket missing");
    expect(basketHashOf([{ ...first, weightBps: 6_001 }, ...BASKET.slice(1)])).not.toBe(BASKET_HASH);
  });

  it("splits the legs as invest() does, with the LAST leg absorbing the dust", () => {
    // 10_001 × 6000 / 10000 = 6000 (truncated), so the last leg takes 4001.
    expect(legAmounts(10_001n, BASKET)).toEqual([6_000n, 4_001n]);
    // The split is exact: the vault asserts an exact debit.
    for (const gross of [1n, 7n, 999n, 10n ** 18n + 1n]) {
      expect(legAmounts(gross, BASKET).reduce((a, b) => a + b, 0n)).toBe(gross);
    }
    // One leg takes everything.
    expect(legAmounts(123n, BASKET.slice(0, 1))).toEqual([123n]);
  });

  it("quotes no floor of its own: minAmountsOut is zeros, so the admin's minOutRateWad stands", () => {
    expect(zeroMinAmountsOut(BASKET)).toEqual([0n, 0n]);
  });
});

describe("invest/policy — every wait reason, and nothing unnamed", () => {
  const decide = (policy: Partial<VaultInvestmentPolicy>, adapter: Partial<AdapterStatus> = {}, basketNonce?: bigint) =>
    decideInvestment({ policy: policyOf(policy), adapter: adapterOf(adapter), basketPolicyNonce: basketNonce ?? null });

  it("DISABLED when the admin has not switched investing on", () => {
    expect(decide({ enabled: false })).toEqual({ kind: "wait", reason: "DISABLED" });
  });

  it("DISABLED when enabled with a zero minimum, which setInvestmentPolicy cannot produce", () => {
    const decision = decide({ minInvestmentWei: 0n });
    expect(decision).toMatchObject({ kind: "wait", reason: "DISABLED" });
    expect(decision.kind === "wait" && decision.detail).toMatch(/minInvestmentWei is 0/);
  });

  it("PAUSED and PROTOCOL_PAUSED are different stops", () => {
    expect(decide({ paused: true })).toEqual({ kind: "wait", reason: "PAUSED" });
    expect(decide({ protocolPaused: true })).toEqual({ kind: "wait", reason: "PROTOCOL_PAUSED" });
    // The vault's own pause is checked first: it is the one an operator set.
    expect(decide({ paused: true, protocolPaused: true })).toEqual({ kind: "wait", reason: "PAUSED" });
  });

  it("ADAPTER_NOT_REGISTERED and ADAPTER_DEACTIVATED, which the registry tells apart", () => {
    expect(decide({}, { adapter: "0x0000000000000000000000000000000000000000" })).toMatchObject({ kind: "wait", reason: "ADAPTER_NOT_REGISTERED" });
    // Registered but not active — deactivated, OR its runtime codehash moved.
    expect(decide({}, { active: false })).toMatchObject({ kind: "wait", reason: "ADAPTER_DEACTIVATED" });
  });

  it("NOTHING_TO_INVEST when no pull has landed yet", () => {
    expect(decide({ wethBalanceWei: 0n })).toEqual({ kind: "wait", reason: "NOTHING_TO_INVEST" });
  });

  it("CAP_EXHAUSTED when the rolling window cannot fit even a minimum call", () => {
    const decision = decide({ rollingRemainingWei: MIN_INVESTMENT - 1n, wethBalanceWei: MAX_PER_CALL });
    expect(decision).toMatchObject({ kind: "wait", reason: "CAP_EXHAUSTED" });
    // Not BELOW_MINIMUM: more WETH would not help, the wait is on the bucket.
    expect(decision.kind === "wait" && decision.detail).toMatch(/rolling cap/);
  });

  it("BELOW_MINIMUM is the vault's own threshold, not a constant in the worker", () => {
    expect(decide({ wethBalanceWei: MIN_INVESTMENT - 1n })).toMatchObject({ kind: "wait", reason: "BELOW_MINIMUM" });
    // Move the vault's minimum and the same balance becomes investable.
    expect(decide({ wethBalanceWei: MIN_INVESTMENT - 1n, minInvestmentWei: 1n })).toMatchObject({ kind: "invest" });
    // And exactly at the threshold it invests: `invest()` refuses only BELOW it.
    expect(decide({ wethBalanceWei: MIN_INVESTMENT })).toMatchObject({ kind: "invest", grossWei: MIN_INVESTMENT });
  });

  it("BASKET_UNKNOWN when the legs are not in hand, or do not hash to the vault's basket", () => {
    expect(decide({ legs: null })).toMatchObject({ kind: "wait", reason: "BASKET_UNKNOWN" });
    expect(decide({ legs: [] })).toMatchObject({ kind: "wait", reason: "BASKET_UNKNOWN" });
    const foreign = [{ targetAsset: TOKEN_A, weightBps: 10_000, minOutRateWad: 1n }];
    const decision = decide({ legs: foreign });
    expect(decision).toMatchObject({ kind: "wait", reason: "BASKET_UNKNOWN" });
    expect(decision.kind === "wait" && decision.detail).toMatch(/hash to/);
    // Nine legs is past NuvemTypes.MAX_BASKET_LEGS.
    const nine = Array.from({ length: 9 }, () => ({ targetAsset: TOKEN_A, weightBps: 1_111, minOutRateWad: 1n }));
    expect(decide({ legs: nine, basketHash: basketHashOf(nine) })).toMatchObject({ kind: "wait", reason: "BASKET_UNKNOWN" });
  });

  it("POLICY_NONCE_MOVED when the basket in hand belongs to a policy the admin replaced", () => {
    const decision = decide({}, {}, POLICY_NONCE - 1n);
    expect(decision).toMatchObject({ kind: "wait", reason: "POLICY_NONCE_MOVED" });
    expect(decision.kind === "wait" && decision.detail).toMatch(/nonce 3, the vault is at 4/);
  });

  it("LEG_ROUNDS_TO_ZERO rather than an invest() that reverts on a zero leg", () => {
    // 3 wei over a 6000/4000 split gives the first leg 1 and the second 2 — but
    // 1 wei gives the first leg 0, which the vault refuses.
    const tiny = { minInvestmentWei: 1n, wethBalanceWei: 1n };
    expect(decide(tiny)).toMatchObject({ kind: "wait", reason: "LEG_ROUNDS_TO_ZERO" });
  });
});

describe("invest/policy — the size, and what bounds it", () => {
  it("is min(balance, maxPerCall, rolling remaining), and says which one bound it", () => {
    expect(decideInvestment({ policy: policyOf({ wethBalanceWei: 10n ** 16n }), adapter: adapterOf() })).toMatchObject({
      kind: "invest",
      grossWei: 10n ** 16n,
      bound: "balance",
    });
    expect(decideInvestment({ policy: policyOf({ wethBalanceWei: 10n * MAX_PER_CALL }), adapter: adapterOf() })).toMatchObject({
      kind: "invest",
      grossWei: MAX_PER_CALL,
      bound: "maxPerCall",
    });
    expect(
      decideInvestment({ policy: policyOf({ wethBalanceWei: 10n * MAX_PER_CALL, rollingRemainingWei: MAX_PER_CALL / 2n }), adapter: adapterOf() }),
    ).toMatchObject({ kind: "invest", grossWei: MAX_PER_CALL / 2n, bound: "rollingCap" });
  });

  it("carries the epoch and the nonce invest() will compare against", () => {
    const decision = decideInvestment({ policy: policyOf(), adapter: adapterOf() });
    expect(decision).toMatchObject({
      kind: "invest",
      expectedAdapterStatusEpoch: STATUS_EPOCH,
      expectedInvestmentPolicyNonce: POLICY_NONCE,
      legs: BASKET,
      minAmountsOut: [0n, 0n],
    });
  });
});

// ── crank.ts: the slots, the read ───────────────────────────────────────────

describe("invest/crank — the slot map is VaultLens's, not a guess", () => {
  it("matches every investment constant in VaultLens.sol", () => {
    const source = readFileSync(new URL("../../contracts/src/periphery/VaultLens.sol", import.meta.url), "utf8");
    const offsetOf = (name: string): bigint => {
      const found = new RegExp(`${name} = BASE \\+ (\\d+);`).exec(source);
      if (found === null) throw new Error(`VaultLens.sol has no ${name}`);
      return BigInt(found[1] ?? "");
    };
    const base = /uint256 internal constant BASE =\s*uint256\((0x[0-9a-f]+)\);/.exec(source);
    expect(base).not.toBeNull();
    expect(hexToBigInt((base?.[1] ?? "0x0") as Hex)).toBe(VAULT_STORAGE_LOCATION);
    expect(SLOT_WETH).toBe(VAULT_STORAGE_LOCATION + offsetOf("SLOT_WETH"));
    expect(SLOT_PAUSE_CONTROLLER).toBe(VAULT_STORAGE_LOCATION + offsetOf("SLOT_PAUSE_CONTROLLER"));
    expect(SLOT_INVESTMENT_PACKED).toBe(VAULT_STORAGE_LOCATION + offsetOf("SLOT_INVESTMENT_PACKED"));
    expect(SLOT_ADAPTER_ID).toBe(VAULT_STORAGE_LOCATION + offsetOf("SLOT_ADAPTER_ID"));
    expect(SLOT_BASKET_HASH).toBe(VAULT_STORAGE_LOCATION + offsetOf("SLOT_BASKET_HASH"));
    expect(SLOT_INVESTMENT_LIMITS).toBe(VAULT_STORAGE_LOCATION + offsetOf("SLOT_INVESTMENT_LIMITS"));
  });

  it("unpacks nonce(0) | enabled(64) | paused(72), the layout after adapterRegistry left the slot", () => {
    expect(decodeInvestmentPacked(word(4n | (1n << 64n)))).toEqual({ policyNonce: 4n, enabled: true, paused: false });
    expect(decodeInvestmentPacked(word(4n | (1n << 64n) | (1n << 72n)))).toEqual({ policyNonce: 4n, enabled: true, paused: true });
    expect(decodeInvestmentPacked(word(0n))).toEqual({ policyNonce: 0n, enabled: false, paused: false });
    // The old layout (registry in the low 160 bits) would read a zero nonce and
    // both flags false — a vault that looks switched off however it is set.
    expect(decodeInvestmentLimits(word(MIN_INVESTMENT | (MAX_PER_CALL << 128n)))).toEqual({
      minInvestmentWei: MIN_INVESTMENT,
      maxPerCallWei: MAX_PER_CALL,
    });
  });
});

describe("invest/crank — readInvestSnapshot", () => {
  it("reads everything invest() checks, in one pass, pinned to one block", async () => {
    const rpc = simRpc();
    const snapshot = await readInvestSnapshot(rpc, VAULT.toUpperCase() as Address, [WALLET.toUpperCase() as Address]);

    expect(snapshot).toMatchObject({
      blockL2: HEAD,
      vault: VAULT,
      vaultAdmin: ADMIN,
      weth: WETH,
      adapterRegistry: REGISTRY,
      investableWei: 4_000_000_000_000_000n,
      accounts: [{ address: WALLET, status: 2 }],
      adapter: { adapter: ADAPTER, active: true, statusEpoch: STATUS_EPOCH },
    });
    expect(snapshot.policy).toEqual({
      enabled: true,
      paused: false,
      protocolPaused: false,
      policyNonce: POLICY_NONCE,
      adapterId: hexToBigInt(ADAPTER_ID),
      basketHash: BASKET_HASH,
      legs: null,
      minInvestmentWei: MIN_INVESTMENT,
      maxPerCallWei: MAX_PER_CALL,
      rollingRemainingWei: ROLLING_REMAINING,
      wethBalanceWei: 4_000_000_000_000_000n,
    });

    // One eth_blockNumber, and every read pinned to exactly that height.
    expect(rpc.calls.filter((c) => c.method === "eth_blockNumber")).toHaveLength(1);
    const tag = numberToHex(HEAD);
    for (const call of rpc.calls.filter((c) => c.method === "eth_call")) expect(call.params[1]).toBe(tag);
    // THE FACTORY IS NOT CONSULTED: `invest()` checks the vault's own mapping.
    expect(rpc.calls.some((c) => c.method === "eth_call" && (c.params[0] as { to: Address }).to.toLowerCase() !== VAULT && (c.params[0] as { to: Address }).to.toLowerCase() !== REGISTRY && (c.params[0] as { to: Address }).to.toLowerCase() !== PAUSE_CONTROLLER && (c.params[0] as { to: Address }).to.toLowerCase() !== WETH)).toBe(false);
  });

  it("authority is the vault's answer: the admin, or an ACTIVE trading account", async () => {
    const active = await readInvestSnapshot(simRpc(), VAULT, [WALLET]);
    expect(authorizedAccounts(active)).toEqual([WALLET]);

    // PAUSED (3) is bound but not authorised.
    const paused = await readInvestSnapshot(simRpc({ accountStatus: 3 }), VAULT, [WALLET]);
    expect(authorizedAccounts(paused)).toEqual([]);

    // The admin needs no trading-account status at all — `invest()` takes it
    // first. The worker holds no admin key; leaving the branch out would make
    // the crank disagree with the contract about who is allowed.
    const asAdmin = await readInvestSnapshot(simRpc({ accountStatus: 0, vaultAdmin: WALLET }), VAULT, [WALLET]);
    expect(authorizedAccounts(asAdmin)).toEqual([WALLET]);
  });
});

// ── crank.ts: the dry run, and the send ─────────────────────────────────────

const investDecision = () => {
  const decision = decideInvestment({ policy: policyOf(), adapter: adapterOf() });
  if (decision.kind !== "invest") throw new Error(`expected an invest decision, got ${decision.reason}`);
  return decision;
};

const snapshotOf = async (rpc: SimRpc, accounts: readonly Address[] = [WALLET]): Promise<InvestSnapshot> => readInvestSnapshot(rpc, VAULT, accounts);

describe("invest/crank — dry run is structural", () => {
  it("returns before the seat, the nonce or the estimate is touched", async () => {
    const snapshot = await snapshotOf(simRpc());
    const outcome = await submitInvestment({
      rpc: throwingRpc,
      mode: "dry-run",
      snapshot,
      decision: investDecision(),
      seat: throwingSeat,
      ledger: refusingLedger(),
      nowSeconds: NOW,
    });
    expect(outcome.kind).toBe("DRY_RUN");
    if (outcome.kind !== "DRY_RUN") throw new Error("unreachable");
    // And it says what it would have bought, to the wei.
    expect(outcome.intent).toEqual({
      vault: VAULT,
      account: WALLET,
      amountInWei: 4_000_000_000_000_000n,
      legs: BASKET,
      minAmountsOut: [0n, 0n],
      deadline: NOW + INVEST_DEADLINE_SECONDS,
      expectedAdapterStatusEpoch: STATUS_EPOCH,
      expectedInvestmentPolicyNonce: POLICY_NONCE,
    });
  });

  it("a whole dry-run pass reads the chain and sends nothing", async () => {
    const rpc = simRpc();
    const outcome = await runInvestCrank(crankArgs(rpc, { seat: throwingSeat }));
    expect(outcome.kind).toBe("DRY_RUN");
    expect(rpc.sent).toHaveLength(0);
    expect(rpc.calls.some((c) => c.method === "eth_sendRawTransaction")).toBe(false);
    // The legs are split 60/40, the way invest() will split them.
    if (outcome.kind !== "DRY_RUN") throw new Error("unreachable");
    expect(legAmounts(outcome.intent.amountInWei, outcome.intent.legs)).toEqual([2_400_000_000_000_000n, 1_600_000_000_000_000n]);
  });

  it("still says when no wallet could have signed: that is the operator's to fix, not the chain's", async () => {
    const outcome = await runInvestCrank(crankArgs(simRpc({ accountStatus: 3 }), { seat: throwingSeat }));
    expect(outcome).toMatchObject({ kind: "DEFERRED", reason: "NO_SEATED_ACCOUNT" });
  });
});

describe("invest/crank — the live path", () => {
  it("builds the calldata invest() expects, in the ordering that closes the crash window", async () => {
    const rpc = simRpc();
    const events: string[] = [];
    const seat = localSeat(events);
    const { ledger, records } = recordingLedger();
    const journalling: Ledger = {
      ...ledger,
      async recordInvestment(vault, intent, outcome) {
        events.push("ledger.recordInvestment");
        await ledger.recordInvestment?.(vault, intent, outcome);
      },
    };

    const outcome = await runInvestCrank(crankArgs(rpc, { mode: "live", seat, ledger: journalling }));
    expect(outcome.kind).toBe("SENT");
    if (outcome.kind !== "SENT") throw new Error("unreachable");

    // The calldata is PersonalVault.invest, carrying the vault's own basket.
    const data = encodeInvestCalldata(outcome.intent);
    const { functionName, args } = decodeFunctionData({ abi: VAULT_ABI, data });
    expect(functionName).toBe("invest");
    const [legs, amountIn, minAmountsOut, deadline, epoch, nonce] = args as [
      readonly { targetAsset: Address; weightBps: number; minOutRateWad: bigint }[],
      bigint,
      readonly bigint[],
      number,
      bigint,
      bigint,
    ];
    expect(legs.map((leg) => leg.targetAsset.toLowerCase())).toEqual([TOKEN_A, TOKEN_B]);
    expect(amountIn).toBe(4_000_000_000_000_000n);
    expect(minAmountsOut).toEqual([0n, 0n]);
    expect(BigInt(deadline)).toBe(NOW + INVEST_DEADLINE_SECONDS);
    expect(epoch).toBe(STATUS_EPOCH);
    expect(nonce).toBe(POLICY_NONCE);
    // The legs the vault will hash are the legs the vault holds.
    expect(basketHashOf(legs.map((leg) => ({ ...leg, targetAsset: leg.targetAsset.toLowerCase() as Address })))).toBe(BASKET_HASH);

    // VALUE IS ZERO: the WETH is the vault's, the wallet pays gas only.
    const parsed = parseTransaction(outcome.intent.rawTx);
    expect(parsed.value ?? 0n).toBe(0n);
    expect((parsed.to ?? "").toLowerCase()).toBe(VAULT);
    expect(parsed.data?.toLowerCase()).toBe(data.toLowerCase());
    expect(parsed.nonce).toBe(7);
    // The chain id came from the node that is about to broadcast it.
    expect(parsed.chainId).toBe(CHAIN_ID);
    // gas = estimate × 1.2, as the pull path pads its own.
    expect(parsed.gas).toBe((700_000n * 12n) / 10n);
    expect(outcome.intent.txHash).toBe(keccak256(outcome.intent.rawTx));

    // RECORD BEFORE SEND: the intent is durable before anything is on the wire.
    expect(events).toEqual(["seat.walletIdOf", "seat.signTransaction", "ledger.recordInvestment"]);
    expect(records[0]).toMatchObject({ vault: VAULT, outcome: { kind: "SENT" } });
    expect(records[0]?.intent?.txHash).toBe(outcome.intent.txHash);
    expect(rpc.sent).toEqual([outcome.intent.rawTx]);
  });

  it("signs with the first authorised wallet that still seats this app", async () => {
    const rpc = simRpc();
    const events: string[] = [];
    const seatOnSecond: SeatSigner = {
      async walletIdOf(address) {
        events.push(`walletIdOf:${address}`);
        return address === WALLET_B ? "wallet-id-b" : null;
      },
      signTransaction: localSeat(events).signTransaction,
    };
    const outcome = await runInvestCrank(crankArgs(rpc, { mode: "live", accounts: [WALLET, WALLET_B], seat: seatOnSecond }));
    expect(outcome.kind).toBe("SENT");
    if (outcome.kind !== "SENT") throw new Error("unreachable");
    expect(outcome.intent.account).toBe(WALLET_B);
    expect(events).toEqual([`walletIdOf:${WALLET}`, `walletIdOf:${WALLET_B}`, "seat.signTransaction"]);
  });

  it("defers when the policy nonce moved between the read and the signature — nothing is signed", async () => {
    const rpc = simRpc({ livePolicyNonce: POLICY_NONCE + 1n });
    const events: string[] = [];
    const outcome = await runInvestCrank(crankArgs(rpc, { mode: "live", seat: localSeat(events) }));
    expect(outcome).toMatchObject({ kind: "DEFERRED", reason: "POLICY_NONCE_MOVED" });
    expect(outcome.kind === "DEFERRED" && outcome.detail).toMatch(/4 -> 5/);
    // The seat was asked whether it exists, and never asked to sign.
    expect(events).toEqual(["seat.walletIdOf"]);
    expect(rpc.sent).toHaveLength(0);
  });

  it("raises rather than sending a call the node says would revert", async () => {
    const rpc = simRpc({ estimateGas: null });
    const events: string[] = [];
    await expect(runInvestCrank(crankArgs(rpc, { mode: "live", seat: localSeat(events) }))).rejects.toBeInstanceOf(InvestError);
    // Nothing was signed and nothing was sent; the pass logs it as the crank
    // failure it is rather than filing it under a reason the worker models.
    expect(events).toEqual(["seat.walletIdOf"]);
    expect(rpc.sent).toHaveLength(0);
  });

  it("defers when the signing wallet cannot pay for its own gas", async () => {
    const rpc = simRpc({ nativeBalanceWei: 1n });
    const events: string[] = [];
    const outcome = await runInvestCrank(crankArgs(rpc, { mode: "live", seat: localSeat(events) }));
    expect(outcome).toMatchObject({ kind: "DEFERRED", reason: "BELOW_GAS_FLOOR" });
    expect(outcome.kind === "DEFERRED" && outcome.detail).toMatch(/holds 1 wei/);
    expect(events).toEqual(["seat.walletIdOf"]);
    expect(rpc.sent).toHaveLength(0);
  });

  it("a revoked seat, a missing seat and a refusing seat are all named, and none of them sends", async () => {
    const revoked = await runInvestCrank(crankArgs(simRpc(), { mode: "live", seat: localSeat([], { walletId: null }) }));
    expect(revoked).toMatchObject({ kind: "DEFERRED", reason: "NO_SEATED_ACCOUNT" });
    const seatless = await runInvestCrank(crankArgs(simRpc(), { mode: "live", seat: null }));
    expect(seatless).toMatchObject({ kind: "DEFERRED", reason: "SIGNER_UNAVAILABLE" });
    const refusing = await runInvestCrank(crankArgs(simRpc(), { mode: "live", seat: localSeat([], { signError: new Error("policy refused") }) }));
    expect(refusing).toMatchObject({ kind: "DEFERRED", reason: "SIGNER_UNAVAILABLE" });
  });

  it("a send that fails after the record throws with the intent, never 'nothing happened'", async () => {
    const rpc = simRpc({ sendError: new Error(`timeout while broadcasting 0x${"ab".repeat(32)}`) });
    const { ledger, records } = recordingLedger();
    const error = await runInvestCrank(crankArgs(rpc, { mode: "live", seat: localSeat([]), ledger })).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InvestBroadcastError);
    if (!(error instanceof InvestBroadcastError)) throw new Error("unreachable");
    expect(error.intent.nonce).toBe(7);
    expect(records[0]?.intent?.txHash).toBe(error.intent.txHash);
    // No secrets — and no bare 64-hex — in the message.
    expect(error.message).toContain("[redacted]");
  });

  it("the seam passes the pass's clock and head straight through, and finds the basket itself", async () => {
    const rpc = simRpc();
    const outcome = await crankVault(rpc, "dry-run", VAULT, [WALLET], null, refusingLedger(), { unixSeconds: NOW, headL2: HEAD });
    expect(outcome.kind).toBe("DRY_RUN");
    if (outcome.kind !== "DRY_RUN") throw new Error("unreachable");
    expect(outcome.intent.deadline).toBe(NOW + INVEST_DEADLINE_SECONDS);
    // It found the basket on the vault's own log, with no source injected.
    expect(outcome.intent.legs).toEqual(BASKET);
    expect(rpc.calls.some((c) => c.method === "eth_getLogs")).toBe(true);
  });
});

describe("invest/crank — a log scan is paid for only when everything else says go", () => {
  it("does not look for the basket when the vault is paused", async () => {
    let looked = false;
    const outcome = await runInvestCrank(
      crankArgs(simRpc({ paused: true }), {
        basket: {
          async legsFor() {
            looked = true;
            return BASKET;
          },
        },
      }),
    );
    expect(outcome).toMatchObject({ kind: "DEFERRED", reason: "PAUSED" });
    expect(looked).toBe(false);
  });

  it("defers with BASKET_UNKNOWN when the legs cannot be recovered", async () => {
    const outcome = await runInvestCrank(crankArgs(simRpc(), { basket: staticBasket(null) }));
    expect(outcome).toMatchObject({ kind: "DEFERRED", reason: "BASKET_UNKNOWN" });
  });

  it("passes the vault's own reasons through, one for one", async () => {
    expect(await runInvestCrank(crankArgs(simRpc({ wethBalanceWei: 0n })))).toMatchObject({ kind: "DEFERRED", reason: "NOTHING_TO_INVEST" });
    expect(await runInvestCrank(crankArgs(simRpc({ wethBalanceWei: MIN_INVESTMENT - 1n })))).toMatchObject({ kind: "DEFERRED", reason: "BELOW_MINIMUM" });
    expect(await runInvestCrank(crankArgs(simRpc({ rollingRemainingWei: 1n })))).toMatchObject({ kind: "DEFERRED", reason: "CAP_EXHAUSTED" });
    expect(await runInvestCrank(crankArgs(simRpc({ adapterActive: false })))).toMatchObject({ kind: "DEFERRED", reason: "ADAPTER_DEACTIVATED" });
    expect(await runInvestCrank(crankArgs(simRpc({ protocolPaused: true })))).toMatchObject({ kind: "DEFERRED", reason: "PROTOCOL_PAUSED" });
    expect(await runInvestCrank(crankArgs(simRpc({ enabled: false })))).toMatchObject({ kind: "DEFERRED", reason: "DISABLED" });
  });

  it("the rolling cap binds the size when it is the smallest of the three", async () => {
    const bound = MIN_INVESTMENT * 2n;
    const outcome = await runInvestCrank(crankArgs(simRpc({ wethBalanceWei: MAX_PER_CALL, rollingRemainingWei: bound })));
    expect(outcome.kind).toBe("DRY_RUN");
    if (outcome.kind !== "DRY_RUN") throw new Error("unreachable");
    expect(outcome.intent.amountInWei).toBe(bound);
  });
});

describe("invest/crank — the plan is pure and the last look is one call", () => {
  it("the dry run's bytes are the bytes a live pass would sign", () => {
    const decision = investDecision();
    const plan = planInvestment(VAULT, WALLET, decision, NOW);
    expect(plan.data).toBe(encodeInvestCalldata(plan.call));
    expect(planInvestment(VAULT, WALLET, decision, NOW).data).toBe(plan.data);
    expect(plan.call.deadline).toBe(NOW + INVEST_DEADLINE_SECONDS);
    expect(plan.legAmountsWei).toEqual([2_400_000_000_000_000n, 1_600_000_000_000_000n]);
    expect(abis.PersonalVault.some((entry) => entry.type === "function" && entry.name === "invest")).toBe(true);
  });

  it("reads investmentPolicyNonce exactly once, at latest", async () => {
    const rpc = simRpc();
    await runInvestCrank(crankArgs(rpc, { mode: "live", seat: localSeat([]) }));
    const selector = toFunctionSelector("investmentPolicyNonce()");
    const nonceReads = rpc.calls.filter((c) => c.method === "eth_call" && (c.params[0] as { data: Hex }).data.startsWith(selector));
    expect(nonceReads).toHaveLength(1);
    // At `latest`, not at the snapshot's height: the whole point is to see a
    // policy the snapshot could not have seen.
    expect(nonceReads[0]?.params[1]).toBe("latest");
  });
});

// ── crank.ts: the basket, read off the vault's own log ──────────────────────

describe("invest/crank — the basket comes from the vault's own log", () => {
  it("decodes encodedLegs and names both indexed keys in the filter", async () => {
    const rpc = simRpc();
    const source = logBasketSource(rpc);
    expect(await source.legsFor(VAULT, POLICY_NONCE, BASKET_HASH, HEAD)).toEqual(BASKET);
    const filter = rpc.calls.find((c) => c.method === "eth_getLogs")?.params[0] as { topics: unknown[]; fromBlock: Hex; toBlock: Hex };
    // [signature, policyNonce, basketHash, adapterId] with the last a wildcard:
    // the two that are named make this the one emission that can be current.
    expect(filter.topics[1]).toBe(padHex(toHex(POLICY_NONCE), { size: 32 }));
    expect(filter.topics[2]).toBe(BASKET_HASH);
    expect(filter.topics[3] ?? null).toBeNull();
    // BACKWARDS from the head, one span at a time.
    expect(hexToBigInt(filter.toBlock)).toBe(HEAD);
    expect(hexToBigInt(filter.fromBlock)).toBe(HEAD - BASKET_LOG_SPAN + 1n);
  });

  it("gives up after a bounded number of spans, and resumes where it stopped", async () => {
    // An emission far below the head: this pass will not reach it.
    const rpc = simRpc({ policyLog: { legs: BASKET, policyNonce: POLICY_NONCE, basketHash: BASKET_HASH, blockL2: HEAD - 500_000n } });
    const source = logBasketSource(rpc);
    expect(await source.legsFor(VAULT, POLICY_NONCE, BASKET_HASH, HEAD)).toBeNull();
    const first = rpc.calls.filter((c) => c.method === "eth_getLogs");
    expect(first).toHaveLength(BASKET_SPANS_PER_PASS);

    // The next pass picks up below the floor the last one reached, rather than
    // rescanning the same eight spans forever.
    await source.legsFor(VAULT, POLICY_NONCE, BASKET_HASH, HEAD);
    const second = rpc.calls.filter((c) => c.method === "eth_getLogs").slice(first.length);
    const firstTop = hexToBigInt((first[0]?.params[0] as { toBlock: Hex }).toBlock);
    const secondTop = hexToBigInt((second[0]?.params[0] as { toBlock: Hex }).toBlock);
    expect(secondTop).toBeLessThan(firstTop);
    expect(secondTop).toBe(HEAD - BASKET_LOG_SPAN * BigInt(BASKET_SPANS_PER_PASS));
  });

  it("returns null when nothing was ever emitted, so the crank waits instead of guessing", async () => {
    const rpc = simRpc({ policyLog: null });
    expect(await logBasketSource(rpc).legsFor(VAULT, POLICY_NONCE, BASKET_HASH, HEAD)).toBeNull();
  });

  it("refuses legs that hash to something else — the log is data, not authority", () => {
    const one = [{ targetAsset: TOKEN_A, weightBps: 10_000, minOutRateWad: 1n }];
    const encoded = encodeAbiParameters(
      [{ type: "tuple[]", components: [{ name: "targetAsset", type: "address" }, { name: "weightBps", type: "uint16" }, { name: "minOutRateWad", type: "uint128" }] }],
      [one],
    );
    expect(() => decodeBasketLegs(encoded, BASKET_HASH)).toThrow(InvestError);
    expect(decodeBasketLegs(encoded, basketHashOf(one))).toEqual(one);
  });

  it("caches on (vault, nonce, hash) — all three move when the admin touches the policy", async () => {
    let calls = 0;
    const cached = cachedBasketSource({
      async legsFor() {
        calls += 1;
        return BASKET;
      },
    });
    await cached.legsFor(VAULT, POLICY_NONCE, BASKET_HASH, HEAD);
    await cached.legsFor(VAULT, POLICY_NONCE, BASKET_HASH, HEAD + 100n);
    expect(calls).toBe(1);
    // A new policy nonce is a different key, and is fetched.
    await cached.legsFor(VAULT, POLICY_NONCE + 1n, BASKET_HASH, HEAD);
    expect(calls).toBe(2);
  });
});
