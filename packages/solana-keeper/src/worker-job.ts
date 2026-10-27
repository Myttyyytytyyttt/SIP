// ONE WORKER JOB: one vault, from its claim to its COMPLETE (dispatcher ADR §3.2,
// §3.6, §3.7, §4.4; plan P3a Q3). In order:
//
//   1. THE TAKEOVER (src/worker-takeover.ts): every open intent of an earlier
//      fence is resolved — by its signature's status, or by the finalized height
//      passing its last valid one — and one that can still land ends this job
//      UNCHANGED, due once it cannot.
//   2. THE PLAN FLOOR: nothing is planned until the finalized height is above
//      the last height any earlier intent could act at — on every vault that has
//      ever gated one, whoever gated it — and every read of this job from then on
//      carries minContextSlot ≥ the slot at which that wait cleared: for a floor
//      passed long ago, a slot as long ago, not the newest finalized one
//      (src/worker-takeover.ts, readFromSlot; src/job-chain.ts).
//   3. A FRESH READ: the vault, its links (addresses from keeper_link, every
//      field from the chain), the protocol config and the crank, in one request.
//   4. EACH LINK SETTLED, in link-address order, through the MODULE the vault's
//      own skim_mode picks (src/settle-modules.ts), each settle gated by the
//      fence (src/fenced-sender.ts) with its PROFIT carry inside the gate (S-4).
//      A per-trade vault's module (ROUND-UP, FIXED: plan §3.4) exists only
//      under SIP_SOLANA_EXTRA_MODES and its vault list, reads its PerTradePolicy
//      and the oracle once for the job — the policy's daily counter carried
//      forward past each SETTLED link, as settle_v3 moves it — and turns DRY
//      in the live world until SIP_SOLANA_EXTRA_MODES_LIVE is 1. A waiting
//      per-trade span is due again when its own clock says (dueAt), a resting
//      per-trade vault within its mode's probe cadence (PMC).
//   5. INVEST ONCE for the vault (owner decision 11), every wrap, convert and leg
//      gated by the fence through the explicit-send order; each landed leg's
//      history row written before its intent is resolved (the outbox, S-9).
//   6. COMPLETE, due again by what it found (ADR §3.7), with the mode byte step 3
//      read (vault_work.skim_mode: the page's, never this job's input), or — when
//      the job may no longer act (its lease, its ceiling, a SIGTERM) — stop, and
//      the loop releases what it still holds.
//
// THE SHADOW WORLD (SIP_SOLANA_DISPATCH=shadow): the same job, keyless and dry.
// Every would-be send is gated as a 'shadow' intent and nothing is sent: the
// settle turn gates its would-be settle through the same fence, and a dry invest
// turn that would buy has its wrap, convert and one leg gated afterwards. The
// takeover, the plan floor and the overlap audit then run on real scheduling.
//
// THE LIVE WORLD NEVER RUNS A DRY TURN. A live worker whose settle key is not the
// chain's attester and keeper (chain-state.ts, verifySettleKey) settles nothing
// and completes RETRY: a dry turn in the live world would only look like work.
//
// THE CUTS (SIP_SOLANA_CUTS), WHERE THEY EXIST INSIDE A JOB (plan P3a design
// detail 4): `rest-skip` hands each settle the process's RestBook, and
// `invest-batch` reads the vault's at-rest invest state in the job's own read
// and lets it decide a turn that sends nothing. `explicit-send` is not a token
// on a worker: the fenced sender IS that order plus the gate (F1).
//
// SHARED IN-PROCESS STATE, REVIEWED FOR TWO JOBS AT ONCE (plan P3a Q3):
//   * the walk cache — SHARED. It keeps finalized facts, which never change, per
//     WALLET; a wallet has one link and a link one vault, so two jobs (two
//     vaults) never read the same wallet's entries, and its eviction only costs a
//     re-read. Soft affinity (CLAIM prefers last_holder) keeps it warm;
//   * the RestBook — SHARED, keyed by link, for the same reason;
//   * the policy-boundary book — SHARED, keyed by vault;
//   * the carry book — PER JOB, and empty: the carries live in Postgres and are
//     read through (workerCarryReads), never decided from memory;
//   * signing routes — NOT KEPT: /status's per-wallet table is the legacy
//     sweep's; a job resolves its wallets' signers itself (JobKeys.signerFor);
//   * the per-sweep Jupiter counter (sweep-cost.ts, jupiterCalls) — NEVER
//     RESET by a job: startSweep zeroes it for everyone, and a worker has no
//     sweep. Only its per-minute view, which needs no reset, means anything here.

