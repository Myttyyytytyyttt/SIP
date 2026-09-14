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

/** The status as served: JSON, scrubbed, and withheld whole if the tripwire finds a registered secret. */
export function renderStatus(status: KeeperStatus, redactor: Redactor): string {
  const scrubbed = redactor.scrub(JSON.stringify(status, bigintSafe));
  if (redactor.contains(scrubbed)) {
    return JSON.stringify({ service: SERVICE, status: "withheld: redaction tripwire" });
  }
  return scrubbed;
}

/** GET /health → {"ok":true}; GET /status → the rendered status. Nothing else. */
export function httpHandler(render: () => string): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    response.setHeader("content-type", "application/json");
    const path = (request.url ?? "/").split("?")[0];
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.statusCode = 405;
      response.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }
    if (path === "/health") {
      // Alive-or-not for probes. keeper-listo hardens this into a staleness check.
      response.end(JSON.stringify({ ok: true }));
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
