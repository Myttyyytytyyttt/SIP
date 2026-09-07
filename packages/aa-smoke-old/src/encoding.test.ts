import {
  AllowlistModule,
  DefaultModuleAddress,
  NativeTokenLimitModule,
  PaymasterGuardModule,
} from "@alchemy/smart-accounts";
import { decodeAbiParameters } from "viem";
import { describe, expect, it } from "vitest";
import {
  buildSessionPermissionDefinition,
  EXECUTE_SELECTOR,
} from "./permissions.js";
import {
  decodeSettlementCall,
  encodeSettlementCall,
  settlementExecutorAbi,
  SETTLE_SELECTOR,
  type SettlementAttestation,
} from "./settlement.js";

const SESSION = "0x1111111111111111111111111111111111111111";
const EXECUTOR = "0x2222222222222222222222222222222222222222";
const PAYMASTER = "0x3333333333333333333333333333333333333333";

describe("session permission ABI encoding", () => {
  it("allows only account.execute and exact executor.settle", () => {
    const definition = buildSessionPermissionDefinition({
      sessionKeyAddress: SESSION,
      executorAddress: EXECUTOR,
      nativeLimitWei: 1_000n,
      entityId: 7,
    });

    expect(definition.validationConfig).toMatchObject({
      entityId: 7,
      isGlobal: false,
      isSignatureValidation: false,
      isUserOpValidation: true,
    });
    expect(definition.selectors).toEqual([EXECUTE_SELECTOR]);

    const allowlistHook = definition.hooks.find(
      ({ hookConfig }) =>
        hookConfig.address === DefaultModuleAddress.ALLOWLIST,
    );
    expect(allowlistHook).toBeDefined();
    const decoded = decodeAbiParameters(
      [
        { type: "uint32" },
        {
          type: "tuple[]",
          components: [
            { type: "address" },
            { type: "bool" },
            { type: "bool" },
            { type: "uint256" },
            { type: "bytes4[]" },
          ],
        },
      ],
      allowlistHook!.initData,
    );
    expect(decoded[0]).toBe(7);
    expect(decoded[1]).toEqual([
      [EXECUTOR, true, false, 0n, [SETTLE_SELECTOR]],
    ]);
  });

  it("installs validation and execution native-limit hooks without expiry", () => {
    const definition = buildSessionPermissionDefinition({
      sessionKeyAddress: SESSION,
      executorAddress: EXECUTOR,
      nativeLimitWei: 1_000n,
      entityId: 7,
    });
    const nativeHooks = definition.hooks.filter(
      ({ hookConfig }) =>
        hookConfig.address === DefaultModuleAddress.NATIVE_TOKEN_LIMIT,
    );
    expect(nativeHooks).toHaveLength(2);
    expect(definition.hooks.some(
      ({ hookConfig }) => hookConfig.address === DefaultModuleAddress.TIME_RANGE,
    )).toBe(false);
    expect(
      decodeAbiParameters(
        [{ type: "uint32" }, { type: "uint256" }],
        nativeHooks[0]!.initData,
      ),
    ).toEqual([7, 1_000n]);
    expect(nativeHooks[1]!.initData).toBe("0x");
  });

  it("adds the exact paymaster guard only when configured", () => {
    const withoutPaymaster = buildSessionPermissionDefinition({
      sessionKeyAddress: SESSION,
      executorAddress: EXECUTOR,
      nativeLimitWei: 1_000n,
      entityId: 7,
    });
    expect(
      withoutPaymaster.hooks.some(
        ({ hookConfig }) =>
          hookConfig.address === DefaultModuleAddress.PAYMASTER_GUARD,
      ),
    ).toBe(false);

    const withPaymaster = buildSessionPermissionDefinition({
      sessionKeyAddress: SESSION,
      executorAddress: EXECUTOR,
      nativeLimitWei: 1_000n,
      entityId: 7,
      paymasterAddress: PAYMASTER,
    });
    const guard = withPaymaster.hooks.find(
      ({ hookConfig }) =>
        hookConfig.address === DefaultModuleAddress.PAYMASTER_GUARD,
    );
    expect(
      decodeAbiParameters(
        [{ type: "uint32" }, { type: "address" }],
        guard!.initData,
      ),
    ).toEqual([7, PAYMASTER]);
  });

  it("uses the SDK encoders rather than hand-written module calldata", () => {
    expect(
      AllowlistModule.encodeOnInstallData({
        entityId: 0,
        inputs: [
          {
            target: EXECUTOR,
            hasSelectorAllowlist: true,
            hasERC20SpendLimit: false,
            erc20SpendLimit: 0n,
            selectors: [SETTLE_SELECTOR],
          },
        ],
      }),
    ).toBeTruthy();
    expect(
      NativeTokenLimitModule.encodeOnInstallData({
        entityId: 0,
        spendLimit: 1_000n,
      }),
    ).toBeTruthy();
    expect(
      PaymasterGuardModule.encodeOnInstallData({
        entityId: 0,
        paymaster: PAYMASTER,
      }),
    ).toBeTruthy();
  });
});

