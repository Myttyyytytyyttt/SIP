import {
  AllowlistModule,
  DefaultModuleAddress,
  NativeTokenLimitModule,
  PaymasterGuardModule,
  SingleSignerValidationModule,
  semiModularAccountV2StaticImpl,
  type HookConfig,
  type InstallValidationParams,
} from "@alchemy/smart-accounts";
import { getAbiItem, toFunctionSelector, type Address, type Hex } from "viem";
import { SETTLE_SELECTOR } from "./settlement.js";

const HookType = {
  EXECUTION: "0x00",
  VALIDATION: "0x01",
} as const;

export const EXECUTE_SELECTOR = toFunctionSelector(
  getAbiItem({
    abi: semiModularAccountV2StaticImpl.accountAbi,
    name: "execute",
  }),
);

export type SessionPermissionInput = {
  sessionKeyAddress: Address;
  executorAddress: Address;
  nativeLimitWei: bigint;
  entityId: number;
  paymasterAddress?: Address;
};

export type SessionPermissionDefinition = Omit<
  InstallValidationParams,
  "account"
>;

function hook(
  hookConfig: HookConfig,
  initData: Hex,
): SessionPermissionDefinition["hooks"][number] {
  return { hookConfig, initData };
}

export function buildSessionPermissionDefinition({
  sessionKeyAddress,
  executorAddress,
  nativeLimitWei,
  entityId,
  paymasterAddress,
}: SessionPermissionInput): SessionPermissionDefinition {
  // Keep every hook configuration namespaced to this session validation.
  // Reusing zero would collide when a key is rotated under a new entity ID.
  const hookEntityId = entityId;
  const hooks: SessionPermissionDefinition["hooks"] = [
    hook(
      {
        address: DefaultModuleAddress.ALLOWLIST,
        entityId: hookEntityId,
        hookType: HookType.VALIDATION,
        hasPreHooks: true,
        hasPostHooks: false,
      },
      AllowlistModule.encodeOnInstallData({
        entityId: hookEntityId,
        inputs: [
          {
            target: executorAddress,
            hasSelectorAllowlist: true,
            hasERC20SpendLimit: false,
            erc20SpendLimit: 0n,
            selectors: [SETTLE_SELECTOR],
          },
        ],
      }),
    ),
    hook(
      {
        address: DefaultModuleAddress.NATIVE_TOKEN_LIMIT,
        entityId: hookEntityId,
        hookType: HookType.VALIDATION,
        hasPreHooks: true,
        hasPostHooks: false,
      },
      NativeTokenLimitModule.encodeOnInstallData({
        entityId: hookEntityId,
        spendLimit: nativeLimitWei,
      }),
    ),
    hook(
      {
        address: DefaultModuleAddress.NATIVE_TOKEN_LIMIT,
        entityId: hookEntityId,
        hookType: HookType.EXECUTION,
        hasPreHooks: true,
        hasPostHooks: false,
      },
      "0x",
    ),
  ];

  if (paymasterAddress) {
    hooks.push(
      hook(
        {
          address: DefaultModuleAddress.PAYMASTER_GUARD,
          entityId: hookEntityId,
          hookType: HookType.VALIDATION,
          hasPreHooks: true,
          hasPostHooks: false,
        },
        PaymasterGuardModule.encodeOnInstallData({
          entityId: hookEntityId,
          paymaster: paymasterAddress,
        }),
      ),
    );
  }

  return {
    validationConfig: {
      moduleAddress: DefaultModuleAddress.SINGLE_SIGNER_VALIDATION,
      entityId,
      isGlobal: false,
      isSignatureValidation: false,
      isUserOpValidation: true,
    },
    selectors: [EXECUTE_SELECTOR],
    installData: SingleSignerValidationModule.encodeOnInstallData({
      entityId,
      signer: sessionKeyAddress,
    }),
    hooks,
  };
}
