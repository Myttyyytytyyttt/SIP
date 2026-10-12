// ONE WORKER PROCESS: s slots, a claim loop, the heartbeat on a timer of its own,
// the job ceiling and the SIGTERM drain (dispatcher ADR §3.2, §3.5, §3.7, §3.11;
// §4.9 rows 3, 6, 7, 27; plan P3a Q3). bin/worker.mts runs one; a fleet is r of
// them. The job itself is src/worker-job.ts; test-local/fence-drill-worker.ts is
// this loop's model, with the chain made of a table.
//
// THE CLAIM LOOP. While a slot is free and the process is not stopping, CLAIM up
// to that many due vaults (FOR UPDATE SKIP LOCKED, fence + 1, a 45 s lease) and
// start a job for each. Nothing claimed: wait CLAIM_IDLE_MS, or less if a job
// ends first. A claim that fails is logged and waited out the same way.
//
// THE HEARTBEAT, EVERY HEARTBEAT_EVERY_MS ON ITS OWN TIMER, never behind a step a
// job is awaiting (ADR §3.7). One statement renews every (vault, fence) this
// process holds; a vault missing from the answer has lost its lease — or passed
// the 6-minute ceiling, which the statement refuses to renew — and its job stops
// at its next step: mayAct answers why, and the fence refuses the next gate on
// its own. Then the process's own beat (`beat`: its worker row, its quotas, its
// usage), which can fail without touching any lease.
//
// THE CEILING, JOB_CEILING_MINUTES AFTER THE CLAIM: the job's AbortSignal fires.
// Every RPC request it has in flight or waiting for budget carries that signal
// (withRpcLane, src/rpc-budget.ts), mayAct answers "past its ceiling", so no gate
// is asked again, and the vault is RELEASED at once — due now, for whoever claims
// it next, whose takeover waits out anything this job sent. A job that hangs
// past it is abandoned, never awaited: its slot is free again.
//
// SIGTERM (stop). No new claim. Every job is told it may not act (no new send
// starts; a CrankSender also stops starting buys), and is given up to drainMs —
// SIGTERM_DRAIN_MS, which needs RAILWAY_DEPLOYMENT_DRAINING_SECONDS ≥ 30 (owner
// decision 6) — to finish a confirm already in flight and end on its own. Then
// every job still running is aborted, every vault still held is RELEASED, due
// now, and counted (releasedOnSigterm), and the process's row is closed. Without
// the drain setting the process is killed first: the leases expire within 45 s
// and the takeover rule covers the rest (§4.9 row 27).

import { summarizeUpstreamError } from "@sip/solana-log";
import type { ClaimedVault, Completion, DispatchStore, GateAnswer, IntentKind } from "./dispatch-store.js";
import { HEARTBEAT_EVERY_MS, JOB_CEILING_MINUTES } from "./dispatch-store.js";
import { SIGTERM_DRAIN_MS, type CrankSender } from "./explicit-send.js";
import { withRpcLane } from "./rpc-budget.js";
import type { JobEnd } from "./worker-job.js";

/** The job ceiling, in ms (ADR §3.7): the heartbeat stops renewing a lease claimed longer ago. */
export const JOB_CEILING_MS = JOB_CEILING_MINUTES * 60_000;
/** The soft deadline: no new phase of a job starts after it (ADR §3.7). */
export const JOB_SOFT_DEADLINE_MS = 4 * 60_000;
/** How long the loop waits before claiming again when the last claim found nothing. */
export const CLAIM_IDLE_MS = 2_000;
/** A job that threw is due again after a tick, not at once (ADR §3.7: RETRY/FAILED 60 s). */
export const THREW_DUE_SECONDS = 60;
/** After the drain, how long an aborted job is given to unwind before the process moves on. */
const ABORT_GRACE_MS = 1_000;

/** What the loop needs of the store. */
export type WorkerLoopStore = Pick<DispatchStore, "claim" | "heartbeat" | "complete" | "release" | "holder">;

/** What a job is handed by the loop that runs it. */
export interface JobControl {
  /** Fires at the ceiling, or when a SIGTERM's drain has run out. */
  readonly signal: AbortSignal;
  /** Why the job may not go on — its lease lost, its ceiling passed, the process draining — or null. */
  readonly mayAct: () => string | null;
  /** No new phase after this instant. */
  readonly softDeadlineAt: number;
  /** A CrankSender the job made: a SIGTERM drains it. */
  onSender(sender: CrankSender): void;
  /** Every gate's answer, for the fence-reject counters. */
  onGate(kind: IntentKind, answer: GateAnswer): void;
}

