// The invest crank: read a vault's investment half in one pass, ask policy.ts
// what to do, and — when the answer is "invest" — build and send the call
// through a trading wallet's own Privy seat.
//
// THIS IS THE HALF THE PRODUCT IS NAMED FOR. The pull path moves WETH into the
// vault; until this file, nothing ever spent it. `PersonalVault.invest()` does,
// and its whole design is that the caller chooses WHEN and, within the admin's
// bounds, HOW MUCH — which assets, in what proportion, at what floor, and where
// the output lands all come from state the admin signed for. So this crank is
// allowed to be a keeper with a key and still cannot take anything: at worst it
// buys the user's own basket into the user's own vault at a price the user
// bounded.
//
// PER VAULT, NOT PER WALLET. `invest()` spends the VAULT's balance against ONE
// hashed basket, so several trading wallets settling into one vault still make
// one investment. `CrankVault` in `src/tick.ts` is that seam: it hands over the
// vault and every wallet bound to it, and those wallets are candidates for who
// SIGNS, never a list of things to do.
//
// WHOSE SIGNATURE. `_requireInvestmentAuthority` accepts the vault admin or a
// trading account the vault currently considers ACTIVE. The worker holds no
// admin key and must never hold one — the admin is the user's pension key, the
// one that withdraws — so the crank signs as a TRADING WALLET, through the same
// Privy seat `pull/submit.ts` uses. The seat's policy already allows `invest`
// with value 0 on chain 4663, and the value IS 0 here: the WETH being spent is
// the vault's, and the wallet pays gas and nothing else. A second wallet is
// asked only when the first cannot SIGN; every other answer is the vault's
// answer, not the wallet's, and asking again would only repeat it.
//
// READ TOGETHER, PINNED TO ONE BLOCK, exactly as `attest/snapshot.ts` does it
// and for the same reason: a decision assembled from values that were never
// simultaneously true is a decision about a state that never existed. What
// happens next is the contract's own doing — `invest()` carries a
// compare-and-swap on the policy nonce, the basket hash and the adapter status
// epoch, so a state that moved between the read and the send makes the
// transaction REVERT rather than do the wrong thing. The crank re-reads the
// nonce once more before signing anyway, because a revert costs the user gas
// and a re-read costs one eth_call.
//
// ORDERING, AND WHERE IT DIFFERS FROM `pull/submit.ts`:
//
//     authority -> MODE -> seat -> reserve nonce -> estimate -> gas floor
//               -> re-read the policy nonce -> sign -> RECORD -> send
//
//   - The mode gate comes before the seat, the nonce and the estimate, and the
//     only thing in front of it is a pure read of values already in hand. Same
//     discipline as `submitPull`, same test: the dry run is handed a seat, an
//     rpc and a ledger that throw on every method.
//   - A REVERTING ESTIMATE STOPS THIS ONE. `submitPull` treats the estimate as
//     diagnostic and falls back to a fixed limit, because a lagging node can
//     refuse a settle the chain would accept. Here the estimate runs the
//     adapter, the price floors and the exact-debit assertion — it is the only
//     slippage check the worker has, and an invest that reverts costs gas and
//     buys nothing. So there is no fallback gas limit: no estimate, no send.
//   - THE JOURNAL IS THE LEDGER'S, WHEN IT HAS ONE. `Ledger.recordInvestment`
//     is optional until the ledger owner lands `sip_investment`, so the write is
//     conditional — but its POSITION is not: the intent is handed over before
//     the send, so the day the table exists the crash-after-broadcast window is
//     already closed. Until then the vault's own WETH balance is the record: an
//     invest that mined is simply absent from the next pass's investable
//     balance.

import { abis } from "@nuvem/contracts-artifacts";
import {
  decodeAbiParameters,
  decodeEventLog,
  encodeEventTopics,
  encodeFunctionData,
  hexToBigInt,
  isHex,
  keccak256,
  numberToHex,
  type Abi,
} from "viem";

