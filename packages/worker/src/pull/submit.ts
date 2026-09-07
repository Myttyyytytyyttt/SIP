// Broadcast, and the dry-run gate.
//
// Ported from packages/keeper-old/src/submit.ts (the ordering). The settle
// calldata is NOT encoded here: attest/phase0.ts owns the executor ABI and the
// attestation, and two encoders would be two answers to "what did we send".
//
// TWO THINGS THIS FILE EXISTS FOR.
//
// 1. DRY RUN BY DEFAULT, STRUCTURALLY. The mode check is the first statement in
//    `submitPull`, and it returns before the seat, the rpc or the ledger is
//    touched. It is not the only defence — config.ts refuses to even read the
//    Privy secrets outside live mode, so in a dry run the process holds no
//    credential that can ask for a signature — but it is the one that is
//    directly testable, and test/pull.test.ts asserts it by handing dry-run
//    mode a seat, an rpc and a ledger that throw if called.
//
// 2. THE CRASH-AFTER-BROADCAST WINDOW IS CLOSED BY ORDERING, NOT BY DETECTION.
//    A tx hash is unknown until after a `sendTransaction` has already happened.
//    That is fine for a human watching a terminal and fatal for an unattended
//    service: crash in that gap and there is no record of what was sent, or
//    with which nonce. So the worker owns both. Privy signs the transaction and
//    hands back the raw bytes, whose keccak IS the transaction hash, before
//    anything reaches the network. The order is therefore:
//
//        reserve nonce -> estimate -> sign via the seat -> RECORD INTENT -> send raw
//
//    Crash anywhere and exactly one of these is true: nothing was sent and no
//    record exists (the window is simply still SIGNED), or an INTENT exists in
//    the ledger carrying the exact nonce and raw hash, and the confirmation pass
//    can ask the chain which it was. There is no third case.
//
// One addition over the old keeper: the raw bytes Privy returns are parsed and
// compared with what was asked for before they are recorded or sent. A TEE that
// signs what it was asked is the assumption; a cheap check that costs nothing
// is how the assumption is kept honest, and it is the last moment at which
// "nothing was broadcast" is still true.

import { hexToBigInt, keccak256, numberToHex, parseTransaction } from "viem";

import { encodeSettleCalldata } from "../attest/phase0.js";
import type { Address, Hex, Ledger, PullIntent, PullOutcome, RpcClient, SettlementAttestation, VolumeWindow, WorkerMode } from "../types.js";
import type { SeatSigner, SeatTransaction } from "./privy.js";

/** The gas a mainnet settle actually used, plus room. Only a fallback when the estimate reverts. */
export const FALLBACK_GAS_LIMIT = 900_000n;

/** The estimate is padded before it becomes the limit: a settle touches storage the estimate may not. */
const GAS_LIMIT_NUMERATOR = 12n;
const GAS_LIMIT_DENOMINATOR = 10n;

/** viem's estimateFeesPerGas default: maxFee = baseFee × 1.2 + priority. */
const BASE_FEE_NUMERATOR = 12n;
const BASE_FEE_DENOMINATOR = 10n;

/** A pull whose contribution does not cover this many times its own gas is not worth the user's gas. */
export const GAS_FLOOR_MULTIPLIER = 2n;

export interface FeeQuote {
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
}

/** Pending nonce: the one a new transaction must be signed for. */
export async function pendingNonce(rpc: RpcClient, address: Address): Promise<number> {
  const raw = await rpc.call<Hex>("eth_getTransactionCount", [address, "pending"]);
  return Number(hexToBigInt(raw));
}

/**
 * Fee quote from the latest block's base fee and the node's priority-fee hint.
 * A node without `eth_maxPriorityFeePerGas` gets a zero tip (Nitro's answer is
 * zero anyway); the worst case is a pull that waits past its own deadline and
 * is simply attested again next tick.
 */
export async function feeQuote(rpc: RpcClient): Promise<FeeQuote> {
  const block = await rpc.call<{ baseFeePerGas?: Hex | null } | null>("eth_getBlockByNumber", ["latest", false]);
  const baseFee = block?.baseFeePerGas;
  if (typeof baseFee !== "string") {
    throw new Error("eth_getBlockByNumber(latest) carries no baseFeePerGas; cannot price an EIP-1559 pull");
  }
  let priority = 0n;
  try {
    priority = hexToBigInt(await rpc.call<Hex>("eth_maxPriorityFeePerGas", []));
  } catch {
    priority = 0n;
  }
  return {
    maxFeePerGas: (hexToBigInt(baseFee) * BASE_FEE_NUMERATOR) / BASE_FEE_DENOMINATOR + priority,
    maxPriorityFeePerGas: priority,
  };
}

