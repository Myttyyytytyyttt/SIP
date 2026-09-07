import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { encodeSettlementCall, type SettlementAttestation } from "./settlement.js";
import { parseSmokeConfig } from "./config.js";
import { buildDryRunResult } from "./runtime.js";

const OWNER_KEY = `0x${"11".repeat(32)}` as const;
const SESSION_KEY = `0x${"22".repeat(32)}` as const;
const EXECUTOR = "0x1000000000000000000000000000000000000001";
const VAULT = "0x2000000000000000000000000000000000000002";
const PAYMASTER = "0x3000000000000000000000000000000000000003";

function baseEnv(): Record<string, string> {
  return {
    TRADING_OWNER_PRIVATE_KEY: OWNER_KEY,
    SESSION_KEY_PRIVATE_KEY: SESSION_KEY,
    SETTLEMENT_EXECUTOR_ADDRESS: EXECUTOR,
    SESSION_NATIVE_LIMIT_WEI: "1000000000000000000",
  };
}

function attestation(overrides: Partial<SettlementAttestation> = {}): SettlementAttestation {
  return {
    account: privateKeyToAccount(OWNER_KEY).address,
    vault: VAULT,
    executor: EXECUTOR,
    chainId: 46_630n,
    bindingEpoch: 1n,
    policyNonce: 2n,
    adminEpoch: 3n,
    localPauseEpoch: 4n,
    globalPauseEpoch: 5n,
    settlementNonce: 6n,
    policyHash: `0x${"aa".repeat(32)}`,
    sessionId: `0x${"bb".repeat(32)}`,
    ledgerRoot: `0x${"cc".repeat(32)}`,
    startBlock: 100n,
    endBlock: 110n,
    // The L2 pair, deliberately distinct from the L1 pair: the two clocks sit
    // millions apart on this chain and the gap is not constant.
    startBlockL2: 12_000n,
    endBlockL2: 13_200n,
    cashStart: 1_000n,
    cashEnd: 1_500n,
    externalDeposits: 0n,
    externalWithdrawals: 0n,
    realizedProfit: 500n,
    contribution: 100n,
    attesterEpoch: 1,
    validAfter: 1,
    deadline: 2,
    ...overrides,
  };
}

describe("parseSmokeConfig", () => {
  it("defaults to a completely offline dry run on chain 46630", () => {
    const config = parseSmokeConfig(baseEnv());

    expect(config.action).toBe("dry-run");
    expect(config.chainId).toBe(46_630);
    expect(config.ownerAddress).toBe(privateKeyToAccount(OWNER_KEY).address);
    expect(config.sessionEntityId).toBe(1);
    expect(config.paymaster).toBeUndefined();
  });

  it("refuses any other chain", () => {
    expect(() =>
      parseSmokeConfig({ ...baseEnv(), RH_TESTNET_CHAIN_ID: "4663" }),
    ).toThrow(/must be 46630/);
    expect(() =>
      parseSmokeConfig({ ...baseEnv(), RH_TESTNET_CHAIN_ID: "46630.0" }),
    ).toThrow(/must be 46630/);
  });

  it("keeps the entity ID outside Alchemy's reserved hook namespace", () => {
    expect(
      parseSmokeConfig({
        ...baseEnv(),
        SESSION_ENTITY_ID: "2147483646",
      }).sessionEntityId,
    ).toBe(2_147_483_646);

    expect(() =>
      parseSmokeConfig({
        ...baseEnv(),
        SESSION_ENTITY_ID: "2147483647",
      }),
    ).toThrow(/below 2147483647/);
    expect(() =>
      parseSmokeConfig({
        ...baseEnv(),
        SESSION_ENTITY_ID: "4294967295",
      }),
    ).toThrow(/below 2147483647/);
  });

  it("validates private keys without echoing their values", () => {
    expect(() =>
      parseSmokeConfig({
        ...baseEnv(),
        TRADING_OWNER_PRIVATE_KEY: "not-a-key",
      }),
    ).toThrow(
      "TRADING_OWNER_PRIVATE_KEY must be a 32-byte 0x-prefixed private key.",
    );
  });

  it("requires paymaster policy and guard address as one configuration", () => {
    expect(() =>
      parseSmokeConfig({
        ...baseEnv(),
        ALCHEMY_GAS_POLICY_ID: "policy-id",
      }),
    ).toThrow(/must be configured together/);

    const config = parseSmokeConfig({
      ...baseEnv(),
      ALCHEMY_GAS_POLICY_ID: "policy-id",
      ALCHEMY_PAYMASTER_ADDRESS: PAYMASTER,
    });
    expect(config.paymaster?.address).toBe(PAYMASTER);
  });

  it("validates prepared settlement binding and contribution", () => {
    const calldata = encodeSettlementCall(
      attestation(),
      `0x${"12".repeat(65)}`,
    );
    const config = parseSmokeConfig({
      ...baseEnv(),
      AA_SMOKE_ACTION: "settle",
      ALCHEMY_API_KEY: "test-key",
      SETTLEMENT_CALLDATA: calldata,
      SETTLEMENT_VALUE_WEI: "100",
    });

    expect(config.preparedSettlement?.attestation.contribution).toBe(100n);
    expect(config.preparedSettlement?.valueWei).toBe(100n);
  });

  it("rejects a prepared settlement for a different executor", () => {
    const calldata = encodeSettlementCall(
      attestation({
        executor: "0x4000000000000000000000000000000000000004",
      }),
      "0x12",
    );
    expect(() =>
      parseSmokeConfig({
        ...baseEnv(),
        AA_SMOKE_ACTION: "settle",
        ALCHEMY_API_KEY: "test-key",
        SETTLEMENT_CALLDATA: calldata,
        SETTLEMENT_VALUE_WEI: "100",
      }),
    ).toThrow(/executor does not match/);
  });

  it("leaves headroom in the native limit for unsponsored gas", () => {
    const calldata = encodeSettlementCall(attestation(), "0x12");
    expect(() =>
      parseSmokeConfig({
        ...baseEnv(),
        AA_SMOKE_ACTION: "settle",
        ALCHEMY_API_KEY: "test-key",
        SESSION_NATIVE_LIMIT_WEI: "100",
        SETTLEMENT_CALLDATA: calldata,
        SETTLEMENT_VALUE_WEI: "100",
      }),
    ).toThrow(/must exceed SETTLEMENT_VALUE_WEI/);
  });

  it("never includes secret material in the dry-run output", () => {
    const config = parseSmokeConfig({
      ...baseEnv(),
      ALCHEMY_API_KEY: "alchemy-secret",
      ALCHEMY_GAS_POLICY_ID: "policy-secret",
      ALCHEMY_PAYMASTER_ADDRESS: PAYMASTER,
    });
    const output = JSON.stringify(buildDryRunResult(config));

    expect(output).not.toContain(OWNER_KEY);
    expect(output).not.toContain(SESSION_KEY);
    expect(output).not.toContain("alchemy-secret");
    expect(output).not.toContain("policy-secret");
  });
});