import {
  ACCOUNT_STATUS_ACTIVE,
  PAUSE_ABI,
  VAULT_ABI,
  VAULT_STORAGE_LOCATION,
  asAddress,
  asBigInt,
  asBool,
  asHex32,
  asNumber,
  asRecord,
  readContract,
} from "../attest/snapshot.js";
import { erc20BalanceAt, getLogs, nativeBalanceAt } from "../chain/reads.js";
import type { SeatSigner, SeatTransaction } from "../pull/privy.js";
// One estimator, one fee quote, one nonce read and one signed-bytes check for
// the whole worker: these are `eth_estimateGas`, `eth_getBlockByNumber` and
// `eth_getTransactionCount` with the narrowing already written, and a second
// copy would be a second answer to "what did we send".
import { assertSignedMatches, estimatePullGas, feeQuote, pendingNonce } from "../pull/submit.js";
import type {
  Address,
  BasketLeg,
  Hex,
  InvestDeferReason,
  InvestIntent,
  InvestOutcome,
  Ledger,
  RpcClient,
  VaultInvestmentPolicy,
  WorkerMode,
} from "../types.js";
import { BASKET_LEGS_PARAM, basketHashOf, decideInvestment, type AdapterStatus, type InvestDecision } from "./policy.js";

export const ADAPTER_REGISTRY_ABI: Abi = abis.AdapterRegistry;

/** A chain answer the crank cannot turn into a decision. */
export class InvestError extends Error {
  override readonly name = "InvestError";
}

// ── VaultStorage slots, measured by VaultLens.sol ───────────────────────────
//
// PersonalVault has getters for `investmentPolicyNonce` and
// `investmentRollingCapStatus` and NOTHING ELSE on this path: the flags, the
// adapter id, the basket hash, the limits, the WETH address and the pause
// controller are private ERC-7201 storage reached through `extsload(slot)`,
// which is what that function exists for. The offsets are VaultLens's, and they
// are MEASURED rather than derived — the compiler packs `settlementExecutor`
// with two other fields, so counting struct members gives the wrong answer.
// Reading the wrong word reports a vault that looks switched off however it is
// configured, so the test pins every constant against VaultLens.sol's source.

export const SLOT_WETH: bigint = VAULT_STORAGE_LOCATION + 4n;
export const SLOT_PAUSE_CONTROLLER: bigint = VAULT_STORAGE_LOCATION + 5n;
/** investmentPolicyNonce(64) | investmentEnabled(8) | investmentPaused(8) */
export const SLOT_INVESTMENT_PACKED: bigint = VAULT_STORAGE_LOCATION + 47n;
export const SLOT_ADAPTER_ID: bigint = VAULT_STORAGE_LOCATION + 48n;
export const SLOT_BASKET_HASH: bigint = VAULT_STORAGE_LOCATION + 49n;
/** minInvestmentWei(128) | maxInvestmentPerCallWei(128) */
export const SLOT_INVESTMENT_LIMITS: bigint = VAULT_STORAGE_LOCATION + 50n;

const MASK_64 = (1n << 64n) - 1n;
const MASK_128 = (1n << 128n) - 1n;

/** `adapterRegistry` LEFT this slot when it became an implementation immutable: nonce at 0, enabled at 64, paused at 72. */
export function decodeInvestmentPacked(word: Hex): { readonly policyNonce: bigint; readonly enabled: boolean; readonly paused: boolean } {
  const value = hexToBigInt(word);
  return { policyNonce: value & MASK_64, enabled: ((value >> 64n) & 1n) === 1n, paused: ((value >> 72n) & 1n) === 1n };
}

/** Two uint128s in one word, low first. */
export function decodeInvestmentLimits(word: Hex): { readonly minInvestmentWei: bigint; readonly maxPerCallWei: bigint } {
  const value = hexToBigInt(word);
  return { minInvestmentWei: value & MASK_128, maxPerCallWei: (value >> 128n) & MASK_128 };
}

/** The 20-byte address in the low bits of a storage word. */
const slotAddress = (word: Hex): Address => asAddress(`0x${word.slice(-40)}`, "extsload(address slot)");

const slotArg = (slot: bigint): Hex => numberToHex(slot, { size: 32 });

// ── the snapshot ────────────────────────────────────────────────────────────

/** One wallet the pass offered, with the only thing about it `invest()` reads. */
export interface VaultAccount {
  readonly address: Address;
  /** `NuvemTypes.AccountStatus` in THIS vault; 2 is ACTIVE, and ACTIVE is authority. */
  readonly status: number;
}

/** Everything `invest()` will check, read in one pass at one block. */
export interface InvestSnapshot {
  readonly blockL2: bigint;
  readonly vault: Address;
  readonly vaultAdmin: Address;
  readonly weth: Address;
  readonly adapterRegistry: Address;
  /** The wallets the pass offered as signers, in its order, with what the vault says about each. */
  readonly accounts: readonly VaultAccount[];
  /** `policy.wethBalanceWei` under the name the pass logs it by: the only thing `invest()` can spend. */
  readonly investableWei: bigint;
  /** `legs` is null here — recovering them costs a log query the crank pays for only if it must. */
  readonly policy: VaultInvestmentPolicy;
  readonly adapter: AdapterStatus;
}

