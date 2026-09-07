// The loop: one pass over every bound wallet, and the schedule that runs the passes.
//
// A PASS (`runTick`) is DESIGN.md §6 in order: where the chain is, who the
// worker is responsible for, what each of them did behind the finality margin,
// which of it can be closed into a window, and — through the attester and the
// wallet's own Privy seat — what can be pulled into the vault right now. The
// summary it returns is the whole truth of the pass in eight numbers: `tick`
// prints it and exits; `run` prints one heartbeat line per pass and never lets
// two passes overlap (`skipWhileRunning`, ported from keeper-old).
//
// TWO THINGS ARE NOT WHERE §6 PUTS THEM, for structural reasons:
//
// 1. THE SCAN STOPS AT THE FINALITY MARGIN, not at the head. §6 scans
//    (cursor, head] and lets §4 hold the newest blocks back at window time. But
//    a fill recorded from inside the margin survives a reorg in the ledger —
//    its row is keyed by tx hash and nothing ever deletes it — and it would be
//    attested the moment the margin passed its block. That is fabricated
//    volume, the one unforgivable output. Nothing is lost by waiting: the margin
//    is re-scanned on the next pass, and 64 L2 blocks is ~9 s of chain against
//    passes minutes apart.
//
// 2. A WINDOW IS PERSISTED ONLY ONCE IT IS SIGNED. §6 opens the window first
//    and marks it OPEN again on a deferred attestation. The frozen Ledger has no
//    way to list windows, so a window opened and then deferred could never be
//    revisited: its fills would be windowed — `unwindowedFills` stops returning
//    them — and no pass would ever pull them. Until the ledger can list OPEN
//    windows, a pass keeps the candidate window in memory, attests it, and only
//    then calls `openWindow`; a deferred or sub-minimum window is rebuilt,
//    larger, on the next pass from the same unwindowed fills. Owed volume is
//    never lost: it sits in sip_fill until a window takes it.
//
// The cursor is therefore "reconciled and clean through", not "windowed
// through": it advances over every range that produced no refusal and no
// incomplete scan, whether or not a window closed. A window's startL2 is the
// block of its earliest fill — always above the last window's endL2, because
// that window took every fill at or below it — and its endL2 is the cursor.
//
// REFUSE RATHER THAN GUESS runs through the pass too: a block whose context
// cannot be read is a STATE_UNAVAILABLE refusal, not a skipped block; a wallet
// whose live vault disagrees with the ledger's is deferred, not attested
// against either; a reconciler that returns fills alongside a refusal has its
// fills dropped, because §3.5 says a refusal voids them.

import { attestPhase0 as attestPhase0Real } from "./attest/phase0.js";
import type { AttesterSigner } from "./attest/phase0.js";
import { batchRoot as batchRootReal } from "./attest/root.js";
import { readVaultSnapshot as readVaultSnapshotReal } from "./attest/snapshot.js";
import { blockNumber as blockNumberReal, l1BlockOf as l1BlockOfReal } from "./chain/reads.js";
import { LedgerConnectionLostError } from "./ledger/pg.js";
import type { Logger } from "./log.js";
import { StateUnavailableError, buildBlockContext as buildBlockContextReal } from "./observe/context.js";
import { discover as discoverReal, discoverLinkedWallets as discoverLinkedWalletsReal, nextScanFrom } from "./observe/discover.js";
import { reconcileBlock as reconcileBlockReal } from "./observe/reconcile.js";
import { VENUES } from "./observe/venues/index.js";
import type { SeatSigner } from "./pull/privy.js";
import { PullBroadcastError, submitPull as submitPullReal } from "./pull/submit.js";
import { isEndpointFault } from "./rpc/failover.js";
import type {
  Address,
  AttestOutcome,
  BlockContext,
  BlockRefusal,
  DiscoveryResult,
  Fill,
  Hex,
  Ledger,
  PullOutcome,
  ReconcileOutcome,
  RpcClient,
  SettlementAttestation,
  VaultSnapshot,
  VenueDecoder,
  VolumeWindow,
  WalletRef,
  WalletState,
  WorkerConfig,
  WorkerMode,
} from "./types.js";

export interface TickSummary {
  readonly headL2: bigint;
  readonly wallets: number;
  readonly fills: number;
  readonly exclusions: number;
  readonly refusals: number;
  readonly windowsOpened: number;
  readonly pulls: number;
  readonly deferred: number;
}

/** What a pass needs from the process: the chain, the ledger, the config, a logger, and the two signers (null in dry run). */
export interface TickDeps {
  readonly rpc: RpcClient;
  readonly ledger: Ledger;
  readonly config: WorkerConfig;
  readonly log: Logger;
  readonly attester: AttesterSigner | null;
  readonly seat: SeatSigner | null;
}

export interface BlockRange {
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
}

/**
 * The module functions a pass is wired to. The defaults are the real modules;
 * tests replace the ones whose owners are still building, and the loop is
 * tested as a loop rather than as a re-run of every other owner's tests.
 */