describe("settlement ABI encoding", () => {
  it("carries the same settle tuple as the compiled contract", async () => {
    // settlementExecutorAbi in settlement.ts is a HAND-WRITTEN copy of the
    // struct, kept hand-written because this package must be able to encode a
    // settlement with no Foundry present. A hand-written copy drifts, and this
    // one drifts SILENTLY in the worst direction: encodeSettlementCall would keep
    // producing well-formed calldata for a shape the executor no longer has, and
    // the session key's permission would keep authorising a selector that no
    // longer exists. Compared field by field against the generated artifact,
    // which is the only copy that cannot be wrong.
    const { abis } = await import("@nuvem/contracts-artifacts");
    type Param = { readonly name?: string; readonly type: string; readonly components?: readonly Param[] };
    const compiled = (abis.SettlementExecutor as readonly { type: string; name?: string; inputs?: readonly Param[] }[])
      .find((entry) => entry.type === "function" && entry.name === "settle");
    const shape = (params: readonly Param[]): string =>
      JSON.stringify(params.map((p) => ({ name: p.name ?? "", type: p.type, components: p.components ? shape(p.components) : null })));

    expect(compiled).toBeDefined();
    expect(shape(settlementExecutorAbi[0].inputs)).toBe(shape(compiled!.inputs!));
  });

  it("matches the selector derived from the finalized Solidity signature", () => {
    // settle() takes the whole SettlementAttestation struct, so this selector
    // moves whenever a FIELD is added — settle() itself need not change a line.
    // It went 0xf38ac34f -> 0xc8f2629d when startBlockL2/endBlockL2 were promoted
    // from ledgerRoot payload to real attestation fields, which is also the value
    // the session key permission below is scoped to. A stale selector here means
    // the smart account is permitted to call a function that no longer exists.
    expect(SETTLE_SELECTOR).toBe("0xc8f2629d");
  });

  it("round-trips the finalized settle tuple and signature", () => {
    const attestation: SettlementAttestation = {
      account: SESSION,
      vault: "0x4444444444444444444444444444444444444444",
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
      startBlock: 10n,
      endBlock: 20n,
      // Deliberately unlike the L1 pair and far from it: on this chain the two
      // clocks are millions apart, and a round trip that swapped them would look
      // correct if the fixture used the same numbers for both.
      startBlockL2: 1_200_000n,
      endBlockL2: 1_202_400n,
      cashStart: 100n,
      cashEnd: 150n,
      externalDeposits: 0n,
      externalWithdrawals: 0n,
      realizedProfit: 50n,
      contribution: 10n,
      attesterEpoch: 1,
      validAfter: 2,
      deadline: 3,
    };
    const signature = `0x${"12".repeat(65)}` as const;
    const calldata = encodeSettlementCall(attestation, signature);

    expect(calldata.slice(0, 10)).toBe(SETTLE_SELECTOR);
    expect(decodeSettlementCall(calldata)).toEqual({
      attestation,
      attesterSignature: signature,
    });
  });
});

describe("native token limit containment", () => {
  // NativeTokenLimitModule 1.0.0 decodes `execute` but NOT `executeBatch`:
  // three legs of 9e13 against a 1e14 cap pass its preExecutionHook, while the
  // same 2.7e14 as a single execute reverts ExceededNativeTokenLimit. Verified
  // live on chain 46630 against the deployed module.
  //
  // The only thing standing between that and an unbounded session key is this
  // selector list. Widening it — even "just to batch settlements" — silently
  // removes the value cap entirely. Hence this test.
  const EXECUTE_BATCH_SELECTOR = "0x34fcd5be";

  it("authorises the session key for execute only, never executeBatch", () => {
    const definition = buildSessionPermissionDefinition({
      sessionKeyAddress: SESSION,
      executorAddress: EXECUTOR,
      nativeLimitWei: 10n ** 14n,
      entityId: 1,
    });

    expect(definition.selectors).toEqual([EXECUTE_SELECTOR]);
    expect(definition.selectors).not.toContain(EXECUTE_BATCH_SELECTOR);
    expect(definition.validationConfig.isGlobal).toBe(false);
    expect(definition.validationConfig.isSignatureValidation).toBe(false);
  });

  it("keeps the allowlist pinned to one target and one selector", () => {
    const definition = buildSessionPermissionDefinition({
      sessionKeyAddress: SESSION,
      executorAddress: EXECUTOR,
      nativeLimitWei: 10n ** 14n,
      entityId: 1,
    });
    // A global validation would bypass the allowlist hook altogether.
    expect(definition.validationConfig.isUserOpValidation).toBe(true);
    expect(definition.hooks.length).toBeGreaterThanOrEqual(3);
  });
});
