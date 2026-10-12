// SHARED DEPENDENCIES THAT ARE DOWN, ONE PAGE EACH. Token `dep-down`
// (src/cuts.ts); off, nothing here is built and every alert goes as it always did.
//
// THE PROBLEM (ADR §4.10 amendment 1, RT-14; §4.9 row 24). Every alert this
// keeper raises names a wallet, a vault, or "the sweep". A dependency every
// wallet shares has no alert of its own, so an outage of one reaches a person as
// whatever its symptoms happen to be:
//   * the RPC: one generic `sweep-failed`, which reads the same for an endpoint
//     that is down and for a bug in the sweep — two very different mornings;
//   * Privy: a `settle-retry` warn per wallet, each turning into its own
//     "A settlement keeps not landing" critical on the third sweep — N pages for
//     one 503;
//   * Jupiter: an `invest-refused` warn per vault, which never pages at all;
//   * Postgres: warn lines in the log, and `not-acting` blaming "another keeper"
//     for a claim nobody could take because the database would not answer.
// An alert that arrives N times for one cause is an alert that gets muted, and
// then it is muted for the defect too.
//
// THE RULE. Each dependency is watched where its requests already pass — the
// RPC pool behind trackedFetch (watchedRpcFetch), the fetch every Privy client
// is built with (privyUsage's onAnswer, src/privy-usage.ts), the global fetch for
// Jupiter's host (observeGlobalFetch: its route builder lives in
// @sip/solana-program and takes no fetch of its own), and the read model's own
// round trips and the loss-carry store's for the database (databaseAnswered,
// src/read-model.ts; CarryStoreHooks.observe) — and is DOWN once DEP_DOWN_STREAK requests in a row have
// failed over at least DEP_DOWN_MIN_MS, with no answer in between. A sweep that
// fails because every RPC endpoint refused is the RPC down at once: that is the
// generic sweep-failed this replaces, and it paged on the first one already.
// While a dependency is down:
//   * `dep-down:<dep>` pages ONCE (`once`, alerts.ts) and stays quiet until an
//     answer clears it, which re-arms it for the next outage;
//   * the alerts that outage explains (explainedBy) are HELD — not sent, counted
//     on /status as `ops.deps.<dep>.held`. Each is raised again by the sweep that
//     next meets its condition, so one that outlives the outage is sent then;
//     one that does not was the outage.
//
// WHAT COUNTS AS DOWN, AND WHAT DOES NOT. A request that got no answer, or an
// HTTP 5xx, 408 or 429, failed. Any other answer — a 2xx, and also a 4xx such as
// Privy's 401 for a bad authorization signature or Jupiter's 400 for a pair it
// cannot route — means the service is up and refused THIS request, which is the
// request's fault, and the per-wallet alerts are right to name the wallet.
// Jupiter's 429 is not counted toward dep-down:jupiter: being throttled is
// `jupiter-budget`'s page (src/usage-alerts.ts), and one cause pages once.
//
// WHAT IS HELD IS A TABLE, AND THE TABLE IS DELIBERATELY SHORT (explainedBy). A
// FAILED settle — the program or Privy refusing a settle — is never held: it is
// the one alert that names a defect, and an outage of something else cannot
// have caused it. Pyth and the carry store, the ADR's other two shared
// dependencies, have no entry of their own: Pyth is read through the RPC
// (src/pyth.ts), so its outage IS an RPC outage, and the carry store
// (SIP_SOLANA_CARRY_STORE, src/carry-store.ts) is a table in the same database —
// its round trips are told to the `database` watch beside the read model's, and
// its one page, `carry-store`, is what a database outage explains. The settles
// it makes wait raise no per-wallet alert at all (settleAlert's `waitingOn`), so
// there is nothing per wallet here to hold for it.
//
// IT DECIDES NOTHING ABOUT MONEY. It is told what already happened, after the
// fact, inside a try of its own at every entry point; nothing on the settle or
// invest path reads it. What it changes is who is woken, and for what.

import { alertFamily, type Alert, type Alerter } from "./alerts.js";
import { CARRY_STORE_ALERT_KEY } from "./carry-store.js";
import { DISCOVERY_STALE_ALERT_KEY } from "./discovery-lkg.js";
import { SETTLE_KEEPS_NOT_LANDING_TITLE, SETTLE_TURN_THREW_TITLE } from "./settle-decision.js";
import { VAULT_READ_ALERT_KEY } from "./sweep-decision.js";