export type JobRunner = (claimed: ClaimedVault, control: JobControl) => Promise<JobEnd>;

export interface WorkerLoopOptions {
  readonly store: WorkerLoopStore;
  readonly slots: number;
  readonly runJob: JobRunner;
  /** The process's own beat, after the leases: its worker row, quotas and usage. Its throw is logged. */
  readonly beat?: () => Promise<void>;
  readonly log: (level: "info" | "warn" | "error", message: string, fields: Record<string, unknown>) => void;
  readonly heartbeatMs?: number;
  readonly ceilingMs?: number;
  readonly softDeadlineMs?: number;
  readonly drainMs?: number;
  readonly claimIdleMs?: number;
  readonly now?: () => number;
}

/** The counters a worker's beat writes into its row (src/fleet-status.ts, WORKER_STATS_KEYS). */
export interface WorkerLoopStats {
  readonly fenceRejects: number;
  readonly fenceRejectsLastHour: number;
  readonly leaseLosses: number;
  readonly jobsLast10Min: number;
  readonly releasedOnSigterm: number;
}

interface RunningJob {
  readonly claimed: ClaimedVault;
  readonly controller: AbortController;
  readonly claimedAt: number;
  readonly senders: CrankSender[];
  lost: string | null;
  draining: boolean;
  ceiling: ReturnType<typeof setTimeout> | null;
  /** Settles once the loop has completed or released the vault. */
  done: Promise<void>;
}

/** The process's loop. start() resolves once stop() has drained it. */
export class WorkerLoop {
  readonly #options: WorkerLoopOptions;
  readonly #now: () => number;
  readonly #jobs = new Map<string, RunningJob>();
  #stopping = false;
  #wake: (() => void) | null = null;
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #beating = false;
  #fenceRejects = 0;
  #rejectTimes: number[] = [];
  #jobTimes: number[] = [];
  #leaseLosses = 0;
  #releasedOnSigterm = 0;
  #loop: Promise<void> | null = null;

  constructor(options: WorkerLoopOptions) {
    if (!Number.isSafeInteger(options.slots) || options.slots < 1) throw new Error(`a worker runs at least one slot, not ${options.slots}`);
    this.#options = options;
    this.#now = options.now ?? (() => Date.now());
  }

  /** Slots running a job now: the worker row's `busy`. */
  get busy(): number {
    return this.#jobs.size;
  }

  stats(): WorkerLoopStats {
    const now = this.#now();
    this.#rejectTimes = this.#rejectTimes.filter((at) => now - at < 3_600_000);
    this.#jobTimes = this.#jobTimes.filter((at) => now - at < 600_000);
    return {
      fenceRejects: this.#fenceRejects,
      fenceRejectsLastHour: this.#rejectTimes.length,
      leaseLosses: this.#leaseLosses,
      jobsLast10Min: this.#jobTimes.length,
      releasedOnSigterm: this.#releasedOnSigterm,
    };
  }

