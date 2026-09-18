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
import type { AuthorizationKeyCheck } from "./privy-authorization-key.js";
import type { SeatCheck } from "./seat-check.js";

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
  /**
   * The policy that must bound the keeper's seat on each trading wallet, or null
   * when it is not configured.
   *
   * ON ITS OWN IT ANSWERS NOTHING. A populated policy id does NOT mean an
   * unbounded seat would be refused: with no signer id there is no seat to hold
   * to it, and the keeper signs for every wallet in the app. Read `seatCheck`.
   */
  readonly privyPolicyId: string | null;
  /**
   * What the keeper actually examines before it signs for a wallet — the one
   * question the two ids above cannot answer separately (src/seat-check.ts).
   */
  readonly seatCheck: SeatCheck;
  /**
   * Whether the configured authorization key is registered in the configured key
   * quorum — established ONCE, at start-up, before any money is at stake.
   *
   * WHY IT IS HERE AND NOT LEFT TO THE FIRST SETTLE. A keeper whose key does not
   * belong to its quorum looks entirely healthy from every other field on this
   * page: it is armed, it holds the claim, it resolves a signer for each wallet,
   * it measures trades correctly. Privy refuses only at the send, with 401 "No
   * valid authorization signatures were provided" — so the first thing that ever
   * reveals the fault is a settlement that should have moved a user's money.
   * "matches" is the only healthy value; "not-checked" means a dry run, or no
   * signer id to compare against (seatCheck is "unchecked" then too).
   */
  readonly authorizationKey: AuthorizationKeyCheck;
  /** False in dry run, by construction: nothing that can sign was read. */
  readonly secretsRead: boolean;
  /** The settle key's PUBLIC key, when armed. */
  readonly settleKey: string | null;
  readonly wallets: { readonly signable: number; readonly of: number } | null;
}

/**
 * One loss a zero settle carried forward and has not yet handed on, as /status
 * shows it.
 *
 * WHY IT IS ON SHOW. The carry book lives in memory and nothing persists it: a
 * restart forgets every pending carry, and the window above it is then charged
 * on its own profit, as if the loss had never happened. That is deliberate — it
 * is the only way a loss is forgiven without the wallet's own signed
 * transactions — but it was also invisible, so nobody could tell what a deploy
 * was about to drop. Showing them does not store them.
 */
export interface PendingCarry {
  /** The trading wallet, or null when this sweep no longer discovered that link. */
  readonly wallet: string | null;
  readonly link: string;
  /** The link state the carry belongs to: `epoch:settlementNonce:frontierSlot`. */
  readonly state: string;
  readonly lossLamports: bigint;
  readonly walletSignedTxCount: number;
  /**
   * When the SWEEP first recorded this carry — the keeper's clock, not the
   * reader's, so a carry first polled hours later still reports the wait it has
   * actually had. A restart resets it, as it resets the carry.
   */
  readonly since: string;
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
  /** Every loss carried forward and not yet handed on — what a restart would drop. */
  pendingCarries: readonly PendingCarry[];
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
 * than the default 60 s interval. So the bound is generous by design, and it is
 * measured from the last time the sweep MOVED (HealthInput.lastProgressAt), not
 * from the sweep's start: an overrun is not the condition this rule is for.
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
   * When the sweep last MOVED, or null until it has moved at all.
   *
   * "STILL WORKING", NOT "STARTED WORKING". A stamp taken once at the top of a
   * sweep cannot tell a wedged sweep from one making steady progress, and the
   * work per link is real: measure-window walks up to MAX_SIGNATURE_PAGES pages
   * plus MAX_SIGNATURES getTransaction reads per link, each bounded only by the
   * pool's 30 s timeout. One backlogged VOLUME wallet against a throttled
   * endpoint reaches ten minutes on its own, and /health answering 503 mid-sweep
   * hands Railway a restart that re-runs the same walk against the same endpoint
   * from scratch — a loop that ends with the keeper down, and that also drops
   * every pending carry on the way. So bin/keeper.mts advances this whenever the
   * sweep demonstrably moves: a sweep begins, a link's turn begins, an RPC call
   * comes back.
   *
   * NOT `lastSweepAt`, EITHER. That is written near the END of a sweep, after
   * the chain read, the discovery and the batched vault read have all succeeded,
   * and a sweep that throws above it never writes it at all: a rule keyed on it
   * would turn an RPC outage into a restart loop.
   */
  readonly lastProgressAt: number | null;
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
 * Whether the sweep has MOVED recently enough for this process to be called
 * healthy: the one question a probe can answer without asking the network.
 *
 * WHAT IT CATCHES: a process up and wedged — a sweep hung inside a call that
 * never returns, an interval that stopped firing, a turn that will never end.
 * Nothing advances the clock and nothing ever will, so the restart Railway
 * performs is the one thing that does fix it. Absence is this keeper's
 * characteristic failure.
 *
 * WHAT IT MUST NEVER CATCH — three cases, each a restart that makes things
 * worse:
 *   * A SWEEP THAT IS SLOW BUT PROGRESSING. A wallet with a long backlog on a
 *     throttled endpoint can spend the whole bound inside one turn; restarting
 *     re-does that walk from the beginning, forever. The clock advances on each
 *     link's turn AND on each RPC answer, so grinding forward reads as healthy.
 *   * A KEEPER THAT IS MERELY IDLE, with nothing to sweep, inside the bound.
 *   * A KEEPER STILL STARTING UP. Before anything has moved, the clock is the
 *     process's own start, so booting gets the same window — the first sweep is
 *     awaited only after the chain read and the read model's preflight, both of
 *     which can take minutes against a slow endpoint.
 *
 * NOTHING FROM UPSTREAM GOES IN THE ANSWER. /health does not pass through
 * renderStatus, so it is neither scrubbed nor tripwired: the detail is built
 * from fixed words and this function's own arithmetic, never from
 * `lastSweepError`, which by construction holds upstream text.
 */
export function decideHealth(input: HealthInput): HealthReport {
  const staleAfterMs = healthStaleAfterMs(input.sweepMs);
  const since = input.lastProgressAt ?? input.startedAt;
  const quietForMs = input.now - since;
  if (!(quietForMs >= staleAfterMs)) return { ok: true };
  const seconds = Math.round(quietForMs / 1000);
  return {
    ok: false,
    detail:
      input.lastProgressAt === null
        ? `no sweep has started in the ${seconds}s since this process came up`
        : `the sweep last moved ${seconds}s ago`,
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
