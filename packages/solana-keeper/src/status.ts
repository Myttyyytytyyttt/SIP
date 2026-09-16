// What /status serves, and the HTTP handler that serves it.
//
// THE POINT, inherited from the EVM keeper's heartbeat: an operator must be able
// to tell a HALTED keeper from a WEDGED one without ssh. `lastSweepAt` moving =
// alive; an old timestamp with the process up = wedged; the numbers say what the
// last sweep actually saw.
//
// NO RPC CALL INSIDE THE HANDLER. A probe must never fail because the upstream
// is down — restarting a keeper has never once fixed an RPC — so the handler
// renders state the sweep already gathered.
//
// NOTHING CREDENTIAL-BEARING IN IT. The status object is built from public keys,
// counts and scrubbed details, and the rendered JSON is scrubbed again against
// the shared redactor with the logger's own tripwire: if a registered secret
// survives, the page is withheld rather than served.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Redactor } from "@sip/solana-log";
import { SERVICE } from "./keeper-log.js";

export interface WalletStatus {
  readonly settle: string;
  readonly invest: string;
  readonly signing: string;
  readonly detail: string;
  readonly at: string;
}

export interface ConfigStatus {
  readonly address: string;
  readonly authority: string;
  readonly attester: string;
  /** Null when the config names the default pubkey: nobody may crank. */
  readonly keeper: string | null;
  readonly pendingAuthority: string | null;
  readonly paused: boolean;
  readonly version: number;
}

export interface SigningStatus {
  /** privy | local-keypairs | none, or "not resolved" in dry run. */
  readonly route: string;
  readonly privyAppId: string | null;
  readonly privySignerId: string | null;
  /** False in dry run, by construction: nothing that can sign was read. */
  readonly secretsRead: boolean;
  /** The settle key's PUBLIC key, when armed. */
  readonly settleKey: string | null;
  readonly wallets: { readonly signable: number; readonly of: number } | null;
}

export interface KeeperStatus {
  service: string;
  startedAt: string;
  program: string;
  /** From getAccountInfo(program).executable; null until read, or when unreadable. */
  programDeployed: boolean | null;
  config: ConfigStatus | null;
  mode: "starting" | "dry-run" | "live";
  armed: boolean;
  missingLiveCondition: string | null;
  sweepMs: number;
  pools: number;
  sweeps: number;
  lastSweepAt: string | null;
  lastSweepLinks: number | null;
  lastSweepError: string | null;
  /** The chain's crank (config.keeper) and its balance, so an operator sees it emptying before it stops. */
  crank: { pubkey: string | null; lamports: string | null };
  signing: SigningStatus;
  history: string;
  /**
   * The latest per-wallet outcome, keyed by wallet. This is where a deduped
   * resting state stays VISIBLE: a wallet stuck INCOMPLETE or NO_SIGNER logs
   * once and then goes quiet, but /status always shows its current condition.
   */
  wallets: Record<string, WalletStatus>;
}

const bigintSafe = (_key: string, value: unknown): unknown => (typeof value === "bigint" ? value.toString() : value);

/**
 * The floor under the staleness bound: ten minutes.
 *
 * A PROBE THAT FIRES EARLY IS WORSE THAN ONE THAT NEVER FIRES. Railway restarts
 * the container when /health fails, and a restart has never once fixed an RPC —
 * it re-runs the same failing chain read against the same endpoint. Sweeps
 * legitimately overrun: a VOLUME wallet with hundreds of transactions above its
 * frontier costs one getTransaction each, and three such wallets can take longer
 * than the default 60 s interval. So the bound is generous by design.
 */
export const HEALTH_STALE_FLOOR_MS = 10 * 60 * 1000;

/** max(3 × sweepMs, 10 min): ten minutes at the default sweep, more only above a 200 s one. */
export function healthStaleAfterMs(sweepMs: number): number {
  const threeSweeps = Number.isFinite(sweepMs) && sweepMs > 0 ? sweepMs * 3 : 0;
  return threeSweeps > HEALTH_STALE_FLOOR_MS ? threeSweeps : HEALTH_STALE_FLOOR_MS;
}