/**
 * eth_estimateGas for the pull, or null when the node says it would revert.
 * The estimate runs the whole settle against current state, so it doubles as
 * the "would this actually work" check.
 */
export async function estimatePullGas(
  rpc: RpcClient,
  call: { from: Address; to: Address; value: bigint; data: Hex },
): Promise<bigint | null> {
  try {
    const raw = await rpc.call<Hex>("eth_estimateGas", [
      { from: call.from, to: call.to, value: numberToHex(call.value), data: call.data },
    ]);
    return hexToBigInt(raw);
  } catch {
    return null;
  }
}

/** The pull must be worth at least GAS_FLOOR_MULTIPLIER × its maximum gas cost. */
export function gasFloorWei(gasLimit: bigint, maxFeePerGas: bigint): bigint {
  return GAS_FLOOR_MULTIPLIER * gasLimit * maxFeePerGas;
}

/** Exactly what would be, or was, put on the wire — minus the signature. */
export interface PullPlan {
  readonly tx: SeatTransaction;
  readonly estimatedGas: bigint | null;
  readonly gasFloorWei: bigint;
}

/**
 * Assembles the exact transaction: calldata, fees, gas limit. When the estimate
 * reverts, the fallback limit is used: the estimate is diagnostic, not a gate
 * (a lagging node can refuse a settle the chain would accept), and the floor
 * below still applies to the fallback.
 */
export async function planPull(
  rpc: RpcClient,
  args: { from: Address; executor: Address; attestation: SettlementAttestation; signature: Hex; nonce: number },
): Promise<PullPlan> {
  const data = encodeSettleCalldata(args.attestation, args.signature);
  const value = args.attestation.contribution;
  const fees = await feeQuote(rpc);
  const estimatedGas = await estimatePullGas(rpc, { from: args.from, to: args.executor, value, data });
  const gas = estimatedGas === null ? FALLBACK_GAS_LIMIT : (estimatedGas * GAS_LIMIT_NUMERATOR) / GAS_LIMIT_DENOMINATOR;
  return {
    tx: {
      to: args.executor,
      data,
      value,
      nonce: args.nonce,
      gas,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      chainId: Number(args.attestation.chainId),
    },
    estimatedGas,
    gasFloorWei: gasFloorWei(gas, fees.maxFeePerGas),
  };
}

/**
 * The INTENT is durable and the send failed — but "failed" is not "definitely
 * not broadcast": a timeout can hide a transaction that reached the mempool.
 * The intent carries the nonce and hash the chain must be asked about; the
 * caller must not treat this as "nothing happened".
 */
export class PullBroadcastError extends Error {
  readonly intent: PullIntent;
  constructor(intent: PullIntent, cause: unknown) {
    super(`eth_sendRawTransaction failed after the intent was recorded (nonce ${intent.nonce}, hash ${intent.txHash}); ${describe(cause)}`);
    this.name = "PullBroadcastError";
    this.intent = intent;
  }
}

/** No secrets in ledger details either: any 64-hex string is masked before it becomes a detail. */
const redactHex64 = (text: string): string => text.replace(/0x[0-9a-fA-F]{64}|(?<![0-9a-fA-F])[0-9a-fA-F]{64}(?![0-9a-fA-F])/g, "[redacted]");

const describe = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return redactHex64(message).slice(0, 400);
};

/**
 * The raw bytes must be the transaction that was asked for. Compared field by
 * field so a signer that returns the wrong transaction — a shape change, a
 * wallet mix-up, a stale request — is caught while "nothing was broadcast" is
 * still true.
 */
export function assertSignedMatches(raw: Hex, wanted: SeatTransaction): void {
  const parsed = parseTransaction(raw);
  const problems: string[] = [];
  if (parsed.type !== "eip1559") problems.push(`type ${parsed.type ?? "?"} ≠ eip1559`);
  if ((parsed.to ?? "").toLowerCase() !== wanted.to.toLowerCase()) problems.push(`to ${parsed.to ?? "?"} ≠ ${wanted.to}`);
  if ((parsed.value ?? 0n) !== wanted.value) problems.push(`value ${parsed.value ?? 0n} ≠ ${wanted.value}`);
  if ((parsed.data ?? "0x").toLowerCase() !== wanted.data.toLowerCase()) problems.push("calldata differs");
  if (parsed.nonce !== wanted.nonce) problems.push(`nonce ${parsed.nonce ?? "?"} ≠ ${wanted.nonce}`);
  if (parsed.chainId !== wanted.chainId) problems.push(`chainId ${parsed.chainId ?? "?"} ≠ ${wanted.chainId}`);
  if (parsed.gas !== wanted.gas) problems.push(`gas ${parsed.gas ?? "?"} ≠ ${wanted.gas}`);
  if (problems.length > 0) {
    throw new Error(`signed transaction does not match the request; nothing was broadcast: ${problems.join("; ")}`);
  }
}