import { PublicKey, type Keypair } from "@solana/web3.js";
import { summarizeUpstreamError } from "@sip/solana-log";
import type { CarryRead, CarryStoreTurn, DurableCarryStore } from "./carry-store.js";
import { verifySettleKey } from "./chain-state.js";
import type { ClaimedVault, Completion, GateAnswer, IntentKind, Lane } from "./dispatch-store.js";
import { investRests, settleRests, turnRests, type TurnInvest, type TurnSettle } from "./doorbell.js";
import { CrankSender, type SigningWallet } from "./explicit-send.js";
import { JobFence, type FenceStore } from "./fenced-sender.js";
import type { Alert } from "./alerts.js";
import { investFailedStreak, type WrapReport } from "./invest-decision.js";
import { readSweepState, settleLeavesSnapshotTrue, type InvestSnapshot } from "./invest-snapshot.js";
import { runInvestTick, type InvestDeps, type InvestResult } from "./invest-tick.js";
import type { JobChain } from "./job-chain.js";
import type { JupiterAccess } from "./jupiter-pacer.js";
import type { WalkCache } from "./measure-window.js";
import type { OwnerHistoryReader, PolicyBoundaryBook } from "./policy-boundary.js";
import type { SolanaWalletSubmitter } from "./privy-signer.js";
import type { InvestmentRow, SettlementRow } from "./read-model.js";
import type { RestBook } from "./rest-book.js";
import { SAFETY_PASS_STEPS_MS } from "./credit-governor.js";
import { keeperModeFor } from "./role-registry.js";
import { activeBps, settleRetryStreak, type CarryBook, type SettleWaitingOn } from "./settle-decision.js";
import { settleModuleFor, type ModulePrepared, type PerTradeServing } from "./settle-modules.js";
import { runSettleTick, type SettleDeps, type SettleResult } from "./settle-tick.js";
import { legOutbox, resolvePriorIntents, waitForPlanFloor, type TakeoverStore } from "./worker-takeover.js";

/**
 * A vault that rests is due again — as a BACKSTOP — after the longest safety
 * pass the credit governor can set (SAFETY_PASS_STEPS_MS: 120 minutes). WHEN it
 * is turned is the scheduler's: the safety slice rotates every queue link once a
 * pass at the pass the governor allows NOW (30, 60 or 120 minutes), and a bell,
 * a new link or a full pass brings it forward sooner; a due time only ever moves
 * earlier (src/scheduler-pg.ts). A backstop at the 30-minute default — what Q3
 * first wrote — turned every resting vault every 30 minutes whatever the pass,
 * so stretching it to 60 or 120 minutes (the credit-burn lever, ADR §3.9) saved
 * nothing on the vaults the workers had completed.
 */
export const REST_DUE_SECONDS = Math.max(...SAFETY_PASS_STEPS_MS) / 1_000;
/** The longest a job waits for its plan floor before it completes and comes back: one blockhash life plus finality. */
export const PLAN_FLOOR_WAIT_MAX_MS = 90_000;
/** A refused basket waits 5 minutes, doubling with each refusal in a row, to an hour (ADR §3.7). */
export const REFUSED_DUE_SECONDS = 5 * 60;
export const REFUSED_DUE_MAX_SECONDS = 60 * 60;

/** What a job needs of the store: the takeover's reads, the fence's gates, and its links. */
export interface WorkerJobStore extends TakeoverStore, FenceStore {
  linksOf(vault: string): Promise<readonly string[]>;
  markBoardDirty(): Promise<void>;
}

/** The history a job writes, over the worker's own pool (SolanaReadModel.overPool). Each answers whether it was written. */
export interface JobHistory {
  recordSettlement(row: SettlementRow): Promise<boolean>;
  recordInvestment(row: InvestmentRow): Promise<boolean>;
  recordLink(vaultAddr: string, ownerAddr: string, rateBps: number, walletAddr: string): Promise<boolean>;
}

/** What only a live worker holds. A shadow worker has none of it. */
export interface JobKeys {
  /** The settle key: the attester, and the crank that pays for every wrap, convert and leg (ADR §4.7). */
  readonly settleKey: Keypair;
  /** The provider's wallet over the settle key: the crank's second signature, as Anchor adds it. */
  readonly wallet: SigningWallet;
  /** The trading wallet's signer: Privy (looked up by address, C8), or a local keypair on localnet; null when there is none. */
  signerFor(wallet: PublicKey): Promise<SolanaWalletSubmitter | Keypair | null>;
}

/** The process's caches a job may read (the header says which and why). */
export interface JobShared {
  readonly walkCache: WalkCache;
  /** The `rest-skip` cut's memos: null without the token. */
  readonly restBook: RestBook | null;
  readonly boundaries: PolicyBoundaryBook;
  readonly ownerHistory: OwnerHistoryReader;
  /** The `jupiter-key` cut's host, key and pacer (retuned to this worker's quota): null without the token. */
  readonly jupiter: JupiterAccess | null;
  /** The `invest-batch` cut: the job's read carries the vault's at-rest invest state. */
  readonly investBatch: boolean;
  /** PROFIT carries, read through from Postgres (workerCarryReads). */
  readonly carryReads: CarryStoreTurn;
  /**
   * What this worker serves of the per-trade modes (SIP_SOLANA_EXTRA_MODES*,
   * src/worker-config.ts). ABSENT OR NULL IS TODAY: no per-trade byte has a
   * module, and such a vault's links rest at UNSUPPORTED_MODE before any RPC.
   */
  readonly perTrade?: PerTradeServing | null;
}