/**
 * The shared dependencies, in the order /status lists them.
 *
 * THE DATABASE IS `database`, NEVER `postgres` (review, 2026-10-12). config.ts
 * registers every part of DATABASE_URL with the redactor, its username
 * included, and `postgres` is the username of Railway's Postgres and of
 * Supabase's direct connection. Named `postgres`, this dependency was scrubbed
 * out of everything that leaves the box: /status served `ops.deps` under the key
 * `<redacted:databaseUrl>`, and the page told the operator to read
 * `ops.deps.<redacted:databaseUrl>.held` — a key no dashboard finds, in an alert
 * that looks as if a secret had leaked into it. No provider's default user is
 * called `database`; test/dependency-watch.test.ts renders /status under a
 * DATABASE_URL whose user is `postgres` to keep it that way.
 */
export const DEPENDENCIES = ["rpc", "privy", "jupiter", "database"] as const;
export type Dependency = (typeof DEPENDENCIES)[number];

/** Failed requests in a row, with no answer between, before a dependency is called down: 3. */
export const DEP_DOWN_STREAK = 3;

/**
 * And the least time those failures must span: a minute, one sweep at the
 * default cadence. Three requests can fail inside one second of a blip — the
 * Privy listing pages, a burst of RPC reads — and a blip is weather.
 */
export const DEP_DOWN_MIN_MS = 60_000;

export const depDownKey = (dep: Dependency): string => `dep-down:${dep}`;

/** How one request to a dependency ended: answered, or failed for a reason made of fixed words. */
export type DepOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * How one HTTP status counts (the file header says why a 4xx is an answer).
 * The reason is the status and nothing else: no URL, no body.
 */
export function answerOutcome(status: number): DepOutcome {
  if (status === 408 || status === 429 || status >= 500 || status < 100) return { ok: false, reason: `HTTP ${status}` };
  return { ok: true };
}

/** A request that never got an answer, by its error's NAME only: messages can quote hosts. */
export function unansweredOutcome(error: unknown): DepOutcome {
  return { ok: false, reason: `no answer (${error instanceof Error ? error.name : "unknown"})` };
}

/** The `ops.deps.<dep>` block of /status. */
export interface DependencyStatus {
  readonly down: boolean;
  /** When the failing run began, while it is down; null otherwise. */
  readonly downSince: string | null;
  readonly failuresInRow: number;
  readonly lastFailure: string | null;
  readonly lastFailureAt: string | null;
  readonly lastOkAt: string | null;
  /** Alerts held since this process started because this dependency was down and explained them. */
  readonly held: number;
}

interface DepState {
  failuresInRow: number;
  runStartedAt: number | null;
  lastFailure: string | null;
  lastFailureAt: number | null;
  lastOkAt: number | null;
  /** True when the last thing recorded was a failure. */
  lastWasFailure: boolean;
  /** Set when a sweep failed on this dependency: down at once, until its next answer. */
  sweepFailure: string | null;
  held: number;
}

const iso = (at: number | null): string | null => (at === null ? null : new Date(at).toISOString());

export class DependencyWatch {
  readonly #state = new Map<Dependency, DepState>(
    DEPENDENCIES.map((dep) => [
      dep,
      { failuresInRow: 0, runStartedAt: null, lastFailure: null, lastFailureAt: null, lastOkAt: null, lastWasFailure: false, sweepFailure: null, held: 0 },
    ]),
  );

  #of(dep: Dependency): DepState {
    return this.#state.get(dep)!;
  }

  /** One request answered. Ends any failing run, and any down the sweep declared. */
  ok(dep: Dependency, at: number): void {
    const state = this.#of(dep);
    state.failuresInRow = 0;
    state.runStartedAt = null;
    state.sweepFailure = null;
    state.lastOkAt = at;
    state.lastWasFailure = false;
  }

  failed(dep: Dependency, at: number, reason: string): void {
    const state = this.#of(dep);
    if (state.failuresInRow === 0) state.runStartedAt = at;
    state.failuresInRow += 1;
    state.lastFailure = reason;
    state.lastFailureAt = at;
    state.lastWasFailure = true;
  }

  record(dep: Dependency, at: number, outcome: DepOutcome): void {
    if (outcome.ok) this.ok(dep, at);
    else this.failed(dep, at, outcome.reason);
  }

  /**
   * Which dependency the sweep that began at `sweepStartedAt` failed on, if any:
   * the RPC, when the last RPC request of that sweep failed and nothing answered
   * after it. The pool throws only once EVERY endpoint has refused, and a sweep
   * that ends on that throw is the generic `sweep-failed` this file replaces.
   * A sweep that failed with the RPC still answering — a JSON-RPC error in a
   * 200, a defect in the sweep — is not the RPC being down, and stays sweep-failed.
   */
  sweepFailureCause(sweepStartedAt: number): Dependency | null {
    const rpc = this.#of("rpc");
    if (rpc.lastWasFailure && rpc.lastFailureAt !== null && rpc.lastFailureAt >= sweepStartedAt) return "rpc";
    return null;
  }

  /** The sweep failed on `dep`: down from now until its next answer. `reason` is already summarized and redacted. */
  sweepFailedOn(dep: Dependency, reason: string): void {
    this.#of(dep).sweepFailure = reason;
  }

  isDown(dep: Dependency, now: number): boolean {
    const state = this.#of(dep);
    if (state.sweepFailure !== null) return true;
    return state.failuresInRow >= DEP_DOWN_STREAK && state.runStartedAt !== null && now - state.runStartedAt >= DEP_DOWN_MIN_MS;
  }

  /** One alert held because `dep` explained it. */
  held(dep: Dependency): void {
    this.#of(dep).held += 1;
  }

  status(now: number): Readonly<Record<Dependency, DependencyStatus>> {
    const out = {} as Record<Dependency, DependencyStatus>;
    for (const dep of DEPENDENCIES) {
      const state = this.#of(dep);
      const down = this.isDown(dep, now);
      out[dep] = {
        down,
        downSince: down ? iso(state.runStartedAt ?? state.lastFailureAt ?? now) : null,
        failuresInRow: state.failuresInRow,
        lastFailure: state.sweepFailure ?? state.lastFailure,
        lastFailureAt: iso(state.lastFailureAt),
        lastOkAt: iso(state.lastOkAt),
        held: state.held,
      };
    }
    return out;
  }
}

