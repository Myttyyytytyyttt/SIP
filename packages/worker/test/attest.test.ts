// attest: root, snapshot, phase0. No network: the vault, factory, executor,
// pause controller and registry are simulated by an RpcClient that decodes the
// calldata with the real artifact ABIs and answers from a state object; the
// executor's pure functions (deriveSessionId, hashAttestation, the contribution
// clamps) are reproduced here from SettlementExecutor.sol, NOT imported from
// src/attest, so the tests check the module against the contract rather than
// against itself. The L2 -> L1 mapping comes from the recorded mainnet fixture.
//
// The pinned vectors (ROOT, SESSION_ID, DIGEST, STORAGE_LOCATION, FRONTIER_SLOT)
// were computed once from first principles (manual abi.encode + keccak256, the
// 0x1901 || domainSeparator || structHash path) and must never be regenerated
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
  recoverTypedDataAddress,
  stringToHex,
  type Abi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { selectors } from "@nuvem/contracts-artifacts";
import type {
  Address,
  Fill,
  Hex,
  Recording,
  RpcClient,
  RpcParams,
  SettlementAttestation,
  VaultSnapshot,
  VolumeWindow,
} from "../src/types.js";
import { BATCH_ROOT_DOMAIN, batchRoot, sortedFillHashes } from "../src/attest/root.js";
import {
  ACCOUNT_STATUS_ACTIVE,
  AttestError,
  EXECUTOR_ABI,
  FACTORY_ABI,
  PAUSE_ABI,
  REGISTRY_ABI,
  SLOT_FRONTIER,
  VAULT_ABI,
  VAULT_STORAGE_LOCATION,
  ZERO_ADDRESS,
  asAddress,
  asBigInt,
  decodeFrontier,
  frontierSlot,
  readContract,
  readVaultSnapshot,
} from "../src/attest/snapshot.js";
import {
  ATTESTATION_TYPES,
  DEADLINE_SECONDS,
  DOMAIN_NAME,
  DOMAIN_VERSION,
  VALID_AFTER_SKEW_SECONDS,
  attestPhase0,
  attestationDomain,
  attesterFromAccount,
  deriveSessionIdLocal,
  encodeSettleCalldata,
  hashAttestationLocal,
  newestSettleableL2,
  toTypedMessage,
  type AttestOptions,
  type AttesterSigner,
} from "../src/attest/phase0.js";

// ── facts ───────────────────────────────────────────────────────────────────

const CHAIN_ID = 4663;
const WALLET: Address = "0xc455bf7f16ebbc2b07cb26d1dd46194977974e7d";
const VAULT: Address = "0x1111111111111111111111111111111111111111";
const OTHER_VAULT: Address = "0x1212121212121212121212121212121212121212";
const EXECUTOR: Address = "0xfa92abf15dfaf470cc8833cb01464bd6ca139e16";
const OTHER_EXECUTOR: Address = "0xce676c73000000000000000000000000000000ce";
const FACTORY: Address = "0x783bdf0281090f21928398cc3da19cfb64fed15e";
const PAUSE_CONTROLLER: Address = "0x2222222222222222222222222222222222222222";
const REGISTRY: Address = "0x3333333333333333333333333333333333333333";
const TOKEN: Address = "0x3792daef78e7c652c8ade7d1ad64fd398ed80056";
const POLICY_HASH: Hex = `0x${"ab".repeat(32)}`;

/** The window, in fixture blocks: (0x14c411c, 0x150ed52], head 0x15101f2 — all three recorded with `false`. */
const START_L2 = 21_774_620n;
const END_L2 = 22_080_850n;
const HEAD_L2 = 22_086_130n;
/** Their recorded l1BlockNumber values. */
const START_L1 = 25_632_836n;
const END_L1 = 25_635_384n;
const HEAD_L1 = 25_635_427n;

const NOW = 1_757_203_200n;

const FIXTURE: Recording = JSON.parse(readFileSync(new URL("./fixtures/mainnet-4663.json", import.meta.url), "utf8")) as Recording;

/** The artifact keys selectors by full signature ("settle((...),bytes)"); look one up by bare name. */
function selectorOf(contract: "SettlementExecutor" | "PersonalVault", name: string): Hex {
  const entry = Object.entries(selectors[contract].functions).find(([signature]) => signature.startsWith(`${name}(`));
  if (entry === undefined) throw new Error(`${contract} has no function ${name} in @nuvem/contracts-artifacts`);
  return entry[1];
}

function fill(txHash: Hex, blockL2: bigint, txIndex: number, side: "buy" | "sell", notionalWei: bigint, feeWei: bigint): Fill {
  return {
    wallet: WALLET,
    txHash,
    blockL2,
    txIndex,
    side,
    venue: "gmgn",
    tokenIn: side === "buy" ? "native" : TOKEN,
    tokenOut: side === "buy" ? TOKEN : "native",
    notionalWei,
    feeWei,
    source: "venue",
  };
}

/** The four GMGN fills of DESIGN.md §1, with the truths of the table. */
const FIXTURE_FILLS: readonly Fill[] = [
  fill("0x27259f99e2cbc54ff51e7193e020af3b3f69c021347448da59665c33c2eef882", 22_080_593n, 1, "buy", 20_000_000_000_000_000n, 200_000_000_000_000n),
  fill("0x5578486de21142788e3affadba58474f3bc37c68121ee232c8e16780513b8ae7", 21_787_563n, 26, "buy", 1_000_000_000_000_000n, 10_000_000_000_000n),
  fill("0x0688bd572526847b44963792025681b36e02cb42c7ce1470ed2476654ce4570d", 22_080_837n, 7, "sell", 22_251_309_406_981_553n, 222_513_094_069_815n),
  fill("0x0e5cd4ab4658c2a97eb64f02b42de93529ca9e45750c661621fca7f3eded6db7", 21_787_635n, 54, "sell", 906_846_740_302_383n, 9_068_467_403_023n),
];
const SUM_NOTIONAL = 44_158_156_147_283_936n;
const SAVINGS_BPS = 20;
const OWED = 88_316_312_294_567n; // floor(SUM_NOTIONAL * 20 / 10_000)

// ── pinned vectors (computed once, from first principles) ───────────────────

const ROOT: Hex = "0x93896fb9129f2fd98ede6286cc158dde48306b4206cd97a8915cc25c72c40ab9";
const EMPTY_ROOT: Hex = "0x96c9a1e5040c7af5128368dd770d059549f5ae8f77bfa41649fe9593d1fa5d5d";
const SESSION_ID: Hex = "0x672bb1ddeaee5b510f31d6e881fd3d1d304bf8dfb5ac97744ebbf3eb7666424c";
const TYPEHASH: Hex = "0x9bd2dea2a8725d725c0b7631f3b26111f1dd7142a802dd34794d9d32180d6aae";
const DOMAIN_SEPARATOR: Hex = "0xdb2a7a455d2ae078d903f1af2e559048df20b85083b966f3fa8a4e9f17993de8";
const DIGEST: Hex = "0x7305311f14cc90142e931171b3d39842bdb03efc7debd486d177525049d3539d";
const STORAGE_LOCATION: Hex = "0xe42e09f071b7e8aed0aad6a42ba1b4e3f8a0bc10a2919eea366981f9c3cd1200";
const FRONTIER_SLOT_EPOCH_3: Hex = "0x367fe9a14f48737f37f6e5f69d1436f8c4c264e47c7b76632c284560f4514532";

/** The literal from SettlementExecutor.sol line 25. */
const TYPE_STRING =
  "SettlementAttestation(address account,address vault,address executor,uint256 chainId,uint64 bindingEpoch,uint64 policyNonce,uint64 adminEpoch,uint64 localPauseEpoch,uint64 globalPauseEpoch,uint64 settlementNonce,bytes32 policyHash,bytes32 sessionId,bytes32 ledgerRoot,uint64 startBlock,uint64 endBlock,uint64 startBlockL2,uint64 endBlockL2,uint256 cashStart,uint256 cashEnd,uint256 externalDeposits,uint256 externalWithdrawals,int256 realizedProfit,uint256 contribution,uint32 attesterEpoch,uint48 validAfter,uint48 deadline)";