export interface TickPipeline {
  readonly blockNumber: (rpc: RpcClient) => Promise<bigint>;
  readonly discoverLinkedWallets: (
    rpc: RpcClient,
    factory: Address,
    range: BlockRange,
    options: { maxLogSpan: bigint },
  ) => Promise<readonly WalletRef[]>;
  readonly discover: (
    rpc: RpcClient,
    wallets: readonly WalletRef[],
    range: BlockRange,
    options: { maxLogSpan: bigint },
  ) => Promise<DiscoveryResult>;
  readonly buildBlockContext: (rpc: RpcClient, wallet: Address, blockL2: bigint) => Promise<BlockContext>;
  readonly reconcileBlock: (context: BlockContext, venues: readonly VenueDecoder[]) => ReconcileOutcome;
  readonly venues: readonly VenueDecoder[];
  readonly batchRoot: (chainId: number, wallet: Address, fills: readonly Fill[]) => Hex;
  readonly readVaultSnapshot: (rpc: RpcClient, factory: Address, executor: Address, account: Address) => Promise<VaultSnapshot>;
  readonly attestPhase0: (
    rpc: RpcClient,
    executor: Address,
    window: VolumeWindow,
    snapshot: VaultSnapshot,
    signer: AttesterSigner,
    now: { unixSeconds: bigint; headL2: bigint },
  ) => Promise<AttestOutcome>;
  readonly submitPull: (
    rpc: RpcClient,
    mode: WorkerMode,
    executor: Address,
    window: VolumeWindow,
    attestation: SettlementAttestation,
    signature: Hex,
    contributionWei: bigint,
    seat: SeatSigner | null,
    ledger: Ledger,
    windowId: number,
  ) => Promise<PullOutcome>;
  /** The pull's gas floor in wei: what `owedWei` must reach before a window is worth persisting (§4). */
  readonly pullGasFloorWei: (rpc: RpcClient) => Promise<bigint>;
  /** The L1 height an L2 block was posted at: the space the vault's activation floor is measured in. */
  readonly l1BlockOf: (rpc: RpcClient, blockL2: bigint) => Promise<bigint>;
  /** Wall clock in unix seconds; injected so a test can pin the attestation's validity window. */
  readonly unixSeconds: () => bigint;
}

/**
 * Where the factory-log scan last finished, carried from pass to pass by the
 * loop. The frozen Ledger has no column for it, and without it every pass
 * would replay the factory's whole history — thousands of capped getLogs
 * calls — to learn nothing new. A single `tick` has no previous pass and scans
 * from `config.logsFromBlock`, the operator's stated floor.
 * (keeper-old/src/discovery.ts, nextScanFrom: the watermark with rescan overlap)
 */
export interface FactoryScanState {
  scannedTo: bigint | null;
}

/**
 * When each refusal was first RECORDED, as the L2 head of the pass that
 * recorded it, keyed `wallet|blockL2` and carried from pass to pass by the loop.
 *
 * THE AGE OF THE REFUSAL, NOT THE AGE OF THE BLOCK. The retention below exists
 * to stop the fills after a block nobody can read from waiting forever; it must
 * therefore start when the block was first tried. Measured from the block's own
 * height, a catch-up longer than the retention — a worker down for a day, a new
 * wallet's backlog — steps over every refused block on the first pass that sees
 * it, with zero retries, which is the one thing the retry was for.
 *
 * A restart empties it, so a refusal older than the process is retried for one
 * more retention window. That errs towards reading the block again, never
 * towards stepping over one that was never retried.
 */
export type RefusalAges = Map<string, bigint>;

export interface TickOptions extends Partial<TickPipeline> {
  readonly factoryScan?: FactoryScanState;
  readonly refusalAges?: RefusalAges;
}

/**
 * Gas one Phase 0 pull costs on the deployed SettlementExecutor, measured in
 * the assessment (§4.4: ≈516k). The pull module estimates for real before it
 * signs; this constant only keeps a window from being persisted when even its
 * whole owed amount could not cover ~2× that gas.
 */
export const PHASE0_PULL_GAS = 516_000n;

/**
 * How long a refusal keeps the cursor from stepping over its block, in L2
 * blocks (~1 day at ~7 blocks/s) counted from the pass that first recorded it
 * (`RefusalAges`). Inside it the block is retried every pass — state reads may
 * succeed later. Past it the refusal stays recorded, the block is never
 * attested, and the fills after it stop waiting (§3.5).
 */
export const REFUSAL_RETENTION_L2 = 604_800n;

/** The default gas floor: `2 × PHASE0_PULL_GAS × eth_gasPrice`, the same ~2× rule the pull module applies to its estimate. */
export async function pullGasFloorWei(rpc: RpcClient): Promise<bigint> {
  const raw = await rpc.call<unknown>("eth_gasPrice", []);
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]+$/.test(raw)) throw new Error(`eth_gasPrice: expected a hex quantity, got ${JSON.stringify(raw)}`);
  return 2n * PHASE0_PULL_GAS * BigInt(raw);
}

const DEFAULT_PIPELINE: TickPipeline = {
  blockNumber: blockNumberReal,
  discoverLinkedWallets: discoverLinkedWalletsReal,
  discover: discoverReal,
  buildBlockContext: buildBlockContextReal,
  reconcileBlock: reconcileBlockReal,
  venues: VENUES,
  batchRoot: batchRootReal,
  readVaultSnapshot: readVaultSnapshotReal,
  attestPhase0: attestPhase0Real,
  submitPull: submitPullReal,
  pullGasFloorWei,
  l1BlockOf: l1BlockOfReal,
  unixSeconds: () => BigInt(Math.floor(Date.now() / 1000)),
};

