// THE DISPATCHER'S SCHEDULER (Q2): one tick a minute, under the advisory lock
// `sip-solana-scheduler`, deciding WHICH VAULT IS DUE AND WHEN — never acting on
// one (dispatcher ADR §3.8, §3.11, §3.12; [QUEUE] §2.7; plan §3.3.1 Q2, C7).
//
// TWO PROCESSES, ONE ACTS. Both replicas tick. A tick's first act is the lock:
// the holder checks its session and schedules; the other asks for the lock and,
// refused, stands by — that attempt IS its tick, and what its /health watches
// (ADR §4.9 row 14). A standby that is granted the lock takes over AT THAT TICK,
// knowing nothing the old holder knew, so its first selection is a FULL PASS
// (DueSelector.takeover): what it heard as a standby is not everything that
// happened. NO FENCE IS NEEDED: every write here is a scheduling hint, idempotent,
// and a split brain doubles reads and writes but cannot spend — money's
// exclusivity is the vault lease (src/dispatch-store.ts).
//
// EACH TICK OF THE HOLDER, IN ADR §3.8's ORDER:
//   1. the chain snapshot (program, config, pause, crank), and `crank-low`
//      for the fleet;
//   2. discovery into keeper_link: a listing (C6's V2 first under `gpa-v2`,
//      V1 otherwise), upserted, with the links it no longer returns marked
//      gone and every vault it names given a row as fleet.new_vault_system says
//      (plan design detail 3: 'legacy' until P3d, then 'draining', which only
//      the handover's `arm` moves to the queue). A FAILED LISTING DOES NOT
//      FAIL THE TICK: the last-known-good list is keeper_link itself, re-read
//      fresh by address (L3's rule, now persisted, so a new holder has it too);
//      warn after three failures, critical once the list is ten minutes old;
//   3. the selection (src/scheduler-select.ts: Doorbell.select ported to
//      vault_work), written as due times — and, under `lamports-filter` (C7),
//      the batch read that lets the scheduler COMPLETE a quiet vault itself
//      instead of handing a worker a job that would only find nothing;
//   4. the webhook sync — by the lock holder only, and ONLY WHEN THE FLEET
//      SAYS THE WEBHOOK IS THE SCHEDULER'S (fleet.webhook_owner). Until the last
//      vault moves (P3d) it is the legacy profit keeper's (plan design detail
//      2): two writers of one webhook would undo each other's PUTs at 100
//      credits each. So until then nothing is synced here, Helius delivers to
//      the legacy keeper, no bell reaches a scheduler, and every tick is a full
//      pass — which at N ≤ 50 is what every tick is anyway (doorbell.ts:93);
//   5. the reap: a vault whose lease lapsed PARK_AFTER_ATTEMPTS claims in a row
//      is parked; an intent nobody reclaimed for ten minutes is resolved where
//      the chain alone can say how it ended; resolved intents and rpc_usage are
//      pruned at 35 days, once an hour;
//   6. the quotas: each live worker's share of the plan's rate and of the
//      organisation's Jupiter minute (src/rpc-quota.ts, through the store);
//   7. the credit governor: the month's credits from rpc_usage, and the safety
//      pass it allows (src/credit-governor.ts) — read by the next selection.
// The rankings are not in the tick: every replica serves /leaderboard, so each
// keeps its own, debounced (src/scheduler-board.ts).
//
// WHAT A DUE TIME IS NOT. A vault whose last job did not rest is "busy", and the
// legacy keeper turned it every sweep; here its job's COMPLETE already set when
// it is due again, by outcome (ADR §3.7: 15 s for finality, 60 s for a retry, 10
// minutes for a missing signer, 5 for a refusal), and the scheduler leaves that
// alone. A vault that RESTS is due again when its job said — the safety pass —
// and the scheduler brings it forward for a bell, a new link, a full pass or the
// safety slice. A due time only ever moves earlier (src/scheduler-pg.ts).
//
// ONE TICK AT A TIME: an overrunning tick makes the next one a skip, counted;
// a skip does not move /health's clock, a tick that runs does. A tick blocked on
// a call that never returns stops moving it, and the watchdog (src/watchdog.ts,
// wired by bin/scheduler.mts) exits the process within max(3 ticks, 10 min):
// its session dies with it, the lock is free, and the standby takes it at its
// next tick (ADR §4.9 row 15).
//
// DARK. Only bin/scheduler.mts constructs this, production starts no such
// process, and with SIP_SOLANA_DISPATCH unset or off that entry point does
// nothing at all.