/** The attestation the pinned SESSION_ID and DIGEST were computed for. */
const PINNED_ATTESTATION: SettlementAttestation = {
  chainId: 4663n,
  vault: VAULT,
  account: WALLET,
  executor: EXECUTOR,
  bindingEpoch: 3n,
  policyNonce: 7n,
  settlementNonce: 5n,
  adminEpoch: 2n,
  localPauseEpoch: 1n,
  globalPauseEpoch: 4n,
  attesterEpoch: 1n,
  policyHash: POLICY_HASH,
  sessionId: SESSION_ID,
  ledgerRoot: ROOT,
  startBlock: START_L1,
  endBlock: END_L1,
  startBlockL2: START_L2,
  endBlockL2: END_L2,
  cashStart: 0n,
  cashEnd: SUM_NOTIONAL,
  externalDeposits: 0n,
  externalWithdrawals: 0n,
  realizedProfit: SUM_NOTIONAL,
  contribution: OWED,
  validAfter: NOW - 60n,
  deadline: NOW + 600n,
};

// ── the executor's pure functions, reproduced from SettlementExecutor.sol ───

/** _hashTypedDataV4(keccak256(abi.encode(TYPEHASH, ...fields))) — the Solidity path, not viem's. */
function solidityHashAttestation(chainId: bigint, executor: Address, a: SettlementAttestation): Hex {
  const typehash = keccak256(stringToHex(TYPE_STRING));
  const structHash = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint64" },
        { type: "uint64" },
        { type: "uint64" },
        { type: "uint64" },
        { type: "uint64" },
        { type: "uint64" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint64" },
        { type: "uint64" },
        { type: "uint64" },
        { type: "uint64" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "int256" },
        { type: "uint256" },
        { type: "uint32" },
        { type: "uint48" },
        { type: "uint48" },
      ],
      [
        typehash,
        a.account,
        a.vault,
        a.executor,
        a.chainId,
        a.bindingEpoch,
        a.policyNonce,
        a.adminEpoch,
        a.localPauseEpoch,
        a.globalPauseEpoch,
        a.settlementNonce,
        a.policyHash,
        a.sessionId,
        a.ledgerRoot,
        a.startBlock,
        a.endBlock,
        a.startBlockL2,
        a.endBlockL2,
        a.cashStart,
        a.cashEnd,
        a.externalDeposits,
        a.externalWithdrawals,
        a.realizedProfit,
        a.contribution,
        Number(a.attesterEpoch),
        Number(a.validAfter),
        Number(a.deadline),
      ],
    ),
  );
  const domainTypehash = keccak256(stringToHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));
  const domainSeparator = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [domainTypehash, keccak256(stringToHex(DOMAIN_NAME)), keccak256(stringToHex(DOMAIN_VERSION)), chainId, executor],
    ),
  );
  return keccak256(concat(["0x1901", domainSeparator, structHash]));
}

function solidityDeriveSessionId(args: readonly unknown[]): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "uint64" },
        { type: "uint64" },
        { type: "uint64" },
        { type: "uint64" },
        { type: "uint64" },
        { type: "bytes32" },
      ],
      args as [bigint, Address, Address, bigint, bigint, bigint, bigint, bigint, Hex],
    ),
  );
}

// ── the simulated chain ─────────────────────────────────────────────────────

interface TradingAccountState {
  status: number;
  platformId: Hex;
  bindingEpoch: bigint;
  policyNonce: bigint;
  inviteNonce: bigint;
  inviteAdminEpoch: bigint;
  settlementNonce: bigint;
  activationBlock: bigint;
  revocationBlock: bigint;
  inviteDeadline: number;
  policy: {
    savingsBps: number;
    minContributionWei: bigint;
    maxPerSettlementWei: bigint;
    maxRolling30dWei: bigint;
    tradingFloorWei: bigint;
    gasReserveWei: bigint;
  };
}

interface SimState {
  headL2: bigint;
  /** null → answer eth_getBlockByNumber from the recorded fixture. */
  l1Of: ((l2: bigint) => bigint) | null;
  activeVault: Address;
  account: TradingAccountState;
  policyHash: Hex;
  adminEpoch: bigint;
  localPauseEpoch: bigint;
  settlementPaused: boolean;
  vaultExecutor: Address;
  accountCapRemaining: bigint;
  aggregateCapRemaining: bigint;
  frontier: { endBlockL1: bigint; endBlockL2: bigint };
  pauseEpoch: bigint;
  paused: boolean;
  attesterEpoch: bigint;
  attester: Address;
  balance: bigint;
  /** null → eth_gasPrice fails. */
  gasPrice: bigint | null;
  previewReverts: boolean;
  previewOverride: bigint | null;
  hashAttestationOverride: Hex | null;
  sessionIdOverride: Hex | null;
}

const ATTESTER_KEY: Hex = `0x${"01".repeat(32)}`;
const ATTESTER = privateKeyToAccount(ATTESTER_KEY);

function baseState(): SimState {
  return {
    headL2: HEAD_L2,
    l1Of: null,
    activeVault: VAULT,
    account: {
      status: ACCOUNT_STATUS_ACTIVE,
      platformId: `0x${"cd".repeat(32)}`,
      bindingEpoch: 3n,
      policyNonce: 7n,
      inviteNonce: 0n,
      inviteAdminEpoch: 0n,
      settlementNonce: 5n,
      activationBlock: START_L1,
      revocationBlock: 0n,
      inviteDeadline: 0,
      policy: {
        savingsBps: SAVINGS_BPS,
        minContributionWei: 1_000_000_000_000n,
        maxPerSettlementWei: 10n ** 18n,
        maxRolling30dWei: 10n ** 18n,
        tradingFloorWei: 100_000_000_000_000n,
        gasReserveWei: 100_000_000_000_000n,
      },
    },
    policyHash: POLICY_HASH,
    adminEpoch: 2n,
    localPauseEpoch: 1n,
    settlementPaused: false,
    vaultExecutor: EXECUTOR,
    accountCapRemaining: 10n ** 18n,
    aggregateCapRemaining: 10n ** 18n,
    frontier: { endBlockL1: 0n, endBlockL2: 0n },
    pauseEpoch: 4n,
    paused: false,
    attesterEpoch: 1n,
    attester: ATTESTER.address.toLowerCase() as Address,
    balance: 50_000_000_000_000_000n,
    gasPrice: 28_000_000n,
    previewReverts: false,
    previewOverride: null,
    hashAttestationOverride: null,
    sessionIdOverride: null,
  };
}

interface Call {
  readonly method: string;
  readonly params: RpcParams;
}

type SimRpc = RpcClient & { readonly calls: Call[]; readonly state: SimState };

function record(state: SimState, abi: Abi, data: Hex): { functionName: string; args: readonly unknown[] } {
  const decoded = decodeFunctionData({ abi, data });
  return { functionName: decoded.functionName, args: (decoded.args ?? []) as readonly unknown[] };
}

function encode(abi: Abi, functionName: string, result: unknown): Hex {
  return encodeFunctionResult({ abi, functionName, result });
}