/**
 * Reads the vault's investment half, pinned to one block.
 *
 * THE VAULT IS GIVEN, NOT RESOLVED. The pull path starts from a wallet and asks
 * `factory.activeVaultOf`; this starts from the vault the ledger already binds
 * those wallets to, and authority is read from the VAULT's own `tradingAccounts`
 * mapping — because that is the mapping `_requireInvestmentAuthority` consults.
 * The factory is not asked anything here, and the test asserts it is not.
 */
export async function readInvestSnapshot(rpc: RpcClient, vault: Address, accounts: readonly Address[]): Promise<InvestSnapshot> {
  const vaultAddress = vault.toLowerCase() as Address;
  const candidates = accounts.map((account) => account.toLowerCase() as Address);
  const head = asBigInt(await rpc.call<unknown>("eth_blockNumber", []), "eth_blockNumber");
  const tag = numberToHex(head);
  const at = (to: Address, abi: Abi, fn: string, args: readonly unknown[]): Promise<unknown> => readContract(rpc, to, abi, fn, args, tag);

  const [packedRaw, adapterIdRaw, basketHashRaw, limitsRaw, wethRaw, pauseRaw, capRaw, registryRaw, adminRaw, ...accountsRaw] = await Promise.all([
    at(vaultAddress, VAULT_ABI, "extsload", [slotArg(SLOT_INVESTMENT_PACKED)]),
    at(vaultAddress, VAULT_ABI, "extsload", [slotArg(SLOT_ADAPTER_ID)]),
    at(vaultAddress, VAULT_ABI, "extsload", [slotArg(SLOT_BASKET_HASH)]),
    at(vaultAddress, VAULT_ABI, "extsload", [slotArg(SLOT_INVESTMENT_LIMITS)]),
    at(vaultAddress, VAULT_ABI, "extsload", [slotArg(SLOT_WETH)]),
    at(vaultAddress, VAULT_ABI, "extsload", [slotArg(SLOT_PAUSE_CONTROLLER)]),
    at(vaultAddress, VAULT_ABI, "investmentRollingCapStatus", []),
    // FROM THE IMPLEMENTATION, NOT FROM A SLOT: the registry is an immutable of
    // the PersonalVault implementation, and slot 47 now holds the nonce and the
    // flags. Reading it as an address is how a working vault reads as unset.
    at(vaultAddress, VAULT_ABI, "ADAPTER_REGISTRY", []),
    at(vaultAddress, VAULT_ABI, "vaultAdmin", []),
    ...candidates.map((account) => at(vaultAddress, VAULT_ABI, "getTradingAccount", [account])),
  ]);

  const packed = decodeInvestmentPacked(asHex32(packedRaw, "extsload(investment packed)"));
  const limits = decodeInvestmentLimits(asHex32(limitsRaw, "extsload(investment limits)"));
  const adapterId = asHex32(adapterIdRaw, "extsload(adapterId)");
  const weth = slotAddress(asHex32(wethRaw, "extsload(weth)"));
  const pauseController = slotAddress(asHex32(pauseRaw, "extsload(pauseController)"));
  const registry = asAddress(registryRaw, "ADAPTER_REGISTRY");

  const [protocolPausedRaw, adapterRaw, activeRaw, epochRaw, investableWei] = await Promise.all([
    readContract(rpc, pauseController, PAUSE_ABI, "paused", [], tag),
    at(registry, ADAPTER_REGISTRY_ABI, "getAdapter", [adapterId]),
    at(registry, ADAPTER_REGISTRY_ABI, "isAdapterActive", [adapterId]),
    at(registry, ADAPTER_REGISTRY_ABI, "adapterStatusEpoch", [adapterId]),
    erc20BalanceAt(rpc, weth, vaultAddress, head),
  ]);

  return {
    blockL2: head,
    vault: vaultAddress,
    vaultAdmin: asAddress(adminRaw, "vaultAdmin"),
    weth,
    adapterRegistry: registry,
    accounts: candidates.map((address, i) => ({
      address,
      status: asNumber(asRecord(accountsRaw[i], "getTradingAccount")["status"], "getTradingAccount.status"),
    })),
    investableWei,
    policy: {
      enabled: packed.enabled,
      paused: packed.paused,
      protocolPaused: asBool(protocolPausedRaw, "ProtocolPauseController.paused"),
      policyNonce: packed.policyNonce,
      // The shared contract carries the adapter id as a number; the registry is
      // asked with the word itself, which never leaves this file.
      adapterId: hexToBigInt(adapterId),
      basketHash: asHex32(basketHashRaw, "extsload(basketHash)"),
      legs: null,
      minInvestmentWei: limits.minInvestmentWei,
      maxPerCallWei: limits.maxPerCallWei,
      rollingRemainingWei: asBigInt(asRecord(capRaw, "investmentRollingCapStatus")["remaining"], "investmentRollingCapStatus.remaining"),
      wethBalanceWei: investableWei,
    },
    adapter: {
      adapter: asAddress(adapterRaw, "getAdapter"),
      active: asBool(activeRaw, "isAdapterActive"),
      statusEpoch: asBigInt(epochRaw, "adapterStatusEpoch"),
    },
  };
}