import { summarizeUpstreamError } from "@sip/solana-log";
import type { Alert, Alerter } from "./alerts.js";
import type { ChainSnapshot } from "./chain-state.js";
import type { DispatchMode } from "./cuts.js";
import { CREDIT_GOVERNOR_ALERT_KEY, type CreditGovernor, type GovernorVerdict } from "./credit-governor.js";
import { DISCOVERY_STALE_ALERT_KEY, DISCOVERY_STALE_CRITICAL_AGE_MS, discoveryStaleAlert } from "./discovery-lkg.js";
import type { DiscoveryMethod, DiscoveryReport, ManagedLink } from "./discovery.js";
import type { IntentOutcome, Lane, QuotaHandOut } from "./dispatch-store.js";
import { DOORBELL_DEAF_ALERT_KEY, ECHO_DEADLINE_MS, SAFETY_PASS_MS, doorbellDeafAlert } from "./doorbell.js";
import { BELL_DELAY_MS } from "./fleet-receiver.js";
import { LamportsFilter, type LamportsFilterStatus, type LinkFingerprint } from "./lamports-filter.js";
import { DueSelector, type SelectLane, type SelectLink, type SelectTrust, type VaultBellState } from "./scheduler-select.js";
import type { FleetRead, HookEvidence, LinkRow, LockState, ParkedVault, SchedulerLock, StaleIntent, VaultSystem, WorkRow } from "./scheduler-pg.js";

/** The scheduler's advisory lock, beside sip-solana-keeper and sip-solana-volume-keeper (ADR §3.8). */
export const SCHEDULER_LOCK_NAME = "sip-solana-scheduler";

/** Failed listings in a row before discovery-stale warns (ADR §3.8 step 2). */
export const DISCOVERY_WARN_AFTER_FAILURES = 3;

/** Failed ticks in a row before scheduler-tick-failed pages. */
export const TICK_FAILED_CRITICAL_STREAK = 3;

/** How often the reap prunes: hourly. Pruning is a retention, not a clock. */
export const PRUNE_EVERY_MS = 60 * 60_000;

/** The crank thresholds of the legacy profit keeper (bin/keeper.mts), for the fleet's crank. */
export const CRANK_LOW_WARN_LAMPORTS = 20_000_000n;
export const CRANK_LOW_CRITICAL_LAMPORTS = 5_000_000n;

/** SIP_SOLANA_DISPATCH's values: src/cuts.ts's one reader, shared with the legacy keepers and the workers. */
export type { DispatchMode };

/** Each vault's invest half, decided dry from one batch snapshot (C5 inside the scheduler). */
export interface InvestRestVerdict {
  /** True only for an at-rest outcome decided from the snapshot that sends nothing and may rest. */
  readonly rests: boolean;
  readonly outcome: string;
  readonly detail: string;
}

/** What the scheduler asks of the chain. Every call goes through the process's budgeted pool, lane `sched`. */
export interface SchedulerChain {
  snapshot(): Promise<ChainSnapshot>;
  /** The listing, with its context slot. Throws when nothing could list. */
  list(): Promise<DiscoveryReport>;
  /** The links at these addresses, read fresh (L3's re-read). Throws when the read is refused. */
  reread(addresses: readonly string[]): Promise<readonly ManagedLink[]>;
  /** C7: each wallet's lamports and its wSOL ATA's balance, and the batch's context slot. */
  fingerprints(
    wallets: readonly string[],
  ): Promise<{ readonly slot: number; readonly byWallet: ReadonlyMap<string, { readonly lamports: bigint; readonly wsol: bigint }> }>;
  /** C5: the invest half of each vault, dry, from one batch snapshot. Never throws per vault: a vault it cannot say rests not. */
  investAtRest(
    vaults: readonly string[],
    input: { readonly crankLamports: bigint | null; readonly protocolPaused: boolean },
  ): Promise<ReadonlyMap<string, InvestRestVerdict>>;
  finalizedHeight(): Promise<bigint>;
  /** getSignatureStatuses with history: null where the chain knows no such transaction. */
  signatureStatuses(signatures: readonly string[]): Promise<readonly ({ readonly err: unknown } | null)[]>;
}

/** The statements the tick runs (PgSchedulerStore, src/scheduler-pg.ts). */
export interface SchedulerStore {
  readFleet(): Promise<FleetRead>;
  upsertLinks(links: readonly LinkRow[], seenSlot: number): Promise<number>;
  markGone(listed: readonly string[]): Promise<readonly string[]>;
  cachedLinks(): Promise<{ readonly links: readonly LinkRow[]; readonly newestSeenAt: number | null }>;
  ensureVaults(vaults: readonly string[]): Promise<readonly { readonly vault: string; readonly system: VaultSystem }[]>;
  readWork(vaults: readonly string[]): Promise<{ readonly now: number | null; readonly rows: readonly WorkRow[] }>;
  markDue(entries: readonly { readonly vault: string; readonly lane: Lane }[], bellDelayMs: number): Promise<readonly string[]>;
  completeIdle(
    entries: readonly { readonly vault: string; readonly fence: bigint; readonly bellAt: number | null }[],
    dueInMs: number,
    detail: string,
  ): Promise<readonly string[]>;
  retireUnlinked(listedVaults: readonly string[]): Promise<readonly string[]>;
  writeTick(schedulerId: string, discoveryOk: boolean): Promise<void>;
  park(): Promise<readonly ParkedVault[]>;
  staleIntents(): Promise<readonly StaleIntent[]>;
  pruneIntents(): Promise<number>;
  hookEvidence(sinceMs: number, echoDeadlineMs: number): Promise<HookEvidence>;
}

