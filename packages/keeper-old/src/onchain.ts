// The chain access seam.
//
// Every read and write the keeper performs goes through `ChainAccess`. That is
// not indirection for its own sake: the dangerous paths in this package —
// crash-after-broadcast recovery, refusing an already-settled window, the
// dry-run gate — are exactly the paths that must be tested, and they cannot be
// tested against a live L2. A narrow, fully stubbable interface is what makes
// the tests in test/ offline and deterministic.
//
// ABIs come from @nuvem/contracts-artifacts, never from packages/contracts/out.
// settle.mjs reads the Foundry output directory directly, which works on a
// developer's machine and fails in a container where Foundry is not installed.

import {
  createPublicClient,
  decodeFunctionData,
  encodeFunctionData,
  http,
  type Abi,
  type AbiEvent,
  type Hex,
  type PublicClient,
} from "viem";
import { abis } from "@nuvem/contracts-artifacts";

export const EXECUTOR_ABI = abis.SettlementExecutor;
export const VAULT_ABI = abis.PersonalVault;
export const FACTORY_ABI = abis.VaultFactory;
export const PAUSE_ABI = abis.ProtocolPauseController;
export const REGISTRY_ABI = abis.AttesterRegistry;

const SETTLEMENT_EXECUTED = (EXECUTOR_ABI as Abi).find(
  (item): item is AbiEvent => item.type === "event" && item.name === "SettlementExecuted",
);
if (!SETTLEMENT_EXECUTED) {
  throw new Error("@nuvem/contracts-artifacts has no SettlementExecuted event; the ABI bundle is wrong.");
}
export const SETTLEMENT_EXECUTED_EVENT: AbiEvent = SETTLEMENT_EXECUTED;

/**
 * The executor's ABI plus every custom error the whole settle call path can
 * raise.
 *
 * settle() delegates into PersonalVault.acceptSettlement, and into the pause
 * controller and the attester registry. A revert from any of those arrives as a
 * bare 4-byte selector that the executor's own ABI cannot name, so an operator
 * reading a failed estimate sees "0x886efb0a" instead of
 * "NonProgressiveBlockRange". Those are not the same message: the second one says
 * "the vault is refusing a window whose range does not progress", which is a
 * complete diagnosis. Merging the error entries is the whole fix.
 */
export const SETTLE_ERROR_ABI: Abi = [
  ...(EXECUTOR_ABI as Abi),
  ...([VAULT_ABI, PAUSE_ABI, REGISTRY_ABI, FACTORY_ABI] as Abi[]).flatMap((abi) =>
    abi.filter((item) => item.type === "error"),
  ),
];

/** The struct SettlementExecutor.settle takes, as viem wants it. */
export interface SettlementAttestation {
  readonly account: `0x${string}`;
  readonly vault: `0x${string}`;
  readonly executor: `0x${string}`;
  readonly chainId: bigint;
  readonly bindingEpoch: bigint;
  readonly policyNonce: bigint;
  readonly adminEpoch: bigint;
  readonly localPauseEpoch: bigint;
  readonly globalPauseEpoch: bigint;
  readonly settlementNonce: bigint;
  readonly policyHash: Hex;
  readonly sessionId: Hex;
  readonly ledgerRoot: Hex;
  /**
   * The L1 pair. This is the range the contract compares against block.number:
   * freshness (`endBlock < block.number`) and the activationBlock floor are both
   * enforced here, because on Arbitrum Nitro `block.number` in Solidity IS the
   * L1 number and it is the only clock the chain can check a claim against.
   */
  readonly startBlock: bigint;
  readonly endBlock: bigint;
  /**
   * The L2 pair, which is what settlement progression is now enforced on.
   *
   * A trading session is an event in L2 time — ~0.1s per L2 block against ~12s
   * per L1 block, about 120 L2 blocks inside each L1 block. Progressing on the
   * L1 pair meant a trader who re-entered within ~12 seconds of closing produced
   * a session whose start mapped into the same L1 block as the previous end, and
   * the vault refused it permanently. These fields were already travelling
   * inside ledgerRoot, where the contract could not see them; carrying them as
   * real attestation fields is what makes them enforceable.
   */
  readonly startBlockL2: bigint;
  readonly endBlockL2: bigint;
  readonly cashStart: bigint;
  readonly cashEnd: bigint;
  readonly externalDeposits: bigint;
  readonly externalWithdrawals: bigint;
  readonly realizedProfit: bigint;
  readonly contribution: bigint;
  readonly attesterEpoch: number;
  readonly validAfter: number;
  readonly deadline: number;
}