/**
 * Who may call `invest()` on this vault, in the pass's own order:
 * `_requireInvestmentAuthority` asked in advance.
 *
 * The admin branch is only ever true for an operator running this by hand — the
 * worker holds no admin key and must never hold one — but leaving it out would
 * make the crank disagree with the contract about who is allowed.
 */
export function authorizedAccounts(snapshot: InvestSnapshot): readonly Address[] {
  return snapshot.accounts
    .filter((account) => account.address === snapshot.vaultAdmin || account.status === ACCOUNT_STATUS_ACTIVE)
    .map((account) => account.address);
}

// ── the basket ──────────────────────────────────────────────────────────────

/**
 * Where the legs come from. The vault stores only the hash, so the array must be
 * recovered from `InvestmentPolicyUpdated`, whose `encodedLegs` are the very
 * bytes the hash was taken over. Behind an interface so the crank is testable
 * without a log query, and so a caller holding its own copy can supply one.
 */
export interface BasketSource {
  /** The legs behind `basketHash` at `policyNonce`, or null when no such emission is found. */
  legsFor(vault: Address, policyNonce: bigint, basketHash: Hex, throughBlock: bigint): Promise<readonly BasketLeg[] | null>;
}

/** Decodes `encodedLegs` and refuses anything that does not hash to what was asked for. */
export function decodeBasketLegs(encodedLegs: Hex, expectedHash: Hex): readonly BasketLeg[] {
  const [decoded] = decodeAbiParameters([BASKET_LEGS_PARAM], encodedLegs);
  const legs: BasketLeg[] = (decoded as readonly { targetAsset: string; weightBps: number; minOutRateWad: bigint }[]).map((leg) => ({
    targetAsset: asAddress(leg.targetAsset, "BasketLeg.targetAsset"),
    weightBps: Number(leg.weightBps),
    minOutRateWad: BigInt(leg.minOutRateWad),
  }));
  // A log is data from the chain like any other. It is trusted here for exactly
  // one reason — it hashes to the value the vault holds — and that reason is
  // checked rather than assumed.
  const hash = basketHashOf(legs);
  if (hash !== expectedHash.toLowerCase()) {
    throw new InvestError(`InvestmentPolicyUpdated legs hash to ${hash}, not the ${expectedHash} the vault holds`);
  }
  return legs;
}

/** The `eth_getLogs` span the rest of the worker uses, and the one Alchemy's free tier caps at. */
export const BASKET_LOG_SPAN = 10_000n;

/**
 * How many spans one pass will walk back before giving up until the next one.
 * The emission being looked for is the CURRENT policy's, so it is normally in
 * the first span; a vault configured long before this worker first saw it is
 * the case this bounds. The search resumes where it stopped, so a cold worker
 * converges over passes instead of scanning a year of history inside one.
 */
export const BASKET_SPANS_PER_PASS = 8;

/**
 * The legs, read backwards from the pass's head off the vault's own
 * `InvestmentPolicyUpdated` log.
 *
 * Filtered on BOTH indexed keys — the policy nonce and the basket hash — so what
 * comes back is the one emission that can be current, not "the latest one we
 * saw", and it is hash-checked before it is ever sent. `getLogs` does the
 * coverage check, because a provider that silently truncates a range must not
 * turn a configured basket into a missing one.
 *
 * BACKWARDS, AND RESUMABLE. The block a vault was configured at is not something
 * this module is told (see this owner's `needs`), so the alternative to walking
 * back from the head is scanning from genesis on every pass. How far it has
 * walked is remembered per (vault, nonce, hash), and all three move together
 * whenever the admin touches the policy, so a stale floor cannot be reused for a
 * basket it was not measured against.
 */
