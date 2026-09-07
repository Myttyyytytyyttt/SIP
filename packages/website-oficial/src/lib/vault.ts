/**
 * Every onchain read the wallets wave performs, and nothing else. Ported from
 * the Nuvem dashboard's src/lib/vault.ts (HEAD fd927b0), cut down to the reads
 * in WEB_WALLETS.md §3.
 *
 * SERVER-ONLY. It creates the viem client from ServerConfig.rpcUrl, which for
 * this deployment carries an Alchemy API key, so it must never be imported for
 * its runtime values by a `'use client'` module — only `import type`. Its callers
 * are the route handlers under src/app/api.
 *
 * Three rules this module exists to enforce:
 *
 * 1. NO MULTICALL. viem's `multicall` needs a Multicall3 deployment, and there
 *    is no verified one on chain 4663. Reads are therefore individual eth_call
 *    fired in parallel with Promise.all.
 *
 * 2. EVERY READ CAN FAIL INDEPENDENTLY, and a failure is never silently turned
 *    into a zero or a false. It becomes `{ ok: false, error }`, which the page
 *    renders as "unknown" rather than as "no vault" or "not linked". A green
 *    tick for something that was not verified is the one bug this whole package
 *    is designed to prevent.
 *
 * 3. THE FACTORY IS THE SOURCE OF TRUTH FOR PROTOCOL WIRING.
 *    PersonalVault.initialize only accepts component addresses that
 *    `factory.isProtocolConfiguration(...)` approves, so the executor, WETH,
 *    pause controller and attester registry are all read from
 *    `VaultFactory.protocolConfiguration()`. Environment variables are used
 *    only as an optional cross-check.
 */

import {
  createPublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  http,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

import {
  ACCOUNT_STATUS,
  personalVaultAbi,
  tradingAccountActivatedEvent,
  tradingAccountInvitedEvent,
  tradingAccountRevokedEvent,
  vaultFactoryAbi,
  type AccountStatusName,
} from "./abi";
import { ROBINHOOD_CHAIN_ID, robinhoodChain } from "./chain";
import { configuredRpcUrl, type ServerConfig } from "./config";
import { errorSummary } from "./redact";

/** Only the fields the read functions need, so they can also take a PublicConfig. */
type ReadConfig = Pick<ServerConfig, "factory" | "logsFromBlock">;

/**
 * The one client every read goes through, pinned to chain 4663 and to OUR RPC —
 * never a wallet's EIP-1193 provider. Privy merely *prompts* an external wallet
 * to switch chains; the user can decline or switch away afterwards, and reading
 * getTradingAccount off whatever chain MetaMask happens to be on would render
 * confident nonsense.
 */
export function createReadClient(config: ServerConfig): PublicClient {
  return createPublicClient({
    chain: robinhoodChain(config.walletRpcUrl, config.explorerUrl),
    // `batch` is deliberately left off: JSON-RPC request batching is an endpoint
    // capability that has not been verified for this RPC.
    transport: http(config.rpcUrl),
  }) as PublicClient;
}

// ---------------------------------------------------------------------------
// Result plumbing
// ---------------------------------------------------------------------------

export type Read<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

export function isOk<T>(read: Read<T>): read is { ok: true; value: T } {
  return read.ok;
}

async function attempt<T>(work: () => Promise<T>): Promise<Read<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    // Redacted against the live env rather than a threaded ServerConfig, so no
    // read site can forget to scrub and reintroduce the leak.
    return { ok: false, error: errorSummary(error, configuredRpcUrl(), 1) };
  }
}

/** Accepts viem's number-or-bigint integer mapping without caring which it is. */
const big = (value: bigint | number): bigint => (typeof value === "bigint" ? value : BigInt(value));
const num = (value: bigint | number): number => (typeof value === "number" ? value : Number(value));

