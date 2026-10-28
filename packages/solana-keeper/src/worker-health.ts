// THE WORKER'S DEPLOY GATE: GET and HEAD /health, and nothing else, served by
// bin/worker.mts on PORT, and only with SIP_SOLANA_WORKER_HEALTH=on
// (src/worker-config.ts; runbook §10.1).
//
// OPT-IN, BECAUSE PORT IS NO SWITCH. The image bakes PORT=8080 (Dockerfile) and
// Railway injects its own, so every worker has a PORT, whether or not its
// service waits for a healthcheck. Unset, empty or off, nothing listens: the
// worker is the one from before this gate.
//
// WHY A WORKER ANSWERS ANYTHING. sip-solana-worker opened no port and had no
// Healthcheck Path, and Railway marks a deployment without one Active as soon
// as its container starts, then sends the one before it SIGTERM
// (docs.railway.com/reference/deployments). So a deploy whose configuration the
// worker refuses at boot — it exits 2, or 0 with SIP_SOLANA_DISPATCH unset —
// would replace the working worker, and nothing on the queue would be settled
// or bought until somebody noticed. With a Healthcheck Path, Railway switches
// only once the new deployment answers 2xx on PORT within its timeout (300 s
// unless RAILWAY_HEALTHCHECK_TIMEOUT_SEC says otherwise); if it never does, the
// deploy is marked failed and the previous one keeps serving
// (docs.railway.com/reference/healthchecks,
// docs.railway.com/guides/roll-back-bad-deploy).
//
// FOUR PHASES, IN ONE DIRECTION:
//   starting  503  listening, past every refusal, not serving yet;
//   ready     200  its row registered AND its claim loop's first claim ANSWERED
//                  (WorkerLoop's onClaimAnswered), whatever the queue held: the
//                  one thing a worker is for, seen working against this
//                  database's tables before Railway retires the worker before it;
//   off       200  SIP_SOLANA_DISPATCH=off, written out: listening and nothing
//                  else, no database, no RPC, no claim (below);
//   stopping  503  from the first line of the shutdown (SIGTERM, SIGINT), before
//                  the drain.
// A gate starts at starting or at off. starting moves to ready or to stopping,
// ready and off only to stopping, and stopping is final: off never becomes
// ready, and nothing is ready or off again once it is stopping.
//
// OFF IS THE STOP THAT SURVIVES PUSHES. On a service whose deploys wait for
// /health, a worker that exited when off would fail its deploy, and the one
// before it would go on serving; a deployment Removed by hand comes back with
// the next push. A worker that is off and answers 200 passes its healthcheck and
// replaces the one before it, which drains and goes, and every later push
// redeploys it still off. Only `off` written out does this: SIP_SOLANA_DISPATCH
// left unset or empty beside the gate is refused at boot (H3,
// src/worker-config.ts), so a variable lost in an edit fails its deploy rather
// than pass for a stop.
//
// A REFUSED CONFIGURATION NEVER ANSWERS AT ALL, not even 503: bin/worker.mts
// listens only after readWorkerSettings and, unless it is off, after loadConfig,
// workerRefusals and the price tape's columns, and after everything it builds
// from them. A server that cannot listen exits 1 (bin/scheduler.mts's rule),
// before any worker row is written: a worker nobody can check would only hold
// the deploy until the timeout, and this says why at once.
//
// READY DOES NOT FALL BACK TO 503 WHEN THE HEARTBEAT STOPS, on purpose. Railway
// asks only at the start of a deployment and stops at the first 2xx — the
// endpoint is "not used for continuous monitoring" (docs.railway.com/reference/
// healthchecks) — so after the first 200 nobody reads this answer. The rule that
// would decide it, decideFleetHealth's worker row (src/fleet-status.ts), waits
// max(3 × 10 s, 10 min), twice Railway's default timeout: inside the one window
// Railway reads, it could only ever say ok. A worker that stops after its deploy
// is seen where it is read: its row's heartbeat age on the scheduler's /status
// (fleet.workers, dead after WORKER_DEAD_AFTER_MS), leases that lapse in 45 s,
// and queue-lag.
//
// THE BODY IS FIXED WORDS AND NUMBERS: ok, phase, role, the commit, when the
// process came up, its slots. Like the keeper's /health (src/status.ts) it
// passes through no redactor, so nothing that could carry a secret is let in:
// no URL, no key, no variable's text. The commit is served only as a hex hash
// (or "local"), the start only as a time, the slots only as a whole number.

import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createHeartbeatServer } from "./status.js";

/** The one path. */
export const WORKER_HEALTH_PATH = "/health";

/** Where the worker stands, in the one direction it moves (the header's table). */
export type WorkerHealthPhase = "starting" | "ready" | "off" | "stopping";

/** Where a gate begins: starting, for a worker on its way to serving; off, for one SIP_SOLANA_DISPATCH=off keeps idle. */
export type WorkerHealthStart = Extract<WorkerHealthPhase, "starting" | "off">;