export function logBasketSource(
  rpc: RpcClient,
  options: { readonly fromBlock?: bigint; readonly maxLogSpan?: bigint; readonly spansPerPass?: number } = {},
): BasketSource {
  const floorBlock = options.fromBlock ?? 0n;
  const span = options.maxLogSpan ?? BASKET_LOG_SPAN;
  const spans = options.spansPerPass ?? BASKET_SPANS_PER_PASS;
  const scanned = new Map<string, bigint>();
  return {
    async legsFor(vault, policyNonce, basketHash, throughBlock) {
      const key = `${vault.toLowerCase()}|${policyNonce}|${basketHash.toLowerCase()}`;
      const topics = encodeEventTopics({
        abi: VAULT_ABI,
        eventName: "InvestmentPolicyUpdated",
        args: { policyNonce, basketHash },
      }) as readonly (Hex | readonly Hex[] | null)[];

      let below = scanned.get(key) ?? throughBlock + 1n;
      for (let i = 0; i < spans && below > floorBlock; i += 1) {
        const toBlock = below - 1n;
        const fromBlock = toBlock >= floorBlock + span ? toBlock - span + 1n : floorBlock;
        const logs = await getLogs(rpc, { fromBlock, toBlock, address: vault, topics }, span);
        below = fromBlock;
        scanned.set(key, below);
        // The LAST match wins. `setInvestmentPolicy` bumps the nonce on every
        // call, so two emissions cannot honestly share this filter — but a
        // reorganisation can leave the same one twice, and the later copy is the
        // one the vault's storage came from.
        const last = logs.at(-1);
        if (last === undefined) continue;
        const decoded = decodeEventLog({ abi: VAULT_ABI, data: last.data, topics: [...last.topics] as [Hex, ...Hex[]] });
        const encodedLegs = asRecord(decoded.args, "InvestmentPolicyUpdated.args")["encodedLegs"];
        if (!isHex(encodedLegs)) throw new InvestError(`InvestmentPolicyUpdated at block ${last.blockNumber} carries no encodedLegs`);
        return decodeBasketLegs(encodedLegs, basketHash);
      }
      return null;
    },
  };
}

/**
 * Remembers baskets across passes. Safe because the key is (vault, nonce, hash)
 * and all three move together whenever the admin touches the policy — a stale
 * entry cannot be asked for. Without it, every pass re-reads the vault's log for
 * a value that changes about once a year.
 */
export function cachedBasketSource(inner: BasketSource, store: Map<string, readonly BasketLeg[]> = new Map()): BasketSource {
  return {
    async legsFor(vault, policyNonce, basketHash, throughBlock) {
      const key = `${vault.toLowerCase()}|${policyNonce}|${basketHash.toLowerCase()}`;
      const hit = store.get(key);
      if (hit !== undefined) return hit;
      const legs = await inner.legsFor(vault, policyNonce, basketHash, throughBlock);
      if (legs !== null) store.set(key, legs);
      return legs;
    },
  };
}

/**
 * One basket source per rpc client, kept for the life of the process.
 *
 * The seam carries no config and nowhere to hang state, and both of this
 * module's memories — the legs it found, and how far back it has already looked
 * — are worthless if they die with the pass. Keyed on the client so a test's
 * scripted rpc gets its own, and weakly so nothing here keeps a client alive.
 */
const defaultBaskets = new WeakMap<RpcClient, BasketSource>();

export function defaultBasketSource(rpc: RpcClient): BasketSource {
  const existing = defaultBaskets.get(rpc);
  if (existing !== undefined) return existing;
  const source = cachedBasketSource(logBasketSource(rpc));
  defaultBaskets.set(rpc, source);
  return source;
}

// ── the call ────────────────────────────────────────────────────────────────

/**
 * How long a signed invest stays valid. Long enough to survive a busy mempool,
 * short enough that one stuck behind a nonce dies rather than executing against
 * a price nobody looked at. The same 600 s the attestation's deadline uses.
 */
export const INVEST_DEADLINE_SECONDS = 600n;

/** The estimate is padded before it becomes the limit, exactly as the pull path pads its own. */
const GAS_LIMIT_NUMERATOR = 12n;
const GAS_LIMIT_DENOMINATOR = 10n;

