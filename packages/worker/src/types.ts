/**
 * THE CONTRACT BETWEEN MODULES. Every file under src/ imports its types from
 * here and nowhere else, so ten people can build ten modules at once and the
 * seams still meet. Change a type here and every owner sees it in tsc.
 *
 * Money is wei as bigint. Blocks are L2 heights as bigint unless the name says
 * L1. Addresses are lowercase 0x strings.
 */

export type Address = `0x${string}`;
export type Hex = `0x${string}`;

// ── rpc ─────────────────────────────────────────────────────────────────────

export type RpcParams = readonly unknown[];

export interface RpcClient {
  call<T>(method: string, params?: RpcParams): Promise<T>;
}

/** A recorded map of `${method}|${JSON.stringify(params)}` -> result. */
export type Recording = Record<string, unknown>;

// ── chain facts ─────────────────────────────────────────────────────────────

export interface RpcTransaction {
  readonly hash: Hex;
  readonly from: Address;
  readonly to: Address | null;
  readonly value: bigint;
  readonly nonce: number;
  readonly input: Hex;
  readonly transactionIndex: number;
  readonly blockNumber: bigint;
}

export interface RpcLog {
  readonly address: Address;
  readonly topics: readonly Hex[];
  readonly data: Hex;
  readonly blockNumber: bigint;
  readonly transactionHash: Hex;
  readonly logIndex: number;
}

export interface RpcReceipt {
  readonly transactionHash: Hex;
  readonly from: Address;
  readonly to: Address | null;
  readonly status: "success" | "reverted";
  readonly gasUsed: bigint;
  readonly effectiveGasPrice: bigint;
  readonly logs: readonly RpcLog[];
  readonly blockNumber: bigint;
}

export interface TxWithReceipt {
  readonly tx: RpcTransaction;
  readonly receipt: RpcReceipt;
}

// ── wallets and discovery ───────────────────────────────────────────────────

export interface WalletRef {
  readonly address: Address;
  readonly vault: Address;
}

export interface Candidate {
  readonly wallet: Address;
  readonly blockL2: bigint;
  readonly txHash: Hex;
}

export interface DiscoveryResult {
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly candidates: readonly Candidate[];
  /** Wallets whose sent-transaction count in the range did not match the nonce delta: their range must not close. */
  readonly incompleteWallets: readonly Address[];
}

// ── fills ───────────────────────────────────────────────────────────────────

export type Side = "buy" | "sell";

/** Where the notional came from, most trusted first. */
export type FillSource = "venue" | "value" | "residual";

export interface Fill {
  readonly wallet: Address;
  readonly txHash: Hex;
  readonly blockL2: bigint;
  readonly txIndex: number;
  readonly side: Side;
  /** "gmgn", "unknown", ... — the decoder that recognised it, or "unknown". */
  readonly venue: string;
  readonly tokenIn: Address | "native";
  readonly tokenOut: Address | "native";
  /** GROSS cash notional in wei: buys = ETH in (tx.value), sells = ETH out before the venue's fee. */
  readonly notionalWei: bigint;
  readonly feeWei: bigint;
  readonly source: FillSource;
}

export type ExclusionReason = "TOKEN_FOR_TOKEN" | "WETH_WRAP" | "AIRDROP" | "NOT_A_TRADE" | "SELF_TRANSFER" | "REVERTED";

export interface Exclusion {
  readonly wallet: Address;
  readonly txHash: Hex;
  readonly blockL2: bigint;
  readonly reason: ExclusionReason;
}

export type RefusalReason =
  | "MULTI_FILL_BLOCK"
  | "UNEXPLAINED_INFLOW"
  | "WALLET_HAS_CODE"
  | "STATE_UNAVAILABLE"
  | "INCOMPLETE_RANGE"
  | "UNDECODED_SELL";

export interface BlockRefusal {
  readonly wallet: Address;
  readonly blockL2: bigint;
  readonly reason: RefusalReason;
  readonly detail?: string;
}

/** Everything the reconciler needs about one (wallet, block). */
export interface BlockContext {
  readonly wallet: Address;
  readonly blockL2: bigint;
  /** Every transaction in the block with from == wallet or to == wallet, in transactionIndex order. */
  readonly txs: readonly TxWithReceipt[];
  readonly nativeBefore: bigint;
  readonly nativeAfter: bigint;
  readonly wethBefore: bigint;
  readonly wethAfter: bigint;
  /** eth_getCode(wallet) at the block is non-empty (EIP-7702 delegation or a contract). */
  readonly hasCode: boolean;
}