const lower = (address: string): Address => address.toLowerCase() as Address;

/** Overrides merge by presence, not by key: a spread that carries `undefined` must not erase a real module. */
function withDefaults(defaults: TickPipeline, overrides: Partial<TickPipeline>): TickPipeline {
  const merged: Record<string, unknown> = { ...defaults };
  for (const [key, value] of Object.entries(overrides)) if (value !== undefined) merged[key] = value;
  return merged as unknown as TickPipeline;
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const compareBigint = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0);

const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/** One pass: discover linked wallets -> discover candidates -> reconcile per block -> close windows behind the margin -> attest -> pull. */
export async function runTick(deps: TickDeps, options: TickOptions = {}): Promise<TickSummary> {
  const { factoryScan, refusalAges, ...overrides } = options;
  const p = withDefaults(DEFAULT_PIPELINE, overrides);
  const { rpc, ledger, config, log } = deps;

  // ---- 1. where the chain is, and the line nothing above may cross ----------
  const headL2 = await p.blockNumber(rpc);
  const closeAt = headL2 > config.finalityMarginL2 ? headL2 - config.finalityMarginL2 : 0n;

  // ---- 2. who: the chain's list, joined with everyone the ledger already knows
  const scanFrom =
    factoryScan === undefined
      ? config.logsFromBlock
      : nextScanFrom({ deployedAt: config.logsFromBlock, scannedTo: factoryScan.scannedTo, rescan: config.finalityMarginL2 });
  const linked = await p.discoverLinkedWallets(rpc, config.factory, { fromBlock: scanFrom, toBlock: headL2 }, { maxLogSpan: config.maxLogSpan });
  if (factoryScan !== undefined) factoryScan.scannedTo = headL2;
  await ledger.upsertWallets(linked);
  const states = await ledger.walletStates();

  // A wallet the ledger has never advanced starts at the close line, not at
  // genesis: scanning from block 0 is not feasible (the public RPC prunes at
  // ~10k blocks and N−1 balances are archive past 128), and volume from before
  // the worker first watched a wallet is NOT observed rather than guessed at.
  const cursors = new Map<Address, bigint>();
  for (const state of states) {
    const wallet = lower(state.wallet);
    let cursor = state.cursorL2;
    if (cursor === 0n && closeAt > 0n) {
      cursor = closeAt;
      await ledger.advanceCursor(wallet, closeAt);
      log.info("wallet.bootstrap", { wallet, cursorL2: closeAt });
    }
    cursors.set(wallet, cursor);
  }
  const cursorOf = (wallet: Address): bigint => cursors.get(wallet) ?? closeAt;

  // ---- 3. what: scan (min cursor, closeAt] once for all wallets, chunked -----
  const scan = new PassScan(deps, p, cursors, closeAt, headL2, refusalAges ?? new Map());
  const behind = states.filter((state) => cursorOf(lower(state.wallet)) < closeAt);
  if (behind.length > 0) {
    let from = behind.map((state) => cursorOf(lower(state.wallet))).reduce(min) + 1n;
    // "Cap the span; if behind, chunk and loop within the tick" (§6). One chunk
    // is one provider-sized getLogs range, so a truncated read flags one chunk
    // of one wallet rather than a day of everyone.
    while (from <= closeAt) {
      const to = min(from + config.maxLogSpan - 1n, closeAt);
      const inChunk = behind.filter((state) => cursorOf(lower(state.wallet)) < to);
      await scan.chunk(inChunk, { fromBlock: from, toBlock: to });
      from = to + 1n;
    }
  }

  // ---- 4. per wallet: the close line, the cursor, the window, the pull ------
  const closer = new WindowCloser(deps, p, headL2);
  for (const state of states) {
    const wallet = lower(state.wallet);
    const cursor = cursorOf(wallet);

    // THE CURSOR DECIDES WHAT IS NEW; IT DOES NOT DECIDE WHETHER TO CLOSE. A
    // wallet with nothing new still owes whatever a previous pass persisted and
    // could not collect, so `closeTo` falls back to the cursor and the closer
    // runs anyway — that window is the common case after a dry run.
    let closeTo = cursor;
    if (cursor < closeAt) {
      const vouched = scan.cleanThrough(wallet, closeAt);
      if (vouched === null) {
        log.warn("wallet.incomplete", { wallet, cursorL2: cursor, detail: "the scan could not vouch for this wallet's range; it stays open" });
      } else {
        // A refusal inside the range holds the line at the block before it, so the
        // fills after it wait (§4) — until the refusal has been retried for a
        // whole retention window. Its age is counted from the pass that first
        // recorded it, so a long catch-up cannot skip a block on sight.
        const holding = scan
          .refusedBlocks(wallet)
          .filter((block) => block > cursor && block <= vouched && headL2 - scan.refusedSince(wallet, block) <= REFUSAL_RETENTION_L2);
        const first = holding.sort(compareBigint).at(0);
        const candidate = first === undefined ? vouched : first - 1n;
        if (candidate > cursor) {
          await ledger.advanceCursor(wallet, candidate);
          cursors.set(wallet, candidate);
          closeTo = candidate;
        }
      }
    }

    try {
      await closer.close(state, wallet, closeTo);
    } catch (error) {
      // One wallet's failure is one wallet's failure: the others still get
      // their pass (keeper-old AccountRunner contained faults per account).
      closer.deferred += 1;
      log.error("wallet.failed", { wallet, detail: describe(error) });
    }
  }

  return {
    headL2,
    wallets: states.length,
    fills: scan.fills,
    exclusions: scan.exclusions,
    refusals: scan.refusals,
    windowsOpened: closer.windowsOpened,
    pulls: closer.pulls,
    deferred: closer.deferred,
  };
}

