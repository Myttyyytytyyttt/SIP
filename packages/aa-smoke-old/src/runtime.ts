import { estimateFeesPerGas } from "@alchemy/aa-infra";
import { alchemyTransport } from "@alchemy/common";
import { robinhoodTestnet } from "@alchemy/common/chains";
import { setGlobalLoggerConfig } from "@alchemy/common/internal";
import {
  installValidationActions,
  toModularAccountV2,
} from "@alchemy/smart-accounts";
import { createPublicClient, type Hash } from "viem";
import {
  createBundlerClient,
  createPaymasterClient,
} from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import type { SmokeConfig } from "./config.js";
import {
  buildSessionPermissionDefinition,
  EXECUTE_SELECTOR,
} from "./permissions.js";
import { SETTLE_SELECTOR } from "./settlement.js";

type OperationResult = {
  userOperationHash: Hash;
  transactionHash: Hash;
};

export type SmokeResult = {
  mode: "dry-run" | "broadcast";
  action: SmokeConfig["action"];
  chainId: number;
  accountMode: "7702";
  accountAddress: string;
  sessionKeyAddress: string;
  sessionEntityId: number;
  executorAddress: string;
  executeSelector: string;
  settleSelector: string;
  nativeLimitWei: string;
  noExpiry: true;
  executeBatchAllowed: false;
  paymasterGuard: string | "disabled";
  settlementPrepared: boolean;
  install?: OperationResult;
  settlement?: OperationResult;
};

export function buildDryRunResult(config: SmokeConfig): SmokeResult {
  return {
    mode: "dry-run",
    action: config.action,
    chainId: config.chainId,
    accountMode: "7702",
    accountAddress: config.ownerAddress,
    sessionKeyAddress: config.sessionKeyAddress,
    sessionEntityId: config.sessionEntityId,
    executorAddress: config.executorAddress,
    executeSelector: EXECUTE_SELECTOR,
    settleSelector: SETTLE_SELECTOR,
    nativeLimitWei: config.nativeLimitWei.toString(),
    noExpiry: true,
    executeBatchAllowed: false,
    paymasterGuard: config.paymaster?.address ?? "disabled",
    settlementPrepared: Boolean(config.preparedSettlement),
  };
}

export async function runSmoke(config: SmokeConfig): Promise<SmokeResult> {
  if (config.action === "dry-run") {
    // Build the exact pure permission inputs as part of the offline validation.
    buildSessionPermissionDefinition({
      sessionKeyAddress: config.sessionKeyAddress,
      executorAddress: config.executorAddress,
      nativeLimitWei: config.nativeLimitWei,
      entityId: config.sessionEntityId,
      paymasterAddress: config.paymaster?.address,
    });
    return buildDryRunResult(config);
  }

  if (!config.alchemyApiKey) {
    throw new Error("ALCHEMY_API_KEY is required for a broadcast action.");
  }

  // The CLI emits its own redacted summary. Suppress dependency diagnostics so
  // verbose SDK/request logging cannot accidentally expose signed operations,
  // policy identifiers, or credential-bearing URLs.
  setGlobalLoggerConfig({ sinks: [] });

  const transport = alchemyTransport({ apiKey: config.alchemyApiKey });
  const publicClient = createPublicClient({
    chain: robinhoodTestnet,
    transport,
  });
  const owner = privateKeyToAccount(config.ownerPrivateKey);
  const ownerAccount = await toModularAccountV2({
    client: publicClient,
    owner,
    mode: "7702",
  });

  const paymasterOptions = config.paymaster
    ? {
        paymaster: createPaymasterClient({
          transport,
        }),
        paymasterContext: { policyId: config.paymaster.policyId },
      }
    : {};

  const ownerClient = createBundlerClient({
    account: ownerAccount,
    client: publicClient,
    chain: robinhoodTestnet,
    transport,
    userOperation: { estimateFeesPerGas },
    ...paymasterOptions,
  }).extend(installValidationActions);

  const result: SmokeResult = {
    ...buildDryRunResult(config),
    mode: "broadcast",
  };

  if (config.action === "install" || config.action === "install-and-settle") {
    const permission = buildSessionPermissionDefinition({
      sessionKeyAddress: config.sessionKeyAddress,
      executorAddress: config.executorAddress,
      nativeLimitWei: config.nativeLimitWei,
      entityId: config.sessionEntityId,
      paymasterAddress: config.paymaster?.address,
    });
    const callData = await ownerClient.encodeInstallValidation(permission);
    const userOperationHash = await ownerClient.sendUserOperation({ callData });
    const receipt = await ownerClient.waitForUserOperationReceipt({
      hash: userOperationHash,
    });
    result.install = {
      userOperationHash,
      transactionHash: receipt.receipt.transactionHash,
    };
  }

  if (config.action === "settle" || config.action === "install-and-settle") {
    const prepared = config.preparedSettlement;
    if (!prepared) {
      throw new Error("A prepared settlement is required.");
    }

    const sessionKeyAccount = await toModularAccountV2({
      client: publicClient,
      owner: privateKeyToAccount(config.sessionPrivateKey),
      accountAddress: ownerAccount.address,
      signerEntity: {
        entityId: config.sessionEntityId,
        isGlobalValidation: false,
      },
    });
    const sessionClient = createBundlerClient({
      account: sessionKeyAccount,
      client: publicClient,
      chain: robinhoodTestnet,
      transport,
      userOperation: { estimateFeesPerGas },
      ...paymasterOptions,
    });
    const userOperationHash = await sessionClient.sendUserOperation({
      calls: [
        {
          to: config.executorAddress,
          data: prepared.calldata,
          value: prepared.valueWei,
        },
      ],
    });
    const receipt = await sessionClient.waitForUserOperationReceipt({
      hash: userOperationHash,
    });
    result.settlement = {
      userOperationHash,
      transactionHash: receipt.receipt.transactionHash,
    };
  }

  return result;
}