export type JobLog = (level: "info" | "warn" | "error", message: string, fields: Record<string, unknown>) => void;

export interface VaultJobDeps {
  readonly store: WorkerJobStore;
  readonly chain: JobChain;
  readonly history: JobHistory;
  readonly keys: JobKeys | null;
  readonly shared: JobShared;
  /**
   * Why this job may not go on — its lease lost at a heartbeat, its 6-minute
   * ceiling passed, the process draining after SIGTERM — or null. Asked between
   * steps and before every gate.
   */
  readonly mayAct: () => string | null;
  /** No new phase (a link's settle, the invest) starts after this instant: the 4-minute soft deadline. */
  readonly softDeadlineAt: number;
  readonly log: JobLog;
  /** Told every gate's answer (the worker's fence-reject counters). */
  readonly onGate?: (kind: IntentKind, answer: GateAnswer) => void;
  /** Told the job's CrankSender when it makes one, so a SIGTERM drain can wait for its sends. */
  readonly onSender?: (sender: CrankSender) => void;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** The turns, injectable for tests; the real ones by default. */
  readonly settle?: (deps: SettleDeps) => Promise<SettleResult>;
  readonly invest?: (deps: InvestDeps) => Promise<InvestResult>;
}

/** One link's settle, as the job's report carries it. */
export interface LinkTurn {
  readonly link: string;
  readonly wallet: string;
  readonly outcome: TurnSettle;
  readonly detail: string;
  /** A per-trade span waiting on its own clock: the unix second it settles (SettleResult.dueAt). */
  readonly dueAt?: number;
  /** A RETRY that waited on something shared (the loss-carry store): it neither counts nor pages per wallet (settleAlert). */
  readonly waitingOn?: SettleWaitingOn;
  /**
   * A per-trade turn's rows, one per trade the probe counted: what the shadow
   * comparator and an operator read (ADR §5.7 M4: "/status lists per-trade rows").
   */
  readonly perTrade?: readonly PerTradeLogRow[];
}

/** One per-trade row as a job's log line carries it: strings, so a bigint survives JSON. */
export interface PerTradeLogRow {
  readonly signature: string;
  readonly slot: string;
  readonly lamports: string;
  readonly status: "charged" | "forgiven" | "below-minimum";
  /** µ$ per SOL, or null for FIXED and forgiven rows. */
  readonly price: string | null;
  readonly priced: "tape" | "late" | null;
  readonly owed: string;
}

/** What a job did, for the log and the tests. */
export interface JobReport {
  readonly vault: string;
  readonly fence: bigint;
  readonly world: "live" | "shadow";
  readonly live: boolean;
  /** The mode byte the job read, and the module it picked (null: none for that byte). */
  readonly mode: number | null;
  readonly module: string | null;
  readonly settles: readonly LinkTurn[];
  readonly invest: { readonly outcome: TurnInvest; readonly detail: string } | null;
  /** A live job's settle-key check against the on-chain ProtocolConfig, when it ran (src/worker-alerts.ts pages a mismatch). */
  readonly settleKey?: { readonly kind: "verified" | "mismatch" | "no-config" | "unreadable"; readonly detail: string | null };
  /** What the invest turn reported beside its outcome, for the alerts the legacy sweep raises from it (src/worker-alerts.ts). */
  readonly investFacts?: { readonly wrap?: WrapReport; readonly feeWarnings?: readonly Alert[] };
  /** Intents this job gated. */
  readonly intents: number;
  /** Earlier fences' intents this job's takeover resolved. */
  readonly resolvedAtTakeover: number;
}

/** How a job ended: complete the vault with this, or stop and let the loop release what it still holds. */
export type JobEnd =
  | { readonly kind: "complete"; readonly completion: Completion; readonly report: JobReport }
  | { readonly kind: "stop"; readonly reason: string; readonly report: JobReport };

/** A link's settle outcome → how soon its vault is due again, when it does not rest (ADR §3.7). */
const SETTLE_DUE_SECONDS: Partial<Record<TurnSettle, number>> = {
  PENDING_FINALITY: 15,
  // A backlog past MAX_SIGNATURES may remain, and the echo is due: the next tick.
  SETTLED: 60,
  // THE ADR SAYS "now"; a vault whose endpoint keeps failing would then be claimed
  // in a hot loop. A tick's cadence, as the legacy sweep gives it today.
  INCOMPLETE: 60,
  NO_SIGNER: 600,
  RETRY: 60,
  FAILED: 60,
  THREW: 60,
};

/** The streaks a job keeps in vault_work.streaks: per wallet for the settle, per vault for the invest. */
export interface JobStreaks {
  readonly settleRetries: Readonly<Record<string, number>>;
  readonly investFailed: number;
  readonly investRefused: number;
  readonly wrapShort: number;
}

const count = (value: unknown): number => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0);