/** The call itself — exactly what a dry run reports, and what a signature is taken over. */
export type InvestCall = Omit<InvestIntent, "nonce" | "rawTx" | "txHash">;

/** The call, its bytes, and the split it implies. */
export interface InvestPlan {
  readonly call: InvestCall;
  readonly data: Hex;
  /** What `invest()` will hand each leg; carried so a dry run can show what each one buys. */
  readonly legAmountsWei: readonly bigint[];
}

/** VALUE IS ZERO. The WETH spent is the vault's; the wallet pays gas and nothing else. */
export function encodeInvestCalldata(call: InvestCall): Hex {
  return encodeFunctionData({
    abi: VAULT_ABI,
    functionName: "invest",
    args: [
      call.legs.map((leg) => ({ targetAsset: leg.targetAsset, weightBps: leg.weightBps, minOutRateWad: leg.minOutRateWad })),
      call.amountInWei,
      call.minAmountsOut,
      call.deadline,
      call.expectedAdapterStatusEpoch,
      call.expectedInvestmentPolicyNonce,
    ],
  });
}

/** The plan a decision implies. Pure, so a dry run reports exactly the bytes a live pass would sign. */
export function planInvestment(
  vault: Address,
  account: Address,
  decision: Extract<InvestDecision, { kind: "invest" }>,
  nowSeconds: bigint,
): InvestPlan {
  const call: InvestCall = {
    vault,
    account,
    amountInWei: decision.grossWei,
    legs: decision.legs,
    minAmountsOut: decision.minAmountsOut,
    deadline: nowSeconds + INVEST_DEADLINE_SECONDS,
    expectedAdapterStatusEpoch: decision.expectedAdapterStatusEpoch,
    expectedInvestmentPolicyNonce: decision.expectedInvestmentPolicyNonce,
  };
  return { call, data: encodeInvestCalldata(call), legAmountsWei: decision.legAmountsWei };
}

/**
 * The intent was journalled and the send failed — which is not "definitely not
 * broadcast": a timeout can hide a transaction that reached the mempool. The
 * caller must not retry blind; the nonce and hash below are what the chain has
 * to be asked about.
 */
export class InvestBroadcastError extends Error {
  readonly intent: InvestIntent;
  constructor(intent: InvestIntent, cause: unknown) {
    super(`eth_sendRawTransaction failed after the invest intent was recorded (nonce ${intent.nonce}, hash ${intent.txHash}); ${describe(cause)}`);
    this.name = "InvestBroadcastError";
    this.intent = intent;
  }
}

/** No secrets in details either: any 64-hex string is masked before it becomes one. */
const redactHex64 = (text: string): string => text.replace(/0x[0-9a-fA-F]{64}|(?<![0-9a-fA-F])[0-9a-fA-F]{64}(?![0-9a-fA-F])/g, "[redacted]");
const describe = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return redactHex64(message).slice(0, 400);
};

const defer = (reason: InvestDeferReason, detail: string): InvestOutcome => ({ kind: "DEFERRED", reason, detail });

/**
 * The chain a transaction is signed for, asked of the node that will broadcast
 * it. Only reached in live mode, and only when the caller did not say: a chain
 * id is not something to default, because signing for the wrong one is either a
 * rejected transaction or — on a chain that shares this wallet — a replayable
 * one.
 */
async function chainIdOf(rpc: RpcClient): Promise<number> {
  return Number(asBigInt(await rpc.call<unknown>("eth_chainId", []), "eth_chainId"));
}

export interface SubmitInvestmentArgs {
  readonly rpc: RpcClient;
  readonly mode: WorkerMode;
  readonly snapshot: InvestSnapshot;
  readonly decision: Extract<InvestDecision, { kind: "invest" }>;
  readonly seat: SeatSigner | null;
  readonly ledger?: Ledger | null;
  /** Seconds, because `deadline` is a uint48 of them. Injected so a test can pin it. */
  readonly nowSeconds: bigint;
}

/**
 * Dry run returns before any signer is touched. Live: seat -> reserve nonce ->
 * estimate -> gas floor -> re-read the policy nonce -> sign -> record -> send.
 */
