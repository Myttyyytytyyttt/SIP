// Builds and signs the deployed SettlementExecutor's attestation for one closed
// volume window. Phase 0: no contract change (DESIGN.md §5).
//
// Port of the keeper of the project this was forked from (src/attest.ts (preflight order, validity window,)
// the digest cross-check, the balance hazard) and of the EIP-712 material in
// the keeper of the project this was forked from (src/onchain.ts (ATTESTATION_TYPES, the domain, the)
// import-time drift check, encodeSettleCalldata, deriveSessionId). What the old
// keeper got right is preserved here, in the same order and for the same
// reasons:
//
//   * A REFUSED WINDOW STOPS HERE, with no override flag, deliberately. Every
//     preflight failure returns BEFORE the signer is touched, so a window that
//     cannot settle cannot produce a signature even by accident. The tests prove
//     it with a signer that throws.
//   * BOTH RANGES ARE ATTESTED, and they do different jobs. The L1 pair
//     (startBlock/endBlock) is what SettlementExecutor compares against
//     block.number — freshness and the activation floor — because on Arbitrum
//     Nitro Solidity's block.number IS the L1 number. The L2 pair
//     (startBlockL2/endBlockL2) is what the vault progresses on, because ~120 L2
//     blocks fit inside one L1 block. Both are folded into deriveSessionId, so
//     the replay key stays unique when two windows share one L1 range.
//   * BIND TO CURRENT ONCHAIN STATE. Every epoch, nonce and policy hash comes
//     from the snapshot and is committed. Anything that changes afterwards
//     invalidates the signature, which is the intended behaviour.
//   * ASK THE EXECUTOR WHAT IT WILL ACCEPT. previewContribution runs the same
//     five clamps settle() will; reimplementing them here would be a second
//     source of truth about the amount of money that moves. The local arithmetic
//     below is a BOUND on that answer, never a replacement for it.
//   * CROSS-CHECK THE DIGEST. The local EIP-712 hash is compared against
//     hashAttestation() before signing, so a drift between ATTESTATION_TYPES and
//     the contract surfaces as DIGEST_MISMATCH rather than as
//     InvalidAttesterSignature after paying for the attempt.
//
// What is different from the old keeper, and why:
//
//   * The "profit" is volume. cashStart = externalDeposits = externalWithdrawals
//     = 0 and cashEnd = realizedProfit = Σ gross notional, so the executor's
//     `calculateRealizedProfit` returns the volume and `_calculateContribution`
//     yields savingsBps × volume, clamped (assessment §4.4). Every consumer of
//     SettlementExecuted will show volume as realizedProfit until Phase 1.
//   * The window is verified against its own fills before anything is derived
//     from it: the root, the sum and the block range must agree, or the window
//     is refused with an exception. A signature over a window that does not
//     describe its fills is fabricated volume, whatever the ledger says.
//   * The chain id is the CALLER's. tick.ts commits the batch root with
//     config.chainId, so an attestation built from the constant would sign for
//     4663 no matter what the worker was configured for. It is threaded in
//     through the options bag and used for the root check, the EIP-712 domain
//     and the attestation alike; the constant is only the default while the
//     caller catches up.

import { encodeAbiParameters, encodeFunctionData, hashTypedData, keccak256, type Abi } from "viem";
import { CHAIN_ID } from "../chain/constants.js";
import { l1BlockOf } from "../chain/reads.js";
import type { Address, AttestOutcome, DeferReason, Hex, RpcClient, SettlementAttestation, VaultSnapshot, VolumeWindow } from "../types.js";
import { batchRoot } from "./root.js";
import {
  ACCOUNT_STATUS_ACTIVE,
  EXECUTOR_ABI,
  REGISTRY_ABI,
  ZERO_ADDRESS,
  asAddress,
  asBigInt,
  asHex32,
  readContract,
} from "./snapshot.js";