/**
 * viem does NOT verify that the endpoint serves the chain declared in the
 * client: only wallet WRITE actions assert the chain id, never readContract.
 * So an RPC pointed at any other chain answers every call happily, and it
 * answers plausibly — the factory address holds no code there, so
 * `vaultOfAdmin` returns the zero address and the pension key reads as simply
 * having no vault yet. Nothing errors, and the page offers to CREATE one.
 *
 * So every route runs this once before its reads. Failing to determine the
 * chain id is treated the same as a mismatch: unverified is not permission to
 * proceed.
 */
export async function verifyChain(client: PublicClient): Promise<Read<typeof ROBINHOOD_CHAIN_ID>> {
  const observed = await attempt(() => client.getChainId());
  if (!observed.ok) {
    return {
      ok: false,
      error: `Could not confirm the RPC serves chain ${ROBINHOOD_CHAIN_ID} (${observed.error}). No reading was attempted.`,
    };
  }
  if (observed.value !== ROBINHOOD_CHAIN_ID) {
    return {
      ok: false,
      error:
        `The configured RPC reports chain ${observed.value}, not ${ROBINHOOD_CHAIN_ID}. ` +
        "Every reading here would have described the wrong chain, so none was attempted. Check NUVEM_RPC_URL.",
    };
  }
  return { ok: true, value: ROBINHOOD_CHAIN_ID };
}

// ---------------------------------------------------------------------------
// Struct-shaped reads, guarded on the WIDTH of the returndata
// ---------------------------------------------------------------------------

/**
 * ABI DECODING IGNORES TRAILING RETURNDATA, AND THAT IS A LIE WAITING TO HAPPEN.
 *
 * This is not hypothetical; it was measured against a live canary factory while
 * the dashboard was being written. That factory predated the removal of the
 * investment path, so its ProtocolConfiguration had SIX address fields and it
 * answered protocolConfiguration() with six 32-byte words. This build's ABI
 * declares FOUR. viem decoded the first four and discarded the rest without a
 * word of complaint, so word 3 (an AdapterRegistry) was read back as
 * `settlementExecutor` and the REAL executor in word 5 was dropped. The read
 * then reported `ok`, and every vault built from it would have been wired to a
 * contract that does not settle.
 *
 * So the one struct-shaped read this module keeps goes through here, which
 * decodes nothing until the returndata is exactly as wide as expected. The
 * struct is flat and static, so "expected width" is simply the number of
 * fields — no ABI-offset arithmetic is involved.
 */
/**
 * Exported so scripts/check-abis.mts can pin it against the compiled ABI. Get it
 * wrong in the harmless-looking direction and the guard starts rejecting the
 * CORRECT deployment; get it wrong in the other and it waves through the shape
 * it exists to catch. Neither shows up in a typecheck, because it is a number.
 */
export const PROTOCOL_CONFIGURATION_WORDS = 4;