export interface HealthInput {
  readonly now: number;
  /** When the process came up: the only clock that exists before the first sweep. */
  readonly startedAt: number;
  /**
   * When the last sweep STARTED, or null until one has.
   *
   * THE START, NEVER THE FINISH. `lastSweepAt` is written near the END of a
   * sweep, after the chain read, the discovery and the batched vault read have
   * all succeeded, and a sweep that throws above it never writes it at all. A
   * rule keyed on that clock would turn an RPC outage into a restart loop.
   */
  readonly lastSweepStartedAt: number | null;
  readonly sweepMs: number;
}

/** What /health answers. Numbers and fixed words only: see decideHealth. */
export interface HealthReport {
  readonly ok: boolean;
  readonly detail?: string;
  readonly quietForMs?: number;
  readonly staleAfterMs?: number;
}

/**
 * Whether a sweep has STARTED recently enough for this process to be called
 * healthy: the one question a probe can answer without asking the network.
 *
 * WHAT IT CATCHES: a process up and wedged — a sweep that hangs inside a call
 * with no timeout, an interval that stopped firing. Absence is this keeper's
 * characteristic failure, and it is the one thing a restart does fix.
 *
 * WHAT IT MUST NEVER CATCH: a keeper that is merely idle or slow within the
 * bound, and a keeper still starting up. Before the first sweep the clock is the
 * process's own start, so booting gets the same window — the first sweep is only
 * awaited after the chain read and the read model's preflight, both of which can
 * take minutes against a slow endpoint.
 *
 * NOTHING FROM UPSTREAM GOES IN THE ANSWER. /health does not pass through
 * renderStatus, so it is neither scrubbed nor tripwired: the detail is built
 * from fixed words and this function's own arithmetic, never from
 * `lastSweepError`, which by construction holds upstream text.
 */
export function decideHealth(input: HealthInput): HealthReport {
  const staleAfterMs = healthStaleAfterMs(input.sweepMs);
  const since = input.lastSweepStartedAt ?? input.startedAt;
  const quietForMs = input.now - since;
  if (!(quietForMs >= staleAfterMs)) return { ok: true };
  const seconds = Math.round(quietForMs / 1000);
  return {
    ok: false,
    detail:
      input.lastSweepStartedAt === null
        ? `no sweep has started in the ${seconds}s since this process came up`
        : `the last sweep started ${seconds}s ago`,
    quietForMs,
    staleAfterMs,
  };
}

/** The status as served: JSON, scrubbed, and withheld whole if the tripwire finds a registered secret. */
export function renderStatus(status: KeeperStatus, redactor: Redactor): string {
  const scrubbed = redactor.scrub(JSON.stringify(status, bigintSafe));
  if (redactor.contains(scrubbed)) {
    return JSON.stringify({ service: SERVICE, status: "withheld: redaction tripwire" });
  }
  return scrubbed;
}

/**
 * GET /health → {"ok":true}, or 503 with the reason when sweeping has stopped;
 * GET /status → the rendered status. Nothing else.
 *
 * `probe` is supplied by the keeper because the handler has no clock and no
 * state of its own, and it is REQUIRED: a default would decide the one question
 * a restart depends on without anyone choosing the answer.
 */
export function httpHandler(
  render: () => string,
  probe: () => HealthReport,
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    response.setHeader("content-type", "application/json");
    const path = (request.url ?? "/").split("?")[0];
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.statusCode = 405;
      response.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }
    if (path === "/health") {
      // A THROW HERE WOULD KILL THE KEEPER: this runs under the process's
      // uncaughtException trap, which exits. A probe that cannot answer says so
      // at 200 — the direction that never restarts a keeper over a bug in its
      // own probe.
      let report: HealthReport;
      try {
        report = probe();
      } catch {
        response.end(JSON.stringify({ ok: true, detail: "the staleness probe threw; this answer is not a health check" }));
        return;
      }
      if (!report.ok) response.statusCode = 503;
      response.end(JSON.stringify(report));
      return;
    }
    if (path === "/status") {
      response.end(render());
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found", paths: ["/health", "/status"] }));
  };
}