export interface AttesterSigner {
  readonly address: `0x${string}`;
  signTypedData(args: { domain: unknown; types: unknown; primaryType: "SettlementAttestation"; message: unknown }): Promise<Hex>;
}

/** Exactly what attestPhase0 hands the signer. */
export interface AttestationSignRequest {
  readonly domain: AttestationDomain;
  readonly types: typeof ATTESTATION_TYPES;
  readonly primaryType: "SettlementAttestation";
  readonly message: TypedAttestationMessage;
}

/**
 * The signing capability, narrowed to exactly what is needed. A viem
 * LocalAccount (privateKeyToAccount) satisfies this structurally; the wider
 * `AttesterSigner` above is what the module contract exposes, and its `unknown`
 * parameters are what keep a throwing test double trivial to write.
 */
export interface TypedDataSigner {
  readonly address: `0x${string}`;
  signTypedData(parameters: AttestationSignRequest): Promise<Hex>;
}

/** Wraps a viem account (or anything shaped like one) as the AttesterSigner the loop passes around. */
export function attesterFromAccount(account: TypedDataSigner): AttesterSigner {
  return {
    address: account.address,
    // attestPhase0 is the only caller and builds the request from the concrete
    // types above; the interface's `unknown` is a widening, not a doubt.
    signTypedData: (args) => account.signTypedData(args as AttestationSignRequest),
  };
}

// ── EIP-712 material, from keeper-old/src/onchain.ts ────────────────────────

/**
 * The EIP-712 type, transcribed from SettlementExecutor's own hashAttestation.
 * Field order is part of the digest, so this list is not cosmetic — a reordered
 * entry produces a signature the contract rejects with InvalidAttesterSignature.
 * attestPhase0 cross-checks the locally computed digest against hashAttestation()
 * before signing, which is what catches a drift here on a live chain; the block
 * below catches it at import.
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
 * The digest cross-check catches this — but only on a live chain, and only once
 * a real window is ready to settle. That is the worst possible moment to
 * discover it: the worker is unattended and the failure arrives as a deferral
 * on volume the trader made. The ABI is right here and is generated from the
 * compiled contract, so check at import instead.
 *
 * Names and order are both load-bearing: EIP-712 hashes the type string, so a
 * renamed or reordered field changes the digest.
 */
{
  const settle = (EXECUTOR_ABI as Abi).find(
    (item): item is Extract<Abi[number], { type: "function" }> => item.type === "function" && item.name === "settle",
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
        "Every signature this worker produces would be rejected as InvalidAttesterSignature.\n" +
        `  contracts: ${fromAbi}\n` +
        `  phase0.ts: ${fromTypes}`,
    );
  }
}

/** SettlementExecutor is constructed with EIP712("Nuvem Settlement Executor", "1"). */
export const DOMAIN_NAME = "Nuvem Settlement Executor";
export const DOMAIN_VERSION = "1";

export interface AttestationDomain {
  readonly name: typeof DOMAIN_NAME;
  readonly version: typeof DOMAIN_VERSION;
  readonly chainId: number;
  readonly verifyingContract: Address;
}

export function attestationDomain(chainId: number, executor: Address): AttestationDomain {
  return { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId, verifyingContract: executor };
}

/**
 * The attestation as viem's typed-data machinery wants it. The shared type
 * carries every field as bigint; the three narrow ones (uint32, uint48) are
 * numbers in abitype's mapping. The encoding is identical either way — this is
 * a type-level conversion so no cast is needed.
 */