export async function submitInvestment(args: SubmitInvestmentArgs): Promise<InvestOutcome> {
  const { rpc, snapshot } = args;
  const vault = snapshot.vault;

  // ---- gate 0: authority, decided from the snapshot already in hand. -------
  // Pure, and therefore allowed in front of the mode gate: a dry run that could
  // not say "no wallet of this vault may sign for it" would hide the one thing
  // only the user can fix.
  const candidates = authorizedAccounts(snapshot);
  const [first] = candidates;
  if (first === undefined) {
    return defer("NO_SEATED_ACCOUNT", `no wallet of ${vault} is its admin or an ACTIVE trading account, so nobody may call invest()`);
  }
  const plan = planInvestment(vault, first, args.decision, args.nowSeconds);

  // ---- gate 1: the mode. Before the seat, the nonce or the estimate. --------
  // §0.1: dry run is structural. This is the first statement that could reach
  // the outside world, and it returns instead.
  if (args.mode !== "live") return { kind: "DRY_RUN", intent: plan.call };

  // ---- gate 2: the seat, read fresh. A revoked seat is a fact, not an error. -
  const seat = args.seat;
  if (seat === null) {
    return defer("SIGNER_UNAVAILABLE", "live mode reached submit with no seat signer; refusing rather than guessing");
  }
  // ONE VAULT INVESTS ONCE PER PASS, so a second wallet is asked only when the
  // first cannot SIGN. Everything else this function could answer is the
  // vault's answer, and would be the same for every wallet on it.
  let account: Address | null = null;
  let walletId: string | null = null;
  for (const candidate of candidates) {
    walletId = await seat.walletIdOf(candidate);
    if (walletId !== null) {
      account = candidate;
      break;
    }
  }
  if (account === null || walletId === null) {
    return defer("NO_SEATED_ACCOUNT", `none of the ${candidates.length} wallet(s) authorised on ${vault} still seats this app`);
  }
  const call: InvestCall = { ...plan.call, account };

  // ---- reserve the nonce, price it, and let the node run the whole invest ---
  const nonce = await pendingNonce(rpc, account);
  const fees = await feeQuote(rpc);
  const estimated = await estimatePullGas(rpc, { from: account, to: vault, value: 0n, data: plan.data });
  if (estimated === null) {
    // NO FALLBACK LIMIT, AND NO DEFERRAL EITHER. Every gate this worker models
    // passed, so a node that still says "reverts" is reporting the adapter's own
    // price bound or a state change since the read — neither of which has a name
    // in `InvestDeferReason` (see this owner's `needs`). Filing it under a name
    // that means something else would be worse than raising: the pass logs this
    // as a failure and carries on to the next vault.
    throw new InvestError(
      `eth_estimateGas refused invest(${call.amountInWei} wei) on ${vault} from ${account}; nothing was signed. ` +
        "Every modelled precondition passed, so this is the adapter's own price bound or a state change since the read.",
    );
  }
  const gas = (estimated * GAS_LIMIT_NUMERATOR) / GAS_LIMIT_DENOMINATOR;

  // ---- the gas floor here is the WALLET's, not the contribution's -----------
  // `submitPull` compares the money being moved against the gas, because the
  // money is `msg.value`. Here the vault pays in WETH and the wallet pays in
  // ETH, so an invest can be perfectly fundable and still unsendable. Checked
  // before signing: a signed transaction that cannot pay for itself is a nonce
  // held hostage.
  const maxCostWei = gas * fees.maxFeePerGas;
  const walletBalanceWei = await nativeBalanceAt(rpc, account, snapshot.blockL2);
  if (walletBalanceWei < maxCostWei) {
    return defer("BELOW_GAS_FLOOR", `${account} holds ${walletBalanceWei} wei, under the ${maxCostWei} wei of gas this invest could cost`);
  }

  // ---- last look before the signature --------------------------------------
  // The snapshot is a few round trips old and `invest()` compares the nonce
  // itself, so this turns a revert the user pays for into a deferral that costs
  // one eth_call. It closes no race — the admin can move the policy after this
  // line, and the contract's compare-and-swap is what makes that safe — it just
  // stops the ones already visible. At `latest`, not at the snapshot's height:
  // the whole point is to see a policy the snapshot could not have seen.
  const liveNonce = asBigInt(await readContract(rpc, vault, VAULT_ABI, "investmentPolicyNonce", [], "latest"), "investmentPolicyNonce");
  if (liveNonce !== call.expectedInvestmentPolicyNonce) {
    return defer(
      "POLICY_NONCE_MOVED",
      `investment policy nonce moved ${call.expectedInvestmentPolicyNonce} -> ${liveNonce} between the read and the signature; nothing was signed`,
    );
  }

  const tx: SeatTransaction = {
    to: vault,
    data: plan.data,
    value: 0n,
    nonce,
    gas,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    chainId: await chainIdOf(rpc),
  };

  let rawTx: Hex;
  try {
    rawTx = await seat.signTransaction(walletId, tx);
  } catch (error) {
    return defer("SIGNER_UNAVAILABLE", `seat refused to sign: ${describe(error)}`);
  }
  // The last moment at which "nothing was broadcast" is still true.
  assertSignedMatches(rawTx, tx);

  // The hash of a signed transaction is the keccak of its serialization.
  // Knowing it before the send is the whole point of this ordering.
  const intent: InvestIntent = { ...call, nonce, rawTx, txHash: keccak256(rawTx) };
  // Recorded as SENT because from the next line on it must be assumed to be on
  // the wire; a confirmation pass settles it by receipt.
  await args.ledger?.recordInvestment?.(vault, intent, { kind: "SENT", intent });

  // Everything above this line is reversible. Nothing below it is.
  try {
    await rpc.call<Hex>("eth_sendRawTransaction", [rawTx]);
  } catch (error) {
    throw new InvestBroadcastError(intent, error);
  }
  return { kind: "SENT", intent };
}