/** The webhook sync, as the lock holder runs it (bin/scheduler.mts wraps WebhookSync). */
export interface SchedulerWebhook {
  /** Starts a sync if one is due; never awaited by the tick (WebhookSync.tick). */
  tick(input: { readonly addresses: readonly string[]; readonly now: number }): void;
  /** What Helius is confirmed to watch, or null when nothing is managed. */
  watched(): ReadonlySet<string> | null;
  /** doorbell-sync's decision (WebhookSync.syncAlert). */
  alert(): { readonly fire: Alert | null; readonly clear: boolean };
}

export interface SchedulerOptions {
  /** This process's worker_id. */
  readonly id: string;
  readonly mode: Exclude<DispatchMode, "off">;
  /** SIP_SOLANA_SWEEP_MS: the tick. */
  readonly tickMs: number;
  readonly lock: SchedulerLock;
  readonly store: SchedulerStore;
  /** fleet.full_pass_reason, taken (PgFleetStore.takeFullPass, src/fleet-pg.ts). */
  readonly fullPass: { takeFullPass(): Promise<string | null> };
  /** The store's one-time resolution (DispatchStore.resolveIntent). */
  readonly intents: { resolveIntent(id: bigint, outcome: IntentOutcome, resolvedHeight: bigint | null): Promise<boolean> };
  readonly chain: SchedulerChain;
  /** The quota hand-out (DispatchStore.handOutQuotas over the plan's figures), or null. */
  readonly quotas?: (() => Promise<QuotaHandOut>) | null;
  readonly governor?: CreditGovernor | null;
  /** rpc_usage's 35-day prune (PgRpcUsageFeed.prune), or null. */
  readonly pruneUsage?: ((beforeMs: number) => Promise<number>) | null;
  readonly alerter: Pick<Alerter, "fire" | "clear">;
  readonly log: (level: "info" | "warn" | "error", message: string, fields?: Record<string, unknown>) => void;
  /** The `lamports-filter` token (C7). */
  readonly lamportsFilter: boolean;
  /** Whether this scheduler holds a usable SIP_SOLANA_DOORBELL_SECRET: without one no bell can reach it. */
  readonly doorbellSecret: boolean;
  /** The webhook sync, or null when this process cannot manage one. Run only by the holder, only when the fleet says so. */
  readonly webhook?: SchedulerWebhook | null;
  /** /health's clock: called whenever the tick demonstrably moves. */
  readonly progress?: () => void;
  /** This process's clock, for durations and /status only. Every scheduling time is the database's. */
  readonly now?: () => number;
}

/** What one tick did: the tests' handle and the log line. */
export type TickReport =
  | { readonly kind: "skipped" }
  | { readonly kind: "standby"; readonly lock: Extract<LockState, "standby" | "lost"> }
  | { readonly kind: "failed"; readonly error: string }
  | {
      readonly kind: "acted";
      readonly tookOver: boolean;
      readonly discovery: { readonly source: "fresh" | "lkg" | "none"; readonly method: DiscoveryMethod | null; readonly links: number; readonly freshLinks: boolean };
      readonly fullReason: string | null;
      readonly lanes: Readonly<Record<SelectLane, number>>;
      /** Vaults made due this tick. */
      readonly marked: readonly string[];
      /** Vaults the scheduler completed itself (C7). */
      readonly completedIdle: readonly string[];
      /** Vaults selected busy, left to their own retry time. */
      readonly leftBusy: number;
      readonly parked: readonly ParkedVault[];
      readonly resolvedIntents: number;
      readonly quotaWorkers: number | null;
    };

export interface SchedulerStatus {
  readonly role: "acting" | "standby";
  readonly mode: Exclude<DispatchMode, "off">;
  readonly ticks: number;
  readonly standbyTicks: number;
  readonly skipped: number;
  readonly takeovers: number;
  readonly lockLosses: number;
  readonly lastTickAt: string | null;
  readonly lastTickMs: number | null;
  readonly lastTickError: string | null;
  readonly consecutiveFailures: number;
  readonly discovery: {
    readonly source: "fresh" | "lkg" | "none" | null;
    readonly method: DiscoveryMethod | null;
    readonly links: number | null;
    readonly consecutiveFailures: number;
    readonly lkgAgeMs: number | null;
  };
  readonly selection: {
    readonly fullReason: string | null;
    readonly fullPassPending: string | null;
    readonly lanes: Readonly<Record<SelectLane, number>> | null;
    readonly safetyPassMs: number;
    readonly marked: number;
    readonly completedIdle: number;
    readonly leftBusy: number;
  };
  readonly trust: SelectTrust | null;
  readonly webhookOwner: string | null;
  readonly lamportsFilter: LamportsFilterStatus | null;
  readonly reap: { readonly parked: number; readonly resolvedIntents: number; readonly prunedIntents: number; readonly prunedUsage: number };
  readonly quotas: QuotaHandOut | null;
  readonly governor: GovernorVerdict | null;
}