/** Step 3 of a pass: discovery and reconciliation over the chunks, and what each wallet's range can vouch for. */
class PassScan {
  fills = 0;
  exclusions = 0;
  refusals = 0;
  /** wallet -> end of the last chunk in a row (from its cursor) that discovery vouched for. */
  private readonly vouchedThrough = new Map<Address, bigint>();
  /** Wallets that came back incomplete in some chunk: later chunks cannot extend their vouched range. */
  private readonly broken = new Set<Address>();
  private readonly refused = new Map<Address, bigint[]>();
  /** wallet -> blocks that already hold a recorded, unwindowed fill: explained on a previous pass, not read again. */
  private readonly explained = new Map<Address, Promise<ReadonlySet<bigint>>>();

  constructor(
    private readonly deps: TickDeps,
    private readonly p: TickPipeline,
    private readonly cursors: ReadonlyMap<Address, bigint>,
    private readonly closeAt: bigint,
    private readonly headL2: bigint,
    private readonly ages: RefusalAges,
  ) {}

  async chunk(states: readonly WalletState[], range: BlockRange): Promise<void> {
    const { rpc, config, log } = this.deps;
    const refs: WalletRef[] = states.map((state) => ({ address: lower(state.wallet), vault: lower(state.vault) }));
    const found = await this.p.discover(rpc, refs, range, { maxLogSpan: config.maxLogSpan });

    const incomplete = new Set(found.incompleteWallets.map(lower));
    for (const ref of refs) {
      if (incomplete.has(ref.address)) this.broken.add(ref.address);
      else if (!this.broken.has(ref.address)) this.vouchedThrough.set(ref.address, range.toBlock);
    }

    // Candidates are per tx; the reconciler is per (wallet, block). Blocks at
    // or below a wallet's cursor were closed on an earlier pass.
    const blocks = new Map<string, { wallet: Address; blockL2: bigint }>();
    for (const candidate of found.candidates) {
      const wallet = lower(candidate.wallet);
      const cursor = this.cursors.get(wallet);
      if (cursor === undefined || candidate.blockL2 <= cursor || candidate.blockL2 > this.closeAt) continue;
      blocks.set(`${wallet}|${candidate.blockL2}`, { wallet, blockL2: candidate.blockL2 });
    }
    const ordered = [...blocks.values()].sort((a, b) => a.wallet.localeCompare(b.wallet) || compareBigint(a.blockL2, b.blockL2));
    for (const { wallet, blockL2 } of ordered) {
      if ((await this.explainedBlocks(wallet)).has(blockL2)) continue;
      await this.reconcile(wallet, blockL2);
    }
    log.info("scan.chunk", {
      fromBlock: range.fromBlock,
      toBlock: range.toBlock,
      wallets: refs.length,
      candidates: found.candidates.length,
      blocks: ordered.length,
      incomplete: found.incompleteWallets.length,
    });
  }

  private explainedBlocks(wallet: Address): Promise<ReadonlySet<bigint>> {
    let known = this.explained.get(wallet);
    if (known === undefined) {
      known = this.deps.ledger.unwindowedFills(wallet, this.closeAt).then((fills) => new Set(fills.map((fill) => fill.blockL2)));
      this.explained.set(wallet, known);
    }
    return known;
  }

  private async reconcile(wallet: Address, blockL2: bigint): Promise<void> {
    const { rpc, ledger, log } = this.deps;
    let outcome: ReconcileOutcome;
    try {
      const context = await this.p.buildBlockContext(rpc, wallet, blockL2);
      outcome = this.p.reconcileBlock(context, this.p.venues);
    } catch (error) {
      // A block whose state cannot be read is refused and retried, never
      // skipped: skipping it would close a window over a fill nobody saw. That
      // is what StateUnavailableError and an endpoint that could not answer
      // mean, and ONLY those: any other exception is a bug in this worker, and
      // dressing it as a refusal would retry it in silence for as long as the
      // bug lives. It ends the pass instead, loudly, naming the block.
      if (!(error instanceof StateUnavailableError) && !isEndpointFault(error)) {
        log.error("block.reconcile_failed", { wallet, blockL2, detail: describe(error) });
        throw error;
      }
      const refusal: BlockRefusal = { wallet, blockL2, reason: "STATE_UNAVAILABLE", detail: describe(error) };
      outcome = { fills: [], exclusions: [], refusal };
    }

    if (outcome.refusal !== null) {
      // §3.5: a refusal voids every fill of the (wallet, block). Enforced here
      // as well as trusted, so a reconciler that returns both cannot leak one.
      await ledger.recordRefusals([outcome.refusal]);
      this.refusals += 1;
      const list = this.refused.get(wallet) ?? [];
      list.push(blockL2);
      this.refused.set(wallet, list);
      const key = `${wallet}|${blockL2}`;
      if (!this.ages.has(key)) this.ages.set(key, this.headL2);
      log.warn("block.refused", { wallet, blockL2, reason: outcome.refusal.reason, detail: outcome.refusal.detail ?? null, headL2: this.headL2 });
      return;
    }
    if (outcome.fills.length > 0) {
      await ledger.recordFills(outcome.fills);
      this.fills += outcome.fills.length;
      for (const fill of outcome.fills) {
        log.info("block.fill", {
          wallet,
          blockL2,
          txHash: fill.txHash,
          side: fill.side,
          venue: fill.venue,
          source: fill.source,
          notionalWei: fill.notionalWei,
          feeWei: fill.feeWei,
        });
      }
    }
    if (outcome.exclusions.length > 0) {
      await ledger.recordExclusions(outcome.exclusions);
      this.exclusions += outcome.exclusions.length;
    }
  }