export interface ReconcileOutcome {
  readonly fills: readonly Fill[];
  readonly exclusions: readonly Exclusion[];
  readonly refusal: BlockRefusal | null;
}

export interface VenueFill {
  readonly side: Side;
  readonly venue: string;
  readonly tokenIn: Address | "native";
  readonly tokenOut: Address | "native";
  readonly notionalWei: bigint;
  readonly feeWei: bigint;
}

export interface VenueDecoder {
  readonly name: string;
  /** null when this decoder does not recognise the transaction. */
  decode(entry: TxWithReceipt, wallet: Address): VenueFill | null;
}

// ── windows, attestation, pull ──────────────────────────────────────────────

export interface VolumeWindow {
  readonly wallet: Address;
  readonly vault: Address;
  readonly startL2: bigint;
  readonly endL2: bigint;
  readonly fills: readonly Fill[];
  readonly sumNotionalWei: bigint;
  readonly savingsBps: number;
  readonly owedWei: bigint;
  /** keccak256 over the domain tag and the sorted fill tx hashes; see attest/root.ts. */
  readonly batchRoot: Hex;
}

export interface VaultSnapshot {
  readonly vault: Address;
  readonly account: Address;
  readonly status: number;
  readonly bindingEpoch: bigint;
  readonly policyNonce: bigint;
  readonly settlementNonce: bigint;
  readonly policyHash: Hex;
  readonly adminEpoch: bigint;
  readonly localPauseEpoch: bigint;
  readonly globalPauseEpoch: bigint;
  readonly attesterEpoch: bigint;
  readonly activationBlockL1: bigint;
  readonly savingsBps: number;
  readonly minContributionWei: bigint;
  readonly maxPerSettlementWei: bigint;
  readonly tradingFloorWei: bigint;
  readonly gasReserveWei: bigint;
  readonly accountRollingRemainingWei: bigint;
  readonly aggregateRollingRemainingWei: bigint;
  readonly settlementPaused: boolean;
  readonly protocolPaused: boolean;
  readonly executor: Address;
  readonly frontierEndL2: bigint;
  readonly nativeBalanceWei: bigint;
}

/** The deployed SettlementExecutor's 26-field EIP-712 struct, verbatim. */
export interface SettlementAttestation {
  readonly chainId: bigint;
  readonly vault: Address;
  readonly account: Address;
  readonly executor: Address;
  readonly bindingEpoch: bigint;
  readonly policyNonce: bigint;
  readonly settlementNonce: bigint;
  readonly adminEpoch: bigint;
  readonly localPauseEpoch: bigint;
  readonly globalPauseEpoch: bigint;
  readonly attesterEpoch: bigint;
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
  readonly validAfter: bigint;
  readonly deadline: bigint;
}

export type AttestOutcome =
  | { readonly kind: "SIGNED"; readonly attestation: SettlementAttestation; readonly signature: Hex; readonly contributionWei: bigint }
  | { readonly kind: "DEFERRED"; readonly reason: DeferReason; readonly detail?: string };

export type DeferReason =
  | "NOTHING_COLLECTABLE"
  | "BELOW_MINIMUM"
  | "ACCOUNT_NOT_ACTIVE"
  | "PAUSED"
  | "EXECUTOR_MISMATCH"
  | "ATTESTER_MISMATCH"
  | "L1_NOT_ADVANCED"
  | "DIGEST_MISMATCH";

export interface PullIntent {
  readonly window: VolumeWindow;
  readonly attestation: SettlementAttestation;
  readonly signature: Hex;
  readonly contributionWei: bigint;
  readonly nonce: number;
  readonly rawTx: Hex;
  readonly txHash: Hex;
}

export type PullOutcome =
  | { readonly kind: "DRY_RUN"; readonly intent: Omit<PullIntent, "rawTx" | "txHash" | "nonce"> }
  | { readonly kind: "SENT"; readonly intent: PullIntent }
  | { readonly kind: "SKIPPED"; readonly reason: "SEAT_REVOKED" | "SIGNER_UNAVAILABLE" | "BELOW_GAS_FLOOR"; readonly detail?: string };

// ── investment (the crank) ──────────────────────────────────────────────────
//
// THE HALF THE PRODUCT IS NAMED FOR. The pull leaves WETH in the PersonalVault;
// `PersonalVault.invest()` is what turns it into the assets the user chose, and
// nothing else in this worker calls it. These are the shapes the crank
// (`src/invest/crank.ts`, `src/invest/policy.ts`) and the pass agree on; the
// function seam itself is `CrankVault` in `src/tick.ts`, where the Privy seat
// type already lives.
//
// PER VAULT, NOT PER WALLET. Several trading wallets settle into one vault and
// the vault invests its whole WETH balance once — assessment §4.6.