async function readStaticStruct<T>(
  client: PublicClient,
  address: Address,
  abi: Abi | readonly unknown[],
  functionName: string,
  expectedWords: number,
  mismatchHint: string,
): Promise<T> {
  const calldata = encodeFunctionData({ abi: abi as Abi, functionName, args: [] });
  const { data } = await client.call({ to: address, data: calldata });
  const raw = data ?? "0x";
  if (raw === "0x") {
    throw new Error(
      `${functionName}() at ${address} returned no data. There is no such function at that address — ` +
        "the address is wrong, or it holds no code on this chain.",
    );
  }
  const words = (raw.length - 2) / 64;
  if (!Number.isInteger(words) || words !== expectedWords) {
    throw new Error(
      `${functionName}() at ${address} returned ${Number.isInteger(words) ? words : "a non-whole number of"} ` +
        `32-byte words, but this build's ABI declares ${expectedWords}. Nothing was decoded, deliberately: ` +
        `ABI decoding silently ignores trailing words, so the values would have been read out of the wrong slots ` +
        `and reported as if they were fine. ${mismatchHint}`,
    );
  }
  return decodeFunctionResult({ abi: abi as Abi, functionName, data: raw }) as T;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * VaultFactory.ProtocolConfiguration. Four fields, and `configureProtocol` is
 * one-shot, so this is permanent for the life of a factory.
 */
export interface ProtocolConfiguration {
  readonly weth: Address;
  readonly pauseController: Address;
  readonly attesterRegistry: Address;
  readonly settlementExecutor: Address;
}

export interface ProtocolSnapshot {
  readonly configuration: Read<ProtocolConfiguration>;
}

export interface CohortState {
  readonly registered: boolean;
  readonly beacon: Address;
}

/** NuvemTypes.TradingAccountPolicy, as getTradingAccount returns it. */
export interface TradingAccountPolicy {
  readonly savingsBps: number;
  readonly minContributionWei: bigint;
  readonly maxPerSettlementWei: bigint;
  readonly maxRolling30dWei: bigint;
  readonly tradingFloorWei: bigint;
  readonly gasReserveWei: bigint;
}

/** NuvemTypes.TradingAccount, with the status decoded to its name. */
export interface TradingAccountView {
  readonly status: AccountStatusName;
  readonly platformId: Hex;
  readonly bindingEpoch: bigint;
  readonly policyNonce: bigint;
  readonly inviteNonce: bigint;
  readonly inviteAdminEpoch: bigint;
  readonly settlementNonce: bigint;
  /** L1 block number. See BLOCK_NUMBER_NOTE in chain.ts. */
  readonly activationBlock: bigint;
  /** L1 block number. See BLOCK_NUMBER_NOTE in chain.ts. */
  readonly revocationBlock: bigint;
  /** UNIX seconds, NOT a block number. */
  readonly inviteDeadline: number;
  /** `policy.savingsBps`, lifted because every row on the page shows it. */
  readonly savingsBps: number;
  readonly policy: TradingAccountPolicy;
}

// ---------------------------------------------------------------------------
// Protocol-level reads
// ---------------------------------------------------------------------------

export async function readProtocol(client: PublicClient, config: ReadConfig): Promise<ProtocolSnapshot> {
  const factory = getAddress(config.factory);

  const chain = await verifyChain(client);
  if (!chain.ok) return { configuration: { ok: false, error: chain.error } };

  const configuration = await attempt(async () => {
    const raw = await readStaticStruct<readonly [Address, Address, Address, Address]>(
      client,
      factory,
      vaultFactoryAbi,
      "protocolConfiguration",
      PROTOCOL_CONFIGURATION_WORDS,
      "That is a VaultFactory from a different deployment of this protocol. Point NUVEM_VAULT_FACTORY at the " +
        "factory this build was compiled against.",
    );
    const [weth, pauseController, attesterRegistry, settlementExecutor] = raw;
    return {
      weth: getAddress(weth),
      pauseController: getAddress(pauseController),
      attesterRegistry: getAddress(attesterRegistry),
      settlementExecutor: getAddress(settlementExecutor),
    } satisfies ProtocolConfiguration;
  });

  return { configuration };
}

export async function readCohort(
  client: PublicClient,
  config: ReadConfig,
  id: bigint | number,
): Promise<Read<CohortState>> {
  return attempt(async () => {
    const [beacon] = await client.readContract({
      address: getAddress(config.factory),
      abi: vaultFactoryAbi,
      functionName: "cohorts",
      args: [num(id)],
    });
    return { registered: beacon !== zeroAddress, beacon: getAddress(beacon) };
  });
}

export async function predictVault(
  client: PublicClient,
  config: ReadConfig,
  owner: Address,
  userSalt: Hex,
  cohortId: bigint | number,
  initData: Hex,
): Promise<Read<{ vaultId: Hex; predicted: Address }>> {
  return attempt(async () => {
    const [vaultId, predicted] = await client.readContract({
      address: getAddress(config.factory),
      abi: vaultFactoryAbi,
      functionName: "predictVault",
      args: [owner, userSalt, num(cohortId), initData],
    });
    return { vaultId, predicted: getAddress(predicted) };
  });
}

/** VaultFactory.vaultOfAdmin(admin). The zero address is reported as null: no vault yet. */
export async function vaultOfAdmin(client: PublicClient, config: ReadConfig, admin: Address): Promise<Read<Address | null>> {
  return attempt(async () => {
    const vault = await client.readContract({
      address: getAddress(config.factory),
      abi: vaultFactoryAbi,
      functionName: "vaultOfAdmin",
      args: [admin],
    });
    return vault === zeroAddress ? null : getAddress(vault);
  });
}

/**
 * VaultFactory.activeVaultOf(account). Non-null means the address is already
 * someone's TRADING wallet: createVault with it as admin would revert
 * TradingAccountAlreadyLinked, and inviting it elsewhere would too.
 */
export async function activeVaultOf(client: PublicClient, config: ReadConfig, account: Address): Promise<Read<Address | null>> {
  return attempt(async () => {
    const vault = await client.readContract({
      address: getAddress(config.factory),
      abi: vaultFactoryAbi,
      functionName: "activeVaultOf",
      args: [account],
    });
    return vault === zeroAddress ? null : getAddress(vault);
  });
}

// ---------------------------------------------------------------------------
// Trading-account reads
// ---------------------------------------------------------------------------

export async function readTradingAccount(client: PublicClient, vault: Address, account: Address): Promise<Read<TradingAccountView>> {
  return attempt(async () => {
    const raw = await client.readContract({
      address: vault,
      abi: personalVaultAbi,
      functionName: "getTradingAccount",
      args: [account],
    });
    const statusCode = num(raw.status);
    const status = ACCOUNT_STATUS[statusCode];
    // A code this build does not know is a contract this build was not
    // compiled against. Saying so beats labelling it with the nearest name.
    if (status === undefined) {
      throw new Error(`getTradingAccount(${account}) returned status ${statusCode}, which this build does not recognise.`);
    }
    return {
      status,
      platformId: raw.platformId,
      bindingEpoch: big(raw.bindingEpoch),
      policyNonce: big(raw.policyNonce),
      inviteNonce: big(raw.inviteNonce),
      inviteAdminEpoch: big(raw.inviteAdminEpoch),
      settlementNonce: big(raw.settlementNonce),
      activationBlock: big(raw.activationBlock),
      revocationBlock: big(raw.revocationBlock),
      inviteDeadline: num(raw.inviteDeadline),
      savingsBps: num(raw.policy.savingsBps),
      policy: {
        savingsBps: num(raw.policy.savingsBps),
        minContributionWei: big(raw.policy.minContributionWei),
        maxPerSettlementWei: big(raw.policy.maxPerSettlementWei),
        maxRolling30dWei: big(raw.policy.maxRolling30dWei),
        tradingFloorWei: big(raw.policy.tradingFloorWei),
        gasReserveWei: big(raw.policy.gasReserveWei),
      },
    } satisfies TradingAccountView;
  });
}

// ---------------------------------------------------------------------------
// Discovery: there is NO view function that enumerates trading accounts
// ---------------------------------------------------------------------------

/**
 * PersonalVault exposes `activeTradingAccountCount()` but no index getter and no
 * enumeration, so accounts are recovered from the vault's own logs since
 * NUVEM_LOGS_FROM_BLOCK — TradingAccountInvited, TradingAccountActivated and
 * TradingAccountRevoked, in one eth_getLogs with an OR of the three topics —
 * and deduplicated by address. The CURRENT status of each is then read with
 * getTradingAccount; nothing about status is inferred from which log was seen.
 *
 * Public RPCs frequently cap `eth_getLogs` ranges. A failure here is reported,
 * not swallowed, and the caller renders it as "unknown": a wallet missing from
 * this list looks exactly like a wallet that does not exist.
 */
export async function listTradingAccounts(client: PublicClient, config: ReadConfig, vault: Address): Promise<Read<readonly Address[]>> {
  return attempt(async () => {
    const logs = await client.getLogs({
      address: vault,
      events: [tradingAccountInvitedEvent, tradingAccountActivatedEvent, tradingAccountRevokedEvent],
      fromBlock: config.logsFromBlock,
      toBlock: "latest",
    });
    const seen = new Map<string, Address>();
    for (const log of logs) {
      const candidate = log.args.account;
      if (candidate !== undefined) seen.set(candidate.toLowerCase(), getAddress(candidate));
    }
    return [...seen.values()];
  });
}