  /** The highest block this pass can close for `wallet`, or null when no chunk of its range could be vouched for. */
  cleanThrough(wallet: Address, closeAt: bigint): bigint | null {
    if (!this.broken.has(wallet)) return closeAt;
    const vouched = this.vouchedThrough.get(wallet);
    return vouched === undefined ? null : min(vouched, closeAt);
  }

  refusedBlocks(wallet: Address): readonly bigint[] {
    return this.refused.get(wallet) ?? [];
  }

  /** The L2 head of the pass that first refused this block — this pass, for one refused just now. */
  refusedSince(wallet: Address, blockL2: bigint): bigint {
    return this.ages.get(`${wallet}|${blockL2}`) ?? this.headL2;
  }
}

/** Step 4 of a pass, for one wallet: the window behind the margin, the attestation, the pull. */
class WindowCloser {
  windowsOpened = 0;
  pulls = 0;
  deferred = 0;

  /** L2 -> L1 heights read this pass; the activation floor is the only reason to ask, and it asks per fill. */
  private readonly l1Heights = new Map<bigint, Promise<bigint>>();

  constructor(
    private readonly deps: TickDeps,
    private readonly p: TickPipeline,
    private readonly headL2: bigint,
  ) {}

  private l1Of(blockL2: bigint): Promise<bigint> {
    let height = this.l1Heights.get(blockL2);
    if (height === undefined) {
      height = this.p.l1BlockOf(this.deps.rpc, blockL2);
      this.l1Heights.set(blockL2, height);
    }
    return height;
  }

  /**
   * THE ACTIVATION FLOOR IS THE OTHER END OF THE FRONTIER, and the one that
   * moves backwards under the account. The executor requires
   * `startBlock >= activationBlock` in L1 space, and an admin pause and unpause
   * (or a re-link) sets `activationBlock` to the L1 height of that moment: every
   * fill already recorded is suddenly below it. Kept as they are, those fills
   * rebuild the same window every pass, the attester defers it every pass with
   * L1_NOT_ADVANCED, and that wallet never skims again — an admin action the
   * user cannot see would quietly end their savings.
   *
   * `activationBlockL1 === 0n` is "no floor": nothing to ask the chain about.
   */
  private async collectable(fills: readonly Fill[], snapshot: VaultSnapshot): Promise<readonly Fill[]> {
    if (snapshot.activationBlockL1 === 0n || fills.length === 0) return fills;
    // L1 heights rise with L2 heights, so the earliest fill answers for all of them in the common case.
    const earliest = fills.map((fill) => fill.blockL2).reduce(min);
    if ((await this.l1Of(earliest)) >= snapshot.activationBlockL1) return fills;
    const kept: Fill[] = [];
    for (const fill of fills) if ((await this.l1Of(fill.blockL2)) >= snapshot.activationBlockL1) kept.push(fill);
    return kept;
  }

  /** A persisted window the floor has risen past: no signature of it can ever settle. */
  private async belowActivation(window: VolumeWindow, snapshot: VaultSnapshot): Promise<boolean> {
    if (snapshot.activationBlockL1 === 0n) return false;
    return (await this.l1Of(window.startL2)) < snapshot.activationBlockL1;
  }

