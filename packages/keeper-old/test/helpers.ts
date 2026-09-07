// Offline fixtures and a stub ChainAccess.
//
// Everything here is deterministic and touches no network. The stub emulates the
// contract where it matters — notably hashAttestation, which is computed with
// viem's own hashTypedData so the digest cross-check in attest.ts is genuinely
// exercised rather than trivially satisfied.

import { hashTypedData, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { AttesterSigner } from "../src/attest.js";
import type { KeeperLimits } from "../src/config.js";
import type { RefusalReason, SessionReport } from "../src/engine.js";
import {
  ATTESTATION_TYPES,
  DOMAIN_NAME,
  DOMAIN_VERSION,
  type ChainAccess,
  type FeeQuote,
  type MinedReceipt,
  type MinedTx,
  type SettlementAttestation,
  type SettlementLog,
  type VaultSnapshot,
} from "../src/onchain.js";
import type { TradingSigner } from "../src/submit.js";

export const CHAIN_ID = 4663;
export const ACCOUNT = "0xc455bF7f16ebbc2b07cb26D1Dd46194977974E7d" as const;
export const VAULT = "0x0b5036063527bA4e32032e1b6B953c3677386BBD" as const;
export const EXECUTOR = "0x5D037fE7Fd65745BA51DDb433Aa5B17E965D46Ac" as const;
export const FACTORY = "0x2a6a5d51677aA52674DF1380a5743fBf601ca9b0" as const;

/** A throwaway key, used only to produce syntactically real signatures offline. */
export const TEST_ATTESTER_KEY = "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318" as const;
export const TEST_ATTESTER = privateKeyToAccount(TEST_ATTESTER_KEY);

export const LIMITS: KeeperLimits = {
  pollMs: 1_000,
  finalityMarginL2: 64n,
  l1Margin: 2n,
  maxVerifySpanBlocks: 20_000n,
  maxTickScanSpanBlocks: 20_000n,
  maxContributionWei: 1_000_000_000_000_000n,
  maxSettlementsPerDay: 8,
  maxRpcCallsPerTick: 5_000,
  gasHeadroom: 2n,
};

export function attestableReport(over: Partial<SessionReport> = {}): SessionReport {
  // The numbers are the real canary settlement's, so the shapes are not invented.
  return {
    wallet: ACCOUNT.toLowerCase(),
    startBlockL2: 22080592n,
    endBlockL2: 22080850n,
    startBlockL1: 25640000n,
    endBlockL1: 25640003n,
    cashStart: 30_000_000_000_000_000n,
    cashEnd: 32_016_854_447_493_738n,
    externalDeposits: 0n,
    externalWithdrawals: 0n,
    realizedProfit: 2_016_854_447_493_738n,
    naiveDelta: 2_016_854_447_493_738n,
    gasPaid: 14_480_924_700n,
    zeroBasisRealized: 0n,
    reconciliation: {
      reconciled: true,
      inflow: 4_000_000_000_000_000n,
      outflow: 1_983_145_552_506_262n,
      observedDelta: 2_016_854_447_493_738n,
      predictedDelta: 2_016_854_447_493_738n,
      residualWei: 0n,
      gasPaid: 14_480_924_700n,
    },
    transactions: [],
    positionDeltas: [],
    verdict: "ATTESTABLE",
    reasons: [],
    ledgerRootLegacy: "0x1111111111111111111111111111111111111111111111111111111111111111",
    ledgerRootV2: "0x2222222222222222222222222222222222222222222222222222222222222222",
    positionsRoot: "0x3333333333333333333333333333333333333333333333333333333333333333",
    replayStartBlockL2: 22080592n,
    senderHeuristicValid: true,
    ...over,
  } as SessionReport;
}

export function refusedReport(reasons: readonly RefusalReason[] = ["NOT_RECONCILED"]): SessionReport {
  return attestableReport({
    verdict: "REFUSED",
    reasons,
    reconciliation: {
      reconciled: false,
      inflow: 0n,
      outflow: 0n,
      observedDelta: 1n,
      predictedDelta: 2n,
      residualWei: -1n,
      gasPaid: 0n,
    },
  });
}

export function vaultSnapshot(over: Partial<VaultSnapshot> = {}): VaultSnapshot {
  return {
    activeVault: VAULT,
    status: 2,
    bindingEpoch: 1n,
    policyNonce: 1n,
    settlementNonce: 1n,
    activationBlockL1: 25_633_549n,
    revocationBlockL1: 0n,
    policy: {
      savingsBps: 2000,
      minContributionWei: 1_000_000_000_000n,
      // BOTH CAPS ARE UINT128_MAX BECAUSE THAT IS WHAT THE PRODUCT WRITES.
      // InviteTradingWallet.tsx sets maxPerSettlementWei and maxRolling30dWei to
      // UINT128_MAX deliberately — a low ceiling is shared by every wallet in the
      // vault, so one wallet exhausting it would block the rest.
      //
      // They used to be 0.001 and 0.01 ETH here, which no invited account has
      // ever had, and the fixtures paired them with a 0.1 ETH preview: a
      // contribution a hundred times its own policy cap, which the executor mins
      // against and therefore cannot return. Nothing caught it, because the only
      // bound the keeper checked was an absolute ceiling the tests raised to 1
      // ETH to get out of the way. attest.ts now checks against the policy, so an
      // incoherent fixture fails instead of passing.
      maxPerSettlementWei: 2n ** 128n - 1n,
      maxRolling30dWei: 2n ** 128n - 1n,
      tradingFloorWei: 100_000_000_000_000n,
      gasReserveWei: 100_000_000_000_000n,
    },
    policyHash: "0x4444444444444444444444444444444444444444444444444444444444444444",
    adminEpoch: 1n,
    localPauseEpoch: 0n,
    globalPauseEpoch: 0n,
    attesterEpoch: 1,
    registeredAttester: TEST_ATTESTER.address,
    protocolPaused: false,
    settlementPaused: false,
    lifetimeContribution: 403_370_889_498_747n,
    accountBalanceWei: 30_274_037_447_092_363n,
    ...over,
  };
}

/**
 * A monotone L2 -> L1 mapping shaped like the real chain: many L2 blocks per L1
 * block, read PER BLOCK and never derived from a stored offset. Calibrated so
 * that the canary window's L2 range maps onto its real L1 range —
 * l1(22_080_592) === 25_635_381 and l1(22_080_850) === 25_635_384 — which is what
 * lets recovery clamp an adopted settlement's L1 range back into L2 space.
 */
export const L2_PER_L1 = 100n;
export const L1_AT_L2_ORIGIN = 25_414_576n;
export const l1BlockNumberAt = (l2Block: bigint): bigint => L1_AT_L2_ORIGIN + l2Block / L2_PER_L1;

export interface StubChainOptions {
  readonly snapshot?: VaultSnapshot;
  readonly headBlockL2?: bigint;
  /** A constant answer for every block. Prefer `l1BlockNumberOf` when the mapping matters. */
  readonly l1BlockNumber?: bigint;
  /** A per-block answer, for tests that exercise the L1 -> L2 clamp. */
  readonly l1BlockNumberOf?: (l2Block: bigint) => bigint;
  readonly previewContribution?: bigint;
  /** Return a deliberately wrong digest to exercise the mismatch guard. */
  readonly forcedDigest?: Hex;
  readonly settlementLogs?: readonly SettlementLog[];
  readonly receipts?: Readonly<Record<string, MinedReceipt | null>>;
  readonly transactions?: Readonly<Record<string, MinedTx | null>>;
  readonly minedNonce?: number;
  readonly pendingNonce?: number;
  readonly feeQuote?: FeeQuote;
  readonly gasEstimate?: bigint;
  readonly chainId?: number;
}

export interface StubChain extends ChainAccess {
  readonly calls: string[];
  readonly sentRaw: Hex[];
}

/** A ChainAccess that answers from memory and records what was asked. */
export function stubChain(options: StubChainOptions = {}): StubChain {
  const calls: string[] = [];
  const sentRaw: Hex[] = [];
  const snapshot = options.snapshot ?? vaultSnapshot();
  const logs = options.settlementLogs ?? [];

  const record = <T>(name: string, value: T): T => {
    calls.push(name);
    return value;
  };

  return {
    calls,
    sentRaw,
    getChainId: async () => record("getChainId", options.chainId ?? CHAIN_ID),
    getHeadBlockL2: async () => record("getHeadBlockL2", options.headBlockL2 ?? 22_996_865n),
    getL1BlockNumber: async (l2Block) =>
      record(
        "getL1BlockNumber",
        options.l1BlockNumberOf ? options.l1BlockNumberOf(l2Block) : (options.l1BlockNumber ?? 25_643_013n),
      ),
    getBlockHash: async (block) => record("getBlockHash", `0x${block.toString(16).padStart(64, "0")}` as Hex),
    readVaultSnapshot: async () => record("readVaultSnapshot", snapshot),
    deriveSessionId: async (args) =>
      record(
        "deriveSessionId",
        // Deterministic, and sensitive to every field the real contract folds in,
        // so a test that changes a boundary gets a different sessionId.
        //
        // THE L2 PAIR IS PART OF THAT SET and must stay part of it. The contract
        // added it so that two distinct sessions sharing one L1 range still
        // derive distinct ids — without it the vault's usedSessions guard refuses
        // the second, which is the same liveness bug the L2 progression change
        // exists to fix, one layer down. A stub that ignored these two fields
        // would collapse exactly the case the change is for, and every test
        // covering it would pass by never reaching the distinction.
        `0x${[args.bindingEpoch, args.startBlockL1, args.endBlockL1, args.startBlockL2, args.endBlockL2]
          .map((v) => v.toString(16).padStart(12, "0"))
          .join("")
          .padEnd(64, "7")}` as Hex,
      ),
    previewContribution: async () =>
      record("previewContribution", options.previewContribution ?? 403_370_889_498_747n),
    hashAttestation: async (attestation: SettlementAttestation) =>
      record(
        "hashAttestation",
        options.forcedDigest ??
          hashTypedData({
            domain: { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId: CHAIN_ID, verifyingContract: EXECUTOR },
            types: ATTESTATION_TYPES,
            primaryType: "SettlementAttestation",
            message: attestation,
          }),
      ),
    getSettlementLogs: async (filter) =>
      record(
        "getSettlementLogs",
        logs.filter((log) => {
          if (filter.sessionId && log.sessionId.toLowerCase() !== filter.sessionId.toLowerCase()) return false;
          if (filter.account && log.account.toLowerCase() !== filter.account.toLowerCase()) return false;
          return true;
        }),
      ),
    getTransaction: async (hash) => record("getTransaction", options.transactions?.[hash.toLowerCase()] ?? null),
    getTransactionReceipt: async (hash) =>
      record("getTransactionReceipt", options.receipts?.[hash.toLowerCase()] ?? null),
    getTransactionCount: async () => record("getTransactionCount", options.minedNonce ?? 75),
    getPendingTransactionCount: async () => record("getPendingTransactionCount", options.pendingNonce ?? 75),
    estimateSettleGas: async () => record("estimateSettleGas", options.gasEstimate ?? 516_254n),
    getFeeQuote: async () =>
      record("getFeeQuote", options.feeQuote ?? { maxFeePerGas: 28_050_000n, maxPriorityFeePerGas: 1_000_000n }),
    sendRawTransaction: async (raw) => {
      calls.push("sendRawTransaction");
      sentRaw.push(raw);
      return "0xdeadbeef00000000000000000000000000000000000000000000000000000001" as Hex;
    },
    waitForReceipt: async (hash) =>
      record("waitForReceipt", {
        transactionHash: hash,
        status: "success" as const,
        blockNumber: 22_996_900n,
        gasUsed: 516_254n,
      }),
  };
}

/** An attester signer that counts calls, so "never signed" is directly assertable. */
export function countingAttesterSigner(): AttesterSigner & { signCount: () => number } {
  let count = 0;
  return {
    address: TEST_ATTESTER.address,
    signCount: () => count,
    async signTypedData(args) {
      count += 1;
      return TEST_ATTESTER.signTypedData(args as never);
    },
  };
}

/** A trading signer that throws if used. For proving a dry run cannot broadcast. */
export function forbiddenTradingSigner(): TradingSigner {
  return {
    address: ACCOUNT,
    async signTransaction() {
      throw new Error("signTransaction must never be called in dry-run mode");
    },
  };
}

export function realTradingSigner(): TradingSigner {
  const account = privateKeyToAccount(
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex,
  );
  return {
    address: account.address,
    signTransaction: (transaction) => account.signTransaction(transaction as never),
  };
}

export function settlementLog(over: Partial<SettlementLog> = {}): SettlementLog {
  return {
    sessionId: "0x0000000000000001000000000186a00000000000000186a37777777777777777" as Hex,
    account: ACCOUNT,
    vault: VAULT,
    settlementNonce: 1n,
    realizedProfit: 2_016_854_447_493_738n,
    contribution: 403_370_889_498_747n,
    ledgerRoot: "0x2222222222222222222222222222222222222222222222222222222222222222" as Hex,
    transactionHash: "0xd342d1170000000000000000000000000000000000000000000000000000cad18" as Hex,
    blockNumber: 22_086_130n,
    ...over,
  };
}