const toRow = (link: ManagedLink): LinkRow => ({
  link: link.linkAddress.toBase58(),
  wallet: link.wallet.toBase58(),
  vault: link.vault.toBase58(),
  epoch: link.epoch,
  nonce: link.settlementNonce,
  frontier: link.frontierSlot,
});

/**
 * The doorbell's trust, from what the replicas' receivers wrote to Postgres
 * (Doorbell.trust, ported): heard since this scheduler took the lock — a bell
 * or an echo written since — and not deaf, which is a LANDED intent no delivery
 * echoed within ECHO_DEADLINE_MS, unless something was heard after it. Never
 * trusted without a doorbell secret, or while the webhook is the legacy
 * keeper's (no delivery reaches a scheduler then).
 */
export function doorbellTrust(input: {
  readonly doorbellSecret: boolean;
  readonly webhookOwner: string;
  readonly takeoverAt: number;
  readonly evidence: HookEvidence | null;
}): SelectTrust {
  if (!input.doorbellSecret) {
    return { enabled: false, trusted: false, reason: "this scheduler holds no usable SIP_SOLANA_DOORBELL_SECRET, so no bell can reach it; every tick is a full pass" };
  }
  if (input.webhookOwner !== "scheduler") {
    return {
      enabled: false,
      trusted: false,
      reason:
        "the webhook is the legacy profit keeper's until the last vault moves to the queue (fleet.webhook_owner): Helius delivers there, " +
        "so every tick is a full pass",
    };
  }
  const evidence = input.evidence;
  const heardAt = Math.max(evidence?.lastBellAt ?? Number.NEGATIVE_INFINITY, evidence?.lastEchoAt ?? Number.NEGATIVE_INFINITY);
  if (!(heardAt >= input.takeoverAt)) {
    return { enabled: true, trusted: false, reason: "no delivery has rung a vault since this scheduler took the lock; every tick is a full pass until one does" };
  }
  if (evidence?.deafSince !== null && evidence?.deafSince !== undefined && heardAt <= evidence.deafSince) {
    return {
      enabled: true,
      trusted: false,
      reason: `a transaction a worker sent landed and did not come back through the webhook within ${ECHO_DEADLINE_MS / 1000} s; every tick is a full pass until a delivery arrives`,
    };
  }
  return { enabled: true, trusted: true, reason: null };
}

export class Scheduler {
  readonly #o: SchedulerOptions;
  readonly #now: () => number;
  readonly #selector = new DueSelector();
  readonly #filter: LamportsFilter | null;
  #running = false;
  #acting = false;
  /** The database's clock when this process last took the lock. */
  #takeoverAt = 0;
  /** The first full pass after a takeover is still to come: its probes are staggered (RT-19). */
  #bootPassPending = false;
  /** Set between a selection and its due times being written: a tick that dies there owes a full pass. */
  #selectionOutstanding = false;
  #everTrusted = false;
  #listingFailures = 0;
  #tickFailures = 0;
  #lastPruneAt: number | null = null;

  #ticks = 0;
  #standbyTicks = 0;
  #skipped = 0;
  #takeovers = 0;
  #lockLosses = 0;
  #lastTickAt: number | null = null;
  #lastTickMs: number | null = null;
  #lastTickError: string | null = null;
  #discovery: SchedulerStatus["discovery"] = { source: null, method: null, links: null, consecutiveFailures: 0, lkgAgeMs: null };
  #selection: Omit<SchedulerStatus["selection"], "fullPassPending" | "safetyPassMs"> = { fullReason: null, lanes: null, marked: 0, completedIdle: 0, leftBusy: 0 };
  #trust: SelectTrust | null = null;
  #webhookOwner: string | null = null;
  #parked = 0;
  #resolvedIntents = 0;
  #prunedIntents = 0;
  #prunedUsage = 0;
  #quotas: QuotaHandOut | null = null;

  constructor(options: SchedulerOptions) {
    this.#o = options;
    this.#now = options.now ?? (() => Date.now());
    this.#filter = options.lamportsFilter ? new LamportsFilter() : null;
  }

  /** Whether this process acted at its last tick: it held the lock. */
  get acting(): boolean {
    return this.#acting;
  }