/** What the gate says about the process, fixed at boot. */
export interface WorkerHealthIdentity {
  /** RAILWAY_GIT_COMMIT_SHA's first 40 characters, or "local": served only in one of those two shapes. */
  readonly version: string;
  /** When the process came up, ms since the epoch. */
  readonly startedAt: number;
  /** The jobs this process runs at once (SIP_SOLANA_WORKER_SLOTS, read strictly before it gets here). */
  readonly slots: number;
}

/** What /health serves, in every phase. */
export interface WorkerHealthBody {
  readonly ok: boolean;
  readonly phase: WorkerHealthPhase;
  readonly role: "worker";
  /** A hex commit hash or "local"; null when the version had any other shape. */
  readonly version: string | null;
  /** ISO-8601; null when the clock it was handed is not a time. */
  readonly startedAt: string | null;
  /** Null when not a whole number from 1 up. */
  readonly slots: number | null;
}

/** A commit hash as Railway writes it, or the word a local run uses. Nothing else is served. */
const VERSION_SHAPE = /^(?:[0-9a-f]{7,40}|local)$/;

/** The phase, and the answer it gives. bin/worker.mts moves it; the handler only reads it. */
export class WorkerHealthGate {
  #phase: WorkerHealthPhase;
  readonly #version: string | null;
  readonly #startedAt: string | null;
  readonly #slots: number | null;

  constructor(identity: WorkerHealthIdentity, start: WorkerHealthStart = "starting") {
    // ONE OF THE TWO, whatever an untyped caller hands it: a gate never begins ready or stopping.
    this.#phase = start === "off" ? "off" : "starting";
    this.#version = VERSION_SHAPE.test(identity.version) ? identity.version : null;
    const started = new Date(identity.startedAt);
    this.#startedAt = Number.isNaN(started.getTime()) ? null : started.toISOString();
    this.#slots = Number.isSafeInteger(identity.slots) && identity.slots >= 1 ? identity.slots : null;
  }

  get phase(): WorkerHealthPhase {
    return this.#phase;
  }

  /**
   * starting → ready. True only on that step, so the caller says it once; a gate
   * already ready, off or stopping is left as it is: a worker kept off claims
   * nothing to be ready for, and one that has begun its shutdown is never ready
   * again.
   */
  ready(): boolean {
    if (this.#phase !== "starting") return false;
    this.#phase = "ready";
    return true;
  }

  /** Any phase → stopping, for good. */
  stopping(): void {
    this.#phase = "stopping";
  }

  /** What /health answers now: 200 while ready or off, 503 while starting or stopping. */
  answer(): { readonly status: 200 | 503; readonly body: WorkerHealthBody } {
    const ok = this.#phase === "ready" || this.#phase === "off";
    return {
      status: ok ? 200 : 503,
      body: { ok, phase: this.#phase, role: "worker", version: this.#version, startedAt: this.#startedAt, slots: this.#slots },
    };
  }
}

/**
 * GET or HEAD /health → the gate's answer (Node sends a HEAD no body); any other
 * method there → 405, naming the two; any other path → 404, naming /health.
 * Nothing else exists: no /status, no /leaderboard, no POST.
 */
export function workerHealthHandler(gate: Pick<WorkerHealthGate, "answer">): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    try {
      route(request, response);
    } catch {
      // THE LAST NET (src/status.ts's): the uncaughtException trap exits the
      // worker mid-job, and a probe that failed to answer is not worth that.
      try {
        if (!response.headersSent) response.statusCode = 500;
        response.end(JSON.stringify({ error: "internal error" }));
      } catch {
        // Nothing left to say, and nowhere safe to say it.
      }
    }
  };

  function route(request: IncomingMessage, response: ServerResponse): void {
    response.setHeader("content-type", "application/json");
    const path = (request.url ?? "/").split("?")[0];
    // THE PATH FIRST: whatever the method, a path that is not /health does not exist here.
    if (path !== WORKER_HEALTH_PATH) {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found", paths: [WORKER_HEALTH_PATH] }));
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.statusCode = 405;
      response.setHeader("allow", "GET, HEAD");
      response.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }
    const { status, body } = gate.answer();
    response.statusCode = status;
    response.end(JSON.stringify(body));
  }
}

/**
 * The gate's server, listening on `port` on every interface, as the keeper's
 * heartbeat does: Railway's prober is not on the loopback. Built by
 * createHeartbeatServer, so a slow request cannot hold a socket (src/status.ts).
 *
 * RESOLVES ONCE LISTENING, AND REJECTS WHEN IT CANNOT: the caller exits 1. After
 * that an error is the probe's and not the money path's, so it goes to
 * `onLateError` and never into the uncaughtException trap, which would end the
 * worker in the middle of a job.
 */
export function listenForHealth(gate: Pick<WorkerHealthGate, "answer">, port: number, onLateError: (error: Error) => void): Promise<Server> {
  const server = createHeartbeatServer(workerHealthHandler(gate));
  return new Promise((resolve, reject) => {
    const failed = (error: Error): void => reject(error);
    server.on("error", failed);
    server.listen(port, () => {
      server.off("error", failed);
      server.on("error", onLateError);
      resolve(server);
    });
  });
}