export interface TypedAttestationMessage {
  readonly account: Address;
  readonly vault: Address;
  readonly executor: Address;
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
  readonly startBlock: bigint;
  readonly endBlock: bigint;
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

const UINT32_MAX = (1n << 32n) - 1n;
const UINT48_MAX = (1n << 48n) - 1n;

export function toTypedMessage(a: SettlementAttestation): TypedAttestationMessage {
  const narrow = (value: bigint, max: bigint, what: string): number => {
    if (value < 0n || value > max) throw new Error(`attestation.${what} ${value} does not fit its EIP-712 width`);
    return Number(value);
  };
  return {
    ...a,
    attesterEpoch: narrow(a.attesterEpoch, UINT32_MAX, "attesterEpoch"),
    validAfter: narrow(a.validAfter, UINT48_MAX, "validAfter"),
    deadline: narrow(a.deadline, UINT48_MAX, "deadline"),
  };
}

/** The digest SettlementExecutor.hashAttestation() produces, computed locally. */
export function hashAttestationLocal(chainId: number, executor: Address, attestation: SettlementAttestation): Hex {
  return hashTypedData({
    domain: attestationDomain(chainId, executor),
    types: ATTESTATION_TYPES,
    primaryType: "SettlementAttestation",
    message: toTypedMessage(attestation),
  });
}

export interface SessionIdInputs {
  readonly chainId: bigint;
  readonly vault: Address;
  readonly account: Address;
  readonly bindingEpoch: bigint;
  readonly startBlockL1: bigint;
  readonly endBlockL1: bigint;
  readonly startBlockL2: bigint;
  readonly endBlockL2: bigint;
  readonly ledgerRoot: Hex;
}

/**
 * SettlementExecutor.deriveSessionId, which is `pure`:
 * keccak256(abi.encode(chainId, vault, account, bindingEpoch, startBlock, endBlock, startBlockL2, endBlockL2, ledgerRoot)).
 *
 * The replay key commits to the L2 window as well as the L1 one. Without the L2
 * pair, two distinct windows collapsed onto a single L1 range derive the same
 * sessionId whenever their ledgerRoots collide, and the vault's usedSessions
 * guard refuses the second.
 */
export function deriveSessionIdLocal(inputs: SessionIdInputs): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "uint64" },
        { type: "uint64" },
        { type: "uint64" },
        { type: "uint64" },
        { type: "uint64" },
        { type: "bytes32" },
      ],
      [
        inputs.chainId,
        inputs.vault,
        inputs.account,
        inputs.bindingEpoch,
        inputs.startBlockL1,
        inputs.endBlockL1,
        inputs.startBlockL2,
        inputs.endBlockL2,
        inputs.ledgerRoot,
      ],
    ),
  );
}

/** Encodes the settle calldata. Shared by the dry-run plan and the live send. */
export function encodeSettleCalldata(attestation: SettlementAttestation, signature: Hex): Hex {
  return encodeFunctionData({ abi: EXECUTOR_ABI, functionName: "settle", args: [attestation, signature] });
}

// ── the validity window, from keeper-old/src/attest.ts ──────────────────────

/** validAfter is backdated by a minute so a slightly-behind node still accepts it. */
export const VALID_AFTER_SKEW_SECONDS = 60n;
/**
 * Ten minutes. SettlementExecutor caps the window at MAX_ATTESTATION_VALIDITY
 * (15 minutes) and rejects anything wider; more importantly a long deadline
 * means a signature that stays live while the state it commits to drifts, so
 * short is safer than generous.
 */
export const DEADLINE_SECONDS = 600n;

/**
 * The gas hazard that deserves naming (keeper-old/src/attest.ts §5).
 *
 * previewContribution clamps against `attestation.account.balance` NOW. settle
 * clamps against `msg.sender.balance + msg.value` at execution time — and for an
 * EOA transaction the entire gasLimit × maxFeePerGas is debited BEFORE the body
 * runs. So the balance the contract sees is lower than the balance we previewed
 * against. If that difference pushes the balance clamp into binding, the
 * recomputed savedAmount no longer equals the signed contribution and settle
 * reverts InvalidContribution — which looks like a mysterious signature failure
 * rather than a funding problem. A settle has cost ~516k gas on mainnet; 800k
 * at twice the quoted price is a safe upper bound for a pre-signature check.
 * The real estimate happens in pull/submit.ts.
 */