  #progress(): void {
    try {
      this.#o.progress?.();
    } catch {
      // A clock that cannot be stamped is not a reason to stop scheduling.
    }
  }

  #fire(alert: Alert): void {
    try {
      this.#o.alerter.fire(alert);
    } catch {
      // An alert that cannot be sent never fails a tick.
    }
  }

  #clear(key: string): void {
    try {
      this.#o.alerter.clear(key);
    } catch {
      // Same.
    }
  }

  /** One tick. Never throws: a failure is reported, counted, and the next tick tries again. */
  async tick(): Promise<TickReport> {
    if (this.#running) {
      this.#skipped += 1;
      return { kind: "skipped" };
    }
    this.#running = true;
    const began = this.#now();
    this.#progress();
    try {
      const lock = await this.#o.lock.ensure();
      this.#progress();
      if (lock === "lost") {
        this.#lockLosses += 1;
        this.#o.log("warn", "the scheduler lost its lock's session; it stands by and asks again next tick");
        this.#fire({
          key: "scheduler-lock-lost",
          severity: "warn",
          title: "The acting scheduler lost its lock",
          detail: "Its database session for sip-solana-scheduler failed. It stands by; the other replica takes the lock at its next tick and starts with a full pass.",
        });
      }
      if (lock === "standby" || lock === "lost") {
        this.#acting = false;
        this.#standbyTicks += 1;
        return { kind: "standby", lock };
      }
      if (lock === "took") this.#takeover();
      this.#acting = true;
      const report = await this.#act(lock === "took");
      this.#tickFailures = 0;
      this.#lastTickError = null;
      this.#clear("scheduler-tick-failed");
      return report;
    } catch (error) {
      const detail = summarizeUpstreamError(error, { take: 3, maxChars: 500 });
      this.#tickFailures += 1;
      this.#lastTickError = detail;
      // A SELECTION NOBODY MADE DUE is a set of bells nobody will answer (Doorbell's rule).
      if (this.#selectionOutstanding) this.#selector.requestFullPass("the previous tick failed before it made its selection due");
      this.#selectionOutstanding = false;
      this.#o.log("error", "scheduler tick failed", { detail, consecutiveFailures: this.#tickFailures });
      this.#fire({
        key: "scheduler-tick-failed",
        severity: this.#tickFailures >= TICK_FAILED_CRITICAL_STREAK ? "critical" : "warn",
        title: "The scheduler's tick is failing",
        detail: `${this.#tickFailures} tick${this.#tickFailures === 1 ? "" : "s"} in a row: ${detail}. Due vaults are still claimed and worked; nothing new is made due.`,
      });
      return { kind: "failed", error: detail };
    } finally {
      this.#running = false;
      this.#lastTickAt = this.#now();
      this.#lastTickMs = this.#lastTickAt - began;
      this.#progress();
    }
  }

  #takeover(): void {
    this.#takeovers += 1;
    this.#selector.takeover();
    this.#filter?.takeover();
    this.#bootPassPending = true;
    this.#everTrusted = false;
    this.#o.log("info", "took the scheduler lock: this tick is a full pass", { scheduler: this.#o.id });
    this.#clear("scheduler-lock-lost");
  }

  async #act(tookOver: boolean): Promise<TickReport> {
    const o = this.#o;
    const fleet = await o.store.readFleet();
    this.#progress();
    if (tookOver) this.#takeoverAt = fleet.now;
    this.#webhookOwner = fleet.webhookOwner;
    const asked = await o.fullPass.takeFullPass();
    if (asked !== null) this.#selector.requestFullPass(asked);

    // 1. THE CHAIN SNAPSHOT.
    const snapshot = await o.chain.snapshot();
    this.#progress();
    this.#crankAlert(snapshot);
    const protocolPaused = snapshot.config?.paused === true;

    // 2. DISCOVERY.
    const found = snapshot.programDeployed === false ? null : await this.#discover(fleet.now);
    this.#progress();
    const links: readonly LinkRow[] = found?.links ?? [];
    const linksByVault = new Map<string, LinkRow[]>();
    for (const link of links) linksByVault.set(link.vault, [...(linksByVault.get(link.vault) ?? []), link]);

    // 3. THE ROWS, AND WHAT THE JOBS SINCE THE LAST TICK LEFT ON THEM.
    const work = await o.store.readWork([...linksByVault.keys()]);
    this.#progress();
    const now = work.now ?? fleet.now;
    const rows = new Map(work.rows.map((row) => [row.vault, row] as const));
    for (const row of work.rows) this.#filter?.observe(row.vault, { claimedAt: row.claimedAt, doneAt: row.doneAt, rests: row.rests, held: row.held });
    this.#filter?.prune(new Set(links.map((l) => l.link)), new Set(linksByVault.keys()));

    // 4. THE SELECTION, over the vaults the queue owns.
    const queueLinks: SelectLink[] = links.filter((l) => rows.get(l.vault)?.system === "queue").map((l) => ({ link: l.link, wallet: l.wallet, vault: l.vault }));
    const evidence = this.#o.doorbellSecret && fleet.webhookOwner === "scheduler" ? await o.store.hookEvidence(this.#takeoverAt, ECHO_DEADLINE_MS) : null;
    const trust = doorbellTrust({ doorbellSecret: o.doorbellSecret, webhookOwner: fleet.webhookOwner, takeoverAt: this.#takeoverAt, evidence });
    this.#trust = trust;
    this.#deafAlert(trust);
    const bells = new Map<string, VaultBellState>();
    for (const row of work.rows) bells.set(row.vault, { bellAt: row.bellAt, rests: row.doneAt === null ? null : row.rests, claimedAt: row.claimedAt });
    const passMs = o.governor?.safetyPassMs ?? SAFETY_PASS_MS;
    const watched = fleet.webhookOwner === "scheduler" ? (o.webhook?.watched() ?? null) : null;
    const selection = this.#selector.select({ links: queueLinks, vaults: bells, now, tickMs: o.tickMs, passMs, protocolPaused, trust, watched });
    this.#selectionOutstanding = selection.vaults.size > 0;

    const toMark: { vault: string; lane: Lane }[] = [];
    const candidates: string[] = [];
    let leftBusy = 0;
    for (const [vault, lane] of selection.vaults) {
      const row = rows.get(vault);
      if (row === undefined || row.held || row.parked || row.system !== "queue") continue;
      if (lane === "busy") {
        leftBusy += 1;
        continue;
      }
      const quiet = (lane === "full" || lane === "safety") && row.rests && row.doneAt !== null && row.openIntents === 0;
      if (this.#filter !== null && quiet) candidates.push(vault);
      else toMark.push({ vault, lane });
    }

    // C7: the batch read, and a quiet vault completed here rather than by a job.
    const idle =
      this.#filter === null
        ? []
        : await this.#filterQuiet(candidates, toMark, selection.vaults, linksByVault, rows, found?.freshLinks === true, snapshot, protocolPaused, now, selection.fullReason !== null);
    const marked = await o.store.markDue(toMark, BELL_DELAY_MS);
    const completedIdle =
      idle.length === 0
        ? []
        : await o.store.completeIdle(
            idle.map((vault) => ({ vault, fence: rows.get(vault)!.fence, bellAt: rows.get(vault)!.bellAt })),
            passMs,
            "decided by the scheduler from its batch read (lamports-filter): no wallet of the vault moved since a real probe that rested, and its invest half rests on the snapshot",
          );
    this.#selectionOutstanding = false;
    this.#progress();
    this.#selection = { fullReason: selection.fullReason, lanes: selection.lanes, marked: marked.length, completedIdle: completedIdle.length, leftBusy };

    await o.store.writeTick(o.id, found?.source === "fresh");

    // 4b. THE WEBHOOK, by the holder, only when it is the scheduler's and the listing is fresh (L3's rule).
    if (o.mode === "on" && fleet.webhookOwner === "scheduler" && o.webhook && found?.source === "fresh" && links.length > 0) {
      o.webhook.tick({ addresses: [...new Set(links.flatMap((l) => [l.wallet, l.vault]))], now: this.#now() });
      const alert = o.webhook.alert();
      if (alert.fire !== null) this.#fire(alert.fire);
      else if (alert.clear) this.#clear("doorbell-sync");
    }

    // 5. THE REAP.
    const parked = await o.store.park();
    this.#parked += parked.length;
    for (const vault of parked) {
      this.#fire({
        key: `vault-parked:${vault.vault}`,
        severity: "critical",
        title: "The scheduler parked a vault: its jobs never complete",
        detail: `Vault ${vault.vault}: ${vault.attempts} claims in a row lapsed without a completion. No worker takes it until an operator clears vault_work.parked_reason; its open intents wait for that claim.`,
        context: { vault: vault.vault, attempts: vault.attempts },
      });
    }
    const resolvedIntents = await this.#reapIntents();
    await this.#prune();
    this.#progress();

    // 6. THE QUOTAS.
    let quotaWorkers: number | null = null;
    if (o.quotas) {
      this.#quotas = await o.quotas();
      quotaWorkers = this.#quotas.workers.length;
    }

    // 7. THE GOVERNOR: the safety pass the next selection reads.
    if (o.governor) {
      const verdict = await o.governor.evaluate();
      if (verdict.alert.fire !== null) this.#fire(verdict.alert.fire);
      else if (verdict.alert.clear) this.#clear(CREDIT_GOVERNOR_ALERT_KEY);
    }

    this.#ticks += 1;
    return {
      kind: "acted",
      tookOver,
      discovery: { source: found?.source ?? "none", method: found?.method ?? null, links: links.length, freshLinks: found?.freshLinks === true },
      fullReason: selection.fullReason,
      lanes: selection.lanes,
      marked,
      completedIdle,
      leftBusy,
      parked,
      resolvedIntents,
      quotaWorkers,
    };
  }

  /**
   * Discovery (ADR §3.8 step 2): a successful listing becomes keeper_link and
   * the vaults' rows; a failed one falls back to keeper_link re-read fresh, and
   * — when even that read is refused — to keeper_link's addresses alone, which
   * still lets bells and the safety rotation be scheduled (every job re-reads
   * its links anyway) but lets C7 skip nothing.
   */
  async #discover(now: number): Promise<{
    readonly source: "fresh" | "lkg";
    readonly method: DiscoveryMethod | null;
    readonly links: readonly LinkRow[];
    readonly freshLinks: boolean;
  }> {
    const o = this.#o;
    let report: DiscoveryReport;
    try {
      report = await o.chain.list();
    } catch (listingError) {
      this.#listingFailures += 1;
      const cached = await o.store.cachedLinks();
      if (cached.links.length === 0) throw listingError;
      const lkgAgeMs = cached.newestSeenAt === null ? null : Math.max(0, now - cached.newestSeenAt);
      let links: readonly LinkRow[] = cached.links;
      let freshLinks = false;
      try {
        links = (await o.chain.reread(cached.links.map((l) => l.link))).map(toRow);
        freshLinks = true;
      } catch {
        // The addresses alone: the RPC that refused the listing refused this too.
      }
      const detail = summarizeUpstreamError(listingError, { take: 3, maxChars: 500 });
      this.#discovery = { source: "lkg", method: null, links: links.length, consecutiveFailures: this.#listingFailures, lkgAgeMs };
      o.log("warn", "the link listing failed; this tick schedules keeper_link's last-known-good list", {
        links: links.length,
        freshLinks,
        lkgAgeMs,
        consecutiveFailures: this.#listingFailures,
        detail,
      });
      if (this.#listingFailures >= DISCOVERY_WARN_AFTER_FAILURES || (lkgAgeMs ?? 0) > DISCOVERY_STALE_CRITICAL_AGE_MS) {
        this.#fire(discoveryStaleAlert(this.#listingFailures, lkgAgeMs ?? 0, detail));
      }
      return { source: "lkg", method: null, links, freshLinks };
    }
    this.#listingFailures = 0;
    this.#clear(DISCOVERY_STALE_ALERT_KEY);
    const links = report.links.map(toRow);
    const vaults = [...new Set(links.map((l) => l.vault))];
    await o.store.upsertLinks(links, report.contextSlot ?? 0);
    const gone = await o.store.markGone(links.map((l) => l.link));
    const created = await o.store.ensureVaults(vaults);
    const retired = await o.store.retireUnlinked(vaults);
    if (gone.length > 0 || created.length > 0 || retired.length > 0) {
      o.log("info", "discovery changed the fleet", { gone: gone.length, newVaults: created.length, retired: retired.length });
    }
    this.#discovery = { source: "fresh", method: report.method, links: links.length, consecutiveFailures: 0, lkgAgeMs: null };
    return { source: "fresh", method: report.method, links, freshLinks: true };
  }

  /**
   * C7 (src/lamports-filter.ts) over this tick's selection: the wallets of
   * every vault the tick makes due are fingerprinted — so a job that then rests
   * leaves a memo — and each quiet candidate whose every link may skip its real
   * probe has its invest half decided dry from one batch snapshot. Returns the
   * vaults to complete here; every other candidate joins `toMark`.
   *
   * A BATCH THAT FAILS IS THE PLAIN PATH: every candidate becomes a job.
   */
  async #filterQuiet(
    candidates: readonly string[],
    toMark: { vault: string; lane: Lane }[],
    lanes: ReadonlyMap<string, SelectLane>,
    linksByVault: ReadonlyMap<string, readonly LinkRow[]>,
    rows: ReadonlyMap<string, WorkRow>,
    freshLinks: boolean,
    snapshot: ChainSnapshot,
    protocolPaused: boolean,
    now: number,
    fullPass: boolean,
  ): Promise<string[]> {
    const filter = this.#filter!;
    const enqueue = (vault: string): void => {
      toMark.push({ vault, lane: lanes.get(vault) ?? "safety" });
    };
    const vaultsRead = [...new Set([...toMark.map((m) => m.vault), ...candidates])];
    if (vaultsRead.length === 0) return [];
    const wallets = [...new Set(vaultsRead.flatMap((vault) => (linksByVault.get(vault) ?? []).map((l) => l.wallet)))];
    let read: Awaited<ReturnType<SchedulerChain["fingerprints"]>> | null = null;
    try {
      read = await this.#o.chain.fingerprints(wallets);
    } catch (error) {
      this.#o.log("warn", "the lamports-filter batch read failed; every quiet vault this tick is a job", { detail: summarizeUpstreamError(error) });
    }
    this.#progress();
    const fingerprintsOf = (vault: string): Map<string, LinkFingerprint> | null => {
      if (read === null || !freshLinks) return null;
      const out = new Map<string, LinkFingerprint>();
      for (const link of linksByVault.get(vault) ?? []) {
        const seen = read.byWallet.get(link.wallet);
        if (seen === undefined) return null;
        out.set(link.link, { lamports: seen.lamports, wsol: seen.wsol, slot: read.slot, nonce: link.nonce, frontier: link.frontier });
      }
      return out.size === 0 ? null : out;
    };

    const settleQuiet: string[] = [];
    for (const vault of candidates) {
      const prints = fingerprintsOf(vault);
      const quiet = prints !== null && [...prints].every(([link, print]) => filter.canSkip(link, print, now).skip);
      if (quiet) settleQuiet.push(vault);
      else enqueue(vault);
    }
    const idle: string[] = [];
    if (settleQuiet.length > 0) {
      let verdicts: ReadonlyMap<string, InvestRestVerdict> = new Map();
      try {
        verdicts = await this.#o.chain.investAtRest(settleQuiet, { crankLamports: snapshot.crankLamports, protocolPaused });
      } catch (error) {
        this.#o.log("warn", "the invest snapshot for quiet vaults failed; they are jobs this tick", { detail: summarizeUpstreamError(error) });
      }
      this.#progress();
      for (const vault of settleQuiet) {
        if (verdicts.get(vault)?.rests === true && rows.get(vault)?.rests === true) idle.push(vault);
        else enqueue(vault);
      }
    }
    // THE READS BEFORE THE PROBES: every vault made due carries the fingerprints
    // read now, and the job that then rests turns them into memos.
    const due = toMark.map((m) => m.vault);
    if (fullPass && this.#bootPassPending) {
      filter.planBootPass(due.flatMap((vault) => (linksByVault.get(vault) ?? []).map((l) => l.link)), now);
      this.#bootPassPending = false;
    }
    for (const vault of due) {
      const prints = fingerprintsOf(vault);
      if (prints !== null) filter.enqueued(vault, prints, now);
    }
    return idle;
  }

  /**
   * Intents nobody reclaimed (ADR §3.8 step 6): resolved where the chain alone
   * says how they ended. A known signature the chain has is landed (or failed,
   * when it reverted); an intent the chain does not know, past its last valid
   * height by the FINALIZED height, expired. The resolved height is the last
   * valid height in every case — the latest height at which it could have
   * acted, so the plan floor (src/dispatch-store.ts) is exactly what it was
   * while the row was open. A settle whose signature Privy never gave back is
   * left to the next job's takeover rule, which reads the link's nonce.
   */
  async #reapIntents(): Promise<number> {
    const o = this.#o;
    const stale = await o.store.staleIntents();
    if (stale.length === 0) return 0;
    const finalized = await o.chain.finalizedHeight();
    const signed = stale.filter((intent) => intent.signature !== null);
    const statuses = signed.length === 0 ? [] : await o.chain.signatureStatuses(signed.map((intent) => intent.signature!));
    const statusOf = new Map(signed.map((intent, index) => [intent.id, statuses[index] ?? null] as const));
    let resolved = 0;
    for (const intent of stale) {
      const status = statusOf.get(intent.id) ?? null;
      let outcome: IntentOutcome | null = null;
      if (status !== null) outcome = status.err === null || status.err === undefined ? "landed" : "failed";
      else if (finalized > intent.lastValidBlockHeight && (intent.signature !== null || intent.kind !== "settle")) outcome = "expired";
      if (outcome === null) continue;
      if (await o.intents.resolveIntent(intent.id, outcome, intent.lastValidBlockHeight)) resolved += 1;
    }
    this.#resolvedIntents += resolved;
    return resolved;
  }

  async #prune(): Promise<void> {
    const at = this.#now();
    if (this.#lastPruneAt !== null && at - this.#lastPruneAt < PRUNE_EVERY_MS) return;
    this.#lastPruneAt = at;
    this.#prunedIntents += await this.#o.store.pruneIntents();
    if (this.#o.pruneUsage) this.#prunedUsage += await this.#o.pruneUsage(at - 35 * 24 * 60 * 60_000);
  }

  #crankAlert(snapshot: ChainSnapshot): void {
    const keeper = snapshot.config?.keeper;
    if (keeper === undefined || snapshot.crankLamports === null) return;
    const lamports = snapshot.crankLamports;
    if (lamports < CRANK_LOW_WARN_LAMPORTS) {
      this.#fire({
        key: "crank-low",
        severity: lamports < CRANK_LOW_CRITICAL_LAMPORTS ? "critical" : "warn",
        title: "The fleet's crank is running out of SOL",
        detail: `${lamports} lamports left; every worker's wrap, convert and buy stops when it empties`,
        context: { crank: keeper.toBase58() },
      });
    } else {
      this.#clear("crank-low");
    }
  }

  #deafAlert(trust: SelectTrust): void {
    if (!trust.enabled) return;
    if (trust.trusted) this.#everTrusted = true;
    const decision = doorbellDeafAlert({ trusted: trust.trusted, reason: trust.reason }, this.#everTrusted);
    if (decision.fire !== null) this.#fire(decision.fire);
    else if (decision.clear) this.#clear(DOORBELL_DEAF_ALERT_KEY);
  }

  status(): SchedulerStatus {
    return {
      role: this.#acting ? "acting" : "standby",
      mode: this.#o.mode,
      ticks: this.#ticks,
      standbyTicks: this.#standbyTicks,
      skipped: this.#skipped,
      takeovers: this.#takeovers,
      lockLosses: this.#lockLosses,
      lastTickAt: this.#lastTickAt === null ? null : new Date(this.#lastTickAt).toISOString(),
      lastTickMs: this.#lastTickMs,
      lastTickError: this.#lastTickError,
      consecutiveFailures: this.#tickFailures,
      discovery: this.#discovery,
      selection: { ...this.#selection, fullPassPending: this.#selector.fullPassPending, safetyPassMs: this.#o.governor?.safetyPassMs ?? SAFETY_PASS_MS },
      trust: this.#trust,
      webhookOwner: this.#webhookOwner,
      lamportsFilter: this.#filter?.status() ?? null,
      reap: { parked: this.#parked, resolvedIntents: this.#resolvedIntents, prunedIntents: this.#prunedIntents, prunedUsage: this.#prunedUsage },
      quotas: this.#quotas,
      governor: this.#o.governor?.verdict ?? null,
    };
  }
}