  async close(state: WalletState, wallet: Address, closeTo: bigint): Promise<void> {
    const { rpc, ledger, config, log } = this.deps;
    // A WINDOW THIS WORKER ALREADY PERSISTED COMES FIRST. Its fills are already
    // windowed, so unwindowedFills cannot see them: a dry run, a skipped pull, a
    // crash between the signature and the send would strand that volume forever.
    const pending = [
      ...(await ledger.windowsByStatus("SIGNED", wallet)),
      ...(await ledger.windowsByStatus("SUBMITTED", wallet)),
      ...(await ledger.windowsByStatus("OPEN", wallet)),
    ].sort((a, b) => a.id - b.id);
    const unwindowed = await ledger.unwindowedFills(wallet, closeTo);
    if (pending.length === 0 && unwindowed.length === 0) return;

    // The snapshot is read once and used for the whole wallet: the rate and the
    // minimum decide the window, the epochs and nonces go into the attestation,
    // and §5 wants them from the same pass.
    const snapshot = await this.p.readVaultSnapshot(rpc, config.factory, config.executor, wallet);
    const vault = lower(state.vault);
    if (lower(snapshot.vault) !== vault) {
      // The ledger's binding and the chain's disagree. Attesting against either
      // would be a guess; the next pass re-links from the factory's logs.
      this.deferred += 1;
      log.warn("wallet.vault_mismatch", { wallet, ledgerVault: vault, chainVault: lower(snapshot.vault) });
      return;
    }

    // THE CHAIN SAYS WHETHER A PULL LANDED, not our own record of having sent
    // one: Phase 0 advances the vault's settled frontier on every settle, so a
    // pending window at or below it was collected. Anything else is retried,
    // and a retry that would double-pull is refused by the vault's own
    // sessionId novelty and settlementNonce, not by us guessing.
    let retried = false;
    for (const entry of pending) {
      if (snapshot.frontierEndL2 >= entry.window.endL2) {
        const collected = contributionOf(entry.detail) ?? entry.window.owedWei;
        await ledger.markWindow(entry.id, "CONFIRMED", { frontierEndL2: snapshot.frontierEndL2, collectedWei: collected });
        await ledger.addCollected(wallet, collected);
        this.pulls += 1;
        log.info("pull.confirmed", { wallet, windowId: entry.id, endL2: entry.window.endL2, collectedWei: collected });
        continue;
      }
      if (await this.belowActivation(entry.window, snapshot)) {
        // Not deferred and not retried: the vault can never accept this range,
        // so it is closed FAILED — its fills stay tagged to it, out of the way —
        // and the pass goes on to open a window above the floor. Left OPEN it
        // would be re-attested, and refused, on every pass from here on.
        await ledger.markWindow(entry.id, "FAILED", {
          activationBlockL1: snapshot.activationBlockL1,
          detail: "the account's activation floor rose above this window's start; no attestation of it can settle",
        });
        log.warn("window.void_below_activation", {
          wallet,
          windowId: entry.id,
          startL2: entry.window.startL2,
          endL2: entry.window.endL2,
          activationBlockL1: snapshot.activationBlockL1,
          owedWei: entry.window.owedWei,
        });
        continue;
      }
      retried = true;
      await this.attestAndPull(entry.window, snapshot, entry.id);
    }
    // One attestation is in flight per account (§5's settlementNonce), so a
    // pass that just re-pulled does not also open a new window; the next one will.
    if (retried || unwindowed.length === 0) return;

    // Phase 0's frontier is strict: a fill at or below the vault's last
    // settled endBlockL2 can never be attested by the deployed executor
    // (assessment §4.4). It is left unwindowed — visible, never faked into a
    // later range — and Phase 1's synthetic frontier will take it.
    const above = unwindowed.filter((fill) => fill.blockL2 > snapshot.frontierEndL2);
    if (above.length < unwindowed.length) {
      log.warn("window.below_frontier", { wallet, frontierEndL2: snapshot.frontierEndL2, fills: unwindowed.length - above.length });
    }
    if (above.length === 0) return;

    // And the floor at the other end (see `collectable`): fills the vault can
    // never accept are left out of the window rather than holding it back.
    const fills = await this.collectable(above, snapshot);
    if (fills.length < above.length) {
      log.warn("window.below_activation", {
        wallet,
        activationBlockL1: snapshot.activationBlockL1,
        fills: above.length - fills.length,
        detail: "these fills predate the account's activation block, so the executor could never settle a window holding them",
      });
    }
    if (fills.length === 0) return;

    const sumNotionalWei = fills.reduce((sum, fill) => sum + fill.notionalWei, 0n);
    const owedWei = (sumNotionalWei * BigInt(snapshot.savingsBps)) / 10_000n;
    const startL2 = fills.map((fill) => fill.blockL2).reduce(min);
    const window: VolumeWindow = {
      wallet,
      vault,
      startL2,
      endL2: closeTo,
      fills,
      sumNotionalWei,
      savingsBps: snapshot.savingsBps,
      owedWei,
      batchRoot: this.p.batchRoot(config.chainId, wallet, fills),
    };
    const amounts = { wallet, vault, startL2, endL2: closeTo, fills: fills.length, sumNotionalWei, owedWei, savingsBps: snapshot.savingsBps };

    // §4's minimum window: below the account's minimum or the pull's gas floor
    // the window is not persisted; it grows on the next pass.
    if (owedWei < snapshot.minContributionWei) {
      this.deferred += 1;
      log.info("window.growing", { ...amounts, reason: "BELOW_MINIMUM", minContributionWei: snapshot.minContributionWei });
      return;
    }
    const gasFloorWei = await this.p.pullGasFloorWei(rpc);
    if (owedWei < gasFloorWei) {
      this.deferred += 1;
      log.info("window.growing", { ...amounts, reason: "BELOW_GAS_FLOOR", gasFloorWei });
      return;
    }
    if (this.deps.attester === null) {
      // keeper-old keeper.ts: "BLOCKED — no attester signer is loaded". The
      // window stays in memory; nothing is persisted that cannot be attested.
      this.deferred += 1;
      log.warn("attest.blocked", { ...amounts, detail: "no attester signer is loaded" });
      return;
    }

    await this.attestAndPull(window, snapshot, null);
  }