/** The row's streaks, read defensively: the column is free jsonb, and a value that is not a count is zero. */
export function readStreaks(raw: Readonly<Record<string, unknown>>): JobStreaks {
  const retries = raw["settleRetries"];
  const settleRetries: Record<string, number> = {};
  if (retries !== null && typeof retries === "object" && !Array.isArray(retries)) {
    for (const [wallet, value] of Object.entries(retries as Record<string, unknown>)) {
      const n = count(value);
      if (n > 0) settleRetries[wallet] = n;
    }
  }
  return { settleRetries, investFailed: count(raw["investFailed"]), investRefused: count(raw["investRefused"]), wrapShort: count(raw["wrapShort"]) };
}

/**
 * The job's COMPLETE: rests, lane, priority (the lane's), streaks, outcome and
 * when it is due again — ADR §3.7's retry-at by outcome, with the vault resting
 * only when every link's settle and the invest rest (doorbell.ts, turnRests).
 */
export function completionFor(input: {
  readonly settles: readonly LinkTurn[];
  readonly invest: { readonly outcome: TurnInvest; readonly detail: string } | null;
  readonly wrapShort: boolean;
  readonly previous: JobStreaks;
  /** The soft deadline stopped the job before every phase ran. */
  readonly unfinished: boolean;
  readonly detailFallback?: string;
  /**
   * How soon a vault that rests is due again, when its mode says sooner than the
   * safety backstop: a per-trade vault's PMC (KeeperMode.realProbeEveryMs).
   * Absent — every PROFIT and VOLUME vault — it is REST_DUE_SECONDS.
   */
  readonly restDueSeconds?: number;
  /** Unix seconds now: what a waiting per-trade span's dueAt is measured from. */
  readonly nowSeconds?: number;
}): Completion {
  const { settles, invest, previous } = input;
  const settleRetries: Record<string, number> = {};
  for (const turn of settles) {
    // AS THE LEGACY SWEEP COUNTS THEM: a turn that THREW pages on its own
    // (settleThrewAlert) and ends the RETRY run; a RETRY that waited on the shared
    // carry store does not count (settleRetryStreak's waitingOn).
    const n = turn.outcome === "THREW" ? 0 : settleRetryStreak(previous.settleRetries[turn.wallet] ?? 0, turn.outcome, turn.waitingOn);
    if (n > 0) settleRetries[turn.wallet] = n;
  }
  const investOutcome = invest?.outcome ?? null;
  const next: JobStreaks = {
    settleRetries,
    // A THROW IN THE INVEST HALF IS A FAILED TURN, as the legacy sweep folds it: it escalates to critical on the third.
    investFailed: investOutcome === null ? previous.investFailed : investFailedStreak(previous.investFailed, investOutcome === "THREW" ? "FAILED" : investOutcome),
    investRefused: investOutcome === "REFUSED" ? previous.investRefused + 1 : investOutcome === null || investOutcome === "DEFERRED" ? previous.investRefused : 0,
    wrapShort: invest === null ? previous.wrapShort : input.wrapShort ? previous.wrapShort + 1 : 0,
  };
  // THE ROW'S jsonb: the four counts, nothing else.
  const streaks: Record<string, unknown> = { ...next };
  const outcome = `settle ${settles.length === 0 ? "none" : settles.map((turn) => turn.outcome).join(",")} · invest ${investOutcome ?? "none"}`;
  const noisy = [...settles.filter((turn) => !settleRests(turn.outcome)).map((turn) => turn.detail), ...(invest !== null && !investRests(invest.outcome) ? [invest.detail] : [])];
  const detail = (noisy[0] ?? invest?.detail ?? settles[0]?.detail ?? input.detailFallback ?? "").slice(0, 500) || null;
  if (input.unfinished) {
    return { rests: false, lane: "busy", streaks, outcome, detail: `${detail ?? ""} (the job's soft deadline stopped it before every phase ran; due again now)`.trim(), dueInSeconds: 0 };
  }
  const rests =
    settles.length > 0 && invest !== null
      ? settles.every((turn) => turnRests({ settle: turn.outcome, invest: invest.outcome, wrapShort: input.wrapShort }))
      : settles.length === 0 && invest !== null && investRests(invest.outcome) && !input.wrapShort;
  if (rests) {
    // A PER-TRADE SPAN WAITING ON ITS CLOCK IS DUE WHEN THE CLOCK SAYS (ADR §5.5's
    // cadence as plan §3.4 hosts it: COMPLETE writes oldest charged trade + the
    // mode's max wait), and a resting per-trade vault within its PMC. Neither
    // applies to PROFIT or VOLUME, whose due time is what it always was.
    const nowSeconds = input.nowSeconds ?? 0;
    const waits = settles.flatMap((turn) => (turn.dueAt === undefined ? [] : [Math.max(1, Math.ceil(turn.dueAt - nowSeconds))]));
    const dueInSeconds = Math.min(input.restDueSeconds ?? REST_DUE_SECONDS, ...waits);
    return { rests: true, lane: "safety", streaks, outcome, detail, dueInSeconds };
  }
  const delays: number[] = [];
  let retry = false;
  for (const turn of settles) {
    if (settleRests(turn.outcome)) continue;
    delays.push(SETTLE_DUE_SECONDS[turn.outcome] ?? 60);
    if (turn.outcome === "RETRY" || turn.outcome === "FAILED" || turn.outcome === "THREW") retry = true;
  }
  if (invest !== null && !investRests(invest.outcome)) {
    if (invest.outcome === "REFUSED") {
      delays.push(Math.min(REFUSED_DUE_MAX_SECONDS, REFUSED_DUE_SECONDS * 2 ** Math.max(0, next.investRefused - 1)));
    } else {
      delays.push(60);
      if (invest.outcome === "FAILED" || invest.outcome === "THREW") retry = true;
    }
  }
  if (input.wrapShort) delays.push(60);
  const lane: Lane = retry ? "retry" : "busy";
  return { rests: false, lane, streaks, outcome, detail, dueInSeconds: delays.length === 0 ? 60 : Math.min(...delays) };
}

