// Everything settle() will compare, read in one pass at one block.
//
// Port of `readVaultSnapshot` in the keeper of the project this was forked from (src/onchain.ts)
// (createViemChainAccess), rewritten over the bare RpcClient so tests run against
// a recorded or hand-built answer set and never a live L2.
//
// READ TOGETHER ON PURPOSE. The attestation commits every one of these values,
// so anything that changes between reading them and mining invalidates the
// signature. That is the intended behaviour, not a race to be papered over —
// but reading them at different times would mean signing a set of values that
// was never simultaneously true. The old keeper issued the reads at "latest"
// and hoped no block landed in between; this one reads eth_blockNumber once and
// pins every eth_call and the balance read to that height.
//
// ABIs come from @nuvem/contracts-artifacts, never from packages/contracts/out:
// the Foundry output directory exists on a developer's machine and not in a
// container, and the bundle is generated from the compiled contract, so a
// function this file names that the contract lacks fails at encode time.
//
// THE FRONTIER HAS NO GETTER. PersonalVault keeps the per-(account, bindingEpoch)
// settlement frontier in private ERC-7201 storage and exposes `extsload(slot)`
// for exactly this purpose (VaultLens reads the vault the same way). The slot
// map below is the one VaultLens pins as MEASURED, not derived — `SLOT_FRONTIER
// = BASE + 11` — and the storage location is recomputed from its formula here
// and checked against the contract's constant in the tests.

import { abis } from "@nuvem/contracts-artifacts";
import {
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  hexToBigInt,
  isHex,
  keccak256,
  numberToHex,
  stringToHex,
  type Abi,
} from "viem";
import type { Address, Hex, RpcClient, VaultSnapshot } from "../types.js";

export const EXECUTOR_ABI: Abi = abis.SettlementExecutor;
export const VAULT_ABI: Abi = abis.PersonalVault;
export const FACTORY_ABI: Abi = abis.VaultFactory;
export const PAUSE_ABI: Abi = abis.ProtocolPauseController;
export const REGISTRY_ABI: Abi = abis.AttesterRegistry;

/** NuvemTypes.AccountStatus: 0 NONE, 1 PENDING, 2 ACTIVE, 3 PAUSED, 4 REVOKED. */
export const ACCOUNT_STATUS_ACTIVE = 2;

export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

/** A chain answer that cannot be turned into the value settle() will compare. */
export class AttestError extends Error {
  override readonly name = "AttestError";
}

// ── ERC-7201 slot math for PersonalVault ────────────────────────────────────

/** keccak256(abi.encode(uint256(keccak256("nuvem.storage.PersonalVault")) - 1)) & ~bytes32(uint256(0xff)) */
export const VAULT_STORAGE_LOCATION: bigint =
  hexToBigInt(
    keccak256(
      encodeAbiParameters([{ type: "uint256" }], [hexToBigInt(keccak256(stringToHex("nuvem.storage.PersonalVault"))) - 1n]),
    ),
  ) & ~0xffn;

/** VaultStorage member offsets that matter here. Measured by VaultLens.sol, not derived from the struct. */
export const SLOT_FRONTIER: bigint = VAULT_STORAGE_LOCATION + 11n;

const MASK_64 = (1n << 64n) - 1n;

/**
 * The slot of `$.frontier[account][bindingEpoch]`: a mapping inside a mapping,
 * so keccak256(h(bindingEpoch) . keccak256(h(account) . SLOT_FRONTIER)).
 */
export function frontierSlot(account: Address, bindingEpoch: bigint): Hex {
  const inner = keccak256(
    encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [account.toLowerCase() as Address, SLOT_FRONTIER]),
  );
  return keccak256(encodeAbiParameters([{ type: "uint64" }, { type: "bytes32" }], [bindingEpoch, inner]));
}

/** `SettlementFrontier { uint64 endBlockL1; uint64 endBlockL2 }` packs low-to-high into one word. */
export function decodeFrontier(word: Hex): { readonly endBlockL1: bigint; readonly endBlockL2: bigint } {
  const value = hexToBigInt(word);
  return { endBlockL1: value & MASK_64, endBlockL2: (value >> 64n) & MASK_64 };
}

// ── eth_call over the bare client ───────────────────────────────────────────

/**
 * One contract read: encode with the artifact ABI, `eth_call` at `blockTag`,
 * decode. Returns `unknown` on purpose — the artifact ABI is a runtime `Abi`, so
 * viem cannot type the result; the shape is asserted at this boundary by the
 * `as*` helpers below and typed everywhere else.
 */
