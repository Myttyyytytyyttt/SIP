import {
  getAddress,
  isAddress,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  decodeSettlementCall,
  ROBINHOOD_TESTNET_CHAIN_ID,
  type SettlementAttestation,
} from "./settlement.js";

export type SmokeAction =
  | "dry-run"
  | "install"
  | "settle"
  | "install-and-settle";

export type PreparedSettlement = {
  calldata: Hex;
  valueWei: bigint;
  attestation: SettlementAttestation;
};

export type SmokeConfig = {
  action: SmokeAction;
  chainId: typeof ROBINHOOD_TESTNET_CHAIN_ID;
  alchemyApiKey?: string;
  ownerPrivateKey: Hex;
  ownerAddress: Address;
  sessionPrivateKey: Hex;
  sessionKeyAddress: Address;
  executorAddress: Address;
  sessionEntityId: number;
  nativeLimitWei: bigint;
  paymaster?: {
    address: Address;
    policyId: string;
  };
  preparedSettlement?: PreparedSettlement;
};

type Environment = Record<string, string | undefined>;
const MAX_UINT256 = (1n << 256n) - 1n;

function optional(env: Environment, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

function required(env: Environment, key: string): string {
  const value = optional(env, key);
  if (!value) {
    throw new Error(`${key} is required.`);
  }
  return value;
}

function parseAction(value: string | undefined): SmokeAction {
  const action = value ?? "dry-run";
  if (
    action !== "dry-run" &&
    action !== "install" &&
    action !== "settle" &&
    action !== "install-and-settle"
  ) {
    throw new Error(
      "AA_SMOKE_ACTION must be dry-run, install, settle, or install-and-settle.",
    );
  }
  return action;
}

function parsePrivateKey(env: Environment, key: string): Hex {
  const value = required(env, key);
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${key} must be a 32-byte 0x-prefixed private key.`);
  }

  try {
    privateKeyToAccount(value as Hex);
  } catch {
    throw new Error(`${key} is not a valid secp256k1 private key.`);
  }

  return value as Hex;
}

function parseAddress(env: Environment, key: string): Address {
  const value = required(env, key);
  if (!isAddress(value)) {
    throw new Error(`${key} must be a valid EVM address.`);
  }
  const address = getAddress(value);
  if (address === zeroAddress) {
    throw new Error(`${key} must not be the zero address.`);
  }
  return address;
}

function parseUnsignedDecimal(
  env: Environment,
  key: string,
  options: { required: true; positive?: boolean },
): bigint;
function parseUnsignedDecimal(
  env: Environment,
  key: string,
  options?: { required?: false; positive?: boolean },
): bigint | undefined;
function parseUnsignedDecimal(
  env: Environment,
  key: string,
  options: { required?: boolean; positive?: boolean } = {},
): bigint | undefined {
  const raw = options.required ? required(env, key) : optional(env, key);
  if (raw === undefined) {
    return undefined;
  }
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new Error(`${key} must be an unsigned base-10 integer.`);
  }
  const parsed = BigInt(raw);
  if (options.positive && parsed === 0n) {
    throw new Error(`${key} must be greater than zero.`);
  }
  if (parsed > MAX_UINT256) {
    throw new Error(`${key} must fit in uint256.`);
  }
  return parsed;
}

function parseEntityId(value: string | undefined): number {
  const raw = value ?? "1";
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(
      "SESSION_ENTITY_ID must be positive and below 2147483647.",
    );
  }
  const parsed = Number(raw);
  // Alchemy reserves the upper half of uint32 for hook-storage namespaces.
  if (!Number.isSafeInteger(parsed) || parsed >= 2_147_483_647) {
    throw new Error(
      "SESSION_ENTITY_ID must be positive and below 2147483647.",
    );
  }
  return parsed;
}

function parseHexCalldata(value: string, key: string): Hex {
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(value)) {
    throw new Error(`${key} must be non-empty, even-length 0x-prefixed hex.`);
  }
  return value as Hex;
}

export function parseSmokeConfig(env: Environment): SmokeConfig {
  const action = parseAction(optional(env, "AA_SMOKE_ACTION"));
  const chainIdRaw = optional(env, "RH_TESTNET_CHAIN_ID") ?? "46630";
  if (chainIdRaw !== String(ROBINHOOD_TESTNET_CHAIN_ID)) {
    throw new Error(
      `RH_TESTNET_CHAIN_ID must be ${ROBINHOOD_TESTNET_CHAIN_ID}; refusing another chain.`,
    );
  }

  const ownerPrivateKey = parsePrivateKey(env, "TRADING_OWNER_PRIVATE_KEY");
  const ownerAddress = privateKeyToAccount(ownerPrivateKey).address;
  const sessionPrivateKey = parsePrivateKey(env, "SESSION_KEY_PRIVATE_KEY");
  const sessionKeyAddress = privateKeyToAccount(sessionPrivateKey).address;
  if (ownerAddress === sessionKeyAddress) {
    throw new Error(
      "TRADING_OWNER_PRIVATE_KEY and SESSION_KEY_PRIVATE_KEY must be different.",
    );
  }

  const executorAddress = parseAddress(env, "SETTLEMENT_EXECUTOR_ADDRESS");
  const nativeLimitWei = parseUnsignedDecimal(env, "SESSION_NATIVE_LIMIT_WEI", {
    required: true,
    positive: true,
  });
  const sessionEntityId = parseEntityId(optional(env, "SESSION_ENTITY_ID"));

  const alchemyApiKey = optional(env, "ALCHEMY_API_KEY");
  if (action !== "dry-run" && !alchemyApiKey) {
    throw new Error("ALCHEMY_API_KEY is required for a broadcast action.");
  }

  const policyId = optional(env, "ALCHEMY_GAS_POLICY_ID");
  const paymasterAddressRaw = optional(env, "ALCHEMY_PAYMASTER_ADDRESS");
  if ((policyId && !paymasterAddressRaw) || (!policyId && paymasterAddressRaw)) {
    throw new Error(
      "ALCHEMY_GAS_POLICY_ID and ALCHEMY_PAYMASTER_ADDRESS must be configured together.",
    );
  }
  const paymaster =
    policyId && paymasterAddressRaw
      ? {
          policyId,
          address: parseAddress(env, "ALCHEMY_PAYMASTER_ADDRESS"),
        }
      : undefined;

  const calldataRaw = optional(env, "SETTLEMENT_CALLDATA");
  const valueRaw = optional(env, "SETTLEMENT_VALUE_WEI");
  if ((calldataRaw && !valueRaw) || (!calldataRaw && valueRaw)) {
    throw new Error(
      "SETTLEMENT_CALLDATA and SETTLEMENT_VALUE_WEI must be configured together.",
    );
  }

  let preparedSettlement: PreparedSettlement | undefined;
  if (calldataRaw && valueRaw) {
    const calldata = parseHexCalldata(calldataRaw, "SETTLEMENT_CALLDATA");
    const valueWei = parseUnsignedDecimal(env, "SETTLEMENT_VALUE_WEI", {
      required: true,
      positive: true,
    });
    const { attestation } = decodeSettlementCall(calldata);

    if (attestation.account !== ownerAddress) {
      throw new Error(
        "Prepared settlement account does not match TRADING_OWNER_PRIVATE_KEY.",
      );
    }
    if (attestation.executor !== executorAddress) {
      throw new Error(
        "Prepared settlement executor does not match SETTLEMENT_EXECUTOR_ADDRESS.",
      );
    }
    if (attestation.vault === zeroAddress) {
      throw new Error("Prepared settlement vault must not be the zero address.");
    }
    if (attestation.chainId !== BigInt(ROBINHOOD_TESTNET_CHAIN_ID)) {
      throw new Error(
        `Prepared settlement chainId must be ${ROBINHOOD_TESTNET_CHAIN_ID}.`,
      );
    }
    if (attestation.contribution !== valueWei) {
      throw new Error(
        "SETTLEMENT_VALUE_WEI must equal the attestation contribution.",
      );
    }
    if (valueWei >= nativeLimitWei) {
      throw new Error(
        "SESSION_NATIVE_LIMIT_WEI must exceed SETTLEMENT_VALUE_WEI to leave room for unsponsored gas.",
      );
    }
    preparedSettlement = { calldata, valueWei, attestation };
  }

  const requiresSettlement =
    action === "settle" || action === "install-and-settle";
  if (requiresSettlement && !preparedSettlement) {
    throw new Error(
      `${action} requires SETTLEMENT_CALLDATA and SETTLEMENT_VALUE_WEI.`,
    );
  }
  if (action === "install" && preparedSettlement) {
    throw new Error(
      "Settlement payload variables are not accepted when AA_SMOKE_ACTION=install.",
    );
  }

  return {
    action,
    chainId: ROBINHOOD_TESTNET_CHAIN_ID,
    alchemyApiKey,
    ownerPrivateKey,
    ownerAddress,
    sessionPrivateKey,
    sessionKeyAddress,
    executorAddress,
    sessionEntityId,
    nativeLimitWei,
    paymaster,
    preparedSettlement,
  };
}

export function secretValues(config: SmokeConfig): string[] {
  return [
    config.ownerPrivateKey,
    config.sessionPrivateKey,
    config.alchemyApiKey,
    config.paymaster?.policyId,
  ].filter((value): value is string => Boolean(value));
}