  /** Runs the claim loop and the heartbeat until stop() has drained them. */
  start(): Promise<void> {
    if (this.#loop !== null) return this.#loop;
    this.#heartbeat = setInterval(() => void this.beatOnce(), this.#options.heartbeatMs ?? HEARTBEAT_EVERY_MS);
    this.#loop = this.#claimLoop();
    return this.#loop;
  }

  async #claimLoop(): Promise<void> {
    while (!this.#stopping) {
      const free = this.#options.slots - this.#jobs.size;
      let took = 0;
      if (free > 0) {
        let claimed: readonly ClaimedVault[] = [];
        try {
          claimed = await this.#options.store.claim(free);
        } catch (error) {
          this.#options.log("warn", "the claim failed; trying again shortly", { detail: summarizeUpstreamError(error) });
        }
        for (const vault of claimed) {
          if (this.#stopping) {
            // CLAIMED AS THE SIGNAL CAME: handed straight back.
            await this.#release(vault, "SIGTERM before the job started", true);
            continue;
          }
          this.#startJob(vault);
          took += 1;
        }
      }
      if (this.#stopping) break;
      if (took > 0 && this.#jobs.size < this.#options.slots) {
        // A TURN OF THE EVENT LOOP BETWEEN TWO CLAIMS: timers (the heartbeat, a ceiling) must never wait behind a
        // claim loop whose jobs end in microtasks.
        await new Promise<void>((resolve) => setImmediate(resolve));
        continue;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.#options.claimIdleMs ?? CLAIM_IDLE_MS);
        this.#wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.#wake = null;
    }
  }

  #startJob(claimed: ClaimedVault): void {
    const controller = new AbortController();
    const claimedAt = this.#now();
    const job: RunningJob = { claimed, controller, claimedAt, senders: [], lost: null, draining: false, ceiling: null, done: Promise.resolve() };
    const ceilingMs = this.#options.ceilingMs ?? JOB_CEILING_MS;
    job.ceiling = setTimeout(() => controller.abort(new Error(`the job passed its ${ceilingMs / 60_000}-minute ceiling`)), ceilingMs);
    const control: JobControl = {
      signal: controller.signal,
      mayAct: () => {
        if (job.lost !== null) return job.lost;
        if (controller.signal.aborted) return `the job may no longer act: ${summarizeUpstreamError(controller.signal.reason)}`;
        if (job.draining) return "the worker is draining after SIGTERM and starts no new send";
        return null;
      },
      softDeadlineAt: claimedAt + (this.#options.softDeadlineMs ?? JOB_SOFT_DEADLINE_MS),
      onSender: (sender) => {
        job.senders.push(sender);
        if (job.draining) sender.beginDrain();
      },
      onGate: (_kind, answer) => {
        if (answer.kind === "refused") {
          this.#fenceRejects += 1;
          this.#rejectTimes.push(this.#now());
        }
      },
    };
    this.#jobs.set(claimed.vault, job);
    // EVERY RPC REQUEST OF THE JOB CARRIES ITS LANE AND ITS SIGNAL: the safety rotation in `rest`, the rest in `hot`.
    const running = withRpcLane(claimed.lane === "safety" ? "rest" : "hot", () => this.#options.runJob(claimed, control), controller.signal);
    job.done = this.#finish(job, running);
  }

  /** What becomes of the vault once the job ends, throws or is aborted. */
  async #finish(job: RunningJob, running: Promise<JobEnd>): Promise<void> {
    const aborted = new Promise<"aborted">((resolve) => {
      if (job.controller.signal.aborted) resolve("aborted");
      else job.controller.signal.addEventListener("abort", () => resolve("aborted"), { once: true });
    });
    // AN ABANDONED JOB'S LATER THROW IS NOBODY'S: it cannot send (mayAct, the fence), and its slot is already free.
    running.catch(() => undefined);
    let end: { kind: "end"; end: JobEnd } | { kind: "threw"; error: unknown } | { kind: "aborted" };
    try {
      end = await Promise.race([running.then((value) => ({ kind: "end" as const, end: value }), (error: unknown) => ({ kind: "threw" as const, error })), aborted.then(() => ({ kind: "aborted" as const }))]);
    } finally {
      if (job.ceiling !== null) clearTimeout(job.ceiling);
    }
    const { claimed } = job;
    try {
      if (end.kind === "end" && end.end.kind === "complete" && !job.controller.signal.aborted) {
        // COMPLETE IS ITS OWN CHECK: it changes nothing unless this worker still holds the vault at this fence.
        const kept = await this.#complete(claimed, end.end.completion);
        if (!kept) this.#lost(job, "COMPLETE found the lease gone; the job's outcome was discarded");
      } else if (end.kind === "threw" && !job.draining) {
        // A JOB THAT THREW IS NOT HANDED BACK DUE NOW: the same throw would come straight back, claim after
        // claim, in a loop. It completes THREW, due again in a tick, as a turn that threw always was (ADR §3.7).
        const detail = `the job threw: ${summarizeUpstreamError(end.error)}`;
        this.#options.log("error", "a worker job threw; its vault is due again in a minute", { vault: claimed.vault, detail });
        await this.#complete(claimed, { rests: false, lane: "retry", streaks: claimed.streaks, outcome: "THREW", detail, dueInSeconds: THREW_DUE_SECONDS });
      } else {
        // AND SO IS RELEASE: a vault taken over since is left alone; one only past its ceiling is handed back, due now.
        const reason =
          end.kind === "aborted"
            ? summarizeUpstreamError(job.controller.signal.reason)
            : end.kind === "threw"
              ? `the job threw: ${summarizeUpstreamError(end.error)}`
              : end.end.kind === "stop"
                ? end.end.reason
                : "the job could no longer act";
        await this.#release(claimed, reason, job.draining);
      }
    } finally {
      this.#jobs.delete(claimed.vault);
      this.#jobTimes.push(this.#now());
      this.#wake?.();
    }
  }

  async #complete(claimed: ClaimedVault, completion: Completion): Promise<boolean> {
    try {
      return await this.#options.store.complete(claimed, completion);
    } catch (error) {
      // THE LEASE RUNS OUT ON ITS OWN, and the next claim's takeover reads the intents. Nothing is lost but the outcome.
      this.#options.log("warn", "COMPLETE failed; the lease will expire and the vault be claimed again", { vault: claimed.vault, detail: summarizeUpstreamError(error) });
      return true;
    }
  }

  async #release(claimed: ClaimedVault, reason: string, sigterm: boolean): Promise<void> {
    try {
      const released = await this.#options.store.release(claimed, reason);
      if (released && sigterm) this.#releasedOnSigterm += 1;
    } catch (error) {
      this.#options.log("warn", "RELEASE failed; the lease will expire on its own", { vault: claimed.vault, detail: summarizeUpstreamError(error) });
    }
  }