function simulateContribution(state: SimState, a: Record<string, unknown>): bigint {
  const profit =
    asBigInt(a["cashEnd"], "cashEnd") + asBigInt(a["externalWithdrawals"], "w") - asBigInt(a["cashStart"], "s") - asBigInt(a["externalDeposits"], "d");
  const policy = state.account.policy;
  if (profit <= 0n || policy.savingsBps === 0) return 0n;
  const min = (x: bigint, y: bigint): bigint => (x < y ? x : y);
  let c = (profit * BigInt(policy.savingsBps)) / 10_000n;
  c = min(c, policy.maxPerSettlementWei);
  c = min(c, state.accountCapRemaining);
  c = min(c, state.aggregateCapRemaining);
  const reserved = policy.tradingFloorWei + policy.gasReserveWei;
  const available = state.balance > reserved ? state.balance - reserved : 0n;
  return min(c, available);
}

function ethCall(state: SimState, to: Address, data: Hex): Hex {
  const target = to.toLowerCase();
  if (target === FACTORY) {
    const { functionName } = record(state, FACTORY_ABI, data);
    if (functionName === "activeVaultOf") return encode(FACTORY_ABI, functionName, state.activeVault);
  }
  // Both vaults exist and answer; which one claims the account is `state.activeVault`.
  if (target === VAULT || target === OTHER_VAULT) {
    const { functionName, args } = record(state, VAULT_ABI, data);
    switch (functionName) {
      case "getTradingAccount":
        return encode(VAULT_ABI, functionName, state.account);
      case "policyHash":
        return encode(VAULT_ABI, functionName, state.policyHash);
      case "adminEpoch":
        return encode(VAULT_ABI, functionName, state.adminEpoch);
      case "localPauseEpoch":
        return encode(VAULT_ABI, functionName, state.localPauseEpoch);
      case "settlementPaused":
        return encode(VAULT_ABI, functionName, state.settlementPaused);
      case "settlementExecutor":
        return encode(VAULT_ABI, functionName, state.vaultExecutor);
      case "accountRollingCapStatus":
        return encode(VAULT_ABI, functionName, { cap: 10n ** 18n, spent: 0n, remaining: state.accountCapRemaining, nextReleaseAt: 0, nextReleaseAmount: 0n });
      case "aggregateRollingCapStatus":
        return encode(VAULT_ABI, functionName, { cap: 10n ** 18n, spent: 0n, remaining: state.aggregateCapRemaining, nextReleaseAt: 0, nextReleaseAmount: 0n });
      case "extsload": {
        const slot = String(args[0]).toLowerCase();
        if (slot === frontierSlot(WALLET, state.account.bindingEpoch)) {
          const word = (state.frontier.endBlockL2 << 64n) | state.frontier.endBlockL1;
          return encode(VAULT_ABI, functionName, numberToHex(word, { size: 32 }));
        }
        return encode(VAULT_ABI, functionName, `0x${"0".repeat(64)}`);
      }
      default:
        break;
    }
  }
  if (target === EXECUTOR) {
    const { functionName, args } = record(state, EXECUTOR_ABI, data);
    switch (functionName) {
      case "pauseController":
        return encode(EXECUTOR_ABI, functionName, PAUSE_CONTROLLER);
      case "attesterRegistry":
        return encode(EXECUTOR_ABI, functionName, REGISTRY);
      case "deriveSessionId":
        return encode(EXECUTOR_ABI, functionName, state.sessionIdOverride ?? solidityDeriveSessionId(args));
      case "previewContribution": {
        if (state.previewReverts) throw new Error("execution reverted: InvalidVault(0x0000000000000000000000000000000000000000, 0x1111111111111111111111111111111111111111)");
        const a = args[0] as Record<string, unknown>;
        return encode(EXECUTOR_ABI, functionName, state.previewOverride ?? simulateContribution(state, a));
      }
      case "hashAttestation": {
        const a = args[0] as SettlementAttestation;
        return encode(EXECUTOR_ABI, functionName, state.hashAttestationOverride ?? solidityHashAttestation(BigInt(CHAIN_ID), EXECUTOR, a));
      }
      default:
        break;
    }
  }
  if (target === PAUSE_CONTROLLER) {
    const { functionName } = record(state, PAUSE_ABI, data);
    if (functionName === "pauseEpoch") return encode(PAUSE_ABI, functionName, state.pauseEpoch);
    if (functionName === "paused") return encode(PAUSE_ABI, functionName, state.paused);
  }
  if (target === REGISTRY) {
    const { functionName } = record(state, REGISTRY_ABI, data);
    if (functionName === "attester") return encode(REGISTRY_ABI, functionName, state.attester);
    if (functionName === "attesterEpoch") return encode(REGISTRY_ABI, functionName, state.attesterEpoch);
  }
  // An address without code answers with empty data, exactly like a node would.
  return "0x";
}

function simRpc(state: SimState = baseState()): SimRpc {
  const calls: Call[] = [];
  return {
    calls,
    state,
    async call<T>(method: string, params: RpcParams = []): Promise<T> {
      calls.push({ method, params });
      switch (method) {
        case "eth_blockNumber":
          return numberToHex(state.headL2) as T;
        case "eth_gasPrice":
          if (state.gasPrice === null) throw new Error("eth_gasPrice unavailable");
          return numberToHex(state.gasPrice) as T;
        case "eth_getBalance":
          return numberToHex(state.balance) as T;
        case "eth_call": {
          const [call] = params as [{ to: Address; data: Hex }, string];
          return ethCall(state, call.to, call.data) as T;
        }
        case "eth_getBlockByNumber": {
          const [tag] = params as [string, boolean];
          const l2 = hexToBigInt(tag as Hex);
          if (state.l1Of !== null) {
            return { number: numberToHex(l2), l1BlockNumber: numberToHex(state.l1Of(l2)) } as T;
          }
          const key = `eth_getBlockByNumber|${JSON.stringify([numberToHex(l2), false])}`;
          const recorded = FIXTURE[key];
          if (recorded === undefined) throw new Error(`block ${l2} is not in the fixture`);
          return recorded as T;
        }
        default:
          throw new Error(`simRpc: unexpected method ${method}`);
      }
    },
  };
}

function fixtureWindow(overrides: Partial<VolumeWindow> = {}): VolumeWindow {
  return {
    wallet: WALLET,
    vault: VAULT,
    startL2: START_L2,
    endL2: END_L2,
    fills: FIXTURE_FILLS,
    sumNotionalWei: SUM_NOTIONAL,
    savingsBps: SAVINGS_BPS,
    owedWei: OWED,
    batchRoot: ROOT,
    ...overrides,
  };
}

/** A signer that must never be reached. */
function throwingSigner(address: Address = ATTESTER.address): AttesterSigner & { readonly touched: () => number } {
  let count = 0;
  return {
    address,
    touched: () => count,
    async signTypedData() {
      count += 1;
      throw new Error("the signer was touched");
    },
  };
}

/** A viem LocalAccount satisfies TypedDataSigner structurally; the adapter widens it to the module contract. */
const realSigner: AttesterSigner = attesterFromAccount(ATTESTER);

// ── root ────────────────────────────────────────────────────────────────────