export async function readContract(
  rpc: RpcClient,
  to: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[],
  blockTag: string,
): Promise<unknown> {
  const data = encodeFunctionData({ abi, functionName, args });
  const raw = await rpc.call<unknown>("eth_call", [{ to, data }, blockTag]);
  if (typeof raw !== "string" || !isHex(raw)) {
    throw new AttestError(`${functionName} at ${to}: eth_call answered with a non-hex value`);
  }
  // Empty return data is what a call to an address without code produces. It is
  // not a zero; decoding it would either throw an unhelpful error or, for a
  // `bool`, read as false. Name the condition instead.
  if (raw === "0x") {
    throw new AttestError(`${functionName} at ${to}: eth_call returned no data (no contract at that address?)`);
  }
  return decodeFunctionResult({ abi, functionName, data: raw });
}

export function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AttestError(`${what}: expected a struct, got ${typeof value}`);
  }
  return value as Record<string, unknown>;
}

export function asBigInt(value: unknown, what: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  if (typeof value === "string" && isHex(value)) return hexToBigInt(value);
  throw new AttestError(`${what}: expected an integer, got ${String(value)}`);
}

export function asNumber(value: unknown, what: string): number {
  const big = asBigInt(value, what);
  if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new AttestError(`${what}: ${big} does not fit a JS number`);
  return Number(big);
}

export function asBool(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") throw new AttestError(`${what}: expected a bool, got ${String(value)}`);
  return value;
}

export function asAddress(value: unknown, what: string): Address {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new AttestError(`${what}: expected an address, got ${String(value)}`);
  }
  return value.toLowerCase() as Address;
}

export function asHex32(value: unknown, what: string): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new AttestError(`${what}: expected bytes32, got ${String(value)}`);
  }
  return value.toLowerCase() as Hex;
}

// ── the snapshot ────────────────────────────────────────────────────────────

/** What an account that no vault claims looks like: status NONE, nothing to settle into. */
function unboundSnapshot(account: Address): VaultSnapshot {
  return {
    vault: ZERO_ADDRESS,
    account,
    status: 0,
    bindingEpoch: 0n,
    policyNonce: 0n,
    settlementNonce: 0n,
    policyHash: `0x${"0".repeat(64)}`,
    adminEpoch: 0n,
    localPauseEpoch: 0n,
    globalPauseEpoch: 0n,
    attesterEpoch: 0n,
    activationBlockL1: 0n,
    savingsBps: 0,
    minContributionWei: 0n,
    maxPerSettlementWei: 0n,
    tradingFloorWei: 0n,
    gasReserveWei: 0n,
    accountRollingRemainingWei: 0n,
    aggregateRollingRemainingWei: 0n,
    settlementPaused: false,
    protocolPaused: false,
    executor: ZERO_ADDRESS,
    frontierEndL2: 0n,
    nativeBalanceWei: 0n,
  };
}

/**
 * Reads everything settle() will compare, in one pass, pinned to one block.
 *
 * The vault comes from `factory.activeVaultOf(account)` — the same resolution
 * settle() performs on msg.sender — and the pause controller and attester
 * registry from the executor's own immutables, because those are the contracts
 * settle() consults, whatever the factory's protocol configuration says today.
 * An account no vault claims returns a snapshot with status NONE rather than an
 * error: "not bound" is a true state of the world, and the preflight names it.
 */