/**
 * Dry run returns before any signer is touched. Live: reserve nonce -> estimate -> sign via seat -> record INTENT -> send raw.
 * Port of keeper-old submit.ts ordering; calldata = SettlementExecutor.settle(attestation, signature).
 */
export async function submitPull(
  rpc: RpcClient,
  mode: WorkerMode,
  executor: Address,
  window: VolumeWindow,
  attestation: SettlementAttestation,
  signature: `0x${string}`,
  contributionWei: bigint,
  seat: SeatSigner | null,
  ledger: Ledger,
  windowId: number,
): Promise<PullOutcome> {
  // ---- gate 1: the mode. Before the seat, the rpc or the ledger is touched. --
  if (mode !== "live") {
    return { kind: "DRY_RUN", intent: { window, attestation, signature, contributionWei } };
  }

  // ---- gate 2: the seat. Live mode without a seat cannot proceed. -----------
  if (seat === null) {
    return { kind: "SKIPPED", reason: "SIGNER_UNAVAILABLE", detail: "live mode reached submit with no seat signer; refusing rather than guessing" };
  }

  // ---- gate 3: the attestation and the money must agree with the window. ----
  // msg.sender MUST be the trading wallet: SettlementExecutor resolves the vault
  // via factory.activeVaultOf(msg.sender). And the contribution must equal
  // msg.value to the wei (the executor's exact-maximum rule), so a disagreement
  // between what was attested and what we were told to send is a bug upstream,
  // not something to pick a side on.
  const wallet = window.wallet;
  if (attestation.account.toLowerCase() !== wallet.toLowerCase()) {
    throw new Error(`attestation.account ${attestation.account} is not the window's wallet ${wallet}; refusing`);
  }
  if (attestation.contribution !== contributionWei) {
    throw new Error(`attestation.contribution ${attestation.contribution} ≠ contributionWei ${contributionWei}; refusing`);
  }

  // ---- gate 4: the seat, read fresh. A revoked seat is a fact, not an error. -
  const walletId = await seat.walletIdOf(wallet);
  if (walletId === null) {
    return { kind: "SKIPPED", reason: "SEAT_REVOKED", detail: `no active app signer on ${wallet}` };
  }

  // ---- reserve the nonce, estimate, then the gas floor -----------------------
  const nonce = await pendingNonce(rpc, wallet);
  const plan = await planPull(rpc, { from: wallet, executor, attestation, signature, nonce });
  if (contributionWei < plan.gasFloorWei) {
    return {
      kind: "SKIPPED",
      reason: "BELOW_GAS_FLOOR",
      detail:
        `contribution ${contributionWei} < floor ${plan.gasFloorWei} ` +
        `(${GAS_FLOOR_MULTIPLIER}× gas ${plan.tx.gas} × maxFeePerGas ${plan.tx.maxFeePerGas}` +
        `${plan.estimatedGas === null ? ", estimate reverted, fallback limit" : ""})`,
    };
  }

  // ---- sign via the seat. A refusal here means nothing was broadcast. --------
  let rawTx: Hex;
  try {
    rawTx = await seat.signTransaction(walletId, plan.tx);
  } catch (error) {
    return { kind: "SKIPPED", reason: "SIGNER_UNAVAILABLE", detail: `seat refused to sign: ${describe(error)}` };
  }
  assertSignedMatches(rawTx, plan.tx);

  // The hash of a signed transaction is the keccak of its serialization. Knowing
  // it before the send is the whole point of this ordering.
  const txHash = keccak256(rawTx);
  const intent: PullIntent = { window, attestation, signature, contributionWei, nonce, rawTx, txHash };

  // THE INTENT MUST BE DURABLE BEFORE ANYTHING IS SENT. Nothing in this project
  // lints for a floating promise, so a missing `await` here would compile, run,
  // and leave a pull that moved real money with no record to reconcile it
  // against. The outcome is recorded as SENT now because from this line on it
  // must be assumed to be on the wire; the confirmation pass settles it by receipt.
  await ledger.recordPull(windowId, intent, { kind: "SENT", intent });

  // Everything above this line is reversible. Nothing below it is.
  try {
    await rpc.call<Hex>("eth_sendRawTransaction", [rawTx]);
  } catch (error) {
    throw new PullBroadcastError(intent, error);
  }
  return { kind: "SENT", intent };
}