/** How much of an outcome's detail a job's log line carries, per wallet and for the invest. */
export const JOB_LOG_DETAIL_CHARS = 300;

/**
 * A job's log line (bin/worker.mts, "job done" / "job stopped"): what it found
 * and did, and EACH WALLET'S SETTLE BY ITS ADDRESS — the shape of a legacy
 * keeper's per-wallet /status row, outcome and detail, so a reader can set a
 * worker's turn beside production's for the same wallet (the local shadow's
 * comparator, test-local/shadow, plan §3.3.2 "agreement"). The invest is the
 * vault's, once: every wallet of the vault shares it, as /status shows it.
 */
export function jobLogFields(end: JobEnd): Record<string, unknown> {
  const { report } = end;
  return {
    vault: report.vault,
    fence: report.fence.toString(),
    world: report.world,
    live: report.live,
    module: report.module,
    settles: report.settles.map((turn) => turn.outcome),
    wallets: report.settles.map((turn) => ({
      wallet: turn.wallet,
      settle: turn.outcome,
      detail: turn.detail.slice(0, JOB_LOG_DETAIL_CHARS),
      // ADDITIVE: only a per-trade turn carries rows.
      ...(turn.perTrade === undefined ? {} : { perTrade: turn.perTrade }),
    })),
    invest: report.invest?.outcome ?? null,
    investDetail: report.invest === null ? null : report.invest.detail.slice(0, JOB_LOG_DETAIL_CHARS),
    intents: report.intents,
    resolvedAtTakeover: report.resolvedAtTakeover,
    ...(end.kind === "complete" ? { outcome: end.completion.outcome, dueInSeconds: end.completion.dueInSeconds } : { reason: end.reason }),
  };
}

/**
 * PROFIT carries for a worker's settle turns, READ THROUGH from Postgres on every
 * turn (the `on` phase's rule, ADR RT-8), and never written here: the fence
 * writes them inside the settle's gate. A mode that carries no loss reads none.
 * A store that cannot be read is a base that cannot be known: the turn ends RETRY
 * before anything is decided (settle-tick.ts).
 */
export function workerCarryReads(store: Pick<DurableCarryStore, "carryFor">): CarryStoreTurn {
  return {
    async carryFor(_book, link, mode): Promise<CarryRead> {
      if (keeperModeFor(mode)?.carriesLosses !== true) return { carry: null };
      try {
        return { carry: await store.carryFor(link) };
      } catch (error) {
        return { unavailable: `the loss-carry store could not be read (${summarizeUpstreamError(error)})` };
      }
    },
    async recordCarry() {
      // UNREACHABLE: a worker's settle carries its fence, and the fence writes the carry.
      throw new Error("a worker writes a carry only inside its settle's gate (the fence); nothing was written or sent");
    },
  };
}