export const GAS_HEADROOM_UNITS = 800_000n;
const GAS_PRICE_MULTIPLIER = 2n;

async function gasHeadroomWei(rpc: RpcClient): Promise<bigint> {
  try {
    return GAS_HEADROOM_UNITS * GAS_PRICE_MULTIPLIER * asBigInt(await rpc.call<unknown>("eth_gasPrice", []), "eth_gasPrice");
  } catch {
    // A fee read that fails must not skip the check entirely: with zero headroom
    // the strict comparison below still refuses a clamp that binds exactly.
    return 0n;
  }
}

/**
 * The newest L2 height in [floor, ceiling] whose L1 block is already strictly
 * below `headL1`, or null when even `floor` still sits in the block L1 is
 * building.
 *
 * Every height is READ from the chain, so nothing here invents an L1 number.
 * `l1BlockNumber` is non-decreasing in L2 height, which makes this a "last
 * true" search: two reads when the ceiling already qualifies (the common case
 * for a window that has aged), ~log2(span) when the end has to be walked back.
 * A linear walk would be ~120 reads for the same answer.
 */
export async function newestSettleableL2(
  rpc: RpcClient,
  floor: bigint,
  ceiling: bigint,
  headL1: bigint,
): Promise<{ readonly l2: bigint; readonly l1: bigint } | null> {
  const ceilingL1 = await l1BlockOf(rpc, ceiling);
  if (ceilingL1 < headL1) return { l2: ceiling, l1: ceilingL1 };
  if (floor >= ceiling) return null;
  const floorL1 = await l1BlockOf(rpc, floor);
  if (floorL1 >= headL1) return null;

  // Invariant: `low` is settleable, `high` is not.
  let low = floor;
  let lowL1 = floorL1;
  let high = ceiling;
  while (high - low > 1n) {
    const mid = low + (high - low) / 2n;
    const midL1 = await l1BlockOf(rpc, mid);
    if (midL1 < headL1) {
      low = mid;
      lowL1 = midL1;
    } else {
      high = mid;
    }
  }
  return { l2: low, l1: lowL1 };
}

// ── the attestation ─────────────────────────────────────────────────────────

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function deferred(reason: DeferReason, detail: string): AttestOutcome {
  return { kind: "DEFERRED", reason, detail };
}

/**
 * The window must describe its fills before anything is derived from it. These
 * are the attester's own invariants, so a violation is an exception, not a
 * deferral: nothing about the chain can make a window agree with itself later.
 */
function verifyWindow(chainId: number, window: VolumeWindow): void {
  if (window.startL2 <= 0n) {
    throw new Error(`window for ${window.wallet} starts at L2 block ${window.startL2}; a window cannot start at genesis`);
  }
  let sum = 0n;
  for (const fill of window.fills) {
    if (fill.blockL2 < window.startL2 || fill.blockL2 > window.endL2) {
      throw new Error(
        `window (${window.startL2}, ${window.endL2}] for ${window.wallet} carries fill ${fill.txHash} at block ${fill.blockL2}, outside its range`,
      );
    }
    if (fill.notionalWei <= 0n) {
      throw new Error(`window for ${window.wallet} carries fill ${fill.txHash} with non-positive notional ${fill.notionalWei}`);
    }
    sum += fill.notionalWei;
  }
  if (sum !== window.sumNotionalWei) {
    throw new Error(`window for ${window.wallet} claims sumNotionalWei ${window.sumNotionalWei}, its fills add up to ${sum}`);
  }
  if (sum === 0n) {
    throw new Error(`window (${window.startL2}, ${window.endL2}] for ${window.wallet} has no volume; nothing to attest`);
  }
  const root = batchRoot(chainId, window.wallet, window.fills);
  if (!same(root, window.batchRoot)) {
    // The root is domain-separated by chain id, so a disagreement here is as
    // likely to be a chain the worker was not configured for as a corrupted
    // window. Name the id that was used, or the next reader chases the fills.
    throw new Error(
      `window for ${window.wallet} carries batchRoot ${window.batchRoot}, its fills hash to ${root} on chain ${chainId}`,
    );
  }
}