describe("attest/root", () => {
  it("commits to the four fixture fills with the pinned root, recomputable from a public RPC", () => {
    expect(batchRoot(CHAIN_ID, WALLET, FIXTURE_FILLS)).toBe(ROOT);
    // The documented encoding, written out: keccak256(abi.encode(tag, chainId, wallet, bytes32[] sorted)).
    const manual = keccak256(
      encodeAbiParameters(
        [{ type: "string" }, { type: "uint256" }, { type: "address" }, { type: "bytes32[]" }],
        [BATCH_ROOT_DOMAIN, 4663n, WALLET, [...FIXTURE_FILLS.map((f) => f.txHash)].sort()],
      ),
    );
    expect(manual).toBe(ROOT);
    expect(BATCH_ROOT_DOMAIN).toBe("sip.volume.v1");
  });

  it("is order-independent", () => {
    const reversed = [...FIXTURE_FILLS].reverse();
    const rotated = [...FIXTURE_FILLS.slice(2), ...FIXTURE_FILLS.slice(0, 2)];
    expect(batchRoot(CHAIN_ID, WALLET, reversed)).toBe(ROOT);
    expect(batchRoot(CHAIN_ID, WALLET, rotated)).toBe(ROOT);
    // Uppercase hashes are the same commitment.
    const upper = FIXTURE_FILLS.map((f) => ({ ...f, txHash: `0x${f.txHash.slice(2).toUpperCase()}` as Hex }));
    expect(batchRoot(CHAIN_ID, WALLET, upper)).toBe(ROOT);
  });

  it("is domain-separated by chain and wallet", () => {
    expect(batchRoot(1, WALLET, FIXTURE_FILLS)).not.toBe(ROOT);
    expect(batchRoot(CHAIN_ID, "0xcc051fed5cdcc3680aab268bea050dabbb99efe3", FIXTURE_FILLS.map((f) => ({ ...f, wallet: "0xcc051fed5cdcc3680aab268bea050dabbb99efe3" as Address }))))
      .not.toBe(ROOT);
    // A subset is a different claim.
    expect(batchRoot(CHAIN_ID, WALLET, FIXTURE_FILLS.slice(0, 3))).not.toBe(ROOT);
  });

  it("has a stable root for an empty fill list, distinct from any non-empty one", () => {
    expect(batchRoot(CHAIN_ID, WALLET, [])).toBe(EMPTY_ROOT);
    expect(EMPTY_ROOT).not.toBe(ROOT);
  });

  it("lists the hashes sorted and lowercase", () => {
    const hashes = sortedFillHashes(WALLET, FIXTURE_FILLS);
    expect(hashes).toEqual([...hashes].sort());
    expect(hashes[0]).toBe("0x0688bd572526847b44963792025681b36e02cb42c7ce1470ed2476654ce4570d");
    expect(hashes.every((h) => h === h.toLowerCase())).toBe(true);
  });

  it("refuses rather than guesses: another wallet's fill, a repeated hash, a malformed hash, a bad chain", () => {
    const first = FIXTURE_FILLS[0];
    if (first === undefined) throw new Error("fixture fills missing");
    const foreign: Fill = { ...first, wallet: "0xcc051fed5cdcc3680aab268bea050dabbb99efe3" };
    expect(() => batchRoot(CHAIN_ID, WALLET, [...FIXTURE_FILLS, foreign])).toThrow(/belongs to/);
    expect(() => batchRoot(CHAIN_ID, WALLET, [...FIXTURE_FILLS, first])).toThrow(/appears twice/);
    expect(() => batchRoot(CHAIN_ID, WALLET, [{ ...first, txHash: "0x1234" }])).toThrow(/malformed/);
    expect(() => batchRoot(0, WALLET, FIXTURE_FILLS)).toThrow(/chainId/);
    expect(() => batchRoot(1.5, WALLET, FIXTURE_FILLS)).toThrow(/chainId/);
  });
});

// ── snapshot ────────────────────────────────────────────────────────────────

describe("attest/snapshot", () => {
  it("recomputes PersonalVault's ERC-7201 storage location and VaultLens' measured frontier slot", () => {
    expect(numberToHex(VAULT_STORAGE_LOCATION, { size: 32 })).toBe(STORAGE_LOCATION);
    expect(SLOT_FRONTIER).toBe(VAULT_STORAGE_LOCATION + 11n);
    expect(frontierSlot(WALLET, 3n)).toBe(FRONTIER_SLOT_EPOCH_3);
    // mapping(address => mapping(uint64 => struct)): keccak(h(epoch) . keccak(h(account) . slot)).
    const inner = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [WALLET, VAULT_STORAGE_LOCATION + 11n]));
    expect(frontierSlot(WALLET, 3n)).toBe(keccak256(encodeAbiParameters([{ type: "uint64" }, { type: "bytes32" }], [3n, inner])));
    expect(frontierSlot(WALLET, 4n)).not.toBe(FRONTIER_SLOT_EPOCH_3);
  });

  it("unpacks SettlementFrontier { uint64 endBlockL1; uint64 endBlockL2 } low-to-high", () => {
    const word = numberToHex((9n << 64n) | 5n, { size: 32 });
    expect(decodeFrontier(word)).toEqual({ endBlockL1: 5n, endBlockL2: 9n });
    expect(decodeFrontier(`0x${"0".repeat(64)}`)).toEqual({ endBlockL1: 0n, endBlockL2: 0n });
  });

  it("reads everything settle() compares, in one pass, pinned to one block", async () => {
    const rpc = simRpc();
    rpc.state.frontier = { endBlockL1: 25_632_000n, endBlockL2: 21_700_000n };
    const snapshot = await readVaultSnapshot(rpc, FACTORY, EXECUTOR, WALLET);

    const expected: VaultSnapshot = {
      vault: VAULT,
      account: WALLET,
      status: 2,
      bindingEpoch: 3n,
      policyNonce: 7n,
      settlementNonce: 5n,
      policyHash: POLICY_HASH,
      adminEpoch: 2n,
      localPauseEpoch: 1n,
      globalPauseEpoch: 4n,
      attesterEpoch: 1n,
      activationBlockL1: START_L1,
      savingsBps: SAVINGS_BPS,
      minContributionWei: 1_000_000_000_000n,
      maxPerSettlementWei: 10n ** 18n,
      tradingFloorWei: 100_000_000_000_000n,
      gasReserveWei: 100_000_000_000_000n,
      accountRollingRemainingWei: 10n ** 18n,
      aggregateRollingRemainingWei: 10n ** 18n,
      settlementPaused: false,
      protocolPaused: false,
      executor: EXECUTOR,
      frontierEndL2: 21_700_000n,
      nativeBalanceWei: 50_000_000_000_000_000n,
    };
    expect(snapshot).toEqual(expected);

    // One eth_blockNumber, then every read at exactly that height.
    const heads = rpc.calls.filter((c) => c.method === "eth_blockNumber");
    expect(heads).toHaveLength(1);
    const tag = numberToHex(HEAD_L2);
    const reads = rpc.calls.filter((c) => c.method === "eth_call" || c.method === "eth_getBalance");
    expect(reads.length).toBeGreaterThanOrEqual(15);
    for (const read of reads) expect(read.params[1]).toBe(tag);
    // The frontier came through extsload at the measured slot.
    const extsload = reads.find((c) => c.method === "eth_call" && String((c.params[0] as { data: Hex }).data).startsWith(selectorOf("PersonalVault", "extsload")));
    expect(extsload).toBeDefined();
    expect(String((extsload?.params[0] as { data: Hex }).data).slice(10)).toBe(frontierSlot(WALLET, 3n).slice(2));
  });

  it("an account no vault claims is status NONE with nothing to settle into, without a vault read", async () => {
    const rpc = simRpc();
    rpc.state.activeVault = ZERO_ADDRESS;
    const snapshot = await readVaultSnapshot(rpc, FACTORY, EXECUTOR, WALLET);
    expect(snapshot.vault).toBe(ZERO_ADDRESS);
    expect(snapshot.status).toBe(0);
    expect(snapshot.executor).toBe(ZERO_ADDRESS);
    expect(snapshot.account).toBe(WALLET);
    const vaultReads = rpc.calls.filter((c) => c.method === "eth_call" && (c.params[0] as { to: Address }).to.toLowerCase() === VAULT);
    expect(vaultReads).toHaveLength(0);
  });

  it("empty return data is an AttestError, never a zero", async () => {
    const rpc = simRpc();
    // A factory that is not deployed at this address answers 0x.
    await expect(readVaultSnapshot(rpc, "0x4444444444444444444444444444444444444444", EXECUTOR, WALLET)).rejects.toBeInstanceOf(AttestError);
    await expect(readContract(rpc, "0x4444444444444444444444444444444444444444", FACTORY_ABI, "activeVaultOf", [WALLET], "latest")).rejects.toThrow(/no data/);
  });

  it("narrows chain answers at the boundary", () => {
    expect(asBigInt("0x10", "x")).toBe(16n);
    expect(asBigInt(7, "x")).toBe(7n);
    expect(asBigInt(7n, "x")).toBe(7n);
    expect(() => asBigInt("seven", "x")).toThrow(AttestError);
    expect(asAddress("0xFA92ABF15DFAF470CC8833CB01464BD6CA139E16", "x")).toBe(EXECUTOR);
    expect(() => asAddress("0x1234", "x")).toThrow(AttestError);
  });
});