export async function readVaultSnapshot(
  rpc: RpcClient,
  factory: Address,
  executor: Address,
  account: Address,
): Promise<VaultSnapshot> {
  const acct = account.toLowerCase() as Address;
  const head = asBigInt(await rpc.call<unknown>("eth_blockNumber", []), "eth_blockNumber");
  const tag = numberToHex(head);
  const at = (to: Address, abi: Abi, fn: string, args: readonly unknown[]): Promise<unknown> =>
    readContract(rpc, to, abi, fn, args, tag);

  const [vaultRaw, pauseRaw, registryRaw] = await Promise.all([
    at(factory, FACTORY_ABI, "activeVaultOf", [acct]),
    at(executor, EXECUTOR_ABI, "pauseController", []),
    at(executor, EXECUTOR_ABI, "attesterRegistry", []),
  ]);
  const vault = asAddress(vaultRaw, "activeVaultOf");
  const pauseController = asAddress(pauseRaw, "SettlementExecutor.pauseController");
  const registry = asAddress(registryRaw, "SettlementExecutor.attesterRegistry");
  if (vault === ZERO_ADDRESS) return unboundSnapshot(acct);

  const [
    tradingAccountRaw,
    policyHashRaw,
    adminEpochRaw,
    localPauseEpochRaw,
    settlementPausedRaw,
    vaultExecutorRaw,
    accountCapRaw,
    aggregateCapRaw,
    pauseEpochRaw,
    protocolPausedRaw,
    attesterEpochRaw,
    balanceRaw,
  ] = await Promise.all([
    at(vault, VAULT_ABI, "getTradingAccount", [acct]),
    at(vault, VAULT_ABI, "policyHash", [acct]),
    at(vault, VAULT_ABI, "adminEpoch", []),
    at(vault, VAULT_ABI, "localPauseEpoch", []),
    at(vault, VAULT_ABI, "settlementPaused", []),
    at(vault, VAULT_ABI, "settlementExecutor", []),
    at(vault, VAULT_ABI, "accountRollingCapStatus", [acct]),
    at(vault, VAULT_ABI, "aggregateRollingCapStatus", []),
    at(pauseController, PAUSE_ABI, "pauseEpoch", []),
    at(pauseController, PAUSE_ABI, "paused", []),
    at(registry, REGISTRY_ABI, "attesterEpoch", []),
    rpc.call<unknown>("eth_getBalance", [acct, tag]),
  ]);

  const tradingAccount = asRecord(tradingAccountRaw, "getTradingAccount");
  const policy = asRecord(tradingAccount["policy"], "getTradingAccount.policy");
  const bindingEpoch = asBigInt(tradingAccount["bindingEpoch"], "getTradingAccount.bindingEpoch");

  // The frontier slot depends on bindingEpoch, so it is the one read that must
  // wait for the account; still at the same block.
  const frontier = decodeFrontier(
    asHex32(await at(vault, VAULT_ABI, "extsload", [frontierSlot(acct, bindingEpoch)]), "extsload(frontier)"),
  );

  return {
    vault,
    account: acct,
    status: asNumber(tradingAccount["status"], "getTradingAccount.status"),
    bindingEpoch,
    policyNonce: asBigInt(tradingAccount["policyNonce"], "getTradingAccount.policyNonce"),
    settlementNonce: asBigInt(tradingAccount["settlementNonce"], "getTradingAccount.settlementNonce"),
    policyHash: asHex32(policyHashRaw, "policyHash"),
    adminEpoch: asBigInt(adminEpochRaw, "adminEpoch"),
    localPauseEpoch: asBigInt(localPauseEpochRaw, "localPauseEpoch"),
    globalPauseEpoch: asBigInt(pauseEpochRaw, "ProtocolPauseController.pauseEpoch"),
    attesterEpoch: asBigInt(attesterEpochRaw, "AttesterRegistry.attesterEpoch"),
    activationBlockL1: asBigInt(tradingAccount["activationBlock"], "getTradingAccount.activationBlock"),
    savingsBps: asNumber(policy["savingsBps"], "policy.savingsBps"),
    minContributionWei: asBigInt(policy["minContributionWei"], "policy.minContributionWei"),
    maxPerSettlementWei: asBigInt(policy["maxPerSettlementWei"], "policy.maxPerSettlementWei"),
    tradingFloorWei: asBigInt(policy["tradingFloorWei"], "policy.tradingFloorWei"),
    gasReserveWei: asBigInt(policy["gasReserveWei"], "policy.gasReserveWei"),
    accountRollingRemainingWei: asBigInt(asRecord(accountCapRaw, "accountRollingCapStatus")["remaining"], "accountRollingCapStatus.remaining"),
    aggregateRollingRemainingWei: asBigInt(asRecord(aggregateCapRaw, "aggregateRollingCapStatus")["remaining"], "aggregateRollingCapStatus.remaining"),
    settlementPaused: asBool(settlementPausedRaw, "settlementPaused"),
    protocolPaused: asBool(protocolPausedRaw, "ProtocolPauseController.paused"),
    executor: asAddress(vaultExecutorRaw, "settlementExecutor"),
    frontierEndL2: frontier.endBlockL2,
    nativeBalanceWei: asBigInt(balanceRaw, "eth_getBalance"),
  };
}