export interface AttestOptions {
  /**
   * The configured chain id (`config.chainId`). It is what the batch root was
   * committed with, what the EIP-712 domain binds to and what the attestation
   * carries, so passing it is how a worker pointed at another chain fails on
   * its own terms instead of signing for 4663 regardless. Optional only while
   * the caller is threading it through; the mainnet constant is the default.
   */
  readonly chainId?: number;
}

/**
 * Builds and signs the deployed SettlementExecutor's 26-field attestation from a volume window:
 * cashStart = 0, externalDeposits = externalWithdrawals = 0, cashEnd = realizedProfit = sumNotionalWei,
 * contribution = previewContribution() (the exact-maximum rule), L1 range from l1BlockOf, sessionId via deriveSessionId(),
 * ledgerRoot = batchRoot, validAfter = now - 60 s, deadline = now + 600 s; refuses BEFORE signing on any preflight failure.
 */
export async function attestPhase0(
  rpc: RpcClient,
  executor: `0x${string}`,
  window: VolumeWindow,
  snapshot: VaultSnapshot,
  signer: AttesterSigner,
  now: { unixSeconds: bigint; headL2: bigint },
  options: AttestOptions = {},
): Promise<AttestOutcome> {
  const chainId = options.chainId ?? CHAIN_ID;
  const account = window.wallet.toLowerCase() as Address;
  const executorAddress = executor.toLowerCase() as Address;

  // A snapshot of another account under this window is not a chain state to
  // wait out; it is the caller signing one wallet's volume with another's
  // nonces. Refuse loudly.
  if (!same(snapshot.account, account)) {
    throw new Error(`attestPhase0: snapshot is for ${snapshot.account}, window is for ${window.wallet}`);
  }
  verifyWindow(chainId, window);

  // -------------------------------------------------------------------------
  // Preflight, in DESIGN.md §5 order. Every condition here would otherwise be
  // learned from a revert that has already cost the trader gas — and an
  // unattended worker would retry it every tick.
  // -------------------------------------------------------------------------

  // 1. Paused: protocol first (settle checks it before anything else), then the vault.
  if (snapshot.protocolPaused) return deferred("PAUSED", "ProtocolPauseController.paused() is true");
  if (snapshot.settlementPaused) return deferred("PAUSED", "PersonalVault.settlementPaused() is true");

  // 2. Account. Either not bound at all (activeVaultOf returns zero — which is
  //    what happens for the vault ADMIN address, a very easy mix-up), bound to
  //    another vault than the window names, or bound but not ACTIVE.
  if (snapshot.vault === ZERO_ADDRESS || !same(snapshot.vault, window.vault)) {
    return deferred(
      "ACCOUNT_NOT_ACTIVE",
      `factory.activeVaultOf(${account}) is ${snapshot.vault}, not the window's vault ${window.vault}. ` +
        "SettlementExecutor resolves the vault from msg.sender, so this account cannot settle into that vault.",
    );
  }
  if (snapshot.status !== ACCOUNT_STATUS_ACTIVE) {
    return deferred("ACCOUNT_NOT_ACTIVE", `account status is ${snapshot.status}, needs ${ACCOUNT_STATUS_ACTIVE} (ACTIVE)`);
  }

  // 3. The vault must point at the executor we are about to bind to.
  if (!same(snapshot.executor, executorAddress)) {
    return deferred(
      "EXECUTOR_MISMATCH",
      `PersonalVault.settlementExecutor() is ${snapshot.executor}, the configured executor is ${executorAddress}`,
    );
  }

  // 4. The attester, read fresh: the registry can rotate between the snapshot
  //    and now, and a signature from a key that is no longer registered would
  //    only produce InvalidAttesterSignature.
  const registry = asAddress(
    await readContract(rpc, executorAddress, EXECUTOR_ABI, "attesterRegistry", [], "latest"),
    "SettlementExecutor.attesterRegistry",
  );
  const [attesterRaw, attesterEpochRaw] = await Promise.all([
    readContract(rpc, registry, REGISTRY_ABI, "attester", [], "latest"),
    readContract(rpc, registry, REGISTRY_ABI, "attesterEpoch", [], "latest"),
  ]);
  const attester = asAddress(attesterRaw, "AttesterRegistry.attester");
  const attesterEpoch = asBigInt(attesterEpochRaw, "AttesterRegistry.attesterEpoch");
  if (!same(attester, signer.address)) {
    return deferred(
      "ATTESTER_MISMATCH",
      `AttesterRegistry.attester() is ${attester}, the loaded key is ${signer.address.toLowerCase()}`,
    );
  }
  if (attesterEpoch !== snapshot.attesterEpoch) {
    return deferred(
      "ATTESTER_MISMATCH",
      `AttesterRegistry.attesterEpoch() moved from ${snapshot.attesterEpoch} to ${attesterEpoch} since the snapshot; re-read next tick`,
    );
  }

  // 5. The L2 range, against the vault's own rules, so no signature is wasted
  //    on a window the vault will refuse. Both bounds are strict on-chain.
  if (window.endL2 <= window.startL2) {
    return deferred(
      "L1_NOT_ADVANCED",
      `L2 range (${window.startL2}, ${window.endL2}] is degenerate; SettlementExecutor requires endBlockL2 > startBlockL2, so the window must grow`,
    );
  }
  if (window.startL2 <= snapshot.frontierEndL2) {
    return deferred(
      "NOTHING_COLLECTABLE",
      `startBlockL2 ${window.startL2} is at or below the vault's settled frontier ${snapshot.frontierEndL2}; ` +
        "Phase 0 cannot settle a range the vault has already progressed past — the cursor must move beyond the frontier",
    );
  }

  // 6. The L1 range. The contract requires endBlock < block.number in L1 space.
  //    ~120 L2 blocks fit inside one L1 block, so the window's own end — the L2
  //    head minus the finality margin — usually still maps to the L1 block that
  //    is being built. Deferring the whole window for that lost about three
  //    passes in four, and the next pass closed an even fresher window, so the
  //    lag never cleared itself.
  //
  //    Settle the part that IS old enough instead: walk the end back to the
  //    newest L2 block this window can still claim whose l1BlockNumber is
  //    already below the head. Every height is read from a block, never derived
  //    from a delta — the L1/L2 gap is not a constant on this chain (measured
  //    at 3,551,127 one day and ~2.65M the next), so a stored offset produces
  //    InvalidBlockRange reverts. The walk stops at the newest fill: the
  //    ledgerRoot commits to those fills, and a range that does not contain
  //    them would not describe what it attests. The blocks above the new end
  //    keep their window and settle once L1 moves on.
  const [startBlock, headL1] = await Promise.all([l1BlockOf(rpc, window.startL2), l1BlockOf(rpc, now.headL2)]);
  const newestFillL2 = window.fills.reduce((newest, fill) => (fill.blockL2 > newest ? fill.blockL2 : newest), window.startL2 + 1n);
  const settleable = await newestSettleableL2(rpc, newestFillL2, window.endL2, headL1);
  if (settleable === null) {
    return deferred(
      "L1_NOT_ADVANCED",
      `no block in [${newestFillL2}, ${window.endL2}] is behind the L1 head yet: L1 head is ${headL1} ` +
        `(L2 head ${now.headL2}), and SettlementExecutor requires endBlock < block.number. ` +
        "One L1 block from now the same window settles, with its volume intact",
    );
  }
  const endL2 = settleable.l2;
  const endBlock = settleable.l1;
  if (endBlock < startBlock) {
    throw new Error(`L1 height decreased across the window: L2 ${window.startL2} -> L1 ${startBlock}, L2 ${endL2} -> L1 ${endBlock}`);
  }
  if (startBlock < snapshot.activationBlockL1) {
    return deferred(
      "L1_NOT_ADVANCED",
      `startBlockL1 ${startBlock} predates the account's activationBlock ${snapshot.activationBlockL1}; ` +
        "the binding was (re)established after this window opened, so retrying will not help until the cursor passes the activation height",
    );
  }

  // -------------------------------------------------------------------------
  // The attestation, with the contribution still unknown.
  // -------------------------------------------------------------------------
  const ledgerRoot = window.batchRoot.toLowerCase() as Hex;
  const sessionInputs: SessionIdInputs = {
    chainId: BigInt(chainId),
    vault: snapshot.vault,
    account,
    bindingEpoch: snapshot.bindingEpoch,
    startBlockL1: startBlock,
    endBlockL1: endBlock,
    startBlockL2: window.startL2,
    endBlockL2: endL2,
    ledgerRoot,
  };
  const sessionId = asHex32(
    await readContract(
      rpc,
      executorAddress,
      EXECUTOR_ABI,
      "deriveSessionId",
      [
        sessionInputs.chainId,
        sessionInputs.vault,
        sessionInputs.account,
        sessionInputs.bindingEpoch,
        sessionInputs.startBlockL1,
        sessionInputs.endBlockL1,
        sessionInputs.startBlockL2,
        sessionInputs.endBlockL2,
        sessionInputs.ledgerRoot,
      ],
      "latest",
    ),
    "SettlementExecutor.deriveSessionId",
  );
  // The view is pure and public; if it disagrees with its own source the
  // executor at this address is not the contract we read, and nothing built on
  // its answers should be signed.
  const localSessionId = deriveSessionIdLocal(sessionInputs);
  if (!same(sessionId, localSessionId)) {
    return deferred(
      "DIGEST_MISMATCH",
      `SettlementExecutor.deriveSessionId() returned ${sessionId}, the local computation is ${localSessionId}`,
    );
  }

  const base: SettlementAttestation = {
    chainId: BigInt(chainId),
    vault: snapshot.vault,
    account,
    executor: executorAddress,
    bindingEpoch: snapshot.bindingEpoch,
    policyNonce: snapshot.policyNonce,
    settlementNonce: snapshot.settlementNonce,
    adminEpoch: snapshot.adminEpoch,
    localPauseEpoch: snapshot.localPauseEpoch,
    globalPauseEpoch: snapshot.globalPauseEpoch,
    attesterEpoch: snapshot.attesterEpoch,
    policyHash: snapshot.policyHash,
    sessionId,
    ledgerRoot,
    startBlock,
    endBlock,
    startBlockL2: window.startL2,
    endBlockL2: endL2,
    // Volume as profit: (0, Σnotional, 0, 0) makes calculateRealizedProfit
    // return Σnotional, and the executor's bps clamp does the rest.
    cashStart: 0n,
    cashEnd: window.sumNotionalWei,
    externalDeposits: 0n,
    externalWithdrawals: 0n,
    realizedProfit: window.sumNotionalWei,
    contribution: 0n,
    validAfter: now.unixSeconds - VALID_AFTER_SKEW_SECONDS,
    deadline: now.unixSeconds + DEADLINE_SECONDS,
  };

  // -------------------------------------------------------------------------
  // 7. The contribution: ask the executor, then bound its answer.
  // -------------------------------------------------------------------------
  let contribution: bigint;
  try {
    contribution = asBigInt(
      await readContract(rpc, executorAddress, EXECUTOR_ABI, "previewContribution", [base], "latest"),
      "SettlementExecutor.previewContribution",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return deferred("NOTHING_COLLECTABLE", `previewContribution reverted: ${message.slice(0, 200)}`);
  }

  const reserved = snapshot.tradingFloorWei + snapshot.gasReserveWei;
  if (contribution === 0n) {
    return deferred(
      "NOTHING_COLLECTABLE",
      `previewContribution returned 0 for owed ${window.owedWei} (savingsBps ${snapshot.savingsBps}, balance ${snapshot.nativeBalanceWei}, floor+reserve ${reserved})`,
    );
  }
  if (contribution < snapshot.minContributionWei) {
    return deferred("BELOW_MINIMUM", `contribution ${contribution} < minContributionWei ${snapshot.minContributionWei}`);
  }

  // THE BOUND ASKS WHETHER THE NUMBER IS POSSIBLE, NOT WHETHER IT IS BIG. Every
  // step of _calculateContribution is a min, so the result can never exceed the
  // first term (volume × bps) nor the per-settlement cap. Exceeding it means the
  // executor returned a number its own source cannot produce, or the policy
  // moved between the snapshot and the preview — and this attestation binds the
  // policy nonce and hash, so it could never execute anyway. Re-read next tick.
  // The rolling-cap terms are deliberately absent: `remaining` is live state
  // that legitimately drifts within a tick, so a bound on it would refuse
  // legitimate settlements. Leaving it out only makes the bound looser.
  const byVolume = (window.sumNotionalWei * BigInt(snapshot.savingsBps)) / 10_000n;
  const possible = byVolume < snapshot.maxPerSettlementWei ? byVolume : snapshot.maxPerSettlementWei;
  if (contribution > possible) {
    return deferred(
      "NOTHING_COLLECTABLE",
      `contribution ${contribution} exceeds what this policy can justify (${possible}): ` +
        `volume ${window.sumNotionalWei} x ${snapshot.savingsBps} bps = ${byVolume}, maxPerSettlement ${snapshot.maxPerSettlementWei}. ` +
        "Either the policy moved since the snapshot was read, in which case the next tick agrees with itself, or the executor is not doing what its source says.",
    );
  }

  // The balance hazard (see GAS_HEADROOM_UNITS). Strict on purpose: with the
  // clamp binding exactly, even a zero-gas transaction would recompute a
  // smaller amount than the one signed.
  const gasHeadroom = await gasHeadroomWei(rpc);
  if (snapshot.nativeBalanceWei <= contribution + reserved + gasHeadroom) {
    return deferred(
      "NOTHING_COLLECTABLE",
      `balance ${snapshot.nativeBalanceWei} <= contribution ${contribution} + floor+reserve ${reserved} + gas headroom ${gasHeadroom}: ` +
        "settle() recomputes the contribution after the gas prefund and would revert InvalidContribution; the owed amount carries forward until the wallet holds more ETH",
    );
  }

  // -------------------------------------------------------------------------
  // 8. The digest, verified against the contract's own view BEFORE signing.
  // -------------------------------------------------------------------------
  const attestation: SettlementAttestation = { ...base, contribution };
  const localDigest = hashAttestationLocal(chainId, executorAddress, attestation);
  const onchainDigest = asHex32(
    await readContract(rpc, executorAddress, EXECUTOR_ABI, "hashAttestation", [attestation], "latest"),
    "SettlementExecutor.hashAttestation",
  );
  if (!same(localDigest, onchainDigest)) {
    return deferred(
      "DIGEST_MISMATCH",
      `local EIP-712 digest ${localDigest} != hashAttestation() ${onchainDigest}. ATTESTATION_TYPES or the domain has drifted from the contract; a signature built from it would be rejected.`,
    );
  }

  // -------------------------------------------------------------------------
  // 9. Sign. Nothing above this line has touched the signer.
  // -------------------------------------------------------------------------
  const signature = await signer.signTypedData({
    domain: attestationDomain(chainId, executorAddress),
    types: ATTESTATION_TYPES,
    primaryType: "SettlementAttestation",
    message: toTypedMessage(attestation),
  });

  return { kind: "SIGNED", attestation, signature, contributionWei: contribution };
}