/** `NuvemTypes.BasketLeg`. Never stored on chain: the vault keeps only `keccak256(abi.encode(legs))`. */
export interface BasketLeg {
  readonly targetAsset: Address;
  readonly weightBps: number;
  /** Adapter output per wei in, scaled by `OUTPUT_RATE_SCALE`: the admin's slippage floor, which a caller may only tighten. */
  readonly minOutRateWad: bigint;
}

/**
 * The investment half of `PersonalVault`'s storage as `invest()` itself reads
 * it, plus the one balance it spends, read in a single pass in the order the
 * function checks them.
 *
 * `legs` IS NOT IN STORAGE. The vault keeps only `basketHash`; the legs it
 * commits to are the bytes `InvestmentPolicyUpdated` emitted, and have to be
 * read back from the vault's own log. `null` is "not in hand", which defers
 * (`BASKET_UNKNOWN`) rather than guessing — the hash is a compare-and-swap, and
 * a guessed basket is a revert at best.
 */
export interface VaultInvestmentPolicy {
  readonly enabled: boolean;
  readonly paused: boolean;
  /** `IProtocolPauseController.paused()` — the vault checks it on every invest. */
  readonly protocolPaused: boolean;
  readonly policyNonce: bigint;
  readonly adapterId: bigint;
  readonly basketHash: Hex;
  readonly legs: readonly BasketLeg[] | null;
  readonly minInvestmentWei: bigint;
  readonly maxPerCallWei: bigint;
  /** `investmentRollingCapStatus().remaining`: cap − spent over the live 30-day window. */
  readonly rollingRemainingWei: bigint;
  /** The vault's WETH: what the pulls put there, and the only thing `invest()` can spend. */
  readonly wethBalanceWei: bigint;
}

export interface InvestIntent {
  readonly vault: Address;
  /** `msg.sender`: the vault admin or an ACTIVE trading account — the worker only ever holds a seat for the latter. */
  readonly account: Address;
  /** `amountIn`: gross WETH this call spends. */
  readonly amountInWei: bigint;
  readonly legs: readonly BasketLeg[];
  /** Per leg, at least the admin's own floor; a caller may only tighten it. */
  readonly minAmountsOut: readonly bigint[];
  readonly deadline: bigint;
  readonly expectedAdapterStatusEpoch: bigint;
  readonly expectedInvestmentPolicyNonce: bigint;
  readonly nonce: number;
  readonly rawTx: Hex;
  readonly txHash: Hex;
}

/**
 * Why a vault is not investing this pass. Every one of them is "later", never
 * "never": the balance grows with the next pull, a pause lifts, a basket is
 * read off the vault's log, a seat comes back.
 *
 * ORDERED AS `invest()` CHECKS THEM, so a deferral and a revert always agree
 * about which thing is wrong first — and named after the gate rather than after
 * the feeling, so nothing has to be folded onto a coarser word on the way out.
 * The last three are the caller's own gates, which the vault never sees.
 */
export type InvestDeferReason =
  /** `investmentEnabled` is false: the admin has not switched investing on. */
  | "DISABLED"
  /** `investmentPaused`: configured, and deliberately stopped. */
  | "PAUSED"
  /** `ProtocolPauseController.paused()`: the whole protocol is stopped. */
  | "PROTOCOL_PAUSED"
  /** Nothing is registered under the vault's `adapterId` — `resolveActiveAdapter` would revert. */
  | "ADAPTER_NOT_REGISTERED"
  /** Registered but deactivated, or its runtime code no longer matches the registry's pin. */
  | "ADAPTER_DEACTIVATED"
  /** The vault holds no WETH: nothing has been pulled in yet. */
  | "NOTHING_TO_INVEST"
  /** The 30-day rolling cap cannot fit even a minimum-sized call until it releases. */
  | "CAP_EXHAUSTED"
  /** There is WETH, but less than the vault's own `minInvestmentWei`. Wait and let it grow. */
  | "BELOW_MINIMUM"
  /** The legs behind the vault's `basketHash` are not in hand, or do not hash to it. */
  | "BASKET_UNKNOWN"
  /** The basket in hand was emitted at a policy nonce the admin has since replaced. */
  | "POLICY_NONCE_MOVED"
  /** A leg's share of this size rounds to zero wei, which `invest()` refuses outright. */
  | "LEG_ROUNDS_TO_ZERO"
  /** None of the vault's bound wallets is an ACTIVE trading account that can sign for it. */
  | "NO_SEATED_ACCOUNT"
  /** Live mode with no seat, or a seat that refused to sign. Nothing was broadcast. */
  | "SIGNER_UNAVAILABLE"
  /** The wallet's native balance would not cover the call's own gas. */
  | "BELOW_GAS_FLOOR";