/**
 * The per-wallet and per-vault alert kinds each dependency's outage explains,
 * by alertFamily. `settle-failed` is not in the table: its key is shared by a
 * refusal, a RETRY streak and a throw (settleThrewAlert says why), and only the
 * last two are what an outage looks like — so it is told apart by title.
 */
const EXPLAINED: Readonly<Record<string, readonly Dependency[]>> = {
  // The sweep's own failure, its degraded vault read, and L3's remembered list:
  // each is the RPC refusing, said three ways.
  "sweep-failed": ["rpc"],
  [VAULT_READ_ALERT_KEY]: ["rpc"],
  [DISCOVERY_STALE_ALERT_KEY]: ["rpc"],
  // A settle that did not land: the RPC that sends and confirms it, or Privy that signs it.
  "settle-retry": ["rpc", "privy"],
  // A basket refused or failed: the RPC that reads the venues, or Jupiter that quotes them.
  "invest-refused": ["rpc", "jupiter"],
  "invest-failed": ["rpc", "jupiter"],
  // "Another keeper holds the claim" — or nobody could take it, because the database is down.
  "not-acting": ["database"],
  // The loss-carry store's one page (the PROFIT settles that wait on it page nothing
  // of their own): a table in that same database, which cannot answer while it is down.
  [CARRY_STORE_ALERT_KEY]: ["database"],
};

/** The dependencies whose outage would explain this alert; empty when none would. */
export function explainedBy(alert: Alert): readonly Dependency[] {
  const family = alertFamily(alert.key);
  if (family === "settle-failed") {
    if (alert.title === SETTLE_KEEPS_NOT_LANDING_TITLE) return ["rpc", "privy"];
    if (alert.title === SETTLE_TURN_THREW_TITLE) return ["rpc"];
    return [];
  }
  return EXPLAINED[family] ?? [];
}

/**
 * An Alerter that holds what a down dependency explains and passes everything
 * else through unchanged — fire, clear and delivery alike. It never throws into
 * a caller: if its own question fails, the alert goes out as it always would.
 */
export function gatedAlerter(inner: Alerter, watch: DependencyWatch, now: () => number = () => Date.now()): Alerter {
  return {
    fire(alert: Alert): void {
      let holder: Dependency | undefined;
      try {
        const at = now();
        holder = explainedBy(alert).find((dep) => watch.isDown(dep, at));
        if (holder !== undefined) watch.held(holder);
      } catch {
        holder = undefined;
      }
      if (holder === undefined) inner.fire(alert);
    },
    delivery: () => inner.delivery(),
    clear: (key: string) => inner.clear(key),
  };
}

const TITLES: Readonly<Record<Dependency, string>> = {
  rpc: "Every Solana RPC endpoint is failing",
  privy: "Privy is failing: settles that need its signature wait",
  jupiter: "Jupiter is failing: baskets cannot be bought",
  database: "The database is failing: the single-keeper claim and the history are at risk",
};

/** What the people woken by it can do first, per dependency. Fixed words. */
const NEXT: Readonly<Record<Dependency, string>> = {
  rpc: "Check the Helius dashboard (a key out of credits answers 429), then rpc.byEndpointPerDay on /status.",
  privy: "Check status.privy.io; settles retry every sweep and nothing is signed until it answers.",
  jupiter: "Check status.jup.ag; vaults keep their SOL and USDC and buy on a later sweep.",
  database:
    "Check the database host (DATABASE_URL's pooler); while it is down no keeper can take the claim, and settlements are not mirrored to the history.",
};

