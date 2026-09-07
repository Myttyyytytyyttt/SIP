import {
  decodeFunctionData,
  encodeFunctionData,
  getAbiItem,
  getAddress,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem";

export const ROBINHOOD_TESTNET_CHAIN_ID = 46_630;

export type SettlementAttestation = {
  account: Address;
  vault: Address;
  executor: Address;
  chainId: bigint;
  bindingEpoch: bigint;
  policyNonce: bigint;
  adminEpoch: bigint;
  localPauseEpoch: bigint;
  globalPauseEpoch: bigint;
  settlementNonce: bigint;
  policyHash: Hex;
  sessionId: Hex;
  ledgerRoot: Hex;
  /** The L1 pair, which is what the contract compares against block.number. */
  startBlock: bigint;
  endBlock: bigint;
  /**
   * The L2 pair, which is what the vault progresses on and what deriveSessionId
   * folds in. ~120 L2 blocks fit inside one L1 block on this chain, so two
   * genuinely distinct sessions routinely share an L1 range; progression had to
   * move to the finer clock, and these fields are what makes it visible to the
   * contract at all.
   */
  startBlockL2: bigint;
  endBlockL2: bigint;
  cashStart: bigint;
  cashEnd: bigint;
  externalDeposits: bigint;
  externalWithdrawals: bigint;
  realizedProfit: bigint;
  contribution: bigint;
  attesterEpoch: number;
  validAfter: number;
  deadline: number;
};

export const settlementExecutorAbi = [
  {
    type: "function",
    name: "settle",
    stateMutability: "payable",
    inputs: [
      {
        name: "attestation",
        type: "tuple",
        internalType: "struct SettlementAttestation",
        components: [
          { name: "account", type: "address" },
          { name: "vault", type: "address" },
          { name: "executor", type: "address" },
          { name: "chainId", type: "uint256" },
          { name: "bindingEpoch", type: "uint64" },
          { name: "policyNonce", type: "uint64" },
          { name: "adminEpoch", type: "uint64" },
          { name: "localPauseEpoch", type: "uint64" },
          { name: "globalPauseEpoch", type: "uint64" },
          { name: "settlementNonce", type: "uint64" },
          { name: "policyHash", type: "bytes32" },
          { name: "sessionId", type: "bytes32" },
          { name: "ledgerRoot", type: "bytes32" },
          { name: "startBlock", type: "uint64" },
          { name: "endBlock", type: "uint64" },
          { name: "startBlockL2", type: "uint64" },
          { name: "endBlockL2", type: "uint64" },
          { name: "cashStart", type: "uint256" },
          { name: "cashEnd", type: "uint256" },
          { name: "externalDeposits", type: "uint256" },
          { name: "externalWithdrawals", type: "uint256" },
          { name: "realizedProfit", type: "int256" },
          { name: "contribution", type: "uint256" },
          { name: "attesterEpoch", type: "uint32" },
          { name: "validAfter", type: "uint48" },
          { name: "deadline", type: "uint48" },
        ],
      },
      { name: "attesterSignature", type: "bytes" },
    ],
    outputs: [{ name: "savedAmount", type: "uint256" }],
  },
] as const;

export const SETTLE_SELECTOR = toFunctionSelector(
  getAbiItem({ abi: settlementExecutorAbi, name: "settle" }),
);

export function encodeSettlementCall(
  attestation: SettlementAttestation,
  attesterSignature: Hex,
): Hex {
  return encodeFunctionData({
    abi: settlementExecutorAbi,
    functionName: "settle",
    args: [attestation, attesterSignature],
  });
}

export function decodeSettlementCall(calldata: Hex): {
  attestation: SettlementAttestation;
  attesterSignature: Hex;
} {
  let decoded: ReturnType<typeof decodeFunctionData<typeof settlementExecutorAbi>>;

  try {
    decoded = decodeFunctionData({
      abi: settlementExecutorAbi,
      data: calldata,
    });
  } catch {
    throw new Error("SETTLEMENT_CALLDATA is not valid SettlementExecutor.settle calldata.");
  }

  if (decoded.functionName !== "settle") {
    throw new Error("SETTLEMENT_CALLDATA must call SettlementExecutor.settle.");
  }

  const [attestation, attesterSignature] = decoded.args;
  return {
    attestation: {
      ...attestation,
      account: getAddress(attestation.account),
      vault: getAddress(attestation.vault),
      executor: getAddress(attestation.executor),
    },
    attesterSignature,
  };
}