/** Deliberately the shape of `PullOutcome`: a dry run says what it would have sent, and says it the same way. */
export type InvestOutcome =
  | { readonly kind: "SENT"; readonly intent: InvestIntent }
  | { readonly kind: "DRY_RUN"; readonly intent: Omit<InvestIntent, "rawTx" | "txHash" | "nonce"> }
  | { readonly kind: "DEFERRED"; readonly reason: InvestDeferReason; readonly detail?: string };

// ── ledger ──────────────────────────────────────────────────────────────────

export type WindowStatus = "OPEN" | "SIGNED" | "SUBMITTED" | "CONFIRMED" | "FAILED";

export interface WalletState {
  readonly wallet: Address;
  readonly vault: Address;
  readonly cursorL2: bigint;
  readonly owedTotalWei: bigint;
  readonly collectedTotalWei: bigint;
}

export interface Ledger {
  upsertWallets(wallets: readonly WalletRef[]): Promise<void>;
  walletStates(): Promise<readonly WalletState[]>;
  recordFills(fills: readonly Fill[]): Promise<void>;
  recordExclusions(exclusions: readonly Exclusion[]): Promise<void>;
  recordRefusals(refusals: readonly BlockRefusal[]): Promise<void>;
  advanceCursor(wallet: Address, toL2: bigint): Promise<void>;
  /** Fills at or below `throughL2` that belong to no window yet, oldest first. */
  unwindowedFills(wallet: Address, throughL2: bigint): Promise<readonly Fill[]>;
  openWindow(window: VolumeWindow): Promise<number>;
  markWindow(id: number, status: WindowStatus, detail?: unknown): Promise<void>;
  recordPull(windowId: number, intent: PullIntent | null, outcome: PullOutcome): Promise<void>;
  /**
   * What a vault's crank did with the WETH the pulls put there — recorded
   * BEFORE the broadcast, for the reason `submitPull` records its intent first:
   * a send that times out is not a send that did not happen.
   *
   * OPTIONAL ONLY UNTIL THE LEDGER OWNER LANDS IT. Declared here so the crank
   * has somewhere to write from its first line, optional so declaring it does
   * not red-build two Ledger implementations that have not seen it yet. It
   * should lose the `?` — and gain its `sip_investment` table — in the same
   * change that implements it; see this owner's `needs`.
   */
  recordInvestment?(vault: Address, intent: InvestIntent | null, outcome: InvestOutcome): Promise<void>;
  addOwed(wallet: Address, wei: bigint): Promise<void>;
  addCollected(wallet: Address, wei: bigint): Promise<void>;
  /**
   * Windows in a given status (optionally for one wallet), oldest first, with
   * their fills — so a pass can re-attest what a previous pass persisted but
   * could not collect (a DRY_RUN or SKIPPED pull, a restart mid-flight).
   */
  windowsByStatus(status: WindowStatus, wallet?: Address): Promise<readonly PersistedWindow[]>;
  close(): Promise<void>;
}

export interface PersistedWindow {
  readonly id: number;
  readonly status: WindowStatus;
  readonly window: VolumeWindow;
  /** Whatever markWindow last stored — for a SIGNED window, the contribution it committed to. */
  readonly detail: unknown;
}

// ── config ──────────────────────────────────────────────────────────────────

export type WorkerMode = "dry-run" | "live";

export interface WorkerConfig {
  readonly mode: WorkerMode;
  readonly chainId: number;
  readonly rpcUrls: readonly string[];
  readonly factory: Address;
  readonly executor: Address;
  readonly logsFromBlock: bigint;
  readonly databaseUrl: string | null;
  readonly pollMs: number;
  readonly finalityMarginL2: bigint;
  readonly maxLogSpan: bigint;
  /** Only in live mode; never logged. */
  readonly attesterPrivateKey: Hex | null;
  readonly privy: { readonly appId: string; readonly appSecret: string; readonly authorizationPrivateKey: string } | null;
}