/** The page for one dependency that is down. Fixed words and numbers; the reason is a status, a name, or the sweep's own summarized error. */
export function depDownAlert(dep: Dependency, status: DependencyStatus, now: number): Alert {
  const since = status.downSince === null ? null : Math.max(0, Math.round((now - Date.parse(status.downSince)) / 1000));
  const held = Object.entries(EXPLAINED)
    .filter(([, deps]) => deps.includes(dep))
    .map(([family]) => family)
    .concat(dep === "rpc" || dep === "privy" ? ["settle-failed (not landing)"] : []);
  return {
    key: depDownKey(dep),
    severity: "critical",
    once: true,
    title: TITLES[dep],
    detail:
      `${status.failuresInRow} request${status.failuresInRow === 1 ? "" : "s"} in a row failed` +
      `${since === null ? "" : ` over ${since} s`}; last: ${status.lastFailure ?? "unknown"}. ` +
      `While it lasts, the alerts it explains are held (${held.join(", ")}) and counted on /status as ops.deps.${dep}.held; ` +
      `this clears with its first answer. ${NEXT[dep]}`,
    context: { dependency: dep, failuresInRow: status.failuresInRow },
  };
}

/** What the end of a sweep raises and resolves: every dependency that is down pages, every other is cleared. */
export function depDownAlerts(watch: DependencyWatch, now: number): { readonly fire: readonly Alert[]; readonly clear: readonly string[] } {
  const status = watch.status(now);
  const fire: Alert[] = [];
  const clear: string[] = [];
  for (const dep of DEPENDENCIES) {
    if (status[dep].down) fire.push(depDownAlert(dep, status[dep], now));
    else clear.push(depDownKey(dep));
  }
  return { fire, clear };
}

/** The reason the RPC is recorded as failing when the pool gives up: fixed words, never the pool's message. */
export const RPC_POOL_REFUSED = "every endpoint refused";

/**
 * The RPC pool's fetch (src/rpc-pool.ts, poolFetch), observed: a returned
 * response is the RPC answering, and a throw is the pool's verdict that EVERY
 * endpoint refused — it throws nothing else, because each endpoint's failure is
 * a failover inside it. Hands back exactly what the pool returned or threw.
 */
export function watchedRpcFetch(pool: typeof fetch, watch: DependencyWatch, now: () => number = () => Date.now()): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    let response: Response;
    try {
      response = await pool(input, init);
    } catch (error) {
      try {
        watch.failed("rpc", now(), RPC_POOL_REFUSED);
      } catch {
        // Observed or not, the throw goes back as it came.
      }
      throw error;
    }
    try {
      watch.ok("rpc", now());
    } catch {
      // Observed or not, the answer goes back as it came.
    }
    return response;
  }) as typeof fetch;
}

/** Whether a hostname is Jupiter's: jup.ag and every subdomain (lite-api, api). */
export const isJupiterHost = (hostname: string): boolean => hostname === "jup.ag" || hostname.endsWith(".jup.ag");

/** The hostname a fetch was called for, or null. Parsed and dropped: the URL itself is never kept. */
function hostnameOf(input: Parameters<typeof fetch>[0]): string | null {
  try {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return new URL(href).hostname;
  } catch {
    return null;
  }
}

/**
 * Observes the requests `scope.fetch` makes to the hosts `matches` accepts, and
 * passes every request — matched or not — to the fetch that was there, with the
 * same arguments, returning exactly what it returns or throws. Returns the undo.
 *
 * WHY THE GLOBAL FETCH, AND ONLY FOR JUPITER. Jupiter is called from
 * @sip/solana-program's route builder, which uses the bare global `fetch` and
 * takes none of its own, so this is the one place its answers can be seen
 * without editing the money path. Everything else this keeper sends over fetch
 * is either observed where it already passes (the RPC pool, Privy's clients) or
 * not observed at all; their requests go through this wrapper untouched, the
 * hostname parsed and dropped — the RPC URLs carry API keys, and nothing of
 * them is kept.
 */
export function observeGlobalFetch(
  scope: { fetch: typeof fetch },
  matches: (hostname: string) => boolean,
  report: (answer: number | "unanswered", error?: unknown) => void,
): () => void {
  const original = scope.fetch;
  const quietly = (run: () => void): void => {
    try {
      run();
    } catch {
      // Observed or not, the request's answer goes back as it came.
    }
  };
  scope.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    let watched = false;
    try {
      const host = hostnameOf(input);
      watched = host !== null && matches(host);
    } catch {
      watched = false;
    }
    if (!watched) return original(input, init);
    let response: Response;
    try {
      response = await original(input, init);
    } catch (error) {
      quietly(() => report("unanswered", error));
      throw error;
    }
    quietly(() => report(response.status));
    return response;
  }) as typeof fetch;
  return () => {
    scope.fetch = original;
  };
}