  #lost(job: RunningJob, why: string): void {
    if (job.lost !== null) return;
    job.lost = why;
    this.#leaseLosses += 1;
    this.#options.log("warn", "a vault's lease is lost; its job stops at its next step", { vault: job.claimed.vault, fence: job.claimed.fence.toString(), why });
  }

  /** One heartbeat: the leases, then the process's own beat. Exposed so a test can drive it without a timer. */
  async beatOnce(): Promise<void> {
    if (this.#beating) return;
    this.#beating = true;
    try {
      const held = [...this.#jobs.values()].filter((job) => job.lost === null);
      if (held.length > 0) {
        try {
          const renewed = await this.#options.store.heartbeat(held.map((job) => job.claimed));
          for (const job of held) {
            if (!renewed.has(job.claimed.vault) && this.#jobs.get(job.claimed.vault) === job) {
              this.#lost(job, "the heartbeat no longer renews this vault's lease (lost, or past the job's ceiling); nothing more is sent");
            }
          }
        } catch (error) {
          // NOTHING WAS RENEWED; the gate finds out on its own when the lease runs short.
          this.#options.log("warn", "the heartbeat failed; no lease was renewed", { detail: summarizeUpstreamError(error) });
        }
      }
      try {
        await this.#options.beat?.();
      } catch (error) {
        this.#options.log("warn", "the process beat failed", { detail: summarizeUpstreamError(error) });
      }
    } finally {
      this.#beating = false;
    }
  }

  /**
   * SIGTERM: stop claiming, let what is in flight finish for up to drainMs, then
   * abort and release whatever is still held. Resolves once the claim loop and
   * the heartbeat have stopped.
   */
  async stop(): Promise<{ readonly drained: boolean; readonly released: number }> {
    if (this.#stopping) {
      await this.#loop;
      return { drained: true, released: this.#releasedOnSigterm };
    }
    this.#stopping = true;
    this.#wake?.();
    const before = this.#releasedOnSigterm;
    for (const job of this.#jobs.values()) {
      job.draining = true;
      for (const sender of job.senders) sender.beginDrain();
    }
    const drainMs = this.#options.drainMs ?? SIGTERM_DRAIN_MS;
    const pending = [...this.#jobs.values()].map((job) => job.done);
    const drained = await Promise.race([
      Promise.allSettled(pending).then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), drainMs)),
    ]);
    if (!drained) {
      for (const job of this.#jobs.values()) job.controller.abort(new Error("SIGTERM: the drain ran out before this job ended"));
      await Promise.race([Promise.allSettled([...this.#jobs.values()].map((job) => job.done)), new Promise((resolve) => setTimeout(resolve, ABORT_GRACE_MS))]);
    }
    if (this.#heartbeat !== null) clearInterval(this.#heartbeat);
    await this.#loop;
    return { drained, released: this.#releasedOnSigterm - before };
  }
}