/** One job, start to end (the header). Throws only what it cannot report as an outcome: the loop's catch then releases. */
export async function runVaultJob(claimed: ClaimedVault, deps: VaultJobDeps): Promise<JobEnd> {
  const { store, chain, history, keys, shared, log } = deps;
  const now = deps.now ?? (() => Date.now());
  const settle = deps.settle ?? runSettleTick;
  const invest = deps.invest ?? runInvestTick;
  const streaks = readStreaks(claimed.streaks);
  const vaultAddr = claimed.vault;
  const report: { -readonly [K in keyof JobReport]: JobReport[K] } = {
    vault: vaultAddr,
    fence: claimed.fence,
    world: store.world,
    live: false,
    mode: null,
    module: null,
    settles: [],
    invest: null,
    intents: 0,
    resolvedAtTakeover: 0,
  };
  let fence: JobFence | null = null;
  const stopReason = (): string | null => fence?.lostReason ?? deps.mayAct();
  const stop = (reason: string): JobEnd => ({ kind: "stop", reason, report: { ...report, intents: fence?.intents.length ?? 0 } });
  // THE MODE BYTE THIS JOB READ, ON EVERY COMPLETE AFTER THE READ: for the page
  // only (COMPLETE_SQL's `$11`). Before the read report.mode is null, and the row
  // keeps the byte the last read left.
  const complete = (completion: Completion): JobEnd => ({
    kind: "complete",
    completion: report.mode === null ? completion : { ...completion, skimMode: report.mode },
    report: { ...report, intents: fence?.intents.length ?? 0 },
  });
  const waiting = (outcome: string, detail: string, dueInSeconds: number): JobEnd =>
    complete({ rests: false, lane: "retry", streaks: claimed.streaks, outcome, detail, dueInSeconds });

  // ── 1. the takeover ─────────────────────────────────────────────────────────
  const outbox = legOutbox(chain.connection, (row) => history.recordInvestment(row), (message, fields) => log("warn", message, { vault: vaultAddr, ...fields }));
  const takeover = await resolvePriorIntents(store, claimed, chain, outbox);
  report.resolvedAtTakeover = takeover.resolved;
  if (takeover.kind === "wait") return waiting("WAITING_INTENT", takeover.detail, takeover.dueInSeconds);
  let blocked = stopReason();
  if (blocked !== null) return stop(blocked);

  // ── 2. the plan floor ───────────────────────────────────────────────────────
  let planClearedHeight: bigint | null = null;
  if (takeover.planFloor !== null) {
    const plan = await waitForPlanFloor(chain, takeover.planFloor, {
      deadlineAt: Math.min(deps.softDeadlineAt, now() + PLAN_FLOOR_WAIT_MAX_MS),
      mayAct: deps.mayAct,
      now,
      ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
    });
    if (plan.kind === "blocked") return stop(plan.reason);
    if (plan.kind === "late") {
      return waiting(
        "WAITING_FINALITY",
        `the finalized height ${plan.finalized} has not passed ${plan.floor}, the last height an earlier holder's transaction could act at; nothing was planned`,
        15,
      );
    }
    planClearedHeight = plan.height;
    // EVERY READ FROM HERE ON IS AT LEAST AS NEW AS THE WAIT (ADR §3.6 step 4): the
    // slot at which it cleared, which for a floor passed long ago is far below the
    // newest finalized slot, so a node a few slots behind still answers.
    chain.requireSlot(plan.slot);
  }

  // ── 3. the fresh read ───────────────────────────────────────────────────────
  const vaultKey = new PublicKey(vaultAddr);
  const linkKeys = (await store.linksOf(vaultAddr)).map((address) => new PublicKey(address));
  const read = await chain.readVault(vaultKey, linkKeys);
  let snapshot: InvestSnapshot | undefined;
  if (shared.investBatch && read.vault !== null) {
    snapshot = (await readSweepState(chain.connection, chain.program, [vaultKey])).invest.get(vaultAddr);
  }
  if (read.vault === null) {
    return complete({
      rests: false,
      lane: "retry",
      streaks: claimed.streaks,
      outcome: "FAILED",
      detail: `vault account missing: the chain holds no account at ${vaultAddr}; nothing was measured, attested or bought`,
      dueInSeconds: 600,
    });
  }
  const vault = read.vault;
  report.mode = vault.skimMode;
  // A PER-TRADE BYTE HAS A MODULE ONLY WHERE THIS WORKER SERVES IT FOR THIS VAULT.
  const module = settleModuleFor(vault.skimMode, { vault: vaultAddr, serving: shared.perTrade ?? null });
  report.module = module?.mode.name ?? null;
  if (read.links.length === 0) {
    // A VAULT WITH NO LIVE LINK IS NOT TURNED BY THE LEGACY SWEEP EITHER: its turns are per link.
    return complete({
      rests: true,
      lane: "safety",
      streaks: claimed.streaks,
      outcome: "NO_LINK",
      detail: "no live trading link names this vault on chain; nothing was settled or bought",
      dueInSeconds: REST_DUE_SECONDS,
    });
  }

  // ── live, or the shadow world's dry run ─────────────────────────────────────
  if (store.world === "live") {
    if (keys === null) return waiting("RETRY", "a live worker holds no settle key; nothing was settled or bought", 60);
    const verification = verifySettleKey(keys.settleKey.publicKey, { config: read.config, configReadable: true });
    report.settleKey = { kind: verification.kind, detail: verification.kind === "verified" ? null : verification.detail };
    if (verification.kind !== "verified") return waiting("RETRY", `${verification.detail}; nothing was settled or bought`, 60);
  } else if (keys !== null) {
    // UNREACHABLE: bin/worker.mts refuses to start a shadow worker that holds a key.
    throw new Error("a shadow job was handed keys; a shadow worker holds none");
  }
  const live = store.world === "live";
  report.live = live;
  fence = new JobFence({
    store,
    vault: vaultAddr,
    fence: claimed.fence,
    planClearedHeight,
    programId: chain.program.programId,
    confirmedHeight: () => chain.confirmedHeight(),
    mayAct: deps.mayAct,
    ...(deps.onGate === undefined ? {} : { onGate: deps.onGate }),
    onResolveFailed: (intent, detail) => log("warn", "an intent's resolution could not be written; it stays open for the next holder", { vault: vaultAddr, intent: intent.id.toString(), detail }),
  });
  const protocolPaused = read.config?.paused === true;

  // ── 3b. what the vault's module reads once (PROFIT, VOLUME: nothing) ────────
  // A paused per-trade vault is not read for: its turns stop at PAUSED first.
  let prepared: ModulePrepared | null = null;
  if (module !== null) {
    if (module.mode.base === "per-trade" && (vault.paused || protocolPaused)) {
      prepared = { kind: "ready", turn: () => ({}) };
    } else {
      try {
        prepared = await module.prepare({ connection: chain.connection, program: chain.program, vaultAddress: vaultKey, vault });
      } catch (error) {
        prepared = { kind: "retry", detail: `the ${module.mode.name} module could not read what it settles by (${summarizeUpstreamError(error)}); nothing was attested` };
      }
    }
  }
  // A MODULE THAT DOES NOT SEND (a per-trade module before SIP_SOLANA_EXTRA_MODES_LIVE=1)
  // turns its links dry in the live world: no signer is resolved and nothing is gated.
  const sends = live && (module?.sends ?? true);

  // ── 4. each link's settle ───────────────────────────────────────────────────
  const settles: LinkTurn[] = [];
  let unfinished = false;
  let moved = false;
  for (const link of read.links) {
    blocked = stopReason();
    if (blocked !== null) {
      report.settles = settles;
      await fence.settled();
      return stop(blocked);
    }
    if (now() >= deps.softDeadlineAt) {
      unfinished = true;
      break;
    }
    const wallet = link.wallet.toBase58();
    if (prepared?.kind === "retry") {
      settles.push({ link: link.linkAddress.toBase58(), wallet, outcome: "RETRY", detail: prepared.detail });
      moved = true;
      continue;
    }
    let result: SettleResult;
    try {
      const walletSigner = sends ? await keys!.signerFor(link.wallet) : null;
      result = await settle({
        connection: chain.connection,
        program: chain.program,
        link,
        vault,
        attester: sends ? keys!.settleKey : null,
        walletSigner,
        live: sends,
        protocolPaused,
        // THE VAULT'S OWN MODE, AND ONLY IT: no module, no byte, UNSUPPORTED_MODE before any RPC.
        settles: module === null ? [] : [module.mode.byte],
        carries: new Map() as CarryBook,
        carryStore: shared.carryReads,
        walkCache: shared.walkCache,
        ...(shared.restBook === null ? {} : { restBook: shared.restBook }),
        ...(prepared === null || prepared.kind !== "ready"
          ? {}
          : prepared.turn({ link, vault, programId: chain.program.programId, boundaries: shared.boundaries, ownerHistory: shared.ownerHistory, nowSeconds: () => now() / 1000 })),
        fence: fence.settleFence(),
      });
    } catch (error) {
      const detail = summarizeUpstreamError(error, { take: 3, maxChars: 500 });
      settles.push({ link: link.linkAddress.toBase58(), wallet, outcome: "THREW", detail });
      log("error", "a worker's settle turn threw", { vault: vaultAddr, wallet, detail });
      moved = true;
      continue;
    }
    settles.push({
      link: link.linkAddress.toBase58(),
      wallet,
      outcome: result.outcome,
      detail: result.detail,
      ...(result.dueAt === undefined ? {} : { dueAt: result.dueAt }),
      ...(result.waitingOn === undefined ? {} : { waitingOn: result.waitingOn }),
      ...(result.perTrade === undefined ? {} : { perTrade: perTradeLogRows(result.perTrade) }),
    });
    // THE MODULE HEARS HOW THE TURN ENDED before the next link's is built: a per-trade vault's daily counter moves with each settle.
    if (prepared?.kind === "ready") prepared.afterTurn?.(result, now() / 1000);
    if (!settleLeavesSnapshotTrue(result.outcome)) moved = true;
    if (result.outcome === "SETTLED" || result.outcome === "FAILED" || result.outcome === "RETRY") {
      log(result.outcome === "FAILED" ? "error" : result.outcome === "RETRY" ? "warn" : "info", `settle ${result.outcome.toLowerCase()}`, {
        vault: vaultAddr,
        wallet,
        detail: result.detail,
        signature: result.signature,
      });
    }
    // THE HISTORY ROW, a live SETTLED's only — the same row bin/keeper.mts writes, awaited here: a job holds one vault, not a sweep.
    if (
      sends &&
      result.outcome === "SETTLED" &&
      result.signature !== undefined &&
      result.baseLamports !== undefined &&
      result.mode !== undefined &&
      result.expectedLamports !== undefined &&
      result.nonce !== undefined &&
      result.endSlot !== undefined
    ) {
      await history.recordLink(vaultAddr, vault.owner.toBase58(), activeBps(vault), wallet);
      const written = await history.recordSettlement({
        walletAddr: wallet,
        nonce: result.nonce,
        vaultAddr,
        mode: result.mode,
        baseRaw: result.baseLamports,
        contributionRaw: result.settledLamports ?? result.expectedLamports,
        volumeRaw: result.volumeLamports ?? result.tradedLamports ?? 0n,
        txRef: result.signature,
        height: result.endSlot,
        ...(result.blockTimeMs === undefined ? {} : { at: new Date(result.blockTimeMs) }),
      });
      if (written) {
        await store.markBoardDirty().catch((error: unknown) => log("warn", "the leaderboard could not be marked due", { detail: summarizeUpstreamError(error) }));
      }
    }
  }
  report.settles = settles;

  // ── 5. invest, once ─────────────────────────────────────────────────────────
  let investTurn: { outcome: TurnInvest; detail: string } | null = null;
  let wrapShort = false;
  blocked = stopReason();
  if (blocked !== null) {
    await fence.settled();
    return stop(blocked);
  }
  if (!unfinished && now() >= deps.softDeadlineAt) unfinished = true;
  if (!unfinished) {
    let sender: CrankSender | undefined;
    if (live) {
      sender = new CrankSender({
        connection: chain.connection,
        wallet: keys!.wallet,
        isLive: () => stopReason() === null,
        // THE TAKEOVER RULE REPLACES THE QUIET PERIOD: this job planned only once nothing earlier could act.
        quietMs: 0,
        gate: fence.crankGate(),
      });
      deps.onSender?.(sender);
    }
    try {
      const result = await invest({
        connection: chain.connection,
        program: chain.program,
        vault: vaultKey,
        crank: live ? keys!.settleKey : null,
        crankLamports: read.crankLamports,
        live,
        protocolPaused,
        ...(shared.jupiter === null ? {} : { jupiter: shared.jupiter }),
        // THE invest-batch CUT: the job's own read, unless a settle above may have moved the vault's money.
        ...(snapshot === undefined || moved ? {} : { snapshot }),
        ...(sender === undefined ? {} : { sender }),
      });
      investTurn = { outcome: result.outcome, detail: result.detail };
      wrapShort = result.wrap?.short === true;
      report.investFacts = {
        ...(result.wrap === undefined ? {} : { wrap: result.wrap }),
        ...(result.feeWarnings === undefined ? {} : { feeWarnings: result.feeWarnings }),
      };
      if (result.outcome === "INVESTED" || result.outcome === "FAILED" || result.outcome === "REFUSED") {
        log(result.outcome === "INVESTED" ? "info" : "warn", `invest ${result.outcome.toLowerCase()}`, { vault: vaultAddr, detail: result.detail });
      }
      // THE OUTBOX (S-9), THE SENDER'S HALF: each confirmed leg's row, THEN its intent resolved.
      if (live) {
        for (const purchase of result.purchases ?? []) {
          const written = await history.recordInvestment({
            vaultAddr,
            target: purchase.target,
            spentRaw: purchase.spentRaw,
            receivedRaw: purchase.receivedRaw,
            txRef: purchase.signature,
            height: purchase.slot,
          });
          const intent = fence.landedAwaitingHistory().find((own) => own.signature === purchase.signature);
          if (written && intent !== undefined) await fence.historyWritten(intent);
        }
      }
      // THE SHADOW WORLD'S WOULD-BE SENDS: a dry turn that would buy gates its wrap, its convert and one leg.
      if (store.world === "shadow" && result.outcome === "INVESTED") {
        const recent = await chain.latestBlockhash();
        const wrapped = result.wrap?.wrapped ?? 0n;
        if (wrapped > 0n) {
          await fence.shadowCrank("wrap", wrapped, recent);
          if (fence.lostReason === null) await fence.shadowCrank("convert", null, recent);
        }
        if (fence.lostReason === null) await fence.shadowCrank("invest", null, recent);
      }
    } catch (error) {
      const detail = summarizeUpstreamError(error, { take: 3, maxChars: 500 });
      investTurn = { outcome: "THREW", detail };
      log("error", "a worker's invest turn threw", { vault: vaultAddr, detail });
    }
  }
  report.invest = investTurn;

  // A LEG THAT LANDED BUT NEVER MADE IT INTO `purchases` (the turn broke right after it): its row from its receipt.
  for (const intent of fence.landedAwaitingHistory()) {
    if (await outbox({ vault: vaultAddr, signature: intent.signature })) await fence.historyWritten(intent);
  }
  await fence.settled();

  blocked = stopReason();
  if (blocked !== null) return stop(blocked);
  const probeEveryMs = module?.mode.realProbeEveryMs ?? 0;
  return complete(
    completionFor({
      settles,
      invest: investTurn,
      wrapShort,
      previous: streaks,
      unfinished,
      ...(probeEveryMs > 0 ? { restDueSeconds: Math.min(REST_DUE_SECONDS, Math.ceil(probeEveryMs / 1_000)), nowSeconds: now() / 1_000 } : {}),
    }),
  );
}

/** A per-trade charge's rows, as a job's log line and report carry them. */
export function perTradeLogRows(charge: NonNullable<SettleResult["perTrade"]>): readonly PerTradeLogRow[] {
  return charge.rows.map((row) => ({
    signature: row.signature,
    slot: row.slot.toString(),
    lamports: row.lamports.toString(),
    status: row.status,
    price: row.priceUsdE6 === null ? null : row.priceUsdE6.toString(),
    priced: row.priceSource,
    owed: row.owedLamports.toString(),
  }));
}