// ── phase0: EIP-712 material ────────────────────────────────────────────────

describe("attest/phase0 — EIP-712 material", () => {
  it("ATTESTATION_TYPES encodes to the contract's exact type string and TYPEHASH", () => {
    const typeString = `SettlementAttestation(${ATTESTATION_TYPES.SettlementAttestation.map((f) => `${f.type} ${f.name}`).join(",")})`;
    expect(typeString).toBe(TYPE_STRING);
    expect(keccak256(stringToHex(typeString))).toBe(TYPEHASH);
    expect(ATTESTATION_TYPES.SettlementAttestation).toHaveLength(26);
  });

  it("the domain is EIP712('Nuvem Settlement Executor', '1') at the executor on 4663", () => {
    const domain = attestationDomain(CHAIN_ID, EXECUTOR);
    expect(domain).toEqual({ name: "Nuvem Settlement Executor", version: "1", chainId: 4663, verifyingContract: EXECUTOR });
    const domainTypehash = keccak256(stringToHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));
    const separator = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
        [domainTypehash, keccak256(stringToHex(DOMAIN_NAME)), keccak256(stringToHex(DOMAIN_VERSION)), 4663n, EXECUTOR],
      ),
    );
    expect(separator).toBe(DOMAIN_SEPARATOR);
  });

  it("hashAttestationLocal round-trips to the pinned digest and to the Solidity computation", () => {
    expect(hashAttestationLocal(CHAIN_ID, EXECUTOR, PINNED_ATTESTATION)).toBe(DIGEST);
    expect(solidityHashAttestation(4663n, EXECUTOR, PINNED_ATTESTATION)).toBe(DIGEST);
    // Every field is load-bearing: flip one and the digest moves.
    expect(hashAttestationLocal(CHAIN_ID, EXECUTOR, { ...PINNED_ATTESTATION, contribution: OWED + 1n })).not.toBe(DIGEST);
    expect(hashAttestationLocal(CHAIN_ID, EXECUTOR, { ...PINNED_ATTESTATION, endBlockL2: END_L2 + 1n })).not.toBe(DIGEST);
    expect(hashAttestationLocal(1, EXECUTOR, PINNED_ATTESTATION)).not.toBe(DIGEST);
    expect(hashAttestationLocal(CHAIN_ID, OTHER_EXECUTOR, PINNED_ATTESTATION)).not.toBe(DIGEST);
  });

  it("toTypedMessage narrows only the three sub-64-bit fields and refuses overflow", () => {
    const message = toTypedMessage(PINNED_ATTESTATION);
    expect(message.attesterEpoch).toBe(1);
    expect(message.validAfter).toBe(Number(NOW - 60n));
    expect(message.deadline).toBe(Number(NOW + 600n));
    expect(message.bindingEpoch).toBe(3n);
    expect(() => toTypedMessage({ ...PINNED_ATTESTATION, attesterEpoch: 1n << 32n })).toThrow(/attesterEpoch/);
    expect(() => toTypedMessage({ ...PINNED_ATTESTATION, deadline: 1n << 48n })).toThrow(/deadline/);
  });

  it("deriveSessionIdLocal matches the pinned replay key and commits to both ranges", () => {
    const inputs = {
      chainId: 4663n,
      vault: VAULT,
      account: WALLET,
      bindingEpoch: 3n,
      startBlockL1: START_L1,
      endBlockL1: END_L1,
      startBlockL2: START_L2,
      endBlockL2: END_L2,
      ledgerRoot: ROOT,
    };
    expect(deriveSessionIdLocal(inputs)).toBe(SESSION_ID);
    expect(deriveSessionIdLocal({ ...inputs, endBlockL2: END_L2 + 1n })).not.toBe(SESSION_ID);
    expect(deriveSessionIdLocal({ ...inputs, endBlockL1: END_L1 + 1n })).not.toBe(SESSION_ID);
    expect(deriveSessionIdLocal({ ...inputs, ledgerRoot: EMPTY_ROOT })).not.toBe(SESSION_ID);
  });

  it("encodeSettleCalldata uses the artifact's settle selector and decodes back to the attestation", () => {
    const signature: Hex = `0x${"11".repeat(65)}`;
    const calldata = encodeSettleCalldata(PINNED_ATTESTATION, signature);
    expect(calldata.slice(0, 10)).toBe(selectorOf("SettlementExecutor", "settle"));
    const decoded = decodeFunctionData({ abi: EXECUTOR_ABI, data: calldata });
    expect(decoded.functionName).toBe("settle");
    const [attestation, sig] = decoded.args as [Record<string, unknown>, Hex];
    expect(sig).toBe(signature);
    expect(attestation["contribution"]).toBe(OWED);
    expect(attestation["ledgerRoot"]).toBe(ROOT);
    expect(attestation["sessionId"]).toBe(SESSION_ID);
    expect(attestation["startBlock"]).toBe(START_L1);
    expect(attestation["endBlockL2"]).toBe(END_L2);
    expect(String(attestation["account"]).toLowerCase()).toBe(WALLET);
    expect(attestation["validAfter"]).toBe(Number(NOW - 60n));
  });
});

// ── phase0: attestPhase0 ────────────────────────────────────────────────────

async function runAttest(
  mutate: (state: SimState) => void = () => {},
  afterSnapshot: (state: SimState) => void = () => {},
  signer: AttesterSigner = throwingSigner(),
  window: VolumeWindow = fixtureWindow(),
  options: AttestOptions = {},
): Promise<{ outcome: Awaited<ReturnType<typeof attestPhase0>>; rpc: SimRpc; snapshot: VaultSnapshot }> {
  const rpc = simRpc();
  mutate(rpc.state);
  const snapshot = await readVaultSnapshot(rpc, FACTORY, EXECUTOR, WALLET);
  afterSnapshot(rpc.state);
  rpc.calls.length = 0;
  const outcome = await attestPhase0(rpc, EXECUTOR, window, snapshot, signer, { unixSeconds: NOW, headL2: rpc.state.headL2 }, options);
  return { outcome, rpc, snapshot };
}

/** The newest fill in the fixture window: the block the walk-back must never go below. */
const NEWEST_FILL_L2 = 22_080_837n;

function callsTo(rpc: SimRpc, functionName: string): number {
  const selector = selectorOf("SettlementExecutor", functionName);
  return rpc.calls.filter((c) => c.method === "eth_call" && (c.params[0] as { data: Hex }).data.startsWith(selector)).length;
}