/**
 * The EIP-712 type, transcribed from SettlementExecutor's own hashAttestation.
 * Field order is part of the digest, so this list is not cosmetic — a reordered
 * entry produces a signature the contract rejects with InvalidAttesterSignature.
 * attest.ts cross-checks the locally computed digest against hashAttestation()
 * before any gas is spent, which is what catches a drift here.
 */
export const ATTESTATION_TYPES = {
  SettlementAttestation: [
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
} as const;

/**
 * The type list above is hand-written, and hand-written copies of a struct drift.
 *
 * attest.ts already compares the locally computed digest against the executor's
 * own hashAttestation() before spending gas, which catches this — but only on a
 * live chain, and only once a real session is ready to settle. That is the worst
 * possible moment to discover it: the keeper is unattended, the window is
 * closing, and the failure arrives as a refusal on a settlement the trader
 * earned. The ABI is right here and is generated from the compiled contract, so
 * check at import instead.
 *
 * Names and order are both load-bearing: EIP-712 hashes the type string, so a
 * renamed or reordered field changes the digest and produces a signature the
 * contract rejects with InvalidAttesterSignature.
 */
{
  const settle = (EXECUTOR_ABI as Abi).find(
    (item): item is Extract<Abi[number], { type: "function" }> =>
      item.type === "function" && item.name === "settle",
  );
  const components = (settle?.inputs?.[0] as { components?: readonly { name?: string; type: string }[] } | undefined)
    ?.components;
  if (!components) {
    throw new Error("@nuvem/contracts-artifacts has no SettlementExecutor.settle(attestation, ...); the ABI bundle is wrong.");
  }
  const fromAbi = components.map((component) => `${component.name ?? ""}:${component.type}`).join(",");
  const fromTypes = ATTESTATION_TYPES.SettlementAttestation.map((field) => `${field.name}:${field.type}`).join(",");
  if (fromAbi !== fromTypes) {
    throw new Error(
      "ATTESTATION_TYPES has drifted from SettlementAttestation in @nuvem/contracts-artifacts. " +
        "Every signature this keeper produces would be rejected as InvalidAttesterSignature.\n" +
        `  contracts: ${fromAbi}\n` +
        `  onchain.ts: ${fromTypes}`,
    );
  }
}

/** SettlementExecutor is constructed with EIP712("Nuvem Settlement Executor", "1"). */
export const DOMAIN_NAME = "Nuvem Settlement Executor";
export const DOMAIN_VERSION = "1";

export interface AccountPolicy {
  readonly savingsBps: number;
  readonly minContributionWei: bigint;
  readonly maxPerSettlementWei: bigint;
  readonly maxRolling30dWei: bigint;
  readonly tradingFloorWei: bigint;
  readonly gasReserveWei: bigint;
}

/**
 * Everything the attestation binds to, read in one pass.
 *
 * Read together on purpose: the attestation commits every one of these, so
 * anything that changes between reading them and mining invalidates the
 * signature. That is the intended behaviour, not a race to be papered over —
 * but reading them at different times would mean signing a set of values that
 * was never simultaneously true.
 */
export interface VaultSnapshot {
  readonly activeVault: `0x${string}`;
  /** NuvemTypes.AccountStatus: 0 NONE, 1 PENDING, 2 ACTIVE, 3 PAUSED, 4 REVOKED. */
  readonly status: number;
  readonly bindingEpoch: bigint;
  readonly policyNonce: bigint;
  readonly settlementNonce: bigint;
  readonly activationBlockL1: bigint;
  readonly revocationBlockL1: bigint;
  readonly policy: AccountPolicy;
  readonly policyHash: Hex;
  readonly adminEpoch: bigint;
  readonly localPauseEpoch: bigint;
  readonly globalPauseEpoch: bigint;
  readonly attesterEpoch: number;
  readonly registeredAttester: `0x${string}`;
  readonly protocolPaused: boolean;
  readonly settlementPaused: boolean;
  readonly lifetimeContribution: bigint;
  readonly accountBalanceWei: bigint;
}

export const ACCOUNT_STATUS_ACTIVE = 2;

export interface SettlementLog {
  readonly sessionId: Hex;
  readonly account: `0x${string}`;
  readonly vault: `0x${string}`;
  readonly settlementNonce: bigint;
  readonly realizedProfit: bigint;
  readonly contribution: bigint;
  readonly ledgerRoot: Hex;
  readonly transactionHash: Hex;
  readonly blockNumber: bigint;
}

export interface MinedTx {
  readonly hash: Hex;
  readonly input: Hex;
  readonly blockNumber: bigint | null;
}

export interface MinedReceipt {
  readonly transactionHash: Hex;
  readonly status: "success" | "reverted";
  readonly blockNumber: bigint;
  readonly gasUsed: bigint;
}

export interface FeeQuote {
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
}

export interface ChainAccess {
  getChainId(): Promise<number>;
  /** eth_blockNumber, i.e. the L2 height. */
  getHeadBlockL2(): Promise<bigint>;
  /** The L1 height Solidity's block.number reports at this L2 block. */
  getL1BlockNumber(l2Block: bigint): Promise<bigint>;
  getBlockHash(l2Block: bigint): Promise<Hex | null>;
  readVaultSnapshot(account: `0x${string}`): Promise<VaultSnapshot>;
  /**
   * The replay key now commits to the L2 window as well as the L1 one.
   *
   * Without the L2 pair, two distinct sessions collapsed onto a single L1 range
   * derive the same sessionId whenever their ledgerRoots collide, and the
   * vault's usedSessions guard refuses the second — reintroducing the exact
   * liveness bug the L2 progression change exists to fix, one layer down.
   */
  deriveSessionId(args: {
    chainId: bigint;
    vault: `0x${string}`;
    account: `0x${string}`;
    bindingEpoch: bigint;
    startBlockL1: bigint;
    endBlockL1: bigint;
    startBlockL2: bigint;
    endBlockL2: bigint;
    ledgerRoot: Hex;
  }): Promise<Hex>;
  previewContribution(attestation: SettlementAttestation): Promise<bigint>;
  hashAttestation(attestation: SettlementAttestation): Promise<Hex>;
  /** SettlementExecuted logs, optionally narrowed by the indexed sessionId. */
  getSettlementLogs(filter: {
    fromBlockL2: bigint;
    toBlockL2?: bigint | "latest";
    sessionId?: Hex;
    account?: `0x${string}`;
  }): Promise<readonly SettlementLog[]>;
  getTransaction(hash: Hex): Promise<MinedTx | null>;
  getTransactionReceipt(hash: Hex): Promise<MinedReceipt | null>;
  /** Latest (mined) nonce of the account. */
  getTransactionCount(address: `0x${string}`): Promise<number>;
  /** Pending nonce, which is the one a new transaction must be signed for. */
  getPendingTransactionCount(address: `0x${string}`): Promise<number>;
  estimateSettleGas(args: {
    account: `0x${string}`;
    attestation: SettlementAttestation;
    signature: Hex;
  }): Promise<bigint>;
  getFeeQuote(): Promise<FeeQuote>;
  sendRawTransaction(raw: Hex): Promise<Hex>;
  waitForReceipt(hash: Hex, timeoutMs: number): Promise<MinedReceipt | null>;
}

/** Encodes the settle calldata. Shared by the dry-run plan and the live send. */
export function encodeSettleCalldata(attestation: SettlementAttestation, signature: Hex): Hex {
  return encodeFunctionData({
    abi: EXECUTOR_ABI,
    functionName: "settle",
    args: [attestation, signature],
  });
}

/**
 * Recovers the full attestation from a settle transaction's calldata.
 *
 * This is the load-bearing half of recovery. Neither SettlementExecuted nor
 * ContributionReceived carries startBlock/endBlock, and PersonalVault exposes NO
 * getter for lastEndBlock or usedSessions (they are private namespaced storage).
 * Decoding the calldata is therefore the only supported way to rebuild the
 * settled-boundary map purely from chain history — which is what makes the local
 * journal a cache rather than the sole record. Do not reach for eth_getStorageAt
 * against ERC-7201 slots instead.
 */
export function decodeSettleCalldata(
  input: Hex,
): { attestation: SettlementAttestation; signature: Hex } | null {
  try {
    const decoded = decodeFunctionData({ abi: EXECUTOR_ABI, data: input });
    if (decoded.functionName !== "settle") return null;
    const args = decoded.args as readonly unknown[];
    return {
      attestation: args[0] as SettlementAttestation,
      signature: args[1] as Hex,
    };
  } catch {
    return null;
  }
}

export interface ViemChainOptions {
  readonly rpcUrl: string;
  readonly chainId: number;
  readonly executor: `0x${string}`;
  readonly vault: `0x${string}`;
  readonly factory: `0x${string}`;
  readonly pauseController: `0x${string}`;
  readonly attesterRegistry: `0x${string}`;
  /** Counts every RPC call so a tick can be abandoned rather than truncated. */
  readonly onCall?: (method: string) => void;
}

interface RawTradingAccount {
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

export function createViemChainAccess(options: ViemChainOptions): ChainAccess {
  const count = options.onCall ?? (() => {});
  // No `batch: true`. JSON-RPC batching is an unverified capability of this
  // endpoint, and a silently-dropped sub-request would look like a smaller,
  // plausible answer rather than an error.
  const client: PublicClient = createPublicClient({
    transport: http(options.rpcUrl, { retryCount: 4, retryDelay: 250 }),
  });

  const read = async <T>(method: string, fn: () => Promise<T>): Promise<T> => {
    count(method);
    return fn();
  };

  return {
    getChainId: () => read("eth_chainId", () => client.getChainId()),

    getHeadBlockL2: () => read("eth_blockNumber", () => client.getBlockNumber()),

    getL1BlockNumber: async (l2Block) =>
      read("eth_getBlockByNumber", async () => {
        const block = (await client.request({
          method: "eth_getBlockByNumber",
          params: [`0x${l2Block.toString(16)}`, false],
        } as never)) as { l1BlockNumber?: string } | null;
        if (!block || block.l1BlockNumber === undefined) {
          // Refuse rather than guess. The L1/L2 gap is NOT a constant on this
          // chain: it was measured at 3,551,127 on one day and ~2.65M the next,
          // because L2 advances far faster than L1. Any code that stores a delta
          // and adds it produces InvalidBlockRange reverts.
          throw new Error(
            `Block ${l2Block} has no l1BlockNumber. The attested range must be L1 and it can only ` +
              "be read per-block; there is no constant offset to fall back on.",
          );
        }
        return BigInt(block.l1BlockNumber);
      }),

    getBlockHash: async (l2Block) =>
      read("eth_getBlockByNumber", async () => {
        const block = (await client.request({
          method: "eth_getBlockByNumber",
          params: [`0x${l2Block.toString(16)}`, false],
        } as never)) as { hash?: Hex } | null;
        return block?.hash ?? null;
      }),

    readVaultSnapshot: async (account) => {
      count("readVaultSnapshot");
      const [
        activeVault,
        tradingAccount,
        policyHash,
        adminEpoch,
        localPauseEpoch,
        settlementPaused,
        lifetimeContribution,
        globalPauseEpoch,
        protocolPaused,
        attesterEpoch,
        registeredAttester,
        accountBalanceWei,
      ] = await Promise.all([
        client.readContract({ address: options.factory, abi: FACTORY_ABI, functionName: "activeVaultOf", args: [account] }),
        client.readContract({ address: options.vault, abi: VAULT_ABI, functionName: "getTradingAccount", args: [account] }),
        client.readContract({ address: options.vault, abi: VAULT_ABI, functionName: "policyHash", args: [account] }),
        client.readContract({ address: options.vault, abi: VAULT_ABI, functionName: "adminEpoch" }),
        client.readContract({ address: options.vault, abi: VAULT_ABI, functionName: "localPauseEpoch" }),
        client.readContract({ address: options.vault, abi: VAULT_ABI, functionName: "settlementPaused" }),
        client.readContract({ address: options.vault, abi: VAULT_ABI, functionName: "lifetimeContribution", args: [account] }),
        client.readContract({ address: options.pauseController, abi: PAUSE_ABI, functionName: "pauseEpoch" }),
        client.readContract({ address: options.pauseController, abi: PAUSE_ABI, functionName: "paused" }),
        client.readContract({ address: options.attesterRegistry, abi: REGISTRY_ABI, functionName: "attesterEpoch" }),
        client.readContract({ address: options.attesterRegistry, abi: REGISTRY_ABI, functionName: "attester" }),
        client.getBalance({ address: account }),
      ]);

      const ta = tradingAccount as unknown as RawTradingAccount;
      return {
        activeVault: activeVault as `0x${string}`,
        status: Number(ta.status),
        bindingEpoch: BigInt(ta.bindingEpoch),
        policyNonce: BigInt(ta.policyNonce),
        settlementNonce: BigInt(ta.settlementNonce),
        activationBlockL1: BigInt(ta.activationBlock),
        revocationBlockL1: BigInt(ta.revocationBlock),
        policy: {
          savingsBps: Number(ta.policy.savingsBps),
          minContributionWei: BigInt(ta.policy.minContributionWei),
          maxPerSettlementWei: BigInt(ta.policy.maxPerSettlementWei),
          maxRolling30dWei: BigInt(ta.policy.maxRolling30dWei),
          tradingFloorWei: BigInt(ta.policy.tradingFloorWei),
          gasReserveWei: BigInt(ta.policy.gasReserveWei),
        },
        policyHash: policyHash as Hex,
        adminEpoch: BigInt(adminEpoch as bigint),
        localPauseEpoch: BigInt(localPauseEpoch as bigint),
        globalPauseEpoch: BigInt(globalPauseEpoch as bigint),
        attesterEpoch: Number(attesterEpoch as number),
        registeredAttester: registeredAttester as `0x${string}`,
        protocolPaused: protocolPaused as boolean,
        settlementPaused: settlementPaused as boolean,
        lifetimeContribution: BigInt(lifetimeContribution as bigint),
        accountBalanceWei: accountBalanceWei as bigint,
      };
    },

    deriveSessionId: async (args) =>
      read("deriveSessionId", async () =>
        (await client.readContract({
          address: options.executor,
          abi: EXECUTOR_ABI,
          functionName: "deriveSessionId",
          args: [
            args.chainId,
            args.vault,
            args.account,
            args.bindingEpoch,
            args.startBlockL1,
            args.endBlockL1,
            args.startBlockL2,
            args.endBlockL2,
            args.ledgerRoot,
          ],
        })) as Hex,
      ),

    previewContribution: async (attestation) =>
      read("previewContribution", async () =>
        (await client.readContract({
          address: options.executor,
          abi: EXECUTOR_ABI,
          functionName: "previewContribution",
          args: [attestation],
        })) as bigint,
      ),

    hashAttestation: async (attestation) =>
      read("hashAttestation", async () =>
        (await client.readContract({
          address: options.executor,
          abi: EXECUTOR_ABI,
          functionName: "hashAttestation",
          args: [attestation],
        })) as Hex,
      ),

    getSettlementLogs: async (filter) =>
      read("eth_getLogs", async () => {
        // Cast at the boundary: the ABI arrives as a runtime `Abi` from the
        // artifacts bundle, so viem cannot infer the decoded arg names from it.
        // The shape is asserted once here and typed everywhere else.
        const logs = (await client.getLogs({
          address: options.executor,
          event: SETTLEMENT_EXECUTED_EVENT as never,
          args: {
            ...(filter.sessionId ? { sessionId: filter.sessionId } : {}),
            ...(filter.account ? { account: filter.account } : {}),
          } as never,
          fromBlock: filter.fromBlockL2,
          toBlock: filter.toBlockL2 ?? "latest",
        })) as unknown as {
          args: Record<string, unknown>;
          transactionHash: Hex | null;
          blockNumber: bigint | null;
        }[];
        return logs.map((log) => {
          const args = log.args;
          return {
            sessionId: args.sessionId as Hex,
            account: args.account as `0x${string}`,
            vault: args.vault as `0x${string}`,
            settlementNonce: BigInt(args.settlementNonce as bigint),
            realizedProfit: BigInt(args.realizedProfit as bigint),
            contribution: BigInt(args.contribution as bigint),
            ledgerRoot: args.ledgerRoot as Hex,
            transactionHash: log.transactionHash as Hex,
            blockNumber: BigInt(log.blockNumber ?? 0n),
          };
        });
      }),

    getTransaction: async (hash) =>
      read("eth_getTransactionByHash", async () => {
        try {
          const tx = await client.getTransaction({ hash });
          return { hash: tx.hash, input: tx.input, blockNumber: tx.blockNumber ?? null };
        } catch {
          // viem throws TransactionNotFoundError for an unknown hash. "Absent" is
          // a legitimate answer here, and a distinct one from "errored".
          return null;
        }
      }),

    getTransactionReceipt: async (hash) =>
      read("eth_getTransactionReceipt", async () => {
        try {
          const receipt = await client.getTransactionReceipt({ hash });
          return {
            transactionHash: receipt.transactionHash,
            status: receipt.status,
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed,
          };
        } catch {
          return null;
        }
      }),

    getTransactionCount: (address) =>
      read("eth_getTransactionCount", () => client.getTransactionCount({ address, blockTag: "latest" })),

    getPendingTransactionCount: (address) =>
      read("eth_getTransactionCount", () => client.getTransactionCount({ address, blockTag: "pending" })),

    estimateSettleGas: (args) =>
      read("eth_estimateGas", () =>
        client.estimateContractGas({
          address: options.executor,
          // The merged ABI, so a revert from the vault names itself.
          abi: SETTLE_ERROR_ABI,
          functionName: "settle",
          args: [args.attestation, args.signature],
          value: args.attestation.contribution,
          account: args.account,
        }),
      ),

    getFeeQuote: async () =>
      read("eth_feeHistory", async () => {
        const fees = await client.estimateFeesPerGas();
        return {
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        };
      }),

    sendRawTransaction: (raw) =>
      read("eth_sendRawTransaction", () => client.sendRawTransaction({ serializedTransaction: raw })),

    waitForReceipt: async (hash, timeoutMs) =>
      read("waitForReceipt", async () => {
        try {
          const receipt = await client.waitForTransactionReceipt({ hash, timeout: timeoutMs });
          return {
            transactionHash: receipt.transactionHash,
            status: receipt.status,
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed,
          };
        } catch {
          return null;
        }
      }),
  };
}