  /**
   * Attest a window and pull it. `windowId` is null for a window that does not
   * exist in the ledger yet — it is persisted only once the attestation is
   * signed, so nothing that cannot be attested ever takes fills out of
   * circulation — and non-null when a previous pass persisted it and this one
   * is retrying.
   */
  private async attestAndPull(window: VolumeWindow, snapshot: VaultSnapshot, windowId: number | null): Promise<void> {
    const { rpc, ledger, config, log } = this.deps;
    const { wallet, owedWei, sumNotionalWei, startL2, endL2, fills, vault, savingsBps } = window;
    const amounts = { wallet, vault, startL2, endL2, fills: fills.length, sumNotionalWei, owedWei, savingsBps };
    if (this.deps.attester === null) {
      this.deferred += 1;
      log.warn("attest.blocked", { ...amounts, detail: "no attester signer is loaded" });
      return;
    }

    const attested = await this.p.attestPhase0(rpc, config.executor, window, snapshot, this.deps.attester, {
      unixSeconds: this.p.unixSeconds(),
      headL2: this.headL2,
    });
    if (attested.kind === "DEFERRED") {
      this.deferred += 1;
      log.info("attest.deferred", { ...amounts, windowId, reason: attested.reason, detail: attested.detail ?? null });
      return;
    }

    // Signed: now, and only now, the window exists in the ledger and the owed
    // amount is on the wallet's account. The fills it took are windowed.
    let id = windowId;
    if (id === null) {
      id = await ledger.openWindow(window);
      this.windowsOpened += 1;
      await ledger.addOwed(wallet, owedWei);
    }
    await ledger.markWindow(id, "SIGNED", {
      contributionWei: attested.contributionWei,
      settlementNonce: attested.attestation.settlementNonce,
      sessionId: attested.attestation.sessionId,
      deadline: attested.attestation.deadline,
    });

    let pull: PullOutcome;
    try {
      pull = await this.p.submitPull(
        rpc,
        config.mode,
        config.executor,
        window,
        attested.attestation,
        attested.signature,
        attested.contributionWei,
        this.deps.seat,
        ledger,
        id,
      );
    } catch (error) {
      if (error instanceof PullBroadcastError) {
        // The intent is already in sip_pull with its nonce and hash: the bytes
        // may be on the wire. Treat it as sent and let the next pass ask the
        // frontier; re-attesting the same nonce here is how a double pull and a
        // wasted revert happen.
        await ledger.markWindow(id, "SUBMITTED", { unresolved: true, detail: error.message });
        log.error("pull.unresolved", { ...amounts, windowId: id, detail: error.message });
        return;
      }
      throw error;
    }
    await ledger.recordPull(id, pull.kind === "SENT" ? pull.intent : null, pull);
    switch (pull.kind) {
      case "SENT":
        // NOT credited here: a broadcast is not a receipt. The next pass reads
        // the vault's frontier and credits what actually landed.
        await ledger.markWindow(id, "SUBMITTED", { txHash: pull.intent.txHash, nonce: pull.intent.nonce, contributionWei: pull.intent.contributionWei });
        this.pulls += 1;
        log.info("pull.sent", { ...amounts, windowId: id, txHash: pull.intent.txHash, nonce: pull.intent.nonce, contributionWei: pull.intent.contributionWei });
        return;
      case "DRY_RUN":
        // §6: dry run performs everything except signing and sending, and
        // says what it would have sent. The window stays OPEN and the next
        // pass picks it up again.
        await ledger.markWindow(id, "OPEN", { dryRun: true, contributionWei: pull.intent.contributionWei });
        this.pulls += 1;
        log.info("pull.dry_run", { ...amounts, windowId: id, contributionWei: pull.intent.contributionWei, batchRoot: window.batchRoot });
        return;
      case "SKIPPED":
        await ledger.markWindow(id, "OPEN", { skipped: pull.reason, detail: pull.detail ?? null });
        this.deferred += 1;
        log.warn("pull.skipped", { ...amounts, windowId: id, reason: pull.reason, detail: pull.detail ?? null });
        return;
    }
  }
}

/** The contribution a SIGNED/SUBMITTED window committed to, when the detail carries one. */
function contributionOf(detail: unknown): bigint | null {
  if (typeof detail !== "object" || detail === null) return null;
  const value = (detail as { contributionWei?: unknown }).contributionWei;
  if (typeof value === "bigint") return value;
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return BigInt(value);
  return null;
}

// ── the schedule ────────────────────────────────────────────────────────────

// Running a periodic body without letting two of them overlap.
// Ported from packages/keeper-old/src/cycle.ts (skipWhileRunning).
//
// `setInterval` fires on the clock whether or not the last firing finished, and
// a pass can outrun its interval: keeper-old's own logs carried 44 ticks longer
// than its 60-second interval. Two passes in flight means `runTick` running
// twice concurrently against the same ledger and the same cursors.
//
// SKIPPED, NOT QUEUED. The next firing is one interval away and a backlog of
// identical passes accomplishes nothing — it would only guarantee the overlap it
// is meant to prevent, one interval later.
//
// IT LIVES HERE RATHER THAN AS A FLAG IN THE BINARY because of how it fails. A
// latch that is taken and not released does not crash and does not log: the
// worker simply never passes again, reporting nothing wrong. The binary has no
// tests; this does.

/**
 * Wraps `body` so a call arriving while a previous one is still running is
 * skipped.
 *
 * `onSkip` is called instead, so the caller can say so out loud — a skipped
 * pass is worth a line, since a run of them means the interval is too short for
 * the work.
 */