describe("attest/phase0 — attestPhase0", () => {
  it("signs the fixture window: volume as profit, L1 range from the fixture's l1BlockNumber, contribution from the executor", async () => {
    const { outcome, rpc } = await runAttest(() => {}, () => {}, realSigner);
    expect(outcome.kind).toBe("SIGNED");
    if (outcome.kind !== "SIGNED") return;

    // The attested L1 pair is what the fixture records for those L2 blocks, not a constant offset.
    const startRecord = FIXTURE[`eth_getBlockByNumber|${JSON.stringify([numberToHex(START_L2), false])}`] as { l1BlockNumber: Hex };
    const endRecord = FIXTURE[`eth_getBlockByNumber|${JSON.stringify([numberToHex(END_L2), false])}`] as { l1BlockNumber: Hex };
    expect(hexToBigInt(startRecord.l1BlockNumber)).toBe(START_L1);
    expect(hexToBigInt(endRecord.l1BlockNumber)).toBe(END_L1);

    expect(outcome.attestation).toEqual(PINNED_ATTESTATION);
    expect(outcome.contributionWei).toBe(OWED);
    expect(hashAttestationLocal(CHAIN_ID, EXECUTOR, outcome.attestation)).toBe(DIGEST);

    // The signature is over exactly that digest, by the registered attester.
    const recovered = await recoverTypedDataAddress({
      domain: attestationDomain(CHAIN_ID, EXECUTOR),
      types: ATTESTATION_TYPES,
      primaryType: "SettlementAttestation",
      message: toTypedMessage(outcome.attestation),
      signature: outcome.signature,
    });
    expect(recovered.toLowerCase()).toBe(ATTESTER.address.toLowerCase());

    // The executor was asked, not second-guessed: sessionId, contribution and digest all came from its views.
    expect(callsTo(rpc, "deriveSessionId")).toBe(1);
    expect(callsTo(rpc, "previewContribution")).toBe(1);
    expect(callsTo(rpc, "hashAttestation")).toBe(1);
    // and the attester was re-read from the registry, not trusted from the snapshot.
    expect(rpc.calls.filter((c) => c.method === "eth_call" && (c.params[0] as { to: Address }).to.toLowerCase() === REGISTRY)).toHaveLength(2);
  });

  it("the validity window is now-60 .. now+600, narrower than MAX_ATTESTATION_VALIDITY", async () => {
    const { outcome } = await runAttest(() => {}, () => {}, realSigner);
    if (outcome.kind !== "SIGNED") throw new Error(`expected SIGNED, got ${JSON.stringify(outcome)}`);
    expect(VALID_AFTER_SKEW_SECONDS).toBe(60n);
    expect(DEADLINE_SECONDS).toBe(600n);
    expect(outcome.attestation.validAfter).toBe(NOW - 60n);
    expect(outcome.attestation.deadline).toBe(NOW + 600n);
    expect(outcome.attestation.deadline - outcome.attestation.validAfter).toBeLessThan(15n * 60n);
    expect(outcome.attestation.cashStart).toBe(0n);
    expect(outcome.attestation.externalDeposits).toBe(0n);
    expect(outcome.attestation.externalWithdrawals).toBe(0n);
    expect(outcome.attestation.cashEnd).toBe(SUM_NOTIONAL);
    expect(outcome.attestation.realizedProfit).toBe(SUM_NOTIONAL);
  });

  interface DeferCase {
    readonly name: string;
    readonly before?: (s: SimState) => void;
    readonly after?: (s: SimState) => void;
    readonly reason: string;
    readonly detail: RegExp;
    /** Gates decided from the snapshot alone must not read the chain at all. */
    readonly noReads?: boolean;
  }

  const DEFER_CASES: readonly DeferCase[] = [
    { name: "protocol paused", before: (s) => { s.paused = true; }, reason: "PAUSED", detail: /ProtocolPauseController/, noReads: true },
    { name: "vault paused", before: (s) => { s.settlementPaused = true; }, reason: "PAUSED", detail: /settlementPaused/, noReads: true },
    { name: "account bound to no vault", before: (s) => { s.activeVault = ZERO_ADDRESS; }, reason: "ACCOUNT_NOT_ACTIVE", detail: /activeVaultOf/, noReads: true },
    { name: "account bound to another vault", before: (s) => { s.activeVault = OTHER_VAULT; }, reason: "ACCOUNT_NOT_ACTIVE", detail: /not the window's vault/, noReads: true },
    { name: "account PAUSED", before: (s) => { s.account.status = 3; }, reason: "ACCOUNT_NOT_ACTIVE", detail: /status is 3/, noReads: true },
    { name: "account PENDING", before: (s) => { s.account.status = 1; }, reason: "ACCOUNT_NOT_ACTIVE", detail: /status is 1/, noReads: true },
    { name: "vault points at another executor", before: (s) => { s.vaultExecutor = OTHER_EXECUTOR; }, reason: "EXECUTOR_MISMATCH", detail: /settlementExecutor/, noReads: true },
    { name: "registered attester is another key", before: (s) => { s.attester = OTHER_VAULT; }, reason: "ATTESTER_MISMATCH", detail: /attester\(\)/ },
    { name: "attester rotated after the snapshot", after: (s) => { s.attester = OTHER_VAULT; }, reason: "ATTESTER_MISMATCH", detail: /attester\(\)/ },
    { name: "attester epoch moved after the snapshot", after: (s) => { s.attesterEpoch = 2n; }, reason: "ATTESTER_MISMATCH", detail: /attesterEpoch\(\) moved from 1 to 2/ },
    { name: "window at or below the vault's frontier", before: (s) => { s.frontier = { endBlockL1: START_L1, endBlockL2: START_L2 }; }, reason: "NOTHING_COLLECTABLE", detail: /frontier/ },
    // Every block the window could claim maps to the L1 block being built, so there is nothing to walk back to.
    { name: "L1 has not passed any block the window can claim", before: (s) => { s.l1Of = () => END_L1; }, reason: "L1_NOT_ADVANCED", detail: /behind the L1 head/ },
    { name: "window predates the account's activation", before: (s) => { s.account.activationBlock = START_L1 + 1n; }, reason: "L1_NOT_ADVANCED", detail: /activationBlock/ },
    { name: "savingsBps is 0", before: (s) => { s.account.policy.savingsBps = 0; }, reason: "NOTHING_COLLECTABLE", detail: /returned 0/ },
    { name: "wallet emptied to the floor", before: (s) => { s.balance = 200_000_000_000_000n; }, reason: "NOTHING_COLLECTABLE", detail: /returned 0/ },
    { name: "contribution below the policy minimum", before: (s) => { s.account.policy.minContributionWei = OWED + 1n; }, reason: "BELOW_MINIMUM", detail: /minContributionWei/ },
    { name: "previewContribution reverts", before: (s) => { s.previewReverts = true; }, reason: "NOTHING_COLLECTABLE", detail: /reverted/ },
    { name: "executor returns more than the policy can justify", before: (s) => { s.previewOverride = OWED + 1n; }, reason: "NOTHING_COLLECTABLE", detail: /exceeds what this policy can justify/ },
    { name: "the balance clamp binds (gas prefund would make settle revert InvalidContribution)", before: (s) => { s.balance = 210_000_000_000_000n; }, reason: "NOTHING_COLLECTABLE", detail: /InvalidContribution/ },
    { name: "hashAttestation disagrees with the local digest", before: (s) => { s.hashAttestationOverride = `0x${"11".repeat(32)}`; }, reason: "DIGEST_MISMATCH", detail: /hashAttestation/ },
    { name: "deriveSessionId disagrees with its own source", before: (s) => { s.sessionIdOverride = `0x${"22".repeat(32)}`; }, reason: "DIGEST_MISMATCH", detail: /deriveSessionId/ },
  ];

  for (const c of DEFER_CASES) {
    it(`defers BEFORE signing when ${c.name}`, async () => {
      const signer = throwingSigner();
      const { outcome, rpc } = await runAttest(c.before, c.after, signer);
      expect(outcome).toMatchObject({ kind: "DEFERRED", reason: c.reason });
      if (outcome.kind !== "DEFERRED") return;
      expect(outcome.detail).toMatch(c.detail);
      expect(signer.touched()).toBe(0);
      if (c.noReads) expect(rpc.calls).toHaveLength(0);
    });
  }

  it("a degenerate L2 range (endL2 <= startL2) waits for the window to grow", async () => {
    const signer = throwingSigner();
    const { outcome } = await runAttest(() => {}, () => {}, signer, fixtureWindow({ startL2: 21_787_563n, endL2: 21_787_563n, fills: FIXTURE_FILLS.slice(1, 2), sumNotionalWei: 1_000_000_000_000_000n, owedWei: 2_000_000_000_000n, batchRoot: batchRoot(CHAIN_ID, WALLET, FIXTURE_FILLS.slice(1, 2)) }));
    expect(outcome).toMatchObject({ kind: "DEFERRED", reason: "L1_NOT_ADVANCED" });
    if (outcome.kind === "DEFERRED") expect(outcome.detail).toMatch(/degenerate/);
    expect(signer.touched()).toBe(0);
  });

  it("the preflight order is fixed: the first failing gate names the deferral", async () => {
    const pairs: readonly [(s: SimState) => void, string][] = [
      [(s) => { s.paused = true; s.account.status = 4; }, "PAUSED"],
      [(s) => { s.settlementPaused = true; s.vaultExecutor = OTHER_EXECUTOR; }, "PAUSED"],
      [(s) => { s.account.status = 4; s.vaultExecutor = OTHER_EXECUTOR; }, "ACCOUNT_NOT_ACTIVE"],
      [(s) => { s.vaultExecutor = OTHER_EXECUTOR; s.attester = OTHER_VAULT; }, "EXECUTOR_MISMATCH"],
      [(s) => { s.attester = OTHER_VAULT; s.account.activationBlock = START_L1 + 1n; }, "ATTESTER_MISMATCH"],
      [(s) => { s.account.activationBlock = START_L1 + 1n; s.account.policy.savingsBps = 0; }, "L1_NOT_ADVANCED"],
      [(s) => { s.account.policy.savingsBps = 0; s.hashAttestationOverride = `0x${"11".repeat(32)}`; }, "NOTHING_COLLECTABLE"],
      [(s) => { s.account.policy.minContributionWei = OWED + 1n; s.hashAttestationOverride = `0x${"11".repeat(32)}`; }, "BELOW_MINIMUM"],
    ];
    for (const [mutate, reason] of pairs) {
      const signer = throwingSigner();
      const { outcome } = await runAttest(mutate, () => {}, signer);
      expect(outcome).toMatchObject({ kind: "DEFERRED", reason });
      expect(signer.touched()).toBe(0);
    }
  });

  it("the exact-maximum rule: whichever clamp binds is the contribution the executor previews", async () => {
    const cases: readonly [(s: SimState) => void, bigint][] = [
      [(s) => { s.account.policy.maxPerSettlementWei = 10_000_000_000_000n; }, 10_000_000_000_000n],
      [(s) => { s.accountCapRemaining = 5_000_000_000_000n; }, 5_000_000_000_000n],
      [(s) => { s.aggregateCapRemaining = 3_000_000_000_000n; }, 3_000_000_000_000n],
      [() => {}, OWED],
    ];
    for (const [mutate, expected] of cases) {
      const { outcome } = await runAttest(mutate, () => {}, realSigner);
      expect(outcome.kind).toBe("SIGNED");
      if (outcome.kind === "SIGNED") {
        expect(outcome.contributionWei).toBe(expected);
        expect(outcome.attestation.contribution).toBe(expected);
      }
    }
  });

  it("the balance hazard is checked strictly even when the gas price cannot be read", async () => {
    const reserved = 200_000_000_000_000n;
    // Exactly contribution + reserved: the clamp does not bind at preview, but any gas at all makes it bind at settle.
    const exact = await runAttest((s) => { s.gasPrice = null; s.balance = OWED + reserved; }, () => {}, throwingSigner());
    expect(exact.outcome).toMatchObject({ kind: "DEFERRED", reason: "NOTHING_COLLECTABLE" });
    // One wei of headroom with no gas quote: signed (the real estimate is submitPull's job).
    const oneWei = await runAttest((s) => { s.gasPrice = null; s.balance = OWED + reserved + 1n; }, () => {}, realSigner);
    expect(oneWei.outcome.kind).toBe("SIGNED");
    // With a quote, the headroom is 800k gas at twice the price.
    const headroom = 800_000n * 2n * 28_000_000n;
    const justShort = await runAttest((s) => { s.balance = OWED + reserved + headroom; }, () => {}, throwingSigner());
    expect(justShort.outcome).toMatchObject({ kind: "DEFERRED", reason: "NOTHING_COLLECTABLE" });
    const justEnough = await runAttest((s) => { s.balance = OWED + reserved + headroom + 1n; }, () => {}, realSigner);
    expect(justEnough.outcome.kind).toBe("SIGNED");
  });

  it("refuses a window that does not describe its fills, before any chain read", async () => {
    const rpc = simRpc();
    const snapshot = await readVaultSnapshot(rpc, FACTORY, EXECUTOR, WALLET);
    const now = { unixSeconds: NOW, headL2: HEAD_L2 };
    const signer = throwingSigner();
    const attempts: readonly [VolumeWindow, RegExp][] = [
      [fixtureWindow({ batchRoot: EMPTY_ROOT }), /batchRoot/],
      [fixtureWindow({ sumNotionalWei: SUM_NOTIONAL + 1n }), /add up to/],
      [fixtureWindow({ startL2: 21_787_600n, batchRoot: ROOT }), /outside its range/],
      [fixtureWindow({ startL2: 0n }), /genesis/],
      [fixtureWindow({ fills: [], sumNotionalWei: 0n, owedWei: 0n, batchRoot: EMPTY_ROOT }), /no volume/],
    ];
    for (const [window, message] of attempts) {
      rpc.calls.length = 0;
      await expect(attestPhase0(rpc, EXECUTOR, window, snapshot, signer, now)).rejects.toThrow(message);
      expect(rpc.calls).toHaveLength(0);
    }
    // A snapshot of another account under this window is a caller bug, not a chain state.
    await expect(attestPhase0(rpc, EXECUTOR, fixtureWindow(), { ...snapshot, account: OTHER_VAULT }, signer, now)).rejects.toThrow(/snapshot is for/);
    expect(signer.touched()).toBe(0);
  });

  it("uses the executor's answers, lowercased, whatever case the window carried", async () => {
    const upperWindow = fixtureWindow({ wallet: WALLET.toUpperCase().replace("0X", "0x") as Address, batchRoot: ROOT.toUpperCase().replace("0X", "0x") as Hex });
    const { outcome } = await runAttest(() => {}, () => {}, realSigner, upperWindow);
    expect(outcome.kind).toBe("SIGNED");
    if (outcome.kind === "SIGNED") {
      expect(outcome.attestation.account).toBe(WALLET);
      expect(outcome.attestation.ledgerRoot).toBe(ROOT);
      expect(outcome.attestation.executor).toBe(EXECUTOR);
    }
  });
});

// ── the L1 endpoint: settle what L1 has already passed ──────────────────────

describe("attest/phase0 — choosing the window's L1 endpoint", () => {
  it("costs three block reads when the window's own end is already behind the L1 head", async () => {
    const { outcome, rpc } = await runAttest(() => {}, () => {}, realSigner);
    expect(outcome.kind).toBe("SIGNED");
    if (outcome.kind !== "SIGNED") return;
    // The recorded fixture: END_L2 maps to END_L1, which L1 has already left.
    expect(outcome.attestation.endBlockL2).toBe(END_L2);
    expect(outcome.attestation.endBlock).toBe(END_L1);
    expect(END_L1).toBeLessThan(HEAD_L1);
    expect(rpc.calls.filter((c) => c.method === "eth_getBlockByNumber")).toHaveLength(3);
  });

  it("walks the end back to the newest settleable block instead of deferring the whole window", async () => {
    // head − finalityMargin lands in the L1 block being built ~3 passes in 4;
    // deferring for that lost a whole pass of collection each time.
    const cut = END_L2 - 5n;
    const { outcome, rpc } = await runAttest((s) => {
      s.l1Of = (l2) => (l2 <= cut ? HEAD_L1 - 1n : HEAD_L1);
    }, () => {}, realSigner);

    expect(outcome.kind).toBe("SIGNED");
    if (outcome.kind !== "SIGNED") return;
    expect(outcome.attestation.endBlockL2).toBe(cut);
    expect(outcome.attestation.endBlock).toBe(HEAD_L1 - 1n);
    expect(outcome.attestation.endBlock).toBeLessThan(HEAD_L1);
    // The start is untouched, and the attested range still contains every fill.
    expect(outcome.attestation.startBlockL2).toBe(START_L2);
    expect(cut).toBeGreaterThanOrEqual(NEWEST_FILL_L2);
    // The whole volume is still what is attested: only the range was trimmed.
    expect(outcome.attestation.cashEnd).toBe(SUM_NOTIONAL);
    expect(outcome.attestation.ledgerRoot).toBe(ROOT);
    // The sessionId the executor derived commits to the walked-back range.
    expect(outcome.attestation.sessionId).toBe(
      deriveSessionIdLocal({
        chainId: BigInt(CHAIN_ID),
        vault: VAULT,
        account: WALLET,
        bindingEpoch: 3n,
        startBlockL1: HEAD_L1 - 1n,
        endBlockL1: HEAD_L1 - 1n,
        startBlockL2: START_L2,
        endBlockL2: cut,
        ledgerRoot: ROOT,
      }),
    );
    // A search, not a walk: ~120 L2 blocks fit in one L1 block and each probe is an RPC.
    expect(rpc.calls.filter((c) => c.method === "eth_getBlockByNumber").length).toBeLessThanOrEqual(12);
  });

  it("never walks past the newest fill: the attested range must contain what the ledgerRoot commits to", async () => {
    const signer = throwingSigner();
    const { outcome } = await runAttest((s) => {
      s.l1Of = (l2) => (l2 < NEWEST_FILL_L2 ? HEAD_L1 - 1n : HEAD_L1);
    }, () => {}, signer);
    expect(outcome).toMatchObject({ kind: "DEFERRED", reason: "L1_NOT_ADVANCED" });
    if (outcome.kind === "DEFERRED") expect(outcome.detail).toMatch(new RegExp(`${NEWEST_FILL_L2}`));
    expect(signer.touched()).toBe(0);
  });

  it("stops exactly at the newest fill, and attests heights read from blocks rather than an L1/L2 delta", async () => {
    // The gap is not a constant on this chain, so every height is asked for per
    // block. Here the newest settleable block IS the newest fill: the walk-back
    // reaches its floor and settles there.
    const cut = NEWEST_FILL_L2;
    const { outcome, rpc } = await runAttest((s) => {
      s.l1Of = (l2) => (l2 <= cut ? HEAD_L1 - 3n : HEAD_L1);
    }, () => {}, realSigner);
    expect(outcome.kind).toBe("SIGNED");
    if (outcome.kind !== "SIGNED") return;
    expect(outcome.attestation.endBlockL2).toBe(cut);
    expect(outcome.attestation.startBlock).toBe(HEAD_L1 - 3n);
    expect(outcome.attestation.endBlock).toBe(HEAD_L1 - 3n);
    // Every height in the attestation was read from a block this call fetched.
    const asked = rpc.calls.filter((c) => c.method === "eth_getBlockByNumber").map((c) => hexToBigInt((c.params as [Hex, boolean])[0]));
    expect(asked).toContain(outcome.attestation.endBlockL2);
    expect(asked).toContain(outcome.attestation.startBlockL2);
  });
});

describe("newestSettleableL2 — the search behind the walk-back", () => {
  let reads = 0;
  /** Blocks up to `cut` are one L1 block behind the head; the rest are in it. */
  const rpcFor = (cut: bigint): RpcClient => ({
    async call<T>(method: string, params: RpcParams = []): Promise<T> {
      if (method !== "eth_getBlockByNumber") throw new Error(`unexpected ${method}`);
      reads += 1;
      const [tag] = params as [Hex, boolean];
      const l2 = hexToBigInt(tag);
      return { number: tag, l1BlockNumber: numberToHex(l2 <= cut ? 99n : 100n) } as T;
    },
  });

  it("finds the exact boundary with a logarithmic number of reads", async () => {
    for (const cut of [1_000n, 1_001n, 1_500n, 1_999n, 2_000n]) {
      reads = 0;
      const found = await newestSettleableL2(rpcFor(cut), 1_000n, 2_000n, 100n);
      expect(found).toEqual({ l2: cut, l1: 99n });
      expect(reads).toBeLessThanOrEqual(14);
    }
    // The common case — the ceiling already qualifies — costs a single read.
    reads = 0;
    await newestSettleableL2(rpcFor(2_000n), 1_000n, 2_000n, 100n);
    expect(reads).toBe(1);
  });

  it("returns null rather than a block L1 has not passed, and answers a one-block range", async () => {
    reads = 0;
    expect(await newestSettleableL2(rpcFor(999n), 1_000n, 2_000n, 100n)).toBeNull();
    expect(reads).toBe(2);
    expect(await newestSettleableL2(rpcFor(1_000n), 1_000n, 1_000n, 100n)).toEqual({ l2: 1_000n, l1: 99n });
    expect(await newestSettleableL2(rpcFor(999n), 1_000n, 1_000n, 100n)).toBeNull();
  });
});

// ── the configured chain id ─────────────────────────────────────────────────

describe("attest/phase0 — the configured chain id", () => {
  const OTHER_CHAIN = 8453;

  it("uses the chain id the caller passes, and the mainnet constant only as its default", async () => {
    const passed = await runAttest(() => {}, () => {}, realSigner, fixtureWindow(), { chainId: CHAIN_ID });
    expect(passed.outcome.kind).toBe("SIGNED");
    if (passed.outcome.kind !== "SIGNED") return;
    expect(passed.outcome.attestation).toEqual(PINNED_ATTESTATION);

    const omitted = await runAttest(() => {}, () => {}, realSigner);
    if (omitted.outcome.kind !== "SIGNED") throw new Error("expected SIGNED");
    expect(omitted.outcome.attestation).toEqual(passed.outcome.attestation);
  });

  it("checks the batch root on the configured chain: the root is domain-separated by it", async () => {
    // tick.ts commits the root with config.chainId. Read with the constant, a
    // window from a differently-configured worker looks corrupted.
    const elsewhere = fixtureWindow({ batchRoot: batchRoot(OTHER_CHAIN, WALLET, FIXTURE_FILLS) });
    const signer = throwingSigner();
    await expect(runAttest(() => {}, () => {}, signer, elsewhere)).rejects.toThrow(/hash to .* on chain 4663/);
    // Passed through, the same window verifies against its own chain.
    const { outcome } = await runAttest(() => {}, () => {}, signer, elsewhere, { chainId: OTHER_CHAIN });
    expect(outcome.kind).toBe("DEFERRED");
    expect(signer.touched()).toBe(0);
  });

  it("a worker configured for another chain cannot sign for 4663: the executor's own digest refuses it", async () => {
    const elsewhere = fixtureWindow({ batchRoot: batchRoot(OTHER_CHAIN, WALLET, FIXTURE_FILLS) });
    const signer = throwingSigner();
    const { outcome } = await runAttest(() => {}, () => {}, signer, elsewhere, { chainId: OTHER_CHAIN });
    // The domain and the struct both moved to 8453; the deployed executor
    // hashes with block.chainid, so the two digests cannot agree.
    expect(outcome).toMatchObject({ kind: "DEFERRED", reason: "DIGEST_MISMATCH" });
    expect(signer.touched()).toBe(0);
    expect(hashAttestationLocal(OTHER_CHAIN, EXECUTOR, PINNED_ATTESTATION)).not.toBe(DIGEST);
  });
});