export interface InvestCrankArgs {
  readonly rpc: RpcClient;
  readonly mode: WorkerMode;
  readonly vault: Address;
  /** Every wallet the ledger binds to this vault: candidates for who signs, not a list of things to do. */
  readonly accounts: readonly Address[];
  readonly seat: SeatSigner | null;
  readonly ledger?: Ledger | null;
  /** Injected by tests and by a caller holding its own copy; otherwise the vault's own log. */
  readonly basket?: BasketSource;
  readonly nowSeconds: bigint;
  /** The pass's head. The basket is looked for at or below it, never past it. */
  readonly headL2: bigint;
}

/**
 * One pass for one vault: read, decide, and — if the answer is invest — send.
 *
 * THE BASKET IS FETCHED LAST AND ONLY IF NEEDED. Recovering the legs is a log
 * query; a vault that is paused, empty or below its own minimum must not pay for
 * one. So the decision runs first with no basket in hand, and only the single
 * answer that means "everything else says go" — BASKET_UNKNOWN — sends the crank
 * looking.
 */
export async function runInvestCrank(args: InvestCrankArgs): Promise<InvestOutcome> {
  const snapshot = await readInvestSnapshot(args.rpc, args.vault, args.accounts);

  const provisional = decideInvestment({ policy: snapshot.policy, adapter: snapshot.adapter });
  if (provisional.kind === "wait" && provisional.reason !== "BASKET_UNKNOWN") {
    return { kind: "DEFERRED", reason: provisional.reason, ...(provisional.detail === undefined ? {} : { detail: provisional.detail }) };
  }

  // Never past the node's own head: `getLogs` coverage-checks the last block of
  // every chunk, so a range beyond it is an error rather than an empty answer.
  const throughBlock = args.headL2 < snapshot.blockL2 ? args.headL2 : snapshot.blockL2;
  const basket = args.basket ?? defaultBasketSource(args.rpc);
  const legs = await basket.legsFor(snapshot.vault, snapshot.policy.policyNonce, snapshot.policy.basketHash, throughBlock);

  const decision = decideInvestment({ policy: { ...snapshot.policy, legs }, adapter: snapshot.adapter });
  if (decision.kind === "wait") {
    return { kind: "DEFERRED", reason: decision.reason, ...(decision.detail === undefined ? {} : { detail: decision.detail }) };
  }

  return submitInvestment({
    rpc: args.rpc,
    mode: args.mode,
    snapshot,
    decision,
    seat: args.seat,
    ledger: args.ledger,
    nowSeconds: args.nowSeconds,
  });
}

/**
 * `CrankVault` in `src/tick.ts` — the seam, and the only export the pass uses.
 *
 * Positional because the pipeline's other steps are, and because a drift between
 * this signature and the seam's type is then a typecheck error in tick.ts, which
 * is where a pass that cannot invest should fail to build.
 */
export async function crankVault(
  rpc: RpcClient,
  mode: WorkerMode,
  vault: Address,
  accounts: readonly Address[],
  seat: SeatSigner | null,
  ledger: Ledger,
  now: { readonly unixSeconds: bigint; readonly headL2: bigint },
): Promise<InvestOutcome> {
  return runInvestCrank({ rpc, mode, vault, accounts, seat, ledger, nowSeconds: now.unixSeconds, headL2: now.headL2 });
}