export function skipWhileRunning(body: () => Promise<void>, onSkip: () => void): () => Promise<void> {
  let running = false;
  return async () => {
    if (running) {
      onSkip();
      return;
    }
    running = true;
    try {
      await body();
    } finally {
      // IN A `finally`. A body that throws past its own handler would otherwise
      // leave this latched forever, which is the silent mute described above.
      running = false;
    }
  };
}

/**
 * A watchdog for the condition that has no event: nothing happening.
 * Ported from packages/keeper-old/src/alerts.ts (createHeartbeat); the alerter
 * is the logger here — this worker has no webhook yet — and the alerter's
 * per-key de-duplication is a latch that resets on the next beat.
 *
 * Every other line the loop writes is raised by something happening. This one
 * fires when NOTHING does — a worker that stopped passing. It is the only
 * signal that can catch a process wedged rather than crashed, which is the
 * failure mode that hides longest.
 */
export function createHeartbeat(input: {
  readonly log: Logger;
  readonly name: string;
  readonly silenceMs: number;
  readonly now?: () => number;
}): { beat: () => void; check: () => boolean } {
  const now = input.now ?? (() => Date.now());
  let last = now();
  let fired = false;

  return {
    beat(): void {
      last = now();
      fired = false;
    },
    check(): boolean {
      const quietFor = now() - last;
      if (quietFor < input.silenceMs || fired) return false;
      fired = true;
      input.log.error("worker.silent", {
        name: input.name,
        quietForMs: quietFor,
        detail:
          `No completed pass for ${Math.round(quietFor / 1000)}s. The process may be up and wedged, ` +
          "which produces no error of its own — the skim stops with nothing in the log.",
      });
      return true;
    },
  };
}

export interface LoopOptions {
  readonly pollMs: number;
  /** Aborting it ends the loop after the in-flight pass, if any, completes. */
  readonly signal: AbortSignal;
  readonly pipeline?: TickOptions;
  /** How long without a completed pass before `worker.silent` is logged. Default max(5 × pollMs, 5 min). */
  readonly silenceMs?: number;
  /** How often the watchdog looks. Default 60 s. */
  readonly watchdogMs?: number;
  readonly now?: () => number;
}

/**
 * `run`: a pass now, then one every `pollMs`, never two at once, one heartbeat
 * line per completed pass, a watchdog line when passes stop completing, and a
 * clean stop on the signal. A pass that fails is logged and the loop goes on: a
 * failed pass must not end the process (keeper-old keeper-supervisor.mts).
 *
 * ONE FAILURE IS NOT LIKE THE OTHERS. A lost ledger connection took the
 * advisory lock with it, and that lock is the only thing keeping a second
 * worker from closing windows against the same cursors and pulling the same
 * fills twice. Ticking on would be doing that work with no claim to it, so the
 * loop ends and this rejects: the caller exits non-zero and the supervisor
 * starts a worker that takes the lock again.
 */
export async function runLoop(deps: TickDeps, options: LoopOptions): Promise<void> {
  const { log } = deps;
  const now = options.now ?? (() => Date.now());
  const pipeline: TickOptions = { factoryScan: { scannedTo: null }, refusalAges: new Map(), ...options.pipeline };
  const heartbeat = createHeartbeat({
    log,
    name: "worker",
    silenceMs: options.silenceMs ?? Math.max(options.pollMs * 5, 5 * 60 * 1000),
    now,
  });

  let pass = 0;
  let inflight: Promise<void> = Promise.resolve();
  let fatal: unknown = null;
  let endLoop = (): void => undefined;
  const ended = new Promise<void>((resolve) => {
    endLoop = resolve;
  });

  const body = async (): Promise<void> => {
    pass += 1;
    const startedAt = now();
    try {
      const summary = await runTick(deps, pipeline);
      heartbeat.beat();
      log.info("worker.heartbeat", { pass, tickMs: now() - startedAt, ...summary });
    } catch (error) {
      if (error instanceof LedgerConnectionLostError) {
        fatal = error;
        log.error("worker.ledger_lost", { pass, tickMs: now() - startedAt, detail: describe(error) });
        endLoop();
        return;
      }
      log.error("worker.tick_failed", { pass, tickMs: now() - startedAt, detail: describe(error) });
    }
  };

  // The FIRST pass cannot overlap anything — it is awaited here, before the
  // interval exists (keeper-old keeper-supervisor.mts).
  if (!options.signal.aborted) await body();

  const cycle = skipWhileRunning(
    async () => {
      inflight = body();
      await inflight;
    },
    () => log.warn("worker.skip", { detail: "skipping this pass; the previous one is still running", pollMs: options.pollMs }),
  );
  if (fatal === null) {
    const timer = setInterval(() => {
      if (options.signal.aborted) return;
      void cycle();
    }, options.pollMs);
    const watchdog = setInterval(() => heartbeat.check(), options.watchdogMs ?? 60_000);
    watchdog.unref();

    await Promise.race([
      ended,
      new Promise<void>((resolve) => {
        if (options.signal.aborted) resolve();
        else options.signal.addEventListener("abort", () => resolve(), { once: true });
      }),
    ]);
    clearInterval(timer);
    clearInterval(watchdog);
  }
  // Let the pass in flight finish before the caller closes the ledger under it.
  await inflight;
  log.info("worker.stop", { passes: pass, fatal: fatal === null ? null : describe(fatal) });
  if (fatal !== null) throw fatal;
}
